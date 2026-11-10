// メイン側: リボン・道筋・CNV（選んだパスの描画に要るもの）を専用の worker（bgWorker.ts）で計算する（11-10）。
//   以前はメインで同期に計算していて、広めの範囲では数秒〜数十秒、ノード・辺の取得を含む全要求が待たされた。
//   worker は 1 本で要求を順に処理する。順番待ちのうちに接続が切れた要求（画面がパンして取り消した fetch）は計算せずに捨てる。
//   Traversals の worker とは別にする（あちらは遺伝子密度など数十秒の計算が流れる）。AMIPA_BG_WORKER=0 ならメインでそのまま計算する（切り分け用）
import { Worker } from 'worker_threads'
import path from 'path'
import type { Request, Response } from 'express'
import { runBgOp } from './bgOps'

const USE_WORKER = (process.env.AMIPA_BG_WORKER ?? '1') !== '0'
let w: Worker | null = null; let nextId = 1; let busy = false
type Job = { id: number; op: string; q: any; res: Response; gone: boolean }
const queue: Job[] = []
const pending = new Map<number, Job>()

function worker(): Worker {
  if (w) return w
  const isTs = __filename.endsWith('.ts')
  const nw = new Worker(path.join(__dirname, isTs ? 'bgWorker.ts' : 'bgWorker.js'), { execArgv: isTs ? ['-r', 'ts-node/register/transpile-only'] : [] })
  nw.on('message', (m: any) => {
    const j = pending.get(m.id); pending.delete(m.id); busy = false
    if (j && !j.gone && !j.res.writableEnded && !j.res.destroyed) j.res.status(m.status).type('application/json').send(m.body)
    if (m.ms > 1500) console.log(`[bgworker] ${m.op} ${m.ms}ms`)
    pump()
  })
  nw.on('error', e => console.error('[bgworker] error:', e))
  nw.on('exit', code => {
    console.error(`[bgworker] exit ${code}`); if (w === nw) w = null; busy = false
    for (const j of pending.values()) if (!j.res.headersSent) j.res.status(500).json({ error: 'bg worker exited ' + code })
    pending.clear(); pump()
  })
  w = nw; return nw
}
function pump(): void {
  while (!busy && queue.length) {
    const j = queue.shift()!
    if (j.gone || j.res.destroyed) continue   // 取り消された要求は計算しない
    busy = true; pending.set(j.id, j); worker().postMessage({ id: j.id, op: j.op, q: j.q })
  }
}
export function sendBg(req: Request, res: Response, op: string): void {
  const q = { ...(req.query as Record<string, any>) }
  if (!USE_WORKER) { const r = runBgOp(op, q); res.status(r.status).json(r.json); return }
  const j: Job = { id: nextId++, op, q, res, gone: false }
  res.on('close', () => { if (!res.writableEnded) j.gone = true })
  queue.push(j); pump()
}
export function warmBg(): void { if (USE_WORKER) worker() }
