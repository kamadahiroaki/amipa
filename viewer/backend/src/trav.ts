// 通過（traversal）のサイドカー `<db>.trav`（prep の trav 段 trav_build.py が作る、SQLite）を読む。
// 設計: amipa-lab/plans/anchor2-traversals.md。錨の座標 x（多数決順の順位）、通過 trav（コンティグ × 座標区間 × 向き × コピー番号）、
// コピー copies（同じコンティグの通過の座標の重なり）、境界 bounds（支持・持続度）、原子 atoms、反復 reps（出現単位）。
// 古い木（.synteny）と Blocks パネルは 11-02 に外した。作るのは prep の trav 段（prep/amipa_prep/trav_build.py ほか）。
import Database from 'better-sqlite3'
import zlib from 'zlib'
import fs from 'fs'
import path from 'path'
import { getDbDir, getDb } from './db'
import { distillFor } from './routes/bubbleMsa'
import { openDistill, Distill } from './distill'
import { bubbleMsaRanges } from './msa'
import { readsSourceFor } from './msaReads'

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

// arrays 表の 1 配列（11-03）: 大きな配列は name, name#1, name#2, … の行に分けてある（prep の trav_arrays.py）。better-sqlite3 は 1 値を約 537 MB までしか
//   読めない（Node の文字列の上限に合わせて SQLITE_LIMIT_LENGTH を下げている）ため、全ゲノムの id_map（651 MB）で "string or blob too big" になった
export function arrRow(db: Database.Database, name: string): { blob: Buffer } | undefined {
  const rows = db.prepare('SELECT name, blob FROM arrays WHERE name = ? OR name GLOB ?').all(name, name + '#*') as { name: string; blob: Buffer }[]
  if (!rows.length) return undefined
  if (rows.length === 1) return { blob: rows[0].blob }
  const part = (r: { name: string }) => r.name === name ? 0 : Number(r.name.slice(r.name.lastIndexOf('#') + 1))
  rows.sort((a, b) => part(a) - part(b))
  return { blob: Buffer.concat(rows.map(r => r.blob)) }
}


// 11-04: 小さなサイドカー（.trav・.genes。既定 1 GB 以下、AMIPA_SIDECAR_MEM_MAX で変える。0 で無効）はメモリに読み込んで開く。
//   ページキャッシュから押し出されると、窓ごとの SQLite のページ読みが Lustre のランダム読みになる（ショウジョウバエで 2〜5 秒）
const SIDECAR_MEM_MAX = (() => { const v = Number(process.env.AMIPA_SIDECAR_MEM_MAX); return Number.isFinite(v) && v >= 0 ? v : 1e9 })()
function openSidecar(f: string): Database.Database {
  try { const sz = fs.statSync(f).size; if (SIDECAR_MEM_MAX && sz <= SIDECAR_MEM_MAX) return new Database(fs.readFileSync(f)) } catch { /* 読めなければ普通に開く */ }
  return new Database(f, { readonly: true })
}
export function loadTrav(dbFile: string): Trav | null {
  const p = travPath(dbFile)
  if (!p) return null
  let mtime = 0
  try { mtime = fs.statSync(p).mtimeMs } catch { /* ignore */ }
  const c = cache.get(p)
  if (c && c.mtime === mtime) return c
  if (c) { try { c.db.close() } catch { /* ignore */ } }
  const db = openSidecar(p)
  const meta: Record<string, any> = {}
  for (const r of db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]) { try { meta[r.key] = JSON.parse(r.value) } catch { meta[r.key] = r.value } }
  const haps = (db.prepare('SELECT hid, hap FROM haps ORDER BY hid').all() as { hid: number; hap: string }[]).map(r => r.hap)
  const paths = db.prepare('SELECT pid, path, hid, orient, relation, excluded, ntok, bp FROM paths ORDER BY pid').all() as TravPath[]
  const atoms = db.prepare('SELECT * FROM atoms ORDER BY x0').all() as TravAtom[]   // ntangle は version 3 から
  const bounds = db.prepare('SELECT x, support, persistence FROM bounds ORDER BY x').all() as TravBound[]
  const xb = arrRow(db, 'xbp')
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
  const refHid = refHidOf(t)
  return { meta: t.meta, H: t.H, R: t.R, total_bp: t.xbp.length ? t.xbp[t.xbp.length - 1] : 0, haps: perHap, atoms: t.atoms, bounds: t.bounds, refHid, refHap: refHid >= 0 ? t.haps[refHid] : null, cdir: contigDirs(t) }
}

// コンティグの主な向き（11-05）: pid → +1/−1。同じ株・同じパス名の断片（minigraph-cactus はクリップした区間でコンティグを W 行の断片に切る。fly16 の A2#0#3R は 26 本）を
//   合わせ、全通過の向きを bp で重み付けした和の符号。以前は画面側が「表示範囲に入っている通過」だけで断片ごとに決めていたため、逆位が断片の多数になる所
//   （A2 の 3R の 8 Mb 逆位）や、逆位の近くだけを表示したときに、逆位の片に印が付かなかった
export function contigDirs(t: Trav): number[] {
  const c = (t as any).__cdir; if (c) return c
  const sum = new Float64Array(t.paths.length)
  for (const r of t.db.prepare('SELECT pid, dir, bp FROM trav').raw().iterate() as Iterable<[number, number, number]>) sum[r[0]] += r[1] * r[2]
  const byKey = new Map<string, number>(); t.paths.forEach((p, pid) => { const k = p.hid + '\t' + p.path; byKey.set(k, (byKey.get(k) || 0) + sum[pid]) })
  const out = t.paths.map(p => (byKey.get(p.hid + '\t' + p.path) || 0) >= 0 ? 1 : -1); (t as any).__cdir = out; return out
}

// 参照（座標の種）のハプロタイプ（11-05）: 前処理が記録した --seed-ref（meta.params.seed_ref、パス名の頭）に当たるパスの株。無ければ先頭のパスの株
//   （trav_build.py と同じ規則）。以前は閲覧側が GRCh38/CHM13 を決め打ちしていて、ショウジョウバエ（dm6）・大腸菌で参照の位置が出なかった
export function refHidOf(t: Trav): number {
  const c = (t as any).__refHid; if (c != null) return c
  const pre = String(t.meta?.params?.seed_ref ?? '')
  const p = (pre ? t.paths.find(q => q.path.startsWith(pre)) : null) ?? t.paths[0]
  const h = p ? p.hid : -1; (t as any).__refHid = h; return h
}

// 染色体の区切り（11-05、Traversals の全体図）: 合意座標を原子ごとに名前で塗り、同じ名前の連なりを 1 区間にする。名前の決め方は
//   (1) 参照（種）のパスが通っていれば、そのパス名のコンティグ部分（最後の # の後。例 chr3R）
//   (2) 参照が通らない所は、通る通過（錨 1,000 以上）のコンティグ名の多数決（chr を除き小文字で比べる。過半数のときだけ）
//   (3) どちらも無ければ空（画面側で「区間 k」）。参照の無い短い隙間（全長の 0.2% 未満）で同じ名前に挟まれたものは前後に吸収する
export function travChroms(t: Trav): { x0: number; x1: number; name: string; ref: boolean }[] {
  const c = (t as any).__chroms; if (c) return c
  // コンティグ名＝最後の # の後。頭にサンプル名が付く形（GRCh38#0#GRCh38.chr1）はそれを外す
  //   （# の無い参照のパス名 GRCh38.chr1 も、株の名前 GRCh38#0 のサンプル部分を頭から外す）
  const contig = (p: string) => { const c = p.slice(p.lastIndexOf('#') + 1); const smp = p.includes('#') ? p.split('#')[0] : ''; if (smp && c.startsWith(smp + '.')) return c.slice(smp.length + 1); if (!p.includes('#')) { const d = c.indexOf('.'); if (d > 0 && t.haps.some(h => h.split('#')[0] === c.slice(0, d))) return c.slice(d + 1) } return c }
  const key = (p: string) => contig(p).replace(/^chr/i, '').toLowerCase()
  const refHid = refHidOf(t)
  let rows = t.db.prepare('SELECT pid, hid, x0, x1, nanch FROM trav WHERE nanch >= 1000 ORDER BY x0').all() as { pid: number; hid: number; x0: number; x1: number; nanch: number }[]
  if (!rows.length) rows = t.db.prepare('SELECT pid, hid, x0, x1, nanch FROM trav WHERE nanch >= 10 ORDER BY x0').all() as any[]
  const lab: { name: string; ref: boolean }[] = []; let k = 0; let act: typeof rows = []
  for (const a of t.atoms) {
    const m = (a.x0 + a.x1) / 2
    while (k < rows.length && rows[k].x0 <= m) act.push(rows[k++])
    act = act.filter(r => r.x1 >= m)
    let best: (typeof rows)[number] | null = null
    for (const r of act) if (r.hid === refHid && (!best || r.nanch > best.nanch)) best = r
    if (best) { lab.push({ name: contig(t.paths[best.pid].path), ref: true }); continue }
    const cnt = new Map<string, number>(), show = new Map<string, string>()
    for (const r of act) { const p = t.paths[r.pid].path; const kk = key(p); cnt.set(kk, (cnt.get(kk) || 0) + 1); if (!show.has(kk)) show.set(kk, contig(p)) }
    let top = '', n = 0; for (const [kk, v] of cnt) if (v > n) { top = kk; n = v }
    lab.push({ name: n >= 3 && n * 2 > act.length && top ? show.get(top)! : '', ref: false })   // 3 本以上かつ過半数（株ごとに名前が違うアセンブリのコンティグ名が 1 本だけで選ばれないように）
  }
  const out: { x0: number; x1: number; name: string; ref: boolean }[] = []
  t.atoms.forEach((a, i) => { const L = lab[i]; const last = out[out.length - 1]
    const same = last && (last.name === L.name || key(last.name) === key(L.name)) && !!last.name === !!L.name
    if (same) { last.x1 = a.x1; if (L.ref && !last.ref) last.name = L.name; last.ref = last.ref || L.ref } else out.push({ x0: a.x0, x1: a.x1, name: L.name, ref: L.ref }) })   // 名前は参照のもの（chrX）を優先
  // 参照に無い挿入（名前の無い区間）が同じ名前に挟まれていれば、その染色体の一部として吸収する（大腸菌で 1 本の染色体が挿入ごとに 24 区間に割れた）。
  // 両端の名前の無い短い区間（全長の 1% 未満）も隣に吸収する
  for (let i = 1; i + 1 < out.length; i++) if (!out[i].name && out[i - 1].name && key(out[i - 1].name) === key(out[i + 1].name)) { out[i - 1].x1 = out[i + 1].x1; out[i - 1].ref = out[i - 1].ref || out[i + 1].ref; out.splice(i, 2); i-- }
  const tiny = Math.max(1, t.R * 0.002)   // 染色体の継ぎ目の名前の無い小片（数〜数百座標）は前の区間に付ける
  for (let i = 1; i < out.length; i++) if (!out[i].name && out[i].x1 - out[i].x0 < tiny) { out[i - 1].x1 = out[i].x1; out.splice(i, 1); i-- }
  const small = Math.max(1, t.R * 0.01)
  if (out.length > 1 && !out[0].name && out[0].x1 - out[0].x0 < small) { out[1].x0 = out[0].x0; out.shift() }
  if (out.length > 1 && !out[out.length - 1].name && out[out.length - 1].x1 - out[out.length - 1].x0 < small) { out[out.length - 2].x1 = out[out.length - 1].x1; out.pop() }
  ;(t as any).__chroms = out; return out
}

// 座標区間 [x0, x1] に重なる通過とコピー。ハプロタイプごとの通過数（×n の材料）も返す
// 錨の床を表示範囲の幅に合わせる（11-02）: 床は広い範囲で硬い領域のかけら（50 錨未満の断片）を隠すためのもの。狭い範囲では短い通過片も範囲の大きな部分を
// 占めるので、床を範囲の座標数の 1 割（下限は構築の最小 10）まで下げる。chr202122v2 x 1,085,725–1,085,925 で、HG03492#1 の 2 回目の通過（錨 48）が隠れ、
// その株にだけあるノードがグラフの絞り込みからも漏れた
export function effFloor(minAnchors: number, x0: number, x1: number): number { return Math.min(minAnchors, Math.max(10, Math.floor((x1 - x0 + 1) * 0.1))) }
export function travRange(t: Trav, x0: number, x1: number, opts: { minOverlap?: number; minAnchors?: number } = {}): any {
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? ORDER BY hid, pid, i0').all(x1, x0) as TravRow[]
  const mo = opts.minOverlap ?? 0; const ma = effFloor(opts.minAnchors ?? 0, x0, x1)   // 錨が少ない断片（硬い領域のかけら）は既定で出さない。ヒト v2 は 50 錨未満が 8,964 本で、x≈1.52M の 1 か所に 5,298 本集中
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
  // 11-04: 以前は要求ごとに dense_of_x と id_map（全ゲノムで計 0.9 GB）を SQLite から読み直していた。読み込み済みの配列を使う
  const dense = denseOfX(t); if (!dense.length) return []; const idf = idOf(t)
  const a = Math.max(0, x0), b = Math.min(dense.length - 1, x1); const n = b - a + 1; if (n <= 0) return []
  const step = n > max ? n / max : 1; const out: string[] = []
  for (let k = 0; k < Math.min(n, max); k++) { const x = a + Math.floor(k * step); const d = dense[x]; if (d >= 1) out.push('n' + idf(d)) }
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
  const xd = arrRow(t.db, 'x_of_dense')
  const kd = arrRow(t.db, 'kind')
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
  // 11-04: 前処理（trav_build）が .trav に bp（dense → bp、int32）を入れていればそれを使う。無ければ distill の s_id/s_bp（全ゲノムで各 650 MB の Float64 に展開）から作る
  const bpa = arrRow(t.db, 'bp')
  if (bpa && bpa.blob.byteLength === N * 4) { t.bpOfDense = new Int32Array(bpa.blob.buffer.slice(bpa.blob.byteOffset, bpa.blob.byteOffset + bpa.blob.byteLength)); return true }
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
    // 読んだ区間の端の錨が窓の端を越えていなければ広げる（11-02）。以前は「端の錨が窓の中なら」で、見積もり（トークンを x に比例で置く）が窓を
    // 飛び越えたとき（端の錨が窓の外）に広げず、窓の手前のトークンを取りこぼした（chr202122v2 x 2,639,602 の n76136864。片の中のトークンの密度が一様でない）
    const fwd = r.dir >= 0, none = lo < 0 || hi < 0
    const cutLo = s0 > r.i0 && (none || (fwd ? lo > x0 : lo < x1)), cutHi = e0 < r.i1 + 1 && (none || (fwd ? hi < x1 : hi > x0))
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
// dense → 元の GFA id（11-04）: .trav の meta.id_identity（trav_build が書く。id_map が 1..N の連番）なら配列を持たずに d そのもの。
//   全ゲノム MC は連番で、id_map（651 MB）を読み込まずに済む
function idOf(t: Trav): (d: number) => number {
  if (t.meta.id_identity === true || t.meta.id_identity === 'true' || t.meta.id_identity === 1) return d => d
  const im = idMapOf(t); return d => Number(im[d - 1])
}
// 元の id → dense（無ければ -1）
function denseOf(t: Trav): (v: number) => number {
  const N = t.xOfDense ? t.xOfDense.length - 1 : 0
  if (t.meta.id_identity === true || t.meta.id_identity === 'true' || t.meta.id_identity === 1) return v => (v >= 1 && v <= N ? v : -1)
  const { ids, order } = origIndex(t)
  return v => { let lo = 0, hi = order.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; const vv = ids[order[mid]]; if (vv === v) return order[mid] + 1; if (vv < v) lo = mid + 1; else hi = mid - 1 } return -1 }
}
function idMapOf(t: Trav): BigInt64Array {
  const c = (t as any).__idmap as BigInt64Array | undefined; if (c) return c
  const im = arrRow(t.db, 'id_map')
  const arr = im ? new BigInt64Array(im.blob.buffer.slice(im.blob.byteOffset, im.blob.byteOffset + im.blob.byteLength)) : new BigInt64Array(0)
  ;(t as any).__idmap = arr; return arr
}
export function travCols(t: Trav, x0: number, x1: number, ncol: number, minAnchors = 50): any {
  const T00 = Date.now()
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い' }
  const X = t.xOfDense!, K = t.kindOfDense!, BP = t.bpOfDense!, dist = t.dist!
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1)); const W = x1 - x0 + 1; if (W <= 0) return { error: 'empty' }
  ncol = Math.max(1, Math.min(W, Math.floor(ncol) || 1))
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, effFloor(minAnchors, x0, x1)) as TravRow[]
  try { markRepeats(t, rows) } catch (e) { console.warn('[trav/cols] markRepeats', e) }
  // 読む量の見積もり: 通過のうち窓に掛かる割合（x が錨の番号に比例するとして）× トークン数 ＋ 余白。ヒトは 1 通過が 100 万トークンなので全長で数えると小さな窓でも断ってしまう
  let ntok = 0; for (const r of rows) { const span = Math.max(1, r.x1 - r.x0 + 1); const ov = Math.max(0, Math.min(r.x1, x1) - Math.max(r.x0, x0) + 1); ntok += Math.ceil((r.i1 - r.i0 + 1) * Math.min(1, ov / span) * 1.2) + 1000 }
  if (ntok > COLS_SCAN_MAX) return { tooBig: true, ntok, max: COLS_SCAN_MAX, x0, x1 }
  const colOf = (x: number) => Math.min(ncol - 1, Math.floor((x - x0) * ncol / W))
  const nanch = new Uint16Array(ncol); for (let c = 0; c < ncol; c++) { const a = Math.ceil(c * W / ncol), b = Math.ceil((c + 1) * W / ncol); nanch[c] = Math.min(65535, Math.max(0, b - a)) }
  type RowOut = { id: number; pid: number; hid: number; dir: number; copy: number; rep?: boolean; tw0: number; tw1: number; pres: Uint8Array; cls: Uint8Array; ins: Uint16Array; bpc: Uint32Array; h1: Uint32Array; h2: Uint32Array; has: Uint8Array; frq: Uint8Array }
  const outs: RowOut[] = []
  const T0 = Date.now(); let tRead = 0, tMix = 0, nread = 0
  const leafSeen = new Uint8Array(X.length); let nleafW = 0
  for (const r of rows) {
    // distill のパス番号: .trav の pid は distill の p_names の順（構築器が同じ順で読む）。名前で引くと重複した名前（ヒト v2 の分割された W 行）で別のパスに当たる
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    const wt = windowTokens(t, r, pi, x0, x1); const toks = wt.toks, s0 = wt.s0; tRead += wt.tRead; nread += wt.nread
    const pres = new Uint8Array(ncol), cls = new Uint8Array(ncol).fill(255), ins = new Uint16Array(ncol), h1 = new Uint32Array(ncol), h2 = new Uint32Array(ncol), has = new Uint8Array(ncol); const cnt = new Uint16Array(ncol); const insb = new Float64Array(ncol); const bpcf = new Float64Array(ncol)   // bpcf = この行のトークンの bp の合計（錨も錨でないノードも。各行の並びの幅）
    let tw0 = -1, tw1 = -1
    const tm0 = Date.now()
    forEachWindowToken(r, toks, s0, x0, x1, X, K, (d, isA, xa, ti) => {
      if (!leafSeen[d]) { leafSeen[d] = 1; nleafW++ }   // 窓の中で通過が通る異なるノード＝塩基の段が集める葉（段の自動切替に使う）
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
  return { x0, x1, ncol, ntok, nread, nleaf: nleafW, ms, msPre: T0 - T00, msRead: tRead, nrows: rows.length, cols: { nanch: b64(nanch), ncls: b64(ncls), nrow: b64(nrow), major: b64(major) },
    rows: outs.map(o => ({ id: o.id, pid: o.pid, hid: o.hid, dir: o.dir, copy: o.copy, rep: o.rep, tw0: o.tw0, tw1: o.tw1, pres: b64(o.pres), cls: b64(o.cls), ins: b64(o.ins), bpc: b64(o.bpc), frq: b64(o.frq) })) }
}

// ---- 遺伝子レーン: 表示範囲に掛かる通過ごとに、その株の遺伝子（<db>.genes の gene × gene_tok）を座標 x に写す ----
// 遺伝子の x は両端のトークン（各 256 個まで）の中の錨の x の最小・最大。錨が無い遺伝子（島の中など）は通過の中の位置から補間
export function genesPathOf(t: Trav): string | null { const base = path.join(getDbDir(), path.basename(t.dbFile)); const cands = [base + '.genes']; try { cands.push(fs.realpathSync(base) + '.genes') } catch { /* ignore */ } return cands.find(c => { try { return fs.existsSync(c) } catch { return false } }) || null }
function genesDbOf(t: Trav): Database.Database | null {
  if (t.genesDb !== undefined) return t.genesDb
  const base = path.join(getDbDir(), path.basename(t.dbFile)); const cands = [base + '.genes']
  try { cands.push(fs.realpathSync(base) + '.genes') } catch { /* ignore */ }
  const f = cands.find(c => { try { return fs.existsSync(c) } catch { return false } })
  t.genesDb = f ? openSidecar(f) : null
  return t.genesDb
}
const GENES_MAX = Number(process.env.AMIPA_TRAV_GENES_MAX) || 30_000
export function travGenes(t: Trav, x0: number, x1: number, minAnchors = 50, withNodes = false): any {
  const gdb = genesDbOf(t); if (!gdb) return { error: 'この DB には .genes サイドカーが無い', genes: [] }
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', genes: [] }
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1))
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, effFloor(minAnchors, x0, x1)) as TravRow[]
  const hasProj = (gdb.prepare('PRAGMA table_info(gene)').all() as { name: string }[]).some(c => c.name === 'proj')   // 参照の注釈を写した遺伝子（genes_project.py）: proj＝元の gid、frac＝一致率
  const q = gdb.prepare(`SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, k.s0, k.e0${hasProj ? ', g.proj, g.frac' : ''} FROM gene g JOIN gene_tok k ON k.gid = g.gid WHERE g.pid = ? AND k.e0 > ? AND k.s0 < ?`)
  const idmapG = withNodes ? idOf(t) : null
  const out: any[] = []; let n = 0; const T0 = Date.now()
  // まず件数だけ数え、多すぎる範囲（全景など）はトークンを読まずに断る
  const qn = gdb.prepare('SELECT count(*) AS n FROM gene g JOIN gene_tok k ON k.gid = g.gid WHERE g.pid = ? AND k.e0 > ? AND k.s0 < ?')
  const winOf = (r: TravRow): [number, number] => { const Lt = r.i1 - r.i0 + 1; const span = Math.max(1, r.x1 - r.x0); const wx0 = Math.max(x0, r.x0), wx1 = Math.min(x1, r.x1)
    const fa = r.dir >= 0 ? (wx0 - r.x0) / span : (r.x1 - wx1) / span, fb = r.dir >= 0 ? (wx1 - r.x0) / span : (r.x1 - wx0) / span
    const pad = Math.max(2000, 0.2 * (fb - fa) * Lt + 0.02 * Lt); return [Math.max(r.i0, Math.floor(r.i0 + fa * Lt - pad)), Math.min(r.i1 + 1, Math.ceil(r.i0 + fb * Lt + pad))] }
  let est = 0; for (const r of rows) { const [ta, tb] = winOf(r); est += (qn.get(r.pid, ta, tb) as { n: number }).n; if (est > GENES_MAX) return { tooMany: true, n: est, max: GENES_MAX, genes: [] } }
  // トークン [a, b) の中の錨: x の最小・最大と錨の dense id（オルソログ群＝ノード共有の材料）
  const anchorsIn = (rd: (a: number, b: number) => ArrayLike<number>, a: number, b: number, acc: number[]): [number, number] => {
    const toks = rd(a, b); let lo = 1e18, hi = -1
    for (let k = 0; k < toks.length; k++) { const d = toks[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { const x = X[d]; if (x < lo) lo = x; if (x > hi) hi = x; acc.push(d) } }
    return hi < 0 ? [-1, -1] : [lo, hi]
  }
  const geneAnch: number[][] = []   // 遺伝子ごとの錨（両端 1,500 トークンまで）
  for (const r of rows) {
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    // 窓に当たるトークン区間の見積もり（x が錨の番号に比例）。余白を広めに取り、遺伝子ごとの x で絞る
    const Lt = r.i1 - r.i0 + 1; const span = Math.max(1, r.x1 - r.x0); const [ta, tb] = winOf(r)
    const gs = q.all(r.pid, ta, tb) as any[]
    // 11-04: この通過の遺伝子が掛かるトークンを 1 回で読み、遺伝子ごとの読み（錨・子の位置・ノード名で 3 回）はその切り出しにする（cold の Lustre ではランダム読みの回数が時間）
    let cLo = Infinity, cHi = -1; for (const g of gs) { if (g.s0 < cLo) cLo = g.s0; if (g.e0 > cHi) cHi = g.e0 }
    const cache = gs.length > 1 && cHi > cLo && cHi - cLo <= 3_000_000 ? { lo: cLo, toks: dist.read(pi, cLo, cHi) } : null
    const rd = (a: number, b: number): ArrayLike<number> => (cache && a >= cache.lo && b <= cache.lo + cache.toks.length ? cache.toks.subarray(a - cache.lo, b - cache.lo) : dist.read(pi, a, b))
    // 子（エキソン・CDS・UTR）もこの通過の遺伝子の分をまとめて引く（以前は遺伝子ごとに 1 回）
    const chMap = new Map<number, any[]>()
    if (rows.length <= 400 && gs.length) { const ids = gs.map(g => g.gid); for (let i = 0; i < ids.length; i += 900) { const part = ids.slice(i, i + 900)
      for (const c of gdb.prepare(`SELECT f.gid, f.type, f.phase, f.strand, f.parent, f.start, f.end, t.s0, t.e0, t.so, t.eo FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.gid IN (${part.map(() => '?').join(',')}) AND f.type IN ('CDS','cds','exon','five_prime_UTR','three_prime_UTR','UTR') ORDER BY f.gid, t.s0`).all(...part) as any[]) { const a = chMap.get(c.gid); if (a) a.push(c); else chMap.set(c.gid, [c]) } } }
    for (const g of gs) {
      if (++n > GENES_MAX) return { tooMany: true, n, max: GENES_MAX, genes: [] }
      const s0 = Math.max(r.i0, g.s0), e0 = Math.min(r.i1 + 1, g.e0); if (e0 <= s0) continue
      const acc: number[] = []; const A = anchorsIn(rd, s0, Math.min(e0, s0 + 1500), acc); const B = e0 - 1500 > s0 + 1500 ? anchorsIn(rd, Math.max(s0, e0 - 1500), e0, acc) : [-1, -1]
      let gx0 = Math.min(A[0] < 0 ? 1e18 : A[0], B[0] < 0 ? 1e18 : B[0]), gx1 = Math.max(A[1], B[1])
      if (gx1 < 0) {   // 錨が無い: 通過の中の位置から補間
        const f0 = (s0 - r.i0) / Lt, f1 = (e0 - r.i0) / Lt; const [u0, u1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]; gx0 = Math.round(r.x0 + u0 * span); gx1 = Math.round(r.x0 + u1 * span)
      }
      if (gx1 < x0 || gx0 > x1) continue
      // 子（エキソン・CDS・UTR）: 遺伝子のトークン範囲の中の位置を座標に比例で写す（転写産物が複数なら種類ごとに併合）。遺伝子が多い範囲（5,000 超）では省く
      let ch: [string, number, number][] | undefined; let nodesOut: any
      if (rows.length <= 400 && n <= 20000) {
        const L = Math.max(1, g.e0 - g.s0); const span2 = gx1 - gx0; const rev = r.dir < 0
        // 子の位置は、遺伝子のトークンを読んで各トークンの錨の座標（錨でなければ直前の錨、前に無ければ次の錨）で引く（10-27: トークン数の比例だと、
        // 株固有の挿入・欠失のある遺伝子でエキソンが別の座標に描かれ、欠失した株の空白の中にエキソンが出た。FAM227A の 5.6 kb の挿入）
        const propX = (tok: number) => { const f = Math.max(0, Math.min(1, (tok - g.s0) / L)); return rev ? gx1 - f * span2 : gx0 + f * span2 }
        let xAt: Float64Array | null = null
        if (L <= 200000) { const tk = rd(g.s0, g.e0); xAt = new Float64Array(tk.length).fill(-1); let last = -1
          for (let k = 0; k < tk.length; k++) { const d = tk[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) last = X[d]; xAt[k] = last }
          let nxt = -1; for (let k = tk.length - 1; k >= 0; k--) { if (xAt[k] >= 0 && (k === 0 || xAt[k] !== xAt[k - 1] || nxt < 0)) { /* keep */ } if (xAt[k] < 0) xAt[k] = nxt; else nxt = xAt[k] } }
        const toX = (tok: number) => { if (xAt) { const k = Math.max(0, Math.min(xAt.length - 1, tok - g.s0)); if (xAt[k] >= 0) return xAt[k] } return propX(tok) }
        const per = new Map<string, [number, number][]>()
        const chs = (chMap.get(g.gid) ?? []) as { type: string; phase: string; strand: string; parent: number | null; start: number; end: number; s0: number; e0: number; so: number; eo: number }[]
        for (const c of chs) { const kind = /cds/i.test(c.type) ? 'cds' : /utr/i.test(c.type) ? 'utr' : 'exon'; const a = toX(c.s0), b = toX(c.e0); const lo = Math.round(Math.min(a, b)), hi = Math.round(Math.max(a, b)); if (!per.has(kind)) per.set(kind, []); per.get(kind)!.push([lo, hi]) }
        // 塩基の段用: 遺伝子（と CDS の片）のトークンのノード名。窓に当たる分だけ（通過のトークン区間の中）、1 遺伝子 6,000 個まで
        if (withNodes && idmapG && out.length < 5000) {
          const ta = Math.max(s0, g.s0), tb = Math.min(e0, g.e0); const toks = rd(ta, Math.min(tb, ta + 6000)); const names: string[] = []; for (let k = 0; k < toks.length; k++) names.push('n' + idmapG(toks[k]))
          // CDS の片は転写産物 1 本（親 parent ごとに合計 bp が最大のもの）に絞る。GENCODE は転写産物が複数あり、混ぜると読み枠が壊れて全行が変異・終止になる（APOBEC3B は 4 転写産物 28 片）
          const byParent = new Map<string, { len: number; parts: typeof chs }>(); for (const c of chs) { if (!/cds/i.test(c.type)) continue; const k = c.parent == null ? '' : String(c.parent); const e = byParent.get(k) || { len: 0, parts: [] }; e.len += Math.max(0, c.end - c.start + 1); e.parts.push(c); byParent.set(k, e) }
          let bestP: typeof chs = []; let bestLen = -1; for (const e of byParent.values()) if (e.len > bestLen) { bestLen = e.len; bestP = e.parts }
          const cds = bestP.map(c => ({ s0: Math.max(ta, c.s0), e0: Math.min(ta + toks.length, c.e0), phase: Number(c.phase) || 0, strand: c.strand, so: c.so, eo: c.eo, gs0: c.s0 })).filter(c => c.e0 > c.s0).map(c => ({ names: names.slice(c.s0 - ta, c.e0 - ta), phase: c.phase, strand: c.strand, so: c.so, eo: c.eo, first: c.gs0 === g.s0 }))
          const exon = chs.filter(c => !/cds/i.test(c.type) && !/utr/i.test(c.type)).map(c => names.slice(Math.max(ta, c.s0) - ta, Math.min(ta + toks.length, c.e0) - ta))
          nodesOut = { names, cds, exon, t0: ta, t1: Math.min(tb, ta + 6000) }
        }
        if (per.size) { ch = []; for (const [kind, iv] of per) { iv.sort((u, v) => u[0] - v[0]); let cur: [number, number] | null = null; for (const [lo, hi] of iv) { if (cur && lo <= cur[1] + 1) cur[1] = Math.max(cur[1], hi); else { if (cur) ch.push([kind, cur[0], cur[1]]); cur = [lo, hi] } } if (cur) ch.push([kind, cur[0], cur[1]]) } }
      }
      out.push({ proj: g.proj ?? null, frac: g.frac ?? 1, gid: g.gid, pid: g.pid, hid: r.hid, tr: r.id, x0: gx0, x1: gx1, s0: g.s0, e0: g.e0, start: g.start, end: g.end, strand: g.strand, fwd: ((g.strand === '-' ? -1 : 1) * (r.dir >= 0 ? 1 : -1)) > 0, type: g.type, name: g.name, locus: g.locus, product: g.product, pseudo: !!g.pseudo, anchored: A[1] >= 0 || B[1] >= 0, og: -1, ch, nodes: nodesOut })
      geneAnch.push(acc)
    }
  }
  const T1 = Date.now()
  // オルソログ群: 同じ種類（タンパク質コード＋擬似／RNA／その他）の遺伝子で、錨（ノード）を 2 個以上、または小さい方の 10% 以上共有するものを結ぶ（連結成分）
  const kindOf = (g: any) => (g.pseudo || /pseudo/i.test(g.type)) ? 'cds' : /^(cds|gene|mrna|protein_coding|protein-coding)$/i.test(g.type) ? 'cds' : /rna/i.test(g.type) ? 'rna' : 'other'
  const par = out.map((_, i) => i); const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i] } return i }
  const byNode = new Map<number, number[]>(); out.forEach((g, i) => { for (const d of geneAnch[i]) { const a = byNode.get(d); if (a) a.push(i); else byNode.set(d, [i]) } })
  // 11-04: 組ごとの共有数を文字列のキーで全部数えてから結んでいた（全ゲノムの広い窓 2 万遺伝子で 48〜56 秒）。数値のキーにし、すでに同じ群の組は数えない。
  //   結ぶ条件（共有 2 以上、または小さい方の錨の 10% 以上）は共有数について単調なので、閾値に届いた時点で結んでも最終の群は同じ
  const NG = out.length; const kinds = out.map(kindOf); const nA = geneAnch.map(a => a.length)
  const shared = new Map<number, number>()   // i * NG + j（i < j）→ 共有する錨の数
  for (const lst of byNode.values()) { if (lst.length < 2 || lst.length > 400) continue
    for (let a = 0; a < lst.length; a++) for (let b = a + 1; b < lst.length; b++) { let i = lst[a], j = lst[b]; if (i === j || out[i].hid === out[j].hid && out[i].tr === out[j].tr) continue
      if (kinds[i] !== kinds[j]) continue; const ri = find(i), rj = find(j); if (ri === rj) continue
      if (i > j) { const tmp = i; i = j; j = tmp } const key = i * NG + j; const n = (shared.get(key) || 0) + 1; shared.set(key, n)
      if (n >= 2 || n >= 0.1 * Math.min(nA[i], nA[j])) par[ri] = rj } }
  const groups = new Map<number, { og: number; x0: number; x1: number; n: number; haps: Set<number>; names: Map<string, number>; fwd: number; npseudo: number; kind: string; members: number[] }>()
  out.forEach((g, i) => { const r = find(i); let G = groups.get(r); if (!G) { G = { og: groups.size, x0: g.x0, x1: g.x1, n: 0, haps: new Set(), names: new Map(), fwd: 0, npseudo: 0, kind: kindOf(g), members: [] }; groups.set(r, G) }
    G.x0 = Math.min(G.x0, g.x0); G.x1 = Math.max(G.x1, g.x1); G.n++; G.haps.add(g.hid); if (g.name) G.names.set(g.name, (G.names.get(g.name) || 0) + 1); if (g.fwd) G.fwd++; if (g.pseudo) G.npseudo++; G.members.push(g.gid); g.og = G.og })
  // 有無とコピー数（10-27）: 群の座標範囲を通る株（通過が掛かる株）ごとに、その群の遺伝子の数と最大の一致率。通らない株は「範囲外」で数えない
  // 参照を写した注釈（proj）があるときは、群でなく「元の遺伝子」ごとに数える（群は重なる別の遺伝子を結ぶので、POLR2F と SOX10 が 1 群になり全株 2 コピーに見えた）
  const srcOf = (g: any) => hasProj ? (g.proj ?? g.gid) : null
  const presOf = (G: { x0: number; x1: number; members: number[]; src?: number | null }) => { const per = new Map<number, { n: number; f: number }>(); const memSet = new Set(G.members)
    const seenG = new Set<number>(); for (const g of out) if ((G.src != null ? srcOf(g) === G.src : memSet.has(g.gid)) && !seenG.has(g.gid)) { seenG.add(g.gid); const e = per.get(g.hid) || { n: 0, f: 0 }; e.n++; e.f = Math.max(e.f, g.frac ?? 1); per.set(g.hid, e) }   // 同じ遺伝子が 2 本の通過に掛かると 2 回出るので gid で数える
    const cover = new Set<number>(); for (const r of rows) if (r.x0 <= G.x1 && r.x1 >= G.x0) cover.add(r.hid)
    let n0 = 0, n1 = 0, n2 = 0, part = 0; const absent: number[] = [], multi: number[] = [], partial: number[] = []
    for (const h of cover) { const e = per.get(h); if (!e) { n0++; absent.push(h) } else { if (e.n >= 2) { n2++; multi.push(h) } else n1++; if (e.f < 0.8) { part++; partial.push(h) } } }
    return { cover: cover.size, n0, n1, n2, part, absent, multi, partial } }
  // 群の代表の元遺伝子＝群の名前を持つ参照の遺伝子（無ければ群の最初）
  const srcRep = (G: { members: number[]; names: Map<string, number> }) => { if (!hasProj) return null; const nm = [...G.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; const ms = new Set(G.members); const g = out.find(x => ms.has(x.gid) && x.name === nm) || out.find(x => ms.has(x.gid)); return g ? srcOf(g) : null }
  const srcList: any[] = []
  if (hasProj) { const bySrc = new Map<number, any>(); for (const g of out) { const k = srcOf(g); if (k == null) continue; const e = bySrc.get(k); if (!e) bySrc.set(k, { src: k, name: g.name || g.locus || '', type: g.type, x0: g.x0, x1: g.x1, members: [g.gid] }); else { e.x0 = Math.min(e.x0, g.x0); e.x1 = Math.max(e.x1, g.x1); e.members.push(g.gid) } }
    for (const e of bySrc.values()) { const P = presOf(e); if (P.n0 || P.n2 || P.part) srcList.push({ name: e.name, type: e.type, x0: e.x0, x1: e.x1, pres: P }) } }
  // 旁系（4）: 1 群に別の元遺伝子（名前）が 2 つ以上あり、かつ同じ株の同じ通過にそれらが並ぶ（＝別の座位が錨の共有で結ばれた）とき、その名前を para に
  //   重なり合う遺伝子（POLR2F と SOX10 のように同じ座位で重なる）は旁系でない: 同じ通過の上で座標が重ならない別名の組があるときだけ
  const paraOf = (G: { members: number[] }) => { const ms = new Set(G.members); const byTr = new Map<number, any[]>()
    for (const g of out) if (ms.has(g.gid) && (g.name || g.locus)) { if (!byTr.has(g.tr)) byTr.set(g.tr, []); byTr.get(g.tr)!.push(g) }
    const names = new Set<string>()
    for (const gs of byTr.values()) for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) { const A = gs[i], B = gs[j]; const na = A.name || A.locus, nb = B.name || B.locus
      if (na !== nb && (A.x1 < B.x0 || B.x1 < A.x0)) { names.add(na); names.add(nb) } }
    return names.size >= 2 ? [...names].slice(0, 6) : null }
  const ogs = [...groups.values()].map(G => ({ para: paraOf(G), pres: presOf({ ...G, src: srcRep(G) }), og: G.og, x0: G.x0, x1: G.x1, n: G.n, nhap: G.haps.size, name: [...G.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '', fwd: G.fwd, npseudo: G.npseudo, kind: G.kind })).sort((a, b) => a.x0 - b.x0)
  return { x0, x1, n: out.length, ms: Date.now() - T0, msScan: T1 - T0, msGroup: Date.now() - T1, nrows: rows.length, genes: out, groups: ogs, srcPres: hasProj ? srcList : null }
}

// ---- 窓のノード集合（グラフをこの範囲に絞る用）: 窓に当たる錨と、その錨に付く錨でないノードの名前（葉）。最大 max 個 ----
export function travNodeSet(t: Trav, x0: number, x1: number, minAnchors = 50, max = 20000): any {
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', names: [] }
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!; const idf = idOf(t)
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1)); if (x1 < x0) return { error: 'empty', names: [] }
  const rows = t.db.prepare('SELECT * FROM trav WHERE x0 <= ? AND x1 >= ? AND nanch >= ? ORDER BY hid, pid, i0').all(x1, x0, effFloor(minAnchors, x0, x1)) as TravRow[]
  let ntok = 0; for (const r of rows) { const span = Math.max(1, r.x1 - r.x0 + 1); const ov = Math.max(0, Math.min(r.x1, x1) - Math.max(r.x0, x0) + 1); ntok += Math.ceil((r.i1 - r.i0 + 1) * Math.min(1, ov / span) * 1.2) + 1000 }
  if (ntok > COLS_SCAN_MAX) return { tooBig: true, ntok, max: COLS_SCAN_MAX, names: [] }
  const seen = new Uint8Array(X.length); const names: string[] = []; const xs: number[] = []; let truncated = false; const T0 = Date.now()
  outer: for (const r of rows) {
    const pi = (dist.names[r.pid] === t.paths[r.pid].path) ? r.pid : dist.pidx.get(t.paths[r.pid].path); if (pi == null) continue
    const wt = windowTokens(t, r, pi, x0, x1); let full = false
    forEachWindowToken(r, wt.toks, wt.s0, x0, x1, X, K, (d, _isA, xa) => { if (full || seen[d]) return; seen[d] = 1; if (names.length >= max) { truncated = true; full = true; return } names.push('n' + idf(d)); xs.push(xa) })   // xs = 付いている錨の座標（塗り分け用）
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
  const dof = denseOf(t); const X = t.xOfDense!, K = t.kindOfDense!
  // スーパーノード（上の層の名前）: super 表（super_build.py が足す。子孫の葉のうち bp 合計が最大の派閥の x）
  const hasSuper = (() => { const c = (t as any).__hasSuper; if (c != null) return c; const r = t.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='super'").get() as { n: number }; (t as any).__hasSuper = r.n > 0; return r.n > 0 })()
  const qs = hasSuper ? t.db.prepare('SELECT x, frac, bp, xmin, xmax FROM super WHERE name = ?') : null
  // 錨でない葉の座標（x_fill: 同じパスで直前の錨の x の bp 多数決。xfill_build.py が足す）
  const XF: Int32Array | null = (() => { const c = (t as any).__xfill; if (c !== undefined) return c; const r = arrRow(t.db, 'x_fill'); const v = r ? new Int32Array(r.blob.buffer.slice(r.blob.byteOffset, r.blob.byteOffset + r.blob.byteLength)) : null; (t as any).__xfill = v; return v })()
  // 上限は画面側の送る上限（120,000）と同じに（11-05: 5,000 で切っていたため、見えているノードが多い広い表示で 6 割が灰色のままだった。fly16 全体 12,303 個）
  const nodes = names.slice(0, 120000).map(nm => {
    const m = /^n(\d+)$/.exec(nm)
    if (!m) { const r = qs ? (qs.get(nm) as { x: number; frac: number; bp: number; xmin: number; xmax: number } | undefined) : undefined; return r ? { name: nm, x: r.x, kind: -2, frac: r.frac, bp: r.bp, xmin: r.xmin, xmax: r.xmax } : { name: nm, x: -1, kind: -1 } }
    const d = dof(Number(m[1]))
    if (d < 0) return { name: nm, x: -1, kind: -1 }
    if (X[d] >= 0) return { name: nm, x: X[d], kind: K[d] }; if (XF && XF[d] >= 0) return { name: nm, x: XF[d], kind: 6 }; return { name: nm, x: -1, kind: K[d] }   // kind 6 ＝ 錨でない葉に直前の錨の座標を与えたもの
  })
  return { nodes, R: t.R, hasSuper, hasFill: !!XF }
}

// ---- 遺伝子名の検索（Traversals パネルの検索欄）: 名前・locus の前方一致、産物の部分一致。見つかった遺伝子ごとに座標（両端 1,500 トークンの錨の x）----
export function travFindGene(t: Trav, q: string, limit = 60): any {
  const gdb = genesDbOf(t); if (!gdb) return { error: 'この DB には .genes サイドカーが無い', hits: [] }
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い', hits: [] }
  const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!
  const qq = q.trim(); if (!qq) return { hits: [] }
  // 11-04: 前処理の gene_name（参照の注釈だけの名前の表）と gene_x（座標）があれば、それで引く。以前は写しを含む全行（全ゲノム 547 万）を LIKE でなめ、
  //   当たった遺伝子ごとに distill を読んで座標を出していた（38 秒）
  if (gdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gene_name'").get() && gdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gene_x'").get()) {
    const T0 = Date.now(); const hidOf = new Map(t.paths.map(p => [p.pid, p.hid]))
    const hasProj = (gdb.prepare('PRAGMA table_info(gene)').all() as { name: string }[]).some(c => c.name === 'proj')
    const canon = gdb.prepare("SELECT gid FROM gene_name WHERE name LIKE ? COLLATE NOCASE OR locus LIKE ? COLLATE NOCASE OR product LIKE ? COLLATE NOCASE ORDER BY (name LIKE ? COLLATE NOCASE) DESC, name, pid LIMIT ?")
      .raw().all(qq + '%', qq + '%', '%' + qq + '%', qq + '%', limit) as [number][]
    const one = gdb.prepare('SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, x.x0, x.x1 FROM gene g JOIN gene_x x ON x.gid = g.gid WHERE g.gid = ?')
    const copies = hasProj ? gdb.prepare('SELECT g.gid, g.pid, g.start, g.end, g.strand, g.type, g.name, g.locus, g.product, g.pseudo, x.x0, x.x1 FROM gene g JOIN gene_x x ON x.gid = g.gid WHERE g.proj = ? ORDER BY g.pid') : null
    const rows2: any[] = []
    for (const [gid] of canon) { if (rows2.length >= limit) break; const r = one.get(gid); if (r) rows2.push(r); if (copies) for (const c of copies.all(gid) as any[]) { if (rows2.length >= limit) break; rows2.push(c) } }
    const hits = rows2.map(g => ({ gid: g.gid, pid: g.pid, hid: hidOf.get(g.pid), hap: t.haps[hidOf.get(g.pid) ?? 0], path: t.paths[g.pid].path, start: g.start, end: g.end, strand: g.strand, type: g.type, name: g.name, locus: g.locus, product: g.product, pseudo: !!g.pseudo, x0: g.x0, x1: g.x1 }))
    return { q: qq, n: hits.length, truncated: canon.length >= limit || rows2.length >= limit, ms: Date.now() - T0, hits }
  }
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


// ---- 遺伝子の密度（3）: 全景など遺伝子を個別に出せない範囲向け。元の注釈（写しでない遺伝子）ごとに座標（遺伝子の先頭 300 トークンの最初の錨）を一度だけ求めて
// キャッシュし、表示範囲を nbin に分けて「1 株あたりの遺伝子数」と「株で有無・コピー数が違う遺伝子数」（写しがあるときだけ）を返す ----
type GeneDens = { x: Float64Array; nPerHap: number; varFlag: Uint8Array }
export function travGeneDensity(t: Trav, x0: number, x1: number, nbin: number, minAnchors = 50): any {
  const gdb = genesDbOf(t); if (!gdb) return { error: 'この DB には .genes サイドカーが無い' }
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い' }
  let D = (t as any).__gdens as GeneDens | undefined
  // 11-04: 前処理（genes_index.py）が gene_x に密度の位置と印を前計算していればそれを読む（全ゲノムで 74〜81 秒 → 1 秒未満）
  if (!D && gdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gene_x'").get()) {
    const meta = Object.fromEntries((gdb.prepare("SELECT key, value FROM meta WHERE key LIKE 'gene_x_%'").all() as { key: string; value: string }[]).map(r => [r.key, r.value]))
    if (Number(meta.gene_x_minanch) === minAnchors) {
      const T0 = Date.now(); const hasProj = (gdb.prepare('PRAGMA table_info(gene)').all() as { name: string }[]).some(c => c.name === 'proj')
      const rs = gdb.prepare(`SELECT x.xd, x.var FROM gene_x x JOIN gene g ON g.gid = x.gid${hasProj ? ' WHERE g.proj IS NULL' : ''}`).raw().all() as [number, number][]
      const xs = new Float64Array(rs.length), vf = new Uint8Array(rs.length); rs.forEach((r, i) => { xs[i] = r[0]; vf[i] = r[1] })
      D = { x: xs, nPerHap: hasProj ? 1 : Math.max(1, Number(meta.gene_x_nperhap) || 1), varFlag: vf }; (t as any).__gdens = D
      console.log(`[trav/genedensity] gene_x から ${rs.length} 遺伝子 ${Date.now() - T0} ms`)
    }
  }
  if (!D) {
    const T0 = Date.now(); const X = t.xOfDense!, K = t.kindOfDense!, dist = t.dist!
    const hasProj = (gdb.prepare('PRAGMA table_info(gene)').all() as { name: string }[]).some(c => c.name === 'proj')
    const gs = gdb.prepare(`SELECT g.gid, g.pid, k.s0, k.e0 FROM gene g JOIN gene_tok k ON k.gid = g.gid${hasProj ? ' WHERE g.proj IS NULL' : ''} ORDER BY g.pid, k.s0`).all()   /* パスの前から読む（distill のランダム読みを減らす） */ as { gid: number; pid: number; s0: number; e0: number }[]
    const xs = new Float64Array(gs.length).fill(-1)
    gs.forEach((g, i) => { const pi = (dist.names[g.pid] === t.paths[g.pid]?.path) ? g.pid : dist.pidx.get(t.paths[g.pid]?.path); if (pi == null) return
      const tk = dist.read(pi, g.s0, Math.min(g.e0, g.s0 + 300)); for (let k = 0; k < tk.length; k++) { const d = tk[k]; const kd = K[d]; if ((kd === 1 || kd === 2) && X[d] >= 0) { xs[i] = X[d]; break } } })
    const nPaths = new Set(gs.map(g => t.paths[g.pid]?.hid)).size || 1
    const varFlag = new Uint8Array(gs.length)
    if (hasProj) {
      const cnt = new Map<number, Map<number, number>>(); const part = new Set<number>()
      for (const r of gdb.prepare('SELECT proj, pid, frac FROM gene WHERE proj IS NOT NULL').iterate() as Iterable<{ proj: number; pid: number; frac: number }>) {
        const h = t.paths[r.pid]?.hid; if (h == null) continue; let m = cnt.get(r.proj); if (!m) { m = new Map(); cnt.set(r.proj, m) } m.set(h, (m.get(h) || 0) + 1); if (r.frac < 0.8) part.add(r.proj) }
      // 座標 x を覆うハプロタイプ（11-03）: 以前は遺伝子ごとに SELECT DISTINCT hid FROM trav WHERE x0 <= x AND x1 >= x を投げ、索引が x0 側しか絞れず
      //   1 回に最大 23 万行をなめた（全ゲノム 6.3 万遺伝子で 360 秒）。ハプロタイプごとに x0 順の区間と x1 の累積最大を持ち、二分探索で引く（結果は同じ）
      const byH = new Map<number, { x0: Float64Array; mx: Float64Array }>()
      { const rows = t.db.prepare('SELECT hid, x0, x1 FROM trav WHERE nanch >= ? ORDER BY hid, x0').all(minAnchors) as { hid: number; x0: number; x1: number }[]
        for (let a = 0; a < rows.length;) { let b = a; while (b < rows.length && rows[b].hid === rows[a].hid) b++
          const x0s = new Float64Array(b - a), mx = new Float64Array(b - a); let m = -Infinity
          for (let k = a; k < b; k++) { x0s[k - a] = rows[k].x0; m = Math.max(m, rows[k].x1); mx[k - a] = m }
          byH.set(rows[a].hid, { x0: x0s, mx }); a = b } }
      const coverOf = (x: number): number[] => { const out: number[] = []
        for (const [h, I] of byH) { let lo = 0, hi = I.x0.length; while (lo < hi) { const md = (lo + hi) >> 1; if (I.x0[md] <= x) lo = md + 1; else hi = md } if (lo > 0 && I.mx[lo - 1] >= x) out.push(h) }
        return out }
      gs.forEach((g, i) => { if (xs[i] < 0) return; const m = cnt.get(g.gid) || new Map(); const self = t.paths[g.pid]?.hid; const cover = coverOf(xs[i])
        let v = part.has(g.gid); for (const h of cover) { const c = (m.get(h) || 0) + (h === self ? 1 : 0); if (c !== 1) { v = true; break } } varFlag[i] = v ? 1 : 0 })
    }
    D = { x: xs, nPerHap: hasProj ? 1 : nPaths, varFlag }; (t as any).__gdens = D
    console.log(`[trav/genedensity] ${gs.length} genes ${Date.now() - T0} ms`)
  }
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(t.R - 1, Math.floor(x1)); nbin = Math.max(1, Math.min(2000, Math.floor(nbin) || 300)); const W = x1 - x0 + 1
  const n = new Float64Array(nbin), v = new Float64Array(nbin)
  for (let i = 0; i < D.x.length; i++) { const x = D.x[i]; if (x < x0 || x > x1) continue; const b = Math.min(nbin - 1, Math.floor((x - x0) * nbin / W)); n[b] += 1 / D.nPerHap; if (D.varFlag[i]) v[b] += 1 / D.nPerHap }
  return { x0, x1, nbin, n: Array.from(n, z => Math.round(z * 10) / 10), v: Array.from(v, z => Math.round(z * 10) / 10), hasVar: D.varFlag.some(f => f) }
}

// ---- ブロック・錨の列の段のリード（10-29） ----
// 範囲 [x0, x1] を ncol 列に切り、列ごとに錨のノードを 1 個標本して <db>.reads の転置索引（node_reads: ノード → 整列 id、サンプルごとのチャンク）を引く。
// 返すもの: サンプルごとの列の深さ（そのノードを通る整列の数）と、整列ごとの「掛かる列の片」（標本の列が GAP 列以上抜けたら次の片）。GAF は読まない。
// 整列が maxReads を超えたら片は返さず深さだけ（overflow）。画面は詰めた段が多すぎるときも深さだけにする
interface ReadsDb { db: Database.Database; chunk: Map<number, { sn: number; base: number }>; samples: string[]; stmt: Database.Statement }
const readsCache = new Map<string, ReadsDb | null>()
function readsDbOf(t: Trav): ReadsDb | null {
  if (readsCache.has(t.file)) return readsCache.get(t.file)!
  const base = path.join(getDbDir(), path.basename(t.dbFile)); let p = base + '.reads'
  if (!fs.existsSync(p)) { try { p = fs.realpathSync(base) + '.reads' } catch { p = '' } }
  let r: ReadsDb | null = null
  if (p && fs.existsSync(p)) {
    const db = new Database(p, { readonly: true })
    const chunk = new Map<number, { sn: number; base: number }>(); for (const c of db.prepare('SELECT chunk_no, sample_no, base_aln_id FROM read_chunk').all() as any[]) chunk.set(c.chunk_no, { sn: c.sample_no, base: c.base_aln_id })
    const samples: string[] = []; for (const s of db.prepare('SELECT sample_no, sample_id FROM read_src ORDER BY sample_no').all() as any[]) samples[s.sample_no] = s.sample_id
    r = { db, chunk, samples, stmt: db.prepare('SELECT chunk_no, postings FROM node_reads WHERE gfa_id=?') }
  }
  readsCache.set(t.file, r); return r
}
function denseOfX(t: Trav): Int32Array {
  const c = (t as any).__dox as Int32Array | undefined; if (c) return c
  const dx = arrRow(t.db, 'dense_of_x')
  const arr = dx ? new Int32Array(dx.blob.buffer.slice(dx.blob.byteOffset, dx.blob.byteOffset + dx.blob.byteLength)) : new Int32Array(0)
  ;(t as any).__dox = arr; return arr
}
// 座標ごとの深さ <db>.xdepth（prep/amipa_prep/reads_xdepth.py）: 段 L（1・64・4096 座標）の区画の平均と深さ 0 の割合を、ブロック（4096 区画）× サンプルの zlib で持つ
interface XDepth { db: Database.Database; R: number; samples: string[]; levels: number[]; block: number; stmt: Database.Statement }
const xdepthCache = new Map<string, XDepth | null>()
function xdepthOf(t: Trav): XDepth | null {
  if (xdepthCache.has(t.file)) return xdepthCache.get(t.file)!
  const base = path.join(getDbDir(), path.basename(t.dbFile)); let p = base + '.xdepth'
  if (!fs.existsSync(p)) { try { p = fs.realpathSync(base) + '.xdepth' } catch { p = '' } }
  let r: XDepth | null = null
  if (p && fs.existsSync(p)) { try {
    const db = new Database(p, { readonly: true }); const m: Record<string, string> = {}; for (const row of db.prepare('SELECT key, value FROM meta').all() as any[]) m[row.key] = row.value
    if (Number(m.R) === t.R || Number(m.R) === denseOfX(t).length) r = { db, R: Number(m.R), samples: JSON.parse(m.samples), levels: m.levels.split(',').map(Number).sort((a, b) => a - b), block: Number(m.block), stmt: db.prepare('SELECT b, s, mean, zero FROM depth WHERE level=? AND b BETWEEN ? AND ?') }
    else db.close()   // 座標の数が .trav と合わない（.trav を作り直した）なら使わない
  } catch { r = null } }
  xdepthCache.set(t.file, r); return r
}
// 列ごとの深さ（平均）と深さ 0 の座標の割合（×255）を xdepth から。段は 1 列に区画が 1 個以上入る最も粗いもの
function xdepthCols(X: XDepth, x0: number, x1: number, ncol: number): { dep: Uint16Array[]; zf: Uint8Array[]; level: number } {
  const W = x1 - x0 + 1; let L = X.levels[0]; for (const l of X.levels) if (W / l >= ncol) L = l
  const i0 = Math.floor(x0 / L), i1 = Math.floor(x1 / L); const S = X.samples.length; const nb = i1 - i0 + 1
  const mean = Array.from({ length: S }, () => new Uint16Array(nb)), zero = Array.from({ length: S }, () => new Uint8Array(nb))
  for (const row of X.stmt.all(L, Math.floor(i0 / X.block), Math.floor(i1 / X.block)) as { b: number; s: number; mean: Buffer; zero: Buffer | null }[]) {
    const mb = zlib.inflateSync(row.mean); const m = new Uint16Array(mb.buffer, mb.byteOffset, mb.byteLength / 2); const z = row.zero ? zlib.inflateSync(row.zero) : null
    const off = row.b * X.block; for (let k = 0; k < m.length; k++) { const i = off + k; if (i < i0 || i > i1) continue; mean[row.s][i - i0] = m[k]; zero[row.s][i - i0] = z ? z[k] : (m[k] ? 0 : 255) } }
  const dep = Array.from({ length: S }, () => new Uint16Array(ncol)), zf = Array.from({ length: S }, () => new Uint8Array(ncol))
  for (let c = 0; c < ncol; c++) { const xa = Math.floor(x0 + c * W / ncol), xb = Math.max(xa, Math.floor(x0 + (c + 1) * W / ncol) - 1); const a = Math.floor(xa / L) - i0, b = Math.floor(xb / L) - i0
    for (let s = 0; s < S; s++) { let sm = 0, sz = 0; for (let i = a; i <= b; i++) { sm += mean[s][i]; sz += zero[s][i] } const n = b - a + 1; dep[s][c] = Math.round(sm / n); zf[s][c] = Math.round(sz / n) } }
  return { dep, zf, level: L }
}
const PIECE_MAX_W = Number(process.env.AMIPA_TRAV_READS_PIECE_W) || 50_000   // これより広い範囲はリードの片を作らない（索引を引かない）
export function travReadSamples(t: Trav): string[] { const R = readsDbOf(t); return R ? R.samples.filter(Boolean) : [] }
export function travReads(t: Trav, x0: number, x1: number, ncol: number, maxReads = 4000, only: string[] | null = null): any {
  const R = readsDbOf(t); if (!R) return { error: 'no .reads sidecar' }
  const want = only && only.length ? new Set(only) : null   // 選んだサンプルだけ（10-30）。null＝全部
  const keep = (sn: number) => !want || want.has(R.samples[sn])
  const XD = xdepthOf(t)
  const dox = denseOfX(t), idf = idOf(t), NX = t.xOfDense ? t.xOfDense.length : Infinity; const W = x1 - x0 + 1; ncol = Math.max(4, Math.min(1500, Math.floor(ncol), W))
  const GAP = 3; const S = R.samples.length; const dep = Array.from({ length: S }, () => new Uint16Array(ncol))
  const pieces = new Map<number, number[]>(); let overflow = false; const t0 = Date.now()
  const wide = !!XD && W > PIECE_MAX_W; if (wide) overflow = true
  for (let c = 0; c < ncol && !wide; c++) {
    const xa = Math.floor(x0 + c * W / ncol), xb = Math.max(xa, Math.floor(x0 + (c + 1) * W / ncol) - 1); const mid = (xa + xb) >> 1
    let d = -1; for (let k = 0; k <= Math.min(16, xb - xa); k++) { for (const x of [mid + k, mid - k]) { if (x < xa || x > xb || x < 0 || x >= dox.length) continue; if (dox[x] >= 1) { d = dox[x]; break } } if (d >= 1) break }
    if (d < 1 || d >= NX) continue
    for (const row of R.stmt.all(idf(d)) as { chunk_no: number; postings: Buffer }[]) {
      const ch = R.chunk.get(row.chunk_no); if (!ch || !keep(ch.sn)) continue; const buf = row.postings; let shift = 0, cur = 0, prev = ch.base, n = 0
      for (let i = 0; i < buf.length; i++) { const b = buf[i]; cur += (b & 0x7f) * 2 ** shift; if (b & 0x80) { shift += 7; continue } prev += cur; cur = 0; shift = 0; n++
        if (overflow) continue
        const p = pieces.get(prev); if (!p) { if (pieces.size >= maxReads) { overflow = true; continue } pieces.set(prev, [ch.sn, c, c]) } else if (c - p[p.length - 1] <= GAP) p[p.length - 1] = c; else p.push(c, c) }
      dep[ch.sn][c] = Math.min(65535, dep[ch.sn][c] + n)
    }
  }
  let reads: any[] | null = null
  if (!overflow) {
    const ids = [...pieces.keys()]; const name = new Map<number, string>()
    for (let i = 0; i < ids.length; i += 900) { const ch = ids.slice(i, i + 900); for (const r of R.db.prepare(`SELECT aln_id, read_name FROM read_aln WHERE aln_id IN (${ch.map(() => '?').join(',')})`).all(...ch) as any[]) name.set(r.aln_id, r.read_name) }
    reads = ids.map(a => { const p = pieces.get(a)!; return { a, s: p[0], n: name.get(a) || '', p: p.slice(1) } })
  }
  const idx = R.samples.map((_, s) => s).filter(keep)   // 返すサンプル（reads の s はこの並びの番号に付け直す）
  const remap = new Map(idx.map((s, i) => [s, i])); if (reads) for (const r of reads) r.s = remap.get(r.s) ?? r.s
  if (XD) { const xc = xdepthCols(XD, x0, x1, ncol); const xi = idx.map(s => XD.samples.indexOf(R.samples[s])); return { x0, x1, ncol, samples: idx.map(s => R.samples[s]), dep: xi.map(i => b64(i >= 0 ? xc.dep[i] : new Uint16Array(ncol))), zf: xi.map(i => b64(i >= 0 ? xc.zf[i] : new Uint8Array(ncol))), src: 'xdepth', level: xc.level, reads, overflow, wide, ms: Date.now() - t0 } }
  return { x0, x1, ncol, samples: idx.map(s => R.samples[s]), dep: idx.map(s => b64(dep[s])), src: 'sample', reads, overflow, ms: Date.now() - t0 }
}

// 範囲 [x0, x1] の葉（ノード）の数: x_fill（錨はその座標、錨でない葉は直前の錨の座標）が範囲に入るノードを、並べた x_fill の二分探索で数える（10-30）。
// 段の自動切替（ノード段に降りてよいか）に使う。塩基の段が実際に集める葉（通過のトークンのノード）とほぼ同じ
export function travNLeaf(t: Trav, x0: number, x1: number): number | null {
  let s = (t as any).__xfs as Int32Array | null | undefined
  if (s === undefined) { const r = arrRow(t.db, 'x_fill')
    if (!r) s = null; else { const a = new Int32Array(r.blob.buffer.slice(r.blob.byteOffset, r.blob.byteOffset + r.blob.byteLength)); s = a.filter(v => v >= 0).sort() }
    ;(t as any).__xfs = s }
  if (!s) return null
  const lb = (v: number) => { let lo = 0, hi = s!.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s![m] < v) lo = m + 1; else hi = m } return lo }
  return lb(Math.floor(x1) + 1) - lb(Math.floor(x0))
}

// ---- 機能喪失の目安（11-04 に viewer/scripts/gene_lof.py から移した。常駐の python と違い、読み込み済みの配列と distill の読み手を共有する）----
// 遺伝子の写し（またはその株の注釈）ごとに、CDS を株の配列から組み立てて翻訳し、状態を返す:
//   ok / trunc（参照の 9 割未満で止まる）/ fs（CDS の長さが 3 の剰余で参照と違う）/ nostart（開始コドンが無い・参照にはある）/ nocds（CDS が写っていない）
// CDS は遺伝子ごとに CDS の合計 bp が最大の転写産物（親）の片をウォークの順に並べ、先頭の片はノード内オフセット so、末尾は eo で切る。鎖が − なら逆相補にしてから読む
const COMP: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N', a: 't', c: 'g', g: 'c', t: 'a', n: 'n' }
const rcSeq = (s: string) => { let o = ''; for (let i = s.length - 1; i >= 0; i--) o += COMP[s[i]] ?? s[i]; return o }
const CODON: Record<string, string> = (() => { const b = 'TCAG', aas = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'; const m: Record<string, string> = {}
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) m[b[i] + b[j] + b[k]] = aas[16 * i + 4 * j + k]; return m })()
export function travGeneLof(t: Trav, gids: number[]): any {
  const gdb = genesDbOf(t); if (!gdb) return { error: 'この DB には .genes サイドカーが無い' }
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い' }
  const dist = t.dist!; const idf = idOf(t); const mdb = getDb(t.dbFile)
  const hasProj = (gdb.prepare('PRAGMA table_info(gene)').all() as { name: string }[]).some(c => c.name === 'proj')
  const qParts = gdb.prepare("SELECT f.parent, f.pid, t.s0, t.e0, t.so, t.eo, f.start, f.end FROM feature f JOIN feature_tok t ON t.fid = f.fid WHERE f.gid = ? AND f.type IN ('CDS','cds')")
  const piOf = (pid: number) => (dist.names[pid] === t.paths[pid]?.path ? pid : dist.pidx.get(t.paths[pid]?.path ?? ''))
  const assemble = (gid: number, strand: string): string | null => {
    const rows = qParts.all(gid) as any[]; if (!rows.length) return null
    const by = new Map<string, any[]>(); for (const r of rows) { const k = String(r.parent); const a = by.get(k); if (a) a.push(r); else by.set(k, [r]) }
    let best: any[] = []; let bestLen = -1; for (const v of by.values()) { const L = v.reduce((s, x) => s + x.end - x.start + 1, 0); if (L > bestLen) { bestLen = L; best = v } }   // 同点は先に出た親（python の max と同じ）
    best.sort((a, b) => a.s0 - b.s0); const pi = piOf(best[0].pid); if (pi == null) return null
    const segs = best.map(r => ({ tk: dist.read(pi, r.s0, r.e0), oo: dist.readOri(pi, r.s0, r.e0), so: r.so as number, eo: r.eo as number }))
    const need = new Set<number>(); for (const s of segs) for (let i = 0; i < s.tk.length; i++) need.add(idf(s.tk[i]))
    const seq = new Map<number, string>(); const ids = [...need]
    for (let i = 0; i < ids.length; i += 500) { const ch = ids.slice(i, i + 500); for (const r of mdb.prepare(`SELECT leaf_id, seq FROM leaf_seq WHERE leaf_id IN (${ch.map(() => '?').join(',')})`).all(...ch) as { leaf_id: number; seq: any }[]) seq.set(Number(r.leaf_id), typeof r.seq === 'string' ? r.seq : Buffer.from(r.seq).toString('latin1')) }
    const out: string[] = []
    for (const sg of segs) {
      const L = (d: number) => (seq.get(idf(d)) ?? '').length
      let so = sg.so, eo = sg.eo
      if (sg.tk.length) { so = sg.oo[0] ? so : L(sg.tk[0]) - 1 - so; eo = sg.oo[sg.tk.length - 1] ? eo : L(sg.tk[sg.tk.length - 1]) - 1 - eo }
      const ss: string[] = []; for (let i = 0; i < sg.tk.length; i++) { const s = seq.get(idf(sg.tk[i])) ?? 'N'; ss.push(sg.oo[i] ? s : rcSeq(s)) }
      if (!ss.length) continue
      ss[ss.length - 1] = ss[ss.length - 1].slice(0, Math.max(0, eo) + 1)
      ss[0] = ss.length > 1 ? ss[0].slice(Math.max(0, so || 0)) : ss[0].slice(Math.max(0, so || 0), Math.max(0, eo) + 1)
      out.push(ss.join(''))
    }
    const cds = out.join('').toUpperCase(); return strand === '-' ? rcSeq(cds) : cds
  }
  const translate = (cds: string) => { let aa = ''; for (let i = 0; i + 2 < cds.length; i += 3) { const x = CODON[cds.slice(i, i + 3)] ?? 'X'; aa += x; if (x === '*') break } return aa }
  const cache = new Map<number, { L: number; aa: number; stop: boolean; start: boolean } | null>()
  const summary = (gid: number, strand: string) => { if (cache.has(gid)) return cache.get(gid)!; let cds: string | null = null; try { cds = assemble(gid, strand) } catch { cds = null }
    if (!cds) { cache.set(gid, null); return null } const p = translate(cds); const stop = p.endsWith('*'); const r = { L: cds.length, aa: p.length - (stop ? 1 : 0), stop, start: ['ATG', 'GTG', 'TTG'].includes(cds.slice(0, 3)) }; cache.set(gid, r); return r }
  const list = gids.slice(0, 5000); const info = new Map<number, [string, number | null]>()
  for (let i = 0; i < list.length; i += 900) { const ch = list.slice(i, i + 900); for (const r of gdb.prepare(`SELECT gid, strand${hasProj ? ', proj' : ', NULL AS proj'} FROM gene WHERE gid IN (${ch.map(() => '?').join(',')})`).all(...ch) as any[]) info.set(r.gid, [r.strand, r.proj]) }
  const qStrand = gdb.prepare('SELECT strand FROM gene WHERE gid = ?')
  const res: Record<number, any> = {}
  for (const gid of list) {
    const inf = info.get(gid); if (!inf) continue; const [strand, src] = inf
    const s = summary(gid, strand); if (!s) { res[gid] = { st: 'nocds', src }; continue }
    let ref: ReturnType<typeof summary> = null
    if (src != null) { const rs = qStrand.get(src) as { strand: string } | undefined; ref = rs ? summary(src, rs.strand) : null }
    let st = 'ok'
    if (ref) { if ((((s.L - ref.L) % 3) + 3) % 3 !== 0) st = 'fs'; else if (s.aa < 0.9 * ref.aa) st = 'trunc'; else if (ref.start && !s.start) st = 'nostart' }
    else { const exp = Math.floor(s.L / 3) - 1; if (!s.start) st = 'nostart'; else if (s.aa < 0.9 * exp) st = 'trunc' }
    res[gid] = { st, aa: s.aa, ref: ref ? ref.aa : null, src }
  }
  return { genes: res, n: Object.keys(res).length }
}

// ---- 塩基の段（11-04 に bubble_msa.py の範囲モードから移した。msa.ts）----
// 合意の並び（python 版の _order_array と同じ）: 錨は x_of_dense、錨でない葉は x_fill
function orderArray(t: Trav): Float64Array | null {
  const c = (t as any).__order; if (c !== undefined) return c
  if (!ensureCols(t)) { (t as any).__order = null; return null }
  const X = t.xOfDense!; const xf = arrRow(t.db, 'x_fill'); const XF = xf ? new Int32Array(xf.blob.buffer.slice(xf.blob.byteOffset, xf.blob.byteOffset + xf.blob.byteLength)) : null
  const o = new Float64Array(X.length); for (let i = 0; i < X.length; i++) { const x = X[i]; o[i] = x < 0 && XF && i < XF.length && XF[i] >= 0 ? XF[i] : x }
  ;(t as any).__order = o; return o
}
export function travMsa(t: Trav, req: any, opt: { label?: string; flank?: number; cap?: number | null; maxLeaves?: number | null; maxTokens?: number }): any {
  if (!ensureCols(t)) return { error: 'distill か x_of_dense が無い' }
  const reads = req && req.reads ? readsSourceFor(path.join(getDbDir(), path.basename(t.dbFile))) : null
  return bubbleMsaRanges({ dbFile: t.dbFile, dist: t.dist!, idOf: idOf(t), denseOf: denseOf(t), order: orderArray(t), reads }, req, opt)
}
