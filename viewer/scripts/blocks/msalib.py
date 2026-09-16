"""msalib.py — 多層 MSA 試作の共通部品: LOD 木・distill・層別通過列・合意(参照)順序。10_supernode_msa.py から切り出し。"""
import json, os, re, sqlite3, sys, time
import numpy as np

def log(*a): print("[%s]" % time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)

class Atlas:
    def __init__(self, db, distill, layers, ref=""):
        self.db, self.distill, self.layers = db, distill, layers
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True); self.con = con
        st = con.execute("SELECT maxlayer, data FROM stats").fetchone(); self.maxlayer = int(st[0]); self.stats = json.loads(st[1])
        rows = con.execute("SELECT layer_index, node_name, parent_name, kind, ref_bp, ref_contig_id FROM nodes").fetchall()
        names = {}
        for _, nm, _, _, _, _ in rows:
            if nm not in names: names[nm] = len(names)
        V = len(names); self.V = V; self.names = names
        parent = np.arange(V, dtype=np.int64); kind = np.zeros(V, np.int8)
        inL = np.zeros((self.maxlayer + 1, V), bool); refbp = np.full(V, -1, np.int64); refcid = np.full(V, -1, np.int64)
        for L, nm, pn, kd, rb, rc in rows:
            v = names[nm]; inL[L, v] = True; kind[v] = kd or 0
            if pn is not None and pn in names and pn != nm: parent[v] = names[pn]
            if rb is not None and (refbp[v] < 0 or rb < refbp[v]): refbp[v] = int(rb); refcid[v] = int(rc) if rc is not None else -1
        del rows
        self.parent, self.kind, self.inL, self.refbp, self.refcid = parent, kind, inL, refbp, refcid
        self.anc = {}
        for L in layers:
            cur = np.arange(V, dtype=np.int64)
            for _ in range(300):
                nxt = np.where(inL[L, cur], cur, parent[cur])
                if np.array_equal(nxt, cur): break
                cur = nxt
            self.anc[L] = cur
        self.inv_names = [None] * V
        for nm, v in names.items(): self.inv_names[v] = nm
        # distill
        d = distill
        self.p_off = np.load(d + "/p_off.npy"); self.p_names = open(d + "/p_names.txt").read().splitlines()
        self.p_tok = np.load(d + "/p_tok.npy", mmap_mode="r"); self.p_ori = np.load(d + "/p_ori.npy", mmap_mode="r")
        id_map = np.load(d + "/id_map.npy"); s_id = np.load(d + "/s_id.npy"); s_bp = np.load(d + "/s_bp.npy"); M = len(id_map)
        leaf_names = [nm for nm, v in names.items() if kind[v] == 0 and inL[self.maxlayer, v]]
        orig = np.array([int(n[1:]) for n in leaf_names], np.int64)
        o2v = np.full(max(int(orig.max()), int(id_map.max())) + 2, -1, np.int64); o2v[orig] = [names[n] for n in leaf_names]
        self.d2v = np.full(M + 1, -1, np.int64); self.d2v[1:] = o2v[id_map]
        self.bp_dense = np.zeros(M + 1, np.int64); self.bp_dense[s_id] = np.maximum(1, s_bp)
        self.leaf_bp = np.zeros(V, np.int64); ok = self.d2v[1:] >= 0; self.leaf_bp[self.d2v[1:][ok]] = self.bp_dense[1:][ok]
        self.leaf_v = np.array([names[n] for n in leaf_names], np.int64)
        self.P = len(self.p_names)
        refpref = {"grch38", "chm13"}
        try: refpref |= {str(k).lower() for (k,) in con.execute("SELECT DISTINCT ref_key FROM ref_contigs") if k}
        except sqlite3.Error: pass
        if ref: refpref = {ref.lower()}
        self.refpref = refpref

    def isref(self, pi):
        low = self.p_names[pi].lower()
        return any(low == p or low.startswith(p + "#") or low.startswith(p + ".") for p in self.refpref)
    def labels_of(self, pi):
        full = self.p_names[pi]; base = re.sub(r"\[[^\]]*\]$", "", full); f = base.split("#")
        samp = f[0]; hap = "#".join(f[:2]) if len(f) >= 3 else base; ctg = f[2] if len(f) >= 3 else ""
        return samp, hap, ctg

    def traversals(self):
        """層別に、パスごとの潰した通過列 (sigma[v], ori(1=+), nsteps, bp) と行 bp を返す"""
        trav = {L: [] for L in self.layers}; rowbp = np.zeros(self.P, np.int64)
        for pi in range(self.P):
            s, e = int(self.p_off[pi]), int(self.p_off[pi + 1])
            if e <= s:
                for L in self.layers: trav[L].append(None)
                continue
            tk = np.asarray(self.p_tok[s:e]).astype(np.int64); ori = np.asarray(self.p_ori[s:e]).astype(np.int64)
            v = self.d2v[tk]; good = v >= 0
            if not good.all(): tk, ori, v = tk[good], ori[good], v[good]
            bp = self.bp_dense[tk]; rowbp[pi] = int(bp.sum())
            for L in self.layers:
                av = self.anc[L][v]
                cut = np.flatnonzero(av[1:] != av[:-1]) + 1; starts = np.concatenate(([0], cut))
                sig = av[starts]; bpr = np.add.reduceat(bp, starts); plus = np.add.reduceat(bp * ori, starts)
                ns = np.diff(np.concatenate((starts, [len(av)])))
                trav[L].append((sig, (plus * 2 >= bpr).astype(np.int8), ns, bpr))
        self.trav, self.rowbp = trav, rowbp
        return trav, rowbp

    def col_bp(self, L, order):
        tot = np.bincount(self.anc[L][self.leaf_v], weights=self.leaf_bp[self.leaf_v], minlength=self.V)
        return tot[order]

    def consensus_order(self, L, order="ref"):
        """列の順序: 順序パス(参照 or 典型パス)の初回通過順 + 非通過ノードは直前の錨の後ろにスロット(全行の中央値)。
        返り値 dict(order[v index の配列], col[V]→列 index or -1, ori0[V], xlab[ncols], backbone[V], opath, okind)"""
        T = self.trav[L]; V = self.V
        present = [pi for pi in range(self.P) if T[pi] is not None and len(T[pi][0])]
        haps = sorted({self.labels_of(pi)[1] for pi in present}); H = len(haps); hid = {h: i for i, h in enumerate(haps)}
        pres = np.zeros((H, V), bool); multi = np.zeros(V, bool)
        for pi in present:
            u, c = np.unique(T[pi][0], return_counts=True); pres[hid[self.labels_of(pi)[1]], u] = True; multi[u[c > 1]] = True
        nhap = pres.sum(0); backbone = (nhap * 2 >= H) & ~multi & self.inL[L]
        refs = [pi for pi in present if self.isref(pi)]
        if order == "ref" and refs:
            o = max(refs, key=lambda pi: self.rowbp[pi]); okind = "ref"
        else:
            pairs = {}
            for pi in present:
                bbseq = T[pi][0][backbone[T[pi][0]]]
                pairs[pi] = set(zip(bbseq[:-1].tolist(), bbseq[1:].tolist())) | set(zip(bbseq[1:].tolist(), bbseq[:-1].tolist()))
            o = max(present, key=lambda pi: sum(len(pairs[pi] & pairs[q]) for q in present if q != pi)); okind = "medoid"
        sig_o, ori_o, ns_o, bp_o = T[o]
        first = {}
        for i, sg in enumerate(sig_o.tolist()):
            if sg not in first: first[sg] = i
        pos = np.full(V, -1.0); ori0 = np.full(V, -1, np.int8)
        for sg, i in first.items(): pos[sg] = i; ori0[sg] = ori_o[i]
        cum_o = np.concatenate(([0], np.cumsum(bp_o)))
        slot_acc = {}; ori_acc = {}
        for pi in present:
            sg, orr, ns, bpr = T[pi]; p = pos[sg]; anch = p >= 0
            if anch.all(): continue
            idx = np.arange(len(sg)); last_anchor = np.maximum.accumulate(np.where(anch, idx, -1))
            nxt_anchor = np.minimum.accumulate(np.where(anch, idx, len(sg))[::-1])[::-1]
            for k in np.flatnonzero(~anch).tolist():
                sgk = int(sg[k])
                if last_anchor[k] >= 0: key = pos[sg[last_anchor[k]]] + 0.5
                elif nxt_anchor[k] < len(sg): key = pos[sg[nxt_anchor[k]]] - 0.5
                else: key = None
                if key is not None: slot_acc.setdefault(sgk, []).append(key)
                ori_acc.setdefault(sgk, [0, 0])[0 if orr[k] else 1] += int(bpr[k])
        for sgk, ks in slot_acc.items(): pos[sgk] = float(np.median(ks))
        for sgk, (pb, mb) in ori_acc.items():
            if ori0[sgk] < 0: ori0[sgk] = 1 if pb >= mb else 0
        allsig = np.unique(np.concatenate([T[pi][0] for pi in present]))
        unplaced = allsig[pos[allsig] < 0]
        pos[unplaced] = len(sig_o) + 1 + np.arange(len(unplaced)); ori0[unplaced[ori0[unplaced] < 0]] = 1
        order_v = allsig[np.lexsort((allsig, pos[allsig]))]
        col = np.full(V, -1, np.int64); col[order_v] = np.arange(len(order_v))
        xlab = np.zeros(len(order_v), np.int64); last = 0
        for j, sg in enumerate(order_v.tolist()):
            if self.refbp[sg] >= 0 and okind == "ref": xlab[j] = self.refbp[sg]
            elif sg in first: xlab[j] = cum_o[first[sg]]
            else: xlab[j] = -1
            if xlab[j] < 0: xlab[j] = last
            else: last = xlab[j]
        return dict(order=order_v, col=col, ori0=ori0, xlab=xlab, backbone=backbone, nhap=nhap, opath=self.p_names[o], okind=okind,
                    present=present, haps=haps, unplaced=int(len(unplaced)))

# ---------------------------------------------------------------- 破断点解析(Mauve 流)
def breakpoints(seqs, A, ncols, hap_of=None, nhap=0):
    """A(錨フラグ, 列空間)の下で破断点を求める。seqs: [(cols, vo, bp, ns)]。
    hap_of/nhap を渡すと、境界ごとに「その境界で共線性が崩れるハプロタイプ数」も返す（4 要素）。
    返り値: rankA(列→錨 rank, 非錨は -1), bk(錨 rank b と b+1 の間が破断か), nA[, sup(境界ごとの支持ハプロ数)]"""
    rankA = np.cumsum(A) - 1; rankA[~A] = -1; nA = int(A.sum())
    bk = np.zeros(max(nA, 1), bool)
    supm = np.zeros((max(nA, 1), nhap), bool) if (hap_of is not None and nhap) else None
    for si, (cols, vo, bp, ns) in enumerate(seqs):
        m = A[cols]
        if m.sum() < 2: continue
        r = rankA[cols[m]]; o = vo[m]
        S = np.unique(r); idx = np.searchsorted(S, r)
        fwd = (o[:-1] == 1) & (o[1:] == 1) & (idx[1:] == idx[:-1] + 1)
        rev = (o[:-1] == 0) & (o[1:] == 0) & (idx[1:] == idx[:-1] - 1)
        bad = np.flatnonzero(~(fwd | rev))
        if bad.size == 0: continue
        b1 = np.where(o[bad] == 1, r[bad], r[bad] - 1)
        b2 = np.where(o[bad + 1] == 1, r[bad + 1] - 1, r[bad + 1])
        for b in (b1, b2):
            b = b[(b >= 0) & (b < nA - 1)]; bk[b] = True
            if supm is not None: supm[b, hap_of[si]] = True
    if supm is not None: return rankA, bk, nA, supm.sum(1)
    return rankA, bk, nA

def blocks_from(bk, nA):
    if nA == 0: return np.zeros(0, np.int64), 0
    bid = np.concatenate(([0], np.cumsum(bk[:nA - 1]))).astype(np.int64)
    return bid, int(bid[-1]) + 1

def consensus_order_fast(at, L, order="ref", sample_backbone=4000):
    """consensus_order のベクトル化版(葉レベル 100 万列でも回る)。返り値は同じ dict。"""
    T = at.trav[L]; V = at.V
    present = [pi for pi in range(at.P) if T[pi] is not None and len(T[pi][0])]
    haps = sorted({at.labels_of(pi)[1] for pi in present}); H = len(haps); hid = {h: i for i, h in enumerate(haps)}
    nhap = np.zeros(V, np.int64); multi = np.zeros(V, bool)
    seen_h = {}
    for pi in present:
        u, c = np.unique(T[pi][0], return_counts=True); multi[u[c > 1]] = True
        h = hid[at.labels_of(pi)[1]]
        prev = seen_h.get(h)
        if prev is None: seen_h[h] = u
        else: seen_h[h] = np.union1d(prev, u)
    for h, u in seen_h.items(): nhap[u] += 1
    backbone = (nhap * 2 >= H) & ~multi & at.inL[L]
    refs = [pi for pi in present if at.isref(pi)]
    if order == "ref" and refs:
        o = max(refs, key=lambda pi: at.rowbp[pi]); okind = "ref"
    else:
        bb = np.flatnonzero(backbone)
        if bb.size > sample_backbone: bb = np.sort(np.random.default_rng(1).choice(bb, sample_backbone, replace=False))
        bbset = np.zeros(V, bool); bbset[bb] = True
        pairs = {}
        for pi in present:
            s = T[pi][0][bbset[T[pi][0]]]
            pairs[pi] = set(zip(s[:-1].tolist(), s[1:].tolist())) | set(zip(s[1:].tolist(), s[:-1].tolist()))
        o = max(present, key=lambda pi: sum(len(pairs[pi] & pairs[q]) for q in present if q != pi)); okind = "medoid"
    sig_o, ori_o, ns_o, bp_o = T[o]
    uo, fo = np.unique(sig_o, return_index=True)
    pos = np.full(V, -1.0); ori0 = np.full(V, -1, np.int8); pos[uo] = fo; ori0[uo] = ori_o[fo]
    cum_o = np.concatenate(([0], np.cumsum(bp_o)))
    keys_n, keys_k = [], []; plus_bp = np.zeros(V, np.int64); tot_bp = np.zeros(V, np.int64)
    for pi in present:
        sg, orr, ns, bpr = T[pi]; p = pos[sg]; anch = p >= 0
        if anch.all(): continue
        idx = np.arange(len(sg)); last_a = np.maximum.accumulate(np.where(anch, idx, -1))
        nxt_a = np.minimum.accumulate(np.where(anch, idx, len(sg))[::-1])[::-1]
        un = np.flatnonzero(~anch)
        key = np.where(last_a[un] >= 0, pos[sg[np.maximum(last_a[un], 0)]] + 0.5,
                       np.where(nxt_a[un] < len(sg), pos[sg[np.minimum(nxt_a[un], len(sg) - 1)]] - 0.5, np.nan))
        ok = ~np.isnan(key); keys_n.append(sg[un[ok]]); keys_k.append(key[ok])
        np.add.at(plus_bp, sg[un], bpr[un] * orr[un]); np.add.at(tot_bp, sg[un], bpr[un])
    if keys_n:
        kn = np.concatenate(keys_n); kk = np.concatenate(keys_k)
        srt = np.lexsort((kk, kn)); kn, kk = kn[srt], kk[srt]
        u, st, cnt = np.unique(kn, return_index=True, return_counts=True)
        pos[u] = kk[st + cnt // 2]
    un_all = np.flatnonzero((ori0 < 0) & (tot_bp > 0)); ori0[un_all] = (plus_bp[un_all] * 2 >= tot_bp[un_all]).astype(np.int8)
    allsig = np.unique(np.concatenate([T[pi][0] for pi in present]))
    unplaced = allsig[pos[allsig] < 0]
    pos[unplaced] = len(sig_o) + 1 + np.arange(len(unplaced)); ori0[unplaced[ori0[unplaced] < 0]] = 1
    order_v = allsig[np.lexsort((allsig, pos[allsig]))]
    col = np.full(V, -1, np.int64); col[order_v] = np.arange(len(order_v))
    xlab = np.full(len(order_v), -1, np.int64)
    if okind == "ref":
        has = at.refbp[order_v] >= 0; xlab[has] = at.refbp[order_v[has]]
    ino = pos[order_v] == np.floor(pos[order_v])
    firstidx = np.full(V, -1, np.int64); firstidx[uo] = fo
    fi = firstidx[order_v]; use = (xlab < 0) & (fi >= 0); xlab[use] = cum_o[fi[use]]
    # 前の値で穴埋め
    m = xlab >= 0; ff = np.maximum.accumulate(np.where(m, np.arange(len(xlab)), -1)); xlab = np.where(ff >= 0, xlab[np.maximum(ff, 0)], 0)
    inorder = np.zeros(V, bool); inorder[uo] = True
    return dict(order=order_v, col=col, ori0=ori0, xlab=xlab, backbone=backbone, nhap=nhap, opath=at.p_names[o], okind=okind,
                present=present, haps=haps, unplaced=int(len(unplaced)), inorder=inorder, H=H)
