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
type Trav = { id: number; pid: number; hid: number; i0: number; i1: number; x0: number; x1: number; dir: number; copy: number; nanch: number; bp: number; bp0?: number }
type Copy = { id: number; pid: number; hid: number; x0: number; x1: number; ia0: number; ia1: number; ib0: number; ib1: number; bpa: number; bpb: number }
type Rep = { id: number; pid: number; hid: number; i0: number; i1: number; bp: number; x0: number; x1: number }
type AtomStat = { id: number; nhap: number; nhap2: number; tangled?: boolean; counts: Record<string, number> }
type Root = { meta: any; H: number; R: number; total_bp: number; haps: Hap[]; atoms: Atom[]; bounds: Bound[] }
type Block = { id: number; x0: number; x1: number; bp: number; a0: number; a1: number; nhap: number; nhap2: number; tangled: boolean }
// 錨の列（ブロックと塩基の間の段）: /api/trav/cols。列＝表示範囲を画面幅で等分した座標区間。行＝通過。pres 錨の有無（0–255）、cls アレル番号（0 多数派、255 掛からない）、ins 挿入 bp
type ColRow = { id: number; pid: number; hid: number; dir: number; copy: number; tw0: number; tw1: number; pres: Uint8Array; cls: Uint8Array; ins: Uint16Array }
type Cols = { x0: number; x1: number; ncol: number; ntok: number; nanch: Uint16Array; ncls: Uint8Array; nrow: Uint16Array; major: Uint16Array; rows: ColRow[]; byId: Map<number, ColRow> }
const CLS_COL = ['#c9ced2', '#e67e22', '#2980b9', '#27ae60', '#8e44ad', '#c0392b', '#16a085', '#d35400', '#7f8c8d']   // アレル番号 → 色（0 多数派は灰）
const u8 = (b: string) => Uint8Array.from(atob(b), ch => ch.charCodeAt(0)); const u16 = (b: string) => { const a = u8(b); return new Uint16Array(a.buffer, a.byteOffset, a.byteLength >> 1) }

type Gene = { gid: number; pid: number; hid: number; tr: number; x0: number; x1: number; s0: number; e0: number; start: number; end: number; strand: string; fwd: boolean; type: string; name: string; locus: string; product: string; pseudo: boolean; anchored: boolean }
export interface TravCallbacks {
  onBaseMsa?: (ranges: [number, number, number][], label: string) => void   // 塩基へ: [distill のパス番号, s0, e0) の列
  onVisible?: (v: { names: string[]; sync: boolean } | null) => void          // 表示範囲の錨のノード名（グラフを寄せる・強調）
  onSelectHap?: (hap: string) => void                                          // 行ラベルのクリック
  onFilter?: (sel: { names: string[] } | null) => void                         // グラフをこの範囲に絞る（葉の名前の集合）／解除
  onGraphRange?: () => void                                                    // 「グラフの範囲を開く」: 主画面が見えているノード名を openNames に渡す
}
export interface TravOpts { db: string; params?: URLSearchParams; page?: boolean }   // page: 試作ページ（window のエラー表示、説明を開いたまま、グラフ連動なし）
export interface TravHandle { setDb(db: string): void; destroy(): void; locateNodes(names: string[]): void; openNames(names: string[]): void }
const BODY = "<div class=\"tv-bar\">\n  <label>錨の床 <input id=\"tv_minanch\" type=\"number\" value=\"50\" min=\"0\" step=\"10\"></label>\n  <label>ブロック <input id=\"tv_nblk\" type=\"number\" value=\"30\" min=\"1\" max=\"500\" step=\"5\"></label>\n  <button id=\"tv_all\">全体</button><button id=\"tv_back\">戻る</button>\n  <label>並び <select id=\"tv_mode\"><option value=\"coord\">合意座標</option><option value=\"rows\">各行の並び</option></select></label>\n  <label title=\"ブロックの段と塩基の間の段。錨の列＝表示範囲を画面の列に等分し、行ごとに錨の有無（濃さ）と錨の間のアレル（色。灰＝多数派、色＝少数派のアレル番号）と挿入（上辺の黒）を出す。自動＝ブロックが 3 個以下か 200 kb 以下で切り替え\">段 <select id=\"tv_rung\"><option value=\"auto\">自動</option><option value=\"blocks\">ブロック</option><option value=\"cols\">錨の列</option></select></label>\n  <button id=\"tv_base\" disabled title=\"錨の列の段で使える\">塩基へ ↓</button><button id=\"tv_graphrange\" title=\"グラフで今見えているノードの座標の範囲（10〜90 パーセンタイル）にパネルを移す\">グラフの範囲を開く</button>\n  <label><input id=\"tv_showlines\" type=\"checkbox\" checked> 連結線</label>\n  <label>並べ替え <select id=\"tv_order\"><option value=\"tree\">表示範囲の木</option><option value=\"name\">名前</option></select></label>\n  <span id=\"tv_cutwrap\" title=\"系統樹の高さの閾値。左へ動かすほど多くの枝をまとめる（右端で解除）。まとめた枝は代表 1 株（群の中心＝他との距離の和が最小）だけを出し、行頭に +n、木には三角\"><input type=\"range\" id=\"tv_cut\" min=\"0\" max=\"100\" value=\"100\" style=\"width:90px;vertical-align:middle\"><small id=\"tv_cuttxt\" style=\"color:#666\"></small></span>\n  <label title=\"各行の片の下に、その株の遺伝子（.genes サイドカー）を置く。緑＝合意の向きに +、橙＝−、灰＝擬似。ホバーで名前・産物\"><input id=\"tv_genes\" type=\"checkbox\" checked> 遺伝子</label>\n  <label title=\"表示範囲を変えると、グラフをその範囲の錨のノードに寄せて強調する\"><input id=\"tv_sync\" type=\"checkbox\"> グラフ連動</label>\n  <label title=\"グラフに、この表示範囲に属するノード（錨と、錨の間の錨でないノード）だけを描く。範囲外へ繋がる辺は切れ端になる。ノードが 2 万を超える範囲では先頭 2 万個だけ\"><input id=\"tv_gfilter\" type=\"checkbox\"> グラフを絞る</label>\n  <label><input id=\"tv_showcopies\" type=\"checkbox\" checked> コピー</label>\n  <label><input id=\"tv_showreps\" type=\"checkbox\" checked> 反復</label>\n  <label><input id=\"tv_showbounds\" type=\"checkbox\" checked> 境界</label>\n  <button id=\"tv_lgd\" title=\"凡例・説明の表示／非表示\">説明</button>\n  <span id=\"tv_busy\" style=\"color:#c0392b;font-weight:600;display:none\">計算中…</span>\n  <span id=\"tv_info\"></span>\n</div>\n<div id=\"tv_legend\" class=\"tv-legend\"><b>上段</b> 四角＝ブロック（表示範囲を持続度の高い境界で「ブロック」個に切った区間。横幅は bp に比例、高さ＝通るハプロタイプの割合、色は番号）／赤い帯＝反復の裏付けつきで 2 回以上通る株がある／灰色の覆いと「?」＝もつれ（順序が線形にならない領域、×n は数えない）／縦線＝境界（赤 支持 ≥50%・灰 ≥2 株・薄灰 1 株。高さ＝持続度＝その境界を潰したときの原子の幅。大きいほど大きなブロックを分ける境界）／ダブルクリックでそのブロックに寄る\n  <b>行</b> 色＝ブロック（同じ色＝同じブロック。株間の対応）／三角＝向き／<span style=\"color:#8e44ad\">紫の枠と左向き三角、下段</span>＝コンティグの主な向きと逆（逆位）／<span style=\"color:#333\">黒の破線</span>＝転座（コンティグ上の前後の通過から座標が 2 万錨以上離れている）／各行の並び: 1 コンティグの株は主な向きで鏡にし座標最小の通過を左に回す（環状）／連結線＝bp で等間隔に標本し、隣の行の同じ場所を結ぶ（交差＝逆位・転座、無い＝持たない、二又＝重複）。範囲の拡大は上段のドラッグ（ホイールは無効）。拡大すると境界が増え、原子まで細かくなる。左の木＝表示範囲の UPGMA（枝の長さ＝ブロックの有無・向きの不一致率）／<span style=\"color:#7a1414\">上辺の濃い赤</span>＝反復（その株で 2 回以上出るノードの連なり＝重複の本体）／<span style=\"color:#d35400\">薄いオレンジ ·n</span>＝座標の再訪（同じコンティグの別の通過と座標が重なる。弱い指標）／下辺の赤＝再訪の重なり部分\n  <b>錨の列（ブロックと塩基の間の段）</b> 各行を画面の列（1 列＝数錨〜数百錨）に切り、<span style=\"color:#888\">灰</span>＝その列のトークン列が多数派と同じ、<span style=\"color:#e67e22\">橙</span>・<span style=\"color:#2980b9\">青</span>・<span style=\"color:#27ae60\">緑</span>…＝少数派のアレル（番号順。同じ色＝同じ配列）、薄い＝その列の錨を一部しか持たない（欠失）、上辺の黒＝錨でない配列の挿入（高さは bp の対数）、白＝通過はあるが錨が無い。上段の帯＝列ごとのアレルの種類数（灰 1 種→赤 多い）と行の数（高さ）。下辺 2 px にブロックの色を残す。ホバーで列の錨数・アレル数・この行のトークン範囲（塩基 MSA へ渡す範囲）\n  <b>行頭</b> +n冗長＝丸ごと別コンティグに含まれるコンティグ数／×n＝表示が 1 原子に収まるときの通過回数／(n)＝表示範囲内の通過数\n  <b>遺伝子レーン</b> 片の下の帯＝その株の遺伝子（緑 合意の向きに +、橙 −、灰 擬似）。錨の無い遺伝子は通過の中の位置から補間\n</div>\n<div id=\"tv_wrap\" class=\"tv-wrap\"><canvas id=\"tv_cv\"></canvas><canvas id=\"tv_ov\"></canvas><div id=\"tv_tip\"></div></div>\n"
const CSS = ".tvpanel { display:flex; flex-direction:column; height:100%; font:12px/1.4 system-ui, sans-serif; color:#222; background:#fafafa; }\n.tvpanel .tv-bar { display:flex; gap:10px; align-items:center; padding:4px 10px; background:#fff; border-bottom:1px solid #ddd; flex-wrap:wrap; flex-shrink:0; }\n.tvpanel .tv-bar label { color:#555; } .tvpanel .tv-bar input[type=number] { width:70px; } .tvpanel button { font:inherit; }\n.tvpanel #tv_info { color:#444; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:60vw; }\n.tvpanel .tv-legend { font-size:11px; color:#444; padding:4px 10px; border-bottom:1px solid #e5e5e5; background:#fdfdfd; line-height:1.5; flex-shrink:0; } .tvpanel .tv-legend b { margin-right:4px; }\n.tvpanel .tv-wrap { position:relative; flex:1; min-height:0; overflow:auto; } .tvpanel canvas { display:block; } .tvpanel #tv_ov { position:absolute; left:0; top:0; pointer-events:none; }\n.tvpanel #tv_tip { position:fixed; pointer-events:none; background:rgba(30,30,30,.92); color:#fff; padding:4px 7px; border-radius:3px; font-size:11px; display:none; max-width:420px; white-space:pre; z-index:9; }"
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
let treeCut: number | null = null          // 系統樹のまとめ: 併合の高さがこれ（根の高さに対する割合）以下の枝を代表 1 株に（null＝まとめない）
let groupOf = new Map<number, number[]>()  // 代表 hid → まとめた枝の hid 一覧
let located: number[] = []                 // グラフから来た座標（縦線の印）
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
  const vq = PARAMS.get('view'); if (vq) { const [a, b] = vq.split('-').map(Number); if (Number.isFinite(a) && Number.isFinite(b)) view = [Math.max(0, a), Math.min(root!.R - 1, b)] }
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
    blocks = makeBlocks()
    hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice()
    const nh2 = Object.values(perHap).filter(n => (n as number) >= 2).length
    $('info').textContent = `${db}: 座標 ${fmt(Math.floor(view[0]))}–${fmt(Math.ceil(view[1]))} / ${fmt(root.R)}（${fmtbp(j.bp0)}–${fmtbp(j.bp1)}） ブロック ${blocks.length}（原子 ${root.atoms.length}） 通過 ${fmt(rows.length)} コピー ${fmt(copies.length)} 2 回以上通る株 ${nh2} | 錨 強 ${fmt(root.meta.strong)} 補間 ${fmt(root.meta.interp)}`
    cols = null; colsNote = ''
    if (wantCols()) {   // 錨の列: まずブロックの段を描いてから取りに行く
      draw()
      const rc = await getJson(`/api/trav/cols?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&ncol=${Math.floor(bodyPx())}&minanch=${numOf('minanch', 50)}`)
      if (my !== loading) return
      const jc = await rc.json()
      if (jc.tooBig) colsNote = `錨の列: 範囲が広すぎる（トークン ${fmt(jc.ntok)} > ${fmt(jc.max)}）`
      else if (jc.error) colsNote = `錨の列: ${jc.error}`
      else { const rc2: ColRow[] = (jc.rows as any[]).map(r => ({ ...r, pres: u8(r.pres), cls: u8(r.cls), ins: u16(r.ins) })); cols = { x0: jc.x0, x1: jc.x1, ncol: jc.ncol, ntok: jc.ntok, nanch: u16(jc.cols.nanch), ncls: u8(jc.cols.ncls), nrow: u16(jc.cols.nrow), major: u16(jc.cols.major), rows: rc2, byId: new Map(rc2.map(r => [r.id, r])) } }
      $('info').textContent = (colsNote ? colsNote : `錨の列 ${fmt(jc.ncol)} 列（トークン ${fmt(jc.nread)}・${fmt(jc.ms)} ms）`) + ' | ' + $('info').textContent
      if (cols && ($('order') as HTMLSelectElement).value === 'tree') hapOrder = treeOrder()   // 木を錨の列（アレル）で作り直す
    }
    updateBase()
    genes = []; genesNote = ''
    if (showGenes()) {   // 遺伝子レーン: 通過ごとの遺伝子を座標に写したもの
      draw()
      const rg = await getJson(`/api/trav/genes?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}`)
      if (my !== loading) return
      const jg = await rg.json()
      if (jg.tooMany) genesNote = `遺伝子: 多すぎる（${fmt(jg.n)} > ${fmt(jg.max)}。範囲を狭める）`; else if (jg.error) genesNote = `遺伝子: ${jg.error}`; else genes = jg.genes as Gene[]
      if (genesNote) $('info').textContent += ' | ' + genesNote; else $('info').textContent += ` | 遺伝子 ${fmt(genes.length)}`
    }
    if (cb.onFilter && ($('gfilter') as HTMLInputElement).checked) {   // グラフを絞る: 表示範囲のノード（葉）の名前の集合を主画面へ
      const rf = await getJson(`/api/trav/nodeset?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&minanch=${numOf('minanch', 50)}&max=20000`)
      if (my !== loading) return
      const jf = await rf.json()
      if (jf.tooBig || jf.error) { $('info').textContent += ` | グラフを絞る: ${jf.error || '範囲が広すぎる'}`; cb.onFilter(null) }
      else { cb.onFilter({ names: jf.names as string[] }); if (jf.truncated) $('info').textContent += ` | グラフを絞る: ノード ${fmt(jf.n)} で打ち切り` }
    }
    if (cb.onVisible && ($('sync') as HTMLInputElement).checked) {   // グラフ連動: 表示範囲の錨のノード名を主画面へ（寄せる・強調）
      const rn = await getJson(`/api/trav/nodes?db=${encodeURIComponent(db)}&x0=${Math.floor(view[0])}&x1=${Math.ceil(view[1])}&max=1500`)
      if (my !== loading) return
      const jn = await rn.json(); cb.onVisible({ names: (jn.names || []) as string[], sync: true })
    }
  } catch (e) { showErr('range', e) }
  $('busy').style.display = 'none'; draw()
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
  const ranges = cols.rows.filter(r => r.tw0 >= 0).map(r => [r.pid, r.tw0, r.tw1 + 1] as [number, number, number]); const label = `通過 ${fmt(Math.floor(view[0]))}–${fmt(Math.ceil(view[1]))}`
  if (cb.onBaseMsa) cb.onBaseMsa(ranges, label); else $('info').textContent = `塩基へ: ${ranges.length} 行を渡す（主画面の Traversals パネルで開く）`
})
// ---- 表示範囲の木（UPGMA）: ブロックごとの状態（無し/順/逆/両方）の bp 重み不一致率 ----
function treeOrder(): number[] {
  treeRoot = null
  if (!root || !blocks.length) return baseOrder.slice()
  const H = root.haps.length, nb = blocks.length
  const ids = baseOrder.slice(); const n = ids.length; const D: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  if (cols && wantCols()) {   // 錨の列の段: ハプロタイプごとの列のアレル番号（複数の通過は先のもの）。距離＝両方が持つ列のうちアレルが違う列の割合
    const C = cols; const st = new Int16Array(H * C.ncol).fill(-1)
    for (const r of C.rows) { const base = r.hid * C.ncol; for (let c = 0; c < C.ncol; c++) { const k = r.cls[c]; if (k !== 255 && st[base + c] < 0) st[base + c] = k } }
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
      if (c.leaves.length > 1) { let best = Infinity; for (const a of c.leaves) { let sum = 0; for (const b of c.leaves) sum += D[idxOf.get(a)!][idxOf.get(b)!]; if (sum < best) { best = sum; rep = a } } }
      c.rep = rep; c.collapsed = c.leaves.length > 1; reps.push(rep); groupOf.set(rep, c.leaves.slice())
    } else c.kids.forEach(visit)
  }
  visit(treeRoot); return reps
}

// ---- 描画 ----
type Piece = { blk: number; px0: number; px1: number; tr: Trav; inv: boolean; disp: boolean; fwd: boolean; c0: number; c1: number }
let lastPieces = new Map<number, Piece[]>()
function draw() { try { drawCore() } catch (e) { showErr('draw', e) } }
function drawCore() {
  const useCols = !!cols && wantCols(); TOP = useCols ? 88 : 70
  const W = cv.parentElement!.clientWidth; const mode = ($('mode') as HTMLSelectElement).value; ROW = (mode === 'rows' ? 22 : 15) + (genes.length && showGenes() ? 8 : 0)   // 遺伝子レーンの分
  const H = TOP + (root ? hapOrder.length * ROW : 0) + 20
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ov.width = cv.width; ov.height = cv.height; ov.style.width = cv.style.width; ov.style.height = cv.style.height; og.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, W, H)
  if (!root) return
  const [v0, v1] = view; const BB = TOP - (useCols ? 30 : 12)   // ブロックの帯の底（錨の列の帯を出すときはその上）
  // 上段: ブロック（色は番号、高さは通るハプロタイプの割合）、×n の赤い帯、もつれの縦縞、境界（支持と持続度）
  for (const b of blocks) {
    const px0 = Math.max(LAB, X(b.x0)), px1 = Math.min(W, X(b.x1 + 1)); const h = 8 + 30 * Math.min(1, b.nhap / root.H)
    g.fillStyle = `hsla(${hue(b.id)}, 70%, 50%, .85)`; g.fillRect(px0, BB - h, Math.max(1, px1 - px0), h); g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.strokeRect(px0 + .5, BB - h + .5, Math.max(1, px1 - px0) - 1, h - 1)
    if (b.nhap2 > 0) { g.fillStyle = 'rgba(192,57,43,.9)'; g.fillRect(px0, BB, Math.max(1, px1 - px0), 3) }
    if (b.tangled) { g.fillStyle = 'rgba(120,120,120,.45)'; g.fillRect(px0, BB - h, Math.max(1, px1 - px0), h); if (px1 - px0 > 10) { g.fillStyle = '#fff'; g.font = 'bold 11px system-ui'; g.fillText('?', (px0 + px1) / 2 - 3, BB - h / 2 + 4) } }
    if (px1 - px0 > 44) { g.fillStyle = '#333'; g.font = '10px system-ui'; g.fillText(`${fmtbp(b.bp)} ${b.nhap}/${root.H}${b.nhap2 ? ` ×${b.nhap2}` : ''}`, px0 + 2, BB - 2 - h) }
  }
  if (useCols && cols) {   // 錨の列の帯: 列ごとのアレルの種類数（灰 1 種 → 橙 → 赤）、高さ＝その列に掛かる行の数
    const C = cols; const Wc = C.x1 - C.x0 + 1; const SY0 = TOP - 24, SH = 10; let maxrow = 1; for (let c = 0; c < C.ncol; c++) if (C.nrow[c] > maxrow) maxrow = C.nrow[c]
    for (let c = 0; c < C.ncol; c++) {
      const n = C.nrow[c]; if (!n) continue; const pa = Math.max(LAB, X(C.x0 + c * Wc / C.ncol)), pb = Math.min(W, X(C.x0 + (c + 1) * Wc / C.ncol)); const k = C.ncls[c]; const h = Math.max(1, SH * n / maxrow); const f = Math.min(1, Math.max(0, (k - 2) / 6))
      g.fillStyle = k <= 1 ? '#c9ced2' : `hsl(${30 - 30 * f}, 80%, ${55 - 15 * f}%)`; g.fillRect(pa, SY0 + SH - h, Math.max(1, pb - pa), h)
    }
    g.fillStyle = '#666'; g.font = '10px system-ui'; const lbl = '錨の列: アレルの種類数'; g.fillText(lbl, LAB - g.measureText(lbl).width - 4, SY0 + SH - 1)
  }
  if (($('showbounds') as HTMLInputElement).checked) for (const b of root.bounds) {
    if (b.x < v0 || b.x > v1) continue
    const px = X(b.x); const h = 6 + 8 * Math.log10(1 + b.persistence / 1000)
    g.strokeStyle = b.support >= root.H * 0.5 ? '#c0392b' : b.support >= 2 ? '#7f8c8d' : '#d0d0d0'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, TOP - 10); g.lineTo(px, TOP - 10 + h); g.stroke()
  }
  g.fillStyle = '#666'; g.font = '10px system-ui'; g.fillText(`${fmtbp(bpOfX(v0))}  x ${fmt(Math.floor(v0))} ${refPos(v0)}`, LAB + 2, TOP - 2); const tt = `${refPos(v1)} x ${fmt(Math.ceil(v1))}  ${fmtbp(bpOfX(v1 + 1))}`; g.fillText(tt, W - g.measureText(tt).width - 4, TOP - 2)

  // 行: 通過をブロックごとの片に割る。合意座標モードは片をその座標の位置に、各行の並びモードはコンティグの順に詰める
  const byHap = new Map<number, Trav[]>(); for (const r of rows) { if (!byHap.has(r.hid)) byHap.set(r.hid, []); byHap.get(r.hid)!.push(r) }
  const cpByHap = new Map<number, Copy[]>(); for (const c of copies) { if (!cpByHap.has(c.hid)) cpByHap.set(c.hid, []); cpByHap.get(c.hid)!.push(c) }
  const rpByHap = new Map<number, Rep[]>(); for (const c of reps) { if (!rpByHap.has(c.hid)) rpByHap.set(c.hid, []); rpByHap.get(c.hid)!.push(c) }
  const piecesOf = new Map<number, Piece[]>(); const fullView = v0 <= 0 && v1 >= root.R - 2
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
    type Raw = { blk: number; tr: Trav; c0: number; c1: number; key: number; wbp: number; fwd: boolean }
    const raw: Raw[] = []
    for (const r of ts) for (let bi = blockAt(r.x0); bi < blocks.length && blocks[bi].x0 <= r.x1; bi++) {
      const b = blocks[bi]; if (b.x1 < r.x0) continue
      const c0 = Math.max(b.x0, r.x0), c1 = Math.min(b.x1, r.x1); const Lx = Math.max(1, r.x1 - r.x0 + 1); const f0 = (c0 - r.x0) / Lx, f1 = (c1 + 1 - r.x0) / Lx
      const [q0, q1] = r.dir >= 0 ? [f0, f1] : [1 - f1, 1 - f0]; const bpA = (r.bp0 ?? 0) + q0 * r.bp, bpB = (r.bp0 ?? 0) + q1 * r.bp   // コンティグ上の bp 区間（格納向き）
      const mir = domOf.get(r.pid)! < 0; const key = mir ? -bpB : bpA   // 読む向き（主な向き）に並ぶ鍵
      raw.push({ blk: bi, tr: r, c0, c1, key, wbp: Math.max(1, bpB - bpA), fwd: (r.dir >= 0) !== mir })
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
      const total = raw.reduce((t, q) => t + q.wbp, 0) + 1; const gapBp = total * 0.004; let cum = 0, lastPid = -1
      const scale = (W - LAB) / (total + gapBp * Math.max(0, pids.length - 1))
      for (const q of raw) {
        if (lastPid >= 0 && q.tr.pid !== lastPid) cum += gapBp
        lastPid = q.tr.pid; const px0 = LAB + cum * scale; cum += q.wbp; const px1 = LAB + cum * scale
        pcs.push({ blk: q.blk, px0, px1, tr: q.tr, inv: inv.has(q.tr), disp: disp.has(q.tr), fwd: q.fwd, c0: q.c0, c1: q.c1 })
      }
    }
    piecesOf.set(hid, pcs)
  }
  lastPieces = piecesOf
  const genesByTr = new Map<number, Gene[]>(); if (genes.length && showGenes()) for (const gn of genes) { if (!genesByTr.has(gn.tr)) genesByTr.set(gn.tr, []); genesByTr.get(gn.tr)!.push(gn) }
  hapOrder.forEach((hid, k) => {
    const y = TOP + k * ROW; const hap = root!.haps[hid]
    g.fillStyle = k % 2 ? '#f2f2f2' : '#fafafa'; g.fillRect(0, y, W, ROW)
    const n = perHap[hid] || 0; const oneBlk = blocks.length === 1
    g.fillStyle = oneBlk && n >= 2 ? '#b03a2e' : '#333'; g.font = '11px system-ui'; const grp = groupOf.get(hid); g.fillText(`${hap.hap}${grp && grp.length > 1 ? ` +${grp.length - 1}` : ''}${hap.nexcl ? ` +${hap.nexcl}冗長` : ''}${oneBlk && n >= 2 ? ` ×${n}` : (n > 1 ? ` (${n})` : '')}`, TREEW + 4, y + 10)
    const pcs = piecesOf.get(hid) || []
    for (const p of pcs) {
      const px0 = Math.max(LAB, Math.min(p.px0, p.px1)), px1 = Math.min(W, Math.max(p.px0, p.px1)); const w = Math.max(1, px1 - px0); const yy = y + 2, hh = BLK
      // 片の中は合意の向きに明→暗。画面上で左が合意の先頭なら明→暗、逆（逆位・逆鎖）なら暗→明
      if (useCols && cols) {   // 錨の列の段: 片の中を列のセルで塗り、ブロックの色は下辺 2 px に残す
        g.fillStyle = '#fff'; g.fillRect(px0, yy, w, hh - 2); g.fillStyle = `hsla(${hue(p.blk)}, 70%, 46%, 1)`; g.fillRect(px0, yy + hh - 2, w, 2)
        const cr = cols.byId.get(p.tr.id); if (cr) drawCells(cr, p, px0, px1, yy, hh - 2, mode)
      } else { g.fillStyle = `hsla(${hue(p.blk)}, 70%, 46%, ${p.tr.copy >= 1 ? .55 : 1})`; g.fillRect(px0, yy, w, hh) }
      if (w >= 3) { g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.strokeRect(px0 + .5, yy + .5, w - 1, hh - 1) }   // ブロック境界の枠
      if (mode === 'rows' && !p.fwd) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(px0, yy + hh - 2, w, 2) }   // 各行の並びで読む向きと逆（逆位）は下辺を暗く
      if (p.inv) { g.strokeStyle = '#8e44ad'; g.lineWidth = 2; g.strokeRect(px0 + 1, yy + 1, Math.max(1, w - 2), hh - 2); if (w > 10) { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(px0 + 7, yy + 1); g.lineTo(px0 + 2, yy + hh / 2); g.lineTo(px0 + 7, yy + hh - 1); g.fill() } }
      else if (p.disp) { g.strokeStyle = '#333'; g.lineWidth = 1; g.setLineDash([3, 2]); g.strokeRect(px0 + .5, yy + .5, w - 1, hh - 1); g.setLineDash([]) }   // 転座（多数派の位置と違う所にある片）は各行の並びでも破線で
    }
    for (const r of byHap.get(hid) || []) {   // 通過ごとに向きの三角（右端または左端）とコピー番号
      const ps = pcs.filter(p => p.tr === r); if (!ps.length) continue
      const lo = Math.max(LAB, Math.min(...ps.map(p => Math.min(p.px0, p.px1)))), hi = Math.min(W, Math.max(...ps.map(p => Math.max(p.px0, p.px1)))); if (hi - lo < 24) continue
      const fwd = ps[0].fwd; const yy = y + 2, hh = BLK
      if (!ps[0].inv) { g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); if (fwd) { g.moveTo(hi - 6, yy); g.lineTo(hi - 1, yy + hh / 2); g.lineTo(hi - 6, yy + hh) } else { g.moveTo(lo + 6, yy); g.lineTo(lo + 1, yy + hh / 2); g.lineTo(lo + 6, yy + hh) } g.fill() }
      if (r.copy >= 1 && hi - lo > 40) { g.fillStyle = '#7a3b00'; g.font = '9px system-ui'; g.fillText('·' + r.copy, lo + 2, y + 9) }
    }
    if (genesByTr.size) for (const p of pcs) for (const gn of (genesByTr.get(p.tr.id) || [])) {   // 遺伝子レーン: 片の下。緑＝合意の向きに +、橙＝−、灰＝擬似
      if (gn.x1 < p.c0 || gn.x0 > p.c1) continue
      const [pa, pb] = pxInPiece(p, Math.max(p.c0, gn.x0), Math.min(p.c1 + 1, gn.x1 + 1), mode); const a = Math.max(LAB, pa), b = Math.min(W, pb); if (b < a) continue
      g.fillStyle = gn.pseudo ? '#9a9a9a' : (gn.fwd ? '#2e8b57' : '#e67e22'); g.fillRect(a, y + 2 + BLK + 2, Math.max(1, b - a), 5)
    }
    if (($('showreps') as HTMLInputElement).checked && mode === 'coord') for (const c of (rpByHap.get(hid) || [])) { const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.fillStyle = 'rgba(120,20,20,.9)'; g.fillRect(px0, y + 1, Math.max(1, px1 - px0), 2) }
    if (($('showcopies') as HTMLInputElement).checked && mode === 'coord') for (const c of (cpByHap.get(hid) || [])) { const px0 = Math.max(LAB, X(c.x0)), px1 = Math.min(W, X(c.x1 + 1)); g.strokeStyle = '#c0392b'; g.lineWidth = 2; g.beginPath(); g.moveTo(px0, y + BLK + 3); g.lineTo(px1, y + BLK + 3); g.stroke() }
  })
  if (treeRoot && ($('order') as HTMLSelectElement).value === 'tree') {   // 系統樹: 根が左、葉が右。枝の長さは不一致率
    const rowOf = new Map(hapOrder.map((h, k) => [h, k])); const hmax = Math.max(1e-9, treeRoot.h); g.strokeStyle = '#444'; g.lineWidth = 1
    const xOfH = (h: number) => 4 + (1 - Math.sqrt(Math.max(0, h) / hmax)) * (TREEW - 8)   // 近い株の併合が 0 付近に集まるので平方根で広げる
    const walk = (c: Clade): number => {   // 返り値はこのクレードの中心 y（子の中心の平均）。葉（まとめた枝も）は行の中心
      const x = xOfH(c.h)
      if (!c.kids.length || c.collapsed) {
        const y = TOP + rowOf.get(c.rep ?? c.leaves[0])! * ROW + 2 + BLK / 2; g.beginPath(); g.moveTo(x, y); g.lineTo(TREEW - 2, y); g.stroke()
        if (c.collapsed) { g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(x, y); g.lineTo(TREEW - 2, y - 3); g.lineTo(TREEW - 2, y + 3); g.fill(); g.fillStyle = '#333' }   // まとめた枝＝三角
        return y
      }
      const ys = c.kids.map(walk)
      g.beginPath(); g.moveTo(x, Math.min(...ys)); g.lineTo(x, Math.max(...ys)); g.stroke()
      c.kids.forEach((k, i) => { const xk = xOfH(k.h); g.beginPath(); g.moveTo(x, ys[i]); g.lineTo(xk, ys[i]); g.stroke() })
      return ys.reduce((t, v) => t + v, 0) / ys.length
    }
    walk(treeRoot)
    if (treeCut != null) { const xc = xOfH(treeCut * hmax); g.strokeStyle = 'rgba(192,57,43,.6)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xc, TOP); g.lineTo(xc, TOP + hapOrder.length * ROW); g.stroke(); g.setLineDash([]) }   // まとめの閾値
    $('cuttxt').textContent = `${hapOrder.length}/${root.H} 行`
  } else $('cuttxt').textContent = ''
  if (located.length) { g.strokeStyle = 'rgba(255,20,147,.85)'; g.lineWidth = 1.5; for (const x of located) { if (x < v0 || x > v1) continue; const px = X(x); g.beginPath(); g.moveTo(px, TOP - 12); g.lineTo(px, TOP + hapOrder.length * ROW); g.stroke() } g.lineWidth = 1 }   // グラフから来たノードの座標
  if (sel) { g.fillStyle = 'rgba(52,152,219,.15)'; g.fillRect(sel[0], 0, sel[1] - sel[0], H); g.fillStyle = '#c0392b'; g.font = '12px system-ui'; g.fillText('計算中…', sel[0] + 4, 14) }
  // 連結線: bp で等間隔に標本し、隣の行でその座標を含む片の中の位置を結ぶ
  if (mode === 'rows' && ($('showlines') as HTMLInputElement).checked) {
    g.lineWidth = 1; const nS = Math.max(8, Math.floor((W - LAB) / 12)); const xsS: number[] = []; for (let k = 0; k < nS; k++) xsS.push(xOfPx(LAB + (k + 0.5) / nS * (W - LAB)))
    const posIn = (pcs: Piece[], x: number): number[] => { const out: number[] = []; for (const p of pcs) { if (x < p.c0 || x > p.c1 + 1) continue; const f = (x - p.c0) / Math.max(1, p.c1 + 1 - p.c0); out.push(p.px0 + (p.fwd ? f : 1 - f) * (p.px1 - p.px0)) } return out }
    for (let k = 0; k + 1 < hapOrder.length; k++) {
      const A = piecesOf.get(hapOrder[k]) || [], B = piecesOf.get(hapOrder[k + 1]) || []; const yA = TOP + k * ROW + 2 + BLK, yB = TOP + (k + 1) * ROW + 2
      for (const x of xsS) {
        const pa = posIn(A, x), pb = posIn(B, x); if (!pa.length || !pb.length) continue
        g.strokeStyle = `hsla(${hue(blockAt(x))}, 60%, 40%, ${useCols ? .12 : (pa.length * pb.length > 1 ? .7 : .4)})`   // 錨の列の段ではセルの邪魔にならないよう薄く
        for (const xa of pa) for (const xb of pb) { if (xa < LAB || xb < LAB) continue; g.beginPath(); g.moveTo(xa, yA); g.lineTo(xb, yB); g.stroke() }
      }
    }
  }
}
// 片の中の座標区間 [xa, xb) → 画面の px（合意座標は X()、各行の並びは片の中の比例。向きが逆なら鏡）
function pxInPiece(p: Piece, xa: number, xb: number, mode: string): [number, number] {
  if (mode === 'coord') { const a = X(xa), b = X(xb); return [Math.min(a, b), Math.max(a, b)] }
  const span = Math.max(1, p.c1 + 1 - p.c0); const fa = (xa - p.c0) / span, fb = (xb - p.c0) / span; const L = p.px1 - p.px0
  const a = p.fwd ? p.px0 + fa * L : p.px0 + (1 - fb) * L, b = p.fwd ? p.px0 + fb * L : p.px0 + (1 - fa) * L; return [Math.min(a, b), Math.max(a, b)]
}
// 錨の列のセル: 片（ブロック × 通過）の座標区間に掛かる列を、合意座標モードは X()、各行の並びは片の中の比例で置く。濃さ＝錨の有無、色＝アレル番号、上辺の黒＝挿入 bp（対数）
function drawCells(cr: ColRow, p: Piece, px0: number, px1: number, yy: number, hh: number, mode: string) {
  const C = cols!; const Wc = C.x1 - C.x0 + 1; const span = Math.max(1, p.c1 + 1 - p.c0)
  const c0 = Math.max(0, Math.floor((p.c0 - C.x0) * C.ncol / Wc)), c1 = Math.min(C.ncol - 1, Math.floor((p.c1 - C.x0) * C.ncol / Wc))
  for (let c = c0; c <= c1; c++) {
    const k = cr.cls[c]; if (k === 255) continue
    const xa = Math.max(p.c0, C.x0 + c * Wc / C.ncol), xb = Math.min(p.c1 + 1, C.x0 + (c + 1) * Wc / C.ncol); if (xb <= xa) continue
    let pa: number, pb: number
    if (mode === 'coord') { pa = X(xa); pb = X(xb) }
    else { const fa = (xa - p.c0) / span, fb = (xb - p.c0) / span; const L = p.px1 - p.px0; if (p.fwd) { pa = p.px0 + fa * L; pb = p.px0 + fb * L } else { pa = p.px0 + (1 - fb) * L; pb = p.px0 + (1 - fa) * L } }
    const a = Math.max(px0, Math.min(pa, pb)), b = Math.min(px1, Math.max(pa, pb)); if (b < a) continue; const wc = Math.max(1, b - a)
    g.globalAlpha = 0.3 + 0.7 * (cr.pres[c] / 255); g.fillStyle = CLS_COL[Math.min(k, CLS_COL.length - 1)]; g.fillRect(a, yy, wc, hh); g.globalAlpha = 1
    const ins = cr.ins[c]; if (ins > 0) { const ih = Math.min(hh, 1 + 1.5 * Math.log10(1 + ins)); g.fillStyle = 'rgba(20,20,20,.85)'; g.fillRect(a, yy, wc, ih) }
  }
}
// ---- 操作 ----
let drag: [number, number] | null = null; let sel: [number, number] | null = null
cv.addEventListener('mousedown', e => {
  const inRows = ($('mode') as HTMLSelectElement).value === 'rows'
  if (e.offsetX > LAB && (!inRows || e.offsetY < TOP)) { drag = [e.offsetX, e.offsetX]; return }
  if (root && e.offsetX >= TREEW && e.offsetX < LAB && e.offsetY >= TOP) { const k = Math.floor((e.offsetY - TOP) / ROW); if (k >= 0 && k < hapOrder.length) cb.onSelectHap?.(root.haps[hapOrder[k]].hap) }   // 行ラベル → 主画面のパス群の選択
})
cv.addEventListener('mousemove', e => {
  if (drag) { drag[1] = e.offsetX; og.clearRect(0, 0, ov.width, ov.height); og.fillStyle = 'rgba(52,152,219,.2)'; og.fillRect(Math.min(drag[0], drag[1]), 0, Math.abs(drag[1] - drag[0]), ov.height); return }
  if (!root) return
  const k = Math.floor((e.offsetY - TOP) / ROW); const x = xOfPx(e.offsetX)
  if (e.offsetY < TOP && e.offsetX >= LAB) {
    const b = blocks[blockAt(x)]; if (!b) { tip.style.display = 'none'; return }
    const multi: string[] = []; for (let a = b.a0; a <= b.a1; a++) { const st = atomStats[a]; if (!st || st.tangled) continue; for (const [h, n] of Object.entries(st.counts)) if (n >= 2) multi.push(`${root!.haps[Number(h)].hap} ×${n}`) }
    tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
    tip.textContent = `ブロック ${b.id + 1}/${blocks.length}  座標 ${fmt(b.x0)}–${fmt(b.x1)}  ${fmtbp(b.bp)}  原子 #${b.a0 + 1}–#${b.a1 + 1}  通るハプロタイプ ${b.nhap}/${root.H}  ${refPos(b.x0)}${b.tangled ? '  【もつれ: 順序が線形にならない領域を含む】' : ''}` + (multi.length ? `\n2 回以上: ${[...new Set(multi)].slice(0, 12).join(', ')}` : '')
    return
  }
  if (k < 0 || k >= hapOrder.length || e.offsetX < LAB) { tip.style.display = 'none'; return }
  const hid = hapOrder[k]; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'
  const hit = inRows ? (lastPieces.get(hid) || []).filter(p => Math.min(p.px0, p.px1) <= e.offsetX && Math.max(p.px0, p.px1) >= e.offsetX).map(p => p.tr).filter((v, i, a) => a.indexOf(v) === i) : rows.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  const rhit = inRows ? [] : reps.filter(r => r.hid === hid && r.x0 <= x && r.x1 >= x)
  if (!hit.length && !rhit.length) { tip.style.display = 'none'; return }
  tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'
  const lines = hit.map(r => `${root!.haps[r.hid].hap}  pid ${r.pid}  トークン ${fmt(r.i0)}–${fmt(r.i1)}${r.bp0 != null ? `  コンティグ ${fmtbp(r.bp0)}〜` : ''}  座標 ${fmt(r.x0)}–${fmt(r.x1)}  ${r.dir >= 0 ? '→' : '←'}  錨 ${fmt(r.nanch)}  ${fmtbp(r.bp)}${r.copy ? `  コピー ·${r.copy}` : ''}`).concat(rhit.map(r => `反復（この株で 2 回以上出るノードの連なり） トークン ${fmt(r.i0)}–${fmt(r.i1)}  ${fmtbp(r.bp)}`))
  let xx = x   // カーソルの座標（各行の並びでは片の中の比例から）
  if (inRows) { const p = (lastPieces.get(hid) || []).find(p => Math.min(p.px0, p.px1) <= e.offsetX && Math.max(p.px0, p.px1) >= e.offsetX); if (p) { const f = (e.offsetX - Math.min(p.px0, p.px1)) / Math.max(1, Math.abs(p.px1 - p.px0)); xx = p.c0 + (p.fwd ? f : 1 - f) * (p.c1 + 1 - p.c0) } }
  if (genes.length && showGenes()) for (const gn of genes.filter(gn => gn.hid === hid && gn.x0 <= xx && gn.x1 >= xx).slice(0, 6)) lines.push(`遺伝子 ${gn.name || gn.locus || ('#' + gn.gid)}${gn.pseudo ? '（擬似）' : ''}  ${gn.type} ${gn.strand}${gn.fwd ? '' : '（合意と逆向き）'}  ${fmtbp(gn.end - gn.start + 1)}  ${gn.product || ''}${gn.anchored ? '' : '  [錨なし: 位置は補間]'}`)
  if (cols && wantCols()) {   // 錨の列: カーソルの列と、この行のアレル・錨の有無・挿入・窓の中のトークン範囲（塩基 MSA へ渡す範囲）
    const C = cols; const Wc = C.x1 - C.x0 + 1
    const c = Math.max(0, Math.min(C.ncol - 1, Math.floor((xx - C.x0) * C.ncol / Wc))); const xa = Math.floor(C.x0 + c * Wc / C.ncol), xb = Math.floor(C.x0 + (c + 1) * Wc / C.ncol) - 1
    lines.push(`列 ${c + 1}/${C.ncol}  座標 ${fmt(xa)}–${fmt(Math.max(xa, xb))}  錨 ${C.nanch[c]}  アレル ${C.ncls[c]} 種（多数派 ${C.major[c]}/${C.nrow[c]} 行）`)
    for (const r of hit) { const cr = C.byId.get(r.id); if (!cr || cr.cls[c] === 255) continue; lines.push(`  この行: アレル #${cr.cls[c] + 1}  錨 ${Math.round(100 * cr.pres[c] / 255)}%  挿入 ${fmt(cr.ins[c])} bp  窓のトークン ${fmt(cr.tw0)}–${fmt(cr.tw1)}`) }
  }
  tip.textContent = lines.join('\n')
})
const onWinUp = () => { if (!drag) return; const [a, b] = [Math.min(...drag), Math.max(...drag)]; drag = null; og.clearRect(0, 0, ov.width, ov.height); if (b - a < 4) return; hist.push(view); view = [xOfPx(a), xOfPx(b)]; sel = [a, b]; draw(); loadRange() }; window.addEventListener('mouseup', onWinUp)
cv.addEventListener('dblclick', e => { if (!root) return; hist.push(view); if (e.offsetY < TOP && e.offsetX >= LAB) { const b = blocks[blockAt(xOfPx(e.offsetX))]; view = b ? [b.x0, b.x1] : [0, root.R - 1] } else view = [0, root.R - 1]; loadRange() })
cv.addEventListener('wheel', e => { if (true) return; if (!root || e.offsetX < LAB) return; const inRows = ($('mode') as HTMLSelectElement).value === 'rows'; if (!inRows || e.offsetY >= TOP) return; /* ホイールの拡大縮小は無効（ドラッグで） */ e.preventDefault(); const x = xOfPx(e.offsetX); const f = e.deltaY > 0 ? 1.25 : 0.8; const n0 = x - (x - view[0]) * f, n1 = x + (view[1] - x) * f; hist.push(view); view = [Math.max(0, n0), Math.min(root!.R - 1, n1)]; draw(); scheduleRange() }, { passive: false })
$('all').addEventListener('click', () => { if (!root) return; hist.push(view); view = [0, root.R - 1]; loadRange() })
$('back').addEventListener('click', () => { const v = hist.pop(); if (v) { view = v; loadRange() } })
$('minanch').addEventListener('change', () => { loadAtoms().then(loadRange) }); $('nblk').addEventListener('change', () => { blocks = makeBlocks(); if (($('order') as HTMLSelectElement).value === 'tree') hapOrder = treeOrder(); draw() })
for (const id of ['showcopies', 'showbounds', 'showreps', 'mode', 'showlines']) $(id).addEventListener('change', draw)
$('order').addEventListener('change', () => { hapOrder = ($('order') as HTMLSelectElement).value === 'tree' ? treeOrder() : baseOrder.slice(); draw() })
$('rung').addEventListener('change', () => { if (rungSel() !== 'blocks' && !cols) loadRange(); else draw() })
$('genes').addEventListener('change', () => { if (showGenes() && !genes.length) loadRange(); else draw() })
$('sync').addEventListener('change', () => { if (($('sync') as HTMLInputElement).checked) loadRange() })
$('gfilter').addEventListener('change', () => { if (($('gfilter') as HTMLInputElement).checked) loadRange(); else cb.onFilter?.(null) })
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
  const r = await getJson(`/api/trav/locate?db=${encodeURIComponent(db)}&names=${encodeURIComponent(names.slice(0, 2000).join(','))}`); const j = await r.json()
  const xs: number[] = ((j.nodes || []) as { x: number }[]).map(n => n.x).filter(x => x >= 0).sort((a, b) => a - b)
  if (!xs.length) { $('info').textContent = `グラフ → パネル: 座標を持つノードが無い（錨でないノード、または別の層のノード）: ${names.slice(0, 3).join(', ')}`; return }
  hist.push(view)
  if (single || xs.length < 4) { const x = xs[Math.floor(xs.length / 2)]; const a = root.atoms[atomAt(x)]; view = [Math.max(a.x0, x - 3000), Math.min(a.x1, x + 3000)]; located = xs.slice() }
  else { const p10 = xs[Math.floor(xs.length * 0.1)], p90 = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]; const pad = Math.max(50, 0.05 * (p90 - p10)); view = [Math.max(0, p10 - pad), Math.min(root.R - 1, p90 + pad)]; located = [] }
  loadRange()
}
return { setDb(d: string) { db = d; located = []; loadRoot() }, locateNodes(names: string[]) { void locate(names, true) }, openNames(names: string[]) { void locate(names, false) }, destroy() { loading++; window.removeEventListener('mouseup', onWinUp); window.removeEventListener('resize', draw); if (opts.page) { window.removeEventListener('error', onWinErr); window.removeEventListener('unhandledrejection', onWinRej) } host.innerHTML = '' } }

}
