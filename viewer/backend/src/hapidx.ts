// hap 絞り込み（選択サンプル/ハプロタイプ/コンティグが通るノード・エッジだけ返す）の共通ロジック。
//
// データは scripts/ggb_hapidx.py が作るサイドカー `<db>.hapidx`（db.ts が ix として ATTACH）:
//   ix.nodes_rtree_hm  rtree(id, min_x,max_x, min_y,max_y, min_layer,max_layer, +hm0..+hm{W-1})
//   ix.edge_hm(edge_rowid PK, hm0..hm{W-1})
//   ix.hap_dict(hap_id PK, name, sample, haplotype, cid_lo, cid_hi, n_contig)
//   ix.hapidx_meta(words, mode=exact|bucket, bits, n_hap, ...)
//
// なぜ R-Tree の補助列か: 密領域の遅さは R-Tree 探索(50ns/entry)ではなく「候補全件の行を実体化する」
// こと(nodes 行 1.6us/行, node_contig_cov の太い blob 25us/行)と Lustre cold random I/O。よって
// マスク判定は **nodes 行を読む前** に済ませる必要がある。
// SQLite の R-Tree 補助列は リーフページ(%_node)ではなく **%_rowid 影テーブル** に入る
// (`CREATE TABLE ..._rowid(rowid INTEGER PRIMARY KEY, nodeno, a0, a1)`)。つまり候補ごとに
// %_rowid を rowid 点引きする形になるが、そこは **細くて rowid クラスタな表**(約28B/行)なので
// 「棄却1件 = 細い表の1読み」で済み、太い nodes 行(20列)を読むより桁で安い。
// 実測 (chr22 密領域, functions/hapfilter/RESULTS.md): 現行比 cold 1.7-4.7x / warm 2.5-2.7x。
//
// H(ハプロタイプ数)スケール: マスク幅 W は ggb_hapidx が H から決め上限で打ち止めるので、
//   mode=exact  → マスクだけで厳密
//   mode=bucket → マスクは保守的(上位集合)。**必ず node_contig_cov / edge_contig_cov blob で
//                 厳密判定を追加する**（needExact()）。誤りは出ない・効きが鈍るだけ。
// コンティグ粒度の選択(hap の一部の contig だけ)も同様に上位集合なので厳密判定を足す。

import type { Database } from 'better-sqlite3'
import { covFmt, hitsRangeFn } from './covBlob'

export interface HapIdxInfo {
  words: number
  mode: 'exact' | 'bucket'
  bits: number
  nHap: number
  /** マスク付き R-Tree の参照名。'nodes_rtree'(emitter 統合) か 'ix.nodes_rtree_hm'(サイドカー) */
  rtree: string
  /** エッジマスク表の参照名。無ければ null（ノード絞り込みのみ） */
  edgeTable: string | null
  /** 描画用補助列(ang/nm/hb/bnd/gcn/rgn)が R-Tree に載っているか（ggb_hapidx --draw-aux） */
  drawAux: boolean
  /** rad 補助列（= nodes.radius の真値）があるか。無い旧 DB は矩形から導出＝過大になる */
  hasRad: boolean
  /** cx/cy 補助列（= nodes.xCoord/yCoord の真値）があるか。無いと中心が float32 の 1 ulp ずれる */
  hasXY: boolean
  /** ang 補助列の倍率（angle = ang / angScale）。既定 1e6 */
  angScale: number
}

const infoCache = new WeakMap<any, HapIdxInfo | null>()

// マスクの置き場所は 2 通りある。どちらも「rtree の第1列は rowid 別名」なので SQL は r.rowid で統一できる。
//   A) emitter 統合: main.nodes_rtree そのものが +hm0.. を持つ（幾何の重複なし。新しい DB）
//   B) サイドカー  : ix.nodes_rtree_hm（<db>.hapidx を ATTACH。既存 DB を作り直さずに済む）
function readMeta(d: Database, schema: string): Map<string, string> | null {
  try {
    const rows = d.prepare(`SELECT key, value FROM ${schema}hapidx_meta`).all() as
      { key: string; value: string }[]
    return new Map(rows.map(r => [r.key, r.value]))
  } catch { return null }
}
// PRAGMA は schema 修飾を `PRAGMA <schema>.table_info(<table>)` の形で書く必要がある
// （`PRAGMA table_info(ix.foo)` は通らない）。schema は '' か 'ix.'。
function rtreeHasMask(d: Database, schema: string, table: string): boolean {
  try {
    return (d.prepare(`PRAGMA ${schema}table_info(${table})`).all() as any[])
      .some(c => c.name === 'hm0')
  } catch { return false }
}
function tableExists(d: Database, table: string): boolean {
  try { d.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(); return true } catch { return false }
}

/** マスクが使える形なら諸元を返す。無ければ null（呼び側は従来経路へ）。 */
export function hapIdxInfo(d: Database): HapIdxInfo | null {
  if (infoCache.has(d)) return infoCache.get(d)!
  let out: HapIdxInfo | null = null
  for (const [schema, bare, edge] of [
    ['', 'nodes_rtree', 'edge_hm'],                 // A) emitter 統合（main の nodes_rtree に補助列）
    ['ix.', 'nodes_rtree_hm', 'edge_hm'],           // B) サイドカー（<db>.hapidx を ATTACH）
  ] as const) {
    const rtree = schema + bare
    if (!rtreeHasMask(d, schema, bare)) continue
    const m = readMeta(d, schema)
    if (!m) continue
    const words = Number(m.get('words'))
    const bits = Number(m.get('bits'))
    const nHap = Number(m.get('n_hap'))
    const mode = m.get('mode') === 'bucket' ? 'bucket' : 'exact'
    // 想定外のスキーマ/幅では黙って誤らないよう機能を切る（従来動作にフォールバック）。
    if (m.get('schema') !== '1' || m.get('layout') !== 'rtree_aux') continue
    if (!Number.isInteger(words) || words < 1 || words > 64) continue
    if (bits !== 64 * words) continue
    if (m.get('node_done') !== '1') continue        // 構築中/中断は使わない
    // 描画用補助列。`nm` が実際に引けるかまで確かめる（meta だけ立っていて列が無い事故を防ぐ）
    const auxCols: string[] = (() => {
      try { return (d.prepare(`PRAGMA ${schema}table_info(${bare})`).all() as any[])
        .map(c => String(c.name)) } catch { return [] }
    })()
    const drawAux = m.get('draw_aux') === '1' && auxCols.includes('nm')
    // rad / cx,cy は後から足した列なので、meta でなく **列の実在**で判定する
    // （先に作った DB は draw_aux=1 でもこれらを持たない）
    const hasRad = drawAux && auxCols.includes('rad')
    const hasXY = drawAux && auxCols.includes('cx') && auxCols.includes('cy')
    out = {
      words, mode, bits, nHap, rtree,
      edgeTable: (m.get('edge_done') === '1' && tableExists(d, schema + edge))
        ? schema + edge : null,
      drawAux,
      hasRad,
      hasXY,
      angScale: Number(m.get('ang_scale')) || 1000000,
    }
    break
  }
  infoCache.set(d, out)
  return out
}

/** エッジ側マスクが使えるか（--skip-edges や edge_contig_cov 無し DB では無い）。 */
export function hapIdxEdgeOk(d: Database): boolean {
  return !!hapIdxInfo(d)?.edgeTable
}

// contig_id → hap_id（distinct (sample,haplotype) を contig_id 昇順で採番）。
// emitter `_build_contig2hap` / ggb_hapidx.build_hap_map と同一の採番。
const hapOfCache = new WeakMap<any, Int32Array>()
export function contigToHap(d: Database): Int32Array {
  const cached = hapOfCache.get(d)
  if (cached) return cached
  const rows = d.prepare('SELECT contig_id, sample, haplotype FROM contig_dict ORDER BY contig_id')
    .all() as { contig_id: number; sample: string; haplotype: string }[]
  let maxId = -1
  for (const r of rows) if (r.contig_id > maxId) maxId = r.contig_id
  const arr = new Int32Array(maxId + 1)
  let last: string | null = null, hid = -1
  for (const r of rows) {
    const key = (r.sample ?? '') + '\x01' + (r.haplotype ?? '')
    if (key !== last) { hid++; last = key }
    arr[r.contig_id] = hid
  }
  hapOfCache.set(d, arr)
  return arr
}

// hap_id → その hap が持つ contig 総数（選択が hap 全体を覆っているかの判定に使う）。
const hapSizeCache = new WeakMap<any, Int32Array>()
function hapContigCount(d: Database): Int32Array {
  const cached = hapSizeCache.get(d)
  if (cached) return cached
  const hapOf = contigToHap(d)
  let maxH = -1
  for (let i = 0; i < hapOf.length; i++) if (hapOf[i] > maxH) maxH = hapOf[i]
  const cnt = new Int32Array(maxH + 1)
  for (let i = 0; i < hapOf.length; i++) cnt[hapOf[i]]++
  hapSizeCache.set(d, cnt)
  return cnt
}

export interface Selection {
  /** 選択された contig_id レンジ（両端含む・正規化済み） */
  ranges: [number, number][]
  /** マスク付き R-Tree の参照名（'nodes_rtree' か 'ix.nodes_rtree_hm'）。SQL は r.rowid で統一する */
  rtree: string
  /** エッジマスク表の参照名（無ければ null） */
  edgeTable: string | null
  /** マスク語（SQLite の signed INTEGER 表現。長さ = words） */
  mask: bigint[]
  /** true なら blob による厳密判定が必要（bucket モード or hap の一部だけ選択） */
  exact: boolean
  /** 選択に含まれる hap_id（デバッグ/ログ用） */
  haps: number[]
}

/**
 * `sel` クエリパラメータをパースする。書式は contig_id のレンジ列:
 *     sel=0-23,24-33      … サンプル/ハプロタイプ選択（frontend の ribbonSel.gids がこの形）
 *     sel=57              … 単一コンティグ選択（= 57-57）
 * 空/不正なら null（絞り込みなし）。
 */
export function parseSel(raw: unknown): [number, number][] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const out: [number, number][] = []
  for (const tok of raw.split(',')) {
    const t = tok.trim()
    if (!t) continue
    const m = /^(\d+)(?:-(\d+))?$/.exec(t)
    if (!m) return null
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return null
    out.push(lo <= hi ? [lo, hi] : [hi, lo])
  }
  if (out.length === 0) return null
  // レンジ数が異常に多い要求は弾く（URL からの DoS 防止）
  if (out.length > 4096) return null
  return out
}

const toSigned = (v: bigint) => (v >= (1n << 63n) ? v - (1n << 64n) : v)

/**
 * 選択レンジから hap マスクを組む。サイドカーが無い/選択が空なら null。
 * bucket モード、または「hap の contig を一部しか選んでいない」場合は exact=true になり、
 * 呼び側は生存行に対して blob で厳密判定しなければならない。
 */
export function buildSelection(d: Database, raw: unknown): Selection | null {
  const info = hapIdxInfo(d)
  if (!info) return null
  const ranges = parseSel(raw)
  if (!ranges) return null
  const hapOf = contigToHap(d)
  const cnt = hapContigCount(d)
  const picked = new Map<number, number>()      // hap_id → 選択された contig 数
  for (const [lo, hi] of ranges) {
    const a = Math.max(0, lo), b = Math.min(hapOf.length - 1, hi)
    for (let c = a; c <= b; c++) {
      const h = hapOf[c]
      picked.set(h, (picked.get(h) ?? 0) + 1)
    }
  }
  if (picked.size === 0) return null
  const words = new Array<bigint>(info.words).fill(0n)
  let partial = false
  for (const [h, k] of picked) {
    if (h < 0 || h >= info.nHap) continue
    if (k < (cnt[h] ?? 0)) partial = true       // hap の一部だけ → マスクは上位集合
    const b = info.mode === 'bucket' ? h % info.bits : h
    words[b >> 6] |= 1n << BigInt(b & 63)
  }
  if (words.every(w => w === 0n)) return null
  return {
    ranges,
    rtree: info.rtree,
    edgeTable: info.edgeTable,
    mask: words.map(toSigned),
    exact: info.mode === 'bucket' || partial,
    haps: [...picked.keys()].sort((x, y) => x - y),
  }
}

/** `(r.hm0 & ?)!=0 OR ...` のような WHERE 断片。マスクが立っていない語は条件から省く。 */
export function maskWhere(alias: string, sel: Selection): { sql: string; params: bigint[] } {
  const parts: string[] = []
  const params: bigint[] = []
  sel.mask.forEach((w, i) => {
    if (w !== 0n) { parts.push(`(${alias}.hm${i} & ?)!=0`); params.push(w) }
  })
  return { sql: parts.length ? ' AND (' + parts.join(' OR ') + ')' : '', params }
}

// ── 厳密判定（bucket モード / コンティグ粒度選択）──────────────────────────────
// blob の形式（現行 f0 = [u32 count][count×u32 contig_id 昇順][...]、および縮小形式 f1/f2）と
// その復号は covBlob.ts に集約した。ここは「選択レンジのどれかと交差するか」だけを見る。
// ★復号関数は **DB ごとに 1 回だけ**選ぶ（行ごとのループの中で形式分岐を入れない）。
export function blobHitsSelection(
  buf: Buffer | null, sel: Selection,
  hits: (b: Buffer, lo: number, hi: number) => boolean = hitsRangeFn('f0'),
): boolean {
  if (!buf) return false
  for (const [lo, hi] of sel.ranges) if (hits(buf, lo, hi)) return true
  return false
}

/**
 * マスクで絞った行に対する厳密判定。`rowids` の各行について cov 表の blob を引き、
 * 選択レンジと交差するものだけ残す。呼び側は「マスク通過後の少数行」にだけ使うこと。
 */
export function exactFilterRowids(
  d: Database, table: 'node_contig_cov' | 'edge_contig_cov', key: string,
  rowids: number[], sel: Selection,
): Set<number> {
  const keep = new Set<number>()
  if (rowids.length === 0) return keep
  const hits = hitsRangeFn(covFmt(d))       // 形式判定はループの外で 1 回
  const CH = 900
  for (let i = 0; i < rowids.length; i += CH) {
    const chunk = rowids.slice(i, i + CH)
    const ph = chunk.map(() => '?').join(',')
    const rows = d.prepare(
      `SELECT ${key} AS k, blob FROM ${table} WHERE ${key} IN (${ph})`).all(...chunk) as
      { k: number; blob: Buffer | null }[]
    for (const r of rows) if (blobHitsSelection(r.blob, sel, hits)) keep.add(r.k)
  }
  return keep
}
