// 塩基の段のリードの行の読み出し（11-04 に viewer/scripts/reads_query.py と prep の zstd_seek.py から移した）。
//   <db>.reads の転置索引（node_reads: ノード → 整列 id）と read_aln（整列 → サンプル・GAF の非圧縮オフセット・リード名）、
//   リード実体は seekable zstd（zstd 公式の seekable format v0.1.0: 独立フレーム＋末尾のシークテーブル）。展開は純 JS の fzstd
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { decompress } from 'fzstd'

const SEEKABLE_MAGIC = 0x8f92eab1
class SeekableZstd {
  fd: number; cOff: number[] = []; dOff: number[] = []; private cache = new Map<number, Buffer>()
  constructor(file: string) {
    this.fd = fs.openSync(file, 'r'); const size = fs.fstatSync(this.fd).size
    const foot = Buffer.alloc(9); fs.readSync(this.fd, foot, 0, 9, size - 9)
    if (foot.readUInt32LE(5) !== SEEKABLE_MAGIC) throw new Error('seekable zstd ではない: ' + file)
    const n = foot.readUInt32LE(0); const chk = (foot[4] & 0x80) !== 0; const es = chk ? 12 : 8
    const tab = Buffer.alloc(n * es); fs.readSync(this.fd, tab, 0, tab.length, size - 9 - n * es)
    let c = 0, d = 0; for (let i = 0; i < n; i++) { this.cOff.push(c); this.dOff.push(d); c += tab.readUInt32LE(i * es); d += tab.readUInt32LE(i * es + 4) } this.cOff.push(c); this.dOff.push(d)
  }
  private frame(i: number): Buffer {
    let b = this.cache.get(i); if (b) return b
    const cb = Buffer.alloc(this.cOff[i + 1] - this.cOff[i]); fs.readSync(this.fd, cb, 0, cb.length, this.cOff[i]); b = Buffer.from(decompress(cb))
    this.cache.set(i, b); if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value as number)   // 直近 4 フレームを持つ（python 版の cache=4）
    return b
  }
  readLine(voff: number): string {
    let lo = 0, hi = this.dOff.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.dOff[m] <= voff) lo = m; else hi = m - 1 }
    let i = lo; let pos = voff - this.dOff[i]; const parts: Buffer[] = []
    while (i < this.dOff.length - 1) { const f = this.frame(i); const nl = f.indexOf(10, pos); if (nl >= 0) { parts.push(f.subarray(pos, nl + 1)); break } parts.push(f.subarray(pos)); i++; pos = 0 }   // 行がフレームを跨ぐときは次へ
    return Buffer.concat(parts).toString('utf8')
  }
}

export interface ReadsSource {
  sampleName: Map<number, string>
  nodeAlnIds(gid: number): number[]
  // 11-12: 窓のノード（id が連続）の整列を範囲 1 回で引く（node_reads は塊ごとに gfa_id の順に並ぶので、塊ごとに連続した読みになる）。gid → 整列 id
  nodeAlnIdsRange(lo: number, hi: number, want?: Set<number>): Map<number, number[]>
  sampleOf(aln: number): number   // 整列 id → サンプル番号（read_chunk の id の範囲から。read_aln を読まない）
  alnInfo(ids: number[]): Map<number, [number, number, string]>   // aln_id → [sample_no, voff, read_name]
  fetchLines(rows: [number, number, number][]): string[]          // [(sample_no, aln_id, voff)] → 行（入力の順）
  // 11-17: リードのラベル <db>.rlabel（prep/amipa_prep/reads_labels.py。例: 父由来・母由来）。無ければ null。labelOf は aln_id → ラベル（表に無い整列は返さない）
  labeled: Set<number> | null   // ラベルを持つサンプル番号
  labelOf(ids: number[]): Map<number, string>
}

const srcCache = new Map<string, ReadsSource | null>()
export function readsSourceFor(dbPath: string): ReadsSource | null {
  if (srcCache.has(dbPath)) return srcCache.get(dbPath)!
  let real = dbPath; try { real = fs.realpathSync(dbPath) } catch { /* */ }
  const side = [dbPath + '.reads', real + '.reads'].find(f => { try { return fs.existsSync(f) } catch { return false } })
  if (!side) { srcCache.set(dbPath, null); return null }
  const db = new Database(side, { readonly: true })
  const hasChunk = (db.prepare('PRAGMA table_info(node_reads)').all() as { name: string }[]).some(c => c.name === 'chunk_no')
  const base = new Map<number, number>(); if (hasChunk) for (const r of db.prepare('SELECT chunk_no, base_aln_id FROM read_chunk').all() as any[]) base.set(r.chunk_no, r.base_aln_id)
  const qNode = hasChunk ? db.prepare('SELECT chunk_no, postings FROM node_reads WHERE gfa_id=? ORDER BY chunk_no') : db.prepare('SELECT NULL AS chunk_no, postings FROM node_reads WHERE gfa_id=?')
  const srcCols = new Set((db.prepare('PRAGMA table_info(read_src)').all() as { name: string }[]).map(c => c.name))
  const src = new Map<number, [string, string, string]>()
  for (const r of db.prepare(srcCols.has('path') ? "SELECT sample_no, path, COALESCE(container,'zstd') AS container, sample_id FROM read_src" : "SELECT sample_no, bgzf_path AS path, 'bgzf' AS container, sample_id FROM read_src").all() as any[]) src.set(r.sample_no, [r.path, r.container, r.sample_id])
  const sampleName = new Map([...src].map(([sn, v]) => [sn, v[2]] as [number, string]))
  const readers = new Map<number, SeekableZstd>()
  const resolve = (recorded: string) => { const b = path.basename(recorded), d = path.dirname(path.resolve(dbPath)); for (const c of [recorded, path.join(d, 'reads', b), path.join(d, b)]) if (fs.existsSync(c)) return c; return recorded }   // 11-11: 記録の絶対パスを先に（DB_DIR/reads に同じ名前の古い GAF があるとオフセットがずれ、リードの行が全部消えた）
  const reader = (sn: number) => { let r = readers.get(sn); if (!r) { const s = src.get(sn)!; if (s[1] !== 'zstd') throw new Error('BGZF のリード実体は TS 版では読めない（旧 DB）'); r = new SeekableZstd(resolve(s[0])); readers.set(sn, r) } return r }
  const decode = (blob: Buffer, prev: number) => { const out: number[] = []; let shift = 0, cur = 0; for (const b of blob) { cur += (b & 0x7f) * 2 ** shift; if (b & 0x80) { shift += 7 } else { prev += cur; out.push(prev); cur = 0; shift = 0 } } return out }
  const qRange = hasChunk ? db.prepare('SELECT gfa_id, chunk_no, postings FROM node_reads WHERE gfa_id BETWEEN ? AND ?') : db.prepare('SELECT gfa_id, NULL AS chunk_no, postings FROM node_reads WHERE gfa_id BETWEEN ? AND ?')
  const chunks = hasChunk ? (db.prepare('SELECT base_aln_id AS b, n_aln AS n, sample_no AS s FROM read_chunk ORDER BY base_aln_id').all() as { b: number; n: number; s: number }[]) : []
  // リードのラベル（11-17）: <db>.rlabel があれば開く。.reads と大きさが合わなければ（作り直した後の古いラベル）使わない
  let ldb: InstanceType<typeof Database> | null = null; let labeled: Set<number> | null = null
  { const lp = [dbPath + '.rlabel', real + '.rlabel'].find(f => { try { return fs.existsSync(f) } catch { return false } })
    if (lp) { try { const L = new Database(lp, { readonly: true }); const mt = new Map((L.prepare('SELECT key, value FROM meta').all() as any[]).map(r => [r.key, r.value]))
      const rsz = Number(mt.get('reads_size') || 0); let sz = 0; try { sz = fs.statSync(side).size } catch { /* */ }
      if (rsz && sz && rsz !== sz) { console.warn(`[reads] ${lp}: .reads と組でない（作ったときの大きさ ${rsz}、今 ${sz}）→ ラベルを使わない`); L.close() }
      else { ldb = L; labeled = new Set((L.prepare('SELECT DISTINCT sample_no FROM label').all() as any[]).map(r => r.sample_no)) } } catch (e) { console.warn(`[reads] ${lp}: ${(e as Error).message}`) } } }
  const labelOf = (ids: number[]) => { const m = new Map<number, string>(); if (!ldb) return m
    for (let i = 0; i < ids.length; i += 900) { const ch = ids.slice(i, i + 900); for (const r of ldb.prepare(`SELECT a.aln_id, l.label FROM aln_label a JOIN label l ON l.lid = a.lid WHERE a.aln_id IN (${ch.map(() => '?').join(',')})`).all(...ch) as any[]) m.set(r.aln_id, r.label) } return m }
  const rs: ReadsSource = {
    sampleName, labeled, labelOf,
    nodeAlnIdsRange: (lo, hi, want) => { const m = new Map<number, number[]>(); for (const r of qRange.all(lo, hi) as any[]) { if (want && !want.has(r.gfa_id)) continue; const v = decode(r.postings, r.chunk_no == null ? 0 : (base.get(r.chunk_no) ?? 0)); const a = m.get(r.gfa_id); if (a) { for (const x of v) a.push(x) } else m.set(r.gfa_id, v) } return m },
    sampleOf: aln => { let lo = 0, hi = chunks.length - 1, k = -1; while (lo <= hi) { const md = (lo + hi) >> 1; if (chunks[md].b < aln) { k = md; lo = md + 1 } else hi = md - 1 } return k >= 0 && aln <= chunks[k].b + chunks[k].n ? chunks[k].s : -1 },   // 整列 id は 1 始まり: 塊は (base_aln_id, base_aln_id + n_aln]（11-17 修正。以前は各サンプルの最後の 1 本を次のサンプルに数えていた）
    nodeAlnIds: gid => { const out: number[] = []; for (const r of qNode.all(gid) as any[]) out.push(...decode(r.postings, r.chunk_no == null ? 0 : (base.get(r.chunk_no) ?? 0))); return out },
    alnInfo: ids => { const m = new Map<number, [number, number, string]>(); for (let i = 0; i < ids.length; i += 900) { const ch = ids.slice(i, i + 900); for (const r of db.prepare(`SELECT aln_id, sample_no, voff, read_name FROM read_aln WHERE aln_id IN (${ch.map(() => '?').join(',')})`).all(...ch) as any[]) m.set(r.aln_id, [r.sample_no, r.voff, r.read_name]) } return m },
    fetchLines: rows => { const ord = rows.map((_, i) => i).sort((a, b) => rows[a][0] - rows[b][0] || rows[a][2] - rows[b][2]); const out = new Array<string>(rows.length); for (const i of ord) out[i] = reader(rows[i][0]).readLine(rows[i][2]); return out },
  }
  srcCache.set(dbPath, rs); return rs
}

export function parseGafLine(line: string): any | null {
  const c = line.replace(/\n$/, '').split('\t'); if (c.length < 12) return null
  const d: any = { read_name: c[0], query_len: Number(c[1]), q_start: Number(c[2]), q_end: Number(c[3]), path: c[5], path_start: Number(c[7]), path_end: Number(c[8]), mapq: c[11] !== '*' ? Number(c[11]) : null, is_primary: 1, cg: null, cs: null }
  for (const t of c.slice(12)) { if (t.startsWith('tp:A:')) d.is_primary = t === 'tp:A:P' ? 1 : 0; else if (t.startsWith('cg:Z:')) d.cg = t.slice(5); else if (t.startsWith('cs:Z:')) d.cs = t.slice(5) }
  return d
}
