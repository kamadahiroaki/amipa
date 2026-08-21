import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { getDb, getDbDir } from '../db'
import { tableCols } from '../nodeQuery'

// 8.3「持ち出せる出力」: 表示中の部分グラフを GFA、ノード集合を参照座標 BED へ書き出す。
// クエリは /nodes と同じ R-Tree(層 L ∩ bbox)。WHERE 引数順は [L, x2, x1, y2, y1]。
// 8.2 ヘッドレス render CLI からも同じ SQL を再利用する想定。
export const exportRouter = Router()

const GFA_MAX_NODES = 30000     // これ以上の葉が視野に入ったら zoom in を促す
const BED_MAX_ROWS = 200000
const CH = 900                  // IN シークのチャンク(SQLite 変数上限回避)

function openDb(db?: string): any | null {
  if (!db) return null
  const base = path.basename(db)
  if (!fs.existsSync(path.join(getDbDir(), base))) return null
  return getDb(base)
}
function fnBase(db: string): string {
  return path.basename(db).replace(/\.(layered\.)?db$/, '').replace(/[^\w.+-]+/g, '_') || 'amipa'
}
function bbox(q: any): { L: number; x1: number; y1: number; x2: number; y2: number } | null {
  const L = Number(q.layer), x1 = Number(q.x1), y1 = Number(q.y1), x2 = Number(q.x2), y2 = Number(q.y2)
  if (![L, x1, y1, x2, y2].every(Number.isFinite)) return null
  return { L, x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) }
}

// ── 部分グラフ GFA: 視野の葉ノード(=配列を持つ層 maxLayer)＋その間のエッジ＋配列 ──
exportRouter.get('/export/gfa', (req, res) => {
  const q = req.query as any
  const d = openDb(q.db)
  if (!d) { res.status(404).type('text/plain').send('# DB not found\n'); return }
  const b = bbox(q)
  if (!b) { res.status(400).type('text/plain').send('# need layer,x1,y1,x2,y2\n'); return }
  try {
    const hasKind = tableCols(d, 'nodes').has('kind')
    const rows = d.prepare(
      `SELECT n.node_name AS nm${hasKind ? ', n.kind AS kind' : ''}
       FROM nodes_rtree r JOIN nodes n ON n.rowid = r.rowid
       WHERE r.min_layer = ? AND r.min_x <= ? AND r.max_x >= ? AND r.min_y <= ? AND r.max_y >= ?`
    ).all(b.L, b.x2, b.x1, b.y2, b.y1) as { nm: string; kind?: number }[]
    // 葉のみ(配列を持つ)。kind 列があれば kind=0、無ければ node_name 'n{digits}' で判定。
    const leaves = rows.filter(r => (hasKind ? r.kind === 0 : /^n\d+$/.test(r.nm)))
    if (leaves.length > GFA_MAX_NODES) {
      res.status(413).type('text/plain')
        .send(`# too many leaf nodes in view (${leaves.length} > ${GFA_MAX_NODES}); zoom in\n`)
      return
    }
    const names = leaves.map(r => r.nm)
    const nameSet = new Set(names)

    // 配列: node_sequences(node_name,sequence) 優先、無ければ leaf_seq(leaf_id,seq) を葉 n{id} の id で。
    const seqOf = new Map<string, string>()
    if (tableCols(d, 'node_sequences').size > 0) {
      for (let i = 0; i < names.length; i += CH) {
        const c = names.slice(i, i + CH)
        for (const r of d.prepare(
          `SELECT node_name AS nm, sequence AS seq FROM node_sequences WHERE node_name IN (${c.map(() => '?').join(',')})`
        ).all(...c) as any[]) seqOf.set(r.nm, r.seq)
      }
    } else if (tableCols(d, 'leaf_seq').size > 0) {
      const ids = names.map(nm => Number(nm.slice(1))).filter(Number.isFinite)
      for (let i = 0; i < ids.length; i += CH) {
        const c = ids.slice(i, i + CH)
        for (const r of d.prepare(
          `SELECT leaf_id, seq FROM leaf_seq WHERE leaf_id IN (${c.map(() => '?').join(',')})`
        ).all(...c) as any[]) seqOf.set('n' + r.leaf_id, r.seq)
      }
    }

    // エッジ: 層 L で source が集合内の行を引き、target も集合内のものだけ残す(各エッジ 1 回)。
    const edges: { source: string; target: string; ss: number; ts: number }[] = []
    for (let i = 0; i < names.length; i += CH) {
      const c = names.slice(i, i + CH)
      for (const r of d.prepare(
        `SELECT source, target, src_sign AS ss, tgt_sign AS ts FROM edges
         WHERE layer_index = ? AND source IN (${c.map(() => '?').join(',')})`
      ).all(b.L, ...c) as any[]) if (nameSet.has(r.target)) edges.push(r)
    }

    const out: string[] = ['H\tVN:Z:1.0']
    for (const nm of names) out.push(`S\t${nm}\t${seqOf.get(nm) ?? '*'}`)
    for (const e of edges) {
      const so = Number(e.ss) < 0 ? '-' : '+'    // src_sign/tgt_sign(1/-1) → GFA 向き(+/-)。0(pathless)は +
      const to = Number(e.ts) < 0 ? '-' : '+'
      out.push(`L\t${e.source}\t${so}\t${e.target}\t${to}\t0M`)
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fnBase(q.db)}_L${b.L}.gfa"`)
    res.send(out.join('\n') + '\n')
  } catch (e) {
    res.status(500).type('text/plain').send('# export error: ' + String(e) + '\n')
  }
})

// ── ノード BED: 視野の(表示層の)ノードを参照座標へ。ref_bp は 0-based, ref_bp_end は排他 → BED [start,end) にそのまま ──
exportRouter.get('/export/bed', (req, res) => {
  const q = req.query as any
  const d = openDb(q.db)
  if (!d) { res.status(404).type('text/plain').send('# DB not found\n'); return }
  const b = bbox(q)
  if (!b) { res.status(400).type('text/plain').send('# need layer,x1,y1,x2,y2\n'); return }
  try {
    if (!tableCols(d, 'nodes').has('ref_bp')) {
      res.status(400).type('text/plain').send('# this DB has no ref_bp track\n'); return
    }
    const rows = d.prepare(
      `SELECT n.node_name AS nm, n.ref_contig_id AS rci, n.ref_bp AS rb, n.ref_bp_end AS rbe,
              n.ref_strand AS rs, n.ref_multi AS rm
       FROM nodes_rtree r JOIN nodes n ON n.rowid = r.rowid
       WHERE r.min_layer = ? AND r.min_x <= ? AND r.max_x >= ? AND r.min_y <= ? AND r.max_y >= ?
         AND n.ref_bp IS NOT NULL
       LIMIT ?`
    ).all(b.L, b.x2, b.x1, b.y2, b.y1, BED_MAX_ROWS + 1) as any[]
    const truncated = rows.length > BED_MAX_ROWS
    const use = truncated ? rows.slice(0, BED_MAX_ROWS) : rows

    const cn = new Map<number, string>()
    for (const c of d.prepare('SELECT contig_id, name FROM ref_contigs').all() as any[]) cn.set(c.contig_id, c.name)
    const chromOf = (cid: number) => {
      const nm = String(cn.get(cid) ?? ('contig' + cid))
      const p = nm.split('#'); return p[p.length - 1] || nm     // PanSN の末尾成分(例 GRCh38#0#chrY → chrY)
    }

    const lines: string[] = []
    for (const r of use) {
      if (r.rb == null) continue
      let start = Number(r.rb), end = Number(r.rbe ?? r.rb)
      if (!(end > start)) end = start + 1
      const strand = r.rs == null ? '.' : (Number(r.rs) === 0 ? '-' : '+')
      const score = r.rm ? 0 : 1000                              // ref_multi(多値=概算) は score 0 で目印
      lines.push([chromOf(Number(r.rci)), start, end, r.nm, score, strand].join('\t'))
    }
    lines.sort((a, z) => {
      const A = a.split('\t'), B = z.split('\t')
      return A[0] < B[0] ? -1 : A[0] > B[0] ? 1 : Number(A[1]) - Number(B[1])
    })
    let body = lines.join('\n') + (lines.length ? '\n' : '')
    if (truncated) body = `# truncated at ${BED_MAX_ROWS} rows; zoom in\n` + body
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fnBase(q.db)}_L${b.L}.bed"`)
    res.send(body)
  } catch (e) {
    res.status(500).type('text/plain').send('# export error: ' + String(e) + '\n')
  }
})
