// 通過（traversal）パネルの描画（vanilla、canvas）。試作ページ trav.html と主画面の Traversals パネル（components/TravPanel.tsx）の両方がこれを使う。
// 元は試作ページ `<db>.trav`（functions/anchor2/build/synteny2_build.py）を /api/trav/* で読む。設計: plans/anchor2-traversals.md
// 上段: 表示範囲を持続度の高い境界で K 個のブロックに切る（予算切り。原子をそのまま出すと全景で細かすぎる）。横軸は bp に比例（原子の bp を累積）。
// 行: ハプロタイプ ＞ コンティグ ＞ 通過をブロックごとの片に割り、ブロックの色で塗る（同じ色＝同じブロック＝株間の対応）。
//   合意座標モード: 片はその座標の位置。逆位（コンティグの主な向きと逆）は下段に下げて紫の枠と左向きの三角、転座（コンティグ内の順が合意と違う）は下段に灰の枠。
//   各行の並びモード: 行ごとにコンティグを bp の順に詰める。1 コンティグの株（環状）は、主な向きが逆なら鏡にし、座標の最小の通過が左に来るよう回す。
//   連結線は bp で等間隔に標本し、隣の行の同じ場所を結ぶ（密度が一定）。
type Atom = { id: number; x0: number; x1: number; bp: number; nhap: number }
type Bound = { x: number; support: number; persistence: number }
type Hap = { hid: number; hap: string; ncontig: number; nexcl: number; bp: number }
type Trav = { id: number; pid: number; hid: number; i0: number; i1: number; x0: number; x1: number; dir: number; copy: number; nanch: number; bp: number; bp0?: number; rep?: boolean; trim?: [number, number]; ox0?: number; ox1?: number; k?: number; members?: Trav[] }   // k, members = 同じ場所を繰り返し通る通過をまとめた片
type Copy = { id: number; pid: number; hid: number; x0: number; x1: number; ia0: number; ia1: number; ib0: number; ib1: number; bpa: number; bpb: number }
type Rep = { id: number; pid: number; hid: number; i0: number; i1: number; bp: number; x0: number; x1: number }
type AtomStat = { id: number; nhap: number; nhap2: number; tangled?: boolean; counts: Record<string, number> }
type Root = { meta: any; H: number; R: number; total_bp: number; haps: Hap[]; atoms: Atom[]; bounds: Bound[] }
type Block = { id: number; x0: number; x1: number; bp: number; a0: number; a1: number; nhap: number; nhap2: number; tangled: boolean }
// 錨の列（ブロックと塩基の間の段）: /api/trav/cols。列＝表示範囲を画面幅で等分した座標区間。行＝通過。pres 錨の有無（0–255）、cls アレル番号（0 多数派、255 掛からない）、ins 挿入 bp
type ColRow = { id: number; pid: number; hid: number; dir: number; copy: number; tw0: number; tw1: number; pres: Uint8Array; cls: Uint8Array; ins: Uint16Array; frq: Uint8Array; bpc: Uint32Array }   // bpc = 列ごとのこの行のトークンの bp（各行の並びの幅）
type Cols = { x0: number; x1: number; ncol: number; ntok: number; nanch: Uint16Array; ncls: Uint8Array; nrow: Uint16Array; major: Uint16Array; rows: ColRow[]; byId: Map<number, ColRow> }
const CLS_COL = ['#c9ced2', '#e67e22', '#2980b9', '#27ae60', '#8e44ad', '#c0392b', '#16a085', '#d35400', '#7f8c8d']   // アレル番号 → 色（0 多数派は灰）
// 色相 → 24 bit の整数（グラフのノード色）
function hslToInt(h: number, sPct: number, lPct: number): number { const sat = sPct / 100, l = lPct / 100; const c = (1 - Math.abs(2 * l - 1)) * sat; const hp = (h % 360) / 60; const x = c * (1 - Math.abs(hp % 2 - 1)); let r = 0, g2 = 0, b = 0; if (hp < 1) { r = c; g2 = x } else if (hp < 2) { r = x; g2 = c } else if (hp < 3) { g2 = c; b = x } else if (hp < 4) { g2 = x; b = c } else if (hp < 5) { r = x; b = c } else { r = c; b = x } const m = l - c / 2; const R = Math.round((r + m) * 255), G = Math.round((g2 + m) * 255), B = Math.round((b + m) * 255); return (R << 16) | (G << 8) | B }
const u8 = (b: string) => Uint8Array.from(atob(b), ch => ch.charCodeAt(0)); const u16 = (b: string) => { const a = u8(b); return new Uint16Array(a.buffer, a.byteOffset, a.byteLength >> 1) }; const u32 = (b: string) => { const a = u8(b); return new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2) }

import { fetchBubbleMsaRanges, BubbleMsaResp, MsaCol, MsaRow } from '../api/client'
import { matchHapToKey } from './blockMsaRender'
type Gene = { gid: number; pid: number; hid: number; tr: number; x0: number; x1: number; s0: number; e0: number; start: number; end: number; strand: string; fwd: boolean; type: string; name: string; locus: string; product: string; pseudo: boolean; anchored: boolean; og: number; ch?: [string, number, number][]; nodes?: { names: string[]; cds: { names: string[]; phase: number; strand: string; so: number; eo: number; first: boolean }[]; exon: string[][]; t0: number; t1: number } }   // ch = 子（'cds'|'exon'|'utr', x0, x1）、nodes = 塩基の段用（ノード名）
type Pres = { cover: number; n0: number; n1: number; n2: number; part: number; absent: number[]; multi: number[]; partial: number[] }
type OGroup = { para?: string[] | null; og: number; x0: number; x1: number; n: number; nhap: number; name: string; fwd: number; npseudo: number; kind: string; pres?: Pres }   // 見出しの遺伝子トラック（オルソログ群＝錨の共有で結んだ遺伝子）
export interface TravCallbacks {
  onBaseMsa?: (ranges: number[][], label: string) => void   // 塩基へ: [distill のパス番号, s0, e0, コンティグの主な向き] の列
  onVisible?: (v: { names: string[]; sync: boolean } | null) => void          // 表示範囲の錨のノード名（グラフを寄せる・強調）
  onSelectHap?: (hap: string) => void                                          // 行ラベルのクリック
  onFilter?: (sel: { names: string[] } | null) => void                         // グラフをこの範囲に絞る（葉の名前の集合）／解除
  onGraphRange?: () => void                                                    // 「グラフの範囲を開く」: 主画面が見えているノード名を openNames に渡す
  onHoverNodes?: (names: string[] | null) => void                              // 塩基の段でホバーしたノード（グラフで強調）
  onRange?: (v: { names: string[]; colors: number[] | null; fit: boolean; hide: boolean; direct?: boolean; fitNames?: string[] } | null) => void   // 表示範囲のノードと色（ブロックの色相）。hide＝範囲外を隠す（集合は葉の名前）。direct＝名前はグラフが描いている層のもの（そのまま薄灰の判定に使う）。fitNames＝寄せる先（葉の名前）
  getVisibleNames?: () => string[]                                             // 主画面のグラフに見えているノード名（広い範囲での塗り分けに使う）
}
export interface TravOpts { db: string; params?: URLSearchParams; page?: boolean }   // page: 試作ページ（window のエラー表示、説明を開いたまま、グラフ連動なし）
export interface TravHandle { setDb(db: string): void; destroy(): void; locateNodes(names: string[]): void; openNames(names: string[]): void; setHapMarks(m: Map<string, string>): void; resetLinks(): void; graphMoved(): void; getState(): any; setState(st: any): void }
const BODY = "<div class=\"tv-bar\">\n  <label>錨の床 <input id=\"tv_minanch\" type=\"number\" value=\"50\" min=\"0\" step=\"10\"></label>\n  <label>ブロック <input id=\"tv_nblk\" type=\"number\" value=\"30\" min=\"1\" max=\"500\" step=\"5\"></label>\n  <button id=\"tv_all\">全体</button><button id=\"tv_back\">戻る</button>\n  <label>並び <select id=\"tv_mode\"><option value=\"coord\">合意座標</option><option value=\"rows\">各行の並び</option></select></label>\n  <label title=\"ブロックの段と塩基の間の段。錨の列＝表示範囲を画面の列に等分し、行ごとに錨の有無（濃さ）と錨の間のアレル（色。灰＝多数派、色＝少数派のアレル番号）と挿入（上辺の黒）を出す。自動＝ブロックが 3 個以下か 200 kb 以下で切り替え\">段 <select id=\"tv_rung\"><option value=\"auto\">自動</option><option value=\"blocks\">ブロック</option><option value=\"cols\">錨の列</option></select></label>\n  <button id=\"tv_base\" disabled title=\"錨の列の段で使える\">塩基へ ↓</button><button id=\"tv_graphrange\" title=\"グラフで今見えているノードの座標の範囲（10〜90 パーセンタイル）にパネルを移す\">グラフの範囲を開く</button>\n  <span id=\"tv_basegrp\" style=\"display:none\"><button id=\"tv_bclose\" title=\"塩基の段を閉じて、ブロック／錨の列に戻る\">↑ 戻る</button> <select id=\"tv_bexp\" title=\"この塩基の段の配列をテキスト（FASTA）で保存する\"><option value=\"\">書き出し…</option><option value=\"aln\">整列（表示のとおり。逆位は多数の向きの文字）</option><option value=\"alnt\">整列（各株の実際の向き。逆位の区間は株の向きの文字）</option><option value=\"seq\">各株の配列（整列なし・コンティグの向き）</option></select><select id=\"tv_bexpw\" title=\"書き出す行\"><option value=\"all\">全行</option><option value=\"shown\">表示中の行（木のまとめ・並べ替えのとおり）</option><option value=\"marked\">主画面で選んだ株</option></select> <label title=\"窓のノードを通るリード（サイドカー <db>.reads）を株の行の下に並べる。サンプルごとに上限の本数まで（窓のノードを多く通るものから）\"><input id=\"tv_breads\" type=\"checkbox\" checked> リード</label><select id=\"tv_bmode\" title=\"リードの表示。展開＝1 本 1 行（名前つき）、詰める＝サンプルごとに重ならないリードを同じ行に左から詰める（ショートリード・リード長より広い窓）、要約＝サンプルごとに深さ（灰の棒）と基準と違う塩基の割合（色）だけ。自動＝詰めて行が 3 割以上減るなら詰める、行が 120 を超えるなら要約\"><option value=\"auto\">自動</option><option value=\"expand\">展開</option><option value=\"pack\">詰める</option><option value=\"cov\">要約</option></select> <label title=\"参照（GRCh38）座標の注釈（サイドカー <db>.ann）: RepeatMasker の反復と、GIAB ベンチマークの変異（HG002/3/4）を見出しの下に並べる。参照のノードの列にだけ付く\"><input id=\"tv_bann\" type=\"checkbox\" checked> 反復・GIAB</label> <input id=\"tv_breadmax\" type=\"number\" value=\"40\" min=\"5\" max=\"300\" step=\"5\" style=\"width:46px\" title=\"サンプルあたりのリードの本数\"> <span style=\"color:#555\">倍率</span><button id=\"tv_zout\" title=\"縮小（Ctrl+ホイール下）\">−</button><button id=\"tv_zin\" title=\"拡大（Ctrl+ホイール上。格子のダブルクリックは 2 段）\">＋</button><button id=\"tv_zfit\" title=\"窓全体を画面幅に（俯瞰）\">全体</button><button id=\"tv_zbase\" title=\"文字が読める 7 px/塩基まで一気に拡大\">塩基</button><span id=\"tv_ztxt\" style=\"color:#666\"></span> <label title=\"比較の基準。多数派＝列ごとの最頻の塩基、参照＝参照パスの行（無ければ先頭の行）。列見出しの下段に出る\">基準 <select id=\"tv_cmp\"><option value=\"major\">多数派</option><option value=\"ref\">参照</option></select></label><label title=\"基準と同じ塩基を · で省き、違う塩基だけ色で出す\"><input id=\"tv_bdiff\" type=\"checkbox\" checked> 一致を省く</label><label title=\"行で塩基か有無が違う群（ノード）だけを並べる。群が画面幅より多いときは自動\"><input id=\"tv_bvar\" type=\"checkbox\"> 変異のある群だけ</label><label title=\"変異が無く全行が持つノード（群）は、拡大しても幅 28 px の区画に畳む（長さは列見出しの下段に）。全株共通の大きなノードの塩基を全部出しても情報が無いため\"><input id=\"tv_bfold\" type=\"checkbox\" checked> 変異の無い群を畳む</label><label title=\"CDS の中の塩基の違いを、座位ごとのモデル（最も多くの株が同じ区間に持つ CDS の注釈）の読み枠で全行のコドンに読み、基準（多数派か参照）のコドンと比べる。セルの上辺の色: 灰 同義・橙 非同義・赤 終止獲得／終止喪失／開始喪失／フレームシフト・黄 インフレーム indel・薄い赤 読み枠がずれた区間。注釈の無い行もモデルの枠で読む。ホバーで p.Ala123Thr の形と遺伝子ごとの要約（★機能喪失）\"><input id=\"tv_beff\" type=\"checkbox\" checked> 変異の効果</label></span>\n  <label><input id=\"tv_showlines\" type=\"checkbox\" checked> 連結線</label>\n  <label>並べ替え <select id=\"tv_order\"><option value=\"tree\">表示範囲の木</option><option value=\"name\">名前</option></select></label>\n  <span id=\"tv_cutwrap\" title=\"系統樹の高さの閾値。左へ動かすほど多くの枝をまとめる（右端で解除）。まとめた枝は代表 1 株（群の中心＝他との距離の和が最小）だけを出し、行頭に +n、木には三角\"><input type=\"range\" id=\"tv_cut\" min=\"0\" max=\"100\" value=\"100\" style=\"width:90px;vertical-align:middle\"><small id=\"tv_cuttxt\" style=\"color:#666\"></small></span>\n  <label title=\"各行の片の下に、その株の遺伝子（.genes サイドカー）を置く。緑＝合意の向きに +、橙＝−、灰＝擬似。ホバーで名前・産物\"><input id=\"tv_genes\" type=\"checkbox\" checked> 遺伝子</label>\n  <label title=\"グラフに見えているノードを座標（葉＝錨、錨でない葉＝直前の錨、スーパーノード＝子孫の多数派）で引き、表示範囲の中をブロックの色、外を薄灰にする。範囲を動かしたときはグラフをその範囲に寄せる（開いた直後は寄せない）。灰のまま残るのは範囲外と座標の無いノード\"><input id=\"tv_sync\" type=\"checkbox\"> グラフ連動</label>\n  <label title=\"グラフに、この表示範囲に属するノード（錨と、錨の間の錨でないノード）だけを描く（薄灰でなく非表示）。範囲外へ繋がる辺とパスリボンは切れ端になる。既定で入っている（範囲が全体のときは絞らない）。ノードが予算を超えると粗い層で描く\"><input id=\"tv_gfilter\" type=\"checkbox\" checked> グラフを絞る</label>\n  <label><input id=\"tv_showcopies\" type=\"checkbox\" checked> コピー</label>\n  <label><input id=\"tv_showreps\" type=\"checkbox\" checked> 反復</label>\n  <label><input id=\"tv_showbounds\" type=\"checkbox\" checked> 境界</label>\n  <span style=\"position:relative\"><input id=\"tv_gfind\" type=\"search\" placeholder=\"遺伝子名…\" title=\"遺伝子名・locus の前方一致、産物名の部分一致。Enter で検索。見つかった遺伝子（株ごと）の一覧から選ぶとその範囲へ移る（1 件なら直接）\" style=\"width:110px;font:11px monospace\"><div id=\"tv_gres\"></div></span>\n  <button id=\"tv_gpres\" title=\"表示範囲で株によって有無・コピー数が違う遺伝子群の一覧\">遺伝子の有無</button>\n  <button id=\"tv_lgd\" title=\"凡例・説明の表示／非表示\">説明</button>\n  <span id=\"tv_busy\" style=\"color:#c0392b;font-weight:600;display:none\">計算中…</span>\n  <span id=\"tv_info\"></span>\n</div>\n<div id=\"tv_gptab\" style=\"display:none;max-height:240px;overflow:auto;font:12px system-ui;border:1px solid #ddd;margin:4px 0;padding:4px\"></div>\n<div id=\"tv_legend\" class=\"tv-legend\"><b>上段</b> 四角＝ブロック（表示範囲を持続度の高い境界で「ブロック」個に切った区間。横幅は bp に比例、高さ＝通るハプロタイプの割合、色は番号）／赤い帯＝反復の裏付けつきで 2 回以上通る株がある／灰色の覆いと「?」＝もつれ（順序が線形にならない領域、×n は数えない）／縦線＝境界（赤 支持 ≥50%・灰 ≥2 株・薄灰 1 株。高さ＝持続度＝その境界を潰したときの原子の幅。大きいほど大きなブロックを分ける境界）／ダブルクリックでそのブロックに寄る\n  <b>行</b> 色＝ブロック（同じ色＝同じブロック。株間の対応）／三角＝向き／<span style=\"color:#8e44ad\">紫の枠と左向き三角、下段</span>＝コンティグの主な向きと逆（逆位）／<span style=\"color:#333\">黒の破線</span>＝転座（コンティグ上の前後の通過から座標が 2 万錨以上離れている）／各行の並び: 1 コンティグの株は主な向きで鏡にし座標最小の通過を左に回す（環状）／連結線＝bp で等間隔に標本し、隣の行の同じ場所を結ぶ（交差＝逆位・転座、無い＝持たない、二又＝重複）。範囲の拡大は上段のドラッグ（ホイールは無効）。拡大すると境界が増え、原子まで細かくなる。左の木＝表示範囲の UPGMA（枝の長さ＝ブロックの有無・向きの不一致率）／<span style=\"color:#7a1414\">上辺の濃い赤</span>＝反復（その株で 2 回以上出るノードの連なり＝重複の本体）／<span style=\"color:#d35400\">薄いオレンジ ·n</span>＝座標の再訪（同じコンティグの別の通過と座標が重なる。弱い指標）／下辺の赤＝再訪の重なり部分\n  <b>錨の列（ブロックと塩基の間の段）</b> 各行を画面の列（1 列＝数錨〜数百錨）に切り、<span style=\"color:#888\">灰</span>＝その列のトークン列が多数派と同じ、<span style=\"color:#e67e22\">橙</span>・<span style=\"color:#2980b9\">青</span>・<span style=\"color:#27ae60\">緑</span>…＝少数派のアレル（番号順。同じ色＝同じ配列）、薄い＝その列の錨を一部しか持たない（欠失）、上辺の黒＝錨でない配列の挿入（高さは bp の対数）、白＝通過はあるが錨が無い。上段の帯＝列ごとのアレルの種類数（灰 1 種→赤 多い）と行の数（高さ）。下辺 2 px にブロックの色を残す。ホバーで列の錨数・アレル数・この行のトークン範囲（塩基 MSA へ渡す範囲）\n  <b>見出しの遺伝子群</b> 錨（ノード）を共有する遺伝子を 1 本の矢印にまとめる（同じ種類どうし。向きは多数）。<span style=\"color:#0d7c86\">濃い青緑</span>＝90% 以上の株が持つ、薄い＝それ未満、紫＝RNA 遺伝子、灰＝擬似が多数。ホバーで株数・遺伝子数・別名・産物\n  <b>繰り返し通過</b> 同じコンティグが同じ場所を続けて何度も通る（タンデム反復・もつれ）通過は 1 片にまとめ、斜線と ×k（回数）。ホバーで各回の座標と向き。粗い錨の列（1 列が 20 錨超）では、この行だけのアレル＝ごく薄い灰、2 行以上が共有する少数派＝共有する行の数の色（淡い橙 対 → 濃い赤 多くの行）\n  <b>行頭</b> +n冗長＝丸ごと別コンティグに含まれるコンティグ数／×n＝表示が 1 原子に収まるときの通過回数／(n)＝表示範囲内の通過数\n  <b>遺伝子レーン</b> 片の下の帯＝その株の遺伝子。<span style=\"color:#2e8b57\">緑</span>＝タンパク質をコードする遺伝子で合意の向きに +、<span style=\"color:#e67e22\">橙</span>＝同 −、<span style=\"color:#6c5ce7\">紫</span>＝RNA 遺伝子（lncRNA・tRNA・rRNA…。濃い＝+、薄い＝−）、<span style=\"color:#9a9a9a\">灰</span>＝擬似遺伝子。三角＝向き。重なる遺伝子（反対鎖の lncRNA など）は下の段に分ける。幅があれば名前を書く。子の注釈があれば、イントロン＝細い線、エキソン＝低い箱（薄い）、UTR＝さらに低く、CDS＝全高。錨の無い遺伝子は通過の中の位置から補間\n  <b>塩基の段</b> 「塩基へ」で各通過の窓の中の配列を列（ノード＝群）に並べる（Blocks と同じ）。入った直後は画面に収まる俯瞰（群を 1 区画、行の色＝アレル。灰＝基準と同じ）。拡大すると塩基のセル、7 px/塩基で文字。「一致を省く」は基準（多数派か参照）と同じ塩基を · に。列見出し: 上段＝ノードの箱（名前・bp。上の青緑の線＝排他アレルを重ねた群）、下段＝基準の配列、底＝参照座標の錨（青緑）・行間で違う（橙）。Ctrl+ホイール＝拡大縮小、ホイール／ドラッグ＝横に動かす、列見出しのドラッグ＝その範囲を画面幅に、列見出しのクリック＝そのサイト（列）の塩基で並べ替え（複数可、再クリックで解除、マゼンタの印）。表示範囲の木は塩基の段では「行で塩基が違う列」の不一致率（ハミング）で作る。遺伝子: 見出しに遺伝子ごとの矢印（CDS の列は濃く、エキソンは薄く）、行の下に その株の遺伝子の帯（CDS 太い・エキソン中・イントロンや UTR は細い線）。紫の帯（セルの上の線と薄紫の地）＝列の多数と逆向きに通ったノード＝逆位。橙の見出しの列（↻ ノード名）＝写しの列: その株がノードを列の順と違う位置で通る（局所の入れ替わり）か、同じノードを 2 回目に通る所。各株の行は、欠失・範囲外を除いて左から読むとその株の配列になる（逆位の区間は「整列（各株の実際の向き）」で書き出すと株の向きの文字）。塩基は列の向きに直して比べるので、同じノードなら一致（·）。3 bp 以下のノードだけは逆相補のまま（向きで実現した SNP）。同じコンティグの隣り合う通過は 1 行に併合し、離れた 2 回目の通過と、同じ範囲を続けて繰り返す通過（再訪）だけを ·2 の行にする。リードの行（青い名前、株の行の下）: <span style=\"color:#e11d74\">桃色の縦線と三角</span>＝リードだけの挿入（グラフに無い配列なので列が無く、列の境界に印。太い＝10 bp 以上。ホバーで配列）、<span style=\"color:#d35400\">橙の縦線と三角</span>＝株より多い周回・株に無い経路（列は株の行だけで作るので、株に当てはまらないリードの通過は列にせず、直前の列の境界に畳む。ホバーで配列とノード）、俯瞰の薄い赤＝覆っている範囲でどの株の配列とも違う（読み取りエラーか新しい配列）。リードは多数派・変異の判定に数えない。リードの表示（10-29）: 展開＝1 本 1 行、詰める＝サンプルごとに重ならないリードを同じ行に左から詰める（ホバーでその列のリード）、要約＝サンプルごとに深さ（灰の棒）と基準と違う割合（その文字の色、2 割未満は薄く、欠失は黒）\n</div>\n<div id=\"tv_wrap\" class=\"tv-wrap\"><canvas id=\"tv_cv\"></canvas><canvas id=\"tv_ov\"></canvas><div id=\"tv_bscroll\" title=\"塩基の段の横スクロール（格子のドラッグ、ホイールでも動く）\"><div></div></div><div id=\"tv_tip\"></div></div>\n"
const CSS = ".tvpanel { display:flex; flex-direction:column; height:100%; font:12px/1.4 system-ui, sans-serif; color:#222; background:#fafafa; }\n.tvpanel .tv-bar { display:flex; gap:10px; align-items:center; padding:4px 10px; background:#fff; border-bottom:1px solid #ddd; flex-wrap:wrap; flex-shrink:0; }\n.tvpanel .tv-bar label { color:#555; } .tvpanel .tv-bar input[type=number] { width:70px; } .tvpanel button { font:inherit; }\n.tvpanel #tv_info { color:#444; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:60vw; }\n.tvpanel .tv-legend { font-size:11px; color:#444; padding:4px 10px; border-bottom:1px solid #e5e5e5; background:#fdfdfd; line-height:1.5; flex-shrink:0; } .tvpanel .tv-legend b { margin-right:4px; }\n.tvpanel .tv-wrap { position:relative; flex:1; min-height:0; overflow:auto; } .tvpanel canvas { display:block; } .tvpanel #tv_ov { position:absolute; left:0; top:0; pointer-events:none; }\n.tvpanel #tv_tip { position:fixed; pointer-events:none; background:rgba(30,30,30,.92); color:#fff; padding:4px 7px; border-radius:3px; font-size:11px; display:none; max-width:420px; white-space:pre; z-index:9; }\n.tvpanel #tv_bscroll { display:none; position:sticky; bottom:0; left:0; height:14px; overflow-x:scroll; overflow-y:hidden; background:#fff; border-top:1px solid #ddd; z-index:3; } .tvpanel #tv_bscroll > div { height:1px; }\n.tvpanel #tv_gres { display:none; position:absolute; left:0; top:22px; z-index:20; max-height:320px; overflow:auto; background:#fff; border:1px solid #c8cdd3; border-radius:4px; box-shadow:0 6px 20px rgba(20,30,40,.14); font:11px system-ui; min-width:360px; } .tvpanel #tv_gres .it { padding:3px 8px; cursor:pointer; white-space:nowrap; } .tvpanel #tv_gres .it:hover { background:#eef6ff; } .tvpanel #tv_gres .k { color:#777; margin-left:6px; } .tvpanel #tv_gres .hd { padding:3px 8px; color:#666; background:#f6f7f9; border-bottom:1px solid #e5e5e5; }"
function injectStyle() { if (document.getElementById('tv-style')) return; const st = document.createElement('style'); st.id = 'tv-style'; st.textContent = CSS; document.head.appendChild(st) }

export function mountTrav(host: HTMLElement, opts: TravOpts, cb: TravCallbacks): TravHandle {
injectStyle(); host.classList.add('tvpanel'); host.innerHTML = BODY
const $ = (id: string) => host.querySelector('#tv_' + id) as HTMLElement
const PARAMS = opts.params ?? new URLSearchParams(''); const SYNC = PARAMS.get('sync') === '1'
async function getJson(url: string): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  if (!SYNC) return fetch(url)
  const x = new XMLHttpRequest(); x.open('GET', url, false); x.send(null); const txt = x.responseText
  return { ok: x.status >= 200 && x.status < 300, status: x.status, json: async () => JSON.parse(txt) }
}
const cv = $('cv') as HTMLCanvasElement; const g = cv.getContext('2d')!; const tip = $('tip'); const ov = $('ov') as HTMLCanvasElement; const og = ov.getContext('2d')!
let TOP = 70; const TREEW = 70, LAB = 150 + TREEW, BLK = 8; let ROW = 13   // 左に木（TREEW）、ラベル、右に本体。TOP は錨の列の帯を出すとき広げる
let db = '', root: Root | null = null, view: [number, number] = [0, 1], hist: [number, number][] = []
let rows: Trav[] = [], copies: Copy[] = [], reps: Rep[] = [], perHap: Record<string, number> = {}, loading = 0
let hapOrder: number[] = [], baseOrder: number[] = [], atomStats: AtomStat[] = [], refTrav: Trav[] = []
type Clade = { leaves: number[]; size: number; h: number; kids: Clade[]; rep?: number; collapsed?: boolean }
let treeRoot: Clade | null = null   // 表示範囲の木（描画用）
let atomCum: number[] = []        // 原子 i の開始 bp（root.atoms の順）
let blocks: Block[] = []           // 今の表示範囲のブロック
let cols: Cols | null = null, colsNote = ''   // 錨の列（今の表示範囲）
let genes: Gene[] = [], genesNote = ''      // 遺伝子レーン（今の表示範囲、通過ごと）
let gdens: { x0: number; x1: number; nbin: number; n: number[]; v: number[]; hasVar: boolean } | null = null   // 全景の遺伝子の密度（3）
let lof = new Map<number, { st: string; aa: number; ref: number | null; src: number | null }>()   // 機能喪失の目安（5）: gid → 状態
let ogroups: OGroup[] = []; let srcPres: { name: string; type: string; x0: number; x1: number; pres: Pres }[] | null = null   // 参照を写した注釈のとき: 元の遺伝子ごとの有無                  // 見出しの遺伝子トラック
const OGH = 16                              // 見出しの遺伝子トラックの高さ
let treeCut: number | null = null          // 系統樹のまとめ: 併合の高さがこれ（根の高さに対する割合）以下の枝を代表 1 株に（null＝まとめない）
let groupOf = new Map<number, number[]>()  // 代表 hid → まとめた枝の hid 一覧
let located: number[] = []                 // グラフから来た座標（縦線の印）
let baseAuto = false                       // ?base=1 で一度だけ塩基へを押す
let hapMarks = new Map<string, string>()   // 主画面で選択中のパス群（ハプロタイプ名 → 色）。行ラベルの前に丸
let rangeMode: 'none' | 'set' | 'locate' = 'none'   // グラフ連動の方式: set＝非表示（範囲のノード集合）、locate＝塗り分け（見えているノードを座標に引く）
let userMoved = false                      // ユーザが範囲を動かした（寄せるのはこのときだけ。開いた直後や設定変更では寄せない）
let graphMovedTimer: ReturnType<typeof setTimeout> | null = null
let lastHoverNodes = ''                    // 塩基の段でグラフに送ったホバーのノード（同じなら送らない）
// 主画面のパス群の鍵（サンプル／ハプロタイプ／コンティグの粒度）とハプロタイプ名の照合は Blocks と同じ規則（接頭辞）
const markOf = (hap: string): string | undefined => { if (!hapMarks.size) return undefined; const d = hapMarks.get(hap); if (d) return d; const k = matchHapToKey(hap, hapMarks.keys()); return k ? hapMarks.get(k) : undefined }
const FOLD_W = 28                          // 変異の無い群を畳んだときの幅
// ---- 塩基の段（Blocks の塩基の段と同じ見え方。README 改訂 117 のズーム軸）----
type BGroup = { g: number; from: number; to: number; nodes: string[]; rb?: number | null; hasEll: boolean; n: number; bp: number; variant: boolean; foldable: boolean; x0: number; x1: number }
type BItem = { kind: 'col'; ci: number; g: number } | { kind: 'blk'; ci0: number; ci1: number; n: number; g: number; w: number }
type BaseAnn = { refPos: Int32Array; rep: Int32Array; reps: { s: number; e: number; strand: string; name: string; cls: string; fam: string; div: number }[]; samples: string[]; varAt: Map<string, Map<number, { pos: number; ref: string; alt: string; gt: string; first: boolean }>>; inBench: Map<string, Uint8Array>; contig: string }
type BaseState = { ann?: BaseAnn; M: BubbleMsaResp; cols: MsaCol[]; rows: MsaRow[]; groups: BGroup[]; label: string; z: number | null; sx: number; rowsOf: Map<number, number[]>; lines: { hid: number; mi: number; pack?: number[]; cov?: string }[]; readMode?: string; covCache?: Map<string, { dep: Uint16Array; mis: Uint16Array; del: Uint16Array; top: string[]; n: number }>
  norm: string[]; brk: { ci: number; n: number }[][]; inv: Set<number>[]; refRow: number | null; major?: string[]; blk: Map<number, { per: number[]; n: number; counts: number[] }>; items: BItem[]; xs: Float64Array; colItem: Int32Array; cw: number; zEff: number; fullW: number; vOnly: boolean; autoVar: boolean; hoverCi: number | null; sortCi: number[]
  byNode: Map<string, number[]>; genes: BGene[]; genesByHid: Map<number, BGene[]>; eff?: EffResult | null }   // 塩基の段の遺伝子（列に写したもの）、変異の効果
type BGene = { g: Gene; c0: number; c1: number; cols: Uint8Array; kindOf: Uint8Array; mi: number }   // cols = この遺伝子が持つ列、kindOf = 列ごとの種類（1 CDS, 2 エキソン, 3 その他の遺伝子内）、mi = その株の行
// ---- 変異の効果（Blocks の computeEffectsCore の移植。座位ごとのモデル＝最も多くの株が同じ区間に持つ CDS の注釈の読み枠で全行のコドンを読み、基準（多数派か参照）のコドンと比べる）----
const AA64 = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'; const NT_IDX: Record<string, number> = { T: 0, C: 1, A: 2, G: 3, U: 0 }
const START_CODONS = new Set(['ATG', 'GTG', 'TTG']); const COMP: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }
const COMP_B: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N', a: 't', c: 'g', g: 'c', t: 'a', n: 'n' }
const translate = (c: string) => { if (!c || c.length < 3) return '?'; const a = NT_IDX[c[0]], b = NT_IDX[c[1]], d = NT_IDX[c[2]]; if (a == null || b == null || d == null) return 'X'; return AA64[a * 16 + b * 4 + d] }
const AA3: Record<string, string> = { A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile', L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val', '*': 'Ter', X: 'Xaa', '?': '?' }
const EFF: Record<number, string> = { 1: '同義', 2: '非同義', 3: '終止獲得', 4: '終止喪失', 5: '開始喪失', 6: 'フレームシフト', 7: 'インフレーム indel', 8: '読み枠がずれた区間', 9: '逆位（向きが逆の区間）' }
const EFF_COL: Record<number, string> = { 1: '#8aa0b4', 2: '#e08a1e', 3: '#c9302c', 4: '#c9302c', 5: '#c9302c', 6: '#c9302c', 7: '#d4b000', 8: 'rgba(201,48,44,.5)', 9: 'rgba(124,58,237,.45)' }
const EFF_RANK: Record<number, number> = { 0: 0, 9: 1, 8: 1, 1: 2, 7: 3, 2: 4, 6: 5, 5: 5, 4: 5, 3: 5 }
type EffInfo = { k: number; cr: string; cc: string; ar: string; ac: string; e: number; gene: string; eff: string; trunc?: boolean }
type EffSummary = { syn: number; mis: number; nonsense: number; stopLost: number; startLost: number; fs: number; inframe: number; aaLen: number | null; modelAa: number; absent: boolean; gene: string; outOfFrame: number; fsNet?: number; trunc?: boolean; lof?: boolean }
type EffLocus = { cA: number; cB: number; members: any[]; rows: Map<number, EffSummary>; model?: any; modelN?: number; name?: string; eff?: string; ncodon?: number; mcols?: number[]; modelStops?: number }
type EffResult = { code: Map<number, Uint8Array>; info: Map<number, Map<number, EffInfo>>; loci: EffLocus[]; byGene: Map<number, EffLocus>; ms: number; error?: string }
function effMaxIn(EC: Uint8Array, a: number, b: number) { let best = 0; for (let c = a; c <= b; c++) { const v = EC[c]; if (v && EFF_RANK[v] > EFF_RANK[best]) best = v } return best }   // sortCi = 並べ替えに使うサイト（列）。クリックで追加、再クリックで外す
let base: BaseState | null = null
const BASE_COLORS: Record<string, [string, string]> = { A: ['#ffffff', '#2e8b57'], C: ['#ffffff', '#2f6fb3'], G: ['#1b1b1b', '#e0a800'], T: ['#ffffff', '#c9302c'], N: ['#ffffff', '#6b7480'] }   // [文字, 塗り]
const SITES_COLORS = ['#c9ced8', '#2f6fb3', '#e08a1e', '#3a9d5d', '#8a5cd6', '#c9302c', '#17a2b8', '#a0522d']
const Z_LADDER = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7, 10, 14]; const BASE_CELL_Z = 3, BASE_LETTER_Z = 7
let rowTop: number[] = [], rowHgt: number[] = []   // 行の上端と高さ（遺伝子レーンの段数は行ごとに違う）
function rowAt(y: number): number { let lo = 0, hi = rowTop.length - 1; if (!rowTop.length || y < rowTop[0]) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rowTop[m] <= y) lo = m; else hi = m - 1 } return y < rowTop[lo] + rowHgt[lo] ? lo : -1 }
const rowsBottom = () => rowTop.length ? rowTop[rowTop.length - 1] + rowHgt[rowTop.length - 1] : TOP
let geneLanesByHid = new Map<number, Map<number, number>>()   // hid → (gid → 段)。段数は行ごと（重なる遺伝子を分ける。最大 3）
const GLH = 10                              // 遺伝子レーン 1 段の高さ
const showGenes = () => ($('genes') as HTMLInputElement).checked
const rungSel = () => ($('rung') as HTMLSelectElement).value
// 段の自動切替: ブロックが 3 個以下（表示範囲が原子の中〜数個）か 200 kb 以下なら錨の列
function wantCols(): boolean { if (!root) return false; const r = rungSel(); if (r === 'blocks') return false; if (r === 'cols') return true; return blocks.length <= 3 || (bpOfX(view[1] + 1) - bpOfX(view[0])) <= 200_000 }
const bodyPx = () => Math.max(100, cv.parentElement!.clientWidth - LAB)
const fmt = (n: number) => n.toLocaleString('en-US')
const fmtbp = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + ' Mb' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kb' : Math.round(n) + ' bp'
function showErr(where: string, e: any) { $('info').textContent = 'エラー ' + `${where}: ${e && (e.stack || e.message || e)}`.slice(0, 400); $('info').style.color = '#c0392b'; $('busy').style.display = 'none'; console.error(where, e) }
const onWinErr = (ev: ErrorEvent) => showErr('window', ev.error || ev.message); const onWinRej = (ev: PromiseRejectionEvent) => showErr('promise', (ev as any).reason)
if (opts.page) { window.addEventListener('error', onWinErr); window.addEventListener('unhandledrejection', onWinRej) }
const hue = (i: number) => blocks.length > 1 ? (i / (blocks.length - 1)) * 300 : 200   // ブロック番号 → 色相（左から右へ一方向）
const numOf = (id: string, dflt: number) => { const v = Number(($(id) as HTMLInputElement).value); return Number.isFinite(v) ? v : dflt }

// ---- 座標 ↔ bp ↔ 画面 ----
function atomAt(x: number): number { const A = root!.atoms; let lo = 0, hi = A.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (A[m].x1 < x) lo = m + 1; else hi = m } return lo }
function bpOfX(x: number): number { if (!root || !root.atoms.length) return x; const A = root.atoms; const i = Math.max(0, Math.min(A.length - 1, atomAt(x))); const a = A[i]; const f = Math.max(0, Math.min(1, (x - a.x0) / (a.x1 - a.x0 + 1))); return atomCum[i] + f * a.bp }
function xOfBp(bp: number): number { if (!root || !root.atoms.length) return bp; const A = root.atoms; let lo = 0, hi = A.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (atomCum[m] + A[m].bp < bp) lo = m + 1; else hi = m } const a = A[lo]; const f = Math.max(0, Math.min(1, (bp - atomCum[lo]) / Math.max(1, a.bp))); return a.x0 + f * (a.x1 - a.x0 + 1) }
const wPx = () => cv.width / devicePixelRatio - LAB
function X(x: number) { const b0 = bpOfX(view[0]), b1 = bpOfX(view[1] + 1); return LAB + (bpOfX(x) - b0) / Math.max(1, b1 - b0) * wPx() }
function xOfPx(px: number) { const b0 = bpOfX(view[0]), b1 = bpOfX(view[1] + 1); return xOfBp(b0 + (px - LAB) / wPx() * (b1 - b0)) }
function refPos(x: number): string {
  const t = refTrav.find(t => t.x0 <= x && t.x1 >= x); if (!t || t.bp0 == null) return ''
  const f = (x - t.x0) / Math.max(1, t.x1 - t.x0); const bp = t.dir >= 0 ? t.bp0 + f * t.bp : t.bp0 + (1 - f) * t.bp
  return `${root!.haps[t.hid].hap.split('#')[0]} ${fmtbp(bp)}`
}

// ---- ブロック: 表示範囲の境界を持続度の高い順に K−1 本残す ----
function makeBlocks(): Block[] {
  if (!root) return []
  const [v0, v1] = view; const K = Math.max(1, numOf('nblk', 30))
  const inside = root.bounds.filter(b => b.x > v0 && b.x <= v1).sort((a, b) => b.persistence - a.persistence).slice(0, K - 1).map(b => b.x).sort((a, b) => a - b)
  const edges = [Math.floor(v0), ...inside, Math.floor(v1) + 1]; const out: Block[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const x0 = edges[i], x1 = edges[i + 1] - 1; if (x1 < x0) continue
    const a0 = atomAt(x0), a1 = atomAt(x1); let nhap = 0, nhap2 = 0, tbp = 0, abp = 0
    for (let k = a0; k <= a1; k++) { const st = atomStats[k]; const a = root.atoms[k]; nhap = Math.max(nhap, st ? st.nhap : a.nhap); abp += a.bp; if (st) { nhap2 = Math.max(nhap2, st.nhap2); if (st.tangled) tbp += a.bp } }
    out.push({ id: i, x0, x1, bp: bpOfX(x1 + 1) - bpOfX(x0), a0, a1, nhap, nhap2, tangled: tbp >= 0.3 * Math.max(1, abp) })   // もつれた原子が bp の 3 割以上のときだけ
  }
  return out
}
function blockAt(x: number): number { let lo = 0, hi = blocks.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (blocks[m].x1 < x) lo = m + 1; else hi = m } return lo }

// ---- 読み込み ----
async function loadRoot() {
  const r = await getJson(`/api/trav/root?db=${encodeURIComponent(db)}`)
  if (!r.ok) { root = null; $('info').textContent = `${db}: .trav が無い（${r.status}）`; draw(); return }
  root = await r.json(); view = [0, root!.R - 1]; hist = []
  const vq = PARAMS.get('view'); if (vq) { const [a, b] = vq.split('-').map(Number); if (Number.isFinite(a) && Number.isFinite(b)) view = [Math.max(0, a), Math.min(root!.R - 1, b)]; userMoved = true }   /* URL の範囲は寄せる（10-28: 全景のまま絞られて真っ白） */
  atomCum = []; let c = 0; for (const a of root!.atoms) { atomCum.push(c); c += a.bp }
  const refLike = (h: string) => /^(GRCh38|CHM13|GCF_000148365)/.test(h) ? 0 : 1
  baseOrder = root!.haps.map(h => h.hid).sort((a, b) => refLike(root!.haps[a].hap) - refLike(root!.haps[b].hap) || root!.haps[a].hap.localeCompare(root!.haps[b].hap)); hapOrder = baseOrder.slice()
  atomStats = []; await loadAtoms(); await loadRange()
}
async function loadAtoms() {
  if (!root) return
  const r = await getJson(`/api/trav/atoms?db=${encodeURIComponent(db)}&minanch=${numOf('minanch', 50)}`); atomStats = r.ok ? (await r.json()).atoms : []
  const refH = root.haps.find(h => /^(GRCh38|CHM13)/.test(h.hap)); refTrav = []
  if (refH) { const rr = await getJson(`/api/trav/range?db=${encodeURIComponent(db)}&x0=0&x1=${root.R}&minanch=1000`); if (rr.ok) refTrav = ((await rr.json()).trav as Trav[]).filter(t => t.hid === refH.hid) }
}
let rangeTimer: any = null
function scheduleRange(ms = 120) { if (rangeTimer) clearTimeout(rangeTimer); $('busy').style.display = 'inline'; rangeTimer = setTimeout(() => { rangeTimer = null; loadRange() }, ms) }
async function loadRange() {
  if (!root) return
  const my = ++loading; $('busy').style.display = 'inline'
  try {
    const r = await getJson(`/api/trav/range?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}`)
    if (my !== loading) return
    const j = await r.json(); rows = j.trav; copies = j.copies; reps = j.reps || []; perHap = j.perHap; sel = null; $('info').style.color = ''
    // 反復でない重なり（backend の trim）: 錨を持たない側の通過からその区間を除く。残る側が 2 つに割れたら広い方（ε で吸われた端の数錨は捨てる）
    for (const t of rows as Trav[]) { if (!t.trim) continue; const [a, b] = t.trim; t.ox0 = t.x0; t.ox1 = t.x1; const lo = a - t.x0, hi = t.x1 - b; if (lo >= hi) t.x1 = Math.max(t.x0, a - 1); else t.x0 = Math.min(t.x1, b + 1) }
    blocks = makeBlocks()
    hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice()
    const nh2 = Object.values(perHap).filter(n => (n as number) >= 2).length
    $('info').textContent = `${db}: 座標 ${fmt(Math.floor(view[0]))}–${fmt(Math.ceil(view[1]))} / ${fmt(root.R)}（${fmtbp(j.bp0)}–${fmtbp(j.bp1)}） ブロック ${blocks.length}（原子 ${root.atoms.length}） 通過 ${fmt(rows.length)} コピー ${fmt(copies.length)} 2 回以上通る株 ${nh2} | 錨 強 ${fmt(root.meta.strong)} 補間 ${fmt(root.meta.interp)}`
    cols = null; colsNote = ''
    const viewBp = bpOfX(view[1] + 1) - bpOfX(view[0])
    if (wantCols() || viewBp <= 2_000_000) {   // 錨の列: まずブロックの段を描いてから取りに行く（ブロックの段でも 2 Mb 以下なら読み、欠失の切れ目に使う）
      draw()
      const rc = await getJson(`/api/trav/cols?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&ncol=${Math.floor(bodyPx())}&minanch=${numOf('minanch', 50)}`)
      if (my !== loading) return
      const jc = await rc.json()
      if (jc.tooBig) colsNote = `錨の列: 範囲が広すぎる（トークン ${fmt(jc.ntok)} > ${fmt(jc.max)}）`
      else if (jc.error) colsNote = `錨の列: ${jc.error}`
      else { const rc2: ColRow[] = (jc.rows as any[]).map(r => ({ ...r, pres: u8(r.pres), cls: u8(r.cls), ins: u16(r.ins), frq: r.frq ? u8(r.frq) : new Uint8Array(0), bpc: r.bpc ? u32(r.bpc) : new Uint32Array(0) })); cols = { x0: jc.x0, x1: jc.x1, ncol: jc.ncol, ntok: jc.ntok, nanch: u16(jc.cols.nanch), ncls: u8(jc.cols.ncls), nrow: u16(jc.cols.nrow), major: u16(jc.cols.major), rows: rc2, byId: new Map(rc2.map(r => [r.id, r])) } }
      $('info').textContent = (colsNote ? colsNote : `錨の列 ${fmt(jc.ncol)} 列（トークン ${fmt(jc.nread)}・${fmt(jc.ms)} ms）`) + ' | ' + $('info').textContent
      if (cols && ($('order') as HTMLSelectElement).value === 'tree') hapOrder = treeOrder()   // 木を錨の列（アレル）で作り直す
    }
    updateBase()
    genes = []; genesNote = ''; ogroups = []; gdens = null; lof = new Map()
    if (showGenes()) {   // 遺伝子レーン: 通過ごとの遺伝子を座標に写したもの
      draw()
      const rg = await getJson(`/api/trav/genes?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}`)
      if (my !== loading) return
      const jg = await rg.json()
      if (jg.tooMany) genesNote = `遺伝子: 多すぎる（${fmt(jg.n)} > ${fmt(jg.max)}。範囲を狭める）`; else if (jg.error) genesNote = `遺伝子: ${jg.error}`; else { genes = jg.genes as Gene[]; ogroups = (jg.groups || []) as OGroup[]; srcPres = jg.srcPres || null } renderGpres()
      if (jg.tooMany) { try { const rd = await getJson(`/api/trav/genedensity?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&nbin=400&minanch=${numOf('minanch', 50)}`); const jd = await rd.json(); if (my === loading && !jd.error) gdens = jd } catch { /* 密度は無くてもよい */ } }
      if (genes.length && genes.length <= 20000) { const gids = [...new Set(genes.filter(gn => geneKind(gn) === 'cds').map(gn => gn.gid))]; if (gids.length) void (async () => { try { const rl = await fetch('/api/trav/genelof', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db, gids }) }); const jl = await rl.json(); if (my !== loading || !jl.genes) return; lof = new Map(Object.entries(jl.genes).map(([k, v]) => [Number(k), v as any])); renderGpres(); draw() } catch { /* 目安なので失敗は無視 */ } })() }
      geneLanesByHid = new Map(); { const byHid = new Map<number, Gene[]>(); for (const gn of genes) { if (!byHid.has(gn.hid)) byHid.set(gn.hid, []); byHid.get(gn.hid)!.push(gn) } for (const [hid, gs] of byHid) geneLanesByHid.set(hid, geneLanes(gs)) }
      if (genesNote) $('info').textContent += ' | ' + genesNote; else $('info').textContent += ` | 遺伝子 ${fmt(genes.length)}`
    }
    const syncOn = ($('sync') as HTMLInputElement).checked, hideOn = ($('gfilter') as HTMLInputElement).checked && !!root && (view[1] - view[0] < 0.98 * (root.R - 1)); const fitNow = syncOn && userMoved; userMoved = false   /* 全体を見ているときは絞らない */
    if (cb.onRange && (syncOn || hideOn)) {
      // 塗り分けは常に「グラフに見えているノード」を座標に引く（葉・錨でない葉・スーパーノードのどれでも）。範囲のノード集合は、非表示（絞る）と寄せる先にだけ使う
      let setNames: string[] | null = null; let fitNames: string[] | undefined
      if (fitNow) {   // 寄せる先: 範囲全体から座標で等間隔に標本した錨（範囲のノード集合は株ごと・位置順で先頭に偏り、広い範囲では最初のブロック付近だけに寄っていた）
        const rn = await getJson(`/api/trav/nodes?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&max=1500`); if (my !== loading) return
        const jn = await rn.json(); fitNames = (jn.names || []) as string[]
      }
      if (hideOn) {
        const rf = await getJson(`/api/trav/nodeset?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}&max=150000`)
        if (my !== loading) return
        const jf = await rf.json(); if (!(jf.tooBig || jf.error)) { setNames = jf.names as string[]; if (jf.truncated) $('info').textContent += ` | 範囲のノード ${fmt(jf.n)} で打ち切り` } else if (hideOn) $('info').textContent += ` | グラフを絞る: ${jf.error || '範囲が広すぎる'}`
      }
      // 絞り（非表示）と塗り分けは別の通り道（10-28: 絞ると塗りが消え、塩基の段の見える範囲を送ると絞りが外れて上の層に戻っていた）
      if (hideOn && setNames) { rangeMode = 'set'; cb.onRange({ names: setNames, colors: null, fit: false, hide: true, fitNames }); await rangeByLocate(my) }
      else { rangeMode = 'locate'; cb.onRange({ names: [], colors: null, fit: false, hide: true }); await rangeByLocate(my, fitNames) }   // hide＋空＝絞りを外す
    } else if (cb.onRange) { rangeMode = 'none'; cb.onRange(null) }
  } catch (e) { showErr('range', e) }
  $('busy').style.display = 'none'; draw()
  // 塩基の段を自動で開くのは、絞り・塗りを送り終えてから（10-28: 途中で開くと loading が進み、範囲の読み込みが絞りを送らずに抜けて、共有 URL の復元で絞り込みが外れた）
  if (my !== loading) return
  if (baseAutoState && !($('base') as HTMLButtonElement).disabled) { baseAutoState = false; setTimeout(() => $('base').click(), 0) }
  if (PARAMS.get('base') === '1' && !baseAuto && !($('base') as HTMLButtonElement).disabled) { baseAuto = true; setTimeout(() => $('base').click(), 0) }   // URL で塩基 MSA まで開く（撮影・再現用）
}

// 塗り分け: 主画面に見えているノード（≤5,000）の座標を引き（葉＝錨の x、錨でない葉＝直前の錨の x、スーパーノード＝子孫の bp 多数派）、表示範囲の中をブロックの色、外を薄灰に。
// 見えているノードが 0 のとき（タイル読み込み中）は前の塗りを保つ。fitNames があればそこへ寄せる
async function rangeByLocate(my: number, fitNames?: string[]) {
  if (!cb.onRange || !root) return
  const names = cb.getVisibleNames ? cb.getVisibleNames() : []
  if (!names.length) { if (fitNames) cb.onRange({ names: [], colors: [], fit: false, hide: false, direct: true, fitNames }); return }
  const r = await fetch('/api/trav/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db, names: names.slice(0, 120000) }) }); const j = await r.json()
  if (my !== loading) return
  // スーパーノード（kind −2）は、多数派の座標が範囲の外でも、子孫の座標の張り（xmin–xmax）が範囲に掛かれば、範囲に寄せた座標の色で塗る
  // （10-28: 範囲の祖先として絞り込みに入るのに、多数派が隣の区間にあるだけで 4 割が灰になった。ecoli 原子 149–155）
  const nodes0 = (j.nodes || []) as { name: string; x: number; kind: number; xmin?: number; xmax?: number }[]
  const nodes = nodes0.map(n => (n.kind === -2 && n.x >= 0 && (n.x < view[0] || n.x > view[1]) && n.xmin != null && n.xmax != null && n.xmin <= view[1] && n.xmax >= view[0]) ? { ...n, x: Math.max(view[0], Math.min(view[1], n.x)) } : n)
  const inR = nodes.filter(n => n.x >= view[0] && n.x <= view[1]); const withX = nodes.filter(n => n.x >= 0).length
  $('info').textContent = $('info').textContent.replace(/ \| グラフ連動:[^|]*$/, '') + ` | グラフ連動: 見えている ${fmt(nodes.length)}（座標あり ${fmt(withX)}、範囲内 ${fmt(inR.length)}${!j.hasFill ? '、錨でない葉は座標なし' : ''}）`
  cb.onRange({ names: inR.map(n => n.name), colors: inR.map(n => hslToInt(hue(blockAt(n.x)), 70, 46)), fit: false, hide: false, direct: true, fitNames })
}
// ---- 塩基へ: 錨の列の各行（通過）の窓の中のトークン範囲を塩基レベル MSA に渡す。葉（ノード）の見積もり＝範囲の bp ÷ ノードあたりの bp ----
const bpPerNode = () => (root && root.meta && root.meta.N) ? Math.max(1, root.total_bp / Number(root.meta.N)) : 10
function updateBase() {
  const b = $('base') as HTMLButtonElement
  if (!root || !cols) { b.disabled = true; b.title = '錨の列の段で使える（表示範囲を狭めるか、段を「錨の列」に）'; return }
  const est = Math.round((bpOfX(view[1] + 1) - bpOfX(view[0])) / bpPerNode()); const nr = cols.rows.filter(r => r.tw0 >= 0).length
  b.disabled = !(nr && est <= 3000); b.title = est <= 3000 ? `この範囲（葉 ≈${fmt(est)}、行 ${nr}）の各通過を塩基レベル MSA へ` : `葉 ≈${fmt(est)} は上限 3,000 を超える。範囲を狭める`
}
$('base').addEventListener('click', () => {
  if (!root || !cols) return
  // 4 つ目＝コンティグの主な向き（通過の dir を錨数で重み付け）。bubble_msa はこれで行の表示の向きを決める（窓が反転ブロックに偏っても両側配列が逆向きにならない）
  const domOf = new Map<number, number>(); for (const r of rows) domOf.set(r.pid, (domOf.get(r.pid) || 0) + r.dir * r.nanch)
  const ranges = cols.rows.filter(r => r.tw0 >= 0).map(r => [r.pid, r.tw0, r.tw1 + 1, (domOf.get(r.pid) ?? r.dir) >= 0 ? 1 : -1] as number[]); const label = `通過 ${fmt(Math.floor(view[0]))}–${fmt(Math.ceil(view[1]))}`
  void openBase(ranges, label); cb.onBaseMsa?.(ranges, label)
})
// ---- 塩基の段 ----
async function openBase(ranges: number[][], label: string) {
  if (!root) return
  const my = ++loading; $('busy').style.display = 'inline'
  const wantReads = !!(root as any)?.hasReads && (($('breads') as HTMLInputElement | null)?.checked !== false)
  const d = await fetchBubbleMsaRanges(db, ranges, label, 0, 0, 3000, wantReads ? { max: numOf('breadmax', 40) } : undefined)   // cap 0＝畳まない（画面側で畳む）、葉の上限 3,000
  if (my !== loading) return
  $('busy').style.display = 'none'
  if (d.error || !d.cols || !d.rows || !d.cols.length) { $('info').textContent = `塩基の段: ${d.error || '列が無い'}`; $('info').style.color = '#c0392b'; return }
  const hidOf = new Map(root.haps.map(h => [h.hap, h.hid])); const rowsOf = new Map<number, number[]>()
  const bySample = new Map<string, number[]>(); for (const h of root.haps) { const sm = h.hap.split('#')[0]; if (!bySample.has(sm)) bySample.set(sm, []); bySample.get(sm)!.push(h.hid) }
  d.rows.forEach((r, mi) => { const nm = r.label.replace(/ ·\d+$/, ''); let hid = hidOf.get(nm)
    if (hid == null) { const sm = (r.path || nm).split('#')[0]; const c = bySample.get(sm); if (c && c.length === 1) hid = c[0] }   // 参照は 'GRCh38#chr22'（パスが sample#contig の 2 区切り）で .trav の 'GRCh38#0' と合わない → サンプルで引く
    if (hid == null) return; if (!rowsOf.has(hid)) rowsOf.set(hid, []); rowsOf.get(hid)!.push(mi) })
  const byNode = new Map<string, number[]>(); d.cols.forEach((c, i) => { for (const nm of (c.nodes || [])) { const a = byNode.get(nm); if (a) a.push(i); else byNode.set(nm, [i]) } })
  baseGenesReq = ++baseGenesSeq
  const inv = d.rows.map(r => { const st = new Set<number>(); if ((r as any).invc) { for (const [a, b] of (r as any).invc as [number, number][]) for (let i = a; i <= b; i++) st.add(i) } else for (const n of (r.inv || [])) for (const i of (byNode.get(n) || [])) st.add(i); return st })   // invc＝通過ごとの逆向きの列（10-29。無ければノード名から）
  // 逆位のノードの文字は bubble_msa が列の多数の向きに揃えて返す（同じノードなら他の行と同じ文字。孤立した 3 bp 以下は逆相補のまま＝向きで実現した SNP）。
  // 画面側は inv（紫の帯）で逆向きを示すだけ。norm は比較・多数派・並べ替え・効果に使う配列（＝seq）
  const norm = d.rows.map(r => r.seq)
  // 継ぎ目: 同じコンティグの離れた範囲を 1 行に繋いだ所（間のトークンは窓の外）。右側のノードの最初の列の左端に印
  const brk = d.rows.map(r => { const out: { ci: number; n: number }[] = []; for (const b of (r.brk || [])) { const ca = byNode.get(b[0]), cb = byNode.get(b[1]); if (!ca || !cb) continue; const right = ca[0] < cb[0] ? cb : ca; out.push({ ci: right[0], n: b[2] }) } return out })
  const ri = d.rows.findIndex(r => r.isref)
  base = { M: d, cols: d.cols, rows: d.rows, groups: baseGroups(d.cols, d.rows), label, z: null, sx: 0, rowsOf, lines: [], norm, brk, inv, refRow: ri >= 0 ? ri : (d.rows.length ? 0 : null), blk: new Map(), items: [], xs: new Float64Array(0), colItem: new Int32Array(0), cw: 0, zEff: 0, fullW: 0, vOnly: false, autoVar: false, hoverCi: null, sortCi: [], byNode, genes: [], genesByHid: new Map() }
  if (showGenes()) void loadBaseGenes(base)
  if ((root as any)?.hasAnn && annOn()) void loadBaseAnn(base)
  if (($('order') as HTMLSelectElement).value === 'tree') hapOrder = treeOrder()   // 木を塩基の違いで作り直す
  { const bz = Number(PARAMS.get('bz')); if (bz > 0) base.z = bz }   // URL で倍率まで再現（撮影用）
  $('basegrp').style.display = ''; $('info').style.color = ''; draw()
}
let baseGenesSeq = 0, baseGenesReq = 0
// ---- 参照座標の注釈（10-28）: 列の参照位置 = rb + so[ri]（参照のノードの格納向きのオフセット。ref_bp は 0 始まり）。参照を通らない列（挿入・株固有のアレル）には付かない ----
const annOn = () => (($('bann') as HTMLInputElement | null)?.checked !== false)
const REP_COL: Record<string, string> = { SINE: '#e8890c', LINE: '#c92a2a', LTR: '#862e9c', DNA: '#1971c2', Simple_repeat: '#0ca678', Low_complexity: '#868e96', Satellite: '#d9480f', Retroposon: '#a61e4d', RC: '#5c940d' }
const repColor = (cls: string) => REP_COL[cls] || '#adb5bd'
const ANN_REP_H = 10, ANN_VAR_H = 8
const annH = (B: BaseState) => (B.ann && annOn()) ? ANN_REP_H + ANN_VAR_H * B.ann.samples.length + 2 : 0
async function loadBaseAnn(B: BaseState) {
  const n = B.cols.length; const refPos = new Int32Array(n).fill(-1); let lo = Infinity, hi = -Infinity
  B.cols.forEach((c, i) => { const cc = c as any; if (c.kind !== 'base' || c.rb == null || cc.ri == null || !c.so || cc.cp) return; const o = c.so[cc.ri]; if (o == null || o < 0) return; const p = c.rb + o; refPos[i] = p; if (p < lo) lo = p; if (p > hi) hi = p })
  const contig = B.M.refname; if (!contig || !(hi >= lo)) return
  const r = await getJson(`/api/trav/ann?db=${encodeURIComponent(db)}&contig=${encodeURIComponent(contig)}&s=${lo}&e=${hi + 1}`); const j = await r.json(); if (base !== B || j.error) return
  const colOf = new Map<number, number>(); refPos.forEach((p, i) => { if (p >= 0 && !colOf.has(p)) colOf.set(p, i) })
  const rep = new Int32Array(n).fill(-1); (j.rmsk as BaseAnn['reps']).forEach((rp, k) => { for (let p = Math.max(rp.s, lo); p < Math.min(rp.e, hi + 1); p++) { const ci = colOf.get(p); if (ci != null) rep[ci] = k } })
  const varAt = new Map<string, Map<number, any>>(); for (const sm of j.samples as string[]) varAt.set(sm, new Map())
  for (const v of j.vars as { sample: string; pos: number; ref: string; alt: string; gt: string }[]) { const m = varAt.get(v.sample); if (!m) continue; const L = Math.max(1, v.ref.length)
    for (let p = v.pos; p < v.pos + L; p++) { const ci = colOf.get(p); if (ci != null && !m.has(ci)) m.set(ci, { ...v, first: p === v.pos }) } }
  const inBench = new Map<string, Uint8Array>(); for (const sm of j.samples as string[]) { const u = new Uint8Array(n); for (const [s0, e0] of (j.bench[sm] || []) as [number, number][]) for (let p = Math.max(s0, lo); p < Math.min(e0, hi + 1); p++) { const ci = colOf.get(p); if (ci != null) u[ci] = 1 } inBench.set(sm, u) }
  B.ann = { refPos, rep, reps: j.rmsk, samples: j.samples, varAt, inBench, contig }; draw()
}
// 塩基の段の遺伝子: 範囲の遺伝子のノード名を列に写す（CDS＝1、エキソン＝2、他＝3）。見出しのトラックと行の下の帯、変異の効果の材料
async function loadBaseGenes(B: BaseState) {
  const my = baseGenesReq
  const r = await getJson(`/api/trav/genes?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}&nodes=1`); const j = await r.json()
  if (my !== baseGenesReq || base !== B || !j.genes) return
  const ncol = B.cols.length; const out: BGene[] = []
  for (const g of j.genes as Gene[]) { if (!g.nodes) continue; const cols = new Uint8Array(ncol), kindOf = new Uint8Array(ncol); let c0 = ncol, c1 = -1
    for (const nm of g.nodes.names) for (const ci of (B.byNode.get(nm) || [])) { cols[ci] = 1; kindOf[ci] = 3; if (ci < c0) c0 = ci; if (ci > c1) c1 = ci }
    for (const ex of g.nodes.exon) for (const nm of ex) for (const ci of (B.byNode.get(nm) || [])) kindOf[ci] = 2
    for (const cd of g.nodes.cds) for (const nm of cd.names) for (const ci of (B.byNode.get(nm) || [])) kindOf[ci] = 1
    if (c1 < 0) continue; let mi = -1, best = -1; for (const m2 of (B.rowsOf.get(g.hid) || [])) { let cnt = 0; const sq = B.rows[m2].seq; for (let ci = c0; ci <= c1; ci++) if (cols[ci] && sq[ci] && sq[ci] !== '-' && sq[ci] !== '.' && sq[ci] !== '~') cnt++; if (cnt > best) { best = cnt; mi = m2 } }
    if (mi < 0) continue; out.push({ g, c0, c1, cols, kindOf, mi }) }
  B.eff = undefined
  B.genes = out; B.genesByHid = new Map(); for (const bg of out) { if (!B.genesByHid.has(bg.g.hid)) B.genesByHid.set(bg.g.hid, []); B.genesByHid.get(bg.g.hid)!.push(bg) }
  draw()
}
function baseUngapped(B: BaseState, mi: number): { posOf: Int32Array; colOf: number[] } { const seq = B.rows[mi].seq || ''; const n = seq.length; const posOf = new Int32Array(n).fill(-1); const colOf: number[] = []; for (let i = 0; i < n; i++) { const ch = seq[i]; if (ch && ch !== '-' && ch !== '~' && ch !== '.') { posOf[i] = colOf.length; colOf.push(i) } } return { posOf, colOf } }
// ノード名と（格納向きの）オフセット → 列。列に off があればそれで、無ければノードの列の並びの中の位置で
function colOfNodeOff(B: BaseState, name: string, off: number): number {
  const cs = B.byNode.get(name); if (!cs || !cs.length) return -1
  // 列の so（格納向きのオフセット。逆相補で表示したノードは L-1-k）を優先、無ければ off。±3 まで許す（Blocks と同じ）
  const offOf = (ci: number): number | null => { const c = B.cols[ci] as any; const j = (c.nodes || []).indexOf(name); const so = Array.isArray(c.so) ? c.so[j] : null; return so != null ? so : (c.off != null ? c.off : null) }
  for (let d = 0; d <= 3; d++) for (const ci of cs) { const o = offOf(ci); if (o != null && Math.abs(o - off) === d) return ci }
  return cs[Math.max(0, Math.min(cs.length - 1, off))]
}
function computeEffects(B: BaseState): EffResult {
  const t0 = Date.now(); const ncol = B.cols.length; const rows = B.rows; const cmp = baseCmpSeq(); const cmpSeq: ArrayLike<string> = cmp.seq || []
  const code = new Map<number, Uint8Array>(), info = new Map<number, Map<number, EffInfo>>(); rows.forEach((_, mi) => { code.set(mi, new Uint8Array(ncol)); info.set(mi, new Map()) })
  const refRow = B.refRow
  // 候補: CDS の片を持つ遺伝子（列の区間）。転写の向きは注釈の開始の列と終了の列の大小で決める（strand に頼らない）
  const cands: any[] = []
  for (const bg of B.genes) { const nd = bg.g.nodes; if (!nd || !nd.cds.length) continue
    const segs = nd.cds.map(c => { const i0 = colOfNodeOff(B, c.names[0], c.so || 0), i1 = colOfNodeOff(B, c.names[c.names.length - 1], c.eo || 0); return { i0, i1, phase: c.phase || 0, first: c.first } }).filter(sg => sg.i0 >= 0 && sg.i1 >= 0)
    if (!segs.length) continue; const cA = Math.min(...segs.map(sg => Math.min(sg.i0, sg.i1))), cB = Math.max(...segs.map(sg => Math.max(sg.i0, sg.i1)))
    const up = segs[0].i0 <= segs[0].i1; const eff = (bg.g.strand === '+') === up ? '+' : '-'
    cands.push({ bg, mi: bg.mi, gid: bg.g.gid, segs, cA, cB, eff, pseudo: bg.g.pseudo, name: bg.g.name || bg.g.locus || ('#' + bg.g.gid) }) }
  cands.sort((a, b) => a.cA - b.cA || b.cB - a.cB); const loci: EffLocus[] = []; const byGene = new Map<number, EffLocus>()
  for (const c of cands) { let L: EffLocus | null = null; for (let i = loci.length - 1; i >= 0 && i >= loci.length - 6; i--) { const l = loci[i]; const ov = Math.min(l.cB, c.cB) - Math.max(l.cA, c.cA) + 1; if (ov >= 0.5 * Math.min(l.cB - l.cA + 1, c.cB - c.cA + 1)) { L = l; break } }
    if (!L) { L = { cA: c.cA, cB: c.cB, members: [], rows: new Map() }; loci.push(L) } L.members.push(c); L.cA = Math.min(L.cA, c.cA); L.cB = Math.max(L.cB, c.cB); byGene.set(c.gid, L) }
  for (const L of loci) {
    const sig = new Map<string, { n: number; first: any; ref: any }>(); for (const c of L.members) { if (c.pseudo) continue; const k = c.cA + ':' + c.cB + ':' + c.eff; const e = sig.get(k) || { n: 0, first: c, ref: null }; e.n++; if (refRow != null && c.mi === refRow) e.ref = c; sig.set(k, e) }
    let best: { n: number; first: any; ref: any } | null = null; for (const e of sig.values()) if (!best || e.n > best.n) best = e
    if (!best) { const longest = L.members.slice().sort((a, b) => (b.cB - b.cA) - (a.cB - a.cA))[0]; best = { n: 0, first: longest, ref: null } }
    const model = best.ref || best.first; L.model = model; L.modelN = best.n; L.name = model.name; L.eff = model.eff
    const mrow = { seq: B.norm[model.mi] || rows[model.mi].seq }; const U = baseUngapped(B, model.mi); const dirUp = model.eff === '+'
    const segs = model.segs.slice().sort((a: any, b: any) => dirUp ? Math.min(a.i0, a.i1) - Math.min(b.i0, b.i1) : Math.max(b.i0, b.i1) - Math.max(a.i0, a.i1))
    const mcols: number[] = []; const ranges: { lo: number; hi: number }[] = []; let first = true
    for (const sg of segs) { const lo = Math.min(sg.i0, sg.i1), hi = Math.max(sg.i0, sg.i1); const pa = U.posOf[lo], pb = U.posOf[hi]; if (pa < 0 || pb < 0) continue; const cs: number[] = []; if (dirUp) { for (let q = pa; q <= pb; q++) cs.push(U.colOf[q]) } else { for (let q = pb; q >= pa; q--) cs.push(U.colOf[q]) } const skip = first ? (sg.phase || 0) : 0; first = false; for (let i = skip; i < cs.length; i++) mcols.push(cs[i]); ranges.push({ lo, hi }) }
    L.mcols = mcols; L.ncodon = Math.floor(mcols.length / 3); if (L.ncodon < 2) continue
    { const rdm = (c: number) => { const ch = mrow.seq[c]; const u = ch ? ch.toUpperCase() : 'N'; return dirUp ? u : (COMP[u] || 'N') }; let stops = 0; for (let k = 0; k < L.ncodon - 1; k++) if (translate(rdm(mcols[3 * k]) + rdm(mcols[3 * k + 1]) + rdm(mcols[3 * k + 2])) === '*') stops++; L.modelStops = stops }
    const isM = new Uint8Array(ncol); for (const c of mcols) isM[c] = 1; const codonOfCol = new Int32Array(ncol).fill(-1); mcols.forEach((c, i) => { codonOfCol[c] = Math.floor(i / 3) })
    const rd = (seq: ArrayLike<string>, c: number): string | null => { const ch = seq[c]; if (!ch || ch === '-' || ch === '~' || ch === '.') return null; const u = ch.toUpperCase(); return dirUp ? u : (COMP[u] || 'N') }
    const cmpCodon = (k: number) => { const a = rd(cmpSeq, mcols[3 * k]), b = rd(cmpSeq, mcols[3 * k + 1]), d = rd(cmpSeq, mcols[3 * k + 2]); if (a && b && d) return a + b + d; return (rd(mrow.seq, mcols[3 * k]) || 'N') + (rd(mrow.seq, mcols[3 * k + 1]) || 'N') + (rd(mrow.seq, mcols[3 * k + 2]) || 'N') }
    const ccache = new Map<number, string>(); const CC = (k: number) => { let v = ccache.get(k); if (v === undefined) { v = cmpCodon(k); ccache.set(k, v) } return v }
    const allCols: number[] = []; for (const rg of ranges) { if (dirUp) { for (let c = rg.lo; c <= rg.hi; c++) allCols.push(c) } else { for (let c = rg.hi; c >= rg.lo; c--) allCols.push(c) } }
    const firstM = mcols[0]; let startIdx = allCols.indexOf(firstM); if (startIdx < 0) startIdx = 0
    rows.forEach((r, mi) => { if ((r as any).read) return; /* リードの行は効果を読まない（10-29: ホモポリマーの読み取りエラーがインフレーム indel・フレームシフトに見えるだけ） */ const seq = B.norm[mi] || r.seq || ''; const EC = code.get(mi)!; const EI = info.get(mi)!; const S: EffSummary = { syn: 0, mis: 0, nonsense: 0, stopLost: 0, startLost: 0, fs: 0, inframe: 0, aaLen: null, modelAa: L.ncodon!, absent: false, gene: L.name!, outOfFrame: 0 }
      let present = 0; const shiftBefore = new Int32Array(ncol); let shift = 0; let run: { cols: number[]; ins: number; del: number } | null = null
      const flush = () => { if (!run) return; const net = run.ins - run.del; const fsh = ((net % 3) + 3) % 3 !== 0; for (const c of run.cols) EC[c] = fsh ? 6 : 7; if (fsh) S.fs++; else S.inframe++; shift = ((shift + net) % 3 + 3) % 3; run = null }
      for (let i = startIdx; i < allCols.length; i++) { const c = allCols[i]; const m = isM[c] === 1; const b = rd(seq, c) != null; if (b) present++; shiftBefore[c] = shift
        if (m && b) { flush() } else if (m && !b) { if (!run) run = { cols: [], ins: 0, del: 0 }; run.cols.push(c); run.del++ } else if (!m && b) { if (!run) run = { cols: [], ins: 0, del: 0 }; run.cols.push(c); run.ins++ } }
      flush()
      if (!present) { S.absent = true; L.rows.set(mi, S); return }
      { const iv = B.inv[mi]; if (iv && iv.size) for (const c of mcols) if (iv.has(c) && !EC[c]) EC[c] = 9 }   // 逆向きに通った区間（逆位）。塩基は向きを揃えて比べるので差は出ないが、区間として示す
      for (let k = 0; k < L.ncodon!; k++) { const c1 = mcols[3 * k], c2 = mcols[3 * k + 1], c3 = mcols[3 * k + 2]; if (EC[c1] === 6 || EC[c1] === 7 || EC[c2] === 6 || EC[c2] === 7 || EC[c3] === 6 || EC[c3] === 7) continue
        const a = rd(seq, c1), b = rd(seq, c2), d = rd(seq, c3); if (!a || !b || !d) continue
        if (shiftBefore[c1] !== 0) { EC[c1] = EC[c1] || 8; EC[c2] = EC[c2] || 8; EC[c3] = EC[c3] || 8; S.outOfFrame++; continue }
        const cr = a + b + d; const cc = CC(k); if (cr === cc) continue; const ar = translate(cr), ac = translate(cc); let e: number
        if (ar === ac) e = 1; else if (ar === '*') e = 3; else if (ac === '*') e = 4; else if (k === 0 && START_CODONS.has(cc) && !START_CODONS.has(cr)) e = 5; else e = 2
        if (e === 1) S.syn++; else if (e === 2) S.mis++; else if (e === 3) S.nonsense++; else if (e === 4) S.stopLost++; else if (e === 5) S.startLost++
        const ii: EffInfo = { k, cr, cc, ar, ac, e, gene: L.name!, eff: L.eff! }; for (const c of [c1, c2, c3]) if (rd(seq, c) !== rd(cmpSeq, c) || !rd(cmpSeq, c)) { EC[c] = e; EI.set(c, ii) } }
      const own: string[] = []; const ownCol: number[] = []; for (let i = startIdx; i < allCols.length; i++) { const c = allCols[i]; const b = rd(seq, c); if (b) { own.push(b); ownCol.push(c) } }
      let stopAt = -1; for (let j = 0; j + 2 < own.length; j += 3) { if (translate(own[j] + own[j + 1] + own[j + 2]) === '*') { stopAt = j / 3; break } }
      S.aaLen = stopAt >= 0 ? stopAt : Math.floor(own.length / 3)
      if (stopAt >= 0 && stopAt < L.ncodon! - 1) { const cs = [ownCol[3 * stopAt], ownCol[3 * stopAt + 1], ownCol[3 * stopAt + 2]]; if (EC[cs[0]] !== 3) { for (const c of cs) { EC[c] = 3; EI.set(c, { k: stopAt, cr: own[3 * stopAt] + own[3 * stopAt + 1] + own[3 * stopAt + 2], cc: CC(Math.min(L.ncodon! - 1, codonOfCol[c] >= 0 ? codonOfCol[c] : stopAt)), ar: '*', ac: '?', e: 3, gene: L.name!, eff: L.eff!, trunc: true }) } S.nonsense++ } }
      else if (stopAt < 0 && translate(CC(L.ncodon! - 1)) === '*' && shift !== 0) { const k = L.ncodon! - 1; for (const c of [mcols[3 * k], mcols[3 * k + 1], mcols[3 * k + 2]]) if (!EC[c]) { EC[c] = 4; EI.set(c, { k, cr: '', cc: CC(k), ar: '?', ac: '*', e: 4, gene: L.name!, eff: L.eff! }) } S.stopLost++ }
      S.fsNet = shift; S.trunc = S.aaLen != null && S.aaLen < 0.9 * L.ncodon!; S.lof = !!(S.startLost || S.stopLost || S.trunc || (S.fs && shift !== 0))
      L.rows.set(mi, S) })
  }
  return { code, info, loci, byGene, ms: Date.now() - t0 }
}
function ensureEffects(): EffResult | null {
  if (!base || !base.genes.length || !($('beff') as HTMLInputElement).checked) return null
  if (base.eff === undefined || base.eff === null) { try { base.eff = computeEffects(base) } catch (e) { console.warn('effects', e); base.eff = { code: new Map(), info: new Map(), loci: [], byGene: new Map(), ms: 0, error: String(e) } } }
  return base.eff
}
function closeBase() { if (!base) return; base = null; $('basegrp').style.display = 'none'; $('bscroll').style.display = 'none'; sendHover(null); draw(); if (cb.onVisible) loadRange() }
function sendHover(names: string[] | null) { const key = names ? names.join(',') : ''; if (key === lastHoverNodes) return; lastHoverNodes = key; cb.onHoverNodes?.(names) }
function baseGroups(cols: MsaCol[], rows: MsaRow[]): BGroup[] {
  const groups: BGroup[] = []
  cols.forEach((c, i) => { const last = groups[groups.length - 1]; if (last && last.g === c.g) last.to = i; else groups.push({ g: c.g, from: i, to: i, nodes: c.nodes, rb: c.rb, hasEll: false, n: 1, bp: 1, variant: false, foldable: false, x0: 0, x1: 0 }) })
  for (const gr of groups) { const cs = cols.slice(gr.from, gr.to + 1); const ell = cs.find(c => c.kind === 'ell'); gr.hasEll = !!ell; gr.n = gr.to - gr.from + 1; gr.bp = ell ? ((ell as any).bp || gr.n) : gr.n; gr.variant = cs.some(c => c.variant) || gr.nodes.length > 1; (gr as any).cp = !!(cs[0] as any).cp
    // 畳める群: 変異が無く、範囲の中にいる全行が持つ（'-' の行が無い）1 ノードの群
    gr.foldable = !gr.variant && gr.nodes.length === 1 && rows.every(r => { const ch = r.seq[gr.from]; return ch !== '-' && ch !== undefined }) }
  return groups
}
const foldOn = () => ($('bfold') as HTMLInputElement).checked
const baseGroupWidth = (gr: BGroup, z: number, gmin: number) => (foldOn() && gr.foldable) ? Math.min(FOLD_W, Math.max(gmin, z * gr.n)) : (z >= BASE_CELL_Z && !gr.hasEll) ? gr.n * Math.floor(z) : Math.max(gmin, z * gr.n)
function baseFitZ(groups: BGroup[], W: number) { let lo = 0, hi = 14; for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; let sum = 0; for (const gr of groups) sum += baseGroupWidth(gr, m, 1); if (sum <= W) lo = m; else hi = m } return lo }
// 配置: 見せる群（変異のある群だけ: 手動か、全群が 1 px ずつでも入らないときは自動）、z（無ければ画面に収まる最大）、項目（セルの列か 1 区画）、x 位置
function baseLayout(W: number) {
  const B = base!; const groups = B.groups; const bvar = ($('bvar') as HTMLInputElement).checked
  const varG = groups.filter(gr => gr.variant); const autoVar = !bvar && groups.length > W && varG.length <= W; const vOnly = bvar || autoVar; const shown = vOnly ? varG : groups
  let gmin = 1; let z = B.z; if (z == null) { z = baseFitZ(shown, W); if (shown.length * gmin > W) { z = 0; gmin = W / Math.max(1, shown.length) } }
  const cw = z >= BASE_CELL_Z ? Math.floor(z) : 0; const items: BItem[] = []
  for (const gr of shown) { if (cw && !gr.hasEll && !(foldOn() && gr.foldable)) { for (let i = gr.from; i <= gr.to; i++) items.push({ kind: 'col', ci: i, g: gr.g }) } else items.push({ kind: 'blk', ci0: gr.from, ci1: gr.to, n: gr.bp, g: gr.g, w: baseGroupWidth(gr, z, gmin) }) }
  const xs = new Float64Array(items.length + 1); let x = 0; const colItem = new Int32Array(B.cols.length).fill(-1)
  items.forEach((it, k) => { xs[k] = x; x += (it.kind === 'blk' ? it.w : cw); if (it.kind === 'col') colItem[it.ci] = k; else for (let i = it.ci0; i <= it.ci1; i++) colItem[i] = k }); xs[items.length] = x
  const gx = new Map<number, { x0: number; x1: number }>(); items.forEach((it, k) => { const e = gx.get(it.g) || { x0: xs[k], x1: xs[k + 1] }; e.x1 = xs[k + 1]; gx.set(it.g, e) }); for (const gr of groups) { const e = gx.get(gr.g); gr.x0 = e ? e.x0 : 0; gr.x1 = e ? e.x1 : 0 }
  B.items = items; B.xs = xs; B.colItem = colItem; B.cw = cw; B.zEff = z; B.fullW = x; B.vOnly = vOnly; B.autoVar = autoVar
  B.sx = Math.max(0, Math.min(B.sx, Math.max(0, B.fullW - W)))
  $('ztxt').textContent = (z >= BASE_LETTER_Z ? `${cw} px/塩基（文字）` : z >= BASE_CELL_Z ? `${cw} px/塩基` : z > 0 ? `俯瞰 ${z.toFixed(2)} px/塩基` : '俯瞰（群 1 px 未満）') + (vOnly ? (autoVar ? ' · 変異のある群だけ（自動）' : ' · 変異のある群だけ') : '') + ` · 列 ${fmt(B.cols.length)} ノード ${fmt(groups.length)}`
  ;($('zbase') as HTMLButtonElement).disabled = z >= BASE_LETTER_Z
}
// 比較の基準: 多数派（列ごとの最頻）か参照パスの行（無ければ先頭の行）
function baseCmpSeq(): { seq: string[] | string | null; row: number | null } {
  const B = base!
  if (($('cmp') as HTMLSelectElement).value === 'major') { if (!B.major) { const n = B.cols.length; const out = new Array<string>(n).fill('-'); for (let i = 0; i < n; i++) { const cnt = new Map<string, number>(); for (let mi = 0; mi < B.rows.length; mi++) { if ((B.rows[mi] as any).read) continue; const ch = (B.norm[mi] || B.rows[mi].seq)[i]; if (!ch || ch === '-' || ch === '~' || ch === '.') continue; cnt.set(ch, (cnt.get(ch) || 0) + 1) } let best = '-', bn = 0; for (const [ch, c] of cnt) if (c > bn) { bn = c; best = ch } out[i] = best } B.major = out } return { seq: B.major, row: null } }
  const rr = B.refRow != null ? B.rows[B.refRow] : null; return rr ? { seq: B.norm[B.refRow!] || rr.seq, row: B.refRow } : { seq: null, row: null }
}
const baseFontPx = (cw: number, h: number) => Math.max(0, Math.min(13, h - 2, Math.floor(cw / 0.62)))
// 区画（畳んだ群）の中でのこの行のアレル番号（0 ＝多数派、持たない行は −1）
function baseBlkAllele(it: { ci0: number; ci1: number }, mi: number): number {
  const B = base!; let e = B.blk.get(it.ci0)
  // アレルは株の行だけで数える（10-29）。リードは窓の途中で始まり終わるので、群の一部しか覆わない配列が別のアレル（青・橙）に見えていた。
  // リードの行は覆っている列だけを各アレルの代表の行と比べ、一致したアレルの番号、どれとも違えば −3（読み取りエラーか新しい配列）
  if (!e) { const isRd = (mi: number) => !!(B.rows[mi] as any).read; const sq = (mi: number) => B.norm[mi] || B.rows[mi].seq; const cnt = new Map<string, number>(); const rep = new Map<string, number>(); const keys: string[] = []
    for (let mi = 0; mi < B.rows.length; mi++) { const k = sq(mi).slice(it.ci0, it.ci1 + 1).replace(/[-.]/g, ''); keys.push(k); if (k && !isRd(mi)) { cnt.set(k, (cnt.get(k) || 0) + 1); if (!rep.has(k)) rep.set(k, mi) } }
    const order = [...cnt.entries()].sort((u, v) => v[1] - u[1] || (u[0] < v[0] ? -1 : 1)).map(([k]) => k); const idx = new Map(order.map((k, i) => [k, i]))
    const readAllele = (mi: number) => { const s = sq(mi); let cov = 0; let nb = 0; for (let i = it.ci0; i <= it.ci1; i++) if (s[i] && s[i] !== '.') { cov++; if (s[i] !== '-') nb++ } if (!cov || !nb) return -1   /* 覆っている所が全部欠失＝株の欠失と同じ（持たない） */
      for (let a = 0; a < order.length; a++) { const r = sq(rep.get(order[a])!); let ok = true; for (let i = it.ci0; i <= it.ci1 && ok; i++) { const ch = s[i]; if (ch && ch !== '.' && ch !== r[i]) ok = false } if (ok) return a } return -3 }
    e = { per: keys.map((k, mi) => (isRd(mi) ? readAllele(mi) : k ? idx.get(k)! : -1)), n: order.length, counts: order.map(k => cnt.get(k)!) }; B.blk.set(it.ci0, e) }
  return mi < e.per.length ? e.per[mi] : -1
}
const baseBlkCmp = (it: { ci0: number; ci1: number }) => { const c = baseCmpSeq(); return c.row != null ? baseBlkAllele(it, c.row) : 0 }
function baseItemAt(px: number): number | null { const xs = base!.xs; if (xs.length < 2 || px < xs[0] || px >= xs[xs.length - 1]) return null; let lo = 0, hi = xs.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m] <= px) lo = m; else hi = m - 1 } return lo }
function baseVisible(W: number): [number, number] { const B = base!; const xs = B.xs; const n = B.items.length; if (!n) return [0, -1]; let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m + 1] <= B.sx) lo = m + 1; else hi = m } const k0 = lo; hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < B.sx + W) lo = m + 1; else hi = m } return [k0, lo - 1] }
function baseSetZoom(z: number | null, anchorPx: number | null) {
  const B = base!; const W = bodyPx(); const ax = anchorPx != null ? anchorPx : W / 2; const k = baseItemAt(ax + B.sx); const ciBase = k != null ? (B.items[k].kind === 'col' ? (B.items[k] as any).ci : (B.items[k] as any).ci0) : Math.floor(B.cols.length / 2)
  B.z = z; baseLayout(W); const kk = B.colItem[ciBase]; if (kk >= 0) B.sx = Math.max(0, Math.min(B.xs[kk] - ax, Math.max(0, B.fullW - W))); draw()
}
function baseZoomStep(dir: number, anchorPx: number | null) {
  const z = base!.zEff; let nz: number | null
  if (dir > 0) { nz = Z_LADDER.find(v => v > z + 1e-9) ?? Z_LADDER[Z_LADDER.length - 1]; if (dir > 1) { const i = Z_LADDER.indexOf(nz); nz = Z_LADDER[Math.min(Z_LADDER.length - 1, i + dir - 1)] } }
  else { const below = Z_LADDER.filter(v => v < z - 1e-9); nz = below.length ? below[below.length - 1] : null }
  if (nz === z) return; baseSetZoom(nz, anchorPx)
}
function baseZoomToCols(i0: number, i1: number) { const B = base!; const W = bodyPx(); const groups = (B.vOnly ? B.groups.filter(gr => gr.variant) : B.groups).filter(gr => gr.to >= i0 && gr.from <= i1); if (!groups.length) return; let z = baseFitZ(groups, W); if (z >= BASE_LETTER_Z) z = Math.min(14, Math.floor(z)); else if (z >= BASE_CELL_Z) z = Math.floor(z); B.z = z; baseLayout(W); const k = B.colItem[i0]; if (k >= 0) B.sx = Math.max(0, Math.min(B.xs[k], Math.max(0, B.fullW - W))); draw() }
let baseVisKey = ''
function baseEmitVisible(W: number) {
  if (!(cb.onVisible || cb.onRange) || !base || !($('sync') as HTMLInputElement).checked) return
  const [k0, k1] = baseVisible(W); if (k1 < k0) return; const set = new Set<string>(); for (let k = k0; k <= k1; k++) { const it = base.items[k]; const c = base.cols[it.kind === 'col' ? it.ci : it.ci0]; for (const n of (c.nodes || [])) set.add(n) }
  let names = [...set]; if (names.length > 600) { const step = names.length / 600; names = Array.from({ length: 600 }, (_, i) => names[Math.floor(i * step)]) }
  const key = `${k0}:${k1}:${names.length}`; if (key === baseVisKey) return; baseVisKey = key; if (cb.onRange) cb.onRange({ names, colors: null, fit: false, hide: false }); else cb.onVisible?.({ names, sync: true })
}
// 要約の 1 行: 灰の棒＝深さ（塩基を持つリード。サンプルの最大で正規化）、色＝基準と違う塩基の割合（最も多い違う文字の色。2 割未満は薄く）、
// 黒＝欠失の割合（その列に塩基を持つリードもいるときだけ。棒の上に積む）
function drawReadCov(B: BaseState, sm: string, y: number, h: number, k0: number, k1: number, letters: boolean) {
  const C = readCov(B, sm); let mx = 1; for (let i = 0; i < C.dep.length; i++) if (C.dep[i] > mx) mx = C.dep[i]
  for (let kk = k0; kk <= k1; kk++) { const it = B.items[kk]; const x = B.xs[kk], w = Math.max(1, B.xs[kk + 1] - B.xs[kk] - (B.cw >= 8 ? 1 : 0)); const i0 = it.kind === 'col' ? it.ci : it.ci0, i1 = it.kind === 'col' ? it.ci : it.ci1
    let d = 0, m = 0, ch = '', dl = 0; for (let i = i0; i <= i1; i++) { if (C.dep[i] > d) d = C.dep[i]; if (C.dep[i] && C.del[i] > dl) dl = C.del[i]; if (C.dep[i] && C.mis[i] / C.dep[i] > (m && d ? m / d : 0)) { m = C.mis[i]; ch = C.top[i] } }
    if (!d) continue; const bh = Math.max(1, h * d / mx); g.fillStyle = '#c3ccd5'; g.fillRect(x, y + h - bh, w, bh)
    if (dl) { const fd = dl / (d + dl); g.globalAlpha = fd >= 0.2 ? 1 : 0.35; g.fillStyle = '#222'; g.fillRect(x, y + h - bh - Math.max(1, h * fd * 0.5), w, Math.max(1, h * fd * 0.5)); g.globalAlpha = 1 }
    if (m) { const f = m / d; const col = BASE_COLORS[ch.toUpperCase()] || BASE_COLORS.N; g.globalAlpha = f >= 0.2 ? 1 : 0.35; g.fillStyle = col[1]; g.fillRect(x, y + h - bh, w, Math.max(1, bh * f)); g.globalAlpha = 1
      if (letters && f >= 0.2) { g.fillStyle = col[0]; g.fillText(ch, x + w / 2, y + h / 2 + 1) } } }
}
// リードの行（10-29）: 展開＝1 本 1 行、詰める＝サンプルごとに列の範囲が重ならないリードを同じ行へ（貪欲、間は 4 列空ける）、要約＝サンプルごとに 1 行
function readSpan(B: BaseState, mi: number): [number, number] { const sq = B.rows[mi].seq; let a = 0, b = sq.length - 1; while (a <= b && sq[a] === '.') a++; while (b >= a && sq[b] === '.') b--; return [a, b] }
function readLines(B: BaseState, mis: number[]): BaseState['lines'] {
  const bySamp = new Map<string, number[]>(); for (const mi of mis) { const sm = (B.rows[mi] as any).read.sample; if (!bySamp.has(sm)) bySamp.set(sm, []); bySamp.get(sm)!.push(mi) }
  const packOf = (lst: number[]) => { const lanes: { end: number; mis: number[] }[] = []; for (const mi of lst) { const [a, b] = readSpan(B, mi); const ln = lanes.find(l => l.end + 4 < a); if (ln) { ln.mis.push(mi); ln.end = b } else lanes.push({ end: b, mis: [mi] }) } return lanes.map(l => l.mis) }
  const packed = [...bySamp.values()].map(packOf); const nPack = packed.reduce((t, l) => t + l.length, 0)
  let mode = ($('bmode') as HTMLSelectElement | null)?.value || 'auto'
  if (mode === 'auto') mode = nPack > 120 ? 'cov' : nPack <= 0.7 * mis.length ? 'pack' : 'expand'
  B.readMode = mode
  if (mode === 'cov') return [...bySamp.keys()].map(sm => ({ hid: -1, mi: bySamp.get(sm)![0], cov: sm }))
  if (mode === 'pack') return packed.flatMap(lanes => lanes.map(l => ({ hid: -1, mi: l[0], pack: l })))
  return mis.map(mi => ({ hid: -1, mi }))
}
// 要約の集計: サンプルの全リードについて、列ごとの深さ（塩基を持つリード）・基準と違う塩基の数と最も多い文字・欠失（-）の数。
// 欠失は「その列に塩基を持つリードがいる」ときだけ意味がある（リードの範囲の内側でも、株に無い経路を通って列を持たないだけのことが多い）
function readCov(B: BaseState, sm: string) {
  const cmp = baseCmpSeq(); const key = sm + '|' + (cmp.row ?? 'major'); if (!B.covCache) B.covCache = new Map(); const hit = B.covCache.get(key); if (hit) return hit
  const n = B.cols.length; const dep = new Uint16Array(n), mis = new Uint16Array(n), del = new Uint16Array(n); const cnt: Map<string, number>[] = new Array(n); let nr = 0
  B.rows.forEach((r, mi) => { const rd = (r as any).read; if (!rd || rd.sample !== sm) return; nr++; const sq = B.norm[mi] || r.seq; const [a, b] = readSpan(B, mi)
    for (let i = a; i <= b; i++) { const ch = sq[i]; if (!ch || ch === '.' || ch === '~') continue; if (ch === '-') { del[i]++; continue } dep[i]++; const ref = cmp.seq ? cmp.seq[i] : null; if (ref && ref !== '-' && ch !== ref) { mis[i]++; if (!cnt[i]) cnt[i] = new Map(); cnt[i].set(ch, (cnt[i].get(ch) || 0) + 1) } } })
  const top = Array.from({ length: n }, (_, i) => { const m = cnt[i]; if (!m) return ''; let best = '', bn = 0; for (const [ch, c] of m) if (c > bn) { bn = c; best = ch } return best })
  const res = { dep, mis, del, top, n: nr }; B.covCache.set(key, res); return res
}
function readItemSpan(B: BaseState, mi: number, k0: number, k1: number): [number, number] { const [a, b] = readSpan(B, mi); if (b < a) return [1, 0]; return [Math.max(k0, B.colItem[a]), Math.min(k1, B.colItem[b])] }
// 描画（塩基の段）: 上段＝ノードの箱と基準の配列、行＝通過（木の順、同じ株の ·2 は続けて）、セル＝塩基（基準と同じなら ·）、区画＝アレル色
function drawBaseCore() {
  const B = base!; const W = cv.parentElement!.clientWidth; const gOn = B.genes.length > 0 && showGenes(); const AH = annH(B); TOP = (gOn ? 70 + OGH + 2 : 70) + AH; ROW = gOn ? 19 : 15
  B.lines = []; for (const hid of hapOrder) for (const mi of (B.rowsOf.get(hid) || [])) B.lines.push({ hid, mi })
  { const rr = B.rows.map((r, mi) => ({ r, mi })).filter(e => (e.r as any).read); const first = (sq: string) => { for (let i = 0; i < sq.length; i++) if (sq[i] !== '.' && sq[i] !== '-') return i; return 1e9 }
    rr.sort((a, b) => ((a.r as any).read.sample < (b.r as any).read.sample ? -1 : (a.r as any).read.sample > (b.r as any).read.sample ? 1 : 0) || first(a.r.seq) - first(b.r.seq))
    if (($('breads') as HTMLInputElement | null)?.checked !== false && rr.length) B.lines.push(...readLines(B, rr.map(e => e.mi))) }   // リード（10-28）: 株の行の下に、サンプル・開始位置の順。10-29: 展開・詰める・要約
  if (B.sortCi.length) {   // 選んだサイトの塩基で並べ替え（複数なら先のサイトを優先。塩基の順は A, C, G, T, その他, 欠け。木の順を基準に安定）
    const rank = (ch: string | undefined) => ch === 'A' ? 0 : ch === 'C' ? 1 : ch === 'G' ? 2 : ch === 'T' ? 3 : (!ch || ch === '-' || ch === '.' || ch === '~') ? 5 : 4
    B.lines = B.lines.map((ln, k) => ({ ln, k })).sort((p, q) => { for (const ci of B.sortCi) { const d = rank((B.norm[p.ln.mi] || B.rows[p.ln.mi].seq)[ci]?.toUpperCase()) - rank((B.norm[q.ln.mi] || B.rows[q.ln.mi].seq)[ci]?.toUpperCase()); if (d) return d } return p.k - q.k }).map(e => e.ln)
  }
  rowTop = B.lines.map((_, k) => TOP + k * ROW); rowHgt = B.lines.map(() => ROW); const H = TOP + B.lines.length * ROW + 20
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ov.width = cv.width; ov.height = cv.height; ov.style.width = cv.style.width; ov.style.height = cv.style.height; og.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, W, H)
  const Wb = W - LAB - 4; baseLayout(Wb)
  const cmp = baseCmpSeq(); const cw = B.cw; const [k0, k1] = baseVisible(Wb)
  g.fillStyle = '#666'; g.font = '10px system-ui'; g.fillText(`塩基の段 ${B.label} · 行 ${B.lines.length}（通過）· 基準 ${cmp.row != null ? ('参照 ' + B.rows[cmp.row].label) : '多数派'}` + (B.sortCi.length ? ` · 並べ替え: サイト ${B.sortCi.map(ci => (B.cols[ci].nodes || [])[0] || ci).join(', ')}（列見出しのクリックで追加／解除）` : ' · 列見出しのクリック＝そのサイトで並べ替え'), LAB + 2, TOP - 2)
  g.save(); g.beginPath(); g.rect(LAB, 0, W - LAB, H); g.clip(); g.translate(LAB - B.sx, 0)
  // 上段: ノードの箱（8..24）、基準の配列（26..52）、底の印（54..57）
  B.groups.forEach((gr, k) => { if (gr.x1 <= gr.x0 || gr.x1 < B.sx || gr.x0 > B.sx + Wb) return; const w = gr.x1 - gr.x0; const folded = foldOn() && gr.foldable && B.zEff * gr.n > w + 1; g.fillStyle = (gr as any).cp ? '#fbe3c4' : folded ? '#d8e0e6' : (k % 2 ? '#e7ecf0' : '#eef2f5'); g.fillRect(gr.x0, 8, w, 16); g.fillStyle = '#d3dbe1'; g.fillRect(gr.x0, 8, 1, 16); g.fillRect(gr.x1 - 1, 8, 1, 16)
    if (folded && w >= 10) { g.fillStyle = '#64707c'; g.font = '9px system-ui'; g.textAlign = 'center'; g.fillText('≡', gr.x0 + w / 2, 19); g.textAlign = 'left' }   // 畳んだ群
    if (gr.nodes.length > 1) { g.fillStyle = '#0d9488'; g.fillRect(gr.x0, 8, w, 3) }
    const nm = ((gr as any).cp ? '↻' : '') + gr.nodes[0] + (gr.nodes.length > 1 ? '+' + (gr.nodes.length - 1) : ''); const bp = fmt(gr.bp) + ' bp'; const label = w >= 118 ? `${nm} · ${bp}` : (w >= 62 ? nm : (w >= 40 ? bp : ''))
    if (label) { g.fillStyle = '#1b2530'; g.font = '10px ui-monospace, monospace'; g.textAlign = 'left'; g.fillText(label, gr.x0 + 4, 20) }
    if (gr.rb) { g.fillStyle = '#0d9488'; g.fillRect(gr.x0, 54, w, 2) }
    if (gr.variant) { g.fillStyle = '#d98200'; g.fillRect(gr.x0 + 1, 56, Math.max(1, w - 2), 3) } })
  for (const ci of B.sortCi) { const k = B.colItem[ci]; if (k < 0) continue; const x = B.xs[k], w = Math.max(2, B.xs[k + 1] - B.xs[k]); g.fillStyle = 'rgba(255,20,147,.9)'; g.fillRect(x, 4, w, 3); g.beginPath(); g.moveTo(x + w / 2 - 4, 0); g.lineTo(x + w / 2 + 4, 0); g.lineTo(x + w / 2, 5); g.fill() }   // 並べ替えに使うサイト（マゼンタ）
  if (cmp.seq) { const y = 26, h = 26; const fpx = baseFontPx(cw, h); g.font = `bold ${fpx}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'
    for (let k = k0; k <= k1; k++) { const it = B.items[k]; const x = B.xs[k], w = B.xs[k + 1] - B.xs[k] - (cw >= 8 ? 1 : 0)
      if (it.kind === 'blk') { const a = baseBlkCmp(it); g.fillStyle = a >= 0 ? SITES_COLORS[Math.min(a, SITES_COLORS.length - 1)] : '#eef2f5'; g.fillRect(x, y + 1, w, h - 2); if (w >= 26) { g.fillStyle = a >= 0 ? '#fff' : '#64707c'; g.font = `bold ${Math.min(fpx, 10)}px ui-monospace, monospace`; g.fillText(fmtBpShort(it.n), x + w / 2, y + h / 2 + 1); g.font = `bold ${fpx}px ui-monospace, monospace` } continue }
      const ch = cmp.seq[it.ci]; if (!ch || ch === '-' || ch === '.') { g.fillStyle = '#eef2f5'; g.fillRect(x, y + 1, w, h - 2); continue } if (ch === '~') { g.fillStyle = '#d3dbe1'; g.fillRect(x, y + 1, w, h - 2); continue }
      const col = BASE_COLORS[ch.toUpperCase()] || BASE_COLORS.N; g.fillStyle = col[1]; g.fillRect(x, y, w, h); if (cw >= 5 && fpx >= 8) { g.fillStyle = col[0]; g.fillText(ch, x + w / 2, y + h / 2 + 1) } }
    g.textBaseline = 'alphabetic'; g.textAlign = 'left' }
  // 行
  const hcell = gOn ? 13 : ROW - 2; const fpx = baseFontPx(cw, hcell); const letters = cw >= 5 && fpx >= 8; const diff = ($('bdiff') as HTMLInputElement).checked; const BE = gOn ? ensureEffects() : null
  B.lines.forEach((ln, k) => { const y = TOP + k * ROW + 1, h = hcell
    g.fillStyle = k % 2 ? 'rgba(0,0,0,.03)' : 'rgba(0,0,0,0)'; g.fillRect(B.sx, y - 1, Wb, ROW)
    g.font = `bold ${fpx}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'
    if (ln.cov) { drawReadCov(B, ln.cov, y, h, k0, k1, letters); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; return }
    for (const mi of (ln.pack || [ln.mi])) { const row = B.rows[mi]; const inv = B.inv[mi]; const nseq = B.norm[mi] || row.seq; const [ka, kb] = ln.pack ? readItemSpan(B, mi, k0, k1) : [k0, k1]; if (kb < ka) continue
    for (let kk = ka; kk <= kb; kk++) { const it = B.items[kk]; const x = B.xs[kk], w = B.xs[kk + 1] - B.xs[kk] - (cw >= 8 ? 1 : 0)
      if (it.kind === 'blk') { const a = baseBlkAllele(it, mi); if (a === -3) { g.fillStyle = '#f4cccc'; g.fillRect(x, y + 1, w, h - 2); continue } if (a < 0) continue; const same = diff && baseBlkCmp(it) === a; g.fillStyle = same ? '#e7ecf0' : SITES_COLORS[Math.min(a, SITES_COLORS.length - 1)]; g.fillRect(x, y + 1, w, h - 2)
        if (inv.size) for (let i = it.ci0; i <= it.ci1; i++) if (inv.has(i)) { g.fillStyle = '#7c3aed'; g.fillRect(x, y, w, 2); break } continue }
      const ch = nseq[it.ci]; if (ch === '-' || ch === undefined) continue
      if (ch === '.') { g.fillStyle = '#e7ecf0'; g.fillRect(x + Math.max(0, w / 2 - 1), y + h / 2 - 1, Math.min(2, w), 2); continue }
      if (ch === '~') { g.fillStyle = '#d3dbe1'; g.fillRect(x, y + 2, w, h - 4); continue }
      if (diff && cmp.seq && cmp.seq[it.ci] === ch) { const isInv = inv.has(it.ci); g.fillStyle = isInv ? '#e4dbf7' : '#e7ecf0'; g.fillRect(x, y, w, h); if (letters) { g.fillStyle = isInv ? '#7c3aed' : '#64707c'; g.fillText('·', x + w / 2, y + h / 2 + 1) } if (isInv) { g.fillStyle = '#7c3aed'; g.fillRect(x, y, w, 2) } continue }   // 逆向きに通った同じノード＝一致だが紫の帯で逆位と示す
      const col = BASE_COLORS[ch.toUpperCase()] || BASE_COLORS.N; g.fillStyle = col[1]; g.fillRect(x, y, w, h); if (letters) { g.fillStyle = col[0]; g.fillText(ch, x + w / 2, y + h / 2 + 1) }
      if (inv.has(it.ci)) { g.fillStyle = '#7c3aed'; g.fillRect(x, y, w, 2) } }
    for (const b of (B.brk[mi] || [])) { const kk = B.colItem[b.ci]; if (kk < 0) continue; const x = B.xs[kk]; if (x < B.sx - 2 || x > B.sx + Wb + 2) continue; g.fillStyle = '#111'; g.fillRect(x - 1, y - 1, 2, h + 2) }   // 継ぎ目（同じコンティグの離れた範囲を繋いだ所）
    for (const [ci, side, isq, lab] of ((row as any).rins || []) as [number, number, string, string?][]) { const x = baseInsX(ci, side); if (x == null || x < B.sx - 4 || x > B.sx + Wb + 4) continue; const lw = isq.length >= 10 ? 3 : 2; g.fillStyle = lab ? '#d35400' : '#e11d74'; g.fillRect(x - lw / 2, y - 1, lw, h + 2); g.beginPath(); g.moveTo(x - 3.5, y - 1); g.lineTo(x + 3.5, y - 1); g.lineTo(x, y + 3); g.fill() }   // リードだけの挿入（10-29。列が無いので列の境界に印。太い＝10 bp 以上）
    const EC = BE ? BE.code.get(mi) : null; if (EC) for (let kk = ka; kk <= kb; kk++) { const it = B.items[kk]; const ec = it.kind === 'col' ? EC[it.ci] : effMaxIn(EC, it.ci0, it.ci1); if (!ec) continue; g.fillStyle = EFF_COL[ec]; g.fillRect(B.xs[kk], y + h - (ec === 8 ? 1 : 3), Math.max(1, B.xs[kk + 1] - B.xs[kk] - (cw >= 8 ? 1 : 0)), ec === 8 ? 1 : 3) }   // 変異の効果（下辺。その行の遺伝子帯のすぐ上に。10-28: 上辺だと上の行の遺伝子帯と組に見えた）
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic' })
  // 遺伝子: 見出しのトラック（遺伝子ごとに矢印、CDS の列は濃く）と、行の下の帯（その株の遺伝子: CDS 濃い・エキソン薄い・他は細い線）
  if (gOn) {
    const y0 = 58 + AH; const xOfCol = (ci: number): [number, number] | null => { const kk = B.colItem[ci]; if (kk < 0) return null; return [B.xs[kk], B.xs[kk + 1]] }
    const span = (bg: BGene): [number, number] | null => { let lo = Infinity, hi = -Infinity; for (let ci = bg.c0; ci <= bg.c1; ci++) { if (!bg.cols[ci]) continue; const r = xOfCol(ci); if (!r) continue; if (r[0] < lo) lo = r[0]; if (r[1] > hi) hi = r[1] } return hi > lo ? [lo, hi] : null }
    g.fillStyle = '#f3f6f7'; g.fillRect(B.sx, y0, Wb, OGH)
    const seen = new Set<number>()
    for (const bg of B.genes) { if (seen.has(bg.g.gid)) continue; seen.add(bg.g.gid); const sp = span(bg); if (!sp || sp[1] < B.sx || sp[0] > B.sx + Wb) continue; const col = geneColor(bg.g); const right = bg.g.fwd
      g.fillStyle = col; g.globalAlpha = .45; g.fillRect(sp[0], y0 + 3, sp[1] - sp[0], OGH - 6); g.globalAlpha = 1
      for (let ci = bg.c0; ci <= bg.c1; ci++) { if (bg.kindOf[ci] !== 1 && bg.kindOf[ci] !== 2) continue; const r = xOfCol(ci); if (!r) continue; g.fillStyle = col; g.globalAlpha = bg.kindOf[ci] === 1 ? 1 : .7; g.fillRect(r[0], y0 + (bg.kindOf[ci] === 1 ? 1 : 4), Math.max(1, r[1] - r[0]), bg.kindOf[ci] === 1 ? OGH - 2 : OGH - 8); g.globalAlpha = 1 }
      const w = sp[1] - sp[0]; if (w >= 10) { g.fillStyle = '#fff'; g.beginPath(); if (right) { g.moveTo(sp[1] - 5, y0 + 2); g.lineTo(sp[1] - 1, y0 + OGH / 2); g.lineTo(sp[1] - 5, y0 + OGH - 2) } else { g.moveTo(sp[0] + 5, y0 + 2); g.lineTo(sp[0] + 1, y0 + OGH / 2); g.lineTo(sp[0] + 5, y0 + OGH - 2) } g.fill() }
      const nm = bg.g.name || bg.g.locus || ''; g.font = '9px system-ui'; const tw = g.measureText(nm).width; if (nm && w >= tw + 12) { g.fillStyle = '#111'; g.fillText(nm, sp[0] + (right ? 3 : 7), y0 + OGH - 4) } }
    B.lines.forEach((ln, k) => { const gs = B.genesByHid.get(ln.hid); if (!gs) return; const y = TOP + k * ROW + ROW - 4
      // 1 つの区画（畳んだ群・俯瞰の群）に複数の列が入るので、区画ごとに 1 回だけ、区画の中で最も強い種類（CDS > エキソン > イントロン）で描く
      // （10-28: 列ごとに同じ区画を重ね塗りしていたので、変異の無い群＝区画だけ濃く（以前は太く）見えた）
      for (const bg of gs) { const col = geneColor(bg.g); const best = new Map<number, number>()
        for (let ci = bg.c0; ci <= bg.c1; ci++) { if (!bg.cols[ci]) continue; const kk = B.colItem[ci]; if (kk < 0) continue; const kd = bg.kindOf[ci] || 3; const cur = best.get(kk); if (cur == null || kd < cur) best.set(kk, kd) }
        for (const [kk, kd] of best) { const x0 = B.xs[kk], x1 = B.xs[kk + 1]; if (x1 < B.sx || x0 > B.sx + Wb) continue
          g.fillStyle = col; g.globalAlpha = kd === 1 ? 1 : kd === 2 ? .55 : .25; g.fillRect(x0, y + (kd === 1 ? 0 : kd === 2 ? .5 : 1), Math.max(1, x1 - x0), kd === 1 ? 3 : kd === 2 ? 2 : 1) } }   // CDS 3 px・エキソン 2 px・イントロン 1 px
      g.globalAlpha = 1 })
  }
  if (AH && B.ann) { const A = B.ann; const y0 = 58   // 注釈の帯: 反復（種類の色）、GIAB のサンプルごとの行（ベンチマーク領域の外は灰、ヘテロ＝橙・ホモ＝赤）
    for (let kk = k0; kk <= k1; kk++) { const it = B.items[kk]; const x = B.xs[kk], w = Math.max(1, B.xs[kk + 1] - B.xs[kk] - (cw >= 8 ? 1 : 0)); const c0 = it.kind === 'col' ? it.ci : it.ci0, c1 = it.kind === 'col' ? it.ci : it.ci1
      let rk = -1; for (let ci = c0; ci <= c1 && rk < 0; ci++) rk = A.rep[ci]; if (rk >= 0) { g.fillStyle = repColor(A.reps[rk].cls); g.globalAlpha = .85; g.fillRect(x, y0 + 1, w, ANN_REP_H - 2); g.globalAlpha = 1 }
      A.samples.forEach((sm, si) => { const yy = y0 + ANN_REP_H + si * ANN_VAR_H; let inb = 0, v: any = null; const m = A.varAt.get(sm)!; const ib = A.inBench.get(sm)!; let anyRef = false
        for (let ci = c0; ci <= c1; ci++) { if (A.refPos[ci] >= 0) anyRef = true; if (ib[ci]) inb = 1; if (!v) v = m.get(ci) || null }
        if (!anyRef) return; g.fillStyle = inb ? '#edf5ee' : '#dee2e6'; g.fillRect(x, yy + 1, w, ANN_VAR_H - 2)
        if (v) { const hom = /^1[/|]1$/.test(v.gt); g.fillStyle = hom ? '#c2255c' : '#f08c00'; g.fillRect(x, yy + (v.first ? 0 : 2), Math.max(2, w), v.first ? ANN_VAR_H : ANN_VAR_H - 4) } }) } }
  if (B.hoverCi != null && B.colItem[B.hoverCi] >= 0) { const kk = B.colItem[B.hoverCi]; g.fillStyle = 'rgba(13,148,136,.10)'; g.fillRect(B.xs[kk], 0, B.xs[kk + 1] - B.xs[kk], H) }
  g.restore()
  if (AH && B.ann) { g.font = '9px system-ui'; g.fillStyle = '#495057'; g.textAlign = 'right'; g.fillText('反復（RepeatMasker）', LAB - 4, 58 + ANN_REP_H - 2)
    B.ann.samples.forEach((sm, si) => g.fillText(`GIAB ${sm}`, LAB - 4, 58 + ANN_REP_H + si * ANN_VAR_H + ANN_VAR_H - 1)); g.textAlign = 'left' }
  // 行ラベル・木
  B.lines.forEach((ln, k) => { const y = TOP + k * ROW; const row = B.rows[ln.mi]; const grp = ln.hid >= 0 ? groupOf.get(ln.hid) : undefined; const mk = ln.hid >= 0 ? markOf(root!.haps[ln.hid].hap) : undefined; const rdi = (row as any).read; if (mk) { g.fillStyle = mk; g.beginPath(); g.arc(TREEW + 7, y + 7, 3.5, 0, Math.PI * 2); g.fill() } g.fillStyle = rdi ? '#1c6e8c' : row.isref ? '#7a4b00' : '#333'; g.font = rdi ? '10px system-ui' : '11px system-ui'; g.fillText(ln.cov ? `▸${rdi.sample} 要約（${readCov(B, rdi.sample).n} 本）` : ln.pack && ln.pack.length > 1 ? `▸${rdi.sample} 詰め ${ln.pack.length} 本` : rdi ? `${row.label}  q${rdi.mapq ?? '?'}${rdi.nins ? ` +${rdi.nins}ins` : ''}  ${row.strand}` : `${row.label}${grp && grp.length > 1 ? ` +${grp.length - 1}` : ''}  ${row.strand}`, TREEW + (mk ? 13 : 4), y + 10) })
  const rowOf = new Map<number, number>(); B.lines.forEach((ln, k) => { if (!rowOf.has(ln.hid)) rowOf.set(ln.hid, k) })
  drawTree(rowOf)
  baseScrollSync(Wb)
  baseEmitVisible(Wb)
}
// 横スクロールバー（本物の DOM。掴んで大きく動かせる）: 内側の幅＝全体の幅＋ラベル欄、scrollLeft ＝ sx
function baseScrollSync(Wb: number) {
  const el = $('bscroll'); const B = base; const on = !!B && B.fullW > Wb; el.style.display = on ? 'block' : 'none'
  if (on && B) { el.style.marginLeft = LAB + 'px'; el.style.width = `calc(100% - ${LAB}px)`; (el.firstElementChild as HTMLElement).style.width = (B.fullW + 4) + 'px'; if (Math.abs(el.scrollLeft - B.sx) > 0.5) el.scrollLeft = B.sx }   // 木とラベルの欄には掛けない
}
$('bscroll').addEventListener('scroll', () => { const el = $('bscroll'); if (base && Math.abs(el.scrollLeft - base.sx) > 0.5) { base.sx = Math.max(0, Math.min(el.scrollLeft, Math.max(0, base.fullW - bodyPx() + 4))); draw() } })
const fmtBpShort = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
// ---- 表示範囲の木（UPGMA）: ブロックごとの状態（無し/順/逆/両方）の bp 重み不一致率 ----
function treeOrder(): number[] {
  treeRoot = null
  if (!root || !blocks.length) return baseOrder.slice()
  const H = root.haps.length, nb = blocks.length
  const ids = baseOrder.slice(); const n = ids.length; const D: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  if (base) {   // 塩基の段: 変異のある列（行で塩基が違う列）の塩基の不一致率（ハミング）。株の代表は最初の行。両方が塩基を持つ列だけ数える
    // 向き（10-27）: 逆向きに通った列（inv）も「塩基が違う」と同じく 1 列として数える（逆位の株どうしがまとまるように）。対象の列＝変異のある列 ∪ どれかの行が逆向きの列
    const B = base; const anyInv = new Uint8Array(B.cols.length); for (const st of B.inv) for (const c of st) anyInv[c] = 1
    const vcols: number[] = []; for (let c = 0; c < B.cols.length; c++) if (B.cols[c].variant || anyInv[c]) vcols.push(c)
    const miOf = (hid: number): number => { const ms = B.rowsOf.get(hid); return ms && ms.length ? ms[0] : -1 }
    const mis = ids.map(miOf)
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const mi = mis[i], mj = mis[j]; if (mi < 0 || mj < 0) { D[i][j] = D[j][i] = 1; continue }
      const a = B.norm[mi] || B.rows[mi].seq, b = B.norm[mj] || B.rows[mj].seq, ia = B.inv[mi], ib = B.inv[mj]; let diff = 0, both = 0
      for (const c of vcols) { const x = a[c], y = b[c]; if (!x || !y || x === '-' || y === '-' || x === '.' || y === '.' || x === '~' || y === '~') continue; both++; if (x !== y || ia.has(c) !== ib.has(c)) diff++ } D[i][j] = D[j][i] = both ? diff / both : 1 }
  } else if (cols && wantCols()) {   // 錨の列の段: ハプロタイプごとの列のアレル番号（複数の通過は先のもの）。距離＝両方が持つ列のうちアレルが違う列の割合
    // 向き（10-27）: 列の状態＝アレル番号 ＋ 向き（その通過がコンティグの主な向きと逆なら +1000）。同じ株の複数の通過は、その列の錨が多い方を採る
    // （以前は先の通過。逆位の片と両側の通過が同じ列に掛かると、錨の無い両側の方を拾って逆位が消えた）
    const C = cols; const st = new Int16Array(H * C.ncol).fill(-1); const bestP = new Uint8Array(H * C.ncol)
    const domC = new Map<number, number>(); for (const r of rows) domC.set(r.pid, (domC.get(r.pid) || 0) + r.dir * r.nanch)
    for (const r of C.rows) { const base = r.hid * C.ncol; const invd = ((domC.get(r.pid) ?? r.dir) >= 0 ? 1 : -1) !== (r.dir >= 0 ? 1 : -1)
      for (let c = 0; c < C.ncol; c++) { const k = r.cls[c]; if (k === 255) continue; if (st[base + c] < 0 || r.pres[c] > bestP[base + c]) { st[base + c] = k + (invd ? 1000 : 0); bestP[base + c] = r.pres[c] } } }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let diff = 0, both = 0; const bi = ids[i] * C.ncol, bj = ids[j] * C.ncol; for (let c = 0; c < C.ncol; c++) { const a = st[bi + c], b = st[bj + c]; if (a >= 0 && b >= 0) { both++; if (a !== b) diff++ } } D[i][j] = D[j][i] = both ? diff / both : 1 }
  } else {   // ブロックの段: ブロックごとの状態（無し/順/逆/両方）の bp 重み不一致率
    const state = new Uint8Array(H * nb)
    const dom = new Map<number, number>(); for (const r of rows) dom.set(r.pid, (dom.get(r.pid) || 0) + r.dir * r.nanch)
    for (const r of rows) { const d = (dom.get(r.pid) || 0) >= 0 ? r.dir : -r.dir; for (let bi = blockAt(r.x0); bi < nb && blocks[bi].x0 <= r.x1; bi++) { const k = r.hid * nb + bi; const nv = d >= 0 ? 1 : 2; state[k] = state[k] === 0 ? nv : (state[k] === nv ? nv : 3) } }
    const w = blocks.map(b => Math.max(1, b.bp)); const wsum = w.reduce((a, b) => a + b, 0)
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let dsum = 0; for (let k = 0; k < nb; k++) { const a = state[ids[i] * nb + k], b = state[ids[j] * nb + k]; if (a !== b) dsum += w[k] * (a === 0 || b === 0 ? 1 : 0.5) } D[i][j] = D[j][i] = dsum / wsum }
  }
  let clusters: Clade[] = ids.map((_, i) => ({ leaves: [i], size: 1, h: 0, kids: [] })); let dist = D.map(r => r.slice())
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity; for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) if (dist[i][j] < bd) { bd = dist[i][j]; bi = i; bj = j }
    const A = clusters[bi], B = clusters[bj]; const merged: Clade = { leaves: A.leaves.concat(B.leaves), size: A.size + B.size, h: bd, kids: [A, B] }
    const nd: number[] = []; for (let k = 0; k < clusters.length; k++) if (k !== bi && k !== bj) nd.push((dist[bi][k] * A.size + dist[bj][k] * B.size) / (A.size + B.size))
    clusters = clusters.filter((_, k) => k !== bi && k !== bj); dist = dist.filter((_, k) => k !== bi && k !== bj).map(r => r.filter((_, k) => k !== bi && k !== bj))
    clusters.push(merged); for (let k = 0; k < dist.length; k++) dist[k].push(nd[k]); dist.push(nd.concat([0]))
  }
  treeRoot = clusters[0]; const mapLeaf = (c: Clade) => { c.leaves = c.leaves.map(i => ids[i]); c.kids.forEach(mapLeaf) }; mapLeaf(treeRoot)
  // 系統樹のまとめ: 併合の高さが閾値以下の枝（最上位のもの）を代表 1 株に。代表＝枝の中で他との距離の和が最小の株
  groupOf = new Map()
  if (treeCut == null) return treeRoot.leaves
  const idxOf = new Map(ids.map((h, i) => [h, i])); const cutH = treeCut * Math.max(1e-9, treeRoot.h); const reps: number[] = []
  const visit = (c: Clade) => {
    if (!c.kids.length || c.h <= cutH) {
      let rep = c.leaves[0]
      if (c.leaves.length > 1) { const cand = c.leaves.filter(h => (perHap[h] || 0) > 0); const pool = cand.length ? cand : c.leaves; rep = pool[0]; let best = Infinity; for (const a of pool) { let sum = 0; for (const b of c.leaves) sum += D[idxOf.get(a)!][idxOf.get(b)!]; if (sum < best) { best = sum; rep = a } } }   // 代表はこの範囲に通過を持つ株から（持たない株が代表になると行が空）
      c.rep = rep; c.collapsed = c.leaves.length > 1; reps.push(rep); groupOf.set(rep, c.leaves.slice())
    } else c.kids.forEach(visit)
  }
  visit(treeRoot); return reps
}

// ---- 描画 ----
type Piece = { blk: number; px0: number; px1: number; tr: Trav; inv: boolean; disp: boolean; fwd: boolean; c0: number; c1: number; cum?: Float64Array; k0?: number }   // cum＝錨の列ごとの累積の割合（各行の並びで欠失の列にも幅を取る）
// 片の中の座標 x → 片の中の割合（0〜1、合意の向き）。cum があれば錨の列ごとの幅で、無ければ座標に比例
function fracOf(p: Piece, x: number): number { x = Math.max(p.c0, Math.min(p.c1 + 1, x)); if (!p.cum || !cols) return (x - p.c0) / Math.max(1, p.c1 + 1 - p.c0)
  const C = cols; const cw = (C.x1 - C.x0 + 1) / C.ncol; const fc = (x - C.x0) / cw; let c = Math.floor(fc); const k = Math.max(0, Math.min(p.cum.length - 2, c - p.k0!)); const t = Math.max(0, Math.min(1, fc - (p.k0! + k)))
  return p.cum[k] + t * (p.cum[k + 1] - p.cum[k]) }
let rowColPx: Float64Array | null = null   // 各行の並びの列の画面位置（上段の描画用）
let lastPieces = new Map<number, Piece[]>(); let mrowsByHap = new Map<number, Trav[]>()   // 表示用（繰り返し通過をまとめた通過）
let ogHits: { o: OGroup; pa: number; pb: number }[] = []   // 見出しの遺伝子トラックの当たり
function draw() { try { drawCore() } catch (e) { showErr('draw', e) } }
function drawCore() {
  if (base && root) { drawBaseCore(); return }
  const useCols = !!cols && wantCols(); const ogOn = (ogroups.length > 0 || !!gdens) && showGenes(); TOP = (useCols ? 88 : 70) + (ogOn ? OGH + 2 : 0)
  const W = cv.parentElement!.clientWidth; const mode = ($('mode') as HTMLSelectElement).value; ROW = mode === 'rows' ? 22 : 15
  // 行の高さ: 遺伝子レーンのある行だけ段数ぶん高く（3 + 10 × 段）
  // 繰り返し通過（同じ場所を k 回）: 錨の列の段では k 段の小行に分けて各回のセルを出す（塩基の段の ·2 の行に対応）。ブロックの段は 1 片 ×k のまま
  const mergedByHap = new Map<number, Trav[]>(); for (const r of mergePasses(rows)) { if (!mergedByHap.has(r.hid)) mergedByHap.set(r.hid, []); mergedByHap.get(r.hid)!.push(r) }
  const passK = new Map<number, number>(); if (useCols) for (const [hid, ts] of mergedByHap) { let k = 1; for (const r of ts) if ((r.k || 1) > k && r.x1 >= view[0] && r.x0 <= view[1]) k = r.k!; passK.set(hid, k) }
  rowTop = []; rowHgt = []; { let yy = TOP; const gOn = genes.length > 0 && showGenes(); for (const hid of (root ? hapOrder : [])) { let nl = 0; if (gOn) { const m = geneLanesByHid.get(hid); if (m) for (const L of m.values()) nl = Math.max(nl, L + 1) } const h = ROW + ((passK.get(hid) || 1) - 1) * (BLK + 1) + (nl ? 3 + GLH * nl : 0); rowTop.push(yy); rowHgt.push(h); yy += h } }
  const H = rowsBottom() + 20
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ov.width = cv.width; ov.height = cv.height; ov.style.width = cv.style.width; ov.style.height = cv.style.height; og.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, W, H)
  if (!root) return
  const [v0, v1] = view; const BB = TOP - (useCols ? 30 : 12) - (ogOn ? OGH + 2 : 0)   // ブロックの帯の底（錨の列の帯・遺伝子トラックを出すときはその上）
  // 上段: ブロック（色は番号、高さは通るハプロタイプの割合）、×n の赤い帯、もつれの縦縞、境界（支持と持続度）
  const rcp = (mode === 'rows' && rowColPx && rowColPx.length === blocks.length + 1) ? rowColPx : null   // 各行の並び: 上段のブロックを行の列の位置に描く（行と上段の幅を揃える）
  const RT = root; blocks.forEach((b, bi) => {
    const px0 = rcp ? rcp[bi] : Math.max(LAB, X(b.x0)), px1 = rcp ? Math.max(rcp[bi] + 1, rcp[bi + 1]) : Math.min(W, X(b.x1 + 1)); const h = 8 + 30 * Math.min(1, b.nhap / RT.H)
    g.fillStyle = `hsla(${hue(b.id)}, 70%, 50%, .85)`; g.fillRect(px0, BB - h, Math.max(1, px1 - px0), h); g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.strokeRect(px0 + .5, BB - h + .5, Math.max(1, px1 - px0) - 1, h - 1)
    if (b.nhap2 > 0) { g.fillStyle = 'rgba(192,57,43,.9)'; g.fillRect(px0, BB, Math.max(1, px1 - px0), 3) }
    if (b.tangled) { g.fillStyle = 'rgba(120,120,120,.45)'; g.fillRect(px0, BB - h, Math.max(1, px1 - px0), h); if (px1 - px0 > 10) { g.fillStyle = '#fff'; g.font = 'bold 11px system-ui'; g.fillText('?', (px0 + px1) / 2 - 3, BB - h / 2 + 4) } }
    if (px1 - px0 > 44) { g.fillStyle = '#333'; g.font = '10px system-ui'; g.fillText(`${fmtbp(b.bp)} ${b.nhap}/${RT.H}${b.nhap2 ? ` ×${b.nhap2}` : ''}`, px0 + 2, BB - 2 - h) }
  })
  if (useCols && cols) {   // 錨の列の帯: 列ごとのアレルの種類数（灰 1 種 → 橙 → 赤）、高さ＝その列に掛かる行の数
    const C = cols; const Wc = C.x1 - C.x0 + 1; const SY0 = TOP - 24 - (ogOn ? OGH + 2 : 0), SH = 10; let maxrow = 1; for (let c = 0; c < C.ncol; c++) if (C.nrow[c] > maxrow) maxrow = C.nrow[c]
    for (let c = 0; c < C.ncol; c++) {
      const n = C.nrow[c]; if (!n) continue; const pa = Math.max(LAB, X(C.x0 + c * Wc / C.ncol)), pb = Math.min(W, X(C.x0 + (c + 1) * Wc / C.ncol)); const k = C.ncls[c]; const h = Math.max(1, SH * n / maxrow); const f = Math.min(1, Math.max(0, (k - 2) / 6))
      g.fillStyle = k <= 1 ? '#c9ced2' : `hsl(${30 - 30 * f}, 80%, ${55 - 15 * f}%)`; g.fillRect(pa, SY0 + SH - h, Math.max(1, pb - pa), h)
    }
    g.fillStyle = '#666'; g.font = '10px system-ui'; const lbl = '錨の列: アレルの種類数'; g.fillText(lbl, LAB - g.measureText(lbl).width - 4, SY0 + SH - 1)
  }
  if (ogOn) {   // 見出しの遺伝子トラック: 群＝1 本の矢印（濃い青緑＝core 90% 以上、薄い＝accessory、灰＝擬似が多数、紫＝RNA）。向きは群の多数
    const y0 = TOP - 12 - OGH; g.fillStyle = '#f3f6f7'; g.fillRect(LAB, y0, W - LAB, OGH); g.fillStyle = '#666'; g.font = '10px system-ui'; const lbl = '遺伝子群'; g.fillText(lbl, LAB - g.measureText(lbl).width - 4, y0 + OGH - 4)
    ogHits = []
    if (!ogroups.length && gdens && gdens.n.length) {   // 全景: 遺伝子の密度（棒の高さ＝1 株あたりの遺伝子数、赤＝株で有無・コピー数が違う遺伝子）
      const D = gdens; const mx = Math.max(1, ...D.n); const Wd = D.x1 - D.x0 + 1
      for (let k = 0; k < D.nbin; k++) { if (!D.n[k]) continue; const xa = D.x0 + k * Wd / D.nbin, xb = D.x0 + (k + 1) * Wd / D.nbin; const pa = Math.max(LAB, X(xa)), pb = Math.min(W, X(xb)); if (pb <= pa) continue
        const h = Math.max(1, (OGH - 3) * D.n[k] / mx); g.fillStyle = '#0d7c86'; g.fillRect(pa, y0 + OGH - 1 - h, Math.max(1, pb - pa), h)
        if (D.v[k]) { const hv = Math.max(1, (OGH - 3) * D.v[k] / mx); g.fillStyle = '#d62728'; g.fillRect(pa, y0 + OGH - 1 - hv, Math.max(1, pb - pa), hv) } }
      g.fillStyle = '#555'; g.font = '9px system-ui'; g.fillText(`遺伝子の密度（最大 ${mx.toFixed(0)}/区間${D.hasVar ? '、赤＝株で有無・コピー数が違う' : ''}。拡大すると個々の遺伝子）`, LAB + 4, y0 + 9)
    }
    for (const o of ogroups) { if (o.x1 < v0 || o.x0 > v1) continue; const pa = Math.max(LAB, X(o.x0)), pb = Math.min(W, X(o.x1 + 1)); const w = Math.max(2, pb - pa); const core = o.nhap >= 0.9 * root.H
      g.fillStyle = o.npseudo * 2 > o.n ? '#9a9a9a' : o.kind === 'rna' ? (core ? '#6c5ce7' : '#b89be0') : (core ? '#0d7c86' : '#8cc3c8'); const right = o.fwd * 2 >= o.n
      g.beginPath(); if (w >= 8) { if (right) { g.moveTo(pa, y0 + 2); g.lineTo(pb - 5, y0 + 2); g.lineTo(pb, y0 + OGH / 2); g.lineTo(pb - 5, y0 + OGH - 2); g.lineTo(pa, y0 + OGH - 2) } else { g.moveTo(pb, y0 + 2); g.lineTo(pa + 5, y0 + 2); g.lineTo(pa, y0 + OGH / 2); g.lineTo(pa + 5, y0 + OGH - 2); g.lineTo(pb, y0 + OGH - 2) } g.closePath(); g.fill() } else g.fillRect(pa, y0 + 2, w, OGH - 4)
      if (o.name) { g.font = '9px system-ui'; const tw = g.measureText(o.name).width; if (w >= tw + 12) { g.fillStyle = '#fff'; g.fillText(o.name, pa + (right ? 3 : 7), y0 + OGH - 5) } }
      if (o.para && w >= 4) { g.save(); g.setLineDash([2, 2]); g.strokeStyle = '#111'; g.lineWidth = 1; g.strokeRect(pa + .5, y0 + 1.5, w - 1, OGH - 3); g.restore() }   // 旁系を含む群＝黒の点線枠
      // 有無・コピー数の印（10-27）: 矢印の下に、欠ける株（赤）・2 コピー以上の株（青）・一部だけの株（橙）の割合を細い帯で。どの株も同じなら印なし
      if (o.pres && o.pres.cover) { const P = o.pres; let xx = pa; const seg = (n: number, col: string) => { if (!n) return; const ww = Math.max(2, w * n / P.cover); g.fillStyle = col; g.fillRect(xx, y0 + OGH - 2, ww, 3); xx += ww }
        seg(P.n0, '#d62728'); seg(P.n2, '#1f63c6'); seg(P.part, '#f39c12') }
      ogHits.push({ o, pa, pb }) }
  }
  if (($('showbounds') as HTMLInputElement).checked) for (const b of root.bounds) {
    if (b.x < v0 || b.x > v1) continue
    const px = X(b.x); const h = 6 + 8 * Math.log10(1 + b.persistence / 1000)
    g.strokeStyle = b.support >= root.H * 0.5 ? '#c0392b' : b.support >= 2 ? '#7f8c8d' : '#d0d0d0'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, TOP - 10); g.lineTo(px, TOP - 10 + h); g.stroke()
  }
  g.fillStyle = '#666'; g.font = '10px system-ui'; g.fillText(`${fmtbp(bpOfX(v0))}  x ${fmt(Math.floor(v0))} ${refPos(v0)}`, LAB + 2, TOP - 2); const tt = `${refPos(v1)} x ${fmt(Math.ceil(v1))}  ${fmtbp(bpOfX(v1 + 1))}`; g.fillText(tt, W - g.measureText(tt).width - 4, TOP - 2)

  // 行: 通過をブロックごとの片に割る。合意座標モードは片をその座標の位置に、各行の並びモードはコンティグの順に詰める
  const byHap = mergedByHap
  mrowsByHap = byHap
  const cpByHap = new Map<number, Copy[]>(); for (const c of copies) { if (!cpByHap.has(c.hid)) cpByHap.set(c.hid, []); cpByHap.get(c.hid)!.push(c) }
  const rpByHap = new Map<number, Rep[]>(); for (const c of reps) { if (!rpByHap.has(c.hid)) rpByHap.set(c.hid, []); rpByHap.get(c.hid)!.push(c) }
  const piecesOf = new Map<number, Piece[]>(); const fullView = v0 <= 0 && v1 >= root.R - 2
  type Deferred = { hid: number; raw: { blk: number; tr: Trav; c0: number; c1: number; key: number; wbp: number; fwd: boolean; cum?: Float64Array; k0?: number }[]; gapBp: number; pcs: Piece[]; inv: Set<Trav>; disp: Set<Trav>; span: number }; const deferred: Deferred[] = []
  for (const hid of hapOrder) {
    const ts = byHap.get(hid) || []
    // コンティグごとの主な向き（錨数で重み）と、コンティグ内の順が合意と合わない通過（転座: 最長単調部分列から外れるもの）
    const pids = [...new Set(ts.map(r => r.pid))]; const inv = new Set<Trav>(), disp = new Set<Trav>(); const domOf = new Map<number, number>(); const firstX = new Map<number, number>()
    for (const pid of pids) {
      const trs = ts.filter(r => r.pid === pid).sort((a, b) => a.i0 - b.i0); const dom = trs.reduce((t, r) => t + r.dir * r.nanch, 0) >= 0 ? 1 : -1; domOf.set(pid, dom)
      const main = trs.reduce((m, r) => r.nanch > m.nanch ? r : m, trs[0]); firstX.set(pid, main.x0)   // コンティグの順は最大の通過の座標で決める（小さな転座片を基準にすると行が乱れる）
      for (const r of trs) if (r.dir !== dom) inv.add(r)
      // 転座: コンティグ上で隣り合う（錨 ≥50 の）通過のどちらからも座標が JFAR 以上離れている通過（局所の重なりや小片は数えない）
      const JFAR = 20000; const big = trs.filter(r => r.nanch >= 50)
      for (let i = 0; i < big.length; i++) {
        const r = big[i]; const nb = [big[i - 1], big[i + 1]].filter(Boolean) as Trav[]; if (!nb.length) continue
        const far = nb.every(q => r.x0 > q.x1 + JFAR || r.x1 < q.x0 - JFAR); if (far) disp.add(r)
      }
    }
    // 片（ブロック × 通過）。各行の並び用に、コンティグ上の bp 位置（読む向きに揃えた鍵）と幅を付ける
    type Raw = { blk: number; tr: Trav; c0: number; c1: number; key: number; wbp: number; fwd: boolean; cum?: Float64Array; k0?: number }
    const raw: Raw[] = []
    for (const r of ts) for (let bi = blockAt(r.x0); bi < blocks.length && blocks[bi].x0 <= r.x1; bi++) {
      const b = blocks[bi]; if (b.x1 < r.x0) continue
      const c0 = Math.max(b.x0, r.x0), c1 = Math.min(b.x1, r.x1); const Lx = Math.max(1, r.x1 - r.x0 + 1); const f0 = (c0 - r.x0) / Lx, f1 = (c1 + 1 - r.x0) / Lx
      const [q0, q1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]; const bpA = (r.bp0 ?? 0) + q0 * r.bp, bpB = (r.bp0 ?? 0) + q1 * r.bp   // コンティグ上の bp 区間（格納向き）
      const mir = domOf.get(r.pid)! < 0; const key = mir ? -bpB : bpA   // 読む向き（主な向き）に並ぶ鍵
      const pc = mode === 'rows' ? pieceCum(r, c0, c1) : null
      raw.push({ blk: bi, tr: r, c0, c1, key, wbp: pc ? pc.wbp : (pieceBp(r, c0, c1) ?? Math.max(1, bpB - bpA)), fwd: (r.dir >= 0) !== mir, cum: pc?.cum, k0: pc?.k0 })
    }
    const pcs: Piece[] = []
    if (mode === 'coord') { for (const q of raw) pcs.push({ blk: q.blk, px0: X(q.c0), px1: X(q.c1 + 1), tr: q.tr, inv: inv.has(q.tr), disp: disp.has(q.tr), fwd: !inv.has(q.tr), c0: q.c0, c1: q.c1 }) }   // 向きはコンティグの主な向きに対する相対
    else {
      const order = pids.slice().sort((a, b) => firstX.get(a)! - firstX.get(b)!); const crank = new Map(order.map((p, i) => [p, i]))
      raw.sort((a, b) => crank.get(a.tr.pid)! - crank.get(b.tr.pid)! || a.key - b.key)
      if (pids.length === 1 && fullView && raw.length) {   // 環状: 錨 1,000 個以上の通過のうち座標最小のものを左端に回す
        const big = raw.filter(q => q.tr.nanch >= 1000); const start = (big.length ? big : raw).reduce((m, q) => q.c0 < m.c0 ? q : m, (big.length ? big : raw)[0]); const k = raw.indexOf(start)
        raw.push(...raw.splice(0, k))
      }
      // 横の尺度は全行で共通（最長の行が幅いっぱい）。行ごとに幅いっぱいへ引き伸ばすと、欠失で短い行だけ尺度が変わり連結線が全部斜めになる（2026-10-26）
      const total = raw.reduce((t, q) => t + q.wbp, 0) + 1; const gapBp = total * 0.004
      deferred.push({ hid, raw, gapBp, pcs, inv, disp, span: total + gapBp * Math.max(0, pids.length - 1) })
    }
    piecesOf.set(hid, pcs)
  }
  if (deferred.length) {
    // ブロックの列に揃える（10-27 改）: 並びは各株のコンティグ上の順のまま。空ける場所は欠失だけにする:
    //  ・合意の順に進む片（直前に進んだブロックより後ろ）＝その間の「この株がどこにも持たないブロック」の列幅だけ空けてから置き、片が占める幅は
    //    max(実 bp, 列幅 × 片が覆う座標の割合)（ブロックの一部が欠けた片も列の幅を保つ＝後ろがずれない）
    //  ・順が戻る片（逆位・転座・重複）＝直前の片のすぐ右に詰める（空きを作らない。そのぶん後ろは右へずれるが、全長は欠失の無い株と同程度）
    // 列の幅＝そのブロックの片の bp の中央値（10-27: 最大だと、一部の株だけが長い挿入を持つブロックで他の全株に大きな空白ができた。長い片は列からはみ出し、後ろが右へずれる）
    // 列の幅は「株ごとにそのブロックに持つ bp の合計」の中央値（10-27: 片ごとの中央値だと、1 ブロックを複数の通過で持つ株の片が小さく数えられ、列が狭すぎて行が上段の 1.5 倍に伸びた）
    const colW = new Float64Array(blocks.length); { const per: number[][] = blocks.map(() => []); for (const d of deferred) { const sum = new Map<number, number>(); for (const q of d.raw) sum.set(q.blk, (sum.get(q.blk) || 0) + q.wbp); for (const [k, v] of sum) per[k].push(v) }
      per.forEach((a, i) => { if (!a.length) return; a.sort((u, v) => u - v); colW[i] = a[a.length >> 1] }) }
    // 合意の順に進む片＝その株の片の並びの中で、ブロック番号の最長非減少部分列（LIS）に入る片（10-27: 以前は「直前までの最大より後ろ」で、
    // 先頭近くに右端のブロックの片が 1 つあるだけで以降の全部が「戻る片」扱いになり、列に揃わず左に詰まった）
    const lisOf = (bs: number[]): Set<number> => { const tails: number[] = [], tailIdx: number[] = [], prev = new Int32Array(bs.length).fill(-1)
      for (let i = 0; i < bs.length; i++) { let lo = 0, hi = tails.length; while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] <= bs[i]) lo = m + 1; else hi = m }
        if (lo > 0) prev[i] = tailIdx[lo - 1]; tails[lo] = bs[i]; tailIdx[lo] = i }
      const out = new Set<number>(); let k = tails.length ? tailIdx[tails.length - 1] : -1; while (k >= 0) { out.add(k); k = prev[k] } return out }
    const placed = deferred.map(d => { let cur = 0, lastPid = -1, lastCol = -1, blkStart = 0; const xs: number[] = []; const have = new Set(d.raw.map(q => q.blk)); const inLis = lisOf(d.raw.map(q => q.blk)); let qi = -1
      // 局所的な並べ替え（10-27）: 片の並びを「ここより前のブロック番号の最大 < ここから後の最小」の所で区切り（区間に分けると整列できる最小単位）、
      // 区間の中が入れ替わっていて、その範囲が 8 ブロック以下なら、空きを作らずその場で並びだけ変える（区間の列幅の合計の中に、株の順で詰める）
      const bl = d.raw.map(q => q.blk); try { const w = window as any; w.__travSeq = w.__travSeq || {}; w.__travSeq[root!.haps[d.hid].hap] = d.raw.map(q => [q.blk, q.tr.pid, Math.round(q.wbp)]); w.__travColW = Array.from(colW) } catch { /* 試験用 */ }
      // 遠い外れ片（LIS に入らず、直前の LIS の片のブロックから 8 ブロック超離れた片＝転座・環状の起点など）は区切りの計算から除く（入れると全体が 1 区間になり局所の入れ替えが見つからない）
      const far = new Uint8Array(bl.length); { let prevL = -1; for (let k = 0; k < bl.length; k++) { if (inLis.has(k)) { prevL = bl[k]; continue } if (prevL < 0 || Math.abs(bl[k] - prevL) > 8) far[k] = 1 } }
      const idx = bl.map((_, k) => k).filter(k => !far[k]); const sufMin = new Array<number>(idx.length + 1).fill(Infinity); for (let k = idx.length - 1; k >= 0; k--) sufMin[k] = Math.min(sufMin[k + 1], bl[idx[k]])
      const localEnd = new Int32Array(bl.length).fill(-1); { let st = 0, mx = -1; for (let k = 0; k < idx.length; k++) { mx = Math.max(mx, bl[idx[k]]); if (mx < sufMin[k + 1] || k === idx.length - 1) {
        let lo = Infinity; let sorted = true; for (let j = st; j <= k; j++) { lo = Math.min(lo, bl[idx[j]]); if (j > st && bl[idx[j]] < bl[idx[j - 1]]) sorted = false }
        const contiguous = idx[k] - idx[st] === k - st   // 区間の中に遠い外れ片が挟まっていない
        if (!sorted && k > st && mx - lo <= 8 && contiguous) localEnd[idx[st]] = idx[k]; st = k + 1; mx = -1 } } }
      // ブロックの中の始まりの位置: ブロックの先頭から片の始まりまでのうち、この株のどの片にも覆われない長さ（＝欠失）だけ。別のコンティグの片が覆う部分は空けない
      // （10-27: コンティグの順でブロックの後半が先に来た株で、ブロックの前半の分の空白ができた。HG03492#1 のブロック 9）
      const ivByBlk = new Map<number, [number, number][]>(); for (const q of d.raw) { if (!ivByBlk.has(q.blk)) ivByBlk.set(q.blk, []); ivByBlk.get(q.blk)!.push([q.c0, q.c1 + 1]) }
      const uncoveredBefore = (k: number): number => { const q = d.raw[k]; const b = blocks[q.blk]; const a0 = b.x0, a1 = q.c0; if (a1 <= a0) return 0
        const iv = (ivByBlk.get(q.blk) || []).map(([u, v]) => [Math.max(u, a0), Math.min(v, a1)] as [number, number]).filter(([u, v]) => v > u).sort((x, y) => x[0] - y[0]); let cov = 0, e = a0
        for (const [u, v] of iv) { if (v <= e) continue; cov += v - Math.max(u, e); e = v } return (a1 - a0) - cov }
      let skipTo = -1
      for (const q of d.raw) { qi++
        if (qi <= skipTo) continue
        if (localEnd[qi] >= 0) { const e = localEnd[qi]; let lo = Infinity, hi = -1; for (let j = qi; j <= e; j++) { lo = Math.min(lo, bl[j]); hi = Math.max(hi, bl[j]) }
          for (let k = lastCol + 1; k < lo; k++) if (!have.has(k)) cur += colW[k]
          let span = 0; for (let k = Math.max(lo, lastCol + 1); k <= hi; k++) if (have.has(k)) span += colW[k];   // 直前までに置いた列（lastCol 以下）は数えない（二重に空いた）
           let sum = 0; const x0 = cur
          for (let j = qi; j <= e; j++) { xs.push(x0 + sum); sum += d.raw[j].wbp }
          cur = x0 + Math.max(sum, span); lastCol = hi; blkStart = cur; lastPid = d.raw[e].tr.pid; skipTo = e; continue }
        // コンティグの変わり目に隙間は足さない（10-27: 0.4% の隙間で後ろのブロックが右に少しずれた。変わり目は片の端の三角で分かる）
        lastPid = q.tr.pid; const b = blocks[q.blk]
        if (inLis.has(qi) && q.blk >= lastCol) {
          if (q.blk > lastCol) { for (let k = lastCol + 1; k < q.blk; k++) if (!have.has(k)) cur += colW[k]; blkStart = cur }
          // ブロックの途中から始まる片（欠失がブロックの途中まで掛かる、1 つのブロックを複数の通過が分けて持つ）は、列の中の位置（始まりの割合 × 列幅）から置き、
          // 占める幅も覆う割合だけにする（10-27: 同じブロックの 2 本目以降を詰めて足していたので、全ゲノムで行が列の合計の 1.6 倍に伸びた）
          const Lb = Math.max(1, b.x1 + 1 - b.x0); const fr = Math.max(0, Math.min(1, uncoveredBefore(qi) / Lb)); const cov = Math.max(0, Math.min(1 - fr, (q.c1 + 1 - q.c0) / Lb))
          const x = Math.max(cur, blkStart + fr * colW[q.blk]); xs.push(x); cur = x + Math.max(q.wbp, colW[q.blk] * cov); lastCol = q.blk }
        else { xs.push(cur); cur += q.wbp } }
      try { const w = window as any; w.__travXs = w.__travXs || {}; w.__travXs[root!.haps[d.hid].hap] = xs.map(Math.round) } catch { /* 試験用 */ }
      return { d, xs, end: cur } })
    const scale = (W - LAB) / Math.max(1, ...placed.map(p => p.end))
    { const cp = new Float64Array(blocks.length + 1); let acc = 0; for (let i = 0; i < blocks.length; i++) { cp[i] = LAB + acc * scale; acc += colW[i] } cp[blocks.length] = LAB + acc * scale
      const changed = !rowColPx || rowColPx.length !== cp.length || cp.some((v, i) => Math.abs(v - rowColPx![i]) > 0.5); rowColPx = cp; if (changed) requestAnimationFrame(() => draw()) }
    for (const { d, xs } of placed) d.raw.forEach((q, i) => { const px0 = LAB + xs[i] * scale, px1 = LAB + (xs[i] + q.wbp) * scale
      d.pcs.push({ blk: q.blk, px0, px1, tr: q.tr, inv: d.inv.has(q.tr), disp: d.disp.has(q.tr), fwd: q.fwd, c0: q.c0, c1: q.c1, cum: q.cum, k0: q.k0 }) })
  }
  lastPieces = piecesOf
  const genesByTr = new Map<number, Gene[]>(); if (genes.length && showGenes()) for (const gn of genes) { if (!genesByTr.has(gn.tr)) genesByTr.set(gn.tr, []); genesByTr.get(gn.tr)!.push(gn) }
  hapOrder.forEach((hid, k) => {
    const y = rowTop[k]; const hap = root!.haps[hid]
    g.fillStyle = k % 2 ? '#f2f2f2' : '#fafafa'; g.fillRect(0, y, W, rowHgt[k])
    const n = perHap[hid] || 0; const oneBlk = blocks.length === 1
    const grp = groupOf.get(hid); const mk = markOf(hap.hap); if (mk) { g.fillStyle = mk; g.beginPath(); g.arc(TREEW + 7, y + 7, 3.5, 0, Math.PI * 2); g.fill() }   // 主画面で選択中のパス群の丸
    g.fillStyle = oneBlk && n >= 2 ? '#b03a2e' : '#333'; g.font = '11px system-ui'; g.fillText(`${hap.hap}${grp && grp.length > 1 ? ` +${grp.length - 1}` : ''}${hap.nexcl ? ` +${hap.nexcl}冗長` : ''}${oneBlk && n >= 2 ? ` ×${n}` : (n > 1 ? ` (${n})` : '')}`, TREEW + (mk ? 13 : 4), y + 10)
    const pcs = piecesOf.get(hid) || []
    for (const p of pcs) {
      const px0 = Math.max(LAB, Math.min(p.px0, p.px1)), px1 = Math.min(W, Math.max(p.px0, p.px1)); const w = Math.max(1, px1 - px0); const yy = y + 2, hh = BLK
      // 片の中は合意の向きに明→暗。画面上で左が合意の先頭なら明→暗、逆（逆位・逆鎖）なら暗→明
      if (useCols && cols) {   // 錨の列の段: 片の中を列のセルで塗り、ブロックの色は下辺 2 px に残す。同じ場所を k 回通る片は各回を小行に（コンティグ上の順）
        const mem = (p.tr.members && p.tr.members.length > 1) ? p.tr.members.slice().sort((a, b) => a.i0 - b.i0) : [p.tr]; const kAll = passK.get(hid) || 1
        g.fillStyle = '#fff'; g.fillRect(px0, yy, w, hh + (kAll - 1) * (BLK + 1) - 2); g.fillStyle = `hsla(${hue(p.blk)}, 70%, 46%, 1)`; g.fillRect(px0, yy + hh + (kAll - 1) * (BLK + 1) - 3, w, 3)
        const C2 = cols; mem.forEach((mtr, j) => { const cr = C2.byId.get(mtr.id); const y2 = yy + j * (BLK + 1); if (cr) drawCells(cr, p, px0, px1, y2, hh - 2, mode); if (mem.length > 1 && w > 14) { g.fillStyle = 'rgba(0,0,0,.55)'; g.font = 'bold 8px system-ui'; g.fillText('·' + (j + 1), px0 + 2, y2 + 7) } })
      } else { g.fillStyle = `hsla(${hue(p.blk)}, 70%, 46%, 1)`; g.fillRect(px0, yy, w, hh)   // コピーの薄塗りはやめた（10-27: 小さな断片が重なるだけで通過全体が薄くなり意味が無かった）
        if (cols) { const cr = cols.byId.get(p.tr.id); if (cr) drawGaps(cr, p, px0, px1, yy, hh, mode) } }   // 欠失（錨の無い連なり）を白い切れ目で
      if (w >= 3) { g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.strokeRect(px0 + .5, yy + .5, w - 1, hh - 1) }   // ブロック境界の枠
      if (mode === 'rows' && !p.fwd) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(px0, yy + hh - 2, w, 2) }   // 各行の並びで読む向きと逆（逆位）は下辺を暗く
      if ((p.tr.k || 1) >= 2 && w >= 4) { g.save(); g.beginPath(); g.rect(px0, yy, w, hh); g.clip(); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1; for (let xx = px0 - hh; xx < px1; xx += 5) { g.beginPath(); g.moveTo(xx, yy + hh); g.lineTo(xx + hh, yy); g.stroke() } g.restore() }   // 繰り返し通過＝斜線
      if (p.inv) { g.strokeStyle = '#8e44ad'; g.lineWidth = 1; g.strokeRect(px0 + .5, yy + .5, Math.max(1, w - 1), hh - 1); if (w > 10) { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(px0 + 7, yy + 1); g.lineTo(px0 + 2, yy + hh / 2); g.lineTo(px0 + 7, yy + hh - 1); g.fill() } }   // 逆位: 細い紫の枠（ブロックの色は残す）と左向きの三角
      else if (p.disp) { g.strokeStyle = '#333'; g.lineWidth = 1; g.setLineDash([3, 2]); g.strokeRect(px0 + .5, yy + .5, w - 1, hh - 1); g.setLineDash([]) }   // 転座（多数派の位置と違う所にある片）は各行の並びでも破線で
    }
    for (const r of byHap.get(hid) || []) {   // 通過ごとに向きの三角（右端または左端）とコピー番号
      const ps = pcs.filter(p => p.tr === r); if (!ps.length) continue
      const lo = Math.max(LAB, Math.min(...ps.map(p => Math.min(p.px0, p.px1)))), hi = Math.min(W, Math.max(...ps.map(p => Math.max(p.px0, p.px1)))); if (hi - lo < 24) continue
      const fwd = ps[0].fwd; const yy = y + 2, hh = BLK
      if (!ps[0].inv) { g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); if (fwd) { g.moveTo(hi - 6, yy); g.lineTo(hi - 1, yy + hh / 2); g.lineTo(hi - 6, yy + hh) } else { g.moveTo(lo + 6, yy); g.lineTo(lo + 1, yy + hh / 2); g.lineTo(lo + 6, yy + hh) } g.fill() }
      if ((r.k || 1) >= 2 && hi - lo > 18 && !(useCols && cols)) { g.fillStyle = '#fff'; g.font = 'bold 9px system-ui'; const t = '×' + r.k; const tw = g.measureText(t).width; g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(lo + (hi - lo) / 2 - tw / 2 - 2, y + 1, tw + 4, 9); g.fillStyle = '#fff'; g.fillText(t, lo + (hi - lo) / 2 - tw / 2, y + 9) }   // 繰り返し通過の回数
      // コピー番号（·n）の表示はやめた（10-27: 判定がゆるく、小さな断片が重なるだけで付いた。薄塗りと同じ理由）
    }
    if (genesByTr.size) {   // 遺伝子レーン: 片の下。種類 × 向きの色、重なりは段に分ける、三角＝向き、幅があれば名前
      const mine: Gene[] = []; for (const p of pcs) for (const gn of (genesByTr.get(p.tr.id) || [])) if (gn.x1 >= p.c0 && gn.x0 <= p.c1) mine.push(gn)
      const lanes = geneLanesByHid.get(hid) || geneLanes(mine); const drawn = new Set<number>()
      for (const p of pcs) for (const gn of (genesByTr.get(p.tr.id) || [])) {
        if (gn.x1 < p.c0 || gn.x0 > p.c1) continue
        const [pa, pb] = pxInPiece(p, Math.max(p.c0, gn.x0), Math.min(p.c1 + 1, gn.x1 + 1), mode); const a = Math.max(LAB, pa), b = Math.min(W, pb); if (b < a) continue
        const L = lanes.get(gn.gid) || 0; const yy0 = y + 2 + BLK + 3 + ((passK.get(hid) || 1) - 1) * (BLK + 1) + L * GLH; const w = Math.max(1, b - a); const col = geneColor(gn)
        const hasEx = gn.ch && gn.ch.some(c => c[0] === 'exon' || c[0] === 'utr')
        if (hasEx) {   // 子がある: イントロン＝細い線、エキソン＝低い箱、UTR＝さらに低く、CDS＝全高
          g.fillStyle = col; g.fillRect(a, yy0 + Math.floor((GLH - 1) / 2) - 1, w, 2)
          for (const [kind, cx0, cx1] of gn.ch!) { if (cx1 < p.c0 || cx0 > p.c1) continue; const [qa, qb] = pxInPiece(p, Math.max(p.c0, cx0), Math.min(p.c1 + 1, cx1 + 1), mode); const ea = Math.max(a, qa), eb = Math.min(b, qb); if (eb < ea) continue
            const hh2 = kind === 'cds' ? GLH - 1 : kind === 'exon' ? GLH - 4 : GLH - 6; g.fillStyle = kind === 'cds' ? col : (kind === 'exon' ? col : col); g.globalAlpha = kind === 'cds' ? 1 : 0.6; g.fillRect(ea, yy0 + Math.floor((GLH - 1 - hh2) / 2), Math.max(1, eb - ea), hh2); g.globalAlpha = 1 }
        } else { g.fillStyle = col; g.fillRect(a, yy0, w, GLH - 1) }
        { const lf = lof.get(gn.gid); if (lf && lf.st !== 'ok' && lf.st !== 'nocds') { g.strokeStyle = '#d62728'; g.lineWidth = 1.5; g.strokeRect(a + .5, yy0 - .5, Math.max(2, w - 1), GLH); g.lineWidth = 1 } }   // 機能喪失の目安＝赤い枠
        const right = (p.fwd ? gn.fwd : !gn.fwd)   // 画面上の向き（各行の並びで片が鏡なら反転）
        if (w >= 12) { g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); if (right) { g.moveTo(b - 5, yy0 + 1); g.lineTo(b - 1, yy0 + (GLH - 1) / 2); g.lineTo(b - 5, yy0 + GLH - 2) } else { g.moveTo(a + 5, yy0 + 1); g.lineTo(a + 1, yy0 + (GLH - 1) / 2); g.lineTo(a + 5, yy0 + GLH - 2) } g.fill() }
        if (!drawn.has(gn.gid)) { const nm = gn.name || gn.locus || ''; g.font = '8.5px system-ui'; const tw = g.measureText(nm).width; if (nm && w >= tw + 12) { g.fillStyle = geneKind(gn) === 'pseudo' ? '#222' : '#fff'; g.fillText(nm, a + (right ? 3 : 7), yy0 + GLH - 3); drawn.add(gn.gid) } }
      }
    }
    if (($('showreps') as HTMLInputElement).checked && mode === 'coord') for (const c of (rpByHap.get(hid) || [])) { const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.fillStyle = 'rgba(120,20,20,.9)'; g.fillRect(px0, y + 1, Math.max(1, px1 - px0), 2) }
    if (($('showcopies') as HTMLInputElement).checked && mode === 'coord') for (const c of (cpByHap.get(hid) || [])) { const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.strokeStyle = '#c0392b'; g.lineWidth = 2; g.beginPath(); g.moveTo(px0, y + BLK + 3); g.lineTo(px1, y + BLK + 3); g.stroke() }
  })
  drawTree(new Map(hapOrder.map((h, k) => [h, k])))
  if (located.length) { g.strokeStyle = 'rgba(255,20,147,.85)'; g.lineWidth = 1.5; for (const x of located) { if (x < v0 || x > v1) continue; const px = X(x); g.beginPath(); g.moveTo(px, TOP - 12); g.lineTo(px, rowsBottom()); g.stroke() } g.lineWidth = 1 }   // グラフから来たノードの座標
  if (sel) { g.fillStyle = 'rgba(52,152,219,.15)'; g.fillRect(sel[0], 0, sel[1] - sel[0], H); g.fillStyle = '#c0392b'; g.font = '12px system-ui'; g.fillText('計算中…', sel[0] + 4, 14) }
  drawLines(mode, W)
}
// 系統樹: 根が左、葉が右。枝の長さは不一致率。rowOf = hid → 行番号（塩基の段では同じ株の最初の行）
function drawTree(rowOf: Map<number, number>) {
  if (!root) return
  if (treeRoot && ($('order') as HTMLSelectElement).value === 'tree') {
    const hmax = Math.max(1e-9, treeRoot.h); g.strokeStyle = '#444'; g.lineWidth = 1
    const xOfH = (h: number) => 4 + (1 - Math.sqrt(Math.max(0, h) / hmax)) * (TREEW - 8)   // 近い株の併合が 0 付近に集まるので平方根で広げる
    const walk = (c: Clade): number => {   // 返り値はこのクレードの中心 y（子の中心の平均）。葉（まとめた枝も）は行の中心
      const x = xOfH(c.h)
      if (!c.kids.length || c.collapsed) {
        const k = rowOf.get(c.rep ?? c.leaves[0]); if (k == null) return -1
        const y = rowTop[k] + 2 + BLK / 2; g.beginPath(); g.moveTo(x, y); g.lineTo(TREEW - 2, y); g.stroke()
        if (c.collapsed) { g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(x, y); g.lineTo(TREEW - 2, y - 3); g.lineTo(TREEW - 2, y + 3); g.fill(); g.fillStyle = '#333' }   // まとめた枝＝三角
        return y
      }
      const ys0 = c.kids.map(walk); const ys = ys0.filter(v => v >= 0); if (!ys.length) return -1   // 塩基の段で行の無い株（範囲に無い）は飛ばす
      g.beginPath(); g.moveTo(x, Math.min(...ys)); g.lineTo(x, Math.max(...ys)); g.stroke()
      c.kids.forEach((k, i) => { if (ys0[i] < 0) return; const xk = xOfH(k.h); g.beginPath(); g.moveTo(x, ys0[i]); g.lineTo(xk, ys0[i]); g.stroke() })
      return ys.reduce((t, v) => t + v, 0) / ys.length
    }
    walk(treeRoot)
    if (treeCut != null) { const xc = xOfH(treeCut * hmax); g.strokeStyle = 'rgba(192,57,43,.6)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xc, TOP); g.lineTo(xc, rowsBottom()); g.stroke(); g.setLineDash([]) }   // まとめの閾値
    $('cuttxt').textContent = `${hapOrder.length}/${root.H} 行`
  } else $('cuttxt').textContent = ''
}
// 連結線: bp で等間隔に標本し、隣の行でその座標を含む片の中の位置を結ぶ
function drawLines(mode: string, W: number) {
  if (!root) return
  if (mode === 'rows' && ($('showlines') as HTMLInputElement).checked) {
    // 連結のリボン（10-27）: 隣り合う 2 行で同じブロックの片どうしを、共通の座標区間の両端で結ぶ四角形 1 枚にする。ずれ＝斜めの平行四辺形、
    // 逆位（片の向きが違う）＝交差した蝶形、欠失＝その行が錨を持たない列の連なりを除いた区間ごとに分かれる。細い線を多数引くと、行が横に大きくずれた所で
    // 線が数倍に伸びて面のように重なり、どこがどこに繋がるか読めなかった
    const C3 = cols; const useC = !!C3 && wantCols()
    const colOfX = (x: number) => C3 ? Math.floor((x - C3.x0) * C3.ncol / (C3.x1 - C3.x0 + 1)) : -1
    const has = (p: Piece, k: number): boolean => { if (!C3) return true; const cr = C3.byId.get(p.tr.id); if (!cr || k < 0 || k >= C3.ncol) return true; return !(C3.nanch[k] > 0 && cr.pres[k] === 0) }
    const pos = (p: Piece, x: number) => { const f = fracOf(p, x); return p.px0 + (p.fwd ? f : 1 - f) * (p.px1 - p.px0) }
    for (let k = 0; k + 1 < hapOrder.length; k++) {
      const A = lastPieces.get(hapOrder[k]) || [], B = lastPieces.get(hapOrder[k + 1]) || []; const yA = rowTop[k] + 2 + BLK, yB = rowTop[k + 1] + 2
      for (const pa of A) for (const pb of B) {
        if (pa.blk !== pb.blk) continue
        if (Math.abs(pa.px1 - pa.px0) < 2 || Math.abs(pb.px1 - pb.px0) < 2) continue   // ほぼ丸ごと欠けた片（幅 2 px 未満）には結ばない（一点に集まる三角になった）
        const lo = Math.max(pa.c0, pb.c0), hi = Math.min(pa.c1, pb.c1); if (hi < lo) continue
        const runs: [number, number][] = []   // 両方が錨を持つ列の連なり（錨の列が無ければ区間全体）。短い切れ目（3 列以下）は繋ぐ
        if (C3) { const Wc = C3.x1 - C3.x0 + 1; const k0 = Math.max(0, colOfX(lo)), k1 = Math.min(C3.ncol - 1, colOfX(hi)); let r0 = -1, miss = 0
          for (let c = k0; c <= k1 + 1; c++) { const ok = c <= k1 && has(pa, c) && has(pb, c)
            if (ok) { if (r0 < 0) r0 = c; miss = 0 } else if (r0 >= 0) { miss++; if (miss > 3 || c > k1) { const e = c - miss + 1; const xa = Math.max(lo, C3.x0 + r0 * Wc / C3.ncol), xb = Math.min(hi + 1, C3.x0 + e * Wc / C3.ncol); if (xb > xa) runs.push([xa, xb]); r0 = -1; miss = 0 } } } }
        else runs.push([lo, hi + 1])
        const crossed = pa.fwd !== pb.fwd
        g.fillStyle = `hsla(${hue(pa.blk)}, 60%, 50%, ${useC ? .10 : (crossed ? .32 : .22)})`; g.strokeStyle = `hsla(${hue(pa.blk)}, 60%, 35%, ${useC ? .25 : .55})`; g.lineWidth = 1
        for (const [xa, xb] of runs) {
          const a0 = pos(pa, xa), a1 = pos(pa, xb), b0 = pos(pb, xa), b1 = pos(pb, xb)
          if (Math.max(a0, a1) < LAB || Math.max(b0, b1) < LAB) continue
          g.beginPath(); g.moveTo(a0, yA); g.lineTo(a1, yA); g.lineTo(b1, yB); g.lineTo(b0, yB); g.closePath(); g.fill()
          g.beginPath(); g.moveTo(a0, yA); g.lineTo(b0, yB); g.moveTo(a1, yA); g.lineTo(b1, yB); g.stroke()
        }
      }
    }
  }
}
// 遺伝子の種類: タンパク質をコードする（cds）／RNA 遺伝子／擬似／その他。色は種類 × 向き
const geneKind = (gn: Gene): 'cds' | 'rna' | 'pseudo' | 'other' => (gn.pseudo || /pseudo/i.test(gn.type)) ? 'pseudo' : /^(cds|gene|mrna|protein_coding|protein-coding)$/i.test(gn.type) ? 'cds' : /rna/i.test(gn.type) ? 'rna' : 'other'
const geneColor = (gn: Gene) => { const k = geneKind(gn); return k === 'pseudo' ? '#9a9a9a' : k === 'cds' ? (gn.fwd ? '#2e8b57' : '#e67e22') : k === 'rna' ? (gn.fwd ? '#6c5ce7' : '#b89be0') : '#5d6d7e' }
// 行ごとに重なる遺伝子を段に分ける（x0 の順に、終わりが x0 より手前の段へ。最大 3 段、溢れは最後の段）
function geneLanes(gs: Gene[]): Map<number, number> { const out = new Map<number, number>(); const ends: number[] = []; for (const gn of gs.slice().sort((a, b) => a.x0 - b.x0 || b.x1 - a.x1)) { let L = ends.findIndex(e => e < gn.x0); if (L < 0) { if (ends.length < 3) { L = ends.length; ends.push(gn.x1) } else { L = 2; ends[2] = Math.max(ends[2], gn.x1) } } else ends[L] = gn.x1; out.set(gn.gid, L) } return out }
// 同じコンティグの連続する通過で座標の範囲が重なるもの（同じ場所を繰り返し通る＝タンデム反復・もつれ）は 1 つの片にまとめ、回数 k を付ける
// （ヒト chr22 短腕の原子 344–347 では 78 株が 500 座標を 6 回ずつ交互の向きで通り、片ごとに描くと全行が再編成に見えた）
// 片の幅（bp）: 錨の列が読めていれば、片の x 区間に掛かる列ごとに「その株のトークンの bp（錨も錨でないノードも）」を足す（＝その株が実際に持つ配列の長さ）。
// 無ければ通過全体の平均 bp/x × 区間。平均だと短い逆位の通過（局所の実 bp）と長い両側の通過（ゲノム平均）で同じブロックの幅が数倍違い、各行の並びで逆位の株だけ
// ブロックが短く描かれて連結線が乱れた（DDTL、2026-10-26）。錨の有無×合意 bp では、アレルの多い区間で錨を持たない株が短く見えた
// 列ごとの bp の中央値（錨を持つ行だけ）。欠失の列に取る幅
function colMedBp(): Float64Array | null { if (!cols) return null; const C = cols as any; if (C.__med) return C.__med; const out = new Float64Array(cols.ncol)
  for (let k = 0; k < cols.ncol; k++) { const a: number[] = []; for (const r of cols.rows) if (r.pres[k] > 0 && r.bpc.length) a.push(r.bpc[k]); if (a.length) { a.sort((u, v) => u - v); out[k] = a[a.length >> 1] } } C.__med = out; return out }
// 片の列ごとの幅（その株の bp、欠失の列＝その株が錨を持たない列は列の中央値）と累積の割合。錨の列の段の各行の並び用（10-28: ブロックの中の欠失で後ろが左に詰まった。APOBEC3A の融合型欠失）
function pieceCum(r: Trav, c0: number, c1: number): { wbp: number; cum: Float64Array; k0: number } | null {
  if (!cols || !wantCols()) return null; const cr = cols.byId.get(r.id); const med = colMedBp(); if (!cr || !cr.bpc.length || !med) return null
  const C = cols; const cw = (C.x1 - C.x0 + 1) / C.ncol; const k0 = Math.max(0, Math.floor((c0 - C.x0) / cw)), k1 = Math.min(C.ncol - 1, Math.floor((c1 - C.x0) / cw)); if (k1 < k0) return null
  const cum = new Float64Array(k1 - k0 + 2); let acc = 0
  for (let k = k0; k <= k1; k++) { const xa = C.x0 + k * cw; const f = Math.max(0, Math.min(xa + cw, c1 + 1) - Math.max(xa, c0)) / cw; const del = C.nanch[k] > 0 && cr.pres[k] === 0; acc += (del ? med[k] : cr.bpc[k]) * f; cum[k - k0 + 1] = acc }
  if (acc <= 0) return null; for (let i = 0; i < cum.length; i++) cum[i] /= acc; return { wbp: Math.max(1, Math.round(acc)), cum, k0 } }
function pieceBp(r: Trav, c0: number, c1: number): number | null {
  if (!cols) return null; const cr = cols.byId.get(r.id); if (!cr || !cr.bpc.length) return null
  const C = cols; const Wc = C.x1 - C.x0 + 1; const cw = Wc / C.ncol; const k0 = Math.max(0, Math.floor((c0 - C.x0) / cw)), k1 = Math.min(C.ncol - 1, Math.floor((c1 - C.x0) / cw)); if (k1 < k0) return null
  let bp = 0
  for (let k = k0; k <= k1; k++) { const xa = C.x0 + k * cw, xb = xa + cw; const f = Math.max(0, Math.min(xb, c1 + 1) - Math.max(xa, c0)) / cw; bp += cr.bpc[k] * f }   // 端の列は片が覆う割合だけ
  return Math.max(1, Math.round(bp))
}
function mergePasses(ts: Trav[]): Trav[] {
  const byPid = new Map<number, Trav[]>(); for (const r of ts) { if (!byPid.has(r.pid)) byPid.set(r.pid, []); byPid.get(r.pid)!.push(r) }
  const out: Trav[] = []
  for (const trs of byPid.values()) {
    trs.sort((a, b) => a.i0 - b.i0); let cur: Trav | null = null
    for (const r of trs) {
      if (cur) { const c: Trav = cur; const ov = Math.min(c.x1, r.x1) - Math.max(c.x0, r.x0) + 1
        // 反復（同じ座標の再訪）かどうかは backend の rep（重なりの中に両方の通過の錨があるか）に従う。逆位の片は隣の通過の x 範囲に収まるが錨は重ならないので併合しない（2026-10-26）
        if (r.rep === true || (r.rep == null && ov >= 0.5 * Math.min(c.x1 - c.x0 + 1, r.x1 - r.x0 + 1))) {
          const mem: Trav[] = [...(c.members || [c]), r].sort((a, b) => b.nanch - a.nanch); const main: Trav = mem[0]   // 代表＝錨の多い通過（id・向き）
          const merged: Trav = { ...c, id: main.id, dir: main.dir, x0: Math.min(c.x0, r.x0), x1: Math.max(c.x1, r.x1), i1: Math.max(c.i1, r.i1), nanch: c.nanch + r.nanch, bp: c.bp + r.bp, k: (c.k || 1) + 1, members: mem }
          cur = merged; continue }
        out.push(c) }
      cur = { ...r, k: 1, members: [r] }
    }
    if (cur) out.push(cur)
  }
  return out
}
// 片の中の座標区間 [xa, xb) → 画面の px（合意座標は X()、各行の並びは片の中の比例。向きが逆なら鏡）
function pxInPiece(p: Piece, xa: number, xb: number, mode: string): [number, number] {
  if (mode === 'coord') { const a = X(xa), b = X(xb); return [Math.min(a, b), Math.max(a, b)] }
  const fa = fracOf(p, xa), fb = fracOf(p, xb); const L = p.px1 - p.px0
  const a = p.fwd ? p.px0 + fa * L : p.px0 + (1 - fb) * L, b = p.fwd ? p.px0 + fb * L : p.px0 + (1 - fa) * L; return [Math.min(a, b), Math.max(a, b)]
}
// ブロックの段の切れ目: 錨の列の pres が 0 の列が 20 列以上続く所（＝その株が持たない配列、欠失）を白く抜く。通過は J（2,000 錨）未満の跳びでは切れないので、片の色だけでは欠失が見えない
function drawGaps(cr: ColRow, p: Piece, px0: number, px1: number, yy: number, hh: number, mode: string) {
  const C = cols!; const Wc = C.x1 - C.x0 + 1
  const c0 = Math.max(0, Math.floor((p.c0 - C.x0) * C.ncol / Wc)), c1 = Math.min(C.ncol - 1, Math.floor((p.c1 - C.x0) * C.ncol / Wc))
  let run0 = -1
  for (let c = c0; c <= c1 + 1; c++) { const zero = c <= c1 && cr.pres[c] === 0 && C.nanch[c] > 0   // 片の中で錨を 1 つも持たない列（cls 255 ＝その列に掛からない、も欠失）
    if (zero) { if (run0 < 0) run0 = c; continue }
    if (run0 >= 0) { const n = c - run0; if (n >= 20) { const xa = Math.max(p.c0, C.x0 + run0 * Wc / C.ncol), xb = Math.min(p.c1 + 1, C.x0 + c * Wc / C.ncol); const [pa, pb] = pxInPiece(p, xa, xb, mode); const a = Math.max(px0, pa), b = Math.min(px1, pb); if (b > a) { g.fillStyle = '#fff'; g.fillRect(a, yy + 1, b - a, hh - 2); g.strokeStyle = 'rgba(192,57,43,.8)'; g.lineWidth = 1; g.setLineDash([2, 2]); g.strokeRect(a + .5, yy + 1.5, Math.max(1, b - a - 1), hh - 3); g.setLineDash([]) } } run0 = -1 }
  }
}
// 錨の列のセル: 片（ブロック × 通過）の座標区間に掛かる列を、合意座標モードは X()、各行の並びは片の中の比例で置く。濃さ＝錨の有無、色＝アレル番号、上辺の黒＝挿入 bp（対数）
// 粗い段（1 列が 20 錨超）では、少数派の色をアレル番号でなく「そのアレルを持つ行の割合」で塗る（橙＝多くが持つ少数派 → 赤＝稀）。細かい段では同じ色＝同じ配列
// 共有の大きさ: 2 行だけ（対）は淡い橙、多くの行が共有する少数派ほど濃い赤（対数。ヒトの数 kb の列は対の共有だらけなので、線形だと真っ赤になる）
const shareColor = (cnt: number, nrow: number) => { const t = Math.log(Math.max(2, cnt)) / Math.log(Math.max(3, nrow)); return `hsl(${Math.round(30 - 30 * t)}, 85%, ${Math.round(80 - 35 * t)}%)` }
function drawCells(cr: ColRow, p: Piece, px0: number, px1: number, yy: number, hh: number, mode: string) {
  const C = cols!; const Wc = C.x1 - C.x0 + 1; const coarse = Wc / C.ncol > 20
  const c0 = Math.max(0, Math.floor((p.c0 - C.x0) * C.ncol / Wc)), c1 = Math.min(C.ncol - 1, Math.floor((p.c1 - C.x0) * C.ncol / Wc))
  for (let c = c0; c <= c1; c++) {
    const k = cr.cls[c]; if (k === 255) continue
    const xa = Math.max(p.c0, C.x0 + c * Wc / C.ncol), xb = Math.min(p.c1 + 1, C.x0 + (c + 1) * Wc / C.ncol); if (xb <= xa) continue
    let pa: number, pb: number
    if (mode === 'coord') { pa = X(xa); pb = X(xb) }
    else { const fa = fracOf(p, xa), fb = fracOf(p, xb); const L = p.px1 - p.px0; if (p.fwd) { pa = p.px0 + fa * L; pb = p.px0 + fb * L } else { pa = p.px0 + (1 - fb) * L; pb = p.px0 + (1 - fa) * L } }
    const a = Math.max(px0, Math.min(pa, pb)), b = Math.min(px1, Math.max(pa, pb)); if (b < a) continue; const wc = Math.max(1, b - a)
    // 粗い段: 多数派＝灰、この行だけのアレル＝ごく薄い灰（ヒトの数 kb の列は全行が別アレルになり、番号の色では真っ赤になる）、2 行以上が共有する少数派＝持つ行の割合の色
    let fill = k === 0 ? `hsl(${hue(p.blk)}, 45%, 78%)` : CLS_COL[Math.min(k, CLS_COL.length - 1)]   // 多数派＝ブロックの色の淡色（10-27: 灰だとブロックの順が読めなかった）
    if (k > 0 && coarse && cr.frq.length) { const nr = Math.max(1, C.nrow[c]); const cnt = Math.round(cr.frq[c] / 255 * nr); fill = cnt <= 1 ? '#f4f4f4' : shareColor(cnt, nr) }
    g.globalAlpha = 0.3 + 0.7 * (cr.pres[c] / 255); g.fillStyle = fill; g.fillRect(a, yy, wc, hh); g.globalAlpha = 1
    const ins = cr.ins[c]; if (ins > 0) { const ih = Math.min(hh, 1 + 1.5 * Math.log10(1 + ins)); g.fillStyle = 'rgba(20,20,20,.85)'; g.fillRect(a, yy, wc, ih) }
  }
}
// ---- 操作 ----
let drag: [number, number] | null = null; let sel: [number, number] | null = null
let bDrag: { x: number; sx: number; moved: boolean } | null = null
cv.addEventListener('mousedown', e => {
  if (base) {   // 塩基の段: 上段のドラッグ＝その範囲を画面幅に、行のドラッグ＝横に動かす、行ラベル＝主画面のパス群の選択
    if (e.offsetX < LAB) { if (root && e.offsetX >= TREEW && e.offsetY >= TOP) { const k = rowAt(e.offsetY); if (k >= 0 && k < base.lines.length && base.lines[k].hid >= 0) cb.onSelectHap?.(root.haps[base.lines[k].hid].hap) } return }
    if (e.offsetY < TOP) { drag = [e.offsetX, e.offsetX]; return }
    bDrag = { x: e.offsetX, sx: base.sx, moved: false }; return
  }
  const inRows = ($('mode') as HTMLSelectElement).value === 'rows'
  if (e.offsetX > LAB && e.offsetY < TOP) { drag = [e.offsetX, e.offsetX]; return }   // 範囲指定はスケールバー（上段）で始めたときだけ（10-27）
  void inRows
  if (root && e.offsetX >= TREEW && e.offsetX < LAB && e.offsetY >= TOP) { const k = rowAt(e.offsetY); if (k >= 0 && k < hapOrder.length) cb.onSelectHap?.(root.haps[hapOrder[k]].hap) }   // 行ラベル → 主画面のパス群の選択
})
cv.addEventListener('mousemove', e => {
  if (bDrag && base) { const dx = e.offsetX - bDrag.x; if (Math.abs(dx) > 2) bDrag.moved = true; base.sx = Math.max(0, Math.min(bDrag.sx - dx, Math.max(0, base.fullW - bodyPx() + 4))); draw(); return }
  if (base) { baseHover(e); return }
  if (drag) { drag[1] = e.offsetX; og.clearRect(0, 0, ov.width, ov.height); og.fillStyle = 'rgba(52,152,219,.2)'; og.fillRect(Math.min(drag[0], drag[1]), 0, Math.abs(drag[1] - drag[0]), ov.height); return }
  if (!root) return
  const k = rowAt(e.offsetY); const x = xOfPx(e.offsetX)
  if (e.offsetY < TOP && e.offsetX >= LAB) {
    if (ogroups.length && showGenes() && e.offsetY >= TOP - 12 - OGH && e.offsetY < TOP - 12) {   // 見出しの遺伝子トラック
      const hits = ogHits.filter(h => h.pa <= e.offsetX && h.pb >= e.offsetX); if (!hits.length) { tip.style.display = 'none'; return }
      const H2 = root!.H; tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
      tip.textContent = hits.slice(0, 4).map(({ o }) => { const mem = genes.filter(gn => gn.og === o.og); const names = [...new Set(mem.map(gn => gn.name || gn.locus).filter(Boolean))].slice(0, 4).join(' / '); const prod = mem.find(gn => gn.product)?.product || ''
        const P = o.pres; const hn = (hs: number[]) => hs.slice(0, 6).map(h => root!.haps[h].hap).join(', ') + (hs.length > 6 ? ` ほか ${hs.length - 6}` : '')
        const presTxt = P ? `\n  範囲を通る ${P.cover} 株: 1 コピー ${P.n1}・無し ${P.n0}・2 コピー以上 ${P.n2}・一部だけ（一致 80% 未満）${P.part}${P.absent.length ? `\n  無し: ${hn(P.absent)}` : ''}${P.multi.length ? `\n  2 コピー以上: ${hn(P.multi)}` : ''}${P.partial.length ? `\n  一部だけ: ${hn(P.partial)}` : ''}` : ''
        return `遺伝子群 ${o.name || names}  ${o.nhap}/${H2} 株（遺伝子 ${o.n}${o.npseudo ? `、擬似 ${o.npseudo}` : ''}${o.n > o.nhap ? `、1 株に複数 ${mem.length - o.nhap} 個` : ''}）  向き +${o.fwd}/−${o.n - o.fwd}  座標 ${fmt(o.x0)}–${fmt(o.x1)}${names && names !== o.name ? `  別名 ${names}` : ''}${prod ? `\n  ${prod}` : ''}${o.para ? `\n  旁系を含む（別の座位の遺伝子が配列の共有で 1 群になった。有無は遺伝子ごとに見る）: ${o.para.join(', ')}` : ''}${presTxt}` }).join('\n')
      return
    }
    const b = blocks[blockAt(x)]; if (!b) { tip.style.display = 'none'; return }
    const multi: string[] = []; for (let a = b.a0; a <= b.a1; a++) { const st = atomStats[a]; if (!st || st.tangled) continue; for (const [h, n] of Object.entries(st.counts)) if (n >= 2) multi.push(`${root!.haps[Number(h)].hap} ×${n}`) }
    tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
    tip.textContent = `ブロック ${b.id + 1}/${blocks.length}  座標 ${fmt(b.x0)}–${fmt(b.x1)}  ${fmtbp(b.bp)}  原子 #${b.a0 + 1}–#${b.a1 + 1}  通るハプロタイプ ${b.nhap}/${root.H}  ${refPos(b.x0)}${b.tangled ? '  【もつれ: 順序が線形にならない領域を含む】' : ''}` + (multi.length ? `\n2 回以上: ${[...new Set(multi)].slice(0, 12).join(', ')}` : '')
    return
  }
  if (k < 0 || k >= hapOrder.length || e.offsetX < LAB) { tip.style.display = 'none'; return }
  const hid = hapOrder[k]; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'
  const hit = inRows ? (lastPieces.get(hid) || []).filter(p => Math.min(p.px0, p.px1) <= e.offsetX && Math.max(p.px0, p.px1) >= e.offsetX).map(p => p.tr).filter((v, i, a) => a.indexOf(v) === i) : (mrowsByHap.get(hid) || []).filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  const rhit = inRows ? [] : reps.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  if (!hit.length && !rhit.length) { tip.style.display = 'none'; return }
  tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
  const lines = hit.map(r => `${root!.haps[r.hid].hap}  pid ${r.pid}  トークン ${fmt(r.i0)}–${fmt(r.i1)}${r.bp0 != null ? `  コンティグ ${fmtbp(r.bp0)}〜` : ''}  座標 ${fmt(r.x0)}–${fmt(r.x1)}  ${r.dir >= 0 ? '→' : '←'}  錨 ${fmt(r.nanch)}  ${fmtbp(r.bp)}${r.copy ? `  コピー ·${r.copy}` : ''}${(r.k || 1) >= 2 ? `\n  同じ場所を ${r.k} 回通る（まとめた通過）: ` + r.members!.map(m => `${m.dir >= 0 ? '→' : '←'}${fmt(m.x0)}–${fmt(m.x1)} 錨${fmt(m.nanch)}`).join(', ') : ''}`).concat(rhit.map(r => `反復（この株で 2 回以上出るノードの連なり） トークン ${fmt(r.i0)}–${fmt(r.i1)}  ${fmtbp(r.bp)}`))
  let xx = x   // カーソルの座標（各行の並びでは片の中の比例から）
  if (inRows) { const p = (lastPieces.get(hid) || []).find(p => Math.min(p.px0, p.px1) <= e.offsetX && Math.max(p.px0, p.px1) >= e.offsetX); if (p) { const f = (e.offsetX - Math.min(p.px0, p.px1)) / Math.max(1, Math.abs(p.px1 - p.px0)); const ft = p.fwd ? f : 1 - f; let lo = p.c0, hi = p.c1 + 1; for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (fracOf(p, m) < ft) lo = m; else hi = m } xx = lo } }
  if (genes.length && showGenes()) for (const gn of genes.filter(gn => gn.hid === hid && gn.x0 <= xx && gn.x1 >= xx).slice(0, 6)) lines.push(`遺伝子 ${gn.name || gn.locus || ('#' + gn.gid)}${gn.pseudo ? '（擬似）' : ''}  ${gn.type}${geneKind(gn) === 'rna' ? '（RNA 遺伝子）' : ''} 鎖 ${gn.strand}${gn.fwd ? '' : '（合意と逆向き）'}  ${fmtbp(gn.end - gn.start + 1)}  コンティグ ${fmt(gn.start)}–${fmt(gn.end)}  ${gn.product || ''}${gn.anchored ? '' : '  [錨なし: 位置は補間]'}` + (() => { const lf = lof.get(gn.gid); const T: Record<string, string> = { trunc: '終止獲得（参照の 9 割未満で止まる）', fs: 'フレームシフト（CDS の長さが参照と 3 の倍数でない差）', nostart: '開始コドンが無い' }; return lf && T[lf.st] ? `  ★機能喪失の目安: ${T[lf.st]}（${lf.aa} aa／参照 ${lf.ref ?? '?'} aa）` : '' })())
  if (cols && wantCols()) {   // 錨の列: カーソルの列と、この行のアレル・錨の有無・挿入・窓の中のトークン範囲（塩基 MSA へ渡す範囲）
    const C = cols; const Wc = C.x1 - C.x0 + 1
    const c = Math.max(0, Math.min(C.ncol - 1, Math.floor((xx - C.x0) * C.ncol / Wc))); const xa = Math.floor(C.x0 + c * Wc / C.ncol), xb = Math.floor(C.x0 + (c + 1) * Wc / C.ncol) - 1
    lines.push(`列 ${c + 1}/${C.ncol}  座標 ${fmt(xa)}–${fmt(Math.max(xa, xb))}  錨 ${C.nanch[c]}  アレル ${C.ncls[c]} 種（多数派 ${C.major[c]}/${C.nrow[c]} 行）`)
    for (const r of hit) { const cr = C.byId.get(r.id); if (!cr || cr.cls[c] === 255) continue; lines.push(`  この行: アレル #${cr.cls[c] + 1}  錨 ${Math.round(100 * cr.pres[c] / 255)}%  挿入 ${fmt(cr.ins[c])} bp  窓のトークン ${fmt(cr.tw0)}–${fmt(cr.tw1)}`) }
  }
  tip.textContent = lines.join('\n')
})
const onWinUp = (e: MouseEvent) => {
  if (bDrag) { bDrag = null; return }
  if (!drag) return; const [a, b] = [Math.min(...drag), Math.max(...drag)]; drag = null; og.clearRect(0, 0, ov.width, ov.height)
  { const r = cv.getBoundingClientRect(); const y = e.clientY - r.top, x = e.clientX - r.left; if (y < 0 || y >= TOP || x < LAB || x > r.width) return }   // スケールバーの外で離したら取り消し（10-27）
  if (b - a < 4) { if (base) { const k = baseItemAt(a - LAB + base.sx); if (k != null && base.items[k].kind === 'col') { const ci = (base.items[k] as any).ci as number; const i = base.sortCi.indexOf(ci); if (i >= 0) base.sortCi.splice(i, 1); else base.sortCi.push(ci); draw() } else if (k != null) { const it = base.items[k] as any; const ci = it.ci0 as number; const i = base.sortCi.indexOf(ci); if (i >= 0) base.sortCi.splice(i, 1); else base.sortCi.push(ci); draw() } } return }
  if (base) { const k0 = baseItemAt(a - LAB + base.sx), k1 = baseItemAt(b - LAB + base.sx); if (k0 == null || k1 == null) return; const i0 = base.items[k0].kind === 'col' ? (base.items[k0] as any).ci : (base.items[k0] as any).ci0, i1 = base.items[k1].kind === 'col' ? (base.items[k1] as any).ci : (base.items[k1] as any).ci1; baseZoomToCols(i0, i1); return }
  hist.push(view); view = [xOfPx(a), xOfPx(b)]; sel = [a, b]; userMoved = true; draw(); loadRange() }; window.addEventListener('mouseup', onWinUp)
cv.addEventListener('dblclick', e => { if (!root) return; if (base) { if (e.offsetX >= LAB) baseZoomStep(2, e.offsetX - LAB); return } userMoved = true; hist.push(view); if (e.offsetY < TOP && e.offsetX >= LAB) { const b = blocks[blockAt(xOfPx(e.offsetX))]; view = b ? [b.x0, b.x1] : [0, root.R - 1] } else view = [0, root.R - 1]; loadRange() })
cv.addEventListener('wheel', e => {
  if (base && e.offsetX >= LAB) {   // 塩基の段: Ctrl＋ホイール＝拡大縮小、ホイール＝横に動かす
    e.preventDefault(); if (e.ctrlKey || e.metaKey) baseZoomStep(e.deltaY < 0 ? 1 : -1, e.offsetX - LAB)
    else { const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY); base.sx = Math.max(0, Math.min(base.sx + d, Math.max(0, base.fullW - bodyPx() + 4))); draw() }
    return
  }
  if (true) return; if (!root || e.offsetX < LAB) return; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'; if (!inRows || e.offsetY >= TOP) return; /* ホイールの拡大縮小は無効（ドラッグで） */ e.preventDefault(); const x = xOfPx(e.offsetX); const f = e.deltaY > 0 ? 1.25 : 0.8; const n0 = x - (x - view[0]) * f, n1 = x + (view[1] - x) * f; hist.push(view); view = [Math.max(0, n0), Math.min(root!.R - 1, n1)]; draw(); scheduleRange() }, { passive: false })
$('all').addEventListener('click', () => { if (!root) return; if (base) closeBase(); hist.push(view); view = [0, root.R - 1]; userMoved = true; loadRange() })
$('back').addEventListener('click', () => { if (base) { closeBase(); return } const v = hist.pop(); if (v) { view = v; userMoved = true; loadRange() } })
$('bclose').addEventListener('click', closeBase)
// 遺伝子名の検索: 名前ごとにまとめ（株数）、選ぶとその範囲（全株の座標の和、2 割の余白）へ移ってマゼンタの印
type GHit = { gid: number; hid: number; hap: string; name: string; locus: string; product: string; type: string; pseudo: boolean; x0: number; x1: number; start: number; end: number }
async function findGene(q: string) {
  const box = $('gres'); if (!q.trim()) { box.style.display = 'none'; return }
  const r = await getJson(`/api/trav/findgene?db=${encodeURIComponent(db)}&q=${encodeURIComponent(q)}&limit=200`); const j = await r.json()
  if (j.error || !j.hits) { box.innerHTML = `<div class="hd">${j.error || '結果なし'}</div>`; box.style.display = 'block'; return }
  const hits = (j.hits as GHit[]).filter(h => h.x0 >= 0); const byName = new Map<string, GHit[]>(); for (const h of hits) { const k = h.name || h.locus; if (!byName.has(k)) byName.set(k, []); byName.get(k)!.push(h) }
  if (!byName.size) { box.innerHTML = `<div class="hd">「${q}」に合う遺伝子が無い（${j.n} 件は座標なし）</div>`; box.style.display = 'block'; return }
  const groups = [...byName.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  if (groups.length === 1) { goGenes(groups[0][1]); box.style.display = 'none'; return }
  box.innerHTML = `<div class="hd">「${q}」 ${groups.length} 遺伝子${j.truncated ? '（上限で打ち切り）' : ''} · クリックで移動</div>` + groups.slice(0, 60).map((e, i) => { const hs = e[1]; const x0 = Math.min(...hs.map(h => h.x0)), x1 = Math.max(...hs.map(h => h.x1)); return `<div class="it" data-i="${i}">${e[0]}${hs[0].pseudo ? '（擬似）' : ''}<span class="k">${hs.length} 株 · ${hs[0].type} · x ${fmt(x0)}–${fmt(x1)}${hs[0].product ? ' · ' + hs[0].product.slice(0, 60) : ''}</span></div>` }).join('')
  box.style.display = 'block'; box.querySelectorAll('.it').forEach(el => el.addEventListener('click', () => { const i = Number((el as HTMLElement).dataset.i); goGenes(groups[i][1]); box.style.display = 'none' }))
}
function goGenes(hs: GHit[]) {
  if (!root || !hs.length) return; if (base) { base = null; $('basegrp').style.display = 'none' }
  const x0 = Math.min(...hs.map(h => h.x0)), x1 = Math.max(...hs.map(h => h.x1)); const pad = Math.max(200, 0.2 * (x1 - x0 + 1))
  hist.push(view); view = [Math.max(0, Math.floor(x0 - pad)), Math.min(root.R - 1, Math.ceil(x1 + pad))]; located = [x0, x1]; ($('genes') as HTMLInputElement).checked = true; userMoved = true; loadRange()
  $('info').textContent = `遺伝子 ${hs[0].name || hs[0].locus}: ${hs.length} 株、座標 ${fmt(x0)}–${fmt(x1)}`
}
$('gfind').addEventListener('keydown', e => { if (e.key === 'Enter') void findGene(($('gfind') as HTMLInputElement).value); if (e.key === 'Escape') $('gres').style.display = 'none' })
$('gfind').addEventListener('search', () => { if (!($('gfind') as HTMLInputElement).value) $('gres').style.display = 'none' })
document.addEventListener('mousedown', e => { const b = $('gres'); if (b && b.style.display !== 'none' && !b.contains(e.target as Node) && e.target !== $('gfind')) b.style.display = 'none' })
cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; sendHover(null); if (base && base.hoverCi != null) { base.hoverCi = null; draw() } })
$('zout').addEventListener('click', () => { if (base) baseZoomStep(-1, null) }); $('zin').addEventListener('click', () => { if (base) baseZoomStep(1, null) })
$('zfit').addEventListener('click', () => { if (base) { base.sx = 0; baseSetZoom(null, null) } }); $('zbase').addEventListener('click', () => { if (base) baseSetZoom(BASE_LETTER_Z, null) })
$('bmode').addEventListener('change', () => { if (base) draw() })
for (const id of ['cmp', 'bdiff', 'bvar', 'bfold', 'beff']) $(id).addEventListener('change', () => { if (base) { if (id === 'bvar' || id === 'bfold') { base.sx = 0; base.z = null } if (id === 'cmp') base.eff = undefined; draw() } })
// リードだけの挿入の印の x: side 0 = 列の左端、1 = 右端、2 = 畳んだ区間（~）の中ほど。列が畳んだ区画（blk）に入っていれば区画の中の比例の位置
function baseInsX(ci: number, side: number): number | null { const B = base!; const kk = B.colItem[ci]; if (kk == null || kk < 0) return null; const it = B.items[kk]; const x0 = B.xs[kk], x1 = B.xs[kk + 1]
  if (it.kind === 'blk') { const n = it.ci1 - it.ci0 + 1; return x0 + (x1 - x0) * (ci - it.ci0 + (side === 0 ? 0 : side === 1 ? 1 : 0.5)) / n } return side === 0 ? x0 : side === 1 ? x1 : (x0 + x1) / 2 }
// 詰めた行はカーソルの列に掛かるリードに読み替える。要約の行は深さと違う塩基の内訳を足して null（行ごとの説明は出さない）
function hoverLine(B: BaseState, ln: BaseState['lines'][number], it: BItem, lines: string[]): BaseState['lines'][number] | null {
  const i0 = it.kind === 'col' ? it.ci : it.ci0, i1 = it.kind === 'col' ? it.ci : it.ci1
  if (ln.cov) { const C = readCov(B, ln.cov); let d = 0, m = 0; const tally = new Map<string, number>()
    B.rows.forEach((r, mi) => { const rd = (r as any).read; if (!rd || rd.sample !== ln.cov) return; const ch = (B.norm[mi] || r.seq)[i0]; if (ch && ch !== '.' && ch !== '~') tally.set(ch, (tally.get(ch) || 0) + 1) })
    for (let i = i0; i <= i1; i++) { if (C.dep[i] > d) d = C.dep[i]; if (C.mis[i] > m) m = C.mis[i] }
    let dl = 0; for (let i = i0; i <= i1; i++) if (C.del[i] > dl) dl = C.del[i]
    lines.push(`${ln.cov} 要約（${C.n} 本）  深さ ${d}  欠失 ${dl}  基準と違う ${m}${d ? `（${Math.round(100 * m / d)}%）` : ''}${it.kind === 'col' ? '  内訳 ' + [...tally].sort((a, b) => b[1] - a[1]).map(([ch, c]) => `${ch === '-' ? '欠失' : ch}:${c}`).join(' ') : ''}`); return null }
  if (ln.pack) { const mi = ln.pack.find(m => { const [a, b] = readSpan(B, m); return i1 >= a && i0 <= b }); if (mi == null) { lines.push(`${(B.rows[ln.mi] as any).read.sample} 詰め ${ln.pack.length} 本（この列に掛かるリードは無い）`); return null } return { ...ln, mi } }
  return ln
}
// 塩基の段のホバー: 列（ノード・bp・位置）とその行の塩基・アレル
function baseHover(e: MouseEvent) {
  const B = base!; if (e.offsetX < LAB) { tip.style.display = 'none'; sendHover(null); if (B.hoverCi != null) { B.hoverCi = null; draw() } return }
  const px = e.offsetX - LAB + B.sx; const k = baseItemAt(px); if (k == null) { tip.style.display = 'none'; sendHover(null); if (B.hoverCi != null) { B.hoverCi = null; draw() } return }
  const it = B.items[k]; const ci = it.kind === 'col' ? it.ci : it.ci0; const gr = B.groups.find(gr => gr.g === it.g); const lines: string[] = []
  sendHover(gr ? gr.nodes.filter(n => /^n\d+$/.test(n)) : null)
  if (gr) lines.push(`ノード ${gr.nodes.join(' / ')}  ${fmt(gr.bp)} bp  列 ${fmt(gr.from)}–${fmt(gr.to)}${gr.rb ? `  参照 bp ${fmt(gr.rb)}` : ''}${gr.variant ? '  行間で違う' : ''}`)
  const kr = rowAt(e.offsetY)
  { const AH = annH(B); const A = B.ann; if (AH && A && e.offsetY >= 58 && e.offsetY < 58 + AH) {   // 注釈の帯
    const c0 = it.kind === 'col' ? it.ci : it.ci0, c1 = it.kind === 'col' ? it.ci : it.ci1; let rp = -1; for (let c = c0; c <= c1; c++) if (A.refPos[c] >= 0) { rp = A.refPos[c]; break }
    lines.push(rp >= 0 ? `参照 ${A.contig}:${fmt(rp + 1)}（GRCh38、1 始まり）` : 'この列は参照を通らない（挿入・株固有のアレル）。注釈は付かない')
    if (e.offsetY < 58 + ANN_REP_H) { let rk = -1; for (let c = c0; c <= c1 && rk < 0; c++) rk = A.rep[c]; if (rk >= 0) { const r = A.reps[rk]; lines.push(`反復 ${r.name}  ${r.cls}/${r.fam}  鎖 ${r.strand}  ${A.contig}:${fmt(r.s + 1)}–${fmt(r.e)}（${fmt(r.e - r.s)} bp）  祖先からの分岐 ${r.div.toFixed(1)}%`) } else lines.push('反復なし') }
    else { const si = Math.floor((e.offsetY - 58 - ANN_REP_H) / ANN_VAR_H); const sm = A.samples[si]; if (sm) { let v: any = null, inb = false; for (let c = c0; c <= c1; c++) { if (A.inBench.get(sm)![c]) inb = true; if (!v) v = A.varAt.get(sm)!.get(c) || null }
      lines.push(v ? `GIAB ${sm}: ${A.contig}:${fmt(v.pos + 1)} ${v.ref} → ${v.alt}  遺伝型 ${v.gt}${/^1[/|]1$/.test(v.gt) ? '（ホモ）' : '（ヘテロ）'}${v.ref.length > 1 && !v.first ? '  ＝欠失の範囲' : ''}` : (inb ? `GIAB ${sm}: 変異なし（ベンチマーク領域の中＝参照と同じと判定されている）` : `GIAB ${sm}: ベンチマーク領域の外（変異の有無は判定されていない）`)) } } } }
  if (B.genes.length && showGenes()) {   // 遺伝子: 見出しのトラック（58..58+OGH）か、この行の遺伝子
    const inTrack = e.offsetY >= 58 + annH(B) && e.offsetY < 58 + annH(B) + OGH; const hid = kr >= 0 && kr < B.lines.length ? B.lines[kr].hid : -1
    const gs = inTrack ? B.genes : (B.genesByHid.get(hid) || []); const hit = gs.filter(bg => bg.cols[ci]); const seenG = new Set<number>()
    for (const bg of hit) { if (seenG.has(bg.g.gid)) continue; seenG.add(bg.g.gid); const kd = bg.kindOf[ci]; lines.push(`遺伝子 ${bg.g.name || bg.g.locus}${bg.g.pseudo ? '（擬似）' : ''}  ${root!.haps[bg.g.hid].hap}  ${bg.g.type} 鎖 ${bg.g.strand}${bg.g.fwd ? '' : '（合意と逆向き）'}  この列は ${kd === 1 ? 'CDS' : kd === 2 ? 'エキソン' : '遺伝子内（イントロン・UTR）'}  ${bg.g.product || ''}`) }
  }
  const lnH = kr >= 0 && kr < B.lines.length ? hoverLine(B, B.lines[kr], it, lines) : null
  if (lnH) { const ln = lnH; const row = B.rows[ln.mi]
    if (it.kind === 'blk') { const a = baseBlkAllele(it, ln.mi); const e2 = B.blk.get(it.ci0)!; lines.push(`${row.label}  アレル ${a === -3 ? 'どの株とも違う（覆っている範囲で。読み取りエラーか新しい配列）' : a < 0 ? '無し' : `#${a + 1}（${e2.counts[a]} 株の行）${(row as any).read ? '  ※覆っている範囲で一致' : ''}`}`) }
    else { const ch = (B.norm[ln.mi] || row.seq)[it.ci]; const raw = row.seq[it.ci]; const cmp = baseCmpSeq(); lines.push(`${row.label}  塩基 ${ch === '-' ? '欠失' : ch === '.' ? '範囲の外' : ch === '~' ? '読んでいない' : ch}${cmp.seq && cmp.seq[it.ci] && cmp.seq[it.ci] !== ch ? `（基準 ${cmp.seq[it.ci]}）` : ''}${B.inv[ln.mi].has(it.ci) ? `  逆向きに通過（逆位。この株の向きでは ${raw}）` : ''}`) }
    for (const [ci2, side, isq, lab] of ((row as any).rins || []) as [number, number, string, string?][]) { const x = baseInsX(ci2, side); if (x != null && Math.abs(x - px) <= 4) lines.push(lab ? `${lab} ${fmt(isq.length)} bp: ${isq.length > 80 ? isq.slice(0, 80) + '…' : isq}（列は株だけで作るので、株に当てはまらない通過は列にせずここに畳む。表示の向き）` : `リードだけの挿入 ${fmt(isq.length)} bp: ${isq.length > 80 ? isq.slice(0, 80) + '…' : isq}（グラフに無い配列なので列は無い。格納向き）`) }
    { const cix = it.kind === 'col' ? it.ci : it.ci0; const bk = (B.brk[ln.mi] || []).find(b => Math.abs(b.ci - cix) <= 1); if (bk) lines.push(`継ぎ目: 同じコンティグの離れた範囲をここで繋いだ（間に ${fmt(bk.n)} トークン、窓の外）`) }
    const BE = ensureEffects(); if (BE) { const EC = BE.code.get(ln.mi); const ec = EC ? (it.kind === 'col' ? EC[it.ci] : effMaxIn(EC, it.ci0, it.ci1)) : 0; const EI = BE.info.get(ln.mi)?.get(ci)
      if (ec) lines.push(`変異の効果: ${EFF[ec]}${EI ? `  コドン ${EI.cc || '?'}→${EI.cr || '?'}（p.${AA3[EI.ac] || EI.ac}${EI.k + 1}${AA3[EI.ar] || EI.ar}）  遺伝子 ${EI.gene}` : ''}`)
      for (const L of BE.loci) { if (ci < L.cA || ci > L.cB) continue; const S = L.rows.get(ln.mi); if (!S || S.absent) continue; lines.push(`  ${L.name}（モデル ${L.modelN} 株の注釈、${L.ncodon} コドン）: 同義 ${S.syn} 非同義 ${S.mis} 終止獲得 ${S.nonsense} 終止喪失 ${S.stopLost} 開始喪失 ${S.startLost} フレームシフト ${S.fs} インフレーム ${S.inframe}  タンパク質 ${S.aaLen ?? '?'}/${S.modelAa} aa${S.lof ? '  ★機能喪失' : ''}`) } } }
  tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; tip.textContent = lines.join('\n')
  if (B.hoverCi !== ci) { B.hoverCi = ci; draw() }
}
$('minanch').addEventListener('change', () => { loadAtoms().then(loadRange) }); $('nblk').addEventListener('change', () => { blocks = makeBlocks(); if (($('order') as HTMLSelectElement).value === 'tree') hapOrder = treeOrder(); draw() })
for (const id of ['showcopies', 'showbounds', 'showreps', 'mode', 'showlines']) $(id).addEventListener('change', draw)
$('order').addEventListener('change', () => { hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice(); draw() })
$('rung').addEventListener('change', () => { if (rungSel() !== 'blocks' && !cols) loadRange(); else draw() })
$('genes').addEventListener('change', () => { if (base) { if (showGenes() && !base.genes.length) { baseGenesReq = ++baseGenesSeq; void loadBaseGenes(base) } else draw(); return } if (showGenes() && !genes.length) loadRange(); else draw() })
$('sync').addEventListener('change', () => loadRange())
$('gfilter').addEventListener('change', () => loadRange())
$('cut').addEventListener('input', () => { const v = Number(($('cut') as HTMLInputElement).value); treeCut = v >= 100 ? null : Math.pow(1 - v / 100, 2); if (($('order') as HTMLSelectElement).value === 'tree') { hapOrder = treeOrder(); draw() } })   // 棒の位置は木の横軸（平方根の尺度）
$('graphrange').addEventListener('click', () => { if (cb.onGraphRange) cb.onGraphRange(); else $('info').textContent = 'グラフの範囲を開く: 主画面でだけ使える' })
$('lgd').addEventListener('click', () => { const l = $('legend'); l.style.display = l.style.display === 'none' ? '' : 'none'; draw() })
window.addEventListener('resize', draw)
for (const [k, id] of [['mode', 'mode'], ['order', 'order'], ['nblk', 'nblk'], ['minanch', 'minanch'], ['rung', 'rung'], ['cut', 'cut']] as [string, string][]) { const v = PARAMS.get(k); if (v != null) ($(id) as HTMLInputElement).value = v }
for (const k of ['genes', 'sync', 'gfilter', 'showlines', 'showreps', 'showcopies', 'showbounds']) { const v = PARAMS.get(k); if (v != null) ($(k) as HTMLInputElement).checked = v === '1' }   // URL で再現できるように（撮影用）
{ const v = Number(($('cut') as HTMLInputElement).value); treeCut = v >= 100 ? null : Math.pow(1 - v / 100, 2) }
db = opts.db; if (!opts.page) { ($('sync') as HTMLInputElement).checked = true; $('legend').style.display = 'none' }
loadRoot()
// グラフ → パネル: ノード名を座標に直し、1 個なら前後 3,000 錨（原子の中）に寄る。多数（見えている範囲）なら 10〜90 パーセンタイルの範囲へ
async function locate(names: string[], single: boolean) {
  if (!root || !names.length) return
  // 塩基の段を見ているとき、グラフのクリック（1 ノード）は段を閉じずに、その列へ横に寄せて印を付ける（10-28: クリックで上の段に戻っていた）
  if (base && single) { const B = base; const ci = names.map(n => B.byNode.get(n)?.[0]).find(c => c != null); if (ci != null) { B.hoverCi = ci; const kk = B.colItem[ci]; const Wb = cv.parentElement!.clientWidth - LAB - 4; if (kk >= 0) B.sx = Math.max(0, Math.min(B.fullW - Wb, B.xs[kk] - Wb / 2)); draw() } return }
  if (base) { base = null; $('basegrp').style.display = 'none' }
  // POST で送る（GET だと 2,000 個の名前で URL が長すぎて失敗し、広い範囲の「グラフの範囲を開く」が黙って効かなかった）
  let j: any
  try { const r = await fetch('/api/trav/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db, names: names.slice(0, 120000) }) }); j = await r.json() } catch (e) { $('info').textContent = `グラフ → パネル: 座標の問い合わせに失敗 ${String(e)}`; $('info').style.color = '#c0392b'; return }
  // 座標を持つノードだけ。張りの広いスーパーノード（派閥が過半でない frac < 0.5）は場所を決めないので外す
  const xs: number[] = ((j.nodes || []) as { x: number; kind: number; frac?: number }[]).filter(n => n.x >= 0 && !(n.kind === -2 && (n.frac ?? 1) < 0.5)).map(n => n.x).sort((a, b) => a - b)
  if (!xs.length) { const leaf = names.filter(n => /^n\d+$/.test(n)).length; $('info').textContent = leaf ? `グラフ → パネル: 座標を持つノードが無い（錨でないノード: ${names.slice(0, 3).join(', ')}）` : `グラフ → パネル: グラフが粗い層を描いている（${names.length} 個、例 ${names.slice(0, 2).join(', ')}）。葉の層まで拡大すると座標を引ける`; $('info').style.color = '#c0392b'; return }
  hist.push(view); userMoved = true
  if (single || xs.length < 4) { const x = xs[Math.floor(xs.length / 2)]; const a = root.atoms[atomAt(x)]; view = [Math.max(a.x0, x - 3000), Math.min(a.x1, x + 3000)]; located = xs.slice() }
  else {
    // 見えているノードは 1 か所とは限らない（レイアウトで近くても座標が離れたノードが混ざる）→ 座標の隙間（R の 0.5% 以上）で連なりに分け、最も多くのノードが属する連なりを開く
    const G = Math.max(2000, Math.round(root.R * 0.005)); const runs: [number, number, number][] = []; let s0 = 0
    for (let i = 1; i <= xs.length; i++) { if (i === xs.length || xs[i] - xs[i - 1] > G) { runs.push([xs[s0], xs[i - 1], i - s0]); s0 = i } }
    runs.sort((a, b) => b[2] - a[2]); const [r0, r1, cnt] = runs[0]; const pad = Math.max(50, 0.05 * (r1 - r0 + 1))
    view = [Math.max(0, Math.floor(r0 - pad)), Math.min(root.R - 1, Math.ceil(r1 + pad))]; located = []
    if (runs.length > 1) setTimeout(() => { $('info').textContent += ` | グラフの範囲: 見えているノードは ${runs.length} か所に分かれ、最大の連なり（${cnt}/${xs.length} 個）を開いた` }, 600)
  }
  loadRange()
}
// 遺伝子の有無の一覧（10-27）: 表示範囲の遺伝子群のうち、範囲を通る株の中で無し・2 コピー以上・一部だけの株がある群を、変化の大きい順に。行のクリックでその群に寄る
// 元の遺伝子（またはその群）の写しのうち、機能喪失の目安が付いた株の数
function lofCount(o: { name: string; x0: number; x1: number; og?: number }): number { const hs = new Set<number>(); for (const gn of genes) { const lf = lof.get(gn.gid); if (!lf || lf.st === 'ok' || lf.st === 'nocds') continue; if ((o.og != null ? gn.og === o.og : (gn.name || gn.locus) === o.name) && gn.x1 >= o.x0 && gn.x0 <= o.x1) hs.add(gn.hid) } return hs.size }
function renderGpres() {
  const el = $('gptab'); if (el.style.display === 'none' || !root) return
  const base0: { name: string; x0: number; x1: number; pres?: Pres; og?: number }[] = srcPres ? srcPres : ogroups
  const rowsG = base0.filter(o => o.pres && o.pres.cover && (o.pres.n0 || o.pres.n2 || o.pres.part || lofCount(o))).sort((a, b) => (b.pres!.n0 + b.pres!.n2 + b.pres!.part) - (a.pres!.n0 + a.pres!.n2 + a.pres!.part))
  if (!showGenes()) { el.textContent = '「遺伝子」が切れている。入れると一覧を作る'; return }
  if (!ogroups.length) { el.textContent = genesNote ? `${genesNote}（一覧は遺伝子を読める範囲で作る。数 Mb 以下に狭める）` : '遺伝子を読み込み中、またはこの範囲に遺伝子が無い'; return }
  if (!rowsG.length) { el.textContent = `表示範囲の${srcPres ? '遺伝子' : '遺伝子群'} ${(srcPres ? new Set(genes.map(g => (g as any).proj ?? g.gid)).size : ogroups.length).toLocaleString()} 個は、範囲を通る全株で 1 コピーずつ（有無・コピー数の違いは無い）`; return }
  const esc = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const hn = (hs: number[]) => esc(hs.slice(0, 8).map(h => root!.haps[h].hap).join(', ') + (hs.length > 8 ? ` ほか ${hs.length - 8}` : ''))
  el.innerHTML = `<div style="color:#555;margin-bottom:2px">表示範囲の${srcPres ? '遺伝子（参照の注釈を各株に写したもの）' : '遺伝子群'}のうち、株によって有無・コピー数が違うもの ${rowsG.length} 個（違いの大きい順）</div>` +
    `<div style="color:#555;margin:2px 0 4px">各列は株の数。「範囲を通る株」＝その遺伝子の座標範囲にコンティグが掛かる株（届かない株は数えない）。「持たない」＝範囲を通るのに遺伝子が無い（欠失）。「2 コピー以上」＝同じ遺伝子が 2 つ以上。「一部だけ」＝あるが参照との一致が 80% 未満（部分的な欠失・融合など）。「機能喪失の目安」＝その株の配列で CDS を組み立てて翻訳すると、参照の 9 割未満で止まる・長さの差が 3 の倍数でない・開始コドンが無い株（境界の写し方の誤差を含む目安。参照の注釈の 1 割弱は参照自身でも完結しない）。右端はそれぞれに当たる株の名前（クリックでその遺伝子に寄る）</div>` +
    `<table style="border-collapse:collapse"><tr style="text-align:left;border-bottom:1px solid #ccc"><th style="padding:2px 8px">${srcPres ? '遺伝子' : '遺伝子群'}</th><th style="padding:2px 8px">範囲を通る株</th><th style="padding:2px 8px;color:#d62728">持たない</th><th style="padding:2px 8px;color:#1f63c6">2 コピー以上</th><th style="padding:2px 8px;color:#f39c12">一部だけ</th><th style="padding:2px 8px;color:#8e0000">機能喪失の目安</th><th style="padding:2px 8px">該当する株</th></tr>` +
    rowsG.map((o, i) => `<tr data-i="${i}" style="cursor:pointer;border-top:1px solid #eee"><td style="padding:2px 8px">${esc(o.name || '#' + (o.og ?? ''))}</td><td style="padding:2px 8px;text-align:right">${o.pres!.cover}</td><td style="padding:2px 8px;text-align:right">${o.pres!.n0 || ''}</td><td style="padding:2px 8px;text-align:right">${o.pres!.n2 || ''}</td><td style="padding:2px 8px;text-align:right">${o.pres!.part || ''}</td><td style="padding:2px 8px;text-align:right">${lofCount(o) || ''}</td><td style="padding:2px 8px;color:#555">${o.pres!.n0 ? '<span style="color:#d62728">持たない</span> ' + hn(o.pres!.absent) + '　' : ''}${o.pres!.n2 ? '<span style="color:#1f63c6">2 コピー以上</span> ' + hn(o.pres!.multi) + '　' : ''}${o.pres!.part ? '<span style="color:#f39c12">一部だけ</span> ' + hn(o.pres!.partial) : ''}</td></tr>`).join('') + '</table>'
  el.querySelectorAll('tr[data-i]').forEach(tr => tr.addEventListener('click', () => { const o = rowsG[Number((tr as HTMLElement).dataset.i)]; const pad = Math.max(50, (o.x1 - o.x0) * 0.5); hist.push(view); view = [Math.max(0, Math.floor(o.x0 - pad)), Math.min(root!.R - 1, Math.ceil(o.x1 + pad))]; userMoved = true; loadRange() }))
}
if (PARAMS.get('gpres') === '1') $('gptab').style.display = 'block'   // URL で一覧を開く（撮影用）
$('gpres').addEventListener('click', () => { const el = $('gptab'); el.style.display = el.style.display === 'none' ? 'block' : 'none'; if (!($('genes') as HTMLInputElement).checked) { ($('genes') as HTMLInputElement).checked = true; loadRange() } else renderGpres() })
// 書き出し（10-28）: FASTA。整列は列のとおり（- 欠失、. 範囲の外。表示の向き＝参照の向き）。実際の向きの整列は逆位の区間を株の向きの文字で。各株の配列はコンティグの向きの本当の配列（整列なし）
function baseExport(kind: string, which: string) {
  const B = base; if (!B) return
  let mis: number[] = which === 'shown' ? B.lines.flatMap(l => l.cov ? B.rows.map((_, i) => i).filter(i => (B.rows[i] as any).read?.sample === l.cov) : (l.pack || [l.mi])) : B.rows.map((_, i) => i)
  if (which === 'marked') { mis = B.rows.map((_, i) => i).filter(i => { const ln = B.lines.find(l => l.mi === i); return (ln && ln.hid >= 0) ? !!markOf(root!.haps[ln.hid].hap) : !!markOf(B.rows[i].label.split(' ')[0]) }); if (!mis.length) { alert('主画面でパス（株）を選んでから'); return } }
  const wrap = (t: string) => t.replace(/(.{80})/g, '$1\n').replace(/\n$/, '')
  const out: string[] = []
  for (const mi of mis) { const r = B.rows[mi] as any
    const hdr = `>${r.label.replace(/\s+/g, '_')} path=${r.path} strand=${r.strand}${(B.inv[mi] && B.inv[mi].size) ? ' inv_cols=' + B.inv[mi].size : ''}`
    const body = kind === 'seq' ? (r.hseq || r.seq.replace(/[-.~]/g, '')) : kind === 'alnt' ? (r.seqt || r.seq) : r.seq
    out.push(hdr + (kind === 'seq' ? ' (contig orientation, unaligned)' : ' (aligned, display orientation)'), wrap(body)) }
  const blob = new Blob([out.join('\n') + '\n'], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = `${db.replace(/\.db$/, '')}_${Math.floor(view[0])}-${Math.ceil(view[1])}_${kind}.fa`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
}
$('breads').addEventListener('change', () => { if (base) draw() })
$('bann').addEventListener('change', () => { if (!base) return; if (annOn() && !base.ann && (root as any)?.hasAnn) void loadBaseAnn(base); else draw() })
$('bexp').addEventListener('change', () => { const el = $('bexp') as HTMLSelectElement; const k = el.value; el.value = ''; if (k) baseExport(k, ($('bexpw') as HTMLSelectElement).value) })
// 状態の書き出し・復元（Share view）: 表示範囲と主な設定。塩基の段は開いているかだけ（開いていれば復元時に開き直す）
const TRAV_SEL = ['mode', 'order', 'nblk', 'minanch', 'rung', 'cut', 'cmp']; const TRAV_CHK = ['genes', 'sync', 'gfilter', 'showlines', 'showreps', 'showcopies', 'showbounds', 'bdiff', 'bvar', 'bfold']
function getState(): any { const st: any = { db, view: [Math.floor(view[0]), Math.ceil(view[1])], base: !!base, sel: {}, chk: {} }
  for (const k of TRAV_SEL) { const el = document.getElementById('tv_' + k) as HTMLInputElement | null; if (el) st.sel[k] = el.value }
  for (const k of TRAV_CHK) { const el = document.getElementById('tv_' + k) as HTMLInputElement | null; if (el) st.chk[k] = el.checked } return st }
function setState(st: any, tries = 0) { if (!st) return; if (!root || (st.db && st.db !== db)) { if (tries < 40) setTimeout(() => setState(st, tries + 1), 500); return }   // パネルが DB を読み終えるまで待つ
  for (const [k, v] of Object.entries(st.sel || {})) { const el = document.getElementById('tv_' + k) as HTMLInputElement | null; if (el) el.value = String(v) }
  for (const [k, v] of Object.entries(st.chk || {})) { const el = document.getElementById('tv_' + k) as HTMLInputElement | null; if (el) el.checked = !!v }
  if (($('cut') as HTMLInputElement).value) $('cut').dispatchEvent(new Event('input'))
  if (Array.isArray(st.view) && st.view.length === 2) { view = [Math.max(0, Number(st.view[0])), Math.min(root.R - 1, Number(st.view[1]))]; userMoved = true }
  if (st.base) { baseAutoState = true } blocks = makeBlocks(); void loadRange() }
let baseAutoState = false
return { getState, setState, setDb(d: string) { db = d; located = []; loadRoot() }, locateNodes(names: string[]) { void locate(names, true) }, openNames(names: string[]) { void locate(names, false) }, setHapMarks(m: Map<string, string>) { hapMarks = m; draw() }, graphMoved() { if (rangeMode === 'none' || base) return; if (graphMovedTimer) clearTimeout(graphMovedTimer); graphMovedTimer = setTimeout(() => { graphMovedTimer = null; if (($('sync') as HTMLInputElement).checked) void rangeByLocate(loading) }, 500) }, resetLinks() { ($('sync') as HTMLInputElement).checked = false; ($('gfilter') as HTMLInputElement).checked = false; cb.onRange?.(null); cb.onFilter?.(null); cb.onVisible?.(null) }, destroy() { loading++; window.removeEventListener('mouseup', onWinUp); window.removeEventListener('resize', draw); if (opts.page) { window.removeEventListener('error', onWinErr); window.removeEventListener('unhandledrejection', onWinRej) } host.innerHTML = '' } }

}

