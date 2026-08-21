export interface NodeData {
  id: number
  node_name: string
  is_bubble: number
  size: number
  xCoord: number
  yCoord: number
  angle: number
  radius: number
  color: number
  coverage?: number
  cov_hist?: number[] | null
  layer?: number   // 検索結果のみ付与
  // 参照座標(ref_bp)トラック（EMITTER_REFPOS_SPEC.md）。ref_bp DB のみ付与、それ以外は undefined/null。
  ref_contig_id?: number | null   // ref_contigs.contig_id（表示名は fetchRefContigs で解決）
  ref_bp?: number | null          // 参照コンティグ上の代表累積 bp（super は子孫葉 offset の min）
  ref_bp_end?: number | null      // 範囲上限（super は子孫葉 offset の max）。ラベルは midpoint 推奨
  is_anchor?: number | null       // 1=ラベル吸着候補（参照被覆・単値）
  ref_multi?: number | null       // 1=複数位置（サイクル/複数 contig）。ラベルは概算扱い
  ref_strand?: number | null      // ref がこのノードを辿る向き（1=+n.a / 0=-n.a）。ref 方向矢印用
  comp_id?: number | null         // 連結成分ID（backfill_comp_id.py）。同層内で同 comp_id ⟺ 同一連結成分
  hb?: number | null              // A-2 hap-breadth: このノードを通る distinct haplotype 数（node_contig_cov.hb）
  max_mult?: number | null        // A-2 通過多重度: 配下の最大コピー数（node_contig_mult blob の max、mult>1 のみ）
  kind?: number | null            // ノード種別 0=葉/1=クラスタ/2=flubble(snarl)。無い旧 DB は node_name 接頭辞で判別
  // アノテーション(annotate.py 産 node_attr)。無い DB では undefined。
  band_id?: number | null         // ギムザバンド id（band_dict で名前/gie_stain→色）
  gene_count?: number | null      // このノードに重なる distinct 遺伝子数（粗ズームの密度表示用）
  region_class?: number | null    // 領域クラス id（region_dict で名前へ; CHM13 セントロ等）
}

export interface EdgeData {
  id: number
  source: string
  target: string
  // 端点座標。座標保存スキーマの DB は backend が返す。signed スキーマ(座標非保存)の DB は backend が
  // src_sign/tgt_sign だけ返し、GraphCanvas が取得済みノードから復元して埋める（EDGE 端点復元の client 化, B）。
  start_x: number
  start_y: number
  end_x: number
  end_y: number
  startc_x: number
  startc_y: number
  endc_x: number
  endc_y: number
  src_sign?: number | null   // signed スキーマのみ。+1/-1=ロッド端(±radius·角度), 0=相手中心方向
  tgt_sign?: number | null
  read_support?: number | null
  edge_hb?: number | null   // A-2 hap-breadth: このエッジを通る distinct haplotype 数（edge_contig_cov.hb）
}

export interface Rect {
  x1: number
  x2: number
  y1: number
  y2: number
}

// LOD-A メタ: layer_nodes=層別グリフ数, world=レイアウト bbox, d_world=層別グリフ world 直径。
// camera zoom と表示 layer を分離した予算駆動の層自動選択に使う。旧 DB では未定義になりうる。
export interface StatsResult {
  // 現行 LOD-A 仕様の適合レベル。ok=layer_zoom あり / legacy=旧仕様(pow フォールバックで動作) /
  // incompatible=stats・3D R-tree 無しで表示不可（maxLayer は無い）。
  spec?: 'ok' | 'legacy' | 'incompatible'
  reason?: string          // incompatible の理由（通知表示用）
  maxLayer: number
  maxCoverage?: number
  layer_nodes?: number[]
  // 層別ズーム閾値の相対値 f(L)（f(0)=1 正規化, 狭義単調増）。emitter が実座標の局所密度から算出。
  // viewer は読むだけ。無い旧 DB のみ layer_nodes から冪則で近似（§1）。
  layer_zoom?: number[]
  layer_zoom_budget?: number      // f(L) 較正の目標グリフ数 V_render（新既定 2000）
  layer_zoom_percentile?: number  // f(L) 較正の分位（新既定 50=中央値）
  // 較正に使った窓の形。viewer は自分の canvas アスペクトでこれを補正する（§4）。
  //   'square_side_W_over_s'  : 一辺 W/s の正方形（canvas 非依存・新既定）→ z = √(sw·sh)/W · f(L)
  //   'world_aspect_W_over_s' : (W/s, H/s)=world アスペクト（旧）→ 従来式 z = sw/W · f(L)
  // 欠落 = 旧 DB なので従来式にフォールバックする。
  zoom_window?: 'square_side_W_over_s' | 'world_aspect_W_over_s'
  zoom_method?: 'rtree' | 'grid'
  // 層別の実分位 [p25,p50,p75,p90,p99]（rtree 較正時のみ）。裾の厚さ＝安全弁の fallback 発生率の目安。
  layer_zoom_diag?: (number[] | null)[]
  schedule?: string
  world?: { x0: number; x1: number; y0: number; y1: number }
  d_world?: number[]
  hapcov?: boolean  // hapcov DB（node_hap_cov テーブルあり）
  contigcov?: boolean  // contig 索引 DB（contigcov_meta あり; sample/hap/contig の全リボンを賄う）
  refpos?: boolean  // 参照座標トラック（ref_meta あり; ノードに参照上の概算 bp 位置ラベルを出せる）
  hbAvail?: boolean   // A-2: node_contig_cov.hb 列あり（breadth ヒートマップ/エッジ太さを出せる）
  multAvail?: boolean // A-2: node_contig_mult 表あり（通過多重度ヒートマップを出せる）
  bandAvail?: boolean   // アノテ: node_attr.band_id あり（color-by バンド）
  regionAvail?: boolean // アノテ: node_attr.region_class あり（color-by 領域）
  geneAvail?: boolean   // アノテ: node_attr.gene_count あり（遺伝子密度）
  // hap 絞り込み取得（サイドカー `<db>.hapidx` あり）。有→「選択群だけ描画」トグルを出せる。
  // mode='bucket' は H が大きくマスクが上位集合＝backend が blob で厳密判定を足す（効きは鈍る）。
  hapidx?: { nHap: number; words: number; mode: 'exact' | 'bucket'; edges: boolean } | null
}
export async function fetchStats(dbFile: string): Promise<StatsResult> {
  const res = await fetch(`/api/stats?db=${encodeURIComponent(dbFile)}`)
  if (!res.ok) throw new Error('Failed to fetch stats')
  return res.json()
}

// プリウォーム（DB ファイルの順読みでページキャッシュに載せる）の進捗。
// cold のビューポート取得は 1 枚 1-4 秒だが、253GB を順読みし切れば 9ms 台に落ちる（実測 98x）。
// 開始は backend の /stats 側（DB を開いた時）で自動。ここは進捗を見るだけ。
export type PrewarmInfo = {
  db: string; total: number; done: number; rate: number
  running: boolean; finished: boolean; error?: string
}
export async function fetchPrewarm(dbFile: string): Promise<PrewarmInfo | null> {
  try {
    const res = await fetch(`/api/prewarm?db=${encodeURIComponent(dbFile)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

// coverage ヒートマップの最大値（nodes 全走査で重いので、coverage モードを使うときだけ遅延取得）。
export async function fetchMaxCoverage(dbFile: string): Promise<number> {
  const res = await fetch(`/api/max_coverage?db=${encodeURIComponent(dbFile)}`)
  if (!res.ok) return 0
  const j = await res.json() as { maxCoverage?: number }
  return j.maxCoverage ?? 0
}

// A-2 breadth(hap-breadth)ヒートマップ/エッジ太さのスケール上限（breadth モード時のみ遅延取得）。
export async function fetchMaxHb(dbFile: string): Promise<number> {
  const res = await fetch(`/api/max_hb?db=${encodeURIComponent(dbFile)}`)
  if (!res.ok) return 0
  const j = await res.json() as { maxHb?: number }
  return j.maxHb ?? 0
}

// A-2 通過多重度ヒートマップのスケール上限（multiplicity モード時のみ遅延取得）。
export async function fetchMaxMult(dbFile: string): Promise<number> {
  const res = await fetch(`/api/max_mult?db=${encodeURIComponent(dbFile)}`)
  if (!res.ok) return 0
  const j = await res.json() as { maxMult?: number }
  return j.maxMult ?? 0
}

// A-2 CNV: 選択ユニット(サンプル/ハプロタイプ)ごとの per-node コピー数。units=各ユニットの contig レンジ [lo,hi]
// (順序=色の順序と対応)。返り値 nodes[].cns は units 順の cn(0=非通過)。node_hap_mult 無い DB は available=false。
export interface CnvNode { id: number; name: string; x: number; y: number; cns: number[] }
export async function fetchCnv(
  dbFile: string, layer: number, units: [number, number][],
  bbox?: { x1: number; y1: number; x2: number; y2: number }
): Promise<{ nodes: CnvNode[]; available: boolean }> {
  if (units.length === 0) return { nodes: [], available: true }
  const p = new URLSearchParams({
    db: dbFile, layer: String(layer),
    units: units.map(([lo, hi]) => `${lo}:${hi}`).join(','),
  })
  if (bbox) {
    p.set('x1', String(bbox.x1)); p.set('y1', String(bbox.y1))
    p.set('x2', String(bbox.x2)); p.set('y2', String(bbox.y2))
  }
  const res = await fetch(`/api/cnv?${p}`)
  if (!res.ok) return { nodes: [], available: false }
  return res.json()
}

// 葉(base 節点)の塩基配列。node_name 'n<id>' の葉のみ持つ。既定は先頭 100kb まで(truncated)、full で全長。
// leaf_seq 表の無い DB(--emit-seq 未指定)は available=false。
export interface LeafSeq {
  available: boolean; name: string; leaf?: boolean; leaf_id?: number
  len?: number; seq: string | null; truncated?: boolean
}
export async function fetchLeafSeq(dbFile: string, name: string, full = false): Promise<LeafSeq> {
  const p = new URLSearchParams({ db: dbFile, name })
  if (full) p.set('full', '1')
  const res = await fetch(`/api/leaf_seq?${p}`)
  if (!res.ok) return { available: false, name, seq: null }
  return res.json()
}

// 上部バー用の版情報。viewer=git rev、db=ビルド由来(built_at/emitter_rev/mtime)+機能フラグ。
export interface VersionInfo {
  viewer: string
  // 配信モード。readonly=true の配信では DB を書き換える経路（ノード編集の保存）が
  // サーバ側で塞がれている。画面側はこれを見て Save を無効表示にする。
  readonly?: boolean
  version?: string
  commit?: string | null
  db?: { name: string; built_at: string | null; emitter_rev: string | null; mtime: string | null
    // rtree_built_at: R-Tree(高速経路が読む実体)を作った時刻。built_at(=④ emit の時刻)とは別。
    // rad=false は radius を矩形から導出する古い R-Tree（深層で相対 174% 過大＝表示がずれる）。
    rtree_built_at?: string | null; rad?: boolean
         features: { seq: boolean; inv: boolean; mult: boolean; contigcov: boolean } }
}
export async function fetchVersion(dbFile?: string): Promise<VersionInfo> {
  const p = new URLSearchParams()
  if (dbFile) p.set('db', dbFile)
  const res = await fetch(`/api/version?${p}`)
  if (!res.ok) return { viewer: '?' }
  return res.json()
}

// 配列表示モード: viewport 内の小さい葉(size<=maxsize bp)の塩基。ノード内描画用。
export interface LeafBase { name: string; base: string }
export async function fetchLeafBases(
  dbFile: string, layer: number, maxsize: number,
  bbox?: { x1: number; y1: number; x2: number; y2: number }
): Promise<{ bases: LeafBase[]; available: boolean; capped?: boolean }> {
  const p = new URLSearchParams({ db: dbFile, layer: String(layer), maxsize: String(maxsize) })
  if (bbox) { p.set('x1', String(bbox.x1)); p.set('y1', String(bbox.y1)); p.set('x2', String(bbox.x2)); p.set('y2', String(bbox.y2)) }
  const res = await fetch(`/api/leaf_bases?${p}`)
  if (!res.ok) return { bases: [], available: false }
  return res.json()
}

// 指定 layer・ビューポート矩形内のグリフ数を R-tree で厳密カウント（予算 V_max の hard cap 用）。
export async function fetchNodeCount(dbFile: string, layer: number, bbox: Rect): Promise<number> {
  const p = new URLSearchParams({
    db: dbFile, layer: String(layer),
    x1: String(bbox.x1), x2: String(bbox.x2), y1: String(bbox.y1), y2: String(bbox.y2),
  })
  const res = await fetch(`/api/node_count?${p}`)
  if (!res.ok) return 0
  const j = await res.json() as { n?: number }
  return j.n ?? 0
}

// 複数 layer のグリフ数を 1 往復で厳密カウント（層自動選択に使う）。layer→count のマップを返す。
export async function fetchNodeCounts(dbFile: string, layers: number[], bbox: Rect): Promise<Record<number, number>> {
  if (layers.length === 0) return {}
  const p = new URLSearchParams({
    db: dbFile, layers: layers.join(','),
    x1: String(bbox.x1), x2: String(bbox.x2), y1: String(bbox.y1), y2: String(bbox.y2),
  })
  const res = await fetch(`/api/node_counts?${p}`)
  if (!res.ok) return {}
  const j = await res.json() as { counts?: Record<number, number> }
  return j.counts ?? {}
}

// nx: 現在必要な annotation 群を "hb,band,region,gene" で指定（D2）。空なら backend は JOIN なしの高速経路。
// 取得の打ち切り通知（backend の X-AMIPA-* ヘッダ）。本文の形は変えない契約なので、
// ヘッダだけをここで拾って観測者へ渡す。詳細は backend/src/fetchGuard.ts。
export interface FetchGuardInfo {
  what: 'nodes' | 'edges' | 'nodes_grid'
  rows: number
  ms: number
  layer: number
  /** 'rows'=UX上限で打ち切り / 'time'=時間ガードで打ち切り / 'cancel'=走行中に中断された / null=完走
   *  ★'cancel' は backend が **途中まで読んだ行を status 200 で返した**ことを意味する。
   *    以前ここで 'cancel' を null に潰していたため、frontend は部分応答を完全な応答として
   *    タイルに確定させ、その領域が二度と取得されず白いままになっていた。 */
  truncated: 'rows' | 'time' | 'cancel' | null
}
let guardObserver: ((i: FetchGuardInfo) => void) | null = null
export function setFetchGuardObserver(f: ((i: FetchGuardInfo) => void) | null) { guardObserver = f }
/** 打ち切りを **呼び出し側** にも返すための受け皿。fetchNodes/fetchEdges の最後の引数に渡す。 */
export type GuardSink = { truncated: 'rows' | 'time' | 'cancel' | null }
function reportGuard(what: FetchGuardInfo['what'], res: Response, sink?: GuardSink) {
  const tt = res.headers.get('X-AMIPA-Truncated')
  if (sink) sink.truncated = tt === 'rows' || tt === 'time' || tt === 'cancel' ? tt : null
  if (!guardObserver) return
  const t = res.headers.get('X-AMIPA-Truncated')
  guardObserver({
    what,
    rows: Number(res.headers.get('X-AMIPA-Rows') ?? 0),
    ms: Number(res.headers.get('X-AMIPA-Ms') ?? 0),
    layer: Number(res.headers.get('X-AMIPA-Layer') ?? -1),
    truncated: t === 'rows' || t === 'time' || t === 'cancel' ? t : null,
  })
}

// 表示層の決定（LOD 安全弁）。`L = min(L_zoom, L_safe)` を backend が返す。
// layer には **viewer が zoom だけから決めた層**（手動オフセット込み）を渡す。密すぎて出せない場合だけ
// 上位層へ clamp された値が返る（下げる方向にしか働かない＝戻り先が一意）。
export interface PickLayerResult {
  layer: number
  requested: number
  fallback: boolean
  counts: Record<string, number>
  reason?: string
  hint?: string
}
export async function fetchPickLayer(
  dbFile: string, layer: number, bbox: Rect, maxRows: number, sel = '',
): Promise<PickLayerResult | null> {
  const p = new URLSearchParams({
    db: dbFile, layer: String(layer), maxRows: String(maxRows),
    x1: String(bbox.x1), x2: String(bbox.x2), y1: String(bbox.y1), y2: String(bbox.y2),
  })
  if (sel) p.set('sel', sel)
  try {
    const res = await fetch(`/api/pick_layer?${p}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

// sel: hap 絞り込み。選択群の contig_id レンジ列（"0-23,24-33"）。空なら絞り込みなし。
// backend は `<db>.hapidx` サイドカーがあればマスクで絞り、無ければ無視する（graceful）。
// signal: パンで用済みになった取得を中断する（GraphCanvas が AbortController を持つ）。
// ⚠ 編集の DB 反映(saveEdits)や session 保存には**絶対に付けない**。中断されては困る。
export async function fetchNodes(layer: number, bbox: Rect, dbFile: string, mapq = 0, nx = '',
                                 sel = '', maxRows = 0,
                                 signal?: AbortSignal, pid?: string,
                                 guard?: GuardSink): Promise<NodeData[]> {
  const p = new URLSearchParams({
    layer: String(layer),
    x1: String(bbox.x1), x2: String(bbox.x2),
    y1: String(bbox.y1), y2: String(bbox.y2),
    db: dbFile,
  })
  if (mapq > 0) p.set('mapq', String(mapq))
  if (nx) p.set('nx', nx)
  if (sel) p.set('sel', sel)
  if (maxRows > 0) p.set('maxRows', String(maxRows))
  if (pid) p.set('pid', pid)
  const res = await fetch(`/api/nodes?${p}`, { signal })
  if (!res.ok) throw new Error('Failed to fetch nodes')
  reportGuard('nodes', res, guard)
  return res.json()
}

// ミニマップ用のグリッド集約。nodes 表を触らず nodes_rtree だけを読み、要求矩形を gw×gh の
// セルに畳んだ占有情報を返す（backend /nodes_grid）。層は呼び出し側が指定したものが必ず使われる
// ＝ maxRows のような層フォールバックは起きない。詳細は backend 側のコメント。
export interface GridCell {
  gx: number; gy: number   // セル添字（0..gw-1 / 0..gh-1）
  c: number                // セル内のノード数（密度の濃淡に使う）
  x: number; y: number     // セル内ノードの重心（world 座標。セル中心より見た目が正確）
  w: number                // セル内ノードの平均幅（world）。1 画素超のノードを大きく描く用
}
// 1 画素より大きく描かれるノード。angle は rtree の bbox に無いので backend が nodes を引いて
// 返す（件数が少ないので安い）。セルの上に向き付きロッドとして重ねて描く。
export interface GridBigNode { x: number; y: number; r: number; a: number }
export interface NodeGrid {
  gw: number; gh: number
  cells: GridCell[]
  nodes?: GridBigNode[]      // 向きが見えるサイズのノード
  nodesTruncated?: boolean   // cap 超過（残りはセルとして描かれる＝消えはしない）
}

// 取得の進捗（backend /api/fetch_progress）。pid は取得ごとにクライアントが発行するランダム ID。
// total=0 は「分母不明」（想定件数が数え切れる上限を超えた）。その場合は % ではなく行数だけ出す。
export interface FetchProgress {
  state: 'queued' | 'running' | 'unknown'
  rows: number
  total: number
  phase: number
}
export function newPid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}
export async function fetchProgress(pid: string): Promise<FetchProgress | null> {
  try {
    const res = await fetch(`/api/fetch_progress?pid=${encodeURIComponent(pid)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

export async function fetchNodesGrid(layer: number, bbox: Rect, dbFile: string,
                                     gw: number, gh: number, sel = '',
                                     signal?: AbortSignal, pid?: string,
                                     guard?: GuardSink): Promise<NodeGrid> {
  const p = new URLSearchParams({
    layer: String(layer),
    x1: String(bbox.x1), x2: String(bbox.x2),
    y1: String(bbox.y1), y2: String(bbox.y2),
    db: dbFile, gw: String(gw), gh: String(gh),
  })
  if (sel) p.set('sel', sel)
  const res = await fetch(`/api/nodes_grid?${p}`, { signal })
  if (!res.ok) throw new Error('Failed to fetch node grid')
  reportGuard('nodes_grid', res, guard)
  return res.json()
}

export async function searchNodes(name: string, dbFile: string): Promise<NodeData[]> {
  const p = new URLSearchParams({ name, db: dbFile })
  const res = await fetch(`/api/search?${p}`)
  if (!res.ok) throw new Error('Failed to search nodes')
  return res.json()
}

// 経路ノードを完全名で一括取得（リード経路を view へ追加する用）。
export async function fetchNodesByName(dbFile: string, names: string[]): Promise<NodeData[]> {
  const uniq = [...new Set(names.filter(Boolean))]
  if (!dbFile || uniq.length === 0) return []
  const p = new URLSearchParams({ db: dbFile, names: uniq.join(',') })
  const res = await fetch(`/api/nodes_by_name?${p}`)
  if (!res.ok) return []
  return res.json()
}

export interface CtgPathNode {
  id: number
  node_name: string
  xCoord: number
  yCoord: number
  angle: number
  radius: number
}

export interface CtgPathStep {
  from_id: number
  to_id: number
  from_x: number
  from_y: number
  from_cx: number
  from_cy: number
  to_x: number
  to_y: number
  to_cx: number
  to_cy: number
}

export interface CtgPath {
  ctg_name: string
  haplotype: number
  total_len: number
  nodes: CtgPathNode[]
  steps: CtgPathStep[]
}

export interface UtgCtgLink {
  ctg_name: string
  haplotype: number
  shared_reads: number
}

export async function fetchCtgPath(dbFile: string, ctgName: string): Promise<CtgPath | null> {
  const p = new URLSearchParams({ db: dbFile, name: ctgName })
  const res = await fetch(`/api/ctg_path?${p}`)
  if (!res.ok) return null
  return res.json()
}

// ── 参照座標(ref_bp)トラック ──
export interface RefContig {
  contig_id: number
  ref_key: string
  name: string        // 表示名（例 chrY）
  length_bp: number   // 参照コンティグ長
}
export interface RefContigsResp { ref_key: string | null; contigs: RefContig[] }
export async function fetchRefContigs(dbFile: string): Promise<RefContigsResp> {
  const p = new URLSearchParams({ db: dbFile })
  const res = await fetch(`/api/ref_contigs?${p}`)
  if (!res.ok) return { ref_key: null, contigs: [] }
  return res.json()
}

// ── アノテーション(band/gene/region)辞書。起動時に1回取得し名前/色へ解決 ──
export interface BandDictEntry { band_id: number; contig_id: number; name: string; gie_stain: string }
export interface RegionDictEntry { region_id: number; name: string; ref_key: string; cx?: number | null; cy?: number | null; layer?: number | null }
export interface TrackDictEntry { track_id: number; kind: string; name: string; ref_key: string; source: string }
export interface AnnotDicts {
  bands: BandDictEntry[]; regions: RegionDictEntry[]; tracks: TrackDictEntry[]; maxGeneCount: number
}
export async function fetchAnnotDicts(dbFile: string): Promise<AnnotDicts> {
  const p = new URLSearchParams({ db: dbFile })
  const res = await fetch(`/api/annot_dicts?${p}`)
  if (!res.ok) return { bands: [], regions: [], tracks: [], maxGeneCount: 0 }
  return res.json()
}
// 選択ノードの遺伝子特徴(node_feature JOIN feature_dict/track_dict)。サイドバー詳細用。
export interface NodeFeature {
  feature_id: number; track_id: number; seg_start: number; seg_end: number
  exonic: number; name: string; attrs: string; kind: string
}
export async function fetchNodeFeatures(dbFile: string, node: string): Promise<NodeFeature[]> {
  const p = new URLSearchParams({ db: dbFile, node })
  const res = await fetch(`/api/node_features?${p}`)
  if (!res.ok) return []
  return (await res.json()).features ?? []
}
// 遺伝子トラックの特徴一覧(参照座標付き)。graph 上の遺伝子名ラベル(ref_bp 吸着)用に起動時1回取得。
export interface GeneFeature { name: string; start: number; end: number; strand: string; gtype?: string; chrom?: string; cx?: number | null; cy?: number | null; layer?: number | null }
export async function fetchGeneFeatures(dbFile: string): Promise<GeneFeature[]> {
  const p = new URLSearchParams({ db: dbFile })
  const res = await fetch(`/api/gene_features?${p}`)
  if (!res.ok) return []
  return (await res.json()).genes ?? []
}
// 選択遺伝子の exon 区間(番号付き, ref 座標)。exon/intron 塗り分け・ジャンクション判定用。
export interface GeneExon { exon_no: number; start: number; end: number }
export async function fetchGeneExons(dbFile: string, gene: string): Promise<GeneExon[]> {
  const p = new URLSearchParams({ db: dbFile, gene })
  const res = await fetch(`/api/gene_exons?${p}`)
  if (!res.ok) return []
  return (await res.json()).exons ?? []
}

// A1 go-to-position: 参照コンティグ contig_id 上の bp 位置を「含む」最深ノード（無ければ最寄り）を返す。
// 返り値は navigateTo / サイドバー表示に足る NodeData（ref 列付き）。
export async function fetchGoto(dbFile: string, contigId: number, bp: number): Promise<NodeData | null> {
  const p = new URLSearchParams({ db: dbFile, contig: String(contigId), bp: String(Math.round(bp)) })
  const res = await fetch(`/api/goto?${p}`)
  if (!res.ok) return null
  const j = await res.json()
  return (j && j.node) ? j.node as NodeData : null
}

// ── パスリボン（サンプル/ハプロ/コンティグの通過経路を線で重畳） ──
export type RibbonLevel = 'sample' | 'haplotype' | 'contig'

export interface PathGroup {
  key: string          // sample / haplotype / contig 名（level により）
  label: string
  n_contigs: number    // この群に畳まれた contig 数
  total_cov: number    // layer0 被覆塩基の合計（並べ替え用）
  gids: number[]       // 含まれる contig 群 id（/api/ribbon に渡す）
}

// ノード本体を端→端で貫くための幾何 (a=angle, r=半長) と被覆率 frac。id=node rowid（追従用）。
export interface RibbonNode { id: number; name: string; x: number; y: number; a: number; r: number; frac: number; inv?: boolean; invDir?: number }
// 実エッジ（start→end の直線）。su/tv=source/target の rowid（追従用）。
export interface RibbonEdge { su: number; tv: number; sx: number; sy: number; ex: number; ey: number; inv?: boolean }
export interface RibbonResp { nodes: RibbonNode[]; edges: RibbonEdge[] }

export async function fetchPathGroups(dbFile: string, level: RibbonLevel): Promise<PathGroup[]> {
  const p = new URLSearchParams({ db: dbFile, level })
  const res = await fetch(`/api/path_groups?${p}`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchRibbon(
  dbFile: string, layer: number, gids: number[], theta: number,
  bbox?: { x1: number; y1: number; x2: number; y2: number }
): Promise<RibbonResp> {
  if (gids.length === 0) return { nodes: [], edges: [] }
  const p = new URLSearchParams({
    db: dbFile, layer: String(layer), groups: gids.join(','), theta: String(theta),
  })
  if (bbox) {
    p.set('x1', String(bbox.x1)); p.set('y1', String(bbox.y1))
    p.set('x2', String(bbox.x2)); p.set('y2', String(bbox.y2))
  }
  const res = await fetch(`/api/ribbon?${p}`)
  if (!res.ok) return { nodes: [], edges: [] }
  return res.json()
}

// ノード編集（移動/回転）1ジェスチャの剛体変換。点 p → (cos*px - sin*py + tx, sin*px + cos*py + ty)、angle += dAngle。
// names = 選択したノード名（ルート）。backend が parent_name で子孫展開して全層 nodes/edges/R-tree を更新。
export interface EditGesture { names: string[]; cos: number; sin: number; tx: number; ty: number; dAngle: number }

export async function saveEdits(
  dbFile: string, gestures: EditGesture[]
): Promise<{ ok: boolean; nodes?: number; error?: string }> {
  const res = await fetch('/api/save_edits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ db: dbFile, gestures }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: j.error || `HTTP ${res.status}` }
  return j
}

export interface ReadAlignEntry {
  node_name: string
  read_name: string
  node_start: number
  node_end: number
  strand: string
  cigar?: string | null
  cs?: string | null   // per-node cs:Z（リード塩基差分。置換 *ab の alt 塩基など）。subsample のみ
  // Phase 1 fields (new schema)
  aln_id?: number | null
  query_start?: number | null
  query_end?: number | null
  query_len?: number | null
  mapq?: number | null
  is_primary?: number | null
  sample_id?: string | null
}

export interface ReadAlignResult {
  reads: Record<string, ReadAlignEntry[]>
  totals: Record<string, number>   // ノードごとの真の総リード数（端のみ取得時に総数が分かる）
}

// endMargin を渡すと、総数が多いノードは「ノード端に達するリード」だけ取得（巨大ノード対策）。
// region を渡すと、その範囲に重なるリードだけ取得（塩基レベルで表示範囲を取得）。
export async function fetchReadAlignments(
  dbFile: string, nodeNames: string[], endMargin?: number,
  region?: { start: number; end: number }
): Promise<ReadAlignResult> {
  if (nodeNames.length === 0) return { reads: {}, totals: {} }
  const p = new URLSearchParams({ db: dbFile, nodes: nodeNames.join(',') })
  if (endMargin != null && endMargin >= 0) p.set('endMargin', String(endMargin))
  if (region) { p.set('regStart', String(Math.floor(region.start))); p.set('regEnd', String(Math.ceil(region.end))) }
  const res = await fetch(`/api/read_alignments?${p}`)
  if (!res.ok) return { reads: {}, totals: {} }
  const j = await res.json()
  // 新形式 {reads, totals}。旧backendのフラット形式にも一応対応。
  if (j && typeof j === 'object' && 'reads' in j) return j as ReadAlignResult
  return { reads: (j ?? {}) as Record<string, ReadAlignEntry[]>, totals: {} }
}

// リード/アラインメント検索結果。1 aln_id = 1 アライメント、segments = 通過ノードのセグメント。
export interface ReadSegment {
  node_name: string | null; node_size: number | null
  node_start: number; node_end: number
  query_start: number; query_end: number
  strand: string; mapq: number | null; is_primary: number | null
  nmatch: number; nmm: number; nins: number; ndel: number
}
export interface ReadAlignment {
  aln_id: number; read_name: string | null; sample_id: string | null
  query_len: number | null; strand: string | null
  n_segments: number; segments: ReadSegment[]
}
// read_name または aln_id でアライメントを検索（aln_id は高速、read_name は idx_ra_readname 依存）。
export async function searchReads(dbFile: string, q: string): Promise<ReadAlignment[]> {
  if (!dbFile || !q.trim()) return []
  const p = new URLSearchParams({ db: dbFile, q: q.trim() })
  const res = await fetch(`/api/read_search?${p}`)
  if (!res.ok) return []
  const j = await res.json()
  return (j?.results ?? []) as ReadAlignment[]
}

export interface ExpandResult {
  total: number         // 未追加の関連ノード総数
  added: string[]       // 今回追加したノード名
  columns: NodeData[][] // サブレイアウト（seed+新規）の列×段
  flipped: string[]     // 反転表示すべき追加ノード名（seedと逆向き優勢）
}

export async function fetchExpandNode(
  dbFile: string, nodeName: string, have: string[], limit = 4
): Promise<ExpandResult | null> {
  const p = new URLSearchParams({ db: dbFile, node: nodeName, have: have.join(','), limit: String(limit) })
  const res = await fetch(`/api/expand_node?${p}`)
  if (!res.ok) return null
  return res.json()
}

export async function saveSession(state: unknown): Promise<string | null> {
  const res = await fetch('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!res.ok) return null
  const d = await res.json() as { id?: string }
  return d.id ?? null
}

export async function loadSession(id: string): Promise<any | null> {
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`)
  if (!res.ok) return null
  return res.json()
}

export interface VariantTrack {
  has: boolean
  start: number; end: number; binw: number; nbins: number
  cov: number[]; mmf: number[]; mmr: number[]; insf: number[]; insr: number[]; delf: number[]; delr: number[]
  // 詳細ズームでのみ算出（cs:Z 由来の置換 alt 塩基）。ビン×鎖の最頻 alt 塩基('' = なし)。
  // 概観の事前計算(/variant_track)には無い（node_var は塩基別カウントを持たない）。
  domf?: string[]; domr?: string[]
}
// 事前計算の変異プロファイルを、表示範囲 [start,end] と出力ビン数 nbins に集約して取得。
export async function fetchVariantTrack(
  dbFile: string, node: string, start: number, end: number, nbins: number
): Promise<VariantTrack | null> {
  const p = new URLSearchParams({ db: dbFile, node, start: String(Math.floor(start)),
    end: String(Math.ceil(end)), nbins: String(Math.round(nbins)) })
  const res = await fetch(`/api/variant_track?${p}`)
  if (!res.ok) return null
  const j = await res.json()
  return j && j.has ? j as VariantTrack : null
}

export async function fetchNodeSequence(dbFile: string, nodeName: string): Promise<string | null> {
  const p = new URLSearchParams({ db: dbFile, name: nodeName })
  const res = await fetch(`/api/node_sequence?${p}`)
  if (!res.ok) return null
  const data = await res.json() as { sequence?: string }
  return data.sequence ?? null
}

// グラフ距離フラッド: クリックしたノードから layer 上を有界 BFS（hop）した到達ノードと手数。
// 「レイアウト上近いだけか実際にグラフ連結か（融合 vs 近接）」の確認用。comp_id が成分の二値、
// これが成分内の距離詳細を与える。d=最大手数, k=ノード数上限（密領域の応答を一定化）。
export interface FloodReach { name: string; hop: number }
export interface FloodResp { node: string; layer: number; d: number; k: number; capped: boolean; count: number; reached: FloodReach[] }
export async function fetchFlood(
  dbFile: string, layer: number, node: string, d = 10, k = 20000
): Promise<FloodResp | null> {
  const p = new URLSearchParams({ db: dbFile, layer: String(layer), node, d: String(d), k: String(k) })
  const res = await fetch(`/api/flood?${p}`)
  if (!res.ok) return null
  return res.json()
}

export async function fetchEdges(layer: number, bbox: Rect, dbFile: string, mapq = 0,
                                 sel = '', maxRows = 0,
                                 signal?: AbortSignal, pid?: string,
                                 guard?: GuardSink): Promise<EdgeData[]> {
  const p = new URLSearchParams({
    layer: String(layer),
    x1: String(bbox.x1), x2: String(bbox.x2),
    y1: String(bbox.y1), y2: String(bbox.y2),
    db: dbFile,
  })
  if (mapq > 0) p.set('mapq', String(mapq))
  if (sel) p.set('sel', sel)
  if (maxRows > 0) p.set('maxRows', String(maxRows))
  if (pid) p.set('pid', pid)
  const res = await fetch(`/api/edges?${p}`, { signal })
  if (!res.ok) throw new Error('Failed to fetch edges')
  reportGuard('edges', res, guard)
  return res.json()
}

// 選択した 1 ノードの「描画では使わない属性」を後から引く。描画の高速経路(nx=fast)は R-Tree だけを
// 読むので size/kind/haplotype/coverage 等が NodeData に入っていない。詳細パネル用に 1 行だけ補う。
export interface NodeInfo {
  size?: number; kind?: number; haplotype?: string | null; coverage?: number
  comp_id?: number; parent_name?: string; is_bubble?: number
}
export async function fetchNodeInfo(dbFile: string, name: string): Promise<NodeInfo> {
  const p = new URLSearchParams({ db: dbFile, name })
  try {
    const res = await fetch(`/api/node_info?${p}`)
    if (!res.ok) return {}
    return await res.json()
  } catch { return {} }
}

// ── Bubble MSA(選択 bubble を通る各サンプルの実通過を多重整列) ──
// backend /api/bubble_msa が Python 抽出器を spawn して返す固定幅グリッド。列=ノードサイト、
// 行=per-pass 通過、seq=各列の塩基/‘-’gap/‘~’畳み。設計は memory msa-traversal-panel-design。
export interface MsaCol {
  kind: 'base' | 'ell'
  nodes: string[]           // この列が属するアレル群(同じサイトの排他アレル。通常 1 要素)
  g: number                 // 群の連番。境界の描画とブロック見出しに使う
  rb?: number | null        // 参照 bp(あればアンカー列)
  variant?: boolean         // 行間で塩基が食い違う列
  off?: number
  bp?: number               // ell 列: 畳んだノードの bp 長
}
export interface MsaRow {
  samp: string              // sample 名(並び/グルーピング用)
  label: string             // 表示ラベル `sample#hap`(同一パスの複数通過は ·2, ·3)
  path: string              // 元のパス名(tooltip 用)
  strand: string            // 行の優勢向き(p_ori の bp 加重多数決)
  inv: string[]             // 優勢向きと逆に通ったノード= 局所反転アレル(塩基は逆相補で入っている)
  seq: string; isref: boolean; allele: number
}
export interface BubbleMsaResp {
  name?: string; bp?: number | null; refname?: string | null; nrow?: number; nallele?: number
  cols?: MsaCol[]; rows?: MsaRow[]; error?: string
}
export async function fetchBubbleMsa(
  dbFile: string, nodes: string[], samples: string[] = [], flank = 0,
): Promise<BubbleMsaResp> {
  if (nodes.length === 0) return { error: 'ノードが選択されていません' }
  const p = new URLSearchParams({ db: dbFile, nodes: nodes.join(','), flank: String(flank) })
  if (samples.length > 0) p.set('samples', samples.join(','))
  const res = await fetch(`/api/bubble_msa?${p}`)
  if (!res.ok) return { error: 'request failed (' + res.status + ')' }
  return res.json()
}
