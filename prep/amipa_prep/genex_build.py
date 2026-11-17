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

# 機能喪失の目安（genelof_build.py の要約）: 状態 0 ok・1 fs・2 trunc・3 nostart・4 nocds・5 partial・6 refdiff（viewer の trav.ts の LOF_ST と同じ並び）。
#   写しは元の遺伝子（proj）の同じ親（転写産物）と比べる（viewer の travGeneLof と同じ）。11-17:
#   partial … 判定しない: 写しの CDS の片が元より少ない（コンティグの端・写しの外）・CDS の端を決められない・元の注釈が pseudo。
#             元の注釈の遺伝子は pseudo・partial（cds_*_NF など）なら。元が partial の写しは nostart だけ判定しない
#   refdiff … 元の遺伝子と違う（fs・trunc・nostart）が、判定できる写しの 9 割以上（5 本以上）が同じ違いを持つ（参照の側が外れ値の見込み）
LOF_ST = ['ok', 'fs', 'trunc', 'nostart', 'nocds', 'partial', 'refdiff']
summ = {}; summ_par = {}
for f in A_.lof:
    z = np.load(f); n_ = len(z["gid"])
    par = z["par"].tolist() if "par" in z else [-1] * n_; npc = z["npiece"].tolist() if "npiece" in z else [0] * n_
    qc = z["qc"].tolist() if "qc" in z else [0] * n_; ch = z["chosen"].tolist() if "chosen" in z else [True] * n_
    for gid_, p_, L_, aa_, st_, np_, q_, c_ in zip(z["gid"].tolist(), par, z["L"].tolist(), z["aa"].tolist(), z["start"].tolist(), npc, qc, ch):
        v = (L_, aa_, st_, np_, q_, p_); summ_par[(gid_, p_)] = v
        if c_ or gid_ not in summ: summ[gid_] = v
if A_.lof: log(f"機能喪失の目安の要約 {len(summ):,}")
proj_all = dict(g.execute("SELECT gid, proj FROM gene WHERE proj IS NOT NULL")) if has_proj else {}
def lof_raw(gid, proj):
    sm = summ.get(gid)
    if sm is None: return (4, None, None, None)
    L_, aa_, start_, np_, qc_, par_ = sm
    ref = (summ_par.get((proj, par_)) or summ.get(proj)) if proj is not None else None
    if ref is not None:
        if (qc_ & 2) or (ref[4] & 1) or np_ < ref[3]: return (5, aa_, ref[1], None)
        if (L_ - ref[0]) % 3 != 0: return (1, aa_, ref[1], ('fs', L_ - ref[0]))
        if aa_ < 0.9 * ref[1]: return (2, aa_, ref[1], ('trunc', aa_))
        if ref[2] and not start_ and not (ref[4] & 4): return (3, aa_, ref[1], ('nostart', L_ - ref[0]))
        return (0, aa_, ref[1], None)
    if qc_ & 5: return (5, aa_, None, None)
    exp = L_ // 3 - 1
    st = 3 if not start_ else 2 if aa_ < 0.9 * exp else 0
    return (st, aa_, None, None)
LOF = {}
if A_.lof:
    byproj = defaultdict(list)
    for gid_ in summ:
        pj = proj_all.get(gid_); r_ = lof_raw(gid_, pj); LOF[gid_] = r_
        if pj is not None: byproj[pj].append(gid_)
    nref = 0
    for pj, gs_ in byproj.items():
        judg = [x for x in gs_ if LOF[x][0] in (0, 1, 2, 3)]
        if len(judg) < 5: continue
        cnt = defaultdict(int)
        for x in judg:
            if LOF[x][3] is not None: cnt[LOF[x][3]] += 1
        for sig, c in cnt.items():
            if c >= 0.9 * len(judg):
                for x in judg:
                    if LOF[x][3] == sig: LOF[x] = (6,) + LOF[x][1:]; nref += 1
    log(f"状態 { {LOF_ST[k]: v for k, v in sorted(__import__('collections').Counter(v[0] for v in LOF.values()).items())} }（refdiff {nref:,}）")
def lof_of(gid, proj):
    if not A_.lof: return (None, None, None)
    r_ = LOF.get(gid)
    if r_ is None: return (4, None, None)
    return r_[:3]

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
               ("genes_size", str(st_.st_size)), ("trav_size", str(st2.st_size)), ("n_gene", str(len(out_rows))), ("has_lof", "1" if A_.lof else "0"), ("lof_states", ",".join(LOF_ST)), ("built", time.strftime("%Y-%m-%d %H:%M"))])
o.commit(); o.execute("VACUUM"); o.close()
log(f"→ {out}（{os.path.getsize(out) / 1e9:.2f} GB）")
