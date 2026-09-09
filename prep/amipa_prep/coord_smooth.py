#!/usr/bin/env python3
"""座位座標（--layout-node-coord）を、レイアウトするグラフの隣接と整合させる最小二乗平滑化。

コピーの表示座標は「自分を通る通過の座位区間の中心」なので、隣接ノードで通過の集合が違うと外挿誤差ぶんの段差（数百 bp〜数十 kb）が入る。
段差はレイアウトで「目標長 1 の辺が段差ぶん伸びる」「私有アレルが両隣から離れて浮く」「局所クラスタが環の内側に弦として張られる」として現れ、
SGD の局所項は 100 ノード規模の一斉ずれを直せない（拡散的。epoch を増やしても消えない）。
そこで各ノード i を推定 c⁰_i に重み w_i = (u0/u_i)²（精密なノードは 1、雑音の大きいノードは小）で留め、接合部でない辺 (a,b) に
c_a − c_b = clip(c⁰_a − c⁰_b, ±(L_a+L_b)/2) を重み λ で課す線形最小二乗を CG で解く。λ=1 が既定: 精密ノードはほぼ動かず、雑音ノードだけが隣に寄る。
λ を大きくすると欠失域（A→v→B で A–B 間に参照の鎖がある）の座標が圧縮されて鎖と矛盾し、波打つ。

usage: coord_smooth.py --distill DIR --coord in.tsv --out out.tsv [--L circ_len] [--lam 1.0] [--u0 5000] [--gap-min 20000] [--maxiter 4000]"""
import sys, time, argparse
from pathlib import Path
import numpy as np, scipy.sparse as sp, scipy.sparse.linalg as spla

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--distill", required=True); ap.add_argument("--coord", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--L", type=float, default=0.0); ap.add_argument("--lam", type=float, default=1.0); ap.add_argument("--u0", type=float, default=5000)
    ap.add_argument("--gap-min", type=float, default=20000); ap.add_argument("--maxiter", type=int, default=4000); ap.add_argument("--tol", type=float, default=1e-7)
    a = ap.parse_args(); t0 = time.time(); log = lambda m: print(f"[coord_smooth {time.time()-t0:6.1f}s] {m}", flush=True)
    d = Path(a.distill); s_id = np.load(d / "s_id.npy").astype(np.int64); s_bp = np.load(d / "s_bp.npy").astype(np.int64)
    la = np.load(d / "l_a.npy").astype(np.int64); lb = np.load(d / "l_b.npy").astype(np.int64)
    M = int(s_id.max()); Larr = np.zeros(M + 1, np.float64); Larr[s_id] = s_bp
    ct = np.loadtxt(a.coord, skiprows=1, ndmin=2); cid = ct[:, 0].astype(np.int64); ok = cid <= M
    c0 = np.full(M + 1, np.nan); u = np.full(M + 1, np.nan); c0[cid[ok]] = ct[ok, 1]; u[cid[ok]] = ct[ok, 2] if ct.shape[1] > 2 else a.u0
    has = ~np.isnan(c0); nodes = np.flatnonzero(has); n = nodes.size; idx = np.full(M + 1, -1, np.int64); idx[nodes] = np.arange(n)
    keep = (la <= M) & (lb <= M); ea, eb = la[keep], lb[keep]; keep = has[ea] & has[eb] & (ea != eb); ea, eb = ea[keep], eb[keep]
    raw = c0[ea] - c0[eb]; d0 = raw.copy()
    if a.L > 0: d0 = np.where(d0 > a.L / 2, d0 - a.L, np.where(d0 < -a.L / 2, d0 + a.L, d0))
    h = 0.5 * (Larr[ea] + Larr[eb]); gap = np.maximum(0, np.abs(d0) - h); tol = np.maximum(a.gap_min, 2 * np.maximum(u[ea], u[eb])); junc = gap > tol
    ea, eb, d0, h, raw = ea[~junc], eb[~junc], d0[~junc], h[~junc], raw[~junc]; m = ea.size
    delta = np.clip(d0, -h, h) + (raw - d0)                 # 原点を跨ぐ辺は、解の変数が生の座標系なので目標にも ±L を戻す
    log(f"ノード {n:,}（座標あり）辺 {m:,}（接合部 {int(junc.sum()):,} を除外）| 隣接残差 |Δc⁰|−h: >100 bp {int((np.abs(d0)-h > 100).sum()):,} >1 kb {int((np.abs(d0)-h > 1000).sum()):,}")
    if n == 0 or m == 0:
        import shutil; shutil.copyfile(a.coord, a.out); log("辺が無いので座標をそのまま出力"); return
    w = np.minimum(1.0, (a.u0 / np.maximum(u[nodes], a.u0)) ** 2); ia, ib = idx[ea], idx[eb]
    B = sp.csr_matrix((np.r_[np.ones(m), -np.ones(m)], (np.r_[np.arange(m), np.arange(m)], np.r_[ia, ib])), shape=(m, n))
    A = sp.diags(w) + a.lam * (B.T @ B); rhs = w * c0[nodes] + a.lam * (B.T @ delta); Minv = sp.diags(1.0 / A.diagonal())
    it = [0]
    def cb(xk): it[0] += 1
    kw = dict(x0=c0[nodes].copy(), M=Minv, maxiter=a.maxiter, callback=cb)
    try: x, info = spla.cg(A, rhs, rtol=a.tol, **kw)
    except TypeError: x, info = spla.cg(A, rhs, tol=a.tol, **kw)
    r1 = np.abs(x[ia] - x[ib]) - h; mv = np.abs(x - c0[nodes])
    log(f"CG {it[0]} 反復 info={info} | 隣接残差（後）>100 bp {int((r1 > 100).sum()):,} >1 kb {int((r1 > 1000).sum()):,} | 移動 中央 {np.median(mv):,.0f} p99 {np.percentile(mv, 99):,.0f}")
    if a.L > 0: x = np.mod(x, a.L)
    with open(a.out, "w") as f:
        f.write("id\tcoord\tu\n"); f.writelines(f"{int(v)}\t{c:.0f}\t{uu:.0f}\n" for v, c, uu in zip(nodes.tolist(), x.tolist(), u[nodes].tolist()))
    log(f"-> {a.out}")

if __name__ == "__main__": main()
