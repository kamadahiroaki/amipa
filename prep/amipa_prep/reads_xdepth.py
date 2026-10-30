#!/usr/bin/env python3
"""座標ごとのリードの深さ <db>.xdepth を作る（2026-10-30）。

使い方: reads_xdepth.py --db <db> [--out <db>.xdepth] [--tmp DIR]

入力は <db>.trav（座標 x → 錨のノード）と <db>.reads（転置索引 node_reads: ノード → 整列 id、チャンク＝サンプルの区切り）。GAF は読まない。
各サンプルについて、座標 x の深さ = その座標の錨のノードを通る整列の数（postings の可変長整数の個数＝最上位ビットが 0 のバイトの数）。

出力（SQLite）:
- meta(key, value): R（座標の数）, samples（JSON）, levels（"1,64,4096"）, block（1 blob の区画数）, trav_n / reads_n（作成時の照合用）
- depth(level, b, s, mean BLOB, zero BLOB) WITHOUT ROWID、主キー (level, b, s)
    段 L の区画 i は座標 [i*L, (i+1)*L)。ブロック b は区画 [b*BLOCK, (b+1)*BLOCK)
    mean = 区画の深さの平均（uint16、zlib）。zero = 区画の中で深さ 0 の座標の割合 ×255（uint8、zlib。段 1 は無し）
最後に VACUUM して主キーの順に並べ直す（同じブロックの全サンプルがディスク上で隣り合い、範囲の読み出しが連続読みになる）。

メモリはサンプル 1〜2 本分の配列（R × 4 バイト）。チャンクは追記順（サンプルごとに連続）に並んでいる前提で、崩れていれば止める。
"""
import argparse, json, os, shutil, sqlite3, sys, tempfile, time, zlib
import numpy as np

LEVELS = (1, 64, 4096)
BLOCK = 4096


def log(t0, m): print(f"[{time.time() - t0:7.1f}s] {m}", flush=True)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--db", required=True); ap.add_argument("--out"); ap.add_argument("--tmp", default=os.environ.get("TMPDIR", "/tmp"))
    ap.add_argument("--batch", type=int, default=200_000)
    a = ap.parse_args(); t0 = time.time()
    out = a.out or a.db + ".xdepth"
    tr = sqlite3.connect(f"file:{a.db}.trav?mode=ro", uri=True)
    def arr(n):
        dt, b = tr.execute("SELECT dtype, blob FROM arrays WHERE name=?", (n,)).fetchone(); return np.frombuffer(b, np.dtype(dt))
    xod = arr("x_of_dense"); idm = arr("id_map"); R = len(arr("dense_of_x"))
    order = np.argsort(idm, kind="stable"); ids_sorted = idm[order]   # gfa id → dense（dense = 添字 + 1）
    rc = sqlite3.connect(f"file:{a.db}.reads?mode=ro", uri=True)
    ch_s = dict(rc.execute("SELECT chunk_no, sample_no FROM read_chunk"))
    samples = {s: n for s, n in rc.execute("SELECT sample_no, sample_id FROM read_src")}
    S = max(samples) + 1; last_chunk = {}
    for cn, sn in ch_s.items(): last_chunk[sn] = max(last_chunk.get(sn, -1), cn)
    n_rows = rc.execute("SELECT count(*) FROM node_reads").fetchone()[0]
    log(t0, f"座標 {R:,}  サンプル {S}  索引の行 {n_rows:,}")

    fd, tmp = tempfile.mkstemp(prefix="xdepth.", suffix=".sqlite", dir=a.tmp); os.close(fd)
    oc = sqlite3.connect(tmp); oc.execute("PRAGMA journal_mode=OFF"); oc.execute("PRAGMA synchronous=OFF")
    oc.executescript("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE depth(level INTEGER, b INTEGER, s INTEGER, mean BLOB, zero BLOB, PRIMARY KEY(level, b, s)) WITHOUT ROWID;")

    def flush(sn, dep):
        rows = []
        for L in LEVELS:
            nb = (R + L - 1) // L
            if L == 1: mean = np.minimum(dep, 65535).astype(np.uint16); zero = None
            else:
                pad = np.zeros(nb * L, np.uint32); pad[:R] = dep; blk = pad.reshape(nb, L)
                cnt = np.full(nb, L, np.int64); cnt[-1] = R - (nb - 1) * L
                mean = np.minimum(np.rint(blk.sum(1) / cnt), 65535).astype(np.uint16)
                z = (blk == 0).sum(1) - (L - cnt); zero = np.rint(255 * z / cnt).astype(np.uint8)
            for b in range(0, nb, BLOCK):
                rows.append((L, b // BLOCK, sn, zlib.compress(mean[b:b + BLOCK].tobytes(), 6), None if zero is None else zlib.compress(zero[b:b + BLOCK].tobytes(), 6)))
        oc.executemany("INSERT INTO depth VALUES (?,?,?,?,?)", rows); oc.commit()
        log(t0, f"  サンプル {samples.get(sn, sn)}: 深さの中央値 {int(np.median(dep))}  0 の座標 {100 * (dep == 0).mean():.1f}%")

    open_ = {}; done = set(); n = 0
    gids, cns, blobs = [], [], []
    def drain():
        nonlocal gids, cns, blobs
        if not gids: return
        g = np.asarray(gids, np.int64); c = np.asarray(cns, np.int64)
        lens = np.fromiter((len(b) for b in blobs), np.int64, len(blobs)); cat = np.frombuffer(b"".join(blobs), np.uint8)
        term = (cat < 128).astype(np.int64); starts = np.concatenate(([0], np.cumsum(lens)[:-1]))
        cnt = np.add.reduceat(term, starts) if len(cat) else np.zeros(len(g), np.int64); cnt[lens == 0] = 0
        pos = np.searchsorted(ids_sorted, g); pos = np.minimum(pos, len(ids_sorted) - 1); ok = ids_sorted[pos] == g
        x = np.full(len(g), -1, np.int64); x[ok] = xod[order[pos[ok]] + 1]
        for cn in np.unique(c):
            sn = ch_s[int(cn)]
            if sn in done: sys.exit(f"チャンク {cn}（サンプル {sn}）が、そのサンプルを書き出した後に現れた。索引のチャンクが追記順に並んでいない")
            if sn not in open_: open_[sn] = np.zeros(R, np.uint32)
            m = (c == cn) & (x >= 0); np.add.at(open_[sn], x[m], cnt[m])
        gids, cns, blobs = [], [], []
    prev_cn = None
    for gid, cn, blob in rc.execute("SELECT gfa_id, chunk_no, postings FROM node_reads"):
        if prev_cn is not None and cn != prev_cn:
            drain(); sn0 = ch_s[prev_cn]
            if last_chunk[sn0] == prev_cn and sn0 in open_: flush(sn0, open_.pop(sn0)); done.add(sn0)   # そのサンプルの最後のチャンクを読み終えた
        prev_cn = cn; gids.append(gid); cns.append(cn); blobs.append(blob); n += 1
        if len(gids) >= a.batch: drain()
        if n % 2_000_000 == 0: log(t0, f"{n:,} / {n_rows:,} 行")
    drain()
    for sn in sorted(open_): flush(sn, open_.pop(sn)); done.add(sn)
    for sn in range(S):   # 整列が 1 本も無いサンプル
        if sn not in done: flush(sn, np.zeros(R, np.uint32))
    meta = dict(R=R, samples=json.dumps([samples.get(s, str(s)) for s in range(S)]), levels=",".join(map(str, LEVELS)), block=BLOCK,
                trav_n=len(xod), reads_n=n_rows, built=time.strftime("%Y-%m-%d %H:%M"))
    oc.executemany("INSERT INTO meta VALUES (?,?)", [(k, str(v)) for k, v in meta.items()]); oc.commit()
    oc.execute("VACUUM"); oc.close()   # 主キー順に並べ直す
    um = os.umask(0); os.umask(um); os.chmod(tmp, 0o666 & ~um)   # mkstemp は 600 で作るので、普通のファイルと同じ権限に
    shutil.move(tmp, out + ".tmp"); os.replace(out + ".tmp", out)
    log(t0, f"→ {out}（{os.path.getsize(out) / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
