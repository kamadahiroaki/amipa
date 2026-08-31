#!/usr/bin/env python3
"""
reads_attach.py — リード整列（オンデマンド取得）をアトラスに足す。

per-read 行はアトラス本体に入れない。実体は **seekable zstd の GAF**（`zstd_seek.py`。行単位で
ランダム取得できる）に持ち、DB 側は「索引＋サマリ」だけを **サイドカー `<db>.reads`** に入れる。
**base の多層 DB は一切改変しない**（annot と同じ ATTACH 方式）。base からは葉サイズと
maxlayer を読むだけ（読取専用）。

サイドカーに作るもの（チャンク追記型 v2）:
  read_src(sample_no PK, sample_id, path, container, n_reads)  -- サンプル→実体ファイル
  read_chunk(chunk_no PK, sample_no, base_aln_id, n_aln, n_visits)
                                                               -- 追記の単位（下記）
  node_reads(gfa_id, chunk_no, postings BLOB)                  -- 転置索引: ノード→通過リード
                                                               --   aln_id(チャンク内相対 delta+varint)
  read_aln(aln_id PK, sample_no, voff[, read_name])            -- read→位置(voff=非圧縮バイトオフセット)
  read_cov(node_name PK, depth, cov_bases)                     -- 概観ヒートマップ用(葉平均深度＋分子)
  edge_read_support(source, target, support)                   -- エッジ太さ(base の edges は触らない)
  read_meta(key, value)                                        -- scheme/容器の設定/base_db 等
実体 = 各サンプルの `<out-dir>/<sample>.gaf.zst`。取得は voff→フレーム→そのフレームだけ展開。

★チャンク（v2 で導入）: 転置索引はノード毎 1 blob ではなく **(ノード, チャンク) 毎 1 blob**。
  チャンクは「path のノード通過数が --chunk-visits に達するか、サンプルが替わったら閉じる」単位で、
  blob 内の delta は **チャンク内の相対 aln_id**（起点 read_chunk.base_aln_id）。これで
    1) 構築メモリがチャンク 1 個分で頭打ちになる（v1 は全リードの通過数に比例して 24GB/WG）
    2) `--append` でサンプルを後から足せる（既存チャンクの行は 1 行も書き換えない）
    3) delta の上限が 1 チャンクのリード数になり、ショートリード数十億本でも 32bit を溢れない
       （v1 は 2^32 本目以降、release ビルドの wrap で索引が黙って壊れた）
  read_cov / edge_read_support は追記のたびに丸ごと作り直す（分子 cov_bases を保存しているので
  加算が成立する。全書換でも INSERT の一括流し込みで、既存 blob の read-modify-write はしない）。

★保存するのは**表示に要る列だけ**。既定で塩基クオリティ `bq:Z` を落とす（`--drop-tags` で変更可）。
  HiFi の GAF は 1 行 ~20KB の **70% が bq:Z** だが、ビューアは一切使わない。落とした上で zstd に
  すると、同じ内容が BGZF の **1/8** に収まる（HPRC の HiFi GAF 256MiB で実測: BGZF 51MB →
  タグ選別 + zstd-9 で 6MB）。元の GAF は入力として手元に残るので、捨てるのは複製の側だけ。

★照合は「アトラスの葉の名前空間」で行う（v2）。葉 n{id} の id 集合を昇順配列に持ち、
  GAF path のトークンは二分探索（連番なら差分の直アクセス）で葉序数に解決する。
  v1 の「最大 id + 1 の密配列」をやめたので、id が疎（部分グラフ・非連番）でもメモリは葉数比例。
  構築前に先頭 1 万行で一致率を検査し、低ければ**その場で失敗する**（黙って捨てない）。

使い方:
  reads_attach.py BASE_DB --reads HG002=hg002.gaf[.gz] --reads HG003=... --out-dir <実体の保存先>
                          [--sidecar <path>] [--level 6] [--frame-bytes 1048576]
                          [--append] [--chunk-visits N] [--no-name-index]
"""
import sys, os, re, time, sqlite3, argparse, gzip, array
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from zstd_seek import SeekableZstdWriter, DEFAULT_FRAME_BYTES, DEFAULT_LEVEL  # 容器（形式の正）

TOK = re.compile(r'([<>])(\d+)')
LEAF_RE = re.compile(r'n(\d+)$')

# 保存時に捨てる GAF タグ（2 文字のタグ名）。既定は塩基クオリティのみ。
# ビューアが読むのは 1..12 列と tp:A / cg:Z / cs:Z だけなので、これ以外を落としても表示は変わらない。
# 「知らないタグは残す」側に倒してある（落とすのは大きさが分かっている物だけ）。
DEFAULT_DROP_TAGS = ("bq",)

# 1 チャンクの通過数予算。HiFi(1 通過 ~60bp)で 180 万リード/チャンク・postings ~1.5GB、
# ショートリード(1 リード 3-4 通過)でも同じメモリで 1.3 億リード/チャンク になる
# （チャンク数が read 長に依らずメモリで決まる）。
DEFAULT_CHUNK_VISITS = 500_000_000
# チャンク内 aln 数の上限（delta を 32bit に収める保険。visits 予算が先に効くのが普通）。
CHUNK_ALN_CAP = (1 << 32) - 2


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


def load_leaves(con):
    """葉 n{id} の (ids 昇順 int64, sizes 同順 int64) を返す。DB は 1 回だけ走査。

    v1 は「最大 id + 1」の密配列だったため、id が疎（WG の部分グラフ等）だと葉数と無関係に
    メモリを食った。v2 は実在する葉だけを持つ（照合は二分探索/連番なら直アクセス）。
    """
    ids = array.array('q'); szs = array.array('q')
    bad = 0
    cur = con.cursor()
    cur.execute("SELECT node_name, size FROM nodes NOT INDEXED WHERE is_bubble=0")
    while True:
        recs = cur.fetchmany(1_000_000)
        if not recs:
            break
        for nm, size in recs:
            m = LEAF_RE.fullmatch(nm)
            if not m:
                bad += 1
                continue
            ids.append(int(m.group(1))); szs.append(int(size) if size else 0)
    if len(ids) == 0:
        raise SystemExit("FATAL: 葉 n{id} が無い（対象 DB が多層アトラスか確認）")
    if bad:
        # 現行パイプラインの葉は必ず n<整数>。それ以外が居る=前提が変わっているので黙って進めない。
        raise SystemExit(f"FATAL: n<整数> でない葉が {bad:,} 個ある。"
                         "このアトラスの葉の名前空間には未対応（reads-node-id-space 計画を参照）")
    ids = np.frombuffer(ids, dtype=np.int64); szs = np.frombuffer(szs, dtype=np.int64)
    o = np.argsort(ids, kind="stable")
    ids, szs = ids[o], szs[o]
    keep = np.r_[True, ids[1:] != ids[:-1]]      # 層をまたぐ重複行を除去
    return np.ascontiguousarray(ids[keep]), np.ascontiguousarray(szs[keep])


class LeafMap:
    """GAF path トークン(整数 id) → 葉序数。連番なら O(1)、疎でも二分探索。"""

    def __init__(self, ids, sizes):
        self.ids = ids; self.sizes = sizes
        self.n = ids.size
        self.lo = int(ids[0]); self.hi = int(ids[-1])
        self.contig = (self.hi - self.lo + 1 == self.n)

    def ord_of(self, gid):
        """葉序数 or -1。"""
        if gid < self.lo or gid > self.hi:
            return -1
        if self.contig:
            return gid - self.lo
        i = int(np.searchsorted(self.ids, gid))
        return i if i < self.n and self.ids[i] == gid else -1


def precheck_match(gaf, lmap, sample_id, max_lines=10_000, min_match=0.5, force=False):
    """先頭 max_lines 行（整列行のみ）で path トークンの葉一致率を検査。

    低ければ **その場で失敗する**。v1 は skip_rate に記録するだけで完走してしまい、
    「リードが少ない」ようにしか見えなかった（沈黙する失敗）。
    """
    tot = hit = lines = 0
    with _open_text(gaf) as f:
        for line in f:
            if line.startswith("@"):
                continue
            cols = line.split("\t", 6)
            if len(cols) < 6:
                continue
            toks = TOK.findall(cols[5])
            if not toks:
                continue
            lines += 1
            for _, g in toks:
                tot += 1
                if lmap.ord_of(int(g)) >= 0:
                    hit += 1
            if lines >= max_lines:
                break
    if tot == 0:
        print(f"  [precheck] {sample_id}: path トークンが見つからない（未マップのみ？）— 続行", file=sys.stderr)
        return
    rate = hit / tot
    print(f"  [precheck] {sample_id}: 先頭 {lines:,} 整列行 一致 {hit:,}/{tot:,} ({rate*100:.1f}%)", file=sys.stderr)
    if rate < min_match and not force:
        raise SystemExit(
            f"FATAL: GAF のノード名がアトラスの葉と一致しない（一致率 {rate*100:.1f}% < {min_match*100:.0f}%）。\n"
            f"  ・`vg giraffe --named-coordinates` で整列したか\n"
            f"  ・整列に使った GFA がこのアトラスの元と同じか（dense 再番号 GFA ではないか）\n"
            f"  を確認する。承知の上で続けるなら --force-mismatch。")


def main():
    ap = argparse.ArgumentParser(description="オンデマンド版リード索引の構築（サイドカー＋転置索引）。")
    ap.add_argument("db", help="base 多層 DB（読取専用: 葉サイズ・maxlayer を読むだけ。改変しない）")
    ap.add_argument("--reads", action="append", required=True, metavar="SAMPLE=GAF")
    ap.add_argument("--out-dir", required=True, help="リード実体(<sample>.gaf.zst)の保存先")
    ap.add_argument("--sidecar", help="read 索引を書くサイドカー DB（既定 <db>.reads）")
    ap.add_argument("--append", action="store_true",
                    help="既存サイドカーに**サンプルを追記**する（v2 サイドカーのみ）。既存の "
                         "node_reads チャンク・read_aln・実体ファイルは触らず、read_cov と "
                         "edge_read_support だけ作り直す")
    ap.add_argument("--chunk-visits", type=int, default=DEFAULT_CHUNK_VISITS,
                    help=f"転置索引 1 チャンクのノード通過数予算（既定 {DEFAULT_CHUNK_VISITS:,}）。"
                         "小さいほど構築メモリが減り、チャンク数（読み出し時の blob 数）が増える")
    ap.add_argument("--no-name-index", action="store_true",
                    help="read_aln の read_name 列と名前索引を作らない。リード名での検索は不可になるが、"
                         "表示は GAF 行から名前を取るので変わらない。数十億リードでは索引だけで "
                         "数百 GB になるため、ショートリードのコホートではこれを推奨")
    ap.add_argument("--min-match", type=float, default=0.5,
                    help="構築前検査（先頭 1 万整列行）の一致率下限（既定 0.5）。下回ると失敗する")
    ap.add_argument("--force-mismatch", action="store_true",
                    help="構築前検査の一致率が低くても続行する")
    ap.add_argument("--level", type=int, default=DEFAULT_LEVEL,
                    help=f"zstd 圧縮レベル（既定 {DEFAULT_LEVEL}）。上げると容量は減るが構築が遅くなる")
    ap.add_argument("--frame-bytes", type=int, default=DEFAULT_FRAME_BYTES,
                    help=f"1 フレームの非圧縮サイズ（既定 {DEFAULT_FRAME_BYTES}）。"
                         "大きいほど容量は減り、1 行取得あたりの展開量は増える")
    ap.add_argument("--drop-tags", default=",".join(DEFAULT_DROP_TAGS),
                    help=f"保存時に捨てる GAF タグ（コンマ区切り、既定 {','.join(DEFAULT_DROP_TAGS)}）。"
                         "ビューアが使わない大きなタグを落とすのが容量に一番効く。"
                         "空文字を渡すと何も落とさない")
    ap.add_argument("--leafsize-cache", metavar="NPZ",
                    help="葉サイズ走査（全ゲノムで 30-40 分）の結果を置く npz。"
                         "既定は <db>.leafsizes.npz。base を読み取り専用で mount しているときは"
                         "書ける場所をここに渡す。base より新しいものだけ使う")
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

    # --- base DB(読取専用)から葉 id/size + maxlayer ---
    # ★この走査は全ゲノム(230GB, 共有FS)で **30-40 分の固定費**。base は静的なので npz に
    #   キャッシュし、base より新しいキャッシュがあれば即ロードする。
    #   既定は base の隣。base を読み取り専用で mount している場合は書けないので、
    #   --leafsize-cache で書ける場所を渡す（失敗しても止めない＝ただ遅いだけ）。
    t0 = time.time()
    cache = args.leafsize_cache or (os.path.abspath(args.db) + ".leafsizes.npz")
    leaf_ids = leaf_sizes = ml = None
    try:
        if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(args.db):
            z = np.load(cache)
            if "ids" in z:                                   # v2 形式
                leaf_ids, leaf_sizes, ml = z["ids"], z["sizes"], int(z["maxlayer"])
            elif "size_arr" in z:                            # v1 形式(密配列)から変換
                sa = z["size_arr"]; nz = np.nonzero(sa)[0]
                leaf_ids = nz.astype(np.int64); leaf_sizes = sa[nz].astype(np.int64)
                ml = int(z["maxlayer"])
            if leaf_ids is not None:
                print(f"  葉サイズ: キャッシュから即ロード {cache} ({time.time()-t0:.1f}s)", file=sys.stderr)
    except Exception as e:
        print(f"  葉サイズキャッシュを読めない({e}) → 走査し直す", file=sys.stderr)
        leaf_ids = None
    if leaf_ids is None:
        print(f"葉サイズ走査中(base 読取専用: {args.db}) ...", file=sys.stderr)
        base = sqlite3.connect(f"file:{os.path.abspath(args.db)}?mode=ro", uri=True)
        leaf_ids, leaf_sizes = load_leaves(base)
        ml = base.execute("SELECT maxlayer FROM stats LIMIT 1").fetchone()[0]
        base.close()
        try:
            np.savez_compressed(cache, ids=leaf_ids, sizes=leaf_sizes, maxlayer=np.int64(ml))
            print(f"  葉サイズ: キャッシュを保存 {cache}", file=sys.stderr)
        except Exception as e:
            print(f"  葉サイズキャッシュを保存できない({e}) 続行", file=sys.stderr)
    lmap = LeafMap(leaf_ids, leaf_sizes)
    print(f"  葉サイズ: 葉 {lmap.n:,} 個  id=[{lmap.lo:,},{lmap.hi:,}]"
          f"{'(連番)' if lmap.contig else '(疎: 二分探索)'}  maxlayer={ml} ({time.time()-t0:.1f}s)",
          file=sys.stderr)

    # --- 構築前検査（沈黙する取りこぼしの排除）---
    for sample_id, gaf in samples:
        precheck_match(gaf, lmap, sample_id, min_match=args.min_match, force=args.force_mismatch)

    # --- サイドカー DB のスキーマ(base は触らない) ---
    con = sqlite3.connect(sidecar)
    cur = con.cursor()
    cur.execute("PRAGMA synchronous=OFF")
    cur.execute("PRAGMA temp_store=MEMORY")
    cur.execute("PRAGMA cache_size=-2000000")

    name_index = not args.no_name_index
    base_aln_id = 0          # このランの aln_id の起点（append なら既存の続き）
    base_chunk_no = 0        # 同、チャンク番号
    sample_no_base = 0

    if args.append:
        have = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "read_chunk" not in have:
            raise SystemExit("FATAL: --append は v2（チャンク型）サイドカーにのみ使える。"
                             "旧形式は全サンプルを列挙して作り直す")
        existing = {r[0] for r in cur.execute("SELECT sample_id FROM read_src")}
        for s, _ in samples:
            if s in existing:
                raise SystemExit(f"FATAL: サンプル {s} は既にある（同名サンプルへの追記は未対応）")
        r = cur.execute("SELECT COALESCE(MAX(base_aln_id + n_aln),0), COALESCE(MAX(chunk_no)+1,0) "
                        "FROM read_chunk").fetchone()
        base_aln_id, base_chunk_no = int(r[0]), int(r[1])
        sample_no_base = int(cur.execute("SELECT COALESCE(MAX(sample_no)+1,0) FROM read_src").fetchone()[0])
        # 名前索引の有無は既存に合わせる（混在させない）
        cols = {r[1] for r in cur.execute("PRAGMA table_info(read_aln)")}
        name_index = "read_name" in cols
        if args.no_name_index and name_index:
            print("  [append] 既存が名前索引あり → --no-name-index は無視して合わせる", file=sys.stderr)
        print(f"  [append] 続きから: aln_id>{base_aln_id:,} chunk_no>={base_chunk_no} "
              f"sample_no>={sample_no_base}", file=sys.stderr)
    else:
        # 旧スキーマ(read_node / bgzf_path 時代の read_src)も含めて作り直す（冪等）
        for t in ("read_node", "node_reads", "read_aln", "read_src", "read_cov",
                  "edge_read_support", "read_chunk"):
            cur.execute(f"DROP TABLE IF EXISTS {t}")
        cur.execute("CREATE TABLE read_src(sample_no INTEGER PRIMARY KEY, sample_id TEXT, "
                    "path TEXT, container TEXT, n_reads INTEGER)")
        namecol = ", read_name TEXT" if name_index else ""
        cur.execute(f"CREATE TABLE read_aln(aln_id INTEGER PRIMARY KEY, sample_no INTEGER, "
                    f"voff INTEGER{namecol})")
        cur.execute("CREATE TABLE read_chunk(chunk_no INTEGER PRIMARY KEY, sample_no INTEGER, "
                    "base_aln_id INTEGER, n_aln INTEGER, n_visits INTEGER)")
        cur.execute("CREATE TABLE node_reads(gfa_id INTEGER, chunk_no INTEGER, postings BLOB)")
    cur.execute("CREATE TABLE IF NOT EXISTS read_meta(key TEXT PRIMARY KEY, value TEXT)")
    con.commit()

    INS_SRC = ("INSERT INTO read_src(sample_no,sample_id,path,container,n_reads) "
               "VALUES(?,?,?,'zstd',0)")

    def out_path(sample_id):
        return os.path.abspath(os.path.join(args.out_dir, f"{sample_id}.gaf.zst"))

    def write_meta(con, n_aln_total, max_depth, skip, n_chunks, depth_p99):
        all_samples = [r[0] for r in con.execute("SELECT sample_id FROM read_src ORDER BY sample_no")]
        meta = {"scheme": "ondemand-zstd-inv", "reads_schema": "chunked-v2",
                "leaf_key": "orig-int", "container": "zstd",
                "zstd_level": str(args.level), "frame_bytes": str(args.frame_bytes),
                "dropped_tags": ",".join(drop_tags),   # 保存時に捨てた GAF タグ（正直に残す）
                "samples": ",".join(all_samples),
                "n_samples": str(len(all_samples)), "n_aln": str(n_aln_total),
                "n_chunks": str(n_chunks), "chunk_visits": str(args.chunk_visits),
                "name_index": "1" if name_index else "0",
                "max_depth": repr(max_depth), "depth_p99": repr(depth_p99),
                "skip_rate": f"{skip:.4f}",
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
        for i, (sample_id, gaf) in enumerate(samples):
            sn = sample_no_base + i
            cur.execute(INS_SRC, (sn, sample_id, out_path(sample_id)))
            sample_nos.append(sn); sample_ids.append(sample_id); gaf_paths.append(gaf)
        con.commit(); con.close()             # Rust が同じサイドカーを開くので閉じる
        import reads_core
        t1 = time.time()
        per_nreads, tot, miss, max_depth, n_chunks, depth_p99 = reads_core.build_reads(
            sidecar, sample_nos, sample_ids, gaf_paths, os.path.abspath(args.out_dir),
            leaf_ids, leaf_sizes, int(ml), bool(args.no_cov), int(args.frame_bytes),
            int(args.level), drop_tags, int(args.chunk_visits), bool(name_index),
            bool(args.append), int(base_aln_id), int(base_chunk_no))
        n_aln_total = base_aln_id + int(sum(per_nreads))
        skip = miss / tot if tot else 0.0
        print(f"[rust] build_reads: {time.time()-t1:.1f}s  per-sample n_reads={per_nreads}  "
              f"tot={tot:,} miss={miss:,} skip={skip*100:.2f}%  chunks(+{n_chunks})", file=sys.stderr)
        con = sqlite3.connect(sidecar)
        nch = int(con.execute("SELECT COUNT(*) FROM read_chunk").fetchone()[0])
        write_meta(con, n_aln_total, max_depth, skip, nch, depth_p99)
        con.commit(); con.close()
        report_sizes()
        print(f"完了(rust,サイドカー={sidecar}): aln={n_aln_total:,}  node_reads(転置索引)済  "
              f"max_depth={max_depth:.2f}  skip={skip*100:.2f}%", file=sys.stderr)
        return

    # ===== --no-rust 純 Python 経路(検証・フォールバック) =====
    # Rust と**同じチャンク規則・同じバイト列**を出す（回帰の基準）。
    if name_index:
        RA = "INSERT INTO read_aln(aln_id,sample_no,voff,read_name) VALUES(?,?,?,?)"
    else:
        RA = "INSERT INTO read_aln(aln_id,sample_no,voff) VALUES(?,?,?)"
    ra_batch = []

    def flush():
        if ra_batch:
            cur.executemany(RA, ra_batch); ra_batch.clear()
        con.commit()

    # 既存の集計を読み戻す（append 時のみ）。cov は分子(cov_bases)を保存してあるので加算できる。
    cov_bases = np.zeros(lmap.n, dtype=np.int64)     # 葉序数添字
    edge_sup = {}   # 葉↔葉リード横断数(無向 sorted pair, 元 id)
    if args.append:
        for nm, cb in cur.execute("SELECT node_name, cov_bases FROM read_cov"):
            o = lmap.ord_of(int(nm[1:]))
            if o >= 0:
                cov_bases[o] = int(cb or 0)
        for s, t, sup in cur.execute("SELECT source, target, support FROM edge_read_support"):
            a, b = int(s[1:]), int(t[1:])
            if a < b:                                 # 両向き 2 行のうち片側だけ拾う
                edge_sup[(a, b)] = int(sup)

    aln_id = base_aln_id
    tot = miss = 0
    dropset = {t + ":" for t in drop_tags}    # "bq" → 行中の "bq:..." を落とす

    # チャンク状態
    chunk_no = base_chunk_no
    chunk_sample = None
    chunk_base = aln_id
    chunk_visits = 0
    postings = {}        # 葉序数 -> bytearray(delta+varint, チャンク内相対)
    last_local = {}      # 葉序数 -> 直前の chunk 内 aln_id

    def close_chunk():
        nonlocal chunk_no, chunk_base, chunk_visits
        n_aln_c = aln_id - chunk_base
        if n_aln_c == 0 and not postings:
            return
        nr = [(int(lmap.ids[o]), chunk_no, bytes(b)) for o, b in sorted(postings.items())]
        for i in range(0, len(nr), 200000):
            cur.executemany("INSERT INTO node_reads(gfa_id,chunk_no,postings) VALUES(?,?,?)",
                            nr[i:i+200000])
        cur.execute("INSERT INTO read_chunk(chunk_no,sample_no,base_aln_id,n_aln,n_visits) "
                    "VALUES(?,?,?,?,?)", (chunk_no, chunk_sample, chunk_base, n_aln_c, chunk_visits))
        con.commit()
        postings.clear(); last_local.clear()
        chunk_no += 1; chunk_base = aln_id; chunk_visits = 0

    def out_line(cols, line):
        """保存する行（要らないタグを落とした物）。Rust 側と同じ規則。"""
        if not dropset or len(cols) <= 12:
            return line
        return "\t".join(cols[:12] + [t for t in cols[12:] if t[:3] not in dropset]) + "\n"

    for i, (sample_id, gaf) in enumerate(samples):
        sample_no = sample_no_base + i
        out = out_path(sample_id)
        cur.execute(INS_SRC, (sample_no, sample_id, out))
        chunk_sample = sample_no
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
                if name_index:
                    ra_batch.append((aln_id, sample_no, voff, cols[0]))
                else:
                    ra_batch.append((aln_id, sample_no, voff))
                offset = 0
                seen_here = set()
                prev_gid = None
                local = aln_id - chunk_base
                for m in TOK.finditer(path):
                    tot += 1
                    gid = int(m.group(2))
                    o = lmap.ord_of(gid)
                    seg = int(lmap.sizes[o]) if o >= 0 else 0
                    if seg == 0:
                        miss += 1
                        prev_gid = None
                        continue
                    chunk_visits += 1
                    if gid not in seen_here:
                        buf = postings.get(o)
                        if buf is None:
                            buf = postings[o] = bytearray()
                        _write_varint(buf, local - last_local.get(o, 0))
                        last_local[o] = local
                        seen_here.add(gid)
                    a0 = max(path_start, offset); a1 = min(path_end, offset + seg)
                    if a1 > a0:
                        cov_bases[o] += (a1 - a0)
                    if prev_gid is not None and prev_gid != gid:
                        key = (prev_gid, gid) if prev_gid < gid else (gid, prev_gid)
                        edge_sup[key] = edge_sup.get(key, 0) + 1
                    prev_gid = gid
                    offset += seg
                if chunk_visits >= args.chunk_visits or (aln_id - chunk_base) >= CHUNK_ALN_CAP:
                    flush(); close_chunk()
                if len(ra_batch) >= 200000:
                    flush()
        w.close()
        flush(); close_chunk()                          # サンプル境界でチャンクを閉じる
        cur.execute("UPDATE read_src SET n_reads=? WHERE sample_no=?", (n_reads, sample_no))
        print(f"[{sample_id}] reads={n_reads:,}  zstd={os.path.getsize(out):,}B", file=sys.stderr)
    flush()

    if not args.append and name_index:
        cur.execute("CREATE INDEX idx_read_aln_name ON read_aln(read_name)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_node_reads ON node_reads(gfa_id, chunk_no)")
    con.commit()

    # edge_read_support(サイドカー表; base の edges は触らない)。両向き。追記時は丸ごと作り直す
    # （集計値の表なのでスキーマは v1 と同じ = viewer / tile_index は無改修で読める）。
    cur.execute("DROP TABLE IF EXISTS edge_read_support")
    cur.execute("CREATE TABLE edge_read_support(source TEXT, target TEXT, support INTEGER)")
    esrows = []
    for (a, b), cnt in edge_sup.items():
        esrows.append((f"n{a}", f"n{b}", cnt)); esrows.append((f"n{b}", f"n{a}", cnt))
    for i in range(0, len(esrows), 200000):
        cur.executemany("INSERT INTO edge_read_support VALUES(?,?,?)", esrows[i:i+200000])
    cur.execute("CREATE INDEX idx_ers ON edge_read_support(source,target)")
    con.commit()
    print(f"edge_read_support: {len(edge_sup):,} 葉↔葉エッジ(maxlayer={ml} は backend で適用)", file=sys.stderr)

    max_depth = depth_p99 = 0.0
    if not args.no_cov:
        print("read_cov(深度サマリ) 書込中 ...", file=sys.stderr)
        cur.execute("DROP TABLE IF EXISTS read_cov")
        cur.execute("CREATE TABLE read_cov(node_name TEXT PRIMARY KEY, depth REAL, cov_bases INTEGER)")
        with np.errstate(divide='ignore', invalid='ignore'):
            depth = np.where(lmap.sizes > 0, cov_bases / np.maximum(lmap.sizes, 1), 0.0)
        rows = []
        for o in np.nonzero(depth > 0)[0]:
            rows.append((f"n{int(lmap.ids[o])}", float(depth[o]), int(cov_bases[o])))
            if len(rows) >= 200000:
                cur.executemany("INSERT INTO read_cov VALUES(?,?,?)", rows); rows.clear()
        cur.executemany("INSERT INTO read_cov VALUES(?,?,?)", rows)
        con.commit()
        pos = depth[depth > 0]
        if pos.size:
            max_depth = float(pos.max())
            depth_p99 = float(np.sort(pos)[max(0, int(0.99 * pos.size) - 1)])

    skip = miss / tot if tot else 0.0
    n_aln_total = aln_id
    write_meta(con, n_aln_total, max_depth, skip, chunk_no, depth_p99)
    con.commit()
    con.close()
    report_sizes()
    print(f"完了(py,サイドカー={sidecar}): aln={n_aln_total:,}  node_reads(転置索引)済  "
          f"max_depth={max_depth:.2f}  skip={skip*100:.2f}%", file=sys.stderr)


if __name__ == "__main__":
    main()
