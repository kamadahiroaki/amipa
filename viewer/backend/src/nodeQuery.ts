// /nodes 系クエリの共有ヘルパ。
//
// **worker(dbJobs.ts) と routes/graph.ts の両方から使う**ために切り出した。DB 読み取りを
// worker_threads へ出すには同じクエリ組み立てを worker 側でも走らせる必要があるが、
// これらは全て (Database, パラメータ) の純粋関数なのでそのまま共有できる。
// 中身は graph.ts から**無改変で移動**しただけ（コメントも含む）。
import { maskWhere, type Selection } from './hapidx'

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

// R-Tree intersection: node bbox overlaps query bbox
// For point nodes (min=max), this reduces to: x1 <= xCoord <= x2
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

// ── 描画専用の高速経路（R-Tree だけで返す）───────────────────────────────────
//
// WG cold の律速は「1 行あたりに触る 4KB ページ数」で、現行 `/nodes` は
//   R-Tree の %_node（空間クラスタ＝連続ページ、ほぼ無料）
//   ＋ `nodes` 行（rowid 順が空間順と一致しないので実測 1 行 ≒ 1 ランダムページ）
// の 2 本を触る。実測（functions/covpack/RESULTS.md §12、同一ノード・未アクセス領域・約 2,000 行）:
//   R-Tree だけ 0.014〜0.028 秒（読み 0 バイト）／`nodes` 行も読む 0.135〜0.206 秒 = **7.5〜9.3x**
//
// `hap_index --draw-aux` が載せた補助列（ang/nm/hb/bnd/gcn/rgn）があれば、
// 描画に要る列を R-Tree だけで揃えられる:
//   xCoord=(min_x+max_x)/2, yCoord=(min_y+max_y)/2, radius=(max_x-min_x)/2   ← 幾何から導出
//   angle=ang/ANG_SCALE, node_name=nm, hb, band_id, gene_count, region_class ← 補助列
//   ref_bp / ref_bp_end / ref_contig_id / is_anchor / ref_multi / ref_strand ← 補助列
//     （参照座標トラックは**既定 ON**なので、これが無いと高速経路をほぼ使えない。
//       実測バイトはデータ約 1.9B ＋ レコードヘッダ 6B = +約 8B/行で、効きは 4x → 約 3.4x）
// ★足りないもの: size / coverage / cov_hist / is_bubble / color / haplotype。
//   これらはラベル・色モード・フィルタでしか使わないので、**必要になったときだけ**
//   従来経路（あるいは選択ノードの詳細取得）で読む。だから呼び側が明示的に要求する形にする。
// ★★描画に使う幾何を **矩形から導出してはいけない**。R-Tree の矩形は float32 で
//   **外向きに丸められる**（包含保証のための SQLite の仕様）ので、復元値は必ずずれる:
//     radius = (max_x-min_x)/2  → 必ず過大。深層で **相対 174%**（wgpggb L2 実測）
//     x      = (min_x+max_x)/2  → 座標の桁(0.2〜0.9)での 1 ulp ≈ 3〜6e-8 が乗る
//   絶対誤差はどちらも約 1e-7 world で「小さい」が、**深層ノードは自分の radius が
//   同じオーダー**。実例 mcgrch38 n23316007（size 1bp, L16）:
//     真値 x=0.21982263076960973 y=0.5923226031850704 radius=4.37e-08
//     箱から復元         Δx=4.8e-10  **Δy=4.5e-08**  ← 自分の radius より大きい
//   このノードが 10px で見えるズーム(1px≈8.7e-9 world)では約 5px ずれる。
//   viewer はノードが見える大きさまでズームするので、効くのは world 比でなく
//   **そのノード自身の大きさに対する比**。この判断を 2 回間違えた（radius → 位置）。
//   → 矩形は **空間索引としてだけ** 使い、幾何は cx/cy/rad 補助列から取る。
//   補助列が無い旧 DB では従来どおり矩形から導出する（後方互換。ずれは残る）。
/** 高速経路(R-Tree)から **node_annot を直接** 引くための SELECT/JOIN 断片。
 *
 * ★なぜ補助列(bnd/gcn/rgn)を使わないか:
 *   補助列は `hap_index` が R-Tree を作る時に node_annot から焼き込む。emitter は hapidx を
 *   最後に走らせるので、**その後にアノテーションを足すと補助列は NULL のまま**になる
 *   （実際 chr22-fin で ref_bp は入っているのに band/gene/region だけ NULL だった）。
 *   毎回 R-Tree を作り直す(WG で 1h10m〜1h28m)のは後付け拡張の運用として重すぎるので、
 *   アノテーションだけは node_annot を rowid で点引きする。
 *   実測(chr22, cold): 被覆索引 idx_na_cov ありで典型 0.2〜35ms・最悪 153ms。
 *   索引が無いと同じ問い合わせが 2,256ms(269倍)になるので、索引の有無は必ず見る
 *   （gene_blob が平均 51B あり、スカラ 3 つのために太い行を読むことになるため）。
 */
/** node_annot の所在を返す。サイドカー(`an.node_annot`)を優先し、無ければ主 DB。
 *  サイドカーは物理連続なので走査・点引きが桁で速い（db.ts の attachAnnot のコメント参照）。 */
export function annotSource(d: any): { qual: string; cols: Set<string> } | null {
  for (const schema of ['an', '']) {
    const cols = tableCols(d, 'node_annot', schema)
    if (cols.size > 0) return { qual: schema ? `${schema}.` : '', cols }
  }
  return null
}

export function fastAnnotSel(d: any, want: { band: boolean; region: boolean; gene: boolean }):
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
  return { sel, join: ` LEFT JOIN ${srcA.qual}node_annot na${idx} ON na.node_rowid = r.rowid` }
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

export function buildNodesSqlFast(rtree: string, angScale: number, maskSql = '',
                                  hasRad = false, hasXY = false,
                                  annot: { sel: string; join: string } | null = null): string {
  return `
  SELECT r.rowid AS id, r.nm AS node_name,
         ${hasXY ? 'r.cx' : '(r.min_x + r.max_x) / 2'} AS xCoord,
         ${hasXY ? 'r.cy' : '(r.min_y + r.max_y) / 2'} AS yCoord,
         ${hasRad ? 'r.rad' : '(r.max_x - r.min_x) / 2'} AS radius,
         CAST(r.ang AS REAL) / ${angScale} AS angle,
         r.hb AS hb,
         ${annot && annot.sel ? '' : 'r.bnd AS band_id, r.gcn AS gene_count, r.rgn AS region_class,'}
         r.rbp AS ref_bp, r.rbe AS ref_bp_end, r.rci AS ref_contig_id,
         r.ranc AS is_anchor, r.rmul AS ref_multi, r.rstr AS ref_strand,
         r.min_layer AS layer${annot ? annot.sel : ''}
  FROM ${rtree} r${annot ? annot.join : ''}
  WHERE r.min_layer = ?
    AND r.min_x <= ? AND r.max_x >= ?
    AND r.min_y <= ? AND r.max_y >= ?${maskSql}`
}

// ビューポート検索の空間索引部。sel あり=マスク付き R-Tree(Selection.rtree)を外側ループにし、
// マスク条件を先に評価して生存分だけ nodes を rowid 点引きする（棄却行の太い nodes 行を読まない）。
// sel なし=従来の nodes_rtree。どちらも WHERE のパラメータ順は [L, x2, x1, y2, y1] で始まる。
export function rtreeFrom(sel: Selection | null): { from: string; where: string; params: bigint[] } {
  if (!sel) {
    return {
      from: 'FROM nodes n JOIN nodes_rtree r ON n.rowid = r.rowid',
      where: '', params: [],
    }
  }
  const mw = maskWhere('r', sel)
  return {
    // ★CROSS JOIN で結合順を固定する（SQLite は CROSS JOIN の左を必ず外側ループにする）。
    //   通常の JOIN だと **WG(nodes 2億行)でプランナが nodes を外側に選び、rtree の bbox 制約すら
    //   使わない**プラン（SCAN n → SCAN r VIRTUAL TABLE INDEX 1:）になり 10 分以上返らなかった。
    //   サイドカーだけ ANALYZE 済で main に stat1 が無い非対称が引き金。chr22 では正しいプランに
    //   なっていたので **WG 規模でしか出ない**。CROSS JOIN で 10分超 → cold 6.9s / warm 87ms。
    from: `FROM ${sel.rtree} r CROSS JOIN nodes n ON n.rowid = r.rowid`,
    where: mw.sql, params: mw.params,
  }
}

export function buildNodesSql(cov: string, hist: string, refSel: string, extraSel = '', extraJoin = '',
                       sel: Selection | null = null): string {
  const rt = rtreeFrom(sel)
  return `
  SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size,
         n.xCoord, n.yCoord, n.angle, n.radius, n.color,
         ${cov} AS coverage, ${hist} AS cov_hist, r.min_layer AS layer${refSel}${extraSel}
  ${rt.from}${extraJoin}
  WHERE r.min_layer = ?
    AND r.min_x <= ? AND r.max_x >= ?
    AND r.min_y <= ? AND r.max_y >= ?${rt.where}
`
}

// レガシー経路（cov_hist 等を持たない LOD DB。emitter 産の layered.db はこちら）。
// これらの DB こそ ref_bp 列を持つので、フォールバックにも refSel を通す。
export function buildNodesSqlLegacy(refSel: string, extraSel = '', extraJoin = '',
                             sel: Selection | null = null): string {
  const rt = rtreeFrom(sel)
  return `
  SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size,
         n.xCoord, n.yCoord, n.angle, n.radius, n.color, r.min_layer AS layer${refSel}${extraSel}
  ${rt.from}${extraJoin}
  WHERE r.min_layer = ?
    AND r.min_x <= ? AND r.max_x >= ?
    AND r.min_y <= ? AND r.max_y >= ?${rt.where}
`
}

export function parseNodes(rows: any[]): any[] {
  return rows.map(n => n.cov_hist
    ? { ...n, cov_hist: JSON.parse(n.cov_hist) }
    : n
  )
}
