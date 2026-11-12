#!/usr/bin/env python3
"""遺伝子レーンの索引 <db>.genex（2026-11-12、genes 段の最後）。設計 amipa-lab/plans/viewer-cold-bounded.md ⑤。

使い方: genex_build.py <db>.genes <db>.trav <out>.genex [--lof <genelof_build.py の npz>...]

以前の viewer は /genes のたびに、窓の通過ごとに .genes（全ゲノム 8.7 GB）の gene × gene_tok をトークン範囲で引き（通過 90 本で数千回の読み）、
遺伝子の座標を distill のトークンと全ゲノムの配列から計算し直していた（gene_x に前計算があるのに使っていなかった）。
ここで、窓の遺伝子を合意座標の階層ビン（trav_xindex.py と同じ）の連続読みで引けるよう、遺伝子 1 行に要る列と子（エキソン・CDS・UTR）を並べる。

g_b(bin, x0, gid, ...) WITHOUT ROWID … 遺伝子（写しを含む全行）。x0, x1 は gene_x（両端 1,500 トークンの錨の座標）。錨の無い遺伝子は
  属する通過（同じパスでトークンが最も重なる通過）の中の位置から補間し、anchored = 0。ch … 子の行を詰めた zlib（int32 × 10 列:
  種類（0 CDS・1 exon・2 UTR）, phase（無ければ -1）, 鎖（1 + / -1 − / 0）, parent（無ければ -1）, start, end, s0, e0, so, eo）
"""
import json, os, sqlite3, sys, time, zlib
from collections import defaultdict
import numpy as np

import argparse
ap = argparse.ArgumentParser(); ap.add_argument("genes"); ap.add_argument("trav"); ap.add_argument("out"); ap.add_argument("--lof", nargs="*", default=[])
A_ = ap.parse_args(); genes, trav, out = A_.genes, A_.trav, A_.out
t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
tr = sqlite3.connect(f"file:{trav}?mode=ro", uri=True)
R = int(json.loads(dict(tr.execute("SELECT key, value FROM meta"))["R"]))
hid_of = dict(tr.execute("SELECT pid, hid FROM paths"))
rows_by_pid = defaultdict(list)
for r in tr.execute("SELECT pid, i0, i1, x0, x1, dir FROM trav"): rows_by_pid[r[0]].append(r)
shifts = []; s = 12
while True:
    shifts.append(s)
    if (1 << s) > R: break
    s += 3
offsets = []; o = 0
for s in shifts: offsets.append(o); o += (R >> s) + 1
def bin_of(x0, x1):
    for L, s in enumerate(shifts):
        if (x0 >> s) == (x1 >> s): return offsets[L] + (x0 >> s)
    return offsets[-1]

g = sqlite3.connect(f"file:{genes}?mode=ro", uri=True)
has_proj = any(c[1] == "proj" for c in g.execute("PRAGMA table_info(gene)"))
# 子（全ゲノムで約 4,900 万行）: Python の組で持つとメモリが足りないので、SQL で整数に直して numpy に溜め、gid・s0 の順に並べる
cq = ("SELECT f.gid, CASE WHEN f.type IN ('CDS','cds') THEN 0 WHEN f.type = 'exon' THEN 1 ELSE 2 END, "
      "CASE WHEN f.phase GLOB '[0-9]*' THEN CAST(f.phase AS INT) ELSE -1 END, CASE f.strand WHEN '+' THEN 1 WHEN '-' THEN -1 ELSE 0 END, "
      "coalesce(f.parent, -1), coalesce(f.start, 0), coalesce(f.end, 0), t.s0, t.e0, coalesce(t.so, 0), coalesce(t.eo, 0) "
      "FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.type IN ('CDS','cds','exon','five_prime_UTR','three_prime_UTR','UTR')")
parts = []; cur = g.execute(cq)
while True:
    rs = cur.fetchmany(200000)
    if not rs: break
    parts.append(np.array(rs, np.int64))
CH = np.concatenate(parts) if parts else np.zeros((0, 11), np.int64); del parts
CH = CH[np.lexsort((CH[:, 7], CH[:, 0]))]; nch = len(CH)
cg = CH[:, 0]; CHV = CH[:, 1:].astype(np.int32); del CH
def children(gid):
    a_ = np.searchsorted(cg, gid, "left"); b_ = np.searchsorted(cg, gid, "right")
    return CHV[a_:b_] if b_ > a_ else None
log(f"子 {nch:,}")

# 機能喪失の目安（genelof_build.py の要約）: 状態 0 ok・1 fs・2 trunc・3 nostart・4 nocds。写しは元の遺伝子（proj）と比べる（viewer の travGeneLof と同じ）
summ = {}
for f in A_.lof:
    z = np.load(f)
    for gid_, L_, aa_, st_ in zip(z["gid"].tolist(), z["L"].tolist(), z["aa"].tolist(), z["start"].tolist()): summ[gid_] = (L_, aa_, st_)
if A_.lof: log(f"機能喪失の目安の要約 {len(summ):,}")
def lof_of(gid, proj):
    if not A_.lof: return (None, None, None)
    sm = summ.get(gid)
    if sm is None: return (4, None, None)
    L_, aa_, start_ = sm; ref = summ.get(proj) if proj is not None else None
    if ref is not None:
        if (L_ - ref[0]) % 3 != 0: st = 1
        elif aa_ < 0.9 * ref[1]: st = 2
        elif ref[2] and not start_: st = 3
        else: st = 0
        return (st, aa_, ref[1])
    exp = L_ // 3 - 1
    st = 3 if not start_ else 2 if aa_ < 0.9 * exp else 0
    return (st, aa_, None)

out_rows = []; ninterp = 0
q = f"SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, {'g.proj, g.frac' if has_proj else 'NULL, 1.0'}, k.s0, k.e0, x.x0, x.x1 FROM gene g JOIN gene_tok k ON k.gid = g.gid JOIN gene_x x ON x.gid = g.gid"
for gid, pid, st, en, strand, typ, name, locus, product, pseudo, proj, frac, s0, e0, x0, x1 in g.execute(q):
    anchored = 1
    if x0 is None or x0 < 0 or x1 < 0:
        best = None; bo = 0
        for r in rows_by_pid.get(pid, ()):
            ov = min(r[2] + 1, e0) - max(r[1], s0)
            if ov > bo: best, bo = r, ov
        if best is None: continue
        _, ri0, ri1, rx0, rx1, d = best; Lt = ri1 - ri0 + 1; span = max(1, rx1 - rx0)
        a_ = max(ri0, s0); b_ = min(ri1 + 1, e0); f0 = (a_ - ri0) / Lt; f1 = (b_ - ri0) / Lt
        u0, u1 = (f0, f1) if d >= 0 else (1 - f1, 1 - f0)
        x0 = int(np.floor(rx0 + u0 * span + 0.5)); x1 = int(np.floor(rx0 + u1 * span + 0.5)); anchored = 0; ninterp += 1
    c = children(gid)
    blob = zlib.compress(np.ascontiguousarray(c).tobytes(), 6) if c is not None else None
    out_rows.append((bin_of(min(x0, x1), max(x0, x1)), min(x0, x1), gid, max(x0, x1), pid, hid_of.get(pid, -1), s0, e0, st, en, strand, typ, name, locus, product, pseudo, proj, frac, anchored, blob, *lof_of(gid, proj)))
log(f"遺伝子 {len(out_rows):,}（錨が無く補間 {ninterp:,}）")
out_rows.sort(key=lambda r: (r[0], r[1], r[2]))
if os.path.exists(out): os.remove(out)
o = sqlite3.connect(out); o.execute("PRAGMA journal_mode=OFF"); o.execute("PRAGMA synchronous=OFF")
o.execute("CREATE TABLE g_b(bin INT, x0 INT, gid INT, x1 INT, pid INT, hid INT, s0 INT, e0 INT, start INT, end INT, strand TEXT, type TEXT, name TEXT, locus TEXT, product TEXT, pseudo INT, proj INT, frac REAL, anchored INT, ch BLOB, lof_st INT, lof_aa INT, lof_ref INT, PRIMARY KEY(bin, x0, gid)) WITHOUT ROWID")
o.executemany(f"INSERT INTO g_b VALUES ({','.join('?' * 23)})", out_rows)
o.execute("CREATE INDEX g_bx ON g_b(bin, x0, x1)")   # 件数（多すぎるかの判定）を子の塊を読まずに数える
st_ = os.stat(genes); st2 = os.stat(trav)
o.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
o.executemany("INSERT INTO meta VALUES (?,?)", [("format", "1"), ("R", str(R)), ("shifts", json.dumps(shifts)), ("offsets", json.dumps(offsets)), ("has_proj", "1" if has_proj else "0"),
               ("genes_size", str(st_.st_size)), ("trav_size", str(st2.st_size)), ("n_gene", str(len(out_rows))), ("has_lof", "1" if A_.lof else "0"), ("built", time.strftime("%Y-%m-%d %H:%M"))])
o.commit(); o.execute("VACUUM"); o.close()
log(f"→ {out}（{os.path.getsize(out) / 1e9:.2f} GB）")
