import type { GuardSink } from '../api/client'
import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import * as PIXI from 'pixi.js'
import { fetchNodes, fetchEdges, fetchPickLayer, fetchCtgPath, fetchProgress, newPid, NodeData, EdgeData, Rect, CtgPathNode, CtgPathStep, RefContig, EditGesture } from '../api/client'
import { stainToColor, GIE_COLORS, GENE_DENSITY_LOW, GENE_DENSITY_HIGH } from '../annotColors'
// §8.2 Phase 3: 図版の幾何＋SVG 直列化は backend の純粋モジュールを共有する(ヘッドレス CLI と一本化)。
import { buildGraphFigure, drawListToSvg, FIG_SCALE } from '../../../backend/src/figure/svgSerialize'
import type { FigNodeIn, FigEdgeIn, FigLabel, FigMark, LegendSection } from '../../../backend/src/figure/svgSerialize'
import {
  nodeStore, edgeStore,
  tileBbox, tilesForRect, getMissingTiles, markFetching, unmarkFetching,
  tileItemCount, tileSrcBbox,
  storeTileData, getVisibleIds, clearCache, clearLayer, areTilesCached,
  currentGeneration, isCurrentGeneration,
} from '../cache/tileCache'

// Colors for up to 12 simultaneously selected CTG paths
export const PATH_COLORS = [
  0xe03131, 0x2f9e44, 0x1971c2, 0xe67700,
  0x7048e8, 0x099268, 0xc2255c, 0x5c7cfa,
  0x862e9c, 0x66a80f, 0xe8590c, 0x0c8599,
]

// 1本のリボン = ある群が現在 layer で通過する super-node の中心列（x 昇順）。
export interface RibbonData {
  color: number
  label?: string   // 凡例用ラベル(= ribbonSel のユニット名 sample/hap/contig)
  nodes: { id: number; name: string; x: number; y: number; a: number; r: number; frac: number; inv?: boolean; invDir?: number }[]
  edges: { su: number; tv: number; sx: number; sy: number; ex: number; ey: number; inv?: boolean }[]
}

function lerpColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff
  const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff
  return ((Math.round(r1 + (r2 - r1) * t) << 16) |
          (Math.round(g1 + (g2 - g1) * t) << 8)  |
           Math.round(b1 + (b2 - b1) * t))
}

// アノテーション着色パレットは annotColors.ts に一元化(App の凡例と共有)。
// ★辞書(`/annot_dicts`)は**トグルを ON にしてから非同期に届く**。届く前は null を返して
//   ハプロタイプ色のままにする（灰色一色に塗ると「バンドが出ない」ように見える）。
//   辞書が届くと bandDict/regionDict の変更で再描画が走り、正しい色に切り替わる。
function bandToColor(bandId: number | null | undefined,
                     dict: Map<number, { gie_stain: string }>): number | null {
  if (bandId == null || dict.size === 0) return null
  const e = dict.get(bandId)
  return e ? stainToColor(e.gie_stain) : 0xadb5bd
}
function regionToColor(rc: number | null | undefined,
                       dict: Map<number, { name: string }>): number | null {
  if (rc == null || dict.size === 0) return null
  const e = dict.get(rc)
  return e ? stainToColor(e.name) : 0xadb5bd
}
function darken(c: number, f = 0.55): number {
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff
  return (Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f)
}
// 遺伝子密度: **密度(genes/Mb) = gene_count / (ref 範囲幅)** を薄→濃の紫ランプに。
// count そのままだと super-node は幅に比例して皆大=均一。密度なら密集(濃)/砂漠(薄)を判別。
// ただし小ノード(leaf: span 数百bp)で density が発散し全部最濃になるため **span に下限**を入れる
// (微小 span の1遺伝子= その1点が遺伝子内、というだけで「高密度領域」ではない)。log スケール。
const GENE_DENSITY_REF = 60    // genes/Mb でおよそ最濃(全 type: 砂漠~5, 平均~25, 密集域 100+/Mb)
const GENE_SPAN_FLOOR = 500000 // bp: density 計算の span 下限(発散防止)
function geneCountToColor(gc: number | undefined | null,
                         bp?: number | null, bpe?: number | null): number {
  if (!gc || gc <= 0) return 0xf3f0ff
  const span = (bp != null && bpe != null && bpe > bp) ? (bpe - bp) : GENE_SPAN_FLOOR
  const perMb = gc / (Math.max(span, GENE_SPAN_FLOOR) / 1e6)
  const t = Math.log(perMb + 1) / Math.log(GENE_DENSITY_REF + 1)
  return lerpColor(0xd0bfff, 0x5f3dc4, Math.min(Math.max(t, 0), 1))
}

// A2 ルーラ: 目標間隔 raw(bp) 以上で最も近い「丸い」1/2/5×10ⁿ ステップを返す。
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const base = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * base >= raw) return m * base
  return 10 * base
}

// ノード bp 数(size)を短く: 236 / 1.2K / 30.6M。クラスタ(size=配下合計bp)にもそのまま使える。
function fmtBp(bp: number): string {
  const a = Math.round(bp)
  if (a >= 1e6) { const v = a / 1e6; return (v >= 100 ? Math.round(v) : +v.toFixed(1)) + 'M' }
  if (a >= 1e3) { const v = a / 1e3; return (v >= 100 ? Math.round(v) : +v.toFixed(1)) + 'K' }
  return String(a)
}

// A2 ルーラ: 丸め目盛り値を短い単位付き文字列に(末尾ゼロは落とす: 12.5 Mb, 250 kb)。
function fmtRuler(bp: number, name?: string): string {
  const a = Math.abs(bp)
  const [v, unit] = a >= 1e6 ? [bp / 1e6, 'Mb'] : a >= 1e3 ? [bp / 1e3, 'kb'] : [bp, 'bp']
  const s = (v as number).toFixed(3).replace(/\.?0+$/, '')
  return `${name ? name + ':' : ''}${s} ${unit}`
}

// 葉ノードの尖端(side1=+hw=3'/exit 端)側の両肩を内側へ寄せる量(半長 hw に対する比)。尖端で向き(5'→3')を示す。集約(is_bubble)には適用しない。
const NODE_TIP_INSET = 0.3

// signed スキーマ(座標非保存)の edge 端点を JS で復元する。backend edgeGeom.rodAxisExpr と同式:
//   sign=±1 → node 中心 ± radius·(cosθ,sinθ)（ロッド端）, sign=0 → 相手ノード中心方向へ radius（pathless）。
function rodEndpoint(n: NodeData, sign: number, other: NodeData): [number, number] {
  if (sign === 0) {
    const dx = other.xCoord - n.xCoord, dy = other.yCoord - n.yCoord
    const dist = Math.hypot(dx, dy) || 1
    return [n.xCoord + n.radius * dx / dist, n.yCoord + n.radius * dy / dist]
  }
  return [n.xCoord + sign * n.radius * Math.cos(n.angle), n.yCoord + sign * n.radius * Math.sin(n.angle)]
}

interface Props {
  maxLayer: number
  dbFile: string
  editMode: boolean
  softDragMode: boolean   // 編集: 掴んだノード+BFS近傍を hop 減衰重みで一緒に動かす(d3-force風)
  softDragHops: number    // ソフト移動で巻き込む最大 hop 距離 D
  softDragSoftness: number // 柔らかさ(大=柔らかい): 減衰指数 p=3/softness を制御
  alignPickMode: boolean
  nodeGreyMode: boolean
  coverageTextMode: boolean
  breadthMode: boolean   // Edge width = Paths: エッジ太さ = 通過ハプロタイプ数(hb)。ノード色は不変
  maxHb: number          // Paths エッジ太さのスケール上限
  bandMode: boolean      // アノテ: color-by ギムザバンド(node_attr.band_id → gie_stain)
  regionMode: boolean    // アノテ: color-by 領域(node_attr.region_class → region_dict.name; CHM13 セントロ等)
  geneMode: boolean      // アノテ: 遺伝子密度(node_attr.gene_count)を紫ランプで(粗ズームの疎表示)
  maxGeneCount: number   // gene 密度のスケール上限
  bandDict: Map<number, import('../api/client').BandDictEntry>
  regionDict: Map<number, import('../api/client').RegionDictEntry>
  showBandLabels: boolean   // オーバーレイ: バンド名(Yq11.221 等)を代表ノードに吸着
  showRegionMarks: boolean  // オーバーレイ: 領域名(セントロメア等)を代表ノードに吸着(ランドマーク)
  showGeneLabels: boolean   // オーバーレイ: 可視 ref_bp 範囲の遺伝子名を最寄りノードに吸着(strand 矢印付き)
  geneFeatures: import('../api/client').GeneFeature[]
  selectedGene: { start: number; end: number; name: string } | null   // goto/検索で選択した1遺伝子
  selectedGeneExons: import('../api/client').GeneExon[]                 // 選択遺伝子の exon 区間(番号付き)
  // A-2 CNV(per-haplotype コピー数): 選択ユニットの cn をノードにテキスト重畳。
  cnvMode: 'off' | 'all' | 'diff'      // off / 全ユニット表示 / 差分ノードのみ
  cnvNodes: Map<string, number[]>      // node_name → 選択ユニット順の cn(0=非通過)
  cnvColors: number[]                  // 選択ユニット順の色(リボン同色)
  onCnvSuppress?: (suppressed: boolean) => void  // 可視ラベルが閾値超で描画抑制中か(トグルの⚠用)
  seqMode: boolean                     // 配列表示: 画面内の小さい葉(1bp)の塩基をノード内描画
  baseMap: Map<string, string>         // node_name → 塩基配列(viewport の小さい葉のみ)
  coverageMin: number
  nodeScale: number    // ノード長(長軸=半径)にかける倍率（構造の見えに影響。1.0=標準）
  edgeMin: number
  mapMapq: number      // 大域 mapq プリセット。この値以上のアラインのみで depth/read_support を集計（0=全件）
  // hap 絞り込み: 選択群の contig_id レンジ列（"0-23,24-33"）。空文字＝絞り込み無し。
  // 変更で全タイルを取り直す（mapq と同じ扱い）。backend にサイドカーが無ければ無視される。
  hapSel?: string
  // LOD 安全弁: 1 リクエストで受け取ってよい行数の上限（= 描いても読めない枚数）。**UX 値なので
  // client が決める**。0/未指定なら安全弁 OFF（従来どおりズームだけで層が決まり、行数も無制限）。
  maxRows?: number
  // 密すぎて要求層が出せず上位層に clamp された時の通知（null=clamp なし）。バッジ表示に使う。
  onLodClamp?: (info: { requested: number; served: number; counts?: Record<string, number> } | null) => void
  detailDepthMode: boolean
  maxEdgePx: number
  maxEdgeReads: number
  showNodeNames: boolean
  showNodeBp: boolean                 // ノードの bp 数(size)をラベル表示。クラスタは配下合計 bp
  labelScale: number                  // 全ラベル(ref bp/ノード名/遺伝子/バンド等)の一括サイズ倍率
  labelColor: number                  // ノード上ラベル(名前/bp/深度)の文字色
  labelOffset: number                 // ノード上ラベルの上方向オフセット px(>0 でノード外へずらす)
  showRefPos: boolean                 // 参照(ref_bp)上の概算 bp 位置ラベルを代表ノード近傍に重畳
  refContigs: Map<number, RefContig>  // contig_id → 表示名/長さ（bp ラベル整形用）
  nodeColors: Map<string, number>     // node_name → color（アラインビュー連動。空=無効）
  selectedPaths: Map<string, number>  // ctg_name → color (hex number)
  ribbons: RibbonData[]               // パスリボン（群ごとに通過 super-node を線で結ぶ）
  // LOD-A メタ（DB ごと・stats 由来）。layer↔camera を分離し、層は zoom だけの関数で選ぶ。
  layerZoom: number[]                 // 層別ズーム閾値の相対値 layer_zoom[L]（f(0)=1 正規化, 単調増）
  // 較正窓の規約（stats.zoom_window）。'square_side_W_over_s' なら canvas アスペクトで補正する。
  // 欠落（旧 DB）は従来式。thresholdFor 参照。
  zoomWindow?: 'square_side_W_over_s' | 'world_aspect_W_over_s'
  worldBbox: { x0: number; x1: number; y0: number; y1: number } | null
  layerOffset: number                 // 手動の詳細度オフセット（＋=1段深く / −=1段浅く）。zoom 自動層に加算
  suppressHeavyWarning: boolean       // 「今後警告しない」（セッション内）。true なら重い描画も警告せず続行
  onViewportChange?: (viewport: Rect, layer: number, glyphs?: number) => void
  onHeavyView?: (glyphs: number) => void   // settle 時に描画枚数 > cap → 警告モーダルを出す（描画は保留）
  onNodeSelect?: (node: NodeData | null) => void
  onLoadingChange?: (loading: boolean) => void
  /** 取得の進捗（取得中の行数 / 想定件数。total=0 は分母不明）。null で非表示。 */
  onFetchProgress?: (p: { rows: number; total: number } | null) => void
  // 描画の高速経路（R-Tree だけを読む）が今 有効かどうか。上部バーに出して
  // 「なぜ急に重くなったのか」が分かるようにする。理由も添える。
  onFastPath?: (v: { on: boolean; cause: 'nodebp' | 'proximity' | null }) => void
  onRibbonEdited?: () => void   // 編集でノード移動/回転しリボンを追従変異させた（App がパン再取得を止める）
  onNodesEdited?: (g: EditGesture) => void   // 移動/回転1ジェスチャ確定（DB反映用の剛体変換を報告）
  // グラフ距離フラッド（近接モード）: クリック点からの hop 距離でグリフを3層着色。
  floodMode?: boolean                        // ON でクリック→フラッド着色
  floodResult?: Map<string, number> | null   // node_name → hop（到達ノードのみ; App が /api/flood から構築）
  floodSeedComp?: number | null              // クリック点の comp_id（同一成分=融合の判定用）
  floodMaxHop?: number                       // ランプ正規化用の最大 hop（=D）
  msaHighlight?: Set<string> | null          // MSA 対象に選択中のノード名(グラフ上でリング強調)
  msaHoverNodes?: Set<string> | null         // MSA パネルで hover 中の列のノード群(強い強調。排他アレルは複数)
}

export interface GraphCanvasHandle {
  navigateTo: (cx: number, cy: number, highlightId?: number | null, targetLayer?: number) => void
  getSelectedNodes: () => NodeData[]
  // フェッチ済み(可視)サブグラフ上で A,B 間のノード名を返す(source/sink なら bubble 内部)。DB 非依存・即時。
  nodesBetween: (a: string, b: string) => string[]
  graphCounts: () => { nodes: number; edges: number }   // 可視サブグラフの規模(間を全選択の診断用)
  proceedHeavy: () => void            // 警告モーダルで「続行」→ 保留していた重い描画を実行
  reload: () => void                  // タイルキャッシュを破棄して現ビューを取り直す（DB更新後の反映用）
  exportSvg: () => void               // 8.1 図版モード: 現ビューを SVG(レイヤ付き・物理寸法)で書き出す
}

const FETCH_MARGIN  = 0.5   // プリフェッチ: ビューポートを各辺 50% 拡張
const RENDER_MARGIN = 0.05  // 描画範囲: ビューポートを各辺 5% 拡張

// タイル空間解像度 zt(L) の目標「画面内タイル数/軸」。タイル幅 ≒ ビューポート幅/K_TILES。
// タイルグリッドを表示 layer ではなく実測 layer_zoom に連動させ（B）、レイアウトの実効次元に
// 依らず 1 層あたりの fetch タイル数を一定に保つための係数。小さすぎ→1タイルが画面超で無駄取得、
// 大きすぎ→タイル過剰細分化で往復増。2〜3 が均衡点。
const K_TILES = 2.5
const ZT_MAX  = 30          // zt(L) 上限（暴走防止。2^30 グリッドで十分細かい）

// LOD-A §7: 密なビュー（hairball 等、f(n) は密度 P95 較正なので上位%は超過しうる）で描画枚数がこの
// 上限を超えたら、間引かず settle 時に「重い」警告モーダルを出して簡略表示(−)/続行をユーザーに選ばせる。
// 描画枚数の上限。**0 = 無効**。
// 以前は 6000 で、超えると maybePromote が render() を呼ばずに警告だけ出していた。
// これは UI から変えられない client 側の定数で、利用者が設定する「表示上限(maxRows)」とは
// 別物のため「無制限にしたのに描かれない」という混乱を招いた。要望により既定で無効化する。
const RENDER_CAP_NODES = Number((window as any).__amipaRenderCap ?? 0)

function expandRect(r: Rect, factor: number): Rect {
  const w = r.x2 - r.x1, h = r.y2 - r.y1
  return { x1: r.x1 - w * factor, x2: r.x2 + w * factor,
           y1: r.y1 - h * factor, y2: r.y2 + h * factor }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// LOD-A（§3.1）: 層境界 z≈f(L) での往復を防ぐヒステリシス幅。
const LOD_HYST = 0.1

function hitTestNode(n: NodeData, px: number, py: number, minW: number, scale = 1): boolean {
  const w = Math.max(n.radius * 2 * scale, minW)
  const hw = w / 2, hh = (w * 0.35) / 2
  const dx = px - n.xCoord, dy = py - n.yCoord
  const cos = Math.cos(n.angle), sin = Math.sin(n.angle)
  return Math.abs(dx * cos + dy * sin) <= hw && Math.abs(-dx * sin + dy * cos) <= hh
}

interface EdgeSnapshot {
  start_x: number; start_y: number; end_x: number; end_y: number
  startc_x: number; startc_y: number; endc_x: number; endc_y: number
}

interface PathStepSnapshot {
  from_x: number; from_y: number; from_cx: number; from_cy: number
  to_x: number; to_y: number; to_cx: number; to_cy: number
}
type PathSnapshots = Map<string, PathStepSnapshot[]>

// リボン追従用の幾何スナップショット（ribbonsRef.current と同じ並びの配列）。
type RibbonGeomSnap = {
  nodes: { x: number; y: number; a: number }[]
  edges: { sx: number; sy: number; ex: number; ey: number }[]
}[]

const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(
  { maxLayer, dbFile, editMode, softDragMode, softDragHops, softDragSoftness, alignPickMode, nodeGreyMode, coverageTextMode,
    breadthMode, maxHb, bandMode, regionMode, geneMode, maxGeneCount, bandDict, regionDict,
    showBandLabels, showRegionMarks, showGeneLabels, geneFeatures, selectedGene, selectedGeneExons,
    cnvMode, cnvNodes, cnvColors, onCnvSuppress, seqMode, baseMap, coverageMin,
    nodeScale, edgeMin, mapMapq, hapSel, maxRows, onLodClamp, detailDepthMode, maxEdgePx, maxEdgeReads, showNodeNames, showNodeBp, labelScale, labelColor, labelOffset, showRefPos, refContigs, nodeColors,
    selectedPaths, ribbons, layerZoom, zoomWindow, worldBbox, layerOffset, suppressHeavyWarning,
    floodMode, floodResult, floodSeedComp, floodMaxHop, msaHighlight, msaHoverNodes,
    onViewportChange, onHeavyView, onNodeSelect, onLoadingChange, onFetchProgress, onFastPath,
    onRibbonEdited, onNodesEdited }, ref
) {
  const containerRef    = useRef<HTMLDivElement>(null)
  const editModeRef      = useRef(editMode)
  const softDragModeRef  = useRef(softDragMode)
  const softDragHopsRef  = useRef(softDragHops)
  const softDragSoftnessRef = useRef(softDragSoftness)
  const alignPickModeRef = useRef(alignPickMode)
  const onModeChangeRef  = useRef<((m: boolean) => void) | null>(null)
  const navigateRef          = useRef<((cx: number, cy: number, highlightId?: number | null, targetLayer?: number) => void) | null>(null)
  const getSelectedNodesRef  = useRef<(() => NodeData[]) | null>(null)
  const exportSvgRef         = useRef<(() => void) | null>(null)
  const nodesBetweenRef      = useRef<((a: string, b: string) => string[]) | null>(null)
  const graphCountsRef       = useRef<(() => { nodes: number; edges: number }) | null>(null)
  const onVCRef         = useRef(onViewportChange)

  useEffect(() => {
    editModeRef.current = editMode
    onModeChangeRef.current?.(editMode)
  }, [editMode])
  useEffect(() => { softDragModeRef.current = softDragMode }, [softDragMode])
  useEffect(() => { softDragHopsRef.current = softDragHops }, [softDragHops])
  useEffect(() => { softDragSoftnessRef.current = softDragSoftness }, [softDragSoftness])

  useEffect(() => { alignPickModeRef.current = alignPickMode }, [alignPickMode])

  useEffect(() => { onVCRef.current = onViewportChange }, [onViewportChange])
  const onProgRef = useRef(onFetchProgress)
  useEffect(() => { onProgRef.current = onFetchProgress }, [onFetchProgress])

  const onNodeSelectRef  = useRef(onNodeSelect)
  const onLoadingRef     = useRef(onLoadingChange)
  const onRibbonEditedRef = useRef(onRibbonEdited)
  const onNodesEditedRef = useRef(onNodesEdited)
  const highlightIdRef   = useRef<number | null>(null)
  useEffect(() => { onNodeSelectRef.current  = onNodeSelect   }, [onNodeSelect])
  useEffect(() => { onLoadingRef.current     = onLoadingChange }, [onLoadingChange])
  useEffect(() => { onRibbonEditedRef.current = onRibbonEdited }, [onRibbonEdited])
  useEffect(() => { onNodesEditedRef.current = onNodesEdited }, [onNodesEdited])
  useEffect(() => {
    nodeGreyModeRef.current = nodeGreyMode
    renderRef.current?.()
  }, [nodeGreyMode])

  useEffect(() => {
    floodModeRef.current = !!floodMode
    floodResultRef.current = floodResult ?? null
    floodSeedCompRef.current = floodSeedComp ?? null
    floodMaxHopRef.current = floodMaxHop ?? 10
    renderRef.current?.()
  }, [floodMode, floodResult, floodSeedComp, floodMaxHop])

  useEffect(() => { msaHiRef.current = msaHighlight ?? null; renderRef.current?.() }, [msaHighlight])
  useEffect(() => { msaHoverRef.current = msaHoverNodes ?? null; renderRef.current?.() }, [msaHoverNodes])

  // Edge width = Paths(breadth=hb)。値は edge fetch に相乗り済なので再描画のみで反映。
  useEffect(() => { breadthModeRef.current = breadthMode; renderRef.current?.() }, [breadthMode])

  // アノテ着色モード(band/region/gene 密度)と辞書。値(band_id/gene_count/region_class)は D2 で
  // 「そのモードが on の時だけ」node fetch に相乗りする(下の fetchedNx 効果が有効化時に reload)。辞書は起動時取得済。
  useEffect(() => { bandModeRef.current = bandMode; renderRef.current?.() }, [bandMode])
  useEffect(() => { regionModeRef.current = regionMode; renderRef.current?.() }, [regionMode])
  useEffect(() => { geneModeRef.current = geneMode; renderRef.current?.() }, [geneMode])
  useEffect(() => { maxGeneCountRef.current = maxGeneCount; renderRef.current?.() }, [maxGeneCount])
  useEffect(() => { bandDictRef.current = bandDict; renderRef.current?.() }, [bandDict])
  useEffect(() => { regionDictRef.current = regionDict; renderRef.current?.() }, [regionDict])
  useEffect(() => { showBandLabelsRef.current = showBandLabels; renderRef.current?.() }, [showBandLabels])
  useEffect(() => { showRegionMarksRef.current = showRegionMarks; renderRef.current?.() }, [showRegionMarks])
  useEffect(() => { showGeneLabelsRef.current = showGeneLabels; renderRef.current?.() }, [showGeneLabels])
  useEffect(() => { geneFeaturesRef.current = geneFeatures; renderRef.current?.() }, [geneFeatures])
  useEffect(() => { selectedGeneRef.current = selectedGene; renderRef.current?.() }, [selectedGene])
  useEffect(() => { selectedGeneExonsRef.current = selectedGeneExons; renderRef.current?.() }, [selectedGeneExons])
  // D2: node fetch に相乗りさせる annotation 群(hb=breadth / band / region / gene)。cache が既に保持する群の
  // 集合を fetchedNxRef に持ち、fetchNodes はこれを nx として送る。表示モードが未保持の群を要求したら union して
  // reload(=その列付きで取り直す)。モードを off にしても縮小・reload はしない(単調増加=off 切替で無駄取得しない)。
  // 何も使わない通常ブラウジングでは nx が空のまま → backend は node_contig_cov/node_annot への JOIN を一切しない。
  const fetchedNxRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const need: string[] = []
    if (breadthMode) need.push('hb')
    if (bandMode) need.push('band')
    if (regionMode) need.push('region')
    if (geneMode) need.push('gene')
    let grew = false
    for (const g of need) if (!fetchedNxRef.current.has(g)) { fetchedNxRef.current.add(g); grew = true }
    if (grew) reloadRef.current?.()   // 新しい列が要る → キャッシュを取り直す(mapq 変更と同じ扱い)
  }, [breadthMode, bandMode, regionMode, geneMode])

  // `fast` は上の nx 群と **極性が逆**の宣言: 「幾何だけあれば描ける」＝ backend は
  // `nodes` 表を読まず R-Tree の補助列だけで返す（WG cold 実測で /nodes が 7.5-9.3x、
  // 補助列を太らせた実効は約 2-3x 見込み。functions/covpack/RESULTS.md §12-13）。
  // 補助列を持たない DB では backend が黙って従来経路に落ちるので、常に付けて安全。
  //
  // 高速経路が返さない列は `size` と `comp_id` だけ（`color`/`is_bubble`/`kind` は描画で未使用）。
  // よって外すのは:
  //   size    … bp ラベル(showNodeBp)を出しているとき
  //   comp_id … Proximity で **実際にノードをクリックした後**。トグルを ON にしただけでは
  //             floodResult が null で着色ブロックごと通らないので comp_id は要らない
  //             （= 探索中ずっと高速経路のままでいられる）。
  // 一度外したら戻さない（上の nx 群と同じ単調規則。トグル往復で毎回 reload しない）。
  const fastOkRef = useRef(true)
  const onFastPathRef = useRef(onFastPath)
  onFastPathRef.current = onFastPath
  // ★以前は「一度外したら戻さない」だったが、Node bp を一度触っただけで**そのセッションの間
  //   ずっと従来経路**になり、しかも画面には何も出ないので気付けなかった（全ゲノムの深層で
  //   桁が変わる）。要らなくなったら戻す。往復での reload 連発は 400ms のディレイで抑える。
  useEffect(() => {
    const cause: 'nodebp' | 'proximity' | null = showNodeBp ? 'nodebp'
      : (!!floodMode && floodResult != null && floodSeedComp != null) ? 'proximity'
      : null
    const want = cause === null
    if (want === fastOkRef.current) return
    const t = setTimeout(() => {
      if (want === fastOkRef.current) return
      fastOkRef.current = want
      onFastPathRef.current?.({ on: want, cause })
      reloadRef.current?.()   // 列の要不要が変わった → 取り直す
    }, 400)
    return () => clearTimeout(t)
  }, [showNodeBp, floodMode, floodResult, floodSeedComp])
  useEffect(() => { maxHbRef.current = maxHb; renderRef.current?.() }, [maxHb])
  useEffect(() => { cnvModeRef.current = cnvMode; renderRef.current?.() }, [cnvMode])
  useEffect(() => { cnvNodesRef.current = cnvNodes; renderRef.current?.() }, [cnvNodes])
  useEffect(() => { cnvColorsRef.current = cnvColors; renderRef.current?.() }, [cnvColors])
  useEffect(() => { seqModeRef.current = seqMode; renderRef.current?.() }, [seqMode])
  useEffect(() => { baseMapRef.current = baseMap; renderRef.current?.() }, [baseMap])

  useEffect(() => {
    coverageTextModeRef.current = coverageTextMode
    renderRef.current?.()
  }, [coverageTextMode])

  useEffect(() => {
    coverageMinRef.current = coverageMin
    renderRef.current?.()
  }, [coverageMin])

  useEffect(() => {
    nodeScaleRef.current = nodeScale
    renderRef.current?.()
  }, [nodeScale])

  useEffect(() => {
    edgeMinRef.current = edgeMin
    renderRef.current?.()
  }, [edgeMin])

  // 大域 mapq の変更は coverage/read_support の値そのものを変える（サーバ側の集計列が変わる）ので、
  // キャッシュを破棄して現在のビューポートを取り直す必要がある（再描画だけでは不十分）。
  useEffect(() => {
    mapMapqRef.current = mapMapq
    reloadRef.current?.()
  }, [mapMapq])
  // hap 絞り込みの変更は取得内容そのものが変わるので、mapq と同様に全タイル破棄して取り直す。
  // （タイルキーに絞り込みを混ぜる代わりに全クリアする。切替は稀・整合性優先。）
  useEffect(() => {
    hapSelRef.current = hapSel ?? ''
    reloadRef.current?.()
  }, [hapSel])
  // maxRows は「取得してよい行数」なのでキャッシュ内容が変わる → mapq と同様に取り直す。
  useEffect(() => {
    const prev = maxRowsRef.current
    maxRowsRef.current = maxRows ?? 0
    if (prev !== (maxRows ?? 0)) reloadRef.current?.()
  }, [maxRows])
  useEffect(() => { onLodClampRef.current = onLodClamp }, [onLodClamp])

  useEffect(() => {
    detailDepthModeRef.current = detailDepthMode
    renderRef.current?.()
  }, [detailDepthMode])

  useEffect(() => { maxEdgePxRef.current    = maxEdgePx    }, [maxEdgePx])
  useEffect(() => { maxEdgeReadsRef.current = maxEdgeReads }, [maxEdgeReads])
  useEffect(() => { showNodeNamesRef.current = showNodeNames; renderRef.current?.() }, [showNodeNames])
  useEffect(() => { showNodeBpRef.current = showNodeBp; renderRef.current?.() }, [showNodeBp])
  useEffect(() => { labelScaleRef.current = labelScale; renderRef.current?.() }, [labelScale])
  useEffect(() => { labelColorRef.current = labelColor; renderRef.current?.() }, [labelColor])
  useEffect(() => { labelOffsetRef.current = labelOffset; renderRef.current?.() }, [labelOffset])
  useEffect(() => { showRefPosRef.current = showRefPos; renderRef.current?.() }, [showRefPos])
  useEffect(() => { refContigsRef.current = refContigs; renderRef.current?.() }, [refContigs])
  useEffect(() => { nodeColorsRef.current = nodeColors; renderRef.current?.() }, [nodeColors])
  useEffect(() => { ribbonsRef.current = ribbons; renderRibbonsRef.current?.() }, [ribbons])

  interface PathCache { nodes: CtgPathNode[]; steps: CtgPathStep[] }
  // Path cache: ctg_name → {nodes, steps}
  const pathCacheRef = useRef<Map<string, PathCache>>(new Map())
  const selectedPathsRef = useRef(selectedPaths)
  const pathLayerRef = useRef<PIXI.Graphics | null>(null)
  const renderPathsRef = useRef<(() => void) | null>(null)
  const renderRef = useRef<(() => void) | null>(null)
  const reloadRef = useRef<(() => void) | null>(null)
  const mapMapqRef          = useRef(mapMapq)
  const hapSelRef           = useRef(hapSel ?? '')
  const maxRowsRef          = useRef(maxRows ?? 0)
  const onLodClampRef       = useRef(onLodClamp)
  const floodModeRef        = useRef(!!floodMode)
  const floodResultRef      = useRef<Map<string, number> | null>(floodResult ?? null)
  const floodSeedCompRef    = useRef<number | null>(floodSeedComp ?? null)
  const floodMaxHopRef      = useRef(floodMaxHop ?? 10)
  const msaHiRef            = useRef<Set<string> | null>(msaHighlight ?? null)
  const msaHoverRef         = useRef<Set<string> | null>(msaHoverNodes ?? null)
  const nodeGreyModeRef     = useRef(nodeGreyMode)
  const breadthModeRef      = useRef(breadthMode)
  const bandModeRef         = useRef(bandMode)
  const regionModeRef       = useRef(regionMode)
  const geneModeRef         = useRef(geneMode)
  const maxGeneCountRef     = useRef(maxGeneCount)
  const bandDictRef         = useRef(bandDict)
  const regionDictRef       = useRef(regionDict)
  const showBandLabelsRef   = useRef(showBandLabels)
  const showRegionMarksRef  = useRef(showRegionMarks)
  const showGeneLabelsRef   = useRef(showGeneLabels)
  const geneFeaturesRef     = useRef(geneFeatures)
  const selectedGeneRef     = useRef(selectedGene)
  const selectedGeneExonsRef = useRef(selectedGeneExons)
  const maxHbRef            = useRef(maxHb)
  const cnvModeRef          = useRef(cnvMode)
  const cnvNodesRef         = useRef(cnvNodes)
  const cnvColorsRef        = useRef(cnvColors)
  const seqModeRef          = useRef(seqMode)
  const baseMapRef          = useRef(baseMap)
  const onCnvSuppressRef    = useRef(onCnvSuppress)
  onCnvSuppressRef.current  = onCnvSuppress
  const coverageTextModeRef = useRef(coverageTextMode)
  const coverageMinRef      = useRef(coverageMin)
  const nodeScaleRef     = useRef(nodeScale)
  const edgeMinRef          = useRef(edgeMin)
  const detailDepthModeRef  = useRef(detailDepthMode)
  const maxEdgePxRef        = useRef(maxEdgePx)
  const maxEdgeReadsRef     = useRef(maxEdgeReads)
  const showNodeNamesRef    = useRef(showNodeNames)
  const showRefPosRef       = useRef(showRefPos)
  const showNodeBpRef       = useRef(showNodeBp)
  const labelScaleRef       = useRef(labelScale)
  const labelColorRef       = useRef(labelColor)
  const labelOffsetRef      = useRef(labelOffset)
  const refContigsRef       = useRef(refContigs)
  const nodeColorsRef       = useRef(nodeColors)
  const ribbonsRef          = useRef(ribbons)
  const ribbonLayerRef      = useRef<PIXI.Graphics | null>(null)
  const renderRibbonsRef    = useRef<(() => void) | null>(null)
  const textLayerRef        = useRef<PIXI.Container | null>(null)
  // LOD-A: DB メタと実行時ノブ。effect の再実行を避けるため ref 経由で読む。
  const layerZoomRef  = useRef(layerZoom)
  const zoomWindowRef = useRef(zoomWindow)
  const worldBboxRef  = useRef(worldBbox)
  const layerOffsetRef = useRef(layerOffset)
  const reevalRef     = useRef<(() => void) | null>(null)  // 層を即再評価（ノブ変更・続行用）
  // 初期ビューを worldBbox に合わせる。worldBbox は /stats 由来で PIXI 初期化後に届くので、
  // 「まだ合わせていない(fitPending)」ときに届いたら一度だけ fitToWorld() する。
  // PIXI effect が作り直されるたびに張り替える（古い app を掴んだままにしないこと）。
  const fitToWorldRef = useRef<((notify?: boolean) => boolean) | null>(null)
  const fitPendingRef = useRef(false)
  // §7 重さ警告: settle 時に描画枚数が cap 超なら描画を止めて警告。suppress=セッション抑制, proceed=続行。
  const heavySuppressRef = useRef(suppressHeavyWarning)
  const heavyProceedRef  = useRef(false)
  const onHeavyRef       = useRef(onHeavyView)
  const proceedHeavyRef  = useRef<(() => void) | null>(null)
  useEffect(() => {
    layerZoomRef.current = layerZoom; worldBboxRef.current = worldBbox
    zoomWindowRef.current = zoomWindow
    // worldBbox が届いたら初期ビューをフィットさせる（URL でビュー指定がある場合は fitPending=false）。
    // ★DB 切替時のフィットはこの effect ではやらない。下の PIXI effect が [maxLayer, dbFile] 依存で
    //   作り直され、その初期化ブロックが URL 判定込みで fitPending を立て直すため。
    //   ここに dbFile 依存を足すと、React が **全 cleanup を先に実行してから effect を順に mount**
    //   する順序のせいで「app.destroy() 済み・PIXI 再初期化前」に古いクロージャを呼んでしまう
    //   （実際に `Cannot destructure property 'width' of 'app.screen'` でクラッシュした）。
    if (worldBbox && fitPendingRef.current && fitToWorldRef.current?.(true)) {
      fitPendingRef.current = false
    } else {
      reevalRef.current?.()  // 較正メタだけ変わった場合。フィット時は onViewportChanged が同じ事をする
    }
  }, [layerZoom, worldBbox, zoomWindow])
  useEffect(() => { layerOffsetRef.current = layerOffset; reevalRef.current?.() }, [layerOffset])
  useEffect(() => { onHeavyRef.current = onHeavyView }, [onHeavyView])
  // 抑制が有効化されたら（今後警告しない）、待機中の重い描画を解禁して再評価。
  useEffect(() => { heavySuppressRef.current = suppressHeavyWarning; if (suppressHeavyWarning) reevalRef.current?.() },
    [suppressHeavyWarning])

  // Sync selectedPaths and trigger path rendering
  useEffect(() => {
    selectedPathsRef.current = selectedPaths

    // Fetch missing paths then redraw
    const fetchAndRender = async () => {
      const toFetch = [...selectedPaths.keys()].filter(n => !pathCacheRef.current.has(n))
      await Promise.all(toFetch.map(async name => {
        const data = await fetchCtgPath(dbFile, name)
        if (data) {
          pathCacheRef.current.set(name, {
            nodes: data.nodes,
            steps: data.steps.map(s => ({ ...s })),  // mutable copies for path following
          })
        }
      }))
      // Remove cached paths no longer selected
      for (const k of pathCacheRef.current.keys())
        if (!selectedPaths.has(k)) pathCacheRef.current.delete(k)
      renderPathsRef.current?.()
    }
    fetchAndRender()
  }, [selectedPaths, dbFile])

  useImperativeHandle(ref, () => ({
    navigateTo: (cx, cy, highlightId?, targetLayer?) =>
      navigateRef.current?.(cx, cy, highlightId, targetLayer),
    getSelectedNodes: () => getSelectedNodesRef.current?.() ?? [],
    nodesBetween: (a, b) => nodesBetweenRef.current?.(a, b) ?? [],
    graphCounts: () => graphCountsRef.current?.() ?? { nodes: 0, edges: 0 },
    proceedHeavy: () => proceedHeavyRef.current?.(),
    reload: () => reloadRef.current?.(),
    exportSvg: () => exportSvgRef.current?.(),
  }))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const el = container

    // ── PixiJS セットアップ ───────────────────────────────────────────
    // WebGL が使えないと PIXI.Application のコンストラクタが
    // `Unable to auto-detect a suitable renderer.` を投げる（PIXI v7 は isWebGLSupported() が
    // false のときここで throw）。素通しすると React が GraphCanvas ごと unmount して
    // **白画面＋コンソールエラーだけ**になり、「DB が開けない」ようにしか見えない。
    // 実際の原因はブラウザ側（GPU プロセス異常 / ハードウェアアクセラレーション無効 /
    // WebGL context 上限〜16 の枯渇＝viewer タブの開きすぎ）なので、画面上で切り分けられるようにする。
    let app: PIXI.Application
    try {
      app = new PIXI.Application({
        width: container.clientWidth, height: container.clientHeight,
        backgroundColor: 0xffffff, antialias: true,
        resolution: window.devicePixelRatio || 1, autoDensity: true,
        autoStart: false,   // オンデマンド描画: 60fps 回しっぱなしをやめ、変化フレームだけ GPU 描画する（下の ticker gate）。
      })
    } catch (e) {
      container.innerHTML = ''
      const box = document.createElement('div')
      box.style.cssText = 'padding:24px;font-family:sans-serif;font-size:14px;line-height:1.9;color:#495057'
      box.innerHTML =
        '<div style="font-size:16px;font-weight:600;color:#e03131;margin-bottom:10px">' +
        'WebGL が利用できないため、グラフを描画できません</div>' +
        '<div style="margin-bottom:10px">DB やサーバ側の問題ではありません（データは取得できています）。' +
        'ブラウザが WebGL コンテキストを作成できていません。</div>' +
        '<ol style="margin:0 0 12px 20px;padding:0">' +
        '<li>他の viewer タブを閉じて再読み込み（WebGL context はブラウザ全体で ~16 個が上限）</li>' +
        '<li>ブラウザを<b>完全に終了</b>して起動し直す（ウィンドウを閉じるだけでは GPU プロセスが残る）</li>' +
        '<li><code>chrome://gpu</code> の <b>Graphics Feature Status</b> と <b>Problems Detected</b> を確認</li>' +
        '<li>暫定回避: Chrome を <code>--enable-unsafe-swiftshader</code> 付きで起動（ソフトウェア WebGL・低速）</li>' +
        '</ol>' +
        '<div style="color:#868e96;font-size:13px">切り分け: ' +
        '<a href="https://get.webgl.org/" target="_blank" rel="noreferrer">get.webgl.org</a>' +
        ' が同じく失敗するならブラウザ/ドライバ側の問題です。別ブラウザでも試してください。</div>' +
        '<pre style="margin-top:12px;color:#868e96;font-size:12px;white-space:pre-wrap">' +
        String(e) + '</pre>'
      container.appendChild(box)
      return
    }
    container.appendChild(app.view as HTMLCanvasElement)

    const world = new PIXI.Container()
    app.stage.addChild(world)
    const edgeLayer = new PIXI.Graphics()
    const nodeLayer = new PIXI.Graphics()
    const pathLayer = new PIXI.Graphics()
    world.addChild(edgeLayer)
    world.addChild(nodeLayer)
    world.addChild(pathLayer)  // on top of nodes
    pathLayerRef.current = pathLayer
    const ribbonLayer = new PIXI.Graphics()
    world.addChild(ribbonLayer)  // パスリボンは最前面
    ribbonLayerRef.current = ribbonLayer
    const uiLayer = new PIXI.Graphics()
    app.stage.addChild(uiLayer)
    const textLayer = new PIXI.Container()
    app.stage.addChild(textLayer)
    textLayerRef.current = textLayer

    // ── オンデマンド描画（複数タブでの GPU 焼き付き対策） ─────────────────────
    // 既定の PIXI ticker は毎フレーム app.render() を呼び、操作していなくても 60fps で GPU を回し続ける。
    // viewer タブを複数開くと、それぞれが常時 GPU を焼き続け、共有 GPU プロセスが飽和してブラウザ全体が
    // 重くなる（1 タブ閉じても復帰しない）。そこで autoStart:false にし、scene graph を書き換える描画関数
    // （render/renderUi/renderPaths/renderRibbons）が needsRender を立て、ticker はそのフレームだけ実際に
    // 描画する。ticker 自体の rAF ループのコストはごく小さく、idle タブの GPU/CPU 使用はほぼゼロになる。
    let needsRender = true
    const markDirty = () => { needsRender = true }
    app.ticker.add(() => { if (needsRender) { needsRender = false; app.render() } })
    app.ticker.start()

    // 初期ビュー: URL 指定があればそれ、無ければ **worldBbox にフィット**。
    //
    // ★以前は URL 無しのとき `zoom = clientWidth` / `position = (0, clientHeight*0.3)` という
    //   決め打ちで、world が [0,1]x[0,~0.5] の上寄りにある前提だった。実際のグラフは横長の帯で
    //   y の中央付近を占める（実測 world y: WG PGGB [0.225,0.782] / MC [0.242,0.760] /
    //   chr22 [0.429,0.569]）。1600x900 だとこの決め打ちで見える world y は [-0.169,+0.394] で、
    //   **グラフの高さの 3 割しか視野に入らず**、しかも画面下側に寄って出る
    //   （chr22 に至っては 0.429 > 0.394 で視野から完全に外れ、clampCamera に救われていた）。
    // ★worldBbox は /stats 由来なので **PIXI 初期化のこの時点ではまだ null**。
    //   届いた時点で一度だけ合わせ直す（fitPendingRef → worldBbox の effect で発火）。
    const fitToWorld = (notify = false) => {
      // ★app が破棄済み（DB 切替の cleanup 後）なら何もしない。ref 越しに呼ばれるので、
      //   自分が生きているかは自分で確かめる必要がある。
      if (!app.screen || (app as unknown as { renderer: unknown }).renderer == null) return false
      const b = worldBboxRef.current
      const cw = container.clientWidth, ch = container.clientHeight
      if (!b || !(b.x1 > b.x0) || !(b.y1 > b.y0) || cw <= 0 || ch <= 0) return false
      const M = 1.04                                   // 端に少し余白を残す
      const zoom = Math.min(cw / ((b.x1 - b.x0) * M), ch / ((b.y1 - b.y0) * M))
      if (!isFinite(zoom) || zoom <= 0) return false
      world.scale.set(zoom)
      world.position.set(cw / 2 - ((b.x0 + b.x1) / 2) * zoom,
                         ch / 2 - ((b.y0 + b.y1) / 2) * zoom)
      // 初期化中(notify=false)はこの後の通常の初期フローに任せる。あとから worldBbox が届いて
      // 合わせ直した時だけ、通常のカメラ操作と同じ経路（層の選び直し＋再取得＋再描画）を通す。
      if (notify) onViewportChanged()
      return true
    }
    fitToWorldRef.current = fitToWorld

    // ── 8.1 図版モード: 現ビューを SVG で書き出す ──────────────────────────
    // 画面(WebGL)と同じ幾何(ノード=5点尖端グリフ / エッジ=線)・同じ色ロジックを再構成する。
    // ★深いズーム(WG では vw~1e-6)では絶対 world 座標＋固定小数桁だと精度が崩壊するので、
    //   現ビューポートを **等方に 0..SCALE の図版座標へ写して**から出す(=floating origin と同趣旨)。
    // レイヤは名前付き <g>、物理寸法(mm)指定、版/DB 刻印つき。対話状態(flood/対応色/grey)は出さない。
    exportSvgRef.current = () => {
      const vp = getViewport()
      const W = vp.x2 - vp.x1, H = vp.y2 - vp.y1
      if (!(W > 0 && H > 0)) return
      const zoom = world.scale.x
      const nodeScl = nodeScaleRef.current
      const hex = (c: number) => '#' + (c & 0xffffff).toString(16).padStart(6, '0')
      const inVp = (x: number, y: number, pad: number) =>
        x + pad >= vp.x1 && x - pad <= vp.x2 && y + pad >= vp.y1 && y - pad <= vp.y2
      // 図版座標変換(等方): world (x,y) → ((x-vp.x1)*k, (y-vp.y1)*k)。数値で返す(リボン/ラベルの点列に使う)。
      const SCALE = FIG_SCALE, k = SCALE / W
      const px = (x: number) => (x - vp.x1) * k
      const py = (y: number) => (y - vp.y1) * k

      // エッジ/ノードの「幾何」は共有 buildGraphFigure に委ねる。ここでは入力(＋ノードの色)を作るだけ。
      const isBreadth = breadthModeRef.current, isDetail = detailDepthModeRef.current
      const edgeWidthMode = isBreadth ? 'paths' : isDetail ? 'reads' : 'off'
      const figEdges: FigEdgeIn[] = visibleEdges.map(e => ({
        source: e.source, target: e.target,
        start_x: e.start_x, start_y: e.start_y, end_x: e.end_x, end_y: e.end_y,
        edge_hb: e.edge_hb, read_support: e.read_support,
      }))
      // ノード色: アノテ着色 or ハプロタイプ(従来 exportSvg と同一)。5点グリフ幾何は buildGraphFigure。
      const figNodes: FigNodeIn[] = visibleNodes.map(n => {
        const annot: number | null =
            bandModeRef.current   ? bandToColor(n.band_id, bandDictRef.current)
          : regionModeRef.current ? regionToColor(n.region_class, regionDictRef.current)
          : geneModeRef.current   ? geneCountToColor(n.gene_count, n.ref_bp, n.ref_bp_end)
          : null
        // ノードの既定色（アノテ着色が無いとき）。以前はここで `nodes.haplotype` を見て
        // a/b/m を塗り分けていたが、その列は emitter が is_bubble を letter で書き直しただけの
        // 重複で、ハプロタイプの意味は無かった（列ごと廃止）。
        const fill = annot != null ? annot : 0x228be6
        const line = annot != null ? darken(annot) : 0x1864ab
        return { node_name: n.node_name, xCoord: n.xCoord, yCoord: n.yCoord, radius: n.radius, angle: n.angle,
                 fill: hex(fill), stroke: hex(line) }
      })

      // パスリボン → FigMark[](renderRibbons と同じステガー/逆位帯。seg は figure 座標の点列を返す)。
      const ribbonMarks: FigMark[] = []
      {
        const ribs = ribbonsRef.current || []
        const rW = 3 / zoom, rhalf = rW / 2, STAGGER = rW * 1.6, scale = nodeScl
        const seg = (ax: number, ay: number, bx: number, by: number, h: number) => {
          let dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy)
          if (len < rW) {
            const mx = (ax + bx) / 2, my = (ay + by) / 2
            if (len < 1e-12) { dx = 1; dy = 0; len = 1 }
            const ux = dx / len, uy = dy / len
            ax = mx - ux * rhalf; ay = my - uy * rhalf; bx = mx + ux * rhalf; by = my + uy * rhalf
            dx = bx - ax; dy = by - ay; len = rW
          }
          const qx = -dy / len * h, qy = dx / len * h
          return [{ x: px(ax + qx), y: py(ay + qy) }, { x: px(bx + qx), y: py(by + qy) },
                  { x: px(bx - qx), y: py(by - qy) }, { x: px(ax - qx), y: py(ay - qy) }]
        }
        ribs.forEach((rib, ri) => {
          if (!((rib.nodes && rib.nodes.length) || (rib.edges && rib.edges.length))) return
          const off = (ri - (ribs.length - 1) / 2) * STAGGER
          const ctr = scale !== 1 ? new Map(rib.nodes.map(n => [n.id, n])) : null
          const col = hex(rib.color)
          for (const e of rib.edges) {
            let sx = e.sx, sy = e.sy, ex = e.ex, ey = e.ey
            if (ctr) {
              const s = ctr.get(e.su), t = ctr.get(e.tv)
              if (s) { sx = s.x + (e.sx - s.x) * scale; sy = s.y + (e.sy - s.y) * scale }
              if (t) { ex = t.x + (e.ex - t.x) * scale; ey = t.y + (e.ey - t.y) * scale }
            }
            if (!inVp(sx, sy, rhalf) && !inVp(ex, ey, rhalf)) continue
            ribbonMarks.push({ pts: seg(sx, sy + off, ex, ey + off, rhalf), fill: col, opacity: 0.9 })
            if (e.inv) ribbonMarks.push({ pts: seg(sx, sy + off, ex, ey + off, rhalf * 1.7), fill: '#111111', opacity: 0.95 })
          }
          for (const n of rib.nodes) {
            const nb = n.r * scale
            if (!inVp(n.x, n.y, nb)) continue
            const dx = Math.cos(n.a) * nb, dy = Math.sin(n.a) * nb
            ribbonMarks.push({ pts: seg(n.x - dx, n.y - dy + off, n.x + dx, n.y + dy + off, rhalf), fill: col, opacity: 0.9 })
            if (n.inv) ribbonMarks.push({ pts: seg(n.x - dx, n.y - dy + off, n.x + dx, n.y + dy + off, rhalf * 1.7), fill: '#111111', opacity: 0.95 })
          }
        })
      }

      const stamp = `amipa · ${dbFile} · cx=${((vp.x1 + vp.x2) / 2).toFixed(6)} cy=${((vp.y1 + vp.y2) / 2).toFixed(6)} vw=${W.toExponential(3)}`

      // ラベル: emitText を1回 render で捕捉→FigLabel[](screen→figure)。表示トグルどおり(showRefPos 等)出る。
      const figLabels: FigLabel[] = []
      try {
        svgLabelCapture = []
        render()
        const caps = svgLabelCapture; svgLabelCapture = null
        const anch = (a: number): 'start' | 'middle' | 'end' => a <= 0.25 ? 'start' : a >= 0.75 ? 'end' : 'middle'
        const bl = (a: number) => a <= 0.25 ? 'text-before-edge' : a >= 0.75 ? 'text-after-edge' : 'central'
        for (const L of caps) {
          const fx = px((L.x - world.position.x) / zoom), fy = py((L.y - world.position.y) / zoom)
          const ffs = L.fs * k / zoom
          const lum = ((L.fill >> 16 & 255) * 299 + (L.fill >> 8 & 255) * 587 + (L.fill & 255) * 114) / 1000
          const halo = L.stroke ? ` stroke="${lum > 150 ? '#111111' : '#ffffff'}" stroke-width="${(ffs * 0.3).toFixed(3)}" paint-order="stroke"` : undefined
          figLabels.push({ x: fx, y: fy, text: L.text, fs: ffs, fill: hex(L.fill), anchor: anch(L.ax), baseline: bl(L.ay), halo })
        }
      } catch { svgLabelCapture = null }

      // 凡例 → LegendSection[]。band=可視ステイン / region=領域名 / gene=密度グラデ ＋ path ribbons。
      // ★ハプロタイプ列は意味が無いので凡例を出さない(空なら drawListToSvg 側で凡例ガター自体を省く)。
      const legendSecs: LegendSection[] = []
      if (bandModeRef.current) {
        const bd = bandDictRef.current, st = new Set<string>()
        for (const n of visibleNodes) {
          if (!inVp(n.xCoord, n.yCoord, 0) || n.band_id == null) continue
          const e = bd.get(n.band_id) as { gie_stain?: string } | undefined
          if (e?.gie_stain) st.add(e.gie_stain)
        }
        const items = Object.keys(GIE_COLORS).filter(s => st.has(s)).map(s => ({ color: hex(GIE_COLORS[s]), stroke: hex(darken(GIE_COLORS[s])), label: s }))
        if (items.length) legendSecs.push({ caption: 'cytoBand stain', items })
      } else if (regionModeRef.current) {
        const rd = regionDictRef.current, nm = new Set<string>()
        for (const n of visibleNodes) {
          if (!inVp(n.xCoord, n.yCoord, 0) || n.region_class == null) continue
          const e = rd.get(n.region_class) as { name?: string } | undefined
          if (e?.name) nm.add(e.name)
        }
        const items = [...nm].slice(0, 14).map(name => ({ color: hex(stainToColor(name)), stroke: hex(darken(stainToColor(name))), label: name }))
        if (items.length) legendSecs.push({ caption: 'region class', items })
      } else if (geneModeRef.current) {
        legendSecs.push({ caption: 'gene density (genes/Mb)', items: [], gradient: { lo: hex(GENE_DENSITY_LOW), hi: hex(GENE_DENSITY_HIGH) } })
      }
      {
        const ribItems = (ribbonsRef.current || [])
          .filter(r => (r.nodes && r.nodes.length) || (r.edges && r.edges.length))
          .map(r => ({ color: hex(r.color), stroke: hex(darken(r.color)), label: (r.label ?? 'ribbon').slice(0, 22) }))
        if (ribItems.length) legendSecs.push({ caption: 'path ribbons', items: ribItems })
      }

      // 幾何(ノード5点グリフ・エッジ細線＋太さクアッド・図版座標・物理mm)＋レイヤ付き SVG 直列化は
      // 共有 buildGraphFigure/drawListToSvg に委ねる ＝ headless CLI(backend)と完全に同一実装。
      const fig = buildGraphFigure(figNodes, figEdges, {
        vpX1: vp.x1, vpY1: vp.y1, vpX2: vp.x2, vpY2: vp.y2,
        zoom, nodeScale: nodeScl, edgeWidthMode,
        maxHb: maxHbRef.current, maxEdgePx: maxEdgePxRef.current, maxEdgeReads: maxEdgeReadsRef.current, edgeMin: edgeMinRef.current,
        widthMm: 180, ribbons: ribbonMarks, labels: figLabels, legend: legendSecs, stamp,
      })
      const svg = drawListToSvg(fig)
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url; a.download = `${(dbFile || 'amipa').replace(/[^\w.+-]+/g, '_')}_figure.svg`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    {
      const p = new URLSearchParams(window.location.search)
      const cx = parseFloat(p.get('cx') ?? 'NaN')
      const cy = parseFloat(p.get('cy') ?? 'NaN')
      const vw = parseFloat(p.get('vw') ?? 'NaN')
      const hasUrl = isFinite(cx) && isFinite(cy) && isFinite(vw) && vw > 0
      if (hasUrl) {
        const zoom = container.clientWidth / vw
        world.scale.set(zoom)
        world.position.set(container.clientWidth / 2 - cx * zoom,
                           container.clientHeight / 2 - cy * zoom)
        fitPendingRef.current = false        // URL 指定を worldBbox 到着で上書きしない
      } else if (fitToWorld()) {
        fitPendingRef.current = false
      } else {
        // 通常こちら（worldBbox 未着）。暫定で従来の見え方にしておき、届いたら合わせ直す。
        world.scale.set(container.clientWidth)
        world.position.set(0, container.clientHeight * 0.3)
        fitPendingRef.current = true
      }
    }

    // ── B: タイル格子解像度を「カメラズーム(autoLayer)」から決める（内容層とは分離） ──────
    // gzForLayer(L)=round(log2(K_TILES·layer_zoom[L]/W_world)): 層 L を『その自然ズーム』で見た時に
    // 画面内タイル数/軸 ≒ K_TILES になる格子解像度。タイル格子は **カメラズーム層(autoLayer)** の gz で
    // 決め、『どの層のノードを取るか(currentLayer=autoLayer+詳細オフセット)』とは分離する。こうすると
    // 詳細+N で深い層を浅いズームのまま出しても、格子はカメラ基準のままなので画面内タイル数は ≒K_TILES²
    // に保たれ、旧実装のような 4^N のタイル爆発（＝深い詳細でノードが出なくなる不具合）が起きない。
    // layer_zoom 欠落時は zt=L（従来動作）にフォールバック。
    function gzForLayer(L: number): number {
      const lz = layerZoomRef.current?.[L]
      const w = worldBboxRef.current
      const W = w ? Math.max(1e-9, w.x1 - w.x0) : 1
      if (!lz || !isFinite(lz) || lz <= 0) return clamp(L, 0, ZT_MAX)
      return clamp(Math.round(Math.log2(K_TILES * lz / W)), 0, ZT_MAX)
    }
    // 現在のタイル格子解像度 = カメラズーム層(autoLayer)の gz。内容層(currentLayer)には依存しない。
    function curGridZ(): number { return gzForLayer(Math.max(0, autoLayer)) }

    // ── ミュータブルな状態 ────────────────────────────────────────────
    let currentLayer = -1     // 取得対象の層（settle で選ばれた層。タイルを fetch 中の層）
    let displayLayer = -1     // 実際に描画する層。新層のタイルが揃うまでは旧層を描き続け、白飛びを防ぐ
    // displayLayer の現在表示中タイルが載っている格子解像度 gz。タイルキーは {layer}/{gz}/… なので、
    // ズームで autoLayer→gz が変わっても「旧 displayLayer を旧 gz で」引き続けないと（curGridZ は新 gz を返し）
    // 旧タイルが見つからず真っ白になる。昇格時に新 gz へ更新する。
    let displayGz = 0
    let autoLayer = -1        // zoom だけで決まる自動層（ヒステリシス対象。layerOffset を足す前）
    // 最後のレンダリングで使った可視ノード・エッジ (イベントハンドラが参照)
    let visibleNodes: NodeData[] = []
    let visibleEdges: EdgeData[] = []
    // 8.1 SVG 図版: ラベルは種類が多いので、描画時に emitText を1か所で捕捉して全種を漏れなく SVG 化する。
    // exportSvg が [] を入れて render() を1回走らせ、集まった (screen 座標の)ラベルを図版座標へ写す。
    let svgLabelCapture: { text: string; x: number; y: number; ax: number; ay: number; fs: number; fill: number; stroke: boolean }[] | null = null

    let fetchCount  = 0
    let isDragging  = false
    let mouseDownPos = { x: 0, y: 0 }
    let lastMouse   = { x: 0, y: 0 }
    let layerDebounce: ReturnType<typeof setTimeout> | null = null
    let urlDebounce:   ReturnType<typeof setTimeout> | null = null

    // 編集モード状態
    let selectedIds = new Set<number>()
    let isBoxSelecting = false, boxAdditive = false
    let boxStart = { x: 0, y: 0 }, boxEnd = { x: 0, y: 0 }

    let isMovingNodes = false
    let moveStartMouse = { x: 0, y: 0 }
    let moveSelectedNodeNames = new Set<string>()
    let moveStartNodePositions: Map<number, { x: number; y: number }> = new Map()
    let moveStartEdgeSnapshots: Map<number, EdgeSnapshot> = new Map()
    // 選択スナップショットの座標範囲。ノードを [0,1] 外へ出さないよう平行移動量をクランプするのに使う。
    let moveBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 }
    function computeMoveBounds() {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const s of moveStartNodePositions.values()) {
        if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x
        if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y
      }
      moveBounds = Number.isFinite(minX) ? { minX, maxX, minY, maxY } : { minX: 0, maxX: 1, minY: 0, maxY: 1 }
    }

    // ── ソフト(BFS弾性)移動: 掴んだノードから BFS hop で近傍を巻き込み、hop 減衰した重みで一緒に動かす ──
    let isSoftDragging = false
    let softStartMouse = { x: 0, y: 0 }
    let softGrabbedId = -1
    let softWById   = new Map<number, number>()   // node id → 重み(0..1)
    let softWByName = new Map<string, number>()   // node name → 重み(0..1)
    let softHopById = new Map<number, number>()   // node id → hop（gesture を hop 別に束ねる用）
    let softStartNodePositions: Map<number, { x: number; y: number }> = new Map()
    let softStartEdgeSnapshots: Map<number, EdgeSnapshot> = new Map()
    let softStartPathSnapshots: PathSnapshots = new Map()
    let softStartRibbonSnap: RibbonGeomSnap = []
    let softBounds = { dxMin: -1, dxMax: 1, dyMin: -1, dyMax: 1 }
    // hop→重み。掴んだ点=1、hop=D+1 で 0。指数 p で硬さを調整: p 大=硬い(近傍が急減=掴んだ点だけ動く)、
    // p 小=柔らかい(近傍が広く緩やかに追従)。p は softDragSoftness から算出。
    const softExponent = () => Math.max(0.2, 3 / Math.max(1, softDragSoftnessRef.current))
    const softWeightForHop = (hop: number, D: number, p: number) => {
      const t = 1 - hop / (D + 1)
      return t <= 0 ? 0 : Math.pow(t, p)
    }
    // 掴んだノードから visibleEdges 上を BFS(無向)して hop≤D の近傍を集め、重みを設定する。
    function buildSoftSet(grabbed: NodeData, D: number) {
      const adj = new Map<string, string[]>()
      for (const e of visibleEdges) {
        if (e.source === e.target) continue
        ;(adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target)
        ;(adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source)
      }
      const idByName = new Map<string, number>()
      for (const n of visibleNodes) idByName.set(n.node_name, n.id)
      const hop = new Map<string, number>([[grabbed.node_name, 0]])
      let frontier = [grabbed.node_name]
      for (let d = 0; d < D && frontier.length; d++) {
        const next: string[] = []
        for (const u of frontier) for (const v of (adj.get(u) ?? [])) {
          if (!hop.has(v)) { hop.set(v, d + 1); next.push(v) }
        }
        frontier = next
      }
      const p = softExponent()
      softWById = new Map(); softWByName = new Map(); softHopById = new Map()
      for (const [name, h] of hop) {
        const w = softWeightForHop(h, D, p)
        if (w <= 0) continue
        softWByName.set(name, w)
        const id = idByName.get(name)
        if (id != null) { softWById.set(id, w); softHopById.set(id, h) }
      }
    }
    function startSoftDrag(grabbed: NodeData, sx: number, sy: number) {
      buildSoftSet(grabbed, Math.max(1, Math.min(30, softDragHopsRef.current)))
      softGrabbedId = grabbed.id
      softStartMouse = { x: sx, y: sy }
      softStartNodePositions = new Map(
        visibleNodes.filter(n => softWById.has(n.id)).map(n => [n.id, { x: n.xCoord, y: n.yCoord }])
      )
      softStartEdgeSnapshots = snapshotConnectedEdges(new Set(softWByName.keys()))
      softStartPathSnapshots = snapshotPathSteps()
      softStartRibbonSnap = snapshotRibbons()
      // 重み付きクランプ: 各影響ノード i は w_i·delta 動く。0 ≤ start + w·delta ≤ 1 を全ノードで満たす delta 範囲。
      let dxMin = -Infinity, dxMax = Infinity, dyMin = -Infinity, dyMax = Infinity
      for (const [id, w] of softWById) {
        const s = softStartNodePositions.get(id); if (!s || w <= 0) continue
        dxMin = Math.max(dxMin, -s.x / w); dxMax = Math.min(dxMax, (1 - s.x) / w)
        dyMin = Math.max(dyMin, -s.y / w); dyMax = Math.min(dyMax, (1 - s.y) / w)
      }
      softBounds = {
        dxMin: Number.isFinite(dxMin) ? dxMin : -1, dxMax: Number.isFinite(dxMax) ? dxMax : 1,
        dyMin: Number.isFinite(dyMin) ? dyMin : -1, dyMax: Number.isFinite(dyMax) ? dyMax : 1,
      }
      isSoftDragging = true
    }
    // ソフト移動確定: 影響ノードを hop 別に束ね、hop ごとの平行移動 gesture を App へ報告(DB反映用)。
    function recordSoftGesture() {
      const gs = softStartNodePositions.get(softGrabbedId)
      const gn = visibleNodes.find(n => n.id === softGrabbedId)
      if (!gs || !gn) return
      const dx = gn.xCoord - gs.x, dy = gn.yCoord - gs.y   // 掴んだノード(w=1)の実移動量
      if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return
      const idToName = new Map<number, string>()
      for (const n of visibleNodes) idToName.set(n.id, n.node_name)
      const byHop = new Map<number, string[]>()
      for (const [id, h] of softHopById) {
        const nm = idToName.get(id); if (!nm) continue
        ;(byHop.get(h) ?? byHop.set(h, []).get(h)!).push(nm)
      }
      const D = Math.max(1, Math.min(30, softDragHopsRef.current))
      const p = softExponent()
      for (const [h, names] of byHop) {
        const w = softWeightForHop(h, D, p); if (w <= 0 || names.length === 0) continue
        onNodesEditedRef.current?.({ names, cos: 1, sin: 0, tx: w * dx, ty: w * dy, dAngle: 0 })
      }
    }

    let isRotating = false
    let rotateCenter = { x: 0, y: 0 }
    let rotateStartAngle = 0
    let rotateSelectedNodeNames = new Set<string>()
    let rotateStartNodePositions: Map<number, { x: number; y: number; angle: number }> = new Map()
    let rotateStartEdgeSnapshots: Map<number, EdgeSnapshot> = new Map()

    let moveStartPathSnapshots: PathSnapshots = new Map()
    let rotateStartPathSnapshots: PathSnapshots = new Map()
    let moveStartRibbonSnap: RibbonGeomSnap = []
    let rotateStartRibbonSnap: RibbonGeomSnap = []

    let isSpacePanning = false, spaceKeyDown = false

    // 編集ダーティフラグ: 現在のレイヤで移動/回転が行われた場合 true
    let isDirty = false

    // Coverage filter: updated each render(), read by renderPaths()
    let hiddenNodeIds   = new Set<number>()
    let hiddenNodeNames = new Set<string>()

    // ── 座標変換 ─────────────────────────────────────────────────────
    function getViewport(): Rect {
      const z = world.scale.x, px = world.position.x, py = world.position.y
      const { width, height } = app.screen
      return { x1: -px/z, x2: (width-px)/z, y1: -py/z, y2: (height-py)/z }
    }
    function screenToWorld(sx: number, sy: number) {
      const z = world.scale.x
      return { x: (sx - world.position.x) / z, y: (sy - world.position.y) / z }
    }
    function worldToScreen(wx: number, wy: number) {
      return { x: wx * world.scale.x + world.position.x,
               y: wy * world.scale.y + world.position.y }
    }
    // カメラ移動範囲の制限: 画面中心の world 座標をノード bbox 内に留める（＝完全にノード範囲外へ出さない）。
    // ノード座標は正規化 [0,1] 空間。実 bbox(worldBbox=R-tree ルート)があればそれを使い、無ければ [0,1]。
    // 画面中心を基準にしているので、端まで寄せても常に画面の半分にはノード領域が残る。
    function clampCamera() {
      const b = worldBboxRef.current
      const x0 = b ? b.x0 : 0, x1 = b ? b.x1 : 1, y0 = b ? b.y0 : 0, y1 = b ? b.y1 : 1
      const z = world.scale.x
      const { width, height } = app.screen
      const cx = (width / 2 - world.position.x) / z    // 画面中心の world 座標
      const cy = (height / 2 - world.position.y) / z
      const cxC = clamp(cx, Math.min(x0, x1), Math.max(x0, x1))
      const cyC = clamp(cy, Math.min(y0, y1), Math.max(y0, y1))
      if (cxC !== cx) world.position.x = width / 2 - cxC * z
      if (cyC !== cy) world.position.y = height / 2 - cyC * z
    }

    function getRotationHandleInfo() {
      if (selectedIds.size === 0) return null
      let sumX = 0, sumY = 0, minScreenY = Infinity, count = 0
      for (const n of visibleNodes) {
        if (!selectedIds.has(n.id)) continue
        sumX += n.xCoord; sumY += n.yCoord
        const s = worldToScreen(n.xCoord, n.yCoord)
        if (s.y < minScreenY) minScreenY = s.y
        count++
      }
      if (count === 0) return null
      const cx = sumX / count, cy = sumY / count
      const cs = worldToScreen(cx, cy)
      return { sx: cs.x, sy: minScreenY - 40, cx, cy }
    }

    // 移動ハンドル: 選択重心のスクリーン位置。掴んで選択全体を移動できる（小さいノードを直接掴めない
    // 浅い層でも、範囲選択→ハンドルで染色体ごと動かせる）。回転ハンドル(上方)とは別位置(中心)。
    function getMoveHandleInfo() {
      if (selectedIds.size === 0) return null
      let sumX = 0, sumY = 0, count = 0
      for (const n of visibleNodes) {
        if (!selectedIds.has(n.id)) continue
        sumX += n.xCoord; sumY += n.yCoord; count++
      }
      if (count === 0) return null
      const cx = sumX / count, cy = sumY / count
      const cs = worldToScreen(cx, cy)
      return { sx: cs.x, sy: cs.y, cx, cy }
    }

    // ── 描画 ─────────────────────────────────────────────────────────
    function render() {
      const viewport    = getViewport()
      const renderRect  = expandRect(viewport, RENDER_MARGIN)
      const zoom        = world.scale.x
      // floating origin（float32 精度対策）: world 直下の Graphics は数百万頂点で非バッチ経路に入り、
      // 頂点をローカル float32 で GPU アップロードする。絶対正規化座標(~0.68, ULP≈6e-8)で描くと深層の
      // 微小ノード(半幅~1e-6)が量子化で歪む(斜め・最深層ほど顕著, 平行移動で四隅が順にスナップ)。視野中心を
      // 引いて小座標で描き、レイヤの position(=world transform)で戻す。データ(n.xCoord)は絶対のまま=当たり判定不変。
      const originX = (viewport.x1 + viewport.x2) / 2
      const originY = (viewport.y1 + viewport.y2) / 2
      edgeLayer.position.set(originX, originY)
      nodeLayer.position.set(originX, originY)
      // LOD-A: 描画は displayLayer（＝現在画面に出ている層）。新層は maybePromote() でタイルが
      // 揃ってから displayLayer に昇格するので、層切替時に空の新層を描いて白飛びすることがない。
      const renderLayer = Math.max(0, displayLayer)

      // 格子解像度は「今表示中のタイルが載っている gz」= displayGz。curGridZ()（＝新しいカメラ zoom の gz）を
      // 使うと、層境界を跨いだ直後は旧 displayLayer のタイル（旧 gz）が見つからず真っ白になる。displayGz なら
      // 新タイル到着（maybePromote で昇格）まで旧内容を PIXI world 変換で拡大表示し続けられる。
      const { nodeIds, edgeIds } = getVisibleIds(renderLayer, displayGz, renderRect)
      visibleNodes = [...nodeIds].map(id => nodeStore.get(id)).filter((n): n is NodeData => n != null)
      visibleEdges = [...edgeIds].map(id => edgeStore.get(id)).filter((e): e is EdgeData => e != null)

      // ノードサイズ倍率。エッジ端点・ノード本体・パスリボンを同じ倍率でノード中心周りにスケールし追従させる。
      // 1.0（既定）は変換ゼロの高速パス。エッジ端点の追従には node_name → 中心 の索引が要る。
      const nodeScl = nodeScaleRef.current
      const nodeByName = nodeScl !== 1 ? new Map(visibleNodes.map(n => [n.node_name, n])) : null
      // エッジ e の端点を、始点=source 中心／終点=target 中心の周りに nodeScl 倍した [sx,sy,ex,ey]。
      // 中心が可視外で引けない端点は元座標のまま（境界エッジの軽微なズレは許容）。
      // 返り値は floating origin 相対（edgeLayer.position=origin で復元）。
      const edgePts = (e: EdgeData): [number, number, number, number] => {
        if (!nodeByName) return [e.start_x - originX, e.start_y - originY, e.end_x - originX, e.end_y - originY]
        const s = nodeByName.get(e.source), t = nodeByName.get(e.target)
        return [
          (s ? s.xCoord + (e.start_x - s.xCoord) * nodeScl : e.start_x) - originX,
          (s ? s.yCoord + (e.start_y - s.yCoord) * nodeScl : e.start_y) - originY,
          (t ? t.xCoord + (e.end_x - t.xCoord) * nodeScl : e.end_x) - originX,
          (t ? t.yCoord + (e.end_y - t.yCoord) * nodeScl : e.end_y) - originY,
        ]
      }

      // A-2/レール表示: ノード厚み(短軸)を長さに依らず一定に。world 厚み(refRadN*0.35, 深く覗くと成長)に
      // **画面px の下限**を足して、引きの画(低ズーム=world 厚みがサブpxになる所)でも必ず見える最低幅を保証する。
      // 最低幅は従来(~1px)の約2倍(=full ~2.4px)。エッジ太さ上限もこの厚みに連動。全ノード共通=一定。
      const MIN_HALF_THICK_PX = 1.2   // 画面px の最低半厚み(full ~2.4px ≈ 従来最低幅の2倍)
      let refRadN = Infinity
      for (const n of visibleNodes) { const r = n.radius; if (r > 0 && r < refRadN) refRadN = r }
      const constHalfThick = Math.max((isFinite(refRadN) ? refRadN : 0.001) * 0.35, MIN_HALF_THICK_PX / zoom)

      // Build hidden sets for coverage threshold filter
      hiddenNodeIds   = new Set<number>()
      hiddenNodeNames = new Set<string>()
      const covMin = coverageMinRef.current
      if (covMin > 0) {
        for (const n of visibleNodes) {
          if ((n.coverage ?? 0) < covMin) {
            hiddenNodeIds.add(n.id)
            hiddenNodeNames.add(n.node_name)
          }
        }
      }

      edgeLayer.clear()
      const edgeMinVal = edgeMinRef.current
      const inDetailMode = detailDepthModeRef.current
      const isBreadthE = breadthModeRef.current
      if (isBreadthE) {
        // A-2 パス多重度: エッジ太さ=通過パス数(breadth) に **線形比例**。lineStyle は深層で closePointEps により
        // 短区間が消えるので **塗りクアッド** で描く。太さ上限は「一定ノード厚み(constHalfThick×2)」に合わせ、
        // 最大 breadth のエッジ=ノード厚みと同じ・以下(エッジはノードを超えない)。色は muted・低 α でノードより
        // 薄い存在感に(太さで量を読む)。base の 1px native 線で全エッジの存在を保証。
        // maxHb(=正規化上限)が未知(0/巨大DBで未取得)のときは太さを出さない(0除算相当で暴走→ノード幅超過を防ぐ)。
        const mh = maxHbRef.current
        const be = visibleEdges.filter(e => {
          if (hiddenNodeNames.has(e.source) || hiddenNodeNames.has(e.target)) return false
          if (Math.min(e.start_x, e.end_x) > renderRect.x2) return false
          if (Math.max(e.start_x, e.end_x) < renderRect.x1) return false
          if (Math.min(e.start_y, e.end_y) > renderRect.y2) return false
          if (Math.max(e.start_y, e.end_y) < renderRect.y1) return false
          return true
        })
        // base: 全エッジ 1px(native:true=深層でも消えない。パス多重度 0/低もここで見える)
        edgeLayer.lineStyle(1, 0xced4da, 0.55, 0.5, true)
        for (const e of be) { const [sx, sy, ex, ey] = edgePts(e); edgeLayer.moveTo(sx, sy); edgeLayer.lineTo(ex, ey) }
        edgeLayer.lineStyle(0)
        // 太さ=breadth 線形・上限=一定ノード厚み・塗りクアッド。高 breadth を後に描いて上へ。
        // mh<=0(スケール未取得)のときは base 1px のみで太さは描かない(暴走防止)。
        if (mh > 0) {
          const be2 = be.filter(e => (e.edge_hb ?? 0) > 0).sort((a, b) => (a.edge_hb ?? 0) - (b.edge_hb ?? 0))
          for (const e of be2) {
            const [sx, sy, ex, ey] = edgePts(e)
            const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy)
            if (len < 1e-12) continue
            // 線形・上限=ノード半厚み。edge_hb>mh でもノードを超えないよう min(1) でクランプ。
            const halfW = Math.min(1, (e.edge_hb ?? 0) / mh) * constHalfThick
            if (halfW <= 0) continue
            const px = -dy / len * halfW, py = dx / len * halfW
            edgeLayer.beginFill(0x8ba7c9, 0.5)   // muted blue-grey・α0.5 = ノードより薄い存在感
            edgeLayer.drawPolygon([sx + px, sy + py, ex + px, ey + py, ex - px, ey - py, sx - px, sy - py])
            edgeLayer.endFill()
          }
        }
      } else if (inDetailMode) {
        const maxPx = maxEdgePxRef.current
        const maxRs = maxEdgeReadsRef.current
        const detailEdges = visibleEdges.filter(e => {
          if (edgeMinVal > 0 && (e.read_support ?? 0) < edgeMinVal) return false
          if (hiddenNodeNames.has(e.source) || hiddenNodeNames.has(e.target)) return false
          if (Math.min(e.start_x, e.end_x) > renderRect.x2) return false
          if (Math.max(e.start_x, e.end_x) < renderRect.x1) return false
          if (Math.min(e.start_y, e.end_y) > renderRect.y2) return false
          if (Math.max(e.start_y, e.end_y) < renderRect.y1) return false
          return true
        })
        // base: 全エッジ 1px(native:true=gl.LINES=深層でも消えない。read_support 0/低もここで見える)
        edgeLayer.lineStyle(1, 0xadb5bd, 0.5, 0.5, true)
        for (const e of detailEdges) {
          const [sx, sy, ex, ey] = edgePts(e)
          edgeLayer.moveTo(sx, sy)
          edgeLayer.lineTo(ex, ey)
        }
        edgeLayer.lineStyle(0)
        // 太さ=read_support 線形・**塗りクアッド**(breadth/パス多重度と同型)。lineStyle(native:false) は
        // 深層で closePointEps により短区間が消える(=「太さ一定」不具合の元凶)ので使わない。
        // w=スクリーン px(maxPx で上限, maxRs で正規化) → world 半厚み=w/(2*zoom)。高 rs を後に描いて上へ。
        if (maxRs > 0) {
          const de2 = detailEdges.filter(e => (e.read_support ?? 0) > 0)
            .sort((a, b) => (a.read_support ?? 0) - (b.read_support ?? 0))
          for (const e of de2) {
            const [sx, sy, ex, ey] = edgePts(e)
            const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy)
            if (len < 1e-12) continue
            const rs = e.read_support ?? 0
            const w = Math.max(1, Math.min(maxPx, (rs / maxRs) * maxPx))
            const halfW = w / (2 * zoom)
            const px = -dy / len * halfW, py = dx / len * halfW
            edgeLayer.beginFill(0xadb5bd, 0.85)
            edgeLayer.drawPolygon([sx + px, sy + py, ex + px, ey + py, ex - px, ey - py, sx - px, sy - py])
            edgeLayer.endFill()
          }
        }
      } else {
        edgeLayer.lineStyle(1, 0xadb5bd, 0.9, 0.5, true)
        for (const e of visibleEdges) {
          if (edgeMinVal > 0 && (e.read_support ?? 0) < edgeMinVal) continue
          if (hiddenNodeNames.has(e.source) || hiddenNodeNames.has(e.target)) continue
          if (Math.min(e.start_x, e.end_x) > renderRect.x2) continue
          if (Math.max(e.start_x, e.end_x) < renderRect.x1) continue
          if (Math.min(e.start_y, e.end_y) > renderRect.y2) continue
          if (Math.max(e.start_y, e.end_y) < renderRect.y1) continue
          const [sx, sy, ex, ey] = edgePts(e)
          edgeLayer.moveTo(sx, sy)
          edgeLayer.lineTo(ex, ey)
        }
      }

      // 選択遺伝子: **exon が隣接 ref ノード境界をまたぐ実エッジのみ**濃緑で上塗り(端点=edgePts, 塗り矩形=フリッカ回避)。
      // またぐ = 低 ref_bp 側の末尾塩基と高側の先頭塩基が同一 exon に入る。非参照端点のエッジは対象外。
      if (selectedGeneRef.current) {
        const g = selectedGeneRef.current
        const exs = selectedGeneExonsRef.current
        // nodeByName は nodeScale≠1 のときだけ作られる(既定 null)ので、遺伝子選択時は自前で名前→node マップを用意。
        const nbn = nodeByName ?? new Map(visibleNodes.map(n => [n.node_name, n]))
        const exonAt = (bp: number): number | null => {
          for (const ex of exs) if (ex.start <= bp && bp < ex.end) return ex.exon_no
          return null
        }
        edgeLayer.lineStyle(0)
        for (const e of visibleEdges) {
          if (hiddenNodeNames.has(e.source) || hiddenNodeNames.has(e.target)) continue
          const a = nbn.get(e.source), b = nbn.get(e.target)
          if (!a || !b || a.ref_bp == null || b.ref_bp == null) continue
          const as = Number(a.ref_bp), ae = Number(a.ref_bp_end ?? a.ref_bp)
          const bs = Number(b.ref_bp), be = Number(b.ref_bp_end ?? b.ref_bp)
          if (!(ae > g.start && as < g.end) || !(be > g.start && bs < g.end)) continue
          const loEnd = as <= bs ? ae : be     // 低 ref_bp 側の末尾
          const hiStart = as <= bs ? bs : as   // 高 ref_bp 側の先頭
          const et = exonAt(loEnd - 1)
          if (et == null || et !== exonAt(hiStart)) continue
          const [sx, sy, ex2, ey2] = edgePts(e)
          const dx = ex2 - sx, dy = ey2 - sy, len = Math.hypot(dx, dy) || 1
          const px = (-dy / len) * (2.4 / zoom), py = (dx / len) * (2.4 / zoom)
          edgeLayer.beginFill(0x2b8a3e, 0.95)
          edgeLayer.drawPolygon([sx + px, sy + py, ex2 + px, ey2 + py, ex2 - px, ey2 - py, sx - px, sy - py])
          edgeLayer.endFill()
        }
      }

      nodeLayer.clear()
      const minW = 3 / zoom
      let drawnCount = 0   // 実際に描いたグリフ数（バッジ表示・重さ判定用・クエリ不要）

      // Grey mode: collect IDs of nodes that are part of any selected path
      const pathNodeIds = new Set<number>()
      if (nodeGreyModeRef.current) {
        for (const [ctgName] of selectedPathsRef.current) {
          const cached = pathCacheRef.current.get(ctgName)
          if (cached) for (const pn of cached.nodes) pathNodeIds.add(pn.id)
        }
      }

      for (const n of visibleNodes) {
        if (hiddenNodeIds.has(n.id)) continue
        const w  = Math.max(n.radius * 2 * nodeScl, minW)
        const hw = w / 2, bound = hw * 1.4
        if (n.xCoord + bound < renderRect.x1 || n.xCoord - bound > renderRect.x2) continue
        if (n.yCoord + bound < renderRect.y1 || n.yCoord - bound > renderRect.y2) continue
        drawnCount++
        const hh  = Math.min(constHalfThick, hw)   // 厚み一定(長さに依らず)。短すぎるノードは長さで頭打ち
        // side1(+hw,3'/exit)側を尖端(5点目=接続点)にし、両肩を inset だけ内側へ寄せて向きを示す。
        // 葉は lang、集約(スーパーノード)は符号解決済み PCA 軸(emitter §4d')で angle が向きを持つ。
        const inset = hw * NODE_TIP_INSET
        const cos = Math.cos(n.angle), sin = Math.sin(n.angle)
        const cx  = n.xCoord - originX, cy = n.yCoord - originY   // floating origin 相対（nodeLayer.position で復元）

        const shouldGrey = nodeGreyModeRef.current && !selectedIds.has(n.id) && !pathNodeIds.has(n.id)
        const isSelected = selectedIds.has(n.id)

        // グラフ距離フラッド(近接モード): クリック点からの hop で3層着色。到達=青ランプ(濃hop0→淡hopD)、
        // 同一成分だが未到達=くすんだ青灰(連結だが遠い＝融合)、別成分=淡灰(ただ近接)。最優先で塗る。
        let floodFill: number | null = null, floodLineC = 0
        if (floodModeRef.current && floodResultRef.current) {
          const hop = floodResultRef.current.get(n.node_name)
          if (hop != null) {
            const t = hop / Math.max(1, floodMaxHopRef.current)
            floodFill = lerpColor(0x1864ab, 0xa5d8ff, t); floodLineC = lerpColor(0x0b3d6b, 0x4dabf7, t)
          } else if (floodSeedCompRef.current != null && n.comp_id === floodSeedCompRef.current) {
            floodFill = 0x8fa8c4; floodLineC = 0x5a7290   // 同一成分・未到達（連結だが遠い＝融合）
          } else {
            floodFill = 0xeceef0; floodLineC = 0xced4da   // 別成分（ただ近接）
          }
        }
        // アラインビュー連動の対応色（あれば最優先で塗る）
        const linkColor = nodeColorsRef.current.get(n.node_name)
        // アノテ着色(band/region/gene 密度)。node fill は単値なので相互排他、優先 band>region>gene。
        const annotColor: number | null =
            bandModeRef.current   ? bandToColor(n.band_id, bandDictRef.current)
          : regionModeRef.current ? regionToColor(n.region_class, regionDictRef.current)
          : geneModeRef.current   ? geneCountToColor(n.gene_count, n.ref_bp, n.ref_bp_end)
          : null
        const fillColor = floodFill != null ? floodFill
                        : linkColor != null ? linkColor
                        : shouldGrey ? 0xe9ecef
                        : annotColor != null ? annotColor
                        : 0x228be6
        const lineColor = floodFill != null ? floodLineC
                        : linkColor != null ? 0x343a40
                        : shouldGrey ? 0xadb5bd
                        : annotColor != null ? darken(annotColor)
                        : 0x1864ab

        {
          if (isSelected) {
            nodeLayer.lineStyle(2 / zoom, 0xf08c00, 1.0, 0.5, true)
            nodeLayer.beginFill(fillColor === 0x228be6 ? 0x74c0fc : fillColor, 1.0)
          } else {
            nodeLayer.lineStyle(0.8 / zoom, lineColor, shouldGrey ? 0.4 : 0.6, 0.5, true)
            nodeLayer.beginFill(fillColor, shouldGrey ? 0.7 : 1.0)
          }
          // 5点: side0(-hw,5'/enter)側は平ら。side1(+hw,0)=3'/exit=次ノードへの接続点を尖端(5点目)にし、
          // 両肩を inset だけ内側へ寄せる。尖端は流れ(5'→3')の向きを指す。集約は inset=0 で長方形に退化。
          nodeLayer.drawPolygon([
            cx + cos*(-hw)         - sin*(-hh), cy + sin*(-hw)         + cos*(-hh),
            cx + cos*(-hw)         - sin*  hh,  cy + sin*(-hw)         + cos*  hh,
            cx + cos*( hw - inset) - sin*  hh,  cy + sin*( hw - inset) + cos*  hh,
            cx + cos*  hw,                      cy + sin*  hw,
            cx + cos*( hw - inset) - sin*(-hh), cy + sin*( hw - inset) + cos*(-hh),
          ])
          nodeLayer.endFill()
        }
        // 選択遺伝子: この ref ノードが gene に重なるなら、**ノード本体に沿って exon 部分区間を塗り分け**
        // (intron=淡緑ベース / exon=濃緑)。node ref_bp スパン ∩ exon を node 軸(hw)に写像する
        // ジオメトリ。ref_strand で向きを合わせる。非参照/非対象ノードは不変(=トポロジーで読む)。
        // ref_multi(多重マッピング)ノードは ref_bp 範囲が散在位置の外接ボックス(1bp が 23Mb 等)になり、
        // exon を写像すると全長の 0.03% 等で不可視/無意味 → gene の塗りは出さない(exon 番号テキストも同様に抑制)。
        if (selectedGeneRef.current && n.ref_bp != null && !shouldGrey && !n.ref_multi) {
          const gsel = selectedGeneRef.current
          const bs = Number(n.ref_bp), be = Number(n.ref_bp_end ?? n.ref_bp)
          if (be > gsel.start && bs < gsel.end && be > bs) {
            const glen = be - bs
            const fwd = n.ref_strand == null ? true : Number(n.ref_strand) !== 0
            const axis = (f: number) => (fwd ? -hw + f * 2 * hw : hw - f * 2 * hw)
            const shoulder = hw - inset
            const hAt = (x: number) => (x <= shoulder ? hh : Math.max(0, hh * (hw - x) / Math.max(inset, 1e-6)))
            // ノード外形に沿った塗り(3' 尖端でテーパー)。肩(shoulder)を跨ぐ区間は中間点を入れて折れを再現。
            const quad = (lo: number, hi: number, col: number, a: number) => {
              if (hi <= lo) return
              const xs = lo < shoulder && shoulder < hi ? [lo, shoulder, hi] : [lo, hi]
              const poly: number[] = []
              for (const x of xs) { const h = hAt(x); poly.push(cx + cos * x - sin * (-h), cy + sin * x + cos * (-h)) }
              for (let i = xs.length - 1; i >= 0; i--) { const x = xs[i], h = hAt(x); poly.push(cx + cos * x - sin * h, cy + sin * x + cos * h) }
              nodeLayer.lineStyle(0); nodeLayer.beginFill(col, a); nodeLayer.drawPolygon(poly); nodeLayer.endFill()
            }
            quad(-hw, hw, 0xd3f9d8, 0.78)                      // gene ノード全体=淡緑(intron ベース)
            for (const ex of selectedGeneExonsRef.current) {   // exon 部分=濃緑
              const os = Math.max(bs, ex.start), oe = Math.min(be, ex.end)
              if (oe <= os) continue
              const a0 = axis((os - bs) / glen), a1 = axis((oe - bs) / glen)
              quad(Math.min(a0, a1), Math.max(a0, a1), 0x2b8a3e, 0.92)
            }
          }
        }
      }
      lastGlyphs = drawnCount   // バッジに実描画数を反映

      // テキストラベル（カバレージ数値 / ノード名）
      const tl = textLayerRef.current
      if (tl) {
        // Text プール: 破棄・再生成でなく既存 PIXI.Text を使い回す。text/style は変化時のみ更新し
        // (PIXI は同値なら再ラスタライズしない)、パン中は位置だけ動かして再ラスタを避ける。
        let poolIdx = 0
        const labelScl = labelScaleRef.current   // 全ラベル一括サイズ倍率（ref bp / ノード名 / 遺伝子 等すべて）
        const emitText = (text: string, x: number, y: number, ax: number, ay: number,
                          fontSizeIn: number, fill: number, stroke: boolean) => {
          const fontSize = fontSizeIn * labelScl
          // フチ色は文字色の明度で自動選択: 明るい/白文字は暗フチ、暗い文字は白フチ(でないと白抜きで消える)。
          const lum = ((fill >> 16 & 255) * 299 + (fill >> 8 & 255) * 587 + (fill & 255) * 114) / 1000
          const strokeColor = lum > 150 ? 0x111111 : 0xffffff
          let t = tl.children[poolIdx] as PIXI.Text | undefined
          if (!t) {
            t = new PIXI.Text(text, { fontSize, fill, fontFamily: 'monospace',
              stroke: strokeColor, strokeThickness: stroke ? 3 : 0 })
            tl.addChild(t)
          } else {
            if (t.text !== text) t.text = text
            const st = t.style
            if (st.fontSize !== fontSize) st.fontSize = fontSize
            if (st.fill !== fill) st.fill = fill
            if (st.stroke !== strokeColor) st.stroke = strokeColor
            const th = stroke ? 3 : 0
            if (st.strokeThickness !== th) st.strokeThickness = th
          }
          t.visible = true
          t.anchor.set(ax, ay)
          t.x = x; t.y = y
          poolIdx++
          if (svgLabelCapture) svgLabelCapture.push({ text, x, y, ax, ay, fs: fontSize, fill, stroke })
          return t
        }
        const showCov   = coverageTextModeRef.current
        const showNames = showNodeNamesRef.current
        const showBp    = showNodeBpRef.current
        const labelCol  = labelColorRef.current      // ノード上ラベル(名前/bp/深度)の文字色
        const labelOff  = labelOffsetRef.current      // 上方向オフセット px(>0 でノード外へ)
        if (showCov || showNames || showBp) {
          for (const n of visibleNodes) {
            if (hiddenNodeIds.has(n.id)) continue
            const w = Math.max(n.radius * 2 * nodeScl, minW)
            const screenW = w * zoom
            const bound = w / 2 * 1.4
            if (n.xCoord + bound < renderRect.x1 || n.xCoord - bound > renderRect.x2) continue
            if (n.yCoord + bound < renderRect.y1 || n.yCoord - bound > renderRect.y2) continue
            const sp = worldToScreen(n.xCoord, n.yCoord)
            // ノード中心付近に複数行(名前 / bp 数 / 深度)を縦積み。白フチ(stroke)でノード色に埋もれないように。
            // bp 行は unit=true: 数字(大)＋"bp"(小)の2サイズで描く。行高はスケール後フォント基準。
            const lines: { text: string; fs: number; unit?: boolean }[] = []
            if (showNames && screenW >= 26)
              lines.push({ text: n.node_name, fs: Math.min(13, Math.max(8, screenW * 0.16)) })
            if (showBp && screenW >= 24 && n.size != null)
              lines.push({ text: fmtBp(n.size), fs: Math.min(13, Math.max(8, screenW * 0.16)), unit: true })
            if (showCov && screenW >= 20)
              lines.push({ text: (n.coverage != null ? Math.round(n.coverage).toString() : '?'),
                           fs: Math.min(14, Math.max(9, screenW * 0.28)) })
            if (!lines.length) continue
            let totalH = 0
            for (const L of lines) totalH += L.fs * labelScl * 1.15
            let yy = sp.y - totalH / 2 - labelOff
            for (const L of lines) {
              const h = L.fs * labelScl * 1.15
              const cy = yy + h / 2
              if (L.unit) {
                // 数字(大)＋"bp"(小)をグループとして中央寄せ。左寄せで一旦描いて幅を測り、x を確定。
                const fsU = Math.max(7, L.fs * 0.66)
                const tN = emitText(L.text, sp.x, cy, 0, 0.5, L.fs, labelCol, true)!
                const tU = emitText('bp', sp.x, cy, 0, 0.5, fsU, labelCol, true)!
                const gap = L.fs * labelScl * 0.22
                const tot = tN.width + gap + tU.width
                tN.x = sp.x - tot / 2
                tU.x = tN.x + tN.width + gap
              } else {
                emitText(L.text, sp.x, cy, 0.5, 0.5, L.fs, labelCol, true)
              }
              yy += h
            }
          }
        }
        // A-2 CNV: 選択ユニットの per-node コピー数をリボン同色テキストで重畳。mode='all'=全 present ユニット、
        // 'diff'=present ユニット間で cn が食い違うノードのみ。**実際に描く可視ノードのラベル数**で抑制判定
        // (テキストは ~100 個までしか読めない)。抑制時は描かず onCnvSuppress で⚠通知(トグルは維持)。
        if (cnvModeRef.current !== 'off' && cnvNodesRef.current.size) {
          const mode = cnvModeRef.current, colors = cnvColorsRef.current, byName = cnvNodesRef.current
          const CFS = 17, CNV_MAX = 100
          const toDraw: { sx: number; sy: number; present: number[]; cns: number[] }[] = []
          let labels = 0, suppressed = false
          for (const n of visibleNodes) {
            if (hiddenNodeIds.has(n.id)) continue
            const cns = byName.get(n.node_name)
            if (!cns) continue
            const w = Math.max(n.radius * 2 * nodeScl, minW), bnd = w / 2 * 1.4
            if (n.xCoord + bnd < renderRect.x1 || n.xCoord - bnd > renderRect.x2) continue
            if (n.yCoord + bnd < renderRect.y1 || n.yCoord - bnd > renderRect.y2) continue
            const present: number[] = []
            for (let i = 0; i < cns.length; i++) if (cns[i] >= 1) present.push(i)
            if (present.length === 0) continue
            if (mode === 'diff') {
              const v0 = cns[present[0]]
              if (present.length < 2 || present.every(i => cns[i] === v0)) continue   // 差が無い
            }
            labels += present.length
            if (labels > CNV_MAX) { suppressed = true; break }
            const sp = worldToScreen(n.xCoord, n.yCoord)
            toDraw.push({ sx: sp.x, sy: sp.y, present, cns })
          }
          if (!suppressed) {
            for (const d of toDraw) {
              const m = d.present.length
              d.present.forEach((i, k) => {
                const yy = d.sy + (k - (m - 1) / 2) * (CFS + 1)
                emitText(String(d.cns[i]), d.sx, yy, 0.5, 0.5, CFS, colors[i] ?? 0x111111, true)
              })
            }
          }
          onCnvSuppressRef.current?.(suppressed)
        } else {
          onCnvSuppressRef.current?.(false)
        }
        // 配列表示モード: 画面内の小さい葉(baseMap=viewport の 1bp 葉)の塩基をノード内に描画。
        // ノードが画面上で十分大きいときだけ描く=引きの画では文字が読めないので自然に非表示。塩基色分け。
        if (seqModeRef.current && baseMapRef.current.size) {
          const byName = baseMapRef.current
          const BASE_COL: Record<string, number> = {
            A: 0x2b8a3e, C: 0x1971c2, G: 0xe8590c, T: 0xe03131, N: 0x868e96, U: 0xe03131 }
          for (const n of visibleNodes) {
            if (hiddenNodeIds.has(n.id)) continue
            const base = byName.get(n.node_name)
            if (!base) continue
            const w = Math.max(n.radius * 2 * nodeScl, minW)
            const screenW = w * zoom
            if (screenW < 9) continue   // 小さすぎて文字が読めない=描かない(引きの画で自然に消える)
            const bnd = w / 2 * 1.4
            if (n.xCoord + bnd < renderRect.x1 || n.xCoord - bnd > renderRect.x2) continue
            if (n.yCoord + bnd < renderRect.y1 || n.yCoord - bnd > renderRect.y2) continue
            const sp = worldToScreen(n.xCoord, n.yCoord)
            const ch = base[0].toUpperCase()
            const fs = Math.min(16, Math.max(8, screenW * 0.7))
            emitText(ch, sp.x, sp.y, 0.5, 0.5, fs, BASE_COL[ch] ?? 0x111111, true)
          }
        }
        // A2 参照座標ルーラ(per-contig / global 方式): bp はレイアウト非比例なので線形写像できない。
        // 可視ノードの ref_bp から丸め目盛り(1/2/5×10ⁿ)を作り最寄りノードにスナップ。コンティグ毎に
        // 上限 PER_CONTIG、全体上限 GLOBAL。各コンティグは両端の目盛りを優先確保してから内側を詰め、
        // ラウンドロビンで配分するので小さいコンティグも最低1個は出る(starvation 回避)。FR11: 境界内挿なし。
        if (showRefPosRef.current) {
          const rc = refContigsRef.current
          // 表示数上限を従来の2倍に（PER_CONTIG 5→10 / GLOBAL 16→32 / 目盛り密度 TARGET 9→18）。
          // MINPX(近接間引き)は据置＝重なりは出さず、画面に余地がある分だけラベルが増える。
          const MINPX = 110, PER_CONTIG = 10, GLOBAL = 32, TARGET = 18
          type Cand = { s: number; e: number; mid: number; anchor: boolean; x: number; y: number;
                        wx: number; wy: number; a: number; strand: number }
          const groups = new Map<number, Cand[]>()
          for (const n of visibleNodes) {
            if (n.ref_bp == null || hiddenNodeIds.has(n.id)) continue
            const w = Math.max(n.radius * 2 * nodeScl, minW)
            const bound = w / 2 * 1.4
            if (n.xCoord + bound < renderRect.x1 || n.xCoord - bound > renderRect.x2) continue
            if (n.yCoord + bound < renderRect.y1 || n.yCoord - bound > renderRect.y2) continue
            const s = Number(n.ref_bp), e = n.ref_bp_end != null ? Number(n.ref_bp_end) : s
            const sp = worldToScreen(n.xCoord, n.yCoord)
            const cid = Number(n.ref_contig_id)
            const cand: Cand = { s, e, mid: (s + e) / 2, anchor: !!n.is_anchor, x: sp.x, y: sp.y,
                                 wx: n.xCoord, wy: n.yCoord, a: n.angle,
                                 strand: n.ref_strand == null ? 1 : Number(n.ref_strand) }
            const arr = groups.get(cid)
            if (arr) arr.push(cand); else groups.set(cid, [cand])
          }
          const multiContig = groups.size > 1
          type Lab = { m: number; x: number; y: number; name?: string; wx: number; wy: number; a: number; strand: number }
          // コンティグ毎: 目盛り生成 → 画面間引き → PER_CONTIG に均等サンプル → 両端を先頭に並べる
          const perContig: Lab[][] = []
          for (const [cid, arr] of groups) {
            let bpMin = Infinity, bpMax = -Infinity
            for (const a of arr) { if (a.mid < bpMin) bpMin = a.mid; if (a.mid > bpMax) bpMax = a.mid }
            const step = Math.max(niceStep((bpMax - bpMin) / TARGET), 1)
            const name = multiContig ? rc.get(cid)?.name : undefined
            const buckets = new Map<number, { m: number; x: number; y: number; dist: number; anchor: boolean;
                                              wx: number; wy: number; a: number; strand: number }>()
            for (const a of arr) {
              if (a.e - a.s > step * 1.5) continue   // 粗すぎるノードは位置決めに使わない
              const m = Math.round(a.mid / step) * step
              const d = Math.abs(a.mid - m)
              const prev = buckets.get(m)
              if (!prev || d < prev.dist || (d === prev.dist && a.anchor && !prev.anchor))
                buckets.set(m, { m, x: a.x, y: a.y, dist: d, anchor: a.anchor,
                                 wx: a.wx, wy: a.wy, a: a.a, strand: a.strand })
            }
            const cand = [...buckets.values()].sort((p, q) => p.x - q.x)
            if (!cand.length) {
              // 全ノードが粗すぎて目盛りが作れないコンティグでも最低1個は出す(starvation 回避)。
              // bp 中央に最寄りのノードを代表に、その bp を丸めてラベル化。
              const midBp = (bpMin + bpMax) / 2
              let best = arr[0]
              for (const a of arr) if (Math.abs(a.mid - midBp) < Math.abs(best.mid - midBp)) best = a
              perContig.push([{ m: Math.round(best.mid / step) * step, x: best.x, y: best.y, name,
                                wx: best.wx, wy: best.wy, a: best.a, strand: best.strand }])
              continue
            }
            // 画面間引き(近接<MINPXは捨てる)
            const kept: typeof cand = []
            for (const l of cand)
              if (kept.every(k => (k.x - l.x) ** 2 + (k.y - l.y) ** 2 >= MINPX * MINPX)) kept.push(l)
            // PER_CONTIG に均等サンプル(両端含む)
            let sel = kept
            if (kept.length > PER_CONTIG) {
              sel = []
              for (let i = 0; i < PER_CONTIG; i++)
                sel.push(kept[Math.round(i * (kept.length - 1) / (PER_CONTIG - 1))])
            }
            // 両端を先頭に(ラウンドロビンで各コンティグの範囲が先に確保されるように)
            const ordered = sel.length <= 2 ? sel : [sel[0], sel[sel.length - 1], ...sel.slice(1, -1)]
            perContig.push(ordered.map(l => ({ m: l.m, x: l.x, y: l.y, name,
                                               wx: l.wx, wy: l.wy, a: l.a, strand: l.strand })))
          }
          // 配分は2段階。① 各コンティグに最低1個を緩い近接ガード(GUARANTEE_MINPX)で確保＝隣接コンティグの
          //   共倒れ(starvation)を防ぐ。② 残り(各リスト index1 以降)を通常 MINPX で round-robin し GLOBAL まで。
          const GUARANTEE_MINPX = 32   // ①の近接ガード。ほぼ同一位置(<32px)の重複だけ弾く=各コンティグは基本1個出る
          const placed: { x: number; y: number }[] = []
          let drawn = 0
          const emitLabel = (l: Lab) => {
            placed.push({ x: l.x, y: l.y }); drawn++
            emitText(fmtRuler(l.m, l.name), l.x, l.y, 0.5, 1.7, 11, 0x0b5394, true)
            // ref 方向矢印: ノード軸 l.a に沿い、ref がそのノードを辿る向き(strand=1→+l.a, 0→-l.a)を指す。
            // world 空間(nodeLayer)に描く＝ノード回転・パン/ズームに追従。bp テキストは screen 空間で読める向き。
            const sgn = l.strand === 0 ? -1 : 1
            const ux = Math.cos(l.a) * sgn, uy = Math.sin(l.a) * sgn
            const px = -uy, py = ux
            const al = 9 / zoom, aw = 5 / zoom          // 矢印 半長/半幅(≈画面 18px 長)
            const cxw = l.wx - originX, cyw = l.wy - originY
            nodeLayer.lineStyle(0)
            nodeLayer.beginFill(0x0b5394, 0.95)
            nodeLayer.drawPolygon([
              cxw + ux * al, cyw + uy * al,                           // 尖端
              cxw - ux * al + px * aw, cyw - uy * al + py * aw,
              cxw - ux * al - px * aw, cyw - uy * al - py * aw,
            ])
            nodeLayer.endFill()
          }
          // ① 各コンティグの先頭(端)ラベルを緩ガードで確保。近接<GUARANTEE_MINPX の重複だけ弾く。
          const G2 = GUARANTEE_MINPX * GUARANTEE_MINPX
          for (const list of perContig) {
            if (drawn >= GLOBAL) break
            const l = list[0]; if (!l) continue
            if (placed.every(p => (p.x - l.x) ** 2 + (p.y - l.y) ** 2 >= G2)) emitLabel(l)
          }
          // ② 残りを通常 MINPX(重なり回避)で round-robin。物理的に重なる(<MINPX)ものは弾く。
          for (let round = 1, active = true; active && drawn < GLOBAL; round++) {
            active = false
            for (const list of perContig) {
              if (round >= list.length) continue
              active = true
              if (drawn >= GLOBAL) break
              const l = list[round]
              if (!placed.every(p => (p.x - l.x) ** 2 + (p.y - l.y) ** 2 >= MINPX * MINPX)) continue
              emitLabel(l)
            }
          }
        }
        // ── アノテ・オーバーレイ: バンド名 / 領域名(ランドマーク) / 遺伝子名 ──
        // A2 と同じくノード吸着＋emitText。fill を消費しない(名前ラベルのみ)ので color-by と併用可。
        const inRR = (n: NodeData) => {
          const w = Math.max(n.radius * 2 * nodeScl, minW), b = w / 2 * 1.4
          return !(n.xCoord + b < renderRect.x1 || n.xCoord - b > renderRect.x2 ||
                   n.yCoord + b < renderRect.y1 || n.yCoord - b > renderRect.y2)
        }
        // band_id / region_class を代表ノード(グループ world 重心に最寄り)へ名前ラベル。画面 minpx で間引き。
        const drawKeyLabels = (keyOf: (n: NodeData) => number | null | undefined,
                               nameOf: (k: number) => string | undefined, color: number, minpx: number) => {
          const cen = new Map<number, { wx: number; wy: number; n: number }>()
          for (const n of visibleNodes) {
            const k = keyOf(n); if (k == null || hiddenNodeIds.has(n.id) || !inRR(n)) continue
            const c = cen.get(k)
            if (c) { c.wx += n.xCoord; c.wy += n.yCoord; c.n++ } else cen.set(k, { wx: n.xCoord, wy: n.yCoord, n: 1 })
          }
          const rep = new Map<number, { x: number; y: number; d2: number }>()
          for (const n of visibleNodes) {
            const k = keyOf(n); if (k == null || hiddenNodeIds.has(n.id) || !inRR(n)) continue
            const c = cen.get(k)!; const d2 = (n.xCoord - c.wx / c.n) ** 2 + (n.yCoord - c.wy / c.n) ** 2
            const prev = rep.get(k)
            if (!prev || d2 < prev.d2) { const sp = worldToScreen(n.xCoord, n.yCoord); rep.set(k, { x: sp.x, y: sp.y, d2 }) }
          }
          const placed: { x: number; y: number }[] = []
          for (const [k, r] of rep) {
            const name = nameOf(k)
            if (!name) continue
            if (!placed.every(p => (p.x - r.x) ** 2 + (p.y - r.y) ** 2 >= minpx * minpx)) continue
            placed.push({ x: r.x, y: r.y }); emitText(name, r.x, r.y - 12, 0.5, 0.5, 11, color, true)
          }
        }
        if (showBandLabelsRef.current)
          drawKeyLabels(n => n.band_id, k => bandDictRef.current.get(k)?.name, 0x862e9c, 80)
        if (showRegionMarksRef.current)
          drawKeyLabels(n => n.region_class, k => regionDictRef.current.get(k)?.name, 0xc92a2a, 90)

        // 遺伝子名: 可視 ref_bp 範囲に重なる遺伝子を、中点に最寄りのノードへ吸着(strand 矢印付き)。単一コンティグ前提。
        if (showGeneLabelsRef.current && geneFeaturesRef.current.length) {
          const rn: { bp: number; x: number; y: number }[] = []
          for (const n of visibleNodes) {
            if (n.ref_bp == null || hiddenNodeIds.has(n.id) || !inRR(n)) continue
            const sp = worldToScreen(n.xCoord, n.yCoord)
            rn.push({ bp: (Number(n.ref_bp) + Number(n.ref_bp_end ?? n.ref_bp)) / 2, x: sp.x, y: sp.y })
          }
          if (rn.length) {
            rn.sort((a, b) => a.bp - b.bp)
            const bpMin = rn[0].bp, bpMax = rn[rn.length - 1].bp
            const placed: { x: number; y: number }[] = []
            let cnt = 0
            for (const g of geneFeaturesRef.current) {
              if (cnt >= 24) break
              if (g.name.startsWith('ENSG')) continue   // 記号なし(ENSG…)はラベルが煩雑なので省く
              if (g.end <= bpMin || g.start >= bpMax) continue
              const mid = (g.start + g.end) / 2
              let lo = 0, hi = rn.length - 1
              while (lo < hi) { const m = (lo + hi) >> 1; if (rn[m].bp < mid) lo = m + 1; else hi = m }
              if (lo > 0 && Math.abs(rn[lo - 1].bp - mid) < Math.abs(rn[lo].bp - mid)) lo--
              const r = rn[lo]
              if (!placed.every(p => (p.x - r.x) ** 2 + (p.y - r.y) ** 2 >= 66 * 66)) continue
              placed.push({ x: r.x, y: r.y }); cnt++
              const arr = g.strand === '-' ? ' ◄' : g.strand === '+' ? ' ►' : ''
              emitText(g.name + arr, r.x, r.y - 12, 0.5, 0.5, 10, 0x2b8a3e, true)
            }
          }
        }

        // ── 選択遺伝子: exon 番号ラベル＋遺伝子名(ノード内 exon 塗り分けは node ループで実施済) ──
        if (selectedGeneRef.current) {
          const g = selectedGeneRef.current
          const exs = selectedGeneExonsRef.current
          const placed: { x: number; y: number }[] = []
          let gx = 0, gy = 0, cnt = 0
          for (const n of visibleNodes) {
            // ref_multi は外接ボックスで exon が不可視化するので exon 番号も出さない(塗りと整合)
            if (n.ref_bp == null || n.ref_multi || hiddenNodeIds.has(n.id) || !inRR(n)) continue
            const s = Number(n.ref_bp), e = Number(n.ref_bp_end ?? n.ref_bp)
            if (!(e > g.start && s < g.end)) continue
            const sp = worldToScreen(n.xCoord, n.yCoord)
            gx += sp.x; gy += sp.y; cnt++
            let best: number | null = null, bestov = 0
            for (const ex of exs) {
              const ov = Math.min(e, ex.end) - Math.max(s, ex.start)
              if (ov > bestov) { bestov = ov; best = ex.exon_no }
            }
            if (best != null && placed.every(p => (p.x - sp.x) ** 2 + (p.y - sp.y) ** 2 >= 42 * 42)) {
              placed.push({ x: sp.x, y: sp.y })
              emitText('e' + best, sp.x, sp.y + 12, 0.5, 0.5, 9, 0x2b8a3e, true)
            }
          }
          if (cnt) emitText(g.name, gx / cnt, gy / cnt, 0.5, 3.4, 12, 0x2b8a3e, true)
        }
        // 使わなかったプール分は破棄せず非表示に(次フレームで再利用)。
        for (let i = poolIdx; i < tl.children.length; i++) tl.children[i].visible = false
      }

      renderPaths()
      renderRibbons()
      renderUi()
      markDirty()
    }

    // パスリボン: 群が通過する super-node 本体とオンノードのエッジを、全層で一定太さの帯として描く。
    // 各区間を「一定スクリーン幅の塗りつぶしクアッド」で描く（lineStyle は使わない）。
    // 理由: lineStyle(native:false) は内部 buildLine が closePointEps(≈1e-4) より短い区間を
    // スキップするため、正規化座標[0,1]の深層(edge長~2e-5)で消える。塗りつぶしポリゴンはこの
    // スキップが無く、最小長を保証すれば layer に依らず一定太さ(=W スクリーン px)で描ける。
    // 複数リボンは y 方向に STAGGER ずらして重なりを見せ、1 群だけ別経路へ逸れるのを可視化。
    function renderRibbons() {
      const rl = ribbonLayerRef.current
      if (!rl) return
      rl.clear()
      const ribs = ribbonsRef.current
      if (!ribs || ribs.length === 0) return
      const zoom = world.scale.x
      const W = 3 / zoom            // 一定太さ = 3 スクリーン px（world 単位に換算）
      const half = W / 2
      const STAGGER = W * 1.6        // リボン間隔(本体幅 W の 1.6 倍)=隙間を空けて複数を見分けやすく
      const vp = getViewport()
      const rr = expandRect(vp, RENDER_MARGIN)
      // floating origin（render() と同方式; 絶対座標の float32 量子化を避ける）
      const originX = (vp.x1 + vp.x2) / 2
      const originY = (vp.y1 + vp.y2) / 2
      rl.position.set(originX, originY)
      const scale = nodeScaleRef.current   // ノードサイズ倍率にリボンも追従（node中心周りにスケール）
      const edgeVisible = (sx: number, sy: number, ex: number, ey: number) =>
        !((sx < rr.x1 && ex < rr.x1) || (sx > rr.x2 && ex > rr.x2) ||
          (sy < rr.y1 && ey < rr.y1) || (sy > rr.y2 && ey > rr.y2))
      // 区間 A→B を幅 W の矩形（塗りつぶしクアッド）として rl に追加。
      // 短すぎる区間は中心を保ったまま最低 W まで延ばし、点状でも一定サイズのマークにする。
      // 区間 A→B を幅 2h の矩形(塗りクアッド)で描く。h は半幅(既定=本体の half)。
      const addSeg = (ax: number, ay: number, bx: number, by: number, h: number = half) => {
        let dx = bx - ax, dy = by - ay
        let len = Math.hypot(dx, dy)
        if (len < W) {
          const mx = (ax + bx) / 2, my = (ay + by) / 2
          if (len < 1e-12) { dx = 1; dy = 0; len = 1 }   // 完全な点は x 方向へ延ばす
          const ux = dx / len, uy = dy / len
          ax = mx - ux * half; ay = my - uy * half
          bx = mx + ux * half; by = my + uy * half
          dx = bx - ax; dy = by - ay; len = W
        }
        const px = -dy / len * h, py = dx / len * h  // 進行方向に直交する半幅ベクトル(h=半幅)
        rl.drawPolygon([ax + px - originX, ay + py - originY, bx + px - originX, by + py - originY,
                        bx - px - originX, by - py - originY, ax - px - originX, ay - py - originY])
      }
      ribs.forEach((rib, ri) => {
        const hasGeom = (rib.nodes && rib.nodes.length) || (rib.edges && rib.edges.length)
        if (!hasGeom) return
        const off = (ri - (ribs.length - 1) / 2) * STAGGER
        // エッジ端点を su/tv ノード中心の周りに scale 倍するための rowid → 中心 索引（scale≠1 のときだけ）。
        const ctr = scale !== 1 ? new Map(rib.nodes.map(n => [n.id, n])) : null
        // エッジ端点を su/tv 中心周りに scale 倍した座標(fill/縁取り両パスで共用)。
        const edgeXY = (e: { su: number; tv: number; sx: number; sy: number; ex: number; ey: number }) => {
          let sx = e.sx, sy = e.sy, ex = e.ex, ey = e.ey
          if (ctr) {
            const s = ctr.get(e.su), t = ctr.get(e.tv)
            if (s) { sx = s.x + (e.sx - s.x) * scale; sy = s.y + (e.sy - s.y) * scale }
            if (t) { ex = t.x + (e.ex - t.x) * scale; ey = t.y + (e.ey - t.y) * scale }
          }
          return { sx, sy, ex, ey }
        }
        const nodeVisible = (n: { x: number; y: number; r: number }) => {
          const nb = n.r * scale
          return !(n.x + nb < rr.x1 || n.x - nb > rr.x2 || n.y + nb < rr.y1 || n.y - nb > rr.y2)
        }
        rl.lineStyle(0)
        // 本体色(全セグメント。off は縦方向ステガー=複数リボンを隙間付きで平行に上下配置。順序は ri で固定
        // ＝入れ替わらない。継ぎ目ずれも無い)
        rl.beginFill(rib.color, 0.9)
        for (const e of rib.edges) {
          const { sx, sy, ex, ey } = edgeXY(e)
          if (!edgeVisible(sx, sy, ex, ey)) continue
          addSeg(sx, sy + off, ex, ey + off)
        }
        for (const n of rib.nodes) {
          if (!nodeVisible(n)) continue
          // ノード本体長も scale 倍（中心 n.x,n.y の周りで拡縮＝ノード矩形の拡大に一致）。
          const nb = n.r * scale
          const dx = Math.cos(n.a) * nb, dy = Math.sin(n.a) * nb
          addSeg(n.x - dx, n.y - dy + off, n.x + dx, n.y + dy + off)
        }
        rl.endFill()
        // 逆位マーカー(非色チャネル・非方向): ref 方向は別途矢印で示すので向きは不要＝逆位であることだけ示せば十分。
        // 逆位ノード/エッジを「本体より太い暗色帯」(本体幅×1.7)で上塗りし、連続した膨らんだ暗色帯として逆位区間を
        // 明示。幅は W 相対(=画面固定)＋最小長 W 保証なので、ノードが小さく密でも縮まず消えない。隙間(STAGGER=W×1.6)
        // 内に収まるので複数サンプルでも通常は隣に滲まない(塗りなので深層でも消えない; lineStyle 不使用)。
        const hasInv = rib.edges.some(e => e.inv) || rib.nodes.some(n => n.inv)
        if (hasInv) {
          const invH = half * 1.7            // 本体(half)より太い＝逆位区間が膨らんで目立つ
          rl.beginFill(0x111111, 0.95)
          for (const e of rib.edges) {
            if (!e.inv) continue
            const { sx, sy, ex, ey } = edgeXY(e)
            if (!edgeVisible(sx, sy, ex, ey)) continue
            addSeg(sx, sy + off, ex, ey + off, invH)
          }
          for (const n of rib.nodes) {
            if (!n.inv || !nodeVisible(n)) continue
            const nb = n.r * scale
            const dx = Math.cos(n.a) * nb, dy = Math.sin(n.a) * nb
            addSeg(n.x - dx, n.y - dy + off, n.x + dx, n.y + dy + off, invH)
          }
          rl.endFill()
        }
      })
      markDirty()
    }

    function renderPaths() {
      pathLayer.clear()
      const zoom = world.scale.x
      const viewport = getViewport()
      const renderRect = expandRect(viewport, RENDER_MARGIN)
      // floating origin（render() と同方式; 絶対座標の float32 量子化を避ける）
      const originX = (viewport.x1 + viewport.x2) / 2
      const originY = (viewport.y1 + viewport.y2) / 2
      pathLayer.position.set(originX, originY)
      const STAGGER = 2.5 / zoom
      const covMin = coverageMinRef.current

      // Compute per-edge path index for stagger: edgeKey → ctgName → index
      const edgeCtgIndex = new Map<string, Map<string, number>>()
      for (const [ctgName] of selectedPathsRef.current) {
        const cached = pathCacheRef.current.get(ctgName)
        if (!cached) continue
        for (const step of cached.steps) {
          const key = `${Math.min(step.from_id, step.to_id)}_${Math.max(step.from_id, step.to_id)}`
          if (!edgeCtgIndex.has(key)) edgeCtgIndex.set(key, new Map())
          const m = edgeCtgIndex.get(key)!
          if (!m.has(ctgName)) m.set(ctgName, m.size)
        }
      }

      for (const [ctgName, color] of selectedPathsRef.current) {
        const cached = pathCacheRef.current.get(ctgName)
        if (!cached) continue

        if (cached.steps.length === 0) {
          const n = cached.nodes[0]
          if (n) {
            const nd = nodeStore.get(n.id)
            const hidden = covMin > 0 && nd !== undefined && (nd.coverage ?? 0) < covMin
            if (!hidden) {
              pathLayer.lineStyle(2.5 / zoom, color, 0.85, 0.5, true)
              pathLayer.beginFill(color, 0.25)
              pathLayer.drawCircle(n.xCoord - originX, n.yCoord - originY, 6 / zoom)
              pathLayer.endFill()
            }
          }
          continue
        }

        pathLayer.lineStyle(6 / zoom, color, 0.6, 0.5, false)
        let prevEndX: number | null = null
        let prevEndY: number | null = null

        for (const step of cached.steps) {
          // Coverage filter: skip steps involving hidden nodes
          if (covMin > 0) {
            const fNode = nodeStore.get(step.from_id)
            const tNode = nodeStore.get(step.to_id)
            if (fNode !== undefined && (fNode.coverage ?? 0) < covMin) { prevEndX = null; prevEndY = null; continue }
            if (tNode !== undefined && (tNode.coverage ?? 0) < covMin) { prevEndX = null; prevEndY = null; continue }
          }

          const key = `${Math.min(step.from_id, step.to_id)}_${Math.max(step.from_id, step.to_id)}`
          const pathsOnEdge = edgeCtgIndex.get(key)?.size ?? 1
          const myIdx = edgeCtgIndex.get(key)?.get(ctgName) ?? 0
          const offset = (myIdx - (pathsOnEdge - 1) / 2) * STAGGER

          const edgeDx = step.to_x - step.from_x
          const edgeDy = step.to_y - step.from_y
          const len = Math.hypot(edgeDx, edgeDy) || 1
          const perpX = -edgeDy / len
          const perpY =  edgeDx / len

          const fx  = step.from_x  + perpX * offset
          const fy  = step.from_y  + perpY * offset
          const fcx = step.from_cx + perpX * offset
          const fcy = step.from_cy + perpY * offset
          const tx  = step.to_x    + perpX * offset
          const ty  = step.to_y    + perpY * offset
          const tcx = step.to_cx   + perpX * offset
          const tcy = step.to_cy   + perpY * offset

          // Viewport culling
          const minX = Math.min(fx, fcx, tx, tcx)
          const maxX = Math.max(fx, fcx, tx, tcx)
          const minY = Math.min(fy, fcy, ty, tcy)
          const maxY = Math.max(fy, fcy, ty, tcy)
          if (maxX < renderRect.x1 || minX > renderRect.x2 || maxY < renderRect.y1 || minY > renderRect.y2) {
            prevEndX = null; prevEndY = null
            continue
          }

          if (prevEndX !== null && prevEndY !== null) {
            pathLayer.moveTo(prevEndX - originX, prevEndY - originY)
            pathLayer.lineTo(fx - originX, fy - originY)
          }
          pathLayer.moveTo(fx - originX, fy - originY)
          pathLayer.bezierCurveTo(fcx - originX, fcy - originY, tcx - originX, tcy - originY, tx - originX, ty - originY)
          prevEndX = tx
          prevEndY = ty
        }
      }
      markDirty()
    }
    renderPathsRef.current = renderPaths
    renderRibbonsRef.current = renderRibbons
    renderRef.current = render

    function renderUi() {
      uiLayer.clear()
      markDirty()   // uiLayer は必ず clear するので、早期 return 経路も含め常に再描画が要る

      // 検索ハイライト: 編集モード問わず描画
      if (highlightIdRef.current !== null) {
        const hn = visibleNodes.find(n => n.id === highlightIdRef.current)
        if (hn) {
          const s = worldToScreen(hn.xCoord, hn.yCoord)
          uiLayer.lineStyle(2.5, 0xff6b00, 1.0)
          uiLayer.beginFill(0, 0)
          uiLayer.drawCircle(s.x, s.y, 16)
          uiLayer.endFill()
          uiLayer.lineStyle(1.5, 0xff6b00, 0.45)
          uiLayer.beginFill(0, 0)
          uiLayer.drawCircle(s.x, s.y, 28)
          uiLayer.endFill()
        }
      }

      // MSA 対象の選択ノード(橙の二重リング)＋パネル hover 中ノード(マゼンタのハロー＋白縁太リング)。
      // 白縁を重ねてどの塗り色(青/緑)の上でも視認できるようにする。編集モード非依存。
      const msaHi = msaHiRef.current
      const msaHov = msaHoverRef.current
      if ((msaHi && msaHi.size) || (msaHov && msaHov.size)) {
        for (const n of visibleNodes) {
          const isHi = msaHi?.has(n.node_name)
          const isHov = msaHov?.has(n.node_name)
          if (!isHi && !isHov) continue
          const s = worldToScreen(n.xCoord, n.yCoord)
          if (isHov) {
            uiLayer.lineStyle(0)
            uiLayer.beginFill(0xff1493, 0.30); uiLayer.drawCircle(s.x, s.y, 25); uiLayer.endFill()   // ハロー
            uiLayer.lineStyle(2.5, 0xffffff, 0.95); uiLayer.beginFill(0, 0); uiLayer.drawCircle(s.x, s.y, 22); uiLayer.endFill()
            uiLayer.lineStyle(4, 0xff1493, 1.0); uiLayer.beginFill(0, 0); uiLayer.drawCircle(s.x, s.y, 19); uiLayer.endFill()
          } else {
            uiLayer.lineStyle(2, 0xffffff, 0.9); uiLayer.beginFill(0, 0); uiLayer.drawCircle(s.x, s.y, 17); uiLayer.endFill()
            uiLayer.lineStyle(3.5, 0xff7a00, 1.0); uiLayer.beginFill(0, 0); uiLayer.drawCircle(s.x, s.y, 15); uiLayer.endFill()
          }
        }
      }

      if (!editModeRef.current) return

      if (isBoxSelecting) {
        const x = Math.min(boxStart.x, boxEnd.x), y = Math.min(boxStart.y, boxEnd.y)
        const w = Math.abs(boxEnd.x - boxStart.x), h = Math.abs(boxEnd.y - boxStart.y)
        uiLayer.lineStyle(1, 0x1971c2, 0.8)
        uiLayer.beginFill(0x339af0, 0.1)
        uiLayer.drawRect(x, y, w, h)
        uiLayer.endFill()
      }

      const info = getRotationHandleInfo()
      if (info) {
        uiLayer.lineStyle(1, 0xf08c00, 0.7)
        uiLayer.moveTo(info.sx, info.sy + 32)
        uiLayer.lineTo(info.sx, info.sy + 8)
        uiLayer.lineStyle(2, 0xf08c00, 1.0)
        uiLayer.beginFill(isRotating ? 0xffd43b : 0xfff3bf, 1.0)
        uiLayer.drawCircle(info.sx, info.sy, 8)
        uiLayer.endFill()
      }

      // 移動ハンドル（選択重心・4方向矢印）: 掴んで選択全体を移動
      const mv = getMoveHandleInfo()
      if (mv) {
        const R = 11, a = 7, h = 3   // 円半径 / 矢印半長 / 矢尻サイズ
        uiLayer.lineStyle(2, 0x1971c2, 1.0)
        uiLayer.beginFill(isMovingNodes ? 0x74c0fc : 0xe7f5ff, 0.95)
        uiLayer.drawCircle(mv.sx, mv.sy, R)
        uiLayer.endFill()
        // 十字
        uiLayer.lineStyle(1.5, 0x1971c2, 1.0)
        uiLayer.moveTo(mv.sx - a, mv.sy); uiLayer.lineTo(mv.sx + a, mv.sy)
        uiLayer.moveTo(mv.sx, mv.sy - a); uiLayer.lineTo(mv.sx, mv.sy + a)
        // 4方向の矢尻
        uiLayer.moveTo(mv.sx - a + h, mv.sy - h); uiLayer.lineTo(mv.sx - a, mv.sy); uiLayer.lineTo(mv.sx - a + h, mv.sy + h)
        uiLayer.moveTo(mv.sx + a - h, mv.sy - h); uiLayer.lineTo(mv.sx + a, mv.sy); uiLayer.lineTo(mv.sx + a - h, mv.sy + h)
        uiLayer.moveTo(mv.sx - h, mv.sy - a + h); uiLayer.lineTo(mv.sx, mv.sy - a); uiLayer.lineTo(mv.sx + h, mv.sy - a + h)
        uiLayer.moveTo(mv.sx - h, mv.sy + a - h); uiLayer.lineTo(mv.sx, mv.sy + a); uiLayer.lineTo(mv.sx + h, mv.sy + a - h)
      }
    }

    // 表示範囲内で layer のグリフ数を数える（描画前の重さ判定用・クエリ不要）。
    function countInView(layer: number, gz: number, rect: Rect): number {
      const { nodeIds } = getVisibleIds(layer, gz, rect)
      const minW = 3 / world.scale.x
      const scale = nodeScaleRef.current
      let n = 0
      for (const id of nodeIds) {
        const nd = nodeStore.get(id); if (!nd) continue
        const b = Math.max(nd.radius * 2 * scale, minW) * 0.7
        if (nd.xCoord + b < rect.x1 || nd.xCoord - b > rect.x2) continue
        if (nd.yCoord + b < rect.y1 || nd.yCoord - b > rect.y2) continue
        n++
      }
      return n
    }

    // 新層(currentLayer)のタイルが現在ビューで揃ったら displayLayer に昇格し、シームレスに差し替える。
    // 揃うまでは旧 displayLayer を現在の zoom で描き続ける（PIXI world 変換で追従＝単純拡大図）。
    function maybePromote() {
      // ★昇格条件は「層が変わった」だけでなく **「格子解像度(gz)が変わった」** も含める。
      //   gz は curGridZ()=gzForLayer(autoLayer) でカメラ基準、currentLayer は pick_layer の
      //   予算で切り下げられた served。よって **currentLayer が据え置きのまま gz だけ動く**
      //   ことがある（予算で層が頭打ちの領域を高速パンした時など）。
      //   旧実装は displayLayer !== currentLayer の時しか displayGz を更新しなかったので、
      //   その場合 displayGz が古いまま固定され、取得は新 gz・描画は旧 gz で引くことになり
      //   **タイルが見つからず真っ白**になった。層が変わるかリロードするまで直らない
      //   （「高速パン中に一部領域が描画されない／リロードで即出る」の正体）。
      const gz = curGridZ()
      if (displayLayer !== currentLayer || displayGz !== gz) {
        const renderRect = expandRect(getViewport(), RENDER_MARGIN)
        // ノードタイルが実際に揃えば昇格（エッジは遅れて乗っても白飛びしない）。空領域も fetch 済みなら揃う。
        // 揃うまでは旧 displayLayer/displayGz のまま描くので、遷移中に白飛びしない。
        if (areTilesCached(currentLayer, gz, renderRect, 'nodes')) {
          displayLayer = currentLayer
          displayGz = gz
        }
      }
      // §7 重さゲート: settle 済み（ドラッグ中でない）で、描く層の画面内枚数が cap 超なら描画を止めて
      // 警告（前フレーム維持）。抑制中/「続行」選択済みならそのまま描画。層・f(n) には触れない（パン不変）。
      // 格子解像度はカメラ基準なのでタイルは爆発しない → 「詳細+N で本当に画面内ノードが多すぎる」ときだけ発火。
      if (RENDER_CAP_NODES > 0 && !isDragging && !heavySuppressRef.current && !heavyProceedRef.current) {
        const c = countInView(Math.max(0, displayLayer), displayGz, expandRect(getViewport(), RENDER_MARGIN))
        if (RENDER_CAP_NODES > 0 && c > RENDER_CAP_NODES) { onHeavyRef.current?.(c); return }
      }
      render()   // lastGlyphs を実描画数に更新
      // バッジ/ミニマップへ現況を報告（タイル到着後も glyphs が正しく更新される）。
      onVCRef.current?.(getViewport(), Math.max(0, displayLayer), lastGlyphs)
    }

    // ── タイル fetch ──────────────────────────────────────────────────
    // アイテムのMBRがタイル bbox と重なるか。backend R-tree の overlap 判定
    // （nodes: 中心±radius / edges: start/end/startc/endc の外接矩形）と同義。
    // これにより「1タイル=1クエリ」を union 矩形の 1 クエリに束ねても各タイルの中身が一致する。
    function itemOverlapsTile(it: NodeData | EdgeData, b: Rect, table: string): boolean {
      if (table === 'nodes') {
        const n = it as NodeData
        const r = n.radius ?? 0
        return n.xCoord + r >= b.x1 && n.xCoord - r <= b.x2 &&
               n.yCoord + r >= b.y1 && n.yCoord - r <= b.y2
      }
      const e = it as EdgeData
      const minx = Math.min(e.start_x, e.end_x, e.startc_x, e.endc_x)
      const maxx = Math.max(e.start_x, e.end_x, e.startc_x, e.endc_x)
      const miny = Math.min(e.start_y, e.end_y, e.startc_y, e.endc_y)
      const maxy = Math.max(e.start_y, e.end_y, e.startc_y, e.endc_y)
      return maxx >= b.x1 && minx <= b.x2 && maxy >= b.y1 && miny <= b.y2
    }

    // A: 欠損タイル群を「外接矩形の 1 クエリ」でまとめて取得し、各タイルへ MBR 重なりで振り分ける。
    // 空タイルも storeTileData で cached 印を付ける（areTilesCached による昇格判定を維持）。
    // B で 1 層あたりのタイル数は ≒K_TILES² に収まるので union の無駄取得は最小。
    // layer=内容層(どの層のノードを取るか), gz=タイル格子解像度(カメラズーム基準)。
    // 実行中のタイル取得。パンで用済みになったものを abort するために控えておく。
    //
    // backend は better-sqlite3（同期 API）なので、**始まってしまったクエリは中断できない**
    // （イベントループごと止まるので切断イベントすら受け取れない）。実測: 重いリクエストを
    // 2 秒でクライアント切断しても後続の軽いリクエストが 7.81 秒待たされ、3 本放棄すると 27.9 秒。
    // ただし backend 側に「ハンドラ入口で切断済み GET を捨てる」ガードを入れたので、
    // **キュー待ちの分は abort が効く**（待っている間はイベントループが回るため切断が届く）。
    // よってここで abort する価値がある: 実行中の 1 本は止まらないが、積み上がりは止まる。
    // abort したときに **その場で** タイルの「fetch 中」印を外せるよう、どのタイルを掴んで
    // いるかも持つ。★getMissingTiles は fetch 中のタイルを missing 扱いしない仕様なので、
    //   abort → unmarkFetching が finally(次のマイクロタスク) だと、同じ tick で走る次の
    //   checkAndFetch が「まだ取得中だから任せよう」と誤判断して**そのタイルを取り直さない**。
    //   その状態で edge へ進むと nodeStore が空なので端点復元で全滅し、しかも空のまま
    //   「取得済み」になってリロードまで edge が出なくなる（座標付き URL で実際に踏んだ）。
    type InFlight = {
      ctrl: AbortController; layer: number; bbox: Rect
      gz: number; table: string; tiles: Array<{ tx: number; ty: number }>
      /** この取得の完了 promise（edge を「ノードが全部落ち着くまで」待たせるのに使う） */
      done?: Promise<boolean>
    }
    const inFlight = new Set<InFlight>()

    // 用済みになった取得を abort する。現在の層でない or 先読み矩形と重ならないものが対象。
    // abort した取得のタイルは **同期で** unmark する（finally を待たない）。
    // 待つと、同じ tick の次の checkAndFetch が getMissingTiles でそのタイルを
    // 「fetch 中＝任せてよい」と見て取り直さず、ノード欠けのまま edge へ進んでしまう。
    function releaseTiles(f: InFlight) {
      for (const { tx, ty } of f.tiles) unmarkFetching(f.layer, f.gz, tx, ty, f.table)
    }
    function abortStaleFetches(rect: Rect, layer: number) {
      for (const f of [...inFlight]) {
        const stale = f.layer !== layer
          || f.bbox.x2 < rect.x1 || f.bbox.x1 > rect.x2
          || f.bbox.y2 < rect.y1 || f.bbox.y1 > rect.y2
        if (stale) { f.ctrl.abort(); releaseTiles(f); inFlight.delete(f) }
      }
    }
    function abortAllFetches() {
      for (const f of inFlight) { f.ctrl.abort(); releaseTiles(f) }
      inFlight.clear()
    }

    // 戻り値 = **その表のタイルを実際に埋めたか**。
    // false は「中断/失敗/世代違いなどで捨てた」＝タイルは未取得のまま(finally で unmark される)。
    // ★呼び側は必ずこれを見て後続を止めること。signed edge の端点復元は nodeStore に依存するので、
    //   ノード取得が false のまま edge を取ると両端が見つからず全部捨てられ、しかも
    //   storeTileData が 0 件でもタイルを『取得済み』にするため、**リロードするまで edge が
    //   永久に出なくなる**（座標付き URL で初期化中にビューが動くと実際に踏んだ）。
    function fetchTileBatch(layer: number, gz: number, tiles: Array<{ tx: number; ty: number }>, table: string): Promise<boolean> {
      if (tiles.length === 0) return Promise.resolve(true)
      for (const { tx, ty } of tiles) markFetching(layer, gz, tx, ty, table)
      if (++fetchCount === 1) onLoadingRef.current?.(true)
      // 欠損タイルの外接矩形（union）
      let ux1 = Infinity, uy1 = Infinity, ux2 = -Infinity, uy2 = -Infinity
      for (const { tx, ty } of tiles) {
        const b = tileBbox(gz, tx, ty)
        if (b.x1 < ux1) ux1 = b.x1
        if (b.y1 < uy1) uy1 = b.y1
        if (b.x2 > ux2) ux2 = b.x2
        if (b.y2 > uy2) uy2 = b.y2
      }
      const bbox: Rect = { x1: ux1, y1: uy1, x2: ux2, y2: uy2 }
      const mapq = mapMapqRef.current
      const sel = hapSelRef.current
      const mr = maxRowsRef.current
      const ctrl = new AbortController()
      const entry: InFlight = { ctrl, layer, bbox, gz, table, tiles }
      inFlight.add(entry)
      // 進捗: 取得ごとに pid を振り、backend の SharedArrayBuffer 上のカウンタを軽くポーリングする。
      // メインのイベントループが空いたので、重い取得の最中でもこの問い合わせは即答される。
      const pid = newPid()
      let progTimer: ReturnType<typeof setInterval> | null = null
      const startProgress = () => {
        if (!onProgRef.current) return
        progTimer = setInterval(async () => {
          const pr = await fetchProgress(pid)
          if (!pr || ctrl.signal.aborted) return
          if (pr.state === 'running') onProgRef.current?.({ rows: pr.rows, total: pr.total })
        }, 400)
      }
      const stopProgress = () => {
        if (progTimer) { clearInterval(progTimer); progTimer = null }
        if (fetchCount <= 1) onProgRef.current?.(null)   // 最後の 1 本が終わったら消す
      }
      startProgress()
      const gen = currentGeneration()   // 応答が届いた時にキャッシュ世代が変わっていたら捨てる
      // ★打ち切り(X-AMIPA-Truncated)を **このバッチについて** 受け取る受け皿。
      //   従来 fetchNodes/fetchEdges は打ち切りをグローバルな観測者へ通知するだけで、
      //   呼び出し側は「部分応答」だと知らないまま storeTileData で全タイルを『取得済み』に
      //   していた。結果、時間ガードで切られた領域が **空のまま恒久的にキャッシュされ**、
      //   「読み込み中の表示も出ず描画されない／パンしても直らない／リロードで即出る」
      //   になっていた（しかも時間ガードは早く返るので "fetch は遅くない" ように見える）。
      const guard: GuardSink = { truncated: null }
      const fetchFn = table === 'nodes'
        ? fetchNodes(layer, bbox, dbFile, mapq,
            [...(fastOkRef.current ? ['fast'] : []), ...fetchedNxRef.current].join(','),
            sel, mr, ctrl.signal, pid, guard)   // D2: 必要な annotation 群のみ（+ fast=幾何だけで足りる宣言）
        : fetchEdges(layer, bbox, dbFile, mapq, sel, mr, ctrl.signal, pid, guard)

      const p = fetchFn
        .then(items => {
          // キャッシュが clear された後（＝DB 切替や reload）に届いた応答は捨てる。
          // tileCache はマウントをまたぐシングルトンなので、これが無いと別 DB のノードが
          // 新しいキャッシュに入り、そのタイルが「取得済み」扱いで永久に埋まらない。
          if (!isCurrentGeneration(gen)) return false
          // mapq / hap 絞り込みが変わった後に届いた旧応答はキャッシュに入れない
          // （古い depth や絞り込み前の全件で上書きするのを防ぐ）
          if (mapq !== mapMapqRef.current || sel !== hapSelRef.current) return false
          let arr = items as (NodeData | EdgeData)[]
          // B: signed スキーマの edge は backend が座標を返さず src_sign/tgt_sign のみ。取得済みノード
          // (同 layer, nodeStore)から端点を復元して従来の座標入り EdgeData 形に整える（タイル振り分け・
          // 描画・編集追従は無改修）。両端ノードが未取得（取得域外）の edge は描画不能なので落とす。
          // checkAndFetch がノード取得後に edge を取得するので、域内 edge の両端は基本そろっている。
          if (table === 'edges' && arr.length > 0 && (arr[0] as EdgeData).src_sign != null) {
            const byName = new Map<string, NodeData>()
            for (const n of nodeStore.values()) if (n.layer === layer) byName.set(n.node_name, n)
            const out: EdgeData[] = []
            for (const it of arr as EdgeData[]) {
              const ns = byName.get(it.source), nt = byName.get(it.target)
              if (!ns || !nt) continue
              const [sx, sy] = rodEndpoint(ns, it.src_sign ?? 0, nt)
              const [ex, ey] = rodEndpoint(nt, it.tgt_sign ?? 0, ns)
              it.start_x = sx; it.start_y = sy; it.end_x = ex; it.end_y = ey
              it.startc_x = sx; it.startc_y = sy; it.endc_x = ex; it.endc_y = ey
              out.push(it)
            }
            // ★ここで全滅したら「ノードが揃っていないのに edge を取った」＝上流のバグ。
            //   storeTileData は 0 件でもタイルを『取得済み』にするので、放置すると
            //   リロードまで edge が出なくなる（座標付き URL の初期化で実際に起きた）。
            //   ノード取得の完了を待つ経路は checkAndFetch で保証しているが、
            //   打ち切り(X-AMIPA-Truncated)経由でも同じ形になりうるので観測できるようにしておく。
            if (out.length === 0 && (arr as EdgeData[]).length > 0) {
              console.warn(`edges L${layer}: ${(arr as EdgeData[]).length} 本すべて端点未取得で捨てた` +
                ` (nodeStore の同層 ${byName.size} 件)。ノード取得が不完全なまま edge を取っている可能性`)
            }
            arr = out
          }
          // ★時間ガードで切られた応答は **不完全** なので、タイルを『取得済み』にしない。
          //   そのままだと二度と取りに行かず空のまま固まる。データは捨てて掃き取りに任せる
          //   （時間ガードは cold I/O 起因の一過性なので、温まった後の再取得で通ることが多い）。
          //   'rows'(UX の表示上限)は利用者が意図した打ち切りなので従来どおり確定させる。
          // ★不完全な応答でタイルを確定させない。
          //   'cancel' = backend が走行中のクエリを中断し、**途中まで読んだ行を status 200 で**
          //   返したもの（実際に 16 行だけ入った空同然のタイルが恒久的に残っていた）。
          //   'time'   = 時間ガード。どちらも一過性なので、確定させず掃き取りで取り直す。
          //   'rows'   = 利用者が指定した表示上限なので、意図どおり確定させる。
          if (guard.truncated && guard.truncated !== 'rows') {
            console.warn(`fetch ${table} L${layer}: ${guard.truncated} で不完全な応答`
                       + ` → タイルを確定させず取り直す (${tiles.length} tiles, ${arr.length} 件)`)
            scheduleMissingSweep(500)
            return false
          }
          // 疎な領域では「タイルが 0 件」は正常なので、ここでの警告はしない
          //（実際 4 タイル中 3 が空で全件が 1 タイルに集中する、は普通に起きた）。
          // 「空が正しいのか間違っているのか」は backend と突き合わせないと判定できないので、
          // その照合は __amipaVerify() で行う。
          for (const { tx, ty } of tiles) {
            const b = tileBbox(gz, tx, ty)
            const part = arr.filter(it => itemOverlapsTile(it, b, table))
            pushStore({ t: Date.now(), table, layer, gz, tx, ty,
                        n: part.length, arrN: arr.length, bbox, tiles: tiles.length })
            storeTileData(layer, gz, tx, ty, table, part, bbox)
          }
          // layer が切り替わった後の応答は描画しない。currentLayer のタイルが揃えば昇格して差し替え。
          if (layer === currentLayer) maybePromote()
          return true
        })
        .catch(e => {
          // abort は「用済みになったので止めた」＝正常系。エラーとして出さない。
          // ただし **タイルは埋まっていない**ので false を返す（呼び側が後続を止める）。
          if ((e as any)?.name === 'AbortError') { scheduleMissingSweep(); return false }
          console.error(`fetch ${table} batch L${layer} (${tiles.length} tiles) failed:`, e)
          scheduleMissingSweep()
          return false
        })
        .finally(() => {
          stopProgress()
          inFlight.delete(entry)
          // abort/失敗でも必ず解除する。ここを飛ばすとそのタイルが二度と取得されない。
          for (const { tx, ty } of tiles) unmarkFetching(layer, gz, tx, ty, table)
          if (--fetchCount === 0) onLoadingRef.current?.(false)
        })
      entry.done = p
      return p
    }

    // edge は **その層のノード取得が 1 本も飛んでいない状態**になってから取る。
    //
    // なぜ必要か: getMissingTiles は「fetch 中」のタイルを missing 扱いしない。だから別の
    // checkAndFetch が掴んでいるノードタイルは、こちらの nodes バッチには含まれない
    // （＝こちらの nodes は「空で成功」する）。その状態で edge を取ると、signed edge の端点復元が
    // nodeStore を引けず**全部捨てられ**、しかも storeTileData が 0 件でもタイルを『取得済み』に
    // するので **リロードするまで edge が出なくなる**（座標付き URL の初期化で実際に起きた）。
    // 飛んでいるノード取得を allSettled で待ち、待っている間に増えていたらまた待つ（再帰）。
    // パン中はここで先延ばしされ、止まった時点で edge が乗る。
    function fetchEdgesAfterNodes(layer: number, gz: number, prefetchRect: Rect) {
      if (layer !== currentLayer) return
      // ★前提条件は「fetch 中が居ないか」ではなく **その矩形のノードタイルが実際にキャッシュ済みか**
      //   で直接見る（areTilesCached は fetch 中を cached 扱いしない）。in-flight の有無から
      //   推論すると、アンマウント時の abortAllFetches 後などに取りこぼす。
      if (areTilesCached(layer, gz, prefetchRect, 'nodes')) {
        fetchTileBatch(layer, gz, getMissingTiles(layer, gz, prefetchRect, 'edges'), 'edges')
        return
      }
      // まだ揃っていない。ノード取得が飛んでいるなら待って再判定（待つ間に増えていたらまた待つ）。
      const pending = [...inFlight].filter(f => f.table === 'nodes' && f.layer === layer && f.done)
      if (pending.length > 0) {
        Promise.allSettled(pending.map(f => f.done!))
          .then(() => fetchEdgesAfterNodes(layer, gz, prefetchRect))
      }
      // 飛んでいるものが無い（= abort されて未取得のまま）ならここでは何もしない。
      // タイルは unmark 済みなので、次の checkAndFetch がノードから取り直す。
    }

    // ★取りこぼしの自己修復。
    //   checkAndFetch は「中断されたら次の checkAndFetch で取り直される」前提だが、
    //   **カメラを止めるとその『次』が来ない**。結果、中断されたタイルが埋まらないまま
    //   「読み込み中の表示も出ずに一部が描かれない／リロードすると即座に出る」状態になる
    //   （タイルは unmarkFetching 済みなので、再取得の契機さえあれば直る）。
    //   そこで中断/失敗を観測したら少し待って **欠損が残っていれば取り直す**。
    //   getMissingTiles が空なら何もしないので、ループにはならない。
    let sweepTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleMissingSweep(delay = 400) {
      if (sweepTimer) return
      sweepTimer = setTimeout(() => {
        sweepTimer = null
        if (currentLayer < 0) return
        const vp = getViewport()
        const rect = expandRect(vp, FETCH_MARGIN)
        const gz = curGridZ()
        const miss = getMissingTiles(currentLayer, gz, rect, 'nodes').length
                   + getMissingTiles(currentLayer, gz, rect, 'edges').length
        if (miss > 0) checkAndFetch(vp, currentLayer)
      }, delay)
    }

    function checkAndFetch(viewport: Rect, layer: number) {
      // レイヤが変わる場合、かつ編集済みノードがある場合は確認を取る
      if (layer !== currentLayer && currentLayer !== -1 && isDirty) {
        const ok = window.confirm(
          '編集されたノードがあります。\n' +
          'レイヤを移動すると他レイヤとの表示整合性が失われます。\n' +
          'キャンセルするとレイヤ移動を中断します（ズームを元に戻してください）。\n\n' +
          '移動してよいですか？'
        )
        if (!ok) return  // ユーザーがキャンセル: レイヤ変更しない
        // 確定: 編集レイヤのキャッシュを全削除して整合性を保つ
        clearLayer(currentLayer)
        isDirty = false
      }

      currentLayer = layer
      const prefetchRect = expandRect(viewport, FETCH_MARGIN)
      const gz = curGridZ()   // 格子解像度はカメラズーム基準（内容層 layer とは独立）
      // 先読み矩形から外れた／層が変わった取得は、この時点で用済み。abort してキュー待ちを減らす。
      abortStaleFetches(prefetchRect, layer)

      // A: 欠損タイルをテーブルごとに 1 クエリへ束ねて取得（従来は 1 タイル=1 リクエスト）。
      // signed edge の端点復元にはノード座標が要る（B）ため、ノード取得を待ってから edge を取得する。
      // ノードが先に描画され、edge は後から乗る（座標保存 DB でも順序が変わるだけで害はない）。
      fetchTileBatch(layer, gz, getMissingTiles(layer, gz, prefetchRect, 'nodes'), 'nodes')
        .then(nodesOk => {
          // ★ノード取得が中断/失敗した(=nodeStore が不完全)なら edge を取らない。
          //   ノードは unmark 済みなので、次の checkAndFetch で取り直される。
          //   ただしカメラが止まるとその「次」が来ないので、掃き取りを予約しておく。
          if (!nodesOk) { scheduleMissingSweep(); return }
          if (layer !== currentLayer) return   // 待機中に別 layer へ settle したら中断
          // 他の checkAndFetch が掴んでいるノード取得も落ち着くまで待つ（上のコメント参照）
          fetchEdgesAfterNodes(layer, gz, prefetchRect)
        })
    }

    // ── LOD-A: camera zoom → 表示 layer のズーム閾値選択（§3） ───────────────
    // 層は「zoom z だけ」の関数。パン（表示範囲の移動）や in-view ノード数では絶対に変わらない。
    let lastGlyphs = 0        // 直近 render で実際に描いたグリフ数（バッジ表示用・クエリ不要）

    // 層 L のズーム閾値 f(L)=z_fit·layer_zoom[L]（§2）。z_fit は resize で変わるので毎回算出。
    // 密度ノブは廃止し、詳細度は「層オフセット」で扱う（layer_zoom の層間比が不均一でも 1 クリック=1 層）。
    // 較正窓の規約に応じて「f(L) をズーム閾値に直す係数」を変える。
    //   square_side_W_over_s(新): emitter は一辺 W/s の **正方形** 窓で較正している。実画面は
    //     sw×sh なので、面積を合わせる → (sw/z)(sh/z)=(W/s)^2 → z = s·√(sw·sh)/W。
    //     これで **canvas アスペクトも world アスペクトも式から消える**（グラフ依存バイアスの除去）。
    //   それ以外/欠落(旧DB): 従来式 z = s·sw/W。
    function thresholdFor(L: number): number {
      const w = worldBboxRef.current
      const W = w ? Math.max(1e-9, w.x1 - w.x0) : 1
      const sq = zoomWindowRef.current === 'square_side_W_over_s'
      const zFit = sq
        ? Math.sqrt(app.screen.width * app.screen.height) / W
        : app.screen.width / W
      const lz = layerZoomRef.current?.[L] ?? Math.pow(2, L / 2)   // メタ欠落時は D=2 相当のフォールバック
      return zFit * lz
    }

    // zoom → 表示層。まず zoom だけで自動層 autoLayer を選び（ヒステリシスで境界の往復抑制, §3.1）、
    // それに手動の層オフセット layerOffset を足す。オフセットは「1 段ちょうど」なので layer_zoom の
    // 層間比が大きい所（例 L6→L7 が 4 倍）でも ＋ 1 回で確実に 1 層深くなる。
    function chooseLayerByZoom(z: number): number {
      const LZ = layerZoomRef.current
      if (!LZ || LZ.length === 0) return clamp(Math.max(0, currentLayer) + layerOffsetRef.current, 0, maxLayer)
      let autoRaw = 0
      for (let L = 0; L <= maxLayer; L++) { if (thresholdFor(L) <= z) autoRaw = L; else break }
      let a = autoRaw
      if (autoLayer >= 0 && autoLayer <= maxLayer) {   // ヒステリシスは「zoom 自動層」に対してのみ
        const h = LOD_HYST
        const loKeep = thresholdFor(autoLayer) * (1 - h)
        const hiKeep = (autoLayer < maxLayer ? thresholdFor(autoLayer + 1) : Infinity) * (1 + h)
        if (z >= loKeep && z < hiKeep) a = autoLayer
      }
      autoLayer = a
      return clamp(a + layerOffsetRef.current, 0, maxLayer)
    }

    // タイル格子に整列させた矩形。小さなパンで「同じタイル集合」のままなら安全弁の判定結果が
    // 変わらない（＝backend 側 memo にも当たる）ようにするための量子化。
    function alignedRect(gz: number, r: Rect): Rect {
      const w = 1 / Math.pow(2, gz)
      return {
        x1: Math.floor(r.x1 / w) * w, x2: (Math.floor(r.x2 / w) + 1) * w,
        y1: Math.floor(r.y1 / w) * w, y2: (Math.floor(r.y2 / w) + 1) * w,
      }
    }
    // 非同期 settle の世代。古い pick_layer 応答を適用しないためのガード。
    let settleGen = 0

    // camera settle 時に層を再評価。
    //   L_zoom : zoom だけの関数（+手動オフセット）。**パンでは変わらない**。
    //   L_safe : maxRows に収まる最深層（backend の /pick_layer）。**下げる方向にしか働かない**。
    // 表示層 = min(L_zoom, L_safe)。maxRows 未設定なら従来どおり L_zoom をそのまま使う（同期・クエリ0）。
    function settleRecompute() {
      heavyProceedRef.current = false   // 新しい表示範囲 → 重さを再判定（前回の「続行」は持ち越さない）
      const viewport = getViewport()
      const L = chooseLayerByZoom(world.scale.x)
      const mr = maxRowsRef.current
      if (!mr) {
        onLodClampRef.current?.(null)
        checkAndFetch(viewport, L)   // currentLayer を L に更新しタイル取得
        maybePromote()               // タイルが揃うまで旧層維持、揃えばシームレス差し替え
        return
      }
      const gen = ++settleGen
      const rect = alignedRect(curGridZ(), expandRect(viewport, FETCH_MARGIN))
      fetchPickLayer(dbFile, L, rect, mr, hapSelRef.current).then(r => {
        if (gen !== settleGen) return          // 待っている間に次の settle が来た → 破棄
        const served = r && Number.isInteger(r.layer) ? clamp(r.layer, 0, maxLayer) : L
        onLodClampRef.current?.(served < L ? { requested: L, served, counts: r?.counts } : null)
        checkAndFetch(viewport, served)
        maybePromote()
      }).catch(e => {
        // fetchPickLayer 自体は内部で catch して null を返すのでここへは来ない。
        // then 本体（checkAndFetch/maybePromote）が投げた時の保険で、握り潰さず記録し、
        // 取りこぼしが残っていれば後で拾い直す（checkAndFetch はここでは呼び直さない＝再throw 防止）。
        console.error('settleRecompute failed:', e)
        scheduleMissingSweep()
      })
    }
    // 警告モーダルで「続行」→ 保留していた重い描画を実行（この表示範囲では以後ゲートしない）。
    proceedHeavyRef.current = () => { heavyProceedRef.current = true; maybePromote() }
    reevalRef.current = settleRecompute

    // ── 診断: タイル格納の履歴（どのバッチが何件でそのタイルを確定させたか）─────────
    // 「応答は届いていて配り方も正しいのに cache が 0」という状態が確定したので、
    // **0 件で上書きしたバッチ**を特定する。__amipaHistory(tx,ty) で引く。
    type StoreRec = { t: number; table: string; layer: number; gz: number; tx: number; ty: number
                      n: number; arrN: number; bbox: Rect; tiles: number }
    const storeLog: StoreRec[] = []
    const pushStore = (r: StoreRec) => { storeLog.push(r); if (storeLog.length > 2000) storeLog.shift() }
    ;(window as any).__amipaHistory = (tx?: number, ty?: number) => {
      const rows = storeLog
        .filter(r => tx === undefined || (r.tx === tx && (ty === undefined || r.ty === ty)))
        .map(r => ({ 時刻: new Date(r.t).toISOString().slice(11, 23), table: r.table,
                     L: r.layer, gz: r.gz, tx: r.tx, ty: r.ty,
                     このタイルに入れた件数: r.n, 応答全体: r.arrN, バッチのタイル数: r.tiles,
                     bbox: `${r.bbox.x1.toFixed(6)}..${r.bbox.x2.toFixed(6)}` }))
      console.table(rows)
      return rows
    }

    // ── 診断: 「一部領域が描画されない」の実態を掴むための dump ────────────────
    // 症状(高速パン中に一部が白いまま／パンでは直らず reload で出る)の原因を、
    // 推測でなく **その瞬間の状態** から特定するための窓口。ブラウザの console で
    //   __amipaDump()
    // を実行すると、描画に使っている層/格子と、描画矩形内タイルの取得状況を出す。
    // 「cached だが件数 0」のタイルが白い領域と一致するなら、取得はしたが中身が
    // 入っていない（= 取りこぼしを『取得済み』にしてしまう系）。
    // 「cached でない」なら取りに行っていない（= 取得契機が無い系）。
    ;(window as any).__amipaDump = () => {
      const vp = getViewport()
      const gz = curGridZ()
      const rect = expandRect(vp, RENDER_MARGIN)
      // ★描画を飛ばす唯一の経路である「重さゲート」の判定材料。
      //   RENDER_CAP_NODES は UI から変えられない **client 側の定数** で、
      //   「表示上限を無制限にした」(=maxRows) とは別物。
      const cnt = countInView(Math.max(0, displayLayer), displayGz, rect)
      const gated = !isDragging && !heavySuppressRef.current && !heavyProceedRef.current
                    && cnt > RENDER_CAP_NODES
      const out: any = {
        currentLayer, displayLayer, displayGz, curGridZ: gz,
        autoLayer, maxRows: maxRowsRef.current, isDragging,
        viewport: vp,
        描画に使う層: Math.max(0, displayLayer),
        画面内グリフ数: cnt,
        RENDER_CAP_NODES,
        重さゲートで描画中止: gated,
        heavySuppress: heavySuppressRef.current,
        heavyProceed: heavyProceedRef.current,
      }
      for (const table of ['nodes', 'edges'] as const) {
        const all = tilesForRect(displayGz, rect)
        const miss = getMissingTiles(Math.max(0, displayLayer), displayGz, rect, table)
        const missKey = new Set(miss.map(t => `${t.tx},${t.ty}`))
        const rows = all.map(({ tx, ty }: { tx: number; ty: number }) => {
          const cached = !missKey.has(`${tx},${ty}`)
          const ids = cached
            ? getVisibleIds(Math.max(0, displayLayer), displayGz, tileBbox(displayGz, tx, ty))
            : null
          return { tx, ty, cached,
                   n: ids ? (table === 'nodes' ? ids.nodeIds.size : ids.edgeIds.size) : -1 }
        })
        out[`${table}_タイル数`] = rows.length
        out[`${table}_未取得`] = rows.filter((r: { cached: boolean }) => !r.cached).length
        out[`${table}_取得済みだが0件`] =
          rows.filter((r: { cached: boolean; n: number }) => r.cached && r.n === 0).length
        out[`${table}_明細`] = rows
      }
      console.log('[amipa dump]', out)
      return out
    }
    // ゲートを迂回して強制描画する。これで領域が出るなら
    // 「データはキャッシュにあるが render() が呼ばれていない」が確定する。
    ;(window as any).__amipaRedraw = () => { render(); return '描画した' }

    // ── 決定的な照合: 「キャッシュが空のタイル」を backend に問い直す ──────────
    // 空タイル自体は疎な領域では正常なので、空が **正しいか** は backend と比べるしかない。
    //   backend が 0 件  → そのタイルは本当に空（白い原因は別）
    //   backend が >0 件 → **取得したつもりで取れていない** ＝ これが原因
    // console で `await __amipaVerify()` と実行する。
    ;(window as any).__amipaVerify = async () => {
      const L = Math.max(0, displayLayer)
      const rect = expandRect(getViewport(), RENDER_MARGIN)
      const rows: any[] = []
      for (const { tx, ty } of tilesForRect(displayGz, rect)) {
        const b = tileBbox(displayGz, tx, ty)
        // ★getVisibleIds に「タイル bbox」を渡すと境界を共有する隣接タイルまで拾って
        //   過大に出る（前版の cache 列はこれで壊れていた）。タイル単体の id 数を使う。
        const cachedN = tileItemCount(L, displayGz, tx, ty, 'nodes')
        const p = new URLSearchParams({
          db: dbFile, layer: String(L),
          x1: String(b.x1), x2: String(b.x2), y1: String(b.y1), y2: String(b.y2), nx: 'fast',
        })
        let serverN = -1
        try {
          const res = await fetch(`/api/nodes?${p}`)
          serverN = res.ok ? Number(res.headers.get('X-AMIPA-Rows') ?? -1) : -1
        } catch { /* ignore */ }
        const src = tileSrcBbox(L, displayGz, tx, ty, 'nodes')
        // ★決め手: **そのタイルを埋めた union 矩形そのもの**で取り直し、
        //   返ってきた中で「このタイルに重なる」ものを数える。
        //   >0 なのに cache が 0 なら、応答は届いていたのに **配り方(itemOverlapsTile)** で
        //   落としている＝client 側のバグと確定する。0 ならその時の応答が実際に欠けていた。
        let reInTile = -1
        if (src && cachedN === 0 && serverN > 0) {
          const q = new URLSearchParams({
            db: dbFile, layer: String(L),
            x1: String(src.x1), x2: String(src.x2), y1: String(src.y1), y2: String(src.y2), nx: 'fast',
          })
          try {
            const r2 = await fetch(`/api/nodes?${q}`)
            if (r2.ok) {
              const items = await r2.json() as NodeData[]
              reInTile = items.filter(n => itemOverlapsTile(n, b, 'nodes')).length
            }
          } catch { /* ignore */ }
        }
        rows.push({ tx, ty, cache: cachedN, server: serverN,
                    src矩形で再取得しタイル内: reInTile,
                    srcX: src ? `${src.x1.toFixed(6)}..${src.x2.toFixed(6)}` : '-',
                    tileX: `${b.x1.toFixed(6)}..${b.x2.toFixed(6)}`,
                    埋めた矩形がこのタイルを覆う: src
                      ? (src.x1 <= b.x1 && src.x2 >= b.x2 && src.y1 <= b.y1 && src.y2 >= b.y2)
                      : '未取得',
                    判定: serverN < 0 ? '取得失敗'
                        : cachedN < 0 ? '未取得'
                        : serverN === 0 ? (cachedN === 0 ? 'OK(本当に空)' : '謎(cacheにだけある)')
                        : cachedN === 0 ? '★取りこぼし' : (cachedN < serverN ? '★一部欠け' : 'OK') })
      }
      console.table(rows)
      const bad = rows.filter(r => String(r.判定).startsWith('★'))
      console.log(bad.length ? `★取りこぼし ${bad.length}/${rows.length} タイル` : '全タイル一致')
      return rows
    }

    // 全タイルを破棄して現在ビューを取り直す（大域 mapq 変更・編集のDB保存後の反映）。
    // reload 後はキャッシュ上に in-memory 限定の未保存編集は残らない（DB保存済みは再取得で反映、
    // 未保存分は破棄）ので、レイヤ移動警告のための dirty フラグは解除する。
    function reload() {
      clearCache()
      isDirty = false
      settleRecompute()
    }
    reloadRef.current = reload

    function updateUrl(viewport: Rect) {
      const cx = ((viewport.x1 + viewport.x2) / 2).toFixed(6)
      const cy = ((viewport.y1 + viewport.y2) / 2).toFixed(6)
      const vw = (viewport.x2  - viewport.x1).toFixed(6)
      const params = new URLSearchParams(window.location.search)
      params.set('cx', cx); params.set('cy', cy); params.set('vw', vw)
      window.history.replaceState(null, '', '?' + params.toString())
    }

    function onViewportChanged() {
      clampCamera()   // パン/ズーム/移動の後、画面中心がノード bbox を出ないよう補正してから反映
      const viewport = getViewport()
      // 即時: 表示中の層のグリフを camera 変換で追従（層選択は settle まで固定）。maybePromote が
      // 描画とバッジ/ミニマップ報告を行い、ズーム中に新層タイルが届いていればここで差し替える。
      maybePromote()

      if (layerDebounce) clearTimeout(layerDebounce)
      layerDebounce = setTimeout(settleRecompute, 130)

      if (urlDebounce) clearTimeout(urlDebounce)
      urlDebounce = setTimeout(() => updateUrl(viewport), 500)
    }

    // ── 編集モードユーティリティ ──────────────────────────────────────
    function findNodeAt(sx: number, sy: number): NodeData | null {
      const minW = 3 / world.scale.x
      const scale = nodeScaleRef.current
      const w = screenToWorld(sx, sy)
      for (let i = visibleNodes.length - 1; i >= 0; i--) {
        if (hitTestNode(visibleNodes[i], w.x, w.y, minW, scale)) return visibleNodes[i]
      }
      return null
    }

    function nodesInBox(sx1: number, sy1: number, sx2: number, sy2: number): NodeData[] {
      const minSx = Math.min(sx1, sx2), maxSx = Math.max(sx1, sx2)
      const minSy = Math.min(sy1, sy2), maxSy = Math.max(sy1, sy2)
      return visibleNodes.filter(n => {
        const s = worldToScreen(n.xCoord, n.yCoord)
        return s.x >= minSx && s.x <= maxSx && s.y >= minSy && s.y <= maxSy
      })
    }

    function selectedNodeNames(): Set<string> {
      return new Set(visibleNodes.filter(n => selectedIds.has(n.id)).map(n => n.node_name))
    }

    // ドラッグ開始時に接続エッジのスナップショットを取る
    function snapshotConnectedEdges(nodeNames: Set<string>): Map<number, EdgeSnapshot> {
      const bySource = new Map<string, EdgeData[]>()
      const byTarget = new Map<string, EdgeData[]>()
      for (const e of visibleEdges) {
        if (!bySource.has(e.source)) bySource.set(e.source, [])
        bySource.get(e.source)!.push(e)
        if (!byTarget.has(e.target)) byTarget.set(e.target, [])
        byTarget.get(e.target)!.push(e)
      }
      const affected = new Set<number>()
      for (const name of nodeNames) {
        for (const e of bySource.get(name) ?? []) affected.add(e.id)
        for (const e of byTarget.get(name) ?? []) affected.add(e.id)
      }
      const out = new Map<number, EdgeSnapshot>()
      for (const e of visibleEdges) {
        if (affected.has(e.id)) {
          out.set(e.id, {
            start_x: e.start_x, start_y: e.start_y,
            end_x:   e.end_x,   end_y:   e.end_y,
            startc_x: e.startc_x, startc_y: e.startc_y,
            endc_x:   e.endc_x,   endc_y:   e.endc_y,
          })
        }
      }
      return out
    }

    // 平行移動を端点ごとの重み(wOf: name→0..1)で適用。剛体移動は wOf=members?1:0、
    // ソフト(BFS弾性)移動は hop 減衰重み。重み 0 の端点は動かさない。
    function applyEdgeTranslation(
      snapshots: Map<number, EdgeSnapshot>, wOf: (name: string) => number, dx: number, dy: number
    ) {
      for (const e of visibleEdges) {
        const snap = snapshots.get(e.id)
        if (!snap) continue
        const ws = wOf(e.source)
        if (ws) {
          e.start_x  = snap.start_x  + ws * dx;  e.start_y  = snap.start_y  + ws * dy
          e.startc_x = snap.startc_x + ws * dx;  e.startc_y = snap.startc_y + ws * dy
        }
        const wt = wOf(e.target)
        if (wt) {
          e.end_x  = snap.end_x  + wt * dx;  e.end_y  = snap.end_y  + wt * dy
          e.endc_x = snap.endc_x + wt * dx;  e.endc_y = snap.endc_y + wt * dy
        }
      }
    }

    function applyEdgeRotation(
      snapshots: Map<number, EdgeSnapshot>, nodeNames: Set<string>,
      rcx: number, rcy: number, cos: number, sin: number
    ) {
      function rot(ox: number, oy: number) {
        const dx = ox - rcx, dy = oy - rcy
        return { x: rcx + cos*dx - sin*dy, y: rcy + sin*dx + cos*dy }
      }
      for (const e of visibleEdges) {
        const snap = snapshots.get(e.id)
        if (!snap) continue
        if (nodeNames.has(e.source)) {
          const p = rot(snap.start_x, snap.start_y);   e.start_x  = p.x; e.start_y  = p.y
          const pc= rot(snap.startc_x,snap.startc_y);  e.startc_x = pc.x;e.startc_y = pc.y
        }
        if (nodeNames.has(e.target)) {
          const p = rot(snap.end_x, snap.end_y);        e.end_x  = p.x; e.end_y  = p.y
          const pc= rot(snap.endc_x,snap.endc_y);       e.endc_x = pc.x;e.endc_y = pc.y
        }
      }
    }

    function snapshotPathSteps(): PathSnapshots {
      const out: PathSnapshots = new Map()
      for (const [ctgName, cached] of pathCacheRef.current) {
        out.set(ctgName, cached.steps.map(s => ({
          from_x: s.from_x, from_y: s.from_y, from_cx: s.from_cx, from_cy: s.from_cy,
          to_x: s.to_x, to_y: s.to_y, to_cx: s.to_cx, to_cy: s.to_cy,
        })))
      }
      return out
    }

    function applyPathTranslation(snapshots: PathSnapshots, wOf: (id: number) => number, dx: number, dy: number) {
      for (const [ctgName, snaps] of snapshots) {
        const cached = pathCacheRef.current.get(ctgName)
        if (!cached) continue
        for (let i = 0; i < cached.steps.length; i++) {
          const step = cached.steps[i], snap = snaps[i]
          if (!snap) continue
          const wf = wOf(step.from_id)
          if (wf) {
            step.from_x = snap.from_x + wf * dx; step.from_y = snap.from_y + wf * dy
            step.from_cx = snap.from_cx + wf * dx; step.from_cy = snap.from_cy + wf * dy
          }
          const wt = wOf(step.to_id)
          if (wt) {
            step.to_x = snap.to_x + wt * dx; step.to_y = snap.to_y + wt * dy
            step.to_cx = snap.to_cx + wt * dx; step.to_cy = snap.to_cy + wt * dy
          }
        }
      }
    }

    function applyPathRotation(
      snapshots: PathSnapshots, nodeIds: Set<number>,
      rcx: number, rcy: number, cos: number, sin: number
    ) {
      function rot(ox: number, oy: number) {
        const dx = ox - rcx, dy = oy - rcy
        return { x: rcx + cos*dx - sin*dy, y: rcy + sin*dx + cos*dy }
      }
      for (const [ctgName, snaps] of snapshots) {
        const cached = pathCacheRef.current.get(ctgName)
        if (!cached) continue
        for (let i = 0; i < cached.steps.length; i++) {
          const step = cached.steps[i], snap = snaps[i]
          if (!snap) continue
          if (nodeIds.has(step.from_id)) {
            const p = rot(snap.from_x, snap.from_y); step.from_x = p.x; step.from_y = p.y
            const pc = rot(snap.from_cx, snap.from_cy); step.from_cx = pc.x; step.from_cy = pc.y
          }
          if (nodeIds.has(step.to_id)) {
            const p = rot(snap.to_x, snap.to_y); step.to_x = p.x; step.to_y = p.y
            const pc = rot(snap.to_cx, snap.to_cy); step.to_cx = pc.x; step.to_cy = pc.y
          }
        }
      }
    }

    // リボン追従: ドラッグ開始時に現在のリボン幾何をコピー。各フレームは「snapshot+delta」で再計算。
    function snapshotRibbons(): RibbonGeomSnap {
      const ribs = ribbonsRef.current
      if (!ribs) return []
      return ribs.map(rib => ({
        nodes: rib.nodes.map(n => ({ x: n.x, y: n.y, a: n.a })),
        edges: rib.edges.map(e => ({ sx: e.sx, sy: e.sy, ex: e.ex, ey: e.ey })),
      }))
    }

    function applyRibbonTranslation(snap: RibbonGeomSnap, wOf: (id: number) => number, dx: number, dy: number) {
      const ribs = ribbonsRef.current
      if (!ribs) return
      for (let ri = 0; ri < ribs.length; ri++) {
        const s = snap[ri]; if (!s) continue
        const rib = ribs[ri]
        for (let i = 0; i < rib.nodes.length; i++) {
          const n = rib.nodes[i], sn = s.nodes[i]
          const wn = sn ? wOf(n.id) : 0
          if (wn) { n.x = sn!.x + wn * dx; n.y = sn!.y + wn * dy }
        }
        for (let i = 0; i < rib.edges.length; i++) {
          const e = rib.edges[i], se = s.edges[i]
          if (!se) continue
          const ws = wOf(e.su)
          if (ws) { e.sx = se.sx + ws * dx; e.sy = se.sy + ws * dy }
          const wt = wOf(e.tv)
          if (wt) { e.ex = se.ex + wt * dx; e.ey = se.ey + wt * dy }
        }
      }
    }

    function applyRibbonRotation(
      snap: RibbonGeomSnap, nodeIds: Set<number>,
      rcx: number, rcy: number, cos: number, sin: number, delta: number
    ) {
      function rot(ox: number, oy: number) {
        const dx = ox - rcx, dy = oy - rcy
        return { x: rcx + cos*dx - sin*dy, y: rcy + sin*dx + cos*dy }
      }
      const ribs = ribbonsRef.current
      if (!ribs) return
      for (let ri = 0; ri < ribs.length; ri++) {
        const s = snap[ri]; if (!s) continue
        const rib = ribs[ri]
        for (let i = 0; i < rib.nodes.length; i++) {
          const n = rib.nodes[i], sn = s.nodes[i]
          if (sn && nodeIds.has(n.id)) {
            const p = rot(sn.x, sn.y); n.x = p.x; n.y = p.y; n.a = sn.a + delta
          }
        }
        for (let i = 0; i < rib.edges.length; i++) {
          const e = rib.edges[i], se = s.edges[i]
          if (!se) continue
          if (nodeIds.has(e.su)) { const p = rot(se.sx, se.sy); e.sx = p.x; e.sy = p.y }
          if (nodeIds.has(e.tv)) { const p = rot(se.ex, se.ey); e.ex = p.x; e.ey = p.y }
        }
      }
    }

    // 移動/回転ジェスチャ確定時に、その剛体変換を App へ報告（DB反映用）。スナップショットから純変換を復元。
    function recordMoveGesture() {
      let dx = 0, dy = 0, found = false
      for (const n of visibleNodes) {
        const s = moveStartNodePositions.get(n.id)
        if (s) { dx = n.xCoord - s.x; dy = n.yCoord - s.y; found = true; break }
      }
      if (!found || (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12)) return
      const names = [...moveSelectedNodeNames]
      if (names.length === 0) return
      onNodesEditedRef.current?.({ names, cos: 1, sin: 0, tx: dx, ty: dy, dAngle: 0 })
    }
    function recordRotateGesture() {
      let delta = 0, found = false
      for (const n of visibleNodes) {
        const s = rotateStartNodePositions.get(n.id)
        if (s) { delta = n.angle - s.angle; found = true; break }   // angle = s.angle + delta を逆算
      }
      if (!found || Math.abs(delta) < 1e-9) return
      const names = [...rotateSelectedNodeNames]
      if (names.length === 0) return
      const cos = Math.cos(delta), sin = Math.sin(delta)
      const rcx = rotateCenter.x, rcy = rotateCenter.y
      // 中心周り回転を x' = cos*x - sin*y + tx / y' = sin*x + cos*y + ty へ落とす
      const tx = rcx - cos * rcx + sin * rcy
      const ty = rcy - sin * rcx - cos * rcy
      onNodesEditedRef.current?.({ names, cos, sin, tx, ty, dAngle: delta })
    }

    // ── イベントハンドラ ─────────────────────────────────────────────
    const canvas = app.view as HTMLCanvasElement

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const wx = (mx - world.position.x) / world.scale.x
      const wy = (my - world.position.y) / world.scale.y
      world.scale.x *= factor; world.scale.y *= factor
      world.position.x = mx - wx * world.scale.x
      world.position.y = my - wy * world.scale.y
      onViewportChanged()
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return
      // canvas 上のドラッグでブラウザ既定のテキスト選択が始まらないようにする。
      // これが無いと、上部のノードを掴んで上方向へドラッグした時にドラッグが「上部バーの文字列選択」に
      // 吸われ、ノードを掴めない。canvas のみに効くので他要素の選択・フォーカスには影響しない。
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top

      // Align pick mode: single click to pick node for alignment view (no edit mode needed)
      if (alignPickModeRef.current && !editModeRef.current) {
        const hit = findNodeAt(sx, sy)
        if (hit) { onNodeSelectRef.current?.(hit); return }
        // No hit: fall through to normal pan
      }

      highlightIdRef.current = null

      if (editModeRef.current) {
        if (spaceKeyDown) {
          isSpacePanning = true; isDragging = true
          lastMouse = { x: e.clientX, y: e.clientY }
          canvas.style.cursor = 'grabbing'
          return
        }
        const handleInfo = getRotationHandleInfo()
        if (handleInfo && Math.hypot(sx - handleInfo.sx, sy - handleInfo.sy) <= 12) {
          isRotating = true
          rotateCenter = { x: handleInfo.cx, y: handleInfo.cy }
          const wp = screenToWorld(sx, sy)
          rotateStartAngle = Math.atan2(wp.y - rotateCenter.y, wp.x - rotateCenter.x)
          rotateSelectedNodeNames = selectedNodeNames()
          rotateStartNodePositions = new Map(
            visibleNodes.filter(n => selectedIds.has(n.id))
              .map(n => [n.id, { x: n.xCoord, y: n.yCoord, angle: n.angle }])
          )
          rotateStartEdgeSnapshots = snapshotConnectedEdges(rotateSelectedNodeNames)
          rotateStartPathSnapshots = snapshotPathSteps()
          rotateStartRibbonSnap = snapshotRibbons()
          canvas.style.cursor = 'crosshair'
          renderUi()
          return
        }
        // 移動ハンドルを掴んだ: 選択はそのままで全体移動を開始（ノードを直接掴まなくてよい）
        const moveInfo = getMoveHandleInfo()
        if (moveInfo && Math.hypot(sx - moveInfo.sx, sy - moveInfo.sy) <= 14) {
          isMovingNodes = true
          moveStartMouse = { x: sx, y: sy }
          moveSelectedNodeNames = selectedNodeNames()
          moveStartNodePositions = new Map(
            visibleNodes.filter(n => selectedIds.has(n.id))
              .map(n => [n.id, { x: n.xCoord, y: n.yCoord }])
          )
          moveStartEdgeSnapshots = snapshotConnectedEdges(moveSelectedNodeNames)
          moveStartPathSnapshots = snapshotPathSteps()
          moveStartRibbonSnap = snapshotRibbons()
          computeMoveBounds()
          canvas.style.cursor = 'move'
          render()
          return
        }
        const hit = findNodeAt(sx, sy)
        // ソフト(BFS弾性)移動モード: 掴んだノードを核に近傍を巻き込んで動かす（Shift は従来の剛体選択に譲る）。
        if (hit && softDragModeRef.current && !e.shiftKey) {
          onNodeSelectRef.current?.(hit)
          selectedIds = new Set([hit.id])
          startSoftDrag(hit, sx, sy)
          canvas.style.cursor = 'move'
          render()
          return
        }
        if (hit) {
          onNodeSelectRef.current?.(hit)
          if (e.shiftKey) {
            if (selectedIds.has(hit.id)) selectedIds.delete(hit.id)
            else selectedIds.add(hit.id)
          } else {
            if (!selectedIds.has(hit.id)) selectedIds = new Set([hit.id])
          }
          isMovingNodes = true
          moveStartMouse = { x: sx, y: sy }
          moveSelectedNodeNames = selectedNodeNames()
          moveStartNodePositions = new Map(
            visibleNodes.filter(n => selectedIds.has(n.id))
              .map(n => [n.id, { x: n.xCoord, y: n.yCoord }])
          )
          moveStartEdgeSnapshots = snapshotConnectedEdges(moveSelectedNodeNames)
          moveStartPathSnapshots = snapshotPathSteps()
          moveStartRibbonSnap = snapshotRibbons()
          computeMoveBounds()
          canvas.style.cursor = 'move'
          render()
          return
        }
        isBoxSelecting = true
        boxAdditive = e.shiftKey
        boxStart = { x: sx, y: sy }; boxEnd = { x: sx, y: sy }
        if (!e.shiftKey) selectedIds = new Set()
        render()
        return
      }

      isDragging = true
      mouseDownPos = { x: e.clientX, y: e.clientY }
      lastMouse = { x: e.clientX, y: e.clientY }
      canvas.style.cursor = 'grabbing'
    }

    function onMouseMove(e: MouseEvent) {
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top

      if (editModeRef.current) {
        if (isSpacePanning) {
          world.position.x += e.clientX - lastMouse.x
          world.position.y += e.clientY - lastMouse.y
          lastMouse = { x: e.clientX, y: e.clientY }
          onViewportChanged(); return
        }
        if (isRotating) {
          const wp = screenToWorld(sx, sy)
          const delta = Math.atan2(wp.y - rotateCenter.y, wp.x - rotateCenter.x) - rotateStartAngle
          const cos = Math.cos(delta), sin = Math.sin(delta)
          // 回転後に [0,1] を外れるノードがあればこのフレームは適用しない（境界で回転が止まる）。
          for (const n of visibleNodes) {
            if (!selectedIds.has(n.id)) continue
            const s = rotateStartNodePositions.get(n.id)
            if (!s) continue
            const dx = s.x - rotateCenter.x, dy = s.y - rotateCenter.y
            const nx = rotateCenter.x + cos*dx - sin*dy
            const ny = rotateCenter.y + sin*dx + cos*dy
            if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
          }
          for (const n of visibleNodes) {
            if (!selectedIds.has(n.id)) continue
            const s = rotateStartNodePositions.get(n.id)
            if (!s) continue
            const dx = s.x - rotateCenter.x, dy = s.y - rotateCenter.y
            n.xCoord = rotateCenter.x + cos*dx - sin*dy
            n.yCoord = rotateCenter.y + sin*dx + cos*dy
            n.angle  = s.angle + delta
          }
          applyEdgeRotation(rotateStartEdgeSnapshots, rotateSelectedNodeNames,
            rotateCenter.x, rotateCenter.y, cos, sin)
          applyPathRotation(rotateStartPathSnapshots, selectedIds,
            rotateCenter.x, rotateCenter.y, cos, sin)
          applyRibbonRotation(rotateStartRibbonSnap, selectedIds,
            rotateCenter.x, rotateCenter.y, cos, sin, delta)
          onRibbonEditedRef.current?.()   // リボンを追従変異させた→パン再取得で上書きさせない
          render(); return
        }
        if (isMovingNodes) {
          let dx = (sx - moveStartMouse.x) / world.scale.x
          let dy = (sy - moveStartMouse.y) / world.scale.y
          // 全選択ノードが [0,1] に収まるよう平行移動量をクランプ（剛体のまま境界で止まる）。
          dx = Math.max(-moveBounds.minX, Math.min(1 - moveBounds.maxX, dx))
          dy = Math.max(-moveBounds.minY, Math.min(1 - moveBounds.maxY, dy))
          for (const n of visibleNodes) {
            if (!selectedIds.has(n.id)) continue
            const s = moveStartNodePositions.get(n.id)
            if (!s) continue
            n.xCoord = s.x + dx; n.yCoord = s.y + dy
          }
          applyEdgeTranslation(moveStartEdgeSnapshots, nm => moveSelectedNodeNames.has(nm) ? 1 : 0, dx, dy)
          applyPathTranslation(moveStartPathSnapshots, id => selectedIds.has(id) ? 1 : 0, dx, dy)
          applyRibbonTranslation(moveStartRibbonSnap, id => selectedIds.has(id) ? 1 : 0, dx, dy)
          onRibbonEditedRef.current?.()   // リボンを追従変異させた→パン再取得で上書きさせない
          render(); return
        }
        if (isSoftDragging) {
          let dx = (sx - softStartMouse.x) / world.scale.x
          let dy = (sy - softStartMouse.y) / world.scale.y
          // 影響ノードが全て [0,1] に収まるよう、重み付きの許容量でクランプ（各ノードは w·delta 動く）。
          dx = Math.max(softBounds.dxMin, Math.min(softBounds.dxMax, dx))
          dy = Math.max(softBounds.dyMin, Math.min(softBounds.dyMax, dy))
          for (const n of visibleNodes) {
            const w = softWById.get(n.id); if (!w) continue
            const s = softStartNodePositions.get(n.id); if (!s) continue
            n.xCoord = s.x + w * dx; n.yCoord = s.y + w * dy
          }
          applyEdgeTranslation(softStartEdgeSnapshots, nm => softWByName.get(nm) ?? 0, dx, dy)
          applyPathTranslation(softStartPathSnapshots, id => softWById.get(id) ?? 0, dx, dy)
          applyRibbonTranslation(softStartRibbonSnap, id => softWById.get(id) ?? 0, dx, dy)
          onRibbonEditedRef.current?.()
          render(); return
        }
        if (isBoxSelecting) {
          boxEnd = { x: sx, y: sy }
          renderUi(); return
        }
        // ホバー: ハンドル上ならカーソルで掴めることを示す（ドラッグ中でない時）
        if (!spaceKeyDown && selectedIds.size > 0) {
          const mv = getMoveHandleInfo()
          const rot = getRotationHandleInfo()
          if (mv && Math.hypot(sx - mv.sx, sy - mv.sy) <= 14) canvas.style.cursor = 'move'
          else if (rot && Math.hypot(sx - rot.sx, sy - rot.sy) <= 12) canvas.style.cursor = 'grab'
          else canvas.style.cursor = 'default'
        }
        return
      }

      if (!isDragging) return
      world.position.x += e.clientX - lastMouse.x
      world.position.y += e.clientY - lastMouse.y
      lastMouse = { x: e.clientX, y: e.clientY }
      onViewportChanged()
    }

    function onMouseUp(e: MouseEvent) {
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top

      if (editModeRef.current) {
        if (isSpacePanning) {
          isSpacePanning = false; isDragging = false
          canvas.style.cursor = spaceKeyDown ? 'grab' : 'default'; return
        }
        if (isRotating) {
          isRotating = false; isDirty = true
          recordRotateGesture()
          canvas.style.cursor = 'default'; render(); return
        }
        if (isMovingNodes) {
          isMovingNodes = false; isDirty = true
          recordMoveGesture()
          canvas.style.cursor = 'default'; return
        }
        if (isSoftDragging) {
          isSoftDragging = false; isDirty = true
          recordSoftGesture()
          canvas.style.cursor = 'default'; return
        }
        if (isBoxSelecting) {
          isBoxSelecting = false
          const found = nodesInBox(boxStart.x, boxStart.y, sx, sy)
          if (boxAdditive) for (const n of found) selectedIds.add(n.id)
          else selectedIds = new Set(found.map(n => n.id))
          render(); return
        }
        return
      }

      isDragging = false
      canvas.style.cursor = 'grab'
      if (Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y) < 5) {
        const rect = el.getBoundingClientRect()
        const hit = findNodeAt(e.clientX - rect.left, e.clientY - rect.top)
        onNodeSelectRef.current?.(hit)
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space' && editModeRef.current) {
        e.preventDefault(); spaceKeyDown = true; canvas.style.cursor = 'grab'
      }
      if (e.code === 'Escape' && editModeRef.current) {
        selectedIds = new Set(); render()
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') {
        spaceKeyDown = false
        if (!isSpacePanning) canvas.style.cursor = editModeRef.current ? 'default' : 'grab'
      }
    }

    function onDblClick(e: MouseEvent) {
      if (editModeRef.current) return
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const wx = (mx - world.position.x) / world.scale.x
      const wy = (my - world.position.y) / world.scale.y
      world.scale.x *= 2; world.scale.y *= 2
      world.position.x = mx - wx * world.scale.x
      world.position.y = my - wy * world.scale.y
      onViewportChanged()
    }

    function onResize() {
      app.renderer.resize(el.clientWidth, el.clientHeight)
      onViewportChanged()
    }

    onModeChangeRef.current = (m: boolean) => {
      if (!m) {
        selectedIds = new Set()
        isBoxSelecting = false; isMovingNodes = false; isRotating = false; isSoftDragging = false
        isSpacePanning = false; spaceKeyDown = false
        canvas.style.cursor = 'grab'; render()
      } else {
        canvas.style.cursor = 'default'; render()
      }
    }

    getSelectedNodesRef.current = () => visibleNodes.filter(n => selectedIds.has(n.id))
    graphCountsRef.current = () => ({ nodes: visibleNodes.length, edges: visibleEdges.length })
    // 可視サブグラフ上で A,B 間のノードを返す(DB 非依存・可視エッジに有界)。
    //
    // ★ 有向到達では駄目。pangenome グラフは **bidirected** で、edges 表の source/target は
    //   正準化された向きであって walk の向きとは一致しない(実例: 参照は …→n81087899→n81087898→…
    //   と進むのに、行は n81087898→n81087899 で入っている)。有向で解くと「A から B に到達しない」
    //   となって無言で失敗する(n81087903 と n81087898 で発生)。
    // そこで **無向グラフの「A と B の間にある頂点」= 二重連結成分(block)の block-cut 木上で
    //   A→B の経路に載る block の合併** を返す。これは「A と B を結ぶ単純道のどれかに載る頂点」
    //   全体そのもので、バブル内部(欠失アレルの直行エッジを含む)は入り、脇に生えた枝は入らない。
    nodesBetweenRef.current = (a, b) => {
      const adj = new Map<string, string[]>()
      const add = (x: string, y: string) => { const l = adj.get(x); if (l) l.push(y); else adj.set(x, [y]) }
      for (const e of visibleEdges) {
        if (e.source === e.target) continue
        add(e.source, e.target); add(e.target, e.source)
      }
      if (!adj.has(a) || !adj.has(b)) return [a, b]

      // Tarjan(反復版)で辺→block 番号を割り当てる。再帰だと数万ノードでスタックが溢れる。
      const disc = new Map<string, number>(), low = new Map<string, number>()
      const blockOf = new Map<string, Set<string>>()      // block id -> 頂点集合
      const blocksAt = new Map<string, Set<number>>()     // 頂点 -> 属する block 群
      let timer = 0, nblock = 0
      const estack: [string, string][] = []
      const popBlock = (u: string, v: string) => {
        const vs = new Set<string>(); const id = nblock++
        for (;;) {
          const t = estack.pop(); if (!t) break
          vs.add(t[0]); vs.add(t[1])
          if (t[0] === u && t[1] === v) break
        }
        blockOf.set(String(id), vs)
        for (const x of vs) { const s = blocksAt.get(x); if (s) s.add(id); else blocksAt.set(x, new Set([id])) }
      }
      for (const root of adj.keys()) {
        if (disc.has(root)) continue
        const st: { u: string; p: string | null; i: number }[] = [{ u: root, p: null, i: 0 }]
        disc.set(root, timer); low.set(root, timer); timer++
        while (st.length) {
          const fr = st[st.length - 1]
          const nb = adj.get(fr.u) ?? []
          if (fr.i < nb.length) {
            const v = nb[fr.i++]
            if (v === fr.p) continue
            if (!disc.has(v)) {
              estack.push([fr.u, v])
              disc.set(v, timer); low.set(v, timer); timer++
              st.push({ u: v, p: fr.u, i: 0 })
            } else if (disc.get(v)! < disc.get(fr.u)!) {
              estack.push([fr.u, v])
              low.set(fr.u, Math.min(low.get(fr.u)!, disc.get(v)!))
            }
          } else {
            st.pop()
            const p = fr.p
            if (p != null) {
              low.set(p, Math.min(low.get(p)!, low.get(fr.u)!))
              if (low.get(fr.u)! >= disc.get(p)!) popBlock(p, fr.u)
            }
          }
        }
      }
      // block-cut 木: block ノード `b<id>` と、2 つ以上の block に属する頂点(切断点)を繋ぐ。
      const tadj = new Map<string, string[]>()
      const tadd = (x: string, y: string) => {
        const l = tadj.get(x); if (l) l.push(y); else tadj.set(x, [y])
        const m = tadj.get(y); if (m) m.push(x); else tadj.set(y, [x])
      }
      for (const [id, vs] of blockOf) for (const x of vs) if ((blocksAt.get(x)?.size ?? 0) > 1) tadd('b' + id, 'v' + x)
      // 端点の木ノード: 切断点ならその頂点、そうでなければ属する block(1 つ)
      const anchor = (x: string): string | null => {
        const bs = blocksAt.get(x); if (!bs || bs.size === 0) return null
        return bs.size > 1 ? 'v' + x : 'b' + [...bs][0]
      }
      const sa = anchor(a), sb = anchor(b)
      if (!sa || !sb) return [a, b]
      // 木上の A→B 経路(BFS で親を辿る)
      const par = new Map<string, string | null>([[sa, null]]); const q = [sa]
      while (q.length) {
        const x = q.shift()!
        if (x === sb) break
        for (const y of tadj.get(x) ?? []) if (!par.has(y)) { par.set(y, x); q.push(y) }
      }
      if (!par.has(sb)) return [a, b]                    // 非連結(可視範囲で繋がっていない)
      const out = new Set<string>([a, b])
      for (let x: string | null | undefined = sb; x != null; x = par.get(x)) {
        if (x.startsWith('b')) for (const v of blockOf.get(x.slice(1)) ?? []) out.add(v)
        else out.add(x.slice(1))
      }
      return [...out]
    }

    navigateRef.current = (cx: number, cy: number, highlightId?: number | null, targetLayer?: number) => {
      highlightIdRef.current = highlightId ?? null
      if (targetLayer !== undefined) {
        // LOD-A: 目的層 L のズーム帯 [f(L), f(L+1)) の中央（幾何平均）に zoom を合わせる。
        const L = clamp(targetLayer, 0, maxLayer)
        const fL = thresholdFor(L)
        const fU = L < maxLayer ? thresholdFor(L + 1) : fL * 1.6
        // 既に目的層以上にズームインしているならズーム率を維持(パンのみ)。目的層より引いている
        // (cur < fL)ときだけ層中央へズームイン。ズームアウトはしない(手動で拡大した率を潰さない)。
        if (world.scale.x < fL) world.scale.set(Math.sqrt(fL * fU))
      }
      const zoom = world.scale.x
      world.position.x = app.screen.width  / 2 - cx * zoom
      world.position.y = app.screen.height / 2 - cy * zoom
      onViewportChanged()
      settleRecompute()   // 目的層への切替を待たせない（ハイライト対象を即可視化）
    }

    // オンデマンド描画では idle 中に paint しないため、バックグラウンドから復帰した際に
    // WebGL キャンバスが空表示になり得る。可視化されたら 1 フレームだけ強制再描画して保険をかける。
    const onVisibility = () => { if (document.visibilityState === 'visible') markDirty() }
    document.addEventListener('visibilitychange', onVisibility)

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('dblclick', onDblClick)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(el)

    // 初回ロード: zoom 閾値で初期層を選ぶ（fit なら layer 0=overview）。
    const initViewport = getViewport()
    currentLayer = chooseLayerByZoom(world.scale.x)
    displayLayer = currentLayer   // 初回は旧層が無いのでその層をそのまま（進行描画）
    displayGz = curGridZ()        // 初期表示 gz（autoLayer は chooseLayerByZoom で確定済み）
    checkAndFetch(initViewport, currentLayer)
    maybePromote()                // 描画 + バッジ/ミニマップ報告（タイル到着で glyphs も更新）

    return () => {
      renderRef.current          = null
      renderPathsRef.current     = null
      renderRibbonsRef.current   = null
      ribbonLayerRef.current     = null
      reloadRef.current          = null
      reevalRef.current          = null
      navigateRef.current        = null
      getSelectedNodesRef.current = null
      onModeChangeRef.current    = null
      textLayerRef.current    = null
      if (layerDebounce) clearTimeout(layerDebounce)
      if (urlDebounce)   clearTimeout(urlDebounce)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('dblclick', onDblClick)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      resizeObserver.disconnect()
      // ★破棄した app を掴んだクロージャを ref に残さない。React は DB 切替時に
      //   「全 cleanup → 全 mount(宣言順)」の順で走らせるので、ここを消さないと
      //   先に宣言された effect が destroy 済みの app を触ってクラッシュする。
      fitToWorldRef.current = null
      reevalRef.current = null
      app.destroy(true)
      // DB 切替/アンマウント: 実行中の取得を全部 abort してから clearCache。
      // abort しても **backend で既に走り出したクエリは止まらない**（同期 API）が、
      // キュー待ちの分は backend の入口ガードで捨てられる。clearCache は世代を進めるので、
      // それでも届いてしまった旧 DB の応答は isCurrentGeneration で弾かれる。
      abortAllFetches()
      clearCache()
    }
  }, [maxLayer, dbFile])

  return (
    <div
      ref={containerRef}
      // position+zIndex:0 で独自スタッキングコンテキストを作り、PixiJS canvas を必ずオーバーレイ（z10+）の
      // 下に閉じ込める。これが無いと canvas が付属UI（ミニマップ/パスリボン等）の上に乗ってクリックを奪う。
      style={{ position: 'relative', zIndex: 0,
        width: '100%', height: '100%', cursor: alignPickMode && !editMode ? 'crosshair' : 'grab' }}
    />
  )
})

export default GraphCanvas
