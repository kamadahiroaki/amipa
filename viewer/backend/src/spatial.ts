// 空間索引の**共通の入口**。「層 L・矩形 rect（・hap 絞り込み sel）に重なるノード集合」を
// 1 つの部分問い合わせ `(...) rt` として返し、呼び側は `rt.rowid` で nodes や被覆表を引く。
//
// 実体は 2 通り:
//   ・tiled : `<db>.tiled`（tl）の Z-order clustered 表 nodes_t/nodes_big。矩形 → Z 範囲（数十本）→ 順読み。
//             hap マスク hm0.. も辺の hb/rs もこの表に焼き込み済み（v4）。**新しい DB はこれしか持たない**
//   ・rtree : 従来の nodes_rtree（絞り込み時はマスク補助列つきの Selection.rtree）。`.tiled` の無い旧 DB 用
// 部分問い合わせが返す列は両者で同じ:
//   rowid, min_layer, max_layer, min_x, max_x, min_y, max_y, cx, cy, rad, ang, nm
// （ang / nm は R-Tree に補助列が無い DB では NULL。cx/cy/rad は無ければ矩形から導出＝旧 DB と同じ精度）
//
// ★呼び側は必ず `FROM ${sp.from} CROSS JOIN nodes n ON n.rowid = rt.rowid` の向きで書く。
//   CROSS JOIN で結合順を固定しないと WG（nodes 2 億行）でプランナが nodes を外側に選び 10 分超になる
//   （nodeQuery.ts rtreeFrom 時代の実測）。tiled の部分問い合わせは UNION ALL の複合なのでコルーチンとして
//   外側で走り、`LIMIT` は行を引き出した分で止まる（＝件数プローブの早期終了もそのまま効く）。
import type Database from 'better-sqlite3'
import { tiledInfo, TILED_OFF, zranges, rangesCte, rangesParams, type TiledInfo } from './tiled'
import { hapIdxInfo, maskWhere, type Selection } from './hapidx'

export interface Rect { x1: number; x2: number; y1: number; y2: number }
export interface SpatialSource {
  /** `FROM ${from}` に置く。別名は rt（引数 alias で変更可） */
  from: string
  params: any[]
  /** タイル経路か（false = R-Tree） */
  tiled: boolean
  /** nm（node_name）が実値か。false なら NULL（nodes を JOIN して取る） */
  hasNm: boolean
}

/** この層でタイル経路が使えるか（サイドカーがあり、層の格子が定義されている） */
export function tiledFor(d: Database.Database, L: number): TiledInfo | null {
  if (TILED_OFF) return null
  const ti = tiledInfo(d)
  return ti && L >= 0 && L < ti.g.length ? ti : null
}

const T_COLS = (a: string) =>
  `${a}.id AS rowid, ${a}.layer AS min_layer, ${a}.layer AS max_layer,
   ${a}.x-${a}.r AS min_x, ${a}.x+${a}.r AS max_x, ${a}.y-${a}.r AS min_y, ${a}.y+${a}.r AS max_y,
   ${a}.x AS cx, ${a}.y AS cy, ${a}.r AS rad, ${a}.ang AS ang, ${a}.name AS nm`
const T_RECT = (a: string) => `${a}.x+${a}.r>=? AND ${a}.x-${a}.r<=? AND ${a}.y+${a}.r>=? AND ${a}.y-${a}.r<=?`

/**
 * 層 L・矩形 rect・絞り込み sel に重なるノードの部分問い合わせ。
 * sel があるのにマスクを載せた索引が無い DB では例外（黙って全件を返さない）。
 */
export function spatialSource(d: Database.Database, L: number, rect: Rect,
                              sel: Selection | null = null, alias = 'rt'): SpatialSource {
  const ti = tiledFor(d, L)
  const tiledMaskOk = !sel || (sel.tiledNodes && ti != null && ti.hmCols.length >= sel.mask.length)
  if (ti && tiledMaskOk) {
    const rg = zranges(rect.x1, rect.x2, rect.y1, rect.y2, ti.g[L])
    const mw = sel ? maskWhere('n', sel) : { sql: '', params: [] as bigint[] }
    const from = `(${rangesCte(rg.length)}
      SELECT ${T_COLS('n')}
      FROM rg CROSS JOIN tl.nodes_t n ON n.layer=? AND n.mkey BETWEEN rg.a AND rg.b
      WHERE ${T_RECT('n')}${mw.sql}
      UNION ALL
      SELECT ${T_COLS('n')}
      FROM tl.nodes_big n
      WHERE n.layer=? AND ${T_RECT('n')}${mw.sql}) ${alias}`
    const rp = [rect.x1, rect.x2, rect.y1, rect.y2]
    return { from, params: [...rangesParams(rg), L, ...rp, ...mw.params, L, ...rp, ...mw.params], tiled: true, hasNm: true }
  }
  // ── R-Tree（旧 DB）──
  const rtree = sel ? sel.rtree : 'nodes_rtree'
  if (!rtree) throw new Error('hap 絞り込みに使える索引が無い（.tiled v4 か nodes_rtree の hm 補助列が要る）')
  const info = hapIdxInfo(d)
  const aux = info && info.rtree === rtree && info.drawAux
  const cx = aux && info.hasXY ? 'r.cx' : '(r.min_x+r.max_x)/2'
  const cy = aux && info.hasXY ? 'r.cy' : '(r.min_y+r.max_y)/2'
  const rad = aux && info.hasRad ? 'r.rad' : '(r.max_x-r.min_x)/2'
  const ang = aux ? `CAST(r.ang AS REAL)/${info.angScale}` : 'NULL'
  const nm = aux ? 'r.nm' : 'NULL'
  const mw = sel ? maskWhere('r', sel) : { sql: '', params: [] as bigint[] }
  const from = `(SELECT r.rowid AS rowid, r.min_layer, r.max_layer, r.min_x, r.max_x, r.min_y, r.max_y,
      ${cx} AS cx, ${cy} AS cy, ${rad} AS rad, ${ang} AS ang, ${nm} AS nm
    FROM ${rtree} r
    WHERE r.min_layer=? AND r.max_layer=? AND r.max_x>=? AND r.min_x<=? AND r.max_y>=? AND r.min_y<=?${mw.sql}) ${alias}`
  return { from, params: [L, L, rect.x1, rect.x2, rect.y1, rect.y2, ...mw.params], tiled: false, hasNm: !!aux }
}

/**
 * 打ち切りカウント（pick_layer / node_count / 進捗の分母）。`LIMIT cap` が部分問い合わせから行を
 * 引き出す量を有界にするので、密度に依らずコストは cap 行ぶんで一定。
 */
export function spatialCount(d: Database.Database, L: number, rect: Rect, sel: Selection | null, cap: number): number {
  const sp = spatialSource(d, L, rect, sel)
  const row = d.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${sp.from} LIMIT ?)`)
    .get(...sp.params, cap) as { n: number } | undefined
  return row?.n ?? 0
}

/** 可視ノード名を流す SQL（signed エッジ経路の phase 1）。nm が実値なら nodes を触らない */
export function visibleNamesSql(sp: SpatialSource): string {
  return sp.hasNm
    ? `SELECT rt.nm AS node_name FROM ${sp.from}`
    : `SELECT n.node_name FROM ${sp.from} CROSS JOIN nodes n ON n.rowid = rt.rowid`
}
