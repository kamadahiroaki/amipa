import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import { AMIPA_PYTHON, amipaScript } from './pyenv'

// 多解像度 MSA（共線ブロック）の**逐次計算**ワーカー。
//   事前計算のサイドカー（<db>.blocks.json）に無い窓を、Python の常駐プロセス（scripts/blocks/worker.py）で
//   その場で計算する。窓 1 個は 1 秒以内が目安だが、最初の 1 回はアトラス＋distill の読み込み（Ctx）に
//   chrY 5 s / ecoli50 40 s 級かかるので、DB ごとに 1 本を**常駐**させて温めておく（/api/blocks/warm）。
//   ・stdin/stdout の 1 行 JSON。要求に id を振り、応答を id で突き合わせる（Python 側は逐次処理）
//   ・使われないまま AMIPA_BLOCKS_IDLE_MS（既定 60 分）経つと落とす（温め直しが 30 秒級なので短くしない）。同時に生かす本数の上限
//     AMIPA_BLOCKS_MAX_WORKERS（既定 3）を超えたら最も古いものを落とす（Ctx は WG で数 GB になる）
//   ・依存は numpy（numba はあれば速い）。無い環境では state='error' になり、画面は事前計算だけで動く

export type WorkerState = 'starting' | 'cold' | 'warming' | 'ready' | 'error' | 'dead'
interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const IDLE_MS = Number(process.env.AMIPA_BLOCKS_IDLE_MS) || 60 * 60_000
const REQ_TIMEOUT_MS = Number(process.env.AMIPA_BLOCKS_TIMEOUT_MS) || 90_000
const WARM_TIMEOUT_MS = Number(process.env.AMIPA_BLOCKS_WARM_MS) || 900_000
const MAX_WORKERS = Number(process.env.AMIPA_BLOCKS_MAX_WORKERS) || 3

export class BlocksWorker {
  state: WorkerState = 'starting'
  error: string | null = null
  warmMs: number | null = null
  lastUsed = Date.now()
  readonly startedAt = Date.now()
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private warmPromise: Promise<void> | null = null

  constructor(readonly dbPath: string, readonly distill: string, readonly blocksJson: string | null) {
    const argv = [amipaScript('blocks/worker.py'), '--db', dbPath, '--distill', distill]
    if (blocksJson) argv.push('--blocks', blocksJson)
    const tag = '[blocks:' + path.basename(dbPath) + ']'
    this.proc = spawn(AMIPA_PYTHON, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (s: string) => { for (const l of s.split('\n')) if (l.trim()) console.log(tag + ' ' + l) })
    this.proc.on('exit', (code, sig) => {
      if (this.state !== 'dead') { this.error = this.error ?? `worker exited (${code ?? sig})`; this.state = 'dead' }
      this.failAll(new Error(this.error ?? 'worker exited'))
    })
    this.proc.on('error', (e) => { this.state = 'error'; this.error = String(e); this.failAll(e) })
    this.proc.stdin.on('error', (e) => { console.log(tag + ' stdin: ' + String(e)) })
  }

  private onData(chunk: string) {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let o: any
      try { o = JSON.parse(line) } catch { continue }
      if (o && o.ev === 'hello') { if (this.state === 'starting') this.state = 'cold'; continue }
      if (o && o.id != null && this.pending.has(o.id)) {
        const p = this.pending.get(o.id)!; this.pending.delete(o.id); clearTimeout(p.timer)
        if (o.ok) p.resolve(o); else p.reject(new Error(o.error ?? 'worker error'))
      }
    }
  }

  private failAll(e: Error) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
  }

  busy(): boolean { return this.pending.size > 0 }
  alive(): boolean { return this.state !== 'dead' && this.state !== 'error' }

  request(op: string, payload: Record<string, unknown>, timeoutMs = REQ_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.alive()) { reject(new Error(this.error ?? 'blocks worker not available')); return }
      const id = this.nextId++
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`blocks worker timeout (${op}, ${timeoutMs} ms)`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.lastUsed = Date.now()
      try { this.proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n') }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e as Error) }
    })
  }

  /** Ctx（アトラス＋distill）を作る。2 回目以降は即 resolve。 */
  warm(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.warmPromise) return this.warmPromise
    this.state = 'warming'
    this.warmPromise = this.request('warm', {}, WARM_TIMEOUT_MS).then(
      r => { this.state = 'ready'; this.warmMs = typeof r.warm_ms === 'number' ? r.warm_ms : null },
      e => { if (this.alive()) this.state = 'error'; this.error = String(e?.message ?? e); this.warmPromise = null; throw e })
    return this.warmPromise
  }

  window(payload: Record<string, unknown>): Promise<any> {
    return this.warm().then(() => this.request('window', payload))
  }

  kill(): void {
    this.state = 'dead'
    try { this.proc.stdin.write('{"op":"quit"}\n'); this.proc.stdin.end() } catch { /* ignore */ }
    const p = this.proc
    setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, 2000).unref()
    this.failAll(new Error('blocks worker stopped'))
  }
}

const workers = new Map<string, BlocksWorker>()

export function getBlocksWorker(dbPath: string, distill: string, blocksJson: string | null): BlocksWorker {
  let w = workers.get(dbPath)
  if (w && !w.alive()) { workers.delete(dbPath); w = undefined }
  if (!w) {
    // 上限を超えるなら、使っていない中で最も古いものを落とす
    while (workers.size >= MAX_WORKERS) {
      let oldest: [string, BlocksWorker] | null = null
      for (const kv of workers) if (!kv[1].busy() && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv
      if (!oldest) break
      console.log('[blocks] evict ' + path.basename(oldest[0])); oldest[1].kill(); workers.delete(oldest[0])
    }
    w = new BlocksWorker(dbPath, distill, blocksJson); workers.set(dbPath, w)
    console.log('[blocks] spawn worker for ' + path.basename(dbPath) + ' (' + AMIPA_PYTHON + ')')
  }
  w.lastUsed = Date.now()
  return w
}

export function peekBlocksWorker(dbPath: string): BlocksWorker | null { return workers.get(dbPath) ?? null }

export function blocksWorkerStatus(w: BlocksWorker | null): Record<string, unknown> {
  if (!w) return { state: 'none' }
  return { state: w.state, warm_ms: w.warmMs, error: w.error, busy: w.busy(), idle_s: Math.round((Date.now() - w.lastUsed) / 1000) }
}

const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, w] of workers) {
    if (!w.alive()) { workers.delete(k); continue }
    if (!w.busy() && w.state !== 'warming' && now - w.lastUsed > IDLE_MS) { console.log('[blocks] idle stop ' + path.basename(k)); w.kill(); workers.delete(k) }
  }
}, 60_000)
sweeper.unref()
