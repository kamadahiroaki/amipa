// リボン・道筋・CNV を計算する worker（11-10）。bgClient.ts から要求を受け、JSON の文字列で返す
import { parentPort } from 'worker_threads'
import { runBgOp } from './bgOps'

parentPort!.on('message', (m: { id: number; op: string; q: any }) => {
  const t0 = Date.now(); const r = runBgOp(m.op, m.q); let body: string; let status = r.status
  try { body = JSON.stringify(r.json) } catch (e) { body = JSON.stringify({ error: String(e) }); status = 500 }
  parentPort!.postMessage({ id: m.id, op: m.op, status, body, ms: Date.now() - t0 })
})
