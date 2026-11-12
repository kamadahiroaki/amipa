#!/usr/bin/env python3
"""グラフのタイル（<db>.tiled の nodes_t / nodes_big）と同じ並びで、ノードの合意座標を持つサイドカー <db>.tiledx（2026-11-12）。
設計 amipa-lab/plans/viewer-cold-bounded.md ①（.tiled を作り直さず、同じ鍵 (layer, mkey, id) の別ファイルにした）。

使い方: tiled_x.py <db>.tiled <db>.trav <db>.distill <out>.tiledx

以前は、グラフに見えているノードの合意座標を、画面が名前の一覧で /trav/locate に問い合わせ、サーバが super 表を名前で 1 件ずつ引いていた
（スーパーノード 2 万件で初回 26〜39 秒。名前の番号は画面上の近さと関係なく散るので、1 件ごとに別のページを読む）。
ここで、グラフの /nodes が読むのと同じ (layer, mkey, id) の順に座標を並べる。/nodes は同じ範囲を連続して読むので、座標がグラフの返事に載る。

nx(layer, mkey, id, tx, tk, tf, ta, tb) WITHOUT ROWID … nodes_big の行は mkey = -1。値は /trav/locate と同じ規則:
  葉（n<元 id>）: 錨なら tx = x_of_dense、tk = kind。錨でなく x_fill があれば tx = x_fill、tk = 6。どちらも無ければ tx = -1、tk = kind
  スーパーノード（葉でない名前。G<番号>・S<番号> など英字 1 文字＋番号）: super 表の x・frac・xmin・xmax、tk = -2。無ければ tx = -1、tk = -1
"""
import json, os, sqlite3, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trav_arrays import get_array

tiled, trav, distill, out = sys.argv[1:5]
t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
tr = sqlite3.connect(f"file:{trav}?mode=ro", uri=True)
X = get_array(tr, "x_of_dense").astype(np.int64); K = get_array(tr, "kind").astype(np.int64)
XF = get_array(tr, "x_fill"); XF = np.asarray(XF, np.int64) if XF is not None else np.full(len(X), -1, np.int64)
if len(XF) < len(X): XF = np.concatenate([XF, np.full(len(X) - len(XF), -1, np.int64)])
meta = {k: v for k, v in tr.execute("SELECT key, value FROM meta")}
ident = str(meta.get("id_identity", "")).lower() in ("true", "1") or json.load(open(f"{distill}/meta.json")).get("dense_identity", False)
if ident: orig2dense = None
else:   # dense → 元 id（id_map、1 始まり）を逆に引く
    im = np.load(f"{distill}/id_map.npy").astype(np.int64); order = np.argsort(im); ims = im[order]
    def orig2dense(v):
        p = np.searchsorted(ims, v); p = np.minimum(p, len(ims) - 1); return np.where(ims[p] == v, order[p] + 1, -1)
# super のスーパーノード（葉 n<番号> 以外。鍵＝先頭の文字の符号 × 2^40 ＋ 番号）
rows = tr.execute("SELECT unicode(substr(name, 1, 1)) * 1099511627776 + CAST(substr(name, 2) AS INTEGER), x, frac, xmin, xmax FROM super WHERE name NOT GLOB 'n[0-9]*' AND substr(name, 2) GLOB '[0-9]*'").fetchall()
S = np.array(rows, np.float64) if rows else np.zeros((0, 5)); del rows
so = np.argsort(S[:, 0]); S = S[so]; sk = S[:, 0].astype(np.int64)
log(f"配列 {len(X):,}、スーパーノード {len(S):,}、id 同一 {ident}")

if os.path.exists(out): os.remove(out)
o = sqlite3.connect(out); o.execute("PRAGMA journal_mode=OFF"); o.execute("PRAGMA synchronous=OFF"); o.execute("PRAGMA page_size=4096")
o.execute("CREATE TABLE nx(layer INT, mkey INT, id INT, tx INT, tk INT, tf REAL, ta INT, tb INT, PRIMARY KEY(layer, mkey, id)) WITHOUT ROWID")
td = sqlite3.connect(f"file:{tiled}?mode=ro", uri=True)
def convert(R):
    lay = R[:, 0]; mk = R[:, 1]; nid = R[:, 2]; isn = R[:, 3] == 1; key = R[:, 4]
    tx = np.full(len(R), -1, np.int64); tk = np.full(len(R), -1, np.int64); tf = np.full(len(R), np.nan); ta = np.full(len(R), -1, np.int64); tb = np.full(len(R), -1, np.int64)
    # 葉
    d = key[isn] if orig2dense is None else orig2dense(key[isn]); ok = (d >= 0) & (d < len(X)); idx = np.flatnonzero(isn)[ok]; dd = d[ok]
    xa = X[dd]; xf = XF[dd]; kk = K[dd]
    tx[idx] = np.where(xa >= 0, xa, np.where(xf >= 0, xf, -1)); tk[idx] = np.where(xa >= 0, kk, np.where(xf >= 0, 6, kk))
    # スーパーノード
    gi = np.flatnonzero(R[:, 3] == 2)
    if len(gi) and len(sk):
        p = np.searchsorted(sk, key[gi]); p = np.minimum(p, len(sk) - 1); hit = sk[p] == key[gi]; g = gi[hit]; q = p[hit]
        tx[g] = S[q, 1].astype(np.int64); tf[g] = S[q, 2]; ta[g] = S[q, 3].astype(np.int64); tb[g] = S[q, 4].astype(np.int64); tk[g] = -2
    return [(int(a), int(b), int(c), int(e), int(f), None if np.isnan(h) else float(h), int(i) if i >= 0 else None, int(j) if j >= 0 else None)
            for a, b, c, e, f, h, i, j in zip(lay, mk, nid, tx, tk, tf, ta, tb)]
TYPE = ("CASE WHEN name GLOB 'n[0-9]*' THEN 1 WHEN substr(name, 2) GLOB '[0-9]*' THEN 2 ELSE 0 END, "
        "CASE WHEN name GLOB 'n[0-9]*' THEN CAST(substr(name, 2) AS INTEGER) WHEN substr(name, 2) GLOB '[0-9]*' THEN unicode(substr(name, 1, 1)) * 1099511627776 + CAST(substr(name, 2) AS INTEGER) ELSE -1 END")
n = 0
for tbl, q in (("nodes_t", f"SELECT layer, mkey, id, {TYPE} FROM nodes_t"), ("nodes_big", f"SELECT layer, -1, id, {TYPE} FROM nodes_big ORDER BY layer, id")):
    cur = td.execute(q)
    while True:
        rs = cur.fetchmany(1_000_000)
        if not rs: break
        o.executemany("INSERT INTO nx VALUES (?,?,?,?,?,?,?,?)", convert(np.array(rs, np.int64))); n += len(rs)
        if n % 10_000_000 < 1_000_000: log(f"  {tbl} {n:,}")
st = os.stat(tiled)
o.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
o.executemany("INSERT INTO meta VALUES (?,?)", [("format", "1"), ("tiled_size", str(st.st_size)), ("trav_size", str(os.stat(trav).st_size)), ("n", str(n)), ("built", time.strftime("%Y-%m-%d %H:%M"))])
o.commit(); o.close()
log(f"→ {out}（{n:,} 行、{os.path.getsize(out) / 1e9:.2f} GB）")
