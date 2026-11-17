// worker で走らせる DB 読み取りジョブの実体。
//
// ここに置く理由: worker とメインスレッドの**両方から同じコードを呼べる**ようにするため。
// worker プールが使えない環境（起動失敗など）ではメインで同じ関数を呼んでフォールバックする。
// 違いは guard の中身だけ（worker はキャンセル旗を見る、メインは見ない）。
import type { Database, Statement } from 'better-sqlite3'
import { guardedAll, guardedFold, FETCH_MS, PROBE_CAP, HARD_ROW_CAP, type GuardResult } from './fetchGuard'
import { buildSelection, maskWhere, exactFilterRowids, type Selection } from './hapidx'
import { readsSchema, hasTiledX } from './db'
import { spatialSource, spatialCount } from './spatial'
import { tiledInfo, zranges, buildTiledNodesSql, tiledNodesParams, tiledNodeMask,
         buildTiledEdgesSql, rangesParams } from './tiled'

import {
  tableCols, nodeCovExprs, refPosSel, compSel, kindSel, nodeExtraSel, nodeAttrSel, buildNodesSql, buildNodesSqlLegacy, fastAnnotSel, parseNodes, maxLayerOf, hbCoveringIdx,
} from './nodeQuery'
import {
  edgesHasSigns, edgeRsExpr, edgeExtraSel, buildSignedEdgesBatchSql, visibleNodesSql,
  edgeHasRs, edgeRsJoin,
} from './edgeQuery'

export type GuardFn = (stmt: Statement, params: any[],
                       opts?: { maxRows?: number; timeMs?: number; exemptTime?: boolean })
                      => GuardResult<any>

export type FoldFn = (stmt: Statement, params: any[], onRow: (r: any) => void,
                      opts?: { maxRows?: number; timeMs?: number; exemptTime?: boolean; rawCap?: number })
                     => { rows: number; truncated: boolean; reason: string; ms: number }

export interface JobCtx {
  guard: GuardFn
  fold: FoldFn
  /** 進捗の分母（想定行数）。0/未呼び出しなら「不明」。 */
  setTotal?: (n: number) => void
  /** 進捗のフェーズ（1=走査, 2=バッチ）。 */
  setPhase?: (n: number) => void
  /** 進捗の分子を直接指定する（バッチ処理のように行数では表せない場合）。 */
  setProgress?: (n: number) => void
}

/** メイン実行時の既定 ctx（キャンセル旗なし）。 */
export const plainCtx: JobCtx = {
  guard: (stmt, params, opts) => guardedAll(stmt, params, opts),
  fold: (stmt, params, onRow, opts) => guardedFold(stmt, params, onRow, opts),
}

// 進捗の分母。空間ソース + LIMIT で早期終了するので密度に依らず安い（実測 全域 331 万件でも warm 0.24ms）。
//
// ⚠ spatialCount は PROBE_CAP で頭打ちになるので、**cap に達した値は「実数」ではない**。
//   そのまま分母にすると rows がすぐ分母を追い越して進捗が壊れる（実測 rows=278,192 / total=100,000）。
//   正確に数え切れたときだけ返し、頭打ちなら 0（＝不明）にする。クライアントは 0 のとき
//   パーセントではなく「取得済み N 行」だけ出す。
function estimateTotal(d: Database, layer: number,
                       rect: { x1: number; x2: number; y1: number; y2: number },
                       sel: Selection | null): number {
  try {
    const n = spatialCount(d, layer, rect, sel, PROBE_CAP)
    return n >= PROBE_CAP ? 0 : n
  } catch { return 0 }
}

export type QueryJob =
  | {
      kind: 'nodes_grid'
      db: string
      layer: number
      x1: number; x2: number; y1: number; y2: number
      gw: number; gh: number
      sel?: string
    }
  | {
      kind: 'edges'
      db: string
      layer: number
      x1: number; x2: number; y1: number; y2: number
      mapq: number
      maxRows: number
      sel?: string
      ex?: string          // 相乗り列の要求（'hb','rs' のカンマ区切り）。タイル経路のみ参照
    }
  | {
      kind: 'nodes'
      db: string
      layer: number
      x1: number; x2: number; y1: number; y2: number
      mapq: number
      maxRows: number
      nx: string          // 相乗りさせる annotation 群（hb,band,region,gene）
      sel?: string
    }

export interface JobResult {
  payload: unknown
  status?: number
  rows?: number
  ms?: number
  truncated?: string | null
  layer?: number | null
}

export function runQueryJob(d: Database, job: QueryJob, ctx: JobCtx): JobResult {
  switch (job.kind) {
    case 'nodes_grid': return nodesGrid(d, job, ctx)
    case 'nodes': return nodesViewport(d, job, ctx)
    case 'edges': return edgesViewport(d, job, ctx)
    default: throw new Error(`unknown job kind: ${(job as { kind: string }).kind}`)
  }
}

// ── /api/nodes_grid（ミニマップのグリッド集約）─────────────────────────────
// 仕様・設計の根拠は routes/graph.ts の /nodes_grid のコメントを参照（nodes 表を触らず
// 空間ソースだけを画素解像度で集約する / 1 画素超のノードだけ angle 付きで別途返す）。
// 可視ノード名を束ねる単位。SQLite の変数上限(既定 32766)に対し 2 枝×(1+B) なので余裕を見て 512。
const EDGE_BATCH = 512
// phase 1 で集める可視ノード名の上限。無制限だと WG の広い矩形で名前配列がメモリを食う。
// maxRows 指定時はそれに合わせ（最低 VIS_MIN_CAP）、未指定なら VIS_DEFAULT_CAP。
const VIS_MIN_CAP = 50_000
const VIS_DEFAULT_CAP = 500_000

const GRID_BIG_PX = 2
const GRID_BIG_CAP = 4000

function nodesGrid(d: Database, job: Extract<QueryJob, { kind: 'nodes_grid' }>, ctx: JobCtx): JobResult {
  const { layer: L, x1: ax1, x2: ax2, y1: ay1, y2: ay2, gw, gh } = job
  const w = ax2 - ax1, h = ay2 - ay1
  let sel = null
  try { sel = job.sel ? buildSelection(d, job.sel) : null } catch { sel = null }
  const rect = { x1: ax1, y1: ay1, x2: ax2, y2: ay2 }
  const sp = spatialSource(d, L, rect, sel, 'r')   // <db>.tiled（spatial.ts）

  // ★SQL で GROUP BY しない。すると `USE TEMP B-TREE FOR GROUP BY` になり 1 行目が出る前に
  //   全集計が終わってしまい、時間ガードもキャンセル旗も一度も評価されない（実測: 重い矩形で
  //   51.5 秒かかったのに FETCH_MS=15s で打ち切られていなかった）。空間ソースの生の行を流して
  //   **JS 側でセルに畳む**。こうすれば行ごとにガードが効き、途中で止められる。
  //   メモリも O(セル数) で済む（行は貯めない）。
  const sql = `SELECT r.min_x AS x1, r.max_x AS x2, r.min_y AS y1, r.max_y AS y2 FROM ${sp.from}`
  ctx.setPhase?.(1)
  ctx.setTotal?.(estimateTotal(d, L, rect, sel))

  interface Cell { gx: number; gy: number; c: number; sx: number; sy: number; sw: number }
  const cells = new Map<number, Cell>()
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)
  const g = ctx.fold(d.prepare(sql),
    sp.params,
    (r: { x1: number; x2: number; y1: number; y2: number }) => {
      const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2
      const gx = clamp(Math.floor((cx - ax1) / w * gw), gw - 1)
      const gy = clamp(Math.floor((cy - ay1) / h * gh), gh - 1)
      const key = gy * gw + gx
      let e = cells.get(key)
      if (!e) { e = { gx, gy, c: 0, sx: 0, sy: 0, sw: 0 }; cells.set(key, e) }
      e.c++; e.sx += cx; e.sy += cy; e.sw += (r.x2 - r.x1)
    },
    { timeMs: FETCH_MS, exemptTime: L <= 0 })

  // 2 本目（1 画素超のノードを angle 込みで取る）も必ずガードする。
  // ⚠ ここを素の .all() にしていたため、1 本目が 15 秒で打ち切られた後にこちらが 92 秒走り、
  //   全体 106.9 秒／中断後も worker が 36 秒塞がったままだった（実測）。
  //   ・1 本目が中断/時間切れなら 2 本目は**そもそも走らせない**（結果は部分的で構わない）
  //   ・走らせる場合も残り時間予算だけを与える
  let big: any[] = []
  let bigTrunc = false
  if (!g.truncated) {
    const bigW = GRID_BIG_PX * (w / gw)
    const remainMs = Math.max(1000, FETCH_MS - g.ms)
    // 角度・中心・半径は空間ソースが持つので nodes を触らない
    const bg = ctx.guard(d.prepare(
      `SELECT r.cx AS x, r.cy AS y, r.rad AS r, r.ang AS a FROM ${sp.from} WHERE (r.max_x - r.min_x) >= ?`),
      [...sp.params, bigW],
      { maxRows: GRID_BIG_CAP, timeMs: remainMs })
    big = bg.rows
    bigTrunc = bg.truncated
  }

  const r7 = (v: number) => Math.round(v * 1e7) / 1e7
  return {
    payload: {
      gw, gh,
      cells: [...cells.values()].map(c => ({
        gx: c.gx, gy: c.gy, c: c.c, x: r7(c.sx / c.c), y: r7(c.sy / c.c), w: r7(c.sw / c.c),
      })),
      nodes: big.map(n => ({
        x: r7(n.x), y: r7(n.y), r: r7(n.r), a: Math.round(n.a * 1e4) / 1e4,
      })),
      nodesTruncated: bigTrunc,
    },
    rows: g.rows, ms: g.ms,
    truncated: g.truncated ? g.reason : null,
    layer: L,
  }
}

// ── /api/nodes（ビューポート内のノード取得）─────────────────────────────────
// 経路は 2 つ: nx に 'fast' があればタイルの行だけで返す（nodes を読まない）。無ければ空間ソースの
// 生存分だけ nodes を rowid 点引きして全列を返す（read_cov 経路・bucket モードの厳密判定もここ）。
//
// このクエリは GROUP BY / ORDER BY を持たないので `iterate()` が素直に行を流す。
// ＝時間ガードもキャンセル旗も行ごとに効く（nodes_grid で踏んだ「集計すると止まらない」問題は無い）。
function nodesViewport(d: Database, job: Extract<QueryJob, { kind: 'nodes' }>, ctx: JobCtx): JobResult {
  const L = job.layer
  const rect = { x1: job.x1, y1: job.y1, x2: job.x2, y2: job.y2 }
  const gopt = { maxRows: job.maxRows, timeMs: FETCH_MS, exemptTime: L <= 0 }
  const nx = new Set(String(job.nx || '').split(',').filter(Boolean))
  const wantAttr = { band: nx.has('band'), region: nx.has('region'), gene: nx.has('gene') }

  let sel = null
  try { sel = job.sel ? buildSelection(d, job.sel) : null } catch { sel = null }
  // 空間ソース（<db>.tiled）。層・矩形・マスクを内包するので、以降のクエリのパラメータは sp.params だけ
  const sp = spatialSource(d, L, rect, sel)

  // bucket モード/コンティグ粒度ではマスクは上位集合 → 生存行だけ blob で厳密判定する。
  const post = (rows: any[]) => {
    if (!sel || !sel.exact || rows.length === 0) return rows
    const keep = exactFilterRowids(d, 'node_contig_cov', 'node_rowid',
      rows.map(r => r.id as number), sel)
    return rows.filter(r => keep.has(r.id))
  }
  const done = (g: ReturnType<GuardFn>, rows: any[]): JobResult => ({
    payload: rows, rows: g.rows.length, ms: g.ms,
    truncated: g.truncated ? g.reason : null, layer: L,
  })

  // 進捗の分母（ビュー内の想定ノード数）。安いので毎回出す。
  ctx.setPhase?.(1)
  ctx.setTotal?.(estimateTotal(d, L, rect, sel))

  // ── 描画専用の高速経路（nx に 'fast'）────────────────────────────────────
  // タイルの行（中心・半径・角度・名前・hb・参照座標）だけで返し、nodes 行を読まない。
  // 返らない列: size / coverage / cov_hist / is_bubble / color / haplotype。
  // 呼び側（frontend）がそれらを使わないと分かっているときだけ 'fast' を付ける契約。
  // 実測(WG cold) ノード 1.7〜12.7x / warm 1.5x（nodes を引く経路比）。
  if (nx.has('fast')) {
    const ti = tiledInfo(d)
    if (ti && L < ti.g.length) {
      const rg = zranges(job.x1, job.x2, job.y1, job.y2, ti.g[L])
      const tm = tiledNodeMask(sel)
      const fa = (wantAttr.band || wantAttr.region || wantAttr.gene) ? fastAnnotSel(d, wantAttr, 'n', 'id') : null
      const g = ctx.guard(d.prepare(buildTiledNodesSql(rg.length, tm.sql, fa && fa.sel ? fa : null, hasTiledX(d))),
        tiledNodesParams(rg, L, job.x1, job.x2, job.y1, job.y2, tm.params), gopt)
      return done(g, post(g.rows as any[]))
    }
  }

  const ex = nodeExtraSel(d, nx.has('hb'))
  const attr = nodeAttrSel(d, wantAttr)
  const refsel = refPosSel(d) + compSel(d) + kindSel(d)

  // リード深度トラック: rd.read_cov(サイドカー) or 本体 read_cov があれば coverage をそちらへ差し替える。
  const rcSchema = readsSchema(d)   // 'rd' or 'main' or null
  const hasRc = !!rcSchema &&
    !!d.prepare(`SELECT 1 FROM ${rcSchema}.sqlite_master WHERE type='table' AND name='read_cov'`).get()
  if (hasRc) {
    // 新 read_cov は node_name PK。葉 node_name で LEFT JOIN。
    const g = ctx.guard(d.prepare(buildNodesSql('rc.depth', 'NULL', refsel, ex.sel + attr.sel,
      ex.join + attr.join + ` LEFT JOIN ${rcSchema}.read_cov rc ON rc.node_name = n.node_name`, sp)), sp.params, gopt)
    return done(g, post(parseNodes(g.rows)))
  }
  try {
    const { cov, hist } = nodeCovExprs(d, job.mapq)
    const g = ctx.guard(d.prepare(buildNodesSql(cov, hist, refsel,
      ex.sel + attr.sel, ex.join + attr.join, sp)), sp.params, gopt)
    return done(g, post(parseNodes(g.rows)))
  } catch {
    // レガシー経路（cov_hist 等を持たない LOD DB）。
    const g2 = ctx.guard(d.prepare(buildNodesSqlLegacy(refsel,
      ex.sel + attr.sel, ex.join + attr.join, sp)), sp.params, gopt)
    let rows = g2.rows as any[]
    if (sel && sel.exact && rows.length > 0) {
      const keep = exactFilterRowids(d, 'node_contig_cov', 'node_rowid',
        rows.map(r => r.id as number), sel)
      rows = rows.filter(r => keep.has(r.id))
    }
    return done(g2, rows)
  }
}

// ── /api/edges（ビューポート内のエッジ取得）─────────────────────────────────
// 経路は 2 つ:
//   ① タイル経路: ノードと同じ Z-order 範囲で edges_t を順読み（通常はこれ）
//   ② 可視ノード名経路: 可視ノード名を束ねて edges の索引を probe（①が使えない時の予備:
//      hap 絞り込みで edges_t に辺マスクが無い、リード支持が要るのに端点名も焼き込みも無い）
// （11-17: 座標保存スキーマ・edges_rtree・.hapidx の edge_hm を使う経路は外した。`.tiled` は signed の DB からしか作れない）
function edgesViewport(d: Database, job: Extract<QueryJob, { kind: 'edges' }>, ctx: JobCtx): JobResult {
  const L = job.layer
  let sel = null
  try { sel = job.sel ? buildSelection(d, job.sel) : null } catch { sel = null }

  // ── ① タイル順サイドカー経路 ─────────────────────────────────────────────
  // 可視ノード名で TEXT 索引を 2V 回 probe する代わりに、ノードと同じ Z-order 範囲で
  // edges_t（端点タイルで格納、端点は id）を順次読む。実測(WG) edges cold 2.6〜4.8x / warm 3.7〜4.7x。
  // 端点 id だけ返し、viewer が nodeStore から復元する（両端が無い辺は捨てる）。
  {
    const ti = tiledInfo(d)
    const exq = new Set(String(job.ex || '').split(',').filter(Boolean))
    // read_support は葉層でだけ意味を持つ（鍵が葉名）。要求されていて、サイドカーに端点名があれば join。
    const wantRs = exq.has('rs') && edgesHasSigns(d) && edgeHasRs(d, job.mapq) && L >= maxLayerOf(d)
    const hasNames = !!ti && ti.edgeCols.has('source') && ti.edgeCols.has('target')
    const bakedRs = !!ti && ti.edgeCols.has('rs')      // read_support を焼き込み済み（join 不要）
    const bakedHb = !!ti && ti.edgeCols.has('hb')      // edge_hb を焼き込み済み
    // 辺マスクは edges_t の hm0.. を直接読む（join 無し）
    const edgeMaskOk = !sel || sel.tiledEdges
    if (ti && L < ti.g.length && edgeMaskOk && (!wantRs || hasNames || bakedRs)) {
      ctx.setPhase?.(1)
      const rg = zranges(job.x1, job.x2, job.y1, job.y2, ti.g[L])
      const em = sel ? maskWhere('e', sel) : { sql: '', params: [] as bigint[] }
      let xsel = '', xjoin = ''
      // ★サイドカーは hb / rs を辺の行に持つので join しない。WG 葉層 cold の実測: 主 DB の
      //   edge_contig_cov を eid で引くと 0.4〜1.2 秒、.reads の edge_read_support を名前で引くと 12〜17 秒
      //   （1 辺 20ms のランダム読み）。焼き込みで両方ともタイルの順読みだけになる。
      if (exq.has('hb')) {
        if (bakedHb) xsel += ', e.hb AS edge_hb'
        else if (tableCols(d, 'edge_contig_cov').has('hb')) {
          xsel += ', ecc.hb AS edge_hb'
          xjoin += ` LEFT JOIN edge_contig_cov ecc${hbCoveringIdx(d, 'edge_contig_cov')} ON ecc.edge_rowid = e.eid`
        }
      }
      if (wantRs) {
        if (bakedRs) xsel += ', e.rs AS read_support'
        else { xsel += `, ${edgeRsExpr(d, job.mapq, L)} AS read_support`; xjoin += edgeRsJoin(d, L) }
      }
      // ★edges_t は端点ごとに 1 行（同じ辺が最大 2 回出る）。ガードの行数上限は**生の行**を数えるので、
      //   利用者の上限 maxRows をそのまま渡すと辺数がその半分で 'rows' 打ち切りになる。
      //   fold で流しながら eid で重複排除し、上限は**辺の数**で判定する（生の行の上限は 2 倍で渡す）。
      //   maxRows=0(無制限)のときはガードの絶対上限(HARD_ROW_CAP=生 100 万行 ≒ 50 万辺)が効く。
      const seen = new Set<number>(); let rows: any[] = []
      const g = ctx.fold(d.prepare(buildTiledEdgesSql(rg.length, xsel, xjoin, '', em.sql, hasNames)),
        [...rangesParams(rg), L, job.x1, job.x2, job.y1, job.y2, ...em.params],
        (r: any) => { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r) } },
        { rawCap: job.maxRows > 0 ? 2 * job.maxRows : 2 * HARD_ROW_CAP, timeMs: FETCH_MS, exemptTime: L <= 0 })
      let trunc: string | null = g.truncated ? g.reason : null
      if (job.maxRows > 0 && rows.length > job.maxRows) { rows = rows.slice(0, job.maxRows); trunc = 'rows' }
      if (trunc === 'cancel') return { payload: [], rows: 0, ms: g.ms, truncated: 'cancel', layer: L }
      if (sel && rows.length > 0 && sel.exact) {
        const keep = exactFilterRowids(d, 'edge_contig_cov', 'edge_rowid', rows.map(r => r.id as number), sel)
        rows = rows.filter(r => keep.has(r.id))
      }
      return { payload: rows, rows: rows.length, ms: g.ms, truncated: trunc, layer: L }
    }
  }

  // ── ② 可視ノード名経路 ─────────────────────────────────────────────────
  const ex = edgeExtraSel(d)   // A-2: edge hap-breadth(edge_hb)を相乗り(無い DB は空)
  const hasRs = edgeHasRs(d, job.mapq)
  // ★層を渡す。葉以外では edge_read_support を結合しない（鍵が葉名なので当たらない）。
  const rsSel = hasRs ? `, ${edgeRsExpr(d, job.mapq, L)} AS read_support` : ''
  const rsJoin = hasRs ? edgeRsJoin(d, L) : ''

  // phase 1: 可視ノード名を**自分で**流して集める（`IN (サブクエリ)` だと 1 行目より前に全部実体化され、
  // 中断も進捗も不可能だった。WG で 16.4 秒／16 行）。
  ctx.setPhase?.(1)
  const rect = { x1: job.x1, y1: job.y1, x2: job.x2, y2: job.y2 }
  const vq = visibleNodesSql(d, L, rect, sel)
  const visCap = job.maxRows > 0 ? Math.max(job.maxRows, VIS_MIN_CAP) : VIS_DEFAULT_CAP
  ctx.setTotal?.(estimateTotal(d, L, rect, sel))
  const names: string[] = []
  const g1 = ctx.fold(d.prepare(vq.sql),
    vq.params,
    (r: { node_name: string }) => { names.push(r.node_name) },
    { maxRows: visCap, timeMs: FETCH_MS, exemptTime: L <= 0 })
  if (g1.reason === 'cancel') {
    return { payload: [], rows: 0, ms: g1.ms, truncated: 'cancel', layer: L }
  }

  // phase 2: 名前を BATCH 件ずつ束ねて辺を引く。バッチ境界が中断点と進捗の刻みになる。
  ctx.setPhase?.(2)
  ctx.setTotal?.(names.length)
  const seen = new Set<number>()
  let rows: any[] = []
  let trunc: string | null = g1.truncated ? g1.reason : null
  let msSum = g1.ms
  let stmtFull: ReturnType<Database['prepare']> | null = null
  for (let off = 0; off < names.length; off += EDGE_BATCH) {
    const chunk = names.slice(off, off + EDGE_BATCH)
    const stmt = chunk.length === EDGE_BATCH
      ? (stmtFull ??= d.prepare(buildSignedEdgesBatchSql(EDGE_BATCH, rsSel, ex.sel, ex.join + rsJoin)))
      : d.prepare(buildSignedEdgesBatchSql(chunk.length, rsSel, ex.sel, ex.join + rsJoin))
    const one = [L, ...chunk]
    const gb = ctx.guard(stmt, [...one, ...one],
      { timeMs: FETCH_MS, exemptTime: L <= 0 })
    msSum += gb.ms
    for (const r of gb.rows as any[]) {
      if (seen.has(r.id)) continue
      seen.add(r.id); rows.push(r)
    }
    ctx.setProgress?.(Math.min(off + chunk.length, names.length))
    if (gb.reason === 'cancel') { trunc = 'cancel'; break }
    if (gb.reason === 'time') { trunc = 'time'; break }
    if (job.maxRows > 0 && rows.length >= job.maxRows) {
      rows = rows.slice(0, job.maxRows); trunc = 'rows'; break
    }
  }
  if (trunc === 'cancel') return { payload: [], rows: 0, ms: msSum, truncated: 'cancel', layer: L }

  // 辺そのものの hap 判定（辺マスクが無いので blob で）。可視ノード側の絞り込みだけだと
  // 「両端が hap のノードだが hap は通らない辺」が 8-17% 混ざる（functions/hapfilter/RESULTS.md §3）。
  if (sel && rows.length > 0 && tableCols(d, 'edge_contig_cov').size > 0) {
    const keep = exactFilterRowids(d, 'edge_contig_cov', 'edge_rowid',
      rows.map(r => r.id as number), sel)
    rows = rows.filter(r => keep.has(r.id))
  }
  return { payload: rows, rows: rows.length, ms: msSum, truncated: trunc, layer: L }
}
