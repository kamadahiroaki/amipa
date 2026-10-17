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

const data = await api.fetchBlocks(DB)
let views = []
const handle = mountBlockMsa(root, data, {
  onSelectBlock: () => {}, onHoverBlock: () => {}, onDrill: req => api.fetchBlockWindow(DB, req),
  onRange: (x0, x1, label, depth, parent, pblock) => api.fetchBlockRange(DB, x0, x1, label, depth, parent, pblock),
  onRangeAtoms: (a0, a1, label, depth, parent) => api.fetchBlockRangeAtoms(DB, a0, a1, label, depth, parent),
  onSites: q => api.fetchBlockSites(DB, q), onTokRanges: (c0, c1) => api.fetchBlockTokRanges(DB, c0, c1),
  onGenes: ranges => api.fetchBlockGenes(DB, ranges), onGenesCols: (c0, c1, paths) => api.fetchBlockGenesCols(DB, c0, c1, paths), onGenesTok: ranges => api.fetchBlockGenesTok(DB, ranges),
  onOrth: (c0, c1, max) => api.fetchBlockOrth(DB, c0, c1, max), onOrthRows: (c0, c1, paths) => api.fetchBlockOrthRows(DB, c0, c1, paths),
  onBaseFetch: (ranges, label, maxLeaves) => api.fetchBubbleMsaRanges(DB, ranges, label, 0, 0, maxLeaves), onLocate: names => api.fetchBlockLocate(DB, names), onFeature: q => api.fetchBlockFeature(DB, q),
  onView: v => views.push(v), onSelectHap: () => {}, onBaseMsa: () => {},
})
const $ = id => root.querySelector('#bk_' + id)
await sleep(1200)
const show = async (tag, wait = 9000) => { const t = Date.now(); while (handle._state().drilling && Date.now() - t < wait) await sleep(200); await sleep(300); const s = handle._state(); console.log(`[${tag}] mode=${s.mode} win=${s.win} label=${s.label} drilling=${s.drilling} nwins=${s.nwins} | toast: ${(root.querySelector('#bk_toast')?.style.display !== 'none' ? root.querySelector('#bk_toast')?.textContent : '') || ''} | errors ${errors.length}`) }
const back = async () => { $('scopeout').click(); await sleep(600) }
await show('root')
// S1: 全体で 1.23–1.25 Mb（原子 62+63 にまたがる）
handle._drillRange(1230000, 1250000); await show('S1 root → 1.23-1.25Mb')
// S2: その窓の中で同じ範囲をもう一度
handle._drillRange(1230000, 1250000); await show('S2 same range again')
await back(); await show('back')
// S3: その窓の中で原子 62 の内側（1.232–1.240）
handle._drillRange(1232000, 1240000); await show('S3 inside atom 62 (from 2-atom window)')
await back(); await show('back')
// S4: 境界をまたぐ 1.245–1.250（原子 62 末尾 + 63 先頭）
handle._drillRange(1245000, 1250000); await show('S4 across boundary 62/63')
await back(); await show('back')
await back(); await show('back to root')
// S5: 全体から直接 原子 62 の内側
handle._drillRange(1232000, 1240000); await show('S5 root → inside atom 62')
// S8: 塩基の段のズーム軸（README 改訂 117）: 入った直後は画面に収まる俯瞰（群 1 px 以上・アレル色）。「塩基」で 7 px/塩基になり横スクロール、
//     Shift+ホイール／格子のドラッグで bsx が動き当たり判定もずれた分を拾う。Ctrl+ホイールで倍率が変わる。「全体」で俯瞰に戻る
{ const s0 = handle._state(); const gw = $('gridwrap'); const grid = $('grid')
  handle._baseZoom(7); const s1 = handle._state()
  gw.dispatchEvent(new W.WheelEvent('wheel', { deltaY: 300, shiftKey: true, bubbles: true, cancelable: true })); const s2 = handle._state()
  grid.dispatchEvent(new W.MouseEvent('mousedown', { button: 0, clientX: 600, clientY: 20, bubbles: true })); W.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 400, clientY: 20 })); W.dispatchEvent(new W.MouseEvent('mouseup', { clientX: 400, clientY: 20 })); const s3 = handle._state()
  grid.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 100, clientY: 20, bubbles: true })); const tip = ($('hoverbody').textContent || '').replace(/\s+/g, ' ').slice(0, 50)
  gw.dispatchEvent(new W.WheelEvent('wheel', { deltaY: 300, ctrlKey: true, bubbles: true, cancelable: true })); const s4 = handle._state()
  handle._baseZoom('fit'); const s5 = handle._state()
  // 列見出しのドラッグ: その範囲を画面幅に（入れ子の窓は作らない）
  const hdr = $('hdr'); hdr.dispatchEvent(new W.MouseEvent('mousedown', { button: 0, clientX: 300, clientY: 10, bubbles: true })); W.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 600, clientY: 10 })); W.dispatchEvent(new W.MouseEvent('mouseup', { clientX: 600, clientY: 10 })); const s6 = handle._state()
  const okDrag = s6.nwins === s5.nwins && !s6.bzFit && s6.bz > s5.bz; if (!okDrag) errors.push('S8 header drag zoom: ' + JSON.stringify({ s5: [s5.nwins, s5.bz], s6: [s6.nwins, s6.bz, s6.bzFit] }))
  console.log(`[S8b header drag] bz ${s5.bz.toFixed(3)} → ${s6.bz.toFixed(3)} windows ${s5.nwins} → ${s6.nwins} | ${okDrag ? 'OK' : 'NG'}`); handle._baseZoom('fit')
  const ok = s0.mode === 'base' && s0.bzFit && s0.bfullW <= 1200 && s1.bcw === 7 && s1.bfullW > 1200 && s2.bsx === 300 && s3.bsx === 500 && /ノード/.test(tip) && s4.bz < 7 && s4.bz > 0 && s5.bzFit && s5.bfullW <= 1200
  if (!ok) errors.push('S8 base zoom: ' + JSON.stringify({ s0, s1: [s1.bcw, s1.bfullW], s2: s2.bsx, s3: s3.bsx, tip, s4: s4.bz, s5: [s5.bzFit, s5.bfullW] }))
  console.log(`[S8 base zoom] fit: bz=${s0.bz.toFixed(3)} items=${s0.nitems} fullW=${s0.bfullW} vOnly=${s0.bvOnly} | 塩基: cw=${s1.bcw} fullW=${s1.bfullW} | shift+wheel → bsx ${s2.bsx} | drag → bsx ${s3.bsx} | hover: ${tip.slice(0, 24)} | ctrl+wheel down → bz ${s4.bz} | 全体 → fit=${s5.bzFit} fullW=${s5.bfullW} | ${ok ? 'OK' : 'NG'}`) }
await back(); await show('back')
// S6: 全体から狭い範囲 1,230,000–1,230,600（塩基へ）
handle._drillRange(1230000, 1230600); await show('S6 root → 600 bp')
await back(); await show('back')
// S7: 全体から 1.23–1.25 の後、その中でさらに狭く（アレル行列→塩基）
handle._drillRange(1230000, 1250000); await show('S7a 2-atom window'); handle._drillRange(1236000, 1237000); await show('S7b → 1 kb inside'); 
// S9: 3,000 列超の原子 → 索引の俯瞰（1 サイト = 1 列、塩基セルなし）→ 列見出しの狭いドラッグで子の塩基の窓（README 改訂 118）
{ const A = data.meta.atoms; let big = -1, bestN = 1e9; A.forEach((a, i) => { const n = a[3] - a[2] + 1; if (n > 3000 && n < bestN){ bestN = n; big = i } })
  handle._zoomTo({ atoms: [big, big] }, 'S9 big atom'); await show(`S9 big atom #${big + 1} (${bestN} cols)`)
  const s0 = handle._state(); const hdr = $('hdr'); hdr.dispatchEvent(new W.MouseEvent('mousedown', { button: 0, clientX: 300, clientY: 10, bubbles: true })); W.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 330, clientY: 10 })); W.dispatchEvent(new W.MouseEvent('mouseup', { clientX: 330, clientY: 10 }))
  await show('S9b drag 30 px on index'); const s1 = handle._state()
  const ok = s0.mode === 'base' && s0.idx && s0.bcw === 0 && s0.nitems > 0 && s1.mode === 'base' && !s1.idx && s1.nwins === s0.nwins + 1
  if (!ok) errors.push('S9 index overview: ' + JSON.stringify({ s0, s1 })); console.log(`[S9 index] overview idx=${s0.idx} items=${s0.nitems} bz=${(s0.bz || 0).toFixed(3)} → drag → idx=${s1.idx} mode=${s1.mode} windows ${s0.nwins}→${s1.nwins} | ${ok ? 'OK' : 'NG'}`) }
console.log('ERRORS', errors.length); for (const e of errors.slice(0, 5)) console.log('  ' + String(e).split('\n').slice(0, 3).join('\n    '))
process.exit(0)
