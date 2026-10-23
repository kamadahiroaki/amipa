// 通過サイドカー `<db>.trav` の API（試作）。GET /api/trav/root?db  /api/trav/range?db&x0&x1[&min]  /api/trav/path?db&pid
import { Router } from 'express'
import { loadTrav, travRoot, travRange, travOfPath, repsOfRange, travAtomStats, nodeNamesForRange, travCols, travGenes, travNodeSet, travLocate } from '../trav'

export const travRouter = Router()

travRouter.get('/trav/root', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travRoot(t)) } catch (err) { res.status(500).json({ error: String(err) }) }
})

travRouter.get('/trav/range', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) { res.status(400).json({ error: 'bad x0/x1' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travRange(t, Math.floor(x0), Math.floor(x1), { minOverlap: Number(q.min) || 0, minAnchors: q.minanch != null ? Number(q.minanch) : 50 })) } catch (err) { res.status(500).json({ error: String(err) }) }
})

travRouter.get('/trav/path', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const pid = Number(q.pid)
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json({ path: t.paths[pid], trav: travOfPath(t, pid), reps: repsOfRange(t, [pid]) }) } catch (err) { res.status(500).json({ error: String(err) }) }
})

travRouter.get('/trav/atoms', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travAtomStats(t, q.minanch != null ? Number(q.minanch) : 50)) } catch (err) { res.status(500).json({ error: String(err) }) }
})

travRouter.get('/trav/nodes', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json({ names: nodeNamesForRange(t, Math.floor(x0), Math.floor(x1), Number(q.max) || 5000) }) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 錨の列（ブロックと塩基の間の段）: 範囲を ncol 列に切り、行（通過）ごとの錨の有無・アレル番号・挿入 bp
travRouter.get('/trav/cols', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) { res.status(400).json({ error: 'bad x0/x1' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travCols(t, x0, x1, Number(q.ncol) || 1000, q.minanch != null ? Number(q.minanch) : 50)) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 遺伝子レーン: 範囲に掛かる通過ごとの遺伝子（<db>.genes）を座標に写したもの
travRouter.get('/trav/genes', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) { res.status(400).json({ error: 'bad x0/x1' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travGenes(t, x0, x1, q.minanch != null ? Number(q.minanch) : 50)) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 撮影・試験用: 指定 ms 待ってから 1×1 の GIF を返す（headless firefox で <img src=…/api/sleep?ms=8000> を置くと load がその分遅れ、非同期の描画を待てる）
travRouter.get('/sleep', (req, res) => {
  const ms = Math.max(0, Math.min(20000, Number((req.query as Record<string, string>).ms) || 0))
  setTimeout(() => { res.type('image/gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')) }, ms)
})

// 窓のノード集合（葉の名前。グラフをこの範囲に絞る）: GET /api/trav/nodeset?db&x0&x1[&max][&minanch]
travRouter.get('/trav/nodeset', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) { res.status(400).json({ error: 'bad x0/x1' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travNodeSet(t, x0, x1, q.minanch != null ? Number(q.minanch) : 50, Math.max(100, Math.min(120000, Number(q.max) || 20000)))) } catch (err) { res.status(500).json({ error: String(err) }) }
})
// ノード名 → 座標（グラフ → パネル）: GET /api/trav/locate?db&names=n1,n2  /  POST {db, names:[...]}
function runLocate(res: any, db: string, names: string[]) {
  try { const t = loadTrav(db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travLocate(t, names)) } catch (err) { res.status(500).json({ error: String(err) }) }
}
travRouter.get('/trav/locate', (req, res) => { const q = req.query as Record<string, string>; if (!q.db) { res.status(400).json({ error: 'Missing db' }); return } runLocate(res, q.db, String(q.names || '').split(',').filter(x => x)) })
travRouter.post('/trav/locate', (req, res) => { const b = (req.body ?? {}) as Record<string, unknown>; if (!b.db) { res.status(400).json({ error: 'Missing db' }); return } runLocate(res, String(b.db), Array.isArray(b.names) ? (b.names as unknown[]).filter(x => typeof x === 'string') as string[] : []) })
