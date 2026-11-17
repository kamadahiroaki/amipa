// セグメント名（11-17）: DB の内部の葉の名前 n<整数> ↔ 元のグラフのセグメント名。
//   ・id がすべて整数のグラフ（<db>.segnames が無い）: 元の名前 = 内部名から n を外したもの。表は引かない
//   ・整数でない id のグラフ（prep の名前モード）: <db>.segnames（segs(id, name)、名前に索引）を引く
//   利用者に見せる名前・利用者から受け取る名前は元の名前。内部（DB・サイドカー・API の行の鍵）は n<整数> のまま。
//   葉でない名前（クラスタ・バブルの内部名）はそのまま返す。
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDbDir } from './db'

export interface SegNames {
  named: boolean
  /** 内部名 → 元の名前（葉でない名前・表に無い名前はそのまま） */
  toDisplay(names: string[]): Map<string, string>
  /** 利用者の入力 → 内部名（元の名前の完全一致。整数グラフは数字だけ・n 付きのどちらでも）。無ければ null */
  toInternal(q: string): string | null
  /** 元の名前の前方一致 → 内部名（名前モードだけ。上限つき） */
  prefix(q: string, limit: number): string[]
}

const LEAF = /^n(\d+)$/
const cache = new Map<string, SegNames>()

function plain(): SegNames {
  return {
    named: false,
    toDisplay: names => { const m = new Map<string, string>(); for (const n of names) { const x = LEAF.exec(n); m.set(n, x ? x[1] : n) } return m },
    toInternal: q => { const x = /^n?(\d+)$/.exec(q.trim()); return x ? 'n' + x[1] : null },
    prefix: () => [],
  }
}

export function segNamesFor(db: string): SegNames {
  const hit = cache.get(db); if (hit) return hit
  const base = path.join(getDbDir(), path.basename(db))
  let p = base + '.segnames'
  if (!fs.existsSync(p)) { try { p = fs.realpathSync(base) + '.segnames' } catch { p = '' } }
  let out: SegNames
  if (!p || !fs.existsSync(p)) out = plain()
  else {
    const d = new Database(p, { readonly: true })
    const byId = d.prepare('SELECT id, name FROM segs WHERE id = ?')
    const byName = d.prepare('SELECT id FROM segs WHERE name = ?')
    const byPrefix = d.prepare('SELECT id FROM segs WHERE name >= ? AND name < ? ORDER BY name LIMIT ?')   // 範囲で引く（GLOB/LIKE は索引に乗らないことがある）
    out = {
      named: true,
      toDisplay: names => { const m = new Map<string, string>(); for (const n of names) { const x = LEAF.exec(n); if (!x) { m.set(n, n); continue } const r = byId.get(Number(x[1])) as { name: string } | undefined; m.set(n, r ? r.name : n) } return m },
      toInternal: q => { const s = q.trim(); const r = byName.get(s) as { id: number } | undefined; if (r) return 'n' + r.id; return null },
      prefix: (q, limit) => { const s = q.trim(); if (!s) return []; const hi = s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + 1); return (byPrefix.all(s, hi, limit) as { id: number }[]).map(r => 'n' + r.id) },
    }
  }
  cache.set(db, out); return out
}
