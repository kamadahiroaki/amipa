// メイン側: Traversals の要求を travWorker に渡す（11-04）。AMIPA_TRAV_WORKER=0 ならメインでそのまま計算する（切り分け用）。
//   worker が落ちたら待っていた要求には 500 を返し、次の要求で作り直す
import { Worker } from 'worker_threads'
import path from 'path'
import type { Response } from 'express'
import { runTravOp } from './travOps'

const USE_WORKER = (process.env.AMIPA_TRAV_WORKER ?? '1') !== '0'
let w: Worker | null = null; let nextId = 1
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: unknown) => void }>()

function worker(): Worker {
  if (w) return w
  const isTs = __filename.endsWith('.ts')
  const nw = new Worker(path.join(__dirname, isTs ? 'travWorker.ts' : 'travWorker.js'), { execArgv: isTs ? ['-r', 'ts-node/register/transpile-only'] : [] })
  nw.on('message', (m: any) => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m) } })
  nw.on('error', e => console.error('[travworker] error:', e))
  nw.on('exit', code => { console.error(`[travworker] exit ${code}`); if (w === nw) w = null; for (const p of pending.values()) p.reject(new Error('trav worker exited ' + code)); pending.clear() })
  w = nw; return nw
}

export function sendTrav(res: Response, op: string, q: Record<string, any>): void {
  if (!USE_WORKER) { const r = runTravOp(op, q); res.status(r.status).json(r.json); return }
  const id = nextId++
  new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); worker().postMessage({ id, op, q }) })
    .then(m => { if (res.writableEnded || res.destroyed) return; res.status(m.status).type('application/json').send(m.body) })
    .catch(e => { if (!res.headersSent) res.status(500).json({ error: String(e) }) })
}

/** 起動時に worker を立てておく（初回の要求で ts-node の読み込みを待たないように） */
export function warmTrav(): void { if (USE_WORKER) worker() }
