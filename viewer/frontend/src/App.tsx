import { useEffect, useRef, useState, useCallback, useId, useMemo, Fragment } from 'react'
import GraphCanvas, { GraphCanvasHandle, PATH_COLORS, RibbonData , BlockColorMap } from './components/GraphCanvas'
import Minimap from './components/Minimap'
import { stainToColor, hexCss, GENE_DENSITY_LOW, GENE_DENSITY_HIGH, EXON_COLOR, INTRON_COLOR } from './annotColors'
import AlignmentView, { AlignRow, MoveDest } from './components/AlignmentView'
import { naReason, naTag, AvailMap } from './avail'
import TravPanel from './components/TravPanel'
import type { TravHandle } from './components/travRender'
import { matchHapToKey } from './components/hapKey'
import { API_LEVEL_REQUIRED, fetchBlockBbox, fetchStats, fetchMaxHb, fetchCnv, fetchNodeInfo, NodeInfo, fetchLeafSeq, fetchLeafBases, fetchVersion, searchNodes, fetchExpandNode, saveSession, loadSession, searchReads, fetchNodesByName, fetchPathGroups, fetchRibbon, fetchRoute, RouteResp, fetchRefContigs, fetchGoto, saveEdits, fetchFlood, fetchAnnotDicts, fetchNodeFeatures, fetchGeneFeatures, fetchGeneExons, fetchBlockAncestors, Rect, NodeData, LeafSeq, VersionInfo, ReadAlignment, PathGroup, RibbonLevel, RefContig, BandDictEntry, RegionDictEntry, NodeFeature, GeneFeature, GeneExon, EditGesture, StatsResult, fetchPrewarm, PrewarmInfo } from './api/client'
import { docsUrl } from './docsLink'
import { fitBar } from './fitBar'

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

const HANDLE_SIZE = 2   // px, resize handle thickness（見た目は縁取り 1 px と合わせて 3 px。11-10 に 5→2 で半分に。掴める幅は GRIP_PAD で据え置き）
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
const GRIP_PAD = 7.5   // 掴める幅 ＝ 見た目 3 px ＋ 両側 7.5 px ＝ 18 px（仕切りを細くする前の 6 px ＋ 6 px×2 と同じ）

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
  const mapViewportRef = useRef<Rect>(mapViewport); useEffect(() => { mapViewportRef.current = mapViewport }, [mapViewport])
  // リボン取得用にデバウンスしたビューポート。パンの度に fetch せず、settle 後 250ms でのみ更新する。
  const [ribbonViewport, setRibbonViewport] = useState<Rect>({ x1: 0, x2: 1, y1: 0, y2: 1 })
  const [mapLayer, setMapLayer] = useState(0)
  // LOD-A: DB メタ（stats 由来）と表示ノブ・状態。層は zoom 閾値 layerZoom だけで選ぶ。
  const [lodMeta, setLodMeta] = useState<{
    layerZoom: number[]; world: { x0: number; x1: number; y0: number; y1: number } | null
    // 較正窓の規約（§4）。'square_side_W_over_s'=canvas 非依存の新既定 / 欠落=旧 DB は従来式。
    zoomWindow?: StatsResult['zoom_window']; calib?: number
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
  const avail = versionInfo?.db?.avail as AvailMap | undefined   // 付属データの有無（使えない機能は隠さず理由を出す）
  const naOf = (k: string) => { const why = naReason(avail, k); return why ? { why, tag: naTag(avail, k) ?? '使えない' } : null }
  const naReads = naOf('reads'), naTrav = naOf('trav'), naAnnot = naOf('annot')
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
  // ノードを通るパスの一覧（11-11。右パネル）
  const [nodePaths, setNodePaths] = useState<{ haps: { hap: string; sample: string; contigs: string[]; copies?: number }[]; total: number; available: boolean } | null>(null)
  useEffect(() => {
    setNodePaths(null); if (!selectedDb || !selectedNode || selectedNode.id == null) return
    let dead = false
    fetch(`/api/node_paths?db=${encodeURIComponent(selectedDb)}&id=${selectedNode.id}`).then(r => r.ok ? r.json() : null).then(j => { if (!dead && j && !j.error) setNodePaths(j) }).catch(() => { /* 出さないだけ */ })
    return () => { dead = true }
  }, [selectedDb, selectedNode])
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
  // 上部バーの Find → Read（11-17）: 当たったリードを右パネルに出し、グラフを経路に寄せて強調し、Linear をその場所の塩基段で開いて行を枠で囲む
  const [readHi, setReadHi] = useState<Set<string> | null>(null)   // グラフで強調するノード（リードの経路の葉＋描いている層の祖先）
  const readHiLeaf = useRef<string[] | null>(null)
  async function handleReadFind(q: string) {
    if (!selectedDb || !q.trim()) return
    setSearchStatus('searching'); const res = await searchReads(selectedDb, q).catch(() => [] as ReadAlignment[]); setReadResults(res)
    if (!res.length) { setSearchStatus('notfound'); return }
    setSearchStatus('idle'); void focusRead(res[0])
  }
  async function focusRead(r: ReadAlignment) {
    if (!selectedDb) return
    const s0 = r.segments[0] as any   // 検索結果の上位の項目に無い向き・長さ・節の数を節から補う
    r = { ...r, strand: r.strand ?? s0?.strand ?? null, query_len: r.query_len ?? s0?.query_len ?? null, n_segments: r.n_segments ?? r.segments.length }
    setSelectedReadAln(r); setSelectedNode(null); openRight()
    const names = [...new Set(r.segments.map(sg => sg.node_name).filter((n): n is string => !!n && /^n\d+$/.test(n)))]
    readHiLeaf.current = names; setReadHi(new Set(names))
    if (!names.length) return
    const step = Math.max(1, Math.floor(names.length / 200)); const smp = names.filter((_, i) => i % step === 0 || i === names.length - 1)
    void fetchBlockAncestors(selectedDb, mapLayer, smp).then(up => { if (readHiLeaf.current === names) setReadHi(new Set([...names, ...up])) })
    fetchNodesByName(selectedDb, smp).then(ns => { if (!ns.length) return
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const n of ns) { x0 = Math.min(x0, n.xCoord); x1 = Math.max(x1, n.xCoord); y0 = Math.min(y0, n.yCoord); y1 = Math.max(y1, n.yCoord) }
      const m = Math.max(x1 - x0, y1 - y0) * 0.15 + 1; graphRef.current?.fitBounds(x0 - m, y0 - m, x1 + m, y1 + m) }).catch(() => { /* 位置が引けなければ寄せない */ })
    if (!naTrav) {   // Linear: 閉じていれば開き、準備ができてから渡す
      if (trvH === 0) setTrvH(360)
      const arg = { aln: r.aln_id, name: r.read_name ?? String(r.aln_id), nodes: names }
      for (let i = 0; i < 80 && !travApiRef.current; i++) await new Promise(ok => setTimeout(ok, 250))
      if (readHiLeaf.current === names) void travApiRef.current?.focusRead(arg)
    }
  }
  function clearReadFocus(fromLinear = false) {
    if (!readHiLeaf.current && !selectedReadAln) return
    readHiLeaf.current = null; setReadHi(null); setSelectedReadAln(null)
    if (!fromLinear) void travApiRef.current?.focusRead(null)
  }
  useEffect(() => {   // グラフの層が変わったら祖先を引き直す
    const names = readHiLeaf.current; if (!names || !names.length || !selectedDb) return
    const step = Math.max(1, Math.floor(names.length / 200)); const smp = names.filter((_, i) => i % step === 0 || i === names.length - 1)
    void fetchBlockAncestors(selectedDb, mapLayer, smp).then(up => { if (readHiLeaf.current === names) setReadHi(new Set([...names, ...up])) })
  }, [mapLayer, selectedDb])   // eslint-disable-line react-hooks/exhaustive-deps
  function openRight() { setRightW(w => w > 80 ? w : RIGHT_W0) }
  useEffect(() => { if (selectedNode) openRight() }, [selectedNode])   // eslint-disable-line react-hooks/exhaustive-deps
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
  const [findScope, setFindScope] = useState<'node' | 'pos' | 'gene' | 'read'>('node')
  // Labels ポップオーバー（ノード名/塩基/参照bp/深度数値/CNV をまとめる）の開閉。
  const [showLabelsMenu, setShowLabelsMenu] = useState(false)
  const labelsMenuRef = useRef<HTMLDivElement>(null)
  // Export ポップオーバー（8.3 持ち出せる出力: 部分グラフ GFA / ノード BED）。
  const [showExportMenu, setShowExportMenu] = useState(false)
  // 11-06 UI 見直し: 「表示」メニュー・設定の引き出し・開発用の表示（URL に ?dev=1）
  const [showViewMenu, setShowViewMenu] = useState(false)
  const viewMenuRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  // 上部バー（11-11）: 幅が足りなければ詰める（fitBar）／自動的に隠す（画面の上端にマウスが来たときだけ下ろす。ブラウザに覚える）
  const headerRef = useRef<HTMLElement>(null)
  useEffect(() => headerRef.current ? fitBar(headerRef.current) : undefined, [])
  const [barAutoHide, setBarAutoHide] = useState<boolean>(() => { try { return localStorage.getItem('amipa.barAutoHide') === '1' } catch { return false } })
  const [barShown, setBarShown] = useState(false)
  const barHideT = useRef<number | null>(null)
  const toggleBarAutoHide = () => setBarAutoHide(v => { const nv = !v; try { localStorage.setItem('amipa.barAutoHide', nv ? '1' : '0') } catch { /* 覚えられなくてもよい */ } setBarShown(false); return nv })
  const showBar = () => { if (barHideT.current) { clearTimeout(barHideT.current); barHideT.current = null } setBarShown(true) }
  const hideBarSoon = () => { if (barHideT.current) clearTimeout(barHideT.current); barHideT.current = window.setTimeout(() => {
    barHideT.current = null; const h = headerRef.current
    if (h && (h.matches(':hover') || h.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement)) return   // マウスが中・検索欄に入力中なら下ろしたまま
    setBarShown(false) }, 450) }
  const devMode = useMemo(() => { try { return new URLSearchParams(window.location.search).has('dev') } catch { return false } }, [])
  // Traversals のブロックの数（設定の引き出しから。パネルへは travApiRef で渡す）
  const [travNBlocks, setTravNBlocksRaw] = useState<number>(() => { try { const v = Number(localStorage.getItem('amipa.trav.nblk')); if (v >= 1 && v <= 500) return v } catch { /* 保存できない環境 */ } return 30 })
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
  const MAXROWS_OPTS = [5000, 20000, 50000, 100000, 0] as const
  // 既定を一旦 0(無制限=安全弁 OFF) にしている。密領域で clamp されずに素の重さを見るため。
  // ⚠ この状態では L_safe が働かず、残る防波堤は backend の時間ガード(FETCH_MS=15s)だけ。
  //   しかもその時間チェックは 1024 行ごとなので、1 行あたりが病的に遅い環境（WG cold の実測で
  //   最初の 1024 行に 280 秒）では発火が遅れる。常用の既定に戻すなら 20000。
  // 10-28: 予算（表示グリフの上限）を有効にし、既定 20,000。選択はブラウザに保存してセッションを越えて保つ（閲覧者ごと）。
  //   超える範囲は backend の /pick_layer が粗い層を選ぶ（欠けずに簡略化）。絞りモードは部分グラフを上限で取り、打ち切られたら 1 段粗い層
  const [maxRows, setMaxRowsRaw] = useState<number>(() => { try { const v = localStorage.getItem('amipa.maxRows'); if (v != null && Number.isFinite(Number(v))) return Number(v) } catch { /* 保存できない環境 */ } return 20000 })
  const setMaxRows = useCallback((v: number) => { setMaxRowsRaw(v); try { localStorage.setItem('amipa.maxRows', String(v)) } catch { /* 保存できない環境 */ } }, [])
  // 10-28: 層の閾値は「画面に約 V 個（較正の目標、既定 2,000）」で較正されている。表示予算 B が有効なら、画面に B 個まで出してよいので
  //   閾値を √(V/B) 倍に下げて（グリフ数は拡大率の 2 乗に反比例）早く深い層に降りる。それでも予算を超える所は /pick_layer と絞りモードの予算判定が粗い層に戻す。
  //   予算が無制限なら較正のまま
  //   11-05: 無制限（0）は上限を掛けないだけで、層の選び方は最大の予算と同じにする（以前は較正のまま＝最も浅く、予算 100,000 より粗い層になった）
  const layerZoomRef = useRef<number[] | null>(null); const lodMetaRef = useRef<{ world: { x0: number; x1: number } | null }>({ world: null })
  const layerZoomEff = useMemo(() => { const V = lodMeta.calib || 2000; const B = maxRows || Math.max(...MAXROWS_OPTS); if (B <= V || !lodMeta.layerZoom.length) return lodMeta.layerZoom; const f = Math.sqrt(V / B); return lodMeta.layerZoom.map(z => z * f) }, [lodMeta, maxRows])   // 11-05: 全層を同じ倍率で。以前は layer 0 を据え置き他を 0.999 で頭打ちにしていたため、浅い層の閾値が重なって全体表示の layer 0 から少しの拡大で layer 3〜4 に飛んだ
  layerZoomRef.current = layerZoomEff; lodMetaRef.current = { world: lodMeta.world }
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
  // パス群一覧の並び。名前順（既定）/ 被覆順（サーバの並び）。系統順（古い木 .synteny の系統樹）は 11-02 に Blocks と一緒に外した
  const [ribbonSort, setRibbonSort] = useState<'name' | 'cov'>('name')
  const sortedPathGroups = useMemo(() => {
    const gs = pathGroups.slice()
    const byName = (a: PathGroup, b: PathGroup) => a.key.localeCompare(b.key, undefined, { numeric: true })
    if (ribbonSort === 'cov') return gs
    return gs.sort(byName)
  }, [pathGroups, ribbonSort])
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
      if (!viewMenuRef.current?.contains(e.target as Node))
        setShowViewMenu(false)
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
  const ribbonSelRef = useRef(ribbonSel); ribbonSelRef.current = ribbonSel
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
    // 層がまだ追いついていない（広げた直後は深い層のまま矩形だけ広い）なら取らない。層が変われば取り直す。11-10: 層 10 で全体の半分の矩形を引き 15 秒塞がった
    { const lz = layerZoomRef.current, w = lodMetaRef.current.world
      if (lz && lz[mapLayer] && w) { const W = Math.abs(w.x1 - w.x0); if (W > 0 && (vp.x2 - vp.x1) > 2 * W / lz[mapLayer]) return () => {} } }
    const mx = (vp.x2 - vp.x1) * 0.5, my = (vp.y2 - vp.y1) * 0.5
    const bbox = { x1: vp.x1 - mx, y1: vp.y1 - my, x2: vp.x2 + mx, y2: vp.y2 + my }
    // 単位がコンティグなら道筋（通る順）も取る（11-10）。矩形はビューポートの 15% 増し（広いと葉が増えて遅い）
    const rx = (vp.x2 - vp.x1) * 0.15, ry = (vp.y2 - vp.y1) * 0.15
    const rbox = { x1: vp.x1 - rx, y1: vp.y1 - ry, x2: vp.x2 + rx, y2: vp.y2 + ry }
    const wantRoute = ribbonLevel === 'contig'
    // 道筋はリボンを待たせない（11-10: 道筋の取得が遅いとリボンも出なかった）。リボンを先に出し、道筋は届いたら同じラベルのリボンに足す
    const ac = new AbortController()   // 古くなった取得は取り消す（サーバ側は順番待ちの要求を計算せずに捨てる）
    const gotRoute = new Map<string, RouteResp>(); let ribsSet = false
    if (wantRoute) for (const [label] of sels) fetchRoute(selectedDb, mapLayer, label, rbox, ac.signal).then(route => {
      if (cancelled || !route || !route.runs?.length) return
      gotRoute.set(label, route)
      if (ribsSet) setRibbons(prev => prev.map(r => r.label === label ? { ...r, route } : r))
    }).catch(() => { /* 道筋が無ければリボンのまま */ })
    Promise.all(sels.map(([label, s]) => fetchRibbon(selectedDb, mapLayer, s.gids, ribbonTheta, bbox, ac.signal)
      .then(resp => ({ label, color: s.color, nodes: resp.nodes, edges: resp.edges, route: gotRoute.get(label) }))))
      // 取得直後に未保存編集を焼き込む＝群追加/解除でもリボンが編集前の初期位置に戻らない。
      .then(ribs => { if (!cancelled) { ribsSet = true; setRibbons(applyGesturesToRibbons(ribs.map(r => ({ ...r, route: r.route ?? gotRoute.get(r.label) })), pendingEditsRef.current)) } })
      .catch(() => { if (!cancelled) setRibbons([]) })
    return () => { cancelled = true; ac.abort() }
  }, [selectedDb, ribbonSel, ribbonTheta, mapLayer, ribbonLevel])
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
      trav: trvH > 0 ? (travApiRef.current?.getState?.() ?? null) : null,   // Traversals パネル（範囲・段・並び・絞り込みなど）
      panels: { leftW, rightW, topH, bottomH, showPaths, showOverlays },
      ribbon: { level: ribbonLevel, sel: [...ribbonSel.entries()] },
      align: { rows: alignRows, activeRowId: activeAlignRowId },
    }
  }

  // スナップショットを適用（初期ロード時に ?s=id から呼ぶ。viewはURL経由でGraphCanvasが復元）
  function applySnapshot(s: any) {
    if (!s || typeof s !== 'object') return
    if (s.trav && typeof s.trav === 'object') { pendingTravState.current = s.trav; setTrvH(h => (h > 0 ? h : 360)); if (travApiRef.current) { const st = s.trav; pendingTravState.current = null; travApiRef.current.setState(st) } }
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
  const RIGHT_W0 = Math.max(120, Math.round(window.innerWidth * 0.09))
  const [rightW,  setRightW]  = useState(0)   // 11-17: 既定で閉じる。ノードのクリック・リードの検索で開く（openRight）   // 11-11: 初期幅を半分に（0.18 → 0.09）
  const [trvH, setTrvH] = useState(() => (new URLSearchParams(window.location.search).get('trav') ? 360 : 0))   // 通過（Traversals）パネルの高さ(0=閉)。?trav=1 で開いて始める
  const pendingHapRef = useRef<string | null>(null)                          // パス群の一覧が届いてから切り替える行
  // 行ラベルのクリック → そのハプロタイプのパス群（リボン）を選択／解除。パスパネルが「なし」なら haplotype 粒度で開く
  const onBlockSelectHap = useCallback((groupKey: string, hap: string) => {
    if (ribbonLevel === 'none' || pathGroups.length === 0) { pendingHapRef.current = hap; if (ribbonLevel === 'none') setRibbonLevel('haplotype'); return }
    const key = matchHapToKey(hap, pathGroups.map(g => g.key)) ?? groupKey
    const g = pathGroups.find(x => x.key === key)
    if (!g) { showHint(`パス群に「${hap}」に合うものがありません（粒度: ${ribbonLevel}）`); return }
    toggleRibbonGroup(g); setRibbonHidden(false)
  }, [ribbonLevel, pathGroups, toggleRibbonGroup, showHint])
  useEffect(() => {
    const hap = pendingHapRef.current; if (!hap || pathGroups.length === 0) return
    pendingHapRef.current = null
    const key = matchHapToKey(hap, pathGroups.map(g => g.key)); const g = key ? pathGroups.find(x => x.key === key) : undefined
    if (g) { toggleRibbonGroup(g); setRibbonHidden(false) } else showHint(`パス群に「${hap}」に合うものがありません`)
  }, [pathGroups, toggleRibbonGroup, showHint])
  // Traversals から複数の株をまとめて選ぶ・外す（木の枝のクリック、選択を外す。10-30）。粒度が未定ならハプロタイプにして、群が出そろってから適用
  const pendingHapsRef = useRef<{ haps: string[]; on: boolean } | null>(null)
  // Traversals の片のクリック → そのコンティグのリボン（11-10）。単位をコンティグに切り替え、群が届いてから選ぶ（もう選んでいれば外す）
  const pendingContigRef = useRef<string | null>(null)
  const onTravSelectContig = useCallback((path: string) => {
    const g = ribbonLevel === 'contig' ? pathGroups.find(x => x.key === path) : undefined
    // 選ぶだけ（外さない）。11-10: 同じコンティグの片を 2 回クリックすると外れて「出ない」ように見えた。外すのはパスの一覧から
    if (g) { if (ribbonSel.has(g.key)) showHint(`${path} は選択済み（外すときはパスの一覧から）`); else toggleRibbonGroup(g); setRibbonHidden(false); return }
    pendingContigRef.current = path
    if (ribbonLevel !== 'contig') { setRibbonLevel('contig'); showHint(`パスの単位をコンティグにして ${path} のリボンを描く`) }
  }, [ribbonLevel, pathGroups, toggleRibbonGroup, showHint, ribbonSel])
  useEffect(() => {
    const path = pendingContigRef.current; if (!path || ribbonLevel !== 'contig' || pathGroups.length === 0) return
    const g = pathGroups.find(x => x.key === path); if (!g) return   // まだ前の単位の群かもしれない
    pendingContigRef.current = null; if (!ribbonSelRef.current.has(g.key)) toggleRibbonGroup(g); setRibbonHidden(false)
  }, [pathGroups, ribbonLevel, toggleRibbonGroup])
  const applyHaps = useCallback((haps: string[], on: boolean) => {
    const keys = pathGroups.map(g => g.key)
    setRibbonSel(prev => {
      const next = new Map(prev)
      for (const h of haps) {
        const k = matchHapToKey(h, keys); const g = k ? pathGroups.find(x => x.key === k) : undefined; if (!g) continue
        if (!on) { next.delete(g.key); continue }
        if (next.has(g.key)) continue
        const used = new Set([...next.values()].map(v => v.color)); const color = PATH_COLORS.find(c => !used.has(c)) ?? PATH_COLORS[next.size % PATH_COLORS.length]
        next.set(g.key, { gids: g.gids, color })
      }
      return next
    })
    if (on) setRibbonHidden(false)
  }, [pathGroups])
  const onTravSelectHaps = useCallback((haps: string[], on: boolean) => {
    if (!on && haps.length === 0) { setRibbonSel(new Map()); return }   // 全部外す
    if (ribbonLevel === 'none' || pathGroups.length === 0) { pendingHapsRef.current = { haps, on }; if (ribbonLevel === 'none') setRibbonLevel('haplotype'); return }
    applyHaps(haps, on)
  }, [ribbonLevel, pathGroups, applyHaps])
  useEffect(() => { const p = pendingHapsRef.current; if (!p || pathGroups.length === 0) return; pendingHapsRef.current = null; applyHaps(p.haps, p.on) }, [pathGroups, applyHaps])
  // Traversals パネル: グラフをその範囲のノード集合に絞る（葉の名前。GraphCanvas が /api/graph/subgraph の POST で層に直す）、グラフ → パネル（locateNodes / openNames）
  const travApiRef = useRef<TravHandle | null>(null)
  const setTravNBlocks = useCallback((v: number) => { setTravNBlocksRaw(v); try { localStorage.setItem('amipa.trav.nblk', String(v)) } catch { /* 保存できない環境 */ } travApiRef.current?.setNBlocks(v) }, [])
  const pendingTravState = useRef<any>(null)   // Share view の復元: パネルが用意できたら適用する Traversals の状態
  const [trvColors, setTrvColors] = useState<BlockColorMap | null>(null)
  const onTravFilter = useCallback((sel: { names: string[] } | null) => {
    setTrvColors(sel && sel.names.length ? { maxSpan: 1, contigs: new Map(), db: selectedDb ?? undefined, filter: true, filterSel: { names: sel.names } } : null)
  }, [selectedDb])
  // Traversals の表示範囲: 範囲のノード（葉の名前）→ 表示している層の名前に直して、範囲外を薄灰（hide なら非表示）、範囲内はブロックの色で塗る、寄せる
  const [trvRange, setTrvRange] = useState<{ names: string[]; colors: number[] | null; fit: boolean; hide: boolean; direct?: boolean; fitNames?: string[] } | null>(null)
  const trvRangeReq = useRef(0)
  const [trvFilter, setTrvFilter] = useState<string[] | null>(null)   // Traversals の「グラフを絞る」の集合（葉の名前）
  const onTravRange = useCallback((v: { names: string[]; colors: number[] | null; fit: boolean; hide: boolean; direct?: boolean; fitNames?: string[] } | null) => {
    if (!v) { setTrvRange(null); setTrvFilter(null) }
    else if (v.hide) setTrvFilter(v.names.length ? v.names : null)   // 絞り（非表示）は塗り分け・塩基の段の見える範囲とは別に保つ
    else if (v.direct && !v.names.length && v.fitNames) { /* 塗りは前のまま（見えているノードが 0 の瞬間）。寄せるだけ */ } else setTrvRange(v)
    // 寄せる: 外接箱がちょうど収まる倍率で（層は倍率から自動）。/blocks/bbox は名前指定だと layer を常に最深（葉）で返すので、それを渡すと箱の中心の最深層＝何も無い所に寄ってしまう
    if (v?.hide && v.names.length && v.fitNames && v.fitNames.length) { graphRef.current?.fitSub(); return }   // 絞りモード: 届いた部分グラフ（表示している層の範囲のノード）に寄せる
    const fn = v?.fitNames; if (fn && fn.length && selectedDb) { const my = ++trvRangeReq.current; void fetchBlockBbox(selectedDb, { names: fn.slice(0, 5000) }).then(f => { if (my !== trvRangeReq.current) return; if (!f || f.minx == null || f.maxx == null || f.miny == null || f.maxy == null) return; graphRef.current?.fitBounds(f.minx, f.miny, f.maxx, f.maxy) }) }
  }, [selectedDb])
  const trvNodeColors = useMemo(() => { const m = new Map<string, number>(); if (trvRange && trvRange.colors) trvRange.names.forEach((n, i) => { const c = trvRange.colors![i]; if (c != null && c >= 0) m.set(n, c) }); return m }, [trvRange])
  useEffect(() => {   // 範囲の葉の名前 → 表示している層の名前（/api/graph/subgraph の名前だけ）。層が変わるたびに引き直す
    const withF = (m: BlockColorMap): BlockColorMap => trvFilter ? { ...m, filter: true, filterSel: { names: trvFilter } } : m
    if (!selectedDb) { setTrvColors(null); return }
    if (!trvRange) { setTrvColors(trvFilter ? withF({ maxSpan: 1, contigs: new Map(), db: selectedDb }) : null); return }
    if (trvRange.direct) { setTrvColors(withF({ maxSpan: 1, contigs: new Map(), db: selectedDb, dimSet: new Set(trvRange.names) })); return }   // 名前はグラフが描いている層のものなのでそのまま
    let live = true
    fetch('/api/graph/subgraph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db: selectedDb, layer: mapLayer, names: trvRange.names, namesOnly: true }) })
      .then(r => r.json()).then(j => { if (!live) return; const names: string[] = Array.isArray(j?.names) ? j.names : trvRange.names; setTrvColors(withF({ maxSpan: 1, contigs: new Map(), db: selectedDb, dimSet: new Set([...names, ...trvRange.names]) })) })
      .catch(() => { if (live) setTrvColors(withF({ maxSpan: 1, contigs: new Map(), db: selectedDb, dimSet: new Set(trvRange.names) })) })
    return () => { live = false }
  }, [trvRange, trvFilter, selectedDb, mapLayer])
  // グラフの塗りや重ね表示を初期値に戻す（Traversals の範囲、ホバー、洪水、重ね着色、辺の太さ、リボン、パス選択）
  const resetGraphView = useCallback(() => {
    setTrvRange(null); setTrvFilter(null); setTrvColors(null); setTrvHov(null)
    setFloodMode(false); setFloodResult(null); setNodeGreyMode(false); setBandMode(false); setRegionMode(false); setGeneMode(false); setEdgeWidthMode('off'); setShowAlignColors(false)
    setRibbonSel(new Map()); setSelectedPaths(new Map())
    travApiRef.current?.resetLinks?.()
    showHint('グラフの塗りと重ね表示を初期値に戻しました')
  }, [showHint])
  const [trvHov, setTrvHov] = useState<Set<string> | null>(null)   // Traversals の塩基の段でホバー中のノード（マゼンタ）
  const trvHovReq = useRef(0)
  const [trvHovColor, setTrvHovColor] = useState<number | null>(null)   // Traversals のブロックのホバーで強調する色（ブロックの色。11-11）
  const onTravHover = useCallback((names: string[] | null) => {
    const my = ++trvHovReq.current
    setTrvHovColor(null)
    if (!names || !names.length || !selectedDb) { setTrvHov(null); return }
    const nm = names.filter(x => /^n\d+$/.test(x)); if (!nm.length) { setTrvHov(null); return }
    void fetchBlockAncestors(selectedDb, mapLayer, nm).then(up => { if (my !== trvHovReq.current) return; setTrvHov(new Set([...nm, ...up])) })   // グラフが粗い層なら祖先も光らせる
  }, [selectedDb, mapLayer])
  const onTravGraphRange = useCallback(() => {
    const names = graphRef.current?.getVisibleNames?.() ?? []
    if (!names.length) { showHint('グラフに見えているノードがありません'); return }
    travApiRef.current?.openNames(names)
  }, [showHint])
  // Traversals の全体図の山（A・B・C…）にカーソル → その山のノードをグラフで強調（11-05。グラフ側の札と枠はユーザ判断で外した）
  const onTravPeakHover = useCallback((letter: string | null, names: string[] | null, color?: number | null) => {
    void letter; ++trvHovReq.current; setTrvHov(names && names.length ? new Set(names) : null); setTrvHovColor(color ?? null)   // 名前はグラフが描いている層のもの（祖先は引かない）
  }, [])
  const selHapMarks = useMemo(() => { const m = new Map<string, string>(); for (const [k, v] of ribbonSel) m.set(k, '#' + v.color.toString(16).padStart(6, '0')); return m }, [ribbonSel])
  const trvHoverSet = useMemo(() => (trvHov && trvHov.size ? trvHov : null), [trvHov])   // Traversals の塩基の段でホバー中のノード（グラフでマゼンタ）

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
        let lastDb: string | null = null; try { lastDb = localStorage.getItem('amipa_last_db') } catch { /* ignore */ }   // URL に db が無ければ前回のアトラス（一覧の先頭は巨大な DB のことがある）
        const initial = (urlDb && dbs.includes(urlDb)) ? urlDb : (lastDb && dbs.includes(lastDb)) ? lastDb : (dbs[0] ?? null)
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
    try { localStorage.setItem('amipa_last_db', selectedDb) } catch { /* ignore */ }
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
      setLodMeta({ layerZoom: lz, world: s.world ?? null, zoomWindow: s.zoom_window, calib: Number((s as any).layer_zoom_budget) || 2000 })
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
  function onTrvHandleDown(e: React.MouseEvent) {
    const start = trvH
    makeDragHandler(delta =>
      setTrvH(Math.max(MIN_SIDE, Math.min(window.innerHeight - MIN_GRAPH, start - delta)))
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
    // 11-16: 完全一致が 1 つ、または候補が 1 つだけなら Enter でそのまま移る（遺伝子の検索と同じ。以前は候補をクリックする必要があった）
    const exact = results.filter(r => r.node_name === q)
    const exactCi = exact.length ? exact : results.filter(r => r.node_name.toLowerCase() === q.toLowerCase())
    if (exactCi.length === 1 || results.length === 1) { setSearchResults(results); handleSearchSelect(exactCi.length === 1 ? exactCi[0] : results[0]); return }
    setSearchResults(results)
    setShowSearchDropdown(true)
  }

  // Alignment（旧版）の出し入れ（11-16）
  function toggleAlign() {
    setBottomH(h => {
      if (h > 0) { setActiveAlignRowId(null); setShowAlignColors(false); alignColorsUserOff.current = false; return 0 }
      return 220
    })
  }

  // 統合 Find: scope に応じて検索/移動を分岐（入力は共用の searchQuery）。
  function submitFind() {
    if (findScope === 'node') handleSearch()
    else if (findScope === 'pos') handleGoto(searchQuery)
    else if (findScope === 'read') void handleReadFind(searchQuery)
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

  // メニューの 1 行のチェック（11-06 UI 見直し）。on のとき青いチェック
  // na: この DB では使えない（データが無い）。押すと理由を出すだけ
  const menuCheck = (label: React.ReactNode, on: boolean, onClick: () => void, title?: string, na?: { why: string; tag: string } | null) => na ? (
    <button className="ui-menu-item is-na" role="menuitemcheckbox" aria-checked={false} aria-disabled="true" title={na.why}>
      <span className="ui-check" /><span>{label}</span><span className="ui-na-tag">{na.tag}</span>
    </button>
  ) : (
    <button className={'ui-menu-item' + (on ? ' is-on' : '')} role="menuitemcheckbox" aria-checked={on} onClick={onClick} title={title}>
      <span className="ui-check">{on ? '✓' : ''}</span><span>{label}</span>
    </button>
  )
  const anyGraphLabelOn = showNodeNames || showNodeBp || seqMode || showRefPos || coverageTextMode || cnvMode !== 'off'
  const anyAnnotOn = bandMode || regionMode || geneMode || showBandLabels || showRegionMarks || showGeneLabels

  if (error) return (
    <div style={{ color: '#c0392b', padding: 20, fontFamily: 'monospace' }}>Error: {error}</div>
  )

  return (
    <div className="ui-root" style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: 'var(--ui-bg)' }}>

      {/* ── 上部バー（11-06 UI 見直し 案 A）─────────────────────────────
          常に出すのは DB・検索・表示/ラベル/書き出しのメニュー・パネルの切り替え・設定・使い方だけ。
          細かい調整は「表示」「ラベル」のメニューと設定の引き出し（⚙）へ、版や内部の状態は設定の「このアプリについて」と ?dev=1 へ。
          ★折り返しても canvas の上に被らないよう、固定の高さにせず縦に伸ばす（以前の不具合の対策を引き継ぐ） */}
      {barAutoHide && <div className="ui-topbar-hot" onMouseEnter={showBar} />}
      <header ref={headerRef} className={'ui-topbar' + (barAutoHide ? ' is-autohide' + (barShown || showViewMenu || showLabelsMenu || showExportMenu ? ' is-shown' : '') : '')}
        onMouseEnter={barAutoHide ? showBar : undefined} onMouseLeave={barAutoHide ? hideBarSoon : undefined} onBlur={barAutoHide ? hideBarSoon : undefined}>
        <span className="ui-brand fit-opt">AMIPA</span>
        <label htmlFor="db-select" className="ui-sr">データベース</label>
        <select id="db-select" className="ui-select" value={selectedDb ?? ''} onChange={e => setSelectedDb(e.target.value)}
          title="表示するデータベース">
          {databases.map(db => <option key={db} value={db}>{db}</option>)}
        </select>
        {versionInfo && (versionInfo.api_level ?? 0) < API_LEVEL_REQUIRED && (
          <span className="ui-chip ui-chip-danger"
            title={`この画面は backend の API 段階 ${API_LEVEL_REQUIRED} 以上を要求しますが、繋いでいる配信は ${versionInfo.api_level ?? 0} です。古い配信に繋いでいるか、backend を再起動していません。ページを再読み込みしても直らなければ配信を上げ直してください`}>
            ⚠ Outdated server
          </span>
        )}
        {/* ★速いときは何も出さない。遅くなる設定を自分で入れている間だけ、原因と戻し方を出す */}
        {!fastPath.on && (
          <span className="ui-chip ui-chip-warn"
            title="この設定はノード 1 個ずつの詳細を読むので、大きいグラフの深い拡大では表示に時間がかかる。解除すると描画用の索引だけを読む速い経路に戻る">
            Slow view: {fastPath.cause === 'nodebp' ? 'node bp' : 'proximity'}
            <button className="ui-link" onClick={() => {
              if (fastPath.cause === 'nodebp') setShowNodeBp(false)
              else { setFloodMode(false); setFloodResult(null); setFloodSeedComp(null) } }}>Off</button>
          </span>
        )}
        {annotLoading && <span className="ui-chip" title="注釈の辞書を取得している。全ゲノムでは十数秒かかることがある">Loading annotations…</span>}
        {prewarm && prewarm.running && !prewarm.finished && (
          <span className="ui-chip" title={'DB ファイルを順に読んでキャッシュに載せている。終わるまで表示範囲の取得が遅い（1 枚 1〜4 秒）'}>
            Preparing {Math.floor(100 * prewarm.done / Math.max(1, prewarm.total))}%
          </span>
        )}

        {/* 検索: 種類（ノード／位置／遺伝子）＋入力＋検索を 1 つの枠に */}
        <div ref={searchWrapRef} className="ui-search">
          <label htmlFor="find-scope" className="ui-sr">検索の種類</label>
          <select id="find-scope" value={findScope}
            onChange={e => { setFindScope(e.target.value as 'node' | 'pos' | 'gene' | 'read'); setShowSearchDropdown(false); setSearchStatus('idle') }}>
            <option value="node">Node</option>
            {refposAvail && <option value="pos">Locus</option>}
            {geneAvail && <option value="gene">Gene</option>}
            {!naReads && <option value="read">Read</option>}
          </select>
          <label htmlFor="find-q" className="ui-sr">検索語</label>
          <input id="find-q" type="text"
            list={findScope === 'gene' ? 'geneGotoList' : undefined}
            placeholder={findScope === 'node' ? 'Node ID' : findScope === 'pos' ? 'chrY:12,300,000' : findScope === 'read' ? (devMode ? 'Read name or aln_id' : 'Read name') : 'Gene (e.g. UTY)'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitFind()}
            style={{ fontFamily: findScope === 'pos' || findScope === 'read' ? 'var(--ui-mono)' : undefined }} />
          <button onClick={submitFind} disabled={searchStatus === 'searching'} data-short="Go">{searchStatus === 'searching' ? '…' : 'Search'}</button>
          {/* 補完候補は入力で絞ってから上位 GENE_MENU_MAX 件だけ描く（全件を対象にしつつ DOM は軽い） */}
          {geneAvail && findScope === 'gene' && (
            <datalist id="geneGotoList">
              {matchGenes(searchQuery).map(g => <option key={g.name} value={g.name} />)}
            </datalist>
          )}
          {searchStatus === 'notfound' && <span className="ui-search-status">No match</span>}
          {findScope === 'node' && showSearchDropdown && searchResults.length > 0 && (
            <div className="ui-menu ui-menu-left" style={{ minWidth: 260, maxHeight: 260 }}>
              {searchResults.map(n => (
                <button key={n.id} className="ui-menu-item" onMouseDown={() => handleSearchSelect(n)}>
                  <span style={{ flex: 1, wordBreak: 'break-all' }}>{n.node_name}</span>
                  {devMode && n.layer !== undefined && <span style={{ fontSize: 11, color: 'var(--ui-faint)' }}>L{n.layer}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ui-spacer" />

        <div className="ui-group">
          {/* ── グラフ（11-16 再編）: ノードと辺そのものの表し方。辺の太さ・ノードの文字・リード由来の数・強調。注釈は Annotations、ミニマップは画面の隅 ── */}
          <div ref={viewMenuRef} className="ui-menu-wrap">
            <button className={'ui-btn ui-btn-ghost' + (showViewMenu ? ' is-open' : '') + (anyGraphLabelOn ? ' is-on' : '')} aria-expanded={showViewMenu}
              onClick={() => setShowViewMenu(v => !v)} title="グラフの表し方（辺の太さ・ノードの文字・深さ・コピー数・強調）" data-short="Grf ▾" data-tiny="G ▾">Graph ▾</button>
            {showViewMenu && (
              <div className="ui-menu" style={{ minWidth: 300 }}>
                <div className="ui-menu-title">Edge width</div>
                <div className="ui-menu-row">
                  <div className="ui-seg" role="radiogroup" aria-label="辺の太さ">
                    {([
                      { key: 'off' as const, label: 'Fixed', show: true, hint: '' },
                      { key: 'paths' as const, label: 'Haplotypes', show: hbAvail, hint: '辺の太さ = その辺を通るハプロタイプの数。太い = 多い' },
                      { key: 'reads' as const, label: 'Reads', show: true, hint: '辺の太さ = その辺をまたぐリードの数' },
                    ].filter(s => s.show)).map(s => { const na = s.key === 'reads' ? naReads : null; return na ? (
                      <button key={s.key} role="radio" aria-checked={false} aria-disabled="true" className="is-na" title={na.why}>{s.label}</button>
                    ) : (
                      <button key={s.key} role="radio" aria-checked={edgeWidthMode === s.key} className={edgeWidthMode === s.key ? 'is-on' : ''}
                        title={s.hint || '辺の太さを一定にする'}
                        onClick={() => setEdgeWidthMode(s.key)}>{s.label}</button>
                    ) })}
                  </div>
                </div>
                {devMode && edgeWidthMode === 'reads' && (
                  <div className="ui-menu-row">
                    <label htmlFor="px-reads" style={{ flex: 1, color: 'var(--ui-muted)' }}>最大の幅 px, 基準のリード数</label>
                    <input id="px-reads" className="ui-input ui-select-sm" style={{ width: 80, fontFamily: 'var(--ui-mono)' }}
                      value={detailParamInput} onChange={e => setDetailParamInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') applyDetailParams() }} onBlur={applyDetailParams} />
                  </div>
                )}
                <div className="ui-menu-sep" />
                <div className="ui-menu-title">Node labels</div>
                {menuCheck('Node ID', showNodeNames, () => setShowNodeNames(v => !v))}
                {menuCheck('Length (bp)', showNodeBp, () => setShowNodeBp(v => !v), 'クラスタは配下の合計 bp。大きいグラフの深い拡大では表示が遅くなる')}
                {seqAvail && menuCheck('Bases', seqMode, () => setSeqMode(v => !v), '画面内の短いノード（1bp）の塩基をノードの中に書く')}
                {refposAvail && menuCheck(`Ref position${refKey ? ` (${refKey})` : ''}`, showRefPos, () => setShowRefPos(v => !v), '参照上のおおよその bp 位置を代表のノードの近くに書く')}
                {menuCheck('Read depth', coverageTextMode, () => setCoverageTextMode(m => !m), '拡大したとき、ノードの上にリードの数を書く', naReads)}
                {multAvail && (<>
                  <div className="ui-menu-title">Copy number{cnvMode !== 'off' && cnvSuppressed ? ' ⚠' : ''}</div>
                  <div className="ui-menu-row" title={ribbonSel.size === 0 ? '左のパスの一覧で、比べたいサンプル／ハプロタイプを選ぶと使える' : '選んだパスの、ノードごとのコピー数をリボンと同じ色で書く'}>
                    <div className="ui-seg" role="radiogroup" aria-label="コピー数">
                      {([['off', 'Off', '書かない'], ['all', 'All', '選んだパスすべての、ノードごとのコピー数'], ['diff', 'Differences', '選んだパスの間でコピー数が違うノードだけ（隠れた CNV）']] as const).map(([k, lab, t]) => (
                        <button key={k} role="radio" aria-checked={cnvMode === k} className={(cnvMode === k ? 'is-on' : '') + (k !== 'off' && ribbonSel.size === 0 ? ' is-na' : '')} title={k !== 'off' && ribbonSel.size === 0 ? '左のパスの一覧でパスを選ぶと使える' : t}
                          onClick={() => { if (k !== 'off' && ribbonSel.size === 0) { showHint('コピー数: 左のパスの一覧で、比べたいサンプル／ハプロタイプを選ぶ'); return } setCnvMode(k) }}>{lab}</button>))}
                    </div>
                  </div>
                </>)}
                <div className="ui-menu-sep" />
                {menuCheck('Dim unselected', nodeGreyMode, () => setNodeGreyMode(m => !m), '左のパスの一覧で選んだパスが通らないノードを薄く描く')}
                {menuCheck('Match Alignment colors', showAlignColors, () => setShowAlignColors(v => { alignColorsUserOff.current = v; return !v }), 'Alignment パネルの各ノードの色で、グラフの同じノードも塗る')}
                {devMode && menuCheck('近さの色分け（開発）', floodMode, () => setFloodMode(m => {
                  const nm = !m
                  if (!nm) { setFloodResult(null); setFloodSeedComp(null) }
                  else showHint('ノードをクリックすると、そこからグラフ距離が近いグリフを着色します（濃青=近い→淡青=D手、同一成分の未到達=青灰、別成分=灰）。背景クリックで解除。')
                  return nm
                }), 'クリックしたノードからグラフ距離の近いグリフを色分けする（融合か近接かの確認）')}
                {devMode && floodMode && (
                  <div className="ui-menu-row" style={{ paddingLeft: 32 }}>
                    <label htmlFor="flood-hops" style={{ color: 'var(--ui-muted)' }}>距離</label>
                    <input id="flood-hops" type="number" min={1} max={50} step={1} className="ui-input ui-select-sm" style={{ width: 56 }}
                      value={floodHopsInput}
                      onChange={e => setFloodHopsInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      onBlur={() => {
                        const v = Math.max(1, Math.min(50, parseInt(floodHopsInput, 10) || 10))
                        setFloodHops(v); setFloodHopsInput(String(v))
                        if (floodMode && selectedNode && selectedDb) {
                          fetchFlood(selectedDb, mapLayer, selectedNode.node_name, v).then(r => {
                            if (r) { setFloodResult(new Map(r.reached.map(x => [x.name, x.hop]))); setFloodSeedComp(selectedNode.comp_id ?? null) }
                          })
                        }
                      }} />
                    <span style={{ color: 'var(--ui-muted)' }}>手</span>
                  </div>
                )}
                {!naTrav && (<>
                  <div className="ui-menu-sep" />
                  <button className="ui-menu-item" onClick={() => { if (bottomH === 0) toggleAlign(); setShowViewMenu(false) }}
                    title="旧版のリード表示（ノードを 1 つずつ列に足して並べる）。リードは Linear の塩基段（Reads）で見るのが現行。Linear でうまく見えないときに">
                    <span>Alignment board (legacy)<span className="ui-sub">ノードを列に並べてリードを見る旧版</span></span></button>
                </>)}
                <div className="ui-menu-sep" />
                <button className="ui-menu-item" onClick={() => { resetGraphView(); setShowViewMenu(false) }}
                  title="グラフの塗りと重ね表示を初期値に戻す（Linear の塗りと絞り込み、ホバーの強調、色分け、辺の太さ、リボン、パスの選択）">
                  表示を初期値に戻す
                </button>
              </div>
            )}
          </div>

          {/* ── 注釈（11-16 再編）: 注釈 1 つ＝1 行に「塗る（1 つだけ）」と「名前（複数可）」を並べる（以前は塗りが View、名前が Labels に分かれていた） ── */}
          <div ref={labelsMenuRef} className="ui-menu-wrap">
            <button className={'ui-btn ui-btn-ghost' + (showLabelsMenu ? ' is-open' : '') + (anyAnnotOn ? ' is-on' : '')} aria-expanded={showLabelsMenu}
              onClick={() => setShowLabelsMenu(v => !v)} title="注釈（バンド・領域・遺伝子）の塗りと名前" data-short="Ann ▾" data-tiny="A ▾">Annotations ▾</button>
            {showLabelsMenu && (
              <div className="ui-menu" style={{ minWidth: 260 }}>
                {!(bandAvail || regionAvail || geneAvail) ? menuCheck('Bands, genes…', false, () => {}, undefined, naAnnot ?? { tag: 'None', why: 'この DB には注釈（cytoBand・領域・遺伝子）が無い' }) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', columnGap: 14, rowGap: 2, alignItems: 'center', padding: '4px 10px 6px' }}>
                    <span className="ui-menu-title" style={{ padding: 0 }}>Layer</span><span className="ui-menu-title" style={{ padding: 0 }}>Color</span><span className="ui-menu-title" style={{ padding: 0 }}>Label</span>
                    {([
                      { k: 'band', name: 'Bands', show: bandAvail, col: bandMode, lab: showBandLabels, setLab: setShowBandLabels, tc: 'ノードを cytoBand の染色で塗る（acen = セントロメア）', tl: 'cytoBand の名前（例 Yq11.221）' },
                      { k: 'region', name: 'Regions', show: regionAvail, col: regionMode, lab: showRegionMarks, setLab: setShowRegionMarks, tc: 'ノードを CHM13 の領域（セントロメア・サテライト）で塗る', tl: 'CHM13 の領域の目印の名前' },
                      { k: 'gene', name: 'Genes', show: geneAvail, col: geneMode, lab: showGeneLabels, setLab: setShowGeneLabels, tc: 'ノードを遺伝子の密度で塗る（粗い拡大での概観）', tl: '遺伝子の名前（向きの矢印つき）' },
                    ].filter(r => r.show)).map(r => (
                      <Fragment key={r.k}>
                        <span>{r.name}</span>
                        <input type="radio" name="annot-color" checked={r.col} title={r.tc} aria-label={`${r.name}: color`}
                          onChange={() => { setBandMode(r.k === 'band'); setRegionMode(r.k === 'region'); setGeneMode(r.k === 'gene') }} />
                        <input type="checkbox" checked={r.lab} title={r.tl} aria-label={`${r.name}: label`} onChange={() => r.setLab((v: boolean) => !v)} />
                      </Fragment>))}
                    <span style={{ color: 'var(--ui-muted)' }}>None</span>
                    <input type="radio" name="annot-color" checked={!bandMode && !regionMode && !geneMode} title="単色（青）。パスのリボンや Linear の「Color」の色はこの上に重なる" aria-label="no annotation color"
                      onChange={() => { setBandMode(false); setRegionMode(false); setGeneMode(false) }} />
                    <span />
                  </div>)}
              </div>
            )}
          </div>

          {/* ── 書き出し: 図・部分グラフ・共有 ── */}
          <div ref={exportMenuRef} className="ui-menu-wrap">
            <button className={'ui-btn ui-btn-ghost' + (showExportMenu ? ' is-open' : '')} aria-expanded={showExportMenu}
              onClick={() => setShowExportMenu(v => !v)} title="書き出し（図・部分グラフ・セッション）" data-short="Exp ▾" data-tiny="E ▾">Export ▾</button>
            {showExportMenu && (
              <div className="ui-menu" style={{ minWidth: 280 }}>
                <div className="ui-menu-title">Current view</div>
                <button className="ui-menu-item" disabled={!selectedDb} onClick={() => { graphRef.current?.exportSvg(); setShowExportMenu(false) }}>
                  <span>Figure (SVG)<span className="ui-sub">レイヤつき・幅 180 mm</span></span></button>
                <button className="ui-menu-item" disabled={!selectedDb} onClick={() => exportRegion('gfa')}>
                  <span>Subgraph (GFA)<span className="ui-sub">見えている葉ノード・辺・配列</span></span></button>
                {refposAvail && (
                  <button className="ui-menu-item" disabled={!selectedDb} onClick={() => exportRegion('bed')}>
                    <span>Node coordinates (BED)<span className="ui-sub">参照（{refKey ?? 'ref'}）の座標で</span></span></button>
                )}
                <div className="ui-menu-note">塩基の整列（FASTA）は Linear の塩基の段の Export から</div>
                <div className="ui-menu-sep" />
                <div className="ui-menu-title">Session</div>
                <button className="ui-menu-item" disabled={!selectedDb} onClick={() => { saveCurrentState(); setShowExportMenu(false) }}>
                  <span>Share link<span className="ui-sub">サーバに保存して短い URL に</span></span></button>
                <button className="ui-menu-item" disabled={!selectedDb} onClick={shareSelfContainedLink}>
                  <span>Copy standalone link<span className="ui-sub">状態を URL に埋め込む（別の配信でも開ける）</span></span></button>
                <button className="ui-menu-item" disabled={!selectedDb} onClick={exportSessionJson}>Save session (JSON)</button>
                <button className="ui-menu-item" onClick={() => sessionFileRef.current?.click()}>Open session…</button>
              </div>
            )}
            <input ref={sessionFileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importSessionJson(f); e.target.value = ''; setShowExportMenu(false) }} />
          </div>
        </div>

        <span className="ui-divider" />

        {/* ── パネルの切り替え ── */}
        <div className="ui-group">
          <button className={'ui-btn' + (showPaths ? ' is-on' : '')} aria-pressed={showPaths}
            title="左にパスの一覧を出す。選んだパスがリボン・比較・絞り込みの対象になる"
            onClick={() => setShowPaths(m => !m)} data-tiny="P">Paths</button>
          {/* 11-16: Alignment は旧版の扱い（ユーザ決定）。リードは Linear の塩基段で見るのが現行。Linear が使えない（パスの無い）グラフと、開いている間だけ上部バーに出す */}
          {(naTrav || bottomH > 0) && (
          <button className={'ui-btn' + (bottomH > 0 ? ' is-on' : '')} aria-pressed={bottomH > 0}
            title={naTrav ? 'Alignment（旧版）: ノードを列に並べてリードを見る。このグラフは Linear が使えない（パスが無い）ので、リードはこちらで' : 'Alignment（旧版）を閉じる。リードは Linear の塩基段（Reads）で見るのが現行'}
            onClick={toggleAlign} data-short="Align" data-tiny="A">Alignment{naTrav ? '' : ' (legacy)'}</button>
          )}
          {naTrav && naReads && trvH === 0 ? (
            <button className="ui-btn is-na" aria-disabled="true" title={naTrav.why} data-tiny="Ln">Linear</button>
          ) : naTrav ? (
          <button className={'ui-btn' + (trvH > 0 ? ' is-on' : '')} aria-pressed={trvH > 0}
            title="Linear（パスの無いグラフ）: グラフでノードを選ぶと、そのノードを通るリードから局所的な歩みを作り、塩基の段でリードを見る"
            onClick={() => setTrvH(h => { if (h > 0) return 0; if (selectedNode && /^n\d+$/.test(selectedNode.node_name)) setTimeout(() => travApiRef.current?.locateNodes([selectedNode.node_name]), 0); return 360 })} data-tiny="Ln">Linear</button>
          ) : (
          <button className={'ui-btn' + (trvH > 0 ? ' is-on' : '')} aria-pressed={trvH > 0}
            title="Linear パネル: 全株を共通の座標（合意座標）に並べて比べる"
            onClick={() => setTrvH(h => h > 0 ? 0 : 360)} data-tiny="Ln">Linear</button>
          )}
          <button className={'ui-btn' + (editMode ? ' is-on' : '')} aria-pressed={editMode}
            title="ノードを動かす・回す。配置を DB に保存できる（閲覧専用の配信では保存しない）"
            onClick={() => setEditMode(m => !m)} data-tiny="Ed">Edit</button>
        </div>

        <span className="ui-divider" />

        <button className={'ui-iconbtn' + (barAutoHide ? ' is-on' : '')} aria-pressed={barAutoHide} aria-label="バーを自動的に隠す"
          title={barAutoHide ? 'バーを自動的に隠す: オン（画面の上端にマウスを寄せると出る）。クリックで常に表示' : 'バーを自動的に隠す（画面の上端にマウスを寄せたときだけ出す）'} onClick={toggleBarAutoHide}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16" /><path d={barAutoHide ? 'M12 9v11M7 15l5 5 5-5' : 'M12 20V9M7 14l5-5 5 5'} />
          </svg>
        </button>
        <button className="ui-iconbtn" aria-label="設定" title="設定" onClick={() => setShowSettings(true)}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
        <a className="ui-iconbtn" aria-label="使い方" title="使い方（この版のドキュメント。別のタブで開く）"
          href={docsUrl('viewer', versionInfo?.viewer)} target="_blank" rel="noreferrer">?</a>
      </header>

      {showSettings && (<>
        <div className="ui-drawer-scrim" onClick={() => setShowSettings(false)} />
        <aside className="ui-drawer" role="dialog" aria-label="設定">
          <div className="ui-drawer-head">
            <h2>Settings</h2>
            <button className="ui-iconbtn" aria-label="閉じる" onClick={() => setShowSettings(false)}>✕</button>
          </div>
          <div className="ui-drawer-body">
            <section className="ui-section">
              <h3>Graph</h3>
              <div className="ui-field">
                <label htmlFor="set-budget">表示予算<span className="ui-help">画面のノードがこれを超えると粗い層で描く。端末が重いときは下げる</span></label>
                <select id="set-budget" className="ui-select" value={maxRows} onChange={e => setMaxRows(Number(e.target.value))}>
                  {MAXROWS_OPTS.map(v => <option key={v} value={v}>{v === 0 ? 'Unlimited' : v.toLocaleString()}</option>)}
                </select>
              </div>
              <div className="ui-field">
                <label htmlFor="set-nodescale">ノードの長さ<span className="ui-help">厚みは変えない。数字のクリックで 1× に戻す</span></label>
                <input id="set-nodescale" type="range" min={0} max={100} style={{ width: 120 }}
                  value={Math.round(100 * Math.log(nodeScaleDraft / NODE_SCALE_MIN) / Math.log(NODE_SCALE_MAX / NODE_SCALE_MIN))}
                  onChange={e => setNodeScaleDraft(NODE_SCALE_MIN * Math.pow(NODE_SCALE_MAX / NODE_SCALE_MIN, Number(e.target.value) / 100))}
                  onMouseUp={() => setNodeScale(nodeScaleDraft)} onKeyUp={() => setNodeScale(nodeScaleDraft)} onTouchEnd={() => setNodeScale(nodeScaleDraft)} />
                <button className="ui-btn ui-btn-ghost ui-btn-sm ui-num" onClick={() => applyNodeScale(1)}>{nodeScaleDraft.toFixed(nodeScaleDraft < 1 ? 2 : 1)}×</button>
              </div>
            </section>
            <section className="ui-section">
              <h3>Labels</h3>
              <div className="ui-field">
                <span className="ui-field-label">Text size</span>
                <span className="ui-stepper">
                  <button aria-label="小さく" onClick={() => bumpLabelScale(1 / 1.15)}>−</button>
                  <button className="ui-num" style={{ width: 'auto', padding: '0 6px', border: 'none' }} title="1× に戻す" onClick={() => setLabelScale(1)}>{labelScale.toFixed(2)}×</button>
                  <button aria-label="大きく" onClick={() => bumpLabelScale(1.15)}>＋</button>
                </span>
              </div>
              <div className="ui-field">
                <span className="ui-field-label">文字の色<span className="ui-help">明るさに応じて白か黒の縁が付く</span></span>
                <span style={{ display: 'flex', gap: 6 }}>
                  {[['#111111', '黒'], ['#ffffff', '白'], ['#e03131', '赤'], ['#1971c2', '青'], ['#2f9e44', '緑'], ['#e8590c', '橙'], ['#7048e8', '紫']].map(([c, nm]) => (
                    <button key={c} aria-label={nm} title={nm} onClick={() => setLabelColor(c)}
                      style={{ width: 20, height: 20, padding: 0, borderRadius: '50%', cursor: 'pointer', background: c,
                        border: labelColor.toLowerCase() === c ? '2px solid var(--ui-accent)' : '1px solid var(--ui-border-strong)' }} />
                  ))}
                </span>
              </div>
              <div className="ui-field">
                <span className="ui-field-label">ノードから離す<span className="ui-help">0 = ノードの中央。重なって読みにくいときに</span></span>
                <span className="ui-stepper">
                  <button aria-label="近づける" onClick={() => setLabelOffset(v => Math.max(0, v - 6))}>−</button>
                  <button className="ui-num" style={{ width: 'auto', padding: '0 6px', border: 'none' }} title="0 に戻す" onClick={() => setLabelOffset(0)}>{labelOffset}px</button>
                  <button aria-label="離す" onClick={() => setLabelOffset(v => Math.min(120, v + 6))}>＋</button>
                </span>
              </div>
            </section>
            <section className="ui-section">
              <h3>Linear</h3>
              <div className="ui-field">
                <label htmlFor="set-nblk">ブロックの数<span className="ui-help">表示範囲をいくつの区間に分けて色を付けるか</span></label>
                <input id="set-nblk" type="number" min={1} max={500} step={5} className="ui-input" style={{ width: 80 }}
                  value={travNBlocks}
                  onChange={e => { const v = Math.max(1, Math.min(500, parseInt(e.target.value, 10) || 30)); setTravNBlocks(v) }} />
              </div>
            </section>
            <section className="ui-section">
              <h3>About</h3>
              <div className="ui-kv">
                <span>viewer</span><b>{versionInfo?.viewer ?? '?'}</b>
                {versionInfo?.db && (<>
                  <span>DB</span><b>{selectedDb} · {versionInfo.db.built_at ?? (versionInfo.db.mtime?.slice(0, 16).replace('T', ' ') ?? '?')}{versionInfo.db.emitter_rev ? ` @${versionInfo.db.emitter_rev}` : ''}</b>
                  <span>DB features</span><b>{(['seq', 'inv', 'mult'] as const).filter(f => versionInfo.db!.features[f]).join(' ') || '—'}</b>
                </>)}
                <span>API</span><b>{versionInfo?.api_level ?? '?'}（必要 {API_LEVEL_REQUIRED}）</b>
                {prewarm && (prewarm.running || prewarm.finished) && (<>
                  <span>Cache</span><b>{prewarm.finished ? 'ready' : `${Math.floor(100 * prewarm.done / Math.max(1, prewarm.total))}%`}</b>
                </>)}
              </div>
              <a href={docsUrl('viewer', versionInfo?.viewer)} target="_blank" rel="noreferrer" style={{ color: 'var(--ui-accent)' }}>Help</a>
              {!devMode && <div style={{ fontSize: 11, color: 'var(--ui-faint)' }}>開発用の表示は URL に ?dev=1 を付けると出る</div>}
            </section>
          </div>
        </aside>
      </>)}

      {/* ── Edit 行（2 段目・文脈ツールバー）────────────────────────────
          ★上段は Edit の ON/OFF で**一切変わらない**。編集用のものは全部ここに出す。
            以前は上段にインライン挿入していたので、Alignment/MSA が次の行へ落ち、
            右寄せのせいで Edit ボタン自身の位置まで動いていた（ON にした所を
            もう一度押すと別のボタンだった）。
          ★Save もここに置く。編集は「DB に保存したいから」だけでなく
            「繋がりをその場で確かめるために動かしてみる」使い方もするので、
            Save は Edit の文脈の中にあるべきで、離れた場所に常駐させない。 */}
      {editMode && (
        <div className="ui-topbar" style={{ minHeight: 44, background: 'var(--ui-bg)', zIndex: 40, gap: 8 }}>
          <span style={{ fontWeight: 600 }}>Edit</span>
          <button className={'ui-btn ui-btn-sm' + (softDragMode ? ' is-on' : '')} aria-pressed={softDragMode}
            title="掴んだノードと、グラフ上で近いノードを、離れるほど弱く一緒に動かす。Shift＋ドラッグは掴んだものだけ動かす"
            onClick={() => setSoftDragMode(m => !m)}>Soft drag</button>
          {softDragMode && (<>
            <label htmlFor="sd-hops" style={{ color: 'var(--ui-muted)' }}>Radius</label>
            <input id="sd-hops" type="number" min={1} max={30} step={1} className="ui-input ui-select-sm" style={{ width: 56 }} value={softDragHops}
              title="一緒に動かす近さ（グラフ上の手数）。大きいほど遠くまで動く"
              onChange={e => { const v = parseInt(e.target.value, 10); setSoftDragHops(isNaN(v) ? 6 : Math.max(1, Math.min(30, v))) }} />
            <label htmlFor="sd-soft" style={{ color: 'var(--ui-muted)' }}>Falloff</label>
            <input id="sd-soft" type="number" min={1} max={12} step={1} className="ui-input ui-select-sm" style={{ width: 56 }} value={softDragSoftness}
              title="大きいほど近くのノードがゆるやかに広くついてくる。小さいほど掴んだ点だけ動く"
              onChange={e => { const v = parseInt(e.target.value, 10); setSoftDragSoftness(isNaN(v) ? 5 : Math.max(1, Math.min(12, v))) }} />
          </>)}
          <button className={'ui-btn ui-btn-sm' + (pendingEdits.length > 0 && !saveDisabled ? ' ui-btn-warn' : '')}
            onClick={saveNodeEdits}
            disabled={pendingEdits.length === 0 || savingEdits || saveDisabled}
            title={saveDisabled
              ? 'この配信では DB への保存を無効にしてある（サーバ側で AMIPA_READONLY=1）。動かして確かめるのは自由で、結果は保存されない'
              : '動かした・回したノードを、子孫のノードと辺ごと DB に保存する'}>
            {savingEdits ? 'Saving…' : `Save${pendingEdits.length > 0 ? ` (${pendingEdits.length})` : ''}`}
          </button>
          {saveDisabled && <span className="ui-chip" title="この配信は閲覧専用（サーバを AMIPA_READONLY=1 で起動）なので、動かした結果は DB に保存できない">Read-only server</span>}
          <span style={{ marginLeft: 'auto', color: 'var(--ui-muted)', fontSize: 'var(--ui-fs-sm)' }}>
            クリック 選択 · Shift＋クリック 追加／外す · 空き地をドラッグ 範囲選択 · ノードをドラッグ 移動 · 黄色の丸 回転 · Space＋ドラッグ 画面を動かす · Esc 解除
          </span>
        </div>
      )}


      {/* ── Main row ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* ── 左パネル: パス選択（リボン描画と MSA の対象を兼ねる） ───────── */}
        {showPaths && (
          <>
            <div style={{
              width: leftW, flexShrink: 0, overflow: 'hidden',
              background: 'var(--ui-panel)', borderRight: '1px solid var(--ui-border)',
              display: 'flex', flexDirection: 'column', fontSize: 'var(--ui-fs)', color: 'var(--ui-text)',
            }}>
              {/* 11-06 UI 見直し: 見出し＋単位の選択、絞り込み、操作の行、一覧 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px' }} title="選んだパスはリボン描画・比較・絞り込みの対象になる">
                <span style={{ fontWeight: 600, flex: 1 }}>Paths</span>
                <label htmlFor="ribbon-level" className="ui-sr">パスの単位</label>
                <select id="ribbon-level" className="ui-select ui-select-sm" value={ribbonLevel} onChange={e => setRibbonLevel(e.target.value as 'none' | RibbonLevel)}>
                  <option value="none">None</option>
                  <option value="sample">Sample</option>
                  <option value="haplotype">Haplotype</option>
                  {(ribbonContig || !ribbonHapcov) && <option value="contig">Contig</option>}
                </select>
              </div>
              {ribbonLevel === 'none' && (
                <div style={{ padding: '0 12px 12px', color: 'var(--ui-muted)', fontSize: 'var(--ui-fs-sm)', lineHeight: 1.6 }}>
                  Choose a level to list paths.
                </div>
              )}
              {ribbonLevel !== 'none' && (
                <>
                  {devMode && <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 8px' }}>
                    <span title="super-node の総塩基の θ% 以上を通れば通過。既定 0=少しでも通れば通過（表示フィルタと同じ基準）。上げると混雑は減るが、バブルは 1 ハプロタイプが総塩基の 1/アリル数しか覆えないためリボンが落ちやすい">θ {Math.round(ribbonTheta * 100)}%</span>
                    <input type="range" min={0} max={100} value={Math.round(ribbonTheta * 100)}
                      onChange={e => setRibbonTheta(Number(e.target.value) / 100)} style={{ flex: 1 }} />
                  </div>}
                  <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px' }}>
                    <label htmlFor="ribbon-q" className="ui-sr">絞り込み</label>
                    <input id="ribbon-q" type="text" className="ui-input ui-select-sm" placeholder="Filter" value={ribbonSearch}
                      onChange={e => setRibbonSearch(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                    <label htmlFor="ribbon-sort" className="ui-sr">並び</label>
                    <select id="ribbon-sort" className="ui-select ui-select-sm" value={ribbonSort} onChange={e => setRibbonSort(e.target.value as 'name' | 'cov')} title="一覧の並び">
                      <option value="name">Name</option>
                      <option value="cov">Coverage</option>
                    </select>
                  </div>
                  {(() => { const off = pathGroups.length === 0; const noSel = off || ribbonSel.size === 0
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 12px 8px', flexWrap: 'wrap', fontSize: 'var(--ui-fs-sm)' }}>
                        <span style={{ color: 'var(--ui-muted)', marginRight: 'auto' }}>{ribbonSel.size ? `${ribbonSel.size} of ${pathGroups.length}` : `${pathGroups.length} paths`}</span>
                        <button className="ui-btn ui-btn-sm ui-btn-ghost" onClick={selectAllRibbon} disabled={off} title="表示中（絞り込みの結果）を全部選ぶ">All</button>
                        <button className="ui-btn ui-btn-sm ui-btn-ghost" onClick={invertRibbon} disabled={off} title="表示中（絞り込みの結果）の選択を反転">Invert</button>
                        <button className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => { setRibbonSel(new Map()); setRibbonHidden(false) }} disabled={noSel}
                          title={ribbonSel.size ? `選択を全部外す（${ribbonSel.size} 個）` : '選択なし'}>Clear</button>
                      </div>
                    ) })()}
                  {(() => { const noSel = pathGroups.length === 0 || ribbonSel.size === 0
                    return (
                      <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px', flexWrap: 'wrap' }}>
                        <button className={'ui-btn ui-btn-sm' + (ribbonHidden ? ' is-on' : '')} onClick={() => setRibbonHidden(h => !h)} disabled={noSel}
                          title="選択は保ったまま、グラフのリボンを一時的に隠す">{ribbonHidden ? 'Show ribbons' : 'Hide ribbons'}</button>
                        {hapIdx && (
                          <button className={'ui-btn ui-btn-sm' + (hapFilter ? ' is-on' : '')} onClick={() => setHapFilter(v => !v)}
                            title={ribbonSel.size === 0 ? '選んだパスが通るノードだけ描く（先に一覧でパスを選ぶ）'
                              : hapFilter ? '選んだパスが通るノードだけ描いている（押すと全体に戻す）'
                              : `選んだパスが通るノードだけ描く。表示予算を超える場所でも深い層まで出せる（${hapIdx.nHap} hap の索引${hapIdx.mode === 'bucket' ? '・近似と厳密判定' : ''}）`}>
                            Selected only
                          </button>
                        )}
                      </div>
                    ) })()}
                  <div style={{ overflowY: 'auto', flex: 1, padding: '0 4px 8px', borderTop: '1px solid var(--ui-border)' }}>
                    {sortedPathGroups
                      .filter(g => !ribbonSearch || g.key.toLowerCase().includes(ribbonSearch.toLowerCase()))
                      .slice(0, 300).map(g => {
                        const sel = ribbonSel.get(g.key)
                        return (
                          <button key={g.key} onClick={() => toggleRibbonGroup(g)} className="ui-menu-item" aria-pressed={!!sel}
                            style={{ minHeight: 28, padding: '4px 8px', marginTop: 2, background: sel ? 'var(--ui-accent-weak)' : undefined }}>
                            <span style={{ width: 12, height: 12, borderRadius: 3, flex: '0 0 auto',
                              border: sel ? 'none' : '1px solid var(--ui-border-strong)',
                              background: sel ? '#' + sel.color.toString(16).padStart(6, '0') : 'transparent' }} />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key}</span>
                            {ribbonLevel !== 'contig' && <span style={{ color: 'var(--ui-muted)', fontSize: 'var(--ui-fs-xs)' }} title="コンティグの数">{g.n_contigs}</span>}
                          </button>
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
            }}>
              {hint.text}
            </div>
          )}
          {selectedDb && maxLayer !== null && trvColors?.filter && (
            <div style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', zIndex: 20, background: '#e7f5ff', border: '1px solid #74c0fc', borderRadius: 4, padding: '2px 8px', fontSize: 12, color: '#1864ab' }}
              title="Linear パネルの「Filter」が入っているので、表示範囲に属するノードとパスリボンだけを描いている">
              Filtered to Linear range{lodClamp ? `（表示予算超過のため layer ${lodClamp.served}）` : ''}
              {' · '}<span style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 700 }} onClick={() => { setTrvFilter(null); travApiRef.current?.setFilter(false) }}>解除</span>
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
                  selectedPaths={selectedPaths}
                  ribbons={ribbonHidden ? EMPTY_RIBBONS : ribbons}
                  layerZoom={layerZoomEff}
                  zoomWindow={lodMeta.zoomWindow}
                  worldBbox={lodMeta.world}
                  layerOffset={detailStep}
                  suppressHeavyWarning={suppressHeavy}
                  floodMode={floodMode}
                  floodResult={floodResult}
                  floodSeedComp={floodSeedComp}
                  floodMaxHop={floodHops}
                  msaHoverNodes={trvHoverSet}
                  msaHighlight={readHi}
                  msaHoverColor={trvHovColor}
                  blockColors={trvColors}
                  nodeColors={trvNodeColors.size ? new Map([...activeNodeColors, ...trvNodeColors]) : activeNodeColors}
                  onViewportChange={(vp, layer, glyphs) => {
                    setMapViewport(vp); setMapLayer(layer); travApiRef.current?.graphMoved?.()   // Traversals: 広い範囲の塗り分けは見えているノードで引き直す
                    if (glyphs !== undefined) setMapGlyphs(glyphs)
                  }}
                  onHeavyView={glyphs => setHeavyModal(prev => prev ?? glyphs)}
                  onRibbonEdited={() => { ribbonEditedRef.current = true }}
                  onNodesEdited={g => setPendingEdits(prev => [...prev, g])}
                  onNodeSelect={node => {
                    setSelectedNode(node)
                    if (trvH > 0 && node && /^n\d+$/.test(node.node_name)) travApiRef.current?.locateNodes([node.node_name])   // 通過: ノード → 座標の位置へ
                    // 近接モード: クリック点からグラフ距離フラッド。背景クリック(node=null)で解除。
                    if (floodMode) {
                      if (node) {
                        fetchFlood(selectedDb, mapLayer, node.node_name, floodHops).then(r => {
                          if (r) { setFloodResult(new Map(r.reached.map(x => [x.name, x.hop]))); setFloodSeedComp(node.comp_id ?? null) }
                        })
                      } else { setFloodResult(null); setFloodSeedComp(null) }
                    }
                    if (node) setSelectedReadAln(null)   // ノード選択でリード詳細を閉じる（直近選択優先）
                    if (!node) clearReadFocus()   // 何も無い所のクリックでリードの強調を外す（11-17）
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
                <div className="ui-float" style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 10,
                  // 編集モード中はクリックを canvas へ通し、パネル下のノードを掴めるようにする（表示は維持）
                  pointerEvents: editMode ? 'none' : undefined,
                  padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320,
                }}>
                  {devMode && (() => {
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
                      Over budget: <b>layer {lodClamp.served}</b> (needs {lodClamp.requested})
                      {trvH > 0 && !trvColors?.filter && (
                        <>
                          {' · '}
                          <span onClick={() => { travApiRef.current?.setFilter(true) }}
                            title="Linear パネルで開いている範囲に属するノードだけを描く（パネルの「Filter」を入れる）。範囲外を描かないので、同じ予算でより深い層を出せる"
                            style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 700 }}>
                            Filter to range
                          </span>
                        </>
                      )}
                      {hapIdx && (
                        <>
                          {' · '}
                          <span
                            onClick={() => {
                              if (ribbonLevel === 'none') setRibbonLevel('sample')

                              if (ribbonSel.size > 0) setHapFilter(true)
                              else showHint('パスリボンのリストでサンプル/ハプロタイプを選ぶと、'
                                + 'その経路だけに絞って深い層まで表示できます')
                            }}
                            title="選択サンプル/ハプロタイプが通るノード・エッジだけに絞ると、この層まで戻せます"
                            style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 700 }}>
                            Filter by sample
                          </span>
                        </>
                      )}
                    </div>
                  )}
                  {(() => {
                    const atDeepest = maxLayer !== null && mapLayer >= maxLayer
                    const atShallowest = mapLayer <= 0
                    const btn: React.CSSProperties = {}
                    const dis: React.CSSProperties = {}
                    const label = atDeepest ? 'Max'
                      : detailStep === 0 ? 'Auto'
                      : detailStep > 0 ? `詳細 +${detailStep}` : `簡略 ${detailStep}`
                    return (
                      <div className="ui-stepper">
                        <span style={{ color: 'var(--ui-muted)', paddingRight: 2 }} title="グラフをどこまで細かく描くか。− で粗く速く、＋ で細かく重く">Detail</span>
                        <button title="1段 軽く（簡略表示・速い）" aria-label="軽く"
                          style={{ ...btn, ...(atShallowest ? dis : {}) }} disabled={atShallowest}
                          onClick={() => setDetailStep(s => Math.max(-DETAIL_CLAMP, s - 1))}>−</button>
                        <span title="クリックで標準（自動）に戻す" onClick={() => setDetailStep(0)}
                          style={{ textAlign: 'center', color: atDeepest ? 'var(--ui-accent-strong)' : 'var(--ui-text)',
                            fontWeight: 500, minWidth: 56, cursor: 'pointer' }}>{label}</span>
                        <button title={atDeepest ? 'これ以上詳細な層はありません（最深層）' : '1段 詳しく（詳細表示・重い）'}
                          aria-label="詳しく"
                          style={{ ...btn, ...(atDeepest ? dis : {}) }} disabled={atDeepest}
                          onClick={() => setDetailStep(s => Math.min(DETAIL_CLAMP, s + 1))}>＋</button>
                        {!devMode && isLoading && <span style={{ color: 'var(--ui-muted)', paddingLeft: 2 }} title="取得中（別の場所へ動くと中断する）">Loading…</span>}
                      </div>
                    )
                  })()}
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
                        ⚠ Heavy view
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
                          Simplify
                        </button>
                        <button
                          onClick={() => closeHeavy('proceed')}
                          style={{
                            flex: 1, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                            border: '1px solid #ced4da', background: '#fff', color: '#495057', fontWeight: 600,
                          }}>
                          Continue
                        </button>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#868e96', cursor: 'pointer' }}>
                        <input type="checkbox" checked={heavyDontWarn}
                          onChange={e => setHeavyDontWarn(e.target.checked)} />
                        Don't warn again
                      </label>
                    </div>
                  </div>
                )}


                {showOverlays && (
                  <Minimap
                    key={`${selectedDb}-${mapReloadKey}`}
                    viewport={mapViewport}
                    layer={mapLayer}
                    layerZoom={layerZoomEff}
                    world={lodMeta.world}
                    zoomWindow={lodMeta.zoomWindow}
                    dbFile={selectedDb}
                    sel={hapSel}
                    clickThrough={editMode}
                    onNavigate={(cx, cy) => graphRef.current?.navigateTo(cx, cy)}
                  />
                )}
                {/* 11-16: ミニマップ・凡例の出し入れ（以前は View の中。データの表し方ではなく画面の部品なので、地図アプリのように画面の隅に） */}
                <button className={'ui-iconbtn' + (showOverlays ? ' is-on' : '')} aria-pressed={showOverlays} aria-label="ミニマップと凡例"
                  title={showOverlays ? 'ミニマップ・凡例・詳細度の箱を隠す' : 'ミニマップ・凡例・詳細度の箱を出す'}
                  style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 11, color: '#334155', background: 'rgba(255,255,255,.9)', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }}
                  onClick={() => setShowOverlays(v => !v)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="8" y="4.5" width="5" height="4" fill={showOverlays ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1" /></svg>
                </button>
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
        <div style={{ width: rightW, flexShrink: 0, overflowY: 'auto', background: 'var(--ui-panel)', borderLeft: '1px solid var(--ui-border)' }}>
          {rightW > 80 && (
            <>
            {/* 11-17: リードの検索は上部バーの Find → Read へ移した。ここは閉じるボタンと、複数当たったときの候補だけ */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 6px 0' }}>
              <button className="ui-btn ui-btn-sm" onClick={() => setRightW(0)} title="右パネルを閉じる（ノードのクリック・リードの検索でまた開く）" aria-label="右パネルを閉じる">×</button>
            </div>
            <div style={{ padding: readResults && readResults.length > 1 ? '0 14px 8px' : 0, borderBottom: readResults && readResults.length > 1 ? '1px solid var(--ui-border)' : 'none' }}>
              {readResults && readResults.length > 1 && (
                <div style={{ marginTop: 4, maxHeight: 90, overflowY: 'auto' }}>
                  {readResults.map(r => (
                    <div key={r.aln_id} onClick={() => void focusRead(r)} title={`aln_id ${r.aln_id}`}
                      style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 4px', cursor: 'pointer', borderRadius: 2,
                        background: selectedReadAln?.aln_id === r.aln_id ? '#fff3bf' : 'transparent' }}>
                      aln {r.aln_id} · {r.n_segments}節 · {r.sample_id ?? '?'}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedReadAln ? (
              <div style={{ padding: '12px 14px', fontSize: 12,
                            userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                  borderBottom: '1px solid var(--ui-border)', paddingBottom: 8, marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--ui-text)', wordBreak: 'break-all', flex: 1 }}>
                    {selectedReadAln.read_name ?? `aln_id ${selectedReadAln.aln_id}`}
                  </div>
                  <button onClick={() => { clearReadFocus(); setReadResults(null) }} title="選択と強調を解除"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#adb5bd',
                      fontSize: 15, lineHeight: 1, padding: '0 2px' }}>×</button>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {([
                      ...(devMode ? [['aln_id', selectedReadAln.aln_id]] : []),
                      ['Sample',   selectedReadAln.sample_id ?? '?'],
                      ['Strand',   selectedReadAln.strand ?? '?'],
                      ['Length',   selectedReadAln.query_len?.toLocaleString() ?? '?'],
                      ['Nodes', selectedReadAln.n_segments],
                    ] as [string, string | number][]).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ color: 'var(--ui-muted)', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>{k}</td>
                        <td style={{ color: 'var(--ui-text)', wordBreak: 'break-all' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {bottomH > 0 && <button className="ui-btn ui-btn-sm is-on" onClick={addPathToView} title="このリードが通るノードを Alignment の view にまとめて足す（既にある view へ残りを足す／無ければ新しい view）">
                    Add to Alignment
                  </button>}
                  {selectedReadAln.read_name && (
                    <button className="ui-btn ui-btn-sm" onClick={() => runReadSearch(selectedReadAln.read_name!)}>
                      Other alignments
                    </button>
                  )}
                </div>
                {/* 経路ノード（このアライメントが通る全ノード） */}
                <div style={{ marginTop: 10, borderTop: '1px solid var(--ui-border)', paddingTop: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--ui-muted)', marginBottom: 6, letterSpacing: '0.04em' }}>
                    Path ({selectedReadAln.n_segments} nodes)
                  </div>
                  {selectedReadAln.segments.map((s, i) => (
                    <div key={i} style={{ fontSize: 10, fontFamily: 'monospace', marginBottom: 6, lineHeight: 1.35 }}>
                      <div style={{ color: 'var(--ui-text)', wordBreak: 'break-all' }}>{s.node_name ?? '?'}</div>
                      <div style={{ color: 'var(--ui-muted)' }}>
                        node {s.node_start.toLocaleString()}–{s.node_end.toLocaleString()} ({s.strand}) · q {s.query_start.toLocaleString()}–{s.query_end.toLocaleString()} · mq{s.mapq ?? '?'}
                      </div>
                      <div style={{ color: 'var(--ui-muted)' }}>
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
              <div style={{ padding: '12px 14px', fontSize: 12,
                            userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ui-text)', marginBottom: 10,
                  wordBreak: 'break-all', borderBottom: '1px solid var(--ui-border)', paddingBottom: 8 }}>
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
                      ['Length',      ((v: string) => v === '—' ? v : v + ' bp')(num(selectedNode.size ?? selectedNodeInfo?.size, true))],
                      ['Type',      ((): string => {
                                      const k = selectedNode.kind ?? selectedNodeInfo?.kind
                                      return (k != null
                                        ? ({ 0: 'Leaf', 1: 'Merged', 2: 'Bubble' } as Record<number, string>)[k]
                                        : ({ n: 'Leaf', S: 'Bubble', G: 'Merged', X: 'Other' } as Record<string, string>)[selectedNode.node_name[0]]) ?? '?'
                                    })()],
                      ...(devMode ? [
                        ['size',      num(selectedNode.size ?? selectedNodeInfo?.size)],
                        ['x',         fixed(selectedNode.xCoord, 6)],
                        ['y',         fixed(selectedNode.yCoord, 6)],
                        ['angle',     Number.isFinite(selectedNode.angle) ? (selectedNode.angle * 180 / Math.PI).toFixed(1) + '°' : '—'],
                        ['radius',    fixed(selectedNode.radius, 6)],
                      ] : []),
                    ] as [string, string | number][]).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ color: 'var(--ui-muted)', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>{k}</td>
                        <td style={{ color: 'var(--ui-text)', wordBreak: 'break-all' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* A3: 参照座標(ref_bp)。クリックしたノードが ref_bp を持つときだけ表示。 */}
                {selectedNode.ref_bp != null && (
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--ui-border)', paddingTop: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--ui-muted)', marginBottom: 6, letterSpacing: '0.04em' }}>
                      Ref position{refKey ? ` (${refKey})` : ''}
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {(([
                          ['Contig', refContigs.get(Number(selectedNode.ref_contig_id))?.name ?? `#${selectedNode.ref_contig_id}`],
                          ['Position',   fmtBpDetail(Number(selectedNode.ref_bp))],
                          ...(selectedNode.ref_bp_end != null && Number(selectedNode.ref_bp_end) !== Number(selectedNode.ref_bp)
                            ? [['Span', `${fmtBpDetail(Number(selectedNode.ref_bp))} – ${fmtBpDetail(Number(selectedNode.ref_bp_end))}`]]
                            : []),
                          ['Confidence', selectedNode.ref_multi ? 'Multiple (approx.)'
                                 : selectedNode.is_anchor ? 'Exact' : 'Inferred'],
                        ] as [string, string | number][])).map(([k, v]) => (
                          <tr key={k}>
                            <td style={{ color: 'var(--ui-muted)', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>{k}</td>
                            <td style={{ color: 'var(--ui-text)', wordBreak: 'break-all' }}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* アノテーション詳細: バンド / 領域 / 遺伝子(選択ノードに重なるもの)。遺伝子クリックで hull 表示。 */}
                {(selectedNode.band_id != null || selectedNode.region_class != null || selectedNodeFeatures.length > 0) && (
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--ui-border)', paddingTop: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--ui-muted)', marginBottom: 6, letterSpacing: '0.04em' }}>Annotations</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {selectedNode.band_id != null && bandDict.get(Number(selectedNode.band_id)) && (
                          <tr>
                            <td style={{ color: 'var(--ui-muted)', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>Band</td>
                            <td style={{ color: 'var(--ui-text)' }}>{bandDict.get(Number(selectedNode.band_id))!.name}（{bandDict.get(Number(selectedNode.band_id))!.gie_stain}）</td>
                          </tr>
                        )}
                        {selectedNode.region_class != null && regionDict.get(Number(selectedNode.region_class)) && (
                          <tr>
                            <td style={{ color: 'var(--ui-muted)', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>Region</td>
                            <td style={{ color: 'var(--ui-text)' }}>{regionDict.get(Number(selectedNode.region_class))!.name}</td>
                          </tr>
                        )}
                        {selectedNode.gene_count != null && Number(selectedNode.gene_count) > 0 && (
                          <tr>
                            <td style={{ color: 'var(--ui-muted)', paddingBottom: 5, paddingRight: 8, whiteSpace: 'nowrap' }}>Genes</td>
                            <td style={{ color: 'var(--ui-text)' }}>{selectedNode.gene_count}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {selectedNodeFeatures.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: 'var(--ui-muted)', marginBottom: 3 }} title="クリックでその遺伝子の範囲を囲む">Genes</div>
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
                              <span style={{ fontSize: 10, color: 'var(--ui-muted)' }}>
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
                {/* ノードを通るパス（11-11）: ハプロタイプごとに、通る回数とコンティグ名 */}
                {nodePaths && nodePaths.available && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--ui-muted)', marginBottom: 6, letterSpacing: '0.04em' }}
                      title="このノードを通るパス（コンティグ）をハプロタイプごとにまとめたもの。×n はそのハプロタイプが通る回数">
                      Paths ({nodePaths.haps.length} haplotypes{nodePaths.total !== nodePaths.haps.length ? `, ${nodePaths.total} contigs` : ''})
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', fontSize: 12, userSelect: 'text' }}>
                      {nodePaths.haps.map(h => (
                        <div key={h.hap} style={{ display: 'flex', gap: 6, padding: '1px 0', alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{h.hap}</span>
                          {h.copies != null && h.copies > 1 && <span style={{ color: 'var(--ui-warn)', fontWeight: 600 }}>×{h.copies}</span>}
                          <span style={{ color: 'var(--ui-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.contigs.join(', ')}>{h.contigs.join(', ')}</span>
                        </div>
                      ))}
                      {!nodePaths.haps.length && <div style={{ color: 'var(--ui-muted)' }}>No paths</div>}
                    </div>
                  </div>
                )}
                {/* 葉ノードの塩基配列(leaf_seq)。葉のみ・--emit-seq 済 DB のみ。巨大配列は先頭のみ+全長取得ボタン。 */}
                {leafSeq?.available && leafSeq.leaf && leafSeq.seq != null && (
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--ui-border)', paddingTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--ui-muted)' }}>
                        Sequence · {(leafSeq.len ?? 0).toLocaleString()} bp
                      </span>
                      <button
                        onClick={() => navigator.clipboard?.writeText(leafSeq.seq ?? '')}
                        className="ui-btn ui-btn-sm" title="表示中の配列をコピー">Copy</button>
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.4, color: 'var(--ui-text)',
                      wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto',
                      background: '#f8f9fa', border: '1px solid var(--ui-border)', borderRadius: 3, padding: 6,
                      userSelect: 'text', WebkitUserSelect: 'text' }}>
                      {leafSeq.seq}
                    </div>
                    {leafSeq.truncated && !leafSeqFull && (
                      <div style={{ marginTop: 5, fontSize: 10, color: 'var(--ui-muted)' }}>
                        First {(leafSeq.seq.length).toLocaleString()} of {(leafSeq.len ?? 0).toLocaleString()} bp.
                        <button
                          onClick={() => {
                            if (!selectedDb || !selectedNode) return
                            fetchLeafSeq(selectedDb, selectedNode.node_name, true)
                              .then(r => { setLeafSeq(r); setLeafSeqFull(true) }).catch(() => {})
                          }}
                          className="ui-btn ui-btn-sm" style={{ marginLeft: 6 }}>
                          Load all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: 20, color: 'var(--ui-muted)', fontSize: 'var(--ui-fs-sm)', textAlign: 'center', marginTop: 12, lineHeight: 1.7 }}>
                Select a node to inspect.
              </div>
            )}
            </>
          )}
        </div>
      </div>

      {/* ── Bottom panel ──────────────────────────────────────────── */}
      {/* Alignment のハンドルは、閉じているときは「下に Traversals が無い」場合だけ出す。
          Traversals が開いていると、その直上にこのハンドルが来て、Traversals を広げようとした
          ドラッグが Alignment を開いてしまう（掴みしろ GRIP_PAD 分だけ下にも張り出している。11-02） */}
      {(bottomH > 0 || trvH === 0) && (
        <div
          onMouseDown={onBottomHandleDown}
          title="Drag to resize bottom panel"
          className="amipa-grip-row"
          style={{ ...handleStyle, height: HANDLE_SIZE, cursor: 'row-resize', borderTop: '1px solid #c8cdd3' }}
        />
      )}
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

      {/* ── Bottom panel 2: 通過（Traversals、錨と通過に基づくシンテニー。11-02 に Bubble MSA・Blocks パネルを外した） ─────────────── */}
      {trvH > 0 && (
        <div
          onMouseDown={onTrvHandleDown}
          title="Drag to resize Linear panel"
          className="amipa-grip-row"
          style={{ ...handleStyle, height: HANDLE_SIZE, cursor: 'row-resize', borderTop: '1px solid #c8cdd3' }}
        />
      )}
      {trvH > 0 && (
        <div style={{ height: trvH, flexShrink: 0, overflow: 'hidden', borderTop: '1px solid #c8cdd3', background: '#fff' }}>
          <TravPanel
            db={selectedDb}
            onRange={onTravRange}
            getVisibleNames={() => graphRef.current?.getVisibleNames?.() ?? []}
            getVisibleNodes={() => graphRef.current?.getVisibleNodes?.() ?? []}
            getVisibleLocs={() => graphRef.current?.getVisibleLocs?.() ?? []}
            getGraphViewport={() => mapViewportRef.current}
            onPeakHover={onTravPeakHover}
            onReadFocusClear={() => clearReadFocus(true)}
            onPeakPicked={q => {   // 山を選んだら、グラフをその山のノードの塊（2–98 パーセンタイル）に寄せる（11-05: 塊が画面の半分以上だと寄せない、にしていたら、全体表示で chrX を選んでも動かなかった）
              const [a, b, c, d] = q.full; const bw = Math.max(c - a, 1e-9), bh = Math.max(d - b, 1e-9); const px = bw * 0.15, py = bh * 0.15
              graphRef.current?.fitBounds(a - px, b - py, c + px, d + py)
            }}
            onSelectHap={hap => onBlockSelectHap(hap, hap)}
            onSelectHaps={onTravSelectHaps}
            onSelectContig={onTravSelectContig}
            onGraphRange={onTravGraphRange}
            onReady={h => { travApiRef.current = h; if (h && pendingTravState.current) { const st = pendingTravState.current; pendingTravState.current = null; setTimeout(() => h.setState(st), 1500) } if (!h) { setTrvRange(null); setTrvFilter(null); setTrvColors(null); setTrvHov(null) } }}
            onHoverNodes={onTravHover}
            hapMarks={selHapMarks}
          />
        </div>
      )}

    </div>
  )
}
