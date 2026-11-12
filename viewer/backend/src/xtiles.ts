// 通過のトークンをタイル（合意座標 2^S 錨ずつ）にまとめたファイル <db>.xtiles（prep/amipa_prep/trav_xtiles.py、11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ②
//   窓は掛かるタイルの塊を 1 回の連続した読みで取り、通過ごとのトークン（dense id・座標・錨か・bp・向き）をそこから組み立てる。
//   全ゲノムの配列（x_of_dense・kind・bp）を引かない。無い・.trav と合わないときは null（呼び手は従来の経路）
import fs from 'fs'
import zlib from 'zlib'
import { checkCancel } from './travCancel'

export interface XTiles { fd: number; S: number; ntile: number; R: number; offs: Float64Array; cache: Map<number, Tile>; cacheBytes: number }
export interface Tile { nseg: number; row: Int32Array; ti: Int32Array; n: Int32Array; start: Int32Array; d: Int32Array; bp: Int32Array; xf: Uint16Array; bytes: number }
const opened = new Map<string, XTiles | null>()
const CACHE_MAX = Number(process.env.AMIPA_XTILES_CACHE_MB || 64) * 1e6   // 展開したタイルを覚えておく上限（直近に使ったもの）。小さく保つ

export function openXTiles(travFile: string): XTiles | null {
  if (opened.has(travFile)) return opened.get(travFile)!
  let r: XTiles | null = null
  if ((process.env.AMIPA_XTILES ?? '1') !== '0') {
    const f = travFile.replace(/\.trav$/, '') + '.xtiles'
    try {
      if (fs.existsSync(f)) {
        const fd = fs.openSync(f, 'r'); const h = Buffer.alloc(4096); fs.readSync(fd, h, 0, 4096, 0); const H = JSON.parse(h.toString('utf8').trim())
        if (H.trav_size !== fs.statSync(travFile).size) { console.log(`[xtiles] ${f} は .trav と合わない（作り直しが要る）`); fs.closeSync(fd) }
        else {
          const ib = Buffer.alloc(8 * (H.ntile + 1)); fs.readSync(fd, ib, 0, ib.length, H.idx_off)
          const big = new BigInt64Array(ib.buffer, ib.byteOffset, H.ntile + 1); const offs = new Float64Array(H.ntile + 1); for (let i = 0; i <= H.ntile; i++) offs[i] = Number(big[i])
          r = { fd, S: H.tile_shift, ntile: H.ntile, R: H.R, offs, cache: new Map(), cacheBytes: 0 }
        }
      }
    } catch (e) { console.log('[xtiles] ' + String(e)); r = null }
  }
  opened.set(travFile, r); return r
}

function decode(buf: Buffer): Tile {
  const u = zlib.inflateSync(buf); const ab = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)
  const nseg = new Int32Array(ab, 0, 1)[0]; let p = 4
  const row = new Int32Array(ab, p, nseg); p += 4 * nseg; const ti = new Int32Array(ab, p, nseg); p += 4 * nseg; const n = new Int32Array(ab, p, nseg); p += 4 * nseg
  let N = 0; const start = new Int32Array(nseg); for (let i = 0; i < nseg; i++) { start[i] = N; N += n[i] }
  const d = new Int32Array(ab, p, N); p += 4 * N; const bp = new Int32Array(ab, p, N); p += 4 * N; const xf = new Uint16Array(ab, p, N)
  for (let i = 0; i < nseg; i++) { const s = start[i]; for (let k = s + 1; k < s + n[i]; k++) d[k] += d[k - 1] }   // 差 → 値
  return { nseg, row, ti, n, start, d, bp, xf, bytes: u.byteLength }
}

/** タイル [t0, t1] を返す（覚えていないものは連続した 1 回の読みでまとめて取る） */
export function readTiles(X: XTiles, t0: number, t1: number): Tile[] {
  t0 = Math.max(0, t0); t1 = Math.min(X.ntile - 1, t1); const out: Tile[] = []; if (t1 < t0) return out
  const need: number[] = []; for (let t = t0; t <= t1; t++) if (!X.cache.has(t)) need.push(t)
  if (need.length) {
    const a = need[0], b = need[need.length - 1]; const o0 = X.offs[a], o1 = X.offs[b + 1]; const buf = Buffer.alloc(o1 - o0)
    if (buf.length) fs.readSync(X.fd, buf, 0, buf.length, o0)
    for (let t = a; t <= b; t++) { if (X.cache.has(t)) continue; checkCancel(); const s = X.offs[t] - o0, e = X.offs[t + 1] - o0
      const tile = e > s ? decode(buf.subarray(s, e)) : { nseg: 0, row: new Int32Array(0), ti: new Int32Array(0), n: new Int32Array(0), start: new Int32Array(0), d: new Int32Array(0), bp: new Int32Array(0), xf: new Uint16Array(0), bytes: 0 }
      X.cache.set(t, tile); X.cacheBytes += tile.bytes }
  }
  for (let t = t0; t <= t1; t++) { const tile = X.cache.get(t)!; X.cache.delete(t); X.cache.set(t, tile); out.push(tile) }   // 使った順に並べ直す（古いものから捨てる）
  while (X.cacheBytes > CACHE_MAX && X.cache.size > t1 - t0 + 1) { const k = X.cache.keys().next().value as number; X.cacheBytes -= X.cache.get(k)!.bytes; X.cache.delete(k) }
  return out
}

/** 通過 1 本の窓のトークン（パスの順、重なりを除く）。gap[k]＝k の前でトークン番号が途切れる（その間は窓の外の錨を挟む） */
export interface RowToks { ti: Int32Array; d: Int32Array; bp: Int32Array; x: Int32Array; anchor: Uint8Array; rev: Uint8Array; gap: Uint8Array; n: number }
export function rowTokens(X: XTiles, tiles: Tile[], t0: number, rowId: number): RowToks {
  const segs: { tile: Tile; tb: number; i: number }[] = []
  tiles.forEach((tile, k) => { const tb = (t0 + k) << X.S
    // 片は (row, ti) の順に並んでいるので二分探索で row の先頭へ
    let lo = 0, hi = tile.nseg; while (lo < hi) { const m = (lo + hi) >> 1; if (tile.row[m] < rowId) lo = m + 1; else hi = m }
    for (let i = lo; i < tile.nseg && tile.row[i] === rowId; i++) segs.push({ tile, tb, i }) })
  segs.sort((a, b) => a.tile.ti[a.i] - b.tile.ti[b.i])
  let N = 0; for (const s of segs) N += s.tile.n[s.i]
  const ti = new Int32Array(N), d = new Int32Array(N), bp = new Int32Array(N), x = new Int32Array(N), anchor = new Uint8Array(N), rev = new Uint8Array(N), gap = new Uint8Array(N); const mask = (1 << X.S) - 1
  let n = 0, last = -1
  for (const s of segs) { const T = s.tile, st = T.start[s.i], m = T.n[s.i], t0i = T.ti[s.i]
    for (let k = 0; k < m; k++) { const tk = t0i + k; if (tk <= last) continue   // 隣の片と重なる錨でないトークン
      if (n > 0 && tk !== last + 1) gap[n] = 1
      const f = T.xf[st + k]; ti[n] = tk; d[n] = T.d[st + k]; bp[n] = T.bp[st + k]; anchor[n] = (f >> 13) & 1; x[n] = anchor[n] ? s.tb + (f & mask) : -1; rev[n] = (f >> 14) & 1; n++; last = tk } }
  return { ti, d, bp, x, anchor, rev, gap, n }
}

/** 以前の forEachWindowToken と同じ規則: 窓の錨と、その間の錨でないトークン（直前の窓の錨の座標。前に無ければ次の窓の錨の座標）。途切れ（gap）は窓の外の錨と同じに扱う */
export function forEachRowToken(T: RowToks, dir: number, x0: number, x1: number, fn: (d: number, isAnchor: boolean, xa: number, ti: number, bp: number) => void): void {
  const n = T.n; const step = dir >= 0 ? 1 : -1; let k = dir >= 0 ? 0 : n - 1; let curX = -1; let pend: number[] = []
  for (; k >= 0 && k < n; k += step) {
    // 途切れ: 正の向きなら k の前、逆向きなら k+1 の前（＝k の後）で窓の外を通った
    if ((dir >= 0 && T.gap[k]) || (dir < 0 && k + 1 < n && T.gap[k + 1])) { curX = -1; pend = [] }
    if (T.anchor[k]) {
      const xx = T.x[k]
      if (xx >= x0 && xx <= x1) { if (pend.length) { for (const q of pend) fn(T.d[q], false, xx, -1, T.bp[q]); pend = [] } curX = xx; fn(T.d[k], true, xx, T.ti[k], T.bp[k]) }
      else { curX = -1; pend = [] }
    } else if (curX >= 0) fn(T.d[k], false, curX, -1, T.bp[k])
    else pend.push(k)
  }
}
