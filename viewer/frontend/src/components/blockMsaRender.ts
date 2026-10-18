// @ts-nocheck
import type { BlockDrillRequest, BlockDrillResult } from '../api/client'
// 多解像度 MSA（共線ブロック）の描画。functions/msa_lod/hier_template.html の JS をそのまま移植（vanilla、canvas）。
// React 側は components/BlockMsa.tsx が薄く包む。ここは意図的に型を付けない（試作。本番化時に整える）。
const BODY = '\n<div class="toolbar"><button id="bk_compact" title="表示設定・説明・情報チップを隠す／出す（整列を広く見る）" aria-pressed="false">設定 ▴</button><div class="chips set" id="bk_chips" style="margin-left:0"></div>\n  <div class="grp"><span class="t">窓</span><nav class="crumbs" id="bk_crumbs" aria-label="階層"></nav></div>\n  <div class="grp"><span class="t">段（まとめ方）</span><span id="bk_ladder"></span></div>\n  <div class="grp set"><span class="t">並べ方</span><button id="bk_m_msa" aria-pressed="true">合意座標</button><button id="bk_m_own" aria-pressed="false">各行の並び</button></div>\n  <div class="grp set"><label title="隣り合う行で同じ錨（80% 以上の株が持つ共有ノード）の位置を線で結ぶ。ブロックの単位によらない対応線。交差＝逆位、扇状＝挿入・欠失、長い斜線＝転座"><input type="checkbox" id="bk_anc" checked>錨の対応線</label><label title="コアでないが 2 株以上が持つ一意ノードの対応を薄い線で足す。隣り合う株が共有する島・ファージが見える"><input type="checkbox" id="bk_anc2" checked>第二錨</label></div>\n  <div class="grp set"><span class="t">目盛り</span><button id="bk_a_cons" aria-pressed="true">ブロック累積 bp</button><button id="bk_a_ref" aria-pressed="false" title="木では合意順の累積 bp（全ノードの塩基数。参照に無い島も幅を持つ）">合意 bp</button></div>\n  <div class="grp set"><span class="t">色</span><button id="bk_c_order" aria-pressed="true" title="合意順序で色を付ける（左→右の色相の帯）">順序</button><button id="bk_c_genes" aria-pressed="false" disabled title="ブロックの参照区間に重なる遺伝子の密度（個/Mb）。アノテのある DB だけ">遺伝子密度</button></div>\n  <div class="grp set"><span class="t">行順</span><button id="bk_o_tree" aria-pressed="true">系統樹</button><button id="bk_o_name" aria-pressed="false">名前</button> <span class="t">木</span><button id="bk_t_global" aria-pressed="true" title="全ゲノムで 1 回作った系統樹（サイドカー）">全体</button><button id="bk_t_range" aria-pressed="false" title="表示している窓の内容だけで作り直した系統樹（画面側で計算。ブロック段＝原子の有無と少数派サイト、アレル行列＝アレル、塩基段＝塩基）">表示範囲</button><span id="bk_treeinfo" class="k"></span></div>\n  <div class="grp set" id="bk_origingrp"><span class="t">原点</span><span id="bk_origintxt" class="t"></span><button id="bk_setorigin" disabled>選択ブロックを原点に</button><button id="bk_autoorigin">自動</button></div>\n  <div class="grp" id="bk_basegrp" style="display:none"><span class="t">比較の基準</span><button id="bk_cmp_ref" aria-pressed="false" title="参照パス（無ければ先頭の行）の塩基。列見出しの下段に出る">参照</button><button id="bk_cmp_major" aria-pressed="true" title="列ごとの最頻の塩基（多数派）。列見出しの下段に出る（既定。参照株は外群のことがある）">多数派</button><label title="基準と同じ塩基を · で省き、違う塩基だけ色で出す"><input type="checkbox" id="bk_bdiff" checked>一致を省く</label><label title="CDS の中の塩基の違いを、座位ごとのモデル（最も多くの株が同じ区間に持つ CDS の注釈）の読み枠で全行のコドンに読み、多数派（比較の基準）のコドンと比べる。セルの上辺の色: 灰 同義・橙 非同義・赤 終止獲得／終止喪失／開始喪失／フレームシフト・黄 インフレーム indel・薄い赤 読み枠がずれた区間。注釈の無い行（擬似遺伝子）もモデルの枠で読むので、どこで壊れたかが見える。ホバーで p.Ala123Thr の形"><input type="checkbox" id="bk_beff" checked>変異の効果</label><label title="変異のある群（行で塩基か有無が違う、または排他アレルが複数）だけを並べる。旧アレル行列の見え方。群が画面幅より多いときは自動でこうなる"><input type="checkbox" id="bk_bvar">変異のある群だけ</label><span class="t">倍率</span><button id="bk_zout" title="縮小（Ctrl+ホイール下）">−</button><button id="bk_zin" title="拡大（Ctrl+ホイール上。格子のダブルクリックは 2 段）">＋</button><button id="bk_zfit" title="窓全体を画面幅に（俯瞰）">全体</button><button id="bk_zbase" title="文字が読める 7 px/塩基まで一気に拡大">塩基</button><span id="bk_ztxt" class="t"></span><span class="t">列見出しをドラッグ＝その範囲を画面幅に</span></div>\n  <div class="grp"><button id="bk_scopein" disabled>選択ブロックの内側へ →</button><button id="bk_base" disabled title="このブロックの各行のトークン範囲を塩基レベル MSA（MSA パネル）に渡す。列（葉）が上限以下のブロックで使える">塩基へ ↓</button><button id="bk_graphrange" disabled title="グラフで今見えている範囲（ミニマップ底の線＝最も多くのノードが属する連なり）を、その広さに合う段（ブロック／アレル行列／塩基）で開く。離れた範囲が複数あるときは主な 1 本。他はミニマップ底の線をクリック">グラフの範囲を開く</button><button id="bk_scopeout" disabled>← 全体へ</button></div>\n  <div class="grp set"><span class="t">変異密度</span><button id="bk_v_minor" aria-pressed="true">少数派サイト</button><button id="bk_v_priv" aria-pressed="false">私有サイト</button><button id="bk_v_nonanc" aria-pressed="false">錨でない bp</button></div>\n  <div class="grp set"><span class="t">基準</span><button id="bk_n_abs" aria-pressed="true">絶対（層内百分位）</button><button id="bk_n_block" aria-pressed="false">ブロック相対</button><button id="bk_n_hap" aria-pressed="false">株相対</button></div>\n  <div class="grp set"><label><input type="checkbox" id="bk_bund" checked>束ねる</label></div>\n  <div class="grp set"><span class="t">行の高さ</span><button id="bk_rh_auto" aria-pressed="true" title="ブロックは 30 px、アレル行列・塩基は全行が入る高さ（12〜18 px）">自動</button><button id="bk_rh_std" aria-pressed="false" title="どの段でも 30 px">標準</button><button id="bk_rh_dense" aria-pressed="false" title="アレル行列・塩基を 14 px に">密</button></div>\n  <div class="grp set"><label title="窓や絞り込みを変えると、グラフをその範囲に寄せ、範囲に合う層で表示する"><input type="checkbox" id="bk_sync" checked>グラフ連動</label><label title="グラフに、この窓（ブロック／アレル行列／塩基の範囲）に属するノードだけを描く。レイアウトで近くてもシンテニーで離れたノードが消え、範囲が数 kb なら折りたたまれた中央でも読める（2026-10-07 の測定: 500 列で隣の 98%、1,000 列で 90% がゲノムの隣）。範囲の外へ繋がる辺は橙の切れ端で示す。全体の窓では何も消えない"><input type="checkbox" id="bk_gfilter">グラフをこの範囲に絞る</label><label title="各行の底に、その株の GFF の遺伝子を置く（緑 + 鎖、橙 − 鎖。鎖は合意の向きに対して＝逆向きに置かれた区間では GFF の鎖を反転するので、同じ遺伝子は行の間で同じ色。灰 擬似遺伝子・RNA・反復）。遺伝子が画素より多い所は灰の帯（密度）。遺伝子サイドカー .genes のある DB だけ。アレル行列・塩基の段では GFF の子の行も描く: CDS は濃く、エキソンは薄く、UTR は細く、遺伝子の張りは底の 1 px の線。ホバーで要約、クリックで GFF の全項目（9 列・属性・親・子）とその株の GFF の書き出し"><input type="checkbox" id="bk_lane" checked>遺伝子レーン</label><label title="各行の並びモードで、錨の無い長い配列（島・私有配列。斜線）が 40 px を超えるときは 12 px に畳んで長さを書く。島の多い領域で原子の矢印が押しやられない。畳まないときは実寸"><input type="checkbox" id="bk_foldgap" checked>長い隙間を畳む</label><label title="各行の並びモードで、コンティグを合意の順に並べ、間を 2 px（縦の細線）に詰める。断片化したアセンブリ（1 行のコンティグ数の中央値 5 以上）では自動で有効"><input type="checkbox" id="bk_ctgpack">コンティグを詰める</label><label title="行の上の三角＝破断点と遺伝子の関係（赤 分断、桃 他株の島の挿入点が遺伝子内、橙 遺伝子の端が接合区間内、灰 遺伝子なし）。ホバーで接合区間と遺伝子"><input type="checkbox" id="bk_jmark" checked>破断点×遺伝子</label><input id="bk_gfind" type="search" placeholder="遺伝子名…" title="遺伝子名の前方一致（産物名の部分一致も）で遺伝子群を探し、その窓を開く。Enter で検索" style="width:88px;font:11px monospace"> <button id="bk_junclist" disabled title="再編成の接合（破断点）の一覧。株・種類・区間・遺伝子との関係。行をクリックで接合カード、TSV で書き出し">接合一覧</button><label title="パスパネルで選んだ（行ラベルをクリックした）ハプロタイプの行だけを表示"><input type="checkbox" id="bk_onlysel">選択行のみ</label></div>\n</div>\n<div id="bk_tip"></div>\n<div id="bk_mini" title="全体の合意シンテニー（根の最細段のブロック）。明るい所＝今の窓の範囲。クリックでそのブロックの窓、ドラッグで範囲の窓"><canvas id="bk_minic"></canvas></div>\n<div class="legend" id="bk_legend"></div>\n<div class="bkmain">\n  <div id="bk_corner"><span id="bk_cutwrap" title="系統樹の高さの閾値。左へ動かすほど多くの枝をまとめる（根が左、葉が右。線より右で閉じる枝は代表 1 株＝群の中心だけを出す）。右端で解除"><input type="range" id="bk_cut" min="0" max="100" value="100"><small id="bk_cuttxt"></small></span><span title="列見出し: クリック=ブロック選択 · ダブルクリック=内側へ · ドラッグ=任意の区間の窓（範囲で降りる）">ハプロタイプ ↓ · 列見出しをドラッグ＝範囲の窓</span><span id="bk_scopetxt"></span></div>\n  <div id="bk_hdrwrap"><canvas id="bk_hdr"></canvas></div>\n  <div id="bk_gtl" title="見出しの遺伝子トラック: 同じノードを共有する遺伝子の群を 1 本の矢印で（向きは合意に対する多数の向き）。濃い青緑＝core（90% 以上の株が持つ）、薄い＝accessory、点線＝擬似が多数、×＝1 株に複数。行には差分だけ: 白抜き＝その株に無い、斜線（橙）＝擬似、紫＝群の多数（65% 以上）と逆向き、青緑の刻み＝その株だけの遺伝子。向きが半々に割れている群は矢印の下半分が紫で、行には紫を出さない。矢印にホバーで詳細、クリックで列を強調">遺伝子</div><div id="bk_gtwrap"><canvas id="bk_gtrack"></canvas></div>\n  <aside id="bk_detail"><h3>詳細 <span class="dbtns"><button id="bk_wide" title="詳細を画面の中央に大きく出す／右の欄に戻す（接合一覧・接合カードは自動で大きく出る）">⤢ 大きく</button><button id="bk_copybtn" title="詳細の文字をコピー">コピー</button><button id="bk_close" title="固定を解除して閉じる（Esc）">✕</button></span></h3><div id="bk_detailbody"><p class="k">矢印や列見出しにホバーすると詳細が出ます。クリックで固定。ダブルクリックでそのブロックの内側へ（どの段からでも）。</p></div><div id="bk_hoverbody"></div></aside>\n  <div id="bk_body"><div id="bk_treewrap"><svg id="bk_tree" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="bk_labwrap"></div><div id="bk_gridwrap"><canvas id="bk_grid"></canvas><div id="bk_bscroll" title="塩基の段の横スクロール（格子のドラッグ、Shift+ホイールでも動く）"><div></div></div><div id="bk_toast" style="display:none"></div></div></div>\n</div>\n';
const CSS = '.bkmsa{--bg:#f3f6f7;--panel:#fff;--ink:#1b2530;--muted:#64707c;--line:#d3dbe1;--line2:#e7ecf0;--accent:#0d9488;--ref:#fff3e0;--reflab:#7a4b00;\n  --sel:#ff1493;--selbg:rgba(255,20,147,.12);--hover:rgba(13,148,136,.10);--shadow:0 6px 20px rgba(20,30,40,.14);--tick:#8a96a3;--rep:#6b7480;--gap:#eef2f5;--inv:#7c3aed;--disp:#d98200;--abs:#c9d1d8}.bkmsa *{box-sizing:border-box}.bkmsa{background:var(--bg);color:var(--ink);font:13px/1.45 "IBM Plex Sans",system-ui,sans-serif;display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}.bkmsa .chips{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.bkmsa .chip{font:11.5px "IBM Plex Mono",monospace;color:var(--muted);border:1px solid var(--line2);border-radius:999px;padding:2px 9px;background:var(--bg)}.bkmsa .chip b{color:var(--ink);font-weight:500}.bkmsa .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .grp{display:flex;align-items:center;gap:5px;padding-right:12px;border-right:1px solid var(--line2)}.bkmsa .grp:last-child{border-right:0}.bkmsa .grp .t{font-size:11.5px;color:var(--muted);margin-right:2px}.bkmsa button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:3px 9px;font:12px "IBM Plex Sans",sans-serif;cursor:pointer}.bkmsa button:hover{border-color:var(--accent)}.bkmsa button[disabled]{opacity:.45;cursor:default}.bkmsa button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa button.mono{font-family:"IBM Plex Mono",monospace}.bkmsa button:focus-visible, .bkmsa input:focus-visible{outline:2px solid var(--sel);outline-offset:1px}.bkmsa label{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px}.bkmsa input[type=checkbox]{accent-color:var(--accent)}.bkmsa .crumbs{display:flex;align-items:center;gap:3px;flex-wrap:wrap}.bkmsa .crumbs .sep{color:var(--muted);font-size:12px}.bkmsa .crumb{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:2px 8px;font:12px "IBM Plex Mono",monospace;cursor:pointer}.bkmsa .crumb[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}.bkmsa .legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:var(--muted);padding:5px 16px;border-bottom:1px solid var(--line);background:var(--panel)}.bkmsa .legend canvas{vertical-align:middle}.bkmsa #bk_tip{position:absolute;z-index:9;max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);padding:6px 9px;font:11.5px/1.45 "IBM Plex Mono",monospace;color:var(--ink);pointer-events:none;display:none;white-space:normal;word-break:break-all}.bkmsa #bk_tip p{margin:0 0 4px}.bkmsa #bk_tip p:last-child{margin:0}.bkmsa #bk_tip .k{color:var(--muted)}.bkmsa #bk_tip .h{color:var(--accent);font-weight:500}.bkmsa #bk_tip .copied{color:var(--accent);font-size:10.5px}.bkmsa #bk_mini{padding:3px 16px 2px;background:var(--panel);border-bottom:1px solid var(--line)}.bkmsa #bk_minic{width:100%;height:18px;display:block;cursor:pointer}.bkmsa.compact .set,.bkmsa.compact .legend{display:none}.bkmsa #bk_compact{font-size:11.5px;padding:2px 7px;color:var(--muted)}.bkmsa .bkmain{flex:1;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr) 320px;grid-template-rows:40px 0px 1fr;min-height:0;background:var(--panel)}\n.bkmsa.gtrack .bkmain{grid-template-rows:40px 22px 1fr}.bkmsa:not(.gtrack) #bk_gtl,.bkmsa:not(.gtrack) #bk_gtwrap{display:none}\n.bkmsa #bk_gtl{grid-column:1/3;grid-row:2;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10px;color:var(--muted);padding:0 8px;display:flex;align-items:center;overflow:hidden;white-space:nowrap}.bkmsa #bk_gtwrap{grid-column:3;grid-row:2;overflow:hidden;position:relative;border-bottom:1px solid var(--line)}.bkmsa #bk_corner{grid-column:1/3;grid-row:1;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10.5px;color:var(--muted);padding:4px 8px;display:flex;align-items:flex-end;justify-content:space-between}.bkmsa #bk_hdrwrap{grid-column:3;grid-row:1;border-bottom:1px solid var(--line);position:relative;overflow:hidden}.bkmsa #bk_detail{grid-row:1/4;border-left:1px solid var(--line);padding:10px 12px;overflow:auto;font:12px/1.55 "IBM Plex Mono",monospace;user-select:text;-webkit-user-select:text}.bkmsa #bk_detail h3{font:600 12px "IBM Plex Sans",sans-serif;margin:0 0 6px;color:var(--muted);display:flex;justify-content:space-between;align-items:center}.bkmsa #bk_detail .k{color:var(--muted)}.bkmsa #bk_detail .h{color:var(--accent);font-weight:500}.bkmsa #bk_detail p{margin:0 0 8px}.bkmsa #bk_hoverbody{border-top:1px dashed var(--line);margin-top:6px;padding-top:6px;color:var(--muted)}.bkmsa #bk_hoverbody:empty{display:none}.bkmsa #bk_detail ul{margin:0 0 8px;padding-left:16px}.bkmsa #bk_detail li{margin:0}.bkmsa #bk_body{grid-column:1/4;grid-row:3;display:grid;grid-template-columns:var(--treew,130px) 176px minmax(0,1fr);overflow-y:auto;overflow-x:auto;min-height:0}.bkmsa #bk_treewrap{position:sticky;left:0;z-index:2;background:var(--panel)}.bkmsa #bk_labwrap{border-right:1px solid var(--line);position:sticky;left:var(--treew,130px);z-index:2;background:var(--panel)}.bkmsa .lab{position:absolute;left:0;right:0;height:30px;display:flex;align-items:center;padding:0 8px;font:11px "IBM Plex Mono",monospace;white-space:nowrap;overflow:hidden;\n  user-select:text;-webkit-user-select:text;border-bottom:1px solid var(--line2)}.bkmsa .lab.ref{background:var(--ref);color:var(--reflab)}.bkmsa .lab.hov{background:var(--hover)}.bkmsa .lab small{color:var(--muted);margin-left:6px;font-size:10px}.bkmsa #bk_gridwrap{position:relative}.bkmsa canvas{display:block}.bkmsa .sw{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:-1px;margin-right:4px}.bkmsa #bk_copybtn{font-size:11px;padding:1px 7px}.bkmsa .hapdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px;flex:none}\n.bkmsa #bk_toast{position:absolute;left:8px;top:6px;z-index:5;max-width:70%;background:var(--ink);color:#fff;padding:6px 10px;border-radius:6px;font:12px \'IBM Plex Sans\',sans-serif;box-shadow:var(--shadow);display:flex;gap:8px;align-items:center}.bkmsa #bk_toast button{font-size:11px}\n.bkmsa #bk_cutwrap{display:flex;align-items:center;gap:4px;margin-right:6px;flex:none}.bkmsa #bk_cut{width:100px;height:12px;margin:0;accent-color:var(--sel)}.bkmsa #bk_cuttxt{font-size:10px;color:var(--muted);white-space:nowrap}.bkmsa .lab.refin{box-shadow:inset 3px 0 var(--reflab)}.bkmsa #bk_tree .cl{cursor:pointer}.bkmsa #bk_treeinfo{font-size:10.5px;margin-left:4px}\n.bkmsa #bk_detail h3 .dbtns{display:inline-flex;gap:4px}.bkmsa #bk_wide,.bkmsa #bk_close{font-size:11px;padding:1px 7px}.bkmsa #bk_detail .jl{max-height:360px;overflow:auto}\n.bkmsa.detailwide #bk_detail{display:block;background:var(--panel);opacity:1;position:fixed;left:50%;top:7vh;transform:translateX(-50%);width:min(88vw,1120px);max-height:min(84vh,820px);z-index:1000;border:1px solid var(--line);border-radius:8px;box-shadow:0 14px 44px rgba(20,30,40,.28);padding:12px 18px;font-size:12.5px;line-height:1.6}\n.bkmsa.detailwide #bk_detail table{font-size:12.5px!important}.bkmsa.detailwide #bk_detail .jl{max-height:calc(min(84vh,820px) - 170px)}.bkmsa.detailwide #bk_detail td,.bkmsa.detailwide #bk_detail th{padding:2px 8px}\n.bkmsa #bk_bscroll{display:none;position:sticky;bottom:0;left:0;height:14px;overflow-x:scroll;overflow-y:hidden;background:var(--panel);border-top:1px solid var(--line2);z-index:3}.bkmsa #bk_bscroll>div{height:1px}\n@media (max-width:900px){.bkmain{grid-template-columns:0 120px 1fr 0}.bkmsa #bk_body{grid-template-columns:0 120px 1fr}.bkmsa #bk_detail{display:none}}\n';
export interface BlockRef { win: number; level: number; W: number; rank: number; name: string; ref_contig: number; x: number; span: number; tbp: number; nhap: number; label: string;  names?: string[]; site?: boolean; base?: boolean; tree?: boolean; a0?: number; a1?: number }
export interface GeneLite { name: string; start: number; end: number; strand?: string }
export interface BlockMsaHandle { selectByRef(contig: number, bp: number): boolean; locateNodes?(names: string[]): void; isTree?(): boolean; setGraphAtoms?(atoms: number[] | number[][]): void; openGraphRange?(): void; setHapMarks(m: Map<string, string>): void; setGenes(g: Map<number, GeneLite[]>): void; destroy(): void; _layout?: () => any }
// 現在見えている窓・段のブロック一覧（色つき）。App がグラフのノードをブロック色で塗るのに使う
export interface BlockView { win: number; level: number; W: number; mode: string; tree?: boolean; blocks: { rank: number; color: string; ref_contig: number; x: number; span: number; label: string; members: number[]; a0?: number; a1?: number }[]; scope: { contig: number; start: number; end: number } | null; scopeKey: string; sync: boolean; n0: number;
  xRange?: [number, number] | null; atomsIn?: [number, number] | null;   // 木・ブロックより下の段: 窓の合意座標の範囲と、それに重なる原子の番号の範囲（グラフの塗り）
  nodeNames?: string[] | null;                                             // 塩基の段: MSA に出ている葉ノード名（グラフは葉の層でこれだけを塗る）
  filterGraph?: boolean; filterRange?: [number, number] | null;           // グラフをこの窓の範囲に絞る（範囲外のノードと辺を描かない）。filterRange=窓の合意座標の張り（根＝null で絞らない）
  filterSel?: { atoms: [number, number] } | { cols: [number, number] } | null }   // 集合の意味での窓: ブロック窓＝原子の範囲、アレル行列／塩基＝原子の内側の列範囲。グラフの部分グラフと寄せ先はこれで引く
export interface BlockMsaCallbacks { onSelectBlock?: (b: BlockRef | null) => void; onHoverBlock?: (b: BlockRef | null) => void; onDrill?: (req: BlockDrillRequest) => Promise<BlockDrillResult>; onRange?: (x0: number, x1: number, label: string, depth: number, parent: number, pblock: number) => Promise<any>; onRangeAtoms?: (a0: number, a1: number, label: string, depth: number, parent: number) => Promise<any>; onSites?: (q: { c0?: number; c1?: number; x0?: number; x1?: number }) => Promise<any>; onTokRanges?: (c0: number, c1: number) => Promise<any>; onGenes?: (ranges: [string, number, number][]) => Promise<any>; onGenesCols?: (c0: number, c1: number, paths?: string[]) => Promise<any>; onGenesTok?: (ranges: [string, number, number][]) => Promise<any>; onOrth?: (c0: number, c1: number, max?: number) => Promise<any>; onOrthRows?: (c0: number, c1: number, paths?: string[]) => Promise<any>; onOrthGroup?: (og: number) => Promise<any>; onOrthFind?: (q: string, limit?: number) => Promise<any>; onFeature?: (q: { fid?: number; gid?: number }) => Promise<any>; onBaseVisible?: (v: { names: string[]; sync: boolean } | null) => void; onJunction?: (jid: number) => Promise<any>; onJunctions?: () => Promise<any>; onJunctionBase?: (jid: number, k?: number) => Promise<any>; onJunctionGenes?: (jid: number, n?: number) => Promise<any>; onBaseFetch?: (ranges: [string, number, number][], label: string, maxLeaves?: number) => Promise<any>; onLocate?: (names: string[]) => Promise<any>; onView?: (v: BlockView | null) => void; onSelectHap?: (groupKey: string, hap: string) => void; onBaseMsa?: (req: BlockDrillRequest) => void }
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
/* 参照コンティグ名を添えた座標（複数染色体のアトラスだけ。DATA.meta.refs = [{cid, key, name, length}]） */
function refName(cid){ const R = DATA && DATA.meta && DATA.meta.refs; if (!R || R.length < 2 || cid == null) return ''; const r = R.find(x => x.cid === cid); return r ? r.name : ''; }
function fmtref(x, cid){ const n = refName(cid); return (n ? n + ':' : '') + fmtbp(x); }
function fmtbp(x){ if (x>=1e6) return (x/1e6).toFixed(x>=1e7?1:2)+' Mb'; if (x>=1e3) return (x/1e3).toFixed(x>=1e5?0:1)+' kb'; return x+' bp'; }
// 範囲のラベル。両端が同じ表記に丸まるときは kb の桁を増やして区別する
function fmtRange(xa, xb){ let a = fmtbp(xa), b = fmtbp(xb); if (a !== b) return a + '–' + b;
  const tries = xa >= 1e6 ? [[1e6, 2, ' Mb'], [1e6, 3, ' Mb'], [1e3, 1, ' kb'], [1e3, 2, ' kb']] : xa >= 1e3 ? [[1e3, 1, ' kb'], [1e3, 2, ' kb'], [1e3, 3, ' kb']] : [];
  for (const [u, d, suf] of tries){ a = (xa/u).toFixed(d)+suf; b = (xb/u).toFixed(d)+suf; if (a !== b) return a + '–' + b; }
  return Math.round(xa)+' bp–'+Math.round(xb)+' bp'; }
const esc = s => String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

let _clades = null, _cladeByNode = null;   // 枝のまとめ（buildRows が作る。LY より先に要るので別変数）
const st = { ctgPack:'auto', beff:true, bvar:false, bz:null, bsx:0, selOg:null, treeMode:'global', treeCut:null, treeOpen:new Set(), localTree:null, localTreeKey:'', localTreeMs:0, graphAtoms:null, graphRuns:null, gfilter:false, lane:true, jmark:true, foldGap:true, marks:null, rowMode:'auto', baseDiff:true, baseCmp:'major', drilling:false, busy:null, anc:true, anc2:true, rangeSel:null, hoverRank:null, filter:null, filterPath:[], sync:true, onlySel:false, hapMarks:new Map(), genes:new Map(), colorBy:'order', win: 0, li: 0, mode:'msa', axis:'cons', order:'tree', origin:null, sel:null, hover:null, pinned:false, showMinor:true, bundle:true, showLinks:false, measure:'minor', norm:'abs'};
if (st.li<0) st.li=0;
st.li = Math.max(0, win().levels.length-1);   // 既定は最も粗い段
const cv = {hdr:$('hdr'), grid:$('grid'), mini:$('minic'), gtrack:$('gtrack')}; const GT_H = 22;
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
  const T = activeTree();
  const hapOrder = st.order==='tree' && T ? T.order.map(i=>nameToIdx.get(T.haps[i])).filter(i=>i!=null) : L.haps.map((h,i)=>i);
  const hapIndexByName = new Map(L.haps.map((h,i)=>[h.hap,i]));
  // 枝のまとめ: 閾値より右で閉じる部分木は代表 1 行（群の中心）だけ。LY.clades = 代表 hap → 群、LY.cladeByNode = 節 → 群
  const col = (st.order==='tree' && T) ? treeCollapse(T, new Set(L.haps.map(h=>h.hap))) : null; const hidden = new Set(); if (col) for (const g of col.values()) for (const m of g.members) if (m !== g.rep) hidden.add(m);
  _clades = col; _cladeByNode = col ? new Map([...col.values()].map(g => [g.node, g])) : null; const refSet = new Set(L.haps.filter(h => h.isref).map(h => h.hap));
  for (const hi0 of hapOrder){
    const h = L.haps[hi0]; if (!h) continue; if (hidden.has(h.hap)) continue;
    const gk = st.hapMarks.size ? matchHapToKey(h.hap, st.hapMarks.keys()) : null;
    if (st.onlySel && st.hapMarks.size && !gk) continue;          // 選択行のみ: グラフで選んだハプロタイプに合う行だけ
    const cl = col ? (col.get(h.hap) || null) : null;
    rows.push({label:h.hap, sub:`${h.contigs.length} ctg`, hap:h.hap, isref:h.isref, hapIdx:hi0, mark: gk ? st.hapMarks.get(gk) : null, gkey: gk, clade: cl, refin: !!(cl && !h.isref && cl.members.some(m => refSet.has(m))), contigs:h.contigs.map(c=>({c, seq:displaySeq(c)}))});
  }
  return rows;
}

// ---- 列（ブロック列＋隙間列）とスロット割り付け ----
let LY = null; let LY_pack = false;
// 段は「まとめ方」: 粗い段のブロックは最細段のブロックの集合（L.members[rank]）。最細段は自分自身
function membersOf(L, rank){ return (L.members && L.members[rank]) ? L.members[rank] : [rank]; }
function visibleBlocks(){ const L = level(); const out=[];
  L.blocks.forEach((b,i)=>{ if (!st.filter){ out.push(i); return; } if (membersOf(L, i).some(m=>st.filter.has(m))) out.push(i); });
  if (DATA.meta.circular && st.win===0) out.sort((a,b)=>rr(a)-rr(b)); return out; }
/* 各行の並び: コンティグを繋げて詰めるか（auto = 1 行のコンティグ数の中央値が 5 以上＝断片化したアセンブリ）。README 改訂 119 */
function ctgPackOn(rows){ if (st.mode !== 'own') return false; if (st.ctgPack === 'on') return true; if (st.ctgPack === 'off') return false; const n = rows.map(r => r.contigs.length).sort((a, b) => a - b); return n.length ? n[n.length >> 1] >= 5 : false; }
function computeLayout(){
  ensureLocalTree(); const L = level(); const rows = buildRows(); const vis = visibleBlocks(); const posOf = new Map(vis.map((b,i)=>[b,i]));   // block -> 列位置 (0..n-1)
  const n = vis.length; const pack = ctgPackOn(rows); LY_pack = pack;
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
    r.markers = []; r.ctgBreaks = [];
    // 詰めるとき: コンティグを合意の位置（主鎖のインスタンスの最小の列位置）の順に。各行の並びでもおおよそ合意と同じ左→右になる
    if (pack){ const key = ct => { let k = Infinity; for (const it of ct.items) if (it.o.kind < 4){ const v = it.slot.pos + (it.slot.lane ? 0.5 : 0); if (v < k) k = v; } return k; }; r.contigs = r.contigs.slice().sort((a, b) => key(a) - key(b)); }
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
        const bpw = colw0!=null ? Math.max(MINW, colw0) : Math.max(pack ? 1 : MINW, o.it[2]*(st.mode==='own'?sOwn:s));   /* 詰めるときは 1 px まで細くする */
        if (o.kind<4 && o.it.length>20 && o.it[20]) p_extra.ext = o.it[20];      // 合意範囲は上段・下段・両モードで持つ（リボンの相手範囲の交わりに使う）
        if (st.mode==='own'){ px = ownX; pw = bpw;
          if (st.foldGap && o.kind<4){ const parts = ownFoldPlan(o, p_extra, sOwn, !!(ct.c && ct.c.strand === '-')); if (parts){ let xx = px; for (const q of parts){ q.x = xx; xx += q.w; } pw = Math.max(MINW, xx - px); p_extra.parts = parts; } }
          ownX += pw + (pack ? 0 : 1); }
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
      if (st.mode==='own'){ if (pack){ if (placed.length){ ownX += 2; r.ctgBreaks.push(ownX - 1); } } else ownX += 8; }   /* 詰めるとき: コンティグの間は 2 px、切れ目は縦の細線（drawCtgBreaks） */
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
function layoutCanvases(){ const W = Math.max($('gridwrap').clientWidth, (LY && LY.fullW) ? LY.fullW : 0); const H = Math.max(RH, (LY?LY.rows.length:1)*RH); sizeCanvas(cv.grid, W, H); sizeCanvas(cv.hdr, W, 40); sizeCanvas(cv.gtrack, W, GT_H); $('labwrap').style.height = H+'px'; $('treewrap').style.height = H+'px'; if (!isBase()){ const el = $('bscroll'); if (el) el.style.display = 'none'; if (cv.grid.style.cursor === 'grab') cv.grid.style.cursor = ''; } }

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
// ---- 索引（変異サイト）を塩基の段の形にして同じ描画器で描く（README 改訂 118、2 段構成の第 2 段階）----
//   1 サイト = 1 列 = 1 群（kind 'site'、tc0/tc1 = 木の列の範囲、x = 合意座標、bp、nall、counts）。行の文字 = アレル番号（'A'+a、無い = '-'）。
//   群の区画の色は baseBlkAllele（出現頻度順、0 = 多数派）なので旧アレル行列と同じ見え方。塩基セルは出さない（M.indexBacked）。
//   拡大して 3,000 列以下の範囲が見えたら、その範囲の塩基の窓を子として開く（indexToBases）。ビン化済み・tooMany のときは旧 sites の段に落ちる
function sitesToBaseM(S, Lp){ const cells = sitesCells(S); const H = S.H; const refSet = new Set((Lp && Lp.haps || []).filter(h => h.isref).map(h => h.hap));
  const cols = S.sites.map((s, k) => ({ kind: 'site', nodes: ['site' + (k + 1)], g: k, rb: null, variant: true, off: 0, bp: s.bp, tc0: s.c0, tc1: s.c1, x: s.x, nall: s.nall, counts: s.counts }));
  const rows = S.haps.map((hap, h) => { const a = new Array(S.nsites); for (let k = 0; k < S.nsites; k++){ const v = cells[k * H + h]; a[k] = v === 255 ? '-' : String.fromCharCode(65 + Math.min(v, 57)); }
    return { samp: hap.split('#')[0], label: hap, path: hap, strand: '+', seq: a.join(''), isref: refSet.has(hap) ? 1 : 0, allele: 0, inv: [] }; });
  return { name: '索引', bp: null, refname: null, nrow: H, nallele: 0, scan: null, cols, rows, indexBacked: true }; }
function indexOrSitesWindow(S, label, parent, pblock, c0, c1){ if (!S.binned && !S.tooMany && S.nsites > 0 && S.nsites <= 20000){ const pw = WINS[parent]; const nw = baseWindow(sitesToBaseM(S, pw.levels[0]), label, parent, pblock, c0, c1); nw.indexBacked = true; nw.levels[0].sitesSrc = S; return nw; } return sitesWindow(S, label, parent, pblock, c0, c1); }
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
    const nw = indexOrSitesWindow(S, label, pw, pblock != null ? pblock : -1, S.c0, S.c1); nw.id = WINS.length; nw.plevel = st.li; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; nw.ms = S.ms || 0;
    enterWindow(nw.id); $('detailbody').innerHTML = S.binned ? `<p class="k">変異サイトが ${S.totalSites.toLocaleString()} 個あるので、${S.sitesPerBin} サイトずつ ${S.nsites} ビンにまとめた粗い段です（列 ${S.ncols}、${S.ncover} 株が被覆）。セルの濃さ＝参照と違うサイトの割合。列見出しをドラッグして狭めると、サイトごとのアレルの段へ降ります。</p>` : `<p class="k">変異サイト ${S.nsites} 個（列 ${S.ncols}、${S.ncover} 株が被覆）。セルの色＝アレル（灰＝参照側）。行は系統樹順。列見出しをドラッグで狭い区間へ、葉 ${BASE_MAX_LEAVES} 以下で塩基 MSA へ。</p>`;
  }).catch(e => { st.drilling = false; st.busy = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; }); }
// アレル行列の中のドラッグ: サイトの範囲 → 列の範囲。葉 400 以下なら親ブロックの錨で絞って塩基へ、そうでなければ狭いアレル行列
function sitesRange(xa, xb){ const S = sitesOf(); if (!S) return; const ks = []; S.sites.forEach((s_, k) => { if (s_.x + Math.max(1, s_.bp) > xa && s_.x < xb) ks.push(k); }); const label = fmtRange(xa, xb);
  // 範囲にサイトが無い（全株同一の区間）→ 合意座標で列を切る（400 列以下なら塩基、そうでなければ通知）
  if (!ks.length){ st.rangeSel = null; drawAll(); const L = level(); const nc = (L.c1 - L.c0 + 1) || 1; const W = Math.max(1, (S.nsites || 1) * (LY.siteW || 1)); const pa = (xa - (S.sites[0] ? S.sites[0].x : xa)), pb = (xb - (S.sites[0] ? S.sites[0].x : xb)); const c0_ = L.c0 + Math.max(0, Math.floor(Math.min(1, Math.max(0, pa / Math.max(1, (S.sites[S.nsites - 1].x + 1 - S.sites[0].x)))) * nc)), c1_ = L.c0 + Math.max(0, Math.ceil(Math.min(1, Math.max(0, pb / Math.max(1, (S.sites[S.nsites - 1].x + 1 - S.sites[0].x)))) * nc) - 1); zoomTo({ atom: atomOfCol(L.c0), c0: Math.min(c0_, c1_), c1: Math.max(c0_, c1_) }, label); return; }   /* サイトが無い区間: 窓の列区間を割合で切る */
  if (TREE){ const c0 = S.sites[ks[0]].c0, c1 = S.sites[ks[ks.length-1]].c1; st.rangeSel = null; drawAll(); zoomTo({ atom: atomOfCol(c0), c0, c1 }, label); return; }
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
// ---- 塩基の段のズーム軸（README 改訂 117、ブロックと塩基の 2 段構成）----
//   z = 1 塩基あたりの px。z < 3: 群（ノード）を 1 つの区画（幅 max(1, z × 塩基数)、行はアレル色）で描く＝俯瞰（旧アレル行列の見え方）。
//   3 ≤ z < 7: 塩基ごとのセル（文字なし）。z ≥ 7: 文字。入った直後は画面に収まる z（fit）。群が画面幅より多ければ変異のある群だけにする（自動）。
//   操作: Ctrl+ホイール／＋−ボタン／列見出しのドラッグ（その範囲を画面幅に）／格子のダブルクリック（2 段拡大）／「全体」「塩基」ボタン。
const Z_LADDER = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7, 10, 14]; const BASE_CELL_Z = 3, BASE_LETTER_Z = 7;
function bsx(){ return isBase() ? (st.bsx || 0) : 0; }   /* 塩基の段の仮想横スクロール量（px）。canvas は画面幅のまま、描画と当たり判定をこれだけずらす */
function baseScrollMax(){ const W = $('gridwrap').clientWidth; return Math.max(0, (LY.bfullW || 0) - W); }
function baseGroups(M){ if (M._groups) return M._groups; const cols = M.cols || []; const groups = []; cols.forEach((c, i) => { const last = groups[groups.length - 1]; if (last && last.g === c.g){ last.to = i; } else groups.push({ g: c.g, from: i, to: i, nodes: c.nodes, rb: c.rb }); });
  for (const gr of groups){ const cs = cols.slice(gr.from, gr.to + 1); const ell = cs.find(c => c.kind === 'ell'); gr.hasEll = !!ell || cs.some(c => c.kind === 'site'); gr.n = gr.to - gr.from + 1; gr.bp = ell ? (ell.bp || gr.n) : gr.n; gr.variant = cs.some(c => c.variant) || gr.nodes.length > 1; }   // サーバが畳んだ群は ell.bp がノード全長。variant = 行で塩基か有無が違う、または排他アレルが複数
  M._groups = groups; return groups; }
/* 群の幅: z ≥ 3 なら塩基ごとのセル（整数幅）、それ未満は 1 区画 max(gmin, z × 塩基数) */
function baseGroupWidth(gr, z, gmin){ return (z >= BASE_CELL_Z && !gr.hasEll) ? gr.n * Math.floor(z) : Math.max(gmin, z * gr.n); }
function baseFitZ(groups, W){ let lo = 0, hi = 14; for (let it = 0; it < 40; it++){ const m = (lo + hi) / 2; let s = 0; for (const gr of groups) s += baseGroupWidth(gr, m, 1); if (s <= W) lo = m; else hi = m; } return lo; }
function baseLayout(){ const M = baseOf(); const W = $('gridwrap').clientWidth - 8; const cols = M.cols || []; const groups = baseGroups(M);
  // 見せる群: 変異のある群だけ（手動 st.bvar、または全群が 1 px ずつでも入らないときは自動）
  const varG = groups.filter(gr => gr.variant); const autoVar = !st.bvar && groups.length > W && varG.length <= W; const vOnly = st.bvar || autoVar; const shown = vOnly ? varG : groups;
  // ズーム: st.bz が無ければ画面に収まる最大の z。収まらない（群の数 > 画面幅）ときは z = 0 で区画を等分（1 px 未満＝濃淡の地図）
  let gmin = 1; let z = st.bz; if (z == null){ z = baseFitZ(shown, W); if (shown.length * gmin > W){ z = 0; gmin = W / Math.max(1, shown.length); } }
  const cw = (z >= BASE_CELL_Z && !M.indexBacked) ? Math.floor(z) : 0;
  const items = [];
  for (const gr of shown){ if (cw && !gr.hasEll){ for (let i = gr.from; i <= gr.to; i++) items.push({ kind: 'col', ci: i, g: gr.g }); } else items.push({ kind: 'blk', ci0: gr.from, ci1: gr.to, n: gr.bp, g: gr.g, w: baseGroupWidth(gr, z, gmin) }); }
  const xs = new Float64Array(items.length + 1); let x = SITES_X0; const colItem = new Int32Array(cols.length).fill(-1);
  items.forEach((it, k) => { xs[k] = x; x += (it.kind === 'blk' ? it.w : cw); if (it.kind === 'col') colItem[it.ci] = k; else for (let i = it.ci0; i <= it.ci1; i++) colItem[i] = k; }); xs[items.length] = x;
  // 隠した群の列は次に見える項目へ（遺伝子の張りなどが切れないように。幅 0）
  { let nxt = items.length; for (let i = cols.length - 1; i >= 0; i--){ if (colItem[i] >= 0) nxt = colItem[i]; else colItem[i] = -1 - nxt; } }
  const gx = new Map(); items.forEach((it, k) => { const e = gx.get(it.g) || { x0: xs[k], x1: xs[k+1] }; e.x1 = xs[k+1]; gx.set(it.g, e); }); for (const gr of groups){ const e = gx.get(gr.g); gr.x0 = e ? e.x0 : 0; gr.x1 = e ? e.x1 : 0; }
  LY.bcw = cw; LY.bz = z; LY.bzFit = st.bz == null; LY.bvOnly = vOnly; LY.bautoVar = autoVar; LY.bxs = xs; LY.bitems = items; LY.bgroups = groups; LY.bcolItem = colItem; LY.bfullW = x + 4; LY.fullW = 0; LY.cols = []; LY.vis = []; LY.blockX = new Map();   /* fullW=0: canvas は画面幅のまま（横は仮想スクロール st.bsx） */
  st.bsx = Math.max(0, Math.min(st.bsx || 0, baseScrollMax())); baseScrollSync(); baseZoomText();
  if (!M._rowOf){ M._rowOf = new Map(); (M.rows || []).forEach((r, i) => M._rowOf.set(r.label, i)); const ri_ = (M.rows || []).findIndex(r => r.isref); M._refRow = ri_ >= 0 ? ri_ : ((M.rows || []).length ? 0 : null);
    const byNode = new Map(); cols.forEach((c, i) => { for (const nm of (c.nodes || [])){ const a = byNode.get(nm); if (a) a.push(i); else byNode.set(nm, [i]); } });   /* 行 × inv × 列の三重ループは 3 万列で重い → ノード→列の索引を 1 回 */
    M._inv = (M.rows || []).map(r => { const st_ = new Set(); for (const n of (r.inv || [])) for (const i of (byNode.get(n) || [])) st_.add(i); return st_; }); } }
function baseZoomLabel(){ const z = LY.bz || 0; const M = baseOf(); if (M && M.indexBacked) return z > 0 ? `索引の俯瞰 ${z.toFixed(2)} px/塩基相当（1 サイト = 1 列）` : '索引の俯瞰（サイト 1 px 未満）'; if (z >= BASE_LETTER_Z) return `${LY.bcw} px/塩基（文字）`; if (z >= BASE_CELL_Z) return `${LY.bcw} px/塩基`; if (z > 0) return `俯瞰 ${z.toFixed(2)} px/塩基（群は 1 px 以上）`; return '俯瞰（群 1 px 未満）'; }
function baseZoomText(){ const t = $('ztxt'); if (!t) return; t.textContent = baseZoomLabel() + (LY.bvOnly ? (LY.bautoVar ? ' · 変異のある群だけ（自動）' : ' · 変異のある群だけ') : ''); const zb = $('zbase'); if (zb) zb.disabled = (LY.bz || 0) >= BASE_LETTER_Z; }
/* ズームを z にする。anchorPx（画面 px）の下にある列を動かさない */
function setBaseZoom(z, anchorPx){ const w = win(); if (!w || !isBase()) return; const M = baseOf(); const ax = anchorPx != null ? anchorPx : ($('gridwrap').clientWidth / 2); const ci = baseColAt(ax + bsx()); const ciBase = ci != null ? ci : Math.floor((M.cols || []).length / 2);
  st.bz = z; w._bz = z; drawAll(); const xr = baseXOfCol(ciBase); if (xr) baseSetScroll(xr[0] - ax); }
/* 索引の俯瞰で木の列 [tc0, tc1] の塩基の窓を子として開く（3,000 列まで）。範囲を渡さなければ見えている範囲 */
function indexToBases(tc0, tc1){ const M = baseOf(); if (!M || !M.indexBacked) return false;
  if (tc0 == null){ const [k0, k1] = baseVisible(); if (k1 < k0) return false; const a = LY.bitems[k0], b = LY.bitems[k1]; tc0 = M.cols[a.kind === 'col' ? a.ci : a.ci0].tc0; tc1 = M.cols[b.kind === 'col' ? b.ci : b.ci1].tc1; }
  const n = tc1 - tc0 + 1; if (n > BASE_MAX_LEAVES){ toast(`この範囲は木の列 ${n.toLocaleString()} 個で、塩基の上限 ${BASE_MAX_LEAVES.toLocaleString()} を超えます。もう少し拡大するか、列見出しをドラッグして狭い範囲を選んでください`); return true; }
  const atom = atomOfCol(tc0); if (atom < 0) return false; openBaseCols(atom, tc0, tc1, `#${atom + 1} 列 ${tc0.toLocaleString()}–${tc1.toLocaleString()}`, 'c:' + atom + ':' + tc0 + '-' + tc1, undefined); return true; }
function baseZoomStep(dir, anchorPx){ const z = LY.bz || 0; { const M = baseOf(); if (M && M.indexBacked && dir > 0){ const nz0 = Z_LADDER.find(v => v > z + 1e-9); if (nz0 == null || nz0 >= BASE_CELL_Z){ indexToBases(); return; } } } let nz; if (dir > 0){ nz = Z_LADDER.find(v => v > z + 1e-9); if (nz == null) nz = Z_LADDER[Z_LADDER.length - 1]; if (dir > 1){ const i = Z_LADDER.indexOf(nz); nz = Z_LADDER[Math.min(Z_LADDER.length - 1, i + dir - 1)]; } } else { const below = Z_LADDER.filter(v => v < z - 1e-9); nz = below.length ? below[below.length - 1] : 0; if (nz === 0){ st.bz = null; const w = win(); if (w) w._bz = null; drawAll(); return; } }
  if (nz === z) return; setBaseZoom(nz, anchorPx); }
/* 列 [i0, i1] を画面幅に（列見出しのドラッグ）: 収まる最大の z にして、i0 を左端へ */
function baseZoomToCols(i0, i1){ const M = baseOf(); if (!M) return; const W = $('gridwrap').clientWidth - 8; const groups = (LY.bvOnly ? baseGroups(M).filter(g => g.variant) : baseGroups(M)).filter(g => g.to >= i0 && g.from <= i1); if (!groups.length) return;
  let z = baseFitZ(groups, W); if (z >= BASE_LETTER_Z) z = Math.min(14, Math.floor(z)); else if (z >= BASE_CELL_Z) z = Math.floor(z);
  const w = win(); st.bz = z; if (w) w._bz = z; drawAll(); const xr = baseXOfCol(i0); if (xr) baseSetScroll(xr[0] - SITES_X0); }
/* 横スクロールバー（#bk_bscroll）を仮想幅に合わせる。画面に入るなら隠す */
function baseScrollSync(){ const el = $('bscroll'); if (!el) return; const W = $('gridwrap').clientWidth; const on = isBase() && (LY.bfullW || 0) > W; el.style.display = on ? 'block' : 'none'; if (on){ el.firstElementChild.style.width = LY.bfullW + 'px'; if (Math.abs(el.scrollLeft - st.bsx) > 0.5) el.scrollLeft = st.bsx; } cv.grid.style.cursor = on ? 'grab' : ''; }
/* 見えている項目の範囲 [k0, k1]（xs の二分探索） */
function baseVisible(){ const xs = LY.bxs; const n = LY.bitems ? LY.bitems.length : 0; if (!n) return [0, -1]; const sx = bsx(), vw = $('gridwrap').clientWidth; let lo = 0, hi = n; while (lo < hi){ const m = (lo + hi) >> 1; if (xs[m + 1] <= sx) lo = m + 1; else hi = m; } const k0 = lo; hi = n; while (lo < hi){ const m = (lo + hi) >> 1; if (xs[m] < sx + vw) lo = m + 1; else hi = m; } return [k0, lo - 1]; }
let _visTimer = null, _visKey = '';
/* 塩基の段で見えている範囲のノード名（最大 600、等間隔）を App へ。グラフで薄く囲い、グラフ連動なら寄せる（README 改訂 121） */
function emitBaseVisible(){ if (!(cb && cb.onBaseVisible)) return; if (_visTimer) clearTimeout(_visTimer);
  _visTimer = setTimeout(() => { _visTimer = null; if (!isBase()){ if (_visKey){ _visKey = ''; cb.onBaseVisible(null); } return; } const M = baseOf(); if (!M || M.indexBacked) return; const [k0, k1] = baseVisible(); if (k1 < k0) return;
    const set = new Set(); for (let k = k0; k <= k1; k++){ const it = LY.bitems[k]; const c = M.cols[it.kind === 'col' ? it.ci : it.ci0]; for (const n of (c.nodes || [])) set.add(n); }
    let names = [...set]; if (names.length > 600){ const step = names.length / 600; names = Array.from({ length: 600 }, (_, i) => names[Math.floor(i * step)]); }
    const key = st.win + ':' + k0 + ':' + k1 + ':' + (st.sync ? 1 : 0); if (key === _visKey) return; _visKey = key; cb.onBaseVisible({ names, sync: !!st.sync }); }, 400); }
function baseSetScroll(x){ const nx = Math.max(0, Math.min(x, baseScrollMax())); if (nx === st.bsx) return; st.bsx = nx; win()._bsx = nx; baseScrollSync(); drawGrid(); drawHeader(); emitBaseVisible(); }
function baseCellColor(ch){ const c = BASE_COLORS[ch.toUpperCase()] || BASE_COLORS.N; return c; }
// 比較の基準（列見出しの下段に出し、「参照一致を省く」の基準になる）: 参照パスの行、または列ごとの多数派の塩基
function baseCmpSeq(M){ if (st.baseCmp === 'major'){ if (!M._major){ const n = (M.cols || []).length; const out = new Array(n).fill('-');
      for (let i = 0; i < n; i++){ const cnt = new Map(); for (const r of M.rows){ const ch = r.seq[i]; if (!ch || ch === '-' || ch === '~') continue; cnt.set(ch, (cnt.get(ch) || 0) + 1); } let best = '-', bn = 0; for (const [ch, c] of cnt) if (c > bn){ bn = c; best = ch; } out[i] = best; } M._major = out; }
    return { seq: M._major, label: '多数派（列ごとの最頻の塩基）', isRow: null }; }
  const rr = M._refRow != null ? M.rows[M._refRow] : null; return rr ? { seq: rr.seq, label: (rr.isref ? '参照パス ' : '先頭の行 ') + rr.label, isRow: M._refRow } : { seq: null, label: '', isRow: null }; }
function baseFontPx(cw, h){ return Math.max(0, Math.min(13, h - 2, Math.floor(cw / 0.62))); }
// 区画（畳んだ群）の中でのこの行のアレル番号: 群の中の隙間を除いた配列が同じ行は同じアレル。番号は多い順（0 = 多数派）。持たない行は -1
function baseBlkAllele(M, it, mi){ if (!M._blk) M._blk = new Map(); let e = M._blk.get(it.ci0); if (!e){ const cnt = new Map(); const keys = []; for (const r of M.rows){ const k = r.seq.slice(it.ci0, it.ci1 + 1).replace(/-/g, ''); keys.push(k); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
    const order = [...cnt.entries()].sort((u, v) => v[1] - u[1] || (u[0] < v[0] ? -1 : 1)).map(([k]) => k); const idx = new Map(order.map((k, i) => [k, i])); e = { per: keys.map(k => (k ? idx.get(k) : -1)), n: order.length, counts: order.map(k => cnt.get(k)), lens: order.map(k => k.length) }; M._blk.set(it.ci0, e); } return mi != null && mi < e.per.length ? e.per[mi] : -1; }
// 比較の基準のアレル: 参照行ならその行のアレル、多数派なら 0（最も多いアレル）
function baseBlkCmp(M, it){ const ri = st.baseCmp === 'major' ? null : M._refRow; return ri != null ? baseBlkAllele(M, it, ri) : 0; }
function fmtBpShort(n){ return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
function drawBaseGrid(){ const M = baseOf(); if (!M || !LY.bxs) return; const g = cv.grid.getContext('2d'); const cols = M.cols || []; const xs = LY.bxs; const items = LY.bitems; const cw = LY.bcw; const hcell = RH - 2; const fpx = baseFontPx(cw, hcell); const letters = cw >= 5 && fpx >= 8; g.font = `bold ${fpx}px "IBM Plex Mono"`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const cmp = baseCmpSeq(M); const cmpSeq = cmp.seq; const [k0, k1] = baseVisible(); g.save(); g.translate(-bsx(), 0); const BE = (st.beff && genesOn()) ? ensureEffects() : null;
  LY.rows.forEach((r, ri) => { const mi = M._rowOf.get(r.hap); if (mi == null) return; const row = M.rows[mi]; const y = ri*RH + 1, h = hcell; const inv = M._inv[mi];
    for (let k = k0; k <= k1; k++){ const it = items[k]; const x = xs[k], w = xs[k+1] - xs[k] - (cw >= 8 ? 1 : 0);
      if (it.kind === 'blk'){ const a = baseBlkAllele(M, it, mi); if (a < 0) continue;   // この行はこの群を持たない
        const same = st.baseDiff && baseBlkCmp(M, it) === a;   // 基準（参照行か多数派）と同じアレル → 省く（塩基の · と同じ扱い）
        g.fillStyle = same ? TH.line2 : SITES_COLORS[Math.min(a, SITES_COLORS.length - 1)]; g.fillRect(x, y + 1, w, h - 2);
        if (inv){ for (let i = it.ci0; i <= it.ci1; i++) if (inv.has(i)){ g.fillStyle = TH.inv; g.fillRect(x, y, w, 2); break; } } continue; }
      const ch = row.seq[it.ci]; if (ch === '-' || ch === undefined) continue;
      if (ch === '~'){ g.fillStyle = TH.line; g.fillRect(x, y + 2, w, h - 4); continue; }
      if (st.baseDiff && cmpSeq && cmpSeq[it.ci] === ch){ g.fillStyle = TH.line2; g.fillRect(x, y, w, h); if (letters){ g.fillStyle = TH.muted; g.fillText('·', x + w/2, y + h/2 + 1); } continue; }   // 基準と一致 → 省く（基準の配列は列見出しの下段）
      const col = baseCellColor(ch); g.fillStyle = col[1]; g.fillRect(x, y, w, h); if (letters){ g.fillStyle = col[0]; g.fillText(ch, x + w/2, y + h/2 + 1); }
      if (inv && inv.has(it.ci)){ g.fillStyle = TH.inv; g.fillRect(x, y, w, 2); } }
    const EC = BE ? BE.code.get(r.hap) : null; if (EC) for (let k = k0; k <= k1; k++){ const it = items[k]; const ec = it.kind === 'col' ? EC[it.ci] : effMaxIn(EC, it.ci0, it.ci1); if (!ec) continue; g.fillStyle = EFF_COL[ec]; g.fillRect(xs[k], y, Math.max(1, xs[k+1] - xs[k] - (cw >= 8 ? 1 : 0)), ec === 8 ? 1 : 2); } });   /* 変異の効果（段階 A）。区画は群の中で最も重いもの */
  if (st.hover && st.hover.ci != null){ const k = LY.bcolItem && st.hover.ci < LY.bcolItem.length ? LY.bcolItem[st.hover.ci] : -1; if (k >= 0 && LY.bitems[k]){ g.fillStyle = TH.hover; g.fillRect(xs[k], 0, xs[k+1]-xs[k], cv.grid.clientHeight); } }
  g.restore(); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; }
function drawBaseHeader(){ const M = baseOf(); if (!M || !LY.bxs) return; const gh = cv.hdr.getContext('2d'); const Hh = cv.hdr.clientHeight; gh.clearRect(0, 0, cv.hdr.clientWidth, Hh); gh.textBaseline = 'alphabetic'; const _vx0 = bsx(), _vx1 = _vx0 + cv.hdr.clientWidth; gh.save(); gh.translate(-_vx0, 0);
  const xs = LY.bxs, items = LY.bitems, cw = LY.bcw; const cmp = baseCmpSeq(M); const refRow = cmp.seq ? { seq: cmp.seq } : null;
  // 上段（0..16）: ノードの帯と大きさ。下段（17..Hh-6）: 比較の基準の配列（参照パス or 多数派）。底（Hh-5..）: 錨・variant の印
  // 上段 = ノードの帯: 1 ノード（群）＝ 1 つの箱。箱の中に名前と長さ（bp）。複数の排他アレルを 1 列に重ねた群は上に青緑の帯線。
  // 以前は群の左端に 1 本の縦線（複数アレルだけ緑）と、幅が狭いと単位の無い数字だけを出していて意味が読めなかった（2026-10-07）
  LY.bgroups.forEach((gr, k) => { if (gr.x1 <= gr.x0 || gr.x1 < _vx0 || gr.x0 > _vx1) return; const w = gr.x1 - gr.x0; gh.fillStyle = k % 2 ? TH.line2 : TH.gap; gh.fillRect(gr.x0, 0, w, 16);
    gh.fillStyle = TH.line; gh.fillRect(gr.x0, 0, 1, 16); gh.fillRect(gr.x1 - 1, 0, 1, 16);                                   // 箱の仕切り（両端）
    if (gr.nodes.length > 1){ gh.fillStyle = TH.accent; gh.fillRect(gr.x0, 0, w, 3); }                                        // 排他アレルの群
    gh.font = '10px "IBM Plex Mono"'; gh.textAlign = 'left';
    const sc = M.indexBacked ? M.cols[gr.from] : null; const nm = sc ? ('列 ' + sc.tc0.toLocaleString() + (sc.tc1 !== sc.tc0 ? '–' + sc.tc1.toLocaleString() : '')) : gr.nodes[0] + (gr.nodes.length > 1 ? '+' + (gr.nodes.length - 1) : ''); const bp = gr.bp.toLocaleString() + ' bp';
    const label = w >= 118 ? `${nm} · ${bp}` : (w >= 62 ? nm : (w >= 40 ? bp : ''));                                           // 名前を優先。数字だけは出さない
    if (label){ gh.fillStyle = TH.ink; gh.fillText(label, gr.x0 + 4, 12); }
    if (gr.rb){ gh.fillStyle = TH.accent; gh.fillRect(gr.x0, Hh - 5, w, 2); }
    if (gr.variant){ gh.fillStyle = TH.disp; gh.fillRect(gr.x0 + 1, Hh - 3, Math.max(1, w - 2), 3); } });
  // 参照の配列（参照行が無ければ先頭の行）
  if (refRow){ const y = 18, h = Hh - 6 - 18; const fpx = baseFontPx(cw, h); gh.font = `bold ${fpx}px "IBM Plex Mono"`; gh.textAlign = 'center'; gh.textBaseline = 'middle';
    const [_k0, _k1] = baseVisible(); for (let k = _k0; k <= _k1; k++){ const it = items[k]; const x = xs[k], w = xs[k+1] - xs[k] - (cw >= 8 ? 1 : 0);
      if (it.kind === 'blk'){ const a = baseBlkCmp(M, it); gh.fillStyle = a >= 0 ? SITES_COLORS[Math.min(a, SITES_COLORS.length - 1)] : TH.gap; gh.fillRect(x, y + 1, w, h - 2);
        if (w >= 26){ gh.fillStyle = a >= 0 ? '#fff' : TH.muted; gh.font = `bold ${Math.min(fpx, 10)}px "IBM Plex Mono"`; gh.fillText(fmtBpShort(it.n), x + w/2, y + h/2 + 1); gh.font = `bold ${fpx}px "IBM Plex Mono"`; } continue; }
      const ch = refRow.seq[it.ci]; if (!ch || ch === '-'){ gh.fillStyle = TH.gap; gh.fillRect(x, y + 1, w, h - 2); continue; }
      if (ch === '~'){ gh.fillStyle = TH.line; gh.fillRect(x, y + 1, w, h - 2); continue; }
      const col = baseCellColor(ch); gh.fillStyle = col[1]; gh.fillRect(x, y, w, h); if (cw >= 5 && fpx >= 8){ gh.fillStyle = col[0]; gh.fillText(ch, x + w/2, y + h/2 + 1); } }
    gh.textBaseline = 'alphabetic'; gh.textAlign = 'left'; }
  if (st.sel != null && LY.bgroups[st.sel]){ const gr = LY.bgroups[st.sel]; gh.strokeStyle = TH.sel; gh.lineWidth = 1.5; gh.strokeRect(gr.x0 + .5, .5, gr.x1 - gr.x0 - 1, Hh - 1); }
  gh.restore();   /* ここから画面座標（範囲選択の帯は画面の px） */
  if (st.rangeSel){ gh.fillStyle = TH.selbg; gh.globalAlpha = .6; gh.fillRect(st.rangeSel[0], 0, st.rangeSel[1]-st.rangeSel[0], Hh); gh.globalAlpha = 1; } }
function baseGroupAt(px){ if (!LY.bgroups) return null; for (let k = 0; k < LY.bgroups.length; k++){ const gr = LY.bgroups[k]; if (px >= gr.x0 && px < gr.x1) return k; } return null; }
function baseItemAt(px){ const xs = LY.bxs; if (!xs || xs.length < 2 || px < xs[0] || px >= xs[xs.length - 1]) return null; let lo = 0, hi = xs.length - 2; while (lo < hi){ const m = (lo + hi + 1) >> 1; if (xs[m] <= px) lo = m; else hi = m - 1; } return lo; }
function baseColAt(px){ const k = baseItemAt(px); if (k == null) return null; const it = LY.bitems[k]; return it.kind === 'col' ? it.ci : it.ci0; }
function baseGroupInfo(k, ri, ci){ const M = baseOf(); const gr = LY.bgroups[k]; const r = ri != null ? LY.rows[ri] : null; const mi = r ? M._rowOf.get(r.hap) : null; const row = mi != null ? M.rows[mi] : null; const col = ci != null ? M.cols[ci] : null;
  if (M.indexBacked){ const sc = M.cols[gr.from]; const kk = LY.bcolItem ? LY.bcolItem[gr.from] : -1; const it = kk >= 0 ? LY.bitems[kk] : null; const a = (it && mi != null) ? baseBlkAllele(M, it, mi) : -1;
    return `<p><span class="h">サイト ${k + 1}</span> <span class="k">木の列 ${sc.tc0.toLocaleString()}${sc.tc1 !== sc.tc0 ? '–' + sc.tc1.toLocaleString() : ''}（${(sc.tc1 - sc.tc0 + 1).toLocaleString()} 列）· 合意 ${fmtbp(sc.x)} · ${sc.bp.toLocaleString()} bp · アレル ${sc.nall} 種（株数 ${(sc.counts || []).slice(0, 6).join('/')}${(sc.counts || []).length > 6 ? '…' : ''}）</span>${row ? `<br><span class="k">${esc(row.label)}:</span> ${a < 0 ? '持たない' : 'アレル #' + (a + 1) + (a === 0 ? '（多数派）' : '')}` : ''}<br><span class="k">索引の俯瞰（1 サイト = 1 列、錨の間の区間）。塩基は「塩基」ボタンか列見出しのドラッグで（3,000 列まで）</span></p>`; }
  const bit = LY.bitems ? LY.bitems.find(it => it.kind === 'blk' && it.g === gr.g) : null; let blk = '';
  if (bit){ baseBlkAllele(M, bit, 0); const e = M._blk.get(bit.ci0); const a = mi != null ? baseBlkAllele(M, bit, mi) : -1; blk = `<br><span class="k">この倍率では群を 1 区画で表示（Ctrl+ホイールか＋で拡大すると塩基が出る）。アレル ${e.n} 種: ${e.lens.slice(0, 4).map((L, i) => `#${i + 1} ${L.toLocaleString()} bp × ${e.counts[i]} 行`).join('、')}${e.n > 4 ? '…' : ''}${a >= 0 ? `。この行はアレル #${a + 1}` : ''}</span>`; }
  return `<p><span class="h">ノード ${esc(gr.nodes.join(' | '))}</span>${gr.nodes.length > 1 ? `<br><span class="k">同じサイトの排他アレル ${gr.nodes.length} 個を 1 列に重ねた群（帯の上の青緑線）</span>` : ''}<br><span class="k">ノードの長さ ${gr.bp.toLocaleString()} bp${gr.rb ? ` · 参照 ${fmtbp(gr.rb)}` : ''}${gr.variant ? ' · 行間で塩基が違う' : ''}</span>${blk}` +
    (row ? `<br><span class="k">${esc(row.label)}（${row.strand} 鎖）:</span> ${col ? (row.seq[ci] === '-' ? '欠失（gap）' : row.seq[ci] === '~' ? '畳んだ部分' : `塩基 ${esc(row.seq[ci])}${col.off != null ? '（ノード内 ' + (col.off + 1) + ' 塩基目）' : ''}`) : ''}${(M._inv[mi] && ci != null && M._inv[mi].has(ci)) ? ' · 周りと逆向きに通過（逆相補で表示）' : ''}` : '') + (r && ci != null ? effectInfo(r.hap, ci) : '') + `</p>`; }
function baseRef(k){ const M = baseOf(); if (!M || k == null || !LY.bgroups || !LY.bgroups[k]) return null; const gr = LY.bgroups[k]; const L = level();
  return { win: st.win, level: st.li, W: 0, rank: k, name: gr.nodes[0], ref_contig: (L.refc != null ? L.refc : 0), x: gr.rb || 0, span: Math.max(1, gr.bp), tbp: gr.bp, nhap: 0, label: gr.nodes.join('|'), names: gr.nodes, base: true }; }
function baseWindow(M, label, parent, pblock, c0, c1, order0){ const pw = WINS[parent]; const Lp = pw.levels[0];
  // 行 = MSA の行（同じハプロタイプの複数通過は ·2 の別行）。順序は親の行順（系統樹順）。order0（hap → 並び鍵）があればそれを優先（接合の塩基: 共有の多い順）
  const order = new Map(); Lp.haps.forEach((h, i) => order.set(h.hap, (order0 && order0.has(h.hap)) ? order0.get(h.hap) : 1e6 + i)); const key = lb => lb.replace(/·\d+$/, '');
  const rows = (M.rows || []).slice().sort((a, b) => ((order.get(key(a.label)) ?? 1e9) - (order.get(key(b.label)) ?? 1e9)) || (a.label < b.label ? -1 : 1));
  const haps = rows.map(r => ({ hap: r.label, isref: r.isref ? 1 : 0, contigs: [{ name: '', path: r.path || '', strand: r.strand || '+', start: 0, bp: 0, nsteps: 0, inst: [], minor: [] }] }));
  const refc = Lp.refc != null ? Lp.refc : (Lp.blocks && Lp.blocks[0] ? (Lp.blocks[0].ref_contig || 0) : 0);
  return { id: -1, parent, pblock, depth: pw.depth + 1, label, atoms: 0, H: haps.length, children: {}, mode: 'base', anchors: null, ondemand: true, tree: true,
    levels: [{ W: 0, nblocks: 0, blocks: [], haps, mergecap: 0, mode: 'base', adj: [], events: {}, origin: 0, merges: 0, members: null, nonmono: 0, base: M, c0, c1, refc }] }; }
// 塩基の窓を開く（各行のトークン範囲 → bubble MSA と同じ計算 → パネル内に描く）。onBaseFetch が無ければ従来どおり別パネルへ
function openBase(ranges, label, pblock, c0, c1, maxLeaves, xr, opts){ if (!ranges || !ranges.length) return;
  if (!(cb && cb.onBaseFetch)){ if (cb && cb.onBaseMsa) cb.onBaseMsa({ ranges, span: 0, afrac: 0, label, depth: win().depth + 1, parent: st.win, pblock: pblock != null ? pblock : -1 }); return; }
  const pw = st.win; const key = 'b:' + (c0 != null ? c0 + ':' + c1 : label); const w = win(); const ch = w.children ? w.children[key] : null; if (ch != null){ enterWindow(ch); return; }
  st.drilling = true; st.busy = `${label} の塩基レベル MSA を計算しています…（${ranges.length} 行）`; updateButtons(); drawGrid(); $('detailbody').innerHTML = `<p class="k">${esc(st.busy)}</p>`;
  cb.onBaseFetch(ranges, label, Math.max(maxLeaves || 0, BASE_LEAF_REQ)).then(M => { st.drilling = false; st.busy = null;
    if (!M || M.error || !M.cols || !M.cols.length){ drawAll(); notice(`塩基レベル MSA を作れませんでした: ${esc((M && M.error) || '列がありません')}`); return; }
    let order0 = null; if (opts && opts.shared){ order0 = new Map(); for (const [hp, f] of Object.entries(opts.shared)){ const hap = (M.rows.find(r => r.path === hp) || {}).label; if (hap) order0.set(hap.replace(/·\d+$/, ''), hp === opts.path ? -1 : 1 - f); } }
    const nw = baseWindow(M, label, pw, pblock != null ? pblock : -1, c0, c1, order0); nw.range = xr || null; nw.ranges = ranges; nw.shared = (opts && opts.shared) || null; if (opts){ nw.focusHap = opts.hap || null; nw.byRanges = !!opts.byRanges; }   /* byRanges: 列範囲で表せない窓（接合の塩基）。遺伝子はトークン範囲で引き、グラフは葉の名前の集合で絞る */ nw.id = WINS.length; nw.plevel = st.li; WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id;
    enterWindow(nw.id); const ng = LY.bgroups ? LY.bgroups.length : 0; if (!st._bhint){ st._bhint = true; toast('俯瞰で入りました。Ctrl+ホイール・＋・格子のダブルクリックで拡大、「塩基」で文字まで。広いときは格子をドラッグして横に動かせます'); }
    let shareNote = ''; if (opts && opts.shared){ const fs = Object.entries(opts.shared).filter(([hp]) => hp !== opts.path).map(([, f]) => f); const full = fs.filter(f => f >= 0.9).length, part = fs.filter(f => f >= 0.1 && f < 0.9).length, none = fs.filter(f => f < 0.1).length; shareNote = `<p><span class="h">接合の株とノードを共有する株</span> <span class="k">ほぼ全部 ${full} · 一部 ${part} · ほぼ無し ${none}（行は共有の多い順。他株の範囲は共有する部分 ± 15 トークンに詰めてある。共有が無い株の塩基は別の配列＝相同でない、または pggb の同一性の閾値未満で別ノードのまま）</span></p>`; }
    $('detailbody').innerHTML = shareNote + `<p class="k">塩基の段: 列 ${M.cols.length}（ノード ${ng} 個）・行 ${M.rows.length}。列見出しの上段＝ノード（群）の帯: 名前と大きさ（bp。「n123[2] 1 bp」の [2] は同じサイトの排他アレル 2 個を 1 列に重ねたもの、緑の縦線はその群の左端）。下段＝比較の基準の配列（参照パスの行、または多数派）。「一致を省く」は基準と同じ塩基を · にする（基準が参照パスなら参照の行も · になる。配列は下段にある）。底の線＝参照座標の錨（青）・行間で塩基が違う（橙）。入った直後は画面に収まる俯瞰（群を 1 区画、行はアレル色＝旧アレル行列の見え方）。Ctrl+ホイール・＋・格子のダブルクリック・列見出しのドラッグで拡大すると塩基のセル、7 px/塩基で文字。「塩基」ボタンで一気に文字まで。画面を超えた分は格子のドラッグ／下のバー／Shift+ホイールで動かす。セルの上の紫線＝周りと逆向きに通ったノード（逆相補で表示）。</p>`;
  }).catch(e => { st.drilling = false; st.busy = null; drawAll(); $('detailbody').innerHTML = `<p class="k">失敗: ${esc(String(e))}</p>`; }); }

// 塩基の段の範囲選択: ドラッグした列の範囲に絞った入れ子の窓（cols/rows を切り出すだけ。再計算なし）
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
/* Blocks を開いたとき（根の窓）、グラフがズームしていれば「グラフの範囲を開く」を案内する（1 回だけ）。グラフで場所を決めてから MSA を見る経路 */
function offerGraphRange(){ if (st._offeredGR || st.win !== 0 || st.filter || !st.graphRuns || !st.graphRuns.length) return; const r = st.graphRuns[0]; const tot = (DATA.meta.atoms || []).reduce((t, a) => t + Math.max(1, a[1]), 0) || 1;
  if ((r.x1 - r.x0) > 0.3 * tot) return; st._offeredGR = true; toast(`グラフで見ている範囲（${fmtbp(r.x1 - r.x0)}）があります`, { label: 'その範囲を開く', run: () => openGraphRange(st.graphRuns && st.graphRuns[0]) }); }
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
function geneColorCols(ge){ return ge[4] ? GENE_COL.other : (ge[3] === 'cds' ? (GENE_COL[ge[2]] || GENE_COL.other) : GENE_COL.other); }   /* 列範囲の配列 [gid,name,strand,type,pseudo,…] 用（geneColor をこれに使うと [6]=end で全部灰になる。2026-10-16 修正） */
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
  return `<p><span class="h">${esc(g[5] || '(無名)')}</span> <span class="k">${esc(g[4])}${g[6] ? '・擬似' : ''} · コンティグ上 ${g[3]} 鎖${(hit.p.o && hit.p.o.dir === 0) ? `（この区間は逆向きに表示: 合意の向きでは ${relStrand(g, hit.p)}）` : ''} · ${g[1].toLocaleString()}–${g[2].toLocaleString()}（${(g[2] - g[1] + 1).toLocaleString()} bp）· ${esc(ctPath(hit.p.ct))}</span>` + (jc.length ? `<br><span class="k">破断点との関係:</span> ${jc.map(j => `${esc(j[3])} ${JN[j[4]] || j[4]}（接合 ${j[1].toLocaleString()}–${j[2].toLocaleString()}）`).join('、')}` : '') + (cb && cb.onFeature ? '<br><span class="copied">クリックで GFF の全項目</span>' : '') + `</p>`; }
function juncInfo(m){ const j = m.j; const JN = { split: '分断', isl: '他株の島の挿入点が遺伝子内', end: '遺伝子の端が接合区間内', inside: '遺伝子が接合区間に丸ごと', near: '近接のみ', '': '遺伝子なし' }; const TN = { inv: '逆位', trans: '転座', del: '欠失（原子を飛ばす）', ins: '挿入', abs: '島の有無' };
  const row = win()._genes.get(ctPath(m.p.ct)); const names = j[7] && j[7].length ? j[7] : (j[5] || []).map(gid => { const gg = row && row.genes ? row.genes.find(x => x[0] === gid) : null; return gg ? gg[5] : ('#' + gid); });
  return `<p><span class="h">破断点 ${TN[j[3]] || j[3]}</span> <span class="k">接合区間 ${j[1].toLocaleString()}–${j[2].toLocaleString()}（${Math.max(0, j[2] - j[1]).toLocaleString()} bp）· ${esc(ctPath(m.p.ct))}</span><br><span class="k">${JN[j[4]] || j[4]}${names.length ? ': ' + esc(names.join(', ')) : ''}${j[6] ? `（関係する遺伝子 ${j[6]}）` : ''}</span></p>`; }
// ---- 列範囲（アレル行列・塩基の窓）の遺伝子: 窓ごとに 1 回取り、hap → genes で持つ ----
function hapPathMap(){ if (!DATA._hapPath){ const m = new Map(); const L0 = DATA.windows[0].levels[0]; for (const h of (L0.haps || [])) for (const c of (h.contigs || [])) if (!m.has(h.hap)) m.set(h.hap, c.path); DATA._hapPath = m; } return DATA._hapPath; }
// 列範囲を持たない塩基の窓（接合の塩基）のうち、トークン範囲を持つ窓（自分か親）。列範囲を持つ窓に当たったら null
function rangesWinOf(w){ let p = w; for (let i = 0; i < 8 && p; i++){ const L0 = p.levels && p.levels[0]; if (L0 && L0.c0 != null && L0.c1 != null) return null; if (p.ranges && p.byRanges) return p; p = p.parent >= 0 ? WINS[p.parent] : null; } return null; }
function ensureGenesCols(w){ if (!genesOn() || !w || !(w.mode === 'sites' || w.mode === 'base') || w._gcols || w._gcolsLoading) return; const L0 = w.levels[0]; if (!L0) return;
  const byCols = L0.c0 != null && L0.c1 != null; const rw = byCols ? null : rangesWinOf(w); if (byCols ? !cb.onGenesCols : !(rw && cb.onGenesTok)) return;
  w._gcolsLoading = true; (byCols ? cb.onGenesCols(L0.c0, L0.c1) : cb.onGenesTok(rw.ranges)).then(r => { w._gcolsLoading = false; const m = new Map(); if (r && r.rows) for (const row of r.rows){ const a = m.get(row.hap) || []; a.push(...row.genes); m.set(row.hap, a); } w._gcols = m; if (win() === w){ drawGrid(); drawHeader(); } }).catch(() => { w._gcolsLoading = false; }); }
// 列の区間 → x（アレル行列: サイトの並び。塩基: ノードとオフセットで列を特定）
function sitesXOfCols(S, pc0, pc1){ const n = S.nsites; if (!n) return null; let lo = 0, hi = n; while (lo < hi){ const m = (lo + hi) >> 1; if (S.sites[m].c1 < pc0) lo = m + 1; else hi = m; } const k0 = lo; if (k0 >= n || S.sites[k0].c0 > pc1) return null; let k1 = k0; while (k1 + 1 < n && S.sites[k1 + 1].c0 <= pc1) k1++; return [SITES_X0 + k0*LY.siteW, SITES_X0 + (k1 + 1)*LY.siteW, k0, k1]; }
function baseColIndex(M, node, off){ if (!M._nodeOff){ M._nodeOff = new Map(); (M.cols || []).forEach((c, i) => { (c.nodes || []).forEach((nm, j) => { const o = (c.so && c.so[j] != null) ? c.so[j] : (c.off != null ? c.off : 0); if (o < 0) return; const key = nm + '|' + o; if (!M._nodeOff.has(key)) M._nodeOff.set(key, i); }); }); }   /* c.so = 格納向きのオフセット（逆相補で表示したノードは L-1-k。遺伝子の端は格納向きで来る） */ let i = M._nodeOff.get(node + '|' + off); if (i == null){ for (let d = 1; d <= 3 && i == null; d++){ i = M._nodeOff.get(node + '|' + (off - d)); if (i == null) i = M._nodeOff.get(node + '|' + (off + d)); } } return i == null ? -1 : i; }
/* 索引の俯瞰: 木の列 [pc0, pc1] に掛かるサイトの列範囲 → [x0, x1, k0, k1]。無ければ null */
function baseXOfTreeCols(M, pc0, pc1){ const cols = M.cols; let lo = 0, hi = cols.length; while (lo < hi){ const m = (lo + hi) >> 1; if (cols[m].tc1 < pc0) lo = m + 1; else hi = m; } const k0 = lo; if (k0 >= cols.length || cols[k0].tc0 > pc1) return null; let k1 = k0; while (k1 + 1 < cols.length && cols[k1 + 1].tc0 <= pc1) k1++; const xa = baseXOfCol(k0), xb = baseXOfCol(k1); return (xa && xb) ? [xa[0], xb[1], k0, k1] : null; }
function nextSiteX(M, pc0){ const cols = M.cols; let lo = 0, hi = cols.length; while (lo < hi){ const m = (lo + hi) >> 1; if (cols[m].tc0 < pc0) lo = m + 1; else hi = m; } const xr = lo < cols.length ? baseXOfCol(lo) : null; return xr ? [xr[0] - 1, xr[0] + 1] : null; }   /* サイトを含まない区間: 次のサイトの左に細く */
function baseXOfCol(ci){ const xs = LY.bxs, ci_ = LY.bcolItem; if (!xs || !ci_ || ci < 0 || ci >= ci_.length) return null; const k = ci_[ci]; if (k >= 0) return [xs[k], xs[k+1]]; const nx = -1 - k; return nx < xs.length ? [xs[nx], xs[nx]] : null; }   /* 隠した群の列は次の項目の左端（幅 0） */   /* 列 → 項目は索引で O(1)（遺伝子の印は行 × 群で呼ぶ） */
function geneSpanX(w, g){ const L = w.levels[0];
  if (w.mode === 'sites'){ const S = L.sites; const out = []; const big = g[7].reduce((a, pc) => Math.max(a, pc[1] - pc[0] + 1), 0);
    for (const pc of g[7]){ if (big >= 20 && pc[1] - pc[0] + 1 < 3) continue;   // 主な片があるとき、1〜2 列の飛び（合意順序でずれた私有ノード等）は描かない
      const r = sitesXOfCols(S, pc[0], pc[1]); if (r) out.push([r[0], r[1]]); } return out; }
  if (w.mode === 'base' && L.base.indexBacked){ const M = L.base; const out = []; for (const pc of (g[7] || [])){ const r = baseXOfTreeCols(M, pc[0], pc[1]); if (r) out.push([r[0], r[1]]); } if (!out.length && g[7] && g[7].length){ const t = nextSiteX(M, g[7][0][0]); if (t) out.push(t); } return out; }
  if (w.mode === 'base'){ const M = L.base; const i0 = baseColIndex(M, g[8], g[9]), i1 = baseColIndex(M, g[10], g[11]); if (i0 < 0 && i1 < 0) return []; const a = i0 >= 0 ? i0 : 0, b = i1 >= 0 ? i1 : (M.cols.length - 1); const xa = baseXOfCol(Math.min(a, b)), xb = baseXOfCol(Math.max(a, b)); if (!xa || !xb) return []; return [[xa[0], xb[1]]]; }
  return []; }
const PART_KIND = { CDS: 2, exon: 1, five_prime_UTR: 0, three_prime_UTR: 0, UTR: 0 };   /* レーンに描く GFF の子の行と重ね順（CDS が最前）。mRNA/transcript 等は遺伝子と同じ張りなので描かない */
function drawGeneLanesCols(g){ const w = win(); if (!st.lane || !w._gcols) return; const h = RH >= 22 ? 5 : 3;
  LY.rows.forEach((r, ri) => { const gs = w._gcols.get(r.hap); if (!gs) return; const y = ri*RH + RH - h; for (const ge of gs){ const col = geneColorCols(ge); const parts = (ge[13] || []).filter(p => PART_KIND[p[1]] != null);
      if (!parts.length){ for (const [x0, x1] of geneSpanX(w, ge)){ g.fillStyle = col; g.fillRect(x0, y, Math.max(1, x1 - x0), h); } continue; }
      // GFF の子の行がある遺伝子（README 改訂 114）: 遺伝子の張りは底の 1 px、UTR は細く、エキソンは薄く、CDS は濃く
      for (const [x0, x1] of geneSpanX(w, ge)){ g.fillStyle = col; g.globalAlpha = .6; g.fillRect(x0, y + h - 1, Math.max(1, x1 - x0), 1); g.globalAlpha = 1; }
      for (const pass of [0, 1, 2]) for (const p of parts){ if (PART_KIND[p[1]] !== pass) continue; for (const [x0, x1] of geneSpanX(w, p)){ const wv = Math.max(1, x1 - x0); g.fillStyle = col;
          if (pass === 2) g.fillRect(x0, y, wv, h); else if (pass === 1){ g.globalAlpha = .45; g.fillRect(x0, y, wv, h); g.globalAlpha = 1; } else { g.globalAlpha = .35; g.fillRect(x0, y + 1, wv, Math.max(1, h - 2)); g.globalAlpha = 1; } } } } }); }
/* 行 mi の塩基だけを数えた位置 ↔ 列（gap 列を飛ばす）。読み枠の目盛りに使う */
function baseUngapped(M, mi){ if (!M._ung) M._ung = new Map(); let U = M._ung.get(mi); if (U) return U; const seq = M.rows[mi].seq || ''; const n = seq.length; const posOf = new Int32Array(n).fill(-1); const colOf = []; for (let i = 0; i < n; i++){ const ch = seq[i]; if (ch && ch !== '-' && ch !== '~'){ posOf[i] = colOf.length; colOf.push(i); } } U = { posOf, colOf }; M._ung.set(mi, U); return U; }
// ---- 変異の効果（段階 A、README 改訂 115）----
//   塩基の窓で、座位（列の区間が重なる遺伝子の群）ごとに「モデル」＝最も多くの株が同じ列区間に持つ CDS の注釈を 1 つ選び、その株の読み枠
//   （CDS の片を転写の順に繋ぎ、先頭の phase を飛ばす＝GenBank の join と同じ）で**全行**のコドンを読む。比較の相手は列ごとの多数派（または参照）の
//   コドン。同義／非同義／終止獲得／終止喪失／開始喪失、indel は転写順の連なりごとに正味の長さで フレームシフト／インフレーム。フレームシフトの
//   下流は「読み枠がずれた区間」とし、その行自身の枠で翻訳して最初の終止を「終止獲得」に置く（擬似遺伝子がどこで切れるかが見える）。
//   注釈の無い行（擬似遺伝子・注釈漏れ・欠失）もモデルの枠で読む。合意配列に注釈は無いので、枠は必ずどれかの株の注釈から取る。
//   行の strand が '-' の行は表示用に逆相補されているので、GFF の鎖をひっくり返して読む向きを決める。
const AA64 = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'; const NT_IDX = { T: 0, C: 1, A: 2, G: 3, U: 0 };
const START_CODONS = new Set(['ATG', 'GTG', 'TTG']);   /* 表 11（細菌）。表 1 でも ATG は含まれる */
const COMP = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
function translate(c){ if (!c || c.length < 3) return '?'; const a = NT_IDX[c[0]], b = NT_IDX[c[1]], d = NT_IDX[c[2]]; if (a == null || b == null || d == null) return 'X'; return AA64[a * 16 + b * 4 + d]; }
const AA3 = { A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile', L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val', '*': 'Ter', X: 'Xaa', '?': '?' };
const EFF = { 1: '同義', 2: '非同義', 3: '終止獲得', 4: '終止喪失', 5: '開始喪失', 6: 'フレームシフト', 7: 'インフレーム indel', 8: '読み枠がずれた区間' };
const EFF_COL = { 1: '#8aa0b4', 2: '#e08a1e', 3: '#c9302c', 4: '#c9302c', 5: '#c9302c', 6: '#c9302c', 7: '#d4b000', 8: 'rgba(201,48,44,.5)' };
/* 遺伝子の CDS の片。親（転写産物）が複数なら（GENCODE）、CDS の合計長が最大の 1 本だけ（読み枠は 1 本の転写産物で決める） */
function cdsPartsOf(ge){ const cds = (ge[13] || []).filter(p => p[1] === 'CDS'); if (cds.length < 2) return cds; const by = new Map(); for (const p of cds){ const k = p[4] == null ? '' : String(p[4]); const e = by.get(k) || { len: 0, parts: [] }; e.len += Math.max(0, p[6] - p[5] + 1); e.parts.push(p); by.set(k, e); } if (by.size <= 1) return cds; let best = null; for (const e of by.values()) if (!best || e.len > best.len) best = e; return best.parts; }
function ensureEffects(){ const w = win(); const M = baseOf(); if (!w || !M || !w._gcols || M.indexBacked) return null; if (w._beff === undefined || w._beff === null){ try { w._beff = computeEffects(w, M); } catch (e) { console.warn('effects', e); w._beff = { code: new Map(), info: new Map(), loci: [], byGene: new Map(), error: String(e) }; } } return w._beff; }
function computeEffects(w, M){ const refRow = LY.rows.find(r => r.isref); return computeEffectsCore(M, w._gcols, refRow ? refRow.hap : null); }
/* 窓に依らない本体: M（塩基 MSA）、gcols（hap → 遺伝子の配列）、参照株。運命の表（窓を開かずに群の列区間を取る）からも呼ぶ */
function computeEffectsCore(M, gcols, refHap){ const t0 = Date.now(); const ncol = (M.cols || []).length; const rows = M.rows || [];
  if (!M._rowOf){ M._rowOf = new Map(); rows.forEach((r, i) => M._rowOf.set(r.label, i)); const ri_ = rows.findIndex(r => r.isref); M._refRow = ri_ >= 0 ? ri_ : (rows.length ? 0 : null); }
  const cmp = baseCmpSeq(M); const cmpSeq = cmp.seq || [];
  const code = new Map(), info = new Map(); for (const r of rows){ code.set(r.label, new Uint8Array(ncol)); info.set(r.label, new Map()); }
  // 遺伝子 → CDS の列区間（モデル候補）。片があれば CDS の片、無ければ cds 型の遺伝子そのもの
  const cands = [];
  for (const [hap, gs] of (gcols || new Map())){ const mi = M._rowOf.get(hap); if (mi == null) continue; const row = rows[mi];
    for (const ge of gs){ const cds = cdsPartsOf(ge); const segs = cds.length ? cds.map(p => ({ i0: baseColIndex(M, p[8], p[9]), i1: baseColIndex(M, p[10], p[11]), phase: Number(p[3]) || 0, s: p[5] })) : (ge[3] === 'cds' ? [{ i0: baseColIndex(M, ge[8], ge[9]), i1: baseColIndex(M, ge[10], ge[11]), phase: 0, s: ge[5] }] : []);
      const ok = segs.filter(s => s.i0 >= 0 && s.i1 >= 0); if (!ok.length) continue; const cA = Math.min(...ok.map(s => Math.min(s.i0, s.i1))), cB = Math.max(...ok.map(s => Math.max(s.i0, s.i1)));
      /* 表示の向きでの転写の向き: この行の注釈の開始（ゲノム座標の小さい端）の列と終了の列の大小で、表示がゲノムの向きと同じか（up）を測る。
         row.strand の意味に頼らず実データで決める（2026-10-16: strand で決めると全行の枠が逆になり全部に終止が出た） */
      const up = ok[0].i0 <= ok[0].i1; const eff = (ge[2] === '+') === up ? '+' : '-';
      cands.push({ hap, mi, ge, gid: ge[0], segs: ok, cA, cB, eff, pseudo: !!ge[4] || ge[3] === 'pseudogene', cds: ge[3] === 'cds' || cds.length > 0 }); } }
  // 座位: 区間の重なりが短い方の 50% 以上なら同じ座位
  cands.sort((a, b) => a.cA - b.cA || b.cB - a.cB); const loci = []; const byGene = new Map();
  for (const c of cands){ let L = null; for (let i = loci.length - 1; i >= 0 && i >= loci.length - 6; i--){ const l = loci[i]; const ov = Math.min(l.cB, c.cB) - Math.max(l.cA, c.cA) + 1; if (ov >= 0.5 * Math.min(l.cB - l.cA + 1, c.cB - c.cA + 1)){ L = l; break; } }
    if (!L){ L = { cA: c.cA, cB: c.cB, members: [], rows: new Map() }; loci.push(L); } L.members.push(c); L.cA = Math.min(L.cA, c.cA); L.cB = Math.max(L.cB, c.cB); byGene.set(c.hap + '|' + c.gid, L); }
  for (const L of loci){ // モデル: 擬似でない CDS のうち (cA, cB, 向き) が最も多いもの。同数なら参照株、次に最初
    const sig = new Map(); for (const c of L.members){ if (c.pseudo || !c.cds) continue; const k = c.cA + ':' + c.cB + ':' + c.eff; const e = sig.get(k) || { n: 0, first: c, ref: null }; e.n++; if (c.hap === refHap) e.ref = c; sig.set(k, e); }
    let best = null; for (const e of sig.values()) if (!best || e.n > best.n) best = e; if (!best){ const longest = L.members.slice().sort((a, b) => (b.cB - b.cA) - (a.cB - a.cA))[0]; best = { n: 0, first: longest, ref: null }; }
    const model = best.ref || best.first; L.model = model; L.modelN = best.n; L.name = model.ge[1]; L.eff = model.eff;
    const mrow = rows[model.mi]; const U = baseUngapped(M, model.mi); const dirUp = model.eff === '+';
    const segs = model.segs.slice().sort((a, b) => dirUp ? Math.min(a.i0, a.i1) - Math.min(b.i0, b.i1) : Math.max(b.i0, b.i1) - Math.max(a.i0, a.i1));
    // モデルの塩基の列（転写順）と、片ごとの「全列の範囲」（挿入の検出用）
    const mcols = []; const ranges = []; let first = true;
    for (const s of segs){ const lo = Math.min(s.i0, s.i1), hi = Math.max(s.i0, s.i1); const pa = U.posOf[lo], pb = U.posOf[hi]; if (pa < 0 || pb < 0) continue; const cs = []; if (dirUp){ for (let q = pa; q <= pb; q++) cs.push(U.colOf[q]); } else { for (let q = pb; q >= pa; q--) cs.push(U.colOf[q]); } const skip = first ? (s.phase || 0) : 0; first = false; for (let i = skip; i < cs.length; i++) mcols.push(cs[i]); ranges.push({ lo, hi, from: skip }); }
    L.mcols = mcols; L.ncodon = Math.floor(mcols.length / 3); if (L.ncodon < 2) continue;
    { const rdm = c => { const ch = mrow.seq[c]; const u = ch ? ch.toUpperCase() : 'N'; return dirUp ? u : (COMP[u] || 'N'); }; let stops = 0; for (let k = 0; k < L.ncodon - 1; k++) if (translate(rdm(mcols[3*k]) + rdm(mcols[3*k+1]) + rdm(mcols[3*k+2])) === '*') stops++; L.modelStops = stops; L.startCodon = rdm(mcols[0]) + rdm(mcols[1]) + rdm(mcols[2]); L.endCodon = translate(rdm(mcols[3*(L.ncodon-1)]) + rdm(mcols[3*(L.ncodon-1)+1]) + rdm(mcols[3*(L.ncodon-1)+2])); }   /* モデル自身の枠の検算（内部の終止が 0、先頭が開始コドン、末尾が終止なら枠は正しい） */
    const isM = new Uint8Array(ncol); for (const c of mcols) isM[c] = 1; const codonOfCol = new Int32Array(ncol).fill(-1); mcols.forEach((c, i) => { codonOfCol[c] = Math.floor(i / 3); });
    const rd = (seq, c) => { const ch = seq[c]; if (!ch || ch === '-' || ch === '~') return null; const u = ch.toUpperCase(); return dirUp ? u : (COMP[u] || 'N'); };
    const cmpCodon = k => { const a = rd(cmpSeq, mcols[3*k]), b = rd(cmpSeq, mcols[3*k+1]), d = rd(cmpSeq, mcols[3*k+2]); if (a && b && d) return a + b + d; return rd(mrow.seq, mcols[3*k]) + rd(mrow.seq, mcols[3*k+1]) + rd(mrow.seq, mcols[3*k+2]); };
    const ccache = new Map(); const CC = k => { let v = ccache.get(k); if (v === undefined){ v = cmpCodon(k); ccache.set(k, v); } return v; };
    // 転写順の全列（片の範囲の中）: モデルに塩基があるか、行に塩基があるかで aligned / 欠失 / 挿入
    const allCols = []; for (const rg of ranges){ if (dirUp){ for (let c = rg.lo; c <= rg.hi; c++) allCols.push(c); } else { for (let c = rg.hi; c >= rg.lo; c--) allCols.push(c); } }
    const firstM = mcols[0]; let startIdx = allCols.indexOf(firstM); if (startIdx < 0) startIdx = 0;
    for (const r of rows){ const seq = r.seq || ''; const EC = code.get(r.label); const EI = info.get(r.label); const S = { syn: 0, mis: 0, nonsense: 0, stopLost: 0, startLost: 0, fs: 0, inframe: 0, aaLen: null, modelAa: L.ncodon, absent: false, gene: L.name, outOfFrame: 0 };
      // (1) indel の連なりと読み枠のずれ
      let present = 0; const shiftBefore = new Int32Array(ncol); let shift = 0; let run = null; const runs = [];
      const flush = () => { if (!run) return; run.net = run.ins - run.del; const fsh = ((run.net % 3) + 3) % 3 !== 0; run.fs = fsh; for (const c of run.cols) EC[c] = fsh ? 6 : 7; if (fsh) S.fs++; else S.inframe++; shift = ((shift + run.net) % 3 + 3) % 3; run = null; };
      for (let i = startIdx; i < allCols.length; i++){ const c = allCols[i]; const m = isM[c] === 1; const b = rd(seq, c) != null; if (b) present++; shiftBefore[c] = shift;
        if (m && b){ flush(); } else if (m && !b){ if (!run) run = { cols: [], ins: 0, del: 0 }; run.cols.push(c); run.del++; } else if (!m && b){ if (!run) run = { cols: [], ins: 0, del: 0 }; run.cols.push(c); run.ins++; } }
      flush();
      if (!present){ S.absent = true; L.rows.set(r.label, S); continue; }
      for (const rn of runs) { /* 予備 */ }
      // (2) コドン比較（枠が合っていて indel を含まないコドンだけ）
      for (let k = 0; k < L.ncodon; k++){ const c1 = mcols[3*k], c2 = mcols[3*k+1], c3 = mcols[3*k+2]; if (EC[c1] === 6 || EC[c1] === 7 || EC[c2] === 6 || EC[c2] === 7 || EC[c3] === 6 || EC[c3] === 7) continue;
        const a = rd(seq, c1), b = rd(seq, c2), d = rd(seq, c3); if (!a || !b || !d) continue;
        if (shiftBefore[c1] !== 0){ EC[c1] = EC[c1] || 8; EC[c2] = EC[c2] || 8; EC[c3] = EC[c3] || 8; S.outOfFrame++; continue; }
        const cr = a + b + d; const cc = CC(k); if (cr === cc) continue; const ar = translate(cr), ac = translate(cc); let e;
        if (ar === ac) e = 1; else if (ar === '*') e = 3; else if (ac === '*') e = 4; else if (k === 0 && START_CODONS.has(cc) && !START_CODONS.has(cr)) e = 5; else e = 2;
        if (e === 1) S.syn++; else if (e === 2) S.mis++; else if (e === 3) S.nonsense++; else if (e === 4) S.stopLost++; else if (e === 5) S.startLost++;
        const ii = { k, cr, cc, ar, ac, e, gene: L.name, eff: L.eff }; for (const c of [c1, c2, c3]) if (rd(seq, c) !== rd(cmpSeq, c) || !rd(cmpSeq, c)){ EC[c] = e; EI.set(c, ii); } }
      // (3) この行自身の枠で翻訳: 最初の終止。モデルの終止より手前なら終止獲得（フレームシフトの下流でも）
      const own = []; const ownCol = []; for (let i = startIdx; i < allCols.length; i++){ const c = allCols[i]; const b = rd(seq, c); if (b){ own.push(b); ownCol.push(c); } }
      let stopAt = -1; for (let j = 0; j + 2 < own.length; j += 3){ if (translate(own[j] + own[j+1] + own[j+2]) === '*'){ stopAt = j / 3; break; } }
      S.aaLen = stopAt >= 0 ? stopAt : Math.floor(own.length / 3);
      if (stopAt >= 0 && stopAt < L.ncodon - 1){ const cs = [ownCol[3*stopAt], ownCol[3*stopAt+1], ownCol[3*stopAt+2]]; if (EC[cs[0]] !== 3){ for (const c of cs){ EC[c] = 3; EI.set(c, { k: stopAt, cr: own[3*stopAt] + own[3*stopAt+1] + own[3*stopAt+2], cc: CC(Math.min(L.ncodon - 1, codonOfCol[c] >= 0 ? codonOfCol[c] : stopAt)), ar: '*', ac: '?', e: 3, gene: L.name, eff: L.eff, trunc: true }); } S.nonsense++; } }
      else if (stopAt < 0 && translate(CC(L.ncodon - 1)) === '*' && shift !== 0){ const k = L.ncodon - 1; for (const c of [mcols[3*k], mcols[3*k+1], mcols[3*k+2]]) if (!EC[c]){ EC[c] = 4; EI.set(c, { k, cr: '', cc: CC(k), ar: '?', ac: '*', e: 4, gene: L.name, eff: L.eff }); } S.stopLost++; }
      S.fsNet = shift; S.trunc = S.aaLen != null && S.aaLen < 0.9 * L.ncodon; S.lof = !!(S.startLost || S.stopLost || S.trunc || (S.fs && shift !== 0));   /* 機能喪失: 開始喪失／終止喪失／タンパク質が 90% 未満に切れる／フレームシフトが末尾まで戻らない。下流で枠が戻る indel の組は置換の可能性（整列の癖）なので数えない */
      L.rows.set(r.label, S); } }
  return { code, info, loci, byGene, ms: Date.now() - t0 }; }
const EFF_RANK = { 0: 0, 8: 1, 1: 2, 7: 3, 2: 4, 6: 5, 5: 5, 4: 5, 3: 5 };
function effMaxIn(EC, a, b){ let best = 0; for (let c = a; c <= b; c++){ const v = EC[c]; if (v && EFF_RANK[v] > EFF_RANK[best]) best = v; } return best; }
function effectInfo(hap, ci){ const BE = (st.beff && genesOn()) ? ensureEffects() : null; if (!BE) return ''; const EC = BE.code.get(hap); if (!EC || !EC[ci]) return ''; const e = EC[ci]; const ii = BE.info.get(hap).get(ci);
  if (!ii) return `<br><span class="k">効果: <b style="color:${EFF_COL[e]}">${EFF[e]}</b>${e === 8 ? '（上流のフレームシフトで読み枠がずれている）' : ''}</span>`;
  const pos = `p.${AA3[ii.ac] || ii.ac}${ii.k + 1}${AA3[ii.ar] || ii.ar}`; return `<br><span class="k">効果（${esc(ii.gene)}${ii.eff === '-' ? '、− 鎖を逆相補で読む' : ''}）: コドン ${ii.k + 1} ${esc(ii.cc)}→${esc(ii.cr)} <b style="color:${EFF_COL[e]}">${EFF[e]}</b> ${ii.trunc ? '（この行自身の枠で翻訳した最初の終止）' : esc(pos)}</span>`; }
function effectsTsv(){ const BE = ensureEffects(); const out = [['hap', 'gene', 'codon', 'cmp_codon', 'codon_seq', 'cmp_aa', 'aa', 'effect', 'column'].join('\t')]; if (!BE) return out[0];
  for (const [hap, EI] of BE.info){ const seen = new Set(); for (const [ci, ii] of [...EI.entries()].sort((a, b) => a[0] - b[0])){ const key = ii.gene + '|' + ii.k + '|' + ii.e; if (seen.has(key)) continue; seen.add(key); out.push([hap, ii.gene, ii.k + 1, ii.cc, ii.cr, ii.ac, ii.ar, EFF[ii.e], ci + 1].join('\t')); } }
  for (const [hap, EC] of BE.code){ let s = -1; for (let c = 0; c <= EC.length; c++){ const v = c < EC.length ? EC[c] : 0; const isRun = v === 6 || v === 7 || v === 8; if (isRun && s < 0) s = c; if (!isRun && s >= 0){ const code = EC[s]; const L = BE.loci.find(l => l.cA <= s && s <= l.cB); out.push([hap, L ? L.name : '', '', '', '', '', '', EFF[code] + (code === 8 ? '' : ` ${c - s} bp`), (s + 1) + '-' + c].join('\t')); s = -1; } } }
  return out.join('\n'); }
function geneEffectSummary(ge, hap){ const BE = (st.beff && genesOn()) ? ensureEffects() : null; if (!BE) return ''; const L = BE.byGene.get(hap + '|' + ge[0]); if (!L || !L.rows) return ''; const S = L.rows.get(hap); if (!S) return '';
  return `<br>効果（多数派との比較、モデル ${esc(L.name)} の枠${L.model && L.model.hap === hap ? '＝この株' : ''}）: 同義 ${S.syn}・非同義 ${S.mis}・<b style="color:${S.lof ? EFF_COL[3] : 'inherit'}">${S.lof ? '機能喪失' : '機能喪失なし'}</b>（終止獲得 ${S.nonsense}・フレームシフト ${S.fs}${S.fs && S.fsNet === 0 ? '＝下流で枠が戻る' : ''}・開始喪失 ${S.startLost}・終止喪失 ${S.stopLost}）・インフレーム indel ${S.inframe}${S.aaLen != null ? ` · タンパク質 ${S.aaLen}/${S.modelAa} aa` : ''}${S.fs + S.inframe >= 3 ? ' · indel が多い（整列の乱れの可能性）' : ''}`; }
function drawGeneBandCols(gh, Hh){ const w = win(); if (!st.lane || !w._gcols) return; const L = w.levels[0]; const fw = rangesWinOf(w); const ref = (fw && fw.focusHap && LY.rows.find(r => r.hap === fw.focusHap)) || LY.rows.find(r => r.isref) || LY.rows[0]; if (!ref) return;   /* 接合の塩基: 見出しの帯はその接合の株の遺伝子 */ const gs = w._gcols.get(ref.hap); if (!gs) return;
  const y = Math.max(0, Hh - 10), h = 4;   // 底の錨・variant の印の上に薄く
  for (const ge of gs){ for (const [x0, x1] of geneSpanX(w, ge)){ gh.fillStyle = geneColorCols(ge); gh.globalAlpha = .9; gh.fillRect(x0, y, Math.max(1, x1 - x0), h); gh.globalAlpha = 1;
      if (w.mode === 'base' && ge[3] === 'cds' && x1 - x0 >= 24){ // 読み枠: CDS の片ごとに phase を引いた所からコドン境界に目盛り。この行の塩基だけを数える（gap 列は飛ばす）。片が複数＝プログラムされたフレームシフト（phase 2）や真核のエキソン
        const M = L.base; const mi = M._rowOf ? M._rowOf.get(ref.hap) : null; const U = mi != null ? baseUngapped(M, mi) : null;
        const cp = cdsPartsOf(ge); const segs = cp.length ? cp.map(p => [p[8], p[9], p[10], p[11], p[2], Number(p[3]) || 0]) : [[ge[8], ge[9], ge[10], ge[11], ge[2], 0]];
        if (U){ gh.fillStyle = TH.panel; for (const [n0, o0, n1, o1, strand, phase] of segs){ const i0 = baseColIndex(M, n0, o0), i1 = baseColIndex(M, n1, o1); if (i0 < 0 || i1 < 0) continue; const pa = U.posOf[Math.min(i0, i1)], pb = U.posOf[Math.max(i0, i1)]; if (pa < 0 || pb < 0) continue;
            const tick = q => { const xr = baseXOfCol(U.colOf[q]); if (xr && xr[0] >= x0 - 1 && xr[0] <= x1 + 1) gh.fillRect(xr[0], y, 1, h); };
            if (strand === '-'){ for (let q = pb - phase - 2; q >= pa; q -= 3) tick(q); } else { for (let q = pa + phase; q <= pb; q += 3) tick(q); } } } }
      if (x1 - x0 >= 40 && ge[1]){ gh.fillStyle = TH.ink; gh.font = '9px "IBM Plex Mono"'; gh.textAlign = 'left'; gh.fillText(ge[1], x0 + 2, y - 1); } } } }
function geneAtCols(r, px){ const w = win(); if (!w._gcols) return null; const gs = w._gcols.get(r.hap); if (!gs) return null; for (const ge of gs){ for (const [x0, x1] of geneSpanX(w, ge)){ if (px >= x0 && px <= x1) return ge; } } return null; }
function geneInfoCols(ge, hap){ const JN = { 1: '窓の外から始まる', 2: '窓の外で終わる', 3: '窓の外から始まり外で終わる' }; return `<p><span class="h">${esc(ge[1] || '(無名)')}</span> <span class="k">${esc(ge[3])}${ge[4] ? '・擬似' : ''} · ${ge[2]} 鎖 · ${ge[5].toLocaleString()}–${ge[6].toLocaleString()}（${(ge[6] - ge[5] + 1).toLocaleString()} bp）· ${esc(hap)}${ge[7].length > 1 ? ` · 窓の中で ${ge[7].length} 片に分かれる` : ''}${ge[12] ? ' · ' + JN[ge[12]] : ''}<br>開始 ${esc(ge[8])} +${ge[9]} · 終了 ${esc(ge[10])} +${ge[11]}${partsSummary(ge)}${geneEffectSummary(ge, hap)}</span>${cb && cb.onFeature ? '<br><span class="copied">クリックで GFF の全項目（9 列・属性・親・子）</span>' : ''}</p>`; }
function partsSummary(ge){ const ps = ge[13] || []; if (!ps.length) return ''; const cnt = new Map(); for (const p of ps){ const k = p[1] + (p[1] === 'CDS' && p[3] != null && p[3] !== '0' && p[3] !== '.' ? `(phase ${p[3]})` : ''); cnt.set(k, (cnt.get(k) || 0) + 1); } return ' · GFF の子の行: ' + [...cnt].map(([k, n]) => n > 1 ? `${k} ×${n}` : k).join(', '); }
// ---- GFF の 1 行の全項目（.genes format 2 の feature 表。backend /blocks/feature）: 9 列・属性・親・子・その株の GFF の書き出し ----
function featBrief(f){ const a = f.attrs || []; const get = k => { const e = a.find(x => x[0] === k); return e ? e[1] : ''; }; return [get('Name') || get('gene'), get('product'), get('protein_id'), get('Note')].filter(x => x).join(' · '); }
function featRow(f){ return `<tr data-act="fopen" data-fid="${f.fid}" style="cursor:pointer"><td data-act="fopen" data-fid="${f.fid}">${'　'.repeat(Math.max(0, (f.depth || 1) - 1))}${esc(f.type)}</td><td data-act="fopen" data-fid="${f.fid}" style="text-align:right">${f.start.toLocaleString()}–${f.end.toLocaleString()}</td><td data-act="fopen" data-fid="${f.fid}">${esc(f.strand)} ${f.phase !== '.' ? 'phase ' + esc(f.phase) : ''}</td><td data-act="fopen" data-fid="${f.fid}" class="k">${esc(featBrief(f) || f.id || '')}</td></tr>`; }
function renderFeature(r){ const f = r.feature; const a = f.attrs || []; const name = featBrief(f) || f.id || f.type;
  const cols = `<table><tr><th>seqid</th><th>source</th><th>type</th><th>start</th><th>end</th><th>score</th><th>strand</th><th>phase</th></tr><tr><td>${esc(f.seqid)}</td><td>${esc(f.source)}</td><td>${esc(f.type)}</td><td>${f.start.toLocaleString()}</td><td>${f.end.toLocaleString()}</td><td>${esc(f.score)}</td><td>${esc(f.strand)}</td><td>${esc(f.phase)}</td></tr></table>`;
  const attrs = `<table>${a.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
  const anc = (r.ancestors || []).length ? `<p><span class="k">親（クリックで開く）:</span></p><table>${r.ancestors.map(x => featRow(x)).join('')}</table>` : '';
  const ch = (r.children || []).length ? `<p><span class="k">子 ${r.children.length} 行（クリックで開く）:</span></p><table>${r.children.map(x => featRow(x)).join('')}</table>` : '';
  return `<p><span class="h">${esc(name)}</span> <span class="k">${esc(f.type)} · GFF ${esc(f.acc)} の ${f.lineno.toLocaleString()} 行目${f.path ? ' · ' + esc(f.path) : ''}${f.tok ? ` · トークン ${f.tok[0].toLocaleString()}–${f.tok[1].toLocaleString()}` : ''}</span></p>${cols}<p><span class="k">属性（第 9 列、${a.length} 個）:</span></p>${attrs}${anc}${ch}<p><button data-act="fcopy">GFF の行をコピー</button> ${r.gff ? `<a href="${esc(r.gff)}" download><button type="button">この株の GFF を書き出す（入力どおり）</button></a>` : ''}</p><pre style="white-space:pre-wrap;word-break:break-all;font-size:10.5px;margin:4px 0 0">${esc(f.line)}</pre>`; }
function showFeature(q){ if (!(cb && cb.onFeature)) return; st.pinned = true; $('detailbody').innerHTML = '<p class="k">GFF の項目を読んでいます…</p>';
  cb.onFeature(q).then(r => { if (!r || r.error || !r.feature){ setDetail(`<p class="k">読めませんでした: ${esc((r && r.error) || '応答なし')}</p>`); return; } setDetailWide((r.children || []).length > 6); setDetail(renderFeature(r)); $('detailbody')._feature = r; }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
// ---- 接合カード・一覧 ----
const JTN = { inv: '逆位', trans: '転座', del: '欠失（原子を飛ばす）', ins: '挿入（同じ原子へ戻る）', abs: '島の有無' }; const JCN = { split: '分断', isl: '他株の島の挿入点が遺伝子内', end: '遺伝子の端が接合区間内', inside: '遺伝子が接合区間に丸ごと', near: '近接', '': '遺伝子なし' };
let _juncList = null;
function openJunction(jid){ if (!(cb && cb.onJunction)) return; $('detailbody').innerHTML = `<p class="k">接合 ${jid} を読んでいます…</p>`; st.pinned = true; setDetailWide(true);
  cb.onJunction(jid).then(r => { if (!r || r.error){ setDetail(`<p class="k">接合を読めませんでした: ${esc((r && r.error) || '応答なし')}</p>`); return; } const j = r.junction;
    const bp = j.b2 - j.a2; const genes = r.genes || [];
    let html = `<p><span class="h">接合カード</span> <span class="k">#${j.jid} · ${esc(JTN[j.type] || j.type)} · ${esc(j.hap)}</span><br>` +
      `<span class="k">区間 ${j.a2.toLocaleString()}–${j.b2.toLocaleString()}（${bp.toLocaleString()} bp）· 中身: 多重 ${(j.multi_bp||0).toLocaleString()} bp · 私有 ${(j.priv_bp||0).toLocaleString()} bp · 層 ${j.tier}${j.wrap ? ' · 環状の継ぎ目（コンティグの起点）をまたぐ' : ''}</span><br>` +
      `<span class="k">左 原子 #${j.ai + 1}（${j.di ? '→' : '←'}）→ 右 原子 #${j.aj + 1}（${j.dj ? '→' : '←'}）</span></p>`;
    html += `<p><button class="mono" data-act="goto" data-atom="${j.ai}">原子 #${j.ai + 1} へ</button> <button class="mono" data-act="goto" data-atom="${j.aj}">原子 #${j.aj + 1} へ</button> ${cb.onJunctionGenes ? `<button data-act="jgenes" data-jid="${j.jid}">遺伝子の並びを比べる</button>` : ''} ${cb.onJunctionBase && cb.onBaseFetch ? `<button data-act="jbase" data-jid="${j.jid}">この接合の塩基を見る</button>` : ''} <button data-act="copy">カードをコピー</button></p>`;
    if (genes.length){ html += `<p><span class="k">関係する遺伝子 ${genes.length}:</span></p><ul>` + genes.map(g => `<li><b>${esc(g.name || '(無名)')}</b> <span class="k">${esc(g.type)}${g.pseudo ? '・擬似' : ''} ${g.strand} ${g.start.toLocaleString()}–${g.end.toLocaleString()} · ${esc(JCN[g.cls] || g.cls)}${g.cls === 'near' ? `（${g.dist.toLocaleString()} bp）` : ` · 左 ${g.left} / 右 ${g.right} / 内 ${g.mid} bp`}${g.product ? ` · ${esc(g.product)}` : ''}</span></li>`).join('') + '</ul>'; }
    else html += '<p class="k">近くに遺伝子はありません。</p>';
    setDetail(html); $('detailbody')._card = { j, genes, html }; }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
function gotoAtom(aid){ const A = DATA.meta.atoms && DATA.meta.atoms[aid]; if (!A) return; if (st.win !== 0 || st.li !== 0 || st.filter){ st.win = 0; st.li = 0; st.filter = null; st.filterPath = []; st.sel = null; st.origin = null; st.pinned = false; drawAll(); emitSel(); } drillRange(A[0], A[0] + Math.max(1, A[1])); }
function openJunctionBase(jid){ if (!(cb && cb.onJunctionBase && cb.onBaseFetch)) return; st.busy = `接合 ${jid} の塩基のトークン範囲を求めています…`; drawGrid();
  cb.onJunctionBase(jid, 60).then(r => { st.busy = null; if (!r || r.error || !r.ranges || !r.ranges.length){ drawAll(); notice(`接合の塩基を出せませんでした: ${esc((r && r.error) || '範囲なし')}`); return; } openBase(r.ranges, r.label || ('接合 ' + jid), -1, null, null, Math.max(2000, r.ranges.length * (2 * (r.k || 60) + 1) + 64), r.xr || null, { hap: r.hap, byRanges: true, shared: r.shared || null, path: (r.ranges.find(x => x[0].startsWith((r.hap || '') + '#')) || r.ranges[0])[0] });   /* 葉の上限: 全株 × (2K+1) トークン（50 株で約 6,000。接合の窓は K で幅が決まるので 2,000 では足りない） */ }).catch(e => { st.busy = null; drawAll(); notice(`失敗: ${esc(String(e))}`); }); }
// 接合の遺伝子近傍の比較: 行＝株（接合の株が先頭、以下は共有の多い順）、各行は接合位置の前後 N 遺伝子の矢印。色＝同じ場所の遺伝子（合意列の重なり）
const JG_PAL = ['#2f6fb3', '#e08a1e', '#3a9d5d', '#8a5cd6', '#c9302c', '#17a2b8', '#a0522d', '#d4a017', '#5c7cfa', '#e64980', '#20c997', '#fd7e14', '#6f42c1', '#795548'];
function openJunctionGenes(jid){ if (!(cb && cb.onJunctionGenes)) return; st.pinned = true; setDetailWide(true); $('detailbody').innerHTML = `<p class="k">接合 ${jid} の遺伝子の並びを読んでいます…</p>`;
  cb.onJunctionGenes(jid, 6).then(r => { if (!r || r.error || !r.rows){ setDetail(`<p class="k">遺伝子の並びを読めませんでした: ${esc((r && r.error) || '応答なし')}</p>`); return; } setDetail(renderJunctionGenes(r)); $('detailbody')._jg = r; }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
function renderJunctionGenes(r){ const N = r.n; const cw = 72, gh = 18, rowH = 26, labW = 196, pad = 8; const W = labW + (2 * N + 1) * cw + pad * 2; const H = r.rows.length * rowH + 24;
  const grpCol = new Map(); r.groups.forEach(g => grpCol.set(g.id, g.nrows >= 2 ? JG_PAL[g.id % JG_PAL.length] : '#c9ced8'));
  const cls = f => f >= 0.9 ? 'ほぼ全部' : f >= 0.1 ? '一部' : 'ほぼ無し'; const q = v => esc(v).replace(/"/g, '&quot;');
  const cx = labW + pad + N * cw;   // 接合の位置: 左側の遺伝子（anchorIdx 個）はこの線より左、右側はこの線より右
  let svg = `<svg width="${W}" height="${H}" style="font:10px 'IBM Plex Mono';display:block">`;
  svg += `<line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="#ff1493" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  r.rows.forEach((row, ri) => { const y = 20 + ri * rowH; const isF = row.path === r.focus;
    svg += `<text x="${pad}" y="${y + 13}" fill="${isF ? '#ff1493' : '#1b2530'}" font-weight="${isF ? 700 : 400}">${esc(row.hap.replace(/#1$/, ''))}</text>`;
    svg += `<text x="${pad + 118}" y="${y + 13}" fill="#64707c">${isF ? '接合の株' : cls(row.shared)}${row.flipped ? ' ⟲' : ''}</text>`;
    const off = row.straddle >= 0 ? (row.straddle + 0.5) : row.anchorIdx;   // 接合位置を内側に含む遺伝子は線の上に中心を置く
    row.genes.forEach((g, i) => { const x0 = cx + (i - off) * cw + 2, x1 = x0 + cw - 4; const col = grpCol.get(g[7]) || '#c9ced8';
      const pts = g[2] === '-' ? `${x1},${y} ${x0 + 7},${y} ${x0},${y + gh / 2} ${x0 + 7},${y + gh} ${x1},${y + gh}` : `${x0},${y} ${x1 - 7},${y} ${x1},${y + gh / 2} ${x1 - 7},${y + gh} ${x0},${y + gh}`;
      const grp = r.groups.find(gg => gg.id === g[7]); const info = `${g[1] || '(無名)'} · ${g[3]}${g[4] ? '・擬似' : ''} · 鎖 ${g[2]}${row.flipped ? '（反転表示）' : ''} · ${g[5].toLocaleString()}–${g[6].toLocaleString()}（${(g[6] - g[5] + 1).toLocaleString()} bp）${g[8] ? ' · ' + g[8] : ''} · 群 #${g[7]}（${grp ? grp.nrows : 1} 株）`;
      svg += `<polygon points="${pts}" fill="${col}" stroke="${g[4] ? '#1b2530' : 'none'}"${g[4] ? ' stroke-dasharray="2 2"' : ''} opacity="${g[3] === 'cds' ? 1 : .55}" data-ginfo="${q(info)}"><title>${esc(info)}</title></polygon>`;
      const nm = (g[1] || '').replace(/^[A-Za-z0-9]+_RS0*/, 'RS'); if (nm) svg += `<text x="${(x0 + x1) / 2}" y="${y + 13}" text-anchor="middle" fill="${col === '#c9ced8' ? '#1b2530' : '#fff'}" pointer-events="none">${esc(nm.length > 9 ? nm.slice(0, 8) + '…' : nm)}</text>`; }); });
  svg += '</svg>';
  const legend = r.groups.filter(g => g.nrows >= 2).slice(0, 30).map(g => `<span style="display:inline-block;margin:0 10px 2px 0"><span class="sw" style="background:${grpCol.get(g.id)}"></span>${esc(g.name || ('群 #' + g.id))} <span class="k">${g.nrows} 株</span></span>`).join('');
  return `<p><span class="h">遺伝子の並びの比較</span> <span class="k">#${r.jid} · ${esc(JTN[r.type] || r.type || '')} · ${esc(r.hap)} · 接合位置（桃色の線）の前後 ${N} 遺伝子。色＝同じ場所の遺伝子（遺伝子のトークンが乗る合意列の重なりで束ねた群。名前は使っていない）、灰＝1 株だけ、点線＝擬似遺伝子、薄い＝CDS 以外、線の上に跨る矢印＝接合位置を内側に含む遺伝子、⟲＝接合の株に並びを合わせて反転表示（アセンブリの向きの違い）。行は塩基の窓と同じ共有の多い順</span><br>` +
    `<button data-act="jcard" data-jid="${r.jid}">← 接合カード</button> <button data-act="jbase" data-jid="${r.jid}">この接合の塩基を見る</button> <button data-act="jgtsv">TSV をコピー</button></p>` +
    `<p id="bk_jginfo" class="k" style="min-height:1.4em;margin:0 0 4px">矢印にホバーで遺伝子の詳細</p><div style="overflow:auto">${svg}</div><p class="k" style="margin-top:6px">${legend}</p>`; }
function junctionGenesTsv(r){ const head = ['hap', 'shared', 'flipped', 'genes (name:strand:group, | = junction)']; return [head.join('\t')].concat(r.rows.map(row => [row.hap, row.shared.toFixed(2), row.flipped ? 1 : 0, row.genes.map((g, i) => (i === row.anchorIdx ? '| ' : '') + `${g[1] || g[0]}:${g[2]}:${g[7]}`).join(' ')].join('\t'))).join('\n'); }
function openJunctionList(){ if (!(cb && cb.onJunctions)) return; st.pinned = true; setDetailWide(true); if (_juncList){ renderJunctionList(); return; }   // 一度読んだ一覧はセッション中そのまま使う（サイドカーは変わらない）
  $('detailbody').innerHTML = '<p class="k">接合の一覧を読んでいます…</p>';
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
function drawAllCore(){ _gdMax = null; computeLayout(); emitBaseVisible(); { const cp = $('ctgpack'); if (cp) cp.checked = LY_pack || st.ctgPack === 'on'; } if (isSites()) sitesLayout(); if (isBase()) baseLayout(); root.classList.toggle('gtrack', orthOn() && !!orthRangeOf()); layoutCanvases(); drawHeader(); drawGrid(); drawLabels(); drawTree(); drawChips(); drawLegend(); updateButtons(); drawMini(); emitView(); }
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
    const rw = TREE ? rangesWinOf(win()) : null;   // 接合の塩基: グラフは MSA に出ている葉の名前の集合で絞る・寄せる（親の範囲＝全体に落ちない）
    cb.onView({ win: st.win, level: st.li, W: 0, mode: 'base', tree: TREE, scope: rbs.length ? { contig: refc, start: x0, end: x1 } : null, scopeKey: st.win + '|base', sync: st.sync, n0: 0, xRange: xr, atomsIn: atomsOverlapping(xr), nodeNames: names, filterGraph: st.gfilter, filterRange: rw ? null : xr, filterSel: (rw && names && names.length) ? { names } : colsSelOf(win()),
      blocks: rbs.length ? [{ rank: 0, color: 'rgb(13,148,136)', ref_contig: refc, x: x0, span: Math.max(1, x1 - x0), label: win().label, members: [] }] : [{ rank: 0, color: 'rgb(13,148,136)', ref_contig: refc, x: 0, span: 1, label: win().label, members: [] }] }); return; }
  if (isSites()){ const S = L.sites; const f = S.sites[0], l = S.sites[S.nsites-1]; const x0 = f.x, x1 = l.x + Math.max(1, l.bp); const refc = L.refc!=null ? L.refc : 0;
    const xr = TREE ? [x0, x1] : null;
    cb.onView({ win: st.win, level: st.li, W: 0, mode: 'sites', tree: TREE, scope: { contig: refc, start: x0, end: x1 }, scopeKey: st.win + '|sites', sync: st.sync, n0: 0, xRange: xr, atomsIn: atomsOverlapping(xr), filterGraph: st.gfilter, filterRange: xr, filterSel: (L.c0 != null && L.c1 != null) ? { cols: [L.c0, L.c1] } : colsSelOf(win()),
      blocks: [{ rank: 0, color: L.pcolor || 'rgb(13,148,136)', ref_contig: refc, x: x0, span: Math.max(1, x1 - x0), label: win().label, members: [] }] }); return; }
  // 範囲 = 見えているブロックの参照区間の合併（最多のコンティグ）。窓・絞り込みが変わったときだけ scopeKey が変わる
  const byC = new Map(); for (const rank of LY.vis){ const B = L.blocks[rank]; const c = (B.ref_contig!=null ? B.ref_contig : 0); const g = byC.get(c) || {n:0, lo:Infinity, hi:-Infinity}; g.n++; const lo_ = (B.rx0 != null ? B.rx0 : B.x), hi_ = (B.rx1 != null ? B.rx1 : B.x + B.span); g.lo = Math.min(g.lo, lo_); g.hi = Math.max(g.hi, hi_); byC.set(c, g); }
  let scope = null; for (const [c,g] of byC){ if (!scope || g.n > scope.n){ scope = {contig:c, start:g.lo, end:g.hi, n:g.n}; } }
  if (st.win === 0 && !st.filter) scope = null;   /* 根の窓（絞り込み無し）ではグラフを寄せない: グラフでズームしてから Blocks を開くと全景に戻っていた（2026-10-18） */
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
  if (st.measure==='minor'){
    // 少数派サイトの位置は 1/255 に丸めて重複を落とした集合しか無い（併合したブロックではさらに粗い）。以前は 1 点に「総数 ÷ 点数」を積んでビンに
    // 入れていたので、点のあるビンは密度が跳ね上がって底、無いビンは満杯、と 2 極に分かれた（ヒト chr20-22 で顕著、README 改訂 120）。
    // ここでは点の**占有**（その 1/255 区間にサイトがあるか）を近傍で平滑化し、インスタンス全体の平均密度をその相対値で配る
    let useCons = cons; let vs = cons ? consSites(it) : varSites(it); if (cons && !vs.length){ vs = varSites(it); useCons = false; }   // 下段など合意座標の位置が無いものは通過内の位置で
    const avg = (it[11]||0) / it[2] * 1000; const dref = levelDensRef(); const h = new Float32Array(nbins);
    if (!vs.length){ h.fill(1 - Math.min(1, avg/(2*dref))); return h; }
    const e0 = (useCons && ext) ? ext[0] : 0, e1 = (useCons && ext) ? Math.max(ext[0]+1, ext[1]) : 255; const nq = e1 - e0 + 1;
    const occ = new Float32Array(nq); let nin = 0; for (let i=0;i<vs.length;i++){ const q = vs[i] - e0; if (q < 0 || q >= nq) continue; occ[q] = 1; nin++; }
    if (!nin){ h.fill(1 - Math.min(1, avg/(2*dref))); return h; }
    const rad = Math.max(1, Math.min(16, Math.round(nq / Math.max(1, nin) / 2)));   // 点の間隔の半分ほどで平滑化
    const sm = new Float32Array(nq); { let acc = 0; for (let q=0;q<Math.min(nq, rad+1);q++) acc += occ[q]; for (let q=0;q<nq;q++){ const lo = q - rad, hi = q + rad; sm[q] = acc / (Math.min(nq-1, hi) - Math.max(0, lo) + 1); if (hi + 1 < nq) acc += occ[hi + 1]; if (lo >= 0) acc -= occ[lo]; } }
    let mean = 0; for (let q=0;q<nq;q++) mean += sm[q]; mean /= nq; mean = Math.max(1e-6, mean);
    for (let b=0;b<nbins;b++){ const qa = Math.floor(b*nq/nbins), qb = Math.max(qa+1, Math.floor((b+1)*nq/nbins)); let v = 0; for (let q=qa;q<qb;q++) v += sm[q]; v /= (qb - qa);
      const dens = avg * v / mean; let bb = b; if ((!useCons && flip) || (useCons && o.dir === 0)) bb = nbins-1-b; h[bb] = 1 - Math.min(1, dens/(2*dref)); }
    return h; }
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
  if (p.ext && p.ext[1] > p.ext[0]){ let e0 = p.ext[0], e1 = p.ext[1]; if (inv){ const t = e0; e0 = 255 - e1; e1 = 255 - t; } const t = (cc*255 - e0)/(e1 - e0); if (t < -0.05 || t > 1.05) return NaN; return p.x + Math.max(0, Math.min(1, t))*p.w; }   /* 片の合意範囲の外の錨は描かない（端に寄せると多数の線が 1 点に集まった。2026-10-18） */
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
function laneKey(){ const w = win(); return [st.win, st.li, st.mode, (w._orthRows ? 'o' : '-') + (w._orthKey || ''), st.filter ? [...st.filter].join('.') : '', Math.round(LY.fullW || 0), RH, st.lane ? 1 : 0, st.jmark ? 1 : 0, w._genes ? 1 : 0, cv.grid.clientWidth, cv.grid.clientHeight].join('|'); }
function drawLanesCached(){ const key = laneKey(); const g = cv.grid.getContext('2d');
  if (!_laneCache || _laneCache.key !== key){ const c = document.createElement('canvas'); c.width = cv.grid.width; c.height = cv.grid.height; const gg = c.getContext('2d'); const dpr = cv.grid.width / Math.max(1, cv.grid.clientWidth); gg.scale(dpr, dpr);
    LY.rows.forEach((r, ri) => { const y = ri*RH; if (st.lane){ if (!drawOrthMarks(gg, r, y)) for (const p of r.items) drawGeneLane(gg, r, p, y); } if (st.jmark) drawJuncMarks(gg, r, y); else r.jmarks = []; });
    _laneCache = { key, canvas: c, jmarks: LY.rows.map(r => r.jmarks || []) }; }
  else LY.rows.forEach((r, ri) => { r.jmarks = _laneCache.jmarks[ri] || []; });   // 配置オブジェクトが作り直されていてもホバー用の位置を戻す
  g.drawImage(_laneCache.canvas, 0, 0, cv.grid.clientWidth, cv.grid.clientHeight); }
function drawCtgBreaks(){ if (!LY_pack || isSites() || isBase() || !LY) return; const g = cv.grid.getContext('2d'); g.fillStyle = TH.muted; LY.rows.forEach((r, ri) => { for (const x of (r.ctgBreaks || [])){ const y = ri*RH + RH - 7; g.beginPath(); g.moveTo(x - 2.5, y + 5); g.lineTo(x + 2.5, y + 5); g.lineTo(x, y); g.closePath(); g.fill(); } }); }   /* 小さな三角（以前の全高の縦線は対応線と紛らわしかった） */
function drawGrid(){ drawGridBase(); drawCtgBreaks(); drawOgBand(); if (!isSites() && !isBase() && genesOn()) drawLanesCached(); if (isSites()){ drawSitesGrid(); if (genesOn() && st.lane) drawOrthMarksAll(cv.grid.getContext('2d')); } if (isBase()){ if (genesOn()) ensureGenesCols(win()); drawBaseGrid(); if (genesOn()){ const g = cv.grid.getContext('2d'); g.save(); g.translate(-bsx(), 0); if (!drawOrthMarksAll(g)){ drawGeneLanesCols(g); } g.restore(); } } drawBusy(); }
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
function setCorner(mode){ const c = $('corner'); if (!c) return; const sp = c.querySelector('span:not(#bk_cutwrap)');   /* 先頭の span は系統樹のまとめのスライダ（#bk_cutwrap）なので飛ばす */ if (sp && sp.textContent !== CORNER_TXT[mode]) sp.textContent = CORNER_TXT[mode]; }
function drawHeader(){ if (isSites()){ setCorner('sites'); drawSitesHeader(); if (genesOn()) drawGeneBandCols(cv.hdr.getContext('2d'), cv.hdr.clientHeight); drawMarks(); drawGeneTrack(); return; } if (isBase()){ setCorner('base'); drawBaseHeader(); if (genesOn()){ const gh = cv.hdr.getContext('2d'); gh.save(); gh.translate(-bsx(), 0); drawGeneBandCols(gh, cv.hdr.clientHeight); gh.restore(); } drawGeneTrack(); return; } setCorner('blocks'); drawHeaderBase(); drawMarks(); drawGeneTrack(); }
function drawHeaderBase(){
  const g = cv.hdr.getContext('2d'); const W = cv.hdr.clientWidth, H = cv.hdr.clientHeight; g.clearRect(0,0,W,H); const L = level();
  g.font='10px "IBM Plex Mono"'; let lastLabelX=-1e9;
  for (const c of LY.cols){
    if (c.type==='block'){ g.fillStyle = colorOf(c.rank); g.fillRect(c.x, H-6, c.w, 4); if (st.sel===c.rank){ g.fillStyle=TH.selbg; g.fillRect(c.x,0,c.w,H); g.strokeStyle=TH.sel; g.strokeRect(c.x+.5,.5,c.w-1,H-1); }
      if (c.w>=30){ g.fillStyle=TH.ink; g.textAlign='center'; g.textBaseline='alphabetic'; g.fillText('#'+(c.rank+1), c.x+c.w/2, 11); } }
    const lab = st.axis==='ref' ? (c.type==='block' ? fmtref(L.blocks[c.rank].rx0 != null ? L.blocks[c.rank].rx0 : L.blocks[c.rank].x, L.blocks[c.rank].ref_contig) : '') : fmtbp(c.cum);
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
  LY.rows.forEach((r,ri)=>{ const d = document.createElement('div'); d.className = 'lab' + (r.isref?' ref':'') + (r.refin?' refin':'') + ((st.hover&&st.hover.ri===ri)?' hov':''); d.style.top = (ri*RH)+'px'; d.style.height = RH+'px'; if (RH < 20) d.style.fontSize = '10px';
    const nInv = r.items.filter(p=>p.o.kind===3).length, nDisp = r.items.filter(p=>p.o.kind===2).length;
    const bn = (r.bundles||[]).map(b=>`#${b.rank+1} に ${b.n} 本`).join(' ');
    d.innerHTML = `${r.mark?`<span class="hapdot" style="background:${r.mark}"></span>`:''}<span>${esc(r.label)}</span>${r.clade ? `<small style="color:var(--sel)" title="まとめた群 ${r.clade.members.length} 株の代表（群の中心）${r.refin ? '・参照株を含む' : ''}: ${esc(r.clade.members.join(', '))}">＋${r.clade.members.length - 1}</small>` : ''}<small>${esc(r.sub)}${(nInv||nDisp)?` · 逆${nInv} 変${nDisp}`:''}${bn?' · 束 '+esc(bn):''}</small>`;
    d.title = r.label + (bn?' / 束: '+bn:'') + '\nクリック: このハプロタイプのパス（リボン）をグラフで選択／解除';
    if (cb && cb.onSelectHap){ d.style.cursor = 'pointer'; d.addEventListener('click', ()=>cb.onSelectHap(r.gkey || r.hap, r.hap)); }
    wrap.appendChild(d); });
}
// ── 見出しの遺伝子トラック（オルソログ群）と行の差分 ──
//   群 = 同じノードを共有する遺伝子（annot/orthogroups.py、.genes の orthogroup）。見出しに 1 本、行には差分だけ（README 改訂 109）。
//   列範囲は段ごと: ブロック段＝見えているブロックの c0..c1、アレル行列＝窓の列範囲、塩基段＝窓の列範囲（接合から開いた窓は列範囲が無いので出さない）
function orthOn(){ return genesOn() && st.lane && TREE && !!(cb && cb.onOrth); }
function orthRangeOf(){ const L = level(); if (!L) return null; if (isSites()) return (L.c0 != null && L.c1 != null) ? [L.c0, L.c1] : null; if (isBase()){ const L0 = win().levels[0]; return (L0 && L0.c0 != null && L0.c1 != null) ? [L0.c0, L0.c1] : null; }
  const vis = LY && LY.vis ? LY.vis : []; if (!vis.length || !L.blocks) return null; let c0 = Infinity, c1 = -Infinity; for (const r of vis){ const B = L.blocks[r]; if (!B || B.c0 == null) continue; c0 = Math.min(c0, B.c0); c1 = Math.max(c1, B.c1); } return c0 <= c1 ? [c0, c1] : null; }
function ensureOrth(){ if (!orthOn()) return null; const w = win(); const rg = orthRangeOf(); if (!rg) return null; const key = st.li + ':' + rg[0] + ':' + rg[1]; if (w._orthKey === key) return w._orth || null; if (w._orthLoading === key) return null; w._orthLoading = key;
  cb.onOrth(rg[0], rg[1], 3000).then(r => { w._orthLoading = null; w._orthKey = key; w._orth = r || null; w._orthRows = null; _laneCache = null; drawGeneTrack(); drawGrid();
    if (r && r.groups && cb.onOrthRows) cb.onOrthRows(rg[0], rg[1]).then(rr => { if (rr && rr.rows && w._orthKey === key){ w._orthRows = new Map(rr.rows.map(x => [x.hap, x])); _laneCache = null; drawGrid(); } }).catch(() => {}); }).catch(() => { w._orthLoading = null; });
  return null; }
function baseNodeSpans(M){ if (!M._nspan){ M._nspan = new Map(); (M.cols || []).forEach((c, i) => { for (const nm of (c.nodes || [])){ const e = M._nspan.get(nm); if (!e) M._nspan.set(nm, [i, i]); else e[1] = i; } }); } return M._nspan; }
// 列範囲（と塩基段用のノード名）→ x の区間の並び（ブロック段は見えているブロックごとに 1 片）。無ければ null
function orthX(o){ const L = level();
  if (isSites()){ const S = L.sites; if (!S || !S.nsites) return null; const r = sitesXOfCols(S, o.c0, o.c1); if (r) return [[r[0], r[1]]]; let lo = 0, hi = S.nsites; while (lo < hi){ const m = (lo + hi) >> 1; if (S.sites[m].c0 < o.c0) lo = m + 1; else hi = m; } const x = SITES_X0 + lo * LY.siteW; return [[x - 1, x + 1]]; }   /* サイトを含まない遺伝子: 次のサイトの左に細く */
  if (isBase() && L.base && L.base.indexBacked){ const M = L.base; const r = baseXOfTreeCols(M, o.c0, o.c1); if (r) return [[r[0], r[1]]]; const t = nextSiteX(M, o.c0); return t ? [t] : null; }
  if (isBase()){ const M = L.base; if (!M || !o.n0 && !o.n1) return null; const sp = baseNodeSpans(M); const a = sp.get(o.n0), b = sp.get(o.n1); if (!a && !b) return null; const i0 = Math.min(a ? a[0] : b[0], b ? b[0] : a[0]), i1 = Math.max(a ? a[1] : b[1], b ? b[1] : a[1]); const xa = baseXOfCol(i0), xb = baseXOfCol(i1); return (xa && xb) ? [[xa[0], xb[1]]] : null; }
  const out = []; for (const c of LY.cols){ if (c.type !== 'block') continue; const B = L.blocks[c.rank]; if (!B || B.c0 == null || B.c1 < o.c0 || B.c0 > o.c1) continue; const den = Math.max(1, B.c1 - B.c0 + 1); const x0 = c.x + Math.max(0, o.c0 - B.c0) / den * c.w, x1 = c.x + (Math.min(B.c1, o.c1) - B.c0 + 1) / den * c.w; out.push([x0, Math.max(x0 + 1, x1)]); } return out.length ? out : null; }
let _gtHits = [];
const OG_CLEAR = 0.65;   // 向きの多数がこの割合以上の群だけ、少数側の株に紫を出す。割れている群は見出しの矢印を二色に
function ogSplit(gr){ const n = gr[7] || 1, plus = gr[11] || 0; return Math.max(plus, n - plus) < OG_CLEAR * n; }
function ogObj(gr){ return { og: gr[0], name: gr[1], c0: gr[2], c1: gr[3], x0: gr[4], x1: gr[5], nhap: gr[6], n: gr[7], multi: gr[8], cds: gr[9], npseudo: gr[10], plus: gr[11], product: gr[12], n0: gr[13], n1: gr[14] }; }
function drawGeneTrack(){ const on = root.classList.contains('gtrack'); if (!on) return; const g = cv.gtrack.getContext('2d'); const W = cv.gtrack.clientWidth, H = GT_H; g.clearRect(0, 0, W, H); const w = win(); const O = ensureOrth(); _gtHits = []; g.font = '10px "IBM Plex Mono"'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  if (!O){ g.fillStyle = TH.muted; g.fillText(w._orth && w._orth.error ? w._orth.error : '遺伝子を読んでいます…', 6, 14); return; }
  const Hh = O.H || 1;
  if (O.density){ const d = O.density; const mx = Math.max(1, ...d.cnt); for (let b = 0; b < d.cnt.length; b++){ if (!d.cnt[b]) continue; const xs = orthX({ c0: d.c0 + b * d.w, c1: d.c0 + (b + 1) * d.w - 1 }); if (!xs) continue; for (const [x0, x1] of xs){ const wv = Math.max(1, x1 - x0); const h = Math.max(2, Math.round((H - 4) * d.cnt[b] / mx)); g.fillStyle = TH.line; g.fillRect(x0, H - 2 - h, wv, h); const hc = Math.round((H - 4) * d.core[b] / mx); if (hc){ g.fillStyle = '#0d9488'; g.fillRect(x0, H - 2 - hc, wv, hc); } } }
    g.fillStyle = TH.muted; g.fillText(`遺伝子群 ${O.n.toLocaleString()}（密度。青緑＝core。狭い窓に降りると矢印）`, 6, 10); return; }
  const _sx = bsx(); g.save(); g.translate(-_sx, 0);
  for (const gr of O.groups){ const o = ogObj(gr); const xs = orthX(o); if (!xs) continue; if (_sx || isBase()){ if (xs[xs.length - 1][1] < _sx || xs[0][0] > _sx + W) continue; } const core = o.nhap >= 0.9 * Hh; const fill = core ? '#0d9488' : (o.nhap >= 2 ? '#9ad7cf' : '#d9dee3'); const fwd = o.plus * 2 >= o.n; const y = 5, h = 11;
    const split = ogSplit(gr);
    for (const [x0, x1] of xs){ const wv = x1 - x0; g.fillStyle = fill;
      if (wv >= 6){ const hd = Math.min(5, wv * 0.4); g.beginPath(); if (fwd){ g.moveTo(x0, y); g.lineTo(x1 - hd, y); g.lineTo(x1, y + h/2); g.lineTo(x1 - hd, y + h); g.lineTo(x0, y + h); } else { g.moveTo(x1, y); g.lineTo(x0 + hd, y); g.lineTo(x0, y + h/2); g.lineTo(x0 + hd, y + h); g.lineTo(x1, y + h); } g.closePath(); g.fill();
        if (split){ g.save(); g.clip(); g.fillStyle = TH.inv; g.globalAlpha = .55; g.fillRect(x0, y + h/2, wv, h/2); g.globalAlpha = 1; g.restore(); } }   /* 向きが割れている群: 下半分を紫に */
      else { g.fillRect(x0, y, Math.max(1, wv), h); if (split){ g.fillStyle = TH.inv; g.fillRect(x0, y + h/2, Math.max(1, wv), h/2); } }
      if (o.npseudo * 2 >= o.n){ g.strokeStyle = TH.ink; g.setLineDash([2, 2]); g.strokeRect(x0 + .5, y + .5, Math.max(1, wv - 1), h - 1); g.setLineDash([]); }
      if (o.multi && wv >= 10){ g.fillStyle = core ? '#fff' : TH.ink; g.font = '9px "IBM Plex Mono"'; g.fillText('×', x1 - 8, y + 9); }
      if (wv >= 44 && o.name){ g.fillStyle = core ? '#fff' : TH.ink; g.font = '9px "IBM Plex Mono"'; g.textAlign = 'center'; const t = o.name.replace(/^[A-Za-z0-9]+_RS0*/, 'RS'); const cap = Math.max(1, Math.floor((wv - 8) / 5.6)); g.fillText(t.length > cap ? t.slice(0, Math.max(1, cap - 1)) + '…' : t, (x0 + x1) / 2, y + 9); g.textAlign = 'left'; }
      _gtHits.push({ x0, x1, o }); } }
  if (isBase() && st.beff && genesOn()){ const BE = ensureEffects(); if (BE) for (const hit of _gtHits){ const L = locusForOrth(hit.o, BE); const n = L ? lofCount(L) : 0; if (!n || hit.x1 - hit.x0 < 24) continue;
      g.fillStyle = EFF_COL[3]; g.beginPath(); g.arc(hit.x1 - 7, 5 + 11 / 2, 6, 0, 2 * Math.PI); g.fill(); g.fillStyle = '#fff'; g.font = 'bold 9px "IBM Plex Mono"'; g.textAlign = 'center'; g.fillText(String(n), hit.x1 - 7, 5 + 11 / 2 + 3); g.textAlign = 'left'; g.font = '10px "IBM Plex Mono"'; } }   /* 赤丸の数字＝この窓の整列で機能喪失の株数 */
  if (st.selOg != null){ for (const hit of _gtHits){ if (hit.o.og !== st.selOg) continue; g.strokeStyle = TH.sel; g.lineWidth = 1.5; g.strokeRect(hit.x0 - 1, 2, hit.x1 - hit.x0 + 2, H - 4); g.lineWidth = 1; } } g.restore(); }
function orthInfo(o, Hh){ return `<p><span class="h">${esc(o.name || '(無名)')}</span> <span class="k">遺伝子群 #${o.og} · ${o.nhap} / ${Hh} 株${o.nhap >= 0.9 * Hh ? '（core）' : o.nhap >= 2 ? '（accessory）' : '（1 株だけ）'} · 構成 ${o.n}${o.multi ? '（1 株に複数）' : ''}${o.npseudo ? ` · 擬似 ${o.npseudo}` : ''} · ${o.cds ? 'CDS' : 'CDS 以外'} · 鎖 ${Math.max(o.plus, o.n - o.plus) < OG_CLEAR * o.n ? `割れている（+ ${o.plus} / − ${o.n - o.plus}。多数が ${Math.round(OG_CLEAR * 100)}% 未満なので行に紫は出さない）` : (o.plus * 2 >= o.n ? '+' : '−') + `（合意の向きに対して。+ が ${o.plus}/${o.n}）`}</span><br><span class="k">合意列 ${o.c0.toLocaleString()}–${o.c1.toLocaleString()} · 合意座標 ${fmtbp(o.x0)}–${fmtbp(o.x1)}${o.product ? ' · ' + esc(o.product) : ''}</span>${orthEffectNote(o)}</p>`; }
// 塩基の窓の整列から、この群に重なる座位の効果の集計（遺伝子トラックのホバーと赤丸）
function locusForOrth(o, BE){ const M = baseOf(); if (!M || !BE || !BE.loci.length) return null; const sp = baseNodeSpans(M); const a = sp.get(o.n0), b = sp.get(o.n1); if (!a && !b) return null; const i0 = Math.min(a ? a[0] : b[0], b ? b[0] : a[0]), i1 = Math.max(a ? a[1] : b[1], b ? b[1] : a[1]); let best = null, bo = 0; for (const L of BE.loci){ if (!L.rows) continue; const ov = Math.min(L.cB, i1) - Math.max(L.cA, i0) + 1; if (ov > bo){ bo = ov; best = L; } } return bo > 0 ? best : null; }
function lofCount(L){ let n = 0; for (const S of L.rows.values()) if (!S.absent && S.lof) n++; return n; }
function orthEffectNote(o){ if (!isBase() || !st.beff || !genesOn()) return ''; const BE = ensureEffects(); const L = BE ? locusForOrth(o, BE) : null; if (!L) return ''; let syn = 0, mis = 0, np = 0; for (const S of L.rows.values()){ if (S.absent) continue; np++; syn += S.syn; mis += S.mis; } const n = lofCount(L);
  return `<br><span class="k">この窓の整列から（モデル ${esc(L.name)} の枠、${L.ncodon} コドン、${np} 株）: <b style="color:${n ? EFF_COL[3] : 'inherit'}">機能喪失 ${n} 株</b> · 同義 ${syn}・非同義 ${mis}</span>`; }
function drawOgBand(){ if (st.selOg == null) return; const w = win(); const O = w._orth; if (!O || !O.groups) return; const gr = O.groups.find(x => x[0] === st.selOg); if (!gr) return; const xs = orthX(ogObj(gr)); if (!xs) return; const g = cv.grid.getContext('2d'); const H = cv.grid.clientHeight; g.save(); g.translate(-bsx(), 0); for (const [x0, x1] of xs){ g.fillStyle = TH.selbg; g.fillRect(x0, 0, Math.max(1, x1 - x0), H); } g.restore(); }
// 行がこの列範囲を覆っているか（無い遺伝子の白抜きは、覆っている行だけに描く）
function rowCovers(r, o){ const L = level(); if (isSites()){ const S = L.sites; const hi = S._hidx ? S._hidx.get(r.hap) : null; if (hi == null || !S._cells) return false; const rr = sitesXOfCols(S, o.c0, o.c1); if (!rr) return true; for (let k = rr[2]; k <= rr[3]; k++) if (S._cells[k * S.H + hi] !== 255) return true; return false; }
  if (isBase()){ const M = L.base; const mi = M._rowOf ? M._rowOf.get(r.hap) : null; if (mi == null) return false; if (M.indexBacked){ const rr = baseXOfTreeCols(M, o.c0, o.c1); if (!rr) return true; const sq = M.rows[mi].seq || ''; for (let i = rr[2]; i <= rr[3]; i++) if (sq[i] && sq[i] !== '-') return true; return false; } const sp = baseNodeSpans(M); const a = sp.get(o.n0) || sp.get(o.n1); if (!a) return false; const seq = M.rows[mi].seq || ''; for (let i = a[0]; i <= Math.min(a[1], seq.length - 1); i++) if (seq[i] && seq[i] !== '-') return true; return false; }
  for (const p of (r.items || [])){ const B = L.blocks[p.o.rank]; if (B && B.c0 != null && B.c1 >= o.c0 && B.c0 <= o.c1) return true; } return false; }
// 行の差分印: 無い（白抜き）、擬似（橙の斜線）、合意と逆向き（紫）、その株だけの遺伝子（青緑の刻み）。描けたら true（従来のレーンを出さない）
function drawOrthMarks(g, r, y){ const w = win(); const O = w._orth; const rows = w._orthRows; if (!O || !O.groups || !rows) return false; const row = rows.get(r.hap); if (!row) return false; const have = new Map(row.st.map(s => [s[0], s])); const yb = y + RH - 4, h = 3;
  for (const gr of O.groups){ if (gr[6] < 2) continue; const o = ogObj(gr); const s = have.get(o.og);
    if (!s){ if (!rowCovers(r, o)) continue; const xs = orthX(o); if (!xs) continue; for (const [x0, x1] of xs){ const wv = Math.max(2, x1 - x0); g.fillStyle = TH.panel; g.fillRect(x0, yb, wv, h); g.strokeStyle = TH.muted; g.lineWidth = 1; g.strokeRect(x0 + .5, yb + .5, wv - 1, h - 1); } continue; }
    let code = s[1]; if ((code & 4) && ogSplit(gr)) code &= ~4;   /* 割れている群では多数が恣意的なので紫を出さない */
    if (code === 1) continue; const xs = orthX(o); if (!xs) continue;
    for (const [x0, x1] of xs){ const wv = Math.max(1, x1 - x0); if (code & 4){ g.fillStyle = TH.inv; g.fillRect(x0, yb, wv, h); } if (code & 2){ g.fillStyle = TH.disp; g.fillRect(x0, yb, wv, h); g.fillStyle = TH.panel; for (let x = x0 + 1; x < x1; x += 4) g.fillRect(x, yb, 1, h); } } }
  for (const e of (row.extra || [])){ const xs = orthX({ c0: e[0], c1: e[1], n0: e[5], n1: e[6] }); if (!xs) continue; for (const [x0, x1] of xs){ g.fillStyle = TH.accent; g.fillRect(x0, yb, Math.max(1, x1 - x0), h); } }
  return true; }
function drawOrthMarksAll(g){ const w = win(); if (!w._orth || !w._orth.groups || !w._orthRows) return false; LY.rows.forEach((r, ri) => drawOrthMarks(g, r, ri * RH)); return true; }
// 遺伝子群の窓を開く（群の列区間 ± 40 列。アレル行列か、狭ければ塩基）／運命の表／名前検索
const _ogCache = new Map();   // og → 群オブジェクト（最後に見た）
function ogButtons(o){ return `<p><button data-act="ogopen" data-og="${o.og}">この遺伝子の窓を開く</button> ${cb.onOrthGroup ? `<button data-act="ogfate" data-og="${o.og}">運命の表（株 × 状態）</button>` : ''}</p>`; }
function openOgWindow(o){ if (!o || o.c0 == null || o.c0 < 0) return; _ogCache.set(o.og, o); const pad = 40; st.selOg = o.og; st.pinned = false; setDetailWide(false); openSites({ c0: Math.max(0, o.c0 - pad), c1: o.c1 + pad }, o.name || ('群 #' + o.og), -1); }
function openOgFate(og){ if (!(cb && cb.onOrthGroup)) return; st.pinned = true; setDetailWide(true); $('detailbody').innerHTML = `<p class="k">遺伝子群 #${og} の運命の表を読んでいます…</p>`;
  cb.onOrthGroup(og).then(r => { if (!r || r.error || !r.group){ setDetail(`<p class="k">読めませんでした: ${esc((r && r.error) || '応答なし')}</p>`); return; } r._effPending = canFateEffects(r); setDetail(renderOgFate(r)); $('detailbody')._fate = r;
    if (r._effPending) fateEffects(r).then(fe => { r._effPending = false; r._eff = fe; if ($('detailbody')._fate === r) setDetail(renderOgFate(r)); }).catch(e => { r._effPending = false; r._eff = { error: String(e) }; if ($('detailbody')._fate === r) setDetail(renderOgFate(r)); }); }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
// 運命の表に「整列からの効果」を足す: 窓を開かずに、その群の列区間（±12 列）の塩基 MSA と遺伝子を取り、computeEffectsCore を回す。
//   群の列区間が 3,000 列を超えるときは出さない（塩基 MSA が重い）。結果は r._eff = {E, L（群の座位）, M}
function canFateEffects(r){ const g = r.group; return !!(cb && cb.onTokRanges && cb.onBaseFetch && cb.onGenesCols && g && g.cds && g.c0 != null && g.c1 != null && g.c1 - g.c0 + 1 <= 3000); }
function fateEffects(r){ const g = r.group; const pad = 12; const c0 = Math.max(0, g.c0 - pad), c1 = g.c1 + pad;
  return cb.onTokRanges(c0, c1).then(t => { const rs = (t && t.ranges || []).filter(x => x[2] > x[1]); if (!rs.length) throw new Error('範囲にトークンがありません'); return Promise.all([cb.onBaseFetch(rs, g.name || ('群 #' + g.og), BASE_LEAF_REQ), cb.onGenesCols(c0, c1)]); })
    .then(([M, gr]) => { if (!M || M.error || !M.cols || !M.cols.length) throw new Error((M && M.error) || '塩基がありません'); const gcols = new Map(); if (gr && gr.rows) for (const row of gr.rows){ const a = gcols.get(row.hap) || []; a.push(...row.genes); gcols.set(row.hap, a); }
      const refRow = LY.rows.find(x => x.isref); const E = computeEffectsCore(M, gcols, refRow ? refRow.hap : null);
      // 群の座位 = 群の構成遺伝子（名前が一致）を含む座位。無ければ最長
      const names = new Set(r.members.map(m => m.name).filter(Boolean)); let L = E.loci.find(l => l.members.some(c => names.has(c.ge[1]))) || E.loci.slice().sort((a, b) => (b.ncodon || 0) - (a.ncodon || 0))[0] || null;
      return { E, L, M, c0, c1 }; }); }
function fateEffOf(r, hap){ const fe = r._eff; if (!fe || !fe.L || !fe.L.rows) return null; for (const [label, S] of fe.L.rows) if (label.replace(/·\d+$/, '') === hap) return S; return null; }
function fateEffCell(S, chip){ if (!S) return '<td class="k">—</td>'; if (S.absent) return '<td class="k">整列に塩基なし</td>';
  const parts = []; if (S.lof) parts.push(chip('機能喪失', EFF_COL[3])); if (S.nonsense) parts.push(`終止 ${S.nonsense}`); if (S.fs) parts.push(`FS ${S.fs}${S.fsNet === 0 ? '（枠は戻る）' : ''}`); if (S.startLost) parts.push('開始喪失'); if (S.stopLost) parts.push('終止喪失'); if (S.inframe) parts.push(`インフレーム ${S.inframe}`);
  return `<td>${parts.join(' ')} <span class="k">同義 ${S.syn}・非同義 ${S.mis}${S.aaLen != null ? ` · ${S.aaLen}/${S.modelAa} aa` : ''}</span></td>`; }
function renderOgFate(r){ const g = r.group; const H = r.H || 1; const med = g.bp || 1; const clear = Math.max(g.plus, g.n - g.plus) >= OG_CLEAR * g.n; const majPlus = g.plus * 2 >= g.n ? 1 : 0;
  const order = new Map(LY.rows.map((row, i) => [row.hap, i])); const byHap = new Map(); for (const m of r.members){ const a = byHap.get(m.hap) || []; a.push(m); byHap.set(m.hap, a); }
  const haps = [...new Set([...LY.rows.map(x => x.hap), ...r.members.map(m => m.hap), ...r.absent])].sort((a, b) => ((order.get(a) ?? 1e9) - (order.get(b) ?? 1e9)) || (a < b ? -1 : 1));
  const chip = (txt, col, fg) => `<span style="display:inline-block;padding:0 6px;border-radius:3px;background:${col};color:${fg || '#fff'};font-size:10.5px">${txt}</span>`;
  let n_abs = 0, n_ps = 0, n_inv = 0, n_short = 0, n_multi = 0;
  const effOn = !!(r._eff && r._eff.L); const effTd = h => effOn ? fateEffCell(fateEffOf(r, h), chip) : ''; let n_lof = 0; if (effOn) for (const h of haps){ const S = fateEffOf(r, h); if (S && !S.absent && S.lof) n_lof++; }
  const rowsHtml = haps.map(h => { const ms = byHap.get(h); if (!ms || !ms.length){ n_abs++; return `<tr><td>${esc(h.replace(/#1$/, ''))}</td><td>${chip('無い', '#fff', '#64707c').replace('background:#fff', 'background:#fff;border:1px solid #64707c')}</td><td colspan="5" class="k"></td>${effTd(h)}</tr>`; }
    if (ms.length > 1) n_multi++;
    return ms.map((m, i) => { const flags = []; if (m.pseudo){ flags.push(chip('擬似', TH.disp)); n_ps++; } if (clear && m.cdir !== majPlus){ flags.push(chip('逆向き', TH.inv)); n_inv++; } if (m.len < 0.8 * med){ flags.push(chip(`短い ${Math.round(100 * m.len / med)}%`, '#c9302c')); n_short++; } if (!flags.length) flags.push(chip('持つ', TH.accent)); if (ms.length > 1) flags.push(chip(`${i + 1}/${ms.length} 個目`, '#64707c'));
      return `<tr><td>${i === 0 ? esc(h.replace(/#1$/, '')) : ''}</td><td>${flags.join(' ')}</td><td>${esc(m.name || '')}${m.locus && m.locus !== m.name ? ` <span class="k">${esc(m.locus)}</span>` : ''}</td><td style="text-align:right">${m.len.toLocaleString()}</td><td>${m.start.toLocaleString()}–${m.end.toLocaleString()} ${m.strand}</td><td>${m.cdir ? '+' : '−'}</td><td class="k">${esc((m.product || '').slice(0, 60))}</td>${effOn ? (i === 0 ? effTd(h) : '<td></td>') : ''}</tr>`; }).join(''); }).join('');
  return `<p><span class="h">運命の表</span> <span class="k">${esc(g.name || '群 #' + g.og)} · ${g.nhap} / ${H} 株が持つ · 構成 ${g.n} · 長さの中央値 ${med.toLocaleString()} bp · ${g.cds ? 'CDS' : 'CDS 以外'}${g.product ? ' · ' + esc(g.product) : ''}</span><br>` +
    `<span class="k">無い ${n_abs} · 擬似 ${n_ps} · 逆向き ${clear ? n_inv : '—（向きが割れている群）'} · 短い（中央値の 80% 未満）${n_short} · 1 株に複数 ${n_multi}。行は今の窓の並び順、鎖は合意の向きに対して</span><br>` +
    (effOn ? `<span class="k">整列からの効果（モデル ${esc(r._eff.L.name)} の枠、多数派のコドンと比較、${r._eff.L.ncodon} コドン）: <b style="color:${n_lof ? EFF_COL[3] : 'inherit'}">機能喪失 ${n_lof} 株</b>。RefSeq の「擬似」と食い違う行は、整列の乱れ（indel が多い）か注釈の違い</span><br>` : (r._effPending ? '<span class="k">整列からの効果を計算しています…</span><br>' : (r._eff && r._eff.error ? `<span class="k">整列からの効果: ${esc(r._eff.error)}</span><br>` : ''))) +
    `<button data-act="ogopen" data-og="${g.og}">この遺伝子の窓を開く</button> <button data-act="ogtsv">TSV をコピー</button></p>` +
    `<div style="max-height:min(60vh,520px);overflow:auto"><table style="border-collapse:collapse;font-size:11px;width:100%"><tr><th>株</th><th>状態</th><th>名前</th><th>長さ</th><th>座標（コンティグ）</th><th>鎖</th><th>産物</th>${effOn ? '<th>整列からの効果</th>' : ''}</tr>${rowsHtml}</table></div>`; }
function ogFateTsv(r){ const g = r.group; const med = g.bp || 1; const clear = Math.max(g.plus, g.n - g.plus) >= OG_CLEAR * g.n; const majPlus = g.plus * 2 >= g.n ? 1 : 0; const effOn = !!(r._eff && r._eff.L); const effCols = S => !effOn ? [] : (!S ? ['', '', '', '', '', '', '', '', ''] : [S.absent ? '' : (S.lof ? 'LoF' : 'ok'), S.syn, S.mis, S.nonsense, S.fs, S.startLost, S.stopLost, S.aaLen == null ? '' : S.aaLen, S.modelAa]);
  const out = [['hap', 'status', 'name', 'locus', 'len_bp', 'len_frac', 'start', 'end', 'strand', 'strand_vs_consensus', 'product', ...(effOn ? ['effect', 'syn', 'missense', 'nonsense', 'frameshift', 'start_lost', 'stop_lost', 'aa_len', 'model_aa'] : [])].join('\t')];
  for (const m of r.members){ const stt = [m.pseudo ? 'pseudo' : '', (clear && m.cdir !== majPlus) ? 'inverted' : '', m.len < 0.8 * med ? 'short' : ''].filter(Boolean).join('+') || 'present'; out.push([m.hap, stt, m.name, m.locus, m.len, (m.len / med).toFixed(2), m.start, m.end, m.strand, m.cdir ? '+' : '-', m.product, ...effCols(fateEffOf(r, m.hap))].join('\t')); }
  for (const h of r.absent) out.push([h, 'absent', '', '', '', '', '', '', '', '', '', ...effCols(fateEffOf(r, h))].join('\t')); return out.join('\n'); }
function findGene(q){ if (!(cb && cb.onOrthFind) || !q) return; st.pinned = true; $('detailbody').innerHTML = `<p class="k">「${esc(q)}」を探しています…</p>`;
  cb.onOrthFind(q, 30).then(r => { const gs = (r && r.groups) || []; if (!gs.length){ setDetail(`<p class="k">「${esc(q)}」に合う遺伝子群はありません（名前の前方一致、産物の部分一致）。</p>`); return; }
    const os = gs.map(ogObj); os.forEach(o => _ogCache.set(o.og, o));
    if (os.length === 1){ setDetail(''); openOgWindow(os[0]); return; }
    const H = (win()._orth && win()._orth.H) || DATA.meta.nhaps || 1; setDetailWide(true);
    setDetail(`<p><span class="h">「${esc(q)}」の遺伝子群</span> <span class="k">${os.length} 件（株数の多い順）。クリックでその窓を開く</span></p><table style="border-collapse:collapse;font-size:11px"><tr><th>名前</th><th>株</th><th>構成</th><th>合意座標</th><th>産物</th></tr>` +
      os.map(o => `<tr data-act="ogsel" data-og="${o.og}" style="cursor:pointer"><td data-act="ogsel" data-og="${o.og}">${esc(o.name || '群 #' + o.og)}</td><td data-act="ogsel" data-og="${o.og}" style="text-align:right">${o.nhap}/${H}</td><td data-act="ogsel" data-og="${o.og}" style="text-align:right">${o.n}</td><td data-act="ogsel" data-og="${o.og}">${fmtbp(o.x0)}–${fmtbp(o.x1)}</td><td data-act="ogsel" data-og="${o.og}" class="k">${esc((o.product || '').slice(0, 60))}</td></tr>`).join('') + '</table>'); }).catch(e => setDetail(`<p class="k">失敗: ${esc(String(e))}</p>`)); }
// ── ズーム（木の範囲で一本化、README 改訂 112）──
//   範囲は 2 通りだけ: {atoms:[a0,a1]}（ブロック段の窓＝原子の範囲）／{atom, c0, c1}（原子の中の列区間＝アレル行列・塩基）。合意 bp は使わない。
//   画面の x（合意 bp）→ 原子は重なりで、原子の中は列比例（遺伝子トラックと同じ写像）。私有ノードの幅の内側を選んでも列が潰れない。
//   決定表: 原子 2 個以上で今の窓と違う → ブロック窓（原子で要求）／ 1 原子: 列 ≤ BASE_MAX_LEAVES（3,000 = bubble MSA の実用上限）→ 塩基の段（俯瞰で入る）、
//   それ以上 → 変異の段（木の索引。塩基が計算できない広さの俯瞰）。塩基の段はズーム軸を持ち、俯瞰（群 1 px 以上・アレル色）→ 塩基セル → 文字（改訂 117）。通知は格子の上の帯（toast）。計算中は Esc で中断、30 秒で自動解除
let _toastTimer = null;
function toast(msg, action){ const t = $('toast'); if (!t) return; t.innerHTML = `<span>${msg}</span>` + (action ? `<button id="bk_toastact">${esc(action.label)}</button>` : ''); t.style.display = 'flex'; if (action){ const b = root.querySelector('#bk_toastact'); if (b) b.addEventListener('click', () => { hideToast(); action.run(); }); }
  if (_toastTimer) clearTimeout(_toastTimer); _toastTimer = setTimeout(hideToast, action ? 15000 : 7000); }
function hideToast(){ const t = $('toast'); if (t) t.style.display = 'none'; if (_toastTimer){ clearTimeout(_toastTimer); _toastTimer = null; } }
function beginDrill(msg){ st.drilling = true; st.drillT0 = Date.now(); st.busy = msg; updateButtons(); drawGrid(); }
function endDrill(){ st.drilling = false; st.busy = null; st.rangeSel = null; }
function atomOfCol(c){ const A = DATA.meta.atoms || []; let lo = 0, hi = A.length - 1, r = -1; while (lo <= hi){ const m = (lo + hi) >> 1; if (A[m][2] != null && A[m][2] <= c){ r = m; lo = m + 1; } else hi = m - 1; } return r; }
function colsOfAtom(a){ const A = DATA.meta.atoms[a]; return A && A[2] != null ? [A[2], A[3]] : null; }
// 画面の合意 bp の範囲 → 木の範囲。重なる原子が 2 個以上なら原子の範囲、1 個ならその原子の中の列区間（列比例）
function xToRange(xa, xb){ const A = DATA.meta.atoms || []; if (!A.length || A[0][2] == null) return null; const hit = []; for (let i = 0; i < A.length; i++){ const x0 = A[i][0], x1 = x0 + Math.max(1, A[i][1]); if (x1 > xa && x0 < xb) hit.push(i); } if (!hit.length) return null;
  if (hit.length >= 2) return { atoms: [hit[0], hit[hit.length - 1]] };
  const a = hit[0]; const x0 = A[a][0], span = Math.max(1, A[a][1]); const nc = A[a][3] - A[a][2] + 1; const c0 = A[a][2] + Math.max(0, Math.min(nc - 1, Math.floor((xa - x0) / span * nc))), c1 = A[a][2] + Math.max(0, Math.min(nc - 1, Math.ceil((xb - x0) / span * nc) - 1)); return { atom: a, c0: Math.min(c0, c1), c1: Math.max(c0, c1) }; }
function xOfCols(a, c0, c1){ const A = DATA.meta.atoms[a]; const nc = A[3] - A[2] + 1; const span = Math.max(1, A[1]); return [A[0] + (c0 - A[2]) / nc * span, A[0] + (c1 - A[2] + 1) / nc * span]; }
function windowAtoms(w){ if (w.atomRange) return w.atomRange; const L0 = w.levels && w.levels[0]; if (!L0 || !L0.blocks || !L0.blocks.length || L0.blocks[0].a0 == null) return null; let a0 = Infinity, a1 = -Infinity; for (const B of L0.blocks){ a0 = Math.min(a0, B.a0); a1 = Math.max(a1, B.a1); } return [a0, a1]; }
function rangeLabel(rg){ if (rg.atoms){ const A = DATA.meta.atoms; return fmtRange(A[rg.atoms[0]][0], A[rg.atoms[1]][0] + A[rg.atoms[1]][1]); } return `#${rg.atom + 1} 列 ${rg.c0.toLocaleString()}–${rg.c1.toLocaleString()}`; }
const ZOOM_MIN_COLS = 24, DRILL_TIMEOUT_MS = 30000;
function zoomTo(rg, label){ if (!rg || !TREE) return;
  if (st.drilling){ if (Date.now() - (st.drillT0 || 0) > DRILL_TIMEOUT_MS){ endDrill(); } else { toast('計算中です（Esc で中断）'); return; } }
  const w = win();
  if (rg.atoms){ const [a0, a1] = rg.atoms; if (a0 === a1){ const cc = colsOfAtom(a0); if (!cc) return; zoomTo({ atom: a0, c0: cc[0], c1: cc[1] }, label); return; }
    const cur = windowAtoms(w); if (cur && cur[0] === a0 && cur[1] === a1){ toast(`選んだ範囲は今の窓と同じ原子の並び（#${a0 + 1}〜#${a1 + 1}）です。ブロックの内側を選ぶか、ブロックをダブルクリックすると降ります`); return; }
    const key = 'a:' + a0 + '-' + a1; const ch = w.children ? w.children[key] : null; if (ch != null){ enterWindow(ch); return; }
    if (!(cb && cb.onRangeAtoms)) return; const lab = label || rangeLabel(rg); beginDrill(`原子 #${a0 + 1}〜#${a1 + 1}（${lab}）の窓を木から取り出しています…`);
    cb.onRangeAtoms(a0, a1, lab, w.depth + 1, st.win).then(r => { endDrill(); if (!r || r.error || !r.window){ drawAll(); toast('この区間の窓を作れませんでした: ' + esc((r && r.error) || '応答なし')); return; }
      const nw = r.window; nw.id = WINS.length; nw.parent = st.win; nw.pblock = -1; nw.plevel = st.li; nw.pW = level().W; nw.children = nw.children || {}; nw.ondemand = true; nw.ms = r.ms || 0; nw.atomRange = [a0, a1]; const A = DATA.meta.atoms; nw.range = [A[a0][0], A[a1][0] + A[a1][1]];
      WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; enterWindow(nw.id); }).catch(e => { endDrill(); drawAll(); toast('失敗: ' + esc(String(e))); }); return; }
  // 原子の中の列区間
  const cc = colsOfAtom(rg.atom); if (!cc) return; let c0 = Math.max(cc[0], Math.min(rg.c0, rg.c1)), c1 = Math.min(cc[1], Math.max(rg.c0, rg.c1));
  if (c1 - c0 + 1 < ZOOM_MIN_COLS){ const mid = (c0 + c1) >> 1; c0 = Math.max(cc[0], mid - (ZOOM_MIN_COLS >> 1)); c1 = Math.min(cc[1], c0 + ZOOM_MIN_COLS - 1); }   /* 狭すぎる（1 ノードの内側など）→ 前後に広げる */
  const n = c1 - c0 + 1; const key = 'c:' + rg.atom + ':' + c0 + '-' + c1; const ch = w.children ? w.children[key] : null; if (ch != null){ enterWindow(ch); return; }
  const lab = label || rangeLabel({ atom: rg.atom, c0, c1 });
  if (n <= BASE_MAX_LEAVES){ openBaseCols(rg.atom, c0, c1, lab, key, undefined); return; }
  openSitesCols(rg.atom, c0, c1, lab, key); }
function openSitesCols(atom, c0, c1, label, key){ if (!(cb && cb.onSites)) return; const pw = st.win; const w = win(); beginDrill(`${label} の変異サイトを集めています…`);
  cb.onSites({ c0, c1 }).then(S => { endDrill(); if (!S || S.error || S.tooMany){ drawAll(); toast(`${esc(label)}: ${esc((S && S.error) || (S && S.tooMany ? 'サイトが多すぎます。狭い区間を選んでください' : '応答なし'))}`); return; }
    const n = c1 - c0 + 1;
    if (!S.nsites || (S.nsites <= BASE_FEW_SITES && n <= BASE_IDENT_MAX)){ drawAll();
      if (n <= BASE_IDENT_MAX){ openBaseCols(atom, c0, c1, label, key, BASE_IDENT_MAX); return; }
      toast(`${esc(label)}（${n.toLocaleString()} 列）は全株同一で変異サイトがありません。塩基は ${BASE_IDENT_MAX.toLocaleString()} 列まで`, { label: `先頭 ${BASE_IDENT_MAX.toLocaleString()} 列を塩基で開く`, run: () => zoomTo({ atom, c0, c1: c0 + BASE_IDENT_MAX - 1 }) }); return; }
    const nw = indexOrSitesWindow(S, label, pw, -1, c0, c1); nw.id = WINS.length; nw.plevel = st.li; nw.range = xOfCols(atom, c0, c1); WINS.push(nw); if (!w.children) w.children = {}; w.children[key] = nw.id; nw.ms = S.ms || 0;
    enterWindow(nw.id); $('detailbody').innerHTML = S.binned ? `<p class="k">変異サイトが ${S.totalSites.toLocaleString()} 個あるので、${S.sitesPerBin} サイトずつ ${S.nsites} ビンにまとめた粗い段です（列 ${S.ncols}、${S.ncover} 株が被覆）。列見出しをドラッグして狭めると、サイトごとのアレルの段へ降ります。</p>` : `<p class="k">変異サイト ${S.nsites} 個（列 ${S.ncols}、${S.ncover} 株が被覆）。セルの色＝アレル（灰＝多数派）。行は系統樹順。列見出しをドラッグで狭い区間へ、${BASE_MAX_LEAVES} 列以下で塩基へ。</p>`;
  }).catch(e => { endDrill(); drawAll(); toast('失敗: ' + esc(String(e))); }); }
function openBaseCols(atom, c0, c1, label, key, maxLeaves){ if (!(cb && cb.onTokRanges && (cb.onBaseFetch || cb.onBaseMsa))){ toast('この構成では塩基へ渡せません'); return; } beginDrill(`${label}: 各行のトークン範囲を求めています…`);
  cb.onTokRanges(c0, c1).then(r => { endDrill(); const rs = (r && r.ranges || []).filter(x => x[2] > x[1]); if (!r || r.error || !rs.length){ drawAll(); toast(`塩基へ渡せませんでした: ${esc((r && r.error) || 'この列を持つ株がありません')}`); return; }
    const hapOfPath = new Map(); for (const h of (WINS[0].levels[0].haps || [])) for (const c of (h.contigs || [])) hapOfPath.set(c.path, h.hap);
    const hasHap = new Set(rs.map(x => hapOfPath.get(x[0]) || x[0])); const allHaps = new Set((WINS[0].levels[0].haps || []).map(h => h.hap));
    const absent = [...allHaps].filter(h => !hasHap.has(h)).length; if (absent) toast(`${absent} 株はこの区間を持たないので塩基の段に出ません`);   /* 株（ハプロタイプ）で数える。以前はパス（コンティグ）で数えて断片化したアセンブリで 1,919 と出た */
    openBase(rs, label, -1, c0, c1, maxLeaves, xOfCols(atom, c0, c1)); }).catch(e => { endDrill(); drawAll(); toast('失敗: ' + esc(String(e))); }); }
// ── 系統樹: 全体の木（サイドカー）／表示範囲の木（画面側で作り直す）、高さの閾値で枝をまとめる ──
function activeTree(){ return (st.treeMode === 'range' && st.localTree) ? st.localTree : DATA.tree; }
function treeHmax(T){ return Math.max(1e-9, T.nodes[String(T.root)].h); }
// 畳む群: 閾値（根の高さに対する割合）以下で閉じる極大の内部節。present = 窓に居るハプロの集合。treeOpen（クリックで開いた節）は畳まず子へ
function treeCollapse(T, present){ if (!T || st.treeCut == null) return null; const t = st.treeCut * treeHmax(T); const out = new Map();
  (function walk(v){ const nd = T.nodes[String(v)]; if ('leaf' in nd) return; if (nd.h <= t && !st.treeOpen.has(v)){ const members = []; collectLeaves(T, v, present, members); if (members.length >= 2){ const rep = medoidOf(T, v, present); out.set(rep, { node: v, members, rep }); return; } } nd.ch.forEach(walk); })(T.root);
  return out.size ? out : null; }
function collectLeaves(T, v, present, out){ const nd = T.nodes[String(v)]; if ('leaf' in nd){ const hp = T.haps[nd.leaf]; if (present.has(hp)) out.push(hp); return; } for (const c of nd.ch) collectLeaves(T, c, present, out); }
// 群の中心: 木の上の距離（最も近い共通祖先の高さ）の和が最小の葉。群の大きさに比例する時間。同点は葉順の先。参照株は特別扱いしない
function medoidOf(T, v, present){ const size = new Map(); (function sz(u){ const nd = T.nodes[String(u)]; let s = 0; if ('leaf' in nd) s = present.has(T.haps[nd.leaf]) ? 1 : 0; else for (const c of nd.ch) s += sz(c); size.set(u, s); return s; })(v);
  let best = null, bs = Infinity; (function go(u, acc){ const nd = T.nodes[String(u)]; if ('leaf' in nd){ const hp = T.haps[nd.leaf]; if (present.has(hp) && acc < bs){ bs = acc; best = hp; } return; } for (const c of nd.ch) go(c, acc + nd.h * (size.get(u) - size.get(c))); })(v, 0); return best; }
function showClade(v){ const g = _cladeByNode ? _cladeByNode.get(v) : null; if (!g) return; setHoverInfo(`<p><span class="h">まとめた群</span> <span class="k">${g.members.length} 株 · 代表 ${esc(g.rep)}（群の中心）· クリックでこの群を開く</span><br><span class="k">${g.members.slice(0, 40).map(esc).join(', ')}${g.members.length > 40 ? ' …' : ''}</span></p>`, 'clade'); }
// 表示範囲の木: 窓の内容から距離を作り UPGMA。n ≤ 300 は厳密、それ以上はビット列（popcount）、n > 800 は二段（最遠点抽出の目印 √n 個 → 群の中だけ全対 → 群どうしは中心株の距離 → 継ぐ）
const LT_EXACT_MAX = 300, LT_FULL_MAX = 800, LT_BITS = 8192;
function ensureLocalTree(){ if (st.treeMode !== 'range' || !DATA.tree){ st.localTree = null; st.localTreeKey = ''; return; } const L = level(); if (!L || !L.haps) return;
  const key = [st.win, st.li, L.mode || 'blocks', st.filter ? [...st.filter].join(',') : '', L.haps.length].join('|'); if (st.localTreeKey === key && st.localTree) return;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()); const t0 = now(); try { st.localTree = buildLocalTree(L); } catch (e) { console.error('local tree', e); st.localTree = null; } st.localTreeKey = key; st.localTreeMs = Math.round(now() - t0); }
function hash32(x){ x = (x ^ 61) ^ (x >>> 16); x = (x + (x << 3)) | 0; x = x ^ (x >>> 4); x = Math.imul(x, 0x27d4eb2d); x = x ^ (x >>> 15); return x >>> 0; }
function popcnt(v){ v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
function sketchDist(a, b){ let x = 0, o = 0; for (let q = 0; q < a.length; q++){ x += popcnt(a[q] ^ b[q]); o += popcnt(a[q] | b[q]); } return o ? x / o : 0; }
function sitesCells(S){ if (!S._cells){ const raw = atob(S.cells); const u = new Uint8Array(raw.length); for (let i=0;i<raw.length;i++) u[i] = raw.charCodeAt(i); S._cells = u; } if (!S._hidx) S._hidx = new Map(S.haps.map((h,i)=>[h,i])); return S._cells; }
// 窓の内容 → 各ハプロの素材（厳密用）とビット列（近似用）と厳密距離関数
function localFeatures(L){ const haps = L.haps.map(h => h.hap); const n = haps.length; const words = LT_BITS >>> 5; const sk = new Array(n); const ex = new Array(n); const mode = L.mode || 'blocks';
  const setbit = (bits, key) => { const b = hash32(key) % LT_BITS; bits[b >>> 5] |= 1 << (b & 31); };
  if (mode === 'sites'){ const S = L.sites; sitesCells(S); const H = S.H;
    for (let i = 0; i < n; i++){ const hi = S._hidx.get(haps[i]); const bits = new Uint32Array(words); const cells = new Uint8Array(S.nsites); cells.fill(255); if (hi != null) for (let k = 0; k < S.nsites; k++){ const a = S._cells[k*H + hi]; cells[k] = a; if (a !== 255) setbit(bits, k * 16 + a); } sk[i] = bits; ex[i] = cells; }
    return { n, haps, sk, exact: (a, b) => { const A = ex[a], B = ex[b]; let m = 0, c = 0; for (let k = 0; k < A.length; k++){ const u = A[k], v = B[k]; if (u === 255 || v === 255) continue; c++; if (u !== v) m++; } return c ? m / c : 1; } }; }
  if (mode === 'base'){ const M = L.base; const rowOf = M._rowOf || new Map((M.rows || []).map((r, i) => [r.label, i]));   /* M._rowOf は baseLayout が _inv 等と一緒に作る。ここで作ると baseLayout の初期化が飛ぶので触らない */
    for (let i = 0; i < n; i++){ const mi = rowOf.get(haps[i]); const seq = mi != null ? (M.rows[mi].seq || '') : ''; const bits = new Uint32Array(words); for (let k = 0; k < seq.length; k++){ const ch = seq.charCodeAt(k); if (ch === 45) continue; setbit(bits, k * 8 + (ch & 7)); } sk[i] = bits; ex[i] = seq; }
    return { n, haps, sk, exact: (a, b) => { const A = ex[a], B = ex[b]; const len = Math.min(A.length, B.length); let m = 0, c = 0; for (let k = 0; k < len; k++){ const u = A.charCodeAt(k), v = B.charCodeAt(k); if (u === 45 || v === 45) continue; c++; if (u !== v) m++; } return c ? m / c : 1; } }; }
  // ブロック段: 見えているブロック（原子）の有無 ＋ 合意座標の少数派サイトの区画（cvs、0..255）。重みはブロックの長さ
  const vis = visibleBlocks(); const span = new Map(vis.map(r => [r, Math.max(1, L.blocks[r].span || 1)]));
  for (let i = 0; i < n; i++){ const bits = new Uint32Array(words); const per = new Map();
    for (const c of L.haps[i].contigs) for (const x of c.inst){ if (x[5] >= 4 || !span.has(x[0])) continue; const r = x[0]; let bs = per.get(r); if (!bs){ bs = new Uint32Array(8); per.set(r, bs); for (let q = 0; q < 4; q++) setbit(bits, r * 7919 + q); } const cv = consSites(x); for (let k = 0; k < cv.length; k++){ const v = cv[k]; bs[v >>> 5] |= 1 << (v & 31); setbit(bits, 1000003 + r * 256 + v); } }
    sk[i] = bits; ex[i] = per; }
  return { n, haps, sk, exact: (a, b) => { const A = ex[a], B = ex[b]; let num = 0, den = 0; for (const [r, w] of span){ const u = A.get(r), v = B.get(r); if (!u && !v) continue; den += w; if (!u || !v){ num += w; continue; } let x = 0, o = 0; for (let q = 0; q < 8; q++){ x += popcnt(u[q] ^ v[q]); o += popcnt(u[q] | v[q]); } if (o) num += w * x / o; } return den ? num / den : 1; } }; }
// UPGMA（最近隣連鎖法、対の数に比例）。D は n×n の Float32Array。葉 0..n-1、内部節は n 以上。高さは距離/2（子より低くならないよう max）
function upgmaFromMatrix(n, D){ const size = new Float64Array(n).fill(1); const alive = new Uint8Array(n).fill(1); const nodeOf = new Int32Array(n); const nodes = {}; for (let i = 0; i < n; i++){ nodes[i] = { id: i, h: 0, leaf: i }; nodeOf[i] = i; } let next = n; const stack = []; let remaining = n;
  while (remaining > 1){ if (!stack.length){ for (let i = 0; i < n; i++) if (alive[i]){ stack.push(i); break; } }
    for (;;){ const a = stack[stack.length - 1]; let b = -1, bd = Infinity; for (let j = 0; j < n; j++){ if (!alive[j] || j === a) continue; const d = D[a*n + j]; if (d < bd){ bd = d; b = j; } }
      const k = stack.indexOf(b);
      if (k >= 0){ stack.length = k; const id = next++; nodes[id] = { id, h: Math.max(bd / 2, nodes[nodeOf[a]].h, nodes[nodeOf[b]].h), ch: [nodeOf[a], nodeOf[b]] };
        const sa = size[a], sb = size[b]; for (let m = 0; m < n; m++){ if (!alive[m] || m === a || m === b) continue; const d = (sa * D[a*n + m] + sb * D[b*n + m]) / (sa + sb); D[a*n + m] = d; D[m*n + a] = d; } size[a] = sa + sb; alive[b] = 0; nodeOf[a] = id; remaining--; break; }
      stack.push(b); } }
  let root = -1; for (let i = 0; i < n; i++) if (alive[i]){ root = nodeOf[i]; break; }
  return { nodes, root, next }; }
function finishTree(nodes, root, names, how, k){ const order = []; (function walk(v){ const nd = nodes[v]; if ('leaf' in nd) order.push(nd.leaf); else nd.ch.forEach(walk); })(root); return { nodes, root, order, haps: names, how, k }; }
function buildLocalTree(L){ const F = localFeatures(L); const n = F.n; if (!n) return null; const exactOK = n <= LT_EXACT_MAX; return treeFromDist(n, exactOK ? F.exact : (a, b) => sketchDist(F.sk[a], F.sk[b]), F.haps, exactOK); }
// 距離関数から木を作る（n ≤ LT_FULL_MAX は全対、それ以上は二段）。試験用に handle._treeFromDist でも呼べる
function treeFromDist(n, dist, names, exactOK){
  if (n === 1) return finishTree({ 0: { id: 0, h: 0, leaf: 0 } }, 0, names, 'exact', 0);
  if (n <= LT_FULL_MAX){ const D = new Float32Array(n * n); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++){ const d = dist(i, j); D[i*n + j] = d; D[j*n + i] = d; } const r = upgmaFromMatrix(n, D); return finishTree(r.nodes, r.root, names, exactOK ? 'exact' : 'sketch', 0); }
  // 二段: 最遠点抽出で √n 個の目印 → 各株を最も近い目印の群へ（n√n 回の距離）→ 群の中は全対 → 群どうしは中心株の距離 → 継ぐ
  const k = Math.max(2, Math.ceil(Math.sqrt(n))); const lm = [0]; const minD = new Float64Array(n).fill(Infinity); const near = new Int32Array(n);
  for (let t = 0; t < k; t++){ const c = lm[t]; for (let i = 0; i < n; i++){ const d = dist(i, c); if (d < minD[i]){ minD[i] = d; near[i] = t; } } if (t + 1 < k){ let bi = -1, bd = -1; for (let i = 0; i < n; i++) if (minD[i] > bd){ bd = minD[i]; bi = i; } lm.push(bi); } }
  const cells = Array.from({ length: k }, () => []); for (let i = 0; i < n; i++) cells[near[i]].push(i);
  const nodes = {}; let next = n; for (let i = 0; i < n; i++) nodes[i] = { id: i, h: 0, leaf: i };
  const cellRoot = [], cellMed = [];
  for (let t = 0; t < k; t++){ const m = cells[t]; if (!m.length){ cellRoot.push(-1); cellMed.push(-1); continue; } if (m.length === 1){ cellRoot.push(m[0]); cellMed.push(m[0]); continue; }
    const mm = m.length; const D = new Float32Array(mm * mm); const sum = new Float64Array(mm); for (let i = 0; i < mm; i++) for (let j = i + 1; j < mm; j++){ const d = dist(m[i], m[j]); D[i*mm + j] = d; D[j*mm + i] = d; sum[i] += d; sum[j] += d; }
    let med = 0; for (let i = 1; i < mm; i++) if (sum[i] < sum[med]) med = i; cellMed.push(m[med]);
    const sub = upgmaFromMatrix(mm, D); const map = new Map(); for (let i = 0; i < mm; i++) map.set(i, m[i]); for (const id of Object.keys(sub.nodes).map(Number)) if (!('leaf' in sub.nodes[id])) map.set(id, next++);
    for (const id of Object.keys(sub.nodes).map(Number)){ const nd = sub.nodes[id]; if ('leaf' in nd) continue; const nid = map.get(id); nodes[nid] = { id: nid, h: nd.h, ch: nd.ch.map(c => map.get(c)) }; }
    cellRoot.push(map.get(sub.root)); }
  const live = []; for (let t = 0; t < k; t++) if (cellRoot[t] >= 0) live.push(t); const kk = live.length; const DL = new Float32Array(kk * kk); for (let i = 0; i < kk; i++) for (let j = i + 1; j < kk; j++){ const d = dist(cellMed[live[i]], cellMed[live[j]]); DL[i*kk + j] = d; DL[j*kk + i] = d; }
  const top = upgmaFromMatrix(kk, DL); const map2 = new Map(); for (let i = 0; i < kk; i++) map2.set(i, cellRoot[live[i]]); for (const id of Object.keys(top.nodes).map(Number)) if (!('leaf' in top.nodes[id])) map2.set(id, next++);
  for (const id of Object.keys(top.nodes).map(Number)){ const nd = top.nodes[id]; if ('leaf' in nd) continue; const ch = nd.ch.map(c => map2.get(c)); const nid = map2.get(id); nodes[nid] = { id: nid, h: Math.max(nd.h, ...ch.map(c => nodes[c].h)), ch }; }
  return finishTree(nodes, map2.get(top.root), names, 'two-level', k); }
function setTreeMode(m){ st.treeMode = m; $('t_global').setAttribute('aria-pressed', m==='global' ? 'true' : 'false'); $('t_range').setAttribute('aria-pressed', m==='range' ? 'true' : 'false'); st.localTreeKey = ''; st.treeOpen.clear(); drawAll(); }
function drawTree(){
  const svg = $('tree'); const T = activeTree(); const show = st.order==='tree' && !!T; root.style.setProperty('--treew', show?'130px':'0px');
  const cw_ = $('cutwrap'); if (cw_) cw_.style.display = show ? '' : 'none'; const sl = $('cut'); if (sl && show && document.activeElement !== sl) sl.value = String(st.treeCut == null ? 100 : Math.round((1 - st.treeCut) * 100)); if ($('cuttxt')) $('cuttxt').textContent = (show && _clades) ? `${LY.rows.length}/${level().haps.length} 行` : '';
  if ($('treeinfo')) $('treeinfo').textContent = (st.treeMode === 'range' && st.localTree) ? `${st.localTree.haps.length} 株 · ${st.localTree.how === 'exact' ? '厳密' : st.localTree.how === 'sketch' ? 'ビット列' : '二段（目印 ' + st.localTree.k + '）'} · ${st.localTreeMs} ms` : '';
  svg.innerHTML=''; if (!show) return;
  const Wt = 128, H = LY.rows.length*RH; svg.setAttribute('width', Wt); svg.setAttribute('height', H); const CB = _cladeByNode || new Map();
  // 葉は名前で行に対応させる（子の窓では L.haps が全体の部分集合で、番号がずれる）。窓に居ないハプロの葉は飛ばし、内部節はある子だけの平均に置く
  const rowOfHap = new Map(LY.rows.map((r,i)=>[r.hap, i])); const hmax = Math.max(1e-9, T.nodes[String(T.root)].h);
  const xOf = h => 8 + (1 - h/hmax) * (Wt-20); const ev = level().events || {};
  const yOf = {}; function place(v){ const nd = T.nodes[String(v)]; const g = CB.get(v); if (g){ const ri = rowOfHap.get(g.rep); yOf[v] = (ri==null? null : ri*RH + RH/2); return yOf[v]; } if ('leaf' in nd){ const ri = rowOfHap.get(T.haps[nd.leaf]); yOf[v] = (ri==null? null : ri*RH + RH/2); return yOf[v]; } const ys = nd.ch.map(place).filter(y=>y!=null); yOf[v] = ys.length ? ys.reduce((a,b)=>a+b,0)/ys.length : null; return yOf[v]; }
  place(T.root);
  const parts = [];
  function draw(v){ const nd = T.nodes[String(v)]; const x = xOf(nd.h), y = yOf[v]; if (y==null) return;
    const g = CB.get(v); if (g){ parts.push(`<path d="M${x},${y} L${Wt-1},${y - RH*0.38} L${Wt-1},${y + RH*0.38} Z" fill="${TH.line}" stroke="${TH.muted}" stroke-width="1" class="cl" data-node="${v}"/>`); return; }   // まとめた群: 三角
    if (!('leaf' in nd)){ for (const c of nd.ch){ const cn = T.nodes[String(c)]; const cx = xOf(cn.h), cy = yOf[c]; if (cy==null) continue;
        parts.push(`<path d="M${x},${y} V${cy} H${cx}" fill="none" stroke="${TH.muted}" stroke-width="1" data-node="${c}" class="br"/>`);
        const e = ev[String(c)]; if (e){ const n = (e.gain?e.gain.length:0)+(e.loss?e.loss.length:0); if (n){ const mx = (x+cx)/2; parts.push(`<g data-node="${c}" class="ev"><circle cx="${mx}" cy="${cy}" r="6" fill="${TH.sel}" opacity=".85"/><text x="${mx}" y="${cy+3}" font-size="8" text-anchor="middle" fill="#fff" font-family="IBM Plex Mono">${n}</text></g>`); } }
        draw(c); } }
    else { parts.push(`<line x1="${x}" y1="${y}" x2="${Wt}" y2="${y}" stroke="${TH.line2}" stroke-width="1"/>`); } }
  draw(T.root); if (st.treeCut != null){ const xc = xOf(st.treeCut * hmax); parts.push(`<line x1="${xc}" y1="0" x2="${xc}" y2="${H}" stroke="${TH.sel}" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`); }
  svg.innerHTML = parts.join('');
  svg.querySelectorAll('.cl').forEach(el=>{ el.addEventListener('mousemove', e=>{ showClade(+el.getAttribute('data-node')); }); el.addEventListener('mouseleave', ()=>{ if (_tipSrc === 'clade') setHoverInfo(''); }); el.addEventListener('click', e=>{ st.treeOpen.add(+el.getAttribute('data-node')); setHoverInfo(''); drawAll(); }); });
  svg.querySelectorAll('.ev, .br').forEach(el=>{ el.style.cursor='pointer'; el.addEventListener('mousemove', e=>{ if (st.pinned) return; showBranch(+el.getAttribute('data-node')); }); el.addEventListener('click', e=>{ st.pinned = true; showBranch(+el.getAttribute('data-node')); }); });
}
function drawChips(){ const L = level(); if (isBase()){ const M = L.base; const cmp = baseCmpSeq(M); $('chips').innerHTML = `<span class="chip">窓 <b>${esc(win().label)}</b> · 塩基の段</span><span class="chip">列 <b>${M.cols.length}</b> · ノード <b>${LY.bgroups ? LY.bgroups.length : 0}</b></span><span class="chip">行 <b>${LY.rows.length}</b></span><span class="chip">比較の基準 <b>${esc(cmp.label)}</b>（列見出しの下段）</span>${M.indexBacked ? `<span class="chip">索引の俯瞰 · サイト <b>${M.cols.length}</b>（塩基は「塩基」か列見出しのドラッグで、3,000 列まで）</span>` : ''}<span class="chip">倍率 <b>${esc(baseZoomLabel())}</b>${LY.bvOnly ? ' · 変異のある群だけ' + (LY.bautoVar ? '（自動）' : '') : ''}${baseScrollMax() ? ` · 横 ${(LY.bfullW / Math.max(1, $('gridwrap').clientWidth)).toFixed(1)} 画面分` : ''}</span>`; $('origingrp').style.display = 'none'; $('ladder').innerHTML = ''; $('scopetxt').textContent = `塩基 · 列 ${M.cols.length}`; return; } if (isSites()){ const S = L.sites; const ncol = L.c1 - L.c0 + 1; $('chips').innerHTML = `<span class="chip">窓 <b>${esc(win().label)}</b> · 変異の段${S.binned ? `（粗い: ${S.sitesPerBin} サイト/ビン）` : ''}</span><span class="chip">変異サイト <b>${S.binned ? S.totalSites.toLocaleString() : S.nsites}</b></span><span class="chip">列 <b>${ncol}</b>${ncol <= BASE_MAX_LEAVES ? ' · 塩基へ渡せます' : ` · 塩基へは ${BASE_MAX_LEAVES} 以下`}</span><span class="chip">被覆 <b>${S.ncover}</b> 株 · 行 <b>${LY.rows.length}</b></span>`; $('origingrp').style.display = 'none'; const ld = $('ladder'); ld.innerHTML = ''; $('scopetxt').textContent = `変異サイト ${S.nsites} · 列 ${ncol}`; return; } let inv=0, disp=0, rep=0, small=0; for (const r of LY.rows) for (const p of r.items){ const k=p.o.kind; if (k===3) inv++; else if (k===2) disp++; else if (k===4) rep++; else if (k===5) small++; }
  $('chips').innerHTML = `<span class="chip">窓 <b>${st.win===0?"全体":esc(win().label)}</b>${(level().mode==='bins')?' · <b>座標分割</b>（再編成なし・等分）':''} · ${level().mode==='bins'?'錨':'原子区間'} ${win().atoms.toLocaleString()} · 深さ ${win().depth}${win().composed?` · <b>継ぎ合わせ</b>`:(win().ondemand?` · <b>逐次計算</b>${win().ms?' '+win().ms+' ms':''}`:'')}</span><span class="chip">${TREE ? '境界の持続度' : (L.mode==='bins'?'ビン幅':'段の幅')} <b>${TREE && !L.W ? '全部' : fmtbp(L.W)}${TREE && L.W ? ' 以上' : ''}</b></span><span class="chip">ブロック <b>${LY.vis.length}</b></span><span class="chip">行 <b>${LY.rows.length}</b></span><span class="chip">逆位 <b>${inv}</b> 変位 <b>${disp}</b> 小群 ${small}</span><span class="chip">${L.members?`最細段の併合 <b>${L.merges||0}</b> 回`:`併合の上限 <b>${L.mergecap||0}</b> 株`}${L.nonmono?` · 内部順序ずれ ${L.nonmono}`:''}</span>${st.filter?`<span class="chip">絞り込み <b>${st.filter.size}</b> / ${win().levels[0].nblocks}</span>`:''}${st.anc && anchorsOf(win())?`<span class="chip">錨の対応線 <b>${anchorsOf(win()).m}</b> 本/行${st.anc2 && anchorsOf(win()).m2?` · 第二錨 <b>${anchorsOf(win()).m2}</b>`:''}</span>`:''}`;
  const ld = $('ladder'); ld.innerHTML=''; win().levels.forEach((lv,i)=>{ const b=document.createElement('button'); b.className='mono'; b.textContent = TREE ? (lv.nblocks+' ブロック') : (fmtbp(lv.W)+' ('+lv.nblocks+')'); if (TREE) b.title = lv.W ? ('境界の持続度 '+fmtbp(lv.W)+' 以上を残した段') : '範囲内の境界を全部残した段'; b.setAttribute('aria-pressed', i===st.li?'true':'false'); b.addEventListener('click',()=>{ st.li=i; st.sel=null; st.origin=null; st.pinned=false; drawAll(); emitSel(); }); ld.appendChild(b); });
  $('origingrp').style.display = (DATA.meta.circular && st.win===0) ? '' : 'none';
  $('origintxt').textContent = DATA.meta.circular ? `#${originRank()+1}${st.origin==null?'（自動）':''}` : '';
  $('scopetxt').textContent = (win().parent>=0 ? `親 ${win().pblock>=0?'#'+(win().pblock+1):'区間'}${win().pW && !TREE?`（段 ${fmtbp(win().pW)}）`:''} の内側 · ` : '') + (TREE ? `${level().nblocks} ブロック` : `段 ${fmtbp(level().W)}`) + (st.filter ? ` · 絞り込み ${st.filterPath.map(e=>e.label).join('›')}（最細 ${st.filter.size} ブロック）` : '');
}
function childKey(rank){ return String(rank); }   // 子窓の鍵（最細段の rank）。粗い段のブロックは絞り込み表示で、子窓は作らない
// 塩基レベルへ渡せるか: 列（葉ノード）が bubble MSA の上限 400 以下と見込めるブロック（典型長 / bp/token）
const BASE_MAX_LEAVES = 3000; const BASE_IDENT_MAX = 3000; const BASE_FEW_SITES = 20; const BASE_LEAF_REQ = 12000;
/* 列（葉）がこれ以下なら塩基へ。ecoli50 は ≈ 11 bp/列なので 1,200 列 ≈ 13 kb ≈ 遺伝子数個（3,000 列でも計算は 2 秒・5 MB だが、横幅が 7 px × 塩基数になるので
   1 遺伝子〜十数遺伝子に留める。README 改訂 113）。BASE_IDENT_MAX: 変異サイトが無い区間の上限。BASE_LEAF_REQ: サーバへ渡す葉の上限（python の既定 400 のままだと
   400 列超でエラー。私有ノードが乗るので列数より多めに。backend も 12,000 で頭打ち） */
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
  if (isBase()){ const Mi = baseOf(); if (Mi && Mi.indexBacked){ el.innerHTML = `<span>索引の俯瞰: 1 サイト = 1 列。区画の色＝アレル（${SITES_COLORS.slice(0, 4).map((c, i) => `<span class="sw" style="background:${c}"></span>${i === 0 ? '多数派' : '#' + (i + 1)}`).join(' ')} …）。「一致を省く」で多数派と同じ区画を薄く。拡大して 3,000 列以下になったら「塩基」で塩基の段へ</span>`; return; } if (st.beff && genesOn()){ const sw = (c, t) => `<span><span class="sw" style="background:${EFF_COL[c]}"></span>${t}</span>`; el.innerHTML = `<span>変異の効果（CDS の中、セルの上辺。多数派のコドンとの比較、モデルの株の読み枠）:</span>${sw(1, '同義')}${sw(2, '非同義')}${sw(3, '終止獲得・終止喪失・開始喪失・フレームシフト')}${sw(7, 'インフレーム indel')}${sw(8, '読み枠がずれた区間')} <button data-act="efftsv" style="font-size:10.5px;padding:1px 6px" title="この窓の変異ごとの効果（株・遺伝子・コドン・塩基・アミノ酸・効果）を TSV でコピー">TSV</button>`; const b = el.querySelector('[data-act="efftsv"]'); if (b) b.addEventListener('click', () => copyPlain(effectsTsv(), '効果を TSV でコピーしました')); } return; }
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
const COPY_SRC = new Set(['gene', 'fold', 'site', 'base', 'orth']);   // junc はクリックで接合カード   // ボタンでもブロック選択でもない所: クリックで内容をクリップボードへ
function placeTip(){ const t = $('tip'); if (!t || t.style.display === 'none') return; const root = t.parentElement; if (!root) return; const W = root.clientWidth || 1200, H = root.clientHeight || 600; const tw = t.offsetWidth || 300, th = t.offsetHeight || 60;
  let x = _tipPos.x + 14, y = _tipPos.y + 16; if (x + tw > W - 4) x = Math.max(4, _tipPos.x - tw - 10); if (y + th > H - 4) y = Math.max(4, _tipPos.y - th - 8); t.style.left = x + 'px'; t.style.top = y + 'px'; }
function copyHover(){ if (!_tipHtml) return false; const t = $('tip'); let text = ''; try { const d = document.createElement('div'); d.innerHTML = _tipHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'); text = (d.textContent || '').replace(/\n{3,}/g, '\n\n').trim(); } catch (e) { text = _tipHtml; }
  const done = () => { if (t){ t.innerHTML = _tipHtml + '<p class="copied">コピーしました</p>'; if (_copiedTimer) clearTimeout(_copiedTimer); _copiedTimer = setTimeout(() => { if (t.style.display !== 'none' && _tipHtml) t.innerHTML = _tipHtml + (COPY_SRC.has(_tipSrc) ? '<p class="copied">クリックでコピー</p>' : ''); }, 900); } };
  try { if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } else fallbackCopy(text, done); } catch (e) { fallbackCopy(text, done); } return true; }
function fallbackCopy(text, done){ try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (e) { /* 無視 */ } }
function safeHover(fn){ try { fn(); } catch (e) { setHoverInfo(`<p class="k">ホバー処理でエラー: ${esc(String(e && e.message || e))}</p>`); console.error(e); } }
function hdrHoverSitesBase(x){ if (isSites()){ const k = siteAt(x); setHoverInfo(k != null ? siteInfo(k, null) : '', 'site'); emitHover(k); return; }
  const k = baseGroupAt(x); const ci = baseColAt(x); setHoverInfo(k != null ? baseGroupInfo(k, null, ci) : '', 'base'); if (!st.hover || st.hover.ci !== ci){ st.hover = ci != null ? { ci } : null; drawGrid(); } emitHover(k); }
function gridHoverSitesBase(e, rect){ const ri = Math.floor((e.clientY-rect.top)/RH); const px = e.clientX-rect.left + bsx(); const inRow = ri>=0 && ri<LY.rows.length;
  if (genesOn() && st.lane && inRow && (e.clientY-rect.top) - ri*RH >= RH - 4){ const ge = geneAtCols(LY.rows[ri], px); _hoverGene = ge ? ge[0] : null; if (ge){ setHoverInfo(geneInfoCols(ge, LY.rows[ri].hap), 'gene'); return; } }
  if (isBase()){ const ci = baseColAt(px); const k = baseGroupAt(px); const h0 = inRow ? {ri, ci} : null;
    if (!st.hover || !h0 || st.hover.ri!==h0.ri || st.hover.ci!==h0.ci){ st.hover = h0; drawGrid(); drawLabels(); }
    setHoverInfo(k!=null && inRow ? baseGroupInfo(k, ri, ci) : '', 'base'); emitHover(k); return; }
  const k = siteAt(px); const h0 = inRow ? {ri} : null;
  if (!st.hover || !h0 || st.hover.ri!==h0.ri){ st.hover = h0; drawGrid(); drawLabels(); }
  setHoverInfo(k!=null && inRow ? siteInfo(k, ri) : '', 'site'); emitHover(k); }
function blockInfo(rank, L){ const memtxt = (L.members ? `<p><span class="k">含む最細段のブロック (${membersOf(L,rank).length}):</span> ${membersOf(L,rank).map(m=>'#'+(m+1)).join(', ')}</p>` : '') + (()=>{ if (!st.genes.size) return ''; const gs = genesOf(L.blocks[rank]); return `<p><span class="k">遺伝子 ${gs.length} 個 (${geneDensity(rank).toFixed(1)}/Mb):</span> ${gs.slice(0,12).map(x=>esc(x.name)+(x.strand==='-'?'−':'')).join(', ')}${gs.length>12?' …':''}</p>`; })(); const B = L.blocks[rank]; const P = LY.prof && LY.prof.get(rank); return (`<p><span class="h">ブロック #${rank+1}</span><br>${esc(B.name)}<br><span class="k">錨列 ${B.c0+1}–${B.c1+1} · 原子区間 ${B.ncol} · 張り ${fmtbp(B.span)}<br>典型 ${fmtbp(B.tbp)} · 最長 ${fmtbp(B.bpmax)} · ${B.nhap} hap · ${B.rx0 != null ? `参照 ${fmtref(B.rx0, B.ref_contig)}–${fmtbp(B.rx1)} · 合意 ${fmtbp(B.x)}` : `参照 ${fmtref(B.x, B.ref_contig)}`}${B.atoms != null ? ` · 原子 ${B.atoms} 個` : ''}</span>${P?`<br><span class="k">状態: 主鎖 ${P.main} / 逆位 ${P.inv} / 別位置 ${P.disp} / 持たない ${P.abs}${P.divmed!=null?` · 変異密度の中央値 ${(100*P.divmed).toFixed(1)}%`:''}</span>`:''}</p>`) + memtxt; }
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
let _bDrag = null, _bDragged = false; let _hoverGene = null;   /* ホバー中の遺伝子（gid）。クリックで GFF の全項目 */   /* 塩基の段: 格子のドラッグで横に動かす。動かした直後の click（セルの選択）は抑止 */
grid.addEventListener('mousedown', e=>{ if (e.button !== 0 || !isBase() || !baseScrollMax()) return; _bDrag = { x: e.clientX, sx: st.bsx, moved: false }; _bDragged = false; });
window.addEventListener('mousemove', e=>{ if (!_bDrag) return; const dx = e.clientX - _bDrag.x; if (!_bDrag.moved && Math.abs(dx) > 3){ _bDrag.moved = true; cv.grid.style.cursor = 'grabbing'; } if (_bDrag.moved) baseSetScroll(_bDrag.sx - dx); });
window.addEventListener('mouseup', ()=>{ if (!_bDrag) return; const d = _bDrag; _bDrag = null; cv.grid.style.cursor = (isBase() && baseScrollMax()) ? 'grab' : ''; if (d.moved) _bDragged = true; });
const onWheelX = e=>{ if (!isBase()) return; if (e.ctrlKey || e.metaKey){ e.preventDefault(); const rect = cv.grid.getBoundingClientRect(); baseZoomStep(e.deltaY < 0 ? 1 : -1, e.clientX - rect.left); return; }   /* Ctrl+ホイール＝ズーム（カーソルの下の列を動かさない） */
  if (!baseScrollMax()) return; const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0); if (!dx) return; e.preventDefault(); baseSetScroll(st.bsx + dx); };   /* 横ホイール／Shift+ホイール。縦はそのまま行のスクロール */
$('gridwrap').addEventListener('wheel', onWheelX, { passive: false }); $('hdrwrap').addEventListener('wheel', onWheelX, { passive: false }); $('gtwrap').addEventListener('wheel', onWheelX, { passive: false });
$('bscroll').addEventListener('scroll', ()=>{ const el = $('bscroll'); if (Math.abs(el.scrollLeft - st.bsx) < 0.5) return; baseSetScroll(el.scrollLeft); });
grid.addEventListener('mousemove', e=>{ const rect = grid.getBoundingClientRect(); if (isBase() || isSites()){ safeHover(()=>gridHoverSitesBase(e, rect)); return; }
  if (st.mode==='own' && st.foldGap){ const px = e.clientX-rect.left, py = e.clientY-rect.top; const ri = Math.floor(py/RH); const r = LY.rows[ri]; if (r){ for (const p of r.items){ if (px < p.x || px > p.x + p.w) continue; const q = foldPartAt(p, px); if (q){ setHoverInfo(`<p class="k">畳んだ隙間: 錨の無い配列 ${q.bp.toLocaleString()} bp（島・私有配列。「長い隙間を畳む」を外すと実寸）· ${esc(ctPath(p.ct))}</p>`, 'fold'); return; } } } }
  if (genesOn()){ const px = e.clientX-rect.left, py = e.clientY-rect.top; const ri = Math.floor(py/RH); const r = LY.rows[ri]; const dy = py - ri*RH; if (r){
    if (st.jmark && dy <= 9 && r.jmarks){ const m = r.jmarks.find(m => Math.abs(m.x - px) <= 5); if (m){ _hoverMark = m; const html = juncInfo(m) + '<p class="copied">クリックで接合カード</p>'; setHoverInfo(html, 'junc'); if (!st.pinned) $('detailbody').innerHTML = html; return; } else _hoverMark = null; }
    if (st.lane && dy >= RH - 6){ const hg = geneAt(r, px, py); _hoverGene = hg ? hg.g[0] : null; const html = hg ? geneInfo(hg) : ''; setHoverInfo(html, 'gene'); if (hg && !st.pinned) $('detailbody').innerHTML = html; if (hg) return; } } } const h = hit(e.clientX-rect.left, e.clientY-rect.top); st.hover = h; st.hoverRank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); setHoverInfo(h ? itemHtml(h) : '', 'item'); drawGrid(); drawLabels(); if (!st.pinned) showItem(h);
  emitHover(h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null)); });
grid.addEventListener('mouseleave', ()=>{ st.hover=null; st.hoverRank=null; _hoverGene=null; drawGrid(); drawLabels(); emitHover(null); setHoverInfo(''); });
grid.addEventListener('dblclick', e=>{ const rect = grid.getBoundingClientRect(); if (isBase()){ baseZoomStep(2, e.clientX - rect.left); return; } const h = hit(e.clientX-rect.left, e.clientY-rect.top);
  const rank = h && h.p && h.p.o.kind<4 ? h.p.o.rank : (h && h.b ? h.b.rank : null); if (rank==null) return;
  st.sel = rank; st.pinned = true; drawAll(); emitSel(); drillInto(rank); });
grid.addEventListener('click', e=>{ if (_bDragged){ _bDragged = false; return; } if (e.detail && e.detail > 1) return; const rect = grid.getBoundingClientRect();
  if (_tipSrc === 'junc' && _hoverMark){ openJunction(_hoverMark.j[0]); return; }   // 三角 → 接合カード
  if (_tipSrc === 'gene' && _hoverGene != null && cb && cb.onFeature){ showFeature({ gid: _hoverGene }); return; }   // 遺伝子 → GFF の全項目（9 列・属性・親・子）
  if (COPY_SRC.has(_tipSrc) && _tipHtml){ copyHover(); if (_tipSrc !== 'site' && _tipSrc !== 'base') return; }   // レーン・畳み: コピーだけ。サイト／塩基のセルはコピーして選択も
  const h = hit(e.clientX-rect.left, e.clientY-rect.top);
  if (h && h.p && h.p.o.kind<4){ st.sel = (st.sel===h.p.o.rank) ? null : h.p.o.rank; st.pinned = st.sel!=null; if (st.sel!=null) showItem(h); drawAll(); emitSel(); }
  else if (h && h.b){ st.sel = (st.sel===h.b.rank) ? null : h.b.rank; st.pinned = st.sel!=null; if (st.sel!=null) showItem(h); drawAll(); emitSel(); }   // 束もブロックの選択として扱う
  else if (h && h.m){ st.pinned = true; showItem(h); }
  else { st.pinned = false; st.sel = null; drawAll(); emitSel(); } });
// 列見出しをドラッグして合意座標の任意区間を選び、その区間の窓へ（ブロック境界に縛られない「範囲で降りる」）。
// 各行のトークン範囲は標本錨（第一・第二）のうち区間内にあるものの最小/最大トークンで近似する
function pxToCons(px){ if (isBase()) return px + bsx(); if (isSites()){ const S = sitesOf(); if (!S || !S.nsites) return null; const k = Math.max(0, Math.min(S.nsites-1, Math.floor((px - SITES_X0) / LY.siteW))); return S.sites[k].x + (px - (SITES_X0 + k*LY.siteW)) / LY.siteW * Math.max(1, S.sites[k].bp); } for (const c of LY.cols){ if (c.type==='block' && px>=c.x && px<=c.x+c.w){ const B = level().blocks[c.rank]; return B.x + (px-c.x)/Math.max(1,c.w)*B.span; } } let best=null; for (const c of LY.cols){ if (c.type!=='block') continue; const d = px < c.x ? c.x-px : px-(c.x+c.w); if (best==null || d<best[0]) best=[d,c]; } if (!best) return null; const c=best[1], B=level().blocks[c.rank]; return px < c.x ? B.x : B.x + B.span; }
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
function drillRange(xa, xb){ if (xb <= xa) return; if (isBase()){ const k0 = baseItemAt(xa), k1 = baseItemAt(xb); const toCol = (k, end) => { if (k == null) return null; const it = LY.bitems[k]; return it.kind === 'col' ? it.ci : (end ? it.ci1 : it.ci0); }; const M = baseOf(); let i0 = toCol(k0, false), i1 = toCol(k1, true); if (i0 == null) i0 = xa < LY.bxs[0] ? 0 : M.cols.length - 1; if (i1 == null) i1 = xb < LY.bxs[0] ? 0 : M.cols.length - 1; if (i1 < i0){ const t = i0; i0 = i1; i1 = t; } st.rangeSel = null; if (i1 - i0 < 1) { drawHeader(); return; } if (M.indexBacked){ const tc0 = M.cols[i0].tc0, tc1 = M.cols[i1].tc1; if (tc1 - tc0 + 1 <= BASE_MAX_LEAVES){ indexToBases(tc0, tc1); return; } } baseZoomToCols(i0, i1); return; } if (isSites()){ sitesRange(xa, xb); return; }
  if (TREE){ const rg = xToRange(xa, xb); if (!rg){ toast('この区間にブロックがありません'); st.rangeSel = null; drawHeader(); return; } st.rangeSel = null; drawHeader(); zoomTo(rg, fmtRange(xa, xb)); return; }
  if (st.drilling) return; const w = win(); const L0 = w.levels[0];
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
cv.gtrack.addEventListener('mousemove', e=>{ const rect = cv.gtrack.getBoundingClientRect(); const x = e.clientX - rect.left + bsx(); const hit = _gtHits.find(hh => x >= hh.x0 - 1 && x <= hh.x1 + 1); const w = win(); if (hit){ setHoverInfo(orthInfo(hit.o, (w._orth && w._orth.H) || 1), 'orth'); cv.gtrack.style.cursor = 'pointer'; } else { if (_tipSrc === 'orth') setHoverInfo(''); cv.gtrack.style.cursor = ''; } });
cv.gtrack.addEventListener('mouseleave', ()=>{ if (_tipSrc === 'orth') setHoverInfo(''); });
cv.gtrack.addEventListener('click', e=>{ const rect = cv.gtrack.getBoundingClientRect(); const x = e.clientX - rect.left + bsx(); const hit = _gtHits.find(hh => x >= hh.x0 - 1 && x <= hh.x1 + 1); if (!hit){ if (st.selOg != null){ st.selOg = null; drawGeneTrack(); drawGrid(); } return; } st.selOg = (st.selOg === hit.o.og) ? null : hit.o.og; drawGeneTrack(); drawGrid();
  if (st.selOg != null){ const w = win(); const rows = w._orthRows; let have = 0, pseudo = 0, inv = 0; const absent = []; if (rows) for (const r of LY.rows){ const row = rows.get(r.hap); const s = row ? row.st.find(z => z[0] === hit.o.og) : null; if (s){ have++; if (s[1] & 2) pseudo++; if ((s[1] & 4) && Math.max(hit.o.plus, hit.o.n - hit.o.plus) >= OG_CLEAR * hit.o.n) inv++; } else if (rowCovers(r, hit.o)) absent.push(r.hap); }
    _ogCache.set(hit.o.og, hit.o); st.pinned = true; setDetail(orthInfo(hit.o, (w._orth && w._orth.H) || 1) + (rows ? `<p><span class="k">この窓の行: 持つ ${have}（擬似 ${pseudo}・合意と逆向き ${inv}）· 覆っているのに無い ${absent.length}${absent.length ? ': ' + esc(absent.slice(0, 20).join(', ')) + (absent.length > 20 ? ' …' : '') : ''}</span></p>` : '') + ogButtons(hit.o)); } });
cv.gtrack.addEventListener('dblclick', e=>{ const rect = cv.gtrack.getBoundingClientRect(); const x = e.clientX - rect.left + bsx(); const hit = _gtHits.find(hh => x >= hh.x0 - 1 && x <= hh.x1 + 1); if (hit) openOgWindow(hit.o); });
cv.hdr.addEventListener('click', e=>{ if (_hdrDragged){ _hdrDragged = false; return; } if (e.detail && e.detail > 1) return; const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (isSites()){ const k = siteAt(x); st.sel = (k!=null && st.sel===k) ? null : k; st.pinned = st.sel!=null; if (st.sel!=null) setDetail(siteInfo(st.sel, null)); drawHeader(); drawGrid(); emitSel(); return; } if (isBase()){ const k = baseGroupAt(x + bsx()); st.sel = (k!=null && st.sel===k) ? null : k; st.pinned = st.sel!=null; if (st.sel!=null) setDetail(baseGroupInfo(st.sel, null, null)); drawHeader(); drawGrid(); emitSel(); return; } for (const c of LY.cols){ if (c.type==='block' && x>=c.x && x<=c.x+c.w){ st.sel = (st.sel===c.rank)?null:c.rank; st.pinned = st.sel!=null; if (st.sel!=null) showBlock(c.rank); drawAll(); emitSel(); return; } } });
cv.hdr.addEventListener('mousemove', e=>{ const rect = cv.hdr.getBoundingClientRect(); const x = e.clientX-rect.left; if (isSites() || isBase()){ safeHover(()=>hdrHoverSitesBase(x + bsx())); return; } for (const c of LY.cols){ if (x>=c.x && x<=c.x+c.w){ if (!st.pinned) showBlock(c.rank); setHoverInfo(blockInfo(c.rank, level()), 'block'); emitHover(c.rank); if (st.hoverRank!==c.rank){ st.hoverRank=c.rank; drawGrid(); } return; } } emitHover(null); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
cv.hdr.addEventListener('mouseleave', ()=>{ emitHover(null); setHoverInfo(''); if (st.hoverRank!=null){ st.hoverRank=null; drawGrid(); } });
function enterWindow(ch){ st.win = ch; st.bsx = WINS[ch]._bsx || 0; st.bz = WINS[ch]._bz == null ? null : WINS[ch]._bz; st.li = Math.max(0, WINS[ch].levels.length-1); st.sel=null; st.origin=null; st.pinned=false; st.filter=null; st.filterPath=[]; drawAll(); emitSel(); }
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
  if (TREE){ const B = level().blocks[rank]; if (B && B.a0 != null){ zoomTo({ atoms: [B.a0, B.a1] }, '#' + (rank + 1)); return; } }   /* 木: ブロック＝原子の範囲として降りる（1 原子なら列の決定表へ） */
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
$('beff').addEventListener('change', e=>{ st.beff = e.target.checked; drawGrid(); drawLegend(); });
$('bvar').addEventListener('change', e=>{ st.bvar = e.target.checked; drawAll(); });
$('ctgpack').addEventListener('change', e=>{ st.ctgPack = e.target.checked ? 'on' : 'off'; drawAll(); });
$('zout').addEventListener('click', ()=>baseZoomStep(-1)); $('zin').addEventListener('click', ()=>baseZoomStep(1)); $('zfit').addEventListener('click', ()=>{ st.bz = null; const w = win(); if (w) w._bz = null; st.bsx = 0; drawAll(); }); $('zbase').addEventListener('click', ()=>{ if (indexToBases()) return; setBaseZoom(BASE_LETTER_Z); });
function setBaseCmp(m){ st.baseCmp = m; { const w = win(); if (w) w._beff = null; }   /* 比較の基準が変わると効果も変わる */ $('cmp_ref').setAttribute('aria-pressed', m==='ref' ? 'true' : 'false'); $('cmp_major').setAttribute('aria-pressed', m==='major' ? 'true' : 'false'); drawHeader(); drawGrid(); drawChips(); }
$('cmp_ref').addEventListener('click', ()=>setBaseCmp('ref')); $('cmp_major').addEventListener('click', ()=>setBaseCmp('major'));
function setRowMode(m){ st.rowMode = m; for (const k of ['auto','std','dense']) $('rh_'+k).setAttribute('aria-pressed', k===m ? 'true' : 'false'); try { localStorage.setItem('bkmsa_rowmode', m); } catch (e) {} drawAll(); }
for (const k of ['auto','std','dense']) $('rh_'+k).addEventListener('click', ()=>setRowMode(k));
try { const m0 = localStorage.getItem('bkmsa_rowmode'); if (m0 === 'std' || m0 === 'dense'){ st.rowMode = m0; for (const k of ['auto','std','dense']) $('rh_'+k).setAttribute('aria-pressed', k===m0 ? 'true' : 'false'); } } catch (e) {}
try { if (localStorage.getItem('bkmsa_compact') === '1'){ root.classList.add('compact'); $('compact').setAttribute('aria-pressed', 'true'); $('compact').textContent = '設定 ▾'; } } catch (e) {}
function setMode(m){ st.mode=m; $('m_msa').setAttribute('aria-pressed', m==='msa'); $('m_own').setAttribute('aria-pressed', m==='own'); drawAll(); }
$('m_msa').addEventListener('click', ()=>setMode('msa')); $('m_own').addEventListener('click', ()=>setMode('own'));
function setOrder(o){ st.order=o; $('o_tree').setAttribute('aria-pressed', o==='tree'); $('o_name').setAttribute('aria-pressed', o==='name'); drawAll(); }
$('o_tree').addEventListener('click', ()=>setOrder('tree')); $('o_name').addEventListener('click', ()=>setOrder('name'));
$('t_global').addEventListener('click', ()=>setTreeMode('global')); $('t_range').addEventListener('click', ()=>setTreeMode('range'));
let _cutRaf = null; $('cut').addEventListener('input', e => { const v = Number(e.target.value); st.treeCut = v >= 100 ? null : Math.max(0, 1 - v / 100); st.treeOpen.clear(); if (_cutRaf) cancelAnimationFrame(_cutRaf); _cutRaf = requestAnimationFrame(() => { _cutRaf = null; drawAll(); }); });
 $('bund').addEventListener('change', e=>{ st.bundle=e.target.checked; drawAll(); });
$('sync').addEventListener('change', e=>{ st.sync=e.target.checked; _lastViewKey=''; emitView(); });
$('gfilter').addEventListener('change', e=>{ st.gfilter=e.target.checked; _lastViewKey=''; emitView(); });
$('lane').addEventListener('change', e=>{ st.lane=e.target.checked; drawGrid(); drawLegend(); });
{ const root = $('tip') && $('tip').parentElement; if (root){ root.addEventListener('mousemove', e => { const r = root.getBoundingClientRect(); _tipPos = { x: e.clientX - r.left, y: e.clientY - r.top }; placeTip(); }); root.addEventListener('mouseleave', () => { const t = $('tip'); if (t) t.style.display = 'none'; }); } }
$('foldgap').addEventListener('change', e=>{ st.foldGap=e.target.checked; drawAll(); });
$('junclist').addEventListener('click', ()=>{ openJunctionList(); });
$('gfind').addEventListener('keydown', e=>{ if (e.key === 'Enter'){ findGene(String(e.target.value || '').trim()); } });
$('detailbody').addEventListener('click', e=>{ const t = e.target; if (!t || !t.getAttribute) return; const act = t.getAttribute('data-act'); const tr = t.closest ? t.closest('tr[data-jid]') : null;
  if (act === 'goto'){ gotoAtom(Number(t.getAttribute('data-atom'))); return; }
  if (act === 'jbase'){ openJunctionBase(Number(t.getAttribute('data-jid'))); return; }
  if (act === 'jgenes'){ openJunctionGenes(Number(t.getAttribute('data-jid'))); return; }
  if (act === 'ogfate'){ openOgFate(Number(t.getAttribute('data-og'))); return; }
  if (act === 'fopen'){ showFeature({ fid: Number(t.getAttribute('data-fid')) }); return; }
  if (act === 'fcopy'){ const r = $('detailbody')._feature; if (r && navigator.clipboard) navigator.clipboard.writeText(r.feature.line).then(()=>{ t.textContent = 'コピーしました'; setTimeout(()=>{ t.textContent = 'GFF の行をコピー'; }, 1200); }); return; }
  if (act === 'ogopen'){ const o = _ogCache.get(Number(t.getAttribute('data-og'))); if (o) openOgWindow(o); return; }
  if (act === 'ogsel'){ const o = _ogCache.get(Number(t.getAttribute('data-og'))); if (o){ st.selOg = o.og; openOgWindow(o); } return; }
  if (act === 'ogtsv'){ const r = $('detailbody')._fate; if (r) copyPlain(ogFateTsv(r), 'TSV をコピーしました'); return; }
  if (act === 'jcard'){ openJunction(Number(t.getAttribute('data-jid'))); return; }
  if (act === 'jgtsv'){ const r = $('detailbody')._jg; if (r) copyPlain(junctionGenesTsv(r), 'TSV をコピーしました'); return; }
  if (act === 'copy'){ const c = $('detailbody')._card; if (c){ const d = document.createElement('div'); d.innerHTML = c.html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li)>/gi, '\n'); copyPlain((d.textContent || '').trim(), 'カードをコピーしました'); } return; }
  if (act === 'tsv'){ const rows = $('detailbody')._list || []; copyPlain(junctionTsv(rows), `TSV ${rows.length} 行をコピーしました`); return; }
  if (tr){ openJunction(Number(tr.getAttribute('data-jid'))); } });
$('detailbody').addEventListener('mousemove', e=>{ const el = $('jginfo'); if (!el) return; const t = e.target; const g = t && t.closest ? t.closest('[data-ginfo]') : null; el.textContent = g ? g.getAttribute('data-ginfo') : '矢印にホバーで遺伝子の詳細'; });
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
const onKey = e=>{ if (e.key === 'Escape' && st.drilling){ endDrill(); drawAll(); toast('中断しました（応答が来ても捨てます）'); return; } if (e.key === 'Escape' && st.pinned){ st.pinned = false; st.sel = null; drawHeader(); drawGrid(); emitSel(); setDetail('<p class="k">固定を解除しました。</p>'); return; } if (e.key==='Escape' && root.isConnected){ st.pinned=false; st.sel=null; drawAll(); emitSel(); } };
window.addEventListener('keydown', onKey);
const ro = new ResizeObserver(()=>{ if (root.isConnected && $('gridwrap').clientWidth > 0) drawAll(); }); ro.observe(root);
$('body').addEventListener('scroll', ()=>{ $('hdrwrap').scrollLeft = $('body').scrollLeft; $('gtwrap').scrollLeft = $('body').scrollLeft; });   // はみ出し分の横スクロールに列見出しを追従
// (sub) (DATA.meta.circular?'環状 · ':'') + `窓 ${WINS.length} 個 · ${DATA.meta.bpt} bp/token · 予算 ${DATA.meta.budget}s · 順序＝` + (DATA.meta.order.kind==='ref'?'参照 ':'典型パス ') + DATA.meta.order.path.split('#')[0];
drawAll();


return {
  isTree(){ return TREE; },
  setGraphAtoms(atoms){ const a = Array.isArray(atoms) ? atoms.slice(0, 4000).map(e => Array.isArray(e) ? [e[0], Math.max(0, +e[1] || 0), e[2] != null ? +e[2] : -1, e[3] != null ? +e[3] : -1] : [e, 1, -1, -1]) : null; const key = a ? a.map(e => e.join(':')).join(',') : ''; if (key === (st._gaKey || '')) return; st._gaKey = key; st.graphAtoms = a; st.graphRuns = graphRunsOf(a); drawHeader(); drawMini(); updateButtons(); offerGraphRange(); },
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
  _treeFromDist(n, dist, names, exactOK){ return treeFromDist(n, dist, names, exactOK); },   // 試験用（二段の木を合成データで）
  _drillRange(xa, xb){ drillRange(xa, xb); },   // 試験用（範囲選択と同じ経路）
  _zoomTo(rg, label){ zoomTo(rg, label); },   // 試験用（木の範囲で）
  _showFeature(q){ showFeature(q); },   // 試験用（GFF の全項目）
  _effects(){ return isBase() ? (ensureEffects() || null) : null; },   // 試験用（変異の効果）
  _fateEffects(og){ return cb.onOrthGroup(og).then(r => fateEffects(r).then(fe => ({ group: r.group, L: fe.L, lof: fe.L ? lofCount(fe.L) : 0 }))); },   // 試験用（運命の表の整列からの効果）
  _base(){ return baseOf(); }, _gcols(){ const w = win(); return w ? w._gcols : null; }, _colIndex(node, off){ const M = baseOf(); return M ? baseColIndex(M, node, off) : -1; },   // 試験用（塩基の窓の中身）
  _xToRange(xa, xb){ return xToRange(xa, xb); },
  _state(){ return { win: st.win, li: st.li, drilling: st.drilling, busy: st.busy, mode: level() ? (level().mode || 'blocks') : null, label: win() ? win().label : null, nwins: WINS.length, bsx: st.bsx, bfullW: LY.bfullW || 0, bcw: LY.bcw || 0, bz: LY.bz || 0, bzFit: !!LY.bzFit, bvOnly: !!LY.bvOnly, nitems: LY.bitems ? LY.bitems.length : 0, idx: !!(baseOf() && baseOf().indexBacked) }; },
  _baseZoom(z){ if (z === 'fit'){ st.bz = null; const w = win(); if (w) w._bz = null; drawAll(); } else if (z === 'step+'){ baseZoomStep(1); } else if (z === 'step-'){ baseZoomStep(-1); } else setBaseZoom(Number(z)); },   // 試験用（倍率）   // 試験用（bsx/bfullW/bcw は塩基の段の横スクロール）
};

}
