import { useEffect, useRef, useState } from 'react'
import { fetchBlocks, fetchBlockWindow, warmBlocks } from '../api/client'
import { mountBlockMsa, BlockMsaHandle, BlockRef, BlockView } from './blockMsaRender'

// 多解像度 MSA（共線ブロック）パネル。中身は vanilla の blockMsaRender（試作の移植）。
//   ・db が変わるたびに /api/blocks（サイドカー JSON）を取り直して描き直す
//   ・ブロックの選択/ホバーを App へ返す（App が参照区間 → 表示層のノード名に解き、グラフを強調）
//   ・onReady で handle を渡す（グラフでノードを選んだときに App が selectByRef で逆に選ぶ）
//   ・事前計算に無い窓は onDrill → POST /api/blocks/window（常駐 Python ワーカー）。開いた時に /warm で温める
interface Props {
  db: string | null
  onSelectBlock?: (b: BlockRef | null) => void
  onHoverBlock?: (b: BlockRef | null) => void
  onView?: (v: BlockView | null) => void            // 見えている窓・段のブロックと色（グラフの塗り分け用）、範囲（グラフ連動用）
  onSelectHap?: (groupKey: string, hap: string) => void   // 行ラベルのクリック → グラフのパス群の選択切替
  hapMarks?: Map<string, string>                    // グラフで選択中のパス群（鍵→色）→ 行ラベルの印
  onReady?: (h: BlockMsaHandle | null) => void
}

export default function BlockMsa({ db, onSelectBlock, onHoverBlock, onView, onSelectHap, hapMarks, onReady }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<BlockMsaHandle | null>(null)
  const cbRef = useRef({ onSelectBlock, onHoverBlock, onView, onSelectHap })
  useEffect(() => { cbRef.current = { onSelectBlock, onHoverBlock, onView, onSelectHap } }, [onSelectBlock, onHoverBlock, onView, onSelectHap])
  useEffect(() => { handleRef.current?.setHapMarks(hapMarks ?? new Map()) }, [hapMarks])
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    handleRef.current?.destroy(); handleRef.current = null; onReady?.(null)
    if (!db) { setMsg('アトラスを選んでください'); return }
    setMsg('読み込み中…')
    fetchBlocks(db).then(data => {
      if (!live || !rootRef.current) return
      if (data.error || !Array.isArray(data.windows) || data.windows.length === 0) { setMsg(data.error || 'ブロックのサイドカーが空です'); return }
      setMsg(null)
      handleRef.current = mountBlockMsa(rootRef.current, data, {
        onSelectBlock: b => cbRef.current.onSelectBlock?.(b),
        onHoverBlock: b => cbRef.current.onHoverBlock?.(b),
        onDrill: req => fetchBlockWindow(db, req),          // 事前計算に無い窓を backend で逐次計算
        onView: v => cbRef.current.onView?.(v),
        onSelectHap: (k, h) => cbRef.current.onSelectHap?.(k, h),
      })
      handleRef.current.setHapMarks(hapMarks ?? new Map())
      onReady?.(handleRef.current)
      void warmBlocks(db)                                   // ワーカーを先に起こして Ctx を温める（初回の降下を速く）
    }).catch(e => { if (live) setMsg('読み込みに失敗: ' + String(e)) })
    return () => { live = false; handleRef.current?.destroy(); handleRef.current = null; onReady?.(null) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {msg && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#667', font: '13px sans-serif' }}>{msg}</div>}
      <div ref={rootRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
