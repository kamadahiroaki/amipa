import { useEffect, useRef, useState } from 'react'
import type { OvPeak } from './travOverview'

// グラフの上の札（11-05）: Traversals の全体図の山 A・B・C… に属するノードの塊に、同じ文字の札と細い枠（ノードの位置の 10–90 パーセンタイル）を重ねる。
//   色相は使わない（色相はパネルで開いている範囲のブロックの色）。開いている範囲に掛かる山は実線、それ以外は破線
//   札にカーソル → その山のノードを強調し、全体図の同じ文字も強調。クリック → パネルをその山の範囲へ
interface Props {
  peaks: OvPeak[] | null
  viewport: { x1: number; x2: number; y1: number; y2: number }
  hover: string | null
  onHover: (letter: string | null) => void
  onPick: (letter: string) => void
}
export default function TravPeaksOverlay({ peaks, viewport, hover, onHover, onPick }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [sz, setSz] = useState<[number, number]>([0, 0])
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(() => setSz([el.clientWidth, el.clientHeight])); ro.observe(el); setSz([el.clientWidth, el.clientHeight])
    return () => ro.disconnect()
  }, [])
  const [W, H] = sz; const vw = viewport.x2 - viewport.x1, vh = viewport.y2 - viewport.y1
  const sx = (x: number) => (x - viewport.x1) / (vw || 1) * W, sy = (y: number) => (y - viewport.y1) / (vh || 1) * H
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, overflow: 'hidden' }}>
      {peaks && W > 0 && peaks.map(p => {
        const [a, b, c, d] = [sx(p.box[0]), sy(p.box[1]), sx(p.box[2]), sy(p.box[3])]
        const bw = c - a, bh = d - b; const on = hover === p.letter
        const showBox = bw > 8 && bh > 8 && bw * bh < 0.7 * W * H   // 画面のほとんどを覆う枠は描かない（札だけ）
        let lx = showBox ? a : sx(p.wx) - 8, ly = showBox ? b - 18 : sy(p.wy) - 8
        lx = Math.max(2, Math.min(W - 22, lx)); ly = Math.max(2, Math.min(H - 20, ly))
        return (
          <div key={p.letter}>
            {showBox && <div style={{ position: 'absolute', left: a, top: b, width: bw, height: bh, border: `${on ? 2 : 1}px ${p.inView ? 'solid' : 'dashed'} ${on ? '#000' : 'rgba(30,30,30,.55)'}`, borderRadius: 4, pointerEvents: 'none' }} />}
            <div
              title={`${p.letter}　${p.label}　${p.n.toLocaleString('en-US')} ノード（${Math.round(p.share * 100)}%）${p.inView ? '・パネルで表示中' : '・クリックでパネルをここへ'}`}
              onMouseEnter={() => onHover(p.letter)} onMouseLeave={() => onHover(null)} onClick={() => onPick(p.letter)}
              style={{ position: 'absolute', left: lx, top: ly, pointerEvents: 'auto', cursor: 'pointer', font: 'bold 12px system-ui', lineHeight: '16px', padding: '0 5px',
                background: on ? '#111' : '#fff', color: on ? '#fff' : '#111', border: `1px ${p.inView ? 'solid' : 'dashed'} #111`, borderRadius: 3, boxShadow: '0 1px 3px rgba(0,0,0,.25)', whiteSpace: 'nowrap' }}>
              {p.letter}{on ? `　${p.label}` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}
