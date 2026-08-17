import { useMemo, useRef, useState } from 'react'
import { fetchBubbleMsa, BubbleMsaResp, MsaRow } from '../api/client'

// 下部パネルの MSA ビュー。ユーザが (1)ノードを選び (2)対象サンプルをパスパネルで選び
// (3)「MSA 計算」を押すと初めて抽出が走る(計算は重いので明示トリガ)。
// 2 ノードだけ選ぶと「間を全選択」で source/sink 間の内部ノードを自動選択できる。
// 塩基=背景色ブロック、差分モードで参照一致は淡ドット、strand は +/− バッジ。
// 列ホバーでグラフ上の対応ノードを強調(onHoverNode)＋パネル内で列ハイライト、列クリックでソート。

interface Props {
  db: string | null
  pickedNodes: string[]             // MSA 対象ノード名(App が onNodeSelect/間埋めで管理)
  pickMode: boolean                 // ON の間、グラフのクリックがノードを追加
  onTogglePick: () => void
  onRemoveNode: (name: string) => void
  onClearNodes: () => void
  onFillBetween: () => void         // 2 ノード選択時: 間のノードを全選択
  onHoverNode?: (names: string[] | null) => void   // 列=アレル群なので複数ノードを渡す
  sampleKeys: string[]              // 選択中のパス群キー([...ribbonSel.keys()])
  ribbonLevel: string
}

const STYLE = `
.bmsa{font-family:ui-monospace,Menlo,Consolas,monospace;color:#222}
.bmsa .r{display:flex;align-items:center;height:19px;white-space:nowrap}
.bmsa .r.ref{background:#fff6e9;border-radius:5px}
.bmsa .rl{position:sticky;left:0;z-index:3;background:#fff;width:150px;min-width:150px;font-size:11px;color:#667;
  padding-right:8px;overflow:hidden;text-overflow:ellipsis}
.bmsa .r.ref .rl{background:#fff6e9;color:#222;font-weight:650}
/* サンプル hover: 同じサンプルの行(·1/·2 や複数 contig も)をまとめて目立たせる。
   ★ .r.ref より後に置くこと(同じ詳細度なので後勝ち。参照行でも強調が効くように) */
.bmsa .r.samphi{background:#e6f1fd;box-shadow:inset 0 0 0 1px #93b8e0;border-radius:5px}
.bmsa .r.samphi .rl{background:#e6f1fd;color:#123a5e;font-weight:700}
.bmsa .stb{width:16px;min-width:16px;text-align:center;font-size:11px;font-weight:700;border-radius:3px;margin-right:6px}
.bmsa .stb.plus{color:#1d4ed8;background:#e6edfb}
.bmsa .stb.minus{color:#b45309;background:#fbeede}
.bmsa .c{width:15px;min-width:15px;height:18px;display:inline-flex;align-items:center;justify-content:center;
  font-size:12.5px;font-weight:650;cursor:pointer;border-radius:2px;box-sizing:border-box}
/* ノード(アレル群)の境界。全行の同じ列に入れるので幅は border-box で不変=見出しと必ず揃う */
.bmsa .gs{border-left:1px solid #dde3e9}
.bmsa .r .c.gs{border-left:1px solid #d3dae1}
.bmsa .c.ell{width:20px;min-width:20px;color:#8a93a0;font-weight:400;font-size:10px;cursor:default}
.bmsa .c.gap{color:#8a93a0;font-weight:700;background:repeating-linear-gradient(45deg,#eef1f4,#eef1f4 3px,#e2e6ea 3px,#e2e6ea 6px)}
.bmsa .c.match{color:#c2c9d1;font-weight:400}
.bmsa .cA{color:#166534;background:#d7f2df}
.bmsa .cC{color:#1e40af;background:#dbe6fe}
.bmsa .cG{color:#854d0e;background:#fdf0a8}
.bmsa .cT{color:#b91c1c;background:#fddddd}
.bmsa .var{outline:1px solid rgba(13,148,136,.35);outline-offset:-1px}
/* 局所反転: 行の優勢向きと逆に通ったノード(=塩基は逆相補で表示している)。
   「配列は同じなのに別ノード」の正体がこれなので、見て分かるようにする。 */
.bmsa .invc{outline:2px dashed #7c3aed;outline-offset:-2px;border-radius:3px}
.bmsa .colhi{outline:2px solid #ff1493;outline-offset:-1px;border-radius:2px}
.bmsa .ruler{display:flex;align-items:flex-end;height:12px}
.bmsa .ruler .c{background:none;color:#0d9488;font-size:9px;cursor:pointer}
.bmsa .ruler .rl,.bmsa .ruler .stb{background:none}
/* ノードブロック見出し: 1 群 = 1 スパン(幅=配下列の合計 px)。交互の淡色＋左境界線で境界を示し、
   多アレル群(同じサイトの排他アレル)は teal。幅を px で自前計算するので下の行と厳密に揃う。 */
.bmsa .gblk{display:flex;align-items:stretch;height:17px;margin-bottom:1px}
.bmsa .gb{height:17px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;
  border-left:1px solid #c3ccd5;background:#f2f5f8;color:#68727e;font-size:9px;letter-spacing:-.2px;
  overflow:hidden;white-space:nowrap;cursor:pointer}
.bmsa .gb.odd{background:#e8edf2}
.bmsa .gb.alt{background:#dff0ee;color:#0f766e;font-weight:700}
.bmsa .gb.anc{border-bottom:2px solid #0f766e}
.bmsa .gb.gbhi{background:#ffe3f1;color:#b3006b;border-left-color:#ff1493}
.bmsa-tip{position:fixed;pointer-events:none;z-index:60;background:#fff;border:1px solid #d7dce2;border-radius:8px;
  padding:6px 9px;font:12px ui-monospace,Menlo,monospace;color:#222;box-shadow:0 6px 20px rgba(0,0,0,.15);
  max-width:260px;opacity:0;transition:opacity .06s}
.bmsa-tip .n{color:#0f766e;font-weight:650}
.bmsa-tip .row{display:flex;justify-content:space-between;gap:12px}
.bmsa-chip{display:inline-flex;align-items:center;gap:4px;background:#eef2f5;border:1px solid #d7dce2;border-radius:11px;
  padding:1px 4px 1px 8px;font:11px ui-monospace,Menlo,monospace;color:#333;cursor:default}
.bmsa-chip:hover{background:#ffe3f1;border-color:#ff1493}
.bmsa-chip b{cursor:pointer;color:#99a;font-weight:700;padding:0 2px}
.bmsa-chip b:hover{color:#b91c1c}
`

function baseCls(ch: string) { return ch === 'A' || ch === 'C' || ch === 'G' || ch === 'T' ? 'c' + ch : '' }
const CW = 15, CW_ELL = 20        // 列の幅(px)。ブロック見出しの幅計算に使う(データ行と同じ値)

// アレル群の見出し文字列。単独なら `n123456`、複数なら共通接頭辞を1回だけ出して `n8109574[1|2|3]`。
function groupLabel(nodes: string[]): string {
  if (nodes.length === 1) return nodes[0]
  const ids = nodes.map(n => n.replace(/^n/, ''))
  const minLen = Math.min(...ids.map(s => s.length))
  let p = 0
  while (p < minLen - 1 && ids.every(s => s[p] === ids[0][p])) p++
  return 'n' + ids[0].slice(0, p) + '[' + ids.map(s => s.slice(p)).join('|') + ']'
}
// 幅(px)に収まる見出しへ落とす。収まらなければ末尾だけ、それも無理なら空(tooltip に全文)。
function fitLabel(nodes: string[], w: number): string {
  const full = groupLabel(nodes), per = 5.5
  if (full.length * per <= w - 2) return full
  const tail = nodes.map(n => n.slice(-3)).join('|')
  if (tail.length * per <= w - 2) return tail
  const n = Math.max(0, Math.floor((w - 2) / per))
  return n >= 2 ? full.slice(-n) : ''
}
function btn(on: boolean, dim = false): React.CSSProperties {
  return { border: '1px solid ' + (on ? '#0d9488' : '#d7dce2'), background: on ? '#0d9488' : '#f4f6f8',
    color: dim ? '#aab' : on ? '#fff' : '#333', borderRadius: 6, padding: '4px 10px', font: '12px sans-serif',
    cursor: dim ? 'default' : 'pointer', fontWeight: 550 }
}

// ── Export(8.3): bubbleMsa の計算済みグリッドを FASTA / CLUSTAL / アレル表 TSV に書き出す ──
// 列は base 列のみ(ell=畳み列は落とす)＝妥当なヌクレオチド整列。'~'(畳み)は N、'-' は gap のまま。
function sanitizeName(s: string): string { return (s || 'bubble').replace(/[^\w.+-]+/g, '_').slice(0, 80) }
function downloadText(name: string, text: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function baseColIdx(d: BubbleMsaResp): number[] {
  return (d.cols || []).map((c, i) => (c.kind === 'base' ? i : -1)).filter(i => i >= 0)
}
function rowBaseSeq(r: MsaRow, keep: number[]): string {
  let s = ''
  for (const i of keep) { const ch = r.seq[i] || '-'; s += ch === '~' ? 'N' : ch }
  return s
}
function wrap60(s: string): string { return s.replace(/(.{60})/g, '$1\n').replace(/\n$/, '') }
function toFasta(d: BubbleMsaResp): string {
  const keep = baseColIdx(d)
  return (d.rows || []).map(r =>
    `>${r.label}${r.isref ? ' [ref]' : ''} allele=${r.allele} strand=${r.strand}\n${wrap60(rowBaseSeq(r, keep))}`
  ).join('\n') + '\n'
}
function toClustal(d: BubbleMsaResp): string {
  const keep = baseColIdx(d), rows = d.rows || []
  const names = rows.map(r => (r.label || r.samp).replace(/\s+/g, '_'))
  const seqs = rows.map(r => rowBaseSeq(r, keep))
  const L = seqs[0]?.length || 0
  const W = Math.min(30, Math.max(1, ...names.map(n => n.length)))
  let out = "CLUSTAL W (ggb bubble MSA export; base columns only, '~' folded->N)\n\n"
  for (let p = 0; p < L; p += 60) {
    for (let i = 0; i < rows.length; i++) out += names[i].slice(0, W).padEnd(W) + '  ' + seqs[i].slice(p, p + 60) + '\n'
    out += '\n'
  }
  return out
}
function toAlleleTsv(d: BubbleMsaResp): string {
  const keep = baseColIdx(d)
  const head = ['label', 'sample', 'allele', 'is_ref', 'strand', 'path', 'seq'].join('\t')
  const body = (d.rows || []).map(r =>
    [r.label, r.samp, r.allele, r.isref ? 1 : 0, r.strand, r.path, rowBaseSeq(r, keep)].join('\t'))
  return [head, ...body].join('\n') + '\n'
}

// MSA グリッドを図版 SVG に。DOM のセル着色(cA/cC/cG/cT・gap・diff の '·'・variant 枠・ref 行)をそのまま写す。
// 別ファイル出力(グラフ図版とは別 SVG)。rows は表示順(整列済み)、refRow・diff は現在の表示状態を渡す。
const MSA_BASE: Record<string, [string, string]> = {   // 塩基 → [文字色, 背景]
  A: ['#166534', '#d7f2df'], C: ['#1e40af', '#dbe6fe'], G: ['#854d0e', '#fdf0a8'], T: ['#b91c1c', '#fddddd'],
}
function xesc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function buildMsaSvg(d: BubbleMsaResp, rows: MsaRow[], diff: boolean, refRow: MsaRow | undefined): string {
  const cols = d.cols || []
  const CWpx = 15, ELLpx = 20, rowH = 16, labelW = 150, headH = 20
  const cx: number[] = []
  let x = labelW
  for (const c of cols) { cx.push(x); x += c.kind === 'ell' ? ELLpx : CWpx }
  const totalW = x + 4, totalH = headH + rows.length * rowH + 4
  const parts: string[] = []
  // タイトル(bubble 名・参照名)
  parts.push(`<text x="4" y="${(headH * 0.7).toFixed(1)}" font-size="12" font-family="sans-serif" font-weight="600" fill="#0f766e">${xesc(d.name || 'bubble')}${d.refname ? '  ·  ' + xesc(d.refname) : ''}  (${d.nrow ?? rows.length} rows · ${d.nallele ?? '?'} alleles)</text>`)
  rows.forEach((r, ri) => {
    const y = headH + ri * rowH
    if (r.isref) parts.push(`<rect x="0" y="${y}" width="${totalW}" height="${rowH}" fill="#fff6e9"/>`)
    parts.push(`<text x="4" y="${(y + rowH * 0.72).toFixed(1)}" font-size="11" font-family="ui-monospace,monospace" fill="${r.isref ? '#222' : '#556'}"${r.isref ? ' font-weight="650"' : ''}>${xesc((r.label || r.samp).slice(0, 24))}${r.isref ? ' *' : ''}</text>`)
    cols.forEach((c, ci) => {
      const w = c.kind === 'ell' ? ELLpx : CWpx, X = cx[ci]
      const ch = r.seq[ci] || '-'
      if (c.kind === 'ell') {
        parts.push(`<text x="${(X + w / 2).toFixed(1)}" y="${(y + rowH * 0.72).toFixed(1)}" font-size="9" text-anchor="middle" font-family="ui-monospace,monospace" fill="#8a93a0">~</text>`)
        return
      }
      let letter = ch, color = '#333333', bg = ''
      if (ch === '~') { letter = '~'; color = '#8a93a0' }
      else if (ch === '-') { letter = '–'; color = '#8a93a0'; bg = '#eef1f4' }
      else if (diff && !r.isref && refRow && ch === refRow.seq[ci]) { letter = '·'; color = '#c2c9d1' }
      else { const b = MSA_BASE[ch]; if (b) { color = b[0]; bg = b[1] } }
      if (bg) parts.push(`<rect x="${X}" y="${y}" width="${w}" height="${rowH}" fill="${bg}"/>`)
      if (c.variant) parts.push(`<rect x="${X + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${rowH - 1}" fill="none" stroke="#0d9488" stroke-opacity="0.35"/>`)
      parts.push(`<text x="${(X + w / 2).toFixed(1)}" y="${(y + rowH * 0.72).toFixed(1)}" font-size="11" text-anchor="middle" font-family="ui-monospace,monospace" font-weight="600" fill="${color}">${letter}</text>`)
    })
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>
${parts.join('\n')}
</svg>
`
}

export default function BubbleMsa(props: Props) {
  const { db, pickedNodes, pickMode, onTogglePick, onRemoveNode, onClearNodes, onFillBetween, onHoverNode, sampleKeys } = props
  const [data, setData] = useState<BubbleMsaResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [diff, setDiff] = useState(true)
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortBy, setSortBy] = useState<'allele' | 'sample'>('allele')
  const [flank, setFlank] = useState(0)   // 既定 0 = 選択ノードだけ(文脈は要るときに増やす)
  const gridRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  async function compute() {
    if (!db || pickedNodes.length === 0) return
    setLoading(true); setErr(null); setSortCol(null)
    const d = await fetchBubbleMsa(db, pickedNodes, sampleKeys, flank)
    setLoading(false)
    if (d.error) { setErr(d.error); setData(null) } else setData(d)
  }

  // 並び順: アレル順(既定)/サンプル順、または列クリック(その列の塩基順、一時的)。
  // 参照はどの順でも先頭に固定する(差分表示の基準行なので上にあってほしい)。
  const rows = useMemo(() => {
    if (!data?.rows) return []
    const rs = data.rows.slice()
    const byLab = (a: typeof rs[0], b: typeof rs[0]) =>
      (a.label || a.samp).localeCompare(b.label || b.samp, undefined, { numeric: true })
    if (sortCol != null) {
      rs.sort((a, b) => { const x = a.seq[sortCol], y = b.seq[sortCol]; if (x !== y) return x < y ? -1 : 1; return (+b.isref - +a.isref) || byLab(a, b) })
    } else if (sortBy === 'sample') {
      rs.sort((a, b) => (+b.isref - +a.isref) || byLab(a, b))
    } else {
      rs.sort((a, b) => (+b.isref - +a.isref) || (a.allele - b.allele) || byLab(a, b))
    }
    return rs
  }, [data, sortCol, sortBy])
  const refRow = useMemo(() => rows.find(r => r.isref) || rows[0], [rows])
  const cols = data?.cols || []
  const refLbl = data?.refname ? data.refname + ':' : ''

  // 列を群(= 1 ノード or 同一サイトの排他アレル)ごとにまとめ、見出しブロックの幅を px で持つ
  const blocks = useMemo(() => {
    const bs: { g: number; nodes: string[]; from: number; w: number; variant: boolean; rb?: number | null }[] = []
    cols.forEach((c, ci) => {
      const w = c.kind === 'ell' ? CW_ELL : CW
      const last = bs[bs.length - 1]
      if (last && last.g === c.g) { last.w += w; last.variant = last.variant || !!c.variant }
      else bs.push({ g: c.g, nodes: c.nodes, from: ci, w, variant: !!c.variant, rb: c.rb })
    })
    return bs
  }, [cols])
  const gStart = useMemo(() => {                       // 群の先頭列 = 境界線を引く列
    const s = new Set<number>()
    cols.forEach((c, ci) => { if (ci === 0 || cols[ci - 1].g !== c.g) s.add(ci) })
    return s
  }, [cols])
  // ノード名 → 列番号。行の inv(局所反転で通ったノード)を列に落として印を付けるのに使う。
  const colsByNode = useMemo(() => {
    const m = new Map<string, number[]>()
    cols.forEach((c, ci) => c.nodes.forEach(n => { const a = m.get(n); if (a) a.push(ci); else m.set(n, [ci]) }))
    return m
  }, [cols])
  const invCols = useMemo(() => {
    const m = new Map<MsaRow, Set<number>>()
    for (const r of rows) {
      if (!r.inv?.length) continue
      const s = new Set<number>()
      for (const n of r.inv) for (const ci of colsByNode.get(n) ?? []) s.add(ci)
      m.set(r, s)
    }
    return m
  }, [rows, colsByNode])

  // 列 or 見出しブロックの hover: 群の全列をハイライトし、グラフ側も群の全ノードを強調する。
  // 行(サンプル)側の hover では、同じサンプルの行をまとめて強調する(ラベル上だけでも効く)。
  function onOver(e: React.MouseEvent) {
    const t = e.target as HTMLElement
    const g = gridRef.current, tip = tipRef.current
    if (!g) return
    g.querySelectorAll('.samphi').forEach(x => x.classList.remove('samphi'))
    const samp = (t.closest('.r') as HTMLElement | null)?.dataset.samp
    if (samp) g.querySelectorAll(`.r[data-samp="${CSS.escape(samp)}"]`).forEach(x => x.classList.add('samphi'))
    const el = t.closest('.c,.gb') as HTMLElement | null
    if (!el || !tip) return
    const ci = Number(el.dataset.ci); if (Number.isNaN(ci)) return
    const c = cols[ci]
    g.querySelectorAll('.colhi').forEach(x => x.classList.remove('colhi'))
    g.querySelectorAll('.gbhi').forEach(x => x.classList.remove('gbhi'))
    if (!c) return
    cols.forEach((cc, k) => {                // 同じ群の列すべて(=1 サイト分)を光らせる
      if (cc.g !== c.g) return
      g.querySelectorAll(`.c[data-ci="${k}"]`).forEach(x => x.classList.add('colhi'))
    })
    g.querySelectorAll(`.gb[data-g="${c.g}"]`).forEach(x => x.classList.add('gbhi'))
    onHoverNode?.(c.nodes)                   // ← グラフ上の対応ノード(群の全メンバ)を強調
    const comp: Record<string, number> = {}
    for (const r of rows) { const ch = r.seq[ci]; if (ch === '~') continue; comp[ch] = (comp[ch] || 0) + 1 }
    const parts = Object.keys(comp).sort((a, b) => comp[b] - comp[a]).map(k => `${k === '-' ? '–' : k}×${comp[k]}`).join('  ')
    const rowEl = el.closest('.r') as HTMLElement | null
    const rowLab = rowEl?.querySelector('.rl')?.textContent || ''
    const ch = el.dataset.ch || ''
    tip.innerHTML = `<div class="n">${c.nodes.join(' | ')}${c.rb ? '  ·  ' + refLbl + c.rb.toLocaleString() : ''}</div>` +
      `<div class="row"><span>${c.nodes.length > 1 ? c.nodes.length + ' アレル同一サイト' : c.variant ? 'variant site' : 'conserved'}</span>` +
      `<span>${parts}</span></div>` +
      (rowLab ? `<div class="row"><span>${rowLab}</span><span>${ch === '-' ? 'gap' : ch === '~' ? '…' : ch}</span></div>` : '') +
      (el.dataset.inv ? '<div class="row" style="color:#7c3aed">この行は逆向きに通過（逆相補で表示）</div>' : '')
    tip.style.opacity = '1'
  }
  function onMove(e: React.MouseEvent) {
    const tip = tipRef.current; if (!tip) return
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 270) + 'px'
    tip.style.top = Math.max(8, e.clientY - 90) + 'px'
  }
  function onLeave() {
    gridRef.current?.querySelectorAll('.colhi').forEach(x => x.classList.remove('colhi'))
    gridRef.current?.querySelectorAll('.gbhi').forEach(x => x.classList.remove('gbhi'))
    gridRef.current?.querySelectorAll('.samphi').forEach(x => x.classList.remove('samphi'))
    if (tipRef.current) tipRef.current.style.opacity = '0'
    onHoverNode?.(null)
  }
  function onClick(e: React.MouseEvent) {
    const el = (e.target as HTMLElement).closest('.c,.gb') as HTMLElement | null
    if (!el) return
    const ci = Number(el.dataset.ci); if (Number.isNaN(ci)) return
    setSortCol(prev => prev === ci ? null : ci)
  }

  const wrap: React.CSSProperties = { height: '100%', display: 'flex', flexDirection: 'column', background: '#fff', boxSizing: 'border-box' }

  return (
    <div className="bmsa" style={wrap} onMouseMove={onMove}>
      <style>{STYLE}</style>
      {/* ── 選択・計算バー ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', padding: '7px 10px',
        borderBottom: '1px solid #e0e5ea', font: '12px sans-serif' }}>
        <b style={{ font: '600 13px sans-serif' }}>Bubble MSA</b>
        <button onClick={onTogglePick} style={btn(pickMode)} title="ON にするとグラフのノードクリックで対象に追加">
          {pickMode ? '● ノード選択中（クリックで追加）' : '＋ ノード選択'}
        </button>
        <button onClick={onFillBetween} style={btn(false, pickedNodes.length !== 2)} disabled={pickedNodes.length !== 2}
          title="2 ノードが source/sink のとき、その間のノードを全選択">↔ 間を全選択</button>
        <span style={{ color: '#556', display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', maxWidth: 420 }}>
          {pickedNodes.length === 0
            ? <i style={{ color: '#99a' }}>ノード未選択</i>
            : pickedNodes.slice(0, 14).map(nm => (
              <span key={nm} className="bmsa-chip"
                onMouseEnter={() => onHoverNode?.([nm])} onMouseLeave={() => onHoverNode?.(null)}>
                {nm}<b onClick={() => onRemoveNode(nm)}>✕</b></span>))}
          {pickedNodes.length > 14 && <span style={{ color: '#99a' }}>+{pickedNodes.length - 14}</span>}
        </span>
        {pickedNodes.length > 0 && <button onClick={onClearNodes} style={btn(false)} title="ノード選択を全解除">clear</button>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span title={sampleKeys.length ? 'MSA 対象パス:\n' + sampleKeys.join('\n') : 'パスパネルで対象を選択'}
            style={{ color: sampleKeys.length ? '#0f766e' : '#c0392b' }}>
            {sampleKeys.length ? `MSA 対象 ${sampleKeys.length} 群` : '全サンプル（重い）'}
          </span>
          <label style={{ color: '#889' }} title="選択ノード集合の前後に何ノード分の文脈を含めるか">文脈±
            <input type="number" min={0} max={12} value={flank} onChange={e => setFlank(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
              style={{ width: 34, marginLeft: 3 }} /></label>
          <button onClick={compute} disabled={pickedNodes.length === 0 || loading}
            style={btn(true, pickedNodes.length === 0 || loading)}>{data ? '再計算' : 'MSA 計算'}</button>
        </span>
      </div>

      {sampleKeys.length === 0 && !data && (
        <div style={{ padding: '6px 10px', color: '#8a6d3b', background: '#fcf8e3', font: '12px sans-serif', borderBottom: '1px solid #f0e6c0' }}>
          対象サンプル／ハプロタイプ／コンティグを「パス」パネルで選ぶと計算が軽くなります（未選択だと選択ノードを通る全パスが対象）。
        </div>
      )}

      {/* ── 結果 ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px' }}>
        {loading && <div style={{ color: '#8a93a0', font: '13px sans-serif' }}>Extracting alignment…</div>}
        {err && <div style={{ color: '#b45309', font: '13px sans-serif' }}>{err}</div>}
        {!loading && !err && !data && (
          <div style={{ color: '#8a93a0', font: '13px sans-serif' }}>
            グラフで bubble（S ノード）や任意ノードを選び（2 ノードなら「間を全選択」で内部を展開）、対象パスを選んで「MSA 計算」。
          </div>
        )}
        {data && !loading && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: 6, font: '12px sans-serif', alignItems: 'center' }}>
              <span style={{ fontFamily: 'ui-monospace,monospace', color: '#0f766e' }}>
                {data.name}{data.bp ? `  ·  ${refLbl}${data.bp.toLocaleString()}` : ''}</span>
              <span style={{ color: '#667' }}>{data.nrow} rows · {data.nallele} alleles</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: '#889' }}>書出</span>
                <button onClick={() => data && downloadText(sanitizeName(data.name || 'bubble') + '.fasta', toFasta(data), 'text/x-fasta')}
                  style={btn(false)} title="MSA を FASTA で書き出し（base 列のみの整列・各行 allele/strand 付き）">FASTA</button>
                <button onClick={() => data && downloadText(sanitizeName(data.name || 'bubble') + '.aln', toClustal(data), 'text/plain')}
                  style={btn(false)} title="MSA を CLUSTAL 形式で書き出し">CLUSTAL</button>
                <button onClick={() => data && downloadText(sanitizeName(data.name || 'bubble') + '.alleles.tsv', toAlleleTsv(data), 'text/tab-separated-values')}
                  style={btn(false)} title="どのハプロタイプがどのアレルか（TSV: label/allele/is_ref/strand/path/seq）">アレル表</button>
                <button onClick={() => data && downloadText(sanitizeName(data.name || 'bubble') + '_msa.svg', buildMsaSvg(data, rows, diff, refRow), 'image/svg+xml')}
                  style={btn(false)} title="MSA グリッドを図版 SVG で書き出し（表示どおりの着色・別ファイル）">SVG</button>
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: '#889' }}>並び</span>
                <button onClick={() => { setSortBy('allele'); setSortCol(null) }}
                  style={btn(sortCol == null && sortBy === 'allele')} title="同じアレル(整列配列)の行をまとめる">アレル順</button>
                <button onClick={() => { setSortBy('sample'); setSortCol(null) }}
                  style={btn(sortCol == null && sortBy === 'sample')} title="サンプル名（sample#hap）順に並べる">サンプル順</button>
                <button onClick={() => setDiff(d => !d)} style={btn(diff)}>差分表示: {diff ? 'ON' : 'OFF'}</button>
                <button onClick={() => setSortCol(null)} style={btn(false, sortCol == null)} disabled={sortCol == null}
                  title="列クリックによる並べ替えを解除">列ソート解除</button>
              </span>
            </div>
            <div ref={gridRef} onMouseOver={onOver} onMouseLeave={onLeave} onClick={onClick} style={{ overflowX: 'auto', paddingBottom: 6 }}>
              {/* ノードブロック見出し: 1 群 = 1 ブロック。交互色＋左境界線でノードの境界を明示、
                  多アレル群(同じサイトの排他アレル)は teal＋`n…[1|2|3]` 表記、参照アンカーは下線。 */}
              <div className="gblk"><span className="rl" /><span className="stb" />
                {blocks.map(b => (
                  <span key={b.g} data-ci={b.from} data-g={b.g} style={{ width: b.w, minWidth: b.w }}
                    className={'gb' + (b.g % 2 ? ' odd' : '') + (b.nodes.length > 1 ? ' alt' : '') + (b.rb ? ' anc' : '')}
                    title={b.nodes.join(' | ') + (b.rb ? '\n' + refLbl + b.rb.toLocaleString() : '') +
                      (b.nodes.length > 1 ? '\n' + b.nodes.length + ' アレル同一サイト' : '')}>
                    {fitLabel(b.nodes, b.w)}</span>))}
              </div>
              <div className="ruler"><span className="rl" /><span className="stb" />
                {cols.map((c, ci) => <span key={ci} data-ci={ci}
                  className={'c' + (c.kind === 'ell' ? ' ell' : '') + (c.variant ? ' var' : '') + (gStart.has(ci) ? ' gs' : '')}>
                  {c.variant ? '▾' : ''}</span>)}
              </div>
              {rows.map((r, ri) => {
                const isRR = r === refRow
                const iv = invCols.get(r)
                return <div key={ri} className={'r' + (r.isref ? ' ref' : '')} data-samp={r.samp}>
                  <span className="rl" title={r.path || r.label}>{r.label || r.samp}</span>
                  <span className={'stb ' + (r.strand === '+' ? 'plus' : 'minus')}
                    title={'この行の優勢向き（' + (r.strand === '+' ? 'グラフの + 鎖' : '逆走 contig') + '）'}>
                    {r.strand === '+' ? '+' : '−'}</span>
                  {cols.map((c, ci) => {
                    const ch = r.seq[ci]; let cls = 'c', txt = ch
                    // ★ 幅は「列」で決める。畳み列(⋯)は 20px だが、これを文字(ch==='~')で判定すると
                    //   同じ列でも ⋯ を持たない行だけ 15px になって行同士がズレる。
                    if (c.kind === 'ell') cls += ' ell'
                    if (ch === '~') txt = '⋯'
                    else if (ch === '-') { cls += ' gap'; txt = '–' }
                    else if (diff && !isRR && ch === refRow?.seq[ci]) { cls += ' match'; txt = '·' }
                    else cls += ' ' + baseCls(ch)
                    if (c.variant) cls += ' var'
                    if (gStart.has(ci)) cls += ' gs'
                    // 局所反転: この行が周りと逆向きに通ったノード。塩基は逆相補で入っている。
                    const inv = iv?.has(ci)
                    if (inv) cls += ' invc'
                    return <span key={ci} className={cls} data-ci={ci} data-ch={ch}
                      data-inv={inv ? '1' : undefined}>{txt}</span>
                  })}
                </div>
              })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8, font: '12px sans-serif', color: '#667' }}>
              <Lg s={{ color: '#166534', background: '#d7f2df' }}>A</Lg><Lg s={{ color: '#1e40af', background: '#dbe6fe' }}>C</Lg>
              <Lg s={{ color: '#854d0e', background: '#fdf0a8' }}>G</Lg><Lg s={{ color: '#b91c1c', background: '#fddddd' }}>T</Lg>
              <span>· = 参照一致</span><span style={{ padding: '0 4px', background: 'repeating-linear-gradient(45deg,#eef1f4,#eef1f4 3px,#e2e6ea 3px,#e2e6ea 6px)' }}>– = gap（欠失）</span>
              <span>⋯ = 畳んだノード</span><span>▾ = variant（列クリックでソート／列 hover でグラフ強調）</span>
              <span style={{ padding: '0 5px', background: '#dff0ee', color: '#0f766e', fontWeight: 700, borderLeft: '1px solid #c3ccd5' }}>n…[1|2]</span>
              <span>= 同じサイトの排他アレル（1 列に統合）</span>
              <span style={{ borderBottom: '2px solid #0f766e' }}>下線 = 参照座標アンカー</span>
              <span style={{ outline: '2px dashed #7c3aed', outlineOffset: -2, padding: '0 5px' }}>逆向き通過</span>
              <span>= 周りと逆向きに通ったノード（塩基は逆相補で表示）</span>
            </div>
          </>
        )}
      </div>
      <div className="bmsa-tip" ref={tipRef} />
    </div>
  )
}

function Lg({ s, children }: { s: React.CSSProperties; children: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
    <span style={{ ...s, width: 15, height: 15, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: '700 11px ui-monospace,monospace' }}>{children}</span>
  </span>
}
