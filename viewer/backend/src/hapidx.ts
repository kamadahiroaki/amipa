// hap 絞り込み（選択サンプル/ハプロタイプ/コンティグが通るノード・エッジだけ返す）の共通ロジック。
//
// マスクは `<db>.tiled`（v4, db.ts が tl として ATTACH）の nodes_t / edges_t に焼き込まれている:
//   tl.meta(hap_layout=tiled, words, bits, n_hap, mode) ＋ nodes_t.hm0.. / edges_t.hm0..
// 矩形走査のついでにマスクを読むので、棄却候補の太い nodes 行を読まずに済む。
// （11-17: 旧来の置き場所＝本体 nodes_rtree の補助列・サイドカー `<db>.hapidx` は読まなくなった）
//
// H(ハプロタイプ数)スケール: マスク幅 W は tile_index が H から決め上限で打ち止めるので、
//   mode=exact  → マスクだけで厳密
//   mode=bucket → マスクは保守的(上位集合)。**必ず node_contig_cov / edge_contig_cov blob で
//                 厳密判定を追加する**（Selection.exact）。誤りは出ない・効きが鈍るだけ。
// コンティグ粒度の選択(hap の一部の contig だけ)も同様に上位集合なので厳密判定を足す。

import type { Database } from 'better-sqlite3'
import { covFmt, hitsRangeFn } from './covBlob'

export interface HapIdxInfo {
  words: number
  mode: 'exact' | 'bucket'
  bits: number
  nHap: number
  /** マスク語が `<db>.tiled` の nodes_t / edges_t にあるか */
  tiledNodes: boolean
  tiledEdges: boolean
}

const infoCache = new WeakMap<any, HapIdxInfo | null>()

// tiled.ts を import すると循環になるので tl.meta を直接引く。
function tiledMaskInfo(d: Database): HapIdxInfo | null {
  try {
    const m = new Map((d.prepare('SELECT key, value FROM tl.meta').all() as { key: string; value: string }[])
      .map(r => [r.key, r.value]))
    if (m.get('hap_layout') !== 'tiled') return null
    const words = Number(m.get('words')), bits = Number(m.get('bits')), nHap = Number(m.get('n_hap'))
    if (!Number.isInteger(words) || words < 1 || words > 64 || bits !== 64 * words || !(nHap > 0)) return null
    const cols = (t: string) => new Set((d.prepare(`PRAGMA tl.table_info(${t})`).all() as any[]).map(c => String(c.name)))
    const nc = cols('nodes_t'), ec = cols('edges_t')
    const has = (c: Set<string>) => Array.from({ length: words }, (_, i) => `hm${i}`).every(h => c.has(h))
    if (!has(nc)) return null
    return {
      words, bits, nHap, mode: m.get('mode') === 'bucket' ? 'bucket' : 'exact',
      tiledNodes: true, tiledEdges: has(ec),
    }
  } catch { return null }
}

/** マスクが使える形なら諸元を返す。無ければ null（絞り込みは無効＝全件を返す）。 */
export function hapIdxInfo(d: Database): HapIdxInfo | null {
  if (infoCache.has(d)) return infoCache.get(d)!
  const out = tiledMaskInfo(d)
  infoCache.set(d, out)
  return out
}

/** エッジ側マスクが使えるか（--skip-edges や edge_contig_cov 無し DB では無い）。 */
export function hapIdxEdgeOk(d: Database): boolean {
  const i = hapIdxInfo(d)
  return !!(i && i.tiledEdges)
}

// contig_id → hap_id（distinct (sample,haplotype) を contig_id 昇順で採番）。
// emitter `_build_contig2hap` / hap_index.build_hap_map と同一の採番。
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
  /** マスクが `<db>.tiled` の nodes_t / edges_t にある（spatial.ts / dbJobs が使う） */
  tiledNodes: boolean
  tiledEdges: boolean
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
    tiledNodes: info.tiledNodes,
    tiledEdges: info.tiledEdges,
    mask: words.map(toSigned),
    exact: info.mode === 'bucket' || partial,
    haps: [...picked.keys()].sort((x, y) => x - y),
  }
}

/** `(n.hm0 & ?)!=0 OR ...` のような WHERE 断片。マスクが立っていない語は条件から省く。 */
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
