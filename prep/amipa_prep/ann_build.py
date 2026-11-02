#!/usr/bin/env python3
"""参照座標の注釈（RepeatMasker・GIAB ベンチマーク VCF と領域 BED）を <db>.ann サイドカーにする（2026-10-28。11-02 に functions/annot_trav/build_ann.py から prep の ann 段へ移した）。

使い方: ann_build.py --out <db>.ann --rmsk rmsk.txt.gz --vcf HG002=x.vcf.gz [--vcf ...] --bed HG002=x.bed [--bed ...] [--ref-key GRCh38]

座標はすべて参照（既定 GRCh38）の 0 始まり半開区間。DB の nodes.ref_bp も 0 始まりなので、塩基の段の列の参照位置（rb + ノード内オフセット）と直接比べられる。
- rmsk(contig, s, e, strand, name, cls, fam, div)   UCSC rmsk.txt（genoStart は 0 始まり）。div = milliDiv / 10（％、祖先配列からの分岐度）
- var(sample, contig, pos, ref, alt, gt)            VCF の POS − 1。多アレルは ALT をカンマのまま、gt は 0/1・1/1・1|0 など（GT 欄そのまま）
- bench(sample, contig, s, e)                       ベンチマーク領域（この外の変異の有無は GIAB では判定されていない）
- meta(key, value)                                  ref_key, maxlen_rmsk（重なり検索の幅）, 出典
"""
import argparse, gzip, os, sqlite3, time

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True); ap.add_argument("--rmsk"); ap.add_argument("--ref-key", default="GRCh38")
ap.add_argument("--vcf", action="append", default=[], metavar="SAMPLE=VCF"); ap.add_argument("--bed", action="append", default=[], metavar="SAMPLE=BED")
a = ap.parse_args()
T0 = time.time()
def log(m): print(f"[{time.time()-T0:6.1f}s] {m}", flush=True)
def op(p): return gzip.open(p, "rt") if p.endswith(".gz") else open(p)

tmp = a.out + ".tmp"
if os.path.exists(tmp): os.remove(tmp)
con = sqlite3.connect(tmp); cur = con.cursor()
cur.executescript("""
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE rmsk(contig TEXT, s INTEGER, e INTEGER, strand TEXT, name TEXT, cls TEXT, fam TEXT, div REAL);
CREATE TABLE var(sample TEXT, contig TEXT, pos INTEGER, ref TEXT, alt TEXT, gt TEXT);
CREATE TABLE bench(sample TEXT, contig TEXT, s INTEGER, e INTEGER);
""")
meta = {"ref_key": a.ref_key, "built": time.strftime("%Y-%m-%d %H:%M")}
if a.rmsk:
    rows = []; maxlen = 0
    for ln in op(a.rmsk):
        f = ln.rstrip("\n").split("\t")
        s, e = int(f[6]), int(f[7]); maxlen = max(maxlen, e - s)
        rows.append((f[5], s, e, f[9], f[10], f[11], f[12], int(f[2]) / 10.0))
    cur.executemany("INSERT INTO rmsk VALUES (?,?,?,?,?,?,?,?)", rows)
    meta["maxlen_rmsk"] = str(maxlen); meta["src_rmsk"] = os.path.basename(a.rmsk)
    log(f"rmsk {len(rows):,} 件（最長 {maxlen:,} bp）")
for sv in a.vcf:
    smp, p = sv.split("=", 1); rows = []
    for ln in op(p):
        if ln[0] == "#": continue
        f = ln.rstrip("\n").split("\t"); fmt = f[8].split(":"); val = f[9].split(":")
        gt = val[fmt.index("GT")] if "GT" in fmt else "."
        rows.append((smp, f[0], int(f[1]) - 1, f[3], f[4], gt))
    cur.executemany("INSERT INTO var VALUES (?,?,?,?,?,?)", rows); meta["src_vcf_" + smp] = os.path.basename(p)
    log(f"{smp}: 変異 {len(rows):,} 件")
for sb in a.bed:
    smp, p = sb.split("=", 1); rows = []
    for ln in op(p):
        f = ln.split("\t")
        if len(f) < 3 or ln[0] == "#": continue
        rows.append((smp, f[0], int(f[1]), int(f[2])))
    cur.executemany("INSERT INTO bench VALUES (?,?,?,?)", rows); meta["src_bed_" + smp] = os.path.basename(p)
    meta["maxlen_bench"] = str(max([int(meta.get("maxlen_bench", 0))] + [r[3] - r[2] for r in rows]))
    log(f"{smp}: ベンチマーク領域 {len(rows):,} 区間")
cur.executemany("INSERT INTO meta VALUES (?,?)", list(meta.items()))
cur.executescript("""
CREATE INDEX rmsk_cs ON rmsk(contig, s);
CREATE INDEX var_cp ON var(contig, pos);
CREATE INDEX bench_cs ON bench(sample, contig, s);
""")
con.commit(); con.execute("VACUUM"); con.close(); os.replace(tmp, a.out)
log(f"→ {a.out} ({os.path.getsize(a.out)/1e6:.1f} MB)")
