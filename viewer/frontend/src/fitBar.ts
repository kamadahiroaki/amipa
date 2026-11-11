// 横一列のバーを折り返さずに収める（11-11）。バーの幅が足りなくなったら段階的に詰める。
//   data-fit="0" 通常 → "1" 余白を詰め、.fit-opt を隠す → "2" [data-short] の文字を略称に、.fit-opt2 を隠す → "3" [data-tiny] を頭文字に、.fit-opt3 を隠す
//   文字の差し替えは CSS だけ（要素の font-size を 0 にして ::after に attr() を出す）。DOM を書き換えないので React の管理する文字とぶつからない。
//   はみ出しは「直下の子（流れの中にあるもの）の右端がバーの内側の右端を越えるか」で見る。開いたメニュー（absolute）は数えない。
export function fitBar(el: HTMLElement, max = 3): () => void {
  let raf = 0
  const over = (): boolean => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const right = r.right - parseFloat(cs.paddingRight || '0') + 0.5
    for (const c of Array.from(el.children) as HTMLElement[]) {
      const p = getComputedStyle(c); if (p.display === 'none' || p.position === 'absolute' || p.position === 'fixed') continue
      if (c.getBoundingClientRect().right > right) return true
    }
    return false
  }
  const run = () => { raf = 0; let lv = 0; el.dataset.fit = '0'; while (lv < max && over()) { lv++; el.dataset.fit = String(lv) } }
  const sched = () => { if (!raf) raf = requestAnimationFrame(run) }
  const ro = new ResizeObserver(sched); ro.observe(el)
  // 中身（範囲の文字・ボタンの出し入れ）が変わったら測り直す。data-fit 自身の変更は attributeFilter に無いので拾わない
  const mo = new MutationObserver(sched); mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'disabled'] })
  sched()
  return () => { ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf) }
}
