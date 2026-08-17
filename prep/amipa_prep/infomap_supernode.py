#!/usr/bin/env python3
"""infomap_supernode.py — 「先に バブルを畳んで数万スーパーノードにしてから Infomap」版。

Phase B の layer0 unit(=top-level flubble を1個に畳んだタイル + 背骨ノード群; PGGB で ~86,062,
chrY で ~260) を頂点とし、GFA エッジが別 unit を跨ぐ本数を重みとする商グラフ(quotient graph)を
作って、Infomap 入力(重み付きリンクリスト)に書き出す。

狙い: Infomap をかける対象を 3.76M ノード(フルグラフ, two-level で 7.8GB) → ~8.6万ノードに縮約し、
メモリ問題を回避しつつ「layer0 の"上"にもう一段の粗視化(=layer0 表示数の cap)」を Infomap で得る。
ExpandModel のノード分割(claim=内部 / boundary_owner=境界 / pure_backbone=背骨・leak内部)は
互いに素なので、各 original node を一意に layer0 supernode へ写せる。

用法:
  infomap_supernode.py --gfa X.compact.gfa --pvst A.pvst [B.pvst ...] --out edges.txt
  → edges.txt(sa sb weight) と <out>.map(node -> super) を書き、統計を表示。
  そのあと: infomap edges.txt outdir --flow-model undirected --seed 1 -N1 --tree
"""
import argparse
import os
import re
import sys
import time
from collections import defaultdict

import numpy as np

# ★絶対パスを埋めない（コンテナや他人のマシンで壊れる。ホームが bind される環境では
#   「たまたま動く」ぶん厄介＝**ホスト側のコードを黙って読む**）。リポ相対で解決する。
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from balanced_expand import ExpandModel, log


def build_super_map(M):
    """各 original node -> layer0 supernode index。layer0 = group_consecutive(base_units)。
    返り値: super_of(dict node->j), nsuper, l0(layer0 units)。"""
    parent = M.parent
    top = np.full(M.F, -1, np.int64)

    def root_of(fi):
        path = []
        while top[fi] < 0 and parent[fi] >= 0:
            path.append(fi)
            fi = parent[fi]
        r = fi if top[fi] < 0 else int(top[fi])
        for p in path:
            top[p] = r
        top[r] = r
        return r

    for fi in range(M.F):
        if top[fi] < 0:
            root_of(fi)

    # base units(root_children_units の入力)と layer0 grouping
    base_units = [(0, x) for x in M.pure_backbone] + \
                 [(1, c) for c in M.root_children if M.ndesc[c] > 0]
    l0 = M.group_consecutive(base_units)
    key2super = {}
    for j, u in enumerate(l0):
        if u[0] == 2:
            for m in u[1]:
                key2super[m] = j
        else:
            key2super[u] = j
    nsuper = len(l0)

    # node -> base unit key -> super
    super_of = {}
    for nd, fi in M.claim.items():
        super_of[nd] = key2super[(1, int(top[fi]))]
    for nd, fi in M.boundary_owner.items():
        super_of[nd] = key2super[(1, int(top[fi]))]
    for nd in M.pure_backbone:
        super_of[nd] = key2super[(0, nd)]
    return super_of, nsuper, l0


def _iter_edges(gfa, distill):
    """L 行の (a, b) を file order で yield。distill 指定時は l_a/l_b 配列(dense)を読む。"""
    if distill is not None:
        l_a = np.load(os.path.join(distill, "l_a.npy")).tolist()
        l_b = np.load(os.path.join(distill, "l_b.npy")).tolist()
        for i in range(len(l_a)):
            yield l_a[i], l_b[i]
        return
    with open(gfa) as f:
        for line in f:
            if line[0] != "L":
                continue
            p = line.split("\t")
            yield int(p[1]), int(p[3])


def build_quotient(gfa, super_of, distill=None):
    """L 行を1回走査し、別 super を跨ぐエッジ本数を重みに商グラフを作る。
    distill 指定時は l_a/l_b 配列(dense, file order)を代わりに読む(出力は GFA 版と同一)。"""
    w = defaultdict(int)
    miss = 0
    n_self = 0
    for a, b in _iter_edges(gfa, distill):
        sa = super_of.get(a)
        sb = super_of.get(b)
        if sa is None or sb is None:
            miss += 1
            continue
        if sa == sb:
            n_self += 1
            continue
        key = (sa, sb) if sa < sb else (sb, sa)
        w[key] += 1
    return w, miss, n_self


def pansn_hapkey(name):
    """PanSN 命名から「相異ハプロタイプ」キーを頑健に決める。

    - `sample#hap#contig[...]` (3フィールド以上かつ第2が整数) → `sample#hap`
      (正しく書かれた PanSN。二倍体の hap1/hap2 を分離)
    - `sample#contig` (2フィールドで第2が非整数=ハプロ番号欠落の参照など) → `sample`
      (第2をコンティグと判断。断片化した参照サブレンジを1本に束ねる)
    - 単一フィールド → そのまま
    整数ヒューリスティックで `CHM13#chrY[..]`(コンティグ) と `HG002#1`(ハプロ) を弁別する。
    """
    p = name.split("#")
    if len(p) >= 3 and p[1].isdigit():
        return p[0] + "#" + p[1]
    return p[0]


def build_quotient_hap(gfa, super_of, struct_edges, floor=1):
    """P 行を1回走査し、supernode を跨ぐ辺ごとに『相異ハプロタイプ数』を重みにする。

    - キー付けは pansn_hapkey(参照は普通のハプロとして計数=特別扱いなし)。
    - 重みは struct_edges(=build_quotient の辺集合=商グラフのトポロジ) に沿って付与し、
      path が通らない辺は floor(既定1) で下支え(連結性維持)。→ 辺集合・連結成分は不変、値だけ変わる。
    返り値: w(dict edge->相異ハプロ数), npath, n_hap(相異ハプロ総数)。
    """
    edge_haps = defaultdict(set)
    npath = 0
    all_haps = set()
    with open(gfa) as f:
        for line in f:
            if line[0] != "P":
                continue
            parts = line.rstrip("\n").split("\t")
            hk = pansn_hapkey(parts[1])
            all_haps.add(hk)
            npath += 1
            prev = None
            for tok in parts[2].split(","):
                nid = int(tok[:-1])  # 末尾の向き(+/-)を除去
                s = super_of.get(nid)
                if s is None:
                    prev = None
                    continue
                if prev is not None and prev != s:
                    k = (prev, s) if prev < s else (s, prev)
                    edge_haps[k].add(hk)
                prev = s
    w = {k: max(floor, len(edge_haps.get(k, ()))) for k in struct_edges}
    return w, npath, len(all_haps)


def ekey(u, v):
    """生 GFA 辺(無向)の int エンコードキー。(min<<32)|max。node id < 2**32 前提
    (chr22 PGGB 最大 3.76M で十分)。tuple より軽く 5M 辺級の dict でも省メモリ。"""
    return (u << 32) | v if u < v else (v << 32) | u


def build_edge_hapw(gfa):
    """P 行を1回走査し、生 GFA 辺ごとの『相異ハプロタイプ数』を事前計算する(App B 用に保存)。

    App B(_kid_quotient)は バブル発火のたびに直接子間の生辺を数えるので、path を毎回走査すると
    重い。ここで一度だけ計算して dict に保存し、以降は辞書引きだけにする。

    HPRC/MC の P 行は同一 hapkey(sample#hap) のコンティグが連続して並ぶので、edge_lasthap で
    「直近に加算したハプロ」を覚えておけば、断片化コンティグの二重計上を避けて(ほぼ)ハプロタイプ
    単位の distinct 計数になる。辺キーは ekey() の int エンコードで軽量化。
    返り値: dict ekey->相異ハプロ数(covered edge のみ; 未計上辺は lookup 側で floor)。
    """
    edge_w = {}
    edge_last = {}
    hid = {}
    with open(gfa) as f:
        for line in f:
            if line[0] != "P":
                continue
            parts = line.rstrip("\n").split("\t")
            hk = pansn_hapkey(parts[1])
            h = hid.get(hk)
            if h is None:
                h = len(hid)
                hid[hk] = h
            prev = None
            for tok in parts[2].split(","):
                nid = int(tok[:-1])
                if prev is not None and prev != nid:
                    e = (prev << 32) | nid if prev < nid else (nid << 32) | prev
                    if edge_last.get(e) != h:
                        edge_last[e] = h
                        edge_w[e] = edge_w.get(e, 0) + 1
                prev = nid
    del edge_last  # 走査後は不要(edge_w だけ保持)
    return edge_w, len(hid)


def _iter_path_tokens(gfa, distill):
    """P/W 行の (name, token_iterable[int]) を file order で yield。distill 指定時は
    p_names/p_off/p_tok(dense) を読む。token は dense int。

    ★ hap エッジ重み用に **W 行(iswalk==1)も算入**する(実ハプロタイプ)。以前は P 行のみ
    (② の GFA-P-only 名残)だったが、MC など walk 主体のグラフでは実ハプロが数えられず hap 重みが
    縮退する(v2 MC は n_p=0=全 W → 全エッジ floor)。P 行のみ(pggb/chrY, n_w==0)では W が無く挙動不変。

    p_tok は全 mmap(=T*4B の VSZ 予約)せず .npy を open して per-path で seek+read する
    (WG 規模 T~4e10 で p_tok が 150GB+ になり memmap の VSZ 予約が RLIMIT_AS を超過するのを回避;
    p_off は単調・file order 走査ゆえ実質シーケンシャル。読む値は mmap 版と bit 同一)。"""
    if distill is not None:
        import numpy.lib.format as _npf
        names = open(os.path.join(distill, "p_names.txt")).read().split("\n")
        if names and names[-1] == "":
            names = names[:-1]
        p_off = np.load(os.path.join(distill, "p_off.npy"))
        with open(os.path.join(distill, "p_tok.npy"), "rb") as fh:
            ver = _npf.read_magic(fh)
            _shape, _fortran, dtype = _npf._read_array_header(fh, ver)
            data_off = fh.tell()
            isz = dtype.itemsize
            for k in range(len(names)):
                a = int(p_off[k]); b = int(p_off[k + 1])
                fh.seek(data_off + a * isz)
                buf = fh.read((b - a) * isz)
                yield names[k], np.frombuffer(buf, dtype=dtype).tolist()
        return
    with open(gfa) as f:
        for line in f:
            c = line[0]
            if c == "P":
                parts = line.rstrip("\n").split("\t")
                yield parts[1], (int(tok[:-1]) for tok in parts[2].split(","))
            elif c == "W":
                parts = line.rstrip("\n").split("\t")
                yield (f"{parts[1]}#{parts[2]}#{parts[3]}",
                       (int(m) for m in re.findall(r"[<>](\d+)", parts[6])))


def build_quotient_hap_and_edgew(gfa, super_of, struct_edges, floor=1, distill=None):
    """build_quotient_hap と build_edge_hapw の**融合版**: P 行を1回だけ走査し、
    App A(super-edge 相異ハプロ数で再重み) と App B(生edge 相異ハプロ数) を同時計算する。

    2関数を別々に呼ぶと同じ P 行・同じトークン列を2回走査・2回 int 化するため、
    ここで1パスに畳んで GFA 読み+トークン parse を半減する(WG/MC で律速)。
    蓄積先はそれぞれ独立(super 粒度のハプロ集合 / 生edge の last-hap dedup 計数)なので
    **出力は両関数と厳密一致**(w, edge_w, npath, 相異ハプロ数)。

    返り値: (w, npath, n_hap, edge_w, n_hap_B)
      - w        : dict struct-edge -> max(floor, 相異ハプロ数)  [= build_quotient_hap の w]
      - edge_w   : dict ekey(生edge) -> 相異ハプロ数            [= build_edge_hapw の edge_w]
      - n_hap == n_hap_B == 相異 hapkey 総数 (両者は同じ集合を数えるので一致)
    """
    edge_haps = defaultdict(set)  # App A: super-edge -> hapkey 集合
    npath = 0
    all_haps = set()              # App A: 相異 hapkey
    edge_w = {}                   # App B: 生edge ekey -> 計数
    edge_last = {}                # App B: 生edge ekey -> 直近加算 hid
    hid = {}                      # App B: hapkey -> 連番 id
    for pname, toks in _iter_path_tokens(gfa, distill):
        hk = pansn_hapkey(pname)
        all_haps.add(hk)          # App A
        npath += 1
        h = hid.get(hk)           # App B の hap id(P 行出現順で連番)
        if h is None:
            h = len(hid)
            hid[hk] = h
        prev_s = None             # App A: 直前の super
        prev_n = None             # App B: 直前の生 node
        for nid in toks:          # dense int(GFA 版は tok[:-1] の int 化)
            # ---- App B(生edge, last-hap dedup) ----
            if prev_n is not None and prev_n != nid:
                e = (prev_n << 32) | nid if prev_n < nid else (nid << 32) | prev_n
                if edge_last.get(e) != h:
                    edge_last[e] = h
                    edge_w[e] = edge_w.get(e, 0) + 1
            prev_n = nid
            # ---- App A(super-edge, 集合で distinct) ----
            s = super_of.get(nid)
            if s is None:
                prev_s = None
                continue
            if prev_s is not None and prev_s != s:
                k = (prev_s, s) if prev_s < s else (s, prev_s)
                edge_haps[k].add(hk)
            prev_s = s
    w = {k: max(floor, len(edge_haps.get(k, ()))) for k in struct_edges}
    del edge_last  # 走査後は不要
    return w, npath, len(all_haps), edge_w, len(hid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gfa", required=True)
    ap.add_argument("--pvst", nargs="+", required=True)
    ap.add_argument("--nsplit", type=int, default=6)
    ap.add_argument("--out", required=True, help="商グラフの重み付きリンクリスト出力先")
    args = ap.parse_args()

    t0 = time.time()
    M = ExpandModel(args.gfa, args.pvst, nsplit=args.nsplit)

    log("build super map (node -> layer0 unit)")
    super_of, nsuper, l0 = build_super_map(M)
    log(f"supernodes(layer0 units) = {nsuper}  covered nodes = {len(super_of)} / N={M.N}")

    # supernode サイズ(内部 original node 数)分布
    size = np.zeros(nsuper, np.int64)
    for nd, j in super_of.items():
        size[j] += 1
    nz = size[size > 0]
    log(f"super size: min={nz.min()} median={int(np.median(nz))} "
        f"mean={nz.mean():.1f} max={nz.max()} singleton(size1)={int((size==1).sum())}")

    log("build quotient graph from GFA edges")
    w, miss, n_self = build_quotient(args.gfa, super_of)
    log(f"quotient edges = {len(w)}  (self-edges skipped={n_self}, unmapped-endpoint edges={miss})")

    deg = defaultdict(int)
    for (a, b), c in w.items():
        deg[a] += 1
        deg[b] += 1
    degv = np.array([deg.get(j, 0) for j in range(nsuper)])
    log(f"quotient degree: min={degv.min()} median={int(np.median(degv))} "
        f"mean={degv.mean():.1f} max={degv.max()} isolated(deg0)={int((degv==0).sum())}")

    with open(args.out, "w") as o:
        for (a, b), c in w.items():
            o.write(f"{a} {b} {c}\n")
    log(f"wrote {args.out}  ({len(w)} weighted links)")

    mp = args.out + ".map"
    with open(mp, "w") as o:
        for nd in sorted(super_of):
            o.write(f"{nd} {super_of[nd]}\n")
    log(f"wrote {mp}  (node->super, {len(super_of)} lines)")

    print(f"RESULT supernodes={nsuper} quotient_edges={len(w)} "
          f"maxdeg={int(degv.max())} covered={len(super_of)}/{M.N} "
          f"({time.time()-t0:.1f}s)")


if __name__ == "__main__":
    main()
