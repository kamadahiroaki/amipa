import { Router } from 'express'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDb, getDbDir } from '../db'
import { distillFor } from './bubbleMsa'
import { execFile } from 'child_process'
import { AMIPA_PYTHON, amipaScript } from '../pyenv'
import { BlocksWorker, getBlocksWorker, peekBlocksWorker, blocksWorkerStatus } from '../blocksWorker'
import { loadSynteny, rootData, buildWindow, syntenyPath, sitesForRange, sitesForRangeLoci, locateNodes, nodesForAtoms, atomsOfNames } from '../synteny'
import { tableCols, parseNodes } from '../nodeQuery'
import { edgeExtraSel } from '../edgeQuery'

// 多解像度 MSA（共線ブロック）のサイドカーを配る。
//   GET /api/blocks?db=X.db            … `<db>.blocks.json`（functions/msa_lod/70_hier_build.py の出力）をそのまま返す
//   GET /api/blocks/warm?db  … 逐次計算ワーカーを起こして Ctx を温める（状態を返す）。パネルを開いた時に呼ぶ
//   GET /api/blocks/status?db … ワーカーの状態
//   POST /api/blocks/nodemap  … {db, layer, names} → ノードが属する全体窓・最細段のブロック番号（塗り分け用）
//   POST /api/blocks/window   … {db, ranges:[[path,s0,e0],…], span, afrac, label, depth, parent, pblock}
//       … 事前計算に無い窓をその場で計算して返す（blocksWorker.ts → scripts/blocks/worker.py）
//   GET /api/blocks/tree?db … 系統樹の葉の順（ハプロタイプ名）。パスパネルの「系統順」
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
  // 窓に依らない一つの木（<db>.synteny）があればそれを優先（plans/msa-multires.md §15）。根の窓を木から作って返す
  try { const syn = loadSynteny(db); if (syn) { res.json(rootData(syn)); return } } catch (err) { res.status(500).json({ error: 'synteny: ' + String(err) }); return }
  const p = blocksPath(db)
  if (!p) { res.json({ error: 'この DB には多解像度 MSA のサイドカーがありません（' + path.basename(db) + BLOCKS_SUFFIX + '）' }); return }
  res.type('application/json'); fs.createReadStream(p).pipe(res)
})

blocksRouter.get('/blocks/has', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  res.json({ has: !!blocksPath(db) || !!syntenyPath(db) })
})

// アレル行列（変異の段）: GET /api/blocks/sites?db&c0&c1 または &x0&x1 → サイト×株のアレル番号（synteny.ts sitesForRange）
blocksRouter.get('/blocks/sites', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db)
  if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const t0 = Date.now()
  try {
    const num = (v?: string) => (v != null && v !== '' ? Number(v) : undefined)
    const fn = q.method === 'cols' ? sitesForRange : sitesForRangeLoci     // 既定は座位（錨の間）ベース。cols は比較用の旧方式
    const r = fn(syn, { c0: num(q.c0), c1: num(q.c1), x0: num(q.x0), x1: num(q.x1) }, q.max ? Number(q.max) : undefined)
    res.json({ ...r, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 合意列の範囲 → 各パスのトークン範囲（塩基 MSA へ渡す）。scripts/blocks/colrange_tokens.py（distill の p_tok と木の dcol だけ）
//   GET /api/blocks/tokranges?db&c0&c1 → {ranges:[[path,s0,e0],…], ncols}
blocksRouter.get('/blocks/tokranges', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const sp = syntenyPath(q.db); if (!sp) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const dbPath = path.join(getDbDir(), path.basename(q.db)); const distill = distillFor(dbPath)
  if (!distill) { res.json({ error: 'distill サイドカーがありません' }); return }
  const c0 = Number(q.c0), c1 = Number(q.c1)
  if (!Number.isFinite(c0) || !Number.isFinite(c1) || c1 < c0) { res.status(400).json({ error: 'c0 ≤ c1 が要ります' }); return }
  const t0 = Date.now()
  execFile(AMIPA_PYTHON, [amipaScript('blocks/colrange_tokens.py'), '--distill', distill, '--synteny', sp, '--c0', String(Math.floor(c0)), '--c1', String(Math.ceil(c1))],
    { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { res.json({ error: 'トークン範囲の計算に失敗: ' + (stderr ? String(stderr).slice(0, 300) : String(err)) }); return }
      try { const j = JSON.parse(stdout); j.ms = Date.now() - t0; res.json(j) } catch (e) { res.json({ error: '出力を解釈できません: ' + String(e) }) }
    })
})

// 原子の範囲 → その層のノード名（木の経路。参照座標を使わない）: GET /api/blocks/nodes2?db&layer&a0&a1
blocksRouter.get('/blocks/nodes2', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db); if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const a0 = Number(q.a0), a1 = Number(q.a1); if (!Number.isFinite(a0) || !Number.isFinite(a1)) { res.status(400).json({ error: 'a0, a1 が要ります' }); return }
  const t0 = Date.now()
  try { const r = nodesForAtoms(syn, Number(q.layer) || 0, Math.max(0, a0), Math.min(syn.nat - 1, a1)); res.json({ names: r.names, truncated: r.truncated, ms: Date.now() - t0 }) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ノード → 木の葉: GET /api/blocks/locate?db&names=n1,n2 → {nodes:[{name, col, x, kind, nplace, places:[{atom|gap, x0, x1}]}]}
blocksRouter.get('/blocks/locate', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db); if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const names = String(q.names || '').split(',').filter(x => x).slice(0, 2000)
  try { res.json(locateNodes(syn, names)) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 木の範囲問い合わせ: 合意座標 [x0, x1] の窓（段は 30/12/5 ブロックの予算切り）。ブロックの内側へ・列見出しのドラッグの両方がこれ
blocksRouter.get('/blocks/range', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db)
  if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) { res.status(400).json({ error: 'x0 < x1 が要ります' }); return }
  const t0 = Date.now()
  try {
    const w = buildWindow(syn, x0, x1, { label: q.label || `${x0}–${x1}`, depth: Number(q.depth || 1), parent: Number(q.parent ?? 0), pblock: Number(q.pblock ?? -1),
                                          tierMax: q.tier != null ? Number(q.tier) : undefined })
    if (w.error) { res.json({ error: w.error }); return }
    res.json({ window: w, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
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

// ── サイドカーの系統樹（葉の順）だけを返す。パスパネルの「系統順」に使う。JSON 全体（〜数 MB）は読まない ──
const treeCache = new Map<string, { mtime: number; haps: string[] }>()
blocksRouter.get('/blocks/tree', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  try { const syn = loadSynteny(db); if (syn) { const t = syn.tree; res.json({ haps: (t && Array.isArray(t.order) && Array.isArray(t.haps)) ? t.order.map((i: number) => t.haps[i]) : syn.hapOrder }); return } } catch { /* fall through */ }
  const p = blocksPath(db)
  if (!p) { res.json({ haps: [] }); return }
  try {
    const mtime = fs.statSync(p).mtimeMs
    const c = treeCache.get(p)
    if (c && c.mtime === mtime) { res.json({ haps: c.haps }); return }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const t = j?.tree
    const haps: string[] = (t && Array.isArray(t.order) && Array.isArray(t.haps)) ? t.order.map((i: number) => t.haps[i]) : []
    treeCache.set(p, { mtime, haps })
    res.json({ haps })
  } catch (err) { res.status(500).json({ error: String(err) }) }
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

// ノード名 → 全体窓・最細段のブロック番号（常駐ワーカー。葉は合意列の位置、スーパーノードは配下の葉の多数決）。
// グラフの塗り分けで、参照座標を持たないノード（chrY pggb の葉の 78%）や外接箱の広いスーパーノードを塗るために使う。
//   POST /api/blocks/nodemap  body {db, layer, names:[…]}  → {ranks:[…], nblocks}
const MAX_NAMES = 20000
blocksRouter.post('/blocks/nodemap', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const db = typeof b.db === 'string' ? b.db : ''
  const names = Array.isArray(b.names) ? (b.names as unknown[]).filter(x => typeof x === 'string') as string[] : []
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  if (!names.length || names.length > MAX_NAMES) { res.status(400).json({ error: `names must be 1..${MAX_NAMES}` }); return }
  // 木のサイドカーがある DB: 旧ワーカーの順位は木のブロック番号と合わないので使わない（-1 = 不明。参照区間の規則だけで塗る）。
  // 木からの葉→原子区間の対応は後で（plans/msa-multires.md §15.2 の 3）
  try { const syn = loadSynteny(db); if (syn) { const t0 = Date.now(); const r = atomsOfNames(syn, Number(b.layer) || 0, names); res.json({ atoms: r.atoms, fracs: r.fracs, xs: r.xs, xe: r.xe, nat: syn.nat, ms: Date.now() - t0, tree: true }); return } } catch (e) { res.status(500).json({ error: String(e) }); return }
  const r = workerFor(db)
  if (!r.w) { res.status(503).json({ error: r.error }); return }
  try {
    const out = await r.w.warm().then(() => r.w!.request('nodemap', { layer: Number(b.layer) || 0, names }))
    res.json({ ranks: out.ranks, nblocks: out.nblocks, ms: out.ms })
  } catch (e) { res.status(500).json({ error: String((e as Error)?.message ?? e) }) }
})



// ---- 合意座標の範囲 → グラフを寄せる先（層と外接矩形）。/blocks/view の参照座標版に代わる、木の窓のための「グラフ連動」----
//   GET /api/blocks/bbox?db&x0&x1[&target]
//   層: 範囲に属するノードが target（既定 800）以下になる最も細かい層（/blocks/view と同じ考え）。葉は列数、上は supermap の件数。
//   矩形: その層の範囲のノード座標の min/max（葉は列を等間隔に最大 4,000 本標本化）。参照に無い島でも正しく寄る。
blocksRouter.get('/blocks/bbox', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db)
  if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1); const tgt = Math.max(50, Number(q.target) || 800)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) { res.status(400).json({ error: 'x0 < x1 が要ります' }); return }
  const t0 = Date.now()
  try {
    const lb = (v: number) => { let lo = 0, hi = syn.colX.length; while (lo < hi) { const m = (lo + hi) >> 1; if (syn.colXc[m + 1] <= v) lo = m + 1; else hi = m } return lo }
    const c0 = lb(x0), c1 = Math.max(c0, lb(x1) - 1)
    const c2o = syn.col2orig; if (!c2o) { res.json({ error: 'サイドカーに col2orig がありません' }); return }
    const atoms = syn.atoms.filter(a => a.x0 < x1 && a.x0 + a.span > x0); const a0 = atoms.length ? atoms[0].id : -1, a1 = atoms.length ? atoms[atoms.length - 1].id : -1
    const d = getDb(q.db)
    // 層ごとの件数（細かい層ほど増える。target を超えたら打ち切り）
    const counts: number[] = []; let layer = syn.maxlayer
    const ds = new Database(syn.file, { readonly: true })
    try {
      const qc = ds.prepare('SELECT COUNT(*) AS n FROM supermap WHERE layer=? AND major BETWEEN ? AND ? AND frac>=0.5')
      let chosen = -1
      for (let L = 0; L <= syn.maxlayer; L++) {
        let n = 0
        if (L >= syn.maxlayer || !syn.hasSupermap) { for (let c = c0; c <= c1 && c < c2o.length; c++) if (c2o[c] >= 0) n++ }
        else if (a0 >= 0) n = Number((qc.get(L, a0, a1) as { n: number }).n)
        counts.push(n)
        if (n > 0 && n <= tgt) chosen = L
        if (n > tgt) break
      }
      layer = chosen >= 0 ? chosen : (counts.findIndex(n => n > 0) >= 0 ? counts.findIndex(n => n > 0) : syn.maxlayer)
    } finally { ds.close() }
    // その層の名前（葉は等間隔に標本化）
    let names: string[] = []
    if (layer >= syn.maxlayer || !syn.hasSupermap) {
      const all: string[] = []; for (let c = c0; c <= c1 && c < c2o.length; c++) if (c2o[c] >= 0) all.push('n' + c2o[c])
      const step = Math.max(1, Math.ceil(all.length / 4000)); for (let i = 0; i < all.length; i += step) names.push(all[i])
    } else if (a0 >= 0) names = nodesForAtoms(syn, layer, a0, a1, 4000, 0.5).names
    if (!names.length) { res.json({ layer, count: 0, counts, c0, c1, ms: Date.now() - t0 }); return }
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, sx = 0, sy = 0, n = 0
    const sel = (ph: string) => `SELECT xCoord, yCoord FROM nodes WHERE layer_index = ? AND node_name IN (${ph})`
    for (let i = 0; i < names.length; i += 400) { const ch = names.slice(i, i + 400)
      for (const r of d.prepare(sel(ch.map(() => '?').join(','))).all(layer, ...ch) as { xCoord: number; yCoord: number }[]) { if (r.xCoord == null) continue; minx = Math.min(minx, r.xCoord); maxx = Math.max(maxx, r.xCoord); miny = Math.min(miny, r.yCoord); maxy = Math.max(maxy, r.yCoord); sx += r.xCoord; sy += r.yCoord; n++ } }
    if (!n) { res.json({ layer, count: 0, counts, c0, c1, ms: Date.now() - t0 }); return }
    res.json({ layer, count: n, counts, c0, c1, minx, miny, maxx, maxy, cx: sx / n, cy: sy / n, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ---- 範囲駆動の部分グラフ（Blocks の窓の範囲だけをグラフに出す「絞りモード」の取得経路）----
//   GET /api/blocks/subgraph?db&layer&x0&x1[&max]
//   空間問い合わせをせず、窓の合意座標の範囲からノード名を決めて主キーで引く。コストは窓の広さに比例し、ビューポートの密度に依らない。
//   葉の層: 列範囲 [c0,c1]（colXc）→ col2orig の名前。上の層: 範囲に重なる原子 → supermap（多数派の場所、frac ≥ 0.5）。
//   辺: 端点が集合に入る辺を source / target の索引で引く（PK (layer,source,target) と idx_edges_ts）。片端が集合の外の辺は
//   その端点ノード（outer）も返す（viewer は隠して、辺を橙の切れ端にする）。座標は返さず src_sign/tgt_sign（viewer が復元）。
const SUBGRAPH_MAX = 20000
blocksRouter.get('/blocks/subgraph', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db)
  if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const layer = Number(q.layer) || 0; const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) { res.status(400).json({ error: 'x0 < x1 が要ります' }); return }
  const max = Math.max(100, Math.min(SUBGRAPH_MAX, Number(q.max) || SUBGRAPH_MAX))
  const t0 = Date.now()
  try {
    // 1) 範囲のノード名
    let names: string[] = []; let truncated = false; let c0 = -1, c1 = -1
    const lb = (v: number) => { let lo = 0, hi = syn.colX.length; while (lo < hi) { const m = (lo + hi) >> 1; if (syn.colXc[m + 1] <= v) lo = m + 1; else hi = m } return lo }
    if (layer >= syn.maxlayer || !syn.hasSupermap) {
      c0 = lb(x0); c1 = Math.max(c0, lb(x1) - 1)
      const c2o = syn.col2orig; if (!c2o) { res.json({ error: "サイドカーに col2orig がありません（tree.py を更新して作り直す）" }); return }
      for (let c = c0; c <= c1 && c < c2o.length; c++) { const o = c2o[c]; if (o >= 0) { if (names.length >= max) { truncated = true; break } names.push('n' + o) } }
    } else {
      const atoms = syn.atoms.filter(a => a.x0 < x1 && a.x0 + a.span > x0)
      if (atoms.length) { const r = nodesForAtoms(syn, layer, atoms[0].id, atoms[atoms.length - 1].id, max, 0.5); names = r.names; truncated = r.truncated }
    }
    if (!names.length) { res.json({ nodes: [], outer: [], edges: [], c0, c1, n: 0, truncated, ms: Date.now() - t0 }); return }
    // 2) ノード（主キーで点引き）
    const d = getDb(q.db)
    const cols = tableCols(d, 'nodes')
    const opt = ['coverage', 'cov_hist', 'haplotype', 'ref_contig_id', 'ref_bp', 'ref_bp_end', 'is_anchor', 'ref_multi', 'ref_strand', 'comp_id', 'kind'].filter(c => cols.has(c)).map(c => `, n.${c}`).join('')
    const selNodes = (ph: string) => `SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size, n.xCoord, n.yCoord, n.angle, n.radius, n.color${opt}, n.layer_index AS layer FROM nodes n WHERE n.layer_index = ? AND n.node_name IN (${ph})`
    const fetchNodes = (list: string[]) => { const out: any[] = []; for (let i = 0; i < list.length; i += 400) { const ch = list.slice(i, i + 400); out.push(...d.prepare(selNodes(ch.map(() => '?').join(','))).all(layer, ...ch)) } return parseNodes(out) }
    const nodes = fetchNodes(names)
    const inSet = new Set(nodes.map((n: any) => n.node_name as string))
    // 3) 辺（端点の索引で引き、rowid で重複を落とす）
    const edges: any[] = []; const seen = new Set<number>()
    const ex = edgeExtraSel(d)   // edge_hb（edge_contig_cov.hb）があれば相乗り: 絞りモードでもパス多重度の太さが出る
    const selE = (side: string, ph: string) => `SELECT e.rowid AS id, e.source, e.target, e.src_sign, e.tgt_sign${ex.sel} FROM edges e${ex.join} WHERE e.layer_index = ? AND e.${side} IN (${ph})`
    const list = [...inSet]
    for (const side of ['source', 'target']) for (let i = 0; i < list.length; i += 400) {
      const ch = list.slice(i, i + 400)
      for (const e of d.prepare(selE(side, ch.map(() => '?').join(','))).all(layer, ...ch) as any[]) { if (!seen.has(e.id)) { seen.add(e.id); edges.push(e) } }
    }
    // 4) 集合の外の端点（切れ端用）
    const outerNames = new Set<string>(); for (const e of edges) { if (!inSet.has(e.source)) outerNames.add(e.source); if (!inSet.has(e.target)) outerNames.add(e.target) }
    const outer = fetchNodes([...outerNames].slice(0, max))
    res.json({ nodes, outer, edges, c0, c1, n: names.length, truncated, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
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
