//! tiled_core — タイル順（Z-order）サイドカー `<db>.tiled` を作る Rust core。
//!
//! 参照実装は prep/amipa_prep/tile_index.py（numpy）。**出力は行単位で同一**であること（chr22 で検証）。
//! 違いは常駐と速度: Python は全層の名前表を持ち WG で 48GB / 113 分だったが、こちらは
//! 「層 L のノードを読む → nodes_t に書く → 同じ層の辺を読む（端点名は層内の名前表で解く）→ edges_t に書く
//!  → 名前表を捨てる」を層ごとに繰り返すので常駐は最大層ぶん。
//!
//! 入力（Python が stats.data を読んで渡す）: layer_zoom（格子 g_L の計算）、layer_nodes（層ごとの rowid 範囲。
//! nodes の rowid は層順に連続＝emit の挿入順）、world（無ければ R-Tree ルート → nodes 全走査）。
//! hap マスク語は node_contig_cov / edge_contig_cov の blob（[u32 n][n×u32 contig_id]）から計算する
//! （hap_index.py MaskCalc と同じ規則: exact=hap をそのままビット位置、bucket=hap % bits）。
//! 葉層のリード支持は <db>.reads の edge_read_support(source,target,support) を層内の名前表で解いて付ける
//! （向きは区別、重複鍵は最大）。旧式の edges.read_support 列にも対応。

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use rusqlite::types::Null;
use rusqlite::{params, Connection, OpenFlags, Statement};
use std::io::Write;
use std::time::Instant;

fn err<E: std::fmt::Display>(ctx: &str, e: E) -> PyErr {
    PyRuntimeError::new_err(format!("{ctx}: {e}"))
}

fn log(t0: &Instant, m: &str) {
    println!("[tile-index {:7.1}s] {}", t0.elapsed().as_secs_f64(), m);
    let _ = std::io::stdout().flush();
}

// ── Z-order ────────────────────────────────────────────────────────────────
fn part1by1(v: u64) -> u64 {
    let mut v = v & 0xffff_ffff;
    v = (v | (v << 16)) & 0x0000_FFFF_0000_FFFF;
    v = (v | (v << 8)) & 0x00FF_00FF_00FF_00FF;
    v = (v | (v << 4)) & 0x0F0F_0F0F_0F0F_0F0F;
    v = (v | (v << 2)) & 0x3333_3333_3333_3333;
    (v | (v << 1)) & 0x5555_5555_5555_5555
}
fn morton(tx: u64, ty: u64) -> i64 {
    (part1by1(tx) | (part1by1(ty) << 1)) as i64
}
/// Python の round()（偶数丸め）と同じ
fn round_half_even(v: f64) -> f64 {
    let t = v.trunc();
    if (v - t).abs() == 0.5 {
        if (t as i64) % 2 == 0 { t } else { v.round() }
    } else {
        v.round()
    }
}
/// numpy の `(x / tw).astype(np.int64)`（0 方向への切り捨て）→ clip
fn tile_of(v: f64, tw: f64, lim: i64) -> u64 {
    let t = (v / tw).trunc() as i64;
    t.clamp(0, lim) as u64
}

// ── hap マスク ─────────────────────────────────────────────────────────────
struct MaskCalc {
    c2h: Vec<i32>,
    words: usize,
    bits: usize,
    bucket: bool,
}
impl MaskCalc {
    fn compute(&self, blob: Option<&[u8]>, out: &mut [u64]) {
        for w in out.iter_mut() { *w = 0 }
        let b = match blob { Some(b) if b.len() >= 4 => b, _ => return };
        let k = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
        if k == 0 || b.len() < 4 + 4 * k { return }   // 壊れた blob は安全側（マスク 0）
        for i in 0..k {
            let o = 4 + 4 * i;
            let cid = u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
            if cid >= self.c2h.len() { continue }
            let h = self.c2h[cid];
            if h < 0 { continue }
            let bit = if self.bucket { (h as usize) % self.bits } else { h as usize };
            let w = bit >> 6;
            if w < self.words { out[w] |= 1u64 << (bit & 63) }
        }
    }
}

/// contig_dict → (c2h, n_hap)。hap_id は distinct (sample, haplotype) を contig_id 昇順で採番（hap_index.build_hap_map と同一）
fn build_hap_map(con: &Connection) -> PyResult<(Vec<i32>, usize)> {
    let mut st = con
        .prepare("SELECT contig_id, sample, haplotype FROM contig_dict ORDER BY contig_id")
        .map_err(|e| err("contig_dict", e))?;
    let rows: Vec<(i64, String, String)> = st
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<String>>(2)?.unwrap_or_default()))
        })
        .map_err(|e| err("contig_dict", e))?
        .collect::<Result<_, _>>()
        .map_err(|e| err("contig_dict", e))?;
    if rows.is_empty() { return Ok((Vec::new(), 0)) }
    let maxid = rows.iter().map(|r| r.0).max().unwrap_or(-1);
    let mut c2h = vec![-1i32; (maxid + 1) as usize];
    let mut last: Option<(String, String)> = None;
    let mut h: i32 = -1;
    for (cid, s, hp) in rows {
        let key = (s, hp);
        if last.as_ref() != Some(&key) { h += 1; last = Some(key) }
        if cid >= 0 { c2h[cid as usize] = h }
    }
    Ok((c2h, (h + 1) as usize))
}

fn has_table(con: &Connection, schema: &str, name: &str) -> bool {
    let q = format!("SELECT 1 FROM {schema}sqlite_master WHERE type IN ('table','view') AND name=?1");
    con.query_row(&q, [name], |_| Ok(())).is_ok()
}
fn has_index(con: &Connection, name: &str) -> bool {
    con.query_row("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1", [name], |_| Ok(())).is_ok()
}
fn table_cols(con: &Connection, table: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(mut st) = con.prepare(&format!("PRAGMA table_info({table})")) {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(1)) {
            for c in rows.flatten() { out.push(c) }
        }
    }
    out
}

/// R-Tree ルートノード（あれば）から world を O(1) で。無ければ None
fn world_from_rtree(con: &Connection) -> Option<(f64, f64, f64, f64)> {
    let buf: Vec<u8> = con
        .query_row("SELECT data FROM nodes_rtree_node WHERE nodeno=1", [], |r| r.get(0))
        .ok()?;
    if buf.len() < 4 { return None }
    let n = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let (mut x0, mut x1, mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for i in 0..n {
        let b = 4 + i * 32;
        if b + 24 > buf.len() { break }
        let f = |o: usize| f32::from_be_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]) as f64;
        x0 = x0.min(f(b + 8)); x1 = x1.max(f(b + 12)); y0 = y0.min(f(b + 16)); y1 = y1.max(f(b + 20));
    }
    if x1 > x0 && y1 > y0 { Some((x0, x1, y0, y1)) } else { None }
}

// ── 層内の名前表（連結バッファ＋ソート済み添字。二分探索で名前→添字） ─────────
struct NameIndex {
    buf: Vec<u8>,
    off: Vec<u64>,      // len = n+1
    order: Vec<u32>,    // 名前順の添字
}
impl NameIndex {
    fn name(&self, i: u32) -> &[u8] {
        &self.buf[self.off[i as usize] as usize..self.off[i as usize + 1] as usize]
    }
    fn build(buf: Vec<u8>, off: Vec<u64>) -> Self {
        let n = off.len() - 1;
        let mut order: Vec<u32> = (0..n as u32).collect();
        let tmp = NameIndex { buf, off, order: Vec::new() };
        order.sort_unstable_by(|&a, &b| tmp.name(a).cmp(tmp.name(b)));
        NameIndex { buf: tmp.buf, off: tmp.off, order }
    }
    fn find(&self, key: &[u8]) -> Option<u32> {
        self.order.binary_search_by(|&i| self.name(i).cmp(key)).ok().map(|p| self.order[p])
    }
}

struct LayerNodes {
    rowid: Vec<i64>,
    x: Vec<f64>,
    y: Vec<f64>,
    r: Vec<f64>,
    mkey: Vec<i64>,
    names: NameIndex,
}

#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db, out, layer_zoom, layer_nodes, world=None, k_tiles=2.5, wmax=8, reads_path=None))]
fn build(
    py: Python<'_>,
    db: String,
    out: String,
    layer_zoom: Vec<f64>,
    layer_nodes: Vec<i64>,
    world: Option<Vec<f64>>,
    k_tiles: f64,
    wmax: usize,
    reads_path: Option<String>,
) -> PyResult<PyObject> {
    let t0 = Instant::now();
    let src = Connection::open_with_flags(
        &db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    ).map_err(|e| err("open src", e))?;
    src.execute_batch("PRAGMA cache_size=-1000000;").map_err(|e| err("pragma", e))?;
    let max_l = layer_zoom.len() as i64 - 1;
    if max_l < 0 || layer_nodes.len() as i64 != max_l + 1 {
        return Err(PyRuntimeError::new_err("layer_zoom / layer_nodes の長さが合わない"));
    }
    let n_ids: i64 = src.query_row("SELECT MAX(rowid) FROM nodes", [], |r| r.get::<_, Option<i64>>(0))
        .map_err(|e| err("nodes", e))?.unwrap_or(0);
    let n_eids: i64 = src.query_row("SELECT MAX(rowid) FROM edges", [], |r| r.get::<_, Option<i64>>(0))
        .map_err(|e| err("edges", e))?.unwrap_or(0);
    let total_nodes: i64 = layer_nodes.iter().sum();
    if total_nodes != n_ids {
        return Err(PyRuntimeError::new_err(format!(
            "stats.layer_nodes の合計 {total_nodes} と nodes の MAX(rowid) {n_ids} が違う（rowid が層順に連続でない DB は Python 実装で）")));
    }

    // ── world ──
    let (x0, x1, y0, y1) = match world.as_deref() {
        Some([a, b, c, d]) => (*a, *b, *c, *d),
        _ => match world_from_rtree(&src) {
            Some(w) => w,
            None => {
                log(&t0, "world: stats.world も nodes_rtree も無いので nodes を全走査する");
                src.query_row(
                    "SELECT MIN(xCoord-radius), MAX(xCoord+radius), MIN(yCoord-radius), MAX(yCoord+radius) FROM nodes NOT INDEXED",
                    [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                ).map_err(|e| err("world scan", e))?
            }
        },
    };
    let w_world = x1 - x0;
    let g_l: Vec<i64> = layer_zoom.iter()
        .map(|lz| round_half_even((k_tiles * lz / w_world).log2()).clamp(0.0, 30.0) as i64)
        .collect();
    log(&t0, &format!("{db}: world W={w_world:.4} layers={} g_L={:?} max_rowid={n_ids}", max_l + 1, g_l));

    // ── hap マスク / hb（node_contig_cov から自前計算）──
    let ncc_cols = table_cols(&src, "node_contig_cov");
    let has_hb = ncc_cols.iter().any(|c| c == "hb");
    let (c2h, n_hap) = if ncc_cols.is_empty() { (Vec::new(), 0) } else { build_hap_map(&src)? };
    let (mut words, mut mode) = (0usize, "exact");
    if n_hap > 0 {
        words = (n_hap + 63) / 64;
        if words > wmax { words = wmax; mode = "bucket" }
    }
    let mc = MaskCalc { c2h: c2h.clone(), words, bits: 64 * words, bucket: mode == "bucket" };
    let nn = (n_ids + 1) as usize;
    let mut hb: Vec<i64> = vec![i64::MIN; nn];
    let mut hm: Vec<u64> = vec![0; nn * words];
    if !ncc_cols.is_empty() && (has_hb || words > 0) {
        let sql = format!("SELECT node_rowid, {}, {} FROM node_contig_cov",
                          if has_hb { "hb" } else { "NULL" }, if words > 0 { "blob" } else { "NULL" });
        let mut st = src.prepare(&sql).map_err(|e| err("node_contig_cov", e))?;
        let mut rows = st.query([]).map_err(|e| err("node_contig_cov", e))?;
        let mut n = 0u64;
        let mut tmp = vec![0u64; words];
        while let Some(r) = rows.next().map_err(|e| err("node_contig_cov", e))? {
            let id: i64 = r.get(0).map_err(|e| err("ncc", e))?;
            if id < 0 || id as usize >= nn { continue }
            if has_hb { hb[id as usize] = r.get::<_, Option<i64>>(1).map_err(|e| err("ncc hb", e))?.unwrap_or(i64::MIN) }
            if words > 0 {
                let b: Option<Vec<u8>> = r.get(2).map_err(|e| err("ncc blob", e))?;
                mc.compute(b.as_deref(), &mut tmp);
                hm[id as usize * words..(id as usize + 1) * words].copy_from_slice(&tmp);
            }
            n += 1;
        }
        log(&t0, &format!("node_contig_cov から hb={} hm={} 語({mode}, H={n_hap}) を {n} 行計算した",
                          if has_hb { "有" } else { "無" }, words));
    }
    // ── 辺の hb / hm（edge_contig_cov）──
    let ecc_cols = table_cols(&src, "edge_contig_cov");
    let has_ehb = ecc_cols.iter().any(|c| c == "hb");
    let ne = (n_eids + 1) as usize;
    let mut ehb: Vec<i64> = vec![i64::MIN; ne];
    let mut ehm: Vec<u64> = vec![0; ne * words];
    if !ecc_cols.is_empty() && (has_ehb || words > 0) {
        let use_idx = words == 0 && has_index(&src, "idx_ecc_hb");
        let sql = format!("SELECT edge_rowid, {}, {} FROM edge_contig_cov{}",
                          if has_ehb { "hb" } else { "NULL" }, if words > 0 { "blob" } else { "NULL" },
                          if use_idx { " INDEXED BY idx_ecc_hb" } else { "" });
        let mut st = src.prepare(&sql).map_err(|e| err("edge_contig_cov", e))?;
        let mut rows = st.query([]).map_err(|e| err("edge_contig_cov", e))?;
        let mut n = 0u64;
        let mut tmp = vec![0u64; words];
        while let Some(r) = rows.next().map_err(|e| err("edge_contig_cov", e))? {
            let id: i64 = r.get(0).map_err(|e| err("ecc", e))?;
            if id < 0 || id as usize >= ne { continue }
            if has_ehb { ehb[id as usize] = r.get::<_, Option<i64>>(1).map_err(|e| err("ecc hb", e))?.unwrap_or(i64::MIN) }
            if words > 0 {
                let b: Option<Vec<u8>> = r.get(2).map_err(|e| err("ecc blob", e))?;
                mc.compute(b.as_deref(), &mut tmp);
                ehm[id as usize * words..(id as usize + 1) * words].copy_from_slice(&tmp);
            }
            n += 1;
        }
        log(&t0, &format!("edge_contig_cov から hb={} hm を {n} 行計算した{}", if has_ehb { "有" } else { "無" },
                          if use_idx { "（被覆索引 idx_ecc_hb を順読み）" } else { "" }));
    }
    // ── リード支持の出所 ──
    let mut rs_mode = "";
    if let Some(rp) = reads_path.as_deref() {
        if std::path::Path::new(rp).exists() {
            src.execute("ATTACH DATABASE ?1 AS rd", [format!("file:{rp}?mode=ro")]).map_err(|e| err("attach reads", e))?;
            if has_table(&src, "rd.", "edge_read_support") { rs_mode = "sidecar" }
        }
    }
    let ecols = table_cols(&src, "edges");
    if rs_mode.is_empty() && ecols.iter().any(|c| c == "read_support") { rs_mode = "column" }
    log(&t0, &format!("edge hb={} read_support={}", if has_ehb { "有" } else { "無" }, if rs_mode.is_empty() { "無し" } else { rs_mode }));

    // ── 出力 DB ──
    let _ = std::fs::remove_file(&out);
    let _ = std::fs::remove_file(format!("{out}-journal"));
    let dst = Connection::open(&out).map_err(|e| err("open dst", e))?;
    dst.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1000000; PRAGMA temp_store=MEMORY;")
        .map_err(|e| err("dst pragma", e))?;
    let hm_cols: Vec<String> = (0..words).map(|i| format!("hm{i}")).collect();
    let hmdecl: String = hm_cols.iter().map(|c| format!(", {c} INTEGER")).collect();
    let ncols_common = format!(
        "name TEXT, x REAL, y REAL, r REAL, ang REAL, kind INTEGER, hb INTEGER, ref_contig_id INTEGER, ref_bp INTEGER, \
         ref_bp_end INTEGER, is_anchor INTEGER, ref_multi INTEGER, ref_strand INTEGER{hmdecl}");
    dst.execute_batch(&format!(
        "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE nodes_t(layer INTEGER, mkey INTEGER, id INTEGER, {ncols_common}, PRIMARY KEY(layer, mkey, id)) WITHOUT ROWID;
         CREATE TABLE nodes_big(layer INTEGER, id INTEGER, {ncols_common}, PRIMARY KEY(layer, id)) WITHOUT ROWID;
         CREATE TABLE edges_t(layer INTEGER, mkey INTEGER, eid INTEGER, side INTEGER,
           src_id INTEGER, tgt_id INTEGER, src_sign INTEGER, tgt_sign INTEGER,
           ex REAL, ey REAL, er REAL, source TEXT, target TEXT, hb INTEGER, rs INTEGER{hmdecl},
           PRIMARY KEY(layer, mkey, eid, side)) WITHOUT ROWID;"
    )).map_err(|e| err("schema", e))?;
    let jlist = |v: &[f64]| format!("[{}]", v.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(", "));
    let src_abs = std::fs::canonicalize(&db).map(|p| p.display().to_string()).unwrap_or(db.clone());
    let meta: Vec<(&str, String)> = vec![
        ("schema", "tiled-v4".into()),
        ("world", jlist(&[x0, x1, y0, y1])),
        ("g_L", format!("[{}]", g_l.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", "))),
        ("K_TILES", format!("{k_tiles}")),
        ("hm_cols", format!("[{}]", hm_cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "))),
        ("has_hb", if has_hb { "1" } else { "0" }.into()),
        ("has_ehb", if has_ehb { "1" } else { "0" }.into()),
        ("rs", rs_mode.into()),
        ("n_hap", n_hap.to_string()), ("words", words.to_string()), ("bits", (64 * words).to_string()),
        ("mode", mode.into()), ("n_contig", c2h.len().to_string()), ("hap_layout", "tiled".into()),
        ("source", src_abs), ("builder", "tiled_core (Rust)".into()),
    ];
    for (k, v) in &meta {
        dst.execute("INSERT INTO meta VALUES(?1, ?2)", params![k, v]).map_err(|e| err("meta", e))?;
    }
    let nv = 3 + 13 + words;
    let ins_t = format!("INSERT INTO nodes_t VALUES({})", vec!["?"; nv].join(","));
    let ins_b = format!("INSERT INTO nodes_big VALUES({})", vec!["?"; nv - 1].join(","));
    let ins_e = format!("INSERT INTO edges_t VALUES({})", vec!["?"; 15 + words].join(","));

    let mut tot_nodes = 0i64; let mut tot_big = 0i64; let mut tot_e = 0i64; let mut tot_erows = 0i64;
    let mut rid_lo = 1i64;
    // raw bind（Vec<Value> を組まない）。i64::MIN は NULL の印
    fn bind_opt(st: &mut Statement<'_>, i: usize, v: i64) -> rusqlite::Result<()> {
        if v == i64::MIN { st.raw_bind_parameter(i, Null) } else { st.raw_bind_parameter(i, v) }
    }

    for l in 0..=max_l {
        py.check_signals()?;
        let cnt = layer_nodes[l as usize];
        let rid_hi = rid_lo + cnt - 1;
        // ── nodes ──
        let g = g_l[l as usize];
        let tw = 1.0 / ((1i64 << g) as f64);
        let lim = (1i64 << g) - 1;
        let mut ln = LayerNodes {
            rowid: Vec::with_capacity(cnt as usize), x: Vec::with_capacity(cnt as usize), y: Vec::with_capacity(cnt as usize),
            r: Vec::with_capacity(cnt as usize), mkey: Vec::with_capacity(cnt as usize),
            names: NameIndex { buf: Vec::new(), off: vec![0], order: Vec::new() },
        };
        let mut ang: Vec<f64> = Vec::with_capacity(cnt as usize);
        let mut ints: Vec<[i64; 7]> = Vec::with_capacity(cnt as usize);
        let mut buf: Vec<u8> = Vec::with_capacity(cnt as usize * 12);
        let mut off: Vec<u64> = Vec::with_capacity(cnt as usize + 1); off.push(0);
        {
            let mut st = src.prepare(
                "SELECT rowid, layer_index, node_name, xCoord, yCoord, radius, angle, kind, ref_contig_id, ref_bp, \
                 ref_bp_end, is_anchor, ref_multi, ref_strand FROM nodes WHERE rowid BETWEEN ?1 AND ?2 ORDER BY rowid",
            ).map_err(|e| err("nodes", e))?;
            let mut rows = st.query(params![rid_lo, rid_hi]).map_err(|e| err("nodes", e))?;
            while let Some(r) = rows.next().map_err(|e| err("nodes", e))? {
                let li: i64 = r.get(1).map_err(|e| err("nodes li", e))?;
                if li != l {
                    return Err(PyRuntimeError::new_err(format!(
                        "nodes の rowid {} は layer_index={li} だが層 {l} の範囲にある（rowid が層順でない DB は Python 実装で）",
                        r.get::<_, i64>(0).unwrap_or(-1))));
                }
                ln.rowid.push(r.get(0).map_err(|e| err("nodes", e))?);
                let nm: String = r.get(2).map_err(|e| err("nodes name", e))?;
                buf.extend_from_slice(nm.as_bytes()); off.push(buf.len() as u64);
                let x: f64 = r.get(3).map_err(|e| err("x", e))?; let y: f64 = r.get(4).map_err(|e| err("y", e))?;
                let rr: f64 = r.get::<_, Option<f64>>(5).map_err(|e| err("r", e))?.unwrap_or(0.0);
                ln.x.push(x); ln.y.push(y); ln.r.push(rr);
                ang.push(r.get::<_, Option<f64>>(6).map_err(|e| err("ang", e))?.unwrap_or(0.0));
                let mut iv = [i64::MIN; 7];
                for (j, col) in (7..14).enumerate() {
                    iv[j] = r.get::<_, Option<i64>>(col).map_err(|e| err("ints", e))?.unwrap_or(i64::MIN);
                }
                ints.push(iv);
                ln.mkey.push(morton(tile_of(x, tw, lim), tile_of(y, tw, lim)));
            }
        }
        let n = ln.rowid.len();
        if n as i64 != cnt {
            return Err(PyRuntimeError::new_err(format!("層 {l}: 読めた行 {n} ≠ layer_nodes {cnt}")));
        }
        // 小ノードは mkey 順（同キーは rowid 順=読み順）、big は半径がタイル幅の半分を超えるもの
        let mut small: Vec<u32> = Vec::with_capacity(n); let mut bigs: Vec<u32> = Vec::new();
        for i in 0..n { if ln.r[i] > tw / 2.0 { bigs.push(i as u32) } else { small.push(i as u32) } }
        small.sort_by_key(|&i| ln.mkey[i as usize]);
        {
            let tx = dst.unchecked_transaction().map_err(|e| err("tx", e))?;
            let mut st_t = tx.prepare(&ins_t).map_err(|e| err("ins_t", e))?;
            let mut st_b = tx.prepare(&ins_b).map_err(|e| err("ins_b", e))?;
            // 共通列 (name, x, y, r, ang, kind, hb, ref×6, hm×W) を base 番目から bind
            let bind_common = |st: &mut Statement<'_>, base: usize, i: usize| -> rusqlite::Result<()> {
                let rid = ln.rowid[i] as usize;
                let nm = std::str::from_utf8(&buf[off[i] as usize..off[i + 1] as usize]).unwrap_or("");
                st.raw_bind_parameter(base, nm)?;
                st.raw_bind_parameter(base + 1, ln.x[i])?; st.raw_bind_parameter(base + 2, ln.y[i])?;
                st.raw_bind_parameter(base + 3, ln.r[i])?; st.raw_bind_parameter(base + 4, ang[i])?;
                bind_opt(st, base + 5, ints[i][0])?;
                bind_opt(st, base + 6, hb[rid])?;
                for j in 1..7 { bind_opt(st, base + 6 + j, ints[i][j])? }
                for w in 0..words { st.raw_bind_parameter(base + 13 + w, hm[rid * words + w] as i64)? }
                Ok(())
            };
            for &i in &small {
                let i = i as usize;
                st_t.raw_bind_parameter(1, l).map_err(|e| err("bind", e))?;
                st_t.raw_bind_parameter(2, ln.mkey[i]).map_err(|e| err("bind", e))?;
                st_t.raw_bind_parameter(3, ln.rowid[i]).map_err(|e| err("bind", e))?;
                bind_common(&mut st_t, 4, i).map_err(|e| err("bind", e))?;
                st_t.raw_execute().map_err(|e| err("nodes_t insert", e))?;
            }
            for &i in &bigs {
                let i = i as usize;
                st_b.raw_bind_parameter(1, l).map_err(|e| err("bind", e))?;
                st_b.raw_bind_parameter(2, ln.rowid[i]).map_err(|e| err("bind", e))?;
                bind_common(&mut st_b, 3, i).map_err(|e| err("bind", e))?;
                st_b.raw_execute().map_err(|e| err("nodes_big insert", e))?;
            }
            drop(st_t); drop(st_b);
            tx.commit().map_err(|e| err("commit", e))?;
        }
        let mut tiles = ln.mkey.clone(); tiles.sort_unstable(); tiles.dedup();
        tot_nodes += n as i64; tot_big += bigs.len() as i64;
        log(&t0, &format!("  nodes L{l:2} g={g:2} n={n:>11} big={:>6} tiles={:>9}", bigs.len(), tiles.len()));
        drop(ang); drop(ints);
        ln.names = NameIndex::build(buf, off);

        // ── edges of layer l ──
        let (elo, ehi): (Option<i64>, Option<i64>) = src.query_row(
            "SELECT MIN(rowid), MAX(rowid) FROM edges WHERE layer_index=?1", [l], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| err("edges range", e))?;
        if let (Some(elo), Some(ehi)) = (elo, ehi) {
            // 葉層のリード支持: (sid,tid) → support（重複は最大）
            let mut rs_map: Vec<(u64, i64)> = Vec::new();
            let leaf_rs = rs_mode == "sidecar" && l == max_l;
            if leaf_rs {
                let mut st = src.prepare("SELECT source, target, support FROM rd.edge_read_support").map_err(|e| err("ers", e))?;
                let mut rows = st.query([]).map_err(|e| err("ers", e))?;
                let mut nrs = 0u64;
                while let Some(r) = rows.next().map_err(|e| err("ers", e))? {
                    let s: String = r.get(0).map_err(|e| err("ers", e))?; let t: String = r.get(1).map_err(|e| err("ers", e))?;
                    let v: i64 = r.get::<_, Option<i64>>(2).map_err(|e| err("ers", e))?.unwrap_or(0);
                    nrs += 1;
                    if let (Some(a), Some(b)) = (ln.names.find(s.as_bytes()), ln.names.find(t.as_bytes())) {
                        let key = (ln.rowid[a as usize] as u64) * (n_ids as u64 + 1) + ln.rowid[b as usize] as u64;
                        rs_map.push((key, v));
                    }
                }
                rs_map.sort_unstable();
                // 同じ鍵は最大値を残す
                let mut w = 0usize;
                for i in 0..rs_map.len() {
                    if w > 0 && rs_map[w - 1].0 == rs_map[i].0 { if rs_map[i].1 > rs_map[w - 1].1 { rs_map[w - 1].1 = rs_map[i].1 } }
                    else { rs_map[w] = rs_map[i]; w += 1 }
                }
                rs_map.truncate(w);
                log(&t0, &format!("  read_support {nrs} 行を読み、葉名で解けた鍵 {}", rs_map.len()));
            }
            let sql = format!(
                "SELECT rowid, layer_index, source, target, src_sign, tgt_sign, {} FROM edges WHERE rowid BETWEEN ?1 AND ?2 ORDER BY rowid",
                if rs_mode == "column" { "read_support" } else { "NULL" });
            let mut st = src.prepare(&sql).map_err(|e| err("edges", e))?;
            let mut rows = st.query(params![elo, ehi]).map_err(|e| err("edges", e))?;
            struct E { eid: i64, ps: u32, pt: u32, ss: i64, ts: i64, rs: i64 }
            let mut es: Vec<E> = Vec::new();
            let mut miss = 0u64; let mut other = 0u64; let mut rs_hit = 0u64;
            while let Some(r) = rows.next().map_err(|e| err("edges", e))? {
                let li: i64 = r.get(1).map_err(|e| err("edges li", e))?;
                if li != l { other += 1; continue }
                let s: String = r.get(2).map_err(|e| err("edges s", e))?; let t: String = r.get(3).map_err(|e| err("edges t", e))?;
                let (ps, pt) = match (ln.names.find(s.as_bytes()), ln.names.find(t.as_bytes())) {
                    (Some(a), Some(b)) => (a, b),
                    _ => { miss += 1; continue }
                };
                let mut rsv: i64 = if rs_mode == "column" {
                    r.get::<_, Option<i64>>(6).map_err(|e| err("edges rs", e))?.unwrap_or(i64::MIN)
                } else { i64::MIN };
                if leaf_rs {
                    let key = (ln.rowid[ps as usize] as u64) * (n_ids as u64 + 1) + ln.rowid[pt as usize] as u64;
                    if let Ok(p) = rs_map.binary_search_by_key(&key, |e| e.0) { rsv = rs_map[p].1; rs_hit += 1 }
                }
                es.push(E {
                    eid: r.get(0).map_err(|e| err("edges", e))?, ps, pt,
                    ss: r.get::<_, Option<i64>>(4).map_err(|e| err("ss", e))?.unwrap_or(i64::MIN),
                    ts: r.get::<_, Option<i64>>(5).map_err(|e| err("ts", e))?.unwrap_or(i64::MIN),
                    rs: rsv,
                });
            }
            if other > 0 {
                return Err(PyRuntimeError::new_err(format!(
                    "edges の rowid 範囲 [{elo},{ehi}] に層 {l} 以外の行が {other} 件（層順でない DB は Python 実装で）")));
            }
            drop(rs_map);
            if leaf_rs { log(&t0, &format!("  read_support → 葉辺 {rs_hit}/{} に付与", es.len())) }
            // 端点ごとに 1 行（side 0=source, 1=target）。(mkey, eid, side) 順に書く
            let mut order: Vec<(i64, u32, u8)> = Vec::with_capacity(es.len() * 2);
            for (i, e) in es.iter().enumerate() {
                order.push((ln.mkey[e.ps as usize], i as u32, 0));
                order.push((ln.mkey[e.pt as usize], i as u32, 1));
            }
            order.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(es[a.1 as usize].eid.cmp(&es[b.1 as usize].eid)).then(a.2.cmp(&b.2)));
            {
                let tx = dst.unchecked_transaction().map_err(|e| err("tx", e))?;
                let mut st_e = tx.prepare(&ins_e).map_err(|e| err("ins_e", e))?;
                for &(key, i, side) in &order {
                    let e = &es[i as usize];
                    let p = if side == 0 { e.ps } else { e.pt } as usize;
                    let eu = e.eid as usize;
                    let b = |st: &mut Statement<'_>| -> rusqlite::Result<()> {
                        st.raw_bind_parameter(1, l)?; st.raw_bind_parameter(2, key)?; st.raw_bind_parameter(3, e.eid)?;
                        st.raw_bind_parameter(4, side as i64)?;
                        st.raw_bind_parameter(5, ln.rowid[e.ps as usize])?; st.raw_bind_parameter(6, ln.rowid[e.pt as usize])?;
                        bind_opt(st, 7, e.ss)?; bind_opt(st, 8, e.ts)?;
                        st.raw_bind_parameter(9, ln.x[p])?; st.raw_bind_parameter(10, ln.y[p])?; st.raw_bind_parameter(11, ln.r[p])?;
                        st.raw_bind_parameter(12, std::str::from_utf8(ln.names.name(e.ps)).unwrap_or(""))?;
                        st.raw_bind_parameter(13, std::str::from_utf8(ln.names.name(e.pt)).unwrap_or(""))?;
                        bind_opt(st, 14, if eu < ne { ehb[eu] } else { i64::MIN })?;
                        bind_opt(st, 15, e.rs)?;
                        for w in 0..words { st.raw_bind_parameter(16 + w, if eu < ne { ehm[eu * words + w] as i64 } else { 0 })? }
                        st.raw_execute()?;
                        Ok(())
                    };
                    b(&mut st_e).map_err(|e| err("edges_t insert", e))?;
                }
                drop(st_e);
                tx.commit().map_err(|e| err("commit", e))?;
            }
            tot_e += es.len() as i64; tot_erows += order.len() as i64;
            log(&t0, &format!("  edges L{l:2} e={:>11} rows={:>11} 未解決={miss}", es.len(), order.len()));
        }
        rid_lo = rid_hi + 1;
    }
    log(&t0, &format!("nodes 完了 {tot_nodes}（big {tot_big}）/ edges {tot_e}"));
    for (k, v) in [("node_rows", tot_nodes), ("edge_rows", tot_erows), ("edges", tot_e)] {
        dst.execute("INSERT INTO meta VALUES(?1, ?2)", params![k, v.to_string()]).map_err(|e| err("meta", e))?;
    }
    dst.execute("INSERT INTO meta VALUES('built_at', datetime('now'))", []).map_err(|e| err("meta", e))?;
    drop(dst);
    let d = PyDict::new_bound(py);
    d.set_item("node_rows", tot_nodes)?; d.set_item("edge_rows", tot_erows)?; d.set_item("edges", tot_e)?;
    d.set_item("words", words)?; d.set_item("n_hap", n_hap)?; d.set_item("rs", rs_mode)?;
    d.set_item("g_L", g_l)?; d.set_item("world", vec![x0, x1, y0, y1])?;
    Ok(d.into())
}

#[pymodule]
fn tiled_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(build, m)?)?;
    Ok(())
}
