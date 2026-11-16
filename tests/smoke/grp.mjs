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
// 並べ方の二段・属性表・株の検索（11-13）
const sel = $('grpby'); const ord = $('order'); const set = async (el, v) => { el.value = v; el.dispatchEvent(new W.Event('change')); await sleep(300) }
const haps = []; { const t = W.__amipaAttrs ? null : null }
// 属性表: 株名の先頭 2 文字で群を作る
const names = [...new Set([...W.document.querySelectorAll('*')].length ? [] : [])]
const rootJ = await (await fetch('/api/trav/root?db=ecoli50.db')).json(); const hs = rootJ.haps.map(h => h.hap.split('#')[0])
const tsv = 'sample\tgrp\tnum\n' + hs.map((h, i) => `${h}\t${i % 3 ? 'B' : 'A'}\t${i % 4 === 0 ? '' : i % 5}`).join('\n')
const r = W.__amipaAttrs(tsv, 't.tsv'); console.log('[attrs]', JSON.stringify(r), $('attrinfo').textContent)
console.log('[options]', [...sel.options].map(o => o.value + '=' + o.textContent).join(' | '))
for (const o of ['tree', 'name']) for (const gv of ['sel', 'pin', 'attr:1', 'attr:2', '']) { await set(ord, o); await set(sel, gv); console.log(`[order ${o} group ${gv || 'none'}] ok rows=${W.document.getElementById('tv_cuttxt').textContent}`) }
const og = [...sel.options].find(o => o.value.startsWith('og:')); if (og) { await set(sel, og.value); console.log('[gene group]', og.textContent, 'ok') } else console.log('[gene group] 選択肢なし（範囲に名前付きの遺伝子群が無い）')
await set(sel, '')
const hf = $('hfind'); hf.value = '0001'; hf.dispatchEvent(new W.Event('input')); await sleep(200); console.log('[find 0001]', $('hfindn').textContent)
hf.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter' })); await sleep(50); console.log('[find enter]', $('hfindn').textContent)
$('hfindpin').dispatchEvent(new W.MouseEvent('click', { bubbles: true })); await sleep(200); await set(sel, 'pin'); console.log('[pin all + group pin] ok')
// 系統樹のまとめ＋群
$('cut').value = '60'; $('cut').dispatchEvent(new W.Event('input')); await sleep(300); await set(ord, 'tree'); await set(sel, 'pin'); console.log('[collapse+group]', W.document.getElementById('tv_cuttxt').textContent)
// 表にある株だけ（11-16）: 20 株だけの表 → 表示 20 行＋参照、0 一致の表 → 警告で選択肢を切る
{ await set($('cut'), '100'); $('cut').dispatchEvent(new W.Event('input')); await set(sel, ''); await set(ord, 'name')
  W.__amipaAttrs('sample\tg\n' + hs.slice(0, 20).map((h, i) => `${h}\t${i % 2 ? 'x' : 'y'}`).join('\n'), 'part.tsv'); console.log('[part]', $('attrinfo').textContent, 'disabled=', $('onlyattr').disabled)
  const cb = $('onlyattr'); cb.checked = true; cb.dispatchEvent(new W.Event('change')); await sleep(300); console.log('[only in table]', W.document.getElementById('tv_cuttxt').textContent)
  await set(sel, 'attr:1'); console.log('[only + group g]', W.document.getElementById('tv_cuttxt').textContent)
  await set(ord, 'tree'); console.log('[only + group + tree]', W.document.getElementById('tv_cuttxt').textContent)
  cb.checked = false; cb.dispatchEvent(new W.Event('change')); await sleep(300); console.log('[off]', W.document.getElementById('tv_cuttxt').textContent)
  W.__amipaAttrs('sample\tg\nNOPE1\tx\nNOPE2\ty', 'wrong.tsv'); console.log('[wrong]', $('attrinfo').textContent, 'disabled=', $('onlyattr').disabled) }
console.log(errors.length ? 'NG\n' + errors.slice(0, 5).map(e => String(e).split('\n').slice(0, 6).join('\n  ')).join('\n') : 'OK 例外なし')
process.exit(errors.length ? 1 : 0)
