// パスの無いグラフで、リードから局所的な歩み（代わりのパス）を作り、Linear の塩基段と同じ形の整列を返す（2026-11-17）。
//   試作と検証は functions/nopath/local_walks.py、結果は amipa-lab/notes/local_walks_from_reads_2026-11-17.md
//   （ecoli50＋MG1655 の 30 範囲: 一致 58%・配列が同じ冗長な道 6%・読み誤りの見込み 31%・別アレル 5%・矛盾 0、辺の不一致 0）。
//   作り方: 種のノードを通るリードのうち、種の両側を最も長く覆う 1 本の前後 radius bp を骨格にする → 骨格のノードを共線に通るリードだけを集める
//   （LIS が自分の通過の 5 割以上。毛玉で別の場所のリードが混ざらないように）→ 骨格の点と点の間をリードの多数の道で置き換えて合意の歩み
//   → 合意と違う道のうち、その区間を通るリードの 2 割以上（かつ 2 本以上）が通るものを追加の歩みに。
//   リードのノードと歩みの対応は「直前の位置より後ろで最も近い出現」（縦列反復の 2 回目の写しを逆戻りと誤らない）。
//   範囲はグラフの距離で広げない（pggb の毛玉で 60 万ノードに膨らんだ）。
import path from 'path'
import { getDbDir } from './db'
import { openDistill, type Distill } from './distill'
import { distillFor } from './routes/bubbleMsa'
import { readsSourceFor, parseGafLine, type ReadsSource } from './msaReads'
import { bubbleMsaRanges } from './msa'

type ON = [number, boolean]   // [GFA の id, 順向きか]
const key = (x: ON) => x[1] ? x[0] : -x[0]
const flip = (w: ON[]): ON[] => w.slice().reverse().map(([n, o]) => [n, !o] as ON)

interface Ctx { dbFile: string; dist: Distill; reads: ReadsSource; idOf: (d: number) => number; denseOf: (g: number) => number; bp: (g: number) => number; seq: (g: number) => string | null }
const ctxCache = new Map<string, Ctx | null>()
function ctxFor(db: string): Ctx | string {
  if (ctxCache.has(db)) { const c = ctxCache.get(db); return c ?? 'distill かリードの索引が無い' }
  const dbPath = path.join(getDbDir(), path.basename(db))
  const dd = distillFor(dbPath); const reads = readsSourceFor(dbPath)
  if (!dd || !reads) { ctxCache.set(db, null); return !dd ? 'distill が無い' : 'リードの索引（.reads）が無い' }
  const dist = openDistill(dd); const idm = dist.idMap(); const bpd = dist.bpOfDense()
  if (!idm || !bpd) { ctxCache.set(db, null); return 'distill の id_map か s_bp が無い' }
  let ident = true; for (let i = 0; i < Math.min(idm.length, 100000); i += 997) if (idm[i] !== i + 1) { ident = false; break }
  const inv = ident ? null : new Map<number, number>(); if (inv) for (let i = 0; i < idm.length; i++) inv.set(idm[i], i + 1)
  const idOf = (d: number) => idm[d - 1] ?? d
  const denseOf = (g: number) => inv ? (inv.get(g) ?? -1) : g
  const c: Ctx = { dbFile: path.basename(db), dist, reads, idOf, denseOf, bp: g => { const d = denseOf(g); return d > 0 ? (bpd[d] || 0) : 0 }, seq: () => null }
  ctxCache.set(db, c); return c
}

function lisIdx(vals: number[]): number[] {
  const tails: number[] = [], tidx: number[] = [], prev = new Array(vals.length).fill(-1)
  vals.forEach((v, k) => { let lo = 0, hi = tails.length; while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < v) lo = m + 1; else hi = m }
    if (lo === tails.length) { tails.push(v); tidx.push(k) } else { tails[lo] = v; tidx[lo] = k } prev[k] = lo ? tidx[lo - 1] : -1 })
  const out: number[] = []; let k = tidx.length ? tidx[tidx.length - 1] : -1; while (k >= 0) { out.push(k); k = prev[k] } return out.reverse()
}
function nxtOcc(occ: Map<number, number[]>, x: ON, last: number): number | null {
  const l = occ.get(key(x)); if (!l) return null; let lo = 0, hi = l.length; while (lo < hi) { const m = (lo + hi) >> 1; if (l[m] <= last) lo = m + 1; else hi = m } return lo < l.length ? l[lo] : null
}

export interface WalksResult { walks: { name: string; nodes: ON[]; reads?: number }[]; stats: Record<string, number>; seedRead: string; error?: string }

/** 種のノード（GFA の id）から局所的な歩みを作る */
export function buildWalks(C: Ctx, seed: number, radius = 10000, maxReads = 800): WalksResult {
  const parsePath = (p: string): ON[] => { const out: ON[] = []; const re = /([<>])(\d+)/g; let m: RegExpExecArray | null; while ((m = re.exec(p))) out.push([Number(m[2]), m[1] === '>']); return out }
  const fetchPaths = (alns: number[]): { name: string; w: ON[] }[] => {
    const info = C.reads.alnInfo(alns); const rows: [number, number, number][] = []; const names: string[] = []
    for (const a of alns) { const i = info.get(a); if (i) { rows.push([i[0], a, i[1]]); names.push(i[2]) } }
    return C.reads.fetchLines(rows).map((ln, k) => { const g = parseGafLine(ln); return { name: g?.read_name ?? names[k], w: g ? parsePath(g.path) : [] } }).filter(r => r.w.length)
  }
  const seedAlns = C.reads.nodeAlnIds(seed).slice(0, maxReads)
  if (!seedAlns.length) return { walks: [], stats: {}, seedRead: '', error: 'このノードを通るリードが無い' }
  const seedReads = fetchPaths(seedAlns)
  // 骨格: 種の両側を最も長く覆うリード（左右の bp の小さい方が最大）
  let best = -1, bestK = -1, bestIdx = -1
  seedReads.forEach((r, k) => { const i = r.w.findIndex(x => x[0] === seed); if (i < 0) return; let lb = 0, rb = 0; for (let t = 0; t < i; t++) lb += C.bp(r.w[t][0]); for (let t = i + 1; t < r.w.length; t++) rb += C.bp(r.w[t][0]); const s = Math.min(lb, rb, radius); if (s > best) { best = s; bestK = k; bestIdx = i } })
  if (bestK < 0) return { walks: [], stats: {}, seedRead: '', error: '種を含むリードの道が読めない' }
  let w0 = seedReads[bestK].w; if (!w0[bestIdx][1]) { w0 = flip(w0); bestIdx = w0.length - 1 - bestIdx }
  let lo = bestIdx, hi = bestIdx, bpL = 0, bpR = 0
  while (lo > 0 && bpL < radius) { lo--; bpL += C.bp(w0[lo][0]) }
  while (hi < w0.length - 1 && bpR < radius) { hi++; bpR += C.bp(w0[hi][0]) }
  const bb = w0.slice(lo, hi + 1)
  const bocc = new Map<number, number[]>(); bb.forEach((x, k) => { const q = key(x); if (!bocc.has(q)) bocc.set(q, []); bocc.get(q)!.push(k) })
  const bset = new Set(bb.map(x => x[0]))
  // 骨格のノードを通るリード（多すぎれば種に近い所から）
  const cand = new Set<number>(); for (let d = 0; d <= Math.max(bestIdx - lo, hi - bestIdx) && cand.size < maxReads; d += Math.max(1, Math.floor(bb.length / 64))) {
    for (const k of [bestIdx - lo - d, bestIdx - lo + d]) { if (k < 0 || k >= bb.length) continue; for (const a of C.reads.nodeAlnIds(bb[k][0])) { cand.add(a); if (cand.size >= maxReads) break } } }
  const all = fetchPaths([...cand])
  const kept: { name: string; seg: ON[]; hk: [number, number][] }[] = []; let other = 0
  for (const r of all) {
    let w = r.w; let f = 0, b = 0; for (const x of w) { if (!bset.has(x[0])) continue; if (bocc.has(key(x))) f++; else b++ } if (b > f) w = flip(w)
    const hits: [number, number][] = []; let last = -1
    w.forEach((x, k) => { let p = nxtOcc(bocc, x, last); if (p == null) p = nxtOcc(bocc, x, -1); if (p != null) { hits.push([k, p]); last = Math.max(last, p) } })
    if (hits.length < 3) { other++; continue }
    const keep = lisIdx(hits.map(h => h[1])); const hk = keep.map(t => hits[t]); const span = hk[hk.length - 1][0] - hk[0][0] + 1
    if (hk.length < 0.5 * span || hk.length < 0.5 * hits.length) { other++; continue }
    kept.push({ name: r.name, seg: w.slice(hk[0][0], hk[hk.length - 1][0] + 1), hk })
  }
  // 合意の歩み: 骨格の点 i から j への道を数え、i から最も支持の多い（次の点、道）へ進む
  const gap = new Map<number, Map<string, { j: number; mid: ON[]; c: number }>>()
  for (const r of kept) { const h0 = r.hk[0][0]
    for (let t = 0; t + 1 < r.hk.length; t++) { const [ka, ba] = r.hk[t], [kb, bb_] = r.hk[t + 1]; const mid = r.seg.slice(ka - h0 + 1, kb - h0); const ks = bb_ + ':' + mid.map(key).join(',')
      let m = gap.get(ba); if (!m) gap.set(ba, m = new Map()); const e = m.get(ks); if (e) e.c++; else m.set(ks, { j: bb_, mid, c: 1 }) } }
  const cons: ON[] = [bb[0]]; let k = 0, fixed = 0
  while (k < bb.length - 1) {
    const m = gap.get(k); let pick: { j: number; mid: ON[]; c: number } | null = null
    if (m) for (const e of m.values()) if (e.j > k && (!pick || e.c > pick.c || (e.c === pick.c && e.j < pick.j))) pick = e
    if (!pick) { cons.push(bb[k + 1]); k++; continue }
    const own = bb.slice(k + 1, pick.j); if (own.map(key).join(',') !== pick.mid.map(key).join(',')) fixed++
    cons.push(...pick.mid, bb[pick.j]); k = pick.j
  }
  // 合意と違う道
  const cocc = new Map<number, number[]>(); cons.forEach((x, t) => { const q = key(x); if (!cocc.has(q)) cocc.set(q, []); cocc.get(q)!.push(t) })
  const alts = new Map<string, { i: number; j: number; mid: ON[]; c: number }>(); const ends: [number, number][] = []
  for (const r of kept) { let last: number | null = null, mid: ON[] = []; let first = -1
    for (const x of r.seg) { const t = nxtOcc(cocc, x, last == null ? -1 : last)
      if (t != null) { if (first < 0) first = t; if (last != null && (mid.length || t !== last + 1)) { const ks = `${last}:${t}:` + mid.map(key).join(','); const e = alts.get(ks); if (e) e.c++; else alts.set(ks, { i: last, j: t, mid, c: 1 }) } last = t; mid = [] }
      else if (last != null) mid.push(x) }
    ends.push([first, last ?? -1]) }
  const seqOf = (w: ON[]) => w.map(([n]) => n).join(',')
  const covering = (i: number, j: number) => ends.filter(([a, b]) => a >= 0 && a <= i && b >= j).length
  const major = [...alts.values()].filter(e => e.j > e.i && e.c >= 2 && e.c >= 0.2 * Math.max(1, covering(e.i, e.j)) && seqOf(e.mid) !== seqOf(cons.slice(e.i + 1, e.j))).sort((a, b) => b.c - a.c)
  const slots: { i: number; j: number; mid: ON[]; c: number }[][] = []
  for (const e of major) { const s = slots.find(sl => sl.every(o => e.j <= o.i || e.i >= o.j)); if (s) s.push(e); else if (slots.length < 7) slots.push([e]) }
  const walks = [{ name: 'consensus', nodes: cons, reads: kept.length }]
  slots.forEach((sl, si) => { const w: ON[] = []; let p0 = 0; for (const e of sl.sort((a, b) => a.i - b.i)) { w.push(...cons.slice(p0, e.i + 1), ...e.mid); p0 = e.j } w.push(...cons.slice(p0)); walks.push({ name: `alt ${si + 1}`, nodes: w, reads: Math.max(...sl.map(e => e.c)) }) })
  let consBp = 0; for (const x of cons) consBp += C.bp(x[0])
  return { walks, seedRead: seedReads[bestK].name, stats: { reads: kept.length, otherLocus: other, fixedInSeed: fixed, alleles: major.length, consensusNodes: cons.length, consensusBp: consBp } }
}

/** 歩みを仮のパスにして、塩基段（bubbleMsaRanges）と同じ形の整列を返す */
export function walksMsa(db: string, seedName: string, opt: { radius?: number; reads?: { max: number; samples?: string[] } | null } = {}): any {
  const C = ctxFor(db); if (typeof C === 'string') return { error: C }
  const seed = Number(String(seedName).replace(/^n/, '')); if (!Number.isFinite(seed) || seed <= 0) return { error: 'ノードの名前が読めない: ' + seedName }
  const t0 = Date.now(); const W = buildWalks(C, seed, opt.radius ?? 10000); if (W.error) return { error: W.error }
  const tW = Date.now() - t0
  // 仮の distill: パス＝歩み（names・off・ntok・pidx・read・readOri だけを bubbleMsaRanges が使う）
  const toks = W.walks.map(w => Float64Array.from(w.nodes.map(([n]) => C.denseOf(n))))
  const oris = W.walks.map(w => Uint8Array.from(w.nodes.map(([, o]) => (o ? 1 : 0))))
  const names = W.walks.map(w => `${w.name}#${w.name === 'consensus' ? 'walk' : 'walk'}`)
  const fake: any = { names, pidx: new Map(names.map((n, i) => [n, i])), off: Int32Array.from(W.walks.map(() => 0)), ntok: (pi: number) => toks[pi].length,
    read: (pi: number, a: number, b: number) => toks[pi].subarray(a, b), readOri: (pi: number, a: number, b: number) => oris[pi].subarray(a, b) }
  const ord = new Map<number, number>(); W.walks[0].nodes.forEach(([n], i) => { const d = C.denseOf(n); if (!ord.has(d)) ord.set(d, i) })
  for (const w of W.walks.slice(1)) { let lastI = -1; w.nodes.forEach(([n]) => { const d = C.denseOf(n); if (ord.has(d)) lastI = ord.get(d)!; else ord.set(d, lastI + 0.5) }) }
  const out = bubbleMsaRanges({ dbFile: C.dbFile, dist: fake, idOf: C.idOf, denseOf: C.denseOf, order: null, orderOf: ds => { const m = new Map<number, number>(); for (const d of ds) m.set(d, ord.get(d) ?? -1); return m }, reads: opt.reads ? C.reads : null },
    { ranges: W.walks.map((w, i) => [i, 0, w.nodes.length, 1]), label: `walks ${seedName}`, reads: opt.reads ?? undefined }, { label: `walks ${seedName}`, flank: 0, cap: 0, maxLeaves: 6000 })
  if (out && !out.error) out.walks = { ...W.stats, seedRead: W.seedRead, nwalks: W.walks.length, msWalks: tW, msTotal: Date.now() - t0 }
  return out
}
