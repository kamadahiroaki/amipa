// DB ごとに「どの付属データが使えるか」と、使えないときの理由を返す（/api/version の db.avail）。
// 画面は使えない機能を隠さず、押せない形で出して理由を添える（11-06）。
// 利用者が自分で DB を作ったときに取り込みが途中で落ちても、「機能が無い」ではなく
// 「機能はあるがこの DB では使えない（取り込みに失敗している）」と分かるようにするため。
//
// why:
//   none    … 作っていない（段の記録もログも無い）
//   failed  … 段を走らせた跡（work/log/<段>.log）はあるが完了の記録（state.json）が無い
//   broken  … ファイルはあるが開けない／中身の表が無い
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { getDbDir } from './db'

export type AvailWhy = 'none' | 'failed' | 'broken'
export interface Avail { ok: boolean; why?: AvailWhy; file: string; stage: string; log?: string; detail?: string }

const KINDS: { key: string; suffix: string; stage: string; table?: string }[] = [
  { key: 'reads', suffix: '.reads', stage: 'reads', table: 'node_reads' },
  { key: 'trav', suffix: '.trav', stage: 'trav' },
  { key: 'genes', suffix: '.genes', stage: 'genes' },
  { key: 'ann', suffix: '.ann', stage: 'ann' },
  { key: 'annot', suffix: '.annot', stage: 'annot', table: 'node_annot' },
  { key: 'xdepth', suffix: '.xdepth', stage: 'xdepth' },
]

const cache = new Map<string, { at: number; v: Record<string, Avail> }>()

export function dataAvail(db: string): Record<string, Avail> {
  const name = path.basename(db)
  const hit = cache.get(name)
  if (hit && Date.now() - hit.at < 30_000) return hit.v
  const base = path.join(getDbDir(), name)
  let real = base
  try { real = fs.realpathSync(base) } catch { /* */ }
  const dirs = [...new Set([path.dirname(base), path.dirname(real)])]
  const find = (sfx: string) => [base + sfx, real + sfx].find(p => { try { return fs.existsSync(p) } catch { return false } }) ?? null
  let state: any = null
  for (const d of dirs) { try { state = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')); break } catch { /* */ } }
  const logOf = (stage: string) => {
    for (const d of dirs) { const p = path.join(d, 'work', 'log', `${stage}.log`); try { if (fs.existsSync(p)) return path.join('work', 'log', `${stage}.log`) } catch { /* */ } }
    return null
  }
  const out: Record<string, Avail> = {}
  for (const k of KINDS) {
    const file = name + k.suffix
    const p = find(k.suffix)
    const a: Avail = { ok: false, file, stage: k.stage }
    if (p) {
      a.ok = true
      try { if (fs.statSync(p).isFile() && fs.statSync(p).size === 0) { a.ok = false; a.why = 'broken'; a.detail = '空のファイル' } } catch { /* */ }
      if (a.ok && k.table) {
        try {
          const d = new Database(p, { readonly: true, fileMustExist: true })
          try { if (!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(k.table)) { a.ok = false; a.why = 'broken'; a.detail = `表 ${k.table} が無い` } }
          finally { d.close() }
        } catch (e) { a.ok = false; a.why = 'broken'; a.detail = String((e as Error).message) }
      }
    } else {
      const done = state?.stages?.[k.stage]?.status === 'done'
      const log = logOf(k.stage)
      a.why = done ? 'broken' : log ? 'failed' : 'none'
      if (done) a.detail = '完了の記録はあるがファイルが無い（運び忘れ）'
      if (log) a.log = log
    }
    out[k.key] = a
  }
  cache.set(name, { at: Date.now(), v: out })
  return out
}
