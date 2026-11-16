// canvas 2D の描画命令を SVG に書き留める描画先（11-16、Linear の図の書き出し）。
//   Linear の描画（drawCore）が使う命令だけを持つ: 矩形・パス（moveTo/lineTo/bezierCurveTo/rect/arc/closePath）・fill/stroke・文字・
//   破線・切り抜き・save/restore・setTransform/translate。変換は拡大＋平行移動だけ（回転なし）として点に直接掛ける。
//   色は Illustrator・Inkscape で編集しやすいよう #rrggbb と不透明度に分けて書く（rgba()/hsla() を読まない編集ソフトがある）
type M = [number, number, number, number, number, number]
interface St { fillStyle: string; strokeStyle: string; lineWidth: number; globalAlpha: number; font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline; dash: number[]; m: M; groups: number }

const probe = document.createElement('canvas').getContext('2d')!
const colorCache = new Map<string, [string, number]>()
function color(c: string): [string, number] {   // → [#rrggbb, alpha]
  const k = colorCache.get(c); if (k) return k
  probe.fillStyle = '#000'; probe.fillStyle = c; const v = String(probe.fillStyle)
  let out: [string, number] = ['#000000', 1]
  if (v.startsWith('#')) out = [v, 1]
  else { const m = /rgba?\(([^)]+)\)/.exec(v); if (m) { const p = m[1].split(',').map(s => parseFloat(s)); out = ['#' + p.slice(0, 3).map(n => Math.round(n).toString(16).padStart(2, '0')).join(''), p.length > 3 ? p[3] : 1] } }
  colorCache.set(c, out); return out
}
const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c])
const n = (v: number) => Number.isInteger(v) ? String(v) : v.toFixed(2)

export class SvgContext {
  private s: St = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', dash: [], m: [1, 0, 0, 1, 0, 0], groups: 0 }
  private stack: St[] = []
  private out: string[] = []
  private defs: string[] = []
  private d = ''
  private nclip = 0
  constructor(public width: number, public height: number, private fontFamily = 'Arial, Helvetica, sans-serif') {}
  // 状態（canvas と同じ名前のプロパティ）
  get fillStyle() { return this.s.fillStyle } set fillStyle(v: string) { this.s.fillStyle = String(v) }
  get strokeStyle() { return this.s.strokeStyle } set strokeStyle(v: string) { this.s.strokeStyle = String(v) }
  get lineWidth() { return this.s.lineWidth } set lineWidth(v: number) { this.s.lineWidth = v }
  get globalAlpha() { return this.s.globalAlpha } set globalAlpha(v: number) { this.s.globalAlpha = v }
  get font() { return this.s.font } set font(v: string) { this.s.font = v }
  get textAlign() { return this.s.textAlign } set textAlign(v: CanvasTextAlign) { this.s.textAlign = v }
  get textBaseline() { return this.s.textBaseline } set textBaseline(v: CanvasTextBaseline) { this.s.textBaseline = v }
  lineCap: CanvasLineCap = 'butt'; lineJoin: CanvasLineJoin = 'miter'; imageSmoothingEnabled = true
  save() { this.stack.push({ ...this.s, dash: this.s.dash.slice(), m: [...this.s.m] as M, groups: 0 }) }
  restore() { const g = this.s.groups; for (let i = 0; i < g; i++) this.out.push('</g>'); const p = this.stack.pop(); if (p) this.s = p }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.s.m = [a, b, c, d, e, f] }
  resetTransform() { this.s.m = [1, 0, 0, 1, 0, 0] }
  translate(x: number, y: number) { const m = this.s.m; m[4] += m[0] * x; m[5] += m[3] * y }
  scale(x: number, y: number) { const m = this.s.m; m[0] *= x; m[3] *= y }
  setLineDash(d: number[]) { this.s.dash = d.slice() } getLineDash() { return this.s.dash.slice() }
  private X(x: number) { return this.s.m[0] * x + this.s.m[4] } private Y(y: number) { return this.s.m[3] * y + this.s.m[5] }
  private paint(kind: 'fill' | 'stroke'): string {
    const [c, a0] = color(kind === 'fill' ? this.s.fillStyle : this.s.strokeStyle); const a = a0 * this.s.globalAlpha
    if (kind === 'fill') return `fill="${c}"${a < 1 ? ` fill-opacity="${n(a)}"` : ''}`
    const w = this.s.lineWidth * Math.abs(this.s.m[0]); const dash = this.s.dash.length ? ` stroke-dasharray="${this.s.dash.map(v => n(v * Math.abs(this.s.m[0]))).join(',')}"` : ''
    return `fill="none" stroke="${c}" stroke-width="${n(w)}"${a < 1 ? ` stroke-opacity="${n(a)}"` : ''}${dash}`
  }
  private visible(kind: 'fill' | 'stroke') { return color(kind === 'fill' ? this.s.fillStyle : this.s.strokeStyle)[1] * this.s.globalAlpha > 0.001 }
  fillRect(x: number, y: number, w: number, h: number) {
    if (!this.visible('fill')) return; let x0 = this.X(x), y0 = this.Y(y), x1 = this.X(x + w), y1 = this.Y(y + h); if (x1 < x0) [x0, x1] = [x1, x0]; if (y1 < y0) [y0, y1] = [y1, y0]
    if (x1 < 0 || y1 < 0 || x0 > this.width || y0 > this.height) return
    this.out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${n(x1 - x0)}" height="${n(y1 - y0)}" ${this.paint('fill')}/>`)
  }
  strokeRect(x: number, y: number, w: number, h: number) { if (!this.visible('stroke')) return; this.out.push(`<rect x="${n(this.X(x))}" y="${n(this.Y(y))}" width="${n(w * this.s.m[0])}" height="${n(h * this.s.m[3])}" ${this.paint('stroke')}/>`) }
  clearRect(x: number, y: number, w: number, h: number) { void x; void y; void w; void h }
  beginPath() { this.d = '' }
  moveTo(x: number, y: number) { this.d += `M${n(this.X(x))} ${n(this.Y(y))}` }
  lineTo(x: number, y: number) { this.d += `L${n(this.X(x))} ${n(this.Y(y))}` }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) { this.d += `C${n(this.X(a))} ${n(this.Y(b))} ${n(this.X(c))} ${n(this.Y(d))} ${n(this.X(x))} ${n(this.Y(y))}` }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { this.d += `Q${n(this.X(a))} ${n(this.Y(b))} ${n(this.X(x))} ${n(this.Y(y))}` }
  rect(x: number, y: number, w: number, h: number) { this.d += `M${n(this.X(x))} ${n(this.Y(y))}h${n(w * this.s.m[0])}v${n(h * this.s.m[3])}h${n(-w * this.s.m[0])}Z` }
  closePath() { this.d += 'Z' }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
    const R = r * Math.abs(this.s.m[0]); const X = this.X(cx), Y = this.Y(cy); let sweep = a1 - a0; if (ccw) sweep = -sweep
    if (Math.abs(sweep) >= Math.PI * 2 - 1e-6) { this.d += `M${n(X + R)} ${n(Y)}A${n(R)} ${n(R)} 0 1 1 ${n(X - R)} ${n(Y)}A${n(R)} ${n(R)} 0 1 1 ${n(X + R)} ${n(Y)}`; return }
    const sx = X + R * Math.cos(a0), sy = Y + R * Math.sin(a0), ex = X + R * Math.cos(a1), ey = Y + R * Math.sin(a1)
    const s0 = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI); const large = ccw ? (s0 < Math.PI ? 1 : 0) : (s0 > Math.PI ? 1 : 0)
    this.d += `${this.d ? 'L' : 'M'}${n(sx)} ${n(sy)}A${n(R)} ${n(R)} 0 ${large} ${ccw ? 0 : 1} ${n(ex)} ${n(ey)}`
  }
  fill() { if (this.d && this.visible('fill')) this.out.push(`<path d="${this.d}" ${this.paint('fill')}/>`) }
  stroke() { if (this.d && this.visible('stroke')) this.out.push(`<path d="${this.d}" ${this.paint('stroke')}/>`) }
  clip() { const id = `c${++this.nclip}`; this.defs.push(`<clipPath id="${id}"><path d="${this.d || 'M0 0'}"/></clipPath>`); this.out.push(`<g clip-path="url(#${id})">`); this.s.groups++ }
  private fontParts() { const f = this.s.font; const size = /(\d+(?:\.\d+)?)px/.exec(f); return { size: (size ? parseFloat(size[1]) : 10) * Math.abs(this.s.m[0]), bold: /\bbold\b|\b[6-9]00\b/.test(f), italic: /\bitalic\b/.test(f), mono: /mono|Menlo|Consolas|Courier/i.test(f) } }
  measureText(t: string): TextMetrics { probe.font = this.s.font; return probe.measureText(t) }
  fillText(t: string, x: number, y: number) {
    if (!this.visible('fill') || t == null || t === '') return; const f = this.fontParts()
    const anchor = this.s.textAlign === 'center' ? 'middle' : this.s.textAlign === 'right' || this.s.textAlign === 'end' ? 'end' : 'start'
    const base = this.s.textBaseline === 'middle' ? 'central' : this.s.textBaseline === 'top' || this.s.textBaseline === 'hanging' ? 'hanging' : this.s.textBaseline === 'bottom' ? 'text-after-edge' : 'auto'
    this.out.push(`<text x="${n(this.X(x))}" y="${n(this.Y(y))}" font-family="${f.mono ? 'Courier New, monospace' : this.fontFamily}" font-size="${n(f.size)}"${f.bold ? ' font-weight="bold"' : ''}${f.italic ? ' font-style="italic"' : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${base !== 'auto' ? ` dominant-baseline="${base}"` : ''} ${this.paint('fill')}>${esc(String(t))}</text>`)
  }
  strokeText(t: string, x: number, y: number) { void t; void x; void y }
  drawImage() { /* 図には入れない */ }
  createLinearGradient() { return { addColorStop() { /* */ } } as any }
  get canvas() { return { width: this.width, height: this.height } as any }
  serialize(title = ''): string {
    let g = 0; for (const st of [this.s, ...this.stack]) g += st.groups
    const tail = '</g>'.repeat(g)
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n${title ? `<title>${esc(title)}</title>\n` : ''}${this.defs.length ? `<defs>${this.defs.join('')}</defs>\n` : ''}<rect width="100%" height="100%" fill="#ffffff"/>\n${this.out.join('\n')}${tail}\n</svg>\n`
  }
}
