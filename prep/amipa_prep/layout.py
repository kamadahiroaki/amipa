#!/usr/bin/env python3
"""素の SGD レイアウト（ベースライン）。
パス不使用・multi-level不使用・ref アンカー不使用。グラフ距離のみで 2D ストレス最小化。

大規模グラフ標準の **ピボット型スパース・ストレス**（s_gd2 / Ortmann 2017 と同方式）を SGD で解く:
  - k 個のピボットを maxmin(farthest-point) で選ぶ
  - 各ピボットから BFS で全ノード距離 D[k,n]
  - 項 = (a) 全エッジ exact(理想距離1)  (b) 各ピボット p × 全ノード i(理想 D[p,i], 重み 1/d^2)
  - SGD: eta を指数アニール、(b) はピボット単位のブロック更新、(a) はエッジ Jacobi 更新

GFA の S/L のみ使用（P/W は読まない＝パス不使用）。無向扱い。
"""
import argparse, time, sys, os
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import shortest_path, connected_components

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bubbletools"))
from components import classify_labels

# (C) 単一連結成分の O(k·n) pivot ループを numba で並列化(あれば)。無ければ numpy(B) に自動フォールバック。
try:
    import numba
    from numba import njit, prange
    HAVE_NUMBA = True
except Exception:
    HAVE_NUMBA = False

if HAVE_NUMBA:
    @njit(parallel=True, fastmath=False, cache=True)
    def _pivot_epoch_numba(X, piv_order, piv, Dc, eta):
        """1 epoch 分の pivot ブロック更新を実行。
        外側 pivot ループは逐次(=numpy 版と同じ Gauss-Seidel 対称破れを保持)、
        内側ノードループは prange 並列。pivot は各 step の先頭でスナップショットして固定
        → ノード更新は互いに独立で race-free(各 X[i] を1スレッドだけが書く)。
        演算式は numpy(B) 版と同一(丸めは float64 で行うため bit ではなく数値等価)。"""
        n = X.shape[0]
        for t in range(piv_order.shape[0]):        # 逐次: pivot 順(GS)
            pi = piv_order[t]
            p = piv[pi]
            px = X[p, 0]; py = X[p, 1]             # pivot 固定(このstep中は動かさない)
            for i in prange(n):                    # 並列: ノードは独立
                dx = X[i, 0] - px
                dy = X[i, 1] - py
                mag = np.sqrt(dx * dx + dy * dy) + 1e-9
                d = Dc[pi, i]
                mu = eta * (1.0 / (d * d))
                if mu > 1.0:
                    mu = 1.0
                r = (mag - d) * 0.5 / mag * mu
                X[i, 0] -= r * dx
                X[i, 1] -= r * dy

    @njit(cache=True)
    def _bfs_csr(indptr, indices, src, n):
        """CSR 無向グラフの単一始点 BFS。unweighted 最短ホップ数を int で返す。
        非並列 njit なので `cache=True` がプロセス跨ぎで効く(初回~0.6s, 以降キャッシュ)。
        戻り値は scipy shortest_path(unweighted) と数値完全一致(距離は整数ホップ)、
        到達不能は -1(呼び側で最大有限値に埋める=現行 isinf 埋めと同義)。"""
        dist = np.full(n, -1, np.int32)
        q = np.empty(n, np.int32)
        dist[src] = 0; q[0] = src; head = 0; tail = 1
        while head < tail:
            u = q[head]; head += 1
            du = dist[u] + 1
            for p in range(indptr[u], indptr[u + 1]):
                v = indices[p]
                if dist[v] < 0:
                    dist[v] = du; q[tail] = v; tail += 1
        return dist

    # ---- 球 pivot(§2.11.2-3): 近傍 K ノードだけを持つ局所 pivot -------------------------
    @njit(cache=True)
    def _bfs_ball(indptr, indices, src, K, order, dist, seen, stamp):
        """**ノード数 K で打ち切る** BFS(= src に最も近い K ノード)。BFS は距離順に訪問するので
        K 個出た時点で止めればよい。半径 R での打ち切りは不可(疎な背骨 2 ノード/hop と密領域
        最大 17,038 ノード/hop が混在するグラフでは、共通 R だと密領域の球だけ数百万に膨れる)。
        seen/stamp は使い回しの訪問マーク(毎回 O(n) クリアを避ける世代スタンプ)。"""
        order[0] = src; dist[0] = 0; seen[src] = stamp
        cnt = 1; head = 0
        while head < cnt and cnt < K:
            u = order[head]; du = dist[head]; head += 1
            for p in range(indptr[u], indptr[u + 1]):
                v = indices[p]
                if seen[v] != stamp:
                    seen[v] = stamp; order[cnt] = v; dist[cnt] = du + 1; cnt += 1
                    if cnt >= K:
                        break
        return cnt

    @njit(cache=True)
    def _bfs_radius_count(indptr, indices, src, R, cap, order, dist, seen, stamp):
        """半径 R hop 以内のノード数(cap 打ち切り)。球サイズ K の自動導出に使う。"""
        order[0] = src; dist[0] = 0; seen[src] = stamp
        cnt = 1; head = 0
        while head < cnt and cnt < cap:
            u = order[head]; du = dist[head]; head += 1
            if du >= R:
                continue
            for p in range(indptr[u], indptr[u + 1]):
                v = indices[p]
                if seen[v] != stamp:
                    seen[v] = stamp; order[cnt] = v; dist[cnt] = du + 1; cnt += 1
                    if cnt >= cap:
                        break
        return cnt

    @njit(parallel=True, fastmath=False, cache=True)
    def _ball_epoch_numba(X, order, bstart, bidx, bdist, bsrc, bmax, tau, eta):
        """球 pivot 1 epoch。各球の内部ノードだけ更新(球内でノードは一意なので race-free)。
        更新式は _pivot_epoch_numba と同一。**境界テーパー**: 球の内外で拘束が不連続だと境界が
        リング状の切れ目になり階段状の歪みが出るので、外縁 tau の割合で重みを 1→0 に落とす。"""
        for t in range(order.shape[0]):
            b = order[t]
            p = bsrc[b]
            px = X[p, 0]; py = X[p, 1]
            s = bstart[b]; e = bstart[b + 1]
            dm = np.float64(bmax[b])
            inner = dm * (1.0 - tau)
            span = dm - inner
            for j in prange(s, e):
                i = bidx[j]
                d = bdist[j]
                if d < 1:
                    continue
                dd = np.float64(d)
                w = 1.0
                if tau > 0.0 and dd > inner:
                    w = (dm - dd) / (span + 1e-12)
                    if w <= 0.0:
                        continue
                dx = X[i, 0] - px
                dy = X[i, 1] - py
                mag = np.sqrt(dx * dx + dy * dy) + 1e-9
                mu = eta * (1.0 / (dd * dd))
                if mu > 1.0:
                    mu = 1.0
                r = (mag - dd) * 0.5 / mag * mu * w
                X[i, 0] -= r * dx
                X[i, 1] -= r * dy

def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)

def parse_gfa(path):
    """S/L のみ。L 行の向きも取得して各エッジ端の side(0=5'/1=3') を返す。
    GFA `L a oa b ob`: a の exit-side su=(oa=='+'?1:0)、b の enter-side sv=(ob=='+'?0:1)
    （build_layered_db.py の構造由来 side 規約に一致）。レイアウト自体は無向で使う。"""
    ids = []; idx = {}; EA = []; EB = []; OA = []; OB = []
    with open(path) as f:
        for ln in f:
            t = ln[0]
            if t == 'S':
                p = ln.split('\t', 2)
                nid = int(p[1]); idx[nid] = len(ids); ids.append(nid)
            elif t == 'L':
                p = ln.split('\t')
                EA.append(int(p[1])); OA.append(p[2])
                EB.append(int(p[3])); OB.append(p[4])
    n = len(ids)
    ei = np.fromiter((idx[a] for a in EA), np.int64, len(EA))
    ej = np.fromiter((idx[b] for b in EB), np.int64, len(EB))
    su = np.fromiter((1 if o == '+' else 0 for o in OA), np.int8, len(OA))  # a の exit-side
    sv = np.fromiter((0 if o == '+' else 1 for o in OB), np.int8, len(OB))  # b の enter-side
    return np.array(ids), n, ei, ej, su, sv


def parse_distill(pfx):
    """distill 中間(distill_gfa.py)から parse_gfa と同一タプルを復元。
    GFA text parse を配列ロードに置換するだけで下流計算は不変 → npz は bit-identical。
    dtype も parse_gfa に厳密一致(ids/ei/ej=int64, su/sv=int8)させる。"""
    j = pfx  # ディレクトリ prefix
    ids = np.load(f"{j}/s_id.npy").astype(np.int64)      # dense node id, S file order
    n = ids.size
    la = np.load(f"{j}/l_a.npy"); lb = np.load(f"{j}/l_b.npy")   # dense, L file order
    loa = np.load(f"{j}/l_oa.npy"); lob = np.load(f"{j}/l_ob.npy")
    # dense id は 1..M 連番 → id2row 直接配列(dict 不要)。ids は file order なので row は enumerate。
    M = int(ids.max()) if n else 0
    id2row = np.empty(M + 1, np.int64)
    id2row[ids] = np.arange(n, dtype=np.int64)
    ei = id2row[la]; ej = id2row[lb]                     # parse_gfa の idx[·] と同値
    su = loa.astype(np.int8)                             # 1 if '+' else 0  (== parse_gfa su)
    sv = (1 - lob).astype(np.int8)                       # 0 if '+' else 1  (== parse_gfa sv)
    return ids, n, ei, ej, su, sv

if HAVE_NUMBA:
    @njit(parallel=True, cache=True)
    def _repel_forces(xy, ip, ind, ustart, ucell, order, r, cap, fx, fy, fn, BIG, gx, gy):
        """格子で近傍だけ見る斥力（非隣接ノード対のみ）。**SGD の各 epoch 内で呼ぶ**のが要点。
        後処理として最後に掛けると大域配置が既に固まっていて動けず、鎖が蛇行するだけになる
        （実測: 折れ角 138.5°→129.7° と悪化）。epoch 内なら pivot 項と同時に釣り合う。

        ★この項が無いと本番エンジンは**2 アレルバブルの 2 本を完全に同一座標へ置く**
          （実測: 2D 分離 0.00・重なり 100%・グリフ重なり 62.4%）。emitter 側の
          separate_collapsed_alleles が必要だったのはこれが原因。斥力を入れると
          重なりは 10.9% まで落ち、分離処理は不要になる（2026-08-04）。
        """
        n = xy.shape[0]; r2 = r * r
        for i in prange(n):
            xi = xy[i, 0]; yi = xy[i, 1]; fxi = 0.0; fyi = 0.0; cnt = 0
            for dx in range(-1, 2):
                for dy in range(-1, 2):
                    key = (gx[i] + dx) * BIG + (gy[i] + dy)
                    lo = 0; hi = ucell.size
                    while lo < hi:
                        mid = (lo + hi) >> 1
                        if ucell[mid] < key: lo = mid + 1
                        else: hi = mid
                    if lo >= ucell.size or ucell[lo] != key: continue
                    st = ustart[lo]; en = ustart[lo + 1]; m = en - st
                    step = 1 if m <= cap else m // cap + 1   # 密セルは間引く（重みで補正）
                    cw = float(step)
                    for t in range(st, en, step):
                        j = order[t]
                        if j == i: continue
                        ddx = xi - xy[j, 0]; ddy = yi - xy[j, 1]
                        d2 = ddx * ddx + ddy * ddy
                        if d2 >= r2: continue
                        adj = False
                        for p in range(ip[i], ip[i + 1]):
                            if ind[p] == j: adj = True; break
                        if adj: continue                     # 隣接はエッジ項に任せる
                        d = np.sqrt(d2)
                        if d < 1e-9:
                            # ★完全に同一座標だと方向が 0 で、w が幾ら大きくても力が 0 になる。
                            #   バブルの 2 アレルは全 pivot への距離が厳密に同一（グラフ的に
                            #   対称）なので pmds 初期化で同座標に置かれ、pivot/エッジ/短距離の
                            #   どの項も対称ゆえ永久に分離しなかった（実測: 2D 分離 0.00・
                            #   重なり 100%）。emitter の separate_collapsed_alleles が
                            #   必要だった真の原因はこれ。対を無順序でハッシュして角度を決め、
                            #   i<j で符号を反転させる（反対称なので必ず離れる方向に動く）。
                            lo_ = i if i < j else j
                            hi_ = j if i < j else i
                            ang = ((lo_ * 2654435761 + hi_ * 40503) % 6283) * 0.001
                            sg = 1.0 if i < j else -1.0
                            ddx = sg * 1e-6 * np.cos(ang); ddy = sg * 1e-6 * np.sin(ang)
                            d = 1e-6
                        else:
                            d = d + 1e-12
                        w = (r - d) / d
                        fxi += ddx * w * cw; fyi += ddy * w * cw; cnt += 1
            fx[i] = fxi; fy[i] = fyi; fn[i] = cnt

    @njit(cache=True)
    def _short_bfs(indptr, indices, n, H, cap, mode, off, oi, oj, od):
        """全ノードから深さ H までの有界 BFS で hop 2..H の対 (i<j, d) を作る。

        ★これは**応力の項集合に欠けていた項**（2026-08-04 実測で判明）。
        従来の項は (a) 全エッジ(hop1) / (b) global pivot 対 / (c) 球 pivot-メンバ対 だけで、
        **hop 2 が丸ごと抜けていた**。バブル a→(B|C)→z の「アレル対 (B,C)」と
        「弦 (a,z)」はどちらも hop 2 なのに、B/C/a/z が pivot や球中心に選ばれる確率は
        chr22 で 2% しかなく、96% のバブルで**分離する力も弦長を決める力も存在しなかった**。
        pivot ベースでなく全ノードから列挙するので、アレル対も弦も必ず入る。

        mode=0: 個数を数えて off[u] に入れるだけ / mode=1: off を先頭位置として書き込む。
        ★2 パスにするのは WG のため。1 パス版は est = n*cap を先に確保していたので
          WG(110M ノード, cap=64)で 63GB を要求して確実に落ちる。実際の対は
          chr22 で 1 ノードあたり 4.2 個（15.77M / 3.76M）しかなく、数えてから確保すれば
          O(実際の対数) で足りる。BFS を 2 回回す分だけ遅くなる（chr22 で +50s）。
        """
        order = np.empty(cap + 8, np.int32); dist = np.empty(cap + 8, np.int32)
        seen = np.full(n, -1, np.int32)
        for u in range(n):
            order[0] = u; dist[0] = 0; seen[u] = u
            cnt = 1; head = 0
            while head < cnt and cnt < cap:
                v = order[head]; dv = dist[head]; head += 1
                if dv >= H: continue
                for p in range(indptr[v], indptr[v + 1]):
                    w = indices[p]
                    if seen[w] != u:
                        seen[w] = u; order[cnt] = w; dist[cnt] = dv + 1; cnt += 1
                        if cnt >= cap: break
            if mode == 0:
                c = 0
                for t in range(1, cnt):
                    if order[t] > u and dist[t] >= 2: c += 1
                off[u] = c
            else:
                m = off[u]
                for t in range(1, cnt):
                    if order[t] > u and dist[t] >= 2:
                        oi[m] = u; oj[m] = order[t]; od[m] = dist[t]; m += 1


def build_short(A, n, H, cap, log_prefix=""):
    """hop 2..H の対を作り (I, J, D, cnt) を返す。numba が無ければ None（項なし）。"""
    if not HAVE_NUMBA or H < 2:
        return None
    ip = np.ascontiguousarray(A.indptr, np.int64)
    ind = np.ascontiguousarray(A.indices, np.int64)
    e0 = np.empty(0, np.int32); e1 = np.empty(0, np.uint8)
    cnts = np.zeros(n + 1, np.int64)
    _short_bfs(ip, ind, n, H, cap, 0, cnts, e0, e0, e1)   # 1 パス目: 数える
    tot = int(cnts[:n].sum())
    if tot == 0:
        return None
    starts = np.zeros(n + 1, np.int64)                    # 重なる view への cumsum は不可
    np.cumsum(cnts[:n], out=starts[1:])
    oi = np.empty(tot, np.int32); oj = np.empty(tot, np.int32); od = np.empty(tot, np.uint8)
    _short_bfs(ip, ind, n, H, cap, 1, starts, oi, oj, od)  # 2 パス目: 書く(starts は不変)
    I = oi.astype(np.int64); J = oj.astype(np.int64); Dd = od.astype(np.float64)
    cnt = np.maximum(np.bincount(I, None, n) + np.bincount(J, None, n), 1.0)
    log(f"{log_prefix}短距離項: hop2..{H} の対 {tot:,} "
        f"({(I.nbytes + J.nbytes + Dd.nbytes) / 2**30:.3f}GiB)")
    return I, J, Dd, cnt


def build_csr(n, ei, ej):
    # ノード index < 2^31 なので int32 で持つ(concat 一時と CSR indices を半減)。
    I = np.concatenate([ei, ej]).astype(np.int32, copy=False)
    J = np.concatenate([ej, ei]).astype(np.int32, copy=False)
    return csr_matrix((np.ones(len(I), np.float32), (I, J)), shape=(n, n))

def maxmin_pivots(A, k, seed=0, engine="numpy"):
    """farthest-point sampling。各ピボットから BFS した距離も返す（D[k,n]）。
    maxmin の逐次依存(pivot t+1 = 実行中最小距離の argmax)は残るのでピボット間並列は不可。
    効くのは 1 本の BFS を速くすること: engine=numba なら scipy heap-Dijkstra(O((n+e)log n))を
    numba キュー BFS(O(n+e))に置換(chr22 巨大成分で 800ms→100ms=8×, chrY 5×)。距離 D はビット一致。"""
    n = A.shape[0]
    rng = np.random.default_rng(seed)
    use_numba = (engine == "numba") and HAVE_NUMBA
    if use_numba:
        indptr, indices = A.indptr, A.indices
        def bfs(src):
            d = _bfs_csr(indptr, indices, np.int32(src), n).astype(np.float32)
            neg = d < 0
            if neg.any():
                d[neg] = d[~neg].max()   # 到達不能を最大有限で埋める(現行 isinf 埋めと同義)
            return d
    else:
        def bfs(src):
            d = shortest_path(A, unweighted=True, indices=src)
            d[np.isinf(d)] = d[~np.isinf(d)].max()
            return d
    piv = [int(rng.integers(n))]
    D = np.empty((k, n), np.float32)
    D[0] = bfs(piv[0])
    mind = D[0].copy()
    for t in range(1, k):
        nxt = int(np.argmax(mind))
        piv.append(nxt)
        D[t] = bfs(nxt)
        mind = np.minimum(mind, D[t])
        if t % 25 == 0:
            log(f"  pivot {t}/{k} maxmin-remaining={mind.max():.0f}")
    return np.array(piv), D

def pivot_cap(n, mem_gib, floor=32):
    """メモリ予算 mem_gib から global pivot 数の上限を返す。

    ■ なぜ必要か（2026-08-06 ユーザ指示）
    pivots の最適値は**サイズから決められない**（chrY と chr1 で傾向が逆転し、最適点の
    K も K/n も揃わない。§6.11）。品質で決められない以上、**費用で縛る**のが正しい。
    これまで扱ったグラフは染色体ごとに成分が分かれているので既定 400 で問題ないが、
    最大成分が大きいグラフが来たときに ② の消費を超えないようにする。

    ■ モデル（chr22/chr1 の MaxRSS 実測から）
        MaxRSS ≈ max( B0·n,  B1 + C·k·n )
        C  = 11.7 バイト/(pivot·ノード)  … chr22 の高 k 側 400→800→1600 で傾き一定
             (= float64 の D[k,n] 約 1.46 個分。pmds の一時コピー込み)
        B0 = k 非依存のピーク。chr22 2.56 KB/ノード / chr1 1.77 KB/ノード
    D 支配側で解いて  k_max = (M - B0·n) / (C·n)。
    C=12(切り上げ), B0=2600(実測 2 グラフの大きい方) と保守側に取る。

    ■ 外挿は信用しない
    今日この外挿を 2 回外している（短距離項の WG メモリ / 段階 pivot の優位性）。
    そのため上限は保守側で、**縛られたら必ず WARN を出す**（build_balls と同じ方針）。
    floor 未満しか置けない場合は「pivots を減らす」ではなく **グラフを成分に分ける**
    のが正しい対処なので、その旨も出す（稀エッジ 1 本で全染色体が連結したグラフでは
    chrY が chr22 に 58.8% 食い込むことを実測済み。§6.14）。
    """
    B0 = 2600.0      # bytes/node, k 非依存のピーク（保守側）
    C = 12.0         # bytes/(pivot*node)
    avail = mem_gib * (2 ** 30) - B0 * n
    if avail <= 0:
        return 0
    return max(0, int(avail / (C * n)))


def build_balls(A, n, D, coverage=170.0, rfrac=3.0, coveff=42.0, min_nodes=20000,
                kpct=10.0, seed=0, log_prefix="", mem_gib=8.0):
    """**球 pivot** を作る。パラメータはグラフから自動導出する(手調整値の過学習を避ける)。

    導出規則(すべて測定量から。chr22/chrY/chr1 で検証済み):
      R_g   = global pivot の被覆半径 = max_v min_p d(p,v) = D.min(0).max()
              (どのノードも最寄り pivot から R_g hop 以内 = global が解像できる下限スケール)
      K     = |半径 R_g/rfrac の球| の **低パーセンタイル(kpct, 既定 p10)**(64 点をサンプルして実測)
              → 球は「global が解像できない細かいスケール」をちょうど埋める。
              **中央値ではなく低パーセンタイルを使うこと**: 密領域が支配的なグラフ(chr1 は
              ノードの 45%+ がサテライト)では中央値が密領域側に落ち、K が桁で暴れる
              (chr1 実測 中央値 575,351 vs p10 12,566 = 46×)。K は球の上限サイズなので
              **疎な背骨側で半径 R_g/rfrac に届くサイズ**に合わせるのが設計意図に忠実。
              密領域では K で頭打ちになり自動的に小さい hop 半径になる(= 適応解像度)。
              p10 なら K/n が chrY 0.0020 / chr22 0.0012 / chr1 0.0011 とほぼ一定。
      NLOCAL= coverage × n / K   (coverage = 1 ノードあたりの球被覆数の目標)
      sub   = coverage / coveff  (1 epoch あたりの実効被覆を coveff に保つ間引き率)
    chr22 での検算: R_g=3,892 → K=8,461 → NLOCAL=75,324 → 手調整(32,000×20,000)と総コスト一致。
    K は chrY 384 / chr22 8,461 / chr1 と 1 桁以上変わるが NLOCAL はほぼ一定になる(K∝n のため)。

    返り値 (bstart, bidx, bdist, bsrc, bmax, sub) または None(球を使わない場合)。
    """
    if coverage <= 0 or not HAVE_NUMBA or n < min_nodes:
        return None
    indptr, indices = A.indptr, A.indices
    R_g = float(D.min(axis=0).max())
    R_ball = max(1.0, R_g / max(rfrac, 1e-9))
    cap = max(1000, n // 8)
    order = np.empty(n, np.int32); dist = np.empty(n, np.int32)
    seen = np.full(n, -1, np.int32)
    rng = np.random.default_rng(seed)
    probes = rng.choice(n, size=min(64, n), replace=False)
    cnts = np.array([_bfs_radius_count(indptr, indices, np.int32(s), R_ball, cap,
                                       order, dist, seen, 1_000_000 + i)
                     for i, s in enumerate(probes)])
    K = int(np.clip(np.percentile(cnts, kpct), 200, max(500, n // 8)))
    # 球の個数は**メモリからのみ**縛る。nloc×K = coverage×n なので所要メモリは coverage だけで
    # 決まり、個数そのものの絶対上限(旧: 200,000)はメモリ削減にほぼ寄与しない一方で、
    # **指定した coverage を黙って下回らせていた**(chr22 pivots=400 で 170→112, 800 で 170→57。
    # 同時に交差 202M→281M/295M、グリフ重なり 32.7%→41.5%/46.2% と悪化)。
    want = int(round(coverage * n / K))
    ncap = max(500, int(mem_gib * (2 ** 30) / max(K * 6, 1)))
    nloc = int(np.clip(want, 500, ncap))
    sub = max(1, int(round(coverage / max(coveff, 1e-9))))
    log(f"{log_prefix}ball: R_g={R_g:,.0f} → R_ball={R_ball:,.0f}hop → K={K:,} (p{kpct:g}; "
        f"med={int(np.median(cnts)):,} p90={int(np.percentile(cnts,90)):,}) "
        f"nballs={nloc:,} sub=1/{sub} mem={nloc*K*6/2**30:.2f}GiB "
        f"実効coverage={coverage*min(nloc,n)/max(want,1):.0f}")
    if nloc < want:
        log(f"{log_prefix}WARN: 球の個数がメモリ上限({mem_gib:g}GiB)で {want:,}→{nloc:,} に制限された。"
            f"実効 coverage = {coverage*nloc/max(want,1):.0f} < 指定 {coverage:g}")
    lp = rng.choice(n, size=min(nloc, n), replace=False).astype(np.int32)
    idxs = []; dsts = []
    for si, s in enumerate(lp):
        c = _bfs_ball(indptr, indices, np.int32(s), K, order, dist, seen, si)
        idxs.append(order[:c].copy()); dsts.append(dist[:c].astype(np.uint16))
    bstart = np.concatenate([[0], np.cumsum([a.size for a in idxs])]).astype(np.int64)
    bmax = np.array([float(a.max()) if a.size else 1.0 for a in dsts], np.float64)
    return (bstart, np.concatenate(idxs), np.concatenate(dsts), lp, bmax, sub)


def sgd_layout(n, ei, ej, piv, D, epochs=30, seed=1, eta_min=0.1, engine="numpy",
               x_init=None, eta_max=None, ball=None, ball_tau=0.3, short=None,
               repel=3.0, repel_strength=0.15, repel_anneal=1.0, repel_cap=64, A=None):
    rng = np.random.default_rng(seed)
    use_numba = (engine == "numba") and HAVE_NUMBA
    piv64 = np.ascontiguousarray(piv, np.int64)
    dmax = float(D.max())
    if x_init is None:
        X = rng.standard_normal((n, 2)).astype(np.float64) * dmax  # spread init to graph scale
    else:
        # トポロジ的初期化(例: PivotMDS)から精緻化。random init の畳み込み局所解を回避。
        X = np.ascontiguousarray(x_init, np.float64).copy()
    k = len(piv)
    if eta_max is None:
        eta_max = dmax * dmax  # 1/min_w, min_w = 1/dmax^2
    schedule = eta_max * (eta_min / eta_max) ** (np.arange(epochs) / max(epochs - 1, 1))
    # 冗長な Dc=D.copy() と W[k,n] を廃止しメモリを 1/3 に(3×4kn → 4kn)。
    # D をその場で下限クランプして Dc として使い、重み 1/(d*d) は pivot ループ内で都度計算する
    # (演算順序も同じで数値は旧 W[pi] と bit-identical)。D は dmax 算出後は他で使わないので破壊可。
    np.maximum(D, 1.0, out=D)   # 旧 Dc[Dc<1]=1.0 と同義(dmax は max なので不変)
    Dc = D                      # コピーせずエイリアス
    # node degree for edge-term averaging (avoid np.add.at sum overshoot)
    deg = np.bincount(np.concatenate([ei, ej]), minlength=n).astype(np.float64)
    deg[deg < 1] = 1.0
    # (B) pivot ループの一時配列を事前確保して毎反復の new を除去(k×epochs 回の確保 churn を消す)。
    #     演算順・dtype は旧実装に厳密一致させ bit-identical(mu は旧 value-based casting どおり f32)。
    #     ※ edge 項は vec/mag を [E,2] に再代入するので pivot 用は別名(pvec 等)にして衝突回避。
    pvec = np.empty((n, 2))           # X - X[p]        (旧: 毎回 new [n,2])
    pmag = np.empty(n)                # |vec|+1e-9
    pr   = np.empty(n)                # 係数
    pmu  = np.empty(n, np.float32)    # min(eta/(d*d),1) ← 旧も f32(python 1.0/f32・f64scalar×f32)
    # 一様斥力の作業配列（epoch ごとに確保し直さない）。隣接判定に CSR が必要。
    use_repel = (repel > 0) and use_numba and (A is not None)
    if use_repel:
        rip = np.ascontiguousarray(A.indptr, np.int64)
        rind = np.ascontiguousarray(A.indices, np.int64)
        rfx = np.zeros(n); rfy = np.zeros(n); rfn = np.zeros(n, np.int64)
    for ep in range(epochs):
        eta = schedule[ep]
        # ---- (b) pivot block updates: pivot FIXED, each node = independent 1-term
        #          majorization → unconditionally stable ----
        piv_order = rng.permutation(k)               # GS 用 pivot 順(両エンジンで同一に消費)
        if use_numba:
            _pivot_epoch_numba(X, piv_order, piv64, Dc, float(eta))   # 数値等価・prange 並列
        else:
          for pi in piv_order:
            p = piv[pi]
            d = Dc[pi]
            np.subtract(X, X[p], out=pvec)               # vec = X - X[p]  # noqa: E128
            np.einsum('ij,ij->i', pvec, pvec, out=pmag)  # (vec*vec).sum(1)  (2幅内和は同順=bit一致)
            np.sqrt(pmag, out=pmag); pmag += 1e-9
            np.multiply(d, d, out=pmu)                   # d*d (旧同様 f32)
            np.reciprocal(pmu, out=pmu); pmu *= eta      # eta*(1/(d*d))  (f32, 可換で bit一致)
            np.minimum(pmu, 1.0, out=pmu)
            np.subtract(pmag, d, out=pr); pr *= 0.5; pr /= pmag; pr *= pmu  # (mag-d)*0.5/mag*mu
            pvec *= pr[:, None]; X -= pvec                # X -= r*vec (only nodes move; pivot fixed)
        # ---- (a) edge exact terms (ideal=1) averaged by degree (stable Jacobi) ----
        mu_e = min(eta * 1.0, 1.0)
        vec = X[ej] - X[ei]
        mag = np.sqrt((vec * vec).sum(1)) + 1e-9
        disp = ((mag - 1.0) * 0.5 / mag * mu_e)[:, None] * vec
        # 遅い np.add.at を bincount に置換(同じ集計・数値等価, スキャッタが桁違いに速い)。
        fx = np.empty((n, 2))
        fx[:, 0] = np.bincount(ei, disp[:, 0], n) - np.bincount(ej, disp[:, 0], n)
        fx[:, 1] = np.bincount(ei, disp[:, 1], n) - np.bincount(ej, disp[:, 1], n)
        X += fx / deg[:, None]                   # average over incident edges
        # ---- (a') 短距離項 hop 2..H。更新式と重み mu=min(eta/d^2,1) は pivot 項と同一 ----
        #      アレル対 (B,C) と弦 (a,z) はどちらも hop 2 で、ここでしか拘束されない。
        if short is not None:
            SHI, SHJ, SHD, SHC = short
            # ★対を CHUNK ずつ処理して一時配列を有界にする。一括だと v2/d2s などが
            #   対数の ~5 倍立ち、chr22 の段階対 coverage20(5.3 億対)で 35GB 級になって
            #   メモリ優位が消える。gx に足し込んでから 1 回適用するので、
            #   一括版と**同じ Jacobi 更新**（意味は変わらない）。
            gx = np.zeros((n, 2))
            CH = 33_554_432
            for c0 in range(0, SHI.size, CH):
                c1 = min(c0 + CH, SHI.size)
                si = SHI[c0:c1]; sj = SHJ[c0:c1]; sd = SHD[c0:c1]
                v2 = X[sj] - X[si]
                m2r = np.sqrt((v2 * v2).sum(1))
                # 同一座標の対は v2=0 で変位も 0 になり、この項でも分離できない。
                # バブルの 2 アレルはグラフ的に完全対称なので pmds 初期化で同座標に置かれ、
                # 対称な力（pivot/エッジ/短距離）はどれも 2 本を区別できない。斥力側と同じ
                # 手当て（対のハッシュから角度。更新式が反対称なので必ず離れる方向に動く）。
                dgn = m2r < 1e-9
                if dgn.any():
                    ang = ((si[dgn] * 2654435761 + sj[dgn] * 40503) % 6283) * 0.001
                    v2[dgn, 0] = 1e-6 * np.cos(ang); v2[dgn, 1] = 1e-6 * np.sin(ang)
                    m2r[dgn] = 1e-6
                m2 = m2r + 1e-9
                mu2 = np.minimum(eta / (sd * sd), 1.0)
                d2s = ((m2 - sd) * 0.5 / m2 * mu2)[:, None] * v2
                gx[:, 0] += np.bincount(si, d2s[:, 0], n) - np.bincount(sj, d2s[:, 0], n)
                gx[:, 1] += np.bincount(si, d2s[:, 1], n) - np.bincount(sj, d2s[:, 1], n)
            X += gx / SHC[:, None]
        # ---- (b') 球 pivot(局所)。毎 epoch 1/sub だけサンプルする(SGD は元々確率的で、
        #      全球を毎回使う必要はない。1/4 で ~2.7× 速く、局所エッジはむしろ改善)。
        #      ★エッジ+短距離の**後**に掛ける。前に掛けると可読領域の交差が悪化する
        #      (2026-08-04 実測 2seed: 前=111/116/124 → 後=94/88。グリフ重なり/TV/アレル
        #       重なりは不変なので代償なし。seed ばらつきは 13 なので有意)。
        if ball is not None:
            bstart, bidx, bdist, bsrc, bmax, bsub = ball
            nb = bsrc.size
            sel = rng.permutation(nb)[:max(1, nb // bsub)]
            _ball_epoch_numba(X, sel, bstart, bidx, bdist, bsrc, bmax, float(ball_tau), float(eta))
        # ---- (c) 一様斥力。**epoch 内**で pivot/エッジ項と同時に釣り合わせる ----
        if use_repel:
            elc = np.hypot(X[ei, 0] - X[ej, 0], X[ei, 1] - X[ej, 1])
            L0c = float(np.median(elc[elc > 0])) if (elc > 0).any() else 1.0
            rr = repel * L0c
            gxr = np.floor(X[:, 0] / rr).astype(np.int64)
            gyr = np.floor(X[:, 1] / rr).astype(np.int64)
            BIGr = np.int64(1 << 32); cidr = gxr * BIGr + gyr
            oc = np.argsort(cidr, kind="stable"); csr_ = cidr[oc]
            ucr, us0 = np.unique(csr_, return_index=True)
            usr = np.r_[us0, csr_.size].astype(np.int64)
            _repel_forces(np.ascontiguousarray(X), rip, rind, usr, ucr,
                          oc.astype(np.int64), rr, repel_cap, rfx, rfy, rfn, BIGr, gxr, gyr)
            fr = 1.0 - ep / max(epochs - 1, 1)
            st_ = repel_strength * (fr ** repel_anneal if repel_anneal > 0 else 1.0)
            rdx = st_ * rfx; rdy = st_ * rfy
            cl = (0.2 + 1.8 * fr) * L0c if repel_anneal > 0 else 1.0 * L0c
            nr = np.hypot(rdx, rdy); bg = nr > cl
            rdx[bg] *= cl / nr[bg]; rdy[bg] *= cl / nr[bg]
            X[:, 0] += rdx; X[:, 1] += rdy
        if ep % 5 == 0 or ep == epochs - 1:
            s = stress_sample(X, piv, Dc, rng)
            log(f"  epoch {ep+1}/{epochs} eta={eta:.3g} stress~{s:.4g}")
    return X

def stress_sample(X, piv, Dc, rng, m=20000):
    k, n = Dc.shape
    pi = rng.integers(k, size=m); j = rng.integers(n, size=m)
    d = Dc[pi, j]
    dd = np.sqrt(((X[piv[pi]] - X[j]) ** 2).sum(1)) + 1e-9
    w = 1.0 / (d * d)
    return float((w * (dd - d) ** 2).sum() / w.sum())

def pivot_mds(D):
    """PivotMDS(Brandes & Pich 2007): D=[k,n] のピボット BFS 距離から 2D 大域初期化を得る。
    topology のみ(パス/ID 不使用)。random init が落ちる「背骨の折り畳み局所解」を避けるため sgd_layout
    の x_init に渡す。手順: 距離二乗を二重中心化した B(n×k)→ S=BᵀB(k×k) の上位2固有ベクトルへ射影。"""
    D = np.asarray(D, np.float32)
    k, n = D.shape
    C = D * D                                    # k×n(距離二乗)
    rowmean = C.mean(0)                           # per node  (n,)
    colmean = C.mean(1)                           # per pivot (k,)
    gmean = float(C.mean())
    B = np.ascontiguousarray(C.T)                 # n×k
    del C
    B -= rowmean[:, None]; B -= colmean[None, :]; B += gmean; B *= -0.5   # 二重中心化
    S = (B.T @ B).astype(np.float64)              # k×k(小)
    w, V = np.linalg.eigh(S)
    V2 = V[:, [-1, -2]].astype(np.float32)        # 上位2固有ベクトル
    X = (B @ V2).astype(np.float64)               # n×2
    # 退化(第2軸≈0)ガード: Y がほぼ一定だと SGD は Y に力が出ず開けない → 微小ノイズで対称を破る。
    sx = float(X[:, 0].std()) or 1.0
    if float(X[:, 1].std()) < 1e-6 * sx:
        X[:, 1] += np.random.default_rng(0).standard_normal(n) * (1e-3 * sx)
    return X


def layout_component(subn, sei, sej, pivots, epochs, seed, engine="numpy", numba_min=0, init="random",
                     ball_coverage=170.0, ball_rfrac=3.0, ball_coveff=42.0, ball_min_nodes=20000,
                     ball_tau=0.3, ball_kpct=10.0, short_h=3, short_cap=64,
                     pivot_mem_gib=0.0, pivot_floor=32,
                     repel=3.0, repel_strength=0.15, repel_anneal=1.0, repel_cap=64):
    """1連結成分をレイアウトし、PCA で長軸=x に整える局所座標 [subn,2] を返す。
    numba_min: **廃止**(引数は後方互換で残すが無視)。njit は cache=True で JIT はプロセス跨ぎに
    キャッシュされるため降格の利得が無い一方、この閾値は「エンジン選択」の顔をして **球 pivot の
    有無まで黙って変えていた**(20,000〜100,000 ノードの成分で球が消え、交差が 6.4 倍悪化していた)。
    球を使うかは ball_min_nodes だけで決める。
    init: 'random'(従来)/'pmds'(PivotMDS 大域初期化=背骨の波打ちを抑制, topology-only)。
    ball_*: **球 pivot**(§2.11)。global pivot だけでは大域拘束が疎すぎてクラスタ間距離を
    拘束できず、ノードの 56.9% が他ノードと重なっていた。近傍 K ノードだけを持つ局所 pivot を
    大量に足すと、重なり・密度・バブルの縮退が同時に改善する。パラメータは自動導出
    (build_balls 参照)。ball_coverage=0 で無効化(従来の挙動)。"""
    if subn == 1:
        return np.zeros((1, 2))
    eng = engine        # numba_min による降格は廃止（球 pivot の有無まで変わる副作用があった）
    A = build_csr(subn, sei, sej)
    k = min(pivots, subn)
    if pivot_mem_gib > 0:                      # メモリ予算で global pivot を縛る
        kc = pivot_cap(subn, pivot_mem_gib)
        if kc < k:
            if kc < pivot_floor:
                log(f"  WARN: 成分 n={subn:,} は予算 {pivot_mem_gib:g}GiB では pivot を "
                    f"{kc} 個しか置けない（下限 {pivot_floor}）。**pivots を減らすのではなく "
                    f"グラフを成分に分けるのが正しい対処**（稀エッジ 1 本で全染色体が連結すると "
                    f"レイアウトが破綻することを実測済み）。下限 {pivot_floor} で続行する。")
                kc = pivot_floor
            else:
                log(f"  WARN: pivots がメモリ予算 {pivot_mem_gib:g}GiB で {k:,}→{kc:,} に "
                    f"制限された（成分 n={subn:,}）。所要 ≈ "
                    f"{(2600.0*subn + 12.0*k*subn)/2**30:.0f}GiB")
            k = min(kc, subn)
    piv, D = maxmin_pivots(A, k, seed=seed, engine=eng)   # 大成分は numba BFS(8×), 距離 D は不変
    x0 = pivot_mds(D) if (init == "pmds" and subn >= 3 and k >= 2) else None   # D は非破壊
    ball = build_balls(A, subn, D, coverage=ball_coverage, rfrac=ball_rfrac, coveff=ball_coveff,
                       min_nodes=ball_min_nodes, kpct=ball_kpct, seed=seed,
                       log_prefix="  ") if eng == "numba" else None
    short = build_short(A, subn, short_h, short_cap, log_prefix="  ") if short_h >= 2 else None
    X = sgd_layout(subn, sei, sej, piv, D, epochs=epochs, seed=seed, engine=eng, x_init=x0,
                   ball=ball, ball_tau=ball_tau, short=short, A=A,
                   repel=repel, repel_strength=repel_strength,
                   repel_anneal=repel_anneal, repel_cap=repel_cap)
    Xc = X - X.mean(0)
    _, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    return Xc @ Vt.T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gfa", help="入力 GFA(--distill 指定時は不要)")
    ap.add_argument("--distill", help="distill 中間ディレクトリ(distill_gfa.py 出力)。"
                    "指定時は GFA を parse せず配列ロード(§10.3)。出力 npz は GFA 経路と bit-identical")
    ap.add_argument("--pivots", type=int, default=400,
                    help="global pivot 数（既定 400、2026-08-06 に 200 から変更）。"
                         "**エッジ長不均衡に効く唯一の手**で、chrY/chr22/chr1 の 3 グラフで "
                         "一貫して pivots↑ → 弦長 CV↓（chrY 0.22→0.17 / chr22 1.48→0.57 / "
                         "chr1 0.65→0.26）。chr22 実測 200→400: 弦長 CV 0.84→0.58、"
                         "弦 p90 2.94→2.64、可読領域 108→102、接触率 49.0→52.0%%、"
                         "メモリ 11.8→18.2GB、時間 268→369s。800 は CV 0.40 まで下がるが "
                         "メモリ 35.7GB・接触率 54.6%% で割に合わない。"
                         "メモリは D[k,n] 支配で **1.5×8×k×n_最大成分**（chr22 で 1 pivot "
                         "あたり約 30MB、chr1 で約 51MB）。WG は最大成分が大きいので "
                         "s_vmem を確認してから使うこと。"
                         "※旧記録『pivots=200 は破滅的（グリフ重なり 32.7%%、バブル 0.14）』は "
                         "短距離項も一様斥力も無い旧エンジンでの測定で、当時アレル分離を "
                         "担っていたのは球 pivot だけだった。現在は分離を短距離項と斥力が "
                         "担うので球サイズに依存しない（100/200/400 でアレル重なり "
                         "9.5/9.7/9.4%% と平坦）。詳細は LAYOUT_AND_DENSE_REGIONS.md §6.11。")
    ap.add_argument("--pivot-mem-gib", type=float, default=0.0, metavar="G",
                    help="global pivot の**合計**メモリ予算（GiB、0=無制限・既定）。"
                         "--jobs J のとき J 成分が同時に走る（しかもサイズ降順なので最大の "
                         "J 個が同時に載る）ので、成分あたりは G/J で縛る。成分ごとに "
                         "k_max=(G-2.6KB*n)/(12B*n) で pivots を縛り、縛ったら WARN を出す。"
                         "pivots の最適値はグラフサイズから決められない（chrY と chr1 で傾向が "
                         "逆転）ので、品質でなく**費用で縛る**ための設定。染色体ごとに成分が "
                         "分かれているグラフでは既定 400 が通るので 0 のままでよい。"
                         "最大成分が大きいグラフ（稀エッジで全染色体が連結した場合など）で使う。")
    ap.add_argument("--pivot-floor", type=int, default=32,
                    help="メモリ予算で縛るときの pivots 下限（既定 32）")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True, help="出力 prefix（.npz と .png）")
    ap.add_argument("--min-comp", type=int, default=1000,
                    help="major(本体)成分のしきい値 τ。これ未満のノード数の成分は debris(§8)")
    ap.add_argument("--jobs", type=int, default=1,
                    help="連結成分レイアウトの並列プロセス数。成分は独立なので出力は品質厳密に不変。"
                         "WG は染色体≒成分が複数あり効く(既定1=逐次)")
    ap.add_argument("--engine", choices=["auto", "numpy", "numba"], default="auto",
                    help="pivot ループの実装。numba=単一成分内をスレッド並列(数値等価)。"
                         "auto=numba あれば numba。単一巨大成分(chr22/WG)の高速化用")
    ap.add_argument("--threads", type=int, default=0,
                    help="numba engine のスレッド数(0=既定=全コア)")
    ap.add_argument("--init", choices=["random", "pmds"], default="pmds",
                    help="SGD 初期化。pmds=PivotMDS 大域初期化(背骨の縦波打ちを抑制, topology-only, 既定)。")
    ap.add_argument("--aspect", type=float, default=16.0 / 9.0,
                    help="連結成分の配置(shelf packing)の目標アスペクト比 W/H(既定16:9≈1.78, 4:3=1.33)")
    ap.add_argument("--pack-gap", type=float, default=0.05,
                    help="shelf packing の箱間ギャップ(全体スケール比。大きいほど成分同士を離す。既定0.05)")
    ap.add_argument("--max-draw-edges", type=int, default=300000)
    ap.add_argument("--png-max-nodes", type=int, default=20_000_000,
                    help="このノード数を超えたら PNG を描かない(既定 2000万)。WG(110.9M)では PNG 描画に"
                         "23 分=全体の 40%% を使っていた。0=常に描く")
    # ---- 球 pivot(§2.11)。パラメータは全てグラフから自動導出(build_balls) ----
    ap.add_argument("--ball-coverage", type=float, default=170.0,
                    help="球 pivot の目標被覆数(1 ノードを覆う球の数)。球数は coverage×n/K で決まる。"
                         "**0 で球を無効化=従来の挙動**。既定 170(chr22/chrY/chr1 で検証)")
    ap.add_argument("--ball-rfrac", type=float, default=3.0,
                    help="球サイズ K を決める半径 = (global pivot の被覆半径 R_g)/rfrac。既定 3")
    ap.add_argument("--ball-coveff", type=float, default=42.0,
                    help="1 epoch あたりの実効被覆。間引き率 = coverage/coveff(既定 170/42≈1/4)。"
                         "SGD は元々確率的なので毎 epoch 全球を使う必要はない(2.7× 速く品質は同等以上)")
    ap.add_argument("--ball-kpct", type=float, default=10.0,
                    help="球サイズ K を決める分位点(既定 p10)。中央値だと密領域が支配的なグラフで "
                         "K が桁で暴れる(chr1 実測 中央値 575,351 vs p10 12,566)")
    ap.add_argument("--ball-min-nodes", type=int, default=20000,
                    help="この値未満のノード数の成分は球を使わない(global pivot だけで十分に密)")
    ap.add_argument("--short", type=int, default=3, metavar="H",
                    help="短距離応力項の hop 上限（既定 3、0 で無効）。応力の項集合には "
                         "hop 2 が丸ごと欠けていた（エッジ=hop1 と pivot 対だけ）ため、"
                         "バブルのアレル対 (B,C) と弦 (a,z) はどちらも hop2 で、96%% の "
                         "バブルで拘束が存在しなかった。chr22 実測: 交差 133.8M→83.4M、"
                         "アレル重なり 29.6→10.9%%、弦長 CV 1.68→1.53、可読領域 108→94。"
                         "H=4 は弦長 CV を 1.28 まで下げるが可読領域を 94→115 と悪化させる"
                         "ので既定にしない（H を上げると hop 斥力と同じ挙動になる）。")
    ap.add_argument("--short-cap", type=int, default=64,
                    help="短距離項の 1 ノードあたり対数上限（密領域の暴走防止）")
    ap.add_argument("--repel", type=float, default=3.0, metavar="R",
                    help="一様斥力の到達距離（L0 倍、既定 3、0 で無効）。非隣接ノード対のみ、"
                         "格子で近傍だけ見る。**epoch 内**で他項と同時に釣り合わせる（後処理に"
                         "すると大域配置が固まっていて鎖が蛇行するだけ）。この項が無いと "
                         "2 アレルバブルの 2 本が完全に同一座標へ落ちる（実測: 2D 分離 0.00・"
                         "重なり 100%%・グリフ重なり 62.4%%）。入れると重なり 10.9%% まで落ち、"
                         "emitter の separate_collapsed_alleles が不要になる。"
                         "短距離項とは補完的で、片方だけでは足りない（実測: short のみ 98.4M 交差 / "
                         "斥力のみ 133.8M / 両方 83.4M）。")
    ap.add_argument("--repel-strength", type=float, default=0.15,
                    help="一様斥力の適用率（既定 0.15）")
    ap.add_argument("--repel-anneal", type=float, default=1.0,
                    help="斥力の焼きなまし指数。強さと変位上限を (1-ep/epochs)^this で減衰")
    ap.add_argument("--repel-cap", type=int, default=64,
                    help="1 格子セルで見る相手数の上限（超えたら間引いて重みで補正）")
    ap.add_argument("--ball-taper", type=float, default=0.3,
                    help="球の外縁 τ の割合で重みを 1→0 に落とす(境界の不連続=階段状の歪みを緩和)")
    args = ap.parse_args()

    engine = args.engine
    if engine == "auto":
        engine = "numba" if HAVE_NUMBA else "numpy"
    if engine == "numba" and not HAVE_NUMBA:
        log("WARN: numba 未導入 → engine=numpy にフォールバック")
        engine = "numpy"
    if engine == "numba":
        if args.threads > 0:
            numba.set_num_threads(args.threads)
        log(f"engine=numba threads={numba.get_num_threads()}")
    else:
        log("engine=numpy")

    t0 = time.time()
    if args.distill:
        log(f"loading distill {args.distill}")
        ids, n, ei, ej, su, sv = parse_distill(args.distill)
    else:
        assert args.gfa, "--gfa か --distill のどちらかが必要"
        log(f"parsing {args.gfa}")
        ids, n, ei, ej, su, sv = parse_gfa(args.gfa)
    log(f"nodes={n:,} edges={len(ei):,}")
    A = build_csr(n, ei, ej)
    ncomp, lab = connected_components(A, directed=False)
    del A                                   # 全体 CSR は成分分解にしか使わない → 即解放(16·E_total)
    log(f"components={ncomp}")

    # §8.2 成分分類(path-free なので重み基準のみ; ref-bearing は ref-anchored 経路で使う)
    cls = classify_labels(lab, tau=args.min_comp)
    major_comps = sorted(cls.major_comps, key=lambda c: -cls.comp_weight[c])
    n_major_nodes = int(cls.is_major_elem.sum())
    log(f"major comps={cls.n_major} (nodes={n_major_nodes:,}), "
        f"debris comps={cls.n_debris} (nodes={n-n_major_nodes:,}), τ={args.min_comp}")

    xy = np.zeros((n, 2))
    comp_kind = np.zeros(n, np.int8)   # 1=major, 0=debris (描画用)

    # 成分抽出(共有 lab/ei/ej を使うので main 側で逐次に。重い layout_component だけを並列化する)。
    tasks = []                                    # (ci, idx, subn, sei, sej)
    for ci in major_comps:
        idx = np.where(lab == ci)[0]
        subn = len(idx)
        g2l = -np.ones(n, np.int64); g2l[idx] = np.arange(subn)
        em = (lab[ei] == ci) & (lab[ej] == ci)
        tasks.append((ci, idx, subn, g2l[ei[em]], g2l[ej[em]]))
        log(f"  major comp {ci}: nodes={subn:,} edges={int(em.sum()):,}")

    # レイアウト本体(BFS+SGD)は成分ごとに完全独立 → プロセス並列で品質厳密に不変。
    # engine=numba は成分内をスレッド並列するので、単一巨大成分(chr22/WG)では jobs=1+numba が本命。
    bkw = dict(ball_coverage=args.ball_coverage, ball_rfrac=args.ball_rfrac,
               ball_coveff=args.ball_coveff, ball_min_nodes=args.ball_min_nodes,
               ball_tau=args.ball_taper, ball_kpct=args.ball_kpct,
               short_h=args.short, short_cap=args.short_cap,
               pivot_mem_gib=args.pivot_mem_gib / max(args.jobs, 1),
               pivot_floor=args.pivot_floor,
               repel=args.repel, repel_strength=args.repel_strength,
               repel_anneal=args.repel_anneal, repel_cap=args.repel_cap)
    if args.jobs > 1 and len(tasks) > 1:
        log(f"  laying out {len(tasks)} major comps with {args.jobs} processes…")
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            futs = [ex.submit(layout_component, subn, sei, sej,
                              args.pivots, args.epochs, args.seed, engine, 0,
                              args.init, **bkw)
                    for (_, _, subn, sei, sej) in tasks]
            results = [f.result() for f in futs]
    else:
        results = [layout_component(subn, sei, sej,
                                    args.pivots, args.epochs, args.seed, engine, 0,
                                    args.init, **bkw)
                   for (_, _, subn, sei, sej) in tasks]

    # ---- 配置: サイズ順 shelf packing で目標アスペクト R(既定16:9)へ詰める ----
    #   横一列(帯状)をやめ、各成分/デブリ塊を1つの箱として大きい順に行折り返し。画面を面で使う。
    R = args.aspect
    # unit(実効エッジ長中央値): 配置は平行移動のみで成分内エッジ長は不変 → local レイアウトから測る。
    ulens = []
    for (ci, idx, subn, sei, sej), Xp in zip(tasks, results):
        if subn > 1 and len(sei):
            el = np.hypot(Xp[sej, 0] - Xp[sei, 0], Xp[sej, 1] - Xp[sei, 1])
            el = el[el > 0]
            if len(el):
                ulens.append(el)
    unit = float(np.median(np.concatenate(ulens))) if ulens else 1.0

    # 箱リスト(idx, local原点座標, w, h, kind)。major はサイズ降順(tasks 順)。
    boxes = []
    for (ci, idx, subn, sei, sej), Xp in zip(tasks, results):
        P = Xp - Xp.min(0)
        w = float(P[:, 0].max()) if subn > 1 else unit
        h = float(P[:, 1].max()) if subn > 1 else unit
        boxes.append((idx, P, w, h, 1))

    # §8.4 debris(小連結成分): 各成分を major と同じ SGD でレイアウト(トポロジ尊重)し正方形へ行詰め、
    #   全体を「1個の箱」として major と同じ packing に投入(下に別置きするとアスペクトが崩れるため)。
    deb = np.where(~cls.is_major_elem)[0]
    if len(deb):
        debcomps = sorted(set(lab[deb].tolist()), key=lambda c: -int((lab == c).sum()))
        blobs = []
        for ci in debcomps:
            idx = np.where(lab == ci)[0]; subn = len(idx)
            if subn == 1:
                blobs.append((idx, np.zeros((1, 2)), 0.0, 0.0)); continue
            g2l = -np.ones(n, np.int64); g2l[idx] = np.arange(subn)
            em = (lab[ei] == ci) & (lab[ej] == ci)
            Xp = layout_component(subn, g2l[ei[em]], g2l[ej[em]],
                                  args.pivots, args.epochs, args.seed, engine, 0, args.init,
                                  short_h=args.short, short_cap=args.short_cap,
                                  pivot_mem_gib=args.pivot_mem_gib / max(args.jobs, 1),
                                  pivot_floor=args.pivot_floor,
                                  repel=args.repel, repel_strength=args.repel_strength,
                                  repel_anneal=args.repel_anneal, repel_cap=args.repel_cap)
            Xp = (Xp - Xp.min(0)) * unit              # 原点基準・本体と同スケール
            blobs.append((idx, Xp, float(Xp[:, 0].max()), float(Xp[:, 1].max())))
        row_w = np.sqrt(sum(max(w, unit) * max(h, unit) for _, _, w, h in blobs)) * 1.2
        Didx = []; Dxy = []; cx = 0.0; cy = 0.0; row_h = 0.0
        for idx, Xp, w, h in blobs:
            if cx > 0.0 and cx + w > row_w:
                cx = 0.0; cy -= row_h + unit; row_h = 0.0
            P = Xp.copy(); P[:, 0] += cx; P[:, 1] += cy
            Didx.append(idx); Dxy.append(P)
            cx += max(w, unit) + unit; row_h = max(row_h, h)
        Didx = np.concatenate(Didx); Dxy = np.concatenate(Dxy); Dxy -= Dxy.min(0)
        boxes.append((Didx, Dxy, float(Dxy[:, 0].max()), float(Dxy[:, 1].max()), 0))
        log(f"  debris: {len(deb):,} nodes / {len(debcomps)} comps → 1 box "
            f"{Dxy[:,0].max():.3g}x{Dxy[:,1].max():.3g} (unit≈{unit:.3g})")

    # shelf packing: サイズ順(=boxes 順)を保持して行折り返し。目標行幅 W* を「走査」して
    #   達成アスペクトが R に最も近い折り返し点を選ぶ。**回転は不許可**: 各成分は layout_component が
    #   PCA で長軸=x に整列済み(=常に横向き landscape)なので、箱は SGD 由来の向きのまま配置する。
    #   扁平な大成分が配置アスペクトの下限を支配し得るが、縦に立てない(必ず横向き)。
    sizes = [(w, h) for _, _, w, h, _ in boxes]
    gap = args.pack_gap * (np.sqrt(R * sum(w * h for w, h in sizes)) if sizes else 1.0)

    def do_pack(Wstar):
        # 返り値 place: 各箱の (ox, oy)。回転なし(全箱 SGD 由来の向き=横向きのまま)。
        # 各箱は「行の上端線 top から下へ h だけ吊るす」(行内で上端揃え)。行送りは完了行の最大高さ rh+gap
        # だけ top を下げる。こうすると下の行の背高箱が上の行へ食い込まない(矩形が重ならない)。
        # ※旧実装は箱を基準線から「上へ」伸ばし、行送りを前行の rh 分だけ下げていたため、後続行に前行より
        #   背の高い箱が来ると上へ突き抜けて重なった(MC 非連結成分が Y 方向に融合して見える不具合)。
        place = []; x = 0.0; top = 0.0; rh = 0.0
        for w, h in sizes:
            if x > 0.0 and x + w > Wstar:             # 行あふれ → 改行(下へ)
                top -= rh + gap; x = 0.0; rh = 0.0
            place.append((x, top - h)); x += w + gap; rh = max(rh, h)   # oy=上端線-h(下へ吊るす)
        xr = [px + w for (px, _), (w, _) in zip(place, sizes)]
        yb = [py for (_, py) in place]
        yt = [py + h for (_, py), (_, h) in zip(place, sizes)]
        W = (max(xr) - min(px for px, _ in place)) if place else 1.0
        H = (max(yt) - min(yb)) if place else 1.0
        return place, W, H

    # 回転不許可なので、最大箱の幅が行幅の下限(これ未満だと最大箱が行に収まらない)。
    max_w = max((w for w, h in sizes), default=1.0)
    tot_w = sum(w + gap for w, h in sizes) or max_w
    best = None
    for f in np.linspace(0.0, 1.0, 41):
        Wstar = max_w * (max(tot_w, max_w) / max_w) ** f    # 幾何補間 max_w→総幅
        place, W, H = do_pack(Wstar)
        score = abs(np.log(W / max(H, 1e-9)) - np.log(R))   # 対数比で対称にアスペクト評価
        if best is None or score < best[0]:
            best = (score, place)
    place = best[1]
    for (idx, P, w, h, kind), (ox, oy) in zip(boxes, place):
        Q = P.copy(); Q[:, 0] += ox; Q[:, 1] += oy
        xy[idx] = Q; comp_kind[idx] = kind

    # 全体を中心化(最終の等方 [0.05,0.95] 正規化は emit 側)。
    xy = xy - xy.mean(0)
    Wbb = float(xy[:, 0].ptp()); Hbb = float(xy[:, 1].ptp())
    log(f"shelf-packed {len(boxes)} boxes (no rotation, all horizontal) → bbox {Wbb:.3g}x{Hbb:.3g} "
        f"aspect={Wbb/max(Hbb,1e-9):.2f} (target {R:.2f})")
    log(f"laid out all {n:,} nodes (0 dropped)")
    np.savez_compressed(args.out + ".npz", ids=ids, xy=xy, comp=lab,
                        comp_kind=comp_kind, ei=ei, ej=ej, esu=su, esv=sv,
                        piv=np.array([], np.int64))
    log(f"saved {args.out}.npz")
    # ---- render ---- (WG では PNG に 23 分=全体の 40% を使っていたので大きいグラフでは省く)
    if args.png_max_nodes and n > args.png_max_nodes:
        log(f"PNG skip: n={n:,} > --png-max-nodes={args.png_max_nodes:,}  total {time.time()-t0:.1f}s")
        return
    # ★PNG は**おまけ**。ここで落ちて npz(本体)まで無駄にしない
    #   （WG のレイアウトは数時間かかる。最後の描画で ImportError では割に合わない）。
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.collections import LineCollection
    except Exception as e:
        log(f"PNG skip: matplotlib が使えない ({e})  total {time.time()-t0:.1f}s")
        return
    fig, axes = plt.subplots(2, 1, figsize=(16, 9))
    for ax, title in [(axes[0], "edges + nodes"),
                      (axes[1], "nodes colored by component (debris=gray tray)")]:
        if title.startswith("edges"):
            ne = len(ei)
            sel = np.arange(ne)
            if ne > args.max_draw_edges:
                sel = np.random.default_rng(0).choice(ne, args.max_draw_edges, replace=False)
            segs = np.stack([xy[ei[sel]], xy[ej[sel]]], axis=1)
            ax.add_collection(LineCollection(segs, linewidths=0.1, colors='gray', alpha=0.3))
            ax.scatter(xy[:, 0], xy[:, 1], s=0.5, c='tab:blue', alpha=0.4)
        else:
            col = np.where(comp_kind == 1, lab.astype(float), -1.0)
            ax.scatter(xy[comp_kind == 1, 0], xy[comp_kind == 1, 1], s=0.5,
                       c=lab[comp_kind == 1], cmap='turbo', alpha=0.6)
            ax.scatter(xy[comp_kind == 0, 0], xy[comp_kind == 0, 1], s=0.5,
                       c='gray', alpha=0.6)
        ax.set_aspect('equal'); ax.set_title(title, fontsize=10)
    fig.suptitle(f"plain SGD per-component (no paths)  n={n:,} edges={len(ei):,}  "
                 f"major={cls.n_major} debris_comps={cls.n_debris} τ={args.min_comp}", fontsize=11)
    plt.tight_layout()
    plt.savefig(args.out + ".png", dpi=120)
    log(f"saved {args.out}.png  total {time.time()-t0:.1f}s")

if __name__ == "__main__":
    main()
