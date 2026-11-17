// セグメント名の表示（11-17）: 画面に出すノード名は元のグラフの名前。内部名 n<整数> は見せない。
//   整数 id のグラフ: n を外すだけ（表を引かない）。名前モードのグラフ（<db>.segnames あり）: /api/segnames でまとめて引いて覚える。
//   segName() は同期で返す。まだ引いていない名前は内部名を返して後で引き、届いたら onSegNames の登録者に知らせる（描き直し）。
const LEAF = /^n(\d+)$/
let db = ''
let named: boolean | null = null           // null＝まだ分からない（DB を開いた直後）
const cache = new Map<string, string>()
const want = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
const subs = new Set<() => void>()
const notify = () => { for (const f of subs) { try { f() } catch { /* 描き直しの失敗は無視 */ } } }

export function segSetDb(d: string) {
  if (d === db) return
  db = d; named = null; cache.clear(); want.clear()
  if (!d) return
  fetch(`/api/segnames?db=${encodeURIComponent(d)}`).then(r => r.ok ? r.json() : null).then(j => { if (db !== d) return; named = !!j?.named; if (named && want.size) schedule(); notify() }).catch(() => { if (db === d) { named = false; notify() } })
}
export function segIsNamed(): boolean | null { return named }

/** 内部名 → 画面に出す名前（葉でない名前はそのまま） */
export function segName(n: string | null | undefined): string {
  if (!n) return n ?? ''
  const x = LEAF.exec(n); if (!x) return n
  if (named === false) return x[1]
  const v = cache.get(n); if (v != null) return v
  want.add(n); if (named) schedule()
  return n
}
function schedule() { if (!timer) timer = setTimeout(flush, 30) }
async function flush() {
  timer = null; const d = db; const ns = [...want].slice(0, 5000); for (const n of ns) want.delete(n)
  if (!ns.length || !d) return
  try { const j = await (await fetch(`/api/segnames?db=${encodeURIComponent(d)}&names=${encodeURIComponent(ns.join(','))}`)).json(); if (db !== d) return
    for (const [k, v] of Object.entries((j?.map || {}) as Record<string, string>)) cache.set(k, v) } catch { /* 次に要るときにまた引く */ }
  if (want.size) schedule(); notify()
}
export function onSegNames(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb) } }

/** 利用者の入力（元の名前）→ 内部名。整数グラフは手元で、名前モードは /api/segids で引く。見つからなければ null */
export async function segIds(names: string[]): Promise<(string | null)[]> {
  if (!names.length) return []
  if (named === false || (named === null && names.every(s => /^n?\d+$/.test(s.trim())))) return names.map(s => { const x = /^n?(\d+)$/.exec(s.trim()); return x ? 'n' + x[1] : null })
  try { const j = await (await fetch(`/api/segids?db=${encodeURIComponent(db)}&names=${encodeURIComponent(names.join(','))}`)).json(); return names.map(s => (j?.map || {})[s] ?? (LEAF.test(s) ? s : null)) } catch { return names.map(s => LEAF.test(s) ? s : null) }
}
