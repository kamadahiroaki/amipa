#!/usr/bin/env python3
"""リードのラベル <db>.rlabel（2026-11-17）: リード名 → ラベル（例: トリオの子のリードの父由来・母由来・不明）を、リード索引 <db>.reads の整列 id に写す。

使い方: reads_labels.py <db> --labels SAMPLE=TSV [--labels SAMPLE=TSV ...] [--out <db>.rlabel]

TSV: 1 行 1 リード、タブ区切りで「リード名<TAB>ラベル」（3 列目以降は無視）。# で始まる行と空行は飛ばす。
  ラベルの決め方はこの段の外（trio binning の yak triobin、whatshap haplotag --output-haplotag-list など）。
  リード名は GAF の 1 列目（= <db>.reads の read_aln.read_name）と同じ文字列で突き合わせる。
  同じリードの複数の整列（supplementary など）は同じラベルになる。表に無いリードはラベル無し（閲覧側は「no label」）。
サンプルは <db>.reads の read_src.sample_id で引く。指定しなかったサンプルのリードはラベル無し。

ファイル: SQLite。
  label(lid INTEGER PRIMARY KEY, sample_no INTEGER, label TEXT)      -- サンプルごとのラベルの辞書（出現順）
  aln_label(aln_id INTEGER PRIMARY KEY, lid INTEGER)                 -- 整列 → ラベル
  meta(key, value)                                                   -- format=1, reads_size（.reads と組か確かめる）, built, 件数
<db>.reads は読むだけ（変えない）。ラベルを差し替えるときはこの段だけ流し直す（整列もタイル索引も作り直さない）。
"""
import argparse, json, os, sqlite3, sys, time

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("db"); ap.add_argument("--labels", action="append", required=True, metavar="SAMPLE=TSV")
ap.add_argument("--reads", help="リード索引（既定 <db>.reads）"); ap.add_argument("--out", help="出力（既定 <db>.rlabel）")
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
reads = a.reads or a.db + ".reads"; out = a.out or a.db + ".rlabel"
if not os.path.exists(reads): sys.exit(f"リード索引が無い: {reads}")
rd = sqlite3.connect(f"file:{reads}?mode=ro", uri=True)
if "read_name" not in {r[1] for r in rd.execute("PRAGMA table_info(read_aln)")}:
    sys.exit("リード索引にリード名が無い（--reads-no-names で作った）。ラベルは名前で突き合わせるので付けられない")
sn_of = {sid: sn for sn, sid in rd.execute("SELECT sample_no, sample_id FROM read_src")}

tmp = out + ".tmp"
if os.path.exists(tmp): os.remove(tmp)
db = sqlite3.connect(tmp); db.execute("PRAGMA journal_mode=OFF"); db.execute("PRAGMA synchronous=OFF")
db.execute("CREATE TABLE label(lid INTEGER PRIMARY KEY, sample_no INTEGER, label TEXT)")
db.execute("CREATE TABLE aln_label(aln_id INTEGER PRIMARY KEY, lid INTEGER)")
db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
summary = {}
for spec in a.labels:
    if "=" not in spec: sys.exit(f"--labels は SAMPLE=TSV の形で指定する: {spec}")
    sample, tsv = spec.split("=", 1)
    if sample not in sn_of: sys.exit(f"リード索引に無いサンプル: {sample}（あるのは {', '.join(sorted(sn_of))}）")
    sn = sn_of[sample]
    # 1. 表を読む（リード名 → ラベル番号）
    lid_of = {}; name_lid = {}; bad = 0
    with open(tsv) as f:
        for line in f:
            if not line.strip() or line.startswith("#"): continue
            p = line.rstrip("\n").split("\t")
            if len(p) < 2 or not p[1]: bad += 1; continue
            lab = p[1]
            if lab not in lid_of:
                lid = db.execute("INSERT INTO label(sample_no, label) VALUES (?, ?)", (sn, lab)).lastrowid; lid_of[lab] = lid
            name_lid[p[0]] = lid_of[lab]
    log(f"{sample}: 表 {len(name_lid):,} 本・ラベル {len(lid_of)} 種（{', '.join(lid_of)}）" + (f"・読めない行 {bad:,}" if bad else ""))
    # 2. そのサンプルの整列を読み流して突き合わせる（名前の索引を 1 本ずつ引くより速い）
    n_aln = n_hit = 0; hit_names = set(); buf = []
    for aid, nm in rd.execute("SELECT aln_id, read_name FROM read_aln WHERE sample_no=?", (sn,)):
        n_aln += 1; lid = name_lid.get(nm)
        if lid is None: continue
        n_hit += 1; hit_names.add(nm); buf.append((aid, lid))
        if len(buf) >= 200000: db.executemany("INSERT INTO aln_label VALUES (?, ?)", buf); buf = []
    if buf: db.executemany("INSERT INTO aln_label VALUES (?, ?)", buf)
    per = dict(db.execute("SELECT l.label, COUNT(*) FROM aln_label a JOIN label l ON l.lid=a.lid WHERE l.sample_no=? GROUP BY l.label", (sn,)).fetchall())
    summary[sample] = dict(aln=n_aln, labeled=n_hit, table=len(name_lid), table_used=len(hit_names), per_label=per)
    log(f"{sample}: 整列 {n_aln:,} 本のうちラベル付き {n_hit:,}（{100*n_hit/max(1,n_aln):.1f}%）・表のリードのうち整列にあった {len(hit_names):,}/{len(name_lid):,}  {per}")
    if n_aln and not n_hit: print(f"  ★{sample}: 1 本も一致しない。表の 1 列目が GAF のリード名（1 列目）と同じ書き方か確かめる", file=sys.stderr)
db.executemany("INSERT INTO meta VALUES (?, ?)", [("format", "1"), ("reads_size", str(os.path.getsize(reads))), ("built", time.strftime("%Y-%m-%d %H:%M:%S")), ("summary", json.dumps(summary, ensure_ascii=False))])
db.commit(); db.close(); os.replace(tmp, out)
log(f"済: {os.path.getsize(out)/1e6:.1f} MB → {out}")
