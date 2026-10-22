// 通過（traversal）の試作ページ。`<db>.trav`（functions/anchor2/build/synteny2_build.py）を /api/trav/* で読み、
// 上段に原子（持続度 ≥ 床で切った座標区間）と境界、下にハプロタイプごとの行（コンティグ ＞ 通過）を描く。
// 操作: ドラッグで範囲を拡大、ダブルクリックで全体、ホイールでカーソル中心に拡大縮小、ホバーで通過の情報。設計: plans/anchor2-traversals.md
type Atom = { id: number; x0: number; x1: number; bp: number; nhap: number }
type Bound = { x: number; support: number; persistence: number }
type Hap = { hid: number; hap: string; ncontig: number; nexcl: number; bp: number }
type Trav = { id: number; pid: number; hid: number; i0: number; i1: number; x0: number; x1: number; dir: number; copy: number; nanch: number; bp: number; bp0?: number }
type AtomStat = { id: number; nhap: number; nhap2: number; tangled?: boolean; counts: Record<string, number> }
type Copy = { id: number; pid: number; hid: number; x0: number; x1: number; ia0: number; ia1: number; ib0: number; ib1: number; bpa: number; bpb: number }
type Root = { meta: any; H: number; R: number; total_bp: number; haps: Hap[]; atoms: Atom[]; bounds: Bound[] }

const $ = (id: string) => document.getElementById(id) as HTMLElement
const cv = $('cv') as HTMLCanvasElement; const g = cv.getContext('2d')!; const tip = $('tip'); const ov = $('ov') as HTMLCanvasElement; const og = ov.getContext('2d')!
const TOP = 70, LAB = 150; let ROW = 13; const BLK = 8   // ROW は並びのモードで変える（連結線の分）
let db = '', root: Root | null = null, view: [number, number] = [0, 1], hist: [number, number][] = []
type Rep = { id: number; pid: number; hid: number; i0: number; i1: number; bp: number; x0: number; x1: number }
let rows: Trav[] = [], copies: Copy[] = [], reps: Rep[] = [], perHap: Record<string, number> = {}, loading = 0
let hapOrder: number[] = []   // 表示順の hid（参照らしい名前を先に、名前順）
let atomStats: AtomStat[] = []; let refTrav: Trav[] = []   // 参照ハプロタイプの通過（座標 → 参照 bp の目安）
const fmt = (n: number) => n.toLocaleString('en-US')
function showErr(where: string, e: any) { const m = `${where}: ${e && (e.stack || e.message || e)}`.slice(0, 400); $('info').textContent = 'エラー ' + m; $('info').style.color = '#c0392b'; $('busy').style.display = 'none'; console.error(where, e) }
window.addEventListener('error', ev => showErr('window', ev.error || ev.message)); window.addEventListener('unhandledrejection', ev => showErr('promise', (ev as any).reason))
const fmtbp = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + ' Mb' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kb' : n + ' bp'

async function loadDbList() {
  const r = await fetch('/api/databases'); const dbs = (await r.json()) as string[]
  const sel = $('db') as HTMLSelectElement; sel.innerHTML = dbs.map(d => `<option>${d}</option>`).join('')
  const q = new URLSearchParams(location.search).get('db'); if (q && dbs.includes(q)) sel.value = q
  db = sel.value
}
async function loadRoot() {
  const r = await fetch(`/api/trav/root?db=${encodeURIComponent(db)}`)
  if (!r.ok) { root = null; $('info').textContent = `${db}: .trav が無い（${r.status}）`; draw(); return }
  root = await r.json(); view = [0, root!.R - 1]; hist = []
  const refLike = (h: string) => /^(GRCh38|CHM13|GCF_000148365)/.test(h) ? 0 : 1
  hapOrder = root!.haps.map(h => h.hid).sort((a, b) => refLike(root!.haps[a].hap) - refLike(root!.haps[b].hap) || root!.haps[a].hap.localeCompare(root!.haps[b].hap)); baseOrder = hapOrder.slice()
  await loadRange(); await loadAtoms()
}
async function loadAtoms() {
  if (!root) return
  const minanch = Number(($('minanch') as HTMLInputElement).value) || 0
  const r = await fetch(`/api/trav/atoms?db=${encodeURIComponent(db)}&minanch=${minanch}`); atomStats = r.ok ? (await r.json()).atoms : []
  const refH = root.haps.find(h => /^(GRCh38|CHM13)/.test(h.hap)); refTrav = []
  if (refH) { const rr = await fetch(`/api/trav/range?db=${encodeURIComponent(db)}&x0=0&x1=${root.R}&minanch=1000`); if (rr.ok) refTrav = ((await rr.json()).trav as Trav[]).filter(t => t.hid === refH.hid) }
  draw()
}
let rangeTimer: any = null
function scheduleRange(ms = 120) { if (rangeTimer) clearTimeout(rangeTimer); $('busy').style.display = 'inline'; rangeTimer = setTimeout(() => { rangeTimer = null; loadRange() }, ms) }
async function loadRange() {
  if (!root) return
  const my = ++loading; $('busy').style.display = 'inline'; const minanch = Number(($('minanch') as HTMLInputElement).value) || 0
  const r = await fetch(`/api/trav/range?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${minanch}`)
  if (my !== loading) return
  const j = await r.json(); rows = j.trav; copies = j.copies; reps = j.reps || []; perHap = j.perHap; $('busy').style.display = 'none'; sel = null; $('info').style.color = ''
  try { hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice() } catch (e) { showErr('tree', e); hapOrder = baseOrder.slice() }
  const nh2 = Object.values(perHap).filter(n => (n as number) >= 2).length
  $('info').textContent = `${db}: 座標 ${fmt(Math.floor(view[0]))}–${fmt(Math.ceil(view[1]))} / ${fmt(root.R)}（${fmtbp(j.bp0)}–${fmtbp(j.bp1)}） 通過 ${fmt(rows.length)} コピー ${fmt(copies.length)} 2 回以上通るハプロタイプ ${nh2} | 原子 ${root.atoms.length} 錨 強 ${fmt(root.meta.strong)} 補間 ${fmt(root.meta.interp)}`
  draw()
}
function X(x: number) { const w = cv.width / devicePixelRatio - LAB; return LAB + (x - view[0]) / Math.max(1, view[1] - view[0]) * w }
function xOfPx(px: number) { const w = cv.width / devicePixelRatio - LAB; return view[0] + (px - LAB) / w * (view[1] - view[0]) }
function hue(i: number) { return (i * 137.508) % 360 }
function treeOrder(): number[] {
  // 表示範囲の原子ごとに、各ハプロタイプの状態（0 無し, 1 順向き, 2 逆向き, 3 両方/複数）を作り、bp 重みの不一致率で UPGMA（n ≤ 数百を想定）
  if (!root) return hapOrder
  const [v0, v1] = view; const atomsIn = root.atoms.filter(a => a.x1 >= v0 && a.x0 <= v1); if (!atomsIn.length) return hapOrder
  const H = root.haps.length; const state = new Uint8Array(H * atomsIn.length); const aIdx = new Map(atomsIn.map((a, i) => [a.id, i]))
  const dom = new Map<number, number>(); for (const r of rows) dom.set(r.pid, (dom.get(r.pid) || 0) + r.dir * r.nanch)
  for (const r of rows) { const d = (dom.get(r.pid) || 0) >= 0 ? r.dir : -r.dir; for (const a of atomsIn) { if (a.x1 < r.x0 || a.x0 > r.x1) continue; const k = r.hid * atomsIn.length + aIdx.get(a.id)!; const cur = state[k]; const nv = d >= 0 ? 1 : 2; state[k] = cur === 0 ? nv : (cur === nv ? cur : 3) } }
  const w = atomsIn.map(a => Math.max(1, Math.min(a.x1, v1) - Math.max(a.x0, v0) + 1)); const wsum = w.reduce((a, b) => a + b, 0)
  const ids = hapOrder.slice(); const n = ids.length; const D: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let dsum = 0; for (let k = 0; k < atomsIn.length; k++) { const a = state[ids[i] * atomsIn.length + k], b = state[ids[j] * atomsIn.length + k]; if (a !== b) dsum += w[k] * (a === 0 || b === 0 ? 1 : 0.5) } D[i][j] = D[j][i] = dsum / wsum }
  // UPGMA: クラスタを併合して葉の順を得る
  let clusters: { leaves: number[]; size: number }[] = ids.map((_, i) => ({ leaves: [i], size: 1 })); let dist = D.map(r => r.slice())
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity; for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) if (dist[i][j] < bd) { bd = dist[i][j]; bi = i; bj = j }
    const A = clusters[bi], B = clusters[bj]; const merged = { leaves: A.leaves.concat(B.leaves), size: A.size + B.size }
    const nd: number[] = []; for (let k = 0; k < clusters.length; k++) if (k !== bi && k !== bj) nd.push((dist[bi][k] * A.size + dist[bj][k] * B.size) / (A.size + B.size))
    clusters = clusters.filter((_, k) => k !== bi && k !== bj); dist = dist.filter((_, k) => k !== bi && k !== bj).map(r => r.filter((_, k) => k !== bi && k !== bj))
    clusters.push(merged); for (let k = 0; k < dist.length; k++) dist[k].push(nd[k]); dist.push(nd.concat([0]))
  }
  return clusters[0].leaves.map(i => ids[i])
}
let baseOrder: number[] = []
function refPos(x: number): string {
  const t = refTrav.find(t => t.x0 <= x && t.x1 >= x); if (!t || t.bp0 == null) return ''
  const f = (x - t.x0) / Math.max(1, t.x1 - t.x0); const bp = t.dir >= 0 ? t.bp0 + f * t.bp : t.bp0 + (1 - f) * t.bp
  return `${root!.haps[t.hid].hap.split('#')[0]} ${fmtbp(bp)}`
}
function draw() { try { drawCore() } catch (e) { showErr('draw', e) } }
function drawCore() {
  const W = cv.parentElement!.clientWidth, H = TOP + (root ? hapOrder.length * ROW : 0) + 20
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ov.width = cv.width; ov.height = cv.height; ov.style.width = cv.style.width; ov.style.height = cv.style.height; og.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, W, H)
  if (!root) return
  // 上段: 原子（色は番号、高さは通るハプロタイプ数）、境界（持続度で高さ）
  const [v0, v1] = view
  for (const a of root.atoms) {
    if (a.x1 < v0 || a.x0 > v1) continue
    const px0 = Math.max(LAB, X(a.x0)), px1 = Math.min(W, X(a.x1 + 1)); const h = 8 + 30 * Math.min(1, a.nhap / root.H)
    g.fillStyle = `hsla(${hue(a.id)}, 60%, 55%, .55)`; g.fillRect(px0, TOP - 12 - h, Math.max(1, px1 - px0), h)
    const st = atomStats[a.id - 1]; if (st && st.nhap2 > 0) { g.fillStyle = 'rgba(192,57,43,.9)'; g.fillRect(px0, TOP - 12, Math.max(1, px1 - px0), 3) }   // 2 回以上通るハプロタイプがある原子
    if (st && st.tangled) { g.fillStyle = 'rgba(0,0,0,.25)'; for (let xx = px0; xx < px1; xx += 6) g.fillRect(xx, TOP - 12 - h, 2, h) }   // もつれ（順序が線形にならない硬い領域）は斜線代わりの縦縞
    if (px1 - px0 > 40) { g.fillStyle = '#333'; g.font = '10px system-ui'; g.fillText(`#${a.id} ${fmtbp(a.bp)} ${a.nhap}/${root.H}${st && st.nhap2 ? ` ×${st.nhap2}` : ''}`, px0 + 2, TOP - 14 - h) }
  }
  if (($('showbounds') as HTMLInputElement).checked) for (const b of root.bounds) {
    if (b.x < v0 || b.x > v1) continue
    const px = X(b.x); const h = 6 + 8 * Math.log10(1 + b.persistence / 1000)
    g.strokeStyle = b.support >= root.H * 0.5 ? '#c0392b' : b.support >= 2 ? '#7f8c8d' : '#d0d0d0'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, TOP - 10); g.lineTo(px, TOP - 10 + h); g.stroke()
  }
  g.fillStyle = '#666'; g.font = '10px system-ui'; g.fillText(`x ${fmt(Math.floor(v0))} ${refPos(v0)}`, LAB + 2, TOP - 2); const t = `${refPos(v1)} x ${fmt(Math.ceil(v1))}`; g.fillText(t, W - g.measureText(t).width - 4, TOP - 2)
  // 行: ハプロタイプ ＞ コンティグ ＞ 通過。通過を原子ごとの片に割り、原子の色で塗る（同じ色＝同じブロック）
  const mode = ($('mode') as HTMLSelectElement).value; ROW = mode === 'rows' ? 22 : 13
  const byHap = new Map<number, Trav[]>(); for (const r of rows) { if (!byHap.has(r.hid)) byHap.set(r.hid, []); byHap.get(r.hid)!.push(r) }
  const cpByHap = new Map<number, Copy[]>(); for (const c of copies) { if (!cpByHap.has(c.hid)) cpByHap.set(c.hid, []); cpByHap.get(c.hid)!.push(c) }
  const rpByHap = new Map<number, Rep[]>(); for (const c of reps) { if (!rpByHap.has(c.hid)) rpByHap.set(c.hid, []); rpByHap.get(c.hid)!.push(c) }
  const atomsIn = root.atoms.filter(a => a.x1 >= v0 && a.x0 <= v1)
  type Piece = { atom: number; px0: number; px1: number; dir: number; tr: Trav }
  const lowerAtom = (arr: Atom[], x: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].x1 < x) lo = m + 1; else hi = m } return lo }   // x1 >= x の最初の原子（原子は x 順）
  const piecesOf = new Map<number, Piece[]>()      // hid → 片（画面座標）
  // 各行の並び: コンティグを最初の通過の座標順に詰め、コンティグの中は bp（通過の bp0 から）。行ごとに bp の総和を幅に合わせる
  const rowScale = new Map<number, { total: number; off: Map<number, number>; sep: number[] }>()
  for (const hid of hapOrder) {
    const ts = byHap.get(hid) || []; const pcs: Piece[] = []
    if (mode === 'rows') {
      const pids = [...new Set(ts.map(r => r.pid))].sort((a, b) => Math.min(...ts.filter(r => r.pid === a).map(r => r.x0)) - Math.min(...ts.filter(r => r.pid === b).map(r => r.x0)))
      const off = new Map<number, number>(); let tot = 0; const sep: number[] = []
      for (const pid of pids) { const trs = ts.filter(r => r.pid === pid); const lo = Math.min(...trs.map(r => r.bp0 ?? 0)), hi = Math.max(...trs.map(r => (r.bp0 ?? 0) + r.bp)); off.set(pid, tot - lo); tot += hi - lo; sep.push(tot) }
      rowScale.set(hid, { total: Math.max(1, tot), off, sep })
    }
    for (const r of ts) for (let ai = lowerAtom(atomsIn, r.x0); ai < atomsIn.length && atomsIn[ai].x0 <= r.x1; ai++) { const a = atomsIn[ai]
      if (a.x1 < r.x0 || a.x0 > r.x1) continue
      const c0 = Math.max(a.x0, r.x0), c1 = Math.min(a.x1, r.x1)
      if (mode === 'coord') pcs.push({ atom: a.id, px0: X(c0), px1: X(c1 + 1), dir: r.dir, tr: r })
      else {
        const sc = rowScale.get(hid)!; const L = Math.max(1, r.x1 - r.x0); const f0 = (c0 - r.x0) / L, f1 = (c1 + 1 - r.x0) / L
        const [b0, b1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]; const base = sc.off.get(r.pid)! + (r.bp0 ?? 0)
        const w = (W - LAB) / sc.total; pcs.push({ atom: a.id, px0: LAB + (base + b0 * r.bp) * w, px1: LAB + (base + b1 * r.bp) * w, dir: r.dir, tr: r })
      }
    }
    piecesOf.set(hid, pcs)
  }
  hapOrder.forEach((hid, k) => {
    const y = TOP + k * ROW; const hap = root!.haps[hid]
    g.fillStyle = k % 2 ? '#f2f2f2' : '#fafafa'; g.fillRect(0, y, W, ROW)
    const n = perHap[hid] || 0
    // 表示範囲が 1 原子に収まっているときだけ ×n（その原子をその株が n 回通る）。広い範囲では通過の数を薄く出す
    const oneAtom = root!.atoms.some(a => a.x0 <= v0 && a.x1 >= v1)
    g.fillStyle = oneAtom && n >= 2 ? '#b03a2e' : '#333'; g.font = '11px system-ui'; g.fillText(`${hap.hap}${hap.nexcl ? ` +${hap.nexcl}冗長` : ''}${oneAtom && n >= 2 ? ` ×${n}` : (n > 1 ? ` (${n})` : '')}`, 4, y + 10)
    const pcs = piecesOf.get(hid) || []
    // コンティグごとの主な向き（錨数で重み）と、コンティグ内の順が合意座標の順と合わない通過（転座: 最長の単調部分列に入らないもの）
    const inv = new Set<Trav>(), displaced = new Set<Trav>()
    for (const pid of new Set((byHap.get(hid) || []).map(r => r.pid))) {
      const trs = (byHap.get(hid) || []).filter(r => r.pid === pid).sort((a, b) => a.i0 - b.i0); const dom = trs.reduce((t, r) => t + r.dir * r.nanch, 0) >= 0 ? 1 : -1
      for (const r of trs) if (r.dir !== dom) inv.add(r)
      const seq = trs.map(r => dom >= 0 ? r.x0 : -r.x0); const n = seq.length; const L = new Array(n).fill(1), P = new Array(n).fill(-1)   // LIS
      for (let i2 = 0; i2 < n; i2++) for (let j2 = 0; j2 < i2; j2++) if (seq[j2] <= seq[i2] && L[j2] + 1 > L[i2]) { L[i2] = L[j2] + 1; P[i2] = j2 }
      let best = 0; for (let i2 = 1; i2 < n; i2++) if (L[i2] > L[best]) best = i2
      const keep = new Set<number>(); for (let i2 = best; i2 >= 0; i2 = P[i2]) keep.add(i2)
      trs.forEach((r, i2) => { if (!keep.has(i2) && r.nanch >= 50) displaced.add(r) })
    }
    for (const p of pcs) {
      const px0 = Math.max(LAB, Math.min(p.px0, p.px1)), px1 = Math.min(W, Math.max(p.px0, p.px1)); const w = Math.max(1, px1 - px0)
      const yy = (mode === 'coord' && displaced.has(p.tr)) ? y + 2 + BLK / 2 : y + 2; const hh = (mode === 'coord' && displaced.has(p.tr)) ? BLK / 2 : BLK   // 転座は下段に下げて細く
      g.fillStyle = `hsla(${hue(p.atom)}, 60%, 50%, ${p.tr.copy >= 1 ? .45 : .85})`; g.fillRect(px0, yy, w, hh)
      if (inv.has(p.tr)) { g.fillStyle = 'rgba(142,68,173,.95)'; g.fillRect(px0, y + 1, w, 2) }   // 逆位: 紫の上線
    }
    // 通過の向きの三角（通過ごとに 1 つ、端に）とコピー番号
    for (const r of byHap.get(hid) || []) {
      const ps = pcs.filter(p => p.tr === r); if (!ps.length) continue
      const lo = Math.min(...ps.map(p => Math.min(p.px0, p.px1))), hi = Math.max(...ps.map(p => Math.max(p.px0, p.px1))); if (hi - lo < 8) continue
      const fwd = mode === 'coord' ? r.dir >= 0 : true   // 各行の並びでは常にコンティグの向きに進む
      g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); if (fwd) { g.moveTo(hi - 6, y + 2); g.lineTo(hi - 1, y + 2 + BLK / 2); g.lineTo(hi - 6, y + 2 + BLK) } else { g.moveTo(lo + 6, y + 2); g.lineTo(lo + 1, y + 2 + BLK / 2); g.lineTo(lo + 6, y + 2 + BLK) } g.fill()
      if (r.copy >= 1 && hi - lo > 14) { g.fillStyle = '#7a3b00'; g.font = '9px system-ui'; g.fillText('·' + r.copy, lo + 2, y + 9) }
    }
    if (mode === 'rows') { const sc = rowScale.get(hid); if (sc) { g.fillStyle = '#222'; const w = (W - LAB) / sc.total; for (const sp of sc.sep.slice(0, -1)) g.fillRect(LAB + sp * w, y + 1, 1, BLK + 2) } }
    if (($('showreps') as HTMLInputElement).checked && mode === 'coord') for (const c of (rpByHap.get(hid) || [])) {   // 反復（出現単位）: 行の上辺に濃い赤
      const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.fillStyle = 'rgba(120,20,20,.9)'; g.fillRect(px0, y + 1, Math.max(1, px1 - px0), 2)
    }
    if (($('showcopies') as HTMLInputElement).checked && mode === 'coord') for (const c of (cpByHap.get(hid) || [])) {
      const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.strokeStyle = '#c0392b'; g.lineWidth = 2; g.beginPath(); g.moveTo(px0, y + BLK + 2); g.lineTo(px1, y + BLK + 2); g.stroke()
    }
  })
  if (sel) { g.fillStyle = 'rgba(52,152,219,.15)'; g.fillRect(sel[0], 0, sel[1] - sel[0], H); g.fillStyle = '#c0392b'; g.font = '12px system-ui'; g.fillText('計算中…', sel[0] + 4, 14) }
  // 連結線: 合意座標を等間隔に標本し、隣の行でその座標を含む片の中の位置を結ぶ（密度が一定になる。原子ごとだと再編成の所に線が集中して黒くなる）
  if (mode === 'rows' && ($('showlines') as HTMLInputElement).checked) {
    g.lineWidth = 1
    const nS = Math.max(8, Math.floor((W - LAB) / 14)); const xsS: number[] = []; for (let k = 0; k < nS; k++) xsS.push(v0 + (k + 0.5) / nS * (v1 - v0))
    const posIn = (pcs: Piece[], x: number): number[] => { const out: number[] = []; for (const p of pcs) { const a = root!.atoms[p.atom - 1]; if (!a || a.x1 < x || a.x0 > x) continue; const c0 = Math.max(a.x0, p.tr.x0), c1 = Math.min(a.x1, p.tr.x1); if (x < c0 || x > c1 + 1) continue; const f = (x - c0) / Math.max(1, c1 + 1 - c0); const fx = p.tr.dir >= 0 ? f : 1 - f; out.push(p.px0 + fx * (p.px1 - p.px0)) } return out }
    for (let k = 0; k + 1 < hapOrder.length; k++) {
      const A = piecesOf.get(hapOrder[k]) || [], B = piecesOf.get(hapOrder[k + 1]) || []; const yA = TOP + k * ROW + 2 + BLK, yB = TOP + (k + 1) * ROW + 2
      for (const x of xsS) {
        const pa = posIn(A, x), pb = posIn(B, x); if (!pa.length || !pb.length) continue
        const a = root!.atoms.find(a => a.x0 <= x && a.x1 >= x); g.strokeStyle = `hsla(${a ? hue(a.id) : 0}, 60%, 40%, ${pa.length * pb.length > 1 ? .7 : .4})`
        for (const xa of pa) for (const xb of pb) { if (xa < LAB || xb < LAB) continue; g.beginPath(); g.moveTo(xa, yA); g.lineTo(xb, yB); g.stroke() }
      }
    }
  }
}
// 操作
let drag: [number, number] | null = null; let sel: [number, number] | null = null   // sel: 読み込み中に残す選択の矩形（画面 px）
cv.addEventListener('mousedown', e => { const inRows = ($('mode') as HTMLSelectElement).value === 'rows'; if (e.offsetX > LAB && (!inRows || e.offsetY < TOP)) drag = [e.offsetX, e.offsetX] })   // 各行の並びでは上段だけ（行の中は座標に写せない）
cv.addEventListener('mousemove', e => {
  if (drag) { drag[1] = e.offsetX; og.clearRect(0, 0, ov.width, ov.height); og.fillStyle = 'rgba(52,152,219,.2)'; og.fillRect(Math.min(drag[0], drag[1]), 0, Math.abs(drag[1] - drag[0]), ov.height); return }   // ドラッグ中は本体を描き直さない（重い）
  if (!root) return
  const k = Math.floor((e.offsetY - TOP) / ROW); const x = xOfPx(e.offsetX)
  if (e.offsetY < TOP && e.offsetX >= LAB) {
    const a = root.atoms.find(a => a.x0 <= x && a.x1 >= x); if (!a) { tip.style.display = 'none'; return }
    const st = atomStats[a.id - 1]; const multi = st ? Object.entries(st.counts).filter(([, n]) => n >= 2).map(([h, n]) => `${root!.haps[Number(h)].hap} ×${n}`) : []
    tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
    tip.textContent = `原子 #${a.id}  座標 ${fmt(a.x0)}–${fmt(a.x1)}  ${fmtbp(a.bp)}  通るハプロタイプ ${st ? st.nhap : a.nhap}/${root.H}  ${refPos(a.x0)}${st && st.tangled ? '  【もつれ: 順序が線形にならない領域。×n は数えない】' : ''}` + (multi.length ? `\n2 回以上: ${multi.slice(0, 12).join(', ')}${multi.length > 12 ? ` +${multi.length - 12}` : ''}` : '')
    return
  }
  if (k < 0 || k >= hapOrder.length || e.offsetX < LAB) { tip.style.display = 'none'; return }
  const hid = hapOrder[k]; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'
  const hit = inRows ? rows.filter(r => r.hid === hid).slice(0, 6) : rows.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x); const rhit = inRows ? [] : reps.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  if (!hit.length && !rhit.length) { tip.style.display = 'none'; return }
  tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
  tip.textContent = hit.map(r => `${root!.haps[r.hid].hap}  pid ${r.pid}  トークン ${fmt(r.i0)}–${fmt(r.i1)}${r.bp0 != null ? `  コンティグ ${fmtbp(r.bp0)}〜` : ''}  座標 ${fmt(r.x0)}–${fmt(r.x1)}  ${r.dir >= 0 ? '→' : '←'}  錨 ${fmt(r.nanch)}  ${fmtbp(r.bp)}${r.copy ? `  コピー ·${r.copy}` : ''}`).concat(rhit.map(r => `反復（この株で 2 回以上出るノードの連なり） トークン ${fmt(r.i0)}–${fmt(r.i1)}  ${fmtbp(r.bp)}`)).join('\n')
})
window.addEventListener('mouseup', e => { if (!drag) return; const [a, b] = [Math.min(...drag), Math.max(...drag)]; drag = null; og.clearRect(0, 0, ov.width, ov.height); if (b - a < 4) return; hist.push(view); view = [xOfPx(a), xOfPx(b)]; sel = [a, b]; draw(); loadRange() })
cv.addEventListener('dblclick', e => { if (!root) return; hist.push(view); if (e.offsetY < TOP && e.offsetX >= LAB) { const x = xOfPx(e.offsetX); const a = root.atoms.find(a => a.x0 <= x && a.x1 >= x); view = a ? [a.x0, a.x1] : [0, root.R - 1] } else view = [0, root.R - 1]; loadRange() })
cv.addEventListener('wheel', e => { if (!root || e.offsetX < LAB) return; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'; if (inRows && e.offsetY >= TOP) return; e.preventDefault(); const x = xOfPx(e.offsetX); const f = e.deltaY > 0 ? 1.25 : 0.8; const n0 = x - (x - view[0]) * f, n1 = x + (view[1] - x) * f; hist.push(view); view = [Math.max(0, n0), Math.min(root.R - 1, n1)]; draw(); scheduleRange() }, { passive: false })
$('all').addEventListener('click', () => { if (!root) return; hist.push(view); view = [0, root.R - 1]; loadRange() })
$('back').addEventListener('click', () => { const v = hist.pop(); if (v) { view = v; loadRange() } })
$('minanch').addEventListener('change', () => { loadRange(); loadAtoms() }); $('showcopies').addEventListener('change', draw); $('showbounds').addEventListener('change', draw); $('showreps').addEventListener('change', draw); $('mode').addEventListener('change', draw); $('showlines').addEventListener('change', draw); $('order').addEventListener('change', () => { hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice(); draw() })
$('db').addEventListener('change', () => { db = ($('db') as HTMLSelectElement).value; history.replaceState(null, '', `?db=${encodeURIComponent(db)}`); loadRoot() })
window.addEventListener('resize', draw)
loadDbList().then(loadRoot)
