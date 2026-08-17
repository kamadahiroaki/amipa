// §8.2 Phase 2: アノテ着色(band/region/gene 密度)をサーバ側で再現する。
// ★色定義は frontend/src/annotColors.ts と frontend の GraphCanvas(bandToColor/regionToColor/
//   geneCountToColor/darken/lerpColor)が正本。ここはその移植(headless 経路用)。片方を変えたら両方直す。
//   （幾何/シリアライザは svgSerialize に一元化済だが、色は frontend 辞書取得と密結合のため当面二重。）
import type Database from 'better-sqlite3'
import type { LegendSection } from './svgSerialize'

const GIE_COLORS: Record<string, number> = {
  gneg: 0xf1f3f5, gpos25: 0xced4da, gpos50: 0x868e96, gpos75: 0x495057, gpos100: 0x212529,
  acen: 0xe03131, gvar: 0x63e6be, stalk: 0x74c0fc,
}
export function stainToColor(stain: string | undefined): number {
  return (stain && GIE_COLORS[stain]) || 0xadb5bd
}
export function hexCss(c: number): string { return '#' + (c & 0xffffff).toString(16).padStart(6, '0') }
export function darken(c: number, f = 0.55): number {
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff
  return (Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f)
}
function lerpColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff
  const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff
  return ((Math.round(r1 + (r2 - r1) * t) << 16) |
          (Math.round(g1 + (g2 - g1) * t) << 8) |
           Math.round(b1 + (b2 - b1) * t))
}
const GENE_DENSITY_LOW = 0xd0bfff, GENE_DENSITY_HIGH = 0x5f3dc4
const GENE_DENSITY_REF = 60, GENE_SPAN_FLOOR = 500000
function geneCountToColor(gc: number | undefined | null, bp?: number | null, bpe?: number | null): number {
  if (!gc || gc <= 0) return 0xf3f0ff
  const span = (bp != null && bpe != null && bpe > bp) ? (bpe - bp) : GENE_SPAN_FLOOR
  const perMb = gc / (Math.max(span, GENE_SPAN_FLOOR) / 1e6)
  const t = Math.log(perMb + 1) / Math.log(GENE_DENSITY_REF + 1)
  return lerpColor(GENE_DENSITY_LOW, GENE_DENSITY_HIGH, Math.min(Math.max(t, 0), 1))
}

export type AnnotMode = 'none' | 'band' | 'region' | 'gene'

export interface BandEntry { band_id: number; name: string; gie_stain: string }
export interface RegionEntry { region_id: number; name: string }
export interface AnnotDicts {
  band: Map<number, BandEntry>
  region: Map<number, RegionEntry>
  maxGeneCount: number
}

// annot 表の schema 修飾子(main か ATTACH した sidecar か)を検出。無ければ null。
function annotQual(d: Database.Database): string {
  for (const q of ['', 'an.']) {
    try { d.prepare(`SELECT 1 FROM ${q}band_dict LIMIT 1`).get(); return q } catch { /* 次 */ }
    try { d.prepare(`SELECT 1 FROM ${q}region_dict LIMIT 1`).get(); return q } catch { /* 次 */ }
    try { d.prepare(`SELECT 1 FROM ${q}node_annot LIMIT 1`).get(); return q } catch { /* 次 */ }
  }
  return ''
}

// /annot_dicts と同じ表から band/region 辞書と gene 密度上限を読む。無い表は空(=graceful)。
export function loadAnnotDicts(d: Database.Database): AnnotDicts {
  const AQ = annotQual(d)
  const band = new Map<number, BandEntry>()
  const region = new Map<number, RegionEntry>()
  try {
    for (const r of d.prepare(`SELECT band_id, name, gie_stain FROM ${AQ}band_dict`).all() as any[])
      band.set(r.band_id, { band_id: r.band_id, name: r.name, gie_stain: r.gie_stain })
  } catch { /* 無ければ空 */ }
  try {
    for (const r of d.prepare(`SELECT region_id, name FROM ${AQ}region_dict`).all() as any[])
      region.set(r.region_id, { region_id: r.region_id, name: r.name })
  } catch { /* 無ければ空 */ }
  let maxGeneCount = 0
  try {
    const m = (d.prepare(`SELECT value AS m FROM ${AQ}annot_meta WHERE key='max_gene_cnt'`).get() as any)?.m
    maxGeneCount = m != null ? Number(m) : (((d.prepare(`SELECT MAX(gene_cnt) AS m FROM ${AQ}node_annot`).get() as any)?.m) ?? 0)
  } catch { maxGeneCount = 0 }
  return { band, region, maxGeneCount }
}

// ノードのアノテ値(band_id/region_class/gene_count)を node_name キーで返す。DB により格納先が違う:
//   旧: node_attr(node_name PK, band_id, gene_count)             ← chrY-annot 等
//   新: node_annot(node_rowid PK, band_id, gene_cnt, region_class) 主 or an. サイドカー
// runQueryJob の annotation 相乗り(nodeAttrSel)は新スキーマ前提なので、ここで自前に検出して引く。
export interface NodeAnnotVal { band_id?: number | null; region_class?: number | null; gene_count?: number | null }
export function fetchNodeAnnotMap(d: Database.Database, nodes: { id?: number; node_name?: string }[]): Map<string, NodeAnnotVal> {
  const out = new Map<string, NodeAnnotVal>()
  const tableExists = (t: string, q = '') => { try { d.prepare(`SELECT 1 FROM ${q}${t} LIMIT 1`).get(); return true } catch { return false } }
  const colsOf = (t: string, q = '') => {
    const s = new Set<string>()
    try { for (const c of d.prepare(`PRAGMA ${q}table_info(${t})`).all() as any[]) s.add(c.name) } catch { /* 無ければ空 */ }
    return s
  }
  const CH = 800

  // 旧: node_attr(node_name PK)
  if (tableExists('node_attr')) {
    const c = colsOf('node_attr')
    const gCol = c.has('gene_count') ? 'gene_count' : c.has('gene_cnt') ? 'gene_cnt' : null
    const sel = ['node_name', c.has('band_id') ? 'band_id' : 'NULL AS band_id',
                 gCol ? `${gCol} AS gene_count` : 'NULL AS gene_count',
                 c.has('region_class') ? 'region_class' : 'NULL AS region_class'].join(', ')
    const names = nodes.map(n => n.node_name).filter(Boolean) as string[]
    for (let i = 0; i < names.length; i += CH) {
      const ch = names.slice(i, i + CH)
      const rows = d.prepare(`SELECT ${sel} FROM node_attr WHERE node_name IN (${ch.map(() => '?').join(',')})`).all(...ch) as any[]
      for (const r of rows) out.set(r.node_name, { band_id: r.band_id, region_class: r.region_class, gene_count: r.gene_count })
    }
    return out
  }

  // 新: node_annot(node_rowid PK) 主 or an. サイドカー
  const AQ = annotQual(d)
  if (tableExists('node_annot', AQ)) {
    const c = colsOf('node_annot', AQ)
    const gCol = c.has('gene_cnt') ? 'gene_cnt' : c.has('gene_count') ? 'gene_count' : null
    const sel = ['node_rowid', c.has('band_id') ? 'band_id' : 'NULL AS band_id',
                 gCol ? `${gCol} AS gene_count` : 'NULL AS gene_count',
                 c.has('region_class') ? 'region_class' : 'NULL AS region_class'].join(', ')
    const byRowid = new Map<number, string>()
    for (const n of nodes) if (n.id != null && n.node_name) byRowid.set(n.id, n.node_name)
    const ids = [...byRowid.keys()]
    for (let i = 0; i < ids.length; i += CH) {
      const ch = ids.slice(i, i + CH)
      const rows = d.prepare(`SELECT ${sel} FROM ${AQ}node_annot WHERE node_rowid IN (${ch.map(() => '?').join(',')})`).all(...ch) as any[]
      for (const r of rows) { const nm = byRowid.get(r.node_rowid); if (nm) out.set(nm, { band_id: r.band_id, region_class: r.region_class, gene_count: r.gene_count }) }
    }
  }
  return out
}

// 1 ノードの着色 [fill, stroke]（css hex）。annot が無い(該当列 null)なら null=既定 haplotype 色に委ねる。
export function nodeAnnotColor(mode: AnnotMode, n: any, dicts: AnnotDicts): { fill: string; stroke: string } | null {
  let c: number | null = null
  if (mode === 'band') {
    if (n.band_id == null) return null
    const e = dicts.band.get(n.band_id); c = e ? stainToColor(e.gie_stain) : 0xadb5bd
  } else if (mode === 'region') {
    if (n.region_class == null) return null
    const e = dicts.region.get(n.region_class); c = e ? stainToColor(e.name) : 0xadb5bd
  } else if (mode === 'gene') {
    c = geneCountToColor(n.gene_count, n.ref_bp, n.ref_bp_end)
  }
  if (c == null) return null
  return { fill: hexCss(c), stroke: hexCss(darken(c)) }
}

// 凡例セクション(GraphCanvas.exportSvg の凡例と同じ内容)。band=可視ノードに現れた GIE ステインだけ、
// region=現れた region 名(最大14)、gene=密度グラデ。可視ノード集合は nodesIn+amap から判定。
export function buildAnnotLegend(
  mode: AnnotMode, nodesIn: { node_name?: string }[],
  amap: Map<string, NodeAnnotVal>, dicts: AnnotDicts,
): LegendSection[] {
  if (mode === 'band') {
    const present = new Set<string>()
    for (const n of nodesIn) {
      const a = n.node_name ? amap.get(n.node_name) : undefined
      if (a?.band_id != null) { const e = dicts.band.get(a.band_id); if (e?.gie_stain) present.add(e.gie_stain) }
    }
    const items = Object.keys(GIE_COLORS).filter(s => present.has(s))
      .map(s => ({ color: hexCss(GIE_COLORS[s]), stroke: hexCss(darken(GIE_COLORS[s])), label: s }))
    return items.length ? [{ caption: 'cytoBand stain', items }] : []
  }
  if (mode === 'region') {
    const nm = new Set<string>()
    for (const n of nodesIn) {
      const a = n.node_name ? amap.get(n.node_name) : undefined
      if (a?.region_class != null) { const e = dicts.region.get(a.region_class); if (e?.name) nm.add(e.name) }
    }
    const items = [...nm].slice(0, 14).map(name => {
      const c = stainToColor(name); return { color: hexCss(c), stroke: hexCss(darken(c)), label: name }
    })
    return items.length ? [{ caption: 'region class', items }] : []
  }
  if (mode === 'gene') {
    return [{ caption: 'gene density (genes/Mb)', items: [], gradient: { lo: hexCss(GENE_DENSITY_LOW), hi: hexCss(GENE_DENSITY_HIGH) } }]
  }
  return []
}
