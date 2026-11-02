#!/usr/bin/env python3
"""錨でない葉ノードに座標を与える（x_fill）。各パスで「直前の錨の x」（先頭は次の錨）を前方に埋め、ノードごとに bp 加重で最大の桶（1,000 錨）の加重平均を採る。
<db>.trav の arrays に x_fill（int32、dense 添字、無ければ -1）を足す。使い方: trav_xfill.py <db.trav> <distill_dir> [--bin 1000]"""
import sys, sqlite3, time, argparse
import numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('trav'); ap.add_argument('distill'); ap.add_argument('--bin', type=int, default=1000)
a = ap.parse_args(); t0 = time.time(); B = a.bin
T = sqlite3.connect(a.trav)
X = np.frombuffer(T.execute("select blob from arrays where name='x_of_dense'").fetchone()[0], np.int32).astype(np.int64)
N1 = len(X)
D = a.distill; tok = np.load(D + '/p_tok.npy', mmap_mode='r'); off = np.load(D + '/p_off.npy'); NP = len(off) - 1 if len(off) > 1 else 0
sid = np.load(D + '/s_id.npy'); sbp = np.load(D + '/s_bp.npy'); bp = np.zeros(N1, np.int64); bp[sid] = sbp
nbin = int(X.max()) // B + 2
keys = []; ws = []; xs = []
# 錨でないトークンを一定量（BATCH）ごとに（ノード, 桶）で集計して足し込む（11-02）。以前は全パス分ためてから集計で、メモリが全トークン数（パス数）に比例した。
# 足すのは bp と bp × 座標（どちらも整数値）なので、まとめ方を変えても和は同じ
BATCH = 20_000_000; nbuf = [0]; ntot = [0]; acc = [np.zeros(0, np.int64), np.zeros(0), np.zeros(0)]
def fold():
    if not keys: return
    k_ = np.concatenate(keys); w_ = np.concatenate(ws).astype(np.float64); x_ = np.concatenate(xs); keys.clear(); ws.clear(); xs.clear(); nbuf[0] = 0
    k_ = np.concatenate((acc[0], k_)); a_w = np.concatenate((acc[1], w_)); a_x = np.concatenate((acc[2], w_ * x_))
    uk_, inv_ = np.unique(k_, return_inverse=True); acc[0] = uk_; acc[1] = np.bincount(inv_, weights=a_w); acc[2] = np.bincount(inv_, weights=a_x)
for pi in range(NP):
    t = np.asarray(tok[off[pi]:off[pi + 1]]).astype(np.int64); x = X[t]; m = x >= 0
    if not m.any(): continue
    idx = np.where(m, np.arange(len(t)), -1); last = np.maximum.accumulate(idx)
    # 先頭（最初の錨より前）は次の錨で埋める
    first = np.flatnonzero(m)[0]; xf = np.where(last >= 0, x[np.maximum(last, 0)], x[first])
    nm = ~m
    if nm.any(): keys.append(t[nm] * nbin + xf[nm] // B); ws.append(bp[t[nm]]); xs.append(xf[nm]); nbuf[0] += int(nm.sum()); ntot[0] += int(nm.sum())
    if nbuf[0] >= BATCH: fold()
    if pi % 2000 == 0: print(f'path {pi}/{NP} ({time.time()-t0:.0f}s)', file=sys.stderr)
fold(); uk, wsum, xw = acc
print(f'錨でないトークン {ntot[0]:,} ({time.time()-t0:.0f}s)', file=sys.stderr)
node = uk // nbin
order = np.lexsort((-wsum, node)); firstm = np.ones(len(order), bool); firstm[1:] = node[order][1:] != node[order][:-1]; best = order[firstm]
xfill = np.full(N1, -1, np.int32); xfill[node[best]] = np.round(xw[best] / np.maximum(1, wsum[best])).astype(np.int32)
filled = (xfill >= 0).sum(); nonanchor = ((X < 0)).sum() - 1
cur = T.cursor(); cur.execute("DELETE FROM arrays WHERE name='x_fill'"); cur.execute("INSERT INTO arrays VALUES ('x_fill', 'int32', ?, ?)", (int(N1), xfill.tobytes())); cur.execute("INSERT OR REPLACE INTO meta VALUES ('xfill_bin', ?)", (str(B),)); T.commit()
print(f'x_fill: 錨でない葉 {nonanchor:,} のうち {filled:,} に座標 ({time.time()-t0:.0f}s)', file=sys.stderr)
