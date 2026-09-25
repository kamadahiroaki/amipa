"""共線ブロックの多解像度 MSA（Mauve 風の LCB）を、アトラス＋distill から窓ごとに計算する。

用途は 2 つ:
  1. 事前計算 (CLI):   python3 hier.py --db X.db --distill X.db.distill [--circular] --out X.db.blocks.json
     … 全体窓から、逐次計算では予算を超える窓だけを先に焼いてサイドカーにする（viewer の /api/blocks が配る）
  2. 逐次計算 (worker.py から): 選択ブロックの窓を 1 個だけ計算する（compute_window）。Ctx は常駐させて温める。
試作の経緯と検証は functions/msa_lod/README.md（開発機のみ）。設計は amipa-lab/plans/msa-multires.md。
依存: numpy（必須）、numba（あれば主鎖の LIS が速い。無ければ純 Python で動く）。
"""
import argparse, base64, json, math, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.expanduser("~/pangenome/ggb/functions/graph_conversion"))
from msalib import Atlas, log, breakpoints, blocks_from, consensus_order_fast

try:
    from numba import njit
except Exception:                                   # numba 無しでも動く（純 Python。窓 1 個あたり数十 ms 増）
    def njit(*a, **k):
        if a and callable(a[0]): return a[0]
        return lambda f: f

@njit(cache=True)
def _seg_lis(c, w, st, J, lam):
    """区間列の重み付き最長増加部分列（区間を外すごとにギャップ罰 λ、下り区間は主鎖に入れない）。
    主鎖の隣り合う区間 j→i の条件: lo_i > hi_j − J。Fenwick 木で O(k log k)。返り値: 区間ごとの主鎖フラグ, 得点。
    （functions/graph_conversion/unfold1d.py から同梱）"""
    k = st.size - 1
    lo = np.empty(k); hi = np.empty(k); dr = np.empty(k); ws = np.empty(k)
    for j in range(k):
        a = st[j]; b = st[j + 1]; mn = c[a]; mx = c[a]; s = 0.0
        for i in range(a, b):
            if c[i] < mn: mn = c[i]
            if c[i] > mx: mx = c[i]
            s += w[i]
        lo[j] = mn; hi[j] = mx; ws[j] = s; dr[j] = c[b - 1] - c[a]
    NEG = -1e300
    hs = np.sort(hi)
    fen_v = np.full(k + 1, NEG); fen_i = np.full(k + 1, -1, np.int64)
    F = np.full(k, NEG); prev = np.full(k, -1, np.int64)
    for i in range(k):
        if dr[i] < -J: continue
        best = 0.0 if i == 0 else -lam; bp = -1
        if i > 0 and F[i - 1] != NEG and lo[i] > hi[i - 1] - J and F[i - 1] > best:
            best = F[i - 1]; bp = i - 1
        r = np.searchsorted(hs, lo[i] + J)
        qv = NEG; qi = -1
        while r > 0:
            if fen_v[r] > qv: qv = fen_v[r]; qi = fen_i[r]
            r -= r & (-r)
        if qi >= 0 and qv - lam > best:
            best = qv - lam; bp = qi
        F[i] = ws[i] + best; prev[i] = bp
        r = np.searchsorted(hs, hi[i], side='right')
        while r <= k:
            if F[i] > fen_v[r]: fen_v[r] = F[i]; fen_i[r] = i
            r += r & (-r)
    bi = -1; bs = NEG
    for i in range(k):
        if F[i] == NEG: continue
        v = F[i] - (0.0 if i == k - 1 else lam)
        if v > bs: bs = v; bi = i
    chain = np.zeros(k, np.bool_)
    while bi >= 0:
        chain[bi] = True; bi = prev[bi]
    return chain, bs

RATE_IO_COLD = 2.0e6      # token/s（Lustre 初回、実測。Ctx の読み込みにだけ効く）
RATE_INST    = 21237.0    # インスタンス/s（実測）
RATE_WARM    = 2.5e6      # token/s（Ctx を温めた常駐ワーカーで窓 1 個を作る速さ。2026-09-16 ecoli50 実測 2.5〜3.8M、chrY 10M）
OVERHEAD_S   = 0.10       # 窓 1 個の固定費（秒）
FANOUT       = 15

def drill_cost(ntok, nhap):
    """逐次計算で窓 1 個を作る所要（秒、Ctx は温まっている前提）。これが予算（既定 0.8 s）を超えるブロックは事前計算する"""
    return OVERHEAD_S + ntok / RATE_WARM + FANOUT * nhap / RATE_INST

def chain_circular(rk, dr, kd, w, nb, circular):
    m = len(rk); best = None
    starts = range(m) if (circular and m > 2) else [0]
    for s in starts:
        idx = (np.arange(m) + s) % m
        for sign in (1.0, -1.0):
            if sign > 0: c = (rk[idx] - rk[idx[0]]) % nb; d_ = dr[idx]
            else: c = (rk[idx[0]] - rk[idx]) % nb; d_ = 1 - dr[idx]
            E = np.flatnonzero((d_ == 1) & (kd[idx] < 4))
            if E.size == 0: continue
            chE, sc = _seg_lis(c[E].astype(np.float64), w[idx][E], np.arange(E.size + 1), 0.5, 0.0)
            if best is None or sc > best[0]:
                ch = np.zeros(m, bool); ch[idx[E[chE]]] = True; best = (sc, sign, s, ch)
    if best is None: return np.zeros(m, bool), 1.0, 0
    return best[3], best[1], best[2]

def upgma(D, names):
    """UPGMA。返り値: nodes（id→{leaf}|{ch:[a,b]}, h=高さ）, root, 葉順（小さい部分木を先に ladderize）"""
    n = len(names); nid = n; nodes = {i: dict(id=i, leaf=i, h=0.0) for i in range(n)}
    Dm = {(i, j): float(D[i, j]) for i in range(n) for j in range(n) if i < j}
    size = {i: 1 for i in range(n)}; active = list(range(n))
    while len(active) > 1:
        i, j = min(((a, b) for a in active for b in active if a < b), key=lambda p: Dm[p])
        h = Dm[(i, j)] / 2
        nodes[nid] = dict(id=nid, ch=[i, j], h=h); size[nid] = size[i] + size[j]
        for k in active:
            if k in (i, j): continue
            dik = Dm[(min(i, k), max(i, k))]; djk = Dm[(min(j, k), max(j, k))]
            Dm[(min(nid, k), max(nid, k))] = (dik * size[i] + djk * size[j]) / (size[i] + size[j])
        active = [k for k in active if k not in (i, j)] + [nid]; nid += 1
    root = active[0]
    def leaves(v): return [nodes[v]["leaf"]] if "leaf" in nodes[v] else leaves(nodes[v]["ch"][0]) + leaves(nodes[v]["ch"][1])
    def ladder(v):
        if "leaf" in nodes[v]: return
        a, b = nodes[v]["ch"]
        if len(leaves(a)) > len(leaves(b)): nodes[v]["ch"] = [b, a]
        for c in nodes[v]["ch"]: ladder(c)
    ladder(root)
    return nodes, root, leaves(root)

def fitch(nodes, root, X):
    """Fitch 節約法。X: (葉数, 形質数) int8、0=無し 1=有り 2=不明（この窓に居ないハプロ＝どちらでもよい）。
    返り値: 枝（子ノード id）ごとの (獲得 index 列, 喪失 index 列)"""
    sets = {}
    def down(v):
        nd = nodes[v]
        if "leaf" in nd: x = X[nd["leaf"]]; sets[v] = np.where(x == 1, 2, np.where(x == 0, 1, 3)).astype(np.int8); return
        a, b = nd["ch"]; down(a); down(b)
        inter = sets[a] & sets[b]; sets[v] = np.where(inter > 0, inter, sets[a] | sets[b]).astype(np.int8)
    down(root)
    state = {}; events = {}
    def up(v, parent_state):
        s = sets[v]
        if parent_state is None: st = np.where(s & 1, 0, 1)                  # 根は「無し」を優先
        else: st = np.where((s & (1 << parent_state)) > 0, parent_state, np.where(s & 1, 0, 1))
        state[v] = st.astype(np.int8)
        if parent_state is not None:
            ch = st != parent_state
            events[v] = (np.flatnonzero(ch & (st == 1)).tolist(), np.flatnonzero(ch & (st == 0)).tolist())
        if "leaf" not in nodes[v]:
            for c in nodes[v]["ch"]: up(c, state[v])
    up(root, None)
    return events

def tree_nodes(tree):
    """JSON 形（キーが str）の木を fitch 用に int キーへ"""
    return {int(k): v for k, v in tree["nodes"].items()}

class Ctx:
    """グラフ全体で 1 回だけ作るもの（本番ではサイドカー生成時に 1 回）"""
    def __init__(self, db, distill, order_kind, ref, circular):
        self.circular = circular
        at = Atlas(db, distill, [], ref); L = at.maxlayer; at.layers = [L]; at.anc[L] = np.arange(at.V, dtype=np.int64)
        at.traversals(); co = consensus_order_fast(at, L, order_kind)
        self.at, self.co = at, co
        self.order, self.col, self.ori0 = co["order"], co["col"], co["ori0"]
        self.ncols = len(self.order)
        self.colbp = at.leaf_bp[self.order].astype(np.int64)
        self.colx = np.asarray(co["xlab"], np.int64)
        self.colname = [at.inv_names[v] for v in self.order.tolist()]
        self.colcid = at.refcid[self.order]
        self.inorder = co["inorder"][self.order]
        self.minority = co["nhap"][self.order] < 0.5 * co["H"]
        self.private = co["nhap"][self.order] <= 1
        self.present = co["present"]
        self.seqs = {}
        for pi in self.present:
            sig, orr, ns, bpr = at.trav[L][pi]
            self.seqs[pi] = (self.col[sig].astype(np.int64), (orr == self.ori0[sig]).astype(np.int8),
                             bpr.astype(np.int64), ns.astype(np.int64))
        self.hapnames = sorted({at.labels_of(pi)[1] for pi in self.present},
                               key=lambda h: (not any(at.isref(p) for p in self.present if at.labels_of(p)[1] == h), h))
        self.hidx = {h: i for i, h in enumerate(self.hapnames)}
        # 1 トークンの塩基数（費用モデルの換算）
        tb = sum(int(self.seqs[pi][2].sum()) for pi in self.present); tt = sum(len(self.seqs[pi][0]) for pi in self.present)
        self.bpt = tb / max(1, tt)
        log("Ctx: 列 %d, パス %d, ハプロ %d, %.1f bp/token" % (self.ncols, len(self.present), len(self.hapnames), self.bpt))

def coarsen(prev, W, at_x0, at_x1):
    """入れ子の段: 直前の段のブロック（合意順に並ぶ単位）を、幅が W 未満のものから支持の弱い境界で隣と併合する（落とさない）。
    prev: dict(bid=活性原子区間ごとのブロック id, atomsA, nb, b0, b1, last_rank=ブロック末尾の錨 rank, supc=境界ごとの支持ハプロ数,
    members=最細段の rank の一覧)。返り値: 同じ形の dict と併合回数"""
    nb = prev["nb"]; segs = [[k, k] for k in range(nb)]; nmerge = 0
    sup = np.array([int(prev["supc"][prev["last_rank"][k]]) if prev["last_rank"][k] < len(prev["supc"]) else 0 for k in range(max(0, nb - 1))], np.int64)
    span_of = lambda sg: float(at_x1[prev["b1"][sg[1]]] - at_x0[prev["b0"][sg[0]]])
    while len(segs) > 1:
        widths = [span_of(sg) for sg in segs]; i = int(np.argmin(widths))
        if widths[i] >= W: break
        cands = []
        if i > 0: cands.append((int(sup[segs[i][0] - 1]), i - 1))
        if i + 1 < len(segs): cands.append((int(sup[segs[i][1]]), i + 1))
        j = min(cands)[1]; a, b = (j, i) if j < i else (i, j)
        segs[a] = [segs[a][0], segs[b][1]]; del segs[b]; nmerge += 1
    g_of = np.zeros(nb, np.int64)
    for g, sg in enumerate(segs): g_of[sg[0]:sg[1] + 1] = g
    bid = g_of[prev["bid"]]; nb2 = len(segs); atomsA = prev["atomsA"]
    b0 = np.full(nb2, int(atomsA.max()) + 1, np.int64); b1 = np.full(nb2, -1, np.int64); np.minimum.at(b0, bid, atomsA); np.maximum.at(b1, bid, atomsA)
    last_rank = np.array([prev["last_rank"][sg[1]] for sg in segs], np.int64)
    members = [sum((prev["members"][k] for k in range(sg[0], sg[1] + 1)), []) for sg in segs]
    return dict(bid=bid, atomsA=atomsA, nb=nb2, b0=b0, b1=b1, last_rank=last_rank, supc=prev["supc"], members=members), nmerge

ANCHOR_SAMPLE = 800     # 行間の対応線に使う錨の標本数（窓ごと）

def sample_anchors(ctx, S, A, colx, nc, M=ANCHOR_SAMPLE):
    """窓の錨（A）を合意順に M 本標本化し、各パスでの位置を返す。画面は隣り合う行の同じ錨を線で結ぶ（ntSynt-viz 風の対応線）。
    返り値: dict(m, x=[錨の合意座標], rows={path: {i: b64 u16 標本番号, tok: b64 u32 トークン index（コンティグ内）,
    bp: b64 u32 累積 bp, ori: b64 u8 向き}})。錨はパスごとに高々 1 回（mv ≤ 1）"""
    ancols = np.flatnonzero(A)
    if ancols.size == 0: return None
    sel = ancols if ancols.size <= M else ancols[np.linspace(0, ancols.size - 1, M).astype(np.int64)]
    sel_idx = np.full(nc, -1, np.int64); sel_idx[sel] = np.arange(sel.size)
    b64 = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
    rows = {}
    for (cols_, vo, bp, ns, pi, off) in S:
        m = sel_idx[cols_]; hit = np.flatnonzero(m >= 0)
        if hit.size == 0: continue
        cum = np.concatenate(([0], np.cumsum(bp)))
        rows[ctx.at.p_names[pi]] = dict(i=b64(m[hit].astype(np.uint16)), tok=b64((hit + off).astype(np.uint32)),
                                        bp=b64(cum[hit].astype(np.uint32)), ori=b64(vo[hit].astype(np.uint8)))
    return dict(m=int(sel.size), x=[int(v) for v in colx[sel]], rows=rows)

def build_window(ctx, ranges, Wlist, anchor_frac, merge_frac_max, minor_floor=500, varbins=256, record=None, bins=0, tree=None, want_tree=False):
    # varbins: 少数派サイトの位置（通過内 0..varbins-1）。画面は 0..255 で読むので 256。32 だと左 1/8 に寄る（改訂 30）
    """ranges: [(pi, s0, e0)]。返り値: dict(levels=[...], atoms=n, cols=[...])"""
    wseqs = []; whap = []; wref = []
    for pi, s0, e0 in ranges:
        c_, vo, bp, ns = ctx.seqs[pi]
        if e0 <= s0: continue
        wseqs.append((c_[s0:e0], vo[s0:e0], bp[s0:e0], ns[s0:e0], pi, s0))
        whap.append(ctx.hidx[ctx.at.labels_of(pi)[1]]); wref.append(ctx.at.isref(pi))
    if not wseqs: return None
    _m = np.zeros(ctx.ncols, bool)
    for w in wseqs: _m[w[0]] = True
    cols_in = np.flatnonzero(_m)                       # np.unique(concat) は O(n log n)。1 千万トークンの窓で 1 s かかっていた
    remap = np.full(ctx.ncols, -1, np.int64); remap[cols_in] = np.arange(len(cols_in)); nc = len(cols_in)
    colbp = ctx.colbp[cols_in]; colx = ctx.colx[cols_in]
    colname = [ctx.colname[c] for c in cols_in.tolist()]; colcid = ctx.colcid[cols_in]
    minority = ctx.minority[cols_in]; private = ctx.private[cols_in]; inorder = ctx.inorder[cols_in]
    haps_in = sorted(set(whap)); H = len(haps_in); hre = {h: i for i, h in enumerate(haps_in)}
    S = [(remap[w[0]], w[1], w[2], w[3], w[4], w[5]) for w in wseqs]
    hap_of = np.array([hre[h] for h in whap], np.int64)
    mv = np.zeros(nc, np.int64); nh = np.zeros((H, nc), bool)
    for w, h in zip(S, hap_of):
        cnt_ = np.bincount(w[0], minlength=nc); np.maximum(mv, cnt_, out=mv); nh[h] |= cnt_ > 0     # ufunc.at より bincount が速い
    nhap_col = nh.sum(0)
    A = (mv <= 1) & inorder & (nhap_col >= anchor_frac * H)
    if int(A.sum()) < 4: A = (mv <= 1) & (nhap_col >= anchor_frac * H)     # 順序パスが通らない窓は条件を外す
    anchors = None if (record is not None and len(record) == 0) else sample_anchors(ctx, S, A, colx, nc)
    seq4 = [(w[0], w[1], w[2], w[3]) for w in S]
    rankA, bk, nA = breakpoints(seq4, A, nc); aid, nat = blocks_from(bk, nA)
    if bins and bins > 0 and nA > 0:
        # 座標分割モードでは錨 1 本ずつを原子区間にする。共線な窓は破断点で切れないので原子区間が 1〜数個の巨大な塊になり、
        # 原子区間単位で等分すると 12 ビンを頼んでも 2〜4 個にしか割れない（chrY #4 が 3 ビンになった）
        nat = int(nA); aid = np.arange(nat)
    if nat == 0: return None
    colsA = np.flatnonzero(A); col2atom = np.full(nc, -1, np.int64); col2atom[colsA] = aid
    at_c0 = np.full(nat, nc, np.int64); at_c1 = np.full(nat, -1, np.int64)
    np.minimum.at(at_c0, aid, colsA); np.maximum.at(at_c1, aid, colsA)
    at_x0 = colx[at_c0]; at_x1 = colx[at_c1] + colbp[at_c1]
    tree_out = None
    if want_tree and H >= 2:
        # 系統樹: 葉ノードの Jaccard（比較は「両方が覆う列」に限る。覆い＝錨を持つ原子区間を列に広げた近似）→ UPGMA
        Pm = np.zeros((H, nc), bool); atomP = np.zeros((H, nat), bool)
        for w, h in zip(S, hap_of):
            Pm[h, w[0]] = True; am = col2atom[w[0]]; atomP[h, am[am >= 0]] = True
        ff0 = np.maximum.accumulate(np.where(col2atom >= 0, np.arange(nc), -1)); enclatom = np.where(ff0 >= 0, col2atom[np.maximum(ff0, 0)], 0)
        Pf = Pm.astype(np.float32); Cf = atomP[:, enclatom].astype(np.float32)
        PP = Pf @ Pf.T; PC = Pf @ Cf.T
        union = PC + PC.T - PP; Dist = 1.0 - np.where(union > 0, PP / np.maximum(union, 1), 0.0); np.fill_diagonal(Dist, 0.0)
        names = [ctx.hapnames[h] for h in haps_in]
        nodes_, root_, order_ = upgma(Dist, names)
        tree_out = dict(nodes={str(k): dict(id=v["id"], h=float(v["h"]), **({"leaf": v["leaf"]} if "leaf" in v else {"ch": v["ch"]})) for k, v in nodes_.items()},
                        root=int(root_), order=[int(x) for x in order_], haps=names)
        tree = tree_out
    aseqs = []
    for w in seq4:
        am = col2atom[w[0]]; m = am >= 0
        if m.sum() == 0: aseqs.append((np.zeros(0, np.int64), np.zeros(0, np.int8), np.zeros(0, np.int64), np.zeros(0, np.int64))); continue
        aa = am[m]; oo = w[1][m]; bb = w[2][m]; cut = np.flatnonzero(aa[1:] != aa[:-1]) + 1; st_ = np.concatenate(([0], cut))
        aseqs.append((aa[st_], (np.add.reduceat(bb * oo, st_) * 2 >= np.add.reduceat(bb, st_)).astype(np.int8),
                      np.add.reduceat(bb, st_), np.ones(len(st_), np.int64)))
    levels = []; A2 = np.ones(nat, bool); supp = set(); child_list = []; nb_by_W = {}
    if bins and bins > 0:
        # 座標分割モード: 窓の中に再編成が無い（破断点で 1〜2 ブロックにしかならない）とき、錨を合意座標で等分して
        # ビンをブロックの代わりにする。降りる手段と変異密度の表示を残すため。W はビン幅として記録する
        # 等分は根の合意座標(colx)でなく、窓内の列を合意順に並べた累積 bp で行う。複製反復の列は根の合意座標では
        # 遠方（最初の出現位置）に置かれるので、colx で等分すると外れ値が幅を吸って空ビンばかりになる（chrY #7 が 9 ビン）
        xloc = np.cumsum(colbp) - colbp
        x_at = xloc[colsA].astype(np.float64); lo_, hi_ = float(x_at.min()), float((xloc + colbp)[colsA].max())
        edges = np.linspace(lo_, hi_, bins + 1)
        raw = np.clip(np.searchsorted(edges, x_at, side='right') - 1, 0, bins - 1)
        _, bid_bins = np.unique(raw, return_inverse=True)
        Wlist = [max(1, int((hi_ - lo_) / bins))]; record = set(Wlist)
    fr = [merge_frac_max * (i / max(1, len(Wlist) - 1)) for i in range(len(Wlist))]
    fine = None; cur = None; fine_origin = 0; nmerge = 0      # 最細の記録段。これより粗い記録段は fine のブロックを入れ子にまとめて作る
    for li, W in enumerate(Wlist):
        cap = int(round(fr[li] * H)); nmerge = 0
        recorded_here = (record is None) or (len(record) > 0 and W in record)
        if bins and bins > 0:
            bid = bid_bins.astype(np.int64); nb = int(bid.max()) + 1; atomsA = np.arange(nat); n2 = nat
            b0 = np.full(nb, nat, np.int64); b1 = np.full(nb, -1, np.int64); np.minimum.at(b0, bid, atomsA); np.maximum.at(b1, bid, atomsA)
        elif fine is not None:
            if not recorded_here: continue                     # 入れ子の段は記録する段だけ作る
            cur, nmerge = coarsen(cur, W, at_x0, at_x1)
            bid, nb, atomsA, b0, b1 = cur["bid"], cur["nb"], cur["atomsA"], cur["b0"], cur["b1"]
        else:
          for it in range(400):
              r2, bkr, n2, supc = breakpoints(aseqs, A2, nat, hap_of, H)
              atomsA = np.flatnonzero(A2); bk2 = bkr.copy()
              for b in np.flatnonzero(bk2):
                  if b + 1 < n2 and (int(atomsA[b]), int(atomsA[b + 1])) in supp: bk2[b] = False
              bid, nb = blocks_from(bk2, n2)
              if nb == 0: break
              b0 = np.full(nb, nat, np.int64); b1 = np.full(nb, -1, np.int64)
              np.minimum.at(b0, bid, atomsA); np.maximum.at(b1, bid, atomsA)
              r0 = np.full(nb, n2, np.int64); r1 = np.full(nb, -1, np.int64)
              np.minimum.at(r0, bid, np.arange(n2)); np.maximum.at(r1, bid, np.arange(n2))
              wt = at_x1[b1] - at_x0[b0]; small = np.flatnonzero(wt < W)
              if small.size == 0: break
              merged = False; drop = []
              for b in small[np.argsort(wt[small])].tolist():
                  cands = []
                  if r0[b] - 1 >= 0 and bk2[r0[b] - 1]: cands.append((int(supc[r0[b] - 1]), int(r0[b] - 1)))
                  if r1[b] < n2 - 1 and bk2[r1[b]]: cands.append((int(supc[r1[b]]), int(r1[b])))
                  if cands and cap > 0 and min(cands)[0] <= cap:
                      sb = min(cands)[1]; supp.add((int(atomsA[sb]), int(atomsA[sb + 1]))); merged = True
                  else: drop.append(b)
              if merged: continue
              if not drop: break
              A2[atomsA[np.isin(bid, drop)]] = False
        if not (bins and bins > 0) and fine is None:
            atomsA = np.flatnonzero(A2)
        if nb == 0 or atomsA.size == 0: break
        nb_by_W[W] = nb
        if record is not None and len(record) == 0: continue          # probe: ブロック数だけ数える
        if fine is None and not (bins and bins > 0) and recorded_here and nb > 0:
            fine = dict(bid=bid.copy(), atomsA=atomsA.copy(), nb=nb, b0=b0.copy(), b1=b1.copy(), last_rank=r1.copy(),
                        supc=np.asarray(supc).copy(), members=[[k] for k in range(nb)]); cur = fine
        atom2blk = np.full(nat, -1, np.int64); atom2blk[atomsA] = bid
        blk_c0 = at_c0[b0]; blk_c1 = at_c1[b1]; blk_span = at_x1[b1] - at_x0[b0]
        col2blk = np.where(col2atom >= 0, atom2blk[np.maximum(col2atom, 0)], -1)
        ff = np.maximum.accumulate(np.where(col2blk >= 0, np.arange(nc), -1))
        encl = np.where(ff >= 0, col2blk[np.maximum(ff, 0)], 0)
        # 各ブロックの原子区間数（細分できるか）
        atoms_in = np.bincount(bid, minlength=nb)
        # ブロック内の合意座標: そのブロックの錨列（合意順）に沿った累積錨 bp。colx でなく錨 bp の累積にするのは、複製反復の列が
        # 根の合意座標では遠方に置かれて座標が跳ぶため。blkrank[col]=ブロック内の錨の順位、cpos255[col]=0..255 の位置、
        # bcols[b]=ブロック b の錨列、bstart[b]=各錨の開始 bp、btot[b]=錨 bp の合計
        blkrank = np.full(nc, -1, np.int64); cpos255 = np.zeros(nc, np.float64); bcols = []; bstart = []; btot = np.zeros(nb, np.int64)
        for b in range(nb):
            cb = np.flatnonzero(col2blk == b); bcols.append(cb)
            if cb.size == 0: bstart.append(np.zeros(0, np.int64)); continue
            st_ = np.cumsum(colbp[cb]) - colbp[cb]; bstart.append(st_); btot[b] = int(colbp[cb].sum())
            blkrank[cb] = np.arange(cb.size); cpos255[cb] = st_ / max(1, btot[b]) * 255
        inst_bp = [[] for _ in range(nb)]; hap_out = []; child_ranges = {b: [] for b in range(nb)}; adj_by_name = {}
        bkpt_bp = np.zeros(nb, np.float64)          # 境界 k|k+1 に破断点を持つハプロの bp（環状の原点＝最も切れていない境界）
        if record is not None and W not in record:
            continue                       # 梯子の途中（錨の削減だけ進める）
        for h in haps_in:
            sel = [k for k in range(len(S)) if whap[k] == h]
            ctg_out = []; hap_adj = set()
            for k in sorted(sel, key=lambda q: -int(S[q][2].sum())):
                cols_, vo, bp, ns, pi, off = S[k]; n = len(cols_); tot = int(bp.sum()); cum = np.concatenate(([0], np.cumsum(bp)))
                bstep = col2blk[cols_]; nonb = bstep < 0; tok = bstep.copy(); has_atom = col2atom[cols_] >= 0
                if nonb.any():
                    e = np.diff(np.concatenate(([0], nonb.view(np.int8), [0])))
                    for s0, e0 in zip(np.flatnonzero(e == 1).tolist(), np.flatnonzero(e == -1).tolist()):
                        rbp = int(cum[e0] - cum[s0])
                        if rbp >= W: tok[s0:e0] = -4 if has_atom[s0:e0].any() else -2
                        else: tok[s0:e0] = -3 if rbp >= minor_floor else -1
                inst = []; minor = []
                if (tok == -3).any():
                    m3 = (tok == -3).view(np.int8); e = np.diff(np.concatenate(([0], m3, [0])))
                    for s0, e0 in zip(np.flatnonzero(e == 1).tolist(), np.flatnonzero(e == -1).tolist()):
                        big = s0 + int(np.argmax(bp[s0:e0]))
                        minor.append([int(cum[s0]), int(cum[e0] - cum[s0]), colname[cols_[big]], int(colbp[cols_[big]]), int(s0), int(e0)])
                # 同じブロックの錨の連なり → (最初の錨, 最後の錨+1, ブロック)。トークン単位の Python ループだと 1 千万トークンで 7 s
                anc_idx = np.flatnonzero(tok >= 0); groups = []
                if anc_idx.size:
                    ta_ = tok[anc_idx]; cut_ = np.flatnonzero(ta_[1:] != ta_[:-1]) + 1
                    gs_ = np.concatenate(([0], cut_)); ge_ = np.concatenate((cut_, [anc_idx.size]))
                    groups = list(zip(anc_idx[gs_].tolist(), (anc_idx[ge_ - 1] + 1).tolist(), ta_[gs_].tolist()))
                def emit_gap(ga, gb):
                    tt_ = tok[ga:gb]
                    if tt_.size == 0: return
                    cut_ = np.flatnonzero(tt_[1:] != tt_[:-1]) + 1                       # 同じ種類の連なりに切る（トークン単位のループを避ける）
                    for q, r in zip((np.concatenate(([0], cut_)) + ga).tolist(), (np.concatenate((cut_, [tt_.size])) - 1 + ga).tolist()):
                        t = tok[q]
                        if t in (-2, -4):
                            sb_ = int(cum[r + 1] - cum[q]); plus = int((bp[q:r + 1] * vo[q:r + 1]).sum()); d = 1 if plus * 2 >= sb_ else 0
                            u, cnt = np.unique(cols_[q:r + 1], return_counts=True); big = q + int(np.argmax(bp[q:r + 1])); top = int(cols_[big])
                            natom = int(len(np.unique(col2atom[cols_[q:r + 1]][col2atom[cols_[q:r + 1]] >= 0]))) if t == -4 else int(r + 1 - q)
                            inst.append([int(encl[top]), d, sb_, int(ns[q:r + 1].sum()), int(cnt.max()), 4 if t == -2 else 5,
                                         int(cum[q]), natom, q + off, r + 1 + off, colname[top], int(colbp[top])])
                prev = 0
                for (s0, e0, t) in groups:
                    if s0 > prev: emit_gap(prev, s0)
                    sb_ = int(cum[e0] - cum[s0]); plus = int((bp[s0:e0] * vo[s0:e0]).sum()); d = 1 if plus * 2 >= sb_ else 0
                    tk = tok[s0:e0]; abp = int(bp[s0:e0][tk >= 0].sum()); nonan = (tk < 0).view(np.int8)
                    st_all = np.flatnonzero(np.diff(np.concatenate(([0], nonan))) == 1)
                    en_all = np.flatnonzero(np.diff(np.concatenate((nonan, [0]))) == -1) + 1
                    cmin = np.concatenate(([0], np.cumsum(minority[cols_[s0:e0]].astype(np.int64))))
                    keep_v = (cmin[en_all] - cmin[st_all]) > 0 if st_all.size else np.zeros(0, bool)
                    starts_v = st_all[keep_v]; nvar = int(starts_v.size)
                    cpri = np.concatenate(([0], np.cumsum(private[cols_[s0:e0]].astype(np.int64))))
                    npriv = int(((cpri[en_all] - cpri[st_all]) > 0).sum()) if st_all.size else 0
                    frac = np.unique(((cum[s0 + starts_v] - cum[s0]) / max(1, sb_) * (varbins - 1)).astype(np.uint8)) if starts_v.size else np.zeros(0, np.uint8)
                    vs = base64.b64encode(frac.tobytes()).decode() if frac.size else ""
                    gap_bp = (cum[s0 + en_all] - cum[s0 + st_all]) if st_all.size else np.zeros(0, np.int64)
                    maxgap = int(gap_bp.max()) if gap_bp.size else 0
                    bigg = np.flatnonzero(gap_bp >= max(20000, 0.02 * sb_)) if gap_bp.size else np.zeros(0, np.int64)
                    gaps = [[int((cum[s0 + st_all[q]] - cum[s0]) / max(1, sb_) * 255), int((cum[s0 + en_all[q]] - cum[s0]) / max(1, sb_) * 255), int(gap_bp[q])] for q in bigg.tolist()]
                    ar = col2atom[cols_[s0:e0]]; ar = ar[ar >= 0]
                    mono = 1
                    if ar.size > 1:
                        dd_ = np.diff(ar.astype(np.int64)); mono = 1 if ((dd_ >= 0).all() or (dd_ <= 0).all()) else 0
                    # ---- ブロック内の差異（合意座標モードの描画用）----
                    # このインスタンスが持つブロック t の錨 → 欠けている錨の連続区間（dels: [c0,c1] 0..255, bp）、覆う範囲（ext）、
                    # 少数派サイトと挿入（gaps）の合意座標での位置、コンティグの端で切れているか（trunc: 1=先頭 2=末尾）
                    cc = cols_[s0:e0]; ist = tk == t; pcol = cc[ist]                         # 持っている錨の列
                    rk_ = blkrank[pcol]; K_t = int(bcols[t].size); dels = []; ext = [0, 255]
                    if K_t > 0 and rk_.size:
                        pres = np.zeros(K_t, bool); pres[rk_[rk_ >= 0]] = True
                        miss = (~pres).view(np.int8); e_ = np.diff(np.concatenate(([0], miss, [0])))
                        ms_ = np.flatnonzero(e_ == 1); me_ = np.flatnonzero(e_ == -1)
                        if ms_.size:
                            bs_ = bstart[t][ms_]; be_ = bstart[t][me_ - 1] + colbp[bcols[t][me_ - 1]]; rbp_ = be_ - bs_
                            keep_ = np.flatnonzero(rbp_ >= max(200, 0.01 * btot[t]))
                            keep_ = keep_[np.argsort(-rbp_[keep_])][:32]; keep_ = np.sort(keep_)
                            dels = [[int(bs_[q] / max(1, btot[t]) * 255), int(min(255, math.ceil(be_[q] / max(1, btot[t]) * 255))), int(rbp_[q])] for q in keep_.tolist()]
                        pr_ = np.flatnonzero(pres); ext = [int(cpos255[bcols[t][pr_[0]]]), int(min(255, math.ceil((bstart[t][pr_[-1]] + colbp[bcols[t][pr_[-1]]]) / max(1, btot[t]) * 255)))]
                    # 直前の錨の合意座標（前方埋め）。少数派サイト・挿入の位置に使う
                    posf = np.where(ist, cpos255[cc], np.nan)
                    if ist.any():
                        idx_ = np.where(ist, np.arange(cc.size), 0); idx_ = np.maximum.accumulate(idx_); posf = cpos255[cc[idx_]]; posf[:int(np.argmax(ist))] = cpos255[cc[int(np.argmax(ist))]]
                    else: posf = np.zeros(cc.size)
                    cvs = np.unique(posf[starts_v].astype(np.uint8)) if starts_v.size else np.zeros(0, np.uint8)
                    cvs_b64 = base64.b64encode(cvs.tobytes()).decode() if cvs.size else ""
                    for gi_, q in enumerate(bigg.tolist()): gaps[gi_].append(int(posf[st_all[q]]))
                    trunc = (1 if off + s0 == 0 else 0) | (2 if off + e0 == len(ctx.seqs[pi][0]) else 0)
                    inst.append([t, d, sb_, int(ns[s0:e0].sum()), 1, 0, int(cum[s0]), int((bstep[s0:e0] == t).sum()),
                                 s0 + off, e0 + off, abp, nvar, vs, maxgap, gaps, npriv, mono, trunc, dels, cvs_b64, ext])
                    inst_bp[t].append(sb_); child_ranges[t].append((pi, s0 + off, e0 + off))
                    prev = e0
                if prev < n: emit_gap(prev, n)
                inst.sort(key=lambda x: x[8])
                if not inst:
                    ctg_out.append(dict(name=ctx.at.labels_of(pi)[2] or ctx.at.p_names[pi], path=ctx.at.p_names[pi],
                                        strand="+", start=0, bp=tot, nsteps=n, inst=[], minor=minor)); continue
                rk = np.array([x[0] for x in inst], np.float64); dr = np.array([x[1] for x in inst], np.int8)
                w_ = np.array([x[2] for x in inst], np.float64); kd = np.array([x[5] for x in inst])
                is_circ = ctx.circular and len(sel) == 1
                ch, sign, start = chain_circular(rk, dr, kd, w_, nb, is_circ)
                for q, x in enumerate(inst):
                    if x[5] >= 4: continue
                    d_ = x[1] if sign > 0 else 1 - x[1]
                    x[5] = 0 if ch[q] else (3 if d_ == 0 else 2)
                # 隣接形質（符号つきブロック隣接: a の出口端と b の入口端。0=尾 1=頭。環状なら巡回）→ 枝ごとの獲得/喪失（Fitch）
                bl = [x for x in inst if x[5] < 4]
                if sign < 0: bl = [[x[0], 1 - x[1]] + x[2:] for x in bl[::-1]]
                pairs = list(zip(bl, bl[1:])) + ([(bl[-1], bl[0])] if is_circ and len(bl) > 1 else [])
                for u_, v_ in pairs:
                    ea = (int(u_[0]), 1 if u_[1] else 0); eb = (int(v_[0]), 0 if v_[1] else 1)
                    hap_adj.add(tuple(sorted([ea, eb])))
                # 主鎖の並びで隣接ブロック k→k+1 が続いていない境界に、このコンティグの bp を積む（環状の原点の選択に使う）
                mainseq = [int(x[0]) for x in bl if x[5] == 0]; mpos = {r: i for i, r in enumerate(mainseq)}
                for k in range(nb):
                    nxt = (k + 1) % nb
                    if k not in mpos or nxt not in mpos: continue
                    if not is_circ and k + 1 >= nb: continue
                    ik = mpos[k]; ok = (ik + 1 < len(mainseq) and mainseq[ik + 1] == nxt) or (is_circ and ik == len(mainseq) - 1 and mainseq[0] == nxt)
                    if not ok: bkpt_bp[k] += tot
                ctg_out.append(dict(name=ctx.at.labels_of(pi)[2] or ctx.at.p_names[pi], path=ctx.at.p_names[pi],
                                    strand=("-" if sign < 0 else "+"), start=int(start), bp=tot, nsteps=n, inst=inst, minor=minor))
            hap_out.append(dict(hap=ctx.hapnames[h], isref=int(any(ctx.at.isref(S[k][4]) for k in sel)), contigs=ctg_out))
            adj_by_name[ctx.hapnames[h]] = hap_adj
        per_hap = {}
        for hp in hap_out:
            acc = {}
            for c in hp["contigs"]:
                for x in c["inst"]:
                    if x[5] < 4: acc[x[0]] = acc.get(x[0], 0) + x[2]
            for b, v in acc.items(): per_hap.setdefault(b, []).append(v)
        tbp = [int(np.median(per_hap[b])) if b in per_hap else int(blk_span[b]) for b in range(nb)]
        bpmax = [int(max(per_hap[b])) if b in per_hap else int(blk_span[b]) for b in range(nb)]
        nhap_b = np.zeros(nb, np.int64)
        for hp in hap_out:
            for b in {x[0] for c in hp["contigs"] for x in c["inst"] if x[5] < 4}: nhap_b[b] += 1
        # 表示・グラフハイライト用の座標 (x, span): ブロック内の錨列の全体座標を、局所長より大きい隙間で塊に分け、
        # 錨 bp 合計が最大の塊を採る。複製反復の列が混ざると c0 の colx が別領域を指し span が数 Mb 伸びるため
        xloc_ = np.cumsum(colbp) - colbp
        xo = colx[blk_c0].astype(np.int64).copy(); so = blk_span.astype(np.int64).copy()
        for b in range(nb):
            cc = np.flatnonzero(col2blk == b)
            if cc.size < 2: continue
            gx0 = colx[cc]; gx1 = gx0 + colbp[cc]
            G = max(50000, int(xloc_[cc[-1]] + colbp[cc[-1]] - xloc_[cc[0]]))
            cut = np.flatnonzero(gx0[1:] - gx1[:-1] > G) + 1
            if cut.size == 0: continue
            segs = np.split(np.arange(cc.size), cut)
            best = max(segs, key=lambda s_: int((gx1[s_] - gx0[s_]).sum()))
            xo[b] = int(gx0[best[0]]); so[b] = int(gx1[best[-1]] - gx0[best[0]])
        blocks = [dict(c0=int(blk_c0[b]), c1=int(blk_c1[b]), span=int(so[b]), tbp=tbp[b], bpmax=bpmax[b],
                       nhap=int(nhap_b[b]), x=int(xo[b]), atoms=int(atoms_in[b]), ref_contig=int(colcid[blk_c0[b]]),
                       name=colname[blk_c0[b]] + "…" + colname[blk_c1[b]], ncol=int(atoms_in[b])) for b in range(nb)]
        # 環状の原点: 破断点の bp が最小の境界のうち、直前のブロックが最も広いものの次 → そのブロックを先頭に回して表示する
        origin = 0
        if ctx.circular and nb > 1:
            cand = np.flatnonzero(bkpt_bp == bkpt_bp.min()); origin = int((cand[np.argmax(blk_span[cand])] + 1) % nb)
        members = None
        if cur is not None and cur is not fine:
            members = cur["members"]
            if ctx.circular: origin = next((g for g, mem in enumerate(members) if fine_origin in mem), origin)   # 粗い段の原点＝最細段の原点を含むブロック
        elif cur is not None: fine_origin = origin
        alladj = sorted(set().union(*adj_by_name.values())) if adj_by_name else []
        aidx = {x: i for i, x in enumerate(alladj)}; events = {}
        if tree is not None and alladj:
            tn = {hn: i for i, hn in enumerate(tree["haps"])}
            X = np.full((len(tree["haps"]), len(alladj)), 2, np.int8)          # 2=不明（この窓に居ないハプロ）
            for hn, sset in adj_by_name.items():
                if hn not in tn: continue
                X[tn[hn]] = 0
                for x in sset: X[tn[hn], aidx[x]] = 1
            ev = fitch(tree_nodes(tree), int(tree["root"]), X)
            events = {str(v): dict(gain=g, loss=l) for v, (g, l) in ev.items() if g or l}
        adj_list = [[x[0][0], x[0][1], x[1][0], x[1][1]] for x in alladj]
        levels.append(dict(W=W, nblocks=nb, blocks=blocks, haps=hap_out, mergecap=cap, mode=('bins' if (bins and bins > 0) else 'blocks'), adj=adj_list, events=events, origin=origin, merges=nmerge, members=members,
                           nonmono=int(sum(1 for hp in hap_out for c in hp["contigs"] for x in c["inst"] if x[5] < 4 and x[16] == 0))))
        child_list.append(child_ranges)          # ★段ごとに保持。子の窓は最細段（levels[0]）のブロック番号で作る
    return dict(levels=levels, atoms=int(nat), H=H, child_ranges=(child_list[0] if child_list else {}), child_list=child_list, ncols=nc, nb_by_W=nb_by_W, tree=tree_out, anchors=anchors)

def ladder(span, steps):
    """内部の梯子は細い方から 2 倍ずつ積み上げる（段階的に落とさないと一気に 1 ブロックへ潰れる）。
    記録するのは上位 steps 段だけ。"""
    hi = max(2000, span / FANOUT); lo = max(500, hi / 512)
    ws = []; w = lo
    while w < hi * 1.001:
        ws.append(int(w)); w *= 2
    ws = sorted(set(ws + [int(hi)]))
    return ws, set(ws[-steps:])

DEFAULT_PARAMS = dict(anchor_frac=0.8, sub_anchor_frac=0.5, merge_frac_max=0.25, steps=3, bins=12)

def compute_window(ctx, ranges, span, afrac, P, tag="", tree=None, want_tree=False):
    """窓 1 個を計算する（事前計算・逐次計算の共通部）。
    ranges: [(pi, s0, e0)]（親ブロックの各インスタンスのトークン範囲）、span: 親ブロックの合意座標での幅
    （閾値の梯子の基準）、afrac: 錨に要る出現割合、P: DEFAULT_PARAMS 形のパラメタ。
    返り値: dict(atoms, H, levels, mode, note) か None（錨が取れない／ブロックにならない）。"""
    Wl, _ = ladder(span, P["steps"])
    probe = build_window(ctx, ranges, Wl, afrac, P["merge_frac_max"], record=set())
    if probe is None: log("  win skip %s: 錨が取れない" % tag); return None
    # ブロック数が手頃な閾値を steps 個選ぶ（粗さの目安 30 / 12 / 5 個）
    cand = [(W, n) for W, n in sorted(probe["nb_by_W"].items()) if 3 <= n <= 60]
    rec = set()
    for target in (30, 12, 5)[:P["steps"]]:
        if not cand: break
        W = min(cand, key=lambda kv: (abs(kv[1] - target), -kv[0]))[0]; rec.add(W)
    note = ""
    if not rec:
        # 再編成が無い窓（破断点では 1〜2 ブロック）→ 合意座標で等分（ビン）して降りられるようにする
        note = "破断点では nb=%s なので座標分割 %d ビン" % (sorted(probe["nb_by_W"].values())[:4], P["bins"])
        log("  win %s: %s" % (tag, note))
        res = build_window(ctx, ranges, Wl, afrac, P["merge_frac_max"], bins=P["bins"], tree=tree, want_tree=want_tree)
    else:
        res = build_window(ctx, ranges, Wl, afrac, P["merge_frac_max"], record=rec, tree=tree, want_tree=want_tree)
    if res is None or not res["levels"]:
        log("  win skip %s: 閾値 %s でブロックにならず" % (tag, Wl)); return None
    res["mode"] = res["levels"][0].get("mode", "blocks"); res["note"] = note
    return res

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True); ap.add_argument("--distill", required=True)
    ap.add_argument("--order", choices=["ref", "medoid"], default="ref"); ap.add_argument("--ref", default="")
    ap.add_argument("--circular", action="store_true")
    ap.add_argument("--anchor-frac", type=float, default=0.8); ap.add_argument("--sub-anchor-frac", type=float, default=0.5)
    ap.add_argument("--merge-frac-max", type=float, default=0.25)
    ap.add_argument("--budget", type=float, default=0.8, help="逐次計算の予算（秒、Ctx 温まり時）。これ以下で計算できる窓は焼かず逐次に任せる。1 秒規則の余裕として 0.8")
    ap.add_argument("--max-depth", type=int, default=3); ap.add_argument("--max-windows", type=int, default=400, help="安全弁。当たったら警告（予算で決めるのが本筋）")
    ap.add_argument("--steps", type=int, default=3, help="1 窓あたりの閾値の段数")
    ap.add_argument("--bins", type=int, default=12, help="再編成の無い窓を座標で等分するビン数")
    ap.add_argument("--name", default=""); ap.add_argument("--out", required=True)
    a = ap.parse_args(); t0 = time.time()
    P = dict(anchor_frac=a.anchor_frac, sub_anchor_frac=a.sub_anchor_frac, merge_frac_max=a.merge_frac_max, steps=a.steps, bins=a.bins)
    ctx = Ctx(a.db, a.distill, a.order, a.ref, a.circular)
    root_ranges = [(pi, 0, len(ctx.seqs[pi][0])) for pi in ctx.present]
    total_bp = sum(int(ctx.seqs[pi][2].sum()) for pi in ctx.present)
    cons_span = int(ctx.colx[-1] + ctx.colbp[-1] - ctx.colx[0])      # 合意座標での全長（閾値の梯子はこれを基準にする）
    windows = []; queue = [dict(parent=-1, pblock=-1, ranges=root_ranges, depth=0, label="全体", span=cons_span, afrac=a.anchor_frac)]
    tree = None                                   # 系統樹は根の窓（全ハプロ）で 1 回作り、子の窓の Fitch にも使う
    while queue and len(windows) < a.max_windows:
        w = queue.pop(0)
        res = compute_window(ctx, w["ranges"], w["span"], w["afrac"], P, tag="(親 %d #%s)" % (w["parent"], w["pblock"] + 1),
                             tree=tree, want_tree=(w["depth"] == 0))
        if res is None: continue
        if w["depth"] == 0 and res.get("tree"): tree = res["tree"]; log("系統樹: ハプロ %d, UPGMA（葉ノードの Jaccard）" % len(tree["haps"]))
        wid = len(windows)
        wd_ = dict(id=wid, parent=w["parent"], pblock=w["pblock"], depth=w["depth"], label=w["label"],
                   atoms=res["atoms"], H=res["H"], levels=res["levels"], children={}, mode=res["mode"], anchors=res.get("anchors"))
        if w.get("plevel"): wd_["plevel"] = w["plevel"]; wd_["pW"] = w["pW"]
        windows.append(wd_)
        if w["depth"] >= a.max_depth - 1: continue
        # どの段のブロックからも降りられる（画面はダブルクリック）。逐次計算が予算を超える窓だけ焼く。
        # children の鍵は最細段 "rank"、粗い段 "li:rank"（画面の childKey と同じ）
        for li, lev in enumerate(res["levels"][:1]):            # 子窓は最細段だけ。粗い段のブロックは画面で最細段への絞り込みになる（計算なし）
            cr = res["child_list"][li] if li < len(res["child_list"]) else {}
            for b, blk in enumerate(lev["blocks"]):
                rng = cr.get(b, [])
                if not rng: continue
                ntok = sum(e - s for _, s, e in rng)
                # 原子区間が 1 つ（内部が共線）のブロックも座標分割（ビン）で降りられるので焼く対象。ビンの段で錨 1 本のものだけ除く
                if drill_cost(ntok, blk["nhap"]) <= a.budget or (lev.get("mode") == "bins" and blk["atoms"] < 2): continue
                if len(windows) + len(queue) >= a.max_windows:
                    log("★ --max-windows %d に当たった（予算 %.2fs を超える窓が残る）" % (a.max_windows, a.budget)); break
                key = str(b) if li == 0 else "%d:%d" % (li, b)
                queue.append(dict(parent=wid, pblock=b, ranges=rng, depth=w["depth"] + 1, label="#%d" % (b + 1), span=blk["span"],
                                  afrac=a.sub_anchor_frac, key=key, plevel=li, pW=lev["W"], cost=drill_cost(ntok, blk["nhap"])))
                windows[wid]["children"][key] = -1     # 後で id を埋める
    # 親の children に子 id を入れる
    for wd in windows:
        if wd["parent"] >= 0:
            key = str(wd["pblock"]) if not wd.get("plevel") else "%d:%d" % (wd["plevel"], wd["pblock"])
            windows[wd["parent"]]["children"][key] = wd["id"]
    for wd in windows: wd["children"] = {k: v for k, v in wd["children"].items() if v >= 0}
    # meta にはパラメタも入れる（worker.py が逐次計算で同じ条件を使う）
    meta = dict(name=a.name or os.path.basename(a.db), circular=bool(a.circular), bpt=round(ctx.bpt, 2),
                nhaps=len(ctx.hapnames), ncols=ctx.ncols, order=dict(path=ctx.co["opath"], kind=ctx.co["okind"]),
                order_arg=a.order, ref_arg=a.ref, params=P, max_depth=a.max_depth,
                budget=a.budget, rate_io=RATE_IO_COLD, rate_warm=RATE_WARM, overhead_s=OVERHEAD_S, rate_inst=RATE_INST, fanout=FANOUT, total_bp=total_bp)
    json.dump(dict(meta=meta, windows=windows, tree=tree), open(a.out, "w"), separators=(",", ":"))
    if not windows: log("窓が 1 つも作れなかった"); return
    log("窓 %d 個 (深さ ≤ %d) → %s (%.1f MB, %.1fs)" % (len(windows), max(w["depth"] for w in windows), a.out,
                                                     os.path.getsize(a.out) / 1e6, time.time() - t0))
    for wd in windows[:12]:
        log("  win%-3d depth=%d %-8s 親#%s 原子区間 %5d ハプロ %3d 段 %s 子 %d" % (
            wd["id"], wd["depth"], wd["label"], wd["pblock"] + 1 if wd["pblock"] >= 0 else "-", wd["atoms"], wd["H"],
            ",".join(str(l["nblocks"]) for l in wd["levels"]), len(wd["children"])))

if __name__ == "__main__":
    main()
