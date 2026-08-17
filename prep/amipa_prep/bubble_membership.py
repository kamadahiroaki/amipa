#!/usr/bin/env python3
"""bubble_membership.py — povu PVST(flubble tree) の各 flubble の**内部メンバノード集合**を
GFA 位相から有界フラッドで復元する(対話 2026-06-24)。

背景: PVST/lod_nodes.tsv は flubble を「向き付き境界対(a,z)＋入れ子」でしか持たず、内部メンバ
ノードを持たない(stage3_lod_tree は境界2ノードしか記録しない→ L2以深が span0 になる元凶)。
これを補い、(1)ホットスポット flubble を1単位で畳む/開く, (2)任意 LOD level の per-node 着色
を可能にする。

アルゴリズム(deepest-wins 有界フラッド, O(N+E)):
  flubble (a,sa)->(z,sz) の内部 = a の**出口側**(sa 由来)の隣接から undirected フラッドし、
  a,z と「既に深い flubble に claim 済みのノード」を壁として到達した未claim ノード集合。
  flubble を**深さ降順**で処理 → 子が先に内部を claim するので、親のフラッドは子境界で止まり
  「親の直接メンバ(deepest container)」だけが残る。各ノードは一度だけ claim される。
  有向シード(a 出口側)＋ a,z 壁で外へ漏れない(過去の無向-only net-graph leak の是正と同方式)。

入力:
  --pvst        povu の .pvst(複数可)
  --edges       stage1 *.edge_support.tsv (a, oa, b, ob, support 向き付き)
  --nodes       stage1 *.node_support.tsv (id 列挙; メンバ表の母集合)
出力(--out プレフィックス):
  {out}.node_flubble.tsv   node_id, deepest_flubble, depth  (未claim は出さない)
  {out}.flubbles.tsv       flubble_id, parent, depth, a, z, a_sign, z_sign,
                           n_members, n_desc_members, leak(1=フラッド過大で要注意)
"""
import argparse
import re
import sys
import time
from collections import defaultdict, deque

import numpy as np

OR = {">": "+", "<": "-"}
BND = re.compile(r"([<>])(\d+)")


def log(m):
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {m}\n"); sys.stderr.flush()


def parse_pvst(paths):
    """複数 .pvst を読み、flubble配列を返す。
       返り値: a[], z[], asign[], zsign[](node_id int / '+'/'-'), kids(list[list]),
               root_kids(list), 各 flubble の局所idx は 0..F-1 に通し番号化。"""
    A, Z, AS, ZS = [], [], [], []
    kids = []
    root_children = []
    for path in paths:
        local = {}              # pvst内idx -> global idx
        rows = []
        with open(path) as f:
            f.readline()        # header H
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) < 4:
                    continue
                fam, idx_s, bnd, ch = p[0], p[1], p[2], p[3]
                rows.append((fam, int(idx_s), bnd, ch))
        # まず idx を割り当て(D=root は flubble にしない)
        root_idx = None
        for fam, idx, bnd, ch in rows:
            if fam == "D":
                root_idx = idx
                continue
            m = BND.findall(bnd)
            if len(m) != 2:
                continue
            local[idx] = len(A)
            (oa, ida), (oz, idz) = m
            A.append(int(ida)); Z.append(int(idz))
            AS.append(OR[oa]); ZS.append(OR[oz])
            kids.append([])
        # children を貼る(local 経由で global へ)
        for fam, idx, bnd, ch in rows:
            ks = [] if ch == "." else [int(x) for x in ch.split(",") if x.strip()]
            gks = [local[k] for k in ks if k in local]
            if fam == "D":
                root_children.extend(gks)
            elif idx in local:
                kids[local[idx]] = gks
    return (np.array(A, np.int64), np.array(Z, np.int64),
            np.array(AS), np.array(ZS), kids, root_children)


def compute_depth(F, kids, root_children):
    """root の子を深さ1とし、子孫の深さと親を BFS で付与。"""
    depth = np.zeros(F, np.int32)
    parent = np.full(F, -1, np.int64)
    dq = deque()
    for k in root_children:
        depth[k] = 1; dq.append(k)
    while dq:
        u = dq.popleft()
        for v in kids[u]:
            if depth[v] == 0:               # 未訪問(depthは1始まりなので0=未)
                depth[v] = depth[u] + 1
                parent[v] = u
                dq.append(v)
    return depth, parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pvst", nargs="+", required=True)
    ap.add_argument("--edges", required=True)
    ap.add_argument("--nodes", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--leak-cap", type=int, default=200000,
                    help="1 flubble のフラッドがこれを超えたら leak とみなし打ち切り")
    args = ap.parse_args()
    t0 = time.time()

    log("parse pvst")
    A, Z, AS, ZS, kids, root_children = parse_pvst(args.pvst)
    F = A.size
    depth, parent = compute_depth(F, kids, root_children)
    log(f"flubbles={F} max_depth={depth.max()} root_children={len(root_children)}")

    log("load edges (oriented) + build adjacency")
    import pandas as pd
    e = pd.read_csv(args.edges, sep="\t", usecols=["a", "oa", "b", "ob"],
                    dtype={"a": np.int64, "oa": str, "b": np.int64, "ob": str})
    ea = e["a"].to_numpy(); eb = e["b"].to_numpy()
    oa = e["oa"].to_numpy(); ob = e["ob"].to_numpy()
    # 無向 node 隣接 + 有向 side 隣接(side: end 0/1)
    nadj = defaultdict(list)
    sideadj = defaultdict(list)        # (node, end) -> [neighbor_node,...]
    for i in range(ea.size):
        a_, b_ = int(ea[i]), int(eb[i])
        nadj[a_].append(b_); nadj[b_].append(a_)
        aex = 1 if oa[i] == "+" else 0      # a の出口側
        ben = 0 if ob[i] == "+" else 1      # b の入口側
        sideadj[(a_, aex)].append(b_)
        sideadj[(b_, ben)].append(a_)
    log(f"edges={ea.size} nodes_in_adj={len(nadj)}")

    # claim 配列(node_id -> flubble global idx, -1=未claim)
    claim = {}                              # node_id -> flubble idx
    order = np.argsort(-depth)              # 深さ降順
    n_members = np.zeros(F, np.int64)
    leak = np.zeros(F, np.int8)

    log("bounded flood (deepest-first)")
    for cnt, fi in enumerate(order):
        a_, z_ = int(A[fi]), int(Z[fi])
        aex = 1 if AS[fi] == "+" else 0
        seeds = sideadj.get((a_, aex), ())
        # フラッド: a,z を壁、claim 済みを壁
        seen = []
        stack = []
        for s in seeds:
            if s != a_ and s != z_ and s not in claim:
                stack.append(s)
        local_seen = set()
        capped = False
        while stack:
            u = stack.pop()
            if u in local_seen:
                continue
            local_seen.add(u)
            if len(local_seen) > args.leak_cap:
                capped = True
                break
            for v in nadj.get(u, ()):
                if v == a_ or v == z_ or v in claim or v in local_seen:
                    continue
                stack.append(v)
        if capped:
            leak[fi] = 1
            # leak は claim しない(全体を飲み込むのを防ぐ)
            n_members[fi] = 0
            continue
        for u in local_seen:
            claim[u] = fi
        n_members[fi] = len(local_seen)
        if cnt % 50000 == 0:
            log(f"  {cnt}/{F} flubbles, claimed nodes={len(claim)}")

    log(f"flood done in {time.time()-t0:.1f}s; claimed={len(claim)} leaks={int(leak.sum())}")

    # 子孫メンバ込みの総数(畳み表示用): n_desc = 自分 + 全子孫の n_members
    n_desc = n_members.copy()
    for fi in order:                        # 深さ降順 = 子が先に確定
        p = parent[fi]
        if p >= 0:
            n_desc[p] += n_desc[fi]

    log("write outputs")
    with open(args.out + ".node_flubble.tsv", "w") as o:
        o.write("node_id\tdeepest_flubble\tdepth\n")
        for nid, fi in claim.items():
            o.write(f"{nid}\t{fi}\t{int(depth[fi])}\n")
    with open(args.out + ".flubbles.tsv", "w") as o:
        o.write("flubble_id\tparent\tdepth\ta\tz\ta_sign\tz_sign\t"
                "n_members\tn_desc_members\tleak\n")
        for fi in range(F):
            o.write(f"{fi}\t{int(parent[fi])}\t{int(depth[fi])}\t{int(A[fi])}\t{int(Z[fi])}\t"
                    f"{AS[fi]}\t{ZS[fi]}\t{int(n_members[fi])}\t{int(n_desc[fi])}\t{int(leak[fi])}\n")
    log(f"ALL DONE in {time.time()-t0:.1f}s  -> {args.out}.node_flubble.tsv / .flubbles.tsv")


if __name__ == "__main__":
    main()
