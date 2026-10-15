// 全ゲノムのアレル距離で系統樹を作り直し、木のサイドカー <db>.synteny の meta.tree を置き換える。
//   使い方: DB_DIR=<アトラスの dir> node dist/tools/alleleTree.js <db ファイル名> [--chunk 2500] [--dry]
//   距離 = 両株が被覆する変異サイト（座位方式のアレル行列 sitesForRangeLoci、2,500 列ずつ）でアレル番号が違う割合。
//   木 = UPGMA（最近隣連鎖法）。古い木（列の有無の Jaccard、tree.py）は meta.tree_jaccard に残す。
//   なぜ: Jaccard は私有ノードの多い株（島が多い株）を全株から遠ざけ、ecoli50 では GCF_014170615 が参照株の群に付いた。
//   アレル距離は置換を数えるので、置換の系統に沿う（README 改訂 108）。
//   規模: 対の数 × サイト数。50 株 × 26 万サイトで数秒。数千株では --max-sites でサイトを間引く（等間隔）。
import Database from 'better-sqlite3'
import { loadSynteny, sitesForRangeLoci } from '../synteny'

const args = process.argv.slice(2); const db = args.find(a => !a.startsWith('--')); if (!db) { console.error('usage: DB_DIR=<dir> node dist/tools/alleleTree.js <db> [--chunk N] [--max-sites N] [--dry]'); process.exit(2) }
const opt = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d }
const CHUNK = opt('--chunk', 2500), MAX_SITES = opt('--max-sites', 0), DRY = args.includes('--dry')
const syn = loadSynteny(db); if (!syn) { console.error('木のサイドカーがありません: ' + db); process.exit(1) }
const haps: string[] = syn.hapOrder; const H = haps.length; const ncols = Number(syn.meta.ncols || 0)
const t0 = Date.now()
const mism = new Float64Array(H * H), comp = new Float64Array(H * H)
let nsites = 0, nchunks = 0, nbinned = 0, stride = 1
if (MAX_SITES > 0) stride = 1   // 間引きは収集後ではなく、サイトごとに stride で飛ばす（下で決める）
const cells: Uint8Array[] = []
for (let c0 = 0; c0 < ncols; c0 += CHUNK) {
  const c1 = Math.min(ncols - 1, c0 + CHUNK - 1)
  const r = sitesForRangeLoci(syn, { c0, c1 }) as any
  if (!r || r.error || !r.nsites) continue
  if (r.binned) { nbinned++; continue }   // 粗い段になった断片は使わない（CHUNK を小さくする）
  nchunks++
  const raw = Buffer.from(r.cells, 'base64'); const hidx = new Map((r.haps as string[]).map((h, i) => [h, i]))
  const n: number = r.nsites; const Hr: number = r.H
  for (let k = 0; k < n; k++) { const row = new Uint8Array(H); for (let i = 0; i < H; i++) { const j = hidx.get(haps[i]); row[i] = j == null ? 255 : raw[k * Hr + j] } cells.push(row) }
}
if (MAX_SITES > 0 && cells.length > MAX_SITES) stride = Math.ceil(cells.length / MAX_SITES)
for (let k = 0; k < cells.length; k += stride) { const row = cells[k]; nsites++
  for (let i = 0; i < H; i++) { const a = row[i]; if (a === 255 || a === 254) continue
    for (let j = i + 1; j < H; j++) { const b = row[j]; if (b === 255 || b === 254) continue; comp[i * H + j]++; if (a !== b) mism[i * H + j]++ } } }
const D = new Float32Array(H * H); for (let i = 0; i < H; i++) for (let j = i + 1; j < H; j++) { const c = comp[i * H + j]; const d = c > 0 ? mism[i * H + j] / c : 1; D[i * H + j] = d; D[j * H + i] = d }
// UPGMA（最近隣連鎖法）
function upgma(n: number, D: Float32Array) { const size = new Float64Array(n).fill(1); const alive = new Uint8Array(n).fill(1); const nodeOf = new Int32Array(n); const nodes: Record<number, any> = {}; for (let i = 0; i < n; i++) { nodes[i] = { id: i, h: 0, leaf: i }; nodeOf[i] = i } let next = n; const stack: number[] = []; let remaining = n
  while (remaining > 1) { if (!stack.length) { for (let i = 0; i < n; i++) if (alive[i]) { stack.push(i); break } }
    for (;;) { const a = stack[stack.length - 1]; let b = -1, bd = Infinity; for (let j = 0; j < n; j++) { if (!alive[j] || j === a) continue; const d = D[a * n + j]; if (d < bd) { bd = d; b = j } }
      const k = stack.indexOf(b)
      if (k >= 0) { stack.length = k; const id = next++; nodes[id] = { id, h: Math.max(bd / 2, nodes[nodeOf[a]].h, nodes[nodeOf[b]].h), ch: [nodeOf[a], nodeOf[b]] }
        const sa = size[a], sb = size[b]; for (let m = 0; m < n; m++) { if (!alive[m] || m === a || m === b) continue; const d = (sa * D[a * n + m] + sb * D[b * n + m]) / (sa + sb); D[a * n + m] = d; D[m * n + a] = d } size[a] = sa + sb; alive[b] = 0; nodeOf[a] = id; remaining--; break }
      stack.push(b) } }
  let root = -1; for (let i = 0; i < n; i++) if (alive[i]) { root = nodeOf[i]; break }
  const order: number[] = []; (function walk(v: number) { const nd = nodes[v]; if ('leaf' in nd) order.push(nd.leaf); else nd.ch.forEach(walk) })(root)
  return { nodes, root, order } }
const T = upgma(H, D)
const tree = { nodes: Object.fromEntries(Object.entries(T.nodes).map(([k, v]: any) => [k, { id: v.id, h: v.h, ...('leaf' in v ? { leaf: v.leaf } : { ch: v.ch }) }])), root: T.root, order: T.order, haps, method: 'allele', nsites }
const ms = Date.now() - t0
console.log(`${db}: ${H} 株 · 断片 ${nchunks}（粗い段で捨てた断片 ${nbinned}）· サイト ${nsites}${stride > 1 ? `（${stride} 個に 1 個）` : ''} · ${ms} ms`)
console.log('葉順:', T.order.map(i => haps[i].replace(/^GCF_/, '').replace(/#1$/, '')).join(' '))
if (DRY) process.exit(0)
const w = new Database(syn.file)
try {
  const old = w.prepare("SELECT value FROM meta WHERE key='tree'").get() as any
  if (old && !(w.prepare("SELECT 1 FROM meta WHERE key='tree_jaccard'").get())) w.prepare("INSERT INTO meta(key, value) VALUES ('tree_jaccard', ?)").run(old.value)
  w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('tree', ?)").run(JSON.stringify(tree))
  w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('tree_method', ?)").run('allele')
  console.log('meta.tree を置き換えました（古い木は meta.tree_jaccard）')
} finally { w.close() }
