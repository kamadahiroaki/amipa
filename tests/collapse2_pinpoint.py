#!/usr/bin/env python3
"""v2 の復元が合わないパスについて、最初の差分を含む区間の中身を出す。"""
import sqlite3, sys
import numpy as np
RC = bytes.maketrans(b"ACGTNacgtn", b"TGCANtgcan")
orig_gfa, coll_gfa, sc, target = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def load(f, want=None):
    S, P = {}, []
    for line in open(f):
        if line[0] == "S":
            c = line.split("\t", 3); S[c[1]] = c[2].rstrip("\n").encode()
        elif line[0] == "P" and want is not False:
            c = line.rstrip("\n").split("\t")
            P.append((c[1], [(t[:-1], t[-1]) for t in c[2].split(",")]))
    return S, P

So, Po = load(orig_gfa); Sc, _ = load(coll_gfa, want=False)
con = sqlite3.connect("file:" + sc + "?mode=ro", uri=True)
msa = {}
for g, nrun, ncol, co, cw, sw, ce in con.execute(
        "SELECT gid,nrun,ncol,cols,colw,slotw,cells FROM node_msa"):
    sw = np.frombuffer(sw, np.int32).astype(np.int64)
    soff = np.zeros(ncol + 1, np.int64); np.cumsum(sw, out=soff[1:])
    msa[g] = (np.frombuffer(co, np.int32), np.frombuffer(cw, np.int32), sw, soff,
              np.frombuffer(ce, np.uint8), int(soff[-1]), nrun)
r = con.execute("SELECT n,gids,oris,rows FROM path_runs WHERE name=?", (target,)).fetchone()
nrun, gids, oris, rws = r[0], np.frombuffer(r[1], np.int32), np.frombuffer(r[2], np.uint8), np.frombuffer(r[3], np.int32)
orig = b"".join(So[t].translate(RC)[::-1] if o == "-" else So[t] for t, o in dict(Po)[target])
out = []; spans = []; pos = 0
for g, o, rw in zip(gids.tolist(), oris.tolist(), rws.tolist()):
    s = Sc[str(g)]; m = msa.get(g)
    if m is None:
        t = s
    else:
        cols, colw, sw, soff, cells, stride, _ = m
        base = rw * stride; buf = []; p = 0
        for j in range(cols.size):
            buf.append(s[p:cols[j]])
            buf.append(cells[base+soff[j]:base+soff[j]+sw[j]].tobytes().replace(b"-", b""))
            p = int(cols[j]) + int(colw[j])
        buf.append(s[p:]); t = b"".join(buf)
    t = t.translate(RC)[::-1] if o == 0 else t
    out.append(t); spans.append((pos, pos+len(t), g, o, rw)); pos += len(t)
rec = b"".join(out)
d = next((i for i, (a, b) in enumerate(zip(orig, rec)) if a != b), -1)
print(f"=== {target}: 元 {len(orig):,} / 復元 {len(rec):,} / 先頭差分 {d:,} ===")
print(f"  元  ...{orig[max(0,d-25):d+25].decode()}...")
print(f"  復元...{rec[max(0,d-25):d+25].decode()}...")
for s0, e0, g, o, rw in spans:
    if s0 <= d < e0:
        m = msa.get(g)
        print(f"\n  区間: グループ n{g} 向き{'+' if o else '-'} 行{rw} / span {s0:,}-{e0:,} / 内部 {d-s0:,}")
        print(f"    GFA ノード長 {len(Sc[str(g)]):,}")
        if m is None: print("    node_msa 無し（スロットなし）"); break
        cols, colw, sw, soff, cells, stride, nr = m
        print(f"    スロット {cols.size} / 区間数 {nr} / 行の幅 {stride}")
        for j in range(min(cols.size, 12)):
            cell = cells[rw*stride+soff[j]:rw*stride+soff[j]+sw[j]].tobytes()
            print(f"      slot{j}: cols={cols[j]} colw={colw[j]} slotw={sw[j]} "
                  f"cell={cell.decode()!r} -> {cell.replace(b'-',b'').decode()!r}")
        if cols.size > 12: print(f"      …残り {cols.size-12} スロット")
        break
