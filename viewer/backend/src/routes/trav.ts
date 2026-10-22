// 通過サイドカー `<db>.trav` の API（試作）。GET /api/trav/root?db  /api/trav/range?db&x0&x1[&min]  /api/trav/path?db&pid
import { Router } from 'express'
import { loadTrav, travRoot, travRange, travOfPath, repsOfRange, travAtomStats, nodeNamesForRange, travCols } from '../trav'

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
