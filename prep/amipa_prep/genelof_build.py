#!/usr/bin/env python3
"""遺伝子の写しごとの機能喪失の目安を前計算する（2026-11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ⑤。

使い方: genelof_build.py <db>.genes <db>.distill <out>.npz [--part K --nparts N]
  N 分割のときは gid の順に N 等分した K 番目だけを計算し、<out> に書く（genex_build.py --lof で全部を読む）

viewer の /genelof（trav.ts の travGeneLof）と同じ規則: 遺伝子ごとに CDS の合計 bp が最大の転写産物（親）の片をトークンの順に並べ、
株の配列（distill の s_seq。ノードの向きが逆なら逆相補）から組み立て、鎖が − なら逆相補にして翻訳する。
  要約: L（CDS の bp）, aa（最初の終止の前までのアミノ酸数）, stop（終止があるか）, start（ATG/GTG/TTG で始まるか）
  状態: 写し（proj あり）は元の遺伝子と比べ、fs（L の差が 3 の倍数でない）/ trunc（aa が元の 9 割未満）/ nostart（元にはある開始が無い）/ ok。
        元の遺伝子（proj なし）は自分の L から: nostart / trunc（aa が L/3−1 の 9 割未満）/ ok。CDS が無い・組み立てられない遺伝子は nocds
以前は画面が遺伝子を出すたびに、窓の遺伝子（最大 5,000）の CDS を distill と本体 DB（leaf_seq）から組み立てて翻訳していた（全ゲノムの初回 7.4 秒）。
出力（npz）: gid, L, aa, stop, start（CDS の無い遺伝子は含めない）
"""
import argparse, os, sqlite3, sys, time
import numpy as np

ap = argparse.ArgumentParser(); ap.add_argument("genes"); ap.add_argument("distill"); ap.add_argument("out")
ap.add_argument("--part", type=int, default=0); ap.add_argument("--nparts", type=int, default=1)
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)

g = sqlite3.connect(f"file:{a.genes}?mode=ro", uri=True)
# CDS の片（gid, parent, pid, s0, e0, so, eo, start, end）。gid・行番号の順（viewer の問い合わせと同じ並び＝同点の親は先に出た方）
cq = ("SELECT f.gid, coalesce(f.parent, -1), f.pid, t.s0, t.e0, coalesce(t.so, 0), coalesce(t.eo, 0), coalesce(f.start, 0), coalesce(f.end, 0) "
      "FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.type IN ('CDS','cds')")
parts = []; cur = g.execute(cq)
while True:
    rs = cur.fetchmany(200000)
    if not rs: break
    parts.append(np.array(rs, np.int64))
C = np.concatenate(parts); del parts
C = C[np.argsort(C[:, 0], kind="stable")]
gids_all = np.unique(C[:, 0])
lo_g, hi_g = 0, len(gids_all)
if a.nparts > 1:
    lo_g = len(gids_all) * a.part // a.nparts; hi_g = len(gids_all) * (a.part + 1) // a.nparts
mine = gids_all[lo_g:hi_g]
sel = (C[:, 0] >= mine[0]) & (C[:, 0] <= mine[-1]) if len(mine) else np.zeros(len(C), bool)
C = C[sel]
strand = dict(g.execute("SELECT gid, strand FROM gene"))
log(f"CDS の片 {len(C):,}、遺伝子 {len(mine):,}（全 {len(gids_all):,} の {a.part + 1}/{a.nparts}）")

p_off = np.load(f"{a.distill}/p_off.npy"); p_tok = np.load(f"{a.distill}/p_tok.npy", mmap_mode="r"); p_ori = np.load(f"{a.distill}/p_ori.npy", mmap_mode="r")
s_id = np.load(f"{a.distill}/s_id.npy").astype(np.int64); s_off = np.load(f"{a.distill}/s_seq_off.npy").astype(np.int64)
s_seq = np.memmap(f"{a.distill}/s_seq.bin", np.uint8, "r")
inv = np.full(int(s_id.max()) + 2, -1, np.int64); inv[s_id] = np.arange(len(s_id))
UP = np.arange(256, dtype=np.uint8); UP[ord('a'):ord('z') + 1] -= 32
COMP = np.arange(256, dtype=np.uint8)
for x, y in zip(b"ACGTNacgtn", b"TGCANtgcan"): COMP[x] = y
CODE = np.full(256, 4, np.int64)
for i, c in enumerate(b"TCAG"): CODE[c] = i
AAS = np.frombuffer(b"FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG", np.uint8)
log("配列を開いた")

def seg_seq(pid, s0, e0, so, eo):
    off = int(p_off[pid]); tk = np.asarray(p_tok[off + s0: off + e0], np.int64); oo = np.asarray(p_ori[off + s0: off + e0])
    n = len(tk)
    if n == 0: return None
    si = inv[tk]; a_ = np.where(si >= 0, s_off[np.maximum(si, 0)], 0); b_ = np.where(si >= 0, s_off[np.maximum(si, 0) + 1], 0)
    L = b_ - a_; miss = si < 0; L = np.where(miss, 1, L)   # 配列の無いノードは N 1 文字（viewer と同じ）
    if not oo[0]: so = int(L[0]) - 1 - so
    if not oo[-1]: eo = int(L[-1]) - 1 - eo
    tot = int(L.sum()); tid = np.repeat(np.arange(n), L); k = np.arange(tot) - np.repeat(np.cumsum(L) - L, L)
    fwd = oo[tid] != 0
    idx = np.where(fwd, a_[tid] + k, b_[tid] - 1 - k)
    out = np.where(miss[tid], ord('N'), s_seq[np.clip(idx, 0, len(s_seq) - 1)]).astype(np.uint8)
    out = np.where(fwd, out, COMP[out]).astype(np.uint8)
    last0 = tot - int(L[-1])
    if n > 1: return out[max(0, so): last0 + max(0, eo) + 1]
    return out[max(0, so): max(0, eo) + 1]

res_g = []; res_L = []; res_aa = []; res_stop = []; res_start = []
starts = np.flatnonzero(np.r_[True, C[1:, 0] != C[:-1, 0]]); ends = np.r_[starts[1:], len(C)]
for j, (s_, e_) in enumerate(zip(starts, ends)):
    R = C[s_:e_]; gid = int(R[0, 0])
    try:
        # 親ごとの CDS の合計 bp。最大の親（同点は先に出た方）
        best = None; bestL = -1; seen = []
        for par in R[:, 1]:
            if par not in seen: seen.append(par)
        for par in seen:
            m = R[R[:, 1] == par]; Lp = int((m[:, 8] - m[:, 7] + 1).sum())
            if Lp > bestL: bestL, best = Lp, m
        best = best[np.argsort(best[:, 3], kind="stable")]
        pid = int(best[0, 2]); pieces = []
        for r in best:
            sq = seg_seq(pid, int(r[3]), int(r[4]), int(r[5]), int(r[6]))
            if sq is not None and len(sq): pieces.append(sq)
        if not pieces: continue
        cds = UP[np.concatenate(pieces)]
        if strand.get(gid) == "-": cds = COMP[cds[::-1]]
        nc = len(cds) // 3
        if nc:
            cc = CODE[cds[:nc * 3]].reshape(nc, 3); bad = (cc == 4).any(1)
            aa = np.where(bad, ord('X'), AAS[np.minimum(cc[:, 0] * 16 + cc[:, 1] * 4 + cc[:, 2], 63)])
            st = np.flatnonzero(aa == ord('*')); stop = len(st) > 0; naa = int(st[0]) if stop else nc
        else: stop = False; naa = 0
        res_g.append(gid); res_L.append(len(cds)); res_aa.append(naa); res_stop.append(stop); res_start.append(bytes(cds[:3]) in (b"ATG", b"GTG", b"TTG"))
    except Exception as e:
        print(f"  gid {gid}: {e}", file=sys.stderr)
    if j % 100000 == 0: log(f"  {j:,}/{len(starts):,}")
np.savez(a.out, gid=np.array(res_g, np.int64), L=np.array(res_L, np.int64), aa=np.array(res_aa, np.int64), stop=np.array(res_stop, bool), start=np.array(res_start, bool))
log(f"→ {a.out}（{len(res_g):,} 遺伝子）")
