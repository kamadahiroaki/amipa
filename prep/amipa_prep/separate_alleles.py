#!/usr/bin/env python3
"""崩壊した並列アレル(座標が完全一致した単一ノードのバブル alleles)を左右に分離する後処理。

背景:
  素の SGD(layout_sgd_plain.py, グラフ距離のみ)は、2ノードバブル X-a-Y / X-b-Y の
  アレル a,b が境界から等距離のため「上に出すか下に出すか」の対称性(勾配ゼロの鞍点)を
  破れず、a と b を同一座標に重ねる。chrY 実測で座標一致ノードの 99.4% がこの
  真の並列アレル(連続チェーンでない)。→ 深層でノードが重なりエッジが埋没する主因。

方針(背骨 x を一切揺らさない後処理):
  各崩壊バブルで
    1. 局所境界軸 axis = xy[exit] - xy[entry] を作り、その *垂直* rot90(axis) 方向へ
       アレルを ±分散する。大域 y でなく局所垂直なので、背骨が縦に走る領域でも左右に開く
       (chrY: 崩壊バブルの 55% は縦寄り背骨。大域 y 一律だと背骨に沿って直列化する誤り)。
    2. entry/exit(=境界 X,Y の進行向き)はパスの通過順から多数決で決める。
       進行方向に対する左右で "同じ側" を定義するので背骨が曲がっても側が一貫する。
    3. どちらのアレルを左(＋)/右(−)に置くかの符号は、パス隣接の符号付き大域割当
       (signed union-find, 重み降順)で決定 → 同一パスが辿るアレルが同じ側に寄る。
       chrY 実測: バブル隣接の 99% を大域一貫に割当可能(残りは真の独立変異/組換え)。

出力: 入力 npz の xy のみ差し替えた npz(ids/ei/ej/esu/esv/piv/comp… 他キーは全保存)。
  offset は正規化 span に対し ~1e-5 と微小で、LOD budget/層構成には影響しない
  (最深層のアレルグリフだけが分離される)。

このモジュールは CLI(下記 usage)と、`layout_emit_db_relayer.py` からの
`separate_collapsed(...)` 直接呼び出し(既定 ON, --no-separate で無効化)の両方で使う。
分離ロジックは 1 実装に集約し drift を防ぐ。

usage:
  separate_collapsed_alleles.py --npz IN.npz --gfa GFA --out OUT.npz
      [--offset-frac 0.4] [--axis-eps 0.05]
"""
import argparse, os, re, sys, time
import numpy as np
import scipy.sparse as sp

try:
    import emit_core as _emit_core          # Rust core(§ separate_path_scan)。無ければ Python 経路。
except Exception:                           # pragma: no cover
    _emit_core = None


def _load_path_tokens(gfa, distill=None):
    """全 path(P/W)token を連結した (tok:int32, poff:int64[P+1]) を返す(step3 走査の入力)。
    distill があれば p_tok(memmap)/p_off をそのまま使う(373GB GFA の再パースを避ける)。
    無ければ GFA を1回だけパースして構築(chrY/chr22 等 distill 未使用時)。token は向き ± 除去の dense/元 id。"""
    if distill is not None:
        p_off = np.load(os.path.join(distill, "p_off.npy"))
        p_tok = np.load(os.path.join(distill, "p_tok.npy"), mmap_mode="r")
        return p_tok, p_off
    toks = []; lens = []
    with open(gfa) as f:
        for line in f:
            if line.startswith("P\t"):
                body = line.rstrip("\n").split("\t")[2]
                if not body:
                    continue
                a = np.fromstring(body.replace("+", "").replace("-", ""), sep=",", dtype=np.int64)
            elif line.startswith("W\t"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 7:
                    continue
                a = np.array([int(x) for x in re.findall(r"[<>](\d+)", parts[6])], np.int64)
            else:
                continue
            toks.append(a.astype(np.int32)); lens.append(a.size)
    poff = np.zeros(len(lens) + 1, np.int64)
    if lens:
        np.cumsum(np.asarray(lens, np.int64), out=poff[1:])
    tok = np.concatenate(toks).astype(np.int32) if toks else np.zeros(0, np.int32)
    return tok, poff


def _path_scan_py(tok, poff, id2idx, bub_of_node, rank_of_node, k2arr, nbub, N):
    """step3 の Python フォールバック(Rust separate_path_scan と同一結果)。
    emit_core 不在時 / use_rust=False / オラクル照合用。argmax タイブレークは挿入順で Rust と一致。"""
    orient = {}      # (bid, prev*N+next) -> [count, first_order]
    esign = {}       # (lo,hi) -> [same, diff]
    order = 0
    id2len = int(id2idx.shape[0])
    P = len(poff) - 1
    b_entry = np.full(nbub, -1, np.int64); b_exit = np.full(nbub, -1, np.int64)
    b_hasvote = np.zeros(nbub, np.uint8)
    for k in range(P):
        a = int(poff[k]); b = int(poff[k + 1])
        raw = np.asarray(tok[a:b], dtype=np.int64)
        valid = (raw >= 0) & (raw < id2len)
        idx = np.full(raw.shape, -1, np.int64)
        idx[valid] = id2idx[raw[valid]]
        seq = idx[idx >= 0].tolist()
        if len(seq) < 2:
            continue
        prev_bid = -1; prev_rank = -1
        for pos, j in enumerate(seq):
            bid = int(bub_of_node[j])
            if bid < 0:
                continue
            rank_r = int(rank_of_node[j])
            if 0 < pos < len(seq) - 1:
                key = (bid, seq[pos - 1] * N + seq[pos + 1])
                e = orient.get(key)
                if e is None:
                    orient[key] = [1, order]; order += 1
                else:
                    e[0] += 1
            if k2arr[bid] == 1 and prev_bid >= 0 and prev_bid != bid and k2arr[prev_bid] == 1:
                same = (rank_r == prev_rank)
                lo, hi = (bid, prev_bid) if bid < prev_bid else (prev_bid, bid)
                es = esign.get((lo, hi))
                if es is None:
                    esign[(lo, hi)] = [1, 0] if same else [0, 1]
                elif same:
                    es[0] += 1
                else:
                    es[1] += 1
            prev_bid = bid; prev_rank = rank_r
    best_cnt = np.full(nbub, -1, np.int64)
    best_ord = np.full(nbub, np.iinfo(np.int64).max, np.int64)
    for (bid, packed), (cnt, ordv) in orient.items():
        if cnt > best_cnt[bid] or (cnt == best_cnt[bid] and ordv < best_ord[bid]):
            best_cnt[bid] = cnt; best_ord[bid] = ordv
            b_entry[bid] = packed // N; b_exit[bid] = packed % N; b_hasvote[bid] = 1
    e_bi = []; e_bj = []; e_same = []; e_diff = []
    for (lo, hi), (s, d) in esign.items():
        e_bi.append(lo); e_bj.append(hi); e_same.append(s); e_diff.append(d)
    return (b_entry, b_exit, b_hasvote,
            np.asarray(e_bi, np.int32), np.asarray(e_bj, np.int32),
            np.asarray(e_same, np.int64), np.asarray(e_diff, np.int64))


def find(parent, relsign, u):
    """符号付き union-find: (root, u の root に対する符号 ±1) を返す(compression なし)。"""
    s = 1
    while parent[u] != u:
        s *= relsign[u]; u = parent[u]
    return u, s


def union(parent, relsign, rank, a, b, J):
    """x_a * x_b = J となるよう連結。既に同集合なら満たされているか(bool)を返す。"""
    ra, sa = find(parent, relsign, a)
    rb, sb = find(parent, relsign, b)
    if ra == rb:
        return sa * sb == J
    K = J * sa * sb                      # 望む x_ra * x_rb
    if rank[ra] < rank[rb]:
        ra, rb = rb, ra
    parent[rb] = ra; relsign[rb] = K
    if rank[ra] == rank[rb]:
        rank[ra] += 1
    return True


def separate_collapsed(ids, xy, ei, ej, gfa, offset_frac=0.4, axis_eps=0.05,
                       collapse_frac=0.8, log=None, distill=None, use_rust=True):
    """座標(準)一致の並列アレルをパス情報で局所境界軸の垂直へ分離した xy を返す(入力 xy は不変)。

    崩壊判定は座標の *厳密一致* でなく **グラフ構造**(deg2 かつ 同一2境界を共有)で行い、
    アレル間 span < collapse_frac×(エッジ長中央値) のバブルだけを分離する(既に開いている
    バブルは触らない=縮めない)。素 SGD の鞍点崩壊は bit-完全一致にならず数 ULP〜1e-8 ずれる
    「準崩壊」を生む(chr22 実測: 崩壊バブルの ~20% が bit-非一致)。構造で束ねる事でこれを確実に拾う。

    引数は layout_sgd_plain.py npz の生配列: ids(graph node-id), xy(N,2), ei/ej(node index 0..N-1)。
    gfa は P/W 行を含む元 GFA(entry/exit 向きと符号付き隣接の材料; 無い場合も分離自体は行う)。
    戻り値: 分離後 xy(N,2, float64)。他キーは呼び出し側で保存する。
    """
    if log is None:
        _t0 = time.time()
        def log(m): print(f"[{time.time()-_t0:6.1f}s] {m}", flush=True)

    ids = np.asarray(ids, dtype=np.int64)
    xy = np.asarray(xy, dtype=np.float64).copy()
    ei = np.asarray(ei, dtype=np.int64); ej = np.asarray(ej, dtype=np.int64)
    N = len(ids)
    log(f"separate: nodes={N:,} edges={len(ei):,}")

    # id -> node index は step3 で dense 逆写像 id2idx を作る(旧 sorted-ids+searchsorted は廃止)。
    deg = np.zeros(N, np.int64); np.add.at(deg, ei, 1); np.add.at(deg, ej, 1)
    # 隣接は純 Python の dict-of-sets/set-of-tuples(WG で ~100GB 破綻)でなく CSR に(~2.5GB)。
    # ei/ej は node index(0..N-1)。無向化して両方向を積む。sum_duplicates で行内は sorted-unique。
    _rows = np.concatenate([ei, ej]); _cols = np.concatenate([ej, ei])
    A = sp.csr_matrix((np.ones(_rows.size, np.int8), (_rows, _cols)), shape=(N, N))
    A.sum_duplicates()
    _indptr, _indices = A.indptr, A.indices
    def nbrs(i):
        return _indices[_indptr[i]:_indptr[i + 1]]

    el = np.hypot(xy[ei, 0] - xy[ej, 0], xy[ei, 1] - xy[ej, 1])
    med = float(np.median(el[el > 0])) if np.any(el > 0) else 1.0
    m = offset_frac * med
    open_thresh = collapse_frac * med         # アレル間 span がこれ未満なら「崩壊/準崩壊」とみなす
    log(f"median edge len={med:.4g}  offset(片側)={m:.4g}  分離幅≈{2*m:.4g}  "
        f"崩壊判定 span<{open_thresh:.4g}")

    # ---- 2. 構造バブル検出(配列化: 群 span を segment-reduce, Python ループ廃止) ----
    # 素 SGD の鞍点崩壊は必ずしも bit-完全一致にならず数 ULP〜1e-8 ずれる(準崩壊)。座標一致でなく構造
    # (deg2・共有2境界)で束ね、アレル間 span < open_thresh のバブルだけを崩壊とみなす。CSR 行が丁度2 →
    # 群内エッジは生じ得ない。旧実装は群ごとに Python dict を積んでいた(WG で 36.6M 反復=律速)ので、
    # 群 span/境界/バブル順序をすべてベクトルで作る(bid 割当は旧 sort(alleles[0]) と同一)。
    rowsz = np.diff(_indptr)
    cand = np.flatnonzero((deg == 2) & (rowsz == 2))
    if cand.size:
        nb0 = _indices[_indptr[cand]].astype(np.int64)
        nb1 = _indices[_indptr[cand] + 1].astype(np.int64)     # CSR 行 sorted → nb0<nb1
        gkey = nb0 * np.int64(N) + nb1                         # 境界ペアの一意キー
        o2 = np.argsort(gkey, kind="stable")
        cs = cand[o2]; ks = gkey[o2]                           # 群内は node index 昇順(cand昇順+stable)
        chg = np.ones(cand.size, bool); chg[1:] = ks[1:] != ks[:-1]
        gs = np.flatnonzero(chg); ge = np.append(gs[1:], cand.size)
        gsz = (ge - gs).astype(np.int64)                       # 各群サイズ
        ng = gs.size
        gid_sorted = np.repeat(np.arange(ng), gsz)             # sorted 候補 -> 群 id
        csx = xy[cs, 0]; csy = xy[cs, 1]
        sumx = np.zeros(ng); np.add.at(sumx, gid_sorted, csx)
        sumy = np.zeros(ng); np.add.at(sumy, gid_sorted, csy)
        cxg = sumx / gsz; cyg = sumy / gsz                     # 群重心(旧 pts.mean(0))
        dist = np.hypot(csx - cxg[gid_sorted], csy - cyg[gid_sorted])
        maxd = np.zeros(ng); np.maximum.at(maxd, gid_sorted, dist)
        span_g = 2.0 * maxd                                    # アレル間 span(旧 2*max dist to centroid)
        keep = (gsz >= 2) & (span_g < open_thresh)             # 崩壊バブルの群だけ(1個共有/開放を除外)
        kgi0 = np.flatnonzero(keep)
        a0_0 = cs[gs[kgi0]]                                    # 各群の最小 node index (= alleles[0])
        border = np.argsort(a0_0, kind="stable")               # 旧 bubbles.sort(key=alleles[0]) を複製
        kgi = kgi0[border]
        nbub = int(kgi.size)
        starts = gs[kgi]                                       # 各バブルの sorted-cs 開始位置
        b_gsz = gsz[kgi]                                       # 各バブルのアレル数
        a0 = cs[starts]                                        # alleles[0]
        a1 = cs[np.minimum(starts + 1, cand.size - 1)]         # alleles[1](k>=2 なので有効; k==2 でのみ使用)
        Xk = _indices[_indptr[a0]].astype(np.int64)            # 境界 X(alleles[0] の隣接0)
        Yk = _indices[_indptr[a0] + 1].astype(np.int64)        # 境界 Y(alleles[0] の隣接1)
    else:
        cs = np.zeros(0, np.int64); gs = cs; nbub = 0
        starts = np.zeros(0, np.int64); b_gsz = np.zeros(0, np.int64)
        a0 = np.zeros(0, np.int64); a1 = np.zeros(0, np.int64)
        Xk = np.zeros(0, np.int64); Yk = np.zeros(0, np.int64); kgi = np.zeros(0, np.int64)
    log(f"構造バブル(deg2 & 2境界共有 & span<{open_thresh:.4g})を崩壊とみなし分離: {nbub:,}")

    # allele node -> (bubble_id, allele_rank) を dense 配列で(旧 Python dict の 73M 反復を廃止)。
    bub_of_node = np.full(N, -1, np.int32)
    rank_of_node = np.full(N, -1, np.int8)
    if nbub:
        sizes = b_gsz
        total = int(sizes.sum())
        seg_bid = np.repeat(np.arange(nbub, dtype=np.int64), sizes)
        offs = np.zeros(nbub, np.int64)
        if nbub > 1:
            offs[1:] = np.cumsum(sizes)[:-1]
        within = np.arange(total, dtype=np.int64) - np.repeat(offs, sizes)
        pos_in_cs = np.repeat(starts, sizes) + within          # sorted-cs 内の実位置(群内昇順)
        allele_nodes = cs[pos_in_cs]                           # bid 昇順・群内昇順に並んだ全アレル node
        seg_starts = np.append(offs, total)                    # seg_starts[bid]=bid の allele 開始, [-1]=total
        bub_of_node[allele_nodes] = seg_bid.astype(np.int32)
        rank_of_node[allele_nodes] = within.astype(np.int8)    # k==2 では 0/1 のみ比較に使用(>2 は k2==0 で不使用)
    k2arr = (b_gsz == 2).astype(np.uint8)

    # ---- 3. パス走査(entry/exit 向き & 符号付き隣接): Rust core 既定, 無ければ Python ----
    # 旧実装は GFA を1行ずつ読み `for k,j in enumerate(seq)` で全パス step を純 Python 走査(WG 数十億 step=律速)。
    # ここを Rust separate_path_scan(or Python フォールバック)へ。token は distill p_tok を優先消費し
    # 373GB GFA の再パースを回避(distill=None のときのみ GFA を1回パース)。P/W 両方を同一視して走る。
    maxid = int(ids.max()) if N else 0
    id2idx = np.full(maxid + 1, -1, np.int32)                  # dense id -> node index(searchsorted+valid と同値)
    id2idx[ids] = np.arange(N, dtype=np.int32)
    tok, poff = _load_path_tokens(gfa, distill)
    n_paths = int(len(poff) - 1)
    use_rust_eff = bool(use_rust and _emit_core is not None and nbub)
    if use_rust_eff:
        b_entry, b_exit, b_hasvote, e_bi, e_bj, e_same, e_diff = _emit_core.separate_path_scan(
            np.asarray(tok, np.int32), np.asarray(poff, np.int64), id2idx,
            bub_of_node, rank_of_node, k2arr, np.int64(nbub), np.int64(N))
    else:
        b_entry, b_exit, b_hasvote, e_bi, e_bj, e_same, e_diff = _path_scan_py(
            tok, poff, id2idx, bub_of_node, rank_of_node, k2arr, nbub, N)
    log(f"paths(scan): P/W={n_paths}  符号付きバブル隣接 edges={len(e_bi):,}"
        + ("  [rust]" if use_rust_eff else "  [py]"))
    if n_paths == 0:
        log("WARN: GFA/distill にパス(P/W)が無い → 分離は行うが「同じ側」符号割当は無効(side は任意)")

    # ---- 4. 符号付き大域割当(union-find, 重み降順) ----
    parent = list(range(nbub)); relsign = [1] * nbub; rank_uf = [0] * nbub
    e_bi = np.asarray(e_bi, np.int64); e_bj = np.asarray(e_bj, np.int64)
    e_same = np.asarray(e_same, np.int64); e_diff = np.asarray(e_diff, np.int64)
    w_arr = e_same + e_diff
    J_arr = np.where(e_same >= e_diff, 1, -1)                  # p>=n → 同符号を望む(旧と同一)
    order = np.lexsort((e_bj, e_bi, -w_arr))                   # (-w, bi, bj) 昇順 = 旧 sort(key=(-w,bi,bj))
    sat_w = tot_w = 0
    for t in order.tolist():
        bi = int(e_bi[t]); bj = int(e_bj[t]); J = int(J_arr[t]); ww = int(w_arr[t])
        ok = union(parent, relsign, rank_uf, bi, bj, J)
        tot_w += ww
        if ok:
            sat_w += ww
    xsign = np.ones(nbub, np.int64)         # +1: allele rank0 を +perp 側へ
    for bid in range(nbub):
        _, s = find(parent, relsign, bid)
        xsign[bid] = s
    if tot_w:
        log(f"符号割当: 満たした隣接重み={sat_w:,}/{tot_w:,} ({100*sat_w/tot_w:.1f}%)")

    # ---- 5. 幾何: 局所境界軸の垂直へ分散 ----
    # 非退化バブル(境界軸が定義できる)は座標が *処理順に依存しない*(境界は動かさず・重心は自分のアレルのみ)
    # → 生 xy から一括ベクトル計算(disp_xy)。退化バブル(境界がほぼ一致し広域近傍から接線回復)だけは
    # ext 近傍(=別バブルのアレルを含みうる)の *その時点の* 座標を読むため bid 順に依存する。旧実装は全バブルを
    # bid 順逐次適用しこの順序依存を持つ → bit 一致のため「退化 bid の直前までに非退化を batch 適用してから
    # 退化 bid を個別処理」する2パスで逐次状態を厳密再現する(退化は ~0.1% なので Python 反復は極少)。
    def unit(v):
        nn = float(np.hypot(v[0], v[1]))
        return (v / nn) if nn > 1e-30 else None

    degen = 0
    if nbub:
        # 投票あれば argmax(entry,exit), 無ければ bnd 境界(旧 orient_vote 分岐と同値)。
        hv = b_hasvote.astype(bool)
        Xr = np.where(hv, b_entry, Xk).astype(np.int64)
        Yr = np.where(hv, b_exit, Yk).astype(np.int64)
        axis = xy[Yr] - xy[Xr]
        axlen = np.hypot(axis[:, 0], axis[:, 1])
        degen_mask = (axlen <= 1e-30) | (axlen < axis_eps * med)

        # (a) 非退化バブルの最終座標を生 xy から一括計算 → disp_xy(アレル位置のみ差替, 他は原座標)。
        disp_xy = xy.copy()
        nd2 = np.flatnonzero((b_gsz == 2) & (~degen_mask))     # 非退化 k==2(大多数)
        if nd2.size:
            u = axis[nd2] / axlen[nd2][:, None]
            perp = np.stack([-u[:, 1], u[:, 0]], axis=1)
            cen = 0.5 * (xy[a0[nd2]] + xy[a1[nd2]])            # 旧 xy[alleles].mean(0)(2行なら =(a+b)/2)
            s = xsign[nd2][:, None].astype(np.float64)
            disp_xy[a0[nd2]] = cen + s * m * perp
            disp_xy[a1[nd2]] = cen - s * m * perp
        for bid in np.flatnonzero((b_gsz >= 3) & (~degen_mask)).tolist():  # 非退化 多アレル(まれ)
            k = int(b_gsz[bid]); al = cs[starts[bid]:starts[bid] + k]
            u = axis[bid] / axlen[bid]
            perp = np.array([-u[1], u[0]]); center = xy[al].mean(0)
            for r, nd in enumerate(al.tolist()):
                disp_xy[nd] = center + ((r - (k - 1) / 2.0) * (2 * m)) * perp

        # (b) 退化バブルを bid 昇順に個別処理。直前までの非退化アレルを batch で xy に反映してから読む。
        def apply_nondegen_range(lo, hi):
            if hi > lo:
                nds = allele_nodes[seg_starts[lo]:seg_starts[hi]]  # bid∈[lo,hi) のアレル(全て非退化)
                xy[nds] = disp_xy[nds]
        cursor = 0
        for B in np.flatnonzero(degen_mask).tolist():
            apply_nondegen_range(cursor, B)                    # bid<B の非退化を確定(逐次状態を再現)
            k = int(b_gsz[B]); alleles = cs[starts[B]:starts[B] + k]
            X = int(Xr[B]); Y = int(Yr[B])
            ax = xy[Y] - xy[X]
            u = unit(ax)
            if u is None or np.hypot(*ax) < axis_eps * med:
                ext = (set(nbrs(X).tolist()) | set(nbrs(Y).tolist())) - set(alleles.tolist()) - {X, Y}
                if ext:
                    pts = xy[sorted(ext)]; c = 0.5 * (xy[X] + xy[Y])
                    u = unit(pts[np.argmax(np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1]))] - c)
                if u is None:
                    u = np.array([1.0, 0.0])
                degen += 1
            perp = np.array([-u[1], u[0]])
            center = xy[alleles].mean(0)
            if k == 2:
                sgn = int(xsign[B])
                xy[alleles[0]] = center + sgn * m * perp
                xy[alleles[1]] = center - sgn * m * perp
            else:
                for r, nd in enumerate(alleles.tolist()):
                    xy[nd] = center + ((r - (k - 1) / 2.0) * (2 * m)) * perp
            cursor = B + 1
        apply_nondegen_range(cursor, nbub)                     # 残り非退化を確定
    log(f"分散適用 bubble={nbub:,}  退化(接線回復)={degen}")

    # ---- 6. 残る(準)座標一致(other): spread 後の xy を *トレランス*でグループ化し放射ジッタで解消 ----
    # 非バブル一致(deg≠2 / 境界不一致)や、同一点付近へ崩壊した *複数の別バブル* が各々 ±perp に開いて
    # +側どうしが接近した残りを拾う。**厳密一致でなくトレランス**でまとめるのが要点: 素 SGD の鞍点崩壊は
    # bit 完全一致でなく数 ULP〜1e-8 ずれた「準一致」を残し(chr22 実測 exact=0 でも近接 ~2万)、下流 emitter の
    # 等方正規化(scale≈0.9/span_raw)がこれを同一 float64 へ丸めて衝突を再生する。tol は「正規化後に float64 が
    # 丸めて同一値になる生距離」span_raw·2^-53 に安全率 2^13 を掛けた span_raw·2^-40。分離幅 m=offset·med には
    # 遥かに及ばない(span_raw/med≲4.6e11 なら tol<m)ので正しく開いたアレル(2m 離間)は決してまとめない。
    span_raw = float((xy.max(0) - xy.min(0)).max()) or 1.0
    tol = span_raw * (2.0 ** -40)             # 正規化後 float64 衝突しきい(span·2^-53)の 2^13≈8000 倍
    sortk = np.lexsort((xy[:, 1], xy[:, 0]))
    xs = xy[sortk]
    chg = np.ones(N, bool)
    if N > 1:
        dd = np.abs(xs[1:] - xs[:-1])         # lexsort(x→y): 近接点は隣接。両軸 <tol の連続は同一クラスタ
        chg[1:] = (dd[:, 0] >= tol) | (dd[:, 1] >= tol)
    gstart = np.flatnonzero(chg); gend = np.append(gstart[1:], N)
    other_nodes = 0; other_groups = 0
    for a, b in zip(gstart.tolist(), gend.tolist()):
        if b - a < 2:
            continue
        v = np.sort(sortk[a:b]); cnt = int(b - a)
        c = xy[v[0]].copy()
        for r, nd in enumerate(v.tolist()):
            ang = 2 * np.pi * r / cnt
            xy[nd] = c + m * np.array([np.cos(ang), np.sin(ang)])
            other_nodes += 1
        other_groups += 1
    if other_nodes:
        log(f"残る準座標一致を放射分散(tol={tol:.3g}): nodes={other_nodes:,} groups={other_groups:,}")

    # ---- 7. 検証: 下流 emitter と同一の等方正規化を内部再現し、float64 丸め後の衝突が 0 か確認 ----
    # (separate は生 xy を返すが、真に効くのは正規化後の分解能。ここで実 emitter 経路と同じ丸めで検算する)
    def _post_norm_collisions(a):
        z = a - a.min(0)
        s = float(z.max()) or 1.0
        z = z / s
        z = 0.05 + 0.9 * z + 0.45 * (1.0 - z.max(0))
        _, cnts = np.unique(z, axis=0, return_counts=True)
        return int(cnts[cnts > 1].sum())
    _, cnts = np.unique(xy, axis=0, return_counts=True)
    remain_raw = int(cnts[cnts > 1].sum())
    remain_norm = _post_norm_collisions(xy)
    log(f"検証: 生 exact 一致={remain_raw:,}  正規化後 float64 衝突={remain_norm:,}(0 が目標)")
    return xy


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True, help="layout_sgd_plain.py の npz(ids,xy,ei,ej[,esu,esv])")
    ap.add_argument("--gfa", required=True,
                    help="パス(P 行 or W 行)を含む元 GFA。パスが無くても分離は行う(同じ側は無効)")
    ap.add_argument("--out", required=True, help="出力 npz")
    ap.add_argument("--offset-frac", type=float, default=0.4,
                    help="片側オフセット = 倍率 × エッジ長中央値(既定 0.4 → 分離幅 ~0.8 エッジ)")
    ap.add_argument("--axis-eps", type=float, default=0.05,
                    help="境界軸長 < eps×med なら退化とみなし広域近傍から接線回復")
    ap.add_argument("--collapse-frac", type=float, default=0.8,
                    help="アレル間 span < 倍率×med のバブルを崩壊とみなし分離(既定0.8≒分離幅2m; "
                         "既に開いたバブルは触らない)")
    args = ap.parse_args()

    t0 = time.time()
    def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)

    # ---- npz 読み込み(全キー保存) ----
    d = np.load(args.npz, allow_pickle=True)
    store = {k: d[k] for k in d.files}
    log(f"npz keys={sorted(store)}")
    xy = separate_collapsed(store["ids"], store["xy"], store["ei"], store["ej"],
                            args.gfa, offset_frac=args.offset_frac,
                            axis_eps=args.axis_eps, collapse_frac=args.collapse_frac, log=log)
    store["xy"] = xy
    np.savez_compressed(args.out, **store)
    log(f"saved {args.out}")


if __name__ == "__main__":
    main()
