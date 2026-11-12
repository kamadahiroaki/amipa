// コンティグの道筋（11-10）: GET /api/route?db&path&layer&x1&y1&x2&y2
//   リボン（/api/ribbon）は「群が通るノードの集合」しか返さないので、同じノードを 2 回通る所や逆位の折り返しで、どこからどこへ続くかが読めない。
//   ここではコンティグ（同じ名前の W 行の断片すべて）のトークン列を distill から順に読み、表示中の層 L のノード（矩形の中）に写して、
//   通る順のノード列（連続する同じノードは 1 つにまとめる）と、各ステップのコンティグ上の位置 p を返す。矩形の外へ出たところで列（run）を切る。
//   ★子を引く問い合わせは INDEXED BY idx_nodes_parent が要る（無いとプランナが layer_index の索引で層全体を走査し、層 11 で 139 秒かかった）
//   葉 → 層 L のノードは、矩形の中の層 L のノードから parent_name を下へたどって作る（同じ名前のノードが層をまたいで続き、parent_name は一つ上の層を指す）
import { Router } from 'express'
import path from 'path'
import { getDb, getDbDir } from '../db'
import { spatialSource } from '../spatial'
import { openDistill } from '../distill'
import { distillFor } from './bubbleMsa'
import { openAnc, ancOf, ancCode, ancSlice } from '../anc'

import { sendBg } from '../bgClient'

export const routeRouter = Router()

const MAX_LEAVES = Number(process.env.AMIPA_ROUTE_MAX_LEAVES) || 400_000
const MAX_STEPS = 200_000
const MAX_EST_LEAVES = Number(process.env.AMIPA_ROUTE_MAX_EST) || 200_000
const MAX_NODES = 8000
function layerNodesOf(d: any): number[] | null {
  const c = (d as any).__layerNodes; if (c !== undefined) return c
  let v: number[] | null = null
  try { const row = d.prepare('SELECT data FROM stats ORDER BY id DESC LIMIT 1').get() as { data: string } | undefined; v = row?.data ? JSON.parse(row.data).layer_nodes ?? null : null } catch { /* ignore */ }
  ;(d as any).__layerNodes = v; return v
}

function maxLayerOf(d: any): number {
  const c = (d as any).__maxLayer; if (c != null) return c
  let m = 0
  try { const row = d.prepare('SELECT maxlayer, data FROM stats ORDER BY id DESC LIMIT 1').get() as { maxlayer: number | null; data: string } | undefined
    m = row?.maxlayer ?? (row?.data ? JSON.parse(row.data).maxlayer : 0) ?? 0 } catch { /* ignore */ }
  ;(d as any).__maxLayer = m; return m
}

export function routeHandler(req: { query: any }, res: any): void {
  const q = req.query as Record<string, string>
  const T0 = Date.now()
  if (!q.db || !q.path || q.layer == null) { res.status(400).json({ error: 'Missing db/path/layer' }); return }
  const L = Number(q.layer)
  const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(k => Number(q[k]))
  if (![x1, y1, x2, y2].every(Number.isFinite)) { res.status(400).json({ error: 'Missing bbox' }); return }
  try {
    const d = getDb(q.db)
    const dir = distillFor(path.join(getDbDir(), path.basename(q.db)))
    if (!dir) { res.json({ error: 'no distill', nodes: [], runs: [] }); return }
    const dist = openDistill(dir)
    const pids = dist.pidsOf(q.path)
    if (!pids.length) { res.json({ error: 'no such path', nodes: [], runs: [] }); return }
    // 11-12: dense＝元の id の DB は id_map（全ゲノム 651 MB）を読まない。bp もコンティグのトークンの番号の範囲だけ s_seq_off から（以前は s_id・s_bp を丸ごと展開）
    const ident = dist.identity()
    const idm = ident ? null : dist.idMap(); if (!ident && !idm) { res.json({ error: 'no id_map', nodes: [], runs: [] }); return }
    const idOfT = (t: number) => (idm ? idm[t - 1] : t)
    const bpd0 = ident ? null : dist.bpOfDense()
    // 1) 矩形の中の層 L のノード
    const sp = spatialSource(d, L, { x1, x2, y1, y2 })
    const nodes = (sp.tiled   // 11-12: タイル経路は中心・半径・角度・名前を持つ（本体の nodes を引かない）
      ? d.prepare(`SELECT rt.nm AS name, rt.cx AS x, rt.cy AS y, rt.ang AS a, rt.rad AS r FROM ${sp.from}`).all(...sp.params)
      : d.prepare(`SELECT n.node_name AS name, n.xCoord AS x, n.yCoord AS y, n.angle AS a, n.radius AS r
                             FROM ${sp.from} CROSS JOIN nodes n ON n.rowid = rt.rowid`).all(...sp.params)) as { name: string; x: number; y: number; a: number; r: number }[]
    // 11-12: <db>.anc（葉 → 各層の祖先）があれば、本体の nodes を親の索引で下へたどらない（層 13 の初回 12.6 秒の主因）。
    //   コンティグのトークンの葉の祖先を層 L の配列から引き、矩形の中のノードなら添字を付ける（下の 3) で使う ancIdx）
    const ANC = (process.env.AMIPA_ANC ?? '1') !== '0' ? openAnc(path.join(getDbDir(), path.basename(q.db))) : null
    const codeIdx = ANC ? new Map(nodes.map((n, i) => [ancCode(n.name), i] as [number, number]).filter(([c]) => c >= 0)) : null
    // 2) 葉（最深層）→ 層 L のノードの添字。parent_name を下へたどる
    const ML = maxLayerOf(d)
    // 重すぎる範囲は先に断る（11-10: 広い表示で数分かかり、その間メインスレッドが塞がって他の取得も止まった）。
    //   葉の数の見込み ＝ 矩形の中のノード数 × （最深層のノード数 ÷ 層 L のノード数）
    const ln = layerNodesOf(d)
    const est = ln && ln[L] ? nodes.length * (ln[ML] / ln[L]) : nodes.length
    if ((!ANC && est > MAX_EST_LEAVES) || nodes.length > MAX_NODES) { res.json({ tooBig: true, est: Math.round(est), nodes: [], runs: [], ms: Date.now() - T0 }); return }
    const leafAnc = new Map<number, number>()   // 元の GFA id → nodes の添字
    let front = new Map<string, number>(nodes.map((n, i) => [n.name, i]))
    let truncated = false
    const qChild = new Map<number, any>()
    for (let l = L; l < ML && front.size && !ANC; l++) {
      const next = new Map<string, number>()
      const names = [...front.keys()]
      for (let i = 0; i < names.length; i += 500) {
        const part = names.slice(i, i + 500)
        const k = part.length
        let st = qChild.get(k); if (!st) { st = d.prepare(`SELECT node_name AS c, parent_name AS p FROM nodes INDEXED BY idx_nodes_parent WHERE parent_name IN (${part.map(() => '?').join(',')}) AND layer_index = ?`).raw(); qChild.set(k, st) }
        for (const [c, p] of st.all(...part, l + 1) as [string, string][]) next.set(c, front.get(p)!)
      }
      if (next.size > MAX_LEAVES) { truncated = true; break }
      front = next
    }
    if (truncated) { res.json({ error: 'too many leaves', tooBig: true, nodes: [], runs: [] }); return }
    if (!ANC) for (const [nm, i] of front) { const m = /^n(\d+)$/.exec(nm); if (m) leafAnc.set(Number(m[1]), i) }
    // 3) コンティグの断片ごとにトークンを順に写す
    const pst = dist.pStart()
    const fragStart = pids.map(p => pst ? pst[p] : 0)
    const fragEnd: number[] = []
    const runs: any[] = []
    let nSteps = 0
    for (let fi = 0; fi < pids.length; fi++) {
      const pid = pids[fi]; const nt = dist.ntok(pid)
      const tok = dist.read(pid, 0, nt), ori = dist.readOri(pid, 0, nt)
      if (ANC && codeIdx) {   // 番号がまとまっていれば範囲 1 回の型付き配列で（11-12: Map で 100 万個を引くと 1 秒かかった）
        let lo = Infinity, hi = -1; for (let i = 0; i < nt; i++) { const v = idOfT(tok[i]); if (v < lo) lo = v; if (v > hi) hi = v }
        const sl = hi - lo <= 8_000_000 ? ancSlice(ANC, L, lo, hi) : null
        if (sl) { for (let i = 0; i < nt; i++) { const v = idOfT(tok[i]); if (leafAnc.has(v)) continue; const c = sl[v - lo]; if (c === 0xFFFFFFFF) continue; const k = codeIdx.get(c); if (k !== undefined) leafAnc.set(v, k) } }
        else if (L >= ANC.maxlayer) { for (let i = 0; i < nt; i++) { const v = idOfT(tok[i]); const k = codeIdx.get(v); if (k !== undefined) leafAnc.set(v, k) } }
        else { const ids = new Set<number>(); for (let i = 0; i < nt; i++) ids.add(idOfT(tok[i])); for (const [leafId, c] of ancOf(ANC, L, ids)) { const k = codeIdx.get(c); if (k !== undefined) leafAnc.set(leafId, k) } } }
      let bpd: ArrayLike<number> | null = bpd0, bpBase = 0; let bpMap: Map<number, number> | null = null
      if (ident && nt) { let lo = Infinity, hi = -1; for (let i = 0; i < nt; i++) { const t = tok[i]; if (t < lo) lo = t; if (t > hi) hi = t }
        if (hi - lo <= 8_000_000) { const r = dist.bpRange(lo, hi); if (r) { bpd = r; bpBase = lo } }
        else {   // 番号が離れて散る（転座など）: 近い番号の塊ごとに読む
          const u = [...new Set(Array.from(tok))].sort((x, y) => x - y); bpMap = new Map(); let i0 = 0
          while (i0 < u.length) { let j = i0; while (j + 1 < u.length && u[j + 1] - u[j] <= 65536) j++; const r = dist.bpRange(u[i0], u[j]); if (r) for (let k = i0; k <= j; k++) bpMap.set(u[k], r[u[k] - u[i0]]); i0 = j + 1 } } }
      let pos = fragStart[fi]
      let cur: { pid: number; t0: number; t1: number; s: number[]; o: number[]; p: number[]; c0: number; c1: number } | null = null
      for (let i = 0; i < nt; i++) {
        const t = tok[i]; const a = leafAnc.get(idOfT(t)); const bp = bpMap ? (bpMap.get(t) ?? 0) : bpd ? bpd[t - bpBase] : 0
        if (a === undefined) { if (cur) { runs.push(cur); cur = null } pos += bp; continue }
        if (!cur) cur = { pid, t0: i, t1: i, s: [a], o: [ori[i]], p: [Math.round(pos)], c0: pos, c1: pos + bp }
        else { if (cur.s[cur.s.length - 1] !== a) { cur.s.push(a); cur.o.push(ori[i]); cur.p.push(Math.round(pos)); nSteps++ } cur.t1 = i; cur.c1 = pos + bp }
        pos += bp
      }
      if (cur) runs.push(cur)
      fragEnd.push(pos)
      if (nSteps > MAX_STEPS) { truncated = true; break }
    }
    const ctgMax = Math.max(...fragEnd)
    // 端の種類: ctg ＝コンティグの本当の端、clip ＝断片の端（クリップの切れ目）、cut ＝矩形の外へ出る
    for (const r of runs) {
      const fi = pids.indexOf(r.pid); const nt = dist.ntok(r.pid)
      // 本当の端は W の start が 0 の始まりだけ。終わりはコンティグの長さが分からないので 'last'（最後の断片の終わり）止まり（11-10）
      r.k0 = r.t0 === 0 ? (fragStart[fi] === 0 ? 'ctg' : 'clip') : 'cut'
      r.k1 = r.t1 === nt - 1 ? (fragEnd[fi] >= ctgMax ? 'last' : 'clip') : 'cut'
    }
    // 断片の並び（コンティグ上の位置）順に
    runs.sort((a, b) => a.c0 - b.c0)
    res.json({ path: q.path, layer: L, nodes, runs, truncated, ms: Date.now() - T0 })
  } catch (e) {
    res.status(500).json({ error: String(e), nodes: [], runs: [] })
  }
}
routeRouter.get('/route', (req, res) => sendBg(req, res, 'route'))   // 11-10: 専用の worker で
