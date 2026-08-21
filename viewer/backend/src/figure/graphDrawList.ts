// §8.2 ヘッドレス グラフ図版レンダラ(サーバ側)。データ取得は既存の runQueryJob(kind:'nodes'/'edges')を
// そのまま再利用する ＝ ブラウザ /nodes /edges と同一 SQL・同一 payload。幾何→SVG は svgSerialize の
// 共有コアに委譲する。∴新規に SQL や幾何を二重実装しない(色/ラベル/凡例の拡張は Phase 2)。
import type Database from 'better-sqlite3'
import { runQueryJob, plainCtx } from '../dbJobs'
import { dbEdgesSigned, rodEndpoint, RodNode } from '../edgeGeom'
import { AnnotMode, loadAnnotDicts, fetchNodeAnnotMap, nodeAnnotColor, buildAnnotLegend } from './annotColorize'
import { buildRefBpLabels, buildKeyLabels } from './refLabels'
import { buildGraphFigure, drawListToSvg, EdgeWidthMode, FigNodeIn, FigEdgeIn, LegendSection, FigLabel, FigMark } from './svgSerialize'

export interface RenderOpts {
  layer: number
  cx: number; cy: number; vw: number; vh: number   // 図版中心と視野(world)。vh は縦視野(=アスペクト)。
  zoomPx?: number        // 想定画面幅(px)。minW/線幅の基準 zoom = zoomPx/vw。既定 1600。
  nodeScale?: number
  edgeWidthMode?: EdgeWidthMode
  annot?: AnnotMode      // ノード着色: none(=haplotype 既定) / band / region / gene 密度
  showRefPos?: boolean   // 参照座標(ref bp)ラベル＋strand 矢印を重畳
  bandLabels?: boolean   // バンド名ラベル(着色モードと独立)
  regionLabels?: boolean // 領域名ラベル(着色モードと独立)
  maxHb?: number; maxEdgePx?: number; maxEdgeReads?: number; edgeMin?: number
  mapq?: number; widthMm?: number
}

export function renderGraphSvg(d: Database.Database, dbName: string, o: RenderOpts): string {
  const vw = o.vw, vh = o.vh
  const x1 = o.cx - vw / 2, x2 = o.cx + vw / 2, y1 = o.cy - vh / 2, y2 = o.cy + vh / 2
  const mapq = o.mapq ?? 0
  const annot: AnnotMode = o.annot ?? 'none'
  const nx = annot === 'none' ? '' : annot   // band/region/gene 列を node fetch に相乗り

  const nodesRes = runQueryJob(d, { kind: 'nodes', db: dbName, layer: o.layer, x1, x2, y1, y2, mapq, maxRows: 0, nx }, plainCtx)
  // nodes 側が層を自動調整して返す場合はそれに合わせて edges を引く(ブラウザと同じ「同一層で両取得」)。
  const L = (typeof nodesRes.layer === 'number' ? nodesRes.layer : o.layer)
  const edgesRes = runQueryJob(d, { kind: 'edges', db: dbName, layer: L, x1, x2, y1, y2, mapq, maxRows: 0 }, plainCtx)

  const nodesIn = (Array.isArray(nodesRes.payload) ? nodesRes.payload : []) as FigNodeIn[]
  const edgesIn = (Array.isArray(edgesRes.payload) ? edgesRes.payload : []) as FigEdgeIn[]

  // signed(座標非保存)スキーマの DB は edges に start_x/end_x を持たない。ns/nt の位置＋符号から
  // 端点を復元する(edgeGeom.rodEndpoint = SQL edgeXYSelect と同一式)。可視ノードで足りない端点
  // (視野を跨ぐ辺の相手側)は nodes(layer_index=L)から補って引く。
  if (edgesIn.length > 0 && dbEdgesSigned(d)) {
    const pos = new Map<string, RodNode>()
    for (const n of nodesIn as any[]) if (n.node_name) pos.set(n.node_name, n)
    const missing = new Set<string>()
    for (const e of edgesIn as any[]) {
      if (!pos.has(e.source)) missing.add(e.source)
      if (!pos.has(e.target)) missing.add(e.target)
    }
    if (missing.size > 0) {
      const names = [...missing], CH = 800
      for (let i = 0; i < names.length; i += CH) {
        const chunk = names.slice(i, i + CH)
        const rows = d.prepare(
          `SELECT node_name, xCoord, yCoord, radius, angle FROM nodes
           WHERE layer_index = ? AND node_name IN (${chunk.map(() => '?').join(',')})`
        ).all(L, ...chunk) as any[]
        for (const r of rows) pos.set(r.node_name, r)
      }
    }
    for (const e of edgesIn as any[]) {
      const ns = pos.get(e.source), nt = pos.get(e.target)
      if (!ns || !nt) continue
      const s = rodEndpoint(ns, nt, e.src_sign ?? 0)
      const t = rodEndpoint(nt, ns, e.tgt_sign ?? 0)
      e.start_x = s.x; e.start_y = s.y; e.end_x = t.x; e.end_y = t.y
    }
  }

  const zoomPx = o.zoomPx ?? 1600
  const rlOpts = { vpX1: x1, vpY1: y1, vpX2: x2, vpY2: y2, zoomPx, nodeScale: o.nodeScale ?? 1 }
  const labels: FigLabel[] = [], labelMarks: FigMark[] = []
  let legend: LegendSection[] | undefined

  // アノテ辞書＋値は「着色」と「名前ラベル」の両方で使うので、どれかが要るとき1回だけ読む。
  const needAnnot = annot !== 'none' || o.bandLabels || o.regionLabels
  if (needAnnot) {
    const dicts = loadAnnotDicts(d)
    const amap = fetchNodeAnnotMap(d, nodesIn as any[])
    // 着色: 該当列 null のノードは未設定＝既定 haplotype 色に委ねる(buildGraphFigure が処理)。
    if (annot !== 'none') {
      for (const n of nodesIn as any[]) {
        const a = amap.get(n.node_name)
        if (!a) continue
        const c = nodeAnnotColor(annot, { ...a, ref_bp: n.ref_bp, ref_bp_end: n.ref_bp_end }, dicts)
        if (c) { n.fill = c.fill; n.stroke = c.stroke }
      }
      legend = buildAnnotLegend(annot, nodesIn as any[], amap, dicts)
    }
    // band/region の「名前」ラベル(着色モードと独立に指定可)。
    if (o.bandLabels)
      labels.push(...buildKeyLabels(nodesIn as any[], n => amap.get(n.node_name)?.band_id,
        k => dicts.band.get(k)?.name, '#862e9c', 80, rlOpts))
    if (o.regionLabels)
      labels.push(...buildKeyLabels(nodesIn as any[], n => amap.get(n.node_name)?.region_class,
        k => dicts.region.get(k)?.name, '#c92a2a', 90, rlOpts))
  }

  // 参照座標(ref bp)ラベル: 可視ノードの ref_bp から目盛りを作り最寄りノードにスナップ(GraphCanvas と同式)。
  if (o.showRefPos && nodesIn.length > 0 && (nodesIn[0] as any).ref_bp !== undefined) {
    const contigNames = new Map<number, string>()
    try {
      for (const r of d.prepare('SELECT contig_id, name FROM ref_contigs').all() as any[]) contigNames.set(r.contig_id, r.name)
    } catch { /* ref_contigs 無し=名前なし */ }
    const rl = buildRefBpLabels(nodesIn as any[], { ...rlOpts, contigNames })
    labels.push(...rl.labels); labelMarks.push(...rl.marks)
  }

  const zoom = zoomPx / vw
  const fig = buildGraphFigure(nodesIn, edgesIn, {
    vpX1: x1, vpY1: y1, vpX2: x2, vpY2: y2,
    zoom, nodeScale: o.nodeScale ?? 1,
    edgeWidthMode: o.edgeWidthMode ?? 'off',
    maxHb: o.maxHb ?? 0, maxEdgePx: o.maxEdgePx ?? 12, maxEdgeReads: o.maxEdgeReads ?? 0, edgeMin: o.edgeMin ?? 0,
    widthMm: o.widthMm, legend, labels, labelMarks,
    stamp: `amipa · ${dbName} · cx=${o.cx.toFixed(6)} cy=${o.cy.toFixed(6)} vw=${vw.toExponential(3)} · layer=${L}${annot !== 'none' ? ` · ${annot}` : ''}`,
  })
  return drawListToSvg(fig)
}
