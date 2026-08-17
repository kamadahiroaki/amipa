// reads_core — オンデマンド reads の索引付与の hot path(Rust)。
//
// **リード実体の容器(seekable zstd)の書き出しもここが担当する**(GAF 1パス化・Python との
// 二重読み解消・書込高速化)。形式の正は `prep/amipa_prep/zstd_seek.py` の docstring:
// 「非圧縮 frame_bytes ごとに独立 zstd フレーム + 末尾に skippable frame のシークテーブル」
// (zstd 公式 seekable format v0.1.0)。フレームは**行の切れ目でだけ閉じる**ので 1 行が
// フレームを跨がない。位置(`read_aln.voff`)は**素の非圧縮バイトオフセット**＝容器実装に依存しない。
//
// Python(reads_attach.py)側:
//   - スキーマ作成(node_reads/read_aln/read_src/read_cov/read_meta)、read_src 登録、con.close()
//   - reads_core.build_reads(...) を呼ぶ。read_meta は後で書く。
// Rust(build_reads)側:
//   - 各サンプル: 入力 GAF(gzip)を1パス読み → zstd 書込(voff 採取) → path 走査
//   - read_aln を rusqlite 直書き、edge_sup を compact HashMap、depth→read_cov、node_reads 転置索引
//
// ★Python 意味論の忠実移植(内容一致検証用):
//   TOK=[<>](\d+) / ヘッダ(@)は容器に書くが voff/parse しない / aln_id は len(cols)>=12 で加算
//   (座標parse失敗でも消費) / 転置索引は 1リード内 gid 重複を集約 / offset は found ノードのみ前進 /
//   edge key は canonical (min,max)。

use flate2::read::MultiGzDecoder;
use numpy::PyReadonlyArray1;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};

const SKIPPABLE_MAGIC: u32 = 0x184D_2A5E; // zstd skippable frame(素の zstd は読み飛ばす)
const SEEKABLE_MAGIC: u32 = 0x8F92_EAB1; // seekable format のフッタ

/// 行を追記して「行頭の**非圧縮**オフセット」を返す seekable zstd ライタ。
/// zstd_seek.py の SeekableZstdWriter と同じ物を書く(相互に読める)。
struct ZstdSeekWriter<W: Write> {
    inner: W,
    buf: Vec<u8>,
    frame_bytes: usize,
    uoffset: u64,             // 現フレーム先頭の非圧縮オフセット
    entries: Vec<(u32, u32)>, // (圧縮size, 非圧縮size)
    cctx: zstd::bulk::Compressor<'static>,
}
impl<W: Write> ZstdSeekWriter<W> {
    fn new(inner: W, frame_bytes: usize, level: i32) -> std::io::Result<Self> {
        let mut cctx = zstd::bulk::Compressor::new(level)?;
        // フレーム毎に xxhash を付ける(壊れた読み出しを黙って通さない)。
        cctx.set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))?;
        Ok(Self {
            inner,
            buf: Vec::with_capacity(frame_bytes + (1 << 16)),
            frame_bytes,
            uoffset: 0,
            entries: Vec::new(),
            cctx,
        })
    }
    /// 次に書くバイト(=行頭)の非圧縮オフセット。
    #[inline]
    fn virtual_position(&self) -> i64 {
        (self.uoffset + self.buf.len() as u64) as i64
    }
    /// 1 行(末尾 \n 込み)を書く。フレームは**行の切れ目でだけ**閉じる。
    fn write_bytes(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= self.frame_bytes {
            self.flush_frame()?;
        }
        Ok(())
    }
    fn flush_frame(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let comp = self.cctx.compress(&self.buf)?;
        if comp.len() > u32::MAX as usize || self.buf.len() > u32::MAX as usize {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "zstd frame > 4GiB",
            ));
        }
        self.inner.write_all(&comp)?;
        self.entries.push((comp.len() as u32, self.buf.len() as u32));
        self.uoffset += self.buf.len() as u64;
        self.buf.clear();
        Ok(())
    }
    /// 残りを吐き出し、シークテーブル(skippable frame)を書いて閉じる。
    fn close(mut self) -> std::io::Result<()> {
        self.flush_frame()?;
        let n = self.entries.len() as u32;
        let tbl_len = n as usize * 8 + 9;
        self.inner.write_all(&SKIPPABLE_MAGIC.to_le_bytes())?;
        self.inner.write_all(&(tbl_len as u32).to_le_bytes())?;
        let mut tbl = Vec::with_capacity(tbl_len);
        for (cs, ds) in &self.entries {
            tbl.extend_from_slice(&cs.to_le_bytes());
            tbl.extend_from_slice(&ds.to_le_bytes());
        }
        tbl.extend_from_slice(&n.to_le_bytes());
        tbl.push(0u8); // descriptor: エントリに checksum は付けない
        tbl.extend_from_slice(&SEEKABLE_MAGIC.to_le_bytes());
        self.inner.write_all(&tbl)?;
        self.inner.flush()?;
        Ok(())
    }
}

/// LEB128 unsigned varint を buf に追記。
#[inline]
fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if v == 0 {
            break;
        }
    }
}

/// バイト列を非負 i64 として厳密パース(全バイト数字のときのみ Some)。GAF 座標が "*" 等なら None。
fn parse_u_i64(b: &[u8]) -> Option<i64> {
    if b.is_empty() {
        return None;
    }
    let mut v: i64 = 0;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v.saturating_mul(10).saturating_add((c - b'0') as i64);
    }
    Some(v)
}

#[pyfunction]
#[allow(clippy::too_many_arguments)]
fn build_reads(
    db_path: String,
    sample_nos: Vec<i64>,
    sample_ids: Vec<String>,
    gaf_paths: Vec<String>,
    out_dir: String,
    size_arr: PyReadonlyArray1<i64>,
    maxlayer: i64,
    no_cov: bool,
    frame_bytes: usize,
    level: i32,
    drop_tags: Vec<String>,
) -> PyResult<(Vec<i64>, i64, i64, f64)> {
    let sizes = size_arr
        .as_slice()
        .map_err(|e| PyRuntimeError::new_err(format!("size_arr: {e}")))?;
    // 落とすタグは 2 文字の名前で受ける("bq" → 行中の "bq:Z:..." を捨てる)
    let mut drop2: Vec<[u8; 2]> = Vec::new();
    for t in &drop_tags {
        let b = t.as_bytes();
        if b.len() != 2 {
            return Err(PyRuntimeError::new_err(format!(
                "drop_tags は 2 文字のタグ名で指定する: {t:?}"
            )));
        }
        drop2.push([b[0], b[1]]);
    }

    let ns = sample_nos.len();
    if sample_ids.len() != ns || gaf_paths.len() != ns {
        return Err(PyRuntimeError::new_err(
            "sample_nos/sample_ids/gaf_paths の長さ不一致",
        ));
    }

    let run = || -> Result<(Vec<i64>, i64, i64, f64), Box<dyn Error>> {
        let n_size = sizes.len();
        let mut conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2000000;",
        )?;

        let mut depth_bases: Vec<f64> = vec![0.0; n_size];
        // ★posting-list(転置索引): gfa_id -> そのノードを通過したリードの aln_id 昇順リスト。
        //   read_node(per-visit 73億行) を廃し、ノード毎に aln_id を delta+varint 圧縮 blob 化して node_reads へ。
        //   aln_id はリード処理順=昇順で push されるので blob 内は昇順(delta 非負)が保証される。
        let mut postings: Vec<Vec<u32>> = Vec::new();
        postings.resize_with(n_size, Vec::new);
        // 点2: edge_sup を compact HashMap に(Python dict の ~10分の1)。canonical (lo,hi) の u32 対。
        let mut edge_sup: std::collections::HashMap<(u32, u32), u32> =
            std::collections::HashMap::new();
        let mut per_sample_nreads: Vec<i64> = Vec::with_capacity(ns);
        let mut aln_id: i64 = 0; // 全サンプル通し
        let mut tot: i64 = 0;
        let mut miss: i64 = 0;

        let tx = conn.transaction()?;
        {
            let mut ins_ra = tx
                .prepare("INSERT INTO read_aln(aln_id,sample_no,voff,read_name) VALUES(?,?,?,?)")?;
            let mut seen: HashSet<i64> = HashSet::new();

            for si in 0..ns {
                let sample_no = sample_nos[si];
                let gpath = &gaf_paths[si];
                let out_path = format!("{}/{}.gaf.zst", out_dir, sample_ids[si]);

                // 入力 GAF(gzip or plain)を読む
                let inf = File::open(gpath)?;
                let reader: Box<dyn std::io::Read> = if gpath.ends_with(".gz") {
                    Box::new(MultiGzDecoder::new(inf))
                } else {
                    Box::new(inf)
                };
                let mut br = BufReader::with_capacity(1 << 20, reader);

                // 出力 seekable zstd
                let outf = File::create(&out_path)?;
                let mut bw = ZstdSeekWriter::new(
                    BufWriter::with_capacity(1 << 20, outf),
                    frame_bytes,
                    level,
                )?;

                let mut line: Vec<u8> = Vec::with_capacity(1 << 16);
                let mut outline: Vec<u8> = Vec::with_capacity(1 << 16);
                let mut n_reads: i64 = 0;
                let mut tabs: Vec<usize> = Vec::with_capacity(32);

                loop {
                    line.clear();
                    let n = br.read_until(b'\n', &mut line)?;
                    if n == 0 {
                        break;
                    }
                    if line[0] == b'@' {
                        bw.write_bytes(&line)?; // ヘッダは容器に書くが voff/parse しない
                        continue;
                    }

                    // 末尾 \n を除いてパース
                    let l: &[u8] = if *line.last().unwrap() == b'\n' {
                        &line[..line.len() - 1]
                    } else {
                        &line[..]
                    };
                    tabs.clear();
                    for (i, &b) in l.iter().enumerate() {
                        if b == b'\t' {
                            tabs.push(i);
                        }
                    }
                    let ncols = tabs.len() + 1;
                    let field = |j: usize| -> &[u8] {
                        let s = if j == 0 { 0 } else { tabs[j - 1] + 1 };
                        let e = if j < tabs.len() { tabs[j] } else { l.len() };
                        &l[s..e]
                    };

                    // ★保存するのは「必要なタグだけ」に間引いた行(既定では塩基クオリティ bq:Z を捨てる)。
                    //   HiFi の GAF は 1 行の 3/4 が bq:Z だが、ビューアは一切使わない。
                    //   間引きは**書き出す行**にだけ効く。以下の解析は元の行から行う。
                    let v = bw.virtual_position(); // 行頭の voff(=非圧縮オフセット。書込**前**に採る)
                    if drop2.is_empty() || ncols <= 12 {
                        bw.write_bytes(&line)?;
                    } else {
                        outline.clear();
                        outline.extend_from_slice(&l[..tabs[11]]); // 1..12 列はそのまま
                        for j in 12..ncols {
                            let f = field(j);
                            if f.len() >= 3 && f[2] == b':' && drop2.contains(&[f[0], f[1]]) {
                                continue;
                            }
                            outline.push(b'\t');
                            outline.extend_from_slice(f);
                        }
                        outline.push(b'\n');
                        bw.write_bytes(&outline)?;
                    }

                    if ncols < 12 {
                        continue; // <12 列: aln_id 加算せず
                    }

                    aln_id += 1;
                    n_reads += 1;

                    let ps = parse_u_i64(field(7));
                    let pe = parse_u_i64(field(8));
                    if ps.is_none() || pe.is_none() {
                        continue; // 座標 parse 失敗(未マップ等): aln_id 消費・行は出さない
                    }
                    let path_start = ps.unwrap();
                    let path_end = pe.unwrap();

                    let name = std::str::from_utf8(field(0)).unwrap_or("");
                    ins_ra.execute(params![aln_id, sample_no, v, name])?;

                    // path トークン走査([<>]\d+)
                    let pb = field(5);
                    let mut offset: i64 = 0;
                    let mut prev_gid: i64 = -1;
                    seen.clear();
                    let mut i = 0usize;
                    while i < pb.len() {
                        let c = pb[i];
                        if c == b'<' || c == b'>' {
                            let mut j = i + 1;
                            let mut gid: i64 = 0;
                            let mut any = false;
                            while j < pb.len() && pb[j].is_ascii_digit() {
                                gid = gid * 10 + (pb[j] - b'0') as i64;
                                any = true;
                                j += 1;
                            }
                            if !any {
                                i += 1;
                                continue;
                            }
                            tot += 1;
                            let seg = if gid >= 0 && (gid as usize) < n_size {
                                sizes[gid as usize]
                            } else {
                                0
                            };
                            if seg == 0 {
                                miss += 1;
                                prev_gid = -1;
                                i = j;
                                continue;
                            }
                            let g = gid as u32;
                            if seen.insert(gid) {
                                postings[gid as usize].push(aln_id as u32); // 転置索引に aln_id を追記(昇順)
                            }
                            let a0 = path_start.max(offset);
                            let a1 = path_end.min(offset + seg);
                            if a1 > a0 {
                                depth_bases[gid as usize] += (a1 - a0) as f64;
                            }
                            if prev_gid >= 0 && prev_gid != gid {
                                let pg = prev_gid as u32;
                                let key = if pg < g { (pg, g) } else { (g, pg) };
                                *edge_sup.entry(key).or_insert(0) += 1;
                            }
                            prev_gid = gid;
                            offset += seg;
                            i = j;
                        } else {
                            i += 1;
                        }
                    }
                }
                bw.close()?; // 残フレーム + シークテーブル
                per_sample_nreads.push(n_reads);
                tx.execute(
                    "UPDATE read_src SET n_reads=?1 WHERE sample_no=?2",
                    params![n_reads, sample_no],
                )?;
            }
        }
        tx.commit()?;

        let _ = maxlayer; // maxlayer は backend が edge_read_support を join する層。Rust では未使用。

        // ★node_reads(転置索引 blob) を postings から構築(read_node per-visit 表は廃止)。
        //   gfa_id 毎に aln_id 昇順リストを delta+varint 圧縮 → BLOB。node→reads は blob 1件を復号するだけ。
        conn.execute("DROP TABLE IF EXISTS node_reads", [])?;
        conn.execute(
            "CREATE TABLE node_reads(gfa_id INTEGER PRIMARY KEY, postings BLOB)",
            [],
        )?;
        {
            let txn = conn.transaction()?;
            {
                let mut ins = txn.prepare("INSERT INTO node_reads(gfa_id,postings) VALUES(?,?)")?;
                let mut blob: Vec<u8> = Vec::with_capacity(512);
                for gid in 0..n_size {
                    let lst = &postings[gid];
                    if lst.is_empty() {
                        continue;
                    }
                    blob.clear();
                    let mut prev: u32 = 0;
                    for &a in lst {
                        write_varint(&mut blob, (a - prev) as u64);
                        prev = a;
                    }
                    ins.execute(params![gid as i64, &blob])?;
                }
            }
            txn.commit()?;
        }
        conn.execute("CREATE INDEX idx_read_aln_name ON read_aln(read_name)", [])?;

        // edge_read_support: サイドカー表(base の edges は改変しない)。両向き。backend が maxlayer で join。
        conn.execute("DROP TABLE IF EXISTS edge_read_support", [])?;
        conn.execute(
            "CREATE TABLE edge_read_support(source TEXT, target TEXT, support INTEGER)",
            [],
        )?;
        {
            let tx2 = conn.transaction()?;
            {
                let mut ins_es = tx2
                    .prepare("INSERT INTO edge_read_support(source,target,support) VALUES(?,?,?)")?;
                for (&(a, b), &cnt) in edge_sup.iter() {
                    let na = format!("n{a}");
                    let nb = format!("n{b}");
                    ins_es.execute(params![na, nb, cnt as i64])?;
                    ins_es.execute(params![nb, na, cnt as i64])?;
                }
            }
            tx2.commit()?;
        }
        conn.execute("CREATE INDEX idx_ers ON edge_read_support(source,target)", [])?;

        // read_cov(葉平均深度サマリ)
        let mut max_depth: f64 = 0.0;
        if !no_cov {
            conn.execute("DROP TABLE IF EXISTS read_cov", [])?;
            conn.execute(
                "CREATE TABLE read_cov(node_name TEXT PRIMARY KEY, depth REAL)",
                [],
            )?;
            let tx3 = conn.transaction()?;
            {
                let mut ins_cov = tx3.prepare("INSERT INTO read_cov(node_name,depth) VALUES(?,?)")?;
                for gid in 0..n_size {
                    let sz = sizes[gid];
                    if sz > 0 {
                        let d = depth_bases[gid] / (sz as f64);
                        if d > max_depth {
                            max_depth = d;
                        }
                        if d > 0.0 {
                            ins_cov.execute(params![format!("n{gid}"), d])?;
                        }
                    }
                }
            }
            tx3.commit()?;
        }

        Ok((per_sample_nreads, tot, miss, max_depth))
    };

    run().map_err(|e| PyRuntimeError::new_err(e.to_string()))
}

#[pymodule]
fn reads_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(build_reads, m)?)?;
    Ok(())
}
