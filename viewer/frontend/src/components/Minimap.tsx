import { useEffect, useRef, useState } from 'react'
import { fetchNodes, fetchEdges, fetchNodesGrid, GridCell, GridBigNode, NodeData, EdgeData, Rect, GuardSink } from '../api/client'

interface Props {
  viewport: Rect
  layer: number
  dbFile: string
  sel?: string             // hap 絞り込み（メインと同じ sel=）。渡さないとミニマップだけ絞り込み前を描く
  clickThrough?: boolean   // 編集モード中: クリックを canvas へ通す（表示は維持）
  onNavigate: (cx: number, cy: number) => void
}

const MINIMAP_W      = 180
const OVERVIEW_H     = 55
const CONTEXT_H      = 110
const CONTEXT_OFFSET = 3    // currentLayer - N をコンテキストレイヤとする
const CONTEXT_SCALE  = 4    // 中心 ± N × ビューポート幅を表示範囲とする

// ── 座標変換 ──────────────────────────────────────────────────────────────
// アスペクト比を保って world 矩形を canvas に収める（x/y 同一スケール＋センタリング）。
// 独立スケール（cw/ww, ch/wh）で引き伸ばすと実際と縦横比が変わる（横長/縦長に歪む）ため、
// 小さい方のスケールで uniform に合わせ、余白は上下 or 左右に均等に振る（レターボックス）。
function fitTransform(r: Rect, cw: number, ch: number) {
  const ww = r.x2 - r.x1, wh = r.y2 - r.y1
  const scale = Math.min(cw / ww, ch / wh)
  return { scale, ox: (cw - ww * scale) / 2, oy: (ch - wh * scale) / 2 }
}

function w2c(wx: number, wy: number, r: Rect, cw: number, ch: number) {
  const { scale, ox, oy } = fitTransform(r, cw, ch)
  return { x: ox + (wx - r.x1) * scale, y: oy + (wy - r.y1) * scale }
}

function c2w(cx: number, cy: number, r: Rect, cw: number, ch: number) {
  const { scale, ox, oy } = fitTransform(r, cw, ch)
  return { x: r.x1 + (cx - ox) / scale, y: r.y1 + (cy - oy) / scale }
}

// コンテキスト矩形。中心はビューポート中心、広さは ±CONTEXT_SCALE×ビューポート。
//
// ★縦横比は **canvas(MINIMAP_W×CONTEXT_H) に合わせる**。ビューポートの縦横比そのままだと、
//   ブラウザを縦長にしたとき矩形も縦長になり、w2c(fitTransform) がレターボックスするので
//   180×110 の canvas の中央に細い縦帯だけが描かれ、左右は空白になる。
//   結果「見える x 範囲がビューポート幅の ±4 しかない」＝グラフの形が分からない絵になっていた
//   （全体マップ側は ovH を world 縦横比に合わせているので、ここだけ食い違っていた）。
//   足りない側の軸を広げて合わせる＝**±CONTEXT_SCALE を下限として、余る方向はもっと広く見せる**
//   （情報が減らない方向の調整）。canvas を余さず使うので:
//     ・レターボックスの空白が消える
//     ・クリック→ナビゲーションが余白で矩形外に外れる問題も消える
//     ・グリッドのセルが world 上でほぼ正方になり、drawGeometry の 1 セル≒1 画素前提と揃う
function makeContextRect(vp: Rect): Rect {
  const cx = (vp.x1 + vp.x2) / 2, cy = (vp.y1 + vp.y2) / 2
  let hw = (vp.x2 - vp.x1) * CONTEXT_SCALE
  let hh = (vp.y2 - vp.y1) * CONTEXT_SCALE
  const A = MINIMAP_W / CONTEXT_H            // canvas の縦横比
  if (hw / hh < A) hw = hh * A               // 縦長すぎ → 横を広げる
  else             hh = hw / A               // 横長すぎ → 縦を広げる
  return { x1: cx - hw, x2: cx + hw, y1: cy - hh, y2: cy + hh }
}

// ビューポート中心が rect の中央 50% 内にあるか
function inMiddle50(vp: Rect, r: Rect): boolean {
  const cx = (vp.x1 + vp.x2) / 2, cy = (vp.y1 + vp.y2) / 2
  return Math.abs(cx - (r.x1 + r.x2) / 2) < (r.x2 - r.x1) / 4
      && Math.abs(cy - (r.y1 + r.y2) / 2) < (r.y2 - r.y1) / 4
}

// ── Canvas 描画 ────────────────────────────────────────────────────────────
//
// 2026-08-03 改修: 「ジオメトリ（重い・データが変わったときだけ変わる）」と「ビューポート枠と
// 移動先マーカー（軽い・パンのたびに変わる）」を分離した。
//
// 以前は 1 つの drawMap が両方を描いており、それが `viewport` を deps に持つ useEffect から
// 呼ばれていた。`onViewportChanged`(GraphCanvas) はスロットル無しで毎パン/ズームイベント発火
// するので、**赤枠を動かすためだけに全ノード・全エッジを描き直していた**。最密領域では
// ノード 76,898 個 ×（save/translate/rotate/beginPath/rect/fill/stroke/restore ＋状態設定）
// ＝ 1 回の再描画で Canvas2D 呼び出し 92 万回。座標変換の JS 自体は 0.6ms なので、コストは
// 全部 Canvas2D 側だった。
//
// いまは drawGeometry() でオフスクリーンに 1 回描き、パン中は composite() が drawImage 1 回＋
// 枠を描くだけ（パンあたり O(N) → O(1)）。

/** 背景＋ジオメトリをオフスクリーンへ描く。データ or キャンバス寸法が変わったときだけ呼ぶ。 */
function drawGeometry(
  off: HTMLCanvasElement,
  nodes: NodeData[], edges: EdgeData[], cells: GridCell[] | null,
  big: GridBigNode[] | null,
  worldRect: Rect,
) {
  const ctx = off.getContext('2d')!
  const cw = off.width, ch = off.height
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#f8f9fa'
  ctx.fillRect(0, 0, cw, ch)
  // fitTransform はループ内で呼ばない（w2c が毎回呼ぶと 1 再描画で 29 万回になっていた）。
  const { scale, ox, oy } = fitTransform(worldRect, cw, ch)
  const px = (wx: number) => ox + (wx - worldRect.x1) * scale
  const py = (wy: number) => oy + (wy - worldRect.y1) * scale

  if (cells) {
    // グリッド集約（context マップ）: 1 セル = 高々 1 画素なので、ここは回転も縁取りも見えない。
    // 密度は濃淡で表す。fillStyle の切替を抑えるため対数密度を 6 段にバケットし、段ごとに 1 パス。
    //
    // ★ランプの下端は**従来のノード色そのまま**にする。0..1 に正規化した薄い色から始めると、
    //   最密セルが 3,755 件もある視野では c=1 のセルが最淡色に落ちて**疎な領域がほぼ消える**
    //   （最初の実装がこれで、従来より見た目が薄くなっていた）。従来は密度表現が無く全部
    //   #228be6 だったので、「下端＝従来色、密なほど暗く」なら疎な場所の見え方は退行しない。
    const SHADES = ['#228be6', '#1c7ed6', '#1971c2', '#1864ab', '#145591', '#0d3d6b']
    const maxC = cells.reduce((m, c) => (c.c > m ? c.c : m), 1)
    const lmax = Math.log1p(maxC)
    const buckets: GridCell[][] = SHADES.map(() => [])
    for (const c of cells) {
      const t = lmax > 0 ? Math.log1p(c.c) / lmax : 0
      buckets[Math.min(SHADES.length - 1, Math.floor(t * SHADES.length))].push(c)
    }
    for (let i = 0; i < SHADES.length; i++) {
      const b = buckets[i]
      if (b.length === 0) continue
      ctx.fillStyle = SHADES[i]
      ctx.beginPath()
      for (const c of b) {
        // 1 画素未満は 1 画素の点。1 画素を超えるものは大きさを反映（疎な領域で潰れないように）。
        const w = Math.max(1, c.w * scale)
        const h = Math.max(1, c.w * 0.35 * scale)
        ctx.rect(px(c.x) - w / 2, py(c.y) - h / 2, w, h)
      }
      ctx.fill()
    }
    // 1 画素より大きく描かれるノードは**向きが見える**ので、セルの上に向き付きロッドを重ねる。
    // これが無いと軸平行の棒が並ぶ絵になり、実際のグラフと向きが食い違って見える
    // （最深層では該当 0 件だが、主層 4〜10 では 70〜2,671 件あり明確に違和感が出る）。
    if (big && big.length) {
      ctx.fillStyle = '#228be6'
      ctx.strokeStyle = '#1864ab'
      ctx.lineWidth = 0.5
      for (const n of big) {
        const w = n.r * 2 * scale
        const h = Math.max(0.8, w * 0.35)
        ctx.save()
        ctx.translate(px(n.x), py(n.y))
        ctx.rotate(n.a)
        ctx.beginPath()
        ctx.rect(-w / 2, -h / 2, w, h)
        ctx.fill()
        ctx.globalAlpha = 0.6
        ctx.stroke()
        ctx.globalAlpha = 1.0
        ctx.restore()
      }
    }
    return
  }

  // 生ノード/エッジ（全体マップ = layer 0。数百件なのでそのまま描く）
  ctx.strokeStyle = '#adb5bd'
  ctx.lineWidth = 0.5
  ctx.globalAlpha = 0.65
  ctx.beginPath()
  for (const e of edges) {
    ctx.moveTo(px(e.start_x), py(e.start_y))
    ctx.lineTo(px(e.end_x), py(e.end_y))
  }
  ctx.stroke()

  ctx.globalAlpha = 1.0
  ctx.fillStyle = '#228be6'
  ctx.strokeStyle = '#1864ab'
  ctx.lineWidth = 0.5
  // 1 画素程度にしかならないノードは回転も縁取りも見えないので、save/rotate/restore をやめて
  // まとめて 1 パスで塗る（Canvas2D 呼び出しがノードあたり 12 回 → 1 回）。
  const bigRaw: NodeData[] = []
  ctx.beginPath()
  for (const n of nodes) {
    const w = n.radius * 2 * scale
    if (w > 2) { bigRaw.push(n); continue }
    ctx.rect(px(n.xCoord) - 0.75, py(n.yCoord) - 0.4, 1.5, 0.8)
  }
  ctx.fill()
  // 画素より大きく描かれるノードだけ、従来どおり向き付きで描く。
  for (const n of bigRaw) {
    const w = n.radius * 2 * scale
    const h = Math.max(0.8, w * 0.35)
    ctx.save()
    ctx.translate(px(n.xCoord), py(n.yCoord))
    ctx.rotate(n.angle)
    ctx.beginPath()
    ctx.rect(-w / 2, -h / 2, w, h)
    ctx.fill()
    ctx.globalAlpha = 0.6
    ctx.stroke()
    ctx.globalAlpha = 1.0
    ctx.restore()
  }
}

/** オフスクリーンを転写し、その上にビューポート枠と移動先マーカーを描く。パンごとに呼ぶ側。 */
function composite(
  canvas: HTMLCanvasElement,
  off: HTMLCanvasElement | null,
  worldRect: Rect,
  vp: Rect,
  target: { x: number; y: number } | null,
) {
  const ctx = canvas.getContext('2d')!
  const cw = canvas.width, ch = canvas.height
  if (off && off.width === cw && off.height === ch) ctx.drawImage(off, 0, 0)
  else { ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = '#f8f9fa'; ctx.fillRect(0, 0, cw, ch) }

  const p1 = w2c(vp.x1, vp.y1, worldRect, cw, ch)
  const p2 = w2c(vp.x2, vp.y2, worldRect, cw, ch)
  const bw = Math.max(2, p2.x - p1.x)
  const bh = Math.max(1, p2.y - p1.y)
  ctx.globalAlpha = 0.12
  ctx.fillStyle = '#e03131'
  ctx.fillRect(p1.x, p1.y, bw, bh)
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = '#e03131'
  ctx.lineWidth = 1.5
  ctx.strokeRect(p1.x, p1.y, bw, bh)

  if (target) {
    const tp = w2c(target.x, target.y, worldRect, cw, ch)
    ctx.globalAlpha = 1.0
    ctx.strokeStyle = '#f08c00'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(tp.x, tp.y, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(tp.x - 8, tp.y); ctx.lineTo(tp.x + 8, tp.y)
    ctx.moveTo(tp.x, tp.y - 8); ctx.lineTo(tp.x, tp.y + 8)
    ctx.stroke()
  }
  ctx.globalAlpha = 1.0
}

// ── コンポーネント ─────────────────────────────────────────────────────────

export default function Minimap({ viewport, layer, dbFile, sel = '', clickThrough, onNavigate }: Props) {
  const ovRef  = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<HTMLCanvasElement>(null)
  // ジオメトリのオフスクリーン。パン中はここから drawImage するだけにする。
  const ovOff  = useRef<HTMLCanvasElement | null>(null)
  const ctxOff = useRef<HTMLCanvasElement | null>(null)
  // 全体マップの canvas 高さ。world の縦横比に合わせてキャンバス自体を伸縮させ、箱がグラフを
  // ちょうど包む（固定 180x55 だと横長の箱に細いグラフがレターボックスされ「横長」に見える）。
  const [ovH, setOvH] = useState(OVERVIEW_H)
  const [collapsed, setCollapsed] = useState(false)   // 最小化（ヘッダのみ表示）

  // 非同期コールバックから最新値を参照するための ref
  const vpRef     = useRef(viewport)
  const targetRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => { vpRef.current = viewport }, [viewport])

  // 全体マップデータ
  const ovNodes  = useRef<NodeData[]>([])
  const ovEdges  = useRef<EdgeData[]>([])
  const ovBounds = useRef<Rect>({ x1: 0, x2: 1, y1: 0, y2: 1 })

  // コンテキストマップデータ。ノード行ではなく **グリッド集約セル** を持つ（/nodes_grid）。
  // 以前は /nodes と /edges を上限なしで叩いており、chr22 最密領域で 76,898 ノード(24.7MB)＋
  // 107,849 エッジ(11.8MB)を 180×110 のキャンバスのために取っていた（3.9 ノード/画素）。
  // グリッド集約なら同じ矩形・同じ層で 6,440 セル / 426KB / warm 0.07s（従来 5.47s）。
  // エッジはこの縮尺では灰色の塊にしかならないので context マップでは取らない。
  // 中断された部分応答で内容を置き換えないための再取得トリガ（下の effect の依存に入れる）。
  // backend は走行中のクエリを中断すると **途中まで読んだ行を status 200 で** 返すため、
  // そのまま採用するとミニマップが白くなる（本体キャンバスで実際に踏んだのと同じ原因）。
  const ctxRetryTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [ctxRetry, setCtxRetry] = useState(0)
  const ctxCells       = useRef<GridCell[]>([])
  const ctxBig         = useRef<GridBigNode[]>([])   // 1画素超＝向きが見えるノード
  const ctxRect        = useRef<Rect>({ x1: 0, x2: 1, y1: 0, y2: 1 })
  const ctxLayerRef    = useRef(-1)
  const ctxBusy        = useRef(false)
  const ctxPendingRect = useRef<Rect | null>(null)  // fetch中の rect
  const ctxSelRef      = useRef(sel)                // 絞り込みが変わったら取り直す
  const ctxAbort       = useRef<AbortController | null>(null)  // 用済み取得の中断用

  const [pendingTarget, setPendingTarget] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => { targetRef.current = pendingTarget }, [pendingTarget])

  // ── 描画関数 ─────────────────────────────────────────────────────────
  // rebuild*: ジオメトリをオフスクリーンに描き直す（データ/寸法が変わったときだけ）。
  // redraw*  : オフスクリーンを転写して枠を描く（パンのたび。O(1)）。
  function offFor(ref: React.MutableRefObject<HTMLCanvasElement | null>, w: number, h: number) {
    if (!ref.current) ref.current = document.createElement('canvas')
    if (ref.current.width !== w || ref.current.height !== h) {
      ref.current.width = w; ref.current.height = h
    }
    return ref.current
  }
  function rebuildOv() {
    const c = ovRef.current
    if (!c) return
    drawGeometry(offFor(ovOff, c.width, c.height),
      ovNodes.current, ovEdges.current, null, null, ovBounds.current)
  }
  function rebuildCtx() {
    const c = ctxRef.current
    if (!c) return
    drawGeometry(offFor(ctxOff, c.width, c.height), [], [],
      ctxCells.current, ctxBig.current, ctxRect.current)
  }
  function redrawOv() {
    if (ovRef.current)
      composite(ovRef.current, ovOff.current, ovBounds.current, vpRef.current, targetRef.current)
  }
  function redrawCtx() {
    if (ctxRef.current)
      composite(ctxRef.current, ctxOff.current, ctxRect.current, vpRef.current, targetRef.current)
  }

  // ── 全体マップ: DB切替時に1回 fetch ─────────────────────────────────
  useEffect(() => {
    const big: Rect = { x1: -0.5, x2: 1.5, y1: -0.5, y2: 1.5 }
    Promise.all([fetchNodes(0, big, dbFile), fetchEdges(0, big, dbFile)])
      .then(([nodes, edges]) => {
        ovNodes.current = nodes
        ovEdges.current = edges
        if (nodes.length > 0) {
          const xs = nodes.map(n => n.xCoord), ys = nodes.map(n => n.yCoord)
          const x0 = Math.min(...xs), x1 = Math.max(...xs)
          const y0 = Math.min(...ys), y1 = Math.max(...ys)
          const rw = (x1 - x0) || 1, rh = (y1 - y0) || 1
          const mx = rw * 0.06, my = rh * 0.06   // 比例マージン（アスペクト比を保つ）
          ovBounds.current = { x1: x0 - mx, x2: x1 + mx, y1: y0 - my, y2: y1 + my }
          // canvas 高さを world 縦横比に合わせる（箱=グラフ形状に）。細すぎ/高すぎは 28..110 でクランプ。
          const aspect = (rw + 2 * mx) / (rh + 2 * my)
          setOvH(Math.round(Math.min(110, Math.max(28, MINIMAP_W / aspect))))
        }
        rebuildOv()
        redrawOv()
      })
      .catch(e => console.error('minimap overview fetch failed:', e))
  }, [dbFile])

  // canvas 高さ変更は bitmap をクリアし、最小化からの復帰は canvas を再マウントするので、
  // 反映後（commit 後）にオフスクリーンごと作り直して再描画する。最小化中は canvas 未マウント
  // なので何もしない（＝ミニマップを畳めばコストは完全にゼロ）。
  useEffect(() => {
    if (collapsed) return
    rebuildOv(); rebuildCtx()
    redrawOv(); redrawCtx()
  }, [ovH, collapsed])

  // ── ビューポート/レイヤ変化時: コンテキスト更新判定 + 再描画 ────────────
  useEffect(() => {
    const newCtxLayer = Math.max(0, layer - CONTEXT_OFFSET)
    const needsNewData = newCtxLayer !== ctxLayerRef.current
      || sel !== ctxSelRef.current
      || !inMiddle50(viewport, ctxRect.current)

    if (needsNewData && !ctxBusy.current) {
      const newRect = makeContextRect(viewport)
      ctxPendingRect.current = newRect
      ctxLayerRef.current    = newCtxLayer
      ctxSelRef.current      = sel
      ctxBusy.current        = true

      // 層は newCtxLayer 固定。maxRows は渡さない（層フォールバックの入力なので、
      // 「メイン層 - 一定オフセット」を必ず描きたいミニマップでは使ってはいけない）。
      // 間引きはグリッド集約＝画素解像度での空間的に均一なサンプリングで行う。
      // 前回の取得がまだ飛んでいれば abort する（backend の入口ガードでキュー待ち分が捨てられる）。
      ctxAbort.current?.abort()
      const ctrl = new AbortController()
      ctxAbort.current = ctrl
      const guard: GuardSink = { truncated: null }
      fetchNodesGrid(newCtxLayer, newRect, dbFile, MINIMAP_W, CONTEXT_H, sel, ctrl.signal,
                     undefined, guard)
        .then(grid => {
          // ★不完全な応答（'cancel'=走行中に中断 / 'time'=時間ガード）で **内容を置き換えない**。
          //   置き換えると前の絵まで消えて真っ白になる。前回の内容を保ったまま少し後に取り直す。
          if (guard.truncated && guard.truncated !== 'rows') {
            if (!ctxRetryTimer.current) {
              ctxRetryTimer.current = setTimeout(() => {
                ctxRetryTimer.current = null
                setCtxRetry(v => v + 1)
              }, 500)
            }
            return
          }
          ctxCells.current = grid.cells
          ctxBig.current   = grid.nodes ?? []
          ctxRect.current  = ctxPendingRect.current!  // データ到着後に rect 確定
          ctxPendingRect.current = null
          rebuildCtx()
          redrawCtx()
        })
        .catch(e => { if ((e as any)?.name !== 'AbortError') console.error('minimap context fetch failed:', e) })
        .finally(() => { ctxBusy.current = false })
    }

    // データ更新の有無に関わらず赤枠は毎回再描画。ここはオフスクリーンの転写＋枠だけなので
    // ノード数に依らず O(1)（以前はここで全ノードを描き直していた）。
    redrawOv()
    redrawCtx()
  }, [viewport, layer, dbFile, sel, pendingTarget, ctxRetry])

  // ── クリックハンドラ ──────────────────────────────────────────────────
  function handleCanvasClick(
    canvas: HTMLCanvasElement,
    worldRect: Rect,
    e: React.MouseEvent<HTMLCanvasElement>,
  ) {
    const r  = canvas.getBoundingClientRect()
    const wp = c2w(e.clientX - r.left, e.clientY - r.top, worldRect, canvas.width, canvas.height)
    setPendingTarget({ x: wp.x, y: wp.y })
  }

  // ── ラベルスタイル ────────────────────────────────────────────────────
  const labelStyle: React.CSSProperties = {
    padding: '2px 6px', fontSize: 10, color: '#868e96',
    fontFamily: 'sans-serif', background: '#f1f3f5',
    borderBottom: '1px solid #e9ecef',
  }

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, zIndex: 10,
      pointerEvents: clickThrough ? 'none' : undefined,   // 編集モード中はクリックを canvas へ通す
      background: 'rgba(255,255,255,0.92)',
      border: '1px solid #dee2e6',
      borderRadius: 6,
      boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      overflow: 'hidden',
      userSelect: 'none',
      width: MINIMAP_W,
    }}>
      {/* ヘッダ（タイトル＋最小化トグル） */}
      <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4,
        borderBottom: collapsed ? 'none' : labelStyle.borderBottom }}>
        <span style={{ fontWeight: 600, flex: 1 }}>ミニマップ</span>
        <button onClick={() => setCollapsed(c => !c)} title={collapsed ? '開く' : '最小化'}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 11, color: '#495057', padding: '0 2px', lineHeight: 1 }}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && (<>
      {/* 全体マップ */}
      <div style={labelStyle}>layer 0</div>
      <canvas
        ref={ovRef}
        width={MINIMAP_W} height={ovH}
        style={{ display: 'block', cursor: 'crosshair' }}
        onClick={e => { if (ovRef.current) handleCanvasClick(ovRef.current, ovBounds.current, e) }}
      />

      {/* コンテキストマップ: layer 4以上のみ表示 */}
      {layer > CONTEXT_OFFSET && (
        <>
          <div style={{ ...labelStyle, borderTop: '1px solid #e9ecef' }}>
            layer {layer - CONTEXT_OFFSET}
          </div>
          <canvas
            ref={ctxRef}
            width={MINIMAP_W} height={CONTEXT_H}
            style={{ display: 'block', cursor: 'crosshair' }}
            onClick={e => { if (ctxRef.current) handleCanvasClick(ctxRef.current, ctxRect.current, e) }}
          />
        </>
      )}

      {/* 移動確認バー */}
      {pendingTarget && (
        <div style={{
          padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6,
          background: '#fff9db', borderTop: '1px solid #ffe066',
        }}>
          <span style={{ fontSize: 11, color: '#5c4400', fontFamily: 'sans-serif', flex: 1 }}>
            この位置に移動?
          </span>
          <button
            onClick={() => { onNavigate(pendingTarget.x, pendingTarget.y); setPendingTarget(null) }}
            style={{ fontSize: 11, padding: '2px 8px', background: '#228be6', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', fontFamily: 'sans-serif' }}
          >
            移動
          </button>
          <button
            onClick={() => setPendingTarget(null)}
            style={{ fontSize: 11, padding: '2px 6px', background: '#dee2e6', color: '#333', border: 'none', borderRadius: 3, cursor: 'pointer', fontFamily: 'sans-serif' }}
          >
            ×
          </button>
        </div>
      )}
      </>)}
    </div>
  )
}
