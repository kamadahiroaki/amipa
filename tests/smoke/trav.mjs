// trav.html のヘッドレス煙試験: 読み込み → 範囲 → 各行の並び＋連結線 → 表示範囲の木、で例外が出ないこと
import { JSDOM, VirtualConsole } from 'jsdom'; import fs from 'fs'; import path from 'path'
const BASE = process.env.AMIPA_BASE, DIST = process.env.AMIPA_DIST; const errors = []
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message))); vc.sendTo(console, { omitJSDOMErrors: true })
const html = fs.readFileSync(path.join(DIST, 'trav.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, '')
const dom = new JSDOM(html, { url: 'http://localhost/?db=' + (process.env.AMIPA_DB || 'ecoli50.db'), pretendToBeVisual: true, virtualConsole: vc }); const W = dom.window
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'HTMLSelectElement', 'HTMLInputElement', 'Element', 'Node', 'requestAnimationFrame', 'MouseEvent', 'Event', 'history', 'location', 'MutationObserver']) { try { if (!(k in globalThis)) globalThis[k] = W[k] } catch { /* */ } }
globalThis.devicePixelRatio = 1; W.devicePixelRatio = 1
Object.defineProperty(W.HTMLElement.prototype, 'clientWidth', { get(){ return 1200 }, configurable: true })
const mkCtx = () => new Proxy({ _p: {} }, { get(t, k){ if (k === 'measureText') return s => ({ width: String(s).length * 6 }); if (k in t._p) return t._p[k]; return () => {} }, set(t, k, v){ t._p[k] = v; return true } })
W.HTMLCanvasElement.prototype.getContext = function(){ if (!this._ctx) this._ctx = mkCtx(); return this._ctx }
const realFetch = globalThis.fetch; globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : (typeof u === 'string' && u.startsWith('http://localhost/') ? BASE + u.slice('http://localhost'.length) : u), o)   /* jsdom の絶対 URL（modulepreload の polyfill が引く）も配信先へ */
process.on('uncaughtException', e => errors.push('uncaught: ' + (e && e.stack || e))); process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.stack || e)))
const asset = fs.readdirSync(path.join(DIST, 'assets')).find(f => /^trav-.*\.js$/.test(f)); const tmp = path.join(DIST, 'assets', asset.replace(/\.js$/, '.smoke.mjs')); fs.copyFileSync(path.join(DIST, 'assets', asset), tmp)   // .js は CommonJS 扱いになるので .mjs に写して読む
try { await import(tmp) } catch (e) { errors.push('import: ' + (e && e.stack || e)) } finally { try { fs.unlinkSync(tmp) } catch { /* */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms)); const $ = id => W.document.getElementById(id)
let t = Date.now(); while (Date.now() - t < 60000 && !/通過 \d/.test($('info').textContent)) await sleep(300)
console.log('[root]', $('info').textContent.slice(0, 160))
const cv = $('cv'); const fire = (type, x, y) => cv.dispatchEvent(new W.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
// ドラッグで範囲（上段）: offsetX/offsetY は jsdom に無いので定義
Object.defineProperty(W.MouseEvent.prototype, 'offsetX', { get(){ return this.clientX }, configurable: true }); Object.defineProperty(W.MouseEvent.prototype, 'offsetY', { get(){ return this.clientY }, configurable: true })
fire('mousedown', 400, 30); fire('mousemove', 700, 30); W.dispatchEvent(new W.MouseEvent('mouseup', { clientX: 700, clientY: 30 }))
t = Date.now(); await sleep(500); while (Date.now() - t < 60000 && $('busy').style.display !== 'none') await sleep(300)
console.log('[range]', $('info').textContent.slice(0, 120))
$('mode').value = 'rows'; $('mode').dispatchEvent(new W.Event('change')); await sleep(200)
$('order').value = 'tree'; $('order').dispatchEvent(new W.Event('change')); await sleep(500)
fire('mousemove', 500, 120); await sleep(100); console.log('[tip]', ($('tip').textContent || '').slice(0, 100) || '(none)')
console.log(errors.length ? 'NG' : 'OK', 'errors', errors.length); for (const e of errors.slice(0, 3)) console.log('  ' + String(e).split('\n').slice(0, 4).join('\n    '))
process.exit(errors.length ? 1 : 0)
