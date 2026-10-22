// 通過サイドカー `<db>.trav` の API（試作）。GET /api/trav/root?db  /api/trav/range?db&x0&x1[&min]  /api/trav/path?db&pid
import { Router } from 'express'
import { loadTrav, travRoot, travRange, travOfPath, repsOfRange } from '../trav'

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
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travRange(t, Math.floor(x0), Math.floor(x1), { minOverlap: Number(q.min) || 0 })) } catch (err) { res.status(500).json({ error: String(err) }) }
})

travRouter.get('/trav/path', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const pid = Number(q.pid)
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json({ path: t.paths[pid], trav: travOfPath(t, pid), reps: repsOfRange(t, [pid]) }) } catch (err) { res.status(500).json({ error: String(err) }) }
})
