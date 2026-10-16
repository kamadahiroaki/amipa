// ヘッドレスの煙試験: blockMsaRender を jsdom + canvas スタブで動かし、実データ（配信中の backend）で描画と操作を通して例外を拾う
//   実行は run.sh（esbuild で束ねてから node）。AMIPA_BASE=http://host:port AMIPA_DB=ecoli50.db
import { JSDOM, VirtualConsole } from 'jsdom'
import fs from 'node:fs'
const BASE = process.env.AMIPA_BASE || 'http://localhost:33001'; const DB = process.env.AMIPA_DB || 'ecoli50.db'
const errors = []
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message))); vc.sendTo(console, { omitJSDOMErrors: true })
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc })
const W = dom.window
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'DOMParser']) { try { globalThis[k] = W[k] } catch {} }
globalThis.devicePixelRatio = 1; W.devicePixelRatio = 1
W.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })
W.ResizeObserver = globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }
Object.defineProperty(W.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
// 要素の大きさ: jsdom は 0 なので、幅 1200 / 高さ 600 を返す
Object.defineProperty(W.HTMLElement.prototype, 'clientWidth', { get(){ return 1200 }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'clientHeight', { get(){ return 600 }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'offsetWidth', { get(){ return 1200 }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'offsetHeight', { get(){ return 600 }, configurable: true })
W.Element.prototype.getBoundingClientRect = function(){ return { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 600, right: 1200, bottom: 600 } }
// canvas 2D のスタブ: すべてのメソッドは何もしない。measureText は文字数で幅を返す
const mkCtx = () => new Proxy({ canvas: null, _props: {} }, { get(t, k){ if (k === 'measureText') return s => ({ width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }); if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop(){} }); if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h }); if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h }); if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); if (k === 'isPointInPath' || k === 'isPointInStroke') return () => false; if (k in t._props) return t._props[k]; if (typeof k === 'string' && /^[a-z]/.test(k) && !(k in t)) return () => {}; return t[k] }, set(t, k, v){ t._props[k] = v; return true } })
W.HTMLCanvasElement.prototype.getContext = function(){ if (!this._ctx) { this._ctx = mkCtx() } return this._ctx }
W.HTMLCanvasElement.prototype.toDataURL = () => 'data:,'
const realFetch = globalThis.fetch
globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : u, o)
process.on('uncaughtException', e => { errors.push('uncaught: ' + (e && e.stack || e)) })
process.on('unhandledRejection', e => { errors.push('unhandledRejection: ' + (e && e.stack || e)) })
W.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)))
const { mountBlockMsa, api } = await import('./bundle.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const root = W.document.getElementById('root')
const t0 = Date.now()
const data = await api.fetchBlocks(DB); console.log('root fetched', Date.now() - t0, 'ms; meta.tree', !!data.meta?.tree, 'meta.genes', !!data.meta?.genes, 'windows', data.windows?.length)
let views = []
let handle
try {
  handle = mountBlockMsa(root, data, {
    onSelectBlock: () => {}, onHoverBlock: () => {},
    onDrill: req => api.fetchBlockWindow(DB, req),
    onRange: (x0, x1, label, depth, parent, pblock) => api.fetchBlockRange(DB, x0, x1, label, depth, parent, pblock),
  onRangeAtoms: (a0, a1, label, depth, parent) => api.fetchBlockRangeAtoms(DB, a0, a1, label, depth, parent),
    onSites: q => api.fetchBlockSites(DB, q),
    onTokRanges: (c0, c1) => api.fetchBlockTokRanges(DB, c0, c1),
    onGenes: ranges => api.fetchBlockGenes(DB, ranges),
    onGenesCols: (c0, c1, paths) => api.fetchBlockGenesCols(DB, c0, c1, paths),
    onGenesTok: ranges => api.fetchBlockGenesTok(DB, ranges),
    onJunction: jid => api.fetchBlockJunction(DB, jid), onFeature: q => api.fetchBlockFeature(DB, q), onJunctions: () => api.fetchBlockJunctions(DB), onJunctionBase: (jid, k) => api.fetchBlockJunctionBase(DB, jid, k),
    onJunctionGenes: (jid, n) => api.fetchBlockJunctionGenes(DB, jid, n),
    onOrth: (c0, c1, max) => api.fetchBlockOrth(DB, c0, c1, max), onOrthRows: (c0, c1, paths) => api.fetchBlockOrthRows(DB, c0, c1, paths),
    onOrthGroup: og => api.fetchBlockOrthGroup(DB, og), onOrthFind: (q, limit) => api.fetchBlockOrthFind(DB, q, limit),
    onBaseFetch: (ranges, label, maxLeaves) => api.fetchBubbleMsaRanges(DB, ranges, label, 0, 0, maxLeaves),
    onLocate: names => api.fetchBlockLocate(DB, names),
    onView: v => views.push(v), onSelectHap: () => {}, onBaseMsa: () => {},
  })
} catch (e) { errors.push('mount: ' + e.stack) }
const $ = id => root.querySelector('#bk_' + id)
const state = tag => console.log(`[${tag}]`, 'junclist.disabled', $('junclist')?.disabled, '| wide', root.classList.contains('detailwide'), '| crumbs', root.querySelector('#bk_crumbs')?.textContent?.trim().slice(0, 40), '| errors', errors.length)
await sleep(1500); state('after mount')
// 見出しの遺伝子トラック: 全体では密度、原子 1 個に降りると矢印
const gt = () => ({ cls: root.classList.contains('gtrack'), w: $('gtrack')?.clientWidth });
await sleep(2500); console.log('[gene track] class', gt().cls, '| errors', errors.length)
// 列見出しをダブルクリックして先頭のブロックの内側へ（アレル行列か塩基）→ トラックが矢印になり行の差分が描かれる
try { const hdr = $('hdr'); const ly = handle._layout(); const c = (ly.cols || []).find(x => x.type === 'block'); if (c) { const ev = new W.MouseEvent('dblclick', { bubbles: true, clientX: c.x + 5, clientY: 20 }); hdr.dispatchEvent(ev); await sleep(8000); console.log('[after drill] mode', views.at(-1)?.mode, 'crumbs', root.querySelector('#bk_crumbs')?.textContent?.trim().slice(0, 50), 'gtrack class', gt().cls, 'errors', errors.length);
    await sleep(4000); console.log('[after drill+4s] errors', errors.length, 'orth loaded', !!handle._layout() && root.classList.contains('gtrack'));
    const gtr = $('gtrack'); if (gtr) { gtr.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 10 })); console.log('  track hover tip:', ($('tip')?.textContent || '').slice(0, 120)); gtr.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 300, clientY: 10 })); await sleep(300); console.log('  track click detail:', root.querySelector('#bk_detailbody')?.textContent?.trim().slice(0, 140)); }
    // 遺伝子の運命の表 → 戻る → トラックをダブルクリックしてその遺伝子の窓を開く
    const fate = root.querySelector('#bk_detailbody button[data-act="ogfate"]'); if (fate) { fate.click(); await sleep(2500); console.log('  fate table rows', root.querySelectorAll('#bk_detailbody table tr').length - 1, '| head:', root.querySelector('#bk_detailbody')?.textContent?.trim().slice(0, 120)); }
    const gtr2 = $('gtrack'); if (gtr2) { gtr2.dispatchEvent(new W.MouseEvent('dblclick', { bubbles: true, clientX: 300, clientY: 10 })); await sleep(8000); console.log('[after gene dblclick] mode', views.at(-1)?.mode, 'crumbs', root.querySelector('#bk_crumbs')?.textContent?.trim().slice(0, 60), 'errors', errors.length); $('scopeout').click(); await sleep(1500); }
    // GFF の 1 行の全項目（遺伝子をクリックしたときの詳細。.genes format 2）
    try { handle._showFeature({ gid: 1 }); await sleep(2500); const d = root.querySelector('#bk_detailbody')?.textContent || ''; console.log('[feature gid=1]', /属性（第 9 列/.test(d) ? 'OK' : 'NG', d.replace(/\s+/g, ' ').slice(0, 110)); if (!/属性（第 9 列/.test(d)) errors.push('feature detail missing'); } catch (e) { errors.push('feature: ' + e.stack) }
    // 名前検索
    try { const inp = $('gfind'); inp.value = 'rlu'; inp.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(2500); console.log('[gfind rzp] detail:', root.querySelector('#bk_detailbody')?.textContent?.trim().slice(0, 120)); const sel = root.querySelector('#bk_detailbody [data-act="ogsel"]'); if (sel) { sel.click(); await sleep(8000); console.log('  after select: mode', views.at(-1)?.mode, 'crumbs', root.querySelector('#bk_crumbs')?.textContent?.trim().slice(0, 60), 'errors', errors.length); $('scopeout').click(); await sleep(1500); } } catch (e) { errors.push('gfind: ' + e.stack) }
    // 外へ戻る
    $('scopeout').click(); await sleep(1500); console.log('[back to root] crumbs', root.querySelector('#bk_crumbs')?.textContent?.trim().slice(0, 30), 'errors', errors.length) } } catch (e) { errors.push('drill: ' + e.stack) }
try { const r = await api.fetchBlockOrth(DB, 240689, 255833); console.log('  orth atom94 groups', r?.groups?.length, 'H', r?.H); const rr = await api.fetchBlockOrthRows(DB, 240689, 255833); console.log('  orth_rows rows', rr?.rows?.length) } catch (e) { errors.push('orth api: ' + e.stack) }
// 系統樹: 閾値で枝をまとめる（スライダ 40）→ 群を開く → 表示範囲の木 → 戻す
const nrows = () => root.querySelectorAll('#bk_labwrap .lab').length; const ncl = () => root.querySelectorAll('#bk_tree .cl').length
console.log('[tree] rows', nrows(), 'wedges', ncl(), 'cuttxt', $('cuttxt')?.textContent, 'treeinfo', $('treeinfo')?.textContent)
try { const sl = $('cut'); sl.value = '40'; sl.dispatchEvent(new W.Event('input', { bubbles: true })) } catch (e) { errors.push('cut: ' + e.stack) }
await sleep(400); console.log('[tree cut=40] rows', nrows(), 'wedges', ncl(), 'cuttxt', $('cuttxt')?.textContent, 'badges', root.querySelectorAll('#bk_labwrap .lab small[title^="まとめた群"]').length)
const wedge = root.querySelector('#bk_tree .cl'); if (wedge) { wedge.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true })); console.log('  wedge hover:', ($('tip')?.textContent || '').slice(0, 100)); wedge.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); await sleep(300); console.log('  after wedge click: rows', nrows(), 'wedges', ncl()) }
try { $('t_range').click() } catch (e) { errors.push('t_range: ' + e.stack) }
await sleep(500); console.log('[range tree] rows', nrows(), 'wedges', ncl(), 'treeinfo', $('treeinfo')?.textContent)
try { const sl = $('cut'); sl.value = '100'; sl.dispatchEvent(new W.Event('input', { bubbles: true })) } catch (e) { errors.push('cut100: ' + e.stack) }
await sleep(400); console.log('[range tree, no cut] rows', nrows(), 'wedges', ncl())
// 二段の木を合成データで: 2,000 点の 2 次元ユークリッド
if (handle && handle._treeFromDist) { const n = 2000; const P = Array.from({ length: n }, (_, i) => [Math.cos(i % 37) * 10 + (i % 7), Math.sin(i % 53) * 10 + (i % 11) / 3]); const dist = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]); const t1 = Date.now(); const T = handle._treeFromDist(n, dist, P.map((_, i) => 'h' + i), true); const ms = Date.now() - t1
  const seen = new Set(T.order); let mono = true; for (const id of Object.keys(T.nodes)) { const nd = T.nodes[id]; if (nd.ch) for (const c of nd.ch) if (T.nodes[c].h > nd.h + 1e-9) mono = false }
  console.log('[two-level synthetic] n', n, 'ms', ms, 'how', T.how, 'k', T.k, 'leaves in order', seen.size, 'monotone', mono, 'root h', T.nodes[T.root].h.toFixed(3))
  const t2 = Date.now(); const T2 = handle._treeFromDist(600, dist, P.slice(0, 600).map((_, i) => 'h' + i), true); console.log('[full n=600] ms', Date.now() - t2, 'how', T2.how, 'leaves', new Set(T2.order).size) }
// 接合一覧ボタンを押す
try { $('junclist').click() } catch (e) { errors.push('junclist click: ' + e.stack) }
await sleep(3000); state('after junclist'); console.log('  detail:', root.querySelector('#bk_detailbody')?.textContent?.trim().slice(0, 100))
const tr = root.querySelector('#bk_detailbody tr[data-jid]'); if (tr) { console.log('  first row jid', tr.getAttribute('data-jid')); tr.click(); await sleep(2000); state('after card') }
// カードの「遺伝子の並びを比べる」→ 戻る
const jg = root.querySelector('#bk_detailbody button[data-act="jgenes"]'); if (jg) { jg.click(); await sleep(5000); state('after jgenes'); const svg = root.querySelector('#bk_detailbody svg'); console.log('  jgenes: polygons', svg ? svg.querySelectorAll('polygon').length : -1)
  const poly = svg && svg.querySelector('polygon'); if (poly) { poly.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true })); console.log('  hover info:', root.querySelector('#bk_jginfo')?.textContent?.slice(0, 100)) }
  const back = root.querySelector('#bk_detailbody button[data-act="jcard"]'); if (back) { back.click(); await sleep(2000); state('after back-to-card') } }
// カードの「この接合の塩基を見る」
const jb = root.querySelector('#bk_detailbody button[data-act="jbase"]'); if (jb) { jb.click(); await sleep(9000); state('after jbase'); console.log('  detail:', root.querySelector('#bk_detailbody')?.textContent?.trim().slice(0, 100)); const lv = views.at(-1); console.log('  last view: mode', lv?.mode, 'filterSel', lv?.filterSel ? Object.keys(lv.filterSel)[0] + (lv.filterSel.names ? ':' + lv.filterSel.names.length : '') : null, 'nodeNames', lv?.nodeNames?.length)
  // 塩基の窓でも表示範囲の木を作る
  try { $('t_range').click(); await sleep(500); console.log('  [range tree in base] rows', nrows(), 'treeinfo', $('treeinfo')?.textContent); $('t_global').click(); await sleep(300) } catch (e) { errors.push('range tree base: ' + e.stack) } }
// ✕ で閉じる → ⤢ → Esc
try { root.querySelector('#bk_close').click() } catch (e) { errors.push('close: ' + e.stack) }
await sleep(300); state('after close')
try { $('wide').click() } catch (e) { errors.push('wide: ' + e.stack) }
await sleep(300); state('after wide')
try { W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) } catch (e) { errors.push('esc: ' + e.stack) }
await sleep(300); state('after esc')
if (process.argv.includes('--dump')) fs.writeFileSync(new URL('./smoke_dom.html', import.meta.url), root.innerHTML)
console.log('views emitted', views.length, 'last mode', views.at(-1)?.mode)
console.log('ERRORS', errors.length); for (const e of errors.slice(0, 10)) console.log('  ' + String(e).split('\n').slice(0, 4).join('\n    '))
process.exit(errors.length ? 1 : 0)
