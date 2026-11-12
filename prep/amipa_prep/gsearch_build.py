#!/usr/bin/env python3
"""遺伝子検索の索引 <db>.gsearch を作る（2026-11-12、genes 段の最後。設計 amipa-lab/plans/viewer-cold-bounded.md ⑤）。

使い方: gsearch_build.py <db>.genes <db>.trav <out>.gsearch

以前の検索は、名前の表を LIKE でなめた後、当たった遺伝子の株ごとの写し（全ゲノムで 1 遺伝子約 90 行）を 8.7 GB の .genes から
1 件ずつ引いていた（初回 3 秒＝ランダム読み約 270 回）。検索に要る量を 1 遺伝子 1 行に前もって集め、小さな別ファイルに置く。
検索 1 回で読むのは、索引の B-tree を 1〜2 回たどる数ページと、名前の順に並んだ要約の数ページだけ（.genes・.trav は読まない）。

表（遺伝子は参照の注釈＝写しでない行。sid は名前の小文字の順に振り直した番号で、前方一致で当たる遺伝子が同じページに並ぶ）:
- gsum(sid INTEGER PRIMARY KEY, gid, name, locus, type, pseudo, product, nhap, ncopy, x0, x1, places)
    nhap/ncopy … 座標のある写し（自分を含む）の株数・数。x0/x1 … その写しの座標の和集合。places … 写しが 1 Mb 以上離れた
    いくつかの場所に分かれるときだけ、場所ごとの [x0, x1, 株数] の JSON（ふつうは NULL）
- gkey(key, sid) WITHOUT ROWID … 小文字の検索語: 名前・locus（版番号つき／なし）・GFF の gene_synonym・Alias・hgnc_id。
    前方一致は key >= q AND key < q の次 の範囲で引く（LIKE … NOCASE は索引を使えない）
- gprod(sid INTEGER PRIMARY KEY, p) … 小文字の産物名。部分一致（3 文字以上）はこの表を全部なめる。全ゲノムで 6.3 万行・数 MB の連続読み
    （FTS5 の trigram は計算ノードの Python の SQLite に無かった。この大きさなら索引より依存の無い方を採る）
- gcopy(sid INTEGER PRIMARY KEY, c BLOB) … 写しごとの (hid, x0, x1) を int32 で並べたもの。遺伝子を選んだときだけ 1 行読む
- meta … format, n_gene, n_copy, built, genes_size, genes_mtime（.genes が変わったら作り直す目印）
"""
import json, os, sqlite3, sys, time
import numpy as np
from collections import defaultdict

genes, trav, out = sys.argv[1:4]
t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)

tr = sqlite3.connect(f"file:{trav}?mode=ro", uri=True)
hid_of = dict(tr.execute("SELECT pid, hid FROM paths"))
g = sqlite3.connect(f"file:{genes}?mode=ro", uri=True)
has_proj = any(c[1] == "proj" for c in g.execute("PRAGMA table_info(gene)"))
has_x = g.execute("SELECT 1 FROM sqlite_master WHERE name='gene_x'").fetchone() is not None
if not has_x: sys.exit("gene_x が無い（genes_index.py を先に）")

canon = g.execute(f"SELECT gid, pid, name, locus, type, pseudo, product, fid FROM gene {'WHERE proj IS NULL' if has_proj else ''}").fetchall()
log(f"参照の注釈 {len(canon):,}")
# 写し（自分を含む）の座標。全行を 1 回順に読む
cp = defaultdict(list)
q = f"SELECT {'coalesce(g.proj, g.gid)' if has_proj else 'g.gid'}, g.pid, x.x0, x.x1 FROM gene g JOIN gene_x x ON x.gid = g.gid"
n_copy = 0
for c, pid, a, b in g.execute(q):
    if a is None or a < 0: continue
    cp[c].append((hid_of.get(pid, -1), a, b)); n_copy += 1
log(f"座標のある写し {n_copy:,}")

# GFF の遺伝子の行から別名。fid の順に 900 件ずつまとめて引く（1 件ずつだと 8.7 GB の .genes をランダムに 6.3 万回読み、全ゲノムで 9 分かかった）
def parse_attrs(t):
    d = {}
    for kv in (t or "").split(";"):
        if "=" in kv: k, v = kv.split("=", 1); d[k.strip()] = v.strip()
    return d
fids = sorted({r[7] for r in canon if r[7] is not None}); attrs = {}
for i in range(0, len(fids), 900):
    ch = fids[i:i + 900]
    for fid, t in g.execute(f"SELECT fid, attrs FROM feature WHERE fid IN ({','.join('?' * len(ch))}) ORDER BY fid", ch): attrs[fid] = t
log(f"別名の行 {len(attrs):,}")
def attrs_of(fid): return parse_attrs(attrs.get(fid)) if fid is not None else {}

def norm(s): return (s or "").strip().lower()
canon.sort(key=lambda r: (norm(r[2]) or norm(r[3]), r[0]))

if os.path.exists(out): os.remove(out)
o = sqlite3.connect(out); o.execute("PRAGMA journal_mode=OFF"); o.execute("PRAGMA synchronous=OFF"); o.execute("PRAGMA page_size=4096")
o.executescript("""
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE gsum(sid INTEGER PRIMARY KEY, gid INT, name TEXT, locus TEXT, type TEXT, pseudo INT, product TEXT, nhap INT, ncopy INT, x0 INT, x1 INT, places TEXT);
CREATE TABLE gkey(key TEXT, sid INT, PRIMARY KEY(key, sid)) WITHOUT ROWID;
CREATE TABLE gcopy(sid INTEGER PRIMARY KEY, c BLOB);
CREATE TABLE gprod(sid INTEGER PRIMARY KEY, p TEXT);
""")
keys = []; nplace = 0
for sid, (gid, pid, name, locus, typ, pseudo, product, fid) in enumerate(canon, 1):
    cs = cp.get(gid, [])
    if cs:
        arr = np.array(cs, dtype=np.int64); arr = arr[np.argsort(arr[:, 1])]
        x0, x1 = int(arr[:, 1].min()), int(arr[:, 2].max()); nhap = len(set(arr[:, 0].tolist())); ncopy = len(arr)
        # 場所: 写しを x の順に並べ、前の場所の右端から 1 Mb 以上離れたら別の場所
        pl = []; cur = [int(arr[0, 1]), int(arr[0, 2]), {int(arr[0, 0])}]
        for h, a, b in arr[1:].tolist():
            if a - cur[1] > 1_000_000: pl.append(cur); cur = [a, b, {h}]
            else: cur[1] = max(cur[1], b); cur[2].add(h)
        pl.append(cur)
        places = json.dumps([[p[0], p[1], len(p[2])] for p in pl]) if len(pl) > 1 else None
        if places: nplace += 1
        blob = arr.astype(np.int32).tobytes()
    else:
        x0 = x1 = -1; nhap = ncopy = 0; places = None; blob = b""
    o.execute("INSERT INTO gsum VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (sid, gid, name, locus, typ, pseudo, product, nhap, ncopy, x0, x1, places))
    if blob: o.execute("INSERT INTO gcopy VALUES (?,?)", (sid, blob))
    if product: o.execute("INSERT INTO gprod VALUES (?,?)", (sid, product.lower()))
    ks = {norm(name), norm(locus)}
    if locus and "." in locus: ks.add(norm(locus.rsplit(".", 1)[0]))
    at = attrs_of(fid)
    for k in ("gene_synonym", "Alias", "hgnc_id"):
        for v in (at.get(k) or "").split(","): ks.add(norm(v))
    keys.extend((k, sid) for k in ks if k)
keys.sort()
o.executemany("INSERT OR IGNORE INTO gkey VALUES (?,?)", keys)
st = os.stat(genes)
o.executemany("INSERT INTO meta VALUES (?,?)", [("format", "1"), ("n_gene", str(len(canon))), ("n_copy", str(n_copy)), ("n_key", str(len(keys))), ("n_multi_place", str(nplace)),
               ("built", time.strftime("%Y-%m-%d %H:%M")), ("genes_size", str(st.st_size)), ("genes_mtime", str(int(st.st_mtime)))])
o.commit(); o.execute("VACUUM"); o.close()
log(f"→ {out}（{os.path.getsize(out)/1e6:.1f} MB、遺伝子 {len(canon):,}、検索語 {len(keys):,}、場所が分かれる遺伝子 {nplace}）")
