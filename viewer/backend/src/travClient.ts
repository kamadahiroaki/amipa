// メイン側: Traversals の要求を travWorker に渡す（11-04）。AMIPA_TRAV_WORKER=0 ならメインでそのまま計算する（切り分け用）。
//   worker が落ちたら待っていた要求には 500 を返し、次の要求で作り直す
import { Worker } from 'worker_threads'
import path from 'path'
import type { Response } from 'express'
import { runTravOp } from './travOps'

const USE_WORKER = (process.env.AMIPA_TRAV_WORKER ?? '1') !== '0'
let w: Worker | null = null; let nextId = 1
// 11-12: 実行中の要求の取り消し旗（travCancel.ts）。取り消された要求の番号を書くと、worker の重い繰り返しが次の検査点で抜ける
const cancelBuf = new SharedArrayBuffer(4); const cancelFlag = new Int32Array(cancelBuf); let running = 0
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: unknown) => void }>()

function worker(): Worker {
  if (w) return w
  const isTs = __filename.endsWith('.ts')
  const nw = new Worker(path.join(__dirname, isTs ? 'travWorker.ts' : 'travWorker.js'), { execArgv: isTs ? ['-r', 'ts-node/register/transpile-only'] : [], workerData: { cancel: cancelBuf } })
  nw.on('message', (m: any) => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m) } })
  nw.on('error', e => console.error('[travworker] error:', e))
  nw.on('exit', code => { console.error(`[travworker] exit ${code}`); if (w === nw) w = null; tbusy = false; for (const p of pending.values()) p.reject(new Error('trav worker exited ' + code)); pending.clear() })
  w = nw; return nw
}

// 11-11: 要求をメイン側の列に溜め、worker へは 1 本ずつ渡す。以前は届いた順に worker へ投げていたので、全体図の山（locate・小さく速い）が
//   行・遺伝子・リードなどの重い要求の後ろで数十秒待った。軽い要求を先に回し、接続が切れた要求（画面が範囲を変えて取り消した fetch）は計算せずに捨てる
// 11-12: locate（グラフ連動）は範囲の行（range）より後に。初回のスーパーノードの引きが重く、範囲の表示が後ろで待った
const PRIO: Record<string, number> = { root: 0, chroms: 0, atoms: 0, nodes: 1, nleaf: 1, readname: 0, range: 2, path: 2, locate: 3 }   // 無いものは 3
type TJob = { id: number; op: string; q: Record<string, any>; res: Response; gone: boolean; t0: number; pr: number }
const tqueue: TJob[] = []; let tbusy = false
function tpump(): void {
  while (!tbusy && tqueue.length) {
    let bi = 0; for (let i = 1; i < tqueue.length; i++) if (tqueue[i].pr < tqueue[bi].pr) bi = i
    const j = tqueue.splice(bi, 1)[0]
    if (j.gone || j.res.destroyed) continue
    tbusy = true; const tw = Date.now() - j.t0; running = j.id
    new Promise<any>((resolve, reject) => { pending.set(j.id, { resolve, reject }); worker().postMessage({ id: j.id, op: j.op, q: j.q }) })
      .then(m => { if (!(j.res.writableEnded || j.res.destroyed)) j.res.status(m.status).type('application/json').send(m.body); if (m.status === 499) console.log(`[travworker] ${j.op} 取り消し（待ち ${tw} ms 計算 ${m.ms} ms で止めた）`); else if (tw + (m.ms || 0) > 2000) console.log(`[travworker] ${j.op} 待ち ${tw} ms 計算 ${m.ms} ms`) })
      .catch(e => { if (!j.res.headersSent) j.res.status(500).json({ error: String(e) }) })
      .finally(() => { tbusy = false; running = 0; tpump() })
  }
}
export function sendTrav(res: Response, op: string, q: Record<string, any>): void {
  if (!USE_WORKER) { const r = runTravOp(op, q); res.status(r.status).json(r.json); return }
  const j: TJob = { id: nextId++, op, q, res, gone: false, t0: Date.now(), pr: PRIO[op] ?? 3 }
  res.on('close', () => { if (res.writableEnded) return; j.gone = true; if (running === j.id) Atomics.store(cancelFlag, 0, j.id) })
  tqueue.push(j); tpump()
}

/** 起動時に worker を立てておく（初回の要求で ts-node の読み込みを待たないように） */
export function warmTrav(): void { if (USE_WORKER) worker() }
