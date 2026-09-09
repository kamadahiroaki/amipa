#!/usr/bin/env python3
"""povu decompose をグラフの分割ごとに走らせ、メモリを「分割の大きさ」に抑える。

povu のメモリはグラフのノード数に対しておよそ 18〜37 KB/ノード（chr22 で 110 GB 級、chr1 で 384 GB 超）。povu は連結成分ごとに
処理するので WG では最大成分（chr1）が上限だったが、変換で chr1 が大きくなると溢れる。そこで参照パス上の**関節点**（取り除くと
グラフが分かれるノード）を選んで切り、切片ごとに povu を掛ける。関節点を内部に含むバブルは存在しないので（あればその
ノードが境界になる）、切片ごとの flubble 木を並べたものは全体の木と一致する。切片をまたぐ入れ子の外側 1 段だけが
2 つの最上位 flubble に分かれる。lod.py は複数の pvst を受けるので、出力ディレクトリをそのまま渡せる。

usage: povu_split.py --gfa dense.gfa --ref <prefix> --out pvst_dir [--target 500000] [--jobs 8] [--povu povu] [--threads 2]"""
import sys, os, argparse, subprocess, time, shutil
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from numba import njit

T0 = time.time()
def log(m): print(f"[povu_split {time.time()-T0:7.1f}s] {m}", file=sys.stderr, flush=True)

@njit(cache=True)
def articulation_points(indptr, indices, n):
    """無向グラフの関節点（反復版 Tarjan）。多重辺・自己ループは無視する。"""
    disc = np.full(n, -1, np.int64); low = np.zeros(n, np.int64); parent = np.full(n, -1, np.int64)
    is_ap = np.zeros(n, np.bool_); it = np.zeros(n, np.int64)         # it[v] = 次に見る隣接の位置
    stack = np.empty(n, np.int64); t = 0
    for root in range(n):
        if disc[root] >= 0: continue
        sp = 0; stack[sp] = root; sp += 1; disc[root] = t; low[root] = t; t += 1; it[root] = indptr[root]; nchild = 0
        while sp > 0:
            v = stack[sp - 1]
            if it[v] < indptr[v + 1]:
                w = indices[it[v]]; it[v] += 1
                if w == v: continue
                if disc[w] < 0:
                    parent[w] = v; disc[w] = t; low[w] = t; t += 1; it[w] = indptr[w]
                    stack[sp] = w; sp += 1
                    if v == root: nchild += 1
                elif w != parent[v]:
                    if disc[w] < low[v]: low[v] = disc[w]
            else:
                sp -= 1
                p = parent[v]
                if p >= 0:
                    if low[v] < low[p]: low[p] = low[v]
                    if p != root and low[v] >= disc[p]: is_ap[p] = True
        if nchild >= 2: is_ap[root] = True
    return is_ap

@njit(cache=True)
def label_pieces(indptr, indices, n, is_cut):
    """切断ノードを除いた無向グラフの連結成分番号（切断ノードは -1）。"""
    lab = np.full(n, -1, np.int64); q = np.empty(n, np.int64); c = 0
    for s in range(n):
        if is_cut[s] or lab[s] >= 0: continue
        lab[s] = c; q[0] = s; h = 0; tl = 1
        while h < tl:
            v = q[h]; h += 1
            for k in range(indptr[v], indptr[v + 1]):
                w = indices[k]
                if is_cut[w] or lab[w] >= 0: continue
                lab[w] = c; q[tl] = w; tl += 1
        c += 1
    return lab, c

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gfa", required=True); ap.add_argument("--ref", required=True, help="参照パス名の接頭辞（切断候補はこのパス上の関節点）")
    ap.add_argument("--out", required=True, help="pvst の出力ディレクトリ"); ap.add_argument("--target", type=int, default=500000, help="切片の目標ノード数")
    ap.add_argument("--jobs", type=int, default=8, help="同時に走らせる povu の数"); ap.add_argument("--threads", type=int, default=2, help="povu 1 本あたりのスレッド")
    ap.add_argument("--povu", default=os.environ.get("AMIPA_POVU", "povu")); ap.add_argument("--tmp", default=None, help="切片 GFA の置き場（既定 out の下）")
    ap.add_argument("--keep", action="store_true", help="切片 GFA を消さない")
    a = ap.parse_args()
    # ---- GFA 読み（S: id と配列行の位置、L: 辺、P: 参照だけ）
    ids = []; seq_lines = []; ea = []; eb = []; L_lines = []; ref_steps = None
    with open(a.gfa, "rb") as f:
        for ln in f:
            c = ln[0]
            if c == 83: p = ln.split(b"\t", 3); ids.append(int(p[1])); seq_lines.append(ln)
            elif c == 76: p = ln.split(b"\t"); ea.append(int(p[1])); eb.append(int(p[3])); L_lines.append(ln)
            elif c == 80 and ref_steps is None:
                p = ln.split(b"\t", 3)
                if p[1].decode().startswith(a.ref):
                    ref_steps = np.array([int(x[:-1]) for x in p[2].decode().split(",")], np.int64)
    if ref_steps is None: sys.exit(f"参照パス {a.ref} が無い")
    ids = np.array(ids, np.int64); n = ids.size; mx = int(ids.max()); id2row = np.full(mx + 1, -1, np.int64); id2row[ids] = np.arange(n)
    ea = id2row[np.array(ea, np.int64)]; eb = id2row[np.array(eb, np.int64)]
    log(f"ノード {n:,} 辺 {ea.size:,} 参照ステップ {ref_steps.size:,}")
    # 無向 CSR
    src = np.concatenate([ea, eb]); dst = np.concatenate([eb, ea]); o = np.argsort(src, kind="stable")
    indptr = np.zeros(n + 1, np.int64); np.add.at(indptr, src + 1, 1); np.cumsum(indptr, out=indptr); indices = dst[o]
    is_ap = articulation_points(indptr, indices, n)
    rref = id2row[ref_steps]; ap_on_ref = is_ap[rref]
    log(f"関節点 {int(is_ap.sum()):,}（参照上 {int(ap_on_ref.sum()):,} / {rref.size:,} ステップ）")
    # ---- 切断ノードの選択: 参照上の関節点を、間のノード数が target になるよう選ぶ（参照ステップ数で近似し、切片の大きさで確認）
    cand = np.flatnonzero(ap_on_ref)
    est_per_step = n / max(rref.size, 1)                           # 参照 1 ステップあたりの全ノード数（大まかな換算）
    stride = max(1, int(a.target / est_per_step))
    chosen = []; last = -stride
    for k in cand.tolist():
        if k - last >= stride: chosen.append(rref[k]); last = k
    is_cut = np.zeros(n, bool); is_cut[np.array(chosen, np.int64)] = True if chosen else False
    lab, npiece = label_pieces(indptr, indices, n, is_cut)
    sizes = np.bincount(lab[lab >= 0], minlength=npiece)
    log(f"切断ノード {len(chosen):,} → 切片 {npiece:,}（ノード数 最大 {sizes.max():,} 中央 {int(np.median(sizes)):,} / 1 ノードだけの切片 {int((sizes==1).sum()):,}）")
    # 小さすぎる切片（孤立した私有片など）は隣の切片へ寄せず、そのまま povu に掛ける（povu は成分ごとに処理するので問題ない）。
    # 切断ノードは、隣接する全切片に境界として複製する。
    cut_rows = np.flatnonzero(is_cut)
    piece_of_cut = {}                                              # cut row → set(piece)
    for v in cut_rows.tolist():
        ps = set()
        for k in range(indptr[v], indptr[v + 1]):
            w = indices[k]
            if lab[w] >= 0: ps.add(int(lab[w]))
        piece_of_cut[v] = ps
    # 辺の切片: 両端が同じ切片 / 片方が切断ノード → その切断ノードが接する側の切片 / 両方切断ノード → 両者が共有する切片（無ければ最初の切片）
    la = lab[ea]; lb = lab[eb]
    edge_piece = np.where(la >= 0, la, lb)
    both_cut = (la < 0) & (lb < 0)
    for e in np.flatnonzero(both_cut).tolist():
        s1 = piece_of_cut.get(int(ea[e]), set()); s2 = piece_of_cut.get(int(eb[e]), set()); s = s1 & s2
        edge_piece[e] = min(s) if s else (min(s1) if s1 else (min(s2) if s2 else 0))
    # ---- 切片 GFA を書く
    tmp = a.tmp or os.path.join(a.out, "_pieces"); os.makedirs(tmp, exist_ok=True); os.makedirs(a.out, exist_ok=True)
    order_nodes = np.argsort(lab, kind="stable"); node_piece_sorted = lab[order_nodes]
    starts = np.searchsorted(node_piece_sorted, np.arange(npiece + 1))
    order_edges = np.argsort(edge_piece, kind="stable"); ep_sorted = edge_piece[order_edges]
    estarts = np.searchsorted(ep_sorted, np.arange(npiece + 1))
    cut_by_piece = {}
    for v, ps in piece_of_cut.items():
        for p in ps: cut_by_piece.setdefault(p, []).append(v)
    files = []
    for p in range(npiece):
        nodes_p = order_nodes[starts[p]:starts[p + 1]]
        if nodes_p.size == 0: continue
        fn = os.path.join(tmp, f"piece{p:05d}.gfa")
        with open(fn, "wb") as w:
            w.write(b"H\tVN:Z:1.0\n")
            for r in nodes_p.tolist(): w.write(seq_lines[r])
            for r in cut_by_piece.get(p, []): w.write(seq_lines[r])
            for e in order_edges[estarts[p]:estarts[p + 1]].tolist(): w.write(L_lines[e])
        files.append((p, fn, int(nodes_p.size) + len(cut_by_piece.get(p, []))))
    log(f"切片 GFA {len(files):,} 本 -> {tmp}")
    # ---- povu を切片ごとに（大きい順に並列）
    files.sort(key=lambda x: -x[2])
    def run(item):
        p, fn, sz = item; od = os.path.join(tmp, f"pv{p:05d}"); os.makedirs(od, exist_ok=True)
        r = subprocess.run([a.povu, "-v", "0", "-t", str(a.threads), "decompose", "-i", fn, "-o", od], capture_output=True, text=True)
        if r.returncode != 0: return (p, sz, None, r.stderr[-300:])
        outs = sorted(x for x in os.listdir(od) if x.endswith(".pvst"))
        for j, x in enumerate(outs): shutil.move(os.path.join(od, x), os.path.join(a.out, f"piece{p:05d}_{j}.pvst"))
        return (p, sz, len(outs), None)
    n_ok = 0; n_pvst = 0
    with ThreadPoolExecutor(max_workers=a.jobs) as ex:
        for p, sz, k, err in ex.map(run, files):
            if k is None: log(f"★ povu 失敗 切片 {p}（ノード {sz:,}）: {err}")
            else: n_ok += 1; n_pvst += k
    log(f"povu 完了 {n_ok}/{len(files)} 切片、pvst {n_pvst:,} 本 -> {a.out}")
    if not a.keep: shutil.rmtree(tmp, ignore_errors=True)
    if n_ok != len(files): sys.exit("★ povu が失敗した切片がある")

if __name__ == "__main__": main()
