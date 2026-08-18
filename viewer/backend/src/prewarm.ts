// DB ファイルを **順読み**してページキャッシュに載せる（プリウォーム）。
//
// == なぜ必要か（2026-08-09 実測, Lustre stripe_count=1 の 253GB DB）==
//   順読み      1.3-1.8 GB/s
//   ランダム4KB 13.4 ms/回（= 75 iops）      → 差は約 4,700 倍
// 高速経路(/nodes)の cold は **%_node(R-Tree 本体)のランダム読み**が支配的で、
// 1 ビューポートあたり 80-100 ページ × 13.4ms ≒ 1-4 秒かかる。ところが同じ 253GB を
// `dd` で丸ごと順読みすると **142 秒**で済み、その後は同一ビューポートが
//   941.9ms → 9.6ms（98x） / 919.1ms → 9.4ms（98x）
// になる。つまり「散ったページを 1 枚ずつ引く」のが高いのであって「全部順に読む」のは安い。
//
// ★R-Tree のページだけを読めれば 19GB/11 秒で済むが、主 DB では 253GB 中に散在していて
//   範囲指定では拾えない（＝R-Tree サイドカー化の動機）。現状は全体を読む。
//
// == 利用者への影響（実測）==
// プリウォーム中は同じ単一 OST を順読みが占有するので、割り込むランダム読みが待たされる。
// 同一ホスト内で「訪問 %_node 1 ページあたりの ms」に正規化した比較で **約 1.4 倍の遅化**
// （個別ビューポートでは最大 5 倍程度、ただし 1 標本なのでばらつきは大きい）。
// → **backend 起動時は利用者がいないのでフル速度**。DB 切り替え時は進捗を出して待たせる。
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getDbDir } from './db'

export type PrewarmState = {
  db: string
  total: number          // ファイルサイズ(bytes)
  done: number           // 読み終えた bytes
  rate: number           // 直近の速度(bytes/s)
  running: boolean
  finished: boolean      // 最後まで読めた
  error?: string
  startedAt: number
  endedAt?: number
}

const states = new Map<string, PrewarmState>()
let current: { db: string; child: ChildProcess } | null = null
const queue: string[] = []

// これより小さい DB は放っておいても自然に温まるので対象外（既定 4GiB）
const MIN_BYTES = Number((process.env.AMIPA_PREWARM_MIN_BYTES ?? process.env.GGB_PREWARM_MIN_BYTES)) || 4 * 1024 ** 3
// DB を開いた時に自動でプリウォームを始めるか。
// ★既定 OFF。理由: 利用者が「今」見たくて DB を開いた瞬間に 250GB の順読みを始めると、
//   最初の表示が順読みと競合して逆に遅くなる（実際にそうなった）。起動時プリウォーム
//   （AMIPA_PREWARM）は利用者がいないので安全だが、開いた時のそれは体感を悪くする。
//   明示的に有効化したい場合のみ AMIPA_PREWARM_ON_OPEN=1。
export const PREWARM_ON_OPEN = (process.env.AMIPA_PREWARM_ON_OPEN ?? process.env.GGB_PREWARM_ON_OPEN) === '1'

// 速度が出ない時に見切る閾値（MB/s）。0 で無効。
// ★このFSは stripe_count=1 ＝ **1 ファイルが 1 OST に固定**される。OST が劣化/混雑していると
//   同じノード・同じ時刻でも 90MB/s(OST34) 対 1.1GB/s(OST30) と 12 倍違う（2026-08-09 実測）。
//   遅い側を掴んだまま走ると 252GB に 47 分かかり、その間ずっと利用者の取得を邪魔する。
//   「速く読めるなら読み切る、遅いなら諦める」が正しい。
const MIN_RATE = (Number((process.env.AMIPA_PREWARM_MIN_MBPS ?? process.env.GGB_PREWARM_MIN_MBPS)) || 300) * 1e6
const RATE_CHECK_MS = 20_000        // 助走のあとこの時点で判定する

export function prewarmState(db: string): PrewarmState | null {
  return states.get(db) ?? null
}

export function prewarmAllStates(): PrewarmState[] {
  return [...states.values()]
}

function safeName(db: string): string | null {
  const s = path.basename(db)
  return s && s === db ? s : null
}

// ★温める対象は **本体だけでは足りない**。全ゲノム実測（2026-08-18）:
//   本体 230GB を読み切った直後でも layer 16 の /edges が **100 秒**かかり、
//   同じ要求の 2 回目が 0.17 秒（588x）。原因は本体ではなく **サイドカー**で、
//   `/edges` が `rd.edge_read_support`（1.2 億行・18GB）を葉層で毎回引くため。
//   本体だけ温めても一番痛い所が冷たいままなので、隣のサイドカーも順に読む。
const SIDECARS = ['.reads', '.annot', '.hapidx', '.nametri']
function prewarmFiles(real: string): string[] {
  const out = [real]
  for (const suf of SIDECARS) {
    const f = real + suf
    try { if (fs.statSync(f).isFile()) out.push(f) } catch { /* 無ければ飛ばす */ }
  }
  return out
}
function totalBytes(files: string[]): number {
  let n = 0
  for (const f of files) { try { n += fs.statSync(f).size } catch { /* */ } }
  return n
}

/** dd の `status=progress` が stderr に出す "<n> bytes (...) copied, <t> s, <rate>" を拾う。 */
function parseProgress(chunk: string, st: PrewarmState, base = 0, startedAt = 0) {
  // \r 区切りで何度も上書き出力される。最後の完全な 1 件だけ見ればよい。
  const m = [...chunk.matchAll(/(\d+)\s+bytes[^\n\r]*?copied,\s*([\d.]+)\s*s/g)].pop()
  if (!m) return
  const done = Number(m[1])
  if (!Number.isFinite(done)) return
  st.done = base + done                       // ファイルを跨いで積む
  // 速度は「開始からの通算」で出す（dd の秒はファイルごとに 0 に戻るため）
  const el = startedAt ? (Date.now() - startedAt) / 1000 : Number(m[2])
  if (el > 0) st.rate = st.done / el
}

function runNext() {
  if (current || queue.length === 0) return
  const db = queue.shift()!
  const st = states.get(db)
  if (!st) return
  const dir = getDbDir()
  const p = path.join(dir, db)
  // 実体を辿る（data/db は lodwork への symlink で運用しているため）
  let real = p
  try { real = fs.realpathSync(p) } catch { /* そのまま使う */ }

  st.running = true
  st.startedAt = Date.now()
  const files = prewarmFiles(real)
  let idx = 0
  let base = 0            // ここまでのファイルで読んだ総バイト（dd の報告は 1 ファイル内の値）
  const state: PrewarmState = st   // 入れ子関数の中では narrowing が効かないので束ね直す
  runFile()

  function runFile() {
  const f = files[idx]
  // dd を子プロセスで回す。node の event loop を一切塞がない（ここが read stream より重要）。
  const child = spawn('dd', [`if=${f}`, 'of=/dev/null', 'bs=8M', 'status=progress'],
                      { stdio: ['ignore', 'ignore', 'pipe'] })
  current = { db, child }
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c: string) => parseProgress(c, state, base, state.startedAt))
  // 速度が出ないなら見切って止める。遅い OST を掴んだまま走り続けると、得られる warm より
  // 「その間ずっと利用者の取得を邪魔する」損の方が大きい。
  const rateGuard = MIN_RATE > 0 ? setTimeout(() => {
    const el = (Date.now() - state.startedAt) / 1000
    const rate = el > 0 ? state.done / el : 0
    if (rate < MIN_RATE) {
      state.error = `遅すぎるので中止 (${(rate / 1e6).toFixed(0)} MB/s < ${(MIN_RATE / 1e6).toFixed(0)} MB/s)。`
               + ` このFSは 1 ファイル 1 OST なので、OST が混んでいると桁で遅くなる`
      console.log(`[prewarm] ${db}: ${state.error}`)
      child.kill('SIGTERM')
    }
  }, RATE_CHECK_MS) : null
  child.on('error', (e) => {
    state.error = String(e); state.running = false; state.endedAt = Date.now()
    if (rateGuard) clearTimeout(rateGuard)
    current = null; runNext()
  })
  child.on('close', (code) => {
    if (rateGuard) clearTimeout(rateGuard)
    if (code === 0) {
      base += (() => { try { return fs.statSync(f).size } catch { return 0 } })()
      state.done = base
      idx++
      if (idx < files.length) { runFile(); return }      // 次のサイドカーへ
      state.finished = true
      state.done = state.total
    } else if (!state.error) {
      state.error = `dd exit ${code}`
    }
    state.running = false
    state.endedAt = Date.now()
    console.log(`[prewarm] ${db}: ${state.finished ? 'done' : 'stopped'} ` +
                `${(state.done / 1e9).toFixed(1)}/${(state.total / 1e9).toFixed(1)} GB ` +
                `in ${((state.endedAt! - state.startedAt) / 1000).toFixed(1)}s`)
    current = null
    runNext()
  })
  console.log(`[prewarm] ${db}: 開始 ${path.basename(f)} ` +
              `(${idx + 1}/${files.length}, 合計 ${(state.total / 1e9).toFixed(1)} GB)`)
  }
}

/**
 * db のプリウォームを開始（既に開始済み/完了済みなら何もしない）。
 * 同時に走らせると順読み同士がぶつかって両方遅くなるので **常に 1 本ずつ**。
 */
export function startPrewarm(db: string): PrewarmState | null {
  const name = safeName(db)
  if (!name) return null
  const existing = states.get(name)
  if (existing) return existing            // 実行中 or 完了済み or 失敗（再試行はしない）
  let total = 0
  try { total = totalBytes(prewarmFiles(fs.realpathSync(path.join(getDbDir(), name)))) }
  catch { return null }
  if (total < MIN_BYTES) return null       // 小さい DB は対象外
  const st: PrewarmState = { db: name, total, done: 0, rate: 0, running: false,
                             finished: false, startedAt: 0 }
  states.set(name, st)
  queue.push(name)
  runNext()
  return st
}

/**
 * 起動時プリウォーム。**既定で有効**（この時点では利用者がいないのでフル速度で読める）。
 *   AMIPA_PREWARM 未設定 … DB_DIR の *.db を順に温める（既定）
 *   AMIPA_PREWARM=<名前,...> … その DB だけ
 *   AMIPA_PREWARM=off|0     … 何もしない
 * 小さい DB（既定 4GiB 未満）は放っておいても温まるので対象外。速度が出ない時は自動で見切る。
 */
export function prewarmAtStartup() {
  const raw = (process.env.AMIPA_PREWARM ?? process.env.GGB_PREWARM ?? '').trim()
  if (raw === 'off' || raw === '0' || raw === 'false') {
    console.log('[prewarm] 無効（AMIPA_PREWARM=off）')
    return
  }
  let list = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (!list.length) {
    // 既定: DB_DIR にあるアトラス本体を全部。ここに来るのは配信を始めた直後だけ。
    try {
      // 本体は `<name>.db`（旧アトラスは `<name>.layered.db`。どちらも .db で終わる）。
      // サイドカーは .reads/.annot/… なのでここには混ざらない。
      list = fs.readdirSync(getDbDir()).filter(f => f.endsWith('.db')).sort()
    } catch { list = [] }
    if (!list.length) return
  }
  console.log(`[prewarm] 起動時プリウォーム: ${list.join(', ')}`)
  for (const db of list) if (!startPrewarm(db)) console.log(`[prewarm] ${db}: 対象外/見つからない`)
}

export function stopAllPrewarm() {
  queue.length = 0
  current?.child.kill('SIGTERM')
}
process.on('exit', stopAllPrewarm)
