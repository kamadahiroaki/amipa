// worker で走らせる DB 読み取りジョブの実体。
//
// ここに置く理由: worker とメインスレッドの**両方から同じコードを呼べる**ようにするため。
// worker プールが使えない環境（起動失敗など）ではメインで同じ関数を呼んでフォールバックする。
// 違いは guard の中身だけ（worker はキャンセル旗を見る、メインは見ない）。
import type { Database, Statement } from 'better-sqlite3'
import { guardedAll, guardedFold, cappedCount, FETCH_MS, PROBE_CAP, type GuardResult } from './fetchGuard'
import { buildSelection, maskWhere, exactFilterRowids, hapIdxEdgeOk, hapIdxInfo } from './hapidx'
import path from 'path'
import { dbBytes, HUGE_DB_BYTES, readsSchema } from './db'

/**
 * 高速経路(nx=fast)を実際に使うか。
 *
 * ★高速経路は R-Tree の補助列だけを読むので **haplotype が返らない**。すると frontend の
 *   ノード色はハプロタイプ別にならず既定色(青)一色になる（実際にそう見えていた: 何かの拍子に
 *   通常経路へ落ちた瞬間に色が変わる、という分かりにくい挙動になる）。
 *   取得削減が効くのは WG 級の cold(実測 7.5-9.3x)だけで、chr22/chrY 規模では通常経路でも
 *   十分速い。**大きい DB のときだけ高速経路を使う**ことにして、小さい DB では色を正しくする。
 */
function fastPathWorthIt(d: Database): boolean {
  try {
    const n = (d as unknown as { name?: string }).name
    return n ? dbBytes(path.basename(n)) >= HUGE_DB_BYTES : true
  } catch { return true }
}
import {
  tableCols, nodeCovExprs, refPosSel, compSel, kindSel, nodeExtraSel, nodeAttrSel,
  buildNodesSql, buildNodesSqlLegacy, buildNodesSqlFast, fastAnnotSel, parseNodes,
} from './nodeQuery'
import {
  edgesHasSigns, edgeRsExpr, edgeExtraSel, buildSignedEdgesSql, signedEdgeBranchParams,
  buildEdgesSql, edgesQueryLegacy, buildSignedEdgesBatchSql, visibleNodesSql,
  edgeHasRs, edgeRsJoin,
} from './edgeQuery'

export type GuardFn = (stmt: Statement, params: any[],
                       opts?: { maxRows?: number; timeMs?: number; exemptTime?: boolean })
                      => GuardResult<any>

export type FoldFn = (stmt: Statement, params: any[], onRow: (r: any) => void,
                      opts?: { maxRows?: number; timeMs?: number; exemptTime?: boolean })
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

// 進捗の分母。rtree + LIMIT で早期終了するので密度に依らず安い（実測 全域 331 万件でも warm 0.24ms）。
//
// ⚠ cappedCount は PROBE_CAP で頭打ちになるので、**cap に達した値は「実数」ではない**。
//   そのまま分母にすると rows がすぐ分母を追い越して進捗が壊れる（実測 rows=278,192 / total=100,000）。
//   正確に数え切れたときだけ返し、頭打ちなら 0（＝不明）にする。クライアントは 0 のとき
//   パーセントではなく「取得済み N 行」だけ出す。
function estimateTotal(d: Database, rtree: string, layer: number,
                       rect: { x1: number; x2: number; y1: number; y2: number },
                       mask: string, maskParams: any[]): number {
  try {
    const n = cappedCount(d, rtree, layer, rect, PROBE_CAP, mask, maskParams)
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
// nodes_rtree だけを画素解像度で集約する / 1 画素超のノードだけ angle 付きで別途返す）。
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
  const rtree = sel ? sel.rtree : 'nodes_rtree'
  const mw = sel ? maskWhere('r', sel) : { sql: '', params: [] as bigint[] }

  // ★SQL で GROUP BY しない。すると `USE TEMP B-TREE FOR GROUP BY` になり 1 行目が出る前に
  //   全集計が終わってしまい、時間ガードもキャンセル旗も一度も評価されない（実測: 重い矩形で
  //   51.5 秒かかったのに FETCH_MS=15s で打ち切られていなかった）。生の rtree 行を流して
  //   **JS 側でセルに畳む**。こうすれば行ごとにガードが効き、途中で止められる。
  //   メモリも O(セル数) で済む（行は貯めない）。
  const sql =
    `SELECT r.min_x AS x1, r.max_x AS x2, r.min_y AS y1, r.max_y AS y2
     FROM ${rtree} r
     WHERE r.min_layer = ? AND r.max_layer = ?
       AND r.max_x >= ? AND r.min_x <= ? AND r.max_y >= ? AND r.min_y <= ?${mw.sql}`
  ctx.setPhase?.(1)
  ctx.setTotal?.(estimateTotal(d, rtree, L, { x1: ax1, y1: ay1, x2: ax2, y2: ay2 },
    mw.sql, mw.params as any[]))

  interface Cell { gx: number; gy: number; c: number; sx: number; sy: number; sw: number }
  const cells = new Map<number, Cell>()
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)
  const g = ctx.fold(d.prepare(sql),
    [L, L, ax1, ax2, ay1, ay2, ...mw.params],
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
    const bg = ctx.guard(d.prepare(
      `SELECT n.xCoord AS x, n.yCoord AS y, n.radius AS r, n.angle AS a
       FROM ${rtree} r JOIN nodes n ON n.rowid = r.rowid
       WHERE r.min_layer = ? AND r.max_layer = ?
         AND r.max_x >= ? AND r.min_x <= ? AND r.max_y >= ? AND r.min_y <= ?
         AND (r.max_x - r.min_x) >= ?${mw.sql}`),
      [L, L, ax1, ax2, ay1, ay2, bigW, ...mw.params],
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
// routes/graph.ts の /nodes ハンドラ本体を**そのまま**移したもの（列選択・legacy フォールバック・
// read_cov 経路・bucket モードの厳密判定まで挙動を変えない）。違いは res を触らず値を返す点だけ。
//
// このクエリは GROUP BY / ORDER BY を持たないので `iterate()` が素直に行を流す。
// ＝時間ガードもキャンセル旗も行ごとに効く（nodes_grid で踏んだ「集計すると止まらない」問題は無い）。
function nodesViewport(d: Database, job: Extract<QueryJob, { kind: 'nodes' }>, ctx: JobCtx): JobResult {
  const L = job.layer
  const baseArgs = [L, job.x2, job.x1, job.y2, job.y1]
  const gopt = { maxRows: job.maxRows, timeMs: FETCH_MS, exemptTime: L <= 0 }
  const nx = new Set(String(job.nx || '').split(',').filter(Boolean))
  const wantAttr = { band: nx.has('band'), region: nx.has('region'), gene: nx.has('gene') }

  let sel = null
  try { sel = job.sel ? buildSelection(d, job.sel) : null } catch { sel = null }
  const args = sel ? [...baseArgs, ...maskWhere('r', sel).params] : baseArgs

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
  ctx.setTotal?.(estimateTotal(d, sel ? sel.rtree : 'nodes_rtree', L,
    { x1: job.x1, y1: job.y1, x2: job.x2, y2: job.y2 },
    sel ? maskWhere('r', sel).sql : '', sel ? maskWhere('r', sel).params : []))

  // ── 描画専用の高速経路（nx に 'fast' が入っていて、R-Tree に描画用補助列がある場合）──
  // `nodes` 行を一切読まないので WG cold で 7.5〜9.3x（実測 §12）。
  // 返らない列: size / coverage / cov_hist / is_bubble / color / haplotype。
  // 呼び側（frontend）がそれらを使わないと分かっているときだけ 'fast' を付ける契約。
  if (nx.has('fast') && fastPathWorthIt(d)) {
    const info = hapIdxInfo(d)
    if (info?.drawAux) {
      // 絞り込みがあればマスクも同じ R-Tree に載っているのでそのまま AND できる
      const mw = sel ? maskWhere('r', sel) : { sql: '', params: [] as bigint[] }
      // ★アノテーション(band/region/gene)だけは R-Tree の補助列ではなく node_annot を直接引く。
      //   補助列は hapidx が R-Tree を作る時に焼き込むので、**その後にアノテーションを足すと
      //   NULL のまま**になる。後付け拡張のたびに R-Tree を作り直す(WG 1h10m〜1h28m)のは
      //   運用として重すぎるため、ここだけ点引きに逃がす（実測 典型 0.2〜35ms・要 idx_na_cov）。
      //   要求されていない時は JOIN しないので、通常の描画は従来どおり R-Tree だけで完結する。
      const fa = (wantAttr.band || wantAttr.region || wantAttr.gene)
        ? fastAnnotSel(d, wantAttr) : null
      const g = ctx.guard(d.prepare(
        buildNodesSqlFast(info.rtree, info.angScale, mw.sql, info.hasRad, info.hasXY,
                          fa && fa.sel ? fa : null)), [...baseArgs, ...mw.params], gopt)
      return done(g, post(g.rows as any[]))
    }
    // 補助列が無い DB では黙って従来経路へ（機能は落ちない・速度だけ従来どおり）
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
      ex.join + attr.join + ` LEFT JOIN ${rcSchema}.read_cov rc ON rc.node_name = n.node_name`, sel)), args, gopt)
    return done(g, post(parseNodes(g.rows)))
  }
  try {
    const { cov, hist } = nodeCovExprs(d, job.mapq)
    const g = ctx.guard(d.prepare(buildNodesSql(cov, hist, refsel,
      ex.sel + attr.sel, ex.join + attr.join, sel)), args, gopt)
    return done(g, post(parseNodes(g.rows)))
  } catch {
    // レガシー経路（cov_hist 等を持たない LOD DB）。
    const g2 = ctx.guard(d.prepare(buildNodesSqlLegacy(refsel,
      ex.sel + attr.sel, ex.join + attr.join, sel)), args, gopt)
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
// routes/graph.ts の /edges ハンドラ本体をそのまま移したもの。4 経路すべて維持する:
//   ①signed スキーマ(座標非保存) ②旧座標スキーマ+hap 絞り込み ③旧座標スキーマ素 ④最終フォールバック
//
// ⚠ ①の buildSignedEdgesSql は **UNION ALL**。UNION に戻すと `UNION USING TEMP B-TREE` になって
//   重複排除が終わるまで 1 行も出ず、時間ガードもキャンセル旗も効かなくなる（実測 77.9s/1024行）。
//   重複（両端が可視な辺は両枝に出る）は下で rowid の Set で落とす。
function edgesViewport(d: Database, job: Extract<QueryJob, { kind: 'edges' }>, ctx: JobCtx): JobResult {
  const L = job.layer
  const args = [L, job.x2, job.x1, job.y2, job.y1]
  const gopt = { maxRows: job.maxRows, timeMs: FETCH_MS, exemptTime: L <= 0 }
  const done = (g: ReturnType<GuardFn>, rows: any[]): JobResult => ({
    payload: rows, rows: g.rows.length, ms: g.ms,
    truncated: g.truncated ? g.reason : null, layer: L,
  })
  try {
    let sel = null
    try { sel = job.sel ? buildSelection(d, job.sel) : null } catch { sel = null }
    const ex = edgeExtraSel(d)   // A-2: edge hap-breadth(edge_hb)を相乗り(無い DB は空)
    if (edgesHasSigns(d)) {
      const hasRs = edgeHasRs(d, job.mapq)
      const rsSel = hasRs ? `, ${edgeRsExpr(d, job.mapq)} AS read_support` : ''
      const rsJoin = hasRs ? edgeRsJoin(d) : ''   // rd.edge_read_support への LEFT JOIN(引数なし)
      const edgeMask = !!sel && hapIdxEdgeOk(d)

      // ── phase 1: 可視ノード名を**自分で**流して集める ─────────────────────
      // 以前は `IN (サブクエリ)` で SQLite に丸投げしていたが、それだと LIST SUBQUERY として
      // 1 行目より前に全部実体化され、中断も進捗も不可能だった（WG で 16.4 秒／16 行）。
      ctx.setPhase?.(1)
      const vq = visibleNodesSql(sel)
      const visCap = job.maxRows > 0 ? Math.max(job.maxRows, VIS_MIN_CAP) : VIS_DEFAULT_CAP
      ctx.setTotal?.(estimateTotal(d, sel ? sel.rtree : 'nodes_rtree', L,
        { x1: job.x1, y1: job.y1, x2: job.x2, y2: job.y2 },
        sel ? maskWhere('r', sel).sql : '', sel ? maskWhere('r', sel).params : []))
      const names: string[] = []
      const g1 = ctx.fold(d.prepare(vq.sql),
        [L, job.x2, job.x1, job.y2, job.y1, ...vq.params],
        (r: { node_name: string }) => { names.push(r.node_name) },
        { maxRows: visCap, timeMs: FETCH_MS, exemptTime: L <= 0 })
      if (g1.reason === 'cancel') {
        return { payload: [], rows: 0, ms: g1.ms, truncated: 'cancel', layer: L }
      }

      // ── phase 2: 名前を BATCH 件ずつ束ねて辺を引く ───────────────────────
      // バッチ境界が中断点と進捗の刻みになる。SQL は buildSignedEdgesSql と同一形。
      ctx.setPhase?.(2)
      ctx.setTotal?.(names.length)
      const em = edgeMask && sel ? maskWhere('ehm', sel) : { sql: '', params: [] as bigint[] }
      const seen = new Set<number>()
      let rows: any[] = []
      let trunc: string | null = g1.truncated ? g1.reason : null
      let msSum = g1.ms
      let stmtFull: ReturnType<Database['prepare']> | null = null
      for (let off = 0; off < names.length; off += EDGE_BATCH) {
        const chunk = names.slice(off, off + EDGE_BATCH)
        const stmt = chunk.length === EDGE_BATCH
          ? (stmtFull ??= d.prepare(buildSignedEdgesBatchSql(EDGE_BATCH, rsSel, ex.sel, ex.join + rsJoin, sel, edgeMask)))
          : d.prepare(buildSignedEdgesBatchSql(chunk.length, rsSel, ex.sel, ex.join + rsJoin, sel, edgeMask))
        const one = [L, ...chunk, ...em.params]
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

      // 厳密判定（bucket モード/辺マスク無し）は従来どおり最後にまとめて。
      if (sel && rows.length > 0 &&
          (edgeMask ? sel.exact : tableCols(d, 'edge_contig_cov').size > 0)) {
        const keep = exactFilterRowids(d, 'edge_contig_cov', 'edge_rowid',
          rows.map(r => r.id as number), sel)
        rows = rows.filter(r => keep.has(r.id))
      }
      return { payload: rows, rows: rows.length, ms: msSum, truncated: trunc, layer: L }
    }
    if (sel && (hapIdxEdgeOk(d) || tableCols(d, 'edge_contig_cov').size > 0)) {
      const useMask = hapIdxEdgeOk(d)
      const em = useMask ? maskWhere('ehm', sel) : { sql: '', params: [] as bigint[] }
      const gl = ctx.guard(d.prepare(buildEdgesSql(edgeRsExpr(d, job.mapq), ex.sel,
        ex.join + edgeRsJoin(d) + (useMask ? ` JOIN ${sel.edgeTable} ehm ON ehm.edge_rowid = e.rowid` : '')) + em.sql),
        [...args, ...em.params], gopt)
      let rows = gl.rows as any[]
      if (rows.length > 0 && (useMask ? sel.exact : true)) {
        const keep = exactFilterRowids(d, 'edge_contig_cov', 'edge_rowid',
          rows.map(r => r.id as number), sel)
        rows = rows.filter(r => keep.has(r.id))
      }
      return done(gl, rows)
    }
    const g0 = ctx.guard(d.prepare(buildEdgesSql(edgeRsExpr(d, job.mapq), ex.sel, ex.join + edgeRsJoin(d))), args, gopt)
    return done(g0, g0.rows as any[])
  } catch {
    const rows = d.prepare(edgesQueryLegacy).all(...args) as any[]
    return { payload: rows, rows: rows.length, ms: 0, truncated: null, layer: L }
  }
}
