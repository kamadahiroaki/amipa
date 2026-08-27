#!/usr/bin/env python3
"""タイル順(Z-order)サイドカー `<db>.tiled` を作る。viewer の描画用ノード/エッジ取得を R-Tree から置き換える。

== なぜ ==
R-Tree の矩形検索は木を降りて探すので cold で 80〜100 ページのランダム読み（WG で 1〜4 秒）。
エッジは可視ノード 1 個ごとに TEXT 索引を 2 回 probe する O(V) 方式で、warm でも重い。
本サイドカーは
  ・層ごとに格子指数 g_L = round(log2(K_TILES*layer_zoom[L]/W))（viewer のタイルキャッシュと同式・同格子）
  ・ノードを中心タイルの Morton キーで (layer, mkey) 順に **WITHOUT ROWID（clustered）** へ格納
  ・エッジは両端点それぞれのタイルで 1 行（side 0=source, 1=target）。その端点の座標/半径 (ex,ey,er) を
     持ち、viewer 側は「端点が viewport に重なる辺」だけを SQL で選べる（R-Tree 経路と同じ意味）。
     ★座標を持たずタイルだけで選ぶと、viewport の外側 1 タイルの環にある密な領域の辺まで全部返して
       しまい、実測で 4〜12 倍の余分な行を転送した（chr22 L10）。端点座標は 24B/行で、この無駄を消す
矩形 → Z-order の連続範囲（quadtree 分解、数十本）→ 各範囲は 1 回の索引降下＋順次スキャン。
実測(2026-08-26, WG PGGB 313GB, cold): 合計 2.4〜8x、最遅 viewport 2.8〜17x、warm でも 3x。

== 注意 ==
・新規ファイルなので物理連続（主 DB の freelist に左右されない）。プリウォームは順読み 44GB ≒ 25 秒
・viewer 側は範囲表を CTE で渡し **CROSS JOIN** で結合順を固定すること（範囲 20 本超で planner が
  層全体走査に落ちる。EQP で確認済み）
・hap 絞り込みのマスク語 hm0..hm{W-1} と hb は R-Tree（または <db>.hapidx）から写す
・v3.3: edges_t に辺の hb（edge_contig_cov.hb）と葉層のリード支持 rs（<db>.reads の edge_read_support、
  または旧式の edges.read_support 列）を焼き込む。viewer が Paths 幅 / Reads 幅のたびに主 DB・.reads を
  辺ごとに join していた（WG 葉層 cold で hb 0.4〜1.2 秒、rs 12〜17 秒＝1 辺 20ms のシーク）のを無くす

使い方: tile_index.py <name>.db [--out <path>] [--force]
"""
import argparse, json, os, sqlite3, struct, sys, time
import numpy as np

K_TILES = 2.5
CHUNK = 2_000_000
SENT = -(1 << 62)
SCHEMA = "tiled-v3.3"


def log(t0, m): print(f"[tile-index {time.time()-t0:7.1f}s] {m}", flush=True)


def part1by1(v):
    v = v.astype(np.uint64) & np.uint64(0xffffffff)
    for sh, mk in ((16, 0x0000FFFF0000FFFF), (8, 0x00FF00FF00FF00FF), (4, 0x0F0F0F0F0F0F0F0F),
                   (2, 0x3333333333333333), (1, 0x5555555555555555)):
        v = (v | (v << np.uint64(sh))) & np.uint64(mk)
    return v


def morton(tx, ty): return (part1by1(tx) | (part1by1(ty) << np.uint64(1))).astype(np.int64)


def nz(v): return None if v == SENT else int(v)


def world_from_rtree(con):
    buf = con.execute("SELECT data FROM nodes_rtree_node WHERE nodeno=1").fetchone()[0]
    n = int.from_bytes(buf[2:4], "big"); x0 = y0 = 1e9; x1 = y1 = -1e9
    for i in range(n):
        b = 4 + i * 32
        mnx, mxx, mny, mxy = struct.unpack(">ffff", buf[b+8:b+24])
        x0, x1, y0, y1 = min(x0, mnx), max(x1, mxx), min(y0, mny), max(y1, mxy)
    return x0, x1, y0, y1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--out", default=None, help="既定 <db>.tiled")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--k-tiles", type=float, default=K_TILES)
    a = ap.parse_args()
    out = a.out or (a.db + ".tiled")
    if os.path.exists(out) and not a.force:
        print(f"[tile-index] 既に在る: {out}（--force で作り直し）"); return 0
    t0 = time.time()
    src = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    src.execute("PRAGMA cache_size=-1000000")
    st = json.loads(src.execute("SELECT data FROM stats ORDER BY id LIMIT 1").fetchone()[0])
    lz = st["layer_zoom"]; maxL = len(lz) - 1
    x0, x1, y0, y1 = world_from_rtree(src); W = x1 - x0
    gL = [max(0, min(30, int(round(np.log2(a.k_tiles * lz[L] / W))))) for L in range(maxL + 1)]
    n_ids = int(src.execute("SELECT MAX(rowid) FROM nodes").fetchone()[0])
    log(t0, f"{a.db}: world W={W:.4f} layers={maxL+1} g_L={gL} max_rowid={n_ids:,}")

    # ---- hap マスク語 / hb を R-Tree（main か <db>.hapidx）から写す ----
    rcols = {r[1] for r in src.execute("PRAGMA table_info(nodes_rtree)")}
    hm_cols = sorted(c for c in rcols if c.startswith("hm") and c[2:].isdigit())
    rt = "nodes_rtree"
    if not hm_cols and os.path.exists(a.db + ".hapidx"):
        src.execute("ATTACH DATABASE ? AS ix", (a.db + ".hapidx",))
        rcols = {r[1] for r in src.execute("PRAGMA ix.table_info(nodes_rtree_hm)")}
        hm_cols = sorted(c for c in rcols if c.startswith("hm") and c[2:].isdigit())
        rt = "ix.nodes_rtree_hm" if hm_cols else rt
    has_hb = "hb" in rcols
    hb = np.full(n_ids + 1, SENT, np.int64)
    hm = np.zeros((n_ids + 1, len(hm_cols)), np.int64)
    if has_hb or hm_cols:
        cols = (["hb"] if has_hb else []) + hm_cols
        cur = src.execute(f"SELECT id, {', '.join(cols)} FROM {rt}")
        n = 0
        while True:
            rows = cur.fetchmany(CHUNK)
            if not rows: break
            arr = np.array(rows, dtype=object)
            ids = arr[:, 0].astype(np.int64)
            k = 1
            if has_hb:
                hb[ids] = np.array([SENT if v is None else v for v in arr[:, 1]], np.int64); k = 2
            for j, _ in enumerate(hm_cols):
                hm[ids, j] = np.array([0 if v is None else v for v in arr[:, k + j]], np.int64)
            n += len(rows)
        log(t0, f"R-Tree から hb={'有' if has_hb else '無'} hm={hm_cols} を {n:,} 行写した ({rt})")

    # ---- 辺の hap-breadth(edge_contig_cov.hb) を写す ----
    n_eids = int(src.execute("SELECT MAX(rowid) FROM edges").fetchone()[0] or 0)
    ehb = np.full(n_eids + 1, SENT, np.int64)
    ecc_cols = {r[1] for r in src.execute("PRAGMA table_info(edge_contig_cov)")}
    has_ehb = "hb" in ecc_cols
    if has_ehb:
        has_idx = src.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ecc_hb'").fetchone() is not None
        cur = src.execute("SELECT edge_rowid, hb FROM edge_contig_cov" + (" INDEXED BY idx_ecc_hb" if has_idx else ""))
        n = 0
        while True:
            rows = cur.fetchmany(CHUNK)
            if not rows: break
            arr = np.array(rows, dtype=object)
            ehb[arr[:, 0].astype(np.int64)] = np.array([SENT if v is None else v for v in arr[:, 1]], np.int64)
            n += len(rows)
        log(t0, f"edge_contig_cov から hb を {n:,} 行写した" + ("（被覆索引 idx_ecc_hb を順読み）" if has_idx else ""))
    # ---- リード支持 read_support の出所（葉層だけ意味を持つ）----
    rs_mode = None
    rd_path = a.db + ".reads"
    if os.path.exists(rd_path):
        src.execute("ATTACH DATABASE ? AS rd", (f"file:{rd_path}?mode=ro",))
        if src.execute("SELECT 1 FROM rd.sqlite_master WHERE type='table' AND name='edge_read_support'").fetchone():
            rs_mode = "sidecar"
    ecols = {r[1] for r in src.execute("PRAGMA table_info(edges)")}
    if rs_mode is None and "read_support" in ecols: rs_mode = "column"
    log(t0, f"edge hb={'有' if has_ehb else '無'} read_support={rs_mode or '無し'}")

    tmp = out + ".part"
    for q in (tmp, tmp + "-journal"):
        if os.path.exists(q): os.unlink(q)
    dst = sqlite3.connect(tmp)
    dst.execute("PRAGMA journal_mode=OFF"); dst.execute("PRAGMA synchronous=OFF"); dst.execute("PRAGMA cache_size=-1000000")
    hmdecl = "".join(f", {c} INTEGER" for c in hm_cols)
    ncols_common = ("name TEXT, x REAL, y REAL, r REAL, ang REAL, kind INTEGER, hb INTEGER, "
                    "ref_contig_id INTEGER, ref_bp INTEGER, ref_bp_end INTEGER, is_anchor INTEGER, "
                    "ref_multi INTEGER, ref_strand INTEGER" + hmdecl)
    dst.executescript(f"""
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE nodes_t(layer INTEGER, mkey INTEGER, id INTEGER, {ncols_common}, PRIMARY KEY(layer, mkey, id)) WITHOUT ROWID;
CREATE TABLE nodes_big(layer INTEGER, id INTEGER, {ncols_common}, PRIMARY KEY(layer, id)) WITHOUT ROWID;
CREATE TABLE edges_t(layer INTEGER, mkey INTEGER, eid INTEGER, side INTEGER,
  src_id INTEGER, tgt_id INTEGER, src_sign INTEGER, tgt_sign INTEGER,
  ex REAL, ey REAL, er REAL, source TEXT, target TEXT, hb INTEGER, rs INTEGER,
  PRIMARY KEY(layer, mkey, eid, side)) WITHOUT ROWID;
""")
    for k, v in (("schema", SCHEMA), ("world", json.dumps([x0, x1, y0, y1])), ("g_L", json.dumps(gL)),
                 ("K_TILES", str(a.k_tiles)), ("hm_cols", json.dumps(hm_cols)), ("has_hb", "1" if has_hb else "0"),
                 ("has_ehb", "1" if has_ehb else "0"), ("rs", rs_mode or ""),
                 ("source", os.path.abspath(a.db))):
        dst.execute("INSERT INTO meta VALUES(?,?)", (k, v))
    NV = 3 + 13 + len(hm_cols)
    ins_t = f"INSERT INTO nodes_t VALUES({','.join('?'*NV)})"
    ins_b = f"INSERT INTO nodes_big VALUES({','.join('?'*(NV-1))})"

    # ---- nodes: rowid 順 1 パス、層ごとに flush ----
    cur = src.execute("SELECT rowid, layer_index, node_name, xCoord, yCoord, radius, angle, kind, "
                      "ref_contig_id, ref_bp, ref_bp_end, is_anchor, ref_multi, ref_strand FROM nodes NOT INDEXED")
    acc, layer_index, tot_nodes, tot_big = {}, {}, 0, 0

    def flush_nodes(L):
        nonlocal tot_nodes, tot_big
        parts = acc.pop(L)
        rid = np.concatenate([p["rid"] for p in parts]); nm = np.concatenate([p["nm"] for p in parts])
        x = np.concatenate([p["x"] for p in parts]); y = np.concatenate([p["y"] for p in parts])
        r = np.concatenate([p["r"] for p in parts]); ang = np.concatenate([p["ang"] for p in parts])
        ints = np.concatenate([p["ints"] for p in parts])
        g = gL[L]; tw = 1.0 / (1 << g); lim = (1 << g) - 1
        tx = np.clip((x / tw).astype(np.int64), 0, lim); ty = np.clip((y / tw).astype(np.int64), 0, lim)
        mk = morton(tx, ty)
        big = r > tw / 2
        small = np.nonzero(~big)[0]; order = small[np.argsort(mk[small], kind="stable")]
        def rec(i):
            return (nm[i].decode(), float(x[i]), float(y[i]), float(r[i]), float(ang[i]), nz(ints[i, 0]),
                    nz(hb[rid[i]]), *(nz(v) for v in ints[i, 1:7]), *(int(v) for v in hm[rid[i]]))
        dst.executemany(ins_t, ((L, int(mk[i]), int(rid[i]), *rec(i)) for i in order))
        bi = np.nonzero(big)[0]
        dst.executemany(ins_b, ((L, int(rid[i]), *rec(i)) for i in bi))
        dst.commit()
        so = np.argsort(nm, kind="stable")
        layer_index[L] = (nm[so], mk[so], rid[so], x[so], y[so], r[so])
        tot_nodes += rid.size; tot_big += bi.size
        log(t0, f"  nodes L{L:2} g={g:2} n={rid.size:>11,} big={bi.size:>6,} tiles={np.unique(mk).size:>9,}")

    cur_layer = -1
    while True:
        rows = cur.fetchmany(CHUNK)
        if not rows: break
        lay = np.fromiter((r[1] for r in rows), np.int64, len(rows))
        for L in np.unique(lay):
            L = int(L)
            if cur_layer >= 0 and L > cur_layer and cur_layer in acc: flush_nodes(cur_layer)
            cur_layer = max(cur_layer, L)
            sel = [rows[i] for i in np.nonzero(lay == L)[0]]
            acc.setdefault(L, []).append(dict(
                rid=np.fromiter((r[0] for r in sel), np.int64, len(sel)),
                nm=np.array([r[2] for r in sel], dtype="S24"),
                x=np.fromiter((r[3] for r in sel), np.float64, len(sel)),
                y=np.fromiter((r[4] for r in sel), np.float64, len(sel)),
                r=np.fromiter(((r[5] or 0.0) for r in sel), np.float64, len(sel)),
                ang=np.fromiter(((r[6] or 0.0) for r in sel), np.float64, len(sel)),
                ints=np.array([[SENT if v is None else int(v) for v in r[7:14]] for r in sel], dtype=np.int64).reshape(len(sel), 7)))
    for L in sorted(acc): flush_nodes(L)
    del hb, hm
    log(t0, f"nodes 完了 {tot_nodes:,}（big {tot_big:,}）")

    # ---- edges: rowid 順 1 パス、層ごとに flush（端点は名前→id を層内 sorted+searchsorted で解く）----
    ecur = src.execute("SELECT rowid, layer_index, source, target, src_sign, tgt_sign, "
                       + ("read_support" if rs_mode == "column" else "NULL") + " FROM edges NOT INDEXED")
    eacc, tot_e, tot_erows = {}, 0, 0

    def flush_edges(L):
        nonlocal tot_e, tot_erows
        parts = eacc.pop(L)
        eid = np.concatenate([p[0] for p in parts]); s = np.concatenate([p[1] for p in parts]); t = np.concatenate([p[2] for p in parts])
        ss = np.concatenate([p[3] for p in parts]); ts = np.concatenate([p[4] for p in parts])
        rsc = np.concatenate([p[5] for p in parts])
        nm, mk, rid, nx_, ny_, nr_ = layer_index[L]
        def resolve(names):
            pos = np.clip(np.searchsorted(nm, names), 0, nm.size - 1); return pos, nm[pos] == names
        ps, oks = resolve(s); pt, okt = resolve(t); ok = oks & okt
        miss = int((~ok).sum())
        eid, ss, ts, ps, pt, rsv = eid[ok], ss[ok], ts[ok], ps[ok], pt[ok], rsc[ok]
        ks, kt = mk[ps], mk[pt]; sid, tid = rid[ps], rid[pt]
        if rs_mode == "sidecar" and L == maxL:
            # <db>.reads の edge_read_support(source,target,support) は葉名が鍵。層内の名前→rowid 表で
            # (sid,tid) に解き、鍵 sid*(n_ids+1)+tid で sorted+searchsorted。viewer の join と同じく向きは区別する
            keys, vals, nrs = [], [], 0
            rcur = src.execute("SELECT source, target, support FROM rd.edge_read_support")
            while True:
                rr = rcur.fetchmany(CHUNK)
                if not rr: break
                p1, o1 = resolve(np.array([q[0] for q in rr], dtype="S24"))
                p2, o2 = resolve(np.array([q[1] for q in rr], dtype="S24")); o = o1 & o2
                keys.append(rid[p1[o]] * (n_ids + 1) + rid[p2[o]])
                vals.append(np.fromiter(((q[2] or 0) for q in rr), np.int64, len(rr))[o])
                nrs += len(rr)
            if keys:
                K = np.concatenate(keys); V = np.concatenate(vals)
                o = np.lexsort((V, K)); K, V = K[o], V[o]
                last = np.r_[K[1:] != K[:-1], True]; K, V = K[last], V[last]   # 重複鍵は最大値
                ek = sid * (n_ids + 1) + tid
                pos = np.clip(np.searchsorted(K, ek), 0, K.size - 1); hit = K[pos] == ek
                rsv = np.where(hit, V[pos], SENT)
                log(t0, f"  read_support {nrs:,} 行 → 葉辺 {int(hit.sum()):,}/{eid.size:,} に付与")
            del keys, vals
        # 端点ごとに 1 行（畳まない）。同タイルでも 2 行にする方が、端点座標で厳密に選べて単純。
        key = np.concatenate([ks, kt]); e2 = np.concatenate([eid, eid])
        side = np.concatenate([np.zeros(eid.size, np.int8), np.ones(eid.size, np.int8)])
        pend = np.concatenate([ps, pt])                 # その行の端点（source or target）の nodes 添字
        idx = np.concatenate([np.arange(eid.size), np.arange(eid.size)])
        order = np.lexsort((side, e2, key))
        # source/target の名前も持つ: 葉層のリード支持(rd.edge_read_support)は **名前鍵**なので、
        # これが無いと reads 表示のたびに従来経路（可視ノード名で 2V 回 probe）へ落ちる。
        dst.executemany("INSERT INTO edges_t VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ((L, int(key[i]), int(e2[i]), int(side[i]), int(sid[idx[i]]), int(tid[idx[i]]), nz(ss[idx[i]]), nz(ts[idx[i]]),
              float(nx_[pend[i]]), float(ny_[pend[i]]), float(nr_[pend[i]]),
              s[idx[i]].decode(), t[idx[i]].decode(), nz(ehb[eid[idx[i]]]), nz(rsv[idx[i]])) for i in order))
        dst.commit()
        tot_e += eid.size; tot_erows += order.size
        log(t0, f"  edges L{L:2} e={eid.size:>11,} rows={order.size:>11,} (+{100*(order.size/max(1,eid.size)-1):.1f}%) 未解決={miss}")
        layer_index.pop(L, None)

    cur_layer = -1
    while True:
        rows = ecur.fetchmany(CHUNK)
        if not rows: break
        lay = np.fromiter((r[1] for r in rows), np.int64, len(rows))
        for L in np.unique(lay):
            L = int(L)
            if cur_layer >= 0 and L > cur_layer and cur_layer in eacc: flush_edges(cur_layer)
            cur_layer = max(cur_layer, L)
            sel = [rows[i] for i in np.nonzero(lay == L)[0]]
            eacc.setdefault(L, []).append((
                np.fromiter((r[0] for r in sel), np.int64, len(sel)),
                np.array([r[2] for r in sel], dtype="S24"), np.array([r[3] for r in sel], dtype="S24"),
                np.fromiter(((SENT if r[4] is None else r[4]) for r in sel), np.int64, len(sel)),
                np.fromiter(((SENT if r[5] is None else r[5]) for r in sel), np.int64, len(sel)),
                np.fromiter(((SENT if r[6] is None else r[6]) for r in sel), np.int64, len(sel))))
    for L in sorted(eacc): flush_edges(L)
    for k, v in (("node_rows", str(tot_nodes)), ("edge_rows", str(tot_erows)), ("edges", str(tot_e))):
        dst.execute("INSERT INTO meta VALUES(?,?)", (k, v))
    dst.execute("INSERT INTO meta VALUES('built_at', datetime('now'))"); dst.commit(); dst.close(); src.close()
    os.replace(tmp, out)
    log(t0, f"完了: {out} {os.path.getsize(out)/1e9:.2f} GB  nodes {tot_nodes:,} / edges {tot_e:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
