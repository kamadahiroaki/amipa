import { useEffect, useRef } from 'react'
import { mountTrav, TravHandle } from './travRender'

// 通過（Traversals）パネル: 新しい錨（ハプロタイプ単位の一意性）と通過（複数回の出現）に基づくシンテニー表示。中身は vanilla の travRender。
//   ・db が変わるたびに作り直す（/api/trav/root）
//   ・塩基へ: 各通過の窓の中のトークン範囲を塩基レベル MSA（MSA パネル）へ渡す
//   ・グラフ連動: 表示範囲の錨のノード名を App へ（寄せる・強調）。行ラベルのクリック → パス群の選択
interface Props {
  db: string | null
  onBaseMsa?: (ranges: [number, number, number][], label: string) => void
  onVisible?: (v: { names: string[]; sync: boolean } | null) => void
  onSelectHap?: (hap: string) => void
}
export default function TravPanel({ db, onBaseMsa, onVisible, onSelectHap }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const hRef = useRef<TravHandle | null>(null)
  const cbRef = useRef({ onBaseMsa, onVisible, onSelectHap })
  useEffect(() => { cbRef.current = { onBaseMsa, onVisible, onSelectHap } }, [onBaseMsa, onVisible, onSelectHap])
  useEffect(() => {
    hRef.current?.destroy(); hRef.current = null
    if (!db || !rootRef.current) return
    hRef.current = mountTrav(rootRef.current, { db, params: new URLSearchParams(window.location.search) }, {   // ?view=a-b&mode=…&sync=1 を主画面でも受ける（撮影・再現用）
      onBaseMsa: (r, l) => cbRef.current.onBaseMsa?.(r, l),
      onVisible: v => cbRef.current.onVisible?.(v),
      onSelectHap: h => cbRef.current.onSelectHap?.(h),
    })
    return () => { hRef.current?.destroy(); hRef.current = null }
  }, [db])
  return <div ref={rootRef} style={{ width: '100%', height: '100%' }} />
}
