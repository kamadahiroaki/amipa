// /nodes 系クエリの共有ヘルパ。
//
// **worker(dbJobs.ts) と routes/graph.ts の両方から使う**ために切り出した。DB 読み取りを
// worker_threads へ出すには同じクエリ組み立てを worker 側でも走らせる必要があるが、
// これらは全て (Database, パラメータ) の純粋関数なのでそのまま共有できる。
// 中身は graph.ts から**無改変で移動**しただけ（コメントも含む）。
import type { SpatialSource } from './spatial'

// テーブルの列名集合を接続単位でメモ化（mapq別 coverage_qN 列の有無判定に使う）。
const colCache = new WeakMap<any, Map<string, Set<string>>>()

/** 表の列名。`schema` を渡すと ATTACH した DB を見る。
 *  ★`PRAGMA table_info(an.node_annot)` は **構文エラー**（near "."）になる。
 *    スキーマ修飾は `PRAGMA an.table_info(node_annot)` と書く必要がある。
 *    以前ここに 'an.node_annot' を渡して 500 を出した（しかも例外を捕まえていなかった）。
 *  表が無い/開けない場合は空集合を返す（呼び側がフォールバックできるように）。 */
export function tableCols(d: any, table: string, schema = ''): Set<string> {
  const key = schema ? `${schema}.${table}` : table
  let m = colCache.get(d)
  if (!m) { m = new Map(); colCache.set(d, m) }
  let s = m.get(key)
  if (!s) {
    const pragma = schema ? `PRAGMA ${schema}.table_info(${table})` : `PRAGMA table_info(${table})`
    try {
      s = new Set((d.prepare(pragma).all() as any[]).map(c => c.name as string))
    } catch { s = new Set<string>() }
    m.set(key, s)
  }
  return s
}

// 指定 mapq プリセットに対応する coverage/cov_hist 列式を返す。
// mapq=0 または該当列が無いDBでは素のベース列（全アライン集計）にフォールバック。
// strata 列を持たないノード（概観層の集約 cc_* ノード等）はベース列へフォールバックする。
// detail 層（layer_index=1）の coverage_qN は「条件を満たすリードが無ければ 0」で埋めてあるので
// COALESCE が誤って素のベース値に戻すことはなく、NULL の集約ノードだけが素通しになる。
export function nodeCovExprs(d: any, mapq: number): { cov: string; hist: string } {
  if (mapq > 0) {
    const cov = `coverage_q${mapq}`, hist = `cov_hist_q${mapq}`
    const cols = tableCols(d, 'nodes')
    if (cols.has(cov) && cols.has(hist))
      return { cov: `COALESCE(n.${cov}, n.coverage)`, hist: `COALESCE(n.${hist}, n.cov_hist)` }
  }
  return { cov: 'n.coverage', hist: 'n.cov_hist' }
}

// cov/hist は mapq プリセットにより列を差し替えるが、別名で coverage/cov_hist に固定するので
// frontend・キャッシュ側のデータ形は不変。
// 参照座標(ref_bp)列がある DB なら node fetch に相乗りさせる（追加往復ゼロ）。無ければ空文字。
// EMITTER_REFPOS_SPEC.md: ref_contig_id/ref_bp/ref_bp_end/is_anchor/ref_multi は nodes の任意列。
export function refPosSel(d: any): string {
  const cols = tableCols(d, 'nodes')
  if (!cols.has('ref_bp')) return ''
  // ref_strand(ref のノード通過向き; 1=+n.a/0=-n.a)は後発列 → 無い旧 DB でも壊れないよう存在時のみ。
  const strand = cols.has('ref_strand') ? ', n.ref_strand' : ''
  return ', n.ref_contig_id, n.ref_bp, n.ref_bp_end, n.is_anchor, n.ref_multi' + strand
}

// comp_id(連結成分ID; backfill_comp_id.py が付与)を node fetch に相乗り。無い旧 DB では空文字。
// viewer は表示層内で同 comp_id ⟺ 同一連結成分（融合）／別 comp_id ⟺ ただ近接、と判定する。
export function compSel(d: any): string {
  return tableCols(d, 'nodes').has('comp_id') ? ', n.comp_id' : ''
}

// kind(0=葉/1=クラスタ G/2=flubble S)。無い旧 DB では空文字(node_name 接頭辞で判別可)。
export function kindSel(d: any): string {
  return tableCols(d, 'nodes').has('kind') ? ', n.kind' : ''
}

// A-2 表示: node の hap-breadth(hb, node_contig_cov.hb=distinct haplotype 数)を node fetch に相乗り。
// hb 列の無い旧 DB では空(=graceful)。LEFT JOIN(全 node が cov 行を持つとは限らない=NULL)。
// (通過多重度は per-haplotype 化＋viewer 表現を再設計中のため node fetch には載せない。node_hap_mult は別途。)
// D2(2026-07-22): want=false なら join を付けない。hb は breadth 表示モードでしか使わないので、
// 非使用時に node_contig_cov への per-node rowid JOIN(WG 巨大表・cold random I/O)を省く。
// hb（hap-breadth）を **太い blob 行を読まずに**取るための被覆索引の有無。
//
// `node_contig_cov(node_rowid PK, blob, hb)` は 1 行 195 B（blob が 186 B）なので、
// hb を rowid 点引きするだけで太い行＝ページ 1 枚を丸ごと読む。WG cold ではこれが効く。
// `(node_rowid, hb)` の被覆索引があれば同じ hb を 13 B/行の索引から取れる。
// 実測（chr22, dbstat）: node_contig_cov 349,219 ページ → 索引 22,968 ページ = **15.2 分の 1**、
// edge_contig_cov 296,094 → 29,645 = **10.0 分の 1**。
//
// ★SQLite は自分では選ばない（rowid シークを最安と見るので `SEARCH ... USING INTEGER PRIMARY KEY`
//   のまま）。**`INDEXED BY` で明示的に強制する**必要がある。
// ★`INDEXED BY` は索引が無いと**エラー**（フォールバックしない）ので、必ず存在確認してから付ける。
const hbIdxCache = new Map<string, boolean>()
/** 索引の有無をキャッシュしつつ `INDEXED BY` 断片を返す（無ければ空文字）。 */
export function indexedByIfExists(d: any, idx: string, schema = 'main'): string {
  const key = (d.name || '') + '|' + schema + '|' + idx
  let has = hbIdxCache.get(key)
  if (has === undefined) {
    try {
      has = !!d.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='index' AND name=?`).get(idx)
    } catch { has = false }
    hbIdxCache.set(key, has)
  }
  return has ? ` INDEXED BY ${idx}` : ''
}

export function hbCoveringIdx(d: any, table: 'node_contig_cov' | 'edge_contig_cov'): string {
  const idx = table === 'node_contig_cov' ? 'idx_ncc_hb' : 'idx_ecc_hb'
  const key = (d.name || '') + '|' + idx
  let has = hbIdxCache.get(key)
  if (has === undefined) {
    try {
      has = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx)
    } catch { has = false }
    hbIdxCache.set(key, has)
  }
  return has ? ` INDEXED BY ${idx}` : ''
}

export function nodeExtraSel(d: any, want: boolean): { sel: string; join: string } {
  if (!want || !tableCols(d, 'node_contig_cov').has('hb')) return { sel: '', join: '' }
  return { sel: ', ncc.hb AS hb',
           join: ` LEFT JOIN node_contig_cov ncc${hbCoveringIdx(d, 'node_contig_cov')}` +
                 ' ON ncc.node_rowid = n.rowid' }
}

// アノテーション(band/gene/region)を node fetch に相乗り。annotate.py が付与する per-node 表
// node_annot(node_rowid PK; band_id/band_multi/region_class/gene_cnt/gene_blob)。無い DB では空(=graceful)。
// coverage(node_contig_cov)と同型で **rowid 相乗り**(別 join 不要)。スカラーのみ載せ、gene 詳細 blob は
// /node_features(選択ノード1件)で扱う。gene_cnt は旧名 gene_count に alias(frontend 無改修)。
// D2: band/region/gene のうち要求された列だけ。全部 false なら node_annot への JOIN を省く
// (band/region/gene 表示モードのいずれも off の通常ブラウジングでは per-node rowid JOIN をしない)。
export function nodeAttrSel(d: any, want: { band: boolean; region: boolean; gene: boolean }): { sel: string; join: string } {
  const srcA = annotSource(d)
  if (!srcA) return { sel: '', join: '' }
  const cols = srcA.cols
  let sel = ''
  if (want.band && cols.has('band_id')) sel += ', na.band_id'
  if (want.region && cols.has('region_class')) sel += ', na.region_class'
  if (want.gene && cols.has('gene_cnt')) sel += ', na.gene_cnt AS gene_count'
  if (!sel) return { sel: '', join: '' }
  return { sel, join: ` LEFT JOIN ${srcA.qual}node_annot na ON na.node_rowid = n.rowid` }
}

// ── アノテーション（band/region/gene）の相乗り ───────────────────────────────
// タイル経路(nx=fast)は nodes 行を読まないので、要求されたときだけ node_annot を id で点引きする。
//   実測(chr22, cold): 被覆索引 idx_na_cov ありで典型 0.2〜35ms・最悪 153ms。
//   索引が無いと同じ問い合わせが 2,256ms(269倍)になるので、索引の有無は必ず見る
//   （gene_blob が平均 51B あり、スカラ 3 つのために太い行を読むことになるため）。
/** node_annot の所在を返す。サイドカー(`an.node_annot`)を優先し、無ければ主 DB。
 *  サイドカーは物理連続なので走査・点引きが桁で速い（db.ts の attachAnnot のコメント参照）。 */
export function annotSource(d: any): { qual: string; cols: Set<string> } | null {
  for (const schema of ['an', '']) {
    const cols = tableCols(d, 'node_annot', schema)
    if (cols.size > 0) return { qual: schema ? `${schema}.` : '', cols }
  }
  return null
}

export function fastAnnotSel(d: any, want: { band: boolean; region: boolean; gene: boolean }, alias = 'n', idCol = 'id'):
  { sel: string; join: string } {
  const srcA = annotSource(d)
  if (!srcA) return { sel: '', join: '' }
  const cols = srcA.cols
  let sel = ''
  if (want.band && cols.has('band_id')) sel += ', na.band_id AS band_id'
  if (want.region && cols.has('region_class')) sel += ', na.region_class AS region_class'
  if (want.gene && cols.has('gene_cnt')) sel += ', na.gene_cnt AS gene_count'
  if (!sel) return { sel: '', join: '' }
  // 索引は在る側にしか無いので、INDEXED BY はサイドカーを使う時だけ付ける
  const idx = srcA.qual ? indexedByIfExists(d, 'idx_na_cov', 'an') : indexedByIfExists(d, 'idx_na_cov')
  return { sel, join: ` LEFT JOIN ${srcA.qual}node_annot na${idx} ON na.node_rowid = ${alias}.${idCol}` }
}

// stats.maxlayer（＝葉の層）。接続ごとに 1 回だけ引いてキャッシュする。
const maxLayerCache = new WeakMap<object, number>()
export function maxLayerOf(d: any): number {
  const hit = maxLayerCache.get(d)
  if (hit !== undefined) return hit
  let v = -1
  try { v = Number((d.prepare('SELECT maxlayer FROM stats LIMIT 1').get() as any)?.maxlayer ?? -1) }
  catch { v = -1 }
  maxLayerCache.set(d, v)
  return v
}

// ビューポート検索の空間索引部は spatial.ts の spatialSource に集約した（<db>.tiled）。
// 部分問い合わせ `rt` を外側にし（CROSS JOIN で結合順を固定）、生存分だけ nodes を rowid 点引きする。
// ★通常の JOIN だと WG(nodes 2億行)でプランナが nodes を外側に選び 10 分以上返らなかった（実測）。
// パラメータは sp.params だけ（層・矩形・マスクは全部 sp に内包）。
export function buildNodesSql(cov: string, hist: string, refSel: string, extraSel = '', extraJoin = '',
                       sp: SpatialSource): string {
  return `
  SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size,
         n.xCoord, n.yCoord, n.angle, n.radius, n.color,
         ${cov} AS coverage, ${hist} AS cov_hist, rt.min_layer AS layer, rt.tx AS tx, rt.tk AS tk, rt.tf AS tf, rt.ta AS ta, rt.tb AS tb${refSel}${extraSel}
  FROM ${sp.from} CROSS JOIN nodes n ON n.rowid = rt.rowid${extraJoin}
`
}

// レガシー経路（cov_hist 等を持たない LOD DB。emitter 産の layered.db はこちら）。
// これらの DB こそ ref_bp 列を持つので、フォールバックにも refSel を通す。
export function buildNodesSqlLegacy(refSel: string, extraSel = '', extraJoin = '',
                             sp: SpatialSource): string {
  return `
  SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size,
         n.xCoord, n.yCoord, n.angle, n.radius, n.color, rt.min_layer AS layer, rt.tx AS tx, rt.tk AS tk, rt.tf AS tf, rt.ta AS ta, rt.tb AS tb${refSel}${extraSel}
  FROM ${sp.from} CROSS JOIN nodes n ON n.rowid = rt.rowid${extraJoin}
`
}

export function parseNodes(rows: any[]): any[] {
  return rows.map(n => n.cov_hist
    ? { ...n, cov_hist: JSON.parse(n.cov_hist) }
    : n
  )
}
