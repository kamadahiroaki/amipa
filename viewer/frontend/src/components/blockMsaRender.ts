// @ts-nocheck
import type { BlockDrillRequest, BlockDrillResult } from '../api/client'
// 多解像度 MSA（共線ブロック）の描画。functions/msa_lod/hier_template.html の JS をそのまま移植（vanilla、canvas）。
// React 側は components/BlockMsa.tsx が薄く包む。ここは意図的に型を付けない（試作。本番化時に整える）。
const BODY = '\n<div class="toolbar"><div class="chips" id="bk_chips" style="margin-left:0"></div>\n  <div class="grp"><span class="t">窓</span><nav class="crumbs" id="bk_crumbs" aria-label="階層"></nav></div>\n  <div class="grp"><span class="t">段（まとめ方）</span><span id="bk_ladder"></span></div>\n  <div class="grp"><span class="t">並べ方</span><button id="bk_m_msa" aria-pressed="true">合意座標</button><button id="bk_m_own" aria-pressed="false">各行の並び</button></div>\n  <div class="grp"><span class="t">連結線</span><button id="bk_l_auto" aria-pressed="true">自動</button><button id="bk_l_off" aria-pressed="false">なし</button><button id="bk_l_diff" aria-pressed="false">ずれ</button><button id="bk_l_all" aria-pressed="false">全部</button></div>\n  <div class="grp"><span class="t">目盛り</span><button id="bk_a_cons" aria-pressed="true">ブロック累積 bp</button><button id="bk_a_ref" aria-pressed="false">参照 bp</button></div>\n  <div class="grp"><span class="t">色</span><button id="bk_c_order" aria-pressed="true" title="合意順序で色を付ける（左→右の色相の帯）">順序</button><button id="bk_c_genes" aria-pressed="false" disabled title="ブロックの参照区間に重なる遺伝子の密度（個/Mb）。アノテのある DB だけ">遺伝子密度</button></div>\n  <div class="grp"><span class="t">行順</span><button id="bk_o_tree" aria-pressed="true">系統樹</button><button id="bk_o_name" aria-pressed="false">名前</button></div>\n  <div class="grp" id="bk_origingrp"><span class="t">原点</span><span id="bk_origintxt" class="t"></span><button id="bk_setorigin" disabled>選択ブロックを原点に</button><button id="bk_autoorigin">自動</button></div>\n  <div class="grp"><button id="bk_scopein" disabled>選択ブロックの内側へ →</button><button id="bk_base" disabled title="このブロックの各行のトークン範囲を塩基レベル MSA（MSA パネル）に渡す。列（葉）が 400 以下のブロックで使える">塩基へ ↓</button><button id="bk_scopeout" disabled>← 全体へ</button></div>\n  <div class="grp"><span class="t">変異密度</span><button id="bk_v_minor" aria-pressed="true">少数派サイト</button><button id="bk_v_priv" aria-pressed="false">私有サイト</button><button id="bk_v_nonanc" aria-pressed="false">錨でない bp</button></div>\n  <div class="grp"><span class="t">基準</span><button id="bk_n_abs" aria-pressed="true">絶対（層内百分位）</button><button id="bk_n_block" aria-pressed="false">ブロック相対</button><button id="bk_n_hap" aria-pressed="false">株相対</button></div>\n  <div class="grp"><label><input type="checkbox" id="bk_bund" checked>束ねる</label></div>\n  <div class="grp"><label title="窓や絞り込みを変えると、グラフをその範囲に寄せ、範囲に合う層で表示する"><input type="checkbox" id="bk_sync" checked>グラフ連動</label><label title="パスパネルで選んだ（行ラベルをクリックした）ハプロタイプの行だけを表示"><input type="checkbox" id="bk_onlysel">選択行のみ</label></div>\n</div>\n<div class="legend" id="bk_legend"></div>\n<div class="bkmain">\n  <div id="bk_corner"><span>ハプロタイプ ↓</span><span id="bk_scopetxt"></span></div>\n  <div id="bk_hdrwrap"><canvas id="bk_hdr"></canvas></div>\n  <aside id="bk_detail"><h3>詳細 <button id="bk_copybtn" title="詳細の文字をコピー">コピー</button></h3><div id="bk_detailbody"><p class="k">矢印や列見出しにホバーすると詳細が出ます。クリックで固定。ダブルクリックでそのブロックの内側へ（どの段からでも）。</p></div></aside>\n  <div id="bk_body"><div id="bk_treewrap"><svg id="bk_tree" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="bk_labwrap"></div><div id="bk_gridwrap"><canvas id="bk_grid"></canvas></div></div>\n</div>\n';
const CSS = '.bkmsa{--bg:#f3f6f7;--panel:#fff;--ink:#1b2530;--muted:#64707c;--line:#d3dbe1;--line2:#e7ecf0;--accent:#0d9488;--ref:#fff3e0;--reflab:#7a4b00;\n  --sel:#ff1493;--selbg:rgba(255,20,147,.12);--hover:rgba(13,148,136,.10);--shadow:0 6px 20px rgba(20,30,40,.14);--tick:#8a96a3;--rep:#6b7480;--gap:#eef2f5;--inv:#7c3aed;--disp:#d98200;--abs:#c9d1d8}.bkmsa *{box-sizing:border-box}.bkmsa{background:var(--bg);color:var(--ink);font:13px/1.45 "IBM Plex Sans",system-ui,sans-serif;display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}.bkmsa .chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.bkmsa .chip{font:11.5px "IBM Plex Mono",monospace;color:var(--muted);border:1px solid var(--line2);border-radius:999px;padding:2px 9px;background:var(--bg)}.bkmsa .chip b{color:var(--ink);font-weight:500}.bkmsa .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .grp{display:flex;align-items:center;gap:5px;padding-right:12px;border-right:1px solid var(--line2)}.bkmsa .grp:last-child{border-right:0}.bkmsa .grp .t{font-size:11.5px;color:var(--muted);margin-right:2px}.bkmsa button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:3px 9px;font:12px "IBM Plex Sans",sans-serif;cursor:pointer}.bkmsa button:hover{border-color:var(--accent)}.bkmsa button[disabled]{opacity:.45;cursor:default}.bkmsa button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa button.mono{font-family:"IBM Plex Mono",monospace}.bkmsa button:focus-visible, .bkmsa input:focus-visible{outline:2px solid var(--sel);outline-offset:1px}.bkmsa label{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px}.bkmsa input[type=checkbox]{accent-color:var(--accent)}.bkmsa .crumbs{display:flex;align-items:center;gap:3px;flex-wrap:wrap}.bkmsa .crumbs .sep{color:var(--muted);font-size:12px}.bkmsa .crumb{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:2px 8px;font:12px "IBM Plex Mono",monospace;cursor:pointer}.bkmsa .crumb[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa .legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted);padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .legend canvas{vertical-align:middle}.bkmsa .bkmain{flex:1;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr) 320px;grid-template-rows:40px 1fr;min-height:0;background:var(--panel)}.bkmsa #bk_corner{grid-column:1/3;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10.5px;color:var(--muted);padding:4px 8px;display:flex;align-items:flex-end;justify-content:space-between}.bkmsa #bk_hdrwrap{border-bottom:1px solid var(--line);position:relative;overflow:hidden}.bkmsa #bk_detail{grid-row:1/3;border-left:1px solid var(--line);padding:10px 12px;overflow:auto;font:12px/1.55 "IBM Plex Mono",monospace;user-select:text;-webkit-user-select:text}.bkmsa #bk_detail h3{font:600 12px "IBM Plex Sans",sans-serif;margin:0 0 6px;color:var(--muted);display:flex;justify-content:space-between;align-items:center}.bkmsa #bk_detail .k{color:var(--muted)}.bkmsa #bk_detail .h{color:var(--accent);font-weight:500}.bkmsa #bk_detail p{margin:0 0 8px}.bkmsa #bk_detail ul{margin:0 0 8px;padding-left:16px}.bkmsa #bk_detail li{margin:0}.bkmsa #bk_body{grid-column:1/4;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr);overflow-y:auto;overflow-x:auto;min-height:0}.bkmsa #bk_treewrap{position:sticky;left:0;z-index:2;background:var(--panel)}.bkmsa #bk_labwrap{border-right:1px solid var(--line);position:sticky;left:var(--treew,130px);z-index:2;background:var(--panel)}.bkmsa .lab{position:absolute;left:0;right:0;height:30px;display:flex;align-items:center;padding:0 8px;font:11px "IBM Plex Mono",monospace;white-space:nowrap;overflow:hidden;\n  user-select:text;-webkit-user-select:text;border-bottom:1px solid var(--line2)}.bkmsa .lab.ref{background:var(--ref);color:var(--reflab)}.bkmsa .lab.hov{background:var(--hover)}.bkmsa .lab small{color:var(--muted);margin-left:6px;font-size:10px}.bkmsa #bk_gridwrap{position:relative}.bkmsa canvas{display:block}.bkmsa .sw{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:-1px;margin-right:4px}.bkmsa #bk_copybtn{font-size:11px;padding:1px 7px}.bkmsa .hapdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px;flex:none}\n@media (max-width:900px){.bkmain{grid-template-columns:0 120px 1fr 0}.bkmsa #bk_body{grid-template-columns:0 120px 1fr}.bkmsa #bk_detail{display:none}}\n';
export interface BlockRef { win: number; level: number; W: number; rank: number; name: string; ref_contig: number; x: number; span: number; tbp: number; nhap: number; label: string }
export interface GeneLite { name: string; start: number; end: number; strand?: string }
export interface BlockMsaHandle { selectByRef(contig: number, bp: number): boolean; setHapMarks(m: Map<string, string>): void; setGenes(g: Map<number, GeneLite[]>): void; destroy(): void; _layout?: () => any }
// 現在見えている窓・段のブロック一覧（色つき）。App がグラフのノードをブロック色で塗るのに使う
export interface BlockView { win: number; level: number; W: number; mode: string; blocks: { rank: number; color: string; ref_contig: number; x: number; span: number; label: string; members: number[] }[]; scope: { contig: number; start: number; end: number } | null; scopeKey: string; sync: boolean; n0: number }
export interface BlockMsaCallbacks { onSelectBlock?: (b: BlockRef | null) => void; onHoverBlock?: (b: BlockRef | null) => void; onDrill?: (req: BlockDrillRequest) => Promise<BlockDrillResult>; onView?: (v: BlockView | null) => void; onSelectHap?: (groupKey: string, hap: string) => void; onBaseMsa?: (req: BlockDrillRequest) => void }
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

const st = { drilling:false, links:'auto', hoverRank:null, filter:null, filterPath:[], sync:true, onlySel:false, hapMarks:new Map(), genes:new Map(), colorBy:'order', win: 0, li: 0, mode:'msa', axis:'cons', order:'tree', origin:null, sel:null, hover:null, pinned:false, showMinor:true, bundle:true, showLinks:false, measure:'minor', norm:'abs'};
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
        let px, pw; const colw0 = (st.mode!=='own' && o.kind<4 && slot.lane===0) ? blockX.get(vis[slot.pos]).w / (cnt0.get(o.rank)||1) : null;
        const bpw = colw0!=null ? Math.max(MINW, colw0) : Math.max(MINW, o.it[2]*(st.mode==='own'?sOwn:s));
        if (st.mode==='own'){ px = ownX; pw = bpw; ownX += bpw + 1; }
        else { const col = blockX.get(vis[slot.pos]); pw = Math.min(col.w, bpw);
          if (slot.lane===0){ // 同じブロックが錨なし区間や小群で分断されて複数インスタンスになったら、列の中で左から順に置く（重ねない）
            const used0 = laneUsed.get('u'+slot.pos)||0; px = col.x + used0; pw = Math.max(2, Math.min(bpw, col.x + col.w - px)); laneUsed.set('u'+slot.pos, used0 + pw + 2); }
          else { const used = laneUsed.get(slot.pos)||0; px = col.x + Math.min(used, Math.max(0, col.w - pw)); laneUsed.set(slot.pos, used + pw + 1); } }
        placed.push({o, slot, x:px, w:pw, ct});
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
          let mx = host ? host.x + Math.min(1, Math.max(0, (m[0]-host.o.it[6])/Math.max(1,host.o.it[2])))*host.w : (sorted.length? sorted[0].x : null);
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
  // 隣り合う行の同じブロックを結ぶ線（Mauve 風）。揃っていれば短い縦線、ずれていれば斜線になる。行の高さは変えず、
  // 上段の下端 → 下段の空き → 次の行の上余白 → 次の行の上段の上端、と通す（相手が下段ならその上端まで）
  const links = []; const laneOfP = p => (st.mode==='own') ? 0 : p.slot.lane;
  for (let i=0; i+1<rows.length; i++){
    const A = rows[i].items.filter(p=>p.o.kind<4), B = rows[i+1].items.filter(p=>p.o.kind<4);
    if (!A.length || !B.length) continue;
    const byR = new Map(); for (const p of B){ if (!byR.has(p.o.rank)) byR.set(p.o.rank, []); byR.get(p.o.rank).push(p); }
    for (const p of A){ const cands = byR.get(p.o.rank); if (!cands) continue;
      const cx0 = p.x + p.w/2; let q = cands[0]; for (const c of cands){ if (Math.abs(c.x+c.w/2-cx0) < Math.abs(q.x+q.w/2-cx0)) q = c; }
      const cx1 = q.x + q.w/2; const l0 = laneOfP(p), l1 = laneOfP(q);
      // 「ずれ」= 段が違う・種類（主鎖/変位/逆位）が違う・横の範囲が重ならない。同じ列を再訪で等分しただけの中心のずれは数えない
      const overlap = p.x < q.x + q.w && q.x < p.x + p.w;
      links.push({rank:p.o.rank, x0:cx0, y0:i*RH + (l0===0?16:26), x1:cx1, y1:(i+1)*RH + (l1===0?4:17), diff: !overlap || l0!==l1 || p.o.kind!==q.o.kind}); }
  }
  // ---- 連なり（seg）単位のリボン。端と端を結ぶ（頭は頭、尾は尾）ので、向きが違えば交差（X）＝逆位が形で分かる。
  //      揃った対は列の下の長方形（薄い背景）、ずれた対は台形かねじれ。ブロック単位の線はホバー/選択時の強調にだけ使う
  const ribbons = [];
  const yBot = (i, lane) => i*RH + ((st.mode==='own' || lane===0) ? 16 : 26), yTop = (i, lane) => i*RH + ((st.mode==='own' || lane===0) ? 4 : 17);
  for (let i=0; i+1<rows.length; i++){
    const A = rows[i], B = rows[i+1];
    const byRank = r => { const m = new Map(); for (const p of r.items){ if (p.o.kind>=4) continue; if (!m.has(p.o.rank)) m.set(p.o.rank, []); m.get(p.o.rank).push(p); } return m; };
    const mA = byRank(A), mB = byRank(B); const seen = new Set();
    for (const [src, mDst, srcIsUpper] of [[A, mB, true], [B, mA, false]]){
      for (const sg of (src.segs||[])){ if (sg.kind>=4 || !sg.items.length) continue;
        const ranks = sg.items.map(p=>p.o.rank); const key = ranks.slice().sort((a,b)=>a-b).join(','); if (seen.has(key)) continue;
        const matched = []; for (const rk of ranks){ const c = mDst.get(rk); if (c) matched.push(...c); }
        if (!matched.length) continue; seen.add(key);
        const mx0 = Math.min(...matched.map(p=>p.x)), mx1 = Math.max(...matched.map(p=>p.x+p.w));
        const mdir = (matched.filter(p=>p.o.dir===1).length*2 >= matched.length) ? 1 : 0;
        const mlane = (st.mode==='own') ? 0 : ((matched.filter(p=>p.slot.lane===0).length*2 >= matched.length) ? 0 : 1);
        const slane = (st.mode==='own') ? 0 : sg.lane;
        const U = srcIsUpper ? {x0:sg.x0, x1:sg.x1, dir:sg.dir, lane:slane} : {x0:mx0, x1:mx1, dir:mdir, lane:mlane};
        const Lw = srcIsUpper ? {x0:mx0, x1:mx1, dir:mdir, lane:mlane} : {x0:sg.x0, x1:sg.x1, dir:sg.dir, lane:slane};
        const inv = U.dir !== Lw.dir;
        const diff = inv || U.lane !== Lw.lane || Math.abs(U.x0 - Lw.x0) > 3 || Math.abs(U.x1 - Lw.x1) > 3;
        ribbons.push({ ranks, rank0: ranks[Math.floor(ranks.length/2)], ux0:U.x0, ux1:U.x1, lx0:Lw.x0, lx1:Lw.x1, y0: yBot(i, U.lane), y1: yTop(i+1, Lw.lane), inv, diff, n: ranks.length }); }
    }
  }
  // ---- 粗い段のサブブロック線: 粗いブロックの中での最細段ブロックの位置を、各行のインスタンスの bp 位置から求めて隣の行と結ぶ。
  //      最細段は窓全体で計算済みなので追加計算なし（最細段を見ているときは無い）。交差＝ブロック内部の逆位・並び替え
  const sub = [];
  if (st.li > 0){
    const L0 = win().levels[0]; const fineOf = new Map();
    for (const hp of L0.haps) for (const c of hp.contigs) fineOf.set(hp.hap + '\u0001' + c.path, c.inst.filter(x=>x[5]<4));
    // 最細インスタンスの位置 rel はコンティグの座標（トークン順）で測る。矢印の左端がトークンの小さい側なのは '+' 鎖の
    // コンティグで、'-' 鎖のコンティグは表示で反転しているので左右を入れ替える（矢印の向き dir ではなく鎖で決まる）。
    // 向きも同様に、'-' 鎖のコンティグでは表示上の向き = 1 − 生の向き。★ここを dir で反転していたため、逆鎖の株と順鎖の株の間で
    // 線が全部左右を結び、逆位に見えていた（ecoli GCF_014170615（−鎖）と GCF_016944755（+鎖））
    const posMap = (r, p) => { const out = new Map(); const it = p.o.it; const fl = fineOf.get(r.hap + '\u0001' + p.ct.c.path) || []; const flip = p.ct.c.strand === '-';
      for (const f of fl){ if (f[8] < it[8] || f[9] > it[9]) continue; const rel = Math.max(0, Math.min(1, (f[6] - it[6]) / Math.max(1, it[2])));
        const x = flip ? p.x + p.w - rel*p.w : p.x + rel*p.w; if (!out.has(f[0])) out.set(f[0], {x, dir: flip ? 1 - f[1] : f[1]}); }
      return out; };
    for (let i=0; i+1<rows.length; i++){
      const A = rows[i], B = rows[i+1]; const firstBy = r => { const m = new Map(); for (const p of r.items){ if (p.o.kind<4 && !m.has(p.o.rank)) m.set(p.o.rank, p); } return m; };
      const fA = firstBy(A), fB = firstBy(B);
      for (const [rk, pa] of fA){ const pb = fB.get(rk); if (!pb) continue; const ma = posMap(A, pa), mb = posMap(B, pb); if (ma.size < 2 && mb.size < 2) continue;
        const la = (st.mode==='own') ? 0 : pa.slot.lane, lb = (st.mode==='own') ? 0 : pb.slot.lane;
        const cur = [];
        for (const [rf, a] of ma){ const b = mb.get(rf); if (!b) continue; cur.push({ rf, x0:a.x, y0:yBot(i, la), x1:b.x, y1:yTop(i+1, lb), inv: a.dir !== b.dir, diff:false }); }
        // 「ずれ」＝並びが変わっている線だけ（上の x の順に並べたとき下の x が単調でない線＝交差する線）と逆位。
        // 内容の長さの違いでまとめて左右に寄るだけの平行な線は、順序の情報が無いので既定では描かない
        cur.sort((u,v)=>u.x0-v.x0); const n = cur.length; const best = new Array(n).fill(1), prev = new Array(n).fill(-1); let bi = 0;
        for (let k=0;k<n;k++){ for (let j=0;j<k;j++){ if (cur[j].x1 <= cur[k].x1 && best[j]+1 > best[k]){ best[k] = best[j]+1; prev[k] = j; } } if (best[k] > best[bi]) bi = k; }
        const mono = new Set(); for (let k=bi; k>=0; k=prev[k]) mono.add(k);
        cur.forEach((l,k)=>{ l.diff = l.inv || !mono.has(k); sub.push(l); }); }
    }
  }
  let maxRight = W;
  for (const r of rows){ for (const p of r.items) maxRight = Math.max(maxRight, p.x + p.w); for (const b of (r.bundles||[])) maxRight = Math.max(maxRight, b.x + b.w); }
  const fullW = Math.ceil(maxRight) + 8;            // はみ出した分だけキャンバスを広げる（列の配置は W のまま）
  LY = {rows, vis, cols, blockX, s, W, n, prof, links, ribbons, sub, fullW};
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
function colorOf(rank){ if (st.colorBy==='genes' && st.genes.size){ return densRamp(Math.sqrt(geneDensity(rank) / geneDensMax())); }
  const L = level(); const L0 = win().levels[0]; const n0 = L0.nblocks; const mem = membersOf(L, rank);
  const o0 = L0.origin!=null ? L0.origin : 0; const pos = m => (DATA.meta.circular && st.win===0) ? (((m - o0) % n0) + n0) % n0 : m;
  const t = mem.reduce((a,m)=>a+pos(m),0)/Math.max(1,mem.length); return ramp(n0<=1?0.5:t/(n0-1)); }

// ---- 描画 ----
function layoutCanvases(){ const W = Math.max($('gridwrap').clientWidth, (LY && LY.fullW) ? LY.fullW : 0); const H = Math.max(RH, (LY?LY.rows.length:1)*RH); sizeCanvas(cv.grid, W, H); sizeCanvas(cv.hdr, W, 40); $('labwrap').style.height = H+'px'; $('treewrap').style.height = H+'px'; }
function drawAll(){ _gdMax = null; computeLayout(); layoutCanvases(); drawHeader(); drawGrid(); drawLabels(); drawTree(); drawChips(); drawLegend(); updateButtons(); emitView(); }
// 窓・段（＝色の割り当て）が変わったときだけ、見えているブロックと色を App へ知らせる（グラフのノードをブロック色で塗る）
let _lastViewKey = '';
function emitView(){ if (!(cb && cb.onView)) return; const L = level(); const key = st.win+':'+st.li+':'+LY.vis.join(',')+':'+(st.sync?1:0);
  if (key === _lastViewKey) return; _lastViewKey = key;
  // 範囲 = 見えているブロックの参照区間の合併（最多のコンティグ）。窓・絞り込みが変わったときだけ scopeKey が変わる
  const byC = new Map(); for (const rank of LY.vis){ const B = L.blocks[rank]; const c = (B.ref_contig!=null ? B.ref_contig : 0); const g = byC.get(c) || {n:0, lo:Infinity, hi:-Infinity}; g.n++; g.lo = Math.min(g.lo, B.x); g.hi = Math.max(g.hi, B.x + B.span); byC.set(c, g); }
  let scope = null; for (const [c,g] of byC){ if (!scope || g.n > scope.n){ scope = {contig:c, start:g.lo, end:g.hi, n:g.n}; } }
  const scopeKey = st.win + '|' + (st.filter ? [...st.filter].sort((a,b)=>a-b).join(',') : '');
  cb.onView({ win: st.win, level: st.li, W: L.W, mode: L.mode||'blocks', scope: scope ? {contig:scope.contig, start:scope.start, end:scope.end} : null, scopeKey, sync: st.sync, n0: win().levels[0].nblocks,
    blocks: LY.vis.map(rank => { const B = L.blocks[rank]; return { rank, color: colorOf(rank), ref_contig: (B.ref_contig!=null ? B.ref_contig : 0), x: B.x, span: B.span, label: '#'+(rank+1), members: membersOf(L, rank) }; }) }); }
function arrowPath(g, x, y, w, h, dir){ const hd = Math.min(6, Math.max(2, w*0.35)); g.beginPath();
  if (dir){ g.moveTo(x,y); g.lineTo(x+w-hd,y); g.lineTo(x+w,y+h/2); g.lineTo(x+w-hd,y+h); g.lineTo(x,y+h); } else { g.moveTo(x+w,y); g.lineTo(x+hd,y); g.lineTo(x,y+h/2); g.lineTo(x+hd,y+h); g.lineTo(x+w,y+h); }
  g.closePath(); }
// Mauve 風の類似度プロファイル: 矢印の中を、位置ごとの「保存度」の高さでブロック色に塗る（残りは白）。
// 尺度が少数派サイトなら位置が分かるので山型、私有サイト／錨でない bp は位置が無いので一定の高さ（値が大きいほど低い）。
// 高さ 1 = この層の典型密度の 2 倍以上で 0、密度 0 で満杯（既存の濃淡と同じ正規化）。返り値: ビンごとの高さ 0..1（null=満杯）
function profileHeights(o, cons, nbins, hapIdx){ const it = o.it; if (!(it.length>12) || it[2]<=0) return null;
  if (st.measure==='minor'){ const vs = cons ? consSites(it) : varSites(it); if (!vs.length) return null;
    const h = new Float32Array(nbins); const cnt = new Float32Array(nbins);
    const scale = (it[11]||vs.length) / vs.length;                                  // 位置は 1/255 に丸めて重複を落としているので、実数に戻す
    for (let i=0;i<vs.length;i++){ let b = Math.min(nbins-1, Math.floor(vs[i]/255*nbins)); if (!cons && !o.dir) b = nbins-1-b; cnt[b] += scale; }
    const bpPerBin = (cons ? Math.max(1, level().blocks[o.rank].tbp) : it[2]) / nbins; const dref = levelDensRef();
    for (let i=0;i<nbins;i++){ const dens = cnt[i]/bpPerBin*1000; h[i] = 1 - Math.min(1, dens/(2*dref)); } return h; }
  const v = measureOf(it); if (v==null) return null; const S = densStats(); const q = pct(S.all, v); const h = new Float32Array(nbins); h.fill(1 - q); return h; }
function shade(col, f){ const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(col); if (!m) return col; return `rgb(${Math.round(+m[1]*f)},${Math.round(+m[2]*f)},${Math.round(+m[3]*f)})`; }
function profileArrow(g, p, o, yy, hh, col, cons, hapIdx){
  const inner = Math.max(1, p.w-2); const nbins = Math.max(2, Math.min(255, Math.floor(inner/2))); const h = profileHeights(o, cons, nbins, hapIdx);
  const hd = Math.min(7, Math.max(3, p.w*0.35));                   // 先端の長さ
  g.save(); arrowPath(g, p.x, yy, p.w, hh, o.dir); g.clip();
  if (!h){ g.fillStyle = col; g.fillRect(p.x, yy, p.w, hh); }
  else { g.fillStyle = TH.panel; g.fillRect(p.x, yy, p.w, hh); g.fillStyle = col; const bw = inner/nbins;
    for (let i=0;i<nbins;i++){ const hp = Math.max(1, Math.round(h[i]*(hh-1))); g.fillRect(p.x+1+i*bw, yy+hh-hp, bw+0.6, hp); } }
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
function linksMode(){ return st.links==='auto' ? (st.mode==='own' ? 'all' : 'diff') : st.links; }
function linksShown(){ const m = linksMode(); if (m==='off' || !LY || !LY.ribbons) return []; return m==='all' ? LY.ribbons : LY.ribbons.filter(l=>l.diff); }
function subShown(){ const m = linksMode(); if (m==='off' || !LY || !LY.sub) return []; return m==='all' ? LY.sub : LY.sub.filter(l=>l.diff); }
function colorOfFine(rf){ const L0 = win().levels[0]; const n0 = L0.nblocks; const o0 = L0.origin!=null ? L0.origin : 0; const pos = (DATA.meta.circular && st.win===0) ? (((rf - o0) % n0) + n0) % n0 : rf; return ramp(n0<=1?0.5:pos/(n0-1)); }
function drawLinks(g){
  const emph = st.sel!=null ? st.sel : st.hoverRank;          // 選択/ホバー中のブロック
  // (1) 連なりのリボン。端と端を結ぶ。逆位は交差（X）
  for (const R of linksShown()){ const on = emph!=null && R.ranks.includes(emph); const col = colorOf(R.rank0);
    const a0 = R.inv ? R.lx1 : R.lx0, a1 = R.inv ? R.lx0 : R.lx1;            // 上の左端 → 下の（逆位なら右端）
    g.beginPath(); g.moveTo(R.ux0, R.y0); g.lineTo(R.ux1, R.y0); g.lineTo(a1, R.y1); g.lineTo(a0, R.y1); g.closePath();
    g.fillStyle = col; g.globalAlpha = emph==null ? (R.diff ? (R.inv ? .28 : .20) : .07) : (on ? .40 : .04); g.fill();
    g.strokeStyle = col; g.lineWidth = on ? 1.8 : 1; g.globalAlpha = emph==null ? (R.diff ? .7 : .25) : (on ? .95 : .08);
    g.beginPath(); g.moveTo(R.ux0, R.y0); g.lineTo(a0, R.y1); g.moveTo(R.ux1, R.y0); g.lineTo(a1, R.y1); g.stroke(); }
  // (2) 粗い段のサブブロック線（ブロック内部の並び。交差＝内部の逆位・並び替え）
  for (const S of subShown()){ g.strokeStyle = colorOfFine(S.rf); g.globalAlpha = emph==null ? (S.inv ? .75 : .45) : .15; g.lineWidth = S.inv ? 1.2 : .8;
    g.beginPath(); g.moveTo(S.x0, S.y0); g.lineTo(S.x1, S.y1); g.stroke(); }
  // (3) 強調中のブロックは、ブロック単位の中心線も重ねる（どこへ移ったかを追う）
  if (emph!=null && LY.links){ for (const L of LY.links){ if (L.rank!==emph) continue; g.strokeStyle = colorOf(L.rank); g.globalAlpha = .95; g.lineWidth = 2; g.beginPath(); g.moveTo(L.x0, L.y0); g.lineTo(L.x1, L.y1); g.stroke(); } }
  g.globalAlpha = 1; }
function drawGrid(){
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
      const inner0 = Math.max(1, p.w-2); const XC = c => p.x+1+Math.max(0,Math.min(255,c))/255*inner0;
      if (o.kind===5) arrow(g, p.x, yy, p.w, hh, o.dir, null, false, true);
      else if (o.kind===4) arrow(g, p.x, yy, p.w, hh, o.dir, TH.rep, true, false);
      else if (p.w >= 6) profileArrow(g, p, o, yy, hh, colorOf(o.rank), cons, r.hapIdx);     // Mauve 風: 中を保存度の高さで塗る
      else arrow(g, p.x, yy, p.w, hh, o.dir, colorOf(o.rank), false, false);
      if (cons){
        // 合意の錨がこの株に無い区間（欠失・分岐・コンティグ断片の外側）: 白く抜いて中央に細い線
        for (const dl of (o.it[18]||[])){ const x0 = XC(dl[0]), x1 = Math.max(XC(dl[1]), x0+1.5); g.fillStyle = TH.panel; g.fillRect(x0, yy, x1-x0, hh); g.fillStyle = TH.ink; g.globalAlpha=.45; g.fillRect(x0, yy+hh/2-.5, x1-x0, 1); g.globalAlpha=1; }
        // コンティグの端で切れている側に点線の縁（向きが逆なら左右も逆）
        if (o.it[17]){ const leftEnd = o.dir ? (o.it[17]&1) : (o.it[17]&2), rightEnd = o.dir ? (o.it[17]&2) : (o.it[17]&1);
          g.save(); g.setLineDash([2,2]); g.strokeStyle = TH.ink; g.lineWidth = 1.5;
          if (leftEnd){ g.beginPath(); g.moveTo(p.x+1.5, yy); g.lineTo(p.x+1.5, yy+hh); g.stroke(); }
          if (rightEnd){ g.beginPath(); g.moveTo(p.x+p.w-1.5, yy); g.lineTo(p.x+p.w-1.5, yy+hh); g.stroke(); } g.restore(); } }
      if (o.kind===3){ g.fillStyle = TH.ink; g.globalAlpha=.7; g.fillRect(p.x, yy+hh+1, p.w, 1.5); g.globalAlpha=1; }
      if (o.kind<4 && o.it.length>16 && o.it[16]===0){ g.save(); g.setLineDash([2,2]); g.strokeStyle = TH.sel; g.lineWidth=1.5; g.beginPath(); g.moveTo(p.x, yy-1.5); g.lineTo(p.x+p.w, yy-1.5); g.stroke(); g.restore(); }
      if (o.kind<4 && o.it.length>14 && o.it[14] && o.it[14].length && p.w>=3){ const y0 = yy + hh*2/3, hv = hh/3; const inner = Math.max(1, p.w - 2);
        for (const gp of o.it[14]){ const useC = cons && gp.length>3; const wI = Math.max(3, Math.min(12, gp[2]*LY.s));
          const x0 = useC ? Math.max(p.x+1, Math.min(p.x+p.w-1-wI, XC(gp[3]))) : p.x+1+gp[0]/255*inner, x1 = useC ? x0+wI : p.x+1+gp[1]/255*inner; g.save(); g.beginPath(); g.rect(x0, yy, Math.max(2, x1-x0), hh); g.clip();
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
  if (st.hover && st.hover.p){ const p = st.hover.p; const lane = (st.mode==='own') ? 0 : p.slot.lane; g.strokeStyle = TH.sel; g.lineWidth=1.5; g.strokeRect(p.x-1.5, st.hover.ri*RH + (lane===0?2.5:15.5), p.w+3, lane===0?15:12); }
}
function drawHeader(){
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
  $('chips').innerHTML = `<span class="chip">窓 <b>${st.win===0?"全体":esc(win().label)}</b>${(level().mode==='bins')?' · <b>座標分割</b>（再編成なし・等分）':''} · ${level().mode==='bins'?'錨':'原子区間'} ${win().atoms.toLocaleString()} · 深さ ${win().depth}${win().ondemand?` · <b>逐次計算</b>${win().ms?' '+win().ms+' ms':''}`:''}</span><span class="chip">${L.mode==='bins'?'ビン幅':'段の幅'} <b>${fmtbp(L.W)}</b></span><span class="chip">ブロック <b>${LY.vis.length}</b></span><span class="chip">行 <b>${LY.rows.length}</b></span><span class="chip">逆位 <b>${inv}</b> 変位 <b>${disp}</b> 小群 ${small}</span><span class="chip">${L.members?`最細段の併合 <b>${L.merges||0}</b> 回`:`併合の上限 <b>${L.mergecap||0}</b> 株`}${L.nonmono?` · 内部順序ずれ ${L.nonmono}`:''}</span>${st.filter?`<span class="chip">絞り込み <b>${st.filter.size}</b> / ${win().levels[0].nblocks}</span>`:''}${linksMode()!=='off'?`<span class="chip">連結 <b>${linksShown().length}</b> 連なり${linksShown().filter(r=>r.inv).length?` · 逆位 ${linksShown().filter(r=>r.inv).length}`:''}${st.li>0?` · サブブロック線 ${subShown().length}`:''}${linksMode()==='diff'?'（ずれのみ）':''}</span>`:''}`;
  const ld = $('ladder'); ld.innerHTML=''; win().levels.forEach((lv,i)=>{ const b=document.createElement('button'); b.className='mono'; b.textContent=fmtbp(lv.W)+' ('+lv.nblocks+')'; b.setAttribute('aria-pressed', i===st.li?'true':'false'); b.addEventListener('click',()=>{ st.li=i; st.sel=null; st.origin=null; st.pinned=false; drawAll(); emitSel(); }); ld.appendChild(b); });
  $('origingrp').style.display = (DATA.meta.circular && st.win===0) ? '' : 'none';
  $('origintxt').textContent = DATA.meta.circular ? `#${originRank()+1}${st.origin==null?'（自動）':''}` : '';
  $('scopetxt').textContent = (win().parent>=0 ? `親 #${win().pblock+1}${win().pW?`（段 ${fmtbp(win().pW)}）`:''} の内側 · ` : '') + `段 ${fmtbp(level().W)}` + (st.filter ? ` · 絞り込み ${st.filterPath.map(e=>e.label).join('›')}（最細 ${st.filter.size} ブロック）` : '');
}
function childKey(rank){ return String(rank); }   // 子窓の鍵（最細段の rank）。粗い段のブロックは絞り込み表示で、子窓は作らない
// 塩基レベルへ渡せるか: 列（葉ノード）が bubble MSA の上限 400 以下と見込めるブロック（典型長 / bp/token）
const BASE_MAX_LEAVES = 400;
function baseCols(rank){ const B = level().blocks[rank]; if (!B) return Infinity; return B.tbp / Math.max(1, DATA.meta.bpt || 1); }
function canBase(rank){ return st.li===0 && !!(cb && cb.onBaseMsa) && baseCols(rank) <= BASE_MAX_LEAVES; }
function canDrill(rank){ const L = level(); const B = L.blocks[rank]; if (!B) return false; return L.mode==='bins' ? (B.atoms==null || B.atoms>=2) : true; }
function updateButtons(){ const w=win();
  const childOK = st.sel!=null && st.li===0 && w.children && w.children[childKey(st.sel)]!=null;
  const drillOK = st.sel!=null && !childOK && st.li===0 && !!(cb && cb.onDrill) && canDrill(st.sel);
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
  for (const t of ['行はそのハプロタイプのブロック順。合意と揃う主鎖は上段で列に揃え（幅＝典型長）、外れたブロックは下段に、前後の主鎖の間へ順に置く。隙間に入らない長い連なりは右へはみ出し、横スクロールで見る。逆位は左向き＋下線', `矢印の中の塗り＝Mauve 風の類似度プロファイル。高さが保存度（この層の典型密度の 2 倍以上で 0、変異なしで満杯）。尺度が「${mname}」。少数派サイトは位置ごとの山型、他の尺度は一定の高さ。${nname}`,'合意座標モードでは矢印の幅＝ブロックの合意座標。白い切れ目＝この株に合意の錨が無い区間（欠失・分岐・断片の外側。ブロック幅の 1% か 200 bp 以上）、点線の縁＝コンティグの端で切れている、変異の線は合意座標に揃う','灰色の縞＝ブロック内側の長い錨なし区間（20 kb 以上の挿入・反復・非コア。合意座標モードでは直前の錨の位置）。上辺のピンクの破線＝この株だけブロック内部の順序が入れ替わっている（粗い層で無視した少数派の破断点）','段（まとめ方）＝最細段のブロックを、幅が段の幅未満のものから支持の弱い境界で隣とまとめたもの。粗い段のブロックの色は含む最細ブロックの平均位置。粗い段のブロックに入ると配下の最細ブロックに絞り込む（計算なし）。最細段のブロックに入ると新しい窓','連結＝隣り合う行の同じ連なり（続けて通るブロック列）を、端と端（頭は頭・尾は尾）で結ぶリボン。揃っていれば列の下の薄い長方形、位置が違えば台形、向きが違えば交差（X）＝逆位。粗い段ではブロック内部の最細ブロック同士も細線で結ぶ（交差＝内部の逆位・並び替え）。「自動」は合意座標でずれた対だけ、各行の並びで全部。ホバー/選択中のブロックはブロック単位の線も出る','系統樹の数字＝その枝で獲得／喪失した隣接の数（節約法）']){ const s=document.createElement('span'); s.textContent=t; el.appendChild(s); } }


function blockRef(rank){ if (rank==null) return null; const L = level(); const B = L.blocks[rank]; if (!B) return null;
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
grid.addEventListener('mousemove', e=>{ const rect = grid.getBoundingClientRect(); const h = hit(e.clientX-rect.left, e.clientY-rect.top); st.hover = h; st.hoverRank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); drawGrid(); drawLabels(); if (!st.pinned) showItem(h);
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
cv.hdr.addEventListener('dblclick', e=>{ const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; for (const c of LY.cols){ if (c.type==='block' && x>=c.x && x<=c.x+c.w){ st.sel = c.rank; st.pinned = true; drawAll(); emitSel(); drillInto(c.rank); return; } } });
cv.hdr.addEventListener('click', e=>{ if (e.detail && e.detail > 1) return; const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; for (const c of LY.cols){ if (c.type==='block' && x>=c.x && x<=c.x+c.w){ st.sel = (st.sel===c.rank)?null:c.rank; st.pinned = st.sel!=null; if (st.sel!=null) showBlock(c.rank); drawAll(); emitSel(); return; } } });
cv.hdr.addEventListener('mousemove', e=>{ const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; for (const c of LY.cols){ if (x>=c.x && x<=c.x+c.w){ if (!st.pinned) showBlock(c.rank); emitHover(c.rank); if (st.hoverRank!==c.rank){ st.hoverRank=c.rank; drawGrid(); } return; } } emitHover(null); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
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
  if (!(cb && cb.onDrill) || !canDrill(rank)) return;
  // 事前計算に無い窓 → backend の常駐ワーカーで逐次計算。返ってきた窓を WINS に足して、親の children に登録する
  const pw = st.win, pli = st.li, L = level(), B = L.blocks[rank];
  const req = { ranges: drillRanges(rank), span: B.span, afrac: (DATA.meta.params && DATA.meta.params.sub_anchor_frac) || 0.5,
                label: '#'+(rank+1), depth: w.depth+1, parent: pw, pblock: rank };
  st.drilling = true; updateButtons();
  $('detailbody').innerHTML = `<p class="k">#${rank+1}（段 ${fmtbp(L.W)}）の内側を計算しています…（初回はアトラスの読み込みで数秒〜数十秒）</p>`;
  cb.onDrill(req).then(r=>{ st.drilling = false;
    if (!r || r.error || !r.window){ $('detailbody').innerHTML = `<p class="k">逐次計算に失敗: ${esc((r && r.error) || '応答なし')}</p>`; updateButtons(); return; }
    const nw = r.window; nw.id = WINS.length; nw.parent = pw; nw.pblock = rank; nw.plevel = pli; nw.pW = L.W; nw.children = nw.children || {}; nw.ondemand = true; nw.ms = r.total_ms || r.ms || 0;
    WINS.push(nw); if (!WINS[pw].children) WINS[pw].children = {}; WINS[pw].children[key] = nw.id;
    if (st.win !== pw || st.li !== pli){ updateButtons(); return; }      // 待つ間に別の窓・段へ移っていたら登録だけして動かない
    enterWindow(nw.id);
  }).catch(e=>{ st.drilling = false; $('detailbody').innerHTML = `<p class="k">逐次計算に失敗: ${esc(String(e))}</p>`; updateButtons(); });
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
function setMode(m){ st.mode=m; $('m_msa').setAttribute('aria-pressed', m==='msa'); $('m_own').setAttribute('aria-pressed', m==='own'); drawAll(); }
$('m_msa').addEventListener('click', ()=>setMode('msa')); $('m_own').addEventListener('click', ()=>setMode('own'));
function setLinks(m){ st.links=m; for (const [id,k] of [['l_auto','auto'],['l_off','off'],['l_diff','diff'],['l_all','all']]) $(id).setAttribute('aria-pressed', k===m ? 'true' : 'false'); drawGrid(); drawChips(); }
for (const [id,k] of [['l_auto','auto'],['l_off','off'],['l_diff','diff'],['l_all','all']]) $(id).addEventListener('click', ()=>setLinks(k));
function setAxis(a){ st.axis=a; $('a_cons').setAttribute('aria-pressed', a==='cons'); $('a_ref').setAttribute('aria-pressed', a==='ref'); drawHeader(); }
$('a_cons').addEventListener('click', ()=>setAxis('cons')); $('a_ref').addEventListener('click', ()=>setAxis('ref'));
function setColorBy(c){ st.colorBy = c; _gdMax = null; $('c_order').setAttribute('aria-pressed', c==='order'); $('c_genes').setAttribute('aria-pressed', c==='genes'); _lastViewKey=''; drawAll(); }
$('c_order').addEventListener('click', ()=>setColorBy('order')); $('c_genes').addEventListener('click', ()=>{ if (st.genes.size) setColorBy('genes'); });
function setOrder(o){ st.order=o; $('o_tree').setAttribute('aria-pressed', o==='tree'); $('o_name').setAttribute('aria-pressed', o==='name'); drawAll(); }
$('o_tree').addEventListener('click', ()=>setOrder('tree')); $('o_name').addEventListener('click', ()=>setOrder('name'));
 $('bund').addEventListener('change', e=>{ st.bundle=e.target.checked; drawAll(); });
$('sync').addEventListener('change', e=>{ st.sync=e.target.checked; _lastViewKey=''; emitView(); });
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
