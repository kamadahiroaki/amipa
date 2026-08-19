import { Router } from 'express'
import zlib from 'zlib'
import path from 'path'
import { execFile } from 'child_process'
import { getDb, getDbDir, dbBytes, HUGE_DB_BYTES, nameTriSchema, readsSchema } from '../db'
import { AMIPA_PYTHON, amipaScript } from '../pyenv'
import { poolAvailable, runOnWorker, AbandonedError, progressFor, type WorkerReply } from '../workerPool'
import { runQueryJob, plainCtx, type QueryJob } from '../dbJobs'
import {
  tableCols, nodeCovExprs, refPosSel, compSel, kindSel, nodeExtraSel, nodeAttrSel,
  buildNodesSql, buildNodesSqlLegacy, parseNodes,
} from '../nodeQuery'
import {
  edgesHasSigns, edgeRsExpr, edgeExtraSel, buildSignedEdgesSql, signedEdgeBranchParams,
  buildEdgesSql, edgesQueryLegacy,
} from '../edgeQuery'
import { hasSignSchema, VISIBLE_NODE_SUBQUERY } from '../edgeGeom'
import {
  buildSelection, maskWhere, hapIdxEdgeOk, exactFilterRowids, type Selection,
} from '../hapidx'
import {
  guardedAll, setGuardHeaders, cappedCount, probeCapFor, FETCH_MS, PROBE_CAP,
} from '../fetchGuard'

export const graphRouter = Router()

// hap 絞り込み（sel=<contig_id レンジ列>）。マスクの置き場所（main.nodes_rtree の補助列 or
// サイドカー ix.nodes_rtree_hm）は hapidx.ts が解決し Selection.rtree に入る。無い/選択が空なら
// null で従来経路。棄却候補は太い nodes 行を読まずに済むのが要点（実測 functions/hapfilter/RESULTS.md）。
function selOf(d: any, req: any): Selection | null {
  try { return buildSelection(d, (req.query as any).sel) } catch { return null }
}

// worker の結果をそのまま返す共通処理（/nodes /edges /nodes_grid の 3 箇所で同一）。
//
// 本文は **worker 側で JSON 化も gzip も済んでいる**ので、メインはヘッダを付けて流すだけ。
// Content-Encoding を立てるとメインの compression ミドルウェアは 'already encoded' で素通しする
// ＝重い本文の deflate がイベントループに乗らない（worker 化の目的をここで壊さないため）。
// Vary は proxy/ブラウザキャッシュが素と gzip を混同しないように必ず付ける。
function sendWorkerReply(res: any, r: WorkerReply) {
  res.setHeader('X-AMIPA-Rows', String(r.rows ?? 0))
  if (r.ms != null) res.setHeader('X-AMIPA-Ms', r.ms.toFixed(1))
  if (r.layer != null) res.setHeader('X-AMIPA-Layer', String(r.layer))
  if (r.truncated) res.setHeader('X-AMIPA-Truncated', r.truncated)
  res.setHeader('Vary', 'Accept-Encoding')
  if (r.enc) res.setHeader('Content-Encoding', r.enc)
  res.type('application/json').send(r.body)
}

// リード表そのものが在るか。emitter が出す素の DB には無い（reads は ggb_reads で後付する）。
// PRAGMA table_info は表が無くても空を返すだけで例外にならないので、それでは判定できない。
function raTableExists(d: any): boolean {
  try {
    return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='read_alignments'").get()
  } catch { return false }
}

// read_alignments の新スキーマ（node_id INTEGER, cigar BLOB圧縮）かを判定。
// 旧スキーマ（node_name TEXT, cigar TEXT）のDBとは別経路でクエリする。
function raHasNodeId(d: any): boolean {
  try {
    return (d.prepare('PRAGMA table_info(read_alignments)').all() as any[])
      .some(c => c.name === 'node_id')
  } catch { return false }
}

// オンデマンド: リード転置索引(node_reads, サイドカー rd or 本体)があるか。有→ per-read 行は DB に無く、
// zstd GAF(旧アトラスは BGZF)から Python ヘルパ(reads_query.py)で該当行だけ取り出して parse する。
// cs スライスは前処理側と共有(TS 再実装しない)。
function readNodeAvail(d: any): boolean {
  try { return readsSchema(d) != null } catch { return false }
}
// 実行体とスクリプトの解決は pyenv.ts に集約（絶対パスを埋めるとコンテナで動かない）。
const AMIPA_PY = AMIPA_PYTHON
const AMIPA_READS_QUERY = (process.env.AMIPA_READS_QUERY ?? process.env.GGB_READS_QUERY) || amipaScript('reads_query.py')
function readsHelper(dbFile: string, args: string[]): Promise<any> {
  const dbPath = path.join(getDbDir(), path.basename(dbFile))
  return new Promise((resolve, reject) => {
    execFile(AMIPA_PY, [AMIPA_READS_QUERY, '--db', dbPath, ...args],
      { maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => {
        if (err) { reject(err); return }
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
      })
  })
}

// cigar の復号: 旧スキーマは TEXT（string）、新スキーマは BLOB（Buffer）。
// BLOB は先頭が 0x78 なら zlib圧縮、それ以外は生のCIGARテキスト（数字始まり）。
function decodeCigar(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (Buffer.isBuffer(v)) {
    if (v.length >= 2 && v[0] === 0x78) {
      try { return zlib.inflateSync(v).toString() } catch { return v.toString() }
    }
    return v.toString()
  }
  return String(v)
}







// ── Find>Node のノード名検索 ────────────────────────────────────────────────
// 以前は一律 `node_name LIKE '%q%'`。先頭ワイルドカードで idx_nodes_node_name が使えず
// (EQP: `SCAN n`)、chr22(nodes 6.77M 行/590MB)でも **cold 48.7 秒**かかっていた。
// better-sqlite3 は同期 API なので、その間 backend のイベントループが丸ごと止まる。
// 段階的に絞る形へ変更する:
//   ① 完全一致 `= q`            → idx_nodes_node_name の点シーク（cold 0.12s / warm ~0ms）
//   ② 前方一致 `GLOB 'q*'`      → 同索引のレンジシーク（cold 0.27s）
//      ※ `LIKE 'q%'` ではダメ。SQLite の LIKE 最適化は大小無視 LIKE に NOCASE 照合の索引を
//        要求するが node_name は BINARY 照合なので、索引の**全走査**に落ちる。GLOB は大小
//        区別なのでレンジシークになる（EQP で確認済）。
//   ③ 部分一致                  → trigram 索引 nmfts があればそれで名前を解決してから
//                                 idx_nodes_node_name で行を引く（cold 0.4-1.5s / warm 0.01s）。
//                                 無い DB のみ従来の全走査へ（＝旧 DB でも動く graceful 縮退）。
//
// あわせて **1 名前 1 行** に畳む。nodes は (layer_index, node_name) 主キーで、存続するノードは
// birth..death の各層に 1 行ずつ出る（chr22: 6.77M 行 / 5.10M ユニーク名、最多 13 行/名）。
// 以前は畳んでいなかったので、1 ノードが最大 13 行を占めて 50 件の枠を食い潰し、候補が実質
// 4 件しか出ないことがあった。層違いの行はジオメトリが完全に同一（xCoord/yCoord/radius/size が
// 層をまたいで不変なことを実 DB で確認済）で、違うのは層だけ。返す層は **最も粗い層＝MIN(layer_index)**
// （そのノードが単体で見え始める層）とする。rowid 順に走査していた従来実装が実質返していた層と同じ。
//   ※ layer は従来 nodes_rtree.min_layer から取っていたが、全 DB で min_layer = layer_index である
//     ことを確認したので MIN(layer_index) に統一し、行ごとの rtree probe を無くす。
const NODE_SEARCH_LIMIT = 50
const nodeSearchCols = (extra: string) => `
  SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size,
         n.xCoord, n.yCoord, n.angle, n.radius, n.color${extra},
         MIN(n.layer_index) AS layer
  FROM nodes n
`
// 部分一致の名前解決だけを trigram 側に投げるサブクエリ。層をまたいだユニーク名が返る。
const triNameSubquery = (schema: string) =>
  `SELECT nm FROM ${schema}.nmfts WHERE nm LIKE ? LIMIT ?`


// 1 段ぶんの検索。extra 列（haplotype/coverage/cov_hist）を持たない旧 DB は自動で落として再試行。
// GROUP BY で 1 名前 1 行に畳む（bare 列は MIN(layer_index) の行の値＝SQLite の規定動作。
// どのみち層違いの行はジオメトリが同一なのでどの行から取っても同じ）。
function runNodeSearch(d: any, where: string, params: any[]): any[] {
  const q = (extra: string) =>
    d.prepare(`${nodeSearchCols(extra)} WHERE ${where} ` +
              `GROUP BY n.node_name LIMIT ${NODE_SEARCH_LIMIT}`).all(...params) as any[]
  try {
    return parseNodes(q(', n.haplotype, n.coverage, n.cov_hist'))
  } catch {
    return q('')
  }
}

graphRouter.get('/search', (req, res) => {
  const { db, name } = req.query as Record<string, string>
  if (!db || !name) { res.status(400).json({ error: 'Missing query parameters' }); return }
  try {
    const d = getDb(db)
    // ① 完全一致
    let rows = runNodeSearch(d, 'n.node_name = ?', [name])
    // ② 前方一致（GLOB のメタ文字を含む入力はエスケープできないので素通しせずスキップ）
    if (rows.length === 0 && !/[*?[\]]/.test(name)) {
      rows = runNodeSearch(d, 'n.node_name GLOB ?', [`${name}*`])
    }
    // ③ 部分一致
    if (rows.length === 0) {
      const schema = nameTriSchema(d)
      const pat = `%${name.replace(/[%_]/g, m => `\\${m}`)}%`
      rows = schema
        ? runNodeSearch(d, `n.node_name IN (${triNameSubquery(schema)})`,
                        [pat, NODE_SEARCH_LIMIT])
        // trigram 索引の無い旧 DB。nodes 全走査になるので巨大 DB では走らせない
        // （サーバ全体が数分〜数十分止まるため。ggb_nametri.py で後付けできる）。
        : dbBytes(db) >= HUGE_DB_BYTES
          ? []
          : runNodeSearch(d, "n.node_name LIKE ? ESCAPE '\\'", [pat])
    }
    res.json(rows)
  } catch (e) {
    console.error('search failed:', e)
    res.status(500).json({ error: String(e) })
  }
})

// idx_nodes_refpos(ref_contig_id, ref_bp) の有無。無い DB では /goto が nodes 全走査に落ちるので、
// 巨大 DB では実行前に弾く判断に使う（better-sqlite3 は同期なので全走査はサーバ全体を止める）。
const refIdxCache = new WeakMap<any, boolean>()
function hasRefPosIndex(d: any): boolean {
  let v = refIdxCache.get(d)
  if (v === undefined) {
    try {
      v = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_nodes_refpos'").get()
    } catch { v = false }
    refIdxCache.set(d, v)
  }
  return v
}
// ref_meta.max_span = 参照区間の最長ノード長。/goto の下限クリップに使う。無い旧 DB は null。
const maxSpanCache = new WeakMap<any, number | null>()
function refMaxSpan(d: any): number | null {
  let v = maxSpanCache.get(d)
  if (v === undefined) {
    try {
      const r = d.prepare('SELECT max_span AS m FROM ref_meta WHERE max_span IS NOT NULL LIMIT 1').get() as any
      v = r && Number.isFinite(Number(r.m)) ? Number(r.m) : null
    } catch { v = null }
    maxSpanCache.set(d, v)
  }
  return v
}

// A1 go-to-position: 参照コンティグ上の bp 位置へ移動するためのノード解決。
// ref_bp トラックのある DB のみ。frontend は返ったノードへ navigateTo する（追加往復 1 回）。
// 1) [ref_bp, ref_bp_end] が target を含むノードのうち最も細かい層（min_layer 最大）を返す
//    ＝その位置を「含む」最深ノードにピタリ着地。2) 無ければ |ref_bp - target| 最小（is_anchor 優先）。
//
// 2026-08-03 索引化: 以前は両クエリとも `SCAN n`(nodes 全走査)＋TEMP B-TREE で、chr22(6.8M 行/590MB)
// でも **cold 72 秒**、その間 backend のイベントループが停止していた。emitter が張る
// idx_nodes_refpos(ref_contig_id, ref_bp) WHERE ref_bp IS NOT NULL を使う形に書き換える:
//   1) 含有クエリ: `ref_bp <= T` だけだとコンティグ先頭〜T の片側レンジを舐めるので、
//      ref_meta.max_span で `ref_bp >= T - max_span` を下限に足す（区間長が max_span を超える
//      ノードは定義上無いので取りこぼさない）。max_span が無い旧 DB は下限なしへフォールバック。
//      ※ 実測ではこの下限はほぼ効かない: リピート/サイクルで参照が同じノードを離れた 2 か所で
//        通ると見かけの区間長が巨大になり、chr22 では max_span = コンティグ全長だった。
//        72.4s→0.50s(cold) の改善はほぼ idx_nodes_refpos 自体の効果。下限は常に正しいので残す。
//   2) 最近傍クエリ: ABS() は索引でソートできないので、下側(ref_bp<=T を降順)と上側(ref_bp>=T を昇順)
//      の 2 本に分けてそれぞれ索引駆動で近傍 NEAR_WIN 件を取り、JS 側で (|距離|, is_anchor DESC)
//      に並べ替えて最良を採る。真の最小は必ず両側の最近傍のどちらかなので結果は従来と一致する。
const NEAR_WIN = 32   // 片側あたりの候補数。同一 ref_bp の重複(層違い)を吸収できる程度に取る
graphRouter.get('/goto', (req, res) => {
  const { db, contig, bp } = req.query as Record<string, string>
  if (!db || contig == null || bp == null) { res.status(400).json({ error: 'Missing db/contig/bp' }); return }
  const cid = Number(contig), target = Number(bp)
  if (!Number.isFinite(cid) || !Number.isFinite(target)) { res.status(400).json({ error: 'Invalid contig/bp' }); return }
  try {
    const d = getDb(db)
    if (!tableCols(d, 'nodes').has('ref_bp')) { res.status(400).json({ error: 'this DB has no ref_bp track' }); return }
    // 索引の無い巨大 DB は実行させない。走らせると nodes 全走査でサーバ全体が数分〜数十分固まる。
    if (!hasRefPosIndex(d) && dbBytes(db) >= HUGE_DB_BYTES) {
      res.status(400).json({ error: 'this DB lacks idx_nodes_refpos; position search is disabled ' +
        'on huge DBs to avoid blocking the server. Rebuild the DB, or add the index manually.' })
      return
    }
    // LOD DB に必ずある列のみ（haplotype/coverage は legacy 経路と同じく含めない）。
    // 候補選択は nodes 単独（＝索引だけで決まる）で行い、rtree JOIN は確定した 1 行にだけ効かせる。
    const COLS = `n.rowid AS id, n.node_name, n.is_bubble, n.size,
                  n.xCoord, n.yCoord, n.angle, n.radius, n.color,
                  r.min_layer AS layer,
                  n.ref_contig_id, n.ref_bp, n.ref_bp_end, n.is_anchor, n.ref_multi`
    const FROM = 'FROM nodes n JOIN nodes_rtree r ON n.rowid = r.rowid'

    // 1) 含有。★勝者の rowid だけを **被覆索引の中で** 決め、太い表アクセスはその 1 行に限定する。
    //    表示列や nodes_rtree を最初から JOIN すると候補ごとに表を引くことになり、
    //    コンティグ後半を狙うほど遅い（chr22 コールド実測 bp=45Mb で 29.8s。索引だけで決めれば 0.11s）。
    const span = refMaxSpan(d)
    const lo = span == null ? null : target - span
    const winner = d.prepare(
      `SELECT rowid AS id FROM nodes
       WHERE ref_contig_id = ? AND ref_bp IS NOT NULL
         AND ref_bp <= ?${lo == null ? '' : ' AND ref_bp >= ?'}
         AND COALESCE(ref_bp_end, ref_bp) >= ?
       ORDER BY layer_index DESC LIMIT 1`
    ).get(...(lo == null ? [cid, target, target] : [cid, target, lo, target])) as any
    let row = winner
      ? d.prepare(`SELECT ${COLS} ${FROM} WHERE n.rowid = ?`).get(winner.id)
      : undefined

    // 2) 最近傍: 下側/上側を索引駆動で別々に取り、JS で従来の並び順を再現する。
    if (!row) {
      const side = (cmp: string, dir: string) =>
        `SELECT ${COLS} ${FROM}
         WHERE n.ref_contig_id = ? AND n.ref_bp IS NOT NULL AND n.ref_bp ${cmp} ?
         ORDER BY n.ref_bp ${dir} LIMIT ${NEAR_WIN}`
      const cand = [
        ...(d.prepare(side('<=', 'DESC')).all(cid, target) as any[]),
        ...(d.prepare(side('>=', 'ASC')).all(cid, target) as any[]),
      ]
      cand.sort((a, b) =>
        Math.abs(a.ref_bp - target) - Math.abs(b.ref_bp - target) || (b.is_anchor ?? 0) - (a.is_anchor ?? 0))
      row = cand[0]
    }
    if (!row) { res.status(404).json({ error: 'no node found for this position' }); return }
    res.json({ node: row })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// 経路ノードの一括取得（リード経路を view へ追加する用）。layer_index=1 の完全名一致のみ。
graphRouter.get('/nodes_by_name', (req, res) => {
  const { db, names } = req.query as Record<string, string>
  if (!db || !names) { res.status(400).json({ error: 'Missing db or names' }); return }
  const list = names.split(',').map(s => s.trim()).filter(Boolean)
  if (list.length === 0) { res.json([]); return }
  const ph = list.map(() => '?').join(',')
  // ★以前は `AND n.layer_index = 1` を決め打ちしていた。多層 LOD では 1 葉が層ごとに複数行
  //   持ち、**葉の名前を渡すと必ず空**が返っていた（リードの経路ノードは全部葉なので、
  //   「経路ノードを view に追加」が何も起きない、という形で出ていた）。
  //   名前ごとに **MAX(rowid)＝最深層の出現**を 1 行返す（read_alignments と同じ規約）。
  const d0 = getDb(db)
  const optCols = ['coverage', 'cov_hist', 'haplotype']
    .filter(c => tableCols(d0, 'nodes').has(c)).map(c => `, n.${c}`).join('')
  const sel = (cols: string) =>
    `SELECT n.rowid AS id, n.node_name, n.is_bubble, n.size,
            n.xCoord, n.yCoord, n.angle, n.radius, n.color${cols},
            r.min_layer AS layer
     FROM nodes n LEFT JOIN nodes_rtree r ON n.rowid = r.rowid
     WHERE n.rowid IN (SELECT MAX(rowid) FROM nodes WHERE node_name IN (${ph}) GROUP BY node_name)`
  try {
    res.json(parseNodes(getDb(db).prepare(sel(optCols)).all(...list) as any[]))
  } catch {
    try {
      res.json(getDb(db).prepare(sel('')).all(...list) as any[])
    } catch (e) {
      console.error('nodes_by_name failed:', e); res.json([])
    }
  }
})

// 選択した 1 ノードの「描画では使わない属性」を後から引く。
// 描画の高速経路(nx=fast, buildNodesSqlFast)は R-Tree だけを読むので size/kind/haplotype/coverage/
// comp_id/parent_name を返さない。ノード詳細パネルはそれらを出すので、ノードが選択されたときだけ
// node_name の索引(idx_nodes_node_name)で 1 行引き直す(WG でもシーク 1 回で済む)。
graphRouter.get('/node_info', (req, res) => {
  const { db, name } = req.query as Record<string, string>
  if (!db || !name) { res.status(400).json({ error: 'Missing db or name' }); return }
  const d = getDb(db)
  const cols = new Set<string>()
  try { for (const r of d.prepare('PRAGMA table_info(nodes)').all() as any[]) cols.add(r.name) } catch { /* ignore */ }
  const want = ['size', 'kind', 'haplotype', 'coverage', 'comp_id', 'parent_name', 'is_bubble']
    .filter(c => cols.has(c))
  if (want.length === 0) { res.json({}); return }
  try {
    // 同じ node_name は層ごとに行があるので最下層(=葉に一番近い)を 1 行だけ。
    const row = d.prepare(
      `SELECT ${want.join(', ')} FROM nodes WHERE node_name = ? ORDER BY layer_index DESC LIMIT 1`,
    ).get(name) as Record<string, unknown> | undefined
    res.json(row ?? {})
  } catch (e) {
    console.error('node_info failed:', e); res.json({})
  }
})

// LOD-A: layer L・ビューポート矩形内のグリフ数を R-tree で厳密カウント（§5）。
// 予算 V_max による層の hard cap 判定に使う。深すぎる層を広ビューで数えないよう、
// フロントは d_world 予測で候補層を絞ってから叩くこと。
const nodeCountSql = `
  SELECT COUNT(*) AS n FROM nodes_rtree
   WHERE min_layer <= ? AND max_layer >= ?
     AND max_x >= ? AND min_x <= ? AND max_y >= ? AND min_y <= ?`
// 絞り込み時のカウント。層自動選択がこの値を見るので、絞り込むと同じ予算でより深い層に降りられる
// （実測: V_max=20000 の密ビューで L7 止まり → 1 hap 絞り込みで L12=葉レベル）。
// bucket モード/コンティグ粒度では上位集合カウント（真値以上）になる点に注意（層選択には安全側）。
function countStmtFor(d: any, sel: Selection | null) {
  if (!sel) return { sql: nodeCountSql, extra: [] as bigint[] }
  // maskWhere は別名前置きなので、テーブル名（schema 付き）をそのまま別名として使う
  const mw = maskWhere(sel.rtree, sel)
  return {
    sql: `SELECT COUNT(*) AS n FROM ${sel.rtree}
   WHERE min_layer <= ? AND max_layer >= ?
     AND max_x >= ? AND min_x <= ? AND max_y >= ? AND min_y <= ?` + mw.sql,
    extra: mw.params,
  }
}
graphRouter.get('/node_count', (req, res) => {
  const { db, layer, x1, x2, y1, y2 } = req.query as Record<string, string>
  if (!db || layer == null || !x1 || !x2 || !y1 || !y2) {
    res.status(400).json({ error: 'Missing query parameters' }); return
  }
  const L = Number(layer)
  try {
    const d = getDb(db)
    const sel = selOf(d, req)
    const q = countStmtFor(d, sel)
    const row = d.prepare(q.sql)
      .get(L, L, Number(x1), Number(x2), Number(y1), Number(y2), ...q.extra) as { n: number }
    res.json({ n: row?.n ?? 0 })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// LOD-A: 複数 layer のビューポート内グリフ数を 1 往復でまとめて厳密カウント（層自動選択用）。
// 一様密度予測は不均一レイアウトで大きく外れるため、選択は実カウントで行う（§7）。
graphRouter.get('/node_counts', (req, res) => {
  const { db, layers, x1, x2, y1, y2 } = req.query as Record<string, string>
  if (!db || !layers || !x1 || !x2 || !y1 || !y2) {
    res.status(400).json({ error: 'Missing query parameters' }); return
  }
  const Ls = layers.split(',').map(Number).filter(n => Number.isFinite(n))
  try {
    const d = getDb(db)
    const sel = selOf(d, req)
    const q = countStmtFor(d, sel)
    const stmt = d.prepare(q.sql)
    const bx1 = Number(x1), bx2 = Number(x2), by1 = Number(y1), by2 = Number(y2)
    const counts: Record<number, number> = {}
    for (const L of Ls)
      counts[L] = (stmt.get(L, L, bx1, bx2, by1, by2, ...q.extra) as { n: number })?.n ?? 0
    res.json({ counts })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ── 表示層の決定（LOD 安全弁）─────────────────────────────────────────────────
// 設計: `L = min(L_zoom, L_safe)`。
//   L_zoom : viewer が **zoom だけ**から決める層（パンでは変わらない。ユーザの ± UI もこれに乗る）。
//            = クエリ引数 `layer`。
//   L_safe : 取得が maxRows に収まる最深層。**下げる方向にしか働かない非対称 clamp**。
// 上限に触れなければ L = L_zoom で完全にズーム固定。密領域では detail が落ちるが、抜ければ
// L_zoom に戻る（戻り先が一意なので「任意の層を行き来する」不安定さは起きない）。
// fallback したことは返り値で通知し、viewer は「密すぎて L-n 表示中／サンプル絞り込みを推奨」を出す。
//
// コスト: 1 プローブ = 打ち切りカウント（実測 warm 0.24-0.34ms、密度非依存）。通常 1 回で終わる。
// 絞り込み(sel)時はマスク条件のせいで LIMIT が候補を止められず O(候補) になるので、
// **まず素のカウントでラダーを回し、絞り込みカウントは「収まる」確認にだけ使う**。
const pickMemo = new Map<string, { layer: number; counts: Record<number, number> }>()
graphRouter.get('/pick_layer', (req, res) => {
  const { db, layer, x1, x2, y1, y2 } = req.query as Record<string, string>
  if (!db || layer == null || !x1 || !x2 || !y1 || !y2) {
    res.status(400).json({ error: 'Missing query parameters' }); return
  }
  const requested = Math.max(0, Number(layer))
  const maxRows = Math.max(0, Number((req.query as any).maxRows) || 0)
  const rect = { x1: Number(x1), x2: Number(x2), y1: Number(y1), y2: Number(y2) }
  if (!maxRows) { res.json({ layer: requested, requested, fallback: false, counts: {} }); return }
  // ⚠ memo キーには **絞り込み(sel) も含める**。含めないと「絞り込み無しの答え」を
  //   絞り込み有りの要求が拾ってしまう（＝絞り込んでも深い層に戻れない）。
  const selKey = String((req.query as any).sel ?? '')
  const key = `${db}|${requested}|${maxRows}|${selKey}|${x1},${x2},${y1},${y2}`
  const hit = pickMemo.get(key)
  if (hit) { res.json({ ...hit, requested, fallback: hit.layer < requested, memo: true }); return }
  try {
    const d = getDb(db)
    const sel = selOf(d, req)
    const rtree = sel ? sel.rtree : 'nodes_rtree'
    const cap = probeCapFor(maxRows)
    const counts: Record<number, number> = {}
    let L = requested
    for (; L > 0; L--) {
      const n = cappedCount(d, rtree, L, rect, cap)   // 素のカウント（絞り込み条件なし＝O(cap)）
      counts[L] = n
      if (n <= maxRows) break
    }
    // 絞り込み中は実際の件数がさらに減るので、素のカウントで棄却された層でも収まることがある。
    // L_zoom へ向かって絞り込みカウントで再挑戦する（1 段ずつ。O(候補) なので深追いしない）。
    if (sel && L < requested) {
      const mw = maskWhere('r', sel)
      for (let M = L + 1; M <= requested; M++) {
        const n = cappedCount(d, rtree, M, rect, cap, mw.sql, mw.params)
        counts[M] = n
        if (n > maxRows) break
        L = M
      }
    }
    const out = { layer: L, counts }
    if (pickMemo.size > 2000) pickMemo.clear()
    pickMemo.set(key, out)
    res.json({ ...out, requested, fallback: L < requested,
               reason: L < requested ? 'too_dense' : 'ok',
               hint: L < requested
                 ? 'この領域はこの層では密すぎます。サンプル/ハプロタイプで絞り込むと深い層に戻せます'
                 : undefined,
               maxRows, probeCap: PROBE_CAP })
  } catch (e) {
    // 判定できない時は要求どおりの層を返す（安全弁が壊れても機能を止めない。取得側の
    // 時間ガードが最後の砦になる）。
    console.error('pick_layer failed:', e)
    res.json({ layer: requested, requested, fallback: false, counts: {}, error: String(e) })
  }
})

graphRouter.get('/nodes', (req, res) => {
  const { db, layer, x1, x2, y1, y2 } = req.query as Record<string, string>
  if (!db || !layer || !x1 || !x2 || !y1 || !y2) {
    res.status(400).json({ error: 'Missing query parameters' })
    return
  }
  const q = req.query as Record<string, string>
  // ★ビューポート取得は DB 読み取りの主役。worker へ出してメインのイベントループを空ける。
  //   投入前に切断済みなら捨て、実行中に切断されたらキャンセル旗で走行中のクエリごと止める。
  //   クエリ組み立ては nodeQuery.ts に切り出して worker と共有しているので、SQL は完全に同一。
  const job: QueryJob = {
    kind: 'nodes', db, layer: Number(layer),
    x1: Number(x1), x2: Number(x2), y1: Number(y1), y2: Number(y2),
    mapq: Math.max(0, Number(q.mapq) || 0),
    maxRows: Math.max(0, Number(q.maxRows) || 0),
    nx: String(q.nx || ''),
    sel: q.sel || undefined,
  }
  if (poolAvailable()) {
    runOnWorker(job, res, q.pid)
      .then(r => sendWorkerReply(res, r))
      .catch(e => {
        if (e instanceof AbandonedError || res.closed) return
        console.error('nodes worker failed; falling back:', e)
        try { inlineNodes() } catch (e2) { res.status(500).json({ error: String(e2) }) }
      })
    return
  }
  inlineNodes()

  // worker が使えないときのメイン実行。**同じ dbJobs の関数**を呼ぶので挙動は一致する
  // （以前はここに handler 本体を二重に持っていたが、SQL 組み立てを共有化したので不要になった）。
  function inlineNodes() {
    try {
      const r = runQueryJob(getDb(db), job, plainCtx)
      res.setHeader('X-AMIPA-Rows', String(r.rows ?? 0))
      if (r.ms != null) res.setHeader('X-AMIPA-Ms', r.ms.toFixed(1))
      if (r.layer != null) res.setHeader('X-AMIPA-Layer', String(r.layer))
      if (r.truncated) {
        res.setHeader('X-AMIPA-Truncated', r.truncated)
        const lv = r.truncated === 'time' ? console.warn : console.log
        lv(`[guard] nodes truncated by ${r.truncated}: layer=${r.layer} rows=${r.rows} ` +
           `${(r.ms ?? 0).toFixed(0)}ms`)
      }
      res.json(r.payload)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  }
})

// 取得の進捗。クライアントが発行した pid(取得ごとのランダム ID)で引く。
// worker が SharedArrayBuffer に書いた処理済み行数をメインが Atomics.load で読むだけなので、
// **重い取得が走っている最中でも即座に応答できる**（メインループが空いているのが前提）。
graphRouter.get('/fetch_progress', (req, res) => {
  const pid = String((req.query as Record<string, string>).pid || '')
  if (!pid) { res.status(400).json({ error: 'Missing pid' }); return }
  res.json(progressFor(pid))
})

// ミニマップ用のグリッド集約。**nodes 表には一切触らず nodes_rtree だけ**を読み、要求矩形を
// gw×gh のセルに分けてセルごとの占有件数と重心を返す。
//
// なぜ必要か（2026-08-03 実測 / chr22 最密セル・layer 9・ミニマップの context 矩形）:
//   従来はミニマップも /nodes を叩いて **76,898 行 = JSON 24.7MB** を取り、それを 180×110 の
//   キャンバスに描いていた（3.9 ノード/画素）。物理的に表示できない情報のために転送も描画も
//   払っていたことになる。しかも遅さの主因は R-Tree 探索ではなく **候補行の実体化**で、
//   同じ矩形で「nodes を JOIN して必要列を取る」= 14.47s に対し「rtree だけで集約」= 0.03s
//   （どちらも rtree ページは warm。差は 590MB の nodes から 76,898 行を拾い集めるコスト）。
//   出力も 5.72MB → 285KB、クライアントの Canvas2D 呼び出しも 922,776 → 6,428 になる。
//
// グリッド解像度はキャンバスの画素数に一致させる想定。**1 画素より細かい情報は元々表示できない**
// ので、1 画素未満のノードは形状も回転も失って構わない。逆にセルの件数(c)で密度を濃淡表現できる。
//
// ただし **1 画素より大きく描かれるノードは向き(angle)が見える**。角度は rtree の bbox
// (xCoord±radius の正方形)には入っていないので、そこだけは nodes を引く必要がある。
// 幸い数が少ないので安い。chr22 の context 矩形での実測（≥2px のノード数 / 総数）:
//   主層 4→ctx 1: 70/1,115   6→3: 298/3,060   8→5: 1,203/7,679
//   10→7: 2,671/16,596       12→9: **0**/76,753   ← 最深層では角度は本当に見えない
// そこで `max_x-min_x`（= radius*2、rtree に入っている）で振り分け、大きいものだけ
// xCoord/yCoord/radius/angle を取って返す（`nodes` 配列）。クライアントはセルを塗った上に
// この向き付きロッドを重ねる。
// ※ 大きいノードは cells にも含めたまま（重複して数える）。こうしておけば `nodes` 側が cap で
//   切れても density は欠けず、切れた分は「向きなしのセル」として残る＝消えない。
const GRID_BIG_PX = 2      // これ以上の画素幅なら向きが見える → 個別に描く
const GRID_BIG_CAP = 4000  // 向き付きで返す上限（超えたら残りはセルとして描かれる）
//
// ⚠ maxRows は渡さない/使わない。あれは /pick_layer 経由の**層フォールバックの入力**であり、
//   ミニマップは「メイン層 - 一定オフセット」を必ず描きたいので層を動かされては困る。
//   backend 側の行数打ち切りも R-Tree の走査順で切るだけなので、使うと空間的に偏った絵になる。
//   ここは層を固定したまま**空間的に均一な間引き**をするのが正解。
graphRouter.get('/nodes_grid', (req, res) => {
  const { db, layer, x1, x2, y1, y2 } = req.query as Record<string, string>
  if (!db || layer == null || !x1 || !x2 || !y1 || !y2) {
    res.status(400).json({ error: 'Missing query parameters' }); return
  }
  const L = Number(layer)
  const ax1 = Number(x1), ax2 = Number(x2), ay1 = Number(y1), ay2 = Number(y2)
  // グリッドはキャンバス画素相当。上限は「画素数として現実的な範囲」に留める。
  const gw = Math.max(1, Math.min(1024, Number((req.query as any).gw) || 180))
  const gh = Math.max(1, Math.min(1024, Number((req.query as any).gh) || 110))
  const w = ax2 - ax1, h = ay2 - ay1
  if (!Number.isFinite(L) || !(w > 0) || !(h > 0)) {
    res.status(400).json({ error: 'Invalid layer/rect' }); return
  }
  // ★DB 読み取りは worker へ出す（メインのイベントループを空けておく）。
  //   投入前に切断を検知したら捨て、実行中に切断されたらキャンセル旗で**走行中のクエリごと止める**。
  //   プールが使えない環境では下の従来経路（メインスレッド同期実行）へフォールバックする。
  const gridJob: QueryJob = {
    kind: 'nodes_grid', db, layer: L, x1: ax1, x2: ax2, y1: ay1, y2: ay2, gw, gh,
    sel: (req.query as Record<string, string>).sel || undefined,
  }
  if (poolAvailable()) {
    runOnWorker(gridJob, res, (req.query as Record<string, string>).pid)
      .then(r => sendWorkerReply(res, r))   // worker が直列化＋圧縮済み: main では触らない
      .catch(e => {
        if (e instanceof AbandonedError || res.closed) return   // 見捨てられた: 何も返さない
        console.error('nodes_grid worker failed; falling back:', e)
        try { runNodesGridInline() } catch (e2) { res.status(500).json({ error: String(e2) }) }
      })
    return
  }
  runNodesGridInline()

  function runNodesGridInline() {
  try {
    const d = getDb(db)
    // hap 絞り込みも同じ rtree のマスク補助列(hm0/hm1)で効く。従来ミニマップは sel を渡しておらず
    // **絞り込み中でも絞り込み前の絵**を描いていた（速度以前に表示が食い違っていた）。
    const sel = selOf(d, req)
    const rtree = sel ? sel.rtree : 'nodes_rtree'
    const mw = sel ? maskWhere('r', sel) : { sql: '', params: [] }
    // セル添字は「矩形内へクランプ」する。R-Tree は矩形と**重なる**ものを返すので、
    // 中心が矩形外のノードが入りうる（クランプしないと負や gw 以上の添字が出る）。
    const gx = `MAX(0, MIN(${gw - 1}, CAST((r.min_x + r.max_x) / 2.0 - ? AS REAL) / ? * ${gw}))`
    const gy = `MAX(0, MIN(${gh - 1}, CAST((r.min_y + r.max_y) / 2.0 - ? AS REAL) / ? * ${gh}))`
    const sql =
      `SELECT CAST(${gx} AS INT) AS gx, CAST(${gy} AS INT) AS gy, COUNT(*) AS c,
              AVG((r.min_x + r.max_x) / 2.0) AS x, AVG((r.min_y + r.max_y) / 2.0) AS y,
              AVG(r.max_x - r.min_x) AS w
       FROM ${rtree} r
       WHERE r.min_layer = ? AND r.max_layer = ?
         AND r.max_x >= ? AND r.min_x <= ? AND r.max_y >= ? AND r.min_y <= ?${mw.sql}
       GROUP BY gx, gy`
    // 時間ガードは掛ける（病的な領域で同期ブロックしないため）。行数上限は不要
    // ＝出力はセル数 ≤ gw×gh で構造的に有界。
    const g = guardedAll(d.prepare(sql),
      [ax1, w, ay1, h, L, L, ax1, ax2, ay1, ay2, ...mw.params],
      { timeMs: FETCH_MS, exemptTime: L <= 0 })
    setGuardHeaders(res, g, L, 'nodes_grid')
    // 1 画素より大きく描かれるノードだけ、向き(angle)込みで個別に返す。ここだけ nodes を引く
    // （angle は rtree の bbox には無い）。件数が少ないので安い（上のコメントの実測参照）。
    const bigW = GRID_BIG_PX * (w / gw)
    const big = d.prepare(
      `SELECT n.xCoord AS x, n.yCoord AS y, n.radius AS r, n.angle AS a
       FROM ${rtree} r JOIN nodes n ON n.rowid = r.rowid
       WHERE r.min_layer = ? AND r.max_layer = ?
         AND r.max_x >= ? AND r.min_x <= ? AND r.max_y >= ? AND r.min_y <= ?
         AND (r.max_x - r.min_x) >= ?${mw.sql}
       LIMIT ?`
    ).all(L, L, ax1, ax2, ay1, ay2, bigW, ...mw.params, GRID_BIG_CAP + 1) as any[]
    // world 座標は 0..1 の正規化座標なので 7 桁で 1e-7 の分解能。ミニマップは高々 1024 画素なので
    // 過剰なほど十分で、JSON をそのまま返すより素直に小さくなる（実測 640KB → 300KB 台）。
    const r7 = (v: number) => Math.round(v * 1e7) / 1e7
    res.json({
      gw, gh,
      cells: (g.rows as any[]).map(c => ({
        gx: c.gx, gy: c.gy, c: c.c, x: r7(c.x), y: r7(c.y), w: r7(c.w),
      })),
      nodes: big.slice(0, GRID_BIG_CAP).map(n => ({
        x: r7(n.x), y: r7(n.y), r: r7(n.r), a: Math.round(n.a * 1e4) / 1e4,
      })),
      nodesTruncated: big.length > GRID_BIG_CAP,
    })
  } catch (e) {
    console.error('nodes_grid failed:', e)
    res.status(500).json({ error: String(e) })
  }
  }
})

// グラフ距離フラッド: クリックしたノードから layer L の super-graph 上を有界 BFS（hop 距離）し、
// D 手以内に到達したノード名と手数を返す。エッジ隣接は PK(layer,source,target)/idx_edges_ts
// (layer,target,source) の両索引で両向き probe。K でノード数を頭打ちにして密領域でも応答一定。
// 用途: 「同じレイアウト位置に近いグリフが実際にグラフ連結しているか」の確認（融合 vs 近接）。
// comp_id（別途 node fetch で返す）が同一成分の二値、本 BFS が成分内の距離詳細を与える。
graphRouter.get('/flood', (req, res) => {
  const { db, layer, node } = req.query as Record<string, string>
  if (!db || layer == null || !node) { res.status(400).json({ error: 'Missing db/layer/node' }); return }
  const L = Number(layer)
  const D = Math.max(1, Math.min(50, Number((req.query as any).d) || 10))
  const K = Math.max(1, Math.min(200000, Number((req.query as any).k) || 20000))
  if (!Number.isFinite(L)) { res.status(400).json({ error: 'Invalid layer' }); return }
  try {
    const d = getDb(db)
    const outStmt = d.prepare('SELECT target AS nb FROM edges WHERE layer_index = ? AND source = ?')
    const inStmt = d.prepare('SELECT source AS nb FROM edges WHERE layer_index = ? AND target = ?')
    const dist = new Map<string, number>()
    dist.set(node, 0)
    let frontier: string[] = [node]
    let capped = false
    for (let h = 1; h <= D && frontier.length > 0; h++) {
      const next: string[] = []
      for (const u of frontier) {
        for (const st of [outStmt, inStmt]) {
          for (const r of st.all(L, u) as any[]) {
            const nb = r.nb as string
            if (!dist.has(nb)) {
              dist.set(nb, h); next.push(nb)
              if (dist.size >= K) { capped = true; break }
            }
          }
          if (capped) break
        }
        if (capped) break
      }
      if (capped) break
      frontier = next
    }
    const reached = [...dist.entries()].map(([name, hop]) => ({ name, hop }))
    res.json({ node, layer: L, d: D, k: K, capped, count: reached.length, reached })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

graphRouter.get('/read_alignments', (req, res) => {
  const { db, nodes } = req.query as Record<string, string>
  if (!db || !nodes) { res.status(400).json({ error: 'Missing db or nodes' }); return }
  const nodeList = nodes.split(',').filter(Boolean)
  if (nodeList.length === 0) { res.json({ reads: {}, totals: {} }); return }
  // オンデマンド: 転置索引がある DB は Python ヘルパで実体から取得（node ごとに 1 起動、並列）。
  if (readNodeAvail(getDb(db))) {
    const sample = (req.query as any).sample as string | undefined
    // ★リードは**葉**にしか付かない（索引の鍵が GFA セグメント id）。クラスタ(G…/S…)を
    //   渡されたらここで弾く。ヘルパも自衛するが、無駄なプロセスを起こさないため。
    const isLeaf = (n: string) => /^n\d+$/.test(n)
    const notes: Record<string, string> = {}
    Promise.all(nodeList.map(n => {
      if (!isLeaf(n)) {
        notes[n] = 'leaf-only'
        return Promise.resolve({ reads: { [n]: [] }, totals: { [n]: 0 } })
      }
      const a = ['--node', n, '--max', '5000']
      if (sample) a.push('--sample', sample)
      return readsHelper(db, a).catch(() => ({ reads: {}, totals: {} }))
    })).then(parts => {
      const reads: Record<string, any> = {}, totals: Record<string, number> = {}
      for (const p of parts) {
        if (p?.reads) Object.assign(reads, p.reads)
        if (p?.totals) Object.assign(totals, p.totals)
      }
      res.json({ reads, totals, notes })
    }).catch(e => { console.error('read_alignments ondemand:', e); res.json({ reads: {}, totals: {} }) })
    return
  }
  const placeholders = nodeList.map(() => '?').join(',')
  // endMargin>=0 が指定されたノードは、総数が endsOver を超える場合だけ「ノード端に達するリード」
  // （node_start<=margin OR node_end>=size-margin）だけ返す。巨大ノードのCIGAR全件取得を避ける。
  // totals には各ノードの真の総数を返し、frontend が cov帯/「端のみ」表示を判断できるようにする。
  const endMargin = Number((req.query as any).endMargin)
  const endsOver = Number((req.query as any).endsOver) || 1500
  const useEndOpt = Number.isFinite(endMargin) && endMargin >= 0
  // regStart/regEnd 指定時は、その範囲に重なるリードだけ返す（塩基レベル表示で表示範囲を取得）。
  const regStart = Number((req.query as any).regStart)
  const regEnd = Number((req.query as any).regEnd)
  const useRegion = Number.isFinite(regStart) && Number.isFinite(regEnd) && regEnd >= regStart
  const group = (rows: { node_name: string; [k: string]: unknown }[]) => {
    const result: Record<string, typeof rows> = {}
    for (const r of rows) {
      if (!result[r.node_name]) result[r.node_name] = []
      result[r.node_name].push(r)
    }
    return result
  }
  const d = getDb(db)
  // 新スキーマ: node_id INTEGER + cigar BLOB圧縮。名前→id を解決し、結果は node_name へ戻す。
  if (raHasNodeId(d)) {
    try {
      // 多層 LOD DB では 1 葉が層ごとに複数 rowid を持つ。read_alignments.node_id は葉の
      // maxlayer(最深層)出現 rowid に統一されている(ggb_reads)。MAX(rowid)=その maxlayer 出現なので
      // 名前→id 解決もそれに固定する。層無指定だと複数 rowid が返り、node_name キーの reads/totals が
      // last-write-win で「空結果に本物が上書き」されて 0 件化する不具合を防ぐ。
      const nameRows = d.prepare(
        `SELECT MAX(rowid) AS id, node_name, size FROM nodes WHERE node_name IN (${placeholders}) GROUP BY node_name`
      ).all(...nodeList) as any[]
      if (nameRows.length === 0) { res.json({ reads: {}, totals: {} }); return }
      const RA_COLS = `aln_id, node_id, read_name, node_start, node_end,
                query_start, query_end, query_len, strand, mapq, is_primary, sample_id, cigar`
      const countStmt = d.prepare('SELECT COUNT(*) AS n FROM read_alignments WHERE node_id = ?')
      const allStmt = d.prepare(`SELECT ${RA_COLS} FROM read_alignments WHERE node_id = ?`)
      const endStmt = d.prepare(
        `SELECT ${RA_COLS} FROM read_alignments WHERE node_id = ? AND (node_start <= ? OR node_end >= ?)`)
      const regionStmt = d.prepare(
        `SELECT ${RA_COLS} FROM read_alignments WHERE node_id = ? AND node_start <= ? AND node_end >= ?`)
      // cs:Z（リード塩基）の側テーブルがあれば (node_id, read_name, node_start) で引いて付与する。
      const csStmt = tableCols(d, 'read_cs').size > 0
        ? d.prepare('SELECT cs FROM read_cs WHERE node_id = ? AND read_name = ? AND node_start = ?')
        : null
      const reads: Record<string, any[]> = {}
      const totals: Record<string, number> = {}
      for (const nr of nameRows) {
        const total = (countStmt.get(nr.id) as any).n as number
        totals[nr.node_name] = total
        const rows = useRegion
          ? regionStmt.all(nr.id, regEnd, regStart) as any[]       // 範囲オーバーラップ
          : (useEndOpt && total > endsOver)
          ? endStmt.all(nr.id, endMargin, (nr.size ?? 0) - endMargin) as any[]
          : allStmt.all(nr.id) as any[]
        reads[nr.node_name] = rows.map(r => {
          const { node_id, cigar, ...rest } = r
          const csRow = csStmt ? csStmt.get(nr.id, r.read_name, r.node_start) as any : null
          return { ...rest, node_name: nr.node_name, cigar: decodeCigar(cigar),
                   cs: csRow ? decodeCigar(csRow.cs) : null }
        })
      }
      res.json({ reads, totals })
    } catch (e) {
      console.error('read_alignments (node_id) failed:', e)
      res.json({ reads: {}, totals: {} })
    }
    return
  }
  try {
    const rows = d.prepare(
      `SELECT aln_id, node_name, read_name, node_start, node_end,
              query_start, query_end, query_len,
              strand, mapq, is_primary, sample_id, cigar
       FROM read_alignments WHERE node_name IN (${placeholders})`
    ).all(...nodeList) as any[]
    res.json({ reads: group(rows), totals: {} })
  } catch {
    try {
      // 旧スキーマ（cigarのみ）へのフォールバック
      const rows = getDb(db).prepare(
        `SELECT node_name, read_name, node_start, node_end, strand, cigar
         FROM read_alignments WHERE node_name IN (${placeholders})`
      ).all(...nodeList) as any[]
      res.json({ reads: group(rows), totals: {} })
    } catch {
      try {
        // 最旧スキーマへのフォールバック
        const rows = getDb(db).prepare(
          `SELECT node_name, read_name, node_start, node_end, strand
           FROM read_alignments WHERE node_name IN (${placeholders})`
        ).all(...nodeList) as any[]
        res.json({ reads: group(rows), totals: {} })
      } catch {
        res.json({ reads: {}, totals: {} })
      }
    }
  }
})

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// CIGAR から一致/ミスマッチ/挿入/欠失の塩基数を集計（サイドバーのリード詳細用）。
function cigarStats(cg: string | null): { nmatch: number; nmm: number; nins: number; ndel: number } {
  let m = 0, mm = 0, ins = 0, del = 0
  if (cg) for (const x of cg.matchAll(/(\d+)([=XMIDNSHP])/g)) {
    const L = +x[1], op = x[2]
    if (op === '=' || op === 'M') m += L
    else if (op === 'X') mm += L
    else if (op === 'I') ins += L
    else if (op === 'D') del += L
  }
  return { nmatch: m, nmm: mm, nins: ins, ndel: del }
}

// リード/アラインメント検索: q が数値なら aln_id 完全一致を優先、無ければ read_name 完全一致→前方一致。
// 各 aln_id について全セグメント（経路ノード・座標・CIGAR集計）を query 順で返す。
// read_name 検索は idx_ra_readname（無ければ全走査）に依存。aln_id は idx_ra_aln で高速。
graphRouter.get('/read_search', (req, res) => {
  const { db, q } = req.query as Record<string, string>
  if (!db || !q || !q.trim()) { res.status(400).json({ error: 'Missing db or q' }); return }
  const query = q.trim()
  const limit = Math.max(1, Math.min(100, Number((req.query as any).limit) || 30))
  try {
    const d = getDb(db)
    // オンデマンド: 転置索引がある DB は Python ヘルパで実体から検索・経路復元。
    if (readNodeAvail(d)) {
      readsHelper(db, ['--search', query, '--limit', String(limit)])
        .then(r => res.json(r))
        .catch(e => { console.error('read_search ondemand:', e); res.json({ results: [], schema: 'ondemand' }) })
      return
    }
    if (!raHasNodeId(d)) { res.json({ results: [], schema: 'old' }); return }
    let alnIds: number[] = []
    if (/^\d+$/.test(query)) {
      alnIds = (d.prepare('SELECT DISTINCT aln_id FROM read_alignments WHERE aln_id = ?')
        .all(Number(query)) as any[]).map(r => r.aln_id)
    }
    if (alnIds.length === 0) {
      let rows = d.prepare('SELECT DISTINCT aln_id FROM read_alignments WHERE read_name = ? LIMIT ?')
        .all(query, limit) as any[]
      if (rows.length === 0 && !/[*?[\]]/.test(query)) {
        // 前方一致は GLOB で引く。`LIKE 'q%'` だと idx_ra_read が使われず全走査になる
        // （EQP: `SCAN read_alignments USING INDEX idx_ra_aln`）。SQLite の LIKE 最適化は
        // 大小無視 LIKE に NOCASE 照合の索引を要求するが read_name は BINARY 照合のため。
        // GLOB は大小区別なのでレンジシークになる。node_name 側(/search)と同じ理由・同じ対処。
        rows = d.prepare('SELECT DISTINCT aln_id FROM read_alignments WHERE read_name GLOB ? LIMIT ?')
          .all(query + '*', limit) as any[]
      }
      alnIds = rows.map(r => r.aln_id)
    }
    alnIds = alnIds.slice(0, limit)
    if (alnIds.length === 0) { res.json({ results: [] }); return }
    const segStmt = d.prepare(
      `SELECT node_id, read_name, node_start, node_end, query_start, query_end, query_len,
              strand, mapq, is_primary, sample_id, cigar
       FROM read_alignments WHERE aln_id = ? ORDER BY query_start`)
    const nameStmt = d.prepare('SELECT node_name, size FROM nodes WHERE rowid = ?')
    const results = alnIds.map(aid => {
      const segs = segStmt.all(aid) as any[]
      const segments = segs.map(s => {
        const nn = nameStmt.get(s.node_id) as any
        return {
          node_name: nn?.node_name ?? null, node_size: nn?.size ?? null,
          node_start: s.node_start, node_end: s.node_end,
          query_start: s.query_start, query_end: s.query_end,
          strand: s.strand, mapq: s.mapq, is_primary: s.is_primary,
          ...cigarStats(decodeCigar(s.cigar)),
        }
      })
      const f = segs[0] ?? {}
      return {
        aln_id: aid, read_name: f.read_name ?? null, sample_id: f.sample_id ?? null,
        query_len: f.query_len ?? null, strand: f.strand ?? null,
        n_segments: segments.length, segments,
      }
    })
    res.json({ results })
  } catch (e) {
    console.error('read_search failed:', e)
    res.json({ results: [] })
  }
})

// seed ノードと共通 aln_id を持つノードを集め、リード上の相対位置でレイアウトして返す。
// have に既存ボードのノード名を渡すと、それらを含めて再レイアウトし、未追加の関連ノードを上位 limit 件追加。
graphRouter.get('/expand_node', (req, res) => {
  const { db, node, have, limit } = req.query as Record<string, string>
  if (!db || !node) { res.status(400).json({ error: 'Missing db or node' }); return }
  const N = Math.max(1, Math.min(20, Number(limit) || 4))
  const haveSet = new Set((have ?? '').split(',').filter(Boolean))
  const ALN_CAP = 2000   // seed の aln_id サンプリング上限
  const EDGE = 4         // bp: ノード端到達とみなす許容
  try {
    const d = getDb(db)
    // リード表が無い DB（emitter が出す素の DB は全部そう）ではこの機能は成立しない。
    // 以前は read_alignments を無条件に引いて **500** を返していた。呼び側は
    // `if (!res.ok) return null` なので UI では無反応と区別できず、原因が見えなかった。
    if (!raTableExists(d) && !readNodeAvail(d)) {
      res.json({ total: 0, added: [], columns: [], flipped: [] }); return
    }
    const useId = raHasNodeId(d)
    // 多層 LOD: node_id は葉の maxlayer 出現(=MAX(rowid))に統一。seed 解決もそれに固定。
    const seed = d.prepare('SELECT MAX(rowid) AS id, size FROM nodes WHERE node_name = ?')
      .get(node) as { id: number; size: number } | undefined
    if (!seed) { res.json({ total: 0, added: [], columns: [] }); return }

    // seed のリード(seedAligns)を ranked → その aln_id が通る全ノード(getRows)で列レイアウト。
    // レイアウトは共通。データ源だけ「DB に行がある旧アトラス」と「helper cohort」で差し替える。
    const runLayout = (seedAligns: any[], getRows: (alnIds: number[]) => any[]) => {
      const ranked = seedAligns
        .map(a => ({ ...a, edge: (a.node_start <= EDGE || a.node_end >= seed.size - EDGE) ? 1 : 0 }))
        .sort((a, b) => b.edge - a.edge || (b.mapq ?? 0) - (a.mapq ?? 0))
        .slice(0, ALN_CAP)
      if (ranked.length === 0) { res.json({ total: 0, added: [], columns: [] }); return }
      const seedQStart = new Map<number, number>()
      const seedStrand = new Map<number, string>()
      for (const a of ranked) { seedQStart.set(a.aln_id, a.query_start); seedStrand.set(a.aln_id, a.strand) }
      const alnIds = [...seedQStart.keys()]
      const rows = getRows(alnIds)

      // ノードごとに seed 相対オフセット・共有 aln_id・反転投票(seedと逆向きなら+1)を集計。
      const agg = new Map<string, { offS: number[]; offE: number[]; alns: Set<number>; flipVote: number }>()
      for (const r of rows) {
        const s = seedQStart.get(r.aln_id); if (s == null) continue
        const ss = seedStrand.get(r.aln_id)
        const sign = ss === '-' ? -1 : 1   // seed が逆向きのリードは符号反転で前方フレームへ
        let lo = (r.query_start - s) * sign
        let hi = (r.query_end   - s) * sign
        if (lo > hi) { const t = lo; lo = hi; hi = t }
        let a = agg.get(r.node_name)
        if (!a) { a = { offS: [], offE: [], alns: new Set(), flipVote: 0 }; agg.set(r.node_name, a) }
        a.offS.push(lo); a.offE.push(hi); a.alns.add(r.aln_id)
        if (ss != null) a.flipVote += (r.strand !== ss ? 1 : -1)
      }

      const newCandidates = [...agg.entries()].filter(([nm]) => nm !== node && !haveSet.has(nm))
      const totalRelated = newCandidates.length
      const newTop = newCandidates
        .sort((a, b) => b[1].alns.size - a[1].alns.size)
        .slice(0, N).map(([nm]) => nm)

      const layoutNames = [...new Set([node, ...newTop])]
      const info = layoutNames.map(nm => {
        const a = agg.get(nm)
        return {
          name: nm,
          anchorS: a ? median(a.offS) : null,
          anchorE: a ? median(a.offE) : null,
          alns: a ? a.alns : new Set<number>(),
        }
      })
      const anchored = info.filter(i => i.anchorS != null).sort((x, y) => x.anchorS! - y.anchorS!)
      const unanchored = info.filter(i => i.anchorS == null)

      // 貪欲に列を作る: 直前列と区間が重なり かつ 共起しない(=代替) なら同列の段、それ以外は新列
      type Col = { names: string[]; iEnd: number; alns: Set<number> }
      const cols: Col[] = []
      for (const it of anchored) {
        const cur = cols[cols.length - 1]
        const overlap = !!cur && it.anchorS! < cur.iEnd
        let shared = 0
        if (cur) for (const x of it.alns) if (cur.alns.has(x)) shared++
        const exclusive = !!cur && it.alns.size > 0 && shared / it.alns.size < 0.3
        if (cur && overlap && exclusive) {
          cur.names.push(it.name)
          cur.iEnd = Math.max(cur.iEnd, it.anchorE!)
          for (const x of it.alns) cur.alns.add(x)
        } else {
          cols.push({ names: [it.name], iEnd: it.anchorE!, alns: new Set(it.alns) })
        }
      }
      for (const it of unanchored) cols.push({ names: [it.name], iEnd: 0, alns: new Set() })

      const allNames = cols.flatMap(c => c.names)
      if (allNames.length === 0) { res.json({ total: totalRelated, added: [], columns: [] }); return }
      const nph = allNames.map(() => '?').join(',')
      // ★列の有無は DB による。決め打ちで SELECT すると **機能ごと落ちる**。
      //   実際 `haplotype` は意味が無いので emitter から外したのに、ここだけ残っていて
      //   「no such column: haplotype」で /expand_node が 500 になり、UI では無反応に見えていた。
      //   coverage/cov_hist も古い DB には無い。あるものだけ選ぶ。
      const nCols = tableCols(d, 'nodes')
      const optSel = ['coverage', 'cov_hist', 'haplotype']
        .filter(c => nCols.has(c)).map(c => `, ${c}`).join('')
      const ndRows = d.prepare(
        `SELECT rowid AS id, node_name, is_bubble, size, xCoord, yCoord, angle, radius, color${optSel}
         FROM nodes WHERE node_name IN (${nph})`).all(...allNames) as any[]
      const ndByName = new Map<string, any>()
      for (const r of ndRows) ndByName.set(r.node_name, r.cov_hist ? { ...r, cov_hist: JSON.parse(r.cov_hist) } : r)
      const columns = cols
        .map(c => c.names.map(nm => ndByName.get(nm)).filter(Boolean))
        .filter(col => col.length > 0)
      const flipped = newTop.filter(nm => (agg.get(nm)?.flipVote ?? 0) > 0)
      res.json({ total: totalRelated, added: newTop, columns, flipped })
    }

    if (readNodeAvail(d)) {
      // オンデマンド: helper --expand で seed のリードと全通過ノードを cohort として取得。
      readsHelper(db, ['--expand', node, '--max', String(ALN_CAP)]).then(r => {
        const cohort = (r && r.reads) || {}
        const seedAligns = (cohort[node] || []) as any[]
        runLayout(seedAligns, (alnIds) => {
          const idset = new Set(alnIds)
          return (Object.values(cohort).flat() as any[]).filter(x => idset.has(x.aln_id))
        })
      }).catch(e => { console.error('expand_node ondemand:', e); res.status(500).json({ error: String(e) }) })
      return
    }

    // 旧アトラス(行を DB に持つ形): seed aligns と aln_id→全ノードを DB から。node_id は node_name に解決。
    const seedAligns = d.prepare(
      useId
        ? `SELECT aln_id, node_start, node_end, query_start, strand, mapq
           FROM read_alignments WHERE node_id = ?`
        : `SELECT aln_id, node_start, node_end, query_start, strand, mapq
           FROM read_alignments WHERE node_name = ?`
    ).all(useId ? seed.id : node) as any[]
    runLayout(seedAligns, (alnIds) => {
      const ph = alnIds.map(() => '?').join(',')
      const rows = d.prepare(
        useId
          ? `SELECT aln_id, node_id, query_start, query_end, strand
             FROM read_alignments WHERE aln_id IN (${ph})`
          : `SELECT aln_id, node_name, query_start, query_end, strand
             FROM read_alignments WHERE aln_id IN (${ph})`
      ).all(...alnIds) as any[]
      if (useId) {
        const idSet = [...new Set(rows.map(r => r.node_id))]
        const id2name = new Map<number, string>()
        if (idSet.length) {
          const jph = idSet.map(() => '?').join(',')
          for (const nr of d.prepare(
            `SELECT rowid AS id, node_name FROM nodes WHERE rowid IN (${jph})`
          ).all(...idSet) as any[]) id2name.set(nr.id, nr.node_name)
        }
        for (const r of rows) r.node_name = id2name.get(r.node_id)
      }
      return rows
    })
  } catch (e) {
    console.error('expand_node failed:', e)
    res.status(500).json({ error: String(e) })
  }
})

// 変異トラック: 事前計算した per-node プロファイル(node_var, binw bp ビン)を、要求された
// 範囲 [start,end] と出力ビン数 nbins に集約して返す。概観で全リードを取得せず変異密度を出す用。
type VarProfile = { binw: number; nbins: number;
  cov: number[]; mmf: number[]; mmr: number[]; insf: number[]; insr: number[]; delf: number[]; delr: number[];
  // 任意: cs 由来の置換 alt 塩基カウント（A/C/G/T × +/−鎖）。あれば dominant 塩基を導出。
  af?: number[]; cf?: number[]; gf?: number[]; tf?: number[]; ar?: number[]; cr?: number[]; gr?: number[]; tr?: number[] }
const BASE_KEYS = ['af', 'cf', 'gf', 'tf', 'ar', 'cr', 'gr', 'tr'] as const
const varProfileCache = new Map<string, VarProfile | null>()   // key: dbfile + ':' + node_id
graphRouter.get('/variant_track', (req, res) => {
  const { db, node } = req.query as Record<string, string>
  if (!db || !node) { res.status(400).json({ error: 'Missing db or node' }); return }
  const start = Math.max(0, Number((req.query as any).start) || 0)
  const end = Number((req.query as any).end)
  const nbins = Math.max(1, Math.min(4000, Number((req.query as any).nbins) || 600))
  try {
    const d = getDb(db)
    if (tableCols(d, 'node_var').size === 0) { res.json({ has: false }); return }
    const nr = d.prepare('SELECT rowid AS id FROM nodes WHERE node_name = ? AND layer_index = 1').get(node) as any
    if (!nr) { res.json({ has: false }); return }
    const ckey = db + ':' + nr.id
    let prof = varProfileCache.get(ckey)
    if (prof === undefined) {
      const row = d.prepare('SELECT binw, nbins, data FROM node_var WHERE node_id = ?').get(nr.id) as any
      if (row) {
        const obj = JSON.parse(decodeCigar(row.data) || '{}')
        prof = { binw: row.binw, nbins: row.nbins, ...obj }
      } else prof = null
      if (varProfileCache.size > 40) varProfileCache.clear()   // 単純な上限
      varProfileCache.set(ckey, prof ?? null)
    }
    if (!prof) { res.json({ has: false }); return }
    const e = Number.isFinite(end) ? end : prof.nbins * prof.binw
    const lo = Math.max(0, start), hi = Math.max(lo + 1, e)
    const outW = (hi - lo) / nbins
    const keys = ['cov', 'mmf', 'mmr', 'insf', 'insr', 'delf', 'delr'] as const
    const hasBase = BASE_KEYS.every(k => Array.isArray((prof as any)[k]))
    const aggKeys: string[] = hasBase ? [...keys, ...BASE_KEYS] : [...keys]
    const out: Record<string, number[]> = {}
    for (const k of aggKeys) out[k] = new Array(nbins).fill(0)
    // 各100bp基底ビンを、重なる出力ビンへ重なり割合で配分（拡大=分配 / 縮小=合算 を両対応）。
    const pb0 = Math.max(0, Math.floor(lo / prof.binw))
    const pb1 = Math.min(prof.nbins - 1, Math.floor((hi - 1e-9) / prof.binw))
    for (let pb = pb0; pb <= pb1; pb++) {
      const ostart = Math.max(pb * prof.binw, lo)
      const oend = Math.min((pb + 1) * prof.binw, hi)
      if (oend <= ostart) continue
      const oj0 = Math.max(0, Math.floor((ostart - lo) / outW))
      const oj1 = Math.min(nbins - 1, Math.floor((oend - 1e-9 - lo) / outW))
      for (let oj = oj0; oj <= oj1; oj++) {
        const os = lo + oj * outW
        const ov = Math.min(oend, os + outW) - Math.max(ostart, os)
        if (ov <= 0) continue
        const frac = ov / prof.binw
        for (const k of aggKeys) out[k][oj] += ((prof as any)[k][pb] || 0) * frac
      }
    }
    // cs 由来の塩基カウントがあれば、出力ビンごとの鎖別 dominant alt 塩基を導出（生カウントは返さない）。
    const resp: Record<string, any> = { has: true, start: lo, end: hi, binw: prof.binw, nbins }
    for (const k of keys) resp[k] = out[k]
    if (hasBase) {
      const B = ['A', 'C', 'G', 'T']
      const argmax = (a: number[], b: number[], c: number[], d: number[], j: number) => {
        const v = [a[j], b[j], c[j], d[j]]; let bi = -1, n = 0
        for (let i = 0; i < 4; i++) if (v[i] > n) { n = v[i]; bi = i }
        return bi < 0 ? '' : B[bi]
      }
      const domf = new Array(nbins), domr = new Array(nbins)
      for (let j = 0; j < nbins; j++) {
        domf[j] = argmax(out.af, out.cf, out.gf, out.tf, j)
        domr[j] = argmax(out.ar, out.cr, out.gr, out.tr, j)
      }
      resp.domf = domf; resp.domr = domr
    }
    res.json(resp)
  } catch (e) {
    console.error('variant_track failed:', e)
    res.json({ has: false })
  }
})

graphRouter.get('/node_sequence', (req, res) => {
  const { db, name } = req.query as Record<string, string>
  if (!db || !name) { res.status(400).json({ error: 'Missing db or name' }); return }
  try {
    const d = getDb(db)
    // 1) node_sequences(node_name, sequence) があれば優先。
    try {
      const row = d.prepare('SELECT sequence FROM node_sequences WHERE node_name = ?')
        .get(name) as { sequence: string } | undefined
      if (row && row.sequence != null) { res.json({ sequence: row.sequence }); return }
    } catch { /* node_sequences 表が無い → leaf_seq へフォールバック */ }
    // 2) leaf_seq(leaf_id, seq) フォールバック。葉 node_name 'n{id}' の id で引く(=元 GFA セグメント id)。
    //    ggb_annotate --emit-seq 系 DB は leaf_seq を持ち、AlignmentView の塩基行はこちらで解決できる。
    const m = /^n(\d+)$/.exec(name)
    if (m) {
      try {
        const lr = d.prepare('SELECT seq FROM leaf_seq WHERE leaf_id = ?')
          .get(Number(m[1])) as { seq: string } | undefined
        if (lr && lr.seq != null) { res.json({ sequence: lr.seq }); return }
      } catch { /* leaf_seq も無い */ }
    }
    res.status(404).json({ error: 'not found' })
  } catch {
    res.status(404).json({ error: 'no sequence table' })
  }
})

graphRouter.get('/edges', (req, res) => {
  const { db, layer, x1, x2, y1, y2 } = req.query as Record<string, string>
  if (!db || !layer || !x1 || !x2 || !y1 || !y2) {
    res.status(400).json({ error: 'Missing query parameters' })
    return
  }
  const q = req.query as Record<string, string>
  // /nodes と同じく worker へ。SQL 組み立ては edgeQuery.ts に切り出して共有しているので同一。
  const job: QueryJob = {
    kind: 'edges', db, layer: Number(layer),
    x1: Number(x1), x2: Number(x2), y1: Number(y1), y2: Number(y2),
    mapq: Math.max(0, Number(q.mapq) || 0),
    maxRows: Math.max(0, Number(q.maxRows) || 0),
    sel: q.sel || undefined,
  }
  if (poolAvailable()) {
    runOnWorker(job, res, q.pid)
      .then(r => sendWorkerReply(res, r))
      .catch(e => {
        if (e instanceof AbandonedError || res.closed) return
        console.error('edges worker failed; falling back:', e)
        try { inlineEdges() } catch (e2) { res.status(500).json({ error: String(e2) }) }
      })
    return
  }
  inlineEdges()

  function inlineEdges() {
    try {
      const r = runQueryJob(getDb(db), job, plainCtx)
      res.setHeader('X-AMIPA-Rows', String(r.rows ?? 0))
      if (r.ms != null) res.setHeader('X-AMIPA-Ms', r.ms.toFixed(1))
      if (r.layer != null) res.setHeader('X-AMIPA-Layer', String(r.layer))
      if (r.truncated) {
        res.setHeader('X-AMIPA-Truncated', r.truncated)
        const lv = r.truncated === 'time' ? console.warn : console.log
        lv(`[guard] edges truncated by ${r.truncated}: layer=${r.layer} rows=${r.rows} ` +
           `${(r.ms ?? 0).toFixed(0)}ms`)
      }
      res.json(r.payload)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  }
})
