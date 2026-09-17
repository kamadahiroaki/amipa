import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { getDb, getDbDir } from '../db'
import { distillFor } from './bubbleMsa'
import { BlocksWorker, getBlocksWorker, peekBlocksWorker, blocksWorkerStatus } from '../blocksWorker'

// 多解像度 MSA（共線ブロック）のサイドカーを配る。
//   GET /api/blocks?db=X.db            … `<db>.blocks.json`（functions/msa_lod/70_hier_build.py の出力）をそのまま返す
//   GET /api/blocks/warm?db  … 逐次計算ワーカーを起こして Ctx を温める（状態を返す）。パネルを開いた時に呼ぶ
//   GET /api/blocks/status?db … ワーカーの状態
//   POST /api/blocks/window   … {db, ranges:[[path,s0,e0],…], span, afrac, label, depth, parent, pblock}
//       … 事前計算に無い窓をその場で計算して返す（blocksWorker.ts → scripts/blocks/worker.py）
//   GET /api/blocks/view?db&contig&start&end … 区間に合う表示層とノードの外接箱（MSA の窓 → グラフの層・範囲）
//   GET /api/blocks/nodes?db&layer&contig&start&end
//       … 参照区間 [start,end] に重なる、表示層 `layer` のノード名。ブロック → グラフの強調に使う。
//         idx_nodes_refpos(ref_contig_id, ref_bp, ref_bp_end, layer_index) を使う索引レンジで、全走査しない。
// 試作段階: サイドカーは 1 ファイルの JSON。本番は SQLite（plans/msa-multires.md §4）に置き換える。
export const blocksRouter = Router()
export const BLOCKS_SUFFIX = '.blocks.json'

function blocksPath(dbFile: string): string | null {
  const p = path.join(getDbDir(), path.basename(dbFile)) + BLOCKS_SUFFIX
  try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
  try {                                                   // symlink 運用（DB_DIR 側が symlink）でも実体の隣を見る
    const rp = fs.realpathSync(path.join(getDbDir(), path.basename(dbFile))) + BLOCKS_SUFFIX
    if (fs.existsSync(rp)) return rp
  } catch { /* ignore */ }
  return null
}

blocksRouter.get('/blocks', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const p = blocksPath(db)
  if (!p) { res.json({ error: 'この DB には多解像度 MSA のサイドカーがありません（' + path.basename(db) + BLOCKS_SUFFIX + '）' }); return }
  res.type('application/json'); fs.createReadStream(p).pipe(res)
})

blocksRouter.get('/blocks/has', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  res.json({ has: !!blocksPath(db) })
})

function refMaxSpan(d: ReturnType<typeof getDb>): number | null {
  try {
    const r = d.prepare("SELECT value FROM ref_meta WHERE key='max_span'").get() as { value?: string } | undefined
    const v = r?.value != null ? Number(r.value) : NaN
    return Number.isFinite(v) ? v : null
  } catch { return null }
}

const MAX_NODES = 20000
// ブロック区間 [start,end] に「属する」ノード。
//   ・区間と重なり、かつノードの参照スパン（ref_bp_end − ref_bp）が区間幅の 2 倍以下のもの。境界をまたぐ普通のノードは
//     入り、区間より桁で広い箱を持つノードは入らない（粗い層のクラスタのスーパーノードは、子孫の葉が散在すると外接箱が
//     Mb 級になる。ecoli50 の G1233638 は 2.04〜4.86 Mb で、どのブロックのホバーでも光っていた。ref_multi では拾えない）
//   ・この規則から ref_bp ≥ start − 2·幅 が従うので、索引レンジの下限もそれで閉じる（DB 統計に依らない）
//   ・グラフの塗り分け（blockColorOf）も同じ規則
blocksRouter.get('/blocks/nodes', (req, res) => {
  const { db, layer, contig, start, end } = req.query as Record<string, string>
  if (!db || layer == null || contig == null || start == null || end == null) { res.status(400).json({ error: 'Missing db/layer/contig/start/end' }); return }
  const L = Number(layer), cid = Number(contig), s = Number(start), e = Number(end)
  if (![L, cid, s, e].every(Number.isFinite)) { res.status(400).json({ error: 'Invalid numbers' }); return }
  try {
    const d = getDb(db)
    const maxSpan = 2 * Math.max(1, e - s)
    const rows = d.prepare(
      `SELECT node_name FROM nodes
       WHERE layer_index = ? AND ref_contig_id = ? AND ref_bp IS NOT NULL
         AND ref_bp <= ? AND ref_bp >= ?
         AND COALESCE(ref_bp_end, ref_bp) >= ?
         AND COALESCE(ref_bp_end, ref_bp) - ref_bp <= ?
       LIMIT ${MAX_NODES}`
    ).all(L, cid, e, s - maxSpan, s, maxSpan) as { node_name: string }[]
    res.json({ names: rows.map(r => r.node_name), truncated: rows.length >= MAX_NODES })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ── MSA の窓 → グラフの表示層と範囲 ───────────────────────────────────────────────
//   GET /api/blocks/view?db&contig&start&end[&target=800]
//   区間に属するノード数を粗い層から数え、target 以下に収まる最も細かい層を選ぶ。その層のノードの外接箱と重心も返す。
//   画面は fitBounds(bbox, layer) でグラフをその層のズーム帯に合わせて範囲へ寄せる（MSA の窓の大きさ→表示層の連動）。
function maxLayerOf(d: ReturnType<typeof getDb>): number {
  try { const r = d.prepare('SELECT maxlayer FROM stats').get() as { maxlayer?: number } | undefined; return Number(r?.maxlayer ?? 0) } catch { return 0 }
}
blocksRouter.get('/blocks/view', (req, res) => {
  const { db, contig, start, end, target } = req.query as Record<string, string>
  if (!db || contig == null || start == null || end == null) { res.status(400).json({ error: 'Missing db/contig/start/end' }); return }
  const cid = Number(contig), s = Number(start), e = Number(end), tgt = Math.max(50, Number(target) || 800)
  if (![cid, s, e].every(Number.isFinite)) { res.status(400).json({ error: 'Invalid numbers' }); return }
  try {
    const d = getDb(db); const maxL = maxLayerOf(d); const maxSpan = 2 * Math.max(1, e - s)
    const cnt = d.prepare(
      `SELECT COUNT(*) AS n FROM nodes
       WHERE layer_index = ? AND ref_contig_id = ? AND ref_bp IS NOT NULL AND ref_bp <= ? AND ref_bp >= ?
         AND COALESCE(ref_bp_end, ref_bp) >= ? AND COALESCE(ref_bp_end, ref_bp) - ref_bp <= ?`)
    const counts: number[] = []; let layer = 0
    for (let L = 0; L <= maxL; L++) {
      const n = Number((cnt.get(L, cid, e, s - maxSpan, s, maxSpan) as { n: number }).n)
      counts.push(n)
      if (n <= tgt && n > 0) layer = L
      if (n > tgt) break                                   // 細かい層ほど増えるので、超えたら打ち切り
    }
    const bb = d.prepare(
      `SELECT COUNT(*) AS n, MIN(xCoord) AS minx, MAX(xCoord) AS maxx, MIN(yCoord) AS miny, MAX(yCoord) AS maxy,
              AVG(xCoord) AS cx, AVG(yCoord) AS cy FROM nodes
       WHERE layer_index = ? AND ref_contig_id = ? AND ref_bp IS NOT NULL AND ref_bp <= ? AND ref_bp >= ?
         AND COALESCE(ref_bp_end, ref_bp) >= ? AND COALESCE(ref_bp_end, ref_bp) - ref_bp <= ?`
    ).get(layer, cid, e, s - maxSpan, s, maxSpan) as any
    if (!bb || !bb.n) { res.json({ layer, count: 0, counts }); return }
    res.json({ layer, count: bb.n, counts, cx: bb.cx, cy: bb.cy, minx: bb.minx, miny: bb.miny, maxx: bb.maxx, maxy: bb.maxy })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ── 逐次計算（事前計算に無い窓を、DB ごとに常駐する Python ワーカーで計算する） ─────────────────
function dbPathOf(db: string): string { return path.join(getDbDir(), path.basename(db)) }
function workerFor(db: string): { w?: BlocksWorker; error?: string } {
  const dbPath = dbPathOf(db)
  if (!fs.existsSync(dbPath)) return { error: 'DB が無い: ' + path.basename(db) }
  const distill = distillFor(dbPath)
  if (!distill) return { error: 'この DB には distill サイドカーが無いので逐次計算できません（' + path.basename(db) + '.distill）' }
  return { w: getBlocksWorker(dbPath, distill, blocksPath(db)) }
}

blocksRouter.get('/blocks/warm', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const r = workerFor(db)
  if (!r.w) { res.json({ state: 'unavailable', error: r.error }); return }
  r.w.warm().catch(() => { /* 失敗は status に残る */ })
  res.json(blocksWorkerStatus(r.w))
})

blocksRouter.get('/blocks/status', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  res.json(blocksWorkerStatus(peekBlocksWorker(dbPathOf(db))))
})

const MAX_RANGES = 200000
blocksRouter.post('/blocks/window', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const db = typeof b.db === 'string' ? b.db : ''
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const ranges = Array.isArray(b.ranges) ? (b.ranges as unknown[]) : []
  const okRange = (r: unknown) => Array.isArray(r) && r.length === 3 && typeof r[0] === 'string' && Number.isFinite(r[1]) && Number.isFinite(r[2])
  if (!ranges.length || ranges.length > MAX_RANGES || !ranges.every(okRange)) { res.status(400).json({ error: 'ranges must be [[path, s0, e0], ...]' }); return }
  const r = workerFor(db)
  if (!r.w) { res.status(503).json({ error: r.error }); return }
  const t0 = Date.now()
  try {
    const out = await r.w.window({
      ranges, span: Number(b.span) || 0, afrac: Number(b.afrac) || 0, label: String(b.label ?? ''),
      depth: Number(b.depth) || 0, parent: Number(b.parent ?? -1), pblock: Number(b.pblock ?? -1),
    })
    res.json({ window: out.window, ms: out.ms, total_ms: Date.now() - t0, missing: out.missing ?? 0, state: r.w.state })
  } catch (e) {
    res.status(500).json({ error: String((e as Error)?.message ?? e), state: r.w.state })
  }
})
