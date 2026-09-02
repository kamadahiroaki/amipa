#!/usr/bin/env python3
"""グループの構成と、そこを通る全区間の実際のステップ列を出す（v2 の不一致の切り分け）。"""
import sqlite3, sys
import numpy as np
D, sc, gid = sys.argv[1], sys.argv[2], int(sys.argv[3])
s_bp = np.load(f"{D}/s_bp.npy").astype(np.int64); s_id = np.load(f"{D}/s_id.npy").astype(np.int64)
p_tok = np.load(f"{D}/p_tok.npy"); p_off = np.load(f"{D}/p_off.npy").astype(np.int64)
p_ori = np.load(f"{D}/p_ori.npy").astype(np.int8)
names = [l.rstrip("\n") for l in open(f"{D}/p_names.txt")]
n = s_id.size
id2row = np.empty(int(s_id.max())+1, np.int64); id2row[s_id] = np.arange(n)
rows = id2row[p_tok]
con = sqlite3.connect("file:" + sc + "?mode=ro", uri=True)
# orig_node からこのグループに属する元ノードを引く
mem = con.execute("SELECT orig_id,off,len,ori FROM orig_node WHERE gid=? ORDER BY off", (gid,)).fetchall()
print(f"=== 畳み込みノード n{gid} の構成ノード {len(mem)} 個 ===")
for o, off, ln, ori in mem[:20]:
    print(f"    元 n{o:<10} off={off:<6} len={ln:<6} ori={ori}")
memset = {o for o, _, _, _ in mem}
memrow = np.array([id2row[o] for o in memset], np.int64)
inset = np.zeros(n, bool); inset[memrow] = True
print(f"\n=== このノード群を通るパスの実際のステップ列 ===")
for k in range(len(names)):
    a, b = p_off[k], p_off[k+1]
    m = inset[rows[a:b]]
    if not m.any(): continue
    idx = np.flatnonzero(m) + a
    # 連続ブロックに分ける
    br = np.flatnonzero(np.r_[True, np.diff(idx) != 1])
    for s0, e0 in zip(br, np.r_[br[1:], idx.size]):
        seg = idx[s0:e0]
        st = " ".join(f"n{s_id[rows[t]]}{'+' if p_ori[t] else '-'}({s_bp[rows[t]]})" for t in seg[:14])
        plus = int(p_ori[seg].sum())
        print(f"  {names[k][:44]:<44} {seg.size:>3} ステップ / '+' {plus}/{seg.size} : {st}")
