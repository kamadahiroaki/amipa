#!/usr/bin/env python3
"""balanced_expand.py — 「合理的な階層化を保証する」展開木を構築し最大depthを計測する。

方針(2 つの不変条件):
  (1) 連続flubble(sink==次のsource を共有する兄弟チェーン; 間の素ノードも含む)を擬似入れ子の
      スーパーノードに束ね、展開時は累積子孫ノード数で「約4分割」する(横幅 ~1/4/層)。
      ※真の入れ子(親子)ではなく兄弟チェーンである点に注意。
  (2) flubble F の1回展開で「露出要素の最大子孫ノード数 ≤ D(F)/2」になるよう、閾値 D(F)/2 を
      超える子は同じレイヤ内で複数段まとめて再展開(=単一子テレスコープを一気に開く)。
      → 1展開で最大要素が半減 → 深さ ≤ log2(N) を保証。

本スクリプトは「毎レイヤ全展開」した時の最大depthとレイヤ毎要素数(=上昇ペース)を計測する。
実際の階層決定(選択的展開)は後段(phaseb_layers.py が ExpandModel を import して使う)。

unit 表現: (0,nodeid)=葉ノード / (1,F)=flubble / (2,members_list,D)=連続群。
"""
import argparse
import bisect
import os
import sys
import time
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bubble_membership import parse_pvst, compute_depth

OR = {"+": 1, "-": 0}


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def read_gfa(path):
    """S/L を読み、無向隣接 nadj と有向 sideadj((node,end)->neighbors) を返す。"""
    nadj = defaultdict(list)
    sideadj = defaultdict(list)
    nodes = set()
    with open(path) as f:
        for line in f:
            c = line[0]
            if c == "S":
                p = line.split("\t")
                nodes.add(int(p[1]))
            elif c == "L":
                p = line.split("\t")
                a_, oa, b_, ob = int(p[1]), p[2], int(p[3]), p[4]
                nadj[a_].append(b_)
                nadj[b_].append(a_)
                aex = 1 if oa == "+" else 0          # a の出口側 end
                ben = 0 if ob == "+" else 1          # b の入口側 end
                sideadj[(a_, aex)].append(b_)
                sideadj[(b_, ben)].append(a_)
    return nodes, nadj, sideadj


def read_distill(distill):
    """distill_gfa.py 出力の S/L 配列(dense id, file order)から read_gfa と同一の
    (nodes, nadj, sideadj) を作る。GFA テキストを走査しない版。

    l_oa/l_ob は distill 規約(1=`+`, 0=`-`)。read_gfa の aex/ben を配列で再現し、
    append 順は L 行 file order = 配列 index 順ゆえ nadj/sideadj のリストまで byte 一致。
    id は dense(chr22 は identity ゆえ元 id と同値)。"""
    s_id = np.load(os.path.join(distill, "s_id.npy"))
    l_a = np.load(os.path.join(distill, "l_a.npy"))
    l_b = np.load(os.path.join(distill, "l_b.npy"))
    l_oa = np.load(os.path.join(distill, "l_oa.npy"))
    l_ob = np.load(os.path.join(distill, "l_ob.npy"))
    nodes = set(int(x) for x in s_id)
    nadj = defaultdict(list)
    sideadj = defaultdict(list)
    la = l_a.tolist(); lb = l_b.tolist()
    loa = l_oa.tolist(); lob = l_ob.tolist()
    for i in range(len(la)):
        a_ = la[i]; b_ = lb[i]
        nadj[a_].append(b_)
        nadj[b_].append(a_)
        aex = 1 if loa[i] else 0                     # a の出口側 end(1=`+`)
        ben = 0 if lob[i] else 1                      # b の入口側 end
        sideadj[(a_, aex)].append(b_)
        sideadj[(b_, ben)].append(a_)
    return nodes, nadj, sideadj


def flood_claim(A, Z, AS, ZS, depth, nadj, sideadj, leak_cap=200000):
    """深さ降順の有界フラッドで各ノードを deepest flubble に claim。
    返り値: claim(node->F), n_members(F), leak(F)。"""
    F = A.size
    claim = {}
    n_members = np.zeros(F, np.int64)
    leak = np.zeros(F, np.int8)
    order = np.argsort(-depth)
    for fi in order:
        a_, z_ = int(A[fi]), int(Z[fi])
        aex = 1 if AS[fi] == "+" else 0
        seen = set()
        stack = [s for s in sideadj.get((a_, aex), ())
                 if s != a_ and s != z_ and s not in claim]
        capped = False
        while stack:
            u = stack.pop()
            if u in seen:
                continue
            seen.add(u)
            if len(seen) > leak_cap:
                capped = True
                break
            for v in nadj.get(u, ()):
                if v == a_ or v == z_ or v in claim or v in seen:
                    continue
                stack.append(v)
        if capped:
            leak[fi] = 1
            continue
        for u in seen:
            claim[u] = fi
        n_members[fi] = len(seen)
    return claim, n_members, leak


class ExpandModel:
    """GFA + povu PVST から balanced expansion の unit 操作を提供する。

    主な属性: nodes, N, A/Z/AS/ZS, kids, root_children, depth, claim, leak,
              direct_leaves, pure_backbone, ndesc, half, nsplit。
    主なメソッド: D_of/ports_of/expandable/group_consecutive/four_split/
                 raw_expand/expand_once/root_children_units。
    """

    def __init__(self, gfa, pvst_list, half=0.5, nsplit=4, leak_cap=200000,
                 verbose=True, distill=None):
        self.half = half
        self.nsplit = nsplit
        self.verbose = verbose

        self._log("parse pvst")
        A, Z, AS, ZS, kids, root_children = parse_pvst(list(pvst_list))
        F = A.size
        depth, parent = compute_depth(F, kids, root_children)
        self._log(f"flubbles={F} max_nesting_depth={int(depth.max()) if F else 0} "
                  f"root_children={len(root_children)}")
        self.A, self.Z, self.AS, self.ZS = A, Z, AS, ZS
        self.kids, self.root_children = kids, root_children
        self.depth, self.parent, self.F = depth, parent, F

        if distill is not None:
            self._log(f"read distill S/L arrays ({distill})")
            nodes, nadj, sideadj = read_distill(distill)
        else:
            self._log("read gfa")
            nodes, nadj, sideadj = read_gfa(gfa)
        self.nodes, self.nadj, self.sideadj = nodes, nadj, sideadj
        self.N = len(nodes)
        self._log(f"nodes={self.N} edges(adj built)")

        self._log("bounded flood (deepest-first)")
        claim, n_members, leak = flood_claim(A, Z, AS, ZS, depth, nadj, sideadj,
                                             leak_cap)
        self.claim, self.n_members, self.leak = claim, n_members, leak
        self._log(f"claimed={len(claim)} leaks={int(leak.sum())}")

        # direct_leaves[F] = このflubbleが deepest claim した素ノード列
        direct_leaves = defaultdict(list)
        for u, fi in claim.items():
            direct_leaves[fi].append(u)
        claimed_set = set(claim.keys())
        unclaimed = [u for u in nodes if u not in claimed_set]
        self._log(f"unclaimed (backbone/boundary nodes)={len(unclaimed)}")

        # 境界ノードの二重表現を解消: 未claim な flubble 境界(a/z)は、その flubble の
        # owned-leaf に1回だけ計上(展開時に枠として露出)。どの flubble 境界でもない
        # 未claim ノードのみ「純背骨ノード」として単独 leaf にする。
        boundary_owner = {}
        for fi in range(F):
            for nd in (int(A[fi]), int(Z[fi])):
                if nd not in claimed_set and nd not in boundary_owner:
                    boundary_owner[nd] = fi
        for nd, fi in boundary_owner.items():
            direct_leaves[fi].append(nd)
        pure_backbone = [u for u in unclaimed if u not in boundary_owner]
        self.direct_leaves = direct_leaves
        self.boundary_owner = boundary_owner
        self.pure_backbone = pure_backbone
        self._log(f"boundary-owned={len(boundary_owner)} "
                  f"pure_backbone={len(pure_backbone)}")

        # ndesc[F] = 部分木の内部メンバ総数(深さ降順=子が先に確定; owned境界含む)
        ndesc = np.zeros(F, np.int64)
        for fi in np.argsort(-depth):
            s = len(direct_leaves.get(fi, ()))
            for c in kids[fi]:
                s += ndesc[c]
            ndesc[fi] = s
        self.ndesc = ndesc
        rc_sum = sum(int(ndesc[c]) for c in root_children)
        self._log(f"ndesc[root_children] sum={rc_sum} + pure_backbone "
                  f"{len(pure_backbone)} = {rc_sum+len(pure_backbone)} "
                  f"(==N? {self.N})")

    def _log(self, *a):
        if self.verbose:
            log(*a)

    # ---- unit 操作 ----
    def ports_of(self, u):
        t = u[0]
        if t == 0:
            return (u[1], u[1])
        if t == 1:
            c = u[1]
            return (int(self.A[c]), int(self.Z[c]))
        mem = u[1]
        return (self.ports_of(mem[0])[0], self.ports_of(mem[-1])[1])

    def D_of(self, u):
        t = u[0]
        if t == 0:
            return 1
        if t == 1:
            return int(self.ndesc[u[1]])
        return u[2]

    def expandable(self, u):
        t = u[0]
        if t == 0:
            return False
        if t == 1:
            c = u[1]
            # ndesc==0 の空flubble(内部も境界も他に claim 済み)は中身ゼロ＝展開不可。
            # leak は「自分の内部 flood を打ち切った」印に過ぎず(漏れた内部は pure_backbone
            # に計上済)、子を通じた展開はできる→ leak で展開を止めない。
            if self.ndesc[c] == 0:
                return False
            return len(self.direct_leaves.get(c, ())) > 0 or len(self.kids[c]) > 0
        return True  # grp は必ず >=2 メンバ

    # ---- 連続チェーン抽出(位置=トポロジカルID順 + 接続チェック) ----
    def _connected(self, x_exit, e_next):
        if x_exit == e_next:
            return True
        if e_next in self.nadj.get(x_exit, ()):
            return True
        if x_exit in self.nadj.get(e_next, ()):
            return True
        return False

    def _chain(self, units, reverse):
        """単方向の連続チェーン化。reverse=False は source(A) 昇順で「前の sink(Z) →
        次の source(A)」を繋ぐ(=現行)。reverse=True は source 降順で同じ接続規則を使い、
        source-id > sink-id の逆向きチェーン(MC 等で頻出)を traversal 順に畳む。
        strip のメンバ順は必ず traversal 順(entry→exit)になるので ports_of/four_split が整合。"""
        if len(units) <= 1:
            return list(units)
        order = sorted(units, key=lambda u: self.ports_of(u)[0], reverse=reverse)
        result = []
        cur = [order[0]]
        cur_exit = self.ports_of(order[0])[1]
        for u in order[1:]:
            e = self.ports_of(u)[0]
            if self._connected(cur_exit, e):
                cur.append(u)
            else:
                result.append(cur)
                cur = [u]
            cur_exit = self.ports_of(u)[1]
        result.append(cur)
        out = []
        for ch in result:
            if len(ch) == 1:
                out.append(ch[0])
            else:
                out.append((2, ch, sum(self.D_of(m) for m in ch)))
        return out

    def group_consecutive(self, units):
        """向き対応の2パス連続チェーン化。
        パス1: 順向き(source 昇順)=現行と完全一致。
        パス2: パス1 で単独のまま残ったユニットだけを逆向きに連鎖化し、元の位置へ差し込む。
        逆向き連鎖が生じなければパス1 の結果をそのまま返す(=完全 no-op; 順向きグラフ不変)。"""
        n = len(units)
        if n <= 1:
            return list(units)
        g1 = self._chain(units, reverse=False)
        singles = [u for u in g1 if u[0] != 2]
        if len(singles) <= 1:
            return g1
        rev = self._chain(singles, reverse=True)
        absorbed = {}                     # id(member) -> 逆向き strip
        for gu in rev:
            if gu[0] == 2:
                for m in gu[1]:
                    absorbed[id(m)] = gu
        if not absorbed:
            return g1                      # 逆向き連鎖なし → 完全 no-op
        out, emitted = [], set()
        for u in g1:
            if u[0] == 2:
                out.append(u)
                continue
            st = absorbed.get(id(u))
            if st is None:
                out.append(u)
            elif id(st) not in emitted:    # 逆向き strip は最初に現れたメンバ位置へ1回だけ
                out.append(st)
                emitted.add(id(st))
        return out

    # ---- 連続チェーンを累積Dで約 nsplit 分割(できるだけ均等) ----
    def four_split(self, members):
        NSPLIT = self.nsplit
        k = len(members)
        if k <= NSPLIT:
            return list(members)
        Ds = [self.D_of(m) for m in members]
        tot = sum(Ds)
        # prefix[i] = 先頭 i 要素の D 合計。各 j について prefix>= j*tot/NSPLIT の
        # 最小 index を切れ目に。巨大メンバ偏在で切れ目が作れない時は個数中央で必ず分割
        # (進捗保証=無限ループ防止)。
        prefix = [0.0] * (k + 1)
        for i in range(k):
            prefix[i + 1] = prefix[i] + Ds[i]
        cuts = set()
        if tot > 0:
            for j in range(1, NSPLIT):
                c = bisect.bisect_left(prefix, j * tot / NSPLIT)
                if 0 < c < k:
                    cuts.add(c)
        if not cuts:
            cuts.add(k // 2)            # フォールバック: 個数で半分(必ず2塊以上)
        bounds = [0] + sorted(cuts) + [k]
        out = []
        for s, e in zip(bounds[:-1], bounds[1:]):
            ch = members[s:e]
            if len(ch) == 1:
                out.append(ch[0])
            else:
                out.append((2, ch, sum(self.D_of(m) for m in ch)))
        return out

    def raw_expand(self, u):
        t = u[0]
        if t == 1:
            c = u[1]
            # 中身ゼロの空flubble(ndesc==0)は子として出さない=phantom super を排除。
            child_units = [(0, x) for x in self.direct_leaves.get(c, ())] + \
                          [(1, k) for k in self.kids[c] if self.ndesc[k] > 0]
            return self.group_consecutive(child_units)
        if t == 2:
            return self.four_split(u[1])
        return [u]  # node: stays

    def expand_once(self, u):
        """1 レイヤ展開(半減則: 露出要素が D(u)*HALF を超える間まとめて再展開)。"""
        thr = self.D_of(u) * self.half
        frontier = self.raw_expand(u)
        it = 0
        while True:
            it += 1
            if it > 2000:
                log(f"RUNAWAY expand_once it={it} D(u)={self.D_of(u)} thr={thr} "
                    f"len(frontier)={len(frontier)} "
                    f"sample={[(w[0], self.D_of(w)) for w in frontier[:8]]}")
                raise SystemExit("runaway")
            changed = False
            newf = []
            for w in frontier:
                if self.expandable(w) and self.D_of(w) > thr:
                    newf.extend(self.raw_expand(w))
                    changed = True
                else:
                    newf.append(w)
            frontier = newf
            if not changed:
                break
        return frontier

    def root_children_units(self):
        cu = [(0, x) for x in self.pure_backbone] + \
             [(1, c) for c in self.root_children if self.ndesc[c] > 0]
        return self.group_consecutive(cu)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gfa", required=True)
    ap.add_argument("--pvst", nargs="+", required=True)
    ap.add_argument("--half", type=float, default=0.5,
                    help="入れ子展開の閾値割合(既定0.5=半減)")
    ap.add_argument("--nsplit", type=int, default=4,
                    help="連続チェーンの分割数(既定4)")
    ap.add_argument("--leak-cap", type=int, default=200000)
    ap.add_argument("--trace", action="store_true",
                    help="最深 lineage の各層を flubble-open / chain-split で分解表示")
    args = ap.parse_args()

    t0 = time.time()
    M = ExpandModel(args.gfa, args.pvst, half=args.half, nsplit=args.nsplit,
                    leak_cap=args.leak_cap)
    N = M.N

    log("BFS full-expansion ...")
    # layer 1: root を展開した直後(=root_children_units)を layer1 とする。
    frontier = M.root_children_units()
    layers = []  # (layer, n_units, n_super, n_leaf, max_child_D)
    layer = 1
    MAXIT = 200
    while True:
        n_units = len(frontier)
        n_leaf = sum(1 for u in frontier if u[0] == 0)
        n_super = n_units - n_leaf
        maxD = max((M.D_of(u) for u in frontier), default=0)
        n_exp = sum(1 for u in frontier if M.expandable(u))
        layers.append((layer, n_units, n_super, n_leaf, maxD))
        log(f"  layer {layer}: units={n_units} super={n_super} leaf={n_leaf} "
            f"expandable={n_exp} maxD={maxD}")
        # 展開可能な unit が尽きたら終了(空flubble等の非展開superが残っても止まる)。
        if n_exp == 0:
            break
        newf = []
        for u in frontier:
            if M.expandable(u):
                newf.extend(M.expand_once(u))
            else:
                newf.append(u)
        frontier = newf
        layer += 1
        if layer > MAXIT:
            log("WARN: hit MAXIT")
            break

    max_depth = layers[-1][0]
    final_leaf = layers[-1][3]
    print("\n=== balanced expansion: レイヤ毎の要素数(毎レイヤ全展開) ===")
    print(f"{'layer':>5} {'units':>9} {'super':>9} {'leaf':>9} {'max_childD':>11}")
    for (l, nu, ns, nl, md) in layers:
        print(f"{l:>5} {nu:>9} {ns:>9} {nl:>9} {md:>11}")
    print(f"\n最大depth={max_depth}  最終leaf={final_leaf} "
          f"(N={N}, 一致={'OK' if final_leaf==N else 'NG'})")
    print(f"理論上限 log2(N)/log({int(1/M.half)})≈{np.log2(N):.1f} (half), "
          f"log{M.nsplit}(N)≈{np.log(N)/np.log(M.nsplit):.1f} (chain)")

    if args.trace:
        # 最深 lineage を再帰DFSで求め、各層を「flubble-open(nest深さ)」「chain-split(長さ)」に分解。
        log("trace deepest lineage ...")
        sys.setrecursionlimit(1 << 20)

        def deepest(u):
            if not M.expandable(u):
                return (0, [])
            ch = M.expand_once(u)
            best = (-1, [])
            for c in ch:
                d, p = deepest(c)
                if d > best[0]:
                    best = (d, p)
            if u[0] == 1:
                fi = u[1]
                kind = f"open  flubble F{fi} (nest depth {int(M.depth[fi])})"
            elif u[0] == 2:
                kind = f"split chain (members {len(u[1])})"
            else:
                kind = "node"
            return (1 + best[0], [(kind, M.D_of(u), len(ch))] + best[1])

        best = (-1, [])
        for r in M.root_children_units():
            d, p = deepest(r)
            if d > best[0]:
                best = (d, p)
        n_open = sum(1 for (k, _, _) in best[1] if k.startswith("open"))
        n_split = sum(1 for (k, _, _) in best[1] if k.startswith("split"))
        print(f"\n=== 最深 lineage の分解 (全 {len(best[1])} 層: "
              f"open={n_open}, chain-split={n_split}) ===")
        for i, (kind, D, nc) in enumerate(best[1], 1):
            print(f"  step{i:>2}: {kind:<40} D={D:<7} -> {nc} children")

    log(f"done {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
