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
dense_of_id = {int(v): i + 1 for i, v in enumerate(id_map)}
print(f'trav/distill 読み込み {time.time()-t0:.1f}s', file=sys.stderr)
D = sqlite3.connect(a.db)
maxL = D.execute('select max(layer_index) from nodes').fetchone()[0]
# 層ごとの名前と親（名前 → 層内の添字）
names = {}; parents = {}
for L in range(maxL + 1):
    rows = D.execute('select node_name, parent_name from nodes where layer_index=?', (L,)).fetchall()
    names[L] = [r[0] for r in rows]; parents[L] = [r[1] for r in rows]
    print(f'layer {L}: {len(rows):,} nodes', file=sys.stderr)
idx = {L: {nm: i for i, nm in enumerate(names[L])} for L in range(maxL + 1)}
# 親の添字（層 L のノード → 層 L-1 の添字、無ければ -1）
par = {}
for L in range(1, maxL + 1):
    up = idx[L - 1]; par[L] = np.array([up.get(p, -1) if p else -1 for p in parents[L]], np.int64)
# 葉: x, bp
leaf = names[maxL]; lx = np.full(len(leaf), -1, np.int64); lbp = np.zeros(len(leaf), np.int64)
for i, nm in enumerate(leaf):
    if nm.startswith('n'):
        d = dense_of_id.get(int(nm[1:]))
        if d is not None: lx[i] = X[d]; lbp[i] = bp[d]
ok = lx >= 0; print(f'葉 {len(leaf):,}, 座標あり {ok.sum():,} ({time.time()-t0:.1f}s)', file=sys.stderr)
B = a.bin; lbin = lx // B
out = {}
cur = np.arange(len(leaf))   # 葉ごとの、今の層での添字
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
    tot = np.bincount(np.unique(node, return_inverse=True)[1], weights=w); nodes_u = np.unique(node)
    order = np.lexsort((-wsum, unode)); first = np.ones(len(order), bool); first[1:] = unode[order][1:] != unode[order][:-1]
    best = order[first]; bnode = unode[best]
    tot_of = dict(zip(nodes_u.tolist(), tot.tolist()))
    xmin = {}; xmax = {}
    for n_, x_ in zip(node.tolist(), xs.tolist()):
        if n_ not in xmin or x_ < xmin[n_]: xmin[n_] = x_
        if n_ not in xmax or x_ > xmax[n_]: xmax[n_] = x_
    for k, n_ in enumerate(bnode.tolist()):
        nm = names[L][n_]
        if nm in out: continue   # 同じ名前は粗い層でも同じノード（子孫が同じ）
        ws = wsum[best[k]]; out[nm] = (int(round(xw[best[k]] / ws)), float(ws / tot_of[n_]), int(tot_of[n_]), int(xmin[n_]), int(xmax[n_]))
    print(f'layer {L}: {len(bnode):,} super nodes ({time.time()-t0:.1f}s)', file=sys.stderr)
cur_ = T.cursor(); cur_.execute('DROP TABLE IF EXISTS super'); cur_.execute('CREATE TABLE super(name TEXT PRIMARY KEY, x INTEGER, frac REAL, bp INTEGER, xmin INTEGER, xmax INTEGER)')
cur_.executemany('INSERT INTO super VALUES (?,?,?,?,?,?)', [(nm, *v) for nm, v in out.items()]); cur_.execute("INSERT OR REPLACE INTO meta VALUES ('super_bin', ?)", (str(B),)); T.commit()
fr = np.array([v[1] for v in out.values()]); print(f'super {len(out):,} 件: frac 中央値 {np.median(fr):.2f}, <0.5 が {(fr<0.5).mean()*100:.1f}%  ({time.time()-t0:.1f}s)', file=sys.stderr)
