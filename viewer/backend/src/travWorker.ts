// Traversals の計算を走らせる worker（11-04）。メインは要求を投げて JSON の文字列を受け取り、そのまま返すだけ（パースも生成もしない）。
//   .trav の配列（全ゲノムで約 2 GB）はこの worker だけが持つ。1 本なので Traversals の要求どうしは順番に処理されるが、グラフの描画は止めない
//   11-12: 画面が取り消した要求は、共有の旗（travCancel.ts）で計算の途中で止める
import { parentPort, workerData } from 'worker_threads'
import { runTravOp } from './travOps'
import { setCancelBuffer, beginJob, endJob } from './travCancel'

if (workerData?.cancel) setCancelBuffer(workerData.cancel as SharedArrayBuffer)
parentPort!.on('message', (m: { id: number; op: string; q: any }) => {
  const t0 = Date.now(); beginJob(m.id); let r
  try { r = runTravOp(m.op, m.q) } finally { endJob() }
  let body: string; let status = r.status
  try { body = JSON.stringify(r.json) } catch (e) { body = JSON.stringify({ error: String(e) }); status = 500 }
  parentPort!.postMessage({ id: m.id, status, body, ms: Date.now() - t0 })
})
