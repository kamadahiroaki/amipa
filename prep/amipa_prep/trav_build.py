#!/usr/bin/env python3
"""trav 段: 錨・座標・通過・境界・持続度の木・反復を distill から作り、サイドカー <db>.trav に書く（2026-10-22 の構築器 synteny2_build.py を 11-02 に prep へ移した）。

  1. 出現回数（ハプロタイプごとの 2 回以上出るノードの一覧。ハプロタイプ単位。丸ごと別コンティグに含まれるコンティグは除く）
  2. 強い錨（1 回だけ出る株 ≥ support_strong、2 回以上の株 ≤ max_multi）→ コンティグの向きを揃え、隣接の多数決の有向グラフ → トポロジカル順
  3. 残りの候補（≥2 株で 1 回）を、持つ株ごとに両脇の強い錨から補間し、中央値を座標、ばらつき ≤ tol なら錨（順序一貫）、超えれば「場所が株で違う」
  4. 通過: コンティグごとに座標のある錨を辿り、区分単調（ε）と跳び（J）で切る。同じコンティグで座標区間が重なる通過にコピー番号
  5. 境界: 通過の端（再編成）と被覆（その座標を通るハプロタイプ数）の変化（有無）。持続度の木（狭い原子から弱い境界を潰す）
  6. 反復: 株ごとに 2 回以上出るノードの連なり（出現単位）
出力: <out>（SQLite）。使い方: trav_build.py --distill D --seed-ref <参照パスの名前の頭> --out X.trav（既定の引数は ecoli50・ヒト chr20–22 で使ってきた値）
続けて trav_xfill.py（錨でない葉の座標）と trav_super.py（スーパーノードの座標）が同じ .trav に表を足す
"""
import argparse, collections, heapq, json, os, sqlite3, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from trav_arrays import put_array
import numpy as np
from numba import njit

ap = argparse.ArgumentParser()
ap.add_argument("--distill", required=True); ap.add_argument("--seed-synteny", default="", help="向きと同順の種に古い木（.synteny）の dcol を使う。無ければ --seed-ref の参照パスから作る（11-02）"); ap.add_argument("--gap-fill", type=int, default=1, help="強い錨の片で覆われない区間を補間の錨で切り直して片を足す（11-02）"); ap.add_argument("--reorder-blocks", type=int, default=1, help="大きな塊を種の順に並べ直す（11-02）"); ap.add_argument("--seed-ref", default="", help="種にする参照パスの名前の頭（例 GRCh38）。空なら先頭のパス"); ap.add_argument("--out", required=True)
ap.add_argument("--support-strong", type=float, default=0.5); ap.add_argument("--max-multi", type=float, default=0.1); ap.add_argument("--tol", type=float, default=3.0, help="補間座標のばらつき（強い錨の順位の単位）")
ap.add_argument("--eps", type=int, default=10); ap.add_argument("--J", type=int, default=2000); ap.add_argument("--min-anchors", type=int, default=10); ap.add_argument("--floor-bp", type=int, default=500)
ap.add_argument("--contained", type=float, default=0.9, help="他コンティグとこの割合以上を共有するコンティグは冗長として一意性の計算から除く")
ap.add_argument("--consist", type=float, default=0.1, help="順序一貫の選別: 後ろ向き・跳びがこの割合を超える株で起きる錨を外す"); ap.add_argument("--rounds", type=int, default=3); ap.add_argument("--reloc-rounds", type=int, default=10, help="挿入片の置き直しの最大回数（0 で無効）"); ap.add_argument("--seg-multi", type=int, default=1, help="通過の切り出しに、そのハプロタイプが 2 回以上通る錨も使う（11-02。0 で旧来の 1 回だけ。座標を作る段は常に 1 回だけ）。2 回通るハプロタイプの区間が通過として残らず、行が出なかった")
ap.add_argument("--seg-anchors", default="strong", help="通過の切り出しに使う錨: strong（強い錨だけ）| all（補間で置いた錨も）"); ap.add_argument("--rep-gap", type=int, default=20); ap.add_argument("--rep-gap-bp", type=int, default=500); ap.add_argument("--rep-min-bp", type=int, default=500)
a = ap.parse_args(); T0 = time.time()
OVF_BATCH = 5_000_000; ADJ_BATCH = OVF_BATCH   # 隣接の組を足し込む単位（int64 で 40 MB）。11-02: 5,000 万（400 MB）だと混んだ計算ノードで一時配列の確保（np.unique の複製）が遅く、1 回の集計が 13 秒〜245 秒とばらついた
def _mem():   # 現在の常駐メモリと最大値（GB）。段ごとのメモリを測る（11-02、全ゲノムの見積もり用）
    try:
        st = dict(l.split(":", 1) for l in open("/proc/self/status") if l.startswith(("VmRSS", "VmHWM"))); return f"RSS {int(st['VmRSS'].split()[0]) / 1e6:.1f}/{int(st['VmHWM'].split()[0]) / 1e6:.1f}G"
    except Exception: return ""
def log(*x): print(f"[{time.time()-T0:7.1f}s {_mem()}]", *x, file=sys.stderr, flush=True)
# np.add.at / minimum.at / maximum.at の代わり（11-02）。ufunc.at は 1 要素ごとの処理が遅く、順序一貫の選別と補間のループで時間の大半を占めた。
# 同じ順に 1 要素ずつ処理するので結果（浮動小数の和の順も）は元と同じ
@njit(cache=True)
def _add_at(a, idx, v):
    for k in range(idx.size): a[idx[k]] += v[k]
@njit(cache=True)
def _add1_at(a, idx):
    for k in range(idx.size): a[idx[k]] += 1
@njit(cache=True)
def _min_at(a, idx, v):
    for k in range(idx.size):
        if v[k] < a[idx[k]]: a[idx[k]] = v[k]
@njit(cache=True)
def _max_at(a, idx, v):
    for k in range(idx.size):
        if v[k] > a[idx[k]]: a[idx[k]] = v[k]

D = a.distill
p_tok = np.load(D + "/p_tok.npy", mmap_mode="r"); p_ori = np.load(D + "/p_ori.npy", mmap_mode="r"); p_off = np.load(D + "/p_off.npy"); id_map = np.load(D + "/id_map.npy")
names = open(D + "/p_names.txt").read().splitlines(); NP = len(names); N = len(id_map)
_sid = np.load(D + "/s_id.npy"); _sbp = np.load(D + "/s_bp.npy"); bp = np.zeros(N + 1, np.int64); bp[_sid] = _sbp
def hap_of(nm):
    # PanSN（sample#hap#contig）。# の無い名前（全ゲノム MC の参照 `GRCh38.chr1` など、P 行）は最初の . の前を sample、ハプロタイプ 0 とする（11-02。
    # 以前は名前そのままで、GRCh38 の 2,580 本がそれぞれ別のハプロタイプになった）
    f = nm.split("#")
    if len(f) >= 3: return f[0] + "#" + f[1]
    if len(f) == 2: return f[0] + "#0"
    return (nm.split(".", 1)[0] if "." in nm else nm) + "#0"
haps = sorted({hap_of(n) for n in names}); hidx = {h: i for i, h in enumerate(haps)}; H = len(haps); phap = np.array([hidx[hap_of(n)] for n in names])
paths_of = collections.defaultdict(list)
for pi, h in enumerate(phap): paths_of[int(h)].append(pi)
tok = lambda pi: np.asarray(p_tok[p_off[pi]:p_off[pi + 1]])
def seed_from_ref(prefix):
    """種（11-02）: 参照パスのトークンの順位。参照に無いノードは、各パスで直前に通った順位のあるノードの値（先頭は次の値）を前に埋め、パスをまたいだ平均 + 0.5。
    最後に順位へ直す（同点はノード番号順）。古い木の dcol（参照の骨格＋補間の合意列）と同じ考え方を distill だけで作る"""
    refs = [pi for pi, n in enumerate(names) if (n.startswith(prefix) if prefix else pi == 0)]
    # 参照の alt・random・chrUn などの断片は種に使わない（全ゲノム MC の GRCh38 は 2,580 本のうち主な染色体 24 本）。最長の 1% 以上の長さのパスだけ
    if len(refs) > 1:
        rl = np.array([p_off[pi + 1] - p_off[pi] for pi in refs]); refs = [pi for pi, l in zip(refs, rl) if l >= 0.01 * rl.max()]
    if not refs: log(f"種: --seed-ref {prefix!r} に当たるパスが無いので先頭のパス {names[0]} を使う"); refs = [0]
    seed = np.full(N + 1, np.nan); r0 = 0.0; bnd_ = []
    for pi in refs:
        bnd_.append(r0)
        t = tok(pi).astype(np.int64); new_ = np.isnan(seed[t]); u, first = np.unique(t[new_], return_index=True); o = np.argsort(first)
        seed[u[o]] = r0 + np.arange(u.size); r0 += u.size
    ssum = np.zeros(N + 1); scnt = np.zeros(N + 1)
    for pi in range(NP):
        t = tok(pi).astype(np.int64); v = seed[t]; k = ~np.isnan(v)
        if not k.any() or k.all(): continue
        idx = np.where(k, np.arange(t.size), -1); last = np.maximum.accumulate(idx); fst = int(np.flatnonzero(k)[0])
        fill = np.where(last >= 0, v[np.maximum(last, 0)], v[fst]); m = ~k
        tm = t[m].astype(np.int64); _add_at(ssum, tm, fill[m]); _add1_at(scnt, tm)   # 11-02: パスごとにノード数の長さの bincount を足していた（パス数 × ノード数。全ゲノムで 80 分）
    un = np.isnan(seed) & (scnt > 0); seed[un] = ssum[un] / scnt[un] + 0.5
    seed[np.isnan(seed)] = r0 + 1
    rank = np.empty(N + 1, np.int64); rank[np.lexsort((np.arange(N + 1), seed))] = np.arange(N + 1)
    log(f"種: 参照パス {len(refs)} 本（{names[refs[0]]} …）順位 {int(r0):,}、前埋め {int(un.sum()):,}、どのパスも参照に届かない {int((seed == r0 + 1).sum()):,}")
    global seed_bounds; seed_bounds = np.searchsorted(np.sort(seed), np.array(bnd_ + [r0 + 1]), side="left")   # 参照パスごとの種の順位の区切り（大きな塊の並べ直しに使う）
    return rank
seed_bounds = None
if a.seed_synteny:
    con0 = sqlite3.connect("file:%s?mode=ro" % a.seed_synteny, uri=True); dt, n_, b_ = con0.execute("select dtype,n,blob from arrays where name='dcol'").fetchone(); dcol = np.frombuffer(b_, np.dtype(dt)).astype(np.int64); con0.close()
else:
    dcol = seed_from_ref(a.seed_ref)
log(f"ノード {N:,} パス {NP} ハプロタイプ {H}")

# ---- 1. コンティグの関係と出現回数 ----
relation = np.zeros(NP, np.int8)        # 0 普通, 1 丸ごと含まれる（冗長）, 2 端の重なり, 3 内部共有
for h in range(H):
    ps = paths_of[h]
    if len(ps) < 2: continue
    cntc = np.zeros(N + 1, np.int16)
    for pi in ps: cntc[np.unique(tok(pi))] += 1
    for pi in ps:
        t = tok(pi); sh = cntc[t] >= 2
        if not sh.any(): continue
        w = bp[t]; frac = w[sh].sum() / max(1, w.sum()); idx = np.flatnonzero(sh); n = t.size
        if frac >= a.contained: relation[pi] = 1
        elif ((idx < 0.05 * n) | (idx >= 0.95 * n)).all(): relation[pi] = 2
        else: relation[pi] = 3
excl = relation == 1
# 出現回数はハプロタイプごとの「2 回以上出るノード」の一覧（整列済み）だけを持つ（11-02）。以前はノード × ハプロタイプの表 C（uint8）で、
# 全ゲノム 8,142 万ノード × 92 で 7.5 GB、ハプロタイプ数に比例して増えた。使うのは「そのハプロタイプで 1 回だけか / 2 回以上か」と
# ノードごとの数（cnt1: 1 回だけ通るハプロタイプ数、cntm: 2 回以上）だけ。除外したコンティグ（冗長）は数えない
MULTI = [np.zeros(0, np.int64)] * H
cnt1 = np.zeros(N + 1, np.int32); cntm = np.zeros(N + 1, np.int32)
for h in range(H):
    ps = [pi for pi in paths_of[h] if not excl[pi]]
    if not ps: continue
    c_ = np.bincount(np.concatenate([tok(pi) for pi in ps]), minlength=N + 1)
    cnt1 += (c_ == 1); m_ = c_ >= 2; cntm += m_; MULTI[h] = np.flatnonzero(m_)
    del c_, m_
cnt1[0] = cntm[0] = 0
ANYMULTI = cntm > 0   # どれかのハプロタイプで 2 回以上出るノード（ほとんどのトークンはここで落ちるので、二分探索はその分だけ）
def multi(t, h):
    """トークン列 t のうち、ハプロタイプ h で 2 回以上出るノード（元の C[t, h] >= 2）"""
    mh = MULTI[h]; out = np.zeros(t.size, bool)
    if mh.size == 0: return out
    c = np.flatnonzero(ANYMULTI[t])
    if c.size: tc = t[c]; i = np.searchsorted(mh, tc); out[c] = mh[np.minimum(i, mh.size - 1)] == tc
    return out
def once(t, h):
    """ハプロタイプ h で 1 回だけ出るノード（元の C[t, h] == 1。t は除外していないパスのトークン）"""
    return ~multi(t, h)
log(f"冗長コンティグ {int(excl.sum())}（端の重なり {int((relation==2).sum())}、内部共有 {int((relation==3).sum())}）; 候補錨 {int((cnt1>=2).sum()):,}")

# ---- 2. 強い錨の多数決順（順序一貫の選別つき） ----
@njit(cache=True)
def _comp_ins(cs, rr, main):
    """パスの強い錨の並び（成分 cs、順位 rr）で、骨格（main）以外の成分に入る所ごとに (成分, 直前の骨格の順位。無ければその錨の順位)"""
    oc = np.empty(cs.size, np.int64); ov = np.empty(cs.size, np.float64); n = 0; prev_other = -1.0; prev_c = -1
    for k in range(cs.size):
        c = cs[k]
        if c != prev_c:
            if c != main and prev_c >= 0 and prev_c != c:
                oc[n] = c; ov[n] = prev_other if prev_other >= 0 else rr[k]; n += 1
            prev_c = c
        if c == main: prev_other = rr[k]
    return oc[:n], ov[:n]
@njit(cache=True)
def _find_alive(p, by_dcol, done, nxt_alive):
    root = p
    while root < by_dcol.size and done[by_dcol[root]]:
        root = nxt_alive[root + 1] if nxt_alive[root + 1] != root + 1 else root + 1
    q = p
    while q < root:
        nq = nxt_alive[q + 1] if q + 1 < nxt_alive.size else q + 1
        nxt_alive[q] = root; q = nq if nq > q else q + 1
    return root
@njit(cache=True)
def _kahn(snodes, indeg, start, eb, crank, dcol, by_dcol, pos_of, N):
    """Kahn 法（build_order の説明どおり）。ヒープの要素は (成分の順, dcol, ノード)、最前線は (成分の順 × (N+2) + 残りの入次数, dcol, ノード)。
    直前に置いたノードの後続で準備できたもの（local、LIFO・dcol の小さい方を先に）を優先。詰まったら最前線、それも空なら種の順で直前の次"""
    done = np.zeros(N + 1, np.bool_); rank = np.full(N + 1, -1.0); nxt_alive = np.arange(by_dcol.size + 1)
    heap = [(np.int64(0), np.int64(0), np.int64(0))]; heap.pop()
    frontier = [(np.int64(0), np.int64(0), np.int64(0))]; frontier.pop()
    for n in snodes:
        if indeg[n] == 0: heap.append((crank[n], dcol[n], n))
    heapq.heapify(heap)
    r = 0; stalls = 0; far = 0; last = -1; local = [np.int64(0)]; local.pop(); M = np.int64(N + 2)
    while r < snodes.size:
        n = -1
        while len(local) > 0:
            c = local.pop()
            if not done[c] and indeg[c] == 0:
                n = c; break
        while n < 0 and len(heap) > 0:
            it = heapq.heappop(heap); c = it[2]
            if not done[c] and indeg[c] == 0:
                n = c; break
        if n < 0:
            while len(frontier) > 0:
                it = heapq.heappop(frontier); c = it[2]
                if not done[c] and indeg[c] == it[0] % M and crank[c] == it[0] // M:
                    n = c; break
            if n >= 0: stalls += 1
            else:
                p = _find_alive(pos_of[last] + 1 if last >= 0 else 0, by_dcol, done, nxt_alive)
                if p >= by_dcol.size: p = _find_alive(0, by_dcol, done, nxt_alive)
                n = by_dcol[p]; stalls += 1; far += 1
        done[n] = True; rank[n] = r; r += 1; last = n
        local = [np.int64(0)]; local.pop()
        for j in range(start[n], start[n + 1]):
            m = eb[j]
            if done[m]: continue
            indeg[m] -= 1
            if indeg[m] <= 0:
                heapq.heappush(heap, (crank[m], dcol[m], m)); local.append(m)
            else:
                heapq.heappush(frontier, (crank[m] * M + indeg[m], dcol[m], m))
        if len(local) > 1:   # dcol の小さい方を先に（LIFO なので逆順に積む。元の list.sort(key=-dcol) と同じ安定な並べ替え）
            la = np.empty(len(local), np.int64)
            for k in range(len(local)): la[k] = local[k]
            o = np.argsort(-dcol[la], kind="mergesort"); local = [np.int64(0)]; local.pop()
            for k in range(o.size): local.append(la[o[k]])
    return rank, stalls, far
# 隣接する強い錨の組 (a, b) を数える（11-03）。錨ごとに後続の欄を 2 つ持ち、最初に現れた 2 種類の後続はその欄で数える。3 種類目以降だけを
# 溢れの配列に入れ、溢れが一杯になったら並べて足し込む。以前は 500 万組ごとに累計（全ゲノムで 7,000 万組）と連結して並べ直し、全ゲノムの 1 回の
# 走査が 13〜26 分（4 回で 81 分）かかった。数は元と同じ（組ごとの整数の和）
@njit(cache=True)
def _pair_count(s, succ, cnt, ovf, novf, N1):
    for k in range(s.size - 1):
        u = s[k]; v = s[k + 1]
        if succ[u, 0] == v: cnt[u, 0] += 1
        elif succ[u, 0] < 0: succ[u, 0] = v; cnt[u, 0] = 1
        elif succ[u, 1] == v: cnt[u, 1] += 1
        elif succ[u, 1] < 0: succ[u, 1] = v; cnt[u, 1] = 1
        else:
            if novf[0] >= ovf.size: return k   # 溢れが一杯: ここから先は呼び出し側が足し込んでから続ける
            ovf[novf[0]] = u * N1 + v; novf[0] += 1
    return -1
def build_order(strong):
    """コンティグの向きを揃え、隣接する強い錨の組の多数決で有向グラフを作り、トポロジカル順を返す（閉路は dcol の小さい方を先に）"""
    orient = np.ones(NP, np.int8)
    succ = np.full((N + 1, 2), -1, np.int32); cntp = np.zeros((N + 1, 2), np.int32)   # 強い錨は株ごとに 1 回なので組の数はパス数以下
    ovf = np.empty(OVF_BATCH, np.int64); novf = np.zeros(1, np.int64); acc = [np.zeros(0, np.int64), np.zeros(0, np.int64)]
    def fold_ovf():
        n_ = int(novf[0]); novf[0] = 0
        if not n_: return
        k_ = np.sort(ovf[:n_]); b_ = np.flatnonzero(np.concatenate(([True], k_[1:] != k_[:-1]))); u_ = k_[b_]; c_ = np.diff(np.concatenate((b_, [k_.size])))
        if acc[0].size: k2 = np.concatenate((acc[0], u_)); c2 = np.concatenate((acc[1], c_)); o_ = np.argsort(k2, kind="stable"); k2 = k2[o_]; c2 = c2[o_]
        else: k2, c2 = u_, c_
        st_ = np.flatnonzero(np.concatenate(([True], k2[1:] != k2[:-1]))); acc[0] = k2[st_]; acc[1] = np.add.reduceat(c2, st_)
    for pi in range(NP):
        if excl[pi]: continue
        t = tok(pi); h = phap[pi]; m = strong[t] & once(t, h); s_ = t[m].astype(np.int64)
        if s_.size < 2: continue
        if np.mean(np.diff(dcol[s_]) > 0) < 0.5: orient[pi] = -1; s_ = s_[::-1]
        while True:
            k = _pair_count(s_, succ, cntp, ovf, novf, N + 1)
            if k < 0: break
            fold_ovf(); s_ = s_[k:]
    fold_ovf()
    # 欄の組と溢れの組は重ならない（欄が埋まった後の新しい後続だけが溢れる）ので、連結して並べるだけ
    has0 = succ[:, 0] >= 0; has1 = succ[:, 1] >= 0; ar = np.arange(N + 1, dtype=np.int64)
    k_all = np.concatenate((ar[has0] * (N + 1) + succ[has0, 0].astype(np.int64), ar[has1] * (N + 1) + succ[has1, 1].astype(np.int64), acc[0])); c_all = np.concatenate((cntp[has0, 0].astype(np.int64), cntp[has1, 1].astype(np.int64), acc[1]))
    del succ, cntp, ovf; o_ = np.argsort(k_all, kind="stable"); uk = k_all[o_]; cnt = c_all[o_]; del k_all, c_all, o_
    ea = uk // (N + 1); eb = uk % (N + 1); log(f'  [順序] パスの走査と隣接の集計（組 {uk.size:,}）')
    rk = eb * (N + 1) + ea; idx = np.searchsorted(uk, rk); has = (idx < uk.size) & (uk[np.minimum(idx, uk.size - 1)] == rk); crev = np.where(has, cnt[np.minimum(idx, uk.size - 1)], 0)
    keep = (cnt > crev) | ((cnt == crev) & (dcol[ea] < dcol[eb])); ea, eb = ea[keep], eb[keep]; o = np.argsort(ea, kind="stable"); ea, eb = ea[o], eb[o]
    indeg = np.bincount(eb, minlength=N + 1); start = np.searchsorted(ea, np.arange(N + 2)); snodes = np.flatnonzero(strong); rank = np.full(N + 1, -1.0); done = np.zeros(N + 1, bool)
    # Kahn 法。閉路で詰まったら、置いた直後のノードの後続（最前線）のうち残りの入次数が最小のものを強制的に置く（その領域の続きを辿る）。
    # 以前は dcol が最小の残りノードを置いていたので、無関係な領域に飛んで全株の座標が入り乱れた（ecoli50 で 15,000 回）
    # 弱連結成分ごとに順に並べる（染色体＝別成分。成分をまたいで「準備できたノード」を取ると染色体の錨が入り乱れる。ヒト v2 で chr21 の錨が
    # x 370k〜2.75M に散った）。成分の順は種の順序（dcol の最小）
    import scipy.sparse as _sp, scipy.sparse.csgraph as _cg
    g = _sp.coo_matrix((np.ones(ea.size, np.int8), (ea, eb)), shape=(N + 1, N + 1)); ncomp, comp = _cg.connected_components(g, directed=True, connection='weak')
    comp_min = np.full(ncomp, np.iinfo(np.int64).max); np.minimum.at(comp_min, comp[snodes], dcol[snodes]); comp_order = np.argsort(comp_min, kind='stable')
    comp_rank = np.empty(ncomp, np.int64); comp_rank[comp_order] = np.arange(ncomp)
    log('  [順序] 有向グラフ・成分')
    # 最前線も空のとき（別の成分へ移る）: 種の順序（dcol）で「直前に置いたノードの次」から前向きに探す。無ければ先頭から。
    # 以前は dcol 最小の残りを置いていて、ヒトでは 8,000 回も遠くへ飛んだ
    by_dcol = snodes[np.argsort(dcol[snodes], kind="stable")]; pos_of = np.full(N + 1, -1, np.int64); pos_of[by_dcol] = np.arange(by_dcol.size)
    # 11-02: Kahn 法の本体を numba に（_kahn）。Python のヒープで 1 ノードずつだと、ヒト chr20–22 の 244 万錨で 1 回 40 秒、全ゲノムでは 1 回 10 分超
    rank, stalls, far = _kahn(snodes.astype(np.int64), indeg.astype(np.int64), start.astype(np.int64), eb.astype(np.int64), comp_rank[comp].astype(np.int64), dcol.astype(np.int64), by_dcol.astype(np.int64), pos_of, N)
    # 成分の順の修正: 小さな成分（参照に無い島など）は種の dcol が当てにならず末尾に置かれて、全株の途中に「遠い色の片」として現れた。
    # 各成分の挿入位置＝それを持つ株で、成分の最初のノードの直前にある別成分のノードの順位（中央値）。大きい方の成分を骨格にして並べ直す
    comps = sorted(set(comp[snodes].tolist()))
    if len(comps) > 1:
        # 11-02: パスの強い錨を Python で 1 つずつ見ていた所を numba（_comp_ins）に、成分ごとの集計を並べ替え 1 回に（ヒトで 1 回 30 秒超、全ゲノムで成分の数にも比例）
        size_ = np.bincount(comp[snodes]); main = int(np.argmax(size_))
        ic, iv = [], []
        for pi in range(NP):
            if excl[pi]: continue
            t = tok(pi); h = phap[pi]; m = strong[t] & once(t, h); s_ = t[m]
            if s_.size < 2: continue
            if orient[pi] < 0: s_ = s_[::-1]
            c_, v_ = _comp_ins(comp[s_].astype(np.int64), rank[s_], main)
            if c_.size: ic.append(c_); iv.append(v_)
        pos_c = {}
        if ic:
            ic = np.concatenate(ic); iv = np.concatenate(iv); o_ = np.lexsort((iv, ic)); ic = ic[o_]; iv = iv[o_]
            b_ = np.flatnonzero(np.concatenate(([True], ic[1:] != ic[:-1], [True])))
            for k0, k1 in zip(b_[:-1], b_[1:]): pos_c[int(ic[k0])] = float(np.median(iv[k0:k1]))
        cmin = np.full(size_.size, np.inf); _min_at(cmin, comp[snodes].astype(np.int64), rank[snodes])
        for c in comps:
            if c != main and c not in pos_c: pos_c[c] = float(cmin[c])
        # 新しい順位: 骨格の順位軸に、各成分をその挿入位置の直後へ差し込む
        order_nodes = snodes[np.argsort(rank[snodes], kind='stable')]; oc = comp[order_nodes]
        main_nodes = order_nodes[oc == main]; main_rank = rank[main_nodes]
        others = sorted([c for c in comps if c != main], key=lambda c: pos_c[c])
        pieces = []; cut = 0; og_ = np.argsort(oc, kind='stable'); oc_s = oc[og_]   # 成分ごとの錨（順位の順）を一度にまとめる（成分ごとに全錨をなめない）
        for c in others:
            p_ = pos_c[c]; k_ = int(np.searchsorted(main_rank, p_, side='right'))
            g0, g1 = np.searchsorted(oc_s, c, 'left'), np.searchsorted(oc_s, c, 'right')
            pieces.append(main_nodes[cut:k_]); pieces.append(order_nodes[og_[g0:g1]]); cut = k_
        pieces.append(main_nodes[cut:]); new_order = np.concatenate(pieces); rank[new_order] = np.arange(new_order.size, dtype=np.float64)
    return rank, orient, (stalls, far, len(comps)), ea.size

strong = (cnt1 >= max(2, a.support_strong * H)) & (cntm <= a.max_multi * H); strong[0] = False
rank, orient, stalls, nedge = build_order(strong)
log(f"強い錨（1 回目）{int(strong.sum()):,} 辺 {nedge:,} 閉路の詰まり {stalls[0]:,}（最前線が空 {stalls[1]:,}、成分 {stalls[2]:,}）")
# 順序一貫の選別: 向きを揃えた各株の錨の並びで、前後との順位差が「後ろ向き（< -eps）」か「跳び（> J）」になる錨を数え、
# 持つ株の 1/4 以上で起きる錨を外す（ワームホール＝株によって場所が違う、局所の入れ替わり）。株固有の逆位の内側は 1 株だけなので残る。数回繰り返す
wormhole = np.zeros(N + 1, bool)
for it in range(a.rounds):
    njump = np.zeros(N + 1, np.int32); nseen = np.zeros(N + 1, np.int32)
    for pi in range(NP):
        if excl[pi]: continue
        t = tok(pi); h = phap[pi]; m = strong[t] & once(t, h); s_ = t[m]
        if s_.size < 3: continue
        if orient[pi] < 0: s_ = s_[::-1]
        rr = rank[s_]; d = np.diff(rr); bad = (d < -a.eps) | (np.abs(d) > a.J); jp = np.zeros(s_.size, bool); jp[1:] |= bad; jp[:-1] |= bad
        _add_at(njump, s_, jp.astype(np.int32)); _add1_at(nseen, s_)
    drop = strong & (nseen > 0) & (njump > np.maximum(2, a.consist * nseen))
    if not drop.any(): break
    wormhole |= drop; strong &= ~drop
    rank, orient, stalls, nedge = build_order(strong)
    log(f"選別 {it+1} 回目: 外した {int(drop.sum()):,} → 強い錨 {int(strong.sum()):,} 閉路の詰まり {stalls[0]:,}（最前線が空 {stalls[1]:,}、成分 {stalls[2]:,}）")

# ---- 3. 残りの候補を補間で置く（順序一貫の選別） ----
cand = (cnt1 >= 2) & ~strong & (cnt1 >= cntm); cand[0] = False
sum_pos = np.zeros(N + 1); sum_sq = np.zeros(N + 1); npos = np.zeros(N + 1, np.int32); mn = np.full(N + 1, np.inf); mx = np.full(N + 1, -np.inf)
for pi in range(NP):
    if excl[pi]: continue
    t = tok(pi); h = phap[pi]; u = once(t, h); si = np.flatnonzero(strong[t] & u)
    if si.size < 2: continue
    ci = np.flatnonzero(cand[t] & u)
    if ci.size == 0: continue
    j = np.searchsorted(si, ci); j0 = np.clip(j - 1, 0, si.size - 1); j1 = np.clip(j, 0, si.size - 1)
    i0, i1 = si[j0], si[j1]; r0, r1 = rank[t[i0]], rank[t[i1]]
    f = np.where(i1 > i0, (ci - i0) / np.maximum(1, i1 - i0), 0.5); pos = r0 + f * (r1 - r0)
    inside = (ci > si[0]) & (ci < si[-1]); ci, pos = ci[inside], pos[inside]
    nodes = t[ci]; _add_at(sum_pos, nodes, pos); _add_at(sum_sq, nodes, pos * pos); _add1_at(npos, nodes); _min_at(mn, nodes, pos); _max_at(mx, nodes, pos)
placed = npos >= 1; spread = np.where(placed, mx - mn, 0.0); consistent = placed & (spread <= a.tol)
rank[consistent] = sum_pos[consistent] / npos[consistent]
kind = np.zeros(N + 1, np.int8)                 # 0 無, 1 強い錨, 2 補間で置いた錨, 3 場所が株で違う, 4 多重（座標なし）, 5 私有
kind[strong] = 1; kind[consistent] = 2; kind[placed & ~consistent] = 3; kind[wormhole & ~consistent] = 3; kind[(cntm > cnt1) & (cnt1 + cntm > 0)] = 4; kind[(cnt1 == 1) & (cntm == 0)] = 5
hasx = rank >= 0; xs_nodes = np.flatnonzero(hasx); order = xs_nodes[np.argsort(rank[xs_nodes], kind="stable")]; X = np.full(N + 1, -1, np.int64); X[order] = np.arange(order.size); R = order.size
log(f"座標のあるノード {R:,}（強い {int(strong.sum()):,} 補間 {int(consistent.sum()):,}）場所が違う {int((kind==3).sum()):,} 多重 {int((kind==4).sum()):,} 私有 {int((kind==5).sum()):,}")
xbp = np.zeros(R + 1, np.int64); xbp[1:] = np.cumsum(bp[order])     # 座標 → 累積 bp

# ---- 4. 通過 ----
@njit(cache=True)
def segment(xv, eps, J, fold):
    # fold[x // FOLDBIN] が真の座標では、単調性の違反で切らずに（最大/最小を現在値に置き直して）続ける。座標軸の局所的な折り目を株の再編成と誤認しないため
    n = xv.size; cuts = np.empty(n, np.int64); kinds = np.empty(n, np.int8); nc = 0; mx_ = xv[0]; mn_ = xv[0]; inc = True; dec = True
    for i in range(1, n):
        x = xv[i]
        if abs(x - xv[i - 1]) > J:
            cuts[nc] = i; kinds[nc] = 2; nc += 1; mx_ = x; mn_ = x; inc = True; dec = True; continue
        if inc and x < mx_ - eps: inc = False
        if dec and x > mn_ + eps: dec = False
        if not inc and not dec:
            if fold.size > 0 and fold[x // FOLDBIN]:
                mx_ = x; mn_ = x; inc = True; dec = True; continue
            cuts[nc] = i; kinds[nc] = 1; nc += 1; mx_ = x; mn_ = x; inc = True; dec = True; continue
        if x > mx_: mx_ = x
        if x < mn_: mn_ = x
    return cuts[:nc], kinds[:nc]
FOLDBIN = 50
# ---- 3b. 挿入片の置き直し（2026-10-27） ----
# トポロジカル順は、株の大半で「A → B → C（A と C は合意で隣）」と別の場所に挟まっている大きな片 B を、座標の遠い所（環状の末尾など）に置くことがある。
# ecoli50 では x 1,013k–1,046k（錨 3.3 万）が全 50 株で x≈335k の中に挟まっているのに末尾に置かれ、全株の各行の並びで「転座」として現れた。
# 各株の強い錨の通過（錨 >= RELOC_MIN）を作り、A・C の接合が合意で隣（|入口C − 出口A| <= J）なのに B の入口が遠いものを数え、
# B の座標区間で束ねて、それを覆う株の半分以上で起きていれば B を A の出口の直後（中央値）へ移す。向きは株の多数（B が A と逆なら区間を裏返す）。1 回に 1 片、最大 a.reloc_rounds 回
RELOC_MIN = 200; RELOC_MIN_B = 50   # 隣の通過は錨 200 以上、動かす片は 50 以上（ecoli の 497 bp・198 錨の片が 49/50 株で別の場所にあった）
def _reloc_once(X_, minB=RELOC_MIN):
    recs = []; segs_by_hap = {}; nseg = 0
    for pi in range(NP):
        if excl[pi]: continue
        t = tok(pi); h = phap[pi]; use = strong[t] & once(t, h); xs = np.where(use, X_[t], -1); vi = np.flatnonzero(xs >= 0)
        if vi.size < RELOC_MIN: continue
        xv = xs[vi]; cuts, _k = segment(xv, a.eps, a.J, np.zeros(0, np.bool_)); bnd = [0] + [int(c) for c in cuts] + [xv.size]
        big = [(bnd[i], bnd[i + 1]) for i in range(len(bnd) - 1) if bnd[i + 1] - bnd[i] >= minB]; nseg += sum(1 for s_, e_ in big if e_ - s_ >= RELOC_MIN)
        for s_, e_ in big: segs_by_hap.setdefault(int(h), []).append((int(xv[s_:e_].min()), int(xv[s_:e_].max())))
        # 片 B の「x の小さい側の隣」: B を x の昇順に読む向きで直前に来る通過の端（B が順向きなら前の通過 A の出口、逆向きなら次の通過 C の入口）。
        # その点が B から遠い（> 5J）なら、B はその点の直後に挟まっている（株の中では）。ecoli の島は 345,167 の直後（A 順向きの株も、逆向きに読む株も同じ点）
        for j in range(len(big)):
            bs, be = big[j]; bx = xv[bs:be]; lo_, hi_ = int(bx.min()), int(bx.max()); dB = 1 if xv[be - 1] >= xv[bs] else -1
            if dB > 0:
                if j == 0: continue
                ns, ne = big[j - 1]; pnt = int(xv[ne - 1]); dN = 1 if xv[ne - 1] >= xv[ns] else -1
            else:
                if j + 1 >= len(big): continue
                ns, ne = big[j + 1]; pnt = int(xv[ns]); dN = 1 if xv[ne - 1] >= xv[ns] else -1
            if lo_ - 5 * a.J <= pnt <= hi_ + 5 * a.J: continue
            recs.append((lo_, hi_, int(h), pnt + (0.5 if dN > 0 else -0.5), dB * dN))
    if os.environ.get('RELOC_DEBUG'):
        log(f'[reloc] 候補 {len(recs)}'); 
        for r_ in recs[:15]: log(f'  {r_}')
    recs = [r_ for r_ in recs if r_[1] - r_[0] + 1 <= R // 4]   # ゲノムの大半に及ぶ片は束ねる前に除く（小さな片を飲み込んで束が壊れる）
    if os.environ.get('RELOC_DEBUG') and minB < RELOC_MIN:
        for r_ in recs:
            if 140000 <= r_[0] <= 150000: log(f'   rec {r_}')
    if not recs: return None, nseg
    recs.sort(); cl = []
    for r_ in recs:
        if cl and min(cl[-1][1], r_[1]) - max(cl[-1][0], r_[0]) >= 0.5 * min(cl[-1][1] - cl[-1][0], r_[1] - r_[0]): cl[-1][0] = min(cl[-1][0], r_[0]); cl[-1][1] = max(cl[-1][1], r_[1]); cl[-1][2].append(r_)
        else: cl.append([r_[0], r_[1], [r_]])
    cands = []
    for lo, hi, rs in cl:
        # 支持: 新しい場所（A と C の間）に挟まる株の数。対抗: いまの場所の両端のどちらかを通過が切れずにまたぐ株の数（＝いまの置き方を支持する株）。
        # 新しい場所の支持が対抗より多く 3 株以上、片の大きさが座標全体の 1/4 以下のときだけ移す（ゲノムの大半を動かすのは置き直しでなく別の問題）
        insm = float(np.median([r_[3] for r_ in rs])); rs = [r_ for r_ in rs if abs(r_[3] - insm) <= a.J]   # 同じ挿入点の株だけ数える
        sup = len({r_[2] for r_ in rs}); cover = sum(1 for h_, ss in segs_by_hap.items() if any((a_ < lo - 2 and b > lo + 2) or (a_ < hi - 2 and b > hi + 2) for a_, b in ss))
        ins = float(np.median([r_[3] for r_ in rs]))
        if sup >= max(3, 0.2 * H) and sup > cover and hi - lo + 1 <= R // 4 and not (lo - 5 * a.J <= ins <= hi + 5 * a.J):
            carr = sum(1 for h_, ss in segs_by_hap.items() if any(min(hi, b) >= max(lo, a_) for a_, b in ss))   # その片を持つ株
            cands.append((sup, cover, lo, hi, ins, 1 if sum(r_[4] for r_ in rs) >= 0 else -1, carr))
    if os.environ.get('RELOC_DEBUG'):
        for lo, hi, rs in sorted(cl, key=lambda c: -len(c[2]))[:8]: log(f'  cluster x {lo}-{hi} recs {len(rs)} haps {len({r_[2] for r_ in rs})} ins med {np.median([r_[3] for r_ in rs]):.0f} cover {sum(1 for h_, ss in segs_by_hap.items() if any((a_ < lo - 2 and b > lo + 2) or (a_ < hi - 2 and b > hi + 2) for a_, b in ss))} R/4 {R//4}')
    cands.sort(key=lambda c: -(c[0] - c[1])); return cands, nseg
# 置き直しは「全株の通過の数」が減るときだけ採る（環状ゲノムの起点の付け替えのように局所では正しくても全体を悪くする移動を止める）
def _apply(order_, lo, hi, ins, rel):
    blk = order_[lo:hi + 1]; rest = np.concatenate((order_[:lo], order_[hi + 1:])); restx = np.concatenate((np.arange(lo), np.arange(hi + 1, R)))
    k_ = int(np.searchsorted(restx, ins)); return np.concatenate((rest[:k_], blk if rel > 0 else blk[::-1], rest[k_:]))
_done = 0
# 1 段目: 大きな片（錨 >= RELOC_MIN の通過）。全株の大きな通過の数が減る移動だけ採る
cands, nseg_now = _reloc_once(X)
while _done < a.reloc_rounds and cands:
    took = False
    for sup, cover, lo, hi, ins, rel, carr in cands[:1]:   # 最上位の候補だけ試し、減らなければ止める（環状の起点の付け替えに入らない）
        order_prev = order; order = _apply(order, lo, hi, ins, rel); X[order] = np.arange(order.size)
        c2, n2 = _reloc_once(X)
        if n2 < nseg_now:
            _done += 1; log(f"挿入片の置き直し {_done}: x {lo:,}–{hi:,}（錨の座標 {hi-lo+1:,}）を x {ins:,.0f} の直後へ（{sup}/{cover} 株、向き {'同' if rel > 0 else '逆'}）通過 {nseg_now:,} → {n2:,}")
            cands, nseg_now = c2, n2; took = True; break
        order = order_prev; X[order] = np.arange(order.size)
    if not took: break
if os.environ.get('RELOC_DEBUG'):
    _c, _n = _reloc_once(X, RELOC_MIN_B); log(f'[reloc] 段 1 の後の候補 {len(_c)}');
    for c_ in _c[:12]: log(f'   {c_}')
# 2 段目: その片を持つ株の 8 割以上が同じ挿入点に持つ片（合意の置き違い）。株ごとに場所が違う可動因子は動かない。
# 2 つの片が互いの場所に挟まっている（入れ替わり）ときは、2 つとも条件を満たせば入れ替える
def _ok(c): return c[0] >= 0.8 * c[6] and c[0] >= max(3, 0.2 * H) and c[3] - c[2] + 1 <= R // 10   # 座標の 1/10 を超える片（ヒトでは染色体の腕）は動かさない
for _it in range(a.reloc_rounds):
    cands, _n = _reloc_once(X, RELOC_MIN_B); good = [c for c in cands if _ok(c)]
    if not good: break
    c = good[0]; sup, cover, lo, hi, ins, rel, carr = c
    mate = next((d for d in good[1:] if lo - 2 * a.J <= d[4] <= hi + 2 * a.J and d[2] - 2 * a.J <= ins <= d[3] + 2 * a.J), None)
    order = _apply(order, lo, hi, ins, rel); X[order] = np.arange(order.size); _done += 1
    log(f"挿入片の置き直し {_done}（多数一致）: x {lo:,}–{hi:,} を x {ins:,.0f} の直後へ（{sup}/{carr} 株が同じ挿入点）" + ("、相方あり" if mate else ""))
# ---- 3c. 大きな塊を種の順に並べ直す（11-02）: トポロジカル順は成分とつながりだけで決まるので、腕の共有配列で別の染色体とつながると
#   染色体が離れた 2 か所に分かれた（種を参照パスにした chr202122v2 で chr20 の p 腕が先頭、q 腕が chr22 の後ろ）。参照パス（染色体）の単位の塊を
#   参照の順に並べる。参照が 1 本なら何もしない（種の跳びで切って並べると、参照株自身の逆位・転座を全体に押し付けて ecoli50 の座標が細切れになった）
if a.reorder_blocks and seed_bounds is not None and len(seed_bounds) > 2:
    # 塊の単位は「どの参照パス（染色体）の種か」。1 本の参照の中の並び（参照株自身の逆位・転座）は持ち込まない（ecoli で全体が細切れになった）。
    # 錨ごとに種の属する参照パスの番号を付け、同じ番号の連なりを塊にする。小さな連なり（R の 0.5% 未満）は直前の塊に含める。塊は（番号、種の中央値）の順
    sv = dcol[order]; lab = np.searchsorted(seed_bounds, sv, side="right") - 1; MINB = max(1000, int(0.005 * order.size))
    cut_ = np.flatnonzero(np.diff(lab) != 0) + 1; st_ = np.concatenate(([0], cut_)); en_ = np.concatenate((cut_, [order.size]))
    runs = []
    for p_, q_ in zip(st_, en_):
        if runs and (q_ - p_ < MINB or lab[p_] == runs[-1][2]): runs[-1][1] = q_
        else: runs.append([p_, q_, int(lab[p_])])
    key_ = [(r_[2], float(np.median(sv[r_[0]:r_[1]]))) for r_ in runs]; ob = sorted(range(len(runs)), key=lambda i: key_[i])
    order = np.concatenate([order[runs[i][0]:runs[i][1]] for i in ob]); X[order] = np.arange(order.size)
    log(f"大きな塊の並べ直し（参照パスの単位）: 塊 {len(runs)}、並び " + " ".join(f"{runs[i][2]}:{runs[i][1] - runs[i][0]:,}" for i in ob))
xbp = np.zeros(R + 1, np.int64); xbp[1:] = np.cumsum(bp[order])
# 1 パス目: 単調性の違反の着地点を数え、その座標を通る株の半分以上が同じ所で跳ぶなら座標軸の「折り目」とする（2 パス目では切らない）
fold_cnt = np.zeros(R // FOLDBIN + 2, np.int32); cov1 = np.zeros(R + 2, np.int32); seen_fold = {}
for pi in range(NP):
    t = tok(pi); h = phap[pi]; use = (strong[t] if a.seg_anchors == 'strong' else hasx[t]) & (True if a.seg_multi else once(t, h)) & (not excl[pi]); xs = np.where(use, X[t], -1); vi = np.flatnonzero(xs >= 0)
    if vi.size < a.min_anchors: continue
    xv = xs[vi]; cuts, kinds = segment(xv, a.eps, a.J, np.zeros(0, np.bool_))
    cov1[xv.min()] += 1; cov1[xv.max() + 1] -= 1
    for c_, k_ in zip(cuts, kinds):
        if k_ == 1:
            key = (int(h), int(xv[c_]) // FOLDBIN)
            if key not in seen_fold: seen_fold[key] = 1; fold_cnt[key[1]] += 1
cov1 = np.cumsum(cov1)[:R]
fold = np.zeros(R // FOLDBIN + 2, np.bool_)
for b_ in np.flatnonzero(fold_cnt > 0):
    x0_ = b_ * FOLDBIN; c_ = int(cov1[min(R - 1, x0_)])
    if c_ >= 2 and fold_cnt[b_] >= 0.5 * c_: fold[b_] = True
log(f"座標軸の折り目（通る株の半分以上が同じ所で後ろへ跳ぶ）{int(fold.sum()):,} 箇所（{FOLDBIN} 刻み）")
trav = []    # (pid, hap, i0, i1, x0, x1, dir, copy, nanch, bp)
copies = []  # (pid, hap, x0, x1, i0_a, i1_a, i0_b, i1_b) 同じコンティグの 2 つの通過が座標区間で重なる部分（重複の候補）
ends = collections.Counter()   # 座標 → 通過の端の支持（ハプロタイプ数）
breaks_rev = []                # (x, hap) 単調性の違反（後ろ向き）による切断の着地点。多くの株が同じ所で跳ぶ＝順序が線形にならない硬い領域
cov = np.zeros(R + 2, np.int32)
for pi in range(NP):
    t = tok(pi); h = phap[pi]; mult_ok = (True if a.seg_multi else once(t, h)) & (not excl[pi])
    use = (strong[t] if a.seg_anchors == 'strong' else hasx[t]) & mult_ok; xs = np.where(use, X[t], -1); vi = np.flatnonzero(xs >= 0)
    cum = np.concatenate(([0], np.cumsum(bp[t]))); segs = []
    def add_segs(vi_, xv_, cuts_, fill=0):
        st_ = np.concatenate(([0], cuts_)); en_ = np.concatenate((cuts_, [vi_.size]))
        for s0, e0 in zip(st_, en_):
            if e0 - s0 < a.min_anchors: continue
            i0, i1 = int(vi_[s0]), int(vi_[e0 - 1]); x0, x1 = int(xv_[s0:e0].min()), int(xv_[s0:e0].max()); d = int(np.sign(xv_[e0 - 1] - xv_[s0])) or 1
            segs.append([pi, int(h), i0, i1, x0, x1, d, 0, int(e0 - s0), int(cum[i1 + 1] - cum[i0]), int(cum[i0]), fill])   # bp0: コンティグ上の bp オフセット（i0 の開始）、fill: 穴埋めの片
    if vi.size >= a.min_anchors:
        xv = xs[vi]; cuts, kinds = segment(xv, a.eps, a.J, fold)
        for c_, k_ in zip(cuts, kinds):
            if k_ == 1: breaks_rev.append((int(xv[c_]), int(h)))
        add_segs(vi, xv, cuts)
    # 隙間の穴埋め（11-02）: 強い錨の片で覆われないトークンの区間を、補間で置いた錨も使って切り直して片を足す。強い錨の無い区間（両隣の片が座標の跳びで
    #   切れる所）がどの片にも入らず、Traversals の行が抜けた（ecoli50 x 828,098 付近の 9 株、ヒト x 1.64–1.68 M の GRCh38 chr21 など。
    #   tests/trav/check_coverage.py）。全体を補間の錨で切ると ecoli の通過が 4 倍に細切れになった（v10）ので、穴だけに使う。
    #   穴埋めの片（fill=1）は行の表示に使うだけで、コピー番号・境界・被覆（＝ブロックの構造）には入れない（入れるとヒトで境界が 2,199 → 6,460、v11）
    if a.gap_fill and a.seg_anchors == 'strong':
        xa = np.where(hasx[t] & mult_ok, X[t], -1); va = np.flatnonzero(xa >= 0)
        if va.size >= a.min_anchors:
            inside = np.zeros(t.size + 1, np.int32)
            for sg in segs: inside[sg[2]] += 1; inside[sg[3] + 1] -= 1
            inside = np.cumsum(inside)[:t.size] > 0; vg = va[~inside[va]]
            if vg.size >= a.min_anchors:
                ci = np.cumsum(inside)   # 片を 1 つでも挟めば別の穴
                grp = np.flatnonzero(ci[vg[1:]] != ci[vg[:-1]]) + 1
                for g0, g1 in zip(np.concatenate(([0], grp)), np.concatenate((grp, [vg.size]))):
                    if g1 - g0 < a.min_anchors: continue
                    vv = vg[g0:g1]; xg = xa[vv]; cg, _kg = segment(xg, a.eps, a.J, fold); add_segs(vv, xg, cg, 1)
        segs.sort(key=lambda sg: sg[2])
    # コピー番号: 座標区間が 50% 以上重なる通過に、コンティグの中の順で 1, 2, …
    byx = sorted((i for i in range(len(segs)) if not segs[i][11]), key=lambda i: segs[i][4]); groups = []
    for i in byx:
        g = None
        for G in groups:
            ov = min(G[1], segs[i][5]) - max(G[0], segs[i][4])
            if ov >= 0.5 * min(segs[i][5] - segs[i][4], G[1] - G[0]): g = G; break
        if g is None: groups.append([segs[i][4], segs[i][5], [i]])
        else: g[0] = min(g[0], segs[i][4]); g[1] = max(g[1], segs[i][5]); g[2].append(i)
    for G in groups:
        if len(G[2]) >= 2:
            for c, i in enumerate(sorted(G[2], key=lambda i: segs[i][2]), 1): segs[i][7] = c
            mem = sorted(G[2], key=lambda i: segs[i][2])
            for ai in range(len(mem)):
                for bi in range(ai + 1, len(mem)):
                    A_, B_ = segs[mem[ai]], segs[mem[bi]]; xo0, xo1 = max(A_[4], B_[4]), min(A_[5], B_[5])
                    if xo1 - xo0 + 1 < a.min_anchors: continue
                    def span(seg):     # 重なりの座標区間に入る錨のトークン範囲
                        ii = np.arange(seg[2], seg[3] + 1); xx = xs[ii]; sel = ii[(xx >= xo0) & (xx <= xo1)]
                        return (int(sel.min()), int(sel.max())) if sel.size else (seg[2], seg[2])
                    sa, sb = span(A_), span(B_); copies.append((pi, int(h), int(xo0), int(xo1), sa[0], sa[1], sb[0], sb[1], int(cum[sa[1] + 1] - cum[sa[0]]), int(cum[sb[1] + 1] - cum[sb[0]])))
    for sg in segs:
        trav.append(tuple(sg))
        if not sg[11]: ends[sg[4]] += 1; ends[sg[5] + 1] += 1; cov[sg[4]] += 1; cov[sg[5] + 1] -= 1
cov = np.cumsum(cov)[:R]
pt = collections.Counter(t_[1] for t_ in trav if not t_[11]); log(f"通過 {sum(1 for t_ in trav if not t_[11]):,}＋穴埋め {sum(1 for t_ in trav if t_[11]):,}（ハプロタイプあたり中央値 {np.median(list(pt.values())):.0f}、長さ中央値 {np.median([t_[9] for t_ in trav if not t_[11]]):,.0f} bp）コピーの重なり {len(copies):,} 組 {sum(c_[8] for c_ in copies)/1e6:.2f} Mb")

# ---- 5. 境界と持続度の木 ----
dcov = np.diff(np.concatenate(([0], cov))); bpos = np.flatnonzero(dcov != 0); support = np.abs(dcov[bpos])
bsup = collections.Counter()
for x_, s_ in zip(bpos.tolist(), support.tolist()): bsup[x_] = max(bsup[x_], s_)
for x_, s_ in ends.items():
    if 0 < x_ < R: bsup[x_] = max(bsup[x_], s_)
bx = np.array(sorted(x_ for x_ in bsup if 0 < x_ < R), np.int64); bs = np.array([bsup[x_] for x_ in bx], np.int64)
# 床: 幅 < floor_bp の原子は弱い方の境界を先に潰す。持続度 = 潰すときの原子の幅（bp）
edges = np.concatenate(([0], bx, [R])); alive = np.ones(edges.size, bool); alive[0] = alive[-1] = True
persist = np.zeros(edges.size); sup = np.concatenate(([10**9], bs, [10**9]))
prev = np.arange(edges.size) - 1; nxt = np.arange(edges.size) + 1
width = lambda i, j: xbp[edges[j]] - xbp[edges[i]]
hp = [(width(i, i + 1), i) for i in range(edges.size - 1)]; heapq.heapify(hp); removed = 0
while hp:
    w, i = heapq.heappop(hp)
    if not alive[i] or nxt[i] >= edges.size or not alive[nxt[i]] or width(i, nxt[i]) != w: continue
    j = nxt[i]
    if i == 0 and j == edges.size - 1: break
    # 原子 [i, j]: 弱い側の境界を潰す（端は潰さない）
    cands = [q for q in (i, j) if 0 < q < edges.size - 1]
    if not cands: break
    q = min(cands, key=lambda q: (sup[q], -w)); persist[q] = w; alive[q] = False; removed += 1
    pq, nq = prev[q], nxt[q]; nxt[pq] = nq; prev[nq] = pq
    heapq.heappush(hp, (width(pq, nq), pq))
persist[0] = persist[-1] = xbp[R] * 2
log(f"境界 {bx.size:,}（被覆の変化 {bpos.size:,}、通過の端 {len(ends):,}）潰した {removed:,}")

# 原子: 持続度 >= floor_bp の境界で切る。各原子の bp と、通るハプロタイプ数（被覆の中央値）
keepb = [q for q in range(edges.size) if q == 0 or q == edges.size - 1 or persist[q] >= a.floor_bp]
atoms = []
brx = np.array([b_[0] for b_ in breaks_rev], np.int64) if breaks_rev else np.zeros(0, np.int64); brh = np.array([b_[1] for b_ in breaks_rev], np.int64) if breaks_rev else np.zeros(0, np.int64); o_ = np.argsort(brx); brx, brh = brx[o_], brh[o_]
for q0, q1 in zip(keepb, keepb[1:]):
    x0, x1 = int(edges[q0]), int(edges[q1]); lo_, hi_ = np.searchsorted(brx, x0), np.searchsorted(brx, x1)
    ntangle = int(np.unique(brh[lo_:hi_]).size)     # この原子の中に単調性の違反の切断を持つハプロタイプ数
    atoms.append((x0, x1, int(xbp[x1] - xbp[x0]), int(np.median(cov[x0:x1])) if x1 > x0 else 0, ntangle))
log(f"原子（持続度 >= {a.floor_bp} bp）{len(atoms):,}")

# ---- 6. 反復（出現単位） ----
reps = []
for pi in range(NP):
    if excl[pi]: continue
    t = tok(pi); h = phap[pi]; m = multi(t, h)
    if not m.any(): continue
    e = np.diff(np.concatenate(([0], m.view(np.int8), [0]))); st = np.flatnonzero(e == 1); en = np.flatnonzero(e == -1); cum = np.concatenate(([0], np.cumsum(bp[t])))
    ms, me = [int(st[0])], [int(en[0])]
    for s_, e_ in zip(st[1:], en[1:]):
        if s_ - me[-1] <= a.rep_gap and cum[s_] - cum[me[-1]] <= a.rep_gap_bp: me[-1] = int(e_)
        else: ms.append(int(s_)); me.append(int(e_))
    for s_, e_ in zip(ms, me):
        if cum[e_] - cum[s_] >= a.rep_min_bp: reps.append((pi, int(h), s_, e_, int(cum[e_] - cum[s_])))
log(f"反復の連なり {len(reps):,}")

# ---- 出力 ----
if os.path.exists(a.out): os.remove(a.out)
con = sqlite3.connect(a.out); cur = con.cursor()
cur.executescript("""
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE haps(hid INTEGER PRIMARY KEY, hap TEXT);
CREATE TABLE paths(pid INTEGER PRIMARY KEY, path TEXT, hid INTEGER, orient INTEGER, relation INTEGER, excluded INTEGER, ntok INTEGER, bp INTEGER);
CREATE TABLE nodes(dense INTEGER PRIMARY KEY, x INTEGER, kind INTEGER, nuniq INTEGER, nmulti INTEGER, spread REAL);
CREATE TABLE trav(id INTEGER PRIMARY KEY, pid INTEGER, hid INTEGER, i0 INTEGER, i1 INTEGER, x0 INTEGER, x1 INTEGER, dir INTEGER, copy INTEGER, nanch INTEGER, bp INTEGER, bp0 INTEGER, fill INTEGER DEFAULT 0);
CREATE INDEX idx_trav_x ON trav(x0, x1); CREATE INDEX idx_trav_pid ON trav(pid, i0);
CREATE TABLE bounds(x INTEGER PRIMARY KEY, support INTEGER, persistence REAL);
CREATE TABLE reps(id INTEGER PRIMARY KEY, pid INTEGER, hid INTEGER, i0 INTEGER, i1 INTEGER, bp INTEGER);
CREATE TABLE copies(id INTEGER PRIMARY KEY, pid INTEGER, hid INTEGER, x0 INTEGER, x1 INTEGER, ia0 INTEGER, ia1 INTEGER, ib0 INTEGER, ib1 INTEGER, bpa INTEGER, bpb INTEGER);
CREATE TABLE atoms(id INTEGER PRIMARY KEY, x0 INTEGER, x1 INTEGER, bp INTEGER, nhap INTEGER, ntangle INTEGER);
CREATE TABLE arrays(name TEXT PRIMARY KEY, dtype TEXT, n INTEGER, blob BLOB);
""")
cur.executemany("INSERT INTO haps VALUES (?,?)", list(enumerate(haps)))
cur.executemany("INSERT INTO paths VALUES (?,?,?,?,?,?,?,?)", [(pi, names[pi], int(phap[pi]), int(orient[pi]), int(relation[pi]), int(excl[pi]), int(p_off[pi + 1] - p_off[pi]), int(bp[tok(pi)].sum())) for pi in range(NP)])
nz = np.flatnonzero((kind > 0)); cur.executemany("INSERT INTO nodes VALUES (?,?,?,?,?,?)", [(int(n), int(X[n]), int(kind[n]), int(cnt1[n]), int(cntm[n]), float(spread[n])) for n in nz])
cur.executemany("INSERT INTO trav VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?)", trav)
cur.executemany("INSERT INTO bounds VALUES (?,?,?)", [(int(edges[q]), int(sup[q]) if sup[q] < 10**9 else 0, float(persist[q])) for q in range(edges.size)])
cur.executemany("INSERT INTO reps VALUES (NULL,?,?,?,?,?)", reps); cur.executemany("INSERT INTO copies VALUES (NULL,?,?,?,?,?,?,?,?,?,?)", copies); cur.executemany("INSERT INTO atoms VALUES (NULL,?,?,?,?,?)", atoms)
for nm, arr in (("x_of_dense", X.astype(np.int32)), ("dense_of_x", order.astype(np.int32)), ("xbp", xbp), ("cov", cov.astype(np.int32)), ("kind", kind), ("id_map", id_map)):
    put_array(cur, nm, arr)   # 256 MiB ごとの行に分ける（trav_arrays.py。viewer は 1 値 537 MB までしか読めない）
meta = dict(version=4, nfold=int(fold.sum()), N=N, H=H, NP=NP, R=R, params=vars(a), strong=int(strong.sum()), interp=int(consistent.sum()), inconsistent=int((kind == 3).sum()), ntrav=len(trav), nbounds=int(bx.size), nreps=len(reps), ncopies=len(copies), natoms=len(atoms), built=time.strftime("%Y-%m-%d %H:%M"))
cur.executemany("INSERT INTO meta VALUES (?,?)", [(k_, json.dumps(v_, ensure_ascii=False)) for k_, v_ in meta.items()]); con.commit(); con.close()
log(f"→ {a.out} ({os.path.getsize(a.out)/1e6:.0f} MB)")
