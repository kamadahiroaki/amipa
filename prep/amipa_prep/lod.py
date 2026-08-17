#!/usr/bin/env python3
"""lod.py — App B(layer0 の「下」= 各バブル内部)＋全体合成。

UNIFIED_INFOMAP_LOD_SPEC.md §4。root から個別 GFA ノードまで、どの階層でも fan-out<=B を保証する
統一 LOD 木を作る。2 粒度に同一の divisive_core を適用:
  App A: 商グラフ(layer0 supernode)上の divisive           … infomap_supernode + divisive_core
  App B: 各バブル内部で、直接子(直接葉ノード＋子バブル)が >B のとき局所商グラフに divisive
seam(layer0)で App A の葉(layer0 unit)を種別解決:
  (0,node)背骨 → LOD 葉 / (1,flubble F) → expand_bubble(F) / (2,members) → strip(座標≤B分割)

このスクリプト1本でフル pipeline(ExpandModel → super-map → 商グラフ → App A → App B → 合成木)を
実行し、最終 LOD 木の統計(葉数==N, 全階層 max fan-out<=B, depth, per-level)を出す。

用法:
  lod.py --gfa X.gfa --pvst A.pvst [B.pvst ...] [--B 10] [--out tree.tsv]
  ※ GFA と pvst は同一 node-id 空間であること(compact GFA は odgi が再採番するので不可;
     povu をかけた元 GFA を使う)。
"""
import argparse
import os
import sys
import time
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# ★絶対パスを埋めない（コンテナや他人のマシンで壊れる。ホームが bind される環境では
#   「たまたま動く」ぶん厄介＝**ホスト側のコードを黙って読む**）。リポ相対で解決する。
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from balanced_expand import ExpandModel, log
from divisive_core import Stats, divisive_build, tree_stats
from infomap_supernode import build_super_map, build_quotient
from components import labels_from_edges, classify_labels


def compute_top(M):
    """flubble -> root-ancestor flubble(top-level)。build_super_map と同じ union-find。"""
    parent = M.parent
    F = M.F
    top = np.full(F, -1, np.int64)

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

    for fi in range(F):
        if top[fi] < 0:
            root_of(fi)
    return top


class BubbleExpander:
    """App B: バブル内部の展開＋全体合成。divisive_core を共有。"""

    HUGE = 1 << 62

    def __init__(self, M, B=10, seed=1, use_meta=True, edge_hapw=None, small=0, large=0,
                 chain_ratio=0.0):
        self.M = M
        self.B = B
        self.seed = seed
        self.use_meta = use_meta
        self.small = small           # LOD② small-n cutoff(0=無効)
        self.large = large           # LOD③ large-n cutoff(0=無効)
        self.chain_ratio = chain_ratio  # chain-aware 分割(0.0=無効)。連続バブルを Infomap 省き posf 分割
        self.edge_hapw = edge_hapw   # None=L行多重度 / dict(ekey->相異ハプロ数)=ハプロ重み
        self.dstats = Stats()
        self.n_bubble = 0
        self.n_bubble_big = 0        # 直接子 >B で divisive をかけたバブル数
        self.max_direct_children = 0  # 生の直接子数(縮約前)の最大 = 旧 fan-out 相当

    # ---- 直接子(直接葉ノード + 子バブル) ----
    def direct_children(self, F):
        M = self.M
        kids = [("n", nd) for nd in M.direct_leaves.get(F, ())]
        kids += [("f", int(c)) for c in M.kids[F] if M.ndesc[c] > 0]
        return kids

    def _direct_child(self, F, node, cache):
        """F 内部ノード node が属す F の直接子を返す。("n",node) or ("f",child_flubble)。"""
        M = self.M
        f = M.claim.get(node)
        if f is None:
            f = M.boundary_owner.get(node)
        if f is None:
            return None
        if f == F:
            return ("n", node)                 # F の直接葉/境界
        hit = cache.get(f)                      # 同 deepest-flubble は同じ直接子
        if hit is not None:
            return hit
        a = f
        par = M.parent
        while par[a] != F:
            a = int(par[a])
            if a < 0:
                cache[f] = None
                return None                     # F の subtree 外(通常起きない)
        res = ("f", int(a))
        cache[f] = res
        return res

    def bucket(self, F, member_nodes):
        """member_nodes を F の直接子へバケツ。cm(kid->nodes) と member_kid(node->kid) を返す。"""
        cache = {}
        cm = defaultdict(list)
        member_kid = {}
        for nd in member_nodes:
            k = self._direct_child(F, nd, cache)
            if k is None:
                continue
            cm[k].append(nd)
            member_kid[nd] = k
        return cm, member_kid

    def _kid_quotient(self, cm, member_kid):
        """直接子間の局所商グラフ。既定の重み=直接子が異なる生 GFA 隣接本数(=L行多重度,
        App B もクラスタをメタノード化しないので概ね1)。edge_hapw があれば、その生辺の
        『相異ハプロタイプ数』(事前計算・保存済)を重みにする(未計上辺は floor=1)。"""
        ke = defaultdict(lambda: defaultdict(float))
        nadj = self.M.nadj
        ew = self.edge_hapw
        for k, nodes in cm.items():
            row = ke[k]
            for nd in nodes:
                for m in nadj.get(nd, ()):
                    k2 = member_kid.get(m)
                    if k2 is not None and k2 != k:
                        if ew is None:
                            row[k2] += 1.0
                        else:
                            e = (nd << 32) | m if nd < m else (m << 32) | nd
                            row[k2] += ew.get(e, 1.0)
        return ke

    def _posf(self, cm):
        def posf(k):
            b = cm.get(k)
            return min(b) if b else self.HUGE      # ゲノム順代理 = 子内 min node id
        return posf

    def resolve(self, kid, members):
        if kid[0] == "n":
            return ("L", kid[1])                    # GFA ノード = LOD 葉
        return self.expand(kid[1], members)          # 子バブル を再帰

    def _attach(self, node, cm):
        """divisive の ("L",kid)/("G",..) 木の葉(kid)を resolve で解決。"""
        if node[0] == "L":
            k = node[1]
            return self.resolve(k, cm.get(k, []))
        return ("G", [self._attach(c, cm) for c in node[1]])

    def expand(self, F, member_nodes):
        self.n_bubble += 1
        kids = self.direct_children(F)
        self.max_direct_children = max(self.max_direct_children, len(kids))
        cm, member_kid = self.bucket(F, member_nodes)
        posf = self._posf(cm)
        if len(kids) <= self.B:
            order = sorted(kids, key=posf)               # 子を ID(ゲノム)順に
            children = [self.resolve(k, cm.get(k, [])) for k in order]
            return ("S", F, children)
        # >B 直接子 → 局所商グラフに divisive(Infomap-cluster 中間ノード挿入)
        self.n_bubble_big += 1
        ke = self._kid_quotient(cm, member_kid)
        adjf = lambda k: ke.get(k, {}).items()
        tree = divisive_build(kids, adjf, posf, self.B, stats=self.dstats,
                              seed=self.seed, use_meta=self.use_meta,
                              small=self.small, large=self.large,
                              chain_ratio=self.chain_ratio)
        attached = self._attach(tree, cm)               # tree は ("G", parts)
        return ("S", F, attached[1])

    # ---- seam: layer0 unit の種別解決 ----
    def resolve_unit(self, unit, nodes_by_topflub):
        t = unit[0]
        if t == 0:
            return ("L", unit[1])
        if t == 1:
            F = unit[1]
            return self.expand(F, nodes_by_topflub.get(F, []))
        # t == 2: 連続バブル群 → strip(既に group_consecutive で ID 昇順)
        members = unit[1]
        resolved = [self.resolve_unit(m, nodes_by_topflub) for m in members]
        return self.strip_group(resolved)

    def strip_group(self, children):
        """順序保持のまま fan-out<=B の strip 木に(座標=既存 ID 順で ≤B 再帰分割)。"""
        B = self.B
        if len(children) <= 1:
            return children[0] if children else ("G", [])
        if len(children) <= B:
            return ("G", children)
        n = len(children)
        groups = []
        for i in range(B):
            s = i * n // B
            e = (i + 1) * n // B
            if e > s:
                groups.append(self.strip_group(children[s:e]))
        return ("G", groups)

    # ---- 全体合成: App A 木の葉(supernode)を layer0 unit 解決に置換 ----
    def compose(self, appA_node, l0, nodes_by_topflub):
        if appA_node[0] == "L":
            return self.resolve_unit(l0[appA_node[1]], nodes_by_topflub)
        return ("G", [self.compose(c, l0, nodes_by_topflub) for c in appA_node[1]])


def _children(node):
    if node[0] == "G":
        return node[1]
    if node[0] == "S":
        return node[2]
    return None


def tail_analysis(root):
    """tuple 木(L/G/S)を size 付けし、dominant node(heavy child が親 size の半分超)を種別(G/S)
    分類。heavy child を辿った最長 dominant 鎖=「半分ずつしか解けない尾」の正体を種別で示す。"""
    size = {}
    heavy = {}
    order = []
    stack = [(root, False)]
    while stack:
        nd, proc = stack.pop()
        ch = _children(nd)
        if ch is None:
            size[id(nd)] = 1
            order.append(nd)
        elif not proc:
            stack.append((nd, True))
            for c in ch:
                stack.append((c, False))
        else:
            s = 0
            hc = None
            hcs = -1
            for c in ch:
                cs = size[id(c)]
                s += cs
                if cs > hcs:
                    hcs = cs
                    hc = c
            size[id(nd)] = s
            heavy[id(nd)] = hc
            order.append(nd)
    isdom = {}
    runlen = {}
    dom_kind = {"G": 0, "S": 0}
    dom_fan = {}
    best_node = None
    best_len = 0
    for nd in order:                       # 子が親より先
        ch = _children(nd)
        if ch is None:
            continue
        hc = heavy[id(nd)]
        dom = 2 * size[id(hc)] > size[id(nd)]
        isdom[id(nd)] = dom
        if dom:
            dom_kind[nd[0]] += 1
            fo = len(ch)
            dom_fan[fo] = dom_fan.get(fo, 0) + 1
            rl = 1 + (runlen.get(id(hc), 0) if isdom.get(id(hc), False) else 0)
        else:
            rl = 0
        runlen[id(nd)] = rl
        if rl > best_len:
            best_len = rl
            best_node = nd
    chain = []
    nd = best_node
    while nd is not None and isdom.get(id(nd), False) and len(chain) < best_len:
        chain.append((nd[0], size[id(nd)], len(_children(nd))))
        nd = heavy[id(nd)]
    return {"n_dom": dom_kind["G"] + dom_kind["S"], "dom_kind": dom_kind,
            "dom_fan": dom_fan, "max_chain": best_len, "chain": chain}


def dump_typed(root, fh):
    """全ノードを path<TAB>kind<TAB>atom で書く(kind∈{G,S,L}; atom は L のみ GFA node-id, 他は空)。
    path は tree_stats と同一(1-based 子番号 ':' 連結, root は '0')。種別付き再レイヤリング/レイアウト
    整合解析用(atom で葉→座標を join できる)。"""
    stack = [(root, [])]
    while stack:
        node, path = stack.pop()
        p = ":".join(map(str, path)) if path else "0"
        if node[0] == "L":
            fh.write(f"{p}\tL\t{node[1]}\n")
        else:
            fh.write(f"{p}\t{node[0]}\t\n")
            children = node[1] if node[0] == "G" else node[2]
            for i, c in enumerate(children, 1):
                stack.append((c, path + [i]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gfa", default=None,
                    help="povu をかけた元 GFA(pvst と同じ node-id 空間; compact 不可)。"
                         "--distill 指定時は不要")
    ap.add_argument("--distill", default=None,
                    help="distill_gfa.py 出力ディレクトリ(GFA テキストの代わりに配列を読む)。"
                         "内部 id は dense(chr22 は identity ゆえ元 GFA と bit-identical)")
    ap.add_argument("--pvst", nargs="+", required=True)
    ap.add_argument("--B", type=int, default=10, help="1回展開の最大子数(既定10)")
    ap.add_argument("--min-comp", type=int, default=1000,
                    help="major(本体)成分のしきい値 τ(GFAノード数)。これ未満の成分は debris bin(§8)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--small-cutoff", type=int, default=0,
                    help="LOD② small-n cutoff: n<=この値の小集合は Infomap を省き座標チャンクで "
                         "B 分割(既定0=無効=bit-identical)。tiny-Infomap 連鎖・深さを削る。目安 2*B")
    ap.add_argument("--large-cutoff", type=int, default=0,
                    help="LOD③ large-n cutoff: n>=この値の巨大集合(巨大バブル)は Infomap を省き "
                         "座標チャンクで B 分割(既定0=無効)。App B 律速の巨大 Infomap と深い "
                         "peel-chain を潰す。目安 数千")
    ap.add_argument("--chain-ratio", type=float, default=0.0,
                    help="chain-aware 分割: 誘導グラフが線形(無向辺数<=ratio*n=連続バブル)なら "
                         "Infomap を省き posf(ゲノム順)で B 分割(既定0=無効)。size でなく線形性で "
                         "発火し tangle を誤爆しない。巨大な直列チェーン対策。推奨 1.2")
    ap.add_argument("--nsplit", type=int, default=6)
    ap.add_argument("--no-meta", action="store_true",
                    help="reduce_to_B の preferred-number Infomap 再クラスタ段を無効化(coalesce のみ)")
    ap.add_argument("--threads", type=int, default=1,
                    help="OMP_NUM_THREADS(既定1=bit再現)")
    ap.add_argument("--edge-weight", choices=["mult", "hap"], default="hap",
                    help="App A 商辺の重み: hap=PanSN-aware 相異ハプロタイプ数(既定; 参照も通常ハプロとして計数) / "
                         "mult=L行多重度(旧・比較用)")
    ap.add_argument("--out", default=None, help="葉(path<TAB>node)出力先(省略で書かない)")
    ap.add_argument("--tail-analysis", action="store_true",
                    help="dominant 鎖(半減の尾)を種別(G=Infomap/S=バブル)で解剖して報告")
    ap.add_argument("--dump-typed", default=None,
                    help="全ノードを path<TAB>kind(G/S/L)で出力(種別付き再レイヤリング用)")
    args = ap.parse_args()

    if not args.gfa and not args.distill:
        ap.error("--gfa か --distill のどちらかが必要")

    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    sys.setrecursionlimit(1 << 21)
    t0 = time.time()

    M = ExpandModel(args.gfa, args.pvst, nsplit=args.nsplit, distill=args.distill)
    N = M.N

    log("build super map (node -> layer0 unit)")
    super_of, nsuper, l0 = build_super_map(M)
    log(f"layer0 supernodes = {nsuper}")

    log("build quotient graph")
    w, miss, n_self = build_quotient(args.gfa, super_of, distill=args.distill)
    edge_hapw = None
    if args.edge_weight == "hap":
        # App A(super-edge 再重み) と App B(生edge hapw) を融合1パスで同時計算。
        # 旧 build_quotient_hap + build_edge_hapw を2回走査していたのを1回に。出力は厳密一致
        # (chr22 で w/edge_w とも dict== 検証済; verify_fuse_chr22.py)。GFA 読み+parse を半減。
        from infomap_supernode import build_quotient_hap_and_edgew
        w, npath, nhap, edge_hapw, _nh = build_quotient_hap_and_edgew(
            args.gfa, super_of, set(w.keys()), floor=1, distill=args.distill)
        log(f"edge-weight=hap: App A/B 融合1パス — quotient reweighted (paths={npath} "
            f"distinct-haplotypes(PanSN-aware)={nhap}, {len(w)} edges in-place, floor=1)")
        log(f"edge-weight=hap: App B 用 per-edge hapw = {len(edge_hapw)} raw edges "
            f"(融合1パスで同時計算; GFA/parse 2走査→1走査, App B は辞書引きのみ)")
    adj = defaultdict(list)
    for (a, b), c in w.items():
        adj[a].append((b, float(c)))
        adj[b].append((a, float(c)))
    log(f"quotient edges = {len(w)} (self={n_self}, unmapped={miss})")

    log("node -> top-level flubble")
    top = compute_top(M)
    nodes_by_topflub = defaultdict(list)
    for nd, f in M.claim.items():
        nodes_by_topflub[int(top[f])].append(nd)
    for nd, f in M.boundary_owner.items():
        nodes_by_topflub[int(top[f])].append(nd)

    # ---- §8: 連結成分の分類(major=本体 / debris=孤立ノード・微小成分) ----
    qei = np.fromiter((a for (a, b) in w.keys()), np.int64, len(w))
    qej = np.fromiter((b for (a, b) in w.keys()), np.int64, len(w))
    sup_lab = labels_from_edges(nsuper, qei, qej)
    snsize = np.bincount([super_of[nd] for nd in super_of], minlength=nsuper)
    cls = classify_labels(sup_lab, tau=args.min_comp, weight=snsize)
    major_super = [j for j in range(nsuper) if cls.is_major_elem[j]]
    debris_by_comp = defaultdict(list)
    for j in range(nsuper):
        if not cls.is_major_elem[j]:
            debris_by_comp[int(sup_lab[j])].append(j)
    log(f"components: major={cls.n_major}(supernodes={len(major_super)}) "
        f"debris={cls.n_debris}(supernodes={nsuper-len(major_super)}) τ={args.min_comp}")

    astats = Stats()
    adjf = lambda a: adj.get(a, ())
    posf = lambda a: a
    exp = BubbleExpander(M, B=args.B, seed=args.seed, use_meta=not args.no_meta,
                        edge_hapw=edge_hapw, small=args.small_cutoff, large=args.large_cutoff,
                        chain_ratio=args.chain_ratio)

    # ---- App A: 商グラフ divisive(major supernode 限定; debris は別 bin) + 合成 ----
    if major_super:
        log(f"App A: divisive on major quotient (supernodes={len(major_super)}, B={args.B}) ...")
        appA = divisive_build(major_super, adjf, posf, args.B, stats=astats,
                              seed=args.seed, use_meta=not args.no_meta,
                              small=args.small_cutoff, large=args.large_cutoff,
                              chain_ratio=args.chain_ratio)
        ainfo = tree_stats(appA)
        log(f"App A done: leaves={ainfo['n_leaf']}/{len(major_super)} "
            f"maxfan={ainfo['max_fanout']} depth={ainfo['depth']} "
            f"infomap={astats.n_infomap} positional={astats.n_positional} "
            f"smallcut={astats.n_smallcut} largecut={astats.n_largecut} "
            f"chain={astats.n_chain}(maxn={astats.max_chain_n}) "
            f"reduce={astats.n_reduce} infomap_time={astats.infomap_time:.1f}s")
        log("App B: expand bubbles + compose (major) ...")
        major_root = exp.compose(appA, l0, nodes_by_topflub)
    else:
        major_root = None

    # ---- debris bin: 1成分=1サブツリー → strip_group で fan-out<=B に束ね ----
    if debris_by_comp:
        comp_trees = []
        for cid in sorted(debris_by_comp, key=lambda c: min(debris_by_comp[c])):
            supers = debris_by_comp[cid]
            t = divisive_build(supers, adjf, posf, args.B, stats=astats,
                               seed=args.seed, use_meta=not args.no_meta,
                               small=args.small_cutoff, large=args.large_cutoff,
                               chain_ratio=args.chain_ratio)
            comp_trees.append(exp.compose(t, l0, nodes_by_topflub))
        debris_root = exp.strip_group(comp_trees)
        log(f"debris bin: {len(comp_trees)} components → strip_group")
    else:
        debris_root = None

    if major_root is not None and debris_root is not None:
        root = ("G", [major_root, debris_root])     # 最上位=[本体, debris bin]
    else:
        root = major_root if major_root is not None else debris_root
    log(f"App B done: bubbles_expanded={exp.n_bubble} big(>B direct)={exp.n_bubble_big} "
        f"max_raw_direct_children={exp.max_direct_children} "
        f"infomap(appB)={exp.dstats.n_infomap} positional={exp.dstats.n_positional} "
        f"smallcut={exp.dstats.n_smallcut} largecut={exp.dstats.n_largecut} "
        f"chain={exp.dstats.n_chain}(maxn={exp.dstats.max_chain_n}) "
        f"infomap_time={exp.dstats.infomap_time:.1f}s")

    info = tree_stats(root)

    if args.out:
        with open(args.out, "w") as o:
            for path, nd in info["lines"]:
                o.write(f"{path}\t{nd}\n")

    B = args.B
    print(f"\n=== 統一 LOD 木 (App A + App B, B={B}) ===")
    print(f"GFA nodes (N)        = {N}")
    print(f"leaves (GFA nodes)   = {info['n_leaf']} "
          f"({'OK ==N' if info['n_leaf'] == N else 'NG !=N'})")
    print(f"internal nodes       = {info['n_internal']}")
    print(f"max fan-out (全階層) = {info['max_fanout']}  "
          f"({'OK <=' + str(B) if info['max_fanout'] <= B else 'VIOLATION'})")
    print(f"depth                = {info['depth']}")
    print(f"max raw direct-children of a bubble (縮約前, 旧fan-out相当) = "
          f"{exp.max_direct_children}  -> 縮約後は max fan-out {info['max_fanout']}")
    print(f"bubbles expanded     = {exp.n_bubble}  (>B direct → divisive: {exp.n_bubble_big})")
    print(f"infomap calls        = App A {astats.n_infomap} + App B {exp.dstats.n_infomap}")
    lv = info["level_nodes"]
    print("per-level node count  = " +
          ", ".join(f"L{d}:{lv[d]}" for d in sorted(lv)))
    fh = info["fanout_hist"]
    print("fan-out histogram     = " +
          ", ".join(f"{k}:{fh[k]}" for k in sorted(fh)))
    if args.tail_analysis:
        log("tail analysis: dominant 鎖を種別(G/S)で解剖 ...")
        ta = tail_analysis(root)
        dk = ta["dom_kind"]
        print(f"\n=== dominant 鎖の種別解剖(半減の尾の正体) ===")
        print(f"dominant nodes       = {ta['n_dom']}  "
              f"(G=Infomap {dk['G']}, S=バブル {dk['S']})")
        print("dominant fan-out hist = " +
              ", ".join(f"{k}:{ta['dom_fan'][k]}" for k in sorted(ta['dom_fan'])))
        print(f"longest dominant chain = {ta['max_chain']}  "
              f"(heavy child 連鎖=半減で1層に半分しか解けない spine の深さ)")
        ch = ta["chain"]
        ns = sum(1 for k, _, _ in ch if k == "S")
        ng = sum(1 for k, _, _ in ch if k == "G")
        print(f"  最長鎖の種別内訳     = S(バブル) {ns} / G(Infomap) {ng} of {len(ch)}")
        print(f"  最長鎖 (kind,size,fanout) 先頭12 = {ch[:12]}")

    if args.dump_typed:
        log(f"dump typed tree (path<TAB>kind) -> {args.dump_typed}")
        with open(args.dump_typed, "w") as fh:
            dump_typed(root, fh)
        print(f"wrote typed tree {args.dump_typed}")

    if args.out:
        print(f"wrote {args.out}")
    print(f"total {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
