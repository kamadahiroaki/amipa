// 通過の試作ページ: DB 選択 ＋ Traversals パネル（components/travRender.ts）。主画面と同じ部品を単体で確かめるためのページ
import '../ui.css'
import { mountTrav, TravHandle } from '../components/travRender'
const sel = document.getElementById('db') as HTMLSelectElement; let h: TravHandle | null = null
const params = new URLSearchParams(location.search)
// 撮影用（?shot=ms）: モジュール評価の時点で load を遅らせる画像を置く（mount は DB 一覧の後＝load の後なので、ここで置かないと間に合わない）
if (params.get('shot')) { const im = document.createElement('img'); im.src = `/api/sleep?ms=${Math.max(0, Math.min(20000, Number(params.get('shot')) || 8000))}`; im.style.cssText = 'position:absolute;left:-9px;top:-9px;width:1px;height:1px'; document.body.appendChild(im) }
// sync=1（headless firefox の撮影用）は DB 一覧も同期 XHR で取り、load までに描き終える
const listDbs = (): Promise<string[]> => { if (params.get('sync') !== '1') return fetch('/api/databases').then(r => r.json()); const x = new XMLHttpRequest(); x.open('GET', '/api/databases', false); x.send(null); return Promise.resolve(JSON.parse(x.responseText)) }
listDbs().then((dbs: string[]) => {
  sel.innerHTML = dbs.map(d => `<option>${d}</option>`).join(''); const q = params.get('db'); if (q && dbs.includes(q)) sel.value = q
  h = mountTrav(document.getElementById('root')!, { db: sel.value, params, page: true }, {})
})
sel.addEventListener('change', () => { history.replaceState(null, '', `?db=${encodeURIComponent(sel.value)}`); h?.setDb(sel.value) })
