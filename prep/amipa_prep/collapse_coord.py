#!/usr/bin/env python3
"""畳み込み（collapse.py）後のノード id に、元グラフのノード座位座標を写す。

元ノードの座標 TSV（id, coord[, u]。locusfold の出力）と <db>.collapse サイドカーの orig_node 表（元 id → 畳み込みノード gid・
代表配列内オフセット off）から、畳み込みノードごとに構成ノードの中点座標の最小と最大の中央を採る（＝畳み込みノードの座位区間の中心）。
座標がノード中点の定義なので向きに依存せず、隣接ノードとの中点差から両ノード長の平均を引くと 0 になり、辺の目標長が 1 のまま保たれる。

usage: collapse_coord.py <db>.collapse in.coord.tsv out.coord.tsv"""
import sys, sqlite3, numpy as np

sidecar, cin, cout = sys.argv[1:4]
coord = {}; unc = {}
with open(cin) as f:
    hdr = f.readline().rstrip("\n").split("\t"); ic = hdr.index("coord") if "coord" in hdr else 1; iu = hdr.index("u") if "u" in hdr else None
    for ln in f:
        p = ln.rstrip("\n").split("\t"); coord[int(p[0])] = float(p[ic])
        if iu is not None: unc[int(p[0])] = float(p[iu])
con = sqlite3.connect("file:" + sidecar + "?mode=ro", uri=True)
rows = con.execute("SELECT orig_id, gid FROM orig_node").fetchall()
lo = {}; hi = {}; uu = {}; n_gid = len({g for _, g in rows})
for orig_id, gid in rows:
    if orig_id not in coord: continue
    c = coord[orig_id]
    if gid not in lo or c < lo[gid]: lo[gid] = c
    if gid not in hi or c > hi[gid]: hi[gid] = c
    if unc and (gid not in uu or unc[orig_id] < uu[gid]): uu[gid] = unc[orig_id]
with open(cout, "w") as w:
    w.write("id\tcoord\tu\n" if unc else "id\tcoord\n")
    for gid in sorted(lo):
        m = 0.5 * (lo[gid] + hi[gid])                      # 構成ノードの中点座標の区間の中心 = 畳み込みノードの座位区間の中心（向きに依存しない）
        w.write(f"{gid}\t{m:.0f}\t{uu[gid]:.0f}\n" if unc else f"{gid}\t{m:.0f}\n")
best = lo
print(f"[collapse_coord] 元ノード座標 {len(coord):,} → 畳み込みノード {len(best):,} / {n_gid:,} に座標 -> {cout}", flush=True)
