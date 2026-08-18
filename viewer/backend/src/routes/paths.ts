import { Router } from 'express'
import { getDb, getWritableDb, dbBytes, HUGE_DB_BYTES } from '../db'
import { dbEdgesSigned, edgeXYSelect, EDGE_NODE_JOIN } from '../edgeGeom'
// contig_id→hap_id の採番は hap 絞り込みと同一定義を使う（重複実装で採番がズレるのを防ぐ）
import { contigToHap, buildSelection, maskWhere, hapIdxEdgeOk } from '../hapidx'
import { covFmt, rangeMaxFn, rangeSumFn } from '../covBlob'

export const pathsRouter = Router()

// UTG positions and edge-aligned step coords for a CTG path
pathsRouter.get('/ctg_path', (req, res) => {
  const { db, name } = req.query as Record<string, string>
  if (!db || !name) { res.status(400).json({ error: 'Missing db or name' }); return }

  try {
    const row = getDb(db)
      .prepare('SELECT ctg_name, haplotype, total_len, utg_count, steps FROM ctg_paths WHERE ctg_name = ?')
      .get(name) as { ctg_name: string; haplotype: number; total_len: number; utg_count: number; steps: string } | undefined
    if (!row) { res.status(404).json({ error: 'CTG not found' }); return }

    const edgePairs: [number, number][] = JSON.parse(row.steps)
    if (edgePairs.length === 0) {
      res.json({ ctg_name: row.ctg_name, haplotype: row.haplotype, total_len: row.total_len, nodes: [], steps: [] })
      return
    }

    const uniqueIds = [...new Set(edgePairs.flat())]
    const ph = uniqueIds.map(() => '?').join(',')
    const nodes = getDb(db)
      .prepare(`SELECT rowid AS id, node_name, xCoord, yCoord, angle, radius FROM nodes WHERE rowid IN (${ph}) AND layer_index = 1`)
      .all(...uniqueIds) as { id: number; node_name: string; xCoord: number; yCoord: number; angle: number; radius: number }[]

    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const nodeNameToId = new Map(nodes.map(n => [n.node_name, n.id]))
    const nodeNames = nodes.map(n => n.node_name)
    const ph2 = nodeNames.map(() => '?').join(',')

    type EdgeRow = { source: string; target: string; start_x: number; start_y: number; end_x: number; end_y: number; startc_x: number; startc_y: number; endc_x: number; endc_y: number }
    const dd = getDb(db)
    // signed スキーマは座標を持たないので nodes(ns/nt)を JOIN して SQL で端点復元(列名は従来どおり)。
    const edgeSql = dbEdgesSigned(dd)
      ? `SELECT e.source, e.target, ${edgeXYSelect(true)} FROM edges e ${EDGE_NODE_JOIN}
         WHERE e.layer_index = 1 AND e.source IN (${ph2}) AND e.target IN (${ph2})`
      : `SELECT source, target, start_x, start_y, end_x, end_y, startc_x, startc_y, endc_x, endc_y
         FROM edges WHERE layer_index = 1 AND source IN (${ph2}) AND target IN (${ph2})`
    const edgeRows = dd.prepare(edgeSql).all(...nodeNames, ...nodeNames) as EdgeRow[]

    const edgeMap = new Map<string, EdgeRow>()
    for (const e of edgeRows) {
      const sid = nodeNameToId.get(e.source)
      const tid = nodeNameToId.get(e.target)
      if (sid === undefined || tid === undefined) continue
      const key = `${Math.min(sid, tid)}_${Math.max(sid, tid)}`
      if (!edgeMap.has(key)) edgeMap.set(key, e)
    }

    const steps = []
    for (const [id1, id2] of edgePairs) {
      const n1 = nodeById.get(id1)
      const n2 = nodeById.get(id2)
      if (!n1 || !n2) continue
      const key = `${Math.min(id1, id2)}_${Math.max(id1, id2)}`
      const e = edgeMap.get(key)
      if (e) {
        if (e.source === n1.node_name) {
          steps.push({ from_id: id1, to_id: id2, from_x: e.start_x, from_y: e.start_y, from_cx: e.startc_x, from_cy: e.startc_y, to_x: e.end_x, to_y: e.end_y, to_cx: e.endc_x, to_cy: e.endc_y })
        } else {
          steps.push({ from_id: id1, to_id: id2, from_x: e.end_x, from_y: e.end_y, from_cx: e.endc_x, from_cy: e.endc_y, to_x: e.start_x, to_y: e.start_y, to_cx: e.startc_x, to_cy: e.startc_y })
        }
      } else {
        steps.push({ from_id: id1, to_id: id2, from_x: n1.xCoord, from_y: n1.yCoord, from_cx: n1.xCoord, from_cy: n1.yCoord, to_x: n2.xCoord, to_y: n2.yCoord, to_cx: n2.xCoord, to_cy: n2.yCoord })
      }
    }

    res.json({ ctg_name: row.ctg_name, haplotype: row.haplotype, total_len: row.total_len, nodes, steps })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})

// hapcov スキーマの有無を確認（hapcov_meta テーブルが存在すれば hapcov DB）。
function hasHapcovSchema(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT n_hap FROM hapcov_meta LIMIT 1').get(); return true }
  catch { return false }
}

// エッジ×ハプロ通過ビットセット（edge_hap_cov）の有無。
// 有→エッジは mask の bit で忠実に描く（偽エッジ排除）。無→旧DB用に両端被覆ヒューリスティックへフォールバック。
function hasEdgeHapCov(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT edge_rowid FROM edge_hap_cov LIMIT 1').get(); return true }
  catch { return false }
}

// contig 前向き索引スキーマ（contigcov_meta）の有無。有→sample/hap/contig の全リボンを contig 索引で賄う
// （hap 索引の置換）。node/edge は「実際に通る contig の疎リスト BLOB」を持ち、選択レベルを [lo,hi] レンジで照合。
function hasContigcovSchema(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT n_contig FROM contigcov_meta LIMIT 1').get(); return true }
  catch { return false }
}
function hasEdgeContigCov(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT edge_rowid FROM edge_contig_cov LIMIT 1').get(); return true }
  catch { return false }
}
// 逆位(inversion)索引の有無。node_contig_inv は edge_contig_cov と同じ blob 形式
// ([u32 count][count×u32 contig_id 昇順]・cov なし) なので covBlob の rangeMax(...,false)>=0 で範囲照合可能。
function hasNodeContigInv(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT node_rowid FROM node_contig_inv LIMIT 1').get(); return true }
  catch { return false }
}

// contig 索引 BLOB のレンジ照合。contig_id が [lo,hi] に入る要素のうち最大 cov を返す
// （cov 配列を持たない edge_contig_cov は在れば 255）。-1 = レンジ内に該当 contig 無し
// （=この group はこのノード/エッジを通過しない）。
// BLOB の形式（現行 f0 / 縮小形式 f1・f2）と復号は covBlob.ts に集約した。
// ★形式判定は DB ごとに 1 回。行ごとのループの外で rangeMaxFn(covFmt(d)) を取ること。

// A-2 CNV(per-haplotype コピー数)索引 node_hap_mult の有無。blob=[u32 count][u32 hap_id 昇順][u8 cn]。
function hasNodeHapMult(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT node_rowid FROM node_hap_mult LIMIT 1').get(); return true }
  catch { return false }
}
function hasLeafSeq(d: ReturnType<typeof getDb>): boolean {
  try { d.prepare('SELECT leaf_id FROM leaf_seq LIMIT 1').get(); return true }
  catch { return false }
}
// node_hap_mult blob の hap レンジ [hlo,hhi] の cn 合計(=そのユニット=サンプル/ハプロタイプ のコピー数)。
// 該当 hap 無し=0(=非通過)。復号は covBlob.ts の rangeSumFn（形式 f0/f1/f2 を吸収）。

// パスリボン: 群一覧（level=sample|haplotype|contig で roll-up）。
// hapcov DB は hap_dict 由来（sample / haplotype の 2 粒度）。
// 旧 DB は path_groups テーブル由来（sample / haplotype / contig の 3 粒度）。
// レスポンス shape は共通: { key, label, n_contigs, total_cov, gids }
// hapcov 時の gids = hap_id の配列（旧 DB は group_id の配列）。
pathsRouter.get('/path_groups', (req, res) => {
  const { db } = req.query as Record<string, string>
  const level = (req.query.level as string) || 'sample'
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  try {
    const d = getDb(db)
    if (hasContigcovSchema(d)) {
      // contig 索引: contig_id は (sample,hap,contig) 昇順 → hap/sample は連続レンジ。
      //  contig level → gids=[contig_id]（単一）。sample/haplotype level → gids=[lo,hi]（MIN/MAX で範囲）。
      if (level === 'contig') {
        const rows = d.prepare(
          `SELECT contig_id, key, contig, total_cov
           FROM contig_dict ORDER BY total_cov DESC`).all() as any[]
        res.json(rows.map(r => ({ key: r.key, label: r.contig || r.key, n_contigs: 1,
                                  total_cov: r.total_cov, gids: [r.contig_id] })))
      } else {
        const col = level === 'haplotype' ? 'haplotype' : 'sample'
        const rows = d.prepare(
          `SELECT ${col} AS key, ${col} AS label, COUNT(*) AS n_contigs,
                  SUM(total_cov) AS total_cov, MIN(contig_id) AS lo, MAX(contig_id) AS hi
           FROM contig_dict GROUP BY ${col} ORDER BY total_cov DESC`).all() as any[]
        res.json(rows.map(r => ({ key: r.key, label: r.label, n_contigs: r.n_contigs,
                                  total_cov: r.total_cov, gids: [r.lo, r.hi] })))
      }
      return
    }
    if (hasHapcovSchema(d)) {
      if (level === 'haplotype') {
        const rows = d.prepare(
          `SELECT key, key AS label, n_paths AS n_contigs, total_cov, hap_id
           FROM hap_dict ORDER BY total_cov DESC`).all() as any[]
        res.json(rows.map(r => ({ key: r.key, label: r.label, n_contigs: r.n_contigs, total_cov: r.total_cov, gids: [r.hap_id] })))
      } else {
        // sample（デフォルト）: GROUP BY sample、hap_id を集約
        const rows = d.prepare(
          `SELECT sample AS key, sample AS label, COUNT(*) AS n_contigs,
                  SUM(total_cov) AS total_cov, GROUP_CONCAT(hap_id) AS gids
           FROM hap_dict GROUP BY sample ORDER BY total_cov DESC`).all() as any[]
        res.json(rows.map(r => ({ ...r, gids: String(r.gids).split(',').map(Number) })))
      }
      return
    }
    // 旧スキーマ（path_groups テーブル）
    const col = level === 'contig' ? 'contig' : level === 'haplotype' ? 'haplotype' : 'sample'
    const rows = d.prepare(
      `SELECT ${col} AS key, ${col} AS label, COUNT(*) AS n_contigs,
              SUM(total_cov) AS total_cov, GROUP_CONCAT(group_id) AS gids
       FROM path_groups GROUP BY ${col} ORDER BY total_cov DESC`).all() as any[]
    res.json(rows.map(r => ({ ...r, gids: String(r.gids).split(',').map(Number) })))
  } catch { res.json([]) }
})

// パスリボン: 指定群(gids の union)が layer で「通過」する super-node と、その間の実エッジを返す。
// hapcov DB: gids = hap_id[] / θ判定 = cov[hap_id] >= max(1, round(θ*255)) を JS で実施。
// 旧 DB:     gids = group_id[] / θ判定 = Σcovered_bp >= θ * nodes.size を SQL で実施。
// nodes: ノード本体を端→端で貫くため中心(x,y)・角度 a・半長 r を返す。id=node rowid。
// edges: hapcov DB は edge_hap_cov の bit=1（実通過）かつ両端θ通過の辺のみ（偽エッジ排除, spec §4b）。
//        edge_hap_cov 無しの旧/未再生成DBは「両端ともオンノード」ヒューリスティックにフォールバック。
//        su/tv=source/target rowid。編集モードのノード移動・回転にリボンを追従させるため（selectedIds と照合）。
// bbox(x1,y1,x2,y2): 指定時は nodes_rtree/edges_rtree で層 L ∩ 矩形に絞る（深層で全層走査を回避）。
//   viewer は現ビューポートを FETCH_MARGIN 拡張した矩形を渡し、パン settle 毎に再取得する（陳腐化防止）。
//   無指定なら層全体（minimap 等の後方互換）。
pathsRouter.get('/ribbon', (req, res) => {
  const { db, layer, groups } = req.query as Record<string, string>
  if (!db || layer == null || !groups) { res.status(400).json({ error: 'Missing params' }); return }
  const gids = String(groups).split(',').map(Number).filter(n => Number.isFinite(n))
  if (gids.length === 0) { res.json({ nodes: [], edges: [] }); return }
  // 既定 0 = 「少しでも通れば通過」で、表示フィルタ(graph.ts の sel=)の判定と一致する。
  // θ>0 は混雑抑制用の任意設定。分母が super-node の総塩基なので、バブルでは 1 ハプロタイプが
  // 1/アリル数しか覆えず、上げるとリボンが落ちやすい点に注意。
  const theta = Math.max(0, Math.min(1, Number(req.query.theta ?? 0)))
  const L = Number(layer)
  // bbox（任意）。4 値そろって数値のときだけ有効。R-tree の矩形重なり判定に使う。
  const bx = ['x1', 'y1', 'x2', 'y2'].map(k => Number(req.query[k as keyof typeof req.query]))
  const hasBbox = bx.every(v => Number.isFinite(v))
  const [x1, y1, x2, y2] = bx
  // R-tree 矩形重なり: rt.max_x>=qx1 AND rt.min_x<=qx2 AND …（層は min_layer==max_layer==L）。
  const rtWhere = 'rt.min_layer = ? AND rt.max_layer = ? AND rt.max_x >= ? AND rt.min_x <= ? AND rt.max_y >= ? AND rt.min_y <= ?'
  const rtParams = [L, L, x1, x2, y1, y2]
  try {
    const d = getDb(db)
    const signed = dbEdgesSigned(d)
    // 対象エッジ集合。
    //  signed: 座標非保存 → 可視/被覆ノード名の集合を種に source 枝を PK probe し、nodes を JOIN して
    //          端点を SQL 復元(edges_rtree 不要, 件数は集合サイズに有界)。両端在は後段 filterEdges で担保。
    //  座標保存: 従来どおり bbox 有→edges_rtree、無→層全体。
    const relevantEdges = (names: string[]): any[] => {
      if (signed) {
        if (names.length === 0) return []
        const ph = names.map(() => '?').join(',')
        return d.prepare(
          `SELECT e.source, e.target, ${edgeXYSelect(false)}
           FROM edges e ${EDGE_NODE_JOIN}
           WHERE e.layer_index = ? AND e.source IN (${ph})`).all(L, ...names) as any[]
      }
      return hasBbox
        ? d.prepare(
          `SELECT e.source, e.target, e.start_x, e.start_y, e.end_x, e.end_y
           FROM edges_rtree rt JOIN edges e ON e.rowid = rt.rowid WHERE ${rtWhere}`).all(...rtParams) as any[]
        : d.prepare(
          `SELECT source, target, start_x, start_y, end_x, end_y
           FROM edges WHERE layer_index = ?`).all(L) as any[]
    }
    const filterEdges = (erows: any[], idByName: Map<string, number>) => erows
      .filter((e: any) => idByName.has(e.source) && idByName.has(e.target))
      .map((e: any) => ({ su: idByName.get(e.source)!, tv: idByName.get(e.target)!,
                   sx: e.start_x, sy: e.start_y, ex: e.end_x, ey: e.end_y }))

    if (hasContigcovSchema(d)) {
      // contig 索引: group を [lo,hi] レンジにして各ノード/エッジの疎 contig-id リストへレンジ照合。
      //  gids は path_groups が返した [lo,hi]（contig level は [id]）。min/max で範囲復元（連続採番ゆえ正確）。
      const lo = Math.min(...gids), hi = Math.max(...gids)
      const t = Math.max(1, Math.round(theta * 255))
      const rangeMaxCov = rangeMaxFn(covFmt(d))   // blob 形式の判定はここで 1 回だけ
      type CRow = { id: number; name: string; x: number; y: number; a: number; r: number; blob: Buffer }

      // ── マスク経路（θ=0 かつ hap 単位選択のとき blob を 1 バイトも読まない）──────────
      //
      // なぜ効くか（cold の実測, functions/covpack/RESULTS.md §12）:
      //   `node_contig_cov` は **195 B/行**（blob が 186 B）で、これを rowid 点引きするのは
      //   ビューポート内の行数ぶんのランダム 4KB 読みになる。WG cold では `nodes`(94 B/行) を
      //   引くだけで既に 0.206 秒/2,000 行かかっており、それより太い表を足すと更に重い。
      //   一方 **hap マスクは R-Tree の補助列(hm0..)に載っている**ので、矩形走査のついでに
      //   ほぼ無料で読める（実測 0.029 秒/2,000 行、読みバイト 0）。
      //
      // いつ厳密か: `hapidx.ts buildSelection` の `exact` が **false** のとき
      //   = mode=exact かつ選択が hap 境界にそろっている（= その hap の contig を全部選んでいる）。
      //   このときマスクは上位集合ではなく厳密なので、blob による再確認は要らない。
      //   リボンはほぼサンプル/ハプロタイプ選択なので、実運用ではここに入る。
      // θ>0 は cov の値そのものが必要なので従来経路（blob を読む）に落ちる。
      // AMIPA_RIBBON_NO_MASK=1 で旧経路（blob を読む）に固定できる。同一リクエストで
      // マスク経路と blob 経路の応答が完全一致することを確かめるための逃げ道。
      const rsel = (theta === 0 && (process.env.AMIPA_RIBBON_NO_MASK ?? process.env.GGB_RIBBON_NO_MASK) !== '1') ? (() => {
        try { return buildSelection(d, `${lo}-${hi}`) } catch { return null }
      })() : null
      const useMask = !!rsel && !rsel.exact
      let covered: { id: number; name: string; x: number; y: number; a: number; r: number; frac: number }[] = []
      if (useMask && rsel) {
        const mw = maskWhere('rt', rsel)
        // ★CROSS JOIN で結合順を固定する（WG でプランナが nodes を外側に選び 10 分超になる件。
        //   nodeQuery.ts rtreeFrom のコメント参照）。
        const rows = (hasBbox
          ? d.prepare(
            `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                    n.angle AS a, n.radius AS r
             FROM ${rsel.rtree} rt CROSS JOIN nodes n ON n.rowid = rt.rowid
             WHERE ${rtWhere}${mw.sql}`).all(...rtParams, ...mw.params)
          : d.prepare(
            `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                    n.angle AS a, n.radius AS r
             FROM ${rsel.rtree} rt CROSS JOIN nodes n ON n.rowid = rt.rowid
             WHERE rt.min_layer = ? AND rt.max_layer = ?${mw.sql}`).all(L, L, ...mw.params)) as CRow[]
        // θ=0 の通過判定なので frac は「通る」の 1 でよい（frac は frontend の描画では未使用）。
        covered = rows.map(r => ({ id: r.id, name: r.name, x: r.x, y: r.y, a: r.a, r: r.r, frac: 1 }))
      } else {
      const allRows = (hasBbox
        ? d.prepare(
          `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                  n.angle AS a, n.radius AS r, ncc.blob
           FROM nodes_rtree rt
           JOIN nodes n ON n.rowid = rt.rowid
           JOIN node_contig_cov ncc ON ncc.node_rowid = rt.rowid
           WHERE ${rtWhere}`).all(...rtParams)
        : d.prepare(
          `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                  n.angle AS a, n.radius AS r, ncc.blob
           FROM nodes n JOIN node_contig_cov ncc ON ncc.node_rowid = n.rowid
           WHERE n.layer_index = ?`).all(L)) as CRow[]
      for (const row of allRows) {
        const b = Buffer.isBuffer(row.blob) ? row.blob : Buffer.from(row.blob)
        const best = rangeMaxCov(b, lo, hi, true)
        if (best >= t) covered.push({ id: row.id, name: row.name, x: row.x, y: row.y, a: row.a, r: row.r, frac: best / 255 })
      }
      }
      // 逆位: 可視ノードのうち [lo,hi] レンジの contig が逆位のものを集める(node_contig_inv, 疎)。
      //  エッジ逆位は「両端ノードが逆位=逆位区間内の辺」として下で導出(別テーブル不要)。
      const invIds = new Set<number>()
      // 逆位判定: blob=[count][ids][invfrac(0-255=逆位bp割合)]。範囲内 contig の invfrac 最大が閾値以上を逆位とする。
      // 閾値は emit でなくここで掛ける＝再ビルド不要で可変(既定 0.5=128)。
      const INV_THRESH = 128
      if (hasNodeContigInv(d) && covered.length) {
        const coveredIds = new Set(covered.map(c => c.id))
        const irows = (hasBbox
          ? d.prepare(
            `SELECT nci.node_rowid AS id, nci.blob FROM nodes_rtree rt
             JOIN node_contig_inv nci ON nci.node_rowid = rt.rowid WHERE ${rtWhere}`).all(...rtParams)
          : d.prepare(
            `SELECT nci.node_rowid AS id, nci.blob FROM node_contig_inv nci
             JOIN nodes n ON n.rowid = nci.node_rowid WHERE n.layer_index = ?`).all(L)) as any[]
        for (const ir of irows) {
          if (!coveredIds.has(ir.id)) continue
          const b = Buffer.isBuffer(ir.blob) ? ir.blob : Buffer.from(ir.blob)
          if (rangeMaxCov(b, lo, hi, true) >= INV_THRESH) invIds.add(ir.id)
        }
      }
      const idByName = new Map<string, number>(covered.map(r => [r.name, r.id]))
      let edges: any[]
      if (idByName.size === 0) {
        edges = []
      } else if (useMask && rsel && rsel.edgeTable && signed) {
        // エッジ側もマスクで済ませる（`edge_contig_cov` は 161 B/行なので触らずに済むと大きい）。
        // ノード側と同じ条件（θ=0 かつ hap 単位選択）でマスクは厳密なので blob 再確認は不要。
        // `edge_hm(edge_rowid PK, hm0..)` は 1 行が細いので rowid 点引きでも安い。
        const em = maskWhere('ehm', rsel)
        const covNames = [...idByName.keys()]
        const CH = 800                       // SQLite のパラメタ上限（既定 999）に収める
        const erows: any[] = []
        for (let i = 0; i < covNames.length; i += CH) {
          const chunk = covNames.slice(i, i + CH)
          const ph = chunk.map(() => '?').join(',')
          erows.push(...d.prepare(
            `SELECT e.source, e.target, ${edgeXYSelect(false)}
             FROM edges e ${EDGE_NODE_JOIN}
             JOIN ${rsel.edgeTable} ehm ON ehm.edge_rowid = e.rowid
             WHERE e.layer_index = ? AND e.source IN (${ph})${em.sql}`)
            .all(L, ...chunk, ...em.params) as any[])
        }
        edges = erows
          .filter((e: any) => idByName.has(e.source) && idByName.has(e.target))
          .map((e: any) => ({ su: idByName.get(e.source)!, tv: idByName.get(e.target)!,
                       sx: e.start_x, sy: e.start_y, ex: e.end_x, ey: e.end_y }))
      } else if (hasEdgeContigCov(d)) {
        const covNames = [...idByName.keys()]
        let erows: any[]
        if (signed) {
          // 被覆ノード名を種に source 枝 probe→nodes JOIN で端点復元。edges_rtree 不要。
          // ★`source IN (...)` は SQLite のパラメタ上限(既定 999)を超えると
          //   `too many SQL variables` で失敗する（chr22 の layer>=8 で実際に発生していた既存バグ）。
          //   分割して回す。
          const CH = 800
          erows = []
          for (let i = 0; i < covNames.length; i += CH) {
            const chunk = covNames.slice(i, i + CH)
            const ph = chunk.map(() => '?').join(',')
            erows.push(...d.prepare(
              `SELECT e.source, e.target, ${edgeXYSelect(false)}, ecc.blob
               FROM edges e ${EDGE_NODE_JOIN}
               JOIN edge_contig_cov ecc ON ecc.edge_rowid = e.rowid
               WHERE e.layer_index = ? AND e.source IN (${ph})`).all(L, ...chunk) as any[])
          }
        } else {
          const cols = 'e.source, e.target, e.start_x, e.start_y, e.end_x, e.end_y, ecc.blob'
          erows = (hasBbox
            ? d.prepare(
              `SELECT ${cols} FROM edge_contig_cov ecc
               JOIN edges_rtree rt ON rt.rowid = ecc.edge_rowid
               JOIN edges e ON e.rowid = ecc.edge_rowid
               WHERE ${rtWhere}`).all(...rtParams)
            : d.prepare(
              `SELECT ${cols} FROM edge_contig_cov ecc
               JOIN edges e ON e.rowid = ecc.edge_rowid
               WHERE e.layer_index = ?`).all(L)) as any[]
        }
        edges = erows
          .filter((e: any) => {
            if (!idByName.has(e.source) || !idByName.has(e.target)) return false
            const b = Buffer.isBuffer(e.blob) ? e.blob : Buffer.from(e.blob)
            return rangeMaxCov(b, lo, hi, false) >= 0
          })
          .map((e: any) => ({ su: idByName.get(e.source)!, tv: idByName.get(e.target)!,
                       sx: e.start_x, sy: e.start_y, ex: e.end_x, ey: e.end_y }))
      } else {
        edges = filterEdges(relevantEdges([...idByName.keys()]), idByName)
      }
      const nodes = covered.map(r => ({ id: r.id, name: r.name, x: r.x, y: r.y, a: r.a, r: r.r, frac: r.frac,
                                        inv: invIds.has(r.id) }))
      // エッジ逆位 = 両端ノードとも逆位(逆位区間内の辺)。invIds が空なら全 false。
      const edgesInv = invIds.size ? edges.map((e: any) => ({ ...e, inv: invIds.has(e.su) && invIds.has(e.tv) }))
                                   : edges
      res.json({ nodes, edges: edgesInv })
      return
    }
    if (hasHapcovSchema(d)) {
      const meta = d.prepare('SELECT n_hap FROM hapcov_meta').get() as { n_hap: number }
      const nHap = meta.n_hap
      const t = Math.max(1, Math.round(theta * 255))
      const validHaps = gids.filter(h => h >= 0 && h < nHap)
      type HapRow = { id: number; name: string; x: number; y: number; a: number; r: number; cov: Buffer }
      // bbox 有→nodes_rtree で層 L ∩ 矩形のノードだけ、無→層全体。cov BLOB を JS で θ 判定。
      const allRows = (hasBbox
        ? d.prepare(
          `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                  n.angle AS a, n.radius AS r, nhc.cov
           FROM nodes_rtree rt
           JOIN nodes n ON n.rowid = rt.rowid
           JOIN node_hap_cov nhc ON nhc.node_rowid = rt.rowid
           WHERE ${rtWhere}`).all(...rtParams)
        : d.prepare(
          `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                  n.angle AS a, n.radius AS r, nhc.cov
           FROM nodes n JOIN node_hap_cov nhc ON nhc.node_rowid = n.rowid
           WHERE n.layer_index = ?`).all(L)) as HapRow[]
      const covered = allRows.filter(row => {
        const b = Buffer.isBuffer(row.cov) ? row.cov : Buffer.from(row.cov)
        return validHaps.some(h => b[h] >= t)
      })
      const idByName = new Map<string, number>(covered.map(r => [r.name, r.id]))
      // エッジ選択:
      //  edge_hap_cov 有 → mask で「実際に通過した辺」だけ（bit(mask,h)==1）＋両端がθを通過（idByName）。
      //    両端被覆ヒューリスティックが出す偽エッジ（chrY葉層 GRCh38 で 7.0%）を排除。spec §4b/§6.1。
      //  edge_hap_cov 無（未再生成DB）→ 従来の両端被覆ヒューリスティックにフォールバック。
      let edges: any[]
      if (idByName.size === 0) {
        edges = []
      } else if (hasEdgeHapCov(d)) {
        const covNames = [...idByName.keys()]
        let erows: any[]
        if (signed) {
          const ph = covNames.map(() => '?').join(',')
          erows = covNames.length === 0 ? [] : d.prepare(
            `SELECT e.source, e.target, ${edgeXYSelect(false)}, ehc.mask
             FROM edges e ${EDGE_NODE_JOIN}
             JOIN edge_hap_cov ehc ON ehc.edge_rowid = e.rowid
             WHERE e.layer_index = ? AND e.source IN (${ph})`).all(L, ...covNames) as any[]
        } else {
          const cols = 'e.source, e.target, e.start_x, e.start_y, e.end_x, e.end_y, ehc.mask'
          erows = (hasBbox
            ? d.prepare(
              `SELECT ${cols} FROM edge_hap_cov ehc
               JOIN edges_rtree rt ON rt.rowid = ehc.edge_rowid
               JOIN edges e ON e.rowid = ehc.edge_rowid
               WHERE ${rtWhere}`).all(...rtParams)
            : d.prepare(
              `SELECT ${cols} FROM edge_hap_cov ehc
               JOIN edges e ON e.rowid = ehc.edge_rowid
               WHERE e.layer_index = ?`).all(L)) as any[]
        }
        edges = erows
          .filter((e: any) => {
            if (!idByName.has(e.source) || !idByName.has(e.target)) return false   // θで消えた端点への辺は落とす
            const m = Buffer.isBuffer(e.mask) ? e.mask : Buffer.from(e.mask)
            return validHaps.some(h => (m[h >> 3] >> (h & 7)) & 1)                 // 実通過（bit=1）のみ
          })
          .map((e: any) => ({ su: idByName.get(e.source)!, tv: idByName.get(e.target)!,
                       sx: e.start_x, sy: e.start_y, ex: e.end_x, ey: e.end_y }))
      } else {
        edges = filterEdges(relevantEdges([...idByName.keys()]), idByName)
      }
      const nodes = covered.map(row => {
        const b = Buffer.isBuffer(row.cov) ? row.cov : Buffer.from(row.cov)
        const maxCov = validHaps.length > 0 ? Math.max(...validHaps.map(h => b[h])) : 0
        return { id: row.id, name: row.name, x: row.x, y: row.y, a: row.a, r: row.r, frac: maxCov / 255 }
      })
      res.json({ nodes, edges })
      return
    }
    // 旧スキーマ（node_group_cov テーブル）。bbox 有→nodes_rtree を JOIN して矩形に絞る。
    const ph = gids.map(() => '?').join(',')
    const nrows = (hasBbox
      ? d.prepare(
        `SELECT c.node_rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                n.angle AS a, n.radius AS r, n.size AS bp, SUM(c.covered_bp) AS cov
         FROM node_group_cov c
         JOIN nodes n ON n.rowid = c.node_rowid
         JOIN nodes_rtree rt ON rt.rowid = c.node_rowid
         WHERE c.layer_index = ? AND c.group_id IN (${ph}) AND ${rtWhere}
         GROUP BY c.node_rowid
         HAVING cov >= ? * bp`).all(L, ...gids, ...rtParams, theta)
      : d.prepare(
        `SELECT c.node_rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y,
                n.angle AS a, n.radius AS r, n.size AS bp, SUM(c.covered_bp) AS cov
         FROM node_group_cov c JOIN nodes n ON n.rowid = c.node_rowid
         WHERE c.layer_index = ? AND c.group_id IN (${ph})
         GROUP BY c.node_rowid
         HAVING cov >= ? * bp`).all(L, ...gids, theta)) as any[]
    const idByName = new Map<string, number>(nrows.map(r => [r.name, r.id]))
    const edges = idByName.size === 0 ? [] : filterEdges(relevantEdges([...idByName.keys()]), idByName)
    const nodes = nrows.map((r: any) => ({
      id: r.id, name: r.name, x: r.x, y: r.y, a: r.a, r: r.r,
      frac: r.bp ? Math.min(1, r.cov / r.bp) : 0,
    }))
    res.json({ nodes, edges })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})

// A-2 CNV: 選択ユニット(サンプル/ハプロタイプ)ごとの per-node コピー数を返す。
//   units=「lo:hi」(=各ユニットの contig_id レンジ, path_groups の gids min/max)をカンマ区切りで受ける。
//   各ユニットの contig レンジ→hap レンジへ写し(連続)、可視ノードの node_hap_mult blob から cn 合計
//   (サンプル=構成ハプロタイプの合計)。返り値 nodes=[{id,name,x,y,cns:[ユニット順の cn]}](cns 全0 のノードは除外)。
//   node_hap_mult は葉+flubble のみ格納なのでクラスタ層では自然に空。
pathsRouter.get('/cnv', (req, res) => {
  const { db, layer, units } = req.query as Record<string, string>
  if (!db || layer == null || !units) { res.status(400).json({ error: 'Missing params' }); return }
  const L = Number(layer)
  const unitRanges = String(units).split(',')
    .map(u => u.split(':').map(Number))
    .filter(a => a.length === 2 && a.every(Number.isFinite))
  if (unitRanges.length === 0) { res.json({ nodes: [], available: true }); return }
  const bx = ['x1', 'y1', 'x2', 'y2'].map(k => Number(req.query[k as keyof typeof req.query]))
  const hasBbox = bx.every(v => Number.isFinite(v))
  const [x1, y1, x2, y2] = bx
  const rtWhere = 'rt.min_layer = ? AND rt.max_layer = ? AND rt.max_x >= ? AND rt.min_x <= ? AND rt.max_y >= ? AND rt.min_y <= ?'
  const rtParams = [L, L, x1, x2, y1, y2]
  try {
    const d = getDb(db)
    if (!hasNodeHapMult(d)) { res.json({ nodes: [], available: false }); return }
    const hapOf = contigToHap(d)
    const maxHapId = hapOf.length - 1
    const uHap = unitRanges.map(([lo, hi]) => {
      const clamp = (c: number) => (c >= 0 && c < hapOf.length ? hapOf[c] : (c < 0 ? 0 : maxHapId))
      return [clamp(Math.min(lo, hi)), clamp(Math.max(lo, hi))] as [number, number]
    })
    const rows = (hasBbox
      ? d.prepare(
        `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y, nhm.blob
         FROM nodes_rtree rt JOIN nodes n ON n.rowid = rt.rowid
         JOIN node_hap_mult nhm ON nhm.node_rowid = rt.rowid WHERE ${rtWhere}`).all(...rtParams)
      : d.prepare(
        `SELECT n.rowid AS id, n.node_name AS name, n.xCoord AS x, n.yCoord AS y, nhm.blob
         FROM node_hap_mult nhm JOIN nodes n ON n.rowid = nhm.node_rowid
         WHERE n.layer_index = ?`).all(L)) as any[]
    const nodes: { id: number; name: string; x: number; y: number; cns: number[] }[] = []
    const rangeSumCn = rangeSumFn(covFmt(d))    // blob 形式の判定はループの外で 1 回
    for (const r of rows) {
      const b = Buffer.isBuffer(r.blob) ? r.blob : Buffer.from(r.blob)
      const cns = uHap.map(([hlo, hhi]) => rangeSumCn(b, hlo, hhi))
      if (cns.some(c => c > 0)) nodes.push({ id: r.id, name: r.name, x: r.x, y: r.y, cns })
    }
    res.json({ nodes, available: true })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})

// 配列表示モード: viewport 内の小さい葉(size<=maxsize bp)の塩基をノード内描画用に返す。
// 葉は nodes.size==配列長(bp)なので size で絞れる。maxsize=1 なら 1bp 葉のみ=base 1 文字。
// leaf_seq 無し DB は available=false。多すぎる場合は CAP で打ち切り(capped=true)。
pathsRouter.get('/leaf_bases', (req, res) => {
  const { db, layer, x1, y1, x2, y2, maxsize } = req.query as Record<string, string>
  if (!db || layer === undefined) { res.status(400).json({ error: 'Missing db or layer' }); return }
  const L = Number(layer)
  const ms = Math.max(1, Number(maxsize) || 1)
  const bx = [x1, y1, x2, y2].map(Number)
  const hasBbox = bx.every(v => Number.isFinite(v))
  const CAP = 4000
  try {
    const d = getDb(db)
    if (!hasLeafSeq(d)) { res.json({ bases: [], available: false }); return }
    const rows = (hasBbox
      ? d.prepare(
        `SELECT n.node_name AS name, ls.seq AS base
         FROM nodes_rtree rt JOIN nodes n ON n.rowid = rt.rowid
         JOIN leaf_seq ls ON ls.leaf_id = CAST(SUBSTR(n.node_name, 2) AS INTEGER)
         WHERE rt.min_layer = ? AND rt.max_layer = ? AND rt.max_x >= ? AND rt.min_x <= ? AND rt.max_y >= ? AND rt.min_y <= ?
           AND n.node_name LIKE 'n%' AND n.size <= ? LIMIT ?`)
        .all(L, L, bx[0], bx[2], bx[1], bx[3], ms, CAP + 1)
      : d.prepare(
        `SELECT n.node_name AS name, ls.seq AS base
         FROM nodes n JOIN leaf_seq ls ON ls.leaf_id = CAST(SUBSTR(n.node_name, 2) AS INTEGER)
         WHERE n.layer_index = ? AND n.node_name LIKE 'n%' AND n.size <= ? LIMIT ?`)
        .all(L, ms, CAP + 1)) as { name: string; base: string }[]
    const capped = rows.length > CAP
    res.json({ bases: (capped ? rows.slice(0, CAP) : rows), available: true, capped })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})

// 参照座標(ref_bp)トラックのメタ: アンカーした参照キーと、そのコンティグ一覧(表示名・長さ)。
// contig_id は nodes.ref_contig_id と同じ空間。frontend は id→name/length で bp ラベルを整形する。
pathsRouter.get('/ref_contigs', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  try {
    const d = getDb(db)
    const meta = d.prepare('SELECT ref_key, is_default FROM ref_meta LIMIT 1').get() as
      { ref_key: string; is_default: number } | undefined
    const contigs = d.prepare(
      'SELECT contig_id, ref_key, name, length_bp FROM ref_contigs ORDER BY contig_id').all() as any[]
    res.json({ ref_key: meta?.ref_key ?? null, contigs })
  } catch { res.json({ ref_key: null, contigs: [] }) }
})

// アノテーション辞書(band/region/track)を1回で返す。ggb_annotate.py 産の任意表。無い表は空配列(=graceful)。
// frontend は起動時に1回取得し、node_attr.band_id/region_class を色・名前へ解決する。
// アノテ辞書の所在（サイドカー `<db>.annot` 優先 → 主 DB）。
// ★node_annot の band_id / gene_cnt / region_class は **辞書の id** を指す。片方だけ差し替わると
//   黙って違う色・違う名前になる（split-brain）ので、id と辞書は同じ所から読む。
//   ggb_annotate は辞書をサイドカーへ同梱するので、在ればそちらが正。
function annotQual(d: any): string {
  for (const schema of ['an', '']) {
    try {
      d.prepare(`SELECT 1 FROM ${schema ? schema + '.' : ''}band_dict LIMIT 1`).get()
      return schema ? schema + '.' : ''
    } catch { /* 次 */ }
  }
  for (const schema of ['an', '']) {
    try {
      d.prepare(`SELECT 1 FROM ${schema ? schema + '.' : ''}region_dict LIMIT 1`).get()
      return schema ? schema + '.' : ''
    } catch { /* 次 */ }
  }
  return ''
}
pathsRouter.get('/annot_dicts', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  const d = getDb(db)
  const q = (sql: string) => { try { return d.prepare(sql).all() as any[] } catch { return [] } }
  const one = (sql: string) => { try { return d.prepare(sql).get() as any } catch { return null } }
  // region_dict は新フォーマットで cx/cy/layer(goto 代表位置)を持つ。無い旧 DB は基本列にフォールバック。
  const AQ = annotQual(d)
  let regions = q(`SELECT region_id, name, ref_key, cx, cy, layer FROM ${AQ}region_dict ORDER BY region_id`)
  if (!regions.length) regions = q(`SELECT region_id, name, ref_key FROM ${AQ}region_dict ORDER BY region_id`)
  // annot_meta.max_gene_cnt があれば即返す(ggb_annotate が拡張時に書く)。無い旧 DB のみ MAX へフォールバック
  // するが、巨大 DB では node_annot 全走査(索引なし)が同期でイベントループを塞ぐ(stats.ts の maxima と同じ理由)
  // ため省略し 0(frontend は maxGeneCount<=1 を graceful に既定スケール扱い)。
  const metaGC = one(`SELECT value AS m FROM ${AQ}annot_meta WHERE key='max_gene_cnt'`)?.m
  const maxGeneCount = metaGC
    ?? (dbBytes(db) > HUGE_DB_BYTES ? 0 : (one(`SELECT MAX(gene_cnt) AS m FROM ${AQ}node_annot`)?.m ?? 0))
  res.json({
    bands: q(`SELECT band_id, contig_id, name, gie_stain FROM ${AQ}band_dict ORDER BY band_id`),
    regions,
    tracks: q(`SELECT track_id, kind, name, ref_key, source FROM ${AQ}track_dict ORDER BY track_id`),
    maxGeneCount,
  })
})

// 選択ノードの遺伝子特徴(サイドバー詳細)。新フォーマットは node_annot.gene_blob(per-node 詰め込み)を
// デコードして feature_dict と結合。旧レスポンス形状(feature_id/seg_start/seg_end/exonic/name/attrs/kind)を維持。
// blob = [u32 count] + count×(u32 fid, u32 seg_start, u32 seg_end, u8 exonic) (LE)。
pathsRouter.get('/node_features', (req, res) => {
  const { db, node } = req.query as Record<string, string>
  if (!db || !node) { res.status(400).json({ error: 'Missing db or node' }); return }
  try {
    const d = getDb(db)
    const row = d.prepare(
      'SELECT na.gene_blob AS blob FROM node_annot na JOIN nodes n ON n.rowid = na.node_rowid ' +
      'WHERE n.node_name = ? AND na.gene_blob IS NOT NULL LIMIT 1').get(node) as { blob: Buffer } | undefined
    if (!row || !row.blob || row.blob.length < 4) { res.json({ features: [] }); return }
    const buf = row.blob
    const cnt = buf.readUInt32LE(0)
    const feats: any[] = []
    let off = 4
    for (let i = 0; i < cnt && off + 13 <= buf.length; i++) {
      feats.push({
        feature_id: buf.readUInt32LE(off), seg_start: buf.readUInt32LE(off + 4),
        seg_end: buf.readUInt32LE(off + 8), exonic: buf.readUInt8(off + 12),
      })
      off += 13
    }
    const AQ = annotQual(d)
    const t = d.prepare(`SELECT track_id FROM ${AQ}track_dict WHERE kind='gene' LIMIT 1`).get() as { track_id: number } | undefined
    const tid = t ? t.track_id : null
    if (tid != null && feats.length) {
      const ph = feats.map(() => '?').join(',')
      const frows = d.prepare(
        `SELECT feature_id, name, attrs FROM ${AQ}feature_dict WHERE track_id=? AND feature_id IN (${ph})`
      ).all(tid, ...feats.map(f => f.feature_id)) as any[]
      const fmap = new Map(frows.map(r => [r.feature_id, r]))
      for (const f of feats) {
        const fr = fmap.get(f.feature_id)
        f.track_id = tid; f.name = fr?.name ?? String(f.feature_id); f.attrs = fr?.attrs ?? '{}'; f.kind = 'gene'
      }
    }
    feats.sort((a, b) => a.seg_start - b.seg_start)
    res.json({ features: feats })
  } catch { res.json({ features: [] }) }
})

// 遺伝子トラックの特徴一覧(名前＋参照座標 start/end/strand)。起動時に1回取得し、graph 上で ref_bp に
// 吸着して遺伝子名ラベルを重畳する(attrs JSON から座標を展開)。無い DB では空。
pathsRouter.get('/gene_features', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  try {
    const d = getDb(db)
    const AQ = annotQual(d)
    // cx/cy/layer は新フォーマットの goto 代表レイアウト位置(ref_bp を全スキャンせず遺伝子へ移動する用)。
    // 無い旧 DB は基本列にフォールバック。
    let rows: any[]
    try {
      rows = d.prepare(
        `SELECT f.name, f.attrs, f.cx, f.cy, f.layer FROM ${AQ}feature_dict f ` +
        `JOIN ${AQ}track_dict t ON t.track_id = f.track_id WHERE t.kind = 'gene'`).all() as any[]
    } catch {
      rows = d.prepare(
        `SELECT f.name, f.attrs FROM ${AQ}feature_dict f ` +
        `JOIN ${AQ}track_dict t ON t.track_id = f.track_id WHERE t.kind = 'gene'`).all() as any[]
    }
    const genes = rows.map(r => {
      let a: any = {}; try { a = JSON.parse(r.attrs || '{}') } catch { /* skip */ }
      return { name: r.name, start: a.start, end: a.end, strand: a.strand, gtype: a.gene_type,
               chrom: a.chrom, cx: r.cx ?? null, cy: r.cy ?? null, layer: r.layer ?? null }
    }).filter(g => g.start != null && g.end != null)
    res.json({ genes })
  } catch { res.json({ genes: [] }) }
})

// 遺伝子名 → マージ exon 区間(番号付き, ref 座標)。viewer の exon/intron 塗り分け・番号・ジャンクション判定用。
pathsRouter.get('/gene_exons', (req, res) => {
  const { db, gene } = req.query as Record<string, string>
  if (!db || !gene) { res.status(400).json({ error: 'Missing db or gene' }); return }
  try {
    const _d = getDb(db)
    const AQ = annotQual(_d)
    const rows = _d.prepare(
      `SELECT ge.exon_no, ge.start, ge.end FROM ${AQ}gene_exons ge ` +
      `JOIN ${AQ}feature_dict f ON f.feature_id = ge.feature_id AND f.track_id = ge.track_id ` +
      `JOIN ${AQ}track_dict t ON t.track_id = ge.track_id ` +
      `WHERE t.kind = 'gene' AND f.name = ? ORDER BY ge.exon_no`).all(gene) as any[]
    res.json({ exons: rows })
  } catch { res.json({ exons: [] }) }
})

// ノード編集の DB 反映。body = { db, gestures: [{ names, cos, sin, tx, ty, dAngle }, ...] }（適用順）。
// 各 gesture は剛体変換 T: 点 p → (cos*px - sin*py + tx, sin*px + cos*py + ty)、angle += dAngle。
// names（選択したルート）を parent_name で子孫展開し、nodes(全層)・edges(境界考慮)・両R-tree を
// 1トランザクションで更新。radius/size/被覆は不変。DB は parent_name 列を持つもののみ編集可。
pathsRouter.post('/save_edits', (req, res) => {
  const { db, gestures } = req.body as { db?: string; gestures?: any[] }
  if (!db || !Array.isArray(gestures)) { res.status(400).json({ error: 'Missing db or gestures' }); return }
  if (gestures.length === 0) { res.json({ ok: true, nodes: 0 }); return }
  // 編集可能判定（parent_name 列の有無）
  try {
    getDb(db).prepare('SELECT parent_name FROM nodes LIMIT 1').get()
  } catch {
    res.status(409).json({ error: 'このDBは編集非対応です（nodes.parent_name が無い。emitter で再生成が必要）' }); return
  }

  let w: ReturnType<typeof getWritableDb> | null = null
  try {
    w = getWritableDb(db)
    // signed スキーマ(座標非保存)は edges を一切書き戻さない: ノードの中心/角度を剛体変換すれば
    // 端点(center ± r·(cosθ,sinθ) / 相手中心方向)は符号不変のまま自動追従する(T の適用と数式上一致)。
    const signed = dbEdgesSigned(w)
    // 子孫展開の再帰を速くする索引（無ければ作成・冪等）
    w.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_name)')
    if (!signed) w.exec('CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)')
    w.exec('CREATE TEMP TABLE IF NOT EXISTS _edit_names(name TEXT PRIMARY KEY)')

    const clearNames = w.prepare('DELETE FROM _edit_names')
    // seed 名（JSON配列）から parent_name を辿って子孫名を集める（UNION で永続ノードの自己参照ループを終端）
    const fillNames = w.prepare(`
      WITH RECURSIVE dd(name) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT n.node_name FROM nodes n JOIN dd ON n.parent_name = dd.name)
      INSERT OR IGNORE INTO _edit_names(name) SELECT name FROM dd`)
    // nodes 幾何（xCoord/yCoord の RHS は SQLite が旧値で評価するので相互参照でも正しい）
    const updNodes = w.prepare(`
      UPDATE nodes SET
        xCoord = :cos*xCoord - :sin*yCoord + :tx,
        yCoord = :sin*xCoord + :cos*yCoord + :ty,
        angle  = angle + :dAngle
      WHERE node_name IN (SELECT name FROM _edit_names)`)
    // R-Tree の幾何。★`ggb_hapidx --draw-aux` で `ang`（angle×ANG_SCALE）補助列がある DB では
    //   それも一緒に更新する。**触る行は増えない**（幾何が動く行＝ang も動く行）ので、
    //   上層ノードを動かして子孫全部を書き換えるケースでもコストは実質変わらない。
    //   （これがエッジに端点座標を持たせられない理由と対照的な点: あちらは行数の多い別の表を
    //     追加で更新することになるが、こちらは既に更新している行に列が 1 つ増えるだけ。）
    const rtHasAng = (() => {
      try {
        return (w.prepare('PRAGMA table_info(nodes_rtree)').all() as any[]).some(c => c.name === 'ang')
      } catch { return false }
    })()
    const angScale = (() => {
      try {
        const v = (w.prepare("SELECT value FROM hapidx_meta WHERE key='ang_scale'").get() as any)?.value
        return Number(v) || 1000000
      } catch { return 1000000 }
    })()
    const updNodesRtree = w.prepare(`
      UPDATE nodes_rtree SET
        min_x = (SELECT xCoord - radius FROM nodes WHERE nodes.rowid = nodes_rtree.rowid),
        max_x = (SELECT xCoord + radius FROM nodes WHERE nodes.rowid = nodes_rtree.rowid),
        min_y = (SELECT yCoord - radius FROM nodes WHERE nodes.rowid = nodes_rtree.rowid),
        max_y = (SELECT yCoord + radius FROM nodes WHERE nodes.rowid = nodes_rtree.rowid)${
        rtHasAng ? `,
        ang = (SELECT CAST(ROUND(angle * ${angScale}) AS INTEGER) FROM nodes WHERE nodes.rowid = nodes_rtree.rowid)` : ''}
      WHERE rowid IN (SELECT rowid FROM nodes WHERE node_name IN (SELECT name FROM _edit_names))`)
    // edges の座標書き戻しは座標保存スキーマ限定。signed は null（端点はノード追従で自動整合）。
    // source 側は start+startc、target 側は end+endc を変換（片端のみ部分集合内なら該当端のみ動く）
    const updEdgesSrc = signed ? null : w.prepare(`
      UPDATE edges SET
        start_x = :cos*start_x - :sin*start_y + :tx,
        start_y = :sin*start_x + :cos*start_y + :ty,
        startc_x = :cos*startc_x - :sin*startc_y + :tx,
        startc_y = :sin*startc_x + :cos*startc_y + :ty
      WHERE source IN (SELECT name FROM _edit_names)`)
    const updEdgesTgt = signed ? null : w.prepare(`
      UPDATE edges SET
        end_x = :cos*end_x - :sin*end_y + :tx,
        end_y = :sin*end_x + :cos*end_y + :ty,
        endc_x = :cos*endc_x - :sin*endc_y + :tx,
        endc_y = :sin*endc_x + :cos*endc_y + :ty
      WHERE target IN (SELECT name FROM _edit_names)`)
    const updEdgesRtree = signed ? null : w.prepare(`
      UPDATE edges_rtree SET
        min_x = (SELECT min(min(start_x,end_x),min(startc_x,endc_x)) FROM edges WHERE edges.rowid=edges_rtree.rowid),
        max_x = (SELECT max(max(start_x,end_x),max(startc_x,endc_x)) FROM edges WHERE edges.rowid=edges_rtree.rowid),
        min_y = (SELECT min(min(start_y,end_y),min(startc_y,endc_y)) FROM edges WHERE edges.rowid=edges_rtree.rowid),
        max_y = (SELECT max(max(start_y,end_y),max(startc_y,endc_y)) FROM edges WHERE edges.rowid=edges_rtree.rowid)
      WHERE rowid IN (SELECT rowid FROM edges WHERE source IN (SELECT name FROM _edit_names) OR target IN (SELECT name FROM _edit_names))`)

    let totalNodes = 0
    const apply = w.transaction((gs: any[]) => {
      for (const g of gs) {
        const names: string[] = Array.isArray(g?.names) ? g.names.filter((s: any) => typeof s === 'string') : []
        const p = { cos: Number(g?.cos), sin: Number(g?.sin), tx: Number(g?.tx), ty: Number(g?.ty), dAngle: Number(g?.dAngle) }
        if (names.length === 0) continue
        if (![p.cos, p.sin, p.tx, p.ty, p.dAngle].every(Number.isFinite)) continue
        clearNames.run()
        fillNames.run(JSON.stringify(names))
        totalNodes += updNodes.run(p).changes
        updNodesRtree.run()
        updEdgesSrc?.run(p)
        updEdgesTgt?.run(p)
        updEdgesRtree?.run()
      }
    })
    apply(gestures)
    res.json({ ok: true, nodes: totalNodes })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  } finally {
    if (w) { try { w.close() } catch {} }
  }
})

// 葉(base 節点)の塩基配列。node_name 'n<id>' の id で leaf_seq を直引き(層非依存 1葉1行)。
// 巨大配列(chrY 最大 2.77Mbp)対策で既定は先頭 SEQ_CAP まで返し、full=1 で全長。
// leaf_seq 表の無い DB(--emit-seq 未指定)や葉でない node は available/seq=null で graceful。
const SEQ_CAP = 100000
pathsRouter.get('/leaf_seq', (req, res) => {
  const { db, name, full } = req.query as Record<string, string>
  if (!db || !name) { res.status(400).json({ error: 'Missing db or name' }); return }
  try {
    const d = getDb(db)
    if (!hasLeafSeq(d)) { res.json({ available: false, name, seq: null }); return }
    // 葉のみ配列を持つ。node_name は 'n<original_id>' (S/G クラスタは配列なし)。
    const m = /^n(\d+)$/.exec(name)
    if (!m) { res.json({ available: true, name, leaf: false, seq: null }); return }
    const leafId = Number(m[1])
    const row = d.prepare('SELECT seq FROM leaf_seq WHERE leaf_id = ?').get(leafId) as { seq: string } | undefined
    if (!row) { res.json({ available: true, name, leaf: true, leaf_id: leafId, len: 0, seq: null }); return }
    const len = row.seq.length
    const truncated = full !== '1' && len > SEQ_CAP
    res.json({
      available: true, name, leaf: true, leaf_id: leafId, len,
      seq: truncated ? row.seq.slice(0, SEQ_CAP) : row.seq,
      truncated,
    })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})
