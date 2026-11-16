// trav.html のヘッドレス煙試験: 読み込み → 範囲 → 各行の並び＋連結線 → 表示範囲の木、で例外が出ないこと
import { JSDOM, VirtualConsole } from 'jsdom'; import fs from 'fs'; import path from 'path'
const BASE = process.env.AMIPA_BASE, DIST = process.env.AMIPA_DIST; const errors = []
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message))); vc.sendTo(console, { omitJSDOMErrors: true })
const html = fs.readFileSync(path.join(DIST, 'trav.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, '')
const dom = new JSDOM(html, { url: 'http://localhost/?db=' + (process.env.AMIPA_DB || 'ecoli50.db'), pretendToBeVisual: true, virtualConsole: vc }); const W = dom.window
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'HTMLSelectElement', 'HTMLInputElement', 'Element', 'Node', 'requestAnimationFrame', 'MouseEvent', 'Event', 'history', 'location', 'MutationObserver']) { try { if (!(k in globalThis)) globalThis[k] = W[k] } catch { /* */ } }
globalThis.ResizeObserver = W.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }; globalThis.getComputedStyle = W.getComputedStyle.bind(W); globalThis.WheelEvent = W.WheelEvent
globalThis.devicePixelRatio = 1; W.devicePixelRatio = 1
Object.defineProperty(W.HTMLElement.prototype, 'clientWidth', { get(){ return 1200 }, configurable: true })
const mkCtx = () => new Proxy({ _p: {} }, { get(t, k){ if (k === 'measureText') return s => ({ width: String(s).length * 6 }); if (k in t._p) return t._p[k]; return () => {} }, set(t, k, v){ t._p[k] = v; return true } })
W.HTMLCanvasElement.prototype.getContext = function(){ if (!this._ctx) this._ctx = mkCtx(); return this._ctx }
const realFetch = globalThis.fetch; globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : (typeof u === 'string' && u.startsWith('http://localhost/') ? BASE + u.slice('http://localhost'.length) : u), o)   /* jsdom の絶対 URL（modulepreload の polyfill が引く）も配信先へ */
process.on('uncaughtException', e => errors.push('uncaught: ' + (e && e.stack || e))); process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.stack || e)))
// 入口 trav-*.js と、それが import する分割チャンク（travRender-*.js など）を .mjs に複製し、import 先も .mjs に書き換える（Node は .js を CommonJS と見なす）
const assetsDir = path.join(DIST, 'assets'); const entry = fs.readdirSync(assetsDir).find(f => /^trav-.*\.js$/.test(f)); const copies = []
const toMjs = f => { const src = path.join(assetsDir, f); const dst = src.replace(/\.js$/, '.smoke.mjs'); let code = fs.readFileSync(src, 'utf8')
  code = code.replace(/from"\.\/([A-Za-z0-9_-]+)\.js"/g, (m, c) => { if (!copies.includes(c + '.js')) toMjs(c + '.js'); return `from"./${c}.smoke.mjs"` }); fs.writeFileSync(dst, code); copies.push(f); return dst }
const tmp = toMjs(entry)
try { await import(tmp) } catch (e) { errors.push('import: ' + (e && e.stack || e)) } finally { for (const f of copies) { try { fs.unlinkSync(path.join(assetsDir, f.replace(/\.js$/, '.smoke.mjs'))) } catch { /* */ } } }
const sleep = ms => new Promise(r => setTimeout(r, ms)); const $ = id => W.document.getElementById(id === 'db' ? id : 'tv_' + id)   // パネルの要素は tv_ 接頭辞
let t = Date.now(); while (Date.now() - t < 60000 && !($('info') && /通過 \d/.test($('info').textContent))) await sleep(300)   // パネルは DB 一覧の後に mount されるので要素が出るまで待つ
if (!$('info')) { console.log('NG: パネルが mount されない（#tv_info が無い）'); for (const e of errors.slice(0, 3)) console.log('  ' + String(e).split('\n').slice(0, 6).join('\n    ')); process.exit(1) }
console.log('[root]', $('info').textContent.slice(0, 160))
// 見えている所だけの canvas（11-16）: 窓の高さ・上下の空き・スクロールで窓が動く・窓が先頭から外れても固定域が出る・右クリックの y が全体の座標
const cv = $('cv'); const pin = $('pin'); const wrap = $('wrap'); const sp0 = $('sp0'), sp1 = $('sp1')
Object.defineProperty(wrap, 'clientHeight', { get(){ return 300 }, configurable: true })
const st = () => `sp0=${sp0.style.height} cv=${cv.style.height} sp1=${sp1.style.height} ov.top=${$('ov').style.top} pin=${pin.style.display === 'none' ? 0 : pin.style.height}`
const at = async sc => { Object.defineProperty(wrap, 'scrollTop', { value: sc, writable: true, configurable: true }); wrap.dispatchEvent(new W.Event('scroll')); await sleep(150) }
const ctx = (x, y) => cv.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
for (const m of ['rows', 'coord']) { const md = $('mode'); md.value = m; md.dispatchEvent(new W.Event('change')); await sleep(800)
  await at(0); $('cut').value = '100'; $('cut').dispatchEvent(new W.Event('input')); await sleep(300); console.log(`[${m} scroll 0]`, st())
  const total = parseFloat(sp0.style.height) + parseFloat(cv.style.height) + parseFloat(sp1.style.height); console.log(`  全体の高さ ${total}`)
  for (const sc of [200, 900, 1600, total - 300]) { await at(sc); console.log(`[${m} scroll ${sc}]`, st()) } }
await at(1600); const w0 = parseFloat(sp0.style.height); console.log('[右クリック前] winTop', w0, st())
ctx(100, 600); await sleep(300); console.log('[窓の中 y=600（全体では winTop+600）で右クリック → 株を固定]', st(), $('cuttxt').textContent)
for (const t of ['mousemove', 'click']) pin.dispatchEvent(new W.MouseEvent(t, { bubbles: true, cancelable: true, clientX: 300, clientY: 5 })); await sleep(100)
await at(0); console.log('[scroll 0]', st()); await at(2000); console.log('[scroll 2000]', st())
console.log(errors.length ? 'NG\n' + errors.slice(0, 5).map(e => String(e).split('\n').slice(0, 5).join('\n  ')).join('\n') : 'OK 例外なし')
process.exit(errors.length ? 1 : 0)
