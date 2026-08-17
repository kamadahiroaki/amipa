// contig 索引 blob（node_contig_cov / edge_contig_cov / node_contig_inv / node_hap_mult /
// edge_hap_mult）の**復号を 1 箇所に集める**。
//
// これらの表はすべて「昇順 id の疎リスト＋任意の u8 付随値」という同じ形をしている。
// 現行形式（emit_core/src/lib.rs:695 が書く）:
//   f0  [u32 count][count × u32 id 昇順][count × u8 val]      ← val 無しの表もある(edge_contig_cov)
//
// この形式が DB の容量を最も食っている（chr22 実測: node_contig_cov 1,364MB + edge_contig_cov
// 1,156MB = DB 6.59GB の 38%。WG 273GB では推定 76+99GB = 64%）。id が u32 固定幅なのが主因で、
// 実際の id は chr22 で 1,756 まで / WG で 34,796 までしか使わない。そこで縮小形式を用意する:
//   f1  [u32 count][count × u16 id][count × u8 val]
//       **固定幅を維持**するので二分探索も val[i] の O(1) 添字もそのまま使える。
//       条件は id < 65536（chr22 1,756 / WG 34,796 なのでどちらも満たす）。
//   f2  [uvarint count][uvarint idsLen][count × uvarint delta][count × u8 val]
//       最小。ただし可変幅ゆえ **二分探索が使えず先頭から線形走査**になる。
//   f4  [u32 (count | width<<24)][count × id(width バイト)][count × u8 val]   ★推奨
//       id 幅を **blob ごとに** 1/2/4 バイトから選ぶ（幅は count 語の最上位バイト。count は
//       n_contig 以下なので 24bit で足りる）。固定幅なので f0 と同じく二分探索も O(1) 添字も使える。
//
// どの形式かは `db_meta.contigcov_fmt`（無ければ f0）で判定する。DB ごとに固定なので
// 判定は 1 回だけ行い、**行ごとのループの外**で復号関数を選ぶ（分岐を毎行入れない）。
//
// 実測(2026-08-05, functions/covpack/RESULTS.md, WG 273GB の実 blob):
//   容量  node_contig_cov 234.4B → f1/f4 142.2B(1.65x) / f2 139.0B(1.69x)
//         node_hap_mult   223.2B → f1 135.5B(1.65x) / **f4 91.7B(2.43x)** / f2 89.7B(2.49x)
//         → WG 全体で f4 は約 67GB(24%) 減。f2 との差は 2GB しかない。
//   CPU   f4 は全パターンで **f0 の 0.24-0.82 倍**（= 現行より速い。幅が細い分キャッシュに乗る）
//         f2 は「選択レンジが blob の後方」で **f0 の 2.4-4.3 倍**（太い blob では 8.8 倍）
//         → 容量がほぼ同じで CPU が悪化する f2 を選ぶ理由がない。f4 が本線。
import type { Database } from 'better-sqlite3'

export type CovFmt = 'f0' | 'f1' | 'f2' | 'f4'

const fmtCache = new WeakMap<any, CovFmt>()

/** この DB の contig 索引 blob の符号化。db_meta に無ければ現行(f0)。 */
export function covFmt(d: Database): CovFmt {
  const hit = fmtCache.get(d)
  if (hit) return hit
  let f: CovFmt = 'f0'
  try {
    const v = (d.prepare("SELECT value FROM db_meta WHERE key='contigcov_fmt'").get() as
      { value?: string } | undefined)?.value
    if (v === 'f1' || v === 'f2' || v === 'f4') f = v
  } catch { /* db_meta 無し = 旧 DB = f0 */ }
  fmtCache.set(d, f)
  return f
}

// ── レンジ交差判定（hap 絞り込みの厳密判定）───────────────────────────────────
// 「[lo,hi] に入る id が 1 つでもあるか」。f0/f1 は最初に id>=lo となる位置を二分探索し、
// そこが hi 以下かを見る。f2 は先頭から走査し、id>hi になった時点で打ち切る（昇順なので安全）。

function hitsF0(b: Buffer, lo: number, hi: number): boolean {
  if (!b || b.length < 4) return false
  const n = b.readUInt32LE(0)
  if (n === 0 || b.length < 4 + 4 * n) return false
  let a = 0, e = n
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt32LE(4 + 4 * m) < lo) a = m + 1; else e = m }
  return a < n && b.readUInt32LE(4 + 4 * a) <= hi
}
function hitsF1(b: Buffer, lo: number, hi: number): boolean {
  if (!b || b.length < 4) return false
  const n = b.readUInt32LE(0)
  if (n === 0 || b.length < 4 + 2 * n) return false
  let a = 0, e = n
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt16LE(4 + 2 * m) < lo) a = m + 1; else e = m }
  return a < n && b.readUInt16LE(4 + 2 * a) <= hi
}
function hitsF2(b: Buffer, lo: number, hi: number): boolean {
  if (!b || b.length < 2) return false
  let p = 0, sh = 0, n = 0, c
  do { c = b[p++]; n |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
  if (n === 0) return false
  do { c = b[p++] } while (c & 0x80)            // idsLen は交差判定では使わない
  let id = 0
  for (let i = 0; i < n; i++) {
    let dv = 0; sh = 0
    do { c = b[p++]; dv |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
    id += dv
    if (id > hi) return false
    if (id >= lo) return true
  }
  return false
}

// f4: 幅は count 語の最上位バイト。幅ごとに別ループを持つ（毎要素で幅分岐しない）。
function hitsF4(b: Buffer, lo: number, hi: number): boolean {
  if (!b || b.length < 4) return false
  const hw = b.readUInt32LE(0), n = hw & 0xffffff, w = hw >>> 24
  if (n === 0 || b.length < 4 + w * n) return false
  let a = 0, e = n
  if (w === 1) {
    while (a < e) { const m = (a + e) >> 1; if (b[4 + m] < lo) a = m + 1; else e = m }
    return a < n && b[4 + a] <= hi
  }
  if (w === 2) {
    while (a < e) { const m = (a + e) >> 1; if (b.readUInt16LE(4 + 2 * m) < lo) a = m + 1; else e = m }
    return a < n && b.readUInt16LE(4 + 2 * a) <= hi
  }
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt32LE(4 + 4 * m) < lo) a = m + 1; else e = m }
  return a < n && b.readUInt32LE(4 + 4 * a) <= hi
}

/** レンジ交差判定関数を形式ごとに 1 回だけ選ぶ。行ごとのループの外で呼ぶこと。 */
export function hitsRangeFn(fmt: CovFmt): (b: Buffer, lo: number, hi: number) => boolean {
  return fmt === 'f4' ? hitsF4 : fmt === 'f2' ? hitsF2 : fmt === 'f1' ? hitsF1 : hitsF0
}

// ── レンジ内 val の最大（リボンの θ 判定 / 逆位判定）─────────────────────────
// hasVal=false（edge_contig_cov のように val 配列を持たない表）は「交差すれば 255」を返す。
// 戻り値の規約は従来の rangeMaxCov と同じ: 該当なし = -1。

function maxF0(b: Buffer, lo: number, hi: number, hasVal: boolean): number {
  const n = b.readUInt32LE(0)
  if (n === 0) return -1
  let a = 0, e = n
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt32LE(4 + 4 * m) < lo) a = m + 1; else e = m }
  if (a >= n) return -1
  const vOff = 4 + 4 * n
  let best = -1
  for (let i = a; i < n; i++) {
    if (b.readUInt32LE(4 + 4 * i) > hi) break
    if (!hasVal) return 255
    const v = b.readUInt8(vOff + i); if (v > best) best = v
  }
  return best
}
function maxF1(b: Buffer, lo: number, hi: number, hasVal: boolean): number {
  const n = b.readUInt32LE(0)
  if (n === 0) return -1
  let a = 0, e = n
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt16LE(4 + 2 * m) < lo) a = m + 1; else e = m }
  if (a >= n) return -1
  const vOff = 4 + 2 * n
  let best = -1
  for (let i = a; i < n; i++) {
    if (b.readUInt16LE(4 + 2 * i) > hi) break
    if (!hasVal) return 255
    const v = b.readUInt8(vOff + i); if (v > best) best = v
  }
  return best
}
function maxF2(b: Buffer, lo: number, hi: number, hasVal: boolean): number {
  let p = 0, sh = 0, n = 0, c
  do { c = b[p++]; n |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
  if (n === 0) return -1
  let idsLen = 0; sh = 0
  do { c = b[p++]; idsLen |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
  const vOff = p + idsLen                       // val は id 列の直後（idsLen があるので O(1) で分かる）
  let id = 0, best = -1
  for (let i = 0; i < n; i++) {
    let dv = 0; sh = 0
    do { c = b[p++]; dv |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
    id += dv
    if (id > hi) break
    if (id >= lo) {
      if (!hasVal) return 255
      const v = b[vOff + i]; if (v > best) best = v
    }
  }
  return best
}

function maxF4(b: Buffer, lo: number, hi: number, hasVal: boolean): number {
  const hw = b.readUInt32LE(0), n = hw & 0xffffff, w = hw >>> 24
  if (n === 0) return -1
  const rd = w === 1 ? 0 : w === 2 ? 1 : 2
  let a = 0, e = n
  while (a < e) {
    const m = (a + e) >> 1
    const v = rd === 0 ? b[4 + m] : rd === 1 ? b.readUInt16LE(4 + 2 * m) : b.readUInt32LE(4 + 4 * m)
    if (v < lo) a = m + 1; else e = m
  }
  if (a >= n) return -1
  const vOff = 4 + w * n
  let best = -1
  for (let i = a; i < n; i++) {
    const v = rd === 0 ? b[4 + i] : rd === 1 ? b.readUInt16LE(4 + 2 * i) : b.readUInt32LE(4 + 4 * i)
    if (v > hi) break
    if (!hasVal) return 255
    const cv = b[vOff + i]; if (cv > best) best = cv
  }
  return best
}

/** レンジ内 val 最大の関数を形式ごとに 1 回だけ選ぶ。 */
export function rangeMaxFn(fmt: CovFmt): (b: Buffer, lo: number, hi: number, hasVal: boolean) => number {
  return fmt === 'f4' ? maxF4 : fmt === 'f2' ? maxF2 : fmt === 'f1' ? maxF1 : maxF0
}

// ── レンジ内 val の合計（node_hap_mult のコピー数）───────────────────────────
function sumF0(b: Buffer, lo: number, hi: number): number {
  const n = b.readUInt32LE(0)
  if (n === 0) return 0
  let a = 0, e = n
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt32LE(4 + 4 * m) < lo) a = m + 1; else e = m }
  const vOff = 4 + 4 * n
  let sum = 0
  for (let i = a; i < n; i++) {
    if (b.readUInt32LE(4 + 4 * i) > hi) break
    sum += b.readUInt8(vOff + i)
  }
  return sum
}
function sumF1(b: Buffer, lo: number, hi: number): number {
  const n = b.readUInt32LE(0)
  if (n === 0) return 0
  let a = 0, e = n
  while (a < e) { const m = (a + e) >> 1; if (b.readUInt16LE(4 + 2 * m) < lo) a = m + 1; else e = m }
  const vOff = 4 + 2 * n
  let sum = 0
  for (let i = a; i < n; i++) {
    if (b.readUInt16LE(4 + 2 * i) > hi) break
    sum += b.readUInt8(vOff + i)
  }
  return sum
}
function sumF2(b: Buffer, lo: number, hi: number): number {
  let p = 0, sh = 0, n = 0, c
  do { c = b[p++]; n |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
  if (n === 0) return 0
  let idsLen = 0; sh = 0
  do { c = b[p++]; idsLen |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
  const vOff = p + idsLen
  let id = 0, sum = 0
  for (let i = 0; i < n; i++) {
    let dv = 0; sh = 0
    do { c = b[p++]; dv |= (c & 0x7f) << sh; sh += 7 } while (c & 0x80)
    id += dv
    if (id > hi) break
    if (id >= lo) sum += b[vOff + i]
  }
  return sum
}

function sumF4(b: Buffer, lo: number, hi: number): number {
  const hw = b.readUInt32LE(0), n = hw & 0xffffff, w = hw >>> 24
  if (n === 0) return 0
  const rd = w === 1 ? 0 : w === 2 ? 1 : 2
  let a = 0, e = n
  while (a < e) {
    const m = (a + e) >> 1
    const v = rd === 0 ? b[4 + m] : rd === 1 ? b.readUInt16LE(4 + 2 * m) : b.readUInt32LE(4 + 4 * m)
    if (v < lo) a = m + 1; else e = m
  }
  const vOff = 4 + w * n
  let sum = 0
  for (let i = a; i < n; i++) {
    const v = rd === 0 ? b[4 + i] : rd === 1 ? b.readUInt16LE(4 + 2 * i) : b.readUInt32LE(4 + 4 * i)
    if (v > hi) break
    sum += b[vOff + i]
  }
  return sum
}

/** レンジ内 val 合計の関数を形式ごとに 1 回だけ選ぶ。 */
export function rangeSumFn(fmt: CovFmt): (b: Buffer, lo: number, hi: number) => number {
  return fmt === 'f4' ? sumF4 : fmt === 'f2' ? sumF2 : fmt === 'f1' ? sumF1 : sumF0
}
