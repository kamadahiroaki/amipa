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
export function travCols(t: Trav, x0: number, x1: number, ncol: number, minAnchors = 50): any {
  const T00 = Date.now()
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い' }
  const X = t.xOfDense!, K = t.kindOfDense!, BP = t.bpOfDense!, dist = t.dist!
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1)); const W = x1 - x0 + 1; if (W <= 0) return { error: 'empty' }
  ncol = Math.max(1, Math.min(W, Math.floor(ncol) || 1))
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, minAnchors) as TravRow[]
  // 読む量の見積もり: 通過のうち窓に掛かる割合（x が錨の番号に比例するとして）× トークン数 ＋ 余白。ヒトは 1 通過が 100 万トークンなので全長で数えると小さな窓でも断ってしまう
  let ntok = 0; for (const r of rows) { const span = Math.max(1, r.x1 - r.x0 + 1); const ov = Math.max(0, Math.min(r.x1, x1) - Math.max(r.x0, x0) + 1); ntok += Math.ceil((r.i1 - r.i0 + 1) * Math.min(1, ov / span) * 1.2) + 1000 }
  if (ntok > COLS_SCAN_MAX) return { tooBig: true, ntok, max: COLS_SCAN_MAX, x0, x1 }
  const colOf = (x: number) => Math.min(ncol - 1, Math.floor((x - x0) * ncol / W))
  const nanch = new Uint16Array(ncol); for (let c = 0; c < ncol; c++) { const a = Math.ceil(c * W / ncol), b = Math.ceil((c + 1) * W / ncol); nanch[c] = Math.min(65535, Math.max(0, b - a)) }
  type RowOut = { id: number; pid: number; hid: number; dir: number; copy: number; tw0: number; tw1: number; pres: Uint8Array; cls: Uint8Array; ins: Uint16Array; h1: Uint32Array; h2: Uint32Array; has: Uint8Array }
  const outs: RowOut[] = []
  const T0 = Date.now(); let tRead = 0, tMix = 0, nread = 0
  for (const r of rows) {
    // distill のパス番号: .trav の pid は distill の p_names の順（構築器が同じ順で読む）。名前で引くと重複した名前（ヒト v2 の分割された W 行）で別のパスに当たる
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    // 通過が窓からはみ出すときは、窓に当たるトークン区間を（x が錨の番号に比例するとして）補間で見積もり、読んだ端の錨が窓の中なら広げて読み直す
    const Lt = r.i1 - r.i0 + 1; const span = Math.max(1, r.x1 - r.x0); let s0 = r.i0, e0 = r.i1 + 1
    if (r.x0 < x0 || r.x1 > x1) {
      const wx0 = Math.max(x0, r.x0), wx1 = Math.min(x1, r.x1)
      const fa = r.dir >= 0 ? (wx0 - r.x0) / span : (r.x1 - wx1) / span, fb = r.dir >= 0 ? (wx1 - r.x0) / span : (r.x1 - wx0) / span
      let pad = Math.max(500, 0.1 * (fb - fa) * Lt + 0.02 * Lt); s0 = Math.max(r.i0, Math.floor(r.i0 + fa * Lt - pad)); e0 = Math.min(r.i1 + 1, Math.ceil(r.i0 + fb * Lt + pad))
    }
    let toks: Float64Array
    for (;;) {
      const tr0 = Date.now(); toks = dist.read(pi, s0, e0); tRead += Date.now() - tr0; nread += toks.length
      // 読んだ区間の両端で最初に出る錨が窓の中なら、窓の内容を切っているかもしれないので広げる
      let lo = -1, hi = -1
      for (let k = 0; k < toks.length; k++) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { lo = X[d]; break } }
      for (let k = toks.length - 1; k >= 0; k--) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { hi = X[d]; break } }
      const cutLo = s0 > r.i0 && lo >= x0 && lo <= x1, cutHi = e0 < r.i1 + 1 && hi >= x0 && hi <= x1
      if (!cutLo && !cutHi) break
      const grow = Math.max(1000, e0 - s0); if (cutLo) s0 = Math.max(r.i0, s0 - grow); if (cutHi) e0 = Math.min(r.i1 + 1, e0 + grow)
    }
    const n = toks.length
    const pres = new Uint8Array(ncol), cls = new Uint8Array(ncol).fill(255), ins = new Uint16Array(ncol), h1 = new Uint32Array(ncol), h2 = new Uint32Array(ncol), has = new Uint8Array(ncol); const cnt = new Uint16Array(ncol); const insb = new Float64Array(ncol)
    let tw0 = -1, tw1 = -1
    // 合意の向きに歩く（dir<0 なら逆から）。錨でないノードは直前の（窓の中の）錨の列に付ける。窓の外の錨を見たら「外」に戻る。
    // 窓の最初の錨より前の錨でないノードは、次の錨が窓の中ならその列に付ける（窓の縁をまたぐ錨の間の配列）
    const tm0 = Date.now()
    const step = r.dir >= 0 ? 1 : -1; let k = r.dir >= 0 ? 0 : n - 1; let cur = -1; let pend: number[] = []
    for (; k >= 0 && k < n; k += step) {
      const d = toks[k]; const kd = K[d]
      if (kd === 1 || kd === 2) {
        const x = X[d]
        if (x >= x0 && x <= x1) {
          const c = Math.min(ncol - 1, Math.floor((x - x0) * ncol / W)); cur = c; cnt[c]++
          h1[c] = Math.imul(h1[c] ^ d, 0x01000193) >>> 0; h2[c] = (Math.imul(h2[c], 0x9E3779B1) + d + 1) >>> 0; has[c] = 1
          if (pend.length) { for (const q of pend) { h1[c] = Math.imul(h1[c] ^ q, 0x01000193) >>> 0; h2[c] = (Math.imul(h2[c], 0x9E3779B1) + q + 1) >>> 0; insb[c] += BP[q] } pend = [] }
          const ti = s0 + k; if (tw0 < 0 || ti < tw0) tw0 = ti; if (ti > tw1) tw1 = ti
        } else { cur = -1; pend = [] }
      } else if (cur >= 0) { h1[cur] = Math.imul(h1[cur] ^ d, 0x01000193) >>> 0; h2[cur] = (Math.imul(h2[cur], 0x9E3779B1) + d + 1) >>> 0; insb[cur] += BP[d] }
      else pend.push(d)
    }
    tMix += Date.now() - tm0
    for (let c = 0; c < ncol; c++) { pres[c] = nanch[c] ? Math.min(255, Math.round(255 * cnt[c] / nanch[c])) : 0; ins[c] = Math.min(65535, Math.round(insb[c])) }
    outs.push({ id: r.id, pid: r.pid, hid: r.hid, dir: r.dir, copy: r.copy, tw0, tw1, pres, cls, ins, h1, h2, has })
  }
  // 列ごとにトークン列（ハッシュ）の種類を数え、多い順に番号を振る
  const ncls = new Uint8Array(ncol), nrow = new Uint16Array(ncol), major = new Uint16Array(ncol)
  for (let c = 0; c < ncol; c++) {
    const m = new Map<string, number>(); for (const o of outs) if (o.has[c]) { const key = o.h1[c] + ':' + o.h2[c]; m.set(key, (m.get(key) || 0) + 1) }
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]); const idx = new Map(ranked.map((e, i) => [e[0], i]))
    for (const o of outs) if (o.has[c]) o.cls[c] = Math.min(254, idx.get(o.h1[c] + ':' + o.h2[c])!)
    ncls[c] = Math.min(255, ranked.length); nrow[c] = m.size ? ranked.reduce((a, e) => a + e[1], 0) : 0; major[c] = ranked.length ? ranked[0][1] : 0
  }
  const ms = Date.now() - T0; if (ms > 2000) console.log(`[trav/cols] ${rows.length} rows, read ${nread} tok (${tRead} ms), mix ${tMix} ms, total ${ms} ms`)
  return { x0, x1, ncol, ntok, nread, ms, msPre: T0 - T00, msRead: tRead, nrows: rows.length, cols: { nanch: b64(nanch), ncls: b64(ncls), nrow: b64(nrow), major: b64(major) },
    rows: outs.map(o => ({ id: o.id, pid: o.pid, hid: o.hid, dir: o.dir, copy: o.copy, tw0: o.tw0, tw1: o.tw1, pres: b64(o.pres), cls: b64(o.cls), ins: b64(o.ins) })) }
}
