#!/usr/bin/env python3
"""共線ブロック MSA の逐次計算ワーカー（backend の blocksWorker.ts が DB ごとに 1 本 spawn して常駐させる）。

  python3 worker.py --db X.db --distill X.db.distill [--blocks X.db.blocks.json]

stdin に 1 行 1 要求の JSON、stdout に 1 行 1 応答の JSON。ログは stderr。
  {"id":1,"op":"warm"}                         → Ctx（アトラス＋distill の読み込み・合意順序）を作って温める
  {"id":2,"op":"window","ranges":[[path,s0,e0],...],"span":<bp>,"afrac":0.5,"label":"#4","depth":1}
                                               → 窓 1 個を計算して {"id":2,"ok":true,"window":{...},"ms":...}
  {"id":3,"op":"nodemap","layer":L,"names":[...]}   → 各ノードが属する全体窓・最細段のブロック番号（-1=不明）
                                                葉は合意列の位置から、スーパーノードは配下の葉の多数決（層ごとに 1 回計算して記憶）
  {"id":4,"op":"ping"} / {"op":"quit"}
Ctx は最初に必要になった時に作る（chrY 10 s / ecoli50 40 s 級）。以後の窓は 1 秒以内が目安。
パラメタ（錨の出現割合・併合上限・ビン数・環状・順序の基準）は事前計算のサイドカー meta から取り、無ければ既定値。
"""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from hier import Ctx, compute_window, DEFAULT_PARAMS, log   # noqa: E402

def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n"); sys.stdout.flush()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True); ap.add_argument("--distill", required=True); ap.add_argument("--blocks", default="")
    a = ap.parse_args()
    meta = {}; tree = None
    bp = a.blocks or (a.db + ".blocks.json")
    if os.path.exists(bp):
        try:
            with open(bp) as f:
                side = json.load(f); meta = side.get("meta", {}) or {}; tree = side.get("tree")   # 系統樹は枝ごとの獲得/喪失（Fitch）に使う
        except Exception as e:
            log("worker: サイドカー meta を読めない (%s): %s" % (bp, e))
    P = dict(DEFAULT_PARAMS); P.update(meta.get("params", {}) or {})
    circular = bool(meta.get("circular", False)); order_arg = meta.get("order_arg", "ref"); ref_arg = meta.get("ref_arg", "")
    state = dict(ctx=None, name2pi=None, warm_ms=None, leaf_rank=None, maj={}, side_windows=None)
    side_root = None
    if os.path.exists(bp):
        try:
            with open(bp) as f: side_root = json.load(f).get("windows", [None])[0]
        except Exception: side_root = None

    def leaf_ranks():
        """葉（V 番号）→ 全体窓・最細段のブロック番号。サイドカーの根の窓のブロック名（c0 列の名前）を合意列に写し、
        列 c のブロック＝c0 ≤ c を満たす最後のブロック（構築器の encl と同じ）。サイドカーが無ければ None"""
        if state["leaf_rank"] is not None: return state["leaf_rank"]
        ctx = ensure_ctx()
        if not side_root: return None
        L0 = side_root["levels"][0]; name2col = {nm: i for i, nm in enumerate(ctx.colname)}
        c0 = []
        for b in L0["blocks"]:
            nm = b["name"].split("…")[0]; c = name2col.get(nm)
            c0.append(c if c is not None else -1)
        c0 = np.array(c0, np.int64); order = np.argsort(c0); c0s = c0[order]
        colrank = (np.searchsorted(c0s, np.arange(ctx.ncols), side="right") - 1)
        colrank = order[np.maximum(colrank, 0)].astype(np.int32)           # 列 → ブロック番号（先頭より前は #1）
        lr = np.full(ctx.at.V, -1, np.int32); lv = ctx.at.leaf_v; col_of = ctx.col[lv]
        ok = col_of >= 0; lr[lv[ok]] = colrank[col_of[ok]]
        state["leaf_rank"] = lr; return lr

    def majority_for_layer(L):
        """層 L のノード（V 番号）→ 配下の葉のブロック番号の多数決（bp 加重）"""
        if L in state["maj"]: return state["maj"][L]
        ctx = ensure_ctx(); at = ctx.at; lr = leaf_ranks()
        if lr is None: state["maj"][L] = {}; return {}
        if L not in at.anc:
            cur = np.arange(at.V, dtype=np.int64)
            for _ in range(300):
                nxt = np.where(at.inL[L, cur], cur, at.parent[cur])
                if np.array_equal(nxt, cur): break
                cur = nxt
            at.anc[L] = cur
        lv = at.leaf_v; a = at.anc[L][lv]; r = lr[lv]; w = at.leaf_bp[lv].astype(np.float64)
        ok = r >= 0; a, r, w = a[ok], r[ok], w[ok]
        key = a.astype(np.int64) * (int(r.max()) + 2) + r
        uk, inv = np.unique(key, return_inverse=True); ws = np.bincount(inv, weights=w)
        ua = uk // (int(r.max()) + 2); ur = uk % (int(r.max()) + 2)
        best = {}
        for anc_v, rk, wt in zip(ua.tolist(), ur.tolist(), ws.tolist()):
            if anc_v not in best or wt > best[anc_v][1]: best[anc_v] = (rk, wt)
        m = {int(k): int(v[0]) for k, v in best.items()}
        state["maj"][L] = m; return m
    emit(dict(ev="hello", db=os.path.basename(a.db), params=P, circular=circular))

    def ensure_ctx():
        if state["ctx"] is None:
            t0 = time.time(); ctx = Ctx(a.db, a.distill, order_arg, ref_arg, circular)
            state["ctx"] = ctx; state["name2pi"] = {ctx.at.p_names[pi]: pi for pi in ctx.present}
            # numba の JIT（主鎖の LIS）もここで済ませる。初回の窓で払うと 10〜20 s（別 CPU の計算ノードでは
            # キャッシュが効かず再コンパイルになる）が「計算中…」に乗る
            try:
                from hier import _seg_lis
                _seg_lis(np.arange(4, dtype=np.float64), np.ones(4), np.arange(5), 0.5, 0.0)
            except Exception as e:
                log("worker: JIT warm-up failed (%s)" % e)
            state["warm_ms"] = int((time.time() - t0) * 1000)
            log("worker: Ctx ready %.1fs (列 %d, パス %d)" % (time.time() - t0, ctx.ncols, len(ctx.present)))
        return state["ctx"]

    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: req = json.loads(line)
        except Exception as e: emit(dict(id=None, ok=False, error="bad json: %s" % e)); continue
        rid = req.get("id"); op = req.get("op")
        t0 = time.time()
        try:
            if op == "quit": emit(dict(id=rid, ok=True)); break
            if op == "ping": emit(dict(id=rid, ok=True, ready=state["ctx"] is not None)); continue
            if op == "warm":
                ensure_ctx(); emit(dict(id=rid, ok=True, warm_ms=state["warm_ms"], ms=int((time.time() - t0) * 1000))); continue
            if op == "nodemap":
                ctx = ensure_ctx(); L = int(req.get("layer", ctx.at.maxlayer)); names = req.get("names") or []
                lr = leaf_ranks()
                if lr is None: emit(dict(id=rid, ok=False, error="サイドカー（根の窓）が無いので対応を作れません")); continue
                m = majority_for_layer(L); nm2v = ctx.at.names; out = []
                for nm in names:
                    v = nm2v.get(str(nm))
                    if v is None: out.append(-1); continue
                    rk = int(lr[v]) if ctx.at.kind[v] == 0 else m.get(int(v), -1)
                    out.append(rk)
                emit(dict(id=rid, ok=True, ranks=out, nblocks=len(side_root["levels"][0]["blocks"]) if side_root else 0, ms=int((time.time() - t0) * 1000))); continue
            if op == "window":
                ctx = ensure_ctx(); n2p = state["name2pi"]
                ranges = []; missing = 0
                for r in req.get("ranges", []):
                    pi = n2p.get(str(r[0]))
                    if pi is None: missing += 1; continue
                    s0, e0 = int(r[1]), int(r[2]); n = len(ctx.seqs[pi][0])
                    s0 = max(0, min(n, s0)); e0 = max(s0, min(n, e0))
                    if e0 > s0: ranges.append((pi, s0, e0))
                if not ranges: emit(dict(id=rid, ok=False, error="範囲が空（パス名が一致しない: %d 件）" % missing)); continue
                span = int(req.get("span") or 0)
                if span <= 0: span = int(sum(int(ctx.seqs[pi][2][s0:e0].sum()) for pi, s0, e0 in ranges) / max(1, len(ranges)))
                afrac = float(req.get("afrac") or P["sub_anchor_frac"])
                res = compute_window(ctx, ranges, span, afrac, P, tag=str(req.get("label", "")), tree=tree)
                if res is None: emit(dict(id=rid, ok=False, error="この範囲では錨が取れず、ブロックになりません")); continue
                win = dict(id=-1, parent=int(req.get("parent", -1)), pblock=int(req.get("pblock", -1)), depth=int(req.get("depth", 0)),
                           label=str(req.get("label", "")), atoms=res["atoms"], H=res["H"], levels=res["levels"], children={},
                           mode=res["mode"], ondemand=True, note=res["note"])
                emit(dict(id=rid, ok=True, window=win, ms=int((time.time() - t0) * 1000), missing=missing)); continue
            emit(dict(id=rid, ok=False, error="unknown op %r" % op))
        except Exception as e:
            import traceback; traceback.print_exc(file=sys.stderr)
            emit(dict(id=rid, ok=False, error="%s: %s" % (type(e).__name__, e)))

if __name__ == "__main__":
    main()
