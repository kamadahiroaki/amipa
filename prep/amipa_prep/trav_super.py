#!/usr/bin/env python3
"""スーパーノード（LOD の上の層のノード）に合意座標 x を付けて <db>.trav に super 表を足す。
x ＝ 子孫の葉のうち bp 合計が最大の派閥（x を 1,000 錨の桶に分けたときの最大の桶）の bp 加重平均。frac ＝ その派閥の bp の割合。
使い方: trav_super.py <main.db> <db.trav> <distill_dir> [--bin 1000]
"""
import sys, sqlite3, time, argparse
import numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('db'); ap.add_argument('trav'); ap.add_argument('distill'); ap.add_argument('--bin', type=int, default=1000)
a = ap.parse_args(); t0 = time.time()
T = sqlite3.connect(a.trav)
X = np.frombuffer(T.execute("select blob from arrays where name='x_of_dense'").fetchone()[0], np.int32).copy()
# 錨でない葉は x_fill（直前の錨の x の bp 加重多数）で補う（10-28: 錨を持たない葉だけからなるスーパーノード＝株固有の配列・可変領域が座標を持たず、
# 高密度領域で灰になった。ecoli 原子 149–155 の層 8 で 2,854 個中 1,886 個）。x_fill が無い trav では従来どおり
_xf = T.execute("select blob from arrays where name='x_fill'").fetchone()
if _xf: XF = np.frombuffer(_xf[0], np.int32); m_ = (X < 0) & (XF[:len(X)] >= 0); X[m_] = XF[:len(X)][m_]; print(f'x_fill で補った葉 {int(m_.sum()):,}', file=sys.stderr)
id_map = np.load(a.distill + '/id_map.npy'); N = len(id_map)
sid = np.load(a.distill + '/s_id.npy'); sbp = np.load(a.distill + '/s_bp.npy'); bp = np.zeros(N + 1, np.int64); bp[sid] = sbp
print(f'trav/distill 読み込み {time.time()-t0:.1f}s', file=sys.stderr)
# 11-02: 全ゲノム向けに書き直した。以前は名前と親を Python の文字列・辞書で持ち（全ゲノムで 1.6 億行）、層ごとに索引で引き（213 GB の本体でランダム読み）、
# 葉ごと・層ごとに Python のループだった。名前は「接頭辞（n 葉 / G / S）＋整数」なので SQL の中で整数の符号に直し、本体を 1 回順に読む
PFX = {'n': 0, 'G': 1, 'S': 2}; SH = 1 << 40
enc = lambda col: f"(CASE substr({col},1,1) WHEN 'n' THEN 0 WHEN 'G' THEN 1 WHEN 'S' THEN 2 ELSE 3 END) * {SH} + CAST(substr({col},2) AS INTEGER)"
D = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
cs = D.execute(f"SELECT layer_index, {enc('node_name')}, CASE WHEN parent_name IS NULL OR parent_name = '' THEN -1 ELSE {enc('parent_name')} END FROM nodes NOT INDEXED")
parts = []
while True:
    rows = cs.fetchmany(1_000_000)
    if not rows: break
    parts.append(np.array(rows, np.int64))
A_ = np.concatenate(parts); del parts
if ((A_[:, 1] >> 40) == 3).any() or ((A_[:, 2] >= 0) & ((A_[:, 2] >> 40) == 3)).any(): sys.exit('ノード名が n/G/S＋整数の形でない（trav_super は対応していない）')
maxL = int(A_[:, 0].max()); print(f'ノード表 {A_.shape[0]:,} 行・層 0–{maxL}（{time.time()-t0:.1f}s）', file=sys.stderr)
o_ = np.argsort(A_[:, 0], kind='stable'); A_ = A_[o_]; lb = np.searchsorted(A_[:, 0], np.arange(maxL + 2))
code = {L: A_[lb[L]:lb[L + 1], 1] for L in range(maxL + 1)}; pcode = {L: A_[lb[L]:lb[L + 1], 2] for L in range(maxL + 1)}
# 親の添字（層 L のノード → 層 L-1 の添字、無ければ -1）: 層 L-1 の符号を並べて二分探索
par = {}
for L in range(1, maxL + 1):
    up = code[L - 1]; so = np.argsort(up, kind='stable'); us = up[so]; pc = pcode[L]
    k = np.minimum(np.searchsorted(us, pc), us.size - 1); par[L] = np.where((pc >= 0) & (us[k] == pc), so[k], -1)
# 葉: x, bp（名前 n<id> → dense: id_map を並べて二分探索）
leaf = code[maxL]; lx = np.full(leaf.size, -1, np.int64); lbp = np.zeros(leaf.size, np.int64)
isn = (leaf >> 40) == 0; lid = leaf & (SH - 1)
io = np.argsort(id_map, kind='stable'); ids = id_map[io]; k = np.minimum(np.searchsorted(ids, lid), ids.size - 1); hit = isn & (ids[k] == lid)
d_ = io[k[hit]] + 1; lx[hit] = X[d_]; lbp[hit] = bp[d_]
ok = lx >= 0; print(f'葉 {leaf.size:,}, 座標あり {ok.sum():,} ({time.time()-t0:.1f}s)', file=sys.stderr)
B = a.bin; lbin = lx // B
oc_l, ox_l, of_l, ob_l, omn_l, omx_l = [], [], [], [], [], []
cur = np.arange(leaf.size)   # 葉ごとの、今の層での添字
for L in range(maxL - 1, -1, -1):
    cur = np.where(cur >= 0, par[L + 1][np.maximum(cur, 0)], -1)
    m = ok & (cur >= 0)
    node = cur[m]; bins = lbin[m]; w = lbp[m]; xs = lx[m]
    if node.size == 0: continue
    key = node * (lbin.max() + 2) + bins
    uk, inv = np.unique(key, return_inverse=True)
    wsum = np.bincount(inv, weights=w); xw = np.bincount(inv, weights=w * xs)
    unode = uk // (lbin.max() + 2)
    # ノードごとの合計 bp と最大の桶
    nodes_u, ninv = np.unique(node, return_inverse=True); tot = np.bincount(ninv, weights=w)
    order = np.lexsort((-wsum, unode)); first = np.ones(len(order), bool); first[1:] = unode[order][1:] != unode[order][:-1]
    best = order[first]; bnode = unode[best]
    og = np.argsort(ninv, kind='stable'); st_ = np.searchsorted(ninv[og], np.arange(nodes_u.size)); xmin = np.minimum.reduceat(xs[og], st_); xmax = np.maximum.reduceat(xs[og], st_)
    bi = np.searchsorted(nodes_u, bnode); ws = wsum[best]
    oc_l.append(code[L][bnode]); ox_l.append(np.rint(xw[best] / ws).astype(np.int64)); of_l.append(ws / tot[bi]); ob_l.append(tot[bi].astype(np.int64)); omn_l.append(xmin[bi]); omx_l.append(xmax[bi])
    print(f'layer {L}: {len(bnode):,} super nodes ({time.time()-t0:.1f}s)', file=sys.stderr)
# 同じ名前は粗い層でも同じノード（子孫が同じ）→ 細かい層の値を採る（上の順で最初に出たもの）
oc = np.concatenate(oc_l); _, fi = np.unique(oc, return_index=True); fi.sort()
oc, ox, of, ob, omn, omx = oc[fi], np.concatenate(ox_l)[fi], np.concatenate(of_l)[fi], np.concatenate(ob_l)[fi], np.concatenate(omn_l)[fi], np.concatenate(omx_l)[fi]
PCH = {v: k for k, v in PFX.items()}
out = {f"{PCH[int(c >> 40)]}{int(c & (SH - 1))}": (int(x_), float(f_), int(b_), int(mn_), int(mx_)) for c, x_, f_, b_, mn_, mx_ in zip(oc.tolist(), ox.tolist(), of.tolist(), ob.tolist(), omn.tolist(), omx.tolist())}
cur_ = T.cursor(); cur_.execute('DROP TABLE IF EXISTS super'); cur_.execute('CREATE TABLE super(name TEXT PRIMARY KEY, x INTEGER, frac REAL, bp INTEGER, xmin INTEGER, xmax INTEGER)')
cur_.executemany('INSERT INTO super VALUES (?,?,?,?,?,?)', [(nm, *v) for nm, v in out.items()]); cur_.execute("INSERT OR REPLACE INTO meta VALUES ('super_bin', ?)", (str(B),)); T.commit()
fr = np.array([v[1] for v in out.values()]); print(f'super {len(out):,} 件: frac 中央値 {np.median(fr):.2f}, <0.5 が {(fr<0.5).mean()*100:.1f}%  ({time.time()-t0:.1f}s)', file=sys.stderr)
