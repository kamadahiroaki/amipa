#!/usr/bin/env python3
"""relayer_budget.py — 予算駆動・可変比(上細下粗)の LOD 再レイヤリング。

背景([[unified-tree-layered-db-leaf-persist]] / 会話 2026-07-03続3):
viewer では layer⊥camera を分離し「グリフの画面サイズ」で層を自動選択する(A)。全体図では
おおまかな形が見たいのでグリフ多め・詳細図では正確な結線が見たいのでグリフ少なめ ⇒ 画面内
グリフ数は緩やかに減る V(z) が自然。この設計に合う層スケジュールは:

  - 上(全体側)は細かく刻む(層あたり比 r≈r_min): 全体像を滑らか&豊かに。安い(グリフ少)。
  - 下(詳細側)は粗く刻む(層あたり比 r≈r_max): 大 pop を許容(正確さ優先)。高い層(グリフ多)を間引く。

旧 kindaware の「各層で全フロンティアを一律展開」だと成長が前倒し(chr22 で先頭15×→末尾1.18×)
= 欲しい形と真逆で viewer が破綻したため廃止した。ここでは代わりに
**部分木サイズ(=配下葉数)の閾値カット**で層を定義する:

  層 L の分割 = frontier(θ_L) = 「size(v) <= θ_L かつ size(parent(v)) > θ_L」なる v の集合(＋葉)。
  θ_L を θ_0 > θ_1 > ... > θ_M=1 と単調減少に選び、各層のグリフ数 count(θ_L) を目標 T_L に合わせる。

θ を単調減少にとるので、各ノード v の在圏層は連続区間 [birth,death) になる:
  birth[v] = θ_L < size(parent(v)) となる最初の層(root は birth=0)
  death[v] = θ_L < size(v)         となる最初の層(葉は size=1 ⇒ death=M+1 で最下層まで永続)
これは leaf-persistence の一般化: 途中で細分されない粗いクラスタは複数層に同じグリフで在圏し続ける。
{v: birth<=L<death} は frontier(θ_L) に厳密一致するので各層は完全分割(Σcoverage=N)。

目標サイズ T_L はボトムアップ構築(下ほど大比):
  T=[N]; r=r_max; while T[0]>floor: T.insert(0, ceil(T[0]/r)); r=max(r_min, r*shrink)
→ 最下段の比が最大(r_max, 粗い pop)・上段ほど比が小(r_min, 細かい)= 上細下粗。

戻り値: (nl, per, birth, death)。per[L]=count(θ_L)=各層グリフ数(=viewer の per-layer nominal scale)。
"""
import argparse
import time
from array import array

import numpy as np

from relayer_halve import csr_children, subtree_size, log
from relayer_common import build_typed


def _targets(N, floor, r_min, r_max, shrink):
    """目標グリフ数列 T_0<...<T_M=N をボトムアップに構築(下ほど大比=上細下粗)。"""
    T = [int(N)]
    r = float(r_max)
    while T[0] > floor:
        nxt = int(np.ceil(T[0] / r))
        if nxt < 1:
            nxt = 1
        if nxt >= T[0]:                       # 比が緩すぎて進まない保険
            nxt = T[0] - 1
        T.insert(0, nxt)
        r = max(r_min, r * shrink)
        if T[0] <= 1:
            break
    return T


def relayer_budget(parent_np, size_np, floor=1000, r_min=2.0, r_max=2.5, shrink=0.8,
                   weight_np=None):
    """予算駆動・可変比の層化。parent_np/size_np(np.int) から (nl, per, birth, death)。
    birth/death は array('i')(在圏区間 [birth,death); birth=-1 は非出現ノード)。

    weight_np を与えると層カットの key を size でなくこの重みで行う(既定=size)。空間スパンで
    嵩上げした重み max(size, λ·N·span/span_root) を渡すと「葉が少なく広範囲」なノードだけ
    重みが大きくなり予算カットで早期に子へ展開できる(巨大グリフの解消)。weight は tree に沿って
    単調(child<=parent)であること・葉の weight==1 であること(終端永続の担保)が前提。"""
    n = len(size_np)
    N = int(size_np[0])
    sv = (size_np if weight_np is None else weight_np).astype(np.int64)
    sp = sv[parent_np.astype(np.int64)].copy()
    sp[0] = int(sv.max()) + 1                  # root の親=∞(sentinel; weight は N を超え得る)
    sv_sorted = np.sort(sv)
    sp_sorted = np.sort(sp)

    def count(theta):
        # frontier(θ) の要素数 = #{sp>θ} - #{sv>θ}  (sv<=sp より sv>θ ⇒ sp>θ)
        a = n - int(np.searchsorted(sp_sorted, theta, "right"))   # #{sp>θ}
        b = n - int(np.searchsorted(sv_sorted, theta, "right"))   # #{sv>θ}
        return a - b

    # 目標 T_L → θ_L(count(θ)>=T を満たす最大の θ; count は θ に対し非増加)
    targets = _targets(N, floor, r_min, r_max, shrink)
    thetas = []
    for T in targets:
        lo, hi, best = 1, N, 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if count(mid) >= T:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        # θ が厳密減少になるよう調整(同 θ の層は重複なので詰める)
        if thetas and best >= thetas[-1]:
            best = thetas[-1] - 1
        if best < 1:
            break
        thetas.append(best)
    if thetas[-1] != 1:
        thetas.append(1)                       # 最下層は全葉(θ=1)を保証
    # 念のため厳密減少・>=1 に正規化
    uniq = []
    for th in thetas:
        if not uniq or th < uniq[-1]:
            uniq.append(th)
    thetas = [t for t in uniq if t >= 1]
    M = len(thetas) - 1

    birth = np.full(n, -1, np.int64)
    death = np.full(n, M + 1, np.int64)
    for L, th in enumerate(thetas):
        present = (sv <= th) & (sp > th)       # θ_L in [sv, sp)
        nb = present & (birth < 0)
        birth[nb] = L
        ref = (sv > th) & (death == M + 1)     # θ_L < sv 初出 = 細分される層
        death[ref] = L
    per = [count(th) for th in thetas]

    # ★最下層は「葉そのもの」でなければならない。
    #   frontier の条件は (sv <= θ) & (sp > θ) で、最下層は θ=1。配下の葉がちょうど 1 個の
    #   内部ノード（povu のバブルにはこれが多い）は sv==1 なのでこの条件を満たしてしまい、
    #   その中の葉は sp==1 になって **どの層にも出なくなる**（＝ビューアから到達できず、
    #   その葉のリードも塩基配列も見られない）。最下層に限って、内部ノードをその 1 葉に置き換える。
    #   個数は変わらない（どちらも葉 1 個ぶん）ので per も完全分割も保たれる。
    has_child = np.zeros(n, bool)
    if n > 1:
        has_child[parent_np[1:].astype(np.int64)] = True
    is_leaf = ~has_child
    last = M
    at_last = (birth >= 0) & (birth <= last) & (last < death)
    swap_out = at_last & ~is_leaf                 # 最下層に居る内部ノード（必ず sv==1）
    death[swap_out] = last                        # 最下層の手前で終わらせる
    swap_in = is_leaf & ((birth < 0) | (birth > last))   # どの層にも出ていなかった葉
    birth[swap_in] = last
    death[swap_in] = last + 1
    ns = int(swap_out.sum()); ni = int(swap_in.sum())
    if ns or ni:
        log(f"最下層の正規化: 内部ノード {ns:,} を葉 {ni:,} に置き換え（葉 1 個だけを包む節）")

    # 検証: 各層 present-set サイズ == per == count(θ_L)(完全分割の担保)
    for L, th in enumerate(thetas):
        pc = int(((birth >= 0) & (birth <= L) & (L < death)).sum())
        assert pc == per[L], f"layer {L}: present {pc} != per {per[L]}"
    assert per[-1] == N, f"最下層 {per[-1]} != N {N}"

    ob = array('i'); ob.frombytes(birth.astype(np.int32).tobytes())
    od = array('i'); od.frombytes(death.astype(np.int32).tobytes())
    return M + 1, per, ob, od, thetas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--typed", required=True, help="path<TAB>kind<TAB>atom(lod.py --dump-typed)")
    ap.add_argument("--floor", type=int, default=1000, help="最上層(全体図)の目標グリフ数(既定1000)")
    ap.add_argument("--rmin", type=float, default=2.0, help="上段(全体側)の層あたり比(既定2)")
    ap.add_argument("--rmax", type=float, default=2.5, help="下段(詳細側)の層あたり比(既定2.5)")
    ap.add_argument("--shrink", type=float, default=0.8, help="下→上へ比を縮める係数(既定0.8)")
    args = ap.parse_args()
    t0 = time.time()

    parent, kind, _atom = build_typed(args.typed)
    n = len(parent)
    deg, off, kids = csr_children(parent)
    size = subtree_size(parent, deg)
    parent_np = np.frombuffer(parent, np.int32)
    size_np = np.frombuffer(size, np.int32)
    N = int(size_np[0])
    log(f"loaded: nodes={n:,} N={N:,}")

    nl, per, birth, death, thetas = relayer_budget(
        parent_np, size_np, args.floor, args.rmin, args.rmax, args.shrink)
    total_rows = sum(per)                      # 内部の複数層在圏も含む総ノード行数

    print(f"\n=== 予算駆動・可変比 再レイヤリング (floor={args.floor} rmin={args.rmin} "
          f"rmax={args.rmax} shrink={args.shrink}) ===")
    print(f"nodes={n:,}  N={N:,}")
    print(f"LOD layers          = {nl}")
    print(f"per-layer glyphs    = " + ", ".join(f"L{i}:{c:,}" for i, c in enumerate(per)))
    print(f"per-layer θ (cut)   = " + ", ".join(f"L{i}:{t}" for i, t in enumerate(thetas)))
    ratios = [per[i + 1] / per[i] for i in range(len(per) - 1)]
    print(f"層あたり比(下ほど大) = " + ", ".join(f"{r:.2f}" for r in ratios))
    print(f"total node rows(Σper)= {total_rows:,}  ({total_rows / N:.2f}·N)")
    print(f"final layer glyphs  = {per[-1]:,}  ({'OK ==N' if per[-1] == N else 'NG'})")
    print(f"({time.time() - t0:.1f}s)")


if __name__ == "__main__":
    main()
