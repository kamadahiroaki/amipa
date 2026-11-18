#!/usr/bin/env python3
"""Traversals の範囲の問い合わせ用の索引 <db>.travx と配列ファイル <db>.travx.arr（2026-11-12、trav 段の後）。
設計 amipa-lab/plans/viewer-cold-bounded.md の ④・⑨（速さはキャッシュに頼らず、1 要求の読みに上限）。

使い方: trav_xindex.py <db>.trav <db>.distill <out>.travx [--db <db>]     （<out>.travx.arr も書く）

以前の viewer は、
  - /range のたびに idx_trav_x(x0, x1) で「x0 ≤ 範囲の右端」の行を全部なめ（全ゲノムで 90 行を返すのに 4,300 回・18 MB の読み）、
    反復の判定（markRepeats）を distill の読みで計算し直し、コンティグの情報（addContigInfo）のために 730 MB の配列を読み込んでいた
  - 起動時に xbp（531 MB）、nleaf のために x_fill（326 MB）を並べ替えた写し、/nodes・ブロック段のリードのために dense_of_x（266 MB）を丸ごと読み込んでいた
ここで、窓に依らない値を前計算し、範囲の問い合わせを「数段のビンの連続した読み」にする。

<out>.travx（SQLite）:
- trav_b / copies_b / reps_b … 行を UCSC 式の階層ビン（最も細かい段で 2^12 座標、3 ビットずつ粗く）の番号の順に、全列ごと並べたもの（WITHOUT ROWID、
    主キー (bin, x0, id)）。各行は区間がまるごと入る最も細かいビンに 1 回だけ入る。範囲 [x0, x1] は段ごとに掛かるビンの範囲を 1 回ずつ読む
  trav_b の追加の列:
    rep      … 反復の判定（同じパスの通過どうしの x の重なりの中に、両方が錨を 10 個以上持つ。-1＝重なる通過が無く判定しない）。以前の markRepeats と同じ規則を
                窓に依らずパス全体で（以前は表示範囲に入った行だけで群を作っていた）
    trim0, trim1 … 反復でない重なりで、錨を持たない側から除く区間（無ければ -1）
    cs, ce, fs, fe, cs0, ceL … コンティグ上の位置と切れ目（以前の addContigInfo と同じ）
  reps_b は以前 /range が trav と結合して補間していた x0, x1 と、属する通過の錨の数 tnanch を持つ
- chroms(x0, x1, name, ref) … 全体図の染色体の帯（以前の travChroms と同じ規則）
- meta … format, R, shifts, offsets, trav_size, trav_mtime（.trav が変わったら作り直す目印）, cdir（パスごとの主な向き、JSON）
<out>.travx.arr（位置を指定して読む固定幅の配列。先頭 4096 バイトが JSON の見出し {name: [offset, dtype, n]}）:
- xbp (int64, R+1) … 座標 → 累積 bp
- nleafcum (int64, R+2) … nleafcum[x] ＝ x_fill（錨はその座標、錨でない葉は直前の錨の座標）が x 未満の葉の数。範囲の葉の数は 2 値の差
- dense_of_x (int32, R) … 座標 → 錨のノード（dense id）
- order (int32, N+1) … ノード（dense id）の合意の並び: 錨は x_of_dense、錨でない葉は x_fill（無ければ -1）。塩基の段が列の順と行の向きに使う（以前は全ゲノムの配列を丸ごと作っていた）
- refbp (int64, N+1), refcid (int32, N+1) … ノード（dense id）の参照座標（参照パスの上の最小の開始位置、0 始まり）と参照コンティグの番号（本体の ref_contigs.contig_id）。
    参照で通らないノードは -1。--db があるときだけ。
- refori (int8, N+1) … 参照パスがそのノードを通る向きの bp 加重の多数派（1＝格納向き、0＝逆、参照が通らなければ -1）。本体の emit.py の ref_orient と同じ。
    パスのリボンがコンティグ単位の逆位を判定するのに使う（rel ＝ 向き XOR refori、基準は contig_dict.ref_baseline）以前は塩基の段が本体 DB（213 GB）の nodes を名前で 1 件ずつ引いていた。本体の nodes.ref_bp と一致（chr13 で確認）
"""
import json, os, sqlite3, sys, time
from collections import defaultdict
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trav_arrays import get_array
from pathnames import contig_of, sample_of

import argparse
_ap = argparse.ArgumentParser(); _ap.add_argument("trav"); _ap.add_argument("distill"); _ap.add_argument("out"); _ap.add_argument("--db")
_A = _ap.parse_args(); trav, distill, out = _A.trav, _A.distill, _A.out
t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)

tr = sqlite3.connect(f"file:{trav}?mode=ro", uri=True)
meta = {}
for k, v in tr.execute("SELECT key, value FROM meta"):
    try: meta[k] = json.loads(v)
    except Exception: meta[k] = v
R = int(meta["R"])
haps = [h for (h,) in tr.execute("SELECT hap FROM haps ORDER BY hid")]
paths = tr.execute("SELECT pid, path, hid, orient, relation, excluded, ntok, bp FROM paths ORDER BY pid").fetchall()
P = {p[0]: p for p in paths}
cols = [c[1] for c in tr.execute("PRAGMA table_info(trav)")]
rows = tr.execute(f"SELECT {', '.join(cols)} FROM trav").fetchall()
ci = {c: i for i, c in enumerate(cols)}
log(f"R {R:,}  通過 {len(rows):,}  パス {len(paths):,}")

# ---- ビン ----
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

# ---- 配列 ----
X = get_array(tr, "x_of_dense").astype(np.int64); K = get_array(tr, "kind")
is_anchor = ((K == 1) | (K == 2)) & (X >= 0)
p_off = np.load(f"{distill}/p_off.npy"); p_tok = np.load(f"{distill}/p_tok.npy", mmap_mode="r")
try: p_start = np.load(f"{distill}/p_start.npy")
except Exception: p_start = None
log("配列を読んだ")

# ---- 反復の判定（以前の markRepeats を窓に依らずパス全体で）----
NEED = 10
rep = {}; trim = {}
by_pid = defaultdict(list)
for r in rows: by_pid[r[ci["pid"]]].append(r)
nchk = 0
for pid, trs in by_pid.items():
    if len(trs) < 2: continue
    trs.sort(key=lambda r: r[ci["i0"]])
    def anchors_in(r, a, b):
        global nchk
        i0, i1 = r[ci["i0"]], r[ci["i1"]]; off = int(p_off[pid])
        tk = np.asarray(p_tok[off + i0: off + i1 + 1], dtype=np.int64)
        m = is_anchor[tk]; xs = X[tk][m]
        nchk += 1
        return int(((xs >= a) & (xs <= b)).sum())
    gx0, gx1 = trs[0][ci["x0"]], trs[0][ci["x1"]]; members = [trs[0]]
    for r in trs[1:]:
        rx0, rx1 = r[ci["x0"]], r[ci["x1"]]
        ov = min(gx1, rx1) - max(gx0, rx0) + 1
        if ov >= 0.5 * min(gx1 - gx0 + 1, rx1 - rx0 + 1):
            a, b = max(gx0, rx0), min(gx1, rx1)
            nr = anchors_in(r, a, b); ng = 0
            if nr >= NEED:
                for m in members:
                    ng += anchors_in(m, a, b)
                    if ng >= NEED: break
            isrep = nr >= NEED and ng >= NEED; rep[r[ci["id"]]] = 1 if isrep else 0
            if isrep: gx0, gx1 = min(gx0, rx0), max(gx1, rx1); members.append(r); continue
            if nr < NEED: trim[r[ci["id"]]] = (a, b)
            elif ng < NEED: trim[members[-1][ci["id"]]] = (a, b)
        gx0, gx1 = rx0, rx1; members = [r]
log(f"反復の判定 {len(rep):,} 行（読み {nchk:,} 回）、trim {len(trim):,}")

# ---- コンティグの情報（以前の addContigInfo）----
ext = {}
for p in paths:
    pid, path, hid = p[0], p[1], p[2]; a = int(p_start[pid]) if p_start is not None and pid < len(p_start) else 0
    k = (hid, path); e = ext.get(k)
    ext[k] = [a, a + p[7]] if e is None else [min(e[0], a), max(e[1], a + p[7])]

# ---- 主な向き（以前の contigDirs）----
dsum = defaultdict(float)
for r in rows: dsum[r[ci["pid"]]] += r[ci["dir"]] * r[ci["bp"]]
bykey = defaultdict(float)
for p in paths: bykey[(p[2], p[1])] += dsum.get(p[0], 0.0)
cdir = [1 if bykey[(p[2], p[1])] >= 0 else -1 for p in paths]

# ---- 書く ----
if os.path.exists(out): os.remove(out)
o = sqlite3.connect(out); o.execute("PRAGMA journal_mode=OFF"); o.execute("PRAGMA synchronous=OFF")
base = [c for c in cols if c not in ("x0",)]
o.execute(f"CREATE TABLE trav_b(bin INT, x0 INT, {', '.join(c + ' INT' for c in base)}, rep INT, trim0 INT, trim1 INT, cs INT, ce INT, fs INT, fe INT, cs0 INT, ceL INT, PRIMARY KEY(bin, x0, id)) WITHOUT ROWID")
outrows = []
for r in rows:
    pid = r[ci["pid"]]; p = P[pid]; a = int(p_start[pid]) if p_start is not None and pid < len(p_start) else 0
    b0 = r[ci["bp0"]] or 0; fs = 1 if r[ci["i0"]] <= 1 else 0; fe = 1 if r[ci["i1"]] >= p[6] - 2 else 0
    e = ext[(p[2], p[1])]; tid = r[ci["id"]]; tm = trim.get(tid, (-1, -1))
    outrows.append((bin_of(r[ci["x0"]], r[ci["x1"]]), r[ci["x0"]], *[r[ci[c]] for c in base], rep.get(tid, -1), tm[0], tm[1],
                    a + b0, a + b0 + r[ci["bp"]], fs, fe, 1 if (fs and a == 0) else 0, 1 if (fe and a + p[7] >= e[1]) else 0))
outrows.sort(key=lambda t: (t[0], t[1], t[2]))
o.executemany(f"INSERT INTO trav_b VALUES ({','.join('?' * len(outrows[0]))})", outrows)
log(f"trav_b {len(outrows):,}")

cc = [c[1] for c in tr.execute("PRAGMA table_info(copies)")]
crs = tr.execute(f"SELECT {', '.join(cc)} FROM copies").fetchall(); cix = {c: i for i, c in enumerate(cc)}
cbase = [c for c in cc if c != "x0"]
o.execute(f"CREATE TABLE copies_b(bin INT, x0 INT, {', '.join(c + ' INT' for c in cbase)}, PRIMARY KEY(bin, x0, id)) WITHOUT ROWID")
co = sorted(((bin_of(r[cix["x0"]], r[cix["x1"]]), r[cix["x0"]], *[r[cix[c]] for c in cbase]) for r in crs), key=lambda t: (t[0], t[1], t[2]))
if co: o.executemany(f"INSERT INTO copies_b VALUES ({','.join('?' * len(co[0]))})", co)
log(f"copies_b {len(co):,}")

# 反復: 以前の /range と同じ補間（同じパスで重なる通過ごとに 1 行。通過の錨の数 tnanch を残し、画面の床で絞れるように）
rq = tr.execute("SELECT r.id, r.pid, r.hid, r.i0, r.i1, r.bp, t.x0, t.x1, t.i0, t.i1, t.dir, t.nanch FROM reps r JOIN trav t ON t.pid = r.pid AND t.i0 <= r.i1 AND t.i1 >= r.i0").fetchall()
o.execute("CREATE TABLE reps_b(bin INT, x0 INT, seq INT, id INT, pid INT, hid INT, i0 INT, i1 INT, bp INT, x1 INT, tnanch INT, PRIMARY KEY(bin, x0, seq)) WITHOUT ROWID")
ro = []
for rid, pid, hid, i0, i1, bp, tx0, tx1, ti0, ti1, d, tn in rq:
    L = max(1, ti1 - ti0); f0 = max(0.0, min(1.0, (i0 - ti0) / L)); f1 = max(0.0, min(1.0, (i1 - ti0) / L))
    a0, a1 = (f0, f1) if d >= 0 else (1 - f1, 1 - f0)
    x0 = int(np.floor(tx0 + a0 * (tx1 - tx0) + 0.5)); x1 = int(np.floor(tx0 + a1 * (tx1 - tx0) + 0.5))   # JS の Math.round と同じ（.5 は上へ）
    ro.append((bin_of(min(x0, x1), max(x0, x1)), x0, len(ro), rid, pid, hid, i0, i1, bp, x1, tn))
ro.sort(key=lambda t: (t[0], t[1], t[2]))
o.executemany("INSERT INTO reps_b VALUES (?,?,?,?,?,?,?,?,?,?,?)", ro)
log(f"reps_b {len(ro):,}")

# ---- 染色体の帯（以前の travChroms と同じ規則）----
atoms = tr.execute("SELECT x0, x1 FROM atoms ORDER BY x0").fetchall()
seed = str((meta.get("params") or {}).get("seed_ref", "") if isinstance(meta.get("params"), dict) else "")
refp = next((p for p in paths if seed and sample_of(p[1]).lower() == seed.lower()), paths[0] if paths else None)
ref_hid = refp[2] if refp else -1
hapsmp = {h.split("#")[0] for h in haps}
def contig(p):
    c = contig_of(p) if "#" in p else p; smp = p.split("#")[0] if "#" in p else ""   # 4 項目の PanSN（…#MT#0）は 3 項目目（11-17）
    if smp and c.startswith(smp + "."): return c[len(smp) + 1:]
    if "#" not in p:
        d = c.find(".")
        if d > 0 and c[:d] in hapsmp: return c[d + 1:]
    return c
def key(p):
    c = contig(p); c = c[3:] if c.lower().startswith("chr") else c
    return c.lower()
cr = [r for r in rows if r[ci["nanch"]] >= 1000] or [r for r in rows if r[ci["nanch"]] >= 10]
cr.sort(key=lambda r: r[ci["x0"]])
lab = []; k = 0; act = []
for ax0, ax1 in atoms:
    m = (ax0 + ax1) / 2
    while k < len(cr) and cr[k][ci["x0"]] <= m: act.append(cr[k]); k += 1
    act = [r for r in act if r[ci["x1"]] >= m]
    best = None
    for r in act:
        if r[ci["hid"]] == ref_hid and (best is None or r[ci["nanch"]] > best[ci["nanch"]]): best = r
    if best is not None: lab.append((contig(P[best[ci["pid"]]][1]), True)); continue
    cnt = {}; show = {}
    for r in act:
        pth = P[r[ci["pid"]]][1]; kk = key(pth); cnt[kk] = cnt.get(kk, 0) + 1; show.setdefault(kk, contig(pth))
    top, n = "", 0
    for kk, v in cnt.items():
        if v > n: top, n = kk, v
    lab.append((show[top] if (n >= 3 and n * 2 > len(act) and top) else "", False))
bands = []
for (ax0, ax1), (nm, isref) in zip(atoms, lab):
    last = bands[-1] if bands else None
    same = last is not None and (last[2] == nm or key(last[2]) == key(nm)) and bool(last[2]) == bool(nm)
    if same:
        last[1] = ax1
        if isref and not last[3]: last[2] = nm
        last[3] = last[3] or isref
    else: bands.append([ax0, ax1, nm, isref])
i = 1
while i + 1 < len(bands):
    if not bands[i][2] and bands[i - 1][2] and key(bands[i - 1][2]) == key(bands[i + 1][2]):
        bands[i - 1][1] = bands[i + 1][1]; bands[i - 1][3] = bands[i - 1][3] or bands[i + 1][3]; del bands[i:i + 2]; continue
    i += 1
tiny = max(1, R * 0.002); i = 1
while i < len(bands):
    if not bands[i][2] and bands[i][1] - bands[i][0] < tiny: bands[i - 1][1] = bands[i][1]; del bands[i]; continue
    i += 1
small = max(1, R * 0.01)
if len(bands) > 1 and not bands[0][2] and bands[0][1] - bands[0][0] < small: bands[1][0] = bands[0][0]; bands.pop(0)
if len(bands) > 1 and not bands[-1][2] and bands[-1][1] - bands[-1][0] < small: bands[-2][1] = bands[-1][1]; bands.pop()
o.execute("CREATE TABLE chroms(x0 INT, x1 INT, name TEXT, ref INT)")
o.executemany("INSERT INTO chroms VALUES (?,?,?,?)", [(b[0], b[1], b[2], 1 if b[3] else 0) for b in bands])
log(f"chroms {len(bands)}")

st = os.stat(trav)
o.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
o.executemany("INSERT INTO meta VALUES (?,?)", [("format", "1"), ("R", str(R)), ("shifts", json.dumps(shifts)), ("offsets", json.dumps(offsets)),
               ("trav_size", str(st.st_size)), ("trav_mtime", str(int(st.st_mtime))), ("cdir", json.dumps(cdir)), ("built", time.strftime("%Y-%m-%d %H:%M"))])
o.commit(); o.execute("VACUUM"); o.close()
log(f"→ {out}（{os.path.getsize(out)/1e6:.1f} MB）")

# ---- 配列ファイル ----
arrs = {}
xb = get_array(tr, "xbp")
if xb is not None: arrs["xbp"] = np.asarray(xb, dtype=np.int64)
xf = get_array(tr, "x_fill")
if xf is not None:
    v = np.asarray(xf, dtype=np.int64); v = v[(v >= 0) & (v <= R)]
    cnt = np.bincount(v, minlength=R + 1)[:R + 1]
    arrs["nleafcum"] = np.concatenate([[0], np.cumsum(cnt)]).astype(np.int64)   # [x] ＝ x 未満の数（長さ R+2）
xo = get_array(tr, "x_of_dense")
if xo is not None:
    od = np.asarray(xo, np.int64).copy()
    if xf is not None:
        xfa = np.asarray(xf, np.int64); m = min(len(od), len(xfa)); sel = (od[:m] < 0) & (xfa[:m] >= 0); od[:m][sel] = xfa[:m][sel]
    arrs["order"] = od.astype(np.int32)
dx = get_array(tr, "dense_of_x")
if dx is not None: arrs["dense_of_x"] = np.asarray(dx, dtype=np.int32)
if _A.db:   # 参照座標: 本体の ref_contigs の名前のパスに沿って bp を足し上げる（パスの開始 p_start から）
    mc = sqlite3.connect(f"file:{_A.db}?mode=ro", uri=True)
    rcrows = mc.execute("SELECT contig_id, ref_key, name FROM ref_contigs").fetchall()
    rc = {nm: cid for cid, _k, nm in rcrows}; rck = {(str(k).lower(), nm): cid for cid, k, nm in rcrows}
    def cid_of(pn):   # 名前がそのまま（GRCh38.chr13）か、PanSN（GCF_000148365.1#1#NC_017631.1）で頭が ref_key・最後の # の後がコンティグ名
        if pn in rc: return rc[pn]
        if "#" in pn:
            ctg = contig_of(pn); head = pn.split("#")[0].lower()
            for (k, nm), cid in rck.items():
                if nm == ctg and (head == k or head.startswith(k + ".") or head.startswith(k)): return cid
        return None
    dnames = open(f"{distill}/p_names.txt").read().split("\n")
    sid = np.load(f"{distill}/s_id.npy").astype(np.int64)
    try: so_ = np.load(f"{distill}/s_seq_off.npy").astype(np.int64); sbp = so_[1:] - so_[:-1]
    except Exception: sbp = np.load(f"{distill}/s_bp.npy").astype(np.int64)
    NB = int(sid.max()) + 1; bpd = np.zeros(NB, np.int64); bpd[sid] = sbp
    refbp = np.full(NB, np.iinfo(np.int64).max, np.int64); refcid = np.full(NB, -1, np.int32)
    p_ori_ = np.load(f"{distill}/p_ori.npy", mmap_mode="r"); rc_ = np.zeros(NB, np.float64); rs_ = np.zeros(NB, np.float64)
    p_start_ = np.load(f"{distill}/p_start.npy") if os.path.exists(f"{distill}/p_start.npy") else None
    nref = 0
    for pi, nm in enumerate(dnames):
        cid = cid_of(nm)
        if cid is None: continue
        tk = np.asarray(p_tok[int(p_off[pi]): int(p_off[pi + 1])], np.int64)
        if not len(tk): continue
        ps = (int(p_start_[pi]) if p_start_ is not None else 0) + np.concatenate([[0], np.cumsum(bpd[tk])[:-1]])
        better = ps < refbp[tk]; np.minimum.at(refbp, tk, ps); refcid[tk[better]] = cid; nref += 1
        oo = np.asarray(p_ori_[int(p_off[pi]): int(p_off[pi + 1])], np.float64); bw = np.maximum(bpd[tk], 1).astype(np.float64)
        np.add.at(rc_, tk, bw); np.add.at(rs_, tk, oo * bw)
    refbp[refbp == np.iinfo(np.int64).max] = -1
    arrs["refbp"] = refbp; arrs["refcid"] = refcid
    arrs["refori"] = np.where(rc_ > 0, (rs_ * 2 >= rc_).astype(np.int8), np.int8(-1)).astype(np.int8)
    log(f"参照座標: 参照パス {nref}、座標のあるノード {int((refbp >= 0).sum()):,}")
hdr = {}; pos = 4096
for nm, a in arrs.items(): hdr[nm] = [pos, str(a.dtype), int(a.size)]; pos += a.nbytes; pos = (pos + 4095) // 4096 * 4096
hb = json.dumps(hdr).encode(); assert len(hb) < 4096
with open(out + ".arr.tmp", "wb") as f:
    f.write(hb + b" " * (4096 - len(hb)))
    for nm, a in arrs.items():
        f.seek(hdr[nm][0]); f.write(np.ascontiguousarray(a).tobytes())
os.replace(out + ".arr.tmp", out + ".arr")
log(f"→ {out}.arr（{os.path.getsize(out + '.arr')/1e9:.2f} GB、{', '.join(arrs)}）")
