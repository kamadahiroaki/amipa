#!/usr/bin/env python3
"""verify_api.sh の判定係。stdin = 応答本文、argv = <http_code> <allow-empty か空>。

「200 が返った」だけでは機能したことにならない。error キー付き 200 と、矩形を外して
[] が返る形の両方を実際に踏んだので、どちらも失敗として扱う。
"""
import json
import sys

code = sys.argv[1] if len(sys.argv) > 1 else ""
allow = bool(sys.argv[2]) if len(sys.argv) > 2 else False
raw = sys.stdin.read()

if code != "200":
    print(f"NG HTTP {code}: {raw[:160]}")
    sys.exit()
try:
    d = json.loads(raw)
except Exception:
    print(f"NG JSON でない: {raw[:160]}")
    sys.exit()
if isinstance(d, dict) and d.get("error"):
    print(f"NG error: {str(d['error'])[:200]}")
    sys.exit()
if isinstance(d, list):
    if not d and not allow:
        print("NG 空配列（矩形/引数が的を外している疑い）")
    else:
        print(f"OK {len(d)} 件")
    sys.exit()
if isinstance(d, dict):
    # ★「先頭で見つかったキー」で判定してはいけない。/nodes_grid は `cells` に本体を入れ
    #   `nodes` は空のまま返す（件数が少ないときだけ個別ノードを載せる仕様）ので、
    #   nodes を先に見ると常に「0 件」になる。**どれか 1 つでも中身があれば通す**。
    keys = [k for k in ("nodes", "edges", "cells", "rows", "results", "groups",
                        "items", "contigs", "hits", "bases", "sequence")
            if k in d and hasattr(d[k], "__len__")]
    if keys:
        sizes = {k: len(d[k]) for k in keys}
        tot = sum(sizes.values())
        desc = " ".join(f"{k}={v}" for k, v in sizes.items())
        print(f"NG 全て 0 件 ({desc})" if (tot == 0 and not allow) else f"OK {desc}")
        sys.exit()
    print(f"OK {str(d)[:110]}")
    sys.exit()
print(f"OK {str(d)[:110]}")
