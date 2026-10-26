// 通過（traversal）のサイドカー `<db>.trav`（functions/anchor2/build/synteny2_build.py が作る、SQLite）を読む。
// 設計: amipa-lab/plans/anchor2-traversals.md。錨の座標 x（多数決順の順位）、通過 trav（コンティグ × 座標区間 × 向き × コピー番号）、
// コピー copies（同じコンティグの通過の座標の重なり）、境界 bounds（支持・持続度）、原子 atoms、反復 reps（出現単位）。
// 現行の `.synteny` と並行して読む（置き換えはまだ）。
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDbDir } from './db'
import { distillFor } from './routes/bubbleMsa'
import { openDistill, Distill } from './distill'

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
  dbFile: string
  genesDb?: Database.Database | null   // <db>.genes（遺伝子レーン用。無ければ null）
  xOfDense?: Int32Array; kindOfDense?: Uint8Array; bpOfDense?: Int32Array; dist?: Distill | null   // 錨の列（travCols）用。初回に読む
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
  const t: Trav = { file: p, mtime, db, meta, H: haps.length, R: Number(meta.R ?? xbp.length - 1), haps, paths, atoms, bounds, xbp, hapPaths, dbFile }
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
  try { markRepeats(t, out) } catch (e) { console.warn('[trav/range] markRepeats', e) }
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

// 反復（出現単位）を座標に写したもの（hid ごと、x0 順）。×n の裏付けに使う
function repsByHap(t: Trav): Map<number, [number, number][]> {
  const c = (t as any).__repsByHap; if (c) return c
  const rows = t.db.prepare('SELECT r.hid, r.i0, r.i1, t.x0 AS tx0, t.x1 AS tx1, t.i0 AS ti0, t.i1 AS ti1, t.dir FROM reps r JOIN trav t ON t.pid = r.pid AND t.i0 <= r.i1 AND t.i1 >= r.i0').all() as any[]
  const m = new Map<number, [number, number][]>()
  for (const r of rows) { const L = Math.max(1, r.ti1 - r.ti0); const f0 = Math.max(0, Math.min(1, (r.i0 - r.ti0) / L)), f1 = Math.max(0, Math.min(1, (r.i1 - r.ti0) / L)); const [a0, a1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]
    if (!m.has(r.hid)) m.set(r.hid, []); m.get(r.hid)!.push([Math.round(r.tx0 + a0 * (r.tx1 - r.tx0)), Math.round(r.tx0 + a1 * (r.tx1 - r.tx0))]) }
  for (const v of m.values()) v.sort((a, b) => a[0] - b[0])
  ;(t as any).__repsByHap = m; return m
}
// 原子 × ハプロタイプの通過数（ブロックの段の ×n）。座標の再訪だけでは信用できない（試作で untangle の重複の +1% しか拾えず、もつれで偽が出る）ので、
// ×n はその株の反復（2 回以上出るノードの連なり）がその原子に掛かるときだけ数える。通過が原子の半分以上を覆うか、通過が原子に収まる（原子の内側の小さな通過）ものを数える
// 単調性の違反の切断を持つハプロタイプが通る株の 3 割を超える原子は「もつれ」（順序が線形にならない硬い領域）とし、×n を数えない
export function travAtomStats(t: Trav, minAnchors = 50): { atoms: { id: number; nhap: number; nhap2: number; tangled: boolean; counts: Record<number, number> }[] } {
  const key = `atoms:${minAnchors}`; const c = (t as any)[key]; if (c) return c
  const rows = t.db.prepare('SELECT hid, x0, x1, nanch FROM trav WHERE nanch >= ? ORDER BY x0').all(minAnchors) as { hid: number; x0: number; x1: number; nanch: number }[]
  const out = t.atoms.map(a => ({ id: a.id, nhap: 0, nhap2: 0, tangled: false, counts: {} as Record<number, number> }))
  const RB = repsByHap(t); const hasRep = (hid: number, a: TravAtom) => { const v = RB.get(hid); if (!v) return false; for (const [r0, r1] of v) { if (r0 > a.x1) break; if (r1 >= a.x0) return true } return false }
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
    for (const h of Object.keys(o.counts)) { const hid = Number(h); if (o.counts[hid] >= 2 && !hasRep(hid, a)) o.counts[hid] = 1 }   // 反復の裏付けが無い再訪は 1 回に
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

// ---- 錨の列（ブロックと塩基の間の段） ----
// 表示範囲 [x0, x1] を ncol 列に等分し、各通過（行）について列ごとに
//   pres = その列の錨（座標を持つノード）のうち行が持つ割合、cls = 行がその列で持つトークン列（錨も錨でないノードも、合意の向きで）のアレル番号
//   （同じトークン列＝同じ番号。0 ＝最多、255 ＝その列に掛からない）、ins = 錨でないノードの bp（挿入の長さ）
// を返す。トークンは distill の p_tok を通過の範囲だけ読む。走査が COLS_SCAN_MAX トークンを超える範囲は tooBig で断る（画面はブロックの段のまま）。
const COLS_SCAN_MAX = Number(process.env.AMIPA_TRAV_COLS_MAX) || 30_000_000
function b64(buf: ArrayBufferView): string { return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64') }
function ensureCols(t: Trav): boolean {
  if (t.xOfDense && t.kindOfDense && t.bpOfDense && t.dist) return true
  if (t.dist === null) return false
  const xd = t.db.prepare("SELECT blob FROM arrays WHERE name='x_of_dense'").get() as { blob: Buffer } | undefined
  const kd = t.db.prepare("SELECT blob FROM arrays WHERE name='kind'").get() as { blob: Buffer } | undefined
  const dir = distillFor(path.join(getDbDir(), path.basename(t.dbFile)))
  if (!xd || !kd || !dir) { t.dist = null; return false }
  t.xOfDense = new Int32Array(xd.blob.buffer.slice(xd.blob.byteOffset, xd.blob.byteOffset + xd.blob.byteLength))
  t.kindOfDense = new Uint8Array(kd.blob.buffer.slice(kd.blob.byteOffset, kd.blob.byteOffset + kd.blob.byteLength))
  t.dist = openDistill(dir)
  // ノードの bp: distill の s_bp は S 行のファイル順なので s_id で並べ直す（dense id で引けるように）
  const N = t.xOfDense.length; const bp = new Int32Array(N)
  const rd = (f: string) => { const fd = fs.openSync(path.join(dir, f), 'r'); const head = Buffer.alloc(128); fs.readSync(fd, head, 0, 128, 0); const major = head[6]; const hlen = major === 1 ? head.readUInt16LE(8) : head.readUInt32LE(8); const off = (major === 1 ? 10 : 12) + hlen
    const hb = Buffer.alloc(hlen); fs.readSync(fd, hb, 0, hlen, major === 1 ? 10 : 12); const m = /'descr':\s*'[<|=]?([iu])(\d)'/.exec(hb.toString('latin1')); const w = m ? Number(m[2]) : 4
    const sz = fs.fstatSync(fd).size - off; const buf = Buffer.alloc(sz); fs.readSync(fd, buf, 0, sz, off); fs.closeSync(fd)
    const n = sz / w; const out = new Float64Array(n)
    if (w === 8) { const v = new BigInt64Array(buf.buffer, buf.byteOffset, n); for (let i = 0; i < n; i++) out[i] = Number(v[i]) } else { const v = new Int32Array(buf.buffer, buf.byteOffset, n); out.set(v) }
    return out }
  try { const sid = rd('s_id.npy'), sbp = rd('s_bp.npy'); for (let i = 0; i < sid.length; i++) { const d = sid[i]; if (d >= 0 && d < N) bp[d] = sbp[i] } } catch (e) { console.log('[trav] s_bp read failed: ' + String(e)) }
  t.bpOfDense = bp
  return true
}
// 通過 r の、窓 [x0, x1] に当たるトークン区間を distill から読む。はみ出す通過は（x が錨の番号に比例するとして）区間を見積もり、読んだ端の錨が窓の中なら広げて読み直す
function windowTokens(t: Trav, r: TravRow, pi: number, x0: number, x1: number): { toks: Float64Array; s0: number; nread: number; tRead: number } {
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!
  const Lt = r.i1 - r.i0 + 1; const span = Math.max(1, r.x1 - r.x0); let s0 = r.i0, e0 = r.i1 + 1
  if (r.x0 < x0 || r.x1 > x1) {
    const wx0 = Math.max(x0, r.x0), wx1 = Math.min(x1, r.x1)
    const fa = r.dir >= 0 ? (wx0 - r.x0) / span : (r.x1 - wx1) / span, fb = r.dir >= 0 ? (wx1 - r.x0) / span : (r.x1 - wx0) / span
    const pad = Math.max(500, 0.1 * (fb - fa) * Lt + 0.02 * Lt); s0 = Math.max(r.i0, Math.floor(r.i0 + fa * Lt - pad)); e0 = Math.min(r.i1 + 1, Math.ceil(r.i0 + fb * Lt + pad))
  }
  let toks: Float64Array; let nread = 0, tRead = 0
  for (;;) {
    const tr0 = Date.now(); toks = dist.read(pi, s0, e0); tRead += Date.now() - tr0; nread += toks.length
    let lo = -1, hi = -1
    for (let k = 0; k < toks.length; k++) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { lo = X[d]; break } }
    for (let k = toks.length - 1; k >= 0; k--) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { hi = X[d]; break } }
    const cutLo = s0 > r.i0 && lo >= x0 && lo <= x1, cutHi = e0 < r.i1 + 1 && hi >= x0 && hi <= x1
    if (!cutLo && !cutHi) break
    const grow = Math.max(1000, e0 - s0); if (cutLo) s0 = Math.max(r.i0, s0 - grow); if (cutHi) e0 = Math.min(r.i1 + 1, e0 + grow)
  }
  return { toks, s0, nread, tRead }
}
// 窓 [x0, x1] に当たるトークンを合意の向きに歩く（dir<0 なら逆から）。錨（kind 1/2、x が窓の中）はその x で、錨でないノードは直前の錨の x で fn に渡す
// （窓の最初の錨より前の錨でないノードは次の錨に付ける＝窓の縁をまたぐ錨の間の配列）。窓の外の錨を見たら「外」に戻り、そこから先の錨でないノードは捨てる。ti = 錨のトークン番号（錨でないときは -1）
function forEachWindowToken(r: TravRow, toks: Float64Array, s0: number, x0: number, x1: number, X: Int32Array, K: Uint8Array, fn: (d: number, isAnchor: boolean, xa: number, ti: number) => void) {
  const n = toks.length; const step = r.dir >= 0 ? 1 : -1; let k = r.dir >= 0 ? 0 : n - 1; let curX = -1; let pend: number[] = []
  for (; k >= 0 && k < n; k += step) {
    const d = toks[k]; const kd = K[d]
    if (kd === 1 || kd === 2) {
      const x = X[d]
      if (x >= x0 && x <= x1) { if (pend.length) { for (const q of pend) fn(q, false, x, -1); pend = [] } curX = x; fn(d, true, x, s0 + k) }
      else { curX = -1; pend = [] }
    } else if (curX >= 0) fn(d, false, curX, -1)
    else pend.push(d)
  }
}
// 同じコンティグの通過どうしの x の重なりが「同じ座標の再訪（反復＝×k）」か「向きの変わり目・接合部の乱れ（1 回の通過が割れただけ）」かを、
// 重なりの中の錨の数で判定して rep に書く（2026-10-26）。逆位の片は隣の通過の x 範囲に収まるが、隣の通過はその範囲に錨を持たない（DDTL: 17 錨 対 121 錨）。
// 反復は両方が重なりの中に錨を持つ（ecoli 原子 365: 198 錨の 2 回目）。判定の読みは 1 要求あたり 400 回まで。それを超えた分と distill が無いときは重なりだけで true（従来）
function markRepeats(t: Trav, rows: TravRow[]): void {
  const ok = ensureCols(t); const byPid = new Map<number, TravRow[]>(); let budget = 400
  for (const r of rows) { (r as any).rep = undefined; if (!byPid.has(r.pid)) byPid.set(r.pid, []); byPid.get(r.pid)!.push(r) }
  const anchorsIn = (r: TravRow, a: number, b: number): number => {
    if (!ok || budget <= 0) return Infinity
    const pi = (t.dist!.names[r.pid] === t.paths[r.pid].path) ? r.pid : t.dist!.pidx.get(t.paths[r.pid].path); if (pi == null) return Infinity
    budget--; const wt = windowTokens(t, r, pi, a, b); let n = 0
    forEachWindowToken(r, wt.toks, wt.s0, a, b, t.xOfDense!, t.kindOfDense!, (_d, isA) => { if (isA) n++ })
    return n }
  for (const trs of byPid.values()) {
    if (trs.length < 2) continue
    trs.sort((p, q) => p.i0 - q.i0)
    let gx0 = trs[0].x0, gx1 = trs[0].x1, members: TravRow[] = [trs[0]]
    for (let i = 1; i < trs.length; i++) { const r = trs[i]
      const ov = Math.min(gx1, r.x1) - Math.max(gx0, r.x0) + 1
      if (ov >= 0.5 * Math.min(gx1 - gx0 + 1, r.x1 - r.x0 + 1)) {
        const a = Math.max(gx0, r.x0), b = Math.min(gx1, r.x1); const need = 10
        const nr = anchorsIn(r, a, b); let ng = 0; if (nr >= need) for (const m of members) { ng += anchorsIn(m, a, b); if (ng >= need) break }
        const rep = nr >= need && ng >= need; (r as any).rep = rep
        if (rep) { gx0 = Math.min(gx0, r.x0); gx1 = Math.max(gx1, r.x1); members.push(r); continue }
        // 反復でない重なり（逆位の片・接合部の乱れ）: 重なりの中に錨を持たない側の x 範囲からその区間を除く（trim）。通過の x0/x1 は錨の最小・最大なので、
        // ε で吸われた 1〜2 個の錨のせいで両側の通過が反転ブロックの座標まで食い込み、各行の並びで同じブロックが 2 度描かれて連結線が乱れた（DDTL）
        if (nr < need) (r as any).trim = [a, b]; else if (ng < need) (members[members.length - 1] as any).trim = [a, b]
      }
      gx0 = r.x0; gx1 = r.x1; members = [r]
    }
  }
}
function idMapOf(t: Trav): BigInt64Array {
  const c = (t as any).__idmap as BigInt64Array | undefined; if (c) return c
  const im = t.db.prepare("SELECT blob FROM arrays WHERE name='id_map'").get() as { blob: Buffer } | undefined
  const arr = im ? new BigInt64Array(im.blob.buffer.slice(im.blob.byteOffset, im.blob.byteOffset + im.blob.byteLength)) : new BigInt64Array(0)
  ;(t as any).__idmap = arr; return arr
}
export function travCols(t: Trav, x0: number, x1: number, ncol: number, minAnchors = 50): any {
  const T00 = Date.now()
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い' }
  const X = t.xOfDense!, K = t.kindOfDense!, BP = t.bpOfDense!, dist = t.dist!
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1)); const W = x1 - x0 + 1; if (W <= 0) return { error: 'empty' }
  ncol = Math.max(1, Math.min(W, Math.floor(ncol) || 1))
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, minAnchors) as TravRow[]
  try { markRepeats(t, rows) } catch (e) { console.warn('[trav/cols] markRepeats', e) }
  // 読む量の見積もり: 通過のうち窓に掛かる割合（x が錨の番号に比例するとして）× トークン数 ＋ 余白。ヒトは 1 通過が 100 万トークンなので全長で数えると小さな窓でも断ってしまう
  let ntok = 0; for (const r of rows) { const span = Math.max(1, r.x1 - r.x0 + 1); const ov = Math.max(0, Math.min(r.x1, x1) - Math.max(r.x0, x0) + 1); ntok += Math.ceil((r.i1 - r.i0 + 1) * Math.min(1, ov / span) * 1.2) + 1000 }
  if (ntok > COLS_SCAN_MAX) return { tooBig: true, ntok, max: COLS_SCAN_MAX, x0, x1 }
  const colOf = (x: number) => Math.min(ncol - 1, Math.floor((x - x0) * ncol / W))
  const nanch = new Uint16Array(ncol); for (let c = 0; c < ncol; c++) { const a = Math.ceil(c * W / ncol), b = Math.ceil((c + 1) * W / ncol); nanch[c] = Math.min(65535, Math.max(0, b - a)) }
  type RowOut = { id: number; pid: number; hid: number; dir: number; copy: number; rep?: boolean; tw0: number; tw1: number; pres: Uint8Array; cls: Uint8Array; ins: Uint16Array; bpc: Uint32Array; h1: Uint32Array; h2: Uint32Array; has: Uint8Array; frq: Uint8Array }
  const outs: RowOut[] = []
  const T0 = Date.now(); let tRead = 0, tMix = 0, nread = 0
  for (const r of rows) {
    // distill のパス番号: .trav の pid は distill の p_names の順（構築器が同じ順で読む）。名前で引くと重複した名前（ヒト v2 の分割された W 行）で別のパスに当たる
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    const wt = windowTokens(t, r, pi, x0, x1); const toks = wt.toks, s0 = wt.s0; tRead += wt.tRead; nread += wt.nread
    const pres = new Uint8Array(ncol), cls = new Uint8Array(ncol).fill(255), ins = new Uint16Array(ncol), h1 = new Uint32Array(ncol), h2 = new Uint32Array(ncol), has = new Uint8Array(ncol); const cnt = new Uint16Array(ncol); const insb = new Float64Array(ncol); const bpcf = new Float64Array(ncol)   // bpcf = この行のトークンの bp の合計（錨も錨でないノードも。各行の並びの幅）
    let tw0 = -1, tw1 = -1
    const tm0 = Date.now()
    forEachWindowToken(r, toks, s0, x0, x1, X, K, (d, isA, xa, ti) => {
      const c = Math.min(ncol - 1, Math.floor((xa - x0) * ncol / W)); has[c] = 1
      h1[c] = Math.imul(h1[c] ^ d, 0x01000193) >>> 0; h2[c] = (Math.imul(h2[c], 0x9E3779B1) + d + 1) >>> 0
      bpcf[c] += BP[d]
      if (isA) { cnt[c]++; if (tw0 < 0 || ti < tw0) tw0 = ti; if (ti > tw1) tw1 = ti } else insb[c] += BP[d]
    })
    tMix += Date.now() - tm0
    const bpc = new Uint32Array(ncol); for (let c = 0; c < ncol; c++) { pres[c] = nanch[c] ? Math.min(255, Math.round(255 * cnt[c] / nanch[c])) : 0; ins[c] = Math.min(65535, Math.round(insb[c])); bpc[c] = Math.min(0xffffffff, Math.round(bpcf[c])) }
    outs.push({ id: r.id, pid: r.pid, hid: r.hid, dir: r.dir, copy: r.copy, rep: (r as any).rep, tw0, tw1, pres, cls, ins, bpc, h1, h2, has, frq: new Uint8Array(ncol) })
  }
  // 列ごとにトークン列（ハッシュ）の種類を数え、多い順に番号を振る
  const ncls = new Uint8Array(ncol), nrow = new Uint16Array(ncol), major = new Uint16Array(ncol)
  for (let c = 0; c < ncol; c++) {
    const m = new Map<string, number>(); for (const o of outs) if (o.has[c]) { const key = o.h1[c] + ':' + o.h2[c]; m.set(key, (m.get(key) || 0) + 1) }
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]); const idx = new Map(ranked.map((e, i) => [e[0], i]))
    const tot = ranked.reduce((a, e) => a + e[1], 0)
    for (const o of outs) if (o.has[c]) { const key = o.h1[c] + ':' + o.h2[c]; o.cls[c] = Math.min(254, idx.get(key)!); o.frq[c] = Math.min(255, Math.round(255 * (m.get(key) || 0) / Math.max(1, tot))) }   // frq = この行のアレルを持つ行の割合（粗い段の塗り）
    ncls[c] = Math.min(255, ranked.length); nrow[c] = m.size ? ranked.reduce((a, e) => a + e[1], 0) : 0; major[c] = ranked.length ? ranked[0][1] : 0
  }
  const ms = Date.now() - T0; if (ms > 2000) console.log(`[trav/cols] ${rows.length} rows, read ${nread} tok (${tRead} ms), mix ${tMix} ms, total ${ms} ms`)
  return { x0, x1, ncol, ntok, nread, ms, msPre: T0 - T00, msRead: tRead, nrows: rows.length, cols: { nanch: b64(nanch), ncls: b64(ncls), nrow: b64(nrow), major: b64(major) },
    rows: outs.map(o => ({ id: o.id, pid: o.pid, hid: o.hid, dir: o.dir, copy: o.copy, rep: o.rep, tw0: o.tw0, tw1: o.tw1, pres: b64(o.pres), cls: b64(o.cls), ins: b64(o.ins), bpc: b64(o.bpc), frq: b64(o.frq) })) }
}

// ---- 遺伝子レーン: 表示範囲に掛かる通過ごとに、その株の遺伝子（<db>.genes の gene × gene_tok）を座標 x に写す ----
// 遺伝子の x は両端のトークン（各 256 個まで）の中の錨の x の最小・最大。錨が無い遺伝子（島の中など）は通過の中の位置から補間
function genesDbOf(t: Trav): Database.Database | null {
  if (t.genesDb !== undefined) return t.genesDb
  const base = path.join(getDbDir(), path.basename(t.dbFile)); const cands = [base + '.genes']
  try { cands.push(fs.realpathSync(base) + '.genes') } catch { /* ignore */ }
  const f = cands.find(c => { try { return fs.existsSync(c) } catch { return false } })
  t.genesDb = f ? new Database(f, { readonly: true }) : null
  return t.genesDb
}
const GENES_MAX = Number(process.env.AMIPA_TRAV_GENES_MAX) || 30_000
export function travGenes(t: Trav, x0: number, x1: number, minAnchors = 50, withNodes = false): any {
  const gdb = genesDbOf(t); if (!gdb) return { error: 'この DB には .genes サイドカーが無い', genes: [] }
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', genes: [] }
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1))
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, minAnchors) as TravRow[]
  const q = gdb.prepare('SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, k.s0, k.e0 FROM gene g JOIN gene_tok k ON k.gid = g.gid WHERE g.pid = ? AND k.e0 > ? AND k.s0 < ?')
  const qch = gdb.prepare("SELECT f.type, f.phase, f.strand, f.parent, f.start, f.end, t.s0, t.e0, t.so, t.eo FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.gid = ? AND f.type IN ('CDS','cds','exon','five_prime_UTR','three_prime_UTR','UTR') ORDER BY t.s0")   // 子（エキソン・CDS・UTR）のトークン範囲と読み枠
  const idmapG = withNodes ? idMapOf(t) : null
  const out: any[] = []; let n = 0; const T0 = Date.now()
  // まず件数だけ数え、多すぎる範囲（全景など）はトークンを読まずに断る
  const qn = gdb.prepare('SELECT count(*) AS n FROM gene g JOIN gene_tok k ON k.gid = g.gid WHERE g.pid = ? AND k.e0 > ? AND k.s0 < ?')
  const winOf = (r: TravRow): [number, number] => { const Lt = r.i1 - r.i0 + 1; const span = Math.max(1, r.x1 - r.x0); const wx0 = Math.max(x0, r.x0), wx1 = Math.min(x1, r.x1)
    const fa = r.dir >= 0 ? (wx0 - r.x0) / span : (r.x1 - wx1) / span, fb = r.dir >= 0 ? (wx1 - r.x0) / span : (r.x1 - wx0) / span
    const pad = Math.max(2000, 0.2 * (fb - fa) * Lt + 0.02 * Lt); return [Math.max(r.i0, Math.floor(r.i0 + fa * Lt - pad)), Math.min(r.i1 + 1, Math.ceil(r.i0 + fb * Lt + pad))] }
  let est = 0; for (const r of rows) { const [ta, tb] = winOf(r); est += (qn.get(r.pid, ta, tb) as { n: number }).n; if (est > GENES_MAX) return { tooMany: true, n: est, max: GENES_MAX, genes: [] } }
  // トークン [a, b) の中の錨: x の最小・最大と錨の dense id（オルソログ群＝ノード共有の材料）
  const anchorsIn = (pi: number, a: number, b: number, acc: number[]): [number, number] => {
    const toks = dist.read(pi, a, b); let lo = 1e18, hi = -1
    for (let k = 0; k < toks.length; k++) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { const x = X[d]; if (x < lo) lo = x; if (x > hi) hi = x; acc.push(d) } }
    return hi < 0 ? [-1, -1] : [lo, hi]
  }
  const geneAnch: number[][] = []   // 遺伝子ごとの錨（両端 1,500 トークンまで）
  for (const r of rows) {
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    // 窓に当たるトークン区間の見積もり（x が錨の番号に比例）。余白を広めに取り、遺伝子ごとの x で絞る
    const Lt = r.i1 - r.i0 + 1; const span = Math.max(1, r.x1 - r.x0); const [ta, tb] = winOf(r)
    const gs = q.all(r.pid, ta, tb) as any[]
    for (const g of gs) {
      if (++n > GENES_MAX) return { tooMany: true, n, max: GENES_MAX, genes: [] }
      const s0 = Math.max(r.i0, g.s0), e0 = Math.min(r.i1 + 1, g.e0); if (e0 <= s0) continue
      const acc: number[] = []; const A = anchorsIn(pi, s0, Math.min(e0, s0 + 1500), acc); const B = e0 - 1500 > s0 + 1500 ? anchorsIn(pi, Math.max(s0, e0 - 1500), e0, acc) : [-1, -1]
      let gx0 = Math.min(A[0] < 0 ? 1e18 : A[0], B[0] < 0 ? 1e18 : B[0]), gx1 = Math.max(A[1], B[1])
      if (gx1 < 0) {   // 錨が無い: 通過の中の位置から補間
        const f0 = (s0 - r.i0) / Lt, f1 = (e0 - r.i0) / Lt; const [u0, u1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]; gx0 = Math.round(r.x0 + u0 * span); gx1 = Math.round(r.x0 + u1 * span)
      }
      if (gx1 < x0 || gx0 > x1) continue
      // 子（エキソン・CDS・UTR）: 遺伝子のトークン範囲の中の位置を座標に比例で写す（転写産物が複数なら種類ごとに併合）。遺伝子が多い範囲（5,000 超）では省く
      let ch: [string, number, number][] | undefined; let nodesOut: any
      if (rows.length <= 400 && n <= 5000) {
        const L = Math.max(1, g.e0 - g.s0); const span2 = gx1 - gx0; const rev = r.dir < 0
        const toX = (tok: number) => { const f = Math.max(0, Math.min(1, (tok - g.s0) / L)); return rev ? gx1 - f * span2 : gx0 + f * span2 }
        const per = new Map<string, [number, number][]>()
        const chs = qch.all(g.gid) as { type: string; phase: string; strand: string; parent: number | null; start: number; end: number; s0: number; e0: number; so: number; eo: number }[]
        for (const c of chs) { const kind = /cds/i.test(c.type) ? 'cds' : /utr/i.test(c.type) ? 'utr' : 'exon'; const a = toX(c.s0), b = toX(c.e0); const lo = Math.round(Math.min(a, b)), hi = Math.round(Math.max(a, b)); if (!per.has(kind)) per.set(kind, []); per.get(kind)!.push([lo, hi]) }
        // 塩基の段用: 遺伝子（と CDS の片）のトークンのノード名。窓に当たる分だけ（通過のトークン区間の中）、1 遺伝子 6,000 個まで
        if (withNodes && idmapG && out.length < 300) {
          const ta = Math.max(s0, g.s0), tb = Math.min(e0, g.e0); const toks = dist.read(pi, ta, Math.min(tb, ta + 6000)); const names: string[] = []; for (let k = 0; k < toks.length; k++) names.push('n' + idmapG[toks[k] - 1].toString())
          // CDS の片は転写産物 1 本（親 parent ごとに合計 bp が最大のもの）に絞る。GENCODE は転写産物が複数あり、混ぜると読み枠が壊れて全行が変異・終止になる（APOBEC3B は 4 転写産物 28 片）
          const byParent = new Map<string, { len: number; parts: typeof chs }>(); for (const c of chs) { if (!/cds/i.test(c.type)) continue; const k = c.parent == null ? '' : String(c.parent); const e = byParent.get(k) || { len: 0, parts: [] }; e.len += Math.max(0, c.end - c.start + 1); e.parts.push(c); byParent.set(k, e) }
          let bestP: typeof chs = []; let bestLen = -1; for (const e of byParent.values()) if (e.len > bestLen) { bestLen = e.len; bestP = e.parts }
          const cds = bestP.map(c => ({ s0: Math.max(ta, c.s0), e0: Math.min(ta + toks.length, c.e0), phase: Number(c.phase) || 0, strand: c.strand, so: c.so, eo: c.eo, gs0: c.s0 })).filter(c => c.e0 > c.s0).map(c => ({ names: names.slice(c.s0 - ta, c.e0 - ta), phase: c.phase, strand: c.strand, so: c.so, eo: c.eo, first: c.gs0 === g.s0 }))
          const exon = chs.filter(c => !/cds/i.test(c.type) && !/utr/i.test(c.type)).map(c => names.slice(Math.max(ta, c.s0) - ta, Math.min(ta + toks.length, c.e0) - ta))
          nodesOut = { names, cds, exon, t0: ta, t1: Math.min(tb, ta + 6000) }
        }
        if (per.size) { ch = []; for (const [kind, iv] of per) { iv.sort((u, v) => u[0] - v[0]); let cur: [number, number] | null = null; for (const [lo, hi] of iv) { if (cur && lo <= cur[1] + 1) cur[1] = Math.max(cur[1], hi); else { if (cur) ch.push([kind, cur[0], cur[1]]); cur = [lo, hi] } } if (cur) ch.push([kind, cur[0], cur[1]]) } }
      }
      out.push({ gid: g.gid, pid: g.pid, hid: r.hid, tr: r.id, x0: gx0, x1: gx1, s0: g.s0, e0: g.e0, start: g.start, end: g.end, strand: g.strand, fwd: ((g.strand === '-' ? -1 : 1) * (r.dir >= 0 ? 1 : -1)) > 0, type: g.type, name: g.name, locus: g.locus, product: g.product, pseudo: !!g.pseudo, anchored: A[1] >= 0 || B[1] >= 0, og: -1, ch, nodes: nodesOut })
      geneAnch.push(acc)
    }
  }
  // オルソログ群: 同じ種類（タンパク質コード＋擬似／RNA／その他）の遺伝子で、錨（ノード）を 2 個以上、または小さい方の 10% 以上共有するものを結ぶ（連結成分）
  const kindOf = (g: any) => (g.pseudo || /pseudo/i.test(g.type)) ? 'cds' : /^(cds|gene|mrna|protein_coding|protein-coding)$/i.test(g.type) ? 'cds' : /rna/i.test(g.type) ? 'rna' : 'other'
  const par = out.map((_, i) => i); const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i] } return i }
  const byNode = new Map<number, number[]>(); out.forEach((g, i) => { for (const d of geneAnch[i]) { const a = byNode.get(d); if (a) a.push(i); else byNode.set(d, [i]) } })
  const shared = new Map<string, number>()   // "i:j" → 共有する錨の数
  for (const lst of byNode.values()) { if (lst.length < 2 || lst.length > 400) continue; for (let a = 0; a < lst.length; a++) for (let b = a + 1; b < lst.length; b++) { const i = lst[a], j = lst[b]; if (i === j || out[i].hid === out[j].hid && out[i].tr === out[j].tr) continue; const key = i < j ? i + ':' + j : j + ':' + i; shared.set(key, (shared.get(key) || 0) + 1) } }
  for (const [key, n] of shared) { const [i, j] = key.split(':').map(Number); if (kindOf(out[i]) !== kindOf(out[j])) continue; const minA = Math.min(geneAnch[i].length, geneAnch[j].length); if (n >= 2 || n >= 0.1 * minA) { const a = find(i), b = find(j); if (a !== b) par[a] = b } }
  const groups = new Map<number, { og: number; x0: number; x1: number; n: number; haps: Set<number>; names: Map<string, number>; fwd: number; npseudo: number; kind: string; members: number[] }>()
  out.forEach((g, i) => { const r = find(i); let G = groups.get(r); if (!G) { G = { og: groups.size, x0: g.x0, x1: g.x1, n: 0, haps: new Set(), names: new Map(), fwd: 0, npseudo: 0, kind: kindOf(g), members: [] }; groups.set(r, G) }
    G.x0 = Math.min(G.x0, g.x0); G.x1 = Math.max(G.x1, g.x1); G.n++; G.haps.add(g.hid); if (g.name) G.names.set(g.name, (G.names.get(g.name) || 0) + 1); if (g.fwd) G.fwd++; if (g.pseudo) G.npseudo++; G.members.push(g.gid); g.og = G.og })
  const ogs = [...groups.values()].map(G => ({ og: G.og, x0: G.x0, x1: G.x1, n: G.n, nhap: G.haps.size, name: [...G.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '', fwd: G.fwd, npseudo: G.npseudo, kind: G.kind })).sort((a, b) => a.x0 - b.x0)
  return { x0, x1, n: out.length, ms: Date.now() - T0, genes: out, groups: ogs }
}

// ---- 窓のノード集合（グラフをこの範囲に絞る用）: 窓に当たる錨と、その錨に付く錨でないノードの名前（葉）。最大 max 個 ----
export function travNodeSet(t: Trav, x0: number, x1: number, minAnchors = 50, max = 20000): any {
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', names: [] }
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!; const idmap = idMapOf(t)
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1)); if (x1 < x0) return { error: 'empty', names: [] }
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, minAnchors) as TravRow[]
  let ntok = 0; for (const r of rows) { const span = Math.max(1, r.x1 - r.x0 + 1); const ov = Math.max(0, Math.min(r.x1, x1) - Math.max(r.x0, x0) + 1); ntok += Math.ceil((r.i1 - r.i0 + 1) * Math.min(1, ov / span) * 1.2) + 1000 }
  if (ntok > COLS_SCAN_MAX) return { tooBig: true, ntok, max: COLS_SCAN_MAX, names: [] }
  const seen = new Uint8Array(X.length); const names: string[] = []; const xs: number[] = []; let truncated = false; const T0 = Date.now()
  outer: for (const r of rows) {
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    const wt = windowTokens(t, r, pi, x0, x1); let full = false
    forEachWindowToken(r, wt.toks, wt.s0, x0, x1, X, K, (d, _isA, xa) => { if (full || seen[d]) return; seen[d] = 1; if (names.length >= max) { truncated = true; full = true; return } names.push('n' + idmap[d - 1].toString()); xs.push(xa) })   // xs = 付いている錨の座標（塗り分け用）
    if (full) break outer
  }
  return { x0, x1, n: names.length, truncated, ms: Date.now() - T0, names, xs }
}
// ---- ノード名 → 座標（グラフ → パネル）: n<元 id> を id_map の逆引きで dense に、x_of_dense で座標に。錨でないノードは x=-1 ----
function origIndex(t: Trav): { ids: Float64Array; order: Uint32Array } {
  const c = (t as any).__origIdx; if (c) return c
  const im = idMapOf(t); const n = im.length; const ids = new Float64Array(n); for (let i = 0; i < n; i++) ids[i] = Number(im[i])
  const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i
  let sorted = true; for (let i = 1; i < n; i++) if (ids[i] < ids[i - 1]) { sorted = false; break }
  if (!sorted) {   // (id, 添字) を 1 つの数に詰めて比較関数なしで並べる（4.8M 個で 1 s 未満。比較関数つきだと 20 s 超）。id が大きすぎて詰められないときだけ比較関数
    let maxId = 0; for (let i = 0; i < n; i++) if (ids[i] > maxId) maxId = ids[i]
    const SH = 8388608   // 2^23
    if (n < SH && maxId < 536870912) { const keys = new Float64Array(n); for (let i = 0; i < n; i++) keys[i] = ids[i] * SH + i; keys.sort(); for (let k = 0; k < n; k++) order[k] = keys[k] % SH }
    else { const arr = Array.from(order); arr.sort((a, b) => ids[a] - ids[b]); order.set(arr) }
  }
  const r = { ids, order }; (t as any).__origIdx = r; return r
}
export function travLocate(t: Trav, names: string[]): any {
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', nodes: [] }
  const { ids, order } = origIndex(t); const X = t.xOfDense!, K = t.kindOfDense!
  // スーパーノード（上の層の名前）: super 表（super_build.py が足す。子孫の葉のうち bp 合計が最大の派閥の x）
  const hasSuper = (() => { const c = (t as any).__hasSuper; if (c != null) return c; const r = t.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='super'").get() as { n: number }; (t as any).__hasSuper = r.n > 0; return r.n > 0 })()
  const qs = hasSuper ? t.db.prepare('SELECT x, frac, bp, xmin, xmax FROM super WHERE name = ?') : null
  // 錨でない葉の座標（x_fill: 同じパスで直前の錨の x の bp 多数決。xfill_build.py が足す）
  const XF: Int32Array | null = (() => { const c = (t as any).__xfill; if (c !== undefined) return c; const r = t.db.prepare("SELECT blob FROM arrays WHERE name='x_fill'").get() as { blob: Buffer } | undefined; const v = r ? new Int32Array(r.blob.buffer.slice(r.blob.byteOffset, r.blob.byteOffset + r.blob.byteLength)) : null; (t as any).__xfill = v; return v })()
  const nodes = names.slice(0, 5000).map(nm => {
    const m = /^n(\d+)$/.exec(nm)
    if (!m) { const r = qs ? (qs.get(nm) as { x: number; frac: number; bp: number; xmin: number; xmax: number } | undefined) : undefined; return r ? { name: nm, x: r.x, kind: -2, frac: r.frac, bp: r.bp, xmin: r.xmin, xmax: r.xmax } : { name: nm, x: -1, kind: -1 } }
    const v = Number(m[1]); let lo = 0, hi = order.length - 1, found = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; const vv = ids[order[mid]]; if (vv === v) { found = order[mid]; break } if (vv < v) lo = mid + 1; else hi = mid - 1 }
    if (found < 0) return { name: nm, x: -1, kind: -1 }
    const d = found + 1; if (X[d] >= 0) return { name: nm, x: X[d], kind: K[d] }; if (XF && XF[d] >= 0) return { name: nm, x: XF[d], kind: 6 }; return { name: nm, x: -1, kind: K[d] }   // kind 6 ＝ 錨でない葉に直前の錨の座標を与えたもの
  })
  return { nodes, R: t.R, hasSuper, hasFill: !!XF }
}

// ---- 遺伝子名の検索（Traversals パネルの検索欄）: 名前・locus の前方一致、産物の部分一致。見つかった遺伝子ごとに座標（両端 1,500 トークンの錨の x）----
export function travFindGene(t: Trav, q: string, limit = 60): any {
  const gdb = genesDbOf(t); if (!gdb) return { error: 'この DB には .genes サイドカーが無い', hits: [] }
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', hits: [] }
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!
  const qq = q.trim(); if (!qq) return { hits: [] }
  const rows = gdb.prepare("SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, k.s0, k.e0 FROM gene g JOIN gene_tok k ON k.gid = g.gid WHERE g.name LIKE ? COLLATE NOCASE OR g.locus LIKE ? COLLATE NOCASE OR g.product LIKE ? COLLATE NOCASE ORDER BY (g.name LIKE ? COLLATE NOCASE) DESC, g.name, g.pid LIMIT ?")
    .all(qq + '%', qq + '%', '%' + qq + '%', qq + '%', limit) as any[]
  const hidOf = new Map(t.paths.map(p => [p.pid, p.hid])); const T0 = Date.now()
  const hits = rows.map(g => {
    const pi = (dist.names[g.pid] === t.paths[g.pid].path) ? g.pid : dist.pidx.get(t.paths[g.pid].path); let x0 = -1, x1 = -1
    if (pi != null) { const rd = (a: number, b: number) => { const toks = dist.read(pi, a, b); for (let k = 0; k < toks.length; k++) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { const x = X[d]; if (x0 < 0 || x < x0) x0 = x; if (x > x1) x1 = x } } }
      rd(g.s0, Math.min(g.e0, g.s0 + 1500)); if (g.e0 - 1500 > g.s0 + 1500) rd(Math.max(g.s0, g.e0 - 1500), g.e0) }
    return { gid: g.gid, pid: g.pid, hid: hidOf.get(g.pid), hap: t.haps[hidOf.get(g.pid) ?? 0], path: t.paths[g.pid].path, start: g.start, end: g.end, strand: g.strand, type: g.type, name: g.name, locus: g.locus, product: g.product, pseudo: !!g.pseudo, x0, x1 }
  })
  return { q: qq, n: hits.length, truncated: rows.length >= limit, ms: Date.now() - T0, hits }
}
