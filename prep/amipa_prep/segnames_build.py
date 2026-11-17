#!/usr/bin/env python3
"""セグメント名の表 <db>.segnames（2026-11-17）: 内部の葉の名前 n<整数> ↔ 元のグラフのセグメント名。

使い方: segnames_build.py <distill ディレクトリ> <out>.segnames

distill が名前モード（S 行の id に整数でないものがある）で seg_names.txt を書いたときだけ作る。
id がすべて整数のグラフでは作らず、あれば消す（内部名 n<整数> の n を外したものが元の名前なので表は要らない）。

ファイル: SQLite。segs(id INTEGER PRIMARY KEY, name TEXT)、索引 segs_name(name)、meta(key, value)（format=1, n, built）。
閲覧側は表示のたびに要る分だけを引く（id → 名前は主キー、名前 → id は索引を 1 回引くだけ）。
"""
import os, sqlite3, sys, time

if len(sys.argv) != 3:
    sys.exit(__doc__)
dist, out = sys.argv[1], sys.argv[2]
src = os.path.join(dist, "seg_names.txt")
if not os.path.exists(src):
    if os.path.exists(out):
        os.remove(out); print(f"名前モードでない（id はすべて整数）→ 古い {out} を消した")
    else:
        print("名前モードでない（id はすべて整数）→ 表は作らない")
    sys.exit(0)
t0 = time.time(); tmp = out + ".tmp"
if os.path.exists(tmp): os.remove(tmp)
db = sqlite3.connect(tmp); db.execute("PRAGMA journal_mode=OFF"); db.execute("PRAGMA synchronous=OFF")
db.execute("CREATE TABLE segs(id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
n = 0
with open(src) as f:
    batch = []
    for i, ln in enumerate(f, 1):
        batch.append((i, ln.rstrip("\n"))); n = i
        if len(batch) >= 500000: db.executemany("INSERT INTO segs VALUES (?, ?)", batch); batch = []
    if batch: db.executemany("INSERT INTO segs VALUES (?, ?)", batch)
db.execute("CREATE INDEX segs_name ON segs(name)")
db.executemany("INSERT INTO meta VALUES (?, ?)", [("format", "1"), ("n", str(n)), ("built", time.strftime("%Y-%m-%d %H:%M:%S"))])
db.commit(); db.close(); os.replace(tmp, out)
print(f"segnames: {n:,} 名 → {out}（{os.path.getsize(out) / 1e6:.1f} MB, {time.time() - t0:.1f} s）")
