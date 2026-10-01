#!/usr/bin/env python3
"""合意列の範囲 [c0, c1] → 各パスのトークン範囲 [path, s0, e0)。Blocks パネルの「塩基へ」（bubble MSA）に渡す。
  python3 colrange_tokens.py --distill <dir> --synteny <db>.synteny --c0 N --c1 N
木のサイドカーの arrays.dcol（distill の dense id → 合意列）と distill の p_tok（memmap）だけを使う。Ctx は要らない。
走査は、範囲を含む原子区間のインスタンス（paths × inst の s0..e0）だけに限る（WG でも原子 1 個分のトークン）。
原子が特定できなければ全パスを走査する（小さいアトラス向けの保険）。"""
import argparse, json, sqlite3, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--distill", required=True); ap.add_argument("--synteny", required=True)
ap.add_argument("--c0", type=int, required=True); ap.add_argument("--c1", type=int, required=True)
a = ap.parse_args()
con = sqlite3.connect(a.synteny)
row = con.execute("SELECT dtype, n, blob FROM arrays WHERE name='dcol'").fetchone()
if row is None: print(json.dumps(dict(error="サイドカーに dcol がありません（tree.py を更新して作り直す）"))); sys.exit(0)
dcol = np.frombuffer(row[2], dtype=np.dtype(row[0])).reshape(row[1])
p_off = np.load(a.distill + "/p_off.npy"); p_tok = np.load(a.distill + "/p_tok.npy", mmap_mode="r")
p_names = open(a.distill + "/p_names.txt").read().splitlines(); pidx = {n: i for i, n in enumerate(p_names)}
c0, c1 = a.c0, a.c1
# 範囲を含む原子区間（最後の錨の列 ≤ c0 の原子と、最初の錨 ≥ c1 の原子が同じなら確定）
r0 = con.execute("SELECT atom FROM anchors WHERE col <= ? ORDER BY col DESC LIMIT 1", (c0,)).fetchone()
r1 = con.execute("SELECT atom FROM anchors WHERE col >= ? ORDER BY col ASC LIMIT 1", (c1,)).fetchone()
atoms = sorted({r[0] for r in (r0, r1) if r})
paths = {pid: path for pid, path in con.execute("SELECT pid, path FROM paths")}
if atoms:
    q = "SELECT pid, s0, e0 FROM inst WHERE atom IN (%s) ORDER BY pid, pos" % ",".join("?" * len(atoms))
    scan = [(paths[pid], s0, e0) for pid, s0, e0 in con.execute(q, atoms)]
else:
    scan = [(path, 0, None) for path in paths.values()]
out = []; seen = {}
for path, s0, e0 in scan:
    i = pidx.get(path)
    if i is None: continue
    off = int(p_off[i]); n = int(p_off[i + 1] - p_off[i]) if i + 1 < len(p_off) else int(len(p_tok) - off)
    e0_ = n if e0 is None else min(e0, n)
    cols = dcol[np.asarray(p_tok[off + s0:off + e0_], dtype=np.int64)]
    m = np.flatnonzero((cols >= c0) & (cols <= c1))
    if m.size == 0: continue
    # 範囲の列を持つトークンが飛び飛び（多重コピーのノードや局所の再編成）なら、最も密な連なりだけを採る（100 トークン超の飛びで切る）
    cuts = np.flatnonzero(np.diff(m) > 100); seg_s = np.concatenate(([0], cuts + 1)); seg_e = np.concatenate((cuts + 1, [m.size]))
    k_ = int(np.argmax(seg_e - seg_s)); m = m[seg_s[k_]:seg_e[k_]]
    lo, hi = s0 + int(m[0]), s0 + int(m[-1]) + 1
    if path in seen:            # 同じパスに複数インスタンス（分割片）→ 範囲の列を最も多く持つ片を採る（和にすると片の間の数 kb を巻き込む）
        k = seen[path]
        if m.size > out[k][3]: out[k] = [path, lo, hi, int(m.size)]
    else: seen[path] = len(out); out.append([path, lo, hi, int(m.size)])
out = [r[:3] for r in out]
print(json.dumps(dict(ranges=out, ncols=c1 - c0 + 1, atoms=atoms, scanned=len(scan))))
