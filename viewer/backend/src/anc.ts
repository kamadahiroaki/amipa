// 葉 → 各層の祖先の配列 <db>.anc（prep/amipa_prep/anc_build.py、11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ⑦
//   層 L の配列を葉の番号の範囲で切り出して読む（1 回の連続した読み）。値 ＝ 接頭辞 × 2^30 ＋ 番号（接頭辞 0 n・1 G・2 S）、無ければ 0xFFFFFFFF
import fs from 'fs'

export interface Anc { fd: number; maxlayer: number; n: number; off: Record<string, number> }
const opened = new Map<string, Anc | null>()
export function openAnc(dbPath: string): Anc | null {
  if (opened.has(dbPath)) return opened.get(dbPath)!
  let r: Anc | null = null
  if ((process.env.AMIPA_ANC ?? '1') !== '0') {
    const cands = [dbPath + '.anc']; try { const rp = fs.realpathSync(dbPath); if (rp !== dbPath) cands.push(rp + '.anc') } catch { /* */ }
    const f = cands.find(c => fs.existsSync(c))
    if (f) { try { const fd = fs.openSync(f, 'r'); const h = Buffer.alloc(4096); fs.readSync(fd, h, 0, 4096, 0); const H = JSON.parse(h.toString('utf8').replace(/\0+$/, '').trim()); r = { fd, maxlayer: H.maxlayer, n: H.n, off: H.layers } } catch (e) { console.log('[anc] ' + String(e)); r = null } }
  }
  opened.set(dbPath, r); return r
}
/** 名前（n123・G45・S6）→ 祖先の値と同じ符号。数字でなければ -1 */
export function ancCode(name: string): number {
  const m = /^([nGS])(\d+)$/.exec(name); if (!m) return -1; const p = m[1] === 'n' ? 0 : m[1] === 'G' ? 1 : 2; return p * 2 ** 30 + Number(m[2])
}
/** 層 L で、葉の番号の集まりそれぞれの祖先の符号。番号を近い塊（間 65,536 以下）にまとめ、塊ごとに 1 回読む */
export function ancOf(A: Anc, L: number, ids: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>()
  const u = [...new Set(ids)].filter(v => v >= 0 && v <= A.n).sort((x, y) => x - y)
  if (L >= A.maxlayer) { for (const v of u) out.set(v, v); return out }   // 最深層は葉そのもの
  const base = A.off[String(L)]; if (base == null) return out
  let i = 0
  while (i < u.length) { let j = i; while (j + 1 < u.length && u[j + 1] - u[j] <= 65536) j++
    const a = u[i], b = u[j]; const buf = Buffer.alloc((b - a + 1) * 4); fs.readSync(A.fd, buf, 0, buf.length, base + a * 4)
    for (let k = i; k <= j; k++) { const v = buf.readUInt32LE((u[k] - a) * 4); if (v !== 0xFFFFFFFF) out.set(u[k], v) }
    i = j + 1 }
  return out
}
