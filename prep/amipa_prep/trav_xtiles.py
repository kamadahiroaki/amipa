#!/usr/bin/env python3
"""通過のトークンを合意座標の区画（タイル）ごとにまとめたファイル <db>.xtiles（2026-11-12、trav 段の後）。
設計 amipa-lab/plans/viewer-cold-bounded.md ②（速さはキャッシュに頼らず、1 要求の読みに上限）。

使い方: trav_xtiles.py <db>.trav <db>.distill <out>.xtiles [--tile-shift 11] [--tmp DIR]

以前の viewer は、窓の各通過について distill の p_tok を通過ごとに読み（行ごとに離れた位置、窓に要る量の約 100 倍）、トークン 1 個ごとの
座標・種類・bp を全ゲノムの配列（x_of_dense・kind・bp、計 730 MB）から引いていた。配列をメモリに載せないと成り立たない。
ここで、合意座標 x を 2^tile_shift（既定 2,048）錨ずつのタイルに切り、タイルごとに「そこを通る全通過のトークン」を座標・種類・bp・向きと並べて 1 つの塊にする。
窓は掛かるタイルの塊を連続して 1 回読むだけで、配列を引かない。

区切り方（viewer の forEachWindowToken と同じ結果を出すため）:
  通過のトークンのうち「境界」＝種類が錨（kind 1・2）のもの。座標のある境界が同じタイルに続く区間を 1 つの片（segment）とし、片には
  直前の別タイル（または座標の無い）境界の次から、直後の別タイルの境界の前までのトークンを入れる（両側の錨でないトークンを含む。隣の片と重なる部分は読み手が除く）。

ファイル: 先頭 4096 バイトが JSON の見出し {format, tile_shift, ntile, R, trav_size, idx_off}、idx_off に int64 の位置（ntile+1 個）、続いてタイルの塊（zlib）。
塊を展開した中身（すべて little endian、4 バイト境界）:
  nseg int32, row[nseg] int32（trav の id）, ti[nseg] int32（パスの中のトークン番号、片の先頭）, n[nseg] int32,
  d[N] int32（dense id。片ごとに先頭は値、2 個目からは前との差）, bp[N] int32, xf[N] uint16（下位 tile_shift ビット＝タイルの中の x、
  ビット 13＝錨、ビット 14＝向きが逆（p_ori が 0））
"""
import argparse, json, os, sqlite3, sys, time, zlib, tempfile, shutil
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trav_arrays import get_array

ap = argparse.ArgumentParser(); ap.add_argument("trav"); ap.add_argument("distill"); ap.add_argument("out")
ap.add_argument("--tile-shift", type=int, default=11); ap.add_argument("--tmp", default=os.environ.get("TMPDIR", "/tmp")); ap.add_argument("--buckets", type=int, default=64)
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
S = a.tile_shift; assert S <= 13
tr = sqlite3.connect(f"file:{a.trav}?mode=ro", uri=True)
R = int(json.loads(dict(tr.execute("SELECT key, value FROM meta"))["R"]))
ntile = (R >> S) + 1
X = get_array(tr, "x_of_dense").astype(np.int64); K = get_array(tr, "kind"); BP = get_array(tr, "bp")
if BP is None:   # 古い .trav: distill の s_bp（S 行のファイル順）を s_id で dense の順に並べ直す（viewer の ensureCols と同じ）
    sid = np.load(f"{a.distill}/s_id.npy").astype(np.int64); sbp = np.load(f"{a.distill}/s_bp.npy")
    BP = np.zeros(len(X), np.int64); ok = (sid >= 0) & (sid < len(X)); BP[sid[ok]] = sbp[ok]
BP = BP.astype(np.int32); isB = (K == 1) | (K == 2)
p_off = np.load(f"{a.distill}/p_off.npy"); p_tok = np.load(f"{a.distill}/p_tok.npy", mmap_mode="r")
try: p_ori = np.load(f"{a.distill}/p_ori.npy", mmap_mode="r")
except Exception: p_ori = None
rows = tr.execute("SELECT id, pid, i0, i1 FROM trav ORDER BY pid, i0").fetchall()
log(f"R {R:,}  タイル {ntile:,}（{1 << S} 錨）  通過 {len(rows):,}")

# ---- 1 段目: 通過ごとに片を作り、タイルの範囲で分けた一時ファイル（バケット）に書く ----
tmpd = tempfile.mkdtemp(prefix="xtiles.", dir=a.tmp)
NB = a.buckets; per_b = (ntile + NB - 1) // NB
bf = [open(os.path.join(tmpd, f"b{k:03d}"), "wb", buffering=1 << 22) for k in range(NB)]
nseg_all = 0; ntok_all = 0
for ri, (rid, pid, i0, i1) in enumerate(rows):
    off = int(p_off[pid]); tk = np.asarray(p_tok[off + i0: off + i1 + 1], dtype=np.int64); n = len(tk)
    if n == 0: continue
    b = isB[tk]; P = np.flatnonzero(b)
    if not len(P): continue
    xs = X[tk[P]]; T = np.where(xs >= 0, xs >> S, -1)
    rs = np.flatnonzero(np.r_[True, T[1:] != T[:-1]]); re_ = np.r_[rs[1:] - 1, len(P) - 1]
    ori = (np.asarray(p_ori[off + i0: off + i1 + 1]) == 0) if p_ori is not None else np.zeros(n, bool)
    xf = np.zeros(n, np.uint16)
    xa = X[tk[P]]; ok = xa >= 0
    xf[P[ok]] = ((xa[ok] & ((1 << S) - 1)) | (1 << 13)).astype(np.uint16)
    xf |= (ori.astype(np.uint16) << 14)
    dd = tk.astype(np.int32); bp = BP[tk]
    for s_, e_ in zip(rs, re_):
        tl = int(T[s_])
        if tl < 0: continue
        a0 = int(P[s_ - 1]) + 1 if s_ > 0 else 0
        b0 = int(P[e_ + 1]) - 1 if e_ + 1 < len(P) else n - 1
        m = b0 - a0 + 1
        d = dd[a0:b0 + 1].copy(); d[1:] = np.diff(dd[a0:b0 + 1])
        f = bf[tl // per_b]
        f.write(np.array([tl, rid, i0 + a0, m], np.int32).tobytes()); f.write(d.tobytes()); f.write(bp[a0:b0 + 1].tobytes()); f.write(xf[a0:b0 + 1].tobytes())
        nseg_all += 1; ntok_all += m
    if ri % 20000 == 0: log(f"  通過 {ri:,}/{len(rows):,}  片 {nseg_all:,}  トークン {ntok_all:,}")
for f in bf: f.close()
log(f"1 段目 済: 片 {nseg_all:,}、トークン {ntok_all:,}（重なりを含む）")

# ---- 2 段目: バケットごとにタイルの塊を作って順に書く ----
hdr_len = 4096; idx_off = hdr_len; data_off = idx_off + 8 * (ntile + 1)
offs = np.zeros(ntile + 1, np.int64)
outp = a.out + ".tmp"
with open(outp, "wb") as fo:
    fo.seek(data_off); pos = data_off; tl_next = 0
    for k in range(NB):
        fn = os.path.join(tmpd, f"b{k:03d}"); raw = open(fn, "rb").read(); os.remove(fn)
        segs = {}   # tile → list of (row, ti, d, bp, xf)
        p = 0; L = len(raw)
        while p < L:
            tl, rid, ti, m = np.frombuffer(raw, np.int32, 4, p); p += 16
            d = raw[p:p + 4 * m]; p += 4 * m; bp = raw[p:p + 4 * m]; p += 4 * m; xf = raw[p:p + 2 * m]; p += 2 * m
            segs.setdefault(int(tl), []).append((int(rid), int(ti), int(m), d, bp, xf))
        del raw
        lo, hi = k * per_b, min(ntile, (k + 1) * per_b)
        for tl in range(lo, hi):
            offs[tl] = pos
            ss = segs.get(tl)
            if not ss: continue
            ss.sort(key=lambda s: (s[0], s[1]))
            head = np.array([len(ss)], np.int32).tobytes() + np.array([s[0] for s in ss], np.int32).tobytes() + np.array([s[1] for s in ss], np.int32).tobytes() + np.array([s[2] for s in ss], np.int32).tobytes()
            body = b"".join(s[3] for s in ss) + b"".join(s[4] for s in ss) + b"".join(s[5] for s in ss)
            blob = zlib.compress(head + body, 6); fo.write(blob); pos += len(blob)
        log(f"  バケット {k + 1}/{NB}  タイル〜{hi:,}  {pos / 1e9:.2f} GB")
    offs[ntile] = pos   # 空のタイルは次のタイルと同じ位置（長さ 0）
    fo.seek(idx_off); fo.write(offs.tobytes())
    st = os.stat(a.trav)
    h = json.dumps({"format": 1, "tile_shift": S, "ntile": ntile, "R": R, "trav_size": st.st_size, "idx_off": idx_off, "nseg": nseg_all, "ntok": ntok_all}).encode()
    fo.seek(0); fo.write(h + b" " * (hdr_len - len(h)))
shutil.rmtree(tmpd, ignore_errors=True)
os.replace(outp, a.out)
log(f"→ {a.out}（{os.path.getsize(a.out) / 1e9:.2f} GB）")
