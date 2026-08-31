#!/usr/bin/env python3
"""畳み込み GFA と対応付けサイドカーだけから各ハプロタイプを復元し、元の GFA と突き合わせる。

サイドカーの node_msa は「変異する列だけ」を持つが、非変異列は代表配列そのものなので
これだけで完全復元できる。表示用の MSA と可逆性の保証が同じ表になっていることの確認。

  collapse_verify.py <元.gfa> <畳み込み.gfa> [<サイドカー>]
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
    print(f"サイドカー {sc}\n  " + " / ".join(f"{k}={v}" for k, v in sorted(meta.items())), flush=True)
    msa = {g: (n_, c_, np.frombuffer(co, np.int32), np.frombuffer(ce, np.uint8))
           for g, n_, c_, co, ce in con.execute(
               "SELECT gid,nrun,ncol,cols,cells FROM node_msa")}
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
            if m is not None:
                _, ncol, cols, cells = m
                row = cells[r * ncol:(r + 1) * ncol]
                b = bytearray(s)
                for t in range(ncol):
                    if row[t] != 0x2E:            # '.' = 代表と同じ
                        b[cols[t]] = row[t]
                s = bytes(b)
            out.append(s.translate(RC)[::-1] if o == 0 else s)
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
    print(f"\n★ サイドカーだけからの復元: {ok}/{len(rowsq)} パス完全一致")
    sys.exit(0 if ok == len(rowsq) else 1)


if __name__ == "__main__":
    main()
