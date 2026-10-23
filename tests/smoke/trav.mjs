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
