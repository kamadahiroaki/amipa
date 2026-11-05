// Traversals の全体図（11-05）: 合意座標の全長を 1 本の帯にし、主画面のグラフに見えているノードがどこに当たるかを山（分布）で重ねる。
//   ・色相は使わない（色相はパネルで開いている範囲のブロックの色だけ。以前の Blocks のミニマップは全体と範囲に同じ色を使い誤解を招いた）。
//     染色体は灰の濃淡の交互、分布は濃い灰、開いている範囲は黒の枠で、その枠の中にだけブロックの色の細い帯を描く
//   ・分布の山に A・B・C…（重い順、6 個まで）。グラフ側の同じ文字の札と対応する（App の TravPeaksOverlay）
//   ・操作: 山のクリック＝その山の範囲へ、帯のドラッグ＝任意の範囲へ、帯のクリック＝今の幅のままそこへ、印（▼ グラフでクリックしたノード）のクリック＝その位置へ
export type OvBand = { x0: number; x1: number; name: string; ref: boolean }
export type OvPoint = { x: number; w: number; name: string; wx: number; wy: number }
export type OvPeak = { letter: string; x0: number; x1: number; xm: number; n: number; w: number; share: number; label: string; names: string[]; wx: number; wy: number; box: [number, number, number, number]; inView: boolean }
export interface OverviewDeps {
  R: () => number
  bpOfX: (x: number) => number
  xOfBp: (bp: number) => number
  totalBp: () => number
  labelOf: (x: number) => string                         // 座標 → 「chr3R 13.7 Mb」
  view: () => [number, number]
  stripe: () => { x0: number; x1: number; color: string }[]   // 開いている範囲のブロックの色
  onGo: (x0: number, x1: number, fit: boolean) => void
  onHoverPeak: (p: OvPeak | null) => void
}
export const LETTERS = 'ABCDEF'
const fmtbp = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + ' Mb' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kb' : Math.round(n) + ' bp'

// 山: 座標の隙間（全長の 0.5%、下限 2,000）と染色体の境目で連なりに分け、重い順に文字。全体の 2% 未満の連なりは文字を付けない（帯には描く）
//   （染色体で分けないと、合意座標で隣り合う chrX と chr3R が 1 つの山になった）
export function computePeaks(pts: OvPoint[], R: number, labelOf: (x: number) => string, view: [number, number], bandOf: (x: number) => number = () => 0): OvPeak[] {
  if (!pts.length) return []
  const s = pts.slice().sort((a, b) => a.x - b.x); const G = Math.max(2000, Math.round(R * 0.005))
  const runs: OvPoint[][] = []; let cur: OvPoint[] = [s[0]]
  let bPrev = bandOf(s[0].x)
  for (let i = 1; i < s.length; i++) { const bi = bandOf(s[i].x); if (s[i].x - s[i - 1].x > G || bi !== bPrev) { runs.push(cur); cur = [] } bPrev = bi; cur.push(s[i]) } runs.push(cur)
  const tot = s.reduce((a, p) => a + p.w, 0) || 1
  const pc = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))]
  const peaks = runs.map(r => {
    const w = r.reduce((a, p) => a + p.w, 0); const xs = r.map(p => p.x); const wx = r.map(p => p.wx).sort((a, b) => a - b), wy = r.map(p => p.wy).sort((a, b) => a - b)
    const x0 = xs[0], x1 = xs[xs.length - 1]; let acc = 0, xm = x0; for (const p of r) { acc += p.w; if (acc >= w / 2) { xm = p.x; break } }
    return { letter: '', x0, x1, xm, n: r.length, w, share: w / tot, label: labelOf(xm), names: r.map(p => p.name), wx: pc(wx, 0.5), wy: pc(wy, 0.5), box: [pc(wx, 0.1), pc(wy, 0.1), pc(wx, 0.9), pc(wy, 0.9)] as [number, number, number, number], inView: x1 >= view[0] && x0 <= view[1] }
  }).sort((a, b) => b.w - a.w)
  let k = 0; for (const p of peaks) { if (k < LETTERS.length && p.share >= 0.02) p.letter = LETTERS[k++] }
  return peaks
}

export interface OverviewHandle { draw(): void; setBands(b: OvBand[]): void; setPoints(pts: OvPoint[], peaks: OvPeak[], note: string): void; setMarker(x: number | null, label?: string): void; setHoverLetter(l: string | null): void; peaks(): OvPeak[]; centerWeighted(): boolean; destroy(): void }
export function mountOverview(host: HTMLElement, LAB: number, deps: OverviewDeps, onCenterToggle: () => void): OverviewHandle {
  host.innerHTML = `<div style="display:flex;align-items:stretch;border-bottom:1px solid #ddd;background:#fff">
    <div style="width:${LAB}px;flex-shrink:0;padding:2px 6px;box-sizing:border-box;font:11px system-ui;color:#555;overflow:hidden">
      <div><b style="color:#333">全体図</b> <label title="グラフの画面の中央に近いノードほど重く数える（画面の端に入った別の場所の山を小さくする）"><input type="checkbox" class="ovc"> 中央を重く</label></div>
      <div class="ovn" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
      <div class="ovh" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#222"></div>
    </div>
    <div style="position:relative;flex:1;min-width:0"><canvas class="ovcv" style="display:block;cursor:pointer"></canvas></div></div>`
  const cv = host.querySelector('.ovcv') as HTMLCanvasElement; const g = cv.getContext('2d')!
  const chk = host.querySelector('.ovc') as HTMLInputElement; const noteEl = host.querySelector('.ovn') as HTMLElement; const hovEl = host.querySelector('.ovh') as HTMLElement
  chk.addEventListener('change', onCenterToggle)
  const H = 58, BAND = 14, HIST0 = 16, HIST1 = 46, STR0 = 49, STR1 = 55
  let bands: OvBand[] = [], pts: OvPoint[] = [], pks: OvPeak[] = [], marker: { x: number; label: string } | null = null, hovL: string | null = null, drag: [number, number] | null = null
  const W = () => Math.max(50, cv.parentElement!.clientWidth)
  const total = () => Math.max(1, deps.totalBp())
  const px = (x: number) => 4 + deps.bpOfX(x) / total() * (W() - 8)
  const xOf = (p: number) => deps.xOfBp((p - 4) / (W() - 8) * total())
  function draw() {
    const w = W(), dpr = devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); cv.style.width = w + 'px'; cv.style.height = H + 'px' }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H); g.fillStyle = '#fff'; g.fillRect(0, 0, w, H)
    // 染色体（灰の交互。名前は入る幅があれば）
    g.font = '10px system-ui'; g.textBaseline = 'middle'; let k = 0
    for (const b of bands) { const a = px(b.x0), c = px(b.x1 + 1); g.fillStyle = k++ % 2 ? '#d5d9de' : '#eceef1'; g.fillRect(a, 0, Math.max(1, c - a), BAND)
      const nm = b.name || `区間 ${k}`; const tw = g.measureText(nm).width; if (c - a >= tw + 6) { g.fillStyle = b.name ? '#333' : '#888'; g.fillText(nm, a + 3, BAND / 2 + 1) } }
    if (!bands.length) { g.fillStyle = '#eceef1'; g.fillRect(4, 0, w - 8, BAND) }
    // 分布（画素の列ごとの重みの和。高さは平方根で）
    if (pts.length) { const cols = new Float64Array(Math.ceil(w)); for (const p of pts) { const i = Math.max(0, Math.min(cols.length - 1, Math.floor(px(p.x)))); cols[i] += p.w }
      let mx = 0; for (const v of cols) if (v > mx) mx = v
      const hovPk = hovL ? pks.find(p => p.letter === hovL) : null
      for (let i = 0; i < cols.length; i++) { if (!cols[i]) continue; const h = Math.max(1, Math.sqrt(cols[i] / mx) * (HIST1 - HIST0)); const x = xOf(i + 0.5); g.fillStyle = hovPk && x >= hovPk.x0 - 1 && x <= hovPk.x1 + 1 ? '#000' : '#6b7280'; g.fillRect(i, HIST1 - h, 1, h) } }
    g.strokeStyle = '#ccc'; g.lineWidth = 1; g.beginPath(); g.moveTo(4, HIST1 + .5); g.lineTo(w - 4, HIST1 + .5); g.stroke()
    // 開いている範囲: 黒の枠と、その中にだけブロックの色の帯
    const [v0, v1] = deps.view(); const a = px(v0), c = px(v1 + 1)
    for (const s of deps.stripe()) { const sa = px(s.x0), sc = px(s.x1 + 1); g.fillStyle = s.color; g.fillRect(sa, STR0, Math.max(1, sc - sa), STR1 - STR0) }
    g.strokeStyle = '#111'; g.lineWidth = 1.5; g.strokeRect(a, 1, Math.max(2, c - a), H - 2)
    if (c - a < 6) { g.fillStyle = '#111'; g.beginPath(); g.moveTo((a + c) / 2 - 5, 0); g.lineTo((a + c) / 2 + 5, 0); g.lineTo((a + c) / 2, 6); g.fill() }
    // 山の文字
    g.font = 'bold 11px system-ui'; g.textBaseline = 'top'
    for (const p of pks) { if (!p.letter) continue; const x = px(p.xm); const on = p.letter === hovL; const tw = g.measureText(p.letter).width
      g.fillStyle = on ? '#111' : '#fff'; g.strokeStyle = '#111'; g.lineWidth = 1; g.beginPath(); g.rect(x - tw / 2 - 3, HIST0, tw + 6, 13); g.fill(); g.stroke(); g.fillStyle = on ? '#fff' : '#111'; g.fillText(p.letter, x - tw / 2, HIST0 + 1) }
    // グラフでクリックしたノードの印
    if (marker) { const x = px(marker.x); g.fillStyle = '#111'; g.beginPath(); g.moveTo(x - 5, BAND); g.lineTo(x + 5, BAND); g.lineTo(x, BAND + 7); g.fill() }
    if (drag) { const l = Math.min(...drag), r = Math.max(...drag); g.fillStyle = 'rgba(52,152,219,.25)'; g.fillRect(l, 0, r - l, H) }
  }
  const peakAt = (p: number): OvPeak | null => { let best: OvPeak | null = null, bd = 1e9
    for (const q of pks) { if (!q.letter) continue; const a = px(q.x0) - 4, c = px(q.x1 + 1) + 4, m = px(q.xm); const lab = Math.abs(p - m) <= 8; if ((p >= a && p <= c) || lab) { const d = Math.abs(p - m); if (d < bd) { bd = d; best = q } } } return best }
  const desc = (q: OvPeak) => `${q.letter}　${q.label}　${q.n.toLocaleString('en-US')} ノード（${Math.round(q.share * 100)}%）${q.inView ? '・表示中' : ''}`
  function setHov(q: OvPeak | null) { const l = q ? q.letter : null; if (l === hovL) return; hovL = l; hovEl.textContent = q ? desc(q) : ''; draw(); deps.onHoverPeak(q) }
  cv.addEventListener('mousedown', e => { drag = [e.offsetX, e.offsetX] })
  cv.addEventListener('mousemove', e => {
    if (drag) { drag[1] = e.offsetX; draw(); return }
    const q = peakAt(e.offsetX); setHov(q)
    if (!q) { const x = xOf(e.offsetX); hovEl.textContent = marker && Math.abs(px(marker.x) - e.offsetX) <= 6 ? `▼ ${marker.label}` : deps.labelOf(Math.max(0, Math.min(deps.R() - 1, x))) }
  })
  cv.addEventListener('mouseleave', () => { setHov(null); hovEl.textContent = '' })
  const onUp = (e: MouseEvent) => {
    if (!drag) return; const d = drag; drag = null; const r = cv.getBoundingClientRect(); const p1 = e.clientX - r.left
    if (Math.abs(p1 - d[0]) >= 4) { const l = Math.min(d[0], p1), h = Math.max(d[0], p1); deps.onGo(Math.max(0, Math.floor(xOf(l))), Math.min(deps.R() - 1, Math.ceil(xOf(h))), true); draw(); return }
    if (marker && Math.abs(px(marker.x) - d[0]) <= 6) { deps.onGo(marker.x, marker.x, false); draw(); return }
    const q = peakAt(d[0]); if (q) { const pad = Math.max(50, Math.round((q.x1 - q.x0) * 0.05)); deps.onGo(Math.max(0, q.x0 - pad), Math.min(deps.R() - 1, q.x1 + pad), false); draw(); return }
    const [v0, v1] = deps.view(); const half = (v1 - v0) / 2; const x = xOf(d[0]); deps.onGo(Math.max(0, Math.floor(x - half)), Math.min(deps.R() - 1, Math.ceil(x + half)), true); draw()
  }
  window.addEventListener('mouseup', onUp)
  const ro = new ResizeObserver(() => draw()); ro.observe(cv.parentElement!)
  draw()
  return {
    draw,
    setBands(b) { bands = b; draw() },
    setPoints(p, peaks, note) { pts = p; pks = peaks; noteEl.textContent = note; noteEl.title = note; if (hovL && !pks.some(q => q.letter === hovL)) hovL = null; draw() },
    setMarker(x, label) { marker = x == null ? null : { x, label: label || '' }; draw() },
    setHoverLetter(l) { if (l === hovL) return; hovL = l; const q = l ? pks.find(p => p.letter === l) : null; hovEl.textContent = q ? desc(q) : ''; draw() },
    peaks: () => pks,
    centerWeighted: () => chk.checked,
    destroy() { window.removeEventListener('mouseup', onUp); ro.disconnect(); host.innerHTML = '' },
  }
}
export { fmtbp as ovFmtbp }
