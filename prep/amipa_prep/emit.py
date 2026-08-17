#!/usr/bin/env python3
"""layout_emit_db_relayer.py — 統一 LOD 木(lod.py の *.unified.typed)を
「予算駆動の省レイヤ展開(relayer_budget)」で LOD 層に畳んでから viewer 多層 layered.db にする。

■ layout_emit_db_unified.py との違い(なぜ別スクリプトか)
  unified 版は layer = 生の tree-depth(chrY 23層 / chr22-pggb 31層)。深い木では層数が過大になり
  葉永続化で db が巨大化する(chr22-pggb で ~30GB)。本スクリプトは層を **tree-depth でなく
  relayer_budget の予算駆動フロンティア展開**で切る:
    - 各層の目標グリフ数を上細下粗の可変比で構築(floor→N まで層ごと約×2)、部分木サイズ閾値でカット
    - 層サイズが単調・滑らか(約2倍ずつ)なので viewer の LOD ズームが1段=1解像度で無理なく詳細化
  展開規則の単一情報源は bubbletools/relayer_budget.py::relayer_budget()。
  (旧 kindaware スケジュールは最上位極小層で layer_zoom が 1.0 に張り付き層スキップ・中層爆発で
   deep zoom が固まるため廃止 [[viewer-lod-use-budget-not-kindaware]]。--schedule/--kG/--kS/
   --merge-tail-frac は後方互換で受理するが無視。)

■ 葉の永続化(layout_emit_db_unified.py と同じ要件)
  各 layer は「その解像度での完全分割スナップショット」。relayer で早く終端に達した glyph
  (size==1: 真の葉 n{gfa_id}、または fan-out=1 テレスコープ内部)は、そこから最下層まで
  **同名で反復出現**して消えないようにする(db 側で複製、viewer 無改修)。
    - 非終端の内部ノード(size>1) : flayer に **1回だけ**(次層で子に展開される)。
    - 終端ノード(size==1)        : flayer .. maxlayer に **同名で永続**。

■ glyph 幾何(1点/ノードの sgdplain レイアウトから; unified 版と同じ規約)
  葉    : center=座標, radius=既定(エッジ長中央値×frac), angle=GFA 向き由来。
  内部  : center=配下葉の重心, angle=配下葉の主軸(PCA), radius=0.5×max(bbox幅,高)(下限 base_r)。
  幾何は「葉座標 → 全ノードへ depth 準 level scatter でボトムアップ集計」(O(n)・省メモリ; chr22 可)。

■ エッジ(layer 毎): GFA 辺の両端の葉を、その層の代表 glyph(frontier-parent を climb)へ写像し、
  異なる glyph の対を 1 対 1 本に集約。端点は相手 glyph 中心方向に ±radius。

入力: --typed X.unified.typed --npz X.sgdplain.npz --template <layered.db> --out-db <出力>
      [--budget-floor 1000] [--gfa X.gfa(size=bp 用)] [--radius-frac 0.25]
"""
import argparse
import itertools
import json
import os
import re
import sqlite3
import shutil
import sys
import time
from array import array

import numpy as np

# 展開規則の単一情報源(bubbletools/relayer_budget.py + relayer_common.build_typed)
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "bubbletools"))
sys.path.insert(0, _HERE)
from relayer_halve import csr_children, subtree_size            # noqa: E402
from relayer_common import build_typed                          # noqa: E402
from relayer_budget import relayer_budget                       # noqa: E402
# 崩壊アレル分離(既定 ON, --no-separate で無効化)。実装は CLI と共有 [[collapsed-allele-separation]]。
from separate_alleles import separate_collapsed       # noqa: E402


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def leaf_angles(n, xy, ei, ej, esu, esv):
    """各 npz ノードの GFA 向き由来 angle(layout_emit_db_unified.py と同一規約)。"""
    cx = xy[:, 0]; cy = xy[:, 1]
    if esu is None or esv is None:
        return np.zeros(n)
    s0x = np.zeros(n); s0y = np.zeros(n); c0n = np.zeros(n)
    s1x = np.zeros(n); s1y = np.zeros(n); c1n = np.zeros(n)
    for sval, (SX, SY, CN) in ((0, (s0x, s0y, c0n)), (1, (s1x, s1y, c1n))):
        m = (esu == sval) & (ei != ej)
        np.add.at(SX, ei[m], cx[ej[m]]); np.add.at(SY, ei[m], cy[ej[m]]); np.add.at(CN, ei[m], 1.0)
        m = (esv == sval) & (ei != ej)
        np.add.at(SX, ej[m], cx[ei[m]]); np.add.at(SY, ej[m], cy[ei[m]]); np.add.at(CN, ej[m], 1.0)
    h0 = c0n > 0; h1 = c1n > 0
    c0x = np.where(h0, s0x / np.maximum(c0n, 1), cx); c0y = np.where(h0, s0y / np.maximum(c0n, 1), cy)
    c1x = np.where(h1, s1x / np.maximum(c1n, 1), cx); c1y = np.where(h1, s1y / np.maximum(c1n, 1), cy)
    dx = np.zeros(n); dy = np.zeros(n)
    both = h0 & h1; dx[both] = c1x[both] - c0x[both]; dy[both] = c1y[both] - c0y[both]
    o1 = h1 & ~h0;  dx[o1] = c1x[o1] - cx[o1];        dy[o1] = c1y[o1] - cy[o1]
    o0 = h0 & ~h1;  dx[o0] = cx[o0] - c0x[o0];        dy[o0] = cy[o0] - c0y[o0]
    return np.where(dx * dx + dy * dy >= 1e-24, np.arctan2(dy, dx), 0.0)


def _zoom_postprocess(raw, layer_nodes, d_floor=2.0, ceil_ratio=4.0):
    """生の層別スケール s_L を viewer の閾値 f(L) へ整える（3 実装で共通）。

    ・f(0)=1 に正規化（viewer が起動時 fit ズームを乗じて絶対閾値にする）
    ・先頭の fit 群(f<=1)は overview バンドを共有
    ・隣接比を [floor_ratio, ceil_ratio] にクランプ
        floor: 空バンド防止。f(n) >= f(n-1)·max(1.10, (N_n/N_{n-1})^(1/d_floor))
        ceil : 密度ジャンプの dead-zone 防止（「ズームしても何も出ない→突然大量」を均す）
    """
    if not raw:
        return []
    s0 = raw[0] if raw[0] > 0 else 1.0
    out = [v / s0 for v in raw]
    lead = 0
    while lead < len(out) and out[lead] <= 1.0 + 1e-9:
        lead += 1
    N = layer_nodes
    for i in range(max(1, lead), len(out)):
        gr = (N[i] / N[i - 1]) ** (1.0 / d_floor) if i < len(N) and N[i - 1] > 0 else 1.0
        floor_ratio = max(1.10, gr)
        out[i] = max(out[i], out[i - 1] * floor_ratio)
        if ceil_ratio and ceil_ratio >= floor_ratio:
            out[i] = min(out[i], out[i - 1] * ceil_ratio)
    return [round(v, 6) for v in out]


def _zoom_solve_layer(x, y, W, vb, pct, samples, diag_samples, rng, workers=1, smax=4.0e6):
    """1 層の座標から s_L(=W/w*) と診断分位を厳密に解く。cKDTree の kNN 1 回だけ。

    定義: 「グリフ中心の一辺 w の正方窓に入るグリフ数の第 pct 分位 = vb」を満たす w を w* とし
          s_L = W/w*。窓内個数 = チェビシェフ距離 <= w/2 の点数なので、標本 s について
              count(s,w) >= vb  ⟺  w >= 2·h_s      (h_s = s の vb 番目に近い点までのチェビシェフ距離)
          よって 第pct分位{count} >= vb ⟺ w >= 2·第(100-pct)分位{h_s}。
          ⇒ **w* = 2·quantile_{100-pct}(h_s)** が閉じた形の厳密解（二分探索も格子も不要）。
    """
    from scipy.spatial import cKDTree
    N = int(x.size)
    if N <= vb:                                  # 層の全グリフが予算内 → fit ズームで出せる
        return 1.0, [N] * 5
    XY = np.empty((N, 2), dtype=np.float64)      # cKDTree は float64 連続配列を要求
    XY[:, 0] = x; XY[:, 1] = y
    # balanced_tree/compact_nodes=False = sliding-midpoint 分割。構築が速く(実測 4000万点 10.8s/+1.5GB)
    # クラスタ状データの範囲問い合わせにも強い。
    tree = cKDTree(XY, balanced_tree=False, compact_nodes=False)
    q = XY[rng.integers(0, N, size=min(samples, N))]   # 標本はグリフ位置=content-weighted
    h = tree.query(q, k=[max(2, int(vb))], p=np.inf, workers=workers)[0][:, 0]
    w = 2.0 * float(np.percentile(h, 100.0 - pct))
    # 縮退クランプ: 座標が完全一致するグリフが vb 個以上あると h_s=0 → w*=0（chr22 hairball の 1bp
    # ノード群）。上は全域窓を超えたら fit と同じなので W で止める。
    w = min(max(w, W / smax), W)
    # 診断分位。**標本を絞りすぎると自己検査に使えない**: chr22 は密度分布が中央値のところで
    # 崖状に跳ぶ(L4 で p25=417 / p50=2005 / p75=5,529)ため、512 標本の中央値は 2000 に対して
    # 0.5-2x ぶれる(実測。4096 標本なら 1,777-2,005 に収まり w* の正しさが見える)。
    # ただし数え上げは O(窓内個数) なので、深層では 1 標本 10 万点になり得る。パイロットで
    # 平均個数を測り、総点数が budget を超えないところまで標本を落とす(グラフに依らず有界にする)。
    DIAG_WORK = 5e8
    pilot = tree.query_ball_point(q[:128], w / 2.0, p=np.inf, return_length=True, workers=workers)
    mean_c = max(1.0, float(np.mean(pilot)))
    ns = int(min(diag_samples, len(q), max(128, DIAG_WORK / mean_c)))
    cnt = (pilot if ns <= 128 else
           tree.query_ball_point(q[:ns], w / 2.0, p=np.inf, return_length=True, workers=workers))
    diag = [int(np.percentile(cnt, p_)) for p_ in (25, 50, 75, 90, 99)]
    return W / w, diag


def world_width_from_rtree_root(cur):
    """全層の外接矩形の x 幅を **R-Tree のルートノード 1 行** から O(1) で得る。

    `MIN(xCoord-radius) FROM nodes` は全走査(WG 2億行)、`MIN(min_x) FROM nodes_rtree` は
    rtree 全走査。viewer(backend/src/routes/stats.ts)と同じくルートノード blob を読む:
      data[2:4]=セル数(BE u16)、offset 4 から 1 セル 32B = rowid(8B) + float32 BE ×6
      (min_x,max_x,min_y,max_y,min_layer,max_layer)。全セルの MBR の和が world bbox。
    """
    import struct
    row = cur.execute("SELECT data FROM nodes_rtree_node WHERE nodeno=1").fetchone()
    if not row or not row[0] or len(row[0]) < 4:
        return None
    buf = row[0]
    ncell = struct.unpack_from(">H", buf, 2)[0]
    x0, x1 = float("inf"), float("-inf")
    for i in range(ncell):
        b = 4 + i * 32
        if b + 24 > len(buf):
            break
        mn, mx = struct.unpack_from(">ff", buf, b + 8)
        x0 = min(x0, mn); x1 = max(x1, mx)
    return (x1 - x0) if x1 > x0 else None


def compute_layer_zoom_xy_db(cur, out_maxlayer, layer_nodes, vb=2000.0, pct=50.0, samples=4096,
                             diag_samples=512, d_floor=2.0, ceil_ratio=4.0, seed=20260730,
                             log_fn=None, smax=4.0e6, workers=1):
    """既存 DB を xy 法で再較正する（座標を **層ごとに 1 回だけ順次読む**）。

    emitter からは compute_layer_zoom_xy(メモリ上の座標, DB アクセス 0)を使う。こちらは
    「もう emit してしまった DB を後から較正し直す」専用。層の rowid は連続(emitter は層順に
    INSERT)なので INTEGER PK レンジ検索＝順次読みになり、rtree 版のような点引きの嵐にならない。
    コストは nodes テーブルを 1 回通読するのと同じ（WG 47GB で数十分オーダー）。
    """
    W = world_width_from_rtree_root(cur)
    if not W:
        _n0 = layer_nodes[0] if layer_nodes else 0
        r = cur.execute("SELECT MIN(xCoord-radius), MAX(xCoord+radius) FROM nodes "
                        "WHERE rowid BETWEEN 1 AND ?", (_n0,)).fetchone() if _n0 else None
        W = ((r[1] - r[0]) if r and r[0] is not None else 1.0) or 1.0
        if log_fn:
            log_fn(f"  WARN: rtree ルートから world 幅が取れず layer0 の bbox を使う (W={W:.6g})")
    rng = np.random.default_rng(seed)
    raw, diag = [], []
    lo = 1
    for L in range(out_maxlayer + 1):
        n_L = layer_nodes[L] if L < len(layer_nodes) else 0
        if n_L <= 0:
            raw.append(raw[-1] if raw else 1.0); diag.append(None); continue
        hi = lo + n_L - 1
        t = time.time()
        # 層の rowid 連続性を両端の点引きで検証（崩れていたら索引クエリへ）
        a = cur.execute("SELECT layer_index FROM nodes WHERE rowid=?", (lo,)).fetchone()
        b = cur.execute("SELECT layer_index FROM nodes WHERE rowid=?", (hi,)).fetchone()
        if a and b and a[0] == L and b[0] == L:
            it = cur.execute("SELECT xCoord, yCoord FROM nodes WHERE rowid BETWEEN ? AND ?", (lo, hi))
        else:
            if log_fn:
                log_fn(f"  WARN: L{L} の rowid が層連続でない → layer_index 索引クエリで読む")
            it = cur.execute("SELECT xCoord, yCoord FROM nodes WHERE layer_index=?", (L,))
        xy = np.fromiter((v for r_ in it for v in r_), dtype=np.float64, count=2 * n_L)
        xy = xy.reshape(n_L, 2)
        s_L, dg = _zoom_solve_layer(xy[:, 0], xy[:, 1], W, vb, pct, samples, diag_samples,
                                    rng, workers, smax)
        raw.append(s_L); diag.append(dg)
        if log_fn:
            log_fn(f"  layer_zoom L{L}: N={n_L:,} f={s_L:.6g} 窓={W/s_L:.4g} "
                   f"p25/p50/p75/p90/p99={'/'.join(str(v) for v in dg)} ({time.time()-t:.1f}s)")
        del xy
        lo = hi + 1
    return _zoom_postprocess(raw, layer_nodes, d_floor, ceil_ratio), diag


def compute_layer_zoom_xy(cx, cy, rad, born, birth, death, start, maxlayer, layer_nodes,
                          vb=2000.0, pct=50.0, samples=4096, diag_samples=512,
                          d_floor=2.0, ceil_ratio=4.0, seed=20260730, log_fn=None,
                          smax=4.0e6, workers=1):
    """viewer の層選択閾値 f(L)(layer_zoom)を **emitter がメモリに持つ座標から直接** 解く（既定）。

    ■ DB を引かないのが要点（2026-07-30）
      emitter は §7 のノード発行でまさに `cx=CX[P]; cy=CY[P]`（P=その層の在圏ノード）を書いている。
      較正に必要なのは**その同じ配列の分布統計だけ**なのに、旧実装(rtree/grid)は書き終えた DB に
      問い合わせ直していた。R-Tree 版は「250 標本×16 反復×18 層 ≈ 63,000 プローブ」で、WG では
      1 プローブが層のシェアに支配され(L17=1.1億/2億 entries なので min_layer で枝刈りできない)
      warm 90-750ms・cold 増幅で **269GB の DB に対し 27.9TB 読んで半日以上終わらなかった**。
      grid 版も層ごとに `SELECT xCoord,yCoord FROM nodes WHERE layer_index=?` で読み直していた。
      → 座標はメモリにある。**DB アクセス 0** で解く。

    ■ 二分探索も格子も不要（厳密解が閉じた形で出る）
      定義は「グリフ中心の一辺 w の正方窓に入るグリフ数の第 pct 分位 = V_render(vb)」。
      窓内個数 = チェビシェフ距離 <= w/2 の点数なので、標本 s について
          count(s,w) >= vb  ⟺  w >= 2·h_s   （h_s = s の vb 番目に近い点までのチェビシェフ距離）
      よって
          第pct分位{count(s,w)} >= vb  ⟺  w >= 2·第(100-pct)分位{h_s}
      すなわち **w* = 2·quantile_{100-pct}(h_s)** が厳密な解。k=vb の kNN 1 回で終わる
      （cKDTree, p=inf）。旧 grid 版の「格子解像度に飽和して d_floor 下限比に落ちる」も、
      旧 rtree 版の「16 反復ぶんのプローブ」も、原理的に消える。

    ■ 分位・窓の規約は rtree 版から不変
      pct=50(中央値を vb に固定)／窓は一辺 w の**正方形**(canvas 非依存)。
      stats.zoom_window='square_side_W_over_s' を viewer が自分のアスペクトで補正する。

    ■ 縮退への備え
      座標が完全一致するグリフが vb 個以上あると h_s=0 → w*=0 になるので s<=smax でクランプする
      （chr22 hairball は 1bp ノードが大量に重なる）。

    world 幅 W は **全層の外接矩形**(cx±rad の min/max)。viewer が nodes_rtree のルートノードから
    得る world bbox と同一定義。

    返り値: (layer_zoom, diag)。diag は層別の実分位 [p25,p50,p75,p90,p99]（打ち切り無しの厳密値）で、
    「このグラフはどのくらい裾が厚い＝取得の安全弁 maxRows でどのくらい上位層 fallback するか」を
    後から観測できるようにする。p50 は設計上 vb に一致するので自己検査にもなる。
    """
    b_born = birth[born]; d_born = death[born]
    _x = cx[born]; _r = rad[born]
    # world 幅 = 全層の外接矩形。viewer が nodes_rtree のルートノードから得る world bbox と同一定義。
    W = float((_x + _r).max() - (_x - _r).min()) or 1.0
    del _x, _r
    rng = np.random.default_rng(seed)
    raw, diag = [], []
    for L in range(start, maxlayer + 1):
        Lw = L - start
        P = born[(b_born <= L) & (L < d_born)]          # §7 のノード発行と同一の在圏判定
        if P.size == 0:
            raw.append(raw[-1] if raw else 1.0); diag.append(None); continue
        t = time.time()
        s_L, dg = _zoom_solve_layer(cx[P], cy[P], W, vb, pct, samples, diag_samples,
                                    rng, workers, smax)
        raw.append(s_L); diag.append(dg)
        if log_fn:
            log_fn(f"  layer_zoom L{Lw}: N={P.size:,} f={s_L:.6g} 窓={W/s_L:.4g} "
                   f"p25/p50/p75/p90/p99={'/'.join(str(v) for v in dg)} ({time.time()-t:.1f}s)")
    return _zoom_postprocess(raw, layer_nodes, d_floor, ceil_ratio), diag


def compute_layer_zoom(cur, out_maxlayer, layer_nodes, vb=1000.0, pct=95.0, grid=4096, d_floor=2.0,
                       ceil_ratio=4.0):
    """viewer の層選択閾値 f(n)(layer_zoom)を **実レイアウト座標の局所密度**から算出する。

    ■ なぜ N_n(総グリフ数)由来でなく座標由来か
      「レイアウトを見ない」f(n) は原理的に f(n)=(N_n/N0)^(1/d) の冪則一択で、自由度は仮定次元 d だけ
      (d=1≈2^n / d=2≈2^(n/2))。だが実分布はクラスタ状(pangenome は tangle/hairball に集中)で、実効次元は
      層・DB ごとに動く(chrY 2.7→1.0、chr22 は hairball で 1 未満=総数より局所密度が速く増える)。冪則の当て
      はめ誤差は chrY で ~2.6×、chr22 で ~10×。単一 d では chrY(要 d≈1.3)と chr22(要 d≈0.8)を両立できない
      → 座標から局所密度を直接測るのが唯一の正解(実測 2026-07-06)。

    ■ 定義: 各グリフを中心とする世界窓 (W/s, H/s) 内のグリフ数の第 pct 分位が予算 vb に等しくなる s を層別に
      求め、それを f(n) とする(=「その層を出し始める zoom で、密度上位(100-pct)%を除く典型ビューが vb 枚に
      収まる」)。z(=z_fit·f) が上がるほど窓が縮み画面内枚数が減る。深いほど密なので s は単調増加。
      pct=95: 上位5%の密領域は f では守り切らず、viewer の「層を変えない描画間引き(render cap)」に回す。
      hairball(chr22)は s が格子解像度(grid)に飽和 → d_floor で下限比を敷き狭義単調(空バンド化を防止)、残りは
      render cap 前提。vb は DB に焼く参照値(viewer は densityKnob で実行時スケール)。
    """
    xmn, xmx, ymn, ymx = cur.execute(
        "SELECT min(xCoord),max(xCoord),min(yCoord),max(yCoord) FROM nodes").fetchone()
    W = (xmx - xmn) or 1.0
    H = (ymx - ymn) or 1.0
    Gx = int(grid)
    Gy = max(1, int(round(Gx * H / W)))

    def solve(x, y):
        ix = np.clip(((x - xmn) / W * Gx).astype(np.int32), 0, Gx - 1)
        iy = np.clip(((y - ymn) / H * Gy).astype(np.int32), 0, Gy - 1)
        G = np.zeros((Gx, Gy)); np.add.at(G, (ix, iy), 1.0)
        II = np.zeros((Gx + 1, Gy + 1)); II[1:, 1:] = G.cumsum(0).cumsum(1)

        def pctdens(ax, ay):                    # グリフ中心窓のグリフ数の第 pct 分位
            ax = max(1, min(ax, Gx)); ay = max(1, min(ay, Gy))
            S = II[ax:, ay:] - II[:-ax, ay:] - II[ax:, :-ay] + II[:-ax, :-ay]
            ci = np.clip(ix - ax // 2, 0, S.shape[0] - 1)
            cj = np.clip(iy - ay // 2, 0, S.shape[1] - 1)
            return np.percentile(S[ci, cj], pct)

        if pctdens(Gx, Gy) <= vb:               # 全体窓でも予算内 → fit で出せる
            return 1.0
        lo, hi = 1.0, float(Gx)                  # 窓(W/s,H/s) を s∈[1,Gx] で二分探索
        for _ in range(38):
            mid = (lo * hi) ** 0.5
            if pctdens(int(round(Gx / mid)), int(round(Gy / mid))) > vb:
                lo = mid
            else:
                hi = mid
        return (lo * hi) ** 0.5

    raw = []
    for L in range(out_maxlayer + 1):
        rows = cur.execute("SELECT xCoord,yCoord FROM nodes WHERE layer_index=?", (L,)).fetchall()
        if not rows:
            raw.append(raw[-1] if raw else 1.0); continue
        xy = np.asarray(rows, float)
        raw.append(solve(xy[:, 0], xy[:, 1]))
    return _zoom_postprocess(raw, layer_nodes, d_floor, ceil_ratio)


def compute_layer_zoom_rtree(cur, out_maxlayer, layer_nodes, vb=2000.0, pct=50.0,
                             samples=400, d_floor=2.0, ceil_ratio=4.0, seed=20260729,
                             log_fn=None, iters=16, diag_cap=None):
    """viewer の層選択閾値 f(n)(layer_zoom)を **R-Tree の打ち切りカウントで直接** 解く（新既定）。

    ■ 旧 grid 版(compute_layer_zoom)の何が問題だったか（実測 2026-07-28）
      格子(既定 4096)で局所密度を測るので、chr22 の hairball では **L8 以降 解が格子解像度に飽和**し、
      実際には `f(L)=f(L-1)×1.41`（d_floor 下限比）のフォールバックに落ちていた。
      つまり深層の閾値には根拠が無い状態だった（真の P95 較正なら f(L12)=4,000,000× 必要なのに
      出力は 25,894×）。R-Tree で直接解けば飽和は起きない。

    ■ 分位は **50（中央値）** が既定（旧 95 から変更）
      「分位 P を上限に合わせる」方式はグラフ間で中央値が 1.18〜3.03× ばらつき、さらに
      **同じグラフの層間で 25〜64×** ばらついた（＝「層によって妙に空/妙に重い」の原因）。
      **各層の中央値を目標 vb に直接固定すると分布の形が入り込まない**ので、3 DB で
      目標比 0.74〜0.90×・層間 2.8〜5.2× に収まった。裾の厚さの違いは
      「取得の安全弁(maxRows)による上位層 fallback の発生率」に出るだけで、そちらは安全側の劣化。
      → 安定させたい量（典型ビューのグリフ数）を直接固定し、変動を許せる量に変動を寄せる。

    ■ 窓は **一辺 W/s の正方形**（canvas 非依存）
      旧版は窓を (W/s, H/s)=world のアスペクトにしていたため、実 viewport(canvas アスペクト)との
      面積比が **グラフごとに 0.96〜3.55×** ずれていた（chrY 3.55× / WG 0.96×）＝分位の選び方とは
      独立なグラフ依存バイアス。正方形に固定し、規約を stats.zoom_window に明記して
      viewer 側が自分の canvas アスペクトで補正する（viewer: z=√(sw·sh)/W·f(L)）。

    ■ 打ち切りカウントで安く解く
      判定に必要なのは「第 pct 分位 <= vb か」の真偽だけなので、カウントを vb+1 で打ち切ってよい
      （LIMIT が R-Tree 走査に押し込まれ早期終了する＝密度に依らず O(vb)。実測 warm 0.24-1.3ms、
      WG 全域 1.1 億件でも 1.01ms）。1 層あたり samples×約16 回の打ち切りカウントで解ける。

    返り値: (layer_zoom, diag)。diag は層別の実分位（p25/p50/p75/p90/p99）で、
    「このグラフはどのくらい裾が厚い＝どのくらい fallback するか」を後から観測できるようにする。
    """
    import random as _random
    rng = _random.Random(seed)
    # ★world 幅 W は **layer0 の rowid レンジで nodes を引いて**求める。
    #   `SELECT MIN(min_x),MAX(max_x) FROM nodes_rtree WHERE min_layer=0` は EXPLAIN が
    #   `SCAN nodes_rtree VIRTUAL TABLE`（=2億 entries 全走査）になり、**WG では 10 分以上返らない**
    #   （既知の罠「MIN/MAX(...) FROM nodes_rtree は rtree 全走査。任意の非索引集約は厳禁」を踏んだ）。
    #   layer0 の rowid は 1..layer_nodes[0]（emitter は層順に INSERT）なので INTEGER PK レンジ検索で
    #   済む（WG cold 実測 902ms・rtree 由来と同一 bbox）。
    _n0 = layer_nodes[0] if layer_nodes else 0
    if _n0 > 0:
        xmn, xmx, ymn, ymx = cur.execute(
            "SELECT MIN(xCoord-radius), MAX(xCoord+radius), MIN(yCoord-radius), MAX(yCoord+radius) "
            "FROM nodes WHERE rowid BETWEEN 1 AND ?", (_n0,)).fetchone()
    else:   # layer_nodes が無い異常時のみ rtree を使う（小 DB 前提のフォールバック）
        xmn, xmx = cur.execute("SELECT MIN(min_x), MAX(max_x) FROM nodes_rtree "
                               "WHERE min_layer=0").fetchone()
        ymn = ymx = None
    W = ((xmx or 0) - (xmn or 0)) or 1.0
    H = ((ymx or 0) - (ymn or 0)) if (ymx is not None) else None
    # 一辺 W の正方窓は、world の y 幅が W 以下なら **どこに置いても層の全グリフを覆う**ので
    # 「全域窓の分位 <= vb」は「layer_nodes[L] <= vb」と同値。WG では全域窓プローブが
    # cap に達せず 1 本 600ms かかり 250 標本×18 層で 10-15 分を無駄にしていたので O(1) 化する。
    _whole_covers = (H is not None and H <= W)
    CAPQ = ("SELECT COUNT(*) FROM (SELECT 1 FROM nodes_rtree WHERE min_layer=? AND max_layer=? "
            "AND max_x>=? AND min_x<=? AND max_y>=? AND min_y<=? LIMIT ?)")

    def counts(L, pts, w, cap):
        h = w / 2.0
        return [cur.execute(CAPQ, (L, L, x - h, x + h, y - h, y + h, cap)).fetchone()[0]
                for (x, y) in pts]

    def quant(vals, p):
        v = sorted(vals)
        if not v:
            return 0.0
        i = min(len(v) - 1, max(0, int(round((p / 100.0) * (len(v) - 1)))))
        return float(v[i])

    # 層ごとにグリフ中心の標本点を取る（rowid レンジ内から一様。content-weighted＝旧版と同じ定義）。
    # ★rowid レンジは **layer_nodes の累積から O(1) で** 出す。
    #   `SELECT layer_index, MIN(rowid), MAX(rowid) FROM nodes GROUP BY layer_index` は
    #   **WG(2億行/47GB, layer_index に有効な索引なし)で 7 時間かけて 1TB 読んでも終わらなかった**
    #   （既知の落とし穴 [[wg-groupby-not-indexed]] を踏んだ）。emitter は層順に INSERT するので
    #   rowid は層ごとに連続（WG/chr22 で全層検証済）。念のため両端の layer_index を点引きで検証し、
    #   崩れていたら層単位の索引付きクエリへフォールバックする。
    lay = {}
    _lo = 1
    for L in range(out_maxlayer + 1):
        n_L = layer_nodes[L] if L < len(layer_nodes) else 0
        if n_L <= 0:
            continue
        _hi = _lo + n_L - 1
        a = cur.execute("SELECT layer_index FROM nodes WHERE rowid=?", (_lo,)).fetchone()
        b = cur.execute("SELECT layer_index FROM nodes WHERE rowid=?", (_hi,)).fetchone()
        if a and b and a[0] == L and b[0] == L:
            lay[L] = (_lo, _hi)
        else:
            # 連続でない DB。層単位なら索引(layer_index,node_name)が効くので全走査にはならない。
            r = cur.execute("SELECT MIN(rowid), MAX(rowid) FROM nodes WHERE layer_index=?",
                            (L,)).fetchone()
            if log_fn:
                log_fn(f"  WARN: L{L} の rowid が層連続でない → 索引クエリで範囲取得 {r}")
            if r and r[0] is not None:
                lay[L] = (r[0], r[1])
        _lo = _hi + 1
    raw, diag = [], []
    cap_dec = int(vb) + 1                     # 判定用（分位<=vb の真偽だけ要るので vb+1 で足りる）
    # 診断用の上限。裾を見たいので広めだが、**WG(2億行)では広い cap が高くつく**ので可変にする
    # （cap で飽和しても「裾が cap を超える」＝安全弁 maxRows で clamp する、という判断には足りる）。
    cap_diag = int(diag_cap) if diag_cap else max(cap_dec, int(vb) * 50)
    for L in range(out_maxlayer + 1):
        rng_lo, rng_hi = lay.get(L, (None, None))
        if rng_lo is None:
            raw.append(raw[-1] if raw else 1.0); diag.append(None); continue
        k = min(samples, rng_hi - rng_lo + 1)
        rids = rng.sample(range(rng_lo, rng_hi + 1), k)
        ph = ",".join("?" * len(rids))
        pts = cur.execute(f"SELECT xCoord, yCoord FROM nodes WHERE rowid IN ({ph})", rids).fetchall()
        if not pts:
            raw.append(raw[-1] if raw else 1.0); diag.append(None); continue
        if log_fn:
            log_fn(f"  layer_zoom L{L}: 標本 {len(pts)} で探索開始（rowid {rng_lo:,}..{rng_hi:,}）")
        n_L = layer_nodes[L] if L < len(layer_nodes) else None
        _fits = (n_L is not None and n_L <= vb) if _whole_covers \
            else (quant(counts(L, pts, W, cap_dec), pct) <= vb)
        if _fits:
            s_L = 1.0                          # 全域窓でも予算内 → fit で出せる
        else:
            lo, hi = W / 4e6, W                # 窓の一辺 w を対数二分探索（w 小 ⇒ 件数少）
            _t = time.time()
            for _it in range(iters):
                mid = (lo * hi) ** 0.5
                if quant(counts(L, pts, mid, cap_dec), pct) > vb:
                    hi = mid
                else:
                    lo = mid
                if log_fn and (_it == 0 or _it == iters - 1):
                    log_fn(f"    L{L} 反復 {_it+1}/{iters} 窓={mid:.4g} ({time.time()-_t:.0f}s)")
            s_L = W / ((lo * hi) ** 0.5)
        raw.append(s_L)
        if s_L == 1.0 and _whole_covers and n_L is not None:
            cs = [float(n_L)] * len(pts)       # 窓=全域 → 全標本が層の全グリフを見る（プローブ不要）
        else:
            cs = counts(L, pts, W / s_L, cap_diag)
        diag.append([int(quant(cs, q)) for q in (25, 50, 75, 90, 99)])
        if log_fn:
            log_fn(f"  layer_zoom L{L}: f={s_L:.6g} 窓={W/s_L:.4g} "
                   f"p25/p50/p75/p90/p99={'/'.join(str(v) for v in diag[-1])} (標本 {len(pts)})")

    return _zoom_postprocess(raw, layer_nodes, d_floor, ceil_ratio), diag


def _parse_p_ids(field):
    """P 行の segment 列 'id±,id±,...' を int64 配列へ。C 側 np.fromstring で ~6x 高速化。
    現行 [int(tk[:-1]) for tk in field.split(',') if tk] と bit-完全一致(向き ± を除去して
    カンマ区切り整数を一括パース)。空・末尾カンマ・重複 token も同一挙動(検証済)。"""
    if not field:
        return np.empty(0, dtype=np.int64)
    return np.fromstring(field.replace("+", "").replace("-", ""), sep=",", dtype=np.int64)


_GROUP_DELIMS = ("#", ".")


def parse_group(name):
    """パス名 -> (sample, haplotype, contig)。区切りは # と .(複数区切り対応)。
       PanSN=sample#hap#contig、reference 略記=sample.contig / sample#contig（GRCh38.chrX 等）。
       **コンティグ名に . を含み得る**(例 HG03540#1#JAGYVY010000089.1)ため、区切りは
       «先頭2個» までしか認識しない — 2個目の区切り以降は contig 本体とみなし、その中の
       . / # は分割しない。subrange [..] は無視。
       返り値: sample=1個目区切りの前, hap=2個目区切りの前(prefix), contig=全体(base)。
       #のみの標準 PanSN(3フィールド)では従来と同一キー(chr22 等 bit 不変)。"""
    base = name.split("[")[0]
    d1 = d2 = -1
    for i, ch in enumerate(base):
        if ch in _GROUP_DELIMS:
            if d1 < 0:
                d1 = i
            else:
                d2 = i
                break
    if d1 < 0:                       # 区切り無し(単一フィールド)
        return base, base, base
    sample = base[:d1]
    if d2 < 0:                       # 区切り1個(sample.contig / sample#contig 略記)
        return sample, sample, base
    return sample, base[:d2], base   # 区切り2個以上: hap=先頭2フィールド, contig=全体


def _ribbon_tables(cur):
    """パスリボン用の2表を旧スキーマ厳守で作り直す(viewer 互換)。"""
    cur.execute("DROP TABLE IF EXISTS path_groups")
    cur.execute("DROP TABLE IF EXISTS node_group_cov")
    cur.execute("CREATE TABLE path_groups(group_id INTEGER PRIMARY KEY, level TEXT, "
                "key TEXT, sample TEXT, haplotype TEXT, contig TEXT, label TEXT, "
                "n_paths INTEGER, total_cov INTEGER)")
    cur.execute("CREATE TABLE node_group_cov(layer_index INTEGER, node_rowid INTEGER, "
                "group_id INTEGER, covered_bp INTEGER)")


def emit_ribbon(cur, con, gfa, sids, ord_ids, bp_row, row2node, rep_at,
                born, b_born, d_born, start, maxlayer, ntree, t0, distill=None):
    """パスリボン表(path_groups, node_group_cov)を書く。旧 layout_group_cov.py の統一LOD木移植版。

    viewer はノード fill でなく、パスが通る super-node 列に「リボン(線)」を引く。super-node は
    通過/非通過の2択でなく「その glyph の総塩基の θ% 以上を群が通れば通過」と viewer 側スライダ θ で
    動的判定する。そのため per (layer, node, group) の被覆塩基 covered_bp を持つ。群 = PanSN contig 粒度
    (sample/hap は viewer/backend が prefix で roll-up)。

    旧 emitter(AVG/layer_bins の bin 割当)から新 emitter(統一LOD木)へ移植: パスの各 token(GFA葉)を
    row2node で木の葉へ、層 L で rep_at により可視 super-node へ climb し、群×(層,super-node) の被覆塩基を
    集計。node_rowid はノード書き出しループと同一の (born, birth<=L<death) 反復・同一連番で再構成する
    (DELETE 後の nodes は挿入順=rowid、本体ループの rids=arange(rid+1,..) と一致)。
    被覆は「出現和」(同一群の revisit を厳密 dedup しない; 非巡回参照では実質 overcount ゼロ)。
    """
    # ---- 全 P/W 行を走査して群登録 + token(gid, npz_row)配列を構築 ----
    contig_gid = {}
    grp_meta = []                          # gid -> [level, key, sample, hap, contig, label, n_paths]
    row_parts, gid_parts = [], []
    n_p = n_w = 0
    for name, raw, is_w in _iter_pw_tokens(gfa, distill):
        if is_w:
            n_w += 1
        else:
            n_p += 1
        sample, hap, contig = parse_group(name)
        gid = contig_gid.get(contig)
        if gid is None:
            gid = len(grp_meta)
            contig_gid[contig] = gid
            grp_meta.append(["contig", contig, sample, hap, contig, contig, 0])
        grp_meta[gid][6] += 1
        if len(raw) == 0:
            continue
        pid = np.asarray(raw, dtype=np.int64)
        pos = np.searchsorted(sids, pid); pos = np.clip(pos, 0, len(sids) - 1)
        ok = sids[pos] == pid
        rows = ord_ids[pos[ok]]                         # npz row per matched token
        if rows.size == 0:
            continue
        row_parts.append(rows.astype(np.int64))
        gid_parts.append(np.full(rows.size, gid, dtype=np.int64))
    NG = len(grp_meta)
    _ribbon_tables(cur)
    if NG == 0 or not row_parts:
        log("ribbon: パス(P/W)行が無い(または一致 token 0) → リボン表は空で作成のみ")
        con.commit()
        return
    row_all = np.concatenate(row_parts)
    gid_all = np.concatenate(gid_parts)
    del row_parts, gid_parts

    # token(npz row) -> 木の葉。葉が無い(row2node<0)token は捨てる。
    leaf_all = row2node[row_all]
    keep = leaf_all >= 0
    leaf_all = leaf_all[keep]
    gid_all = gid_all[keep]
    bp_all = np.maximum(bp_row[row_all[keep]].astype(np.int64), 1)
    log(f"ribbon: groups(contig)={NG} P={n_p} W={n_w} tokens(anchored)={leaf_all.size:,}")

    # total_cov[gid] = 群が辿った総塩基(層に依らず token 1回ずつ)
    total_cov = np.bincount(gid_all, weights=bp_all, minlength=NG).astype(np.int64)

    # ユニーク葉ごとに rep_at を計算し token へ展開(rep_at の climb を葉数に畳む)
    uniq_leaf, inv_leaf = np.unique(leaf_all, return_inverse=True)
    inv_leaf = np.asarray(inv_leaf).ravel()

    # --- streaming 化: token(=anchored 数, chr22 で ~2億)を (uniq_leaf, gid) 粒度へ
    #     ループ外で1回だけ集約する。以降の毎層処理は token 数でなく Q=distinct(leaf,gid) 数で回り、
    #     旧実装の毎層 205M への vis/key 展開+np.unique(48GB OOM の主因)を消す。
    #     二段 bincount(token→(leaf,gid)→(vis,gid))は bp が整数<2^53 で厳密和=元と同一値・同一順。
    keep_n = int(leaf_all.size)
    lgkey = inv_leaf.astype(np.int64) * NG + gid_all
    ulg, invlg = np.unique(lgkey, return_inverse=True)
    invlg = np.asarray(invlg).ravel()
    bp_q = np.bincount(invlg, weights=bp_all, minlength=ulg.size).astype(np.int64)
    leaf_q = ulg // NG                                       # uniq_leaf 内 index
    gid_q = (ulg % NG).astype(np.int64)
    del lgkey, invlg, inv_leaf, leaf_all, gid_all, bp_all, row_all
    log(f"ribbon: incidence 畳み込み tokens={keep_n:,} -> (leaf,gid)={ulg.size:,}")

    ins = ("INSERT INTO node_group_cov(layer_index,node_rowid,group_id,covered_bp) "
           "VALUES(?,?,?,?)")
    CHUNK = 1_000_000                                        # executemany を分割し Python リスト常駐を CHUNK 行に抑える
    rid_base = 0
    rows_written = 0
    for L in range(start, maxlayer + 1):
        Lw = L - start
        P = born[(b_born <= L) & (L < d_born)]              # 本体ノードループと同一
        k = len(P)
        if k == 0:
            continue
        posmap = np.full(ntree, -1, np.int64)               # tree-node -> P 内 index(=rowid-rid_base-1)
        posmap[P] = np.arange(k)
        vis_q = rep_at(uniq_leaf, L)[leaf_q]                # (leaf,gid) ごとの可視 super-node(tree index)
        key = vis_q * NG + gid_q
        uk, invk = np.unique(key, return_inverse=True)
        sums = np.bincount(np.asarray(invk).ravel(), weights=bp_q, minlength=uk.size).astype(np.int64)
        vis_u = uk // NG
        gid_u = uk % NG
        idx_in_P = posmap[vis_u]
        good = idx_in_P >= 0                                # 在圏代表は必ず P に居る(保険)
        rowid_u = (rid_base + 1 + idx_in_P[good]).astype(np.int64)
        gid_g = gid_u[good].astype(np.int64)
        sums_g = sums[good]
        m = int(rowid_u.size)
        for s in range(0, m, CHUNK):                        # チャンク emit: 全行の Python リスト化(旧 batch=list(zip))を避ける
            e = min(s + CHUNK, m)
            cur.executemany(ins, zip(itertools.repeat(Lw, e - s),
                                     rowid_u[s:e].tolist(), gid_g[s:e].tolist(),
                                     sums_g[s:e].tolist()))
        rows_written += m
        rid_base += k
        con.commit()
        log(f"  ribbon L{Lw}(旧L{L}): rows={m:,}")

    cur.executemany(
        "INSERT INTO path_groups(group_id,level,key,sample,haplotype,contig,label,"
        "n_paths,total_cov) VALUES(?,?,?,?,?,?,?,?,?)",
        [(gid, m[0], m[1], m[2], m[3], m[4], m[5], m[6], int(total_cov[gid]))
         for gid, m in enumerate(grp_meta)])
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ngc_layer_node ON node_group_cov(layer_index,node_rowid)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ngc_group ON node_group_cov(group_id,layer_index)")
    con.commit()
    log(f"ribbon[done] groups={NG} ngc-rows={rows_written:,} ({time.time()-t0:.1f}s)")


def _hapcov_tables(cur, n_hap, levels):
    """ハプロ dense リボン用テーブル(sparse 版 path_groups/node_group_cov とは別)。
       node_hap_cov.node_rowid は INTEGER PRIMARY KEY(=rowid 別名)で二次索引不要=サイズ最小。"""
    cur.execute("DROP TABLE IF EXISTS hap_dict")
    cur.execute("DROP TABLE IF EXISTS node_hap_cov")
    cur.execute("DROP TABLE IF EXISTS hapcov_meta")
    cur.execute("CREATE TABLE hap_dict(hap_id INTEGER PRIMARY KEY, key TEXT, "
                "sample TEXT, haplotype TEXT, n_paths INTEGER, total_cov INTEGER)")
    # cov = n_hap バイトの BLOB。位置 h(=hap_id) の 1 バイト = round((levels-1)·covered_bp/node.size)。
    cur.execute("CREATE TABLE node_hap_cov(node_rowid INTEGER PRIMARY KEY, cov BLOB)")
    cur.execute("CREATE TABLE hapcov_meta(n_hap INTEGER, levels INTEGER)")
    cur.execute("INSERT INTO hapcov_meta(n_hap,levels) VALUES(?,?)", (n_hap, levels))


def _edge_hapcov_table(cur):
    """エッジ・ハプロ被覆(ビットセット)。エッジ通過は2値(通った/通らない)なので割合バイト不要、
       各エッジ ceil(H/8) バイトの mask で bit h = hap h がこのエッジを通過。
       edge_hap_cov.edge_rowid は edges.rowid と一致(INTEGER PRIMARY KEY=rowid 別名, 二次索引ゼロ=最小)。
       maskbytes は viewer 側で ceil(hapcov_meta.n_hap/8) から導出。"""
    cur.execute("DROP TABLE IF EXISTS edge_hap_cov")
    cur.execute("CREATE TABLE edge_hap_cov(edge_rowid INTEGER PRIMARY KEY, mask BLOB)")


# ===== distill サイドカー(viewer の bubble MSA 用) ==================================
# viewer の MSA パネルは「各 contig が選択ノード集合をどの順序・向きで実際に通ったか」を出すため、
# 順序付きウォーク(p_tok/p_ori)を要る。これは DB に入れられない規模(WG で T=380 億 token=190GB)なので
# **DB の隣に distill ディレクトリへの symlink を置く**規約 `<dbpath>.distill`(hapidx/nametri と同型)にし、
# backend がそれを辿って直読みする。手で ln -s する運用だと「DB は出来たのに MSA だけ出ない」を
# 繰り返すので、emitter が必ず張る。
DISTILL_MSA_FILES = ("p_tok.npy", "p_ori.npy", "p_off.npy", "p_names.txt", "id_map.npy")


# 空間順(Hilbert)の採番順。main() が §7 の直前に 1 回だけ設定し、emit_core の各呼び出しが読む。
# ★全部の関数署名に足すより大域 1 個の方が安全: rowid 規約は 7 経路が共有していて、
#   1 つでも渡し忘れると **ブロブが別のノードに付く**（静かな破壊）。大域なら渡し忘れが起きない。
_SPATIAL_ORDER = None


def hilbert_rank(x, y, order=16):
    """(x,y) を Hilbert 曲線上の距離に写す（ベクトル化）。空間順の採番に使う。

    なぜ Hilbert か: Morton(Z-order) は四分木の境界で長いジャンプが出る。ビューポート＝
    小さい矩形なので「矩形内の点が曲線上で連続している」性質が直に効く。Hilbert はそれが強い。

    order=16 なら 65536x65536 の格子。WG の world は約 0.9x0.14 なので、
    最小ノード(radius 5e-8)より格子の方が粗いが、**目的は同一ページに載せること**で
    厳密な順序ではないので十分（同一セル内の順序は不定でよい）。
    """
    import numpy as _np
    n = 1 << order
    X0 = _np.asarray(x, dtype=_np.float64)
    Y0 = _np.asarray(y, dtype=_np.float64)
    # ★両軸に **共通スケール** を使う（縦横比を保つ）。軸ごとに [0,n) へ正規化すると
    #   セルが world の縦横比を持つ長方形になり、正方形のビューポートが短い軸で
    #   何倍も多くのセルにまたがって局所性が落ちる。
    #   実例: chr22 の world は x 0.90 x y 0.14。軸別だと L14 の正方ビューポートが
    #   x 102 セル・y 654 セル(=6.4 倍)にまたがるが、共通スケールなら 102x102 に収まる。
    #   短い軸は格子を使い切らない（chr22 で y は約 1/6.4）が、65536/6.4 でもまだ十分細かい。
    lox, hix = float(_np.nanmin(X0)), float(_np.nanmax(X0))
    loy, hiy = float(_np.nanmin(Y0)), float(_np.nanmax(Y0))
    span = max(hix - lox, hiy - loy)
    def q(a, lo):
        if not (span > 0):
            return _np.zeros(a.shape, dtype=_np.int64)
        t = (a - lo) / span * (n - 1)
        return _np.clip(_np.nan_to_num(t), 0, n - 1).astype(_np.int64)
    X = q(X0, lox)
    Y = q(Y0, loy)
    d = _np.zeros(X.shape, dtype=_np.int64)
    s = n >> 1
    while s > 0:
        rx = ((X & s) > 0).astype(_np.int64)
        ry = ((Y & s) > 0).astype(_np.int64)
        d += s * s * ((3 * rx) ^ ry)
        # 回転（ry==0 のとき rx==1 なら反転してから x,y を入れ替え）
        flip = (ry == 0)
        refl = flip & (rx == 1)
        Xr = _np.where(refl, s - 1 - X, X)
        Yr = _np.where(refl, s - 1 - Y, Y)
        X, Y = _np.where(flip, Yr, Xr), _np.where(flip, Xr, Yr)
        s >>= 1
    return d


def spatial_order_of(cx, cy, parent, log_fn=None):
    """**子を空間順に訪れる DFS 前順**で、ノードの採番順を返す。

    ★大域 Hilbert ソートは使わない。木インデックスは `build_typed` が typed ファイルの
      初出順（＝パス順＝DFS）で振るので、**部分木は既に連続した index 範囲**を占めている。
      ビューポートが 1 つの部分木に収まれば rowid は 1 run になり、これは強い性質。
      大域 Hilbert はこれを壊し、矩形を「周長に比例する数の曲線区間」に切ってしまう
      （chr22 実測: rows-per-run 312 → 122、runs 3 → 6 と悪化）。

    ★恣意的なのは **兄弟の順序だけ**。`build_typed` の兄弟順は Infomap のモジュール番号
      （パス "2:10:8" の数字）で決まり、**レイアウトを一切参照していない**（木は ②、
      レイアウトは ③ で順序が逆）。だから兄弟をレイアウト上の位置で並べ替えれば、
      部分木のまとまりを保ったままビューポート内の連続性が上がる。
      MC の散乱ビューポート（単一成分の内部で rowid が 11 個の塊に割れる）はこの形。

    子の並べ替えキーはその子自身の (CX, CY) の Hilbert 距離。内部ノードの CX/CY は
    emit_geometry が出した**部分木の重心**なので「その部分木がどこにあるか」を表す。
    """
    import numpy as _np
    n = len(parent)
    par = _np.asarray(parent, dtype=_np.int64)
    key = hilbert_rank(cx, cy)

    # 子リストを CSR で作る（root=0 の親は -1）。200M ノードでも再帰しない。
    child_of = par[1:]                                   # v=1.. の親
    cnt = _np.bincount(child_of, minlength=n)
    off = _np.zeros(n + 1, dtype=_np.int64)
    _np.cumsum(cnt, out=off[1:])
    # 各親の子を **空間キー順**に並べて詰める（親ごとに安定ソート）
    vs = _np.arange(1, n, dtype=_np.int64)
    order_pairs = _np.lexsort((key[vs], child_of))       # 親ごと → キー昇順
    kids = vs[order_pairs]

    # 反復 DFS 前順
    out = _np.empty(n, dtype=_np.int64)
    stack = _np.empty(n, dtype=_np.int64)
    sp = 0
    stack[sp] = 0; sp += 1
    k = 0
    while sp:
        sp -= 1
        v = stack[sp]
        out[k] = v; k += 1
        a0, a1 = off[v], off[v + 1]
        if a1 > a0:
            # 逆順に積む → pop で空間キー昇順に訪れる
            blk = kids[a0:a1][::-1]
            stack[sp:sp + blk.size] = blk
            sp += blk.size
    if k != n:
        # 木が非連結（root から届かないノードがある）場合は残りを末尾に付ける
        seen = _np.zeros(n, dtype=bool); seen[out[:k]] = True
        rest = _np.flatnonzero(~seen)
        out[k:] = rest[_np.argsort(key[rest], kind="stable")]
        if log_fn:
            log_fn(f"spatial-order: root から未到達 {rest.size:,} ノードを末尾に付加")
    if log_fn:
        log_fn(f"spatial-order: 子を空間順に訪れる DFS 前順で {n:,} ノードを採番"
               f"（部分木の連続性は保ち、兄弟の並びだけ空間順にする）")
    return _np.ascontiguousarray(out)


def _build_hb_covering_idx(cur, con, t0):
    """hb（hap-breadth）用の被覆索引。

    エッジ太さ/breadth 表示は `node_contig_cov.hb` / `edge_contig_cov.hb` を rowid 点引きするが、
    これらの表は **1 行 195B / 161B**（blob が大半）なので、hb 1 バイトのために太い行
    ＝4KB ページを丸ごと読む。WG の cold ではここが効く（ビューポート内の行数ぶんランダム読み）。
    (rowid, hb) の被覆索引を置くと、同じ hb を 13B/行の索引から取れる。

    実測（chr22, dbstat のページ数）:
      node_contig_cov 349,219 → idx_ncc_hb 22,968 ページ = **15.2 分の 1**（索引 +89MB）
      edge_contig_cov 296,094 → idx_ecc_hb 29,645 ページ = **10.0 分の 1**（索引 +115MB）
      構築は 2 本で 4.2 秒（chr22）。WG では +約 5.9GB（273GB の 2%）の見込み。

    ★SQLite は自分では使わない（rowid シークを最安と見る）。viewer 側が `INDEXED BY` で
      明示的に強制する（nodeQuery.ts hbCoveringIdx）。索引が無ければ従来どおり太い行を読む。
    ★呼ぶ場所が要点: **contig リボン段より後**でなければ表がまだ無い。前に置いていた版では
      pragma_table_info が空を返し、ログも出ないまま索引が作られていなかった。
    """
    for _t, _k, _ix in (("node_contig_cov", "node_rowid", "idx_ncc_hb"),
                        ("edge_contig_cov", "edge_rowid", "idx_ecc_hb")):
        try:
            if not cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                               (_t,)).fetchone():
                log(f"{_ix} skip: {_t} が無い（--no-ribbon-contig?）")
                continue
            if not cur.execute("SELECT 1 FROM pragma_table_info(?) WHERE name='hb'", (_t,)).fetchone():
                log(f"{_ix} skip: {_t} に hb 列が無い")
                continue
            _t0 = time.time()
            cur.execute(f"CREATE INDEX IF NOT EXISTS {_ix} ON {_t}({_k}, hb)")
            con.commit()
            log(f"{_ix} built ({time.time()-_t0:.1f}s; hb を太い blob 行を読まずに取るための被覆索引)")
        except Exception as _e:
            log(f"{_ix} skipped: {type(_e).__name__}: {_e}")


def _distill_msa_ok(distill):
    """MSA に要る distill 成果物が揃っているか。p_ori 未出力の旧 distill では MSA は不可。"""
    if not distill:
        return False
    return all(os.path.exists(os.path.join(distill, f)) for f in DISTILL_MSA_FILES)


def _distill_matches_db(distill, cur, maxlayer, sample=512):
    """distill が **この DB と同じグラフ** かを標本照合する。
    MSA は dense token → id_map → 元 id → DB の葉 `n{id}` で対応づけるので、別グラフの distill を
    指すと黙って無意味な MSA が出る(v1.0-mc と v2.0-mc の id 不一致など; memory
    `wg-mc-vs-pggb-id-identity` と同種の事故)。DB の葉ノード名を標本し、id_map に載っている割合を見る。
    id_map は WG で 887MB あるので mmap で読み、標本だけ照合する。
    ⚠ 標本の取り方: 最下層(=全ノードが葉)を PK 索引 (layer_index, node_name) の範囲走査で引く。
      `WHERE kind=0 AND node_name LIKE 'n%'` は索引が効かず WG で nodes 全走査になる
      (LIKE は BINARY 照合で前方一致シークにならない: memory `sqlite-like-index-pitfall`)。"""
    try:
        idm = np.load(os.path.join(distill, "id_map.npy"), mmap_mode="r")
        names = [r[0] for r in cur.execute(
            "SELECT node_name FROM nodes WHERE layer_index=? AND node_name GLOB 'n*' LIMIT ?",
            (maxlayer, sample))]
        ids = np.array([int(n[1:]) for n in names if n[1:].isdigit()], dtype=np.int64)
        if ids.size == 0:
            return True, "葉ノードを標本できず照合スキップ"
        hit = int(np.isin(ids, np.asarray(idm)).sum())
        frac = hit / ids.size
        return (frac >= 0.99), "葉 %d 標本中 %d (%.1f%%) が id_map に一致" % (ids.size, hit, 100 * frac)
    except Exception as e:                       # 照合できないだけでビルドは壊さない
        return True, "照合不能(%s: %s)" % (type(e).__name__, e)


def _write_distill_sidecar(db_path, distill, log):
    """`<db_path>.distill` → distill(realpath)の symlink を張る。再ビルドで冪等に張り替える。
    ⚠ 実体(dir/file)が既にある場合は絶対に壊さない。data/db/ の DB が e2e/db への symlink 運用でも
    効くよう、backend 側は realpath(db)+'.distill' も探す(routes/bubbleMsa.ts)。"""
    sc = db_path + ".distill"
    tgt = os.path.realpath(distill)
    try:
        if os.path.islink(sc):
            os.unlink(sc)                        # 旧リンク(壊れリンク含む)は張り替え
        if os.path.exists(sc):
            log("WARN: distill sidecar: %s が実体で存在するため張り替えません(手動で確認)" % sc)
            return
        os.symlink(tgt, sc)
        log("distill sidecar: %s -> %s" % (sc, tgt))
    except OSError as e:
        log("WARN: distill sidecar を張れません (%s)。後から `ln -s %s %s` で足せる"
            "(無いと viewer の MSA パネルだけ使えない)" % (e, tgt, sc))


# ===== hapcov リボンの streaming 畳み込みヘルパ =====================================
# 動機: chr22 で 205M token を 1 本の配列に concat して np.unique するピーク(~26GB)が、
# WG(~12.7B token)では ~1.6TB になり収まらない。全 T を常駐させず、バッチで流しながら
# incidence を逐次マージ集約し、ピークを O(T) → O(I incidence + バッファ) に落とす。

def _load_distill_paths(distill):
    """distill 中間(distill_gfa.py)の path 配列を返す(p_tok は memmap=全 token 常駐しない)。
    p_names/p_off/p_tok/p_iswalk はいずれも GFA file order。token は dense id(=③ npz ids と同一空間)。"""
    names = open(os.path.join(distill, "p_names.txt")).read().split("\n")
    if names and names[-1] == "":
        names = names[:-1]
    p_off = np.load(os.path.join(distill, "p_off.npy"))
    p_tok = np.load(os.path.join(distill, "p_tok.npy"), mmap_mode="r")
    p_iswalk = np.load(os.path.join(distill, "p_iswalk.npy"))
    return names, p_off, p_tok, p_iswalk


def _load_distill_ori(distill):
    """distill の p_ori.npy(各 token の向き uint8, p_tok と 1:1 並列)を memmap で返す。
    旧 distill(p_ori 未出力)では None(呼び出し側は GFA 直読みへフォールバック)。"""
    path = os.path.join(distill, "p_ori.npy")
    if not os.path.exists(path):
        return None
    return np.load(path, mmap_mode="r")


def _iter_pw_names(gfa, distill=None):
    """P/W 行から (name, is_path) を軽量に列挙(token 配列は作らない=pass1 用)。
    distill 指定時は p_names/p_iswalk から(GFA テキストを開かない)。順序は GFA file order で同一。"""
    if distill is not None:
        names, _off, _tok, p_iswalk = _load_distill_paths(distill)
        for k in range(len(names)):
            yield names[k], bool(p_iswalk[k] == 0)
        return
    with open(gfa) as f:
        for line in f:
            if line.startswith("P\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 3:
                    yield parts[1], True
            elif line.startswith("W\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 7:
                    yield f"{parts[1]}#{parts[2]}#{parts[3]}", False


def _iter_pw_tokens(gfa, distill=None):
    """P/W 行から (name, raw:int64 ndarray, is_walk) を列挙(pass2 用; token 配列を作る)。
    GFA:  name=P の parts[1] / W の '#' 連結、raw=_parse_p_ids(P) / regex(W)。
    distill: name=p_names、raw=p_tok[off[k]:off[k+1]](dense id, GFA parse と bit 同値)。
    W の raw を list→ndarray に統一するが、消費側は np.asarray(raw,int64) で正規化するため出力不変。"""
    if distill is not None:
        names, p_off, p_tok, p_iw = _load_distill_paths(distill)
        for k in range(len(names)):
            a = int(p_off[k]); b = int(p_off[k + 1])
            yield names[k], np.asarray(p_tok[a:b], dtype=np.int64), bool(p_iw[k])
        return
    with open(gfa) as f:
        for line in f:
            if line.startswith("P\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                yield parts[1], _parse_p_ids(parts[2]), False
            elif line.startswith("W\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 7:
                    continue
                yield (f"{parts[1]}#{parts[2]}#{parts[3]}",
                       np.asarray([int(x) for x in re.findall(r"[<>](\d+)", parts[6])], np.int64),
                       True)


def _iter_pw_tokens_oriented(gfa, distill=None):
    """inversion/ref_strand 用: P/W 行から (name, ids:int64, orient:uint8(1=+/>,0=-/<), is_walk) を列挙。
    通常の _iter_pw_tokens は向きを除去するが、これは各ステップの向き(GFA の ±/<>)も返す。
    distill 経路: distill_gfa が出力する p_ori.npy(p_tok と 1:1)があればそれを memmap 消費し、
    GFA テキストの再パースを回避(WG の oriented 走査を高速化)。p_ori 未出力の旧 distill では
    NotImplementedError(呼び出し側が gfa 直読みへフォールバックする想定)。"""
    if distill is not None:
        p_ori = _load_distill_ori(distill)
        if p_ori is None:
            raise NotImplementedError("distill に p_ori.npy が無い(旧 distill) — oriented 走査は --gfa が必要")
        names, p_off, p_tok, p_iw = _load_distill_paths(distill)
        for k in range(len(names)):
            a = int(p_off[k]); b = int(p_off[k + 1])
            yield (names[k], np.asarray(p_tok[a:b], dtype=np.int64),
                   np.asarray(p_ori[a:b], dtype=np.uint8), bool(p_iw[k]))
        return
    pw = re.compile(r"([<>])(\d+)")
    with open(gfa) as f:
        for line in f:
            if line.startswith("P\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                ids_l = []; ori_l = []
                for t in parts[2].split(","):
                    if not t:
                        continue
                    ids_l.append(int(t[:-1])); ori_l.append(1 if t[-1] == "+" else 0)
                yield parts[1], np.asarray(ids_l, np.int64), np.asarray(ori_l, np.uint8), False
            elif line.startswith("W\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 7:
                    continue
                m = pw.findall(parts[6])
                ids = np.fromiter((int(x[1]) for x in m), np.int64, len(m))
                ori = np.fromiter((1 if x[0] == ">" else 0 for x in m), np.uint8, len(m))
                yield f"{parts[1]}#{parts[2]}#{parts[3]}", ids, ori, True


def _scan_haplotypes(gfa, distill=None):
    """pass1: P/W 名だけ読み hap 辞書を確定(H 固定にしてから token を流すため)。
       返り値 (hap_gid dict, hap_meta list[[key,sample,hap,n_paths]], n_p, n_w)。"""
    hap_gid = {}
    hap_meta = []
    n_p = n_w = 0
    for name, is_path in _iter_pw_names(gfa, distill):
        if is_path:
            n_p += 1
        else:
            n_w += 1
        sample, hap, _c = parse_group(name)
        gid = hap_gid.get(hap)
        if gid is None:
            gid = len(hap_meta)
            hap_gid[hap] = gid
            hap_meta.append([hap, sample, hap, 0])
        hap_meta[gid][3] += 1
    return hap_gid, hap_meta, n_p, n_w


def _stream_unique_sum(chunk_iter, merge_at=60_000_000, use_rust=False):
    """(key:int64[], w:int64[]) のチャンク列を、全チャンクを一度に載せずに
       sorted-unique key ごとの w 合算へ畳む(逐次マージ)。返り値 (uk, wsum)。
       ピーク = 走行集約 I + 未処理バッファ(<=merge_at) + マージ一時。二段集約は
       整数和が結合的(<2^63)なので単発 np.unique と厳密同値。
       use_rust=True で merge を emit_core.dedup_merge_sum(sort+集約→2-way マージ)に置換し
       np.unique(return_inverse)の一時 ~5倍(argsort/mask/cumsum/inverse; WG OOM 源)を ~2倍に抑える。
       numpy 経路と «同じ昇順 sorted-unique» を返すので結果は厳密同一。"""
    ec = None
    if use_rust:
        import emit_core as ec
    _EMPTY = np.empty(0, np.int64)
    run_k = run_w = None
    buf_k, buf_w, buf_n = [], [], 0

    def merge():
        nonlocal run_k, run_w, buf_k, buf_w, buf_n
        if buf_n == 0:
            return
        k = np.concatenate(buf_k)
        w = np.concatenate(buf_w)
        buf_k, buf_w, buf_n = [], [], 0
        if ec is not None:
            run_k, run_w = ec.dedup_merge_sum(
                run_k if run_k is not None else _EMPTY,
                run_w if run_w is not None else _EMPTY, k, w)
            return
        if run_k is not None:
            k = np.concatenate([run_k, k])
            w = np.concatenate([run_w, w])
        uk, inv = np.unique(k, return_inverse=True)
        run_w = np.bincount(np.asarray(inv).ravel(), weights=w, minlength=uk.size).astype(np.int64)
        run_k = uk

    for k, w in chunk_iter:
        if k.size == 0:
            continue
        buf_k.append(k)
        buf_w.append(w)
        buf_n += int(k.size)
        if buf_n >= merge_at:
            merge()
    merge()
    if run_k is None:
        return np.empty(0, np.int64), np.empty(0, np.int64)
    return run_k, run_w


class _SumAccum:
    """(key,w) を逐次 add し sorted-unique key ごとの w 合算へ畳む(RAM 有界)。_stream_unique_sum のクラス版で、
       node/edge を **1 走査で同時集約**するため 2 インスタンスを並行して回す用(GFA/distill 再走査を避ける)。
       二段集約は整数和が結合的なので単発 np.unique(return_counts)と厳密同値=結果 bit 一致。"""
    def __init__(self, merge_at=60_000_000, use_rust=False):
        self.merge_at = merge_at
        self._ec = __import__("emit_core") if use_rust else None
        self._E = np.empty(0, np.int64)
        self.run_k = None; self.run_w = None
        self._bk = []; self._bw = []; self._bn = 0

    def _merge(self):
        if self._bn == 0:
            return
        k = np.concatenate(self._bk); w = np.concatenate(self._bw)
        self._bk = []; self._bw = []; self._bn = 0
        if self._ec is not None:
            self.run_k, self.run_w = self._ec.dedup_merge_sum(
                self.run_k if self.run_k is not None else self._E,
                self.run_w if self.run_w is not None else self._E, k, w)
            return
        if self.run_k is not None:
            k = np.concatenate([self.run_k, k]); w = np.concatenate([self.run_w, w])
        uk, inv = np.unique(k, return_inverse=True)
        self.run_w = np.bincount(np.asarray(inv).ravel(), weights=w, minlength=uk.size).astype(np.int64)
        self.run_k = uk

    def add(self, k, w):
        if k.size == 0:
            return
        self._bk.append(k); self._bw.append(w); self._bn += int(k.size)
        if self._bn >= self.merge_at:
            self._merge()

    def finalize(self):
        self._merge()
        if self.run_k is None:
            return np.empty(0, np.int64), np.empty(0, np.int64)
        return self.run_k, self.run_w


class _SumAccum2:
    """2 列キー (khi, klo) の count 集約(RAM 有界)。1 列に詰めると i64 が溢れる場合用。
       用途: 辺多重度の (edge=lo*ntree+hi, hap)。edge は ntree²<2^63 で i64 に収まるが、×H(hap 数)で
       溢れる(WG×大H)ため hap を別列に。返り値 (khi, klo, wsum) は np.unique(axis=0,return_counts)と同一集合。"""
    def __init__(self, merge_at=60_000_000):
        self.merge_at = merge_at
        self.run_hi = None; self.run_lo = None; self.run_w = None
        self._bh = []; self._bl = []; self._bw = []; self._bn = 0

    def _merge(self):
        if self._bn == 0:
            return
        hi = np.concatenate(self._bh); lo = np.concatenate(self._bl); w = np.concatenate(self._bw)
        self._bh = []; self._bl = []; self._bw = []; self._bn = 0
        if self.run_hi is not None:
            hi = np.concatenate([self.run_hi, hi]); lo = np.concatenate([self.run_lo, lo])
            w = np.concatenate([self.run_w, w])
        key2 = np.stack([hi, lo], axis=1)
        uk, inv = np.unique(key2, axis=0, return_inverse=True)
        self.run_w = np.bincount(np.asarray(inv).ravel(), weights=w, minlength=uk.shape[0]).astype(np.int64)
        self.run_hi = np.ascontiguousarray(uk[:, 0]); self.run_lo = np.ascontiguousarray(uk[:, 1])

    def add(self, khi, klo, w):
        if khi.size == 0:
            return
        self._bh.append(khi); self._bl.append(klo); self._bw.append(w); self._bn += int(khi.size)
        if self._bn >= self.merge_at:
            self._merge()

    def finalize(self):
        self._merge()
        if self.run_hi is None:
            e = np.empty(0, np.int64)
            return e, e, e
        return self.run_hi, self.run_lo, self.run_w


class _SumSpill:
    """(key,w) を逐次 add し、budget ごとに dedup_merge_sum で sorted-unique run を disk へ吐く(ribbon _spill 同型)。
       RAM=O(budget)=**パス本数/incidence 非依存**(WG の要)。finalize_runs() が run ファイル列を返し、
       Rust の merge_runs(k-way マージ, w 合算)→per-layer flush が消費する。"""
    def __init__(self, spill_dir, prefix, budget=400_000_000):
        import emit_core
        self._ec = emit_core
        self.dir = spill_dir; self.prefix = prefix; self.budget = budget
        self._E = np.empty(0, np.int64)
        self._bk = []; self._bw = []; self._bn = 0
        self.runs = []
        os.makedirs(spill_dir, exist_ok=True)

    def _flush(self):
        if self._bn == 0:
            return
        uk, uw = self._ec.dedup_merge_sum(self._E, self._E,
                                          np.concatenate(self._bk), np.concatenate(self._bw))
        self._bk = []; self._bw = []; self._bn = 0
        p = os.path.join(self.dir, f"{self.prefix}{len(self.runs):04d}.bin")
        np.stack([uk, uw], axis=1).astype(np.int64, copy=False).tofile(p)  # 交互 (key,w) i64
        self.runs.append(p)

    def add(self, k, w):
        if k.size == 0:
            return
        self._bk.append(k); self._bw.append(w); self._bn += int(k.size)
        if self._bn >= self.budget:
            self._flush()

    def finalize_runs(self):
        self._flush()
        return self.runs


class _TripleSpill:
    """(c1,c2) を逐次 add(w=1)し、budget ごとに lexsort+run-length で sorted run(3値 (c1,c2,count))を disk へ。
       RAM=O(budget)=**パス本数/incidence 非依存**。edge mult disk 用: c1=lo, c2=hi*H+hap。
       run は (c1,c2) 昇順(内 unique)。Rust merge_runs3_sum(k-way, count 合算)→emit_hap_mult_edge_disk が消費。"""
    def __init__(self, spill_dir, prefix, budget=200_000_000):
        self.dir = spill_dir; self.prefix = prefix; self.budget = budget
        self._b1 = []; self._b2 = []; self._bn = 0
        self.runs = []
        os.makedirs(spill_dir, exist_ok=True)

    def _flush(self):
        if self._bn == 0:
            return
        c1 = np.concatenate(self._b1); c2 = np.concatenate(self._b2)
        self._b1 = []; self._b2 = []; self._bn = 0
        order = np.lexsort((c2, c1))                 # c1 主・c2 副で昇順
        c1 = c1[order]; c2 = c2[order]
        chg = np.empty(c1.size, bool); chg[0] = True
        chg[1:] = (c1[1:] != c1[:-1]) | (c2[1:] != c2[:-1])
        first = np.flatnonzero(chg)
        uc1 = c1[first]; uc2 = c2[first]
        counts = np.diff(np.append(first, c1.size)).astype(np.int64)   # w=1 → 重複数=count
        p = os.path.join(self.dir, f"{self.prefix}{len(self.runs):04d}.bin")
        np.stack([uc1, uc2, counts], axis=1).astype(np.int64, copy=False).tofile(p)  # (c1,c2,count) i64×3
        self.runs.append(p)

    def add(self, c1, c2):
        if c1.size == 0:
            return
        self._b1.append(c1); self._b2.append(c2); self._bn += int(c1.size)
        if self._bn >= self.budget:
            self._flush()

    def finalize_runs(self):
        self._flush()
        return self.runs


class _Sum2wSpill:
    """(key, w1, w2) を逐次 add し、budget ごと sort+reduceat(w1,w2 各々合算)で sorted run(key,w1,w2)を disk へ。
       RAM=O(budget)=**パス本数/incidence 非依存**。逆位 disk 用: key=leaf*C+gid, w1=totbp, w2=sum(rel*bp)。
       run は key 昇順(内 unique)。Rust merge_runs_2w(k-way, w1,w2 合算)→emit_contig_inv_disk が消費。"""
    def __init__(self, spill_dir, prefix, budget=200_000_000):
        self.dir = spill_dir; self.prefix = prefix; self.budget = budget
        self._bk = []; self._bw1 = []; self._bw2 = []; self._bn = 0
        self.runs = []
        os.makedirs(spill_dir, exist_ok=True)

    def _flush(self):
        if self._bn == 0:
            return
        k = np.concatenate(self._bk); w1 = np.concatenate(self._bw1); w2 = np.concatenate(self._bw2)
        self._bk = []; self._bw1 = []; self._bw2 = []; self._bn = 0
        order = np.argsort(k, kind="stable")
        k = k[order]; w1 = w1[order]; w2 = w2[order]
        uk, first = np.unique(k, return_index=True)
        sw1 = np.add.reduceat(w1, first).astype(np.int64)
        sw2 = np.add.reduceat(w2, first).astype(np.int64)
        p = os.path.join(self.dir, f"{self.prefix}{len(self.runs):04d}.bin")
        np.stack([uk.astype(np.int64), sw1, sw2], axis=1).tofile(p)   # (key,w1,w2) i64×3
        self.runs.append(p)

    def add(self, k, w1, w2):
        if k.size == 0:
            return
        self._bk.append(k); self._bw1.append(w1); self._bw2.append(w2); self._bn += int(k.size)
        if self._bn >= self.budget:
            self._flush()

    def finalize_runs(self):
        self._flush()
        return self.runs


class _MultFeeder:
    """§7.2 走査統合: ribbon の全トークン走査に相乗りして多重度 node/edge incidence を同時集約
       (mult 専用の GFA/distill 走査 1 本を削減)。ribbon が計算済みの leaf(=leaf[keep])と la/lb
       (=g で有効な連続葉対)をそのまま使う → mult 単独走査と **bit 一致**(選択条件・edge mask が同一)。
       accumulator は mult の disk/in-RAM と同型(disk: _SumSpill/_TripleSpill, in-RAM: _SumAccum/_SumAccum2)。
       emit_hap_mult が prefed でこれを受け、走査を省いて finalize のみ行う。"""
    def __init__(self, disk, spill_dir, contig2hap, H, ntree, use_rust):
        self.H = int(H); self.c2h = contig2hap; self.ntree = int(ntree); self.disk = bool(disk)
        self.spill_dir = spill_dir
        if disk:
            self.node_acc = _SumSpill(spill_dir, "nrun")
            self.edge_acc = _TripleSpill(spill_dir, "erun")
        else:
            self.node_acc = _SumAccum(use_rust=use_rust)
            self.edge_acc = _SumAccum2()

    def feed(self, gid, leaf, la_g, lb_g):
        """ribbon の _node_chunks から per-path 呼び出し。leaf=葉(keep 済), la_g/lb_g=有効連続葉対(源/先)。"""
        hap = int(self.c2h[gid])
        if leaf.size:
            self.node_acc.add(leaf * self.H + hap, np.ones(leaf.size, np.int64))
        if la_g.size:
            lo = np.minimum(la_g, lb_g); hi = np.maximum(la_g, lb_g)
            if self.disk:
                self.edge_acc.add(lo, hi * self.H + hap)             # (c1=lo, c2=hi*H+hap)
            else:
                eid = lo * self.ntree + hi
                self.edge_acc.add(eid, np.full(eid.size, hap, np.int64), np.ones(eid.size, np.int64))


def _triple_modes(base, H):
    """三つ組 (a<base, b<base, c<H) の dedup パッキング方式を選ぶ → (safe, two)。
       safe: (a*base+b)*H+c が int64 に収まる(base²·H<2^62) → 1D unique(8B/key, 最速)。
       two : safe 不可でも b*H+c が int64 に収まる(base·H<2^62) なら (a, b*H+c) の (N,2) unique(16B/行)。
             WG(base²·H が溢れる)向けの本命。(N,3) unique(24B/行)を避け OOM を回避。b*H+c は (b,c) と全単射で
             集合は (a,b,c) の unique と厳密同一 → 結果 bit 一致。どちらも不可なら (N,3) fallback。
       EMIT_FORCE_TRIPLE_2COL=1 で safe を無効化し two を強制(検証用: chr22 で safe と結果一致を確認するため)。"""
    if base <= 0:
        return False, False
    H1 = max(int(H), 1)
    safe = (base * base) < ((1 << 62) // H1)
    if os.environ.get("EMIT_FORCE_TRIPLE_2COL") == "1":
        safe = False
    two = (not safe) and (base * H1 < (1 << 62))
    return safe, two


def _stream_unique_triples(chunk_iter, base, H, merge_at=60_000_000, use_rust=False):
    """(a:int64[], b:int64[], c:int64[]) のチャンク列から相異なる三つ組集合を、
       全チャンクを載せずに逐次マージで求める。返り値 (a,b,c) 各 int64。
       a,b < base, c < H のとき key=(a*base+b)*H+c が 2^63 未満なら int64 1D 経路(高速)、
       溢れるなら 2D unique(axis=0) 経路(安全)。三つ組の重複除去は多重度に依らないので
       逐次でも単発でも同一集合。use_rust=True で merge を emit_core.dedup_merge_set1/2 に置換
       (np.unique(axis=0) の一時を抑え WG OOM を回避; 昇順 sorted-unique 集合は同一)。"""
    safe, two = _triple_modes(base, H)
    ec = None
    if use_rust:
        import emit_core as ec
    _EMPTY = np.empty(0, np.int64)
    run = None                      # numpy: 1D key / (m,2)or(m,3)。 rust two: (run_hi,run_lo)
    run_hi = run_lo = None
    buf, buf_hi, buf_lo, buf_n = [], [], [], 0

    def merge():
        nonlocal run, run_hi, run_lo, buf, buf_hi, buf_lo, buf_n
        if buf_n == 0:
            return
        if safe:
            k = np.concatenate(buf)
            if ec is not None:
                run = ec.dedup_merge_set1(run if run is not None else _EMPTY, k)
            else:
                if run is not None:
                    k = np.concatenate([run, k])
                run = np.unique(k)
            buf = []
        elif two:
            hi = np.concatenate(buf_hi); lo = np.concatenate(buf_lo)
            if ec is not None:
                run_hi, run_lo = ec.dedup_merge_set2(
                    run_hi if run_hi is not None else _EMPTY,
                    run_lo if run_lo is not None else _EMPTY, hi, lo)
            else:
                t = np.stack([hi, lo], axis=1)
                if run is not None:
                    t = np.concatenate([run, t], axis=0)
                run = np.unique(t, axis=0)      # (N,2) 16B/行
            buf_hi = []; buf_lo = []
        else:
            t = np.concatenate(buf, axis=0)
            if run is not None:
                t = np.concatenate([run, t], axis=0)
            run = np.unique(t, axis=0)          # (N,3) 24B/行(rust 未対応 fallback)
            buf = []
        buf_n = 0

    for a, b, c in chunk_iter:
        if a.size == 0:
            continue
        a = a.astype(np.int64); b = b.astype(np.int64); c = c.astype(np.int64)
        if safe:
            buf.append((a * base + b) * H + c)
        elif two:
            buf_hi.append(a); buf_lo.append(b * H + c)       # WG-safe: (a, b*H+c) を列分離
        else:
            buf.append(np.stack([a, b, c], axis=1))
        buf_n += int(a.size)
        if buf_n >= merge_at:
            merge()
    merge()
    if safe:
        if run is None:
            z = _EMPTY; return z, z, z
        c = (run % H).astype(np.int64)
        ab = run // H
        return (ab // base).astype(np.int64), (ab % base).astype(np.int64), c
    if two:
        if ec is not None:
            if run_hi is None:
                z = _EMPTY; return z, z, z
            a = run_hi; bc = run_lo
        else:
            if run is None:
                z = _EMPTY; return z, z, z
            a = np.ascontiguousarray(run[:, 0]); bc = run[:, 1]
        return (np.ascontiguousarray(a), (bc // H).astype(np.int64), (bc % H).astype(np.int64))
    if run is None:
        z = _EMPTY; return z, z, z
    return (np.ascontiguousarray(run[:, 0]), np.ascontiguousarray(run[:, 1]),
            np.ascontiguousarray(run[:, 2]))


class _TripleAccum:
    """_stream_unique_triples の逐次(.add)版。node 被覆と edge 通過を GFA の同一 1 パスから
       同時に畳むための融合用(node generator の副作用で本器に edge 三つ組を投入)。三つ組の
       重複除去は多重度・チャンク境界・投入順に非依存なので、結果は _stream_unique_triples と厳密同値。"""
    def __init__(self, base, H, merge_at=60_000_000, use_rust=False):
        self.base = base; self.H = H; self.merge_at = merge_at
        self.safe, self.two = _triple_modes(base, H)   # safe:1D / two:(a,b*H+c)(N,2) / else (N,3)
        self.ec = None
        if use_rust:
            import emit_core as _ec
            self.ec = _ec
        self._EMPTY = np.empty(0, np.int64)
        # safe/three: run=配列, buf=list。two: run=(run_hi,run_lo), buf=(buf_hi list, buf_lo list)。
        self.run = None; self.run_hi = None; self.run_lo = None
        self.buf = []; self.buf_hi = []; self.buf_lo = []; self.buf_n = 0

    def _merge(self):
        if self.buf_n == 0:
            return
        ec = self.ec
        if self.safe:
            k = np.concatenate(self.buf)
            if ec is not None:
                self.run = ec.dedup_merge_set1(self.run if self.run is not None else self._EMPTY, k)
            else:
                if self.run is not None:
                    k = np.concatenate([self.run, k])
                self.run = np.unique(k)
            self.buf = []
        elif self.two:
            hi = np.concatenate(self.buf_hi); lo = np.concatenate(self.buf_lo)
            if ec is not None:
                self.run_hi, self.run_lo = ec.dedup_merge_set2(
                    self.run_hi if self.run_hi is not None else self._EMPTY,
                    self.run_lo if self.run_lo is not None else self._EMPTY, hi, lo)
            else:
                t = np.stack([hi, lo], axis=1)
                if self.run is not None:
                    t = np.concatenate([self.run, t], axis=0)
                self.run = np.unique(t, axis=0)     # (N,2) 16B/行
            self.buf_hi = []; self.buf_lo = []
        else:
            t = np.concatenate(self.buf, axis=0)
            if self.run is not None:
                t = np.concatenate([self.run, t], axis=0)
            self.run = np.unique(t, axis=0)         # (N,3) 24B/行(rust 未対応 fallback)
            self.buf = []
        self.buf_n = 0

    def add(self, a, b, c):
        if a.size == 0:
            return
        a = a.astype(np.int64); b = b.astype(np.int64); c = c.astype(np.int64)
        if self.safe:
            self.buf.append((a * self.base + b) * self.H + c)
        elif self.two:
            self.buf_hi.append(a); self.buf_lo.append(b * self.H + c)   # (a, b*H+c) を列分離で保持
        else:
            self.buf.append(np.stack([a, b, c], axis=1))
        self.buf_n += int(a.size)
        if self.buf_n >= self.merge_at:
            self._merge()

    def finalize(self):
        self._merge()
        if self.safe:
            if self.run is None:
                z = self._EMPTY; return z, z, z
            c = (self.run % self.H).astype(np.int64)
            ab = self.run // self.H
            return (ab // self.base).astype(np.int64), (ab % self.base).astype(np.int64), c
        if self.two:
            if self.ec is not None:
                if self.run_hi is None:
                    z = self._EMPTY; return z, z, z
                a = self.run_hi; bc = self.run_lo
            else:
                if self.run is None:
                    z = self._EMPTY; return z, z, z
                a = np.ascontiguousarray(self.run[:, 0]); bc = self.run[:, 1]
            return (np.ascontiguousarray(a),
                    (bc // self.H).astype(np.int64), (bc % self.H).astype(np.int64))
        if self.run is None:
            z = self._EMPTY; return z, z, z
        return (np.ascontiguousarray(self.run[:, 0]), np.ascontiguousarray(self.run[:, 1]),
                np.ascontiguousarray(self.run[:, 2]))


class _EdgeSpill:
    """edge 三つ組(leaf_src,leaf_dst,contig)を RAM に溜めず disk へ吐く(disk リボン edge 用の _TripleAccum 置換)。
       **canonical leaf pair** (a=min,b=max) にして (a, b*C+contig) の 2 列で dedup_merge_set2 により
       sorted-unique 化し、budget ごとに run ファイルを書き出す。finalize() が run パス列を返す。
       a<b と rep_at の leaf 昇順単調性から Rust emit_edge_contig_cov_disk が Sa-flush で O(node+edge) 集約できる。
       .add(a,b,gid) の呼び出しは _node_chunks の副作用(edge_acc.add)から。API は _TripleAccum.add と互換。"""
    def __init__(self, C, spill_dir, budget=400_000_000):
        self.C = C; self.spill = spill_dir; self.budget = budget
        self.runs = []; self.ba = []; self.bl = []; self.bn = 0
        self._EMP = np.empty(0, np.int64)
        import emit_core
        self.ec = emit_core

    def _flush(self):
        if self.bn == 0:
            return
        a = np.concatenate(self.ba); l = np.concatenate(self.bl)
        self.ba = []; self.bl = []; self.bn = 0
        ua, ul = self.ec.dedup_merge_set2(self._EMP, self._EMP, a, l)   # (a, b*C+contig) 昇順 unique
        p = os.path.join(self.spill, f"erun{len(self.runs):04d}.bin")
        np.stack([ua, ul], axis=1).astype(np.int64, copy=False).tofile(p)  # 交互 (a, b*C+contig) i64
        self.runs.append(p)

    def add(self, a, b, gid):
        if a.size == 0:
            return
        a = a.astype(np.int64); b = b.astype(np.int64); gid = gid.astype(np.int64)
        lo = np.minimum(a, b); hi = np.maximum(a, b)            # canonical: lo<hi
        self.ba.append(lo); self.bl.append(hi * self.C + gid)
        self.bn += int(a.size)
        if self.bn >= self.budget:
            self._flush()

    def finalize(self):
        self._flush()
        return self.runs


def emit_ribbon_hapbytes(cur, con, gfa, sids, ord_ids, bp_row, row2node, rep_at,
                         born, b_born, d_born, start, maxlayer, ntree, sbp, t0, stream=True,
                         distill=None):
    """ハプロタイプ・リボンを『全層 dense 1バイト/hap・被覆率256段階』で書く(sparse 版 emit_ribbon の別実装)。

    現行 emit_ribbon(群=contig 粒度・(layer,node,group) 毎 1 行 + covered_bp + 索引2本)は最深・多ハプロで
    行数=被覆インシデンス数に比例して肥大する(chr22 で ~19GB 見積り; 特に高被覆な粗層で行あたり ~30-40B の
    オーバヘッドが効く)。本実装はハプロ粒度に限定し、各 super-node につき H バイト固定(位置=hap_id,
    値=round(255·covered_bp/node.size))の BLOB を 1 行だけ持つ。行あたりオーバヘッド・二次索引が消え、
    サイズは M(全層ノード数)×H に固定(粗層の高被覆でも増えない)。深層は frac≈1→255、粗層は部分被覆を
    そのまま量子化 → viewer は全層一律 byte>=round(θ·255) で θ 判定。
    node_rowid の再構成は emit_ribbon と同一((born, birth<=L<death) 反復・rid_base+1+index_in_P)。
    量子化は表示 θ 用途のみ(群の厳密 total_cov は hap_dict に別途保持)。
    """
    LEVELS = 256
    QMAX = float(LEVELS - 1)                       # 255
    INS_CHUNK = 400000                             # BLOB 挿入の一時リスト上限(chr22 のメモリ保険)

    edge_precomp = None                                # 融合: stream 時 node パスで edge 三つ組を先取り(下記)
    if stream:
        # ---- streaming: pass1で hap 辞書(H)を確定 → pass2 で token をバッチ流し (leaf,hap) 畳み込み ----
        #   全 T トークンを常駐させないので WG(数十億 token)でもピークは O(I incidence + バッファ)。
        hap_gid, hap_meta, n_p, n_w = _scan_haplotypes(gfa, distill)
        H = len(hap_meta)
        _hapcov_tables(cur, H, LEVELS)
        if H == 0:
            log("ribbon-hap: パス(P/W)行が無い → hap 表は空で作成のみ")
            con.commit()
            return dict(hap_gid), edge_precomp
        total_cov = np.zeros(H, np.int64)
        ntok = [0]
        # ---- 融合: node 被覆の1パスで edge 通過三つ組も畳む(GFA 走査を1本削減) ----
        #   _node_chunks の副作用として edge_acc.add() に (leaf_src,leaf_dst,hap) を投入。
        #   両畳み込みは投入順・境界非依存ゆえ、別パスの _stream_unique_triples と厳密同値(bit-identical)。
        netok = [0]
        edge_acc = _TripleAccum(ntree, H)

        def _node_chunks():
            # GFA/distill いずれからも (name, raw, is_walk) を取り、body は不変(distill=dense token でも同一)。
            for name, raw, _iw in _iter_pw_tokens(gfa, distill):
                gid = hap_gid.get(parse_group(name)[1])
                if gid is None or len(raw) == 0:
                    continue
                pid = np.asarray(raw, dtype=np.int64)
                pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
                ok = sids[pos] == pid
                oi = ord_ids[pos]                        # 全位置の ord id(未一致含む)
                leaf_full = row2node[oi]                 # 全位置の葉(edge 隣接判定に未マスクで要る)
                # --- edge 通過三つ組(emit_edge_hap_cov._edge_chunks と同一ロジック) ---
                if leaf_full.size >= 2:
                    lseq = leaf_full.copy()              # copy: node 側 leaf_full を破壊しない
                    lseq[~ok] = -1                       # 未一致は -1(隣接ペアを跨がせない)
                    la = lseq[:-1]; lb = lseq[1:]
                    g = (la >= 0) & (lb >= 0) & (la != lb)
                    if g.any():
                        ng = int(g.sum()); netok[0] += ng
                        edge_acc.add(la[g].astype(np.int64), lb[g].astype(np.int64),
                                     np.full(ng, gid, np.int64))
                # --- node 被覆(旧 _node_chunks と同一: rows=ord_ids[pos[ok]]) ---
                leaf = leaf_full[ok]                     # == row2node[ord_ids[pos[ok]]]
                keep = leaf >= 0
                if not keep.any():
                    continue
                leaf = leaf[keep]
                bp = np.maximum(bp_row[oi[ok][keep]].astype(np.int64), 1)   # oi[ok][keep]==rows[keep]
                total_cov[gid] += int(bp.sum())
                ntok[0] += int(leaf.size)
                yield leaf.astype(np.int64) * H + np.int64(gid), bp
        run_k, bp_inc = _stream_unique_sum(_node_chunks())
        # generator を消費し終えた時点で edge_acc に全 P/W の通過エッジ三つ組が入っている。
        es, ed, eg = edge_acc.finalize()
        edge_precomp = (es, ed, eg, netok[0])
        if run_k.size == 0:
            log("ribbon-hap: 一致 token 0 → hap 表は空で作成のみ")
            con.commit()
            return dict(hap_gid), edge_precomp
        leaf_raw = run_k // H
        hap_inc = (run_k % H).astype(np.int64)                       # hap gid (0..H-1)
        uniq_leaf = np.unique(leaf_raw)
        leaf_idx_inc = np.searchsorted(uniq_leaf, leaf_raw)          # uniq_leaf index (0..U-1)
        del run_k, leaf_raw
        log(f"ribbon-hap[stream]: H={H} P={n_p} W={n_w} T={ntok[0]:,} -> I={leaf_idx_inc.size:,} "
            f"({100.0 * leaf_idx_inc.size / max(ntok[0], 1):.1f}%) blob={H}B/node")
    else:
        # ---- 非streaming(旧): 全 P/W 行を走査 → concat → 単発 np.unique(ピーク O(T)) ----
        hap_gid = {}
        hap_meta = []                                  # gid -> [key, sample, hap, n_paths]
        row_parts, gid_parts = [], []
        n_p = n_w = 0
        for name, raw, is_w in _iter_pw_tokens(gfa, distill):
            if is_w:
                n_w += 1
            else:
                n_p += 1
            sample, hap, _contig = parse_group(name)
            gid = hap_gid.get(hap)
            if gid is None:
                gid = len(hap_meta)
                hap_gid[hap] = gid
                hap_meta.append([hap, sample, hap, 0])
            hap_meta[gid][3] += 1
            if len(raw) == 0:
                continue
            pid = np.asarray(raw, dtype=np.int64)
            pos = np.searchsorted(sids, pid); pos = np.clip(pos, 0, len(sids) - 1)
            ok = sids[pos] == pid
            rows = ord_ids[pos[ok]]
            if rows.size == 0:
                continue
            row_parts.append(rows.astype(np.int64))
            gid_parts.append(np.full(rows.size, gid, dtype=np.int32))   # hap≤~数百 → int32
        H = len(hap_meta)
        _hapcov_tables(cur, H, LEVELS)
        if H == 0 or not row_parts:
            log("ribbon-hap: パス(P/W)行が無い(または一致 token 0) → hap 表は空で作成のみ")
            con.commit()
            return dict(hap_gid), edge_precomp        # 非stream: edge_precomp=None(edge は自前再走査)
        row_all = np.concatenate(row_parts)
        gid_all = np.concatenate(gid_parts)
        del row_parts, gid_parts

        # token(npz row) -> 木の葉。葉が無い token は捨てる。(chr22=205M token 級なので即時解放/dtype 縮小)
        leaf_all = row2node[row_all]
        keep = leaf_all >= 0
        leaf_all = leaf_all[keep]
        gid_all = gid_all[keep]
        bp_all = np.maximum(bp_row[row_all[keep]].astype(np.int32), 1)   # 葉bp=S行長→int32
        del row_all                                                       # 以降不要
        log(f"ribbon-hap: haplotypes(H)={H} P={n_p} W={n_w} tokens={leaf_all.size:,} blob={H}B/node")

        total_cov = np.bincount(gid_all, weights=bp_all, minlength=H).astype(np.int64)
        uniq_leaf, inv_leaf = np.unique(leaf_all, return_inverse=True)
        inv_leaf = np.asarray(inv_leaf).ravel()                           # token -> uniq_leaf index
        n_tok = leaf_all.size
        del leaf_all
        # ---- token 軸 T を (leaf,hap) インシデンス軸 I へ 1 度だけ畳む(層ループを O(T)→O(I) に) ----
        # 可視 super-node vis は葉のみの関数(rep_at)なので、(vis,hap) 集約の結果は token 直接集約と厳密一致。
        # 同一 (leaf,hap) の bp を先に合算しておけば、層ループで T サイズ配列を一切作らずに済む。
        lkey = inv_leaf.astype(np.int64) * H + gid_all                    # size T (int64): (leaf,hap) 一意キー
        del inv_leaf, gid_all
        uk0, invk0 = np.unique(lkey, return_inverse=True)                 # I 個の (leaf,hap) incidence
        del lkey
        bp_inc = np.bincount(np.asarray(invk0).ravel(), weights=bp_all,
                             minlength=uk0.size).astype(np.int64)         # incidence ごとの合算 bp
        del invk0, bp_all
        leaf_idx_inc = uk0 // H                                           # uniq_leaf index (0..U-1)
        hap_inc = (uk0 % H).astype(np.int64)                             # hap gid (0..H-1)
        del uk0
        log(f"ribbon-hap: incidence 畳み込み T={n_tok:,} -> I={leaf_idx_inc.size:,} "
            f"({100.0 * leaf_idx_inc.size / max(n_tok, 1):.1f}%)")

    ins = "INSERT INTO node_hap_cov(node_rowid,cov) VALUES(?,?)"
    rid_base = 0
    rows_written = 0
    for L in range(start, maxlayer + 1):
        Lw = L - start
        P = born[(b_born <= L) & (L < d_born)]     # 本体ノードループと同一
        k = len(P)
        if k == 0:
            continue
        posmap = np.full(ntree, -1, np.int64)      # tree-node -> P 内 index(=rowid-rid_base-1)
        posmap[P] = np.arange(k)
        vis = rep_at(uniq_leaf, L)[leaf_idx_inc]    # incidence ごとの可視 super-node(tree index)
        # (vis, hap) 毎に covered_bp を集約。軸は T でなく I(incidence)なのでピーク O(I)。
        key = vis * H + hap_inc
        del vis
        uk, invk = np.unique(key, return_inverse=True)
        del key
        sums = np.bincount(np.asarray(invk).ravel(), weights=bp_inc, minlength=uk.size).astype(np.int64)
        del invk
        vis_u = uk // H
        hap_u = (uk % H).astype(np.int64)
        idx_in_P = posmap[vis_u]
        good = idx_in_P >= 0                        # 在圏代表は必ず P に居る(保険)
        idx_in_P = idx_in_P[good]; hap_u = hap_u[good]; sums = sums[good]; vis_u = vis_u[good]
        # 量子化: byte = clip(round(255·covered_bp/node.size),1,255)(被覆あれば最低1でθ=0時も可視)
        sz = np.maximum(sbp[vis_u], 1.0)
        q = np.clip(np.rint(QMAX * sums / sz), 1.0, QMAX).astype(np.uint8)
        # dense (k×H) uint8 に散布 → 非ゼロ行(=被覆ありノード)だけ書く
        blob = np.zeros((k, H), np.uint8)
        blob[idx_in_P, hap_u] = q
        nz = np.where(blob.any(axis=1))[0]
        for c0 in range(0, len(nz), INS_CHUNK):
            sub = nz[c0:c0 + INS_CHUNK]
            cur.executemany(ins, [(int(rid_base + 1 + i), blob[i].tobytes()) for i in sub.tolist()])
        rows_written += len(nz)
        rid_base += k
        con.commit()
        log(f"  ribbon-hap L{Lw}(旧L{L}): nodes-with-cov={len(nz):,}/{k:,}")

    cur.executemany(
        "INSERT INTO hap_dict(hap_id,key,sample,haplotype,n_paths,total_cov) VALUES(?,?,?,?,?,?)",
        [(gid, m[0], m[1], m[2], m[3], int(total_cov[gid])) for gid, m in enumerate(hap_meta)])
    con.commit()
    log(f"ribbon-hap[done] H={H} node_hap_cov-rows={rows_written:,} blob={H}B ({time.time()-t0:.1f}s)")
    return dict(hap_gid), edge_precomp


def emit_edge_hap_cov(cur, con, gfa, sids, ord_ids, row2node, rep_at,
                      en_i, en_j, start, maxlayer, ntree, hap_gid, t0, stream=True, precomp=None,
                      distill=None):
    """エッジ・ハプロ被覆をビットセットで書く(edge_hap_cov)。

    ノード被覆(emit_ribbon_hapbytes)だけだと viewer は『両端ノードが被覆ならエッジを描く』しかできず、
    indel の弦(欠失 A→C が挿入 A→B→C と併存)・巡回/再訪・super-node 集約で **偽エッジ**を生む
    (chr22 grch38 葉層で実測 ~6.3%)。本表はパスの **連続ノード対=実際に通過した(super-)エッジ**にだけ
    hap の bit を立てるので、viewer は `mask の bit h`(かつ両端が θ 可視)で忠実に描ける。
    edge_rowid は本体エッジループ(§8 の for L)と **同一の per-layer 反復**で一致させる:
      ga=rep_at(en_i,L); gb=rep_at(en_j,L); m=ga!=gb; key=min·ntree+max; uk=unique(key); rowid=e_rid+1+idx。
    エッジ通過は2値なので割合不要、mask=ceil(H/8) バイトのビットセット(1バイト/hap の 1/8)。
    """
    H = len(hap_gid)
    maskbytes = (H + 7) // 8
    _edge_hapcov_table(cur)
    if H == 0:
        con.commit()
        return

    # ---- P/W 走査: パスの連続ノード対(leaf_src, leaf_dst, hap)。gid は hap_dict と同一(hap_gid を共有) ----
    if precomp is not None:
        # 融合: emit_ribbon_hapbytes の node パスが同一走査で集めた通過三つ組を再利用(GFA 再走査なし)。
        #   三つ組は _stream_unique_triples と厳密同値(相異なる集合・順序非依存)ゆえ出力は bit-identical。
        src_raw, dst_raw, egid, netok_val = precomp
        if src_raw.size == 0:
            log("edge-hap: 通過エッジ token 0 → edge_hap_cov は空で作成のみ")
            con.commit()
            return
        uniq_leaf = np.unique(np.concatenate([src_raw, dst_raw]))
        si = np.searchsorted(uniq_leaf, src_raw).astype(np.int32)
        di = np.searchsorted(uniq_leaf, dst_raw).astype(np.int32)
        egid = egid.astype(np.int32)
        log(f"edge-hap[fused]: H={H} maskbytes={maskbytes} T={netok_val:,} -> I={si.size:,} "
            f"({100.0 * si.size / max(netok_val, 1):.1f}%)")
    elif stream:
        # streaming: 通過エッジ token を全載せせず、相異なる三つ組を逐次マージで畳む。
        netok = [0]

        def _edge_chunks():
            for name, raw, _iw in _iter_pw_tokens(gfa, distill):
                if len(raw) < 2:
                    continue
                gid = hap_gid.get(parse_group(name)[1])
                if gid is None:
                    continue
                pid = np.asarray(raw, dtype=np.int64)
                pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
                ok = sids[pos] == pid
                leaf_seq = row2node[ord_ids[pos]]          # 各位置の葉(fancy index=新配列, 破壊安全)
                leaf_seq[~ok] = -1                          # 未一致は -1(隣接ペアを跨がせない)
                la = leaf_seq[:-1]; lb = leaf_seq[1:]
                g = (la >= 0) & (lb >= 0) & (la != lb)
                if not g.any():
                    continue
                netok[0] += int(g.sum())
                yield (la[g].astype(np.int64), lb[g].astype(np.int64),
                       np.full(int(g.sum()), gid, np.int64))
        src_raw, dst_raw, egid = _stream_unique_triples(_edge_chunks(), ntree, H)
        if src_raw.size == 0:
            log("edge-hap: 通過エッジ token 0 → edge_hap_cov は空で作成のみ")
            con.commit()
            return
        uniq_leaf = np.unique(np.concatenate([src_raw, dst_raw]))
        si = np.searchsorted(uniq_leaf, src_raw).astype(np.int32)
        di = np.searchsorted(uniq_leaf, dst_raw).astype(np.int32)
        egid = egid.astype(np.int32)
        del src_raw, dst_raw
        log(f"edge-hap[stream]: H={H} maskbytes={maskbytes} T={netok[0]:,} -> I={si.size:,} "
            f"({100.0 * si.size / max(netok[0], 1):.1f}%)")
    else:
        esrc_parts, edst_parts, egid_parts = [], [], []
        for name, raw, _iw in _iter_pw_tokens(gfa, distill):
            if len(raw) < 2:
                continue
            _s, hap, _c = parse_group(name)
            gid = hap_gid.get(hap)
            if gid is None:
                continue
            pid = np.asarray(raw, dtype=np.int64)
            pos = np.searchsorted(sids, pid); pos = np.clip(pos, 0, len(sids) - 1)
            ok = sids[pos] == pid
            leaf_seq = row2node[ord_ids[pos]]          # 各パス位置の葉(pos は clip 済で index 安全)
            leaf_seq[~ok] = -1                          # 未一致は -1 に(隣接ペアを跨がせない=偽エッジ防止)
            la = leaf_seq[:-1]; lb = leaf_seq[1:]
            g = (la >= 0) & (lb >= 0) & (la != lb)      # 両端マップ済かつ別ノード=実通過エッジ
            if not g.any():
                continue
            esrc_parts.append(la[g].astype(np.int64))
            edst_parts.append(lb[g].astype(np.int64))
            egid_parts.append(np.full(int(g.sum()), gid, np.int32))
        if not esrc_parts:
            log("edge-hap: 通過エッジ token 0 → edge_hap_cov は空で作成のみ")
            con.commit()
            return
        esrc = np.concatenate(esrc_parts); edst = np.concatenate(edst_parts)
        egid = np.concatenate(egid_parts)
        del esrc_parts, edst_parts, egid_parts
        log(f"edge-hap: H={H} maskbytes={maskbytes} traversed-edge-tokens={esrc.size:,}")

        # 葉を圧縮 index 化(rep_at を毎層ユニーク葉にだけ適用しコスト削減; esrc/edst は必ず uniq_leaf に含まれる)
        uniq_leaf = np.unique(np.concatenate([esrc, edst]))
        si = np.searchsorted(uniq_leaf, esrc).astype(np.int32)
        di = np.searchsorted(uniq_leaf, edst).astype(np.int32)
        del esrc, edst
        # ---- 通過エッジ token を (leaf_src,leaf_dst,hap) の相異なる三つ組へ 1 度だけ畳む ----
        # 各層の uc=unique((super-edge,hap)) は三つ組の集合のみに依存し多重度に依らないので、
        # 事前に重複を落としても書き込む bit は厳密不変。層ループを O(T_edge)->O(I_edge) に。
        n_etok = si.size
        etrip = np.unique(np.stack([si, di, egid.astype(np.int32)], axis=1), axis=0)
        si = np.ascontiguousarray(etrip[:, 0]); di = np.ascontiguousarray(etrip[:, 1])
        egid = np.ascontiguousarray(etrip[:, 2])
        del etrip
        log(f"edge-hap: incidence 畳み込み T={n_etok:,} -> I={si.size:,} "
            f"({100.0 * si.size / max(n_etok, 1):.1f}%)")

    ins = "INSERT INTO edge_hap_cov(edge_rowid,mask) VALUES(?,?)"
    e_rid = 0
    rows_written = 0
    for L in range(start, maxlayer + 1):
        # --- 本体エッジループと同一のエッジ集合・rowid を再現 ---
        ga = rep_at(en_i, L); gb = rep_at(en_j, L)
        m = ga != gb
        if not np.any(m):
            continue                                   # 本体と同じく rowid を消費しない
        a = ga[m]; b = gb[m]
        key = np.minimum(a, b) * ntree + np.maximum(a, b)
        uk = np.unique(key)                            # ソート済; 局所 index j → rowid=e_rid+1+j
        ke = len(uk)
        # --- hap 通過: ユニーク葉 → 可視 super-node、連続対を super-edge へ ---
        vis_of = rep_at(uniq_leaf, L)
        vsrc = vis_of[si]; vdst = vis_of[di]
        mm = vsrc != vdst                              # 同一 super-node に畳まれた対は内部辺→除外
        lo = np.minimum(vsrc[mm], vdst[mm]); hi = np.maximum(vsrc[mm], vdst[mm])
        del vsrc, vdst
        tkey = lo * ntree + hi
        del lo, hi
        tgid = egid[mm]
        comb = tkey * H + tgid                          # (super-edge, hap) を一意化
        del tkey
        uc = np.unique(comb)
        del comb
        ek = uc // H; eh = (uc % H).astype(np.int64)
        idx = np.searchsorted(uk, ek)                  # 本層エッジ集合内の局所 index
        idx = np.clip(idx, 0, ke - 1)
        valid = uk[idx] == ek                          # 通過エッジは必ず uk にある(保険で不一致を捨てる)
        idx = idx[valid]; eh = eh[valid]
        blob = np.zeros((ke, maskbytes), np.uint8)
        np.bitwise_or.at(blob, (idx, (eh >> 3)), (1 << (eh & 7)).astype(np.uint8))
        nz = np.where(blob.any(axis=1))[0]
        for c0 in range(0, len(nz), 400000):
            sub = nz[c0:c0 + 400000]
            cur.executemany(ins, [(int(e_rid + 1 + i), blob[i].tobytes()) for i in sub.tolist()])
        rows_written += len(nz)
        e_rid += ke
        con.commit()
        log(f"  edge-hap L{L-start}(旧L{L}): edges-with-hap={len(nz):,}/{ke:,}")
    log(f"edge-hap[done] rows={rows_written:,} maskbytes={maskbytes} ({time.time()-t0:.1f}s)")


# ===== contig 前向き索引(hap 索引の一本化置換) =====================================
# 動機: hap 索引(node_hap_cov, 幅 H=hap 数の dense バイト)では contig を出せない(contig は sample/hap 内で
#   さらに多数)。かつ 各ノードに「全 contig の通過有無」を dense(幅 C)で持つと M×C で破綻。しかし
#   同一ハプロの別 contig は互いにノードをほとんど共有しない(実測 (node,contig)≈(node,hap)×1.4)ため、
#   各ノードに「実際に通る contig の疎リスト」だけを持てば hap 索引と同オーダーで収まる。
#   contig→hap→sample が一意に決まるので、この1索引で sample/hap/contig の全リボンを賄える(hap 表は不要)。
# 設計: contig_id を (sample, hap, contig) 昇順に採番 → ある hap の contig 群・ある sample の contig 群は
#   いずれも連続 id レンジ。backend は選択レベルを [lo,hi] レンジにして、ノードの昇順 contig-id リストへ
#   binary search でレンジ照合(hap 索引の byte/bit 参照と同じ「可視ノードだけ触る」高速クエリ)。
#   BLOB: node = [u32 count][count×u32 contig_id 昇順][count×u8 cov]、edge = [u32 count][count×u32 id 昇順]。

def _scan_contigs(gfa, distill=None):
    """pass1: P/W 名だけ読み contig 辞書を確定。gid は (sample, hap, contig) 昇順で採番するので、
       hap/sample は contig_id の連続レンジになり backend は MIN/MAX(contig_id) で範囲照合できる。
       返り値 (contig_gid dict[contig_key->gid], contig_meta list[[key,sample,hap,short,n_paths]], n_p, n_w)。"""
    info = {}                                       # contig_key -> [sample, hap, short, n_paths]
    n_p = n_w = 0
    for name, is_path in _iter_pw_names(gfa, distill):
        if is_path:
            n_p += 1
        else:
            n_w += 1
        sample, hap, contig = parse_group(name)
        rec = info.get(contig)
        if rec is None:
            short = contig.split("#")[-1] if "#" in contig else contig
            info[contig] = [sample, hap, short, 1]
        else:
            rec[3] += 1
    keys = sorted(info.keys(), key=lambda c: (info[c][0], info[c][1], c))   # (sample, hap, contig) 昇順
    contig_gid = {}
    contig_meta = []
    for gid, c in enumerate(keys):
        s, h, short, npaths = info[c]
        contig_gid[c] = gid
        contig_meta.append([c, s, h, short, npaths])
    return contig_gid, contig_meta, n_p, n_w


def _contigcov_tables(cur, n_contig, levels):
    """contig 前向き索引のテーブル(hap 索引 node_hap_cov 系の置換)。
       node_contig_cov.node_rowid は INTEGER PRIMARY KEY(=rowid 別名)で二次索引不要=サイズ最小。"""
    cur.execute("DROP TABLE IF EXISTS contig_dict")
    cur.execute("DROP TABLE IF EXISTS node_contig_cov")
    cur.execute("DROP TABLE IF EXISTS contigcov_meta")
    cur.execute("CREATE TABLE contig_dict(contig_id INTEGER PRIMARY KEY, key TEXT, "
                "sample TEXT, haplotype TEXT, contig TEXT, n_paths INTEGER, total_cov INTEGER)")
    # blob = [u32 count][count×u32 contig_id 昇順(little-endian)][count×u8 cov]。
    #   cov = round((levels-1)·covered_bp/node.size)。位置は不要(id が自明に昇順)。
    #   hb(A-2) = このノードを通る distinct haplotype 数(太さ/クラスタ被覆用の事前計算スカラー)。
    #   contig 単位でなく hap 単位なので 1サンプル複数 contig の過剰計上を排除。NULL=未計算(rust 経路は
    #   当面 NULL、後で Rust climb 内に統合)。viewer は rowid で相乗り取得し粗ズームの毎フレーム集計を回避。
    cur.execute("CREATE TABLE node_contig_cov(node_rowid INTEGER PRIMARY KEY, blob BLOB, hb INTEGER)")
    cur.execute("CREATE TABLE contigcov_meta(n_contig INTEGER, levels INTEGER)")
    cur.execute("INSERT INTO contigcov_meta(n_contig,levels) VALUES(?,?)", (n_contig, levels))
    cur.execute("CREATE INDEX IF NOT EXISTS idx_contig_dict_hap ON contig_dict(haplotype)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_contig_dict_sample ON contig_dict(sample)")


def _edge_contigcov_table(cur):
    """エッジ contig 索引。エッジ通過は2値なので cov 不要、blob=[u32 count][count×u32 id 昇順]。
       edge_contig_cov.edge_rowid は edges.rowid と一致(INTEGER PRIMARY KEY=rowid 別名, 二次索引ゼロ=最小)。
       hb(A-2) = このエッジを通る distinct haplotype 数(flubble flow/エッジ太さ用の事前計算スカラー)。"""
    cur.execute("DROP TABLE IF EXISTS edge_contig_cov")
    cur.execute("CREATE TABLE edge_contig_cov(edge_rowid INTEGER PRIMARY KEY, blob BLOB, hb INTEGER)")


def _pack_contig_rows(rid_base, node_local, cids, covs, ins_chunk, contig2hap=None):
    """(node_local:int64 0..k-1, cids:int64 contig_id, covs:uint8|None) を (node, contig) 昇順に並べ、
       node ごとに blob=[u32 count][count×u32 cid 昇順]([count×u8 cov]) を作って
       [(rid_base+1+node, blob)] のバッチを yield する(node 内 cid は昇順を保証)。
       contig2hap(contig_id→hap_id, 長さ C)を渡すと A-2 の hap-breadth(distinct haplotype 数)を各
       node ごとに算出し (rowid, blob, hb) の3組を yield する(未指定なら従来の2組)。
       contig_id は (sample,hap,contig) 昇順採番=同一 node の昇順 cid 内で hap_id 単調 → distinct 数は
       境界カウントで得られるが、正しさ優先で np.unique.size を使う(chrY/chr22 の Python 参照実装)。"""
    if node_local.size == 0:
        return
    order = np.argsort(node_local.astype(np.int64) * (int(cids.max()) + 1) + cids, kind="stable") \
        if cids.size else np.arange(0)
    # cids は < C。node_local*(cids.max()+1)+cids は (node, contig) 辞書順(オーバフロー回避に max+1 を基数)。
    ns = node_local[order]
    cs = cids[order].astype("<u4")
    cvs = covs[order] if covs is not None else None
    unode, first = np.unique(ns, return_index=True)
    counts = np.diff(np.append(first, ns.size))
    batch = []
    for gi in range(unode.size):
        s = int(first[gi]); c = int(counts[gi])
        cnt = np.uint32(c).tobytes()
        idb = cs[s:s + c].tobytes()
        if cvs is not None:
            blob = cnt + idb + cvs[s:s + c].tobytes()
        else:
            blob = cnt + idb
        if contig2hap is not None:
            hb = int(np.unique(contig2hap[cs[s:s + c].astype(np.int64)]).size)
            batch.append((int(rid_base + 1 + unode[gi]), blob, hb))
        else:
            batch.append((int(rid_base + 1 + unode[gi]), blob))
        if len(batch) >= ins_chunk:
            yield batch
            batch = []
    if batch:
        yield batch


def _build_contig2hap(contig_meta):
    """contig_id → hap_id(distinct (sample,haplotype) を出現順=gid 昇順に採番)と n_hap を返す。
       _scan_contigs が (sample,hap,contig) 昇順で gid を振るので hap_id は gid に対し単調非減少。"""
    C = len(contig_meta)
    c2h = np.empty(C, np.int64)
    last = None
    hid = -1
    for gid in range(C):
        hk = (contig_meta[gid][1], contig_meta[gid][2])   # (sample, haplotype)
        if hk != last:
            hid += 1
            last = hk
        c2h[gid] = hid
    return c2h, hid + 1


def emit_ribbon_contig(cur, con, gfa, sids, ord_ids, bp_row, row2node, rep_at,
                       born, b_born, d_born, start, maxlayer, ntree, sbp, t0, stream=True,
                       distill=None, rust_layers=False, out_db=None,
                       birth=None, death=None, fp=None, ribbon_disk=False, ribbon_spill_dir=None,
                       emit_mult=False, mult_out=None):
    """contig 前向き索引を全層で書く(emit_ribbon_hapbytes の group=contig・疎ストレージ版)。
       畳み上げ・incidence 構造は hapbytes と同一(group が hap→contig、dense byte→疎 (id,cov) リスト)。
       返り値 (contig_gid dict, edge_precomp(融合 stream 時), contig_meta, total_cov)。"""
    LEVELS = 256
    QMAX = float(LEVELS - 1)
    INS_CHUNK = 200000

    contig_gid, contig_meta, n_p, n_w = _scan_contigs(gfa, distill)
    C = len(contig_meta)
    # rust_layers: 自前接続でテーブル作成/contig_dict を扱い per-layer は Rust。main の con に触れない。
    if rust_layers:
        _con = sqlite3.connect(out_db); _cur = _con.cursor()
        _con.execute("PRAGMA synchronous=OFF"); _con.execute("PRAGMA journal_mode=OFF")
    else:
        _con, _cur = con, cur
    _contigcov_tables(_cur, C, LEVELS)
    edge_precomp = None
    if C == 0:
        log("ribbon-contig: パス(P/W)行が無い → contig 表は空で作成のみ")
        _con.commit()
        if rust_layers:
            _con.close()
        return dict(contig_gid), edge_precomp, contig_meta, np.zeros(0, np.int64)
    total_cov = np.zeros(C, np.int64)

    if stream:
        # ---- streaming: token を全載せせず (leaf,contig) incidence を逐次マージ。node パスの副作用で
        #      edge 三つ組(leaf_src,leaf_dst,contig)も同時に畳む(GFA 走査 1 本削減)。hapbytes と同型。 ----
        ntok = [0]; netok = [0]
        # §7.2 走査統合: mult を ribbon 走査へ相乗り(stream 経路のみ)。ribbon の leaf/la/lb を再利用 → bit 一致。
        mult_feeder = None
        if emit_mult and mult_out is not None:
            _c2h_m, _Hm = _build_contig2hap(contig_meta)
            _mspill = (os.path.join(ribbon_spill_dir or os.path.dirname(out_db) or ".", "mult_spill")
                       if ribbon_disk else None)
            mult_feeder = _MultFeeder(ribbon_disk, _mspill, _c2h_m, _Hm, ntree, rust_layers)
            mult_out.append(mult_feeder)
        _EMPTY_I64 = np.empty(0, np.int64)
        if ribbon_disk:
            _spill_dir = os.path.join(ribbon_spill_dir or os.path.dirname(out_db) or ".", "ribbon_spill")
            os.makedirs(_spill_dir, exist_ok=True)
            edge_acc = _EdgeSpill(C, _spill_dir)          # edge 三つ組も disk spill(node と同じ枠)
        else:
            edge_acc = _TripleAccum(ntree, C, use_rust=rust_layers)

        def _node_chunks():
            for name, raw, _iw in _iter_pw_tokens(gfa, distill):
                gid = contig_gid.get(parse_group(name)[2])
                if gid is None or len(raw) == 0:
                    continue
                pid = np.asarray(raw, dtype=np.int64)
                pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
                ok = sids[pos] == pid
                oi = ord_ids[pos]
                leaf_full = row2node[oi]
                _mla = _EMPTY_I64; _mlb = _EMPTY_I64          # mult edge 用(有効連続葉対 源/先)
                if leaf_full.size >= 2:
                    lseq = leaf_full.copy()
                    lseq[~ok] = -1
                    la = lseq[:-1]; lb = lseq[1:]
                    g = (la >= 0) & (lb >= 0) & (la != lb)
                    if g.any():
                        _mla = la[g].astype(np.int64); _mlb = lb[g].astype(np.int64)
                        ng = _mla.size; netok[0] += ng
                        edge_acc.add(_mla, _mlb, np.full(ng, gid, np.int64))
                leaf = leaf_full[ok]
                keep = leaf >= 0
                if not keep.any():
                    if mult_feeder is not None and _mla.size:      # node 無しでも edge は相乗り
                        mult_feeder.feed(gid, _EMPTY_I64, _mla, _mlb)
                    continue
                leaf = leaf[keep]
                bp = np.maximum(bp_row[oi[ok][keep]].astype(np.int64), 1)
                total_cov[gid] += int(bp.sum())
                ntok[0] += int(leaf.size)
                if mult_feeder is not None:
                    mult_feeder.feed(gid, leaf.astype(np.int64), _mla, _mlb)
                yield leaf.astype(np.int64) * C + np.int64(gid), bp

        if ribbon_disk:
            # ---- disk-streaming: incidence を RAM に持たず (key,bp) を sorted run へ吐き出し、
            #      Rust(emit_ribbon_contig_disk)が k-way マージ + per-layer flush-on-vis で発行。
            #      RAM=O(node)。WG 巨大 incidence(node×contig 被覆)で np.unique/keybp の O(I) を回避。
            import emit_core
            spill = _spill_dir                          # edge_acc と同じ spill dir(node 前計算済)
            _EMP = np.empty(0, np.int64)
            runs = []
            _bk, _bw, _bn = [], [], 0
            _BUDGET = 400_000_000        # ~6.4GB/run(deduped)。RAM 上限の定数(I 非依存)。
            def _spill():
                nonlocal _bk, _bw, _bn
                if _bn == 0:
                    return
                uk, uw = emit_core.dedup_merge_sum(_EMP, _EMP, np.concatenate(_bk), np.concatenate(_bw))
                _bk, _bw, _bn = [], [], 0
                p = os.path.join(spill, f"run{len(runs):04d}.bin")
                np.stack([uk, uw], axis=1).astype(np.int64, copy=False).tofile(p)  # 交互 (key,bp) i64
                runs.append(p)
            for _k, _w in _node_chunks():                 # 副作用で edge_acc(_EdgeSpill)にも edge 三つ組が spill される
                if _k.size == 0:
                    continue
                _bk.append(_k); _bw.append(_w); _bn += int(_k.size)
                if _bn >= _BUDGET:
                    _spill()
            _spill()
            edge_runs = edge_acc.finalize()               # edge 三つ組 sorted run のパス列(disk)
            edge_precomp = ("DISK", edge_runs, netok[0], spill)   # emit_edge_contig_cov が disk 経路で消費
            merged = os.path.join(spill, "merged.bin")
            _con.commit(); _con.close()
            if not runs:
                log("ribbon-contig[disk]: 一致 token 0 → contig 表は空で作成のみ")
                rows_written = 0
            else:
                _c2h = np.ascontiguousarray(_build_contig2hap(contig_meta)[0], dtype=np.int64)  # A-2 hb
                rows_written, _pl = emit_core.emit_ribbon_contig_disk(
                    out_db, runs, merged, birth, death, fp, sbp, _c2h,
                    int(C), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
            _con = sqlite3.connect(out_db); _cur = _con.cursor()
            _con.execute("PRAGMA synchronous=OFF"); _con.execute("PRAGMA journal_mode=OFF")
            _cur.executemany(
                "INSERT INTO contig_dict(contig_id,key,sample,haplotype,contig,n_paths,total_cov) "
                "VALUES(?,?,?,?,?,?,?)",
                [(gid, mm[0], mm[1], mm[2], mm[3], mm[4], int(total_cov[gid]))
                 for gid, mm in enumerate(contig_meta)])
            _con.commit(); _con.close()
            for p in runs + [merged]:
                try:
                    os.remove(p)
                except OSError:
                    pass
            log(f"ribbon-contig[done, disk] C={C} T={ntok[0]:,} node_contig_cov-rows={rows_written:,} "
                f"({time.time()-t0:.1f}s)")
            return dict(contig_gid), edge_precomp, contig_meta, total_cov

        run_k, bp_inc = _stream_unique_sum(_node_chunks(), use_rust=rust_layers)
        es, ed, eg = edge_acc.finalize()
        edge_precomp = (es, ed, eg, netok[0])
        if run_k.size == 0:
            log("ribbon-contig: 一致 token 0 → contig 表は空で作成のみ")
            _con.commit()
            if rust_layers:
                _con.close()
            return dict(contig_gid), edge_precomp, contig_meta, total_cov
        leaf_raw = run_k // C
        contig_inc = (run_k % C).astype(np.int64)
        uniq_leaf = np.unique(leaf_raw)
        leaf_idx_inc = np.searchsorted(uniq_leaf, leaf_raw)
        del run_k, leaf_raw
        log(f"ribbon-contig[stream]: C={C} P={n_p} W={n_w} T={ntok[0]:,} -> I={leaf_idx_inc.size:,} "
            f"({100.0 * leaf_idx_inc.size / max(ntok[0], 1):.1f}%)")
    else:
        # ---- 非streaming: 全 P/W を concat → 単発 unique(ピーク O(T))。edge は自前再走査。 ----
        row_parts, gid_parts = [], []
        for name, raw, _iw in _iter_pw_tokens(gfa, distill):
            gid = contig_gid.get(parse_group(name)[2])
            if gid is None or len(raw) == 0:
                continue
            pid = np.asarray(raw, dtype=np.int64)
            pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
            ok = sids[pos] == pid
            rows = ord_ids[pos[ok]]
            if rows.size == 0:
                continue
            row_parts.append(rows.astype(np.int64))
            gid_parts.append(np.full(rows.size, gid, np.int64))
        if not row_parts:
            log("ribbon-contig: 一致 token 0 → contig 表は空で作成のみ")
            _con.commit()
            if rust_layers:
                _con.close()
            return dict(contig_gid), edge_precomp, contig_meta, total_cov
        row_all = np.concatenate(row_parts); gid_all = np.concatenate(gid_parts)
        del row_parts, gid_parts
        leaf_all = row2node[row_all]
        keep = leaf_all >= 0
        leaf_all = leaf_all[keep]; gid_all = gid_all[keep]
        bp_all = np.maximum(bp_row[row_all[keep]].astype(np.int64), 1)
        del row_all
        total_cov = np.bincount(gid_all, weights=bp_all, minlength=C).astype(np.int64)
        uniq_leaf, inv_leaf = np.unique(leaf_all, return_inverse=True)
        inv_leaf = np.asarray(inv_leaf).ravel()
        del leaf_all
        lkey = inv_leaf.astype(np.int64) * C + gid_all
        del inv_leaf, gid_all
        uk0, invk0 = np.unique(lkey, return_inverse=True)
        del lkey
        bp_inc = np.bincount(np.asarray(invk0).ravel(), weights=bp_all,
                             minlength=uk0.size).astype(np.int64)
        del invk0, bp_all
        leaf_idx_inc = uk0 // C
        contig_inc = (uk0 % C).astype(np.int64)
        del uk0
        log(f"ribbon-contig: C={C} incidence 畳み込み I={leaf_idx_inc.size:,}")

    if rust_layers:
        # per-layer rep_at→(vis,contig)集約→blob を Rust core へ(np.unique(I) の MC OOM を回避)。
        import emit_core
        _c2h = _build_contig2hap(contig_meta)[0]      # A-2: hap-breadth 用 contig_id→hap_id
        _con.commit(); _con.close()
        rows_written, _pl = emit_core.emit_ribbon_contig_layers(
            out_db, np.ascontiguousarray(uniq_leaf, dtype=np.int64),
            np.ascontiguousarray(leaf_idx_inc, dtype=np.int64),
            np.ascontiguousarray(contig_inc, dtype=np.int64),
            np.ascontiguousarray(bp_inc, dtype=np.int64),
            birth, death, fp, sbp, np.ascontiguousarray(_c2h, dtype=np.int64),
            int(C), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
        _con = sqlite3.connect(out_db); _cur = _con.cursor()
        _con.execute("PRAGMA synchronous=OFF"); _con.execute("PRAGMA journal_mode=OFF")
        _cur.executemany(
            "INSERT INTO contig_dict(contig_id,key,sample,haplotype,contig,n_paths,total_cov) "
            "VALUES(?,?,?,?,?,?,?)",
            [(gid, mm[0], mm[1], mm[2], mm[3], mm[4], int(total_cov[gid]))
             for gid, mm in enumerate(contig_meta)])
        _con.commit(); _con.close()
        log(f"ribbon-contig[done, rust] C={C} node_contig_cov-rows={rows_written:,} ({time.time()-t0:.1f}s)")
        return dict(contig_gid), edge_precomp, contig_meta, total_cov

    # A-2: hap-breadth(distinct haplotype 数)を climb 内で算出し node_contig_cov.hb へ(粗ズーム太さ/
    # クラスタ被覆の事前計算)。contig2hap は contig_id→hap_id(単調)。
    contig2hap, _n_hap = _build_contig2hap(contig_meta)
    ins = "INSERT INTO node_contig_cov(node_rowid,blob,hb) VALUES(?,?,?)"
    rid_base = 0; rows_written = 0
    for L in range(start, maxlayer + 1):
        Lw = L - start
        P = born[(b_born <= L) & (L < d_born)]
        k = len(P)
        if k == 0:
            continue
        posmap = np.full(ntree, -1, np.int64)
        posmap[P] = np.arange(k)
        vis = rep_at(uniq_leaf, L)[leaf_idx_inc]
        key = vis * C + contig_inc
        del vis
        uk, invk = np.unique(key, return_inverse=True)
        del key
        sums = np.bincount(np.asarray(invk).ravel(), weights=bp_inc, minlength=uk.size).astype(np.int64)
        del invk
        vis_u = uk // C
        contig_u = (uk % C).astype(np.int64)
        del uk
        idx_in_P = posmap[vis_u]
        good = idx_in_P >= 0
        idx_in_P = idx_in_P[good]; contig_u = contig_u[good]; sums = sums[good]; vis_u = vis_u[good]
        sz = np.maximum(sbp[vis_u], 1.0)
        q = np.clip(np.rint(QMAX * sums / sz), 1.0, QMAX).astype(np.uint8)
        n_nodes = 0
        for batch in _pack_contig_rows(rid_base, idx_in_P, contig_u, q, INS_CHUNK, contig2hap=contig2hap):
            cur.executemany(ins, batch)
            n_nodes += len(batch)
        rows_written += n_nodes
        rid_base += k
        con.commit()
        log(f"  ribbon-contig L{Lw}(旧L{L}): nodes-with-cov={n_nodes:,}/{k:,}")

    cur.executemany(
        "INSERT INTO contig_dict(contig_id,key,sample,haplotype,contig,n_paths,total_cov) "
        "VALUES(?,?,?,?,?,?,?)",
        [(gid, m[0], m[1], m[2], m[3], m[4], int(total_cov[gid])) for gid, m in enumerate(contig_meta)])
    con.commit()
    log(f"ribbon-contig[done] C={C} node_contig_cov-rows={rows_written:,} ({time.time()-t0:.1f}s)")
    return dict(contig_gid), edge_precomp, contig_meta, total_cov


def emit_leaf_seq(cur, con, gfa, distill, ids, id_map, t0):
    """葉(base 節点)の塩基配列を leaf_seq(leaf_id INTEGER PRIMARY KEY, seq TEXT)へ格納する。
       leaf_id = 元 segment id(= node_name 'n<id>' の数値部; id_map 適用済で S 行 id と一致)。
       配列は層非依存なので **1葉1行**(node_rowid キーだと層ごとに重複)。viewer は node_name→leaf_id で直引き。
       入力優先順:
         (1) distill に s_seq(distill_gfa.py --emit-seq が出す s_seq.bin+s_seq_off.npy)があれば **GFA 不要**で
             memmap 消費(WG で 373GB GFA 再読み回避)。s_id(dense, file order)が layout の全葉と一致=valid-set 不要。
         (2) 無ければ GFA の S 行を streaming 走査(--gfa 必須)。valid=layout の葉 id 集合(chrY 規模前提)。
       いずれも RAM=O(1)。"""
    cur.execute("DROP TABLE IF EXISTS leaf_seq")
    cur.execute("CREATE TABLE leaf_seq(leaf_id INTEGER PRIMARY KEY, seq TEXT)")
    ins = "INSERT OR IGNORE INTO leaf_seq(leaf_id,seq) VALUES(?,?)"

    # (1) distill 優先。s_id(dense)→id_map で元 id、配列 = s_seq[off[i]:off[i+1]]。
    seq_off_p = os.path.join(distill, "s_seq_off.npy") if distill else None
    seq_bin_p = os.path.join(distill, "s_seq.bin") if distill else None
    if distill and seq_off_p and os.path.exists(seq_off_p) and os.path.exists(seq_bin_p):
        s_id = np.load(os.path.join(distill, "s_id.npy"))     # dense id(file order, s_seq_off と並列)
        off = np.load(seq_off_p)                              # CSR byte offset(file order), N+1
        buf = np.memmap(seq_bin_p, dtype=np.uint8, mode="r")
        batch = []; n_seq = 0; tot = 0
        for i in range(s_id.size):
            dsi = int(s_id[i])
            oid = int(id_map[dsi - 1]) if id_map is not None else dsi
            a = int(off[i]); b = int(off[i + 1])
            batch.append((oid, buf[a:b].tobytes().decode("ascii"))); tot += b - a
            if len(batch) >= 20000:
                cur.executemany(ins, batch); n_seq += len(batch); batch = []
        if batch:
            cur.executemany(ins, batch); n_seq += len(batch)
        con.commit()
        log(f"leaf-seq[done, distill] leaf_seq-rows={n_seq:,} total_bp={tot:,} ({time.time()-t0:.1f}s)")
        return

    # (2) GFA 直読み。distill に s_seq が無い場合のフォールバック(--gfa 必須)。
    if not gfa:
        log("emit-seq: distill に s_seq 無し かつ --gfa 無し → スキップ(配列取得元なし)")
        con.commit()
        return
    if id_map is not None:
        valid = set(int(x) for x in id_map.tolist())         # id_map 値=元 id(余分な S 行=phantom 等を除外)
    else:
        valid = set(int(x) for x in ids.tolist())            # distill 無し: ids 自体が元 id
    batch = []; n_seq = 0; tot_bp = 0
    with open(gfa) as f:
        for ln in f:
            if not ln or ln[0] != "S":
                continue
            p = ln.split("\t", 3)
            oid = int(p[1])
            if oid not in valid:
                continue
            seq = p[2].strip()
            batch.append((oid, seq)); tot_bp += len(seq)
            if len(batch) >= 20000:
                cur.executemany(ins, batch); n_seq += len(batch); batch = []
    if batch:
        cur.executemany(ins, batch); n_seq += len(batch)
    con.commit()
    log(f"leaf-seq[done, gfa] leaf_seq-rows={n_seq:,} total_bp={tot_bp:,} ({time.time()-t0:.1f}s)")


def _write_contig_baseline(cur, base_c, base_s):
    """contig_dict に ref_baseline(その contig が ref に対して主にどっち向きか: 0=同/1=逆/-1=ref未被覆)を書く。
       baseline=(base_s*2>base_c)(bp 重み多数派 rel。rel=contig向き XOR ref向き, 0=refと同/1=逆)。base_c=0(ref と
       共有葉なし)は -1。これで viewer は任意 (node,contig) の ref 相対向きを rel = ref_baseline XOR (invfrac>=閾値)
       で復元できる(invfrac 無=dev0=baseline のまま、有=dev1=反転)。逆位計算の途中値を格納するだけ=ほぼ無コスト。"""
    cols = [r[1] for r in cur.execute("PRAGMA table_info(contig_dict)").fetchall()]
    if "ref_baseline" not in cols:
        cur.execute("ALTER TABLE contig_dict ADD COLUMN ref_baseline INTEGER")
    bl = np.where(base_c > 0, (base_s * 2 > base_c).astype(np.int64), -1)
    cur.executemany("UPDATE contig_dict SET ref_baseline=? WHERE contig_id=?",
                    [(int(bl[g]), int(g)) for g in range(bl.size)])


def _contig_inv_tables(cur):
    """逆位(inversion)索引。node/edge とも per-(node|edge, contig) の疎 contig-id リスト。
       blob=[u32 count][count×u32 contig_id 昇順]。rowid は nodes/edges の rowid と一致(node_contig_cov 同型)。"""
    cur.execute("DROP TABLE IF EXISTS node_contig_inv")
    cur.execute("DROP TABLE IF EXISTS edge_contig_inv")
    cur.execute("CREATE TABLE node_contig_inv(node_rowid INTEGER PRIMARY KEY, blob BLOB)")
    cur.execute("CREATE TABLE edge_contig_inv(edge_rowid INTEGER PRIMARY KEY, blob BLOB)")


def emit_contig_inv(cur, con, gfa, distill, sids, ord_ids, bp_row, row2node, rep_at,
                    born, b_born, d_born, start, maxlayer, ntree, contig_gid, contig_meta,
                    ref_key, t0, rust_layers=False, out_db=None, birth=None, death=None, fp=None,
                    ribbon_disk=False, ribbon_spill_dir=None, ref_orient_pre=None):
    """逆位索引 node_contig_inv を全層で書く。blob=[count][ids][invfrac](invfrac=round(255·逆位bp/被覆bp))。
       各共有(ref被覆)ステップで rel = contig 向き XOR ref 向き、contig ごと bp 多数派を baseline、baseline から
       外れる bp を逆位とする(ref 相対＋多数派補正=storage 逆格納でも偽陽性ゼロ・局所正順も拾う)。スーパーノードは
       配下 逆位bp/総bp の割合(=invfrac)。viewer/backend が invfrac に閾値(既定0.5)を掛けて判定＝閾値は
       再ビルド不要で可変。順序不要=集合ベース、負担は node_contig_cov と同型。
       向き付き走査は distill(p_ori.npy)があれば memmap で、無ければ gfa 直読み。
       rust_layers: GFA 向き取得→XOR→baseline までは Python、per-layer climb→invfrac→blob 発行を
       emit_core.emit_contig_inv_layers(Rust)へ委譲(MC の per-layer np.unique OOM を回避)。出力は bit 一致。"""
    C = len(contig_meta)
    # rust_layers 時は自前接続でテーブル作成、per-layer は Rust。main の con に触れない(ribbon/edge と同型)。
    if rust_layers:
        _con = sqlite3.connect(out_db); _cur = _con.cursor()
        _con.execute("PRAGMA synchronous=OFF"); _con.execute("PRAGMA journal_mode=OFF")
    else:
        _con, _cur = con, cur
    _contig_inv_tables(_cur)
    if C == 0:
        _con.commit()
        if rust_layers: _con.close()
        return set()
    ref_key_lc = ref_key.lower()
    INS_CHUNK = 200000
    _ori_distill = distill if (distill is not None and _load_distill_ori(distill) is not None) else None
    if _ori_distill is None and gfa is None:
        log("emit-inversion: 向き付き走査の入力なし(p_ori 無し distill かつ gfa 無し)のためスキップ")
        _con.commit()
        if rust_layers: _con.close()
        return set()

    # ---- disk-streaming(WG): 2 パスで RAM を パス本数/incidence 非依存の有界化。 ----
    #   Pass A(ref パスのみ): rc/rs(size ntree, 整数和=順序不問)→ ref_orient。
    #   Pass B(全パス): on-ref 步で base_c/base_s(size C)を貯めつつ (leaf*C+gid, bp, rel*bp) を 2重み spill。
    #   baseline 確定 → Rust emit_contig_inv_disk が k-way merge + 層 flush(invbp を baseline で復元)。出力は in-RAM と bit 一致。
    if rust_layers and ribbon_disk:
        _spill_dir = os.path.join(ribbon_spill_dir or os.path.dirname(out_db) or ".", "inv_spill")
        # §7.2 統合: ref_bp トラックが計算済みの ref_strand(=ref のノード辿り向き, bp 重み多数派)を再利用し
        # Pass A(ref_orient 計算=全トークン走査 1 本)を丸ごと省く。ref_strand[leaf]==ref_orient[leaf] は
        # 式・入力が同一(compute_ref_pos の scnt/ssum == 逆位の rc/rs, ssum*2>=scnt == rs*2>=rc)。未指定なら自前計算。
        if ref_orient_pre is not None:
            ref_orient = np.ascontiguousarray(ref_orient_pre, dtype=np.int64)
            log("contig-inv: ref_strand を再利用(Pass A 省略=統合)")
        else:
            rc = np.zeros(ntree, np.float64); rs = np.zeros(ntree, np.float64)
            for name, ids, ori, _iw in _iter_pw_tokens_oriented(gfa, _ori_distill):
                sample, _hap, contig = parse_group(name)
                if sample.lower() != ref_key_lc or contig_gid.get(contig) is None or ids.size == 0:
                    continue
                pos = np.clip(np.searchsorted(sids, ids), 0, len(sids) - 1)
                ok = sids[pos] == ids
                oi = ord_ids[pos]; leaf = row2node[oi]; keep = ok & (leaf >= 0)
                if not keep.any():
                    continue
                lf = leaf[keep].astype(np.int64)
                orf = ori[keep].astype(np.float64)
                bpf = np.maximum(bp_row[oi[keep]].astype(np.float64), 1.0)
                np.add.at(rc, lf, bpf); np.add.at(rs, lf, orf * bpf)
            ref_orient = np.where(rc > 0, (rs * 2 >= rc).astype(np.int64), -1)
            del rc, rs
        if not np.any(ref_orient >= 0):
            log("contig-inv: 参照パス無し/参照共有葉無し → inv 表は空で作成のみ")
            _con.commit(); _con.close()
            return
        base_c = np.zeros(C, np.float64); base_s = np.zeros(C, np.float64)
        spill = _Sum2wSpill(_spill_dir, "irun")
        for name, ids, ori, _iw in _iter_pw_tokens_oriented(gfa, _ori_distill):
            _s, _h, contig = parse_group(name)
            gid = contig_gid.get(contig)
            if gid is None or ids.size == 0:
                continue
            pos = np.clip(np.searchsorted(sids, ids), 0, len(sids) - 1)
            ok = sids[pos] == ids
            oi = ord_ids[pos]; leaf = row2node[oi]; keep = ok & (leaf >= 0)
            if not keep.any():
                continue
            lf = leaf[keep].astype(np.int64)
            ro = ref_orient[lf]
            on = ro >= 0
            if not np.any(on):
                continue
            lfo = lf[on]
            orf = ori[keep][on].astype(np.int64)
            bpf = np.maximum(bp_row[oi[keep][on]].astype(np.int64), 1)
            rel = (orf ^ ro[on]).astype(np.int64)                 # ref 相対向き(0/1)
            relbp = rel * bpf
            base_c[gid] += float(bpf.sum()); base_s[gid] += float(relbp.sum())
            spill.add(lfo * C + gid, bpf, relbp)                  # key=leaf*C+gid, w1=bp, w2=rel*bp
        baseline = (base_s * 2 > base_c).astype(np.int64)         # contig ごと bp 重み多数派
        _write_contig_baseline(_cur, base_c, base_s)              # ref_baseline を contig_dict へ(viewer 用)
        runs = spill.finalize_runs()
        import emit_core
        _con.commit(); _con.close()
        if runs:
            _merged = os.path.join(_spill_dir, "imerged.bin")
            rows_written, _pl = emit_core.emit_contig_inv_disk(
                out_db, runs, _merged,
                np.ascontiguousarray(baseline, dtype=np.int64),
                birth, death, fp, int(C), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
            log(f"contig-inv[done, disk] node_contig_inv-rows={rows_written:,} ({time.time()-t0:.1f}s)")
        else:
            log("contig-inv: 参照共有ステップ 0 → inv 表は空")
        shutil.rmtree(_spill_dir, ignore_errors=True)
        return

    # pass: on-ref 共有ステップを (leaf, gid, orient, bp) で収集。参照ステップ(sample==ref_key)は ref_orient 用。
    leaf_p = []; gid_p = []; ori_p = []; bp_p = []; rleaf_p = []; rori_p = []; rbp_p = []
    for name, ids, ori, _iw in _iter_pw_tokens_oriented(gfa, _ori_distill):
        sample, _hap, contig = parse_group(name)
        gid = contig_gid.get(contig)
        if gid is None or ids.size == 0:
            continue
        pos = np.clip(np.searchsorted(sids, ids), 0, len(sids) - 1)
        ok = sids[pos] == ids
        oi = ord_ids[pos]
        leaf = row2node[oi]
        keep = ok & (leaf >= 0)
        if not keep.any():
            continue
        lf = leaf[keep].astype(np.int64); orf = ori[keep].astype(np.int64)
        bpf = np.maximum(bp_row[oi[keep]].astype(np.int64), 1)
        leaf_p.append(lf); gid_p.append(np.full(lf.size, gid, np.int64)); ori_p.append(orf); bp_p.append(bpf)
        if sample.lower() == ref_key_lc:
            rleaf_p.append(lf); rori_p.append(orf); rbp_p.append(bpf)
    if not leaf_p or not rleaf_p:
        log(f"contig-inv: {'参照パス無し' if not rleaf_p else 'token 0'} → inv 表は空で作成のみ")
        _con.commit()
        if rust_layers: _con.close()
        return
    leaf_all = np.concatenate(leaf_p); gid_all = np.concatenate(gid_p)
    ori_all = np.concatenate(ori_p); bp_all = np.concatenate(bp_p)
    del leaf_p, gid_p, ori_p, bp_p

    # ref_orient[leaf] = 参照ステップの bp 重み多数派向き(参照が通らない葉は -1)
    rleaf = np.concatenate(rleaf_p); rori = np.concatenate(rori_p)
    rbp = np.concatenate(rbp_p).astype(np.float64); del rleaf_p, rori_p, rbp_p
    rc = np.bincount(rleaf, weights=rbp, minlength=ntree)
    rs = np.bincount(rleaf, weights=rori.astype(np.float64) * rbp, minlength=ntree)
    ref_orient = np.where(rc > 0, (rs * 2 >= rc).astype(np.int64), -1)
    del rc, rs, rleaf, rori, rbp

    # 参照と共有する葉のステップのみ。rel = orient XOR ref_orient。
    on = ref_orient[leaf_all] >= 0
    if not on.any():
        log("contig-inv: 参照と共有する葉が無い → inv 表は空")
        _con.commit()
        if rust_layers: _con.close()
        return
    L_on = leaf_all[on]; G_on = gid_all[on]; bp_on = bp_all[on].astype(np.float64)
    rel = (ori_all[on] ^ ref_orient[L_on]).astype(np.int64)
    del on, leaf_all, gid_all, ori_all, bp_all

    # contig ごと bp 多数派 baseline。baseline から外れるステップ = 逆位。
    base_c = np.bincount(G_on, weights=bp_on, minlength=C)
    base_s = np.bincount(G_on, weights=rel.astype(np.float64) * bp_on, minlength=C)
    baseline = (base_s * 2 > base_c).astype(np.int64)
    _write_contig_baseline(_cur, base_c, base_s)            # ref_baseline を contig_dict へ(viewer 用)
    dev = (rel != baseline[G_on]).astype(np.float64)        # ステップ毎の baseline 逸脱(=逆位)
    # (leaf,gid) 毎に 総bp と 逆位bp を集約(全 on-ref を保持=割合の分母)。
    key = L_on * C + G_on
    uk, invk = np.unique(key, return_inverse=True)
    invk = np.asarray(invk).ravel()
    lg_bp = np.bincount(invk, weights=bp_on, minlength=uk.size)
    lg_invbp = np.bincount(invk, weights=dev * bp_on, minlength=uk.size)
    lg_leaf = uk // C; lg_gid = (uk % C).astype(np.int64)
    log(f"contig-inv: 共有ステップ I={rel.size:,} (leaf,contig)対={uk.size:,} 逆位bp有対={int((lg_invbp > 0).sum()):,}")
    del key, uk, invk, rel, dev, L_on, G_on, bp_on, baseline, base_c, base_s

    # 層ごとに rep_at で可視スーパーノードへ climb、(vis,contig) の 逆位bp/総bp = invfrac(0..255)を書く。
    # blob=[u32 count][count×u32 id][count×u8 invfrac]。viewer/backend が invfrac に閾値(既定0.5)を掛けて判定
    # ＝閾値は再ビルド不要で可変。rid_base は node INSERT と同一進行。
    uniq_leaf = np.unique(lg_leaf)
    leaf_idx = np.searchsorted(uniq_leaf, lg_leaf)

    if rust_layers:
        # per-layer rep_at→(vis,contig)集約(2重み分数 reducer)→blob を Rust core へ委譲。
        # lg_bp/lg_invbp は整数bp和の float64 → int64 化(<2^53 で厳密)。Python 版と bit 一致。
        import emit_core
        _con.commit(); _con.close()
        rows_written, _pl = emit_core.emit_contig_inv_layers(
            out_db,
            np.ascontiguousarray(uniq_leaf, dtype=np.int64),
            np.ascontiguousarray(leaf_idx, dtype=np.int64),
            np.ascontiguousarray(lg_gid, dtype=np.int64),
            np.ascontiguousarray(np.rint(lg_bp), dtype=np.int64),
            np.ascontiguousarray(np.rint(lg_invbp), dtype=np.int64),
            birth, death, fp, int(C), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
        log(f"contig-inv[done, rust] node_contig_inv-rows={rows_written:,} ({time.time()-t0:.1f}s)")
        return

    ins = "INSERT INTO node_contig_inv(node_rowid,blob) VALUES(?,?)"
    rid_base = 0; rows_written = 0
    for L in range(start, maxlayer + 1):
        P = born[(b_born <= L) & (L < d_born)]
        k = len(P)
        if k == 0:
            continue
        posmap = np.full(ntree, -1, np.int64); posmap[P] = np.arange(k)
        vis = rep_at(uniq_leaf, L)[leaf_idx]
        key = vis * C + lg_gid
        uk, invk = np.unique(key, return_inverse=True)
        invk = np.asarray(invk).ravel()
        totbp = np.bincount(invk, weights=lg_bp, minlength=uk.size)
        invbp = np.bincount(invk, weights=lg_invbp, minlength=uk.size)
        q = np.clip(np.rint(255.0 * invbp / np.maximum(totbp, 1.0)), 0, 255).astype(np.uint8)
        vis_u = uk // C; contig_u = (uk % C).astype(np.int64)
        idx_in_P = posmap[vis_u]
        good = (idx_in_P >= 0) & (q > 0)                    # 逆位 bp が有るものだけ疎に格納
        idx_in_P = idx_in_P[good]; contig_u = contig_u[good]; q = q[good]
        for batch in _pack_contig_rows(rid_base, idx_in_P, contig_u, q, INS_CHUNK):
            cur.executemany(ins, batch); rows_written += len(batch)
        rid_base += k
        con.commit()
    log(f"contig-inv[done] node_contig_inv-rows={rows_written:,} ({time.time()-t0:.1f}s)")


MULT_MAX = 255   # u8 上限(1バイト値)。コピー数がこれを超える稀ケースは飽和(実害小)。


def _hap_mult_tables(cur):
    """通過多重度(per-haplotype コピー数)索引。blob=[u32 count][count×u32 hap_id 昇順][count×u8 cn]。
       cn=そのハプロタイプのコピー数(配下葉/base辺の通過回数の max)。hap_id は contig_dict の (sample,haplotype)
       出現順(=contig_id 昇順の distinct)。用途=あるハプロタイプのコピー数が他と異なる(個体間 CNV)を見る。
       - **node_hap_mult**: **present な全ハプロタイプの cn(≥1)を格納**(viewer が値を直接読める。cn0=非通過=非格納)。
         **葉(kind L)＋flubble(kind S)ノードのみ**(クラスタ kind G は CNV の意味が薄いので書かない)。
       - **edge_hap_mult**: cn>1 のみ疎(DB 用意のみ・当面表示なし)。反復領域そのものの注釈は Part B の別トラック。"""
    for t in ("node_hap_mult", "edge_hap_mult", "node_contig_mult", "edge_contig_mult"):
        cur.execute(f"DROP TABLE IF EXISTS {t}")   # 旧 per-contig/u16 版も掃除(誤読防止)
    cur.execute("CREATE TABLE node_hap_mult(node_rowid INTEGER PRIMARY KEY, blob BLOB)")
    cur.execute("CREATE TABLE edge_hap_mult(edge_rowid INTEGER PRIMARY KEY, blob BLOB)")


def _pack_mult_rows(rid_base, node_local, cids, mult, ins_chunk):
    """(node_local:int64, cids:int64 hap_id, mult:int64 cn) を (node,hap)昇順で node ごとに
       blob=[u32 count][count×u32 id 昇順][count×u8 cn] にして (rowid, blob) を yield。"""
    if node_local.size == 0:
        return
    order = np.argsort(node_local.astype(np.int64) * (int(cids.max()) + 1) + cids, kind="stable")
    ns = node_local[order]; cs = cids[order].astype("<u4"); ms = mult[order].astype("<u1")
    unode, first = np.unique(ns, return_index=True)
    counts = np.diff(np.append(first, ns.size))
    batch = []
    for gi in range(unode.size):
        s = int(first[gi]); c = int(counts[gi])
        blob = np.uint32(c).tobytes() + cs[s:s + c].tobytes() + ms[s:s + c].tobytes()
        batch.append((int(rid_base + 1 + unode[gi]), blob))
        if len(batch) >= ins_chunk:
            yield batch; batch = []
    if batch:
        yield batch


def _group_max(key, val):
    """key 昇順ソート後、同一 key ごとに val の max を取り (uniq_key, max_val) を返す(np.maximum.reduceat)。"""
    order = np.argsort(key, kind="stable")
    ks = key[order]; vs = val[order]
    uk, first = np.unique(ks, return_index=True)
    mx = np.maximum.reduceat(vs, first)
    return uk, mx


def emit_hap_mult(cur, con, gfa, distill, sids, ord_ids, row2node, rep_at,
                  born, b_born, d_born, start, maxlayer, ntree, contig_gid, contig_meta,
                  en_i, en_j, t0, kind=None, rust_layers=False, out_db=None, birth=None, death=None, fp=None,
                  ribbon_disk=False, ribbon_spill_dir=None, prefed=None):
    """通過多重度(per-haplotype コピー数) node_hap_mult / edge_hap_mult を書く(§A-2)。
       各パスの葉列から (leaf,hap)/(base-edge,hap) の通過回数を数え、層 climb で **配下 max** を
       per-(super-node|super-edge, haplotype) の cn(=そのハプロタイプのコピー数)とする。同一ハプロタイプの複数 contig は
       同 hap_id へ合算。向き不要=_iter_pw_tokens。狙い=あるハプロタイプのコピー数が他と異なる(個体間 CNV)を DB で持つ。
       node は **present な全 hap の cn(≥1)** を **葉(L)＋flubble(S)ノードのみ**格納(kind でクラスタ G を除外)。
       edge は cn>1 のみ疎(DB 用意のみ)。
       ribbon_disk(=WG): node incidence を disk-streaming(_SumSpill→Rust merge_runs→per-layer flush)で
       **パス本数/incidence 非依存の有界 RAM** に(edge は当面 in-RAM 2列 streaming)。非rust/非disk は Python per-layer。"""
    C = len(contig_meta)
    _mult_max = 0   # 格納 blob cn(u8)の最大 = build時 max_mult(起動時 rescan 回避; 各経路で更新し return)
    _disk = bool(rust_layers and ribbon_disk)
    kind = np.zeros(ntree, np.uint8) if kind is None else kind   # 0=L,1=G,2=S。None なら全て L 扱い
    if rust_layers:
        _con = sqlite3.connect(out_db); _cur = _con.cursor()
        _con.execute("PRAGMA synchronous=OFF"); _con.execute("PRAGMA journal_mode=OFF")
    else:
        _con, _cur = con, cur
    _hap_mult_tables(_cur)
    if C == 0:
        _con.commit()
        if rust_layers: _con.close()
        return _mult_max
    INS_CHUNK = 200000
    contig2hap, H = _build_contig2hap(contig_meta)   # contig_id→hap_id(単調非減少), H=distinct haplotype 数

    # ---- pass(streaming): (leaf,hap) と (base-edge(lo,hi),hap) の通過回数(w=1 count 集約)を RAM 有界に。
    #      node/edge を _SumAccum 2 つで 1 走査同時集約(WG の全 token concat+np.unique OOM を回避)。
    #      結果(sorted-unique key + count 和)は単発 np.unique(return_counts)と bit 一致。 ----
    #   node key=leaf*H+hap は i64 安全(ntree·H≪2^63)。edge は (edge=lo*ntree+hi, hap) の **2 列**で集約
    #   (単一 key (lo*ntree+hi)*H+hap は ntree²·H が WG×大H で i64 溢れ → 2 列で回避)。
    if prefed is not None:
        # §7.2 融合: ribbon 走査で既に node/edge を集約済み(mult 単独走査を省く)。finalize のみ。
        _disk = prefed.disk
        _mult_spill = prefed.spill_dir
        node_acc = prefed.node_acc
        edge_acc = prefed.edge_acc
        log(f"hap-mult: ribbon 走査に相乗り集約(統合) H={H}")
    else:
        _mult_spill = os.path.join(ribbon_spill_dir or os.path.dirname(out_db) or ".", "mult_spill") if _disk else None
        node_acc = _SumSpill(_mult_spill, "nrun") if _disk else _SumAccum(use_rust=rust_layers)
        edge_acc = _TripleSpill(_mult_spill, "erun") if _disk else _SumAccum2()
        for name, raw, _iw in _iter_pw_tokens(gfa, distill):
            gid = contig_gid.get(parse_group(name)[2])
            if gid is None or raw.size == 0:
                continue
            hap = int(contig2hap[gid])                  # このパス(contig)が属す haplotype
            pos = np.clip(np.searchsorted(sids, raw), 0, len(sids) - 1)
            ok = sids[pos] == raw
            leaf = row2node[ord_ids[pos]]
            lf = np.where(ok & (leaf >= 0), leaf, -1).astype(np.int64)   # per-token 葉(順序保持, -1=無効)
            good = lf[lf >= 0]
            if good.size:
                node_acc.add(good * H + hap, np.ones(good.size, np.int64))
            a = lf[:-1]; b = lf[1:]
            em = (a >= 0) & (b >= 0) & (a != b)
            if np.any(em):
                aa = a[em]; bb = b[em]
                lo = np.minimum(aa, bb); hi = np.maximum(aa, bb)
                if _disk:
                    edge_acc.add(lo, hi * H + hap)      # (c1=lo, c2=hi*H+hap)。disk は 3 値 spill
                else:
                    eid = lo * ntree + hi               # 辺 id(i64 安全)。hap は別列(2 列集約)
                    edge_acc.add(eid, np.full(eid.size, hap, np.int64), np.ones(eid.size, np.int64))

    # ---- disk-streaming(WG): node/edge とも spill→Rust merge→per-layer flush(RAM=O(budget), パス本数非依存)。 ----
    if _disk:
        node_runs = node_acc.finalize_runs()
        edge_runs = edge_acc.finalize_runs()
        import emit_core
        _con.commit(); _con.close()
        if node_runs:
            _nmerged = os.path.join(_mult_spill, "nmerged.bin")
            rows_n, _max_cn, _pl = emit_core.emit_hap_mult_node_disk(
                out_db, node_runs, _nmerged,
                np.ascontiguousarray(kind, dtype=np.uint8),
                birth, death, fp, int(H), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
            _mult_max = int(_max_cn)   # Rust が格納 cn の最大を返す(disk 経路は lg_cnt を materialize しない)
            log(f"hap-mult[node done, disk] node_hap_mult-rows={rows_n:,} (leaf+flubble, present全hap) ({time.time()-t0:.1f}s)")
        else:
            log("hap-mult: 通過 token 0 → node_hap_mult は空")
        if edge_runs:
            _emerged = os.path.join(_mult_spill, "emerged.bin")
            rows_e, _ple = emit_core.emit_hap_mult_edge_disk(
                out_db,
                np.ascontiguousarray(en_i, dtype=np.int64), np.ascontiguousarray(en_j, dtype=np.int64),
                edge_runs, _emerged, birth, fp, int(H), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
            log(f"hap-mult[edge done, disk] edge_hap_mult-rows={rows_e:,} ({time.time()-t0:.1f}s)")
        else:
            log("hap-mult: base-edge 通過 0 → edge_hap_mult は空")
        shutil.rmtree(_mult_spill, ignore_errors=True)
        return _mult_max

    # ---- 非disk: in-RAM(chrY/chr22 検証・小規模)。edge は 2 列集約 → in-RAM climb。 ----
    eg_edge, eg_hap, eg_cnt = edge_acc.finalize()    # (edge=lo*ntree+hi, hap, count)
    eg_hap = eg_hap.astype(np.int64)
    eg_cnt = np.minimum(eg_cnt, MULT_MAX).astype(np.int64)
    ukn, cntn = node_acc.finalize()
    if ukn.size == 0:
        log("hap-mult: 通過 token 0 → mult 表は空で作成のみ")
        _con.commit()
        if rust_layers: _con.close()
        return _mult_max

    # (leaf,hap)→通過回数(=そのハプロタイプの葉レベル copy 数; 同 hap の複数 contig は合算済)
    lg_leaf = ukn // H; lg_hap = (ukn % H).astype(np.int64)
    lg_cnt = np.minimum(cntn, MULT_MAX).astype(np.int64); del ukn, cntn
    _mult_max = int(lg_cnt.max()) if lg_cnt.size else 0   # 非disk: 葉 cn 最大 = 格納 blob cn 最大(climb は max 縮約)
    log(f"hap-mult: node (leaf,hap)対={lg_leaf.size:,} 多重(>1)={int((lg_cnt > 1).sum()):,} H={H}")

    # ---- NODE climb: 層ごと rep_at で葉→vis、(vis,hap) の配下 max copy。**present 全 hap(cn≥1)** を
    #      **葉(L)＋flubble(S)ノードのみ** 格納(クラスタ G は CNV の意味が薄いので除外)。 ----
    uniq_leaf = np.unique(lg_leaf); leaf_idx = np.searchsorted(uniq_leaf, lg_leaf)

    if rust_layers:
        # per-layer climb→(vis,hap) max→present全hap(葉/flubble)→blob を Rust core へ委譲(逆位と同型、
        # MC の per-layer np.unique OOM を回避)。node/edge とも自前接続、出力は Python 版と bit 一致。
        import emit_core
        _con.commit(); _con.close()
        rows_n, _pl = emit_core.emit_hap_mult_node_layers(
            out_db,
            np.ascontiguousarray(uniq_leaf, dtype=np.int64),
            np.ascontiguousarray(leaf_idx, dtype=np.int64),
            np.ascontiguousarray(lg_hap, dtype=np.int64),
            np.ascontiguousarray(lg_cnt, dtype=np.int64),
            np.ascontiguousarray(kind, dtype=np.uint8),
            birth, death, fp, int(H), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
        log(f"hap-mult[node done, rust] node_hap_mult-rows={rows_n:,} (leaf+flubble, present全hap) ({time.time()-t0:.1f}s)")
        if eg_edge.size:
            elo = eg_edge // ntree; ehi = eg_edge % ntree
            uniq_ep = np.unique(np.concatenate([elo, ehi]))
            si = np.searchsorted(uniq_ep, elo); di = np.searchsorted(uniq_ep, ehi)
            rows_e, _ple = emit_core.emit_hap_mult_edge_layers(
                out_db,
                np.ascontiguousarray(en_i, dtype=np.int64),
                np.ascontiguousarray(en_j, dtype=np.int64),
                np.ascontiguousarray(uniq_ep, dtype=np.int64),
                np.ascontiguousarray(si, dtype=np.int32),
                np.ascontiguousarray(di, dtype=np.int32),
                np.ascontiguousarray(eg_hap, dtype=np.int64),
                np.ascontiguousarray(eg_cnt, dtype=np.int64),
                birth, fp, int(H), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
            log(f"hap-mult[edge done, rust] edge_hap_mult-rows={rows_e:,} ({time.time()-t0:.1f}s)")
        else:
            log("hap-mult: base-edge 通過 0 → edge_hap_mult は空")
        return _mult_max

    ins_n = "INSERT INTO node_hap_mult(node_rowid,blob) VALUES(?,?)"
    rid_base = 0; n_rows = 0
    for L in range(start, maxlayer + 1):
        P = born[(b_born <= L) & (L < d_born)]; k = len(P)
        if k == 0:
            continue
        posmap = np.full(ntree, -1, np.int64); posmap[P] = np.arange(k)
        vis = rep_at(uniq_leaf, L)[leaf_idx]
        uk, mx = _group_max(vis * H + lg_hap, lg_cnt)
        vis_u = uk // H; hap_u = (uk % H).astype(np.int64)
        idx_in_P = posmap[vis_u]
        kindok = (kind[vis_u] == 0) | (kind[vis_u] == 2)   # 葉(L=0) or バブル(S=2) のみ
        keep = (idx_in_P >= 0) & kindok                    # present 全 hap(cn≥1)を格納
        idx_in_P = idx_in_P[keep]; hap_u = hap_u[keep]; mx = mx[keep]
        for batch in _pack_mult_rows(rid_base, idx_in_P, hap_u, mx, INS_CHUNK):
            _cur.executemany(ins_n, batch); n_rows += len(batch)
        rid_base += k
        _con.commit()
    log(f"hap-mult[node done] node_hap_mult-rows={n_rows:,} (leaf+flubble, present全hap) ({time.time()-t0:.1f}s)")

    # ---- EDGE climb: emit_edge_contig_cov と同じ super-edge 集合/rowid、reducer=max ----
    if eg_edge.size:
        elo = eg_edge // ntree; ehi = eg_edge % ntree
        uniq_ep = np.unique(np.concatenate([elo, ehi]))
        si = np.searchsorted(uniq_ep, elo); di = np.searchsorted(uniq_ep, ehi)
        ins_e = "INSERT INTO edge_hap_mult(edge_rowid,blob) VALUES(?,?)"
        e_rid = 0; e_rows = 0
        for L in range(start, maxlayer + 1):
            ga = rep_at(en_i, L); gb = rep_at(en_j, L)
            m = ga != gb
            if not np.any(m):
                continue
            a = ga[m]; b = gb[m]
            uk = np.unique(np.minimum(a, b) * ntree + np.maximum(a, b)); ke = len(uk)
            vis_ep = rep_at(uniq_ep, L)
            vs = vis_ep[si]; vd = vis_ep[di]
            mm = vs != vd
            lo = np.minimum(vs[mm], vd[mm]); hi = np.maximum(vs[mm], vd[mm])
            uc, mx = _group_max((lo * ntree + hi) * H + eg_hap[mm], eg_cnt[mm])
            ecol = uc // H; hcol = (uc % H).astype(np.int64)
            idx = np.clip(np.searchsorted(uk, ecol), 0, ke - 1)
            valid = (uk[idx] == ecol) & (mx > 1)
            idx = idx[valid].astype(np.int64); hcol = hcol[valid]; mx = mx[valid]
            for batch in _pack_mult_rows(e_rid, idx, hcol, mx, INS_CHUNK):
                _cur.executemany(ins_e, batch); e_rows += len(batch)
            e_rid += ke
            _con.commit()
        log(f"hap-mult[edge done] edge_hap_mult-rows={e_rows:,} ({time.time()-t0:.1f}s)")
    else:
        log("hap-mult: base-edge 通過 0 → edge_hap_mult は空")

    if rust_layers:
        _con.close()
    return _mult_max


def emit_edge_contig_cov(cur, con, gfa, sids, ord_ids, row2node, rep_at,
                         en_i, en_j, start, maxlayer, ntree, contig_gid, t0, stream=True,
                         precomp=None, distill=None, rust_layers=False, out_db=None,
                         birth=None, fp=None, contig2hap=None):
    """エッジ contig 索引(edge_contig_cov)。emit_edge_hap_cov の bitmask を per-edge 疎 contig-id リストへ。
       edge_rowid・per-layer エッジ集合の再現ロジックは emit_edge_hap_cov と同一。
       contig2hap(A-2, contig_id→hap_id)を渡すと edge_contig_cov.hb(distinct haplotype 数)も書く。"""
    C = len(contig_gid)
    # rust_layers: 自前接続でテーブル作成、per-layer は Rust。main の con に触れない。
    if rust_layers:
        _con = sqlite3.connect(out_db); _cur = _con.cursor()
        _con.execute("PRAGMA synchronous=OFF"); _con.execute("PRAGMA journal_mode=OFF")
    else:
        _con, _cur = con, cur
    _edge_contigcov_table(_cur)
    if C == 0:
        _con.commit()
        if rust_layers:
            _con.close()
        return
    INS_CHUNK = 200000

    if precomp is not None and isinstance(precomp[0], str) and precomp[0] == "DISK":
        # ---- disk-streaming: emit_ribbon_contig(disk)が吐いた edge 三つ組 run を Rust が
        #      k-way マージ + per-layer Sa-flush で edge_contig_cov 発行。RAM=O(node+edge)。 ----
        _mark, edge_runs, netok_val, spill = precomp
        import emit_core
        _con.commit(); _con.close()
        if not edge_runs:
            log("edge-contig[disk]: 通過エッジ token 0 → edge_contig_cov は空で作成のみ")
            rows_written = 0
        else:
            merged_e = os.path.join(spill, "merged_edge.bin")
            _c2h = (np.ascontiguousarray(contig2hap, dtype=np.int64) if contig2hap is not None
                    else np.zeros(0, np.int64))   # A-2 hb(空=hb NULL)
            rows_written, _pl = emit_core.emit_edge_contig_cov_disk(
                out_db, np.ascontiguousarray(en_i, dtype=np.int64),
                np.ascontiguousarray(en_j, dtype=np.int64),
                edge_runs, merged_e, birth, fp, _c2h, int(C), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
            for p in edge_runs + [merged_e]:
                try:
                    os.remove(p)
                except OSError:
                    pass
        log(f"edge-contig[done, disk] T={netok_val:,} rows={rows_written:,} ({time.time()-t0:.1f}s)")
        return

    if precomp is not None:
        src_raw, dst_raw, egid, netok_val = precomp
        if src_raw.size == 0:
            log("edge-contig: 通過エッジ token 0 → edge_contig_cov は空で作成のみ")
            _con.commit()
            if rust_layers:
                _con.close()
            return
        uniq_leaf = np.unique(np.concatenate([src_raw, dst_raw]))
        si = np.searchsorted(uniq_leaf, src_raw).astype(np.int32)
        di = np.searchsorted(uniq_leaf, dst_raw).astype(np.int32)
        egid = egid.astype(np.int64)
        log(f"edge-contig[fused]: C={C} T={netok_val:,} -> I={si.size:,}")
    elif stream:
        netok = [0]

        def _edge_chunks():
            for name, raw, _iw in _iter_pw_tokens(gfa, distill):
                if len(raw) < 2:
                    continue
                gid = contig_gid.get(parse_group(name)[2])
                if gid is None:
                    continue
                pid = np.asarray(raw, dtype=np.int64)
                pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
                ok = sids[pos] == pid
                leaf_seq = row2node[ord_ids[pos]]
                leaf_seq[~ok] = -1
                la = leaf_seq[:-1]; lb = leaf_seq[1:]
                g = (la >= 0) & (lb >= 0) & (la != lb)
                if not g.any():
                    continue
                netok[0] += int(g.sum())
                yield (la[g].astype(np.int64), lb[g].astype(np.int64),
                       np.full(int(g.sum()), gid, np.int64))
        src_raw, dst_raw, egid = _stream_unique_triples(_edge_chunks(), ntree, C, use_rust=rust_layers)
        if src_raw.size == 0:
            log("edge-contig: 通過エッジ token 0 → edge_contig_cov は空で作成のみ")
            _con.commit()
            if rust_layers:
                _con.close()
            return
        uniq_leaf = np.unique(np.concatenate([src_raw, dst_raw]))
        si = np.searchsorted(uniq_leaf, src_raw).astype(np.int32)
        di = np.searchsorted(uniq_leaf, dst_raw).astype(np.int32)
        egid = egid.astype(np.int64)
        del src_raw, dst_raw
        log(f"edge-contig[stream]: C={C} T={netok[0]:,} -> I={si.size:,}")
    else:
        esrc_parts, edst_parts, egid_parts = [], [], []
        for name, raw, _iw in _iter_pw_tokens(gfa, distill):
            if len(raw) < 2:
                continue
            gid = contig_gid.get(parse_group(name)[2])
            if gid is None:
                continue
            pid = np.asarray(raw, dtype=np.int64)
            pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
            ok = sids[pos] == pid
            leaf_seq = row2node[ord_ids[pos]]
            leaf_seq[~ok] = -1
            la = leaf_seq[:-1]; lb = leaf_seq[1:]
            g = (la >= 0) & (lb >= 0) & (la != lb)
            if not g.any():
                continue
            esrc_parts.append(la[g].astype(np.int64)); edst_parts.append(lb[g].astype(np.int64))
            egid_parts.append(np.full(int(g.sum()), gid, np.int64))
        if not esrc_parts:
            log("edge-contig: 通過エッジ token 0 → edge_contig_cov は空で作成のみ")
            _con.commit()
            if rust_layers:
                _con.close()
            return
        esrc = np.concatenate(esrc_parts); edst = np.concatenate(edst_parts)
        egid = np.concatenate(egid_parts)
        del esrc_parts, edst_parts, egid_parts
        uniq_leaf = np.unique(np.concatenate([esrc, edst]))
        si = np.searchsorted(uniq_leaf, esrc).astype(np.int32)
        di = np.searchsorted(uniq_leaf, edst).astype(np.int32)
        del esrc, edst
        etrip = np.unique(np.stack([si, di, egid.astype(np.int64)], axis=1), axis=0)
        si = np.ascontiguousarray(etrip[:, 0]).astype(np.int32)
        di = np.ascontiguousarray(etrip[:, 1]).astype(np.int32)
        egid = np.ascontiguousarray(etrip[:, 2]).astype(np.int64)
        del etrip
        log(f"edge-contig: C={C} I={si.size:,}")

    if rust_layers:
        # per-layer base超辺 uk + (超辺,contig)集約→blob を Rust core へ(emit_edges と rowid 整合)。
        import emit_core
        _c2h = (np.ascontiguousarray(contig2hap, dtype=np.int64) if contig2hap is not None
                else np.zeros(0, np.int64))          # A-2: hap-breadth 用(空=hb NULL)
        _con.commit(); _con.close()
        rows_written, _pl = emit_core.emit_edge_contig_cov_layers(
            out_db, np.ascontiguousarray(en_i, dtype=np.int64),
            np.ascontiguousarray(en_j, dtype=np.int64),
            np.ascontiguousarray(uniq_leaf, dtype=np.int64),
            np.ascontiguousarray(si, dtype=np.int32),
            np.ascontiguousarray(di, dtype=np.int32),
            np.ascontiguousarray(egid, dtype=np.int64),
            birth, fp, np.ascontiguousarray(_c2h, dtype=np.int64),
            int(C), int(start), int(maxlayer), int(ntree), spatial_order=_SPATIAL_ORDER)
        log(f"edge-contig[done, rust] rows={rows_written:,} ({time.time()-t0:.1f}s)")
        return

    ins = ("INSERT INTO edge_contig_cov(edge_rowid,blob,hb) VALUES(?,?,?)" if contig2hap is not None
           else "INSERT INTO edge_contig_cov(edge_rowid,blob) VALUES(?,?)")
    e_rid = 0; rows_written = 0
    for L in range(start, maxlayer + 1):
        ga = rep_at(en_i, L); gb = rep_at(en_j, L)
        m = ga != gb
        if not np.any(m):
            continue
        a = ga[m]; b = gb[m]
        key = np.minimum(a, b) * ntree + np.maximum(a, b)
        uk = np.unique(key)
        ke = len(uk)
        vis_of = rep_at(uniq_leaf, L)
        vsrc = vis_of[si]; vdst = vis_of[di]
        mm = vsrc != vdst
        lo = np.minimum(vsrc[mm], vdst[mm]); hi = np.maximum(vsrc[mm], vdst[mm])
        del vsrc, vdst
        tkey = lo * ntree + hi
        del lo, hi
        tgid = egid[mm]
        comb = tkey * C + tgid                          # (super-edge, contig) を一意化
        del tkey
        uc = np.unique(comb)
        del comb
        ek = uc // C; ec = (uc % C).astype(np.int64)
        idx = np.searchsorted(uk, ek)
        idx = np.clip(idx, 0, ke - 1)
        valid = uk[idx] == ek
        idx = idx[valid].astype(np.int64); ec = ec[valid]
        n_edges = 0
        for batch in _pack_contig_rows(e_rid, idx, ec, None, INS_CHUNK, contig2hap=contig2hap):
            cur.executemany(ins, batch)
            n_edges += len(batch)
        rows_written += n_edges
        e_rid += ke
        con.commit()
        log(f"  edge-contig L{L-start}(旧L{L}): edges-with-contig={n_edges:,}/{ke:,}")
    log(f"edge-contig[done] rows={rows_written:,} ({time.time()-t0:.1f}s)")


# ===== 参照座標(ref_bp)トラック =====================================================
# 動機: グラフ全ゲノムレイアウトは bp 非比例(hop ベース SGD)なので、画面 X ≠ 参照 bp。
#   そこで「選んだ参照パス(既定 GRCh38)のコンティグ上の累積 bp」を各ノードのスカラ属性として
#   持たせ、viewer は代表ノード近傍にラベルを置いて大まかな位置を示す(色塗りはしない)。
#   仕様は ANNOTATION_TRACKS_DESIGN.md §10-13 / EMITTER_REFPOS_SPEC.md。
# 実装: contig 索引と同じ token→葉連鎖(searchsorted/ord_ids/row2node)で参照パスを辿り、
#   各葉に累積 offset を与える → 幾何集約(§4d)と同一の depth-level scatter で全木ノードへ集約。
def compute_ref_pos(gfa, distill, ref_key, sids, ord_ids, bp_row,
                    sr, sn, nnpz, n, parent_np, order, ds, maxdepth):
    """参照パス(PanSN sample==ref_key)を token 順に辿り、各葉へ参照コンティグ上の累積 bp を付与し、
       森を bottom-up 集約して全木ノード v の 5 値を返す。
       戻り値 (present, ref_contigs, refcid, refbp, refbpend, isanchor, refmulti):
         present     : ref_key に一致するパスが1本でもあったか
         ref_contigs : [(local_cid, ref_key, short_name, length_bp), ...]  (ref_contigs 表用)
         ref* 配列   : 長さ n(木ノード id 添字)。未被覆は refcid/refbp/refbpend=-1(=NULL 予定), isanchor/refmulti=0。
       座標は 0 起点(P subrange / W seqstart は当面無視。chrY GRCh38 は単一 P・base 0 で一致)。"""
    BIG = np.int64(np.iinfo(np.int64).max)
    # sample==ref_key の比較は大小無視(PGGB は 'grch38' 小文字, MC は 'GRCh38' 大文字で同一参照を指す)。
    ref_key_lc = ref_key.lower()
    # 1. 参照コンティグ辞書(sample==ref_key)。contig_key -> local cid、表示名は '#' 末尾。
    ref_cid = {}
    ref_short = []
    for name, _iw in _iter_pw_names(gfa, distill):
        s, _hap, contig = parse_group(name)
        if s.lower() != ref_key_lc:
            continue
        if contig not in ref_cid:
            ref_cid[contig] = len(ref_cid)
            ref_short.append(contig.split("#")[-1] if "#" in contig else contig)
    C = len(ref_cid)
    # 2. npz row -> tree leaf(row2node)。
    r2n = np.full(nnpz, -1, np.int64)
    r2n[sr] = sn
    # 3. 葉(木ノード添字)配列。内部ノードは sentinel(集約で子から入る)。
    lo = np.full(n, BIG, np.int64)          # ref_bp 開始(min over ref 葉)
    hi = np.full(n, -1, np.int64)           # ref_bp_end(max)
    lcmin = np.full(n, C, np.int64)         # 葉を通る contig id の min(未被覆= C=sentinel, min に無害)
    lcmax = np.full(n, -1, np.int64)        # 同 max(未被覆= -1)
    hit = np.zeros(n, np.int64)             # 参照 token が当たった回数(>1 で多値=サイクル/複数 contig)
    ssum = np.zeros(n, np.int64)            # ref 向き集計(+/> の bp 合計)。向き取得可能時のみ埋まる
    scnt = np.zeros(n, np.int64)            # ref 総 bp(向きの母数; bp 重み多数決の分母)
    length_bp = np.zeros(max(C, 1), np.int64)
    # ref 向き(strand)は向き付き走査(oriented)が要る。distill に p_ori.npy があれば memmap で高速に、
    # 無くても gfa があれば gfa 直読みで取得。どちらも無い(旧 distill のみ)場合だけ ori=None(strand 既定)。
    def _ref_tokens():
        if distill is not None and _load_distill_ori(distill) is not None:
            for name, raw, ori, iw in _iter_pw_tokens_oriented(gfa, distill):
                yield name, raw, ori, iw
        elif gfa is not None:
            for name, raw, ori, iw in _iter_pw_tokens_oriented(gfa):
                yield name, raw, ori, iw
        else:
            for name, raw, iw in _iter_pw_tokens(gfa, distill):
                yield name, raw, None, iw
    if C > 0:
        for name, raw, ori, _iw in _ref_tokens():
            s, _hap, contig = parse_group(name)
            if s.lower() != ref_key_lc or len(raw) == 0:
                continue
            cid = int(ref_cid[contig])
            pid = np.asarray(raw, np.int64)
            pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
            ok = sids[pos] == pid
            oi = ord_ids[pos]
            leaf = r2n[oi]
            # 各 token の bp(未一致 token は 1; 累積 offset の連続性を壊さない)。
            bpstep = np.where(ok, np.maximum(bp_row[oi].astype(np.int64), 1), 1)
            ends = np.cumsum(bpstep)             # token 終端の累積 offset(base 0)
            starts = ends - bpstep               # token 開始 offset
            if ends.size:
                length_bp[cid] = max(int(length_bp[cid]), int(ends[-1]))
            valid = ok & (leaf >= 0)
            if not valid.any():
                continue
            vl = leaf[valid]
            np.minimum.at(lo, vl, starts[valid])
            np.maximum.at(hi, vl, ends[valid])
            np.minimum.at(lcmin, vl, np.int64(cid))
            np.maximum.at(lcmax, vl, np.int64(cid))
            np.add.at(hit, vl, 1)
            if ori is not None:
                ov = np.asarray(ori, np.int64)[valid]   # 1=+/> → +n.a 方向, 0=-/< → -n.a 方向
                bpv = bpstep[valid]                      # そのステップの bp(bp 重み多数決用)
                np.add.at(ssum, vl, ov * bpv)            # + 向きの bp 合計
                np.add.at(scnt, vl, bpv)                 # 総 bp
    # 4. 葉の多値フラグ(サイクルで複数回通過、または葉内で複数 contig)。
    leaf_multi = ((hit > 1) | (lcmax > lcmin)).astype(np.int64)
    # 5. bottom-up 集約(幾何集約 §4d と同一の depth-level scatter; idx と親 p は別 depth=書込/読込が非衝突)。
    cmin = lcmin.copy()
    cmax = lcmax.copy()
    multi = leaf_multi.copy()
    for dep in range(maxdepth, 0, -1):
        loi = int(np.searchsorted(ds, dep, "left")); hii = int(np.searchsorted(ds, dep, "right"))
        if hii <= loi:
            continue
        idx = order[loi:hii]
        p = parent_np[idx].astype(np.int64)
        np.minimum.at(lo, p, lo[idx])
        np.maximum.at(hi, p, hi[idx])
        np.minimum.at(cmin, p, cmin[idx])
        np.maximum.at(cmax, p, cmax[idx])
        np.maximum.at(multi, p, multi[idx])
        np.add.at(ssum, p, ssum[idx])
        np.add.at(scnt, p, scnt[idx])
    # 6. 最終列。has_ref = 参照被覆される子孫がある(cmax>=0)。
    has_ref = cmax >= 0
    multi_out = (has_ref & ((cmax > cmin) | (multi > 0))).astype(np.int64)
    refcid = np.where(has_ref, cmin, -1).astype(np.int64)
    refbp = np.where(has_ref, lo, -1).astype(np.int64)
    refbpend = np.where(has_ref, hi, -1).astype(np.int64)
    # is_anchor = 参照被覆 & 単値(サイクル/複数 contig でない)。viewer のラベル吸着候補(FR5)。
    isanchor = (has_ref & (multi_out == 0)).astype(np.int64)
    # ref_strand = ref がそのノードを辿る向き(1=+n.a / 0=-n.a; bp 重み多数派)。未被覆/向き不明は -1(NULL 予定)。
    refstrand = np.where(has_ref & (scnt > 0), (ssum * 2 >= scnt).astype(np.int64), -1).astype(np.int64)
    ref_contigs = [(cid, ref_key, ref_short[cid], int(length_bp[cid]))
                   for _contig, cid in sorted(ref_cid.items(), key=lambda kv: kv[1])]
    return (C > 0), ref_contigs, refcid, refbp, refbpend, isanchor, multi_out, refstrand


def orient_by_ref(xy, ids, ei, ej, gfa, distill, ref_key, log=lambda *a: None):
    """レイアウト座標 xy(正規化後)を per連結成分で左右反転し、各成分の「支配 ref コンティグ」が
    画面 x 昇順=ref ステップ昇順(ゲノム前部が左)になるよう向きを決定的に正規化する。
    背景: topology-only レイアウトの PCA 整列符号は任意(左右がランダム)。ref を知る emitter 側で直す。
    - 支配コンティグ = その成分で is_anchor(単一 ref・非サイクル)ノードが最多の ref コンティグ。
    - 反転判定 = そのコンティグのノードでの cov(x, step) の符号(step=ref パス上の累積位置)。負なら反転。
    - 反転は成分の x ボックス内 (x -> lo+hi-x)。等長変換ゆえエッジ長・形状・角度整合(呼出は leaf_angles 前)。
    - bp 不要(step 順で符号同一)。DB 列は追加しない(向き符号は使い捨て)。
    複数 ref コンティグ(融合染色体 / ref 分割)でも支配コンティグ単独で判定 → 全 ref_bp 混合の
    『ノコギリ波』破綻を回避。反平行の副コンティグは topology のまま(原理的限界)。"""
    import scipy.sparse as sp
    from scipy.sparse.csgraph import connected_components
    n = len(ids)
    A = sp.csr_matrix((np.ones(ei.size * 2, np.int8),
                       (np.concatenate([ei, ej]), np.concatenate([ej, ei]))), shape=(n, n))
    ncc, cc = connected_components(A, directed=False)
    del A
    ord_ids = np.argsort(ids); sids = ids[ord_ids]
    ref_key_lc = ref_key.lower()
    BIG = np.int64(np.iinfo(np.int64).max)
    # pass1: 各 npz row の min/max ref-contig id と被覆回数(→ multi/anchor 判定)。
    row_mincid = np.full(n, BIG, np.int64); row_maxcid = np.full(n, -1, np.int64)
    row_hit = np.zeros(n, np.int64)
    ref_cid = {}
    def _cid(name):
        s, _h, contig = parse_group(name)
        if s.lower() != ref_key_lc:
            return None
        return ref_cid.setdefault(contig, len(ref_cid))
    for name, raw, _iw in _iter_pw_tokens(gfa, distill):
        cid = _cid(name)
        if cid is None or len(raw) == 0:
            continue
        pid = np.asarray(raw, np.int64)
        pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
        ok = sids[pos] == pid
        rw = ord_ids[pos][ok]
        if rw.size == 0:
            continue
        np.minimum.at(row_mincid, rw, np.int64(cid))
        np.maximum.at(row_maxcid, rw, np.int64(cid))
        np.add.at(row_hit, rw, 1)
    has_ref = row_maxcid >= 0
    anchor = has_ref & (row_maxcid == row_mincid) & (row_hit == 1)   # 単一 contig・非サイクル
    row_cid = np.where(has_ref, row_mincid, -1)
    if not anchor.any():
        log("orient: ref アンカーノード無し → 反転しない")
        return xy, 0, 0, 0
    # pass2: anchor 行の step(その contig 上の位置, min occurrence)を採る。
    row_step = np.full(n, BIG, np.int64)
    for name, raw, _iw in _iter_pw_tokens(gfa, distill):
        cid = _cid(name)
        if cid is None or len(raw) == 0:
            continue
        pid = np.asarray(raw, np.int64)
        pos = np.clip(np.searchsorted(sids, pid), 0, len(sids) - 1)
        ok = sids[pos] == pid
        rw = ord_ids[pos]
        step = np.arange(pid.size, dtype=np.int64)
        m = ok & anchor[rw] & (row_cid[rw] == cid)
        if m.any():
            np.minimum.at(row_step, rw[m], step[m])
    # ref を持つ成分だけループ(≤ ref コンティグ数=少数)。
    ref_ccs = np.unique(cc[anchor])
    nflip = 0; nflip_nodes = 0
    x = xy[:, 0]
    for c in ref_ccs.tolist():
        in_c = anchor & (cc == c)
        cids_c = row_cid[in_c]
        # 支配コンティグ = anchor ノード最多の contig
        vals, cnts = np.unique(cids_c, return_counts=True)
        dom = int(vals[int(cnts.argmax())])
        rows_d = np.where(in_c & (row_cid == dom))[0]
        if rows_d.size < 2:
            continue
        xd = x[rows_d]; sd = row_step[rows_d].astype(np.float64)
        cov = float(((xd - xd.mean()) * (sd - sd.mean())).mean())   # 符号だけ使う
        if cov < 0:                                                  # x 昇順で step 降順 → 反転
            cc_rows = np.where(cc == c)[0]
            lo = float(x[cc_rows].min()); hi = float(x[cc_rows].max())
            x[cc_rows] = lo + hi - x[cc_rows]
            nflip += 1; nflip_nodes += cc_rows.size
    log(f"orient: ref-bearing comps={ref_ccs.size} flipped={nflip} (nodes={nflip_nodes:,}) "
        f"ref_contigs={len(ref_cid)}")
    return xy, nflip, nflip_nodes, int(ref_ccs.size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--typed", required=True, help="lod.py の *.unified.typed(path<TAB>kind<TAB>atom)")
    ap.add_argument("--npz", required=True, help="layout_sgd_plain.py の npz(ids,xy,ei,ej[,esu,esv])")
    ap.add_argument("--gfa", default=None, help="ノード size(bp) 用。無ければ size=葉数")
    ap.add_argument("--distill", default=None,
                    help="distill 中間ディレクトリ(distill_gfa.py 出力)。指定時は bp/ribbon を GFA テキストでなく "
                         "numpy 配列から読む(--gfa 不要)。token は dense id・node_name は id_map で元 id に復元。")
    ap.add_argument("--distill-sidecar", dest="emit_distill_sidecar", action="store_true", default=True,
                    help="[既定ON] `<out-db>.distill` → distill ディレクトリの symlink を張る。viewer の "
                         "bubble MSA パネルが順序付きウォーク(p_tok/p_ori)を直読みするための在り処で、"
                         "hapidx/nametri と同じサイドカー規約。distill が MSA 用配列を持たない(旧 distill)か、"
                         "この DB と別グラフだった場合は張らずに警告する。")
    ap.add_argument("--no-distill-sidecar", dest="emit_distill_sidecar", action="store_false",
                    help="distill サイドカーを張らない(viewer の MSA パネルだけ使えなくなる)")
    ap.add_argument("--distill-sidecar-dir", dest="distill_sidecar_dir", default=None,
                    help="サイドカーが指す distill ディレクトリ(既定=--distill)。--gfa でビルドする場合"
                         "(--distill を渡さない場合)でも、同じ GFA から作った distill をここで指定すれば "
                         "MSA が使えるようになる。")
    ap.add_argument("--template", required=True, help="スキーマ供給用の既存 layered.db")
    ap.add_argument("--out-db", required=True)
    ap.add_argument("--build-tmp", default=None,
                    help="DB をこのローカル一時ディレクトリ(例 /tmp や $TMPDIR)でビルドし、完了後に --out-db へ "
                         "1 回の逐次コピーで確定する。共有FS(NFS/Lustre 等)上の SQLite ランダム書込(特に "
                         "nodes_rtree の B-tree ページ更新・読み戻し)がネットワーク律速のとき WG で有効。"
                         "内容は不変(bit-identical)。ローカルに DB サイズ分の空きが必要(WG: 60〜145GB)。")
    # 層スケジュールは budget に一本化。kindaware は viewer LOD 破綻(最上位極小層で layer_zoom が
    # 1.0 に張り付き層スキップ、中層爆発で deep zoom 一段大量描画→固まる)のため廃止した
    # ([[viewer-lod-use-budget-not-kindaware]])。--schedule/--kG/--kS/--merge-tail-frac は
    # 既存 qsub(spool 済みジョブの再起動を含む)を壊さないため受理するが**無視**する(下で警告)。
    ap.add_argument("--schedule", choices=("kindaware", "budget"), default="budget",
                    help="層スケジュール(budget のみ; kindaware は廃止・指定しても budget で実行)")
    ap.add_argument("--kG", type=int, default=4, help="[廃止・無視] 旧 kindaware 引数")
    ap.add_argument("--kS", type=int, default=2, help="[廃止・無視] 旧 kindaware 引数")
    ap.add_argument("--merge-tail-frac", type=float, default=None,
                    help="[廃止・無視] 旧 kindaware 引数")
    ap.add_argument("--budget-floor", type=int, default=1000,
                    help="[budget] 最上層(全体図)の目標グリフ数(既定1000)")
    ap.add_argument("--budget-rmin", type=float, default=2.0, help="[budget] 上段(全体側)の層あたり比(既定2)")
    ap.add_argument("--budget-rmax", type=float, default=2.5, help="[budget] 下段(詳細側)の層あたり比(既定2.5)")
    ap.add_argument("--budget-shrink", type=float, default=0.8, help="[budget] 下→上へ比を縮める係数(既定0.8)")
    ap.add_argument("--budget-span-weight", type=float, default=1.0,
                    help="[budget] 空間スパン嵩上げ係数λ: weight=max(size, λ·N·span/span_root)。"
                         "広範囲だが葉の少ないノードを早く展開し巨大グリフを解消(既定1.0, 0=size のみ)")
    ap.add_argument("--start-min-nodes", type=int, default=0,
                    help="ノード数が此値を超える最初の層の --start-back 手前を新 layer0 にする(粗い層を捨てる)。0=無効")
    ap.add_argument("--start-back", type=int, default=2,
                    help="--start-min-nodes 超えの初出層から何層手前を layer0 にするか(既定2)")
    ap.add_argument("--radius-frac", type=float, default=0.25, help="葉半径 = 倍率 × エッジ長中央値(絶対 floor なし)")
    # 崩壊アレル分離。素の SGD は 2ノードバブルの並列アレルを同座標に重ねる(chr22 で全ノードの
    # ~44%)。パス情報で局所境界軸の垂直へ ±分離し最深層のグリフ重なり/エッジ埋没を解消する。--gfa が必要。
    #
    # ★2026-08-03: **既定を OFF に変更**（ユーザ指示）。理由:
    #   (1) レイアウト側で解決できるなら不要になる。並列アレルが重なる根本原因は
    #       **pivot SGD の応力項に (アレルB, アレルC) の対が存在しない**こと。項は
    #       (pivot,ノード)/(球中心,member)/(辺) だけで、B か C が中心に選ばれる確率は
    #       73,238/3,759,736≈2% ＝ バブルの 96% に分離する応力項が無い。
    #       この欠落を埋める hop 応力項を ③ 側で実装中。
    #   (2) **レイアウトの評価を妨げる**。分離が入ると viewer では開いて見えるので、
    #       ③ が本当にバブルを開けているのか目視で判断できない。
    ap.add_argument("--separate", dest="separate", action="store_true", default=False,
                    help="崩壊した並列アレル(同座標ノード)をパス情報で分離(既定 OFF, --gfa 必須)。")
    ap.add_argument("--no-separate", dest="separate", action="store_false",
                    help="崩壊アレル分離を無効化(既定)。素の npz 座標をそのまま使う。")
    ap.add_argument("--separate-offset-frac", type=float, default=0.4,
                    help="[separate] 片側オフセット = 倍率 × エッジ長中央値(既定 0.4)。")
    ap.add_argument("--separate-axis-eps", type=float, default=0.05,
                    help="[separate] 境界軸長 < eps×med を退化とみなし接線回復する閾値(既定 0.05)。")
    ap.add_argument("--separate-collapse-frac", type=float, default=0.8,
                    help="[separate] アレル間 span < 倍率×med のバブルを崩壊とみなし分離(既定 0.8)。"
                         "座標厳密一致でなく構造で束ねるので数ULPずれた準崩壊も拾う。既開バブルは不変。")
    ap.add_argument("--ribbon", dest="emit_ribbon", action="store_true", default=False,
                    help="[非既定] 疎な contig 粒度リボン path_groups/node_group_cov を書く"
                         "(塩基exact だが行数=被覆インシデンス数で肥大: chr22 で 321M 行/20.9GB; hapcov より重い; --gfa 必須)")
    ap.add_argument("--no-ribbon", dest="emit_ribbon", action="store_false",
                    help="疎 contig リボン表を書かない(既定)")
    ap.add_argument("--ribbon-contig", dest="emit_ribbon_contig", action="store_true", default=True,
                    help="[既定ON] contig 前向き索引を書き sample/hap/contig の全リボンを賄う(hap 索引の置換)。"
                         "各ノード/エッジに『実際に通る contig の疎リスト』を持つ(node_contig_cov/edge_contig_cov/"
                         "contig_dict/contigcov_meta)。contig_id は (sample,hap,contig) 昇順で hap/sample は連続レンジ。"
                         "サイズは (node,contig) インシデンス数 ≈ (node,hap)×1.4 で hap 索引と同オーダー; --gfa 必須")
    ap.add_argument("--no-ribbon-contig", dest="emit_ribbon_contig", action="store_false",
                    help="contig 索引を書かない")
    ap.add_argument("--ribbon-disk", dest="ribbon_disk", action="store_true", default=False,
                    help="contig node リボンの incidence を RAM に載せず sorted run を spill-dir へ吐き出し、"
                         "Rust が k-way マージ+per-layer flush で発行(RAM=O(node), I 非依存)。WG 巨大 incidence"
                         "(node×contig 被覆で 数十億)の OOM 回避用。chr22 では既定 in-RAM で十分。--rust-ribbon 前提。")
    ap.add_argument("--ribbon-spill-dir", dest="ribbon_spill_dir", default=None,
                    help="--ribbon-disk の run/merged 一時ファイル置き場(既定=out-db の隣)。WG は spill が "
                         "~run合計140GB+merged70GB になるので、job-local /tmp でなく容量のある共有FSを指定推奨。")
    ap.add_argument("--hapidx", dest="emit_hapidx", action="store_true", default=True,
                    help="[既定ON] hap 絞り込み取得の索引を書く。nodes_rtree を『hap ビットマスクを補助列に持つ』"
                         "形で作り直し、edge_hm(edge_rowid PK, hm0..) を足す。viewer の「選択サンプル/ハプロタイプが"
                         "通るノード・エッジだけ描画」モードが使うもの。密領域の取得が cold 1.7-4.7x / warm 2.5-2.7x、"
                         "エッジは warm 最大 31x 速くなる(実測 functions/hapfilter/RESULTS.md)。ついでに nodes_rtree が"
                         "rowid 昇順の一括再構築になるので cold が 1.6-6x 改善する。node_contig_cov 必須"
                         "(=--ribbon-contig)。マスク幅は H から自動(H<=512 は厳密, 超えたら保守的マスク+厳密判定)。")
    ap.add_argument("--no-hapidx", dest="emit_hapidx", action="store_false",
                    help="hap 絞り込み索引を書かない(nodes_rtree は補助列なしのまま)")
    ap.add_argument("--hapidx-wmax", dest="hapidx_wmax", type=int, default=8,
                    help="hap マスクの語数上限(既定 8=512bit)。R-Tree の %%_rowid が 8B/語 太る。")
    ap.add_argument("--spatial-order", dest="spatial_order", action="store_true", default=False,
                    help="[既定OFF — 実測で退行したため] 層内の rowid を空間順に採番する。rowid は "
                         "nodes / node_contig_cov / node_hap_mult / node_contig_inv / node_annot / "
                         "read_cov / nodes_rtree_rowid の共通キーなので、ビューポート内の行が "
                         "rowid 上でも連続になり cold のシーク数が減る、はずだった（下記の通り退行）")
    ap.add_argument("--no-spatial-order", dest="spatial_order", action="store_false",
                    help="従来どおり木のインデックス順で採番する（既定）")

    # ★2026-08-09: 空間順採番は **3 グラフすべてで退行した**ので既定 OFF にした。
    #   cold のコストは run 数(=シーク回数)で決まるが、rows/run が軒並み半減する:
    #     chr22 PGGB 大域Hilbert : rows/run 312 → 122   runs 3 → 6
    #     chr22 PGGB 兄弟のみ    : 同傾向
    #     chrY  MC   兄弟のみ    : L6 860→398(runs 4→6) / L7 671→268(2→6) / L8 821→329(3→8)
    #   理由: 木インデックスは typed の初出順(=パス順=DFS)なので **部分木が連続範囲**を占め、
    #   ビューポートが部分木に収まれば 1 run になる。これは空間充填曲線には出せない性質
    #   (矩形は原理的に周長に比例する数の曲線区間に切られる)。
    #   さらに「兄弟順は恣意的」も誤りだった: Infomap の階層もレイアウトも**同じ連結性**から
    #   導かれるので、兄弟順は既にレイアウトと相関している。そこへ重心の Hilbert 順を被せると
    #   相関していた並びを別基準で切り直すことになり run が細切れになる。
    #   （等価性は全ケースで 0 件不一致＝実装は正しい。設計として効かない、が結論）
    #
    #   ★エッジ側も同じ結論（2026-08-09 追試, functions/reemit2/edgeloc2.js）。
    #   きっかけになった「edge density は両グラフとも 0.0000＝最悪＝伸びしろ」は **測り方の誤り**で、
    #   `WHERE source IN (可視ノード名)` に **層フィルタが無かった**（edges の PK は
    #   (layer_index,source,target) で、ノード名は層をまたいで同じなので全層ぶんを拾っていた）。
    #   層で絞ると木順のエッジは既にほぼ最良で、空間順にすると退行する:
    #     chrY MC   L7 : edge runs 2 → 5   (rows/run 753.7 → 278.7)
    #     chr22PGGB L10: edge runs 2 → 10  (rows/run 329.0 →  98.7)
    #   runs 中央値 2 は下限(1)のすぐ隣なので、**別の採番規則でも改善余地が原理的に無い**。
    #
    #   ★さらに「rowid ではなく R-Tree の**挿入順**だけ空間順にする」（%_rowid は rowid キーの
    #   B-tree なので並びは不変のまま、%_node の葉と nodeno だけ空間順にできる）も試したが
    #   これも退行した（rtorder.js, chrY MC L7: 訪問中央 74→77〜82 / runs 中央 13→22〜73）。
    #
    #   ★そもそも cold の律速は rowid ではなかった: vpdiag.js で分けると高速経路の cold は
    #   **%_node(R-Tree 本体)のランダム読み**が支配的で（自前走査で先に読むと SQL 側の
    #   t_rt が 1405ms → 1.0ms）、1 ノード 3-5ms × 訪問 80-100 ノード。rowid の並びは無関係。
    #   打ち手は採番ではなく**配置と先読み**（R-Tree のサイドカー化 / 順読みプリウォーム /
    #   lfs のストライプ分散）。詳細は functions/reemit2/README.md 付録 D。
    ap.add_argument("--nametri", dest="emit_nametri", action="store_true", default=True,
                    help="ノード名の部分一致検索用 FTS5 trigram 索引(nmdict/nmfts)を DB 内に作る(既定ON)。"
                         "無いと viewer の Find>Node の `LIKE '%%q%%'` が nodes 全走査(chr22 cold 48.7s)になる。"
                         "chr22 実測 +8 秒 / +190MB。")
    ap.add_argument("--no-nametri", dest="emit_nametri", action="store_false",
                    help="trigram 索引を書かない(部分一致は従来の全走査にフォールバック)")
    ap.add_argument("--nametri-cache-mb", dest="nametri_cache_mb", type=int, default=8192,
                    help="nametri 段だけの SQLite ページキャッシュ上限(MiB, 既定 8192)。"
                         "負値=上限の遅延確保なので小さい DB では実際には伸びない。")
    ap.add_argument("--ribbon-hapbytes", dest="emit_ribbon_hap", action="store_true", default=False,
                    help="[既定OFF; contig 索引に置換済] ハプロタイプ・リボンを全層 dense 1バイト/hap(被覆率256段階)で"
                         "書く(node_hap_cov/hap_dict/hapcov_meta + edge_hap_cov)。contig を出せないので通常不要; --gfa 必須")
    ap.add_argument("--no-ribbon-hapbytes", dest="emit_ribbon_hap", action="store_false",
                    help="ハプロタイプ・リボンを書かない(既定)")
    ap.add_argument("--ribbon-nostream", dest="ribbon_stream", action="store_false", default=True,
                    help="hapcov 畳み込みを非streaming(全 token 常駐)で行う。既定は streaming"
                         "(全 T を載せず逐次マージ; WG の O(T) ピーク回避)。出力は両者 content 同一")
    ap.add_argument("--zoom-budget", type=float, default=2000.0,
                    help="layer_zoom f(n) 較正の目標画面内グリフ数 V_render(**典型ビューをこれで埋める**; "
                         "既定2000)。密領域の上限は viewer の maxRows(取得の安全弁)が別に持つ")
    ap.add_argument("--zoom-percentile", type=float, default=50.0,
                    help="f(n) を較正する分位(**既定50=中央値**)。分位を上限に合わせる方式はグラフ間で "
                         "1.18-3.03x・層間で 25-64x ばらついたが、中央値を目標に固定すると "
                         "目標比 0.74-0.90x・層間 2.8-5.2x に収まる(3 DB 実測)")
    ap.add_argument("--zoom-method", choices=("xy", "rtree", "grid"), default="xy",
                    help="f(n) の解き方。**xy(既定)=メモリ上の座標から kNN で厳密解**(DB アクセス 0・"
                         "二分探索なし・格子飽和なし)。rtree=DB の打ち切りカウントで二分探索"
                         "(WG では 1 プローブが層のシェアに支配され実用外)。grid=旧格子実装"
                         "(chr22 では L8 以降飽和して下限比に落ちる)")
    ap.add_argument("--zoom-diag-samples", type=int, default=4096,
                    help="stats.layer_zoom_diag(層別 p25/p50/p75/p90/p99)の標本数上限(既定4096)。"
                         "密度分布が崖状のグラフ(chr22)では 512 標本だと中央値が 0.5-2x ぶれて"
                         "自己検査に使えない。数え上げコストは総点数 5e8 で自動に縛る")
    ap.add_argument("--zoom-samples", type=int, default=4096,
                    help="層あたり標本グリフ数(既定4096)。xy 法では kNN の問い合わせ点数で安いので"
                         "多め、rtree 法では 1 標本=16 プローブなので 400 程度が実用上限だった")
    ap.add_argument("--zoom-grid", type=int, default=4096, help="局所密度測定の格子解像度(既定4096)")
    ap.add_argument("--zoom-ceil-ratio", type=float, default=4.0,
                    help="layer_zoom 隣接層のズーム比の上限(既定4=1層あたり最大4倍ズームで次層が出る)。"
                         "chr22 等 hairball で密度ジャンプ由来の dead-zone(ズームしても何も出ず突然大量=kindaware様破綻)を"
                         "均す。深層の自然比<上限は不変=到達ズーム保存。0=無効(従来)")
    ap.add_argument("--zoom-dfloor", type=float, default=2.0,
                    help="飽和/同値層の狭義単調化に使う下限次元(既定2=2D一様の最小成長√(N比)/層)")
    ap.add_argument("--ref-key", default="GRCh38",
                    help="参照とする PanSN sample 名(大小無視で一致。PGGB 'grch38'/MC 'GRCh38' 両対応)。"
                         "この経路のコンティグ上の累積 bp を各ノードに付与(既定 GRCh38)")
    ap.add_argument("--emit-inversion", dest="emit_inversion", action="store_true", default=False,
                    help="逆位(inversion)索引 node_contig_inv/edge_contig_inv を出力(既定OFF)。各共有ノードで "
                         "contig 向きを ref 相対比較し contig 多数派 baseline から外れる箇所を逆位とする。現状 --gfa 直読みのみ")
    ap.add_argument("--emit-multiplicity", dest="emit_multiplicity", action="store_true", default=False,
                    help="通過多重度索引 node_hap_mult/edge_hap_mult を出力(既定OFF, per-haplotype)。各パスの葉/base辺の"
                         "通過回数を hap 毎に数え、層 climb で配下 max(=最大コピー数)を per-(super-node|super-edge, haplotype)"
                         "に持つ。同一ハプロタイプの複数 contig は合算。mult>1 のみ疎格納")
    ap.add_argument("--emit-seq", dest="emit_seq", action="store_true", default=True,
                    help="葉(base 節点)の塩基配列を leaf_seq(leaf_id,seq)へ格納(既定ON)。leaf_id=元 segment id"
                         "(node_name 'n<id>' の数値部)。層非依存の 1葉1行、RAM=O(1) streaming。配列は distill(s_seq, "
                         "distill_gfa --emit-seq)優先→無ければ --gfa。どちらも無ければ graceful スキップ")
    ap.add_argument("--no-emit-seq", dest="emit_seq", action="store_false",
                    help="葉配列 leaf_seq を出力しない")
    ap.add_argument("--ref-bp", dest="emit_ref_bp", action="store_true", default=True,
                    help="参照座標(ref_bp)列 + ref_meta/ref_contigs を出力(既定ON)")
    ap.add_argument("--no-ref-bp", dest="emit_ref_bp", action="store_false",
                    help="参照座標トラックを出力しない")
    ap.add_argument("--orient-ref", dest="orient_ref", action="store_true", default=False,
                    help="per連結成分で座標を左右反転し支配 ref コンティグ(--ref-key)を画面 x 昇順に揃える(既定OFF)。"
                         "注: ノードの自然な流れ(左→右)が ref 向きと逆の場合、ref に合わせると流れが右→左になり不自然なので既定では行わない")
    ap.add_argument("--no-orient-ref", dest="orient_ref", action="store_false",
                    help="向き正規化をしない(既定; PCA 整列符号のまま=ノードの自然な流れを保持)")
    ap.add_argument("--rust-edges", action="store_true",
                    help="§8 エッジ発行を Rust core(emit_core.emit_edges)で行う"
                         "(省メモリ・高速化; 出力は Python 経路と bit一致想定)")
    ap.add_argument("--rust-geometry", action="store_true",
                    help="§4 幾何集約を Rust core(emit_core.emit_geometry)で行う"
                         "(死配列/bincount一時を排し省メモリ; ANG は arctan2 のみ Python)")
    ap.add_argument("--rust-nodes", action="store_true",
                    help="§7 ノード発行を Rust core(emit_core.emit_nodes)で行う"
                         "(name_all object 配列 ~8GB を排し省メモリ; --rust-edges と併用で完全排除)")
    ap.add_argument("--rust-ribbon", action="store_true",
                    help="§8.55 contig ribbon(node/edge)の per-layer 発行を Rust core で行う"
                         "(MC の ribbon np.unique 209G OOM 点を回避; GFA 走査は Python streaming 維持)")
    ap.add_argument("--rust-all", dest="rust_all", action="store_true", default=True,
                    help="§4/§7/§8/§8.55 の hot path を Rust core(emit_core)でまとめて実行(既定ON; "
                         "chrY/chr22 で Python 経路と論理一致・ribbon 一致を検証済, WG のメモリ/時間律速を解消)")
    ap.add_argument("--no-rust", dest="rust_all", action="store_false",
                    help="Rust core を使わず全 hot path を Python 経路で発行(デバッグ/bit検証用; WG では OOM 前提)")
    args = ap.parse_args()
    # --rust-all(既定ON)は個別フラグを一括点灯。--no-rust で全消灯、個別 --rust-* で選択点灯も可能。
    if args.rust_all:
        args.rust_geometry = args.rust_nodes = args.rust_edges = args.rust_ribbon = True
    t0 = time.time()

    # ---- 1. レイアウト npz ----
    d = np.load(args.npz)
    ids = d["ids"].astype(np.int64)
    xy = d["xy"].astype(np.float64)
    ei = d["ei"].astype(np.int64)
    ej = d["ej"].astype(np.int64)
    esu = d["esu"].astype(np.int64) if "esu" in d.files else None
    esv = d["esv"].astype(np.int64) if "esv" in d.files else None
    nnpz = len(ids); ne = len(ei)
    log(f"npz: nodes={nnpz:,} edges={ne:,} (orientation={'yes' if esu is not None else 'no'})")

    # 崩壊アレル分離(既定 ON): 正規化・leaf_angles・幾何集約の前に生 xy を差し替える。offset は
    # med 相対なので生/正規化どちらの座標でも等価。分離後は同名の分離グリフが最深層に開き、
    # 内部ノードの PCA angle/bbox も開いたバブルを反映する。CLI と同一実装 [[collapsed-allele-separation]]。
    if args.separate:
        if args.gfa or args.distill:
            # distill があれば separate も p_tok(dense id)を消費し 373GB GFA 再パースを回避。
            # step3 走査は Rust core(既定); --no-rust 時は Python フォールバック。[[collapsed-allele-separation]]
            xy = separate_collapsed(ids, xy, ei, ej, args.gfa,
                                    offset_frac=args.separate_offset_frac,
                                    axis_eps=args.separate_axis_eps,
                                    collapse_frac=args.separate_collapse_frac, log=log,
                                    distill=args.distill, use_rust=args.rust_all)
        else:
            log("[warn] --separate 指定だが --gfa/--distill が無い → 分離をスキップ(素座標のまま)")

    # 等方 [0.05,0.95] 正規化(縁に余白 0.05; 等方スケールで形状不変, 各軸を中央寄せ)
    xy = xy - xy.min(0)
    span = float(xy.max()) or 1.0
    xy = xy / span                                   # 長辺→[0,1], 短辺→[0,<1](等方)
    ext = xy.max(0)                                  # 各軸 extent(長辺=1.0)
    xy = 0.05 + 0.9 * xy + 0.45 * (1.0 - ext)        # 幅0.9の内側へ等方縮小+各軸中央寄せ
    el = np.hypot(xy[ej, 0] - xy[ei, 0], xy[ej, 1] - xy[ei, 1])
    med = float(np.median(el[el > 0])) if np.any(el > 0) else 1e-3
    # 葉半径はエッジ長中央値に比例(スケール相対)。以前の絶対 floor 1e-5 は正規化座標では
    # chrY の med(≈1.9e-5)の半分に達し radius_frac の意図を上書き=ノード過大→エッジ埋没だったので撤廃。
    # 退化(med=0)への保険として med×1e-4 のみ下限に残す。
    base_r = max(args.radius_frac * med, med * 1e-4)
    log(f"normalized; median edge len={med:.5g} base radius={base_r:.5g} (frac={args.radius_frac})")

    # 向き正規化(既定 ON): per連結成分で左右反転し支配 ref コンティグを x 昇順(ゲノム前部が左)へ。
    # 等長変換なので med/base_r は不変。leaf_angles/幾何/edge/ribbon より前=全て反転後座標で一貫。
    if args.orient_ref and (args.gfa or args.distill):
        xy, _nf, _nfn, _nrc = orient_by_ref(xy, ids, ei, ej, args.gfa, args.distill, args.ref_key, log=log)
    elif args.orient_ref:
        log("orient: --gfa/--distill 未指定のため向き正規化スキップ")

    lang = leaf_angles(nnpz, xy, ei, ej, esu, esv)

    # npz の gfa_id -> row(searchsorted 用)
    ord_ids = np.argsort(ids); sids = ids[ord_ids]

    bp_row = np.ones(nnpz, np.float64)   # npz row -> bp
    id_map = None                        # dense -> original(distill 時のみ; node_name 復元に使う)
    if args.distill:
        # distill: bp を s_id(dense)/s_bp(=len(seq.strip()))から。npz ids は dense で同一空間 →
        #   searchsorted で row を引き当て bp_row[row]=max(1,s_bp)。GFA 版の max(1,len(seq.strip())) と同値。
        id_map = np.load(os.path.join(args.distill, "id_map.npy"))
        s_id = np.load(os.path.join(args.distill, "s_id.npy"))
        s_bp = np.load(os.path.join(args.distill, "s_bp.npy"))
        pos = np.clip(np.searchsorted(sids, s_id), 0, len(sids) - 1)
        ok = sids[pos] == s_id
        bp_row[ord_ids[pos[ok]]] = np.maximum(s_bp[ok].astype(np.float64), 1.0)
        log(f"bp from distill: {int(ok.sum()):,}/{nnpz:,} (id_map={'identity' if np.array_equal(id_map, np.arange(1, id_map.size + 1)) else 'remap'})")
    elif args.gfa:
        id2ix = {int(v): k for k, v in enumerate(ids)}
        got = 0
        with open(args.gfa) as f:
            for ln in f:
                if not ln or ln[0] != "S":
                    continue
                p = ln.split("\t", 3)
                k = id2ix.get(int(p[1]))
                if k is not None:
                    bp_row[k] = max(1, len(p[2].strip())); got += 1
        log(f"bp from GFA: {got:,}/{nnpz:,}")

    # ---- 2. typed 木を復元(単一情報源の build_typed) ----
    parent, kind, atom = build_typed(args.typed)
    n = len(parent)
    deg, off, kids = csr_children(parent)
    size = subtree_size(parent, deg)
    nG = sum(1 for k in kind if k == 1); nS = sum(1 for k in kind if k == 2)
    nL = sum(1 for k in kind if k == 0)
    log(f"tree: nodes={n:,} N(root)={size[0]:,} (G={nG:,} S={nS:,} L={nL:,}) max_fanout={max(deg)}")

    # numpy ビュー(array モジュール → zero-copy)
    parent_np = np.frombuffer(parent, np.int32)
    size_np = np.frombuffer(size, np.int32)
    atom_np = np.frombuffer(atom, np.int64)
    kind_np = np.frombuffer(bytes(kind), np.uint8)

    # ---- 4. 幾何: 葉座標を全ノードへボトムアップ集計(depth 準 level scatter) ----
    # (層化 §3 はこの後。budget の span-aware 重みに各ノードの bbox スパンを使うため先に幾何を出す)
    # 4a. tree 葉 → npz row(座標/角度)。 atom>=0 が真の GFA 葉。
    leaf_mask = atom_np >= 0
    leaf_nodes = np.where(leaf_mask)[0]
    la = atom_np[leaf_nodes]
    pos = np.searchsorted(sids, la)
    pos = np.clip(pos, 0, len(sids) - 1)
    valid = sids[pos] == la
    seed_row = np.full(n, -1, np.int64)
    seed_row[leaf_nodes[valid]] = ord_ids[pos[valid]]
    n_missing = int((~valid).sum())
    if n_missing:
        log(f"WARN: {n_missing:,} tree leaves have no npz coord (seeded empty)")

    # 4b. depth(root=0)。array モジュールで高速に。
    depth_a = array('i', [0]) * n
    for v in range(1, n):
        depth_a[v] = depth_a[parent[v]] + 1
    depth = np.frombuffer(depth_a, np.int32)
    maxdepth = int(depth.max())

    # 4c. 葉シード情報(両経路が使う)。sn/sr/lx/ly は leaf override・ref_pos でも参照。
    sn = leaf_nodes[valid]; sr = ord_ids[pos[valid]]
    lx = xy[sr, 0]; ly = xy[sr, 1]
    # order/ds は §4d(Python経路) と compute_ref_pos(§ref) の両方が必要 → 経路に依らず先に作る。
    order = np.argsort(depth, kind="stable")
    ds = depth[order]
    if args.rust_geometry:
        # Rust core: ボトムアップ集約を C 速度・compact 常駐で。死配列(sx..maxy)/bincount一時を持たない。
        import emit_core
        CX, CY, RAD, vxx, vyy, vxy, cnt, sbp, raw_span = emit_core.emit_geometry(
            parent_np, np.ascontiguousarray(sn, dtype=np.int64),
            np.ascontiguousarray(lx), np.ascontiguousarray(ly),
            np.ascontiguousarray(bp_row[sr]), float(base_r), int(n))
        ANG = 0.5 * np.arctan2(2 * vxy, vxx - vyy); ANG[sn] = lang[sr]
        del vxx, vyy, vxy
        log(f"geometry aggregated (rust core, depth={maxdepth}) ({time.time()-t0:.1f}s)")
    else:
        # 4c. 集計器を葉でシード
        cnt = np.zeros(n); sx = np.zeros(n); sy = np.zeros(n)
        sxx = np.zeros(n); syy = np.zeros(n); sxy = np.zeros(n); sbp = np.zeros(n)
        minx = np.full(n, np.inf); maxx = np.full(n, -np.inf)
        miny = np.full(n, np.inf); maxy = np.full(n, -np.inf)
        cnt[sn] = 1.0; sx[sn] = lx; sy[sn] = ly
        sxx[sn] = lx * lx; syy[sn] = ly * ly; sxy[sn] = lx * ly
        sbp[sn] = bp_row[sr]
        minx[sn] = lx; maxx[sn] = lx; miny[sn] = ly; maxy[sn] = ly

        # 4d. depth 深い順に親へ畳み込み(親は depth-1、子は depth。high→low で子は確定済み)
        for dep in range(maxdepth, 0, -1):
            lo = int(np.searchsorted(ds, dep, "left")); hi = int(np.searchsorted(ds, dep, "right"))
            if hi <= lo:
                continue
            idx = order[lo:hi]
            p = parent_np[idx].astype(np.int64)
            cnt += np.bincount(p, cnt[idx], n)
            sx += np.bincount(p, sx[idx], n); sy += np.bincount(p, sy[idx], n)
            sxx += np.bincount(p, sxx[idx], n); syy += np.bincount(p, syy[idx], n)
            sxy += np.bincount(p, sxy[idx], n); sbp += np.bincount(p, sbp[idx], n)
            np.minimum.at(minx, p, minx[idx]); np.maximum.at(maxx, p, maxx[idx])
            np.minimum.at(miny, p, miny[idx]); np.maximum.at(maxy, p, maxy[idx])
        log(f"geometry aggregated over {maxdepth} depth levels ({time.time()-t0:.1f}s)")

        nn = np.maximum(cnt, 1.0)
        CX = sx / nn; CY = sy / nn
        vxx = sxx / nn - CX * CX; vyy = syy / nn - CY * CY; vxy = sxy / nn - CX * CY
        ANG = 0.5 * np.arctan2(2 * vxy, vxx - vyy)
        w = np.where(np.isfinite(maxx), maxx - minx, 0.0)
        h = np.where(np.isfinite(maxy), maxy - miny, 0.0)
        RAD = np.maximum(0.5 * np.maximum(w, h), base_r)
        # 真の葉(atom>=0)は素座標・既定半径・GFA 向き angle に上書き
        CX[sn] = lx; CY[sn] = ly; RAD[sn] = base_r; ANG[sn] = lang[sr]
        raw_span = np.maximum(w, h)

    # 4d'. クラスタ向き符号: 内部ノードの ANG は PCA 主軸で無向(π 曖昧)。配下葉の向き(lang)を単位
    #      ベクトルで集約し、その合成が軸方向 (cosANG,sinANG) と逆(内積<0)なら軸を π 回して符号を多数派へ
    #      揃える。葉は ANG=lang で内積=1>0 のため不変。エッジ端点は付着符号を反転後 ANG へ射影して決める
    #      ため(§8)、ANG 反転しても付着点は不変。矩形は180°対称なので現行描画も不変、尖端グリフのみ向きを反映。
    #      (参照方向は使わない: 参照自身が - になりうるため。タングルは合成が弱く符号が曖昧だが実害小。)
    _dvx = np.zeros(n); _dvy = np.zeros(n)
    _dvx[sn] = np.cos(lang[sr]); _dvy[sn] = np.sin(lang[sr])
    for _dep in range(maxdepth, 0, -1):
        _lo = int(np.searchsorted(ds, _dep, "left")); _hi = int(np.searchsorted(ds, _dep, "right"))
        if _hi <= _lo:
            continue
        _idx = order[_lo:_hi]; _p = parent_np[_idx].astype(np.int64)
        _dvx += np.bincount(_p, _dvx[_idx], n); _dvy += np.bincount(_p, _dvy[_idx], n)
    _flip = (_dvx * np.cos(ANG) + _dvy * np.sin(ANG)) < 0
    ANG[_flip] += np.pi
    ANG = np.arctan2(np.sin(ANG), np.cos(ANG))       # (-π,π] へ正規化
    log(f"cluster orientation sign resolved: flipped {int(_flip.sum()):,}/{n:,} nodes")
    del _dvx, _dvy, _flip

    # ---- 4e. 空間スパン嵩上げ重み(budget span-aware): 葉が少なくても広範囲のノードを早く展開 ----
    #   raw_span[v] = 葉 bbox の max(幅,高)(単一葉=0, 親⊇子で単調)。span_root=全体の max(幅,高)。
    #   eq = λ·N·raw_span/span_root = 「その広がりなら本来これだけ葉があるはず」相当の等価葉数。
    #   weight = max(size, eq): 広がり相応の葉数を持つ compact ノードは size のまま不変、散らばった
    #   広域ノードは eq が勝ち大重み → 予算カットで早期に子へ展開(グリフ巨大化を解消)。葉は eq=0→weight=1。
    span_root = float(raw_span[0]) or 1.0
    eq = np.rint(args.budget_span_weight * size_np[0] * raw_span / span_root).astype(np.int64)
    weight_np = np.maximum(size_np.astype(np.int64), eq)

    # ---- 3. 層化 → 各ノードの在圏区間 [birth, death) ----
    # スケジュールは budget に一本化(kindaware 廃止, [[viewer-lod-use-budget-not-kindaware]])。
    # budget: 部分木サイズ(span 嵩上げ)閾値カットで在圏区間が連続([[relayer_budget]])。上細下粗。
    # 「birth<=L<death なら層 L に在圏」の契約。
    if args.schedule != "budget" or args.merge_tail_frac is not None:
        log(f"[warn] --schedule={args.schedule}/--kG/--kS/--merge-tail-frac は廃止済みで無視します"
            f"(budget で実行)。kindaware は viewer LOD が破綻するため撤去しました。")
    nl, per, birth_a, death_a, thetas = relayer_budget(
        parent_np, size_np, args.budget_floor, args.budget_rmin,
        args.budget_rmax, args.budget_shrink, weight_np=weight_np)
    maxlayer = nl - 1
    birth = np.frombuffer(birth_a, np.int32).astype(np.int64)
    death = np.frombuffer(death_a, np.int32).astype(np.int64)
    n_boost = int((eq > size_np).sum())
    log(f"budget(floor={args.budget_floor} rmin={args.budget_rmin} rmax={args.budget_rmax} "
        f"span_w={args.budget_span_weight}): layers={nl} θ={thetas} per={per} "
        f"span_boosted={n_boost:,}/{n:,}")
    full = next((i for i, c in enumerate(per) if c == size[0]), maxlayer)
    log(f"full-expand @ L{full} (葉総数 {size[0]:,} に達する層)")

    # 開始層シフト: ノード数 > start_min_nodes の最初の層の start_back 手前を新 layer0 に。
    # 内部処理は旧層番号 L のまま行い、DB 書き出し時のみ layer_index = L - start に付番。
    start = 0
    if args.start_min_nodes > 0:
        k1 = next((i for i, c in enumerate(per) if c > args.start_min_nodes), maxlayer)
        start = max(0, k1 - args.start_back)
        log(f"start-shift: 最初に >{args.start_min_nodes} の層=L{k1} → 新 layer0 = 旧 L{start} "
            f"(旧 L0..L{start-1} を破棄; 新層数={maxlayer - start + 1}, 新 layer0 グリフ={per[start]:,})")
    out_maxlayer = maxlayer - start

    # ---- 5. frontier-parent(層間の代表継承)。エッジの層別代表引きに使用 ----
    #   fp[v] = v の最近傍の「出現するノード」(birth>=0)。出現しない中間ノードは飛ばす。
    fp_a = array('l', [-1]) * n
    for v in range(1, n):
        p = parent[v]
        fp_a[v] = p if birth_a[p] >= 0 else fp_a[p]
    fp = np.frombuffer(fp_a, np.int64)

    # ---- 6. DB 準備(--build-tmp 指定時はローカル一時領域でビルドし最後に out-db へ 1 回コピー) ----
    final_out_db = args.out_db
    work_db = final_out_db
    if args.build_tmp:
        os.makedirs(args.build_tmp, exist_ok=True)
        work_db = os.path.join(args.build_tmp, os.path.basename(final_out_db))
        if os.path.exists(work_db):
            os.remove(work_db)
        args.out_db = work_db     # 以降のビルド(copyfile/connect/Rust db_path/fsync)は全て work_db を使う
        log(f"build DB on local staging: {work_db}  (→ 完了後 {final_out_db} へコピー)")
    shutil.copyfile(args.template, args.out_db)
    con = sqlite3.connect(args.out_db)
    con.execute("PRAGMA synchronous=OFF")       # 一括生成専用: 速度優先(耐障害性不要)
    # journal_mode=OFF: ロールバックジャーナルを一切作らない。MEMORY より速く、in-RAM ジャーナルの
    # ピーク常駐も消える(単スロット化のメモリ余裕にも効く)。MEMORY/OFF/DELETE はいずれも DB ヘッダ
    # の file-format 版=1 で本体バイト不変 → 既存 bit-identical を維持(WAL は版=2 で不可・sidecar 発生)。
    # build 中の耐障害性は不要(出力は再生成可能・crash 時は再実行)。この OFF は当接続限りで DB に永続せず
    # (非WAL journal_mode は per-connection)、後で viewer が編集を書き戻す際は viewer 接続の既定(DELETE)が
    # 保護するので安全。完成 DB の確定は close 後の明示 fsync(main 末尾)で担保する。
    con.execute("PRAGMA journal_mode=OFF")
    cur = con.cursor()
    for t in ("nodes", "edges", "nodes_rtree", "edges_rtree", "paths", "path_steps",
              "utg_ctg_links", "ctg_paths", "path_groups", "node_group_cov"):
        try:
            cur.execute(f"DELETE FROM {t}")
        except sqlite3.OperationalError:
            pass
    con.commit()

    # edges は座標非保存スキーマへ差し替える(テンプレの 8 座標列 + edges_rtree を廃止)。
    # 端点はノードのロッド端(中心 ± radius·(cosANG,sinANG)) で、どちらの端かだけを符号で保持:
    #   src_sign / tgt_sign ∈ {+1,-1} = GFA の side(向き)。0 = 向き情報なし(相手中心方向のフォールバック)。
    # viewer は nodes(xCoord,yCoord,radius,angle)+符号から start/end を厳密復元する(cos/sin は libm)。
    # PK(layer_index,source,target) が source 枝の covering、追加索引が target 枝の covering。
    # ビューポートのエッジ検索は nodes_rtree で可視ノード集合→両枝を索引 probe(edges_rtree 不要)。
    cur.execute("DROP TABLE IF EXISTS edges_rtree")   # 仮想 rtree + シャドウ表を除去
    cur.execute("DROP TABLE IF EXISTS edges")
    cur.execute(
        "CREATE TABLE edges (\n"
        "    layer_index INTEGER,\n"
        "    source      TEXT,\n"
        "    target      TEXT,\n"
        "    src_sign    INTEGER,\n"
        "    tgt_sign    INTEGER,\n"
        # `haplotypes` 列は廃止(2026-08-16)。常に空文字を入れていただけで読む側も無かった。
        "    PRIMARY KEY (layer_index, source, target)\n"
        ")")
    # ★idx_edges_ts は **挿入後** に作る（§8 末尾）。
    #   ここで作ると 3.06 億行の挿入がその索引への随機 B-tree 挿入を伴う。
    #   target 順は挿入順(layer,source 順)と無相関なので全行がランダム書き込みになる。
    #   共有FS 直書きの実測(10M 行, /tmp 不使用): 索引を先に作ると 75.0s、後に回すと
    #   挿入 15.5s + 索引 5.9s = 21.4s ＝ **3.5x**。ビルド中に edges を引く箇所は無いので安全。
    con.commit()

    # ★nodes のテンプレート由来索引も外す。`DELETE FROM nodes` では索引は消えないので、
    #   2.45 億行の挿入が idx_nodes_node_name(node_name 単独) への随機挿入を伴っていた。
    #   node_name は層順の挿入に対して完全に散らばるため、索引全域にランダム書き込みが出る。
    #   PK(layer_index,node_name) の自動索引は表の再作成が要るので今回は触らない
    #   （層プレフィックスがあるぶん局所性がまだある）。
    #   ビルド中の唯一の node_name 参照(L864)は `WHERE layer_index=? AND node_name GLOB` で
    #   PK 前置列を使うので、この索引が無くても計画は変わらない。
    cur.execute("DROP INDEX IF EXISTS idx_nodes_node_name")
    con.commit()

    def kchar(k):
        return "G" if k == 1 else ("S" if k == 2 else "X")

    def gname(v):
        if v == 0:
            return "root"
        a = int(atom_np[v])
        return f"n{a}" if a >= 0 else f"{kchar(int(kind_np[v]))}{v}"

    def rep_at(nodes, L):
        # 葉から fp を上り、層 L で在圏する代表(birth<=L の最深の出現ノード)へ。
        # 未出現(birth<0)ノードも上る。最深在圏祖先は death>L が保証される。
        r = nodes.copy()
        m = (birth[r] > L) | (birth[r] < 0)
        while m.any():
            r[m] = fp[r[m]]
            m = (birth[r] > L) | (birth[r] < 0)
        return r

    # parent_name 列(直上層 layer_index-1 の所属クラスタ名)。テンプレート由来スキーマに無ければ ALTER で追加。
    # DB layer0(旧 L=start)は森の根 → NULL。層 Lw>0 の各ノード v の親は rep_at(v, L-1)(=v が L-1 に
    # 在圏すれば自名、L で新生した子なら L-1 の所属クラスタ)。索引(子孫再帰降下用)は挿入後に張る(§7 末尾)。
    _ncols = [r[1] for r in cur.execute("PRAGMA table_info(nodes)").fetchall()]
    if "parent_name" not in _ncols:
        cur.execute("ALTER TABLE nodes ADD COLUMN parent_name TEXT")
    # comp_id 列(連結成分ID)。viewer の「融合(同一成分) vs 近接(別成分)」判定用。値は §8 の en_i/en_j
    # 確定後に葉の連結成分を求めて木へ伝播し、ref_strand と同じ rowid 規約で UPDATE する。
    if "comp_id" not in _ncols:
        cur.execute("ALTER TABLE nodes ADD COLUMN comp_id INTEGER")
    # kind 列(0=葉/L, 1=クラスタ/G, 2=バブル/S)。node_name 接頭辞(n/S/G)と同義だが明示 1 バイト属性で
    # クエリしやすく(is_bubble は size!=1 の集約フラグで kind ではない=別物・残置)。ref_strand と同じ rowid 規約で UPDATE。
    if "kind" not in _ncols:
        cur.execute("ALTER TABLE nodes ADD COLUMN kind INTEGER")
    con.commit()

    # 参照座標(ref_bp)トラック: 参照パス(既定 GRCh38)上の累積 bp を各ノードのスカラ列に持たせる
    # (ANNOTATION_TRACKS_DESIGN.md §10-13 / EMITTER_REFPOS_SPEC.md)。node 行取得に相乗りする列なので追加取得ゼロ。
    # 値は層非依存に全木ノードへ 1 回集約し、§7 の書き出しループで rowid ごとに UPDATE(name_all[P] と同じ添字整合)。
    ref_cols = None
    ref_strand_arr = None           # ref_strand は rowid 規約で別 UPDATE(emit_core の ref 5列固定を避ける)
    if args.emit_ref_bp and (args.gfa or args.distill):
        for _c in ("ref_contig_id", "ref_bp", "ref_bp_end", "is_anchor", "ref_multi", "ref_strand"):
            if _c not in _ncols:
                cur.execute(f"ALTER TABLE nodes ADD COLUMN {_c} INTEGER")
        cur.execute("DROP TABLE IF EXISTS ref_meta")
        # max_span = max(ref_bp_end - ref_bp) = 参照区間の最長ノード長。viewer の /goto は
        # 「ref_bp <= T かつ ref_bp_end >= T」で位置を含むノードを探すが、後者は索引で表現できない
        # ため素直に書くと「コンティグ先頭〜T」の片側レンジを舐める。max_span があれば
        # `ref_bp >= T - max_span` を下限に足せる(区間長がこれを超えるノードは無いので取りこぼさない)。
        # ⚠ ただし実測では**この下限はほぼ効かない**: リピート/サイクルで参照パスが同じノードを
        #   離れた 2 か所で通ると ref_bp=min/ref_bp_end=max となり見かけの区間長が巨大になる。
        #   chr22 実測 max_span=50,818,468bp = コンティグ全長(葉 layer 12 に限っても 12.0Mb、
        #   is_anchor=1 に限っても同じ)。span>1Mb のノードが 1,400,433 中 44,207 件ある。
        #   /goto が速くなったのは(72.4s→0.50s cold)ほぼ idx_nodes_refpos 自体の効果で、
        #   下限クリップの寄与ではない。値としては常に正しいので残す(参照によっては効く)。
        # NULL/欠落なら viewer 側は下限なしにフォールバックする。
        cur.execute("CREATE TABLE ref_meta(ref_key TEXT, is_default INTEGER, max_span INTEGER)")
        cur.execute("DROP TABLE IF EXISTS ref_contigs")
        cur.execute("CREATE TABLE ref_contigs(contig_id INTEGER PRIMARY KEY, ref_key TEXT, "
                    "name TEXT, length_bp INTEGER)")
        present, ref_contigs, _rcid, _rbp, _rbpe, _ranc, _rmul, _rstr = compute_ref_pos(
            args.gfa, args.distill, args.ref_key, sids, ord_ids, bp_row,
            sr, sn, nnpz, n, parent_np, order, ds, maxdepth)
        if present:
            # numpy 上で算出(DB 走査ゼロ)。ref_bp_end が NULL の行は幅 0 とみなす。
            _sp = np.where((_rbp >= 0) & (_rbpe >= 0), _rbpe - _rbp, 0)
            _max_span = int(_sp.max()) if _sp.size else 0
            cur.execute("INSERT INTO ref_meta(ref_key,is_default,max_span) VALUES(?,1,?)",
                        (args.ref_key, _max_span))
            log(f"ref-pos: max_span={_max_span:,}bp (/goto の下限クリップに使う)")
            cur.executemany("INSERT INTO ref_contigs(contig_id,ref_key,name,length_bp) "
                            "VALUES(?,?,?,?)", ref_contigs)
            ref_cols = (_rcid, _rbp, _rbpe, _ranc, _rmul)
            ref_strand_arr = _rstr           # ref_strand は emit_core(5列固定)に載せず node_name で別 UPDATE
            _len = sum(c[3] for c in ref_contigs)
            log(f"ref-pos: ref_key={args.ref_key} contigs={len(ref_contigs)} "
                f"Σlen={_len:,}bp anchored-nodes={int((_ranc == 1).sum()):,}")
        else:
            log(f"ref-pos: ref_key={args.ref_key} にマッチするパス無し → ref 列は NULL のまま")
        con.commit()
    elif args.emit_ref_bp:
        log("ref-pos: --gfa/--distill 未指定のため ref_bp 列はスキップ")

    # node_name は node id の純関数(層不変)。旧実装は層ごとに [gname(int(v)) for v in P] を
    # 再計算し、永続葉が birth..death の全層で再登場するため gname 呼び出しが Σ_L N_L 回に膨れていた。
    # ここで全 n ノード分を1回だけベクトル構築(gname と厳密に同値)し、各層は name_all[P] で引くだけにする。
    #   gname(v): v==0->"root"; atom>=0->f"n{atom}"; else f"{kchar(kind)}{v}"  (kchar: 1->G,2->S,他->X)
    # name_all は Python 経路(§7 node / §8 edge)のみ使用。node/edge とも Rust なら構築不要(~8GB 節約)。
    name_all = None
    if (not args.rust_nodes) or (not args.rust_edges):
        name_all = np.empty(n, dtype=object)
        _leaf = atom_np >= 0
        _leaf_atoms = atom_np[_leaf]
        if id_map is not None:
            # dense atom -> 元 id(表示名 node_name のみ復元; row2node 照合等は dense のまま)。identity なら無変換。
            _leaf_atoms = id_map[_leaf_atoms - 1]
        name_all[_leaf] = np.char.add("n", _leaf_atoms.astype("U"))
        _nl = ~_leaf
        if _nl.any():
            _kk = kind_np[_nl].astype(np.int64)
            _ch = np.where(_kk == 1, "G", np.where(_kk == 2, "S", "X"))
            name_all[_nl] = np.char.add(_ch.astype("U"), np.nonzero(_nl)[0].astype("U"))
        if n > 0:
            name_all[0] = "root"                      # v==0 は atom/kind に依らず root(gname 先頭分岐)
    CHUNK = 1_000_000                                 # executemany を分割し Python リスト常駐を CHUNK 行に抑える

    # ---- 7. ノード行(在圏 birth<=L<death; 終端 size==1 は death=maxlayer+1 で永続) ----
    #
    # nodes_rtree の二重構築を避ける: 後段の hapidx 段が hap マスク補助列つきで nodes_rtree を
    # 作り直すので、そこが走るなら §7 では rtree に入れない(chrY 実測 9s→19.1s、WG 外挿 +約1.8h)。
    # ※rtree の aux を後から UPDATE で埋める案は実測で 73k 行/s < aux 込み INSERT 146k 行/s と
    #   逆に遅かったので、挿入自体を飛ばす形にした。
    # ⚠ 飛ばした場合、hapidx が失敗すると nodes_rtree が **空** のまま残り viewer が表示不能になる。
    #   §8.6 に「失敗したら素の nodes_rtree をここで作る」フォールバックを必ず置く（下記 _rtree_pending）。
    _rtree_pending = bool(args.emit_hapidx and args.emit_ribbon_contig and (args.gfa or args.distill))
    if _rtree_pending:
        log("nodes_rtree: §7 では入れず hapidx 段で補助列つきに一括構築する(二重構築の回避)")
    born = np.where(birth >= 0)[0]                       # 出現するノードのみ
    b_born = birth[born]; d_born = death[born]
    # ★空間順の採番。ここで 1 回だけ決めて以降の全経路（nodes / ribbon / inv / mult）が共有する。
    global _SPATIAL_ORDER
    _SPATIAL_ORDER = spatial_order_of(CX, CY, parent, log) if args.spatial_order else None
    rid = 0
    n_written = 0
    if args.rust_nodes:
        # §7 を Rust core へ委譲。name_all を持たず Rust が名前生成、ref 列は INSERT に畳む。
        import emit_core
        con.commit(); con.close()
        if ref_cols is not None:
            _rc, _rb, _rbe, _ra, _rm = (np.ascontiguousarray(a, dtype=np.int64) for a in ref_cols)
        else:
            _rc = _rb = _rbe = _ra = _rm = None
        rid, per_layer_n = emit_core.emit_nodes(
            args.out_db, birth, death, fp, CX, CY, RAD, ANG, cnt, sbp,
            np.ascontiguousarray(size_np, dtype=np.int64), atom_np, kind_np,
            (id_map.astype(np.int64) if id_map is not None else None),
            _rc, _rb, _rbe, _ra, _rm, int(start), int(maxlayer), int(n),
            skip_rtree=_rtree_pending, spatial_order=_SPATIAL_ORDER)
        con = sqlite3.connect(args.out_db)
        con.execute("PRAGMA synchronous=OFF"); con.execute("PRAGMA journal_mode=OFF")
        cur = con.cursor()
        n_written = rid
        for _Lw, _k in enumerate(per_layer_n):
            if _k:
                log(f"  L{_Lw}: nodes={_k:,}")
        log(f"nodes written (rust core): {n_written:,} rows ({time.time()-t0:.1f}s)")
    for L in range(start, maxlayer + 1):
        if args.rust_nodes:
            break
        Lw = L - start                                   # 書き出す layer_index
        P = born[(b_born <= L) & (L < d_born)]
        k = len(P)
        if k == 0:
            continue
        cx = CX[P]; cy = CY[P]; rad = RAD[P]; ang = ANG[P]
        cov = cnt[P]; sz = sbp[P]
        isbub = (size_np[P] != 1).astype(np.int64)      # 内部=1(bubble) / 終端=0
        names = name_all[P]                             # 事前計算 name_all を引くだけ(層ごとの gname 再計算を排除)
        # parent_name: DB layer0 は根(NULL)。それ以外は直上層 L-1 の代表クラスタ名。
        pnames = None if Lw == 0 else name_all[rep_at(P, L - 1)]
        # executemany を CHUNK 行ずつに分割(全層マテリアライズの Python リスト常駐を O(N_layer)→O(CHUNK) に)。
        rid0 = rid
        for s in range(0, k, CHUNK):
            e = min(s + CHUNK, k)
            pn = itertools.repeat(None, e - s) if Lw == 0 else pnames[s:e].tolist()
            cur.executemany(
                # ★`haplotype` 列は書かない（2026-08-16 廃止）。中身は
                #   `size==1 ? "a" : "b"` ＝ **is_bubble の別表記**で、ハプロタイプの意味は無かった
                #   （実測: haplotype='a' ⟺ is_bubble=0、不一致 0 件）。viewer がこれを
                #   ハプロタイプ色として塗っていたため誤解を招いていた。
                "INSERT INTO nodes(layer_index,node_name,is_bubble,size,xCoord,yCoord,"
                "angle,radius,color,coverage,parent_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                zip(itertools.repeat(Lw, e - s), names[s:e].tolist(),
                    isbub[s:e].tolist(), sz[s:e].tolist(), cx[s:e].tolist(), cy[s:e].tolist(),
                    ang[s:e].tolist(), rad[s:e].tolist(), isbub[s:e].tolist(),
                    cov[s:e].tolist(), pn))
        rids = np.arange(rid0 + 1, rid0 + 1 + k); rid += k
        if not _rtree_pending:
            rminx = cx - rad; rmaxx = cx + rad; rminy = cy - rad; rmaxy = cy + rad
            for s in range(0, k, CHUNK):
                e = min(s + CHUNK, k)
                cur.executemany("INSERT INTO nodes_rtree(rowid,min_x,max_x,min_y,max_y,"
                                "min_layer,max_layer) VALUES(?,?,?,?,?,?,?)",
                    zip(rids[s:e].tolist(), rminx[s:e].tolist(), rmaxx[s:e].tolist(),
                        rminy[s:e].tolist(), rmaxy[s:e].tolist(),
                        itertools.repeat(Lw, e - s), itertools.repeat(Lw, e - s)))
        # ref_bp 列: rowid は INSERT と同一順(rid0+1+index_in_P) → rids で UPDATE(name_all[P] と同じ添字整合)。
        # 未被覆(-1)は NULL に落とす。is_anchor/ref_multi は 0/1。
        if ref_cols is not None:
            _rcid, _rbp, _rbpe, _ranc, _rmul = ref_cols
            rc = _rcid[P]; rb = _rbp[P]; rbe = _rbpe[P]; ra = _ranc[P]; rm = _rmul[P]
            for s in range(0, k, CHUNK):
                e = min(s + CHUNK, k)
                cur.executemany(
                    "UPDATE nodes SET ref_contig_id=?,ref_bp=?,ref_bp_end=?,is_anchor=?,ref_multi=? "
                    "WHERE rowid=?",
                    zip((None if x < 0 else x for x in rc[s:e].tolist()),
                        (None if x < 0 else x for x in rb[s:e].tolist()),
                        (None if x < 0 else x for x in rbe[s:e].tolist()),
                        ra[s:e].tolist(), rm[s:e].tolist(), rids[s:e].tolist()))
        n_written += k
        con.commit()
        n_int = int((size_np[P] > 1).sum())
        log(f"  L{Lw}(旧L{L}): nodes={k:,} (internal={n_int:,} terminal={k - n_int:,})")
    # ★この 2 つ(ref_strand / kind)は **rowid を自前で再計算**して UPDATE する。
    #   採番規約が「各層の born 順」から「各層の **空間順**」に変わったので、ここも合わせないと
    #   値が別のノードに付く。実際 chr22 で kind が S(=2) のノードに 0 が入る形で踏んだ
    #   （幾何もブロブも一致するのに kind だけずれる＝在庫検査では絶対に出ない壊れ方）。
    #   born を空間順に並べたものを 1 回作り、両方がそれを使う。
    _born_ord = born
    if _SPATIAL_ORDER is not None:
        _rank = np.empty(len(fp), dtype=np.int64)
        _rank[_SPATIAL_ORDER] = np.arange(_SPATIAL_ORDER.size, dtype=np.int64)
        _born_ord = born[np.argsort(_rank[born], kind="stable")]
    _b_ord = birth[_born_ord]; _d_ord = death[_born_ord]

    if ref_strand_arr is not None:
        _rid0 = 0
        for L in range(start, maxlayer + 1):
            P = _born_ord[(_b_ord <= L) & (L < _d_ord)]
            kL = len(P)
            if kL == 0:
                continue
            rs = ref_strand_arr[P]
            rids = np.arange(_rid0 + 1, _rid0 + 1 + kL)
            for s in range(0, kL, CHUNK):
                e = min(s + CHUNK, kL)
                cur.executemany("UPDATE nodes SET ref_strand=? WHERE rowid=?",
                    zip((None if x < 0 else int(x) for x in rs[s:e].tolist()), rids[s:e].tolist()))
            _rid0 += kL
        con.commit()
        log(f"ref_strand written for {int((ref_strand_arr >= 0).sum()):,} nodes")
    # kind(0=葉/1=クラスタ G/2=flubble S)を全ノードへ UPDATE(ref_strand と同 rowid 規約: 各層 born 順)。
    # kind_np は build_typed 由来(0=L,1=G,2=S)。emit_core(nodes 5列+ref)に載せず後段で書く。
    _rid0 = 0
    for L in range(start, maxlayer + 1):
        P = _born_ord[(_b_ord <= L) & (L < _d_ord)]
        kL = len(P)
        if kL == 0:
            continue
        kk = kind_np[P]
        rids = np.arange(_rid0 + 1, _rid0 + 1 + kL)
        for s in range(0, kL, CHUNK):
            e = min(s + CHUNK, kL)
            cur.executemany("UPDATE nodes SET kind=? WHERE rowid=?",
                zip((int(x) for x in kk[s:e].tolist()), rids[s:e].tolist()))
        _rid0 += kL
    con.commit()
    log(f"kind written (0=leaf/1=cluster/2=flubble) for {n_written:,} nodes")
    # parent_name 索引(viewer の子孫再帰降下 WITH RECURSIVE 用)は全挿入後に一括構築(bulk-load 高速化)。
    # 挿入前に外した node_name 索引をここで張り直す（bulk-load 後の一括構築）。
    cur.execute("CREATE INDEX IF NOT EXISTS idx_nodes_node_name ON nodes(node_name)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_name)")
    con.commit()
    # 参照座標索引(viewer の Find>Position = /goto 用)。これが無いと /goto は nodes 全走査になり、
    # chr22(6.8M 行/590MB)で **cold 72 秒**、しかも better-sqlite3 は同期 API なので backend の
    # イベントループがその間まるごと停止する(= 全ユーザの全リクエストが固まる)。WG では桁が上がる。
    # 部分索引(WHERE ref_bp IS NOT NULL)にするのは、ref を持たないノード(内部層の大半)を索引から
    # 落として小さく保つため。
    #
    # ★4 列にして **被覆索引**にするのが要点。含有判定 `COALESCE(ref_bp_end, ref_bp) >= T` と
    #   `ORDER BY layer_index DESC` に要る列まで索引へ入れ、表アクセスを勝者 1 行だけにする。
    #   (ref_contig_id, ref_bp) の 2 列だけだと候補ごとに ref_bp_end を**表から**引くので、
    #   コンティグ後半を狙うほど遅い。chr22 で別ノード・コールド実測(bp=44-45Mb):
    #       2 列索引 29.84s / 4 列被覆索引 **0.11s** / 3次元 rtree 0.01s
    #   サイズは 18MB → 28MB(+10MB)。rtree はさらに 100 倍速いが +98MB と実装コストに見合わない。
    if ref_cols is not None:
        cur.execute("CREATE INDEX IF NOT EXISTS idx_nodes_refpos "
                    "ON nodes(ref_contig_id, ref_bp, ref_bp_end, layer_index) "
                    "WHERE ref_bp IS NOT NULL")
        con.commit()
        log("idx_nodes_refpos built (被覆索引 4 列; Find>Position /goto 用)")
    log(f"nodes written: {n_written:,} rows over layers 0..{out_maxlayer} ({time.time()-t0:.1f}s)")

    # ---- 8. エッジ行(layer 毎: 端点の葉を層代表へ climb → 集約) ----
    # GFA 辺端点の tree 葉ノード
    posi = np.searchsorted(sids, ids[ei]); posi = np.clip(posi, 0, len(sids) - 1)
    posj = np.searchsorted(sids, ids[ej]); posj = np.clip(posj, 0, len(sids) - 1)
    # npz row -> tree leaf node（真の葉のみ)
    row2node = np.full(nnpz, -1, np.int64)
    row2node[sr] = sn                                   # sr=npz row, sn=tree node
    en_i = row2node[ei]; en_j = row2node[ej]
    okE = (en_i >= 0) & (en_j >= 0) & (ei != ej)
    en_i = en_i[okE]; en_j = en_j[okE]

    # --- comp_id: 葉の連結成分(union-find via scipy)を木へ上方伝播し、ref_strand と同じ rowid 規約で書く。
    #     同一 comp_id ⟺ 同一連結成分(super-node は配下葉の成分を継ぐ=層をまたいで一貫)。viewer の
    #     融合(同一成分) vs 近接(別成分)判定用。con は開いたまま(edge 発行の前に UPDATE→commit)。
    try:
        import scipy.sparse as _spsp
        from scipy.sparse.csgraph import connected_components as _cc
        _cg = _spsp.coo_matrix((np.ones(en_i.size, np.int8), (en_i, en_j)), shape=(n, n))
        _nc, _lab = _cc(_cg, directed=False)          # 葉グラフの CC(辺なし内部ノードは孤立ラベル)
        comp_arr = np.full(n, -1, np.int64)
        comp_arr[sn] = _lab[sn]                        # 葉(sn=leaf tree nodes)を CC で seed
        for _dep in range(maxdepth, 0, -1):            # 深い順に親へ伝播(geometry と同じ depth 走査)
            _lo = int(np.searchsorted(ds, _dep, "left")); _hi = int(np.searchsorted(ds, _dep, "right"))
            if _hi <= _lo:
                continue
            _idx = order[_lo:_hi]; _p = parent_np[_idx]
            _m = comp_arr[_idx] >= 0
            comp_arr[_p[_m]] = comp_arr[_idx][_m]      # 親=子の成分(同一内部の子は全て同成分)
        _cid0 = 0
        for L in range(start, maxlayer + 1):
            P = born[(b_born <= L) & (L < d_born)]
            kL = len(P)
            if kL == 0:
                continue
            cvals = comp_arr[P]
            rids = np.arange(_cid0 + 1, _cid0 + 1 + kL)
            for s in range(0, kL, CHUNK):
                e = min(s + CHUNK, kL)
                cur.executemany("UPDATE nodes SET comp_id=? WHERE rowid=?",
                    zip((None if x < 0 else int(x) for x in cvals[s:e].tolist()), rids[s:e].tolist()))
            _cid0 += kL
        con.commit()
        cur.execute("CREATE INDEX IF NOT EXISTS idx_nodes_layer_comp ON nodes(layer_index, comp_id)")
        con.commit()
        log(f"comp_id written: {int(_nc):,} leaf components ({time.time()-t0:.1f}s)")
    except Exception as _e:
        log(f"comp_id skipped: {type(_e).__name__}: {_e}")

    # hb（hap-breadth）用の被覆索引。エッジ太さ/breadth 表示は
    # `node_contig_cov.hb` / `edge_contig_cov.hb` を rowid 点引きするが、これらの表は
    # **1 行 195B / 161B**（blob が大半）なので、hb 1 バイトのために太い行＝4KB ページを丸ごと読む。
    # WG の cold ではここが効く（ビューポート内の行数ぶんランダム読み）。
    # (rowid, hb) の被覆索引を置くと、同じ hb を 13B/行の索引から取れる。
    # 実測（chr22, dbstat のページ数）:
    #   node_contig_cov 349,219 → idx_ncc_hb 22,968 ページ = **15.2 分の 1**（索引 +89MB）
    #   edge_contig_cov 296,094 → idx_ecc_hb 29,645 ページ = **10.0 分の 1**（索引 +115MB）
    #   構築は 2 本で 4.2 秒（chr22）。WG では +約 5.9GB（273GB の 2%）の見込み。
    # ★SQLite は自分では使わない（rowid シークを最安と見る）。viewer 側が `INDEXED BY` で
    #   明示的に強制する（nodeQuery.ts hbCoveringIdx）。索引が無ければ従来どおり太い行を読む。
    # ★ここで作ってはいけない: node_contig_cov / edge_contig_cov は **この時点では存在しない**
    #   (§8.55 の contig リボン段で作られる。chr22 実測で comp_id 16:52:57 に対しリボン完了 16:57:32)。
    #   ここに置いていたので pragma_table_info が空を返し、索引が**黙って作られていなかった**
    #   (ログも出ないので気付けなかった)。実際の生成は _build_hb_covering_idx() で
    #   リボン/hapidx の後に呼ぶ。
    # エッジ端点は「ノード=円」の円周でなく「ノード=ロッド(中心±radius·(cosANG,sinANG))」の端に付ける。
    # どちらの端かは GFA の向き(L 行)で構造的に確定する: leaf_angles 規約で dir=(cosANG,sinANG) は
    # side0→side1 を指すので side1 端=center+RAD·dir, side0 端=center−RAD·dir。
    #   → 各 GFA 葉辺の端点のワールド座標 P = center + sgn·RAD·dir, sgn=+1(side1)/−1(side0) を先に確定。
    # 層代表(group)へ climb 後は、この P を代表グリフの主軸へ射影した符号で「どちらのロッド端に付くか」を
    # 決める(下の loop)。葉層では代表=葉自身なので射影符号は side に一致(規約が自己整合)。
    have_or = (esu is not None) and (esv is not None)
    if have_or:
        su = esu[okE]; sv = esv[okE]
    if have_or and not args.rust_edges:
        # PIx..PJy(4×E float64 常駐)は Python 経路のみ。Rust 経路は cos/sin を渡して Rust 内で算出。
        sgi = np.where(su == 1, 1.0, -1.0); sgj = np.where(sv == 1, 1.0, -1.0)
        PIx = CX[en_i] + sgi * RAD[en_i] * np.cos(ANG[en_i])
        PIy = CY[en_i] + sgi * RAD[en_i] * np.sin(ANG[en_i])
        PJx = CX[en_j] + sgj * RAD[en_j] * np.cos(ANG[en_j])
        PJy = CY[en_j] + sgj * RAD[en_j] * np.sin(ANG[en_j])

    e_rid = 0; e_total = 0
    if args.rust_edges:
        # §8 を Rust core へ委譲。Python con を commit+close(単一writer)→Rust が edges/edges_rtree を
        # streaming 書込→再 open。cos/sin は precompute して渡し、Rust は基本演算のみ→bit一致想定。
        import emit_core
        cosANG = np.cos(ANG); sinANG = np.sin(ANG)
        con.commit(); con.close()
        e_total, per_layer = emit_core.emit_edges(
            args.out_db,
            np.ascontiguousarray(en_i), np.ascontiguousarray(en_j),
            (np.ascontiguousarray(su) if have_or else None),
            (np.ascontiguousarray(sv) if have_or else None),
            birth, fp, CX, CY, RAD, cosANG, sinANG,
            atom_np, kind_np,
            (id_map.astype(np.int64) if id_map is not None else None),
            int(start), int(maxlayer), int(n), spatial_order=_SPATIAL_ORDER)
        con = sqlite3.connect(args.out_db)
        con.execute("PRAGMA synchronous=OFF"); con.execute("PRAGMA journal_mode=OFF")
        cur = con.cursor()
        for _Lw, _ke in enumerate(per_layer):
            if _ke:
                log(f"  L{_Lw}: edges={_ke:,}")
        log(f"edges written (rust core): {e_total:,} rows ({time.time()-t0:.1f}s)")
    for L in range(start, maxlayer + 1):
        if args.rust_edges:
            break
        Lw = L - start                                   # 書き出す layer_index
        ga = rep_at(en_i, L); gb = rep_at(en_j, L)
        m = ga != gb
        if not np.any(m):
            continue
        a = ga[m]; b = gb[m]
        lo = np.minimum(a, b); hi = np.maximum(a, b)
        key = lo * n + hi
        if have_or:
            # 端点をロッド端へ: 各生き残り葉辺のワールド端点 P を、その端点が属する層代表グリフの
            # 主軸へ射影し、符号(±)で center±RAD·dir のどちら端かを決める。多重葉辺が同じグリフ対に
            # 集約される場合は射影の総和の符号で代表端を選ぶ(PK が多重度を畳むため)。
            # 座標は保存せず「どちらの端か」の符号だけ持つ(viewer が nodes+符号から厳密復元)。
            uk, inv = np.unique(key, return_inverse=True)
            inv = np.asarray(inv).ravel()
            ua = uk // n; ub = uk % n
            pa = ((PIx[m] - CX[a]) * np.cos(ANG[a]) + (PIy[m] - CY[a]) * np.sin(ANG[a]))
            pb = ((PJx[m] - CX[b]) * np.cos(ANG[b]) + (PJy[m] - CY[b]) * np.sin(ANG[b]))
            a_is_lo = a < b                                   # a(=ga) が lo(=ua) 側か
            projLo = np.where(a_is_lo, pa, pb)                # lo グリフに寄与する射影
            projHi = np.where(a_is_lo, pb, pa)                # hi グリフに寄与する射影
            ke = len(uk)
            sumLo = np.zeros(ke); np.add.at(sumLo, inv, projLo)
            sumHi = np.zeros(ke); np.add.at(sumHi, inv, projHi)
            srcS = np.where(sumLo >= 0, 1, -1).astype(np.int64)   # +1=side1(center+RAD·dir) / -1=side0
            tgtS = np.where(sumHi >= 0, 1, -1).astype(np.int64)
        else:
            # 向き情報なし: 相手中心方向の円周点フォールバック。符号 0 で viewer が幾何復元。
            uk = np.unique(key)
            ua = uk // n; ub = uk % n
            ke = len(uk)
            srcS = np.zeros(ke, np.int64); tgtS = np.zeros(ke, np.int64)
        na = name_all[ua]; nb = name_all[ub]           # 事前計算 name_all(層ごとの gname 再計算を排除)
        for s in range(0, ke, CHUNK):
            e = min(s + CHUNK, ke)
            cur.executemany(
                # ★`haplotypes` 列は書かない(2026-08-16 廃止)。常に空文字を入れていただけ。
                "INSERT INTO edges(layer_index,source,target,src_sign,tgt_sign) "
                "VALUES(?,?,?,?,?)",
                zip(itertools.repeat(Lw, e - s), na[s:e].tolist(), nb[s:e].tolist(),
                    srcS[s:e].tolist(), tgtS[s:e].tolist()))
        e_rid += ke
        e_total += ke
        con.commit()
        log(f"  L{Lw}(旧L{L}): edges={ke:,}")

    # ★edges の target 側索引はここで一括構築する（挿入前に作ると 3.5x 遅い。§6 のコメント参照）。
    _t_ix = time.time()
    cur.execute("CREATE INDEX IF NOT EXISTS idx_edges_ts ON edges(layer_index, target, source)")
    con.commit()
    log(f"idx_edges_ts built ({time.time()-_t_ix:.1f}s)")

    # ---- 8.5 パスリボン(群 × 層代表 super-node の被覆塩基): 旧 layout_group_cov.py の移植 ----
    if args.emit_ribbon and (args.gfa or args.distill):
        emit_ribbon(cur, con, args.gfa, sids, ord_ids, bp_row, row2node, rep_at,
                    born, b_born, d_born, start, maxlayer, n, t0, distill=args.distill)
    elif args.emit_ribbon:
        log("ribbon: --gfa/--distill 未指定のためリボン表はスキップ")

    # ---- 8.55 contig 前向き索引(既定; hap 索引の一本化置換): sample/hap/contig の全リボンを賄う ----
    #   node_contig_cov(疎 (id,cov) リスト) + edge_contig_cov(疎 id リスト) + contig_dict/contigcov_meta。
    #   融合: node パス走査で edge 三つ組も同時に集め edge_precomp として edge 側へ渡す(GFA 再走査省略)。
    _max_mult_build = None   # emit_hap_mult が返す build時 max_mult(db_meta 用; mult 未出力なら None)
    if args.emit_ribbon_contig and (args.gfa or args.distill):
        if args.rust_ribbon:
            # rust_layers 時は各 ribbon 関数が自前接続を開閉 → main の con を先に閉じ、後で開き直す。
            con.commit(); con.close()
        # §7.2 走査統合: 多重度を ribbon の全トークン走査へ相乗り集約(mult 専用走査を削減)。stream 経路のみ。
        _mult_out = []
        contig_gid, edge_precomp, _cmeta, _tcov = emit_ribbon_contig(
            cur, con, args.gfa, sids, ord_ids, bp_row, row2node, rep_at,
            born, b_born, d_born, start, maxlayer, n, sbp, t0,
            stream=args.ribbon_stream, distill=args.distill,
            rust_layers=args.rust_ribbon, out_db=args.out_db, birth=birth, death=death, fp=fp,
            ribbon_disk=args.ribbon_disk, ribbon_spill_dir=args.ribbon_spill_dir,
            emit_mult=(args.emit_multiplicity and (args.gfa or args.distill)), mult_out=_mult_out)
        _mult_feeder = _mult_out[0] if _mult_out else None
        # A-2: edge hap-breadth 用に contig_id→hap_id を渡す(非rust 経路で edge_contig_cov.hb を書く)。
        _c2h_edge = _build_contig2hap(_cmeta)[0] if _cmeta else None
        emit_edge_contig_cov(cur, con, args.gfa, sids, ord_ids, row2node, rep_at,
                             en_i, en_j, start, maxlayer, n, contig_gid, t0,
                             stream=args.ribbon_stream, precomp=edge_precomp, distill=args.distill,
                             rust_layers=args.rust_ribbon, out_db=args.out_db, birth=birth, fp=fp,
                             contig2hap=_c2h_edge)
        # 逆位も rust_ribbon 時は自前接続 → main con を閉じたまま呼ぶ(ribbon/edge と同窓)。再オープンは後。
        if args.emit_inversion and (args.gfa or args.distill):
            emit_contig_inv(cur, con, args.gfa, args.distill, sids, ord_ids, bp_row, row2node, rep_at,
                            born, b_born, d_born, start, maxlayer, n, contig_gid, _cmeta,
                            args.ref_key, t0,
                            rust_layers=args.rust_ribbon, out_db=args.out_db,
                            birth=birth, death=death, fp=fp,
                            ribbon_disk=args.ribbon_disk, ribbon_spill_dir=args.ribbon_spill_dir,
                            ref_orient_pre=ref_strand_arr)   # §7.2 統合: ref_bp の ref_strand を再利用(Pass A 省略)
        elif args.emit_inversion:
            log("emit-inversion: --gfa/--distill 未指定のためスキップ")
        # 通過多重度(node/edge)。逆位と同じく rust_ribbon 時は自前接続で main con を閉じたまま。
        if args.emit_multiplicity and (args.gfa or args.distill):
            _max_mult_build = emit_hap_mult(cur, con, args.gfa, args.distill, sids, ord_ids, row2node, rep_at,
                          born, b_born, d_born, start, maxlayer, n, contig_gid, _cmeta,
                          en_i, en_j, t0, kind=kind_np,
                          rust_layers=args.rust_ribbon, out_db=args.out_db,
                          birth=birth, death=death, fp=fp,
                          ribbon_disk=args.ribbon_disk, ribbon_spill_dir=args.ribbon_spill_dir,
                          prefed=_mult_feeder)
        elif args.emit_multiplicity:
            log("emit-multiplicity: --gfa/--distill 未指定のためスキップ")
        if args.rust_ribbon:
            con = sqlite3.connect(args.out_db); cur = con.cursor()
            con.execute("PRAGMA synchronous=OFF"); con.execute("PRAGMA journal_mode=OFF")
    elif args.emit_ribbon_contig:
        log("ribbon-contig: --gfa/--distill 未指定のためスキップ")

    # ---- 8.6 hap 絞り込み索引: nodes_rtree を hap マスク補助列つきに作り直し、edge_hm を足す ----
    #   viewer の「選択サンプル/ハプロタイプが通るノード・エッジだけ描画」モードのデータ源。
    #   密領域の遅さは R-Tree 探索(50ns/entry)ではなく候補全件の行の実体化(nodes 1.6us/行、
    #   node_contig_cov の太い blob 25us/行)なので、マスクを **細い %_rowid 影テーブル** に置いて
    #   棄却候補が太い nodes 行を読まないようにするのが要点(実測 functions/hapfilter/RESULTS.md)。
    #   実装は scripts/ggb_hapidx.py を import して --into-db 相当を呼ぶ(サイドカー版と同一コード)。
    if args.emit_hapidx:
        if not cur.execute("SELECT name FROM sqlite_master WHERE type='table' "
                           "AND name='node_contig_cov'").fetchone():
            log("hapidx: node_contig_cov が無い(--no-ribbon-contig?)のでスキップ")
        else:
            con.commit(); con.close()
            try:
                import subprocess
                # GGB_HAPIDX_BIN で差し替え可（失敗時フォールバックの検証用。既定は同ディレクトリ）
                _hx = (os.environ.get("AMIPA_HAPIDX_BIN") or os.environ.get("AMIPA_HAPIDX_BIN") or os.environ.get("GGB_HAPIDX_BIN")
                       or os.path.join(os.path.dirname(os.path.abspath(__file__)), "hap_index.py"))
                # --no-integrity-check: quick_check は **DB 全ページ読み**。この DB は今この
                # プロセスが書いたので検査は無意味な重複で、共有FS 直書き(--build-tmp 無し)だと
                # WG 273GB を cold random で読んで実質終わらない(実測 0.46MB/s)。
                _cmd = [sys.executable, _hx, "--db", args.out_db, "--into-db",
                        "--no-integrity-check",
                        "--wmax", str(args.hapidx_wmax), "--verify", "1000"]
                log("hapidx: " + " ".join(_cmd))
                _r = subprocess.run(_cmd)
                if _r.returncode != 0:
                    if _rtree_pending:
                        # §7 で rtree を飛ばしているので、ここで作らないと **nodes_rtree が空**の
                        # 使えない DB が残る。補助列なしの素の rtree を作って最低限使える状態にする。
                        log(f"ERROR: hapidx が失敗 (rc={_r.returncode})。§7 で rtree を飛ばしているため "
                            f"素の nodes_rtree をここで構築する(絞り込みは使えないが表示は可能)。")
                        _c2 = sqlite3.connect(args.out_db)
                        _c2.execute("PRAGMA synchronous=OFF"); _c2.execute("PRAGMA journal_mode=OFF")
                        _c2.execute("DROP TABLE IF EXISTS nodes_rtree")
                        _c2.execute("CREATE VIRTUAL TABLE nodes_rtree USING rtree("
                                    "rowid, min_x, max_x, min_y, max_y, min_layer, max_layer)")
                        _cur2 = _c2.cursor()
                        _B = 200_000
                        _mx = _c2.execute("SELECT MAX(rowid) FROM nodes").fetchone()[0] or 0
                        for _lo in range(1, _mx + 1, _B):
                            _cur2.executemany(
                                "INSERT INTO nodes_rtree(rowid,min_x,max_x,min_y,max_y,"
                                "min_layer,max_layer) VALUES(?,?,?,?,?,?,?)",
                                _c2.execute(
                                    "SELECT rowid, xCoord-radius, xCoord+radius, yCoord-radius, "
                                    "yCoord+radius, layer_index, layer_index FROM nodes "
                                    "WHERE rowid BETWEEN ? AND ? ORDER BY rowid",
                                    (_lo, min(_lo + _B - 1, _mx))).fetchall())
                            _c2.commit()
                        _c2.close()
                        log("素の nodes_rtree を構築した（後から "
                            f"`python3 {_hx} --db {args.out_db} --into-db` で絞り込みを足せる）")
                    else:
                        log(f"WARN: hapidx が失敗 (rc={_r.returncode})。nodes_rtree は元のまま "
                            f"= 絞り込みモードだけ使えない状態(他機能は無影響)。"
                            f"後から `python3 {_hx} --db {args.out_db} --into-db` で足せる。")
                else:
                    log(f"hapidx[done] ({time.time()-t0:.1f}s)")
            finally:
                con = sqlite3.connect(args.out_db); cur = con.cursor()
                con.execute("PRAGMA synchronous=OFF"); con.execute("PRAGMA journal_mode=OFF")

    # ---- 8.7 ノード名 trigram 索引: viewer の Find>Node の部分一致を索引で引けるようにする ----
    #   無いと `node_name LIKE '%q%'` が nodes 全走査(chr22 590MB, ネットワーク FS で cold 48.7 秒)。
    #   先頭ワイルドカードがあるので idx_nodes_node_name は原理的に使えない。詳細は ggb_nametri.py。
    #
    # ★名前は **メモリ上で生成する**（DB 読み取り 0）。名前はノード id の純関数 gname(v) なので
    #   atom_np/kind_np/id_map から作れる。初版は書き終えた DB に
    #   `SELECT DISTINCT node_name` を投げていたが、WG で計測すると被覆索引の走査が
    #   **4KB ランダム読み・実効 2.0MB/s・CPU 7%**（索引ページが表のページと交互配置のため）で、
    #   抽出だけで 40 分超の見込みだった。LOD 較正を「書き終えた DB に問い合わせ直す」のを
    #   やめた経緯(functions/reemit)と同じ落とし穴。
    #   サイズは「出現するツリーノード数」だけで決まり、**パス数には依存しない**。
    #
    #   ⚠ DISTINCT 不要: 出現ノードは 1 個につき 1 名で、葉 `n{元id}` / 内部 `{G|S|X}{v}` は
    #     接頭辞が違うため元々一意。chr22 で 5,102,778 = nodes の distinct node_name 数と一致。
    if args.emit_nametri:
        try:
            import name_index as _nt
            _NCHUNK = 1_000_000     # 名前を一度に materialize する上限（WG でもピークはこの 1 チャンク）
            # FTS5 の rebuild はページキャッシュが効く。emitter は cache_size を設定していないので
            # 既定(2MB)のままだと WG 規模(出力 8GB)でスラッシングする。この段だけ引き上げる。
            # 負値=KiB 上限の**遅延確保**なので、小さい DB(chrY: 出力 10MB / s_vmem 8G)では
            # 実際には伸びない。WG emit は s_vmem 320-384G・実測 RSS 115-181GB なので誤差。
            # WG 相当(180M 名)の合成ベンチ実測: 8GB キャッシュで nmdict 190.5s + FTS 262.9s
            # = build 453.4s、verify(k=20) +169.6s、出力 8.04GB、CPU 95%(=計算律速)。
            con.execute(f"PRAGMA cache_size = -{args.nametri_cache_mb * 1024}")

            def _name_batches():
                for _s in range(0, born.size, _NCHUNK):
                    P = born[_s:_s + _NCHUNK]
                    a = atom_np[P]
                    out = np.empty(P.size, dtype=object)
                    _lf = a >= 0
                    _la = a[_lf]
                    if id_map is not None:
                        _la = id_map[_la - 1]      # dense atom -> 元 id（表示名の復元）
                    out[_lf] = np.char.add("n", _la.astype("U"))
                    _in = ~_lf
                    if _in.any():
                        _kk = kind_np[P[_in]].astype(np.int64)
                        _ch = np.where(_kk == 1, "G", np.where(_kk == 2, "S", "X"))
                        out[_in] = np.char.add(_ch.astype("U"), P[_in].astype("U"))
                    out[P == 0] = "root"           # v==0 は atom/kind に依らず root
                    yield out.tolist()

            _n = _nt.build_from_batches(con, _name_batches())
            log(f"nametri: nmdict {_n:,} names (in-memory 生成; DB 読み取り 0) + nmfts(trigram)")
            if not _nt.verify_con(con, 20):
                log("WARN: nametri の標本検証が不一致。索引は残すが要調査。")
            log(f"nametri[done] ({time.time()-t0:.1f}s)")
        except Exception as _e:
            # 失敗しても他機能は無影響（部分一致だけ従来の全走査に落ちる）。
            log(f"WARN: nametri が失敗 ({type(_e).__name__}: {_e})。Find>Node の部分一致だけ"
                f"低速な全走査にフォールバックする(他機能は無影響)。後から "
                f"`python3 scripts/ggb_nametri.py --db {args.out_db} --into-db` で足せる。")
            try:
                con.rollback()
            except Exception:
                pass
        finally:
            # 後続段（leaf_seq 等）に大きなキャッシュ上限を残さない（既定へ戻す）。
            try:
                con.execute("PRAGMA cache_size = -2000")
            except Exception:
                pass

    # ---- 葉(base 節点)の塩基配列 leaf_seq(leaf_id, seq)。層非依存の 1葉1行。 ----
    #   ここで con は open(rust_ribbon 経路も上で再オープン済)。distill に s_seq があれば GFA 不要、
    #   無ければ --gfa 直読み(関数内でフォールバック判定)。ribbon 機構に依存しない独立走査。
    if args.emit_seq:
        emit_leaf_seq(cur, con, args.gfa, args.distill, ids, id_map, t0)

    # ---- 8.6 ハプロタイプ・リボン(全層 dense 1バイト/hap・256段階; 既定OFF, contig 索引に置換済) ----
    #   node_hap_cov(ノード被覆) + edge_hap_cov(エッジ通過ビットセット)。後者で両端被覆ヒューリスティックの
    #   偽エッジ(indel 弦/巡回/集約)を排除。edge_hap_cov は本体エッジ集合(en_i/en_j)の rowid を再現して一致。
    if args.emit_ribbon_hap and (args.gfa or args.distill):
        # 融合: node パス走査で edge 通過三つ組も同時に集め、edge_precomp として edge 側へ渡す
        #   (stream 時のみ; edge_hap_cov の GFA 再走査を省く。非stream は edge_precomp=None で自前走査)。
        hap_gid, edge_precomp = emit_ribbon_hapbytes(cur, con, args.gfa, sids, ord_ids, bp_row, row2node, rep_at,
                                                     born, b_born, d_born, start, maxlayer, n, sbp, t0,
                                                     stream=args.ribbon_stream, distill=args.distill)
        emit_edge_hap_cov(cur, con, args.gfa, sids, ord_ids, row2node, rep_at,
                          en_i, en_j, start, maxlayer, n, hap_gid, t0,
                          stream=args.ribbon_stream, precomp=edge_precomp, distill=args.distill)
    elif args.emit_ribbon_hap:
        log("ribbon-hap: --gfa/--distill 未指定のためスキップ")

    # per-layer nominal scale: 各層のグリフ数 N_L。
    layer_nodes = [int(c) for c in per[start:maxlayer + 1]]      # 書き出した層(Lw=0..out_maxlayer)
    # layer_zoom f(n): viewer の層選択閾値(バンド境界)。layer n は f(n)<=z<f(n+1) で表示(z=カメラズーム)。
    # f(0)=1(相対値; viewer が起動時 fit-to-screen ズームを乗じ絶対閾値化 f(L)=z_fit·densityKnob·layer_zoom[L])。
    # **実レイアウト座標の局所密度**から算出(N_n 冪則でなく; 理由は compute_layer_zoom の docstring)。
    _zoom_diag = None
    _zoom_method = args.zoom_method
    if args.zoom_method == "xy":
        # **DB を引かない**（既定）。§7 のノード発行が使ったのと同じメモリ上の座標配列から
        # kNN 1 回で厳密解を出す。詳細は compute_layer_zoom_xy の docstring。
        # ここは emit の最終段なので、較正の失敗で数時間の成果を落とさないよう grid 版へ落とす。
        _wk = max(1, int(os.environ.get("NSLOTS", "1")))    # qsub のスロット数を超えて並列化しない
        try:
            layer_zoom, _zoom_diag = compute_layer_zoom_xy(
                CX, CY, RAD, born, birth, death, start, maxlayer, layer_nodes,
                vb=args.zoom_budget, pct=args.zoom_percentile, samples=args.zoom_samples,
                diag_samples=args.zoom_diag_samples, d_floor=args.zoom_dfloor,
                ceil_ratio=args.zoom_ceil_ratio, log_fn=log, workers=_wk)
            _zoom_window = "square_side_W_over_s"
        except Exception as _e:
            log(f"ERROR: xy 較正が失敗 ({type(_e).__name__}: {_e}) → grid 版へフォールバック。"
                f"DB は使えるが LOD 較正は最適でない(ggb_recalib_zoom.py --method xy で後から直せる)")
            layer_zoom = compute_layer_zoom(cur, out_maxlayer, layer_nodes,
                                            vb=args.zoom_budget, pct=args.zoom_percentile,
                                            grid=args.zoom_grid, d_floor=args.zoom_dfloor,
                                            ceil_ratio=args.zoom_ceil_ratio)
            _zoom_window = "world_aspect_W_over_s"
            _zoom_method = "grid(xy失敗)"
    elif args.zoom_method == "rtree":
        layer_zoom, _zoom_diag = compute_layer_zoom_rtree(
            cur, out_maxlayer, layer_nodes, vb=args.zoom_budget, pct=args.zoom_percentile,
            samples=args.zoom_samples, d_floor=args.zoom_dfloor,
            ceil_ratio=args.zoom_ceil_ratio, log_fn=log)
        _zoom_window = "square_side_W_over_s"
    else:
        layer_zoom = compute_layer_zoom(cur, out_maxlayer, layer_nodes,
                                        vb=args.zoom_budget, pct=args.zoom_percentile,
                                        grid=args.zoom_grid, d_floor=args.zoom_dfloor,
                                        ceil_ratio=args.zoom_ceil_ratio)
        _zoom_window = "world_aspect_W_over_s"
    _sd = {"maxlayer": out_maxlayer, "layer_nodes": layer_nodes,
           "layer_zoom": layer_zoom,
           "layer_zoom_budget": args.zoom_budget,
           "layer_zoom_percentile": args.zoom_percentile,
           # 較正に使った窓の形。viewer は自分の canvas アスペクトでこれを補正する。
           #   square_side_W_over_s : 一辺 W/s の正方形（canvas 非依存。新既定）→ viewer は z=√(sw·sh)/W·f(L)
           #   world_aspect_W_over_s: (W/s, H/s)=world アスペクト（旧。実 viewport との面積比が
           #                          グラフごとに 0.96-3.55x ずれる）→ viewer は従来式 z=sw/W·f(L)
           "zoom_window": _zoom_window,
           "zoom_method": _zoom_method,
           "schedule": "budget"}   # budget 一本化(--schedule 値に依らず実際に使った値)
    if _zoom_diag is not None:
        # 層別の実分位 [p25,p50,p75,p90,p99]。「このグラフはどのくらい裾が厚い＝取得の安全弁で
        # どのくらい上位層 fallback するか」を推測でなく観測できるようにする。
        _sd["layer_zoom_diag"] = _zoom_diag
    stats_data = json.dumps(_sd)
    # stats は UPDATE でなく行の存在に依らない UPDATE→無ければ INSERT で確定する。
    # (template に stats 行が無い/複数ある場合でも layer_zoom を必ず書く。旧 UPDATE のみだと
    #  stats 行の無い template で 0 行更新となり layer_zoom 欠落=viewer 旧仕様判定を招いていた)
    cur.execute("UPDATE stats SET maxlayer=?, data=?", (out_maxlayer, stats_data))
    if cur.rowcount == 0:
        cur.execute("INSERT INTO stats(maxlayer, data) VALUES(?, ?)", (out_maxlayer, stats_data))

    # db_meta: ビルド由来(build 時刻/emitter git rev/含む機能)を DB に刻む。viewer が「今どの版の DB か」を表示する用。
    import subprocess
    # ★コンテナ内には .git が無い（git も無い）ので、イメージのビルド時に埋めた
    #   GGB_EMITTER_REV を優先する。これが無いと db_meta.emitter_rev が "unknown" になり、
    #   どの版で作った DB か後から辿れなくなる（図版の版刻印にも出る）。
    _rev = os.environ.get("AMIPA_EMITTER_REV", "") or os.environ.get("AMIPA_EMITTER_REV", "") or os.environ.get("GGB_EMITTER_REV", "").strip()
    if not _rev:
        try:
            _rev = subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(__file__)),
                                   "rev-parse", "--short", "HEAD"],
                                  capture_output=True, text=True, timeout=10).stdout.strip() or "unknown"
        except Exception:
            _rev = "unknown"
    _build_hb_covering_idx(cur, con, t0)
    _feat = [t for t in ("leaf_seq", "node_hap_mult", "node_contig_inv", "node_contig_cov")
             if cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()]
    if all(cur.execute("SELECT name FROM sqlite_master WHERE type='index' AND name=?",
                       (_ix,)).fetchone() for _ix in ("idx_ncc_hb", "idx_ecc_hb")):
        _feat.append("hb_idx")      # hb の被覆索引あり(viewer が INDEXED BY で強制する)
    if any(r[1] == "hm0" for r in cur.execute("PRAGMA table_info(nodes_rtree)")):
        _feat.append("hapidx")      # nodes_rtree に hap マスク補助列あり(絞り込み取得が使える)
    if cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='nmfts'").fetchone():
        _feat.append("nametri")     # ノード名 trigram 索引あり(Find>Node の部分一致が索引で引ける)
    if cur.execute("SELECT name FROM sqlite_master WHERE type='index' "
                   "AND name='idx_nodes_refpos'").fetchone():
        _feat.append("refpos_idx")  # 参照座標索引あり(Find>Position が索引で引ける)
    # distill サイドカーの適格判定は cur が生きているここで済ませ(グラフ照合に DB を引く)、
    # 実際の symlink は --build-tmp のコピー完了後=最終パスに対して張る(下の §末尾)。
    _distill_sc_dir = args.distill_sidecar_dir or args.distill
    _distill_sc_ok = False
    if args.emit_distill_sidecar and _distill_sc_dir:
        if not _distill_msa_ok(_distill_sc_dir):
            log("distill sidecar: skip — %s に MSA 用配列(p_tok/p_ori/p_off/p_names/id_map)が揃っていない"
                % _distill_sc_dir)
        else:
            _ok, _why = _distill_matches_db(_distill_sc_dir, cur, out_maxlayer)
            if _ok:
                _distill_sc_ok = True
                _feat.append("distill_msa")   # viewer の bubble MSA が使える(サイドカー経由で distill 直読み)
                log("distill sidecar: グラフ照合 OK (%s)" % _why)
            else:
                log("WARN: distill sidecar: skip — %s は この DB と別グラフの可能性 (%s)"
                    % (_distill_sc_dir, _why))
    # ★入力の出自を刻む。これが無かったために「既存 DB を後から再較正したいが、どの npz/typed から
    #   作られたのか DB からは辿れない」という詰みが起きた(2026-07-30)。座標や層構造をやり直す系の
    #   後付けツールは必ず入力を要るので、パスと mtime/サイズを記録する。
    _inp = {}
    for _kk, _pp in (("npz", args.npz), ("typed", args.typed), ("distill", args.distill),
                     ("gfa", args.gfa), ("tree", getattr(args, "tree", None))):
        if not _pp:
            continue
        try:
            _st = os.stat(_pp)
            _inp[_kk] = {"path": os.path.abspath(_pp), "bytes": _st.st_size,
                         "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(_st.st_mtime))}
        except OSError:
            _inp[_kk] = {"path": os.path.abspath(_pp)}
    cur.execute("CREATE TABLE IF NOT EXISTS db_meta(key TEXT PRIMARY KEY, value TEXT)")
    for _k, _v in (("built_at", time.strftime("%Y-%m-%d %H:%M:%S")),
                   ("emitter_rev", _rev),
                   ("features", ",".join(_feat)),
                   ("inputs", json.dumps(_inp, ensure_ascii=False)),
                   ("argv", " ".join(sys.argv[1:]))):
        cur.execute("INSERT OR REPLACE INTO db_meta(key,value) VALUES(?,?)", (_k, _v))

    # 起動時に viewer が全走査してイベントループを塞ぐ集計値を **ビルド時に db_meta へ**(起動負荷ゼロ化)。
    # ここは build 固有(coverage/hb/mult)。annotation 由来(max_gene_cnt 等)は ggb_annotate が annot_meta に書く。
    def _has_col(_t, _c):
        try:
            return any(r[1] == _c for r in cur.execute(f"PRAGMA table_info({_t})"))
        except Exception:
            return False
    _maxima = {}
    if _has_col("nodes", "coverage"):
        _maxima["max_coverage"] = cur.execute("SELECT MAX(coverage) FROM nodes WHERE coverage>0").fetchone()[0] or 0
    if _has_col("node_contig_cov", "hb"):
        _maxima["max_hb"] = cur.execute("SELECT MAX(hb) FROM node_contig_cov WHERE hb>0").fetchone()[0] or 0
    # max_mult(通過多重度スケール上限=格納 cn(u8)の最大)は emit_hap_mult が build 時に in-memory/Rust から
    # 返した値を使う。node_hap_mult 全走査(WG 172M 行≈7分)を build/起動の双方で回避。
    if _max_mult_build is not None:
        _maxima["max_mult"] = int(_max_mult_build)
    for _k, _v in _maxima.items():
        cur.execute("INSERT OR REPLACE INTO db_meta(key,value) VALUES(?,?)", (_k, str(int(_v))))
    if _maxima:
        log(f"  db_meta maxima(build時): {_maxima}")
    con.commit()
    log(f"  layer_zoom f(n) [method={_zoom_method} V_render={args.zoom_budget:.0f} "
        f"P{args.zoom_percentile:.0f} 窓={_zoom_window}]: "
        + " ".join(f"{v:g}" for v in layer_zoom))
    if args.zoom_method in ("xy", "rtree") and abs(args.zoom_percentile - 50.0) > 1e-9:
        log(f"  NOTE: --zoom-percentile={args.zoom_percentile:g} を明示指定しています。"
            f"中央値較正(50)がグラフ間/層間で唯一安定という実測(functions/hapfilter/LOD_REDESIGN.md)"
            f"があるので、意図が無ければ外して既定(50)にしてください。")

    # rowid 整合の最終検証(VACUUM しないので挿入順=rowid のはず)
    (mm,) = cur.execute("SELECT count(*) FROM nodes n JOIN nodes_rtree r ON n.rowid=r.rowid "
                        "WHERE n.layer_index<>r.min_layer").fetchone()
    con.close()
    # synchronous=OFF / journal_mode=OFF は build 中の速度優先設定。完成 DB は viewer が編集を
    # 書き戻す永続成果物なので、最後に明示 fsync でディスクへ確定(内容バイト不変=bit-identical維持)。
    # 以後 viewer が書く際の耐障害性は viewer 接続側 pragma が担う(非WAL journal_mode は接続毎=非永続、
    # この build の OFF は viewer に波及せず既定 DELETE で保護される)。
    try:
        _fd = os.open(args.out_db, os.O_RDWR)
        os.fsync(_fd)
        os.close(_fd)
    except OSError:
        pass
    # --build-tmp: ローカルでビルドした DB を最終 out-db へ 1 回の逐次コピーで確定(共有FSのランダム書込を回避)。
    if work_db != final_out_db:
        _sz = os.path.getsize(work_db)
        _tcp = time.time()
        log(f"copy staged DB → {final_out_db} ({_sz:,} bytes)")
        shutil.copyfile(work_db, final_out_db)
        try:
            _fd = os.open(final_out_db, os.O_RDWR)
            os.fsync(_fd)
            os.close(_fd)
        except OSError:
            pass
        os.remove(work_db)
        log(f"staged copy done ({time.time()-_tcp:.1f}s); local work DB removed")
        args.out_db = final_out_db     # 以降のログ表示用に最終パスへ
    # distill サイドカー: 最終パス(--build-tmp のコピー先)に対して張る。適格判定は §db_meta で済み。
    if _distill_sc_ok:
        _write_distill_sidecar(final_out_db, _distill_sc_dir, log)
    log(f"[done] nodes={n_written:,} edges={e_total:,} maxlayer={out_maxlayer} "
        f"rowid-misaligned={mm} {time.time()-t0:.1f}s -> {args.out_db}")
    if mm:
        log("ERROR: nodes.rowid != nodes_rtree.rowid; backend join will break")
        sys.exit(1)


if __name__ == "__main__":
    main()
