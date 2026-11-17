// /edges 系クエリの共有ヘルパ。nodeQuery.ts と同じ理由で切り出した
// （worker(dbJobs.ts) と routes/graph.ts の両方から同じ SQL 組み立てを使うため）。
// 中身は graph.ts から**無改変で移動**しただけ（コメントも含む）。
import { hasSignSchema } from './edgeGeom'
import { tableCols, hbCoveringIdx, maxLayerOf } from './nodeQuery'
import { readsSchema } from './db'
import { spatialSource, visibleNamesSql } from './spatial'
import type { Selection } from './hapidx'

// リード由来のエッジ太さ(read_support)がこの DB にあるか。新スキーム= rd.edge_read_support(サイドカー),
// レガシー= base edges.read_support 列。どちらも無ければ false(=太さ機能オフ、描画は壊れない)。
function edgeRsSchema(d: any): string | null {
  const rs = readsSchema(d)
  try {
    if (rs && d.prepare(`SELECT 1 FROM ${rs}.sqlite_master WHERE type='table' AND name='edge_read_support'`).get())
      return rs
  } catch { /* 未 ATTACH */ }
  return null
}
export function edgeHasRs(d: any, mapq = 0): boolean {
  if (edgeRsSchema(d)) return true
  const ec = tableCols(d, 'edges')
  return ec.has('read_support') || (mapq > 0 && ec.has(`read_support_q${mapq}`))
}
// buildEdgesSql/buildSignedEdgesSql の extraJoin に足す edge_read_support への LEFT JOIN。
// ★葉の層でだけ結合する。edge_read_support の鍵は**葉の名前 `n{id}`** なので、上の層
//   （端点が G…/S… のクラスタ）では絶対に当たらないのに、索引を引くコストだけ払っていた。
//   全ゲノム実測で 1 エッジあたり layer12 0.21ms / layer14 0.38ms に対し **layer16 は 8.13ms**
//   （命中して 18GB のサイドカーの葉ページを 1 枚ずつ拾うため）。当たらない層で引かない。
export function edgeRsJoin(d: any, layer?: number): string {
  const rs = edgeRsSchema(d)
  if (!rs) return ''
  if (layer !== undefined && layer !== maxLayerOf(d)) return ''
  return ` LEFT JOIN ${rs}.edge_read_support ers ON ers.source=e.source AND ers.target=e.target`
}

export function edgeRsExpr(d: any, mapq: number, layer?: number): string {
  // 新スキーム: rd.edge_read_support を join 済み(ers.support)。レガシー: base edges 列。無ければ NULL。
  // 葉以外の層では join しない（edgeRsJoin と同じ判定）ので、参照せず NULL を返す。
  if (edgeRsSchema(d)) {
    return (layer !== undefined && layer !== maxLayerOf(d)) ? 'NULL' : 'ers.support'
  }
  const ec = tableCols(d, 'edges')
  if (mapq > 0) {
    const c = `read_support_q${mapq}`
    if (ec.has(c)) return `COALESCE(e.${c}, e.read_support)`
  }
  if (ec.has('read_support')) return 'e.read_support'
  return 'NULL'
}

// edge の hap-breadth(edge_contig_cov.hb)。可視ノード名経路の SELECT 断片＋LEFT JOIN。
export function edgeExtraSel(d: any): { sel: string; join: string } {
  if (!tableCols(d, 'edge_contig_cov').has('hb')) return { sel: '', join: '' }
  // 被覆索引 idx_ecc_hb があれば 161 B/行の blob 行を読まずに hb を取る（ページ 10 分の 1）。
  return { sel: ', ecc.hb AS edge_hb',
           join: ` LEFT JOIN edge_contig_cov ecc${hbCoveringIdx(d, 'edge_contig_cov')}` +
                 ' ON ecc.edge_rowid = e.rowid' }
}

// edges が座標非保存(signed)スキーマか。`.tiled` は signed の DB からしか作れないので、表示できる DB では常に真。
export function edgesHasSigns(d: any): boolean {
  return hasSignSchema(tableCols(d, 'edges'))
}

// ── 可視ノード名で辺を引く（タイル経路が使えない時の予備。worker で中断可能・進捗を出せる形）──────
//
// 可視ノードは呼び側が自分で streaming 取得し、名前を N 件ずつ束ねてここへ渡す。
// `IN (サブクエリ)` で SQLite に丸投げすると EQP が `LIST SUBQUERY` になり、可視ノード一覧を
// 1 行目より前に丸ごと実体化する＝キャンセル旗も時間ガードも評価されない（WG 実測: layer13 の
// 0.06x0.06 矩形で 16.4 秒かけて 16 行）。バッチごとに iterate が回るので、**バッチ境界が中断点と進捗の刻み**になる。
// ★UNION ではなく UNION ALL。UNION だと `UNION USING TEMP B-TREE` で重複排除を終えるまで 1 行も出ない
//   （実測 77.9s/1024行）。重複（両端が可視な辺は両枝に出る）は呼び出し側が e.rowid で落とす。
export function buildSignedEdgesBatchSql(n: number, rsSel: string, extraSel = '', extraJoin = ''): string {
  const cols = `e.rowid AS id, e.source, e.target, e.src_sign, e.tgt_sign${rsSel}${extraSel}`
  const ph = new Array(n).fill('?').join(',')
  const branch = (side: string) =>
    `SELECT ${cols} FROM edges e${extraJoin} ` +
    `WHERE e.layer_index = ? AND e.${side} IN (${ph})`
  return `${branch('source')} UNION ALL ${branch('target')}`
}

/** 可視ノード名を流すクエリ（バッチ版 phase 1 用）。パラメータは sp.params（層・矩形・マスク内包）。
 *  nm（node_name）を空間ソースが持つので nodes を触らない。 */
export function visibleNodesSql(d: any, L: number, rect: { x1: number; x2: number; y1: number; y2: number },
                                sel: Selection | null): { sql: string; params: any[] } {
  const sp = spatialSource(d, L, rect, sel)
  return { sql: visibleNamesSql(sp), params: sp.params }
}
