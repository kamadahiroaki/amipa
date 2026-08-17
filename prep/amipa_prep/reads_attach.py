#!/usr/bin/env python3
"""
reads_attach.py — リード整列（オンデマンド取得）をアトラスに足す。

per-read 行はアトラス本体に入れない。実体は **seekable zstd の GAF**（`zstd_seek.py`。行単位で
ランダム取得できる）に持ち、DB 側は「索引＋サマリ」だけを **サイドカー `<db>.reads`** に入れる。
**base の多層 DB は一切改変しない**（annot と同じ ATTACH 方式）。base からは葉サイズと
maxlayer を読むだけ（読取専用）。

サイドカーに作るもの:
  read_src(sample_no PK, sample_id, path, container, n_reads)  -- サンプル→実体ファイル
  node_reads(gfa_id PK, postings BLOB)                         -- 転置索引: ノード→通過リード aln_id(delta+varint)
  read_aln(aln_id PK, sample_no, voff, read_name)              -- read→位置(voff=非圧縮バイトオフセット)
  read_cov(node_name PK, depth)                                -- 概観ヒートマップ用(葉平均深度)
  edge_read_support(source, target, support)                   -- エッジ太さ(base の edges は触らない)
  read_meta(key, value)                                        -- scheme/容器の設定/base_db 等
実体 = 各サンプルの `<out-dir>/<sample>.gaf.zst`。取得は voff→フレーム→そのフレームだけ展開。

★保存するのは**表示に要る列だけ**。既定で塩基クオリティ `bq:Z` を落とす（`--drop-tags` で変更可）。
  HiFi の GAF は 1 行 ~20KB の **70% が bq:Z** だが、ビューアは一切使わない。落とした上で zstd に
  すると、同じ内容が BGZF の **1/8** に収まる（HPRC の HiFi GAF 256MiB で実測: BGZF 51MB →
  タグ選別 + zstd-9 で 6MB）。元の GAF は入力として手元に残るので、捨てるのは複製の側だけ。

★per-visit の read_node（WG で 73 億行）は持たない。node_reads（gfa_id 毎 1 blob）に畳む。
  キーは GFA セグメント id（= 葉 node_name "n{id}"）のみ＝座標にも id 順にも依存しない
  （ノードが動いても、層構成が変わっても、同じ GFA から作った別のアトラスに付け替えられる）。

使い方:
  reads_attach.py BASE_DB --reads HG002=hg002.gaf[.gz] --reads HG003=... --out-dir <実体の保存先>
                          [--sidecar <path>] [--level 6] [--frame-bytes 1048576]
"""
import sys, os, re, time, sqlite3, argparse, gzip, array
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from zstd_seek import SeekableZstdWriter, DEFAULT_FRAME_BYTES, DEFAULT_LEVEL  # 容器（形式の正）

TOK = re.compile(r'([<>])(\d+)')

# 保存時に捨てる GAF タグ（2 文字のタグ名）。既定は塩基クオリティのみ。
# ビューアが読むのは 1..12 列と tp:A / cg:Z / cs:Z だけなので、これ以外を落としても表示は変わらない。
# 「知らないタグは残す」側に倒してある（落とすのは大きさが分かっている物だけ）。
DEFAULT_DROP_TAGS = ("bq",)


def _open_text(path):
    return gzip.open(path, "rt") if path.endswith(".gz") else open(path)


def _write_varint(buf, v):
    """LEB128 unsigned varint を bytearray buf に追記(Rust write_varint と同一)。"""
    while True:
        b = v & 0x7f
        v >>= 7
        if v:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            break


def load_leaf_sizes(con):
    """葉 n{id} の size を id 添字 numpy 配列で返す(depth 計算用)。DB は 1 回だけ走査。"""
    ids = array.array('q'); szs = array.array('q')
    cur = con.cursor()
    cur.execute("SELECT node_name, size FROM nodes NOT INDEXED "
                "WHERE is_bubble=0 AND node_name GLOB 'n[0-9]*'")
    while True:
        recs = cur.fetchmany(1_000_000)
        if not recs:
            break
        for nm, size in recs:
            ids.append(int(nm[1:])); szs.append(int(size) if size else 0)
    if len(ids) == 0:
        raise SystemExit("FATAL: 葉 n{id} が無い（対象 DB が多層アトラスか確認）")
    ids = np.frombuffer(ids, dtype=np.int64); szs = np.frombuffer(szs, dtype=np.int64)
    size_arr = np.zeros(int(ids.max()) + 1, dtype=np.int64)
    size_arr[ids] = szs
    return size_arr


def main():
    ap = argparse.ArgumentParser(description="オンデマンド版リード索引の構築（サイドカー＋転置索引）。")
    ap.add_argument("db", help="base 多層 DB（読取専用: 葉サイズ・maxlayer を読むだけ。改変しない）")
    ap.add_argument("--reads", action="append", required=True, metavar="SAMPLE=GAF")
    ap.add_argument("--out-dir", required=True, help="リード実体(<sample>.gaf.zst)の保存先")
    ap.add_argument("--sidecar", help="read 索引を書くサイドカー DB（既定 <db>.reads）")
    ap.add_argument("--level", type=int, default=DEFAULT_LEVEL,
                    help=f"zstd 圧縮レベル（既定 {DEFAULT_LEVEL}）。上げると容量は減るが構築が遅くなる")
    ap.add_argument("--frame-bytes", type=int, default=DEFAULT_FRAME_BYTES,
                    help=f"1 フレームの非圧縮サイズ（既定 {DEFAULT_FRAME_BYTES}）。"
                         "大きいほど容量は減り、1 行取得あたりの展開量は増える")
    ap.add_argument("--drop-tags", default=",".join(DEFAULT_DROP_TAGS),
                    help=f"保存時に捨てる GAF タグ（コンマ区切り、既定 {','.join(DEFAULT_DROP_TAGS)}）。"
                         "ビューアが使わない大きなタグを落とすのが容量に一番効く。"
                         "空文字を渡すと何も落とさない")
    ap.add_argument("--no-cov", action="store_true", help="read_cov(深度サマリ) を作らない")
    ap.add_argument("--no-rust", action="store_true",
                    help="reads_core(Rust)を使わず純 Python 経路で構築(検証・フォールバック用)")
    args = ap.parse_args()

    drop_tags = [t.strip() for t in args.drop_tags.split(",") if t.strip()]
    for t in drop_tags:
        if len(t) != 2:
            raise SystemExit(f"--drop-tags は 2 文字のタグ名で指定する: {t!r}")

    samples = []
    for spec in args.reads:
        s, g = spec.split("=", 1)
        if not os.path.exists(g):
            raise SystemExit(f"GAF が無い: {g}")
        samples.append((s, g))
    os.makedirs(args.out_dir, exist_ok=True)
    sidecar = args.sidecar or (args.db + ".reads")

    # --- base DB(読取専用)から葉サイズ + maxlayer ---
    t0 = time.time()
    print(f"葉サイズ読込中(base 読取専用: {args.db}) ...", file=sys.stderr)
    base = sqlite3.connect(f"file:{os.path.abspath(args.db)}?mode=ro", uri=True)
    size_arr = load_leaf_sizes(base)
    ml = base.execute("SELECT maxlayer FROM stats LIMIT 1").fetchone()[0]
    base.close()
    print(f"  葉サイズ: maxid={len(size_arr)-1:,}  maxlayer={ml} ({time.time()-t0:.1f}s)", file=sys.stderr)
    depth_bases = np.zeros(len(size_arr), dtype=np.float64)

    # --- サイドカー DB にスキーマ(base は触らない) ---
    con = sqlite3.connect(sidecar)
    cur = con.cursor()
    cur.execute("PRAGMA synchronous=OFF")
    cur.execute("PRAGMA temp_store=MEMORY")
    cur.execute("PRAGMA cache_size=-2000000")
    # 旧スキーマ(read_node / bgzf_path 時代の read_src)も含めて作り直す（冪等）
    for t in ("read_node", "node_reads", "read_aln", "read_src", "read_cov", "edge_read_support"):
        cur.execute(f"DROP TABLE IF EXISTS {t}")
    cur.execute("CREATE TABLE read_src(sample_no INTEGER PRIMARY KEY, sample_id TEXT, "
                "path TEXT, container TEXT, n_reads INTEGER)")
    cur.execute("CREATE TABLE read_aln(aln_id INTEGER PRIMARY KEY, sample_no INTEGER, "
                "voff INTEGER, read_name TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS read_meta(key TEXT PRIMARY KEY, value TEXT)")
    con.commit()

    INS_SRC = ("INSERT INTO read_src(sample_no,sample_id,path,container,n_reads) "
               "VALUES(?,?,?,'zstd',0)")

    def out_path(sample_id):
        return os.path.abspath(os.path.join(args.out_dir, f"{sample_id}.gaf.zst"))

    def write_meta(con, aln_id, max_depth, skip):
        meta = {"scheme": "ondemand-zstd-inv", "container": "zstd",
                "zstd_level": str(args.level), "frame_bytes": str(args.frame_bytes),
                "dropped_tags": ",".join(drop_tags),   # 保存時に捨てた GAF タグ（正直に残す）
                "samples": ",".join(s for s, _ in samples),
                "n_samples": str(len(samples)), "n_aln": str(aln_id),
                "max_depth": repr(max_depth), "skip_rate": f"{skip:.4f}",
                "maxlayer": str(ml), "base_db": os.path.abspath(args.db),
                "out_dir": os.path.abspath(args.out_dir)}
        for k, v in meta.items():
            con.execute("INSERT OR REPLACE INTO read_meta VALUES(?,?)", (k, v))

    def report_sizes():
        ti = tz = 0
        for sid, gaf in samples:
            o = out_path(sid)
            if os.path.exists(o):
                i = os.path.getsize(gaf); z = os.path.getsize(o)
                ti += i; tz += z
                print(f"  {sid}: 入力 {i/2**30:.1f}GiB → 保存 {z/2**30:.2f}GiB "
                      f"（入力比 {z/i*100:.0f}%）", file=sys.stderr)
        if ti:
            print(f"  計: 入力 {ti/2**30:.1f}GiB → 保存 {tz/2**30:.2f}GiB "
                  f"（捨てたタグ: {','.join(drop_tags) or 'なし'}、zstd-{args.level}）",
                  file=sys.stderr)

    if not args.no_rust:
        # ===== Rust 経路(reads_core): 容器の書込・voff 採取・GAF 走査・read_aln/node_reads/
        #       edge_read_support/read_cov すべて Rust。Python はスキーマ+read_src+read_meta のみ。=====
        sample_nos, sample_ids, gaf_paths = [], [], []
        for sample_no, (sample_id, gaf) in enumerate(samples):
            cur.execute(INS_SRC, (sample_no, sample_id, out_path(sample_id)))
            sample_nos.append(sample_no); sample_ids.append(sample_id); gaf_paths.append(gaf)
        con.commit(); con.close()             # Rust が同じサイドカーを開くので閉じる
        import reads_core
        t1 = time.time()
        per_nreads, tot, miss, max_depth = reads_core.build_reads(
            sidecar, sample_nos, sample_ids, gaf_paths, os.path.abspath(args.out_dir),
            size_arr, int(ml), bool(args.no_cov), int(args.frame_bytes), int(args.level),
            drop_tags)
        aln_id = int(sum(per_nreads))
        skip = miss / tot if tot else 0.0
        print(f"[rust] build_reads: {time.time()-t1:.1f}s  per-sample n_reads={per_nreads}  "
              f"tot={tot:,} miss={miss:,} skip={skip*100:.2f}%", file=sys.stderr)
        con = sqlite3.connect(sidecar)
        write_meta(con, aln_id, max_depth, skip)
        con.commit(); con.close()
        report_sizes()
        print(f"完了(rust,サイドカー={sidecar}): aln={aln_id:,}  node_reads(転置索引)済  "
              f"max_depth={max_depth:.2f}  skip={skip*100:.2f}%", file=sys.stderr)
        return

    # ===== --no-rust 純 Python 経路(検証・フォールバック) =====
    RA = "INSERT INTO read_aln(aln_id,sample_no,voff,read_name) VALUES(?,?,?,?)"
    ra_batch = []
    postings = {}   # gfa_id -> list[aln_id](昇順)

    def flush():
        if ra_batch:
            cur.executemany(RA, ra_batch); ra_batch.clear()
        con.commit()

    aln_id = 0
    tot = miss = 0
    edge_sup = {}   # 葉↔葉リード横断数(無向 sorted pair)
    dropset = {t + ":" for t in drop_tags}    # "bq" → 行中の "bq:..." を落とす

    def out_line(cols, line):
        """保存する行（要らないタグを落とした物）。Rust 側と同じ規則。"""
        if not dropset or len(cols) <= 12:
            return line
        return "\t".join(cols[:12] + [t for t in cols[12:] if t[:3] not in dropset]) + "\n"
    for sample_no, (sample_id, gaf) in enumerate(samples):
        out = out_path(sample_id)
        cur.execute(INS_SRC, (sample_no, sample_id, out))
        n_reads = 0
        print(f"[{sample_id}] zstd 化＋索引: {gaf} → {out}", file=sys.stderr)
        w = SeekableZstdWriter(out, frame_bytes=args.frame_bytes, level=args.level)
        with _open_text(gaf) as f:
            for line in f:
                if line.startswith("@"):
                    w.write_line(line.encode()); continue
                cols = line.rstrip("\n").split("\t")
                voff = w.write_line(out_line(cols, line).encode())   # 行頭の非圧縮オフセット
                if len(cols) < 12:
                    continue
                aln_id += 1; n_reads += 1
                path = cols[5]
                try:
                    path_start = int(cols[7]); path_end = int(cols[8])
                except ValueError:
                    continue
                ra_batch.append((aln_id, sample_no, voff, cols[0]))
                offset = 0
                seen_here = set()
                prev_gid = None
                for m in TOK.finditer(path):
                    tot += 1
                    gid = int(m.group(2))
                    seg = int(size_arr[gid]) if 0 <= gid < size_arr.shape[0] else 0
                    if seg == 0:
                        miss += 1
                        prev_gid = None
                        continue
                    if gid not in seen_here:
                        postings.setdefault(gid, []).append(aln_id)   # 転置索引に追記(昇順)
                        seen_here.add(gid)
                    a0 = max(path_start, offset); a1 = min(path_end, offset + seg)
                    if a1 > a0:
                        depth_bases[gid] += (a1 - a0)
                    if prev_gid is not None and prev_gid != gid:
                        key = (prev_gid, gid) if prev_gid < gid else (gid, prev_gid)
                        edge_sup[key] = edge_sup.get(key, 0) + 1
                    prev_gid = gid
                    offset += seg
                if len(ra_batch) >= 200000:
                    flush()
        w.close()
        cur.execute("UPDATE read_src SET n_reads=? WHERE sample_no=?", (n_reads, sample_no))
        print(f"[{sample_id}] reads={n_reads:,}  zstd={os.path.getsize(out):,}B", file=sys.stderr)
    flush()

    print("node_reads(転置索引 blob) 書込中 ...", file=sys.stderr)
    cur.execute("CREATE TABLE node_reads(gfa_id INTEGER PRIMARY KEY, postings BLOB)")
    nr_batch = []
    for gid in sorted(postings.keys()):
        blob = bytearray()
        prev = 0
        for a in postings[gid]:      # 既に昇順
            _write_varint(blob, a - prev); prev = a
        nr_batch.append((gid, bytes(blob)))
        if len(nr_batch) >= 200000:
            cur.executemany("INSERT INTO node_reads VALUES(?,?)", nr_batch); nr_batch.clear()
    if nr_batch:
        cur.executemany("INSERT INTO node_reads VALUES(?,?)", nr_batch)
    cur.execute("CREATE INDEX idx_read_aln_name ON read_aln(read_name)")
    con.commit()

    # edge_read_support(サイドカー表; base の edges は触らない)。両向き。
    cur.execute("CREATE TABLE edge_read_support(source TEXT, target TEXT, support INTEGER)")
    esrows = []
    for (a, b), cnt in edge_sup.items():
        esrows.append((f"n{a}", f"n{b}", cnt)); esrows.append((f"n{b}", f"n{a}", cnt))
    for i in range(0, len(esrows), 200000):
        cur.executemany("INSERT INTO edge_read_support VALUES(?,?,?)", esrows[i:i+200000])
    cur.execute("CREATE INDEX idx_ers ON edge_read_support(source,target)")
    con.commit()
    print(f"edge_read_support: {len(edge_sup):,} 葉↔葉エッジ(maxlayer={ml} は backend で適用)", file=sys.stderr)

    if not args.no_cov:
        print("read_cov(深度サマリ) 書込中 ...", file=sys.stderr)
        cur.execute("CREATE TABLE read_cov(node_name TEXT PRIMARY KEY, depth REAL)")
        with np.errstate(divide='ignore', invalid='ignore'):
            depth = np.where(size_arr > 0, depth_bases / np.maximum(size_arr, 1), 0.0)
        rows = []
        for gid in np.nonzero(depth > 0)[0]:
            rows.append((f"n{int(gid)}", float(depth[gid])))
            if len(rows) >= 200000:
                cur.executemany("INSERT INTO read_cov VALUES(?,?)", rows); rows.clear()
        cur.executemany("INSERT INTO read_cov VALUES(?,?)", rows)
        con.commit()
        max_depth = float(depth.max()) if depth.size else 0.0
    else:
        max_depth = 0.0

    skip = miss / tot if tot else 0.0
    write_meta(con, aln_id, max_depth, skip)
    con.commit()
    con.close()
    report_sizes()
    print(f"完了(py,サイドカー={sidecar}): aln={aln_id:,}  node_reads(転置索引)済  "
          f"max_depth={max_depth:.2f}  skip={skip*100:.2f}%", file=sys.stderr)


if __name__ == "__main__":
    main()
