// 通過の試作ページ: DB 選択 ＋ Traversals パネル（components/travRender.ts）。主画面と同じ部品を単体で確かめるためのページ
import { mountTrav, TravHandle } from '../components/travRender'
const sel = document.getElementById('db') as HTMLSelectElement; let h: TravHandle | null = null
const params = new URLSearchParams(location.search)
fetch('/api/databases').then(r => r.json()).then((dbs: string[]) => {
  sel.innerHTML = dbs.map(d => `<option>${d}</option>`).join(''); const q = params.get('db'); if (q && dbs.includes(q)) sel.value = q
  h = mountTrav(document.getElementById('root')!, { db: sel.value, params, page: true }, {})
})
sel.addEventListener('change', () => { history.replaceState(null, '', `?db=${encodeURIComponent(sel.value)}`); h?.setDb(sel.value) })
