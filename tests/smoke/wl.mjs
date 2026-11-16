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
console.log('[root]', $('info').textContent.slice(0, 160))
// 地点の一覧（11-16）: 変換（BED・VCF・1 行 1 項目・JSON Lines）、go（遺伝子・参照座標・合意座標・ノード）、一覧の移動と印、群、API の pin/order
const A = W.amipaLinear; if (!A) { console.log('NG: window.amipaLinear が無い'); process.exit(1) }
const P = s => JSON.stringify(A.parse(s))
for (const s of ['APOL1', 'gene:APOL1', 'chr22:36,253,964-36,266,033', 'CHM13#0#chr22:100-200', 'x:100-200', 'node:12,34', 'path:HG00438#1#JAHBCB010000005.1:5-10', 'two words']) console.log('[parse]', s, '→', P(s))
const info = () => $('info').textContent
for (const t of ['APOL1', 'chr22:36,253,964-36,266,033', 'CHM13#chr22:36,228,001-36,242,000', 'x:3215000-3216000', 'chr99:1-2', 'NOSUCHGENE_X']) { const r = await A.go(t); console.log('[go]', t, '→', r.ok, r.resolved ? JSON.stringify(r.resolved) : r.reason, '|', info().slice(0, 90)) }
const vcf = ['##fileformat=VCFv4.2', '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tHG00438\tHG00621\tCHM13',
  'chr22\t36253964\tsv1\tN\t<DEL>\t.\tPASS\tSVTYPE=DEL;END=36260000\tGT\t0|1\t0|0\t1/1',
  'chr22\t20000000\tbnd1\tN\tN[chr21:30000000[\t.\tPASS\tSVTYPE=BND\tGT\t1|1\t0|1\t0/0',
  'chr20\t30000000\tins1\tA\tAT\t.\tPASS\t.\tGT\t0|0\t0|0\t0/0'].join('\n')
const n = A.list.load(vcf, 'test.vcf'); await sleep(1500); console.log('[vcf]', n, 'wlinfo:', $('wlinfo').textContent, '| cur:', $('wlcur').textContent)
const gsel = $('grpby'); console.log('[groups]', gsel.value, [...gsel.options].map(o => o.value).join(','), '| rec groups', JSON.stringify(A.list.get().recs[0].groups))
$('wlnote').value = 'check later'; $('wlnote').dispatchEvent(new W.Event('change')); A.list.mark('later'); await sleep(1500); console.log('[later → next]', $('wlcur').textContent, '| end2 shown:', $('wlend2').style.display !== 'none')
$('wlend2').dispatchEvent(new W.MouseEvent('click', { bubbles: true })); await sleep(1500); console.log('[end 2]', info().slice(0, 90))
await A.list.next(); await sleep(800); console.log('[next]', $('wlcur').textContent); await A.list.next(); console.log('[past end]', $('wlcur').textContent)
const sh = $('wlshow'); sh.value = 'later'; sh.dispatchEvent(new W.Event('change')); console.log('[show later]', $('wllist').textContent)
{ const ks = Object.keys(W.localStorage); const k = ks.find(q => q.startsWith('amipa.worklist.')); console.log('[saved]', ks.join(','), k ? JSON.parse(W.localStorage.getItem(k)).recs.map(r => r.status + ':' + r.note).join(' ') : '保存なし') }
const bed = 'track name=x\nchr22\t36253963\t36266033\tAPOL1_region\nchr21\t30000000\t30001000\n'; console.log('[bed]', JSON.stringify(A.list.convert(bed, 'a.bed').records.map(r => [r.label, r.targets[0]])))
console.log('[lines]', JSON.stringify(A.list.convert('APOL1\tthe gene\nchr22:1-100\n# c\nnode:5', 'l.txt').records.map(r => [r.label, r.targets[0].kind])))
console.log('[jsonl]', JSON.stringify(A.list.convert('{"label":"a","targets":["APOL1"],"status":"later"}\n{"targets":[{"kind":"x","x0":1,"x1":2}]}', 'w.jsonl').records.map(r => [r.label, r.status])))
console.log('[pin api]', A.pin(['HG00438']), 'pinned rows', $('cuttxt').textContent, '| order', A.order({ group: 'pin', order: 'name' }), $('grpby').value)
$('wlclear').dispatchEvent(new W.MouseEvent('click', { bubbles: true })); await sleep(300); console.log('[close]', $('wlbar').style.display, $('wlinfo').textContent)
console.log(errors.length ? 'NG\n' + errors.slice(0, 5).map(e => String(e).split('\n').slice(0, 5).join('\n  ')).join('\n') : 'OK 例外なし')
process.exit(errors.length ? 1 : 0)
