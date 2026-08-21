import { useRef, useLayoutEffect, useState, useEffect, useMemo, useContext, createContext, Fragment } from 'react'
import { NodeData, ReadAlignEntry, fetchNodeSequence, fetchReadAlignments, fetchVariantTrack, VariantTrack } from '../api/client'

// リード塗りモード（タグ/株選択と独立に塗りを切替）。
//  auto   = 既定（タグ選択時はメンバーシップ色／株フォーカス時はサンプル色／それ以外はストランド色）
//  strand = 常にストランド色（タグ選択を無視）
//  sample = 常にサンプル別色
//  muted  = 灰（ミスマッチ・挿入欠失マークを見やすく）
export type ReadFill = 'auto' | 'strand' | 'sample' | 'muted'

export interface AlignUi {
  boardZoom: ZoomMode
  nodeZoom: Record<number, ZoomMode>
  tags: (string | null)[]          // 選択タグ(node_name)。index=色スロット（解除でnull化し再利用）
  samples: string[] | null         // 株フォーカス（null=全て）
  colorMode?: 'strand' | 'sample'  // 旧フィールド（readFill への移行用に残す）
  readFill?: ReadFill              // リード塗りモード
  sampleHighlight?: boolean        // 株フォーカス: true=強調(非選択を灰), false/未=絞り込み(非選択を非表示)
  showConnectors: boolean
  // リードの縦位置の決め方。'packed'=上に詰める（既定・縦が短い）／
  // 'unique'=1 リード 1 段（全ノードで同じ段。列をまたいで目で追える）
  readRows?: 'packed' | 'unique'
  laneHeights: number[]
  minMapq?: number                 // ボードの mapq 上書き（未設定/0=大域 mapq に追従、正値=上書き）
  cbSafe?: boolean                 // 色覚対応パレット（塩基/鎖/変異色を CB-safe に）
}

export interface AlignRow {
  id: number
  columns: (NodeData | null)[][]   // 列ごとの段。columns[c][l] = 列c・段l のノード（null=空セル）
  flipped?: number[]               // 反転表示するノードid
  ui?: AlignUi                     // ボードのUI状態（保存・復元用）
}

// ノード移動先:
//  column: 新しい列として index に挿入
//  lane:   既存列 col の段 lane に挿入（以降をシフト）
//  cell:   既存列 col の段 lane に「そのまま配置」（手前を null で埋めて隙間可）
//  swap:   対象ノードと位置を入れ替え
export type MoveDest =
  | { kind: 'column'; index: number }
  | { kind: 'lane'; col: number; lane: number }
  | { kind: 'cell'; col: number; lane: number }
  | { kind: 'swap'; withNodeId: number }

interface Props {
  rows: AlignRow[]
  activeRowId: number | null
  globalMapq: number               // 大域 mapq プリセット。ボードが未指定なら既定値として使う
  pendingNode: NodeData | null
  onClearPending: () => void
  onSetActiveRow: (id: number | null) => void
  onAddRow: () => void
  onRemoveRow: (id: number) => void
  onRemoveNode: (rowId: number, nodeId: number) => void
  onInsertColumn: (rowId: number, colIndex: number, node: NodeData) => void
  onAddLane: (rowId: number, colIndex: number, node: NodeData) => void
  onMoveNode: (rowId: number, nodeId: number, dest: MoveDest) => void
  onExpandNode: (rowId: number, seedName: string) => void
  onToggleFlip: (rowId: number, nodeId: number) => void
  onUpdateUi: (rowId: number, ui: AlignUi) => void
  nodeColors: Map<string, number>   // node_name → 対応色（hex）。マップと共有。空=無効
  height: number
  dbFile: string
  selectedAln?: number | null               // 選択/検索中のアライメント(aln_id)。全ボードで該当リードを強調
  onSelectAln?: (alnId: number | null) => void   // リードクリックで選択を通知（null=解除）
}

const MIN_COL_PX = 60    // minimum column display width

// 列幅ドラッグ: 列 idx と idx+1 の境界を dx px 動かす。総幅は保存。
// 広げる側の隣がすでに最小なら、さらにその先の列を縮める（カスケード）。
function applyColResize(base: number[], idx: number, dx: number): number[] {
  const next = [...base]
  if (dx > 0) {            // idx を広げ、右側(idx+1, idx+2, …)を順に最小まで縮める
    let need = dx
    for (let j = idx + 1; j < next.length && need > 0; j++) {
      const give = Math.min(need, next[j] - MIN_COL_PX)
      if (give > 0) { next[j] -= give; need -= give }
    }
    next[idx] += dx - need
  } else if (dx < 0) {     // idx+1 を広げ、左側(idx, idx-1, …)を順に最小まで縮める
    let need = -dx
    for (let j = idx; j >= 0 && need > 0; j--) {
      const give = Math.min(need, next[j] - MIN_COL_PX)
      if (give > 0) { next[j] -= give; need -= give }
    }
    next[idx + 1] += -dx - need
  }
  return next
}

// 縮尺: 'fit'=全体, それ以外は絶対 px/bp の10のべき（1k=0.001px/bp=1000bp/px … base=10px/bp=塩基）。
type ZoomMode = 'fit' | '1kbp' | '100bp' | '10bp' | '1bp' | 'base'
const ZOOM_ORDER: ZoomMode[] = ['fit', '1kbp', '100bp', '10bp', '1bp', 'base']
// 旧3段（2x/10x）からの移行
const migrateZoom = (v: unknown): ZoomMode =>
  v === '2x' ? '1bp' : v === '10x' ? 'base'
  : (typeof v === 'string' && (ZOOM_ORDER as string[]).includes(v)) ? v as ZoomMode : 'fit'

interface LayoutEntry extends ReadAlignEntry { y_row: number; sig: number[]; _shared?: boolean; _grp?: string; _gs?: number }
interface RowReadLayout {
  byNode: Map<string, LayoutEntry[]>
  maxYRow: number
  rowsByNode: Map<string, number>   // ノードごとの使用行数（タイル高さ用）
  samples: string[]                 // 含まれる sample_id 一覧（ソート済み）
}

// 位置決め方針: リードを「上に集める」のではなく、各ノード内でコンパクトに詰める。
// - 複数ノードに跨る aln_id（shared）だけにグローバル順位を付け、全ノードで同じ順序に並べる
//   → 隣接列のコネクタ交差を抑える。1ノードのみの aln_id は順位計算に含めず空き行に詰めるだけ
//   → 巨大ノードでも軽い。
// selectedTags は色分け(sig)用のみ。位置決めには影響しない。
//   index=色スロットなので null（解除済みスロット）はスキップし、生きているタグの index を sig に積む。
// 共有リードは「接続相手のノード集合(_grp)」でクラスタ化し、各クラスタ内はグローバル開始位置(_gs)
//   順に段を割り当てる（相手ノードと順序一致＝コネクタ非交差）。クラスタ同士は横が空けば同段に同居。
function computeReadLayout(
  nodes: NodeData[],
  byNode: Record<string, ReadAlignEntry[]>,
  selectedTags: (string | null)[] = [],
  mode: 'packed' | 'unique' = 'packed',
): RowReadLayout {
  // Node global offsets
  const offsets = new Map<string, number>()
  let off = 0
  for (const nd of nodes) { offsets.set(nd.node_name, off); off += nd.size }

  // Merge spans across nodes.
  // aln_id がある場合: 同一 aln_id（同一 GAF 行）を同一行に配置（正確なクロスノード連続表示）
  // aln_id がない場合（旧スキーマ）: read_name ベースのフォールバック。同一ノードで同名リードが
  //   複数ある場合は 2 回目以降を別スパンとして扱う。
  type Raw = { gs: number; ge: number; entries: ReadAlignEntry[]; nodeNames: Set<string> }
  const spans = new Map<string, Raw>()
  for (const nd of nodes) {
    const nodeOff = offsets.get(nd.node_name) ?? 0
    const localCount = new Map<string, number>()
    for (const e of (byNode[nd.node_name] ?? [])) {
      const gs = nodeOff + e.node_start
      const ge = nodeOff + e.node_end
      let key: string
      if (e.aln_id != null) {
        key = `aln:${e.aln_id}`
      } else {
        const n = localCount.get(e.read_name) ?? 0
        localCount.set(e.read_name, n + 1)
        key = n === 0 ? e.read_name : `${e.read_name}\x00${n}`
      }
      const existing = spans.get(key)
      if (!existing) {
        spans.set(key, { gs, ge, entries: [e], nodeNames: new Set([e.node_name]) })
      } else {
        existing.gs = Math.min(existing.gs, gs)
        existing.ge = Math.max(existing.ge, ge)
        existing.entries.push(e)
        existing.nodeNames.add(e.node_name)
      }
    }
  }

  // 署名(色分け) + shared判定 + grp（このスパンが触れるノード集合キー＝「接続相手」の識別子）。
  // 単一レーン列だとレーン重心では相手を区別できないので、ノード集合そのものをクラスタキーにする。
  type Span = { gs: number; entries: ReadAlignEntry[]; sig: number[]; shared: boolean; grp: string }
  const spanArr: Span[] = [...spans.values()].map(sp => {
    const sig: number[] = []
    selectedTags.forEach((t, i) => { if (t != null && sp.nodeNames.has(t)) sig.push(i) })
    return {
      gs: sp.gs, entries: sp.entries, sig,
      shared: sp.nodeNames.size >= 2,
      grp: [...sp.nodeNames].sort().join('\x00'),
    }
  })

  // Build byNode entries（_gs=グローバル開始位置: 全ノード共通の順序キー、コネクタ整合に使う。
  // _grp=このリードが触れるノード集合＝接続相手の識別子、クラスタキーに使う）
  const result = new Map<string, LayoutEntry[]>()
  for (const nd of nodes) result.set(nd.node_name, [])

  // ★'unique': 1 リード（＝1 スパン）に**全ノード共通の一意な段**を与える。
  //   上に詰める方式は列ごとに独立して詰めるので、同じリードが列をまたぐたびに段が変わり、
  //   n45173086→n45173091 のように何列も跨ぐリードを目で追えない。こちらは段が動かない。
  //   縦は伸びる（リード数ぶんの段になる）ので、少数のリードを追跡したいときに使う。
  const spanRow = new Map<Span, number>()
  if (mode === 'unique') {
    // ★packed の「_grp クラスタ化」はここでは**流用しない**。1 リード = 全列共通の 1 段なので
    //   同一 aln_id の段は列を跨いでも動かず、コネクタは定義上つねに水平＝交差しえない。
    //   つまり交差回避は自明に達成済みで、並べ替えで最適化すべきなのは別のこと＝
    //   「どの経路を通ったリードか」が縦の塊として読めるかどうか。
    //   キー: ①触れている列番号の列（辞書順）＝経路 → ②サンプル → ③開始座標 → ④aln_id
    //   ①で分岐ごと、②で親子ごとにブロックになる（HG003 だけ空、が一目で分かる）。
    //   サンプルより座標を先にしたければ ② と ③ を入れ替えるだけ。
    const colOf = new Map<string, number>()
    nodes.forEach((nd, i) => colOf.set(nd.node_name, i))
    const pk = new Map<Span, number[]>()
    for (const sp of spanArr) {
      const s = new Set<number>()
      for (const e of sp.entries) { const c = colOf.get(e.node_name); if (c != null) s.add(c) }
      pk.set(sp, [...s].sort((a, b) => a - b))
    }
    // 列番号列の辞書順。前方一致なら短い方（＝先で止まるリード）が先。
    const cmpPath = (a: number[], b: number[]) => {
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
      return a.length - b.length
    }
    const ordered = [...spanArr].sort((a, b) =>
      cmpPath(pk.get(a)!, pk.get(b)!) ||
      (a.entries[0].sample_id ?? '').localeCompare(b.entries[0].sample_id ?? '') ||
      a.gs - b.gs ||
      ((a.entries[0].aln_id ?? 0) - (b.entries[0].aln_id ?? 0)) ||
      a.entries[0].read_name.localeCompare(b.entries[0].read_name))
    ordered.forEach((sp, i) => spanRow.set(sp, i))
  }

  for (const sp of spanArr) {
    for (const e of sp.entries) {
      result.get(e.node_name)?.push({ ...e, y_row: spanRow.get(sp) ?? 0,
        sig: sp.sig, _shared: sp.shared, _grp: sp.grp, _gs: sp.gs })
    }
  }

  if (mode === 'unique') {
    const total = spanArr.length
    const rbn = new Map<string, number>()
    for (const nd of nodes) rbn.set(nd.node_name, total)   // 列の高さを揃える＝段が水平に並ぶ
    const ss = new Set<string>()
    for (const entries of Object.values(byNode)) for (const e of entries) if (e.sample_id) ss.add(e.sample_id)
    return { byNode: result, maxYRow: total, rowsByNode: rbn, samples: [...ss].sort() }
  }

  // 段割り当て。狙い: ①横に離れたリードは別の隣接ノードと共有していても同段に同居させ縦を節約、
  // ②同じ相手へ繋がるリード群の中では順序を相手ノードと一致させてコネクタを交差させない。
  //   - 共有リードを _grp（接続相手のノード集合）ごとにクラスタ化。クラスタは min _gs 順に処理。
  //   - 各クラスタ内は _gs(グローバル開始)昇順で段番号を非減少に保つ（クラスタ内の順序保存＝
  //     相手ノードでの順序と一致 → コネクタ非交差）。クラスタごとに row0 から探すので、横が
  //     (GAP以上)空いていれば先のクラスタの段に同居できる（＝x方向に離れた塊どうしを統合）。
  //   - 単独リードは最後に node_start 順で右詰め（コネクタ無し＝順序制約なし）。
  // GAP: 近すぎて視覚的にほぼ重なるリードは同居させないための最小間隔（ノード幅比）。
  const GAP_FRAC = 0.01
  const rowsByNode = new Map<string, number>()
  let maxRow = 0
  for (const nd of nodes) {
    const entries = result.get(nd.node_name)!
    const gap = nd.size * GAP_FRAC
    const rows: { s: number; e: number }[][] = []   // 各段の占有区間
    const fits = (y: number, s: number, en: number) => {
      for (const iv of rows[y]) if (!(en + gap <= iv.s || iv.e + gap <= s)) return false
      return true
    }
    const put = (e: LayoutEntry, y: number) => {
      if (y === rows.length) rows.push([])
      rows[y].push({ s: e.node_start, e: e.node_end })
      e.y_row = y
    }
    // 共有: 接続相手(_grp)ごとにクラスタ化 → 各クラスタ内 _gs 昇順・段非減少。クラスタは min _gs 順。
    const byGrp = new Map<string, LayoutEntry[]>()
    for (const e of entries) if (e._shared) {
      const a = byGrp.get(e._grp ?? ''); if (a) a.push(e); else byGrp.set(e._grp ?? '', [e])
    }
    // 接合部で繋がるリードは _gs が同値になりやすい（左/右端で全て同じグローバル開始）。タイは
    // 必ずグローバルキー(aln_id→read_name)で割る。ローカル node_start でのタイ割りは相手ノードと
    // 食い違ってコネクタが乱れるので使わない。
    const ord = (a: LayoutEntry, b: LayoutEntry) =>
      (a._gs ?? 0) - (b._gs ?? 0) ||
      (a.aln_id ?? 0) - (b.aln_id ?? 0) ||
      a.read_name.localeCompare(b.read_name)
    const clusters = [...byGrp.values()]
      .map(c => { c.sort(ord); return c })
      .sort((a, b) => ord(a[0], b[0]) || (a[0]._grp ?? '').localeCompare(b[0]._grp ?? ''))
    for (const cluster of clusters) {
      let prevRow = 0
      for (const e of cluster) {
        let y = prevRow
        while (y < rows.length && !fits(y, e.node_start, e.node_end)) y++
        put(e, y); prevRow = y
      }
    }
    // 単独: node_start 順で、横が(GAP以上)空いている最初の段へ。区間ベース判定なので、左右端リードが
    // 統合された段の「中央の大きな空き」にも入る（中央リードを上段に詰められる）。
    for (const e of entries.filter(e => !e._shared).sort((a, b) => a.node_start - b.node_start)) {
      let y = 0
      while (y < rows.length && !fits(y, e.node_start, e.node_end)) y++
      put(e, y)
    }
    rowsByNode.set(nd.node_name, rows.length)
    if (rows.length > maxRow) maxRow = rows.length
  }

  const sampleSet = new Set<string>()
  for (const entries of Object.values(byNode)) {
    for (const e of entries) { if (e.sample_id) sampleSet.add(e.sample_id) }
  }

  return { byNode: result, maxYRow: maxRow, rowsByNode, samples: [...sampleSet].sort() }
}

// px per bp for each mode (null = fit to container)
// 各レベルの px/bp（fit は null＝全体）。10のべき。base=10px/bp で塩基文字。
const PX_PER_BP: Record<ZoomMode, number | null> = {
  'fit': null,
  '1kbp': 0.001,   // 1000 bp/px
  '100bp': 0.01,   // 100 bp/px
  '10bp': 0.1,     // 10 bp/px
  '1bp': 1,        // 1 bp/px（変異位置スキャン）
  'base': 10,      // 0.1 bp/px（塩基文字）
}
const ZOOM_SHORT: Record<ZoomMode, string> = {
  fit: '概', '1kbp': '1k', '100bp': '100', '10bp': '10', '1bp': '1', base: '塩',
}
const ZOOM_TITLE: Record<ZoomMode, string> = {
  fit: '全体（集約のみ・塩基なし）', '1kbp': '1000 bp/px', '100bp': '100 bp/px',
  '10bp': '10 bp/px', '1bp': '1 bp/px（変異位置スキャン）', base: '0.1 bp/px（塩基文字）',
}
// fit + ノードが MIN_COL_PX 以上になるレベル。塩基(base)は小ノードでも選べるよう常に含める。
// ★size が欠けている（描画の高速経路は size を返さない）と nodeSize*p が NaN になり、
//   **fit と base の 2 段しか残らない**。列が最小幅から広がらず、+ を押すといきなり塩基表示へ
//   飛んで落ちる、という形で出た。欠けているときは「大きいノード」とみなして全段を許す。
function validZoomSteps(nodeSize: number): ZoomMode[] {
  const n = Number.isFinite(nodeSize) && nodeSize > 0 ? nodeSize : Infinity
  return ZOOM_ORDER.filter(z => { const p = PX_PER_BP[z]; return p === null || z === 'base' || n * p >= MIN_COL_PX })
}
function stepZoom(z: ZoomMode, dir: 1 | -1, steps: ZoomMode[]): ZoomMode {
  let i = steps.indexOf(z); if (i < 0) i = 0   // 範囲外(fit以下にクランプ)は fit 扱い
  return steps[Math.max(0, Math.min(steps.length - 1, i + dir))]
}
// ルーラーで選んだ bp 幅 rangeBp を viewW px に収める最細レベルを、有効ステップから選ぶ
// （×10 の離散レベルなので「収まる範囲で最も拡大」＝ p ≤ viewW/rangeBp の最大 p）。
function pickZoomLevel(rangeBp: number, viewW: number, nodeSize: number): ZoomMode {
  const steps = validZoomSteps(nodeSize)   // 先頭は 'fit'（最も縮小）
  if (rangeBp <= 0) return steps[steps.length - 1]
  const want = viewW / rangeBp
  let best = steps[0]
  for (const z of steps) { const p = PX_PER_BP[z]; if (p != null && p <= want) best = z }
  return best
}

function useDragScroll(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let dragging = false, startX = 0, startScrollLeft = 0

    function onMouseDown(e: MouseEvent) {
      // ルーラー上のドラッグ（範囲ズーム）はパンさせない
      if ((e.target as HTMLElement)?.closest?.('[data-ruler]')) return
      dragging = true
      startX = e.clientX
      startScrollLeft = (e.currentTarget as HTMLElement).scrollLeft
      ;(e.currentTarget as HTMLElement).style.cursor = 'grabbing'
      e.preventDefault()
    }
    function onMouseMove(e: MouseEvent) {
      if (!dragging) return
      el!.scrollLeft = startScrollLeft - (e.clientX - startX)
    }
    function onMouseUp() {
      if (!dragging) return
      dragging = false
      el!.style.cursor = 'grab'
    }

    el.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [ref])
}

const DEFAULT_LANE_H = 150   // 1段(レーン)のデフォルト高さ

export default function AlignmentView({
  rows, activeRowId, globalMapq, pendingNode, onClearPending, onSetActiveRow, onAddRow,
  onRemoveRow, onRemoveNode, onInsertColumn, onAddLane, onMoveNode, onExpandNode, onToggleFlip, onUpdateUi, nodeColors, height, dbFile,
  selectedAln, onSelectAln,
}: Props) {
  const TOPBAR_H = 28
  const bodyH = height - TOPBAR_H

  // 保留中ノードがあるとき Esc でキャンセル
  useEffect(() => {
    if (!pendingNode) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClearPending() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingNode, onClearPending])

  // アラインメントパネルが開いた際に自動でviewを1つ追加（StrictMode二重実行対策でrefフラグ使用）
  const onAddRowRef = useRef(onAddRow)
  onAddRowRef.current = onAddRow
  const autoAddedRef = useRef(false)
  useEffect(() => {
    if (!autoAddedRef.current && rows.length === 0) {
      autoAddedRef.current = true
      onAddRowRef.current()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleNodeAdd(rowId: number) {
    onSetActiveRow(activeRowId === rowId ? null : rowId)
  }

  return (
    <div style={{ height, display: 'flex', flexDirection: 'column', background: '#f8f9fa' }}>

      {/* Top bar */}
      <div style={{
        height: TOPBAR_H, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
        borderBottom: '1px solid #dee2e6', background: '#f1f3f5',
      }}>
        <button
          onClick={onAddRow}
          title="新しいビューを追加"
          style={{
            fontFamily: 'sans-serif', fontSize: 12, padding: '2px 10px',
            border: '1px solid #7950f2', borderRadius: 4,
            background: '#7950f2', color: '#fff', cursor: 'pointer',
          }}
        >
          view +
        </button>
      </div>

      {/* Rows — 縦スクロール対応 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ height: bodyH, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#adb5bd', fontFamily: 'sans-serif', fontSize: 13 }}>
            ノードをクリックしてアラインメントを表示
          </div>
        ) : (
          rows.map(row => (
            <AlignRowView
              key={row.id}
              row={row}
              dbFile={dbFile}
              globalMapq={globalMapq}
              isActive={activeRowId === row.id}
              pendingNode={activeRowId === row.id ? pendingNode : null}
              onToggleNodeAdd={() => toggleNodeAdd(row.id)}
              onRemoveRow={() => onRemoveRow(row.id)}
              onRemoveNode={nodeId => onRemoveNode(row.id, nodeId)}
              onInsertColumn={colIndex => pendingNode && onInsertColumn(row.id, colIndex, pendingNode)}
              onAddLane={colIndex => pendingNode && onAddLane(row.id, colIndex, pendingNode)}
              onMoveNode={(nodeId, dest) => onMoveNode(row.id, nodeId, dest)}
              onExpandNode={seedName => onExpandNode(row.id, seedName)}
              flippedIds={row.flipped}
              onToggleFlip={nodeId => onToggleFlip(row.id, nodeId)}
              onUpdateUi={ui => onUpdateUi(row.id, ui)}
              nodeColors={nodeColors}
              selectedAln={selectedAln ?? null}
              onSelectAln={onSelectAln}
            />
          ))
        )}
      </div>
    </div>
  )
}

const DIVIDER_W = 14  // px, 列間ギャップ兼リサイズハンドル幅（コネクタを見やすく広め）

const RESIZE_H = 5   // 行高さ調整ハンドルの高さ

// 列間コネクタ（同一 aln_id を結ぶ線）
interface Conn { x1: number; y1: number; x2: number; y2: number; color: string; dashed: boolean; faint: boolean }
interface ConnRef { e: LayoutEntry; nodeId: number; size: number }

// 接続端（隣接ノードへ向かう端）のノード内フラクション(0..1, sequence order)。
// isFirst = このノードがクエリ上で前 → 後続へ向かう端＝最大クエリ側を返す。
// 反転は描画側(sx)で処理するので、ここでは常に sequence-order 座標を返す。
function junctionFrac(e: LayoutEntry, size: number, isFirst: boolean): number {
  if (size <= 0) return isFirst ? 1 : 0
  let coord: number
  if (e.query_start != null && e.query_end != null) {
    const wantMax = isFirst
    coord = e.strand === '-'
      ? (wantMax ? e.node_start : e.node_end)   // '-': query_end ↔ node_start
      : (wantMax ? e.node_end   : e.node_start)
  } else {
    coord = isFirst ? e.node_end : e.node_start  // 旧スキーマ: sequence order でフォールバック
  }
  return coord / size
}

function AlignRowView({ row, dbFile, globalMapq, isActive, pendingNode, flippedIds: flippedProp, onToggleNodeAdd, onRemoveRow, onRemoveNode, onInsertColumn, onAddLane, onMoveNode, onExpandNode, onToggleFlip, onUpdateUi, nodeColors, selectedAln, onSelectAln }: {
  row: AlignRow
  dbFile: string
  globalMapq: number
  isActive: boolean
  pendingNode: NodeData | null
  flippedIds?: number[]
  onToggleNodeAdd: () => void
  onRemoveRow: () => void
  onRemoveNode: (nodeId: number) => void
  onInsertColumn: (colIndex: number) => void
  onAddLane: (colIndex: number) => void
  onMoveNode: (nodeId: number, dest: MoveDest) => void
  onExpandNode: (seedName: string) => void
  onToggleFlip: (nodeId: number) => void
  onUpdateUi: (ui: AlignUi) => void
  nodeColors: Map<string, number>
  selectedAln: number | null
  onSelectAln?: (alnId: number | null) => void
}) {
  const ui0 = row.ui   // 初期UI状態（復元時はrow.idが変わり再マウントされてここから初期化される）
  const [boardZoom, setBoardZoom] = useState<ZoomMode>(() => ui0?.boardZoom ? migrateZoom(ui0.boardZoom) : 'fit')
  const [nodeZoom, setNodeZoom] = useState<Record<number, ZoomMode>>(
    () => Object.fromEntries(Object.entries(ui0?.nodeZoom ?? {}).map(([k, v]) => [k, migrateZoom(v)])))
  const zoomOf = (id: number): ZoomMode => nodeZoom[id] ?? boardZoom
  const [dragId, setDragId] = useState<number | null>(null)  // ドラッグ中のノードid（⠿グリップで開始）
  const [dropHint, setDropHint] = useState<{ col: number; lane: number; mode: 'before' | 'after' | 'swap' | 'place' } | null>(null)
  const HEADER_H = 22
  const rowBodyRef = useRef<HTMLDivElement>(null)
  const [colWidths, setColWidths] = useState<number[] | null>(null)
  const [laneRowHeights, setLaneRowHeights] = useState<number[]>(() => ui0?.laneHeights ?? [])
  const [readLayout, setReadLayout] = useState<RowReadLayout | null>(null)
  // 選択中 aln_id がこのボードに存在する時だけ強調を有効化（無関係なボードを灰色にしない）。
  const effSelectedAln = useMemo(() => {
    if (selectedAln == null || !readLayout) return null
    for (const entries of readLayout.byNode.values())
      for (const e of entries) if (e.aln_id === selectedAln) return selectedAln
    return null
  }, [selectedAln, readLayout])
  const flippedIds = useMemo(() => new Set(flippedProp ?? []), [(flippedProp ?? []).join(',')])  // 反転ノード（ボード側で保持）
  const [selectedSamples, setSelectedSamples] = useState<Set<string> | null>(() => ui0?.samples ? new Set(ui0.samples) : null)
  // リード塗りモード。旧 colorMode='sample' は readFill='sample' に移行、それ以外は 'auto'。
  const [readFill, setReadFill] = useState<ReadFill>(() => ui0?.readFill ?? (ui0?.colorMode === 'sample' ? 'sample' : 'auto'))
  // 株フォーカスの振る舞い: false=絞り込み(非選択を非表示), true=強調(非選択を灰で残す)
  const [sampleHighlight, setSampleHighlight] = useState<boolean>(() => ui0?.sampleHighlight ?? false)
  // 選択タグ。配列 index = 安定した色スロット。解除したタグは null にして穴を残し、
  // 次の選択が最小の空きスロットを再利用する（残りタグの色が動かないようにするため）。
  const [selectedTags, setSelectedTags] = useState<(string | null)[]>(() => ui0?.tags ?? [])
  const [rawAlignData, setRawAlignData] = useState<Record<string, ReadAlignEntry[]> | null>(null)
  const [readTotals, setReadTotals] = useState<Record<string, number>>({})
  const [showConnectors, setShowConnectors] = useState(() => ui0?.showConnectors ?? true)
  // リードの縦位置: 'packed'=上に詰める（既定）/ 'unique'=1 リード 1 段（列をまたいで追える）
  const [readRows, setReadRows] = useState<'packed' | 'unique'>(() => ui0?.readRows ?? 'packed')
  const [cbSafe, setCbSafe] = useState<boolean>(() => ui0?.cbSafe ?? false)
  // ボード固有の mapq 上書き。null = 大域 mapq に追従。数値 = このボードだけその値で絞る。
  // （旧セッションの minMapq=0/未設定 は「追従」として扱う。正の保存値は上書きとして復元。）
  const [mapqOverride, setMapqOverride] = useState<number | null>(() => ui0?.minMapq ? ui0.minMapq : null)
  const [mapqInput, setMapqInput] = useState(() => ui0?.minMapq ? String(ui0.minMapq) : '')
  const effMapq = mapqOverride ?? globalMapq   // 実際に適用する mapq しきい値
  function commitMapq(raw: string) {
    const s = raw.trim()
    if (s === '') { setMapqOverride(null); return }   // 空 = 大域に追従
    const v = parseInt(s, 10)
    setMapqOverride(isNaN(v) || v < 0 ? null : v)
  }
  // node.id → { svg: pileup SVG, vp: 可視ビューポート(横スクロール容器) }（コネクタ測定用）
  const pileupEls = useRef(new Map<number, { svg: SVGSVGElement; vp: HTMLElement | null }>())
  const overlayWrapRef = useRef<HTMLDivElement>(null)
  const [connectors, setConnectors] = useState<Conn[]>([])

  // P2: 選択/検索リードを含む最初の列をボードの横スクロールで可視化（1選択につき1回）。
  // 各列内の縦/横スクロールは NodeBody 側が行う。リードが後から読み込まれた時(P3)も発火する。
  const boardScrolledForRef = useRef<number | null>(null)
  useEffect(() => {
    if (effSelectedAln == null) { boardScrolledForRef.current = null; return }
    if (!readLayout || boardScrolledForRef.current === effSelectedAln) return
    for (const col of row.columns) {
      for (const n of col) {
        if (!n) continue
        const entries = readLayout.byNode.get(n.node_name)
        if (entries && entries.some(e => e.aln_id === effSelectedAln)) {
          boardScrolledForRef.current = effSelectedAln
          pileupEls.current.get(n.id)?.vp?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          return
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effSelectedAln, readLayout])

  // UI状態を App(row.ui) に反映（スナップショット保存用）。ループ回避のため ref 経由
  const onUpdateUiRef = useRef(onUpdateUi); onUpdateUiRef.current = onUpdateUi
  const nodeZoomKey = Object.entries(nodeZoom).sort().map(([k, v]) => `${k}:${v}`).join(',')
  const samplesKeyUi = selectedSamples ? [...selectedSamples].sort().join(',') : '*'
  const laneHeightsKeyUi = laneRowHeights.join(',')
  const tagsKeyUi = selectedTags.join(',')
  useEffect(() => {
    onUpdateUiRef.current({
      boardZoom, nodeZoom,
      tags: selectedTags,
      samples: selectedSamples ? [...selectedSamples] : null,
      readFill, sampleHighlight, showConnectors, readRows, laneHeights: laneRowHeights,
      minMapq: mapqOverride == null ? undefined : mapqOverride,
      cbSafe,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardZoom, nodeZoomKey, tagsKeyUi, samplesKeyUi, readFill, sampleHighlight, showConnectors, readRows, laneHeightsKeyUi, mapqOverride, cbSafe])

  const allNodes = row.columns.flat().filter((n): n is NodeData => n != null)
  const nodeNamesKey = allNodes.map(n => n.node_name).join(',')
  const columnsKey = row.columns.map(c => c.map(n => n ? n.node_name : '_').join('/')).join('|')  // 列・段構造（null含む）
  const zoomKey = allNodes.map(n => zoomOf(n.id)).join(',')  // ノード別倍率（コネクタ再計算用）
  const tagsKey = selectedTags.join(',')
  const tagColorOf = (name: string): string | null => {
    const i = selectedTags.indexOf(name)   // index = 色スロット
    return i < 0 ? null : TAG_COLORS[i % TAG_COLORS.length]
  }
  function toggleTag(name: string) {
    setSelectedTags(prev => {
      const idx = prev.indexOf(name)
      if (idx >= 0) {
        // 解除: そのスロットを null にして穴を残す（他タグの色を動かさない）。末尾の穴は詰める。
        const next = prev.slice()
        next[idx] = null
        while (next.length && next[next.length - 1] == null) next.pop()
        return next
      }
      // 選択: 最小の空きスロットを再利用。なければ末尾に追加。
      const free = prev.indexOf(null)
      if (free >= 0) { const next = prev.slice(); next[free] = name; return next }
      return [...prev, name]
    })
  }
  const maxLanes = Math.max(1, ...row.columns.map(c => c.length))
  const DROP_LANE_H = 40
  // 段(レーンバンド)ごとの高さ。未設定の段は DEFAULT_LANE_H
  const bandHeights = Array.from({ length: maxLanes }, (_, l) => laneRowHeights[l] ?? DEFAULT_LANE_H)
  // グリッド総高 = 各段高さの合計 + 各段下のリサイズハンドル + (保留中は ＋段 / ドラッグ中は新段ゾーン)
  const gridContentH = bandHeights.reduce((s, h) => s + h, 0)
    + maxLanes * RESIZE_H + (pendingNode ? DROP_LANE_H : 0) + (dragId != null ? 16 : 0)

  function startLaneResize(lane: number, e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const base = bandHeights.slice()
    const startH = base[lane]
    function onMove(ev: MouseEvent) {
      const newH = Math.max(70, startH + ev.clientY - startY)
      const next = base.slice()
      next[lane] = newH
      setLaneRowHeights(next)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const samples = useMemo(() => {
    if (!rawAlignData) return []
    const s = new Set<string>()
    for (const entries of Object.values(rawAlignData))
      for (const e of entries) { if (e.sample_id) s.add(e.sample_id) }
    return [...s].sort()
  }, [rawAlignData])

  const sampleColorMap = useMemo(() => {
    const m = new Map<string, string>()
    samples.forEach((s, i) => m.set(s, SAMPLE_COLORS[i % SAMPLE_COLORS.length]))
    return m
  }, [samples])

  function toggleSample(sid: string) {
    setSelectedSamples(prev => {
      const current = prev ?? new Set(samples)
      const next = new Set(current)
      next.has(sid) ? next.delete(sid) : next.add(sid)
      return next.size === samples.length ? null : next
    })
  }

  // リード塗りモードを循環。標本(サンプル別)は複数サンプルがあるときのみ。
  const fillOrder: ReadFill[] = samples.length > 1
    ? ['auto', 'strand', 'sample', 'muted']
    : ['auto', 'strand', 'muted']
  function cycleFill() {
    setReadFill(prev => {
      const i = fillOrder.indexOf(prev)
      return fillOrder[(i < 0 ? 0 : i + 1) % fillOrder.length]
    })
  }

  // 8.1 別ファイル SVG: 画面のアラインメントを「見たまま」ベクタ化する。各列の実 SVG
  // (ルーラー/変異密度/参照配列トラック/CIGAR・cs:Z 塩基グリフ)＋ノード跨ぎコネクタ層を、
  // DOM の実測座標(getBoundingClientRect)で 1 枚に合成する ＝ 現ビューポートと完全一致。
  // 塩基文字・ミスマッチ(赤/alt塩基)・挿入(▽)・欠失(線)・参照配列は各列 SVG がそのまま持つので忠実。
  // 範囲は「今スクロールで見えている窓」のみ（画面外にはみ出た列内容はルート svg viewport でクリップ）。
  function serializeBoardSvg(): string | null {
    const wrap = overlayWrapRef.current
    if (!wrap || allNodes.length === 0) return null
    const O = wrap.getBoundingClientRect()
    const W = Math.max(1, Math.round(O.width)), H = Math.max(1, Math.round(O.height))
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const ser = new XMLSerializer()
    const NS = 'http://www.w3.org/2000/svg'
    let uid = 0

    // ネストする各 <svg> 内の id を一意化（列間で hatch-0-1 等が衝突して url(#) が
    // 先頭一致で誤解決するのを防ぐ）。id と url(#id)/href="#id" 参照を同じ接頭辞で書き換える。
    const uniquify = (root: Element, prefix: string) => {
      const map = new Map<string, string>()
      root.querySelectorAll('[id]').forEach(el => {
        const old = el.getAttribute('id')!; const neu = prefix + old
        map.set(old, neu); el.setAttribute('id', neu)
      })
      if (map.size === 0) return
      const rew = (v: string) =>
        v.replace(/url\(#([^)]+)\)/g, (m, g) => map.has(g) ? `url(#${map.get(g)})` : m)
         .replace(/^#([^\s]+)$/, (m, g) => map.has(g) ? `#${map.get(g)}` : m)
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        for (const a of el.getAttributeNames()) {
          const v = el.getAttribute(a); if (!v) continue
          if (v.includes('url(#') || (a.toLowerCase().endsWith('href') && v.startsWith('#')))
            el.setAttribute(a, rew(v))
        }
      }
    }

    const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`]

    // 1) ヘッダ帯（ノード名）。HTML なので合成せず簡易再描画。列幅で切り詰め。
    wrap.querySelectorAll<HTMLElement>('[data-node-hdr]').forEach(el => {
      const r = el.getBoundingClientRect()
      const dx = r.left - O.left, dy = r.top - O.top
      if (r.width <= 0 || dx >= W || dx + r.width <= 0 || dy >= H || dy + r.height <= 0) return
      const full = el.getAttribute('data-node-hdr') || ''
      const maxCh = Math.max(1, Math.floor((r.width - 8) / 6.6))
      const name = full.length > maxCh ? full.slice(0, Math.max(1, maxCh - 1)) + '…' : full
      parts.push(`<rect x="${dx.toFixed(1)}" y="${dy.toFixed(1)}" width="${r.width.toFixed(1)}" height="${r.height.toFixed(1)}" fill="#e9ecef" stroke="#dee2e6" stroke-width="0.5"/>`)
      parts.push(`<text x="${(dx + 4).toFixed(1)}" y="${(dy + r.height / 2 + 4).toFixed(1)}" font-size="11" font-family="ui-monospace,monospace" fill="#343a40">${esc(name)}</text>`)
    })

    // 2) 全トラック SVG（ルーラー/変異密度/参照配列/pileup）＋コネクタ層を実測座標でネスト。
    //    横スクロールした列はスクロール分だけ左端が負になり、ルート viewport でクリップされる＝画面通り。
    wrap.querySelectorAll('svg').forEach(svg => {
      const r = svg.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      const dx = r.left - O.left, dy = r.top - O.top
      if (dx + r.width <= 0 || dx >= W || dy + r.height <= 0 || dy >= H) return   // 完全に画面外
      const vbw = svg.viewBox?.baseVal?.width || svg.width?.baseVal?.value || r.width
      const vbh = svg.viewBox?.baseVal?.height || svg.height?.baseVal?.value || r.height
      const clone = svg.cloneNode(true) as SVGSVGElement
      uniquify(clone, `x${uid++}_`)
      clone.setAttribute('x', dx.toFixed(2))
      clone.setAttribute('y', dy.toFixed(2))
      clone.setAttribute('width', r.width.toFixed(2))
      clone.setAttribute('height', r.height.toFixed(2))
      clone.removeAttribute('style')
      // 背景色は CSS 指定で clone に乗らないため rect で補う（内部座標＝viewBox 基準）。
      const bg = getComputedStyle(svg).backgroundColor
      const bgRect = (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent')
        ? `<rect x="0" y="0" width="${vbw}" height="${vbh}" fill="${bg}"/>` : ''
      let s = ser.serializeToString(clone)
      if (bgRect) s = s.replace(/^(<svg[^>]*>)/, `$1${bgRect}`)
      parts.push(s)
    })

    const stamp = `amipa alignment view · ${new Date().toISOString().slice(0, 10)} · ${esc(dbFile)}`
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<!-- ${stamp} -->
${parts.join('\n')}
</svg>
`
  }
  function exportAlignPileup() {
    const svg = serializeBoardSvg()
    if (!svg) return
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = `alignment_${(allNodes[0]?.node_name || 'board').replace(/[^\w.+-]+/g, '_')}_view.svg`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // Reset to auto-proportional when column count changes
  useEffect(() => { setColWidths(null) }, [row.columns.length])

  // Fetch raw alignment data。endMargin=32: 総数の多い巨大ノードは「端に達するリード」だけ取得。
  useEffect(() => {
    if (allNodes.length === 0) { setRawAlignData(null); setReadTotals({}); return }
    let cancelled = false
    fetchReadAlignments(dbFile, allNodes.map(n => n.node_name), 32).then(({ reads, totals }) => {
      if (cancelled) return
      setRawAlignData(reads)
      setReadTotals(totals)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbFile, nodeNamesKey])

  // 端のみ取得した巨大ノードで、塩基レベル表示時に表示範囲のリードを追加取得する（タイル管理）。
  // 座標を TILE_BP 幅のタイルに区切り、取得済みタイルを記録 → 未取得タイルだけを取りに行くので、
  // 左右先読みで範囲を広げても既取得分は再取得しない。
  const TILE_BP = 4096
  const loadedTilesRef = useRef<Map<string, Set<number>>>(new Map())
  useEffect(() => { loadedTilesRef.current = new Map() }, [dbFile, nodeNamesKey])
  const keyOf = (r: ReadAlignEntry) => r.aln_id != null ? `a${r.aln_id}` : `n${r.read_name}:${r.node_start}`
  const loadRegion = (nodeName: string, start: number, end: number) => {
    const t0 = Math.max(0, Math.floor(start / TILE_BP))
    const t1 = Math.floor(Math.max(start, end - 1) / TILE_BP)
    let loaded = loadedTilesRef.current.get(nodeName)
    if (!loaded) { loaded = new Set(); loadedTilesRef.current.set(nodeName, loaded) }
    const added: number[] = []
    for (let t = t0; t <= t1; t++) if (!loaded.has(t)) { loaded.add(t); added.push(t) }
    if (added.length === 0) return   // 範囲内は全タイル取得済み
    const rs = added[0] * TILE_BP, re = (added[added.length - 1] + 1) * TILE_BP
    fetchReadAlignments(dbFile, [nodeName], undefined, { start: rs, end: re }).then(({ reads }) => {
      const fresh = reads[nodeName] ?? []
      if (fresh.length === 0) return
      setRawAlignData(prev => {
        const base = prev ?? {}
        const existing = base[nodeName] ?? []
        const seen = new Set(existing.map(keyOf))
        const merged = existing.slice()
        for (const r of fresh) { const k = keyOf(r); if (!seen.has(k)) { seen.add(k); merged.push(r) } }
        return merged.length === existing.length ? prev : { ...base, [nodeName]: merged }
      })
    }).catch(() => { for (const t of added) loaded!.delete(t) })   // 失敗タイルは未取得へ戻し再試行可能に
  }

  // ボードのノードが変わったら、消えたノードのスロットを null 化（他タグの色は維持）。末尾の穴は詰める。
  useEffect(() => {
    setSelectedTags(prev => {
      const next = prev.map(t => (t != null && allNodes.some(n => n.node_name === t)) ? t : null)
      while (next.length && next[next.length - 1] == null) next.pop()
      return next.length === prev.length && next.every((t, i) => t === prev[i]) ? prev : next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeNamesKey])

  // selectedSamples / selectedTags / rawAlignData / effMapq が変わったらレイアウトを再計算
  useEffect(() => {
    if (!rawAlignData) { setReadLayout(null); return }
    // 株フォーカス: 絞り込みモードのみレイアウトから除外。強調モードは全リードを残し色だけ灰にする。
    const sampleFilter = selectedSamples !== null && !sampleHighlight
    // 株フィルタ + mapq フィルタ（mapq が null の旧スキーマは通す）。effMapq はボード上書き or 大域。
    const keep = (e: ReadAlignEntry) =>
      (!sampleFilter || !e.sample_id || selectedSamples!.has(e.sample_id)) &&
      (effMapq <= 0 || e.mapq == null || e.mapq >= effMapq)
    const data = (!sampleFilter && effMapq <= 0)
      ? rawAlignData
      : Object.fromEntries(Object.entries(rawAlignData).map(([nname, entries]) =>
          [nname, entries.filter(keep)]))
    setReadLayout(computeReadLayout(allNodes, data, selectedTags, readRows))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawAlignData, selectedSamples, sampleHighlight, effMapq, nodeNamesKey, columnsKey, tagsKey, readRows])

  // 列間コネクタ用データ: 列ごとに aln_id → {entry, nodeId, size}（全リード。選択不要）
  const bandHeightsKey = bandHeights.join(',')
  const flippedKey = [...flippedIds].sort((a, b) => a - b).join(',')
  const colMaps = useMemo(() => {
    if (!readLayout || !showConnectors) return [] as Map<number, ConnRef>[]
    return row.columns.map(col => {
      const m = new Map<number, ConnRef>()
      for (const node of col) {
        if (!node) continue
        for (const e of (readLayout.byNode.get(node.node_name) ?? [])) {
          if (e.aln_id == null || m.has(e.aln_id)) continue
          m.set(e.aln_id, { e, nodeId: node.id, size: node.size })
        }
      }
      return m
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readLayout, showConnectors, nodeNamesKey])

  // 隣接列で同一 aln_id を、接続端どうし（クエリ座標＋反転を考慮）で結ぶ。
  // 色付き（選択ノードを通る=sig>0）は濃く・タグ色、それ以外は灰色で薄く。
  useEffect(() => {
    if (colMaps.length < 2) { setConnectors([]); return }
    function recompute() {
      const wrap = overlayWrapRef.current
      if (!wrap) return
      const orect = wrap.getBoundingClientRect()
      // ノードごとに svg/viewport 矩形を1フレーム1回測定（レイアウトスラッシング回避）
      const cache = new Map<number, { svg: DOMRect; vp: DOMRect | null } | null>()
      const getRects = (nodeId: number) => {
        if (cache.has(nodeId)) return cache.get(nodeId)!
        const ent = pileupEls.current.get(nodeId)
        const r = ent
          ? { svg: ent.svg.getBoundingClientRect(), vp: ent.vp ? ent.vp.getBoundingClientRect() : null }
          : null
        cache.set(nodeId, r)
        return r
      }
      // 接続端の画面座標。frac→svg幅で実位置を出し、可視ビューポートにクランプ
      //（ズーム時に端点が画面外へ飛んでも、ギャップ側のタイル端で結ぶ）。
      // readRowH はノード個別の倍率に従う（列ごとに倍率が違ってよい）。
      const endpoint = (rects: { svg: DOMRect; vp: DOMRect | null }, frac: number, flip: boolean, yRow: number, readRowH: number) => {
        const sr = rects.svg
        let x = flip ? sr.right - frac * sr.width : sr.left + frac * sr.width
        let y = sr.top + yRow * readRowH + readRowH / 2
        const vp = rects.vp
        if (vp) {
          x = Math.max(vp.left, Math.min(vp.right, x))
          y = Math.max(vp.top, Math.min(vp.bottom, y))
        }
        return { x: x - orect.left, y: y - orect.top }
      }
      // aln_id ごとに全列での出現を集め、リード順(query_start)で連続するものを結ぶ。
      // → 隣接列でなくても、離れて配置された同一リードのノードが線で繋がる。
      const occ = new Map<number, { ci: number; ref: ConnRef }[]>()
      for (let c = 0; c < colMaps.length; c++) {
        for (const [aln, ref] of colMaps[c]) {
          let arr = occ.get(aln)
          if (!arr) { arr = []; occ.set(aln, arr) }
          arr.push({ ci: c, ref })
        }
      }
      const lines: Conn[] = []
      for (const arr of occ.values()) {
        if (arr.length < 2) continue
        arr.sort((a, b) => (a.ref.e.query_start ?? a.ci) - (b.ref.e.query_start ?? b.ci) || a.ci - b.ci)
        for (let i = 0; i < arr.length - 1; i++) {
          const av = arr[i].ref, bv = arr[i + 1].ref   // av がリード上で前
          if (arr[i].ci === arr[i + 1].ci) continue
          const ar = getRects(av.nodeId)
          const br = getRects(bv.nodeId)
          if (!ar || !br) continue
          const colored = av.e.sig.length > 0
          const rhA = READ_ROW_H[zoomOf(av.nodeId)], rhB = READ_ROW_H[zoomOf(bv.nodeId)]
          const p1 = endpoint(ar, junctionFrac(av.e, av.size, true), flippedIds.has(av.nodeId), av.e.y_row, rhA)
          const p2 = endpoint(br, junctionFrac(bv.e, bv.size, false), flippedIds.has(bv.nodeId), bv.e.y_row, rhB)
          lines.push({
            x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
            color: colored ? TAG_COLORS[av.e.sig[0] % TAG_COLORS.length] : '#868e96',
            dashed: av.e.sig.length > 1,
            faint: !colored,
          })
        }
      }
      setConnectors(lines)
    }
    let raf = 0
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(recompute) }
    setConnectors([])   // 依存変化(ズーム/列幅/レイアウト)時は古い線を即クリアし recompute で引き直す（残像防止）
    schedule()
    window.addEventListener('scroll', schedule, true)  // capture: 内側スクロールも拾う
    window.addEventListener('resize', schedule)
    const ro = new ResizeObserver(schedule)
    if (overlayWrapRef.current) ro.observe(overlayWrapRef.current)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      ro.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colMaps, zoomKey, flippedKey, colWidths, bandHeightsKey, pendingNode])

  // 列ごとの代表サイズ（最大段サイズ）— 比例幅算出に使用
  const colReps = row.columns.map(col => Math.max(1, ...col.filter((n): n is NodeData => n != null).map(n => n.size)))

  function startResize(idx: number, e: React.MouseEvent) {
    e.preventDefault()
    const container = rowBodyRef.current
    if (!container) return

    // ドラッグ開始時の「実際に描画されている」列幅を測って起点にする。
    // 比例(flex)レイアウトの実幅は MIN_COL_PX + 空き幅の比例配分で、単純な
    // (size比 × 全幅) の式とは一致しない。式から作り直すと未調整の列がその式幅へ
    // ジャンプ（＝ノードサイズ比例の既定へ戻ったように見える）するので、実測値を使う。
    const els = container.querySelectorAll<HTMLElement>('[data-colw]')
    let cur: number[]
    if (els.length === row.columns.length) {
      cur = Array.from(els).map(el => el.getBoundingClientRect().width)
    } else if (colWidths && colWidths.length === row.columns.length) {
      cur = [...colWidths]
    } else {
      // フォールバック（測定不可時のみ）: size比例の概算
      const n = row.columns.length
      const dividerTotal = Math.max(0, n - 1) * DIVIDER_W
      const availW = container.offsetWidth - dividerTotal - 4
      const totalSize = colReps.reduce((s, v) => s + v, 0) || 1
      cur = colReps.map(v => Math.max(MIN_COL_PX, Math.round((v / totalSize) * availW)))
    }

    const startX = e.clientX
    // 毎フレーム cur(ドラッグ開始時のスナップショット) から再計算。動かした境界以外は不変。
    // mousemove は1フレームに何度も来るので rAF でコアレスし、再描画は最大フレーム1回に抑える。
    let raf = 0
    let pendingDx = 0
    let moved = false
    const flush = () => { raf = 0; setColWidths(applyColResize(cur, idx, pendingDx)) }
    function onMove(ev: MouseEvent) {
      pendingDx = ev.clientX - startX
      moved = true
      if (!raf) raf = requestAnimationFrame(flush)
    }
    function onUp() {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      if (moved) setColWidths(applyColResize(cur, idx, pendingDx))   // 最終位置を確実に反映（純クリックは無視）
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 列挿入スロット（保留中ノードがあるときのみ）
  function dropColumnSlot(index: number) {
    return (
      <div key={`dropcol-${index}`} onClick={() => onInsertColumn(index)}
        title="ここに新しい列を挿入"
        style={{
          alignSelf: 'stretch', width: 22, flexShrink: 0, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px dashed #b197fc', borderRadius: 3, background: '#f3f0ff',
          color: '#7950f2', fontSize: 10, fontFamily: 'sans-serif', writingMode: 'vertical-rl',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#e5dbff' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#f3f0ff' }}
      >＋列</div>
    )
  }

  // 1つの列。maxLanes 個のバンド行を描画（空セルもスペーサ＋ハンドルで埋める）
  function renderColumn(col: (NodeData | null)[], c: number) {
    // 固定幅モードは flexShrink/Grow を 0 にして、動かしていない列が
    // コンテナ幅の変動(スクロールバー・再レイアウト)で勝手に縮む/比例配分に戻るのを防ぐ。
    // 長さ不一致(列増減直後)のときは比例にフォールバック。
    const useFixed = !!colWidths && colWidths.length === row.columns.length
    const colStyle: React.CSSProperties = useFixed
      ? { flexBasis: colWidths![c], flexShrink: 0, flexGrow: 0, minWidth: MIN_COL_PX }
      : { flex: colReps[c], flexShrink: 1, flexBasis: MIN_COL_PX, minWidth: MIN_COL_PX }
    return (
      <div key={`col-${c}`} data-colw={c} style={{
        ...colStyle, alignSelf: 'flex-start',
        display: 'flex', flexDirection: 'column',
      }}>
        {Array.from({ length: maxLanes }, (_, l) => {
          const node = col[l] ?? null
          const hint = dropHint?.col === c && dropHint.lane === l ? dropHint.mode : null
          return (
          <Fragment key={l}>
            <div
              onDragOver={e => {
                if (dragId == null) return
                e.preventDefault()
                if (node && dragId === node.id) return
                let mode: 'before' | 'after' | 'swap' | 'place' = 'place'
                if (node) {
                  const r = e.currentTarget.getBoundingClientRect()
                  const edge = Math.min(16, r.height * 0.25)
                  const rel = e.clientY - r.top
                  mode = rel < edge ? 'before' : rel > r.height - edge ? 'after' : 'swap'
                }
                setDropHint(prev => prev && prev.col === c && prev.lane === l && prev.mode === mode ? prev : { col: c, lane: l, mode })
              }}
              onDrop={e => {
                if (dragId == null) return
                e.preventDefault()
                if (!(node && dragId === node.id)) {
                  if (node) {
                    const r = e.currentTarget.getBoundingClientRect()
                    const edge = Math.min(16, r.height * 0.25)
                    const rel = e.clientY - r.top
                    if (rel < edge) onMoveNode(dragId, { kind: 'lane', col: c, lane: l })
                    else if (rel > r.height - edge) onMoveNode(dragId, { kind: 'lane', col: c, lane: l + 1 })
                    else onMoveNode(dragId, { kind: 'swap', withNodeId: node.id })
                  } else {
                    onMoveNode(dragId, { kind: 'cell', col: c, lane: l })
                  }
                }
                setDragId(null); setDropHint(null)
              }}
              style={{ position: 'relative', opacity: node && dragId === node.id ? 0.4 : 1 }}
            >
            {node ? (
              <NodeColumn
                key={node.id}
                node={node}
                headerH={HEADER_H}
                bodyH={Math.max(40, bandHeights[l] - HEADER_H)}
                zoomMode={zoomOf(node.id)}
                onSetZoom={m => setNodeZoom(prev => ({ ...prev, [node.id]: m }))}
                dbFile={dbFile}
                readEntries={readLayout?.byNode.get(node.node_name) ?? null}
                totalReads={readTotals[node.node_name]}
                truncated={(readTotals[node.node_name] ?? 0) > (rawAlignData?.[node.node_name]?.length ?? 0)}
                onNeedRegion={loadRegion}
                maxYRow={readLayout ? (readLayout.rowsByNode.get(node.node_name) ?? readLayout.maxYRow) : 0}
                flipped={flippedIds.has(node.id)}
                sampleColorMap={sampleColorMap}
                readFill={readFill}
                focusSamples={selectedSamples}
                sampleHighlight={sampleHighlight}
                selectedAln={effSelectedAln}
                onSelectAln={onSelectAln}
                tagColor={tagColorOf(node.node_name)}
                tagCount={selectedTags.filter(Boolean).length}
                linkColor={nodeColors.has(node.node_name) ? `#${nodeColors.get(node.node_name)!.toString(16).padStart(6, '0')}` : null}
                onExpand={() => onExpandNode(node.node_name)}
                onHeaderDragStart={() => setDragId(node.id)}
                onHeaderDragEnd={() => { setDragId(null); setDropHint(null) }}
                registerPileup={(svg, vp) => {
                  if (svg) pileupEls.current.set(node.id, { svg, vp })
                  else pileupEls.current.delete(node.id)
                }}
                onToggleTag={() => toggleTag(node.node_name)}
                onToggleFlip={() => onToggleFlip(node.id)}
                onRemove={() => onRemoveNode(node.id)}
              />
            ) : (
              <div style={{
                height: bandHeights[l], boxSizing: 'border-box',
                border: '1px dashed #e9ecef', borderRadius: 3, background: '#fcfcfd',
              }} />
            )}
            {/* ドロップ位置のヒント */}
            {hint === 'swap' && (
              <div style={{
                position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10,
                border: '2px solid #0c8599', background: 'rgba(12,133,137,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#0c8599', fontSize: 20, fontWeight: 700,
              }}>⇄</div>
            )}
            {hint === 'place' && (
              <div style={{
                position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10,
                border: '2px solid #0c8599', borderRadius: 3, background: 'rgba(12,133,137,0.10)',
              }} />
            )}
            {(hint === 'before' || hint === 'after') && (
              <div style={{
                position: 'absolute', left: 0, right: 0, height: 4, zIndex: 10,
                pointerEvents: 'none', background: '#0c8599',
                top: hint === 'before' ? -2 : undefined,
                bottom: hint === 'after' ? -2 : undefined,
              }} />
            )}
            </div>
            {/* 段(バンド l)の高さ調整ハンドル */}
            <div onMouseDown={e => startLaneResize(l, e)} title="段の高さを調整"
              style={{
                height: RESIZE_H, flexShrink: 0, cursor: 'ns-resize',
                background: '#dee2e6', transition: 'background 0.1s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7950f2' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#dee2e6' }}
            />
          </Fragment>
          )
        })}
        {/* ドラッグ中: 新しい段としてここへ配置 */}
        {dragId != null && (
          <div
            onDragOver={e => { e.preventDefault(); setDropHint(prev => prev && prev.col === c && prev.lane === maxLanes ? prev : { col: c, lane: maxLanes, mode: 'place' }) }}
            onDrop={e => { e.preventDefault(); onMoveNode(dragId, { kind: 'cell', col: c, lane: maxLanes }); setDragId(null); setDropHint(null) }}
            title="新しい段としてここに配置"
            style={{
              height: 14, cursor: 'copy',
              border: '1px dashed #0c8599', borderRadius: 3,
              background: dropHint?.col === c && dropHint.lane === maxLanes ? '#c3fae8' : '#e6fcf5',
            }}
          />
        )}
        {pendingNode && (
          <div onClick={() => onAddLane(c)} title="この列に段（アレル）を追加"
            style={{
              height: DROP_LANE_H, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '1px dashed #b197fc', borderRadius: 3, background: '#f3f0ff',
              color: '#7950f2', fontSize: 11, fontFamily: 'sans-serif',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#e5dbff' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#f3f0ff' }}
          >＋段</div>
        )}
      </div>
    )
  }

  // ドラッグ中に出す「列として挿入」ドロップ帯
  const dragging = dragId != null
  const columnDropZone = (index: number) => (
    <div key={`cdz-${index}`}
      onDragOver={e => { e.preventDefault(); if (dropHint) setDropHint(null) }}
      onDrop={e => { e.preventDefault(); if (dragId != null) onMoveNode(dragId, { kind: 'column', index }); setDragId(null); setDropHint(null) }}
      title="ここに新しい列として挿入"
      style={{
        alignSelf: 'stretch', width: DIVIDER_W + 6, flexShrink: 0,
        background: '#e7f5ff', border: '1px dashed #4dabf7', borderRadius: 3,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#d0ebff' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#e7f5ff' }}
    />
  )

  // グリッド本体: 列・段・ドロップスロット・リサイズ区切りを組み立て
  const gridChildren: React.ReactNode[] = []
  if (pendingNode) gridChildren.push(dropColumnSlot(0))
  else if (dragging) gridChildren.push(columnDropZone(0))
  row.columns.forEach((col, c) => {
    gridChildren.push(renderColumn(col, c))
    if (pendingNode) {
      gridChildren.push(dropColumnSlot(c + 1))
    } else if (dragging) {
      gridChildren.push(columnDropZone(c + 1))
    } else if (c < row.columns.length - 1) {
      gridChildren.push(
        <div key={`div-${c}`} onMouseDown={e => startResize(c, e)}
          title="ドラッグで列幅を調整"
          style={{
            alignSelf: 'stretch', width: DIVIDER_W, flexShrink: 0, cursor: 'col-resize',
            background: '#f1f3f5', transition: 'background 0.1s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#e5dbff' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#f1f3f5' }}
        />
      )
    }
  })

  return (
    <PaletteCtx.Provider value={cbSafe ? PALETTE_CB : PALETTE_DEFAULT}>
    <div style={{
      height: gridContentH, display: 'flex', flexDirection: 'column',
      borderBottom: '1px solid #dee2e6', background: '#fff', overflow: 'hidden',
      outline: isActive ? '2px solid #7950f2' : 'none',
      outlineOffset: -2,
    }}>
      {/* Main content: sidebar + grid */}
      <div style={{ height: gridContentH, display: 'flex', alignItems: 'stretch', minHeight: 0 }}>
        {/* Sidebar: controls */}
        <div style={{
          width: 58, flexShrink: 0,
          background: isActive ? '#f3f0ff' : '#f8f9fa',
          borderRight: '1px solid #dee2e6',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'flex-start', gap: 4, padding: '4px 0',
        }}>
          <button
            onClick={onToggleNodeAdd}
            title={isActive ? 'ノード追加モードをOFF' : 'ノード追加モードをON'}
            style={{
              fontFamily: 'sans-serif', fontSize: 11, padding: '2px 6px',
              border: '1px solid',
              borderColor: isActive ? '#7950f2' : '#adb5bd',
              borderRadius: 3,
              background: isActive ? '#7950f2' : '#fff',
              color: isActive ? '#fff' : '#495057',
              cursor: 'pointer',
              fontWeight: isActive ? 700 : 400,
            }}
          >
            node +
          </button>
          <button
            onClick={onRemoveRow}
            title="このビューを削除"
            style={{
              fontFamily: 'sans-serif', fontSize: 11, padding: '2px 6px',
              border: '1px solid #fa5252', borderRadius: 3,
              background: '#fff', color: '#fa5252', cursor: 'pointer',
            }}
          >
            削除
          </button>
          {/* 全ノードの縮尺ステッパー（−/＋ で ×10。個別はタイルヘッダで上書き）。列の −＋ と同じUI。 */}
          {(() => {
            const bi = ZOOM_ORDER.indexOf(boardZoom)
            const set = (i: number) => { setBoardZoom(ZOOM_ORDER[i]); setNodeZoom({}) }
            const bbtn = (dis: boolean) => ({
              fontFamily: 'sans-serif', fontSize: 12, lineHeight: 1, padding: '2px 6px',
              border: 'none', background: '#fff', color: dis ? '#ced4da' : '#495057',
              cursor: dis ? 'default' : 'pointer',
            } as const)
            return (
              <div title={`全ノードの縮尺: ${ZOOM_TITLE[boardZoom]}（現在値はノード上端のルーラー参照。個別はタイルのヘッダで変更）`}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontFamily: 'sans-serif', fontSize: 9, color: '#868e96', lineHeight: 1.4 }}>縮尺</span>
                <div style={{ display: 'flex', border: '1px solid #adb5bd', borderRadius: 3, overflow: 'hidden' }}>
                  <button onClick={() => set(bi - 1)} disabled={bi <= 0} title="縮小（×10）"
                    style={bbtn(bi <= 0)}>−</button>
                  <button onClick={() => set(bi + 1)} disabled={bi >= ZOOM_ORDER.length - 1} title="拡大（×10）"
                    style={{ ...bbtn(bi >= ZOOM_ORDER.length - 1), borderLeft: '1px solid #adb5bd' }}>＋</button>
                </div>
              </div>
            )
          })()}
          {/* コネクタ表示ON/OFF */}
          <button
            onClick={() => setShowConnectors(v => !v)}
            title={showConnectors ? 'コネクタ線を非表示' : 'コネクタ線を表示'}
            style={{
              fontFamily: 'sans-serif', fontSize: 10, padding: '2px 0', width: 50, marginTop: 2,
              border: '1px solid', borderColor: showConnectors ? '#1971c2' : '#adb5bd', borderRadius: 3,
              background: showConnectors ? '#1971c2' : '#fff',
              color: showConnectors ? '#fff' : '#495057', cursor: 'pointer',
            }}>
            線 {showConnectors ? 'ON' : 'OFF'}
          </button>
          {/* リードの縦位置。既定は上に詰める（縦が短い）。列をまたいで 1 本を目で追いたいときは
              「1本1段」にすると、同じリードが**全ノードで同じ高さ**に並ぶ（段は伸びる）。 */}
          <button
            onClick={() => setReadRows(m => m === 'packed' ? 'unique' : 'packed')}
            title={readRows === 'packed'
              ? 'リードを上に詰めています（縦が短い代わりに、同じリードでも列ごとに高さが変わります）。'
                + '押すと 1 リード 1 段になり、列をまたいで同じ高さに並びます'
              : '1 リード 1 段（全ノードで同じ高さ＝列をまたいで追える）。押すと上に詰める表示に戻ります'}
            style={{
              fontFamily: 'sans-serif', fontSize: 11, padding: '2px 6px', marginTop: 2,
              border: '1px solid', borderColor: readRows === 'unique' ? '#1971c2' : '#adb5bd',
              borderRadius: 3,
              background: readRows === 'unique' ? '#1971c2' : '#fff',
              color: readRows === 'unique' ? '#fff' : '#495057', cursor: 'pointer',
            }}>
            {readRows === 'unique' ? '1本1段' : '詰める'}
          </button>
          {/* mapq フィルタ: 空欄=マップの大域 mapq に追従、数値=このボードだけ上書き */}
          <input
            type="number" min={0} step={1}
            value={mapqInput}
            placeholder={globalMapq > 0 ? `≥${globalMapq}` : 'mapq≥'}
            title={mapqOverride != null
              ? `このボードのみ mapq≥${mapqOverride}（空欄にするとマップの mapq≥${globalMapq} に追従）`
              : `マップの mapq≥${globalMapq} に追従中（数値を入れるとこのボードだけ上書き）`}
            onChange={e => setMapqInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitMapq(mapqInput) }}
            onBlur={() => commitMapq(mapqInput)}
            style={{
              width: 50, marginTop: 2, padding: '2px 4px', boxSizing: 'border-box',
              fontFamily: 'sans-serif', fontSize: 10, textAlign: 'center',
              // 上書き=青、大域追従(有効)=緑、無効=灰
              border: `1px solid ${mapqOverride != null ? '#1971c2' : effMapq > 0 ? '#2f9e44' : '#adb5bd'}`,
              borderRadius: 3,
              background: mapqOverride != null ? '#e7f5ff' : effMapq > 0 ? '#ebfbee' : '#fff',
              color: mapqOverride != null ? '#1971c2' : effMapq > 0 ? '#2f9e44' : '#495057', outline: 'none',
            }}
          />
          {/* リード塗りモード（1ボタン循環）: 自動→鎖→[株]→灰 */}
          <button onClick={cycleFill} title={FILL_TITLE[readFill]}
            style={{
              width: 50, marginTop: 2, padding: '2px 0', boxSizing: 'border-box',
              fontFamily: 'sans-serif', fontSize: 10, cursor: 'pointer',
              border: `1px solid ${readFill === 'auto' ? '#adb5bd' : FILL_BG[readFill]}`,
              borderRadius: 3,
              background: readFill === 'auto' ? '#fff' : FILL_BG[readFill],
              color: readFill === 'auto' ? '#495057' : '#fff',
            }}>
            色:{FILL_LABEL[readFill]}
          </button>
          {/* 色覚対応パレット: 塩基(A/C/G/T)・鎖・変異色を CB-safe(青-橙軸+明度差)に切替。SVG 書き出しにも反映 */}
          <button onClick={() => setCbSafe(v => !v)}
            title={cbSafe ? '色覚対応パレット ON（塩基/鎖/変異色を CB-safe に）— クリックで慣習色へ' : '色覚対応パレット OFF（IGV 慣習色）— クリックで CB-safe へ'}
            style={{
              width: 50, marginTop: 2, padding: '2px 0', boxSizing: 'border-box',
              fontFamily: 'sans-serif', fontSize: 10, cursor: 'pointer',
              border: `1px solid ${cbSafe ? '#0072B2' : '#adb5bd'}`, borderRadius: 3,
              background: cbSafe ? '#0072B2' : '#fff', color: cbSafe ? '#fff' : '#495057',
            }}>
            CB:{cbSafe ? 'ON' : 'OFF'}
          </button>
          {/* 8.1 別ファイル SVG: 画面のアラインメントをそのままベクタ化 */}
          <button onClick={exportAlignPileup} title="今表示中のアラインメント（塩基/CIGAR/cs:Z・ノード跨ぎ線を含む）をそのまま SVG に書き出し（現ビューポート範囲）"
            style={{
              width: 50, marginTop: 2, padding: '2px 0', boxSizing: 'border-box',
              fontFamily: 'sans-serif', fontSize: 10, cursor: 'pointer',
              border: '1px solid #adb5bd', borderRadius: 3, background: '#fff', color: '#495057',
            }}>
            SVG
          </button>
          {/* 株フォーカス（複数サンプルあるとき）: 絞り込み↔強調 + サンプルチップ（任意の1〜複数を選択） */}
          {samples.length > 1 && (
            <>
              <div style={{ display: 'flex', border: '1px solid #adb5bd', borderRadius: 3, overflow: 'hidden', width: 50, marginTop: 2 }}>
                {([[false, '絞込'], [true, '強調']] as const).map(([hl, label], i) => (
                  <button key={label} onClick={() => setSampleHighlight(hl)}
                    title={hl ? '強調: 非選択サンプルを灰で残す' : '絞込: 非選択サンプルを非表示にする'}
                    style={{
                      flex: 1, fontFamily: 'sans-serif', fontSize: 9, padding: '2px 0',
                      border: 'none', borderLeft: i > 0 ? '1px solid #adb5bd' : 'none',
                      background: sampleHighlight === hl ? '#1971c2' : '#fff',
                      color: sampleHighlight === hl ? '#fff' : '#495057',
                      cursor: 'pointer',
                    }}>
                    {label}
                  </button>
                ))}
              </div>
              {/* サンプル選択チップ（複数選択可） */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center', maxWidth: 54, marginTop: 2 }}>
                {samples.map(sid => {
                  const color = sampleColorMap.get(sid) ?? '#999'
                  const active = selectedSamples === null || selectedSamples.has(sid)
                  return (
                    <div key={sid} title={sid} onClick={() => toggleSample(sid)} style={{
                      width: 11, height: 11, borderRadius: 2, cursor: 'pointer',
                      background: active ? color : '#dee2e6',
                      border: `1px solid ${active ? color : '#adb5bd'}`,
                    }} />
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* Grid (横スクロール) + コネクタオーバーレイ用の相対ラッパ */}
        <div ref={overlayWrapRef} style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <div ref={rowBodyRef} style={{
            display: 'flex', alignItems: 'flex-start', height: '100%',
            overflowX: 'auto', overflowY: 'hidden', padding: '1px 2px', gap: 0,
          }}>
            {row.columns.length === 0 ? (
              pendingNode ? (
                <div onClick={() => onInsertColumn(0)}
                  style={{
                    flex: 1, height: bandHeights[0], cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '2px dashed #b197fc', borderRadius: 4, background: '#f3f0ff',
                    color: '#7950f2', fontFamily: 'sans-serif', fontSize: 13,
                  }}>
                  ＋ ここに「{pendingNode.node_name}」を追加
                </div>
              ) : (
                // ★使い方はここ（空のビュー箱の中）だけに出す。ノードが入った時点で消えるので、
                //   スクリーンショットに説明文が写り込まない。
                //   「⠿ で並べ替え・段分けができる」は触ってみるまで分からないため必ず書く。
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'sans-serif', fontSize: 12 }}>
                  {isActive ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, color: '#7950f2' }}>
                      <span><b>①</b> グラフの葉ノード（n…）をクリック → 右へ並ぶ</span>
                      <span><b>②</b> <b style={{ color: '#0c8599' }}>⠿</b> を左右へドラッグ → 並べ替え</span>
                      <span><b>③</b> <b style={{ color: '#0c8599' }}>⠿</b> を列の上下へドラッグ → 段を分ける</span>
                    </div>
                  ) : (
                    <span style={{ color: '#ced4da' }}>node + でノードを追加</span>
                  )}
                </div>
              )
            ) : gridChildren}
          </div>
          {/* コネクタ線（スクロール容器の外に置き、ビューポート固定でDOM測定座標と一致させる） */}
          {connectors.length > 0 && (
            <svg style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              pointerEvents: 'none', zIndex: 5, overflow: 'hidden',
            }}>
              {/* 薄い灰線(faint)を先に、色付きを上に重ねる */}
              {[...connectors].sort((a, b) => Number(a.faint ? 0 : 1) - Number(b.faint ? 0 : 1)).map((l, i) => (
                <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                  stroke={l.color}
                  strokeWidth={l.faint ? 1 : 1.4}
                  strokeOpacity={l.faint ? 0.4 : 0.9}
                  strokeDasharray={l.dashed ? '3,2' : undefined} />
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
    </PaletteCtx.Provider>
  )
}

function NodeColumn({ node, headerH, bodyH, zoomMode, onSetZoom, dbFile, readEntries, totalReads, truncated, onNeedRegion, maxYRow, flipped, sampleColorMap, readFill, focusSamples, sampleHighlight, selectedAln, onSelectAln, tagColor, tagCount, linkColor, onExpand, onHeaderDragStart, onHeaderDragEnd, registerPileup, onToggleTag, onToggleFlip, onRemove }: {
  node: NodeData
  headerH: number
  bodyH: number
  zoomMode: ZoomMode
  onSetZoom: (m: ZoomMode) => void
  dbFile: string
  readEntries: LayoutEntry[] | null
  totalReads?: number   // backend が返す真の総リード数（端のみ取得時に総数が分かる）
  truncated?: boolean   // 端のみ取得済み（＝塩基レベル表示時に表示範囲を追加取得する対象）
  onNeedRegion?: (nodeName: string, start: number, end: number) => void
  maxYRow: number
  flipped: boolean
  sampleColorMap: Map<string, string>
  readFill: ReadFill
  focusSamples: Set<string> | null
  sampleHighlight: boolean
  selectedAln: number | null
  onSelectAln?: (alnId: number | null) => void
  tagColor: string | null   // 色分け選択時の自ノード色（未選択は null）
  tagCount: number          // 選択タグ総数（>0 でメンバーシップ色分け有効）
  linkColor?: string | null // マップ連動の対応色（ヘッダ枠に表示）
  onExpand?: () => void     // 共通aln_idノードを展開
  onHeaderDragStart?: () => void
  onHeaderDragEnd?: () => void
  registerPileup?: (svg: SVGSVGElement | null, vp: HTMLElement | null) => void
  onToggleTag: () => void
  onToggleFlip: () => void
  onRemove: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [sequence, setSequence] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const w = el.getBoundingClientRect().width || el.offsetWidth
    if (w > 0) setContainerW(w)
    const obs = new ResizeObserver(([e]) => setContainerW(e.contentRect.width))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onScroll() { setScrollLeft(el!.scrollLeft) }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useDragScroll(scrollRef)

  // 反転トグル時: 同じbp範囲が見えるようスクロール位置をミラーリング
  const flipMounted = useRef(false)
  useEffect(() => {
    if (!flipMounted.current) { flipMounted.current = true; return }
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, el.scrollWidth - el.scrollLeft - el.clientWidth)
  }, [flipped])

  // 塩基が見える縮尺(≥1px/bp)のときだけ配列をfetch（概観・粗い縮尺では不要）
  useEffect(() => {
    const p = PX_PER_BP[zoomMode]
    if (p === null || p < 1) { setSequence(null); return }
    let cancelled = false
    fetchNodeSequence(dbFile, node.node_name).then(seq => {
      if (!cancelled) setSequence(seq)
    })
    return () => { cancelled = true }
  }, [dbFile, node.node_name, zoomMode])

  const lvlPx = PX_PER_BP[zoomMode]
  const fitW = Math.max(containerW, MIN_COL_PX)
  const isFit = lvlPx === null
  const detail = lvlPx != null && lvlPx >= 1   // ≥1px/bp(レベル)＝塩基表示
  const pxPerBp = isFit ? null : lvlPx
  // 概観/粗い縮尺(塩基なし)は列幅いっぱいに引き伸ばす（fitと同様、ノードが列幅未満でも余白を作らない）。
  // 塩基表示(detail)のときだけ本来幅(MIN_COL_PX下限)＝塩基サイズを列間で揃える（引き伸ばさない）。
  const contentW = isFit ? fitW
    : detail ? Math.max(node.size * lvlPx!, MIN_COL_PX)
    : Math.max(node.size * lvlPx!, fitW)

  // ルーラーで選んだ bp 範囲にズーム（このノード列のみ）。レベルを選び、選択範囲を中央寄せでスクロール。
  // ズーム変更で contentW が変わってから位置を当てるため、pending に積んで useLayoutEffect で適用。
  const pendingZoomScroll = useRef<{ lo: number; hi: number } | null>(null)
  const applyRangeScroll = (lo: number, hi: number, cW: number) => {
    const el = scrollRef.current
    if (!el || node.size <= 0 || cW <= 0) return
    const center = ((lo + hi) / 2) / node.size * cW
    let eff = center - containerW / 2
    eff = Math.max(0, Math.min(Math.max(0, cW - containerW), eff))   // eff = 可視左端の非反転content座標
    el.scrollLeft = flipped ? Math.max(0, cW - eff - containerW) : eff
  }
  const onZoomRange = (lo: number, hi: number) => {
    const level = pickZoomLevel(hi - lo, Math.max(1, containerW), node.size)
    if (level === zoomMode) applyRangeScroll(lo, hi, contentW)   // 同レベル→パンのみ
    else { pendingZoomScroll.current = { lo, hi }; onSetZoom(level) }
  }
  useLayoutEffect(() => {
    const p = pendingZoomScroll.current
    if (!p) return
    pendingZoomScroll.current = null
    applyRangeScroll(p.lo, p.hi, contentW)
  // contentW（=ズーム適用後の新しい幅）が確定してから位置を当てる
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomMode, contentW])

  // 端のみ取得した巨大ノードを十分拡大したとき(≒10bp/px以上＝可視範囲が手頃)、表示範囲(±2画面)の
  // リードを追加取得。粗い縮尺(概観〜100bp/px)では取得しない（可視リードが多すぎるため／変異は
  // 事前計算トラックで表示）。スクロール/ズームで再評価しデバウンス。
  const onNeedRegionRef = useRef(onNeedRegion); onNeedRegionRef.current = onNeedRegion
  useEffect(() => {
    if (!truncated || pxPerBp === null || pxPerBp < 0.1 || contentW <= 0 || containerW <= 0 || node.size <= 0) return
    const eff = flipped ? Math.max(0, contentW - scrollLeft - containerW) : scrollLeft
    const margin = containerW * 2   // 表示の左右に2画面ぶん先読み
    const vs = Math.max(0, (eff - margin) / contentW * node.size)
    const ve = Math.min(node.size, (eff + containerW + margin) / contentW * node.size)
    const t = setTimeout(() => onNeedRegionRef.current?.(node.node_name, vs, ve), 200)
    return () => clearTimeout(t)
  }, [truncated, zoomMode, contentW, containerW, scrollLeft, flipped, node.node_name, node.size])

  // ヘッダ要素の優先度別表示。列が狭いほど低優先度から落とす。
  // 残す優先度(高→低): ドラッグ/色(常時) > ×(常時) > 反転 > 展開 > 概観切替 > サイズ。名前は常時(省略表示)。
  const hw = containerW || 9999   // 未測定(0)時は全表示
  const showFlip   = hw >= 100
  const showExpand = hw >= 120
  const showZoom   = hw >= 175
  const showSize   = hw >= 225

  return (
    <div style={{
      width: '100%', height: headerH + bodyH, flexShrink: 0,
      display: 'flex', flexDirection: 'column',
      border: '1px solid #dee2e6', borderRadius: 3, overflow: 'hidden',
    }}>
      {/* Header */}
      <div data-node-hdr={node.node_name} style={{
        height: headerH, flexShrink: 0,
        background: tagColor ? `${tagColor}22` : linkColor ? `${linkColor}1f` : '#e9ecef',
        borderBottom: '1px solid #dee2e6',
        borderTop: tagColor ? `2px solid ${tagColor}` : '2px solid transparent',
        borderLeft: linkColor ? `6px solid ${linkColor}` : undefined,
        display: 'flex', alignItems: 'center', gap: 3, padding: linkColor ? '0 4px 0 2px' : '0 4px', minWidth: 0,
      }}>
        {/* ドラッグハンドル（移動・入替） */}
        <span draggable
          onDragStart={e => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.node_name)
            // onDragStart 内で即 state 更新するとDOM書換でドラッグが中断するため一拍遅らせる
            setTimeout(() => onHeaderDragStart?.(), 0)
          }}
          onDragEnd={() => onHeaderDragEnd?.()}
          title="ドラッグして移動・入替"
          style={{ flexShrink: 0, cursor: 'grab', color: '#0c8599', fontSize: 12, lineHeight: 1, userSelect: 'none' }}>
          ⠿
        </span>
        {/* 色分け選択トグル */}
        <button onClick={onToggleTag}
          title={tagColor ? 'このノードの色分け選択を解除' : 'このノードで色分け（通るリードを着色）'}
          style={{
            width: 12, height: 12, flexShrink: 0, cursor: 'pointer', padding: 0,
            borderRadius: 3, border: `1px solid ${tagColor ?? '#adb5bd'}`,
            background: tagColor ?? '#fff',
          }} />
        <span style={{
          fontFamily: 'monospace', fontSize: 11, color: '#343a40',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
        }}>
          {node.node_name}
        </span>
        {showSize && (
          <span style={{ fontFamily: 'sans-serif', fontSize: 10, color: '#868e96', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {node.size >= 1e6
              ? `${(node.size / 1e6).toFixed(1)}M`
              : node.size >= 1000
              ? `${(node.size / 1000).toFixed(1)}k`
              : node.size} bp
          </span>
        )}
        {/* このノードの縮尺ステッパー（−/＋ で ×10 単位、ラベルは bp/px の短縮） */}
        {showZoom && (() => {
          const steps = validZoomSteps(node.size)
          const cur: ZoomMode = isFit ? 'fit' : zoomMode
          const ci = Math.max(0, steps.indexOf(cur))
          const zbtn = (dis: boolean) => ({
            fontFamily: 'sans-serif', fontSize: 11, lineHeight: 1, padding: '1px 4px',
            border: 'none', background: '#fff', color: dis ? '#ced4da' : '#495057',
            cursor: dis ? 'default' : 'pointer',
          } as const)
          return (
            <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, border: '1px solid #ced4da', borderRadius: 3, overflow: 'hidden' }}>
              <button onClick={() => onSetZoom(stepZoom(cur, -1, steps))} disabled={ci <= 0}
                title="縮小（×10）" style={zbtn(ci <= 0)}>−</button>
              <span style={{ fontFamily: 'sans-serif', fontSize: 9, padding: '0 2px', color: '#495057', minWidth: 16, textAlign: 'center', borderLeft: '1px solid #ced4da', borderRight: '1px solid #ced4da' }}
                title={ZOOM_TITLE[cur]}>{ZOOM_SHORT[cur]}</span>
              <button onClick={() => onSetZoom(stepZoom(cur, 1, steps))} disabled={ci >= steps.length - 1}
                title="拡大（×10）" style={zbtn(ci >= steps.length - 1)}>＋</button>
            </div>
          )
        })()}
        {showExpand && (
          <button onClick={onExpand} title="共通aln_idのノードを展開（関連ノードを追加）"
            style={{ border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0,
              color: '#0c8599', fontSize: 13, lineHeight: 1, padding: '0 2px' }}>
            ⤢
          </button>
        )}
        {showFlip && (
          <button onClick={onToggleFlip} title="左右反転"
            style={{ border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0,
              fontSize: 12, lineHeight: 1, padding: '0 2px',
              color: flipped ? '#7950f2' : '#adb5bd', fontWeight: flipped ? 700 : 400 }}>
            ⇄
          </button>
        )}
        <button onClick={onRemove} title="ノードを削除"
          style={{ border: 'none', background: 'none', cursor: 'pointer',
            color: '#adb5bd', fontSize: 12, lineHeight: 1, padding: '0 1px', flexShrink: 0 }}>
          ×
        </button>
      </div>

      {/* Scrollable body */}
      <div ref={scrollRef} style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', cursor: 'grab' }}>
        <NodeBody
          node={node}
          contentW={contentW}
          height={bodyH}
          pxPerBp={pxPerBp ?? contentW / node.size}
          levelPx={lvlPx}
          onZoomRange={onZoomRange}
          scrollLeft={scrollLeft}
          visibleW={containerW}
          sequence={sequence}
          zoomMode={zoomMode}
          readEntries={readEntries}
          totalReads={totalReads}
          maxYRow={maxYRow}
          flipped={flipped}
          sampleColorMap={sampleColorMap}
          readFill={readFill}
          focusSamples={focusSamples}
          sampleHighlight={sampleHighlight}
          selectedAln={selectedAln}
          onSelectAln={onSelectAln}
          tagCount={tagCount}
          pileupSvgRef={el => registerPileup?.(el, scrollRef.current)}
          outerScrollRef={scrollRef}
          dbFile={dbFile}
        />
      </div>
    </div>
  )
}

const SAMPLE_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b',
  '#cc5de8', '#ff922b', '#20c997', '#f06595',
  '#74c0fc', '#ffa8a8', '#8ce99a', '#ffec99',
]

// メンバーシップ色分け用（選択ノードの色）。Okabe-Ito（色覚バリアフリー）から黒を除いた7色。
// 既存の挙動に合わせ、青→朱(赤)を先頭に並べ替えて選択順に割当。
const TAG_COLORS = [
  '#0072b2', // blue
  '#d55e00', // vermillion (red)
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#e69f00', // orange
  '#56b4e9', // sky blue
  '#f0e442', // yellow
]
const TAG_GREY = '#ced4da'   // どの選択ノードも通らないリード
const MUTED    = '#c4ccd6'   // 灰モード／株フォーカス強調で目立たせないリード
const READ_HILITE = '#f08c00'   // 選択/検索した1リードの強調色（灰の海で目立つ）

const FILL_LABEL: Record<ReadFill, string> = { auto: '自動', strand: '鎖', sample: '株', muted: '灰' }
const FILL_TITLE: Record<ReadFill, string> = {
  auto:   'リード色: 自動（タグ選択時はメンバーシップ色／株フォーカス時はサンプル色／それ以外はストランド色）。クリックで切替',
  strand: 'リード色: ストランド（タグ選択を無視して +/− で色分け）。クリックで切替',
  sample: 'リード色: サンプル別。クリックで切替',
  muted:  'リード色: 灰（ミスマッチ・挿入欠失マークを見やすく）。クリックで切替',
}
const FILL_BG: Record<ReadFill, string> = { auto: '#1971c2', strand: '#1971c2', sample: '#1971c2', muted: '#868e96' }

const BASE_COLORS: Record<string, string> = {
  A: '#4caf50',
  C: '#2196f3',
  G: '#ff9800',
  T: '#f44336',
}
const BASES = ['A', 'C', 'G', 'T']

// 塩基/鎖/変異の配色。既定は IGV 慣習色（A緑/C青/G橙/T赤）。色覚対応(cbSafe)は
// Okabe-Ito 由来で「青系(A暗/C明) vs 橙系(G明/T暗)」＝色覚多様性で安全な青-橙軸＋明度差で 4 塩基を分離。
// これは NodeBody 経由で塩基レベル描画・参照配列トラック・変異色・鎖色に効き、SVG 書き出しにもそのまま乗る。
export interface AlignPalette {
  base: Record<string, string>   // A/C/G/T
  strandPlus: string; strandMinus: string
  mismatch: string               // cs 無し時のミスマッチ既定色
  del: string; ins: string
}
const PALETTE_DEFAULT: AlignPalette = {
  base: { A: '#4caf50', C: '#2196f3', G: '#ff9800', T: '#f44336' },
  strandPlus: '#4a9eff', strandMinus: '#ff6b6b',
  mismatch: '#e03131', del: '#7048e8', ins: '#f76707',
}
const PALETTE_CB: AlignPalette = {
  base: { A: '#0072B2', C: '#56B4E9', G: '#E69F00', T: '#D55E00' },
  strandPlus: '#0072B2', strandMinus: '#D55E00',
  mismatch: '#D55E00', del: '#CC79A7', ins: '#009E73',
}
const PaletteCtx = createContext<AlignPalette>(PALETTE_DEFAULT)

// cs:Z の置換（*ab）だけを node-local ref 位置とともに取り出す。pos=node_start からの ref オフセット。
interface CsSub { pos: number; alt: string }
function parseCsSubs(cs: string): CsSub[] {
  const subs: CsSub[] = []
  let ref = 0
  for (const m of cs.matchAll(/:(\d+)|\*([a-zA-Z])([a-zA-Z])|([+-])([a-zA-Z]+)/g)) {
    if (m[1] != null) ref += parseInt(m[1])                              // :N  一致
    else if (m[2] != null) { subs.push({ pos: ref, alt: m[3].toUpperCase() }); ref += 1 }  // *ab 置換
    else if (m[4] === '-') ref += m[5].length                            // -seq 欠失(refを消費)
    // '+seq' 挿入は ref を消費しない
  }
  return subs
}

// cs:Z の挿入（+seq）を node-local ref 位置とともに取り出す。pos=挿入が入る ref オフセット, seq=挿入塩基。
interface CsIns { pos: number; seq: string }
// 置換と挿入を1パスで取り出す（readGlyphs 用。cs を2回正規表現走査しないため）。
function parseCs(cs: string): { subs: CsSub[]; ins: CsIns[] } {
  const subs: CsSub[] = [], ins: CsIns[] = []
  let ref = 0
  for (const m of cs.matchAll(/:(\d+)|\*([a-zA-Z])([a-zA-Z])|([+-])([a-zA-Z]+)/g)) {
    if (m[1] != null) ref += parseInt(m[1])
    else if (m[2] != null) { subs.push({ pos: ref, alt: m[3].toUpperCase() }); ref += 1 }   // *ab 置換
    else if (m[4] === '-') ref += m[5].length                                                 // -seq 欠失
    else if (m[4] === '+') ins.push({ pos: ref, seq: m[5].toUpperCase() })                    // +seq 挿入
  }
  return { subs, ins }
}
// 挿入塩基が均一ならその塩基色、混在なら橙。
function insColor(seq: string, pal: AlignPalette): string {
  const u = seq.toUpperCase()
  return u.length > 0 && [...u].every(c => c === u[0]) ? (pal.base[u[0]] ?? pal.ins) : pal.ins
}

// 詳細ズーム用: 取得済みリードの CIGAR(X/I/D)から、表示範囲 [start,end] を nbins ビンに厳密集計
// （事前計算の100bpより細かい）。塩基加重 cov / mm/del(塩基数) / ins(件数) を鎖別に。
// cs:Z があればビン×鎖の置換 alt 塩基もカウントし、最頻塩基(domf/domr)を求める（鎖別ドミナント塩基）。
function varTrackFromReads(reads: LayoutEntry[], start: number, end: number, nbins: number): VariantTrack {
  const span = Math.max(1, end - start), outW = span / nbins
  const mk = () => new Array(nbins).fill(0)
  const cov = mk(), mmf = mk(), mmr = mk(), insf = mk(), insr = mk(), delf = mk(), delr = mk()
  // ビン×鎖の塩基別カウント [A,C,G,T]（cs の置換から。ドミナント塩基算出用）
  const bcF = Array.from({ length: nbins }, () => [0, 0, 0, 0])
  const bcR = Array.from({ length: nbins }, () => [0, 0, 0, 0])
  const BASE_IDX: Record<string, number> = { A: 0, C: 1, G: 2, T: 3 }
  const addSpan = (arr: number[], a: number, b: number) => {   // [a,b) を node 座標で配分
    const s = Math.max(a, start), e = Math.min(b, end); if (e <= s) return
    const b0 = Math.max(0, Math.floor((s - start) / outW)), b1 = Math.min(nbins - 1, Math.floor((e - 1e-9 - start) / outW))
    for (let k = b0; k <= b1; k++) {
      const lo = Math.max(s, start + k * outW), hi = Math.min(e, start + (k + 1) * outW)
      if (hi > lo) arr[k] += (hi - lo)
    }
  }
  let hasCs = false
  for (const r of reads) {
    if (r.node_end <= start || r.node_start >= end) continue
    const rev = r.strand === '-'
    addSpan(cov, r.node_start, r.node_end)
    if (r.cigar) {
      const mm = rev ? mmr : mmf, de = rev ? delr : delf, ins = rev ? insr : insf
      for (const op of parseCigar(r.cigar)) {
        if (op.op === 'X') addSpan(mm, r.node_start + op.refStart, r.node_start + op.refEnd)
        else if (op.op === 'D') addSpan(de, r.node_start + op.refStart, r.node_start + op.refEnd)
        else if (op.op === 'I') {
          const p = r.node_start + op.refStart
          if (p >= start && p < end) { const k = Math.min(nbins - 1, Math.floor((p - start) / outW)); ins[k] += 1 }
        }
      }
    }
    if (r.cs) {                          // 置換の alt 塩基をビン×鎖にカウント
      const bc = rev ? bcR : bcF
      for (const sub of parseCsSubs(r.cs)) {
        const p = r.node_start + sub.pos
        if (p < start || p >= end) continue
        const bi = BASE_IDX[sub.alt]; if (bi == null) continue
        hasCs = true
        bc[Math.min(nbins - 1, Math.floor((p - start) / outW))][bi]++
      }
    }
  }
  const dom = (counts: number[][]) => counts.map(c => {
    let bi = -1, n = 0
    for (let i = 0; i < 4; i++) if (c[i] > n) { n = c[i]; bi = i }
    return bi < 0 ? '' : 'ACGT'[bi]
  })
  const out: VariantTrack = { has: true, start, end, binw: outW, nbins, cov, mmf, mmr, insf, insr, delf, delr }
  if (hasCs) { out.domf = dom(bcF); out.domr = dom(bcR) }
  return out
}

const READ_ROW_H: Record<ZoomMode, number> = { fit: 4, '1kbp': 4, '100bp': 4, '10bp': 5, '1bp': 7, base: 12 }

interface CigarOp { op: string; refStart: number; refEnd: number }

function parseCigar(s: string): CigarOp[] {
  const ops: CigarOp[] = []
  let ref = 0
  for (const m of s.matchAll(/(\d+)([MIDNSHPX=])/g)) {
    const len = parseInt(m[1]); const op = m[2]
    const refLen = 'MDN=X'.includes(op) ? len : 0
    ops.push({ op, refStart: ref, refEnd: ref + refLen })
    ref += refLen
  }
  return ops
}

const VAR_BINS = 160   // 変異密度トラックの横解像度（ノード幅を等分するビン数）
const VAR_H = 26       // 変異密度トラックの高さ(px)

function NodeBody({ node, contentW, height, pxPerBp, levelPx, onZoomRange, scrollLeft, visibleW, sequence, zoomMode, readEntries, totalReads, maxYRow, flipped, sampleColorMap, readFill, focusSamples, sampleHighlight, selectedAln, onSelectAln, tagCount, pileupSvgRef, outerScrollRef, dbFile }: {
  node: NodeData; contentW: number; height: number; dbFile: string
  pxPerBp: number; levelPx: number | null; scrollLeft: number; visibleW: number
  onZoomRange?: (bpLo: number, bpHi: number) => void
  sequence: string | null; zoomMode: ZoomMode
  readEntries: LayoutEntry[] | null; totalReads?: number; maxYRow: number
  flipped: boolean
  sampleColorMap: Map<string, string>
  readFill: ReadFill
  focusSamples: Set<string> | null
  sampleHighlight: boolean
  selectedAln: number | null
  onSelectAln?: (alnId: number | null) => void
  tagCount: number
  pileupSvgRef?: (el: SVGSVGElement | null) => void
  outerScrollRef: React.RefObject<HTMLDivElement>
}) {
  const palette = useContext(PaletteCtx)
  const pileupRef = useRef<HTMLDivElement>(null)
  // スクロールバーが現れると clientWidth が縮小するため ResizeObserver で追跡
  const [pileupClientW, setPileupClientW] = useState(contentW)
  useEffect(() => {
    const el = pileupRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPileupClientW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // パイルアップ領域のドラッグスクロール（縦: pileup内、横: 外側コンテナ）
  const draggedRef = useRef(false)   // 直近の mousedown～up で実ドラッグが起きたか（クリック選択と区別）
  useEffect(() => {
    const el = pileupRef.current
    if (!el) return
    let dragging = false, startX = 0, startY = 0, startSL = 0, startST = 0
    function onMouseDown(e: MouseEvent) {
      dragging = true; draggedRef.current = false
      startX = e.clientX; startY = e.clientY
      startSL = outerScrollRef.current?.scrollLeft ?? 0
      startST = el!.scrollTop
      e.stopPropagation()   // 外側の横ドラッグを発火させない
      e.preventDefault()
    }
    function onMouseMove(e: MouseEvent) {
      if (!dragging) return
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) draggedRef.current = true
      el!.scrollTop  = startST + (startY - e.clientY)
      if (outerScrollRef.current)
        outerScrollRef.current.scrollLeft = startSL + (startX - e.clientX)
    }
    function onMouseUp() { dragging = false }
    el.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [outerScrollRef])

  // seqPxPerBp: 実際の描画縮尺(px/bp)。小ノードは fit でも実効縮尺が高い（5bp が列幅いっぱい等）ので、
  // 「fitかどうか」ではなく実効 px/bp で詳細表示(塩基/per-readマーク)を判定する。
  const seqPxPerBp = contentW / node.size
  // detail は「選んだズームレベル」で判定（実効px/bpではない）。小ノードが MIN_COL_PX 下限で
  // 実効縮尺が高くなっても、ボード倍率が概観なら全列で概観＝トラック構成・高さを揃える。
  const detail = levelPx != null && levelPx >= 1   // ≥1px/bp(レベル) → 塩基・per-read詳細
  const showBases = detail
  const SEQ_H   = showBases ? 16 : 0   // 固定高さ（列間で配列トラックの高さを揃え、行をずらさない）
  const RULER_H = 14
  // restH: pileupDiv（sequence+reads を含む縦スクロール容器）の高さ
  const restH   = Math.max(0, height - RULER_H)
  const showText = seqPxPerBp >= 8

  // SVG flip transform: mirror horizontally around contentW/2
  const flipTransform = flipped ? `scale(-1,1) translate(-${contentW},0)` : undefined

  // 反転時はスクロール位置をグループローカル座標に変換。
  // flip後は可視グループローカルx範囲が [contentW-scrollLeft-visibleW, contentW-scrollLeft] になる。
  const effScrollLeft = flipped ? Math.max(0, contentW - scrollLeft - visibleW) : scrollLeft

  const ticks   = makeTicks(contentW, node.size, effScrollLeft, visibleW)

  // ルーラー上のドラッグで範囲ズーム（一般的なゲノムブラウザのスケールバー操作）。
  // svg 生 x（= e.clientX - rulerRect.left ＝スクロール込みの content 座標）→ bp は flip を考慮。
  const rulerRef = useRef<SVGSVGElement>(null)
  const [rulerSel, setRulerSel] = useState<{ x0: number; x1: number } | null>(null)
  const rulerSelRef = useRef<{ x0: number; x1: number } | null>(null)
  const xToBp = (rawX: number) => {
    const frac = Math.max(0, Math.min(1, contentW > 0 ? rawX / contentW : 0))
    return (flipped ? 1 - frac : frac) * node.size
  }
  function onRulerDown(e: React.MouseEvent) {
    if (!onZoomRange || node.size <= 0) return
    const svg = rulerRef.current; if (!svg) return
    e.preventDefault(); e.stopPropagation()
    const rect = svg.getBoundingClientRect()
    const x0 = e.clientX - rect.left
    const init = { x0, x1: x0 }
    rulerSelRef.current = init; setRulerSel(init)
    const move = (ev: MouseEvent) => {
      const s = { x0, x1: Math.max(0, Math.min(contentW, ev.clientX - rect.left)) }
      rulerSelRef.current = s; setRulerSel(s)
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      const s = rulerSelRef.current; rulerSelRef.current = null; setRulerSel(null)
      if (!s || Math.abs(s.x1 - s.x0) < 3) return    // クリック相当は無視
      // このルーラーの外でドロップしたらキャンセル（pileup や他列に外したとき）
      const over = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null
      if (!over || over.closest('[data-ruler]') !== rulerRef.current) return
      const a = xToBp(s.x0), b = xToBp(s.x1)
      const lo = Math.min(a, b), hi = Math.max(a, b)
      if (hi - lo >= 1) onZoomRange!(lo, hi)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  // 可視範囲 + 前後1倍分を先読み（合計3倍範囲）
  const startBase = showBases
    ? Math.max(0, Math.floor((effScrollLeft - visibleW) / seqPxPerBp))
    : 0
  const endBase = showBases
    ? Math.min(node.size, Math.ceil((effScrollLeft + visibleW * 2) / seqPxPerBp))
    : 0

  // Strand colors (swapped when flipped)
  const colorPlus  = flipped ? palette.strandMinus : palette.strandPlus
  const colorMinus = flipped ? palette.strandPlus : palette.strandMinus

  // メンバーシップ色分け
  const membershipActive = tagCount > 0
  const hatchId = (sig: number[]) => `hatch-${sig[0]}-${sig[1]}`
  // 重なり署名（≥2タグ）のペア集合 → <pattern> defs を生成
  const overlapPairs = new Set<string>()
  if (membershipActive && readEntries) {
    for (const e of readEntries) if (e.sig.length >= 2) overlapPairs.add(`${e.sig[0]}-${e.sig[1]}`)
  }
  const focusActive = focusSamples != null
  const strandColor = (e: LayoutEntry) => (e.strand === '+' ? colorPlus : colorMinus)
  const sampColor   = (e: LayoutEntry) => (e.sample_id && sampleColorMap.get(e.sample_id)) || strandColor(e)
  function readColor(e: LayoutEntry): string {
    // 選択/検索リードの強調が最優先: 当該 aln_id を強調色、他は一時的に灰（解除で従来塗りに戻る）
    if (selectedAln != null) return e.aln_id === selectedAln ? READ_HILITE : MUTED
    // 株フォーカス強調: 非選択サンプルは灰で残す（絞り込みモードでは既にレイアウトから除外済み）
    if (focusActive && sampleHighlight && !(e.sample_id != null && focusSamples!.has(e.sample_id))) return MUTED
    if (readFill === 'muted')  return MUTED
    if (readFill === 'strand') return strandColor(e)
    if (readFill === 'sample') return sampColor(e)
    // auto: フォーカス中はサンプル別色で区別 → タグ選択時はメンバーシップ色 → 既定はストランド色
    if (focusActive) return sampColor(e)
    if (membershipActive) {
      if (e.sig.length === 0) return TAG_GREY
      if (e.sig.length === 1) return TAG_COLORS[e.sig[0] % TAG_COLORS.length]
      return `url(#${hatchId(e.sig)})`
    }
    return strandColor(e)
  }

  // 端のみ取得(巨大ノード)では readEntries は端リードだけ。total=真の総数, truncated=端のみ取得済み。
  const fetched = readEntries?.length ?? 0
  const total = totalReads ?? fetched
  const truncated = total > fetched   // backend が端リードだけ返した
  // 概観でリードが多すぎるとき: 全リードは描かず、他ノードと aln_id を共有するリード(_shared)だけ
  // を上部に描き、下にカバレージ帯(cov_hist)を出す。判定は真の総数 total で行う。
  const tooMany = !!(readEntries && !detail && total > 1000)
  const renderEntries = tooMany && readEntries
    ? readEntries.filter(e => e._shared)
    : readEntries
  const sharedRows = tooMany
    ? (renderEntries ?? []).reduce((m, e) => Math.max(m, e.y_row + 1), 0)
    : 0

  // 変異密度トラック: 表示範囲 [vs,ve] を ≒1px/ビンで集計。
  //  - 詳細ズーム(リード取得済み)では取得済みリードから「厳密に」集計（事前計算100bpより細かい）。
  //  - それ以外(概観〜中縮尺)は事前計算プロファイル(/variant_track)をフェッチ（全リード取得不要）。
  const viewRange = useMemo(() => {
    if (node.size <= 0 || contentW <= 0) return null
    const eff = flipped ? Math.max(0, contentW - scrollLeft - visibleW) : scrollLeft
    const pad = visibleW * 0.5
    const vs = Math.max(0, (eff - pad) / contentW * node.size)
    const ve = Math.min(node.size, (eff + visibleW + pad) / contentW * node.size)
    const nbins = Math.max(1, Math.min(2000, Math.round((ve - vs) / node.size * contentW)))
    return { vs, ve, nbins }
  }, [node.size, contentW, scrollLeft, visibleW, flipped])
  // 詳細(≥10bp/px)かつリードあり → クライアントで厳密集計
  const clientVarData = useMemo(() => {
    // リード取得済みのレベル(≥0.1px/bp=10bp/px以上)なら、取得済みリードから厳密集計。
    // それ以外（概観〜中縮尺）は事前計算プロファイルを使う（列間で整合）。
    if (levelPx == null || levelPx < 0.1 || !readEntries || !viewRange) return null
    return varTrackFromReads(readEntries, viewRange.vs, viewRange.ve, viewRange.nbins)
  }, [levelPx, readEntries, viewRange])
  const [fetchedVarData, setFetchedVarData] = useState<VariantTrack | null>(null)
  useEffect(() => {
    if (clientVarData || !viewRange) return   // 詳細はクライアント計算を使うのでフェッチ不要
    let cancelled = false
    const { vs, ve, nbins } = viewRange
    const t = setTimeout(() => {
      fetchVariantTrack(dbFile, node.node_name, vs, ve, nbins).then(d => { if (!cancelled) setFetchedVarData(d) })
    }, 150)
    return () => { cancelled = true; clearTimeout(t) }
  }, [clientVarData, viewRange, dbFile, node.node_name])
  const varData = clientVarData ?? fetchedVarData
  // 変異トラックは常に高さを確保（データが無い/少ない列でも空で予約し、列間で行をずらさない）。
  const varH = VAR_H

  // 変異トラックの矩形をメモ化。上=+鎖, 下=−鎖のミラー。棒の高さ=変異率(変異塩基/被覆塩基)を
  // 表示範囲内の最大値で正規化。欠失=紫 挿入=橙。ミスマッチは詳細ズームでは鎖別ドミナント塩基の色
  // (BASE_COLORS)で塗る（cs:Z 由来。domf/domr が無い概観では赤）。bin は node 座標に配置。
  const varBars = useMemo(() => {
    if (!varData || varData.nbins <= 0) return null
    const half = VAR_H / 2 - 1
    const span = Math.max(1, varData.end - varData.start)
    const bw = span / varData.nbins   // node 座標でのビン幅（描画時に scale で px へ。contentW非依存）
    let maxRate = 0
    for (let b = 0; b < varData.nbins; b++) {
      const c = varData.cov[b]; if (c <= 0) continue
      const v = varData.mmf[b] + varData.mmr[b] + varData.insf[b] + varData.insr[b] + varData.delf[b] + varData.delr[b]
      const r = v / c; if (r > maxRate) maxRate = r
    }
    if (maxRate <= 0) return null
    const out: JSX.Element[] = []
    for (let b = 0; b < varData.nbins; b++) {
      const c = varData.cov[b]; if (c <= 0) continue
      const bx = varData.start + b * span / varData.nbins   // node 座標
      for (let s = 0; s < 2; s++) {
        const mm = s === 0 ? varData.mmf[b] : varData.mmr[b]
        const del = s === 0 ? varData.delf[b] : varData.delr[b]
        const ins = s === 0 ? varData.insf[b] : varData.insr[b]
        const dom = s === 0 ? varData.domf?.[b] : varData.domr?.[b]   // 鎖別ドミナント alt 塩基
        const mmColor = dom ? (palette.base[dom] ?? palette.mismatch) : palette.mismatch
        let acc = 0, oi = 0
        for (const [cnt, color, base] of [[mm, mmColor, dom || ''], [del, palette.del, ''], [ins, palette.ins, '']] as [number, string, string][]) {
          oi++
          if (cnt <= 0) continue
          const h = (cnt / c) / maxRate * half
          if (h <= 0) continue
          const y0 = s === 0 ? VAR_H / 2 - acc - h : VAR_H / 2 + acc
          out.push(
            <rect key={`${b}-${s}-${oi}`} x={bx} y={y0} width={bw} height={h} fill={color}>
              {base ? <title>{`${base} 優勢（${s === 0 ? '+' : '−'}鎖 置換）`}</title> : null}
            </rect>
          )
          acc += h
        }
      }
    }
    return out
  // node 座標で作るので contentW/node.size には非依存（列幅調整で作り直さない）。
  }, [varData, palette])

  // リードグリフ部分木をメモ化する。依存に height / restH / totalPileupH を含めないので、
  // view の高さを変えても同じ配列（＝各 <g> 要素の参照）が再利用され、React は数千の
  // リード要素の再 reconcile をスキップする（高さドラッグ時の再描画負荷を除去）。
  // 横スクロール(effScrollLeft)・幅(contentW)・色・ズーム変更では従来通り作り直す。
  const readRowH = detail ? READ_ROW_H[zoomMode] : READ_ROW_H.fit
  const readGlyphs = useMemo(() => {
    if (!renderEntries) return null
    const rowH = readRowH
    return [...renderEntries].sort((a, b) => a.y_row - b.y_row).map((e, i) => {
      const rx = (e.node_start / node.size) * contentW
      const rw = Math.max(1, ((e.node_end - e.node_start) / node.size) * contentW)
      const ry = e.y_row * rowH
      const rh = rowH - 1
      if (rx + rw < effScrollLeft || rx > effScrollLeft + visibleW) return null

      const color = readColor(e)
      const cigarOps = detail && e.cigar ? parseCigar(e.cigar) : null
      const cs = detail && e.cs ? parseCs(e.cs) : null   // 置換+挿入を1パスで
      const csSubs = cs ? cs.subs : []
      const csIns  = cs ? cs.ins  : []

      // 方向矢印の境界: CIGARあり→最初・最後のM/=/X op範囲。デリーション領域に矢印が重ならない。
      let arrowLeft = rx, arrowRight = rx + rw
      if (cigarOps) {
        let fl: number | null = null, lr: number | null = null
        for (const op of cigarOps) {
          if ('=MX'.includes(op.op)) {
            const sx = (e.node_start + op.refStart) / node.size * contentW
            const ex = (e.node_start + op.refEnd)   / node.size * contentW
            if (fl === null || sx < fl) fl = sx
            if (lr === null || ex > lr) lr = ex
          }
        }
        if (fl !== null) { arrowLeft = fl; arrowRight = lr! }
      }

      return (
        <g key={i} className="algn-read" data-aln={e.aln_id ?? undefined} style={{ cursor: onSelectAln ? 'pointer' : undefined }}>
          <title>{e.query_start != null
            ? `${e.read_name}  query ${e.query_start.toLocaleString()}–${e.query_end!.toLocaleString()} / ${e.query_len!.toLocaleString()} bp (${e.strand})${e.mapq != null ? `  mapq=${e.mapq}` : ''}${e.aln_id != null ? `  aln_id=${e.aln_id}` : ''}`
            : `${e.read_name}  ${e.node_start}–${e.node_end} bp (${e.strand})`
          }</title>
          {cigarOps ? (
            cigarOps.map((op, j) => {
              const opX = (e.node_start + op.refStart) / node.size * contentW
              const opW = (op.refEnd - op.refStart) / node.size * contentW
              if (opX + Math.max(opW, 2) < effScrollLeft || opX > effScrollLeft + visibleW) return null
              switch (op.op) {
                case '=': case 'M':
                  return <rect key={j} x={opX} y={ry}
                    width={Math.max(1, opW)} height={rh}
                    fill={color} />
                case 'X':
                  return <rect key={j} x={opX} y={ry}
                    width={Math.max(pxPerBp, opW)} height={rh}
                    fill={palette.mismatch} />
                case 'D':
                  return <rect key={j} x={opX} y={ry + Math.round(rh / 2) - 0.5}
                    width={Math.max(2, opW)} height={1}
                    fill="#888" />
                case 'I': {
                  // cs があれば下の csIns 側で塩基つきマーカーを描くので CIGAR I は描かない
                  if (e.cs) return null
                  // ▽ リードバー内（上端から下方向）に描画。行外に出ない
                  const th = Math.min(rh, 5)
                  const hw = Math.max(1, th)
                  return <polygon key={j}
                    points={`${opX - hw},${ry} ${opX + hw},${ry} ${opX},${ry + th}`}
                    fill={palette.ins} style={{ pointerEvents: 'none' }} />
                }
                default: return null
              }
            })
          ) : (
            <rect x={rx} y={ry} width={rw} height={rh} fill={color} />
          )}
          {/* cs:Z があれば置換を「リード側の alt 塩基」の色で上書き表示（赤Xより情報量大）。
              10px(showText)では塩基文字も描く。挿入/欠失は CIGAR 側の描画のまま。 */}
          {csSubs.map((s, j) => {
            const sx = (e.node_start + s.pos) / node.size * contentW
            if (sx + Math.max(pxPerBp, 2) < effScrollLeft || sx > effScrollLeft + visibleW) return null
            const w = Math.max(pxPerBp, 1)
            return (
              <g key={`cs${j}`}>
                <rect x={sx} y={ry} width={w} height={rh} fill={palette.base[s.alt] ?? palette.mismatch} />
                {showText && (
                  <text x={sx + w / 2} y={ry + rh / 2 + 3} textAnchor="middle"
                    fontSize={Math.min(pxPerBp - 1, rh)} fill="#fff" fontFamily="monospace" fontWeight="bold"
                    transform={flipped ? `translate(${(sx + w / 2) * 2},0) scale(-1,1)` : undefined}
                    style={{ pointerEvents: 'none' }}>{s.alt}</text>
                )}
              </g>
            )
          })}
          {/* 挿入(cs +seq): 常時=塩基色の縦I字マーカー＋ツールチップ。
              showText でホバー中のみ、挿入塩基(最大8)をリード上のコールアウトに展開。 */}
          {csIns.map((ins, j) => {
            const ix = (e.node_start + ins.pos) / node.size * contentW
            if (ix < effScrollLeft - 4 || ix > effScrollLeft + visibleW + 4) return null
            const col = insColor(ins.seq, palette)
            const shown = ins.seq.slice(0, 8), more = ins.seq.length > 8
            const cw = Math.max(7, Math.min(pxPerBp, 12))
            const ncell = shown.length + (more ? 1 : 0)
            const totalW = ncell * cw, cx0 = ix - totalW / 2
            const ch = Math.min(rh + 2, 12)
            const above = ry - ch - 2 >= 0
            const cy = above ? ry - ch - 2 : ry + rh + 2
            return (
              <g key={`ins${j}`}>
                <title>{`+${ins.seq} (${ins.seq.length} bp 挿入)`}</title>
                <rect x={ix - 1} y={ry} width={2} height={rh} fill={col} />
                <polygon points={`${ix - 3},${ry} ${ix + 3},${ry} ${ix},${ry + 3}`}
                  fill={col} style={{ pointerEvents: 'none' }} />
                {showText && (
                  <g className="ins-call" style={{ pointerEvents: 'none' }}>
                    <line x1={ix} y1={ry + rh / 2} x2={ix} y2={above ? cy + ch : cy}
                      stroke={col} strokeWidth={1} />
                    <rect x={cx0 - 1} y={cy - 1} width={totalW + 2} height={ch + 2}
                      fill="#fff" stroke={col} strokeWidth={0.8} rx={1} />
                    {[...shown].map((b, k) => {
                      const bx = cx0 + k * cw
                      return (
                        <g key={k}>
                          <rect x={bx} y={cy} width={cw} height={ch} fill={palette.base[b] ?? palette.ins} />
                          <text x={bx + cw / 2} y={cy + ch / 2 + 3} textAnchor="middle"
                            fontSize={Math.min(cw - 1, ch)} fill="#fff" fontFamily="monospace" fontWeight="bold"
                            transform={flipped ? `translate(${(bx + cw / 2) * 2},0) scale(-1,1)` : undefined}>{b}</text>
                        </g>
                      )
                    })}
                    {more && (
                      <text x={cx0 + shown.length * cw + cw / 2} y={cy + ch / 2 + 3} textAnchor="middle"
                        fontSize={Math.min(cw - 1, ch)} fill={col} fontFamily="monospace"
                        transform={flipped ? `translate(${(cx0 + shown.length * cw + cw / 2) * 2},0) scale(-1,1)` : undefined}>…</text>
                    )}
                  </g>
                )}
              </g>
            )
          })}
          {/* 方向矢印 (2x/10x) */}
          {detail && (() => {
            const arw = arrowRight - arrowLeft
            const aw = Math.min(rh, arw * 0.25)
            if (arw <= aw * 3) return null
            const my = ry + rh / 2
            return e.strand === '+' ? (
              <polygon
                points={`${arrowRight-aw},${ry} ${arrowRight},${my} ${arrowRight-aw},${ry+rh}`}
                fill="rgba(0,0,0,0.25)" style={{ pointerEvents: 'none' }} />
            ) : (
              <polygon
                points={`${arrowLeft+aw},${ry} ${arrowLeft},${my} ${arrowLeft+aw},${ry+rh}`}
                fill="rgba(0,0,0,0.25)" style={{ pointerEvents: 'none' }} />
            )
          })()}
        </g>
      )
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderEntries, readRowH, node.size, contentW, effScrollLeft, visibleW, detail, pxPerBp, showText, flipped,
      membershipActive, readFill, focusSamples, sampleHighlight, selectedAln, onSelectAln, sampleColorMap, colorPlus, colorMinus, palette])

  // P2: 選択/検索リードがこの列にあれば、その行（縦）とセグメント（横）が見えるよう1回だけスクロール。
  // 選択が変わった時、または（P3で）リードが後から読み込まれて初めて現れた時に発火し、手動スクロールとは競合しない。
  const scrolledForRef = useRef<number | null>(null)
  useEffect(() => {
    if (selectedAln == null) { scrolledForRef.current = null; return }
    if (!renderEntries) return
    const e = renderEntries.find(x => x.aln_id === selectedAln)
    if (!e) return
    if (scrolledForRef.current === selectedAln) return   // この選択では既にスクロール済み
    scrolledForRef.current = selectedAln
    const pv = pileupRef.current
    if (pv && pv.clientHeight > 0) {
      pv.scrollTop = Math.max(0, e.y_row * readRowH - pv.clientHeight / 2 + readRowH / 2)
    }
    const sc = outerScrollRef.current
    if (sc && node.size > 0 && contentW > 0) {
      const cx = ((e.node_start + e.node_end) / 2) / node.size * contentW   // 非反転 content 座標
      const left = (flipped ? contentW - cx : cx) - sc.clientWidth / 2
      sc.scrollLeft = Math.max(0, Math.min(Math.max(0, contentW - sc.clientWidth), left))
    }
  }, [selectedAln, renderEntries, readRowH, contentW, node.size, flipped, outerScrollRef])

  return (
    <div style={{ width: contentW, height, flexShrink: 0 }}>

      {/* Ruler（ドラッグで範囲ズーム） */}
      <svg ref={rulerRef} data-ruler width={contentW} height={RULER_H}
        onMouseDown={onZoomRange ? onRulerDown : undefined}
        style={{ display: 'block', background: '#f8f9fa', cursor: onZoomRange ? 'zoom-in' : 'default' }}>
        <g transform={flipTransform}>
          <line x1={0} y1={RULER_H - 1} x2={contentW} y2={RULER_H - 1}
            stroke="#dee2e6" strokeWidth={1} />
          {ticks.map(t => (
            <g key={t.x} transform={`translate(${t.x},0)`}>
              <line x1={0} y1={RULER_H - 4} x2={0} y2={RULER_H - 1} stroke="#868e96" strokeWidth={1} />
              {/* テキストはflip後に再反転して正立させる */}
              <text x={2} y={RULER_H - 5} fontSize={9} fill="#868e96" fontFamily="monospace"
                transform={flipped ? 'scale(-1,1)' : undefined}>
                {t.label}
              </text>
            </g>
          ))}
        </g>
        {/* 選択中の範囲ハイライト（生 content 座標。flipTransform の外に置く） */}
        {rulerSel && Math.abs(rulerSel.x1 - rulerSel.x0) >= 1 && (
          <rect x={Math.min(rulerSel.x0, rulerSel.x1)} y={0}
            width={Math.abs(rulerSel.x1 - rulerSel.x0)} height={RULER_H}
            fill="#1971c2" fillOpacity={0.2} stroke="#1971c2" strokeWidth={0.6} pointerEvents="none" />
        )}
      </svg>

      {/* Sequence track + Alignment pileup: 同一スクロール容器に入れてスクロールバー幅を揃える */}
      {restH > 0 && (() => {
        const COVHIST_H = 56   // tooMany 時の下部カバレージ帯の高さ
        const totalPileupH = tooMany
          ? Math.max(40, sharedRows * readRowH + COVHIST_H)
          : Math.max(restH - SEQ_H - varH, maxYRow * readRowH)
        return (
        <div ref={pileupRef} style={{ height: restH, overflowY: 'hidden', cursor: 'grab' }}>
          {/* 変異密度トラック（事前計算・全モード・sticky）。常に高さ確保（列間で行を揃える）。
              データが無い/少ない列は空のベースラインだけ表示。上=+鎖 下=−鎖, 赤=ミスマッチ 紫=欠失 橙=挿入。 */}
          <div style={{ position: 'sticky', top: 0, zIndex: 2, background: '#fff' }}
            title="変異密度（上=+鎖 / 下=−鎖、赤=ミスマッチ 紫=欠失 橙=挿入）。高さ=変異率(変異塩基/被覆塩基)を表示範囲内の最大値で正規化。塩基種別(alt)は cs版リード描画で。">
            <svg width={pileupClientW} height={VAR_H} viewBox={`0 0 ${contentW} ${VAR_H}`} preserveAspectRatio="none"
              style={{ display: 'block', background: '#fcfcfd', borderBottom: '1px solid #e9ecef' }}>
              <line x1={0} y1={VAR_H / 2} x2={contentW} y2={VAR_H / 2} stroke="#dee2e6" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
              {/* varBars は node 座標。ここで node→contentW へ scale（列幅調整では transform だけ更新）。 */}
              {varBars && (
                <g transform={flipTransform}>
                  <g transform={node.size > 0 ? `scale(${contentW / node.size},1)` : undefined}>{varBars}</g>
                </g>
              )}
            </svg>
          </div>
          {/* Sequence track (塩基モードのみ) — sticky でスクロールしても常に表示 */}
          {showBases && (
            <div style={{ position: 'sticky', top: varH, zIndex: 1 }}>
              <svg width={pileupClientW} height={SEQ_H} viewBox={`0 0 ${contentW} ${SEQ_H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                <g transform={flipTransform}>
                <rect x={0} y={0} width={contentW} height={SEQ_H} fill="#e0e0e0" />
                {sequence === null
                  ? Array.from({ length: endBase - startBase }, (_, j) => {
                      const i = startBase + j
                      const base = BASES[i % 4]
                      const x = i * seqPxPerBp
                      return (
                        <g key={i}>
                          <rect x={x} y={0} width={seqPxPerBp} height={SEQ_H} fill={palette.base[base]} opacity={0.4} />
                        </g>
                      )
                    })
                  : Array.from({ length: endBase - startBase }, (_, j) => {
                      const i = startBase + j
                      const base = (sequence[i] ?? 'N').toUpperCase()
                      const color = palette.base[base] ?? '#999'
                      const x = i * seqPxPerBp
                      return (
                        <g key={i}>
                          <rect x={x} y={0} width={seqPxPerBp} height={SEQ_H} fill={color} />
                          {showText && (
                            <text
                              x={x + seqPxPerBp / 2} y={SEQ_H / 2 + 4}
                              textAnchor="middle"
                              fontSize={Math.min(seqPxPerBp - 2, 12)}
                              fill="white" fontFamily="monospace" fontWeight="bold"
                              transform={flipped ? `translate(${(x + seqPxPerBp / 2) * 2},0) scale(-1,1)` : undefined}
                            >
                              {base}
                            </text>
                          )}
                        </g>
                      )
                    })
                }
                </g>
              </svg>
            </div>
          )}
        <svg ref={pileupSvgRef} width={pileupClientW} height={totalPileupH} viewBox={`0 0 ${contentW} ${totalPileupH}`} preserveAspectRatio="none" style={{ display: 'block', background: '#f8f9fa' }}
          onClick={onSelectAln ? (e => {
            if (draggedRef.current) return                                   // ドラッグはクリック扱いしない
            const el = (e.target as Element)?.closest?.('[data-aln]')
            const a = el ? Number(el.getAttribute('data-aln')) : NaN
            onSelectAln(Number.isFinite(a) ? a : null)                       // 空白クリック=解除
          }) : undefined}>
          {/* 挿入塩基コールアウトはホバー中のリードだけ表示 */}
          <style>{'.algn-read .ins-call{visibility:hidden}.algn-read:hover .ins-call{visibility:visible}'}</style>
          {overlapPairs.size > 0 && (
            <defs>
              {[...overlapPairs].map(key => {
                const [a, b] = key.split('-').map(Number)
                return (
                  <pattern key={key} id={`hatch-${a}-${b}`} patternUnits="userSpaceOnUse"
                    width={6} height={6} patternTransform="rotate(45)">
                    <rect width={6} height={6} fill={TAG_COLORS[a % TAG_COLORS.length]} />
                    <rect width={3} height={6} fill={TAG_COLORS[b % TAG_COLORS.length]} />
                  </pattern>
                )
              })}
            </defs>
          )}
          <g transform={flipTransform}>
          {/* tooMany 時: 下部にカバレージ帯（共有リードは下の通常描画で出る） */}
          {tooMany && (() => {
            const hist = node.cov_hist
            const top = totalPileupH - COVHIST_H
            if (hist && hist.length > 0) {
              const maxVal = Math.max(...hist, 1)
              const bw = contentW / hist.length
              return (
                <g>
                  <line x1={0} y1={top} x2={contentW} y2={top} stroke="#dee2e6" strokeWidth={1} />
                  {hist.map((v, i) => {
                    const bh = (v / maxVal) * (COVHIST_H - 14)
                    return (
                      <rect key={i} x={i * bw} y={totalPileupH - 14 - bh}
                        width={bw} height={bh} fill={palette.strandPlus} opacity={0.6} />
                    )
                  })}
                  <text x={contentW / 2} y={totalPileupH - 2} textAnchor="middle"
                    fontSize={Math.min(11, contentW / 18)} fill="#868e96" fontFamily="sans-serif">
                    {`リード多数（${total.toLocaleString()}本${truncated ? "・端のみ取得" : ""}）- 共有リードのみ表示`}
                  </text>
                </g>
              )
            }
            return (
              <text x={contentW / 2} y={totalPileupH - 4} textAnchor="middle"
                fontSize={Math.min(11, contentW / 18)} fill="#868e96" fontFamily="sans-serif">
                {`リード多数（${total.toLocaleString()}本${truncated ? "・端のみ取得" : ""}）- 共有リードのみ表示`}
              </text>
            )
          })()}
          {readGlyphs}
          </g>
        </svg>
        </div>
        )
      })()}

    </div>
  )
}

function makeTicks(
  contentW: number, totalBp: number,
  scrollLeft: number, visibleW: number,
): { x: number; label: string }[] {
  if (contentW <= 0 || totalBp <= 0 || visibleW <= 0) return []
  const pxPerBp = contentW / totalBp
  const minSpacingPx = 50
  const minBpSpacing = minSpacingPx / pxPerBp
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(minBpSpacing, 1))))
  let interval = mag
  for (const m of [1, 2, 5, 10]) {
    if (mag * m >= minBpSpacing) { interval = mag * m; break }
  }
  // 可視範囲＋前後バッファ内だけ生成
  const startBp = Math.max(0,        Math.floor((scrollLeft - visibleW) / pxPerBp / interval) * interval)
  const endBp   = Math.min(totalBp,  Math.ceil( (scrollLeft + visibleW * 2) / pxPerBp))
  const ticks: { x: number; label: string }[] = []
  for (let bp = startBp; bp <= endBp; bp += interval) {
    ticks.push({ x: (bp / totalBp) * contentW, label: formatBp(bp) })
  }
  return ticks
}

function formatBp(bp: number): string {
  if (bp === 0) return '0'
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(bp % 1e6 === 0 ? 0 : 1)}M`
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(bp % 1e3 === 0 ? 0 : 1)}k`
  return String(bp)
}
