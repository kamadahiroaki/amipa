// 窓に依らない一つのシンテニーの木（`<db>.synteny`、SQLite）から、Blocks パネルが読む「窓」の形を作る。
//   plans/msa-multires.md §15。作るのは functions/msa_lod/tree/tree.py（試作。本番は prep の段へ）。
//
//   木: 原子区間（最細ブロック、床 500 bp）と境界（層 tier・支持 support・持続度 persistence）。
//   窓 = 合意座標の範囲 [x0, x1]。範囲内の境界を持続度の高い順に N−1 本残して N ブロックにする（30 / 12 / 5 の段）。
//   境界が足りなければブロックは少なくなる（再編成が無い範囲は 1 ブロック。座標で無理に切らない）。
//   ブロックのインスタンスは原子インスタンス（行 × 原子）を隣接で併合して作る。返す形は旧サイドカーの窓と同じ
//   （blockMsaRender.ts はそのまま読める）。
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDbDir } from './db'
import { distillFor } from './routes/bubbleMsa'
import { openDistill } from './distill'

export const SYNTENY_SUFFIX = '.synteny'

export function syntenyPath(dbFile: string): string | null {
  const base = path.join(getDbDir(), path.basename(dbFile))
  for (const p of [base + SYNTENY_SUFFIX]) { try { if (fs.existsSync(p)) return p } catch { /* ignore */ } }
  try { const rp = fs.realpathSync(base) + SYNTENY_SUFFIX; if (fs.existsSync(rp)) return rp } catch { /* ignore */ }
  return null
}

interface Atom { id: number; c0: number; c1: number; x0: number; span: number; nanc: number; name0: string; name1: string; refcid: number; rx0: number; rx1: number }   // x0/span＝合意累積 bp（原子は隙間なく並ぶ）、rx0/rx1＝参照座標（グラフ寄せ・目盛り用）
interface Boundary { id: number; tier: number; support: number; persistence: number }
interface PathRow { pid: number; path: string; hap: string; sample: string; contig: string; strand: string; ntok: number; nsteps: number; bp: number; isref: number }
interface Inst { pid: number; atom: number; dir: number; s0: number; e0: number; pos: number; bp: number; nsteps: number; nanc: number; nminor: number; npriv: number; vs: Buffer | null; anc: Buffer | null }
interface Junc { pid: number; a: number; b: number; a2: number; b2: number; wrap: number; type: string; ai: number; di: number; aj: number; dj: number; multi_bp: number; priv_bp: number; tier: number }

export interface Synteny {
  file: string; mtime: number
  meta: Record<string, string>; circular: boolean; H: number; total: number; tiers: number[]; floor: number
  atoms: Atom[]; bnd: Boundary[]; paths: PathRow[]; inst: Inst[][]      // inst[pid] は pos 昇順
  anchorX: Int32Array; anchorTier: Int8Array; anchorCol: Int32Array      // rank → 合意座標 / 層 / 列
  rankOfCol: Int32Array; dcol: Int32Array | null; colX: Int32Array; colBp: Int32Array; colXc: Float64Array; orig2col: Int32Array | null; col2orig: Int32Array | null; nat: number; distill: string | null; maxlayer: number; hasSupermap: boolean
  junc: Junc[][]
  tree: any | null
  hapOrder: string[]                                                       // 参照ハプロを先に、名前順
}

const cache = new Map<string, Synteny>()

export function loadSynteny(dbFile: string): Synteny | null {
  const p = syntenyPath(dbFile)
  if (!p) return null
  let mtime = 0
  try { mtime = fs.statSync(p).mtimeMs } catch { /* ignore */ }
  const c = cache.get(p)
  if (c && c.mtime === mtime) return c
  const d = new Database(p, { readonly: true })
  try {
    const meta: Record<string, string> = {}
    for (const r of d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]) meta[r.key] = r.value
    const atoms = d.prepare('SELECT id, c0, c1, x0, span, nanc, name0, name1, refcid FROM atoms ORDER BY id').all() as Atom[]
    const bnd = d.prepare('SELECT id, tier, support, persistence FROM boundaries ORDER BY id').all() as Boundary[]
    const paths = d.prepare('SELECT pid, path, hap, sample, contig, strand, ntok, nsteps, bp, isref FROM paths ORDER BY pid').all() as PathRow[]
    const inst: Inst[][] = paths.map(() => [])
    for (const r of d.prepare('SELECT pid, atom, dir, s0, e0, pos, bp, nsteps, nanc, nminor, npriv, vs, anc FROM inst ORDER BY pid, pos').all() as Inst[]) inst[r.pid].push(r)
    const nA = (d.prepare('SELECT COUNT(*) AS n FROM anchors').get() as { n: number }).n
    const anchorX = new Int32Array(nA); const anchorTier = new Int8Array(nA); const anchorCol = new Int32Array(nA)
    const ncols = Number(meta.ncols || 0); const rankOfCol = new Int32Array(ncols).fill(-1)
    for (const r of d.prepare('SELECT rank, x, tier, col FROM anchors').iterate() as Iterable<{ rank: number; x: number; tier: number; col: number }>) { anchorTier[r.rank] = r.tier; anchorCol[r.rank] = r.col; if (r.col < ncols) rankOfCol[r.col] = r.rank }
    // 列ごとの合意座標と塩基数（座位のアレルの幅・位置）。1.5M 行で約 1 s
    const colX = new Int32Array(ncols), colBp = new Int32Array(ncols)
    try { for (const r of d.prepare('SELECT col, x, bp FROM cols').iterate() as Iterable<{ col: number; x: number; bp: number }>) { colX[r.col] = r.x; colBp[r.col] = r.bp } } catch { /* 古いサイドカー */ }
    // 合意累積 bp（全列の塩基数の前置和）。参照座標 x は参照に無い島で進まず、原子の幅（全列の bp）と座標系が合わないので、
    // 範囲・幅・対応線・サイトの位置は全部この座標で持つ。参照座標は rx0/rx1 として別に持つ（グラフ寄せ・目盛り）
    const colXc = new Float64Array(ncols + 1); for (let c = 0; c < ncols; c++) colXc[c + 1] = colXc[c] + colBp[c]
    for (const a of atoms) { a.rx0 = a.x0; a.rx1 = colX[a.c1] + colBp[a.c1]; a.x0 = colXc[a.c0]; a.span = colXc[a.c1 + 1] - colXc[a.c0] }
    const arr = (name: string): Int32Array | null => { try { const r = d.prepare('SELECT dtype, n, blob FROM arrays WHERE name=?').get(name) as { dtype: string; n: number; blob: Buffer } | undefined; if (!r) return null; const b = r.blob; return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + r.n * 4)) } catch { return null } }
    for (let r = 0; r < nA; r++) anchorX[r] = Math.round(colXc[anchorCol[r]])
    const dcol = arr('dcol'), orig2col = arr('orig2col'), col2orig = arr('col2orig')
    let hasSupermap = false; try { d.prepare('SELECT 1 FROM supermap LIMIT 1').get(); hasSupermap = true } catch { hasSupermap = false }
    const junc: Junc[][] = paths.map(() => [])
    for (const r of d.prepare('SELECT * FROM junc ORDER BY pid, a').all() as Junc[]) junc[r.pid].push(r)
    let tree: any = null
    try { tree = meta.tree ? JSON.parse(meta.tree) : null } catch { tree = null }
    const haps = [...new Set(paths.map(r => r.hap))]
    const isrefHap = new Set(paths.filter(r => r.isref).map(r => r.hap))
    haps.sort((a, b) => (Number(!isrefHap.has(a)) - Number(!isrefHap.has(b))) || (a < b ? -1 : a > b ? 1 : 0))
    const syn: Synteny = {
      file: p, mtime, meta, circular: meta.circular === '1', H: Number(meta.H || haps.length), total: Math.round(colXc[ncols]),
      tiers: (meta.tiers || '').split(',').map(Number).filter(v => Number.isFinite(v)), floor: Number(meta.floor || 500),
      atoms, bnd, paths, inst, anchorX, anchorTier, anchorCol, rankOfCol, dcol, colX, colBp, colXc, orig2col, col2orig, nat: atoms.length, distill: distillFor(path.join(getDbDir(), path.basename(dbFile))), maxlayer: Number(meta.maxlayer || 0), hasSupermap, junc, tree, hapOrder: haps,
    }
    cache.set(p, syn)
    return syn
  } finally { d.close() }
}

// ---- 窓を作る ----
export interface ViewOpts { N?: number[]; tierMax?: number; label?: string; depth?: number; parent?: number; pblock?: number; maxAnchors?: number }

function b64(buf: ArrayBufferView): string { return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64') }
const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

// 範囲 [x0, x1] に重なる原子（id 昇順 = 合意順）
function atomsInRange(syn: Synteny, x0: number, x1: number): Atom[] {
  const out: Atom[] = []
  for (const a of syn.atoms) if (a.x0 < x1 && a.x0 + a.span > x0) out.push(a)
  return out
}

interface Cut { groups: number[][]; W: number }     // groups: 範囲内の原子 index（0..n-1）の連なり
// 範囲内の境界（隣り合う原子 k|k+1）を持続度で選び、N ブロックにする。tierMax より低い層の境界は無視（併合される）
function cutByBudget(syn: Synteny, atoms: Atom[], N: number, tierMax: number): Cut {
  const n = atoms.length
  const cand: { k: number; p: number; s: number }[] = []
  for (let k = 0; k < n - 1; k++) {
    const b = syn.bnd[atoms[k].id]
    if (!b) continue
    if (atoms[k + 1].id !== atoms[k].id + 1) { cand.push({ k, p: Infinity, s: 999 }); continue }   // 連続でない（範囲が飛ぶ）→ 必ず切る
    if (b.tier > tierMax) continue
    cand.push({ k, p: b.persistence < 0 ? Infinity : b.persistence, s: b.support })
  }
  cand.sort((u, v) => (v.p - u.p) || (v.s - u.s) || (u.k - v.k))
  const keep = cand.slice(0, Math.max(0, N - 1)).sort((u, v) => u.k - v.k)
  const W = keep.length ? Math.min(...keep.map(c => c.p === Infinity ? Number.MAX_SAFE_INTEGER : c.p)) : 0
  const groups: number[][] = []; let cur: number[] = []
  let ki = 0
  for (let k = 0; k < n; k++) {
    cur.push(k)
    if (ki < keep.length && keep[ki].k === k) { groups.push(cur); cur = []; ki++ }
  }
  if (cur.length) groups.push(cur)
  return { groups, W: W === Number.MAX_SAFE_INTEGER ? 0 : W }
}

// 原子インスタンスの連なり（同じブロック、コンティグ順）を 1 インスタンスに併合して、旧サイドカーの 21 要素の配列にする
function mergeInstances(syn: Synteny, parts: Inst[], rank: number, blk: { x: number; span: number; atoms: Atom[] }, ntok: number): any[] {
  const first = parts[0], last = parts[parts.length - 1]
  const pos = first.pos, bp = Math.max(1, last.pos + last.bp - pos)
  let abp = 0, nsteps = 0, nvar = 0, npriv = 0, plus = 0
  for (const p of parts) { abp += p.bp; nsteps += p.nsteps; nvar += p.nminor; npriv += p.npriv; if (p.dir === 1) plus += p.bp }
  const dir = plus * 2 >= abp ? 1 : 0
  // 少数派サイト（インスタンス内 0..255）と合意座標での位置（cvs）
  const vsSet = new Set<number>(), cvsSet = new Set<number>()
  const atomById = new Map(blk.atoms.map(a => [a.id, a]))
  for (const p of parts) {
    const f0 = (p.pos - pos) / bp, f1 = (p.pos + p.bp - pos) / bp
    const A = atomById.get(p.atom)
    if (p.vs && p.vs.length) for (const b of p.vs) {
      vsSet.add(clamp255((f0 + (b / 255) * (f1 - f0)) * 255))
      if (A) { const cf = p.dir === 1 ? b / 255 : 1 - b / 255; cvsSet.add(clamp255((A.x0 - blk.x + cf * A.span) / Math.max(1, blk.span) * 255)) }
    }
  }
  const vs = Uint8Array.from([...vsSet].sort((u, v) => u - v)), cvs = Uint8Array.from([...cvsSet].sort((u, v) => u - v))
  // 隙間（挿入）: 隣り合う部分の間の bp
  const gaps: number[][] = []; let maxgap = 0
  for (let i = 0; i + 1 < parts.length; i++) {
    const g = parts[i + 1].pos - (parts[i].pos + parts[i].bp)
    if (g > maxgap) maxgap = g
    if (g >= Math.max(20000, 0.02 * bp)) {
      const A = atomById.get(parts[i].atom)
      const cpos = A ? clamp255((A.x0 + A.span - blk.x) / Math.max(1, blk.span) * 255) : 0
      gaps.push([clamp255((parts[i].pos + parts[i].bp - pos) / bp * 255), clamp255((parts[i + 1].pos - pos) / bp * 255), g, cpos])
    }
  }
  // 単調か（原子 id がコンティグ順に一方向）
  let mono = 1
  for (let i = 0; i + 2 < parts.length + 1 && i + 1 < parts.length; i++) {
    const d0 = Math.sign(parts[1].atom - parts[0].atom), d = Math.sign(parts[i + 1].atom - parts[i].atom)
    if (d !== 0 && d0 !== 0 && d !== d0) { mono = 0; break }
  }
  const trunc = (first.s0 === 0 ? 1 : 0) | (last.e0 === ntok ? 2 : 0)
  // 欠け（ブロックの原子のうちこの株が持たないもの）と覆う範囲 ext
  const present = new Set(parts.map(p => p.atom))
  const dels: number[][] = []; let run: Atom[] = []
  const flush = () => { if (!run.length) return; const x0 = run[0].x0, x1 = run[run.length - 1].x0 + run[run.length - 1].span
    if (x1 - x0 >= Math.max(200, 0.01 * blk.span)) dels.push([clamp255((x0 - blk.x) / Math.max(1, blk.span) * 255), clamp255((x1 - blk.x) / Math.max(1, blk.span) * 255), x1 - x0]); run = [] }
  for (const A of blk.atoms) { if (present.has(A.id)) flush(); else run.push(A) }
  flush()
  dels.sort((u, v) => v[2] - u[2]); dels.splice(32); dels.sort((u, v) => u[0] - v[0])
  const pres = blk.atoms.filter(A => present.has(A.id))
  const ext = pres.length ? [clamp255((pres[0].x0 - blk.x) / Math.max(1, blk.span) * 255), clamp255(Math.ceil((pres[pres.length - 1].x0 + pres[pres.length - 1].span - blk.x) / Math.max(1, blk.span) * 255))] : [0, 255]
  return [rank, dir, bp, nsteps, 1, 0, pos, parts.length, first.s0, last.e0, abp, nvar, b64(vs), maxgap, gaps, npriv, mono, trunc, dels, b64(cvs), ext]
}

// 標本錨（対応線）: 範囲内の原子インスタンスの標本から、層 ≤ 1 を主錨、それ以外を第二錨として最大 M 本ずつ
const ANC_REC = 14   // rank u32, tok u32, bp u32, ori u8, tier u8
function anchorsForRange(syn: Synteny, pids: number[], instsByPid: Map<number, Inst[]>, M: number, tierPrimary = 1) {
  type Hit = { tok: number; bp: number; ori: number }
  const perRank1 = new Map<number, Map<number, Hit>>(), perRank2 = new Map<number, Map<number, Hit>>()
  for (const pid of pids) {
    for (const it of instsByPid.get(pid) || []) {
      const buf = it.anc; if (!buf || buf.length < ANC_REC) continue
      for (let off = 0; off + ANC_REC <= buf.length; off += ANC_REC) {
        const rank = buf.readUInt32LE(off), tok = buf.readUInt32LE(off + 4), bp = buf.readUInt32LE(off + 8), ori = buf.readUInt8(off + 12), tier = buf.readUInt8(off + 13)
        const tgt = tier <= tierPrimary ? perRank1 : perRank2
        let m = tgt.get(rank); if (!m) { m = new Map(); tgt.set(rank, m) }
        m.set(pid, { tok, bp, ori })
      }
    }
  }
  const pick = (per: Map<number, Map<number, Hit>>) => {
    const ranks = [...per.keys()].sort((u, v) => u - v)
    const sel = ranks.length <= M ? ranks : Array.from({ length: M }, (_, i) => ranks[Math.round(i * (ranks.length - 1) / Math.max(1, M - 1))])
    const x = sel.map(r => syn.anchorX[r])
    const rows: Record<string, { i: string; tok: string; bp: string; ori: string }> = {}
    const byPid = new Map<number, { i: number[]; tok: number[]; bp: number[]; ori: number[] }>()
    sel.forEach((r, i) => { for (const [pid, h] of per.get(r)!) { let e = byPid.get(pid); if (!e) { e = { i: [], tok: [], bp: [], ori: [] }; byPid.set(pid, e) } e.i.push(i); e.tok.push(h.tok); e.bp.push(h.bp); e.ori.push(h.ori) } })
    for (const [pid, e] of byPid) rows[syn.paths[pid].path] = { i: b64(Uint16Array.from(e.i)), tok: b64(Uint32Array.from(e.tok)), bp: b64(Uint32Array.from(e.bp)), ori: b64(Uint8Array.from(e.ori)) }
    return { m: sel.length, x, rows }
  }
  // 主錨が無い範囲（島の中など、低い層の錨しか無い）は第二錨を主錨として使う（対応線が消えないように）
  if (perRank1.size === 0 && perRank2.size > 0) { const a = pick(perRank2); return { m: a.m, x: a.x, rows: a.rows, m2: 0, x2: [], rows2: {}, promoted: true } }
  const a1 = pick(perRank1), a2 = pick(perRank2)
  return { m: a1.m, x: a1.x, rows: a1.rows, m2: a2.m, x2: a2.x, rows2: a2.rows }
}


// ---- 主鎖（旧構築器 chain_circular と同じ考え）: 行のインスタンス列から「最も重い単調な連なり」を選ぶ。環状なら順位の原点を
//      ずらして試し、両向きを試す。鎖に入るもの kind 0、入らないものは鎖と同じ向きなら 2（変位）、逆なら 3（逆位）。
//      鎖の向きがその行（コンティグ）の strand になる（窓ごと・段ごとに決める。旧構築器と同じ）
function weightedLis(c: number[], w: number[]): { score: number; members: number[] } {
  const m = c.length; const best = new Array<number>(m).fill(0), prev = new Array<number>(m).fill(-1); let bi = -1, bs = -1
  for (let i = 0; i < m; i++) { let b = 0, p = -1; for (let j = 0; j < i; j++) if (c[j] <= c[i] && best[j] > b) { b = best[j]; p = j } best[i] = b + w[i]; prev[i] = p; if (best[i] > bs) { bs = best[i]; bi = i } }
  const members: number[] = []; while (bi >= 0) { members.push(bi); bi = prev[bi] }
  return { score: bs, members }
}
function chainKinds(rk: number[], dr: number[], w: number[], nb: number, circular: boolean): { kinds: number[]; sign: number } {
  const m = rk.length; if (!m) return { kinds: [], sign: 1 }
  const offsets = circular && m > 2 ? [...new Set(rk)] : [0]
  let best: { score: number; sign: number; set: Set<number> } | null = null
  for (const o of offsets) for (const sign of [1, -1]) {
    const idx: number[] = []; const c: number[] = []; const ww: number[] = []
    for (let i = 0; i < m; i++) { if (dr[i] !== (sign > 0 ? 1 : 0)) continue; idx.push(i); c.push(((sign > 0 ? rk[i] - o : o - rk[i]) % nb + nb) % nb); ww.push(w[i]) }
    if (!idx.length) continue
    const r = weightedLis(c, ww)
    if (!best || r.score > best.score) best = { score: r.score, sign, set: new Set(r.members.map(k => idx[k])) }
  }
  if (!best) return { kinds: rk.map(() => 2), sign: 1 }
  const fwd = best.sign > 0 ? 1 : 0
  return { kinds: rk.map((_, i) => best!.set.has(i) ? 0 : (dr[i] === fwd ? 2 : 3)), sign: best.sign }
}

const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

export function buildWindow(syn: Synteny, x0: number, x1: number, opts: ViewOpts = {}): any {
  const Ns = opts.N || [30, 12, 5]
  const tierMax = opts.tierMax ?? 1
  const atoms = atomsInRange(syn, x0, x1)
  if (!atoms.length) return { error: '範囲に原子区間がありません' }
  const wholeGenome = atoms.length === syn.atoms.length
  const aidx = new Map(atoms.map((a, i) => [a.id, i]))
  // 範囲内の原子インスタンス（パスごと、コンティグ順）
  const instsByPid = new Map<number, Inst[]>()
  for (const pr of syn.paths) { const arr = syn.inst[pr.pid].filter(it => aidx.has(it.atom)); if (arr.length) instsByPid.set(pr.pid, arr) }
  const pids = [...instsByPid.keys()]
  // 段: N ごとに切る。ブロック数が同じ段は 1 つにまとめる（最細を先に）
  // 層: 既定は 80% 層以上の境界。範囲の中でそれだけだと 1 ブロックにしかならず、低い層の境界があるなら、境界が現れる層まで緩める
  // （「再編成の境界が現れるまで降りる」）。緩めた層は返り値 tierUsed に出す
  let tierUsed = tierMax
  const maxTier = Math.max(0, syn.tiers.length - 1)
  while (tierUsed < maxTier && cutByBudget(syn, atoms, Ns[0], tierUsed).groups.length < 2) tierUsed++
  const cuts: Cut[] = []
  for (const N of Ns) { const c = cutByBudget(syn, atoms, N, tierUsed); if (!cuts.length || cuts[cuts.length - 1].groups.length !== c.groups.length) cuts.push(c) }
  const fine = cuts[0]
  const fineRank = new Map<number, number>(); fine.groups.forEach((g, r) => g.forEach(i => fineRank.set(atoms[i].id, r)))   // 最細段の rank（members 用）
  const levels = cuts.map((cut, li) => {
    const blocks = cut.groups.map(g => {
      const as = g.map(i => atoms[i]); const bx = as[0].x0, bspan = as[as.length - 1].x0 + as[as.length - 1].span - bx
      return { c0: as[0].c0, c1: as[as.length - 1].c1, span: bspan, tbp: 0, bpmax: 0, nhap: 0, x: bx, rx0: as[0].rx0, rx1: as[as.length - 1].rx1, atoms: as.length, a0: as[0].id, a1: as[as.length - 1].id, ref_contig: Math.max(0, as[0].refcid), name: as[0].name0 + '…' + as[as.length - 1].name1, ncol: as.reduce((s, a) => s + a.nanc, 0), _atoms: as }
    })
    const rankOfAtom = new Map<number, number>(); cut.groups.forEach((g, r) => g.forEach(i => rankOfAtom.set(atoms[i].id, r)))
    const bpsOf: number[][] = blocks.map(() => []); const hapsOf: Set<string>[] = blocks.map(() => new Set())
    // 行（ハプロタイプ）→ コンティグ（パス）→ インスタンス
    const byHap = new Map<string, PathRow[]>()
    for (const pid of pids) { const pr = syn.paths[pid]; if (!byHap.has(pr.hap)) byHap.set(pr.hap, []); byHap.get(pr.hap)!.push(pr) }
    let nonmono = 0
    const haps = syn.hapOrder.filter(h => byHap.has(h)).map(h => {
      const prs = byHap.get(h)!
      const contigs = prs.map(pr => {
        const its = instsByPid.get(pr.pid)!
        const out: any[] = []; let i = 0
        while (i < its.length) {
          const r = rankOfAtom.get(its[i].atom)!; let j = i + 1
          while (j < its.length && rankOfAtom.get(its[j].atom) === r) j++
          const parts = its.slice(i, j); const B = blocks[r]
          const m = mergeInstances(syn, parts, r, { x: B.x, span: B.span, atoms: B._atoms }, pr.ntok)
          if (m[16] === 0) nonmono++
          bpsOf[r].push(m[2]); hapsOf[r].add(h); out.push(m); i = j
        }
        // 少数派の区間（旧: 錨でないトークンの連なり ≥ 床）: 原子インスタンスの間の隙間 ≥ 床を同じ形 [pos, bp, name, colbp, s0, e0] で
        const minor: any[] = []
        for (let k = 0; k + 1 < its.length; k++) { const g = its[k + 1].pos - (its[k].pos + its[k].bp); if (g >= syn.floor) minor.push([its[k].pos + its[k].bp, g, '', 0, its[k].e0, its[k + 1].s0]) }
        // 主鎖 → kind（0 主鎖 / 2 変位 / 3 逆位）と、この行の向き（鎖の向き）
        const ck = chainKinds(out.map(it => it[0]), out.map(it => it[1]), out.map(it => it[2]), blocks.length, syn.circular && wholeGenome)
        out.forEach((it, k) => { it[5] = ck.kinds[k] })
        // 行の長さ＝この窓にあるインスタンスの bp ＋ その間の隙間（旧構築器の「範囲のトークンの bp」に相当）。コンティグ全長にすると
        // 子窓の「各行の並び」で幅が 1/30 になり目盛りと合わない
        const rowBp = out.reduce((a, it) => a + it[2], 0) + minor.reduce((a, m) => a + m[1], 0)
        const rowSteps = out.reduce((a, it) => a + it[3], 0)
        return { name: pr.contig, path: pr.path, strand: ck.sign < 0 ? '-' : '+', start: 0, bp: rowBp, nsteps: rowSteps, inst: out, minor }
      })
      return { hap: h, isref: prs.some(p => p.isref) ? 1 : 0, contigs }
    })
    blocks.forEach((B, r) => { B.tbp = median(bpsOf[r]); B.bpmax = bpsOf[r].length ? Math.max(...bpsOf[r]) : 0; B.nhap = hapsOf[r].size; delete (B as any)._atoms })
    // 隣接（adj）: 各行のインスタンス列から [ri, di, rj, dj]
    const adjSet = new Set<string>()
    for (const hp of haps) for (const c of hp.contigs) for (let k = 0; k + 1 < c.inst.length; k++) adjSet.add([c.inst[k][0], c.inst[k][1], c.inst[k + 1][0], c.inst[k + 1][1]].join(','))
    const adj = [...adjSet].map(s => s.split(',').map(Number))
    // 原点（環状の全体窓）: 支持が最小の境界の次のブロック
    let origin = 0
    if (syn.circular && li >= 0) {
      let best = -1, bs = Infinity
      cut.groups.forEach((g, r) => { const lastAtom = atoms[g[g.length - 1]]; const b = syn.bnd[lastAtom.id]; const s = b ? b.support : Infinity; if (s < bs) { bs = s; best = r } })
      if (best >= 0) origin = (best + 1) % blocks.length
    }
    const members = li === 0 ? null : cut.groups.map(g => { const out: number[] = []; for (const i of g) { const r0 = fineRank.get(atoms[i].id); if (r0 != null && (!out.length || out[out.length - 1] !== r0)) out.push(r0) } return out })
    return { W: cut.W, nblocks: blocks.length, blocks, haps, mergecap: 0, mode: 'blocks', adj, events: {}, origin, merges: atoms.length - blocks.length, members, nonmono }
  })
  const anchors = anchorsForRange(syn, pids, instsByPid, opts.maxAnchors || 800, tierUsed)
  return {
    id: -1, parent: opts.parent ?? -1, pblock: opts.pblock ?? -1, depth: opts.depth ?? 0, label: opts.label || '全体',
    atoms: atoms.length, H: new Set(pids.map(p => syn.paths[p].hap)).size, levels, children: {}, mode: 'blocks', anchors,
    range: [atoms[0].x0, atoms[atoms.length - 1].x0 + atoms[atoms.length - 1].span], tree: true, tierUsed, tierMax,
  }
}

// ---- アレル行列（変異の段）: 合意列の範囲 [c0, c1] の列（cols 表: 株ビットセット）から、サイトとアレルを作る ----
//   不変列 = その範囲で株数が最大（ncover）の列。サイト = 不変列の間の非不変列の連なり（バブル）。
//   株のアレル = サイトの中でその株が持つ列の集合（同じ集合＝同じアレル）。被覆（左右の不変列を持つ）していて列を持たない株は
//   「無し」のアレル（欠失側）。被覆していない株は 255（この区間を持たない）。
export interface SitesResult { c0: number; c1: number; ncols: number; ncover: number; H: number; haps: string[]; nsites: number
  sites: { x: number; c0: number; c1: number; ncols: number; bp: number; nall: number; counts: number[]; nsites?: number }[]; cells: string; tooMany?: boolean; error?: string
  binned?: boolean; sitesPerBin?: number; totalSites?: number; method?: string; boundaryTier?: number }
const SITES_MAX = 4000      // これを超えるサイト数はビンにまとめる（粗い段）
const LOCUS_SPLIT = 48      // 座位方式で、これより多い列を持つ座位は内側を列方式のサイトに分ける（錨の疎な島・大きな座位の内部構造を見せる）
// 列方式の芯: [c0, c1] の列（株ビットセット）から「不変列の間の非不変列の連なり」をサイトにする。cover を与えたときはその株だけを見る
function colSitesCore(d: InstanceType<typeof Database>, syn: Synteny, c0: number, c1: number, haps: string[], coverIn?: number[]): { sites: SitesResult['sites']; cellsArr: number[][]; ncover: number; ncols: number } {
  const rows = d.prepare('SELECT col, x, bp, nhap, haps FROM cols WHERE col BETWEEN ? AND ? ORDER BY col').all(c0, c1) as { col: number; x: number; bp: number; nhap: number; haps: Buffer }[]
  const H = syn.H; const has = (buf: Buffer, h: number) => (buf[h >> 3] >> (h & 7)) & 1
  if (!rows.length) return { sites: [], cellsArr: [], ncover: 0, ncols: 0 }
  let cover: number[]; if (coverIn) cover = coverIn; else { const ncoverMax = Math.max(...rows.map(r => r.nhap)); const inv0 = rows.find(r => r.nhap === ncoverMax); cover = []; for (let h = 0; h < H; h++) if (!inv0 || has(inv0.haps, h)) cover.push(h) }
  const coverSet = new Set(cover); const ncover = cover.length
  const nIn = (r: { haps: Buffer }) => { let n = 0; for (const h of cover) n += has(r.haps, h); return n }   // 被覆の中で列を持つ株の数（不変列 = 全員が持つ）
  const inv = rows.map(r => nIn(r) === ncover)
  const refIdx = syn.paths.filter(p => p.isref).map(p => haps.indexOf(p.hap)).find(v => v >= 0)
  const sites: SitesResult['sites'] = []; const cellsArr: number[][] = []
  let i = 0
  while (i < rows.length) {
    if (inv[i]) { i++; continue }
    let j = i; while (j < rows.length && !inv[j]) j++
    const run = rows.slice(i, j)
    const key: (string | null)[] = new Array(H).fill(null)
    for (let h = 0; h < H; h++) { if (!coverSet.has(h)) continue; const ks: number[] = []; for (let k = 0; k < run.length; k++) if (has(run[k].haps, h)) ks.push(k); key[h] = ks.join(',') }
    const cnt = new Map<string, number>(); for (let h = 0; h < H; h++) if (key[h] != null) cnt.set(key[h]!, (cnt.get(key[h]!) || 0) + 1)
    const order = [...cnt.keys()].sort((u, v) => (cnt.get(v)! - cnt.get(u)!) || (u < v ? -1 : 1))
    if (refIdx != null && refIdx >= 0 && key[refIdx] != null) { const k = key[refIdx]!; order.splice(order.indexOf(k), 1); order.unshift(k) }
    const idxOf = new Map(order.map((k, n) => [k, n]))
    const cells = new Array(H).fill(255); for (let h = 0; h < H; h++) if (key[h] != null) cells[h] = Math.min(253, idxOf.get(key[h]!)!)
    cellsArr.push(cells)
    sites.push({ x: run[0].x, c0: run[0].col, c1: run[run.length - 1].col, ncols: run.length, bp: Math.max(...run.map(r => r.bp)), nall: order.length, counts: order.map(k => cnt.get(k)!) })
    i = j
  }
  return { sites, cellsArr, ncover, ncols: rows.length }
}
const BIN_TARGET = 1500     // ビンの数の目安（画面幅 1 px/ビン）
export function sitesForRange(syn: Synteny, q: { c0?: number; c1?: number; x0?: number; x1?: number }, max = SITES_MAX): SitesResult | { error: string } {
  const d = new Database(syn.file, { readonly: true })
  try {
    let c0 = q.c0, c1 = q.c1
    if (c0 == null || c1 == null) {
      if (q.x0 == null || q.x1 == null) return { error: 'c0,c1 か x0,x1 が要ります' }
      const lb = (v: number) => { let lo = 0, hi = syn.colX.length; while (lo < hi) { const m = (lo + hi) >> 1; if (syn.colXc[m + 1] <= v) lo = m + 1; else hi = m } return lo }
      c0 = lb(q.x0); c1 = Math.max(c0, lb(q.x1) - 1)
    }
    const rows = d.prepare('SELECT col, x, bp, nhap, haps FROM cols WHERE col BETWEEN ? AND ? ORDER BY col').all(c0, c1) as { col: number; x: number; bp: number; nhap: number; haps: Buffer }[]
    const H = syn.H; let haps: string[] = []
    try { haps = JSON.parse(syn.meta.hapnames || '[]') } catch { haps = [] }
    if (!rows.length) return { error: '範囲に列がありません' }
    const ncover = Math.max(...rows.map(r => r.nhap))
    const has = (buf: Buffer, h: number) => (buf[h >> 3] >> (h & 7)) & 1
    // 被覆集合: 最初の不変列のビットセット
    const inv0 = rows.find(r => r.nhap === ncover)
    const cover: number[] = []; for (let h = 0; h < H; h++) if (!inv0 || has(inv0.haps, h)) cover.push(h)
    const coverSet = new Set(cover)
    // サイト = 不変列の間の非不変列の連なり
    const sites: SitesResult['sites'] = []; const cellsArr: number[][] = []
    let i = 0
    while (i < rows.length) {
      if (rows[i].nhap === ncover) { i++; continue }
      let j = i; while (j < rows.length && rows[j].nhap !== ncover) j++
      const run = rows.slice(i, j)
      // 株ごとの列集合（ビット列の位置の列挙）→ アレル
      const key: (string | null)[] = new Array(H).fill(null)
      for (let h = 0; h < H; h++) {
        if (!coverSet.has(h)) continue
        const ks: number[] = []; for (let k = 0; k < run.length; k++) if (has(run[k].haps, h)) ks.push(k)
        key[h] = ks.join(',')
      }
      const cnt = new Map<string, number>(); for (let h = 0; h < H; h++) if (key[h] != null) cnt.set(key[h]!, (cnt.get(key[h]!) || 0) + 1)
      const refIdx = syn.paths.filter(p => p.isref).map(p => haps.indexOf(p.hap)).find(v => v >= 0)
      const order = [...cnt.keys()].sort((u, v) => (cnt.get(v)! - cnt.get(u)!) || (u < v ? -1 : 1))
      if (refIdx != null && refIdx >= 0 && key[refIdx] != null) { const k = key[refIdx]!; order.splice(order.indexOf(k), 1); order.unshift(k) }
      const idxOf = new Map(order.map((k, n) => [k, n]))
      const cells = new Array(H).fill(255); for (let h = 0; h < H; h++) if (key[h] != null) cells[h] = Math.min(254, idxOf.get(key[h]!)!)
      cellsArr.push(cells)
      sites.push({ x: run[0].x, c0: run[0].col, c1: run[run.length - 1].col, ncols: run.length, bp: Math.max(...run.map(r => r.bp)), nall: order.length, counts: order.map(k => cnt.get(k)!) })
      i = j
    }
    if (sites.length > max) {
      // 粗い段: サイトが多すぎるときは、連続するサイトを等数ずつビンにまとめ、セルを「参照のアレルと違うサイトの割合」（0..254）にする。
      // 範囲を狭めれば（ドラッグ）サイトごとのアレルの段に降りる
      const per = Math.ceil(sites.length / BIN_TARGET); const bins: SitesResult['sites'] = []; const bcells: number[][] = []
      for (let b = 0; b < sites.length; b += per) {
        const grp = sites.slice(b, b + per); const idx = Array.from({ length: grp.length }, (_, j) => b + j)
        const cells = new Array(H).fill(255)
        for (let h = 0; h < H; h++) { let cov = 0, dif = 0; for (const k of idx) { const a = cellsArr[k][h]; if (a === 255) continue; cov++; if (a !== 0) dif++ } if (cov) cells[h] = Math.min(254, Math.round(254 * dif / cov)) }
        bcells.push(cells); const f = grp[0], l = grp[grp.length - 1]
        bins.push({ x: f.x, c0: f.c0, c1: l.c1, ncols: l.c1 - f.c0 + 1, bp: Math.max(1, l.x + l.bp - f.x), nall: 0, counts: [], nsites: grp.length })
      }
      const flatB = new Uint8Array(bins.length * H); bcells.forEach((c, k) => flatB.set(c, k * H))
      return { c0, c1, ncols: rows.length, ncover, H, haps, nsites: bins.length, sites: bins, cells: Buffer.from(flatB.buffer).toString('base64'), binned: true, sitesPerBin: per, totalSites: sites.length }
    }
    const flat = new Uint8Array(sites.length * H); cellsArr.forEach((c, k) => flat.set(c, k * H))
    return { c0, c1, ncols: rows.length, ncover, H, haps, nsites: sites.length, sites, cells: Buffer.from(flat.buffer).toString('base64') }
  } finally { d.close() }
}

// ---- アレル行列 v2（座位＝錨の間）: 各株のトークン列を、その株が持つ境界錨の出現で区切り、同じノード列＝同じアレル。
//      多重コピーのノードも各株の列の中に出現として入るので、座位ごとに正しく出る。列の表（株ビットセット）は使わない ----
export function sitesForRangeLoci(syn: Synteny, q: { c0?: number; c1?: number; x0?: number; x1?: number }, max = SITES_MAX): SitesResult | { error: string } {
  if (!syn.dcol || !syn.distill) return { error: 'サイドカーに dcol が無いか distill がありません' }
  let c0 = q.c0, c1 = q.c1
  if (c0 == null || c1 == null) {
    if (q.x0 == null || q.x1 == null) return { error: 'c0,c1 か x0,x1 が要ります' }
    const lb = (v: number) => { let lo = 0, hi = syn.colX.length; while (lo < hi) { const m = (lo + hi) >> 1; if (syn.colXc[m + 1] <= v) lo = m + 1; else hi = m } return lo }   // 列 c は [colXc[c], colXc[c+1])
    c0 = lb(q.x0); c1 = Math.max(c0, lb(q.x1) - (Number.isInteger(q.x1) && q.x1 > q.x0 ? 1 : 0))
    if (c1 < c0) return { error: '範囲に列がありません' }
  }
  const H = syn.H; let haps: string[] = []; try { haps = JSON.parse(syn.meta.hapnames || '[]') } catch { haps = [] }
  const hidx = new Map(haps.map((h, i) => [h, i]))
  // 範囲内の錨（rank の区間）。境界の層: 範囲に 2 本以上ある最も厳しい層
  const lbRank = (c: number) => { let lo = 0, hi = syn.anchorCol.length; while (lo < hi) { const m = (lo + hi) >> 1; if (syn.anchorCol[m] < c) lo = m + 1; else hi = m } return lo }
  const r0 = lbRank(c0), r1 = lbRank(c1 + 1) - 1
  if (r1 - r0 < 1) return { c0, c1, ncols: c1 - c0 + 1, ncover: 0, H, haps, nsites: 0, sites: [], cells: '' }
  const tiersPresent = [...new Set(Array.from(syn.anchorTier.subarray(r0, r1 + 1)))].sort((a, b) => a - b)
  let T = tiersPresent[tiersPresent.length - 1]
  for (const t of tiersPresent) { let n = 0; for (let r = r0; r <= r1; r++) if (syn.anchorTier[r] <= t) n++; if (n >= 2) { T = t; break } }
  const B: number[] = []; for (let r = r0; r <= r1; r++) if (syn.anchorTier[r] <= T) B.push(r)
  const bidx = new Map<number, number>(); B.forEach((r, i) => bidx.set(r, i))
  const nl = B.length - 1
  // 範囲に重なる原子 → パスごとのトークン範囲
  const atomsIn = syn.atoms.filter(a => a.c1 >= c0 && a.c0 <= c1); const aset = new Set(atomsIn.map(a => a.id))
  const dist = openDistill(syn.distill)
  const alleles: Map<string, { idx: number; n: number }>[] = Array.from({ length: nl }, () => new Map())
  const cells = new Uint8Array(nl * H).fill(255)
  const refPath = syn.paths.find(p => p.isref)
  const coverN = new Int32Array(nl)
  for (const pr of syn.paths) {
    const hi = hidx.get(pr.hap); if (hi == null) continue
    const pi = dist.pidx.get(pr.path); if (pi == null) continue
    const its = syn.inst[pr.pid].filter(it => aset.has(it.atom)).sort((a, b) => a.s0 - b.s0)
    if (!its.length) continue
    // 連続する範囲をまとめて読む
    const runs: [number, number][] = []; for (const it of its) { const last = runs[runs.length - 1]; if (last && it.s0 <= last[1]) last[1] = Math.max(last[1], it.e0); else runs.push([it.s0, it.e0]) }
    for (const [s0, e0] of runs) {
      const toks = dist.read(pi, s0, e0)
      // 境界錨の出現位置
      let prevB = -1, prevPos = -1
      for (let k = 0; k < toks.length; k++) {
        const col = syn.dcol[toks[k]]; if (col < 0) continue
        const rk = syn.rankOfCol[col]; if (rk < 0) continue; const b = bidx.get(rk); if (b == null) continue
        if (prevB >= 0 && b !== prevB) {
          const lo = Math.min(prevB, b), hiB = Math.max(prevB, b)
          const inner: number[] = []; for (let j = prevPos + 1; j < k; j++) inner.push(toks[j])
          if (prevB > b) inner.reverse()
          const key = inner.join(',')
          const m = alleles[lo]; let e = m.get(key); if (!e) { e = { idx: m.size, n: 0 }; m.set(key, e) } e.n++
          cells[lo * H + hi] = Math.min(253, e.idx); coverN[lo]++
          for (let l = lo + 1; l < hiB; l++) cells[l * H + hi] = 254      // 境界錨を欠く → 前の座位に併合
          if (pr === refPath) (m as any)._ref = key
        }
        prevB = b; prevPos = k
      }
    }
  }
  // アレル番号の付け直し: 参照のアレルを 0、以下は株数順
  const sites: SitesResult['sites'] = []; const cellsOut: number[][] = []
  for (let l = 0; l < nl; l++) {
    const m = alleles[l]; if (m.size < 2) continue
    const order = [...m.entries()].sort((u, v) => (v[1].n - u[1].n) || (u[0] < v[0] ? -1 : 1))
    const refKey = (m as any)._ref as string | undefined
    if (refKey != null) { const i = order.findIndex(e => e[0] === refKey); if (i > 0) { const e = order.splice(i, 1)[0]; order.unshift(e) } }
    const remap = new Map(order.map((e, i) => [e[1].idx, i]))
    const row = new Array(H).fill(255); for (let h = 0; h < H; h++) { const v = cells[l * H + h]; row[h] = v >= 254 ? v : (remap.get(v) ?? 255) }
    cellsOut.push(row)
    const ca = syn.anchorCol[B[l]], cb = syn.anchorCol[B[l + 1]]
    let bpMax = 0; for (const [key] of order) { let bp = 0; if (key) for (const t of key.split(',')) { const c = syn.dcol[Number(t)]; if (c >= 0) bp += syn.colBp[c] } bpMax = Math.max(bpMax, bp) }
    sites.push({ x: Math.round(syn.colXc[ca + 1]), c0: ca + 1, c1: Math.max(ca + 1, cb - 1), ncols: Math.max(0, cb - ca - 1), bp: Math.max(1, bpMax), nall: order.length, counts: order.map(e => e[1].n) })
  }
  const ncover = Math.max(0, ...Array.from(coverN))
  // 混成: 列が多い座位（錨の疎な島・大きな座位）は、その内側を列方式のサイトに分ける。被覆＝その座位にアレルを持つ株。
  // 座位そのもの（有無・アレルの違い）は先頭に 1 列残し、続けて内側の列サイトを置く（x 順）
  let nsplit = 0
  if (sites.some(s => s.ncols > LOCUS_SPLIT)) {
    const d2 = new Database(syn.file, { readonly: true })
    try {
      const sites2: SitesResult['sites'] = []; const cells2: number[][] = []
      for (let k = 0; k < sites.length; k++) {
        const s = sites[k]; sites2.push(s); cells2.push(cellsOut[k])
        if (s.ncols <= LOCUS_SPLIT) continue
        const cover: number[] = []; for (let h = 0; h < H; h++) if (cellsOut[k][h] < 254) cover.push(h)
        if (cover.length < 2) continue
        const sub = colSitesCore(d2, syn, s.c0, s.c1, haps, cover)
        if (!sub.sites.length) continue
        nsplit++; (s as any).split = sub.sites.length
        for (let j = 0; j < sub.sites.length; j++) { (sub.sites[j] as any).sub = k; sites2.push(sub.sites[j]); cells2.push(sub.cellsArr[j]) }
      }
      if (nsplit) { sites.length = 0; cellsOut.length = 0; for (let k = 0; k < sites2.length; k++) { sites.push(sites2[k]); cellsOut.push(cells2[k]) } }
    } finally { d2.close() }
  }
  if (sites.length > max) {
    const per = Math.ceil(sites.length / BIN_TARGET); const bins: SitesResult['sites'] = []; const bcells: number[][] = []
    for (let b = 0; b < sites.length; b += per) {
      const grp = sites.slice(b, b + per); const idx = Array.from({ length: grp.length }, (_, j) => b + j); const row = new Array(H).fill(255)
      for (let h = 0; h < H; h++) { let cov = 0, dif = 0; for (const k of idx) { const a = cellsOut[k][h]; if (a >= 254) continue; cov++; if (a !== 0) dif++ } if (cov) row[h] = Math.min(254, Math.round(254 * dif / cov)) }
      bcells.push(row); const f = grp[0], l = grp[grp.length - 1]
      bins.push({ x: f.x, c0: f.c0, c1: l.c1, ncols: l.c1 - f.c0 + 1, bp: Math.max(1, l.x + l.bp - f.x), nall: 0, counts: [], nsites: grp.length })
    }
    const flatB = new Uint8Array(bins.length * H); bcells.forEach((c, k) => flatB.set(c, k * H))
    return { c0, c1, ncols: c1 - c0 + 1, ncover, H, haps, nsites: bins.length, sites: bins, cells: Buffer.from(flatB.buffer).toString('base64'), binned: true, sitesPerBin: per, totalSites: sites.length, method: 'loci', boundaryTier: T, nsplit } as any
  }
  const flat = new Uint8Array(sites.length * H); cellsOut.forEach((c, k) => flat.set(c, k * H))
  return { c0, c1, ncols: c1 - c0 + 1, ncover, H, haps, nsites: sites.length, sites, cells: Buffer.from(flat.buffer).toString('base64'), method: 'loci', boundaryTier: T, nsplit } as any
}

// ---- locate: ノード名 → 木の葉（原子）または隙間。nodeleaf 表（kind 0 錨 / 1 一意一貫 / 2 私有 / 3 株で別の場所 / 4 多重）----
export function locateNodes(syn: Synteny, names: string[]): { nodes: any[]; nat: number } {
  const d = new Database(syn.file, { readonly: true })
  try {
    const q = d.prepare('SELECT kind, nplace, places FROM nodeleaf WHERE col=?')
    const out: any[] = []
    for (const nm of names) {
      const m = /^n(\d+)$/.exec(nm)
      if (!m || !syn.orig2col) {
        if (syn.hasSupermap) { const r = d.prepare('SELECT layer, major, frac, nplace, places FROM supermap WHERE node_name=? ORDER BY layer DESC LIMIT 1').get(nm) as { layer: number; major: number; frac: number; nplace: number; places: Buffer } | undefined
          if (r) { const pl = new Int32Array(r.places.buffer.slice(r.places.byteOffset, r.places.byteOffset + r.places.length)); const places = Array.from(pl).map(code => { if (code < syn.nat) { const a = syn.atoms[code]; return { atom: code, x0: a.x0, x1: a.x0 + a.span } } const prev = code - syn.nat - 1; const a = prev >= 0 ? syn.atoms[prev] : null; const x = a ? a.x0 + a.span : 0; return { gap: prev, x0: x, x1: x } })
            out.push({ name: nm, kind: 5, layer: r.layer, nplace: r.nplace, frac: r.frac, places }); continue } }
        out.push({ name: nm, kind: -1 }); continue }
      const oid = Number(m[1]); const col = oid < syn.orig2col.length ? syn.orig2col[oid] : -1
      if (col < 0) { out.push({ name: nm, kind: -1 }); continue }
      const r = q.get(col) as { kind: number; nplace: number; places: Buffer } | undefined
      if (!r) { out.push({ name: nm, col, kind: -1 }); continue }
      const pl = new Int32Array(r.places.buffer.slice(r.places.byteOffset, r.places.byteOffset + r.places.length))
      const places = Array.from(pl).map(code => {
        if (code < syn.nat) { const a = syn.atoms[code]; return { atom: code, x0: a.x0, x1: a.x0 + a.span } }
        const prev = code - syn.nat - 1; const a = prev >= 0 ? syn.atoms[prev] : null; const x = a ? a.x0 + a.span : (syn.atoms[0] ? syn.atoms[0].x0 : 0); return { gap: prev, x0: x, x1: x }
      })
      out.push({ name: nm, col, x: Math.round(syn.colXc[col]), rx: syn.colX[col], kind: r.kind, nplace: r.nplace, places })
    }
    return { nodes: out, nat: syn.nat }
  } finally { d.close() }
}

// ---- 原子（葉）の集合 ↔ グラフのノード（層ごと）。参照座標に依らない経路 ----
//   葉の層: 原子の列範囲 [c0, c1] の列 → 名前（col2orig）。上の層: supermap の major（bp 加重の多数派の場所）が原子の範囲に入り、
//   frac ≥ minFrac のノード（旧「参照スパン ≤ 2 × ブロック幅」の規則に相当）
export function nodesForAtoms(syn: Synteny, layer: number, a0: number, a1: number, max = 20000, minFrac = 0.5): { names: string[]; truncated: boolean } {
  const names: string[] = []
  if (layer >= syn.maxlayer || !syn.hasSupermap) {
    if (!syn.col2orig) return { names, truncated: false }
    for (let a = a0; a <= a1 && a < syn.atoms.length; a++) { const A = syn.atoms[a]; for (let c = A.c0; c <= A.c1; c++) { const o = syn.col2orig[c]; if (o >= 0) { names.push('n' + o); if (names.length >= max) return { names, truncated: true } } } }
    return { names, truncated: false }
  }
  const d = new Database(syn.file, { readonly: true })
  try {
    for (const r of d.prepare('SELECT node_name FROM supermap WHERE layer=? AND major BETWEEN ? AND ? AND frac>=?').iterate(layer, a0, a1, minFrac) as Iterable<{ node_name: string }>) { names.push(r.node_name); if (names.length >= max) return { names, truncated: true } }
    return { names, truncated: false }
  } finally { d.close() }
}
// ---- 集合の意味での解決（bp の近似を使わない）----
//   原子の集合 [a0,a1] に「場所」が重なるノード: 葉は atomnodes（場所→列、全場所）、上の層は atomsuper（層・場所→名前、全場所）。
//   どちらも tree.py が 2026-10-07 以降に作る逆引き表。無い古いサイドカーでは従来（列範囲・supermap の多数派）に落ちる。
export function hasSetTables(syn: Synteny): boolean {
  if ((syn as any)._setTables != null) return (syn as any)._setTables
  const d = new Database(syn.file, { readonly: true })
  try { const r = d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('atomnodes','atomsuper')").get() as { n: number }; (syn as any)._setTables = r.n === 2; return r.n === 2 }
  finally { d.close() }
}
export function namesForAtomsExact(syn: Synteny, layer: number, a0: number, a1: number, max = 20000, gaps = true): { names: string[]; truncated: boolean; exact: boolean } {
  if (!hasSetTables(syn)) { const r = nodesForAtoms(syn, layer, a0, a1, max, 0.5); return { ...r, exact: false } }
  const d = new Database(syn.file, { readonly: true })
  try {
    const names: string[] = []; const seen = new Set<string>(); let truncated = false
    // 隙間の場所コード = nat+1+直前の原子。窓の原子の直後の隙間も含める（原子の間の列はその隙間に属する）
    const ranges: [number, number][] = [[a0, a1]]; if (gaps) ranges.push([syn.nat + 1 + a0, syn.nat + 1 + a1])
    if (layer >= syn.maxlayer || !syn.hasSupermap) {
      if (!syn.col2orig) return { names, truncated, exact: true }
      const q = d.prepare('SELECT DISTINCT col FROM atomnodes WHERE place BETWEEN ? AND ?')
      for (const [p0, p1] of ranges) for (const r of q.iterate(p0, p1) as Iterable<{ col: number }>) { const o = syn.col2orig[r.col]; if (o < 0) continue; const nm = 'n' + o; if (seen.has(nm)) continue; if (names.length >= max) { truncated = true; break } seen.add(nm); names.push(nm) }
    } else {
      const q = d.prepare('SELECT DISTINCT node_name FROM atomsuper WHERE layer=? AND place BETWEEN ? AND ?')
      for (const [p0, p1] of ranges) for (const r of q.iterate(layer, p0, p1) as Iterable<{ node_name: string }>) { if (seen.has(r.node_name)) continue; if (names.length >= max) { truncated = true; break } seen.add(r.node_name); names.push(r.node_name) }
    }
    return { names, truncated, exact: true }
  } finally { d.close() }
}
// 列範囲 [c0,c1]（原子の内側の窓: アレル行列・塩基）→ 各パスのトークン範囲（colrange_tokens.py と同じ規則: 範囲の列を持つトークンの
// 最も密な連なり）→ その範囲の全トークンの名前の和。列がずれたノード（私有の 22%）も、パスが通る以上は含まれる
export function namesForCols(syn: Synteny, layer: number, c0: number, c1: number, max = 20000): { names: string[]; truncated: boolean; exact: boolean } {
  if (!syn.dcol || !syn.distill || !syn.col2orig) return { names: [], truncated: false, exact: false }
  const dist = openDistill(syn.distill)
  const atomsIn = syn.atoms.filter(a => a.c1 >= c0 && a.c0 <= c1); const aset = new Set(atomsIn.map(a => a.id))
  const names: string[] = []; const seen = new Set<string>(); let truncated = false
  for (const pr of syn.paths) {
    const pi = dist.pidx.get(pr.path); if (pi == null) continue
    const its = syn.inst[pr.pid].filter(it => aset.has(it.atom)).sort((a, b) => a.s0 - b.s0)
    const runs: [number, number][] = []; for (const it of its) { const last = runs[runs.length - 1]; if (last && it.s0 <= last[1]) last[1] = Math.max(last[1], it.e0); else runs.push([it.s0, it.e0]) }
    for (const [s0, e0] of runs) {
      const toks = dist.read(pi, s0, e0)
      const m: number[] = []; for (let k = 0; k < toks.length; k++) { const c = syn.dcol[toks[k]]; if (c >= c0 && c <= c1) m.push(k) }
      if (!m.length) continue
      // 最も密な連なり（100 トークン超の飛びで切る）
      let bs = 0, be = 0, cs = 0; for (let i = 1; i <= m.length; i++) { if (i === m.length || m[i] - m[i - 1] > 100) { if (i - cs > be - bs) { bs = cs; be = i } cs = i } }
      const lo = m[bs], hi = m[be - 1]
      for (let k = lo; k <= hi; k++) { const c = syn.dcol[toks[k]]; if (c < 0) continue; const o = syn.col2orig[c]; if (o < 0) continue; const nm = 'n' + o; if (seen.has(nm)) continue; if (names.length >= max) { truncated = true; return { names, truncated, exact: true } } seen.add(nm); names.push(nm) }
    }
  }
  // 上の層: 葉の集合をスーパーノードに写す（supermap の多数派ではなく、葉の親を辿るのが正確だが、ここでは葉名→原子→atomsuper で近似せず、葉だけ返す）
  return { names, truncated, exact: layer >= syn.maxlayer }
}

// 名前 → 多数派の原子（葉は nodeleaf の先頭の場所、上の層は supermap の major。-1 = 不明、隙間は -2-prev）
// xs/xe: 葉のノードはその合意列の合意座標 [colXc[col], colXc[col+1])。上の層（supermap）は位置が無いので -1（原子の粒度）
export function atomsOfNames(syn: Synteny, layer: number, names: string[]): { atoms: number[]; fracs: number[]; xs: number[]; xe: number[] } {
  const atoms: number[] = [], fracs: number[] = [], xs: number[] = [], xe: number[] = []
  const d = new Database(syn.file, { readonly: true })
  try {
    const ql = d.prepare('SELECT nplace, places FROM nodeleaf WHERE col=?'), qs = d.prepare('SELECT major, frac FROM supermap WHERE node_name=? AND layer=?')
    for (const nm of names) {
      let atom = -1, frac = 0, x0 = -1, x1 = -1
      if (layer >= syn.maxlayer || !syn.hasSupermap) {
        const m = /^n(\d+)$/.exec(nm); const col = m && syn.orig2col && Number(m[1]) < syn.orig2col.length ? syn.orig2col[Number(m[1])] : -1
        if (col >= 0) { x0 = syn.colXc[col]; x1 = syn.colXc[col + 1]; const r = ql.get(col) as { nplace: number; places: Buffer } | undefined; if (r && r.places.length >= 4) { const p = r.places.readInt32LE(0); atom = p < syn.nat ? p : -2 - (p - syn.nat - 1); frac = r.nplace === 1 ? 1 : 1 / r.nplace } }
      } else { const r = qs.get(nm, layer) as { major: number; frac: number } | undefined; if (r) { atom = r.major < syn.nat ? r.major : -2 - (r.major - syn.nat - 1); frac = r.frac } }
      atoms.push(atom); fracs.push(frac); xs.push(x0); xe.push(x1)
    }
    return { atoms, fracs, xs, xe }
  } finally { d.close() }
}

// 旧サイドカー（JSON）と同じ外形: {meta, windows:[根], tree}
export function rootData(syn: Synteny): any {
  const root = buildWindow(syn, -Infinity, Infinity, { label: '全体', depth: 0, parent: -1, pblock: -1 })
  root.id = 0
  const meta = {
    name: syn.meta.name, circular: syn.circular, bpt: Number(syn.meta.bpt || 0), nhaps: syn.H, ncols: Number(syn.meta.ncols || 0),
    order: { kind: syn.meta.order_kind || 'ref', path: syn.meta.order_path || '' }, params: { anchor_frac: syn.tiers[1] ?? 0.8, sub_anchor_frac: syn.tiers[2] ?? 0.5, tiers: syn.tiers, floor: syn.floor },
    total_bp: syn.paths.reduce((s, p) => s + p.bp, 0), total_x: syn.total, tree: true, synteny: path.basename(syn.file), distill: !!syn.distill,   // distill: tokranges / 塩基 MSA が使えるか（試験の gating にも使う）
    natoms: syn.atoms.length, nboundaries: syn.bnd.length, t_build: syn.meta.t_build, maxlayer: syn.maxlayer, supermap: syn.hasSupermap,
    atoms: syn.atoms.map(a => [a.x0, a.span]),
  }
  return { meta, windows: [root], tree: syn.tree }
}
