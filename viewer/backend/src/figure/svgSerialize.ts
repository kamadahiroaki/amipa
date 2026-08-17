// 図版 draw-list とその SVG シリアライザ。★純粋(DOM/Node API 非依存)。
// ねらい(§8.2): グラフ図版の「幾何(ノード5点グリフ・エッジ細線＋太さクアッド)」と「SVG 直列化」を
// framework 非依存の1箇所に置き、browser(exportSvg)と node(headless render)の双方から使えるようにする。
// ＝ headless CLI とインタラクティブ書き出しの二重保守を避けるための共有コア。
// 図版座標: 現ビューポート [vpX1..vpX2]×[vpY1..vpY2] を等方に 0..SCALE(横) へ写す(k=SCALE/W)。
// GraphCanvas.exportSvg の幾何・色・スタイルと一致させてある(将来 exportSvg 側をこれに載せ替える)。

export interface Pt { x: number; y: number }
export interface FigNode { pts: Pt[]; fill: string; stroke: string }
export interface FigEdge { x1: number; y1: number; x2: number; y2: number }
export interface FigQuad { pts: Pt[] }

export interface FigStyle {
  baseStroke: string; baseOpacity: number; edgeStrokeW: number
  quadFill: string; quadOpacity: number
  nodeStrokeW: number
}
// 凡例(右ガター)。スウォッチ列 items か、gene 密度用グラデ gradient のどちらか。色は css hex。
export interface LegendItem { color: string; stroke: string; label: string }
export interface LegendSection { caption: string; items: LegendItem[]; gradient?: { lo: string; hi: string } }
// ラベル(ref bp 目盛り等)と、その付随マーク(strand 矢印)。図版座標で持つ。
export interface FigLabel {
  x: number; y: number; text: string; fs: number; fill: string
  anchor: 'start' | 'middle' | 'end'; baseline: string; halo?: string
}
export interface FigMark { pts: Pt[]; fill: string; opacity?: number }
export interface FigDrawList {
  figW: number; figH: number; widthMm: number   // figW = グラフ本体幅(=SCALE)。凡例は右ガターに追加。
  edges: FigEdge[]; edgeQuads: FigQuad[]; nodes: FigNode[]
  style: FigStyle
  ribbons?: FigMark[]           // パスリボン(塗りクアッド。ブラウザ側のみ生成、backend headless は未対応)
  labels?: FigLabel[]; labelMarks?: FigMark[]
  legend?: LegendSection[]
  stamp: string
}

// --- 入力(データ) ---
export interface FigNodeIn {
  node_name?: string
  xCoord: number; yCoord: number; radius: number; angle: number
  haplotype?: string | null
  fill?: string; stroke?: string   // 明示色(アノテ着色済み)があれば優先。無ければ haplotype 既定色。
}
export interface FigEdgeIn {
  source: string; target: string
  start_x: number; start_y: number; end_x: number; end_y: number
  edge_hb?: number | null; read_support?: number | null
}
export type EdgeWidthMode = 'off' | 'paths' | 'reads'

export const FIG_SCALE = 1000   // 図版横幅(グラフ本体)。graphDrawList のラベル座標計算と共有する。

export interface FigOpts {
  vpX1: number; vpY1: number; vpX2: number; vpY2: number
  zoom: number            // world→screen px 比。minW(=3/zoom)・線幅(1/zoom)の基準。
  nodeScale: number
  edgeWidthMode: EdgeWidthMode
  maxHb: number; maxEdgePx: number; maxEdgeReads: number; edgeMin: number
  widthMm?: number
  ribbons?: FigMark[]
  labels?: FigLabel[]; labelMarks?: FigMark[]
  legend?: LegendSection[]
  stamp: string
}

const SCALE = FIG_SCALE
const NODE_TIP_INSET = 0.3
// haplotype 既定色(GraphCanvas.exportSvg と同一): [fill, stroke]
const HAP: Record<string, [string, string]> = {
  a: ['#4dabf7', '#1864ab'], b: ['#ff8787', '#c92a2a'], m: ['#da77f2', '#862e9c'],
}
const HAP_DEFAULT: [string, string] = ['#228be6', '#1864ab']

// データ＋変換パラメータ → 図版座標の primitive 群。GraphCanvas.exportSvg の各ループと式を一致させる。
export function buildGraphFigure(nodesIn: FigNodeIn[], edgesIn: FigEdgeIn[], o: FigOpts): FigDrawList {
  const W = o.vpX2 - o.vpX1, H = o.vpY2 - o.vpY1
  const k = SCALE / W
  const figH = H * k
  const nodeScl = o.nodeScale, zoom = o.zoom
  const minW = 3 / zoom
  let refRadN = Infinity
  for (const n of nodesIn) { const r = n.radius; if (r > 0 && r < refRadN) refRadN = r }
  const constHalfThick = Math.max((isFinite(refRadN) ? refRadN : 0.001) * 0.35, 1.2 / zoom)
  const px = (x: number) => (x - o.vpX1) * k
  const py = (y: number) => (y - o.vpY1) * k
  const inVp = (x: number, y: number, pad: number) =>
    x + pad >= o.vpX1 && x - pad <= o.vpX2 && y + pad >= o.vpY1 && y - pad <= o.vpY2

  const isBreadth = o.edgeWidthMode === 'paths', isDetail = o.edgeWidthMode === 'reads'
  const mh = o.maxHb, maxPx = o.maxEdgePx, maxRs = o.maxEdgeReads

  const nbn = new Map<string, FigNodeIn>()
  for (const n of nodesIn) if (n.node_name) nbn.set(n.node_name, n)

  const edges: FigEdge[] = [], edgeQuads: FigQuad[] = []
  for (const e of edgesIn) {
    if (isDetail && o.edgeMin > 0 && (e.read_support ?? 0) < o.edgeMin) continue
    const s = nbn.get(e.source), t = nbn.get(e.target)
    const sx = s ? s.xCoord + (e.start_x - s.xCoord) * nodeScl : e.start_x
    const sy = s ? s.yCoord + (e.start_y - s.yCoord) * nodeScl : e.start_y
    const ex = t ? t.xCoord + (e.end_x - t.xCoord) * nodeScl : e.end_x
    const ey = t ? t.yCoord + (e.end_y - t.yCoord) * nodeScl : e.end_y
    if (!inVp(sx, sy, 0) && !inVp(ex, ey, 0)) continue
    edges.push({ x1: px(sx), y1: py(sy), x2: px(ex), y2: py(ey) })
    let halfW = 0
    if (isBreadth && mh > 0 && (e.edge_hb ?? 0) > 0) halfW = Math.min(1, (e.edge_hb ?? 0) / mh) * constHalfThick
    else if (isDetail && maxRs > 0 && (e.read_support ?? 0) > 0)
      halfW = Math.max(1, Math.min(maxPx, ((e.read_support ?? 0) / maxRs) * maxPx)) / (2 * zoom)
    if (halfW > 0) {
      const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy)
      if (len >= 1e-12) {
        const qx = -dy / len * halfW, qy = dx / len * halfW
        edgeQuads.push({ pts: [
          { x: px(sx + qx), y: py(sy + qy) }, { x: px(ex + qx), y: py(ey + qy) },
          { x: px(ex - qx), y: py(ey - qy) }, { x: px(sx - qx), y: py(sy - qy) },
        ] })
      }
    }
  }

  const nodes: FigNode[] = []
  for (const n of nodesIn) {
    const w = Math.max(n.radius * 2 * nodeScl, minW), hw = w / 2, bound = hw * 1.4
    if (!inVp(n.xCoord, n.yCoord, bound)) continue
    const hh = Math.min(constHalfThick, hw), inset = hw * NODE_TIP_INSET
    const cos = Math.cos(n.angle), sin = Math.sin(n.angle), X0 = n.xCoord, Y0 = n.yCoord
    const P = (dx: number, dy: number): Pt => ({ x: px(X0 + cos * dx - sin * dy), y: py(Y0 + sin * dx + cos * dy) })
    const pts = [P(-hw, -hh), P(-hw, hh), P(hw - inset, hh), P(hw, 0), P(hw - inset, -hh)]
    const h = (n.haplotype && HAP[n.haplotype]) ? HAP[n.haplotype] : HAP_DEFAULT
    nodes.push({ pts, fill: n.fill ?? h[0], stroke: n.stroke ?? h[1] })
  }

  const baseStroke = isBreadth ? '#ced4da' : '#adb5bd'
  const baseOpacity = isBreadth ? 0.55 : isDetail ? 0.5 : 0.9
  const quadFill = isBreadth ? '#8ba7c9' : '#adb5bd'
  const quadOpacity = isBreadth ? 0.5 : 0.85
  return {
    figW: SCALE, figH, widthMm: o.widthMm ?? 180,
    edges, edgeQuads, nodes,
    style: {
      baseStroke, baseOpacity, edgeStrokeW: (1 / zoom) * k,
      quadFill, quadOpacity, nodeStrokeW: (0.8 / zoom) * k,
    },
    ribbons: o.ribbons && o.ribbons.length ? o.ribbons : undefined,
    labels: o.labels && o.labels.length ? o.labels : undefined,
    labelMarks: o.labelMarks && o.labelMarks.length ? o.labelMarks : undefined,
    legend: o.legend && o.legend.length ? o.legend : undefined,
    stamp: o.stamp,
  }
}

// 凡例(右ガター)を SVG に。GraphCanvas.exportSvg の凡例と同じ配置・行送り。defs(グラデ)も返す。
function legendSvg(d: FigDrawList, legW: number): { defs: string; body: string } {
  const secs = d.legend
  if (!secs || !secs.length) return { defs: '', body: '' }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const fx = (n: number) => n.toFixed(2)
  const figW = d.figW, figH = d.figH
  const lx = figW + legW * 0.06, lw = legW * 0.88
  // 総行数を先に出し、rowH を「図の高さ(0.96)に収まる値」で上限クランプする。
  // ★複数セクション(cytoBand＋path ribbons 等)や多項目でも凡例が figH を超えてはみ出さない(崩れ防止)。
  // 行数見積り: セクション毎に caption(1 行) + 内容(items 数 or gradient 2.4) + セクション間 gap(0.5)。
  // ★以前は caption が行を消費せず gap も 0.4 しかなく、次セクションの caption が前段最終項目に
  //   重なっていた(ユーザ報告)。caption に 1 行、間に 0.5 行を確保して重なりを解消する。
  let rows = 0.8
  for (const s of secs) rows += 1.5 + (s.gradient ? 2.4 : s.items.length)
  const rowH = Math.min(figH * 0.045, (figH * 0.96) / rows)
  const sw = rowH * 0.85
  const lfs = (rowH * 0.6).toFixed(2)
  const defs: string[] = [], out: string[] = []
  out.push(`<rect x="${fx(lx)}" y="${fx(figH * 0.02)}" width="${fx(lw)}" height="${fx(rowH * rows)}" fill="#ffffff" fill-opacity="0.9" stroke="#dee2e6" stroke-width="${(figW * 0.0008).toFixed(3)}"/>`)
  let yy = figH * 0.02 + rowH
  secs.forEach((s, si) => {
    out.push(`<text x="${fx(lx + sw * 0.4)}" y="${fx(yy)}" font-size="${lfs}" font-family="sans-serif" font-weight="600" fill="#495057">${esc(s.caption)}</text>`)
    yy += rowH                        // caption が 1 行を占有 → 内容は次行から(重なり防止)
    if (s.gradient) {
      const gid = `ggbGrad${si}`
      defs.push(`<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${s.gradient.lo}"/><stop offset="1" stop-color="${s.gradient.hi}"/></linearGradient>`)
      const gx = lx + sw * 0.4, gw = lw - sw * 0.8, gh = rowH * 0.7
      out.push(`<rect x="${fx(gx)}" y="${fx(yy)}" width="${fx(gw)}" height="${fx(gh)}" fill="url(#${gid})" stroke="#dee2e6" stroke-width="${(figW * 0.0006).toFixed(3)}"/>`)
      out.push(`<text x="${fx(gx)}" y="${fx(yy + gh + rowH * 0.7)}" font-size="${lfs}" font-family="sans-serif" fill="#333333">low</text>`)
      out.push(`<text x="${fx(gx + gw)}" y="${fx(yy + gh + rowH * 0.7)}" font-size="${lfs}" font-family="sans-serif" text-anchor="end" fill="#333333">high</text>`)
      yy += rowH * 2.4
    } else {
      for (const it of s.items) {
        out.push(`<rect x="${fx(lx + sw * 0.4)}" y="${fx(yy - sw * 0.75)}" width="${fx(sw)}" height="${fx(sw)}" fill="${it.color}" stroke="${it.stroke}" stroke-width="${(figW * 0.0006).toFixed(3)}"/>`)
        out.push(`<text x="${fx(lx + sw * 1.7)}" y="${fx(yy)}" font-size="${lfs}" font-family="sans-serif" fill="#333333">${esc(it.label)}</text>`)
        yy += rowH
      }
    }
    yy += rowH * 0.5                   // セクション間 gap
  })
  return { defs: defs.join(''), body: out.join('\n') }
}

// draw-list → レイヤ付き SVG(physical 寸法 widthMm)。GraphCanvas.exportSvg の <g id=...> 構成に合わせる。
export function drawListToSvg(d: FigDrawList): string {
  const f = (n: number) => n.toFixed(3)
  const poly = (pts: Pt[]) => pts.map(p => `${f(p.x)},${f(p.y)}`).join(' ')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const legW = d.legend && d.legend.length ? d.figW * 0.2 : 0
  const totalW = d.figW + legW
  const leg = legendSvg(d, legW)
  const mmW = d.widthMm, mmH = mmW * d.figH / totalW
  const fs = (d.figH * 0.02).toFixed(2)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${mmW}mm" height="${mmH.toFixed(2)}mm" viewBox="0 0 ${totalW} ${f(d.figH)}">
${leg.defs ? '<defs>' + leg.defs + '</defs>\n' : ''}<rect id="background" x="0" y="0" width="${totalW}" height="${f(d.figH)}" fill="#ffffff"/>
<g id="edges" fill="none" stroke="${d.style.baseStroke}" stroke-width="${f(d.style.edgeStrokeW)}" stroke-opacity="${d.style.baseOpacity}">
${d.edges.map(e => `<line x1="${f(e.x1)}" y1="${f(e.y1)}" x2="${f(e.x2)}" y2="${f(e.y2)}"/>`).join('\n')}
</g>
<g id="edge-widths" fill="${d.style.quadFill}" fill-opacity="${d.style.quadOpacity}">
${d.edgeQuads.map(q => `<polygon points="${poly(q.pts)}"/>`).join('\n')}
</g>
<g id="nodes" stroke-width="${f(d.style.nodeStrokeW)}" stroke-opacity="0.6" stroke-linejoin="round">
${d.nodes.map(n => `<polygon points="${poly(n.pts)}" fill="${n.fill}" stroke="${n.stroke}"/>`).join('\n')}
</g>
<g id="ribbons">
${(d.ribbons || []).map(m => `<polygon points="${poly(m.pts)}" fill="${m.fill}"${m.opacity != null ? ` fill-opacity="${m.opacity}"` : ''}/>`).join('\n')}
</g>
<g id="labels">
${(d.labelMarks || []).map(m => `<polygon points="${poly(m.pts)}" fill="${m.fill}"${m.opacity != null ? ` fill-opacity="${m.opacity}"` : ''}/>`).join('\n')}
${(d.labels || []).map(L => `<text x="${f(L.x)}" y="${f(L.y)}" font-size="${f(L.fs)}" text-anchor="${L.anchor}" dominant-baseline="${L.baseline}" font-family="monospace" fill="${L.fill}"${L.halo || ''}>${esc(L.text)}</text>`).join('\n')}
</g>
<g id="legend">
${leg.body}
</g>
<g id="frame">
<text x="${(totalW * 0.008).toFixed(2)}" y="${(d.figH - d.figH * 0.012).toFixed(2)}" font-family="sans-serif" font-size="${fs}" fill="#495057">${esc(d.stamp)}</text>
</g>
</svg>
`
}
