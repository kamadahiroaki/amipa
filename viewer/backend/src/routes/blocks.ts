import { Router } from 'express'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDb, getDbDir } from '../db'
import { distillFor } from './bubbleMsa'
import { execFile } from 'child_process'
import { AMIPA_PYTHON, amipaScript } from '../pyenv'
import { BlocksWorker, getBlocksWorker, peekBlocksWorker, blocksWorkerStatus } from '../blocksWorker'
import { loadSynteny, rootData, buildWindow, syntenyPath, sitesForRange, sitesForRangeLoci, locateNodes, nodesForAtoms, atomsOfNames, namesForAtomsExact, namesForCols } from '../synteny'
import { tableCols, parseNodes } from '../nodeQuery'
import { openDistill } from '../distill'
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
  try { const syn = loadSynteny(db); if (syn) { const t0 = Date.now(); const r = atomsOfNames(syn, Number(b.layer) || 0, names); res.json({ atoms: r.atoms, fracs: r.fracs, xs: r.xs, xe: r.xe, places: r.places, kinds: r.kinds, nat: syn.nat, ms: Date.now() - t0, tree: true }); return } } catch (e) { res.status(500).json({ error: String(e) }); return }
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
  const tgt = Math.max(50, Number(q.target) || 800)
  const t0 = Date.now()
  try {
    // 葉の集合（a0,a1 / c0,c1 / x0,x1 のどれでも。集合の意味で解決）
    const rsel = resolveNames(syn, syn.maxlayer, q, 200000); if ('error' in rsel) { res.status(400).json({ error: rsel.error }); return }
    const all = rsel.names; const c0 = rsel.c0, c1 = rsel.c1
    const atoms = (q.a0 != null && q.a1 != null) ? syn.atoms.slice(Number(q.a0), Number(q.a1) + 1) : syn.atoms.filter(a => a.c1 >= c0 && a.c0 <= c1); const a0 = atoms.length ? atoms[0].id : -1, a1 = atoms.length ? atoms[atoms.length - 1].id : -1
    const d = getDb(q.db)
    // 矩形は常に葉から（範囲に対して正確）。層は「範囲のノードが target 以下になる最も細かい層」: 葉の件数が target 以下なら葉、超えるときだけ上の層を件数で選ぶ
    const counts: number[] = []; let layer = syn.maxlayer
    if (all.length > tgt && syn.hasSupermap && a0 >= 0) {
      const ds = new Database(syn.file, { readonly: true })
      try {
        const qc = ds.prepare('SELECT COUNT(*) AS n FROM supermap WHERE layer=? AND major BETWEEN ? AND ? AND frac>=0.5')
        let chosen = -1
        for (let L = 0; L < syn.maxlayer; L++) { const n = Number((qc.get(L, a0, a1) as { n: number }).n); counts.push(n); if (n > 0 && n <= tgt) chosen = L; if (n > tgt) break }
        counts.push(all.length)
        layer = chosen >= 0 ? chosen : 0
      } finally { ds.close() }
    } else counts.push(all.length)
    const names: string[] = []; const step = Math.max(1, Math.ceil(all.length / 4000)); for (let i = 0; i < all.length; i += step) names.push(all[i])
    const bboxLayer = syn.maxlayer
    if (!names.length) { res.json({ layer, count: 0, counts, c0, c1, ms: Date.now() - t0 }); return }
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, sx = 0, sy = 0, n = 0
    const sel = (ph: string) => `SELECT xCoord, yCoord FROM nodes WHERE layer_index = ? AND node_name IN (${ph})`
    for (let i = 0; i < names.length; i += 400) { const ch = names.slice(i, i + 400)
      for (const r of d.prepare(sel(ch.map(() => '?').join(','))).all(bboxLayer, ...ch) as { xCoord: number; yCoord: number }[]) { if (r.xCoord == null) continue; minx = Math.min(minx, r.xCoord); maxx = Math.max(maxx, r.xCoord); miny = Math.min(miny, r.yCoord); maxy = Math.max(maxy, r.yCoord); sx += r.xCoord; sy += r.yCoord; n++ } }
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
const SUBGRAPH_MAX = 120000   // 原子 1 個の窓は葉が 9 万（原子 286: 列 82k + 他所から場所を持つ多重）になりうる。超えたら truncated（viewer が警告）
// 窓 → ノード名の集合。優先順: a0,a1（原子の集合。葉は atomnodes、上は atomsuper）→ c0,c1（原子の内側の列範囲。パスのトークン範囲の和）
// → x0,x1（合意座標。重なる原子の集合に直す＝旧 API 互換）。how にどの経路で解決したかを返す
function resolveNames(syn: ReturnType<typeof loadSynteny> & object, layer: number, q: Record<string, string>, max: number): { names: string[]; truncated: boolean; c0: number; c1: number; how: string } | { error: string } {
  const S = syn as any
  if (q.a0 != null && q.a1 != null) {
    const a0 = Number(q.a0), a1 = Number(q.a1); if (!Number.isInteger(a0) || !Number.isInteger(a1) || a1 < a0) return { error: 'a0 ≤ a1 の整数が要ります' }
    const r = namesForAtomsExact(S, layer, a0, a1, max)
    return { names: r.names, truncated: r.truncated, c0: S.atoms[a0]?.c0 ?? -1, c1: S.atoms[Math.min(a1, S.atoms.length - 1)]?.c1 ?? -1, how: r.exact ? 'atoms' : 'atoms-approx' }
  }
  if (q.c0 != null && q.c1 != null) {
    const c0 = Number(q.c0), c1 = Number(q.c1); if (!Number.isInteger(c0) || !Number.isInteger(c1) || c1 < c0) return { error: 'c0 ≤ c1 の整数が要ります' }
    if (layer >= S.maxlayer || !S.hasSupermap) { const r = namesForCols(S, layer, c0, c1, max); return { names: r.names, truncated: r.truncated, c0, c1, how: 'cols' } }
    // 上の層で列範囲: 重なる原子の集合で近似
    const atoms = S.atoms.filter((a: any) => a.c1 >= c0 && a.c0 <= c1); if (!atoms.length) return { names: [], truncated: false, c0, c1, how: 'cols-empty' }
    const r = namesForAtomsExact(S, layer, atoms[0].id, atoms[atoms.length - 1].id, max); return { names: r.names, truncated: r.truncated, c0, c1, how: 'cols→atoms' }
  }
  const x0 = Number(q.x0), x1 = Number(q.x1); if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return { error: 'a0,a1 か c0,c1 か x0,x1 が要ります' }
  const atoms = S.atoms.filter((a: any) => a.x0 < x1 && a.x0 + a.span > x0); if (!atoms.length) return { names: [], truncated: false, c0: -1, c1: -1, how: 'x-empty' }
  const r = namesForAtomsExact(S, layer, atoms[0].id, atoms[atoms.length - 1].id, max); return { names: r.names, truncated: r.truncated, c0: atoms[0].c0, c1: atoms[atoms.length - 1].c1, how: 'x→atoms' }
}
blocksRouter.get('/blocks/subgraph', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db)
  if (!syn) { res.status(404).json({ error: 'この DB には木のサイドカー（.synteny）がありません' }); return }
  const layer = Number(q.layer) || 0
  const max = Math.max(100, Math.min(SUBGRAPH_MAX, Number(q.max) || SUBGRAPH_MAX))
  const t0 = Date.now()
  try {
    // 1) 範囲のノード名（集合の意味）: a0,a1=原子の集合 / c0,c1=原子の内側の列範囲（パスのトークン範囲の和）/ x0,x1=合意座標（旧: 重なる原子に直す）
    const sel = resolveNames(syn, layer, q, max); if ('error' in sel) { res.json({ error: sel.error }); return }
    const { names, truncated, c0, c1, how } = sel
    if (q.names === '1') { res.json({ names, c0, c1, n: names.length, truncated, how, ms: Date.now() - t0 }); return }   // 名前だけ（塗り分け用）
    if (!names.length) { res.json({ nodes: [], outer: [], edges: [], c0, c1, n: 0, truncated, how, ms: Date.now() - t0 }); return }
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
    res.json({ nodes, outer, edges, c0, c1, n: names.length, truncated, how, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ---- 遺伝子サイドカー <db>.genes（annot/build_genes.py）: 株ごとの遺伝子区間（コンティグ bp）と、接合 × 遺伝子の分類 ----
//   POST /api/blocks/genes  body {db, ranges:[[path, s, e], ...], maxGenes?}
//   → {rows:[{path, s, e, genes:[[gid,start,end,strand,type,name,pseudo],...] | null, density:[[bin0, n],...] | null, juncs:[[jid,a2,b2,type,cls,gids...]...]}]}
//   範囲の遺伝子が maxGenes（既定 2,000）を超えるときは密度（bin あたりの件数）だけ返す（全体の窓で 25 万件を送らない）。
//   接合は常に返す（株あたり 80 件程度）。cls は junc_gene の最も強いもの（split > isl > end > inside > near）。
const CLS_ORDER: Record<string, number> = { split: 5, isl: 4, end: 3, inside: 2, near: 1 }
function genesPath(db: string): string | null { const sp = syntenyPath(db); if (!sp) return null; const g = sp.replace(/\.synteny$/, '.genes'); return fs.existsSync(g) ? g : null }
blocksRouter.post('/blocks/genes', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const db = typeof b.db === 'string' ? b.db : ''
  const ranges = Array.isArray(b.ranges) ? (b.ranges as unknown[]).filter(r => Array.isArray(r) && r.length === 3 && typeof r[0] === 'string') as [string, number, number][] : []
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const gp = genesPath(db); const syn = loadSynteny(db)
  if (!gp || !syn) { res.json({ rows: [], error: 'この DB には遺伝子サイドカー（.genes）がありません' }); return }
  const maxGenes = Math.max(100, Math.min(20000, Number(b.maxGenes) || 2000))
  const t0 = Date.now()
  const d = new Database(gp, { readonly: true }); const ds = new Database(syn.file, { readonly: true })
  try {
    const pidOf = new Map(syn.paths.map(p => [p.path, p.pid]))
    const qCount = d.prepare('SELECT COUNT(*) AS n FROM gene WHERE pid=? AND end>=? AND start<=?')
    const qGenes = d.prepare('SELECT gid, start, end, strand, type, name, pseudo FROM gene WHERE pid=? AND end>=? AND start<=? ORDER BY start')
    const qDens = d.prepare('SELECT ((start - ?) / ?) AS bin, COUNT(*) AS n FROM gene WHERE pid=? AND end>=? AND start<=? GROUP BY bin')
    const qJunc = ds.prepare('SELECT rowid AS jid, a2, b2, type FROM junc WHERE pid=? AND b2>=? AND a2<=? ORDER BY a2')
    const qJG = d.prepare('SELECT gid, cls, left, right, mid, dist FROM junc_gene WHERE jid=?'); const qName = d.prepare('SELECT name FROM gene WHERE gid=?')
    const rows: any[] = []
    for (const [path, s, e] of ranges.slice(0, 500)) {
      const pid = pidOf.get(path); if (pid == null) { rows.push({ path, s, e, genes: null, density: null, juncs: [] }); continue }
      const n = Number((qCount.get(pid, s, e) as { n: number }).n)
      let genes: any[] | null = null, density: any[] | null = null
      if (n <= maxGenes) genes = (qGenes.all(pid, s, e) as any[]).map(g => [g.gid, g.start, g.end, g.strand, g.type, g.name, g.pseudo])
      else { const bin = Math.max(1000, Math.ceil((e - s) / 2000)); density = (qDens.all(s, bin, pid, s, e) as any[]).map(r => [s + Number(r.bin) * bin, r.n]); (density as any).bin = bin; density = [[bin, 0], ...density] }
      const juncs: any[] = []
      for (const j of qJunc.all(pid, s, e) as any[]) {
        const jg = qJG.all(j.jid) as any[]; let best = ''; let bo = 0; const gids: number[] = []
        for (const r of jg) { const o = CLS_ORDER[r.cls] || 0; if (o > bo) { bo = o; best = r.cls } if (r.cls !== 'near' && r.cls !== 'inside') gids.push(r.gid) }
        const names = gids.slice(0, 8).map(g => { const r = qName.get(g) as { name: string } | undefined; return r ? r.name : ('#' + g) })
        juncs.push([j.jid, j.a2, j.b2, j.type, best, gids.slice(0, 8), jg.length, names])   // [7] = 遺伝子名（密度モードの行でも名前が出せる）
      }
      rows.push({ path, s, e, n, genes, density, juncs })
    }
    res.json({ rows, maxGenes, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) } finally { d.close(); ds.close() }
})
// ---- 列範囲（アレル行列・塩基の窓）の遺伝子: 遺伝子 → その株のトークン → 列。POST /api/blocks/genes_cols body {db, c0, c1, paths?}
//   行ごとに [gid, name, strand, type, pseudo, start, end, pieces [[c0,c1],...], sn, so, en, eo, part]。
//   pieces = 窓の列範囲に入る列の連なり（再編成で分かれていれば複数）。sn/so, en/eo = 遺伝子の開始・終了の (ノード名, ノード内オフセット)
//   （塩基の段で塩基単位に置く）。part: 1=窓の外から始まる, 2=窓の外で終わる（ビット）
blocksRouter.post('/blocks/genes_cols', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const db = typeof b.db === 'string' ? b.db : ''; const c0 = Number(b.c0), c1 = Number(b.c1)
  if (!db || !Number.isInteger(c0) || !Number.isInteger(c1) || c1 < c0) { res.status(400).json({ error: 'db, c0 ≤ c1 が要ります' }); return }
  const gp = genesPath(db); const syn = loadSynteny(db)
  if (!gp || !syn) { res.json({ rows: [], error: 'この DB には遺伝子サイドカー（.genes）がありません' }); return }
  if (!syn.dcol || !syn.distill || !syn.col2orig) { res.json({ rows: [], error: 'dcol / distill がありません' }); return }
  const want = Array.isArray(b.paths) ? new Set((b.paths as unknown[]).filter(x => typeof x === 'string') as string[]) : null
  const t0 = Date.now(); const dist = openDistill(syn.distill); const d = new Database(gp, { readonly: true })
  try {
    const qG = d.prepare('SELECT g.gid, g.name, g.strand, g.type, g.pseudo, g.start, g.end, t.s0, t.e0 FROM gene g JOIN gene_tok t ON t.gid=g.gid WHERE g.pid=? AND t.e0>? AND t.s0<? ORDER BY t.s0')
    const atomsIn = syn.atoms.filter(a => a.c1 >= c0 && a.c0 <= c1); const aset = new Set(atomsIn.map(a => a.id))
    const rows: any[] = []
    for (const pr of syn.paths) {
      if (want && !want.has(pr.path)) continue
      const pi = dist.pidx.get(pr.path); if (pi == null) continue
      const its = syn.inst[pr.pid].filter(it => aset.has(it.atom)).sort((a, b) => a.s0 - b.s0)
      const runs: { s0: number; e0: number; pos: number }[] = []
      for (const it of its) { const last = runs[runs.length - 1]; if (last && it.s0 <= last.e0) last.e0 = Math.max(last.e0, it.e0); else runs.push({ s0: it.s0, e0: it.e0, pos: it.pos }) }
      const genes: any[] = []
      for (const run of runs) {
        const toks = dist.read(pi, run.s0, run.e0); const n = toks.length
        const colA = new Int32Array(n); const cum = new Float64Array(n + 1); cum[0] = run.pos
        for (let k = 0; k < n; k++) { const c = syn.dcol[toks[k]]; colA[k] = c; cum[k + 1] = cum[k] + (c >= 0 ? syn.colBp[c] : 0) }
        const nameAt = (k: number) => { const c = colA[k]; const o = c >= 0 ? syn.col2orig![c] : -1; return o >= 0 ? 'n' + o : '' }
        for (const g of qG.all(pr.pid, run.s0, run.e0) as any[]) {
          const ks0 = Math.max(g.s0, run.s0), ke0 = Math.min(g.e0, run.e0); if (ke0 <= ks0) continue
          const cols: number[] = []; for (let k = ks0 - run.s0; k < ke0 - run.s0; k++) { const c = colA[k]; if (c >= c0 && c <= c1) cols.push(c) }
          if (!cols.length) continue
          cols.sort((u, v) => u - v); const pieces: [number, number][] = []; for (const c of cols) { const last = pieces[pieces.length - 1]; if (last && c <= last[1] + 2) last[1] = c; else pieces.push([c, c]) }
          // 開始・終了の (ノード, オフセット)。遺伝子が走査範囲の中で始まる／終わるときだけ正確、外なら端のトークンで代用（part に印）
          let part = 0; let sk = g.s0, ek = g.e0 - 1
          if (sk < run.s0) { sk = run.s0; part |= 1 } if (ek >= run.e0) { ek = run.e0 - 1; part |= 2 }
          const so = Math.max(0, (g.start - 1) - cum[sk - run.s0]), eo = Math.max(0, g.end - cum[ek - run.s0] - 1)
          genes.push([g.gid, g.name, g.strand, g.type, g.pseudo, g.start, g.end, pieces, nameAt(sk - run.s0), Math.round(so), nameAt(ek - run.s0), Math.round(eo), part])
        }
      }
      if (genes.length) rows.push({ path: pr.path, hap: pr.hap, genes })
    }
    res.json({ rows, c0, c1, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) } finally { d.close() }
})
// ---- 接合（破断点）の詳細・一覧・塩基 ----
//   GET /api/blocks/junction?db&jid    → 接合カード: 種類・区間・両側の原子と向き・中身・関係する遺伝子（重なり bp と分類）
//   GET /api/blocks/junctions?db       → 全接合の要約（一覧用、DB ごとにキャッシュ）
//   GET /api/blocks/junction_base?db&jid&k → 塩基 MSA に渡すトークン範囲: その株は接合区間 ± k トークン、他株は原子 i の同じ端 ± k
const JCLS = ['split', 'isl', 'end', 'inside', 'near']
function juncRow(syn: any, ds: any, jid: number): any | null { const j = ds.prepare('SELECT rowid AS jid, pid, a, b, a2, b2, wrap, type, ai, di, aj, dj, multi_bp, priv_bp, tier FROM junc WHERE rowid=?').get(jid); if (!j) return null; const pr = syn.paths[j.pid]; return { ...j, path: pr?.path, hap: pr?.hap, atom_i: syn.atoms[j.ai] ? { id: j.ai, x0: syn.atoms[j.ai].x0, span: syn.atoms[j.ai].span } : null, atom_j: syn.atoms[j.aj] ? { id: j.aj, x0: syn.atoms[j.aj].x0, span: syn.atoms[j.aj].span } : null } }
blocksRouter.get('/blocks/junction', (req, res) => {
  const q = req.query as Record<string, string>; const jid = Number(q.jid)
  if (!q.db || !Number.isInteger(jid)) { res.status(400).json({ error: 'db, jid が要ります' }); return }
  const syn = loadSynteny(q.db); const gp = genesPath(q.db); if (!syn) { res.status(404).json({ error: '木のサイドカーがありません' }); return }
  const ds = new Database(syn.file, { readonly: true }); const d = gp ? new Database(gp, { readonly: true }) : null
  try {
    const j = juncRow(syn, ds, jid); if (!j) { res.json({ error: '接合がありません' }); return }
    const rels = d ? (d.prepare('SELECT r.gid, r.cls, r.left, r.right, r.mid, r.dist, g.name, g.start, g.end, g.strand, g.type, g.pseudo, g.product FROM junc_gene r JOIN gene g ON g.gid=r.gid WHERE r.jid=? ORDER BY g.start').all(jid) as any[]) : []
    res.json({ junction: j, genes: rels })
  } catch (err) { res.status(500).json({ error: String(err) }) } finally { ds.close(); if (d) d.close() }
})
const _juncListCache = new Map<string, { key: string; rows: any[] }>()
blocksRouter.get('/blocks/junctions', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const syn = loadSynteny(q.db); const gp = genesPath(q.db); if (!syn) { res.status(404).json({ error: '木のサイドカーがありません' }); return }
  const key = syn.file + '|' + syn.mtime + '|' + (gp ? fs.statSync(gp).mtimeMs : 0); const c = _juncListCache.get(q.db); if (c && c.key === key) { res.json({ rows: c.rows, cached: true }); return }
  const t0 = Date.now(); const ds = new Database(syn.file, { readonly: true }); const d = gp ? new Database(gp, { readonly: true }) : null
  try {
    const qJG = d ? d.prepare('SELECT r.cls, g.name FROM junc_gene r JOIN gene g ON g.gid=r.gid WHERE r.jid=?') : null
    const rows: any[] = []
    for (const j of ds.prepare('SELECT rowid AS jid, pid, a2, b2, wrap, type, ai, di, aj, dj, multi_bp, priv_bp, tier FROM junc ORDER BY pid, a2').iterate() as Iterable<any>) {
      let best = ''; let bo = 99; let nrel = 0; const names: string[] = []
      if (qJG) for (const r of qJG.all(j.jid) as any[]) { nrel++; const o = JCLS.indexOf(r.cls); if (o >= 0 && o < bo) { bo = o; best = r.cls } if ((r.cls === 'split' || r.cls === 'isl' || r.cls === 'end') && names.length < 3) names.push(r.name) }
      const pr = syn.paths[j.pid]
      rows.push([j.jid, j.pid, pr?.hap ?? '', j.type, j.a2, j.b2, j.tier, best, nrel, names, j.ai, j.aj, j.di, j.dj, j.wrap ? 1 : 0])
    }
    _juncListCache.set(q.db, { key, rows }); res.json({ rows, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) } finally { ds.close(); if (d) d.close() }
})
blocksRouter.get('/blocks/junction_base', (req, res) => {
  const q = req.query as Record<string, string>; const jid = Number(q.jid); const K = Math.max(10, Math.min(400, Number(q.k) || 60))
  if (!q.db || !Number.isInteger(jid)) { res.status(400).json({ error: 'db, jid が要ります' }); return }
  const syn = loadSynteny(q.db); if (!syn) { res.status(404).json({ error: '木のサイドカーがありません' }); return }
  const ds = new Database(syn.file, { readonly: true })
  try {
    const j = juncRow(syn, ds, jid); if (!j) { res.json({ error: '接合がありません' }); return }
    const ranges: [string, number, number][] = []
    const mine = syn.inst[j.pid]; const ntok = syn.paths[j.pid].ntok || 1e12
    if (j.wrap) {
      // 環状の継ぎ目（コンティグの起点）をまたぐ接合: この株は「原子 i の最後のインスタンスの端 − K … コンティグ末尾」と「先頭 … 原子 j の最初のインスタンスの端 + K」。
      // 他株は、この株の継ぎ目に最も近い錨（順位）に最も近い錨 ± K（錨の記録は synteny.ts の ANC_REC と同じ 14 バイト: rank u32, tok u32, bp u32, ori u8, tier u8）
      const ANC = 14
      const insI = mine.filter(it => it.atom === j.ai), insJ = mine.filter(it => it.atom === j.aj)
      const a = insI.reduce((b, it) => (!b || it.e0 > b.e0) ? it : b, null as any), bb = insJ.reduce((b, it) => (!b || it.s0 < b.s0) ? it : b, null as any)
      if (a) ranges.push([j.path, Math.max(0, a.e0 - K), ntok]); if (bb) ranges.push([j.path, 0, Math.min(ntok, bb.s0 + K)])
      let seamRank = -1, seamTok = -1
      if (a && a.anc) for (let off = 0; off + ANC <= a.anc.length; off += ANC) { const tok = a.anc.readUInt32LE(off + 4); if (tok > seamTok) { seamTok = tok; seamRank = a.anc.readUInt32LE(off) } }
      if (seamRank >= 0) for (const pr of syn.paths) { if (pr.pid === j.pid) continue; let bt = -1, bd = Infinity
        for (const it of syn.inst[pr.pid]) { if (it.atom !== j.ai && it.atom !== j.aj) continue; const buf = it.anc; if (!buf) continue; for (let off = 0; off + ANC <= buf.length; off += ANC) { const dd = Math.abs(buf.readUInt32LE(off) - seamRank); if (dd < bd) { bd = dd; bt = buf.readUInt32LE(off + 4) } } }
        if (bt >= 0) ranges.push([pr.path, Math.max(0, bt - K), Math.min(pr.ntok || 1e12, bt + K)]) }
      res.json({ ranges, label: `継ぎ目 ${j.type} ${j.hap}`, k: K }); return
    }
    // この株: 原子 i のインスタンスの接合側の端から、原子 j のインスタンスの接合側の端まで（間の接合区間を含む）± K
    const insI = mine.filter(it => it.atom === j.ai), insJ = mine.filter(it => it.atom === j.aj)
    let bestPair: [any, any] | null = null; let bestGap = Infinity
    for (const a of insI) for (const bb of insJ) { const gap = bb.s0 - a.e0; if (gap >= 0 && gap < bestGap) { bestGap = gap; bestPair = [a, bb] } }
    if (bestPair) ranges.push([j.path, Math.max(0, bestPair[0].e0 - K), Math.min(ntok, bestPair[1].s0 + K)])
    else if (insI.length) { const a = insI[0]; const e = j.di ? a.e0 : a.s0; ranges.push([j.path, Math.max(0, e - K), e + K]) }
    // 他の株: 原子 i のインスタンスの同じ端 ± K（その株の並びが続く先が見える）
    for (const pr of syn.paths) { if (pr.pid === j.pid) continue; const ins = syn.inst[pr.pid].filter(it => it.atom === j.ai); if (!ins.length) continue; const a = ins[0]; const e = (j.di === a.dir) ? (j.di ? a.e0 : a.s0) : (j.di ? a.s0 : a.e0); ranges.push([pr.path, Math.max(0, e - K), Math.min(pr.ntok || 1e12, e + K)]) }
    res.json({ ranges, label: `接合 ${j.type} ${j.hap}`, k: K })
  } catch (err) { res.status(500).json({ error: String(err) }) } finally { ds.close() }
})

// 遺伝子の詳細（ホバー・検索）: GET /api/blocks/gene?db&gid  /  ?db&name=<名前>（前方一致、最大 50）
blocksRouter.get('/blocks/gene', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const gp = genesPath(q.db); const syn = loadSynteny(q.db); if (!gp || !syn) { res.json({ error: 'この DB には遺伝子サイドカー（.genes）がありません' }); return }
  const d = new Database(gp, { readonly: true })
  try {
    const pathOf = new Map(syn.paths.map(p => [p.pid, { path: p.path, hap: p.hap }]))
    const sel = 'SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, t.s0, t.e0, a.a0, a.a1 FROM gene g LEFT JOIN gene_tok t ON t.gid=g.gid LEFT JOIN gene_atom a ON a.gid=g.gid'
    const rows = q.gid != null ? d.prepare(sel + ' WHERE g.gid=?').all(Number(q.gid)) : (q.name ? d.prepare(sel + " WHERE g.name LIKE ? ORDER BY g.name, g.pid LIMIT 50").all(q.name + '%') : [])
    const out = (rows as any[]).map(g => ({ ...g, ...(pathOf.get(g.pid) || {}), juncs: (d.prepare('SELECT jid, cls, left, right, mid, dist FROM junc_gene WHERE gid=?').all(g.gid) as any[]) }))
    res.json({ genes: out })
  } catch (err) { res.status(500).json({ error: String(err) }) } finally { d.close() }
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
