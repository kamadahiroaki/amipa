#!/usr/bin/env python3
"""参照の遺伝子注釈を、ノードの共有で各ハプロタイプのパスに写す（2026-10-27）。

使い方: genes_project.py <in.genes> <distill_dir> <out.genes> [--min-frac 0.3] [--gap 0.5]

- 注釈のあるパス（参照）のトークン位置を各ノードに付け（refpos[dense] = 参照の何番目のトークンか、最初の出現）、
  注釈の無いパスのトークンを参照の位置に引き直す。遺伝子 [s0, e0) は、その位置が範囲に入るトークンの連なりとして各パスに現れる。
- 連なりは、パス上で遺伝子の長さの gap 倍（最小 200 トークン）以内の隙間なら繋ぐ。連なりが 1 本のパスに 2 つ以上あれば 2 コピー。
- 写した遺伝子の一致率 frac ＝ 連なりの中で参照の遺伝子と共有するノードの bp ÷ 参照の遺伝子の bp。min-frac 未満は捨てる。
- 子（CDS・エキソン・UTR）は最長の転写産物だけ写す（行数を抑えるため）。
- 出力は入力の複製に行を足したもの。足した gene には proj 列（写した元の gid）と frac 列を付ける（元の注釈は proj = NULL）。
"""
import sys, os, shutil, sqlite3, argparse, time
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("genes"); ap.add_argument("distill"); ap.add_argument("out")
ap.add_argument("--min-frac", type=float, default=0.3); ap.add_argument("--gap", type=float, default=0.5)
a = ap.parse_args()
T0 = time.time()
def log(m): print(f"[{time.time()-T0:7.1f}s] {m}", flush=True)

p_off = np.load(a.distill + "/p_off.npy"); p_names = open(a.distill + "/p_names.txt").read().splitlines()
p_tok = np.load(a.distill + "/p_tok.npy", mmap_mode="r"); p_ori = np.load(a.distill + "/p_ori.npy", mmap_mode="r")
id_map = np.load(a.distill + "/id_map.npy", mmap_mode="r")
s_id = np.load(a.distill + "/s_id.npy"); s_bp = np.load(a.distill + "/s_bp.npy")
N = len(id_map)
bp_of = np.zeros(N + 1, np.int64)                      # dense（1 始まり）→ bp。s_bp は S 行の順、s_id はその行の dense id
bp_of[s_id.astype(np.int64)] = s_bp
log(f"ノード {N:,} パス {len(p_names):,}")

if os.path.exists(a.out): os.remove(a.out)
shutil.copyfile(a.genes, a.out)
con = sqlite3.connect(a.out); cur = con.cursor()
cols = [r[1] for r in cur.execute("PRAGMA table_info(gene)")]
if "proj" not in cols: cur.execute("ALTER TABLE gene ADD COLUMN proj INTEGER"); cur.execute("ALTER TABLE gene ADD COLUMN frac REAL")
ref_pids = sorted(r[0] for r in cur.execute("SELECT DISTINCT pid FROM gene"))
log(f"注釈のあるパス {ref_pids}")

genes = cur.execute("SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, k.s0, k.e0, k.so, k.eo FROM gene g JOIN gene_tok k ON k.gid = g.gid").fetchall()
# 子: 遺伝子ごとに最長の転写産物（CDS があれば CDS の bp、無ければエキソンの bp が最大の親）
feats = cur.execute("SELECT f.fid, f.gid, f.type, f.parent, f.phase, f.strand, f.start, f.end, t.s0, t.e0, t.so, t.eo FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.type IN ('CDS','exon','five_prime_UTR','three_prime_UTR')").fetchall()
byg = {}
for f in feats: byg.setdefault(f[1], []).append(f)
kids = {}
for gid, fs in byg.items():
    score = {}
    for f in fs:
        k = f[3]; s = score.get(k, [0, 0]); (s.__setitem__(0, s[0] + f[7] - f[6] + 1) if f[2] == 'CDS' else s.__setitem__(1, s[1] + f[7] - f[6] + 1)); score[k] = s
    best = max(score, key=lambda k: (score[k][0], score[k][1]))
    kids[gid] = [f for f in fs if f[3] == best]
log(f"遺伝子 {len(genes):,}、子（最長の転写産物）{sum(len(v) for v in kids.values()):,}")

next_gid = cur.execute("SELECT max(gid) FROM gene").fetchone()[0] + 1
next_fid = cur.execute("SELECT max(fid) FROM feature").fetchone()[0] + 1
out_g, out_gt, out_f, out_ft = [], [], [], []
nproj = 0; ncopy2 = 0
# 各パスが共有する参照パスを先に 1 回の走査で調べ、参照ごとの内側のループをそのパスだけにする（11-02）。以前は参照ごとに全パスのトークンを読み、
# 計算量が 参照パス数 × 全トークン数（全ゲノムは参照 24 本以上・トークン 44 億）。ノードと、それを含む参照パスの組を全部持つ（参照どうしの共有も落とさない）
touch = [[] for _ in ref_pids]   # 参照ごとの、ノードを共有するパス
refset = set(ref_pids)
if 0 < len(ref_pids) <= 64:
    # 11-03: ノード → 含む参照パスのビット（uint64）。各パスは自分のトークンのビットの OR を 1 回取るだけ（全ゲノムで 63 分 → 数分。
    #   以前はパスごとに np.unique と、共有ノードごとの Python の範囲の連結だった）
    rmask = np.zeros(N + 1, np.uint64)
    for k_, rp in enumerate(ref_pids):
        u_ = np.unique(np.asarray(p_tok[int(p_off[rp]):int(p_off[rp + 1])]).astype(np.int64)); rmask[u_] |= np.uint64(1 << k_)
    for pi in range(len(p_names)):
        if pi in refset: continue
        pa, pb = int(p_off[pi]), int(p_off[pi + 1])
        if pb - pa < 50: continue
        bits = int(np.bitwise_or.reduce(rmask[np.asarray(p_tok[pa:pb])]))
        k_ = 0
        while bits:
            if bits & 1: touch[k_].append(pi)
            bits >>= 1; k_ += 1
else:
    pr_n, pr_r = [], []
    for k_, rp in enumerate(ref_pids):
        u_ = np.unique(np.asarray(p_tok[int(p_off[rp]):int(p_off[rp + 1])]).astype(np.int64)); pr_n.append(u_); pr_r.append(np.full(u_.size, k_, np.int64))
    pr_n = np.concatenate(pr_n) if pr_n else np.zeros(0, np.int64); pr_r = np.concatenate(pr_r) if pr_r else np.zeros(0, np.int64)
    o_ = np.lexsort((pr_r, pr_n)); pr_n = pr_n[o_]; pr_r = pr_r[o_]
    for pi in range(len(p_names)):
        if pi in refset: continue
        pa, pb = int(p_off[pi]), int(p_off[pi + 1])
        if pb - pa < 50 or pr_n.size == 0: continue
        u_ = np.unique(np.asarray(p_tok[pa:pb]).astype(np.int64)); lo_ = np.searchsorted(pr_n, u_, "left"); hi_ = np.searchsorted(pr_n, u_, "right"); m_ = hi_ > lo_
        if not m_.any(): continue
        rs = np.unique(np.concatenate([pr_r[a_:b_] for a_, b_ in zip(lo_[m_], hi_[m_])])) if m_.sum() < 64 else np.unique(pr_r[np.concatenate([np.arange(a_, b_) for a_, b_ in zip(lo_[m_], hi_[m_])])])
        for k_ in rs.tolist(): touch[k_].append(pi)
log(f"参照を共有するパス {sum(len(v) for v in touch):,}（参照 {len(ref_pids)} 本）")
for k_ref, rp in enumerate(ref_pids):
    ra, rb = int(p_off[rp]), int(p_off[rp + 1]); rtok = np.asarray(p_tok[ra:rb]).astype(np.int64); rori = np.asarray(p_ori[ra:rb])
    refpos = np.full(N + 1, -1, np.int64); order = np.arange(rtok.size)[::-1]; refpos[rtok[order]] = order   # 最初の出現
    gs = [g for g in genes if g[1] == rp]
    gs_s0 = np.array([g[10] for g in gs]); gs_e0 = np.array([g[11] for g in gs])
    gbp = np.array([int(bp_of[rtok[g[10]:g[11]]].sum()) for g in gs], np.int64)
    for pi in touch[k_ref]:
        pa, pb = int(p_off[pi]), int(p_off[pi + 1])
        if pb - pa < 50: continue
        t = np.asarray(p_tok[pa:pb]).astype(np.int64); r = refpos[t]; m = np.flatnonzero(r >= 0)
        if m.size == 0: continue
        rr = r[m]; srt = np.argsort(rr, kind="stable"); rr_s = rr[srt]; m_s = m[srt]
        lo = np.searchsorted(rr_s, gs_s0, "left"); hi = np.searchsorted(rr_s, gs_e0, "left")
        oo = np.asarray(p_ori[pa:pb])
        for gi in np.flatnonzero(hi > lo):
            g = gs[gi]; idx = np.sort(m_s[lo[gi]:hi[gi]]); glen = g[11] - g[10]; gap = max(200, int(a.gap * glen))
            brk = np.flatnonzero(np.diff(idx) > gap); starts = np.concatenate(([0], brk + 1)); ends = np.concatenate((brk + 1, [idx.size]))
            copies = []
            for s_, e_ in zip(starts, ends):
                ii = idx[s_:e_]; fr = float(bp_of[t[ii]].sum()) / max(1, gbp[gi])
                if fr >= a.min_frac: copies.append((ii, min(fr, 1.0)))
            if len(copies) >= 2: ncopy2 += 1
            for ii, fr in copies:
                s0, e0 = int(ii.min()), int(ii.max()) + 1
                # 向き: 参照と同じ向きに読む位置の増減（参照位置の並びが増えれば同じ向き）
                rseq = r[ii]; same = (np.sign(np.diff(rseq)).sum() >= 0) if ii.size >= 2 else (oo[ii[0]] == rori[r[ii[0]]])
                strand = g[4] if same else ('-' if g[4] == '+' else '+' if g[4] == '-' else g[4])
                ngid = next_gid; next_gid += 1; nproj += 1
                out_g.append((ngid, pi, g[2], g[3], strand, g[5], g[6], g[7], g[8], g[9], None, g[0], round(fr, 3)))
                # 境界のノードが参照と同じなら参照のオフセット（格納向き）、違えばノード全体（ウォークの向きで先頭／末尾 → 格納向きに直す）
                def full0(k): L_ = int(bp_of[t[k]]); return 0 if oo[k] else max(0, L_ - 1)
                def full1(k): L_ = int(bp_of[t[k]]); return max(0, L_ - 1) if oo[k] else 0
                # 逆向きの写し（コンティグが参照と逆）は、ウォークの先頭が参照の末尾に当たるので、参照の末尾のノード・オフセットと比べる（オフセットは格納向きなのでそのまま使える）
                def bnd(k, rk_same, off_same, rk_rev, off_rev, full):
                    if same and t[k] == rk_same: return off_same
                    if (not same) and t[k] == rk_rev: return off_rev
                    return full(k)
                so = bnd(s0, rtok[g[10]], g[12], rtok[g[11] - 1], g[13], full0); eo = bnd(e0 - 1, rtok[g[11] - 1], g[13], rtok[g[10]], g[12], full1)
                out_gt.append((ngid, s0, e0, so, eo))
                # 子: 参照の範囲 [cs0, ce0) に引き直されるトークン（この写しの中）の最小〜最大
                for f in kids.get(g[0], []):
                    sel = ii[(rseq >= f[8]) & (rseq < f[9])]
                    if sel.size == 0: continue
                    nfid = next_fid; next_fid += 1
                    out_f.append((nfid, pi, f[2], f[3], f[4], strand, f[6], f[7], ngid))
                    k0_, k1_ = int(sel.min()), int(sel.max())
                    out_ft.append((nfid, k0_, k1_ + 1, bnd(k0_, rtok[f[8]], f[10], rtok[f[9] - 1], f[11], full0), bnd(k1_, rtok[f[9] - 1], f[11], rtok[f[8]], f[10], full1)))
    log(f"参照 {p_names[rp]}: 写し {nproj:,}（累計）")

cur.executemany("INSERT INTO gene(gid, pid, start, end, strand, type, name, locus, product, pseudo, fid, proj, frac) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", out_g)
cur.executemany("INSERT INTO gene_tok VALUES (?,?,?,?,?)", out_gt)
cur.executemany("INSERT INTO feature(fid, pid, type, parent, phase, strand, start, end, gid) VALUES (?,?,?,?,?,?,?,?,?)", out_f)
cur.executemany("INSERT INTO feature_tok VALUES (?,?,?,?,?)", out_ft)
cur.execute("INSERT OR REPLACE INTO meta VALUES ('projected', ?)", (f"{nproj} genes from pids {ref_pids}, min_frac {a.min_frac}, {time.strftime('%Y-%m-%d %H:%M')}",))
con.commit(); con.execute("VACUUM"); con.close()
log(f"写した遺伝子 {nproj:,}（2 コピー以上の遺伝子×パス {ncopy2:,}）子 {len(out_f):,} → {a.out} ({os.path.getsize(a.out)/1e6:.0f} MB)")
