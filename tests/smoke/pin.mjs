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
const cv = $('cv'); const fire = (type, x, y) => cv.dispatchEvent(new W.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
// 行の固定（11-13）: 行ラベルの右クリックで株を固定 → 写しの行が先頭に、固定域が出る、見出しの帯の固定の切り替え、固定域の上の操作が本体へ渡る
const rowsBefore = () => W.document.getElementById('tv_cuttxt')?.textContent
const ctx = (x, y) => cv.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
const pin = $('pin'); const wrap = $('wrap')
console.log('[pins at start] display=', pin.style.display, 'strips pinned default?')
const H0 = () => pin.style.display === 'none' ? 0 : parseFloat(pin.style.height)
const at = async sc => { Object.defineProperty(wrap, 'scrollTop', { value: sc, writable: true, configurable: true }); wrap.dispatchEvent(new W.Event('scroll')); await sleep(80); return H0() }
console.log('[既定] 固定域の高さ scroll 0/300:', await at(0), await at(300))
await at(0); ctx(100, 200); await sleep(150)
console.log('[株を固定] scroll 0/300:', await at(0), await at(300), ' cuttxt', rowsBefore())
await at(0); ctx(100, 200); await sleep(150)   // y=200 は今は写しの行の後ろの行（同じ株とは限らない）
console.log('[2 つ目] scroll 300:', await at(300))
await at(0); ctx(100, 5); await sleep(150)   // 合意列の固定を外す
console.log('[合意列を外す] scroll 300:', await at(300))
await at(0); ctx(100, 5); await sleep(150)
console.log('[合意列を戻す] scroll 300:', await at(300))
wrap.scrollTop = 0; wrap.dispatchEvent(new W.Event('scroll')); await sleep(100)
console.log('[scroll 0] pin display', pin.style.display, 'h', pin.style.height)
Object.defineProperty(wrap, 'scrollTop', { value: 120, writable: true }); wrap.dispatchEvent(new W.Event('scroll')); await sleep(100)
console.log('[scroll 120] pin display', pin.style.display, 'h', pin.style.height, 'mb', pin.style.marginBottom)
// 固定域の上のホバー・右クリックを送る
for (const t of ['mousemove', 'mousedown', 'click', 'contextmenu']) pin.dispatchEvent(new W.MouseEvent(t, { bubbles: true, cancelable: true, clientX: 300, clientY: 5 }))
await sleep(100)
console.log('[after fwd] pin display', pin.style.display, 'h', pin.style.height)
console.log(errors.length ? 'NG\n' + errors.slice(0, 5).map(e => String(e).split('\n').slice(0, 5).join('\n  ')).join('\n') : 'OK 例外なし')
process.exit(errors.length ? 1 : 0)
