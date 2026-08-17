#!/usr/bin/env python3
"""relayer_halve.py — 統一 LOD 木(path<TAB>node)を「半減展開」で LOD 層に再編し層数を測る。

odgitest(Phase B / balanced_expand)で採用したのと同じ戦略を、既にできた細かい木
(lod.py の depth31 木など)への後処理として掛ける:

  各グリフ g(= 木の内部ノード。Infomap クラスタ "G" でもバブル "S" でも区別しない)を、
  「展開後の最大ピースの子孫ノード数が親 g の半分以下」になるまで **一度に** 展開する。
  具体的には g のサブツリーをしきい値 T=size(g)//2 で切ったフロンティア(=size<=T の最も浅い
  ノード集合)を次の LOD 層のグリフとする。size(child)<=T なら即採用、超える枝だけ更に潜る。

これにより fan-out=1 のテレスコープ入れ子や、大きい枝に付いた小枝は勝手に畳まれ、
入力の深い木が log2(N) 級の LOD 層に圧縮される(1回展開の fan-out は B を超え得る)。

入力: path<TAB>node(path は root='0'、以降 1-based 子番号を ':' 連結。fan-out<=10 前提)。
出力: LOD 層数 / 各層のグリフ数 / 1回展開の最大 fan-out(フロンティアサイズ)/ 分布。
"""
import argparse
import sys
import time
from array import array


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def build_tree(path):
    """path<TAB>node の葉パス列から木を復元。parent[v]<v が保証される(祖先は先に採番)。"""
    parent = array('i', [-1])          # parent[0] = root
    id_of = {}                          # (parent_id*64 + child_idx) -> node id
    nleaf = 0
    with open(path) as f:
        for ln in f:
            tab = ln.find('\t')
            p = ln[:tab] if tab >= 0 else ln.rstrip('\n')
            # path は root からの 1-based 子番号列(root は暗黙で先頭に無い)。
            # root 自身が葉になるのは全木が1葉のときだけで、その行だけ "0"。
            cur = 0
            if p != '0':
                for c in p.split(':'):
                    key = cur * 64 + int(c)
                    nid = id_of.get(key)
                    if nid is None:
                        nid = len(parent)
                        parent.append(cur)
                        id_of[key] = nid
                    cur = nid
            nleaf += 1
    return parent, nleaf


def csr_children(parent):
    n = len(parent)
    deg = array('i', [0]) * n
    for v in range(1, n):
        deg[parent[v]] += 1
    off = array('i', [0]) * (n + 1)
    for v in range(n):
        off[v + 1] = off[v] + deg[v]
    kids = array('i', [0]) * (n - 1 if n > 1 else 0)
    pos = array('i', off[0:n])
    for v in range(1, n):
        p = parent[v]
        kids[pos[p]] = v
        pos[p] += 1
    return deg, off, kids


def subtree_size(parent, deg):
    n = len(parent)
    size = array('i', [0]) * n
    for v in range(n):
        if deg[v] == 0:
            size[v] = 1
    for v in range(n - 1, 0, -1):       # parent[v] < v なので子は先に確定済み
        size[parent[v]] += size[v]
    return size


def halving_layers(off, kids, size):
    """半減展開で LOD 層を作り、(層数, 各層グリフ数, 最大展開fanout, fanout分布) を返す。"""
    def expand(g, T, out):
        stack = [g]                     # g 自身は size>T。子から潜る
        while stack:
            x = stack.pop()
            for i in range(off[x], off[x + 1]):
                c = kids[i]
                if size[c] <= T:
                    out.append(c)
                else:
                    stack.append(c)

    cur = [0]
    per_layer = [1]
    maxfan = 0
    fan_hist = {}
    while not all(size[g] == 1 for g in cur):
        nxt = []
        for g in cur:
            if size[g] == 1:
                nxt.append(g)
                continue
            T = size[g] // 2
            fr = []
            expand(g, T, fr)
            k = len(fr)
            if k > maxfan:
                maxfan = k
            fan_hist[k] = fan_hist.get(k, 0) + 1
            nxt.extend(fr)
        cur = nxt
        per_layer.append(len(cur))
    return len(per_layer), per_layer, maxfan, fan_hist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", required=True,
                    help="path<TAB>node の LOD 木(lod.py --out)")
    args = ap.parse_args()
    t0 = time.time()

    parent, nleaf = build_tree(args.tree)
    n = len(parent)
    log(f"reconstructed: tree nodes={n}  leaf lines={nleaf}")

    deg, off, kids = csr_children(parent)
    size = subtree_size(parent, deg)
    log(f"sizes done: N(root)={size[0]}  original max fan-out={max(deg)}")

    num_layers, per_layer, maxfan, fan_hist = halving_layers(off, kids, size)

    print("\n=== 半減展開による LOD 層再編 ===")
    print(f"tree nodes           = {n}  (internal {n - nleaf}, leaves {nleaf})")
    print(f"N (root size)        = {size[0]}  "
          f"({'OK ==葉' if size[0] == nleaf else 'MISMATCH'})")
    print(f"original tree depth比較用 max fan-out = {max(deg)}")
    print(f"LOD layers           = {num_layers}  (旧: root->葉 の生パス depth を圧縮)")
    print(f"max expand fan-out   = {maxfan}  (1回展開のフロンティア最大。半減規則では B を超え得る)")
    print(f"final layer glyphs   = {per_layer[-1]}  "
          f"({'OK ==N' if per_layer[-1] == size[0] else 'NG'})")
    print("per-layer glyph count= " +
          ", ".join(f"L{i}:{c}" for i, c in enumerate(per_layer)))
    print("expand fan-out hist  = " +
          ", ".join(f"{k}:{fan_hist[k]}" for k in sorted(fan_hist)))
    print(f"({time.time() - t0:.1f}s)")


if __name__ == "__main__":
    main()
