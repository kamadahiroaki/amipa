// DB 読み取りを走らせる worker。**メインスレッドのイベントループを空けておくため**に存在する。
//
// なぜ必要か（2026-08-04 実測, WG 273GB）:
//   better-sqlite3 は同期 API なので、重いクエリの間 backend のイベントループが完全に止まる。
//   ・クライアントが切断しても検知できない（切断イベントを処理する余地が無い）
//   ・全リクエストが直列化され、他ユーザ/他タブも巻き添えで固まる
//   ・実行中のクエリは中断できない（重い矩形 1 本で最大 15 秒＝FETCH_MS 占有）
//   server.ts の入口ガードで「キュー待ちの放棄分」は捨てられるようになったが、
//   **実行中の 1 本**はそこでは救えなかった。これがその残りを埋める。
//
// worker 側は依然として同期 API だが、止まるのは worker のループだけでメインは動き続ける。
// 実行中のクエリの中断は **SharedArrayBuffer のキャンセル旗**で行う: メインが切断を検知して
// 旗を立て、worker の guardedAll が iterate ループの中（TIME_CHECK_EVERY 行ごと）で
// Atomics.load して break する。これで「走り出したクエリは止められない」が解消する。
import { parentPort, workerData } from 'worker_threads'
import zlib from 'zlib'
import { getDb } from './db'
import { guardedAll, guardedFold, FETCH_MS } from './fetchGuard'
import { runQueryJob, type QueryJob } from './dbJobs'
import { SLOT_WORDS, SLOT_CANCEL, SLOT_ROWS, SLOT_TOTAL, SLOT_PHASE } from './workerPool'

const cancelFlags = new Int32Array(workerData.cancelBuf as SharedArrayBuffer)
const slot: number = workerData.slot
const BASE = slot * SLOT_WORDS

export interface JobRequest {
  id: number
  job: QueryJob
  /** クライアントが gzip を受け付けるか（Accept-Encoding 由来）。true なら worker 側で圧縮する。 */
  gzip?: boolean
}
export interface JobReply {
  id: number
  ok: boolean
  /** 本文（worker 側で直列化・必要なら圧縮済み）。メインは触らずそのまま res へ流す。 */
  body?: ArrayBuffer
  /** 本文の Content-Encoding。'gzip' なら圧縮済み、未設定なら素の JSON。 */
  enc?: 'gzip'
  status?: number
  rows?: number
  ms?: number
  truncated?: string | null
  layer?: number | null
  error?: string
}

// 直列化した本文をここで gzip する。**メインスレッドを空けておくのが worker 化の目的**なので、
// 24.78MB の deflate(level 1 で 130ms) もメインには持ち込まない。level は server.ts と同じ既定 1。
// 小さい本文はヘッダ分の損になるので threshold 未満は素通し（compression の既定と同じ 1KB）。
const GZIP_LEVEL = (() => {
  const v = Number((process.env.AMIPA_GZIP_LEVEL ?? process.env.GGB_GZIP_LEVEL))
  return Number.isFinite(v) && v >= 0 && v <= 9 ? Math.floor(v) : 1
})()
const GZIP_MIN_BYTES = 1024

parentPort!.on('message', (msg: JobRequest) => {
  const { id, job } = msg
  try {
    // 旗はジョブ開始時に必ず倒す（前のジョブのキャンセルが残らないように）。
    Atomics.store(cancelFlags, BASE + SLOT_CANCEL, 0)
    Atomics.store(cancelFlags, BASE + SLOT_ROWS, 0)
    Atomics.store(cancelFlags, BASE + SLOT_TOTAL, 0)
    Atomics.store(cancelFlags, BASE + SLOT_PHASE, 0)
    const d = getDb(job.db)
    const cancelled = () => Atomics.load(cancelFlags, BASE + SLOT_CANCEL) === 1
    // 進捗はキャンセル判定と同じ刻みで書く。Atomics.store だけなので通信も同期も無い。
    const onProgress = (n: number) => Atomics.store(cancelFlags, BASE + SLOT_ROWS, n)
    const setTotal = (n: number) => Atomics.store(cancelFlags, BASE + SLOT_TOTAL, Math.min(n, 2 ** 31 - 1))
    const setPhase = (n: number) => Atomics.store(cancelFlags, BASE + SLOT_PHASE, n)
    const r = runQueryJob(d, job, {
      guard: (stmt, params, opts) =>
        guardedAll(stmt, params, { ...opts, timeMs: opts?.timeMs ?? FETCH_MS, cancelled, onProgress }),
      fold: (stmt, params, onRow, opts) =>
        guardedFold(stmt, params, onRow, { ...opts, timeMs: opts?.timeMs ?? FETCH_MS, cancelled, onProgress }),
      setTotal, setPhase,
      setProgress: (n: number) => Atomics.store(cancelFlags, BASE + SLOT_ROWS, n),
    })
    // 直列化も圧縮も worker でやる。メインへ渡すのは ArrayBuffer 1 個だけ（transfer でゼロコピー）。
    let buf = Buffer.from(JSON.stringify(r.payload), 'utf8')
    let enc: 'gzip' | undefined
    if (msg.gzip && GZIP_LEVEL > 0 && buf.length >= GZIP_MIN_BYTES) {
      buf = zlib.gzipSync(buf, { level: GZIP_LEVEL })
      enc = 'gzip'
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    const reply: JobReply = {
      id, ok: true, body: ab, enc, status: r.status ?? 200,
      rows: r.rows, ms: r.ms, truncated: r.truncated ?? null, layer: r.layer ?? null,
    }
    parentPort!.postMessage(reply, [ab])
  } catch (e) {
    parentPort!.postMessage({ id, ok: false, error: String(e) } as JobReply)
  }
})
