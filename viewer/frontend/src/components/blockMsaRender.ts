// @ts-nocheck
import type { BlockDrillRequest, BlockDrillResult } from '../api/client'
// 多解像度 MSA（共線ブロック）の描画。functions/msa_lod/hier_template.html の JS をそのまま移植（vanilla、canvas）。
// React 側は components/BlockMsa.tsx が薄く包む。ここは意図的に型を付けない（試作。本番化時に整える）。
const BODY = '\n<div class="toolbar"><button id="bk_compact" title="表示設定・説明・情報チップを隠す／出す（整列を広く見る）" aria-pressed="false">設定 ▴</button><div class="chips set" id="bk_chips" style="margin-left:0"></div>\n  <div class="grp"><span class="t">窓</span><nav class="crumbs" id="bk_crumbs" aria-label="階層"></nav></div>\n  <div class="grp"><span class="t">段（まとめ方）</span><span id="bk_ladder"></span></div>\n  <div class="grp set"><span class="t">並べ方</span><button id="bk_m_msa" aria-pressed="true">合意座標</button><button id="bk_m_own" aria-pressed="false">各行の並び</button></div>\n  <div class="grp set"><label title="隣り合う行で同じ錨（80% 以上の株が持つ共有ノード）の位置を線で結ぶ。ブロックの単位によらない対応線。交差＝逆位、扇状＝挿入・欠失、長い斜線＝転座"><input type="checkbox" id="bk_anc" checked>錨の対応線</label><label title="コアでないが 2 株以上が持つ一意ノードの対応を薄い線で足す。隣り合う株が共有する島・ファージが見える"><input type="checkbox" id="bk_anc2" checked>第二錨</label></div>\n  <div class="grp set"><span class="t">目盛り</span><button id="bk_a_cons" aria-pressed="true">ブロック累積 bp</button><button id="bk_a_ref" aria-pressed="false">参照 bp</button></div>\n  <div class="grp set"><span class="t">色</span><button id="bk_c_order" aria-pressed="true" title="合意順序で色を付ける（左→右の色相の帯）">順序</button><button id="bk_c_genes" aria-pressed="false" disabled title="ブロックの参照区間に重なる遺伝子の密度（個/Mb）。アノテのある DB だけ">遺伝子密度</button></div>\n  <div class="grp set"><span class="t">行順</span><button id="bk_o_tree" aria-pressed="true">系統樹</button><button id="bk_o_name" aria-pressed="false">名前</button></div>\n  <div class="grp set" id="bk_origingrp"><span class="t">原点</span><span id="bk_origintxt" class="t"></span><button id="bk_setorigin" disabled>選択ブロックを原点に</button><button id="bk_autoorigin">自動</button></div>\n  <div class="grp"><button id="bk_scopein" disabled>選択ブロックの内側へ →</button><button id="bk_base" disabled title="このブロックの各行のトークン範囲を塩基レベル MSA（MSA パネル）に渡す。列（葉）が 400 以下のブロックで使える">塩基へ ↓</button><button id="bk_scopeout" disabled>← 全体へ</button></div>\n  <div class="grp set"><span class="t">変異密度</span><button id="bk_v_minor" aria-pressed="true">少数派サイト</button><button id="bk_v_priv" aria-pressed="false">私有サイト</button><button id="bk_v_nonanc" aria-pressed="false">錨でない bp</button></div>\n  <div class="grp set"><span class="t">基準</span><button id="bk_n_abs" aria-pressed="true">絶対（層内百分位）</button><button id="bk_n_block" aria-pressed="false">ブロック相対</button><button id="bk_n_hap" aria-pressed="false">株相対</button></div>\n  <div class="grp set"><label><input type="checkbox" id="bk_bund" checked>束ねる</label></div>\n  <div class="grp set"><label title="窓や絞り込みを変えると、グラフをその範囲に寄せ、範囲に合う層で表示する"><input type="checkbox" id="bk_sync" checked>グラフ連動</label><label title="パスパネルで選んだ（行ラベルをクリックした）ハプロタイプの行だけを表示"><input type="checkbox" id="bk_onlysel">選択行のみ</label></div>\n</div>\n<div class="legend" id="bk_legend"></div>\n<div class="bkmain">\n  <div id="bk_corner"><span title="列見出し: クリック=ブロック選択 · ダブルクリック=内側へ · ドラッグ=任意の区間の窓（範囲で降りる）">ハプロタイプ ↓ · 列見出しをドラッグ＝範囲の窓</span><span id="bk_scopetxt"></span></div>\n  <div id="bk_hdrwrap"><canvas id="bk_hdr"></canvas></div>\n  <aside id="bk_detail"><h3>詳細 <button id="bk_copybtn" title="詳細の文字をコピー">コピー</button></h3><div id="bk_detailbody"><p class="k">矢印や列見出しにホバーすると詳細が出ます。クリックで固定。ダブルクリックでそのブロックの内側へ（どの段からでも）。</p></div></aside>\n  <div id="bk_body"><div id="bk_treewrap"><svg id="bk_tree" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="bk_labwrap"></div><div id="bk_gridwrap"><canvas id="bk_grid"></canvas></div></div>\n</div>\n';
const CSS = '.bkmsa{--bg:#f3f6f7;--panel:#fff;--ink:#1b2530;--muted:#64707c;--line:#d3dbe1;--line2:#e7ecf0;--accent:#0d9488;--ref:#fff3e0;--reflab:#7a4b00;\n  --sel:#ff1493;--selbg:rgba(255,20,147,.12);--hover:rgba(13,148,136,.10);--shadow:0 6px 20px rgba(20,30,40,.14);--tick:#8a96a3;--rep:#6b7480;--gap:#eef2f5;--inv:#7c3aed;--disp:#d98200;--abs:#c9d1d8}.bkmsa *{box-sizing:border-box}.bkmsa{background:var(--bg);color:var(--ink);font:13px/1.45 "IBM Plex Sans",system-ui,sans-serif;display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}.bkmsa .chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.bkmsa .chip{font:11.5px "IBM Plex Mono",monospace;color:var(--muted);border:1px solid var(--line2);border-radius:999px;padding:2px 9px;background:var(--bg)}.bkmsa .chip b{color:var(--ink);font-weight:500}.bkmsa .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .grp{display:flex;align-items:center;gap:5px;padding-right:12px;border-right:1px solid var(--line2)}.bkmsa .grp:last-child{border-right:0}.bkmsa .grp .t{font-size:11.5px;color:var(--muted);margin-right:2px}.bkmsa button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:3px 9px;font:12px "IBM Plex Sans",sans-serif;cursor:pointer}.bkmsa button:hover{border-color:var(--accent)}.bkmsa button[disabled]{opacity:.45;cursor:default}.bkmsa button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa button.mono{font-family:"IBM Plex Mono",monospace}.bkmsa button:focus-visible, .bkmsa input:focus-visible{outline:2px solid var(--sel);outline-offset:1px}.bkmsa label{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px}.bkmsa input[type=checkbox]{accent-color:var(--accent)}.bkmsa .crumbs{display:flex;align-items:center;gap:3px;flex-wrap:wrap}.bkmsa .crumbs .sep{color:var(--muted);font-size:12px}.bkmsa .crumb{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:2px 8px;font:12px "IBM Plex Mono",monospace;cursor:pointer}.bkmsa .crumb[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa .legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted);padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .legend canvas{vertical-align:middle}.bkmsa.compact .set,.bkmsa.compact .legend{display:none}.bkmsa #bk_compact{font-size:11.5px;padding:2px 7px;color:var(--muted)}.bkmsa .bkmain{flex:1;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr) 320px;grid-template-rows:40px 1fr;min-height:0;background:var(--panel)}.bkmsa #bk_corner{grid-column:1/3;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10.5px;color:var(--muted);padding:4px 8px;display:flex;align-items:flex-end;justify-content:space-between}.bkmsa #bk_hdrwrap{border-bottom:1px solid var(--line);position:relative;overflow:hidden}.bkmsa #bk_detail{grid-row:1/3;border-left:1px solid var(--line);padding:10px 12px;overflow:auto;font:12px/1.55 "IBM Plex Mono",monospace;user-select:text;-webkit-user-select:text}.bkmsa #bk_detail h3{font:600 12px "IBM Plex Sans",sans-serif;margin:0 0 6px;color:var(--muted);display:flex;justify-content:space-between;align-items:center}.bkmsa #bk_detail .k{color:var(--muted)}.bkmsa #bk_detail .h{color:var(--accent);font-weight:500}.bkmsa #bk_detail p{margin:0 0 8px}.bkmsa #bk_detail ul{margin:0 0 8px;padding-left:16px}.bkmsa #bk_detail li{margin:0}.bkmsa #bk_body{grid-column:1/4;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr);overflow-y:auto;overflow-x:auto;min-height:0}.bkmsa #bk_treewrap{position:sticky;left:0;z-index:2;background:var(--panel)}.bkmsa #bk_labwrap{border-right:1px solid var(--line);position:sticky;left:var(--treew,130px);z-index:2;background:var(--panel)}.bkmsa .lab{position:absolute;left:0;right:0;height:30px;display:flex;align-items:center;padding:0 8px;font:11px "IBM Plex Mono",monospace;white-space:nowrap;overflow:hidden;\n  user-select:text;-webkit-user-select:text;border-bottom:1px solid var(--line2)}.bkmsa .lab.ref{background:var(--ref);color:var(--reflab)}.bkmsa .lab.hov{background:var(--hover)}.bkmsa .lab small{color:var(--muted);margin-left:6px;font-size:10px}.bkmsa #bk_gridwrap{position:relative}.bkmsa canvas{display:block}.bkmsa .sw{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:-1px;margin-right:4px}.bkmsa #bk_copybtn{font-size:11px;padding:1px 7px}.bkmsa .hapdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px;flex:none}\n@media (max-width:900px){.bkmain{grid-template-columns:0 120px 1fr 0}.bkmsa #bk_body{grid-template-columns:0 120px 1fr}.bkmsa #bk_detail{display:none}}\n';
export interface BlockRef { win: number; level: number; W: number; rank: number; name: string; ref_contig: number; x: number; span: number; tbp: number; nhap: number; label: string }
export interface GeneLite { name: string; start: number; end: number; strand?: string }
export interface BlockMsaHandle { selectByRef(contig: number, bp: number): boolean; setHapMarks(m: Map<string, string>): void; setGenes(g: Map<number, GeneLite[]>): void; destroy(): void; _layout?: () => any }
// 現在見えている窓・段のブロック一覧（色つき）。App がグラフのノードをブロック色で塗るのに使う
export interface BlockView { win: number; level: number; W: number; mode: string; tree?: boolean; blocks: { rank: number; color: string; ref_contig: number; x: number; span: number; label: string; members: number[] }[]; scope: { contig: number; start: number; end: number } | null; scopeKey: string; sync: boolean; n0: number }
export interface BlockMsaCallbacks { onSelectBlock?: (b: BlockRef | null) => void; onHoverBlock?: (b: BlockRef | null) => void; onDrill?: (req: BlockDrillRequest) => Promise<BlockDrillResult>; onRange?: (x0: number, x1: number, label: string, depth: number, parent: number, pblock: number) => Promise<any>; onSites?: (q: { c0?: number; c1?: number; x0?: number; x1?: number }) => Promise<any>; onView?: (v: BlockView | null) => void; onSelectHap?: (groupKey: string, hap: string) => void; onBaseMsa?: (req: BlockDrillRequest) => void }
// MSA の行（ハプロタイプ名。例 'HG00673#1', 'GCF_013459175.1#1', 'grch38#chrY'）を、グラフのパス群の鍵
// （sample 'HG00673' / haplotype 'HG00673#1' / ecoli では haplotype 'GCF_013459175.1', sample 'GCF_013459175'）に合わせる
export function hapCandidates(hap: string): string[] {
  const noHap = hap.replace(/#\d+$/, ''), sample = hap.split('#')[0]
  return [...new Set([hap, noHap, sample, sample.replace(/\.\d+$/, '')])]
}
export function matchHapToKey(hap: string, keys: Iterable<string>): string | null {
  const ks = new Set(keys); for (const c of hapCandidates(hap)) if (ks.has(c)) return c; return null
}
function injectStyle(){ if (document.getElementById('bkmsa_style')) return; const s = document.createElement('style'); s.id = 'bkmsa_style'; s.textContent = CSS; document.head.appendChild(s); }
export function mountBlockMsa(root: HTMLElement, DATA: any, cb: BlockMsaCallbacks): BlockMsaHandle {
  injectStyle(); root.classList.add('bkmsa'); root.innerHTML = BODY;

'use strict';
const WINS = DATA.windows;
const TREE = !!(DATA.meta && DATA.meta.tree);   // 窓に依らない一つの木（.synteny）。窓は backend の範囲問い合わせで作る
function win(){ return WINS[st.win]; }
function winPath(){ const p=[]; let w=st.win; while (w>=0){ p.unshift(WINS[w]); w=WINS[w].parent; } return p; }
const $ = id => root.querySelector('#bk_'+id);
const css = n => getComputedStyle(root).getPropertyValue(n).trim();
let TH = {}; function readTheme(){ TH = {ink:css('--ink'),muted:css('--muted'),line:css('--line'),line2:css('--line2'),ref:css('--ref'),reflab:css('--reflab'),sel:css('--sel'),selbg:css('--selbg'),hover:css('--hover'),panel:css('--panel'),accent:css('--accent'),tick:css('--tick'),rep:css('--rep'),gap:css('--gap'),inv:css('--inv'),disp:css('--disp'),abs:css('--abs')}; }
readTheme();
const RH = 30, MINW = 4, SEP = 2;
const BUNDLE_FRAC = 0.3;   // 束に入れるのはブロックの典型長のこの割合未満の断片だけ
const KINDN = {0:'主鎖',2:'変位（同じ向きで別の位置）',3:'逆位',4:'錨なし区間（反復・参照に無い配列・非コア）',5:'閾値未満の小ブロック群'};
const RAMP = [[68,1,84],[72,36,117],[65,68,135],[53,95,141],[42,120,142],[33,145,140],[34,168,132],[68,191,112],[122,209,81],[189,223,38],[253,231,37]];
function ramp(t){ t=Math.max(0,Math.min(1,t)); const k=t*(RAMP.length-1), i=Math.min(RAMP.length-2,Math.floor(k)), f=k-i; const a=RAMP[i], b=RAMP[i+1]; return `rgb(${Math.round(a[0]+(b[0]-a[0])*f)},${Math.round(a[1]+(b[1]-a[1])*f)},${Math.round(a[2]+(b[2]-a[2])*f)})`; }
function varSites(it){ if (it._vs) return it._vs; if (!it[12]) return (it._vs = new Uint8Array(0)); const b = atob(it[12]); const u8 = new Uint8Array(b.length); for (let i=0;i<b.length;i++) u8[i]=b.charCodeAt(i); it._vs = u8; return it._vs; }
function consSites(it){ if (it._cvs) return it._cvs; if (!it[19]) return (it._cvs = new Uint8Array(0)); const b = atob(it[19]); const u8 = new Uint8Array(b.length); for (let i=0;i<b.length;i++) u8[i]=b.charCodeAt(i); it._cvs = u8; return it._cvs; }
function measureOf(it){ if (!(it.length>11) || it[2]<=0) return null; if (st.measure==='minor') return it[11]/it[2]*1000; if (st.measure==='priv') return (it[15]||0)/it[2]*1000; return 1 - it[10]/it[2]; }
const _stats = new Map();
function densStats(){ const key = st.li+'|'+st.measure; if (_stats.has(key)) return _stats.get(key); const L = level(); const all = []; const byBlock = new Map(), byHap = new Map();
  L.haps.forEach((h,hi)=>{ for (const c of h.contigs) for (const x of c.inst){ if (x[5]>=4) continue; const v = measureOf(x); if (v==null) continue; all.push(v); if (!byBlock.has(x[0])) byBlock.set(x[0], []); byBlock.get(x[0]).push(v); if (!byHap.has(hi)) byHap.set(hi, []); byHap.get(hi).push(v); } });
  all.sort((a,b)=>a-b); const med = arr => { const a = arr.slice().sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };
  const st_ = {all, blockMed: new Map([...byBlock].map(([k,v])=>[k, med(v)])), hapMed: new Map([...byHap].map(([k,v])=>[k, med(v)]))}; _stats.set(key, st_); return st_; }
function pct(all, v){ let lo=0, hi=all.length; while (lo<hi){ const m=(lo+hi)>>1; if (all[m]<=v) lo=m+1; else hi=m; } return all.length ? lo/all.length : 0; }
function diverge(t){ // t in [-1,1]: 青(少) – 白 – 赤(多)
  t = Math.max(-1, Math.min(1, t)); const a = t<0 ? [37,99,235] : [220,38,38]; const f = Math.abs(t); return `rgb(${Math.round(255+(a[0]-255)*f)},${Math.round(255+(a[1]-255)*f)},${Math.round(255+(a[2]-255)*f)})`; }
function cellFill(it, hapIdx){ const v = measureOf(it); if (v==null) return null; const S = densStats();
  if (st.norm==='abs'){ const p = pct(S.all, v); return {color: TH.ink, alpha: 0.08 + 0.82*p, txt:`層内百分位 ${(100*p).toFixed(0)}%`}; }
  const ref = st.norm==='block' ? S.blockMed.get(it[0]) : S.hapMed.get(hapIdx); if (!ref) return {color: TH.ink, alpha: 0.1, txt:'基準なし'};
  const l2 = Math.log2(Math.max(1e-6, v)/Math.max(1e-6, ref)); return {color: diverge(l2/2), alpha: 1, txt:`${st.norm==='block'?'ブロック中央値':'株中央値'}の ${(v/ref).toFixed(2)} 倍`}; }
const _densRef = new Map();
function levelDensRef(){ if (_densRef.has(st.li)) return _densRef.get(st.li); const L = level(); const d = [];
  for (const h of L.haps) for (const c of h.contigs) for (const x of c.inst) if (x[5]<4 && x.length>12 && x[2]>0) d.push(x[11]/x[2]*1000);
  d.sort((a,b)=>a-b); const ref = d.length ? Math.max(0.5, 2*d[Math.floor(d.length/2)]) : 10; _densRef.set(st.li, ref); return ref; }
function fmtbp(x){ if (x>=1e6) return (x/1e6).toFixed(x>=1e7?1:2)+' Mb'; if (x>=1e3) return (x/1e3).toFixed(x>=1e5?0:1)+' kb'; return x+' bp'; }
const esc = s => String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const st = { drilling:false, busy:null, anc:true, anc2:true, rangeSel:null, hoverRank:null, filter:null, filterPath:[], sync:true, onlySel:false, hapMarks:new Map(), genes:new Map(), colorBy:'order', win: 0, li: 0, mode:'msa', axis:'cons', order:'tree', origin:null, sel:null, hover:null, pinned:false, showMinor:true, bundle:true, showLinks:false, measure:'minor', norm:'abs'};
if (st.li<0) st.li=0;
st.li = Math.max(0, win().levels.length-1);   // 既定は最も粗い段
const cv = {hdr:$('hdr'), grid:$('grid')};
function sizeCanvas(c,w,h){ const r=window.devicePixelRatio||1; c.width=Math.max(1,Math.round(w*r)); c.height=Math.max(1,Math.round(h*r)); c.style.width=w+'px'; c.style.height=h+'px'; const g=c.getContext('2d'); g.setTransform(r,0,0,r,0,0); return g; }
function level(){ return win().levels[st.li]; }
function nb(){ return level().nblocks; }
function originRank(){ return st.origin==null ? (level().origin!=null ? level().origin : 0) : Math.min(st.origin, nb()-1); }   // origin が無い古いサイドカーでも NaN にしない
function rr(rank){ return DATA.meta.circular && st.win===0 ? ((rank - originRank()) % nb() + nb()) % nb() : rank; }

// ---- ブロックインスタンスの表示順（反転・回転） ----
function displaySeq(c){
  let seq = c.inst.map(x=>({it:x, rank:x[0], dir:x[1], kind:x[5]}));
  if (c.strand==='-') seq = seq.reverse().map(o=>({...o, dir:1-o.dir}));
  if (DATA.meta.circular && st.win===0 && seq.length>1){
    let s=-1, best=1e9; seq.forEach((o,i)=>{ if (o.kind===0){ const r=rr(o.rank); if (r<best){best=r; s=i;} } });
    if (s>0) seq = seq.slice(s).concat(seq.slice(0,s));
    // コンティグの切れ目がブロックの内側に落ちて、同じブロックの主鎖が末尾と先頭に割れていたら 1 つに繋ぐ（環状ゲノム）
    const a = seq[seq.length-1], b = seq[0];
    if (seq.length>2 && a.kind===0 && b.kind===0 && a.rank===b.rank && a.it.length>12 && b.it.length>12){
      const A = a.it, Bt = b.it; const bpA = A[2], bpB = Bt[2], tot = bpA + bpB;
      const merge = (u8s, off, bp) => Array.from(u8s).map(v => Math.round((off + v/255*bp)/tot*255));
      const vs = Uint8Array.from([...merge(varSites(A), 0, bpA), ...merge(varSites(Bt), bpA, bpB)]);
      const gaps = [...(A[14]||[]).map(g=>[Math.round(g[0]/255*bpA/tot*255), Math.round(g[1]/255*bpA/tot*255), g[2]]), ...(Bt[14]||[]).map(g=>[Math.round((bpA+g[0]/255*bpB)/tot*255), Math.round((bpA+g[1]/255*bpB)/tot*255), g[2]])];
      const it = [A[0], A[1], tot, A[3]+Bt[3], 1, 0, A[6], A[7]+Bt[7], A[8], Bt[9], A[10]+Bt[10], A[11]+Bt[11], '', Math.max(A[13]||0, Bt[13]||0), gaps, (A[15]||0)+(Bt[15]||0)]; it._vs = vs; it._merged = true;
      seq = [{it, rank:a.rank, dir:a.dir, kind:0}].concat(seq.slice(1, seq.length-1));
    }
  }
  return seq;
}
// LIS（スコープ内の主鎖再計算）
function lisKinds(seq){
  const m = seq.length; const best = new Array(m).fill(0), prev = new Array(m).fill(-1); let bi=-1, bs=-1;
  for (let i=0;i<m;i++){ if (seq[i].kind>=4 || seq[i].dir===0) { best[i]=-1; continue; } let b=0, p=-1; for (let j=0;j<i;j++){ if (best[j]>=0 && seq[j].rank<=seq[i].rank && best[j]>b){ b=best[j]; p=j; } } best[i]=b+seq[i].it[2]; prev[i]=p; if (best[i]>bs){bs=best[i]; bi=i;} }
  const chain = new Set(); while (bi>=0){ chain.add(bi); bi=prev[bi]; }
  return seq.map((o,i)=>({...o, kind: o.kind>=4 ? o.kind : (chain.has(i) ? 0 : (o.dir===0 ? 3 : 2))}));
}

// ---- 行の構築 ----
// 返り値 rows: [{label, sub, hap, isref, contigs:[{c, seq(display), s0?, e0?}], hapIdx}]
function buildRows(){
  const L = level(); const rows = [];
  const nameToIdx = new Map(L.haps.map((h,i)=>[h.hap,i]));
  const hapOrder = st.order==='tree' && DATA.tree ? DATA.tree.order.map(i=>nameToIdx.get(DATA.tree.haps[i])).filter(i=>i!=null) : L.haps.map((h,i)=>i);
  const hapIndexByName = new Map(L.haps.map((h,i)=>[h.hap,i]));
  for (const hi0 of hapOrder){
    const h = L.haps[hi0]; if (!h) continue;
    const gk = st.hapMarks.size ? matchHapToKey(h.hap, st.hapMarks.keys()) : null;
    if (st.onlySel && st.hapMarks.size && !gk) continue;          // 選択行のみ: グラフで選んだハプロタイプに合う行だけ
    rows.push({label:h.hap, sub:`${h.contigs.length} ctg`, hap:h.hap, isref:h.isref, hapIdx:hi0, mark: gk ? st.hapMarks.get(gk) : null, gkey: gk, contigs:h.contigs.map(c=>({c, seq:displaySeq(c)}))});
  }
  return rows;
}

// ---- 列（ブロック列＋隙間列）とスロット割り付け ----
let LY = null;
// 段は「まとめ方」: 粗い段のブロックは最細段のブロックの集合（L.members[rank]）。最細段は自分自身
function membersOf(L, rank){ return (L.members && L.members[rank]) ? L.members[rank] : [rank]; }
function visibleBlocks(){ const L = level(); const out=[];
  L.blocks.forEach((b,i)=>{ if (!st.filter){ out.push(i); return; } if (membersOf(L, i).some(m=>st.filter.has(m))) out.push(i); });
  if (DATA.meta.circular && st.win===0) out.sort((a,b)=>rr(a)-rr(b)); return out; }
function computeLayout(){
  const L = level(); const rows = buildRows(); const vis = visibleBlocks(); const posOf = new Map(vis.map((b,i)=>[b,i]));   // block -> 列位置 (0..n-1)
  const n = vis.length;
  for (const r of rows){
    for (const ct of r.contigs){
      ct.items = [];
      for (const o of ct.seq){
        const home = posOf.has(o.rank) ? posOf.get(o.rank) : null;
        if (home==null) continue;                                  // スコープ外・未表示のブロック
        ct.items.push({o, slot:{type:'block', pos:home, lane: o.kind===0 ? 0 : 1}});
      }
    }
  }
  // 列の幅: ブロック = bpmax、隙間 = 最大合計。最小幅つきの比例配分
  const W = $('gridwrap').clientWidth - 8;
  const cols = [];  // {type:'block', rank, pos, bp}
  vis.forEach((b,i)=>{ cols.push({type:'block', rank:b, pos:i, bp:Math.max(1, L.blocks[b].tbp)}); });
  const totbp = cols.reduce((a,c)=>a+c.bp,0) || 1; let s = (W - SEP*cols.length)/totbp;
  for (let it=0; it<6; it++){ let fixed=0, flex=0; cols.forEach(c=>{ if (c.bp*s<MINW) fixed+=MINW; else flex+=c.bp; }); if (flex>0) s = (W - SEP*cols.length - fixed)/flex; }
  let x = 4; const blockX = new Map(); let cum = 0;
  cols.forEach(c=>{ c.x = x; c.w = Math.max(MINW, c.bp*s); c.cum = cum; cum += c.bp; x += c.w + SEP; blockX.set(c.rank, c); });
  // 各アイテムの x
  for (const r of rows){
    r.items = []; r.marks = []; r.minors = []; r.bundles = []; r.segs = []; const laneUsed = new Map();   // 下段: 同じ列に複数来たら右へずらす
    // 束: 1 ブロックに閉じたコンティグが同じブロックに 2 本以上（全体表示のみ）
    const bundled = new Set();
    if (st.bundle){ const byRank = new Map();
      // 束の対象は「1 ブロックに閉じていて、そのブロックの典型長の BUNDLE_FRAC 未満の断片」だけ。ブロックの大半を載せている
      // コンティグ（例: chrY HG00673 の #1 全体 330 kb）は束に入れず普通の矢印で描く。束は drawGrid で重ね矢印として描く
      for (const ct of r.contigs){ const rs = new Set(ct.seq.filter(o=>o.kind<4).map(o=>o.rank)); if (ct.seq.length && rs.size===1){ const rk=[...rs][0]; const B = L.blocks[rk]; if (B && ct.c.bp >= BUNDLE_FRAC*Math.max(1,B.tbp)) continue; if (!byRank.has(rk)) byRank.set(rk,[]); byRank.get(rk).push(ct); } }
      for (const [rk, cts] of byRank){ if (cts.length>=2 && blockX.has(rk)){ cts.forEach(ct=>bundled.add(ct)); const col=blockX.get(rk);
        const dirs = cts.flatMap(ct=>ct.seq.filter(o=>o.kind<4).map(o=>o.dir)); const dir = dirs.filter(d=>d===1).length*2 >= dirs.length ? 1 : 0;
        r.bundles.push({rank:rk, n:cts.length, dir, bp:cts.reduce((a,ct)=>a+ct.c.bp,0), contigs:cts.map(ct=>ct.c), x:col.x, w:col.w}); } } }
    r.markers = [];
    // 合意座標モード: 主鎖（上段）のブロック矢印は通過長でなく列の幅いっぱいに描き、中に欠け・挿入・変異を合意座標で描く
    // （drawGrid）。同じブロックを同じ行で複数回通る（再訪）ときは列を等分する
    const cnt0 = new Map();
    for (const ct of r.contigs){ if (bundled.has(ct)) continue; for (const {o, slot} of ct.items){ if (o.kind<4 && slot.lane===0) cnt0.set(o.rank, (cnt0.get(o.rank)||0)+1); } }
    let ownX = 4; const sOwn = W / Math.max(1, ...rows.map(rw=>rw.contigs.reduce((a,ct)=>a+ct.c.bp,0)));
    for (const ct of r.contigs){
      if (bundled.has(ct)) continue; const placed=[];
      for (const {o, slot} of ct.items){
        let px, pw; let p_extra = {}; const p = { get ext(){ return p_extra.ext; }, set ext(v){ p_extra.ext = v; }, get col(){ return p_extra.col; }, set col(v){ p_extra.col = v; } };
        const colw0 = (st.mode!=='own' && o.kind<4 && slot.lane===0) ? blockX.get(vis[slot.pos]).w / (cnt0.get(o.rank)||1) : null;
        const bpw = colw0!=null ? Math.max(MINW, colw0) : Math.max(MINW, o.it[2]*(st.mode==='own'?sOwn:s));
        if (o.kind<4 && o.it.length>20 && o.it[20]) p_extra.ext = o.it[20];      // 合意範囲は上段・下段・両モードで持つ（リボンの相手範囲の交わりに使う）
        if (st.mode==='own'){ px = ownX; pw = bpw; ownX += bpw + 1; }
        else { const col = blockX.get(vis[slot.pos]); pw = Math.min(col.w, bpw);
          if (slot.lane===0 && o.kind<4 && o.it.length>20 && o.it[20]){
            // 合意座標: インスタンスを列の中の自分の合意範囲 [ext0, ext1]（0..255）に置く。錨なし挿入やコンティグの切れ目で
            // 分断された断片は、等分でなく真の位置に（例: ecoli #7 は 94% と 6% の 2 片。等分すると中央に境界線が立ち、欠失に見えた）
            const e0 = o.it[20][0], e1 = Math.max(o.it[20][0]+1, o.it[20][1]);
            px = col.x + e0/255*col.w; pw = Math.max(2, (e1-e0)/255*col.w); p.col = col; }
          else if (slot.lane===0){ // 同じブロックが分断されて複数インスタンスになったら（合意範囲の無い古いデータ）、列の中で左から順に置く
            const used0 = laneUsed.get('u'+slot.pos)||0; px = col.x + used0; pw = Math.max(2, Math.min(bpw, col.x + col.w - px)); laneUsed.set('u'+slot.pos, used0 + pw + 2); }
          else { const used = laneUsed.get(slot.pos)||0; px = col.x + Math.min(used, Math.max(0, col.w - pw)); laneUsed.set(slot.pos, used + pw + 1); } }
        placed.push(Object.assign({o, slot, x:px, w:pw, ct}, p_extra)); p_extra = {};
      }
      if (st.mode==='own') ownX += 8;
      // 区間 = 表示順で連続し、合意ランクが向きに沿って ±1 ずつ進み、同じ段のブロックインスタンスの並び。錨なし/小群は単独
      const segs = [];
      for (const p of placed){ const o = p.o; const last = segs.length ? segs[segs.length-1] : null; const lp = last ? last.items[last.items.length-1].o : null;
        const cont = last && o.kind<4 && lp.kind<4 && (o.kind===0)===(lp.kind===0) && o.dir===lp.dir && o.rank === lp.rank + (lp.dir ? 1 : -1);
        if (cont) last.items.push(p); else segs.push({items:[p], lane: p.slot.lane, dir:o.dir, kind:o.kind}); }
      // 下段の配置: 行はそのハプロタイプのブロック順のまま。主鎖(上段)は合意列に揃え、主鎖から外れた項目は
      // 直前の主鎖の右端〜次の主鎖の左端の空きに、行の順どおり左→右に置く（その場の逆位なら空き＝元の列の範囲）。
      // 空きが足りなければ縮めて置き、空きが無ければ直前の主鎖の右端から最小幅で右へはみ出させる。
      // 錨なし区間(4)・小ブロック群(5)は段に置かず、行の順どおりの位置（直前の主鎖の右端）に小さな印として出す
      r.markers = r.markers || [];
      if (st.mode!=='own'){
        const excs = []; let cur = [], prevMain = null;
        for (const p of placed){ if (p.slot.lane===0){ if (cur.length) excs.push({items:cur, prev:prevMain, next:p}); cur = []; prevMain = p; } else cur.push(p); }
        if (cur.length) excs.push({items:cur, prev:prevMain, next:null});
        for (const E of excs){
          const blocks = E.items.filter(p=>p.o.kind<4), others = E.items.filter(p=>p.o.kind>=4);
          const left = E.prev ? E.prev.x + E.prev.w + SEP : null, right = E.next ? E.next.x - SEP : null;
          let mx = left!=null ? left : (right!=null ? right - 6*others.length : 4);
          for (const p of others){ r.markers.push({x: mx, o:p.o, ct:p.ct}); mx += 6; p.hidden = true; }
          if (!blocks.length) continue;
          const widths = blocks.map(p=> blockX.get(vis[p.slot.pos]).w);
          const need = widths.reduce((a,b)=>a+b,0) + SEP*(blocks.length-1);
          let x0, avail;
          if (left!=null && right!=null){ avail = Math.max(0, right - left); x0 = left; }
          else if (left!=null){ avail = need; x0 = left; }
          else if (right!=null){ avail = need; x0 = Math.max(4, right - need); }
          else { avail = need; x0 = 4; }
          // 隙間に入らなければ縮めるが 1/2 までにし、足りない分は右へはみ出させる（行末なら画面の外へ。キャンバスを広げて横スクロールで見る）。
          // 各ブロックを自分の合意の列に置く案は、1 つの逆位が 14 個の逆位に見えるので採らない（ecoli GCF_013459175）
          const sc = avail >= need ? 1 : Math.max(0.5, avail/need);
          let cx = x0; blocks.forEach((p,i)=>{ p.w = Math.max(2, widths[i]*sc); p.x = cx; cx += p.w + SEP*sc; });
        }
      }
      for (const sg of segs){ sg.x0 = Math.min(...sg.items.map(p=>p.x)); sg.x1 = Math.max(...sg.items.map(p=>p.x+p.w)); sg.r0 = sg.items[0].o.rank; sg.r1 = sg.items[sg.items.length-1].o.rank;
        const lower = st.mode!=='own' && sg.lane===1;                     // 下段は通過順に左→右で置いてあるので入口=左端、出口=右端
        sg.entryX = lower ? sg.x0 : (sg.dir ? sg.x0 : sg.x1); sg.exitX = lower ? sg.x1 : (sg.dir ? sg.x1 : sg.x0); sg.ct = ct; for (const p of sg.items) p.seg = sg; }
      r.segs.push(...segs);
      if (placed.length){ r.marks.push({c:ct.c, x0:Math.min(...placed.map(p=>p.x)), x1:Math.max(...placed.map(p=>p.x+p.w))}); }
      if (st.showMinor){ const sorted = placed.slice().sort((a,b)=>a.o.it[6]-b.o.it[6]);
        for (const m of ct.c.minor){ let host=null; for (const p of sorted){ if (p.o.it[6]<=m[0]) host=p; else break; }
          let frac = host ? Math.min(1, Math.max(0, (m[0]-host.o.it[6])/Math.max(1,host.o.it[2]))) : 0; if (ct.c.strand === '-') frac = 1 - frac;   // 通過内の位置は鎖で左右反転
          let mx = host ? host.x + frac*host.w : (sorted.length? sorted[0].x : null);
          if (mx!=null) r.minors.push({x:mx, m, c:ct.c}); } }
      r.items.push(...placed.filter(p=>!p.hidden));
    }
    if (st.mode==='own'){ for (const b of r.bundles){ b.x = ownX; b.w = Math.max(14, b.bp*sOwn); ownX += b.w + 8; b.lane = 0; } }   // 各行の並び: 束は行の末尾に
    else { for (const b of r.bundles){ b.lane = r.items.some(p=>p.slot.lane===0 && p.x < b.x+b.w && p.x+p.w > b.x) ? 1 : 0; } }   // 同じ列に全長の矢印があれば束は下段へ
  }
  // 列プロファイル: ブロックごとに ハプロの状態(主鎖/逆位/別位置/持たない(覆っているのに)) と 錨でない bp 割合の中央値
  const prof = new Map();
  if (true){
    for (const b of vis){ prof.set(b, {main:0, inv:0, disp:0, abs:0, div:[]}); }
    for (const h of L.haps){ const have = new Map(); let rmin=Infinity, rmax=-Infinity;
      for (const c of h.contigs) for (const x of c.inst){ if (x[5]>=4) continue; rmin=Math.min(rmin,x[0]); rmax=Math.max(rmax,x[0]); if (!have.has(x[0])) have.set(x[0], []); have.get(x[0]).push(x); }
      for (const b of vis){ const P = prof.get(b); const xs = have.get(b);
        if (xs){ const ks = new Set(xs.map(x=>x[5])); if (ks.has(3)) P.inv++; else if (ks.has(2)) P.disp++; else P.main++; for (const x of xs){ if (x.length>11 && x[2]>0) P.div.push(1 - x[10]/x[2]); } }
        else if (DATA.meta.circular || (b>rmin && b<rmax)) P.abs++; } }
    for (const [b,P] of prof){ const d = P.div.slice().sort((a,b)=>a-b); P.divmed = d.length ? d[Math.floor(d.length/2)] : null; }
  }
  let maxRight = W;
  for (const r of rows){ for (const p of r.items) maxRight = Math.max(maxRight, p.x + p.w); for (const b of (r.bundles||[])) maxRight = Math.max(maxRight, b.x + b.w); }
  const fullW = Math.ceil(maxRight) + 8;            // はみ出した分だけキャンバスを広げる（列の配置は W のまま）
  LY = {rows, vis, cols, blockX, s, W, n, prof, fullW};
}
// 遺伝子: ブロックの参照区間 [x, x+span] に重なる遺伝子（コンティグ別・start 昇順の配列を二分探索）
function genesOf(B){ const gs = st.genes.get(B.ref_contig!=null ? B.ref_contig : 0); if (!gs || !gs.length) return [];
  const x0 = B.x, x1 = B.x + B.span; let lo = 0, hi = gs.length; while (lo < hi){ const m = (lo+hi)>>1; if (gs[m].start < x0 - 5e6) lo = m+1; else hi = m; }
  const out = []; for (let i=lo; i<gs.length && gs[i].start <= x1; i++){ if (gs[i].end >= x0) out.push(gs[i]); } return out; }
function geneDensity(rank){ const B = level().blocks[rank]; if (!B) return 0; return genesOf(B).length / Math.max(1, B.span) * 1e6; }
let _gdMax = null;
function geneDensMax(){ if (_gdMax!=null) return _gdMax; const L = level(); let m = 0; for (let r=0; r<L.nblocks; r++) m = Math.max(m, geneDensity(r)); _gdMax = m || 1; return _gdMax; }
function densRamp(t){ t = Math.max(0, Math.min(1, t)); const a=[236,240,243], b=[178,24,43]; return `rgb(${Math.round(a[0]+(b[0]-a[0])*t)},${Math.round(a[1]+(b[1]-a[1])*t)},${Math.round(a[2]+(b[2]-a[2])*t)})`; }
// 色は最細段の並び（環状なら最細段の原点から）での位置。粗い段のブロックは含む最細ブロックの平均位置＝親子で色が対応し、絞り込んでも変わらない
// 色の回転の起点: 今の段の原点ブロックの先頭の最細ブロック（粗い段では原点を含むブロックの先頭。環状の全体窓だけ）
function hueOrigin(){ const L = level(); const L0 = win().levels[0]; if (!(DATA.meta.circular && st.win===0)) return 0;
  const oL = (st.origin!=null && st.li===0) ? st.origin : (L.origin!=null ? L.origin : 0); const mem = membersOf(L, oL); return mem.length ? mem[0] : (L0.origin!=null ? L0.origin : 0); }
function colorOf(rank){ if (st.colorBy==='genes' && st.genes.size){ return densRamp(Math.sqrt(geneDensity(rank) / geneDensMax())); }
  const L = level(); const L0 = win().levels[0]; const n0 = L0.nblocks; const mem = membersOf(L, rank);
  const o0 = hueOrigin(); const pos = m => (DATA.meta.circular && st.win===0) ? (((m - o0) % n0) + n0) % n0 : m;
  const t = mem.reduce((a,m)=>a+pos(m),0)/Math.max(1,mem.length); return ramp(n0<=1?0.5:t/(n0-1)); }

// ---- 描画 ----
function layoutCanvases(){ const W = Math.max($('gridwrap').clientWidth, (LY && LY.fullW) ? LY.fullW : 0); const H = Math.max(RH, (LY?LY.rows.length:1)*RH); sizeCanvas(cv.grid, W, H); sizeCanvas(cv.hdr, W, 40); $('labwrap').style.height = H+'px'; $('treewrap').style.height = H+'px'; }

// ---- 変異の段（アレル行列）: 原子区間の内側（再編成の境界が無い所）で、変異サイトを列、株を行にして同じアレルを同じ色で塗る。
//      行は系統樹順なので、クレードで共有されるアレルが色の塊に見える。列数（葉）が 400 以下になったら塩基（bubble MSA）へ。
const SITES_X0 = 4; const SITES_COLORS = ['#c9ced8', '#2f6fb3', '#e08a1e', '#3a9d5d', '#8a5cd6', '#c9302c', '#17a2b8', '#a0522d'];
function isSites(){ return !!(level() && level().mode === 'sites'); }
function sitesOf(){ const L = level(); return L && L.mode === 'sites' ? L.sites : null; }
function sitesLayout(){ const S = sitesOf(); const W = $('gridwrap').clientWidth - 8; const n = Math.max(1, S.nsites); LY.siteW = Math.max(1, Math.min(14, Math.floor(W / n))); LY.fullW = SITES_X0 + n * LY.siteW + 4; LY.cols = []; LY.vis = []; LY.blockX = new Map();
  if (!S._cells){ const raw = atob(S.cells); const u = new Uint8Array(raw.length); for (let i=0;i<raw.length;i++) u[i] = raw.charCodeAt(i); S._cells = u; S._hidx = new Map(S.haps.map((h,i)=>[h,i])); } }
function drawSitesGrid(){ const S = sitesOf(); if (!S || !LY.siteW) return; const g = cv.grid.getContext('2d'); const sw = LY.siteW, gap = sw >= 4 ? 1 : 0; const H = S.H;
  LY.rows.forEach((r, ri) => { const hi = S._hidx.get(r.hap); if (hi == null) return; const y = ri*RH + 5, h = RH - 10;
    for (let k = 0; k < S.nsites; k++){ const a = S._cells[k*H + hi]; if (a === 255) continue; g.fillStyle = SITES_COLORS[Math.min(a, SITES_COLORS.length-1)]; g.fillRect(SITES_X0 + k*sw, y, sw - gap, h); } });
  if (st.rangeSel){ g.fillStyle = TH.selbg; g.globalAlpha = .5; g.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], cv.grid.clientHeight); g.globalAlpha = 1; } }
function drawSitesHeader(){ const S = sitesOf(); if (!S || !LY.siteW) return; const sw = LY.siteW, gap = sw >= 4 ? 1 : 0;
  // 列見出し: 目盛りと合意座標、アレル数の帯、ドラッグ中の範囲
  const gh = cv.hdr.getContext('2d'); const Hh = cv.hdr.clientHeight; gh.clearRect(0, 0, cv.hdr.clientWidth, Hh); gh.font = '10px "IBM Plex Mono"'; gh.fillStyle = TH.muted; gh.textAlign = 'left';
  let lastX = -1e9; for (let k = 0; k < S.nsites; k++){ const x = SITES_X0 + k*sw; const s_ = S.sites[k]; gh.fillStyle = s_.nall >= 3 ? TH.disp : (s_.nall === 2 ? TH.accent : TH.line); gh.fillRect(x, Hh-6, Math.max(1, sw-gap), 4);
    if (x - lastX >= 90){ gh.fillStyle = TH.muted; gh.fillText(fmtbp(s_.x), x, 12); gh.fillRect(x, 14, 1, 6); lastX = x; } }
  if (st.sel!=null && st.sel < S.nsites){ gh.strokeStyle = TH.sel; gh.lineWidth = 1.5; gh.strokeRect(SITES_X0 + st.sel*sw + .5, .5, Math.max(2, sw) - 1, Hh - 1); }
  if (st.rangeSel){ gh.fillStyle = TH.selbg; gh.globalAlpha = .6; gh.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], Hh); gh.globalAlpha = 1; } }
function siteAt(px){ const S = sitesOf(); if (!S) return null; const k = Math.floor((px - SITES_X0) / LY.siteW); return (k >= 0 && k < S.nsites) ? k : null; }
function siteInfo(k, ri){ const S = sitesOf(); const s_ = S.sites[k]; const H = S.H; const r = ri != null ? LY.rows[ri] : null; const hi = r ? S._hidx.get(r.hap) : null; const a = hi != null ? S._cells[k*H + hi] : null;
  const names = S.sites.length ? '' : ''; const dist = s_.counts.map((n, i) => `<span style="display:inline-block;width:9px;height:9px;background:${SITES_COLORS[Math.min(i, SITES_COLORS.length-1)]};vertical-align:-1px;margin-right:3px"></span>${i===0?'参照側':'アレル '+(i+1)} ${n} 株`).join(' · ');
  return `<p><span class="h">変異サイト ${k+1} / ${S.nsites}</span><br><span class="k">合意座標 ${fmtbp(s_.x)} · 列 ${s_.c0}–${s_.c1}（${s_.ncols} 列、最長 ${s_.bp} bp）· アレル ${s_.nall} 種</span><br>${dist}${r ? `<br><span class="k">${esc(r.hap)}:</span> ${a===255?'この区間を持たない':(a===0?'参照側のアレル':'アレル '+(a+1))}` : ''}</p>`; }
function siteRef(k){ const S = sitesOf(); const L = level(); if (!S || k==null || !S.sites[k]) return null; const s_ = S.sites[k]; const span = Math.max(400, s_.bp * 2);
  return { win: st.win, level: st.li, W: 0, rank: k, name: 'site', ref_contig: (L.refc!=null ? L.refc : 0), x: Math.max(0, s_.x - span/2), span, tbp: s_.bp, nhap: S.ncover, label: '変異サイト ' + (k+1), site: true }; }
function sitesWindow(S, label, parent, pblock, c0, c1){ const pw = WINS[parent]; const Lp = pw.levels[0]; const PB = pblock>=0 ? Lp.blocks[pblock] : null;
  const refc = PB ? (PB.ref_contig!=null ? PB.ref_contig : 0) : (Lp.blocks[0] ? (Lp.blocks[0].ref_contig||0) : 0); const pcolor = PB ? colorOf(pblock) : 'rgb(13,148,136)';
  const haps = Lp.haps.map(h => ({ hap: h.hap, isref: h.isref, contigs: [{ name: '', path: '', strand: '+', start: 0, bp: 0, nsteps: 0, inst: [], minor: [] }] }));
  return { id: -1, parent, pblock, depth: pw.depth + 1, label, atoms: 0, H: haps.length, children: {}, mode: 'sites', anchors: null, ondemand: true, tree: true,
    levels: [{ W: 0, nblocks: 0, blocks: [], haps, mergecap: 0, mode: 'sites', adj: [], events: {}, origin: 0, merges: 0, members: null, nonmono: 0, sites: S, c0, c1, refc, pcolor }] }; }
function openSites(q, label, pblock){ if (!(cb && cb.onSites) || st.drilling) return; const pw = st.win;
  const ncol = (q.c0 != null && q.c1 != null) ? (q.c1 - q.c0 + 1) : null;
  if (ncol != null && ncol <= BASE_MAX_LEAVES && pblock != null && pblock >= 0){ baseMsa(pblock); return; }   // 葉 400 以下 → 塩基へ
  const key = 's:' + (q.c0 != null ? q.c0 + ':' + q.c1 : Math.round(q.x0) + ':' + Math.round(q.x1)); const w = win(); const ch = w.children ? w.children[key] : null; if (ch != null){ enterWindow(ch); return; }
  st.drilling = true; st.busy = `${label} の変異サイトを集めています…`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  cb.onSites(q).then(S => { st.drilling = false; st.busy = null;
    if (!S || S.error || S.tooMany){ drawAll(); $('detailbody').innerHTML = `<p class="k">${esc((S && S.error) || '応答なし')}${S && S.tooMany ? ' 列見出しをドラッグして狭い区間を選ぶと変異サイトの段に降りられます。' : ''}</p>`; return; }
    if (!S.nsites){ drawAll(); $('detailbody').innerHTML = `<p class="k">${esc(label)}（${S.ncols} 列）は全株同一です。変異サイトがありません。</p>`; return; }
    const nw = sitesWindow(S, label, pw, pblock != null ? pblock : -1, S.c0, S.c1); nw.id = WINS.length; nw.plevel = st.li; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; nw.ms = S.ms || 0;
    enterWindow(nw.id); $('detailbody').innerHTML = `<p class="k">変異サイト ${S.nsites} 個（列 ${S.ncols}、${S.ncover} 株が被覆）。セルの色＝アレル（灰＝参照側）。行は系統樹順。列見出しをドラッグで狭い区間へ、葉 ${BASE_MAX_LEAVES} 以下で塩基 MSA へ。</p>`;
  }).catch(e => { st.drilling = false; st.busy = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; }); }
// アレル行列の中のドラッグ: サイトの範囲 → 列の範囲。葉 400 以下なら親ブロックの錨で絞って塩基へ、そうでなければ狭いアレル行列
function sitesRange(xa, xb){ const S = sitesOf(); if (!S) return; const ks = []; S.sites.forEach((s_, k) => { if (s_.x + Math.max(1, s_.bp) > xa && s_.x < xb) ks.push(k); }); if (!ks.length){ st.rangeSel = null; drawAll(); return; }
  const c0 = S.sites[ks[0]].c0, c1 = S.sites[ks[ks.length-1]].c1; const ncol = c1 - c0 + 1; const label = fmtbp(xa) + '–' + fmtbp(xb);
  if (ncol <= BASE_MAX_LEAVES && cb && cb.onBaseMsa){ // 親（ブロックの窓）の錨で各行のトークン範囲を絞って塩基へ
    const w = win(); const pw = WINS[w.parent]; const L0 = pw.levels[0]; const anc = anchorsOf(pw); const ranges = [];
    const xlo = S.sites[ks[0]].x, xhi = S.sites[ks[ks.length-1]].x + Math.max(1, S.sites[ks[ks.length-1]].bp);
    for (const hp of L0.haps) for (const c of hp.contigs) for (const it of c.inst){ if (it[5] >= 4) continue; const B = L0.blocks[it[0]]; if (!B || B.x + B.span < xlo || B.x > xhi) continue;
      let lo = Infinity, hi = -Infinity; const A = anc ? anc.rows.get(c.path) : null; if (A) for (let k=0;k<A.i.length;k++){ const x = anc.x[A.i[k]]; if (x >= xlo - 2000 && x <= xhi + 2000 && A.tok[k] >= it[8] && A.tok[k] < it[9]){ lo = Math.min(lo, A.tok[k]); hi = Math.max(hi, A.tok[k]+1); } }
      if (hi > lo) ranges.push([c.path, lo, hi]); }
    if (ranges.length){ cb.onBaseMsa({ ranges, span: xb - xa, afrac: 0, label: winPath().map((p,i)=>i===0?'全体':p.label).join('›') + '›' + label, depth: w.depth+1, parent: st.win, pblock: -1 }); st.rangeSel = null; drawAll(); $('detailbody').innerHTML = `<p class="k">区間 ${label}（列 ${ncol}）の各行を塩基レベル MSA に渡しました。</p>`; return; } }
  st.rangeSel = null; openSites({ c0, c1 }, label, -1); }
function drawAll(){ _gdMax = null; computeLayout(); if (isSites()) sitesLayout(); layoutCanvases(); drawHeader(); drawGrid(); drawLabels(); drawTree(); drawChips(); drawLegend(); updateButtons(); emitView(); }
// 窓・段（＝色の割り当て）が変わったときだけ、見えているブロックと色を App へ知らせる（グラフのノードをブロック色で塗る）
let _lastViewKey = '';
function emitView(){ if (!(cb && cb.onView)) return; const L = level(); const key = st.win+':'+st.li+':'+LY.vis.join(',')+':'+(st.sync?1:0);
  if (key === _lastViewKey) return; _lastViewKey = key;
  if (isSites()){ const S = L.sites; const f = S.sites[0], l = S.sites[S.nsites-1]; const x0 = f.x, x1 = l.x + Math.max(1, l.bp); const refc = L.refc!=null ? L.refc : 0;
    cb.onView({ win: st.win, level: st.li, W: 0, mode: 'sites', tree: TREE, scope: { contig: refc, start: x0, end: x1 }, scopeKey: st.win + '|sites', sync: st.sync, n0: 0,
      blocks: [{ rank: 0, color: L.pcolor || 'rgb(13,148,136)', ref_contig: refc, x: x0, span: Math.max(1, x1 - x0), label: win().label, members: [] }] }); return; }
  // 範囲 = 見えているブロックの参照区間の合併（最多のコンティグ）。窓・絞り込みが変わったときだけ scopeKey が変わる
  const byC = new Map(); for (const rank of LY.vis){ const B = L.blocks[rank]; const c = (B.ref_contig!=null ? B.ref_contig : 0); const g = byC.get(c) || {n:0, lo:Infinity, hi:-Infinity}; g.n++; g.lo = Math.min(g.lo, B.x); g.hi = Math.max(g.hi, B.x + B.span); byC.set(c, g); }
  let scope = null; for (const [c,g] of byC){ if (!scope || g.n > scope.n){ scope = {contig:c, start:g.lo, end:g.hi, n:g.n}; } }
  const scopeKey = st.win + '|' + (st.filter ? [...st.filter].sort((a,b)=>a-b).join(',') : '');
  cb.onView({ win: st.win, level: st.li, W: L.W, mode: L.mode||'blocks', tree: TREE, scope: scope ? {contig:scope.contig, start:scope.start, end:scope.end} : null, scopeKey, sync: st.sync, n0: win().levels[0].nblocks,
    blocks: LY.vis.map(rank => { const B = L.blocks[rank]; return { rank, color: colorOf(rank), ref_contig: (B.ref_contig!=null ? B.ref_contig : 0), x: B.x, span: B.span, label: '#'+(rank+1), members: membersOf(L, rank) }; }) }); }
function arrowPath(g, x, y, w, h, dir){ const hd = Math.min(6, Math.max(2, w*0.35)); g.beginPath();
  if (dir){ g.moveTo(x,y); g.lineTo(x+w-hd,y); g.lineTo(x+w,y+h/2); g.lineTo(x+w-hd,y+h); g.lineTo(x,y+h); } else { g.moveTo(x+w,y); g.lineTo(x+hd,y); g.lineTo(x,y+h/2); g.lineTo(x+hd,y+h); g.lineTo(x+w,y+h); }
  g.closePath(); }
// Mauve 風の類似度プロファイル: 矢印の中を、位置ごとの「保存度」の高さでブロック色に塗る（残りは白）。
// 尺度が少数派サイトなら位置が分かるので山型、私有サイト／錨でない bp は位置が無いので一定の高さ（値が大きいほど低い）。
// 高さ 1 = この層の典型密度の 2 倍以上で 0、密度 0 で満杯（既存の濃淡と同じ正規化）。返り値: ビンごとの高さ 0..1（null=満杯）
function profileHeights(o, cons, nbins, hapIdx, ext, flip){ const it = o.it; if (!(it.length>12) || it[2]<=0) return null;
  if (st.measure==='minor'){ const vs = cons ? consSites(it) : varSites(it); if (!vs.length) return null;
    const h = new Float32Array(nbins); const cnt = new Float32Array(nbins);
    const scale = (it[11]||vs.length) / vs.length;                                  // 位置は 1/255 に丸めて重複を落としているので、実数に戻す
    const e0 = (cons && ext) ? ext[0] : 0, e1 = (cons && ext) ? Math.max(ext[0]+1, ext[1]) : 255;      // 合意座標モード: この片の合意範囲だけ
    // 通過内の位置（各行の並びモード）は矢印の左端がトークンの小さい側なのは '+' 鎖のとき。'-' 鎖のコンティグは表示で反転しているので左右を入れ替える
    for (let i=0;i<vs.length;i++){ if (cons && (vs[i] < e0 || vs[i] > e1)) continue; let b = Math.min(nbins-1, Math.floor((vs[i]-e0)/(e1-e0)*nbins)); if ((!cons && flip) || (cons && o.dir === 0)) b = nbins-1-b; cnt[b] += scale; }
    const bpPerBin = (cons ? Math.max(1, level().blocks[o.rank].tbp) * (e1-e0)/255 : it[2]) / nbins; const dref = levelDensRef();
    for (let i=0;i<nbins;i++){ const dens = cnt[i]/bpPerBin*1000; h[i] = 1 - Math.min(1, dens/(2*dref)); } return h; }
  const v = measureOf(it); if (v==null) return null; const S = densStats(); const q = pct(S.all, v); const h = new Float32Array(nbins); h.fill(1 - q); return h; }
function shade(col, f){ const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(col); if (!m) return col; return `rgb(${Math.round(+m[1]*f)},${Math.round(+m[2]*f)},${Math.round(+m[3]*f)})`; }
function profileArrow(g, p, o, yy, hh, col, cons, hapIdx){
  const inner = Math.max(1, p.w-2); const nbins = Math.max(2, Math.min(255, Math.floor(inner/2))); const h = profileHeights(o, cons, nbins, hapIdx, p.ext, p.ct && p.ct.c && p.ct.c.strand === '-');
  const hd = Math.min(7, Math.max(3, p.w*0.35));                   // 先端の長さ
  g.save(); arrowPath(g, p.x, yy, p.w, hh, o.dir); g.clip();
  // 軽い矢印: 上辺の細い帯（ブロック色）と先端だけを濃く、その下は保存度のプロファイルを薄く塗る（対応線と競合しない）
  g.fillStyle = TH.panel; g.fillRect(p.x, yy, p.w, hh);
  g.fillStyle = col; g.fillRect(p.x, yy, p.w, 2.5);
  g.globalAlpha = .5; const bw = inner/nbins;
  if (!h){ g.fillRect(p.x, yy+2.5, p.w, hh-2.5); }
  else { for (let i=0;i<nbins;i++){ const hp = Math.max(1, Math.round(h[i]*(hh-3))); g.fillRect(p.x+1+i*bw, yy+hh-hp, bw+0.6, hp); } }
  g.globalAlpha = 1;
  // 先端（向き）は中身が白でも必ず塗る。逆位（左向き）が矢印の形で読めるように、少し濃い色で
  g.fillStyle = shade(col, 0.72); g.beginPath();
  if (o.dir){ g.moveTo(p.x+p.w-hd, yy); g.lineTo(p.x+p.w, yy+hh/2); g.lineTo(p.x+p.w-hd, yy+hh); } else { g.moveTo(p.x+hd, yy); g.lineTo(p.x, yy+hh/2); g.lineTo(p.x+hd, yy+hh); }
  g.closePath(); g.fill();
  g.restore();
  arrowPath(g, p.x, yy, p.w, hh, o.dir); g.strokeStyle = shade(col, 0.72); g.globalAlpha = .95; g.lineWidth = 1.1; g.stroke(); g.globalAlpha = 1; }
function arrow(g, x, y, w, h, dir, color, hatch, dotted){
  const hd = Math.min(6, Math.max(2, w*0.35)); g.beginPath();
  if (dir){ g.moveTo(x,y); g.lineTo(x+w-hd,y); g.lineTo(x+w,y+h/2); g.lineTo(x+w-hd,y+h); g.lineTo(x,y+h); } else { g.moveTo(x+w,y); g.lineTo(x+hd,y); g.lineTo(x,y+h/2); g.lineTo(x+hd,y+h); g.lineTo(x+w,y+h); }
  g.closePath();
  if (dotted){ g.save(); g.setLineDash([3,2]); g.strokeStyle = TH.rep; g.lineWidth=1; g.stroke(); g.restore(); return; }
  g.fillStyle = color; g.fill();
  if (hatch){ g.save(); g.clip(); g.strokeStyle = TH.panel; g.lineWidth=1; g.beginPath(); for (let t=-h;t<w;t+=4){ g.moveTo(x+t,y+h); g.lineTo(x+t+h,y); } g.stroke(); g.restore(); }
  g.strokeStyle = TH.ink; g.globalAlpha=.35; g.lineWidth=.8; g.stroke(); g.globalAlpha=1;
}
// ---- 錨の対応線: 窓の anchors（標本 M 本、各パスでの tok/bp/向き）を復号し、行ごとに表示 x を求める
function b64u(s_, T){ const b = atob(s_); const u8 = new Uint8Array(b.length); for (let i=0;i<b.length;i++) u8[i]=b.charCodeAt(i); return new T(u8.buffer); }
function anchorsOf(w){ if (w._anc) return w._anc; if (!w.anchors) return null; const a = w.anchors; const rows = new Map();
  for (const [path, r] of Object.entries(a.rows)) rows.set(path, { i: b64u(r.i, Uint16Array), tok: b64u(r.tok, Uint32Array), bp: b64u(r.bp, Uint32Array), ori: b64u(r.ori, Uint8Array) });
  const rows2 = new Map(); for (const [path, r] of Object.entries(a.rows2 || {})) rows2.set(path, { i: b64u(r.i, Uint16Array), tok: b64u(r.tok, Uint32Array), bp: b64u(r.bp, Uint32Array), ori: b64u(r.ori, Uint8Array) });
  w._anc = { m: a.m, x: a.x, rows, m2: a.m2 || 0, x2: a.x2 || [], rows2 }; return w._anc; }
// インスタンスの中の合意座標 c(0..1) → 表示 x。逆位（dir=0）のインスタンスは中身を鏡像にする（その株の配列は右から左に進む＝
// 隣の行の同じブロックと線が交差する。Mauve の下段 LCB と同じ読み方）。片（ext）や下段（幅が任意）にも対応
function xInInstance(p, c){ const inv = p.o.dir === 0; const cc = Math.max(0, Math.min(1, inv ? 1 - c : c));
  if (p.col) return p.col.x + cc*p.col.w;
  if (p.ext && p.ext[1] > p.ext[0]){ let e0 = p.ext[0], e1 = p.ext[1]; if (inv){ const t = e0; e0 = 255 - e1; e1 = 255 - t; } return p.x + Math.max(0, Math.min(1, (cc*255 - e0)/(e1 - e0)))*p.w; }
  return p.x + cc*p.w; }
// 行 r の各標本錨の表示 x。cons: 錨の合意座標をブロックの合意範囲に写す（逆位のインスタンスは鏡像）。own: その株の bp 位置（鎖で反転）
function anchorSetXs(r, rows, xarr, m, cons){ const L = level(); const xs = new Float32Array(m).fill(NaN), ys = new Int8Array(m), ors = new Int8Array(m);
  for (const ct of r.contigs){ const A = rows.get(ct.c.path); if (!A) continue; const items = r.items.filter(q=>q.ct===ct && q.o.kind<4 && q.x!=null).sort((u,v)=>u.o.it[8]-v.o.it[8]); if (!items.length) continue;
    const flip = ct.c.strand === '-'; const starts = items.map(q=>q.o.it[8]);
    for (let k=0;k<A.i.length;k++){ const tok = A.tok[k]; let lo = 0, hi = starts.length; while (lo < hi){ const mid = (lo+hi)>>1; if (starts[mid] <= tok) lo = mid+1; else hi = mid; } const p = items[lo-1]; if (!p || tok >= p.o.it[9]) continue;
      const i = A.i[k]; let x;
      if (cons){ const B = L.blocks[p.o.rank]; const c = Math.max(0, Math.min(1, (xarr[i] - B.x) / Math.max(1, B.span))); x = xInInstance(p, c); }
      else { const it = p.o.it; let rel = Math.max(0, Math.min(1, (A.bp[k] - it[6]) / Math.max(1, it[2]))); if (flip) rel = 1 - rel; x = p.x + rel*p.w; }
      if (isNaN(xs[i])){ xs[i] = x; ys[i] = (st.mode==='own') ? 0 : p.slot.lane; ors[i] = flip ? 1 - A.ori[k] : A.ori[k]; } } }
  return { xs, ys, ors }; }
// 線の色は合意座標の位置。環状で全体窓なら原点のブロックから数える（ブロックの色と同じ回転）
function ancHue(anc){ const L0 = win().levels[0]; let k0 = 0; if (!anc.m) return ()=>TH.link || '#8a94a6';
  if (DATA.meta.circular && st.win===0){ const x0 = L0.blocks[hueOrigin()].x; k0 = anc.x.findIndex(v=>v>=x0); if (k0<0) k0 = 0; }
  const m = anc.m; return (k)=>ramp(((k - k0 + m) % m) / Math.max(1, m-1)); }
function drawAnchorLinks(g){ const anc = anchorsOf(win()); if (!st.anc || !anc || !LY) return 0; const cons = st.mode!=='own'; const rows = LY.rows; let n = 0;
  if (!LY._ancXs) LY._ancXs = rows.map(r => anchorSetXs(r, anc.rows, anc.x, anc.m, cons));
  if (st.anc2 && anc.m2 && !LY._anc2Xs) LY._anc2Xs = rows.map(r => anchorSetXs(r, anc.rows2, anc.x2, anc.m2, cons));
  const yB = (i, lane) => i*RH + ((st.mode==='own' || lane===0) ? 16 : 26), yT = (i, lane) => i*RH + ((st.mode==='own' || lane===0) ? 4 : 17);
  const emph = st.sel!=null ? st.sel : st.hoverRank; const hue = ancHue(anc);
  // 第二錨の色: その合意座標に最も近い第一錨の番号の色（同じ色相の帯）
  const hue2 = (k2)=>{ const x = anc.x2[k2]; let lo = 0, hi = anc.x.length; while (lo < hi){ const mid = (lo+hi)>>1; if (anc.x[mid] < x) lo = mid+1; else hi = mid; } return hue(Math.min(anc.m-1, lo)); };
  g.lineWidth = 1;
  if (st.anc2 && LY._anc2Xs){ for (let i=0;i+1<rows.length;i++){ const A = LY._anc2Xs[i], B = LY._anc2Xs[i+1];
    for (let k=0;k<anc.m2;k++){ const xa = A.xs[k], xb = B.xs[k]; if (isNaN(xa) || isNaN(xb)) continue; g.strokeStyle = hue2(k); g.globalAlpha = emph!=null ? .06 : .13; g.beginPath(); g.moveTo(xa, yB(i, A.ys[k])); g.lineTo(xb, yT(i+1, B.ys[k])); g.stroke(); n++; } } }
  for (let i=0;i+1<rows.length;i++){ const A = LY._ancXs[i], B = LY._ancXs[i+1];
    for (let k=0;k<anc.m;k++){ const xa = A.xs[k], xb = B.xs[k]; if (isNaN(xa) || isNaN(xb)) continue;
      g.strokeStyle = hue(k); g.globalAlpha = emph!=null ? .12 : .3; g.beginPath(); g.moveTo(xa, yB(i, A.ys[k])); g.lineTo(xb, yT(i+1, B.ys[k])); g.stroke(); n++; } }
  g.globalAlpha = 1; return n; }
function drawLinks(g){ drawAnchorLinks(g); }
function drawGrid(){ drawGridBase(); if (isSites()) drawSitesGrid(); }
function drawGridBase(){
  const g = cv.grid.getContext('2d'); const W = cv.grid.clientWidth, H = cv.grid.clientHeight; g.clearRect(0,0,W,H);
  if (st.sel!=null && LY.blockX.has(st.sel)){ const c = LY.blockX.get(st.sel); g.fillStyle = TH.selbg; g.fillRect(c.x, 0, c.w, H); }
  LY.rows.forEach((r,ri)=>{ const y = ri*RH;
    if (r.isref){ g.fillStyle = TH.ref; g.globalAlpha=.6; g.fillRect(0,y,W,RH); g.globalAlpha=1; }
    if (st.hover && st.hover.ri===ri){ g.fillStyle = TH.hover; g.fillRect(0,y,W,RH); }
    g.fillStyle = TH.line2; g.fillRect(0,y+RH-1,W,1);
  });
  drawLinks(g);                                   // 連結線はブロックの下に
  LY.rows.forEach((r,ri)=>{ const y = ri*RH;
    const laneOf = p => (st.mode==='own') ? 0 : p.slot.lane; const yTop = l => l===0 ? y+4 : y+17; const hOf = l => l===0 ? 12 : 9;
    for (const p of r.items){ const o = p.o; const lane = laneOf(p); const yy = yTop(lane), hh = hOf(lane);
      const inSeg = p.seg && p.seg.items.length>1 && o.kind<4;
      const cons = st.mode!=='own' && o.kind<4 && o.it.length>20 && p.w>=6;     // 合意座標モード: ブロック内の差異を合意座標で描く
      const inner0 = Math.max(1, p.w-2); const XC = (o.kind<4 && (p.col || p.ext)) ? (c => xInInstance(p, c/255)) : (c => p.x+1+Math.max(0,Math.min(255,c))/255*inner0);
      if (o.kind===5) arrow(g, p.x, yy, p.w, hh, o.dir, null, false, true);
      else if (o.kind===4) arrow(g, p.x, yy, p.w, hh, o.dir, TH.rep, true, false);
      else if (p.w >= 6) profileArrow(g, p, o, yy, hh, colorOf(o.rank), cons, r.hapIdx);     // Mauve 風: 中を保存度の高さで塗る
      else arrow(g, p.x, yy, p.w, hh, o.dir, colorOf(o.rank), false, false);
      if (cons){
        // 合意の錨がこの株に無い区間（欠失・分岐・コンティグ断片の外側）: 白く抜いて中央に細い線
        for (const dl of (o.it[18]||[])){ let x0 = XC(dl[0]), x1 = Math.max(XC(dl[1]), x0+1.5); x0 = Math.max(x0, p.x+1); x1 = Math.min(x1, p.x+p.w-1); if (x1 - x0 < 1) continue;   // この片の範囲の外（別の片が持つ部分）は描かない
          g.fillStyle = TH.panel; g.fillRect(x0, yy, x1-x0, hh); g.fillStyle = TH.ink; g.globalAlpha=.45; g.fillRect(x0, yy+hh/2-.5, x1-x0, 1); g.globalAlpha=1; }
        // コンティグの端で切れている側に点線の縁（向きが逆なら左右も逆）
        if (o.it[17]){ const leftEnd = o.dir ? (o.it[17]&1) : (o.it[17]&2), rightEnd = o.dir ? (o.it[17]&2) : (o.it[17]&1);
          g.save(); g.setLineDash([2,2]); g.strokeStyle = TH.ink; g.lineWidth = 1.5;
          if (leftEnd){ g.beginPath(); g.moveTo(p.x+1.5, yy); g.lineTo(p.x+1.5, yy+hh); g.stroke(); }
          if (rightEnd){ g.beginPath(); g.moveTo(p.x+p.w-1.5, yy); g.lineTo(p.x+p.w-1.5, yy+hh); g.stroke(); } g.restore(); } }
      if (o.kind===3){ g.fillStyle = TH.ink; g.globalAlpha=.7; g.fillRect(p.x, yy+hh+1, p.w, 1.5); g.globalAlpha=1; }
      if (o.kind<4 && o.it.length>16 && o.it[16]===0){ g.save(); g.setLineDash([2,2]); g.strokeStyle = TH.sel; g.lineWidth=1.5; g.beginPath(); g.moveTo(p.x, yy-1.5); g.lineTo(p.x+p.w, yy-1.5); g.stroke(); g.restore(); }
      if (o.kind<4 && o.it.length>14 && o.it[14] && o.it[14].length && p.w>=3){ const y0 = yy + hh*2/3, hv = hh/3; const inner = Math.max(1, p.w - 2);
        for (const gp of o.it[14]){ const useC = cons && gp.length>3; const wI = Math.max(3, Math.min(12, gp[2]*LY.s));
          const flipS = p.ct && p.ct.c && p.ct.c.strand === '-'; const g0 = flipS ? 255-gp[1] : gp[0], g1 = flipS ? 255-gp[0] : gp[1];   // 通過内座標は鎖で左右反転
          const x0 = useC ? Math.max(p.x+1, Math.min(p.x+p.w-1-wI, XC(gp[3]))) : p.x+1+g0/255*inner, x1 = useC ? x0+wI : p.x+1+g1/255*inner; g.save(); g.beginPath(); g.rect(x0, yy, Math.max(2, x1-x0), hh); g.clip();
          g.fillStyle = TH.panel; g.globalAlpha = .75; g.fillRect(x0, yy, Math.max(2,x1-x0), hh); g.globalAlpha = 1; g.strokeStyle = TH.rep; g.lineWidth = 1; g.beginPath(); for (let t=-hh; t<x1-x0+hh; t+=4){ g.moveTo(x0+t, yy+hh); g.lineTo(x0+t+hh, yy); } g.stroke(); g.restore(); } }
      if (o.kind<4 && o.it[4]>1 && p.w>=16){ g.fillStyle=TH.ink; g.font='9.5px "IBM Plex Mono"'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('×'+o.it[4], p.x+p.w/2, yy+hh/2); }
      if (o.kind===5 && p.w>=22){ g.fillStyle=TH.muted; g.font='9px "IBM Plex Mono"'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(o.it[7]+'小', p.x+p.w/2, yy+hh/2); }
      if (o.kind===4 && o.it[4]>1 && p.w>=16){ g.fillStyle=TH.panel; g.font='9.5px "IBM Plex Mono"'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('×'+o.it[4], p.x+p.w/2, yy+hh/2); }
      if (st.sel!=null && o.kind<4 && o.rank===st.sel){ g.strokeStyle = TH.sel; g.lineWidth=2; g.strokeRect(p.x-1, yy-1, p.w+2, hh+2); }
    }
    // 束: 1 ブロックに閉じた断片コンティグ n 本を、その列に 1 つの重ね矢印（後ろにずらした影 ＋ 本体 ＋ 点線の内枠 ＋ ×n）で描く
    for (const b of (r.bundles||[])){ const yy = b.lane===1 ? y+17 : y+4, hh = b.lane===1 ? 9 : 12; const col = colorOf(b.rank);
      g.globalAlpha = .35; arrow(g, b.x+2, yy-2, b.w, hh, b.dir, col, false, false); g.globalAlpha = 1;
      arrow(g, b.x, yy, b.w, hh, b.dir, col, false, false);
      g.save(); g.setLineDash([2,2]); g.strokeStyle = TH.panel; g.lineWidth = 1; g.strokeRect(b.x+1.5, yy+1.5, Math.max(1,b.w-3), hh-3); g.restore();
      if (b.w>=16){ g.fillStyle=TH.ink; g.font='9.5px "IBM Plex Mono"'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('×'+b.n, b.x+b.w/2, yy+hh/2); }
      if (st.sel!=null && b.rank===st.sel){ g.strokeStyle = TH.sel; g.lineWidth=2; g.strokeRect(b.x-1, yy-1, b.w+2, hh+2); } }
  });
  if (st.hover && st.hover.b){ const b = st.hover.b; g.strokeStyle = TH.sel; g.lineWidth=1.5; g.strokeRect(b.x-1.5, st.hover.ri*RH + (b.lane===1?15.5:2.5), b.w+3, b.lane===1?12:15); }
  if (st.busy){ g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(0, 0, W, H); g.fillStyle = TH.sel; g.fillRect(0, 0, W, 26); g.fillStyle = '#fff'; g.font = '600 12px "IBM Plex Sans", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('計算中: ' + st.busy, 10, 13); }
  if (st.hover && st.hover.p){ const p = st.hover.p; const lane = (st.mode==='own') ? 0 : p.slot.lane; g.strokeStyle = TH.sel; g.lineWidth=1.5; g.strokeRect(p.x-1.5, st.hover.ri*RH + (lane===0?2.5:15.5), p.w+3, lane===0?15:12); }
}
function drawHeader(){ if (isSites()){ drawSitesHeader(); return; } drawHeaderBase(); }
function drawHeaderBase(){
  const g = cv.hdr.getContext('2d'); const W = cv.hdr.clientWidth, H = cv.hdr.clientHeight; g.clearRect(0,0,W,H); const L = level();
  g.font='10px "IBM Plex Mono"'; let lastLabelX=-1e9;
  for (const c of LY.cols){
    if (c.type==='block'){ g.fillStyle = colorOf(c.rank); g.fillRect(c.x, H-6, c.w, 4); if (st.sel===c.rank){ g.fillStyle=TH.selbg; g.fillRect(c.x,0,c.w,H); g.strokeStyle=TH.sel; g.strokeRect(c.x+.5,.5,c.w-1,H-1); }
      if (c.w>=30){ g.fillStyle=TH.ink; g.textAlign='center'; g.textBaseline='alphabetic'; g.fillText('#'+(c.rank+1), c.x+c.w/2, 11); } }
    const lab = st.axis==='ref' ? (c.type==='block' ? fmtbp(L.blocks[c.rank].x) : '') : fmtbp(c.cum);
    if (lab && c.x - lastLabelX > 48){ g.fillStyle = TH.muted; g.fillRect(c.x, H-12, 1, 6); g.textAlign='left'; g.textBaseline='alphabetic'; g.fillText(lab, c.x+2, H-14); lastLabelX = c.x; }
  }
  // 遺伝子トラック: 各ブロック列の参照区間に重なる遺伝子を、列の中の相対位置に短い帯で描く（+ 鎖は上、− 鎖は下）
  if (st.genes.size){ for (const c of LY.cols){ if (c.type!=='block') continue; const B = L.blocks[c.rank]; const gs = genesOf(B); if (!gs.length) continue;
      const sc = c.w / Math.max(1, B.span);
      for (const gn of gs){ const x0 = c.x + Math.max(0, (gn.start - B.x)) * sc, x1 = c.x + Math.min(B.span, (gn.end - B.x)) * sc; const w = Math.max(1, x1 - x0);
        g.fillStyle = gn.strand==='-' ? '#d98200' : '#0d9488'; g.globalAlpha = .75; g.fillRect(x0, gn.strand==='-' ? 19 : 14, w, 4); g.globalAlpha = 1; }
      if (c.w >= 60 && gs.length <= 3){ g.fillStyle = TH.muted; g.font = '9px "IBM Plex Sans"'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(gs.map(x=>x.name).join(' '), c.x + c.w/2, 25 + 6); g.font='10px "IBM Plex Mono"'; } } }
  if (st.rangeSel){ g.fillStyle = TH.selbg; g.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], H); g.strokeStyle = TH.sel; g.strokeRect(st.rangeSel[0]+.5, .5, st.rangeSel[1]-st.rangeSel[0]-1, H-1); }
  if (DATA.meta.circular && st.win===0){ g.fillStyle = TH.accent; g.fillRect(3, 0, 2, H); }
}
function drawLabels(){
  const wrap = $('labwrap'); wrap.innerHTML='';
  LY.rows.forEach((r,ri)=>{ const d = document.createElement('div'); d.className = 'lab' + (r.isref?' ref':'') + ((st.hover&&st.hover.ri===ri)?' hov':''); d.style.top = (ri*RH)+'px';
    const nInv = r.items.filter(p=>p.o.kind===3).length, nDisp = r.items.filter(p=>p.o.kind===2).length;
    const bn = (r.bundles||[]).map(b=>`#${b.rank+1} に ${b.n} 本`).join(' ');
    d.innerHTML = `${r.mark?`<span class="hapdot" style="background:${r.mark}"></span>`:''}<span>${esc(r.label)}</span><small>${esc(r.sub)}${(nInv||nDisp)?` · 逆${nInv} 変${nDisp}`:''}${bn?' · 束 '+esc(bn):''}</small>`;
    d.title = r.label + (bn?' / 束: '+bn:'') + '\nクリック: このハプロタイプのパス（リボン）をグラフで選択／解除';
    if (cb && cb.onSelectHap){ d.style.cursor = 'pointer'; d.addEventListener('click', ()=>cb.onSelectHap(r.gkey || r.hap, r.hap)); }
    wrap.appendChild(d); });
}
function drawTree(){
  const svg = $('tree'); const show = st.order==='tree' && !!DATA.tree; root.style.setProperty('--treew', show?'130px':'0px');
  svg.innerHTML=''; if (!show) return;
  const T = DATA.tree; const Wt = 128, H = LY.rows.length*RH; svg.setAttribute('width', Wt); svg.setAttribute('height', H);
  // 葉は名前で行に対応させる（子の窓では L.haps が全体の部分集合で、番号がずれる）。窓に居ないハプロの葉は飛ばし、内部節はある子だけの平均に置く
  const rowOfHap = new Map(LY.rows.map((r,i)=>[r.hap, i])); const hmax = Math.max(1e-9, T.nodes[String(T.root)].h);
  const xOf = h => 8 + (1 - h/hmax) * (Wt-20); const ev = level().events || {};
  const yOf = {}; function place(v){ const nd = T.nodes[String(v)]; if ('leaf' in nd){ const ri = rowOfHap.get(T.haps[nd.leaf]); yOf[v] = (ri==null? null : ri*RH + RH/2); return yOf[v]; } const ys = nd.ch.map(place).filter(y=>y!=null); yOf[v] = ys.length ? ys.reduce((a,b)=>a+b,0)/ys.length : null; return yOf[v]; }
  place(T.root);
  const parts = [];
  function draw(v){ const nd = T.nodes[String(v)]; const x = xOf(nd.h), y = yOf[v]; if (y==null) return;
    if (!('leaf' in nd)){ for (const c of nd.ch){ const cn = T.nodes[String(c)]; const cx = xOf(cn.h), cy = yOf[c]; if (cy==null) continue;
        parts.push(`<path d="M${x},${y} V${cy} H${cx}" fill="none" stroke="${TH.muted}" stroke-width="1" data-node="${c}" class="br"/>`);
        const e = ev[String(c)]; if (e){ const n = (e.gain?e.gain.length:0)+(e.loss?e.loss.length:0); if (n){ const mx = (x+cx)/2; parts.push(`<g data-node="${c}" class="ev"><circle cx="${mx}" cy="${cy}" r="6" fill="${TH.sel}" opacity=".85"/><text x="${mx}" y="${cy+3}" font-size="8" text-anchor="middle" fill="#fff" font-family="IBM Plex Mono">${n}</text></g>`); } }
        draw(c); } }
    else { parts.push(`<line x1="${x}" y1="${y}" x2="${Wt}" y2="${y}" stroke="${TH.line2}" stroke-width="1"/>`); } }
  draw(T.root); svg.innerHTML = parts.join('');
  svg.querySelectorAll('.ev, .br').forEach(el=>{ el.style.cursor='pointer'; el.addEventListener('mousemove', e=>{ if (st.pinned) return; showBranch(+el.getAttribute('data-node')); }); el.addEventListener('click', e=>{ st.pinned = true; showBranch(+el.getAttribute('data-node')); }); });
}
function drawChips(){ const L = level(); let inv=0, disp=0, rep=0, small=0; for (const r of LY.rows) for (const p of r.items){ const k=p.o.kind; if (k===3) inv++; else if (k===2) disp++; else if (k===4) rep++; else if (k===5) small++; }
  $('chips').innerHTML = `<span class="chip">窓 <b>${st.win===0?"全体":esc(win().label)}</b>${(level().mode==='bins')?' · <b>座標分割</b>（再編成なし・等分）':''} · ${level().mode==='bins'?'錨':'原子区間'} ${win().atoms.toLocaleString()} · 深さ ${win().depth}${win().composed?` · <b>継ぎ合わせ</b>`:(win().ondemand?` · <b>逐次計算</b>${win().ms?' '+win().ms+' ms':''}`:'')}</span><span class="chip">${TREE ? '境界の持続度' : (L.mode==='bins'?'ビン幅':'段の幅')} <b>${TREE && !L.W ? '全部' : fmtbp(L.W)}${TREE && L.W ? ' 以上' : ''}</b></span><span class="chip">ブロック <b>${LY.vis.length}</b></span><span class="chip">行 <b>${LY.rows.length}</b></span><span class="chip">逆位 <b>${inv}</b> 変位 <b>${disp}</b> 小群 ${small}</span><span class="chip">${L.members?`最細段の併合 <b>${L.merges||0}</b> 回`:`併合の上限 <b>${L.mergecap||0}</b> 株`}${L.nonmono?` · 内部順序ずれ ${L.nonmono}`:''}</span>${st.filter?`<span class="chip">絞り込み <b>${st.filter.size}</b> / ${win().levels[0].nblocks}</span>`:''}${st.anc && anchorsOf(win())?`<span class="chip">錨の対応線 <b>${anchorsOf(win()).m}</b> 本/行${st.anc2 && anchorsOf(win()).m2?` · 第二錨 <b>${anchorsOf(win()).m2}</b>`:''}</span>`:''}`;
  const ld = $('ladder'); ld.innerHTML=''; win().levels.forEach((lv,i)=>{ const b=document.createElement('button'); b.className='mono'; b.textContent = TREE ? (lv.nblocks+' ブロック') : (fmtbp(lv.W)+' ('+lv.nblocks+')'); if (TREE) b.title = lv.W ? ('境界の持続度 '+fmtbp(lv.W)+' 以上を残した段') : '範囲内の境界を全部残した段'; b.setAttribute('aria-pressed', i===st.li?'true':'false'); b.addEventListener('click',()=>{ st.li=i; st.sel=null; st.origin=null; st.pinned=false; drawAll(); emitSel(); }); ld.appendChild(b); });
  $('origingrp').style.display = (DATA.meta.circular && st.win===0) ? '' : 'none';
  $('origintxt').textContent = DATA.meta.circular ? `#${originRank()+1}${st.origin==null?'（自動）':''}` : '';
  $('scopetxt').textContent = (win().parent>=0 ? `親 ${win().pblock>=0?'#'+(win().pblock+1):'区間'}${win().pW && !TREE?`（段 ${fmtbp(win().pW)}）`:''} の内側 · ` : '') + (TREE ? `${level().nblocks} ブロック` : `段 ${fmtbp(level().W)}`) + (st.filter ? ` · 絞り込み ${st.filterPath.map(e=>e.label).join('›')}（最細 ${st.filter.size} ブロック）` : '');
}
function childKey(rank){ return String(rank); }   // 子窓の鍵（最細段の rank）。粗い段のブロックは絞り込み表示で、子窓は作らない
// 塩基レベルへ渡せるか: 列（葉ノード）が bubble MSA の上限 400 以下と見込めるブロック（典型長 / bp/token）
const BASE_MAX_LEAVES = 400;
function baseCols(rank){ const B = level().blocks[rank]; if (!B) return Infinity; return B.tbp / Math.max(1, DATA.meta.bpt || 1); }
function canBase(rank){ if (TREE){ const B = level().blocks[rank]; return !!B && st.li===0 && !!(cb && cb.onBaseMsa) && (B.c1 - B.c0 + 1) <= BASE_MAX_LEAVES; } return st.li===0 && !!(cb && cb.onBaseMsa) && baseCols(rank) <= BASE_MAX_LEAVES; }
function canDrill(rank){ const L = level(); const B = L.blocks[rank]; if (!B) return false; if (TREE) return (B.atoms==null || B.atoms>=2); return L.mode==='bins' ? (B.atoms==null || B.atoms>=2) : true; }
function updateButtons(){ const w=win();
  const childOK = st.sel!=null && st.li===0 && w.children && w.children[childKey(st.sel)]!=null;
  const drillOK = st.sel!=null && !childOK && st.li===0 && !!(cb && (TREE ? cb.onRange : cb.onDrill)) && canDrill(st.sel);
  const filterOK = st.sel!=null && st.li>0;                      // 粗い段のブロック → 配下の最細ブロックに絞り込む（計算なし）
  $('setorigin').disabled = !(st.sel!=null && DATA.meta.circular && st.win===0);
  if (st.drilling){ $('scopein').disabled = true; $('scopein').textContent = '計算中…'; }
  else {
    $('scopein').disabled = !(childOK || drillOK || filterOK);
    $('scopein').textContent = filterOK ? '選択ブロックの内側へ（絞り込み）→' : childOK ? '選択ブロックの内側へ →' : (st.sel!=null && canBase(st.sel)) ? '塩基レベルへ ↓' : (drillOK ? '選択ブロックの内側へ（逐次計算）→' : '選択ブロックの内側へ →');
  }
  $('scopein').title = filterOK ? 'この段のブロックが含む最細段のブロックだけを表示します（計算なし）。ダブルクリックでも同じ'
    : (st.sel!=null && st.li===0 && !childOK && !drillOK) ? (canDrill(st.sel) ? '逐次計算の経路が無い（backend の Python ワーカーが使えない）' : 'このビンは錨が 1 本以下なので、これ以上分けられません')
    : (drillOK ? '事前計算に無い窓。backend で今計算します（初回はアトラスの読み込みで数秒〜数十秒）。ダブルクリックでも同じ' : '');
  $('base').disabled = !(st.sel!=null && canBase(st.sel));
  $('base').title = st.sel==null ? 'ブロックを選ぶ' : (canBase(st.sel) ? `このブロック（列 ≈${Math.round(baseCols(st.sel))}）の各行を塩基レベル MSA に渡す` : (st.li>0 ? '最細段のブロックで使える' : `列 ≈${Math.round(baseCols(st.sel))} は上限 ${BASE_MAX_LEAVES} を超える。内側へ降りると塩基へ渡せる`));
  $('scopeout').disabled = !(st.filter || w.parent>=0);
  $('scopeout').textContent = st.filter ? '← 絞り込みを解除' : '← 親の窓へ';
  const bc = $('crumbs'); if (bc){ bc.innerHTML = winPath().map((p,i)=>
    `<button class="crumb" data-w="${p.id}" aria-pressed="${p.id===st.win && !st.filter}">${i===0?'全体':esc(p.label)}</button>`).join('<span class="sep">›</span>')
      + st.filterPath.map((e,i)=>`<span class="sep">›</span><button class="crumb" data-f="${i}" aria-pressed="${i===st.filterPath.length-1}" title="段 ${fmtbp(e.W)} のブロック ${esc(e.label)} に絞り込み">${esc(e.label)}<small> ${fmtbp(e.W)}</small></button>`).join('');
    bc.querySelectorAll('.crumb[data-w]').forEach(el=>el.addEventListener('click',()=>{ const v=+el.getAttribute('data-w'); if (v===st.win && !st.filter) return; if (v===st.win){ st.filter=null; st.filterPath=[]; st.sel=null; st.pinned=false; drawAll(); emitSel(); return; } st.win=v; st.li=Math.max(0,WINS[v].levels.length-1); st.sel=null; st.origin=null; st.pinned=false; st.filter=null; st.filterPath=[]; drawAll(); emitSel(); }));
    bc.querySelectorAll('.crumb[data-f]').forEach(el=>el.addEventListener('click',()=>{ const i=+el.getAttribute('data-f'); if (i===st.filterPath.length-1) return; const e = st.filterPath[i]; st.filterPath = st.filterPath.slice(0, i+1); st.filter = new Set([...membersOf(win().levels[e.li], e.rank)].filter(m=>!e.prev || e.prev.has(m))); st.li=0; st.sel=null; st.pinned=false; drawAll(); emitSel(); })); } }
function drawLegend(){ const el=$('legend'); el.innerHTML='';
  const c=document.createElement('canvas'); const g=sizeCanvas(c,120,10); for (let x=0;x<120;x++){ g.fillStyle= st.colorBy==='genes' ? densRamp(x/119) : ramp(x/119); g.fillRect(x,0,1,10); }
  const s1=document.createElement('span'); s1.append(st.colorBy==='genes' ? '遺伝子密度（薄→濃、平方根）' : '合意順序（左→右）'); s1.prepend(c); el.appendChild(s1);
  if (st.genes.size){ const sg=document.createElement('span'); sg.textContent='列見出しの帯＝遺伝子（上＝+鎖 緑、下＝−鎖 橙。位置はブロックの参照区間の中の相対位置）'; el.appendChild(sg); }
  const mname = {minor:'少数派サイト密度（半数未満のハプロだけが持つノードを含む区間 / kb）', priv:'私有サイト密度（この株だけが持つノードを含む区間 / kb）', nonanc:'錨でない bp の割合'}[st.measure];
  const nname = {abs:'層内の百分位で灰色の濃さ（濃い＝多い）', block:'そのブロックの全株の中央値との比。青＝少ない、赤＝多い（±4 倍で飽和）', hap:'その株の全ブロックの中央値との比。青＝少ない、赤＝多い（±4 倍で飽和）'}[st.norm];
  for (const t of ['行はそのハプロタイプのブロック順。合意と揃う主鎖は上段で列に揃え（幅＝典型長）、外れたブロックは下段に、前後の主鎖の間へ順に置く。隙間に入らない長い連なりは右へはみ出し、横スクロールで見る。逆位は左向き＋下線', `矢印の中の塗り＝Mauve 風の類似度プロファイル。高さが保存度（この層の典型密度の 2 倍以上で 0、変異なしで満杯）。尺度が「${mname}」。少数派サイトは位置ごとの山型、他の尺度は一定の高さ。${nname}`,'合意座標モードでは矢印の幅＝ブロックの合意座標。白い切れ目＝この株に合意の錨が無い区間（欠失・分岐・断片の外側。ブロック幅の 1% か 200 bp 以上）、点線の縁＝コンティグの端で切れている、変異の線は合意座標に揃う','灰色の縞＝ブロック内側の長い錨なし区間（20 kb 以上の挿入・反復・非コア。合意座標モードでは直前の錨の位置）。上辺のピンクの破線＝この株だけブロック内部の順序が入れ替わっている（粗い層で無視した少数派の破断点）','段（まとめ方）＝最細段のブロックを、幅が段の幅未満のものから支持の弱い境界で隣とまとめたもの。粗い段のブロックの色は含む最細ブロックの平均位置。粗い段のブロックに入ると配下の最細ブロックに絞り込む（計算なし）。最細段のブロックに入ると新しい窓','錨の対応線＝隣り合う行で同じ錨（80% 以上の株が持つ共有ノード。窓ごとに 800 本を等間隔に標本化）の位置を結ぶ細線。色は合意座標（左→右、環状なら原点から）。揃っていれば縦の帯、交差＝逆位、扇状に開く・閉じる＝挿入・欠失、長い斜線＝転座。第二錨（薄い線）＝コアでないが 2 株以上が持つノードの対応。逆位の矢印（←）は中身も鏡像に描く（その株の配列は右から左へ進む）','ブロック＝範囲（内側へ）・グラフとの接続・行をまたぐ集計の単位。矢印の細い帯と先端が向き、その下の塗りが保存度のプロファイル','系統樹の数字＝その枝で獲得／喪失した隣接の数（節約法）']){ const s=document.createElement('span'); s.textContent=t; el.appendChild(s); } }


function blockRef(rank){ if (isSites()) return siteRef(rank); if (rank==null) return null; const L = level(); const B = L.blocks[rank]; if (!B) return null;
  return {win: st.win, level: st.li, W: L.W, rank, name: B.name, ref_contig: (B.ref_contig!=null ? B.ref_contig : 0), x: B.x, span: B.span, tbp: B.tbp, nhap: B.nhap, label: '#'+(rank+1)}; }
function emitSel(){ if (cb && cb.onSelectBlock) cb.onSelectBlock(blockRef(st.sel)); }
let _lastHover = null;
function emitHover(rank){ if (!(cb && cb.onHoverBlock)) return; if (rank === _lastHover) return; _lastHover = rank; cb.onHoverBlock(blockRef(rank)); }

// ---- 詳細パネル ----
function setDetail(html){ $('detailbody').innerHTML = html; }
function blockInfo(rank, L){ const memtxt = (L.members ? `<p><span class="k">含む最細段のブロック (${membersOf(L,rank).length}):</span> ${membersOf(L,rank).map(m=>'#'+(m+1)).join(', ')}</p>` : '') + (()=>{ if (!st.genes.size) return ''; const gs = genesOf(L.blocks[rank]); return `<p><span class="k">遺伝子 ${gs.length} 個 (${geneDensity(rank).toFixed(1)}/Mb):</span> ${gs.slice(0,12).map(x=>esc(x.name)+(x.strand==='-'?'−':'')).join(', ')}${gs.length>12?' …':''}</p>`; })(); const B = L.blocks[rank]; const P = LY.prof && LY.prof.get(rank); return (`<p><span class="h">ブロック #${rank+1}</span><br>${esc(B.name)}<br><span class="k">錨列 ${B.c0+1}–${B.c1+1} · 原子区間 ${B.ncol} · 張り ${fmtbp(B.span)}<br>典型 ${fmtbp(B.tbp)} · 最長 ${fmtbp(B.bpmax)} · ${B.nhap} hap · 参照 ${fmtbp(B.x)}</span>${P?`<br><span class="k">状態: 主鎖 ${P.main} / 逆位 ${P.inv} / 別位置 ${P.disp} / 持たない ${P.abs}${P.divmed!=null?` · 変異密度の中央値 ${(100*P.divmed).toFixed(1)}%`:''}</span>`:''}</p>`) + memtxt; }
function showItem(h){
  if (!h) return; const L = level(); const r = LY.rows[h.ri]; let html = `<p><span class="h">${esc(r.label)}</span> <span class="k">${esc(r.sub)}</span></p>`;
  if (h.p){ const o = h.p.o, it = o.it; const B = L.blocks[o.rank];
    html += `<p>${o.kind>=4?'近傍の':''}ブロック #${o.rank+1} <span class="k">${esc(B.name)}</span><br>${KINDN[o.kind]} · 向き ${o.dir?'→':'←'}${o.kind<4&&it[4]>1?' · ×'+it[4]:''}${o.kind===4&&it[4]>1?' · 最大再訪 ×'+it[4]:''}${o.kind===5?' · 小ブロック '+it[7]+' 個':''}<br>`+
      `この通過 ${fmtbp(it[2])}${o.kind<4?` (典型長の ${(100*it[2]/Math.max(1,B.tbp)).toFixed(0)}%)`:''} · ${it[3].toLocaleString()} 葉歩 · 位置 ${fmtbp(it[6])} · 歩 ${it[8]}–${it[9]}${o.kind<4&&it.length>11?`<br>少数派サイト ${it[11]} 個 (${(it[11]/Math.max(1,it[2])*1000).toFixed(2)}/kb) · 私有サイト ${it[15]||0} 個 (${((it[15]||0)/Math.max(1,it[2])*1000).toFixed(2)}/kb) · 錨でない bp ${(100*(1-it[10]/Math.max(1,it[2]))).toFixed(1)}%${(()=>{ const cf = cellFill(it, r.hapIdx); return cf ? ' · 塗り: '+cf.txt : ''; })()}${it.length>14&&it[14]&&it[14].length?` · <b>内側の長い錨なし区間 ${it[14].map(g=>fmtbp(g[2])).join(', ')}</b>（縞）`:''}${it.length>16&&it[16]===0?`<br><b>この株はブロック内部で順序が入れ替わっている</b>（この層では少数派の破断点を無視して 1 ブロックにまとめている。上辺の破線。細かい層に降りると分かれる）`:''}`:''}${it[10]?`<br><span class="k">主なノード ${esc(it[10])} (${fmtbp(it[11])})</span>`:''}<br><span class="k">${esc(h.p.ct.c.name)} ${h.p.ct.c.strand} · ${esc(h.p.ct.c.path)}</span></p>`;
    if (o.kind<4 && it.length>20){ const dl = it[18]||[]; const big = dl.length ? dl.reduce((a,b)=>Math.max(a,b[2]),0) : 0;
      html += `<p><span class="k">ブロック内:</span> 覆う範囲 ${(it[20][0]/2.55).toFixed(0)}–${(it[20][1]/2.55).toFixed(0)}% · 合意の錨が無い区間 ${dl.length} 個${dl.length?`（最大 ${fmtbp(big)}）`:''}${it[17]?` · コンティグの${it[17]&1?'先頭':''}${it[17]===3?'と':''}${it[17]&2?'末尾':''}で切れている`:''}</p>`; }
    if (h.p.seg && st.mode!=='own'){ const sg = h.p.seg; const segs = LY.rows[h.ri].segs.filter(x=>x.ct===sg.ct); const i = segs.indexOf(sg);
      const nm = x => x.kind>=4 ? (x.kind===4?'錨なし':'小群') : (x.items.length>1 ? `#${x.items[0].o.rank+1}${x.dir?'→':'←'}…#${x.items[x.items.length-1].o.rank+1}` : `#${x.r0+1}${x.dir?'→':'←'}`);
      html += `<p><span class="k">この行の通過順:</span> ${i>0?esc(nm(segs[i-1]))+' → ':''}<b>${esc(nm(sg))}</b>${i+1<segs.length?' → '+esc(nm(segs[i+1])):''}<br><span class="k">区間 ${sg.items.length} ブロック · ${fmtbp(sg.items.reduce((a,p)=>a+p.o.it[2],0))}</span></p>`; }
    if (o.kind<4) html += breakdown(o.rank);
  } else if (h.b){ const B = L.blocks[h.b.rank]; html += `<p>ブロック #${h.b.rank+1} <span class="k">${esc(B.name)}</span><br>束: このブロックに閉じた断片コンティグ ${h.b.n} 本 · 合計 ${fmtbp(h.b.bp)} (典型長 ${fmtbp(B.tbp)} の ${(100*h.b.bp/Math.max(1,B.tbp)).toFixed(0)}%)<br><span class="k">典型長の ${Math.round(BUNDLE_FRAC*100)}% 以上を載せるコンティグは束に入れず矢印で描く</span></p><ul>` + h.b.contigs.map(c=>`<li>${esc(c.name)} ${fmtbp(c.bp)} ${c.strand} · ${c.nsteps.toLocaleString()} 歩</li>`).join('') + '</ul>' + breakdown(h.b.rank); }
  else if (h.mk){ const it = h.mk.o.it; html += `<p>${KINDN[h.mk.o.kind]}<br>${fmtbp(it[2])} · ${it[3].toLocaleString()} 葉歩${h.mk.o.kind===4&&it[4]>1?' · 最大再訪 ×'+it[4]:''}${h.mk.o.kind===5?' · 小ブロック '+it[7]+' 個':''}<br><span class="k">主なノード ${esc(it[10])} (${fmtbp(it[11])}) · 歩 ${it[8]}–${it[9]} · 近傍ブロック #${h.mk.o.rank+1}</span><br><span class="k">${esc(h.mk.ct.c.name)}</span></p>`; }
  else if (h.m){ html += `<p>小要素 ${fmtbp(h.m.m[1])} <span class="k">主なノード ${esc(h.m.m[2])} (${fmtbp(h.m.m[3])}) · 歩 ${h.m.m[4]}–${h.m.m[5]}</span></p>`; }
  else { html += '<ul>' + r.contigs.map(ct=>`<li>${esc(ct.c.name)} ${fmtbp(ct.c.bp)} ${ct.c.strand} · ${ct.c.nsteps.toLocaleString()} 歩</li>`).join('') + '</ul>'; }
  setDetail(html);
}
function breakdown(rank){ const L = level(); const cat = {main:[], inv:[], disp:[], none:[]};
  for (const h of L.haps){ const insts = []; for (const c of h.contigs) for (const x of c.inst) if (x[0]===rank && x[5]<4) insts.push(x);
    if (!insts.length) cat.none.push(h.hap); else { const ks = new Set(insts.map(x=>x[5])); if (ks.has(0) && ks.size===1) cat.main.push(h.hap + (insts.length>1?` ×${insts.length}`:'')); else if (ks.has(3)) cat.inv.push(h.hap); else cat.disp.push(h.hap); } }
  const li = a => a.length ? a.map(esc).join(', ') : '—';
  return `<p><span class="k">主鎖に持つ (${cat.main.length}):</span> ${li(cat.main)}<br><span class="k">逆位で持つ (${cat.inv.length}):</span> ${li(cat.inv)}<br><span class="k">別の位置に持つ (${cat.disp.length}):</span> ${li(cat.disp)}<br><span class="k">持たない (${cat.none.length}):</span> ${li(cat.none)}</p>`; }
function showBlock(rank){ setDetail(blockInfo(rank, level()) + breakdown(rank)); }
function showBranch(node){ const T = DATA.tree; const L = level(); const ev = (L.events||{})[String(node)]; const nd = T.nodes[String(node)];
  const leaves = []; (function walk(v){ const n = T.nodes[String(v)]; if ('leaf' in n) leaves.push(T.haps[n.leaf]); else n.ch.forEach(walk); })(node);
  let html = `<p><span class="h">枝</span> <span class="k">→ ${leaves.length} ハプロ</span><br><span class="k">${leaves.map(esc).join(', ')}</span></p>`;
  const adjs = idx => idx.map(k=>{ const a=L.adj[k]; return `#${a[0]+1}${a[1]?'頭':'尾'}–#${a[2]+1}${a[3]?'頭':'尾'}`; }).join(', ');
  if (ev){ html += `<p><span class="k">獲得した隣接 (${(ev.gain||[]).length}):</span> ${adjs(ev.gain||[])||'—'}<br><span class="k">失った隣接 (${(ev.loss||[]).length}):</span> ${adjs(ev.loss||[])||'—'}</p><p class="k">同じ枝で対になった獲得/喪失は 1 回の逆位・転座に対応します（節約法。木は葉ノードの Jaccard から UPGMA）。</p>`; }
  else html += '<p class="k">この枝で変わった隣接はありません。</p>';
  setDetail(html);
}

// ---- 操作 ----
function hit(x,y){ const ri = Math.floor(y/RH); if (ri<0||ri>=LY.rows.length) return null; const r = LY.rows[ri]; const ly = y-ri*RH;
  for (const p of r.items){ const lane = (st.mode==='own') ? 0 : p.slot.lane; const y0 = lane===0?3:16, y1 = lane===0?17:27; if (x>=p.x-1 && x<=p.x+p.w+1 && ly>=y0 && ly<=y1) return {ri,p}; }
  for (const b of (r.bundles||[])){ const y0 = b.lane===1?16:3, y1 = b.lane===1?27:17; if (x>=b.x-1 && x<=b.x+b.w+1 && ly>=y0 && ly<=y1) return {ri, b}; }
  return {ri}; }
const grid = cv.grid;
grid.addEventListener('mousemove', e=>{ const rect = grid.getBoundingClientRect(); if (isSites()){ const ri = Math.floor((e.clientY-rect.top)/RH); const k = siteAt(e.clientX-rect.left); const h0 = (ri>=0 && ri<LY.rows.length) ? {ri} : null; if (!st.hover || !h0 || st.hover.ri!==h0.ri){ st.hover = h0; drawGrid(); drawLabels(); } if (k!=null && h0 && !st.pinned) setDetail(siteInfo(k, ri)); emitHover(k); return; } const h = hit(e.clientX-rect.left, e.clientY-rect.top); st.hover = h; st.hoverRank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); drawGrid(); drawLabels(); if (!st.pinned) showItem(h);
  emitHover(h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null)); });
grid.addEventListener('mouseleave', ()=>{ st.hover=null; st.hoverRank=null; drawGrid(); drawLabels(); emitHover(null); });
grid.addEventListener('dblclick', e=>{ const rect = grid.getBoundingClientRect(); const h = hit(e.clientX-rect.left, e.clientY-rect.top);
  const rank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); if (rank==null) return;
  st.sel = rank; st.pinned = true; drawAll(); emitSel(); drillInto(rank); });
grid.addEventListener('click', e=>{ if (e.detail && e.detail > 1) return; const rect = grid.getBoundingClientRect(); const h = hit(e.clientX-rect.left, e.clientY-rect.top);
  if (h && h.p && h.p.o.kind<4){ st.sel = (st.sel===h.p.o.rank) ? null : h.p.o.rank; st.pinned = st.sel!=null; if (st.sel!=null) showItem(h); drawAll(); emitSel(); }
  else if (h && h.b){ st.sel = (st.sel===h.b.rank) ? null : h.b.rank; st.pinned = st.sel!=null; if (st.sel!=null) showItem(h); drawAll(); emitSel(); }   // 束もブロックの選択として扱う
  else if (h && h.m){ st.pinned = true; showItem(h); }
  else { st.pinned = false; st.sel = null; drawAll(); emitSel(); } });
// 列見出しをドラッグして合意座標の任意区間を選び、その区間の窓へ（ブロック境界に縛られない「範囲で降りる」）。
// 各行のトークン範囲は標本錨（第一・第二）のうち区間内にあるものの最小/最大トークンで近似する
function pxToCons(px){ if (isSites()){ const S = sitesOf(); if (!S || !S.nsites) return null; const k = Math.max(0, Math.min(S.nsites-1, Math.floor((px - SITES_X0) / LY.siteW))); return S.sites[k].x + (px - (SITES_X0 + k*LY.siteW)) / LY.siteW * Math.max(1, S.sites[k].bp); } for (const c of LY.cols){ if (c.type==='block' && px>=c.x && px<=c.x+c.w){ const B = level().blocks[c.rank]; return B.x + (px-c.x)/Math.max(1,c.w)*B.span; } } let best=null; for (const c of LY.cols){ if (c.type!=='block') continue; const d = px < c.x ? c.x-px : px-(c.x+c.w); if (best==null || d<best[0]) best=[d,c]; } if (!best) return null; const c=best[1], B=level().blocks[c.rank]; return px < c.x ? B.x : B.x + B.span; }
// 範囲の窓は再計算せず、範囲が重なる最細ブロックの子窓（事前計算か、予算内の逐次計算）を継ぎ合わせて作る。
// 端は子窓のブロック境界に丸める。1 ブロックに収まる範囲は、その子窓に入って絞り込む。子窓が作れない小さなブロック
// （列 ≤ 400）は親のブロックをそのまま 1 ブロックとして継ぐ。継いだ窓の段は最細段の 1 段だけ、系統樹の枝の事象は無し
function drillRangesAt(L, rank){ const out = []; for (const hp of L.haps) for (const c of hp.contigs) for (const x of c.inst){ if (x[5] < 4 && x[0] === rank) out.push([c.path, x[8], x[9]]); } return out; }
function childWindowFor(rank){ const w = win(); const key = String(rank); const ch = w.children ? w.children[key] : null; if (ch!=null) return Promise.resolve(WINS[ch]);
  if (!(cb && cb.onDrill)) return Promise.resolve(null);
  const L0 = w.levels[0]; const B = L0.blocks[rank]; if (!B || B.tbp / Math.max(1, DATA.meta.bpt||1) <= BASE_MAX_LEAVES) return Promise.resolve(null);   // 小さすぎて子窓が無い
  const req = { ranges: drillRangesAt(L0, rank), span: B.span, afrac: (DATA.meta.params && DATA.meta.params.sub_anchor_frac) || 0.5, label: '#'+(rank+1), depth: w.depth+1, parent: st.win, pblock: rank };
  return cb.onDrill(req).then(r=>{ if (!r || r.error || !r.window) return null; const nw = r.window; nw.id = WINS.length; nw.parent = w.id; nw.pblock = rank; nw.plevel = 0; nw.pW = L0.W; nw.children = nw.children || {}; nw.ondemand = true; nw.ms = r.total_ms || r.ms || 0;
    WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; return nw; }); }
function composeRange(xa, xb, srcs){
  // srcs: [{win: 子窓 | null, rank: 親の最細ブロック番号}] を範囲の順に。子窓が null なら親のブロックをそのまま 1 ブロックとして継ぐ
  const w = win(); const L0 = w.levels[0]; const blocks = []; const hapMap = new Map(); const ancX = [], ancRows = new Map(), ancX2 = [], ancRows2 = new Map(); let Wmin = Infinity, nonmono = 0;
  const addAnc = (a, keepIdx, dstX, dstRows, which) => { if (!a) return; const idxMap = new Map(); for (const i of keepIdx){ idxMap.set(i, dstX.length); dstX.push(which === 1 ? a.x[i] : a.x2[i]); }
    const rows = which === 1 ? a.rows : a.rows2; for (const [path, A] of rows){ const ii = [], tt = [], bb = [], oo = [];
      for (let k=0;k<A.i.length;k++){ const ni = idxMap.get(A.i[k]); if (ni==null) continue; ii.push(ni); tt.push(A.tok[k]); bb.push(A.bp[k]); oo.push(A.ori[k]); }
      if (!ii.length) continue; const cur = dstRows.get(path) || { i: [], tok: [], bp: [], ori: [] }; cur.i.push(...ii); cur.tok.push(...tt); cur.bp.push(...bb); cur.ori.push(...oo); dstRows.set(path, cur); } };
  for (const src of srcs){
    const L = src.win ? src.win.levels[0] : L0; const keep = new Map();      // 元の rank → 新しい rank
    L.blocks.forEach((B, r)=>{ if (src.win ? (B.x < xb && B.x + B.span > xa) : r === src.rank){ keep.set(r, blocks.length); blocks.push(Object.assign({}, B)); } });
    if (!keep.size) continue; Wmin = Math.min(Wmin, L.W); nonmono += L.nonmono || 0;
    for (const hp of L.haps){ const dst = hapMap.get(hp.hap) || { hap: hp.hap, isref: hp.isref, contigs: new Map() }; hapMap.set(hp.hap, dst);
      for (const c of hp.contigs){ const inst = c.inst.filter(x => keep.has(x[0])).map(x => { const y = x.slice(); y[0] = keep.get(x[0]); return y; }); if (!inst.length) continue;
        const dc = dst.contigs.get(c.path) || { name: c.name, path: c.path, strand: c.strand, start: c.start, bp: c.bp, nsteps: c.nsteps, inst: [], minor: [] }; dc.inst.push(...inst); dc.minor.push(...(c.minor||[])); dst.contigs.set(c.path, dc); } }
    if (src.win){ const a = anchorsOf(src.win); if (a){ const k1 = []; for (let i=0;i<a.m;i++) if (a.x[i] >= xa && a.x[i] <= xb) k1.push(i); addAnc(a, k1, ancX, ancRows, 1);
        const k2 = []; for (let i=0;i<a.m2;i++) if (a.x2[i] >= xa && a.x2[i] <= xb) k2.push(i); addAnc(a, k2, ancX2, ancRows2, 2); } }
  }
  if (!blocks.length) return null;
  // 行の順は今の窓に合わせる。コンティグのインスタンスはトークン順に
  const order = new Map(L0.haps.map((h,i)=>[h.hap, i]));
  const haps = [...hapMap.values()].sort((u,v)=>(order.get(u.hap)??1e9)-(order.get(v.hap)??1e9)).map(h => ({ hap: h.hap, isref: h.isref, contigs: [...h.contigs.values()].map(c => { c.inst.sort((u,v)=>u[8]-v[8]); c.minor.sort((u,v)=>u[0]-v[0]); return c; }) }));
  const toTyped = (rows) => { const m = new Map(); for (const [path, r] of rows) m.set(path, { i: Uint16Array.from(r.i), tok: Uint32Array.from(r.tok), bp: Uint32Array.from(r.bp), ori: Uint8Array.from(r.ori) }); return m; };
  const nw = { id: -1, parent: st.win, pblock: -1, plevel: st.li, pW: level().W, depth: w.depth + 1, label: fmtbp(xa) + '–' + fmtbp(xb), atoms: blocks.reduce((a,B)=>a+(B.atoms||1),0), H: haps.length,
    levels: [{ W: Wmin === Infinity ? L0.W : Wmin, nblocks: blocks.length, blocks, haps, mergecap: 0, mode: 'blocks', adj: [], events: {}, origin: 0, merges: 0, members: null, nonmono }],
    children: {}, ondemand: true, composed: true, note: '範囲: ' + srcs.length + ' ブロックの子窓を継ぎ合わせ',
    _anc: { m: ancX.length, x: ancX, rows: toTyped(ancRows), m2: ancX2.length, x2: ancX2, rows2: toTyped(ancRows2) } };
  for (const target of [30, 12]){ const g = regroupLevel(nw.levels[0], target); if (g && g.nblocks < nw.levels[nw.levels.length-1].nblocks) nw.levels.push(g); }
  return nw; }
// 最細段 L から、隣接ブロック k|k+1 の境界を「その境界で並びが崩れている株の bp」（支持）が少ない順に併合して target 個の
// ブロックにした段を作る（構築器の coarsen と同じ考え方を、インスタンスの並びから画面側で）。継ぎ合わせた窓の細分化対策。
// 座標分割のビンの境界は支持 0 なので真っ先に併合され、再編成の無い区間は 1 ブロックに戻る
function regroupLevel(L, target){ const nb = L.nblocks; if (nb <= target) return null;
  const sup = new Float64Array(Math.max(0, nb-1));
  for (const hp of L.haps){ for (const c of hp.contigs){ const seq = c.inst.filter(x=>x[5]<4).slice().sort((u,v)=>u[8]-v[8]); const has = new Set(seq.map(x=>x[0]));
      const okAdj = new Set(); for (let i=0;i+1<seq.length;i++){ const a = seq[i], b = seq[i+1]; if (b[0] === a[0]+1 && a[1]===1 && b[1]===1) okAdj.add(a[0]); if (a[0] === b[0]+1 && a[1]===0 && b[1]===0) okAdj.add(b[0]); }
      for (let k=0;k+1<nb;k++){ if (has.has(k) && has.has(k+1) && !okAdj.has(k)) sup[k] += c.bp; } } }
  const segs = []; for (let k=0;k<nb;k++) segs.push([k,k]);
  const spanOf = sg => (L.blocks[sg[1]].x + L.blocks[sg[1]].span) - L.blocks[sg[0]].x;
  while (segs.length > target){ let bi = -1, bs = Infinity; for (let i=0;i+1<segs.length;i++){ const v = sup[segs[i][1]] + 1e-9*(spanOf(segs[i]) + spanOf(segs[i+1])); if (v < bs){ bs = v; bi = i; } }
    if (bi < 0) break; segs[bi] = [segs[bi][0], segs[bi+1][1]]; segs.splice(bi+1, 1); }
  const g_of = new Int32Array(nb); segs.forEach((sg,g)=>{ for (let k=sg[0];k<=sg[1];k++) g_of[k]=g; });
  const blocks = segs.map(sg => { const B0 = L.blocks[sg[0]], B1 = L.blocks[sg[1]]; const mem = []; for (let k=sg[0];k<=sg[1];k++) mem.push(k);
    return { c0: B0.c0, c1: B1.c1, span: (B1.x + B1.span) - B0.x, tbp: mem.reduce((a,k)=>a+L.blocks[k].tbp,0), bpmax: mem.reduce((a,k)=>a+L.blocks[k].bpmax,0), nhap: Math.max(...mem.map(k=>L.blocks[k].nhap)), x: B0.x, atoms: mem.reduce((a,k)=>a+(L.blocks[k].atoms||1),0), ref_contig: B0.ref_contig, name: String(B0.name).split('…')[0] + '…' + String(B1.name).split('…').pop(), ncol: mem.length }; });
  const haps = L.haps.map(hp => ({ hap: hp.hap, isref: hp.isref, contigs: hp.contigs.map(c => { const seq = c.inst.slice().sort((u,v)=>u[8]-v[8]); const inst = [];
      for (const x of seq){ if (x[5] >= 4){ const y = x.slice(); y[0] = g_of[x[0]]; inst.push(y); continue; } const g = g_of[x[0]]; const last = inst.length ? inst[inst.length-1] : null;
        if (last && last[5] < 4 && last[0] === g && (x[1] === last[1])){ // 同じ群の連続 → 1 インスタンスに併合（位置の詳細は捨てる）
          last[2] += x[2]; last[3] += x[3]; last[7] += x[7]; last[9] = Math.max(last[9], x[9]); last[10] += x[10]; last[11] += x[11]; last[13] = Math.max(last[13], x[13]); last[15] += (x[15]||0); last[17] = (last[17]|0) | ((x[17]|0) & 2); continue; }
        inst.push([g, x[1], x[2], x[3], 1, x[5], x[6], x[7], x[8], x[9], x[10], x[11], '', x[13], [], x[15]||0, 1, (x[17]|0), [], '', [0,255]]); }
      return { name: c.name, path: c.path, strand: c.strand, start: c.start, bp: c.bp, nsteps: c.nsteps, inst, minor: c.minor }; }) }));
  return { W: Math.min(...blocks.map(B=>B.span)), nblocks: blocks.length, blocks, haps, mergecap: 0, mode: 'blocks', adj: [], events: {}, origin: 0, merges: nb - blocks.length, members: segs.map(sg => { const m=[]; for (let k=sg[0];k<=sg[1];k++) m.push(k); return m; }), nonmono: 0 }; }
function drillRange(xa, xb){ if (xb <= xa || st.drilling) return; if (isSites()){ sitesRange(xa, xb); return; } const w = win(); const L0 = w.levels[0];
  const ranks = []; L0.blocks.forEach((B, r)=>{ if (B.x < xb && B.x + B.span > xa) ranks.push(r); });
  if (!ranks.length){ $('detailbody').innerHTML = '<p class="k">この区間にブロックがありません。</p>'; st.rangeSel = null; drawHeader(); return; }
  const label = fmtbp(xa) + '–' + fmtbp(xb); const key = 'r:' + Math.round(xa) + ':' + Math.round(xb);
  const ch = w.children ? w.children[key] : null; if (ch!=null){ st.rangeSel = null; drawHeader(); enterWindow(ch); return; }
  // 1 ブロックに収まる範囲: その子窓に入って、範囲に重なるブロックに絞り込む（子窓が無い小さなブロックは塩基へ）
  const cols = (xb - xa) / Math.max(1, DATA.meta.bpt || 1);
  if (ranks.length === 1 && cols <= BASE_MAX_LEAVES && cb && cb.onBaseMsa){ const rk = ranks[0]; const rr_ = drillRangesAt(L0, rk); const anc = anchorsOf(w);
    // 範囲内の錨でトークン範囲を狭める（親ブロック全体でなく範囲だけを塩基へ）
    const ranges = []; if (anc){ for (const [path, s0, e0] of rr_){ const A = anc.rows.get(path); let lo = Infinity, hi = -Infinity; if (A) for (let k=0;k<A.i.length;k++){ const x = anc.x[A.i[k]]; if (x >= xa && x <= xb && A.tok[k] >= s0 && A.tok[k] < e0){ lo = Math.min(lo, A.tok[k]); hi = Math.max(hi, A.tok[k]+1); } } if (hi > lo) ranges.push([path, lo, hi]); } }
    if (ranges.length){ cb.onBaseMsa({ ranges, span: xb-xa, afrac: 0, label: winPath().map((p,i)=>i===0?'全体':p.label).join('›') + '›' + label, depth: w.depth+1, parent: st.win, pblock: -1 }); $('detailbody').innerHTML = `<p class="k">区間 ${label} の各行を塩基レベル MSA に渡しました。</p>`; st.rangeSel = null; drawHeader(); return; } }
  if (TREE){   // 木: 範囲をそのまま問い合わせる（境界は原子区間の単位に丸まる）
    if (!(cb && cb.onRange)) return;
    st.drilling = true; st.busy = `区間 ${label} の窓を木から取り出しています…`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
    cb.onRange(xa, xb, label, w.depth+1, st.win, -1).then(r=>{ st.drilling = false; st.busy = null; st.rangeSel = null;
      if (!r || r.error || !r.window){ drawAll(); $('detailbody').innerHTML = `<p class="k">この区間の窓を作れませんでした: ${esc((r && r.error) || '応答なし')}</p>`; return; }
      const nw = r.window; nw.id = WINS.length; nw.parent = st.win; nw.pblock = -1; nw.plevel = st.li; nw.pW = level().W; nw.children = nw.children || {}; nw.ondemand = true; nw.ms = r.ms || 0;
      WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; enterWindow(nw.id);
    }).catch(e=>{ st.drilling = false; st.busy = null; st.rangeSel = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; });
    return; }
  st.drilling = true; st.busy = `区間 ${label}: 重なる ${ranks.length} ブロックの子窓を集めています…`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  (async ()=>{ const srcs = []; let k = 0;
    for (const r of ranks){ k++; const have = w.children && w.children[String(r)]!=null; if (!have){ st.busy = `区間 ${label}: #${r+1} の子窓を計算中（${k}/${ranks.length}）`; drawGrid(); }
      const cw = await childWindowFor(r); srcs.push({ win: cw, rank: r }); }
    if (ranks.length === 1 && srcs[0].win){ // 1 ブロックに収まる: 子窓に入り、範囲に重なるブロックに絞り込む
      st.drilling = false; st.busy = null; st.rangeSel = null; enterWindow(srcs[0].win.id); const Lc = level(); const f = new Set(); Lc.blocks.forEach((B, r)=>{ if (B.x < xb && B.x + B.span > xa) f.add(r); });
      if (f.size && f.size < Lc.nblocks){ st.filterPath.push({ label, W: Lc.W, li: st.li, rank: -1, prev: null }); st.filter = f; st.li = 0; drawAll(); emitSel(); } return; }
    const nw = composeRange(xa, xb, srcs); st.drilling = false; st.busy = null; st.rangeSel = null;
    if (!nw){ drawAll(); $('detailbody').innerHTML = '<p class="k">この区間の窓を作れませんでした。</p>'; return; }
    nw.id = WINS.length; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; enterWindow(nw.id);
  })().catch(e=>{ st.drilling = false; st.busy = null; st.rangeSel = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; }); }
let _hdrDrag = null, _hdrDragged = false;
cv.hdr.style.cursor = 'crosshair';
cv.hdr.addEventListener('mousedown', e=>{ if (e.button!==0) return; const rect = cv.hdr.getBoundingClientRect(); _hdrDrag = { x0: e.clientX-rect.left, moved:false }; _hdrDragged = false; });
window.addEventListener('mousemove', e=>{ if (!_hdrDrag) return; const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (Math.abs(x-_hdrDrag.x0) > 3) _hdrDrag.moved = true; st.rangeSel = _hdrDrag.moved ? [Math.min(_hdrDrag.x0, x), Math.max(_hdrDrag.x0, x)] : null; drawHeader(); });
window.addEventListener('mouseup', e=>{ if (!_hdrDrag) return; const d = _hdrDrag; _hdrDrag = null; if (!d.moved || !st.rangeSel) { st.rangeSel = null; drawHeader(); return; }
  _hdrDragged = true;                                                   // 直後の click（列の選択）を抑止
  const [pa, pb] = st.rangeSel; const xa = pxToCons(pa), xb = pxToCons(pb); if (xa==null || xb==null){ st.rangeSel = null; drawHeader(); return; }
  drillRange(Math.min(xa,xb), Math.max(xa,xb)); });
cv.hdr.addEventListener('dblclick', e=>{ const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; for (const c of LY.cols){ if (c.type==='block' && x>=c.x && x<=c.x+c.w){ st.sel = c.rank; st.pinned = true; drawAll(); emitSel(); drillInto(c.rank); return; } } });
cv.hdr.addEventListener('click', e=>{ if (_hdrDragged){ _hdrDragged = false; return; } if (e.detail && e.detail > 1) return; const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (isSites()){ const k = siteAt(x); st.sel = (k!=null && st.sel===k) ? null : k; st.pinned = st.sel!=null; if (st.sel!=null) setDetail(siteInfo(st.sel, null)); drawHeader(); drawGrid(); emitSel(); return; } for (const c of LY.cols){ if (c.type==='block' && x>=c.x && x<=c.x+c.w){ st.sel = (st.sel===c.rank)?null:c.rank; st.pinned = st.sel!=null; if (st.sel!=null) showBlock(c.rank); drawAll(); emitSel(); return; } } });
cv.hdr.addEventListener('mousemove', e=>{ const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (isSites()){ const k = siteAt(x); if (k != null && !st.pinned) setDetail(siteInfo(k, null)); emitHover(k); return; } for (const c of LY.cols){ if (x>=c.x && x<=c.x+c.w){ if (!st.pinned) showBlock(c.rank); emitHover(c.rank); if (st.hoverRank!==c.rank){ st.hoverRank=c.rank; drawGrid(); } return; } } emitHover(null); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
cv.hdr.addEventListener('mouseleave', ()=>{ emitHover(null); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
function enterWindow(ch){ st.win = ch; st.li = Math.max(0, WINS[ch].levels.length-1); st.sel=null; st.origin=null; st.pinned=false; st.filter=null; st.filterPath=[]; drawAll(); emitSel(); }
// 親ブロック rank の各インスタンスのトークン範囲（inst[8]=s0, inst[9]=e0、パス名で送る）。事前計算の child_ranges と同じ定義
function drillRanges(rank){ const L = level(); const out = [];
  for (const hp of L.haps) for (const c of hp.contigs) for (const x of c.inst){ if (x[5] < 4 && x[0] === rank) out.push([c.path, x[8], x[9]]); }
  return out; }
// ブロック rank の内側へ。今の段（粗い段でもよい）のインスタンス範囲で窓を作る。事前計算の子窓は最細段の rank にだけある
function drillInto(rank){ if (rank==null || st.drilling) return;
  if (st.li > 0){   // 粗い段のブロック → 配下の最細ブロックに絞り込む（計算なし）。絞り込みは入れ子にできる
    const L = level(); const mem = new Set(membersOf(L, rank)); const f = st.filter ? new Set([...mem].filter(m=>st.filter.has(m))) : mem; if (!f.size) return;
    st.filterPath.push({label:'#'+(rank+1), W:L.W, li:st.li, rank, prev:st.filter}); st.filter = f; st.li = 0; st.sel = null; st.pinned=false; drawAll(); emitSel(); return; }
  const w = win(); const key = childKey(rank); const ch = w.children ? w.children[key] : null;
  if (ch!=null){ enterWindow(ch); return; }
  if (canBase(rank)){ baseMsa(rank); return; }          // 列が少ないブロックは窓を作らず塩基レベルへ（階層の底）
  if (TREE && !canDrill(rank) && cb && cb.onSites){ const B_ = level().blocks[rank]; openSites({ c0: B_.c0, c1: B_.c1 }, '#'+(rank+1), rank); return; }
  if (!(cb && (TREE ? cb.onRange : cb.onDrill)) || !canDrill(rank)){
    if (TREE){ const B_ = level().blocks[rank]; const cols_ = Math.round(baseCols(rank));
      $('detailbody').innerHTML = `<p class="k">#${rank+1} の内側には再編成の境界がありません（原子区間 1 個・${fmtbp(B_.span)}）。ここが木の底です。` +
        (cb && cb.onBaseMsa ? (cols_ <= BASE_MAX_LEAVES ? `塩基レベルへは「塩基へ ↓」で渡せます。` : `塩基レベル MSA は列が約 ${cols_.toLocaleString()} 個で上限 ${BASE_MAX_LEAVES} を超えるため渡せません。列見出しをドラッグして狭い区間を選ぶと渡せます。`) : '') + `</p>`; }
    return; }
  // 木: ブロックの合意座標の範囲を backend に問い合わせて窓を作る。旧: 事前計算に無い窓 → 常駐ワーカーで逐次計算。
  // 返ってきた窓を WINS に足して、親の children に登録する
  const pw = st.win, pli = st.li, L = level(), B = L.blocks[rank];
  const req = { ranges: drillRanges(rank), span: B.span, afrac: (DATA.meta.params && DATA.meta.params.sub_anchor_frac) || 0.5,
                label: '#'+(rank+1), depth: w.depth+1, parent: pw, pblock: rank };
  st.drilling = true; st.busy = TREE ? `#${rank+1} の内側（原子区間 ${B.atoms||'?'} 個）を木から取り出しています…` : `#${rank+1}（段 ${fmtbp(L.W)}）の内側を計算しています…（初回はアトラスの読み込みで数秒〜数十秒）`; updateButtons(); drawGrid();
  $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  (TREE ? cb.onRange(B.x, B.x + B.span, '#'+(rank+1), w.depth+1, pw, rank) : cb.onDrill(req)).then(r=>{ st.drilling = false; st.busy = null;
    if (!r || r.error || !r.window){ $('detailbody').innerHTML = `<p class="k">逐次計算に失敗: ${esc((r && r.error) || '応答なし')}</p>`; updateButtons(); return; }
    const nw = r.window; nw.id = WINS.length; nw.parent = pw; nw.pblock = rank; nw.plevel = pli; nw.pW = L.W; nw.children = nw.children || {}; nw.ondemand = true; nw.ms = r.total_ms || r.ms || 0;
    WINS.push(nw); if (!WINS[pw].children) WINS[pw].children = {}; WINS[pw].children[key] = nw.id;
    if (st.win !== pw || st.li !== pli){ updateButtons(); return; }      // 待つ間に別の窓・段へ移っていたら登録だけして動かない
    enterWindow(nw.id);
  }).catch(e=>{ st.drilling = false; st.busy = null; drawGrid(); $('detailbody').innerHTML = `<p class="k">逐次計算に失敗: ${esc(String(e))}</p>`; updateButtons(); });
}
$('scopein').addEventListener('click', ()=>{ if (st.sel==null || st.drilling) return; drillInto(st.sel); });
function baseMsa(rank){ if (!(cb && cb.onBaseMsa) || rank==null) return; const L = level(); const B = L.blocks[rank];
  cb.onBaseMsa({ ranges: drillRanges(rank), span: B.span, afrac: 0, label: winPath().map((p,i)=>i===0?'全体':p.label).join('›') + '›#' + (rank+1), depth: win().depth+1, parent: st.win, pblock: rank });
  $('detailbody').innerHTML = `<p class="k">#${rank+1} の各行を塩基レベル MSA（MSA パネル）に渡しました。</p>`; }
$('base').addEventListener('click', ()=>{ if (st.sel==null) return; baseMsa(st.sel); });
$('scopeout').addEventListener('click', ()=>{
  if (st.filter){ const e = st.filterPath.pop(); st.filter = e ? e.prev : null; st.li = e ? Math.min(e.li, win().levels.length-1) : 0; st.sel = e ? e.rank : null; st.pinned=false; drawAll(); emitSel(); return; }
  const w = win(); if (w.parent<0) return;
  st.sel = w.pblock; st.win = w.parent; st.li = Math.min(w.plevel!=null ? w.plevel : 0, WINS[w.parent].levels.length-1); st.origin=null; st.pinned=false; drawAll(); emitSel(); });
$('setorigin').addEventListener('click', ()=>{ if (st.sel==null) return; st.origin = st.sel; drawAll(); });
$('autoorigin').addEventListener('click', ()=>{ st.origin = null; drawAll(); });
// 表示設定・説明・チップを隠す（整列を広く見る）。状態はこのブラウザに記憶
function setCompact(on){ root.classList.toggle('compact', !!on); $('compact').setAttribute('aria-pressed', on ? 'true' : 'false'); $('compact').textContent = on ? '設定 ▾' : '設定 ▴'; try { localStorage.setItem('bkmsa_compact', on ? '1' : '0'); } catch (e) {} drawAll(); }
$('compact').addEventListener('click', ()=>setCompact(!root.classList.contains('compact')));
try { if (localStorage.getItem('bkmsa_compact') === '1'){ root.classList.add('compact'); $('compact').setAttribute('aria-pressed', 'true'); $('compact').textContent = '設定 ▾'; } } catch (e) {}
function setMode(m){ st.mode=m; $('m_msa').setAttribute('aria-pressed', m==='msa'); $('m_own').setAttribute('aria-pressed', m==='own'); drawAll(); }
$('m_msa').addEventListener('click', ()=>setMode('msa')); $('m_own').addEventListener('click', ()=>setMode('own'));
function setOrder(o){ st.order=o; $('o_tree').setAttribute('aria-pressed', o==='tree'); $('o_name').setAttribute('aria-pressed', o==='name'); drawAll(); }
$('o_tree').addEventListener('click', ()=>setOrder('tree')); $('o_name').addEventListener('click', ()=>setOrder('name'));
 $('bund').addEventListener('change', e=>{ st.bundle=e.target.checked; drawAll(); });
$('sync').addEventListener('change', e=>{ st.sync=e.target.checked; _lastViewKey=''; emitView(); });
$('anc').addEventListener('change', e=>{ st.anc=e.target.checked; drawGrid(); drawChips(); drawLegend(); });
$('anc2').addEventListener('change', e=>{ st.anc2=e.target.checked; drawGrid(); drawChips(); });
$('onlysel').addEventListener('change', e=>{ st.onlySel=e.target.checked; drawAll(); });
function setMeasure(m){ st.measure=m; for (const [id,k] of [['v_minor','minor'],['v_priv','priv'],['v_nonanc','nonanc']]) $(id).setAttribute('aria-pressed', k===m); drawGrid(); drawLegend(); }
function setNorm(n){ st.norm=n; for (const [id,k] of [['n_abs','abs'],['n_block','block'],['n_hap','hap']]) $(id).setAttribute('aria-pressed', k===n); drawGrid(); drawLegend(); }
$('v_minor').addEventListener('click', ()=>setMeasure('minor')); $('v_priv').addEventListener('click', ()=>setMeasure('priv')); $('v_nonanc').addEventListener('click', ()=>setMeasure('nonanc'));
$('n_abs').addEventListener('click', ()=>setNorm('abs')); $('n_block').addEventListener('click', ()=>setNorm('block')); $('n_hap').addEventListener('click', ()=>setNorm('hap'));
$('copybtn').addEventListener('click', ()=>{ const t = $('detailbody').innerText; if (navigator.clipboard) navigator.clipboard.writeText(t).then(()=>{ $('copybtn').textContent='コピーしました'; setTimeout(()=>$('copybtn').textContent='コピー', 1200); }); });
const onKey = e=>{ if (e.key==='Escape' && root.isConnected){ st.pinned=false; st.sel=null; drawAll(); emitSel(); } };
window.addEventListener('keydown', onKey);
const ro = new ResizeObserver(()=>{ if (root.isConnected && $('gridwrap').clientWidth > 0) drawAll(); }); ro.observe(root);
$('body').addEventListener('scroll', ()=>{ $('hdrwrap').scrollLeft = $('body').scrollLeft; });   // はみ出し分の横スクロールに列見出しを追従
// (sub) (DATA.meta.circular?'環状 · ':'') + `窓 ${WINS.length} 個 · ${DATA.meta.bpt} bp/token · 予算 ${DATA.meta.budget}s · 順序＝` + (DATA.meta.order.kind==='ref'?'参照 ':'典型パス ') + DATA.meta.order.path.split('#')[0];
drawAll();


return {
  selectByRef(contig, bp){ const L = level(); let hit = -1;
    L.blocks.forEach((B, i)=>{ const c = (B.ref_contig!=null ? B.ref_contig : 0); if (c===contig && bp >= B.x && bp <= B.x + B.span) { if (hit<0 || B.span < L.blocks[hit].span) hit = i; } });
    if (hit < 0) return false; st.sel = hit; st.pinned = true; showBlock(hit); drawAll(); emitSel(); return true; },
  destroy(){ window.removeEventListener('keydown', onKey); ro.disconnect(); root.innerHTML = ''; if (cb && cb.onView) cb.onView(null); },
  setHapMarks(m){ st.hapMarks = m || new Map(); drawAll(); },   // グラフで選択中のパス群（鍵→色）。行ラベルに印、「選択行のみ」の対象
  setGenes(g){ st.genes = g || new Map(); _gdMax = null; $('c_genes').disabled = !st.genes.size; if (!st.genes.size && st.colorBy==='genes') st.colorBy='order'; _lastViewKey=''; drawAll(); },   // 参照コンティグ id → 遺伝子（start 昇順）
  _layout(){ return LY; },   // 試験用（配置の検査）
};

}
