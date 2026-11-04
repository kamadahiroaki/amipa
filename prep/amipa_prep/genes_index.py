#!/usr/bin/env python3
"""遺伝子サイドカー <db>.genes に、viewer が初回の要求で計算していた量を前計算して足す（2026-11-04、genes 段の最後）。

使い方: genes_index.py <db>.genes <db>.trav <db>.distill [--minanch 50]

足すもの（以前は backend の trav.ts が全ゲノムで 38〜81 秒かけて、配信の処理を止めて計算していた）:
- gene_x(gid PRIMARY KEY, x0, x1, xd, var)
    x0, x1 … 遺伝子の先頭 1500 トークンと末尾 1500 トークンにある錨（kind 1・2 で座標のあるノード）の座標の最小・最大（無ければ -1）。遺伝子名の検索の結果に使う
    xd     … 先頭 300 トークンで最初に出会う錨の座標（無ければ -1）。遺伝子密度の位置。参照の注釈（proj が NULL の行）だけ、写しは -1
    var    … 遺伝子密度の「株で違う」印（参照の注釈だけ）: 写しの一致率が 0.8 未満の株がある、または xd を（錨 --minanch 以上の通過で）覆う
             ハプロタイプのどれかで、写しの数（自分の株は自分も数える）が 1 でない
- gene_name(gid, pid, name, locus, product) … 参照の注釈（写しでない行）だけの名前の表。検索はこれをなめ、写しは idx_gene_proj で引く
- 索引 idx_gene_proj ON gene(proj)
- meta: gene_x_minanch, gene_x_nperhap（写しが無いときの密度の割り算: 通るハプロタイプ数）
"""
import argparse, os, sqlite3, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trav_arrays import get_array

ap = argparse.ArgumentParser(); ap.add_argument("genes"); ap.add_argument("trav"); ap.add_argument("distill"); ap.add_argument("--minanch", type=int, default=50)
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
tr = sqlite3.connect(f"file:{a.trav}?mode=ro", uri=True)
X = get_array(tr, "x_of_dense").astype(np.int64); K = get_array(tr, "kind")
anchor_x = np.where(((K == 1) | (K == 2)) & (X >= 0), X, -1)   # dense → 錨の座標（錨でなければ -1）
hid_of = dict(tr.execute("SELECT pid, hid FROM paths"))
p_off = np.load(f"{a.distill}/p_off.npy"); p_tok = np.load(f"{a.distill}/p_tok.npy", mmap_mode="r")
g = sqlite3.connect(a.genes); g.execute("PRAGMA journal_mode=OFF"); g.execute("PRAGMA synchronous=OFF")
has_proj = any(c[1] == "proj" for c in g.execute("PRAGMA table_info(gene)"))
rows = np.array(g.execute(f"SELECT g.gid, g.pid, k.s0, k.e0, {'g.proj IS NULL' if has_proj else '1'} FROM gene g JOIN gene_tok k ON k.gid = g.gid ORDER BY g.pid, k.s0").fetchall(), dtype=np.int64)
log(f"遺伝子 {len(rows):,}（参照の注釈 {int(rows[:, 4].sum()):,}）")
gid, pid, s0, e0, canon = rows.T
x0 = np.full(len(rows), -1, np.int64); x1 = np.full(len(rows), -1, np.int64); xd = np.full(len(rows), -1, np.int64)
BIG = np.int64(1) << 62
starts = np.flatnonzero(np.r_[True, pid[1:] != pid[:-1]]); ends = np.r_[starts[1:], len(rows)]
for a_, b_ in zip(starts, ends):
    p = int(pid[a_]); off = int(p_off[p]); n = int(p_off[p + 1] - p_off[p])
    lo = int(s0[a_:b_].min()); hi = min(n, int(e0[a_:b_].max()))
    xp = anchor_x[np.asarray(p_tok[off + lo:off + hi], dtype=np.int64)]   # このパスで遺伝子の掛かる範囲だけ読む
    ok = xp >= 0; xmin = np.where(ok, xp, BIG); xmax = np.where(ok, xp, -1)
    ss = s0[a_:b_] - lo; ee = np.minimum(e0[a_:b_], hi) - lo
    def red(f, arr, sa, sb):
        """[sa, sb) ごとの f.reduce（空の区間は単位元）"""
        out = np.full(sa.size, BIG if f is np.minimum else -1, np.int64); m = sb > sa
        if m.any():
            idx = np.empty(2 * int(m.sum()), np.int64); idx[0::2] = sa[m]; idx[1::2] = sb[m]
            ext = np.r_[arr, BIG if f is np.minimum else -1]   # sb が末尾のときの番兵
            out[m] = f.reduceat(ext, idx)[0::2]
        return out
    h_a, h_b = ss, np.minimum(ee, ss + 1500); t_a, t_b = np.maximum(ss, ee - 1500), ee
    mn = np.minimum(red(np.minimum, xmin, h_a, h_b), red(np.minimum, xmin, t_a, t_b)); mx = np.maximum(red(np.maximum, xmax, h_a, h_b), red(np.maximum, xmax, t_a, t_b))
    x0[a_:b_] = np.where(mn >= BIG, -1, mn); x1[a_:b_] = mx
    # xd: 先頭 300 トークンで最初の錨（参照の注釈だけ）
    for k in np.flatnonzero(canon[a_:b_]):
        sg = xp[ss[k]:min(ee[k], ss[k] + 300)]; f_ = np.flatnonzero(sg >= 0)
        if f_.size: xd[a_ + k] = sg[f_[0]]
log(f"座標: x0 のある遺伝子 {int((x0 >= 0).sum()):,}、xd のある参照の注釈 {int((xd >= 0).sum()):,}")

# var（参照の注釈だけ）
var = np.zeros(len(rows), np.uint8); nperhap = 1
if has_proj:
    pr = np.array(g.execute("SELECT proj, pid, frac FROM gene WHERE proj IS NOT NULL").fetchall(), dtype=np.float64).reshape(-1, 3)
    H = max(hid_of.values()) + 1
    if len(pr):
        ph = np.array([hid_of.get(int(q), -1) for q in pr[:, 1]], np.int64); okh = ph >= 0
        key = pr[okh, 0].astype(np.int64) * H + ph[okh]; uk, uc = np.unique(key, return_counts=True)
        part = set(np.unique(pr[pr[:, 2] < 0.8, 0].astype(np.int64)).tolist())
    else: uk = np.zeros(0, np.int64); uc = np.zeros(0, np.int64); part = set()
    tv = np.array(tr.execute("SELECT hid, x0, x1 FROM trav WHERE nanch >= ? ORDER BY hid, x0", (a.minanch,)).fetchall(), dtype=np.int64).reshape(-1, 3)
    byh = {}
    for h in np.unique(tv[:, 0]):
        m = tv[:, 0] == h; byh[int(h)] = (tv[m, 1], np.maximum.accumulate(tv[m, 2]))
    ci = np.flatnonzero(canon & (xd >= 0))
    cov = {}   # 各ハプロタイプが覆うか（参照の注釈の xd ごと）
    for h, (xs0, mxs) in byh.items():
        j = np.searchsorted(xs0, xd[ci], side="right"); cov[h] = (j > 0) & (mxs[np.maximum(j - 1, 0)] >= xd[ci])
    for n_, k in enumerate(ci):
        gk = int(gid[k]); selfh = hid_of.get(int(pid[k]), -1); v = gk in part
        if not v:
            for h, cv in cov.items():
                if not cv[n_]: continue
                j = np.searchsorted(uk, gk * H + h); c = int(uc[j]) if j < uk.size and uk[j] == gk * H + h else 0
                if c + (1 if h == selfh else 0) != 1: v = True; break
        var[k] = 1 if v else 0
    log(f"株で違う印: {int(var.sum()):,} / {len(ci):,}")
else:
    nperhap = len({hid_of.get(int(p), -1) for p in np.unique(pid)}) or 1

g.executescript("DROP TABLE IF EXISTS gene_x; CREATE TABLE gene_x(gid INTEGER PRIMARY KEY, x0 INTEGER, x1 INTEGER, xd INTEGER, var INTEGER);")
g.executemany("INSERT INTO gene_x VALUES (?,?,?,?,?)", zip(gid.tolist(), x0.tolist(), x1.tolist(), xd.tolist(), var.tolist()))
g.executescript(f"""DROP TABLE IF EXISTS gene_name;
CREATE TABLE gene_name AS SELECT gid, pid, name, locus, product FROM gene {'WHERE proj IS NULL' if has_proj else ''};
CREATE INDEX IF NOT EXISTS idx_gene_proj ON gene(proj);""" if has_proj else """DROP TABLE IF EXISTS gene_name;
CREATE TABLE gene_name AS SELECT gid, pid, name, locus, product FROM gene;""")
g.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [("gene_x_minanch", str(a.minanch)), ("gene_x_nperhap", str(nperhap)), ("gene_x_built", time.strftime("%Y-%m-%d %H:%M"))])
g.commit(); g.close()
log(f"→ {a.genes}（gene_x {len(rows):,} 行、gene_name）")
