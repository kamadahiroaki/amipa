#!/usr/bin/env python3
"""relayer_common.py — LOD 再レイヤリング共通ユーティリティ。

`build_typed()`: lod.py --dump-typed の出力(path<TAB>kind<TAB>atom)から
統一 LOD 木を復元する。スケジューラ(現状 relayer_budget のみ)と emitter の共通入口。
以前は relayer_kindaware.py に同居していたが、kindaware スケジューラ廃止に伴いここへ移設。
"""
from array import array

_KMAP = {"L": 0, "G": 1, "S": 2}   # kind code


def build_typed(path):
    """path<TAB>kind<TAB>atom の全ノード列から木を復元。parent[v]<v・kind[v]・atom[v] を返す
    (atom は L の GFA node-id を int で, 内部ノードは -1)。"""
    parent = array('i', [-1])
    kind = bytearray([0])                     # kind[0]=root(後で上書き)
    atom = array('q', [-1])                   # 葉の GFA node-id(int), 内部は -1
    id_of = {}
    with open(path) as f:
        for ln in f:
            parts = ln.rstrip('\n').split('\t')
            p = parts[0]
            kd = parts[1]
            av = int(parts[2]) if len(parts) > 2 and parts[2] != '' else -1
            cur = 0
            if p != '0':
                for c in p.split(':'):
                    key = cur * 64 + int(c)
                    nid = id_of.get(key)
                    if nid is None:
                        nid = len(parent)
                        parent.append(cur)
                        kind.append(0)
                        atom.append(-1)
                        id_of[key] = nid
                    cur = nid
            kind[cur] = _KMAP[kd]              # そのノード自身の行で種別確定
            if av >= 0:
                atom[cur] = av
    return parent, kind, atom
