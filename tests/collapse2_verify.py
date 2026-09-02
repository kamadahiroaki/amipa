#!/usr/bin/env python3
"""v2（ノード長が通過ごとに変わる版）の可逆性検証。

畳み込み GFA とサイドカーだけから各ハプロタイプを復元し、元の GFA と突き合わせる。
復元は「GFA ノードを走り、スロットをその区間のアレルで置き換える」。
アレルの長さはスロット幅と違ってよい（indel）。
"""
import sqlite3
import sys

import numpy as np

RC = bytes.maketrans(b"ACGTNacgtn", b"TGCANtgcan")


def load_gfa(f, want_paths=True):
    S, P = {}, []
    for line in open(f):
        if line[0] == "S":
            c = line.split("\t", 3)
            S[c[1]] = c[2].rstrip("\n").encode()
        elif want_paths and line[0] == "P":
            c = line.rstrip("\n").split("\t")
            P.append((c[1], [(t[:-1], t[-1]) for t in c[2].split(",")]))
        elif want_paths and line[0] == "W":
            c = line.rstrip("\n").split("\t")
            w, st, i = c[6], [], 0
            while i < len(w):
                o = "+" if w[i] == ">" else "-"
                j = i + 1
                while j < len(w) and w[j] not in "><":
                    j += 1
                st.append((w[i + 1:j], o))
                i = j
            P.append((f"{c[1]}#{c[2]}#{c[3]}", st))
    return S, P


def main():
    orig_gfa, coll_gfa = sys.argv[1], sys.argv[2]
    sc = sys.argv[3] if len(sys.argv) > 3 else coll_gfa + ".collapse"
    print("元 GFA を読む…", flush=True)
    So, Po = load_gfa(orig_gfa)
    print("畳み込み GFA を読む…", flush=True)
    Sc, _ = load_gfa(coll_gfa, want_paths=False)
    con = sqlite3.connect("file:" + sc + "?mode=ro", uri=True)
    meta = {k: v for k, v in con.execute("SELECT k,v FROM meta")}
    print("  " + " / ".join(f"{k}={v}" for k, v in sorted(meta.items())), flush=True)
    msa = {}
    for g, nrun, ncol, co, cw, sw, ce in con.execute(
            "SELECT gid,nrun,ncol,cols,colw,slotw,cells FROM node_msa"):
        sw = np.frombuffer(sw, np.int32).astype(np.int64)
        soff = np.zeros(ncol + 1, np.int64)
        np.cumsum(sw, out=soff[1:])
        msa[g] = (np.frombuffer(co, np.int32), np.frombuffer(cw, np.int32),
                  sw, soff, np.frombuffer(ce, np.uint8), int(soff[-1]))
    Om = dict(Po)
    ok = 0
    rowsq = con.execute("SELECT path,name,n,gids,oris,rows FROM path_runs ORDER BY path").fetchall()
    for _, nm, nrun, gids, oris, rws in rowsq:
        gids = np.frombuffer(gids, np.int32)
        oris = np.frombuffer(oris, np.uint8)
        rws = np.frombuffer(rws, np.int32)
        out = []
        for g, o, r in zip(gids.tolist(), oris.tolist(), rws.tolist()):
            s = Sc[str(g)]
            m = msa.get(g)
            if m is None:
                out.append(s.translate(RC)[::-1] if o == 0 else s)
                continue
            cols, colw, sw, soff, cells, stride = m
            base = r * stride
            buf = []
            pos = 0
            for j in range(cols.size):
                buf.append(s[pos:cols[j]])
                cell = cells[base + soff[j]:base + soff[j] + sw[j]].tobytes()
                buf.append(cell.replace(b"-", b""))
                pos = int(cols[j]) + int(colw[j])
            buf.append(s[pos:])
            t = b"".join(buf)
            out.append(t.translate(RC)[::-1] if o == 0 else t)
        rec = b"".join(out)
        src = Om.get(nm)
        if src is None:
            print(f"  {nm}: 元 GFA に無い"); continue
        orig = b"".join(So[t].translate(RC)[::-1] if x == "-" else So[t] for t, x in src)
        same = rec == orig
        ok += same
        if not same or ok <= 2:
            d = next((i for i, (a, b) in enumerate(zip(orig, rec)) if a != b), -1)
            print(f"  {nm}: 元 {len(orig):,} bp / 復元 {len(rec):,} bp / "
                  f"{'一致' if same else f'★不一致 先頭差分 {d:,}'}", flush=True)
    print(f"\n★ v2 サイドカーだけからの復元: {ok}/{len(rowsq)} パス完全一致")
    sys.exit(0 if ok == len(rowsq) else 1)


if __name__ == "__main__":
    main()
