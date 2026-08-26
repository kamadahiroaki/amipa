// タイル順サイドカー `<db>.tiled`（prep/amipa_prep/tile_index.py 産、db.ts が tl として ATTACH）。
//
// viewer の描画用ノード/エッジ取得を R-Tree から置き換える。
//   R-Tree: 矩形検索が木を降りるので cold で 80〜100 ページのランダム読み（WG 1〜4 秒）。
//           エッジは可視ノードごとに TEXT 索引を 2 回 probe する O(V) 方式で warm でも重い。
//   tiled : 行が (layer, Morton(tile)) 順に clustered。矩形 → Z-order の連続範囲（数十本）→
//           各範囲は 1 回の索引降下 + 順次スキャン。エッジも同じ範囲で取る（端点タイルで格納）。
// 実測(2026-08-26, WG PGGB 313GB cold): 合計 2.4〜8x、最遅 viewport 2.8〜17x、warm でも 3x。
//
// ★SQL の作法（実測で踏んだ罠）:
//   ・`layer=? AND (mkey BETWEEN … OR …)` は SQLite が **層全体の走査** に落とす
//   ・範囲表を CTE で JOIN しても、範囲 20 本超＋矩形フィルタで planner が結合順を反転し同じ結末
//     （L12 で 445ms＝3.76M 行スキャン）。**CROSS JOIN** で順序を固定して 38ms。
import type Database from 'better-sqlite3'
import { tableCols } from './nodeQuery'
import type { Selection } from './hapidx'
import { maskWhere } from './hapidx'

export interface TiledInfo {
  g: number[]                       // 層 → 格子指数（タイル幅 = 1/2^g、世界座標 [0,1]）
  world: { x0: number; x1: number; y0: number; y1: number }
  hmCols: string[]                  // hap マスク語の列名（hm0..）。空なら絞り込み不可
  hasHb: boolean
  nodeCols: Set<string>
  edgeCols: Set<string>            // v3.2 以降は source/target（端点名）を持つ＝葉層のリード支持 join が可能
}
const cache = new WeakMap<object, TiledInfo | null>()
export function tiledInfo(d: Database.Database): TiledInfo | null {
  if (cache.has(d)) return cache.get(d)!
  let info: TiledInfo | null = null
  try {
    const meta = new Map<string, string>()
    for (const r of d.prepare('SELECT key, value FROM tl.meta').all() as { key: string; value: string }[]) meta.set(r.key, r.value)
    if (['tiled-v3.1', 'tiled-v3.2'].includes(meta.get('schema') || '')) {
      const w = JSON.parse(meta.get('world') || '[0,1,0,1]') as number[]
      info = {
        g: JSON.parse(meta.get('g_L') || '[]'),
        world: { x0: w[0], x1: w[1], y0: w[2], y1: w[3] },
        hmCols: JSON.parse(meta.get('hm_cols') || '[]'),
        hasHb: meta.get('has_hb') === '1',
        nodeCols: tableCols(d, 'nodes_t', 'tl'),
        edgeCols: tableCols(d, 'edges_t', 'tl'),
      }
    }
  } catch { info = null }
  cache.set(d, info)
  return info
}
export const TILED_OFF = process.env.AMIPA_TILED === '0'

// ── Z-order（Morton）と矩形の分解 ─────────────────────────────────────────
// キーは最大 2^(2g)。g ≤ 30 なので BigInt で持ち、パラメータも BigInt で渡す（better-sqlite3 は可）。
function part1by1(v: bigint): bigint {
  v &= 0xffffffffn
  v = (v | (v << 16n)) & 0x0000FFFF0000FFFFn
  v = (v | (v << 8n))  & 0x00FF00FF00FF00FFn
  v = (v | (v << 4n))  & 0x0F0F0F0F0F0F0F0Fn
  v = (v | (v << 2n))  & 0x3333333333333333n
  return (v | (v << 1n)) & 0x5555555555555555n
}
export function morton(tx: number, ty: number): bigint { return part1by1(BigInt(tx)) | (part1by1(BigInt(ty)) << 1n) }

/** 世界座標の矩形を、格子 g のタイル矩形（半径のはみ出しぶん margin タイルの余白付き）にし、
 *  quadtree 分解で Z-order キーの連続範囲に落とす。隣接する範囲は併合する。
 *  分解は矩形の**内側を大きな整列ブロック**で覆い、細かいタイルは縁だけに使うので、
 *  detail+N でタイル数が 10 倍になっても範囲数は 3〜4 倍にしか増えない（実測 12→46 本）。 */
export function zranges(x1: number, x2: number, y1: number, y2: number, g: number, margin = 1): Array<[bigint, bigint]> {
  const n = 1 << g, tw = 1 / n
  const cl = (v: number) => Math.max(0, Math.min(n - 1, v))
  const tx0 = cl(Math.floor(x1 / tw) - margin), tx1 = cl(Math.floor(x2 / tw) + margin)
  const ty0 = cl(Math.floor(y1 / tw) - margin), ty1 = cl(Math.floor(y2 / tw) + margin)
  const out: Array<[bigint, bigint]> = []
  const stack: Array<[number, number, number]> = [[g, 0, 0]]
  while (stack.length) {
    const [lv, ox, oy] = stack.pop()!
    const sz = 1 << lv, cx1 = ox + sz - 1, cy1 = oy + sz - 1
    if (cx1 < tx0 || ox > tx1 || cy1 < ty0 || oy > ty1) continue
    if ((ox >= tx0 && cx1 <= tx1 && oy >= ty0 && cy1 <= ty1) || lv === 0) {
      const k = morton(ox, oy); out.push([k, k + (1n << BigInt(2 * lv)) - 1n]); continue
    }
    const h = sz >> 1
    stack.push([lv - 1, ox, oy], [lv - 1, ox + h, oy], [lv - 1, ox, oy + h], [lv - 1, ox + h, oy + h])
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const merged: Array<[bigint, bigint]> = []
  for (const [a, b] of out) {
    if (merged.length && a - merged[merged.length - 1][1] <= 1n) merged[merged.length - 1][1] = b
    else merged.push([a, b])
  }
  return merged
}
export function rangesCte(n: number): string {
  return 'WITH rg(a,b) AS (VALUES ' + Array.from({ length: n }, () => '(?,?)').join(',') + ')'
}
export function rangesParams(r: Array<[bigint, bigint]>): bigint[] { return r.flatMap(([a, b]) => [a, b]) }

// ── ノード ──────────────────────────────────────────────────────────────
// 高速経路(buildNodesSqlFast)と同じ列名で返す（frontend 無改修）。annot は node_annot を id で LEFT JOIN。
const NODE_SEL = `n.id AS id, n.name AS node_name, n.x AS xCoord, n.y AS yCoord, n.r AS radius, n.ang AS angle,
         n.kind AS kind, n.hb AS hb, n.ref_bp AS ref_bp, n.ref_bp_end AS ref_bp_end, n.ref_contig_id AS ref_contig_id,
         n.is_anchor AS is_anchor, n.ref_multi AS ref_multi, n.ref_strand AS ref_strand, n.layer AS layer`
const RECT = 'n.x+n.r>=? AND n.x-n.r<=? AND n.y+n.r>=? AND n.y-n.r<=?'
export function buildTiledNodesSql(nRanges: number, maskSql: string, annot: { sel: string; join: string } | null): string {
  const asel = annot?.sel ?? '', ajoin = annot?.join ?? ''
  return `${rangesCte(nRanges)}
  SELECT ${NODE_SEL}${asel}
  FROM rg CROSS JOIN tl.nodes_t n ON n.layer=? AND n.mkey BETWEEN rg.a AND rg.b${ajoin}
  WHERE ${RECT}${maskSql}
  UNION ALL
  SELECT ${NODE_SEL}${asel}
  FROM tl.nodes_big n${ajoin}
  WHERE n.layer=? AND ${RECT}${maskSql}`
}
/** buildTiledNodesSql のパラメータ: [範囲..., L, 矩形, マスク..., L, 矩形, マスク...] */
export function tiledNodesParams(r: Array<[bigint, bigint]>, L: number, x1: number, x2: number, y1: number, y2: number, mask: bigint[]): any[] {
  return [...rangesParams(r), L, x1, x2, y1, y2, ...mask, L, x1, x2, y1, y2, ...mask]
}
export function tiledNodeMask(sel: Selection | null, info: TiledInfo): { sql: string; params: bigint[] } | null {
  if (!sel) return { sql: '', params: [] }
  // マスク語が sel.mask の長さぶん揃っていなければ絞り込みできない（呼び側は R-Tree 経路へ）
  if (info.hmCols.length < sel.mask.length) return null
  return maskWhere('n', sel)
}

// ── エッジ ──────────────────────────────────────────────────────────────
// 端点 id だけ返す。viewer は nodeStore から端点を復元し、両端が無い辺は捨てる（従来と同じ契約）。
// 行は端点ごと（side 0/1）なので同じ辺が 2 行出うる → 呼び側で eid で重複排除する。
// ★その行の端点 (ex,ey,er) が viewport に重なる行だけ返す（R-Tree 経路の「可視ノードの辺」と同じ意味）。
//   これが無いと外側 1 タイルの環にある密な領域の辺まで全部返し、chr22 L10 で 4〜12 倍の余分を転送した。
const ERECT = 'e.ex+e.er>=? AND e.ex-e.er<=? AND e.ey+e.er>=? AND e.ey-e.er<=?'
// extraSel/extraJoin: edge_hb(edge_contig_cov)・read_support(rd.edge_read_support) を**要求された時だけ**
// 相乗りさせる。従来経路は常に両方を join していたが、葉層の read_support は 1 辺 ~8ms の点引き
// （18GB サイドカーの葉ページを 1 枚ずつ拾う）で、これが「エッジが出るまで数十秒」の正体だった。
export function buildTiledEdgesSql(nRanges: number, extraSel: string, extraJoin: string,
                                   edgeMaskJoin: string, edgeMaskSql: string, hasNames: boolean): string {
  const names = hasNames ? ', e.source AS source, e.target AS target' : ''
  return `${rangesCte(nRanges)}
  SELECT e.eid AS id, e.src_id AS src_id, e.tgt_id AS tgt_id, e.src_sign AS src_sign, e.tgt_sign AS tgt_sign${names}${extraSel}
  FROM rg CROSS JOIN tl.edges_t e ON e.layer=? AND e.mkey BETWEEN rg.a AND rg.b${extraJoin}${edgeMaskJoin}
  WHERE ${ERECT}${edgeMaskSql}`
}
