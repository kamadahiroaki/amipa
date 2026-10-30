#!/usr/bin/env python3
"""座標ごとのリードの深さ <db>.xdepth を作る（2026-10-30）。

使い方: reads_xdepth.py --db <db> [--out <db>.xdepth] [--tmp DIR]

入力は <db>.trav（座標 x → 錨のノード）と <db>.reads（転置索引 node_reads: ノード → 整列 id、チャンク＝サンプルの区切り）。GAF は読まない。
各サンプルについて、座標 x の深さ = その座標をまたぐ整列の数。整列ごとに通る錨の座標を集め、座標が GAP（既定 200）を超えて飛ぶ所で片に切り（反復で遠くの錨に
触れる所を分ける）、片 [最小, 最大] がまたぐ座標を数える。錨はハプロタイプのアレルごとにあるので、「錨を通る整列の数」だとサンプルが持たないアレルの錨で 0 になり、
1 座標ずつ見ると株の型どおりの縞になった（10-30）。またぐ数はリードの棒の表示と一致する。

出力（SQLite）:
- meta(key, value): R（座標の数）, samples（JSON）, levels（"1,64,4096"）, block（1 blob の区画数）, trav_n / reads_n（作成時の照合用）
- depth(level, b, s, mean BLOB, zero BLOB) WITHOUT ROWID、主キー (level, b, s)
    段 L の区画 i は座標 [i*L, (i+1)*L)。ブロック b は区画 [b*BLOCK, (b+1)*BLOCK)
    mean = 区画の深さ（またぐ整列の数）の平均（uint16、zlib）。zero = 区画の中で、錨そのものを通る整列が 0 の座標の割合 ×255（uint8、zlib。段 1 は 0 か 255）
最後に VACUUM して主キーの順に並べ直す（同じブロックの全サンプルがディスク上で隣り合い、範囲の読み出しが連続読みになる）。

メモリはチャンク 1 つ分の (整列, 座標) の組（ヒト chr20–22 で 1 億組 ≒ 数 GB）＋サンプル 1〜2 本分の配列。チャンクは追記順に並んでいる前提で、崩れていれば止める。
"""
import argparse, json, os, shutil, sqlite3, sys, tempfile, time, zlib
import numpy as np

LEVELS = (1, 64, 4096)
BLOCK = 4096


def log(t0, m): print(f"[{time.time() - t0:7.1f}s] {m}", flush=True)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--db", required=True); ap.add_argument("--out"); ap.add_argument("--tmp", default=os.environ.get("TMPDIR", "/tmp"))
    ap.add_argument("--batch", type=int, default=200_000); ap.add_argument("--gap", type=int, default=200, help="整列の錨の座標がこれを超えて飛んだら別の片")
    a = ap.parse_args(); t0 = time.time()
    out = a.out or a.db + ".xdepth"
    tr = sqlite3.connect(f"file:{a.db}.trav?mode=ro", uri=True)
    def arr(n):
        dt, b = tr.execute("SELECT dtype, blob FROM arrays WHERE name=?", (n,)).fetchone(); return np.frombuffer(b, np.dtype(dt))
    xod = arr("x_of_dense"); idm = arr("id_map"); R = len(arr("dense_of_x"))
    order = np.argsort(idm, kind="stable"); ids_sorted = idm[order]   # gfa id → dense（dense = 添字 + 1）
    rc = sqlite3.connect(f"file:{a.db}.reads?mode=ro", uri=True)
    ch_s = dict(rc.execute("SELECT chunk_no, sample_no FROM read_chunk")); ch_base = dict(rc.execute("SELECT chunk_no, base_aln_id FROM read_chunk"))
    samples = {s: n for s, n in rc.execute("SELECT sample_no, sample_id FROM read_src")}
    S = max(samples) + 1; last_chunk = {}
    for cn, sn in ch_s.items(): last_chunk[sn] = max(last_chunk.get(sn, -1), cn)
    n_rows = rc.execute("SELECT count(*) FROM node_reads").fetchone()[0]
    log(t0, f"座標 {R:,}  サンプル {S}  索引の行 {n_rows:,}")

    fd, tmp = tempfile.mkstemp(prefix="xdepth.", suffix=".sqlite", dir=a.tmp); os.close(fd)
    oc = sqlite3.connect(tmp); oc.execute("PRAGMA journal_mode=OFF"); oc.execute("PRAGMA synchronous=OFF")
    oc.executescript("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE depth(level INTEGER, b INTEGER, s INTEGER, mean BLOB, zero BLOB, PRIMARY KEY(level, b, s)) WITHOUT ROWID;")

    def flush(sn, acc):
        dep = np.cumsum(acc["diff"][:R]).astype(np.int64); vis = acc["vis"]; rows = []
        for L in LEVELS:
            nb = (R + L - 1) // L
            pad = np.zeros(nb * L, np.int64); pad[:R] = dep; padv = np.ones(nb * L, np.uint8); padv[:R] = vis > 0
            cnt = np.full(nb, L, np.int64); cnt[-1] = R - (nb - 1) * L
            mean = np.minimum(np.rint(pad.reshape(nb, L).sum(1) / cnt), 65535).astype(np.uint16)
            zero = np.rint(255 * (L - padv.reshape(nb, L).sum(1)) / cnt).astype(np.uint8)
            for b in range(0, nb, BLOCK):
                rows.append((L, b // BLOCK, sn, zlib.compress(mean[b:b + BLOCK].tobytes(), 6), zlib.compress(zero[b:b + BLOCK].tobytes(), 6)))
        oc.executemany("INSERT INTO depth VALUES (?,?,?,?,?)", rows); oc.commit()
        log(t0, f"  サンプル {samples.get(sn, sn)}: またぐ深さの中央値 {int(np.median(dep))}  0 の座標 {100 * (dep == 0).mean():.1f}%  錨を通らない座標 {100 * (vis == 0).mean():.1f}%")
    pend = {}   # チャンク → [(整列, 座標) の配列の一覧]
    def close_chunk(cn):
        sn = ch_s[cn]; parts = pend.pop(cn, [])
        if not parts: return
        al = np.concatenate([p[0] for p in parts]); xs = np.concatenate([p[1] for p in parts])
        o = np.lexsort((xs, al)); al = al[o]; xs = xs[o]
        brk = np.ones(len(al), bool); brk[1:] = (al[1:] != al[:-1]) | (xs[1:] - xs[:-1] > a.gap)
        st = np.flatnonzero(brk); en = np.concatenate((st[1:] - 1, [len(al) - 1]))
        acc = open_[sn]; acc["diff"] += np.bincount(xs[st], minlength=R + 1)[:R + 1]; acc["diff"] -= np.bincount(xs[en] + 1, minlength=R + 1)[:R + 1]
        log(t0, f"  チャンク {cn}: 錨の通過 {len(al):,}  片 {len(st):,}")

    open_ = {}; done = set(); n = 0
    gids, cns, blobs = [], [], []
    def drain():
        nonlocal gids, cns, blobs
        if not gids: return
        g = np.asarray(gids, np.int64); c = np.asarray(cns, np.int64)
        pos = np.searchsorted(ids_sorted, g); pos = np.minimum(pos, len(ids_sorted) - 1); ok = ids_sorted[pos] == g
        x = np.full(len(g), -1, np.int64); x[ok] = xod[order[pos[ok]] + 1]
        keep = np.flatnonzero(x >= 0)   # 錨（座標を持つノード）の行だけ
        if len(keep):
            kb = [blobs[i] for i in keep]; lens = np.fromiter((len(b) for b in kb), np.int64, len(kb)); cat = np.frombuffer(b"".join(kb), np.uint8)
            term = cat < 128; nv = np.add.reduceat(term.astype(np.int64), np.concatenate(([0], np.cumsum(lens)[:-1]))); nv[lens == 0] = 0
            # 可変長整数をまとめて復号: バイトごとに属する値の番号と値の中の位置 → (b & 0x7f) << 7k を値ごとに足す
            vid = np.cumsum(term) - term; vstart = np.concatenate(([0], np.flatnonzero(term)[:-1] + 1)); k = np.arange(len(cat)) - vstart[vid]
            val = np.bincount(vid, weights=((cat & 0x7f).astype(np.int64) << (7 * k)).astype(np.float64), minlength=int(term.sum())).astype(np.int64)
            row = np.repeat(np.arange(len(kb)), nv); cs = np.cumsum(val); first = np.concatenate(([0], np.cumsum(nv)[:-1]))
            off = np.where(first > 0, cs[np.maximum(first - 1, 0)], 0); aln = cs - np.repeat(off, nv)   # 行の中の累積＝チャンクの起点からの id
            xr = np.repeat(x[keep], nv); cr = np.repeat(c[keep], nv)
            for cn in np.unique(cr):
                cn = int(cn); sn = ch_s[cn]
                if sn in done: sys.exit(f"チャンク {cn}（サンプル {sn}）が、そのサンプルを書き出した後に現れた。索引のチャンクが追記順に並んでいない")
                if sn not in open_: open_[sn] = {"diff": np.zeros(R + 1, np.int64), "vis": np.zeros(R, np.uint32)}
                m = cr == cn; pend.setdefault(cn, []).append((aln[m].astype(np.int64), xr[m].astype(np.int64)))
                np.add.at(open_[sn]["vis"], xr[m], 1)
        gids, cns, blobs = [], [], []
    prev_cn = None
    for gid, cn, blob in rc.execute("SELECT gfa_id, chunk_no, postings FROM node_reads"):
        if prev_cn is not None and cn != prev_cn:
            drain(); close_chunk(prev_cn); sn0 = ch_s[prev_cn]
            if last_chunk[sn0] == prev_cn and sn0 in open_: flush(sn0, open_.pop(sn0)); done.add(sn0)   # そのサンプルの最後のチャンクを読み終えた
        prev_cn = cn; gids.append(gid); cns.append(cn); blobs.append(blob); n += 1
        if len(gids) >= a.batch: drain()
        if n % 2_000_000 == 0: log(t0, f"{n:,} / {n_rows:,} 行")
    drain()
    for cn in list(pend): close_chunk(cn)
    for sn in sorted(open_): flush(sn, open_.pop(sn)); done.add(sn)
    for sn in range(S):   # 整列が 1 本も無いサンプル
        if sn not in done: flush(sn, {"diff": np.zeros(R + 1, np.int64), "vis": np.zeros(R, np.uint32)})
    meta = dict(measure="span", gap=a.gap, R=R, samples=json.dumps([samples.get(s, str(s)) for s in range(S)]), levels=",".join(map(str, LEVELS)), block=BLOCK,
                trav_n=len(xod), reads_n=n_rows, built=time.strftime("%Y-%m-%d %H:%M"))
    oc.executemany("INSERT INTO meta VALUES (?,?)", [(k, str(v)) for k, v in meta.items()]); oc.commit()
    oc.execute("VACUUM"); oc.close()   # 主キー順に並べ直す
    um = os.umask(0); os.umask(um); os.chmod(tmp, 0o666 & ~um)   # mkstemp は 600 で作るので、普通のファイルと同じ権限に
    shutil.move(tmp, out + ".tmp"); os.replace(out + ".tmp", out)
    log(t0, f"→ {out}（{os.path.getsize(out) / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
