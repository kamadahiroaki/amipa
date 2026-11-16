#!/usr/bin/env python3
"""パスの座標 → 合意座標の索引 <db>.refx（2026-11-16、trav 段の後）。Linear の地点の一覧（go）が参照座標・株の座標から移動するため。
設計 amipa-lab/plans/ui-redesign/trav-rows-worklist.md 3（読みの回数に上限がある形）。

使い方: trav_refx.py <db>.trav <db>.distill <out>.refx [--ref-step 256] [--other-step 16384]

各パスの通過（trav 行）の中の錨（kind 1・2 で x を持つトークン）から、パス上の bp で一定の間隔ごとに 1 つと、各通過の最初と最後の錨を
点 (pid, bp, x) として残す。bp はそのトークンのコンティグ上の開始位置（0 始まり。パスの先頭の位置 p_start.npy を足す。W 行の断片は SeqStart から）。間隔は参照の株（meta.params.seed_ref と
GRCh38・CHM13）が --ref-step、その他が --other-step。読み手は前後の点を線形に補う（点の間で x が bp と釣り合わないときは補わない）。

ファイル: SQLite。refx(pid, bp, x, ti) PRIMARY KEY (pid, bp) WITHOUT ROWID、索引 (pid, ti)、meta(key, value)。ti＝パスの中のトークン番号（format 2、11-16。
範囲の端のトークンのコンティグ上の位置を、手前の点から .xtiles のトークンの bp を足して正確に出す）。1 回の問い合わせは索引を数ページ読むだけ。
"""
import argparse, json, os, sqlite3, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trav_arrays import get_array

ap = argparse.ArgumentParser(); ap.add_argument("trav"); ap.add_argument("distill"); ap.add_argument("out")
ap.add_argument("--ref-step", type=int, default=256); ap.add_argument("--other-step", type=int, default=16384)
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
tr = sqlite3.connect(f"file:{a.trav}?mode=ro", uri=True)
meta = dict(tr.execute("SELECT key, value FROM meta"))
params = json.loads(meta.get("params") or "{}"); seed = str(params.get("seed_ref") or "")
X = get_array(tr, "x_of_dense").astype(np.int64); K = get_array(tr, "kind"); BP = get_array(tr, "bp")
if BP is None:
    sid = np.load(f"{a.distill}/s_id.npy").astype(np.int64); sbp = np.load(f"{a.distill}/s_bp.npy")
    BP = np.zeros(len(X), np.int64); ok = (sid >= 0) & (sid < len(X)); BP[sid[ok]] = sbp[ok]
BP = BP.astype(np.int64); isA = ((K == 1) | (K == 2)) & (X >= 0)
try: p_start = np.load(f"{a.distill}/p_start.npy")   # コンティグ上の開始（W 行の SeqStart。11-04 より前の distill には無い → 0）
except Exception: p_start = None
p_off = np.load(f"{a.distill}/p_off.npy"); p_tok = np.load(f"{a.distill}/p_tok.npy", mmap_mode="r")
haps = dict(tr.execute("SELECT hid, hap FROM haps"))
paths = tr.execute("SELECT pid, path, hid FROM paths ORDER BY pid").fetchall()
refhid = set()
for pid, path, hid in paths:
    if (seed and path.startswith(seed)) or path.startswith(("GRCh38", "CHM13")): refhid.add(hid)
if not refhid and paths: refhid.add(paths[0][2])
rows = tr.execute("SELECT pid, i0, i1 FROM trav ORDER BY pid, i0").fetchall()
log(f"パス {len(paths):,}  通過 {len(rows):,}  参照の株 {sorted(haps.get(h, h) for h in refhid)}  間隔 参照 {a.ref_step} / その他 {a.other_step} bp")

tmp = a.out + ".tmp"
if os.path.exists(tmp): os.remove(tmp)
db = sqlite3.connect(tmp); db.execute("PRAGMA journal_mode=OFF"); db.execute("PRAGMA synchronous=OFF")
db.execute("CREATE TABLE refx(pid INTEGER, bp INTEGER, x INTEGER, ti INTEGER, PRIMARY KEY(pid, bp)) WITHOUT ROWID")
db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
hid_of = {pid: hid for pid, _, hid in paths}
npt = 0; k = 0; nrows = len(rows)
while k < nrows:
    pid = rows[k][0]; j = k
    while j < nrows and rows[j][0] == pid: j += 1
    off = int(p_off[pid]); end = int(p_off[pid + 1]) if pid + 1 < len(p_off) else len(p_tok)
    tk = np.asarray(p_tok[off:end], dtype=np.int64)
    cum = np.zeros(len(tk) + 1, np.int64); np.cumsum(BP[tk], out=cum[1:]); cum += int(p_start[pid]) if p_start is not None else 0
    step = a.ref_step if hid_of.get(pid) in refhid else a.other_step
    pts = []
    for _, i0, i1 in rows[k:j]:
        idx = np.arange(i0, min(i1, len(tk) - 1) + 1)
        if not len(idx): continue
        idx = idx[isA[tk[idx]]]
        if not len(idx): continue
        b = cum[idx]; _, first = np.unique(b // step, return_index=True)
        sel = np.unique(np.r_[first, len(idx) - 1])
        pts.append(np.stack([b[sel], X[tk[idx[sel]]], idx[sel]], 1))
    if pts:
        P = np.concatenate(pts); P = P[np.argsort(P[:, 0], kind="stable")]
        db.executemany("INSERT OR IGNORE INTO refx VALUES (?, ?, ?, ?)", ((pid, int(bp), int(x), int(ti)) for bp, x, ti in P)); npt += len(P)
    k = j
    if pid % 500 == 0: log(f"  pid {pid:,}  点 {npt:,}")
db.execute("CREATE INDEX refx_ti ON refx(pid, ti)")
db.executemany("INSERT INTO meta VALUES (?, ?)", [("format", "2"), ("ref_step", str(a.ref_step)), ("other_step", str(a.other_step)),
               ("ref_hids", json.dumps(sorted(int(h) for h in refhid))), ("path_offsets", "1" if p_start is not None else "0"), ("trav_size", str(os.path.getsize(a.trav))), ("built", time.strftime("%Y-%m-%d %H:%M:%S"))])
db.commit(); db.close(); os.replace(tmp, a.out)
log(f"済: 点 {npt:,}  {os.path.getsize(a.out) / 1e6:.1f} MB → {a.out}")
