#!/usr/bin/env python3
"""verify_api.sh が「次のリクエストに使う値」を応答から取り出す係。

決め打ちの座標やノード名を書くと、グラフが変わった瞬間に空応答になって
「速い/OK」と誤読する。だから常に DB 自身の応答から取る。

usage: pick.py <what>   (stdin = 応答 JSON)
  bbox    -> "maxlayer x0 y0 x1 y1"（/stats の world）
  gid     -> "lo-hi"（1 サンプル分の contig_id 範囲。/path_groups の gids。hap 揃い→mode=exact）
  gidcsv  -> "g1,g2,..."（/ribbon の groups= に渡す gid の CSV）
  node    -> 最初の node_name
  parent  -> /node_info の parent_name（葉の親＝小さいバブル。MSA の試験対象）
  refctg  -> 最初の参照 contig の **contig_id**（/goto は名前でなく数値 id を取る）
"""
import json
import sys

what = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit()


def rows(x, *keys):
    if isinstance(x, list):
        return x
    for k in keys:
        v = x.get(k) if isinstance(x, dict) else None
        if isinstance(v, list):
            return v
    return []


if what == "bbox":
    # /stats の世界座標は `world: {x0,x1,y0,y1}`（bbox/bounds ではない）。
    b = d.get("world") or d.get("bbox") or d.get("bounds") or {}
    src = {**d, **(b if isinstance(b, dict) else {})}

    def g(*names):
        for n in names:
            if src.get(n) is not None:
                return src[n]
        return None
    print(d.get("maxlayer") or d.get("maxLayer"),
          g("x0", "minX", "min_x", "x1"), g("y0", "minY", "min_y", "y1"),
          g("x1", "maxX", "max_x", "x2"), g("y1", "maxY", "max_y", "y2"))
elif what in ("gid", "gidcsv"):
    # /path_groups は [{key, label, n_contigs, total_cov, gids:[lo,hi]}, ...]。
    # 1 サンプル分の gids を丸ごと取ると hap 全体が入る → buildSelection の partial が false
    #   → Selection.exact になり、マスクだけで厳密に絞れる経路を通る。
    g = [r["gids"] for r in rows(d, "groups", "rows") if isinstance(r, dict) and r.get("gids")]
    if not g:
        print("")
    elif what == "gid":
        lo, hi = g[0][0], g[0][-1]
        print(f"{lo}-{hi}")
    else:
        print(",".join(str(x) for x in g[0]))
elif what == "node":
    r = rows(d, "nodes", "rows", "items")
    print(r[0].get("node_name", "") if r and isinstance(r[0], dict) else "")
elif what == "parent":
    print(d.get("parent_name") or "" if isinstance(d, dict) else "")
elif what == "refctg":
    # ★/goto の contig は **数値 contig_id**。名前を渡すと Number() が NaN になり
    #   "Invalid contig/bp" で 400 が返る（機能の故障と誤読しやすい）。
    r = rows(d, "contigs", "rows", "items")
    if r and isinstance(r[0], dict):
        v = r[0].get("contig_id")
        print(v if v is not None else "")
    else:
        print("")
else:
    print("")
