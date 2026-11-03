#!/usr/bin/env python3
"""SQLite の表の指定した列を、ファイルの順読みで抜き出す（2026-11-03）。

全ゲノムの本体 DB（213 GB）の nodes 表を SQLite で全走査すると、葉のページが索引のページと入り混じり、ときどき遠くへ飛ぶので
（隣の葉との頁番号の差は中央値 2、隣接は 10%）飛び飛びの小さな読みになり、9 MB/s・29 分かかった。dd で先に順読みしても、
ページキャッシュに残らず効かなかった。ここでは
  1. 表の B 木の内部ページだけを辿って葉のページ番号を集め（内部ページは葉の 1/300 程度）
  2. ファイルを前から大きな塊で順に読み、集めた番号のページだけを numba で解読して要る列を取り出す
ことで、全体を 1 回順読みする時間（1〜2 GB/s）にする。取り出すのは整数の列と「名前の符号」（接頭辞 1 文字 n/G/S＋整数 → 種別 * 2^40 + 整数、
trav_super と同じ）の列だけ。NULL は -1。行は rowid の順に並べて返す（SQLite の NOT INDEXED 走査と同じ順）。

制約: 文字コードは UTF-8、行が溢れのページを持たないこと（持つ行は SQL で引き直す）、読む間に DB が書き換わらないこと。
使い方（試験）: sqlite_seqscan.py <db> <表> <列>:int|name ... [--check]
"""
import os, sqlite3, struct, sys, time
import numpy as np
from numba import njit

KIND_INT, KIND_NAME = 0, 1
SH = 1 << 40


@njit(cache=True, nogil=True)
def _varint(b, o):
    v = 0
    for i in range(8):
        c = b[o + i]; v = (v << 7) | (c & 0x7F)
        if c < 0x80: return v, o + i + 1
    v = (v << 8) | b[o + 8]; return v, o + 9


@njit(cache=True, nogil=True)
def _count_cells(buf, offs, PS):
    n = 0
    for k in range(offs.size):
        o = offs[k]; n += (buf[o + 3] << 8) | buf[o + 4]
    return n


@njit(cache=True, nogil=True)
def _decode(buf, offs, PS, U, cols, kinds, out, rowid, ovf, start):
    """buf の中の葉のページ（先頭の位置 offs）を解読して out[start:] に書く。溢れのある行は ovf に rowid を書き、out の行は -2 で埋める"""
    r = start; X = U - 35; nov = 0; ncol = cols.size
    for k in range(offs.size):
        o = offs[k]
        if buf[o] != 13: return -1 - k      # 表の葉でない（呼び出し側の誤り）
        nc = (buf[o + 3] << 8) | buf[o + 4]
        for c in range(nc):
            p = o + ((buf[o + 8 + 2 * c] << 8) | buf[o + 9 + 2 * c])
            P, p = _varint(buf, p); rid, p = _varint(buf, p); rowid[r] = rid
            if P > X:
                for j in range(ncol): out[r, j] = -2
                ovf[nov] = rid; nov += 1; r += 1; continue
            hs, q = _varint(buf, p); hend = p + hs; body = hend; ci = 0
            for j in range(ncol): out[r, j] = -1
            while q < hend:
                st, q = _varint(buf, q)
                if st >= 12: ln = (st - 12) >> 1
                elif st <= 4: ln = st
                elif st == 5: ln = 6
                elif st <= 7: ln = 8
                else: ln = 0
                for j in range(ncol):
                    if cols[j] == ci:
                        if kinds[j] == 0:     # 整数
                            if 1 <= st <= 6:
                                v = 0
                                for t in range(ln): v = (v << 8) | buf[body + t]
                                if buf[body] >= 0x80: v -= 1 << (8 * ln)   # 符号
                                out[r, j] = v
                            elif st == 8: out[r, j] = 0
                            elif st == 9: out[r, j] = 1
                        else:                 # 名前の符号
                            if st >= 13 and (st & 1) == 1 and ln >= 1:
                                ch = buf[body]; pf = 3
                                if ch == 110: pf = 0       # n
                                elif ch == 71: pf = 1      # G
                                elif ch == 83: pf = 2      # S
                                v = 0; okd = ln >= 2
                                for t in range(1, ln):
                                    d = buf[body + t] - 48
                                    if d < 0 or d > 9: okd = False; break
                                    v = v * 10 + d
                                out[r, j] = pf * 1099511627776 + v if okd else 3 * 1099511627776
                body += ln; ci += 1
            r += 1
    return nov


@njit(cache=True, nogil=True)
def _cell_counts(buf, offs):
    c = np.empty(offs.size, np.int64)
    for k in range(offs.size): o = offs[k]; c[k] = (buf[o + 3] << 8) | buf[o + 4]
    return c


@njit(cache=True)
def _scatter(src, srid, cnt, dst0, out, rid):
    s = 0
    for k in range(cnt.size):
        d = dst0[k]
        for t in range(cnt[k]):
            for j in range(src.shape[1]): out[d + t, j] = src[s, j]
            rid[d + t] = srid[s]; s += 1


def _page_size(f):
    f.seek(0); h = f.read(100)
    if h[:16] != b"SQLite format 3\x00": raise ValueError("SQLite のファイルでない")
    ps = struct.unpack(">H", h[16:18])[0]; ps = 65536 if ps == 1 else ps
    if struct.unpack(">I", h[56:60])[0] not in (0, 1): raise ValueError("文字コードが UTF-8 でない")
    return ps, ps - h[20]


def leaf_pages(path, root, nio=32):
    """表の B 木の葉のページ番号（昇順）。内部ページは層ごとに、nio 本の読みを同時に出す（11-03: 1 本ずつだと全ゲノムで 1.2 万ページに
    419 秒＝1 回 35 ms。Lustre のランダム読みは待ち時間で決まるので、同時に出せば重なる）"""
    from concurrent.futures import ThreadPoolExecutor
    fd = os.open(path, os.O_RDONLY)
    try:
        with open(path, "rb") as f: PS, U = _page_size(f)
        def rd(p): return p, os.pread(fd, PS, (p - 1) * PS)
        level = [root]; leaves = []
        with ThreadPoolExecutor(nio) as ex:
            while level:
                # 読むのは番号の昇順、並びは木の順（層の中で左から右）を保つ。葉は木の順＝rowid の順
                got = dict(ex.map(rd, sorted(set(level)))); nxt = []
                for p in level:
                    b = got[p]; h = 100 if p == 1 else 0; t = b[h]
                    if t == 13: leaves.append(p); continue
                    if t != 5: raise ValueError(f"頁 {p} が表の B 木でない（型 {t}）")
                    n = struct.unpack(">H", b[h + 3:h + 5])[0]
                    for i in range(n):
                        o = struct.unpack(">H", b[h + 12 + 2 * i:h + 14 + 2 * i])[0]; nxt.append(struct.unpack(">I", b[o:o + 4])[0])
                    nxt.append(struct.unpack(">I", b[h + 8:h + 12])[0])
                level = nxt
    finally: os.close(fd)
    return np.array(leaves, np.int64), PS, U   # 木の順


def scan(path, table, cols, chunk_mb=64, nio=1, nio_interior=16, log=None):
    """cols = [(列名, 'int'|'name'), ...] → (rowid, 値の表 int64 [行, 列])。rowid の昇順"""
    t0 = time.time(); log = log or (lambda *x: None)
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    root = con.execute("SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    if not root: raise ValueError(f"表 {table} が無い")
    sql = con.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,)).fetchone()[0] or ""
    if "WITHOUT ROWID" in sql.upper(): raise ValueError("WITHOUT ROWID の表は対象外")
    info = con.execute(f"PRAGMA table_info({table})").fetchall(); idx = {r[1]: r[0] for r in info}
    if any(r[5] == 1 and r[2].upper() == "INTEGER" and sum(1 for x in info if x[5]) == 1 for r in info): raise ValueError("INTEGER PRIMARY KEY（rowid の別名）の表は対象外")
    ci = np.array([idx[c] for c, _ in cols], np.int64); ki = np.array([KIND_INT if k == "int" else KIND_NAME for _, k in cols], np.int64)
    tree, PS, U = leaf_pages(path, root[0], nio=nio_interior); leaves = np.sort(tree)
    trank = np.argsort(tree, kind="stable")   # ファイル順の k 番目の葉 → 木の順の番号
    log(f"  葉のページ {leaves.size:,}（{leaves.size * PS / 1e9:.1f} GB、内部ページを辿って {time.time() - t0:.1f}s）")
    # 葉の並びを chunk_mb 以内の塊に分け（塊の間の葉の無い所は読まない）、nio 本を同時に順読みして解読する（解読は numba の nogil）。
    # 11-03: 全ゲノム（ストライプ 1 の 213 GB）で 31.5 GB を 1 本の順読みで 81 秒、8 本同時では 680 秒（1 台の OST で順読み同士が崩れた）。既定は 1 本
    from concurrent.futures import ThreadPoolExecutor
    per = max(1, chunk_mb * (1 << 20) // PS); chunks = []; i = 0
    while i < leaves.size:
        j = int(np.searchsorted(leaves, leaves[i] + per, side="left")) - 1; chunks.append((i, max(i, j))); i = max(i, j) + 1
    fd = os.open(path, os.O_RDONLY)
    def work(ij):
        i, j = ij; lo, hi = int(leaves[i]), int(leaves[j])
        buf = np.frombuffer(os.pread(fd, (hi - lo + 1) * PS, (lo - 1) * PS), np.uint8); offs = (leaves[i:j + 1] - lo) * PS
        n = _count_cells(buf, offs, PS); out = np.empty((n, len(cols)), np.int64); rid = np.empty(n, np.int64); ovf = np.empty(n, np.int64)
        nov = _decode(buf, offs, PS, U, ci, ki, out, rid, ovf, 0)
        if nov < 0: raise ValueError(f"頁 {int(leaves[i + (-1 - nov)])} が表の葉でない")
        return i, j, _cell_counts(buf, offs), out, rid, ovf[:nov], buf.size
    parts = []; nread = 0; cnt = np.zeros(leaves.size, np.int64)
    try:
        with ThreadPoolExecutor(nio) as ex:
            for i, j, cc, out, rid, ov, nb in ex.map(work, chunks): cnt[i:j + 1] = cc; parts.append((i, j, out, rid, ov)); nread += nb
    finally: os.close(fd)
    # 11-03: 行を rowid で並べ直す argsort（1.5 億行）が全ゲノムで 6.5 分かかった → 葉ごとの行を木の順の位置へ直接書く
    tcnt = np.zeros(leaves.size, np.int64); tcnt[trank] = cnt; toff = np.concatenate(([0], np.cumsum(tcnt)))
    total = int(toff[-1]); out = np.empty((total, len(cols)), np.int64); rid = np.empty(total, np.int64); ovfs = []
    for i, j, o_, r_, ov in parts:
        _scatter(o_, r_, cnt[i:j + 1], toff[trank[i:j + 1]], out, rid); ovfs.append(ov)
    del parts
    ovf = np.concatenate(ovfs) if ovfs else np.zeros(0, np.int64)
    log(f"  順読み {nread / 1e9:.1f} GB・{out.shape[0]:,} 行（{time.time() - t0:.1f}s）、溢れの行 {ovf.size:,}")
    if ovf.size:   # 溢れのページを持つ行は SQL で引き直す（名前の符号は Python で）
        pos = {int(r): k for k, r in enumerate(rid)}
        for r_ in ovf.tolist():
            row = con.execute(f"SELECT {', '.join(c for c, _ in cols)} FROM {table} WHERE rowid = ?", (r_,)).fetchone()
            out[pos[r_]] = [_enc_py(v, k) for v, (_, k) in zip(row, cols)]
    con.close()
    if rid.size > 1 and not (rid[1:] > rid[:-1]).all(): raise ValueError("木の順の rowid が昇順でない")
    return rid, out


def _enc_py(v, kind):
    if v is None or v == "": return -1
    if kind == "int": return int(v)
    s = str(v); pf = {"n": 0, "G": 1, "S": 2}.get(s[:1], 3)
    return pf * SH + int(s[1:]) if pf < 3 and s[1:].isdigit() else 3 * SH


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument("db"); ap.add_argument("table"); ap.add_argument("cols", nargs="+"); ap.add_argument("--check", action="store_true", help="SQLite の走査と突き合わせる")
    a = ap.parse_args(); cols = [tuple(c.split(":")) for c in a.cols]; t0 = time.time()
    rid, out = scan(a.db, a.table, cols, log=lambda *x: print(*x, file=sys.stderr, flush=True))
    print(f"順読み: {out.shape[0]:,} 行 {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
    if a.check:
        t1 = time.time(); D = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
        enc = lambda c, k: c if k == "int" else (f"(CASE substr({c},1,1) WHEN 'n' THEN 0 WHEN 'G' THEN 1 WHEN 'S' THEN 2 ELSE 3 END) * {SH} + CAST(substr({c},2) AS INTEGER)")
        sel = ", ".join(f"CASE WHEN {c} IS NULL OR {c} = '' THEN -1 ELSE {enc(c, k)} END" for c, k in cols)
        cs = D.execute(f"SELECT rowid, {sel} FROM {a.table} NOT INDEXED"); parts = []
        while True:
            r = cs.fetchmany(1_000_000)
            if not r: break
            parts.append(np.array(r, np.int64))
        ref = np.concatenate(parts); print(f"SQLite: {ref.shape[0]:,} 行 {time.time() - t1:.1f}s", file=sys.stderr)
        ok = ref.shape[0] == out.shape[0] and (ref[:, 0] == rid).all() and (ref[:, 1:] == out).all()
        print("一致" if ok else "不一致", file=sys.stderr); sys.exit(0 if ok else 1)
