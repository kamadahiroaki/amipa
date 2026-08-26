// タイル経路と R-Tree 経路の結果を同じ矩形で突き合わせる検証ハーネス。
//   AMIPA_TILED=0 で回すと R-Tree 経路、既定でタイル経路。両方の JSON を出して diff する。
//   使い方: DB_DIR=<dir> npx ts-node --transpile-only scripts/compare_tiled.ts <db名> <layer> <n_vp> <seed> <out.json>
import { getDb } from '../src/db'
import { runQueryJob } from '../src/dbJobs'
import { guardedAll, guardedFold } from '../src/fetchGuard'
import fs from 'fs'

const [dbName, layerS, nS, seedS, outPath] = process.argv.slice(2)
const L = Number(layerS), N = Number(nS)
const d = getDb(dbName)
const ctx = { guard: (s: any, p: any[], o?: any) => guardedAll(s, p, o ?? {}), fold: (s: any, p: any[], f: any, o?: any) => guardedFold(s, p, f, o ?? {}) }
// viewport 中心は層 L の実ノードから決定的にサンプル
let seed = Number(seedS)
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const st = JSON.parse((d.prepare('SELECT data FROM stats ORDER BY id LIMIT 1').get() as any).data)
const lz: number[] = st.layer_zoom
const ids = (d.prepare('SELECT rowid FROM nodes NOT INDEXED WHERE layer_index=? LIMIT 200000').all(L) as any[]).map(r => r.rowid)
const W = 0.9, vw = W * Math.sqrt(1600 / 900) / lz[L] * 2, vh = W * Math.sqrt(900 / 1600) / lz[L] * 2
const out: any[] = []
for (let i = 0; i < N; i++) {
  const id = ids[Math.floor(rnd() * ids.length)]
  const c = d.prepare('SELECT xCoord x, yCoord y FROM nodes WHERE rowid=?').get(id) as any
  const rect = { x1: c.x - vw / 2, x2: c.x + vw / 2, y1: c.y - vh / 2, y2: c.y + vh / 2 }
  const t0 = Date.now()
  const nj = runQueryJob(d, { kind: 'nodes', layer: L, ...rect, mapq: 0, nx: 'fast', sel: '', maxRows: 0 } as any, ctx)
  const t1 = Date.now()
  const ej = runQueryJob(d, { kind: 'edges', layer: L, ...rect, mapq: 0, sel: '', maxRows: 0 } as any, ctx)
  const t2 = Date.now()
  const nrows = nj.payload as any[], erows = ej.payload as any[]
  out.push({
    vp: i, rect, nodes_ms: t1 - t0, edges_ms: t2 - t1,
    n_nodes: nrows.length, n_edges: erows.length,
    node_ids: nrows.map(r => r.id).sort((a, b) => a - b),
    edge_ids: erows.map(r => r.id).sort((a, b) => a - b),
    // 内容の要約（列の値が同じかも見る）: 座標和・名前長和
    node_sum: nrows.reduce((s, r) => s + r.xCoord + r.yCoord + (r.radius || 0), 0),
    name_len: nrows.reduce((s, r) => s + String(r.node_name).length, 0),
    edge_has_ids: erows.length ? (erows[0].src_id != null) : null,
    trunc_n: nj.truncated, trunc_e: ej.truncated,
  })
  console.log(`vp${i} nodes ${nrows.length} (${t1 - t0}ms) edges ${erows.length} (${t2 - t1}ms) trunc=${nj.truncated}/${ej.truncated}`)
}
fs.writeFileSync(outPath, JSON.stringify(out))
