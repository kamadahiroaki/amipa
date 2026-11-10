// distill サイドカー（numpy .npy）の部分読み。p_tok（全パスのトークン＝dense id を連結）を、パスとトークン範囲を指定してバイト位置で読む。
// Blocks パネルの「座位ごとのアレル」（錨の間の各株のノード列）を、Ctx も Python も無しに TS で作るため。
import fs from 'fs'
import path from 'path'

interface Npy { fd: number; dtype: 'int32' | 'int64' | 'uint32'; itemsize: number; dataOffset: number; n: number }

function openNpy(file: string): Npy {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(128); fs.readSync(fd, head, 0, 128, 0)
  if (head.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('not npy: ' + file)
  const major = head[6]; const hlen = major === 1 ? head.readUInt16LE(8) : head.readUInt32LE(8); const hstart = major === 1 ? 10 : 12
  const hbuf = Buffer.alloc(hlen); fs.readSync(fd, hbuf, 0, hlen, hstart); const h = hbuf.toString('latin1')
  const m = /'descr':\s*'([<|=]?)([iu])(\d)'/.exec(h); if (!m) throw new Error('npy descr: ' + h)
  const bytes = Number(m[3]); const dtype = (m[2] === 'u' ? 'uint32' : (bytes === 8 ? 'int64' : 'int32')) as Npy['dtype']
  const sm = /'shape':\s*\((\d+),?\)/.exec(h); const n = sm ? Number(sm[1]) : 0
  if (/'fortran_order':\s*True/.test(h)) throw new Error('fortran order not supported')
  return { fd, dtype, itemsize: bytes, dataOffset: hstart + hlen, n }
}

export class Distill {
  private ori: Npy | null | undefined
  private tokMem: Buffer | null = null; private oriMem: Buffer | null | undefined
  dir: string; tok: Npy; off: BigInt64Array | Int32Array; names: string[]; pidx: Map<string, number>
  constructor(dir: string) {
    this.dir = dir
    this.tok = openNpy(path.join(dir, 'p_tok.npy')); this.tokMem = loadWhole(this.tok)
    const o = openNpy(path.join(dir, 'p_off.npy')); const ob = Buffer.alloc(o.n * o.itemsize); fs.readSync(o.fd, ob, 0, ob.length, o.dataOffset); fs.closeSync(o.fd)
    this.off = o.itemsize === 8 ? new BigInt64Array(ob.buffer, ob.byteOffset, o.n) : new Int32Array(ob.buffer, ob.byteOffset, o.n)
    this.names = fs.readFileSync(path.join(dir, 'p_names.txt'), 'utf8').split('\n').filter(x => x.length)
    this.pidx = new Map(this.names.map((nm, i) => [nm, i]))
  }
  // パスがコンティグのどこから始まるか（W 行の start。minigraph-cactus はクリップした区間でコンティグを断片に切る）。無ければ null
  private pst: Float64Array | null | undefined
  pStart(): Float64Array | null {
    if (this.pst !== undefined) return this.pst
    try { const n = openNpy(path.join(this.dir, 'p_start.npy')); const b = Buffer.alloc(n.n * n.itemsize); fs.readSync(n.fd, b, 0, b.length, n.dataOffset); fs.closeSync(n.fd)
      const out = new Float64Array(n.n); if (n.itemsize === 8) { const v = new BigInt64Array(b.buffer, b.byteOffset, n.n); for (let i = 0; i < n.n; i++) out[i] = Number(v[i]) } else out.set(new Int32Array(b.buffer, b.byteOffset, n.n)); this.pst = out
    } catch { this.pst = null }
    return this.pst
  }
  // dense（1 始まり）→ 元の GFA id（id_map.npy）と、dense → bp（s_bp を s_id で並べ直す）。コンティグの道筋（route.ts）用。11-10
  private idm: Float64Array | null | undefined; private bpd: Float64Array | null | undefined
  private readAll(f: string): Float64Array | null {
    try { const n = openNpy(path.join(this.dir, f)); const b = Buffer.alloc(n.n * n.itemsize); let o = 0; while (o < b.length) { const k = fs.readSync(n.fd, b, o, Math.min(1 << 28, b.length - o), n.dataOffset + o); if (k <= 0) break; o += k } fs.closeSync(n.fd)
      const out = new Float64Array(n.n); if (n.itemsize === 8) { const v = new BigInt64Array(b.buffer, b.byteOffset, n.n); for (let i = 0; i < n.n; i++) out[i] = Number(v[i]) } else if (n.dtype === 'uint32') out.set(new Uint32Array(b.buffer, b.byteOffset, n.n)); else out.set(new Int32Array(b.buffer, b.byteOffset, n.n)); return out
    } catch { return null }
  }
  idMap(): Float64Array | null { if (this.idm === undefined) this.idm = this.readAll('id_map.npy'); return this.idm }
  bpOfDense(): Float64Array | null {
    if (this.bpd !== undefined) return this.bpd
    const sid = this.readAll('s_id.npy'), sbp = this.readAll('s_bp.npy'); if (!sid || !sbp) { this.bpd = null; return null }
    let mx = 0; for (let i = 0; i < sid.length; i++) if (sid[i] > mx) mx = sid[i]
    const out = new Float64Array(mx + 1); for (let i = 0; i < sid.length; i++) out[sid[i]] = sbp[i]; this.bpd = out; return out
  }
  // 同じ名前のパス（コンティグの断片）の pid の一覧。pidx は名前→最後の pid なので別に引く
  pidsOf(name: string): number[] { const out: number[] = []; for (let i = 0; i < this.names.length; i++) if (this.names[i] === name) out.push(i); return out }
  ntok(pi: number): number { const a = Number(this.off[pi]); const b = pi + 1 < this.off.length ? Number(this.off[pi + 1]) : this.tok.n; return b - a }
  // パス pi のトークン [s0, e0) を dense id の配列で（Float64Array で返す: int64 も安全に表せる範囲）
  read(pi: number, s0: number, e0: number): Float64Array {
    const base = Number(this.off[pi]); const n = Math.max(0, e0 - s0); const out = new Float64Array(n); if (!n) return out
    let buf: Buffer
    if (this.tokMem) { const a = (base + s0) * this.tok.itemsize; buf = Buffer.from(this.tokMem.subarray(a, a + n * this.tok.itemsize)) }   // 揃った位置の写し（型付き配列の境界のため）
    else { buf = Buffer.alloc(n * this.tok.itemsize); fs.readSync(this.tok.fd, buf, 0, buf.length, this.tok.dataOffset + (base + s0) * this.tok.itemsize) }
    if (this.tok.itemsize === 8) { const v = new BigInt64Array(buf.buffer, buf.byteOffset, n); for (let i = 0; i < n; i++) out[i] = Number(v[i]) }
    else if (this.tok.dtype === 'uint32') { const v = new Uint32Array(buf.buffer, buf.byteOffset, n); out.set(v) }
    else { const v = new Int32Array(buf.buffer, buf.byteOffset, n); out.set(v) }
    return out
  }
  // パス pi のトークン [s0, e0) の向き（p_ori.npy、1 = 格納向き）。11-04（gene_lof を TS に移すため）
  readOri(pi: number, s0: number, e0: number): Uint8Array {
    if (this.ori === undefined) { try { this.ori = openNpy(path.join(this.dir, 'p_ori.npy')); this.oriMem = loadWhole(this.ori) } catch { this.ori = null } }
    const n = Math.max(0, e0 - s0); const out = new Uint8Array(n); if (!n || !this.ori) return out.fill(1)
    const base = Number(this.off[pi]); const a = (base + s0) * this.ori.itemsize
    if (this.oriMem) { out.set(this.oriMem.subarray(a, a + n)); return out }
    fs.readSync(this.ori.fd, out, 0, n, this.ori.dataOffset + a); return out
  }
}
// 11-04: パスの表（p_tok）と向き（p_ori）が小さければプロセスのメモリに丸ごと読む（既定 2 GB 以下、AMIPA_DISTILL_MEM_MAX で変える。0 で無効）。
//   ショウジョウバエ（333 MB）では、配信ノードのページキャッシュから押し出されると、窓ごとの読み出しが Lustre のランダム読みで 2〜5 秒になった
const MEM_MAX = (() => { const v = Number(process.env.AMIPA_DISTILL_MEM_MAX); return Number.isFinite(v) && v >= 0 ? v : 2e9 })()
function loadWhole(n: Npy): Buffer | null {
  const bytes = n.n * n.itemsize; if (!MEM_MAX || bytes > MEM_MAX) return null
  const b = Buffer.allocUnsafe(bytes); let o = 0; while (o < bytes) { const k = fs.readSync(n.fd, b, o, Math.min(1 << 28, bytes - o), n.dataOffset + o); if (k <= 0) break; o += k } return b
}
const cache = new Map<string, Distill>()
export function openDistill(dir: string): Distill { let d = cache.get(dir); if (!d) { d = new Distill(dir); cache.set(dir, d) } return d }
