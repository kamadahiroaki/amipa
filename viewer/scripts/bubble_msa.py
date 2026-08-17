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
import argparse, json, re, sqlite3, sys
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

def die(msg):
    print(json.dumps({"error": msg})); sys.exit(0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--distill", required=True)
    ap.add_argument("--nodes", required=True,
                    help="ノード名のカンマ区切り。S/クラスタは配下葉に展開、n… は葉そのもの")
    ap.add_argument("--samples", default="",
                    help="対象 sample/hap/contig キーのカンマ区切り(空=この bubble を通る全パス)。参照は常に含む")
    ap.add_argument("--flank", type=int, default=4)
    ap.add_argument("--merge-gap", dest="merge_gap", type=int, default=8,
                    help="選択集合を一時的に離れてすぐ戻る通過を『1 回の通過』として繋ぐ token 数の上限"
                         "(既定 8。実際は max(2*flank, これ)＝flank が重なるなら同じ通過とみなす)。"
                         "負値で無効=極大 run ごとに 1 行")
    ap.add_argument("--max-tokens", dest="max_tokens", type=int, default=MAX_TOKENS,
                    help="走査するウォーク token 数の上限(既定 %d)。越えたらエラー" % MAX_TOKENS)
    args = ap.parse_args()

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
    if not sel_nodes:
        die("ノードが指定されていません")
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
    rows = con.execute(
        "SELECT rowid FROM nodes WHERE layer_index=? AND node_name IN (%s)"
        % ",".join("?" * len(leaves)), [maxlayer] + leaves).fetchall()
    rowids = [r[0] for r in rows]
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
    if touch_cid:
        for cid in touch_cid:
            for pi in key2pi.get(cid2key.get(cid, "\0"), ()):
                pis.append(pi)
    else:
        pis = list(range(len(p_names)))           # cov 前絞り込み不可時は全走査にフォールバック
    # 参照を先に処理する: MAX_ROWS で打ち切られても整列の基準行(参照)が必ず残るように。
    pis = sorted(set(pi for pi in pis if matches(pi)), key=lambda pi: (not isref_pi(pi), pi))

    # ★ 走査量の事前見積り。WG は 1 contig が chr 級(数百万〜千万 token)なので、絞り込みを
    #   忘れて全 hap を選ぶと p_tok を数 GB 読んで timeout する。読む前に p_off の差分で判定して
    #   「絞ってください」と返す(黙って 30s 待たせない)。
    ntok = int(sum(int(p_off[pi + 1]) - int(p_off[pi]) for pi in pis))
    if ntok > args.max_tokens:
        die("走査対象が大きすぎます(%d contig / %.1fM token)。対象サンプル/ハプロタイプを絞ってください。"
            % (len(pis), ntok / 1e6))

    # --- 各触れ contig を distill から slice し、S 内極大 run を抽出 ---
    def runs_of(pi):
        a, b = int(p_off[pi]), int(p_off[pi + 1])
        if b <= a:
            return []
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
            runs.append(dict(samp=samp, lab=lab, ctg=ctg, path=full, isref=isref, ids=ids, ors=ors,
                             k=(0 if len(rr) == 1 else k + 1)))
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

    need = sorted({nname(t) for r in runs for t in r["ids"]}, key=lambda n: int(n[1:]))
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
    raw = []
    for r in runs:
        ids, ors = r["ids"], r["ors"]
        nodes = [nname(t) for t in ids]
        wp = sum(len(seqleaf.get(n, "")) for n, o in zip(nodes, ors) if o)        # '+' の bp
        wm = sum(len(seqleaf.get(n, "")) for n, o in zip(nodes, ors) if not o)    # '-' の bp
        rev = wm > wp                       # この行の優勢向き('-' 優勢 = 逆走 contig)
        cells, inv = {}, []
        for n, o in zip(nodes, ors):
            if n in cells:
                continue
            s = seqleaf.get(n, "?")
            if (not o) != rev:              # ステップ向きが行の優勢向きと違う = 局所反転
                s = rc(s); inv.append(n)
            cells[n] = s
        raw.append(dict(samp=r["samp"], label=r["label"], path=r["path"],
                        strand=("-" if rev else "+"), cells=cells, inv=inv,
                        nodes=set(nodes), isref=r["isref"]))

    # --- 固定幅列。★同じサイトの排他アレルは「アレル群」として **1 ブロック**にまとめる。
    #   旧実装は「id 隣接・等長・排他のペア」だけを統合していたので、3 アレル以上の site(G/A/C)や
    #   長さの違うアレル(1bp vs 3bp)がそれぞれ別列に並び、MSA としては同じ列に来るべきものが横に
    #   ずれて見えていた。ここでは id 昇順に貪欲に群を伸ばす:
    #     ・候補が群の既メンバと同じ行に共存する(=排他でない)なら別サイト → 群を閉じる
    #     ・群の支持行が全行を覆ったら、そのサイトは尽きた → 群を閉じる
    #   これで隣サイトへ連鎖せず、多アレル/不等長もまとまる。群の幅=メンバ最長、短いアレルは gap 埋め。 ---
    alln = sorted({n for r in raw for n in r["nodes"]}, key=lambda n: int(n[1:]))
    present = {n: set(i for i, r in enumerate(raw) if n in r["nodes"]) for n in alln}
    groups, gi = [], 0
    while gi < len(alln):
        g = [alln[gi]]; sup = set(present[alln[gi]]); gi += 1
        while gi < len(alln) and len(sup) < len(raw):
            c = alln[gi]
            if present[c] & sup:
                break
            g.append(c); sup |= present[c]; gi += 1
        groups.append(g)

    cols = []
    for g in groups:
        rb = next((refbp[n] for n in g if n in refbp), None)
        w = max((len(seqleaf.get(n, "")) for n in g), default=0)
        if w == 0:
            continue
        meta = dict(nodes=g, rb=rb)
        if w <= CAP:
            for k in range(w): cols.append(dict(kind="base", off=k, **meta))
        else:
            for k in range(HEAD): cols.append(dict(kind="base", off=k, **meta))
            cols.append(dict(kind="ell", bp=w, **meta))
            for k in range(w - TAIL, w): cols.append(dict(kind="base", off=k, **meta))

    def cellchar(r, c):
        s = None
        for n in c["nodes"]:                      # 群のメンバは互いに排他=行が持つのは高々1つ
            if n in r["cells"]:
                s = r["cells"][n]; break
        if s is None: return "-"
        if c["kind"] == "ell": return "~"
        k = c["off"]
        return s[k] if k < len(s) else "-"        # 同群で短いアレルは末尾を gap 埋め
    for r in raw:
        r["seq"] = "".join(cellchar(r, c) for c in cols)

    # --- bubble 内部(選択ノード配下の葉)の列範囲＋pad に自動トリム。
    #     変異は内部に集中する一方、flank は隣接 VNTR 等を拾いがちなので、内部基準で切ると焦点が定まる。 ---
    def is_var(ci):
        vals = set(r["seq"][ci] for r in raw); vals.discard("~")
        return len(vals) > 1
    leafset = set(leaves)
    intidx = [ci for ci in range(len(cols)) if any(n in leafset for n in cols[ci]["nodes"])]
    if intidx:
        a = max(0, min(intidx) - 3); b = min(len(cols), max(intidx) + 4)
    else:
        varidx = [ci for ci in range(len(cols)) if cols[ci].get("variant") or is_var(ci)]
        a, b = (max(0, min(varidx) - 3), min(len(cols), max(varidx) + 4)) if varidx else (0, len(cols))
    if b - a > MAX_COLS: b = a + MAX_COLS
    cols = cols[a:b]
    for r in raw: r["seq"] = r["seq"][a:b]
    # 変異フラグ(トリム後)
    for ci, c in enumerate(cols):
        vals = set(r["seq"][ci] for r in raw); vals.discard("~")
        c["variant"] = bool(c.get("variant")) or (len(vals) > 1)

    # 列が属する群の連番(frontend が境界の描画とブロック見出しに使う)
    gseq, gid = -1, []
    for c in cols:
        key = tuple(c["nodes"])
        if not gid or gid[-1][0] != key:
            gseq += 1; gid.append((key, gseq))
        c["g"] = gid[-1][1]

    # 行を allele(整列配列)でグループ化, 参照を先頭
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
               cols=[{k: c[k] for k in ("kind", "nodes", "g", "rb", "variant", "off", "bp") if k in c} for c in cols],
               rows=[{"samp": r["samp"], "label": r["label"], "path": r["path"], "strand": r["strand"],
                      "seq": r["seq"], "isref": r["isref"], "allele": r["allele"],
                      "inv": r["inv"]} for r in raw])   # inv=行の優勢向きと逆に通ったノード(局所反転)
    print(json.dumps(out))

if __name__ == "__main__":
    main()
