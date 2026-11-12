// 塩基の段（Traversals パネルの「範囲」モードの MSA）。11-04 に viewer/scripts/bubble_msa.py の --ranges-stdin から移した。
//   python 版は常駐の別プロセスで、.trav の配列や distill を自分で読み直し、1 文字ずつのループ（全ゲノムの窓で warm 9 秒）だった。
//   ここは Traversals の worker の中で、読み込み済みの配列と distill の読み手を共有する。規則は python 版の各所の注記（日付つき）をそのまま移した。
//   出力は python 版と同じ JSON（tests: functions/travspeed の cmp_msa_ts）。ノードを選ぶモード（Bubble MSA パネル）は python 版に残す
import type Database from 'better-sqlite3'
import { getDb } from './db'
import type { Distill } from './distill'
import { parseGafLine, type ReadsSource } from './msaReads'

const HEAD = 7, TAIL = 3, MAX_ROWS = 600, MAX_COLS = 320
const COMP: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N', a: 't', c: 'g', g: 'c', t: 'a', n: 'n' }
export const rc = (s: string): string => { let o = ''; for (let i = s.length - 1; i >= 0; i--) { const c = s[i]; o += COMP[c] ?? c } return o }
const idn = (n: string) => Number(n.slice(1))
// Python の値の並び（数・文字列・配列）
function cmpPy(a: any, b: any): number {
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmpPy(a[i], b[i]); if (c) return c } return a.length - b.length }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean') a = a ? 1 : 0; if (typeof b === 'boolean') b = b ? 1 : 0
  return a < b ? -1 : a > b ? 1 : 0
}
function bisectLeft(a: number[], x: number): number { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m } return lo }
const signSum = (v: number[]) => { let s = 0; for (let i = 1; i < v.length; i++) s += Math.sign(v[i] - v[i - 1]); return s }
// numpy.interp（xp は昇順）
function interp(x: number, xp: number[], fp: number[]): number {
  const n = xp.length; if (x <= xp[0]) return x === xp[0] ? fp[0] : fp[0]; if (x >= xp[n - 1]) return fp[n - 1]
  let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m + 1; else hi = m } const j = lo - 1
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]); return slope * (x - xp[j]) + fp[j]
}
class Heap<T> { a: T[] = []; constructor(private lt: (x: T, y: T) => boolean) {}
  push(x: T) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p } else break } }
  pop(): T { const a = this.a; const top = a[0]; const last = a.pop()!; if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.lt(a[l], a[m])) m = l; if (r < a.length && this.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m } } return top }
  get size() { return this.a.length } }

export interface MsaCtx {
  dbFile: string
  dist: Distill
  idOf: (d: number) => number           // dense → 元 id
  denseOf: (v: number) => number        // 元 id → dense（無ければ -1）
  order: ArrayLike<number> | null       // dense → 合意の並び（.trav の x、錨でない葉は x_fill。無ければ -1）
  reads?: ReadsSource | null            // <db>.reads（msaReads.ts）。無ければリードの行は出さない
  // 11-12（設計 plans/viewer-cold-bounded.md 4c）: 窓のタイル・配列ファイル・distill の配列から引く口。無ければ従来（distill のパスごとの読み・本体 DB の leaf_seq と nodes）
  tok?: { read: (pi: number, a: number, b: number) => Float64Array; ori: (pi: number, a: number, b: number) => Uint8Array } | null
  nodeInfo?: ((ids: number[]) => { seq: Map<number, string>; refbp: Map<number, number>; refcid: Map<number, number> } | null) | null
  orderOf?: ((denses: number[]) => Map<number, number>) | null
}
function bisectRight(a: number[], x: number, lo: number, hi: number): number { while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1 } return lo }

export function bubbleMsaRanges(C: MsaCtx, req: any, opt: { label?: string; flank?: number; cap?: number | null; maxLeaves?: number | null; maxTokens?: number }): any {
  const PROF = process.env.AMIPA_MSA_PROF === '1'; let tP = Date.now(); const prof = (m: string) => { if (PROF) { const n = Date.now(); console.error(`[msa] ${m} ${n - tP} ms`); tP = n } }
  const dist = C.dist; const p_names = dist.names; const flank = opt.flank ?? 4
  const CAP = opt.cap != null ? (opt.cap > 0 ? opt.cap : 1e9) : 12
  const MAX_LEAVES = opt.maxLeaves ? Math.max(1, Math.floor(opt.maxLeaves)) : 400
  const maxTokens = opt.maxTokens || 800_000_000
  const off = (pi: number) => Number(dist.off[pi]); const ntok = (pi: number) => dist.ntok(pi)
  const tokRange = (pi: number, a: number, b: number) => C.tok ? C.tok.read(pi, a, b) : dist.read(pi, a, b)
  const oriRange = (pi: number, a: number, b: number) => C.tok ? C.tok.ori(pi, a, b) : dist.readOri(pi, a, b)
  const nname = (t: number) => 'n' + C.idOf(t)
  const con: Database.Database = getDb(C.dbFile)
  // ---- 範囲 ----
  const RNG = new Map<number, [number, number][]>(); const RDIR = new Map<number, number>()
  for (const r of (req.ranges || [])) {
    const pi = (typeof r[0] === 'number' && Number.isInteger(r[0]) && r[0] >= 0 && r[0] < p_names.length) ? r[0] : dist.pidx.get(String(r[0]))
    if (pi == null) continue
    const n_ = ntok(pi); const s0 = Math.max(0, Math.min(n_, Math.trunc(Number(r[1])))); const e0 = Math.max(s0, Math.min(n_, Math.trunc(Number(r[2]))))
    if (e0 > s0) { if (!RNG.has(pi)) RNG.set(pi, []); RNG.get(pi)!.push([s0, e0]) }
    if (r.length > 3 && r[3] != null && Math.trunc(Number(r[3])) !== 0) RDIR.set(pi, Math.trunc(Number(r[3])) > 0 ? 1 : -1)
  }
  if (!RNG.size) return { error: '範囲が空です（パス名が distill と一致しません）' }
  const EXT = 20000, GAPMAX = 64, STEP = 512
  const unionOf = () => { const s = new Set<number>(); for (const [pi, rs] of RNG) for (const [s0, e0] of rs) { const t = tokRange(pi, s0, e0); for (let i = 0; i < t.length; i++) s.add(t[i]) } return s }
  let Sall = unionOf()
  for (let pass = 0; pass < 2; pass++) {
    let grew = false
    for (const [pi, rs] of RNG) {
      const n_ = ntok(pi); const out_: [number, number][] = []
      for (const [s0, e0] of rs) {
        let ns0 = s0, miss = 0, pos = s0; let lim = Math.max(0, s0 - EXT)
        while (pos > lim && miss <= GAPMAX) { const lo = Math.max(lim, pos - STEP); const seg = tokRange(pi, lo, pos)
          for (let k = seg.length - 1; k >= 0; k--) { if (Sall.has(seg[k])) { ns0 = lo + k; miss = 0 } else { miss++; if (miss > GAPMAX) break } } pos = lo }
        let ne0 = e0; miss = 0; pos = e0; lim = Math.min(n_, e0 + EXT)
        while (pos < lim && miss <= GAPMAX) { const hi = Math.min(lim, pos + STEP); const seg = tokRange(pi, pos, hi)
          for (let k = 0; k < seg.length; k++) { if (Sall.has(seg[k])) { ne0 = pos + k + 1; miss = 0 } else { miss++; if (miss > GAPMAX) break } } pos = hi }
        if (ns0 !== s0 || ne0 !== e0) grew = true
        out_.push([ns0, ne0])
      }
      RNG.set(pi, out_)
    }
    if (!grew) break
    Sall = unionOf()
  }
  const RG = new Map<number, [number, number][][]>()
  for (const [pi, rs] of RNG) {
    const out_: [number, number][] = []
    for (const [s0, e0] of [...rs].sort((a, b) => a[0] - b[0] || a[1] - b[1])) { if (out_.length && s0 <= out_[out_.length - 1][1] + 2) out_[out_.length - 1] = [out_[out_.length - 1][0], Math.max(out_[out_.length - 1][1], e0)]; else out_.push([s0, e0]) }
    const JOIN = 20000; const grp_: [number, number][][] = []
    for (const [s0, e0] of out_) { if (grp_.length && s0 - grp_[grp_.length - 1][grp_[grp_.length - 1].length - 1][1] <= JOIN) grp_[grp_.length - 1].push([s0, e0]); else grp_.push([[s0, e0]]) }
    RG.set(pi, grp_)
  }
  const label = opt.label || String(req.label || 'Blocks')
  // ---- S と葉 ----
  const Sdense = new Set<number>()
  for (const [pi, rs] of RG) for (const grp of rs) for (const [s0, e0] of grp) { const t = tokRange(pi, s0, e0); for (let i = 0; i < t.length; i++) Sdense.add(t[i]) }
  if (Sdense.size > MAX_LEAVES) return { error: `この範囲は葉が ${Sdense.size} 個あり、塩基レベル MSA の上限 ${MAX_LEAVES} を超えます。Blocks でさらに内側へ降りてください。` }
  const leaves = [...new Set([...Sdense].map(nname))].sort((a, b) => idn(a) - idn(b))
  if (!Sdense.size) return { error: '葉を distill の dense id に対応づけできません(グラフ不一致?)' }
  // ---- 参照 ----
  const refpref = new Set(['grch38', 'chm13'])
  try { for (const r of con.prepare('SELECT DISTINCT ref_key FROM ref_contigs').raw().all() as any[][]) if (r[0]) refpref.add(String(r[0]).toLowerCase()) } catch { /* */ }
  const isrefPi = (pi: number) => { const low = p_names[pi].toLowerCase(); for (const p of refpref) if (low === p || low.startsWith(p + '#') || low.startsWith(p + '.')) return true; return false }
  const pis = [...new Set(RG.keys())].sort((a, b) => (Number(!isrefPi(a)) - Number(!isrefPi(b))) || a - b)
  let ntokAll = 0; for (const pi of pis) for (const grp of RG.get(pi)!) for (const [s0, e0] of grp) ntokAll += e0 - s0
  if (ntokAll > maxTokens) return { error: `走査対象が大きすぎます(${pis.length} contig / ${(ntokAll / 1e6).toFixed(1)}M token)。対象サンプル/ハプロタイプを絞ってください。` }
  // ---- 行（通過）----
  const labelsOf = (pi: number): [string, string, string, string] => { const full = p_names[pi]; const base = full.replace(/\[[^\]]*\]$/, ''); const f = base.split('#'); return [f[0], f.length >= 3 ? f.slice(0, 2).join('#') : base, f.length >= 3 ? f[2] : '', full] }
  const runs: any[] = []
  outer: for (const pi of pis) {
    const [samp, lab, ctg, full] = labelsOf(pi); const isref = isrefPi(pi); const nb = ntok(pi); if (nb <= 0) continue
    const rr: { ids: number[]; ors: number[]; cend: [boolean, boolean]; brk: [number, number][] }[] = []
    for (const grp of RG.get(pi)!) {
      const tk: number[] = [], oo: number[] = [], brks: [number, number][] = []
      grp.forEach(([s0, e0], gi) => {
        const lo = gi === 0 ? Math.max(0, s0 - flank) : s0; const hi = gi === grp.length - 1 ? Math.min(nb, e0 + flank) : e0
        if (gi > 0) brks.push([tk.length, s0 - grp[gi - 1][1]])
        const t = tokRange(pi, lo, hi), o = oriRange(pi, lo, hi); for (let i = 0; i < t.length; i++) { tk.push(t[i]); oo.push(o[i]) }
      })
      const lo0 = Math.max(0, grp[0][0] - flank), hi1 = Math.min(nb, grp[grp.length - 1][1] + flank)
      const cuts = [0]; let seen = new Set<number>()
      for (let k = 0; k < tk.length; k++) { const t_ = tk[k]
        if (seen.has(t_)) { const look = tk.slice(k, k + 16); let c = 0; for (const q of look) if (seen.has(q)) c++; if (c >= Math.min(8, look.length)) { cuts.push(k); seen = new Set() } }
        seen.add(t_) }
      cuts.push(tk.length)
      for (let i = 0; i + 1 < cuts.length; i++) { const ca = cuts[i], cb = cuts[i + 1]; if (cb <= ca) continue
        rr.push({ ids: tk.slice(ca, cb), ors: oo.slice(ca, cb), cend: [lo0 === 0 && ca === 0, hi1 === nb && cb === tk.length], brk: brks.filter(([j]) => ca < j && j < cb).map(([j, n]) => [j - ca, n]) }) }
    }
    rr.forEach((x, k) => { runs.push({ samp, lab, ctg, path: full, isref, ids: x.ids, ors: x.ors, pi, brk: x.brk, k: rr.length === 1 ? 0 : k + 1, cend: x.cend }) })
    if (runs.length >= MAX_ROWS) { runs.length = Math.min(runs.length, MAX_ROWS); break outer }
  }
  if (!runs.length) return { error: '選択サンプル/参照がこの bubble を通っていません' }
  const npath = new Map<string, Set<string>>(); for (const r of runs) { if (!npath.has(r.lab)) npath.set(r.lab, new Set()); npath.get(r.lab)!.add(r.path) }
  for (const r of runs) { let lab = r.lab; if (npath.get(lab)!.size > 1 && r.ctg) lab += ':' + r.ctg.slice(-8); r.label = lab + (!r.k ? '' : ` ·${r.k}`) }
  // ---- リード（10-28）: 要求に reads があり <db>.reads があれば、窓のノード（Sall）を通るリードを行として足す ----
  //   各リードの GAF の path を窓のノードの連なりで切り、ノードごとに cs から「格納向きの文字列」を作る（一致＝ノードの塩基、置換＝リードの塩基、欠失＝'-'、掛からない所＝'.'）
  prof('範囲・行'); const rq = req.reads || null
  if (rq && C.reads) { try {
    const RS = C.reads; const maxr = Math.trunc(Number(rq.max ?? 60)); const want = new Set<string>(rq.samples || [])
    const win_ids = new Set([...Sall].map(t => C.idOf(t))); const wsorted = [...win_ids].sort((a, b) => a - b)
    // 窓全体から選ぶ（10-29）: 窓のノードを最大 200 個標本し、標本を順に回って、まだ選んでいないリードを 1 本ずつ取る（サンプルごとに上限まで）
    const step = Math.max(1, Math.floor(win_ids.size / 200)); const probe = wsorted.filter((_, i) => i % step === 0)
    const cand = new Map<number, number>(); let plist: number[][] = []
    for (const gid of probe) { const al_ = RS.nodeAlnIds(gid).slice(0, 2000); plist.push(al_); for (const aid of al_) cand.set(aid, (cand.get(aid) ?? 0) + 1) }
    const info = new Map<number, [number, number, string]>()
    for (const [aid, v] of RS.alnInfo([...cand.keys()])) { if (want.size && !want.has(RS.sampleName.get(v[0]) as string)) continue; info.set(aid, v) }
    plist = plist.map(al_ => al_.filter(a => info.has(a)).sort((a, b) => cand.get(b)! - cand.get(a)!))
    const got = new Map<number, number>(), chosen = new Set<number>(), pick: [number, number, number, string][] = []; const pos_ = plist.map(() => 0); let more = true
    while (more) { more = false
      for (let pi_ = 0; pi_ < plist.length; pi_++) { const al_ = plist[pi_]
        while (pos_[pi_] < al_.length) { const a = al_[pos_[pi_]]; pos_[pi_]++; if (chosen.has(a)) continue; const [sn, vo, rn] = info.get(a)!; if ((got.get(sn) ?? 0) >= maxr) continue
          chosen.add(a); got.set(sn, (got.get(sn) ?? 0) + 1); pick.push([sn, a, vo, rn]); more = true; break } } }
    prof('リード: 標本と選択'); const lines = RS.fetchLines(pick.map(([sn, a, vo]) => [sn, a, vo] as [number, number, number]))
    prof('リード: GAF の行の取り出し'); const read_meta: any[] = []
    pick.forEach(([sn], i) => {
      const d = parseGafLine(lines[i]); if (!d || !d.cs) return
      const toks: [number, boolean][] = [...String(d.path).matchAll(/([<>])(\d+)/g)].map(m => [Number(m[2]), m[1] === '>'])
      const inw: number[] = []; toks.forEach(([gid], j) => { if (win_ids.has(gid)) inw.push(j) }); if (!inw.length) return
      const cl: number[][] = [[inw[0]]]; for (const i_ of inw.slice(1)) { const last = cl[cl.length - 1]; if (i_ - last[last.length - 1] > 50) cl.push([i_]); else last.push(i_) }
      const JOINR = 2000; const mg: number[][] = [[...cl[0]]]; for (const c_ of cl.slice(1)) { const last = mg[mg.length - 1]; if (c_[0] - last[last.length - 1] <= JOINR) last.push(...c_); else mg.push([...c_]) }
      let best_ = mg[0]; for (const m of mg) if (m.length > best_.length) best_ = m
      read_meta.push({ sn, sample: RS.sampleName.get(sn) ?? String(sn), name: d.read_name, mapq: d.mapq, toks, i0: best_[0], i1: best_[best_.length - 1], d })
    })
    if (read_meta.length) {
      const dmap = new Map<number, number>(); for (const rm of read_meta) for (const [gid] of rm.toks) if (!dmap.has(gid)) { const dd = C.denseOf(gid); if (dd >= 1) dmap.set(gid, dd) }
      for (const rm of read_meta) {
        const ids_: number[] = [], ors_: number[] = [], tix_: number[] = []
        for (let t_i = rm.i0; t_i <= rm.i1; t_i++) { const [gid, o] = rm.toks[t_i]; const dd = dmap.get(gid); if (dd != null) { ids_.push(dd); ors_.push(o ? 1 : 0); tix_.push(t_i) } }
        if (!ids_.length) continue
        const nm: string = rm.name; const short = (nm.match(/\//g) || []).length >= 2 ? nm.split('/')[1] : nm.slice(-10)
        runs.push({ label: '▸' + rm.sample + ':' + short, samp: rm.sample, lab: '▸' + rm.sample + ':' + short, ctg: '', path: nm, isref: false, ids: ids_, ors: ors_, pi: null, brk: [], k: 0, cend: [false, false], rd: rm, tix: tix_ })
      }
    }
  } catch (e) { console.error('[msa] reads: ' + String(e)) } }
  prof('リード: 行の切り出し'); // ---- 塩基と参照位置 ----
  const needSet = new Set<string>(); for (const r of runs) for (const t of r.ids) needSet.add(nname(t)); for (const r of runs) if (r.rd) for (const [gid] of r.rd.toks) needSet.add('n' + gid)
  const need = [...needSet].sort((a, b) => idn(a) - idn(b))
  const seqleaf = new Map<string, string>(), refbp = new Map<string, number>(), refcid = new Map<string, number>()
  const ni = C.nodeInfo ? C.nodeInfo(need.map(idn)) : null
  if (ni) { for (const [id, sq] of ni.seq) seqleaf.set('n' + id, sq); for (const [id, rb] of ni.refbp) { refbp.set('n' + id, rb); const c = ni.refcid.get(id); if (c != null && c >= 0) refcid.set('n' + id, c) } }
  else for (let i = 0; i < need.length; i += 400) { const ch = need.slice(i, i + 400); const ph = ch.map(() => '?').join(',')
    for (const [lid, s] of con.prepare(`SELECT leaf_id, seq FROM leaf_seq WHERE leaf_id IN (${ph})`).raw().all(...ch.map(idn)) as any[][]) seqleaf.set('n' + lid, typeof s === 'string' ? s : Buffer.from(s).toString('latin1'))
    for (const [nm, rb, rcid] of con.prepare(`SELECT node_name, MIN(ref_bp), ref_contig_id FROM nodes WHERE node_name IN (${ph}) AND ref_bp IS NOT NULL GROUP BY node_name`).raw().all(...ch) as any[][]) { refbp.set(nm, Number(rb)); if (rcid != null) refcid.set(nm, Number(rcid)) } }
  const L = (n: string) => (seqleaf.get(n) ?? '').length
  prof('塩基と参照位置')
  // リードの行のノードごとの文字列（格納向き）。パス座標で cs を歩き、ノード [off, off+seg) に一致・置換・欠失・挿入を落とす
  for (const r of runs) {
    const rm = r.rd; if (!rm) continue
    const d = rm.d; const ps = d.path_start; const toks: [number, boolean][] = rm.toks
    const offs: [number, boolean, number, number][] = []; let off2 = 0; for (const [gid, o] of toks) { const L_ = L('n' + gid); offs.push([gid, o, off2, L_]); off2 += L_ }
    const lo_ = offs[rm.i0][2], hi_ = offs[rm.i1][2] + offs[rm.i1][3]
    const buf = new Map<string, string[]>(); const ins = new Map<number, number>(); const rins: [string, number, string, number][] = []
    for (let t_i = rm.i0; t_i <= rm.i1; t_i++) { const [gid, , of_, L_] = offs[t_i]; buf.set(gid + '|' + of_, new Array(L_).fill('.')) }
    const starts_ = offs.map(x => x[2])
    const tokAt = (pos: number) => { const t_i = bisectRight(starts_, pos, rm.i0, rm.i1 + 1) - 1; if (t_i < rm.i0) return -1; const [, , of_, L_] = offs[t_i]; return of_ <= pos && pos < of_ + L_ ? t_i : -1 }
    // 11-04: トークンごとの置き場と向きを揃えた配列を一度だけ作る（以前は 1 塩基ごとにノードの配列全体の逆相補とキーの文字列を作り直し、全ゲノムの窓で 11〜14 秒）
    const tbuf: (string[] | undefined)[] = [], tbase: (string | undefined)[] = []
    const put = (pos: number, ch: string | null) => { const t_i = tokAt(pos); if (t_i < 0) return; const [gid, o, of_] = offs[t_i]
      let bf = tbuf[t_i]; if (!bf) { bf = buf.get(gid + '|' + of_)!; tbuf[t_i] = bf }
      if (ch == null) { let base = tbase[t_i]; if (base === undefined) { const sq = seqleaf.get('n' + gid) ?? ''; base = o ? sq : rc(sq); tbase[t_i] = base } bf[pos - of_] = base[pos - of_] } else bf[pos - of_] = ch }
    let pos = ps
    for (const m_ of String(d.cs).toLowerCase().matchAll(/(:\d+)|(\*[a-z][a-z])|(-[a-z]+)|(\+[a-z]+)/g)) {
      const t = m_[0]
      if (t[0] === ':') { const Lc = Number(t.slice(1)); for (let q = Math.max(pos, lo_); q < Math.min(pos + Lc, hi_); q++) put(q, null); pos += Lc }
      else if (t[0] === '*') { if (lo_ <= pos && pos < hi_) put(pos, t[2].toUpperCase()); pos += 1 }
      else if (t[0] === '-') { for (let q = Math.max(pos, lo_); q < Math.min(pos + t.length - 1, hi_); q++) put(q, '-'); pos += t.length - 1 }
      else { if (lo_ <= pos && pos < hi_) { ins.set(pos, (ins.get(pos) ?? 0) + t.length - 1); const t_i = tokAt(pos)
          if (t_i >= 0) { const [gid, o, of_, L_] = offs[t_i]; const k_ = pos - of_; const sq_ = t.slice(1).toUpperCase(); rins.push(['n' + gid, o ? k_ : L_ - k_, o ? sq_ : rc(sq_), t_i]) } } }
      if (pos >= hi_) break
    }
    const rdt = new Map<number, string>(); for (let t_i = rm.i0; t_i <= rm.i1; t_i++) { const [gid, o, of_] = offs[t_i]; const w = buf.get(gid + '|' + of_)!.join(''); rdt.set(t_i, o ? w : rc(w)) }
    const tpos = new Map<number, number>(); (r.tix as number[]).forEach((t_, k_) => tpos.set(t_, k_))
    r.rdocc = (r.tix as number[]).map(t_ => rdt.get(t_)!); let ni = 0; for (const v of ins.values()) ni += v; r.nins = ni
    r.rins = rins.filter(x => tpos.has(x[3])).map(([n_, k_, q_, t_]) => [n_, k_, q_, tpos.get(t_)!])
  }
  prof('リード: cs を歩く'); // ---- 行の向き ----
  // 合意の並び: 窓の行のノードだけ引く（11-12: 配列ファイルから。以前は全ゲノムの配列を丸ごと作った）
  const dcache: ArrayLike<number> | null = C.orderOf ? (() => { const ds: number[] = []; for (const r of runs) for (const t of r.ids as number[]) ds.push(t); const m = C.orderOf!(ds)
    return new Proxy({ length: Number.MAX_SAFE_INTEGER } as any, { get: (o, k) => (k === 'length' ? o.length : (m.get(Number(k)) ?? -1)) }) as ArrayLike<number> })() : C.order
  const dense_of_name = new Map<string, number>()
  const pre: { r: any; nodes: string[]; ors: number[]; rev: boolean; cflip?: boolean }[] = []
  for (const r of runs) { const nodes = (r.ids as number[]).map(nname); let wp = 0, wm = 0; nodes.forEach((n, i) => { if (r.ors[i]) wp += L(n); else wm += L(n) })
    pre.push({ r, nodes, ors: r.ors, rev: wm > wp }); r.ids.forEach((t: number, i: number) => { if (!dense_of_name.has(nodes[i])) dense_of_name.set(nodes[i], t) }) }
  const disp = (p: { nodes: string[]; rev: boolean }) => (p.rev ? [...p.nodes].reverse() : p.nodes)
  let bi = pre.findIndex(p => p.r.isref); if (bi < 0) bi = 0
  const fixed = new Set<number>()
  if (pre.length) { const refdir = RDIR.get(pre[bi].r.pi); pre.forEach((p, k) => { const d = p.r.pi == null ? undefined : RDIR.get(p.r.pi); if (d == null) return; p.rev = refdir != null ? d !== refdir : d < 0; fixed.add(k) }) }
  if (pre.length) {
    const bseq = disp(pre[bi]); const bpos = new Map<string, number>(); bseq.forEach((n, k) => { if (!bpos.has(n)) bpos.set(n, k) })
    const ctrend = (seq: string[]) => { if (!dcache) return 0; const cs: number[] = []; for (const n of seq) { const d = dense_of_name.get(n); if (d != null && d >= 0 && d < dcache.length && dcache[d] >= 0) cs.push(dcache[d]) } return cs.length >= 2 ? signSum(cs) : 0 }
    const btrend = ctrend(bseq)
    pre.forEach((p, k) => { if (k === bi) return; const sq = disp(p); const sh: number[] = []; for (const n of sq) { const b = bpos.get(n); if (b != null) sh.push(b) }
      let t = sh.length >= 2 ? signSum(sh) : 0
      // コンティグの主な向きで決めた行（fixed）も、この窓で基準の行と共有するノードの順がはっきり逆なら裏返す（11-11）。
      //   逆位の通過は主な向きだと合意と逆順になり、全ノードが「列の順と違う位置」＝写しの列に回って、参照型の行と 1 列もそろわなかった
      //   （HPRC chr10:79.5–80.2 Mb の 710 kb 逆位の 5 本）。裏返せば合意の列に入り、向きの違いは逆位の印（inv）で出る
      if (fixed.has(k)) { if (sh.length >= 4 && -t >= Math.max(3, 0.3 * (sh.length - 1))) { p.rev = !p.rev; p.cflip = true } return }   // cflip ＝コンティグの主な向きと逆に通る（逆位）。行全体に紫の帯
      if (t === 0 && btrend !== 0) t = ctrend(sq) * (btrend > 0 ? 1 : -1); if (t < 0) p.rev = !p.rev })
  }
  const has_h = pre.some(p => !p.r.rd)
  const rc_votes = new Map<string, number>(); const raw: any[] = []
  for (const { r, nodes, ors, rev, cflip } of pre) {
    const cells = new Map<string, string>(); const inv: string[] = []; let occ: string[] = [], occ_inv: boolean[] = [], occ_st: string[] = []; const rdo: string[] | undefined = r.rdocc; const vote = !(rdo && has_h)
    nodes.forEach((n, k_) => { const o = ors[k_]; const st_ = rdo ? rdo[k_] : (seqleaf.get(n) ?? '?'); const iv_ = (!o) !== rev; const s = iv_ ? rc(st_) : st_
      occ.push(s); occ_inv.push(iv_); occ_st.push(st_); if (cells.has(n)) return; if (iv_) inv.push(n); if (vote) rc_votes.set(n, (rc_votes.get(n) ?? 0) + (iv_ ? 1 : -1)); cells.set(n, s) })
    if (rev) { occ = occ.reverse(); occ_inv = occ_inv.reverse(); occ_st = occ_st.reverse() }
    const rins_ = (r.rins || []).map(([n_, k_, q_, i_]: any[]) => [n_, k_, q_, rev ? nodes.length - 1 - i_ : i_])
    const ce = r.cend || [false, false]
    const brk_ = (r.brk || []).filter(([i]: number[]) => 0 < i && i < nodes.length).map(([i, n_]: number[]) => [nodes[i - 1], nodes[i], Math.trunc(n_)])
    let hseq_ = nodes.map((n_, i) => (ors[i] ? (seqleaf.get(n_) ?? 'N') : rc(seqleaf.get(n_) ?? 'N'))).join('')
    if (rdo) hseq_ = rdo.map((st_, i) => (ors[i] ? st_ : rc(st_))).join('').replace(/-/g, '').replace(/\./g, '')
    raw.push({ rdinfo: r.rd ? { sample: r.rd.sample, name: r.rd.name, mapq: r.rd.mapq, nins: r.nins ?? 0 } : null, rins: rins_, occ, occ_inv, occ_st, seqn: rev ? [...nodes].reverse() : nodes, hseq: hseq_, samp: r.samp, label: r.label, path: r.path,
      strand: rev ? '-' : '+', cells, inv, ends: rev ? [ce[1], ce[0]] : [ce[0], ce[1]], nodes: new Set(nodes), seq: rev ? [...nodes].reverse() : nodes, isref: r.isref, brk: brk_, cflip: !!cflip })
  }
  const normRow = (r: any) => { const seqn: string[] = r.seq, oi: boolean[] = r.occ_inv, ost: string[] = r.occ_st; const occ: string[] = r.occ = [...r.occ0]
    let i = 0
    while (i < seqn.length) { if (!oi[i]) { i++; continue } let j = i; while (j < seqn.length && oi[j]) j++
      let sum = 0, big = false; for (let q = i; q < j; q++) { const l = L(seqn[q]); sum += l; if (l > 3) big = true }
      if (sum >= 10 || big) for (let q = i; q < j; q++) occ[q] = (rc_votes.get(seqn[q]) ?? 0) > 0 ? rc(ost[q]) : ost[q]
      i = j }
    seqn.forEach((n, q) => { if (!oi[q] && (rc_votes.get(n) ?? 0) > 0 && L(n) > 3) occ[q] = rc(ost[q]) }) }
  for (const r of raw) { r.occ0 = [...r.occ]; normRow(r) }
  prof('行の向き・文字'); // ---- 列 ----
  let craw = raw.filter(r => !r.rdinfo); if (!craw.length) craw = raw
  const allnSet = new Set<string>(); for (const r of craw) for (const n of r.nodes) allnSet.add(n)
  const alln = [...allnSet].sort((a, b) => idn(a) - idn(b))
  const present = new Map<string, Set<number>>(); for (const n of alln) present.set(n, new Set()); craw.forEach((r, i) => { for (const n of r.nodes) present.get(n)!.add(i) })
  const colof = dcache ? (() => { const m = new Map<string, number>(); for (const [n, d] of dense_of_name) m.set(n, d >= 0 && d < dcache.length ? Number(dcache[d]) : -1); return m })() : null
  let invNodes: Set<string>; const seg_pos = new Map<string, number>()
  const baseRow = craw.find(r => r.isref) ?? craw[0]
  if (colof && colof.size) {
    const succ = new Map<string, Set<string>>()
    for (const r of craw) { const sq: string[] = r.seq; for (let i = 0; i + 1 < sq.length; i++) { if (!succ.has(sq[i])) succ.set(sq[i], new Set()); succ.get(sq[i])!.add(sq[i + 1]) } }
    const paired = new Set<string>()
    for (const [, sset] of succ) { const S_ = [...sset].filter(n => (succ.get(n)?.size ?? 0) > 0); if (S_.length < 2 || S_.length > 16) continue
      for (let ia = 0; ia < S_.length; ia++) for (let ib = ia + 1; ib < S_.length; ib++) { const a_ = S_[ia], b_ = S_[ib]; const sa = succ.get(a_)!, sb = succ.get(b_)!
        let inter = false; for (const x of sa) if (sb.has(x)) { inter = true; break } if (!inter) continue
        let disj = true; for (const x of present.get(a_)!) if (present.get(b_)!.has(x)) { disj = false; break } if (disj) { paired.add(a_); paired.add(b_) } } }
    const need_ = Math.max(2, Math.floor((craw.length + 3) / 4))
    invNodes = new Set(alln.filter(n => !paired.has(n) && present.get(n)!.size >= need_ && (colof.get(n) ?? -1) >= 0))
    const bposf = new Map<string, number>(); (baseRow.seq as string[]).forEach((n, k) => { if (invNodes.has(n) && !bposf.has(n)) bposf.set(n, k) })
    const prio = new Map<string, [number, number]>(); for (const n of invNodes) prio.set(n, bposf.has(n) ? [0, bposf.get(n)!] : [1, colof.get(n) ?? 0])
    const outs = new Map<string, Set<string>>(), indeg = new Map<string, number>(); for (const n of invNodes) { outs.set(n, new Set()); indeg.set(n, 0) }
    for (const r of craw) { const sq_ = (r.seq as string[]).filter(n => invNodes.has(n)); for (let i = 0; i + 1 < sq_.length; i++) { const a_ = sq_[i], b_ = sq_[i + 1]; if (a_ !== b_ && !outs.get(a_)!.has(b_)) { outs.get(a_)!.add(b_); indeg.set(b_, indeg.get(b_)! + 1) } } }
    const bl = [...bposf].map(([n, k]) => [colof.get(n)!, k] as [number, number]).sort((a, b) => cmpPy(a, b))
    if (bl.length) { const xs_ = bl.map(x => x[0]), ys_ = bl.map(x => x[1]); for (const n of invNodes) if (!bposf.has(n)) prio.set(n, [0, interp(colof.get(n)!, xs_, ys_) + 1e-3]) }
    const lt = (x: [[number, number], string], y: [[number, number], string]) => cmpPy([x[0][0], x[0][1], x[1]], [y[0][0], y[0][1], y[1]]) < 0
    const heap = new Heap<[[number, number], string]>(lt); for (const n of invNodes) if (indeg.get(n) === 0) heap.push([prio.get(n)!, n])
    const order_: string[] = []; const done_ = new Set<string>()
    while (order_.length < invNodes.size) {
      if (!heap.size) { let m_: string | null = null; for (const n of invNodes) { if (done_.has(n)) continue; if (m_ == null || cmpPy([...prio.get(n)!, idn(n)], [...prio.get(m_)!, idn(m_)]) < 0) m_ = n } indeg.set(m_!, 0); heap.push([prio.get(m_!)!, m_!]) }
      const [, n] = heap.pop(); if (done_.has(n)) continue
      done_.add(n); order_.push(n)
      for (const m_ of outs.get(n)!) { indeg.set(m_, indeg.get(m_)! - 1); if (indeg.get(m_) === 0 && !done_.has(m_)) heap.push([prio.get(m_)!, m_]) }
    }
    order_.forEach((n, k) => seg_pos.set(n, k))
  } else {
    invNodes = new Set(alln.filter(n => present.get(n)!.size === craw.length))
    ;(baseRow.seq as string[]).forEach((n, i) => { if (invNodes.has(n) && !seg_pos.has(n)) seg_pos.set(n, i) })
    let nseg = seg_pos.size; for (const r of craw) for (const n of r.seq) if (invNodes.has(n) && !seg_pos.has(n)) seg_pos.set(n, nseg++)
  }
  const keyof = new Map<string, [number, number]>(); const setk = (n: string, v: [number, number]) => { if (!keyof.has(n)) keyof.set(n, v) }
  for (const r of craw) {
    const sq: string[] = r.seq
    if (colof && colof.size) {
      const first = sq.findIndex(n => invNodes.has(n))
      if (first >= 0) { let back = 0; for (let i = first - 1; i >= 0; i--) { back += L(sq[i]); setk(sq[i], [seg_pos.get(sq[first])!, -1 - back]) } }
      const sidx: number[] = []; sq.forEach((n, i) => { if (invNodes.has(n)) sidx.push(i) })
      for (const i of sidx) setk(sq[i], [seg_pos.get(sq[i])!, -1])
      for (let z = 0; z + 1 < sidx.length; z++) { const a_ = sidx[z], b_ = sidx[z + 1]; const mid = sq.slice(a_ + 1, b_); if (!mid.length) continue
        const A_ = sq[a_], B_ = sq[b_]; let base_: string, seq_: string[]; if (seg_pos.get(A_)! <= seg_pos.get(B_)!) { base_ = A_; seq_ = mid } else { base_ = B_; seq_ = [...mid].reverse() }
        let off2 = L(base_); for (const n of seq_) { setk(n, [seg_pos.get(base_)!, off2]); off2 += L(n) } }
      if (sidx.length) { const last = sidx[sidx.length - 1]; const seg = seg_pos.get(sq[last])!; let off2 = L(sq[last]); for (const n of sq.slice(last + 1)) { setk(n, [seg, off2]); off2 += L(n) } }
      else { let off2 = 0; for (const n of sq) { setk(n, [-1, off2]); off2 += L(n) } }
      continue
    }
    let seg = -1, off2 = 0
    for (const n of sq) { const l = L(n); if (invNodes.has(n)) { seg = seg_pos.get(n)!; off2 = 0; setk(n, [seg, -1]); off2 += l; continue } setk(n, [seg, off2]); off2 += l }
  }
  const bykey = new Map<string, { key: [number, number]; ns: string[] }>()
  for (const n of alln) { const key = keyof.get(n) ?? [-2, idn(n)]; const ks = key[0] + '|' + key[1]; if (!bykey.has(ks)) bykey.set(ks, { key, ns: [] }); bykey.get(ks)!.ns.push(n) }
  const groups: string[][] = []
  for (const { ns } of [...bykey.values()].sort((a, b) => cmpPy(a.key, b.key))) {
    const members = [...ns].sort((a, b) => present.get(b)!.size - present.get(a)!.size)
    const pools: [string[], Set<number>][] = []
    for (const n of members) { let put = false
      for (const pl of pools) { let dis = true; for (const x of present.get(n)!) if (pl[1].has(x)) { dis = false; break }
        if (dis && L(n) === L(pl[0][0])) { pl[0].push(n); for (const x of present.get(n)!) pl[1].add(x); put = true; break } }
      if (!put) pools.push([[n], new Set(present.get(n)!)]) }
    for (const pl of pools) groups.push(pl[0])
  }
  const gidx = new Map<string, number>(); groups.forEach((g_, gi_) => { for (const n_ of g_) if (!gidx.has(n_)) gidx.set(n_, gi_) })
  const copies_after = new Map<number, [number, string][]>()
  const lisLen = (v: number[]) => { const t_: number[] = []; for (const x of v) { const k_ = bisectLeft(t_, x); if (k_ === t_.length) t_.push(x); else t_[k_] = x } return t_.length }
  if (craw !== raw) for (const r of raw) {
    if (!r.rdinfo) continue
    const g_ = (r.seq as string[]).filter(n_ => gidx.has(n_)).map(n_ => gidx.get(n_)!)
    if (lisLen([...g_].reverse()) <= lisLen(g_)) continue
    const L_ = r.seq.length; r.seq = [...r.seq].reverse(); r.seqn = [...r.seqn].reverse(); r.occ_st = [...r.occ_st].reverse()
    r.occ_inv = [...r.occ_inv].reverse().map((x: boolean) => !x); r.occ0 = [...r.occ0].reverse().map((x: string) => rc(x)); normRow(r)
    r.strand = r.strand === '-' ? '+' : '-'; r.ends = [...r.ends].reverse()
    r.rins = (r.rins || []).map(([n_, k_, q_, i_]: any[]) => [n_, k_, q_, L_ - 1 - i_])
    const fo = new Map<string, number>(); (r.seq as string[]).forEach((n_, q) => { if (!fo.has(n_)) fo.set(n_, q) })
    r.inv = [...fo].filter(([, q]) => r.occ_inv[q]).map(([n_]) => n_)
  }
  const cset = new Set(craw)
  for (const r of [...raw.filter(r => cset.has(r)), ...raw.filter(r => !cset.has(r))]) {
    const mk = cset.has(r)
    const seqi: number[] = []; (r.seq as string[]).forEach((n_, k_) => { if (gidx.has(n_)) seqi.push(k_) }); const seqr = seqi.map(k_ => r.seq[k_] as string); const gl = seqr.map(n_ => gidx.get(n_)!)
    r.occ_at = new Map<string, number>()
    const tails: number[] = [], tidx: number[] = [], prev = new Array(gl.length).fill(-1)
    gl.forEach((v, i_) => { const k_ = bisectLeft(tails, v); if (k_ > 0) prev[i_] = tidx[k_ - 1]; if (k_ === tails.length) { tails.push(v); tidx.push(i_) } else { tails[k_] = v; tidx[k_] = i_ } })
    const keep = new Set<number>(); let k_ = tidx.length ? tidx[tidx.length - 1] : -1; while (k_ >= 0) { keep.add(k_); k_ = prev[k_] }
    r.skip = new Set(); r.cps = new Set(); let anchor = -1, j_ = 0; const kept_g = new Set([...keep].map(q => gl[q]))
    for (let i_ = 0; i_ < seqr.length; i_++) { const n_ = seqr[i_]
      if (keep.has(i_)) { anchor = gl[i_]; j_ = 0; r.occ_at.set('g|' + gl[i_], seqi[i_]); continue }
      const key = `${anchor}|${j_}|${n_}`; j_++
      if (!copies_after.has(anchor)) copies_after.set(anchor, []); const lst = copies_after.get(anchor)!
      if (!lst.some(([a, b]) => a === j_ - 1 && b === n_)) { if (!mk) continue; lst.push([j_ - 1, n_]) }
      r.occ_at.set('c|' + key, seqi[i_]); r.cps.add(key); if (!kept_g.has(gl[i_])) r.skip.add(gl[i_]) }
  }
  const sortCp = (a: [number, string][]) => [...a].sort((x, y) => cmpPy(x, y))
  const final: [string[], string | null, number][] = []
  for (const c_ of sortCp(copies_after.get(-1) ?? [])) final.push([[c_[1]], `-1|${c_[0]}|${c_[1]}`, -1])
  const used_g = new Set<number>(); for (const r of raw) for (const k of r.occ_at.keys()) if (k.startsWith('g|')) used_g.add(Number(k.slice(2)))
  groups.forEach((g_, gi_) => { if (used_g.has(gi_)) final.push([g_, null, gi_]); for (const c_ of sortCp(copies_after.get(gi_) ?? [])) final.push([[c_[1]], `${gi_}|${c_[0]}|${c_[1]}`, gi_]) })
  let cols: any[] = []
  for (const [g, cpkey, gorig] of final) {
    const ri = g.findIndex(n => refbp.has(n)); const rb = ri >= 0 ? refbp.get(g[ri])! : null
    let w = 0; for (const n of g) w = Math.max(w, L(n)); if (w === 0) continue
    const meta = { nodes: g, rb, ri: ri >= 0 ? ri : null, nl: w, _cp: cpkey, _g: gorig, cp: cpkey != null ? 1 : 0 }
    const soffs = (k: number) => g.map(n => { const L_ = L(n); return k >= L_ ? -1 : ((rc_votes.get(n) ?? 0) > 0 ? L_ - 1 - k : k) })
    if (w <= CAP) for (let k = 0; k < w; k++) cols.push({ kind: 'base', off: k, so: soffs(k), ...meta })
    else { for (let k = 0; k < HEAD; k++) cols.push({ kind: 'base', off: k, so: soffs(k), ...meta }); cols.push({ kind: 'ell', bp: w, ...meta }); for (let k = w - TAIL; k < w; k++) cols.push({ kind: 'base', off: k, so: soffs(k), ...meta }) }
  }
  prof('列'); for (const c of cols) c._k = c._cp != null ? 'c|' + c._cp : 'g|' + c._g
  const cellchar = (r: any, c: any, which: string, k_: number | undefined): string => { if (k_ == null) return '-'; const s: string = r[which][k_]; if (c.kind === 'ell') return '~'; const k = c.off; return k < s.length ? s[k] : '-' }
  const firstNon = (s: string) => { for (let i = 0; i < s.length; i++) if (s[i] !== '-' && s[i] !== '~') return i; return -1 }
  const lastNon = (s: string) => { for (let i = s.length - 1; i >= 0; i--) if (s[i] !== '-' && s[i] !== '~') return i; return -1 }
  for (const r of raw) {
    const oc_ = cols.map(c => r.occ_at.get(c._k) as number | undefined)
    const sq = cols.map((c, i) => cellchar(r, c, 'occ', oc_[i])).join('')
    const i0 = firstNon(sq); if (i0 < 0) r.seq = '.'.repeat(sq.length); else { const i1 = lastNon(sq); r.seq = '.'.repeat(i0) + sq.slice(i0, i1 + 1) + '.'.repeat(sq.length - i1 - 1) }
    const sqt = cols.map((c, i) => cellchar(r, c, 'occ0', oc_[i])).join(''); const j0 = firstNon(sqt)
    r.seqt = j0 < 0 ? '.'.repeat(sqt.length) : ('.'.repeat(j0) + sqt.slice(j0, lastNon(sqt) + 1)).padEnd(sqt.length, '.')
  }
  if (cols.length) {
    let t0 = 0; const hraw = raw.filter(r => !r.rdinfo)
    while (t0 < Math.min(40, cols.length - 1) && hraw.some(r => r.seq[t0] === '.' && !r.ends[0])) t0++
    let t1 = cols.length
    while (t1 - 1 > t0 && cols.length - t1 < 40 && hraw.some(r => r.seq[t1 - 1] === '.' && !r.ends[1])) t1--
    if (t0 || t1 < cols.length) { cols = cols.slice(t0, t1); for (const r of raw) { r.seq = r.seq.slice(t0, t1); r.seqt = r.seqt.slice(t0, t1) } }
  }
  const leafset = new Set(leaves)
  const isVar = (ci: number) => { const vals = new Set<string>(); for (const r of raw) if (!r.rdinfo) vals.add(r.seq[ci]); vals.delete('~'); vals.delete('.'); return vals.size > 1 }
  const intidx: number[] = []; cols.forEach((c, ci) => { if ((c.nodes as string[]).some(n => leafset.has(n))) intidx.push(ci) })
  let a: number, b: number
  // intidx・varidx は列の順に積むので先頭が最小・末尾が最大（11-12: Math.min(...a) は列が十数万を超えると呼び出しの段数あふれで落ちた。全ゲノム BRCA2 の 2 kb 窓）
  if (intidx.length) { a = Math.max(0, intidx[0] - 3); b = Math.min(cols.length, intidx[intidx.length - 1] + 4) }
  else { const varidx: number[] = []; cols.forEach((c, ci) => { if (c.variant || isVar(ci)) varidx.push(ci) }); [a, b] = varidx.length ? [Math.max(0, varidx[0] - 3), Math.min(cols.length, varidx[varidx.length - 1] + 4)] : [0, cols.length] }
  const max_cols = opt.cap === 0 ? 0 : MAX_COLS
  if (max_cols && b - a > max_cols) b = a + max_cols
  cols = cols.slice(a, b); for (const r of raw) { r.seq = r.seq.slice(a, b); r.seqt = r.seqt.slice(a, b) }
  cols.forEach((c, ci) => { const vals = new Set<string>(); for (const r of raw) if (!r.rdinfo) vals.add(r.seq[ci]); vals.delete('~'); vals.delete('.'); c.variant = !!c.variant || vals.size > 1 })
  for (const r of raw) r._oc = cols.map(c => r.occ_at.get(c._k) as number | undefined)
  // リードの、列に置かれなかった通過（株より多い周回・株に無い経路）を連なりごとに 1 つの印にする（10-29）
  for (const r of raw) {
    if (!r.rdinfo) continue
    const placed = new Map<number, [number, number]>(); r._oc.forEach((k_: number | undefined, ci: number) => { if (k_ != null) { if (!placed.has(k_)) placed.set(k_, [ci, ci]); placed.get(k_)![1] = ci } })
    const sq_: string[] = r.seqn; let i = 0; const ext: any[] = []
    if (!placed.size) continue
    const pk = [...placed.keys()].sort((x, y) => x - y); const lo_k = pk[0], hi_k = pk[pk.length - 1]
    while (i < sq_.length) {
      if (placed.has(i) || i < lo_k || i > hi_k) { i++; continue }
      let j = i; while (j < sq_.length && !placed.has(j)) j++
      const bases = (r.occ0 as string[]).slice(i, j).join('').replace(/-/g, '').replace(/\./g, '')
      if (bases) { let prv: number | null = null, nxt: number | null = null; for (const q of placed.keys()) { if (q < i && (prv == null || q > prv)) prv = q; if (q >= j && (nxt == null || q < nxt)) nxt = q }
        const [ci, side] = prv != null ? [placed.get(prv)![1], 1] : [placed.get(nxt!)![0], 0]
        const nn = sq_.slice(i, j); const kind = nn.every(n => gidx.has(n)) ? '株より多い周回' : '株に無い経路'
        ext.push([ci, side, bases, `${kind}（ノード ${nn.length} 個: ${nn.slice(0, 4).join(' ')}${nn.length > 4 ? ' …' : ''}）`]) }
      i = j
    }
    r.rext = ext
  }
  // リードだけの挿入を列に対応させる: 格納向きの塩基 k-1 と k の間 → その 2 列の境界。片方しか無いときはある方の列の端
  if (raw.some(r => r.rins && r.rins.length)) for (const r of raw) {
    if (!r.rins || !r.rins.length) continue
    const so_at = new Map<string, number>()
    cols.forEach((c, ci) => { const q_ = r._oc[ci]; if (q_ == null) return
      (c.nodes as string[]).forEach((n, j) => { const so_ = c.so; const v = so_ && j < so_.length ? so_[j] : null
        if (c.kind === 'ell') { const k = `${q_}|${n}|ell`; if (!so_at.has(k)) so_at.set(k, ci) } else if (v != null && v >= 0) so_at.set(`${q_}|${n}|${v}`, ci) }) })
    const out_: any[] = []
    for (const [n0, k, sq_, q_] of r.rins as [string, number, string, number][]) {
      const g = (kk: number | string) => so_at.get(`${q_}|${n0}|${kk}`)
      const a_ = g(k - 1), b_ = g(k); let ci: number, side: number
      if (a_ != null && b_ != null) { ci = Math.max(a_, b_); side = 0 }
      else if (b_ != null) { ci = b_; side = (g(k + 1) ?? b_ + 1) > b_ ? 0 : 1 }
      else if (a_ != null) { ci = a_; side = (g(k - 2) ?? a_ - 1) < a_ ? 1 : 0 }
      else if (g('ell') != null) { ci = g('ell')!; side = 2 }
      else continue
      if (r.seq[ci] === '.') continue
      out_.push([ci, side, sq_])
    }
    r.rins = out_
  }
  let gseq = -1; let lastKey: string | null = null
  for (const c of cols) { const key = JSON.stringify(c.nodes); if (lastKey !== key) { gseq++; lastKey = key } c.g = gseq }
  const invcols = (r: any) => { const out_: number[][] = []; let st_: number | null = null
    cols.forEach((c, ci) => { const k_ = r._oc[ci]; const f_ = k_ != null && (r.occ_inv[k_] !== ((rc_votes.get(r.seqn[k_]) ?? 0) > 0)); if (f_ && st_ == null) st_ = ci; if (!f_ && st_ != null) { out_.push([st_, ci - 1]); st_ = null } })
    if (st_ != null) out_.push([st_, cols.length - 1]); return out_ }
  // コンティグの主な向きと逆に通る行（cflip）: 行が塩基を持つ列の最初から最後までを 1 本の逆位の帯に
  const ctgInvCols = (r: any) => { let a = -1, b = -1; cols.forEach((_c, ci) => { if (r._oc[ci] != null) { if (a < 0) a = ci; b = ci } }); return a >= 0 ? [[a, b]] : [] }
  const invmaj = (r: any) => { const iv = new Set(r.inv); return [...r.cells.keys()].filter((n: string) => iv.has(n) !== ((rc_votes.get(n) ?? 0) > 0)) }
  const ord = raw.map((_, i) => i).sort((i, j) => cmpPy([!raw[i].isref, raw[i].seq, raw[i].label], [!raw[j].isref, raw[j].seq, raw[j].label]) || i - j)
  const rows2 = ord.map(i => raw[i])
  const aid = new Map<string, number>(); let nu = 0; for (const r of rows2) { if (!aid.has(r.seq)) aid.set(r.seq, nu++); r.allele = aid.get(r.seq) }
  const anc = cols.filter(c => c.rb).map(c => [c.rb, c.nodes]); let refname: string | null = null; let minA: any = null
  for (const x of anc) if (minA == null || cmpPy(x, minA) < 0) minA = x
  if (minA) { const n_ = (minA[1] as string[]).find(n => refcid.has(n)); if (n_ != null) { const rr = con.prepare('SELECT name FROM ref_contigs WHERE contig_id=?').get(refcid.get(n_)) as { name: string } | undefined; refname = rr ? rr.name : null } }
  const pick = (c: any) => { const o: any = {}; for (const k of ['kind', 'nodes', 'g', 'rb', 'variant', 'off', 'bp', 'so', 'nl', 'cp', 'ri']) if (k in c) o[k] = c[k]; return o }
  return { name: label, bp: minA ? minA[0] : null, refname, nrow: rows2.length, nallele: nu, scan: { leaves: leaves.length, contigs: pis.length, tokens: ntokAll },
    cols: cols.map(pick),
    rows: rows2.map(r => ({ samp: r.samp, label: r.label, path: r.path, strand: r.strand, seq: r.seq, isref: r.isref, allele: r.allele, inv: invmaj(r), invc: r.cflip ? ctgInvCols(r) : invcols(r), cinv: !!r.cflip, hseq: r.hseq ?? '', read: r.rdinfo,
      rins: r.rdinfo ? (((r.rins || []).concat(r.rext || [])).length ? (r.rins || []).concat(r.rext || []) : null) : null, seqt: r.seqt !== r.seq ? r.seqt : null, ends: r.ends ?? [false, false], brk: r.brk ?? [] })) }
}
