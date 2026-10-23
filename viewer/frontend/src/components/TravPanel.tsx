import { useEffect, useRef, useState } from 'react'
import { mountTrav, TravHandle } from './travRender'
import BubbleMsa from './BubbleMsa'

// 通過（Traversals）パネル: 新しい錨（ハプロタイプ単位の一意性）と通過（複数回の出現）に基づくシンテニー表示。中身は vanilla の travRender。
//   ・db が変わるたびに作り直す（/api/trav/root）
//   ・塩基へ: 各通過の窓の中のトークン範囲を、パネルの下半分の塩基レベル MSA（BubbleMsa、範囲は distill のパス番号）に出す
//   ・グラフ連動: 表示範囲の錨のノード名を App へ（寄せる・強調）。グラフを絞る: 範囲のノード集合を App へ。行ラベルのクリック → パス群の選択
//   ・onReady で handle を渡す（グラフでノードを選ぶと App が locateNodes、「グラフの範囲を開く」で openNames）
interface Props {
  db: string | null
  onVisible?: (v: { names: string[]; sync: boolean } | null) => void
  onSelectHap?: (hap: string) => void
  onFilter?: (sel: { names: string[] } | null) => void
  onGraphRange?: () => void
  onReady?: (h: TravHandle | null) => void
}
export default function TravPanel({ db, onVisible, onSelectHap, onFilter, onGraphRange, onReady }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const hRef = useRef<TravHandle | null>(null)
  const cbRef = useRef({ onVisible, onSelectHap, onFilter, onGraphRange, onReady })
  useEffect(() => { cbRef.current = { onVisible, onSelectHap, onFilter, onGraphRange, onReady } }, [onVisible, onSelectHap, onFilter, onGraphRange, onReady])
  const [msaReq, setMsaReq] = useState<{ ranges: [number, number, number][]; label: string; key: number } | null>(null)
  const [msaH, setMsaH] = useState(260)
  useEffect(() => {
    hRef.current?.destroy(); hRef.current = null; cbRef.current.onReady?.(null)
    if (!db || !rootRef.current) return
    setMsaReq(null)
    hRef.current = mountTrav(rootRef.current, { db, params: new URLSearchParams(window.location.search) }, {   // ?view=a-b&mode=…&shot=… を主画面でも受ける（撮影・再現用）
      onBaseMsa: (ranges, label) => setMsaReq({ ranges, label, key: Date.now() }),
      onVisible: v => cbRef.current.onVisible?.(v),
      onSelectHap: h => cbRef.current.onSelectHap?.(h),
      onFilter: sel => cbRef.current.onFilter?.(sel),
      onGraphRange: () => cbRef.current.onGraphRange?.(),
    })
    cbRef.current.onReady?.(hRef.current)
    return () => { hRef.current?.destroy(); hRef.current = null; cbRef.current.onReady?.(null); cbRef.current.onFilter?.(null) }
  }, [db])
  // 塩基 MSA の高さ（ドラッグ）
  function onHandleDown(e: React.MouseEvent) {
    e.preventDefault(); const y0 = e.clientY, h0 = msaH
    const move = (ev: MouseEvent) => setMsaH(Math.max(80, Math.min(window.innerHeight - 200, h0 + (y0 - ev.clientY))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={rootRef} style={{ flex: '1 1 0', minHeight: 0 }} />
      {msaReq && (
        <>
          <div onMouseDown={onHandleDown} title="ドラッグで塩基 MSA の高さを変える" style={{ height: 6, cursor: 'row-resize', background: '#dfe3e8', borderTop: '1px solid #c8cdd3', flexShrink: 0 }} />
          <div style={{ height: msaH, flexShrink: 0, position: 'relative', overflow: 'hidden', background: '#fff' }}>
            <button onClick={() => setMsaReq(null)} title="塩基 MSA を閉じる" style={{ position: 'absolute', right: 10, top: 4, zIndex: 5, font: '12px system-ui', padding: '1px 7px' }}>✕ 閉じる</button>
            <BubbleMsa db={db} pickedNodes={[]} pickMode={false} onTogglePick={() => {}} onRemoveNode={() => {}} onClearNodes={() => {}} onFillBetween={() => {}} sampleKeys={[]} ribbonLevel="none" rangeReq={msaReq} />
          </div>
        </>
      )}
    </div>
  )
}
