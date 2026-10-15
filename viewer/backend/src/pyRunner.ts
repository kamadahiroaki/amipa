import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { AMIPA_PYTHON, amipaScript } from './pyenv'

// 常駐の Python 実行器（scripts/py_runner.py）。同梱スクリプト（bubble_msa.py 等）を spawn せずに走らせる。
//   理由: 計算ノードでは Lustre 上の miniconda の `import numpy` だけで 6〜43 秒かかり（2026-10-15 pc060 実測、
//   ばらつきも大きい）、bubble_msa.py の計算本体 1 秒を桁で上回っていた。import を 1 回で済ませる。
//   ・1 行 JSON の要求／応答（id で突き合わせ）。1 本の中では逐次。AMIPA_PY_RUNNERS 本（既定 2）を抱え、空いている方に渡す
//   ・時間切れは kill して立て直す（スクリプトが固まっていても次の要求が通るように）。落ちたら次の要求で再起動
//   ・サーバ起動時に warmRunners() で立ち上げて import を済ませておく（最初の要求が待たされない）
//   ・応答の out はスクリプトの標準出力そのもの（bubble_msa.py は 1 行 JSON。die() も {"error"} の 1 行）

export interface RunResult { ok: boolean; out: string; err: string; ms: number }
interface Pending { resolve: (v: RunResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const N_RUNNERS = Math.max(1, Number(process.env.AMIPA_PY_RUNNERS) || 2)
const RUNNER = amipaScript('py_runner.py')

class PyRunner {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  alive = true
  hello = false
  readonly startedAt = Date.now()

  constructor(readonly idx: number) {
    const tag = `[py:${idx}]`
    this.proc = spawn(AMIPA_PYTHON, [RUNNER], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (s: string) => { for (const l of s.split('\n')) if (l.trim()) console.log(tag + ' ' + l) })
    this.proc.on('exit', (code, sig) => { this.alive = false; this.failAll(new Error(`python runner exited (${code ?? sig})`)) })
    this.proc.on('error', (e) => { this.alive = false; this.failAll(e) })
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
      if (o && o.ev === 'hello') { this.hello = true; console.log(`[py:${this.idx}] ready pid=${o.pid} numpy=${o.numpy} (${Date.now() - this.startedAt} ms)`); continue }
      if (o && o.id != null && this.pending.has(o.id)) {
        const p = this.pending.get(o.id)!; this.pending.delete(o.id); clearTimeout(p.timer)
        p.resolve({ ok: !!o.ok, out: String(o.out ?? ''), err: String(o.err ?? o.error ?? ''), ms: Number(o.ms) || 0 })
      }
    }
  }

  private failAll(e: Error) { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e) } this.pending.clear() }
  load(): number { return this.pending.size }

  run(script: string, argv: string[], stdin: string, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error('python runner not available')); return }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`python runner timeout (${timeoutMs} ms)`))
        this.kill('timeout')   // 固まったスクリプトを道連れに。次の要求で立て直す
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.proc.stdin.write(JSON.stringify({ id, script, argv, stdin }) + '\n') }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e as Error) }
    })
  }

  kill(why: string): void {
    if (!this.alive) return
    this.alive = false
    console.log(`[py:${this.idx}] kill (${why})`)
    try { this.proc.stdin.write('{"op":"quit"}\n'); this.proc.stdin.end() } catch { /* ignore */ }
    const p = this.proc
    setTimeout(() => { try { p.kill() } catch { /* ignore */ } }, 1500).unref()
    this.failAll(new Error('python runner stopped (' + why + ')'))
  }
}

const runners: (PyRunner | null)[] = []

function runnerAt(i: number): PyRunner {
  let r = runners[i]
  if (!r || !r.alive) { r = new PyRunner(i); runners[i] = r; console.log(`[py:${i}] spawn ${AMIPA_PYTHON} ${RUNNER}`) }
  return r
}

/** 空いている（抱えている要求が最も少ない）実行器。 */
function pick(): PyRunner {
  let best: PyRunner | null = null
  for (let i = 0; i < N_RUNNERS; i++) { const r = runnerAt(i); if (!best || r.load() < best.load()) best = r }
  return best!
}

/** 同梱スクリプトを常駐の python で走らせる。argv はスクリプト名を除いた引数。 */
export function runScript(script: string, argv: string[], stdin: string, timeoutMs: number): Promise<RunResult> {
  return pick().run(script, argv, stdin, timeoutMs)
}

/** サーバ起動時に立ち上げて import を済ませておく。 */
export function warmRunners(): void { for (let i = 0; i < N_RUNNERS; i++) runnerAt(i) }

export function pyRunnerStatus(): Record<string, unknown>[] {
  return runners.filter((r): r is PyRunner => !!r).map(r => ({ idx: r.idx, alive: r.alive, ready: r.hello, pending: r.load(), up_s: Math.round((Date.now() - r.startedAt) / 1000) }))
}
