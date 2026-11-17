#!/usr/bin/env python3
"""遺伝子の写しごとの機能喪失の目安を前計算する（2026-11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ⑤。

使い方: genelof_build.py <db>.genes <db>.distill <out>.npz [--part K --nparts N]
  N 分割のときは gid の順に N 等分した K 番目だけを計算し、<out> に書く（genex_build.py --lof で全部を読む）

viewer の /genelof（trav.ts の travGeneLof）と同じ規則: 遺伝子ごとに CDS の合計 bp が最大の転写産物（親）の片をトークンの順に並べ、
株の配列（distill の s_seq。ノードの向きが逆なら逆相補）から組み立て、鎖が − なら逆相補にして翻訳する。
  要約: L（CDS の bp）, aa（最初の終止の前までのアミノ酸数）, stop（終止があるか）, start（開始コドンで始まるか）
  11-17: 転写産物は cds_rules.pick_parent（MANE_Select ＞ Ensembl_canonical ＞ CDS の bp。LoF・NMD・_NF の転写産物を除く）。
        元の遺伝子は親ごとに 1 行ずつ出し（写しが別の親を写した古い .genes でも、写しと同じ親の参照と比べられるように）、選んだ親に chosen。
        セレノシステインの転写産物は TGA を終止としない。transl_table=11 は代替開始（CTG・ATT・ATC・ATA）も開始。
        npiece（組み立てた CDS の片の数）と qc（1: 注釈が pseudo、2: 写しの CDS の端を決められなかった＝gene_qc.unanch、4: 注釈が partial・cds_*_NF。写しは元の注釈のビット）
  状態: 写し（proj あり）は元の遺伝子と比べ、fs（L の差が 3 の倍数でない）/ trunc（aa が元の 9 割未満）/ nostart（元にはある開始が無い）/ ok。
        元の遺伝子（proj なし）は自分の L から: nostart / trunc（aa が L/3−1 の 9 割未満）/ ok。CDS が無い・組み立てられない遺伝子は nocds
以前は画面が遺伝子を出すたびに、窓の遺伝子（最大 5,000）の CDS を distill と本体 DB（leaf_seq）から組み立てて翻訳していた（全ゲノムの初回 7.4 秒）。
出力（npz）: gid, par, L, aa, stop, start, npiece, qc, chosen（CDS の無い遺伝子は含めない）
"""
import argparse, os, sqlite3, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cds_rules import pick_parent, ann_flags, STARTS, STARTS11

ap = argparse.ArgumentParser(); ap.add_argument("genes"); ap.add_argument("distill"); ap.add_argument("out")
ap.add_argument("--part", type=int, default=0); ap.add_argument("--nparts", type=int, default=1)
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)

g = sqlite3.connect(f"file:{a.genes}?mode=ro", uri=True)
# CDS の片（gid, parent, pid, s0, e0, so, eo, start, end）。gid・行番号の順（viewer の問い合わせと同じ並び＝同点の親は先に出た方）
cq = ("SELECT f.gid, coalesce(f.parent, -1), f.pid, t.s0, t.e0, coalesce(t.so, 0), coalesce(t.eo, 0), coalesce(f.start, 0), coalesce(f.end, 0) "
      "FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.type IN ('CDS','cds') ORDER BY f.fid")
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
has_proj = any(c[1] == "proj" for c in g.execute("PRAGMA table_info(gene)"))
proj_of = dict(g.execute("SELECT gid, proj FROM gene WHERE proj IS NOT NULL")) if has_proj else {}
gpseudo = {r[0] for r in g.execute("SELECT gid FROM gene WHERE pseudo = 1")}
# 元の遺伝子（写しでない）の CDS の attrs（親ごとに最初の行）と、セレノシステインの転写産物
attrs = {}
aq = ("SELECT f.gid, coalesce(f.parent, -1), f.attrs FROM feature f JOIN gene g ON g.gid = f.gid WHERE f.type IN ('CDS','cds') AND g.proj IS NULL ORDER BY f.fid" if has_proj
      else "SELECT gid, coalesce(parent, -1), attrs FROM feature WHERE type IN ('CDS','cds') ORDER BY fid")
for gid_, par_, at_ in g.execute(aq): attrs.setdefault((gid_, par_), at_ or "")
sec = {(r[0], r[1]) for r in g.execute("SELECT gid, coalesce(parent, -1) FROM feature WHERE type = 'stop_codon_redefined_as_selenocysteine'")}
unanch = dict(g.execute("SELECT gid, unanch FROM gene_qc")) if g.execute("SELECT 1 FROM sqlite_master WHERE name = 'gene_qc'").fetchone() else {}
def flags(gid, par):   # (qc のビット 1 pseudo・4 partial, Sec か, transl_table 11 か)。写しは元の遺伝子の同じ親で
    src = proj_of.get(gid, gid); sk, se, t11 = ann_flags(attrs.get((src, par), ""), src in gpseudo)
    return sk, se or (src, par) in sec, t11
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

res = []   # (gid, par, L, aa, stop, start, npiece, qc, chosen)
AAS_SEC = AAS.copy(); AAS_SEC[CODE[ord('T')] * 16 + CODE[ord('G')] * 4 + CODE[ord('A')]] = ord('U')
def summarize(gid, pid, rows, par):
    off0 = int(p_off[pid]); t0_ = np.asarray(p_tok[off0 + rows[:, 3]], np.int64); o0_ = np.asarray(p_ori[off0 + rows[:, 3]])
    si0 = inv[t0_]; L0 = np.where(si0 >= 0, s_off[np.maximum(si0, 0) + 1] - s_off[np.maximum(si0, 0)], 1)
    # 片をパスの上の順に。11-17: 開始トークン（列 3）だけだと、隣のエキソンが同じ長いノードに入ったとき同点になり、逆向きのパスで順が入れ替わった
    #   （FCGR2B の逆向きの 48 株すべてが偽の trunc）。同点はそのノードの中で片が始まる位置（ノードの向きを考えた位置）で決める
    eff = np.where(o0_ != 0, rows[:, 5], L0 - 1 - rows[:, 5])
    rows = rows[np.lexsort((eff, rows[:, 3]))]; pieces = []
    for r in rows:
        sq = seg_seq(pid, int(r[3]), int(r[4]), int(r[5]), int(r[6]))
        if sq is not None and len(sq): pieces.append(sq)
    if not pieces: return None
    cds = UP[np.concatenate(pieces)]
    if strand.get(gid) == "-": cds = COMP[cds[::-1]]
    sk, se, t11 = flags(gid, par)
    nc = len(cds) // 3
    if nc:
        cc = CODE[cds[:nc * 3]].reshape(nc, 3); bad = (cc == 4).any(1)
        aa = np.where(bad, ord('X'), (AAS_SEC if se else AAS)[np.minimum(cc[:, 0] * 16 + cc[:, 1] * 4 + cc[:, 2], 63)])
        st = np.flatnonzero(aa == ord('*')); stop = len(st) > 0; naa = int(st[0]) if stop else nc
    else: stop = False; naa = 0
    qc = sk | (2 if unanch.get(gid, 0) > 0 else 0)
    return (gid, par, len(cds), naa, stop, bytes(cds[:3]) in (STARTS11 if t11 else STARTS), len(pieces), qc)
starts = np.flatnonzero(np.r_[True, C[1:, 0] != C[:-1, 0]]); ends = np.r_[starts[1:], len(C)]
for j, (s_, e_) in enumerate(zip(starts, ends)):
    R = C[s_:e_]; gid = int(R[0, 0])
    try:
        seen = []; cbp = {}
        for r in R:
            p_ = int(r[1])
            if p_ not in seen: seen.append(p_)
            cbp[p_] = cbp.get(p_, 0) + int(r[8] - r[7] + 1)
        own = gid not in proj_of
        src = proj_of.get(gid, gid)
        best = pick_parent(seen, cbp, {p_: attrs.get((src, p_), "") for p_ in seen})
        # 元の遺伝子は親ごとに（写しが別の親を写していても比べられるように）。写しは選んだ親だけ
        for par in (seen if (own and has_proj) else [best]):
            m = R[R[:, 1] == par]; sm = summarize(gid, int(m[0, 2]), m, par)
            if sm: res.append(sm + (par == best,))
    except Exception as e:
        print(f"  gid {gid}: {e}", file=sys.stderr)
    if j % 100000 == 0: log(f"  {j:,}/{len(starts):,}")
cols = list(zip(*res)) if res else [[]] * 9
np.savez(a.out, gid=np.array(cols[0], np.int64), par=np.array(cols[1], np.int64), L=np.array(cols[2], np.int64), aa=np.array(cols[3], np.int64),
         stop=np.array(cols[4], bool), start=np.array(cols[5], bool), npiece=np.array(cols[6], np.int64), qc=np.array(cols[7], np.int64), chosen=np.array(cols[8], bool))
log(f"→ {a.out}（{len(res):,} 行）")
