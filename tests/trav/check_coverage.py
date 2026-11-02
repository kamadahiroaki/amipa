#!/usr/bin/env python3
"""Traversals の通過の取りこぼしを調べる（2026-11-02）。Traversals の行は .trav の通過片から作るので、片が欠けると行も欠ける
（11-02 の不具合: ハプロタイプが 2 回通る区間は錨が全部外れて片が無かった）。ここでは片を使わず、distill のウォークを直接見て比べる。

  check_coverage.py --distill <db>.distill --trav <db>.trav [--windows 600] [--widths 200,2000,20000] [--seed 1] [--gap 1000] [--min-anch 10]

1. 窓 [x0, x1]（座標）の錨（.trav の x_of_dense が窓に入るノード）を決める
2. 全パスの錨の出現（x, パス, トークン位置）を x の順に並べておき、窓の出現をパスごとにトークン位置の順に並べ、
   隙間が --gap トークンを超える所で切って「訪問」にする（同じパスで窓を 2 回通れば訪問 2 つ）。窓の錨を --min-anch 個以上含む訪問だけ数える
3. 訪問ごとに、同じパスの通過片で、トークン範囲が重なり座標範囲が窓に掛かるものを探して分類する:
   shown＝片があり画面の錨の床（min(50, max(10, 窓の 1 割))）以上 / floor＝片はあるが床の下で隠れる / excluded＝冗長コンティグ（意図して片を作らない）/
   missing＝片が無い（取りこぼし）
窓は座標から一様に無作為（--seed）。結果は分類ごとの訪問数・錨数と、取りこぼしの例。終了コード: missing が 0 なら 0
"""
import argparse, sqlite3, sys, time, collections
import numpy as np
ap = argparse.ArgumentParser(); ap.add_argument("--distill", required=True); ap.add_argument("--trav", required=True)
ap.add_argument("--windows", type=int, default=600); ap.add_argument("--widths", default="200,2000,20000"); ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--gap", type=int, default=1000); ap.add_argument("--min-anch", type=int, default=10); ap.add_argument("--show", type=int, default=15)
a = ap.parse_args(); T0 = time.time()
def log(m): print(f"[{time.time() - T0:6.1f}s] {m}", flush=True)
D = a.distill; p_off = np.load(D + "/p_off.npy"); p_tok = np.load(D + "/p_tok.npy", mmap_mode="r"); names = open(D + "/p_names.txt").read().splitlines(); NP = len(p_off) - 1
c = sqlite3.connect(f"file:{a.trav}?mode=ro", uri=True)
X = np.frombuffer(c.execute("select blob from arrays where name='x_of_dense'").fetchone()[0], np.int32); R = int((X >= 0).sum())
excl = dict(c.execute("select pid, excluded from paths"))
pieces = collections.defaultdict(list)
for pid, i0, i1, x0, x1, na in c.execute("select pid, i0, i1, x0, x1, nanch from trav"): pieces[pid].append((i0, i1, x0, x1, na))
log(f"パス {NP:,}  座標 {R:,}  通過片 {sum(map(len, pieces.values())):,}")
# 全パスの錨の出現を x の順に
xs_l, pid_l, pos_l = [], [], []
for pi in range(NP):
    t = np.asarray(p_tok[p_off[pi]:p_off[pi + 1]]); x = X[t]; k = np.flatnonzero(x >= 0)
    xs_l.append(x[k].astype(np.int32)); pos_l.append(k.astype(np.int64)); pid_l.append(np.full(k.size, pi, np.int32))
XS = np.concatenate(xs_l); PS = np.concatenate(pos_l); PI = np.concatenate(pid_l); del xs_l, pos_l, pid_l
o = np.argsort(XS, kind="stable"); XS, PS, PI = XS[o], PS[o], PI[o]
log(f"錨の出現 {XS.size:,}")
rng = np.random.default_rng(a.seed); widths = [int(w) for w in a.widths.split(",")]
cnt = collections.Counter(); anc = collections.Counter(); bad = []; nwin = 0
for wi in range(a.windows):
    W = widths[wi % len(widths)]; x0 = int(rng.integers(0, max(1, R - W))); x1 = x0 + W - 1; floor = min(50, max(10, int(W * 0.1)))
    lo, hi = np.searchsorted(XS, x0, "left"), np.searchsorted(XS, x1, "right")
    if hi <= lo: continue
    nwin += 1; pi_w = PI[lo:hi]; ps_w = PS[lo:hi]; oo = np.lexsort((ps_w, pi_w)); pi_w = pi_w[oo]; ps_w = ps_w[oo]
    cut = np.flatnonzero((np.diff(pi_w) != 0) | (np.diff(ps_w) > a.gap)) + 1; st = np.concatenate(([0], cut)); en = np.concatenate((cut, [pi_w.size]))
    for s_, e_ in zip(st, en):
        n = int(e_ - s_)
        if n < a.min_anch: continue
        pid = int(pi_w[s_]); v0, v1 = int(ps_w[s_]), int(ps_w[e_ - 1])
        hit = [p for p in pieces.get(pid, ()) if p[0] <= v1 and p[1] >= v0 and p[2] <= x1 and p[3] >= x0]
        cls = ("shown" if any(p[4] >= floor for p in hit) else "floor") if hit else ("excluded" if excl.get(pid) else "missing")
        cnt[cls] += 1; anc[cls] += n
        if cls == "missing": bad.append((n, names[pid], pid, x0, x1, v0, v1))
tot = sum(cnt.values()) or 1; tota = sum(anc.values()) or 1
log(f"窓 {nwin}（幅 {a.widths}）  訪問（窓の錨 {a.min_anch} 個以上） {tot:,}")
for k in ["shown", "floor", "excluded", "missing"]: print(f"  {k:9s} 訪問 {cnt[k]:>8,} ({100 * cnt[k] / tot:5.2f}%)  錨 {anc[k]:>10,} ({100 * anc[k] / tota:5.2f}%)")
bad.sort(reverse=True)
for b in bad[:a.show]: print(f"  missing 錨 {b[0]:>6,}  {b[1]} (pid {b[2]})  窓 x {b[3]:,}–{b[4]:,}  トークン {b[5]:,}–{b[6]:,}")
sys.exit(1 if cnt["missing"] else 0)
