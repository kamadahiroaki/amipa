import { useEffect, useRef, useState, useCallback, useId, useMemo, Fragment } from 'react'
import GraphCanvas, { GraphCanvasHandle, PATH_COLORS, RibbonData } from './components/GraphCanvas'
import Minimap from './components/Minimap'
import { stainToColor, hexCss, GENE_DENSITY_LOW, GENE_DENSITY_HIGH, EXON_COLOR, INTRON_COLOR } from './annotColors'
import AlignmentView, { AlignRow, MoveDest } from './components/AlignmentView'
import BubbleMsa from './components/BubbleMsa'
import { fetchStats, fetchMaxHb, fetchCnv, fetchNodeInfo, NodeInfo, fetchLeafSeq, fetchLeafBases, fetchVersion, searchNodes, fetchExpandNode, saveSession, loadSession, searchReads, fetchNodesByName, fetchPathGroups, fetchRibbon, fetchRefContigs, fetchGoto, saveEdits, fetchFlood, fetchAnnotDicts, fetchNodeFeatures, fetchGeneFeatures, fetchGeneExons, Rect, NodeData, LeafSeq, VersionInfo, ReadAlignment, PathGroup, RibbonLevel, RefContig, BandDictEntry, RegionDictEntry, NodeFeature, GeneFeature, GeneExon, EditGesture, StatsResult, fetchPrewarm, PrewarmInfo } from './api/client'
import { docsUrl } from './docsLink'

type Cell = NodeData | null

// 参照 bp を「12,345,678 (12.3 Mb)」形式に整形（サイドバー詳細用）。
// ノード詳細パネル用の安全な整形。★NodeData の属性は「取得経路によっては入っていない」
// (描画の高速経路 nx=fast は R-Tree だけを読むので size/kind/haplotype 等が無い)。
// 素に .toFixed()/.toLocaleString() を呼ぶと undefined で例外→画面が落ちるので必ずこれを通す。
function num(v: number | undefined | null, group = false): string {
  return typeof v === 'number' && Number.isFinite(v) ? (group ? v.toLocaleString() : String(v)) : '—'
}
function fixed(v: number | undefined | null, digits: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'
}

// 「間を全選択」で一度に選べるノード数の上限(抽出器の MAX_LEAVES=400 に合わせる)。
const MSA_MAX_NODES = 400

function fmtBpDetail(bp: number): string {
  if (!isFinite(bp)) return '?'
  const a = Math.abs(bp)
  const r = a >= 1e6 ? (bp / 1e6).toFixed(2) + ' Mb'
          : a >= 1e3 ? (bp / 1e3).toFixed(1) + ' kb'
          : bp + ' bp'
  return `${bp.toLocaleString()} (${r})`
}

// go-to 入力の bp をパース: カンマ・空白を許容し、末尾に bp/kb/mb(k/m) 単位を認める。
// 例 "12,300,000" → 12300000 / "12.3Mb" → 12300000 / "800kb" → 800000。
function parseBpNumber(s: string): number | null {
  const t = s.trim().replace(/[, ]/g, '')
  const m = t.match(/^([0-9]*\.?[0-9]+)(bp|kb|mb|k|m)?$/i)
  if (!m) return null
  let v = parseFloat(m[1])
  if (!isFinite(v)) return null
  const u = (m[2] || '').toLowerCase()
  if (u === 'kb' || u === 'k') v *= 1e3
  else if (u === 'mb' || u === 'm') v *= 1e6
  return Math.round(v)
}

// 8.2 自己完結パーマリンク用: 状態オブジェクト ⇄ deflate-raw + base64url 文字列。
// CompressionStream/DecompressionStream は Chrome103+/FF113+/Safari16.4+。サーバ session を介さず
// URL(?st=) だけで復元でき、別デプロイ間・オフラインでも図版を再現できる。
async function encodeStateB64(obj: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(obj))
  const cs = new CompressionStream('deflate-raw')
  const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function decodeStateB64(s: string): Promise<any> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const ds = new DecompressionStream('deflate-raw')
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text()
  return JSON.parse(text)
}

// 末尾の null を切り詰め、全 null（空）の列を除去
function cleanupColumns(cols: Cell[][]): Cell[][] {
  return cols
    .map(col => { let e = col.length; while (e > 0 && col[e - 1] == null) e--; return col.slice(0, e) })
    .filter(col => col.some(n => n != null))
}

// ノードをグリッド内で移動／入れ替え。空セル(null)で段の隙間を表現できる。
function moveNodeInColumns(columns: Cell[][], nodeId: number, dest: MoveDest): Cell[][] {
  let node: NodeData | null = null, fromCol = -1, fromLane = -1
  columns.forEach((col, c) => col.forEach((n, l) => { if (n && n.id === nodeId) { node = n; fromCol = c; fromLane = l } }))
  if (!node || fromCol < 0) return columns

  if (dest.kind === 'swap') {
    if (dest.withNodeId === nodeId) return columns
    let toCol = -1, toLane = -1
    columns.forEach((col, c) => col.forEach((n, l) => { if (n && n.id === dest.withNodeId) { toCol = c; toLane = l } }))
    if (toCol < 0) return columns
    const cols = columns.map(col => col.slice())
    const tmp = cols[fromCol][fromLane]
    cols[fromCol][fromLane] = cols[toCol][toLane]
    cols[toCol][toLane] = tmp
    return cleanupColumns(cols)
  }

  if (dest.kind === 'cell') {
    // 絶対バンド位置へ配置。元は null にして隙間を残さない側はcleanupで処理
    const cols = columns.map(col => col.slice())
    cols[fromCol][fromLane] = null
    const col = cols[dest.col]
    while (col.length <= dest.lane) col.push(null)
    col[dest.lane] = node
    return cleanupColumns(cols)
  }

  // column / lane: 移動（元を詰める）
  const cols = columns.map(col => col.slice())
  cols[fromCol].splice(fromLane, 1)
  if (dest.kind === 'column') {
    cols.splice(dest.index, 0, [node])
  } else {
    let lane = dest.lane
    if (dest.col === fromCol && lane > fromLane) lane -= 1   // 同一列内で前を抜いた分シフト
    cols[dest.col].splice(lane, 0, node)
  }
  return cleanupColumns(cols)
}

// 展開のサブレイアウト(seed+新規)を既存ボードへマージ。既存ノードは動かさず、
// 新規列を seed の列の前後に挿入、seed と同列の新規は seed の列に段として追加。
function mergeExpansion(existing: Cell[][], sub: NodeData[][], seedName: string): Cell[][] {
  let si = -1, sl = -1
  sub.forEach((col, c) => col.forEach((n, l) => { if (n.node_name === seedName) { si = c; sl = l } }))
  void sl
  let ec = -1
  existing.forEach((col, c) => col.forEach(n => { if (n && n.node_name === seedName) ec = c }))
  if (si < 0 || ec < 0) return cleanupColumns([...existing.map(c => c.slice()), ...sub])  // フォールバック: 末尾に追加
  const before = sub.slice(0, si)
  const after = sub.slice(si + 1)
  const mates = sub[si].filter(n => n.node_name !== seedName)   // seed と同列の新規ノード
  const merged: Cell[][] = [
    ...existing.slice(0, ec).map(c => c.slice()),
    ...before.map(c => c.slice() as Cell[]),
    [...existing[ec], ...mates],
    ...after.map(c => c.slice() as Cell[]),
    ...existing.slice(ec + 1).map(c => c.slice()),
  ]
  return cleanupColumns(merged)
}

// アラインビューのノード対応色（マップとヘッダ枠で共有）
const ALIGN_NODE_COLORS = [
  0x1971c2, 0xe03131, 0x2f9e44, 0xf08c00, 0x9c36b5, 0x0c8599,
  0xe8590c, 0xc2255c, 0x495057, 0x5c940d, 0x1098ad, 0xd6336c,
  0x6741d9, 0x37b24d, 0xf59f00, 0x4263eb,
]
const EMPTY_NODE_COLORS: Map<string, number> = new Map()

const HANDLE_SIZE = 5   // px, resize handle thickness
const MIN_SIDE   = 0    // px, minimum surrounding panel size
const MIN_GRAPH  = 120  // px, minimum graph canvas dimension

const handleStyle: React.CSSProperties = {
  flexShrink: 0,
  background: '#d8dde3',
  userSelect: 'none',
  // ★掴める範囲を広げるため、下の .amipa-grip-* が ::after で透明な帯を張り出す。
  //   見た目の太さ(HANDLE_SIZE)は変えない。position/zIndex はその帯を隣より前に出すため。
  position: 'relative',
  zIndex: 5,
}
// 掴みしろ(px)。5px の線を掴むのは細すぎるので、上下(左右)にこれだけ透明な帯を足す。
const GRIP_PAD = 6

const EMPTY_RIBBONS: RibbonData[] = []   // リボン一時非表示用の安定した空配列(参照不変で再描画churn回避)

function makeDragHandler(
  onMove: (delta: number) => void
): (e: React.MouseEvent) => void {
  return (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const isHoriz = (e.currentTarget as HTMLElement).style.cursor === 'col-resize'

    // mousemove は1フレームに何度も来るので rAF でコアレスし、setState（＝重い再描画）を
    // 最大フレーム1回に抑える。パネルサイズ変更時の引っかかりを軽減する。
    let raf = 0
    let pendingDelta = 0
    const flush = () => { raf = 0; onMove(pendingDelta) }
    function onMouseMove(ev: MouseEvent) {
      pendingDelta = isHoriz ? ev.clientX - startX : ev.clientY - startY
      if (!raf) raf = requestAnimationFrame(flush)
    }
    function onMouseUp() {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      onMove(pendingDelta)   // 最終位置を確実に反映
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
}

// 未保存のノード編集（pendingEdits = 名前集合ごとの剛体変換）を、DB から取り直した素のリボン幾何へ
// 再適用する。ノード移動/回転では in-memory のリボンが追従するが、群の追加/解除・θ/層変更でリボンを
// 取り直すと DB 元座標に戻ってしまう。取得直後にここで編集分を焼き込んで、移動済みノードと整合させる。
// gesture は記録順に「その時点の座標」に効く剛体変換なので、素座標へ順に合成すれば最終位置になる。
// ノードは自身の node_name で、エッジ端点は su/tv(rowid)→name(同一リボンの nodes から解決)で判定する。
function applyGesturesToRibbons(ribs: RibbonData[], gestures: EditGesture[]): RibbonData[] {
  if (gestures.length === 0) return ribs
  return ribs.map(rib => {
    const idToName = new Map(rib.nodes.map(n => [n.id, n.name]))
    const nodes = rib.nodes.map(n => ({ ...n }))
    const edges = rib.edges.map(e => ({ ...e }))
    for (const g of gestures) {
      const names = new Set(g.names)
      const { cos, sin, tx, ty, dAngle } = g
      for (const n of nodes) {
        if (!names.has(n.name)) continue
        const x = n.x, y = n.y
        n.x = cos * x - sin * y + tx
        n.y = sin * x + cos * y + ty
        n.a += dAngle
      }
      for (const e of edges) {
        if (names.has(idToName.get(e.su) ?? '')) {
          const x = e.sx, y = e.sy
          e.sx = cos * x - sin * y + tx
          e.sy = sin * x + cos * y + ty
        }
        if (names.has(idToName.get(e.tv) ?? '')) {
          const x = e.ex, y = e.ey
          e.ex = cos * x - sin * y + tx
          e.ey = sin * x + cos * y + ty
        }
      }
    }
    return { ...rib, nodes, edges }
  })
}

export default function App() {
  const [databases, setDatabases] = useState<string[]>([])
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  // プリウォーム進捗（DB を開くと backend が順読みを始める）。走っている間だけポーリングする。
  const [prewarm, setPrewarm] = useState<PrewarmInfo | null>(null)
  useEffect(() => {
    if (!selectedDb) { setPrewarm(null); return }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const p = await fetchPrewarm(selectedDb)
      if (!alive) return
      setPrewarm(p && (p.running || p.finished) ? p : null)
      // 走っている間だけ 1 秒ポーリング。終わったら止める（完了表示は数秒だけ出して消す）。
      if (p?.running) timer = setTimeout(tick, 1000)
      else if (p?.finished) timer = setTimeout(() => { if (alive) setPrewarm(null) }, 4000)
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [selectedDb])
  const [maxLayer, setMaxLayer] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  // ソフト(BFS弾性)移動: 掴んだノード＋近傍(hop≤softDragHops)を hop 減衰重みで一緒に動かす。
  const [softDragMode, setSoftDragMode] = useState(false)
  const [softDragHops, setSoftDragHops] = useState(6)
  const [softDragSoftness, setSoftDragSoftness] = useState(5)   // 大=柔らかい(近傍が広く緩やかに追従)
  const [pendingEdits, setPendingEdits] = useState<EditGesture[]>([])   // 未保存のノード編集（移動/回転）
  const [savingEdits, setSavingEdits] = useState(false)
  const [mapReloadKey, setMapReloadKey] = useState(0)   // DB更新後にミニマップを再マウントする用
  const [nodeGreyMode, setNodeGreyMode] = useState(false)
  const [showNodeNames, setShowNodeNames] = useState(false)
  const [showNodeBp, setShowNodeBp] = useState(false)   // ノードの bp 数(size)ラベル。クラスタは合計 bp
  const [showAlignColors, setShowAlignColors] = useState(false)
  // ノード追加でリンク色を自動 ON にするが、利用者が自分で切ったらそれを尊重する。
  // Alignment を閉じるとリセット（次に開いたらまた自動 ON になる）。
  const alignColorsUserOff = useRef(false)
  const [coverageTextMode, setCoverageTextMode] = useState(false)
  // 全ラベル(ref bp/ノード名/遺伝子/バンド等)の一括サイズ倍率。Labels ポップオーバーの ± で調整。
  const [labelScale, setLabelScale] = useState(1)
  const bumpLabelScale = (f: number) => setLabelScale(s => Math.round(Math.min(3, Math.max(0.6, s * f)) * 100) / 100)
  // ノード上ラベル(名前/bp/深度)の文字色と、ノード外へずらす上方向オフセット px。
  const [labelColor, setLabelColor] = useState('#111111')
  const [labelOffset, setLabelOffset] = useState(0)
  // エッジ太さに乗せる量（排他・一度に1つ）: off / paths=通過ハプロタイプ数(hb) / reads=read_support(リード数)。
  const [edgeWidthMode, setEdgeWidthMode] = useState<'off' | 'paths' | 'reads'>('off')
  // A-2 CNV(per-haplotype コピー数): off / all=選択ユニット全ての cn / diff=cn が食い違うノードのみ。
  // 選択リボン(ribbonSel)のユニットを流用し、ノードにリボン同色でコピー数テキストを重畳。
  const [cnvMode, setCnvMode] = useState<'off' | 'all' | 'diff'>('off')
  // 配列表示モード: 画面内の小さい葉(現状 1bp のみ)の塩基をノード内に描画。それより長い葉はノード選択時のみ。
  const [seqMode, setSeqMode] = useState(false)
  const [baseMap, setBaseMap] = useState<Map<string, string>>(new Map())
  const [cnvNodes, setCnvNodes] = useState<Map<string, number[]>>(new Map())
  const [cnvColors, setCnvColors] = useState<number[]>([])
  // 近接モード(グラフ距離フラッド): クリック点から hop 距離でグリフを3層着色（融合 vs 近接の確認）。
  const [floodMode, setFloodMode] = useState(false)
  const [floodHops, setFloodHops] = useState(10)              // D（最大手数, 確定値）
  const [floodHopsInput, setFloodHopsInput] = useState('10')  // D 入力ドラフト（確定は Enter/blur; 毎キー再描画を避ける）
  const [floodResult, setFloodResult] = useState<Map<string, number> | null>(null)  // name→hop
  const [floodSeedComp, setFloodSeedComp] = useState<number | null>(null)            // クリック点の comp_id
  // ノード半径にかける倍率（全体サイズ調整）。nodeScale=確定値(描画を駆動)、draft=スライダーの追従位置。
  // ドラッグ中は draft だけ動かし、離した時に nodeScale へ確定＝重い再描画をドラッグ中に走らせない。
  const [nodeScale, setNodeScale] = useState(1)
  const [nodeScaleDraft, setNodeScaleDraft] = useState(1)
  const NODE_SCALE_MIN = 0.25, NODE_SCALE_MAX = 6
  // 確定値を即反映（±ボタン・リセット・スナップショット用）。スライダーは onChange で draft のみ更新。
  const applyNodeScale = (v: number) => {
    const c = Math.min(NODE_SCALE_MAX, Math.max(NODE_SCALE_MIN, Math.round(v * 100) / 100))
    setNodeScale(c); setNodeScaleDraft(c)
  }
  const [maxHb, setMaxHb] = useState(1)      // Paths(=hb) エッジ太さのスケール上限（/api/max_hb で遅延取得）
  const [coverageMin, setCoverageMin] = useState(0)
  const [coverageMinInput, setCoverageMinInput] = useState('')
  const [edgeMin, setEdgeMin] = useState(0)
  const [edgeMinInput, setEdgeMinInput] = useState('')
  // 大域 mapq プリセット: この値以上のアラインのみで depth/read_support を集計（マップ全体＋アラインビュー既定）
  const [mapMapq, setMapMapq] = useState(0)
  const [maxEdgePx, setMaxEdgePx] = useState(10)
  const [maxEdgeReads, setMaxEdgeReads] = useState(100)
  const [detailParamInput, setDetailParamInput] = useState('10,100')
  const [hint, setHint] = useState<{ text: string; key: number } | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showOverlays, setShowOverlays] = useState(true)  // viewport内の付属UI一括表示（false=全消去）
  const [alignRows, setAlignRows] = useState<AlignRow[]>([])
  const [activeAlignRowId, setActiveAlignRowId] = useState<number | null>(null)
  const [pendingNode, setPendingNode] = useState<NodeData | null>(null)
  const alignRowNextId = useRef(0)
  const [mapViewport, setMapViewport] = useState<Rect>({ x1: 0, x2: 1, y1: 0, y2: 1 })
  // リボン取得用にデバウンスしたビューポート。パンの度に fetch せず、settle 後 250ms でのみ更新する。
  const [ribbonViewport, setRibbonViewport] = useState<Rect>({ x1: 0, x2: 1, y1: 0, y2: 1 })
  const [mapLayer, setMapLayer] = useState(0)
  // LOD-A: DB メタ（stats 由来）と表示ノブ・状態。層は zoom 閾値 layerZoom だけで選ぶ。
  const [lodMeta, setLodMeta] = useState<{
    layerZoom: number[]; world: { x0: number; x1: number; y0: number; y1: number } | null
    // 較正窓の規約（§4）。'square_side_W_over_s'=canvas 非依存の新既定 / 欠落=旧 DB は従来式。
    zoomWindow?: StatsResult['zoom_window']
  }>({ layerZoom: [], world: null })
  const [dbIncompatible, setDbIncompatible] = useState<string | null>(null)  // 現行仕様非互換DBの理由
  const [dbLegacy, setDbLegacy] = useState(false)       // 旧仕様(layer_zoom 無し)警告バナー（消せる）
  const [ribbonHapcov, setRibbonHapcov] = useState(false)  // hapcov DB（node_hap_cov テーブルあり）
  const [ribbonContig, setRibbonContig] = useState(false)  // contig 索引 DB（contigcov_meta あり; sample/hap/contig 全対応）
  const [refposAvail, setRefposAvail] = useState(false)    // 参照座標トラック（ref_meta あり）
  const [hbAvail, setHbAvail] = useState(false)            // A-2 hap-breadth 列あり（パス多重度モード可）
  const [multAvail, setMultAvail] = useState(false)        // A-2 node_hap_mult あり（CNV モード可）
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)  // 上部バー版表示(viewer/db)
  // 描画の高速経路（R-Tree だけを読む）の状態。外れると全ゲノムの深層で桁が変わるので上部バーに出す。
  const [fastPath, setFastPath] = useState<{ on: boolean; cause: 'nodebp' | 'proximity' | null }>(
    { on: true, cause: null })
  // 配信側で DB 書き換えを塞いである配信（AMIPA_READONLY=1）。編集操作そのものは許すが
  // Save だけ無効にする＝「動かして繋がりを確かめる」用途はデモでもそのまま使える。
  const saveDisabled = versionInfo?.readonly === true
  const seqAvail = versionInfo?.db?.features.seq ?? false   // leaf_seq あり（配列表示モード可）
  const [showRefPos, setShowRefPos] = useState(true)       // 参照上の概算 bp 位置ラベルを重畳（既定ON）
  const [refContigs, setRefContigs] = useState<Map<number, RefContig>>(new Map())  // contig_id -> 表示名/長さ
  // アノテーション(band/gene/region)着色。node fill は単値なので coverage 等と相互排他(トグルで切替)。
  const [bandMode, setBandMode] = useState(false)
  const [regionMode, setRegionMode] = useState(false)
  const [geneMode, setGeneMode] = useState(false)     // 遺伝子密度(粗ズームの疎表示)
  const [bandAvail, setBandAvail] = useState(false)
  const [regionAvail, setRegionAvail] = useState(false)
  const [geneAvail, setGeneAvail] = useState(false)
  const [bandDict, setBandDict] = useState<Map<number, BandDictEntry>>(new Map())
  const [regionDict, setRegionDict] = useState<Map<number, RegionDictEntry>>(new Map())
  const [maxGeneCount, setMaxGeneCount] = useState(1)
  // アノテ・オーバーレイ(名前ラベル; color-by とは独立に重畳)。
  const [showBandLabels, setShowBandLabels] = useState(false)
  const [showRegionMarks, setShowRegionMarks] = useState(false)
  const [showGeneLabels, setShowGeneLabels] = useState(false)
  const [geneFeatures, setGeneFeatures] = useState<GeneFeature[]>([])
  // アノテーションの遅延取得。**トラックを ON にした時に初めて**取りに行く。
  // ref は「どの DB で取得済みか」。DB 切替でクリアされる（上のリセット参照）。
  const annotDictsLoadedRef   = useRef<string | null>(null)
  const geneFeaturesLoadedRef = useRef<string | null>(null)
  const [annotLoading, setAnnotLoading] = useState(false)
  useEffect(() => {
    if (!selectedDb) return
    // band/region の色分けに使う辞書。gene 密度の正規化 (maxGeneCount) もここで来る。
    const needDicts = (bandMode || regionMode || geneMode)
      && (bandAvail || regionAvail || geneAvail) && annotDictsLoadedRef.current !== selectedDb
    if (needDicts) {
      annotDictsLoadedRef.current = selectedDb
      setAnnotLoading(true)
      fetchAnnotDicts(selectedDb).then(a => {
        setBandDict(new Map(a.bands.map(b => [b.band_id, b])))
        setRegionDict(new Map(a.regions.map(r => [r.region_id, r])))
        setMaxGeneCount(Math.max(1, a.maxGeneCount || 1))
      }).catch(() => { annotDictsLoadedRef.current = null /* 次に ON にした時に再試行 */ })
        .finally(() => setAnnotLoading(false))
    }
    // 遺伝子ランドマークの一覧（WG では 13MB 級）。gene トラックを使う時だけ。
    if (geneMode && geneAvail && geneFeaturesLoadedRef.current !== selectedDb) {
      geneFeaturesLoadedRef.current = selectedDb
      fetchGeneFeatures(selectedDb).then(setGeneFeatures)
        .catch(() => { geneFeaturesLoadedRef.current = null })
    }
  }, [selectedDb, bandMode, regionMode, geneMode, bandAvail, regionAvail, geneAvail])
  const [selectedNodeFeatures, setSelectedNodeFeatures] = useState<NodeFeature[]>([])  // 選択ノードの遺伝子(詳細)
  const [selectedGene, setSelectedGene] = useState<{ start: number; end: number; name: string } | null>(null)
  const [selectedGeneExons, setSelectedGeneExons] = useState<GeneExon[]>([])  // 選択遺伝子の exon 区間
  const [refKey, setRefKey] = useState<string | null>(null)  // アンカー参照名（例 GRCh38）
  // 詳細度オフセット（層数）: ＋=1段深く / −=1段浅く。zoom 自動層に加算される（1クリック=確実に1層）。
  // 段数は固定制限を付けず、実層が [0, maxLayer] に達したらボタン側で止める（DETAIL_CLAMP は暴走防止の緩い上限）。
  const [detailStep, setDetailStep] = useState(0)
  const DETAIL_CLAMP = 30
  const [mapGlyphs, setMapGlyphs] = useState(0)
  const [suppressHeavy, setSuppressHeavy] = useState(false)     // 「今後警告しない」（セッション内）
  const [heavyModal, setHeavyModal] = useState<number | null>(null)  // 重い警告モーダル（表示中は glyph 数）
  const [heavyDontWarn, setHeavyDontWarn] = useState(false)    // モーダル内チェックボックスの一時状態
  // モーダルを閉じる: 「今後警告しない」なら以後抑制。simplify=軽く / それ以外=続行して描画。
  const closeHeavy = (action: 'simplify' | 'proceed') => {
    if (heavyDontWarn) setSuppressHeavy(true)
    if (action === 'simplify') setDetailStep(s => Math.max(-DETAIL_CLAMP, s - 1))
    else graphRef.current?.proceedHeavy()
    setHeavyModal(null); setHeavyDontWarn(false)
  }
  const graphRef = useRef<GraphCanvasHandle>(null)
  const [selectedNode, setSelectedNode] = useState<NodeData | null>(null)
  const [selectedNodeInfo, setSelectedNodeInfo] = useState<NodeInfo | null>(null)  // 高速経路で欠ける属性の補完
  // リード/アラインメント選択（クリック or 検索）。サイドバーに詳細を出し、全ボードで該当 aln_id を強調。
  const [selectedReadAln, setSelectedReadAln] = useState<ReadAlignment | null>(null)
  const [readResults, setReadResults] = useState<ReadAlignment[] | null>(null)  // 検索候補（read_name で複数になり得る）
  const [readQuery, setReadQuery] = useState('')
  const [readSearching, setReadSearching] = useState(false)
  const selectedAln = selectedReadAln?.aln_id ?? null
  async function runReadSearch(q: string) {
    if (!selectedDb || !q.trim()) { setReadResults(null); return }
    setReadSearching(true)
    const res = await searchReads(selectedDb, q)
    setReadSearching(false)
    setReadResults(res)
    setSelectedReadAln(res.length >= 1 ? res[0] : null)   // 1件なら即選択、複数なら先頭を選択しつつ候補も表示
  }
  // ボードでのクリック由来。aln_id から詳細を引いて選択（null=解除）。
  async function selectAln(alnId: number | null) {
    if (alnId == null) { setSelectedReadAln(null); return }
    if (!selectedDb) return
    const res = await searchReads(selectedDb, String(alnId))
    if (res.length > 0) { setSelectedReadAln(res[0]); setReadResults(res) }
  }
  // 選択中アライメントの経路ノードを view に一括追加。既にどこかの view に当該 aln_id があれば
  // （= その view が経路ノードを1つでも表示）その view へ残りを追加、無ければ新 view を作る。
  // selectedAln は維持されるので、追加ノードのリードが読み込まれ次第ハイライトが効く。
  async function addPathToView() {
    if (!selectedReadAln || !selectedDb) return
    const path = [...new Set(selectedReadAln.segments.map(s => s.node_name).filter((n): n is string => !!n))]
    if (path.length === 0) return
    const has = (r: AlignRow) => {
      const names = new Set(r.columns.flat().filter((n): n is NodeData => !!n).map(n => n.node_name))
      return path.some(p => names.has(p))
    }
    const active = alignRows.find(r => r.id === activeAlignRowId)
    const target = (active && has(active)) ? active : (alignRows.find(has) ?? null)
    const present = new Set((target?.columns.flat().filter((n): n is NodeData => !!n) ?? []).map(n => n.node_name))
    const want = target ? path.filter(p => !present.has(p)) : path
    if (want.length === 0) { setActiveAlignRowId(target!.id); return }   // 既に全経路が表示済み
    const nodes = await fetchNodesByName(selectedDb, want)
    if (nodes.length === 0) return
    const order = new Map(path.map((p, i) => [p, i]))   // 経路順に並べて列にする
    nodes.sort((a, b) => (order.get(a.node_name) ?? 0) - (order.get(b.node_name) ?? 0))
    const newCols = nodes.map(n => [n] as (NodeData | null)[])
    if (target) {
      setAlignRows(prev => prev.map(r => r.id !== target.id ? r : { ...r, columns: [...r.columns, ...newCols] }))
      setActiveAlignRowId(target.id)
    } else {
      const id = alignRowNextId.current++
      setAlignRows(prev => [...prev, { id, columns: newCols }])
      setActiveAlignRowId(id)
    }
  }
  const [isLoading, setIsLoading] = useState(false)
  // 取得の進捗（backend の worker が報告する処理済み行数 / 想定件数）。total=0 は分母不明。
  const [fetchProg, setFetchProg] = useState<{ rows: number; total: number } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<NodeData[]>([])
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'notfound'>('idle')
  const searchWrapRef = useRef<HTMLDivElement>(null)
  // 統合 Find: 検索対象を Node（ノード名）/ Position（chr:bp）/ Gene（遺伝子名）で切替。入力は searchQuery を共用。
  const [findScope, setFindScope] = useState<'node' | 'pos' | 'gene'>('node')
  // Labels ポップオーバー（ノード名/塩基/参照bp/深度数値/CNV をまとめる）の開閉。
  const [showLabelsMenu, setShowLabelsMenu] = useState(false)
  const labelsMenuRef = useRef<HTMLDivElement>(null)
  // Export ポップオーバー（8.3 持ち出せる出力: 部分グラフ GFA / ノード BED）。
  const [showExportMenu, setShowExportMenu] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // パスパネル
  const [showPaths, setShowPaths] = useState(true)   // 左のパス選択パネル（主要な操作面なので既定 ON）
  const [leftW, setLeftW] = useState(260)
  // CTG パスの折れ線描画。現行スキーマでは `ctg_paths` を埋める処理が無いので**常に空**
  // （GraphCanvas 側の renderPaths も同じ理由で何も描かない）。
  const [selectedPaths, setSelectedPaths] = useState<Map<string, number>>(new Map())

  // ── パスリボン（サンプル/ハプロ/コンティグの通過経路を線で重畳） ──
  const [ribbonLevel, setRibbonLevel] = useState<'none' | RibbonLevel>('none')
  const [pathGroups, setPathGroups] = useState<PathGroup[]>([])
  const [ribbonSel, setRibbonSel] = useState<Map<string, { gids: number[]; color: number }>>(new Map())
  // hap 絞り込み描画: 選択したリボン群(サンプル/ハプロタイプ/コンティグ)を通るノード・エッジだけ取得する。
  // 密領域(gvar 等)では取得件数が桁で落ち、同じ予算でより深い層＝葉レベルまで降りられる。
  // サイドカー `<db>.hapidx` (prep/amipa_prep/hap_index.py 産)がある DB でのみ有効。
  const [hapIdx, setHapIdx] = useState<NonNullable<StatsResult['hapidx']> | null>(null)
  const [hapFilter, setHapFilter] = useState(false)
  // LOD 安全弁: 1 リクエストで受け取る行数の上限（= 描いても読めない枚数）。**UX 値なので client が決める**。
  // 密領域に入ると backend が上位層へ clamp し、その旨が lodClamp に入る（絞り込みへの導線を出す）。
  // 0 = 安全弁 OFF（従来どおり）。
  const MAXROWS_OPTS = [0, 5000, 20000, 50000] as const
  // 既定を一旦 0(無制限=安全弁 OFF) にしている。密領域で clamp されずに素の重さを見るため。
  // ⚠ この状態では L_safe が働かず、残る防波堤は backend の時間ガード(FETCH_MS=15s)だけ。
  //   しかもその時間チェックは 1024 行ごとなので、1 行あたりが病的に遅い環境（WG cold の実測で
  //   最初の 1024 行に 280 秒）では発火が遅れる。常用の既定に戻すなら 20000。
  const [maxRows, setMaxRows] = useState<number>(0)
  const [lodClamp, setLodClamp] =
    useState<{ requested: number; served: number; counts?: Record<string, number> } | null>(null)
  // 選択群 → backend の sel= に渡す contig_id レンジ列。絞り込み OFF・索引無し・選択無しなら空文字。
  // ここが変わると GraphCanvas は全タイルを取り直す（内容が変わるので mapq 変更と同じ扱い）。
  const hapSel = useMemo(() => {
    if (!hapFilter || !hapIdx || ribbonSel.size === 0) return ''
    const parts: string[] = []
    for (const { gids } of ribbonSel.values()) {
      if (!gids || gids.length === 0) continue
      const lo = Math.min(...gids), hi = Math.max(...gids)
      parts.push(lo === hi ? String(lo) : `${lo}-${hi}`)
    }
    return parts.sort().join(',')
  }, [hapFilter, hapIdx, ribbonSel])
  // θ 既定 0 = 「少しでも通れば通過」。**表示フィルタ(sel=)の判定と一致させるため**。
  // θ は super-node の *総塩基* に対する被覆率なので、バブルでは 1 ハプロタイプが原理的に
  // 1/アリル数しか覆えない（例: S3976494 は 10bp のバブルで grch38 は 4bp = cov 102/255）。
  // 既定 0.5 だと多アリルのバブスで「ノードは表示されるのにリボンが無い」矛盾が出ていた。
  // 混雑を抑えたい時だけ手で上げる。
  const [ribbonTheta, setRibbonTheta] = useState(0)
  const [ribbons, setRibbons] = useState<RibbonData[]>([])
  const [ribbonSearch, setRibbonSearch] = useState('')
  const [ribbonCollapsed, setRibbonCollapsed] = useState(false)  // リスト部を畳む（リボン描画は維持）
  const [ribbonHidden, setRibbonHidden] = useState(false)        // 選択は維持したままリボン描画だけ一時非表示
  // Layer 2: UTGクリック時のCTGリスト
  // 葉ノードの塩基配列(選択時 on-demand)。leafSeqFull=全長取得済みか(既定は先頭100kb)。
  const [leafSeq, setLeafSeq] = useState<LeafSeq | null>(null)
  const [leafSeqFull, setLeafSeqFull] = useState(false)

  // ドロップダウン外クリックで閉じる
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!searchWrapRef.current?.contains(e.target as Node))
        setShowSearchDropdown(false)
      if (!labelsMenuRef.current?.contains(e.target as Node))
        setShowLabelsMenu(false)
      if (!exportMenuRef.current?.contains(e.target as Node))
        setShowExportMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // 描画の高速経路(nx=fast)は R-Tree だけを読むので size/kind/haplotype/coverage が NodeData に
  // 入ってこない。詳細パネルはそれらを出すので、選択されたノード 1 個だけ後から引き直して補う
  // (node_name の索引シーク 1 回)。★ここが欠けたまま `size.toLocaleString()` を呼んでいたため、
  // Edit モードでノードを掴む(=onNodeSelect が走る)と React が落ちて画面が真っ暗になっていた。
  useEffect(() => {
    if (!selectedNode || !selectedDb) { setSelectedNodeInfo(null); return }
    let live = true
    setSelectedNodeInfo(null)
    fetchNodeInfo(selectedDb, selectedNode.node_name)
      .then(r => { if (live) setSelectedNodeInfo(r) })
      .catch(() => { if (live) setSelectedNodeInfo(null) })
    return () => { live = false }
  }, [selectedNode, selectedDb])

  // 葉ノード選択時に塩基配列を on-demand 取得(既定は先頭 100kb; 葉以外/leaf_seq 無し DB は null)。
  useEffect(() => {
    setLeafSeqFull(false)
    if (!selectedNode || !selectedDb || !/^n\d+$/.test(selectedNode.node_name)) { setLeafSeq(null); return }
    let live = true
    fetchLeafSeq(selectedDb, selectedNode.node_name).then(r => { if (live) setLeafSeq(r) }).catch(() => { if (live) setLeafSeq(null) })
    return () => { live = false }
  }, [selectedNode, selectedDb])

  // パスリボン: level 変更で群一覧を取得。選択はリセット。
  useEffect(() => {
    setRibbonSel(new Map()); setRibbons([])
    if (!selectedDb || ribbonLevel === 'none') { setPathGroups([]); return }
    fetchPathGroups(selectedDb, ribbonLevel).then(setPathGroups).catch(() => setPathGroups([]))
  }, [selectedDb, ribbonLevel])

  // mapViewport → ribbonViewport をデバウンス（250ms）。パン連打で fetch を撃たないため。
  useEffect(() => {
    const t = setTimeout(() => setRibbonViewport(mapViewport), 250)
    return () => clearTimeout(t)
  }, [mapViewport])

  // 編集中フラグ・現ビューポートを ref で参照（下の取得を「依存」にせず読むため）。
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode
  const ribbonViewportRef = useRef(ribbonViewport)
  ribbonViewportRef.current = ribbonViewport
  // fetchRibbonsNow から最新の未保存編集を読むための ref（依存に入れると編集の度に再取得してしまうため）
  const pendingEditsRef = useRef(pendingEdits)
  pendingEditsRef.current = pendingEdits
  // リボンが編集（ノード移動/回転の追従で in-memory 変異）されたか。true の間はパン再取得を止め、
  // DB 元座標での上書きを防ぐ（＝編集モードを抜けてパンしても元位置に戻らない）。
  // 群/θ/層/DB を変えると新規取得するので下の Effect でクリアする。
  const ribbonEditedRef = useRef(false)

  // パスリボン取得の実体。現ビューポートを 50% 拡張した bbox で backend が R-tree 絞り込み（深層でも軽い）。
  const fetchRibbonsNow = useCallback(() => {
    if (!selectedDb || ribbonSel.size === 0) { setRibbons([]); return () => {} }
    let cancelled = false
    const sels = [...ribbonSel.entries()]
    const vp = ribbonViewportRef.current
    const mx = (vp.x2 - vp.x1) * 0.5, my = (vp.y2 - vp.y1) * 0.5
    const bbox = { x1: vp.x1 - mx, y1: vp.y1 - my, x2: vp.x2 + mx, y2: vp.y2 + my }
    Promise.all(sels.map(([label, s]) => fetchRibbon(selectedDb, mapLayer, s.gids, ribbonTheta, bbox)
      .then(resp => ({ label, color: s.color, nodes: resp.nodes, edges: resp.edges }))))
      // 取得直後に未保存編集を焼き込む＝群追加/解除でもリボンが編集前の初期位置に戻らない。
      .then(ribs => { if (!cancelled) setRibbons(applyGesturesToRibbons(ribs, pendingEditsRef.current)) })
      .catch(() => { if (!cancelled) setRibbons([]) })
    return () => { cancelled = true }
  }, [selectedDb, ribbonSel, ribbonTheta, mapLayer])
  const fetchRibbonsRef = useRef(fetchRibbonsNow)
  fetchRibbonsRef.current = fetchRibbonsNow

  // 明示操作（DB・群・θ・層の変更）は編集中でも取得＝群選択で初回表示できる。取得時に
  // applyGesturesToRibbons が未保存編集(pendingEdits)を焼き込むので、群の追加/解除でも移動分は
  // 失われない。「編集済み」フラグはクリアしてよい（以後のパン再取得も同様に編集分を再適用して整合する）。
  useEffect(() => { ribbonEditedRef.current = false; return fetchRibbonsNow() }, [fetchRibbonsNow])

  // パン（ビューポート settle）での取り直し。ただし編集中 or 編集済みのときはスキップする:
  // ノード移動は in-memory のリボン(ribbonsRef)を書き換えて追従させるため、ここで再取得すると
  // DB 元座標で上書きされ「パンでリボンだけ元位置に戻る」不具合になる。移動は DB 未永続なので、
  // 編集モードを抜けた後もセッション中は再取得を止めて保持する（群/θ/層を変えるまで）。
  useEffect(() => {
    if (editModeRef.current || ribbonEditedRef.current) return
    return fetchRibbonsRef.current()
  }, [ribbonViewport])

  // A-2 CNV 取得: cnvMode!=off かつ選択リボン群があれば、各ユニットの contig レンジで per-node cn を取得。
  // ユニット順=色順(ribbonSel)。bbox はリボンと同じ現ビューポート50%拡張。
  const fetchCnvNow = useCallback(() => {
    if (!selectedDb || cnvMode === 'off' || ribbonSel.size === 0) { setCnvNodes(new Map()); setCnvColors([]); return () => {} }
    let cancelled = false
    const sels = [...ribbonSel.values()]
    const units = sels.map(s => [Math.min(...s.gids), Math.max(...s.gids)] as [number, number])
    const colors = sels.map(s => s.color)
    const vp = ribbonViewportRef.current
    const mx = (vp.x2 - vp.x1) * 0.5, my = (vp.y2 - vp.y1) * 0.5
    const bbox = { x1: vp.x1 - mx, y1: vp.y1 - my, x2: vp.x2 + mx, y2: vp.y2 + my }
    fetchCnv(selectedDb, mapLayer, units, bbox).then(resp => {
      if (cancelled) return
      const m = new Map<string, number[]>()
      for (const n of resp.nodes) m.set(n.name, n.cns)
      setCnvNodes(m); setCnvColors(colors)
    }).catch(() => { if (!cancelled) { setCnvNodes(new Map()); setCnvColors([]) } })
    return () => { cancelled = true }
  }, [selectedDb, cnvMode, ribbonSel, mapLayer])
  const fetchCnvRef = useRef(fetchCnvNow)
  fetchCnvRef.current = fetchCnvNow
  useEffect(() => fetchCnvNow(), [fetchCnvNow])
  useEffect(() => fetchCnvRef.current(), [ribbonViewport])

  // 上部バー版情報(viewer git rev + 選択 DB のビルド由来/機能フラグ)。DB 切替時に取得。
  useEffect(() => {
    fetchVersion(selectedDb ?? undefined).then(setVersionInfo).catch(() => setVersionInfo(null))
  }, [selectedDb])

  // 配列表示モード: 画面内の小さい葉(現状 1bp)の塩基を取得しノード内描画に渡す。CNV と同じ現ビューポート50%拡張。
  const fetchBasesNow = useCallback(() => {
    if (!selectedDb || !seqMode) { setBaseMap(new Map()); return () => {} }
    let cancelled = false
    const vp = ribbonViewportRef.current
    const mx = (vp.x2 - vp.x1) * 0.5, my = (vp.y2 - vp.y1) * 0.5
    const bbox = { x1: vp.x1 - mx, y1: vp.y1 - my, x2: vp.x2 + mx, y2: vp.y2 + my }
    fetchLeafBases(selectedDb, mapLayer, 1, bbox).then(resp => {
      if (cancelled) return
      const m = new Map<string, string>()
      for (const b of resp.bases) m.set(b.name, b.base)
      setBaseMap(m)
    }).catch(() => { if (!cancelled) setBaseMap(new Map()) })
    return () => { cancelled = true }
  }, [selectedDb, seqMode, mapLayer])
  const fetchBasesRef = useRef(fetchBasesNow)
  fetchBasesRef.current = fetchBasesNow
  useEffect(() => fetchBasesNow(), [fetchBasesNow])
  useEffect(() => fetchBasesRef.current(), [ribbonViewport])

  // ラベル過多判定は GraphCanvas が「実際に描く可視ノードのラベル数」で行い onCnvSuppress で通知(トグルの⚠用)。
  // (fetch は bbox+50% マージンを含むため App 側で数えると画面上は閾値以下でも過大計上になる → 描画側で判定)。
  const [cnvSuppressed, setCnvSuppressed] = useState(false)
  const onCnvSuppress = useCallback((s: boolean) => setCnvSuppressed(s), [])

  // リボン群の選択トグル（色は PATH_COLORS から順に割当）
  const toggleRibbonGroup = useCallback((g: PathGroup) => {
    setRibbonSel(prev => {
      const next = new Map(prev)
      if (next.has(g.key)) { next.delete(g.key); return next }
      const used = new Set([...next.values()].map(v => v.color))
      const color = PATH_COLORS.find(c => !used.has(c)) ?? PATH_COLORS[next.size % PATH_COLORS.length]
      next.set(g.key, { gids: g.gids, color })
      return next
    })
  }, [])

  // 全選択: 現在の絞り込み(ribbonSearch)を通る群を全て選択に加える(色は循環割当)。
  const selectAllRibbon = useCallback(() => {
    const q = ribbonSearch.toLowerCase()
    const filtered = pathGroups.filter(g => !q || g.key.toLowerCase().includes(q))
    setRibbonSel(prev => {
      const next = new Map(prev)
      const used = new Set([...next.values()].map(v => v.color))
      let i = 0
      const pick = () => {
        let c = PATH_COLORS.find(x => !used.has(x))
        if (c == null) { c = PATH_COLORS[i % PATH_COLORS.length] }
        used.add(c); i++; return c
      }
      for (const g of filtered) if (!next.has(g.key)) next.set(g.key, { gids: g.gids, color: pick() })
      return next
    })
    setRibbonHidden(false)
  }, [pathGroups, ribbonSearch])

  // 選択反転(絞り込み結果に対して): 入っている群は外し、外れている群は入れる。
  const invertRibbon = useCallback(() => {
    const q = ribbonSearch.toLowerCase()
    const filtered = pathGroups.filter(g => !q || g.key.toLowerCase().includes(q))
    setRibbonSel(prev => {
      const next = new Map(prev)
      const used = new Set([...next.values()].map(v => v.color))
      let i = 0
      const pick = () => { let c = PATH_COLORS.find(x => !used.has(x)); if (c == null) c = PATH_COLORS[i % PATH_COLORS.length]; used.add(c); i++; return c }
      for (const g of filtered) {
        if (next.has(g.key)) next.delete(g.key)
        else next.set(g.key, { gids: g.gids, color: pick() })
      }
      return next
    })
  }, [pathGroups, ribbonSearch])

  // 2 ノード選択時: **フェッチ済み(可視)サブグラフ上で** A,B 間のノードを全選択(source/sink なら bubble 内部)。
  // DB は叩かない(client-side BFS, 可視エッジに有界＝WG でも即時)。可視外のノードは対象にならない。
  function fillBetween() {
    if (msaNodeSel.length !== 2) return
    const cnt = graphRef.current?.graphCounts() ?? { nodes: 0, edges: 0 }
    const got = graphRef.current?.nodesBetween(msaNodeSel[0], msaNodeSel[1]) ?? []
    // ★ 失敗を無言にしない。可視サブグラフ依存なので「なぜ効かないか」を必ず出す。
    if (got.length > MSA_MAX_NODES) {
      showHint(`間のノードが多すぎます（${got.length}）。より近い 2 ノードを選ぶか、深い層で選び直してください`)
    } else if (got.length > 2) {
      setMsaNodeSel(got); showHint(`間を全選択: ${got.length} ノード`)
    } else if (cnt.edges === 0) {
      showHint('エッジが未取得のため「間を全選択」できません（描画が落ち着いてから再実行）')
    } else {
      showHint('可視サブグラフ上で 2 ノードが繋がっていません（内部が見えるまでズームして再実行）')
    }
  }

  const showHint = useCallback((text: string) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    setHint({ text, key: Date.now() })
    hintTimerRef.current = setTimeout(() => setHint(null), 4000)
  }, [])

  // 未保存のノード編集をDBへ反映（子孫展開・全層・R-tree更新はbackend側でトランザクション処理）
  const saveNodeEdits = useCallback(async () => {
    if (!selectedDb || pendingEdits.length === 0 || savingEdits) return
    setSavingEdits(true)
    const gestures = pendingEdits
    const r = await saveEdits(selectedDb, gestures).catch(e => ({ ok: false, error: String(e) }))
    setSavingEdits(false)
    if (r.ok) {
      setPendingEdits([])
      // タイルキャッシュを破棄して現ビューを取り直す（他層の子孫も更新後の座標で再取得）。
      ribbonEditedRef.current = false   // 保存済み＝DBが最新。以後のパンでリボン再取得を再開
      graphRef.current?.reload()
      setMapReloadKey(k => k + 1)       // ミニマップ（別キャッシュ）を再マウントして取り直す
      showHint(`ノード編集をDBに保存しました（${(r as any).nodes?.toLocaleString?.() ?? '?'} ノード更新）`)
    } else {
      showHint(`保存に失敗しました: ${(r as any).error ?? '不明なエラー'}`)
    }
  }, [selectedDb, pendingEdits, savingEdits, showHint])

  // アラインビューに載っているノードへ出現順で対応色を割り当て（マップ・ヘッダ枠で共有）
  const alignNodeColors = useMemo(() => {
    const m = new Map<string, number>()
    let i = 0
    for (const row of alignRows)
      for (const col of row.columns)
        for (const n of col)
          if (n && !m.has(n.node_name)) m.set(n.node_name, ALIGN_NODE_COLORS[i++ % ALIGN_NODE_COLORS.length])
    return m
  }, [alignRows])
  const activeNodeColors = showAlignColors ? alignNodeColors : EMPTY_NODE_COLORS

  // 現在の状態をスナップショット化
  function captureSnapshot() {
    const vp = mapViewport
    return {
      v: 1,
      db: selectedDb,
      view: { cx: (vp.x1 + vp.x2) / 2, cy: (vp.y1 + vp.y2) / 2, vw: vp.x2 - vp.x1 },
      graph: { nodeGreyMode, coverageTextMode, edgeWidthMode, cnvMode, showNodeNames, showNodeBp, showAlignColors, showRefPos,
               maxHb, coverageMin, nodeScale, edgeMin, mapMapq, maxEdgePx, maxEdgeReads, labelScale, labelColor, labelOffset },
      paths: [...selectedPaths.entries()],
      panels: { leftW, rightW, topH, bottomH, msaH, showPaths, showOverlays },
      ribbon: { level: ribbonLevel, sel: [...ribbonSel.entries()] },
      align: { rows: alignRows, activeRowId: activeAlignRowId },
    }
  }

  // スナップショットを適用（初期ロード時に ?s=id から呼ぶ。viewはURL経由でGraphCanvasが復元）
  function applySnapshot(s: any) {
    if (!s || typeof s !== 'object') return
    const g = s.graph ?? {}
    setNodeGreyMode(!!g.nodeGreyMode)
    // Edge width: 新形式 edgeWidthMode を優先。旧共有URL(breadthMode/detailDepthMode)は paths/reads に読み替え。
    if (g.edgeWidthMode === 'paths' || g.edgeWidthMode === 'reads' || g.edgeWidthMode === 'off') setEdgeWidthMode(g.edgeWidthMode)
    else if (g.breadthMode) setEdgeWidthMode('paths')
    else if (g.detailDepthMode) setEdgeWidthMode('reads')
    if (g.cnvMode === 'all' || g.cnvMode === 'diff' || g.cnvMode === 'off') setCnvMode(g.cnvMode)
    if (typeof g.maxHb === 'number' && g.maxHb > 0) setMaxHb(g.maxHb)
    setCoverageTextMode(!!g.coverageTextMode); setShowNodeNames(!!g.showNodeNames); setShowNodeBp(!!g.showNodeBp)
    setShowAlignColors(!!g.showAlignColors)
    if (typeof g.showRefPos === 'boolean') setShowRefPos(g.showRefPos)
    if (typeof g.labelScale === 'number' && g.labelScale > 0) setLabelScale(g.labelScale)
    if (typeof g.labelColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.labelColor)) setLabelColor(g.labelColor)
    if (typeof g.labelOffset === 'number' && g.labelOffset >= 0) setLabelOffset(g.labelOffset)
    if (typeof g.coverageMin === 'number') { setCoverageMin(g.coverageMin); setCoverageMinInput(g.coverageMin ? String(g.coverageMin) : '') }
    if (typeof g.nodeScale === 'number' && g.nodeScale > 0) applyNodeScale(g.nodeScale)
    if (typeof g.edgeMin === 'number') { setEdgeMin(g.edgeMin); setEdgeMinInput(g.edgeMin ? String(g.edgeMin) : '') }
    if (typeof g.mapMapq === 'number') setMapMapq(g.mapMapq)
    if (typeof g.maxEdgePx === 'number') setMaxEdgePx(g.maxEdgePx)
    if (typeof g.maxEdgeReads === 'number') setMaxEdgeReads(g.maxEdgeReads)
    if (Array.isArray(s.paths)) setSelectedPaths(new Map(s.paths))
    const pn = s.panels ?? {}
    if (typeof pn.leftW === 'number') setLeftW(pn.leftW)
    if (typeof pn.rightW === 'number') setRightW(pn.rightW)
    if (typeof pn.topH === 'number') setTopH(pn.topH)
    if (typeof pn.bottomH === 'number') setBottomH(pn.bottomH)
    if (typeof pn.msaH === 'number') setMsaH(pn.msaH)
    if (typeof pn.showPaths === 'boolean') setShowPaths(pn.showPaths)
    if (typeof pn.showOverlays === 'boolean') setShowOverlays(pn.showOverlays)
    const rb = s.ribbon
    if (rb && ['none', 'sample', 'haplotype', 'contig'].includes(rb.level)) setRibbonLevel(rb.level)
    if (rb && Array.isArray(rb.sel)) setRibbonSel(new Map(rb.sel))
    if (s.align && Array.isArray(s.align.rows)) {
      const idMap = new Map<number, number>()
      const newRows: AlignRow[] = s.align.rows.map((r: AlignRow) => {
        const nid = alignRowNextId.current++; idMap.set(r.id, nid); return { ...r, id: nid }
      })
      setAlignRows(newRows)
      setActiveAlignRowId(s.align.activeRowId != null ? (idMap.get(s.align.activeRowId) ?? null) : null)
    }
    if (s.view && typeof s.db === 'string') {
      const p = new URLSearchParams(window.location.search)
      p.set('db', s.db)
      p.set('cx', String(s.view.cx)); p.set('cy', String(s.view.cy)); p.set('vw', String(s.view.vw))
      window.history.replaceState(null, '', '?' + p.toString())
    }
    if (typeof s.db === 'string') setSelectedDb(s.db)
  }

  // 毎レンダー再生成（現在の状態を読むため useCallback にしない）
  const saveCurrentState = async () => {
    const id = await saveSession(captureSnapshot())
    if (!id) { showHint('保存に失敗しました'); return }
    const p = new URLSearchParams(window.location.search)
    p.set('s', id)
    window.history.replaceState(null, '', '?' + p.toString())
    try { await navigator.clipboard.writeText(window.location.href) } catch {}
    showHint('状態を保存しました。現在のURL（クリップボードにコピー）で復元・共有できます。')
  }

  // 8.2 セッション JSON: 状態をそのままファイルに書き出す（サーバ不要・論文添付/バージョン管理向け）。
  const exportSessionJson = () => {
    const text = JSON.stringify(captureSnapshot(), null, 2)
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `amipa_session_${(selectedDb || 'view').replace(/[^\w.+-]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setShowExportMenu(false)
  }
  // セッション JSON を読み込んで適用。DB が手元に無ければ中断（applySnapshot は db 切替も行う）。
  const sessionFileRef = useRef<HTMLInputElement | null>(null)
  const importSessionJson = (file: File) => {
    const reader = new FileReader()
    reader.onerror = () => showHint('ファイルの読み込みに失敗しました')
    reader.onload = () => {
      try {
        const snap = JSON.parse(String(reader.result))
        if (!snap || typeof snap !== 'object') { showHint('セッション JSON の形式が不正です'); return }
        if (typeof snap.db === 'string' && databases.length > 0 && !databases.includes(snap.db)) {
          showHint(`このセッションの DB (${snap.db}) がこのサーバに見つかりません`); return
        }
        applySnapshot(snap)
        showHint('セッション JSON を読み込みました')
      } catch { showHint('セッション JSON の解析に失敗しました') }
    }
    reader.readAsText(file)
  }

  // 8.2 自己完結パーマリンク: 状態を deflate→base64url で URL(?st=) に埋め込む。サーバ session に依存せず
  // 別デプロイ間でも復元でき、図版の再現リンクとして論文に貼れる。長すぎる時はサーバ保存へフォールバック。
  const shareSelfContainedLink = async () => {
    setShowExportMenu(false)
    try {
      const enc = await encodeStateB64(captureSnapshot())
      const p = new URLSearchParams(window.location.search)
      p.delete('s'); p.set('st', enc)
      const href = `${window.location.origin}${window.location.pathname}?${p.toString()}`
      if (href.length > 30000) {   // 実用 URL 長を超えたらサーバ保存へ
        showHint('状態が大きく自己完結リンクにできないため、サーバ保存リンクにします…')
        await saveCurrentState()
        return
      }
      window.history.replaceState(null, '', '?' + p.toString())
      try { await navigator.clipboard.writeText(href) } catch {}
      showHint('自己完結リンクをコピーしました（サーバ保存不要・URL だけで復元）。')
    } catch (e) {
      showHint('リンク生成に失敗しました: ' + String(e))
    }
  }

  const applyDetailParams = useCallback(() => {
    const parts = detailParamInput.split(',')
    const px = parseInt(parts[0]?.trim(), 10)
    const rs = parseInt(parts[1]?.trim(), 10)
    if (!isNaN(px) && px > 0) setMaxEdgePx(px)
    if (!isNaN(rs) && rs > 0) setMaxEdgeReads(rs)
  }, [detailParamInput])

  // Surrounding panel sizes (px). Start collapsed so graph fills most of the area.
  const [topH,    setTopH]    = useState(0)
  const [bottomH, setBottomH] = useState(0)
  const [msaH,    setMsaH]    = useState(0)        // Bubble MSA 下部パネルの高さ(0=閉)
  const [rightW,  setRightW]  = useState(Math.round(window.innerWidth * 0.18))
  const [msaPick, setMsaPick] = useState(false)                 // ON: グラフのクリックで MSA 対象ノードを追加
  const [msaNodeSel, setMsaNodeSel] = useState<string[]>([])    // MSA 対象ノード名
  // MSA パネルで hover 中の列のノード群。列=アレル群(排他アレル複数)なので配列で受ける。
  const [msaHover, setMsaHover] = useState<string[] | null>(null)
  const msaHiSet = useMemo(() => new Set(msaNodeSel), [msaNodeSel])  // グラフ強調用
  const msaHoverSet = useMemo(() => (msaHover && msaHover.length ? new Set(msaHover) : null), [msaHover])

  useEffect(() => {
    fetch('/api/databases')
      .then(r => { if (!r.ok) throw new Error('Failed to fetch databases'); return r.json() as Promise<string[]> })
      .then(async dbs => {
        setDatabases(dbs)
        // ?st=<base64url> があれば自己完結スナップショットを復元（サーバ session 不要）。
        const stParam = new URLSearchParams(window.location.search).get('st')
        if (stParam) {
          try {
            const snap = await decodeStateB64(stParam)
            if (snap && typeof snap.db === 'string' && dbs.includes(snap.db)) { applySnapshot(snap); return }
          } catch { /* 壊れた ?st= は無視して通常初期化へ */ }
        }
        // ?s=id があればスナップショットを復元（db含む）
        const sid = new URLSearchParams(window.location.search).get('s')
        if (sid) {
          const snap = await loadSession(sid)
          if (snap && typeof snap.db === 'string' && dbs.includes(snap.db)) { applySnapshot(snap); return }
        }
        const urlDb = new URLSearchParams(window.location.search).get('db')
        const initial = (urlDb && dbs.includes(urlDb)) ? urlDb : (dbs[0] ?? null)
        setSelectedDb(initial)
      })
      .catch(e => setError(String(e)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync selected DB to URL
  useEffect(() => {
    if (!selectedDb) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('db') !== selectedDb) {
      params.set('db', selectedDb)
      window.history.replaceState(null, '', '?' + params.toString())
    }
    setMaxLayer(null); setDbIncompatible(null); setDbLegacy(false); setRibbonHapcov(false); setRibbonContig(false)
    setHapIdx(null); setHapFilter(false)   // 絞り込み可否/状態は DB ごとに再判定
    setLodClamp(null)
    setRefposAvail(false); setRefContigs(new Map()); setRefKey(null)
    setBandAvail(false); setRegionAvail(false); setGeneAvail(false)
    setBandMode(false); setRegionMode(false); setGeneMode(false)
    setBandDict(new Map()); setRegionDict(new Map()); setMaxGeneCount(1)
    annotDictsLoadedRef.current = null; geneFeaturesLoadedRef.current = null
    setShowBandLabels(false); setShowRegionMarks(false); setShowGeneLabels(false); setGeneFeatures([])
    setSelectedGene(null); setSelectedGeneExons([]); setSelectedNodeFeatures([]); setSearchQuery(''); setFindScope('node')
    setHbAvail(false); setMultAvail(false)   // A-2 表示ソース可否は DB ごとに再判定
    setPendingEdits([])   // DB切替で未保存編集は破棄
    fetchStats(selectedDb).then(s => {
      // 現行仕様の適合レベルで分岐。incompatible は表示せず通知、legacy は警告バナー付きで表示。
      if (s.spec === 'incompatible') { setDbIncompatible(s.reason ?? 'このDBは現行ビューアと互換性がありません'); return }
      setDbLegacy(s.spec === 'legacy')
      setHapIdx(s.hapidx ?? null)   // hap 絞り込み索引サイドカーの有無・諸元
      if (s.contigcov) {
        // contig 索引 DB: sample/hap/contig の全リボンを賄える（hap 索引の置換）。contig level を許可。
        setRibbonContig(true)
      } else if (s.hapcov) {
        setRibbonHapcov(true)
        // hapcov DB は contig 粒度を持たないため contig モードをリセット
        setRibbonLevel(prev => prev === 'contig' ? 'none' : prev)
      }
      // 参照座標トラック（ref_bp）: あれば contig_id→表示名/長さを取得し、bp 位置ラベルのトグルを有効化。
      if (s.refpos) {
        setRefposAvail(true)
        fetchRefContigs(selectedDb).then(r => {
          setRefKey(r.ref_key)
          setRefContigs(new Map(r.contigs.map(c => [c.contig_id, c])))
        }).catch(() => { /* 取得失敗時は id を数値表示にフォールバック */ })
      }
      // A-2 パス多重度(breadth=hb 列)/CNV(node_hap_mult)可否。トグルの表示条件に使う。
      setHbAvail(!!s.hbAvail)
      setMultAvail(!!s.multAvail)
      // アノテーション(band/gene/region)可否。あれば辞書と gene 密度スケールを取得。
      // ★ここでは **可否フラグだけ** 立てる。辞書と gene features の取得は
      //   「トラックを ON にした時」まで遅らせる（下の遅延取得 effect）。
      //   以前はここで無条件に取っていたが、/annot_dicts は WG cold で **13.9 秒**かかり、
      //   better-sqlite3 は同期実行なので **その間 backend のイベントループが完全に塞がる**。
      //   DB を開いた直後＝初期表示の取得が最も欲しい瞬間にそれをやっていたため、
      //   「初期表示が遅い/読み込み表示も出ずに一部が描かれない」の主因になっていた。
      setBandAvail(!!s.bandAvail); setRegionAvail(!!s.regionAvail); setGeneAvail(!!s.geneAvail)
      // LOD-A メタは maxLayer と同時にセット（GraphCanvas は maxLayer!==null で初めてマウントされるため）。
      // layer_zoom は emitter が実座標の局所密度から較正済みなので、あればそのまま使う。無い旧 DB のみ
      // layer_nodes から f(L)=(N_L/N_0)^(1/2) の冪則で近似（密度を測れないので粗い）。
      const ln = s.layer_nodes ?? []
      const lz = (s.layer_zoom && s.layer_zoom.length)
        ? s.layer_zoom
        : (ln.length ? ln.map(n => Math.pow((n || 1) / (ln[0] || 1), 0.5)) : [])
      setLodMeta({ layerZoom: lz, world: s.world ?? null, zoomWindow: s.zoom_window })
      setMaxLayer(s.maxLayer)
    }).catch(e => setDbIncompatible('stats を取得できません: ' + String(e)))
  }, [selectedDb])

  // Paths(=hb) エッジ太さのスケール上限は、Edge width=Paths を初めて使うときだけ DB ごと1回取得。
  const maxHbLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (edgeWidthMode !== 'paths' || !selectedDb || maxHbLoadedRef.current === selectedDb) return
    maxHbLoadedRef.current = selectedDb
    fetchMaxHb(selectedDb).then(v => { if (v > 0) setMaxHb(v) }).catch(() => {})
  }, [edgeWidthMode, selectedDb])

  // Resize handlers — each captures start state at mousedown
  function onTopHandleDown(e: React.MouseEvent) {
    const start = topH
    makeDragHandler(delta =>
      setTopH(Math.max(MIN_SIDE, Math.min(window.innerHeight - MIN_GRAPH, start + delta)))
    )(e)
  }
  function onBottomHandleDown(e: React.MouseEvent) {
    const start = bottomH
    makeDragHandler(delta =>
      setBottomH(Math.max(MIN_SIDE, Math.min(window.innerHeight - MIN_GRAPH, start - delta)))
    )(e)
  }
  function onMsaHandleDown(e: React.MouseEvent) {
    const start = msaH
    makeDragHandler(delta =>
      setMsaH(Math.max(MIN_SIDE, Math.min(window.innerHeight - MIN_GRAPH, start - delta)))
    )(e)
  }
  function onRightHandleDown(e: React.MouseEvent) {
    const start = rightW
    makeDragHandler(delta =>
      setRightW(Math.max(MIN_SIDE, Math.min(window.innerWidth - MIN_GRAPH, start - delta)))
    )(e)
  }
  function onLeftHandleDown(e: React.MouseEvent) {
    const start = leftW
    makeDragHandler(delta =>
      setLeftW(Math.max(180, Math.min(500, start + delta)))
    )(e)
  }

  function handleSearchSelect(node: NodeData) {
    graphRef.current?.navigateTo(node.xCoord, node.yCoord, node.id, node.layer)
    setSearchQuery(node.node_name)
    setShowSearchDropdown(false)
    setSelectedNode(node)
  }

  // 入力のコンティグ名（例 chrY / GRCh38#chrY）を contig_id へ解決。'#' 以降の末尾一致も許容。
  function resolveContigId(name: string): number | null {
    const n = name.trim().toLowerCase()
    if (!n) return null
    for (const c of refContigs.values()) {
      const cn = c.name.toLowerCase()
      if (cn === n || (cn.split('#').pop() ?? cn) === n) return c.contig_id
    }
    return null
  }

  // 選択ノードの遺伝子(サイドバー詳細)。node が変わるたび /node_features を取得。
  useEffect(() => {
    if (selectedNode && geneAvail && selectedDb)
      fetchNodeFeatures(selectedDb, selectedNode.node_name).then(setSelectedNodeFeatures).catch(() => setSelectedNodeFeatures([]))
    else setSelectedNodeFeatures([])
  }, [selectedNode, geneAvail, selectedDb])

  // サイドバー(選択ノードの遺伝子一覧)からのクリック: そのノードが既にその遺伝子を持つので、
  // **移動せずその場で hull(selectedGene)** を出す(重心 cx/cy へ navigateTo すると離れた位置に飛ぶため)。
  function selectGeneInPlace(name: string) {
    if (!selectedDb) return
    // 同じ遺伝子を再クリックしたらトグル解除(hull を消す)。
    if (selectedGene?.name === name) { clearSelectedGene(); return }
    const g = geneFeatures.find(x => x.name === name)
    setSelectedGene(g ? { start: g.start, end: g.end, name: g.name } : { start: 0, end: 0, name })
    fetchGeneExons(selectedDb, name).then(setSelectedGeneExons).catch(() => setSelectedGeneExons([]))
    showHint(`${name}${g?.strand ? ' (' + g.strand + ')' : ''} — hull 表示`)
  }

  // 遺伝子 hull(selectedGene のノード塗り+exon エッジ)を解除する。× ボタン/同一遺伝子の再クリックから。
  function clearSelectedGene() {
    setSelectedGene(null); setSelectedGeneExons([])
  }

  // 遺伝子名の候補列挙。完全一致 → 前方一致 → 部分一致 の順（同じ段の中では短い名前が先）。
  // ENSG… の安定 ID は名前で検索したい対象ではないので後ろへ回すが、明示的に "ENSG" で引いた
  // ときだけは普通に出す（以前は datalist から一律除外していたため、そもそも補完に出なかった）。
  // 遺伝子は WG でも 78,733 件（うち非 ENSG 43,440 件）と少なく、全件クライアント側に載っている
  // ので、ここは DB へ問い合わせずメモリ上で完結する。
  const GENE_MENU_MAX = 50
  function matchGenes(q: string, cap = GENE_MENU_MAX): GeneFeature[] {
    const s = q.trim().toLowerCase()
    if (!s) return []
    const wantEnsg = s.startsWith('ensg')
    const rank = (n: string): number => {
      const l = n.toLowerCase()
      if (l === s) return 0
      if (l.startsWith(s)) return 1
      if (l.includes(s)) return 2
      return 9
    }
    return geneFeatures
      .map(g => ({ g, r: rank(g.name), ensg: !wantEnsg && g.name.startsWith('ENSG') }))
      .filter(x => x.r < 9)
      .sort((a, b) =>
        Number(a.ensg) - Number(b.ensg) || a.r - b.r ||
        a.g.name.length - b.g.name.length || a.g.name.localeCompare(b.g.name))
      .slice(0, cap)
      .map(x => x.g)
  }

  // 遺伝子名で移動 + hull 選択(検索ボックス用)。cx/cy/layer(代表位置)へ navigateTo し selectedGene で hull。
  async function handleGeneGoto(name: string) {
    if (!selectedDb || !name.trim()) return
    const q = name.trim()
    // 以前は完全一致(＋大小無視の完全一致)だけで、部分一致では何も出なかった。
    // matchGenes で 完全一致→前方一致→部分一致 の順に候補を作り、その先頭を採る。
    const hits = matchGenes(q)
    const g = hits[0]
    if (!g) { showHint(`遺伝子「${q}」が見つかりません`); return }
    // 部分一致で複数当たったときは、他に何件あるかも伝える(候補一覧は入力欄の補完に出る)。
    const more = (hits.length > 1 && g.name.toLowerCase() !== q.toLowerCase())
      ? `  [${q} に ${hits.length} 件該当・補完から選択可]` : ''
    const bp = Math.round((g.start + g.end) / 2)
    const contigId = (g.chrom ? resolveContigId(g.chrom) : null)
      ?? (refContigs.size === 1 ? [...refContigs.values()][0].contig_id : null)
    setSelectedGene({ start: g.start, end: g.end, name: g.name })
    fetchGeneExons(selectedDb, g.name).then(setSelectedGeneExons).catch(() => setSelectedGeneExons([]))
    // 新フォーマット: feature_dict の cx/cy/layer(会員ノード重心+最粗層)へ直接移動 = ref_bp 全スキャン(/goto)を回避。
    // 巨大 DB(WG)で /goto は nodes 全走査になりイベントループを塞ぐため、これが必須。
    if (g.cx != null && g.cy != null) {
      graphRef.current?.navigateTo(g.cx, g.cy, null, g.layer ?? undefined)
      showHint(`${g.name} (${g.strand}) ${g.gtype ?? ''}${more}`)
      return
    }
    // 旧 DB(cx/cy 無し)フォールバック: ref_bp から /goto(小 DB のみ推奨)
    if (contigId == null) { showHint('コンティグを特定できません'); return }
    const node = await fetchGoto(selectedDb, contigId, bp).catch(() => null)
    if (node) { graphRef.current?.navigateTo(node.xCoord, node.yCoord, node.id, node.layer); setSelectedNode(node) }
    showHint(`${g.name} (${g.strand}) ${g.gtype ?? ''} → ${node ? node.node_name : '範囲外'}${more}`)
  }

  // region(CHM13 ランドマーク: acen=centromere 等)へ移動。region_dict の cx/cy/layer(代表位置=最粗層の
  // 会員ノード実位置)へ直接 navigateTo。CHM13 領域は GRCh38 ref_bp を持たない(=/goto 不可)ので、
  // cx/cy が無い旧 DB では移動先無しを通知する。gene goto と同型。
  function handleRegionGoto(r: RegionDictEntry) {
    if (!selectedDb) return
    if (r.cx != null && r.cy != null) {
      graphRef.current?.navigateTo(r.cx, r.cy, null, r.layer ?? undefined)
      showHint(`region「${r.name}」代表位置へ移動`)
      return
    }
    showHint(`region「${r.name}」: 代表位置が無く移動できません(旧 DB)`)
  }

  // A1 go-to-position: 「chr:bp」または（単一コンティグ時）「bp」を解釈し、該当ノードへ移動。
  async function handleGoto(rawQ: string) {
    if (!selectedDb) return
    const q = rawQ.trim()
    if (!q) return
    const ci = q.lastIndexOf(':')   // PanSN 名は '#' 区切りなので、最後の ':' が bp の区切り
    let contigId: number | null = null
    let bpStr = q
    if (ci >= 0) {
      const nm = q.slice(0, ci)
      contigId = resolveContigId(nm)
      bpStr = q.slice(ci + 1)
      if (contigId == null) { showHint(`コンティグ「${nm}」が見つかりません`); return }
    } else if (refContigs.size === 1) {
      contigId = [...refContigs.values()][0].contig_id
    } else {
      showHint('コンティグ名を指定してください（例 chrY:12,300,000）'); return
    }
    const bp = parseBpNumber(bpStr)
    if (bp == null) { showHint('位置を解釈できません（例 chrY:12,300,000 / 12.3Mb）'); return }
    const node = await fetchGoto(selectedDb, contigId, bp).catch(() => null)
    if (!node) { showHint('該当位置のノードが見つかりません'); return }
    graphRef.current?.navigateTo(node.xCoord, node.yCoord, node.id, node.layer)
    setSelectedNode(node)
    const cn = refContigs.get(Number(node.ref_contig_id))?.name ?? `#${node.ref_contig_id}`
    showHint(`${cn}:${bp.toLocaleString()} 付近 → ${node.node_name}`)
  }

  async function handleSearch() {
    const q = searchQuery.trim()
    if (!q || !selectedDb) return
    setSearchStatus('searching')
    setShowSearchDropdown(false)
    let results: NodeData[]
    try {
      results = await searchNodes(q, selectedDb)
    } catch (e) {
      console.error('search error:', e)
      setSearchStatus('notfound')
      return
    }
    if (results.length === 0) { setSearchStatus('notfound'); return }

    // 名前長の短い順 → 同長はアルファベット順
    results.sort((a, b) =>
      a.node_name.length - b.node_name.length || a.node_name.localeCompare(b.node_name)
    )

    setSearchStatus('idle')
    setSearchResults(results)
    setShowSearchDropdown(true)
  }

  // 統合 Find: scope に応じて検索/移動を分岐（入力は共用の searchQuery）。
  function submitFind() {
    if (findScope === 'node') handleSearch()
    else if (findScope === 'pos') handleGoto(searchQuery)
    else handleGeneGoto(searchQuery)
  }

  // 8.3 Export: 現ビューポートの部分グラフを GFA / ノード集合を BED でダウンロード（backend /export/*）。
  // GFA は葉(=配列を持つ maxLayer)、BED は表示中の層(mapLayer)。Content-Disposition で実ファイル DL。
  function exportRegion(kind: 'gfa' | 'bed') {
    if (!selectedDb) return
    const vp = mapViewport
    const layer = kind === 'gfa' ? (maxLayer ?? mapLayer) : mapLayer
    const p = new URLSearchParams({
      db: selectedDb, layer: String(layer),
      x1: String(vp.x1), y1: String(vp.y1), x2: String(vp.x2), y2: String(vp.y2),
    })
    const a = document.createElement('a')
    a.href = `/api/export/${kind}?${p.toString()}`
    document.body.appendChild(a); a.click(); a.remove()
    setShowExportMenu(false)
  }

  // ── ツールバー共通の描画ヘルパ（多数の同型ボタンを DRY 化）──
  // トグルボタン: active でアクセント色に反転。
  const toggleBtn = (active: boolean, onClick: () => void, label: React.ReactNode,
                     accent = '#1971c2', bg = '#e7f5ff', title?: string) => (
    <button onClick={onClick} title={title} style={{
      fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px', border: '1px solid',
      borderColor: active ? accent : '#adb5bd', borderRadius: 4,
      background: active ? bg : '#f8f9fa', color: active ? accent : '#495057',
      cursor: 'pointer', fontWeight: active ? 600 : 400, whiteSpace: 'nowrap',
    }}>{label}</button>
  )
  // グループ間の細い縦仕切り（折り返しても関係が読み取れるように）。
  const divider = () => <span style={{ alignSelf: 'stretch', width: 1, background: '#e9ecef', margin: '2px 0' }} />
  // Labels ポップオーバー内の 1 行トグル。
  const labelRow = (label: string, active: boolean, onClick: () => void, title?: string) => (
    <button onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
      padding: '4px 8px', border: '1px solid', borderColor: active ? '#1971c2' : '#e9ecef',
      borderRadius: 4, background: active ? '#e7f5ff' : '#fff', color: active ? '#1971c2' : '#495057',
      cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: active ? 600 : 400,
    }}><span style={{ width: 12, textAlign: 'center' }}>{active ? '✓' : ''}</span>{label}</button>
  )
  const anyLabelOn = showNodeNames || showNodeBp || seqMode || showRefPos || coverageTextMode || cnvMode !== 'off'

  if (error) return (
    <div style={{ color: '#c0392b', padding: 20, fontFamily: 'monospace' }}>Error: {error}</div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: '#f0f2f5' }}>

      {/* ── Toolbar ───────────────────────────────────────────────── */}
      {/* ボタンが多く1行に収まらない時は、48px 固定で下（canvas 上）にはみ出すのではなく
          折り返して縦に伸ばす（flexWrap + minHeight, 固定 height を外す）。はみ出したボタンの
          当たり判定がグラフを覆ってノードを掴めなくなる不具合を防ぐ。
          （overflow:hidden は検索候補ドロップダウンを切ってしまうので付けない） */}
      <div style={{
        minHeight: 48, flexShrink: 0,
        background: '#ffffff', borderBottom: '1px solid #e0e0e0',
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', padding: '4px 16px', gap: 8,
        position: 'relative', zIndex: 50,
      }}>
        <label htmlFor="db-select" style={{ fontFamily: 'sans-serif', fontSize: 14, color: '#333', whiteSpace: 'nowrap' }}>
          Database:
        </label>
        <select
          id="db-select"
          value={selectedDb ?? ''}
          onChange={e => setSelectedDb(e.target.value)}
          style={{ fontFamily: 'sans-serif', fontSize: 14, padding: '3px 8px' }}
        >
          {databases.map(db => <option key={db} value={db}>{db}</option>)}
        </select>

        {/* 版表示: viewer(git rev) と 選択 DB のビルド由来 + 機能フラグ。staleness/機能有無の確認用。 */}
        {versionInfo && (
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#868e96', whiteSpace: 'nowrap',
            display: 'inline-flex', alignItems: 'center', gap: 8 }}
            title={'viewer=git rev / db=ビルド時刻・emitter rev・含む機能(seq/inv/mult)'
              + (versionInfo.db?.rtree_built_at
                ? `\nR-Tree(描画の高速経路が読む実体): ${versionInfo.db.rtree_built_at}`
                  + `\nrad 列: ${versionInfo.db.rad
                    ? 'あり (radius は真値)'
                    : 'なし → radius を矩形から導出＝深層で過大。ノード/エッジがリボンに対してずれる'}`
                : '')}>
            <span>viewer <b style={{ color: '#495057' }}>{versionInfo.viewer}</b></span>
            {/* 使い方。★この版に固定した URL を作る（docsLink.ts）。動いているビルドと
                説明が食い違わないため。外部サイトが開くので別タブにする。 */}
            <a
              href={docsUrl('viewer', versionInfo.viewer)}
              target="_blank" rel="noreferrer"
              title="使い方を開く（この版のドキュメント。GitHub が別タブで開きます）"
              style={{
                fontFamily: 'sans-serif', fontSize: 11, lineHeight: '14px', fontWeight: 700,
                width: 16, height: 16, borderRadius: 8, textAlign: 'center',
                border: '1px solid #adb5bd', color: '#495057', textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}
            >?</a>
            {/* ★速いときは何も出さない（常時出ていると意味を失う）。遅くなる設定を
                自分で入れている間だけ、**何が原因で・どうすれば戻るか**を出す。 */}
            {!fastPath.on && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                color: '#e8590c', fontWeight: 600, fontFamily: 'sans-serif' }}
                title={'この設定はノード 1 個ずつの詳細を読む必要があるため、'
                  + '大きいグラフの深いズームでは表示に時間がかかります。'
                  + '解除すると描画用の索引だけを読む速い経路に戻ります。'}>
                ⚠ 表示が遅くなる設定:
                {fastPath.cause === 'nodebp' ? 'Node bp' : 'Proximity'}
                <button
                  onClick={() => { if (fastPath.cause === 'nodebp') setShowNodeBp(false)
                                   else { setFloodMode(false); setFloodResult(null); setFloodSeedComp(null) } }}
                  style={{ fontSize: 11, padding: '1px 8px', cursor: 'pointer', borderRadius: 3,
                    border: '1px solid #e8590c', background: '#fff4e6', color: '#e8590c',
                    fontFamily: 'sans-serif', fontWeight: 600 }}>
                  解除して速くする
                </button>
              </span>
            )}
            {versionInfo.db && (
              <span>db <b style={{ color: '#495057' }}>{versionInfo.db.built_at ?? (versionInfo.db.mtime?.slice(0, 16).replace('T', ' ') ?? '?')}</b>
                {versionInfo.db.emitter_rev ? ` @${versionInfo.db.emitter_rev}` : ''}
                {/* ★R-Tree は built_at とは別に作り直されることがある（hapidx だけ回した場合）。
                    描画の高速経路が読む実体はこちらなので、built_at と食い違うときだけ併記する。
                    rad 無し = radius を矩形から導出＝深層で相対 174% 過大なので赤で警告する。 */}
                {versionInfo.db.rtree_built_at
                  && versionInfo.db.rtree_built_at !== versionInfo.db.built_at && (
                  <> rtree <b style={{ color: '#495057' }}>{versionInfo.db.rtree_built_at}</b></>
                )}
                {versionInfo.db.rad === false && <b style={{ color: '#c92a2a' }}> ⚠rad無</b>}
                {/* プリウォーム: DB を開くと backend が順読みでページキャッシュに載せる。
                    終わるまでビューポート取得は cold（1 枚 1-4 秒）、終われば 9ms 台になる。 */}
                {/* アノテーション辞書の取得中。WG では cold で 14 秒かかるうえ backend が
                    同期実行なのでその間ほぼ無反応になる。黙って固まらないよう明示する。 */}
                {annotLoading && (
                  <b style={{ color: '#e8590c' }} title={
                    'アノテーション辞書を取得しています。WG では十数秒かかることがあります。'}>
                    {' ⏳annot'}
                  </b>
                )}
                {prewarm && (prewarm.running || prewarm.finished) && (
                  <b style={{ color: prewarm.finished ? '#2b8a3e' : '#e8590c' }} title={
                    'DB ファイルを順読みしてページキャッシュに載せています。\n'
                    + 'これが終わるまで表示範囲の取得は cold（1 枚あたり 1〜4 秒）で、\n'
                    + '終わると同じ範囲が 10 ミリ秒程度になります（実測 98 倍）。\n'
                    + '進行中は他の取得が 1.4 倍ほど遅くなります。'}>
                    {prewarm.finished
                      ? ' ✓warm'
                      : ` ⏳warm ${Math.floor(100 * prewarm.done / Math.max(1, prewarm.total))}%`
                        + (prewarm.rate > 0 ? ` ${(prewarm.rate / 1e9).toFixed(1)}GB/s` : '')}
                  </b>
                )}
                {' ['}{(['seq', 'inv', 'mult'] as const).filter(f => versionInfo.db!.features[f]).join(' ') || '—'}{']'}
              </span>
            )}
          </span>
        )}

        {/* 統合 Find: 検索対象（Node / Position / Gene）を左のセレクタで切替、入力・Go は共用 */}
        <div ref={searchWrapRef} style={{ position: 'relative', marginLeft: 16, display: 'flex', gap: 0 }}>
          <select
            value={findScope}
            onChange={e => { setFindScope(e.target.value as 'node' | 'pos' | 'gene'); setShowSearchDropdown(false); setSearchStatus('idle') }}
            title="検索対象を選択"
            style={{ fontFamily: 'sans-serif', fontSize: 13, padding: '4px 6px',
              border: '1px solid #adb5bd', borderRight: 'none', borderRadius: '4px 0 0 4px',
              background: '#f1f3f5', color: '#495057', outline: 'none', cursor: 'pointer' }}
          >
            <option value="node">Node</option>
            {refposAvail && <option value="pos">Position</option>}
            {geneAvail && <option value="gene">Gene</option>}
          </select>
          <input
            type="text"
            list={findScope === 'gene' ? 'geneGotoList' : undefined}
            placeholder={findScope === 'node' ? 'Search node name…'
              : findScope === 'pos' ? 'chr:bp (e.g. chrY:12,300,000)'
              : 'Gene name (e.g. UTY)'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitFind()}
            style={{ fontFamily: findScope === 'pos' ? 'monospace' : 'sans-serif', fontSize: 13,
              padding: '4px 10px', width: 200,
              border: '1px solid #adb5bd', borderRadius: 0, outline: 'none' }}
          />
          <button
            onClick={submitFind}
            disabled={searchStatus === 'searching'}
            style={{ padding: '4px 10px', fontFamily: 'sans-serif', fontSize: 13,
              background: '#f1f3f5', border: '1px solid #adb5bd', borderLeft: 'none',
              borderRadius: '0 4px 4px 0', cursor: searchStatus === 'searching' ? 'default' : 'pointer',
              color: '#495057', whiteSpace: 'nowrap' }}
          >
            {searchStatus === 'searching' ? '…' : 'Go'}
          </button>
          {/* 補完候補は入力に応じて動的に作る。以前は「非 ENSG の先頭 3000 件」を固定で出しており、
              WG(非 ENSG 43,440 件)では **候補の約 93% が出てこなかった**（正確な名前を打てば当たる
              ので機能不全ではないが、実質「知っている遺伝子しか引けない」状態だった）。
              入力で絞ってから上位 GENE_MENU_MAX 件だけ描くので、全件を対象にしつつ DOM は軽い。 */}
          {geneAvail && findScope === 'gene' && (
            <datalist id="geneGotoList">
              {matchGenes(searchQuery).map(g => (
                <option key={g.name} value={g.name} />
              ))}
            </datalist>
          )}
          {searchStatus === 'notfound' && (
            <span style={{ marginLeft: 6, fontSize: 12, color: '#e03131',
              fontFamily: 'sans-serif', whiteSpace: 'nowrap', alignSelf: 'center' }}>
              Not found
            </span>
          )}
          {findScope === 'node' && showSearchDropdown && searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 2, zIndex: 200,
              background: '#fff', border: '1px solid #dee2e6', borderRadius: 4,
              boxShadow: '0 4px 12px rgba(0,0,0,0.12)', minWidth: 240, maxHeight: 240, overflowY: 'auto',
            }}>
              {searchResults.map(n => (
                <div
                  key={n.id}
                  onMouseDown={() => handleSearchSelect(n)}
                  style={{ padding: '5px 12px', fontFamily: 'sans-serif', fontSize: 13, cursor: 'pointer',
                    borderBottom: '1px solid #f1f3f5', color: '#333',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <span style={{ wordBreak: 'break-all' }}>{n.node_name}</span>
                  {n.layer !== undefined && (
                    <span style={{ fontSize: 11, color: '#adb5bd', whiteSpace: 'nowrap' }}>
                      L{n.layer}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
          {/* ── Edge width: エッジ太さに乗せる量（排他・一度に1つ）── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'sans-serif', fontSize: 13 }}>
            <span style={{ color: '#495057', whiteSpace: 'nowrap' }}
              title="エッジの太さに乗せる量を1つ選ぶ。Paths=通過ハプロタイプ数（パス多重度）/ Reads=ノードをまたぐリード数（read_support）">Edge width</span>
            <div style={{ display: 'flex', border: '1px solid #adb5bd', borderRadius: 4, overflow: 'hidden' }}>
              {([
                { key: 'off' as const, label: 'Off', accent: '#495057', show: true,
                  hint: '' },
                { key: 'paths' as const, label: 'Paths', accent: '#0b3d91', show: hbAvail,
                  hint: 'エッジ太さ = 通過ハプロタイプ数（パス多重度 = distinct haplotype 数）。太い=多い。ノード色は不変。' },
                { key: 'reads' as const, label: 'Reads', accent: '#e67700', show: true,
                  hint: 'エッジ太さ = ノードをまたぐリード数（read_support）。「px,reads」で最大幅と基準リード数を指定（例 10,100 = 100リードで10px）。' },
              ].filter(s => s.show)).map((s, i) => {
                const active = edgeWidthMode === s.key
                return (
                  <button key={s.key}
                    onClick={() => { setEdgeWidthMode(active ? 'off' : s.key); if (!active && s.hint) showHint(s.hint) }}
                    title={s.hint || 'エッジ太さを使わない'}
                    style={{ padding: '4px 12px', border: 'none', borderLeft: i === 0 ? 'none' : '1px solid #dee2e6',
                      fontFamily: 'sans-serif', fontSize: 13, cursor: 'pointer',
                      background: active ? s.accent : '#f8f9fa', color: active ? '#fff' : '#495057',
                      fontWeight: active ? 600 : 400 }}>
                    {s.label}
                  </button>
                )
              })}
            </div>
            {edgeWidthMode === 'reads' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: '#e67700', whiteSpace: 'nowrap' }}>px,reads:</span>
                <input
                  type="text"
                  value={detailParamInput}
                  onChange={e => setDetailParamInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyDetailParams() }}
                  onBlur={applyDetailParams}
                  style={{ width: 72, padding: '3px 6px', fontFamily: 'monospace', fontSize: 12,
                    border: '1px solid #e67700', borderRadius: 4, outline: 'none',
                    background: '#fff4e6', color: '#e67700' }}
                />
              </span>
            )}
          </div>
          {divider()}
          {/* ── Tools: 選択・近接・アライン連動 ── */}
          {toggleBtn(nodeGreyMode,
            () => setNodeGreyMode(m => { if (!m) showHint('パスを選択した状態でONにすると、パスに含まれないノードをグレー表示します。'); return !m }),
            'Dim off-path', '#1971c2', '#e7f5ff', 'パス選択時、パスに含まれないノードを淡色化する')}
          {toggleBtn(floodMode,
            () => setFloodMode(m => {
              const nm = !m
              if (!nm) { setFloodResult(null); setFloodSeedComp(null) }
              else showHint('ノードをクリックすると、そこからグラフ距離が近いグリフを着色します（濃青=近い→淡青=D手、同一成分の未到達=青灰＝連結だが遠い、別成分=灰＝ただ近接）。融合か近接かの確認に。背景クリックで解除。')
              return nm
            }),
            'Proximity', '#1971c2', '#e7f5ff', 'ONにしてノードをクリック→グラフ距離が近いグリフを着色（融合か近接かの確認）')}
          {floodMode && (
            <span style={{ fontFamily: 'sans-serif', fontSize: 12, color: '#495057', display: 'flex', alignItems: 'center', gap: 4 }}>
              距離
              <input type="number" min={1} max={50} step={1} value={floodHopsInput}
                title="到達とみなす最大手数 D（この層の super-edge の hop 数）。Enter/フォーカス外で確定"
                onChange={e => setFloodHopsInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                onBlur={() => {
                  // 確定時のみ 1 回だけ再描画＋再フラッド（毎ティック再描画による WebGL コンテキスト喪失=黒画面を防ぐ）。
                  const v = Math.max(1, Math.min(50, parseInt(floodHopsInput, 10) || 10))
                  setFloodHops(v); setFloodHopsInput(String(v))
                  // D は BFS 深さ＝到達集合が変わるので、直近クリックノードから再フラッド（未クリックなら次クリックで反映）。
                  if (floodMode && selectedNode && selectedDb) {
                    fetchFlood(selectedDb, mapLayer, selectedNode.node_name, v).then(r => {
                      if (r) { setFloodResult(new Map(r.reached.map(x => [x.name, x.hop]))); setFloodSeedComp(selectedNode.comp_id ?? null) }
                    })
                  }
                }}
                style={{ width: 44, fontSize: 12, padding: '2px 4px' }} />
              手
            </span>
          )}
          {(bandAvail || regionAvail || geneAvail) && divider()}
          {/* ── Color (node fill): 既定=ハプロタイプ / アノテ着色（Band/Region/Gene × Color/Label）── */}
          {(bandAvail || regionAvail || geneAvail) && (() => {
            // アノテのトグルを Band/Region/Gene 列 × Color(塗り)/Label(テキスト) 行のグリッドに集約。
            // Color 行は node fill が単値なので相互排他。Label 行は併用可。
            const cols = ([
              bandAvail && { name: 'Band', accent: '#c92a2a',
                fill: [bandMode, () => setBandMode(m => { const v = !m; if (v) { setRegionMode(false); setGeneMode(false) } return v })] as const,
                text: [showBandLabels, () => setShowBandLabels(v => !v)] as const,
                cT: 'Color nodes by cytoBand stain (acen = centromere)', tT: 'Overlay cytoBand names (e.g. Yq11.221)' },
              regionAvail && { name: 'Region', accent: '#e8590c',
                fill: [regionMode, () => setRegionMode(m => { const v = !m; if (v) { setBandMode(false); setGeneMode(false) } return v })] as const,
                text: [showRegionMarks, () => setShowRegionMarks(v => !v)] as const,
                cT: 'Color nodes by CHM13 region (centromere / satellite)', tT: 'Overlay region landmark names' },
              geneAvail && { name: 'Gene', accent: '#6741d9',
                fill: [geneMode, () => setGeneMode(m => { const v = !m; if (v) { setBandMode(false); setRegionMode(false) } return v })] as const,
                text: [showGeneLabels, () => setShowGeneLabels(v => !v)] as const,
                cT: 'Color nodes by gene density (coarse-zoom overview)', tT: 'Overlay gene names (strand arrow)' },
            ].filter(Boolean)) as { name: string; accent: string; fill: readonly [boolean, () => void]; text: readonly [boolean, () => void]; cT: string; tT: string }[]
            const cellBtn = (active: boolean, onClick: () => void, accent: string, title: string) => (
              <button onClick={onClick} title={title} style={{
                width: '100%', fontFamily: 'sans-serif', fontSize: 12, padding: '1px 0', border: '1px solid',
                borderColor: active ? accent : '#ced4da', borderRadius: 3, lineHeight: '15px',
                background: active ? accent : '#f8f9fa', color: active ? '#fff' : '#adb5bd',
                cursor: 'pointer', fontWeight: 700 }}>{active ? '✓' : '·'}</button>
            )
            const hdr: React.CSSProperties = { fontSize: 10, textAlign: 'center', fontWeight: 700 }
            const rl: React.CSSProperties = { fontSize: 10, color: '#868e96', paddingRight: 4, whiteSpace: 'nowrap' }
            return (
              <div style={{ display: 'inline-grid', gridTemplateColumns: `auto repeat(${cols.length}, 42px)`,
                gap: '2px 4px', alignItems: 'center', border: '1px solid #dee2e6', borderRadius: 4,
                padding: '3px 8px', marginLeft: 6 }}
                title="Annotation tracks — Color row = node fill (exclusive); Label row = text overlays (combinable)">
                <span style={{ fontSize: 10, color: '#495057', fontWeight: 700 }}>Annot</span>
                {cols.map(c => <span key={c.name} style={{ ...hdr, color: c.accent }}>{c.name}</span>)}
                <span style={rl}>Color</span>
                {cols.map(c => <span key={c.name}>{cellBtn(c.fill[0], c.fill[1], c.accent, c.cT)}</span>)}
                <span style={rl}>Label</span>
                {cols.map(c => <span key={c.name}>{cellBtn(c.text[0], c.text[1], c.accent, c.tT)}</span>)}
              </div>
            )
          })()}
          {divider()}
          {/* ── Labels: テキスト重畳をまとめたポップオーバー（併用可）── */}
          <div ref={labelsMenuRef} style={{ position: 'relative' }}>
            {toggleBtn(anyLabelOn, () => setShowLabelsMenu(v => !v), 'Labels ▾', '#1971c2', '#e7f5ff',
              'ノード名・塩基・参照bp・深度数値・CNV などのテキスト重畳をまとめて切替')}
            {showLabelsMenu && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 200,
                background: '#fff', border: '1px solid #dee2e6', borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 8, display: 'flex',
                flexDirection: 'column', gap: 6, minWidth: 190 }}>
                {/* 全ラベル一括サイズ: ref bp・ノード名・遺伝子・バンド等すべてに効く */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#495057',
                  paddingBottom: 6, borderBottom: '1px solid #f1f3f5' }}>
                  <span style={{ whiteSpace: 'nowrap', flex: 1 }}>Label size</span>
                  <button onClick={() => bumpLabelScale(1 / 1.15)} title="小さく"
                    style={{ width: 22, height: 22, padding: 0, cursor: 'pointer',
                      border: '1px solid #adb5bd', borderRadius: 4, background: '#f8f9fa', color: '#495057' }}>−</button>
                  <span onClick={() => setLabelScale(1)} title="クリックで標準(1×)に戻す"
                    style={{ width: 40, textAlign: 'center', cursor: 'pointer', userSelect: 'none',
                      fontVariantNumeric: 'tabular-nums' }}>{labelScale.toFixed(2)}×</span>
                  <button onClick={() => bumpLabelScale(1.15)} title="大きく"
                    style={{ width: 22, height: 22, padding: 0, cursor: 'pointer',
                      border: '1px solid #adb5bd', borderRadius: 4, background: '#f8f9fa', color: '#495057' }}>＋</button>
                </div>
                {/* ノード上ラベル(名前/bp/深度)の色と、ノード外へずらすオフセット。ノードに被って読みにくい時に */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#495057' }}>
                  <span style={{ whiteSpace: 'nowrap', flex: 1 }}
                    title="ノード上ラベル(名前/bp/深度)の文字色。明度に応じて白/黒のフチが自動で付く">Label color</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {['#111111', '#ffffff', '#e03131', '#1971c2', '#2f9e44', '#e8590c', '#7048e8'].map(c => {
                      const sel = labelColor.toLowerCase() === c
                      return (
                        <button key={c} onClick={() => setLabelColor(c)} title={c}
                          style={{ width: 16, height: 16, padding: 0, cursor: 'pointer', borderRadius: 3,
                            background: c, border: sel ? '2px solid #1971c2' : '1px solid #ced4da',
                            boxShadow: c === '#ffffff' ? 'inset 0 0 0 1px #dee2e6' : 'none' }} />
                      )
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#495057',
                  paddingBottom: 6, borderBottom: '1px solid #f1f3f5' }}>
                  <span style={{ whiteSpace: 'nowrap', flex: 1 }}
                    title="ノード上ラベルを上方向へずらす px。0=ノード中心、大きくするとノード外へ">Label offset</span>
                  <button onClick={() => setLabelOffset(v => Math.max(0, v - 6))} title="下げる(ノードへ寄せる)"
                    style={{ width: 22, height: 22, padding: 0, cursor: 'pointer',
                      border: '1px solid #adb5bd', borderRadius: 4, background: '#f8f9fa', color: '#495057' }}>−</button>
                  <span onClick={() => setLabelOffset(0)} title="クリックで0(ノード中心)に戻す"
                    style={{ width: 40, textAlign: 'center', cursor: 'pointer', userSelect: 'none',
                      fontVariantNumeric: 'tabular-nums' }}>{labelOffset}px</span>
                  <button onClick={() => setLabelOffset(v => Math.min(120, v + 6))} title="上げる(ノード外へ)"
                    style={{ width: 22, height: 22, padding: 0, cursor: 'pointer',
                      border: '1px solid #adb5bd', borderRadius: 4, background: '#f8f9fa', color: '#495057' }}>＋</button>
                </div>
                {labelRow('Node names', showNodeNames, () => setShowNodeNames(v => !v),
                  'マップ上のノードにノード名を表示')}
                {labelRow('Node bp', showNodeBp, () => setShowNodeBp(v => !v),
                  'ノードの塩基数(bp)を表示。クラスタは配下の合計 bp（必要に応じ K/M 単位）')}
                {seqAvail && labelRow('Bases (A/C/G/T)', seqMode,
                  () => setSeqMode(v => { if (!v) showHint('画面内の 1bp ノードにその塩基(A/C/G/T)をノード内表示します。より長い葉はノード選択時に右パネルで配列を確認できます。'); return !v }),
                  '画面内の小さい葉(現状 1bp)の塩基をノード内に表示。長い葉は選択時のみ右パネル')}
                {refposAvail && labelRow(`Ref bp position${refKey ? ` (${refKey})` : ''}`, showRefPos,
                  () => setShowRefPos(v => !v), '参照上の概算 bp 位置を代表ノード近傍にラベル表示')}
                {labelRow('Depth number', coverageTextMode,
                  () => setCoverageTextMode(m => { if (!m) showHint('ズームインしてノード幅が20px以上になると、ノード上に深度(リード数)の数値を表示します。'); return !m }),
                  'ズームイン時、ノード上に深度(リード数)の数値を表示')}
                {multAvail && (
                  <>
                    <span style={{ fontSize: 10, color: '#868e96', paddingTop: 2 }}>Copy number (CNV)</span>
                    {(['all', 'diff'] as const).map(mode => (
                      <Fragment key={mode}>
                        {labelRow(
                          (mode === 'all' ? 'All units' : 'Diff only') + (cnvMode === mode && cnvSuppressed ? ' ⚠' : ''),
                          cnvMode === mode,
                          () => setCnvMode(m => {
                            const next = m === mode ? 'off' : mode
                            if (next !== 'off' && ribbonSel.size === 0)
                              showHint('CNV 表示はパスリボンで比較したいサンプル/ハプロタイプを選択してから使ってください。')
                            else if (next === 'diff') showHint('選択ユニット間でコピー数が異なるノードだけにコピー数を表示します（隠れ CNV 発見用）。')
                            else if (next === 'all') showHint('選択ユニット全ての各ノードのコピー数をリボン同色で表示します。')
                            return next
                          }),
                          mode === 'all' ? '選択ユニット全ての per-node コピー数をリボン同色テキストで表示'
                            : '選択ユニット間でコピー数が異なるノードのみコピー数を表示(隠れ CNV)'
                        )}
                      </Fragment>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          {toggleBtn(showAlignColors, () => setShowAlignColors(v => { alignColorsUserOff.current = v; return !v }), 'Link colors', '#0c8599', '#e6fcf5',
            'アラインビューの各ノードを色分けし、マップ上の該当ノードも同色で塗る')}
          {divider()}
          {/* ── View: ノードサイズ・パネル・共有 ── */}
          {/* ノードサイズ倍率: 長さ(長軸=半径)にかける係数。厚み(短軸)は画面上一定なので長さのみ変わる。
              スライダーはドラッグ中 draft のみ更新し、離した時(onMouseUp/onKeyUp)に確定＝重い再描画を待たせる。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'sans-serif', fontSize: 13, color: '#495057' }}>
            <span onClick={() => applyNodeScale(1)} title="ノードの長さ(長軸=半径)にかける倍率。厚みは一定。クリックで標準(1×)に戻す"
              style={{ whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}>Node size</span>
            <button onClick={() => applyNodeScale(nodeScale / 1.25)}
              title="小さく" style={{ width: 22, height: 22, padding: 0, cursor: 'pointer',
                border: '1px solid #adb5bd', borderRadius: 4, background: '#f8f9fa', color: '#495057' }}>−</button>
            <input type="range" min={0} max={100}
              value={Math.round(100 * Math.log(nodeScaleDraft / NODE_SCALE_MIN) / Math.log(NODE_SCALE_MAX / NODE_SCALE_MIN))}
              onChange={e => setNodeScaleDraft(NODE_SCALE_MIN * Math.pow(NODE_SCALE_MAX / NODE_SCALE_MIN, Number(e.target.value) / 100))}
              onMouseUp={() => setNodeScale(nodeScaleDraft)}
              onKeyUp={() => setNodeScale(nodeScaleDraft)}
              onTouchEnd={() => setNodeScale(nodeScaleDraft)}
              style={{ width: 84 }} />
            <button onClick={() => applyNodeScale(nodeScale * 1.25)}
              title="大きく" style={{ width: 22, height: 22, padding: 0, cursor: 'pointer',
                border: '1px solid #adb5bd', borderRadius: 4, background: '#f8f9fa', color: '#495057' }}>＋</button>
            <span style={{ width: 36, textAlign: 'right', whiteSpace: 'nowrap' }}>{nodeScaleDraft.toFixed(nodeScaleDraft < 1 ? 2 : 1)}×</span>
          </div>
          <button
            onClick={saveCurrentState}
            title="現在の表示状態（ビュー・各トグル・アラインメント構成）を保存し、共有可能なURLにする"
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px',
              border: '1px solid #adb5bd', borderRadius: 4,
              background: '#f8f9fa', color: '#495057', cursor: 'pointer',
            }}
          >
            Share view
          </button>
          {/* 8.3 Export: 現ビューポートの部分グラフ/ノードをファイル書き出し */}
          <div ref={exportMenuRef} style={{ position: 'relative' }}>
            <button onClick={() => setShowExportMenu(v => !v)}
              title="表示中の部分グラフ/ノードをファイルに書き出す（GFA・BED）"
              style={{ fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px', border: '1px solid',
                borderColor: showExportMenu ? '#1971c2' : '#adb5bd', borderRadius: 4,
                background: showExportMenu ? '#e7f5ff' : '#f8f9fa', color: showExportMenu ? '#1971c2' : '#495057',
                cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Export ▾
            </button>
            {showExportMenu && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 200,
                background: '#fff', border: '1px solid #dee2e6', borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 8, display: 'flex',
                flexDirection: 'column', gap: 6, minWidth: 230 }}>
                <span style={{ fontSize: 10, color: '#868e96' }}>現ビューポート範囲を書き出し</span>
                <button onClick={() => { graphRef.current?.exportSvg(); setShowExportMenu(false) }} disabled={!selectedDb}
                  title="現在の表示をベクタ図版(SVG・レイヤ付き・物理寸法 180mm)で書き出し"
                  style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #e9ecef', borderRadius: 4,
                    background: '#fff', color: '#7048e8', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: 600 }}>
                  Figure SVG (view)
                </button>
                <button onClick={() => exportRegion('gfa')} disabled={!selectedDb}
                  title="視野の葉ノード＋エッジ＋配列を GFA で（他ツールへの入口＝相互引用）"
                  style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #e9ecef', borderRadius: 4,
                    background: '#fff', color: '#0c8599', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: 600 }}>
                  Subgraph GFA
                </button>
                {refposAvail && (
                  <button onClick={() => exportRegion('bed')} disabled={!selectedDb}
                    title={`視野のノードを参照(${refKey ?? 'ref'})座標の BED6 で`}
                    style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #e9ecef', borderRadius: 4,
                      background: '#fff', color: '#0c8599', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: 600 }}>
                    Nodes BED ({refKey ?? 'ref'})
                  </button>
                )}
                <span style={{ fontSize: 10, color: '#adb5bd', borderTop: '1px solid #f1f3f5', paddingTop: 4 }}>
                  MSA / アレル表はバブル選択→MSA パネルの Export から
                </span>
                <span style={{ fontSize: 10, color: '#868e96', borderTop: '1px solid #f1f3f5', paddingTop: 4 }}>状態（セッション）</span>
                <button onClick={shareSelfContainedLink} disabled={!selectedDb}
                  title="現在の表示状態を URL 自体に圧縮埋め込みしたリンクをコピー（サーバ保存不要・別環境でも復元）"
                  style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #e9ecef', borderRadius: 4,
                    background: '#fff', color: '#495057', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: 600 }}>
                  自己完結リンクをコピー
                </button>
                <button onClick={exportSessionJson} disabled={!selectedDb}
                  title="現在の表示状態を JSON ファイルに書き出し（論文添付・バージョン管理向け）"
                  style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #e9ecef', borderRadius: 4,
                    background: '#fff', color: '#495057', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: 600 }}>
                  Session JSON 書き出し
                </button>
                <button onClick={() => sessionFileRef.current?.click()}
                  title="書き出した Session JSON を読み込んで表示状態を復元（同じ DB が必要）"
                  style={{ textAlign: 'left', padding: '5px 8px', border: '1px solid #e9ecef', borderRadius: 4,
                    background: '#fff', color: '#495057', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13, fontWeight: 600 }}>
                  Session JSON 読込…
                </button>
              </div>
            )}
            <input ref={sessionFileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importSessionJson(f); e.target.value = ''; setShowExportMenu(false) }} />
          </div>
          {divider()}
          {/* ── Panels: パス一覧・付属UI・編集・アライメント ── */}
          <button
            onClick={() => setShowPaths(m => { if (!m) showHint('左にパス選択パネルを出します。サンプル/ハプロタイプ/コンティグ単位で選ぶと、リボン描画・MSA の対象・絞り込み描画の対象になります。'); return !m })}
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px',
              border: '1px solid',
              borderColor: showPaths ? '#1971c2' : '#adb5bd',
              borderRadius: 4,
              background: showPaths ? '#e7f5ff' : '#f8f9fa',
              color: showPaths ? '#1971c2' : '#495057',
              cursor: 'pointer',
              fontWeight: showPaths ? 600 : 400,
            }}
          >
            Paths
          </button>
          <button
            onClick={() => setShowOverlays(v => !v)}
            title="ミニマップ・凡例・レイヤバッジなど、マップ上に重なる付属UIをまとめて表示/非表示"
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px',
              border: '1px solid',
              borderColor: showOverlays ? '#1971c2' : '#adb5bd',
              borderRadius: 4,
              background: showOverlays ? '#e7f5ff' : '#f8f9fa',
              color: showOverlays ? '#1971c2' : '#495057',
              cursor: 'pointer',
              fontWeight: showOverlays ? 600 : 400,
            }}
          >
            Overlays
          </button>
          <button
            onClick={() => setEditMode(m => { if (!m) showHint('編集モード: クリックでノード選択、ドラッグで移動、Shiftで複数選択、黄丸で回転。Space+ドラッグでパン。'); return !m })}
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px',
              border: '1px solid',
              borderColor: editMode ? '#1971c2' : '#adb5bd',
              borderRadius: 4,
              background: editMode ? '#e7f5ff' : '#f8f9fa',
              color: editMode ? '#1971c2' : '#495057',
              cursor: 'pointer',
              fontWeight: editMode ? 600 : 400,
            }}
          >
            Edit
          </button>
          <button
            onClick={() => {
              setBottomH(h => {
                if (h > 0) {
                  setActiveAlignRowId(null)
                  setShowAlignColors(false)          // 閉じたらリンク色も戻す
                  alignColorsUserOff.current = false // 次に開いたらまた自動 ON
                  return 0
                }
                return 220
              })
            }}
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px',
              border: '1px solid',
              borderColor: bottomH > 0 ? '#7950f2' : '#adb5bd',
              borderRadius: 4,
              background: bottomH > 0 ? '#f3f0ff' : '#f8f9fa',
              color: bottomH > 0 ? '#7950f2' : '#495057',
              cursor: 'pointer',
              fontWeight: bottomH > 0 ? 600 : 400,
            }}
          >
            Alignment
          </button>
          <button
            onClick={() => setMsaH(h => {
              // Alignment と同様、開くとノード選択(クリックで MSA 対象ノード追加)を自動 ON、閉じると OFF。
              if (h > 0) { setMsaPick(false); return 0 }
              setMsaPick(true); return 300
            })}
            title="Bubble MSA パネル（開くとノード選択が自動 ON：グラフのノードをクリックで追加）"
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '4px 14px',
              border: '1px solid',
              borderColor: msaH > 0 ? '#0d9488' : '#adb5bd',
              borderRadius: 4,
              background: msaH > 0 ? '#e6f4f1' : '#f8f9fa',
              color: msaH > 0 ? '#0d9488' : '#495057',
              cursor: 'pointer',
              fontWeight: msaH > 0 ? 600 : 400,
            }}
          >
            MSA
          </button>
        </div>
      </div>

      {/* ── Edit 行（2 段目・文脈ツールバー）────────────────────────────
          ★上段は Edit の ON/OFF で**一切変わらない**。編集用のものは全部ここに出す。
            以前は上段にインライン挿入していたので、Alignment/MSA が次の行へ落ち、
            右寄せのせいで Edit ボタン自身の位置まで動いていた（ON にした所を
            もう一度押すと別のボタンだった）。
          ★Save もここに置く。編集は「DB に保存したいから」だけでなく
            「繋がりをその場で確かめるために動かしてみる」使い方もするので、
            Save は Edit の文脈の中にあるべきで、離れた場所に常駐させない。 */}
      {editMode && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '4px 16px', background: '#faf8ff', borderBottom: '1px solid #e5dcf7',
          fontFamily: 'sans-serif', fontSize: 12, color: '#495057',
        }}>
          <span style={{ fontWeight: 600, color: '#7048e8', whiteSpace: 'nowrap' }}>Edit</span>
          {toggleBtn(softDragMode,
            () => setSoftDragMode(m => { if (!m) showHint('ソフト移動: ノードを掴んでドラッグすると、BFSで近い近傍も hop 減衰した強さで一緒に動きます（d3-force風）。Shift+ドラッグは従来の剛体移動。「hop」で巻き込む距離を調整。'); return !m }),
            'Soft drag', '#7048e8', '#f3f0ff', '掴んだノード＋BFS近傍を hop 減衰重みで一緒に動かす（d3-force風）')}
          {softDragMode && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              hop
              <input type="number" min={1} max={30} step={1} value={softDragHops}
                title="ソフト移動で巻き込む最大 hop 距離。大きいほど遠くまで一緒に動く"
                onChange={e => { const v = parseInt(e.target.value, 10); setSoftDragHops(isNaN(v) ? 6 : Math.max(1, Math.min(30, v))) }}
                style={{ width: 44, fontSize: 12, padding: '2px 4px' }} />
              soft
              <input type="number" min={1} max={12} step={1} value={softDragSoftness}
                title="柔らかさ。大きいほど柔らかく（近傍が広く緩やかに追従）、小さいほど硬い（掴んだ点だけ動く）"
                onChange={e => { const v = parseInt(e.target.value, 10); setSoftDragSoftness(isNaN(v) ? 5 : Math.max(1, Math.min(12, v))) }}
                style={{ width: 44, fontSize: 12, padding: '2px 4px' }} />
            </span>
          )}
          <button
            onClick={saveNodeEdits}
            disabled={pendingEdits.length === 0 || savingEdits || saveDisabled}
            title={saveDisabled
              ? 'この配信では DB への保存を無効にしてある（サーバ側で AMIPA_READONLY=1）。移動して確かめるのは自由で、結果は保存されない'
              : '編集モードでのノード移動/回転を、子孫ノードと関連エッジごとDBへ保存する'}
            style={{
              fontFamily: 'sans-serif', fontSize: 13, padding: '3px 12px',
              border: '1px solid',
              borderColor: (pendingEdits.length > 0 && !saveDisabled) ? '#e8590c' : '#adb5bd',
              borderRadius: 4,
              background: (pendingEdits.length > 0 && !saveDisabled) ? '#fff4e6' : '#f8f9fa',
              color: (pendingEdits.length > 0 && !saveDisabled) ? '#e8590c' : '#adb5bd',
              cursor: (pendingEdits.length === 0 || savingEdits || saveDisabled) ? 'default' : 'pointer',
              fontWeight: (pendingEdits.length > 0 && !saveDisabled) ? 600 : 400,
            }}
          >
            {savingEdits ? 'Saving…' : `Save to DB${pendingEdits.length > 0 ? ` (${pendingEdits.length})` : ''}`}
          </button>
          {saveDisabled && (
            <span style={{ color: '#868e96', whiteSpace: 'nowrap' }}
              title="サーバを AMIPA_READONLY=1 で起動している">
              保存は無効（閲覧専用の配信）
            </span>
          )}
          <span style={{ marginLeft: 'auto', color: '#888' }}>
            Click: select &nbsp;·&nbsp;
            Shift+Click: add/remove &nbsp;·&nbsp;
            Drag (empty): box-select &nbsp;·&nbsp;
            Drag (node): move &nbsp;·&nbsp;
            Yellow handle: rotate &nbsp;·&nbsp;
            Space+Drag: pan &nbsp;·&nbsp;
            Esc: clear
          </span>
        </div>
      )}

      {/* ── Top panel ─────────────────────────────────────────────── */}
      {topH > 0 && (
        <div style={{ height: topH, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 13, fontFamily: 'sans-serif' }}>
          (top panel)
        </div>
      )}
      <div
        onMouseDown={onTopHandleDown}
        title="Drag to resize top panel"
        className="amipa-grip-row"
        style={{ ...handleStyle, height: HANDLE_SIZE, cursor: 'row-resize', borderTop: '1px solid #c8cdd3' }}
      />

      {/* ── Main row ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* ── 左パネル: パス選択（リボン描画と MSA の対象を兼ねる） ───────── */}
        {showPaths && (
          <>
            <div style={{
              width: leftW, flexShrink: 0, overflow: "hidden",
              background: "#fafafa", borderRight: "1px solid #c8cdd3",
              display: "flex", flexDirection: "column",
              fontFamily: "sans-serif", fontSize: 12, color: "#343a40", padding: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4,
                marginBottom: (ribbonLevel !== 'none' && !ribbonCollapsed) ? 6 : 0 }}>
                <span style={{ fontWeight: 600 }} title="選択したパスはリボン描画と MSA 対象を兼ねる">
              パス{ribbonSel.size > 0 ? ` (${ribbonSel.size})` : ''}</span>
                <select value={ribbonLevel} onChange={e => setRibbonLevel(e.target.value as 'none' | RibbonLevel)}
                  style={{ flex: 1, marginLeft: 'auto' }}>
                  <option value="none">なし</option>
                  <option value="sample">サンプル</option>
                  <option value="haplotype">ハプロタイプ</option>
                  {(ribbonContig || !ribbonHapcov) && <option value="contig">コンティグ</option>}
                </select>
                {/* hap 絞り込み描画: 選択群を通るノード・エッジだけ取得する（サイドカー必須） */}
                {hapIdx && (
                  <button onClick={() => setHapFilter(v => !v)}
                    title={ribbonSel.size === 0
                      ? '選択群だけ描画（先に下のリストで群を選ぶ）'
                      : hapFilter
                        ? '選択群だけ描画: ON（クリックで全体表示に戻す）'
                        : `選択群だけ描画: OFF（クリックで ON。${hapIdx.nHap} hap 索引${
                            hapIdx.mode === 'bucket' ? '・近似マスク+厳密判定' : ''}）`}
                    style={{ flex: '0 0 auto', width: 20, height: 20, padding: 0, cursor: 'pointer',
                      border: '1px solid ' + (hapFilter ? '#1971c2' : '#ced4da'), borderRadius: 3,
                      background: hapFilter ? '#e7f5ff' : '#f8f9fa',
                      color: hapFilter ? '#1971c2' : '#495057', lineHeight: 1, fontSize: 12 }}>
                    🔍
                  </button>
                )}
                {/* 全選択 / 反転: 絞り込み結果に対して */}
                {ribbonLevel !== 'none' && pathGroups.length > 0 && (
                  <>
                    <button onClick={selectAllRibbon}
                      title="表示中(絞り込み結果)を全選択"
                      style={{ flex: '0 0 auto', height: 20, padding: '0 6px', cursor: 'pointer',
                        border: '1px solid #ced4da', borderRadius: 3, background: '#f8f9fa',
                        color: '#495057', lineHeight: 1, fontSize: 11 }}>
                      全選択
                    </button>
                    <button onClick={invertRibbon}
                      title="表示中(絞り込み結果)の選択を反転"
                      style={{ flex: '0 0 auto', height: 20, padding: '0 6px', cursor: 'pointer',
                        border: '1px solid #ced4da', borderRadius: 3, background: '#f8f9fa',
                        color: '#495057', lineHeight: 1, fontSize: 11 }}>
                      反転
                    </button>
                  </>
                )}
                {/* 選択があるとき: 一時非表示(選択は維持)・全解除 */}
                {ribbonLevel !== 'none' && ribbonSel.size > 0 && (
                  <>
                    <button onClick={() => setRibbonHidden(h => !h)}
                      title={ribbonHidden ? 'リボンを再表示' : 'リボンを一時非表示（選択は維持）'}
                      style={{ flex: '0 0 auto', width: 20, height: 20, padding: 0, cursor: 'pointer',
                        border: '1px solid #ced4da', borderRadius: 3,
                        background: ribbonHidden ? '#ffe3e3' : '#f8f9fa',
                        color: ribbonHidden ? '#c92a2a' : '#495057', lineHeight: 1, fontSize: 12 }}>
                      {ribbonHidden ? '🙈' : '👁'}
                    </button>
                    <button onClick={() => { setRibbonSel(new Map()); setRibbonHidden(false) }}
                      title="選択を全解除"
                      style={{ flex: '0 0 auto', width: 20, height: 20, padding: 0, cursor: 'pointer',
                        border: '1px solid #ced4da', borderRadius: 3, background: '#f8f9fa',
                        color: '#495057', lineHeight: 1, fontSize: 12 }}>
                      ✕
                    </button>
                  </>
                )}
                {/* 折りたたみトグル: 描画は維持したままリスト部だけ畳む */}
                {ribbonLevel !== 'none' && (
                  <button onClick={() => setRibbonCollapsed(c => !c)}
                    title={ribbonCollapsed ? 'リストを開く' : 'リストを畳む（描画は維持）'}
                    style={{ flex: '0 0 auto', width: 20, height: 20, padding: 0, cursor: 'pointer',
                      border: '1px solid #ced4da', borderRadius: 3, background: '#f8f9fa',
                      color: '#495057', lineHeight: 1, fontSize: 12 }}>
                    {ribbonCollapsed ? '▸' : '▾'}
                  </button>
                )}
              </div>
              {ribbonLevel !== 'none' && ribbonCollapsed && ribbonSel.size > 0 && (
                <div style={{ fontSize: 11, color: '#868e96', marginTop: 4 }}>{ribbonSel.size} 群を表示中</div>
              )}
              {ribbonLevel !== 'none' && !ribbonCollapsed && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span title="super-node の総塩基の θ% 以上を通れば通過。既定 0=少しでも通れば通過（表示フィルタと同じ基準）。上げると混雑は減るが、バブルは 1 ハプロタイプが総塩基の 1/アリル数しか覆えないためリボンが落ちやすい">θ {Math.round(ribbonTheta * 100)}%</span>
                    <input type="range" min={0} max={100} value={Math.round(ribbonTheta * 100)}
                      onChange={e => setRibbonTheta(Number(e.target.value) / 100)} style={{ flex: 1 }} />
                  </div>
                  <input type="text" placeholder="絞り込み…" value={ribbonSearch}
                    onChange={e => setRibbonSearch(e.target.value)}
                    style={{ marginBottom: 6, padding: '2px 4px', border: '1px solid #ced4da', borderRadius: 3 }} />
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    {pathGroups
                      .filter(g => !ribbonSearch || g.key.toLowerCase().includes(ribbonSearch.toLowerCase()))
                      .slice(0, 300).map(g => {
                        const sel = ribbonSel.get(g.key)
                        return (
                          <div key={g.key} onClick={() => toggleRibbonGroup(g)}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px',
                              cursor: 'pointer', borderRadius: 3, background: sel ? '#f1f3f5' : 'transparent' }}>
                            <span style={{ width: 12, height: 12, borderRadius: 2, flex: '0 0 auto',
                              border: '1px solid #adb5bd',
                              background: sel ? '#' + sel.color.toString(16).padStart(6, '0') : '#ced4da' }} />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key}</span>
                            {ribbonLevel !== 'contig' && <span style={{ color: '#868e96' }}>{g.n_contigs}</span>}
                          </div>
                        )
                      })}
                  </div>
                </>
              )}
            </div>
            {/* Left resize handle */}
            <div onMouseDown={onLeftHandleDown} title="Drag to resize path panel"
              className="amipa-grip-col"
              style={{ ...handleStyle, width: HANDLE_SIZE, cursor: "col-resize", borderRight: "1px solid #c8cdd3" }} />
          </>
        )}

        {/* Graph canvas — clearly bounded rectangle */}
        <div style={{
          flex: 1, minWidth: 0, overflow: 'hidden',
          outline: '1px solid #c8cdd3',
          background: '#ffffff',
          position: 'relative',
        }}>
          <style>{`
            /* ★リサイズハンドルの当たり判定。見た目は 5px のままで、掴める帯だけ広げる */
            .amipa-grip-row::after { content:''; position:absolute; left:0; right:0;
              top:-${GRIP_PAD}px; bottom:-${GRIP_PAD}px; }
            .amipa-grip-col::after { content:''; position:absolute; top:0; bottom:0;
              left:-${GRIP_PAD}px; right:-${GRIP_PAD}px; }
            @keyframes hint-toast {
              0%   { opacity: 0; transform: translateY(-8px); }
              10%  { opacity: 1; transform: translateY(0); }
              72%  { opacity: 1; }
              100% { opacity: 0; }
            }
          `}</style>
          {hint && (
            <div key={hint.key} style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
              zIndex: 300, pointerEvents: 'none',
              background: 'rgba(33, 37, 41, 0.88)', color: '#fff',
              fontFamily: 'sans-serif', fontSize: 13, lineHeight: 1.5,
              padding: '8px 16px', borderRadius: 6,
              maxWidth: 480, textAlign: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
              animation: 'hint-toast 4s ease forwards',
            }}>
              {hint.text}
            </div>
          )}
          {selectedDb && maxLayer !== null
            ? <>
                <GraphCanvas
                  ref={graphRef}
                  maxLayer={maxLayer}
                  dbFile={selectedDb}
                  editMode={editMode}
                  softDragMode={softDragMode}
                  softDragHops={softDragHops}
                  softDragSoftness={softDragSoftness}
                  alignPickMode={bottomH > 0 && activeAlignRowId !== null}
                  nodeGreyMode={nodeGreyMode}
                  coverageTextMode={coverageTextMode}
                  breadthMode={edgeWidthMode === 'paths'}
                  maxHb={maxHb}
                  bandMode={bandMode}
                  regionMode={regionMode}
                  geneMode={geneMode}
                  maxGeneCount={maxGeneCount}
                  bandDict={bandDict}
                  regionDict={regionDict}
                  showBandLabels={showBandLabels}
                  showRegionMarks={showRegionMarks}
                  showGeneLabels={showGeneLabels}
                  geneFeatures={geneFeatures}
                  selectedGene={selectedGene}
                  selectedGeneExons={selectedGeneExons}
                  cnvMode={cnvMode}
                  cnvNodes={cnvNodes}
                  cnvColors={cnvColors}
                  onCnvSuppress={onCnvSuppress}
                  seqMode={seqMode}
                  baseMap={baseMap}
                  coverageMin={coverageMin}
                  nodeScale={nodeScale}
                  edgeMin={edgeMin}
                  mapMapq={mapMapq}
                  hapSel={hapSel}
                  maxRows={maxRows}
                  onLodClamp={setLodClamp}
                  detailDepthMode={edgeWidthMode === 'reads'}
                  showNodeBp={showNodeBp}
                  labelScale={labelScale}
                  labelColor={parseInt(labelColor.slice(1), 16) || 0x111111}
                  labelOffset={labelOffset}
                  maxEdgePx={maxEdgePx}
                  maxEdgeReads={maxEdgeReads}
                  showNodeNames={showNodeNames}
                  showRefPos={showRefPos && refposAvail}
                  refContigs={refContigs}
                  nodeColors={activeNodeColors}
                  selectedPaths={selectedPaths}
                  ribbons={ribbonHidden ? EMPTY_RIBBONS : ribbons}
                  layerZoom={lodMeta.layerZoom}
                  zoomWindow={lodMeta.zoomWindow}
                  worldBbox={lodMeta.world}
                  layerOffset={detailStep}
                  suppressHeavyWarning={suppressHeavy}
                  floodMode={floodMode}
                  floodResult={floodResult}
                  floodSeedComp={floodSeedComp}
                  floodMaxHop={floodHops}
                  msaHighlight={msaHiSet}
                  msaHoverNodes={msaHoverSet}
                  onViewportChange={(vp, layer, glyphs) => {
                    setMapViewport(vp); setMapLayer(layer)
                    if (glyphs !== undefined) setMapGlyphs(glyphs)
                  }}
                  onHeavyView={glyphs => setHeavyModal(prev => prev ?? glyphs)}
                  onRibbonEdited={() => { ribbonEditedRef.current = true }}
                  onNodesEdited={g => setPendingEdits(prev => [...prev, g])}
                  onNodeSelect={node => {
                    setSelectedNode(node)
                    // MSA ノード選択モード中はクリックしたノードを MSA 対象集合にトグル追加。
                    if (node && msaPick) {
                      const nm = node.node_name
                      setMsaNodeSel(prev => prev.includes(nm) ? prev.filter(x => x !== nm) : [...prev, nm])
                    }
                    // 近接モード: クリック点からグラフ距離フラッド。背景クリック(node=null)で解除。
                    if (floodMode) {
                      if (node) {
                        fetchFlood(selectedDb, mapLayer, node.node_name, floodHops).then(r => {
                          if (r) { setFloodResult(new Map(r.reached.map(x => [x.name, x.hop]))); setFloodSeedComp(node.comp_id ?? null) }
                        })
                      } else { setFloodResult(null); setFloodSeedComp(null) }
                    }
                    if (node) setSelectedReadAln(null)   // ノード選択でリード詳細を閉じる（直近選択優先）
                    if (!node || activeAlignRowId === null) return
                    // ★アラインメントは**葉ノード**にしか付かない（リード索引の鍵が GFA の
                    //   セグメント id で、クラスタには対応する実体が無い）。以前はクラスタでも
                    //   そのまま列に足していたので、空のまま列幅が潰れ、塩基表示で落ちていた。
                    if (!/^n\d+$/.test(node.node_name)) {
                      showHint(`${node.node_name} はクラスタなので、リードの整列はありません。`
                        + 'ズームして葉ノード（n…）を選んでください。')
                      return
                    }
                    // ★描画の高速経路(nx=fast)は **size を返さない**。アラインビューは列幅と
                    //   拡大段を size から決めるので、欠けたまま渡すと「列が最小幅のまま広げられない」
                    //   「+ で塩基表示にすると落ちる」になる（実際にそうなった）。足りなければ補う。
                    // ★選んだ端から**右端の列として足していく**。以前は 2 個目以降を「保留中」に
                    //   して置き場所の + を押させていたが、複数ノードを並べるのに毎回 2 手かかった。
                    //   位置と段は後から ⠿ のドラッグで直せるので、追加は 1 手でよい。
                    const addToAlign = (nd: NodeData) => {
                      setAlignRows(prev => prev.map(r =>
                        r.id !== activeAlignRowId ? r : { ...r, columns: [...r.columns, [nd]] }))
                      // 追加を始めたらリンク色を自動で入れる（どのノードがどの列かを地図側でも追える）。
                      // 自分で切った後は勝手に戻さない。Alignment を閉じたら解除する。
                      if (!alignColorsUserOff.current) setShowAlignColors(true)
                    }
                    if (node.size == null && selectedDb) {
                      fetchNodeInfo(selectedDb, node.node_name)
                        .then(info => addToAlign({ ...node, ...info } as NodeData))
                        .catch(() => addToAlign(node))
                    } else {
                      addToAlign(node)
                    }
                  }}
                  onLoadingChange={loading => { setIsLoading(loading); if (!loading) setFetchProg(null) }}
                  onFetchProgress={setFetchProg}
                  onFastPath={setFastPath}
                />
                {/* アノテ凡例(色キー): アクティブなモードのみ。左下オーバーレイ。 */}
                {showOverlays && (bandMode || regionMode || geneMode || selectedGene) && (
                  <div style={{
                    position: 'absolute', bottom: 8, left: 8, zIndex: 10, pointerEvents: 'none',
                    background: 'rgba(255,255,255,0.92)', border: '1px solid #dee2e6', borderRadius: 4,
                    padding: '6px 9px', fontFamily: 'sans-serif', fontSize: 11, color: '#495057',
                    display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 240,
                  }}>
                    {bandMode && (
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>Band (cytoBand)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                          {[...new Set([...bandDict.values()].map(b => b.gie_stain))].map(st => (
                            <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ width: 12, height: 12, background: hexCss(stainToColor(st)),
                                border: '1px solid #ced4da', borderRadius: 2 }} />
                              {st === 'acen' ? 'acen (centromere)' : st}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {regionMode && (
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>Region (CHM13)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                          {[...regionDict.values()].map(r => {
                            const canGoto = r.cx != null && r.cy != null
                            return (
                              <span key={r.region_id}
                                onClick={() => { if (canGoto) handleRegionGoto(r) }}
                                title={canGoto ? `${r.name} の代表位置へ移動` : `${r.name}(移動先なし)`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                                  cursor: canGoto ? 'pointer' : 'default' }}>
                                <span style={{ width: 12, height: 12, background: hexCss(stainToColor(r.name)),
                                  border: '1px solid #ced4da', borderRadius: 2 }} />
                                {r.name}
                              </span>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    {geneMode && (
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>Gene density</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span>1</span>
                          <span style={{ flex: 1, height: 10, minWidth: 80, borderRadius: 2,
                            background: `linear-gradient(90deg, ${hexCss(GENE_DENSITY_LOW)}, ${hexCss(GENE_DENSITY_HIGH)})` }} />
                          <span>{maxGeneCount}</span>
                        </div>
                      </div>
                    )}
                    {selectedGene && (
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 2, color: '#2b8a3e',
                          display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>{selectedGene.name}</span>
                          <button onClick={clearSelectedGene} title="遺伝子 hull を解除"
                            style={{ cursor: 'pointer', border: '1px solid #ced4da', borderRadius: 3,
                              background: '#fff', color: '#868e96', lineHeight: 1, padding: '0 5px',
                              fontSize: 12 }}>×</button>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 12, height: 12, background: hexCss(EXON_COLOR), borderRadius: 2 }} />exon
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 12, height: 12, background: hexCss(INTRON_COLOR),
                              border: '1px solid #ced4da', borderRadius: 2 }} />intron
                          </span>
                          <span style={{ color: '#868e96' }}>green edge = exon spans nodes</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {showOverlays && (
                <div style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 10,
                  // 編集モード中はクリックを canvas へ通し、パネル下のノードを掴めるようにする（表示は維持）
                  pointerEvents: editMode ? 'none' : undefined,
                  background: 'rgba(255,255,255,0.9)',
                  border: '1px solid #dee2e6',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontFamily: 'sans-serif', fontSize: 12, color: '#495057',
                  display: 'flex', flexDirection: 'column', gap: 3, minWidth: 168,
                }}>
                  {(() => {
                    const atDeepest = maxLayer !== null && mapLayer >= maxLayer
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>layer {mapLayer}</span>
                        {atDeepest && (
                          <span title="これ以上詳細な層はありません（個々のノード＝葉）"
                            style={{ background: '#e7f5ff', color: '#1971c2', border: '1px solid #a5d8ff',
                              borderRadius: 3, padding: '0 4px', fontSize: 11, fontWeight: 700 }}>最深層</span>
                        )}
                        <span style={{ color: '#868e96' }}>· {mapGlyphs.toLocaleString()} glyphs</span>
                        {isLoading && (
                          // 進捗が取れていれば行数（分母が分かるときだけ %）を出す。
                          // 重い取得でも「動いている / どこまで来たか」が分かるようにする。
                          <span style={{ color: '#868e96' }} title="取得中（別領域へ移動すると中断されます）">
                            {fetchProg && fetchProg.rows > 0
                              ? (fetchProg.total > 0
                                  ? `… ${Math.min(99, Math.floor(fetchProg.rows / fetchProg.total * 100))}% `
                                    + `(${fetchProg.rows.toLocaleString()} / ${fetchProg.total.toLocaleString()})`
                                  : `… ${fetchProg.rows.toLocaleString()} 行`)
                              : '…'}
                          </span>
                        )}
                      </div>
                    )
                  })()}
                  {/* LOD 安全弁: 密すぎて要求層が出せず上位層に clamp された時だけ出る。
                      clamp は下げる方向にしか働かないので、抜ければ自動で元の層に戻る。
                      絞り込めば収まって元の層に戻れるので、その導線をここに置く。 */}
                  {lodClamp && (
                    <div style={{ background: '#fff4e6', border: '1px solid #ffd8a8', borderRadius: 3,
                      padding: '3px 5px', fontSize: 11, color: '#a8620a', lineHeight: 1.35 }}>
                      密すぎて <b>layer {lodClamp.served}</b> を表示中（要求 {lodClamp.requested}）
                      {hapIdx && (
                        <>
                          {' · '}
                          <span
                            onClick={() => {
                              if (ribbonLevel === 'none') setRibbonLevel('sample')
                              setRibbonCollapsed(false)
                              if (ribbonSel.size > 0) setHapFilter(true)
                              else showHint('パスリボンのリストでサンプル/ハプロタイプを選ぶと、'
                                + 'その経路だけに絞って深い層まで表示できます')
                            }}
                            title="選択サンプル/ハプロタイプが通るノード・エッジだけに絞ると、この層まで戻せます"
                            style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 700 }}>
                            サンプルで絞る
                          </span>
                        </>
                      )}
                    </div>
                  )}
                  {/* 取得上限（UX 値）。遅い環境や重い端末では下げる。0=無制限（安全弁 OFF）。 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
                    color: '#868e96' }}>
                    <span title="1 リクエストで受け取る最大グリフ数。これを超える層は自動で 1 段上に落ちる（UX 上限なので端末に合わせて調整）">上限</span>
                    <select value={maxRows} onChange={e => setMaxRows(Number(e.target.value))}
                      style={{ flex: 1, fontSize: 11 }}>
                      {MAXROWS_OPTS.map(v => (
                        <option key={v} value={v}>{v === 0 ? '無制限' : v.toLocaleString()}</option>
                      ))}
                    </select>
                  </div>
                  {(() => {
                    const atDeepest = maxLayer !== null && mapLayer >= maxLayer
                    const atShallowest = mapLayer <= 0
                    const btn: React.CSSProperties = {
                      width: 24, height: 22, lineHeight: '20px', textAlign: 'center', padding: 0,
                      border: '1px solid #ced4da', borderRadius: 4, background: '#fff', cursor: 'pointer',
                      fontSize: 14, fontWeight: 700, color: '#495057',
                    }
                    const dis: React.CSSProperties = { opacity: 0.4, cursor: 'default' }
                    const label = atDeepest ? '最深層'
                      : detailStep === 0 ? '標準'
                      : detailStep > 0 ? `詳細 +${detailStep}` : `簡略 ${detailStep}`
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <button title="1段 軽く（簡略表示・速い）" aria-label="軽く"
                          style={{ ...btn, ...(atShallowest ? dis : {}) }} disabled={atShallowest}
                          onClick={() => setDetailStep(s => Math.max(-DETAIL_CLAMP, s - 1))}>−</button>
                        <span title="クリックで標準（自動）に戻す" onClick={() => setDetailStep(0)}
                          style={{ flex: 1, textAlign: 'center', color: atDeepest ? '#1971c2' : '#868e96',
                            fontWeight: atDeepest ? 700 : 400, minWidth: 60, cursor: 'pointer' }}>{label}</span>
                        <button title={atDeepest ? 'これ以上詳細な層はありません（最深層）' : '1段 詳しく（詳細表示・重い）'}
                          aria-label="詳しく"
                          style={{ ...btn, ...(atDeepest ? dis : {}) }} disabled={atDeepest}
                          onClick={() => setDetailStep(s => Math.min(DETAIL_CLAMP, s + 1))}>＋</button>
                      </div>
                    )
                  })()}
                  <div style={{ color: '#adb5bd', fontSize: 11 }}>
                    − 軽く（簡略）／ ＋ 詳しく（詳細・重い）・ラベルで標準に戻す
                  </div>
                </div>
                )}

                {/* 重い表示範囲の警告モーダル（settle 時に描画枚数 > cap） */}
                {heavyModal !== null && (
                  <div style={{
                    position: 'absolute', inset: 0, zIndex: 50,
                    background: 'rgba(0,0,0,0.25)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <div style={{
                      background: '#fff', border: '1px solid #dee2e6', borderRadius: 8,
                      padding: '18px 20px', width: 380, boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
                      fontFamily: 'sans-serif', color: '#343a40',
                    }}>
                      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
                        ⚠ この表示範囲は描画が重いです
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 14, color: '#495057' }}>
                        画面内に約 <b>{heavyModal.toLocaleString()}</b> 個のグリフがあります（目安上限 6,000）。
                        <br />簡略表示にすると軽くなります。このまま詳細表示を続けると重くなります。
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                        <button
                          onClick={() => closeHeavy('simplify')}
                          disabled={mapLayer <= 0}
                          style={{
                            flex: 1, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                            border: 'none', background: '#228be6', color: '#fff', fontWeight: 700,
                            opacity: mapLayer <= 0 ? 0.5 : 1,
                          }}>
                          − 簡略表示にする
                        </button>
                        <button
                          onClick={() => closeHeavy('proceed')}
                          style={{
                            flex: 1, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                            border: '1px solid #ced4da', background: '#fff', color: '#495057', fontWeight: 600,
                          }}>
                          このまま続行
                        </button>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#868e96', cursor: 'pointer' }}>
                        <input type="checkbox" checked={heavyDontWarn}
                          onChange={e => setHeavyDontWarn(e.target.checked)} />
                        今後このセッションでは警告しない
                      </label>
                    </div>
                  </div>
                )}


                {showOverlays && (
                  <Minimap
                    key={`${selectedDb}-${mapReloadKey}`}
                    viewport={mapViewport}
                    layer={mapLayer}
                    dbFile={selectedDb}
                    sel={hapSel}
                    clickThrough={editMode}
                    onNavigate={(cx, cy) => graphRef.current?.navigateTo(cx, cy)}
                  />
                )}
              </>
            : dbIncompatible
            ? <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 560 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#e03131', marginBottom: 8 }}>
                  ⚠ このDBは現行ビューアで表示できません
                </div>
                <div style={{ fontSize: 13, color: '#495057', lineHeight: 1.6 }}>
                  {dbIncompatible}
                  <br />現行仕様（3D R-tree・LOD-A stats）を満たす <code>*.layered.db</code>
                  （emitter が生成、<code>layer_zoom</code> 付き）を選択してください。
                </div>
              </div>
            : <div style={{ color: '#aaa', padding: 20, fontFamily: 'monospace' }}>
                {selectedDb ? 'Connecting...' : 'No database selected'}
              </div>
          }

          {/* 旧仕様DB（layer_zoom 無し）の警告バナー（消せる・非モーダル） */}
          {dbLegacy && maxLayer !== null && (
            <div style={{
              position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
              background: '#fff3bf', border: '1px solid #ffe066', borderRadius: 4, padding: '4px 10px',
              fontFamily: 'sans-serif', fontSize: 12, color: '#7a5900',
              display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            }}>
              ⚠ 旧仕様DB（layer_zoom なし）: LOD が密度較正されず表示が最適でない場合があります
              <span onClick={() => setDbLegacy(false)} style={{ cursor: 'pointer', fontWeight: 700, color: '#7a5900' }}>×</span>
            </div>
          )}
        </div>

        {/* Right resize handle */}
        <div
          onMouseDown={onRightHandleDown}
          title="Drag to resize right panel"
          className="amipa-grip-col"
          style={{ ...handleStyle, width: HANDLE_SIZE, cursor: 'col-resize', borderLeft: '1px solid #c8cdd3' }}
        />

        {/* Right panel — node detail */}
        <div style={{ width: rightW, flexShrink: 0, overflowY: 'auto', background: '#fafafa' }}>
          {rightW > 80 && (
            <>
            {/* リード/アラインメント検索（read_name または aln_id） */}
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #e9ecef' }}>
              <div style={{ fontSize: 10, color: '#868e96', fontFamily: 'sans-serif', marginBottom: 3 }}>リード / aln_id 検索</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <input value={readQuery} onChange={e => setReadQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') runReadSearch(readQuery) }}
                  placeholder="read名 または aln_id" disabled={!selectedDb}
                  style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '3px 5px', fontFamily: 'monospace',
                    border: '1px solid #ced4da', borderRadius: 3, outline: 'none' }} />
                <button onClick={() => runReadSearch(readQuery)} disabled={!selectedDb || !readQuery.trim()}
                  style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #1971c2', borderRadius: 3,
                    background: !selectedDb || !readQuery.trim() ? '#adb5bd' : '#1971c2', color: '#fff', cursor: 'pointer' }}>検索</button>
              </div>
              {readSearching && <div style={{ fontSize: 10, color: '#868e96', marginTop: 3 }}>検索中…</div>}
              {readResults && !readSearching && readResults.length === 0 &&
                <div style={{ fontSize: 10, color: '#e8590c', marginTop: 3 }}>該当なし</div>}
              {readResults && readResults.length > 1 && (
                <div style={{ marginTop: 4, maxHeight: 90, overflowY: 'auto' }}>
                  {readResults.map(r => (
                    <div key={r.aln_id} onClick={() => setSelectedReadAln(r)} title={`aln_id ${r.aln_id}`}
                      style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 4px', cursor: 'pointer', borderRadius: 2,
                        background: selectedReadAln?.aln_id === r.aln_id ? '#fff3bf' : 'transparent' }}>
                      aln {r.aln_id} · {r.n_segments}節 · {r.sample_id ?? '?'}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedReadAln ? (
              <div style={{ padding: '12px 14px', fontFamily: 'sans-serif', fontSize: 12,
                            userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                  borderBottom: '1px solid #e9ecef', paddingBottom: 8, marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#212529', wordBreak: 'break-all', flex: 1 }}>
                    {selectedReadAln.read_name ?? `aln_id ${selectedReadAln.aln_id}`}
                  </div>
                  <button onClick={() => { setSelectedReadAln(null); setReadResults(null) }} title="選択解除"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#adb5bd',
                      fontSize: 15, lineHeight: 1, padding: '0 2px' }}>×</button>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {([
                      ['aln_id',     selectedReadAln.aln_id],
                      ['sample',     selectedReadAln.sample_id ?? '?'],
                      ['strand',     selectedReadAln.strand ?? '?'],
                      ['query_len',  selectedReadAln.query_len?.toLocaleString() ?? '?'],
                      ['通過ノード', selectedReadAln.n_segments],
                    ] as [string, string | number][]).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ color: '#868e96', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>{k}</td>
                        <td style={{ color: '#343a40', wordBreak: 'break-all' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  <button onClick={addPathToView} title="このアライメントの経路ノードを view に一括追加（既にある view へ残りを追加／無ければ新 view）"
                    style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #1971c2',
                      borderRadius: 3, background: '#e7f5ff', color: '#1971c2', cursor: 'pointer' }}>
                    経路ノードを view に追加
                  </button>
                  {selectedReadAln.read_name && (
                    <button onClick={() => runReadSearch(selectedReadAln.read_name!)}
                      style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #adb5bd',
                        borderRadius: 3, background: '#fff', color: '#495057', cursor: 'pointer' }}>
                      同名リードの他アライメントを探す
                    </button>
                  )}
                </div>
                {/* 経路ノード（このアライメントが通る全ノード） */}
                <div style={{ marginTop: 10, borderTop: '1px solid #e9ecef', paddingTop: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 11, color: '#868e96', marginBottom: 6 }}>
                    経路ノード（{selectedReadAln.n_segments}）
                  </div>
                  {selectedReadAln.segments.map((s, i) => (
                    <div key={i} style={{ fontSize: 10, fontFamily: 'monospace', marginBottom: 6, lineHeight: 1.35 }}>
                      <div style={{ color: '#212529', wordBreak: 'break-all' }}>{s.node_name ?? '?'}</div>
                      <div style={{ color: '#868e96' }}>
                        node {s.node_start.toLocaleString()}–{s.node_end.toLocaleString()} ({s.strand}) · q {s.query_start.toLocaleString()}–{s.query_end.toLocaleString()} · mq{s.mapq ?? '?'}
                      </div>
                      <div style={{ color: '#868e96' }}>
                        <span style={{ color: '#2f9e44' }}>= {s.nmatch}</span>{'  '}
                        <span style={{ color: '#e03131' }}>X {s.nmm}</span>{'  '}
                        <span style={{ color: '#f76707' }}>I {s.nins}</span>{'  '}
                        <span style={{ color: '#7048e8' }}>D {s.ndel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : selectedNode ? (
              // ノード詳細はコピペできるよう選択可(index.html の body user-select:none を subtree で上書き)。
              <div style={{ padding: '12px 14px', fontFamily: 'sans-serif', fontSize: 12,
                            userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#212529', marginBottom: 10,
                  wordBreak: 'break-all', borderBottom: '1px solid #e9ecef', paddingBottom: 8 }}>
                  {selectedNode.node_name}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {/* ★ 値は「無いかもしれない」前提で組み立てる。描画の高速経路(nx=fast)は R-Tree
                        だけを読むので size/kind/haplotype 等は NodeData に入らず、selectedNodeInfo
                        (選択時に 1 行だけ引き直す)で補う。未着なら '—'。ここで素に
                        `selectedNode.size.toLocaleString()` を呼んでいたため undefined で例外→
                        ErrorBoundary が無く React ごと落ちて画面が真っ暗になっていた。 */}
                    {([
                      ['size',      num(selectedNode.size ?? selectedNodeInfo?.size)],
                      ['kind',      ((): string => {
                                      const k = selectedNode.kind ?? selectedNodeInfo?.kind
                                      return (k != null
                                        ? ({ 0: 'leaf', 1: 'cluster', 2: 'flubble' } as Record<number, string>)[k]
                                        : ({ n: 'leaf', S: 'flubble', G: 'cluster', X: 'other' } as Record<string, string>)[selectedNode.node_name[0]]) ?? '?'
                                    })()],
                      ['x',         fixed(selectedNode.xCoord, 6)],
                      ['y',         fixed(selectedNode.yCoord, 6)],
                      ['angle',     Number.isFinite(selectedNode.angle) ? (selectedNode.angle * 180 / Math.PI).toFixed(1) + '°' : '—'],
                      ['radius',    fixed(selectedNode.radius, 6)],
                      ['size (bp)', num(selectedNode.size ?? selectedNodeInfo?.size, true)],
                    ] as [string, string | number][]).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ color: '#868e96', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>{k}</td>
                        <td style={{ color: '#343a40', wordBreak: 'break-all' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* A3: 参照座標(ref_bp)。クリックしたノードが ref_bp を持つときだけ表示。 */}
                {selectedNode.ref_bp != null && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #e9ecef', paddingTop: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: '#868e96', marginBottom: 6 }}>
                      参照位置{refKey ? `（${refKey}）` : ''}
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {(([
                          ['コンティグ', refContigs.get(Number(selectedNode.ref_contig_id))?.name ?? `#${selectedNode.ref_contig_id}`],
                          ['ref_bp',     fmtBpDetail(Number(selectedNode.ref_bp))],
                          ...(selectedNode.ref_bp_end != null && Number(selectedNode.ref_bp_end) !== Number(selectedNode.ref_bp)
                            ? [['範囲', `${fmtBpDetail(Number(selectedNode.ref_bp))} – ${fmtBpDetail(Number(selectedNode.ref_bp_end))}`]]
                            : []),
                          ['種別', selectedNode.ref_multi ? '複数位置（概算）'
                                 : selectedNode.is_anchor ? 'アンカー（単値）' : '継承（概算）'],
                        ] as [string, string | number][])).map(([k, v]) => (
                          <tr key={k}>
                            <td style={{ color: '#868e96', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>{k}</td>
                            <td style={{ color: '#343a40', wordBreak: 'break-all' }}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* アノテーション詳細: バンド / 領域 / 遺伝子(選択ノードに重なるもの)。遺伝子クリックで hull 表示。 */}
                {(selectedNode.band_id != null || selectedNode.region_class != null || selectedNodeFeatures.length > 0) && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #e9ecef', paddingTop: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: '#868e96', marginBottom: 6 }}>アノテーション</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {selectedNode.band_id != null && bandDict.get(Number(selectedNode.band_id)) && (
                          <tr>
                            <td style={{ color: '#868e96', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>バンド</td>
                            <td style={{ color: '#343a40' }}>{bandDict.get(Number(selectedNode.band_id))!.name}（{bandDict.get(Number(selectedNode.band_id))!.gie_stain}）</td>
                          </tr>
                        )}
                        {selectedNode.region_class != null && regionDict.get(Number(selectedNode.region_class)) && (
                          <tr>
                            <td style={{ color: '#868e96', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>領域</td>
                            <td style={{ color: '#343a40' }}>{regionDict.get(Number(selectedNode.region_class))!.name}</td>
                          </tr>
                        )}
                        {selectedNode.gene_count != null && Number(selectedNode.gene_count) > 0 && (
                          <tr>
                            <td style={{ color: '#868e96', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>遺伝子数</td>
                            <td style={{ color: '#343a40' }}>{selectedNode.gene_count}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {selectedNodeFeatures.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: '#868e96', marginBottom: 3 }}>遺伝子（クリックで hull 表示）</div>
                        {selectedNodeFeatures.map(f => {
                          let a: { strand?: string; gene_type?: string } = {}
                          try { a = JSON.parse(f.attrs || '{}') } catch { /* ignore */ }
                          return (
                            <div key={`${f.track_id}:${f.feature_id}`}
                              onClick={() => selectGeneInPlace(f.name)}
                              title={`${a.gene_type ?? ''} ${a.strand ?? ''} · クリックで移動+hull`}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                                padding: '2px 0', cursor: 'pointer' }}>
                              <span style={{ color: '#2b8a3e', fontWeight: 600 }}>{f.name}</span>
                              <span style={{ fontSize: 10, color: '#868e96' }}>
                                {a.strand === '-' ? '◄' : a.strand === '+' ? '►' : ''} {f.exonic ? 'exon' : 'intron'}
                                {a.gene_type && a.gene_type !== 'protein_coding' ? ` · ${a.gene_type}` : ''}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                {/* 葉ノードの塩基配列(leaf_seq)。葉のみ・--emit-seq 済 DB のみ。巨大配列は先頭のみ+全長取得ボタン。 */}
                {leafSeq?.available && leafSeq.leaf && leafSeq.seq != null && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #e9ecef', paddingTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 11, color: '#868e96' }}>
                        塩基配列 {(leafSeq.len ?? 0).toLocaleString()} bp
                      </span>
                      <button
                        onClick={() => navigator.clipboard?.writeText(leafSeq.seq ?? '')}
                        style={{ fontSize: 10, padding: '2px 6px', border: '1px solid #ced4da',
                          borderRadius: 3, background: '#f8f9fa', cursor: 'pointer', color: '#495057' }}
                        title="表示中の配列をコピー">コピー</button>
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.4, color: '#343a40',
                      wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto',
                      background: '#f8f9fa', border: '1px solid #e9ecef', borderRadius: 3, padding: 6,
                      userSelect: 'text', WebkitUserSelect: 'text' }}>
                      {leafSeq.seq}
                    </div>
                    {leafSeq.truncated && !leafSeqFull && (
                      <div style={{ marginTop: 5, fontSize: 10, color: '#868e96' }}>
                        先頭 {(leafSeq.seq.length).toLocaleString()} bp を表示中（全 {(leafSeq.len ?? 0).toLocaleString()} bp）。
                        <button
                          onClick={() => {
                            if (!selectedDb || !selectedNode) return
                            fetchLeafSeq(selectedDb, selectedNode.node_name, true)
                              .then(r => { setLeafSeq(r); setLeafSeqFull(true) }).catch(() => {})
                          }}
                          style={{ marginLeft: 6, fontSize: 10, padding: '2px 6px', border: '1px solid #ced4da',
                            borderRadius: 3, background: '#f8f9fa', cursor: 'pointer', color: '#495057' }}>
                          全長を取得
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: 16, color: '#ced4da', fontSize: 12,
                fontFamily: 'sans-serif', textAlign: 'center', marginTop: 20 }}>
                ノード/リードをクリック、または上で検索
              </div>
            )}
            </>
          )}
        </div>
      </div>

      {/* ── Bottom panel ──────────────────────────────────────────── */}
      <div
        onMouseDown={onBottomHandleDown}
        title="Drag to resize bottom panel"
        className="amipa-grip-row"
        style={{ ...handleStyle, height: HANDLE_SIZE, cursor: 'row-resize', borderTop: '1px solid #c8cdd3' }}
      />
      {bottomH > 0 && (
        <div style={{ height: bottomH, flexShrink: 0, overflow: 'hidden',
          borderTop: '1px solid #c8cdd3', background: '#f8f9fa' }}>
          <AlignmentView
            rows={alignRows}
            dbFile={selectedDb ?? ''}
            globalMapq={mapMapq}
            nodeColors={activeNodeColors}
            activeRowId={activeAlignRowId}
            selectedAln={selectedAln}
            onSelectAln={selectAln}
            pendingNode={pendingNode}
            onClearPending={() => setPendingNode(null)}
            onSetActiveRow={id => { setActiveAlignRowId(id); if (id === null) setPendingNode(null) }}
            onAddRow={() => {
              const id = alignRowNextId.current++
              setAlignRows(prev => [...prev, { id, columns: [] }])
              setActiveAlignRowId(id)
            }}
            height={bottomH}
            onRemoveRow={id => {
              setAlignRows(prev => prev.filter(r => r.id !== id))
              setActiveAlignRowId(prev => prev === id ? null : prev)
            }}
            onRemoveNode={(rowId, nodeId) => setAlignRows(prev =>
              prev.map(r => r.id !== rowId ? r : {
                ...r,
                // 該当ノードを段から除去（他の隙間nullは保持）し、空列・末尾nullを整理
                columns: cleanupColumns(
                  r.columns.map(col => col.filter(n => n == null || n.id !== nodeId))
                ),
              })
            )}
            onInsertColumn={(rowId, colIndex, node) => {
              setPendingNode(null)
              setAlignRows(prev => prev.map(r => {
                if (r.id !== rowId) return r
                if (r.columns.flat().some(n => n?.id === node.id)) return r
                const cols = [...r.columns]
                cols.splice(colIndex, 0, [node])
                return { ...r, columns: cols }
              }))
            }}
            onAddLane={(rowId, colIndex, node) => {
              setPendingNode(null)
              setAlignRows(prev => prev.map(r => {
                if (r.id !== rowId) return r
                if (r.columns.flat().some(n => n?.id === node.id)) return r
                const cols = r.columns.map((col, i) => i === colIndex ? [...col, node] : col)
                return { ...r, columns: cols }
              }))
            }}
            onMoveNode={(rowId, nodeId, dest) => setAlignRows(prev => prev.map(r =>
              r.id !== rowId ? r : { ...r, columns: moveNodeInColumns(r.columns, nodeId, dest) }
            ))}
            onExpandNode={async (rowId, seedName) => {
              if (!selectedDb) return
              const row = alignRows.find(r => r.id === rowId)
              if (!row) return
              const have = row.columns.flat().filter((n): n is NodeData => n != null).map(n => n.node_name)
              const result = await fetchExpandNode(selectedDb, seedName, have, 4)
              if (!result) { setHint({ text: '展開に失敗しました', key: Date.now() }); return }
              if (result.added.length) {
                const nameToId = new Map<string, number>()
                for (const col of result.columns) for (const n of col) nameToId.set(n.node_name, n.id)
                const flipIds = result.flipped.map(nm => nameToId.get(nm)).filter((x): x is number => x != null)
                setAlignRows(prev => prev.map(r =>
                  r.id !== rowId ? r : {
                    ...r,
                    columns: mergeExpansion(r.columns, result.columns, seedName),
                    flipped: [...new Set([...(r.flipped ?? []), ...flipIds])],
                  }
                ))
              }
              const remaining = result.total - result.added.length
              setHint({
                text: result.added.length
                  ? `「${seedName}」の関連ノード ${result.total} 件中 ${result.added.length} 件を追加${remaining > 0 ? `（残り ${remaining} 件・再度展開で追加）` : ''}`
                  : '未追加の関連ノードはありません',
                key: Date.now(),
              })
            }}
            onToggleFlip={(rowId, nodeId) => setAlignRows(prev => prev.map(r => {
              if (r.id !== rowId) return r
              const set = new Set(r.flipped ?? [])
              set.has(nodeId) ? set.delete(nodeId) : set.add(nodeId)
              return { ...r, flipped: [...set] }
            }))}
            onUpdateUi={(rowId, ui) => setAlignRows(prev => prev.map(r =>
              r.id !== rowId || JSON.stringify(r.ui) === JSON.stringify(ui) ? r : { ...r, ui }
            ))}
          />
        </div>
      )}

      {/* ── Bottom panel 2: Bubble MSA ────────────────────────────── */}
      {msaH > 0 && (
        <div
          onMouseDown={onMsaHandleDown}
          title="Drag to resize MSA panel"
          className="amipa-grip-row"
        style={{ ...handleStyle, height: HANDLE_SIZE, cursor: 'row-resize', borderTop: '1px solid #c8cdd3' }}
        />
      )}
      {msaH > 0 && (
        <div style={{ height: msaH, flexShrink: 0, overflow: 'hidden', borderTop: '1px solid #c8cdd3', background: '#fff' }}>
          <BubbleMsa
            db={selectedDb}
            pickedNodes={msaNodeSel}
            pickMode={msaPick}
            onTogglePick={() => setMsaPick(p => !p)}
            onRemoveNode={name => setMsaNodeSel(prev => prev.filter(x => x !== name))}
            onClearNodes={() => setMsaNodeSel([])}
            onFillBetween={fillBetween}
            onHoverNode={setMsaHover}
            sampleKeys={[...ribbonSel.keys()]}
            ribbonLevel={ribbonLevel}
          />
        </div>
      )}

    </div>
  )
}
