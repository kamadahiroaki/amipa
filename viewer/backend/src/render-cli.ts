// §8.2 ヘッドレス グラフ図版 CLI。ブラウザ無しで SVG を生成する。エンドポイント(routes/render.ts)と
// 同じ renderGraphSvg を呼ぶ ＝ バッチ/CI で図版を量産できる。
// 使い方(backend ディレクトリで):
//   npx ts-node src/render-cli.ts --db chrY-annot.layered.db --layer 6 --cx 0.5 --cy 0.5 --vw 0.3 --out fig.svg
//   [--vh v] [--edge off|paths|reads] [--maxHb n] [--maxEdgeReads n] [--edgeMin n]
//   [--nodeScale s] [--zoomPx px] [--widthMm mm] [--mapq q]
// --out 省略時は stdout に SVG を書く。DB は viewer の DB_DIR から解決(getDb)。
import fs from 'fs'
import { getDb } from './db'
import { renderGraphSvg } from './figure/graphDrawList'
import { EdgeWidthMode } from './figure/svgSerialize'
import { AnnotMode } from './figure/annotColorize'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function num(v: string | undefined, d: number): number {
  return v != null && v !== '' && isFinite(Number(v)) ? Number(v) : d
}

const db = arg('db')
if (!db) { console.error('usage: render-cli --db <name.layered.db> --layer L --cx .. --cy .. --vw .. [--out fig.svg]'); process.exit(1) }
const vw = num(arg('vw'), 1)
const em = arg('edge'); const mode = (['off', 'paths', 'reads'].includes(em || '') ? em : 'off') as EdgeWidthMode
const an = arg('annot'); const annot = (['none', 'band', 'region', 'gene'].includes(an || '') ? an : 'none') as AnnotMode

try {
  const svg = renderGraphSvg(getDb(db), db, {
    layer: num(arg('layer'), 0),
    cx: num(arg('cx'), 0.5), cy: num(arg('cy'), 0.5), vw, vh: num(arg('vh'), vw * 0.618),
    zoomPx: num(arg('zoomPx'), 1600), nodeScale: num(arg('nodeScale'), 1),
    edgeWidthMode: mode, annot, showRefPos: process.argv.includes('--refpos'),
    bandLabels: process.argv.includes('--band-labels'), regionLabels: process.argv.includes('--region-labels'),
    maxHb: num(arg('maxHb'), 0), maxEdgePx: num(arg('maxEdgePx'), 12),
    maxEdgeReads: num(arg('maxEdgeReads'), 0), edgeMin: num(arg('edgeMin'), 0),
    mapq: num(arg('mapq'), 0), widthMm: num(arg('widthMm'), 180),
  })
  const out = arg('out')
  if (out) { fs.writeFileSync(out, svg); console.error(`wrote ${out} (${svg.length} bytes)`) }
  else process.stdout.write(svg)
} catch (e) {
  console.error('render failed:', String(e)); process.exit(1)
}
