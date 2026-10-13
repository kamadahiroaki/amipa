// @ts-nocheck
import type { BlockDrillRequest, BlockDrillResult } from '../api/client'
// 多解像度 MSA（共線ブロック）の描画。functions/msa_lod/hier_template.html の JS をそのまま移植（vanilla、canvas）。
// React 側は components/BlockMsa.tsx が薄く包む。ここは意図的に型を付けない（試作。本番化時に整える）。
const BODY = '\n<div class="toolbar"><button id="bk_compact" title="表示設定・説明・情報チップを隠す／出す（整列を広く見る）" aria-pressed="false">設定 ▴</button><div class="chips set" id="bk_chips" style="margin-left:0"></div>\n  <div class="grp"><span class="t">窓</span><nav class="crumbs" id="bk_crumbs" aria-label="階層"></nav></div>\n  <div class="grp"><span class="t">段（まとめ方）</span><span id="bk_ladder"></span></div>\n  <div class="grp set"><span class="t">並べ方</span><button id="bk_m_msa" aria-pressed="true">合意座標</button><button id="bk_m_own" aria-pressed="false">各行の並び</button></div>\n  <div class="grp set"><label title="隣り合う行で同じ錨（80% 以上の株が持つ共有ノード）の位置を線で結ぶ。ブロックの単位によらない対応線。交差＝逆位、扇状＝挿入・欠失、長い斜線＝転座"><input type="checkbox" id="bk_anc" checked>錨の対応線</label><label title="コアでないが 2 株以上が持つ一意ノードの対応を薄い線で足す。隣り合う株が共有する島・ファージが見える"><input type="checkbox" id="bk_anc2" checked>第二錨</label></div>\n  <div class="grp set"><span class="t">目盛り</span><button id="bk_a_cons" aria-pressed="true">ブロック累積 bp</button><button id="bk_a_ref" aria-pressed="false" title="木では合意順の累積 bp（全ノードの塩基数。参照に無い島も幅を持つ）">合意 bp</button></div>\n  <div class="grp set"><span class="t">色</span><button id="bk_c_order" aria-pressed="true" title="合意順序で色を付ける（左→右の色相の帯）">順序</button><button id="bk_c_genes" aria-pressed="false" disabled title="ブロックの参照区間に重なる遺伝子の密度（個/Mb）。アノテのある DB だけ">遺伝子密度</button></div>\n  <div class="grp set"><span class="t">行順</span><button id="bk_o_tree" aria-pressed="true">系統樹</button><button id="bk_o_name" aria-pressed="false">名前</button></div>\n  <div class="grp set" id="bk_origingrp"><span class="t">原点</span><span id="bk_origintxt" class="t"></span><button id="bk_setorigin" disabled>選択ブロックを原点に</button><button id="bk_autoorigin">自動</button></div>\n  <div class="grp" id="bk_basegrp" style="display:none"><span class="t">比較の基準</span><button id="bk_cmp_ref" aria-pressed="true" title="参照パス（無ければ先頭の行）の塩基。列見出しの下段に出る">参照</button><button id="bk_cmp_major" aria-pressed="false" title="列ごとの最頻の塩基（多数派）。列見出しの下段に出る">多数派</button><label title="基準と同じ塩基を · で省き、違う塩基だけ色で出す"><input type="checkbox" id="bk_bdiff" checked>一致を省く</label><span class="t">列見出しをドラッグ＝列の範囲に絞る</span></div>\n  <div class="grp"><button id="bk_scopein" disabled>選択ブロックの内側へ →</button><button id="bk_base" disabled title="このブロックの各行のトークン範囲を塩基レベル MSA（MSA パネル）に渡す。列（葉）が 400 以下のブロックで使える">塩基へ ↓</button><button id="bk_graphrange" disabled title="グラフで今見えている範囲（ミニマップ底の線＝最も多くのノードが属する連なり）を、その広さに合う段（ブロック／アレル行列／塩基）で開く。離れた範囲が複数あるときは主な 1 本。他はミニマップ底の線をクリック">グラフの範囲を開く</button><button id="bk_scopeout" disabled>← 全体へ</button></div>\n  <div class="grp set"><span class="t">変異密度</span><button id="bk_v_minor" aria-pressed="true">少数派サイト</button><button id="bk_v_priv" aria-pressed="false">私有サイト</button><button id="bk_v_nonanc" aria-pressed="false">錨でない bp</button></div>\n  <div class="grp set"><span class="t">基準</span><button id="bk_n_abs" aria-pressed="true">絶対（層内百分位）</button><button id="bk_n_block" aria-pressed="false">ブロック相対</button><button id="bk_n_hap" aria-pressed="false">株相対</button></div>\n  <div class="grp set"><label><input type="checkbox" id="bk_bund" checked>束ねる</label></div>\n  <div class="grp set"><span class="t">行の高さ</span><button id="bk_rh_auto" aria-pressed="true" title="ブロックは 30 px、アレル行列・塩基は全行が入る高さ（12〜18 px）">自動</button><button id="bk_rh_std" aria-pressed="false" title="どの段でも 30 px">標準</button><button id="bk_rh_dense" aria-pressed="false" title="アレル行列・塩基を 14 px に">密</button></div>\n  <div class="grp set"><label title="窓や絞り込みを変えると、グラフをその範囲に寄せ、範囲に合う層で表示する"><input type="checkbox" id="bk_sync" checked>グラフ連動</label><label title="グラフに、この窓（ブロック／アレル行列／塩基の範囲）に属するノードだけを描く。レイアウトで近くてもシンテニーで離れたノードが消え、範囲が数 kb なら折りたたまれた中央でも読める（2026-10-07 の測定: 500 列で隣の 98%、1,000 列で 90% がゲノムの隣）。範囲の外へ繋がる辺は橙の切れ端で示す。全体の窓では何も消えない"><input type="checkbox" id="bk_gfilter">グラフをこの範囲に絞る</label><label title="各行の底に、その株の GFF の遺伝子を置く（緑 + 鎖、橙 − 鎖。鎖は合意の向きに対して＝逆向きに置かれた区間では GFF の鎖を反転するので、同じ遺伝子は行の間で同じ色。灰 擬似遺伝子・RNA・反復）。遺伝子が画素より多い所は灰の帯（密度）。遺伝子サイドカー .genes のある DB だけ"><input type="checkbox" id="bk_lane" checked>遺伝子レーン</label><label title="各行の並びモードで、錨の無い長い配列（島・私有配列。斜線）が 40 px を超えるときは 12 px に畳んで長さを書く。島の多い領域で原子の矢印が押しやられない。畳まないときは実寸"><input type="checkbox" id="bk_foldgap" checked>長い隙間を畳む</label><label title="行の上の三角＝破断点と遺伝子の関係（赤 分断、桃 他株の島の挿入点が遺伝子内、橙 遺伝子の端が接合区間内、灰 遺伝子なし）。ホバーで接合区間と遺伝子"><input type="checkbox" id="bk_jmark" checked>破断点×遺伝子</label><button id="bk_junclist" disabled title="再編成の接合（破断点）の一覧。株・種類・区間・遺伝子との関係。行をクリックで接合カード、TSV で書き出し">接合一覧</button><label title="パスパネルで選んだ（行ラベルをクリックした）ハプロタイプの行だけを表示"><input type="checkbox" id="bk_onlysel">選択行のみ</label></div>\n</div>\n<div id="bk_tip"></div>\n<div id="bk_mini" title="全体の合意シンテニー（根の最細段のブロック）。明るい所＝今の窓の範囲。クリックでそのブロックの窓、ドラッグで範囲の窓"><canvas id="bk_minic"></canvas></div>\n<div class="legend" id="bk_legend"></div>\n<div class="bkmain">\n  <div id="bk_corner"><span title="列見出し: クリック=ブロック選択 · ダブルクリック=内側へ · ドラッグ=任意の区間の窓（範囲で降りる）">ハプロタイプ ↓ · 列見出しをドラッグ＝範囲の窓</span><span id="bk_scopetxt"></span></div>\n  <div id="bk_hdrwrap"><canvas id="bk_hdr"></canvas></div>\n  <aside id="bk_detail"><h3>詳細 <span class="dbtns"><button id="bk_wide" title="詳細を画面の中央に大きく出す／右の欄に戻す（接合一覧・接合カードは自動で大きく出る）">⤢ 大きく</button><button id="bk_copybtn" title="詳細の文字をコピー">コピー</button><button id="bk_close" title="固定を解除して閉じる（Esc）">✕</button></span></h3><div id="bk_detailbody"><p class="k">矢印や列見出しにホバーすると詳細が出ます。クリックで固定。ダブルクリックでそのブロックの内側へ（どの段からでも）。</p></div><div id="bk_hoverbody"></div></aside>\n  <div id="bk_body"><div id="bk_treewrap"><svg id="bk_tree" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="bk_labwrap"></div><div id="bk_gridwrap"><canvas id="bk_grid"></canvas></div></div>\n</div>\n';
const CSS = '.bkmsa{--bg:#f3f6f7;--panel:#fff;--ink:#1b2530;--muted:#64707c;--line:#d3dbe1;--line2:#e7ecf0;--accent:#0d9488;--ref:#fff3e0;--reflab:#7a4b00;\n  --sel:#ff1493;--selbg:rgba(255,20,147,.12);--hover:rgba(13,148,136,.10);--shadow:0 6px 20px rgba(20,30,40,.14);--tick:#8a96a3;--rep:#6b7480;--gap:#eef2f5;--inv:#7c3aed;--disp:#d98200;--abs:#c9d1d8}.bkmsa *{box-sizing:border-box}.bkmsa{background:var(--bg);color:var(--ink);font:13px/1.45 "IBM Plex Sans",system-ui,sans-serif;display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}.bkmsa .chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.bkmsa .chip{font:11.5px "IBM Plex Mono",monospace;color:var(--muted);border:1px solid var(--line2);border-radius:999px;padding:2px 9px;background:var(--bg)}.bkmsa .chip b{color:var(--ink);font-weight:500}.bkmsa .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .grp{display:flex;align-items:center;gap:5px;padding-right:12px;border-right:1px solid var(--line2)}.bkmsa .grp:last-child{border-right:0}.bkmsa .grp .t{font-size:11.5px;color:var(--muted);margin-right:2px}.bkmsa button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:3px 9px;font:12px "IBM Plex Sans",sans-serif;cursor:pointer}.bkmsa button:hover{border-color:var(--accent)}.bkmsa button[disabled]{opacity:.45;cursor:default}.bkmsa button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa button.mono{font-family:"IBM Plex Mono",monospace}.bkmsa button:focus-visible, .bkmsa input:focus-visible{outline:2px solid var(--sel);outline-offset:1px}.bkmsa label{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px}.bkmsa input[type=checkbox]{accent-color:var(--accent)}.bkmsa .crumbs{display:flex;align-items:center;gap:3px;flex-wrap:wrap}.bkmsa .crumbs .sep{color:var(--muted);font-size:12px}.bkmsa .crumb{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:2px 8px;font:12px "IBM Plex Mono",monospace;cursor:pointer}.bkmsa .crumb[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa .legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted);padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .legend canvas{vertical-align:middle}.bkmsa #bk_tip{position:absolute;z-index:9;max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);padding:6px 9px;font:11.5px/1.45 "IBM Plex Mono",monospace;color:var(--ink);pointer-events:none;display:none;white-space:normal;word-break:break-all}.bkmsa #bk_tip p{margin:0 0 4px}.bkmsa #bk_tip p:last-child{margin:0}.bkmsa #bk_tip .k{color:var(--muted)}.bkmsa #bk_tip .h{color:var(--accent);font-weight:500}.bkmsa #bk_tip .copied{color:var(--accent);font-size:10.5px}.bkmsa #bk_mini{padding:3px 16px 2px;background:var(--panel);border-bottom:1px solid var(--line)}.bkmsa #bk_minic{width:100%;height:18px;display:block;cursor:pointer}.bkmsa.compact .set,.bkmsa.compact .legend{display:none}.bkmsa #bk_compact{font-size:11.5px;padding:2px 7px;color:var(--muted)}.bkmsa .bkmain{flex:1;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr) 320px;grid-template-rows:40px 1fr;min-height:0;background:var(--panel)}.bkmsa #bk_corner{grid-column:1/3;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10.5px;color:var(--muted);padding:4px 8px;display:flex;align-items:flex-end;justify-content:space-between}.bkmsa #bk_hdrwrap{border-bottom:1px solid var(--line);position:relative;overflow:hidden}.bkmsa #bk_detail{grid-row:1/3;border-left:1px solid var(--line);padding:10px 12px;overflow:auto;font:12px/1.55 "IBM Plex Mono",monospace;user-select:text;-webkit-user-select:text}.bkmsa #bk_detail h3{font:600 12px "IBM Plex Sans",sans-serif;margin:0 0 6px;color:var(--muted);display:flex;justify-content:space-between;align-items:center}.bkmsa #bk_detail .k{color:var(--muted)}.bkmsa #bk_detail .h{color:var(--accent);font-weight:500}.bkmsa #bk_detail p{margin:0 0 8px}.bkmsa #bk_hoverbody{border-top:1px dashed var(--line);margin-top:6px;padding-top:6px;color:var(--muted)}.bkmsa #bk_hoverbody:empty{display:none}.bkmsa #bk_detail ul{margin:0 0 8px;padding-left:16px}.bkmsa #bk_detail li{margin:0}.bkmsa #bk_body{grid-column:1/4;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr);overflow-y:auto;overflow-x:auto;min-height:0}.bkmsa #bk_treewrap{position:sticky;left:0;z-index:2;background:var(--panel)}.bkmsa #bk_labwrap{border-right:1px solid var(--line);position:sticky;left:var(--treew,130px);z-index:2;background:var(--panel)}.bkmsa .lab{position:absolute;left:0;right:0;height:30px;display:flex;align-items:center;padding:0 8px;font:11px "IBM Plex Mono",monospace;white-space:nowrap;overflow:hidden;\n  user-select:text;-webkit-user-select:text;border-bottom:1px solid var(--line2)}.bkmsa .lab.ref{background:var(--ref);color:var(--reflab)}.bkmsa .lab.hov{background:var(--hover)}.bkmsa .lab small{color:var(--muted);margin-left:6px;font-size:10px}.bkmsa #bk_gridwrap{position:relative}.bkmsa canvas{display:block}.bkmsa .sw{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:-1px;margin-right:4px}.bkmsa #bk_copybtn{font-size:11px;padding:1px 7px}.bkmsa .hapdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px;flex:none}\n.bkmsa #bk_detail h3 .dbtns{display:inline-flex;gap:4px}.bkmsa #bk_wide,.bkmsa #bk_close{font-size:11px;padding:1px 7px}.bkmsa #bk_detail .jl{max-height:360px;overflow:auto}\n.bkmsa.detailwide #bk_detail{display:block;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(88vw,1120px);height:min(84vh,820px);z-index:1000;border:1px solid var(--line);border-radius:8px;box-shadow:0 14px 44px rgba(20,30,40,.28);padding:12px 18px;font-size:12.5px;line-height:1.6}\n.bkmsa.detailwide #bk_detail table{font-size:12.5px!important}.bkmsa.detailwide #bk_detail .jl{max-height:calc(min(84vh,820px) - 170px)}.bkmsa.detailwide #bk_detail td,.bkmsa.detailwide #bk_detail th{padding:2px 8px}\n@media (max-width:900px){.bkmain{grid-template-columns:0 120px 1fr 0}.bkmsa #bk_body{grid-template-columns:0 120px 1fr}.bkmsa #bk_detail{display:none}}\n';
export interface BlockRef { win: number; level: number; W: number; rank: number; name: string; ref_contig: number; x: number; span: number; tbp: number; nhap: number; label: string;  names?: string[]; site?: boolean; base?: boolean; tree?: boolean; a0?: number; a1?: number }
export interface GeneLite { name: string; start: number; end: number; strand?: string }
export interface BlockMsaHandle { selectByRef(contig: number, bp: number): boolean; locateNodes?(names: string[]): void; isTree?(): boolean; setGraphAtoms?(atoms: number[] | number[][]): void; openGraphRange?(): void; setHapMarks(m: Map<string, string>): void; setGenes(g: Map<number, GeneLite[]>): void; destroy(): void; _layout?: () => any }
// 現在見えている窓・段のブロック一覧（色つき）。App がグラフのノードをブロック色で塗るのに使う
export interface BlockView { win: number; level: number; W: number; mode: string; tree?: boolean; blocks: { rank: number; color: string; ref_contig: number; x: number; span: number; label: string; members: number[]; a0?: number; a1?: number }[]; scope: { contig: number; start: number; end: number } | null; scopeKey: string; sync: boolean; n0: number;
  xRange?: [number, number] | null; atomsIn?: [number, number] | null;   // 木・ブロックより下の段: 窓の合意座標の範囲と、それに重なる原子の番号の範囲（グラフの塗り）
  nodeNames?: string[] | null;                                             // 塩基の段: MSA に出ている葉ノード名（グラフは葉の層でこれだけを塗る）
  filterGraph?: boolean; filterRange?: [number, number] | null;           // グラフをこの窓の範囲に絞る（範囲外のノードと辺を描かない）。filterRange=窓の合意座標の張り（根＝null で絞らない）
  filterSel?: { atoms: [number, number] } | { cols: [number, number] } | null }   // 集合の意味での窓: ブロック窓＝原子の範囲、アレル行列／塩基＝原子の内側の列範囲。グラフの部分グラフと寄せ先はこれで引く
export interface BlockMsaCallbacks { onSelectBlock?: (b: BlockRef | null) => void; onHoverBlock?: (b: BlockRef | null) => void; onDrill?: (req: BlockDrillRequest) => Promise<BlockDrillResult>; onRange?: (x0: number, x1: number, label: string, depth: number, parent: number, pblock: number) => Promise<any>; onSites?: (q: { c0?: number; c1?: number; x0?: number; x1?: number }) => Promise<any>; onTokRanges?: (c0: number, c1: number) => Promise<any>; onGenes?: (ranges: [string, number, number][]) => Promise<any>; onGenesCols?: (c0: number, c1: number, paths?: string[]) => Promise<any>; onJunction?: (jid: number) => Promise<any>; onJunctions?: () => Promise<any>; onJunctionBase?: (jid: number, k?: number) => Promise<any>; onBaseFetch?: (ranges: [string, number, number][], label: string, maxLeaves?: number) => Promise<any>; onLocate?: (names: string[]) => Promise<any>; onView?: (v: BlockView | null) => void; onSelectHap?: (groupKey: string, hap: string) => void; onBaseMsa?: (req: BlockDrillRequest) => void }
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
let RH = 30; const RH_BLOCK = 30, MINW = 4, SEP = 2;
// 段ごとの行の高さ: ブロックは上下 2 段の矢印で 30 px。アレル行列・塩基はセル 1 個なので、全行が入る高さ（12〜18 px）に詰める。
// 「行の高さ」の設定: 自動（既定）／標準（常に 30）／密（常に 14）。順序・ラベル・系統樹・印は変えない
function targetRH(nrows){ const mode = st.rowMode || 'auto'; if (!(isSites() || isBase())) return RH_BLOCK; if (mode === 'std') return RH_BLOCK; if (mode === 'dense') return 14;
  const avail = Math.max(120, ($('body').clientHeight || 600) - 2); const fit = Math.floor(avail / Math.max(1, nrows)); const lo = isBase() ? 14 : 12; return Math.max(lo, Math.min(18, fit)); }
let _rhAnim = null;
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
// 範囲のラベル。両端が同じ表記に丸まるときは kb の桁を増やして区別する
function fmtRange(xa, xb){ let a = fmtbp(xa), b = fmtbp(xb); if (a !== b) return a + '–' + b;
  const tries = xa >= 1e6 ? [[1e6, 2, ' Mb'], [1e6, 3, ' Mb'], [1e3, 1, ' kb'], [1e3, 2, ' kb']] : xa >= 1e3 ? [[1e3, 1, ' kb'], [1e3, 2, ' kb'], [1e3, 3, ' kb']] : [];
  for (const [u, d, suf] of tries){ a = (xa/u).toFixed(d)+suf; b = (xb/u).toFixed(d)+suf; if (a !== b) return a + '–' + b; }
  return Math.round(xa)+' bp–'+Math.round(xb)+' bp'; }
const esc = s => String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const st = { graphAtoms:null, graphRuns:null, gfilter:false, lane:true, jmark:true, foldGap:true, marks:null, rowMode:'auto', baseDiff:true, baseCmp:'ref', drilling:false, busy:null, anc:true, anc2:true, rangeSel:null, hoverRank:null, filter:null, filterPath:[], sync:true, onlySel:false, hapMarks:new Map(), genes:new Map(), colorBy:'order', win: 0, li: 0, mode:'msa', axis:'cons', order:'tree', origin:null, sel:null, hover:null, pinned:false, showMinor:true, bundle:true, showLinks:false, measure:'minor', norm:'abs'};
if (st.li<0) st.li=0;
st.li = Math.max(0, win().levels.length-1);   // 既定は最も粗い段
const cv = {hdr:$('hdr'), grid:$('grid'), mini:$('minic')};
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
    // 各行の並びの尺度: 行が**この窓で描く bp**（インスタンスの bp の和）で決める。ct.c.bp（コンティグ全長）だと子窓で 1/N に縮む（10-08 再発）
    let ownX = 4; let sOwn = W / Math.max(1, ...rows.map(rw=>rw.contigs.reduce((a,ct)=>a+((ct.c.inst && ct.c.inst.length) ? ct.c.inst.reduce((b,it)=>b+(it[2]||0),0) : ct.c.bp),0)));
    // 長い隙間（錨の無い配列、it[14]）を畳む: 畳む分を除いた bp と畳みの固定幅で尺度を決め直す（畳む判定は尺度に依るので 2 回反復）
    if (st.mode==='own' && st.foldGap){ for (let pass=0; pass<2; pass++){ let best = Infinity; for (const rw of rows){ let U=0, nf=0, ni=0; for (const ct of rw.contigs) for (const it of (ct.c.inst||[])){ ni++; U += it[2]||0; for (const gp of (it[14]||[])) if (gp[2]*sOwn > FOLD_PX){ U -= gp[2]; nf++; } } const avail = W - nf*FOLD_W - ni - 8*rw.contigs.length; if (U > 0 && avail > 0) best = Math.min(best, avail/U); } if (isFinite(best) && best > 0) sOwn = best; } }
    _sOwn = sOwn;
    for (const ct of r.contigs){
      if (bundled.has(ct)) continue; const placed=[];
      for (const {o, slot} of ct.items){
        let px, pw; let p_extra = {}; const p = { get ext(){ return p_extra.ext; }, set ext(v){ p_extra.ext = v; }, get col(){ return p_extra.col; }, set col(v){ p_extra.col = v; } };
        const colw0 = (st.mode!=='own' && o.kind<4 && slot.lane===0) ? blockX.get(vis[slot.pos]).w / (cnt0.get(o.rank)||1) : null;
        const bpw = colw0!=null ? Math.max(MINW, colw0) : Math.max(MINW, o.it[2]*(st.mode==='own'?sOwn:s));
        if (o.kind<4 && o.it.length>20 && o.it[20]) p_extra.ext = o.it[20];      // 合意範囲は上段・下段・両モードで持つ（リボンの相手範囲の交わりに使う）
        if (st.mode==='own'){ px = ownX; pw = bpw;
          if (st.foldGap && o.kind<4){ const parts = ownFoldPlan(o, p_extra, sOwn, !!(ct.c && ct.c.strand === '-')); if (parts){ let xx = px; for (const q of parts){ q.x = xx; xx += q.w; } pw = Math.max(MINW, xx - px); p_extra.parts = parts; } }
          ownX += pw + 1; }
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
          let mx = host ? xU(host, frac) : (sorted.length? sorted[0].x : null);
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
function divRamp(f){ const t = Math.max(0, Math.min(1, f)); const a = [226,231,238], b = [31,79,160]; return `rgb(${Math.round(a[0]+(b[0]-a[0])*t)},${Math.round(a[1]+(b[1]-a[1])*t)},${Math.round(a[2]+(b[2]-a[2])*t)})`; }   // 参照と違うサイトの割合（薄→濃）
function sitesOf(){ const L = level(); return L && L.mode === 'sites' ? L.sites : null; }
function sitesLayout(){ const S = sitesOf(); const W = $('gridwrap').clientWidth - 8; const n = Math.max(1, S.nsites); LY.siteW = Math.max(1, Math.min(14, Math.floor(W / n))); LY.fullW = SITES_X0 + n * LY.siteW + 4; LY.cols = []; LY.vis = []; LY.blockX = new Map();
  if (!S._cells){ const raw = atob(S.cells); const u = new Uint8Array(raw.length); for (let i=0;i<raw.length;i++) u[i] = raw.charCodeAt(i); S._cells = u; S._hidx = new Map(S.haps.map((h,i)=>[h,i])); } }
function drawSitesGrid(){ const S = sitesOf(); if (!S || !LY.siteW) return; const g = cv.grid.getContext('2d'); const sw = LY.siteW, gap = sw >= 4 ? 1 : 0; const H = S.H;
  LY.rows.forEach((r, ri) => { const hi = S._hidx.get(r.hap); if (hi == null) return; const y = ri*RH + 1, h = RH - 2;
    for (let k = 0; k < S.nsites; k++){ const a = S._cells[k*H + hi]; if (a === 255) continue; g.fillStyle = S.binned ? divRamp(a / 254) : SITES_COLORS[Math.min(a, SITES_COLORS.length-1)]; g.fillRect(SITES_X0 + k*sw, y, sw - gap, h); } });
  if (genesOn()){ ensureGenesCols(win()); drawGeneLanesCols(g); }
  if (st.rangeSel){ g.fillStyle = TH.selbg; g.globalAlpha = .5; g.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], cv.grid.clientHeight); g.globalAlpha = 1; } }
function drawSitesHeader(){ const S = sitesOf(); if (!S || !LY.siteW) return; const sw = LY.siteW, gap = sw >= 4 ? 1 : 0;
  // 列見出し: 目盛りと合意座標、アレル数の帯、ドラッグ中の範囲
  const gh = cv.hdr.getContext('2d'); const Hh = cv.hdr.clientHeight; gh.clearRect(0, 0, cv.hdr.clientWidth, Hh); gh.font = '10px "IBM Plex Mono"'; gh.fillStyle = TH.muted; gh.textAlign = 'left';
  let lastX = -1e9; const maxDens = S.binned ? Math.max(1, ...S.sites.map(s_ => s_.nsites / Math.max(1, s_.ncols))) : 1;
  for (let k = 0; k < S.nsites; k++){ const x = SITES_X0 + k*sw; const s_ = S.sites[k]; if (S.binned){ const d = (s_.nsites / Math.max(1, s_.ncols)) / maxDens; gh.fillStyle = divRamp(d); gh.fillRect(x, Hh-8, Math.max(1, sw-gap), 6); } else { gh.fillStyle = s_.nall >= 3 ? TH.disp : (s_.nall === 2 ? TH.accent : TH.line); gh.fillRect(x, Hh-6, Math.max(1, sw-gap), 4); }
    if (x - lastX >= 90){ gh.fillStyle = TH.muted; gh.fillText(fmtbp(s_.x), x, 12); gh.fillRect(x, 14, 1, 6); lastX = x; } }
  if (st.sel!=null && st.sel < S.nsites){ gh.strokeStyle = TH.sel; gh.lineWidth = 1.5; gh.strokeRect(SITES_X0 + st.sel*sw + .5, .5, Math.max(2, sw) - 1, Hh - 1); }
  if (st.rangeSel){ gh.fillStyle = TH.selbg; gh.globalAlpha = .6; gh.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], Hh); gh.globalAlpha = 1; } }
function siteAt(px){ const S = sitesOf(); if (!S) return null; const k = Math.floor((px - SITES_X0) / LY.siteW); return (k >= 0 && k < S.nsites) ? k : null; }
function siteInfo(k, ri){ const S = sitesOf(); const s_ = S.sites[k]; const H = S.H; const r = ri != null ? LY.rows[ri] : null; const hi = r ? S._hidx.get(r.hap) : null; const a = hi != null ? S._cells[k*H + hi] : null;
  if (S.binned) return `<p><span class="h">ビン ${k+1} / ${S.nsites}</span><br><span class="k">合意座標 ${fmtbp(s_.x)}〜 · 列 ${s_.c0}–${s_.c1}（${s_.ncols} 列）· 変異サイト ${s_.nsites}</span><br><span class="k">セルの濃さ＝そのビンで参照のアレルと違うサイトの割合。</span>${r ? `<br><span class="k">${esc(r.hap)}:</span> ${a===255?'この区間を持たない':(Math.round(a/254*100)+'% のサイトで参照と違う')}` : ''}<br><span class="k">列見出しをドラッグして狭めると、サイトごとのアレルの段へ降ります。</span></p>`;
  const names = S.sites.length ? '' : ''; const dist = s_.counts.map((n, i) => `<span style="display:inline-block;width:9px;height:9px;background:${SITES_COLORS[Math.min(i, SITES_COLORS.length-1)]};vertical-align:-1px;margin-right:3px"></span>${i===0?'参照側':'アレル '+(i+1)} ${n} 株`).join(' · ');
  return `<p><span class="h">変異サイト ${k+1} / ${S.nsites}</span><br><span class="k">合意座標 ${fmtbp(s_.x)} · 列 ${s_.c0}–${s_.c1}（${s_.ncols} 列、最長 ${s_.bp} bp）· アレル ${s_.nall} 種</span><br>${dist}${r ? `<br><span class="k">${esc(r.hap)}:</span> ${a===255?'この区間を持たない':(a===0?'参照側のアレル':'アレル '+(a+1))}` : ''}</p>`; }
function siteRef(k){ const S = sitesOf(); const L = level(); if (!S || k==null || !S.sites[k]) return null; const s_ = S.sites[k]; const span = Math.max(400, s_.bp * 2);
  return { win: st.win, level: st.li, W: 0, rank: k, name: 'site', ref_contig: (L.refc!=null ? L.refc : 0), x: Math.max(0, s_.x - span/2), span, tbp: s_.bp, nhap: S.ncover, label: '変異サイト ' + (k+1), site: true }; }
function sitesWindow(S, label, parent, pblock, c0, c1){ const pw = WINS[parent]; const Lp = pw.levels[0]; const PB = pblock>=0 ? Lp.blocks[pblock] : null;
  const refc = PB ? (PB.ref_contig!=null ? PB.ref_contig : 0) : (Lp.blocks[0] ? (Lp.blocks[0].ref_contig||0) : 0); const pcolor = PB ? colorOf(pblock) : 'rgb(13,148,136)';
  const haps = Lp.haps.map(h => ({ hap: h.hap, isref: h.isref, contigs: [{ name: '', path: '', strand: '+', start: 0, bp: 0, nsteps: 0, inst: [], minor: [] }] }));
  return { id: -1, parent, pblock, depth: pw.depth + 1, label, atoms: 0, H: haps.length, children: {}, mode: 'sites', anchors: null, ondemand: true, tree: true,
    levels: [{ W: 0, nblocks: 0, blocks: [], haps, mergecap: 0, mode: 'sites', adj: [], events: {}, origin: 0, merges: 0, members: null, nonmono: 0, sites: S, c0, c1, refc, pcolor }] }; }
function notice(msg){ $('detailbody').innerHTML = `<p class="k">${msg}</p>`; try { setHoverInfo(`<p class="k">${msg}</p>`); } catch (e) { /* 初期化前 */ } }
function openSites(q, label, pblock){ if (!(cb && cb.onSites) || st.drilling) return; const pw = st.win;
  const ncol = (q.c0 != null && q.c1 != null) ? (q.c1 - q.c0 + 1) : null;
  if (ncol != null && ncol <= BASE_MAX_LEAVES && pblock != null && pblock >= 0){ baseMsa(pblock); return; }   // 葉 400 以下 → 塩基へ
  const key = 's:' + (q.c0 != null ? q.c0 + ':' + q.c1 : Math.round(q.x0) + ':' + Math.round(q.x1)); const w = win(); const ch = w.children ? w.children[key] : null; if (ch != null){ enterWindow(ch); return; }
  st.drilling = true; st.busy = `${label} の変異サイトを集めています…`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  cb.onSites(q).then(S => { st.drilling = false; st.busy = null;
    if (!S || S.error || S.tooMany){ drawAll(); $('detailbody').innerHTML = `<p class="k">${esc((S && S.error) || '応答なし')}${S && S.tooMany ? ' 列見出しをドラッグして狭い区間を選ぶと変異サイトの段に降りられます。' : ''}</p>`; return; }
    // 範囲が葉 400 以下なら、変異サイトの有無に関わらずアレル行列を挟まず塩基へ（全株同一でも塩基は見せる）。
    // 変異サイトが少ない（≤ BASE_FEW_SITES）ならアレル行列は数列で意味が無いので、葉 BASE_IDENT_MAX までは上限を上げて塩基へ
    const ncS = (S.c0 != null && S.c1 != null) ? (S.c1 - S.c0 + 1) : null;
    if (ncS != null && cb.onTokRanges && (ncS <= BASE_MAX_LEAVES || (S.nsites <= BASE_FEW_SITES && ncS <= BASE_IDENT_MAX))){ drawAll();
      const xrq = (q.x0 != null && q.x1 != null) ? [q.x0, q.x1] : (S.nsites ? [S.sites[0].x, S.sites[S.nsites-1].x + Math.max(1, S.sites[S.nsites-1].bp)] : null);
      baseFromCols(S.c0, S.c1, label, ncS > BASE_MAX_LEAVES ? BASE_IDENT_MAX : undefined, xrq); return; }
    if (!S.nsites){ drawAll(); notice(`${esc(label)}（${S.ncols.toLocaleString()} 列）は全株同一で、変異サイトがありません。塩基を見るには列見出しをドラッグして ${BASE_IDENT_MAX.toLocaleString()} 列以下（この範囲の約 ${Math.max(1, Math.round(100 * BASE_IDENT_MAX / S.ncols))}%）に絞ってください。`); return; }
    const nw = sitesWindow(S, label, pw, pblock != null ? pblock : -1, S.c0, S.c1); nw.id = WINS.length; nw.plevel = st.li; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; nw.ms = S.ms || 0;
    enterWindow(nw.id); $('detailbody').innerHTML = S.binned ? `<p class="k">変異サイトが ${S.totalSites.toLocaleString()} 個あるので、${S.sitesPerBin} サイトずつ ${S.nsites} ビンにまとめた粗い段です（列 ${S.ncols}、${S.ncover} 株が被覆）。セルの濃さ＝参照と違うサイトの割合。列見出しをドラッグして狭めると、サイトごとのアレルの段へ降ります。</p>` : `<p class="k">変異サイト ${S.nsites} 個（列 ${S.ncols}、${S.ncover} 株が被覆）。セルの色＝アレル（灰＝参照側）。行は系統樹順。列見出しをドラッグで狭い区間へ、葉 ${BASE_MAX_LEAVES} 以下で塩基 MSA へ。</p>`;
  }).catch(e => { st.drilling = false; st.busy = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; }); }
// アレル行列の中のドラッグ: サイトの範囲 → 列の範囲。葉 400 以下なら親ブロックの錨で絞って塩基へ、そうでなければ狭いアレル行列
function sitesRange(xa, xb){ const S = sitesOf(); if (!S) return; const ks = []; S.sites.forEach((s_, k) => { if (s_.x + Math.max(1, s_.bp) > xa && s_.x < xb) ks.push(k); }); const label = fmtRange(xa, xb);
  // 範囲にサイトが無い（全株同一の区間）→ 合意座標で列を切る（400 列以下なら塩基、そうでなければ通知）
  if (!ks.length){ st.rangeSel = null; drawAll(); openSites({ x0: xa, x1: xb }, label, -1); return; }
  const c0 = S.sites[ks[0]].c0, c1 = S.sites[ks[ks.length-1]].c1; const ncol = c1 - c0 + 1;
  const xrSel = [S.sites[ks[0]].x, S.sites[ks[ks.length-1]].x + Math.max(1, S.sites[ks[ks.length-1]].bp)];
  if (ncol <= BASE_MAX_LEAVES){ st.rangeSel = null; drawAll(); baseFromCols(c0, c1, label, undefined, xrSel); return; }
  // 1 つの座位（錨の間）の内側を選んだ: 座位は分割できないので、合意座標で列を切る（錨の無い長い座位＝島・大きなノード）
  const one = S.sites[ks[0]]; if (ks.length === 1 && (xb - xa) < 0.9 * Math.max(1, one.bp)){ st.rangeSel = null; drawAll(); openSites({ x0: xa, x1: xb }, label, -1); return; }
  if (c0 === S.c0 && c1 === S.c1){ st.rangeSel = null; drawAll(); notice(`選んだ範囲は今の窓（列 ${S.c0.toLocaleString()}–${S.c1.toLocaleString()}）と同じです。狭く選ぶか、サイトの内側を選んでください。`); return; }
  st.rangeSel = null; openSites({ c0, c1 }, label, -1); }
// 列の範囲 [c0, c1] を塩基 MSA へ: backend が distill から各行のトークン範囲を出す（錨の標本に頼らない）
function baseFromCols(c0, c1, label, maxLeaves, xr){ if (!(cb && (cb.onBaseFetch || cb.onBaseMsa))) return; if (!(cb && cb.onTokRanges)){ $('detailbody').innerHTML = '<p class="k">この構成では列の範囲を塩基へ渡せません。</p>'; return; }
  if (st.drilling) return; st.drilling = true; st.busy = `${label}: 列 ${c0}–${c1} の各行のトークン範囲を求めています…`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  cb.onTokRanges(c0, c1).then(r => { st.busy = null; st.drilling = false; if (!r || r.error || !r.ranges || !r.ranges.length){ drawAll(); notice(`塩基へ渡せませんでした: ${esc((r && r.error) || '範囲にトークンがありません')}`); return; }
    openBase(r.ranges, label, -1, c0, c1, maxLeaves, xr);
  }).catch(e => { st.busy = null; st.drilling = false; drawAll(); notice(`失敗: ${esc(String(e))}`); }); }

// ---- 塩基の段（パネル内 MSA）: 木の底。bubble MSA と同じ計算（各行のトークン範囲）を、同じ描画器の列として描く。
//      列＝塩基（ノードの中の位置）。ノード（群）の境界を見出しに出し、ノードの大きさ（bp）を書く。長いノードは中央を畳む（⋯）。
const BASE_COLORS = { A: ['#ffffff', '#2e8b57'], C: ['#ffffff', '#2f6fb3'], G: ['#1b1b1b', '#e0a800'], T: ['#ffffff', '#c9302c'], N: ['#ffffff', '#6b7480'] };   // [文字, 塗り]。塗りを濃くして読みやすく
function isBase(){ return !!(level() && level().mode === 'base'); }
function baseOf(){ const L = level(); return L && L.mode === 'base' ? L.base : null; }
const BASE_CAPc = 12, BASE_HEADc = 7, BASE_TAILc = 3, BASE_MINCW = 3;
function baseLayout(){ const M = baseOf(); const W = $('gridwrap').clientWidth - 8; const cols = M.cols || [];
  // 群（ノード）: 列の g の連なり
  const groups = []; cols.forEach((c, i) => { const last = groups[groups.length - 1]; if (last && last.g === c.g){ last.to = i; } else groups.push({ g: c.g, from: i, to: i, nodes: c.nodes, rb: c.rb }); });
  for (const gr of groups){ const ell = cols.slice(gr.from, gr.to + 1).find(c => c.kind === 'ell'); gr.bp = ell ? (ell.bp || (gr.to - gr.from + 1)) : (gr.to - gr.from + 1); gr.variant = cols.slice(gr.from, gr.to + 1).some(c => c.variant); }   // サーバが畳んだ群は ell.bp がノード全長
  // 表示項目: 全列が最小幅で入るなら畳まない。入らなければ長い群の中央を畳む（サーバが畳んだ ell 列はそのまま 1 項目）
  const fitAll = cols.length * BASE_MINCW <= W; const items = [];
  for (const gr of groups){ const n = gr.to - gr.from + 1; const hasEll = cols.slice(gr.from, gr.to + 1).some(c => c.kind === 'ell');
    if (fitAll || hasEll || n <= BASE_CAPc){ for (let i = gr.from; i <= gr.to; i++) items.push(cols[i].kind === 'ell' ? { kind: 'ell', ci0: i, ci1: i, n: cols[i].bp || 0, g: gr.g } : { kind: 'col', ci: i, g: gr.g }); }
    else { for (let i = gr.from; i < gr.from + BASE_HEADc; i++) items.push({ kind: 'col', ci: i, g: gr.g }); items.push({ kind: 'ell', ci0: gr.from + BASE_HEADc, ci1: gr.to - BASE_TAILc, n: n - BASE_HEADc - BASE_TAILc, g: gr.g }); for (let i = gr.to - BASE_TAILc + 1; i <= gr.to; i++) items.push({ kind: 'col', ci: i, g: gr.g }); } }
  const nEll = items.filter(it => it.kind === 'ell').length; const nCol = items.length - nEll;
  const cw = Math.max(2, Math.min(14, Math.floor((W - nEll * 28) / Math.max(1, nCol)))); const ew = Math.max(cw * 3, 28);
  const xs = new Float64Array(items.length + 1); let x = SITES_X0; items.forEach((it, k) => { xs[k] = x; x += (it.kind === 'ell' ? ew : cw); }); xs[items.length] = x;
  const gx = new Map(); items.forEach((it, k) => { const e = gx.get(it.g) || { x0: xs[k], x1: xs[k+1] }; e.x1 = xs[k+1]; gx.set(it.g, e); }); for (const gr of groups){ const e = gx.get(gr.g); gr.x0 = e ? e.x0 : 0; gr.x1 = e ? e.x1 : 0; }
  LY.bcw = cw; LY.bxs = xs; LY.bitems = items; LY.bgroups = groups; LY.bfold = !fitAll; LY.fullW = x + 4; LY.cols = []; LY.vis = []; LY.blockX = new Map();
  if (!M._rowOf){ M._rowOf = new Map(); (M.rows || []).forEach((r, i) => M._rowOf.set(r.label, i)); const ri_ = (M.rows || []).findIndex(r => r.isref); M._refRow = ri_ >= 0 ? ri_ : ((M.rows || []).length ? 0 : null);
    M._inv = (M.rows || []).map(r => { const st_ = new Set(); for (const n of (r.inv || [])) cols.forEach((c, i) => { if (c.nodes.indexOf(n) >= 0) st_.add(i); }); return st_; }); } }
function baseCellColor(ch){ const c = BASE_COLORS[ch.toUpperCase()] || BASE_COLORS.N; return c; }
// 比較の基準（列見出しの下段に出し、「参照一致を省く」の基準になる）: 参照パスの行、または列ごとの多数派の塩基
function baseCmpSeq(M){ if (st.baseCmp === 'major'){ if (!M._major){ const n = (M.cols || []).length; const out = new Array(n).fill('-');
      for (let i = 0; i < n; i++){ const cnt = new Map(); for (const r of M.rows){ const ch = r.seq[i]; if (!ch || ch === '-' || ch === '~') continue; cnt.set(ch, (cnt.get(ch) || 0) + 1); } let best = '-', bn = 0; for (const [ch, c] of cnt) if (c > bn){ bn = c; best = ch; } out[i] = best; } M._major = out; }
    return { seq: M._major, label: '多数派（列ごとの最頻の塩基）', isRow: null }; }
  const rr = M._refRow != null ? M.rows[M._refRow] : null; return rr ? { seq: rr.seq, label: (rr.isref ? '参照パス ' : '先頭の行 ') + rr.label, isRow: M._refRow } : { seq: null, label: '', isRow: null }; }
function baseFontPx(cw, h){ return Math.max(0, Math.min(13, h - 2, Math.floor(cw / 0.62))); }
function drawBaseGrid(){ const M = baseOf(); if (!M || !LY.bxs) return; const g = cv.grid.getContext('2d'); const cols = M.cols || []; const xs = LY.bxs; const items = LY.bitems; const cw = LY.bcw; const hcell = RH - 2; const fpx = baseFontPx(cw, hcell); const letters = cw >= 5 && fpx >= 8; g.font = `bold ${fpx}px "IBM Plex Mono"`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const cmp = baseCmpSeq(M); const cmpSeq = cmp.seq;
  LY.rows.forEach((r, ri) => { const mi = M._rowOf.get(r.hap); if (mi == null) return; const row = M.rows[mi]; const y = ri*RH + 1, h = hcell; const inv = M._inv[mi];
    for (let k = 0; k < items.length; k++){ const it = items[k]; const x = xs[k], w = xs[k+1] - xs[k] - (cw >= 8 ? 1 : 0);
      if (it.kind === 'ell'){ let has = false; for (let i = it.ci0; i <= it.ci1; i++){ const ch = row.seq[i]; if (ch && ch !== '-') { has = true; break; } } if (!has) continue;
        g.fillStyle = TH.line; g.fillRect(x, y + 2, w, h - 4); continue; }   // 畳んだ区間（数は見出しの ⋯N に出す。行ごとには書かない）
      const ch = row.seq[it.ci]; if (ch === '-' || ch === undefined) continue;
      if (ch === '~'){ g.fillStyle = TH.line; g.fillRect(x, y + 2, w, h - 4); continue; }
      if (st.baseDiff && cmpSeq && cmpSeq[it.ci] === ch){ g.fillStyle = TH.line2; g.fillRect(x, y, w, h); if (letters){ g.fillStyle = TH.muted; g.fillText('·', x + w/2, y + h/2 + 1); } continue; }   // 基準と一致 → 省く（基準の配列は列見出しの下段）
      const col = baseCellColor(ch); g.fillStyle = col[1]; g.fillRect(x, y, w, h); if (letters){ g.fillStyle = col[0]; g.fillText(ch, x + w/2, y + h/2 + 1); }
      if (inv && inv.has(it.ci)){ g.fillStyle = TH.inv; g.fillRect(x, y, w, 2); } } });
  if (st.hover && st.hover.ci != null){ const k = LY.bitems.findIndex(it => it.kind === 'col' ? it.ci === st.hover.ci : (st.hover.ci >= it.ci0 && st.hover.ci <= it.ci1)); if (k >= 0){ g.fillStyle = TH.hover; g.fillRect(xs[k], 0, xs[k+1]-xs[k], cv.grid.clientHeight); } }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; }
function drawBaseHeader(){ const M = baseOf(); if (!M || !LY.bxs) return; const gh = cv.hdr.getContext('2d'); const Hh = cv.hdr.clientHeight; gh.clearRect(0, 0, cv.hdr.clientWidth, Hh); gh.textBaseline = 'alphabetic';
  const xs = LY.bxs, items = LY.bitems, cw = LY.bcw; const cmp = baseCmpSeq(M); const refRow = cmp.seq ? { seq: cmp.seq } : null;
  // 上段（0..16）: ノードの帯と大きさ。下段（17..Hh-6）: 比較の基準の配列（参照パス or 多数派）。底（Hh-5..）: 錨・variant の印
  // 上段 = ノードの帯: 1 ノード（群）＝ 1 つの箱。箱の中に名前と長さ（bp）。複数の排他アレルを 1 列に重ねた群は上に青緑の帯線。
  // 以前は群の左端に 1 本の縦線（複数アレルだけ緑）と、幅が狭いと単位の無い数字だけを出していて意味が読めなかった（2026-10-07）
  LY.bgroups.forEach((gr, k) => { const w = gr.x1 - gr.x0; gh.fillStyle = k % 2 ? TH.line2 : TH.gap; gh.fillRect(gr.x0, 0, w, 16);
    gh.fillStyle = TH.line; gh.fillRect(gr.x0, 0, 1, 16); gh.fillRect(gr.x1 - 1, 0, 1, 16);                                   // 箱の仕切り（両端）
    if (gr.nodes.length > 1){ gh.fillStyle = TH.accent; gh.fillRect(gr.x0, 0, w, 3); }                                        // 排他アレルの群
    gh.font = '10px "IBM Plex Mono"'; gh.textAlign = 'left';
    const nm = gr.nodes[0] + (gr.nodes.length > 1 ? '+' + (gr.nodes.length - 1) : ''); const bp = gr.bp.toLocaleString() + ' bp';
    const label = w >= 118 ? `${nm} · ${bp}` : (w >= 62 ? nm : (w >= 40 ? bp : ''));                                           // 名前を優先。数字だけは出さない
    if (label){ gh.fillStyle = TH.ink; gh.fillText(label, gr.x0 + 4, 12); }
    if (gr.rb){ gh.fillStyle = TH.accent; gh.fillRect(gr.x0, Hh - 5, w, 2); }
    if (gr.variant){ gh.fillStyle = TH.disp; gh.fillRect(gr.x0 + 1, Hh - 3, Math.max(1, w - 2), 3); } });
  // 参照の配列（参照行が無ければ先頭の行）
  if (refRow){ const y = 18, h = Hh - 6 - 18; const fpx = baseFontPx(cw, h); gh.font = `bold ${fpx}px "IBM Plex Mono"`; gh.textAlign = 'center'; gh.textBaseline = 'middle';
    for (let k = 0; k < items.length; k++){ const it = items[k]; const x = xs[k], w = xs[k+1] - xs[k] - (cw >= 8 ? 1 : 0);
      if (it.kind === 'ell'){ gh.fillStyle = TH.line; gh.fillRect(x, y + 1, w, h - 2); if (w >= 20){ gh.fillStyle = TH.ink; gh.fillText('⋯' + (it.n || ''), x + w/2, y + h/2); } continue; }
      const ch = refRow.seq[it.ci]; if (!ch || ch === '-'){ gh.fillStyle = TH.gap; gh.fillRect(x, y + 1, w, h - 2); continue; }
      if (ch === '~'){ gh.fillStyle = TH.line; gh.fillRect(x, y + 1, w, h - 2); continue; }
      const col = baseCellColor(ch); gh.fillStyle = col[1]; gh.fillRect(x, y, w, h); if (cw >= 5 && fpx >= 8){ gh.fillStyle = col[0]; gh.fillText(ch, x + w/2, y + h/2 + 1); } }
    gh.textBaseline = 'alphabetic'; gh.textAlign = 'left'; }
  if (st.sel != null && LY.bgroups[st.sel]){ const gr = LY.bgroups[st.sel]; gh.strokeStyle = TH.sel; gh.lineWidth = 1.5; gh.strokeRect(gr.x0 + .5, .5, gr.x1 - gr.x0 - 1, Hh - 1); }
  if (st.rangeSel){ gh.fillStyle = TH.selbg; gh.globalAlpha = .6; gh.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], Hh); gh.globalAlpha = 1; } }
function baseGroupAt(px){ if (!LY.bgroups) return null; for (let k = 0; k < LY.bgroups.length; k++){ const gr = LY.bgroups[k]; if (px >= gr.x0 && px < gr.x1) return k; } return null; }
function baseItemAt(px){ const xs = LY.bxs; if (!xs) return null; for (let i = 0; i + 1 < xs.length; i++) if (px >= xs[i] && px < xs[i+1]) return i; return null; }
function baseColAt(px){ const k = baseItemAt(px); if (k == null) return null; const it = LY.bitems[k]; return it.kind === 'col' ? it.ci : it.ci0; }
function baseGroupInfo(k, ri, ci){ const M = baseOf(); const gr = LY.bgroups[k]; const r = ri != null ? LY.rows[ri] : null; const mi = r ? M._rowOf.get(r.hap) : null; const row = mi != null ? M.rows[mi] : null; const col = ci != null ? M.cols[ci] : null;
  return `<p><span class="h">ノード ${esc(gr.nodes.join(' | '))}</span>${gr.nodes.length > 1 ? `<br><span class="k">同じサイトの排他アレル ${gr.nodes.length} 個を 1 列に重ねた群（帯の上の青緑線）</span>` : ''}<br><span class="k">ノードの長さ ${gr.bp.toLocaleString()} bp${gr.rb ? ` · 参照 ${fmtbp(gr.rb)}` : ''}${gr.variant ? ' · 行間で塩基が違う' : ''}</span>` +
    (row ? `<br><span class="k">${esc(row.label)}（${row.strand} 鎖）:</span> ${col ? (row.seq[ci] === '-' ? '欠失（gap）' : row.seq[ci] === '~' ? '畳んだ部分' : `塩基 ${esc(row.seq[ci])}${col.off != null ? '（ノード内 ' + (col.off + 1) + ' 塩基目）' : ''}`) : ''}${(M._inv[mi] && ci != null && M._inv[mi].has(ci)) ? ' · 周りと逆向きに通過（逆相補で表示）' : ''}` : '') + `</p>`; }
function baseRef(k){ const M = baseOf(); if (!M || k == null || !LY.bgroups || !LY.bgroups[k]) return null; const gr = LY.bgroups[k]; const L = level();
  return { win: st.win, level: st.li, W: 0, rank: k, name: gr.nodes[0], ref_contig: (L.refc != null ? L.refc : 0), x: gr.rb || 0, span: Math.max(1, gr.bp), tbp: gr.bp, nhap: 0, label: gr.nodes.join('|'), names: gr.nodes, base: true }; }
function baseWindow(M, label, parent, pblock, c0, c1){ const pw = WINS[parent]; const Lp = pw.levels[0];
  // 行 = MSA の行（同じハプロタイプの複数通過は ·2 の別行）。順序は親の行順（系統樹順）に合わせる
  const order = new Map(); Lp.haps.forEach((h, i) => order.set(h.hap, i)); const key = lb => lb.replace(/·\d+$/, '');
  const rows = (M.rows || []).slice().sort((a, b) => ((order.get(key(a.label)) ?? 1e9) - (order.get(key(b.label)) ?? 1e9)) || (a.label < b.label ? -1 : 1));
  const haps = rows.map(r => ({ hap: r.label, isref: r.isref ? 1 : 0, contigs: [{ name: '', path: r.path || '', strand: r.strand || '+', start: 0, bp: 0, nsteps: 0, inst: [], minor: [] }] }));
  const refc = Lp.refc != null ? Lp.refc : (Lp.blocks && Lp.blocks[0] ? (Lp.blocks[0].ref_contig || 0) : 0);
  return { id: -1, parent, pblock, depth: pw.depth + 1, label, atoms: 0, H: haps.length, children: {}, mode: 'base', anchors: null, ondemand: true, tree: true,
    levels: [{ W: 0, nblocks: 0, blocks: [], haps, mergecap: 0, mode: 'base', adj: [], events: {}, origin: 0, merges: 0, members: null, nonmono: 0, base: M, c0, c1, refc }] }; }
// 塩基の窓を開く（各行のトークン範囲 → bubble MSA と同じ計算 → パネル内に描く）。onBaseFetch が無ければ従来どおり別パネルへ
function openBase(ranges, label, pblock, c0, c1, maxLeaves, xr){ if (!ranges || !ranges.length) return;
  if (!(cb && cb.onBaseFetch)){ if (cb && cb.onBaseMsa) cb.onBaseMsa({ ranges, span: 0, afrac: 0, label, depth: win().depth + 1, parent: st.win, pblock: pblock != null ? pblock : -1 }); return; }
  const pw = st.win; const key = 'b:' + (c0 != null ? c0 + ':' + c1 : label); const w = win(); const ch = w.children ? w.children[key] : null; if (ch != null){ enterWindow(ch); return; }
  st.drilling = true; st.busy = `${label} の塩基レベル MSA を計算しています…（${ranges.length} 行）`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  cb.onBaseFetch(ranges, label, maxLeaves).then(M => { st.drilling = false; st.busy = null;
    if (!M || M.error || !M.cols || !M.cols.length){ drawAll(); notice(`塩基レベル MSA を作れませんでした: ${esc((M && M.error) || '列がありません')}`); return; }
    const nw = baseWindow(M, label, pw, pblock != null ? pblock : -1, c0, c1); nw.range = xr || null; nw.id = WINS.length; nw.plevel = st.li; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id;
    enterWindow(nw.id); const ng = LY.bgroups ? LY.bgroups.length : 0; $('detailbody').innerHTML = `<p class="k">塩基の段: 列 ${M.cols.length}（ノード ${ng} 個）・行 ${M.rows.length}。列見出しの上段＝ノード（群）の帯: 名前と大きさ（bp。「n123[2] 1 bp」の [2] は同じサイトの排他アレル 2 個を 1 列に重ねたもの、緑の縦線はその群の左端）。下段＝比較の基準の配列（参照パスの行、または多数派）。「一致を省く」は基準と同じ塩基を · にする（基準が参照パスなら参照の行も · になる。配列は下段にある）。底の線＝参照座標の錨（青）・行間で塩基が違う（橙）。長いノードは画面に入らないときだけ中央を畳む（⋯N）。列見出しをドラッグで列の範囲に絞る。セルの上の紫線＝周りと逆向きに通ったノード（逆相補で表示）。</p>`;
  }).catch(e => { st.drilling = false; st.busy = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; }); }

// 塩基の段の範囲選択: ドラッグした列の範囲に絞った入れ子の窓（cols/rows を切り出すだけ。再計算なし）
function baseRange(pa, pb){ const M = baseOf(); if (!M || !LY.bxs) return; const k0 = baseItemAt(pa), k1 = baseItemAt(pb); const toCol = (k, end) => { if (k == null) return null; const it = LY.bitems[k]; return it.kind === 'col' ? it.ci : (end ? it.ci1 : it.ci0); };
  let i0 = toCol(k0, false), i1 = toCol(k1, true); if (i0 == null) i0 = pa < LY.bxs[0] ? 0 : M.cols.length - 1; if (i1 == null) i1 = pb < LY.bxs[0] ? 0 : M.cols.length - 1;
  if (i1 < i0){ const t = i0; i0 = i1; i1 = t; } if (i1 - i0 < 1 || (i0 === 0 && i1 === M.cols.length - 1)){ st.rangeSel = null; drawAll(); return; }
  const sub = { ...M, cols: M.cols.slice(i0, i1 + 1), rows: M.rows.map(r => ({ ...r, seq: r.seq.slice(i0, i1 + 1) })), _rowOf: null, _inv: null, _refRow: null, name: (M.name || '') + ` 列 ${i0 + 1}–${i1 + 1}` };
  const label = `列 ${i0 + 1}–${i1 + 1}`; const w = win(); const key = 'bc:' + i0 + ':' + i1; const ch = w.children ? w.children[key] : null; st.rangeSel = null; if (ch != null){ enterWindow(ch); return; }
  const nw = baseWindow(sub, label, st.win, -1, null, null); nw.range = w.range || null; nw.id = WINS.length; nw.plevel = st.li; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; enterWindow(nw.id);
  $('detailbody').innerHTML = `<p class="k">列 ${i0 + 1}–${i1 + 1}（${i1 - i0 + 1} 列）に絞りました。「全体へ」で戻ります。</p>`; }
// グラフで選んだノードの場所（locate の結果）を列見出しに印として重ねる。ブロックの段: 原子の x をブロックの列の中に写す。アレル行列: サイトの x
function xOfCons(x){ if (isSites()){ const S = sitesOf(); if (!S || !S.nsites) return null; let lo = 0, hi = S.nsites; while (lo < hi){ const m = (lo + hi) >> 1; if (S.sites[m].x < x) lo = m + 1; else hi = m; } const k = Math.min(S.nsites - 1, lo); return SITES_X0 + k * LY.siteW; }
  const L = level(); for (const c of LY.cols){ if (c.type !== 'block') continue; const B = L.blocks[c.rank]; if (x >= B.x && x <= B.x + Math.max(1, B.span)) return c.x + (x - B.x) / Math.max(1, B.span) * c.w; } return null; }
function drawMarks(){ const gh = cv.hdr.getContext('2d'); const Hh = cv.hdr.clientHeight;
  // グラフの表示範囲の帯: 見えているノードが属する原子（斜線の帯、列見出しの底）。散らばっていれば複数
  if (st.graphRuns && st.graphRuns.length){ gh.save(); gh.fillStyle = TH.accent;
    for (const r of st.graphRuns){ const xa = xOfCons(r.x0), xb = xOfCons(r.x1); if (xa == null && xb == null) continue; const x0 = xa != null ? xa : xb, x1 = xb != null ? xb : xa; gh.globalAlpha = .25 + .6 * r.share; gh.fillRect(Math.min(x0, x1), Hh - 4, Math.max(2, Math.abs(x1 - x0)), 4); }
    gh.restore(); }
  if (!st.marks || !st.marks.length) return;
  for (const m of st.marks){ for (const p of m.places){ const xa = xOfCons(p.x0), xb = xOfCons(Math.max(p.x0, p.x1)); if (xa == null && xb == null) continue; const x0 = xa != null ? xa : xb, x1 = xb != null ? xb : xa;
    gh.fillStyle = TH.sel; gh.globalAlpha = .25; gh.fillRect(Math.min(x0, x1), 0, Math.max(3, Math.abs(x1 - x0)), Hh); gh.globalAlpha = 1; gh.beginPath(); gh.moveTo(x0 - 5, 0); gh.lineTo(x0 + 5, 0); gh.lineTo(x0, 7); gh.closePath(); gh.fillStyle = TH.sel; gh.fill(); } } }

// ---- ミニマップ: 全体（根の最細段のブロック）を細い帯に描き、今の窓の範囲を明るく示す。環状なら根の表示と同じ回転。
//      座標は合意累積 bp（木）または根のブロックの x（旧）。クリック＝そのブロックの窓、ドラッグ＝範囲の窓 ----
// 重み付きの原子 [[atom, w, xmin, xmax]] → 番号が連続する原子を一つの連なり（合意座標 x0–x1）にまとめ、重みの割合 share を付ける。割合 < 1% の連なりは落とす。
// 葉の合意座標 xmin/xmax がその原子の中にあればそれを使う（グラフのズームに追従）。無ければ原子の全幅
function graphRunsOf(a){ if (!a || !a.length || !DATA.meta.atoms) return null; const A = DATA.meta.atoms; const s = a.filter(e => A[e[0]]).sort((u, v) => u[0] - v[0]); if (!s.length) return null;
  const runs = []; for (const [id, w, xm, xM] of s){ const at = A[id]; const ax0 = at[0], ax1 = at[0] + Math.max(1, at[1]); const fine = xm != null && xM != null && xm >= 0 && xM > xm && xm >= ax0 - 1 && xM <= ax1 + 1; const lo = fine ? xm : ax0, hi = fine ? xM : ax1;
    const last = runs[runs.length - 1]; if (last && id === last.a1 + 1){ last.a1 = id; last.x0 = Math.min(last.x0, lo); last.x1 = Math.max(last.x1, hi); last.w += w; } else runs.push({ a0: id, a1: id, x0: lo, x1: hi, w }); }
  const W = runs.reduce((t, r) => t + r.w, 0) || 1; for (const r of runs) r.share = r.w / W; const out = runs.filter(r => r.share >= 0.01).sort((u, v) => v.share - u.share); return out.length ? out : null; }
function miniBlocks(){ const R = WINS[0]; const L0 = R.levels[0]; if (!L0 || !L0.blocks.length) return null;
  const n0 = L0.nblocks; const o = (DATA.meta.circular && L0.origin != null) ? L0.origin : 0; const order = [...Array(n0).keys()].sort((a, b) => (((a - o) % n0 + n0) % n0) - (((b - o) % n0 + n0) % n0));
  const tot = order.reduce((a, r) => a + Math.max(1, L0.blocks[r].span), 0); let acc = 0; const items = order.map((r, i) => { const B = L0.blocks[r]; const it = { rank: r, pos: i, x: B.x, span: Math.max(1, B.span), f0: acc / tot, f1: (acc + Math.max(1, B.span)) / tot, color: ramp(n0 <= 1 ? 0.5 : i / (n0 - 1)) }; acc += Math.max(1, B.span); return it; });
  return { items, n0 }; }
function miniFrac(mb, x){ for (const it of mb.items){ if (x >= it.x && x <= it.x + it.span) return it.f0 + (x - it.x) / it.span * (it.f1 - it.f0); } let best = null; for (const it of mb.items){ const d = x < it.x ? it.x - x : x - (it.x + it.span); if (best == null || d < best[0]) best = [d, x < it.x ? it.f0 : it.f1]; } return best ? best[1] : null; }
// 今の窓の合意座標の範囲（複数可: 絞り込みは最細ブロックごと）
function currentRanges(){ const w = win(); const L = level();
  if (isSites()){ const S = L.sites; if (!S || !S.nsites) return []; const f = S.sites[0], l = S.sites[S.nsites - 1]; return [[f.x, l.x + Math.max(1, l.bp)]]; }
  if (isBase()){ if (w.range) return [w.range]; let p = w; while (p && p.parent >= 0 && (p.mode === 'base' || p.mode === 'sites')){ const pp = WINS[p.parent]; if (!pp) break; if (pp.mode === 'sites'){ const S = pp.levels[0].sites; const f = S.sites[0], l = S.sites[S.nsites - 1]; return [[f.x, l.x + Math.max(1, l.bp)]]; } if (pp.mode !== 'base'){ const B = pp.levels[0].blocks[p.pblock]; if (B) return [[B.x, B.x + B.span]]; if (p.range) return [p.range]; break; } p = pp; } return w.range ? [w.range] : []; }
  if (st.filter){ const L0 = w.levels[0]; return [...st.filter].map(r => L0.blocks[r]).filter(B => B).map(B => [B.x, B.x + B.span]); }
  if (w.range) return [w.range]; const L0 = w.levels[0]; if (!L0.blocks.length) return []; return [[Math.min(...L0.blocks.map(B => B.x)), Math.max(...L0.blocks.map(B => B.x + B.span))]]; }
function drawMini(){ const c = cv.mini; if (!c) return; const mb = miniBlocks(); if (!mb){ c.style.display = 'none'; return; } c.style.display = '';
  const W = $('mini').clientWidth - 32; const g = sizeCanvas(c, Math.max(50, W), 18); const H = 18;
  for (const it of mb.items){ const x0 = it.f0 * W, x1 = it.f1 * W; g.fillStyle = it.color; g.fillRect(x0, 3, Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)), 11); }
  // 今の窓以外を暗く
  const rs = currentRanges().map(([a, b]) => [miniFrac(mb, a), miniFrac(mb, b)]).filter(r => r[0] != null && r[1] != null);
  const isRoot = st.win === 0 && !st.filter;
  if (!isRoot && rs.length){ const segs = []; for (let [fa, fb] of rs){ if (fa <= fb) segs.push([fa, fb]); else { segs.push([fa, 1]); segs.push([0, fb]); } }
    segs.sort((u, v) => u[0] - v[0]); g.fillStyle = 'rgba(255,255,255,.62)'; let cur = 0; for (const [fa, fb] of segs){ if (fa > cur) g.fillRect(cur * W, 0, (fa - cur) * W, H); cur = Math.max(cur, fb); } if (cur < 1) g.fillRect(cur * W, 0, (1 - cur) * W, H);
    g.strokeStyle = TH.sel; g.lineWidth = 1.5; for (const [fa, fb] of segs) g.strokeRect(fa * W + .5, 1.5, Math.max(2, (fb - fa) * W) - 1, H - 3); }
  // グラフの表示範囲（原子の連なり）を底の線で。濃さ＝見えているノードのうちそこに属する割合（離れた範囲が複数あれば複数本）
  if (st.graphRuns && st.graphRuns.length){ g.fillStyle = TH.accent; for (const r of st.graphRuns){ const fa = miniFrac(mb, r.x0), fb = miniFrac(mb, r.x1); if (fa == null || fb == null) continue; g.globalAlpha = .3 + .7 * r.share; g.fillRect(Math.min(fa, fb) * W, H - 4, Math.max(2, Math.abs(fb - fa) * W), 4); } g.globalAlpha = 1; }
  // 選択ブロックの印（根のとき）
  if (isRoot && st.sel != null && st.li === 0){ const it = mb.items.find(it => it.rank === st.sel); if (it){ g.strokeStyle = TH.sel; g.lineWidth = 1.5; g.strokeRect(it.f0 * W + .5, 1.5, Math.max(2, (it.f1 - it.f0) * W) - 1, H - 3); } }
  c._mb = mb; c._W = W; }
// グラフの表示範囲（連なり）をその広さに合う段で開く: 根に戻ってから drillRange（原子 1 個の内側ならアレル行列／塩基へ）
function openGraphRange(run){ if (!run || st.drilling) return; if (st.win !== 0 || st.li !== 0 || st.filter){ st.win = 0; st.li = 0; st.filter = null; st.filterPath = []; st.sel = null; st.origin = null; st.pinned = false; drawAll(); emitSel(); }
  const x0 = Math.max(0, Math.floor(run.x0)), x1 = Math.max(x0 + 1, Math.ceil(run.x1)); drillRange(x0, x1); }
function graphRunAt(x){ if (!st.graphRuns) return null; return st.graphRuns.find(r => x >= r.x0 && x <= r.x1) || null; }
function miniAt(px){ const c = cv.mini; const mb = c && c._mb; if (!mb) return null; const f = px / Math.max(1, c._W); for (const it of mb.items){ if (f >= it.f0 && f <= it.f1) return { it, x: it.x + (f - it.f0) / Math.max(1e-9, it.f1 - it.f0) * it.span }; } return null; }
let _miniDrag = null;
if (cv.mini){
  cv.mini.addEventListener('mousemove', e => { const r = cv.mini.getBoundingClientRect(); const px = e.clientX - r.left; const m = miniAt(px);
    if (_miniDrag){ _miniDrag.x1 = px; _miniDrag.moved = _miniDrag.moved || Math.abs(px - _miniDrag.x0) > 3; drawMini(); if (_miniDrag.moved){ const g = cv.mini.getContext('2d'); g.fillStyle = TH.selbg; g.fillRect(Math.min(_miniDrag.x0, px), 0, Math.abs(px - _miniDrag.x0), 18); } return; }
    if (m){ let gtxt = ''; if (st.graphRuns && st.graphRuns.length){ const on = st.graphRuns.find(r => m.x >= r.x0 && m.x <= r.x1); const n = st.graphRuns.length; gtxt = on ? `<br>グラフの表示範囲（${n} 本）: この連なり 原子 #${on.a0 + 1}–#${on.a1 + 1}（合意 ${fmtbp(on.x0)}–${fmtbp(on.x1)}）に見えているノードの ${Math.round(on.share * 100)}%。底の線をクリックでこの範囲を開く（ツールバーの「グラフの範囲を開く」は主な 1 本）` : `<br>グラフの表示範囲: ${n} 本（底の線。濃い＝見えているノードの多くが属する。線をクリックでその範囲を開く）`; }
      setHoverInfo(`<p class="k">全体 #${m.it.rank + 1}（合意 ${fmtbp(m.it.x)}–${fmtbp(m.it.x + m.it.span)}）· ここ ${fmtbp(m.x)}。クリックでこのブロックの窓、ドラッグで範囲の窓。${gtxt}</p>`); } });
  cv.mini.addEventListener('mouseleave', () => { if (!_miniDrag) setHoverInfo(''); });
  cv.mini.addEventListener('mousedown', e => { if (e.button !== 0) return; const r = cv.mini.getBoundingClientRect(); _miniDrag = { x0: e.clientX - r.left, x1: e.clientX - r.left, moved: false }; });
  window.addEventListener('mouseup', e => { if (!_miniDrag) return; const d = _miniDrag; _miniDrag = null; const r = cv.mini.getBoundingClientRect(); const px = e.clientX - r.left;
    if (d.moved){ const a = miniAt(Math.min(d.x0, px)), b = miniAt(Math.max(d.x0, px)); drawMini(); if (a && b && b.x > a.x){ if (st.win !== 0){ st.win = 0; st.li = 0; } drillRange(a.x, b.x); } return; }
    const m = miniAt(px); if (!m) return;
    const py = (typeof e.clientY === 'number') ? e.clientY - r.top : 0; const onRun = py >= 18 - 6 ? graphRunAt(m.x) : null; if (onRun){ openGraphRange(onRun); return; }   // 底の線＝グラフの表示範囲 → その範囲を開く
    if (st.win !== 0 || st.li !== 0 || st.filter){ st.win = 0; st.li = 0; st.filter = null; st.filterPath = []; st.sel = null; st.pinned = false; drawAll(); emitSel(); }
    st.sel = m.it.rank; st.pinned = true; drawAll(); emitSel(); drillInto(m.it.rank); });
}
// ---- 遺伝子レーンと破断点×遺伝子（.genes サイドカー）: 窓ごとに各行のコンティグ範囲で取り、w._genes に持つ ----
const GENE_COL = { '+': '#2f9e44', '-': '#e8590c', other: '#868e96' }; const JCLS_COL = { split: '#e03131', isl: '#d6336c', end: '#f08c00', inside: '#868e96', near: '#adb5bd', '': '#adb5bd' };
function genesOn(){ return !!(DATA.meta && DATA.meta.genes && cb && cb.onGenes); }
function ensureGenes(w){ if (!genesOn() || !w || w.mode === 'sites' || w.mode === 'base' || w._genes || w._genesLoading) return; const L0 = w.levels[0]; if (!L0 || !L0.haps) return;
  const ranges = []; for (const hp of L0.haps) for (const ct of hp.contigs){ if (!ct.inst || !ct.inst.length) continue; let lo = Infinity, hi = -Infinity; for (const it of ct.inst){ lo = Math.min(lo, it[6]); hi = Math.max(hi, it[6] + it[2]); } if (hi > lo) ranges.push([ct.path, lo + 1, hi]); }
  if (!ranges.length) return; w._genesLoading = true;
  cb.onGenes(ranges).then(r => { w._genesLoading = false; const m = new Map(); if (r && r.rows) for (const row of r.rows){ if (row.genes) row._starts = row.genes.map(g => g[1]); m.set(row.path, row); } w._genes = m; if (win() === w) drawGrid(); }).catch(() => { w._genesLoading = false; }); }
function ctPath(ct){ return ct ? (ct.path || (ct.c && ct.c.path) || '') : ''; }   // 配置用のコンティグ（c = 元の contig オブジェクト）
function xBp(p, bp){ const it = p.o.it; const f = (bp - it[6]) / Math.max(1, it[2]); return xU(p, dispFrac(p, f)); }
// 色は合意の向きに対する鎖: 逆向きに置かれたインスタンス（dir 0）では GFF の鎖を反転する。同じ遺伝子が行の間で同じ色になり、本当の逆位だけが色違いになる
function relStrand(g, p){ const st_ = g[3]; if (st_ !== '+' && st_ !== '-') return st_; return (p && p.o && p.o.dir === 0) ? (st_ === '+' ? '-' : '+') : st_; }
function geneColor(g, p){ return g[6] ? GENE_COL.other : (g[4] === 'cds' ? (GENE_COL[relStrand(g, p)] || GENE_COL.other) : GENE_COL.other); }
// 行 r の項目 p（インスタンス）に重なる遺伝子を描く。遺伝子が画素より多ければ灰の帯（密度）
function drawGeneLane(g, r, p, y){ const w = win(); const row = w._genes && w._genes.get(ctPath(p.ct)); if (!row) return; const it = p.o.it; const pos = it[6], len = Math.max(1, it[2]); const ly = y + RH - 4, lh = 4;
  const fx = bp => xBp(p, bp);
  if (row.density){ const bin = row.density[0][0]; g.fillStyle = TH.ink; let i0 = 1; { let lo = 1, hi = row.density.length; while (lo < hi){ const mid = (lo + hi) >> 1; if (row.density[mid][0] + bin <= pos + 1) lo = mid + 1; else hi = mid; } i0 = lo; }
    for (let i = i0; i < row.density.length; i++){ const b0 = row.density[i][0], n = row.density[i][1]; if (b0 > pos + len) break; const x0 = fx(Math.max(b0, pos + 1)), x1 = fx(Math.min(b0 + bin, pos + len)); g.globalAlpha = Math.min(.8, .2 + n / (bin / 1000) * .12); g.fillRect(Math.min(x0, x1), ly, Math.max(1, Math.abs(x1 - x0)), lh); } g.globalAlpha = 1; return; }
  const gs = row.genes; if (!gs || !gs.length) return; const st_ = row._starts; let i = 0; { let lo = 0, hi = st_.length; while (lo < hi){ const m = (lo + hi) >> 1; if (st_[m] < pos + 1 - 20000) lo = m + 1; else hi = m; } i = lo; }
  let n = 0; const first = i; for (let k = i; k < gs.length && gs[k][1] <= pos + len; k++){ if (gs[k][2] >= pos + 1) n++; }
  if (n > p.w){ g.fillStyle = TH.ink; g.globalAlpha = .4; g.fillRect(p.x, ly, p.w, lh); g.globalAlpha = 1; return; }
  for (let k = first; k < gs.length && gs[k][1] <= pos + len; k++){ const gg = gs[k]; if (gg[2] < pos + 1) continue; const x0 = fx(Math.max(gg[1] - 1, pos)), x1 = fx(Math.min(gg[2], pos + len)); g.fillStyle = geneColor(gg, p); g.fillRect(Math.min(x0, x1), ly, Math.max(1, Math.abs(x1 - x0)), lh); } }
// 行 r の破断点の印（接合区間の始まり a2 の位置の項目に三角）。r.jmarks にホバー用の位置を残す
function drawJuncMarks(g, r, y){ const w = win(); r.jmarks = []; if (!w._genes) return;
  // 接合区間 [a2, b2] は「インスタンス i の終わり ≤ a2」「b2 ≤ インスタンス j の始まり」なので、通常は項目の隙間に落ちる（根の併合ブロックの中では項目の内側）。
  // 項目の内側ならその位置、隙間なら i の終端（画面上の端。無ければ j の始端）に置く
  const byPath = new Map(); for (const p of r.items){ const a = byPath.get(ctPath(p.ct)) || []; a.push(p); byPath.set(ctPath(p.ct), a); }
  // 混雑の抑制: 弱い分類（近接・丸ごと・遺伝子なし）は、その行の接合が画面幅 10 px あたり 1 件以下のときだけ描く。強い分類（分断・島の挿入点・端）は常に
  let nj = 0; for (const [path] of byPath){ const row = w._genes.get(path); if (row && row.juncs) nj += row.juncs.length; } const sparse = nj <= (cv.grid.clientWidth || 1200) / 10;
  for (const [path, items] of byPath){ const row = w._genes.get(path); if (!row || !row.juncs) continue; items.sort((u, v) => u.o.it[6] - v.o.it[6]);
    for (const j of row.juncs){ const a2 = j[1], b2 = j[2]; const cls = j[4]; if (j[3] === 'abs' && !(cls === 'isl' || cls === 'end')) continue;   // 島の有無は遺伝子に効くときだけ
      if (!sparse && !(cls === 'split' || cls === 'isl' || cls === 'end')) continue;
      let x = null; let pm = null;
      for (const p of items){ const pos = p.o.it[6], len = Math.max(1, p.o.it[2]); if (a2 > pos && a2 < pos + len){ x = xBp(p, a2); pm = p; break; } }
      if (x == null){ let left = null, right = null; for (const p of items){ const pos = p.o.it[6], len = Math.max(1, p.o.it[2]); if (pos + len <= a2 && (!left || pos > left.o.it[6])) left = p; if (pos >= b2 && (!right || pos < right.o.it[6])) right = p; }
        if (left){ x = left.o.dir === 0 ? left.x : left.x + left.w; pm = left; } else if (right){ x = right.o.dir === 0 ? right.x + right.w : right.x; pm = right; } }
      if (x == null) continue;
      const col = JCLS_COL[cls] || JCLS_COL['']; g.fillStyle = col; g.beginPath(); g.moveTo(x - 4, y + 1); g.lineTo(x + 4, y + 1); g.lineTo(x, y + 7); g.closePath(); g.fill(); if (cls === 'split' || cls === 'isl'){ g.strokeStyle = TH.ink; g.lineWidth = .8; g.stroke(); } r.jmarks.push({ x, j, p: pm }); } } }
function geneAt(r, px, py){ const w = win(); if (!w._genes) return null; for (const p of r.items){ if (px < p.x || px > p.x + p.w) continue; const row = w._genes.get(ctPath(p.ct)); if (!row) return null; const it = p.o.it; const pos = it[6], len = Math.max(1, it[2]);
    if (!row.genes){ if (!row.density) return null; const u = uOfX(p, px); let f = u; if (st.mode==='own'){ if (p.ct && p.ct.c && p.ct.c.strand === '-') f = 1 - u; } else if (p.o.dir === 0) f = 1 - u; const bp = pos + f * len; const bin = row.density[0][0]; let n = 0; for (let i = 1; i < row.density.length; i++){ if (row.density[i][0] <= bp && bp < row.density[i][0] + bin){ n = row.density[i][1]; break; } } return { dens: { bp, bin, n, total: row.n }, p, row }; }
    const u = uOfX(p, px); let f = u; if (st.mode==='own'){ if (p.ct && p.ct.c && p.ct.c.strand === '-') f = 1 - u; } else if (p.o.dir === 0) f = 1 - u; const bp = pos + f * len;
    let best = null; for (const gg of row.genes){ if (gg[1] - 1 <= bp + 2 && gg[2] >= bp - 2){ best = gg; break; } if (gg[1] > bp + 2) break; } return best ? { g: best, p, row } : null; } return null; }
function geneInfo(hit){ if (hit.dens){ const d = hit.dens; return `<p><span class="h">遺伝子密度</span> <span class="k">${fmtbp(d.bp)} 付近の ${fmtbp(d.bin)} に ${d.n} 個（この行の範囲に ${(d.total||0).toLocaleString()} 個。多すぎるので個別には出さない。窓を狭めると遺伝子ごとに）· ${esc(ctPath(hit.p.ct))}</span></p>`; }
  const g = hit.g, row = hit.row; const jc = (row.juncs || []).filter(j => j[5] && j[5].includes(g[0])); const JN = { split: '分断', isl: '他株の島の挿入点がこの遺伝子の中', end: '遺伝子の端が接合区間内', inside: '接合区間に丸ごと', near: '近接' };
  return `<p><span class="h">${esc(g[5] || '(無名)')}</span> <span class="k">${esc(g[4])}${g[6] ? '・擬似' : ''} · コンティグ上 ${g[3]} 鎖${(hit.p.o && hit.p.o.dir === 0) ? `（この区間は逆向きに表示: 合意の向きでは ${relStrand(g, hit.p)}）` : ''} · ${g[1].toLocaleString()}–${g[2].toLocaleString()}（${(g[2] - g[1] + 1).toLocaleString()} bp）· ${esc(ctPath(hit.p.ct))}</span>` + (jc.length ? `<br><span class="k">破断点との関係:</span> ${jc.map(j => `${esc(j[3])} ${JN[j[4]] || j[4]}（接合 ${j[1].toLocaleString()}–${j[2].toLocaleString()}）`).join('、')}` : '') + `</p>`; }
function juncInfo(m){ const j = m.j; const JN = { split: '分断', isl: '他株の島の挿入点が遺伝子内', end: '遺伝子の端が接合区間内', inside: '遺伝子が接合区間に丸ごと', near: '近接のみ', '': '遺伝子なし' }; const TN = { inv: '逆位', trans: '転座', del: '欠失（原子を飛ばす）', ins: '挿入', abs: '島の有無' };
  const row = win()._genes.get(ctPath(m.p.ct)); const names = j[7] && j[7].length ? j[7] : (j[5] || []).map(gid => { const gg = row && row.genes ? row.genes.find(x => x[0] === gid) : null; return gg ? gg[5] : ('#' + gid); });
  return `<p><span class="h">破断点 ${TN[j[3]] || j[3]}</span> <span class="k">接合区間 ${j[1].toLocaleString()}–${j[2].toLocaleString()}（${Math.max(0, j[2] - j[1]).toLocaleString()} bp）· ${esc(ctPath(m.p.ct))}</span><br><span class="k">${JN[j[4]] || j[4]}${names.length ? ': ' + esc(names.join(', ')) : ''}${j[6] ? `（関係する遺伝子 ${j[6]}）` : ''}</span></p>`; }
// ---- 列範囲（アレル行列・塩基の窓）の遺伝子: 窓ごとに 1 回取り、hap → genes で持つ ----
function hapPathMap(){ if (!DATA._hapPath){ const m = new Map(); const L0 = DATA.windows[0].levels[0]; for (const h of (L0.haps || [])) for (const c of (h.contigs || [])) if (!m.has(h.hap)) m.set(h.hap, c.path); DATA._hapPath = m; } return DATA._hapPath; }
function ensureGenesCols(w){ if (!genesOn() || !cb.onGenesCols || !w || !(w.mode === 'sites' || w.mode === 'base') || w._gcols || w._gcolsLoading) return; const L0 = w.levels[0]; if (!L0 || L0.c0 == null || L0.c1 == null) return;
  w._gcolsLoading = true; cb.onGenesCols(L0.c0, L0.c1).then(r => { w._gcolsLoading = false; const m = new Map(); if (r && r.rows) for (const row of r.rows){ const a = m.get(row.hap) || []; a.push(...row.genes); m.set(row.hap, a); } w._gcols = m; if (win() === w){ drawGrid(); drawHeader(); } }).catch(() => { w._gcolsLoading = false; }); }
// 列の区間 → x（アレル行列: サイトの並び。塩基: ノードとオフセットで列を特定）
function sitesXOfCols(S, pc0, pc1){ const n = S.nsites; if (!n) return null; let lo = 0, hi = n; while (lo < hi){ const m = (lo + hi) >> 1; if (S.sites[m].c1 < pc0) lo = m + 1; else hi = m; } const k0 = lo; if (k0 >= n || S.sites[k0].c0 > pc1) return null; let k1 = k0; while (k1 + 1 < n && S.sites[k1 + 1].c0 <= pc1) k1++; return [SITES_X0 + k0*LY.siteW, SITES_X0 + (k1 + 1)*LY.siteW, k0, k1]; }
function baseColIndex(M, node, off){ if (!M._nodeOff){ M._nodeOff = new Map(); (M.cols || []).forEach((c, i) => { for (const nm of (c.nodes || [])){ const key = nm + '|' + (c.off != null ? c.off : 0); if (!M._nodeOff.has(key)) M._nodeOff.set(key, i); } }); } let i = M._nodeOff.get(node + '|' + off); if (i == null){ for (let d = 1; d <= 3 && i == null; d++){ i = M._nodeOff.get(node + '|' + (off - d)); if (i == null) i = M._nodeOff.get(node + '|' + (off + d)); } } return i == null ? -1 : i; }
function baseXOfCol(ci){ const items = LY.bitems, xs = LY.bxs; if (!items) return null; for (let k = 0; k < items.length; k++){ const it = items[k]; if (it.kind === 'col' ? it.ci === ci : (ci >= it.ci0 && ci <= it.ci1)) return [xs[k], xs[k+1]]; } return null; }
function geneSpanX(w, g){ const L = w.levels[0];
  if (w.mode === 'sites'){ const S = L.sites; const out = []; const big = g[7].reduce((a, pc) => Math.max(a, pc[1] - pc[0] + 1), 0);
    for (const pc of g[7]){ if (big >= 20 && pc[1] - pc[0] + 1 < 3) continue;   // 主な片があるとき、1〜2 列の飛び（合意順序でずれた私有ノード等）は描かない
      const r = sitesXOfCols(S, pc[0], pc[1]); if (r) out.push([r[0], r[1]]); } return out; }
  if (w.mode === 'base'){ const M = L.base; const i0 = baseColIndex(M, g[8], g[9]), i1 = baseColIndex(M, g[10], g[11]); if (i0 < 0 && i1 < 0) return []; const a = i0 >= 0 ? i0 : 0, b = i1 >= 0 ? i1 : (M.cols.length - 1); const xa = baseXOfCol(Math.min(a, b)), xb = baseXOfCol(Math.max(a, b)); if (!xa || !xb) return []; return [[xa[0], xb[1]]]; }
  return []; }
function drawGeneLanesCols(g){ const w = win(); if (!st.lane || !w._gcols) return; const h = 3;
  LY.rows.forEach((r, ri) => { const gs = w._gcols.get(r.hap); if (!gs) return; const y = ri*RH + RH - h; for (const ge of gs){ for (const [x0, x1] of geneSpanX(w, ge)){ g.fillStyle = geneColor(ge, null); g.fillRect(x0, y, Math.max(1, x1 - x0), h); } } }); }
function drawGeneBandCols(gh, Hh){ const w = win(); if (!st.lane || !w._gcols) return; const L = w.levels[0]; const ref = LY.rows.find(r => r.isref) || LY.rows[0]; if (!ref) return; const gs = w._gcols.get(ref.hap); if (!gs) return;
  const y = Math.max(0, Hh - 10), h = 4;   // 底の錨・variant の印の上に薄く
  for (const ge of gs){ for (const [x0, x1] of geneSpanX(w, ge)){ gh.fillStyle = geneColor(ge, null); gh.globalAlpha = .9; gh.fillRect(x0, y, Math.max(1, x1 - x0), h); gh.globalAlpha = 1;
      if (w.mode === 'base' && ge[3] === 'cds' && x1 - x0 >= 24){ // 読み枠: 開始コドンから 3 塩基ごとの目盛り（鎖の向きに合わせる）
        const M = L.base; const i0 = baseColIndex(M, ge[8], ge[9]); const i1 = baseColIndex(M, ge[10], ge[11]); const from = ge[2] === '-' ? i1 : i0; if (from >= 0){ gh.fillStyle = TH.panel; for (let ci = from; ci >= 0 && ci < M.cols.length; ci += (ge[2] === '-' ? -3 : 3)){ const xr = baseXOfCol(ci); if (!xr) break; if (xr[0] < x0 - 1 || xr[0] > x1 + 1) break; gh.fillRect(xr[0], y, 1, h); } } }
      if (x1 - x0 >= 40 && ge[1]){ gh.fillStyle = TH.ink; gh.font = '9px "IBM Plex Mono"'; gh.textAlign = 'left'; gh.fillText(ge[1], x0 + 2, y - 1); } } } }
function geneAtCols(r, px){ const w = win(); if (!w._gcols) return null; const gs = w._gcols.get(r.hap); if (!gs) return null; for (const ge of gs){ for (const [x0, x1] of geneSpanX(w, ge)){ if (px >= x0 && px <= x1) return ge; } } return null; }
function geneInfoCols(ge, hap){ const JN = { 1: '窓の外から始まる', 2: '窓の外で終わる', 3: '窓の外から始まり外で終わる' }; return `<p><span class="h">${esc(ge[1] || '(無名)')}</span> <span class="k">${esc(ge[3])}${ge[4] ? '・擬似' : ''} · ${ge[2]} 鎖 · ${ge[5].toLocaleString()}–${ge[6].toLocaleString()}（${(ge[6] - ge[5] + 1).toLocaleString()} bp）· ${esc(hap)}${ge[7].length > 1 ? ` · 窓の中で ${ge[7].length} 片に分かれる` : ''}${ge[12] ? ' · ' + JN[ge[12]] : ''}<br>開始 ${esc(ge[8])} +${ge[9]} · 終了 ${esc(ge[10])} +${ge[11]}</span></p>`; }
// ---- 接合カード・一覧 ----
const JTN = { inv: '逆位', trans: '転座', del: '欠失（原子を飛ばす）', ins: '挿入（同じ原子へ戻る）', abs: '島の有無' }; const JCN = { split: '分断', isl: '他株の島の挿入点が遺伝子内', end: '遺伝子の端が接合区間内', inside: '遺伝子が接合区間に丸ごと', near: '近接', '': '遺伝子なし' };
let _juncList = null;
function openJunction(jid){ if (!(cb && cb.onJunction)) return; $('detailbody').innerHTML = `<p class="k">接合 ${jid} を読んでいます…</p>`; st.pinned = true; setDetailWide(true);
  cb.onJunction(jid).then(r => { if (!r || r.error){ setDetail(`<p class="k">接合を読めませんでした: ${esc((r && r.error) || '応答なし')}</p>`); return; } const j = r.junction;
    const bp = j.b2 - j.a2; const genes = r.genes || [];
    let html = `<p><span class="h">接合カード</span> <span class="k">#${j.jid} · ${esc(JTN[j.type] || j.type)} · ${esc(j.hap)}</span><br>` +
      `<span class="k">区間 ${j.a2.toLocaleString()}–${j.b2.toLocaleString()}（${bp.toLocaleString()} bp）· 中身: 多重 ${(j.multi_bp||0).toLocaleString()} bp · 私有 ${(j.priv_bp||0).toLocaleString()} bp · 層 ${j.tier}${j.wrap ? ' · 環状の継ぎ目（コンティグの起点）をまたぐ' : ''}</span><br>` +
      `<span class="k">左 原子 #${j.ai + 1}（${j.di ? '→' : '←'}）→ 右 原子 #${j.aj + 1}（${j.dj ? '→' : '←'}）</span></p>`;
    html += `<p><button class="mono" data-act="goto" data-atom="${j.ai}">原子 #${j.ai + 1} へ</button> <button class="mono" data-act="goto" data-atom="${j.aj}">原子 #${j.aj + 1} へ</button> ${cb.onJunctionBase && cb.onBaseFetch ? `<button data-act="jbase" data-jid="${j.jid}">この接合の塩基を見る</button>` : ''} <button data-act="copy">カードをコピー</button></p>`;
    if (genes.length){ html += `<p><span class="k">関係する遺伝子 ${genes.length}:</span></p><ul>` + genes.map(g => `<li><b>${esc(g.name || '(無名)')}</b> <span class="k">${esc(g.type)}${g.pseudo ? '・擬似' : ''} ${g.strand} ${g.start.toLocaleString()}–${g.end.toLocaleString()} · ${esc(JCN[g.cls] || g.cls)}${g.cls === 'near' ? `（${g.dist.toLocaleString()} bp）` : ` · 左 ${g.left} / 右 ${g.right} / 内 ${g.mid} bp`}${g.product ? ` · ${esc(g.product)}` : ''}</span></li>`).join('') + '</ul>'; }
    else html += '<p class="k">近くに遺伝子はありません。</p>';
    setDetail(html); $('detailbody')._card = { j, genes, html }; }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
function gotoAtom(aid){ const A = DATA.meta.atoms && DATA.meta.atoms[aid]; if (!A) return; if (st.win !== 0 || st.li !== 0 || st.filter){ st.win = 0; st.li = 0; st.filter = null; st.filterPath = []; st.sel = null; st.origin = null; st.pinned = false; drawAll(); emitSel(); } drillRange(A[0], A[0] + Math.max(1, A[1])); }
function openJunctionBase(jid){ if (!(cb && cb.onJunctionBase && cb.onBaseFetch)) return; st.busy = `接合 ${jid} の塩基のトークン範囲を求めています…`; drawGrid();
  cb.onJunctionBase(jid, 60).then(r => { st.busy = null; if (!r || r.error || !r.ranges || !r.ranges.length){ drawAll(); notice(`接合の塩基を出せませんでした: ${esc((r && r.error) || '範囲なし')}`); return; } openBase(r.ranges, r.label || ('接合 ' + jid), -1, null, null, 2000, null); }).catch(e => { st.busy = null; drawAll(); notice(`失敗: ${esc(String(e))}`); }); }
function openJunctionList(){ if (!(cb && cb.onJunctions)) return; st.pinned = true; setDetailWide(true); $('detailbody').innerHTML = '<p class="k">接合の一覧を読んでいます…</p>';
  const go = rows => { _juncList = rows; renderJunctionList(); };
  if (_juncList) go(_juncList); else cb.onJunctions().then(r => { if (!r || r.error || !r.rows){ setDetail(`<p class="k">一覧を読めませんでした: ${esc((r && r.error) || '応答なし')}</p>`); return; } go(r.rows); }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
const JL = { type: '', cls: '', win: true, sort: 'hap' };
function junctionRowsFiltered(){ const w = win(); const L0 = w.levels[0]; let a0 = -1, a1 = -1; if (JL.win && w.mode !== 'sites' && w.mode !== 'base' && L0.blocks && L0.blocks.length && L0.blocks[0].a0 != null && !(st.win === 0 && !st.filter)){ a0 = Math.min(...L0.blocks.map(b => b.a0)); a1 = Math.max(...L0.blocks.map(b => b.a1)); }
  let rows = _juncList.filter(r => (!JL.type || r[3] === JL.type) && (!JL.cls || (JL.cls === 'gene' ? (r[7] === 'split' || r[7] === 'isl' || r[7] === 'end') : r[7] === JL.cls)) && (a0 < 0 || (r[10] >= a0 && r[10] <= a1) || (r[11] >= a0 && r[11] <= a1)));
  const key = JL.sort; const cmp = { hap: (u, v) => (u[2] < v[2] ? -1 : u[2] > v[2] ? 1 : u[4] - v[4]), type: (u, v) => (u[3] < v[3] ? -1 : u[3] > v[3] ? 1 : u[2] < v[2] ? -1 : 1), width: (u, v) => (v[5] - v[4]) - (u[5] - u[4]), cls: (u, v) => (JCLS_ORDER(u[7]) - JCLS_ORDER(v[7])) || (u[2] < v[2] ? -1 : 1), atom: (u, v) => u[10] - v[10] || u[2].localeCompare(v[2]) }[key] || ((u, v) => 0); rows = rows.slice().sort(cmp); return rows; }
function JCLS_ORDER(c){ return { split: 0, isl: 1, end: 2, inside: 3, near: 4 }[c] ?? 5; }
function renderJunctionList(){ const rows = junctionRowsFiltered(); const w = win();
  const sel = (id, opts, cur) => `<select data-jl="${id}">${opts.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
  let html = `<p><span class="h">再編成の接合 一覧</span> <span class="k">${rows.length} / ${_juncList.length} 件</span><br>` +
    `<label><input type="checkbox" data-jl="win"${JL.win ? ' checked' : ''}>今の窓の原子に限る</label> 種類 ${sel('type', [['', '全部'], ['inv', '逆位'], ['trans', '転座'], ['del', '欠失'], ['ins', '挿入'], ['abs', '島の有無']], JL.type)} 遺伝子 ${sel('cls', [['', '全部'], ['gene', '分断・島・端'], ['split', '分断'], ['isl', '島の挿入点'], ['end', '端が接合内'], ['inside', '丸ごと'], ['near', '近接']], JL.cls)} 並び ${sel('sort', [['hap', '株'], ['type', '種類'], ['width', '幅'], ['cls', '遺伝子の関係'], ['atom', '原子']], JL.sort)} <button data-act="tsv">TSV をコピー</button></p>`;
  html += `<div class="jl"><table style="border-collapse:collapse;font-size:11px;width:100%">` + `<tr><th>株</th><th>種類</th><th>区間</th><th>幅</th><th>原子</th><th>遺伝子</th></tr>` +
    rows.slice(0, 500).map(r => `<tr data-jid="${r[0]}" style="cursor:pointer"><td>${esc(r[2])}</td><td>${esc(JTN[r[3]] || r[3])}${r[14] ? '<span class="k">・継ぎ目</span>' : ''}</td><td>${r[4].toLocaleString()}–${r[5].toLocaleString()}</td><td style="text-align:right">${(r[5] - r[4]).toLocaleString()}</td><td>#${r[10] + 1}${r[12] ? '→' : '←'} #${r[11] + 1}${r[13] ? '→' : '←'}</td><td><span style="color:${JCLS_COL[r[7]] || JCLS_COL['']}">●</span> ${esc(JCN[r[7]] || r[7])}${r[9] && r[9].length ? ': ' + esc(r[9].join(', ')) : ''}${r[8] > (r[9] ? r[9].length : 0) ? `（他 ${r[8] - (r[9] ? r[9].length : 0)}）` : ''}</td></tr>`).join('') + `</table>${rows.length > 500 ? '<p class="k">先頭 500 件だけ表示（TSV は全部）</p>' : ''}</div>`;
  setDetail(html); $('detailbody')._list = rows; }
function junctionTsv(rows){ const head = ['jid', 'hap', 'type', 'seam', 'a2', 'b2', 'width', 'tier', 'atom_i', 'dir_i', 'atom_j', 'dir_j', 'gene_class', 'n_related', 'genes']; return [head.join('\t')].concat(rows.map(r => [r[0], r[2], r[3], r[14] ? 1 : 0, r[4], r[5], r[5] - r[4], r[6], r[10] + 1, r[12] ? '+' : '-', r[11] + 1, r[13] ? '+' : '-', r[7] || 'none', r[8], (r[9] || []).join(';')].join('\t'))).join('\n'); }
function copyPlain(text, label){ const t = $('tip'); const done = () => { setHoverInfo(`<p class="copied">${esc(label || 'コピーしました')}</p>`); setTimeout(() => { if (_tipSrc === '') setHoverInfo(''); }, 900); }; try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); else fallbackCopy(text, done); } catch (e) { fallbackCopy(text, done); } }
function drawAllCore(){ _gdMax = null; computeLayout(); if (isSites()) sitesLayout(); if (isBase()) baseLayout(); layoutCanvases(); drawHeader(); drawGrid(); drawLabels(); drawTree(); drawChips(); drawLegend(); updateButtons(); drawMini(); emitView(); }
function drawAll(){ const nrows = buildRows().length; const tgt = targetRH(nrows);
  if (tgt === RH){ if (_rhAnim){ cancelAnimationFrame(_rhAnim); _rhAnim = null; } drawAllCore(); return; }
  const reduce = (typeof matchMedia === 'function') && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof requestAnimationFrame !== 'function'){ RH = tgt; drawAllCore(); return; }
  drawAllCore();   // まず今の高さで同期的に描く（状態を一貫させる）。高さだけを続くフレームで寄せる
  const from = RH, t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); if (_rhAnim) cancelAnimationFrame(_rhAnim);
  const step = () => { const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()); const f = Math.min(1, (now - t0) / 150); const e = f < 1 ? 1 - Math.pow(1 - f, 2) : 1;
    RH = Math.round(from + (tgt - from) * e); drawAllCore(); if (f < 1) _rhAnim = requestAnimationFrame(step); else { _rhAnim = null; RH = tgt; drawAllCore(); } };
  _rhAnim = requestAnimationFrame(step); }
// 窓・段（＝色の割り当て）が変わったときだけ、見えているブロックと色を App へ知らせる（グラフのノードをブロック色で塗る）
let _lastViewKey = '';
// 合意座標の範囲 [a, b] に重なる原子の番号の範囲（原子は合意座標順）。無ければ null
// 原子の内側の窓（アレル行列・塩基）の列範囲。塩基の窓は c0/c1 を持つ（入れ子は親から）
function colsSelOf(w){ let p = w; for (let i = 0; i < 8 && p; i++){ const L0 = p.levels && p.levels[0]; if (L0 && L0.c0 != null && L0.c1 != null) return { cols: [L0.c0, L0.c1] };   // 塩基もアレル行列も列範囲は levels[0] に持つ（入れ子の塩基は null → 親へ）
  p = p.parent >= 0 ? WINS[p.parent] : null; } return null; }
function atomsOverlapping(xr){ if (!xr || !DATA.meta.atoms) return null; const A = DATA.meta.atoms; let lo = -1, hi = -1; for (let i = 0; i < A.length; i++){ const x0 = A[i][0], x1 = x0 + Math.max(1, A[i][1]); if (x1 > xr[0] && x0 < xr[1]){ if (lo < 0) lo = i; hi = i; } } return lo < 0 ? null : [lo, hi]; }
function emitView(){ if (!(cb && cb.onView)) return; const L = level(); const key = st.win+':'+st.li+':'+LY.vis.join(',')+':'+(st.sync?1:0)+':'+(st.gfilter?1:0);
  if (key === _lastViewKey) return; _lastViewKey = key;
  if (isBase()){ const M = L.base; const rbs = (M.cols || []).map(c => c.rb).filter(v => v != null); const refc = L.refc != null ? L.refc : 0; const x0 = rbs.length ? Math.min(...rbs) : 0, x1 = rbs.length ? Math.max(...rbs) + 1 : 1;
    const xr = TREE ? (win().range || currentRanges()[0] || null) : null;   // 木: 窓の合意座標の範囲（選んだ範囲。無ければ親から）→ ミニマップとスーパーノードの塗り
    const names = TREE ? [...new Set((M.cols || []).flatMap(c => c.nodes || []))] : null;   // MSA に出ている葉ノード: グラフは葉の層でこれだけを塗る
    cb.onView({ win: st.win, level: st.li, W: 0, mode: 'base', tree: TREE, scope: rbs.length ? { contig: refc, start: x0, end: x1 } : null, scopeKey: st.win + '|base', sync: st.sync, n0: 0, xRange: xr, atomsIn: atomsOverlapping(xr), nodeNames: names, filterGraph: st.gfilter, filterRange: xr, filterSel: colsSelOf(win()),
      blocks: rbs.length ? [{ rank: 0, color: 'rgb(13,148,136)', ref_contig: refc, x: x0, span: Math.max(1, x1 - x0), label: win().label, members: [] }] : [{ rank: 0, color: 'rgb(13,148,136)', ref_contig: refc, x: 0, span: 1, label: win().label, members: [] }] }); return; }
  if (isSites()){ const S = L.sites; const f = S.sites[0], l = S.sites[S.nsites-1]; const x0 = f.x, x1 = l.x + Math.max(1, l.bp); const refc = L.refc!=null ? L.refc : 0;
    const xr = TREE ? [x0, x1] : null;
    cb.onView({ win: st.win, level: st.li, W: 0, mode: 'sites', tree: TREE, scope: { contig: refc, start: x0, end: x1 }, scopeKey: st.win + '|sites', sync: st.sync, n0: 0, xRange: xr, atomsIn: atomsOverlapping(xr), filterGraph: st.gfilter, filterRange: xr, filterSel: (L.c0 != null && L.c1 != null) ? { cols: [L.c0, L.c1] } : colsSelOf(win()),
      blocks: [{ rank: 0, color: L.pcolor || 'rgb(13,148,136)', ref_contig: refc, x: x0, span: Math.max(1, x1 - x0), label: win().label, members: [] }] }); return; }
  // 範囲 = 見えているブロックの参照区間の合併（最多のコンティグ）。窓・絞り込みが変わったときだけ scopeKey が変わる
  const byC = new Map(); for (const rank of LY.vis){ const B = L.blocks[rank]; const c = (B.ref_contig!=null ? B.ref_contig : 0); const g = byC.get(c) || {n:0, lo:Infinity, hi:-Infinity}; g.n++; const lo_ = (B.rx0 != null ? B.rx0 : B.x), hi_ = (B.rx1 != null ? B.rx1 : B.x + B.span); g.lo = Math.min(g.lo, lo_); g.hi = Math.max(g.hi, hi_); byC.set(c, g); }
  let scope = null; for (const [c,g] of byC){ if (!scope || g.n > scope.n){ scope = {contig:c, start:g.lo, end:g.hi, n:g.n}; } }
  const scopeKey = st.win + '|' + (st.filter ? [...st.filter].sort((a,b)=>a-b).join(',') : '');
  cb.onView({ filterGraph: st.gfilter, filterRange: (TREE && LY.vis.length && !(st.win === 0 && !st.filter)) ? [Math.min(...LY.vis.map(r => L.blocks[r].x)), Math.max(...LY.vis.map(r => L.blocks[r].x + Math.max(1, L.blocks[r].span)))] : null, filterSel: (TREE && LY.vis.length && !(st.win === 0 && !st.filter) && L.blocks[LY.vis[0]].a0 != null) ? { atoms: [Math.min(...LY.vis.map(r => L.blocks[r].a0)), Math.max(...LY.vis.map(r => L.blocks[r].a1))] } : null,  win: st.win, level: st.li, W: L.W, mode: L.mode||'blocks', tree: TREE, scope: scope ? {contig:scope.contig, start:scope.start, end:scope.end} : null, scopeKey, sync: st.sync, n0: win().levels[0].nblocks,
    blocks: LY.vis.map(rank => { const B = L.blocks[rank]; return { rank, color: colorOf(rank), ref_contig: (B.ref_contig!=null ? B.ref_contig : 0), x: (B.rx0 != null ? B.rx0 : B.x), span: (B.rx1 != null ? Math.max(1, B.rx1 - B.rx0) : B.span), label: '#'+(rank+1), members: membersOf(L, rank), a0: B.a0, a1: B.a1 }; }) }); }
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
// 長い隙間を畳んだ矢印: 配列の部品は保存度プロファイルの断片（向きの先端は末端の部品だけ）、隙間の部品は斜線の箱に長さ
function foldedArrow(g, p, o, yy, hh, col, hapIdx){ const flipS = p.ct && p.ct.c && p.ct.c.strand === '-'; const NB = 255; const hFull = profileHeights(o, false, NB, hapIdx, null, flipS);
  const parts = p.parts; const last = parts.length - 1;
  for (let i=0;i<=last;i++){ const q = parts[i];
    if (q.fold){ g.save(); g.beginPath(); g.rect(q.x, yy, q.w, hh); g.clip(); g.fillStyle = TH.panel; g.fillRect(q.x, yy, q.w, hh); g.strokeStyle = TH.rep; g.lineWidth = 1; g.beginPath(); for (let t=-hh; t<q.w+hh; t+=4){ g.moveTo(q.x+t, yy+hh); g.lineTo(q.x+t+hh, yy); } g.stroke(); g.restore();
      g.strokeStyle = TH.rep; g.lineWidth = 1; g.strokeRect(q.x+.5, yy+.5, q.w-1, hh-1);
      if (hh >= 10){ g.fillStyle = TH.ink; g.font = '8px "IBM Plex Mono"'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(fmtShort(q.bp), q.x + q.w/2, yy + hh/2); } continue; }
    const headR = o.dir && i === last, headL = !o.dir && i === 0; const hd = Math.min(6, Math.max(2, q.w*0.35));
    g.save(); g.beginPath();
    if (headR){ g.moveTo(q.x,yy); g.lineTo(q.x+q.w-hd,yy); g.lineTo(q.x+q.w,yy+hh/2); g.lineTo(q.x+q.w-hd,yy+hh); g.lineTo(q.x,yy+hh); }
    else if (headL){ g.moveTo(q.x+q.w,yy); g.lineTo(q.x+hd,yy); g.lineTo(q.x,yy+hh/2); g.lineTo(q.x+hd,yy+hh); g.lineTo(q.x+q.w,yy+hh); }
    else g.rect(q.x, yy, q.w, hh);
    g.closePath(); g.clip();
    g.fillStyle = TH.panel; g.fillRect(q.x, yy, q.w, hh); g.fillStyle = col; g.fillRect(q.x, yy, q.w, 2.5);
    const inner = Math.max(1, q.w-2); const nb = Math.max(1, Math.min(NB, Math.floor(inner/2))); const bw = inner/nb; g.globalAlpha = .5;
    if (!hFull) g.fillRect(q.x, yy+2.5, q.w, hh-2.5);
    else for (let b=0;b<nb;b++){ const b0 = Math.floor((q.u0 + (q.u1-q.u0)*b/nb)*NB), b1 = Math.max(b0+1, Math.floor((q.u0 + (q.u1-q.u0)*(b+1)/nb)*NB)); let m=0, n=0; for (let k=b0;k<b1 && k<NB;k++){ m += hFull[k]; n++; } const hv = n ? m/n : 1; const hp = Math.max(1, Math.round(hv*(hh-3))); g.fillRect(q.x+1+b*bw, yy+hh-hp, bw+0.6, hp); }
    g.globalAlpha = 1;
    if (headR || headL){ g.fillStyle = shade(col, 0.72); g.beginPath(); if (headR){ g.moveTo(q.x+q.w-hd, yy); g.lineTo(q.x+q.w, yy+hh/2); g.lineTo(q.x+q.w-hd, yy+hh); } else { g.moveTo(q.x+hd, yy); g.lineTo(q.x, yy+hh/2); g.lineTo(q.x+hd, yy+hh); } g.closePath(); g.fill(); }
    g.restore();
    g.beginPath(); if (headR){ g.moveTo(q.x,yy); g.lineTo(q.x+q.w-hd,yy); g.lineTo(q.x+q.w,yy+hh/2); g.lineTo(q.x+q.w-hd,yy+hh); g.lineTo(q.x,yy+hh); } else if (headL){ g.moveTo(q.x+q.w,yy); g.lineTo(q.x+hd,yy); g.lineTo(q.x,yy+hh/2); g.lineTo(q.x+hd,yy+hh); g.lineTo(q.x+q.w,yy+hh); } else g.rect(q.x, yy, q.w, hh);
    g.closePath(); g.strokeStyle = shade(col, 0.72); g.globalAlpha = .95; g.lineWidth = 1.1; g.stroke(); g.globalAlpha = 1; } }
function fmtShort(bp){ return bp >= 1e6 ? (bp/1e6).toFixed(1)+'M' : bp >= 1e3 ? Math.round(bp/1e3)+'k' : String(bp); }
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
const FOLD_PX = 40, FOLD_W = 12; let _sOwn = 1;   // 各行の並び: 隙間の描画幅がこれを超えたら畳む／畳んだ幅
// インスタンス o の表示割合 u（0..1、'-' 鎖のコンティグは反転済み）での部品: 配列（seq）と畳んだ隙間（fold）。畳む隙間が無ければ null
function ownFoldPlan(o, p_extra, s, flipS){ const it = o.it; const bp = it[2]||0; const gaps = (it.length>14 && it[14]) ? it[14] : []; if (!gaps.length || bp <= 0) return null;
  const folds = []; gaps.forEach((gp, gi) => { if (gp[2]*s > FOLD_PX){ let a = gp[0]/255, b = gp[1]/255; if (flipS){ const t = a; a = 1-b; b = 1-t; } if (b > a) folds.push([a, b, gp[2], gi]); } });
  if (!folds.length) return null; folds.sort((x,y)=>x[0]-y[0]);
  const parts = []; let cur = 0; const fset = new Set();
  for (const [a,b,gbp,gi] of folds){ if (a > cur + 1e-6) parts.push({ u0:cur, u1:a, fold:false, w: Math.max(1, (a-cur)*bp*s) }); parts.push({ u0:a, u1:b, fold:true, bp:gbp, w: FOLD_W }); cur = b; fset.add(gi); }
  if (cur < 1 - 1e-6) parts.push({ u0:cur, u1:1, fold:false, w: Math.max(1, (1-cur)*bp*s) });
  p_extra.folded = fset; return parts; }
// 表示割合 u → x。畳みがあれば部品を通す（畳んだ隙間の中は 12 px に圧縮）。無ければ線形
function xU(p, u){ u = Math.max(0, Math.min(1, u)); const parts = p.parts; if (!parts || parts.length <= 1) return p.x + u*p.w;
  for (let i=0;i<parts.length;i++){ const q = parts[i]; if (u <= q.u1 + 1e-9 || i === parts.length-1){ const t = Math.max(0, Math.min(1, (u - q.u0)/Math.max(1e-9, q.u1 - q.u0))); return q.x + t*q.w; } } return p.x; }
function uOfX(p, x){ const parts = p.parts; if (!parts || parts.length <= 1) return Math.max(0, Math.min(1, (x - p.x)/Math.max(1, p.w)));
  for (const q of parts){ if (x <= q.x + q.w || q === parts[parts.length-1]) return q.u0 + Math.max(0, Math.min(1, (x - q.x)/Math.max(1e-9, q.w)))*(q.u1 - q.u0); } return 0; }
// インスタンス内の bp 割合 f（コンティグ順）→ 表示割合 u: 各行の並びは '-' 鎖のコンティグで反転、合意座標は逆向き（dir 0）で反転
function dispFrac(p, f){ f = Math.max(0, Math.min(1, f)); if (st.mode==='own') return (p.ct && p.ct.c && p.ct.c.strand === '-') ? 1-f : f; return p.o.dir === 0 ? 1-f : f; }
function foldPartAt(p, x){ const parts = p.parts; if (!parts) return null; for (const q of parts){ if (q.fold && x >= q.x && x <= q.x + q.w) return q; } return null; }
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
      else { const it = p.o.it; let rel = Math.max(0, Math.min(1, (A.bp[k] - it[6]) / Math.max(1, it[2]))); if (flip) rel = 1 - rel; x = xU(p, rel); }
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
// 遺伝子レーンと三角はホバーのたびに描き直すと重い（根: 50 行 × 39 項目 × 2,000 ビン）。配置が変わらない間は裏キャンバスに 1 回描いて貼る
let _laneCache = null;   // { key, canvas }
function laneKey(){ const w = win(); return [st.win, st.li, st.mode, st.filter ? [...st.filter].join('.') : '', Math.round(LY.fullW || 0), RH, st.lane ? 1 : 0, st.jmark ? 1 : 0, w._genes ? 1 : 0, cv.grid.clientWidth, cv.grid.clientHeight].join('|'); }
function drawLanesCached(){ const key = laneKey(); const g = cv.grid.getContext('2d');
  if (!_laneCache || _laneCache.key !== key){ const c = document.createElement('canvas'); c.width = cv.grid.width; c.height = cv.grid.height; const gg = c.getContext('2d'); const dpr = cv.grid.width / Math.max(1, cv.grid.clientWidth); gg.scale(dpr, dpr);
    LY.rows.forEach((r, ri) => { const y = ri*RH; if (st.lane) for (const p of r.items) drawGeneLane(gg, r, p, y); if (st.jmark) drawJuncMarks(gg, r, y); else r.jmarks = []; });
    _laneCache = { key, canvas: c, jmarks: LY.rows.map(r => r.jmarks || []) }; }
  else LY.rows.forEach((r, ri) => { r.jmarks = _laneCache.jmarks[ri] || []; });   // 配置オブジェクトが作り直されていてもホバー用の位置を戻す
  g.drawImage(_laneCache.canvas, 0, 0, cv.grid.clientWidth, cv.grid.clientHeight); }
function drawGrid(){ drawGridBase(); if (!isSites() && !isBase() && genesOn()) drawLanesCached(); if (isSites()) drawSitesGrid(); if (isBase()){ drawBaseGrid(); if (genesOn()){ ensureGenesCols(win()); drawGeneLanesCols(cv.grid.getContext('2d')); } } drawBusy(); }
// 計算中の帯は、どの段の描画よりも後に、画面に見えている範囲（横スクロール位置）に重ねる
function drawBusy(){ if (!st.busy) return; const g = cv.grid.getContext('2d'); const W = cv.grid.clientWidth, H = cv.grid.clientHeight; const sx = $('body').scrollLeft || 0, vw = $('gridwrap').clientWidth || W;
  g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(0, 0, W, H); g.fillStyle = TH.sel; g.fillRect(sx, 0, Math.min(vw, W - sx), 26); g.fillStyle = '#fff'; g.font = '600 12px "IBM Plex Sans", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('計算中: ' + st.busy, sx + 10, 13); g.textBaseline = 'alphabetic'; }
function drawGridBase(){
  const g = cv.grid.getContext('2d'); const W = cv.grid.clientWidth, H = cv.grid.clientHeight; g.clearRect(0,0,W,H);
  if (st.sel!=null && LY.blockX.has(st.sel)){ const c = LY.blockX.get(st.sel); g.fillStyle = TH.selbg; g.fillRect(c.x, 0, c.w, H); }
  LY.rows.forEach((r,ri)=>{ const y = ri*RH;
    if (r.isref){ g.fillStyle = TH.ref; g.globalAlpha=.6; g.fillRect(0,y,W,RH); g.globalAlpha=1; }
    if (st.hover && st.hover.ri===ri){ g.fillStyle = TH.hover; g.fillRect(0,y,W,RH); }
    g.fillStyle = TH.line2; g.fillRect(0,y+RH-1,W,1);
  });
  drawLinks(g);                                   // 連結線はブロックの下に
  if (genesOn()) ensureGenes(win());
  LY.rows.forEach((r,ri)=>{ const y = ri*RH;
    const laneOf = p => (st.mode==='own') ? 0 : p.slot.lane; const yTop = l => l===0 ? y+4 : y+17; const hOf = l => l===0 ? 12 : 9;
    for (const p of r.items){ const o = p.o; const lane = laneOf(p); const yy = yTop(lane), hh = hOf(lane);
      const inSeg = p.seg && p.seg.items.length>1 && o.kind<4;
      const cons = st.mode!=='own' && o.kind<4 && o.it.length>20 && p.w>=6;     // 合意座標モード: ブロック内の差異を合意座標で描く
      const inner0 = Math.max(1, p.w-2); const XC = (o.kind<4 && (p.col || p.ext)) ? (c => xInInstance(p, c/255)) : (c => p.x+1+Math.max(0,Math.min(255,c))/255*inner0);
      if (o.kind===5) arrow(g, p.x, yy, p.w, hh, o.dir, null, false, true);
      else if (o.kind===4) arrow(g, p.x, yy, p.w, hh, o.dir, TH.rep, true, false);
      else if (st.mode==='own' && p.parts && p.parts.length > 1) foldedArrow(g, p, o, yy, hh, colorOf(o.rank), r.hapIdx);   // 長い隙間を畳んだ矢印
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
        for (const [gi_, gp] of o.it[14].entries()){ if (p.folded && p.folded.has(gi_)) continue; const useC = cons && gp.length>3; const wI = Math.max(3, Math.min(12, gp[2]*LY.s));
          const flipS = p.ct && p.ct.c && p.ct.c.strand === '-'; const g0 = flipS ? 255-gp[1] : gp[0], g1 = flipS ? 255-gp[0] : gp[1];   // 通過内座標は鎖で左右反転
          const x0 = useC ? Math.max(p.x+1, Math.min(p.x+p.w-1-wI, XC(gp[3]))) : xU(p, g0/255), x1 = useC ? x0+wI : xU(p, g1/255); g.save(); g.beginPath(); g.rect(x0, yy, Math.max(2, x1-x0), hh); g.clip();
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
const CORNER_TXT = { blocks: 'ハプロタイプ ↓ · 列見出しをドラッグ＝範囲の窓', sites: '上段: 変異サイト（列）。ドラッグ＝狭い区間（葉 400 以下で塩基）', base: '上段: ノードの箱（名前 · 長さ bp。上の青緑線＝同じサイトの排他アレルを 1 列に重ねた群）· 下段: 比較の基準の配列' };
function setCorner(mode){ const c = $('corner'); if (!c) return; const sp = c.querySelector('span'); if (sp && sp.textContent !== CORNER_TXT[mode]) sp.textContent = CORNER_TXT[mode]; }
function drawHeader(){ if (isSites()){ setCorner('sites'); drawSitesHeader(); if (genesOn()) drawGeneBandCols(cv.hdr.getContext('2d'), cv.hdr.clientHeight); drawMarks(); return; } if (isBase()){ setCorner('base'); drawBaseHeader(); if (genesOn()) drawGeneBandCols(cv.hdr.getContext('2d'), cv.hdr.clientHeight); return; } setCorner('blocks'); drawHeaderBase(); drawMarks(); }
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
  LY.rows.forEach((r,ri)=>{ const d = document.createElement('div'); d.className = 'lab' + (r.isref?' ref':'') + ((st.hover&&st.hover.ri===ri)?' hov':''); d.style.top = (ri*RH)+'px'; d.style.height = RH+'px'; if (RH < 20) d.style.fontSize = '10px';
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
function drawChips(){ const L = level(); if (isBase()){ const M = L.base; const cmp = baseCmpSeq(M); $('chips').innerHTML = `<span class="chip">窓 <b>${esc(win().label)}</b> · 塩基の段</span><span class="chip">列 <b>${M.cols.length}</b> · ノード <b>${LY.bgroups ? LY.bgroups.length : 0}</b></span><span class="chip">行 <b>${LY.rows.length}</b></span><span class="chip">比較の基準 <b>${esc(cmp.label)}</b>（列見出しの下段）</span>`; $('origingrp').style.display = 'none'; $('ladder').innerHTML = ''; $('scopetxt').textContent = `塩基 · 列 ${M.cols.length}`; return; } if (isSites()){ const S = L.sites; const ncol = L.c1 - L.c0 + 1; $('chips').innerHTML = `<span class="chip">窓 <b>${esc(win().label)}</b> · 変異の段${S.binned ? `（粗い: ${S.sitesPerBin} サイト/ビン）` : ''}</span><span class="chip">変異サイト <b>${S.binned ? S.totalSites.toLocaleString() : S.nsites}</b></span><span class="chip">列 <b>${ncol}</b>${ncol <= BASE_MAX_LEAVES ? ' · 塩基へ渡せます' : ` · 塩基へは ${BASE_MAX_LEAVES} 以下`}</span><span class="chip">被覆 <b>${S.ncover}</b> 株 · 行 <b>${LY.rows.length}</b></span>`; $('origingrp').style.display = 'none'; const ld = $('ladder'); ld.innerHTML = ''; $('scopetxt').textContent = `変異サイト ${S.nsites} · 列 ${ncol}`; return; } let inv=0, disp=0, rep=0, small=0; for (const r of LY.rows) for (const p of r.items){ const k=p.o.kind; if (k===3) inv++; else if (k===2) disp++; else if (k===4) rep++; else if (k===5) small++; }
  $('chips').innerHTML = `<span class="chip">窓 <b>${st.win===0?"全体":esc(win().label)}</b>${(level().mode==='bins')?' · <b>座標分割</b>（再編成なし・等分）':''} · ${level().mode==='bins'?'錨':'原子区間'} ${win().atoms.toLocaleString()} · 深さ ${win().depth}${win().composed?` · <b>継ぎ合わせ</b>`:(win().ondemand?` · <b>逐次計算</b>${win().ms?' '+win().ms+' ms':''}`:'')}</span><span class="chip">${TREE ? '境界の持続度' : (L.mode==='bins'?'ビン幅':'段の幅')} <b>${TREE && !L.W ? '全部' : fmtbp(L.W)}${TREE && L.W ? ' 以上' : ''}</b></span><span class="chip">ブロック <b>${LY.vis.length}</b></span><span class="chip">行 <b>${LY.rows.length}</b></span><span class="chip">逆位 <b>${inv}</b> 変位 <b>${disp}</b> 小群 ${small}</span><span class="chip">${L.members?`最細段の併合 <b>${L.merges||0}</b> 回`:`併合の上限 <b>${L.mergecap||0}</b> 株`}${L.nonmono?` · 内部順序ずれ ${L.nonmono}`:''}</span>${st.filter?`<span class="chip">絞り込み <b>${st.filter.size}</b> / ${win().levels[0].nblocks}</span>`:''}${st.anc && anchorsOf(win())?`<span class="chip">錨の対応線 <b>${anchorsOf(win()).m}</b> 本/行${st.anc2 && anchorsOf(win()).m2?` · 第二錨 <b>${anchorsOf(win()).m2}</b>`:''}</span>`:''}`;
  const ld = $('ladder'); ld.innerHTML=''; win().levels.forEach((lv,i)=>{ const b=document.createElement('button'); b.className='mono'; b.textContent = TREE ? (lv.nblocks+' ブロック') : (fmtbp(lv.W)+' ('+lv.nblocks+')'); if (TREE) b.title = lv.W ? ('境界の持続度 '+fmtbp(lv.W)+' 以上を残した段') : '範囲内の境界を全部残した段'; b.setAttribute('aria-pressed', i===st.li?'true':'false'); b.addEventListener('click',()=>{ st.li=i; st.sel=null; st.origin=null; st.pinned=false; drawAll(); emitSel(); }); ld.appendChild(b); });
  $('origingrp').style.display = (DATA.meta.circular && st.win===0) ? '' : 'none';
  $('origintxt').textContent = DATA.meta.circular ? `#${originRank()+1}${st.origin==null?'（自動）':''}` : '';
  $('scopetxt').textContent = (win().parent>=0 ? `親 ${win().pblock>=0?'#'+(win().pblock+1):'区間'}${win().pW && !TREE?`（段 ${fmtbp(win().pW)}）`:''} の内側 · ` : '') + (TREE ? `${level().nblocks} ブロック` : `段 ${fmtbp(level().W)}`) + (st.filter ? ` · 絞り込み ${st.filterPath.map(e=>e.label).join('›')}（最細 ${st.filter.size} ブロック）` : '');
}
function childKey(rank){ return String(rank); }   // 子窓の鍵（最細段の rank）。粗い段のブロックは絞り込み表示で、子窓は作らない
// 塩基レベルへ渡せるか: 列（葉ノード）が bubble MSA の上限 400 以下と見込めるブロック（典型長 / bp/token）
const BASE_MAX_LEAVES = 400; const BASE_IDENT_MAX = 2000; const BASE_FEW_SITES = 20;
function baseCols(rank){ const B = level().blocks[rank]; if (!B) return Infinity; return B.tbp / Math.max(1, DATA.meta.bpt || 1); }
function canBase(rank){ if (TREE){ const B = level().blocks[rank]; return !!B && st.li===0 && !!(cb && (cb.onBaseFetch || cb.onBaseMsa)) && (B.c1 - B.c0 + 1) <= BASE_MAX_LEAVES; } return st.li===0 && !!(cb && cb.onBaseMsa) && baseCols(rank) <= BASE_MAX_LEAVES; }
function canDrill(rank){ const L = level(); const B = L.blocks[rank]; if (!B) return false; if (TREE) return (B.atoms==null || B.atoms>=2); return L.mode==='bins' ? (B.atoms==null || B.atoms>=2) : true; }
function updateButtons(){ const w=win(); if (!st.pinned && st.detailWide) setDetailWide(false); { const jb = $('junclist'); if (jb) jb.disabled = !(genesOn() && cb && cb.onJunctions); } { const gr = $('graphrange'); if (gr){ const n = st.graphRuns ? st.graphRuns.length : 0; gr.disabled = !n || st.drilling; gr.textContent = n > 1 ? `グラフの範囲を開く (${n} 本の主)` : 'グラフの範囲を開く'; } } $('basegrp').style.display = isBase() ? '' : 'none'; if (isBase()){ $('scopein').disabled = true; $('scopein').textContent = '選択ブロックの内側へ →'; $('base').disabled = true; $('base').title = 'ここが木の底（塩基）です'; $('scopeout').disabled = !(w.parent>=0); $('setorigin').disabled = true; return; } if (isSites()){ const L = level(); const ncol = L.c1 - L.c0 + 1; $('scopein').disabled = true; $('scopein').textContent = '選択ブロックの内側へ →'; $('base').disabled = !(cb && cb.onBaseMsa && ncol <= BASE_MAX_LEAVES); $('base').title = ncol <= BASE_MAX_LEAVES ? `この窓（列 ${ncol}）を塩基レベル MSA へ` : `列 ${ncol} は上限 ${BASE_MAX_LEAVES} を超えます。列見出しをドラッグして狭い区間を選ぶと渡せます`; $('scopeout').disabled = !(w.parent>=0); $('setorigin').disabled = true; return; }
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
  if (genesOn()){ const sl=document.createElement('span'); sl.textContent=(st.lane ? '行の底＝その株の遺伝子（緑 + 鎖、橙 − 鎖。鎖は合意の向きに対して＝逆向きの区間では反転、灰 擬似・RNA・反復。画素より多い所は灰の帯）' : '') + (st.jmark ? '　行の上の三角＝破断点×遺伝子（赤 分断、桃 他株の島の挿入点が遺伝子内、橙 端が接合内、灰 遺伝子なし）' : ''); el.appendChild(sl); }
  const mname = {minor:'少数派サイト密度（半数未満のハプロだけが持つノードを含む区間 / kb）', priv:'私有サイト密度（この株だけが持つノードを含む区間 / kb）', nonanc:'錨でない bp の割合'}[st.measure];
  const nname = {abs:'層内の百分位で灰色の濃さ（濃い＝多い）', block:'そのブロックの全株の中央値との比。青＝少ない、赤＝多い（±4 倍で飽和）', hap:'その株の全ブロックの中央値との比。青＝少ない、赤＝多い（±4 倍で飽和）'}[st.norm];
  for (const t of ['行はそのハプロタイプのブロック順。合意と揃う主鎖は上段で列に揃え（幅＝典型長）、外れたブロックは下段に、前後の主鎖の間へ順に置く。隙間に入らない長い連なりは右へはみ出し、横スクロールで見る。逆位は左向き＋下線' + (st.mode==='own' && st.foldGap ? '。各行の並びでは 40 px を超える錨の無い配列（斜線）を 12 px に畳み、長さを書く（⋯48k）' : ''), `矢印の中の塗り＝Mauve 風の類似度プロファイル。高さが保存度（この層の典型密度の 2 倍以上で 0、変異なしで満杯）。尺度が「${mname}」。少数派サイトは位置ごとの山型、他の尺度は一定の高さ。${nname}`,'合意座標モードでは矢印の幅＝ブロックの合意座標。白い切れ目＝この株に合意の錨が無い区間（欠失・分岐・断片の外側。ブロック幅の 1% か 200 bp 以上）、点線の縁＝コンティグの端で切れている、変異の線は合意座標に揃う','灰色の縞＝ブロック内側の長い錨なし区間（20 kb 以上の挿入・反復・非コア。合意座標モードでは直前の錨の位置）。上辺のピンクの破線＝この株だけブロック内部の順序が入れ替わっている（粗い層で無視した少数派の破断点）','段（まとめ方）＝最細段のブロックを、幅が段の幅未満のものから支持の弱い境界で隣とまとめたもの。粗い段のブロックの色は含む最細ブロックの平均位置。粗い段のブロックに入ると配下の最細ブロックに絞り込む（計算なし）。最細段のブロックに入ると新しい窓','錨の対応線＝隣り合う行で同じ錨（80% 以上の株が持つ共有ノード。窓ごとに 800 本を等間隔に標本化）の位置を結ぶ細線。色は合意座標（左→右、環状なら原点から）。揃っていれば縦の帯、交差＝逆位、扇状に開く・閉じる＝挿入・欠失、長い斜線＝転座。第二錨（薄い線）＝コアでないが 2 株以上が持つノードの対応。逆位の矢印（←）は中身も鏡像に描く（その株の配列は右から左へ進む）','ブロック＝範囲（内側へ）・グラフとの接続・行をまたぐ集計の単位。矢印の細い帯と先端が向き、その下の塗りが保存度のプロファイル','系統樹の数字＝その枝で獲得／喪失した隣接の数（節約法）']){ const s=document.createElement('span'); s.textContent=t; el.appendChild(s); } }


function blockRef(rank){ if (isSites()) return siteRef(rank); if (isBase()) return baseRef(rank); if (rank==null) return null; const L = level(); const B = L.blocks[rank]; if (!B) return null;
  return {win: st.win, level: st.li, W: L.W, rank, name: B.name, ref_contig: (B.ref_contig!=null ? B.ref_contig : 0), x: (B.rx0 != null ? B.rx0 : B.x), span: (B.rx1 != null ? Math.max(1, B.rx1 - B.rx0) : B.span), tbp: B.tbp, nhap: B.nhap, label: '#'+(rank+1), tree: TREE, a0: B.a0, a1: B.a1}; }
function emitSel(){ if (cb && cb.onSelectBlock) cb.onSelectBlock(blockRef(st.sel)); }
let _lastHover = null;
function emitHover(rank){ if (!(cb && cb.onHoverBlock)) return; if (rank === _lastHover) return; _lastHover = rank; cb.onHoverBlock(blockRef(rank)); }

// ---- 詳細パネル ----
// 詳細の窓を画面中央に大きく出す（接合一覧・接合カード・手動）。固定が解けたら自動で右の欄に戻す
function setDetailWide(on){ st.detailWide = !!on; root.classList.toggle('detailwide', st.detailWide); const b = $('wide'); if (b) b.textContent = st.detailWide ? '⤡ 戻す' : '⤢ 大きく'; }
function setDetail(html){ if (!st.pinned && st.detailWide) setDetailWide(false); $('detailbody').innerHTML = (st.pinned ? '<p class="k" style="margin:0 0 4px;color:var(--sel)">固定中（クリックで解除・Esc）</p>' : '') + html; }
let _tipPos = { x: 0, y: 0 }, _tipSrc = '', _tipHtml = '', _copiedTimer = null, _hoverMark = null;
function setHoverInfo(html, src){ $('hoverbody').innerHTML = html || ''; _tipHtml = html || ''; _tipSrc = html ? (src || '') : ''; const t = $('tip'); if (!t) return; if (!html){ t.style.display = 'none'; return; } t.innerHTML = html + (COPY_SRC.has(_tipSrc) ? '<p class="copied">クリックでコピー</p>' : ''); t.style.display = 'block'; placeTip(); }
const COPY_SRC = new Set(['gene', 'fold', 'site', 'base']);   // junc はクリックで接合カード   // ボタンでもブロック選択でもない所: クリックで内容をクリップボードへ
function placeTip(){ const t = $('tip'); if (!t || t.style.display === 'none') return; const root = t.parentElement; if (!root) return; const W = root.clientWidth || 1200, H = root.clientHeight || 600; const tw = t.offsetWidth || 300, th = t.offsetHeight || 60;
  let x = _tipPos.x + 14, y = _tipPos.y + 16; if (x + tw > W - 4) x = Math.max(4, _tipPos.x - tw - 10); if (y + th > H - 4) y = Math.max(4, _tipPos.y - th - 8); t.style.left = x + 'px'; t.style.top = y + 'px'; }
function copyHover(){ if (!_tipHtml) return false; const t = $('tip'); let text = ''; try { const d = document.createElement('div'); d.innerHTML = _tipHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'); text = (d.textContent || '').replace(/\n{3,}/g, '\n\n').trim(); } catch (e) { text = _tipHtml; }
  const done = () => { if (t){ t.innerHTML = _tipHtml + '<p class="copied">コピーしました</p>'; if (_copiedTimer) clearTimeout(_copiedTimer); _copiedTimer = setTimeout(() => { if (t.style.display !== 'none' && _tipHtml) t.innerHTML = _tipHtml + (COPY_SRC.has(_tipSrc) ? '<p class="copied">クリックでコピー</p>' : ''); }, 900); } };
  try { if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } else fallbackCopy(text, done); } catch (e) { fallbackCopy(text, done); } return true; }
function fallbackCopy(text, done){ try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (e) { /* 無視 */ } }
function safeHover(fn){ try { fn(); } catch (e) { setHoverInfo(`<p class="k">ホバー処理でエラー: ${esc(String(e && e.message || e))}</p>`); console.error(e); } }
function hdrHoverSitesBase(x){ if (isSites()){ const k = siteAt(x); setHoverInfo(k != null ? siteInfo(k, null) : '', 'site'); emitHover(k); return; }
  const k = baseGroupAt(x); const ci = baseColAt(x); setHoverInfo(k != null ? baseGroupInfo(k, null, ci) : '', 'base'); if (!st.hover || st.hover.ci !== ci){ st.hover = ci != null ? { ci } : null; drawGrid(); } emitHover(k); }
function gridHoverSitesBase(e, rect){ const ri = Math.floor((e.clientY-rect.top)/RH); const px = e.clientX-rect.left; const inRow = ri>=0 && ri<LY.rows.length;
  if (genesOn() && st.lane && inRow && (e.clientY-rect.top) - ri*RH >= RH - 4){ const ge = geneAtCols(LY.rows[ri], px); if (ge){ setHoverInfo(geneInfoCols(ge, LY.rows[ri].hap), 'gene'); return; } }
  if (isBase()){ const ci = baseColAt(px); const k = baseGroupAt(px); const h0 = inRow ? {ri, ci} : null;
    if (!st.hover || !h0 || st.hover.ri!==h0.ri || st.hover.ci!==h0.ci){ st.hover = h0; drawGrid(); drawLabels(); }
    setHoverInfo(k!=null && inRow ? baseGroupInfo(k, ri, ci) : '', 'base'); emitHover(k); return; }
  const k = siteAt(px); const h0 = inRow ? {ri} : null;
  if (!st.hover || !h0 || st.hover.ri!==h0.ri){ st.hover = h0; drawGrid(); drawLabels(); }
  setHoverInfo(k!=null && inRow ? siteInfo(k, ri) : '', 'site'); emitHover(k); }
function blockInfo(rank, L){ const memtxt = (L.members ? `<p><span class="k">含む最細段のブロック (${membersOf(L,rank).length}):</span> ${membersOf(L,rank).map(m=>'#'+(m+1)).join(', ')}</p>` : '') + (()=>{ if (!st.genes.size) return ''; const gs = genesOf(L.blocks[rank]); return `<p><span class="k">遺伝子 ${gs.length} 個 (${geneDensity(rank).toFixed(1)}/Mb):</span> ${gs.slice(0,12).map(x=>esc(x.name)+(x.strand==='-'?'−':'')).join(', ')}${gs.length>12?' …':''}</p>`; })(); const B = L.blocks[rank]; const P = LY.prof && LY.prof.get(rank); return (`<p><span class="h">ブロック #${rank+1}</span><br>${esc(B.name)}<br><span class="k">錨列 ${B.c0+1}–${B.c1+1} · 原子区間 ${B.ncol} · 張り ${fmtbp(B.span)}<br>典型 ${fmtbp(B.tbp)} · 最長 ${fmtbp(B.bpmax)} · ${B.nhap} hap · ${B.rx0 != null ? `参照 ${fmtbp(B.rx0)}–${fmtbp(B.rx1)} · 合意 ${fmtbp(B.x)}` : `参照 ${fmtbp(B.x)}`}${B.atoms != null ? ` · 原子 ${B.atoms} 個` : ''}</span>${P?`<br><span class="k">状態: 主鎖 ${P.main} / 逆位 ${P.inv} / 別位置 ${P.disp} / 持たない ${P.abs}${P.divmed!=null?` · 変異密度の中央値 ${(100*P.divmed).toFixed(1)}%`:''}</span>`:''}</p>`) + memtxt; }
function itemHtml(h){
  const L = level(); const r = LY.rows[h.ri]; let html = `<p><span class="h">${esc(r.label)}</span> <span class="k">${esc(r.sub)}</span></p>`;
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
  return html;
}
function showItem(h){ if (!h) return; setDetail(itemHtml(h)); }
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
grid.addEventListener('mousemove', e=>{ const rect = grid.getBoundingClientRect(); if (isBase() || isSites()){ safeHover(()=>gridHoverSitesBase(e, rect)); return; }
  if (st.mode==='own' && st.foldGap){ const px = e.clientX-rect.left, py = e.clientY-rect.top; const ri = Math.floor(py/RH); const r = LY.rows[ri]; if (r){ for (const p of r.items){ if (px < p.x || px > p.x + p.w) continue; const q = foldPartAt(p, px); if (q){ setHoverInfo(`<p class="k">畳んだ隙間: 錨の無い配列 ${q.bp.toLocaleString()} bp（島・私有配列。「長い隙間を畳む」を外すと実寸）· ${esc(ctPath(p.ct))}</p>`, 'fold'); return; } } } }
  if (genesOn()){ const px = e.clientX-rect.left, py = e.clientY-rect.top; const ri = Math.floor(py/RH); const r = LY.rows[ri]; const dy = py - ri*RH; if (r){
    if (st.jmark && dy <= 9 && r.jmarks){ const m = r.jmarks.find(m => Math.abs(m.x - px) <= 5); if (m){ _hoverMark = m; const html = juncInfo(m) + '<p class="copied">クリックで接合カード</p>'; setHoverInfo(html, 'junc'); if (!st.pinned) $('detailbody').innerHTML = html; return; } else _hoverMark = null; }
    if (st.lane && dy >= RH - 6){ const hg = geneAt(r, px, py); const html = hg ? geneInfo(hg) : ''; setHoverInfo(html, 'gene'); if (hg && !st.pinned) $('detailbody').innerHTML = html; if (hg) return; } } } const h = hit(e.clientX-rect.left, e.clientY-rect.top); st.hover = h; st.hoverRank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); setHoverInfo(h ? itemHtml(h) : '', 'item'); drawGrid(); drawLabels(); if (!st.pinned) showItem(h);
  emitHover(h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null)); });
grid.addEventListener('mouseleave', ()=>{ st.hover=null; st.hoverRank=null; drawGrid(); drawLabels(); emitHover(null); setHoverInfo(''); });
grid.addEventListener('dblclick', e=>{ const rect = grid.getBoundingClientRect(); const h = hit(e.clientX-rect.left, e.clientY-rect.top);
  const rank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); if (rank==null) return;
  st.sel = rank; st.pinned = true; drawAll(); emitSel(); drillInto(rank); });
grid.addEventListener('click', e=>{ if (e.detail && e.detail > 1) return; const rect = grid.getBoundingClientRect();
  if (_tipSrc === 'junc' && _hoverMark){ openJunction(_hoverMark.j[0]); return; }   // 三角 → 接合カード
  if (COPY_SRC.has(_tipSrc) && _tipHtml){ copyHover(); if (_tipSrc !== 'site' && _tipSrc !== 'base') return; }   // レーン・畳み: コピーだけ。サイト／塩基のセルはコピーして選択も
  const h = hit(e.clientX-rect.left, e.clientY-rect.top);
  if (h && h.p && h.p.o.kind<4){ st.sel = (st.sel===h.p.o.rank) ? null : h.p.o.rank; st.pinned = st.sel!=null; if (st.sel!=null) showItem(h); drawAll(); emitSel(); }
  else if (h && h.b){ st.sel = (st.sel===h.b.rank) ? null : h.b.rank; st.pinned = st.sel!=null; if (st.sel!=null) showItem(h); drawAll(); emitSel(); }   // 束もブロックの選択として扱う
  else if (h && h.m){ st.pinned = true; showItem(h); }
  else { st.pinned = false; st.sel = null; drawAll(); emitSel(); } });
// 列見出しをドラッグして合意座標の任意区間を選び、その区間の窓へ（ブロック境界に縛られない「範囲で降りる」）。
// 各行のトークン範囲は標本錨（第一・第二）のうち区間内にあるものの最小/最大トークンで近似する
function pxToCons(px){ if (isBase()) return px; if (isSites()){ const S = sitesOf(); if (!S || !S.nsites) return null; const k = Math.max(0, Math.min(S.nsites-1, Math.floor((px - SITES_X0) / LY.siteW))); return S.sites[k].x + (px - (SITES_X0 + k*LY.siteW)) / LY.siteW * Math.max(1, S.sites[k].bp); } for (const c of LY.cols){ if (c.type==='block' && px>=c.x && px<=c.x+c.w){ const B = level().blocks[c.rank]; return B.x + (px-c.x)/Math.max(1,c.w)*B.span; } } let best=null; for (const c of LY.cols){ if (c.type!=='block') continue; const d = px < c.x ? c.x-px : px-(c.x+c.w); if (best==null || d<best[0]) best=[d,c]; } if (!best) return null; const c=best[1], B=level().blocks[c.rank]; return px < c.x ? B.x : B.x + B.span; }
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
function drillRange(xa, xb){ if (xb <= xa || st.drilling) return; if (isBase()){ baseRange(xa, xb); return; } if (isSites()){ sitesRange(xa, xb); return; } const w = win(); const L0 = w.levels[0];
  const ranks = []; L0.blocks.forEach((B, r)=>{ if (B.x < xb && B.x + B.span > xa) ranks.push(r); });
  if (!ranks.length){ notice('この区間にブロックがありません。'); st.rangeSel = null; drawHeader(); return; }
  const label = fmtRange(xa, xb); const key = 'r:' + Math.round(xa) + ':' + Math.round(xb);
  const ch = w.children ? w.children[key] : null; if (ch!=null){ st.rangeSel = null; drawHeader(); enterWindow(ch); return; }
  // 1 ブロックに収まる範囲: その子窓に入って、範囲に重なるブロックに絞り込む（子窓が無い小さなブロックは塩基へ）
  const cols = (xb - xa) / Math.max(1, DATA.meta.bpt || 1);
  if (!TREE && ranks.length === 1 && cols <= BASE_MAX_LEAVES && cb && cb.onBaseMsa){ const rk = ranks[0]; const rr_ = drillRangesAt(L0, rk); const anc = anchorsOf(w);
    // 範囲内の錨でトークン範囲を狭める（親ブロック全体でなく範囲だけを塩基へ）
    const ranges = []; if (anc){ for (const [path, s0, e0] of rr_){ const A = anc.rows.get(path); let lo = Infinity, hi = -Infinity; if (A) for (let k=0;k<A.i.length;k++){ const x = anc.x[A.i[k]]; if (x >= xa && x <= xb && A.tok[k] >= s0 && A.tok[k] < e0){ lo = Math.min(lo, A.tok[k]); hi = Math.max(hi, A.tok[k]+1); } } if (hi > lo) ranges.push([path, lo, hi]); } }
    if (ranges.length){ cb.onBaseMsa({ ranges, span: xb-xa, afrac: 0, label: winPath().map((p,i)=>i===0?'全体':p.label).join('›') + '›' + label, depth: w.depth+1, parent: st.win, pblock: -1 }); $('detailbody').innerHTML = `<p class="k">区間 ${label} の各行を塩基レベル MSA に渡しました。</p>`; st.rangeSel = null; drawHeader(); return; } }
  if (TREE){   // 木: 範囲をそのまま問い合わせる（境界は原子区間の単位に丸まる）
    // 範囲が原子 1 個の内側（または窓がその原子 1 個だけ）なら木には降りる先が無い。同じ窓が繰り返しできるだけなので、範囲の変異サイトへ降りる
    const inOneAtom = ranks.length === 1 && (B => B && B.a0 != null && B.a0 === B.a1 && (L0.nblocks === 1 || (xa >= B.x && xb <= B.x + B.span)))(L0.blocks[ranks[0]]);
    if (inOneAtom && cb && cb.onSites){ st.rangeSel = null; drawHeader(); openSites({ x0: xa, x1: xb }, label, -1); return; }
    if (!(cb && cb.onRange)) return;
    st.drilling = true; st.busy = `区間 ${label} の窓を木から取り出しています…`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
    cb.onRange(xa, xb, label, w.depth+1, st.win, -1).then(r=>{ st.drilling = false; st.busy = null; st.rangeSel = null;
      if (!r || r.error || !r.window){ drawAll(); notice(`この区間の窓を作れませんでした: ${esc((r && r.error) || '応答なし')}`); return; }
      const nw = r.window; const nb = nw.levels && nw.levels[0] ? nw.levels[0].blocks : [];
      // 木が返したのが原子 1 個で、選んだ範囲がその内側（原子の 9 割未満）なら、原子 1 個の窓を挟まず範囲の変異サイトへ。
      // 返った原子の並びが今の段で範囲に重なるブロックと同じ（範囲の中に新しい境界が現れない）ときも同じ（同じ窓が入れ子になるだけ）
      const keyOf = bs => bs.map(b => (b.a0 != null ? b.a0 : '?') + '-' + (b.a1 != null ? b.a1 : '?')).join(',');
      const sameAsNow = nb.length > 0 && nb[0].a0 != null && keyOf(nb) === keyOf(ranks.map(r => L0.blocks[r]));
      if (sameAsNow || (nb.length === 1 && nb[0].a0 != null && nb[0].a0 === nb[0].a1 && xa >= nb[0].x - 1 && xb <= nb[0].x + nb[0].span + 1 && (xb - xa) < 0.9 * nb[0].span)){ if (cb && cb.onSites){ drawAll(); openSites({ x0: xa, x1: xb }, label, -1); } else { drawAll(); $('detailbody').innerHTML = '<p class="k">この範囲は今のブロックと同じ原子区間です。ダブルクリックで変異サイトへ降りてください。</p>'; } return; }
      nw.id = WINS.length; nw.parent = st.win; nw.pblock = -1; nw.plevel = st.li; nw.pW = level().W; nw.children = nw.children || {}; nw.ondemand = true; nw.ms = r.ms || 0;
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
cv.hdr.addEventListener('click', e=>{ if (_hdrDragged){ _hdrDragged = false; return; } if (e.detail && e.detail > 1) return; const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (isSites()){ const k = siteAt(x); st.sel = (k!=null && st.sel===k) ? null : k; st.pinned = st.sel!=null; if (st.sel!=null) setDetail(siteInfo(st.sel, null)); drawHeader(); drawGrid(); emitSel(); return; } if (isBase()){ const k = baseGroupAt(x); st.sel = (k!=null && st.sel===k) ? null : k; st.pinned = st.sel!=null; if (st.sel!=null) setDetail(baseGroupInfo(st.sel, null, null)); drawHeader(); drawGrid(); emitSel(); return; } for (const c of LY.cols){ if (c.type==='block' && x>=c.x && x<=c.x+c.w){ st.sel = (st.sel===c.rank)?null:c.rank; st.pinned = st.sel!=null; if (st.sel!=null) showBlock(c.rank); drawAll(); emitSel(); return; } } });
cv.hdr.addEventListener('mousemove', e=>{ const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (isSites() || isBase()){ safeHover(()=>hdrHoverSitesBase(x)); return; } for (const c of LY.cols){ if (x>=c.x && x<=c.x+c.w){ if (!st.pinned) showBlock(c.rank); setHoverInfo(blockInfo(c.rank, level()), 'block'); emitHover(c.rank); if (st.hoverRank!==c.rank){ st.hoverRank=c.rank; drawGrid(); } return; } } emitHover(null); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
cv.hdr.addEventListener('mouseleave', ()=>{ emitHover(null); setHoverInfo(''); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
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
function baseMsa(rank){ if (!(cb && (cb.onBaseFetch || cb.onBaseMsa)) || rank==null) return; const L = level(); const B = L.blocks[rank];
  if (cb.onBaseFetch){ openBase(drillRanges(rank), '#' + (rank+1), rank, B.c0, B.c1, undefined, [B.x, B.x + Math.max(1, B.span)]); return; }
  cb.onBaseMsa({ ranges: drillRanges(rank), span: B.span, afrac: 0, label: winPath().map((p,i)=>i===0?'全体':p.label).join('›') + '›#' + (rank+1), depth: win().depth+1, parent: st.win, pblock: rank });
  $('detailbody').innerHTML = `<p class="k">#${rank+1} の各行を塩基レベル MSA（MSA パネル）に渡しました。</p>`; }
$('graphrange').addEventListener('click', ()=>{ if (st.graphRuns && st.graphRuns.length) openGraphRange(st.graphRuns[0]); });
$('base').addEventListener('click', ()=>{ if (isSites()){ const L = level(); const S_ = L.sites; const xr_ = S_ && S_.nsites ? [S_.sites[0].x, S_.sites[S_.nsites-1].x + Math.max(1, S_.sites[S_.nsites-1].bp)] : null; if (L.c1 - L.c0 + 1 <= BASE_MAX_LEAVES) baseFromCols(L.c0, L.c1, win().label, undefined, xr_); return; } if (st.sel==null) return; baseMsa(st.sel); });
$('scopeout').addEventListener('click', ()=>{
  if (st.filter){ const e = st.filterPath.pop(); st.filter = e ? e.prev : null; st.li = e ? Math.min(e.li, win().levels.length-1) : 0; st.sel = e ? e.rank : null; st.pinned=false; drawAll(); emitSel(); return; }
  const w = win(); if (w.parent<0) return;
  st.sel = w.pblock; st.win = w.parent; st.li = Math.min(w.plevel!=null ? w.plevel : 0, WINS[w.parent].levels.length-1); st.origin=null; st.pinned=false; drawAll(); emitSel(); });
$('setorigin').addEventListener('click', ()=>{ if (st.sel==null) return; st.origin = st.sel; drawAll(); });
$('autoorigin').addEventListener('click', ()=>{ st.origin = null; drawAll(); });
// 表示設定・説明・チップを隠す（整列を広く見る）。状態はこのブラウザに記憶
function setCompact(on){ root.classList.toggle('compact', !!on); $('compact').setAttribute('aria-pressed', on ? 'true' : 'false'); $('compact').textContent = on ? '設定 ▾' : '設定 ▴'; try { localStorage.setItem('bkmsa_compact', on ? '1' : '0'); } catch (e) {} drawAll(); }
$('compact').addEventListener('click', ()=>setCompact(!root.classList.contains('compact')));
$('bdiff').addEventListener('change', e=>{ st.baseDiff = e.target.checked; drawGrid(); });
function setBaseCmp(m){ st.baseCmp = m; $('cmp_ref').setAttribute('aria-pressed', m==='ref' ? 'true' : 'false'); $('cmp_major').setAttribute('aria-pressed', m==='major' ? 'true' : 'false'); drawHeader(); drawGrid(); drawChips(); }
$('cmp_ref').addEventListener('click', ()=>setBaseCmp('ref')); $('cmp_major').addEventListener('click', ()=>setBaseCmp('major'));
function setRowMode(m){ st.rowMode = m; for (const k of ['auto','std','dense']) $('rh_'+k).setAttribute('aria-pressed', k===m ? 'true' : 'false'); try { localStorage.setItem('bkmsa_rowmode', m); } catch (e) {} drawAll(); }
for (const k of ['auto','std','dense']) $('rh_'+k).addEventListener('click', ()=>setRowMode(k));
try { const m0 = localStorage.getItem('bkmsa_rowmode'); if (m0 === 'std' || m0 === 'dense'){ st.rowMode = m0; for (const k of ['auto','std','dense']) $('rh_'+k).setAttribute('aria-pressed', k===m0 ? 'true' : 'false'); } } catch (e) {}
try { if (localStorage.getItem('bkmsa_compact') === '1'){ root.classList.add('compact'); $('compact').setAttribute('aria-pressed', 'true'); $('compact').textContent = '設定 ▾'; } } catch (e) {}
function setMode(m){ st.mode=m; $('m_msa').setAttribute('aria-pressed', m==='msa'); $('m_own').setAttribute('aria-pressed', m==='own'); drawAll(); }
$('m_msa').addEventListener('click', ()=>setMode('msa')); $('m_own').addEventListener('click', ()=>setMode('own'));
function setOrder(o){ st.order=o; $('o_tree').setAttribute('aria-pressed', o==='tree'); $('o_name').setAttribute('aria-pressed', o==='name'); drawAll(); }
$('o_tree').addEventListener('click', ()=>setOrder('tree')); $('o_name').addEventListener('click', ()=>setOrder('name'));
 $('bund').addEventListener('change', e=>{ st.bundle=e.target.checked; drawAll(); });
$('sync').addEventListener('change', e=>{ st.sync=e.target.checked; _lastViewKey=''; emitView(); });
$('gfilter').addEventListener('change', e=>{ st.gfilter=e.target.checked; _lastViewKey=''; emitView(); });
$('lane').addEventListener('change', e=>{ st.lane=e.target.checked; drawGrid(); drawLegend(); });
{ const root = $('tip') && $('tip').parentElement; if (root){ root.addEventListener('mousemove', e => { const r = root.getBoundingClientRect(); _tipPos = { x: e.clientX - r.left, y: e.clientY - r.top }; placeTip(); }); root.addEventListener('mouseleave', () => { const t = $('tip'); if (t) t.style.display = 'none'; }); } }
$('foldgap').addEventListener('change', e=>{ st.foldGap=e.target.checked; drawAll(); });
$('junclist').addEventListener('click', ()=>{ openJunctionList(); });
$('detailbody').addEventListener('click', e=>{ const t = e.target; if (!t || !t.getAttribute) return; const act = t.getAttribute('data-act'); const tr = t.closest ? t.closest('tr[data-jid]') : null;
  if (act === 'goto'){ gotoAtom(Number(t.getAttribute('data-atom'))); return; }
  if (act === 'jbase'){ openJunctionBase(Number(t.getAttribute('data-jid'))); return; }
  if (act === 'copy'){ const c = $('detailbody')._card; if (c){ const d = document.createElement('div'); d.innerHTML = c.html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li)>/gi, '\n'); copyPlain((d.textContent || '').trim(), 'カードをコピーしました'); } return; }
  if (act === 'tsv'){ const rows = $('detailbody')._list || []; copyPlain(junctionTsv(rows), `TSV ${rows.length} 行をコピーしました`); return; }
  if (tr){ openJunction(Number(tr.getAttribute('data-jid'))); } });
$('detailbody').addEventListener('change', e=>{ const t = e.target; const k = t && t.getAttribute && t.getAttribute('data-jl'); if (!k) return; if (k === 'win') JL.win = !!t.checked; else JL[k] = t.value; if (_juncList) renderJunctionList(); });
$('jmark').addEventListener('change', e=>{ st.jmark=e.target.checked; drawGrid(); });
$('anc').addEventListener('change', e=>{ st.anc=e.target.checked; drawGrid(); drawChips(); drawLegend(); });
$('anc2').addEventListener('change', e=>{ st.anc2=e.target.checked; drawGrid(); drawChips(); });
$('onlysel').addEventListener('change', e=>{ st.onlySel=e.target.checked; drawAll(); });
function setMeasure(m){ st.measure=m; for (const [id,k] of [['v_minor','minor'],['v_priv','priv'],['v_nonanc','nonanc']]) $(id).setAttribute('aria-pressed', k===m); drawGrid(); drawLegend(); }
function setNorm(n){ st.norm=n; for (const [id,k] of [['n_abs','abs'],['n_block','block'],['n_hap','hap']]) $(id).setAttribute('aria-pressed', k===n); drawGrid(); drawLegend(); }
$('v_minor').addEventListener('click', ()=>setMeasure('minor')); $('v_priv').addEventListener('click', ()=>setMeasure('priv')); $('v_nonanc').addEventListener('click', ()=>setMeasure('nonanc'));
$('n_abs').addEventListener('click', ()=>setNorm('abs')); $('n_block').addEventListener('click', ()=>setNorm('block')); $('n_hap').addEventListener('click', ()=>setNorm('hap'));
$('wide').addEventListener('click', ()=>{ if (!st.detailWide && !st.pinned) st.pinned = true; setDetailWide(!st.detailWide); });
$('close').addEventListener('click', ()=>{ st.pinned = false; st.sel = null; setDetailWide(false); drawHeader(); drawGrid(); emitSel(); setDetail('<p class="k">固定を解除しました。</p>'); });
$('copybtn').addEventListener('click', ()=>{ const t = $('detailbody').innerText; if (navigator.clipboard) navigator.clipboard.writeText(t).then(()=>{ $('copybtn').textContent='コピーしました'; setTimeout(()=>$('copybtn').textContent='コピー', 1200); }); });
const onKey = e=>{ if (e.key === 'Escape' && st.pinned){ st.pinned = false; st.sel = null; drawHeader(); drawGrid(); emitSel(); setDetail('<p class="k">固定を解除しました。</p>'); return; } if (e.key==='Escape' && root.isConnected){ st.pinned=false; st.sel=null; drawAll(); emitSel(); } };
window.addEventListener('keydown', onKey);
const ro = new ResizeObserver(()=>{ if (root.isConnected && $('gridwrap').clientWidth > 0) drawAll(); }); ro.observe(root);
$('body').addEventListener('scroll', ()=>{ $('hdrwrap').scrollLeft = $('body').scrollLeft; });   // はみ出し分の横スクロールに列見出しを追従
// (sub) (DATA.meta.circular?'環状 · ':'') + `窓 ${WINS.length} 個 · ${DATA.meta.bpt} bp/token · 予算 ${DATA.meta.budget}s · 順序＝` + (DATA.meta.order.kind==='ref'?'参照 ':'典型パス ') + DATA.meta.order.path.split('#')[0];
drawAll();


return {
  isTree(){ return TREE; },
  setGraphAtoms(atoms){ const a = Array.isArray(atoms) ? atoms.slice(0, 4000).map(e => Array.isArray(e) ? [e[0], Math.max(0, +e[1] || 0), e[2] != null ? +e[2] : -1, e[3] != null ? +e[3] : -1] : [e, 1, -1, -1]) : null; const key = a ? a.map(e => e.join(':')).join(',') : ''; if (key === (st._gaKey || '')) return; st._gaKey = key; st.graphAtoms = a; st.graphRuns = graphRunsOf(a); drawHeader(); drawMini(); updateButtons(); },
  openGraphRange(){ if (st.graphRuns && st.graphRuns.length) openGraphRange(st.graphRuns[0]); },
  locateNodes(names){ if (!TREE || !(cb && cb.onLocate) || !names || !names.length){ st.marks = null; drawHeader(); return; }
    cb.onLocate(names).then(r => { if (!r || r.error || !r.nodes){ st.marks = null; drawHeader(); return; }
      const KIND = ['錨（1 対 1 で葉）', '一意・一貫（1 か所）', '私有（この株だけ）', '一意だが株によって場所が違う', '多重コピー（反復）'];
      st.marks = r.nodes.filter(n => n.kind >= 0 && n.places && n.places.length); drawHeader();
      const html = r.nodes.map(n => { if (n.kind < 0) return `<p><span class="h">${esc(n.name)}</span><br><span class="k">葉ノードではないか、木に無い（スーパーノードの写像は未実装）</span></p>`;
        const pls = (n.places || []).map(p => p.atom != null ? `<button class="mini locgo" data-x0="${p.x0}" data-x1="${p.x1}" data-atom="${p.atom}" title="この原子区間の窓へ">原子 ${p.atom} (${fmtbp(p.x0)}–${fmtbp(p.x1)})</button>` : `<button class="mini locgo" data-x0="${Math.max(0, p.x0 - 5000)}" data-x1="${p.x1 + 5000}" title="この隙間の前後 5 kb の窓へ">隙間 ${p.gap + 1}|${p.gap + 2} (${fmtbp(p.x0)})</button>`).join(' ');
        return `<p><span class="h">${esc(n.name)}</span> <span class="k">${KIND[n.kind] || ''}${n.nplace > (n.places || []).length ? ` · 全 ${n.nplace} か所（先頭 ${(n.places || []).length}）` : (n.nplace > 1 ? ` · ${n.nplace} か所` : '')} · 合意座標 ${fmtbp(n.x || 0)}</span><br>${pls}</p>`; }).join('');
      setDetail(html + '<p class="k">列見出しのピンク＝このノードの場所。ボタンでその範囲の窓を開きます。</p>');
      $('detailbody').querySelectorAll('.locgo').forEach(b => b.addEventListener('click', () => { const x0 = +b.getAttribute('data-x0'), x1 = +b.getAttribute('data-x1'); if (x1 > x0 && cb && cb.onRange){ st.win = 0; st.li = 0; drillRange(x0, x1); } }));
    }).catch(() => { st.marks = null; drawHeader(); }); },
  selectByRef(contig, bp){ const L = level(); let hit = -1;
    L.blocks.forEach((B, i)=>{ const c = (B.ref_contig!=null ? B.ref_contig : 0); if (c===contig && bp >= B.x && bp <= B.x + B.span) { if (hit<0 || B.span < L.blocks[hit].span) hit = i; } });
    if (hit < 0) return false; st.sel = hit; st.pinned = true; showBlock(hit); drawAll(); emitSel(); return true; },
  destroy(){ window.removeEventListener('keydown', onKey); ro.disconnect(); root.innerHTML = ''; if (cb && cb.onView) cb.onView(null); },
  setHapMarks(m){ st.hapMarks = m || new Map(); drawAll(); },   // グラフで選択中のパス群（鍵→色）。行ラベルに印、「選択行のみ」の対象
  setGenes(g){ st.genes = g || new Map(); _gdMax = null; $('c_genes').disabled = !st.genes.size; if (!st.genes.size && st.colorBy==='genes') st.colorBy='order'; _lastViewKey=''; drawAll(); },   // 参照コンティグ id → 遺伝子（start 昇順）
  _layout(){ return LY; },   // 試験用（配置の検査）
};

}
