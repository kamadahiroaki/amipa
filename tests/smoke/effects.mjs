// ヘッドレスの検証: 変異の効果（段階 A）。ybeF の座位（og 1839、50 株中 8 株が擬似遺伝子）を塩基の段で開き、
// 行ごとの効果の要約を出す。擬似遺伝子の株に機能喪失（終止獲得／フレームシフト）が付けば OK。
//   AMIPA_BASE=http://host:port AMIPA_DB=ecoli50.db node effects.mjs   （bundle.mjs は run.sh の esbuild で作る）
//   AMIPA_COLS=214727-214963 で座位の列区間を替えられる（既定 ybeF）
import { JSDOM, VirtualConsole } from 'jsdom'
const BASE = process.env.AMIPA_BASE || 'http://localhost:33001'; const DB = process.env.AMIPA_DB || 'ecoli50.db'
const [C0, C1] = (process.env.AMIPA_COLS || '214727-214963').split('-').map(Number)
const errors = []
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message))); vc.sendTo(console, { omitJSDOMErrors: true })
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc })
const W = dom.window
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'MouseEvent', 'KeyboardEvent', 'WheelEvent', 'CustomEvent', 'Event']) { try { if (!(k in globalThis)) globalThis[k] = W[k] } catch { /* */ } }
globalThis.devicePixelRatio = 1; W.devicePixelRatio = 1
W.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })
W.ResizeObserver = globalThis.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }
Object.defineProperty(W.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'clientWidth', { get(){ return 1200 }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'clientHeight', { get(){ return 600 }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'offsetWidth', { get(){ return 1200 }, configurable: true })
Object.defineProperty(W.HTMLElement.prototype, 'offsetHeight', { get(){ return 600 }, configurable: true })
W.Element.prototype.getBoundingClientRect = function(){ return { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 600, right: 1200, bottom: 600 } }
const mkCtx = () => new Proxy({ canvas: null, _props: {} }, { get(t, k){ if (k === 'measureText') return s => ({ width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }); if (k in t) return t[k]; if (k in t._props) return t._props[k]; return () => {} }, set(t, k, v){ t._props[k] = v; return true } })
W.HTMLCanvasElement.prototype.getContext = function(){ if (!this._ctx) { this._ctx = mkCtx() } return this._ctx }
W.HTMLCanvasElement.prototype.toDataURL = () => 'data:,'
const realFetch = globalThis.fetch
globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? BASE + u : u, o)
process.on('uncaughtException', e => { errors.push('uncaught: ' + (e && e.stack || e)) })
process.on('unhandledRejection', e => { errors.push('unhandledRejection: ' + (e && e.stack || e)) })
const { mountBlockMsa, api } = await import('./bundle.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const root = W.document.getElementById('root')
const data = await api.fetchBlocks(DB)
const handle = mountBlockMsa(root, data, {
  onSelectBlock: () => {}, onHoverBlock: () => {}, onDrill: req => api.fetchBlockWindow(DB, req),
  onRange: (x0, x1, label, depth, parent, pblock) => api.fetchBlockRange(DB, x0, x1, label, depth, parent, pblock),
  onRangeAtoms: (a0, a1, label, depth, parent) => api.fetchBlockRangeAtoms(DB, a0, a1, label, depth, parent),
  onSites: q => api.fetchBlockSites(DB, q), onTokRanges: (c0, c1) => api.fetchBlockTokRanges(DB, c0, c1),
  onGenes: ranges => api.fetchBlockGenes(DB, ranges), onGenesCols: (c0, c1, paths) => api.fetchBlockGenesCols(DB, c0, c1, paths), onGenesTok: ranges => api.fetchBlockGenesTok(DB, ranges),
  onOrth: (c0, c1, max) => api.fetchBlockOrth(DB, c0, c1, max), onOrthRows: (c0, c1, paths) => api.fetchBlockOrthRows(DB, c0, c1, paths),
  onBaseFetch: (ranges, label, maxLeaves) => api.fetchBubbleMsaRanges(DB, ranges, label, 0, 0, maxLeaves), onLocate: names => api.fetchBlockLocate(DB, names), onFeature: q => api.fetchBlockFeature(DB, q),
  onView: () => {}, onSelectHap: () => {}, onBaseMsa: () => {},
})
await sleep(1200)
// 列 C0 を含む原子 → その中の列区間で塩基の段へ
const A = data.meta.atoms; const atom = A.findIndex(a => a[2] != null && a[2] <= C0 && C0 <= a[3]); if (atom < 0) { console.log('NG: 列', C0, 'を含む原子が無い'); process.exit(1) }
const pad = 40; handle._zoomTo({ atom, c0: Math.max(A[atom][2], C0 - pad), c1: Math.min(A[atom][3], C1 + pad) }, 'effects test')
let t = Date.now(); while (Date.now() - t < 40000) { const s = handle._state(); if (!s.drilling && s.mode === 'base') break; await sleep(200) }
console.log('[window]', JSON.stringify(handle._state()))
t = Date.now(); let E = null; while (Date.now() - t < 20000) { E = handle._effects(); if (E && E.loci && E.loci.length) break; await sleep(300) }
if (!E || !E.loci || !E.loci.length) { console.log('NG: 効果が計算されない', E && E.error); console.log('errors', errors.length, errors.slice(0, 3)); process.exit(1) }
console.log(`[effects] loci ${E.loci.length}, ms ${E.ms}`)
for (const L of E.loci) {
  const rows = [...L.rows.entries()]; const present = rows.filter(([, S]) => !S.absent)
  const lof = present.filter(([, S]) => S.lof)
  const syn = present.reduce((a, [, S]) => a + S.syn, 0), mis = present.reduce((a, [, S]) => a + S.mis, 0)
  console.log(`  locus ${L.name} (${L.eff}, model ${L.model && L.model.hap}, same-span ${L.modelN}) codons ${L.ncodon} start ${L.startCodon} end ${L.endCodon} internal stops ${L.modelStops} | rows ${present.length}/${rows.length} | syn ${syn} mis ${mis} | LoF rows ${lof.length}`)
  for (const [hap, S] of lof.slice(0, 12)) console.log(`    LoF ${hap}: 末尾の枠ずれ ${S.fsNet} 終止獲得 ${S.nonsense} フレームシフト ${S.fs} 開始喪失 ${S.startLost} 終止喪失 ${S.stopLost} インフレーム ${S.inframe} | ${S.aaLen}/${S.modelAa} aa | 読み枠ずれ ${S.outOfFrame} コドン`)
}
// 期待: ybeF では擬似遺伝子の 8 株に機能喪失が付く（厳密な数は注釈次第なので 5 以上なら OK とする）
const main = E.loci.slice().sort((a, b) => b.ncodon - a.ncodon)[0]; const nlof = [...main.rows.values()].filter(S => !S.absent && S.lof).length
const ok = nlof >= 8 && nlof <= 10 && main.modelStops === 0 && errors.length === 0   /* RefSeq の擬似遺伝子 8 株は全部、RefSeq が無傷とする株は多くて 2 */
console.log(ok ? 'OK' : 'NG', 'LoF rows', nlof, 'errors', errors.length); for (const e of errors.slice(0, 3)) console.log('  ' + String(e).split('\n').slice(0, 3).join('\n    '))
process.exit(ok ? 0 : 1)
