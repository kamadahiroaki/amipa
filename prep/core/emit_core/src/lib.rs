//! emit_core — ④ emitter hot path の Rust core。
//!
//! infra(sum_i64/probe_sqlite): PyO3 + numpy zero-copy + rusqlite(rtree) の疎通確認済。
//!
//! increment 1: emit_edges — §8 エッジ発行(PGGB の base-edge L7 OOM 点)を所有。
//!   Python は okE フィルタ済 en_i/en_j/su/sv と n サイズの幾何/名前入力を渡すだけ。
//!   Rust が層ごとに rep_at climb → dedup(np.unique 複製) → ロッド端の符号(side)を edges へ
//!   streaming 書込(座標非保存・edges_rtree 廃止)。常駐は O(生存エッジ)=約24B×E(層で再利用)に
//!   有界化(numpy の 4×E常駐PIx..PJy と np.unique の3-4×Eソート作業を消す)。cos/sin は Python
//!   precompute を受け取り射影の符号判定に用いるのみ(端点座標は viewer が nodes+符号から復元)。

use numpy::PyReadonlyArray1;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use rusqlite::params;
use std::time::{Duration, Instant};

// 速度プロファイル用: 環境変数 EMIT_CORE_PROFILE=1 のときだけ phase 別内訳を stderr へ出す。
// 出力(DB)は一切変えない(stderr のみ) → chr22 は byte 一致のまま。rep_at(fp climb)/sort/SQLite write の
// 実時間割合を測り、rayon 並列(rep_at)と複数行 INSERT バッチ化(write)のどちらが効くかを決める材料にする。
fn profile_on() -> bool {
    std::env::var("EMIT_CORE_PROFILE").map(|v| v == "1").unwrap_or(false)
}
fn secs(d: Duration) -> f64 {
    d.as_secs_f64()
}

fn sqlite_err<E: std::fmt::Display>(ctx: &str, e: E) -> PyErr {
    PyRuntimeError::new_err(format!("{ctx}: {e}"))
}

// SQLite 書込チューニング。cache_size を増やすと R-tree(shadow B-tree)の random-access working set が
// ページキャッシュに載り、既定 2MB での spill→re-read の thrash が消える。出力(DB 中身)は完全不変=
// 純粋に内部キャッシュのサイズだけ。既定 512MB、環境変数 EMIT_CORE_CACHE_MB で調整可(WG のメモリ制約に応じ)。
// cache_size 負値=KB 絶対指定。この分だけ RSS が増える(512MB は chr22 14GB ピークの ~3.5%)。
fn cache_mb() -> i64 {
    std::env::var("EMIT_CORE_CACHE_MB")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|&m| m >= 0)
        .unwrap_or(512)
}
// mmap_size(MB)。既定 0=off(SQLite 既定, read/write は syscall)。DB をノードローカルで焼く時(--build-tmp)、
// 大きな mmap 窓は nodes_rtree のランダムなページ read/write を syscall なしにし高速化する。共有FS 上では
// mmap は不安定なので使わない(その場合は 0 のまま)。EMIT_CORE_MMAP_MB で調整。内容(DB バイト)は不変。
fn mmap_mb() -> i64 {
    std::env::var("EMIT_CORE_MMAP_MB")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|&m| m >= 0)
        .unwrap_or(0)
}
fn apply_write_pragmas(conn: &rusqlite::Connection) -> PyResult<()> {
    let kb = cache_mb() * 1024;
    let mmap_bytes = mmap_mb() * 1024 * 1024;
    conn.execute_batch(&format!(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; \
         PRAGMA cache_size=-{kb}; PRAGMA mmap_size={mmap_bytes};"
    ))
    .map_err(|e| sqlite_err("pragma", e))
}

/// numpy int64 配列を zero-copy で受け取り総和を返す(interop 実証)。
#[pyfunction]
fn sum_i64(arr: PyReadonlyArray1<'_, i64>) -> PyResult<i64> {
    let s = arr.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    // wrapping_add で overflow パニックを避ける(検証用の単純総和)。
    Ok(s.iter().copied().fold(0i64, i64::wrapping_add))
}

/// rusqlite が rtree を含むこと & トランザクション書込ができることを実証。
/// 通常表と rtree 仮想表へ数行書き、rtree 行数を返す。
#[pyfunction]
fn probe_sqlite(db_path: String) -> PyResult<i64> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS _probe_t;
         CREATE TABLE _probe_t(id INTEGER PRIMARY KEY, x REAL, name TEXT);
         DROP TABLE IF EXISTS _probe_rt;
         CREATE VIRTUAL TABLE _probe_rt USING rtree(id, minx, maxx, miny, maxy);",
    )
    .map_err(|e| sqlite_err("create(rtree?)", e))?;

    let tx = conn.unchecked_transaction().map_err(|e| sqlite_err("begin", e))?;
    {
        let mut ins_t = tx
            .prepare("INSERT INTO _probe_t(id,x,name) VALUES(?1,?2,?3)")
            .map_err(|e| sqlite_err("prep t", e))?;
        let mut ins_rt = tx
            .prepare("INSERT INTO _probe_rt(id,minx,maxx,miny,maxy) VALUES(?1,?2,?3,?4,?5)")
            .map_err(|e| sqlite_err("prep rt", e))?;
        for i in 1..=5i64 {
            let x = i as f64 * 0.5;
            ins_t
                .execute(rusqlite::params![i, x, format!("n{i}")])
                .map_err(|e| sqlite_err("ins t", e))?;
            ins_rt
                .execute(rusqlite::params![i, x - 1.0, x + 1.0, x - 1.0, x + 1.0])
                .map_err(|e| sqlite_err("ins rt", e))?;
        }
    }
    tx.commit().map_err(|e| sqlite_err("commit", e))?;

    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM _probe_rt", [], |r| r.get(0))
        .map_err(|e| sqlite_err("count", e))?;
    conn.execute_batch("DROP TABLE _probe_t; DROP TABLE _probe_rt;")
        .map_err(|e| sqlite_err("cleanup", e))?;
    Ok(n)
}

/// 葉/内部ノードの表示名(name_all と厳密同値)。
///   v==0 -> "root"; atom>=0 -> "n{id_map? id_map[atom-1] : atom}"; else "{G|S|X}{v}"。
#[inline]
fn node_name(v: usize, atom: &[i64], kind: &[u8], id_map: Option<&[i64]>) -> String {
    if v == 0 {
        return "root".to_string();
    }
    let a = atom[v];
    if a >= 0 {
        let disp = match id_map {
            Some(m) => m[(a - 1) as usize],
            None => a,
        };
        format!("n{disp}")
    } else {
        let c = match kind[v] {
            1 => 'G',
            2 => 'S',
            _ => 'X',
        };
        format!("{c}{v}")
    }
}

/// 葉 v から fp を上り、層 L で在圏する代表(birth<=L の最深の出現ノード)へ。
/// Python rep_at のスカラ版(birth[r]>L または birth[r]<0 の間 climb)。
#[inline]
fn rep_at(v: i64, l: i64, birth: &[i64], fp: &[i64]) -> i64 {
    let mut r = v as usize;
    while birth[r] > l || birth[r] < 0 {
        r = fp[r] as usize;
    }
    r as i64
}

/// 層 l の在圏ノードを列挙して `posmap[v]=局所index` を埋め、`p_list` に積む。件数を返す。
///
/// **rowid 規約の唯一の実装点**（node_rowid = rid_base + 1 + posmap[v]）。
/// 以前は 6 か所に同じループが複製されていて、順序を変えるとどれか 1 つ直し忘れる形だった。
///
/// `order` = ノードを**空間順(Hilbert)に並べた大域インデックス列**。渡すと層内の採番が
/// 空間順になり、ビューポート内の rowid が連続になる（cold のシーク数がそのまま減る）。
/// 実測(2026-08-09): ビューポート内 rowid の density は node 側 PGGB 0.99 / MC 二峰性(0.006〜1.0)、
/// **edge 側は両グラフとも 0.0000**（node dens=1.0 の vp ですら）。rowid は
/// nodes / node_contig_cov / node_hap_mult / node_contig_inv / node_annot / read_cov /
/// nodes_rtree_rowid の共通キーなので、ここを直すと全部に効く。
///
/// `None` なら従来どおり木のインデックス順（後方互換）。
/// ★木のインデックス自体は並べ替えられない: climb が `rep_arr[v]=rep_arr[fp[v]]` を
///   `for v in 0..nn` で解いており **親 < 子 のトポロジカル順**を前提にしている。
///   だから「木の index は据え置き、層内の採番順だけ空間順」にする。
#[inline]
fn build_layer_set(
    l: i64, nn: usize, birth: &[i64], death: &[i64], order: Option<&[i64]>,
    posmap: &mut [i64], p_list: &mut Vec<usize>,
) -> i64 {
    p_list.clear();
    let mut k: i64 = 0;
    match order {
        Some(ord) => {
            for &vv in ord.iter() {
                let v = vv as usize;
                let b = birth[v];
                if b >= 0 && b <= l && l < death[v] {
                    posmap[v] = k;
                    p_list.push(v);
                    k += 1;
                }
            }
        }
        None => {
            for v in 0..nn {
                let b = birth[v];
                if b >= 0 && b <= l && l < death[v] {
                    posmap[v] = k;
                    p_list.push(v);
                    k += 1;
                }
            }
        }
    }
    k
}

/// `spatial_order`(ノードの空間順の並び) から `srank[v] = v の空間順位` を作る。
#[inline]
fn srank_of(order: Option<&[i64]>, nn: usize) -> Option<Vec<i64>> {
    let ord = order?;
    let mut sr = vec![0i64; nn];
    for (r, &v) in ord.iter().enumerate() {
        sr[v as usize] = r as i64;
    }
    Some(sr)
}

/// 層内の超辺 `uk`(生キー lo*n+hi の昇順ユニーク) に **空間順の rowid オフセット**を割り当てる。
/// 返り値 `erank[g]` = `uk[g]` のその層内 rowid-1（edge_rowid = e_rid + 1 + erank[g]）。
///
/// ★`uk` 自体は**生キー昇順のまま**にする。5 か所が `uk.binary_search` で超辺を引いており、
///   並びを変えるとその全部を別の索引方式に変えることになる。rowid だけ写せば済む。
/// ★エッジの並びが効く理由: `/ribbon`・エッジ太さ・hap 絞り込みは `edge_contig_cov` /
///   `edge_hm` / `edge_hap_mult` を **edge_rowid で点引き**する。実測(2026-08-09)では
///   ビューポート内の edge rowid density が **両グラフとも 0.0000**（node dens=1.0 の vp ですら）で、
///   1 vp あたり 2,100〜2,800 本がほぼ全部別ページだった＝ここが最大の伸びしろ。
/// キーは (端点の空間順位) の小さい方→大きい方。レイアウト後は端点同士が空間的に近いので、
/// これでビューポート内のエッジが rowid 上でまとまる。
fn edge_spatial_rank(uk: &[i64], n: i64, srank: Option<&[i64]>) -> Vec<i64> {
    let m = uk.len();
    let mut erank = vec![0i64; m];
    match srank {
        None => {
            for g in 0..m {
                erank[g] = g as i64;
            }
        }
        Some(sr) => {
            let mut idx: Vec<u32> = (0..m as u32).collect();
            idx.sort_unstable_by_key(|&g| {
                let k = uk[g as usize];
                let a = sr[(k / n) as usize];
                let b = sr[(k % n) as usize];
                if a <= b { (a, b) } else { (b, a) }
            });
            for (r, &g) in idx.iter().enumerate() {
                erank[g as usize] = r as i64;
            }
        }
    }
    erank
}

/// §8 エッジ発行。edges(層/source/target/src_sign/tgt_sign)を全層 streaming 書込し
/// (e_total, per_layer_counts) を返す。座標は非保存・edges_rtree は作らない(viewer が nodes と
/// 符号から端点を復元)。db は Python が新スキーマで用意し nodes を書き終え close 済(単一writer)。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, en_i, en_j, su, sv, birth, fp, cx, cy, rad, cosang, sinang,
                    atom, kind, id_map, start, maxlayer, n, spatial_order=None))]
fn emit_edges<'py>(
    _py: Python<'py>,
    db_path: String,
    en_i: PyReadonlyArray1<'py, i64>,
    en_j: PyReadonlyArray1<'py, i64>,
    su: Option<PyReadonlyArray1<'py, i64>>,
    sv: Option<PyReadonlyArray1<'py, i64>>,
    birth: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    cx: PyReadonlyArray1<'py, f64>,
    cy: PyReadonlyArray1<'py, f64>,
    rad: PyReadonlyArray1<'py, f64>,
    cosang: PyReadonlyArray1<'py, f64>,
    sinang: PyReadonlyArray1<'py, f64>,
    atom: PyReadonlyArray1<'py, i64>,
    kind: PyReadonlyArray1<'py, u8>,
    id_map: Option<PyReadonlyArray1<'py, i64>>,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードの空間順(Hilbert)。エッジ rowid を端点の空間順位で採番するのに使う。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let as_i64 = |a: &PyReadonlyArray1<'py, i64>| -> PyResult<Vec<i64>> {
        Ok(a.as_slice()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?
            .to_vec())
    };
    // 幾何/木の n サイズ配列は借用スライスのまま使う(コピー不要)。
    let en_i = en_i.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let en_j = en_j.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let birth = birth.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let fp = fp.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let cx = cx.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let cy = cy.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let rad = rad.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let cosang = cosang.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let sinang = sinang.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let atom = atom.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let kind = kind.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let idm_vec = match &id_map {
        Some(a) => Some(as_i64(a)?),
        None => None,
    };
    let idm = idm_vec.as_deref();

    let have_or = su.is_some() && sv.is_some();
    let su_v = if have_or { Some(as_i64(su.as_ref().unwrap())?) } else { None };
    let sv_v = if have_or { Some(as_i64(sv.as_ref().unwrap())?) } else { None };
    let su_s = su_v.as_deref().unwrap_or(&[]);
    let sv_s = sv_v.as_deref().unwrap_or(&[]);

    let ne = en_i.len();

    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let mut e_total: i64 = 0;

    // 層で再利用する生存エッジ・バッファ(常駐を O(生存エッジ) に有界化)。
    let mut keys: Vec<i64> = Vec::new();
    let mut plos: Vec<f64> = Vec::new();
    let mut phis: Vec<f64> = Vec::new();
    let prof = profile_on();
    let (mut t_repat, mut t_sort, mut t_write) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    // 空間順位（None なら従来どおり uk の生キー順＝木インデックス順）
    let _srank = srank_of(
        match &spatial_order {
            Some(a) => Some(a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?),
            None => None,
        },
        n as usize,
    );
    for l in start..=maxlayer {
        let lw = l - start;
        keys.clear();
        plos.clear();
        phis.clear();
        let tr = Instant::now();
        for e in 0..ne {
            let ga = rep_at(en_i[e], l, birth, fp);
            let gb = rep_at(en_j[e], l, birth, fp);
            if ga == gb {
                continue;
            }
            let (lo, hi) = if ga < gb { (ga, gb) } else { (gb, ga) };
            keys.push(lo * n + hi);
            if have_or {
                let eni = en_i[e] as usize;
                let enj = en_j[e] as usize;
                let sgi = if su_s[e] == 1 { 1.0 } else { -1.0 };
                let sgj = if sv_s[e] == 1 { 1.0 } else { -1.0 };
                let pix = cx[eni] + sgi * rad[eni] * cosang[eni];
                let piy = cy[eni] + sgi * rad[eni] * sinang[eni];
                let pjx = cx[enj] + sgj * rad[enj] * cosang[enj];
                let pjy = cy[enj] + sgj * rad[enj] * sinang[enj];
                let a = ga as usize;
                let b = gb as usize;
                let pa = (pix - cx[a]) * cosang[a] + (piy - cy[a]) * sinang[a];
                let pb = (pjx - cx[b]) * cosang[b] + (pjy - cy[b]) * sinang[b];
                // a(=ga=端点iの代表) が lo 側か。projLo=lo側グリフに寄与する射影。
                if ga < gb {
                    plos.push(pa);
                    phis.push(pb);
                } else {
                    plos.push(pb);
                    phis.push(pa);
                }
            }
        }
        if prof { t_repat += tr.elapsed(); }
        if keys.is_empty() {
            continue;
        }
        let ts = Instant::now();
        // np.unique(key): 昇順ユニーク。
        let mut uk = keys.clone();
        uk.sort_unstable();
        uk.dedup();
        // エッジ rowid を **端点の空間順**に写す（uk 自体は binary_search のため生キー昇順のまま）
        let erank = edge_spatial_rank(&uk, n, _srank.as_deref());
        let ke = uk.len();

        // np.add.at(sum, inv, proj): 元順序で群へ加算(丸め順を numpy と一致させる)。
        let mut suml = vec![0.0f64; ke];
        let mut sumh = vec![0.0f64; ke];
        if have_or {
            for idx in 0..keys.len() {
                let g = uk.binary_search(&keys[idx]).unwrap();
                suml[g] += plos[idx];
                sumh[g] += phis[idx];
            }
        }
        if prof { t_sort += ts.elapsed(); }

        let tw = Instant::now();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        {
            // 座標は保存しない。端点はノードのロッド端で、どちらの端か(side)の符号だけ持つ:
            //   src_sign/tgt_sign = +1(center+RAD·dir) / -1(center-RAD·dir)。向き情報なしは 0
            //   (viewer が相手中心方向で幾何復元)。viewer が nodes+符号から start/end を厳密復元。
            let mut ins_e = tx
                .prepare(
                    // ★`haplotypes` 列も書かない(2026-08-16 廃止)。常に空文字を入れていただけ。
                    "INSERT INTO edges(layer_index,source,target,src_sign,tgt_sign) \
                     VALUES(?1,?2,?3,?4,?5)",
                )
                .map_err(|e| sqlite_err("prep edges", e))?;
            // ★挿入順 = 暗黙 rowid。erank の順（空間順）に並べ替えて入れる。
            //   他の 4 経路は edge_rowid を明示するので erank[] を引くだけでよいが、
            //   ここだけは順序そのものを合わせないと rowid がずれる。
            let mut eord: Vec<u32> = (0..ke as u32).collect();
            eord.sort_unstable_by_key(|&g| erank[g as usize]);
            for &g32 in eord.iter() {
                let g = g32 as usize;
                let ua = (uk[g] / n) as usize;
                let ub = (uk[g] % n) as usize;
                let (src_sign, tgt_sign): (i64, i64) = if have_or {
                    (
                        if suml[g] >= 0.0 { 1 } else { -1 },
                        if sumh[g] >= 0.0 { 1 } else { -1 },
                    )
                } else {
                    (0, 0)
                };
                let na = node_name(ua, atom, kind, idm);
                let nb = node_name(ub, atom, kind, idm);
                ins_e
                    .execute(params![lw, na, nb, src_sign, tgt_sign])
                    .map_err(|e| sqlite_err("ins edges", e))?;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        if prof { t_write += tw.elapsed(); }

        e_total += ke as i64;
        per_layer[lw as usize] = ke as i64;
    }
    if prof {
        eprintln!(
            "[emit_core] emit_edges: repat+proj={:.1}s sort+addat={:.1}s write(sqlite)={:.1}s rows={}",
            secs(t_repat), secs(t_sort), secs(t_write), e_total
        );
    }
    Ok((e_total, per_layer))
}

/// §4 幾何: 葉座標を全ノードへボトムアップ集約(depth 準 level scatter)。
/// Python §4d(argsort(depth,stable)+per-level np.bincount/np.minimum.at)を厳密複製し、
/// CX,CY,RAD,vxx,vyy,vxy,cnt(coverage),sbp,raw_span を返す。ANG は Python 側で arctan2(超越)。
///
/// bit一致: 加算は基本演算のみ。np.bincount は各親につき「0 から子を昇順 index で加算」→ Python は
/// `acc += bincount(...)` だが内部親(非葉=非seed)の acc 初期値は 0 なので結合律も一致。min/max は順序不問。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (parent, sn, lx, ly, sbp_seed, base_r, n))]
fn emit_geometry<'py>(
    py: Python<'py>,
    parent: PyReadonlyArray1<'py, i32>,
    sn: PyReadonlyArray1<'py, i64>,
    lx: PyReadonlyArray1<'py, f64>,
    ly: PyReadonlyArray1<'py, f64>,
    sbp_seed: PyReadonlyArray1<'py, f64>,
    base_r: f64,
    n: usize,
) -> PyResult<(
    Bound<'py, numpy::PyArray1<f64>>,  // CX
    Bound<'py, numpy::PyArray1<f64>>,  // CY
    Bound<'py, numpy::PyArray1<f64>>,  // RAD
    Bound<'py, numpy::PyArray1<f64>>,  // vxx
    Bound<'py, numpy::PyArray1<f64>>,  // vyy
    Bound<'py, numpy::PyArray1<f64>>,  // vxy
    Bound<'py, numpy::PyArray1<f64>>,  // cnt (coverage)
    Bound<'py, numpy::PyArray1<f64>>,  // sbp
    Bound<'py, numpy::PyArray1<f64>>,  // raw_span
)> {
    use numpy::IntoPyArray;
    let map = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let parent = parent.as_slice().map_err(map)?;
    let sn = sn.as_slice().map_err(map)?;
    let lx = lx.as_slice().map_err(map)?;
    let ly = ly.as_slice().map_err(map)?;
    let sbp_seed = sbp_seed.as_slice().map_err(map)?;
    let prof = profile_on();
    let t0 = Instant::now();

    // 集計器(f64 n)。内部=0, min/max=±inf で初期化。
    let mut cnt = vec![0.0f64; n];
    let mut sx = vec![0.0f64; n];
    let mut sy = vec![0.0f64; n];
    let mut sxx = vec![0.0f64; n];
    let mut syy = vec![0.0f64; n];
    let mut sxy = vec![0.0f64; n];
    let mut sbp = vec![0.0f64; n];
    let mut minx = vec![f64::INFINITY; n];
    let mut maxx = vec![f64::NEG_INFINITY; n];
    let mut miny = vec![f64::INFINITY; n];
    let mut maxy = vec![f64::NEG_INFINITY; n];

    // 4b. depth(root=0)。parent[v] < v(build_typed の topo 順)を前提に前進計算。
    let mut depth = vec![0i32; n];
    let mut maxdepth = 0i32;
    for v in 1..n {
        let d = depth[parent[v] as usize] + 1;
        depth[v] = d;
        if d > maxdepth {
            maxdepth = d;
        }
    }

    // 4c. 葉シード
    for k in 0..sn.len() {
        let v = sn[k] as usize;
        let x = lx[k];
        let y = ly[k];
        cnt[v] = 1.0;
        sx[v] = x;
        sy[v] = y;
        sxx[v] = x * x;
        syy[v] = y * y;
        sxy[v] = x * y;
        sbp[v] = sbp_seed[k];
        minx[v] = x;
        maxx[v] = x;
        miny[v] = y;
        maxy[v] = y;
    }

    // depth で counting sort(stable = v 昇順)→ 各 depth 区間の境界を得る。np.argsort(depth,stable) と同値。
    let md = maxdepth as usize;
    let mut cnt_d = vec![0usize; md + 2];
    for v in 0..n {
        cnt_d[depth[v] as usize + 1] += 1;
    }
    for d in 1..md + 2 {
        cnt_d[d] += cnt_d[d - 1];
    }
    let start_d = cnt_d.clone(); // start_d[d] = order 内で depth==d が始まる位置
    let mut order = vec![0u32; n];
    let mut cursor = cnt_d; // 破壊的に使う
    for v in 0..n {
        let d = depth[v] as usize;
        order[cursor[d]] = v as u32;
        cursor[d] += 1;
    }

    // 4d. depth 深い順に親へ畳み込み(子は昇順 index=np.bincount の加算順)。
    for d in (1..=md).rev() {
        let lo = start_d[d];
        let hi = start_d[d + 1];
        for &vu in &order[lo..hi] {
            let v = vu as usize;
            let p = parent[v] as usize;
            cnt[p] += cnt[v];
            sx[p] += sx[v];
            sy[p] += sy[v];
            sxx[p] += sxx[v];
            syy[p] += syy[v];
            sxy[p] += sxy[v];
            sbp[p] += sbp[v];
            if minx[v] < minx[p] {
                minx[p] = minx[v];
            }
            if maxx[v] > maxx[p] {
                maxx[p] = maxx[v];
            }
            if miny[v] < miny[p] {
                miny[p] = miny[v];
            }
            if maxy[v] > maxy[p] {
                maxy[p] = maxy[v];
            }
        }
    }

    // 後処理(基本演算のみ)。バッファ再利用で追加確保しない。
    //   sx->CX, sy->CY, sxx->vxx, syy->vyy, sxy->vxy, minx->raw_span, miny->RAD。maxx/maxy は w/h scratch。
    for v in 0..n {
        let nn = if cnt[v] > 1.0 { cnt[v] } else { 1.0 };
        let cx = sx[v] / nn;
        let cy = sy[v] / nn;
        sxx[v] = sxx[v] / nn - cx * cx;
        syy[v] = syy[v] / nn - cy * cy;
        sxy[v] = sxy[v] / nn - cx * cy;
        sx[v] = cx;
        sy[v] = cy;
        let wv = if maxx[v].is_finite() { maxx[v] - minx[v] } else { 0.0 };
        let hv = if maxy[v].is_finite() { maxy[v] - miny[v] } else { 0.0 };
        let span = if wv > hv { wv } else { hv };
        minx[v] = span; // raw_span
        let rad = 0.5 * span;
        miny[v] = if rad > base_r { rad } else { base_r }; // RAD
    }
    // 真の葉は素座標・既定半径に上書き(ANG は Python 側で lang に上書き)。
    for k in 0..sn.len() {
        let v = sn[k] as usize;
        sx[v] = lx[k];
        sy[v] = ly[k];
        miny[v] = base_r;
    }
    drop(maxx);
    drop(maxy);
    drop(depth);
    drop(order);
    drop(start_d);

    if prof {
        eprintln!("[emit_core] emit_geometry: total(compute)={:.1}s n={}", secs(t0.elapsed()), n);
    }
    Ok((
        sx.into_pyarray_bound(py),
        sy.into_pyarray_bound(py),
        miny.into_pyarray_bound(py),
        sxx.into_pyarray_bound(py),
        syy.into_pyarray_bound(py),
        sxy.into_pyarray_bound(py),
        cnt.into_pyarray_bound(py),
        sbp.into_pyarray_bound(py),
        minx.into_pyarray_bound(py),
    ))
}

/// §7 ノード行発行。nodes / nodes_rtree を全層 streaming 書込し per_layer_counts を返す。
/// name_all(object 配列 ~8GB)を Python に持たせず Rust が名前を都度生成。ref 列は INSERT に畳む
/// (Python の別 UPDATE と同値・高速)。db は Python が nodes 空で用意し close 済であること。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, birth, death, fp, cx, cy, rad, ang, cnt, sbp, size,
                    atom, kind, id_map, ref_cid, ref_bp, ref_bpe, ref_anc, ref_multi,
                    start, maxlayer, n, skip_rtree=false, spatial_order=None))]
fn emit_nodes<'py>(
    _py: Python<'py>,
    db_path: String,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    cx: PyReadonlyArray1<'py, f64>,
    cy: PyReadonlyArray1<'py, f64>,
    rad: PyReadonlyArray1<'py, f64>,
    ang: PyReadonlyArray1<'py, f64>,
    cnt: PyReadonlyArray1<'py, f64>,
    sbp: PyReadonlyArray1<'py, f64>,
    size: PyReadonlyArray1<'py, i64>,
    atom: PyReadonlyArray1<'py, i64>,
    kind: PyReadonlyArray1<'py, u8>,
    id_map: Option<PyReadonlyArray1<'py, i64>>,
    ref_cid: Option<PyReadonlyArray1<'py, i64>>,
    ref_bp: Option<PyReadonlyArray1<'py, i64>>,
    ref_bpe: Option<PyReadonlyArray1<'py, i64>>,
    ref_anc: Option<PyReadonlyArray1<'py, i64>>,
    ref_multi: Option<PyReadonlyArray1<'py, i64>>,
    start: i64,
    maxlayer: i64,
    n: i64,
    // true なら nodes_rtree への INSERT を **しない**。後段の hapidx 段(scripts/ggb_hapidx.py --into-db)
    // が hap マスク補助列つきで nodes_rtree を作るので、ここで入れると二重構築になる
    // (chrY 実測 9s→19.1s、WG 外挿 +約1.8h)。rtree の aux を後から UPDATE で埋める案は
    // 実測で 73k 行/s < aux 込み INSERT 146k 行/s と逆に遅かったので、挿入自体を飛ばす形にした。
    skip_rtree: bool,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let s = |a: &PyReadonlyArray1<'py, i64>| a.as_slice().map(|x| x.to_vec());
    let birth = birth.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let death = death.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let fp = fp.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let cx = cx.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let cy = cy.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let rad = rad.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let ang = ang.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let cnt = cnt.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let sbp = sbp.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let size = size.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let atom = atom.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let kind = kind.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    let idm_vec = match &id_map {
        Some(a) => Some(s(a).map_err(|e| PyRuntimeError::new_err(e.to_string()))?),
        None => None,
    };
    let idm = idm_vec.as_deref();

    let have_ref = ref_cid.is_some();
    let grab = |o: &Option<PyReadonlyArray1<'py, i64>>| -> PyResult<Vec<i64>> {
        match o {
            Some(a) => s(a).map_err(|e| PyRuntimeError::new_err(e.to_string())),
            None => Ok(Vec::new()),
        }
    };
    let rcid = grab(&ref_cid)?;
    let rbp = grab(&ref_bp)?;
    let rbpe = grab(&ref_bpe)?;
    let ranc = grab(&ref_anc)?;
    let rmul = grab(&ref_multi)?;

    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    // ★`haplotype` 列は書かない(2026-08-16 廃止)。中身は size==1 ? "a" : "b" ＝
    //   **is_bubble の別表記**で、ハプロタイプの意味は無かった(実測で完全一致)。
    let base_sql = "INSERT INTO nodes(layer_index,node_name,is_bubble,size,xCoord,yCoord,\
                    angle,radius,color,coverage,parent_name) \
                    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)";
    let ref_sql = "INSERT INTO nodes(layer_index,node_name,is_bubble,size,xCoord,yCoord,\
                   angle,radius,color,coverage,parent_name,\
                   ref_contig_id,ref_bp,ref_bp_end,is_anchor,ref_multi) \
                   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)";

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let mut rid: i64 = 0;
    let mut n_written: i64 = 0;
    let nn = n as usize;
    // 空間順(Hilbert)の走査順。INSERT 順 = rowid 順なので、ここを空間順にすると
    // ビューポート内のノードが rowid 上で連続する（side 表も同じ rowid を共有するので全部に効く）。
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let scan: Vec<usize> = match ord_ref {
        Some(o) => o.iter().map(|&x| x as usize).collect(),
        None => (0..nn).collect(),
    };
    let prof = profile_on();
    let t0 = Instant::now();
    // 内訳: inline rep_at(parent_name) / flat nodes 追記 / nodes_rtree 仮想表。
    let (mut t_repat, mut t_wflat, mut t_wrt) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    for l in start..=maxlayer {
        let lw = l - start;
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut k: i64 = 0;
        {
            let mut ins = tx
                .prepare(if have_ref { ref_sql } else { base_sql })
                .map_err(|e| sqlite_err("prep nodes", e))?;
            let mut ins_rt = if skip_rtree {
                None
            } else {
                Some(
                    tx.prepare(
                        "INSERT INTO nodes_rtree(rowid,min_x,max_x,min_y,max_y,min_layer,max_layer) \
                         VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    )
                    .map_err(|e| sqlite_err("prep rtree", e))?,
                )
            };
            for &v in scan.iter() {
                let b = birth[v];
                if b < 0 || b > l || l >= death[v] {
                    continue;
                }
                let isbub: i64 = if size[v] != 1 { 1 } else { 0 };
                let name = node_name(v, atom, kind, idm);
                let tp = if prof { Some(Instant::now()) } else { None };
                let pname: Option<String> = if lw == 0 {
                    None
                } else {
                    let r = rep_at(v as i64, l - 1, birth, fp) as usize;
                    Some(node_name(r, atom, kind, idm))
                };
                if let Some(tp) = tp { t_repat += tp.elapsed(); }
                let x = cx[v];
                let y = cy[v];
                let r = rad[v];
                let tf = if prof { Some(Instant::now()) } else { None };
                if have_ref {
                    let cid = if rcid[v] < 0 { None } else { Some(rcid[v]) };
                    let bp = if rbp[v] < 0 { None } else { Some(rbp[v]) };
                    let bpe = if rbpe[v] < 0 { None } else { Some(rbpe[v]) };
                    ins.execute(params![lw, name, isbub, sbp[v], x, y, ang[v], r, isbub,
                                         cnt[v], pname, cid, bp, bpe, ranc[v], rmul[v]])
                        .map_err(|e| sqlite_err("ins nodes", e))?;
                } else {
                    ins.execute(params![lw, name, isbub, sbp[v], x, y, ang[v], r, isbub,
                                         cnt[v], pname])
                        .map_err(|e| sqlite_err("ins nodes", e))?;
                }
                if let Some(tf) = tf { t_wflat += tf.elapsed(); }
                let rowid = rid + 1 + k;
                let trt = if prof { Some(Instant::now()) } else { None };
                if let Some(ins_rt) = ins_rt.as_mut() {
                    ins_rt
                        .execute(params![rowid, x - r, x + r, y - r, y + r, lw, lw])
                        .map_err(|e| sqlite_err("ins rtree", e))?;
                }
                if let Some(trt) = trt { t_wrt += trt.elapsed(); }
                k += 1;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        rid += k;
        n_written += k;
        per_layer[lw as usize] = k;
    }
    // parent_name 索引は Python 側(全挿入後)で張る。
    let _ = n_written;
    if prof {
        eprintln!(
            "[emit_core] emit_nodes: total={:.1}s [repat={:.1}s flat={:.1}s rtree={:.1}s] rows={}",
            secs(t0.elapsed()), secs(t_repat), secs(t_wflat), secs(t_wrt), rid
        );
    }
    Ok((rid, per_layer))
}

/// A-2 hap-breadth: 昇順 contig 列を hap_id へ写像した distinct 数。contig_id は (sample,hap,contig)
/// 昇順採番=c2h は単調非減少、かつ contigs は node 内で昇順 → hap 値は非減少なので遷移数+1 で distinct
/// (np.unique(c2h[ids]).size と一致)。c2h 未指定(空)なら -1(=viewer で NULL 扱い)。
#[inline]
fn hap_breadth(contigs: &[u32], c2h: &[i64]) -> i64 {
    if c2h.is_empty() || contigs.is_empty() {
        return if contigs.is_empty() { 0 } else { -1 };
    }
    let mut hb = 1i64;
    let mut last = c2h[contigs[0] as usize];
    for &c in &contigs[1..] {
        let h = c2h[c as usize];
        if h != last {
            hb += 1;
            last = h;
        }
    }
    hb
}

/// contig blob = [u32 count LE][count×u32 contig_id LE]([count×u8 cov])。cov=None ならエッジ用(cov 無し)。
#[inline]
fn push_contig_blob(buf: &mut Vec<u8>, contigs: &[u32], covs: Option<&[u8]>) {
    buf.clear();
    buf.extend_from_slice(&(contigs.len() as u32).to_le_bytes());
    for &c in contigs {
        buf.extend_from_slice(&c.to_le_bytes());
    }
    if let Some(cv) = covs {
        buf.extend_from_slice(cv);
    }
}

/// §8.55 node_contig_cov の層別発行(surgical)。Python の streaming 走査が作った incidence
/// (uniq_leaf, leaf_idx_inc, contig_inc, bp_inc)を受け取り、層ごとに rep_at→(vis,contig)集約→blob 書込。
/// np.unique(I) のソート作業(MC 209G OOM 点)を sort+run 集約に置換し常駐を O(I) に有界化。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, uniq_leaf, leaf_idx_inc, contig_inc, bp_inc,
                    birth, death, fp, sbp, contig2hap, c, start, maxlayer, n, spatial_order))]
fn emit_ribbon_contig_layers<'py>(
    _py: Python<'py>,
    db_path: String,
    uniq_leaf: PyReadonlyArray1<'py, i64>,
    leaf_idx_inc: PyReadonlyArray1<'py, i64>,
    contig_inc: PyReadonlyArray1<'py, i64>,
    bp_inc: PyReadonlyArray1<'py, i64>,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    sbp: PyReadonlyArray1<'py, f64>,
    contig2hap: PyReadonlyArray1<'py, i64>,
    c: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let uniq_leaf = uniq_leaf.as_slice().map_err(m)?;
    let leaf_idx_inc = leaf_idx_inc.as_slice().map_err(m)?;
    let contig_inc = contig_inc.as_slice().map_err(m)?;
    let bp_inc = bp_inc.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let death = death.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    let sbp = sbp.as_slice().map_err(m)?;
    let c2h = contig2hap.as_slice().map_err(m)?; // A-2 hap-breadth 用(空 slice なら hb=-1)
    const QMAX: f64 = 255.0;

    let u = uniq_leaf.len();
    let inc = leaf_idx_inc.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let nn = n as usize;
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let mut posmap = vec![-1i64; nn]; // node -> local index(P 内位置)。層末に p_list 分だけ戻す。
    let mut p_list: Vec<usize> = Vec::new();
    let mut rep_u = vec![0i64; u]; // 層ごとの uniq_leaf の代表
    let mut keybp: Vec<(i64, i64)> = Vec::with_capacity(inc);
    let mut rid_base: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut blob: Vec<u8> = Vec::new();
    let prof = profile_on();
    let (mut t_repat, mut t_sort, mut t_write) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    for l in start..=maxlayer {
        let lw = l - start;
        let ts0 = Instant::now();
        // P と posmap(node->local)
        let k = build_layer_set(l, nn, birth, death, ord_ref, &mut posmap, &mut p_list);
        if prof { t_sort += ts0.elapsed(); }
        // 層 L の各 uniq_leaf の代表
        let tr = Instant::now();
        for j in 0..u {
            rep_u[j] = rep_at(uniq_leaf[j], l, birth, fp);
        }
        if prof { t_repat += tr.elapsed(); }
        // incidence -> (key=vis*C+contig, bp)。sort+run で (vis,contig) 集約(bp は int64 で順序不問)。
        let ts = Instant::now();
        keybp.clear();
        for i in 0..inc {
            let vis = rep_u[leaf_idx_inc[i] as usize];
            // ★鍵の上位は **局所 index(posmap)**。大域 v だと空間順採番のとき sort 結果が
            //   rowid 順にならず、INSERT が逆走して B-tree の page split を招く。
            let nl = if vis >= 0 { posmap[vis as usize] } else { -1 };
            if nl < 0 { continue; }
            keybp.push((nl * c + contig_inc[i], bp_inc[i]));
        }
        keybp.sort_unstable_by_key(|&(kk, _)| kk);
        if prof { t_sort += ts.elapsed(); }

        let tw = Instant::now();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_nodes: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO node_contig_cov(node_rowid,blob,hb) VALUES(?1,?2,?3)")
                .map_err(|e| sqlite_err("prep ncc", e))?;
            // sorted key を run 集約。key 昇順 = (vis,contig) 昇順 = (node_local,contig) 昇順(posmap 単調)。
            let mut cur_node: i64 = -1;
            let mut contigs: Vec<u32> = Vec::new();
            let mut covs: Vec<u8> = Vec::new();
            let mut i = 0usize;
            while i < keybp.len() {
                let key = keybp[i].0;
                let mut sum: i64 = 0;
                while i < keybp.len() && keybp[i].0 == key {
                    sum += keybp[i].1;
                    i += 1;
                }
                // 鍵の上位は局所 index。大域 v は p_list で逆引きする（p_list[nl] = そのノード）。
                let nl = key / c;
                let vis = p_list[nl as usize];
                let contig = (key % c) as u32;
                let sz = if sbp[vis] > 1.0 { sbp[vis] } else { 1.0 };
                let qf = (QMAX * (sum as f64) / sz).round_ties_even();
                let q = qf.clamp(1.0, QMAX) as u8;
                if nl != cur_node {
                    if cur_node >= 0 && !contigs.is_empty() {
                        push_contig_blob(&mut blob, &contigs, Some(&covs));
                        ins.execute(params![rid_base + 1 + cur_node, blob.as_slice(),
                                            hap_breadth(&contigs, c2h)])
                            .map_err(|e| sqlite_err("ins ncc", e))?;
                        n_nodes += 1;
                    }
                    cur_node = nl;
                    contigs.clear();
                    covs.clear();
                }
                contigs.push(contig);
                covs.push(q);
            }
            if cur_node >= 0 && !contigs.is_empty() {
                push_contig_blob(&mut blob, &contigs, Some(&covs));
                ins.execute(params![rid_base + 1 + cur_node, blob.as_slice(),
                                    hap_breadth(&contigs, c2h)])
                    .map_err(|e| sqlite_err("ins ncc", e))?;
                n_nodes += 1;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        if prof { t_write += tw.elapsed(); }
        // posmap を戻す(次層のため)
        for &v in &p_list {
            posmap[v] = -1;
        }
        rid_base += k;
        rows_written += n_nodes;
        per_layer[lw as usize] = n_nodes;
    }
    if prof {
        eprintln!(
            "[emit_core] emit_ribbon_contig: repat={:.1}s Pbuild+keybp+sort={:.1}s write(sqlite+blob)={:.1}s rows={}",
            secs(t_repat), secs(t_sort), secs(t_write), rows_written
        );
    }
    Ok((rows_written, per_layer))
}

/// §3.4 逆位 node_contig_inv の層別発行。emit_ribbon_contig_layers と同一の climb/森集約機構だが、
/// (leaf,contig) ごとに **2重み**(totbp=被覆bp / invbp=逆位bp)を持ち、reducer が「分数」:
///   q = round(255·invbp/totbp) を **q>0 のときだけ疎格納**(ribbon は sum/size で常に q≥1)。
/// Python 側が GFA 直読み→per-step 向き取得→rel=向き XOR ref向き→contig 多数派 baseline→逸脱=逆位、
/// までを済ませ (uniq_leaf, leaf_idx_inc, contig_inc, totbp_inc, invbp_inc) を渡す(§7: GFA パース/向きは
/// Python 据置)。Rust は per-layer rep_at climb→(vis,contig)集約→invfrac→blob。出力は Python 版と bit 一致。
/// blob=[u32 count][count×u32 id 昇順][count×u8 invfrac]。node_contig_cov と同型・同 rowid 規約。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, uniq_leaf, leaf_idx_inc, contig_inc, totbp_inc, invbp_inc,
                    birth, death, fp, c, start, maxlayer, n, spatial_order))]
fn emit_contig_inv_layers<'py>(
    _py: Python<'py>,
    db_path: String,
    uniq_leaf: PyReadonlyArray1<'py, i64>,
    leaf_idx_inc: PyReadonlyArray1<'py, i64>,
    contig_inc: PyReadonlyArray1<'py, i64>,
    totbp_inc: PyReadonlyArray1<'py, i64>,
    invbp_inc: PyReadonlyArray1<'py, i64>,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    c: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let uniq_leaf = uniq_leaf.as_slice().map_err(m)?;
    let leaf_idx_inc = leaf_idx_inc.as_slice().map_err(m)?;
    let contig_inc = contig_inc.as_slice().map_err(m)?;
    let totbp_inc = totbp_inc.as_slice().map_err(m)?;
    let invbp_inc = invbp_inc.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let death = death.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    const QMAX: f64 = 255.0;

    let u = uniq_leaf.len();
    let inc = leaf_idx_inc.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let nn = n as usize;
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let mut posmap = vec![-1i64; nn]; // node -> local index(P 内位置)。層末に p_list 分だけ戻す。
    let mut p_list: Vec<usize> = Vec::new();
    let mut rep_u = vec![0i64; u]; // 層ごとの uniq_leaf の代表
    let mut keyw: Vec<(i64, i64, i64)> = Vec::with_capacity(inc); // (key=vis*C+contig, totbp, invbp)
    let mut rid_base: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut blob: Vec<u8> = Vec::new();
    let prof = profile_on();
    let (mut t_repat, mut t_sort, mut t_write) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    for l in start..=maxlayer {
        let lw = l - start;
        // P と posmap(node->local)。emit_ribbon_contig_layers と厳密同一の在圏判定・rid 規約。
        let ts0 = Instant::now();
        let k = build_layer_set(l, nn, birth, death, ord_ref, &mut posmap, &mut p_list);
        if prof { t_sort += ts0.elapsed(); }
        // 層 L の各 uniq_leaf の代表
        let tr = Instant::now();
        for j in 0..u {
            rep_u[j] = rep_at(uniq_leaf[j], l, birth, fp);
        }
        if prof { t_repat += tr.elapsed(); }
        // incidence -> (key=vis*C+contig, totbp, invbp)。sort+run で (vis,contig) 集約。
        let ts = Instant::now();
        keyw.clear();
        for i in 0..inc {
            let vis = rep_u[leaf_idx_inc[i] as usize];
            let nl = if vis >= 0 { posmap[vis as usize] } else { -1 };
            if nl < 0 { continue; }
            keyw.push((nl * c + contig_inc[i], totbp_inc[i], invbp_inc[i]));
        }
        keyw.sort_unstable_by_key(|&(kk, _, _)| kk);
        if prof { t_sort += ts.elapsed(); }

        let tw = Instant::now();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_nodes: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO node_contig_inv(node_rowid,blob) VALUES(?1,?2)")
                .map_err(|e| sqlite_err("prep nci", e))?;
            // sorted key を run 集約。key 昇順 = (node_local,contig) 昇順(posmap 単調)。q>0 のみ疎格納。
            let mut cur_node: i64 = -1;
            let mut contigs: Vec<u32> = Vec::new();
            let mut covs: Vec<u8> = Vec::new();
            let mut i = 0usize;
            while i < keyw.len() {
                let key = keyw[i].0;
                let mut tot: i64 = 0;
                let mut invv: i64 = 0;
                while i < keyw.len() && keyw[i].0 == key {
                    tot += keyw[i].1;
                    invv += keyw[i].2;
                    i += 1;
                }
                // 鍵の上位は局所 index(=rowid 順)。層 P 外は生成側で除いてあるので防御は不要。
                let nl = key / c;
                let denom = if tot > 0 { tot as f64 } else { 1.0 };
                let qf = (QMAX * (invv as f64) / denom).round_ties_even();
                let q = qf.clamp(0.0, QMAX) as u8;
                if q == 0 {
                    continue; // 逆位 bp 無し → 疎格納で省略(Python の good=(q>0) と一致)
                }
                let contig = (key % c) as u32;
                if nl != cur_node {
                    if cur_node >= 0 && !contigs.is_empty() {
                        push_contig_blob(&mut blob, &contigs, Some(&covs));
                        ins.execute(params![rid_base + 1 + cur_node, blob.as_slice()])
                            .map_err(|e| sqlite_err("ins nci", e))?;
                        n_nodes += 1;
                    }
                    cur_node = nl;
                    contigs.clear();
                    covs.clear();
                }
                contigs.push(contig);
                covs.push(q);
            }
            if cur_node >= 0 && !contigs.is_empty() {
                push_contig_blob(&mut blob, &contigs, Some(&covs));
                ins.execute(params![rid_base + 1 + cur_node, blob.as_slice()])
                    .map_err(|e| sqlite_err("ins nci", e))?;
                n_nodes += 1;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        if prof { t_write += tw.elapsed(); }
        // posmap を戻す(次層のため)
        for &v in &p_list {
            posmap[v] = -1;
        }
        rid_base += k;
        rows_written += n_nodes;
        per_layer[lw as usize] = n_nodes;
    }
    if prof {
        eprintln!(
            "[emit_core] emit_contig_inv: repat={:.1}s Pbuild+keyw+sort={:.1}s write(sqlite+blob)={:.1}s rows={}",
            secs(t_repat), secs(t_sort), secs(t_write), rows_written
        );
    }
    Ok((rows_written, per_layer))
}

/// §3.4 逆位 node_contig_inv の disk-streaming 発行(WG 用; RAM をパス本数/incidence 非依存に有界化)。
/// emit_ribbon_contig_disk と同型(Phase A: run を key=leaf*C+gid で (totbp, sum_rel_bp) 合算 → merged;
/// Phase B: 層ごと merged を1回流し rep_at(leaf)=vis 単調 flush)。invbp は baseline で復元:
///   invbp = if baseline[gid]==0 { sum_rel_bp } else { totbp - sum_rel_bp }  (= Σ dev·bp と厳密同値)。
/// (vis,gid) で totbp/invbp を合算 → q=round(255·invbp/totbp), **q>0 のみ疎格納**。blob=[count][gid 昇順][invfrac]。
/// baseline(size C, 0/1)は Python が pass B で bp 重み多数決から確定して渡す。出力は emit_contig_inv_layers と bit 一致。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, run_files, merged_path, baseline, birth, death, fp, c, start, maxlayer, n, spatial_order))]
fn emit_contig_inv_disk<'py>(
    _py: Python<'py>,
    db_path: String,
    run_files: Vec<String>,
    merged_path: String,
    baseline: PyReadonlyArray1<'py, i64>,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    c: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    use std::collections::HashMap;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let baseline = baseline.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let death = death.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    const QMAX: f64 = 255.0;
    let prof = profile_on();
    let ioerr = |ctx: &str, e: std::io::Error| PyRuntimeError::new_err(format!("{ctx}: {e}"));

    // Phase A: run を key=leaf*C+gid で (totbp, sum_rel_bp) 合算 → merged。
    let t_a = Instant::now();
    let nuniq = merge_runs_2w(&run_files, &merged_path).map_err(|e| ioerr("merge_runs_2w", e))?;
    if prof {
        eprintln!("[emit_core] contig_inv_disk: merge {} runs -> I={} ({:.1}s)",
                  run_files.len(), nuniq, secs(t_a.elapsed()));
    }

    let nn = n as usize;
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;
    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let mut posmap = vec![-1i64; nn];
    let mut p_list: Vec<usize> = Vec::new();
    let mut rid_base: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut blob: Vec<u8> = Vec::new();
    let (mut t_repat, mut t_write) = (Duration::ZERO, Duration::ZERO);

    for l in start..=maxlayer {
        let lw = (l - start) as usize;
        let k = build_layer_set(l, nn, birth, death, ord_ref, &mut posmap, &mut p_list);
        let mut rd = TripleFile::open(&merged_path).map_err(|e| ioerr("open merged", e))?;
        let mut n_nodes: i64 = 0;
        let mut last_leaf: i64 = -1;
        let mut cur_rep: i64 = -1;
        let mut cur_vis: i64 = -1;
        let mut dict: HashMap<u32, (i64, i64)> = HashMap::new(); // gid -> (totbp, invbp)
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        {
            let mut ins = tx
                .prepare("INSERT INTO node_contig_inv(node_rowid,blob) VALUES(?1,?2)")
                .map_err(|e| sqlite_err("prep nci", e))?;
            macro_rules! flush {
                ($vis:expr) => {{
                    let vis = $vis;
                    if vis >= 0 && !dict.is_empty() {
                        let nl = posmap[vis as usize];
                        if nl >= 0 {
                            let mut items: Vec<(u32, i64, i64)> =
                                dict.iter().map(|(&g, &(t, iv))| (g, t, iv)).collect();
                            items.sort_unstable_by_key(|&(g, _, _)| g);
                            let mut contigs: Vec<u32> = Vec::with_capacity(items.len());
                            let mut covs: Vec<u8> = Vec::with_capacity(items.len());
                            for (g, tot, invv) in items {
                                let denom = if tot > 0 { tot as f64 } else { 1.0 };
                                let qf = (QMAX * (invv as f64) / denom).round_ties_even();
                                let q = qf.clamp(0.0, QMAX) as u8;
                                if q == 0 {
                                    continue; // 逆位 bp 無し → 疎格納で省略
                                }
                                contigs.push(g);
                                covs.push(q);
                            }
                            if !contigs.is_empty() {
                                push_contig_blob(&mut blob, &contigs, Some(&covs));
                                ins.execute(params![rid_base + 1 + nl, blob.as_slice()])
                                    .map_err(|e| sqlite_err("ins nci", e))?;
                                n_nodes += 1;
                            }
                        }
                    }
                    dict.clear();
                }};
            }
            loop {
                let (key, totbp, sum_rel_bp) = match rd.next3().map_err(|e| ioerr("read merged", e))? {
                    Some(x) => x,
                    None => break,
                };
                let leaf = key / c;
                let gid = (key % c) as usize;
                // invbp = Σ dev·bp を baseline で復元(baseline 0 → dev=rel, 1 → dev=1-rel)。
                let invbp = if baseline[gid] == 0 { sum_rel_bp } else { totbp - sum_rel_bp };
                if leaf != last_leaf {
                    let tr = Instant::now();
                    cur_rep = rep_at(leaf, l, birth, fp);
                    if prof { t_repat += tr.elapsed(); }
                    last_leaf = leaf;
                }
                let vis = cur_rep;
                if vis != cur_vis {
                    let tw = Instant::now();
                    flush!(cur_vis);
                    if prof { t_write += tw.elapsed(); }
                    cur_vis = vis;
                }
                let e = dict.entry(gid as u32).or_insert((0, 0));
                e.0 += totbp;
                e.1 += invbp;
            }
            let tw = Instant::now();
            flush!(cur_vis);
            if prof { t_write += tw.elapsed(); }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        for &v in &p_list {
            posmap[v] = -1;
        }
        rid_base += k;
        rows_written += n_nodes;
        per_layer[lw] = n_nodes;
    }
    if prof {
        eprintln!("[emit_core] contig_inv_disk: layers repat={:.1}s write={:.1}s rows={}",
                  secs(t_repat), secs(t_write), rows_written);
    }
    Ok((rows_written, per_layer))
}

// ==========================================================================
// disk-streaming node_contig_cov(WG 巨大 incidence 用)。RAM を O(node) に有界化。
//   入力: run_files = Python が吐いた «sorted-unique(key昇順) (key=leaf*C+contig, bp) の i64 対» の
//         binary 列(各ファイル内は key 昇順)。これらを k-way マージし key で bp を合算 → merged 化。
//   その merged を «leaf(tree-node-id) 昇順 = DFS 順» とみなし、rep_at(leaf,L) が leaf 昇順で単調
//   (subtree 連続, chr22 で実測検証)である性質を使い、per-layer で «vis が変わったら flush» の
//   dict 累積で集約。np.unique(I) も per-layer keybp(O(I)) も持たない。
//   出力/rowid/blob は emit_ribbon_contig_layers と厳密同一(node_rowid=rid_base+1+posmap[vis])。
// ==========================================================================

/// binary の (i64 key, i64 bp) 対を順に読むバッファ付きリーダ。
struct PairFile {
    rdr: std::io::BufReader<std::fs::File>,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
    done: bool,
}
impl PairFile {
    fn open(path: &str) -> std::io::Result<Self> {
        Ok(PairFile {
            rdr: std::io::BufReader::with_capacity(1 << 22, std::fs::File::open(path)?),
            buf: vec![0u8; 1 << 22],
            pos: 0,
            len: 0,
            done: false,
        })
    }
    fn next_pair(&mut self) -> std::io::Result<Option<(i64, i64)>> {
        use std::io::Read;
        if self.pos + 16 > self.len {
            let rem = self.len - self.pos;
            self.buf.copy_within(self.pos..self.len, 0);
            self.pos = 0;
            self.len = rem;
            while self.len < 16 && !self.done {
                let nread = self.rdr.read(&mut self.buf[self.len..])?;
                if nread == 0 {
                    self.done = true;
                } else {
                    self.len += nread;
                }
            }
            if self.len < 16 {
                return Ok(None);
            }
        }
        let k = i64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        let b = i64::from_le_bytes(self.buf[self.pos + 8..self.pos + 16].try_into().unwrap());
        self.pos += 16;
        Ok(Some((k, b)))
    }
}

/// sorted-unique(key,bp) の run_files を k-way マージ(bp 合算) → merged_path に書く。
fn merge_runs(run_files: &[String], merged_path: &str) -> std::io::Result<i64> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use std::io::Write;
    let mut readers: Vec<PairFile> = Vec::with_capacity(run_files.len());
    for p in run_files {
        readers.push(PairFile::open(p)?);
    }
    // heap: (Reverse(key), bp, run_idx) の min-heap(key 昇順)
    let mut heap: BinaryHeap<Reverse<(i64, i64, usize)>> = BinaryHeap::new();
    for (i, r) in readers.iter_mut().enumerate() {
        if let Some((k, b)) = r.next_pair()? {
            heap.push(Reverse((k, b, i)));
        }
    }
    let mut out = std::io::BufWriter::with_capacity(1 << 22, std::fs::File::create(merged_path)?);
    let mut cur_key: i64 = 0;
    let mut cur_bp: i64 = 0;
    let mut have = false;
    let mut nuniq: i64 = 0;
    while let Some(Reverse((k, b, i))) = heap.pop() {
        if have && k == cur_key {
            cur_bp += b;
        } else {
            if have {
                out.write_all(&cur_key.to_le_bytes())?;
                out.write_all(&cur_bp.to_le_bytes())?;
                nuniq += 1;
            }
            cur_key = k;
            cur_bp = b;
            have = true;
        }
        if let Some((k2, b2)) = readers[i].next_pair()? {
            heap.push(Reverse((k2, b2, i)));
        }
    }
    if have {
        out.write_all(&cur_key.to_le_bytes())?;
        out.write_all(&cur_bp.to_le_bytes())?;
        nuniq += 1;
    }
    out.flush()?;
    Ok(nuniq)
}

/// binary の (i64,i64,i64) 三つ組を順に読むリーダ(edge mult disk 用: (a=lo, hi*H+hap, count))。
struct TripleFile {
    rdr: std::io::BufReader<std::fs::File>,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
    done: bool,
}
impl TripleFile {
    fn open(path: &str) -> std::io::Result<Self> {
        Ok(TripleFile {
            rdr: std::io::BufReader::with_capacity(1 << 22, std::fs::File::open(path)?),
            buf: vec![0u8; 1 << 22],
            pos: 0,
            len: 0,
            done: false,
        })
    }
    fn next3(&mut self) -> std::io::Result<Option<(i64, i64, i64)>> {
        use std::io::Read;
        if self.pos + 24 > self.len {
            let rem = self.len - self.pos;
            self.buf.copy_within(self.pos..self.len, 0);
            self.pos = 0;
            self.len = rem;
            while self.len < 24 && !self.done {
                let nread = self.rdr.read(&mut self.buf[self.len..])?;
                if nread == 0 { self.done = true; } else { self.len += nread; }
            }
            if self.len < 24 {
                return Ok(None);
            }
        }
        let a = i64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        let b = i64::from_le_bytes(self.buf[self.pos + 8..self.pos + 16].try_into().unwrap());
        let w = i64::from_le_bytes(self.buf[self.pos + 16..self.pos + 24].try_into().unwrap());
        self.pos += 24;
        Ok(Some((a, b, w)))
    }
}

/// sorted((c1,c2),w) の run_files を k-way マージ((c1,c2)で w 合算) → merged_path((c1,c2)昇順 unique)。
/// 各 run は (c1,c2) 昇順であれば良い(run 内 unique でなくても重複はマージで合算される)。
fn merge_runs3_sum(run_files: &[String], merged_path: &str) -> std::io::Result<i64> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use std::io::Write;
    let mut readers: Vec<TripleFile> = Vec::with_capacity(run_files.len());
    for p in run_files {
        readers.push(TripleFile::open(p)?);
    }
    // heap: (Reverse((c1,c2)), w, run_idx) の min-heap((c1,c2) 昇順)
    let mut heap: BinaryHeap<Reverse<((i64, i64), i64, usize)>> = BinaryHeap::new();
    for (i, r) in readers.iter_mut().enumerate() {
        if let Some((a, b, w)) = r.next3()? {
            heap.push(Reverse(((a, b), w, i)));
        }
    }
    let mut out = std::io::BufWriter::with_capacity(1 << 22, std::fs::File::create(merged_path)?);
    let mut cur: (i64, i64) = (0, 0);
    let mut cur_w: i64 = 0;
    let mut have = false;
    let mut nuniq: i64 = 0;
    while let Some(Reverse((key, w, i))) = heap.pop() {
        if have && key == cur {
            cur_w += w;
        } else {
            if have {
                out.write_all(&cur.0.to_le_bytes())?;
                out.write_all(&cur.1.to_le_bytes())?;
                out.write_all(&cur_w.to_le_bytes())?;
                nuniq += 1;
            }
            cur = key;
            cur_w = w;
            have = true;
        }
        if let Some((a2, b2, w2)) = readers[i].next3()? {
            heap.push(Reverse(((a2, b2), w2, i)));
        }
    }
    if have {
        out.write_all(&cur.0.to_le_bytes())?;
        out.write_all(&cur.1.to_le_bytes())?;
        out.write_all(&cur_w.to_le_bytes())?;
        nuniq += 1;
    }
    out.flush()?;
    Ok(nuniq)
}

/// (key, w1, w2) の run_files を k-way マージ(key で w1,w2 を各々合算) → merged(key 昇順)。各 run は key 昇順。
/// 逆位 disk 用: key=leaf*C+gid, w1=totbp, w2=sum(rel*bp)。TripleFile を (key,w1,w2) と解釈して再利用。
fn merge_runs_2w(run_files: &[String], merged_path: &str) -> std::io::Result<i64> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use std::io::Write;
    let mut readers: Vec<TripleFile> = Vec::with_capacity(run_files.len());
    for p in run_files {
        readers.push(TripleFile::open(p)?);
    }
    let mut heap: BinaryHeap<Reverse<(i64, i64, i64, usize)>> = BinaryHeap::new();
    for (i, r) in readers.iter_mut().enumerate() {
        if let Some((k, w1, w2)) = r.next3()? {
            heap.push(Reverse((k, w1, w2, i)));
        }
    }
    let mut out = std::io::BufWriter::with_capacity(1 << 22, std::fs::File::create(merged_path)?);
    let mut cur_k: i64 = 0;
    let mut cur1: i64 = 0;
    let mut cur2: i64 = 0;
    let mut have = false;
    let mut nuniq: i64 = 0;
    while let Some(Reverse((k, w1, w2, i))) = heap.pop() {
        if have && k == cur_k {
            cur1 += w1;
            cur2 += w2;
        } else {
            if have {
                out.write_all(&cur_k.to_le_bytes())?;
                out.write_all(&cur1.to_le_bytes())?;
                out.write_all(&cur2.to_le_bytes())?;
                nuniq += 1;
            }
            cur_k = k;
            cur1 = w1;
            cur2 = w2;
            have = true;
        }
        if let Some((k2, a2, b2)) = readers[i].next3()? {
            heap.push(Reverse((k2, a2, b2, i)));
        }
    }
    if have {
        out.write_all(&cur_k.to_le_bytes())?;
        out.write_all(&cur1.to_le_bytes())?;
        out.write_all(&cur2.to_le_bytes())?;
        nuniq += 1;
    }
    out.flush()?;
    Ok(nuniq)
}

/// disk-streaming 版 node_contig_cov 発行。RAM=O(node)。emit_ribbon_contig_layers と結果 bit 同一。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, run_files, merged_path, birth, death, fp, sbp, contig2hap, c, start, maxlayer, n, spatial_order))]
fn emit_ribbon_contig_disk<'py>(
    _py: Python<'py>,
    db_path: String,
    run_files: Vec<String>,
    merged_path: String,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    sbp: PyReadonlyArray1<'py, f64>,
    contig2hap: PyReadonlyArray1<'py, i64>,
    c: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    use std::collections::HashMap;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let birth = birth.as_slice().map_err(m)?;
    let death = death.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    let sbp = sbp.as_slice().map_err(m)?;
    let c2h = contig2hap.as_slice().map_err(m)?; // A-2 hap-breadth 用(空 slice なら hb=-1)
    const QMAX: f64 = 255.0;
    let prof = profile_on();
    let ioerr = |ctx: &str, e: std::io::Error| PyRuntimeError::new_err(format!("{ctx}: {e}"));

    // Phase A: run_files を k-way マージ(bp 合算) → merged(key 昇順 unique)。
    let t_a = Instant::now();
    let nuniq = merge_runs(&run_files, &merged_path).map_err(|e| ioerr("merge_runs", e))?;
    if prof {
        eprintln!("[emit_core] ribbon_disk: merge {} runs -> I={} ({:.1}s)",
                  run_files.len(), nuniq, secs(t_a.elapsed()));
    }

    let nn = n as usize;
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;
    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let mut posmap = vec![-1i64; nn];
    let mut p_list: Vec<usize> = Vec::new();
    let mut rid_base: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut blob: Vec<u8> = Vec::new();
    let (mut t_repat, mut t_write) = (Duration::ZERO, Duration::ZERO);

    // Phase B: 層ごとに merged を1回ずつ流し、vis が変わったら dict を flush。
    for l in start..=maxlayer {
        let lw = (l - start) as usize;
        // posmap(present node -> local rank, v 昇順)
        let k = build_layer_set(l, nn, birth, death, ord_ref, &mut posmap, &mut p_list);
        let mut rd = PairFile::open(&merged_path).map_err(|e| ioerr("open merged", e))?;
        let mut n_nodes: i64 = 0;
        let mut last_leaf: i64 = -1;
        let mut cur_rep: i64 = -1;
        let mut cur_vis: i64 = -1;
        let mut dict: HashMap<u32, i64> = HashMap::new();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        {
            let mut ins = tx
                .prepare("INSERT INTO node_contig_cov(node_rowid,blob,hb) VALUES(?1,?2,?3)")
                .map_err(|e| sqlite_err("prep ncc", e))?;
            // flush クロージャは借用が絡むのでマクロ的に inline 展開する。
            macro_rules! flush {
                ($vis:expr) => {{
                    let vis = $vis;
                    if vis >= 0 && !dict.is_empty() {
                        let nl = posmap[vis as usize];
                        if nl >= 0 {
                            let mut items: Vec<(u32, i64)> =
                                dict.iter().map(|(&cg, &s)| (cg, s)).collect();
                            items.sort_unstable_by_key(|&(cg, _)| cg);
                            let sz = if sbp[vis as usize] > 1.0 { sbp[vis as usize] } else { 1.0 };
                            let mut contigs: Vec<u32> = Vec::with_capacity(items.len());
                            let mut covs: Vec<u8> = Vec::with_capacity(items.len());
                            for (cg, s) in items {
                                let qf = (QMAX * (s as f64) / sz).round_ties_even();
                                let q = qf.clamp(1.0, QMAX) as u8;
                                contigs.push(cg);
                                covs.push(q);
                            }
                            push_contig_blob(&mut blob, &contigs, Some(&covs));
                            ins.execute(params![rid_base + 1 + nl, blob.as_slice(),
                                                hap_breadth(&contigs, c2h)])
                                .map_err(|e| sqlite_err("ins ncc", e))?;
                            n_nodes += 1;
                        }
                    }
                    dict.clear();
                }};
            }
            let ts = Instant::now();
            loop {
                let pair = rd.next_pair().map_err(|e| ioerr("read merged", e))?;
                let (key, bp) = match pair {
                    Some(x) => x,
                    None => break,
                };
                let leaf = key / c;
                let contig = (key % c) as u32;
                if leaf != last_leaf {
                    let tr = Instant::now();
                    cur_rep = rep_at(leaf, l, birth, fp);
                    if prof { t_repat += tr.elapsed(); }
                    last_leaf = leaf;
                }
                let vis = cur_rep;
                if vis != cur_vis {
                    let tw = Instant::now();
                    flush!(cur_vis);
                    if prof { t_write += tw.elapsed(); }
                    cur_vis = vis;
                }
                *dict.entry(contig).or_insert(0) += bp;
            }
            let tw = Instant::now();
            flush!(cur_vis);
            if prof { t_write += tw.elapsed(); let _ = ts; }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        for &v in &p_list {
            posmap[v] = -1;
        }
        rid_base += k;
        rows_written += n_nodes;
        per_layer[lw] = n_nodes;
    }
    // merged 一時ファイルは呼び出し側(Python)が片付ける。
    if prof {
        eprintln!(
            "[emit_core] ribbon_disk: layers repat={:.1}s write(blob+sqlite)={:.1}s rows={}",
            secs(t_repat), secs(t_write), rows_written
        );
    }
    Ok((rows_written, per_layer))
}

/// §A-2 通過多重度 node_hap_mult の disk-streaming 発行(WG 用; RAM をパス本数/incidence 非依存に有界化)。
/// emit_ribbon_contig_disk と同型(Phase A: run k-way マージで (leaf*H+hap) ごとの count 合算 → merged;
/// Phase B: 層ごと merged を 1 回流し rep_at(leaf)=vis 単調で vis 変化 flush)だが reducer が **max**
/// (配下葉の per-hap copy の最大)で、**present な全 hap(cn≥1)** を **葉(kind 0)＋flubble(kind 2)のみ** 格納
/// (クラスタ kind 1 除外)。node key=leaf*H+hap は i64 安全(ntree·H≪2^63)。出力は in-RAM(emit_hap_mult_node_layers)と bit 一致。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, run_files, merged_path, kind, birth, death, fp, h, start, maxlayer, n, spatial_order))]
fn emit_hap_mult_node_disk<'py>(
    _py: Python<'py>,
    db_path: String,
    run_files: Vec<String>,
    merged_path: String,
    kind: PyReadonlyArray1<'py, u8>,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    h: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, i64, Vec<i64>)> {
    use std::collections::HashMap;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let kind = kind.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let death = death.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    let prof = profile_on();
    let ioerr = |ctx: &str, e: std::io::Error| PyRuntimeError::new_err(format!("{ctx}: {e}"));

    // Phase A: run_files を k-way マージ(count 合算=葉レベル copy) → merged(key=leaf*H+hap 昇順 unique)。
    let t_a = Instant::now();
    let nuniq = merge_runs(&run_files, &merged_path).map_err(|e| ioerr("merge_runs", e))?;
    if prof {
        eprintln!("[emit_core] hapmult_node_disk: merge {} runs -> I={} ({:.1}s)",
                  run_files.len(), nuniq, secs(t_a.elapsed()));
    }

    let nn = n as usize;
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;
    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let mut posmap = vec![-1i64; nn];
    let mut p_list: Vec<usize> = Vec::new();
    let mut rid_base: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut blob: Vec<u8> = Vec::new();
    let mut max_cn: u8 = 0;   // 格納した cn(u8)の全ノード最大 = 通過多重度スケール上限(db_meta.max_mult 用)
    let (mut t_repat, mut t_write) = (Duration::ZERO, Duration::ZERO);

    // Phase B: 層ごとに merged を1回ずつ流し、vis(=rep_at(leaf))が変わったら dict{hap:max}を flush。
    for l in start..=maxlayer {
        let lw = (l - start) as usize;
        let k = build_layer_set(l, nn, birth, death, ord_ref, &mut posmap, &mut p_list);
        let mut rd = PairFile::open(&merged_path).map_err(|e| ioerr("open merged", e))?;
        let mut n_nodes: i64 = 0;
        let mut last_leaf: i64 = -1;
        let mut cur_rep: i64 = -1;
        let mut cur_vis: i64 = -1;
        let mut dict: HashMap<u32, i64> = HashMap::new();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        {
            let mut ins = tx
                .prepare("INSERT INTO node_hap_mult(node_rowid,blob) VALUES(?1,?2)")
                .map_err(|e| sqlite_err("prep nhm", e))?;
            // present 全 hap(cn≥1)を格納・葉(0)/flubble(2)のみ(kind 1 除外)。cn=min(max,255)。hap 昇順。
            macro_rules! flush {
                ($vis:expr) => {{
                    let vis = $vis;
                    if vis >= 0 && !dict.is_empty() {
                        let nl = posmap[vis as usize];
                        let kd = kind[vis as usize];
                        if nl >= 0 && (kd == 0 || kd == 2) {
                            let mut items: Vec<(u32, i64)> =
                                dict.iter().map(|(&hp, &s)| (hp, s)).collect();
                            items.sort_unstable_by_key(|&(hp, _)| hp);
                            let mut haps: Vec<u32> = Vec::with_capacity(items.len());
                            let mut cns: Vec<u8> = Vec::with_capacity(items.len());
                            for (hp, s) in items {
                                haps.push(hp);
                                let c8 = s.clamp(0, 255) as u8;
                                if c8 > max_cn { max_cn = c8; }
                                cns.push(c8);
                            }
                            push_contig_blob(&mut blob, &haps, Some(&cns));
                            ins.execute(params![rid_base + 1 + nl, blob.as_slice()])
                                .map_err(|e| sqlite_err("ins nhm", e))?;
                            n_nodes += 1;
                        }
                    }
                    dict.clear();
                }};
            }
            loop {
                let pair = rd.next_pair().map_err(|e| ioerr("read merged", e))?;
                let (key, cnt) = match pair {
                    Some(x) => x,
                    None => break,
                };
                let leaf = key / h;
                let hap = (key % h) as u32;
                if leaf != last_leaf {
                    let tr = Instant::now();
                    cur_rep = rep_at(leaf, l, birth, fp);
                    if prof { t_repat += tr.elapsed(); }
                    last_leaf = leaf;
                }
                let vis = cur_rep;
                if vis != cur_vis {
                    let tw = Instant::now();
                    flush!(cur_vis);
                    if prof { t_write += tw.elapsed(); }
                    cur_vis = vis;
                }
                let e = dict.entry(hap).or_insert(0);
                if cnt > *e { *e = cnt; }   // 配下葉の max
            }
            let tw = Instant::now();
            flush!(cur_vis);
            if prof { t_write += tw.elapsed(); }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        for &v in &p_list {
            posmap[v] = -1;
        }
        rid_base += k;
        rows_written += n_nodes;
        per_layer[lw] = n_nodes;
    }
    if prof {
        eprintln!(
            "[emit_core] hapmult_node_disk: layers repat={:.1}s write={:.1}s rows={}",
            secs(t_repat), secs(t_write), rows_written
        );
    }
    Ok((rows_written, max_cn as i64, per_layer))
}

/// §A-2 通過多重度 edge_hap_mult の disk-streaming 発行(WG 用; RAM をパス本数/incidence 非依存に有界化)。
/// emit_edge_contig_cov_disk と同型(rep_arr 前計算 + uk base 超辺 + merged を Sa-flush で1パス集約)だが、
/// reducer が **max**(配下 leaf-edge の per-hap copy の最大)で **cn>1 のみ疎格納**。
/// 入力 run_files = «(a=lo, hi*H+hap, count)» の 3 値 binary((a, hi*H+hap) 昇順)。canonical lo<hi +
/// rep 単調 → rep(lo)=sa <= rep(hi)=sb で super-edge (sa,sb) は lo の block からのみ寄与(無向重複なし)。
/// 出力(edge_rowid = e_rid+1+uk_index, blob=[count][hap 昇順][cn])は in-RAM(emit_hap_mult_edge_layers)と bit 一致。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, en_i, en_j, run_files, merged_path, birth, fp, h, start, maxlayer, n, spatial_order=None))]
fn emit_hap_mult_edge_disk<'py>(
    _py: Python<'py>,
    db_path: String,
    en_i: PyReadonlyArray1<'py, i64>,
    en_j: PyReadonlyArray1<'py, i64>,
    run_files: Vec<String>,
    merged_path: String,
    birth: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    h: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードの空間順(Hilbert)。エッジ rowid を端点の空間順位で採番するのに使う。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    use std::collections::HashMap;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let en_i = en_i.as_slice().map_err(m)?;
    let en_j = en_j.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    let ioerr = |ctx: &str, e: std::io::Error| PyRuntimeError::new_err(format!("{ctx}: {e}"));
    let prof = profile_on();

    // Phase A: run_files を k-way マージ((a, hi*H+hap)で count 合算) → merged(葉レベル copy)。
    let t_a = Instant::now();
    let nuniq = merge_runs3_sum(&run_files, &merged_path).map_err(|e| ioerr("merge_runs3_sum", e))?;
    if prof {
        eprintln!("[emit_core] hapmult_edge_disk: merge {} runs -> I={} ({:.1}s)",
                  run_files.len(), nuniq, secs(t_a.elapsed()));
    }

    let nn = n as usize;
    let ne = en_i.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;
    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let mut rep_arr = vec![-1i64; nn];
    let mut uk: Vec<i64> = Vec::new();
    let mut blob: Vec<u8> = Vec::new();
    let mut e_rid: i64 = 0;
    let mut rows_written: i64 = 0;
    let (mut t_rep, mut t_write) = (Duration::ZERO, Duration::ZERO);

    // 空間順位（None なら従来どおり uk の生キー順＝木インデックス順）
    let _srank = srank_of(
        match &spatial_order {
            Some(a) => Some(a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?),
            None => None,
        },
        n as usize,
    );
    for l in start..=maxlayer {
        let lw = (l - start) as usize;
        let tr = Instant::now();
        // rep_arr[v] = birth<=L なら v、さもなくば親の rep(topo: parent<v)。emit_edge_contig_cov_disk と同一。
        for v in 0..nn {
            let b = birth[v];
            rep_arr[v] = if b >= 0 && b <= l {
                v as i64
            } else {
                let p = fp[v];
                if p >= 0 { rep_arr[p as usize] } else { -1 }
            };
        }
        uk.clear();
        for e in 0..ne {
            let ga = rep_arr[en_i[e] as usize];
            let gb = rep_arr[en_j[e] as usize];
            if ga < 0 || gb < 0 || ga == gb {
                continue;
            }
            let (lo, hi) = if ga < gb { (ga, gb) } else { (gb, ga) };
            uk.push(lo * n + hi);
        }
        if prof { t_rep += tr.elapsed(); }
        if uk.is_empty() {
            continue; // ke=0(e_rid 不変)
        }
        uk.sort_unstable();
        uk.dedup();
        // エッジ rowid を **端点の空間順**に写す（uk 自体は binary_search のため生キー昇順のまま）
        let erank = edge_spatial_rank(&uk, n, _srank.as_deref());
        let ke = uk.len() as i64;

        // merged を1回流し Sa-flush。dict{sb -> {hap -> max count}}。
        let mut rd = TripleFile::open(&merged_path).map_err(|e| ioerr("open merged", e))?;
        let mut cur_sa: i64 = -1;
        let mut dict: HashMap<i64, HashMap<u32, i64>> = HashMap::new();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_edges: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO edge_hap_mult(edge_rowid,blob) VALUES(?1,?2)")
                .map_err(|e| sqlite_err("prep ehm", e))?;
            macro_rules! flush {
                ($sa:expr) => {{
                    let sa = $sa;
                    if sa >= 0 {
                        for (sb, hm) in dict.iter() {
                            let superkey = sa * n + *sb; // sa <= sb(canonical + rep 単調)
                            if let Ok(pos) = uk.binary_search(&superkey) {
                                // cn>1 の hap のみ、hap 昇順。
                                let mut items: Vec<(u32, u8)> = hm.iter()
                                    .filter(|&(_, &mx)| mx > 1)
                                    .map(|(&hp, &mx)| (hp, mx.clamp(0, 255) as u8))
                                    .collect();
                                if items.is_empty() {
                                    continue;
                                }
                                items.sort_unstable_by_key(|&(hp, _)| hp);
                                let haps: Vec<u32> = items.iter().map(|&(hp, _)| hp).collect();
                                let cns: Vec<u8> = items.iter().map(|&(_, c)| c).collect();
                                push_contig_blob(&mut blob, &haps, Some(&cns));
                                ins.execute(params![e_rid + 1 + erank[pos], blob.as_slice()])
                                    .map_err(|e| sqlite_err("ins ehm", e))?;
                                n_edges += 1;
                            }
                        }
                    }
                    dict.clear();
                }};
            }
            let tw = Instant::now();
            loop {
                let (a, col2, cnt) = match rd.next3().map_err(|e| ioerr("read merged", e))? {
                    Some(x) => x,
                    None => break,
                };
                let hi = col2 / h;
                let hap = (col2 % h) as u32;
                let sa = rep_arr[a as usize];
                let sb = rep_arr[hi as usize];
                if sa < 0 || sb < 0 || sa == sb {
                    continue;
                }
                if sa != cur_sa {
                    flush!(cur_sa);
                    cur_sa = sa;
                }
                let e = dict.entry(sb).or_default().entry(hap).or_insert(0);
                if cnt > *e { *e = cnt; }
            }
            flush!(cur_sa);
            if prof { t_write += tw.elapsed(); }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        e_rid += ke;
        rows_written += n_edges;
        per_layer[lw] = n_edges;
    }
    if prof {
        eprintln!("[emit_core] hapmult_edge_disk: rep+uk={:.1}s stream+write={:.1}s rows={}",
                  secs(t_rep), secs(t_write), rows_written);
    }
    Ok((rows_written, per_layer))
}

/// §8.55 edge_contig_cov の層別発行(surgical)。base 超辺 uk(emit_edges と同一)で edge_rowid を整合させ、
/// incidence(si,di,egid)から (超辺,contig) を集約して blob 書込。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, en_i, en_j, uniq_leaf, si, di, egid,
                    birth, fp, contig2hap, c, start, maxlayer, n, spatial_order=None))]
fn emit_edge_contig_cov_layers<'py>(
    _py: Python<'py>,
    db_path: String,
    en_i: PyReadonlyArray1<'py, i64>,
    en_j: PyReadonlyArray1<'py, i64>,
    uniq_leaf: PyReadonlyArray1<'py, i64>,
    si: PyReadonlyArray1<'py, i32>,
    di: PyReadonlyArray1<'py, i32>,
    egid: PyReadonlyArray1<'py, i64>,
    birth: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    contig2hap: PyReadonlyArray1<'py, i64>,
    c: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードの空間順(Hilbert)。エッジ rowid を端点の空間順位で採番するのに使う。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let en_i = en_i.as_slice().map_err(m)?;
    let en_j = en_j.as_slice().map_err(m)?;
    let uniq_leaf = uniq_leaf.as_slice().map_err(m)?;
    let si = si.as_slice().map_err(m)?;
    let di = di.as_slice().map_err(m)?;
    let egid = egid.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    let c2h = contig2hap.as_slice().map_err(m)?; // A-2 hap-breadth 用(空 slice なら hb=-1)

    let ne = en_i.len();
    let u = uniq_leaf.len();
    let inc = si.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let mut e_rid: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut uk: Vec<i64> = Vec::new();
    let mut vis_of = vec![0i64; u];
    let mut comb: Vec<i64> = Vec::new();
    let mut blob: Vec<u8> = Vec::new();
    let prof = profile_on();
    let (mut t_repat, mut t_sort, mut t_write) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    // 空間順位（None なら従来どおり uk の生キー順＝木インデックス順）
    let _srank = srank_of(
        match &spatial_order {
            Some(a) => Some(a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?),
            None => None,
        },
        n as usize,
    );
    for l in start..=maxlayer {
        let lw = l - start;
        // base 超辺 uk(emit_edges と同一の集合・順序)。
        let tr = Instant::now();
        uk.clear();
        for e in 0..ne {
            let ga = rep_at(en_i[e], l, birth, fp);
            let gb = rep_at(en_j[e], l, birth, fp);
            if ga == gb {
                continue;
            }
            let (lo, hi) = if ga < gb { (ga, gb) } else { (gb, ga) };
            uk.push(lo * n + hi);
        }
        if prof { t_repat += tr.elapsed(); }
        if uk.is_empty() {
            continue;
        }
        let ts = Instant::now();
        uk.sort_unstable();
        uk.dedup();
        // エッジ rowid を **端点の空間順**に写す（uk 自体は binary_search のため生キー昇順のまま）
        let erank = edge_spatial_rank(&uk, n, _srank.as_deref());
        if prof { t_sort += ts.elapsed(); }
        let ke = uk.len() as i64;

        // incidence 超辺の代表化 → comb=(超辺*C+contig)
        let tr2 = Instant::now();
        for j in 0..u {
            vis_of[j] = rep_at(uniq_leaf[j], l, birth, fp);
        }
        if prof { t_repat += tr2.elapsed(); }
        let ts2 = Instant::now();
        comb.clear();
        for i in 0..inc {
            let vs = vis_of[si[i] as usize];
            let vd = vis_of[di[i] as usize];
            if vs == vd {
                continue;
            }
            let (lo, hi) = if vs < vd { (vs, vd) } else { (vd, vs) };
            comb.push((lo * n + hi) * c + egid[i]);
        }
        comb.sort_unstable();
        comb.dedup();
        if prof { t_sort += ts2.elapsed(); }

        let tw = Instant::now();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_edges: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO edge_contig_cov(edge_rowid,blob,hb) VALUES(?1,?2,?3)")
                .map_err(|e| sqlite_err("prep ecc", e))?;
            // comb 昇順 = (超辺,contig) 昇順。super-edge の uk 内 index(=edge local)も超辺昇順で単調 → 単一パス。
            let mut cur_idx: i64 = -1;
            let mut contigs: Vec<u32> = Vec::new();
            let mut i = 0usize;
            while i < comb.len() {
                let ek = comb[i] / c; // 超辺 key
                let ec = (comb[i] % c) as u32;
                i += 1;
                // uk 内で ek を二分探索(np.searchsorted + uk[idx]==ek に一致)
                match uk.binary_search(&ek) {
                    Ok(pos) => {
                        let idx = pos as i64;
                        if idx != cur_idx {
                            if cur_idx >= 0 && !contigs.is_empty() {
                                push_contig_blob(&mut blob, &contigs, None);
                                ins.execute(params![e_rid + 1 + erank[cur_idx as usize], blob.as_slice(),
                                                    hap_breadth(&contigs, c2h)])
                                    .map_err(|e| sqlite_err("ins ecc", e))?;
                                n_edges += 1;
                            }
                            cur_idx = idx;
                            contigs.clear();
                        }
                        contigs.push(ec);
                    }
                    Err(_) => continue, // uk に無い超辺(valid=False)
                }
            }
            if cur_idx >= 0 && !contigs.is_empty() {
                push_contig_blob(&mut blob, &contigs, None);
                ins.execute(params![e_rid + 1 + erank[cur_idx as usize], blob.as_slice(),
                                    hap_breadth(&contigs, c2h)])
                    .map_err(|e| sqlite_err("ins ecc", e))?;
                n_edges += 1;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        if prof { t_write += tw.elapsed(); }
        e_rid += ke;
        rows_written += n_edges;
        per_layer[lw as usize] = n_edges;
    }
    if prof {
        eprintln!(
            "[emit_core] emit_edge_contig_cov: repat={:.1}s sort={:.1}s write(sqlite+blob)={:.1}s rows={}",
            secs(t_repat), secs(t_sort), secs(t_write), rows_written
        );
    }
    Ok((rows_written, per_layer))
}

/// §A-2 通過多重度(per-haplotype コピー数) node_hap_mult の層別発行。emit_contig_inv_layers と同型の
/// climb/森集約だが reducer が **max**(配下葉の per-hap copy の最大)で、逆位の「分数」でなく素の cn を格納。
/// **present な全 hap(cn≥1)を格納**(逆位の q>0 疎格納と異なる)、かつ **葉(kind 0)＋flubble(kind 2)ノードのみ**
/// (クラスタ kind 1 は除外)。Python 側が (leaf,hap)→cnt(clamp≤255)まで済ませ (uniq_leaf,leaf_idx,hap,cnt) を渡す。
/// blob=[u32 count][count×u32 hap_id 昇順][count×u8 cn]。node_contig_cov/inv と同 rowid 規約。出力は Python 版と bit 一致。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, uniq_leaf, leaf_idx_inc, hap_inc, cnt_inc,
                    kind, birth, death, fp, h, start, maxlayer, n, spatial_order))]
fn emit_hap_mult_node_layers<'py>(
    _py: Python<'py>,
    db_path: String,
    uniq_leaf: PyReadonlyArray1<'py, i64>,
    leaf_idx_inc: PyReadonlyArray1<'py, i64>,
    hap_inc: PyReadonlyArray1<'py, i64>,
    cnt_inc: PyReadonlyArray1<'py, i64>,
    kind: PyReadonlyArray1<'py, u8>,
    birth: PyReadonlyArray1<'py, i64>,
    death: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    h: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードを空間順(Hilbert)に並べた大域インデックス列。層内の採番順＝rowid 順になり、
    // ビューポート内の rowid が連続する。None は従来どおり木のインデックス順（後方互換）。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let uniq_leaf = uniq_leaf.as_slice().map_err(m)?;
    let leaf_idx_inc = leaf_idx_inc.as_slice().map_err(m)?;
    let hap_inc = hap_inc.as_slice().map_err(m)?;
    let cnt_inc = cnt_inc.as_slice().map_err(m)?;
    let kind = kind.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let death = death.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;

    let u = uniq_leaf.len();
    let inc = leaf_idx_inc.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let nn = n as usize;
    let _ord_vec = match &spatial_order {
        Some(a) => a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?.to_vec(),
        None => Vec::new(),
    };
    let ord_ref: Option<&[i64]> = if _ord_vec.is_empty() { None } else { Some(&_ord_vec) };
    let mut posmap = vec![-1i64; nn]; // node -> local(P 内位置)。層末に p_list 分だけ戻す。
    let mut p_list: Vec<usize> = Vec::new();
    let mut rep_u = vec![0i64; u];
    let mut keyw: Vec<(i64, i64)> = Vec::with_capacity(inc); // (key=vis*H+hap, cnt)
    let mut rid_base: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut blob: Vec<u8> = Vec::new();
    let prof = profile_on();
    let (mut t_repat, mut t_sort, mut t_write) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    for l in start..=maxlayer {
        let lw = l - start;
        let ts0 = Instant::now();
        let k = build_layer_set(l, nn, birth, death, ord_ref, &mut posmap, &mut p_list);
        if prof { t_sort += ts0.elapsed(); }
        let tr = Instant::now();
        for j in 0..u {
            rep_u[j] = rep_at(uniq_leaf[j], l, birth, fp);
        }
        if prof { t_repat += tr.elapsed(); }
        // incidence -> (key=vis*H+hap, cnt)。sort+run で (vis,hap) を max 集約。
        let ts = Instant::now();
        keyw.clear();
        for i in 0..inc {
            let vis = rep_u[leaf_idx_inc[i] as usize];
            let nl = if vis >= 0 { posmap[vis as usize] } else { -1 };
            if nl < 0 { continue; }
            keyw.push((nl * h + hap_inc[i], cnt_inc[i]));
        }
        keyw.sort_unstable_by_key(|&(kk, _)| kk);
        if prof { t_sort += ts.elapsed(); }

        let tw = Instant::now();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_nodes: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO node_hap_mult(node_rowid,blob) VALUES(?1,?2)")
                .map_err(|e| sqlite_err("prep nhm", e))?;
            // key 昇順 = (vis,hap) 昇順。posmap 単射 → vis 変化で node flush = 単一パス。hap は node 内昇順。
            let mut cur_node: i64 = -1;
            let mut haps: Vec<u32> = Vec::new();
            let mut cns: Vec<u8> = Vec::new();
            let mut i = 0usize;
            while i < keyw.len() {
                let key = keyw[i].0;
                let mut mx: i64 = 0;
                while i < keyw.len() && keyw[i].0 == key {
                    if keyw[i].1 > mx { mx = keyw[i].1; }
                    i += 1;
                }
                let nl = key / h;
                let vis = p_list[nl as usize];
                if nl < 0 {
                    continue; // 層 P 外(防御的)
                }
                let kd = kind[vis];
                if kd != 0 && kd != 2 {
                    continue; // クラスタ(kind 1)除外。葉(0)/flubble(2)のみ
                }
                let hap = (key % h) as u32;
                let cn = mx.clamp(0, 255) as u8; // cnt_inc は Python で clamp 済(念のため)
                if nl != cur_node {
                    if cur_node >= 0 && !haps.is_empty() {
                        push_contig_blob(&mut blob, &haps, Some(&cns));
                        ins.execute(params![rid_base + 1 + cur_node, blob.as_slice()])
                            .map_err(|e| sqlite_err("ins nhm", e))?;
                        n_nodes += 1;
                    }
                    cur_node = nl;
                    haps.clear();
                    cns.clear();
                }
                haps.push(hap);
                cns.push(cn);
            }
            if cur_node >= 0 && !haps.is_empty() {
                push_contig_blob(&mut blob, &haps, Some(&cns));
                ins.execute(params![rid_base + 1 + cur_node, blob.as_slice()])
                    .map_err(|e| sqlite_err("ins nhm", e))?;
                n_nodes += 1;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        if prof { t_write += tw.elapsed(); }
        for &v in &p_list {
            posmap[v] = -1;
        }
        rid_base += k;
        rows_written += n_nodes;
        per_layer[lw as usize] = n_nodes;
    }
    if prof {
        eprintln!(
            "[emit_core] emit_hap_mult_node: repat={:.1}s Pbuild+keyw+sort={:.1}s write={:.1}s rows={}",
            secs(t_repat), secs(t_sort), secs(t_write), rows_written
        );
    }
    Ok((rows_written, per_layer))
}

/// §A-2 通過多重度 edge_hap_mult の層別発行。emit_edge_contig_cov_layers と同型の super-edge 機構だが、
/// (super-edge, hap) ごとに **max** copy を取り、**cn>1 のみ疎格納**(DB 用意・当面表示なし)。Python 側が
/// (eg_edge=lo*n+hi, eg_hap, eg_cnt(clamp≤255)) と端点集合 uniq_ep(+si,di)まで済ませて渡す。
/// blob=[u32 count][count×u32 hap_id 昇順][count×u8 cn]。edge_rowid は edge_contig_cov と同一規約。出力は Python 版と bit 一致。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, en_i, en_j, uniq_ep, si, di, hap_inc, cnt_inc,
                    birth, fp, h, start, maxlayer, n, spatial_order=None))]
fn emit_hap_mult_edge_layers<'py>(
    _py: Python<'py>,
    db_path: String,
    en_i: PyReadonlyArray1<'py, i64>,
    en_j: PyReadonlyArray1<'py, i64>,
    uniq_ep: PyReadonlyArray1<'py, i64>,
    si: PyReadonlyArray1<'py, i32>,
    di: PyReadonlyArray1<'py, i32>,
    hap_inc: PyReadonlyArray1<'py, i64>,
    cnt_inc: PyReadonlyArray1<'py, i64>,
    birth: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    h: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードの空間順(Hilbert)。エッジ rowid を端点の空間順位で採番するのに使う。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let en_i = en_i.as_slice().map_err(m)?;
    let en_j = en_j.as_slice().map_err(m)?;
    let uniq_ep = uniq_ep.as_slice().map_err(m)?;
    let si = si.as_slice().map_err(m)?;
    let di = di.as_slice().map_err(m)?;
    let hap_inc = hap_inc.as_slice().map_err(m)?;
    let cnt_inc = cnt_inc.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;

    let ne = en_i.len();
    let u = uniq_ep.len();
    let inc = si.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;

    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let mut e_rid: i64 = 0;
    let mut rows_written: i64 = 0;
    let mut uk: Vec<i64> = Vec::new();
    let mut vis_of = vec![0i64; u];
    // key=(superedge)*H+hap を i128 で持つ: superedge=lo*n+hi は ntree²<2^63 で i64 に収まるが、
    // ×H(hap 数, 最大 ~数千)で 2^63 を超えうる(WG×大H)。i128(上限 1.7e38)で溢れを防ぐ。
    let mut comb: Vec<(i128, i64)> = Vec::new(); // (key=superedge*H+hap [i128], cnt)
    let mut blob: Vec<u8> = Vec::new();
    let prof = profile_on();
    let (mut t_repat, mut t_sort, mut t_write) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);

    // 空間順位（None なら従来どおり uk の生キー順＝木インデックス順）
    let _srank = srank_of(
        match &spatial_order {
            Some(a) => Some(a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?),
            None => None,
        },
        n as usize,
    );
    for l in start..=maxlayer {
        let lw = l - start;
        // base 超辺 uk(emit_edge_contig_cov_layers と同一の集合・順序)。
        let tr = Instant::now();
        uk.clear();
        for e in 0..ne {
            let ga = rep_at(en_i[e], l, birth, fp);
            let gb = rep_at(en_j[e], l, birth, fp);
            if ga == gb {
                continue;
            }
            let (lo, hi) = if ga < gb { (ga, gb) } else { (gb, ga) };
            uk.push(lo * n + hi);
        }
        if prof { t_repat += tr.elapsed(); }
        if uk.is_empty() {
            continue;
        }
        let ts = Instant::now();
        uk.sort_unstable();
        uk.dedup();
        // エッジ rowid を **端点の空間順**に写す（uk 自体は binary_search のため生キー昇順のまま）
        let erank = edge_spatial_rank(&uk, n, _srank.as_deref());
        if prof { t_sort += ts.elapsed(); }
        let ke = uk.len() as i64;

        // incidence 超辺の代表化 → comb=(superedge*H+hap, cnt)。sort+run で max 集約。
        let tr2 = Instant::now();
        for j in 0..u {
            vis_of[j] = rep_at(uniq_ep[j], l, birth, fp);
        }
        if prof { t_repat += tr2.elapsed(); }
        let ts2 = Instant::now();
        comb.clear();
        for i in 0..inc {
            let vs = vis_of[si[i] as usize];
            let vd = vis_of[di[i] as usize];
            if vs == vd {
                continue;
            }
            let (lo, hi) = if vs < vd { (vs, vd) } else { (vd, vs) };
            // lo*n+hi は i64 で安全(< ntree²)→ i128 に上げて *h(溢れ防止)。
            comb.push(((lo * n + hi) as i128 * h as i128 + hap_inc[i] as i128, cnt_inc[i]));
        }
        comb.sort_unstable_by_key(|&(kk, _)| kk);
        if prof { t_sort += ts2.elapsed(); }

        let tw = Instant::now();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_edges: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO edge_hap_mult(edge_rowid,blob) VALUES(?1,?2)")
                .map_err(|e| sqlite_err("prep ehm", e))?;
            // key 昇順 = (superedge,hap) 昇順。uk 昇順 → uk_index も superedge 昇順で単調 → 単一パス。
            let mut cur_idx: i64 = -1;
            let mut haps: Vec<u32> = Vec::new();
            let mut cns: Vec<u8> = Vec::new();
            let h128 = h as i128;
            let mut i = 0usize;
            while i < comb.len() {
                let key = comb[i].0;
                let mut mx: i64 = 0;
                while i < comb.len() && comb[i].0 == key {
                    if comb[i].1 > mx { mx = comb[i].1; }
                    i += 1;
                }
                if mx <= 1 {
                    continue; // cn>1 のみ疎格納(Python valid=(mx>1) と一致)
                }
                let superedge = (key / h128) as i64;     // lo*n+hi(i64 に収まる)
                let idx = match uk.binary_search(&superedge) {
                    Ok(pos) => pos as i64,
                    Err(_) => continue, // uk に無い超辺(valid=False)
                };
                let hap = (key % h128) as u32;
                let cn = mx.clamp(0, 255) as u8;
                if idx != cur_idx {
                    if cur_idx >= 0 && !haps.is_empty() {
                        push_contig_blob(&mut blob, &haps, Some(&cns));
                        ins.execute(params![e_rid + 1 + erank[cur_idx as usize], blob.as_slice()])
                            .map_err(|e| sqlite_err("ins ehm", e))?;
                        n_edges += 1;
                    }
                    cur_idx = idx;
                    haps.clear();
                    cns.clear();
                }
                haps.push(hap);
                cns.push(cn);
            }
            if cur_idx >= 0 && !haps.is_empty() {
                push_contig_blob(&mut blob, &haps, Some(&cns));
                ins.execute(params![e_rid + 1 + erank[cur_idx as usize], blob.as_slice()])
                    .map_err(|e| sqlite_err("ins ehm", e))?;
                n_edges += 1;
            }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        if prof { t_write += tw.elapsed(); }
        e_rid += ke;
        rows_written += n_edges;
        per_layer[lw as usize] = n_edges;
    }
    if prof {
        eprintln!(
            "[emit_core] emit_hap_mult_edge: repat={:.1}s sort={:.1}s write={:.1}s rows={}",
            secs(t_repat), secs(t_sort), secs(t_write), rows_written
        );
    }
    Ok((rows_written, per_layer))
}

// ==========================================================================
// disk-streaming edge_contig_cov(WG 巨大 incidence 用)。RAM=O(node+edge)。
//   入力 run_files = «canonical leaf pair (a<b) + contig» を 2 列 (hi=a, lo=b*C+contig) で
//   sorted-unique 化した binary 列。a<b と rep 単調性から rep(a,L) <= rep(b,L) が保証され、
//   super-edge (Sa,Sb)(Sa<=Sb)は «小さい側 Sa のブロックからのみ» 寄与される(無向重複が生じない)。
//   → (a) 昇順に流し «Sa が変わったら flush» の単一パスで、内側 dict{Sb: contig集合} を集約。
//   per-layer の rep は rep_arr[v]=(birth<=L? v : rep_arr[parent]) を topo 順に O(n) 前計算
//   (rep_at と厳密同値=birth-only)。uk(base 超辺)は emit_edge_contig_cov_layers と同一。
//   出力(edge_rowid=e_rid+1+uk_index, blob=sorted contig ids)は in-RAM 版と厳密同一。
// ==========================================================================

/// (hi,lo) 2 列 run を k-way マージし unique(hi,lo)へ(集合; bp 合算でない)。
fn merge_runs_uniq(run_files: &[String], merged_path: &str) -> std::io::Result<i64> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use std::io::Write;
    let mut readers: Vec<PairFile> = Vec::with_capacity(run_files.len());
    for p in run_files {
        readers.push(PairFile::open(p)?);
    }
    let mut heap: BinaryHeap<Reverse<(i64, i64, usize)>> = BinaryHeap::new();
    for (i, r) in readers.iter_mut().enumerate() {
        if let Some((h, l)) = r.next_pair()? {
            heap.push(Reverse((h, l, i)));
        }
    }
    let mut out = std::io::BufWriter::with_capacity(1 << 22, std::fs::File::create(merged_path)?);
    let (mut ch, mut cl) = (0i64, 0i64);
    let mut have = false;
    let mut nuniq = 0i64;
    while let Some(Reverse((h, l, i))) = heap.pop() {
        if !have || h != ch || l != cl {
            out.write_all(&h.to_le_bytes())?;
            out.write_all(&l.to_le_bytes())?;
            nuniq += 1;
            ch = h;
            cl = l;
            have = true;
        }
        if let Some((h2, l2)) = readers[i].next_pair()? {
            heap.push(Reverse((h2, l2, i)));
        }
    }
    out.flush()?;
    Ok(nuniq)
}

/// disk-streaming 版 edge_contig_cov 発行。RAM=O(node+edge+層別 dict)。emit_edge_contig_cov_layers と結果同一。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (db_path, en_i, en_j, run_files, merged_path, birth, fp, contig2hap, c, start, maxlayer, n, spatial_order=None))]
fn emit_edge_contig_cov_disk<'py>(
    _py: Python<'py>,
    db_path: String,
    en_i: PyReadonlyArray1<'py, i64>,
    en_j: PyReadonlyArray1<'py, i64>,
    run_files: Vec<String>,
    merged_path: String,
    birth: PyReadonlyArray1<'py, i64>,
    fp: PyReadonlyArray1<'py, i64>,
    contig2hap: PyReadonlyArray1<'py, i64>,
    c: i64,
    start: i64,
    maxlayer: i64,
    n: i64,
    // ノードの空間順(Hilbert)。エッジ rowid を端点の空間順位で採番するのに使う。
    spatial_order: Option<PyReadonlyArray1<'py, i64>>,
) -> PyResult<(i64, Vec<i64>)> {
    use std::collections::HashMap;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let en_i = en_i.as_slice().map_err(m)?;
    let en_j = en_j.as_slice().map_err(m)?;
    let birth = birth.as_slice().map_err(m)?;
    let fp = fp.as_slice().map_err(m)?;
    let c2h = contig2hap.as_slice().map_err(m)?; // A-2 hap-breadth 用(空 slice なら hb=-1)
    let ioerr = |ctx: &str, e: std::io::Error| PyRuntimeError::new_err(format!("{ctx}: {e}"));
    let prof = profile_on();

    let t_a = Instant::now();
    let nuniq = merge_runs_uniq(&run_files, &merged_path).map_err(|e| ioerr("merge_runs_uniq", e))?;
    if prof {
        eprintln!("[emit_core] edge_disk: merge {} runs -> I={} ({:.1}s)",
                  run_files.len(), nuniq, secs(t_a.elapsed()));
    }

    let nn = n as usize;
    let ne = en_i.len();
    let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| sqlite_err("open", e))?;
    apply_write_pragmas(&conn)?;
    let nlayers = (maxlayer - start + 1).max(0) as usize;
    let mut per_layer = vec![0i64; nlayers];
    let mut rep_arr = vec![-1i64; nn];
    let mut uk: Vec<i64> = Vec::new();
    let mut blob: Vec<u8> = Vec::new();
    let mut e_rid: i64 = 0;
    let mut rows_written: i64 = 0;
    let (mut t_rep, mut t_write) = (Duration::ZERO, Duration::ZERO);

    // 空間順位（None なら従来どおり uk の生キー順＝木インデックス順）
    let _srank = srank_of(
        match &spatial_order {
            Some(a) => Some(a.as_slice().map_err(|e| PyRuntimeError::new_err(e.to_string()))?),
            None => None,
        },
        n as usize,
    );
    for l in start..=maxlayer {
        let lw = (l - start) as usize;
        // rep_arr[v] = birth<=L なら v、さもなくば親の rep(topo: parent<v で前進計算)= rep_at 同値。
        let tr = Instant::now();
        for v in 0..nn {
            let b = birth[v];
            rep_arr[v] = if b >= 0 && b <= l {
                v as i64
            } else {
                let p = fp[v];
                if p >= 0 { rep_arr[p as usize] } else { -1 }
            };
        }
        // uk: base 超辺(emit_edges/emit_edge_contig_cov_layers と同一集合・順序)
        uk.clear();
        for e in 0..ne {
            let ga = rep_arr[en_i[e] as usize];
            let gb = rep_arr[en_j[e] as usize];
            if ga < 0 || gb < 0 || ga == gb {
                continue;
            }
            let (lo, hi) = if ga < gb { (ga, gb) } else { (gb, ga) };
            uk.push(lo * n + hi);
        }
        if prof { t_rep += tr.elapsed(); }
        if uk.is_empty() {
            continue; // ke=0(e_rid 不変)
        }
        uk.sort_unstable();
        uk.dedup();
        // エッジ rowid を **端点の空間順**に写す（uk 自体は binary_search のため生キー昇順のまま）
        let erank = edge_spatial_rank(&uk, n, _srank.as_deref());
        let ke = uk.len() as i64;

        // merged を1回流し Sa-flush で集約。
        let mut rd = PairFile::open(&merged_path).map_err(|e| ioerr("open merged", e))?;
        let mut cur_sa: i64 = -1;
        let mut dict: HashMap<i64, Vec<u32>> = HashMap::new();
        let tx = conn.transaction().map_err(|e| sqlite_err("begin", e))?;
        let mut n_edges: i64 = 0;
        {
            let mut ins = tx
                .prepare("INSERT INTO edge_contig_cov(edge_rowid,blob,hb) VALUES(?1,?2,?3)")
                .map_err(|e| sqlite_err("prep ecc", e))?;
            macro_rules! flush {
                ($sa:expr) => {{
                    let sa = $sa;
                    if sa >= 0 {
                        for (sb, contigs) in dict.iter_mut() {
                            let superkey = sa * n + *sb; // sa <= sb(canonical + rep 単調)
                            if let Ok(pos) = uk.binary_search(&superkey) {
                                contigs.sort_unstable();
                                contigs.dedup();
                                push_contig_blob(&mut blob, contigs, None);
                                ins.execute(params![e_rid + 1 + erank[pos], blob.as_slice(),
                                                    hap_breadth(contigs, c2h)])
                                    .map_err(|e| sqlite_err("ins ecc", e))?;
                                n_edges += 1;
                            }
                        }
                    }
                    dict.clear();
                }};
            }
            let tw = Instant::now();
            loop {
                let (a, lo) = match rd.next_pair().map_err(|e| ioerr("read merged", e))? {
                    Some(x) => x,
                    None => break,
                };
                let b = lo / c;
                let contig = (lo % c) as u32;
                let sa = rep_arr[a as usize];
                let sb = rep_arr[b as usize];
                if sa < 0 || sb < 0 || sa == sb {
                    continue;
                }
                if sa != cur_sa {
                    flush!(cur_sa);
                    cur_sa = sa;
                }
                dict.entry(sb).or_default().push(contig);
            }
            flush!(cur_sa);
            if prof { t_write += tw.elapsed(); }
        }
        tx.commit().map_err(|e| sqlite_err("commit", e))?;
        e_rid += ke;
        rows_written += n_edges;
        per_layer[lw] = n_edges;
    }
    if prof {
        eprintln!("[emit_core] edge_disk: rep+uk={:.1}s stream+write={:.1}s rows={}",
                  secs(t_rep), secs(t_write), rows_written);
    }
    Ok((rows_written, per_layer))
}

/// separate 崩壊アレル分離の step3(パス走査)を Rust core で。
/// Python の純ループ(`for k,j in enumerate(seq)`, WG で数十億ステップ=律速)を置換する。
/// 入力(すべて dense/元 id 空間で一貫):
///   tok       : 全 path token を連結した配列(dense id)。distill の p_tok(memmap int32)をそのまま渡せる。
///   off       : [P+1] 各 path の token CSR オフセット。
///   id2idx    : [max_id+1] id -> node index(0..N-1)。無効 id は -1(Python の searchsorted+valid と同値)。
///   bub_of_node: [N] node -> bubble id(バブルでないノードは -1)。
///   rank_of_node: [N] node -> allele rank(バブルノードのみ有効, 他は -1)。
///   k2        : [nb] バブルがちょうど 2 アレルなら 1(符号付き隣接の条件)。
///   nb, n     : バブル数 / ノード数 N(prev*n+next のパッキング用)。
/// 出力:
///   b_entry/b_exit : [nb] orient_vote の argmax(entry,exit) の node index(投票が無ければ -1)。
///   b_hasvote      : [nb] 投票があったか(0/1)。Python は 0 のとき bnd 境界にフォールバック。
///   e_bi/e_bj/e_same/e_diff : 符号付き隣接 edge_sign を配列化(Python が (-w,bi,bj) で再ソートするため順序不問)。
/// bit 一致の要点: orient argmax のタイブレークは Python dict の「最初に挿入された最大票」に一致させる
/// (挿入順を order で記録し、同票なら最小 order を採用)。走査順(path 順・token 順)は Python と同一。
#[allow(clippy::too_many_arguments)]
#[pyfunction]
#[pyo3(signature = (tok, off, id2idx, bub_of_node, rank_of_node, k2, nb, n))]
fn separate_path_scan<'py>(
    py: Python<'py>,
    tok: PyReadonlyArray1<'py, i32>,
    off: PyReadonlyArray1<'py, i64>,
    id2idx: PyReadonlyArray1<'py, i32>,
    bub_of_node: PyReadonlyArray1<'py, i32>,
    rank_of_node: PyReadonlyArray1<'py, i8>,
    k2: PyReadonlyArray1<'py, u8>,
    nb: i64,
    n: i64,
) -> PyResult<(
    Bound<'py, numpy::PyArray1<i64>>, // b_entry
    Bound<'py, numpy::PyArray1<i64>>, // b_exit
    Bound<'py, numpy::PyArray1<u8>>,  // b_hasvote
    Bound<'py, numpy::PyArray1<i32>>, // e_bi
    Bound<'py, numpy::PyArray1<i32>>, // e_bj
    Bound<'py, numpy::PyArray1<i64>>, // e_same
    Bound<'py, numpy::PyArray1<i64>>, // e_diff
)> {
    use numpy::IntoPyArray;
    use std::collections::HashMap;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let tok = tok.as_slice().map_err(m)?;
    let off = off.as_slice().map_err(m)?;
    let id2idx = id2idx.as_slice().map_err(m)?;
    let bub_of_node = bub_of_node.as_slice().map_err(m)?;
    let rank_of_node = rank_of_node.as_slice().map_err(m)?;
    let k2 = k2.as_slice().map_err(m)?;
    let nb = nb as usize;
    let np_paths = off.len().saturating_sub(1);
    let id2len = id2idx.len();
    let prof = profile_on();
    let t0 = Instant::now();

    // orient_vote: (bid, prev*n+next) -> (count, first_insert_order)。挿入順タイブレーク用に order を保持。
    let mut orient: HashMap<(i32, i64), (i64, i64)> = HashMap::new();
    // edge_sign: (lo_bid, hi_bid) -> (want_same, want_diff)
    let mut esign: HashMap<(i32, i32), (i64, i64)> = HashMap::new();
    let mut order_counter: i64 = 0;
    let mut seq: Vec<i64> = Vec::new(); // path ごとに再利用する有効 index 列

    for k in 0..np_paths {
        let a = off[k] as usize;
        let b = off[k + 1] as usize;
        // 有効 token を index へ写して seq を作る(Python: idx[valid].tolist() と同値)。
        seq.clear();
        for t in a..b {
            let raw = tok[t];
            let idx = if raw >= 0 && (raw as usize) < id2len {
                id2idx[raw as usize]
            } else {
                -1
            };
            if idx >= 0 {
                seq.push(idx as i64);
            }
        }
        let ml = seq.len();
        if ml < 2 {
            continue;
        }
        let mut prev_bid: i64 = -1; // None
        let mut prev_rank: i64 = -1;
        for pos in 0..ml {
            let j = seq[pos] as usize;
            let bid = bub_of_node[j];
            if bid < 0 {
                continue;
            }
            let rank_r = rank_of_node[j] as i64;
            // orient vote(パス中間のみ)
            if pos > 0 && pos < ml - 1 {
                let prev = seq[pos - 1];
                let next = seq[pos + 1];
                let key = (bid, prev * n + next);
                let ent = orient.entry(key).or_insert_with(|| {
                    let o = order_counter;
                    order_counter += 1;
                    (0i64, o)
                });
                ent.0 += 1;
            }
            // 符号付き隣接(2アレルバブル同士のみ)
            if k2[bid as usize] == 1 && prev_bid >= 0 {
                let pb = prev_bid as i32;
                if pb != bid && k2[pb as usize] == 1 {
                    let same = rank_r == prev_rank;
                    let (lo, hi) = if bid < pb { (bid, pb) } else { (pb, bid) };
                    let e = esign.entry((lo, hi)).or_insert((0i64, 0i64));
                    if same {
                        e.0 += 1;
                    } else {
                        e.1 += 1;
                    }
                }
            }
            prev_bid = bid as i64;
            prev_rank = rank_r;
        }
    }
    if prof {
        eprintln!(
            "[emit_core] separate_path_scan: walk paths={} orient_keys={} esign_keys={} {:.1}s",
            np_paths, orient.len(), esign.len(), secs(t0.elapsed())
        );
    }

    // orient -> per-bubble argmax(最大票; 同票は最小挿入 order = Python dict 先勝ちに一致)。
    let mut b_entry = vec![-1i64; nb];
    let mut b_exit = vec![-1i64; nb];
    let mut b_hasvote = vec![0u8; nb];
    let mut best_cnt = vec![-1i64; nb];
    let mut best_ord = vec![i64::MAX; nb];
    for (&(bid, packed), &(cnt, ord)) in orient.iter() {
        let bi = bid as usize;
        if cnt > best_cnt[bi] || (cnt == best_cnt[bi] && ord < best_ord[bi]) {
            best_cnt[bi] = cnt;
            best_ord[bi] = ord;
            b_entry[bi] = packed / n;
            b_exit[bi] = packed % n;
            b_hasvote[bi] = 1;
        }
    }

    // edge_sign -> 配列(順序不問; Python が (-w,bi,bj) で再ソート)。
    let ne = esign.len();
    let mut e_bi = Vec::with_capacity(ne);
    let mut e_bj = Vec::with_capacity(ne);
    let mut e_same = Vec::with_capacity(ne);
    let mut e_diff = Vec::with_capacity(ne);
    for (&(lo, hi), &(same, diff)) in esign.iter() {
        e_bi.push(lo);
        e_bj.push(hi);
        e_same.push(same);
        e_diff.push(diff);
    }

    Ok((
        b_entry.into_pyarray_bound(py),
        b_exit.into_pyarray_bound(py),
        b_hasvote.into_pyarray_bound(py),
        e_bi.into_pyarray_bound(py),
        e_bj.into_pyarray_bound(py),
        e_same.into_pyarray_bound(py),
        e_diff.into_pyarray_bound(py),
    ))
}

// ==========================================================================
// increment: incidence dedup。ribbon の (leaf,contig) 合算 / edge 三つ組 unique の畳み込みを
// Python の streaming(_stream_unique_sum / _stream_unique_triples / _TripleAccum)の各 merge から
// 呼ぶ stateless 関数群。numpy の np.unique(return_inverse) は入力の ~5 倍の一時
// (argsort/sorted/mask/cumsum/inverse)を確保し WG(unique~19億)で OOM する。ここでは
// 「未処理 buffer を sort+集約 → 既 sorted-unique な run と 2-way マージ」で一時を ~2 倍に抑える
// (run は Python 側が numpy で保持=言語跨ぎのコピー最小)。集合/整数和は結合的・順序非依存なので
// numpy 経路と «同じ昇順 sorted-unique» を返す(結果は厳密同一)。
// ==========================================================================

/// 生 buffer(重複可)を key 昇順に並べ同一 key の w を合算 → sorted-unique (uk, uw)。
fn sort_agg_sum(bk: &[i64], bw: &[i64]) -> (Vec<i64>, Vec<i64>) {
    let n = bk.len();
    let mut p: Vec<(i64, i64)> = (0..n).map(|i| (bk[i], bw[i])).collect();
    p.sort_unstable_by_key(|x| x.0);
    let mut uk = Vec::new();
    let mut uw = Vec::new();
    let mut i = 0usize;
    while i < n {
        let k = p[i].0;
        let mut s = 0i64;
        while i < n && p[i].0 == k {
            s += p[i].1;
            i += 1;
        }
        uk.push(k);
        uw.push(s);
    }
    (uk, uw)
}

/// 2 つの sorted-unique (key,w) を 2-way マージし同一 key の w を合算。
fn merge_sum(ak: &[i64], aw: &[i64], bk: &[i64], bw: &[i64]) -> (Vec<i64>, Vec<i64>) {
    let mut ok = Vec::with_capacity(ak.len() + bk.len());
    let mut ow = Vec::with_capacity(ak.len() + bk.len());
    let (mut i, mut j) = (0usize, 0usize);
    while i < ak.len() && j < bk.len() {
        if ak[i] < bk[j] {
            ok.push(ak[i]); ow.push(aw[i]); i += 1;
        } else if ak[i] > bk[j] {
            ok.push(bk[j]); ow.push(bw[j]); j += 1;
        } else {
            ok.push(ak[i]); ow.push(aw[i] + bw[j]); i += 1; j += 1;
        }
    }
    while i < ak.len() { ok.push(ak[i]); ow.push(aw[i]); i += 1; }
    while j < bk.len() { ok.push(bk[j]); ow.push(bw[j]); j += 1; }
    (ok, ow)
}

/// node incidence: sorted-unique run(rk,rw) に 生 buffer(bk,bw)を合算マージ → 新 sorted-unique。
/// run 空(初回)は rk.len()==0 を渡す。_stream_unique_sum の merge() 置換。
#[pyfunction]
fn dedup_merge_sum<'py>(
    py: Python<'py>,
    run_k: PyReadonlyArray1<'py, i64>,
    run_w: PyReadonlyArray1<'py, i64>,
    buf_k: PyReadonlyArray1<'py, i64>,
    buf_w: PyReadonlyArray1<'py, i64>,
) -> PyResult<(Bound<'py, numpy::PyArray1<i64>>, Bound<'py, numpy::PyArray1<i64>>)> {
    use numpy::IntoPyArray;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let (uk, uw) = sort_agg_sum(buf_k.as_slice().map_err(m)?, buf_w.as_slice().map_err(m)?);
    let (ok, ow) = merge_sum(run_k.as_slice().map_err(m)?, run_w.as_slice().map_err(m)?, &uk, &uw);
    Ok((ok.into_pyarray_bound(py), ow.into_pyarray_bound(py)))
}

/// 1D set: 生 buffer を昇順 unique。
fn sort_uniq1(b: &[i64]) -> Vec<i64> {
    let mut v = b.to_vec();
    v.sort_unstable();
    v.dedup();
    v
}
fn merge_uniq1(a: &[i64], b: &[i64]) -> Vec<i64> {
    let mut o = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] < b[j] { o.push(a[i]); i += 1; }
        else if a[i] > b[j] { o.push(b[j]); j += 1; }
        else { o.push(a[i]); i += 1; j += 1; }
    }
    o.extend_from_slice(&a[i..]);
    o.extend_from_slice(&b[j..]);
    o
}

/// edge safe(1D key): sorted-unique run に 生 buffer を集合マージ → 新 sorted-unique。
#[pyfunction]
fn dedup_merge_set1<'py>(
    py: Python<'py>,
    run: PyReadonlyArray1<'py, i64>,
    buf: PyReadonlyArray1<'py, i64>,
) -> PyResult<Bound<'py, numpy::PyArray1<i64>>> {
    use numpy::IntoPyArray;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let u = sort_uniq1(buf.as_slice().map_err(m)?);
    let o = merge_uniq1(run.as_slice().map_err(m)?, &u);
    Ok(o.into_pyarray_bound(py))
}

/// 2col set: 生 buffer(hi,lo)を lexicographic(hi,lo)昇順 unique。
fn sort_uniq2(bh: &[i64], bl: &[i64]) -> (Vec<i64>, Vec<i64>) {
    let n = bh.len();
    let mut p: Vec<(i64, i64)> = (0..n).map(|i| (bh[i], bl[i])).collect();
    p.sort_unstable();
    p.dedup();
    let mut oh = Vec::with_capacity(p.len());
    let mut ol = Vec::with_capacity(p.len());
    for (h, l) in p {
        oh.push(h);
        ol.push(l);
    }
    (oh, ol)
}
fn merge_uniq2(ah: &[i64], al: &[i64], bh: &[i64], bl: &[i64]) -> (Vec<i64>, Vec<i64>) {
    let mut oh = Vec::with_capacity(ah.len() + bh.len());
    let mut ol = Vec::with_capacity(ah.len() + bh.len());
    let (mut i, mut j) = (0usize, 0usize);
    while i < ah.len() && j < bh.len() {
        let ca = (ah[i], al[i]);
        let cb = (bh[j], bl[j]);
        if ca < cb { oh.push(ah[i]); ol.push(al[i]); i += 1; }
        else if ca > cb { oh.push(bh[j]); ol.push(bl[j]); j += 1; }
        else { oh.push(ah[i]); ol.push(al[i]); i += 1; j += 1; }
    }
    while i < ah.len() { oh.push(ah[i]); ol.push(al[i]); i += 1; }
    while j < bh.len() { oh.push(bh[j]); ol.push(bl[j]); j += 1; }
    (oh, ol)
}

/// edge two(2col (hi,lo)): sorted-unique run(rh,rl) に 生 buffer(bh,bl)を集合マージ → 新 sorted-unique。
#[pyfunction]
fn dedup_merge_set2<'py>(
    py: Python<'py>,
    run_hi: PyReadonlyArray1<'py, i64>,
    run_lo: PyReadonlyArray1<'py, i64>,
    buf_hi: PyReadonlyArray1<'py, i64>,
    buf_lo: PyReadonlyArray1<'py, i64>,
) -> PyResult<(Bound<'py, numpy::PyArray1<i64>>, Bound<'py, numpy::PyArray1<i64>>)> {
    use numpy::IntoPyArray;
    let m = |e: numpy::NotContiguousError| PyRuntimeError::new_err(e.to_string());
    let (uh, ul) = sort_uniq2(buf_hi.as_slice().map_err(m)?, buf_lo.as_slice().map_err(m)?);
    let (oh, ol) = merge_uniq2(run_hi.as_slice().map_err(m)?, run_lo.as_slice().map_err(m)?, &uh, &ul);
    Ok((oh.into_pyarray_bound(py), ol.into_pyarray_bound(py)))
}

#[pymodule]
fn emit_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(sum_i64, m)?)?;
    m.add_function(wrap_pyfunction!(probe_sqlite, m)?)?;
    m.add_function(wrap_pyfunction!(emit_edges, m)?)?;
    m.add_function(wrap_pyfunction!(emit_geometry, m)?)?;
    m.add_function(wrap_pyfunction!(emit_nodes, m)?)?;
    m.add_function(wrap_pyfunction!(emit_ribbon_contig_layers, m)?)?;
    m.add_function(wrap_pyfunction!(emit_contig_inv_layers, m)?)?;
    m.add_function(wrap_pyfunction!(emit_contig_inv_disk, m)?)?;
    m.add_function(wrap_pyfunction!(emit_hap_mult_node_layers, m)?)?;
    m.add_function(wrap_pyfunction!(emit_hap_mult_node_disk, m)?)?;
    m.add_function(wrap_pyfunction!(emit_hap_mult_edge_layers, m)?)?;
    m.add_function(wrap_pyfunction!(emit_hap_mult_edge_disk, m)?)?;
    m.add_function(wrap_pyfunction!(emit_edge_contig_cov_layers, m)?)?;
    m.add_function(wrap_pyfunction!(separate_path_scan, m)?)?;
    m.add_function(wrap_pyfunction!(dedup_merge_sum, m)?)?;
    m.add_function(wrap_pyfunction!(dedup_merge_set1, m)?)?;
    m.add_function(wrap_pyfunction!(dedup_merge_set2, m)?)?;
    m.add_function(wrap_pyfunction!(emit_ribbon_contig_disk, m)?)?;
    m.add_function(wrap_pyfunction!(emit_edge_contig_cov_disk, m)?)?;
    Ok(())
}
