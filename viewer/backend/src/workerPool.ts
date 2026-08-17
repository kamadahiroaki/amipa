// DB 読み取り worker のプール。
//
// 目的は「メインスレッドのイベントループを空けておく」こと。better-sqlite3 は同期 API なので
// メインで走らせると重いクエリの間サーバ全体が無反応になり、切断検知も中断もできなかった
// （実測: WG 273GB で 1 本 15 秒占有、放棄分が積み上がって 27.9 秒）。
//
// 三段構えで守る:
//   1. **投入前**  … 既に切断されていたらそもそも worker へ渡さない（キューにいる間はメインが
//                    動いているので `res.closed` が即座に正しい。server.ts の setTimeout 芸は不要）
//   2. **実行中**  … SharedArrayBuffer のキャンセル旗を立てる。worker の guardedAll が
//                    iterate ループ内で Atomics.load して break する＝**走行中のクエリを中断できる**
//   3. **戻り値**  … 直列化は worker 側。メインは ArrayBuffer をそのまま res へ流すだけで、
//                    76,898 行の JSON を**メインでパースも生成もしない**（24.7MB でも詰まらない）
//
// 進捗の受け渡しも同じ SharedArrayBuffer で行う。worker がキャンセル旗を読むのと同じ刻み
// (TIME_CHECK_EVERY 行ごと)で処理済み行数を Atomics.store するだけ＝**通信も同期も不要**。
// メインは Atomics.load で読める。メインループが空いたので軽いポーリング endpoint
// (/api/fetch_progress)が普通に応答できるようになった（従来は同期ブロックで原理的に不可能）。
// スロット割り当て: 1 worker あたり Int32 × SLOT_WORDS。
//   [0]=キャンセル旗 [1]=処理済み行数 [2]=想定総行数(0=不明) [3]=フェーズ(0=なし/1=走査/2=バッチ)
import { Worker } from 'worker_threads'
import path from 'path'
import type { Response } from 'express'
import type { QueryJob } from './dbJobs'

// worker 数。DB 接続がワーカーごとに増える（cache_size も worker ごと）ので控えめが既定。
// 読み取りは並列化しても Lustre の I/O 律速なので、数を増やすより「メインを空ける」ことが本質。
const N_WORKERS = (() => {
  const v = Number((process.env.AMIPA_DB_WORKERS ?? process.env.GGB_DB_WORKERS))
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2
})()

interface Pending {
  job: QueryJob
  res: Response
  pid?: string
  resolve: (r: WorkerReply) => void
  reject: (e: unknown) => void
}
export const SLOT_WORDS = 4
export const SLOT_CANCEL = 0, SLOT_ROWS = 1, SLOT_TOTAL = 2, SLOT_PHASE = 3

export interface WorkerReply {
  body: Buffer
  /** 本文の Content-Encoding。worker 側で圧縮済みなら 'gzip'。呼び側はそのままヘッダに載せる。 */
  enc?: 'gzip'
  status: number
  rows?: number
  ms?: number
  truncated?: string | null
  layer?: number | null
}

/** クライアントが gzip 本文を受け付けるか。worker に圧縮させるかの判断に使う。 */
function acceptsGzip(res: Response): boolean {
  const ae = (res.req as any)?.headers?.['accept-encoding']
  return typeof ae === 'string' && /(^|,)\s*(gzip|\*)\s*(;|,|$)/.test(ae)
}

interface Slot {
  w: Worker
  idx: number
  busy: Pending | null
  killTimer?: ReturnType<typeof setTimeout> | null
  killing?: boolean          // 意図的に terminate 中（exit を「異常死」と扱わない）
}

// キャンセル旗を立ててから強制終了するまでの猶予（ms）。
//
// 旗で止まるのは iterate ループの中にいるときだけ。SQL の内部で回っている区間
// （集計・ソート・サブクエリの実体化など）は旗を見る機会が無いので止まらない。
// 時間ガードを 5 分まで緩めた今、そこに引っかかると worker が長時間塞がるので、
// **見捨てられたジョブが猶予内に返らなければ worker ごと殺して作り直す**。
// 代償はその worker の SQLite ページキャッシュを失うこと（cold に戻る）なので短すぎない値に。
// env AMIPA_TERMINATE_GRACE_MS で上書き。
const TERMINATE_GRACE_MS = (() => {
  const v = Number((process.env.AMIPA_TERMINATE_GRACE_MS ?? process.env.GGB_TERMINATE_GRACE_MS))
  return Number.isFinite(v) && v > 0 ? v : 10_000
})()

let slots: Slot[] = []
let cancelFlags: Int32Array | null = null
const queue: Pending[] = []
let nextId = 1
const inflight = new Map<number, { slot: Slot; p: Pending }>()
let disabled = false

function spawn(idx: number, cancelBuf: SharedArrayBuffer): Slot | null {
  try {
    // ts-node-dev 実行時は .ts のまま動くので、worker にも transpile-only の loader を積む。
    const isTs = __filename.endsWith('.ts')
    const file = path.join(__dirname, isTs ? 'dbWorker.ts' : 'dbWorker.js')
    const w = new Worker(file, {
      workerData: { cancelBuf, slot: idx },
      execArgv: isTs ? ['-r', 'ts-node/register/transpile-only'] : [],
    })
    const slot: Slot = { w, idx, busy: null, killTimer: null, killing: false }
    w.on('message', (m: any) => onReply(slot, m))
    w.on('error', e => { console.error(`[dbworker ${idx}] error:`, e); failSlot(slot, e) })
    w.on('exit', code => {
      if (slot.killing) return          // 強制終了は respawn 側で面倒を見る
      if (code !== 0) console.error(`[dbworker ${idx}] exited: ${code}`)
      failSlot(slot, new Error(`worker exited ${code}`))
    })
    return slot
  } catch (e) {
    console.error(`[dbworker ${idx}] spawn failed:`, e)
    return null
  }
}

export function initWorkerPool(): boolean {
  if (N_WORKERS === 0) { disabled = true; return false }
  try {
    const cancelBuf = new SharedArrayBuffer(4 * SLOT_WORDS * N_WORKERS)
    sharedCancelBuf = cancelBuf
    cancelFlags = new Int32Array(cancelBuf)
    slots = []
    for (let i = 0; i < N_WORKERS; i++) {
      const s = spawn(i, cancelBuf)
      if (s) slots.push(s)
    }
    if (slots.length === 0) { disabled = true; return false }
    console.log(`[dbworker] pool ready: ${slots.length} worker(s)`)
    return true
  } catch (e) {
    console.error('[dbworker] pool init failed; falling back to main thread:', e)
    disabled = true
    return false
  }
}

export function poolAvailable(): boolean { return !disabled && slots.length > 0 }

let sharedCancelBuf: SharedArrayBuffer | null = null

/** 見捨てられたのに旗で止まらないジョブ用の最後の手段。worker を殺して同じスロットに作り直す。 */
function terminateAndRespawn(slot: Slot, why: string) {
  const p = slot.busy
  slot.killing = true
  if (slot.killTimer) { clearTimeout(slot.killTimer); slot.killTimer = null }
  console.warn(`[dbworker ${slot.idx}] terminating: ${why} ` +
               `(job=${p?.job.kind ?? '-'}) → respawn（この worker のページキャッシュは失われる）`)
  for (const [id, v] of [...inflight]) if (v.slot === slot) inflight.delete(id)
  if (p) { forgetPid(p.pid); p.reject(new AbandonedError()) }
  slot.busy = null
  slot.w.terminate().catch(() => { /* すでに死んでいる */ }).then(() => {
    if (!sharedCancelBuf) { disabled = true; return }
    const fresh = spawn(slot.idx, sharedCancelBuf)
    slots = slots.filter(x => x !== slot)
    if (fresh) slots.push(fresh)
    else if (slots.length === 0) { disabled = true; console.error('[dbworker] respawn failed → main-thread fallback') }
    pump()
  })
}

function failSlot(slot: Slot, e: unknown) {
  const p = slot.busy
  if (p) forgetPid(p.pid)
  slot.busy = null
  for (const [id, v] of inflight) if (v.slot === slot) inflight.delete(id)
  if (p) p.reject(e)
  // worker が死んだらプールから外す。全滅したらメイン実行へフォールバック。
  slots = slots.filter(s => s !== slot)
  if (slots.length === 0) { disabled = true; console.error('[dbworker] all workers gone → main-thread fallback') }
  else pump()
}

function onReply(slot: Slot, m: any) {
  if (slot.killTimer) { clearTimeout(slot.killTimer); slot.killTimer = null }
  const entry = inflight.get(m.id)
  inflight.delete(m.id)
  if (entry) forgetPid(entry.p.pid)
  slot.busy = null
  if (entry) {
    if (m.ok) {
      if (m.truncated === 'cancel') {
        // 走行中のクエリを実際に止められた記録。これが出ないなら中断機構が効いていない。
        console.log(`[dbworker] cancelled in-flight query after ${(m.ms ?? 0).toFixed(0)}ms ` +
                    `(${m.rows ?? 0} rows read) job=${entry.p.job.kind}`)
      }
      entry.p.resolve({
        body: Buffer.from(m.body as ArrayBuffer),
        enc: m.enc,
        status: m.status ?? 200,
        rows: m.rows, ms: m.ms, truncated: m.truncated, layer: m.layer,
      })
    } else {
      entry.p.reject(new Error(m.error || 'worker job failed'))
    }
  }
  pump()
}

function pump() {
  while (queue.length > 0) {
    const slot = slots.find(s => !s.busy)
    if (!slot) return
    const p = queue.shift()!
    // ① 投入前チェック: 順番待ちの間に見捨てられていたら worker を使わない。
    //    メインのループは空いているので res.closed はこの時点で正しい（遅延チェック不要）。
    if (p.res.closed || p.res.destroyed) {
      forgetPid(p.pid)
      p.reject(new AbandonedError())
      continue
    }
    const id = nextId++
    slot.busy = p
    inflight.set(id, { slot, p })
    if (cancelFlags) {
      const b = slot.idx * SLOT_WORDS
      Atomics.store(cancelFlags, b + SLOT_CANCEL, 0)
      Atomics.store(cancelFlags, b + SLOT_ROWS, 0)
      Atomics.store(cancelFlags, b + SLOT_TOTAL, 0)
      Atomics.store(cancelFlags, b + SLOT_PHASE, 0)
    }
    if (p.pid) { pidSlot.set(p.pid, slot.idx); pidQueued.delete(p.pid) }
    // ② 実行中チェック: 切断されたらキャンセル旗を立てる。worker の iterate ループが拾って止まる。
    const onClose = () => {
      if (cancelFlags) Atomics.store(cancelFlags, slot.idx * SLOT_WORDS + SLOT_CANCEL, 1)
      // 旗で止まらない区間にいる可能性があるので、猶予を過ぎたら worker ごと殺す。
      if (slot.killTimer) clearTimeout(slot.killTimer)
      slot.killTimer = setTimeout(() => {
        if (slot.busy === p) terminateAndRespawn(slot, `abandoned job did not stop within ${TERMINATE_GRACE_MS}ms`)
      }, TERMINATE_GRACE_MS)
    }
    p.res.once('close', onClose)
    slot.w.postMessage({ id, job: p.job, gzip: acceptsGzip(p.res) })
  }
}

export class AbandonedError extends Error {
  constructor() { super('client abandoned before dispatch'); this.name = 'AbandonedError' }
}

/** worker でジョブを走らせる。プールが使えないときは reject するので呼び側でメイン実行へ落ちる。 */
export function runOnWorker(job: QueryJob, res: Response, pid?: string): Promise<WorkerReply> {
  if (!poolAvailable()) return Promise.reject(new Error('pool unavailable'))
  return new Promise<WorkerReply>((resolve, reject) => {
    if (pid) pidQueued.add(pid)
    queue.push({ job, res, pid, resolve, reject })
    pump()
  })
}

// pid(クライアントが発行する取得 ID) → 実行中のスロット。/api/fetch_progress の解決に使う。
const pidSlot = new Map<string, number>()
const pidQueued = new Set<string>()
function forgetPid(pid?: string) { if (pid) { pidSlot.delete(pid); pidQueued.delete(pid) } }

export interface FetchProgress {
  state: 'queued' | 'running' | 'unknown'
  rows: number
  total: number      // 0 = 不明
  phase: number      // 0=なし 1=走査 2=バッチ
  tracked?: number   // 追跡中の pid 数（切り分け用）
}
export function progressFor(pid: string): FetchProgress {
  const idx = pidSlot.get(pid)
  if (idx == null) {
    // 追跡中の pid 数も返す（0 なら「pid が届いていない/登録されていない」の切り分けになる）。
    return { state: pidQueued.has(pid) ? 'queued' : 'unknown', rows: 0, total: 0, phase: 0,
             tracked: pidSlot.size + pidQueued.size }
  }
  if (!cancelFlags) return { state: 'unknown', rows: 0, total: 0, phase: 0 }
  const b = idx * SLOT_WORDS
  return {
    state: 'running',
    rows: Atomics.load(cancelFlags, b + SLOT_ROWS),
    total: Atomics.load(cancelFlags, b + SLOT_TOTAL),
    phase: Atomics.load(cancelFlags, b + SLOT_PHASE),
  }
}

export function poolStats() {
  return { workers: slots.length, busy: slots.filter(s => s.busy).length, queued: queue.length, disabled }
}
