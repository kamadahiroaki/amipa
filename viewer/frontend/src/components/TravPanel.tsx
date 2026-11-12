import { useEffect, useRef } from 'react'
import { mountTrav, TravHandle } from './travRender'
import type { OvPeak } from './travOverview'

// 通過（Traversals）パネル: 新しい錨（ハプロタイプ単位の一意性）と通過（複数回の出現）に基づくシンテニー表示。中身は vanilla の travRender。
//   ・db が変わるたびに作り直す（/api/trav/root）
//   ・塩基へ: 各通過の窓の中のトークン範囲を塩基の段（travRender の中、Blocks と同じ見え方）に出す（範囲は distill のパス番号）
//   ・グラフ連動: 表示範囲の錨のノード名を App へ（寄せる・強調）。グラフを絞る: 範囲のノード集合を App へ。行ラベルのクリック → パス群の選択
//   ・onReady で handle を渡す（グラフでノードを選ぶと App が locateNodes、「グラフの範囲を開く」で openNames）
interface Props {
  db: string | null
  onVisible?: (v: { names: string[]; sync: boolean } | null) => void
  onSelectHap?: (hap: string) => void
  onSelectHaps?: (haps: string[], on: boolean) => void   // まとめて選ぶ・外す（木の枝、選択を外す）。haps が空で on=false は全部外す
  onSelectContig?: (path: string) => void               // 片のクリック → そのコンティグのリボン
  onFilter?: (sel: { names: string[] } | null) => void
  onGraphRange?: () => void
  onReady?: (h: TravHandle | null) => void
  onHoverNodes?: (names: string[] | null) => void   // 塩基の段でホバーしたノード（グラフで強調）
  hapMarks?: Map<string, string>                    // 主画面で選択中のパス群（ハプロタイプ名 → 色）→ 行ラベルの丸
  onRange?: (v: { names: string[]; colors: number[] | null; fit: boolean; hide: boolean; direct?: boolean; fitNames?: string[] } | null) => void   // 表示範囲のノードと色（塗る・範囲外を薄灰か非表示・fitNames があれば寄せる）
  getVisibleNames?: () => string[]                  // グラフに見えているノード名（広い範囲の塗り分け）
  getVisibleNodes?: () => { name: string; x: number; y: number; loc?: { x: number; kind: number; frac?: number; xmin?: number; xmax?: number } }[]   // 同じノードの位置（全体図の山・グラフ側の札）。loc＝/nodes に載った合意座標（11-12）
  getGraphViewport?: () => { x1: number; x2: number; y1: number; y2: number } | null
  onPeaks?: (peaks: OvPeak[] | null) => void        // 全体図の山（文字つき）
  onPeakHover?: (letter: string | null, names: string[] | null, color?: number | null) => void
  onPeakPicked?: (peak: OvPeak) => void
}
export default function TravPanel({ db, onVisible, onSelectHap, onSelectHaps, onSelectContig, onFilter, onGraphRange, onReady, onHoverNodes, hapMarks, onRange, getVisibleNames, getVisibleNodes, getGraphViewport, onPeaks, onPeakHover, onPeakPicked }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const hRef = useRef<TravHandle | null>(null)
  const cbRef = useRef({ onVisible, onSelectHap, onSelectHaps, onSelectContig, onFilter, onGraphRange, onReady, onHoverNodes, onRange, getVisibleNames, getVisibleNodes, getGraphViewport, onPeaks, onPeakHover, onPeakPicked })
  useEffect(() => { cbRef.current = { onVisible, onSelectHap, onSelectHaps, onSelectContig, onFilter, onGraphRange, onReady, onHoverNodes, onRange, getVisibleNames, getVisibleNodes, getGraphViewport, onPeaks, onPeakHover, onPeakPicked } }, [onSelectContig, onVisible, onSelectHap, onSelectHaps, onFilter, onGraphRange, onReady, onHoverNodes, onRange, getVisibleNames, getVisibleNodes, getGraphViewport, onPeaks, onPeakHover, onPeakPicked])
  useEffect(() => { hRef.current?.setHapMarks(hapMarks ?? new Map()) }, [hapMarks])
  useEffect(() => {
    hRef.current?.destroy(); hRef.current = null; cbRef.current.onReady?.(null)
    if (!db || !rootRef.current) return
    hRef.current = mountTrav(rootRef.current, { db, params: new URLSearchParams(window.location.search) }, {   // ?view=a-b&mode=…&base=1 を主画面でも受ける（撮影・再現用）
      onVisible: v => cbRef.current.onVisible?.(v),
      onSelectHap: h => cbRef.current.onSelectHap?.(h),
      onSelectHaps: (hs, on) => cbRef.current.onSelectHaps?.(hs, on),
      onSelectContig: pn => cbRef.current.onSelectContig?.(pn),
      onFilter: sel => cbRef.current.onFilter?.(sel),
      onGraphRange: () => cbRef.current.onGraphRange?.(),
      onHoverNodes: names => cbRef.current.onHoverNodes?.(names),
      onRange: v => cbRef.current.onRange?.(v),
      getVisibleNames: () => cbRef.current.getVisibleNames?.() ?? [],
      getVisibleNodes: () => cbRef.current.getVisibleNodes?.() ?? [],
      getGraphViewport: () => cbRef.current.getGraphViewport?.() ?? null,
      onPeaks: p => cbRef.current.onPeaks?.(p),
      onPeakHover: (l, n, c) => cbRef.current.onPeakHover?.(l, n, c),
      onPeakPicked: q => cbRef.current.onPeakPicked?.(q),
    })
    hRef.current.setHapMarks(hapMarks ?? new Map())
    cbRef.current.onReady?.(hRef.current)
    return () => { hRef.current?.destroy(); hRef.current = null; cbRef.current.onReady?.(null); cbRef.current.onFilter?.(null); cbRef.current.onHoverNodes?.(null); cbRef.current.onRange?.(null); cbRef.current.onPeaks?.(null) }
  }, [db])
  return <div ref={rootRef} style={{ width: '100%', height: '100%' }} />
}
