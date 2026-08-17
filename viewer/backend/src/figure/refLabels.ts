// §8.2 Phase 2: 参照座標(ref bp)ラベルをサーバ側で再現する。
// ★正本は GraphCanvas.tsx の showRefPos ブロック(per-contig 目盛り→最寄りノードにスナップ→画面間引き→
//   2段階 round-robin 配分＝小コンティグの starvation 回避)。ここはその移植(figure 座標で計算)。
// ラベルは figure 座標に置く。画面px 基準の間引き閾値(MINPX 等)は s2f=FIG_SCALE/zoomPx で figure 単位へ換算。
import { FIG_SCALE, FigLabel, FigMark } from './svgSerialize'

// A2 ルーラ: 目標間隔 raw(bp) 以上で最も近い 1/2/5×10ⁿ ステップ。
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const base = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * base >= raw) return m * base
  return 10 * base
}
// 丸め目盛り値 → 短い単位付き(12.5 Mb 等)。name があれば "name:" を前置(多コンティグ時)。
function fmtRuler(bp: number, name?: string): string {
  const a = Math.abs(bp)
  const [v, unit] = a >= 1e6 ? [bp / 1e6, 'Mb'] : a >= 1e3 ? [bp / 1e3, 'kb'] : [bp, 'bp']
  const s = v.toFixed(3).replace(/\.?0+$/, '')
  return `${name ? name + ':' : ''}${s} ${unit}`
}

export interface RefLabelOpts {
  vpX1: number; vpY1: number; vpX2: number; vpY2: number
  zoomPx: number; nodeScale: number
  contigNames?: Map<number, string>   // ref_contig_id → name(多コンティグ時のみ前置)。名前ラベルでは未使用。
}

export function buildRefBpLabels(nodesIn: any[], o: RefLabelOpts): { labels: FigLabel[]; marks: FigMark[] } {
  const W = o.vpX2 - o.vpX1
  if (!(W > 0)) return { labels: [], marks: [] }
  const k = FIG_SCALE / W, zoom = o.zoomPx / W, s2f = FIG_SCALE / o.zoomPx
  const px = (x: number) => (x - o.vpX1) * k, py = (y: number) => (y - o.vpY1) * k
  const nodeScl = o.nodeScale, minW = 3 / zoom
  const MINPX = 110 * s2f, PER_CONTIG = 10, GLOBAL = 32, TARGET = 18, GUARANTEE = 32 * s2f

  type Cand = { s: number; e: number; mid: number; anchor: boolean; x: number; y: number; wx: number; wy: number; a: number; strand: number }
  const groups = new Map<number, Cand[]>()
  for (const n of nodesIn) {
    if (n.ref_bp == null) continue
    const w = Math.max(n.radius * 2 * nodeScl, minW), bound = w / 2 * 1.4
    if (n.xCoord + bound < o.vpX1 || n.xCoord - bound > o.vpX2) continue
    if (n.yCoord + bound < o.vpY1 || n.yCoord - bound > o.vpY2) continue
    const s = Number(n.ref_bp), e = n.ref_bp_end != null ? Number(n.ref_bp_end) : s
    const cid = Number(n.ref_contig_id)
    const cand: Cand = { s, e, mid: (s + e) / 2, anchor: !!n.is_anchor, x: px(n.xCoord), y: py(n.yCoord),
                         wx: n.xCoord, wy: n.yCoord, a: n.angle, strand: n.ref_strand == null ? 1 : Number(n.ref_strand) }
    const arr = groups.get(cid); if (arr) arr.push(cand); else groups.set(cid, [cand])
  }
  const multiContig = groups.size > 1

  type Lab = { m: number; x: number; y: number; name?: string; wx: number; wy: number; a: number; strand: number }
  const perContig: Lab[][] = []
  for (const [cid, arr] of groups) {
    let bpMin = Infinity, bpMax = -Infinity
    for (const a of arr) { if (a.mid < bpMin) bpMin = a.mid; if (a.mid > bpMax) bpMax = a.mid }
    const step = Math.max(niceStep((bpMax - bpMin) / TARGET), 1)
    const name = multiContig ? o.contigNames?.get(cid) : undefined
    const buckets = new Map<number, { m: number; x: number; y: number; dist: number; anchor: boolean; wx: number; wy: number; a: number; strand: number }>()
    for (const a of arr) {
      if (a.e - a.s > step * 1.5) continue
      const m = Math.round(a.mid / step) * step
      const d = Math.abs(a.mid - m)
      const prev = buckets.get(m)
      if (!prev || d < prev.dist || (d === prev.dist && a.anchor && !prev.anchor))
        buckets.set(m, { m, x: a.x, y: a.y, dist: d, anchor: a.anchor, wx: a.wx, wy: a.wy, a: a.a, strand: a.strand })
    }
    const cand = [...buckets.values()].sort((p, q) => p.x - q.x)
    if (!cand.length) {
      const midBp = (bpMin + bpMax) / 2
      let best = arr[0]
      for (const a of arr) if (Math.abs(a.mid - midBp) < Math.abs(best.mid - midBp)) best = a
      perContig.push([{ m: Math.round(best.mid / step) * step, x: best.x, y: best.y, name, wx: best.wx, wy: best.wy, a: best.a, strand: best.strand }])
      continue
    }
    const kept: typeof cand = []
    for (const l of cand) if (kept.every(kk => (kk.x - l.x) ** 2 + (kk.y - l.y) ** 2 >= MINPX * MINPX)) kept.push(l)
    let sel = kept
    if (kept.length > PER_CONTIG) {
      sel = []
      for (let i = 0; i < PER_CONTIG; i++) sel.push(kept[Math.round(i * (kept.length - 1) / (PER_CONTIG - 1))])
    }
    const ordered = sel.length <= 2 ? sel : [sel[0], sel[sel.length - 1], ...sel.slice(1, -1)]
    perContig.push(ordered.map(l => ({ m: l.m, x: l.x, y: l.y, name, wx: l.wx, wy: l.wy, a: l.a, strand: l.strand })))
  }

  const labels: FigLabel[] = [], marks: FigMark[] = []
  const placed: { x: number; y: number }[] = []
  let drawn = 0
  const fs = 11 * s2f
  const halo = ` stroke="#ffffff" stroke-width="${(fs * 0.3).toFixed(3)}" paint-order="stroke"`
  const al = 9 * s2f, aw = 5 * s2f
  const emitLabel = (l: Lab) => {
    placed.push({ x: l.x, y: l.y }); drawn++
    labels.push({ x: l.x, y: l.y, text: fmtRuler(l.m, l.name), fs, fill: '#0b5394', anchor: 'middle', baseline: 'text-after-edge', halo })
    // ref 方向矢印(ノード軸 a に沿い strand 向き): figure 座標で三角形。
    const sgn = l.strand === 0 ? -1 : 1
    const ux = Math.cos(l.a) * sgn, uy = Math.sin(l.a) * sgn, qx = -uy, qy = ux
    const fx = px(l.wx), fy = py(l.wy)
    marks.push({ fill: '#0b5394', opacity: 0.95, pts: [
      { x: fx + ux * al, y: fy + uy * al },
      { x: fx - ux * al + qx * aw, y: fy - uy * al + qy * aw },
      { x: fx - ux * al - qx * aw, y: fy - uy * al - qy * aw },
    ] })
  }
  // ① 各コンティグの端ラベルを緩ガードで確保(starvation 回避)。
  const G2 = GUARANTEE * GUARANTEE
  for (const list of perContig) {
    if (drawn >= GLOBAL) break
    const l = list[0]; if (!l) continue
    if (placed.every(p => (p.x - l.x) ** 2 + (p.y - l.y) ** 2 >= G2)) emitLabel(l)
  }
  // ② 残りを通常 MINPX で round-robin。
  for (let round = 1, active = true; active && drawn < GLOBAL; round++) {
    active = false
    for (const list of perContig) {
      if (round >= list.length) continue
      active = true
      if (drawn >= GLOBAL) break
      const l = list[round]
      if (!placed.every(p => (p.x - l.x) ** 2 + (p.y - l.y) ** 2 >= MINPX * MINPX)) continue
      emitLabel(l)
    }
  }
  return { labels, marks }
}

// band/region の「名前」ラベル(GraphCanvas.drawKeyLabels の移植)。キー(band_id/region_class)別に
// 可視ノードの world 重心を出し、最寄りノードを代表点に名前ラベルを置く。minpx(画面px)で間引き。
export function buildKeyLabels(
  nodesIn: any[], keyOf: (n: any) => number | null | undefined,
  nameOf: (k: number) => string | undefined, color: string, minpx: number, o: RefLabelOpts,
): FigLabel[] {
  const W = o.vpX2 - o.vpX1
  if (!(W > 0)) return []
  const k = FIG_SCALE / W, zoom = o.zoomPx / W, s2f = FIG_SCALE / o.zoomPx
  const px = (x: number) => (x - o.vpX1) * k, py = (y: number) => (y - o.vpY1) * k
  const nodeScl = o.nodeScale, minW = 3 / zoom
  const inRR = (n: any) => {
    const w = Math.max(n.radius * 2 * nodeScl, minW), b = w / 2 * 1.4
    return !(n.xCoord + b < o.vpX1 || n.xCoord - b > o.vpX2 || n.yCoord + b < o.vpY1 || n.yCoord - b > o.vpY2)
  }
  const cen = new Map<number, { wx: number; wy: number; n: number }>()
  for (const n of nodesIn) {
    const key = keyOf(n); if (key == null || !inRR(n)) continue
    const c = cen.get(key); if (c) { c.wx += n.xCoord; c.wy += n.yCoord; c.n++ } else cen.set(key, { wx: n.xCoord, wy: n.yCoord, n: 1 })
  }
  const rep = new Map<number, { x: number; y: number; d2: number }>()
  for (const n of nodesIn) {
    const key = keyOf(n); if (key == null || !inRR(n)) continue
    const c = cen.get(key)!; const d2 = (n.xCoord - c.wx / c.n) ** 2 + (n.yCoord - c.wy / c.n) ** 2
    const prev = rep.get(key)
    if (!prev || d2 < prev.d2) rep.set(key, { x: px(n.xCoord), y: py(n.yCoord), d2 })
  }
  const placed: { x: number; y: number }[] = []
  const out: FigLabel[] = []
  const mp = minpx * s2f, fs = 11 * s2f
  const halo = ` stroke="#ffffff" stroke-width="${(fs * 0.3).toFixed(3)}" paint-order="stroke"`
  for (const [key, r] of rep) {
    const name = nameOf(key); if (!name) continue
    if (!placed.every(p => (p.x - r.x) ** 2 + (p.y - r.y) ** 2 >= mp * mp)) continue
    placed.push({ x: r.x, y: r.y })
    out.push({ x: r.x, y: r.y - 12 * s2f, text: name, fs, fill: color, anchor: 'middle', baseline: 'central', halo })
  }
  return out
}
