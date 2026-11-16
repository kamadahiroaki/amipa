// trav.html のヘッドレス煙試験: 読み込み → 範囲 → 各行の並び＋連結線 → 表示範囲の木、で例外が出ないこと
import { JSDOM, VirtualConsole } from 'jsdom'; import fs from 'fs'; import path from 'path'
const BASE = process.env.AMIPA_BASE, DIST = process.env.AMIPA_DIST; const errors = []
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message))); vc.sendTo(console, { omitJSDOMErrors: true })
const html = fs.readFileSync(path.join(DIST, 'trav.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, '')
const dom = new JSDOM(html, { url: 'http://localhost/?db=' + (process.env.AMIPA_DB || 'ecoli50.db'), pretendToBeVisual: true, virtualConsole: vc }); const W = dom.window
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'HTMLSelectElement', 'HTMLInputElement', 'Element', 'Node', 'requestAnimationFrame', 'MouseEvent', 'Event', 'history', 'location', 'MutationObserver', 'localStorage', 'KeyboardEvent']) { try { if (!(k in globalThis)) globalThis[k] = W[k] } catch { /* */ } }
globalThis.ResizeObserver = W.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }; globalThis.getComputedStyle = W.getComputedStyle.bind(W); globalThis.WheelEvent = W.WheelEvent
globalThis.devicePixelRatio = 1; W.devicePixelRatio = 1
Object.defineProperty(W.HTMLElement.prototype, 'clientWidth', { get(){ return 1200 }, configurable: true })
const mkCtx = () => new Proxy({ _p: {} }, { get(t, k){ if (k === 'measureText') return s => ({ width: String(s).length * 6 }); if (k in t._p) return t._p[k]; return () => {} }, set(t, k, v){ t._p[k] = v; return true } })
W.HTMLCanvasElement.prototype.getContext = function(){ if (!this._ctx) this._ctx = mkCtx(); return this._ctx }
const realFetch0 = globalThis.fetch; const realFetch = (u, o) => realFetch0(u, o).catch(e => (o && o.signal && o.signal.aborted) ? Promise.reject(e) : realFetch0(u, o))   /* Node の fetch は閉じた keep-alive を使い回して 1 回落ちることがある */
globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : (typeof u === 'string' && u.startsWith('http://localhost/') ? BASE + u.slice('http://localhost'.length) : u), o)   /* jsdom の絶対 URL（modulepreload の polyfill が引く）も配信先へ */
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
process.on("exit", c => { if (c === 0 && errors.length) console.log("NG（途中で止まった）\n" + errors.slice(0, 3).map(e => String(e).split("\n").slice(0, 6).join("\n  ")).join("\n")) })
// 地点の一覧の追加分（11-16）: 開く段（Open / stage）、候補の選択、キー操作
const A = W.amipaLinear; const info = () => $('info').textContent
const crumb = () => [...W.document.querySelectorAll('#tv_crumb span[data-r]')].find(e => /dbeafe/.test(e.getAttribute('style') || ''))?.dataset.r
A.list.load('{"label":"APOL1 の 1 kb（塩基段）","targets":["chr22:36,254,001-36,255,000"],"stage":"base"}\n{"label":"APOL（候補が多い）","targets":["APOL"]}\n{"label":"COMT","targets":["COMT"]}', 'w.jsonl')
let t0 = Date.now(); while (Date.now() - t0 < 60000 && crumb() !== 'base') await sleep(500); console.log('[stage base]', crumb(), (Date.now() - t0) + ' ms |', info().slice(0, 120))
W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'n', bubbles: true })); await sleep(3000)
const alt = $('wlalt'); console.log('[key n → 候補]', $('wlcur').textContent.slice(0, 80), '| alt shown', alt.style.display !== 'none', alt.options.length, [...alt.options].slice(0, 4).map(o => o.textContent.slice(0, 40)).join(' / '))
if (alt.options.length > 1) { alt.value = alt.options[1].value; alt.dispatchEvent(new W.Event('change')); await sleep(3000); console.log('[候補を選ぶ]', info().slice(0, 100)) }
W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'l', bubbles: true })); await sleep(3000); console.log('[key l → later して次]', $('wlcur').textContent.slice(0, 60), JSON.stringify(A.list.get().recs.map(r => r.status)))
const inp = $('wlnote'); inp.focus(); inp.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'n', bubbles: true })); await sleep(500); console.log('[入力欄の中の n は無視]', A.list.get().pos)
$('wlstage').value = 'node'; $('wlstage').dispatchEvent(new W.Event('change')); await A.list.goto(2); t0 = Date.now(); while (Date.now() - t0 < 30000 && crumb() !== 'node') await sleep(500); console.log('[Open=Nodes で COMT]', crumb(), '|', info().slice(0, 110))
console.log(errors.length ? 'NG\n' + errors.slice(0, 5).map(e => String(e).split('\n').slice(0, 5).join('\n  ')).join('\n') : 'OK 例外なし')
process.exit(errors.length ? 1 : 0)
