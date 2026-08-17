// 座標非保存(signed)スキーマの端点復元ユーティリティ。
//
// 新 emitter は edges に座標を持たせず、端点の「どちらのロッド端か」だけを符号で保持する:
//   src_sign / tgt_sign = +1 → center + radius·(cosθ,sinθ)
//                         -1 → center - radius·(cosθ,sinθ)
//                          0 → 相手中心方向(向き情報なしの pathless フォールバック)
// 端点は nodes(xCoord,yCoord,radius,angle) と符号から一意に復元できる(chrY/chr22 で
// |offset|・角度軸ともに機械精度で厳密確認済)。cos/sin は better-sqlite3 の SQL 関数を用いる。
//
// 復元式を SQL 側で start_x/start_y/end_x/end_y として展開すれば、下流(リボン/経路)の
// JS は従来の座標入りスキーマと同じ列名を読むだけでよい(消費側の改修が不要)。

// edges が signed スキーマ(src_sign 列を持つ)か。列集合から判定する。
export function hasSignSchema(edgeCols: Set<string>): boolean {
  return edgeCols.has('src_sign')
}

// DB 接続から直接 signed スキーマかを判定(PRAGMA)。paths 系の簡便版。
export function dbEdgesSigned(d: any): boolean {
  try {
    return (d.prepare('PRAGMA table_info(edges)').all() as any[]).some(c => c.name === 'src_sign')
  } catch { return false }
}

// 端点座標(x または y)を復元する SQL 式。
//   nA    : 当該端点が属するノードの別名(source 端なら ns, target 端なら nt)
//   signCol: そのノードの符号列(e.src_sign / e.tgt_sign)
//   nB    : 相手ノードの別名(sign=0 の相手中心方向に用いる)
export function rodAxisExpr(nA: string, signCol: string, nB: string, axis: 'x' | 'y'): string {
  const c = axis === 'x' ? 'xCoord' : 'yCoord'
  const trig = axis === 'x' ? 'cos' : 'sin'
  const dist =
    `SQRT((${nB}.xCoord-${nA}.xCoord)*(${nB}.xCoord-${nA}.xCoord)` +
    `+(${nB}.yCoord-${nA}.yCoord)*(${nB}.yCoord-${nA}.yCoord))`
  return (
    `CASE WHEN ${signCol}=0 ` +
    `THEN ${nA}.${c}+${nA}.radius*(${nB}.${c}-${nA}.${c})/(CASE WHEN ${dist}=0 THEN 1 ELSE ${dist} END) ` +
    `ELSE ${nA}.${c}+${signCol}*${nA}.radius*${trig}(${nA}.angle) END`
  )
}

// start_x/start_y/end_x/end_y(必要なら startc/endc も)を復元する SELECT 列。
// ns=source ノード, nt=target ノード が JOIN 済であること。制御点(startc/endc)は
// 端点と同一(未使用=直線)なので start/end を複製する。
export function edgeXYSelect(withControl: boolean): string {
  const sx = rodAxisExpr('ns', 'e.src_sign', 'nt', 'x')
  const sy = rodAxisExpr('ns', 'e.src_sign', 'nt', 'y')
  const ex = rodAxisExpr('nt', 'e.tgt_sign', 'ns', 'x')
  const ey = rodAxisExpr('nt', 'e.tgt_sign', 'ns', 'y')
  let s = `${sx} AS start_x, ${sy} AS start_y, ${ex} AS end_x, ${ey} AS end_y`
  if (withControl) s += `, ${sx} AS startc_x, ${sy} AS startc_y, ${ex} AS endc_x, ${ey} AS endc_y`
  return s
}

// rodAxisExpr の JS 版。signed 端点(x,y)を復元する。SQL(edgeXYSelect)と同じ式なので
// headless レンダラ(figure/graphDrawList)は座標非保存 DB でも同一幾何の端点を得られる。
export interface RodNode { xCoord: number; yCoord: number; radius: number; angle: number }
export function rodEndpoint(nA: RodNode, nB: RodNode, sign: number): { x: number; y: number } {
  if (!sign) {   // sign=0: 相手中心方向へ radius 分
    const dx = nB.xCoord - nA.xCoord, dy = nB.yCoord - nA.yCoord
    const dist = Math.hypot(dx, dy) || 1
    return { x: nA.xCoord + nA.radius * dx / dist, y: nA.yCoord + nA.radius * dy / dist }
  }
  return {
    x: nA.xCoord + sign * nA.radius * Math.cos(nA.angle),
    y: nA.yCoord + sign * nA.radius * Math.sin(nA.angle),
  }
}

// source/target ノードを JOIN する句(ns, nt を導入)。PK(layer_index,node_name)引き。
export const EDGE_NODE_JOIN =
  'JOIN nodes ns ON ns.layer_index = e.layer_index AND ns.node_name = e.source ' +
  'JOIN nodes nt ON nt.layer_index = e.layer_index AND nt.node_name = e.target'

// 可視ノード集合(nodes_rtree ∩ 矩形, 層 L)。パラメータ順 = [L, x2, x1, y2, y1]。
export const VISIBLE_NODE_SUBQUERY =
  'SELECT n.node_name FROM nodes_rtree rt JOIN nodes n ON n.rowid = rt.rowid ' +
  'WHERE rt.min_layer = ? AND rt.min_x <= ? AND rt.max_x >= ? AND rt.min_y <= ? AND rt.max_y >= ?'
