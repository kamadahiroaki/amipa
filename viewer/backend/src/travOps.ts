// Traversals の API の中身（11-04 に routes/trav.ts から移した）。worker（travWorker.ts）の中で走らせ、メインスレッドのイベントループを空けておく。
//   以前はメインで同期に計算していたので、遺伝子密度の初回（全ゲノム 74 秒）などの間、グラフの描画（/nodes・/edges）を含む全要求が待たされた。
//   ここの関数はどれも「要求のパラメータ → { status, json }」で、Express に触らない（worker からも、AMIPA_TRAV_WORKER=0 のときはメインからも呼べる）
import path from 'path'
import fs from 'fs'
import { getDbDir } from './db'
import { TravCancelled } from './travCancel'
import { dataAvail } from './availability'
import { loadTrav, travRoot, travRange, travOfPath, repsOfRange, travAtomStats, nodeNamesForRange, travCols, travGenes, travNodeSet, travLocate, travFindGene, travGeneDensity, travReads, travReadName, travNLeaf, travReadSamples, travGeneLof, travMsa, travChroms, travRefX, travPathBp, type Trav } from './trav'

export interface OpResult { status: number; json: any }
type Q = Record<string, any>

export function annPathOf(db: string): string | null { const base = path.join(getDbDir(), path.basename(db)); const cands = [base + '.ann']; try { cands.push(fs.realpathSync(base) + '.ann') } catch { /* ignore */ } return cands.find(c => { try { return fs.existsSync(c) } catch { return false } }) ?? null }

const bad = (m: string): OpResult => ({ status: 400, json: { error: m } })
function withT(q: Q, f: (t: Trav) => any): OpResult {
  if (!q.db) return bad('Missing db')
  const t = loadTrav(String(q.db)); if (!t) return { status: 404, json: { error: 'no .trav sidecar' } }
  return { status: 200, json: f(t) }
}
function range(q: Q): [number, number] | null { const x0 = Number(q.x0), x1 = Number(q.x1); return Number.isFinite(x0) && Number.isFinite(x1) && x1 >= x0 ? [x0, x1] : null }
const minanch = (q: Q) => (q.minanch != null ? Number(q.minanch) : 50)

export const OPS: Record<string, (q: Q) => OpResult> = {
  root: q => withT(q, t => {
    const r: any = travRoot(t)
    try { const base = path.join(getDbDir(), path.basename(String(q.db))); r.hasReads = fs.existsSync(base + '.reads') || (() => { try { return fs.existsSync(fs.realpathSync(base) + '.reads') } catch { return false } })(); r.hasAnn = !!annPathOf(String(q.db)); if (r.hasReads) r.readSamples = travReadSamples(t) } catch { /* */ }
    try { r.avail = dataAvail(String(q.db)); if (r.hasReads && !r.avail.reads.ok) r.hasReads = false } catch { /* 無くても従来どおり */ }
    return r
  }),
  range: q => { const r = range(q); if (!r) return bad('bad x0/x1'); return withT(q, t => travRange(t, Math.floor(r[0]), Math.floor(r[1]), { minOverlap: Number(q.min) || 0, minAnchors: minanch(q), hid: q.hid != null && q.hid !== '' ? Number(q.hid) : undefined, dups: q.dups === '1' })) },
  path: q => withT(q, t => { const pid = Number(q.pid); return { path: t.paths[pid], trav: travOfPath(t, pid), reps: repsOfRange(t, [pid]) } }),
  atoms: q => withT(q, t => travAtomStats(t, minanch(q))),
  pathbp: q => { const it = Array.isArray(q.items) ? (q.items as unknown[]).filter((v): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)) : []; return withT(q, t => ({ items: travPathBp(t, it, Number(q.x0) || 0, Number(q.x1) || 0) })) },
  refx: q => { const a = Number(q.start), b = Number(q.end); if (!Number.isFinite(a) || !Number.isFinite(b)) return bad('bad start/end'); return withT(q, t => travRefX(t, { ref: q.ref ? String(q.ref) : undefined, chrom: q.chrom ? String(q.chrom) : undefined, path: q.path ? String(q.path) : undefined, start: a, end: b })) },
  chroms: q => withT(q, t => { const t0 = Date.now(); const bands = travChroms(t); return { bands, ms: Date.now() - t0 } }),
  nodes: q => withT(q, t => ({ names: nodeNamesForRange(t, Math.floor(Number(q.x0)), Math.floor(Number(q.x1)), Number(q.max) || 5000) })),
  cols: q => { const r = range(q); if (!r) return bad('bad x0/x1'); return withT(q, t => { const o: any = travCols(t, r[0], r[1], Number(q.ncol) || 1000, minanch(q)); if (o.nleaf == null) o.nleaf = travNLeaf(t, r[0], r[1]); return o }) },
  nleaf: q => withT(q, t => ({ nleaf: travNLeaf(t, Number(q.x0), Number(q.x1)) })),
  reads: q => { const r = range(q); if (!r) return bad('bad x0/x1'); return withT(q, t => travReads(t, Math.floor(r[0]), Math.floor(r[1]), Number(q.ncol) || 600, Number(q.max) || 4000, q.samples ? String(q.samples).split(',').filter(Boolean) : null)) },
  genes: q => { const r = range(q); if (!r) return bad('bad x0/x1'); return withT(q, t => travGenes(t, r[0], r[1], minanch(q), q.nodes === '1')) },
  nodeset: q => { const r = range(q); if (!r) return bad('bad x0/x1'); return withT(q, t => travNodeSet(t, r[0], r[1], minanch(q), Math.max(100, Math.min(120000, Number(q.max) || 20000)))) },
  locate: q => withT(q, t => travLocate(t, Array.isArray(q.names) ? (q.names as unknown[]).filter(x => typeof x === 'string') as string[] : String(q.names || '').split(',').filter(x => x))),
  findgene: q => withT(q, t => travFindGene(t, String(q.q || ''), Math.max(1, Math.min(300, Number(q.limit) || 60)))),
  msa: q => withT(q, t => { const t0 = Date.now(); const o: any = travMsa(t, q.req || {}, { label: q.label, flank: q.flank != null ? Number(q.flank) : 0, cap: q.cap != null ? Number(q.cap) : null, maxLeaves: q.maxLeaves != null ? Number(q.maxLeaves) : null, maxTokens: q.maxTokens ? Number(q.maxTokens) : undefined }); if (o && !o.error) o.ms = Date.now() - t0; return o }),
  readname: q => withT(q, t => travReadName(t, Number(q.a))),
  genelof: q => withT(q, t => travGeneLof(t, (Array.isArray(q.gids) ? q.gids : []).filter((x: unknown) => Number.isInteger(x)))),
  genedensity: q => withT(q, t => travGeneDensity(t, Number(q.x0) || 0, Number(q.x1) || 1e12, Number(q.nbin) || 300, minanch(q))),
}

export function runTravOp(op: string, q: Q): OpResult {
  const f = OPS[op]; if (!f) return { status: 404, json: { error: 'unknown op ' + op } }
  try { return f(q) } catch (err) { if (err instanceof TravCancelled) return { status: 499, json: { error: 'cancelled' } }; return { status: 500, json: { error: String(err) } } }
}
