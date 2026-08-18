// /edges 系クエリの共有ヘルパ。nodeQuery.ts と同じ理由で切り出した
// （worker(dbJobs.ts) と routes/graph.ts の両方から同じ SQL 組み立てを使うため）。
// 中身は graph.ts から**無改変で移動**しただけ（コメントも含む）。
import { hasSignSchema, VISIBLE_NODE_SUBQUERY } from './edgeGeom'
import { hapIdxInfo, maskWhere, type Selection } from './hapidx'
import { tableCols, hbCoveringIdx, maxLayerOf } from './nodeQuery'
import { readsSchema } from './db'

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

// 絞り込み時の可視ノード集合（マスク付き R-Tree を引く）。rtree の第1列は rowid 別名なので
// main/サイドカーどちらでも rt.rowid で書ける。パラメータ順 = [L, x2, x1, y2, y1, ...mask]。
export function visibleNodeSubquerySel(sel: Selection): { sql: string; params: bigint[] } {
  const mw = maskWhere('rt', sel)
  return {
    sql: `SELECT n.node_name FROM ${sel.rtree} rt CROSS JOIN nodes n ON n.rowid = rt.rowid ` +
         'WHERE rt.min_layer = ? AND rt.min_x <= ? AND rt.max_x >= ? ' +
         'AND rt.min_y <= ? AND rt.max_y >= ?' + mw.sql,
    params: mw.params,
  }
}

// ★R-Tree に描画補助列 `nm`（node_name）があるなら、可視ノード名は **R-Tree だけで出せる**。
//   従来は必ず `JOIN nodes` していたので、ノード側の高速経路がせっかく避けている
//   「%_node のランダム読み」をエッジ取得のたびに踏んでいた（コールドで支配的）。
//   nm が無い DB では従来どおり（機能は落ちない・速度だけ従来どおり）。
function rtreeWithNm(d: any, sel: Selection | null): string | null {
  const rt = sel ? sel.rtree : (hapIdxInfo(d)?.rtree ?? null)
  if (!rt) return null
  const bare = rt.includes('.') ? rt.split('.')[1] : rt
  const schema = rt.includes('.') ? rt.split('.')[0] + '.' : ''
  try {
    const cols = new Set((d.prepare(`PRAGMA ${schema}table_info(${bare})`).all() as any[])
      .map(c => String(c.name)))
    return cols.has('nm') ? rt : null
  } catch { return null }
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

// edge の hap-breadth(edge_contig_cov.hb)。signed/coord 両経路の SELECT 断片＋LEFT JOIN。
export function edgeExtraSel(d: any): { sel: string; join: string } {
  if (!tableCols(d, 'edge_contig_cov').has('hb')) return { sel: '', join: '' }
  // 被覆索引 idx_ecc_hb があれば 161 B/行の blob 行を読まずに hb を取る（ページ 10 分の 1）。
  return { sel: ', ecc.hb AS edge_hb',
           join: ` LEFT JOIN edge_contig_cov ecc${hbCoveringIdx(d, 'edge_contig_cov')}` +
                 ' ON ecc.edge_rowid = e.rowid' }
}

export function buildEdgesSql(rs: string, extraSel = '', extraJoin = ''): string {
  return `
  SELECT e.rowid AS id, e.source, e.target,
         e.start_x, e.start_y, e.end_x, e.end_y,
         e.startc_x, e.startc_y, e.endc_x, e.endc_y,
         ${rs} AS read_support${extraSel}
  FROM edges e
  JOIN edges_rtree r ON e.rowid = r.rowid${extraJoin}
  WHERE r.min_layer = ?
    AND r.min_x <= ? AND r.max_x >= ?
    AND r.min_y <= ? AND r.max_y >= ?
`
}

export const edgesQueryLegacy = `
  SELECT e.rowid AS id, e.source, e.target,
         e.start_x, e.start_y, e.end_x, e.end_y,
         e.startc_x, e.startc_y, e.endc_x, e.endc_y,

  FROM edges e
  JOIN edges_rtree r ON e.rowid = r.rowid
  WHERE r.min_layer = ?
    AND r.min_x <= ? AND r.max_x >= ?
    AND r.min_y <= ? AND r.max_y >= ?
`

// 新スキーマ(座標非保存): edges は src_sign/tgt_sign のみ。ビューポート検索は edges_rtree を使わず、
// nodes_rtree の可視ノード集合で source/target 両枝を covering 索引
// (PK=layer,source,target と idx_edges_ts=layer,target,source)で probe する UNION。詳細 ../edgeGeom。
export function edgesHasSigns(d: any): boolean {
  return hasSignSchema(tableCols(d, 'edges'))
}

// B(2026-07-22): 端点座標は SQL で復元しない。符号(src_sign/tgt_sign)だけ返し、viewer が取得済みノード
// (中心/半径/角度)から JS で端点を復元する。WG(2億行)では端点復元のための nodes への二重 name-JOIN が
// コールド random I/O の主因(実測 密領域で +1200ms)だったのを除去。可視ノード名での edges 探索は残る(=A で対処)。
// sel あり: ① 種になる可視ノードを hap 該当分だけに絞る（probe 回数が selectivity 分だけ減る＝
// 速度向上はほぼ全部これ。実測 warm 280ms→10ms）② さらに ix.edge_hm で **辺自体**が その hap を
// 通るかを判定する。②は速度ではなく正しさのため: ①だけだと「両端が hap のノードだが hap は通らない辺」
// が 8-17% 混ざり、ハブ領域で偽の分岐として描かれる（functions/hapfilter/RESULTS.md §3）。
export function buildSignedEdgesSql(rsSel: string, extraSel = '', extraJoin = '',
                             sel: Selection | null = null, edgeMask = false): string {
  const cols = `e.rowid AS id, e.source, e.target, e.src_sign, e.tgt_sign${rsSel}${extraSel}`
  const vis = sel ? visibleNodeSubquerySel(sel) : { sql: VISIBLE_NODE_SUBQUERY, params: [] }
  const ej = extraJoin +
    (edgeMask && sel?.edgeTable ? ` JOIN ${sel.edgeTable} ehm ON ehm.edge_rowid = e.rowid` : '')
  const em = edgeMask && sel ? maskWhere('ehm', sel) : { sql: '', params: [] }
  const branch = (side: string) =>
    `SELECT ${cols} FROM edges e${ej} ` +
    `WHERE e.layer_index = ? AND e.${side} IN (${vis.sql})${em.sql}`
  // ★UNION ではなく UNION ALL。重複（両端が可視な辺は両枝に出る）は呼び出し側が e.rowid で落とす。
  //
  // UNION だと EQP が `UNION USING TEMP B-TREE` になり、**重複排除を終えるまで 1 行も出てこない**。
  // SQL 側に LIMIT は無い（打ち切りは guardedAll の iterate + break）ので、密領域では
  // 「可視ノード 345,723 件 × 両枝ぶんの索引 probe をすべて済ませてから 1 行目」になり、
  // 時間ガードが発火した時には既に 50 秒同期ブロックした後だった（2026-08-03 実測:
  // 16 行しか返していないのに X-AMIPA-Ms 50,548）。TIME_CHECK_EVERY を 1024→16 に詰めても、
  // 行が出てこない以上まったく効かない。
  // UNION ALL なら左枝から素直にストリームするので iterate/break が本当に効く
  // （同条件の LIMIT 16 で warm 1.36s → 0.24s、無制限でも早期 break できる）。
  return `${branch('source')} UNION ALL ${branch('target')}`
}

// buildSignedEdgesSql の 1 ブランチぶんのパラメータ順を作る。
// [L(edges), L(rtree), x2, x1, y2, y1, ...visibleMask, ...edgeMask]
export function signedEdgeBranchParams(L: number, bx1: number, bx2: number, by1: number, by2: number,
                                sel: Selection | null, edgeMask: boolean): any[] {
  const vis = sel ? maskWhere('r', sel).params : []
  const em = edgeMask && sel ? maskWhere('ehm', sel).params : []
  return [L, L, bx2, bx1, by2, by1, ...vis, ...em]
}

// ── バッチ版（worker で中断可能・進捗を出せる形にするため）─────────────────
//
// buildSignedEdgesSql は可視ノードを `IN (サブクエリ)` で渡すので、EQP が `LIST SUBQUERY` になり
// **可視ノード一覧を 1 行目より前に丸ごと実体化**する。その間 iterate ループに入らないので、
// キャンセル旗も時間ガードも一度も評価されない（WG 実測: layer13 の 0.06x0.06 矩形で
// 16.4 秒かけて 16 行しか流れず time 打ち切り＝ほぼ全部が実体化フェーズ）。
//
// そこで可視ノードは呼び側が自分で streaming 取得し、名前を N 件ずつ束ねてここへ渡す。
// バッチごとに iterate が回るので、**バッチ境界が中断点と進捗の刻みになる**。
// SQL 自体（列・JOIN・マスク）は buildSignedEdgesSql と同一で、`IN` の中身だけが差し替わる。
export function buildSignedEdgesBatchSql(n: number, rsSel: string, extraSel = '', extraJoin = '',
                                         sel: Selection | null = null, edgeMask = false): string {
  const cols = `e.rowid AS id, e.source, e.target, e.src_sign, e.tgt_sign${rsSel}${extraSel}`
  const ej = extraJoin +
    (edgeMask && sel?.edgeTable ? ` JOIN ${sel.edgeTable} ehm ON ehm.edge_rowid = e.rowid` : '')
  const em = edgeMask && sel ? maskWhere('ehm', sel) : { sql: '', params: [] }
  const ph = new Array(n).fill('?').join(',')
  const branch = (side: string) =>
    `SELECT ${cols} FROM edges e${ej} ` +
    `WHERE e.layer_index = ? AND e.${side} IN (${ph})${em.sql}`
  return `${branch('source')} UNION ALL ${branch('target')}`
}

/** 可視ノード名を流すクエリ（バッチ版 phase 1 用）。パラメータ順 [L, x2, x1, y2, y1, ...mask]。 */
export function visibleNodesSql(d: any, sel: Selection | null): { sql: string; params: bigint[] } {
  const rt = rtreeWithNm(d, sel)
  if (rt) {
    const mw = sel ? maskWhere('rt', sel) : { sql: '', params: [] as bigint[] }
    return {
      sql: `SELECT rt.nm AS node_name FROM ${rt} rt ` +
           'WHERE rt.min_layer = ? AND rt.min_x <= ? AND rt.max_x >= ? ' +
           'AND rt.min_y <= ? AND rt.max_y >= ?' + mw.sql,
      params: mw.params,
    }
  }
  return sel ? visibleNodeSubquerySel(sel) : { sql: VISIBLE_NODE_SUBQUERY, params: [] }
}
