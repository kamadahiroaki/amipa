// Traversals の範囲の索引 <db>.travx と配列ファイル <db>.travx.arr（prep/amipa_prep/trav_xindex.py、11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ④・⑨
//   範囲の問い合わせは階層ビンの段ごとに連続した数ページを読むだけ。xbp・葉の数・dense_of_x は位置を指定して読む（配列を丸ごと読み込まない）。
//   .travx が無い・.trav と合わない（作り直した）ときは null を返し、呼び手は従来の経路を使う
import Database from 'better-sqlite3'
import fs from 'fs'

export interface TravX {
  db: Database.Database; R: number; shifts: number[]; offsets: number[]; cdir: number[]
  arr: { fd: number; hdr: Record<string, [number, string, number]> } | null
  q: Record<string, Database.Statement>
}
const cache = new Map<string, TravX | null>()

export function openTravX(travFile: string): TravX | null {
  if (cache.has(travFile)) return cache.get(travFile)!
  let r: TravX | null = null
  if ((process.env.AMIPA_TRAVX ?? '1') === '0') { cache.set(travFile, null); return null }   // 切り分け用: 索引を使わない
  const f = travFile.replace(/\.trav$/, '') + '.travx'
  try {
    if (fs.existsSync(f)) {
      const db = new Database(f, { readonly: true, fileMustExist: true })
      const m = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(x => [x.key, x.value]))
      const st = fs.statSync(travFile)
      if (String(st.size) !== m.trav_size) { console.log(`[travx] ${f} は .trav と合わない（作り直しが要る）。従来の経路を使う`); db.close() }
      else {
        let arr: TravX['arr'] = null
        if (fs.existsSync(f + '.arr')) { const fd = fs.openSync(f + '.arr', 'r'); const h = Buffer.alloc(4096); fs.readSync(fd, h, 0, 4096, 0); arr = { fd, hdr: JSON.parse(h.toString('utf8').trim()) } }
        const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name).filter(c => c !== 'bin')
        const tc = cols('trav_b'), cc = cols('copies_b')
        r = { db, R: Number(m.R), shifts: JSON.parse(m.shifts), offsets: JSON.parse(m.offsets), cdir: JSON.parse(m.cdir), arr,
          q: {
            trav: db.prepare(`SELECT ${tc.join(', ')} FROM trav_b WHERE bin BETWEEN ? AND ? AND x0 <= ? AND x1 >= ?`),
            travHid: db.prepare(`SELECT ${tc.join(', ')} FROM trav_b WHERE bin BETWEEN ? AND ? AND x0 <= ? AND x1 >= ? AND hid = ?`),
            copies: db.prepare(`SELECT ${cc.join(', ')} FROM copies_b WHERE bin BETWEEN ? AND ? AND x0 <= ? AND x1 >= ?`),
            reps: db.prepare('SELECT id, pid, hid, i0, i1, bp, x0, x1, tnanch FROM reps_b WHERE bin BETWEEN ? AND ? AND x0 <= ? AND x1 >= ?'),
            chroms: db.prepare('SELECT x0, x1, name, ref FROM chroms ORDER BY x0'),
          } }
      }
    }
  } catch (e) { console.log('[travx] ' + String(e)); r = null }
  cache.set(travFile, r); return r
}

/** 区間 [x0, x1] に掛かる行（段ごとにビンの範囲を 1 回ずつ読む） */
export function binQuery<T>(X: TravX, stmt: Database.Statement, x0: number, x1: number, ...more: unknown[]): T[] {
  const out: T[] = []; const a = Math.max(0, Math.floor(x0)), b = Math.max(a, Math.floor(x1))
  X.shifts.forEach((s, L) => { const o = X.offsets[L]; for (const r of stmt.all(o + (a >> s), o + (b >> s), b, a, ...more) as T[]) out.push(r) })
  return out
}

function readArr(X: TravX, name: string, i0: number, n: number): Buffer | null {
  if (!X.arr || !X.arr.hdr[name]) return null
  const [off, dt, len] = X.arr.hdr[name]; const w = dt === 'int64' ? 8 : 4
  const a = Math.max(0, Math.min(len, i0)), e = Math.max(a, Math.min(len, i0 + n)); const b = Buffer.alloc((e - a) * w)
  if (b.length) fs.readSync(X.arr.fd, b, 0, b.length, off + a * w)
  return b
}
/** 座標 x の累積 bp（範囲外は端に寄せる） */
export function bpAt(X: TravX, x: number): number | null {
  const len = X.arr?.hdr.xbp?.[2]; if (!len) return null
  const b = readArr(X, 'xbp', Math.max(0, Math.min(len - 1, Math.floor(x))), 1); return b && b.length ? Number(b.readBigInt64LE(0)) : null
}
/** 範囲 [x0, x1] の葉の数（累積の 2 値の差） */
export function nleafX(X: TravX, x0: number, x1: number): number | null {
  const len = X.arr?.hdr.nleafcum?.[2]; if (!len) return null
  const at = (i: number) => { const b = readArr(X, 'nleafcum', Math.max(0, Math.min(len - 1, i)), 1); return b && b.length ? Number(b.readBigInt64LE(0)) : 0 }
  return at(Math.floor(x1) + 1) - at(Math.floor(x0))
}
/** dense_of_x の [x0, x1] の切り出し（連続した 1 回の読み） */
export function denseSlice(X: TravX, x0: number, x1: number): Int32Array | null {
  const b = readArr(X, 'dense_of_x', Math.floor(x0), Math.floor(x1) - Math.floor(x0) + 1); if (!b) return null
  return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/** dense id の集まりについて、配列（order・refbp・refcid）の値を引く。id を近いもの（間 4,096 以下）の塊にまとめ、塊ごとに 1 回の連続した読み（11-12）。
 *  窓のノードの id はほぼ連続するので、ふつうは 1〜数回 */
export function arrByIds(X: TravX, name: string, ids: Iterable<number>): Map<number, number> | null {
  if (!X.arr || !X.arr.hdr[name]) return null
  const dt = X.arr.hdr[name][1]; const s = [...new Set(ids)].filter(v => v >= 0).sort((a, b) => a - b); const out = new Map<number, number>()
  let i = 0
  while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1] - s[j] <= 4096) j++
    const a = s[i], b = s[j]; const buf = readArr(X, name, a, b - a + 1)
    if (buf) { const v = dt === 'int64' ? null : new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      for (let k = i; k <= j; k++) { const o = s[k] - a; if (dt === 'int64') { if ((o + 1) * 8 <= buf.length) out.set(s[k], Number(buf.readBigInt64LE(o * 8))) } else if (v && o < v.length) out.set(s[k], v[o]) } }
    i = j + 1 }
  return out
}
