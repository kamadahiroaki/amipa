// 通過（traversal）の試作ページ。`<db>.trav`（functions/anchor2/build/synteny2_build.py）を /api/trav/* で読む。設計: plans/anchor2-traversals.md
// 上段: 表示範囲を持続度の高い境界で K 個のブロックに切る（予算切り。原子をそのまま出すと全景で細かすぎる）。横軸は bp に比例（原子の bp を累積）。
// 行: ハプロタイプ ＞ コンティグ ＞ 通過をブロックごとの片に割り、ブロックの色で塗る（同じ色＝同じブロック＝株間の対応）。
//   合意座標モード: 片はその座標の位置。逆位（コンティグの主な向きと逆）は下段に下げて紫の枠と左向きの三角、転座（コンティグ内の順が合意と違う）は下段に灰の枠。
//   各行の並びモード: 行ごとにコンティグを bp の順に詰める。1 コンティグの株（環状）は、主な向きが逆なら鏡にし、座標の最小の通過が左に来るよう回す。
//   連結線は bp で等間隔に標本し、隣の行の同じ場所を結ぶ（密度が一定）。
type Atom = { id: number; x0: number; x1: number; bp: number; nhap: number }
type Bound = { x: number; support: number; persistence: number }
type Hap = { hid: number; hap: string; ncontig: number; nexcl: number; bp: number }
type Trav = { id: number; pid: number; hid: number; i0: number; i1: number; x0: number; x1: number; dir: number; copy: number; nanch: number; bp: number; bp0?: number }
type Copy = { id: number; pid: number; hid: number; x0: number; x1: number; ia0: number; ia1: number; ib0: number; ib1: number; bpa: number; bpb: number }
type Rep = { id: number; pid: number; hid: number; i0: number; i1: number; bp: number; x0: number; x1: number }
type AtomStat = { id: number; nhap: number; nhap2: number; tangled?: boolean; counts: Record<string, number> }
type Root = { meta: any; H: number; R: number; total_bp: number; haps: Hap[]; atoms: Atom[]; bounds: Bound[] }
type Block = { id: number; x0: number; x1: number; bp: number; a0: number; a1: number; nhap: number; nhap2: number; tangled: boolean }

const $ = (id: string) => document.getElementById(id) as HTMLElement
const cv = $('cv') as HTMLCanvasElement; const g = cv.getContext('2d')!; const tip = $('tip'); const ov = $('ov') as HTMLCanvasElement; const og = ov.getContext('2d')!
const TOP = 70, LAB = 150, BLK = 8; let ROW = 13
let db = '', root: Root | null = null, view: [number, number] = [0, 1], hist: [number, number][] = []
let rows: Trav[] = [], copies: Copy[] = [], reps: Rep[] = [], perHap: Record<string, number> = {}, loading = 0
let hapOrder: number[] = [], baseOrder: number[] = [], atomStats: AtomStat[] = [], refTrav: Trav[] = []
let atomCum: number[] = []        // 原子 i の開始 bp（root.atoms の順）
let blocks: Block[] = []           // 今の表示範囲のブロック
const fmt = (n: number) => n.toLocaleString('en-US')
const fmtbp = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + ' Mb' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kb' : Math.round(n) + ' bp'
function showErr(where: string, e: any) { $('info').textContent = 'エラー ' + `${where}: ${e && (e.stack || e.message || e)}`.slice(0, 400); $('info').style.color = '#c0392b'; $('busy').style.display = 'none'; console.error(where, e) }
window.addEventListener('error', ev => showErr('window', ev.error || ev.message)); window.addEventListener('unhandledrejection', ev => showErr('promise', (ev as any).reason))
const hue = (i: number) => (i * 137.508) % 360
const numOf = (id: string, dflt: number) => { const v = Number(($(id) as HTMLInputElement).value); return Number.isFinite(v) ? v : dflt }

// ---- 座標 ↔ bp ↔ 画面 ----
function atomAt(x: number): number { const A = root!.atoms; let lo = 0, hi = A.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (A[m].x1 < x) lo = m + 1; else hi = m } return lo }
function bpOfX(x: number): number { if (!root || !root.atoms.length) return x; const A = root.atoms; const i = Math.max(0, Math.min(A.length - 1, atomAt(x))); const a = A[i]; const f = Math.max(0, Math.min(1, (x - a.x0) / (a.x1 - a.x0 + 1))); return atomCum[i] + f * a.bp }
function xOfBp(bp: number): number { if (!root || !root.atoms.length) return bp; const A = root.atoms; let lo = 0, hi = A.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (atomCum[m] + A[m].bp < bp) lo = m + 1; else hi = m } const a = A[lo]; const f = Math.max(0, Math.min(1, (bp - atomCum[lo]) / Math.max(1, a.bp))); return a.x0 + f * (a.x1 - a.x0 + 1) }
const wPx = () => cv.width / devicePixelRatio - LAB
function X(x: number) { const b0 = bpOfX(view[0]), b1 = bpOfX(view[1] + 1); return LAB + (bpOfX(x) - b0) / Math.max(1, b1 - b0) * wPx() }
function xOfPx(px: number) { const b0 = bpOfX(view[0]), b1 = bpOfX(view[1] + 1); return xOfBp(b0 + (px - LAB) / wPx() * (b1 - b0)) }
function refPos(x: number): string {
  const t = refTrav.find(t => t.x0 <= x && t.x1 >= x); if (!t || t.bp0 == null) return ''
  const f = (x - t.x0) / Math.max(1, t.x1 - t.x0); const bp = t.dir >= 0 ? t.bp0 + f * t.bp : t.bp0 + (1 - f) * t.bp
  return `${root!.haps[t.hid].hap.split('#')[0]} ${fmtbp(bp)}`
}

// ---- ブロック: 表示範囲の境界を持続度の高い順に K−1 本残す ----
function makeBlocks(): Block[] {
  if (!root) return []
  const [v0, v1] = view; const K = Math.max(1, numOf('nblk', 30))
  const inside = root.bounds.filter(b => b.x > v0 && b.x <= v1).sort((a, b) => b.persistence - a.persistence).slice(0, K - 1).map(b => b.x).sort((a, b) => a - b)
  const edges = [Math.floor(v0), ...inside, Math.floor(v1) + 1]; const out: Block[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const x0 = edges[i], x1 = edges[i + 1] - 1; if (x1 < x0) continue
    const a0 = atomAt(x0), a1 = atomAt(x1); let nhap = 0, nhap2 = 0, tangled = false
    for (let k = a0; k <= a1; k++) { const st = atomStats[k]; const a = root.atoms[k]; nhap = Math.max(nhap, st ? st.nhap : a.nhap); if (st) { nhap2 = Math.max(nhap2, st.nhap2); tangled = tangled || !!st.tangled } }
    out.push({ id: i, x0, x1, bp: bpOfX(x1 + 1) - bpOfX(x0), a0, a1, nhap, nhap2, tangled })
  }
  return out
}
function blockAt(x: number): number { let lo = 0, hi = blocks.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (blocks[m].x1 < x) lo = m + 1; else hi = m } return lo }

// ---- 読み込み ----
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
  atomCum = []; let c = 0; for (const a of root!.atoms) { atomCum.push(c); c += a.bp }
  const refLike = (h: string) => /^(GRCh38|CHM13|GCF_000148365)/.test(h) ? 0 : 1
  baseOrder = root!.haps.map(h => h.hid).sort((a, b) => refLike(root!.haps[a].hap) - refLike(root!.haps[b].hap) || root!.haps[a].hap.localeCompare(root!.haps[b].hap)); hapOrder = baseOrder.slice()
  atomStats = []; await loadAtoms(); await loadRange()
}
async function loadAtoms() {
  if (!root) return
  const r = await fetch(`/api/trav/atoms?db=${encodeURIComponent(db)}&minanch=${numOf('minanch', 50)}`); atomStats = r.ok ? (await r.json()).atoms : []
  const refH = root.haps.find(h => /^(GRCh38|CHM13)/.test(h.hap)); refTrav = []
  if (refH) { const rr = await fetch(`/api/trav/range?db=${encodeURIComponent(db)}&x0=0&x1=${root.R}&minanch=1000`); if (rr.ok) refTrav = ((await rr.json()).trav as Trav[]).filter(t => t.hid === refH.hid) }
}
let rangeTimer: any = null
function scheduleRange(ms = 120) { if (rangeTimer) clearTimeout(rangeTimer); $('busy').style.display = 'inline'; rangeTimer = setTimeout(() => { rangeTimer = null; loadRange() }, ms) }
async function loadRange() {
  if (!root) return
  const my = ++loading; $('busy').style.display = 'inline'
  try {
    const r = await fetch(`/api/trav/range?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}`)
    if (my !== loading) return
    const j = await r.json(); rows = j.trav; copies = j.copies; reps = j.reps || []; perHap = j.perHap; sel = null; $('info').style.color = ''
    blocks = makeBlocks()
    hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice()
    const nh2 = Object.values(perHap).filter(n => (n as number) >= 2).length
    $('info').textContent = `${db}: 座標 ${fmt(Math.floor(view[0]))}–${fmt(Math.ceil(view[1]))} / ${fmt(root.R)}（${fmtbp(j.bp0)}–${fmtbp(j.bp1)}） ブロック ${blocks.length}（原子 ${root.atoms.length}） 通過 ${fmt(rows.length)} コピー ${fmt(copies.length)} 2 回以上通る株 ${nh2} | 錨 強 ${fmt(root.meta.strong)} 補間 ${fmt(root.meta.interp)}`
  } catch (e) { showErr('range', e) }
  $('busy').style.display = 'none'; draw()
}

// ---- 表示範囲の木（UPGMA）: ブロックごとの状態（無し/順/逆/両方）の bp 重み不一致率 ----
function treeOrder(): number[] {
  if (!root || !blocks.length) return baseOrder.slice()
  const H = root.haps.length, nb = blocks.length; const state = new Uint8Array(H * nb)
  const dom = new Map<number, number>(); for (const r of rows) dom.set(r.pid, (dom.get(r.pid) || 0) + r.dir * r.nanch)
  for (const r of rows) { const d = (dom.get(r.pid) || 0) >= 0 ? r.dir : -r.dir; for (let bi = blockAt(r.x0); bi < nb && blocks[bi].x0 <= r.x1; bi++) { const k = r.hid * nb + bi; const nv = d >= 0 ? 1 : 2; state[k] = state[k] === 0 ? nv : (state[k] === nv ? nv : 3) } }
  const w = blocks.map(b => Math.max(1, b.bp)); const wsum = w.reduce((a, b) => a + b, 0)
  const ids = baseOrder.slice(); const n = ids.length; const D: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let dsum = 0; for (let k = 0; k < nb; k++) { const a = state[ids[i] * nb + k], b = state[ids[j] * nb + k]; if (a !== b) dsum += w[k] * (a === 0 || b === 0 ? 1 : 0.5) } D[i][j] = D[j][i] = dsum / wsum }
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

// ---- 描画 ----
type Piece = { blk: number; px0: number; px1: number; tr: Trav; inv: boolean; disp: boolean }
let lastPieces = new Map<number, Piece[]>()
function draw() { try { drawCore() } catch (e) { showErr('draw', e) } }
function drawCore() {
  const W = cv.parentElement!.clientWidth; const mode = ($('mode') as HTMLSelectElement).value; ROW = mode === 'rows' ? 22 : 15
  const H = TOP + (root ? hapOrder.length * ROW : 0) + 20
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ov.width = cv.width; ov.height = cv.height; ov.style.width = cv.style.width; ov.style.height = cv.style.height; og.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, W, H)
  if (!root) return
  const [v0, v1] = view
  // 上段: ブロック（色は番号、高さは通るハプロタイプの割合）、×n の赤い帯、もつれの縦縞、境界（支持と持続度）
  for (const b of blocks) {
    const px0 = Math.max(LAB, X(b.x0)), px1 = Math.min(W, X(b.x1 + 1)); const h = 8 + 30 * Math.min(1, b.nhap / root.H)
    g.fillStyle = `hsla(${hue(b.id)}, 60%, 55%, .6)`; g.fillRect(px0, TOP - 12 - h, Math.max(1, px1 - px0), h)
    if (b.nhap2 > 0) { g.fillStyle = 'rgba(192,57,43,.9)'; g.fillRect(px0, TOP - 12, Math.max(1, px1 - px0), 3) }
    if (b.tangled) { g.fillStyle = 'rgba(0,0,0,.25)'; for (let xx = px0; xx < px1; xx += 6) g.fillRect(xx, TOP - 12 - h, 2, h) }
    if (px1 - px0 > 44) { g.fillStyle = '#333'; g.font = '10px system-ui'; g.fillText(`${fmtbp(b.bp)} ${b.nhap}/${root.H}${b.nhap2 ? ` ×${b.nhap2}` : ''}`, px0 + 2, TOP - 14 - h) }
  }
  if (($('showbounds') as HTMLInputElement).checked) for (const b of root.bounds) {
    if (b.x < v0 || b.x > v1) continue
    const px = X(b.x); const h = 6 + 8 * Math.log10(1 + b.persistence / 1000)
    g.strokeStyle = b.support >= root.H * 0.5 ? '#c0392b' : b.support >= 2 ? '#7f8c8d' : '#d0d0d0'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, TOP - 10); g.lineTo(px, TOP - 10 + h); g.stroke()
  }
  g.fillStyle = '#666'; g.font = '10px system-ui'; g.fillText(`${fmtbp(bpOfX(v0))}  x ${fmt(Math.floor(v0))} ${refPos(v0)}`, LAB + 2, TOP - 2); const tt = `${refPos(v1)} x ${fmt(Math.ceil(v1))}  ${fmtbp(bpOfX(v1 + 1))}`; g.fillText(tt, W - g.measureText(tt).width - 4, TOP - 2)

  // 行
  const byHap = new Map<number, Trav[]>(); for (const r of rows) { if (!byHap.has(r.hid)) byHap.set(r.hid, []); byHap.get(r.hid)!.push(r) }
  const cpByHap = new Map<number, Copy[]>(); for (const c of copies) { if (!cpByHap.has(c.hid)) cpByHap.set(c.hid, []); cpByHap.get(c.hid)!.push(c) }
  const rpByHap = new Map<number, Rep[]>(); for (const c of reps) { if (!rpByHap.has(c.hid)) rpByHap.set(c.hid, []); rpByHap.get(c.hid)!.push(c) }
  const piecesOf = new Map<number, Piece[]>()
  for (const hid of hapOrder) {
    const ts = byHap.get(hid) || []; const pcs: Piece[] = []
    // コンティグごとの主な向きと、コンティグ内の順が合意と合わない通過（転座: 最長単調部分列から外れるもの）
    const pids = [...new Set(ts.map(r => r.pid))]; const inv = new Set<Trav>(), disp = new Set<Trav>(); const domOf = new Map<number, number>(); const firstX = new Map<number, number>()
    for (const pid of pids) {
      const trs = ts.filter(r => r.pid === pid).sort((a, b) => a.i0 - b.i0); const dom = trs.reduce((t, r) => t + r.dir * r.nanch, 0) >= 0 ? 1 : -1; domOf.set(pid, dom); firstX.set(pid, Math.min(...trs.map(r => r.x0)))
      for (const r of trs) if (r.dir !== dom) inv.add(r)
      const seq = trs.map(r => dom >= 0 ? r.x0 : -r.x0); const n = seq.length; const L = new Array(n).fill(1), P = new Array(n).fill(-1)
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (seq[j] <= seq[i] && L[j] + 1 > L[i]) { L[i] = L[j] + 1; P[i] = j }
      let best = 0; for (let i = 1; i < n; i++) if (L[i] > L[best]) best = i
      const keep = new Set<number>(); for (let i = best; i >= 0; i = P[i]) keep.add(i)
      trs.forEach((r, i) => { if (!keep.has(i) && r.nanch >= 50) disp.add(r) })
    }
    // 各行の並び: コンティグを座標順に詰める。1 コンティグなら主な向きで鏡にし、座標最小の通過が左に来るよう回す（環状）
    let scale = 1, offOf = new Map<number, number>(), total = 1, mirror = new Map<number, boolean>(), rot = 0
    if (mode === 'rows') {
      const order = pids.slice().sort((a, b) => firstX.get(a)! - firstX.get(b)!); let tot = 0
      for (const pid of order) { const trs = ts.filter(r => r.pid === pid); const lo = Math.min(...trs.map(r => r.bp0 ?? 0)), hi = Math.max(...trs.map(r => (r.bp0 ?? 0) + r.bp)); offOf.set(pid, tot - lo); mirror.set(pid, domOf.get(pid)! < 0); tot += hi - lo }
      total = Math.max(1, tot); scale = wPx() / total
      if (pids.length === 1) { const pid = pids[0]; const r0 = ts.reduce((m, r) => r.x0 < m.x0 ? r : m, ts[0]); const b0 = (r0.bp0 ?? 0), b1 = b0 + r0.bp; const tlen = root.haps[hid].bp || total; const start = mirror.get(pid) ? tlen - b1 : b0; rot = start - (Math.min(...ts.map(r => r.bp0 ?? 0))); total = Math.max(1, tlen); scale = wPx() / total }
    }
    const pos = (r: Trav, bp: number) => {   // コンティグ上の bp → 行の画面 x（各行の並び）
      const tlen = root!.haps[hid].bp || total; let b = mirror.get(r.pid) ? (pids.length === 1 ? tlen - bp : (offOf.get(r.pid)! * 0 + (Math.max(...(byHap.get(hid) || []).filter(q => q.pid === r.pid).map(q => (q.bp0 ?? 0) + q.bp)) + Math.min(...(byHap.get(hid) || []).filter(q => q.pid === r.pid).map(q => q.bp0 ?? 0))) - bp)) : bp
      if (pids.length === 1) { b = b - rot; if (b < 0) b += tlen; if (b >= tlen) b -= tlen } else b += offOf.get(r.pid)!
      return LAB + b * scale
    }
    for (const r of ts) for (let bi = blockAt(r.x0); bi < blocks.length && blocks[bi].x0 <= r.x1; bi++) {
      const b = blocks[bi]; if (b.x1 < r.x0) continue
      const c0 = Math.max(b.x0, r.x0), c1 = Math.min(b.x1, r.x1)
      if (mode === 'coord') pcs.push({ blk: bi, px0: X(c0), px1: X(c1 + 1), tr: r, inv: inv.has(r), disp: disp.has(r) })
      else { const L = Math.max(1, r.x1 - r.x0); const f0 = (c0 - r.x0) / L, f1 = (c1 + 1 - r.x0) / L; const [q0, q1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]; const base = r.bp0 ?? 0
        pcs.push({ blk: bi, px0: pos(r, base + q0 * r.bp), px1: pos(r, base + q1 * r.bp), tr: r, inv: inv.has(r), disp: disp.has(r) }) }
    }
    piecesOf.set(hid, pcs)
  }
  lastPieces = piecesOf
  hapOrder.forEach((hid, k) => {
    const y = TOP + k * ROW; const hap = root!.haps[hid]
    g.fillStyle = k % 2 ? '#f2f2f2' : '#fafafa'; g.fillRect(0, y, W, ROW)
    const n = perHap[hid] || 0; const oneBlk = blocks.length === 1
    g.fillStyle = oneBlk && n >= 2 ? '#b03a2e' : '#333'; g.font = '11px system-ui'; g.fillText(`${hap.hap}${hap.nexcl ? ` +${hap.nexcl}冗長` : ''}${oneBlk && n >= 2 ? ` ×${n}` : (n > 1 ? ` (${n})` : '')}`, 4, y + 10)
    const pcs = piecesOf.get(hid) || []
    for (const p of pcs) {
      const px0 = Math.max(LAB, Math.min(p.px0, p.px1)), px1 = Math.min(W, Math.max(p.px0, p.px1)); const w = Math.max(1, px1 - px0); const low = mode === 'coord' && (p.inv || p.disp)
      const yy = low ? y + 2 + BLK / 2 : y + 2, hh = low ? BLK / 2 + 1 : BLK
      g.fillStyle = `hsla(${hue(p.blk)}, 60%, 50%, ${p.tr.copy >= 1 ? .45 : .85})`; g.fillRect(px0, yy, w, hh)
      if (p.inv) { g.strokeStyle = '#8e44ad'; g.lineWidth = 1.5; g.strokeRect(px0 + .5, yy + .5, w - 1, hh - 1); if (w > 10 && mode === 'coord') { g.fillStyle = '#8e44ad'; g.beginPath(); g.moveTo(px0 + 7, yy); g.lineTo(px0 + 1, yy + hh / 2); g.lineTo(px0 + 7, yy + hh); g.fill() } }
      else if (p.disp && mode === 'coord') { g.strokeStyle = '#555'; g.lineWidth = 1; g.strokeRect(px0 + .5, yy + .5, w - 1, hh - 1) }
    }
    for (const r of byHap.get(hid) || []) {   // 通過ごとに向きの三角（右端または左端）とコピー番号
      const ps = pcs.filter(p => p.tr === r); if (!ps.length) continue
      const lo = Math.max(LAB, Math.min(...ps.map(p => Math.min(p.px0, p.px1)))), hi = Math.min(W, Math.max(...ps.map(p => Math.max(p.px0, p.px1)))); if (hi - lo < 10) continue
      const fwd = mode === 'coord' ? r.dir >= 0 : true; const yy = (mode === 'coord' && (ps[0].inv || ps[0].disp)) ? y + 2 + BLK / 2 : y + 2, hh = (mode === 'coord' && (ps[0].inv || ps[0].disp)) ? BLK / 2 + 1 : BLK
      if (!(ps[0].inv && mode === 'coord')) { g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); if (fwd) { g.moveTo(hi - 6, yy); g.lineTo(hi - 1, yy + hh / 2); g.lineTo(hi - 6, yy + hh) } else { g.moveTo(lo + 6, yy); g.lineTo(lo + 1, yy + hh / 2); g.lineTo(lo + 6, yy + hh) } g.fill() }
      if (r.copy >= 1 && hi - lo > 14) { g.fillStyle = '#7a3b00'; g.font = '9px system-ui'; g.fillText('·' + r.copy, lo + 2, y + 9) }
    }
    if (($('showreps') as HTMLInputElement).checked && mode === 'coord') for (const c of (rpByHap.get(hid) || [])) { const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.fillStyle = 'rgba(120,20,20,.9)'; g.fillRect(px0, y + 1, Math.max(1, px1 - px0), 2) }
    if (($('showcopies') as HTMLInputElement).checked && mode === 'coord') for (const c of (cpByHap.get(hid) || [])) { const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.strokeStyle = '#c0392b'; g.lineWidth = 2; g.beginPath(); g.moveTo(px0, y + BLK + 3); g.lineTo(px1, y + BLK + 3); g.stroke() }
  })
  if (sel) { g.fillStyle = 'rgba(52,152,219,.15)'; g.fillRect(sel[0], 0, sel[1] - sel[0], H); g.fillStyle = '#c0392b'; g.font = '12px system-ui'; g.fillText('計算中…', sel[0] + 4, 14) }
  // 連結線: bp で等間隔に標本し、隣の行でその座標を含む片の中の位置を結ぶ
  if (mode === 'rows' && ($('showlines') as HTMLInputElement).checked) {
    g.lineWidth = 1; const nS = Math.max(8, Math.floor((W - LAB) / 12)); const xsS: number[] = []; for (let k = 0; k < nS; k++) xsS.push(xOfPx(LAB + (k + 0.5) / nS * (W - LAB)))
    const posIn = (pcs: Piece[], x: number): number[] => { const out: number[] = []; for (const p of pcs) { const b = blocks[p.blk]; const c0 = Math.max(b.x0, p.tr.x0), c1 = Math.min(b.x1, p.tr.x1); if (x < c0 || x > c1 + 1) continue; const f = (x - c0) / Math.max(1, c1 + 1 - c0); const fx = p.tr.dir >= 0 ? f : 1 - f; out.push(p.px0 + fx * (p.px1 - p.px0)) } return out }
    for (let k = 0; k + 1 < hapOrder.length; k++) {
      const A = piecesOf.get(hapOrder[k]) || [], B = piecesOf.get(hapOrder[k + 1]) || []; const yA = TOP + k * ROW + 2 + BLK, yB = TOP + (k + 1) * ROW + 2
      for (const x of xsS) {
        const pa = posIn(A, x), pb = posIn(B, x); if (!pa.length || !pb.length) continue
        g.strokeStyle = `hsla(${hue(blockAt(x))}, 60%, 40%, ${pa.length * pb.length > 1 ? .7 : .4})`
        for (const xa of pa) for (const xb of pb) { if (xa < LAB || xb < LAB) continue; g.beginPath(); g.moveTo(xa, yA); g.lineTo(xb, yB); g.stroke() }
      }
    }
  }
}
// ---- 操作 ----
let drag: [number, number] | null = null; let sel: [number, number] | null = null
cv.addEventListener('mousedown', e => { const inRows = ($('mode') as HTMLSelectElement).value === 'rows'; if (e.offsetX > LAB && (!inRows || e.offsetY < TOP)) drag = [e.offsetX, e.offsetX] })
cv.addEventListener('mousemove', e => {
  if (drag) { drag[1] = e.offsetX; og.clearRect(0, 0, ov.width, ov.height); og.fillStyle = 'rgba(52,152,219,.2)'; og.fillRect(Math.min(drag[0], drag[1]), 0, Math.abs(drag[1] - drag[0]), ov.height); return }
  if (!root) return
  const k = Math.floor((e.offsetY - TOP) / ROW); const x = xOfPx(e.offsetX)
  if (e.offsetY < TOP && e.offsetX >= LAB) {
    const b = blocks[blockAt(x)]; if (!b) { tip.style.display = 'none'; return }
    const multi: string[] = []; for (let a = b.a0; a <= b.a1; a++) { const st = atomStats[a]; if (!st || st.tangled) continue; for (const [h, n] of Object.entries(st.counts)) if (n >= 2) multi.push(`${root!.haps[Number(h)].hap} ×${n}`) }
    tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
    tip.textContent = `ブロック ${b.id + 1}/${blocks.length}  座標 ${fmt(b.x0)}–${fmt(b.x1)}  ${fmtbp(b.bp)}  原子 #${b.a0 + 1}–#${b.a1 + 1}  通るハプロタイプ ${b.nhap}/${root.H}  ${refPos(b.x0)}${b.tangled ? '  【もつれ: 順序が線形にならない領域を含む】' : ''}` + (multi.length ? `\n2 回以上: ${[...new Set(multi)].slice(0, 12).join(', ')}` : '')
    return
  }
  if (k < 0 || k >= hapOrder.length || e.offsetX < LAB) { tip.style.display = 'none'; return }
  const hid = hapOrder[k]; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'
  const hit = inRows ? (lastPieces.get(hid) || []).filter(p => Math.min(p.px0, p.px1) <= e.offsetX && Math.max(p.px0, p.px1) >= e.offsetX).map(p => p.tr).filter((v, i, a) => a.indexOf(v) === i) : rows.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  const rhit = inRows ? [] : reps.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  if (!hit.length && !rhit.length) { tip.style.display = 'none'; return }
  tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
  tip.textContent = hit.map(r => `${root!.haps[r.hid].hap}  pid ${r.pid}  トークン ${fmt(r.i0)}–${fmt(r.i1)}${r.bp0 != null ? `  コンティグ ${fmtbp(r.bp0)}〜` : ''}  座標 ${fmt(r.x0)}–${fmt(r.x1)}  ${r.dir >= 0 ? '→' : '←'}  錨 ${fmt(r.nanch)}  ${fmtbp(r.bp)}${r.copy ? `  コピー ·${r.copy}` : ''}`).concat(rhit.map(r => `反復（この株で 2 回以上出るノードの連なり） トークン ${fmt(r.i0)}–${fmt(r.i1)}  ${fmtbp(r.bp)}`)).join('\n')
})
window.addEventListener('mouseup', () => { if (!drag) return; const [a, b] = [Math.min(...drag), Math.max(...drag)]; drag = null; og.clearRect(0, 0, ov.width, ov.height); if (b - a < 4) return; hist.push(view); view = [xOfPx(a), xOfPx(b)]; sel = [a, b]; draw(); loadRange() })
cv.addEventListener('dblclick', e => { if (!root) return; hist.push(view); if (e.offsetY < TOP && e.offsetX >= LAB) { const b = blocks[blockAt(xOfPx(e.offsetX))]; view = b ? [b.x0, b.x1] : [0, root.R - 1] } else view = [0, root.R - 1]; loadRange() })
cv.addEventListener('wheel', e => { if (!root || e.offsetX < LAB) return; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'; if (inRows && e.offsetY >= TOP) return; e.preventDefault(); const x = xOfPx(e.offsetX); const f = e.deltaY > 0 ? 1.25 : 0.8; const n0 = x - (x - view[0]) * f, n1 = x + (view[1] - x) * f; hist.push(view); view = [Math.max(0, n0), Math.min(root.R - 1, n1)]; draw(); scheduleRange() }, { passive: false })
$('all').addEventListener('click', () => { if (!root) return; hist.push(view); view = [0, root.R - 1]; loadRange() })
$('back').addEventListener('click', () => { const v = hist.pop(); if (v) { view = v; loadRange() } })
$('minanch').addEventListener('change', () => { loadAtoms().then(loadRange) }); $('nblk').addEventListener('change', () => { blocks = makeBlocks(); if (($('order') as HTMLSelectElement).value === 'tree') hapOrder = treeOrder(); draw() })
for (const id of ['showcopies', 'showbounds', 'showreps', 'mode', 'showlines']) $(id).addEventListener('change', draw)
$('order').addEventListener('change', () => { hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice(); draw() })
$('db').addEventListener('change', () => { db = ($('db') as HTMLSelectElement).value; history.replaceState(null, '', `?db=${encodeURIComponent(db)}`); loadRoot() })
window.addEventListener('resize', draw)
loadDbList().then(loadRoot)
