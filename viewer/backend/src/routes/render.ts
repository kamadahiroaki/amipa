// §8.2 ヘッドレス グラフ図版レンダラ(エンドポイント)。ブラウザを介さず SVG を返す。
// 例: /api/render?db=chrY-annot.layered.db&layer=6&cx=0.5&cy=0.5&vw=0.3&edge=paths&maxHb=10
// CLI(render-cli.ts)も同じ renderGraphSvg を呼ぶ。
import { Router } from 'express'
import { getDb } from '../db'
import { renderGraphSvg } from '../figure/graphDrawList'
import { EdgeWidthMode } from '../figure/svgSerialize'
import { AnnotMode } from '../figure/annotColorize'

export const renderRouter = Router()

function num(v: string | undefined, d: number): number {
  return v != null && v !== '' && isFinite(Number(v)) ? Number(v) : d
}

renderRouter.get('/render', (req, res) => {
  const q = req.query as Record<string, string>
  const db = q.db
  if (!db) { res.status(400).json({ error: 'missing db' }); return }
  const vw = num(q.vw, 1)
  const mode = (['off', 'paths', 'reads'].includes(q.edge) ? q.edge : 'off') as EdgeWidthMode
  const annot = (['none', 'band', 'region', 'gene'].includes(q.annot) ? q.annot : 'none') as AnnotMode
  try {
    const svg = renderGraphSvg(getDb(db), db, {
      layer: num(q.layer, 0),
      cx: num(q.cx, 0.5), cy: num(q.cy, 0.5), vw, vh: num(q.vh, vw * 0.618),
      zoomPx: num(q.zoomPx, 1600), nodeScale: num(q.nodeScale, 1),
      edgeWidthMode: mode, annot, showRefPos: q.refpos === '1' || q.refpos === 'true',
      bandLabels: q.bandLabels === '1', regionLabels: q.regionLabels === '1',
      maxHb: num(q.maxHb, 0), maxEdgePx: num(q.maxEdgePx, 12),
      maxEdgeReads: num(q.maxEdgeReads, 0), edgeMin: num(q.edgeMin, 0),
      mapq: num(q.mapq, 0), widthMm: num(q.widthMm, 180),
    })
    if (q.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="ggb_figure.svg"')
    res.type('image/svg+xml').send(svg)
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})
