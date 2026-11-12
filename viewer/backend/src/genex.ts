// 遺伝子レーンの索引 <db>.genex（prep/amipa_prep/genex_build.py、11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ⑤
//   窓の遺伝子を合意座標の階層ビン（.travx と同じ）の連続読みで引く。子（エキソン・CDS・UTR）は行の中の zlib。.genes（全ゲノム 8.7 GB）を読まない
import Database from 'better-sqlite3'
import fs from 'fs'
import zlib from 'zlib'

export interface GeneX { db: Database.Database; shifts: number[]; offsets: number[]; hasProj: boolean; q: Database.Statement; qn: Database.Statement }
const opened = new Map<string, GeneX | null>()
export function openGeneX(travFile: string, genesFile: string | null): GeneX | null {
  if (opened.has(travFile)) return opened.get(travFile)!
  let r: GeneX | null = null
  const f = travFile.replace(/\.trav$/, '') + '.genex'
  if ((process.env.AMIPA_GENEX ?? '1') !== '0' && fs.existsSync(f)) {
    try {
      const db = new Database(f, { readonly: true, fileMustExist: true })
      const m = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(x => [x.key, x.value]))
      const okG = !genesFile || String(fs.statSync(genesFile).size) === m.genes_size, okT = String(fs.statSync(travFile).size) === m.trav_size
      if (!okG || !okT) { console.log(`[genex] ${f} は .genes／.trav と合わない（作り直しが要る）`); db.close() }
      else r = { db, shifts: JSON.parse(m.shifts), offsets: JSON.parse(m.offsets), hasProj: m.has_proj === '1',
        q: db.prepare('SELECT * FROM g_b WHERE bin BETWEEN ? AND ? AND x0 <= ? AND x1 >= ?'), qn: db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM g_b WHERE bin BETWEEN ? AND ? AND x0 <= ? AND x1 >= ? LIMIT ?)') }
    } catch (e) { console.log('[genex] ' + String(e)); r = null }
  }
  opened.set(travFile, r); return r
}
/** 窓の遺伝子の数。cap を超えたら数えるのをやめる（全体表示で 550 万行を数えていた） */
export function genexCount(G: GeneX, x0: number, x1: number, cap = Infinity): number {
  let n = 0; for (let L = 0; L < G.shifts.length && n <= cap; L++) { const s = G.shifts[L], o = G.offsets[L]; n += (G.qn.get(o + (x0 >> s), o + (x1 >> s), x1, x0, Number.isFinite(cap) ? cap - n + 1 : -1) as { n: number }).n } return n
}
export function genexRows(G: GeneX, x0: number, x1: number): any[] {
  const out: any[] = []; G.shifts.forEach((s, L) => { const o = G.offsets[L]; for (const r of G.q.all(o + (x0 >> s), o + (x1 >> s), x1, x0)) out.push(r) }); return out
}
const TYPE = ['CDS', 'exon', 'UTR']
export type Child = { type: string; phase: string; strand: string; parent: number | null; start: number; end: number; s0: number; e0: number; so: number; eo: number }
export function genexChildren(blob: Buffer | null): Child[] {
  if (!blob) return []
  const u = zlib.inflateSync(blob); const v = new Int32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)); const out: Child[] = []
  for (let i = 0; i + 9 < v.length; i += 10) out.push({ type: TYPE[v[i]] ?? 'exon', phase: v[i + 1] < 0 ? '.' : String(v[i + 1]), strand: v[i + 2] > 0 ? '+' : v[i + 2] < 0 ? '-' : '.', parent: v[i + 3] < 0 ? null : v[i + 3], start: v[i + 4], end: v[i + 5], s0: v[i + 6], e0: v[i + 7], so: v[i + 8], eo: v[i + 9] })
  return out
}
