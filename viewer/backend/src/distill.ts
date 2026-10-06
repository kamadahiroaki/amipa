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
  dir: string; tok: Npy; off: BigInt64Array | Int32Array; names: string[]; pidx: Map<string, number>
  constructor(dir: string) {
    this.dir = dir
    this.tok = openNpy(path.join(dir, 'p_tok.npy'))
    const o = openNpy(path.join(dir, 'p_off.npy')); const ob = Buffer.alloc(o.n * o.itemsize); fs.readSync(o.fd, ob, 0, ob.length, o.dataOffset); fs.closeSync(o.fd)
    this.off = o.itemsize === 8 ? new BigInt64Array(ob.buffer, ob.byteOffset, o.n) : new Int32Array(ob.buffer, ob.byteOffset, o.n)
    this.names = fs.readFileSync(path.join(dir, 'p_names.txt'), 'utf8').split('\n').filter(x => x.length)
    this.pidx = new Map(this.names.map((nm, i) => [nm, i]))
  }
  ntok(pi: number): number { const a = Number(this.off[pi]); const b = pi + 1 < this.off.length ? Number(this.off[pi + 1]) : this.tok.n; return b - a }
  // パス pi のトークン [s0, e0) を dense id の配列で（Float64Array で返す: int64 も安全に表せる範囲）
  read(pi: number, s0: number, e0: number): Float64Array {
    const base = Number(this.off[pi]); const n = Math.max(0, e0 - s0); const out = new Float64Array(n); if (!n) return out
    const buf = Buffer.alloc(n * this.tok.itemsize); fs.readSync(this.tok.fd, buf, 0, buf.length, this.tok.dataOffset + (base + s0) * this.tok.itemsize)
    if (this.tok.itemsize === 8) { const v = new BigInt64Array(buf.buffer, buf.byteOffset, n); for (let i = 0; i < n; i++) out[i] = Number(v[i]) }
    else if (this.tok.dtype === 'uint32') { const v = new Uint32Array(buf.buffer, buf.byteOffset, n); out.set(v) }
    else { const v = new Int32Array(buf.buffer, buf.byteOffset, n); out.set(v) }
    return out
  }
}
const cache = new Map<string, Distill>()
export function openDistill(dir: string): Distill { let d = cache.get(dir); if (!d) { d = new Distill(dir); cache.set(dir, d) } return d }
