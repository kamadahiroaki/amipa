// 通過（traversal）のサイドカー `<db>.trav`（functions/anchor2/build/synteny2_build.py が作る、SQLite）を読む。
// 設計: amipa-lab/plans/anchor2-traversals.md。錨の座標 x（多数決順の順位）、通過 trav（コンティグ × 座標区間 × 向き × コピー番号）、
// コピー copies（同じコンティグの通過の座標の重なり）、境界 bounds（支持・持続度）、原子 atoms、反復 reps（出現単位）。
// 現行の `.synteny` と並行して読む（置き換えはまだ）。
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDbDir } from './db'

export const TRAV_SUFFIX = '.trav'

export function travPath(dbFile: string): string | null {
  const base = path.join(getDbDir(), path.basename(dbFile))
  try { if (fs.existsSync(base + TRAV_SUFFIX)) return base + TRAV_SUFFIX } catch { /* ignore */ }
  try { const rp = fs.realpathSync(base) + TRAV_SUFFIX; if (fs.existsSync(rp)) return rp } catch { /* ignore */ }
  return null
}

export interface TravPath { pid: number; path: string; hid: number; orient: number; relation: number; excluded: number; ntok: number; bp: number }
export interface TravAtom { id: number; x0: number; x1: number; bp: number; nhap: number; ntangle?: number }
export interface TravBound { x: number; support: number; persistence: number }
export interface TravRow { id: number; pid: number; hid: number; i0: number; i1: number; x0: number; x1: number; dir: number; copy: number; nanch: number; bp: number; bp0?: number }
export interface CopyRow { id: number; pid: number; hid: number; x0: number; x1: number; ia0: number; ia1: number; ib0: number; ib1: number; bpa: number; bpb: number }

export interface Trav {
  file: string; mtime: number; db: Database.Database
  meta: Record<string, any>; H: number; R: number
  haps: string[]; paths: TravPath[]; atoms: TravAtom[]; bounds: TravBound[]
  xbp: Float64Array                                   // 座標 → 累積 bp（長さ R+1）
  hapPaths: number[][]                                 // hid → pid の一覧
}

const cache = new Map<string, Trav>()

export function loadTrav(dbFile: string): Trav | null {
  const p = travPath(dbFile)
  if (!p) return null
  let mtime = 0
  try { mtime = fs.statSync(p).mtimeMs } catch { /* ignore */ }
  const c = cache.get(p)
  if (c && c.mtime === mtime) return c
  if (c) { try { c.db.close() } catch { /* ignore */ } }
  const db = new Database(p, { readonly: true })
  const meta: Record<string, any> = {}
  for (const r of db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]) { try { meta[r.key] = JSON.parse(r.value) } catch { meta[r.key] = r.value } }
  const haps = (db.prepare('SELECT hid, hap FROM haps ORDER BY hid').all() as { hid: number; hap: string }[]).map(r => r.hap)
  const paths = db.prepare('SELECT pid, path, hid, orient, relation, excluded, ntok, bp FROM paths ORDER BY pid').all() as TravPath[]
  const atoms = db.prepare('SELECT * FROM atoms ORDER BY x0').all() as TravAtom[]   // ntangle は version 3 から
  const bounds = db.prepare('SELECT x, support, persistence FROM bounds ORDER BY x').all() as TravBound[]
  const xb = db.prepare("SELECT blob FROM arrays WHERE name='xbp'").get() as { blob: Buffer } | undefined
  let xbp = new Float64Array(0)
  if (xb) { const big = new BigInt64Array(xb.blob.buffer, xb.blob.byteOffset, xb.blob.byteLength / 8); xbp = new Float64Array(big.length); for (let i = 0; i < big.length; i++) xbp[i] = Number(big[i]) }
  const hapPaths: number[][] = haps.map(() => []); for (const r of paths) hapPaths[r.hid].push(r.pid)
  const t: Trav = { file: p, mtime, db, meta, H: haps.length, R: Number(meta.R ?? xbp.length - 1), haps, paths, atoms, bounds, xbp, hapPaths }
  cache.set(p, t)
  return t
}

// 根: メタ・ハプロタイプ・原子・境界（持続度つき）・コンティグの関係の要約
export function travRoot(t: Trav): any {
  const perHap = t.haps.map((hap, hid) => { const ps = t.hapPaths[hid]; return { hid, hap, ncontig: ps.length, nexcl: ps.filter(pid => t.paths[pid].excluded).length, bp: ps.reduce((a, pid) => a + t.paths[pid].bp, 0) } })
  return { meta: t.meta, H: t.H, R: t.R, total_bp: t.xbp.length ? t.xbp[t.xbp.length - 1] : 0, haps: perHap, atoms: t.atoms, bounds: t.bounds }
}

// 座標区間 [x0, x1] に重なる通過とコピー。ハプロタイプごとの通過数（×n の材料）も返す
export function travRange(t: Trav, x0: number, x1: number, opts: { minOverlap?: number; minAnchors?: number } = {}): any {
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? ORDER BY hid, pid, i0').all(x1, x0) as TravRow[]
  const mo = opts.minOverlap ?? 0; const ma = opts.minAnchors ?? 0   // 錨が少ない断片（硬い領域のかけら）は既定で出さない。ヒト v2 は 50 錨未満が 8,964 本で、x≈1.52M の 1 か所に 5,298 本集中
  const out = rows.filter(r => r.nanch >= ma && (mo <= 0 || Math.min(r.x1, x1) - Math.max(r.x0, x0) + 1 >= mo))
  const copies = t.db.prepare('SELECT id, pid, hid, x0, x1, ia0, ia1, ib0, ib1, bpa, bpb FROM copies WHERE x0 <= ? AND x1 >= ? ORDER BY hid, pid').all(x1, x0) as CopyRow[]
  const perHap: Record<number, number> = {}
  for (const r of out) perHap[r.hid] = (perHap[r.hid] || 0) + 1
  // 反復（出現単位: その株で 2 回以上出るノードの連なり）。トークン範囲しか持たないので、同じコンティグの通過の中の位置から座標を補間する
  const reps = t.db.prepare('SELECT r.id, r.pid, r.hid, r.i0, r.i1, r.bp, t.x0 AS tx0, t.x1 AS tx1, t.i0 AS ti0, t.i1 AS ti1, t.dir FROM reps r JOIN trav t ON t.pid = r.pid AND t.i0 <= r.i1 AND t.i1 >= r.i0 WHERE t.x0 <= ? AND t.x1 >= ? AND t.nanch >= ?').all(x1, x0, ma) as any[]
  const repsOut = reps.map(r => { const L = Math.max(1, r.ti1 - r.ti0); const f0 = Math.max(0, Math.min(1, (r.i0 - r.ti0) / L)), f1 = Math.max(0, Math.min(1, (r.i1 - r.ti0) / L)); const [a0, a1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]
    return { id: r.id, pid: r.pid, hid: r.hid, i0: r.i0, i1: r.i1, bp: r.bp, x0: Math.round(r.tx0 + a0 * (r.tx1 - r.tx0)), x1: Math.round(r.tx0 + a1 * (r.tx1 - r.tx0)) } }).filter(r => r.x1 >= x0 && r.x0 <= x1)   // 反復自体が区間に掛かるものだけ（通過が掛かるだけでは不足）
  return { x0, x1, bp0: t.xbp[Math.max(0, Math.min(t.xbp.length - 1, x0))], bp1: t.xbp[Math.max(0, Math.min(t.xbp.length - 1, x1 + 1))], trav: out, copies, reps: repsOut, perHap }
}

// 錨でないトークンも含めた「このコンティグのトークン区間 [i0, i1] が座標のどこに当たるか」は trav 表から引く
export function travOfPath(t: Trav, pid: number): TravRow[] {
  return t.db.prepare('SELECT * FROM trav WHERE pid = ? ORDER BY i0').all(pid) as TravRow[]
}

export function repsOfRange(t: Trav, pids: number[]): any[] {
  if (!pids.length) return []
  const q = `SELECT id, pid, hid, i0, i1, bp FROM reps WHERE pid IN (${pids.map(() => '?').join(',')}) ORDER BY pid, i0`
  return t.db.prepare(q).all(...pids)
}

// 原子 × ハプロタイプの通過数（ブロックの段の ×n）。通過が原子の半分以上を覆うか、通過が原子に収まる（原子の内側の小さな通過）ものを数える
// 単調性の違反の切断を持つハプロタイプが通る株の 3 割を超える原子は「もつれ」（順序が線形にならない硬い領域）とし、×n を数えない
export function travAtomStats(t: Trav, minAnchors = 50): { atoms: { id: number; nhap: number; nhap2: number; tangled: boolean; counts: Record<number, number> }[] } {
  const key = `atoms:${minAnchors}`; const c = (t as any)[key]; if (c) return c
  const rows = t.db.prepare('SELECT hid, x0, x1, nanch FROM trav WHERE nanch >= ? ORDER BY x0').all(minAnchors) as { hid: number; x0: number; x1: number; nanch: number }[]
  const out = t.atoms.map(a => ({ id: a.id, nhap: 0, nhap2: 0, tangled: false, counts: {} as Record<number, number> }))
  let j = 0
  for (let ai = 0; ai < t.atoms.length; ai++) {
    const a = t.atoms[ai]; const o = out[ai]
    while (j < rows.length && rows[j].x1 < a.x0) j++
    // ハプロタイプごとに、原子に関わる通過を x の順に見て、既に数えた範囲と 50% 以上重なるものだけを「もう 1 回」と数える
    // （共線な断片が並んでいるだけなら 1 回。硬い領域の細切れを ×n にしない）
    const seen: Record<number, [number, number][]> = {}
    for (let k = j; k < rows.length && rows[k].x0 <= a.x1; k++) {
      const r = rows[k]; const ov = Math.min(r.x1, a.x1) - Math.max(r.x0, a.x0) + 1
      if (!(ov >= 0.5 * (a.x1 - a.x0 + 1) || (r.x0 >= a.x0 && r.x1 <= a.x1))) continue
      const rs = seen[r.hid] || (seen[r.hid] = []); let dup = false
      for (const [s0, s1] of rs) { const o2 = Math.min(s1, r.x1) - Math.max(s0, r.x0) + 1; if (o2 >= 0.5 * Math.min(s1 - s0 + 1, r.x1 - r.x0 + 1)) { dup = true; break } }
      if (dup || rs.length === 0) o.counts[r.hid] = (o.counts[r.hid] || 0) + 1
      rs.push([r.x0, r.x1])
    }
    const v = Object.values(o.counts); o.nhap = v.length; o.tangled = (a.ntangle || 0) > 0.3 * Math.max(1, o.nhap); o.nhap2 = o.tangled ? 0 : v.filter(n => n >= 2).length
  }
  const res = { atoms: out }; (t as any)[key] = res; return res
}

// 座標区間の錨のノード名（グラフの強調用）。dense_of_x と id_map から n{元 id}
export function nodeNamesForRange(t: Trav, x0: number, x1: number, max = 5000): string[] {
  const dx = t.db.prepare("SELECT blob FROM arrays WHERE name='dense_of_x'").get() as { blob: Buffer } | undefined
  const im = t.db.prepare("SELECT blob FROM arrays WHERE name='id_map'").get() as { blob: Buffer } | undefined
  if (!dx || !im) return []
  const dense = new Int32Array(dx.blob.buffer, dx.blob.byteOffset, dx.blob.byteLength / 4); const idmap = new BigInt64Array(im.blob.buffer, im.blob.byteOffset, im.blob.byteLength / 8)
  const a = Math.max(0, x0), b = Math.min(dense.length - 1, x1); const n = b - a + 1; if (n <= 0) return []
  const step = n > max ? n / max : 1; const out: string[] = []
  for (let k = 0; k < Math.min(n, max); k++) { const x = a + Math.floor(k * step); const d = dense[x]; if (d >= 1) out.push('n' + idmap[d - 1].toString()) }
  return out
}
