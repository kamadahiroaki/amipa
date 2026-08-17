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

/** dd の `status=progress` が stderr に出す "<n> bytes (...) copied, <t> s, <rate>" を拾う。 */
function parseProgress(chunk: string, st: PrewarmState) {
  // \r 区切りで何度も上書き出力される。最後の完全な 1 件だけ見ればよい。
  const m = [...chunk.matchAll(/(\d+)\s+bytes[^\n\r]*?copied,\s*([\d.]+)\s*s/g)].pop()
  if (!m) return
  const done = Number(m[1]), sec = Number(m[2])
  if (Number.isFinite(done)) st.done = done
  if (Number.isFinite(sec) && sec > 0) st.rate = done / sec
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
  // dd を子プロセスで回す。node の event loop を一切塞がない（ここが read stream より重要）。
  const child = spawn('dd', [`if=${real}`, 'of=/dev/null', 'bs=8M', 'status=progress'],
                      { stdio: ['ignore', 'ignore', 'pipe'] })
  current = { db, child }
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c: string) => parseProgress(c, st))
  // 速度が出ないなら見切って止める。遅い OST を掴んだまま走り続けると、得られる warm より
  // 「その間ずっと利用者の取得を邪魔する」損の方が大きい。
  const rateGuard = MIN_RATE > 0 ? setTimeout(() => {
    const el = (Date.now() - st.startedAt) / 1000
    const rate = el > 0 ? st.done / el : 0
    if (rate < MIN_RATE) {
      st.error = `遅すぎるので中止 (${(rate / 1e6).toFixed(0)} MB/s < ${(MIN_RATE / 1e6).toFixed(0)} MB/s)。`
               + ` このFSは 1 ファイル 1 OST なので、OST が混んでいると桁で遅くなる`
      console.log(`[prewarm] ${db}: ${st.error}`)
      child.kill('SIGTERM')
    }
  }, RATE_CHECK_MS) : null
  child.on('error', (e) => {
    st.error = String(e); st.running = false; st.endedAt = Date.now()
    if (rateGuard) clearTimeout(rateGuard)
    current = null; runNext()
  })
  child.on('close', (code) => {
    st.running = false
    st.endedAt = Date.now()
    if (rateGuard) clearTimeout(rateGuard)
    if (code === 0) { st.finished = true; st.done = st.total }
    else if (!st.error) st.error = `dd exit ${code}`
    console.log(`[prewarm] ${db}: ${st.finished ? 'done' : 'stopped'} ` +
                `${(st.done / 1e9).toFixed(1)}/${(st.total / 1e9).toFixed(1)} GB ` +
                `in ${((st.endedAt! - st.startedAt) / 1000).toFixed(1)}s`)
    current = null
    runNext()
  })
  console.log(`[prewarm] ${db}: 開始 ${(st.total / 1e9).toFixed(1)} GB`)
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
  try { total = fs.statSync(fs.realpathSync(path.join(getDbDir(), name))).size } catch { return null }
  if (total < MIN_BYTES) return null       // 小さい DB は対象外
  const st: PrewarmState = { db: name, total, done: 0, rate: 0, running: false,
                             finished: false, startedAt: 0 }
  states.set(name, st)
  queue.push(name)
  runNext()
  return st
}

/** 起動時プリウォーム。AMIPA_PREWARM に DB 名をカンマ区切りで並べる（利用者がいないのでフル速度）。 */
export function prewarmAtStartup() {
  const list = ((process.env.AMIPA_PREWARM ?? process.env.GGB_PREWARM) || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!list.length) return
  console.log(`[prewarm] 起動時プリウォーム: ${list.join(', ')}`)
  for (const db of list) if (!startPrewarm(db)) console.log(`[prewarm] ${db}: 対象外/見つからない`)
}

export function stopAllPrewarm() {
  queue.length = 0
  current?.child.kill('SIGTERM')
}
process.on('exit', stopAllPrewarm)
