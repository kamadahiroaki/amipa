#!/usr/bin/env python3
"""遺伝子の写し（またはその株の注釈）ごとに、CDS を株の配列から組み立てて翻訳し、機能喪失の目安を返す（2026-10-27）。

使い方: gene_lof.py --db <main.db> --distill <dir> --genes <db.genes>   （stdin に {"gids": [...]}）
出力: {"genes": {gid: {"st": 状態, "aa": 長さ, "ref": 参照の長さ, "src": 元の gid}}, "n": 件数}
状態: ok / trunc（終止獲得: 参照の 9 割未満で止まる）/ fs（フレームシフト: CDS の長さが 3 の倍数の剰余で参照と違う）/
      nostart（開始コドンが無い・参照にはある）/ nocds（CDS が写っていない）
CDS は遺伝子ごとに CDS の合計 bp が最大の転写産物（親）の片を、ウォークの順に並べ、先頭の片はノード内オフセット so、末尾は eo で切る。
鎖が − なら全体を逆相補にしてから読む。参照（proj が無い元の遺伝子）も同じ方法で組み立てて比べるので、切り方の誤差は両方に同じく乗る。
"""
import sys, json, sqlite3, argparse
import numpy as np

ap = argparse.ArgumentParser(); ap.add_argument("--db", required=True); ap.add_argument("--distill", required=True); ap.add_argument("--genes", required=True)
a = ap.parse_args()
req = json.load(sys.stdin); gids = [int(x) for x in (req.get("gids") or [])][:5000]
p_off = np.load(a.distill + "/p_off.npy"); p_tok = np.load(a.distill + "/p_tok.npy", mmap_mode="r"); p_ori = np.load(a.distill + "/p_ori.npy", mmap_mode="r")
id_map = np.load(a.distill + "/id_map.npy", mmap_mode="r")
g = sqlite3.connect("file:%s?mode=ro" % a.genes, uri=True); m = sqlite3.connect("file:%s?mode=ro" % a.db, uri=True)
hasProj = any(r[1] == "proj" for r in g.execute("PRAGMA table_info(gene)"))
COMP = str.maketrans("ACGTNacgtn", "TGCANtgcan")
def rc(s): return s.translate(COMP)[::-1]
CODON = {}
bases = "TCAG"; aas = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"
for i, x in enumerate(bases):
    for j, y in enumerate(bases):
        for k, z in enumerate(bases): CODON[x + y + z] = aas[16 * i + 4 * j + k]

def parts_of(gid):
    rows = g.execute("SELECT f.parent, f.pid, t.s0, t.e0, t.so, t.eo, f.start, f.end FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.gid = ? AND f.type IN ('CDS','cds')", (gid,)).fetchall()
    if not rows: return None, None
    by = {}
    for r in rows: by.setdefault(r[0], []).append(r)
    best = max(by.values(), key=lambda v: sum(x[7] - x[6] + 1 for x in v))
    return best[0][1], sorted(best, key=lambda x: x[2])

def assemble(gid, strand):
    pid, parts = parts_of(gid)
    if not parts: return None
    a0 = int(p_off[pid]); toks = []; segs = []
    for (_p, _pid, s0, e0, so, eo, _s, _e) in parts:
        tk = np.asarray(p_tok[a0 + s0:a0 + e0]); oo = np.asarray(p_ori[a0 + s0:a0 + e0]); segs.append((tk, oo, so, eo))
        toks.extend(int(x) for x in tk)
    need = sorted(set(int(id_map[t - 1]) for t in toks)); seq = {}
    for i in range(0, len(need), 500):
        ch = need[i:i + 500]
        for lid, s in m.execute("SELECT leaf_id, seq FROM leaf_seq WHERE leaf_id IN (%s)" % ",".join("?" * len(ch)), ch): seq[int(lid)] = s
    out = []
    for tk, oo, so, eo in segs:
        # so・eo はノードの格納向きの 0 始まり。ウォークの向きに直す（逆向きに通ったノードは L-1-x）
        def L(t_): return len(seq.get(int(id_map[int(t_) - 1]), ""))
        if len(tk): so = so if oo[0] else L(tk[0]) - 1 - so; eo = eo if oo[-1] else L(tk[-1]) - 1 - eo
        ss = []
        for t_, o_ in zip(tk, oo):
            s = seq.get(int(id_map[int(t_) - 1]), "N"); ss.append(s if o_ else rc(s))
        if not ss: continue
        ss[-1] = ss[-1][:max(0, eo) + 1] if eo is not None else ss[-1]
        ss[0] = ss[0][max(0, so or 0):] if len(ss) > 1 else ss[0][max(0, so or 0):max(0, eo) + 1]
        out.append("".join(ss))
    cds = "".join(out).upper()
    return rc(cds) if strand == "-" else cds

def translate(cds):
    aa = []
    for i in range(0, len(cds) - 2, 3):
        x = CODON.get(cds[i:i + 3], "X"); aa.append(x)
        if x == "*": break
    return "".join(aa)

info = {}
for r in g.execute("SELECT gid, strand%s FROM gene WHERE gid IN (%s)" % (", proj" if hasProj else ", NULL", ",".join("?" * len(gids))), gids) if gids else []:
    info[int(r[0])] = (r[1], r[2])
cache = {}
def summary(gid, strand):
    if gid in cache: return cache[gid]
    try: cds = assemble(gid, strand)
    except Exception: cds = None
    if not cds: cache[gid] = None; return None
    p = translate(cds); stop = p.endswith("*")
    cache[gid] = dict(L=len(cds), aa=len(p) - (1 if stop else 0), stop=stop, start=cds[:3] in ("ATG", "GTG", "TTG")); return cache[gid]
res = {}
for gid in gids:
    if gid not in info: continue
    strand, src = info[gid]
    s = summary(gid, strand)
    if s is None: res[gid] = dict(st="nocds", src=src); continue
    ref = None
    if src is not None:
        rs = g.execute("SELECT strand FROM gene WHERE gid = ?", (src,)).fetchone(); ref = summary(int(src), rs[0]) if rs else None
    st = "ok"
    if ref:
        if (s["L"] - ref["L"]) % 3 != 0: st = "fs"
        elif s["aa"] < 0.9 * ref["aa"]: st = "trunc"
        elif ref["start"] and not s["start"]: st = "nostart"
    else:
        exp = s["L"] // 3 - 1
        if not s["start"]: st = "nostart"
        elif s["aa"] < 0.9 * exp: st = "trunc"
    res[gid] = dict(st=st, aa=s["aa"], ref=(ref["aa"] if ref else None), src=src)
print(json.dumps(dict(genes=res, n=len(res))))
