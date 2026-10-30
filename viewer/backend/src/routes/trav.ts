import path from 'path'
import { getDbDir } from '../db'
import { amipaScript } from '../pyenv'
import { runScript } from '../pyRunner'
import { distillFor } from './bubbleMsa'
// 通過サイドカー `<db>.trav` の API（試作）。GET /api/trav/root?db  /api/trav/range?db&x0&x1[&min]  /api/trav/path?db&pid
import { Router } from 'express'
import fs from 'fs'
import Database from 'better-sqlite3'
import { loadTrav, travRoot, travRange, travOfPath, repsOfRange, travAtomStats, nodeNamesForRange, travCols, travGenes, travNodeSet, travLocate, travFindGene, travGeneDensity, genesPathOf, travReads, travNLeaf, travReadSamples } from '../trav'

export const travRouter = Router()

travRouter.get('/trav/root', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } { const r: any = travRoot(t); try { const fs = require('fs'); const base = path.join(getDbDir(), path.basename(q.db)); r.hasReads = fs.existsSync(base + '.reads') || (() => { try { return fs.existsSync(fs.realpathSync(base) + '.reads') } catch { return false } })(); r.hasAnn = !!annPathOf(q.db); if (r.hasReads) r.readSamples = travReadSamples(t) } catch { /* */ } res.json(r) } } catch (err) { res.status(500).json({ error: String(err) }) }
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
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } { const r: any = travCols(t, x0, x1, Number(q.ncol) || 1000, q.minanch != null ? Number(q.minanch) : 50); if (r.nleaf == null) r.nleaf = travNLeaf(t, x0, x1); res.json(r) } } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ブロック・錨の列の段のリード: 列ごとのサンプル別の深さと、整列ごとの掛かる列の片（GET /api/trav/reads?db&x0&x1&ncol）
travRouter.get('/trav/nleaf', (req, res) => { const q = req.query as Record<string, string>; if (!q.db) { res.status(400).json({ error: 'Missing db' }); return } try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json({ nleaf: travNLeaf(t, Number(q.x0), Number(q.x1)) }) } catch (err) { res.status(500).json({ error: String(err) }) } })
travRouter.get('/trav/reads', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) { res.status(400).json({ error: 'bad x0/x1' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travReads(t, Math.floor(x0), Math.floor(x1), Number(q.ncol) || 600, Number(q.max) || 4000, q.samples ? String(q.samples).split(',').filter(Boolean) : null)) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 遺伝子レーン: 範囲に掛かる通過ごとの遺伝子（<db>.genes）を座標に写したもの
travRouter.get('/trav/genes', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const x0 = Number(q.x0), x1 = Number(q.x1)
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) { res.status(400).json({ error: 'bad x0/x1' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travGenes(t, x0, x1, q.minanch != null ? Number(q.minanch) : 50, q.nodes === '1')) } catch (err) { res.status(500).json({ error: String(err) }) }
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

// 遺伝子名の検索: GET /api/trav/findgene?db&q[&limit]
travRouter.get('/trav/findgene', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travFindGene(t, String(q.q || ''), Math.max(1, Math.min(300, Number(q.limit) || 60)))) } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ---- 参照座標の注釈（<db>.ann: RepeatMasker・GIAB の変異とベンチマーク領域。build_ann.py で作る）----
//   GET /api/trav/ann?db&contig&s&e  → 区間 [s, e)（参照の 0 始まり）に掛かる反復・変異・ベンチマーク領域。塩基の段が列の参照位置に写して描く
function annPathOf(db: string): string | null { const base = path.join(getDbDir(), path.basename(db)); const cands = [base + '.ann']; try { cands.push(fs.realpathSync(base) + '.ann') } catch { /* ignore */ } return cands.find(c => { try { return fs.existsSync(c) } catch { return false } }) ?? null }
const annDbs = new Map<string, Database.Database | null>()
function annDbOf(db: string): Database.Database | null { if (!annDbs.has(db)) { const f = annPathOf(db); annDbs.set(db, f ? new Database(f, { readonly: true }) : null) } return annDbs.get(db)! }
travRouter.get('/trav/ann', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db || !q.contig) { res.status(400).json({ error: 'Missing db/contig' }); return }
  const d = annDbOf(q.db); if (!d) { res.status(404).json({ error: 'no .ann sidecar' }); return }
  const s = Math.max(0, Number(q.s) || 0), e = Number(q.e) || 0
  if (!(e > s) || e - s > 5_000_000) { res.status(400).json({ error: 'range must be 1 bp – 5 Mb' }); return }
  try {
    const meta = Object.fromEntries((d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]))
    const ml = Number(meta.maxlen_rmsk) || 0, mb = Number(meta.maxlen_bench) || 0
    const rmsk = ml ? d.prepare('SELECT s, e, strand, name, cls, fam, div FROM rmsk WHERE contig = ? AND s >= ? AND s < ? AND e > ? ORDER BY s').all(q.contig, s - ml, e, s) : []
    const vars = d.prepare('SELECT sample, pos, ref, alt, gt FROM var WHERE contig = ? AND pos >= ? AND pos < ? ORDER BY pos').all(q.contig, s - 200, e)
    const samples = (d.prepare('SELECT DISTINCT sample FROM bench').all() as { sample: string }[]).map(r => r.sample)
    const bench: Record<string, [number, number][]> = {}
    for (const sm of samples) bench[sm] = (d.prepare('SELECT s, e FROM bench WHERE sample = ? AND contig = ? AND s >= ? AND s < ? AND e > ? ORDER BY s').all(sm, q.contig, s - mb, e, s) as { s: number; e: number }[]).map(r => [r.s, r.e])
    res.json({ ref: meta.ref_key, contig: q.contig, s, e, rmsk, vars, bench, samples, src: { rmsk: meta.src_rmsk, vcf: samples.map(sm => meta['src_vcf_' + sm]) } })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

travRouter.get('/trav/genedensity', (req, res) => {
  const q = req.query as Record<string, string>; if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  try { const t = loadTrav(q.db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return } res.json(travGeneDensity(t, Number(q.x0) || 0, Number(q.x1) || 1e12, Number(q.nbin) || 300, q.minanch != null ? Number(q.minanch) : 50)) } catch (err) { res.status(500).json({ error: String(err) }) }
})
// 機能喪失の目安（5）: 遺伝子（写しを含む）ごとに CDS を株の配列から組み立てて翻訳し、参照と比べる（scripts/gene_lof.py を常駐の python で）
travRouter.post('/trav/genelof', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>; const db = typeof b.db === 'string' ? b.db : ''; const gids = Array.isArray(b.gids) ? (b.gids as unknown[]).filter(x => Number.isInteger(x)).slice(0, 5000) : []
  if (!db || !gids.length) { res.status(400).json({ error: 'db と gids が要る' }); return }
  const t = loadTrav(db); if (!t) { res.status(404).json({ error: 'no .trav sidecar' }); return }
  const dbPath = path.join(getDbDir(), path.basename(db)); const distill = distillFor(dbPath); const gp = genesPathOf(t)
  if (!distill || !gp) { res.json({ error: 'distill か .genes が無い' }); return }
  runScript(amipaScript('gene_lof.py'), ['--db', dbPath, '--distill', distill, '--genes', gp], JSON.stringify({ gids }), 60000).then(r => {
    if (!r.ok) { res.json({ error: '失敗: ' + r.err.slice(-300) }); return } try { res.json(JSON.parse(r.out)) } catch (e) { res.json({ error: String(e) }) } }).catch(e => res.json({ error: String(e?.message ?? e) }))
})
