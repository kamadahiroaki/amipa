import { Router } from 'express'
import type Database from 'better-sqlite3'
import { hapIdxInfo, hapIdxEdgeOk } from '../hapidx'
import { getDb, dbBytes, HUGE_DB_BYTES, readsSchema } from '../db'
import { startPrewarm, prewarmState, PREWARM_ON_OPEN } from '../prewarm'

export const statsRouter = Router()

// 巨大 DB(WG 258GB 等)では MAX/blob 全走査が同期でイベントループを数十秒〜分塞ぎ、サーバー全体が無反応になる。
// dbBytes/HUGE_DB_BYTES(db.ts の単一定義)で巨大判定し、db_meta に保存値があればそれを、無ければ巨大 DB は
// スキャンを飛ばして既定 0(frontend は maxCoverage/maxHb/maxMult の 0/<=1 を graceful に扱う)を返す。
function metaNum(d: Database.Database, key: string): number | null {
  try {
    const r = d.prepare('SELECT value AS v FROM db_meta WHERE key=?').get(key) as { v: any } | undefined
    if (r && r.v != null) { const n = Number(r.v); if (Number.isFinite(n)) return n }
  } catch { /* db_meta 無し */ }
  return null
}

// world 全体 bbox を R-tree の**ルートノード**（全要素の外接矩形を内包）から O(1) で取得する。
// `SELECT MIN(min_x)... FROM nodes_rtree` は 2M 行を全走査して数秒〜十数秒かかり、しかも
// better-sqlite3 は同期実行なのでイベントループを塞いで layer0 の fetch まで待たせる。
// ルートノード blob: [2:4]=セル数(BE u16), offset4 から 1 セル=32B（rowid8B + float32×6 BE:
// minx,maxx,miny,maxy,minL,maxL）。全セルの x,y MBR の和が world bbox。
function worldBboxFromRtree(d: Database.Database):
  { x0: number; x1: number; y0: number; y1: number } | undefined {
  try {
    const row = d.prepare('SELECT data FROM nodes_rtree_node WHERE nodeno = 1').get() as
      { data: Buffer } | undefined
    const buf = row?.data
    if (!Buffer.isBuffer(buf) || buf.length < 4) return undefined
    const nCell = buf.readUInt16BE(2)
    const CELL = 8 + 6 * 4
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let i = 0; i < nCell; i++) {
      const b = 4 + i * CELL
      if (b + 24 > buf.length) break
      const minx = buf.readFloatBE(b + 8),  maxx = buf.readFloatBE(b + 12)
      const miny = buf.readFloatBE(b + 16), maxy = buf.readFloatBE(b + 20)
      if (minx < x0) x0 = minx
      if (maxx > x1) x1 = maxx
      if (miny < y0) y0 = miny
      if (maxy > y1) y1 = maxy
    }
    if (Number.isFinite(x0) && x1 > x0 && y1 > y0) return { x0, x1, y0, y1 }
  } catch { /* rtree shape differs / very old DB */ }
  return undefined
}

// /stats は**軽量クエリのみ**（stats 1 行 + R-tree ルート読み）。nodes 全走査はしない。
// これで DB 選択直後の「Connecting...」が長引かない（全 DB で数十 ms）。maxCoverage は
// coverage モードでしか要らないので別エンドポイントに分離（下記 /max_coverage）。
// プリウォームの進捗。frontend は DB 選択後これをポーリングして「% と速度」を出す。
// 開始は /stats 側（DB を開いた時）で行う。ここは読むだけ。
statsRouter.get('/prewarm', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db query parameter' }); return }
  res.json(prewarmState(db) ?? { db, running: false, finished: false, total: 0, done: 0, rate: 0 })
})

statsRouter.get('/stats', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db query parameter' }); return }
  // DB を開いた＝切り替えた時点でプリウォームを開始する（既に開始/完了済みなら no-op）。
  // cold の実測が「ビューポート 1 枚 1-4 秒」なので、待たせるより読み切った方が速い。
  // 進捗は /prewarm で見せる。AMIPA_PREWARM_ON_OPEN=0 で無効化できる。
  if (PREWARM_ON_OPEN) { try { startPrewarm(db) } catch { /* 温めは失敗しても本処理に影響させない */ } }

  // 現行 LOD-A 仕様の適合レベルを判定して返す（旧 DB を「ハング/遅延」でなく「通知」で扱うため）:
  //   incompatible = stats/3D R-tree が無い or 破損 → 表示不可（frontend で明示通知）
  //   legacy       = stats+R-tree はあるが layer_zoom 無し → 動くが LOD 較正が最適でない（警告バナー）
  //   ok           = layer_zoom あり（現行 emitter 出力）
  let d: ReturnType<typeof getDb>
  try { d = getDb(db) }
  catch (e) { res.json({ spec: 'incompatible', reason: 'DB を開けません: ' + String(e) }); return }

  let rtree3D = false
  try {
    rtree3D = (d.prepare('PRAGMA table_info(nodes_rtree)').all() as { name: string }[])
      .some(c => c.name === 'min_layer')
  } catch { /* rtree 無し */ }

  let row: { maxlayer: number | null; data: string } | undefined
  try {
    row = d.prepare('SELECT maxlayer, data FROM stats ORDER BY id DESC LIMIT 1').get() as typeof row
  } catch (e) {
    res.json({ spec: 'incompatible', reason: 'stats テーブルを読めません（破損 or 旧形式）: ' + String(e) })
    return
  }
  if (!row) { res.json({ spec: 'incompatible', reason: 'stats が空です' }); return }
  if (!rtree3D) { res.json({ spec: 'incompatible', reason: '3D R-tree（nodes_rtree.min_layer）がありません' }); return }

  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  const maxLayer: number = row.maxlayer ?? data?.maxlayer ?? 0
  const hasLayerZoom = Array.isArray(data?.layer_zoom) && data.layer_zoom.length > 0
  const spec: 'ok' | 'legacy' = hasLayerZoom ? 'ok' : 'legacy'

  // world bbox（z_fit 用）は R-tree ルートから O(1)。取れなければ frontend は W=1 でフォールバック。
  let world: { x0: number; x1: number; y0: number; y1: number } | undefined
  try { world = worldBboxFromRtree(d) } catch { /* ignore */ }

  const hapcov = (() => {
    try { d.prepare('SELECT n_hap FROM hapcov_meta LIMIT 1').get(); return true }
    catch { return false }
  })()

  // contig 前向き索引（hap 索引の置換）。有→sample/hap/contig の全リボンを contig 索引で賄える。
  const contigcov = (() => {
    try { d.prepare('SELECT n_contig FROM contigcov_meta LIMIT 1').get(); return true }
    catch { return false }
  })()

  // 参照座標(ref_bp)トラック（ref_meta があれば有効）。有→ノードに参照上の概算 bp 位置ラベルを重畳できる。
  const refpos = (() => {
    try { d.prepare('SELECT ref_key FROM ref_meta LIMIT 1').get(); return true }
    catch { return false }
  })()

  // A-2 表示ソース: hap-breadth 列(node_contig_cov.hb)/通過多重度表(node_contig_mult)の有無。
  // 有→frontend が breadth/multiplicity ヒートマップのトグルを出す。
  const hbAvail = (() => {
    try { d.prepare('SELECT hb FROM node_contig_cov LIMIT 1').get(); return true }
    catch { return false }
  })()
  const multAvail = (() => {
    try { d.prepare('SELECT node_rowid FROM node_hap_mult LIMIT 1').get(); return true }
    catch { return false }
  })()

  // アノテーション(band/gene/region)トラック: node_annot の各列があれば有効(annotate.py 産)。
  // 有→frontend が color-by=バンド/領域トグル・遺伝子密度・ランドマークを出す。
  // ★アノテは サイドカー `an.node_annot`（物理連続で速い）を優先し、無ければ主 DB を見る。
  const annotQual = (() => {
    for (const q of ['an.', '']) {
      try { d.prepare(`SELECT node_rowid FROM ${q}node_annot LIMIT 1`).get(); return q } catch { /* 次 */ }
    }
    return null
  })()
  const has = (col: string) => {
    if (annotQual === null) return false
    try { d.prepare(`SELECT ${col} FROM ${annotQual}node_annot LIMIT 1`).get(); return true }
    catch { return false }
  }
  const bandAvail = has('band_id')
  const geneAvail = has('gene_cnt')
  const regionAvail = has('region_class')

  // hap 絞り込み取得（選択サンプル/hap が通るノード・エッジだけ描画）: サイドカー `<db>.hapidx`
  // (prep/amipa_prep/hap_index.py 産)が ATTACH できていれば有効。有→frontend が絞り込みトグルを出す。
  // mode=bucket は「マスクが上位集合＝backend が blob で厳密判定を追加する」ことを表す(効きは鈍る)。
  // ★rad / rtreeBuiltAt も返す。db_meta.built_at は ④ emit の時刻で、後から
  //   `hap_index --into-db` だけ回しても**変わらない**。実際に radius 修正の再構築後に
  //   「built_at が 05:59:04 のままだがこれで合っているのか」となったので、
  //   R-Tree 側の時刻と rad の有無を別に出して見分けられるようにする。
  //   rad=false は「radius を矩形から導出＝深層で相対 174% 過大」の DB。
  const hapidx = (() => {
    const i = hapIdxInfo(d)
    if (!i) return null
    const hm = (() => {
      try {
        return Object.fromEntries((d.prepare('SELECT key,value FROM hapidx_meta').all() as any[])
          .map(r => [r.key, r.value]))
      } catch { return {} as Record<string, string> }
    })()
    return { nHap: i.nHap, words: i.words, mode: i.mode, edges: hapIdxEdgeOk(d),
             rad: i.hasRad,
             rtreeBuiltAt: hm.rtree_built_at ?? hm.built_at ?? null }
  })()

  // layer_nodes は stats.data 由来のみ尊重（無い旧 DB は GROUP BY 全走査せず frontend の pow フォールバック）。
  res.json({ spec, maxLayer, ...data, world, hapcov, contigcov, refpos, hbAvail, multAvail,
    bandAvail, geneAvail, regionAvail, hapidx })
})

// coverage ヒートマップの最大値。nodes 全走査（数秒・イベントループを塞ぐ）なので、
// coverage モードを使うときだけ遅延取得する。DB は readonly なので結果をキャッシュ。
const maxCovCache = new Map<string, number>()
statsRouter.get('/max_coverage', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db query parameter' }); return }
  if (maxCovCache.has(db)) { res.json({ maxCoverage: maxCovCache.get(db) }); return }
  const d = getDb(db)
  // リード深度トラック(read_cov)がある DB では coverage スケール = read_cov.depth の最大値
  // (read_cov は小さく PK 走査で速い)。
  try {
    const rs = readsSchema(d)   // 'rd'(サイドカー) or 'main'(レガシー) or null
    if (rs && d.prepare(`SELECT 1 FROM ${rs}.sqlite_master WHERE type='table' AND name='read_cov'`).get()) {
      // リード深度は高コピー領域で極端に歪む(chrY 実測 p50=43, max=2681)。素の MAX をスケール上限に
      // すると通常深度が全部 flat(~2%)になり色分けが見えない。→ p99 を既定上限に(外れ値は赤で飽和、
      // 通常域に階調が乗る)。ユーザは「最大深度」で手動上書き可。WG では read_meta 事前計算に移すべき。
      const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${rs}.read_cov WHERE depth>0`).get() as any).n as number
      let rv = 0
      if (n > 0) {
        const off = Math.max(0, Math.floor(0.99 * n) - 1)
        const r = d.prepare(`SELECT depth AS v FROM ${rs}.read_cov WHERE depth>0 ORDER BY depth LIMIT 1 OFFSET ?`)
          .get(off) as { v: number } | undefined
        rv = r?.v ?? 0
      }
      maxCovCache.set(db, rv); res.json({ maxCoverage: rv }); return
    }
  } catch { /* fall through to nodes.coverage */ }
  let v = metaNum(d, 'max_coverage')
  if (v == null) {
    if (dbBytes(db) > HUGE_DB_BYTES) {
      v = 0                                  // 巨大 DB: nodes 全走査を回避(既定スケール)
    } else {
      try {
        const r = d.prepare('SELECT MAX(coverage) AS v FROM nodes WHERE coverage > 0')
          .get() as { v: number | null } | undefined
        v = r?.v ?? 0
      } catch { v = 0 }
    }
  }
  maxCovCache.set(db, v)
  res.json({ maxCoverage: v })
})

// A-2 表示: hap-breadth(hb)ヒートマップ/エッジ太さのスケール上限 = MAX(node_contig_cov.hb)。
// node_contig_cov.hb は索引無しだが行数は node_contig_cov と同数(=coverage 走査と同規模)。キャッシュ。
const maxHbCache = new Map<string, number>()
statsRouter.get('/max_hb', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db query parameter' }); return }
  if (maxHbCache.has(db)) { res.json({ maxHb: maxHbCache.get(db) }); return }
  const d = getDb(db)
  let v = metaNum(d, 'max_hb')
  if (v == null) {
    if (dbBytes(db) > HUGE_DB_BYTES) {
      v = 0                                  // 巨大 DB: node_contig_cov 全走査を回避
    } else {
      try {
        const r = d.prepare('SELECT MAX(hb) AS v FROM node_contig_cov WHERE hb > 0')
          .get() as { v: number | null } | undefined
        v = r?.v ?? 0
      } catch { v = 0 }
    }
  }
  maxHbCache.set(db, v)
  res.json({ maxHb: v })
})

// 通過多重度ヒートマップのスケール上限 = 全 node_contig_mult blob の u16 mult 最大。列 MAX が取れない
// (blob 内)ため一度だけ全 blob を decode 走査してキャッシュ(chrY で数万行=数十ms)。
const maxMultCache = new Map<string, number>()
statsRouter.get('/max_mult', (req, res) => {
  const { db } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db query parameter' }); return }
  if (maxMultCache.has(db)) { res.json({ maxMult: maxMultCache.get(db) }); return }
  const d = getDb(db)
  let v = metaNum(d, 'max_mult')
  if (v == null) {
    if (dbBytes(db) > HUGE_DB_BYTES) {
      v = 0                                  // 巨大 DB: 全 blob を Node メモリに読む .all() を回避(最重量)
    } else {
      v = 0
      try {
        // blob=[u32 count][count×u32 hap_id][count×u8 cn]。cn は u8(node_contig_cov と同型)。
        const rows = d.prepare('SELECT blob FROM node_hap_mult').all() as { blob: Buffer }[]
        for (const { blob } of rows) {
          if (!blob || blob.length < 4) continue
          const cnt = blob.readUInt32LE(0)
          const base = 4 + 4 * cnt
          if (base + cnt <= blob.length) for (let i = 0; i < cnt; i++) { const m = blob.readUInt8(base + i); if (m > v!) v = m }
        }
      } catch { v = 0 }
    }
  }
  maxMultCache.set(db, v)
  res.json({ maxMult: v })
})
