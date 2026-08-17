#!/usr/bin/env python3
"""ggb_hapidx — 「選択サンプル/ハプロタイプが通るノード・エッジだけ描画する」ための取得索引を作る。

既存の layered.db を **一切書き換えず**、サイドカー DB `<db>.hapidx` を作る。
backend は存在すれば ATTACH して viewport クエリにマスク条件を足す（無ければ従来動作＝graceful）。

--------------------------------------------------------------------------------
なぜこの形か（実測の根拠は functions/hapfilter/RESULTS.md）
--------------------------------------------------------------------------------
密領域の取得コストは「R-Tree 探索(50ns/entry)」ではなく「候補全件の行を実体化すること」
(nodes 行 1.6us/行、node_contig_cov の太い blob 25us/行) と Lustre cold random I/O。
よって絞り込みは **nodes 行を読む前に** 効かせるのが唯一効く形。

SQLite の R-Tree 補助列(`+hm0`)は **リーフページ(%_node.data)ではなく %_rowid 影テーブル**に入る
（実測確認: `CREATE TABLE nodes_rtree_hm_rowid(rowid INTEGER PRIMARY KEY, nodeno, a0, a1)`）。
つまりマスク判定は「候補ごとに %_rowid を rowid 点引き」する。効くのはそこが
**細くて rowid クラスタな表**（約 28B/行 = 8KB ページに約 290 行）だから:
  棄却候補 1 件のコスト = 細い %_rowid の 1 読み  ≪  太い nodes 行(20列)の 1 読み
実測 現行比 cold 1.7-4.7x / warm 2.5-2.7x、エッジは warm 最大 31x。
（同じ理由で「hb を node_contig_cov の太い blob 行から引くのが遅い」問題と表裏＝細い表に置くのが要。）

副産物: R-Tree を rowid 昇順に一括再構築するとページが整列し cold が 1.6-6x 速くなる。

--------------------------------------------------------------------------------
ハプロタイプ数 H に対するスケール（想定外の H で壊れないための設計）
--------------------------------------------------------------------------------
マスクの語数 W = min(ceil(H/64), --wmax)。R-Tree の 1 entry は 8*W バイト太る。

  mode=exact  (H <= 64*W): hap h → bit h。**厳密**。追加判定不要。
  mode=bucket (H >  64*W): hap h → bit (h mod 64*W)。**保守的（上位集合）**。
                           backend は生存ノードだけ既存 node_contig_cov blob で厳密判定する
                           （2段フィルタ）。誤りは出ない・効きが鈍るだけ。

  H=90   (HPRC v1.0 / chr22・WG)  → W=2 (128bit) exact
  H=400  (MC v2)                  → W=7 (448bit) exact
  H=4000 (将来)                   → W=8 で bucket（512 バケット, 約 7.8 hap/バケット）
  H=それ以上（ウイルス等）        → 同様に bucket。**H に依存せずインデックス幅は有界**。

--wmax を上げれば厳密域は広がるが R-Tree が太る（= 走査と cold I/O が重くなる）ので、
既定 8 (=512bit, +64B/entry) で打ち止め。H が非常に大きく厳密性が要る場合は
将来の逆索引 (hap→node の Morton 順チャンク; 問い合わせコストが H 非依存) を足す余地を
`hapidx_meta.layout` で判別できるようにしてある。

--------------------------------------------------------------------------------
置き場所（2 通り。backend はどちらでも同じ SQL で引ける = rtree の第1列は rowid 別名）
--------------------------------------------------------------------------------
  既定（サイドカー）: `<db>.hapidx` に nodes_rtree_hm / edge_hm を作る。**元 DB 無改変**。
                      既存の巨大 DB(WG 269GB)を作り直さずに機能を足せる。幾何が重複する分だけ嵩む。
  --into-db         : 元 DB の `nodes_rtree` を **補助列つきで作り直し**、`edge_hm` を同じ DB に作る。
                      幾何の重複なし。ついでに rowid 昇順の一括再構築になるので cold が 1.6-6x 改善。
                      emitter から最終段として呼ぶのはこちら（新しい DB は既定でこの形になる）。

出力スキーマ
--------------------------------------------------------------------------------
  hapidx_meta(key TEXT PRIMARY KEY, value TEXT)
      schema=1 / layout=rtree_aux / words=W / mode=exact|bucket / bits=64*W
      n_hap / n_contig / node_rows / edge_rows / src_db / src_built_at / src_emitter_rev
      built_at / builder_rev / node_done / edge_done
  hap_dict(hap_id INTEGER PRIMARY KEY, name TEXT, sample TEXT, haplotype TEXT,
           cid_lo INTEGER, cid_hi INTEGER, n_contig INTEGER)
      hap_id = distinct (sample, haplotype) を contig_id 昇順で採番
      = emitter `_build_contig2hap` / backend `contigToHap` と同一。
      cid_lo/cid_hi は「その hap の contig_id の min/max」（連続を仮定せず実測値）。
  nodes_rtree_hm  rtree(id, min_x,max_x, min_y,max_y, min_layer,max_layer, +hm0..+hm{W-1})
      id = nodes.rowid。bbox = xCoord±radius（emitter と同一）。
  edge_hm(edge_rowid INTEGER PRIMARY KEY, hm0..hm{W-1})
      edge_rowid = edges.rowid。cov 行が無いエッジ（誰も通らない）は行を作らない=マスク0扱い。

使い方:
  python3 ggb_hapidx.py --db path/to/x.layered.db                 # → x.layered.db.hapidx
  python3 ggb_hapidx.py --db ... --resume                         # 中断から再開
  python3 ggb_hapidx.py --db ... --verify 2000                    # 標本検証のみ
"""
import argparse, os, sqlite3, struct, sys, time
import numpy as np

BUILDER_REV = 'hapidx-1'
SCHEMA = '1'


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


def to_signed(v):
    """uint64 → SQLite の signed INTEGER 表現。"""
    return int(v) - (1 << 64) if int(v) >= (1 << 63) else int(v)


def to_unsigned(v):
    return int(v) + (1 << 64) if int(v) < 0 else int(v)


# ---------------------------------------------------------------- hap 採番
def build_hap_map(src):
    """contig_dict → (c2h: contig_id→hap_id の直引き配列, haps: hap 情報リスト)。

    hap_id は distinct (sample, haplotype) を contig_id 昇順で採番（emitter/backend と一致）。
    **contig_id が hap ごとに連続レンジであることを仮定しない**（将来の DB で崩れても正しく動く）。
    """
    rows = src.execute(
        'SELECT contig_id, sample, haplotype FROM contig_dict ORDER BY contig_id').fetchall()
    if not rows:
        return None, None
    maxid = max(r[0] for r in rows)
    c2h = np.full(maxid + 1, -1, dtype=np.int32)
    haps = []                     # [[name, sample, haplotype, cid_lo, cid_hi, n_contig], ...]
    last = None
    for cid, sample, hap in rows:
        key = (sample or '', hap or '')
        if key != last:
            haps.append([hap or (sample or ''), sample or '', hap or '', cid, cid, 0])
            last = key
        h = len(haps) - 1
        c2h[cid] = h
        haps[h][3] = min(haps[h][3], cid)
        haps[h][4] = max(haps[h][4], cid)
        haps[h][5] += 1
    # 同じ (sample,hap) が contig_id 上で不連続に再出現した場合の検出（警告のみ; c2h は正しい）
    seen, dup = set(), 0
    last = None
    for cid, sample, hap in rows:
        key = (sample or '', hap or '')
        if key != last:
            if key in seen:
                dup += 1
            seen.add(key)
            last = key
    if dup:
        log(f'WARN: (sample,haplotype) が contig_id 上で不連続に再出現 {dup} 件 → '
            f'hap_dict.cid_lo/cid_hi はレンジでなく min/max。backend はレンジ前提にしないこと')
    return c2h, haps


# ---------------------------------------------------------------- マスク計算
class MaskCalc:
    """contig_id 配列 → W 語の hap ビットマスク（ベクトル化）。"""

    def __init__(self, c2h, n_hap, words, mode, spread=1):
        self.c2h = c2h
        self.W = words
        self.bits = 64 * words
        self.mode = mode
        # hap_id → (word, bit) を事前計算（bucket モードは折り返し済み）
        # spread>1 はデバッグ用: hap_id を散らして「H が spread 倍」の格納コストを模擬する。
        h = np.arange(max(1, n_hap), dtype=np.int64) * max(1, spread)
        b = h % self.bits if mode == 'bucket' else h
        self.hword = (b >> 6).astype(np.int64)
        self.hbit = (np.uint64(1) << (b & 63).astype(np.uint64))

    def compute(self, blobs):
        """blobs: list[bytes|None]（[u32 n][n×u32 contig_id][...]）→ (n, W) uint64 配列。"""
        n = len(blobs)
        out = np.zeros((n, self.W), dtype=np.uint64)
        cnts = np.zeros(n, dtype=np.int64)
        parts = []
        for i, b in enumerate(blobs):
            if not b or len(b) < 4:
                continue
            k = struct.unpack_from('<I', b, 0)[0]
            if k == 0:
                continue
            need = 4 + 4 * k
            if len(b) < need:            # 壊れた blob は安全側（マスク0）に倒す
                continue
            cnts[i] = k
            parts.append(b[4:need])
        if not parts:
            return out
        ids = np.frombuffer(b''.join(parts), dtype='<u4').astype(np.int64)
        # 範囲外 contig_id / 未割当(-1) は無視
        ok = (ids >= 0) & (ids < self.c2h.size)
        hap = np.full(ids.size, -1, dtype=np.int64)
        hap[ok] = self.c2h[ids[ok]]
        off = np.zeros(n + 1, dtype=np.int64)
        np.cumsum(cnts, out=off[1:])
        nz = cnts > 0
        starts = off[:-1][nz]
        valid = hap >= 0
        for w in range(self.W):
            sel = valid & (self.hword[np.where(valid, hap, 0)] == w)
            bits = np.where(sel, self.hbit[np.where(valid, hap, 0)], np.uint64(0))
            out[nz, w] = np.bitwise_or.reduceat(bits, starts)
        return out


# ---------------------------------------------------------------- 出力 DB
def open_dst(path, page_size, cache_mb, mmap_gb, fresh):
    if fresh and os.path.exists(path):
        os.remove(path)
    for suf in ('-journal', '-wal', '-shm'):
        p = path + suf
        if fresh and os.path.exists(p):
            os.remove(p)
    d = sqlite3.connect(path)
    if fresh:
        d.execute(f'PRAGMA page_size={page_size}')
    d.execute('PRAGMA journal_mode=OFF')
    d.execute('PRAGMA synchronous=OFF')
    d.execute('PRAGMA temp_store=MEMORY')
    d.execute(f'PRAGMA cache_size=-{cache_mb * 1024}')
    if mmap_gb:
        d.execute(f'PRAGMA mmap_size={int(mmap_gb * (1 << 30))}')
    return d


def integrity_ok(con, schema='main'):
    """PRAGMA quick_check。異常終了後の残骸をそのまま延長して不正な索引を作らないための門。
       (quick_check は integrity_check より速く、ページ構造の破損は検出できる)"""
    try:
        r = con.execute(f'PRAGMA {schema}.quick_check(64)').fetchall()
        ok = len(r) == 1 and str(r[0][0]).lower() == 'ok'
        if not ok:
            log('quick_check: ' + '; '.join(str(x[0])[:120] for x in r[:5]))
        return ok
    except Exception as e:
        log(f'quick_check 実行不能: {e}')
        return False


def meta_set(dst, **kw):
    dst.executemany('INSERT OR REPLACE INTO hapidx_meta(key,value) VALUES(?,?)',
                    [(k, str(v)) for k, v in kw.items()])
    dst.commit()


def meta_get(dst, key, default=None):
    r = dst.execute('SELECT value FROM hapidx_meta WHERE key=?', (key,)).fetchone()
    return r[0] if r else default


# 描画用の補助列（--draw-aux, 既定 ON）。
#
# なぜ: WG の cold では「1 行あたりに触る 4KB ページ数」が律速で、`/nodes` は
#   R-Tree(%_node, 空間クラスタ=連続ページ) + `nodes` 行(rowid 順=空間順と一致せず 1 行 1 ページ)
#   の 2 本を触る。ビューポート内 2,000 行の実測（functions/covpack/RESULTS.md §12）で
#   R-Tree だけなら 0.014-0.028 秒（読み 0 バイト）、`nodes` 行を足すと 0.135-0.206 秒。
#   → **描画に要る列を補助列(%_rowid)へ移せば `nodes` を読まずに描ける = 7.5-9.3x**。
#   x=(min_x+max_x)/2 / radius=(max_x-min_x)/2 は幾何から導出できるので、足すのは残りだけ。
#
# 何を足すか（GraphCanvas.tsx の使用箇所を数えて決めた）:
#   ang  angle を 1e6 倍した整数（3-4B）。向きの計算と編集の回転に必須
#   nm   node_name（約 8B）。`/edges` が名前で端点を返すので突合に必要（14 箇所で使用）
#   hb   hap-breadth（1B, max 90）。エッジ/ノードの太さ。今は 195B/行の node_contig_cov を引いている
#   bnd/gcn/rgn  band_id / gene_cnt / region_class（各 1B 未満）。今は node_annot を引いている
#   rbp/rbe/rci/ranc/rmul/rstr  参照座標トラック
#     (ref_bp / ref_bp_end / ref_contig_id / is_anchor / ref_multi / ref_strand)。
#     Ref bp トラックは**既定 ON** なので、これが無いと高速経路をほぼ使えない。
#     実測バイト(chr22 nodes): ref_bp 0.93B / ref_bp_end 0.93B / 残り 4 列は 0B（全 NULL か 0/1）。
#     データは約 1.9B だが **列 1 本ごとにレコードヘッダ 1B** かかるので計 +約 8B/行。
# 入れないもの: size/coverage(ラベル・フィルタ時だけ) / color・is_bubble(描画で未使用) /
#   blob 類（node_contig_cov.blob は 186B で、入れると %_rowid が 7 倍太り本末転倒）
#
# ★補助列は %_rowid に入る。1 行が太るとページ/行が増えるので **足す列は最小限に**。
#   実測の見積り: 28B → 40B で 7x → 約 5x、44B で 約 4.5x。
DRAW_AUX = ('cx', 'cy', 'ang', 'rad', 'nm', 'hb', 'bnd', 'gcn', 'rgn',
            'rbp', 'rbe', 'rci', 'ranc', 'rmul', 'rstr')
# ★幾何(cx,cy,rad)は **箱から導出せず補助列で持つ**。R-Tree の矩形は float32 で外向きに
#   丸められる（包含保証のための仕様）ので、箱から復元した値は必ずずれる:
#     radius=(max_x-min_x)/2  → 必ず過大。深層で **相対 174%**（wgpggb L2 実測）
#     x=(min_x+max_x)/2       → 座標の桁(0.2〜0.9)での 1 ulp ≈ 3〜6e-8 が乗る
#   絶対誤差はどちらも 1e-7 world 程度で「小さい」が、**深層ノードは自分の radius が
#   その同オーダー**（例 mcgrch38 n23316007: radius 4.37e-08 に対し Δy 4.5e-08）。
#   viewer はノードが見える大きさまでズームするので、効くのは world 比でなく
#   **そのノード自身の大きさに対する比**。この判断を 2 回間違えた（radius→位置）。
#   矩形は**空間索引としてだけ**使い、描画に使う幾何は全部ここから取る。
#   REAL のまま持つ理由: radius の動的範囲が 4e-3〜1e-8 以下と広く、固定倍率の整数化では
#   最小のノードが 0 に潰れる。3 列 24B/行 = WG 200M 行で約 4.8GB（DB の 1.6%）。
# ★rad(=nodes.radius) を **REAL のまま**持つ理由:
#   R-Tree の矩形は float32 で **外向きに丸められる**（包含保証のための仕様）ので、
#   viewer が `(max_x-min_x)/2` で radius を復元すると必ず過大になる。誤差は絶対値では
#   約 1e-7 world で一定だが、深層のノードは radius 自体が 1e-7 前後なので
#   **相対で最大 174% 過大**になる（wgpggb 実測: L2 174% / L4-L12 119% / L17 92%）。
#   viewer はエッジ端点を `中心 ± radius·(cosθ,sinθ)` に置くので、これがそのまま
#   「ノード/エッジがリボンに対してずれる」形で見える（リボンは nodes.radius を直読みするため正しい）。
#   ang のような整数スケールにしないのは、radius の動的範囲が広く(4e-3 〜 5e-8 以下)、
#   固定倍率だと最小のノードが 0 に潰れるため。8B/行 = WG 200M 行で約 1.6GB（DB の 0.6%）。
# rbp.. は nodes のこの列から取る（無い DB では NULL）
REF_COLS = ('ref_bp', 'ref_bp_end', 'ref_contig_id', 'is_anchor', 'ref_multi', 'ref_strand')
ANG_SCALE = 1000000          # angle を整数化する倍率（viewer 側も同じ値で割る）


def create_schema(dst, W, mode, n_hap, haps, meta, rt='nodes_rtree_hm', draw_aux=True):
    dst.execute('CREATE TABLE IF NOT EXISTS hapidx_meta(key TEXT PRIMARY KEY, value TEXT)')
    dst.execute('CREATE TABLE IF NOT EXISTS hap_dict(hap_id INTEGER PRIMARY KEY, name TEXT, '
                'sample TEXT, haplotype TEXT, cid_lo INTEGER, cid_hi INTEGER, n_contig INTEGER)')
    if not dst.execute('SELECT 1 FROM hap_dict LIMIT 1').fetchone():
        dst.executemany('INSERT INTO hap_dict VALUES(?,?,?,?,?,?,?)',
                        [(i, h[0], h[1], h[2], h[3], h[4], h[5]) for i, h in enumerate(haps)])
    aux_l = [f'+hm{w}' for w in range(W)]
    if draw_aux:
        aux_l += [f'+{c}' for c in DRAW_AUX]
    dst.execute(f'CREATE VIRTUAL TABLE IF NOT EXISTS {rt} USING rtree('
                f'id, min_x, max_x, min_y, max_y, min_layer, max_layer, {", ".join(aux_l)})')
    cols = ', '.join(f'hm{w} INTEGER' for w in range(W))
    dst.execute(f'CREATE TABLE IF NOT EXISTS edge_hm(edge_rowid INTEGER PRIMARY KEY, {cols})')
    meta_set(dst, schema=SCHEMA, layout='rtree_aux', words=W, mode=mode, bits=64 * W,
             n_hap=n_hap, builder_rev=BUILDER_REV,
             draw_aux=('1' if draw_aux else '0'),
             draw_aux_cols=(','.join(DRAW_AUX) if draw_aux else ''),
             ang_scale=str(ANG_SCALE), **meta)


# ---------------------------------------------------------------- nodes
def build_nodes(src, dst, mc, batch, resume_from, total_hint, rt='nodes_rtree_hm',
                draw_aux=True, has_hb=False, has_annot=False, has_ref=False):
    """nodes の rowid レンジごとに 幾何(nodes) と マスク(node_contig_cov) を読み、rtree へ一括 INSERT。

    rowid レンジで区切るのは --into-db（読み書き同一接続）でも安全に commit できるようにするため
    （SELECT カーソルを開いたまま commit すると SQLite が失敗する）。nodes.rowid は 1..N 連続、
    node_contig_cov.node_rowid はその部分集合（cov 行が無いノード＝誰も通らない → マスク0）。
    """
    W = mc.W
    nx = len(DRAW_AUX) if draw_aux else 0
    ph = ','.join('?' * (7 + W + nx))
    ins = f'INSERT INTO {rt} VALUES({ph})'
    # 描画用補助列は nodes / node_contig_cov.hb / node_annot から集める。
    # angle は 1e6 倍して整数化（REAL 8B → 3-4B。viewer は ANG_SCALE で割る）。
    geo_cols = 'rowid, xCoord, yCoord, radius, layer_index'
    if draw_aux:
        geo_cols += ', angle, node_name'
        # 参照座標 6 列は nodes から一緒に取る（列が無い DB では NULL を入れる）
        geo_cols += (', ' + ', '.join(REF_COLS)) if has_ref else ''
    n = 0
    t0 = time.time()
    lo = resume_from + 1
    while lo <= total_hint:
        hi = min(lo + batch - 1, total_hint)
        geo = src.execute(f'SELECT {geo_cols} FROM nodes '
                          'WHERE rowid BETWEEN ? AND ? ORDER BY rowid', (lo, hi)).fetchall()
        if geo:
            cov = dict(src.execute('SELECT node_rowid, blob FROM node_contig_cov '
                                   'WHERE node_rowid BETWEEN ? AND ?', (lo, hi)).fetchall())
            m = mc.compute([cov.get(g[0]) for g in geo])
            hbm = dict(src.execute('SELECT node_rowid, hb FROM node_contig_cov '
                                   'WHERE node_rowid BETWEEN ? AND ?', (lo, hi)).fetchall()) \
                if (draw_aux and has_hb) else {}
            anm = {}
            if draw_aux and has_annot:
                anm = {r[0]: (r[1], r[2], r[3]) for r in src.execute(
                    'SELECT node_rowid, band_id, gene_cnt, region_class FROM node_annot '
                    'WHERE node_rowid BETWEEN ? AND ?', (lo, hi))}
            rows = []
            for i, g in enumerate(geo):
                rid, x, y, r, L = g[0], g[1], g[2], g[3], g[4]
                rr = r or 0.0
                rec = [rid, x - rr, x + rr, y - rr, y + rr, L, L,
                       *(to_signed(m[i, w]) for w in range(W))]
                if draw_aux:
                    ang, nm = g[5], g[6]
                    b, gc, rg = anm.get(rid, (None, None, None))
                    rec += [x, y, None if ang is None else int(round(ang * ANG_SCALE)), rr, nm,
                            hbm.get(rid), b, gc, rg]
                    rec += list(g[7:13]) if has_ref else [None] * len(REF_COLS)
                rows.append(tuple(rec))
            dst.executemany(ins, rows)
            n += len(geo)
            dst.commit()
        lo = hi + 1
        if n and n % (batch * 10) < batch:
            el = time.time() - t0
            rate = n / max(1e-9, el)
            eta = (total_hint - resume_from - n) / rate if rate else 0
            log(f'  nodes {resume_from + n:,}/{total_hint:,}  {rate/1000:.0f}k rows/s  '
                f'ETA {eta/60:.0f} min')
    return n


# ---------------------------------------------------------------- edges
def build_edges(src, dst, mc, batch, resume_from, total_hint):
    """edge_contig_cov を edge_rowid レンジごとに読み、edge_hm へ一括 INSERT（cov 行が無い辺は作らない）。"""
    W = mc.W
    ph = ','.join('?' * (1 + W))
    ins = f'INSERT INTO edge_hm VALUES({ph})'
    n = 0
    t0 = time.time()
    lo = resume_from + 1
    while lo <= total_hint:
        hi = min(lo + batch - 1, total_hint)
        g = src.execute('SELECT edge_rowid, blob FROM edge_contig_cov '
                        'WHERE edge_rowid BETWEEN ? AND ? ORDER BY edge_rowid',
                        (lo, hi)).fetchall()
        if g:
            m = mc.compute([b for _, b in g])
            dst.executemany(ins, [(g[i][0], *(to_signed(m[i, w]) for w in range(W)))
                                  for i in range(len(g))])
            n += len(g)
            dst.commit()
        lo = hi + 1
        if n and n % (batch * 10) < batch:
            el = time.time() - t0
            rate = n / max(1e-9, el)
            log(f'  edges {resume_from + n:,}/{total_hint:,}  {rate/1000:.0f}k rows/s  '
                f'ETA {(total_hint - resume_from - n)/max(1e-9, rate)/60:.0f} min')
    return n


# ---------------------------------------------------------------- 検証
def verify(src, dst, mc, k, vt='nodes_rtree_hm'):
    """標本 k 件について (a) bbox が元 nodes_rtree と一致 (b) マスクが blob と整合 を確認。"""
    W = mc.W
    bad_geo = bad_mask = tot = 0
    same = (vt == 'nodes_rtree')      # 差し替え済 = 比較相手が自分自身なので bbox 検証は無意味
    rows = dst.execute(f'SELECT id FROM {vt} ORDER BY RANDOM() LIMIT ?', (k,)).fetchall()
    for (rid,) in rows:
        a = src.execute('SELECT min_x,max_x,min_y,max_y,min_layer,max_layer FROM nodes_rtree '
                        'WHERE rowid=?', (rid,)).fetchone()
        b = dst.execute(f'SELECT min_x,max_x,min_y,max_y,min_layer,max_layer FROM {vt} '
                        'WHERE id=?', (rid,)).fetchone()
        tot += 1
        if not same and (a is None or b is None or any(abs(x - y) > 0 for x, y in zip(a, b))):
            bad_geo += 1
        br = src.execute('SELECT blob FROM node_contig_cov WHERE node_rowid=?', (rid,)).fetchone()
        want = mc.compute([br[0] if br else None])[0]
        got = dst.execute(
            'SELECT ' + ','.join(f'hm{w}' for w in range(W)) +
            f' FROM {vt} WHERE id=?', (rid,)).fetchone()
        if tuple(to_unsigned(g) for g in got) != tuple(int(x) for x in want):
            bad_mask += 1
    log(f'verify nodes: {tot} 標本 / bbox 不一致 '
        + ('(差し替え済のため省略)' if same else str(bad_geo))
        + f' / マスク不一致 {bad_mask}')
    etot = ebad = 0
    for (rid,) in dst.execute('SELECT edge_rowid FROM edge_hm ORDER BY RANDOM() LIMIT ?',
                              (k,)).fetchall():
        br = src.execute('SELECT blob FROM edge_contig_cov WHERE edge_rowid=?', (rid,)).fetchone()
        want = mc.compute([br[0] if br else None])[0]
        got = dst.execute('SELECT ' + ','.join(f'hm{w}' for w in range(W)) +
                          ' FROM edge_hm WHERE edge_rowid=?', (rid,)).fetchone()
        etot += 1
        if tuple(to_unsigned(g) for g in got) != tuple(int(x) for x in want):
            ebad += 1
    log(f'verify edges: {etot} 標本 / マスク不一致 {ebad}')
    return bad_geo == 0 and bad_mask == 0 and ebad == 0


# ---------------------------------------------------------------- main
def main():
    p = argparse.ArgumentParser(description='hap 絞り込み取得索引（サイドカー）を作る')
    p.add_argument('--db', required=True, help='入力 layered.db（読み取り専用でしか開かない）')
    p.add_argument('--out', help='出力サイドカー（既定: <db>.hapidx）')
    p.add_argument('--into-db', action='store_true',
                   help='サイドカーを作らず、元 DB の nodes_rtree を補助列つきで作り直し edge_hm も同 DB に作る'
                        '（emitter 統合用。元 DB を書き換えるので注意）')
    p.add_argument('--wmax', type=int, default=8, help='マスク語数の上限（既定 8=512bit）')
    p.add_argument('--draw-aux', dest='draw_aux', action='store_true', default=True,
                   help='描画用の補助列(ang/nm/hb/bnd/gcn/rgn)も R-Tree に載せる（既定 ON）。'
                        'viewer が nodes 行を読まずにビューポートを描けるようになる'
                        '（WG cold 実測で /nodes が 7.5-9.3x。補助列が太る分 実効は約 4-5x の見込み）')
    p.add_argument('--no-draw-aux', dest='draw_aux', action='store_false',
                   help='描画用補助列を載せない（マスクのみ。従来と同じ形）')
    p.add_argument('--batch', type=int, default=200_000)
    p.add_argument('--cache-mb', type=int, default=1024)
    p.add_argument('--page-size', type=int, default=8192)
    p.add_argument('--mmap-gb', type=float, default=0)
    p.add_argument('--resume', action='store_true', help='既存サイドカーの続きから')
    p.add_argument('--verify', type=int, default=1000, help='標本検証件数（0 で省略）')
    p.add_argument('--verify-only', action='store_true')
    p.add_argument('--skip-nodes', action='store_true')
    p.add_argument('--skip-edges', action='store_true')
    p.add_argument('--no-integrity-check', dest='integrity_check', action='store_false', default=True,
                   help='書き換え/再開の前の PRAGMA quick_check を省く。'
                        'quick_check は **DB 全ページを読む** ので、Lustre 上の巨大 DB では'
                        '実質実行不能（WG 273GB で cold random 0.46MB/s = 数百時間）。'
                        '直前に自分で作った／コピーした DB だと分かっているときだけ使う')
    p.add_argument('--force-words', type=int, help='デバッグ: W を強制（幅の影響測定用）')
    p.add_argument('--spread', type=int, default=1,
                   help='デバッグ: hap_id を N 倍に散らして H を N 倍に見せかける（大 H の実コスト測定用。'
                        'SQLite は値 0 の整数を 0 バイトで格納するので、単に W を増やしただけでは'
                        '空語がほぼ無コストになり大 H の代理にならない）')
    a = p.parse_args()

    # 置き場所の決定。--into-db は元 DB を書き換える（emitter 最終段として使う形）。
    into = bool(a.into_db)
    out = a.db if into else (a.out or (a.db + '.hapidx'))
    if into and a.out:
        log('WARN: --into-db では --out は無視される')
    # --into-db は読み書き同一接続（レンジ読みにしてあるので commit と衝突しない）。
    src = sqlite3.connect(a.db) if into else sqlite3.connect('file:' + a.db + '?mode=ro', uri=True)
    src.execute(f'PRAGMA cache_size=-{a.cache_mb * 1024}')

    tabs = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for need in ('nodes', 'nodes_rtree', 'contig_dict', 'node_contig_cov'):
        if need not in tabs:
            log(f'ERROR: {a.db} に {need} が無い → この DB では hapidx を作れない')
            return 2
    has_edge_cov = 'edge_contig_cov' in tabs
    if not has_edge_cov:
        log('WARN: edge_contig_cov が無い → エッジ側マスクは作らない（ノード絞り込みのみになる）')

    c2h, haps = build_hap_map(src)
    if not haps:
        log('ERROR: contig_dict が空')
        return 2
    H = len(haps)
    C = int(c2h.size)
    Heff = H * max(1, a.spread)          # spread 込みの実効 H（幅と mode の決定に使う）
    W = a.force_words or min(max(1, (Heff + 63) // 64), a.wmax)
    mode = 'exact' if Heff <= 64 * W else 'bucket'
    node_rows = src.execute('SELECT MAX(rowid) FROM nodes').fetchone()[0] or 0
    edge_rows = (src.execute('SELECT MAX(rowid) FROM edges').fetchone()[0] or 0) if has_edge_cov else 0
    smeta = dict(src.execute('SELECT key,value FROM db_meta')) if 'db_meta' in tabs else {}

    log(f'src   = {a.db} ({os.path.getsize(a.db)/1e9:.1f} GB)')
    log(f'hap   = H={H}' + (f' (spread x{a.spread} → 実効 H={Heff})' if a.spread > 1 else '')
        + f' / contig C={C} / words W={W} ({64*W} bit) / mode={mode}')
    if mode == 'bucket':
        log(f'      → 実効 H({Heff}) > {64*W} なので **保守的マスク**（hap h → bit h mod {64*W}, '
            f'約 {Heff/(64*W):.1f} hap/バケット）。backend 側で node_contig_cov による厳密判定が必要。')
    log(f'rows  = nodes {node_rows:,} / edges {edge_rows:,}')
    log(f'out   = {out}' + ('  (元 DB を書き換え: nodes_rtree を補助列つきで作り直す)' if into else ''))

    mc = MaskCalc(c2h, H, W, mode, a.spread)

    # --into-db は元 nodes_rtree を残したまま一時名で作り、完成後に差し替える（途中で落ちても
    # 元 DB は viewer から従来どおり使える = 半端な状態で壊さない）。
    RT = 'nodes_rtree_hmnew' if into else 'nodes_rtree_hm'
    if into:
        dst = src
        # ★ここで journal_mode=OFF にしてはいけない。--into-db は **既存の本番 DB** を書き換えるので、
        #   ジャーナル無しだとプロセス落ち・OOM・qdel で DB そのものが壊れる(WG は 269GB)。
        #   journal は既定(DELETE)のまま残し、synchronous だけ OFF にする
        #   (プロセス落ちには耐える／電源断には耐えない、という妥当な折衷。速度はほぼ同じ)。
        dst.execute('PRAGMA synchronous=OFF')
        dst.execute('PRAGMA temp_store=MEMORY')
        if not a.integrity_check:
            log('quick_check: --no-integrity-check により省略')
        elif not integrity_ok(dst, 'main'):
            log('ERROR: 対象 DB の quick_check が通らない → 書き換えを中止')
            return 2
        if not a.resume and not a.verify_only:
            for t in ('hapidx_meta', 'hap_dict', 'edge_hm'):
                dst.execute(f'DROP TABLE IF EXISTS {t}')
            dst.execute(f'DROP TABLE IF EXISTS {RT}')
            dst.commit()
    else:
        dst = open_dst(out, a.page_size, a.cache_mb, a.mmap_gb,
                       not (a.resume or a.verify_only))
        # サイドカーは journal_mode=OFF(derived なので壊れても作り直せる)。ただし --resume で
        # 壊れた残骸の続きを書くと黙って不正な索引が出来るので、再開前に必ず検査する。
        if a.resume and a.integrity_check and not integrity_ok(dst, 'main'):
            log(f'ERROR: 既存 {out} が壊れている(前回の異常終了)。--resume 不可 → '
                f'--resume を外して作り直すこと')
            return 2
    create_schema(dst, W, mode, H, haps,
                  dict(n_contig=C, node_rows=node_rows, edge_rows=edge_rows,
                       src_db=os.path.basename(a.db),
                       src_built_at=smeta.get('built_at', ''),
                       src_emitter_rev=smeta.get('emitter_rev', ''),
                       spread=a.spread, into_db=int(into),
                       built_at=time.strftime('%Y-%m-%d %H:%M:%S')), rt=RT,
                  draw_aux=a.draw_aux)
    # 既存の索引と W/mode が食い違ったまま resume すると壊れるので突き合わせる
    if a.resume or a.verify_only:
        for k, v in (('words', W), ('mode', mode)):
            got = meta_get(dst, k)
            if got is not None and got != str(v):
                log(f'ERROR: 既存 {out} は {k}={got} だが今回 {k}={v} → --resume 不可（作り直し）')
                return 2

    # verify は完成後の表名（--into-db なら差し替え済の nodes_rtree）を見る
    VT = 'nodes_rtree' if into else 'nodes_rtree_hm'
    if a.verify_only:
        return 0 if verify(src, dst, mc, a.verify or 1000, VT) else 1

    t_all = time.time()
    if not a.skip_nodes:
        done = dst.execute(f'SELECT MAX(id) FROM {RT}').fetchone()[0] or 0
        if done and not a.resume:
            done = 0
        log(f'nodes: rowid > {done:,} から構築')
        # hb / node_annot は無い DB もあるので存在を見てから読む（無ければ NULL を入れる）
        _has_hb = bool(src.execute(
            "SELECT 1 FROM pragma_table_info('node_contig_cov') WHERE name='hb'").fetchone())
        _has_annot = bool(src.execute(
            "SELECT 1 FROM pragma_table_info('node_annot') WHERE name='band_id'").fetchone())
        if a.draw_aux:
            log(f'  描画用補助列: {",".join(DRAW_AUX)}  (hb={"有" if _has_hb else "無"} '
                f'node_annot={"有" if _has_annot else "無"}; angle は x{ANG_SCALE} の整数)')
        _has_ref = bool(src.execute(
            "SELECT 1 FROM pragma_table_info('nodes') WHERE name='ref_bp'").fetchone())
        if a.draw_aux:
            log(f'  参照座標 6 列: {"有" if _has_ref else "無（NULL で埋める）"}')
        n = build_nodes(src, dst, mc, a.batch, done, node_rows, rt=RT,
                        draw_aux=a.draw_aux, has_hb=_has_hb, has_annot=_has_annot,
                        has_ref=_has_ref)
        meta_set(dst, node_done=1, node_written=done + n,
                 # ★R-Tree を作り直した時刻。db_meta.built_at は ④ emit の時刻のままなので、
                 #   後から hapidx だけ回したときに「どの版を見ているか」が分からなくなる
                 #   （rad 追加の再構築で実際に「05:59:04 のままだがこれで合っているのか」となった）。
                 rtree_built_at=time.strftime('%Y-%m-%d %H:%M:%S'),
                 draw_aux_cols_actual=','.join(DRAW_AUX) if a.draw_aux else '')
        log(f'nodes done: +{n:,} 行 (計 {done+n:,}) {time.time()-t_all:.0f}s')

    if has_edge_cov and not a.skip_edges:
        t = time.time()
        done = dst.execute('SELECT MAX(edge_rowid) FROM edge_hm').fetchone()[0] or 0
        if done and not a.resume:
            done = 0
        log(f'edges: rowid > {done:,} から構築')
        n = build_edges(src, dst, mc, a.batch, done, edge_rows)
        meta_set(dst, edge_done=1, edge_written=done + n)
        log(f'edges done: +{n:,} 行 (計 {done+n:,}) {time.time()-t:.0f}s')

    if into and not a.skip_nodes:
        # 差し替え。rtree の RENAME は影テーブル(%_node/%_rowid/%_parent)も追随する（実測確認）。
        # nodes.rowid ↔ rtree.rowid の整合を確認してから捨てる（壊れた索引で置き換えないため）。
        bad = dst.execute(f'SELECT COUNT(*) FROM nodes n JOIN {RT} r ON n.rowid=r.id '
                          'WHERE n.layer_index<>r.min_layer').fetchone()[0]
        cnt = dst.execute(f'SELECT COUNT(*) FROM {RT}').fetchone()[0]
        if bad or cnt != node_rows:
            log(f'ERROR: 新 rtree が不整合 (layer 不一致 {bad} / 件数 {cnt:,} vs nodes {node_rows:,}) '
                f'→ 差し替えを中止（元 nodes_rtree はそのまま）')
            return 2
        dst.execute('DROP TABLE nodes_rtree')
        dst.execute(f'ALTER TABLE {RT} RENAME TO nodes_rtree')
        dst.commit()
        log('nodes_rtree を補助列つきの新 rtree へ差し替えた')

    dst.execute('ANALYZE')
    dst.commit()
    log(f'out size = {os.path.getsize(out)/1e9:.2f} GB / 合計 {(time.time()-t_all)/60:.1f} min')
    ok = True
    if a.verify:
        ok = verify(src, dst, mc, a.verify, VT if into else 'nodes_rtree_hm')
    dst.close()
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
