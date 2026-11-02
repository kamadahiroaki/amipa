#!/usr/bin/env python3
"""bubble_msa.py — 構築済み layered.db + distill から、選択 bubble(S ノード)を通る
各サンプルの実通過を抽出し、多重整列(MSA)グリッド用の JSON を stdout に出す。

backend の `/api/bubble_msa` が spawn する想定(引数=DB/distill/ノード)。設計は
memory `msa-traversal-panel-design` / DESIGN §5。順序付きウォークは distill(p_tok/p_ori)、
S 内に閉じた極大 run を per-pass に切り出し(短く離れてすぐ戻る通過は 1 行に連結)、ノード同一性
(昇順 id)で正準化して固定幅列に整列。**同じサイトの排他アレルは「アレル群」として 1 ブロック**に
まとめる(3 アレル以上/不等長も可)。共有ノードは >CAP bp で ⋯ 畳み。node_contig_cov で S を触る contig だけ走査。

★塩基は **向き(p_ori)を反映**して出す。walk の各ステップは向きを持ち、'-' で通ったノードで
その haplotype が実際に持つのは逆相補。基準鎖は行自身の優勢向き(bp 加重多数決)にし、優勢と違う
ステップだけ逆相補する。→ 逆走 contig は全体が参照と揃い、局所反転したノードだけが差分に出る。
向きバッジ(+/−)＝行の優勢向き。row.inv に逆相補したノード名(=局所反転アレル)を返す。

WG(110M ノード/34.8k contig/8.1B token)でも動くよう、DB/distill 全体を読む操作は一切しない:
  ・id_map は mmap + 必要 id だけ searchsorted(全体 dict 化は 10GB 級になる)
  ・maxlayer は stats から(MAX(layer_index) は索引が無く全走査)
  ・leaf_seq / nodes.ref_bp は「出てきたノード」に限った IN シーク(全読み/全走査は WG で終わらない)
  ・S 内判定は np.isin(token ごとの Python ループは chr 級 contig で数秒/本)
  ・走査 token 数を p_off で事前見積りし、上限超はエラー(絞り込みを促す)

  python bubble_msa.py --db DB.layered.db --distill DIR --node S143108 [--flank 4]

出力(stdout): {name, bp, refname, nrow, nallele, scan:{leaves,contigs,tokens},
  cols:[{kind:'base'|'ell', nodes:[群のノード名], g:群連番, rb, variant, off, bp}],
  rows:[{samp, label:'sample#hap'(複数通過なら ·2), path:元のパス名, strand, seq, isref, allele}]}
エラー時は {error:"..."} を出し exit 0(backend が JSON として扱えるように)。
"""
import argparse, json, os, re, sqlite3, sys
import numpy as np

CAP, HEAD, TAIL = 12, 7, 3
MAX_LEAVES  = 400     # これ超のノード集合は MSA 対象外(大クラスタ誤選択回避)
MAX_EXPLORE = 5000    # 葉集合を作る際に降りるノード数の上限(正当な選択なら数百で終わる)
MAX_ROWS   = 600
MAX_COLS   = 320
# 走査するウォーク token 数の上限。WG は 1 contig が chr 級(最長 12.1M token)なので、90 hap を
# 全部選ぶと p_tok を GB 単位で読む。実測(wgpggb, 90 contig): 118M token→cold 3.1s/warm 1.0s、
# 331M token→cold 5.1s/warm 3.3s(≈65-100M token/s)。既定 800M は cold ~12s 相当で backend の
# timeout(30s)内に収まる線。越えたらエラーで「サンプルを絞れ」と返す(黙って待たせない)。
# --max-tokens / backend の env MSA_MAX_TOKENS で調整可。
MAX_TOKENS = 800_000_000

def _order_array(path):
    """dense id → 合意の並びの値。<db>.trav（11-02〜）なら座標 x（錨は x_of_dense、錨でない葉は x_fill）、古い木 <db>.synteny なら dcol。
    使うのは値の大小（行の向き・区切りの順）だけなので、どちらでもよい。無い値は -1"""
    import sqlite3 as _sq
    try:
        con = _sq.connect("file:%s?mode=ro" % path, uri=True)
        def get(nm):
            r = con.execute("SELECT dtype, n, blob FROM arrays WHERE name=?", (nm,)).fetchone(); return np.frombuffer(r[2], dtype=np.dtype(r[0])) if r else None
        if path.endswith(".trav"):
            x = get("x_of_dense"); xf = get("x_fill")
            if x is None: con.close(); return None
            x = x.astype(np.int64)
            if xf is not None: m = (x < 0) & (xf[:len(x)] >= 0); x[m] = xf[:len(x)][m]
        else: x = get("dcol")
        con.close(); return x
    except Exception: return None

_SYN_CACHE = {}
def synteny_dcol(path):
    """<db>.synteny の dcol（dense id → 合意列）。常駐実行器で使い回すため sys.modules に置く"""
    import sqlite3 as _sq
    cache = sys.modules.setdefault("__amipa_cache__", type(sys)("__amipa_cache__")).__dict__.setdefault("dcol", {})
    try: mt = os.path.getmtime(path)
    except OSError: return None
    ent = cache.get(path)
    if not ent or ent[0] != mt:
        arr = _order_array(path)
        if arr is None: return None
        ent = (mt, arr); cache[path] = ent
    return ent[1]
def synteny_cols(path, dense_of_name):
    """<db>.synteny の dcol（dense id → 合意列）でノード名 → 合意列。常駐実行器で使い回すため sys.modules に置く"""
    import sqlite3 as _sq
    cache = sys.modules.setdefault("__amipa_cache__", type(sys)("__amipa_cache__")).__dict__.setdefault("dcol", {})
    try: mt = os.path.getmtime(path)
    except OSError: return None
    ent = cache.get(path)
    if not ent or ent[0] != mt:
        arr = _order_array(path)
        if arr is None: return None
        ent = (mt, arr); cache[path] = ent
    dc = ent[1]
    return {n: int(dc[d]) if 0 <= d < len(dc) else -1 for n, d in dense_of_name.items()}

def die(msg):
    print(json.dumps({"error": msg})); sys.exit(0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--distill", required=True)
    ap.add_argument("--nodes", default="",
                    help="ノード名のカンマ区切り。S/クラスタは配下葉に展開、n… は葉そのもの")
    ap.add_argument("--ranges-stdin", dest="ranges_stdin", action="store_true",
                    help="stdin の JSON {ranges:[[path名, s0, e0],…], label} で対象を与える（Blocks パネルの底からの受け渡し）。"
                         "S=範囲内のトークンの葉集合、行=与えたパスの範囲だけ")
    ap.add_argument("--label", default="")
    ap.add_argument("--synteny", default="", help="合意の並びのサイドカー（<db>.trav か古い木 <db>.synteny）。あれば行の向きと列の区切りの順を合意の並びで決める（行が窓の一部しか覆わないときも揃う）")
    ap.add_argument("--samples", default="",
                    help="対象 sample/hap/contig キーのカンマ区切り(空=この bubble を通る全パス)。参照は常に含む")
    ap.add_argument("--flank", type=int, default=4)
    ap.add_argument("--cap", type=int, default=None, help="この長さを超えるノードの中央を畳む（既定 12）。0 で畳まない（Blocks パネルは画面側で畳む）")
    ap.add_argument("--max-cols", dest="max_cols", type=int, default=None, help="MSA の列数の上限（既定 320。--cap 0 のときは無制限。0 で無制限）")
    ap.add_argument("--max-leaves", dest="max_leaves", type=int, default=None, help="葉（ノード）数の上限（既定 400）。変異の少ない区間を塩基で見るとき Blocks が上げる")
    ap.add_argument("--merge-gap", dest="merge_gap", type=int, default=8,
                    help="選択集合を一時的に離れてすぐ戻る通過を『1 回の通過』として繋ぐ token 数の上限"
                         "(既定 8。実際は max(2*flank, これ)＝flank が重なるなら同じ通過とみなす)。"
                         "負値で無効=極大 run ごとに 1 行")
    ap.add_argument("--max-tokens", dest="max_tokens", type=int, default=MAX_TOKENS,
                    help="走査するウォーク token 数の上限(既定 %d)。越えたらエラー" % MAX_TOKENS)
    args = ap.parse_args()
    global MAX_LEAVES
    if getattr(args, 'max_leaves', None): MAX_LEAVES = max(1, int(args.max_leaves))
    global CAP
    if args.cap is not None: CAP = args.cap if args.cap > 0 else 10**9

    try:
        p_off = np.load(args.distill + "/p_off.npy")
        p_names = open(args.distill + "/p_names.txt").read().splitlines()
        p_tok = np.load(args.distill + "/p_tok.npy", mmap_mode="r")
        p_ori = np.load(args.distill + "/p_ori.npy", mmap_mode="r")   # 1='+'(格納配列) 0='-'(逆相補)
        id_map = np.load(args.distill + "/id_map.npy", mmap_mode="r")
    except Exception as e:
        die("distill を読めません: " + str(e))
    def nname(tok): return "n" + str(int(id_map[tok - 1]))   # dense は 1-based: id_map[tok-1]=元 id

    def dense_of(orig_ids):
        """元 GFA id → dense token の対応を、必要な id の分だけ作る。
        ★ `{orig: dense}` を id_map 全体から作ると WG(110M 要素/887MB)で 10GB 級の dict になり
          そこで詰む。id_map はほぼ昇順なので searchsorted で位置を引き、**id_map[pos]==元 id を
          検証**して採る(検証が通るなら昇順仮定は要らない=定義そのものの確認)。落ちたら
          np.isin の 1 パス(887MB 読み)にフォールバック。"""
        want = np.array(sorted(orig_ids), dtype=np.int64)
        if want.size == 0:
            return {}
        pos = np.clip(np.searchsorted(id_map, want), 0, len(id_map) - 1)
        got = np.asarray(id_map[pos])
        if bool((got == want).all()):
            return {int(w): int(p) + 1 for w, p in zip(want, pos)}
        hit = np.flatnonzero(np.isin(np.asarray(id_map), want))
        return {int(id_map[i]): int(i) + 1 for i in hit}

    try:
        con = sqlite3.connect("file:%s?mode=ro" % args.db, uri=True)
    except Exception as e:
        die("DB を開けません: " + str(e))

    sel_nodes = [x for x in args.nodes.split(",") if x]
    RNG = None                                   # ranges モード: {pi: [(s0,e0),…]}
    if args.ranges_stdin:
        try:
            req = json.load(sys.stdin)
        except Exception as e:
            die("stdin の JSON を読めません: " + str(e))
        name2pi = {nm: i for i, nm in enumerate(p_names)}
        RNG = {}; RDIR = {}                              # RDIR[pi] = コンティグの主な向き（+1/−1。通過パネルが錨数で重み付けして渡す。行の表示の向きに使う）
        for r in (req.get("ranges") or []):
            # r[0] はパス名か、distill の p_names の番号（通過パネルは番号で渡す。ヒト chr20-22 v2 は分割された W 行の名前が重複する）
            pi = int(r[0]) if isinstance(r[0], int) and 0 <= int(r[0]) < len(p_names) else name2pi.get(str(r[0]))
            if pi is None: continue
            n_ = int(p_off[pi + 1]) - int(p_off[pi]); s0 = max(0, min(n_, int(r[1]))); e0 = max(s0, min(n_, int(r[2])))
            if e0 > s0: RNG.setdefault(pi, []).append((s0, e0))
            if len(r) > 3 and r[3] is not None and int(r[3]) != 0: RDIR[pi] = 1 if int(r[3]) > 0 else -1
        if not RNG:
            die("範囲が空です（パス名が distill と一致しません）")
        # 行の範囲を、窓に出るノード（全行の範囲の和）まで延ばす（2026-10-19）。行ごとの範囲は「窓の列に入るトークンの最初〜最後」なので、
        # 合意列の並びの都合で他の行の範囲だけが少し先まで届くと、その列をこの行は通っているのに「範囲の外」になった（HG01978#2 の n73207588）。
        # 端から外へ、和集合に入るノードを辿って延ばす（和集合に無いノードが 64 個続いたら止める。最大 20,000 トークン）
        EXT, GAPMAX = 20000, 64
        parts = [np.asarray(p_tok[int(p_off[pi]) + s0:int(p_off[pi]) + e0]) for pi, rs in RNG.items() for s0, e0 in rs]
        Sall = np.unique(np.concatenate(parts)) if parts else np.zeros(0, p_tok.dtype)
        for _pass in range(2):
            grew = False
            for pi, rs in RNG.items():
                a0 = int(p_off[pi]); n_ = int(p_off[pi + 1]) - a0; out_ = []
                for s0, e0 in rs:
                    lo = max(0, s0 - EXT); seg = np.asarray(p_tok[a0 + lo:a0 + s0]); m = np.isin(seg, Sall)
                    ns0 = s0; miss = 0
                    for k in range(len(seg) - 1, -1, -1):
                        if m[k]: ns0 = lo + k; miss = 0
                        else:
                            miss += 1
                            if miss > GAPMAX: break
                    hi = min(n_, e0 + EXT); seg = np.asarray(p_tok[a0 + e0:a0 + hi]); m = np.isin(seg, Sall)
                    ne0 = e0; miss = 0
                    for k in range(len(seg)):
                        if m[k]: ne0 = e0 + k + 1; miss = 0
                        else:
                            miss += 1
                            if miss > GAPMAX: break
                    if ns0 != s0 or ne0 != e0: grew = True
                    out_.append((ns0, ne0))
                RNG[pi] = out_
            if not grew: break
            parts = [np.asarray(p_tok[int(p_off[pi]) + s0:int(p_off[pi]) + e0]) for pi, rs in RNG.items() for s0, e0 in rs]
            Sall = np.unique(np.concatenate(parts))
        # 同じパスの範囲が（元から、または延長の結果）重なる・接するなら 1 つに併合する（2026-10-26）。逆位で 3 本に割れた通過や、接合部で x が少し戻って
        # 2 本になった通過は延長後に同じトークン区間を指すので、別々に出すと中身が同一の行が 2〜3 本並んだ（DDTL の ·1 ·2 ·3、FAM230F の ·1 ·2）。
        # 離れた反復（別の場所の 2 回目の通過）は重ならないので別の行のまま。併合した区間の中の再訪（タンデム反復）は runs_of で分ける
        for pi, rs in RNG.items():
            out_ = []
            for s0, e0 in sorted(rs):
                if out_ and s0 <= out_[-1][1] + 2: out_[-1] = (out_[-1][0], max(out_[-1][1], e0))
                else: out_.append((s0, e0))
            # 併合できなかった同じパスの範囲（間に窓の外のトークンが挟まる）が JOIN トークン以内なら 1 行に繋ぐ（間は読まず、継ぎ目を brk に記す）。
            # 逆位の切れ目が窓の中にあると、窓の中の材料がコンティグ上で 2 か所に分かれる（左の両側配列と、反転ブロックのうち窓に入る部分。DDTL の n76458271–312）。
            # 離れた 2 回目（ecoli 原子 365 は 455k トークン先）は繋がない。RNG[pi] は以後「範囲の組（1 行）」のリスト
            JOIN = 20000; grp_ = []
            for s0, e0 in out_:
                if grp_ and s0 - grp_[-1][-1][1] <= JOIN: grp_[-1].append((s0, e0))
                else: grp_.append([(s0, e0)])
            RNG[pi] = grp_
        label = args.label or str(req.get("label") or "Blocks")
    elif not sel_nodes:
        die("ノードが指定されていません")
    else:
        label = sel_nodes[0] + ((" +%d" % (len(sel_nodes) - 1)) if len(sel_nodes) > 1 else "")
    # ★ MAX(layer_index) は索引が無く WG(110M 行)で全走査になるので stats を使う(emitter が書く)。
    _ml = con.execute("SELECT maxlayer FROM stats").fetchone()
    maxlayer = int(_ml[0]) if _ml and _ml[0] is not None else \
        con.execute("SELECT MAX(layer_index) FROM nodes").fetchone()[0]

    # --- S = 選択ノード群配下の葉集合の和。葉ノードそのものが選ばれていればそれも加える。
    #     ★ `WITH RECURSIVE` で部分木を一気に降りる実装は WG で使えない: 上位クラスタ(G1)を
    #       誤選択すると 110M ノードの部分木を数える羽目になり、LIMIT を付けても止まらない
    #       (実測 G1=147s / G2=35s。UNION の重複除去と kind=0 フィルタで CTE が全展開される)。
    #       そこで parent_name(idx_nodes_parent)を **Python 側で幅優先に 1 段ずつ**降り、
    #       葉数と探索ノード数の両方で打ち切る。正当な選択なら数百ノードで終わる。 ---
    def leaves_under(nm):
        frontier, seen, out = [nm], {nm}, set()
        while frontier:
            chunk, frontier = frontier[:400], frontier[400:]
            rows = con.execute(
                "SELECT DISTINCT node_name, kind FROM nodes WHERE parent_name IN (%s) "
                "AND node_name<>parent_name" % ",".join("?" * len(chunk)), chunk).fetchall()
            for nm2, kind in rows:
                if nm2 in seen:
                    continue
                seen.add(nm2)
                if kind == 0:
                    out.add(nm2)
                else:
                    frontier.append(nm2)
            if len(out) > MAX_LEAVES:
                die("選択が大きすぎます(%s 配下の葉が %d 超)。MSA は %d 葉まで。bubble か、"
                    "より狭いノード集合を選んでください。" % (nm, MAX_LEAVES, MAX_LEAVES))
            if len(seen) > MAX_EXPLORE:
                die("選択が大きすぎます(%s 配下のノードが %d 超)。より深い階層の bubble か、"
                    "狭いノード集合を選んでください。" % (nm, MAX_EXPLORE))
        return out
    leafset = set()
    for nm in sel_nodes:
        krow = con.execute("SELECT kind FROM nodes WHERE node_name=? LIMIT 1", (nm,)).fetchone()
        if krow is None:
            continue                              # 存在しないノードは無視
        sub = leaves_under(nm)
        if sub:
            leafset.update(sub)
        elif krow[0] == 0:
            leafset.add(nm)                       # 葉そのもの
        if len(leafset) > MAX_LEAVES:
            die("選択が大きすぎます(葉 %d 超)。MSA は %d 葉まで。より狭いノード集合を選んでください。"
                % (MAX_LEAVES, MAX_LEAVES))
    if RNG is not None:
        # S = 与えた範囲のトークン（dense id）の和。葉名は表示・塩基の取得のために dense→元 id で作る
        Sdense = set()
        for pi, rs in RNG.items():
            a = int(p_off[pi])
            for grp in rs:
                for s0, e0 in grp: Sdense.update(int(t) for t in np.unique(np.asarray(p_tok[a + s0:a + e0])))   # RNG[pi] は範囲の組のリスト
        if len(Sdense) > MAX_LEAVES:
            die("この範囲は葉が %d 個あり、塩基レベル MSA の上限 %d を超えます。Blocks でさらに内側へ降りてください。" % (len(Sdense), MAX_LEAVES))
        leaves = sorted({nname(t) for t in Sdense}, key=lambda n: int(n[1:]))
    else:
        leaves = sorted(leafset, key=lambda n: int(n[1:]))
        if not leaves:
            die("選択ノードから葉集合を作れません(bubble か葉ノードを選んでください)")
        orig2dense = dense_of(int(n[1:]) for n in leaves)
        Sdense = set(orig2dense[int(n[1:])] for n in leaves if int(n[1:]) in orig2dense)
    if not Sdense:
        die("葉を distill の dense id に対応づけできません(グラフ不一致?)")
    Sarr = np.array(sorted(Sdense), dtype=p_tok.dtype)   # 判定は np.isin(C 実装)で行う
    Smin, Smax = int(Sarr[0]), int(Sarr[-1])

    # --- node_contig_cov 前絞り込み: S を触る contig_id → distill パス index ---
    rowids = []                                   # 葉が多い（--max-leaves で 400 超）と IN の変数が SQLite の上限 999 を超えるので刻む
    for i in range(0, len(leaves), 400):
        chunk = leaves[i:i + 400]
        rowids += [r[0] for r in con.execute(
            "SELECT rowid FROM nodes WHERE layer_index=? AND node_name IN (%s)"
            % ",".join("?" * len(chunk)), [maxlayer] + chunk).fetchall()]
    touch_cid = set()
    if rowids:
        for i in range(0, len(rowids), 400):
            chunk = rowids[i:i + 400]
            for (blob,) in con.execute(
                "SELECT blob FROM node_contig_cov WHERE node_rowid IN (%s)"
                % ",".join("?" * len(chunk)), chunk):
                if not blob or len(blob) < 4:
                    continue
                cnt = int(np.frombuffer(blob, np.uint32, 1)[0])
                if 4 + 4 * cnt <= len(blob):
                    ids = np.frombuffer(blob, np.uint32, cnt, 4)
                    touch_cid.update(int(x) for x in ids)
    # contig_id -> distill path index (p_names の末尾 [range] を剥いで contig_dict.key と一致)
    key2pi = {}
    for i, nm in enumerate(p_names):
        base = re.sub(r"\[[^\]]*\]$", "", nm)
        key2pi.setdefault(base, []).append(i)
    cid2key = dict(con.execute("SELECT contig_id, key FROM contig_dict"))
    samp_keys = set(x for x in args.samples.split(",") if x)
    # 参照パスの検出。★ 表記がグラフごとに違う(MC chrY は `GRCh38#chrY`、pggb WG は `grch38#chr1`)
    #   ので大小無視・`#` 前だけで判定する。候補は DB の ref_contigs.ref_key(emitter が書く)＋既知名。
    #   ここを取り違えると「整列の基準行(参照)が MSA に出ない/絞り込みで落ちる」になる。
    refpref = {"grch38", "chm13"}
    try:
        refpref |= {str(k).lower() for (k,) in con.execute("SELECT DISTINCT ref_key FROM ref_contigs") if k}
    except sqlite3.Error:
        pass
    # 参照判定は `#` 区切り(CHM13#0#chr1)だけでなく `.` 区切り(GRCh38.chr1)や裸名にも対応する。
    # ★MC-grch38 は GRCh38 パスが `GRCh38.chr1`(ドット)なので split("#")[0] だと参照と認識されず、
    #   grch38 だけ選ぶと「参照は常に含む」から漏れて CHM13 だけ残る不具合になっていた。
    def isref_pi(pi):
        low = p_names[pi].lower()
        return any(low == p or low.startswith(p + "#") or low.startswith(p + ".") for p in refpref)
    def matches(pi):
        if not samp_keys: return True
        if isref_pi(pi): return True              # 参照は常に含む(整列の基準行)
        base = re.sub(r"\[[^\]]*\]$", "", p_names[pi]); s0 = base.split("#")[0]
        if base in samp_keys or s0 in samp_keys: return True
        return any(base == k or base.startswith(k + "#") for k in samp_keys)
    pis = []
    if RNG is not None:
        pis = list(RNG.keys())                   # 行は与えたパスの範囲だけ（他のゲノムの反復通過は出さない）
    elif touch_cid:
        for cid in touch_cid:
            for pi in key2pi.get(cid2key.get(cid, "\0"), ()):
                pis.append(pi)
    else:
        pis = list(range(len(p_names)))           # cov 前絞り込み不可時は全走査にフォールバック
    # 参照を先に処理する: MAX_ROWS で打ち切られても整列の基準行(参照)が必ず残るように。
    pis = sorted(set(pi for pi in pis if (RNG is not None or matches(pi))), key=lambda pi: (not isref_pi(pi), pi))

    # ★ 走査量の事前見積り。WG は 1 contig が chr 級(数百万〜千万 token)なので、絞り込みを
    #   忘れて全 hap を選ぶと p_tok を数 GB 読んで timeout する。読む前に p_off の差分で判定して
    #   「絞ってください」と返す(黙って 30s 待たせない)。
    ntok = int(sum(e0 - s0 for pi in pis for grp in RNG[pi] for s0, e0 in grp)) if RNG is not None else int(sum(int(p_off[pi + 1]) - int(p_off[pi]) for pi in pis))
    if ntok > args.max_tokens:
        die("走査対象が大きすぎます(%d contig / %.1fM token)。対象サンプル/ハプロタイプを絞ってください。"
            % (len(pis), ntok / 1e6))

    # --- 各触れ contig を distill から slice し、S 内極大 run を抽出 ---
    RUNFLAGS = {}; RUNBRK = {}
    def runs_of(pi):
        a, b = int(p_off[pi]), int(p_off[pi + 1])
        if b <= a:
            return []
        if RNG is not None:
            # 与えた範囲だけを読み、前後 flank 分の文脈を付けて 1 範囲 = 1 通過にする（S の判定はしない）
            out = []; fl = []; bk = []
            for grp in RNG[pi]:
                # 範囲の組を 1 本のトークン列に繋ぐ（間のトークンは読まない）。継ぎ目 brks = [(列の中の位置, 飛ばしたトークン数)]
                tk = []; oo = []; brks = []
                for gi, (s0, e0) in enumerate(grp):
                    lo = max(0, s0 - args.flank) if gi == 0 else s0; hi = min(b - a, e0 + args.flank) if gi == len(grp) - 1 else e0
                    if gi > 0: brks.append((len(tk), s0 - grp[gi - 1][1]))
                    tk += [int(x) for x in np.asarray(p_tok[a + lo:a + hi])]; oo += [int(x) for x in np.asarray(p_ori[a + lo:a + hi])]
                lo0 = max(0, grp[0][0] - args.flank); hi1 = min(b - a, grp[-1][1] + args.flank)
                # 繋いだ範囲の中で同じノードを再訪していれば、そこで行を分ける（タンデム反復の 2 回目＝·2。2026-10-26）。1〜2 個の再訪（小さな戻り）では
                # 分けず、続く 16 トークンのうち 8 個以上が既出のときだけ本物の 2 回目とみなす。逆位（向きが変わるだけで再訪は無い）は 1 行のまま
                cuts = [0]; seen = set(); k = 0
                while k < len(tk):
                    t_ = tk[k]
                    if t_ in seen:
                        look = tk[k:k + 16]
                        if sum(1 for q in look if q in seen) >= min(8, len(look)): cuts.append(k); seen = set()
                    seen.add(t_); k += 1
                cuts.append(len(tk))
                for ca, cb in zip(cuts, cuts[1:]):
                    if cb <= ca: continue
                    out.append((tk[ca:cb], oo[ca:cb])); fl.append((lo0 == 0 and ca == 0, hi1 == b - a and cb == len(tk)))   # コンティグの端に届いたか（歩きの向き）
                    bk.append([(i - ca, n) for i, n in brks if ca < i < cb])
            RUNFLAGS[pi] = fl; RUNBRK[pi] = bk
            return out
        tk = np.asarray(p_tok[a:b])
        # ★ token ごとの `int(t) in Sdense`(Python ループ)は WG の chr 級 contig で数秒/contig
        #   かかり timeout の主因になる。dense id レンジで粗く落として np.isin(C 実装)で判定する。
        m = (tk >= Smin) & (tk <= Smax)
        if not m.any():
            return []
        inS = np.zeros(len(tk), bool)
        inS[m] = np.isin(tk[m], Sarr)
        if not inS.any():
            return []
        e = np.diff(np.concatenate(([0], inS.view(np.int8), [0])))
        # ★ 選択集合を短く離れてすぐ戻る場合は「1 回の通過」として繋ぐ。繋がないと、選択が walk 上で
        #   連続していないだけ(間に非選択ノードが1つある等)で 1 パスが複数行に割れ、しかも
        #   「1行=1通過」の前提が崩れて列統合(アレルの排他判定)まで壊れる。間のノードは文脈として列に出る。
        #   ★ただし **同じノードを再訪している場合は繋がない**: それは本物の 2 回目の通過(タンデム反復
        #   /CNV)で、通過回数はこのパネルの主目的だから 1 行に潰してはいけない。判定は run の
        #   token 集合が交わるか(交わらない=選択が飛んでいるだけ、交わる=再訪)。
        gap = -1 if args.merge_gap < 0 else max(2 * args.flank, args.merge_gap)
        merged = []
        for s0, e0 in zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1)):
            s0, e0 = int(s0), int(e0)
            cur = set(int(x) for x in tk[s0:e0])
            if merged and s0 - merged[-1][1] <= gap and not (cur & merged[-1][2]):
                merged[-1][1] = e0; merged[-1][2] |= cur
            else:
                merged.append([s0, e0, cur])
        out = []
        for s0, e0, _s in merged:
            lo = max(0, s0 - args.flank); hi = min(len(tk), e0 + args.flank)
            # 向きは run の範囲だけ読む(contig 全体の p_ori を読むと WG で無駄が大きい)
            oo = np.asarray(p_ori[a + lo:a + hi])
            out.append(([int(tk[j]) for j in range(lo, hi)], [int(x) for x in oo]))
        return out
    # 1 パス目: run(token 列)だけ集める。塩基と ref_bp は「実際に出てきたノード」に限って後で引く
    # (WG の leaf_seq は 8.4GB・nodes は 110M 行なので、全読み/全走査は絶対にやらない)。
    # 行ラベルは **sample だけでは足りない**: 2 ハプロタイプ/複数 contig 断片が同名で並び「同じパスが
    # 2 行ある」ように見える(chrY MC は 1 contig が `…#0[a-b]` の断片に割れて p_names に複数出る)。
    # そこで `sample#hap` を既定ラベルにし、同一パスから複数通過が出たら ·2, ·3 を付ける。
    def labels_of(pi):
        full = p_names[pi]
        base = re.sub(r"\[[^\]]*\]$", "", full)
        f = base.split("#")
        return f[0], ("#".join(f[:2]) if len(f) >= 3 else base), (f[2] if len(f) >= 3 else ""), full
    runs = []
    for pi in pis:
        samp, lab, ctg, full = labels_of(pi)
        isref = isref_pi(pi)
        rr = runs_of(pi)
        for k, (ids, ors) in enumerate(rr):
            fl_ = RUNFLAGS.get(pi); fl_ = fl_[k] if fl_ and k < len(fl_) else (False, False)
            bk_ = RUNBRK.get(pi); bk_ = bk_[k] if bk_ and k < len(bk_) else []
            runs.append(dict(samp=samp, lab=lab, ctg=ctg, path=full, isref=isref, ids=ids, ors=ors, pi=pi, brk=bk_,
                             k=(0 if len(rr) == 1 else k + 1), cend=fl_))
            if len(runs) >= MAX_ROWS:
                break
        if len(runs) >= MAX_ROWS:
            break
    if not runs:
        die("選択サンプル/参照がこの bubble を通っていません")
    # ラベル衝突の解消: 同じ `sample#hap` に複数 contig がある場合はどれがどれか分からないので
    # contig 名の末尾を付ける(全文は path として tooltip に出る)。そのうえで同一パスから複数通過が
    # 出ていれば ·1, ·2 を付ける(=タンデム反復の 2 回目。これは潰さず別行にしている)。
    npath = {}
    for r in runs:
        npath.setdefault(r["lab"], set()).add(r["path"])
    for r in runs:
        lab = r["lab"]
        if len(npath[lab]) > 1 and r["ctg"]:
            lab += ":" + r["ctg"][-8:]
        r["label"] = lab + ("" if not r["k"] else " ·%d" % r["k"])

    # ---- リード（10-28）: 要求に reads があり、サイドカー <db>.reads があれば、窓のノード（Sall）を通るリードを行として足す ----
    #   各リードの GAF の path を窓のノードの連なり（窓のノードを含む最初〜最後）で切り、ノードごとに cs から「格納向きの文字列」を作る
    #   （一致＝ノードの塩基、置換＝リードの塩基（小文字でなく大文字）、欠失＝'-'、リードが掛からない所＝'.'）。挿入は数だけ記録（列は足さない）
    read_meta = []
    rq = (req.get("reads") if RNG is not None else None) or None
    if rq:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import reads_query as RQ
            rcon = sqlite3.connect("file:%s?mode=ro" % args.db, uri=True)
            if RQ.attach_sidecar(rcon, args.db):
                maxr = int(rq.get("max", 60)); want = set(rq.get("samples") or [])
                getr, sname = RQ.open_readers(rcon, args.db)
                win_ids = set(int(id_map[int(t) - 1]) for t in Sall.tolist()) if 'Sall' in dir() else set()
                # 窓全体から選ぶ（10-29）: 窓のノードを最大 200 個標本し（id 順＝おおよそ位置順）、標本を順に回って、まだ選んでいないリードを 1 本ずつ取る
                # （サンプルごとに上限まで）。以前は「標本 40 個を多く通る順」に上限まで取ったので、リード長より広い窓では 1 か所に固まった
                cand = {}; plist = []
                probe = sorted(win_ids)[:: max(1, len(win_ids) // 200)]
                for gid in probe:
                    al_ = RQ._node_aln_ids(rcon, gid)[:2000]; plist.append(al_)
                    for aid in al_: cand[aid] = cand.get(aid, 0) + 1
                allc = list(cand)
                info = {}
                for i_ in range(0, len(allc), 900):
                    ch_ = allc[i_:i_ + 900]
                    for aid, sn, vo, rn in rcon.execute("SELECT aln_id, sample_no, voff, read_name FROM rd.read_aln WHERE aln_id IN (%s)" % ",".join("?" * len(ch_)), ch_):
                        if want and sname.get(sn) not in want: continue
                        info[aid] = (sn, vo, rn)
                plist = [sorted((a for a in al_ if a in info), key=lambda a: -cand[a]) for al_ in plist]
                got = {}; chosen = set(); pick = []; pos_ = [0] * len(plist); more = True
                while more:
                    more = False
                    for pi_, al_ in enumerate(plist):
                        while pos_[pi_] < len(al_):
                            a = al_[pos_[pi_]]; pos_[pi_] += 1
                            if a in chosen: continue
                            sn, vo, rn = info[a]
                            if got.get(sn, 0) >= maxr: continue
                            chosen.add(a); got[sn] = got.get(sn, 0) + 1; pick.append((sn, a, vo, rn)); more = True; break
                lines = RQ.fetch_lines(getr, [(sn, a, v) for sn, a, v, _ in pick])
                need_d = {}
                for (sn, aid, line), (_, _, _, rn) in zip(lines, pick):
                    d = RQ.parse_gaf_line(line)
                    if not d or not d.get("cs"): continue
                    toks = [(int(m.group(2)), m.group(1) == '>') for m in RQ.TOK.finditer(d["path"])]
                    inw = [i for i, (gid, _o) in enumerate(toks) if gid in win_ids]
                    if not inw: continue
                    # 窓のノードに離れた 2 か所以上で触れるリード（反復・環の継ぎ目）は、窓のノードを最も多く含む連なりだけを行にする
                    # （10-29: 先頭と末尾の窓ノードの間を全部入れていたので、間の窓外の区間が株の通らない列として並んだ。ecoli x 500,000）
                    cl = [[inw[0]]]
                    for i_ in inw[1:]:
                        if i_ - cl[-1][-1] > 50: cl.append([i_])
                        else: cl[-1].append(i_)
                    # 塊の間が JOINR トークン以内ならつなぐ（10-29: 列は株の行だけで作り、窓に無いノードは印に畳むようになったので、最大の塊だけに
                    # 切る必要が無くなった。ecoli50 原子 406 で 18.7 kb のリードが株に無い 140–170 トークンの経路で 3 塊に分かれ、1.2 kb しか出なかった）
                    JOINR = 2000; mg = [list(cl[0])]
                    for c_ in cl[1:]:
                        if c_[0] - mg[-1][-1] <= JOINR: mg[-1].extend(c_)
                        else: mg.append(list(c_))
                    best_ = max(mg, key=len)
                    read_meta.append(dict(sn=sn, sample=sname.get(sn, str(sn)), name=d["read_name"], mapq=d["mapq"], toks=toks, i0=best_[0], i1=best_[-1], d=d))
                for rm in read_meta:
                    for gid, _o in rm["toks"]: need_d[gid] = None
                rcon.close()
                if read_meta:
                    dmap = dense_of(need_d.keys())
                    for rm in read_meta:
                        ids_ = []; ors_ = []; tix_ = []
                        for t_i, (gid, o) in enumerate(rm["toks"][rm["i0"]:rm["i1"] + 1], rm["i0"]):
                            if gid in dmap: ids_.append(dmap[gid]); ors_.append(1 if o else 0); tix_.append(t_i)
                        if not ids_: continue
                        nm = rm["name"]; short = nm.split("/")[1] if nm.count("/") >= 2 else nm[-10:]
                        runs.append(dict(label="▸" + rm["sample"] + ":" + short, samp=rm["sample"], lab="▸" + rm["sample"] + ":" + short, ctg="", path=nm, isref=False, ids=ids_, ors=ors_, pi=None, brk=[], k=0, cend=(False, False), rd=rm, tix=tix_))
        except Exception as e_:
            print("reads: " + repr(e_), file=sys.stderr)
    need = sorted({nname(t) for r in runs for t in r["ids"]} | {"n%d" % gid for r in runs if r.get("rd") for gid, _o in r["rd"]["toks"]}, key=lambda n: int(n[1:]))
    # ↑ リードは窓の外のノードの長さも要る（パス上の位置＝ノード長の累積。10-29: 窓の手前のノードを長さ 0 として数え、cs の位置がずれて塩基が別の列に落ちるか消えた）
    COMP = str.maketrans("ACGTNacgtn", "TGCANtgcan")
    def rc(s): return s.translate(COMP)[::-1]
    seqleaf, refbp, refcid = {}, {}, {}
    for i in range(0, len(need), 400):
        chunk = need[i:i + 400]
        ph = ",".join("?" * len(chunk))
        # leaf_seq.leaf_id は INTEGER PRIMARY KEY(=rowid) なので IN は rowid シーク
        for lid, s in con.execute("SELECT leaf_id, seq FROM leaf_seq WHERE leaf_id IN (%s)" % ph,
                                  [int(n[1:]) for n in chunk]):
            seqleaf["n" + str(lid)] = s
        # ref_bp は idx_nodes_node_name のシーク。ここを `WHERE ref_bp IS NOT NULL GROUP BY node_name`
        # の全走査でやると WG では終わらない(かつ集約は中断も効かない)。
        for nm, rb, rcid in con.execute(
                "SELECT node_name, MIN(ref_bp), ref_contig_id FROM nodes WHERE node_name IN (%s) "
                "AND ref_bp IS NOT NULL GROUP BY node_name" % ph, chunk):
            refbp[nm] = int(rb)
            if rcid is not None:
                refcid[nm] = int(rcid)

    # ★ ノードの格納配列をそのまま並べてはいけない。walk は各ステップに向き(p_ori)を持ち、'-' の
    #   ステップでその haplotype が実際に持つのは **逆相補**。同じ配列 "T" のノードでも、周りと逆向きに
    #   通れば実体は "A" で、これは本物の SNP。verbatim 表示だと「同じ塩基なのにノードが違う」という
    #   意味不明な見え方になる(chrY n81087900/n81087901 で実例: GRCh38=T / HG01243=A)。
    #   比較の基準鎖は **その行自身の優勢向き**(bp 加重の多数決=長い共有ノードが決める)。
    #   優勢向きと違うステップだけ逆相補する。→ 逆走 contig は全体が揃って参照と一致し、
    #   局所的に反転しているノードだけが差分として出る(それが生物学的な実体)。
    # リードの行のノードごとの文字列（格納向き）。パス座標で cs を歩き、ノード [off, off+seg) に一致・置換・欠失・挿入を落とす
    for r in runs:
        rm = r.get("rd")
        if not rm: continue
        d = rm["d"]; ps, pe = d["path_start"], d["path_end"]; toks = rm["toks"]
        offs = []; off = 0
        for gid, o in toks:
            L_ = len(seqleaf.get("n%d" % gid, "")); offs.append((gid, o, off, L_)); off += L_
        lo_ = offs[rm["i0"]][2]; hi_ = offs[rm["i1"]][2] + offs[rm["i1"]][3]
        buf = {}; ins = {}; rins = []
        for gid, o, of_, L_ in offs[rm["i0"]:rm["i1"] + 1]: buf[(gid, of_)] = ["."] * L_
        import bisect as _bsr
        starts_ = [of_ for _g, _o, of_, _L in offs]   # パス座標 → トークンは二分探索（10-29: 先頭から順に探していたので塩基数×ノード数で、ヒト 1.1 kb の窓が 25 秒）
        def tok_at(pos):
            t_i = _bsr.bisect_right(starts_, pos, rm["i0"], rm["i1"] + 1) - 1
            if t_i < rm["i0"]: return None
            gid, o, of_, L_ = offs[t_i]
            return t_i if of_ <= pos < of_ + L_ else None
        def put(pos, ch):
            t_i = tok_at(pos)
            if t_i is None: return
            gid, o, of_, L_ = offs[t_i]
            sq = seqleaf.get("n%d" % gid, ""); base = (sq if o else sq.translate(COMP)[::-1])
            buf[(gid, of_)][pos - of_] = base[pos - of_] if ch is None else ch
        pos = ps
        for m_ in re.finditer(r'(:\d+)|(\*[a-z][a-z])|(-[a-z]+)|(\+[a-z]+)', d["cs"].lower()):
            t = m_.group(0)
            if t[0] == ':':
                L = int(t[1:])
                for q in range(max(pos, lo_), min(pos + L, hi_)): put(q, None)
                pos += L
            elif t[0] == '*':
                if lo_ <= pos < hi_: put(pos, t[2].upper())
                pos += 1
            elif t[0] == '-':
                for q in range(max(pos, lo_), min(pos + len(t) - 1, hi_)): put(q, "-")
                pos += len(t) - 1
            else:
                if lo_ <= pos < hi_:
                    ins[pos] = ins.get(pos, 0) + len(t) - 1
                    t_i = tok_at(pos)   # 挿入の位置を「ノード・格納向きの塩基の間」で覚える（列への対応は列を作った後）
                    if t_i is not None:
                        gid, o, of_, L_ = offs[t_i]; k_ = pos - of_; sq_ = t[1:].upper()
                        rins.append(("n%d" % gid, k_ if o else L_ - k_, sq_ if o else rc(sq_), t_i))
            if pos >= hi_: break
        # 通過ごと（トークンごと）の格納向きの文字列（10-29: ノード名で持つと同じノードの 2 回目の通過が 1 回目を上書きした）
        rdt = {}
        for t_i in range(rm["i0"], rm["i1"] + 1):
            gid, o, of_, L_ = offs[t_i]; wstr = "".join(buf[(gid, of_)]); rdt[t_i] = wstr if o else wstr.translate(COMP)[::-1]
        tpos = {t_: k_ for k_, t_ in enumerate(r["tix"])}
        r["rdocc"] = [rdt[t_] for t_ in r["tix"]]; r["nins"] = sum(ins.values()); r["rins"] = [(n_, k_, q_, tpos[t_]) for n_, k_, q_, t_ in rins if t_ in tpos]
    raw = []; dense_of_name = {}; rc_votes = {}   # ノードが表示で逆相補されている行の多数（列の塩基オフセットを格納向きに直すため）
    # 行の向き: 合意列があれば「歩きが合意列を減らす向きに進むか」で決める（2026-10-18）。格納向きの bp の多数決だと、局所的に長い反転を
    # 含む逆鎖のコンティグが順向きと判定され、行が逆に読まれた（chr21 n73207575 の CA が半数の株で TG、573/574 が並列に見えず直列に）
    # 行の向き（2026-10-18）: まず格納向きの bp の多数決で決め、次に**参照行（無ければ最初の行）と共有するノードの並び**が参照行と逆なら
    # 裏返す（共有が無ければ合意列の増減で比べる）。行ごとに独立に決めると、局所反転を含む逆鎖コンティグが参照と逆向きに読まれ、
    # 区切りの順と行の並びが食い違って列がずれた（chr21 n73207582 が 578 の後ろへ、HG01978#2 の欠失）
    dcache = synteny_dcol(args.synteny) if args.synteny else None
    pre = []
    for r in runs:
        ids, ors = r["ids"], r["ors"]
        nodes = [nname(t) for t in ids]
        wp = sum(len(seqleaf.get(n, "")) for n, o in zip(nodes, ors) if o)        # '+' の bp
        wm = sum(len(seqleaf.get(n, "")) for n, o in zip(nodes, ors) if not o)    # '-' の bp
        pre.append([r, nodes, ors, wm > wp])
        for t, n in zip(ids, nodes): dense_of_name.setdefault(n, int(t))
    def disp(p): return p[1][::-1] if p[3] else p[1]
    bi = next((k for k, p in enumerate(pre) if p[0]["isref"]), 0)
    # 通過パネルからコンティグの主な向き（錨数の重み付き）が来ていればそれを優先する（2026-10-26）。窓が反転ブロックに偏ると bp 多数決も
    # 共有ノードの並びも反転ブロックの向きに引かれ、両側配列の方が「逆向き」に見えた（DDTL の狭い窓）。参照の向きを基準に、無ければ合意の向き
    # ★先に決める（10-29）: 後で上書きしていたので、基準の行（参照が無い ecoli では先頭の株）が反転されると、それに揃えたリードの行だけが逆向きのまま残り、
    #   ノードの順が逆なので全部が写しの列に回った（ecoli の窓の 7/12 で株とリードの列が分かれた）
    fixed = set()
    if pre and RNG is not None:
        refdir = RDIR.get(pre[bi][0].get("pi"))
        for k, p in enumerate(pre):
            d = RDIR.get(p[0].get("pi"))
            if d is None: continue
            p[3] = (d != refdir) if refdir is not None else (d < 0); fixed.add(k)
    if pre:
        bseq = disp(pre[bi]); bpos = {}
        for k, n in enumerate(bseq): bpos.setdefault(n, k)
        def ctrend(seq):
            if dcache is None: return 0
            cs = [int(dcache[dense_of_name[n]]) for n in seq if n in dense_of_name and 0 <= dense_of_name[n] < len(dcache) and dcache[dense_of_name[n]] >= 0]
            return int(np.sign(np.diff(np.asarray(cs, np.int64))).sum()) if len(cs) >= 2 else 0
        btrend = ctrend(bseq)
        for k, p in enumerate(pre):
            if k == bi or k in fixed: continue
            sq = disp(p); sh = [bpos[n] for n in sq if n in bpos]
            t = int(np.sign(np.diff(np.asarray(sh, np.int64))).sum()) if len(sh) >= 2 else 0
            if t == 0 and btrend != 0: t = ctrend(sq) * (1 if btrend > 0 else -1)
            if t < 0: p[3] = not p[3]   # リードの向きは列ができた後に最長増加部分列で決め直す（lis_len）
    has_h = any(not p[0].get("rd") for p in pre)
    for r, nodes, ors, rev in pre:
        # 通過ごとの文字列（10-29）: occ_st＝格納向き（リードは自分の塩基）、occ_inv＝その通過が行の表示の向きと逆か、occ＝表示の向きの文字列。
        # 同じノードを 2 回通る行（タンデム反復の輪・局所の入れ替わり）で、写しの列にその回の文字と向きを出すため。cells / inv / rc_votes は従来どおり最初の通過で決める
        cells, inv = {}, []; occ, occ_inv, occ_st = [], [], []; rdo = r.get("rdocc"); vote = not (rdo and has_h)   # 列の多数の向きは株の行だけで決める（株が無ければ全行）
        for k_, (n, o) in enumerate(zip(nodes, ors)):
            st_ = rdo[k_] if rdo else seqleaf.get(n, "?"); iv_ = (not o) != rev   # ステップ向きが行の表示の向きと違う = 局所反転
            s = rc(st_) if iv_ else st_
            occ.append(s); occ_inv.append(iv_); occ_st.append(st_)
            if n in cells:
                continue
            if iv_: inv.append(n)
            if vote: rc_votes[n] = rc_votes.get(n, 0) + (1 if iv_ else -1)
            cells[n] = s
        if rev: occ, occ_inv, occ_st = occ[::-1], occ_inv[::-1], occ_st[::-1]
        rins_ = [(n_, k_, q_, (len(nodes) - 1 - i_) if rev else i_) for n_, k_, q_, i_ in r.get("rins", [])]
        ce = r.get("cend", (False, False))
        brk_ = [[nodes[i - 1], nodes[i], int(n_)] for i, n_ in r.get("brk", []) if 0 < i < len(nodes)]   # 継ぎ目: [前のノード, 後のノード, 飛ばしたトークン数]
        hseq_ = "".join((seqleaf.get(n_, "N") if o_ else rc(seqleaf.get(n_, "N"))) for n_, o_ in zip(nodes, ors))   # その株のコンティグの向きの実際の配列（書き出し用）
        if rdo: hseq_ = "".join((st_ if o_ else rc(st_)) for st_, o_ in zip(rdo, ors)).replace("-", "").replace(".", "")   # リードは自分の塩基（整列の向き。欠失・範囲外を除く。挿入は含まない）
        raw.append(dict(rdinfo=(dict(sample=r["rd"]["sample"], name=r["rd"]["name"], mapq=r["rd"]["mapq"], nins=r.get("nins", 0)) if r.get("rd") else None), rins=rins_, occ=occ, occ_inv=occ_inv, occ_st=occ_st, seqn=(nodes[::-1] if rev else nodes), hseq=hseq_, samp=r["samp"], label=r["label"], path=r["path"],
                        strand=("-" if rev else "+"), cells=cells, inv=inv, ends=([ce[1], ce[0]] if rev else [ce[0], ce[1]]),   # 表示の左端・右端がコンティグの端か
                        nodes=set(nodes), seq=(nodes[::-1] if rev else nodes), isref=r["isref"], brk=brk_))

    # 逆位の見せ方（2026-10-26）: 行の向きと逆に通ったノード（inv）が連なり（行の並びで隣り合う inv ノードの合計 ≥ 10 bp、または 4 bp 以上の 1 ノード）なら、
    # 列の多数の向き（rc_votes）の文字列で出す＝同じノードなら他の行と同じ文字になり、位置ごとの比較で偽のミスマッチが出ない（DDTL の 2.95 kb 逆位）。inv の印（紫の帯）は残す。
    # 孤立した 3 bp 以下の inv ノードはそのまま逆相補で出す（向きで実現した SNP: chrY n81087900 の T/A）。行が順向きでも列の多数が逆相補なら多数に合わせる
    # 通過ごとに揃える（10-29）。連なりは「行の並びで隣り合う、逆向きの通過」。リードは自分の塩基（occ_st）で揃える
    def norm_row(r):
        seqn = r["seq"]; oi = r["occ_inv"]; ost = r["occ_st"]; occ = r["occ"] = list(r["occ0"])
        i = 0
        while i < len(seqn):
            if not oi[i]: i += 1; continue
            j = i
            while j < len(seqn) and oi[j]: j += 1
            if sum(len(seqleaf.get(seqn[q], "")) for q in range(i, j)) >= 10 or any(len(seqleaf.get(seqn[q], "")) > 3 for q in range(i, j)):
                for q in range(i, j): occ[q] = rc(ost[q]) if rc_votes.get(seqn[q], 0) > 0 else ost[q]
            i = j
        for q, n in enumerate(seqn):
            if not oi[q] and rc_votes.get(n, 0) > 0 and len(seqleaf.get(n, "")) > 3: occ[q] = rc(ost[q])
    for r in raw:
        r["occ0"] = list(r["occ"])   # occ0＝揃える前の文字（その株の実際の向き。書き出しの「実配列の整列」用）
        norm_row(r)

    # --- 固定幅列。★同じサイトの排他アレルは「アレル群」として **1 ブロック**にまとめる。
    #   旧実装は「id 隣接・等長・排他のペア」だけを統合していたので、3 アレル以上の site(G/A/C)や
    #   長さの違うアレル(1bp vs 3bp)がそれぞれ別列に並び、MSA としては同じ列に来るべきものが横に
    #   ずれて見えていた。ここでは id 昇順に貪欲に群を伸ばす:
    #     ・候補が群の既メンバと同じ行に共存する(=排他でない)なら別サイト → 群を閉じる
    #     ・群の支持行が全行を覆ったら、そのサイトは尽きた → 群を閉じる
    #   これで隣サイトへ連鎖せず、多アレル/不等長もまとまる。群の幅=メンバ最長、短いアレルは gap 埋め。 ---
    #   ★さらに（2026-10-06）: 排他だけだと、連鎖不平衡で常に一緒に出る隣のサイトのアレル同士（29‖31 と 30‖32 の 2 サイトで、
    #   29 と 30、31 と 32 が常に同じ株）を同じサイトと誤って束ね、全株に偽の欠失が出た。同じサイト＝**グラフで並列**（行の並びから
    #   見た直前・直後のノード集合が同じ）を条件にする。群の順は行の中での位置（中央値）で決める（id 順だと島の中で乱れる）。
    # 列は株の行だけで作る（10-29）。リードは株の列（元の列・株が作った写しの列）に当てはめ、当てはまらない通過（株より多い周回・株に無い経路）は
    # 列を作らずに印にする（rins）。リードから列を作ると、輪に入る位置の違うリードごとに専用の写しの列ができ、ecoli50 の窓で列の 8 割がリード 1 本だけの列になった。
    # 株の行が無い（パスの無いグラフ）ときは全行で作る
    craw = [r for r in raw if not r.get("rdinfo")] or raw
    alln = sorted({n for r in craw for n in r["nodes"]}, key=lambda n: int(n[1:]))
    present = {n: set(i for i, r in enumerate(craw) if n in r["nodes"]) for n in alln}
    #   やり方: 全行が持つノード（不変ノード）で各行の並びを区切り、区切りの中（＝バブルの通り方＝アレル）で、区切りの先頭からの
    #   塩基オフセットが同じノード同士を同じ列群にする（29+32 と 31+30 の 2 bp ずつのアレルは [29|31][32|30] に揃う）。
    #   長さの違うアレルはオフセットがずれた所から別の群＝gap になる（整列としてはそれが正しい）。
    colof = synteny_cols(args.synteny, dense_of_name) if args.synteny else None
    if colof:
        # ★区切りの決め方（2026-10-18）: 以前は「全行が持つノード」。窓の中で別の経路を通る行（断片化したコンティグ、chr21 の 28 行中 16 行）が
        #   あると区切りが数百列にわたって立たず、オフセットがずれてアレルが別の列に落ちた（n75194845–848 の間に 843 と 847 が並び全株どちらかが欠失）。
        #   ここでは区切り＝**並列な相手を持たないノード**（行の並びで見た直前・直後のノード集合が同じ別のノードが無い＝バブルのアレルでない）。
        #   区切りの順は合意列。区切りの間はこれまでどおり行ごとの塩基オフセットで揃える（多ノードのアレルの中の順を保つ。合意列で並べると
        #   錨でないノードの列は近似なので、アレルの中が入れ替わって読み枠が壊れた＝ecoli ybeF で内部の終止 14）
        pred, succ = {}, {}
        for r in craw:
            sq = r["seq"]
            for a_, b_ in zip(sq, sq[1:]): succ.setdefault(a_, set()).add(b_); pred.setdefault(b_, set()).add(a_)
        # 並列＝直前と直後のノードを少なくとも 1 つずつ共有し、同じ行に共存しない（排他）。完全一致だと、広い窓で別の経路を通る行が
        # 前後の集合を変えるだけで外れた（chr21 n73207573/574）
        paired = set()
        for p_ in list(succ):
            S_ = [n for n in succ[p_] if succ.get(n)]
            if len(S_) < 2 or len(S_) > 16: continue
            for ia in range(len(S_)):
                for ib in range(ia + 1, len(S_)):
                    a_, b_ = S_[ia], S_[ib]
                    if succ[a_] & succ[b_] and not (present[a_] & present[b_]): paired.add(a_); paired.add(b_)
        # 区切りは参照行（無ければ最初の行）の上の、並列な相手を持たないノードに限り、順はその行の中の位置（正確）。合意列は錨でないノードでは
        # 近似なので順に使うとアレルの中や島の中が入れ替わった（ecoli ybeF で内部の終止 10）
        # 区切り＝並列な相手を持たず、行の 1/4 以上が持つノード（共有の多い鎖のノードは合意列が正確）。順は合意列（参照行の向きに合わせる）。
        # 参照行の上のノードだけに限ると、参照がその区間を別の経路で通るとき区切りが数百塩基立たず、上流の indel でオフセットが 1 ずれた
        base_row = next((r for r in craw if r["isref"]), craw[0])
        need_ = max(2, (len(craw) + 3) // 4)
        inv_nodes = {n for n in alln if n not in paired and len(present[n]) >= need_ and colof.get(n, -1) >= 0}
        # 区切りの順: 全行の「区切りの並び」を有向辺にしてトポロジカルに並べる（行の向きは参照に揃えてある）。同点・閉路は参照行の位置、
        # 次に合意列で決める。参照に無い区切りを「直前の区切りの直後」に置く近似は、行ごとに直前が違うと順が崩れた
        import heapq as _hq
        bposf = {}
        for k, n in enumerate(base_row["seq"]):
            if n in inv_nodes: bposf.setdefault(n, k)
        prio = {n: (0, bposf[n]) if n in bposf else (1, colof.get(n, 0)) for n in inv_nodes}
        outs = {n: set() for n in inv_nodes}; indeg = {n: 0 for n in inv_nodes}
        for r in craw:
            sq_ = [n for n in r["seq"] if n in inv_nodes]
            for a_, b_ in zip(sq_, sq_[1:]):
                if a_ != b_ and b_ not in outs[a_]: outs[a_].add(b_); indeg[b_] += 1
        # 参照行の位置を持つ区切りどうしの合意列の値で、参照に無い区切りの優先度を参照の位置へ寄せる（同じ位置付近で並ぶように）
        bl = sorted((colof[n], bposf[n]) for n in bposf)
        if bl:
            xs_ = [c for c, _ in bl]; ys_ = [k for _, k in bl]
            for n in inv_nodes:
                if n not in bposf: prio[n] = (0, float(np.interp(colof[n], xs_, ys_)) + 1e-3)
        order_ = []; heap = [(prio[n], n) for n in inv_nodes if indeg[n] == 0]; _hq.heapify(heap); done_ = set()
        while len(order_) < len(inv_nodes):
            if not heap:   # 閉路: 残りの中で優先度が最小のものを入れる
                rest = [n for n in inv_nodes if n not in done_]; m_ = min(rest, key=lambda n: (prio[n], int(n[1:]))); indeg[m_] = 0; heap = [(prio[m_], m_)]   # 同点はノード番号で（10-29: 集合の並び順＝ハッシュの種で列が変わった。ecoli50 の環の継ぎ目で 9.8 万〜15 万列）
            _, n = _hq.heappop(heap)
            if n in done_: continue
            done_.add(n); order_.append(n)
            for m_ in outs[n]:
                indeg[m_] -= 1
                if indeg[m_] == 0 and m_ not in done_: _hq.heappush(heap, (prio[m_], m_))
        seg_pos = {n: float(k) for k, n in enumerate(order_)}
    else:
        inv_nodes = {n for n in alln if len(present[n]) == len(craw)}
        seg_pos = {}                                   # 不変ノード → 並びの中の位置（参照行があれば参照行、無ければ最初の行）
        base_row = next((r for r in craw if r["isref"]), craw[0])
        for i, n in enumerate(base_row["seq"]):
            if n in inv_nodes and n not in seg_pos: seg_pos[n] = i
        nseg = len(seg_pos)
        for r in craw:                                  # 参照行に無い不変ノードは無い（全行が持つ）はずだが、順が違う行は位置を後ろに
            for n in r["seq"]:
                if n in inv_nodes and n not in seg_pos: seg_pos[n] = nseg; nseg += 1
    keyof = {}                                     # ノード → (区切りの順位, オフセット bp)。行によって違えば最初の行の値
    for r in craw:
        seg = -1; off = 0
        sq = r["seq"]
        if colof:
            # 最初の区切りより前のノード: その区切りから後ろ向きに測った負のオフセット（他の行の前の区間と混ぜない）
            first = next((i for i, n in enumerate(sq) if n in inv_nodes), None)
            if first is not None:
                back = 0
                for n in reversed(sq[:first]):
                    back += len(seqleaf.get(n, "")); keyof.setdefault(n, (seg_pos[sq[first]], -1 - back))
        if colof:
            # 区切りの間を区間ごとに: 区切り A → B が表示の向き（seg_pos が増える）なら A から前向きに、逆（局所的に逆に通る区間）なら
            # B から前向き＝並びを逆にして測る（chr21 n73207574 が 575 の後ろに落ちた）
            sidx = [i for i, n in enumerate(sq) if n in inv_nodes]
            for i in sidx: keyof.setdefault(sq[i], (seg_pos[sq[i]], -1))
            for a_, b_ in zip(sidx, sidx[1:]):
                mid = sq[a_ + 1:b_]
                if not mid: continue
                A_, B_ = sq[a_], sq[b_]
                if seg_pos[A_] <= seg_pos[B_]: base_, seq_ = A_, mid
                else: base_, seq_ = B_, mid[::-1]
                off = len(seqleaf.get(base_, ""))
                for n in seq_: keyof.setdefault(n, (seg_pos[base_], off)); off += len(seqleaf.get(n, ""))
            if sidx:   # 最後の区切りより後
                seg = seg_pos[sq[sidx[-1]]]; off = len(seqleaf.get(sq[sidx[-1]], ""))
                for n in sq[sidx[-1] + 1:]: keyof.setdefault(n, (seg, off)); off += len(seqleaf.get(n, ""))
            else:
                off = 0
                for n in sq: keyof.setdefault(n, (-1, off)); off += len(seqleaf.get(n, ""))
            continue
        for n in sq:
            L_ = len(seqleaf.get(n, ""))
            if n in inv_nodes:
                seg = seg_pos[n]; off = 0; keyof.setdefault(n, (seg, -1))      # 不変ノード自身は区切り（オフセット -1）
                off += L_; continue
            keyof.setdefault(n, (seg, off)); off += L_
    bykey = {}
    if False:
        pass
    else:
        for n in alln: bykey.setdefault(keyof.get(n, (-2, int(n[1:]))), []).append(n)
    groups = []
    for key in sorted(bykey.keys()):
        members = sorted(bykey[key], key=lambda n: -len(present[n]))   # 株数の多い順に、排他なら同じ群へ
        pools = []
        for n in members:
            for pl in pools:
                # 長さが違うアレルは同じ列群に重ねない（10-28: 短い方が長い方の前半に揃い、合意が 2 ノードの混合になって長い方の前半だけミスマッチに見えた）
                if not (present[n] & pl[1]) and len(seqleaf.get(n, '')) == len(seqleaf.get(pl[0][0], '')): pl[0].append(n); pl[1] |= present[n]; break
            else: pools.append([[n], set(present[n])])
        groups.extend(pl[0] for pl in pools)

    # 並びの違う株と同じノードの再訪（10-28）: 列の順は全株で 1 つなので、ある株がノードを列の順と違う順に通る所（局所の入れ替わり・反復）や、
    # 同じノードを 2 回通る所は、その株の配列が整列から復元できなかった。各行の「ノードの群番号の並び」の最長増加部分列から外れる出現を、
    # 直前の（増加列の）群の直後に足した「写しの群」に置く（同じ置き場所・同じノード・同じ順位の写しは株どうしで共有）。元の群ではその行は欠失
    gidx = {}
    for gi_, g_ in enumerate(groups):
        for n_ in g_: gidx.setdefault(n_, gi_)
    import bisect as _bs
    copies_after = {}          # 元の群の番号 → [(順位 j, ノード)]（写しの群を作る順）
    # リードの向きを列の順で決め直す（10-29）: 行のノード列を列の群番号に直し、順向きと逆向きで最長増加部分列の長さを比べて長い方を採る。
    # 株の 1 行や合意座標と比べる方法は、環状の継ぎ目（合意座標の折り返し）やタンデム重複（株自身が同じノードを 2 回通る）で誤った
    def lis_len(v):
        t_ = []
        for x in v:
            k_ = _bs.bisect_left(t_, x)
            if k_ == len(t_): t_.append(x)
            else: t_[k_] = x
        return len(t_)
    if craw is not raw:
        for r in raw:
            if not r.get("rdinfo"): continue
            g_ = [gidx[n_] for n_ in r["seq"] if n_ in gidx]
            if lis_len(g_[::-1]) <= lis_len(g_): continue
            L_ = len(r["seq"]); r["seq"] = r["seq"][::-1]; r["seqn"] = r["seqn"][::-1]; r["occ_st"] = r["occ_st"][::-1]
            r["occ_inv"] = [not x for x in r["occ_inv"][::-1]]; r["occ0"] = [rc(x) for x in r["occ0"][::-1]]; norm_row(r)
            r["strand"] = "+" if r["strand"] == "-" else "-"; r["ends"] = r["ends"][::-1]
            r["rins"] = [(n_, k_, q_, L_ - 1 - i_) for n_, k_, q_, i_ in r.get("rins", [])]
            fo = {}
            for q, n_ in enumerate(r["seq"]): fo.setdefault(n_, q)
            r["inv"] = [n_ for n_, q in fo.items() if r["occ_inv"][q]]
    cset = set(id(r) for r in craw)
    for r in sorted(raw, key=lambda r: id(r) not in cset):   # 列を作る行（株）を先に。リードは株の写しの列にだけ入る
        mk = id(r) in cset
        seqi = [k_ for k_, n_ in enumerate(r["seq"]) if n_ in gidx]; seqr = [r["seq"][k_] for k_ in seqi]; gl = [gidx[n_] for n_ in seqr]
        r["occ_at"] = {}   # 列の鍵（("g", 元の群) / ("c", 写しの鍵)）→ この行の通過の番号（r["seq"] の位置）
        tails, tidx, prev = [], [], [-1] * len(gl)        # 狭義増加の LIS（同じ群＝同じノードの再訪は 1 回だけ入る）
        for i_, v in enumerate(gl):
            k_ = _bs.bisect_left(tails, v)
            if k_ > 0: prev[i_] = tidx[k_ - 1]
            if k_ == len(tails): tails.append(v); tidx.append(i_)
            else: tails[k_] = v; tidx[k_] = i_
        keep = set(); k_ = tidx[-1] if tidx else -1
        while k_ >= 0: keep.add(k_); k_ = prev[k_]
        r["skip"] = set(); r["cps"] = set(); anchor = -1; j_ = 0; kept_g = set(gl[q] for q in keep)
        for i_, n_ in enumerate(seqr):
            if i_ in keep: anchor = gl[i_]; j_ = 0; r["occ_at"][("g", gl[i_])] = seqi[i_]; continue
            key = (anchor, j_, n_); j_ += 1
            lst = copies_after.setdefault(anchor, [])
            if (j_ - 1, n_) not in lst:
                if not mk: continue   # リード: 株に無い写し＝余分な周回。列を作らない（印は後で）
                lst.append((j_ - 1, n_))
            r["occ_at"][("c", key)] = seqi[i_]; r["cps"].add(key)
            if gl[i_] not in kept_g: r["skip"].add(gl[i_])   # この行はこのノードを増加列で通らない＝元の群では欠失
    final = []                 # (ノードの群, 写しの鍵 or None, 元の群の番号)
    for c_ in sorted(copies_after.get(-1, [])): final.append(([c_[1]], (-1, c_[0], c_[1]), -1))
    used_g = {k_[1] for r in raw for k_ in r["occ_at"] if k_[0] == "g"}   # どの行も置かれない元の列は出さない（10-29: 株 1〜2 本にしか無いノードは
    # 列の順が最初の 1 行の並びで決まり、当の株の並びと食い違うと全員が写しの列に回って、空の元の列が残った。ecoli50 原子 406 で 4.2 万列中 1 万列）
    for gi_, g_ in enumerate(groups):
        if gi_ in used_g: final.append((g_, None, gi_))
        for c_ in sorted(copies_after.get(gi_, [])): final.append(([c_[1]], (gi_, c_[0], c_[1]), gi_))
    ncopy_cols = sum(1 for f_ in final if f_[1] is not None)
    cols = []
    for g, cpkey, gorig in final:
        ri = next((i_ for i_, n in enumerate(g) if n in refbp), None); rb = refbp[g[ri]] if ri is not None else None   # ri = 参照位置を持つノードの g 内の番号（列の参照位置 = rb + so[ri]）
        w = max((len(seqleaf.get(n, "")) for n in g), default=0)
        if w == 0:
            continue
        meta = dict(nodes=g, rb=rb, ri=ri, nl=w, _cp=cpkey, _g=gorig, cp=(1 if cpkey is not None else 0))   # nl = 群の幅（＝ノードの bp。窓の端で列が切られても、画面側が鏡像の位置を正しく求められるように）
        def soffs(k):   # 列 k（表示の向き）→ 各ノードの格納向きのオフセット（ノードより先なら -1）。逆相補で表示しているノードは L-1-k
            out = []
            for n in g:
                L_ = len(seqleaf.get(n, ""))
                out.append(-1 if k >= L_ else ((L_ - 1 - k) if rc_votes.get(n, 0) > 0 else k))
            return out
        if w <= CAP:
            for k in range(w): cols.append(dict(kind="base", off=k, so=soffs(k), **meta))
        else:
            for k in range(HEAD): cols.append(dict(kind="base", off=k, so=soffs(k), **meta))
            cols.append(dict(kind="ell", bp=w, **meta))
            for k in range(w - TAIL, w): cols.append(dict(kind="base", off=k, so=soffs(k), **meta))

    for c in cols: c["_k"] = ("c", c["_cp"]) if c.get("_cp") is not None else ("g", c.get("_g"))   # 列の鍵は 1 回だけ作る（10-29: 行×列×4 回作っていて、ヒトの窓で 1,800 万回）
    def occ_of(r, c):   # この列に置くこの行の通過の番号（無ければ None）。写しの列はその写し、元の列は増加列に入った通過
        return r["occ_at"].get(c["_k"])
    def cellchar(r, c, which="occ", k_=False):
        if k_ is False: k_ = occ_of(r, c)
        if k_ is None: return "-"
        s = r[which][k_]
        if c["kind"] == "ell": return "~"
        k = c["off"]
        return s[k] if k < len(s) else "-"        # 同群で短いアレルは末尾を gap 埋め
    for r in raw:
        oc_ = [r["occ_at"].get(c["_k"]) for c in cols]
        sq = "".join(cellchar(r, c, "occ", k_) for c, k_ in zip(cols, oc_))
        # 行の範囲の外（最初の塩基より前・最後の塩基より後）は "."＝読んでいない。窓の端で、この行のトークン範囲は終わっているが
        # 他の行の範囲がもう少し先まで届くと、その列がこの行の欠失に見えた（2026-10-19: HG01978#2 の n73207588 以降）
        i0 = next((i for i, ch in enumerate(sq) if ch not in "-~"), None)
        if i0 is None: r["seq"] = "." * len(sq)
        else:
            i1 = max(i for i, ch in enumerate(sq) if ch not in "-~")
            r["seq"] = "." * i0 + sq[i0:i1 + 1] + "." * (len(sq) - i1 - 1)
        # 実際の向きの文字の範囲外は自分の文字で決める（10-29: seq の "." を写していたので、列の向きに揃えて端が入れ替わったノード＝リードが途中から始まる逆向きのノードで、本物の塩基が "." に化けた）
        sqt = "".join(cellchar(r, c, "occ0", k_) for c, k_ in zip(cols, oc_)); j0 = next((i for i, ch in enumerate(sqt) if ch not in "-~"), None)
        r["seqt"] = "." * len(sqt) if j0 is None else ("." * j0 + sqt[j0:max(i for i, ch in enumerate(sqt) if ch not in "-~") + 1]).ljust(len(sqt), ".")
    # 窓の端の列を落とす: 端の列に「範囲の外」の行があり、その行がコンティグの端で切れているのではない（＝この窓で読んでいないだけ）なら、
    # その列は一部の行にしか判断材料が無いので出さない（最大 40 列ずつ）。コンティグの端で切れている行の「範囲の外」は残す（意味がある）
    if cols:
        t0 = 0
        hraw = [r for r in raw if not r.get("rdinfo")]   # リードは窓の途中で始まり終わるのが普通なので、端の列を落とす判断に使わない
        while t0 < min(40, len(cols) - 1) and any(r["seq"][t0] == "." and not r["ends"][0] for r in hraw): t0 += 1
        t1 = len(cols)
        while t1 - 1 > t0 and len(cols) - t1 < 40 and any(r["seq"][t1 - 1] == "." and not r["ends"][1] for r in hraw): t1 -= 1
        if t0 or t1 < len(cols):
            cols = cols[t0:t1]
            for r in raw: r["seq"] = r["seq"][t0:t1]; r["seqt"] = r["seqt"][t0:t1]

    # --- bubble 内部(選択ノード配下の葉)の列範囲＋pad に自動トリム。
    #     変異は内部に集中する一方、flank は隣接 VNTR 等を拾いがちなので、内部基準で切ると焦点が定まる。 ---
    def is_var(ci):   # 変異の有無は株の行だけで決める（リードの読み取りエラーで列が変異扱いにならないように）
        vals = set(r["seq"][ci] for r in raw if not r.get("rdinfo")); vals.discard("~"); vals.discard(".")
        return len(vals) > 1
    leafset = set(leaves)
    intidx = [ci for ci in range(len(cols)) if any(n in leafset for n in cols[ci]["nodes"])]
    if intidx:
        a = max(0, min(intidx) - 3); b = min(len(cols), max(intidx) + 4)
    else:
        varidx = [ci for ci in range(len(cols)) if cols[ci].get("variant") or is_var(ci)]
        a, b = (max(0, min(varidx) - 3), min(len(cols), max(varidx) + 4)) if varidx else (0, len(cols))
    # 列数の上限: 既定 320（別パネルの Bubble MSA 向け）。--cap 0（Blocks パネル内、画面側で畳む）か --max-cols 0 なら切らない
    max_cols = args.max_cols if getattr(args, 'max_cols', None) is not None else (0 if getattr(args, 'cap', None) == 0 else MAX_COLS)
    if max_cols and b - a > max_cols: b = a + max_cols
    cols = cols[a:b]
    for r in raw: r["seq"] = r["seq"][a:b]; r["seqt"] = r["seqt"][a:b]
    # 変異フラグ(トリム後)。逆位のノードの文字は上で列の多数の向きに揃えてあるので、同じノードなら変異にならない（DDTL の n76458304 で 82 列中 66 列が偽の変異になった 2026-10-26）
    for ci, c in enumerate(cols):
        vals = set(r["seq"][ci] for r in raw if not r.get("rdinfo")); vals.discard("~"); vals.discard(".")
        c["variant"] = bool(c.get("variant")) or (len(vals) > 1)
    # リードの、列に置かれなかった通過（株より多い周回・株に無い経路）を連なりごとに 1 つの印にする（10-29）。置き場所は直前に置かれた通過の列の右端（無ければ直後の左端）
    for r in raw: r["_oc"] = [r["occ_at"].get(c["_k"]) for c in cols]   # 確定した列 → この行の通過（印・紫の印で使い回す）
    for r in raw:
        if not r.get("rdinfo"): continue
        placed = {}
        for ci, k_ in enumerate(r["_oc"]):
            if k_ is not None: placed.setdefault(k_, [ci, ci]); placed[k_][1] = ci
        sq_ = r["seqn"]; i = 0; ext = []
        if not placed: continue
        pk = sorted(placed); lo_k, hi_k = pk[0], pk[-1]
        while i < len(sq_):
            if i in placed or i < lo_k or i > hi_k: i += 1; continue   # 窓の外（切り詰めた列の先）は数えない
            j = i
            while j < len(sq_) and j not in placed: j += 1
            bases = "".join(r["occ0"][q] for q in range(i, j)).replace("-", "").replace(".", "")   # 実際の向きの文字（表示の向きに読む）
            if bases:
                prv = max((q for q in placed if q < i), default=None); nxt = min((q for q in placed if q >= j), default=None)
                ci, side = (placed[prv][1], 1) if prv is not None else (placed[nxt][0], 0)
                nn = sq_[i:j]; kind = "株より多い周回" if all(n in gidx for n in nn) else "株に無い経路"
                ext.append([ci, side, bases, "%s（ノード %d 個: %s%s）" % (kind, len(nn), " ".join(nn[:4]), " …" if len(nn) > 4 else "")])
            i = j
        r["rext"] = ext
    # リードだけの挿入を列に対応させる: 格納向きの塩基 k-1 と k の間 → その 2 列の境界。片方しか無い（ノードの端・畳んだ区間）ときはある方の列の端
    if any(r.get("rins") for r in raw):
        for r in raw:
            if not r.get("rins"): continue
            so_at = {}   # この行の (通過の番号, ノード, 格納向きの位置) → 列（10-29: 同じノードの別の通過の列に印が付かないように）
            for ci, c in enumerate(cols):
                q_ = r["_oc"][ci]
                if q_ is None: continue
                for j, n in enumerate(c["nodes"]):
                    so_ = c.get("so"); v = so_[j] if so_ and j < len(so_) else None
                    if c["kind"] == "ell": so_at.setdefault(((q_, n), "ell"), ci)
                    elif v is not None and v >= 0: so_at[((q_, n), v)] = ci
            out_ = []
            for n0, k, sq_, q_ in r.get("rins", []):
                n = (q_, n0)
                a_, b_ = so_at.get((n, k - 1)), so_at.get((n, k))
                if a_ is not None and b_ is not None: ci, side = max(a_, b_), 0
                elif b_ is not None: ci, side = b_, 0 if (so_at.get((n, k + 1), b_ + 1) > b_) else 1
                elif a_ is not None: ci, side = a_, 1 if (so_at.get((n, k - 2), a_ - 1) < a_) else 0
                elif (n, "ell") in so_at: ci, side = so_at[(n, "ell")], 2
                else: continue
                if r["seq"][ci] == ".": continue
                out_.append([ci, side, sq_])
            r["rins"] = out_

    # 列が属する群の連番(frontend が境界の描画とブロック見出しに使う)
    gseq, gid = -1, []
    for c in cols:
        key = tuple(c["nodes"])
        if not gid or gid[-1][0] != key:
            gseq += 1; gid.append((key, gseq))
        c["g"] = gid[-1][1]

    # 行を allele(整列配列)でグループ化, 参照を先頭
    # 紫（逆位）の印は「列の多数の向きと逆に通ったノード」（10-28: 行の向きと逆のノードに付けていたので、全株が同じく逆に通るノード（グラフの格納向きが周囲と逆）が全行紫になった）。3 bp 以下は従来どおり
    # 10-28 夜: 3 bp 以下も同じ規則に。行の向きと逆というだけで紫にすると、全株が逆に通る短いノード（n76136869 = TT をポリ A の中で AA として通る 2 bp の挿入）が全行紫になった
    def invcols(r):   # 逆向きの印を列で（10-29）: 列に置いた通過が列の多数の向きと逆なら。ノード名で返すと、同じノードの順向きの通過（写しの列）にも印が付く。[[先頭, 末尾], ...]
        out_, st_ = [], None
        for ci, c in enumerate(cols):
            k_ = r["_oc"][ci]; f_ = k_ is not None and (r["occ_inv"][k_] != (rc_votes.get(r["seqn"][k_], 0) > 0))
            if f_ and st_ is None: st_ = ci
            if not f_ and st_ is not None: out_.append([st_, ci - 1]); st_ = None
        if st_ is not None: out_.append([st_, len(cols) - 1])
        return out_
    def invmaj(r):
        iv = set(r["inv"]); return [n for n in r["cells"] if (n in iv) != (rc_votes.get(n, 0) > 0)]
    order = sorted(range(len(raw)), key=lambda i: (not raw[i]["isref"], raw[i]["seq"], raw[i]["label"]))
    raw = [raw[i] for i in order]
    aid = {}; uniq = []
    for r in raw:
        if r["seq"] not in aid: aid[r["seq"]] = len(uniq); uniq.append(r["seq"])
        r["allele"] = aid[r["seq"]]
    anc = [(c["rb"], c["nodes"]) for c in cols if c.get("rb")]
    refname = None
    if anc:
        _n = next((n for n in min(anc)[1] if n in refcid), None)
        if _n is not None:
            _r = con.execute("SELECT name FROM ref_contigs WHERE contig_id=?", (refcid[_n],)).fetchone()
            refname = _r[0] if _r else None
    out = dict(name=label, bp=(min(anc)[0] if anc else None), refname=refname,
               nrow=len(raw), nallele=len(uniq),
               scan=dict(leaves=len(leaves), contigs=len(pis), tokens=ntok),   # 走査コストの実測(診断用)
               cols=[{k: c[k] for k in ("kind", "nodes", "g", "rb", "variant", "off", "bp", "so", "nl", "cp", "ri") if k in c} for c in cols],
               rows=[{"samp": r["samp"], "label": r["label"], "path": r["path"], "strand": r["strand"],
                      "seq": r["seq"], "isref": r["isref"], "allele": r["allele"],
                      "inv": invmaj(r), "invc": invcols(r), "hseq": r.get("hseq", ""), "read": r.get("rdinfo"), "rins": ((r.get("rins") or []) + (r.get("rext") or []) or None) if r.get("rdinfo") else None, "seqt": (r["seqt"] if r.get("seqt") != r["seq"] else None), "ends": r.get("ends", [False, False]), "brk": r.get("brk", [])} for r in raw])   # inv=行の優勢向きと逆に通ったノード(局所反転)
    print(json.dumps(out))

if __name__ == "__main__":
    main()
