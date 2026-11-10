// Traversals の全体図（11-05）: 合意座標の全長を 1 本の帯にし、主画面のグラフに見えているノードがどこに当たるかを山（分布）で重ねる。
//   ・色相は使わない（色相はパネルで開いている範囲のブロックの色だけ。以前の Blocks のミニマップは全体と範囲に同じ色を使い誤解を招いた）。
//     染色体は灰の濃淡の交互、分布は濃い灰、開いている範囲は黒の枠で、その枠の中にだけブロックの色の細い帯を描く
//   ・分布の山に札（重い順、6 個まで）。札は場所の名前＝染色体と参照の位置（「chr3R:13.7M」。11-06: 以前の A・B・C は解像度や見えているものが変わると
//     同じ文字が別の場所を指した）。山にカーソルを当てるとグラフでその山のノードを強調する（グラフ側の札は 11-05 に外した）
//   ・操作: 山のクリック＝その山の範囲へ、帯のドラッグ＝任意の範囲へ、帯のクリック＝今の幅のままそこへ、印（▼ グラフでクリックしたノード）のクリック＝その位置へ
export type OvBand = { x0: number; x1: number; name: string; ref: boolean }
export type OvPoint = { x: number; w: number; name: string; wx: number; wy: number; a?: number; b?: number }   // a–b＝座標の張り（スーパーノード。無ければ x の 1 点）
export type OvPeak = { letter: string; x0: number; x1: number; xm: number; n: number; w: number; share: number; label: string; names: string[]; wx: number; wy: number; box: [number, number, number, number]; full: [number, number, number, number]; inView: boolean }
export interface OverviewDeps {
  R: () => number
  bpOfX: (x: number) => number
  xOfBp: (bp: number) => number
  totalBp: () => number
  labelOf: (x: number) => string                         // 座標 → 「chr3R 13.7 Mb」
  view: () => [number, number]
  stripe: () => { x0: number; x1: number; color: string }[]   // 開いている範囲のブロックの色
  onGo: (x0: number, x1: number, fit: boolean) => void
  onGoPeak: (q: OvPeak) => void                           // 山のクリック（パネルを山の範囲へ、グラフは山の塊が小さければ寄せる）
  onHoverPeak: (p: OvPeak | null) => void
}
export const MAX_TAGS = 6
const fmtbp = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + ' Mb' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kb' : Math.round(n) + ' bp'

// 山: 座標の隙間（全長の 0.5%、下限 2,000）と染色体の境目で連なりに分け、重い順に札。全体の 2% 未満の連なりは札を付けない（帯には描く）
//   （染色体で分けないと、合意座標で隣り合う chrX と chr3R が 1 つの山になった）
//   札 tagOf(xm, extra) は山の重みの中央の位置の名前（extra＝桁を足す数）。同じ札が 2 つできたらその山だけ桁を足す
export function computePeaks(pts: OvPoint[], R: number, labelOf: (x: number) => string, view: [number, number], bandOf: (x: number) => number, tagOf: (x: number, extra: number, x0: number, x1: number) => string): OvPeak[] {
  if (!pts.length) return []
  // 11-05: 点は張り（a–b）の区間として繋ぐ。粗い層のスーパーノードを 1 点で数えると、全体表示で点が疎になり 1 染色体が数十の山に割れた
  const lo = (p: OvPoint) => p.a ?? p.x, hi = (p: OvPoint) => p.b ?? p.x
  const s = pts.slice().sort((a, b) => lo(a) - lo(b)); const G = Math.max(2000, Math.round(R * 0.005))
  const runs: OvPoint[][] = []; let cur: OvPoint[] = [s[0]]
  let bPrev = bandOf(s[0].x), end = hi(s[0])
  for (let i = 1; i < s.length; i++) { const bi = bandOf(s[i].x); if (lo(s[i]) - end > G || bi !== bPrev) { runs.push(cur); cur = []; end = -Infinity } bPrev = bi; end = Math.max(end, hi(s[i])); cur.push(s[i]) } runs.push(cur)
  const tot = s.reduce((a, p) => a + p.w, 0) || 1
  const pc = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))]
  const peaks = runs.map(r => {
    const w = r.reduce((a, p) => a + p.w, 0); const wx = r.map(p => p.wx).sort((a, b) => a - b), wy = r.map(p => p.wy).sort((a, b) => a - b)
    const x0 = Math.min(...r.map(lo)), x1 = Math.max(...r.map(hi)); const byX = r.slice().sort((a, b) => a.x - b.x); let acc = 0, xm = x0; for (const p of byX) { acc += p.w; if (acc >= w / 2) { xm = p.x; break } }
    return { letter: '', x0, x1, xm, n: r.length, w, share: w / tot, label: labelOf(xm), names: r.map(p => p.name), wx: pc(wx, 0.5), wy: pc(wy, 0.5), box: [pc(wx, 0.1), pc(wy, 0.1), pc(wx, 0.9), pc(wy, 0.9)] as [number, number, number, number], full: [pc(wx, 0.02), pc(wy, 0.02), pc(wx, 0.98), pc(wy, 0.98)] as [number, number, number, number], inView: x1 >= view[0] && x0 <= view[1] }
  }).sort((a, b) => b.w - a.w)
  const cand = peaks.filter(p => p.share >= 0.02).slice(0, MAX_TAGS)
  const extra = new Map<OvPeak, number>(); for (const p of cand) { p.letter = tagOf(p.xm, 0, p.x0, p.x1); extra.set(p, 0) }
  for (let it = 0; it < 4; it++) { const cnt = new Map<string, number>(); for (const p of cand) cnt.set(p.letter, (cnt.get(p.letter) || 0) + 1)
    const dup = cand.filter(p => cnt.get(p.letter)! > 1); if (!dup.length) break
    for (const p of dup) { const e = extra.get(p)! + 1; extra.set(p, e); p.letter = tagOf(p.xm, e, p.x0, p.x1) } }
  return peaks
}

export interface OverviewHandle { viewClient(): [number, number] | null; draw(): void; setBands(b: OvBand[]): void; setPoints(pts: OvPoint[], peaks: OvPeak[], note: string): void; setMarker(x: number | null, label?: string): void; setHoverLetter(l: string | null): void; peaks(): OvPeak[]; centerWeighted(): boolean; destroy(): void }
export function mountOverview(host: HTMLElement, LAB: number, deps: OverviewDeps, onCenterToggle: () => void): OverviewHandle {
  host.innerHTML = `<div style="display:flex;align-items:stretch;border-bottom:1px solid #ddd;background:#fff">
    <div style="width:${LAB}px;height:29px;flex-shrink:0;padding:1px 6px;box-sizing:border-box;font:10px/13px system-ui;color:#555;overflow:hidden">
      <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b style="color:#333">全体図</b> <span class="ovn"></span> <label class="ovcl" title="グラフの画面の中央に近いノードほど重く数える（画面の端に入った別の場所の山を小さくする）"${new URLSearchParams(location.search).has("dev") ? "" : " hidden"}><input type="checkbox" class="ovc"> 中央を重く</label></div>
      <div class="ovh" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#222"></div>
    </div>
    <div style="position:relative;flex:1;min-width:0"><canvas class="ovcv" style="display:block;cursor:pointer"></canvas></div></div>`
  const cv = host.querySelector('.ovcv') as HTMLCanvasElement; const g = cv.getContext('2d')!
  const chk = host.querySelector('.ovc') as HTMLInputElement; const noteEl = host.querySelector('.ovn') as HTMLElement; const hovEl = host.querySelector('.ovh') as HTMLElement
  chk.addEventListener('change', onCenterToggle)
  const H = 29, BAND = 9, HIST0 = 10, HIST1 = 24, STR0 = 25, STR1 = 29   // 11-10: 58 → 29 px
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
    g.font = '9px system-ui'; g.textBaseline = 'middle'; let k = 0
    for (const b of bands) { const a = px(b.x0), c = px(b.x1 + 1); g.fillStyle = k++ % 2 ? '#d5d9de' : '#eceef1'; g.fillRect(a, 0, Math.max(1, c - a), BAND)
      const nm = b.name || `区間 ${k}`; const tw = g.measureText(nm).width; if (c - a >= tw + 6) { g.fillStyle = b.name ? '#333' : '#888'; g.fillText(nm, a + 3, BAND / 2 + 1) } }
    if (!bands.length) { g.fillStyle = '#eceef1'; g.fillRect(4, 0, w - 8, BAND) }
    // 分布（画素の列ごとの重みの和。高さは平方根で）
    if (pts.length) { const cols = new Float64Array(Math.ceil(w)); for (const p of pts) { const i0 = Math.max(0, Math.min(cols.length - 1, Math.floor(px(p.a ?? p.x)))), i1 = Math.max(i0, Math.min(cols.length - 1, Math.floor(px(p.b ?? p.x)))); const v = p.w / (i1 - i0 + 1); for (let i = i0; i <= i1; i++) cols[i] += v }   // 張りのある点は区間に均して積む
      let mx = 0; for (const v of cols) if (v > mx) mx = v
      const hovPk = hovL ? pks.find(p => p.letter === hovL) : null
      for (let i = 0; i < cols.length; i++) { if (!cols[i]) continue; const h = Math.max(1, Math.sqrt(cols[i] / mx) * (HIST1 - HIST0)); const x = xOf(i + 0.5); g.fillStyle = hovPk && x >= hovPk.x0 - 1 && x <= hovPk.x1 + 1 ? '#000' : '#6b7280'; g.fillRect(i, HIST1 - h, 1, h) } }
    g.strokeStyle = '#ccc'; g.lineWidth = 1; g.beginPath(); g.moveTo(4, HIST1 + .5); g.lineTo(w - 4, HIST1 + .5); g.stroke()
    // 開いている範囲: 黒の枠と、その中にだけブロックの色の帯
    const [v0, v1] = deps.view(); const a = px(v0), c = px(v1 + 1)
    for (const s of deps.stripe()) { const sa = px(s.x0), sc = px(s.x1 + 1); g.fillStyle = s.color; g.fillRect(sa, STR0, Math.max(1, sc - sa), STR1 - STR0) }
    g.strokeStyle = '#111'; g.lineWidth = 1.5; g.strokeRect(a, 1, Math.max(2, c - a), H - 1.5)
    if (c - a < 6) { g.fillStyle = '#111'; g.beginPath(); g.moveTo((a + c) / 2 - 5, 0); g.lineTo((a + c) / 2 + 5, 0); g.lineTo((a + c) / 2, 6); g.fill() }
    // 山の札（場所の名前）。横に重なるものは 2 段目へ、それでも重なるものは小さな印だけ（ホバーで名前）
    g.font = 'bold 8px system-ui'; g.textBaseline = 'top'; tagBoxes = []; const rowEnd = [-Infinity, -Infinity]
    for (const p of pks.filter(q => q.letter).sort((a, b) => px(a.xm) - px(b.xm))) { const x = px(p.xm); const on = p.letter === hovL; const tw = g.measureText(p.letter).width
      let l = Math.max(1, Math.min(w - tw - 7, x - tw / 2 - 3)); const row = l > rowEnd[0] + 2 ? 0 : l > rowEnd[1] + 2 ? 1 : -1
      g.strokeStyle = '#111'; g.lineWidth = 1
      if (row < 0) { g.fillStyle = on ? '#111' : '#fff'; g.beginPath(); g.rect(x - 3, HIST0, 6, 6); g.fill(); g.stroke(); tagBoxes.push({ q: p, a: x - 4, b: x + 4, y0: HIST0, y1: HIST0 + 7 }); continue }
      const y = HIST0 + row * 9; rowEnd[row] = l + tw + 6   // 札は高さ 10 px で 2 段
      g.fillStyle = on ? '#111' : '#fff'; g.beginPath(); g.rect(l, y, tw + 6, 10); g.fill(); g.stroke(); g.fillStyle = on ? '#fff' : '#111'; g.fillText(p.letter, l + 3, y + 1)
      if (x < l || x > l + tw + 6) { g.beginPath(); g.moveTo(x + .5, y + 10); g.lineTo(x + .5, y + 13); g.stroke() }
      tagBoxes.push({ q: p, a: l, b: l + tw + 6, y0: y, y1: y + 10 }) }
    // グラフでクリックしたノードの印
    if (marker) { const x = px(marker.x); g.fillStyle = '#111'; g.beginPath(); g.moveTo(x - 5, BAND); g.lineTo(x + 5, BAND); g.lineTo(x, BAND + 7); g.fill() }
    if (drag) { const l = Math.min(...drag), r = Math.max(...drag); g.fillStyle = 'rgba(52,152,219,.25)'; g.fillRect(l, 0, r - l, H) }
  }
  let tagBoxes: { q: OvPeak; a: number; b: number; y0: number; y1: number }[] = []
  const peakAt = (p: number, y = -1): OvPeak | null => { const tb = tagBoxes.find(t => p >= t.a && p <= t.b && y >= t.y0 && y <= t.y1); if (tb) return tb.q
    let best: OvPeak | null = null, bd = 1e9
    for (const q of pks) { if (!q.letter) continue; const a = px(q.x0) - 4, c = px(q.x1 + 1) + 4, m = px(q.xm); const lab = false; if ((p >= a && p <= c) || lab) { const d = Math.abs(p - m); if (d < bd) { bd = d; best = q } } } return best }
  const desc = (q: OvPeak) => `${q.letter}（${q.label}）　${q.n.toLocaleString('en-US')} ノード（${Math.round(q.share * 100)}%）${q.inView ? '・表示中' : ''}`
  function setHov(q: OvPeak | null) { const l = q ? q.letter : null; if (l === hovL) return; hovL = l; hovEl.textContent = q ? desc(q) : ''; draw(); deps.onHoverPeak(q) }
  let dragY = -1
  cv.addEventListener('mousedown', e => { drag = [e.offsetX, e.offsetX]; dragY = e.offsetY })
  cv.addEventListener('mousemove', e => {
    if (drag) { drag[1] = e.offsetX; draw(); return }
    const q = peakAt(e.offsetX, e.offsetY); setHov(q)
    if (!q) { const x = xOf(e.offsetX); hovEl.textContent = marker && Math.abs(px(marker.x) - e.offsetX) <= 6 ? `▼ ${marker.label}` : deps.labelOf(Math.max(0, Math.min(deps.R() - 1, x))) }
  })
  cv.addEventListener('mouseleave', () => { setHov(null); hovEl.textContent = '' })
  const onUp = (e: MouseEvent) => {
    if (!drag) return; const d = drag; drag = null; const r = cv.getBoundingClientRect(); const p1 = e.clientX - r.left
    if (Math.abs(p1 - d[0]) >= 4) { const l = Math.min(d[0], p1), h = Math.max(d[0], p1); deps.onGo(Math.max(0, Math.floor(xOf(l))), Math.min(deps.R() - 1, Math.ceil(xOf(h))), true); draw(); return }
    if (marker && Math.abs(px(marker.x) - d[0]) <= 6) { deps.onGo(marker.x, marker.x, false); draw(); return }
    const q = peakAt(d[0], dragY); if (q) { deps.onGoPeak(q); draw(); return }
    const [v0, v1] = deps.view(); const half = (v1 - v0) / 2; const x = xOf(d[0]); deps.onGo(Math.max(0, Math.floor(x - half)), Math.min(deps.R() - 1, Math.ceil(x + half)), true); draw()
  }
  window.addEventListener('mouseup', onUp)
  const ro = new ResizeObserver(() => draw()); ro.observe(cv.parentElement!)
  draw()
  return {
    viewClient: () => { const r = cv.getBoundingClientRect(); if (!r.width) return null; const [v0, v1] = deps.view(); return [r.left + px(v0), r.left + px(v1 + 1)] },   // 開いている範囲の枠の左右（画面の座標）。合意列から線で結ぶ
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
