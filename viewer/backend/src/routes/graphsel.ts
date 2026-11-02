import { Router } from 'express'
import { getDb } from '../db'
import { tableCols, parseNodes } from '../nodeQuery'
import { edgeExtraSel } from '../edgeQuery'

// グラフを「葉の名前の集合」で扱う口（2026-11-02）。Traversals の範囲をグラフに写す（絞る・寄せる・ホバーを光らせる）。
// 以前は Blocks の routes/blocks.ts にあり、名前の集合で呼んでも古い木（<db>.synteny）が無いと 404 を返した（前処理だけで作った DB で
// 「グラフを絞る」「グラフに寄せる」が効かなかった）。名前の集合で要るのは本体 DB の最下層の番号（stats.maxlayer）と nodes・edges だけ。
//   GET  /api/graph/ancestors?db&layer&names=n1,n2   … 葉の名前 → 指定した層の祖先の名前（グラフが粗い層を描いているとき光らせる）
//   POST /api/graph/bbox      {db, names}             … 葉の座標の箱（外れ値を除いた 5〜95 パーセンタイルを 15% 広げたもの。外接は raw）
//   POST /api/graph/subgraph  {db, layer, names, namesOnly?, max?, budget?, bbox?}
//        … 葉の名前を親の連鎖で layer の名前に直し、そのノードと、端点が集合に入る辺（片端が外なら外の端点 outer も）
export const graphSelRouter = Router()

function maxLayerOf(db: string): number {
  try { const r = getDb(db).prepare('SELECT maxlayer FROM stats ORDER BY id DESC LIMIT 1').get() as { maxlayer?: number } | undefined; return Number(r?.maxlayer ?? 0) } catch { return 0 }
}
const strList = (v: unknown): string[] => Array.isArray(v) ? (v as unknown[]).filter(x => typeof x === 'string') as string[] : []

graphSelRouter.get('/graph/ancestors', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db) { res.status(400).json({ error: 'Missing db' }); return }
  const layer = Number(q.layer); const names = String(q.names || '').split(',').filter(x => x).slice(0, 200)
  try {
    const d = getDb(q.db); const st = d.prepare('SELECT layer_index AS L, parent_name AS p FROM nodes WHERE node_name = ? LIMIT 1')
    const out = new Set<string>(); const memo = new Map<string, string | null>()
    for (const nm0 of names) { let nm: string | null = nm0
      for (let k = 0; k < 16 && nm; k++) { const r = st.get(nm) as { L: number; p: string | null } | undefined; if (!r) { nm = null; break } if (!Number.isFinite(layer) || r.L <= layer) break; if (memo.has(nm)) { nm = memo.get(nm)!; continue } const pp: string | null = r.p && r.p !== nm ? r.p : null; memo.set(nm, pp); nm = pp }
      if (nm) out.add(nm) }
    res.json({ names: [...out] })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

// 矩形の標本の本数: 1 本＝本体 DB の主キー 1 回のシーク。コールドの Lustre では 1 回 ~10 ms なので 4,000 本で 35 秒かかった（ヒト chr20-22）
const BBOX_SAMPLE = Number(process.env.AMIPA_BBOX_SAMPLE) || 600
graphSelRouter.post('/graph/bbox', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>; const db = String(b.db ?? ''); const all = strList(b.names)
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const t0 = Date.now()
  try {
    const layer = maxLayerOf(db); const d = getDb(db)
    const names: string[] = []; const step = Math.max(1, Math.ceil(all.length / BBOX_SAMPLE)); for (let i = 0; i < all.length; i += step) names.push(all[i]); names.sort((u, v) => Number(u.slice(1)) - Number(v.slice(1)))   // 主キーの近い順に引く
    if (!names.length) { res.json({ layer, count: 0, ms: Date.now() - t0 }); return }
    const sel = (ph: string) => `SELECT xCoord, yCoord FROM nodes WHERE layer_index = ? AND node_name IN (${ph})`
    const xs: number[] = [], ys: number[] = []; let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, sx = 0, sy = 0
    for (let i = 0; i < names.length; i += 400) { const ch = names.slice(i, i + 400)
      for (const r of d.prepare(sel(ch.map(() => '?').join(','))).all(layer, ...ch) as { xCoord: number; yCoord: number }[]) { if (r.xCoord == null) continue; xs.push(r.xCoord); ys.push(r.yCoord); minx = Math.min(minx, r.xCoord); maxx = Math.max(maxx, r.xCoord); miny = Math.min(miny, r.yCoord); maxy = Math.max(maxy, r.yCoord); sx += r.xCoord; sy += r.yCoord } }
    const n = xs.length
    if (!n) { res.json({ layer, count: 0, ms: Date.now() - t0 }); return }
    // 外れ値を除いた矩形（10-28）: ecoli では範囲の一部のノード（IS・反復）がレイアウトの中央のハブなど遠くにあり、外接矩形がグラフ全体に広がった
    xs.sort((u, v) => u - v); ys.sort((u, v) => u - v); const pc = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))]
    let tx0 = pc(xs, .05), tx1 = pc(xs, .95), ty0 = pc(ys, .05), ty1 = pc(ys, .95); const px = (tx1 - tx0) * .15 + 1e-9, py = (ty1 - ty0) * .15 + 1e-9; tx0 -= px; tx1 += px; ty0 -= py; ty1 += py
    res.json({ layer, count: n, minx: tx0, miny: ty0, maxx: tx1, maxy: ty1, raw: { minx, miny, maxx, maxy }, cx: sx / n, cy: sy / n, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

const SUBGRAPH_MAX = 120000
graphSelRouter.post('/graph/subgraph', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>; const db = String(b.db ?? '')
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const layer = Number(b.layer) || 0; const max = Math.max(100, Math.min(SUBGRAPH_MAX, Number(b.max) || SUBGRAPH_MAX)); const t0 = Date.now()
  try {
    // 1) 葉の名前 → 表示する層の名前: 親の連鎖（parent_name）で 1 段ずつ上へ（10-28。原子経由だと範囲に掛かる原子の上の層を全部取り、1 段上で 9 万に膨らんだ）
    const d = getDb(db); const ML = maxLayerOf(db)
    let cur = strList(b.names); let L = ML
    if (layer < ML && tableCols(d, 'nodes').has('parent_name')) {
      while (L > layer && cur.length) { const next = new Set<string>(); for (let i = 0; i < cur.length; i += 400) { const ch = cur.slice(i, i + 400); for (const r of d.prepare(`SELECT parent_name FROM nodes WHERE layer_index = ? AND node_name IN (${ch.map(() => '?').join(',')})`).all(L, ...ch) as { parent_name: string | null }[]) if (r.parent_name) next.add(r.parent_name) } cur = [...next]; L-- }
    }
    const names = cur.slice(0, max); const truncated = cur.length > max; const how = layer < ML ? 'names→parents' : 'names'
    if (b.namesOnly) { res.json({ names, n: names.length, truncated, how, ms: Date.now() - t0 }); return }   // 名前だけ（塗り分け用）
    if (!names.length) { res.json({ nodes: [], outer: [], edges: [], n: 0, truncated, how, ms: Date.now() - t0 }); return }
    // 2) ノード（主キーで点引き）
    const cols = tableCols(d, 'nodes')
    const opt = ['coverage', 'cov_hist', 'haplotype', 'ref_contig_id', 'ref_bp', 'ref_bp_end', 'is_anchor', 'ref_multi', 'ref_strand', 'comp_id', 'kind'].filter(c => cols.has(c)).map(c => `, n.${c}`).join('')
    const selNodes = (ph: string) => `SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size, n.xCoord, n.yCoord, n.angle, n.radius, n.color${opt}, n.layer_index AS layer FROM nodes n WHERE n.layer_index = ? AND n.node_name IN (${ph})`
    const fetchNodes = (list: string[]) => { const out: any[] = []; for (let i = 0; i < list.length; i += 400) { const ch = list.slice(i, i + 400); out.push(...d.prepare(selNodes(ch.map(() => '?').join(','))).all(layer, ...ch)) } return parseNodes(out) }
    const nodes = fetchNodes(names)
    // 表示予算（10-28）: 画面の範囲（bbox）に入るノードだけを数え、予算を超えたら辺を引かずに知らせる（viewer が 1 段粗い層へ）
    const budget = Number(b.budget) || 0; const bb = (b.bbox && typeof b.bbox === 'object') ? b.bbox as Record<string, number> : null
    if (budget && bb) { let nIn = 0
      for (const n of nodes as any[]) { const r = Number(n.radius) || 0; if (n.xCoord + r >= bb.x1 && n.xCoord - r <= bb.x2 && n.yCoord + r >= bb.y1 && n.yCoord - r <= bb.y2) nIn++ }
      if (nIn > budget) { res.json({ overBudget: true, nIn, n: names.length, nodes: [], outer: [], edges: [], truncated, how, ms: Date.now() - t0 }); return } }
    const inSet = new Set(nodes.map((n: any) => n.node_name as string))
    // 3) 辺（端点の索引で引き、rowid で重複を落とす）
    const edges: any[] = []; const seen = new Set<number>()
    const ex = edgeExtraSel(d)   // edge_hb があれば相乗り: 絞りモードでもパス多重度の太さが出る
    const selE = (side: string, ph: string) => `SELECT e.rowid AS id, e.source, e.target, e.src_sign, e.tgt_sign${ex.sel} FROM edges e${ex.join} WHERE e.layer_index = ? AND e.${side} IN (${ph})`
    const list = [...inSet]
    for (const side of ['source', 'target']) for (let i = 0; i < list.length; i += 400) {
      const ch = list.slice(i, i + 400)
      for (const e of d.prepare(selE(side, ch.map(() => '?').join(','))).all(layer, ...ch) as any[]) { if (!seen.has(e.id)) { seen.add(e.id); edges.push(e) } }
    }
    // 4) 集合の外の端点（切れ端用）
    const outerNames = new Set<string>(); for (const e of edges) { if (!inSet.has(e.source)) outerNames.add(e.source); if (!inSet.has(e.target)) outerNames.add(e.target) }
    const outer = fetchNodes([...outerNames].slice(0, max))
    res.json({ nodes, outer, edges, n: names.length, truncated, how, ms: Date.now() - t0 })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})
