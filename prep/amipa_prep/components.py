#!/usr/bin/env python3
"""components.py — 連結成分の分類（major=本体 / debris=孤立ノード・微小成分）の共有情報源。

UNIFIED_INFOMAP_LOD_SPEC.md §8。LOD 木（lod.py）とレイアウト
（scripts/layout_sgd_plain.py）が同一規則で成分を major/debris に分ける。

- major : 重み(=内部 GFA ノード数) >= τ、または ref を担う成分。ゲノム全体では各染色体が major。
- debris: それ以外。1成分=1サブクラスタに束ね、レイアウトでは一箇所(トレイ)に集約する。
- 安全弁: major が0個なら最大成分を強制 major（退化回避）。

依存は numpy のみ。ラベルは任意の int（呼び出し側で scipy connected_components を使ってもよいし、
`labels_from_edges` の union-find を使ってもよい）。
"""
from collections import namedtuple

import numpy as np


def labels_from_edges(n, ei, ej):
    """union-find で無向連結成分ラベル(0..)を返す。ei/ej は要素 index の配列。
    要素数 n が小さい(数万)用途向け(レイアウトの数百万ノードは scipy を推奨)。"""
    parent = np.arange(n, dtype=np.int64)

    def find(x):
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:      # path compression
            parent[x], x = root, parent[x]
        return root

    ei = np.asarray(ei, dtype=np.int64)
    ej = np.asarray(ej, dtype=np.int64)
    for a, b in zip(ei.tolist(), ej.tolist()):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    # 正規化(root ラベル→連番)
    roots = np.array([find(i) for i in range(n)], dtype=np.int64)
    _, labels = np.unique(roots, return_inverse=True)
    return labels.astype(np.int64)


Classification = namedtuple(
    "Classification",
    "labels weight comp_weight major_comps is_major_elem n_major n_debris")


def classify_labels(labels, tau, weight=None, ref_comps=None):
    """成分ラベルを major/debris に分類。

    labels : 要素→成分 id の int 配列(長さ m)。
    tau    : major しきい値(成分重み >= tau なら major)。
    weight : 要素ごとの重み(既定=1。LOD では supernode の内部ノード数)。
    ref_comps: ref を担う成分 id の集合(サイズによらず major に含める)。

    返り値 Classification:
      comp_weight   : {comp_id: 重み合計}
      major_comps   : major と判定した comp_id の set
      is_major_elem : 要素ごとの bool 配列(その要素が major 成分に属すか)
    """
    labels = np.asarray(labels, dtype=np.int64)
    m = len(labels)
    if weight is None:
        weight = np.ones(m, dtype=np.int64)
    else:
        weight = np.asarray(weight, dtype=np.int64)
    ncomp = int(labels.max()) + 1 if m else 0
    cw = np.bincount(labels, weights=weight, minlength=ncomp).astype(np.int64)
    comp_weight = {int(c): int(cw[c]) for c in range(ncomp)}

    major = set(int(c) for c in range(ncomp) if cw[c] >= tau)
    if ref_comps:
        major |= set(int(c) for c in ref_comps)
    if not major and ncomp > 0:              # 安全弁: 最大成分を major に
        major = {int(np.argmax(cw))}

    major_arr = np.zeros(ncomp, dtype=bool)
    for c in major:
        major_arr[c] = True
    is_major_elem = major_arr[labels] if m else np.zeros(0, dtype=bool)
    return Classification(
        labels=labels, weight=weight, comp_weight=comp_weight,
        major_comps=major, is_major_elem=is_major_elem,
        n_major=len(major), n_debris=ncomp - len(major))
