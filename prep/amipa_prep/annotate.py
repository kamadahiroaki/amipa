#!/usr/bin/env python3
"""ggb-annotate: 構築済み layered.db に外部アノテーショントラックを後付けする (Part B)。

設計: ANNOTATION_IMPL_PLAN.md / ANNOTATE_HOWTO.md。本体 DB の nodes/edges/*_rtree は不変。
アノテは **per-node の相乗り表 `node_annot`（node_rowid キー）** に保存する。これは coverage 系
(`node_contig_cov(node_rowid PK, blob)`) と同型で、viewer は rtree の rowid で node fetch に相乗り取得
できる。列は additive（トラック追加ごとに ALTER で増やす）。

  node_annot(node_rowid INTEGER PRIMARY KEY,
             band_id INTEGER, band_multi INTEGER,   -- band(ギムザ)
             region_class INTEGER,                    -- region(CHM13 セントロメア等)
             gene_cnt INTEGER, gene_blob BLOB)        -- gene 密度スカラー + 詳細 blob

  gene_blob = [u32 count] + count×(u32 feature_id, u32 seg_start, u32 seg_end, u8 exonic)   (LE)

== 効率(WG 1億ノード級) ==
rowid キーなので **GROUP BY node_name 不要**（各 layer 行を直接注記=順次フルスキャン, NOT INDEXED)。
gene は「ノード毎に重なる遺伝子」を per-contig 射影して blob 化 → 旧 node_feature の
idx(node_name)/idx(track,feature)/gene_count GROUP BY という **3大ソートが消える**。
書き込みは node_rowid の UPSERT。出力は chunk ストリームで RAM 有界。詳細は ANNOTATE_HOWTO.md。

== トラック ==
  --band  = 各ノードの GRCh38 ref_bp × UCSC cytoBand（区間結合, 外部ツール不要）
  --gene  = GRCh38 ref_bp × GENCODE GTF（区間結合。gene_blob + gene_cnt + gene_exons + goto 代表位置）
  --region= CHM13 座標 BED を CHM13 パス walk(distill)で射影。super-node は森 climb。goto 代表位置付き
"""
import argparse
import gzip
import json
import os
import re
import sqlite3
import struct
import sys

import numpy as np


def _open_text(path):
    return gzip.open(path, "rt") if path.endswith(".gz") else open(path, "rt")


# --- 大規模(WG)向け: 出力を全て貯めず chunk 単位で書き出しメモリ上限を切る ---
_READ_CHUNK = 2_000_000     # nodes の fetchmany 単位
_WRITE_CHUNK = 200_000      # executemany の 1 バッチ行数(blob 含むので控えめ)
_GENE_WIDE_LEN = 200_000    # gene 射影: これ超のノードは全走査, 以下は start 窓で絞る

# gene_blob の 1 レコード(13B, packed): feature_id/seg_start/seg_end(u32) + exonic(u8)
GENE_REC = np.dtype([("fid", "<u4"), ("s", "<u4"), ("e", "<u4"), ("ex", "u1")])
assert GENE_REC.itemsize == 13, GENE_REC.itemsize


def _pack_gene_blob(fids, ss, es, exs):
    """u32 count 前置き + GENE_REC 配列。node_hap_mult と同じ count-prefixed 方式。"""
    rec = np.empty(fids.size, GENE_REC)
    rec["fid"] = fids
    rec["s"] = ss
    rec["e"] = es
    rec["ex"] = exs
    return struct.pack("<I", int(fids.size)) + rec.tobytes()


def _executemany_chunked(cur, sql, rows_iter, con=None, chunk=_WRITE_CHUNK):
    """rows_iter を chunk 行ずつ executemany。con 指定時は chunk 毎に commit。総行数を返す。"""
    buf = []
    total = 0
    for r in rows_iter:
        buf.append(r)
        if len(buf) >= chunk:
            cur.executemany(sql, buf)
            total += len(buf)
            buf.clear()
            if con is not None:
                con.commit()
    if buf:
        cur.executemany(sql, buf)
        total += len(buf)
    if con is not None:
        con.commit()
    return total


def ensure_node_annot(cur, cols):
    """node_annot(node_rowid PK) を用意し、無い列を additive に ALTER 追加。"""
    cur.execute("CREATE TABLE IF NOT EXISTS node_annot(node_rowid INTEGER PRIMARY KEY)")
    have = {r[1] for r in cur.execute("PRAGMA table_info(node_annot)")}
    for name, typ in cols:
        if name not in have:
            cur.execute(f"ALTER TABLE node_annot ADD COLUMN {name} {typ}")


# 出力する列の順番（新規作成時。既存 DB の列順もこれに揃う）
_ANNOT_COLS = (("band_id", "INTEGER"), ("band_multi", "INTEGER"),
               ("gene_cnt", "INTEGER"), ("gene_blob", "BLOB"),
               ("region_class", "INTEGER"))


class AnnotAccum:
    """3 トラックの結果を **rowid をそのまま添字にした配列**へ貯め、最後に `node_annot` を
    **新規表として 1 回だけ rowid 昇順で** 書く。

    == なぜこうするか（2026-08-09 実測） ==
    旧実装は 3 トラックがそれぞれ `INSERT .. ON CONFLICT DO UPDATE` で同じ `node_annot` を
    書き換えていた。これが WG で致命的だった:
      ① band が 1 行 ~10B の行を 199.8M 行作る(2GB) → gene が `gene_blob`(平均 51B)を **後から
         足す**ので 1 行 ~62B に育つ ＝ **表全体が in-place で 6 倍**になりほぼ全ページが分割・再書き
      ② `journal_mode=delete` なので既存ページの更新は「元ページをジャーナルへ退避 + 本体書き」
         の 3 重。散らばった更新では全部がランダム I/O
      ③ gene は contig 順に flush するので rowid が全域に飛ぶ
    実測 (ann_pg2, PGGB 312.9GB): CPU 22.8% / **2,198 iops / 7.8 MB/s / 1 回 3.5KB**
    ＝ ページ単位のランダム I/O。同じ Lustre の順読みは 1,300-1,800 MB/s なので **0.5%**。

    新実装は書き込みが「新規表への rowid 昇順 INSERT」だけになる。新規ページには退避すべき
    元ページが無いのでジャーナルもほぼ空で、追記＝順次書きになる。

    == メモリ ==
    DB サイズではなく **(ノード, 層) の対の数 = LOD 木の生存ノード総数** で決まる。
    PGGB WG (199.8M 行) で band 1.0GB + gene_cnt 0.8GB + ptr 1.6GB + region 0.2GB
    + blob 実体(chr22 からの外挿で 4-10GB) ≒ 8-13GB。旧実装の maxvmem 82.5GB より小さい。
    """

    def __init__(self, con, con_path=None):
        self.con = con
        self.con_path = con_path
        self.n = int(con.execute("SELECT MAX(rowid) FROM nodes").fetchone()[0] or 0)
        self.band_id = None      # int32, -1 = 無し（band_id は 0 始まりなので 0 は有効値）
        self.band_multi = None   # int8,  -1 = 無し
        self.region = None       # int16, -1 = 無し
        self.gene_cnt = None     # int32,  0 = 無し（blob の count は必ず 1 以上）
        self.gene_ptr = None     # int64,  0 = 無し / それ以外は gene_buf 内 offset+1
        self.gene_buf = None     # bytearray（blob 長は 4+13*gene_cnt で復元できるので長さは持たない）

    # --- 遅延確保（走らせたトラックの列だけ確保する）---
    def _need_band(self):
        if self.band_id is None:
            self.band_id = np.full(self.n + 1, -1, np.int32)
            self.band_multi = np.full(self.n + 1, -1, np.int8)

    def _need_gene(self):
        if self.gene_cnt is None:
            self.gene_cnt = np.zeros(self.n + 1, np.int32)
            self.gene_ptr = np.zeros(self.n + 1, np.int64)
            self.gene_buf = bytearray()

    def _need_region(self):
        if self.region is None:
            self.region = np.full(self.n + 1, -1, np.int16)

    # --- 各トラックの投入口（旧実装のジェネレータをそのまま渡せる形）---
    def feed_band(self, rows):
        self._need_band()
        n = 0
        for rid, bid, multi in rows:
            self.band_id[rid] = bid
            self.band_multi[rid] = multi
            n += 1
        return n

    def feed_gene(self, rows):
        self._need_gene()
        n = 0
        buf = self.gene_buf
        for rid, cnt, blob in rows:
            self.gene_cnt[rid] = cnt
            self.gene_ptr[rid] = len(buf) + 1        # 1-based。0 を「無し」に使うため
            buf += blob
            n += 1
        return n

    def feed_region(self, rows):
        self._need_region()
        n = 0
        for rid, cls in rows:
            self.region[rid] = cls
            n += 1
        return n

    def load_existing(self, skip=(), sidecar_path=None):
        """既存 `node_annot` を順次読みして配列へ復元する。今回のトラックが上書きする列は
        `skip` で読み飛ばす（WG では gene_blob 列が 10GB 規模なので、gene を走らせる時に
        それを読まないだけで大きく違う）。部分再実行でも他トラックの値を失わないための処置。"""
        # サイドカーが在ればそちらを引き継ぐ（新方式の既定）。無ければ主 DB の旧 node_annot。
        src = self.con
        if sidecar_path and os.path.exists(sidecar_path):
            src = sqlite3.connect(f"file:{sidecar_path}?mode=ro", uri=True)
        have = {r[1] for r in src.execute("PRAGMA table_info(node_annot)")}
        if not have:
            return 0
        sel = [c for c, _ in _ANNOT_COLS if c in have and c not in skip]
        if not sel:
            return 0
        if "band_id" in sel or "band_multi" in sel:
            self._need_band()
        if "gene_cnt" in sel:
            self._need_gene()
        if "region_class" in sel:
            self._need_region()
        ix = {c: i + 1 for i, c in enumerate(sel)}
        cur = src.execute(
            f"SELECT node_rowid, {', '.join(sel)} FROM node_annot")   # PK 順 = rowid 順 = 順次
        n = 0
        while True:
            recs = cur.fetchmany(_READ_CHUNK)
            if not recs:
                break
            for r in recs:
                rid = r[0]
                if "band_id" in ix and r[ix["band_id"]] is not None:
                    self.band_id[rid] = r[ix["band_id"]]
                if "band_multi" in ix and r[ix["band_multi"]] is not None:
                    self.band_multi[rid] = r[ix["band_multi"]]
                if "region_class" in ix and r[ix["region_class"]] is not None:
                    self.region[rid] = r[ix["region_class"]]
                if "gene_cnt" in ix and r[ix["gene_cnt"]] is not None:
                    self.gene_cnt[rid] = r[ix["gene_cnt"]]
                    if "gene_blob" in ix and r[ix["gene_blob"]] is not None:
                        self.gene_ptr[rid] = len(self.gene_buf) + 1
                        self.gene_buf += r[ix["gene_blob"]]
            n += len(recs)
        return n

    def write(self, sidecar_path=None):
        """`node_annot` を rowid 昇順に 1 回で書く。

        sidecar_path を渡すと **新規ファイル `<db>.annot` へ直接書く**（既定・推奨）。

        == なぜ主 DB に書かないか（2026-08-13）==
        主 DB は大きな表を drop した跡の freelist が巨大で（wgpggb.povu.fin 14.2GB /
        mcgrch38.povu.fin 11.6GB）、SQLite は新ページを **freelist から優先再利用**する。
        そのため rowid 昇順に書いても **物理配置が散る**。実測でその表の走査は
        4KB ランダム読み 0.4 MB/s まで落ち、被覆索引を張るだけで 7 時間見込みになった。
        以前は「主 DB に書く → 別ジョブ ggb_annot_index/annot_sidecar が読み戻して
        サイドカーへ写す」構成にしていたが、**その読み戻しが散在読みそのもの**で、
        `dd` で主 DB を丸ごと順読みしてページキャッシュに載せる（77x）という
        当て物で凌いでいた。キャッシュ残留は保証されないので恒久策にならない。

        新規ファイルには freelist が無いので **追記＝物理連続が保証される**。
        読みは元から順次（`FROM nodes NOT INDEXED`）、集計はメモリ上（この class）、
        書きも順次追記になり、経路全体で随機アクセスが消える。読み戻しの段自体が不要。
        """
        if sidecar_path is not None:
            return self._write_sidecar(sidecar_path)
        cur = self.con.cursor()
        cols = []
        if self.band_id is not None:
            cols += ["band_id", "band_multi"]
        if self.gene_cnt is not None:
            cols += ["gene_cnt", "gene_blob"]
        if self.region is not None:
            cols += ["region_class"]
        if not cols:
            return 0
        typ = dict(_ANNOT_COLS)
        # ★先に DROP せず **一時表へ書き切ってから差し替える**。途中で落ちても既存の
        #   node_annot が残る（先に DROP する版だと、書き込み中の失敗で全消失する）。
        cur.execute("DROP TABLE IF EXISTS node_annot_new")
        cur.execute("CREATE TABLE node_annot_new(node_rowid INTEGER PRIMARY KEY, "
                    + ", ".join(f"{c} {typ[c]}" for c in cols) + ")")
        # 「どれか 1 つでも値がある行」だけ書く（旧実装の UPSERT と同じ集合になる）
        mask = np.zeros(self.n + 1, bool)
        if self.band_id is not None:
            mask |= self.band_id >= 0
            mask |= self.band_multi >= 0
        if self.gene_cnt is not None:
            mask |= self.gene_cnt > 0
        if self.region is not None:
            mask |= self.region >= 0
        mask[0] = False
        rids = np.nonzero(mask)[0]
        sql = (f"INSERT INTO node_annot_new(node_rowid, {', '.join(cols)}) VALUES ("
               + ",".join("?" * (len(cols) + 1)) + ")")
        total = 0
        for i0 in range(0, rids.size, _WRITE_CHUNK):
            chunk = rids[i0:i0 + _WRITE_CHUNK]
            batch = []
            for rid in chunk.tolist():
                rec = [rid]
                if self.band_id is not None:
                    b = int(self.band_id[rid]); m = int(self.band_multi[rid])
                    rec.append(None if b < 0 else b)
                    rec.append(None if m < 0 else m)
                if self.gene_cnt is not None:
                    c = int(self.gene_cnt[rid]); p = int(self.gene_ptr[rid])
                    rec.append(None if c <= 0 else c)
                    rec.append(None if p == 0 else
                               bytes(self.gene_buf[p - 1:p - 1 + 4 + 13 * c]))
                if self.region is not None:
                    g = int(self.region[rid])
                    rec.append(None if g < 0 else g)
                batch.append(rec)
            cur.executemany(sql, batch)
            total += len(batch)
            self.con.commit()
        # ★被覆索引 idx_na_cov は **ここでは作らない**（別ジョブ scripts/ggb_annot_index.py）。
        #   viewer の高速経路は node_annot を rowid で点引きするので索引は必須だが、
        #   作成自体は速い（chr22 2,779,533 行で temp_store=MEMORY なら 0.98s）。
        #   分離したのは時間のためではなく、この実装が最後まで DB に書かないので
        #   段を長くすると途中失敗で全トラック分を失うため。
        # 書き切ってから差し替え（ここまで来なければ旧 node_annot がそのまま残る）
        cur.execute("DROP TABLE IF EXISTS node_annot")
        cur.execute("ALTER TABLE node_annot_new RENAME TO node_annot")
        self.con.commit()
        return total


    def _write_sidecar(self, path):
        """`<db>.annot`（新規 sqlite ファイル）へ node_annot を書き、被覆索引まで作る。

        新規ファイルなので freelist が無く、rowid 昇順の INSERT は純粋な追記＝物理連続。
        表が連続なので索引構築も順次スキャンで済む（実測 chr22 0.98s / WG 47-54s）。
        `.part` に書いて完成後に rename（途中の中途半端なファイルを使わせない）。
        """
        cols = self._cols()
        if not cols:
            return 0
        typ = dict(_ANNOT_COLS)
        tmp = path + ".part"
        for q in (tmp, tmp + "-journal"):
            if os.path.exists(q):
                os.unlink(q)
        dst = sqlite3.connect(tmp)
        dst.execute("PRAGMA journal_mode=OFF")     # 新規ファイル＝ロールバック不要。純粋な追記に
        dst.execute("PRAGMA synchronous=OFF")
        dst.execute("PRAGMA cache_size=-1000000")
        dcur = dst.cursor()
        dcur.execute("CREATE TABLE node_annot(node_rowid INTEGER PRIMARY KEY, "
                     + ", ".join(f"{c} {typ[c]}" for c in cols) + ")")
        total = 0
        for batch in self._batches(cols):
            dcur.executemany(
                f"INSERT INTO node_annot(node_rowid, {', '.join(cols)}) VALUES ("
                + ",".join("?" * (len(cols) + 1)) + ")", batch)
            total += len(batch)
        dst.commit()
        # 被覆索引: viewer の高速経路が rowid で点引きするのに必須（無いと 269x 遅い）。
        # 表が物理連続なのでここは順次スキャンで済む。
        idx_cols = [c for c in ("band_id", "gene_cnt", "region_class") if c in cols]
        if idx_cols:
            dst.execute("PRAGMA temp_store=MEMORY")
            dcur.execute("CREATE INDEX idx_na_cov ON node_annot(node_rowid, "
                         + ", ".join(idx_cols) + ")")
            dst.commit()
        # ★辞書表もサイドカーへ複製して **自己完結** にする。
        #   node_annot の band_id / gene_cnt / region_class は辞書の id を指す。片方だけ
        #   差し替わると **黙って違う色・違う名前**になる（split-brain）。id と辞書が
        #   同じファイルに同居していれば、サイドカーを差し替えるだけで整合が保たれ、
        #   複数バージョンを並べて置ける（ファイル名で切り替え）。
        #   辞書は小さい（chr22 で最大 9,164 行 / WG でも feature_dict 78,733 + gene_exons 423,778）。
        dst.execute("ATTACH DATABASE ? AS m", (self.con_path,))
        n_dict = {}
        for t in ("band_dict", "feature_dict", "region_dict", "gene_exons",
                  "annot_track", "track_dict", "annot_meta"):
            try:
                ddl = dst.execute(
                    "SELECT sql FROM m.sqlite_master WHERE type='table' AND name=?", (t,)
                ).fetchone()
                if not ddl or not ddl[0]:
                    continue
                dst.execute(ddl[0])
                dst.execute(f"INSERT INTO {t} SELECT * FROM m.{t}")
                n_dict[t] = dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                pass                     # その辞書は今回作られていない
        dst.commit()
        dst.execute("DETACH DATABASE m")
        if n_dict:
            print("[ggb-annotate] 辞書もサイドカーへ同梱: "
                  + ", ".join(f"{k}={v:,}" for k, v in sorted(n_dict.items())))
        dst.close()
        os.replace(tmp, path)
        return total

    def _cols(self):
        cols = []
        if self.band_id is not None:
            cols += ["band_id", "band_multi"]
        if self.gene_cnt is not None:
            cols += ["gene_cnt", "gene_blob"]
        if self.region is not None:
            cols += ["region_class"]
        return cols

    def _batches(self, cols):
        """書く行を rowid 昇順の chunk で生成する（write/_write_sidecar 共用）。"""
        mask = np.zeros(self.n + 1, bool)
        if self.band_id is not None:
            mask |= self.band_id >= 0
            mask |= self.band_multi >= 0
        if self.gene_cnt is not None:
            mask |= self.gene_cnt > 0
        if self.region is not None:
            mask |= self.region >= 0
        mask[0] = False
        rids = np.nonzero(mask)[0]
        for i0 in range(0, rids.size, _WRITE_CHUNK):
            batch = []
            for rid in rids[i0:i0 + _WRITE_CHUNK].tolist():
                rec = [rid]
                if self.band_id is not None:
                    b = int(self.band_id[rid]); m = int(self.band_multi[rid])
                    rec.append(None if b < 0 else b)
                    rec.append(None if m < 0 else m)
                if self.gene_cnt is not None:
                    c = int(self.gene_cnt[rid]); pt = int(self.gene_ptr[rid])
                    rec.append(None if c <= 0 else c)
                    rec.append(None if pt == 0 else
                               bytes(self.gene_buf[pt - 1:pt - 1 + 4 + 13 * c]))
                if self.region is not None:
                    g = int(self.region[rid])
                    rec.append(None if g < 0 else g)
                batch.append(rec)
            yield batch


def _pansn_contig(nm):
    """PanSN 風 path/contig 名から染色体トークンを取り出す。'#'(PanSN: GRCh38#0#chr1)と
    '.'(MC: GRCh38.chr1)の両区切りに対応。'GRCh38.chr1'->'chr1'; 'CHM13#0#chr1'->'chr1'; 'chr1'->'chr1'。"""
    return re.split(r"[#.]", nm)[-1]


def _pansn_sample(nm):
    """PanSN 風名の sample(先頭フィールド)。'#' 優先、無ければ '.'。区切りが無ければ ''。"""
    if "#" in nm:
        return nm.split("#", 1)[0]
    if "." in nm:
        return nm.split(".", 1)[0]
    return ""


def load_ref_contigs(con, ref_key):
    rows = con.execute(
        "SELECT contig_id, name FROM ref_contigs WHERE ref_key=?", (ref_key,)
    ).fetchall()
    if not rows:
        sys.exit(f"[ggb-annotate] ref_contigs に ref_key={ref_key} が無い")
    cid2name = {cid: name for cid, name in rows}
    # 完全一致(full name)を最優先。加えて染色体トークン('GRCh38.chr1'->'chr1')・小文字の別名キーを、
    # 曖昧でない範囲で張る(アノテーション入力 'chr1' を DB 命名 'GRCh38.chr1'/'grch38#chr1' に一致させる)。
    name2cid = {name: cid for cid, name in rows}
    alias = {}
    for cid, name in rows:
        for k in {_pansn_contig(name), name.lower(), _pansn_contig(name).lower()}:
            if k in name2cid:            # full name と衝突するキーは触らない
                continue
            alias.setdefault(k, set()).add(cid)
    for k, cids in alias.items():
        if len(cids) == 1:               # 曖昧(複数 contig が同一トークン)は捨てる
            name2cid[k] = next(iter(cids))
    return name2cid, cid2name


def load_cytoband(path, name2cid):
    """cytoBand -> {contig_id: (starts, ends, names, stains) start 昇順}"""
    per = {}
    with _open_text(path) as fh:
        for line in fh:
            if not line.strip() or line.startswith("#"):
                continue
            f = line.rstrip("\n").split("\t")
            chrom, start, end, name, stain = f[0], int(f[1]), int(f[2]), f[3], f[4]
            cid = name2cid.get(chrom)
            if cid is not None:
                per.setdefault(cid, []).append((start, end, name, stain))
    for cid in per:
        per[cid].sort()
    return per


# ---------------------------------------------------------------------------
# band (cytoBand): 各 rowid(=node×layer) に band_id/band_multi。GROUP BY 不要=順次スキャン。
# ---------------------------------------------------------------------------
def annotate_band(con, band_path, ref_key, source, acc):
    name2cid, cid2name = load_ref_contigs(con, ref_key)
    per = load_cytoband(band_path, name2cid)
    if not per:
        sys.exit("[ggb-annotate] cytoBand に一致する contig 名が無い (PanSN 命名不一致?)")

    band_rows = []
    contig_bands = {}                  # cid -> (starts, ids)
    bid = 0
    for cid, rows in per.items():
        starts = np.array([r[0] for r in rows], dtype=np.int64)
        ids = np.arange(bid, bid + len(rows), dtype=np.int64)
        for i, (s, e, nm, st) in enumerate(rows):
            band_rows.append((int(ids[i]), cid, nm, st))
        bid += len(rows)
        contig_bands[cid] = (starts, ids)

    cur = con.cursor()
    cur.execute("DROP TABLE IF EXISTS band_dict")
    cur.execute("CREATE TABLE band_dict("
                "band_id INTEGER PRIMARY KEY, contig_id INTEGER, name TEXT, gie_stain TEXT)")
    cur.executemany("INSERT INTO band_dict VALUES (?,?,?,?)", band_rows)

    counters = {"skipped": 0}

    def rows_gen():
        # 各 ref 行(=rowid, 層重複はそのまま各層に付与)を chunk 読み→contig 毎 searchsorted ベクトル化
        rcur = con.execute(
            "SELECT rowid, ref_contig_id, ref_bp, ref_bp_end "
            "FROM nodes NOT INDEXED WHERE ref_bp IS NOT NULL")
        while True:
            recs = rcur.fetchmany(_READ_CHUNK)
            if not recs:
                break
            m = len(recs)
            rid = np.fromiter((r[0] for r in recs), np.int64, m)
            cid = np.fromiter((r[1] if r[1] is not None else -1 for r in recs), np.int64, m)
            bp = np.fromiter((r[2] for r in recs), np.int64, m)
            bpe = np.fromiter((r[3] if r[3] is not None else -1 for r in recs), np.int64, m)
            bpe = np.where(bpe > bp, bpe, bp + 1)
            mid = (bp + bpe) // 2
            hipos = np.maximum(bp, bpe - 1)
            band_id = np.full(m, -1, dtype=np.int64)
            multi = np.zeros(m, dtype=np.int64)
            for cv in np.unique(cid):
                c = int(cv)
                if c not in contig_bands:
                    continue
                sel = cid == cv
                starts, ids = contig_bands[c]
                last = len(starts) - 1
                jm = np.clip(np.searchsorted(starts, mid[sel], side="right") - 1, 0, last)
                jl = np.clip(np.searchsorted(starts, bp[sel], side="right") - 1, 0, last)
                jh = np.clip(np.searchsorted(starts, hipos[sel], side="right") - 1, 0, last)
                band_id[sel] = ids[jm]
                multi[sel] = (jl != jh).astype(np.int64)
            valid = band_id >= 0
            counters["skipped"] += int((~valid).sum())
            for i in np.nonzero(valid)[0]:
                yield (int(rid[i]), int(band_id[i]), int(multi[i]))

    n = acc.feed_band(rows_gen())        # DB へは書かず配列へ。書き出しは main の acc.write()
    cur.execute("CREATE TABLE IF NOT EXISTS annot_track("
                "track TEXT, kind TEXT, ref_key TEXT, source TEXT, note TEXT)")
    cur.execute("DELETE FROM annot_track WHERE track='band'")
    cur.execute("INSERT INTO annot_track VALUES (?,?,?,?,?)",
                ("band", "band", ref_key, source, f"{n} rows / {len(band_rows)} bands"))
    con.commit()
    print(f"[ggb-annotate band] node_annot rows(band)={n} band_dict={len(band_rows)} "
          f"(ref={ref_key}, skipped {counters['skipped']} w/o band-ref contig)")


# ---------------------------------------------------------------------------
# gene (GENCODE GTF): rowid 毎に gene_blob。per-contig 射影→ノードでグループ化→blob。
# ---------------------------------------------------------------------------
_ATTR = re.compile(r'(\w+) "([^"]*)"')


def load_gtf(path, name2cid, gene_types=None):
    """GTF(1-based closed) -> (genes, exons) を 0-based half-open で返す。gene_types 指定時は絞る。"""
    genes, exons = {}, {}
    keep = set(gene_types) if gene_types else None
    with _open_text(path) as fh:
        for line in fh:
            if not line or line[0] == "#":
                continue
            c = line.rstrip("\n").split("\t")
            if len(c) < 9:
                continue
            cid = name2cid.get(c[0])
            if cid is None:
                continue
            feat = c[2]
            if feat not in ("gene", "exon"):
                continue
            a = dict(_ATTR.findall(c[8]))
            gid = a.get("gene_id")
            if not gid:
                continue
            if keep is not None and a.get("gene_type", "") not in keep:
                continue
            if feat == "gene":
                genes[gid] = dict(cid=cid, start=int(c[3]) - 1, end=int(c[4]),
                                  strand=c[6], name=a.get("gene_name", gid),
                                  gtype=a.get("gene_type", ""))
            else:
                exons.setdefault(gid, []).append((int(c[3]) - 1, int(c[4])))
    if keep is not None:                    # gene 行に出なかった gid の exon を捨てる
        exons = {g: v for g, v in exons.items() if g in genes}
    return genes, exons


def annotate_gene(con, gtf_path, ref_key, source, acc, gene_types=None,
                  distill_dir=None, ref_path_key="grch38"):
    name2cid, cid2name = load_ref_contigs(con, ref_key)
    genes, exons = load_gtf(gtf_path, name2cid, gene_types)
    if not genes:
        sys.exit("[ggb-annotate] GTF に一致する contig の gene 行が無い (命名/型フィルタ?)")

    feat_rows, gene_list, gene_by_contig = [], [], {}
    fid = 0
    for gid, g in genes.items():
        attrs = json.dumps({"gene_id": gid, "gene_type": g["gtype"], "strand": g["strand"],
                            "chrom": cid2name.get(g["cid"]), "start": g["start"], "end": g["end"]},
                           ensure_ascii=False)
        feat_rows.append((fid, g["name"], attrs))
        gene_list.append((fid, g["cid"], g["start"], g["end"], gid))
        gene_by_contig.setdefault(g["cid"], []).append((fid, g["start"], g["end"], gid))
        fid += 1
    nfeat = fid

    cur = con.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS track_dict("
                "track_id INTEGER PRIMARY KEY, kind TEXT, name TEXT, ref_key TEXT, source TEXT)")
    cur.execute("CREATE TABLE IF NOT EXISTS feature_dict("
                "feature_id INTEGER, track_id INTEGER, name TEXT, attrs TEXT, "
                "cx REAL, cy REAL, layer INTEGER)")
    for col in ("cx", "cy", "layer"):        # 既存 DB への additive 追加
        if col not in {r[1] for r in cur.execute("PRAGMA table_info(feature_dict)")}:
            cur.execute(f"ALTER TABLE feature_dict ADD COLUMN {col} "
                        f"{'INTEGER' if col == 'layer' else 'REAL'}")
    row = cur.execute("SELECT track_id FROM track_dict WHERE kind='gene' AND ref_key=?",
                      (ref_key,)).fetchone()
    if row:
        track_id = row[0]
        cur.execute("DELETE FROM feature_dict WHERE track_id=?", (track_id,))
        cur.execute("UPDATE track_dict SET source=? WHERE track_id=?", (source, track_id))
    else:
        track_id = cur.execute(
            "SELECT COALESCE(MAX(track_id), -1) + 1 FROM track_dict").fetchone()[0]
        cur.execute("INSERT INTO track_dict VALUES (?,?,?,?,?)",
                    (track_id, "gene", "gene", ref_key, source))
    # 再実行冪等化: 旧実装は `UPDATE node_annot SET gene_cnt=NULL,...` で表を全走査していたが
    # (索引が無いので 199.8M 行スキャン + 全ページ書き換え)、新実装は acc が gene 列を
    # **今回の結果だけで作り直す**ので不要（main が load_existing の skip に gene を入れる）。

    # goto 代表位置(遺伝子毎): 会員ノードの重心 + 最粗(最小 layer)会員の座標
    g_sumx = np.zeros(nfeat); g_sumy = np.zeros(nfeat); g_cnt = np.zeros(nfeat, np.int64)
    g_minlay = np.full(nfeat, 1 << 30, np.int64); g_mlx = np.zeros(nfeat); g_mly = np.zeros(nfeat)
    stats = {"assoc": 0, "exonic": 0, "wide": 0, "nodes": 0, "maxcnt": 0}

    # --- (b) 葉ノードは GRCh38 パスを distill で walk し「実 occurrence 区間」に遺伝子を射影 ---
    # 多重ノード(ref_multi)も、その配列が実際に遺伝子内に落ちた occurrence だけ拾える(=[min,max] 外接
    # ボックスに頼らない)。super-node は下の範囲射影(近似)のまま。distill 未指定なら葉も範囲射影(旧挙動)。
    # leaf_blob[origid(=node_name の n<id>)] = (gene_cnt, blob)。dense→origid は id_map。
    leaf_blob = None
    gene_rep_pos = {}     # fid -> (x,y,layer): goto 代表 = 実 occurrence 葉の座標(粗い super-node でなく葉を使う)
    rep_by_origid = {}    # origid(n<id>) -> [fid]: その葉を goto 代表とする遺伝子群(blobs 走査で座標を拾う)
    if distill_dir:
        import os
        names_d = open(os.path.join(distill_dir, "p_names.txt")).read().splitlines()
        p_off = np.load(os.path.join(distill_dir, "p_off.npy"))
        p_tok = np.load(os.path.join(distill_dir, "p_tok.npy"), mmap_mode="r")
        s_id = np.load(os.path.join(distill_dir, "s_id.npy"))
        s_bp = np.load(os.path.join(distill_dir, "s_bp.npy"))
        id_map = np.load(os.path.join(distill_dir, "id_map.npy"))
        bp_by_dense = np.zeros(int(s_id.max()) + 1, dtype=np.int64)
        bp_by_dense[s_id] = s_bp
        LA_d, LA_f, LA_s, LA_e, LA_x = [], [], [], [], []   # dense, fid, seg_s, seg_e, ex
        gene_rep_dense, gene_rep_bp = {}, {}   # fid -> 代表葉 dense / その ref start(最小=5'端 occurrence)
        walked = 0
        for k, nm in enumerate(names_d):
            if _pansn_sample(nm).lower() != ref_path_key.lower():
                continue          # 大小無視・'#'/'.'両対応('grch38' が 'GRCh38#chrY'/'GRCh38.chr1' に一致)
            cid = name2cid.get(_pansn_contig(nm))
            glist = gene_by_contig.get(cid) if cid is not None else None
            if not glist:
                continue
            walked += 1
            a, b = int(p_off[k]), int(p_off[k + 1])
            toks = np.asarray(p_tok[a:b], dtype=np.int64)
            seglen = bp_by_dense[toks]
            start = np.empty(len(toks), dtype=np.int64)
            start[0] = 0
            np.cumsum(seglen[:-1], out=start[1:])          # 参照は連続タイル: start[i+1]=end[i]
            end = start + seglen
            for feature_id, gs, ge, gid in glist:
                lo = max(int(np.searchsorted(start, gs, side="right")) - 1, 0)
                hi = int(np.searchsorted(start, ge, side="left"))
                if hi <= lo:
                    continue
                os_, oe, od = start[lo:hi], end[lo:hi], toks[lo:hi]
                keep = (os_ < ge) & (oe > gs)              # 実際に重なる occurrence のみ
                os_, oe, od = os_[keep], oe[keep], od[keep]
                if od.size == 0:
                    continue
                # goto 代表 = この遺伝子の最小 ref start(5'端)の occurrence 葉。粗い super-node でなく実葉位置へ。
                _ai = int(np.argmin(os_)); _ms = int(os_[_ai])
                if feature_id not in gene_rep_bp or _ms < gene_rep_bp[feature_id]:
                    gene_rep_bp[feature_id] = _ms; gene_rep_dense[feature_id] = int(od[_ai])
                ex = exons.get(gid)
                if ex:
                    ex_s = np.fromiter((e[0] for e in ex), np.int64, len(ex))
                    ex_e = np.fromiter((e[1] for e in ex), np.int64, len(ex))
                    exon = np.any((ex_s[None, :] < oe[:, None]) & (ex_e[None, :] > os_[:, None]),
                                  axis=1).astype(np.uint8)
                else:
                    exon = np.zeros(od.size, np.uint8)
                LA_d.append(od); LA_f.append(np.full(od.size, feature_id, np.int64))
                LA_s.append(np.maximum(os_, gs)); LA_e.append(np.minimum(oe, ge)); LA_x.append(exon)
        leaf_blob = {}
        if LA_d:
            Ad = np.concatenate(LA_d); Af = np.concatenate(LA_f)
            As = np.concatenate(LA_s); Ae = np.concatenate(LA_e); Ax = np.concatenate(LA_x)
            # (葉 dense, 遺伝子 fid) で dedup: 同一遺伝子に複数 occurrence(反復)でも 1 エントリ。
            # exonic は OR(いずれかの occurrence が exon なら exon), seg はその代表。
            key = Ad.astype(np.int64) * (nfeat + 1) + Af.astype(np.int64)
            order = np.lexsort((-(Ax.astype(np.int64)), key))   # key 昇順, 同 key 内は exonic 降順
            key = key[order]; Ad = Ad[order]; Af = Af[order]; As = As[order]; Ae = Ae[order]; Ax = Ax[order]
            keep = np.empty(key.size, bool); keep[0] = True; keep[1:] = key[1:] != key[:-1]
            Ad = Ad[keep]; Af = Af[keep].astype(np.uint32)
            As = As[keep].astype(np.uint32); Ae = Ae[keep].astype(np.uint32); Ax = Ax[keep]
            uq, si = np.unique(Ad, return_index=True)   # Ad は key 順=dense 昇順
            ei = np.append(si[1:], Ad.size)
            for i in range(uq.size):
                a2, b2 = int(si[i]), int(ei[i])
                leaf_blob[int(id_map[int(uq[i]) - 1])] = (   # dense は 1-based → id_map[d-1]=元id
                    b2 - a2, _pack_gene_blob(Af[a2:b2], As[a2:b2], Ae[a2:b2], Ax[a2:b2]))
                if b2 - a2 > stats["maxcnt"]:
                    stats["maxcnt"] = b2 - a2
            stats["assoc"] += int(Ad.size); stats["exonic"] += int(Ax.sum()); stats["nodes"] += uq.size
        print(f"  [gene walk] ref-path={ref_path_key} paths={walked} "
              f"leaf-assoc={stats['assoc']} leaf-nodes={len(leaf_blob)}")
        for _fid, _dense in gene_rep_dense.items():
            rep_by_origid.setdefault(int(id_map[_dense - 1]), []).append(_fid)  # dense 1-based

    def flush(cid, rid, bp, bpe0, x, y, lay):
        """1 contig ぶんの super-node 群に遺伝子を射影する。引数は **numpy 配列**
        （旧: DB 行のリスト）。呼び側が contig ごとに切って渡す。"""
        glist = gene_by_contig.get(cid)
        if not glist:
            return
        bpe = np.where(bpe0 > bp, bpe0, bp + 1)
        order = np.argsort(bp, kind="stable")
        bp_s = bp[order]; bpe_s = bpe[order]
        length = bpe_s - bp_s
        narrow = length <= _GENE_WIDE_LEN
        ns_start, ns_end, ns_o = bp_s[narrow], bpe_s[narrow], order[narrow]
        wmask = ~narrow
        wd_start, wd_end, wd_o = bp_s[wmask], bpe_s[wmask], order[wmask]
        stats["wide"] += int(wmask.sum())

        P_node, P_fid, P_s, P_e, P_ex = [], [], [], [], []
        for feature_id, gs, ge, gid in glist:
            lo = int(np.searchsorted(ns_start, gs - _GENE_WIDE_LEN, side="left"))
            hi = int(np.searchsorted(ns_start, ge, side="left"))
            cs, ce, co = ns_start[lo:hi], ns_end[lo:hi], ns_o[lo:hi]
            keep = ce > gs
            cs, ce, co = cs[keep], ce[keep], co[keep]
            if wd_start.size:
                wk = (wd_start < ge) & (wd_end > gs)
                cs = np.concatenate([cs, wd_start[wk]])
                ce = np.concatenate([ce, wd_end[wk]])
                co = np.concatenate([co, wd_o[wk]])
            if co.size == 0:
                continue
            ex = exons.get(gid)
            if ex:
                ex_s = np.fromiter((e[0] for e in ex), np.int64, len(ex))
                ex_e = np.fromiter((e[1] for e in ex), np.int64, len(ex))
                # ★2 次元ブロードキャスト `(ex_s[None,:] < ce[:,None]) & ...` は
                #   (候補ノード数 × エクソン数) の bool 配列を作る。WG では
                #   (65,799 × 1,400) = 88MiB が 2 本必要になり s_vmem の仮想上限で落ちた
                #   （物理は余っていた。memory: hpc-svmem-is-virtual-arena-cap）。
                #   区間の重なりは searchsorted + 終端の累積 max で厳密に同じ答えが出る:
                #     「ex_s < ce を満たすエクソン(=先頭から j まで)の中に ex_e > cs があるか」
                #     ⇔ prefix_max(ex_e)[j] > cs
                #   エクソンが重なっていても順不同でも正しい（累積 max がそれを吸収する）。
                so = np.argsort(ex_s, kind="stable")
                ex_s = ex_s[so]
                ex_emax = np.maximum.accumulate(ex_e[so])
                j = np.searchsorted(ex_s, ce, side="left") - 1
                exonic = np.zeros(co.size, np.uint8)
                ok = j >= 0
                if ok.any():
                    exonic[ok] = (ex_emax[j[ok]] > cs[ok]).astype(np.uint8)
            else:
                exonic = np.zeros(co.size, np.uint8)
            seg_s = np.maximum(cs, gs)
            seg_e = np.minimum(ce, ge)
            P_node.append(co); P_fid.append(np.full(co.size, feature_id, np.int64))
            P_s.append(seg_s); P_e.append(seg_e); P_ex.append(exonic)
            stats["assoc"] += int(co.size); stats["exonic"] += int(exonic.sum())
            # goto 集計
            g_sumx[feature_id] += float(x[co].sum()); g_sumy[feature_id] += float(y[co].sum())
            g_cnt[feature_id] += co.size
            j = int(co[int(np.argmin(lay[co]))])
            if lay[j] < g_minlay[feature_id]:
                g_minlay[feature_id] = int(lay[j]); g_mlx[feature_id] = x[j]; g_mly[feature_id] = y[j]

        if not P_node:
            return
        A_node = np.concatenate(P_node)
        A_fid = np.concatenate(P_fid).astype(np.uint32)
        A_s = np.concatenate(P_s).astype(np.uint32)
        A_e = np.concatenate(P_e).astype(np.uint32)
        A_ex = np.concatenate(P_ex)
        o2 = np.argsort(A_node, kind="stable")        # ノードでグループ化(contig 内の小ソート)
        A_node = A_node[o2]; A_fid = A_fid[o2]; A_s = A_s[o2]; A_e = A_e[o2]; A_ex = A_ex[o2]
        uniq, start_idx = np.unique(A_node, return_index=True)
        end_idx = np.append(start_idx[1:], A_node.size)
        stats["nodes"] += uniq.size
        if uniq.size:
            stats["maxcnt"] = max(stats["maxcnt"], int((end_idx - start_idx).max()))
        for k in range(uniq.size):
            a, b = int(start_idx[k]), int(end_idx[k])
            blob = _pack_gene_blob(A_fid[a:b], A_s[a:b], A_e[a:b], A_ex[a:b])
            yield (int(rid[int(uniq[k])]), int(b - a), blob)

    def blobs():
        # 1回のフルスキャンで葉(n<id>: walk 由来 leaf_blob を即書き)と super-node(G/S: 範囲射影)を両方処理。
        # → 葉用の別スキャンを削減。node_name は SELECT 末尾(flush の rec[0..6] を保つ)。
        # 葉は walk が GRCh38 上で見つけた occurrence なので **ref_bp/ref_contig_id が NULL でも書く**
        # (emitter が一意配置できず ref_bp 未付与の GRCh38 葉が存在する)。よって walk 時は葉('n*')を
        # ref_bp 条件と OR で拾い、cid=None チェックより前に処理する。NOT INDEXED は全行走査なので追加I/Oなし。
        # walk 無し(旧挙動)は葉も範囲射影する(ref_multi 除外)ので leaf 分岐を通さず全て buf へ。
        # ★旧実装は `ORDER BY ref_contig_id` を付けて contig の連続 run を作っていたが、これは
        #   **199.8M 行 × 8 列の外部ソート**（temp_store=FILE なので一時ファイルへ spill）で、
        #   WG の遅さの主因の一つだった。ソートは DB にやらせず、rowid 順（= B-tree の素の順 =
        #   順次読み）で読んで **contig ごとに numpy 配列へ振り分ける**。
        #   ref contig は GRCh38 で 25 本程度なので、振り分け先はごく少数。
        where = ("ref_bp IS NOT NULL OR node_name GLOB 'n*'" if leaf_blob is not None
                 else "ref_bp IS NOT NULL AND (ref_multi IS NULL OR ref_multi = 0)")
        rcur = con.execute(
            "SELECT rowid, ref_contig_id, ref_bp, ref_bp_end, xCoord, yCoord, layer_index, node_name "
            "FROM nodes NOT INDEXED WHERE " + where)
        C = [[], [], [], [], [], [], []]          # rid, cid, bp, bpe, x, y, lay のチャンク列
        while True:
            recs = rcur.fetchmany(_READ_CHUNK)
            if not recs:
                break
            keep = []
            for rec in recs:
                if leaf_blob is not None and rec[7] and rec[7][0] == 'n':  # 葉: walk 済 → 即書き
                    _oid = int(rec[7][1:])
                    lb = leaf_blob.get(_oid)
                    if lb is not None:
                        yield (rec[0], lb[0], lb[1])
                    _reps = rep_by_origid.get(_oid)
                    if _reps:                          # この葉を goto 代表とする遺伝子に実座標を記録
                        for _fid in _reps:             # 同一 origid が複数層なら最細層(max layer)
                            _prev = gene_rep_pos.get(_fid)
                            if _prev is None or rec[6] > _prev[2]:
                                gene_rep_pos[_fid] = (rec[4], rec[5], rec[6])
                    continue
                if rec[1] is None:
                    continue
                keep.append(rec)                  # super(walk時) / 全ノード(非walk時)
            if not keep:
                continue
            m = len(keep)
            C[0].append(np.fromiter((r[0] for r in keep), np.int64, m))
            C[1].append(np.fromiter((r[1] for r in keep), np.int64, m))
            C[2].append(np.fromiter((r[2] if r[2] is not None else 0 for r in keep), np.int64, m))
            C[3].append(np.fromiter((r[3] if r[3] is not None else -1 for r in keep), np.int64, m))
            C[4].append(np.fromiter((r[4] if r[4] is not None else 0.0 for r in keep), np.float64, m))
            C[5].append(np.fromiter((r[5] if r[5] is not None else 0.0 for r in keep), np.float64, m))
            C[6].append(np.fromiter((r[6] if r[6] is not None else 0 for r in keep), np.int64, m))
        if not C[0]:
            return
        rid, cidv, bp, bpe0, x, y, lay = (np.concatenate(c) for c in C)
        C = None
        o = np.argsort(cidv, kind="stable")       # contig でグループ化（contig 数は数十）
        cs = cidv[o]
        uq, si = np.unique(cs, return_index=True)
        ei = np.append(si[1:], cs.size)
        for k in range(uq.size):
            g = o[si[k]:ei[k]]
            yield from flush(int(uq[k]), rid[g], bp[g], bpe0[g], x[g], y[g], lay[g])

    acc.feed_gene(blobs())               # DB へは書かず配列へ。書き出しは main の acc.write()

    # feature_dict(+goto 代表位置) を書く
    frows = []
    for fid_, name, attrs in feat_rows:
        if fid_ in gene_rep_pos:
            # walk 由来: goto 代表 = 実 occurrence 葉の座標(遺伝子ごとに distinct)。粗い super-node に潰れない。
            _rx, _ry, _rl = gene_rep_pos[fid_]
            cx = float(_rx); cy = float(_ry); lay = int(_rl)
        elif g_cnt[fid_] > 0:
            # 非walk(範囲射影)フォールバック: 最粗(最小 layer)会員ノードの実座標。重心(mean)だとグラフ
            # レイアウト上どのノードからも離れた点になり得る(座標は非線形)ため使わない。
            cx = float(g_mlx[fid_]); cy = float(g_mly[fid_])
            lay = int(g_minlay[fid_])
        else:
            cx = cy = None; lay = None
        frows.append((fid_, track_id, name, attrs, cx, cy, lay))
    cur.executemany("INSERT INTO feature_dict(feature_id,track_id,name,attrs,cx,cy,layer) "
                    "VALUES (?,?,?,?,?,?,?)", frows)

    # gene_exons: マージ exon に転写方向で番号(strand-aware)。exon/intron 塗り分け用。
    cur.execute("CREATE TABLE IF NOT EXISTS gene_exons("
                "feature_id INTEGER, track_id INTEGER, exon_no INTEGER, start INTEGER, end INTEGER)")
    cur.execute("DELETE FROM gene_exons WHERE track_id=?", (track_id,))
    ge_rows = []
    for feature_id, cid, gs, ge, gid in gene_list:
        ex = exons.get(gid)
        if not ex:
            continue
        merged = []
        for s, e in sorted(ex):
            if merged and s <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        ordered = merged if genes[gid]["strand"] != '-' else merged[::-1]
        for i, (s, e) in enumerate(ordered, 1):
            ge_rows.append((feature_id, track_id, i, s, e))
    cur.executemany("INSERT INTO gene_exons VALUES (?,?,?,?,?)", ge_rows)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_gene_exons_feat ON gene_exons(feature_id)")
    # max(gene_cnt) を meta に保存(viewer の密度ランプ正規化用。WG では node_annot 全走査が重いため)
    cur.execute("CREATE TABLE IF NOT EXISTS annot_meta(key TEXT PRIMARY KEY, value INTEGER)")
    cur.execute("INSERT OR REPLACE INTO annot_meta VALUES ('max_gene_cnt', ?)", (stats["maxcnt"],))
    con.commit()

    print(f"[ggb-annotate gene] track_id={track_id} genes={len(feat_rows)} exons={len(ge_rows)} "
          f"assoc(gene-node)={stats['assoc']} (exonic={stats['exonic']}) "
          f"blob-nodes={stats['nodes']} wide={stats['wide']} ref={ref_key}"
          + (f" types={','.join(gene_types)}" if gene_types else ""))


# ---------------------------------------------------------------------------
# region (CHM13 BED を CHM13 パス walk で射影 → node_name → rowid, goto 代表位置付き)
# ---------------------------------------------------------------------------
def _load_distill(d):
    import os
    names = open(os.path.join(d, "p_names.txt")).read().splitlines()
    p_off = np.load(os.path.join(d, "p_off.npy"))
    p_tok = np.load(os.path.join(d, "p_tok.npy"), mmap_mode="r")
    s_id = np.load(os.path.join(d, "s_id.npy"))
    s_bp = np.load(os.path.join(d, "s_bp.npy"))
    id_map = np.load(os.path.join(d, "id_map.npy"))
    bp_by_dense = np.zeros(int(s_id.max()) + 1, dtype=np.int64)
    bp_by_dense[s_id] = s_bp
    return names, p_off, p_tok, bp_by_dense, id_map


def _load_region_bed(path):
    per = {}
    with _open_text(path) as fh:
        for line in fh:
            if not line.strip() or line[0] == "#":
                continue
            f = line.rstrip("\n").split("\t")
            per.setdefault(f[0], []).append((int(f[1]), int(f[2]),
                                             f[3] if len(f) > 3 else "region"))
    return per


def _layer_rowid_ranges(con):
    """層 L -> (rowid_lo, rowid_hi) を返す。rowid が層メジャー昇順でなければ None。

    stats の層別ノード数から境界を出し、実際に引いて確かめる（層数ぶんの点引きだけ）。
    これがあれば「深→浅」の走査を **層ごとの前向きレンジスキャン**に分解できる。
    """
    import json
    try:
        st = json.loads(con.execute("SELECT data FROM stats ORDER BY id LIMIT 1").fetchone()[0])
        ln = st["layer_nodes"]
    except Exception:
        return None
    out, cum = {}, 0
    for L, cnt in enumerate(ln):
        if not cnt:
            continue
        lo, hi = cum + 1, cum + cnt
        for rid in (lo, hi):
            r = con.execute("SELECT layer_index FROM nodes WHERE rowid=?", (rid,)).fetchone()
            if r is None or r[0] != L:
                return None
        out[L] = (lo, hi)
        cum = hi
    if cum != int(con.execute("SELECT MAX(rowid) FROM nodes").fetchone()[0] or 0):
        return None
    return out


def _rowid_is_layer_major(con):
    """`nodes.rowid` が層メジャー昇順か（emitter は層ごとに rid_base を進めて書くのでそのはず）。

    そうなら層順の走査は `ORDER BY rowid` で済み、**199.8M 行の外部ソートを丸ごと省ける**。
    仮定に頼らず、stats の層別ノード数から境界 rowid を出して実際に引いて確かめる
    （層数ぶんの点引きだけ = 数十シーク）。1 つでも違えば False を返して従来の ORDER BY に戻す。"""
    import json
    try:
        st = json.loads(con.execute("SELECT data FROM stats ORDER BY id LIMIT 1").fetchone()[0])
        ln = st["layer_nodes"]
    except Exception:
        return False
    cum = 0
    for L, cnt in enumerate(ln):
        if not cnt:
            continue
        lo, hi = cum + 1, cum + cnt          # 層 L はこの rowid 範囲を占めるはず
        for rid in (lo, hi):
            r = con.execute("SELECT layer_index FROM nodes WHERE rowid=?", (rid,)).fetchone()
            if r is None or r[0] != L:
                return False
        cum = hi
    return cum == int(con.execute("SELECT MAX(rowid) FROM nodes").fetchone()[0] or 0)


def annotate_region(con, bed_path, ref_key, distill_dir, source, acc,
                    dry_run=False, min_frac=0.5):
    names, p_off, p_tok, bp_by_dense, id_map = _load_distill(distill_dir)
    bed = _load_region_bed(bed_path)
    classes = sorted({c for rows in bed.values() for (_, _, c) in rows})
    class_id = {c: i for i, c in enumerate(classes)}

    BASE = 1 << 40                    # 複数 CHM13 contig の座標衝突回避(1 contig なら base=0)
    contig_base = {}
    node_class = {}
    stats = {c: [0, 1 << 62, 0] for c in classes}
    cmin = np.full(bp_by_dense.size, 1 << 62, dtype=np.int64)
    cmax = np.full(bp_by_dense.size, -1, dtype=np.int64)
    walked = 0
    for k, nm in enumerate(names):
        sample, contig = _pansn_sample(nm), _pansn_contig(nm)
        if sample.lower() != ref_key.lower() or contig not in bed:   # '#'/'.'両対応・大小無視
            continue
        if contig not in contig_base:
            contig_base[contig] = len(contig_base) * BASE
        base = contig_base[contig]
        walked += 1
        a, b = int(p_off[k]), int(p_off[k + 1])
        toks = np.asarray(p_tok[a:b], dtype=np.int64)
        bp = bp_by_dense[toks]
        start = np.empty(len(toks), dtype=np.int64)
        start[0] = 0
        np.cumsum(bp[:-1], out=start[1:])
        end = start + bp
        np.minimum.at(cmin, toks, start + base)
        np.maximum.at(cmax, toks, end + base)
        for (bs, be, cls) in bed[contig]:
            cidx = class_id[cls]
            for j in np.nonzero((start < be) & (end > bs))[0]:
                node_name = "n" + str(int(id_map[int(toks[j]) - 1]))   # dense 1-based → id_map[d-1]
                node_class.setdefault(node_name, cidx)
                s = stats[cls]; s[0] += 1
                s[1] = min(s[1], int(start[j])); s[2] = max(s[2], int(end[j]))

    print(f"[ggb-annotate region] ref={ref_key} paths_walked={walked} "
          f"leaf-hits(distinct node)={len(node_class)} classes={classes}")
    for c in classes:
        s = stats[c]
        print(f"  {c:12} leaf-marks={s[0]:8} CHM13 pos[{s[1] if s[0] else 0:,},{s[2]:,}]")
    if dry_run:
        print("  (dry-run: DB 未書き込み)")
        return

    # --- in-memory 森 climb: 葉の CHM13 範囲(offset)を parent 森で min/max 伝播 ---
    # 旧: _rng temp + 18連 SQL self-join(node_name×layer で 258GB を毎回引く=WG で random I/O 律速)。
    # 新: nodes を layer 深→浅で順次1回読み、rng[node_name]=[cmin,cmax] 辞書(=CHM13 被覆部分木のみ)で
    #     child→parent 伝播。DB ランダムアクセス無し。木サイズはグラフ上限(パス数非依存)でメモリ許容範囲。
    present = np.nonzero(cmax >= 0)[0]
    cur = con.cursor()
    rng = {}
    for d in present.tolist():
        rng["n" + str(int(id_map[d - 1]))] = [int(cmin[d]), int(cmax[d])]   # dense 1-based
    # 深→浅の順で子から親へ伝播する。順序の作り方が性能を決める:
    #   ・`ORDER BY layer_index DESC` … 199.8M 行の**外部ソート**（旧実装）
    #   ・`ORDER BY rowid DESC` ……… ソートは消えるが **逆方向スキャン**になり、
    #       Lustre の readahead は前向きしか検知しないので **全ページがランダム読み**に化ける。
    #       2026-08-10 実測: OST が 1.4GB/s 出る状況で 0.35 MB/s / CPU 3%（4000 分の 1）。
    #       7.4M ページ × 13.8ms ≒ 28 時間。私がこれを入れて大幅に遅くした。
    #   ・**層ごとの前向きレンジスキャンを深い層から順に並べる**（採用）…
    #       各スキャンが前向きなので readahead が効き、かつ層順は保てる。
    #       rowid は層メジャーなので `WHERE rowid BETWEEN lo AND hi` で層を切り出せる。
    _ranges = _layer_rowid_ranges(con)
    print(f"  [region climb] 層別 rowid 範囲={'取得できた' if _ranges else '取れない'} "
          f"→ {'層ごとの前向きスキャン(深→浅)' if _ranges else 'ORDER BY layer_index DESC(外部ソート)'}")
    if _ranges:
        scans = [con.execute("SELECT node_name, layer_index, parent_name FROM nodes NOT INDEXED "
                             "WHERE rowid BETWEEN ? AND ?", _ranges[L])
                 for L in sorted(_ranges, reverse=True)]
    else:
        scans = [con.execute("SELECT node_name, layer_index, parent_name FROM nodes NOT INDEXED "
                             "ORDER BY layer_index DESC")]
    for scur in scans:
        while True:
            recs = scur.fetchmany(_READ_CHUNK)
            if not recs:
                break
            for nm, lay, par in recs:        # 深→浅: 子は先に確定済 → 親へ min/max 伝播
                r = rng.get(nm)
                if r is None or par is None or par == nm:
                    continue
                pr = rng.get(par)
                if pr is None:
                    rng[par] = [r[0], r[1]]
                else:
                    if r[0] < pr[0]:
                        pr[0] = r[0]
                    if r[1] > pr[1]:
                        pr[1] = r[1]

    # --- 重なり割合 >= min_frac のノードを region-class に(offset 込み interval, searchsorted) ---
    ivs = sorted((bs + base, be + base, class_id[cls])
                 for contig, base in contig_base.items() for (bs, be, cls) in bed[contig])
    ib_s = np.fromiter((v[0] for v in ivs), np.int64, len(ivs))
    ib_e = np.fromiter((v[1] for v in ivs), np.int64, len(ivs))
    ib_c = np.fromiter((v[2] for v in ivs), np.int64, len(ivs))
    nlast = len(ivs) - 1

    # rng(covered names) をベクトル化マーキング → marks{name: class}(min_frac 以上で最大重なりクラス)
    names_cov = list(rng.keys())
    marks = {}
    for i0 in range(0, len(names_cov), _READ_CHUNK):
        chunk = names_cov[i0:i0 + _READ_CHUNK]
        m = len(chunk)
        lo = np.fromiter((rng[n][0] for n in chunk), np.int64, m)
        hi = np.fromiter((rng[n][1] for n in chunk), np.int64, m)
        span = np.maximum(hi - lo, 1)
        il = np.clip(np.searchsorted(ib_s, lo, side="right") - 1, 0, nlast)
        ih = np.clip(np.searchsorted(ib_s, np.maximum(hi - 1, lo), side="right") - 1, 0, nlast)
        best_c = np.full(m, -1, dtype=np.int64)
        single = il == ih
        if single.any():
            idx = np.nonzero(single)[0]
            b1 = il[idx]
            ov = np.minimum(hi[idx], ib_e[b1]) - np.maximum(lo[idx], ib_s[b1])
            ok = (ov > 0) & (ov / span[idx] >= min_frac)
            best_c[idx[ok]] = ib_c[b1[ok]]
        for i in np.nonzero(~single)[0]:
            lo_i, hi_i, sp_i = int(lo[i]), int(hi[i]), int(span[i])
            bestf, bestc = min_frac, -1
            for t in range(int(il[i]), int(ih[i]) + 1):
                ov = min(hi_i, int(ib_e[t])) - max(lo_i, int(ib_s[t]))
                if ov > 0 and ov / sp_i >= bestf:
                    bestf, bestc = ov / sp_i, int(ib_c[t])
            if bestc >= 0:
                best_c[i] = bestc
        for i in np.nonzero(best_c >= 0)[0]:
            marks[chunk[i]] = int(best_c[i])
    n_marks = len(marks)

    # --- marks(node_name) を rowid に解決して node_annot へ + goto 集計(1 順次スキャン, in-memory) ---
    cur.execute("DROP TABLE IF EXISTS region_dict")
    cur.execute("CREATE TABLE region_dict("
                "region_id INTEGER PRIMARY KEY, name TEXT, ref_key TEXT, cx REAL, cy REAL, layer INTEGER)")
    goto = {i: [0.0, 0.0, 0, 1 << 30] for i in range(len(classes))}   # cls -> [sumx,sumy,cnt,minlayer]

    def region_annot_rows():
        rcur = con.execute("SELECT rowid, node_name, xCoord, yCoord, layer_index FROM nodes NOT INDEXED")
        while True:
            recs = rcur.fetchmany(_READ_CHUNK)
            if not recs:
                break
            for rid, nm, x, y, lay in recs:
                cls = marks.get(nm)
                if cls is None:
                    continue
                g = goto[cls]
                g[0] += (x or 0.0); g[1] += (y or 0.0); g[2] += 1
                if lay is not None and lay < g[3]:
                    g[3] = lay
                yield (rid, cls)

    n_rows = acc.feed_region(region_annot_rows())   # DB へは書かず配列へ

    rdrows = []
    for c in classes:
        i = class_id[c]; g = goto[i]
        if g[2] > 0:
            rdrows.append((i, c, ref_key, g[0] / g[2], g[1] / g[2], (g[3] if g[3] < (1 << 30) else None)))
        else:
            rdrows.append((i, c, ref_key, None, None, None))
    cur.executemany("INSERT INTO region_dict VALUES (?,?,?,?,?,?)", rdrows)
    cur.execute("CREATE TABLE IF NOT EXISTS annot_track("
                "track TEXT, kind TEXT, ref_key TEXT, source TEXT, note TEXT)")
    cur.execute("DELETE FROM annot_track WHERE track='region'")
    cur.execute("INSERT INTO annot_track VALUES (?,?,?,?,?)",
                ("region", "region", ref_key, source,
                 f"{n_rows} rows (climb frac>={min_frac}) / {len(classes)} classes"))
    con.commit()
    print(f"  in-mem climb: covered node_name={len(rng)} -> marked {n_marks} "
          f"-> node_annot rows(region)={n_rows} (overlap frac >= {min_frac})")


def main():
    ap = argparse.ArgumentParser(
        description="ggb-annotate: 構築済み layered.db への後付けアノテーション (Part B, per-node blob)")
    ap.add_argument("db")
    ap.add_argument("--band", metavar="cytoBand.txt[.gz]")
    ap.add_argument("--band-ref", default="GRCh38")
    ap.add_argument("--source", default="UCSC hg38 cytoBand")
    ap.add_argument("--gene", metavar="annotation.gtf[.gz]")
    ap.add_argument("--gene-ref", default="GRCh38")
    ap.add_argument("--gene-source", default="GENCODE GTF")
    ap.add_argument("--gene-type", metavar="csv",
                    help="gene_type を絞る(例 protein_coding,lncRNA)。省略で全 type")
    ap.add_argument("--gene-distill", metavar="DIR",
                    help="葉ノードを GRCh38 パス walk で実 occurrence 射影する distill dir(既定の正確法)。"
                         "super-node は範囲射影。省略時は --distill を流用、どちらも無ければ "
                         "--gene-range-fallback が無い限りエラー(旧・全ノード範囲射影の暗黙採用を防ぐ)")
    ap.add_argument("--gene-ref-path", default="grch38",
                    help="gene walk する distill パスの sample key (既定 grch38, 大小無視)")
    ap.add_argument("--gene-range-fallback", action="store_true",
                    help="distill 無しで旧・全ノード範囲射影(近似)を明示採用(既定は walk 必須)")
    ap.add_argument("--region", metavar="regions.bed")
    ap.add_argument("--region-ref", default="chm13")
    ap.add_argument("--distill")
    ap.add_argument("--region-source", default="T2T-CHM13 cytoBand/CenSat")
    ap.add_argument("--region-min-frac", type=float, default=0.5)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--annot-out", default=None,
                    help="サイドカーの出力先を明示する（既定 <db>.annot）。別ファイルへ書けば"
                         "既存のアノテを壊さずに作り直せ、複数バージョンを並べて置ける。"
                         "viewer に見せるものは <db>.annot に rename/symlink で切り替える")
    ap.add_argument("--into-db", action="store_true",
                    help="旧挙動: 主 DB 内に node_annot を作る。既定は <db>.annot サイドカーへ直接書く"
                         "（主 DB の freelist で物理配置が散るのを避ける。ggb_annot_sidecar.py の"
                         "読み戻し段が不要になる）")
    args = ap.parse_args()

    if not (args.band or args.gene or args.region):
        ap.error("--band / --gene / --region のいずれかが必要")
    if args.region and not args.distill:
        ap.error("--region には --distill が必要")
    gene_types = [s.strip() for s in args.gene_type.split(",")] if args.gene_type else None

    # gene 射影の既定 = GRCh38 パス walk(正確法)。distill は --gene-distill か --distill から解決。
    # どちらも無い時は暗黙で旧・範囲射影に落ちないよう、--gene-range-fallback を要求(明示 opt-out)。
    gene_distill = args.gene_distill or args.distill
    if args.gene and not gene_distill and not args.gene_range_fallback:
        ap.error("--gene は既定で --gene-distill DIR(または --distill DIR)による GRCh38 walk 射影を使う。"
                 "distill を渡すか、旧・範囲射影(近似)を使うなら --gene-range-fallback を明示せよ")

    need_db = bool(args.band or args.gene or (args.region and not args.dry_run))
    con = sqlite3.connect(args.db) if need_db else None
    # アノテの置き場: 既定は `<db>.annot` サイドカー（新規ファイル＝追記＝物理連続）。
    # 主 DB は freelist が巨大で、そこに書くと rowid 昇順でも物理配置が散る（--into-db で旧挙動）。
    sc_path = args.annot_out or (args.db + ".annot")
    if con is not None:
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA cache_size=-2000000")
        con.execute("PRAGMA temp_store=FILE")
    acc = None
    if con is not None:
        acc = AnnotAccum(con, con_path=args.db)
        # 今回書き換える列は既存値を読む必要が無い。特に gene_blob は WG で 10GB 級なので、
        # --gene を走らせる時にそれを読まないだけで大きく違う。
        skip = set()
        if args.band:
            skip |= {"band_id", "band_multi"}
        if args.gene:
            skip |= {"gene_cnt", "gene_blob"}
        if args.region and not args.dry_run:
            skip |= {"region_class"}
        nprev = acc.load_existing(skip=skip, sidecar_path=sc_path)
        if nprev:
            print(f"[ggb-annotate] 既存 node_annot から {nprev:,} 行を引き継ぎ"
                  f"（今回書く列 {sorted(skip)} は読み飛ばし）")
    if args.band:
        annotate_band(con, args.band, args.band_ref, args.source, acc)
    if args.gene:
        annotate_gene(con, args.gene, args.gene_ref, args.gene_source, acc, gene_types,
                      distill_dir=gene_distill, ref_path_key=args.gene_ref_path)
    if args.region:
        annotate_region(con, args.region, args.region_ref, args.distill,
                        args.region_source, acc, dry_run=args.dry_run,
                        min_frac=args.region_min_frac)
    if acc is not None:
        import time
        t0 = time.time()
        if args.into_db:
            n = acc.write()      # 旧挙動: 主 DB 内に node_annot を作り直す
            where = f"主 DB 内 node_annot（★freelist で物理配置が散る）"
        else:
            n = acc.write(sidecar_path=sc_path)   # 既定: <db>.annot へ直接（物理連続）
            where = f"{sc_path}（新規ファイル＝追記＝物理連続, 索引 idx_na_cov 込み）"
        print(f"[ggb-annotate] node_annot を書き出し: {n:,} 行 / {time.time() - t0:.1f}s → {where}")
    if con is not None:
        con.close()


if __name__ == "__main__":
    main()
