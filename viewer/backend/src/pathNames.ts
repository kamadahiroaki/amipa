// パス名の解釈（11-18）。前処理の prep/amipa_prep/pathnames.py の split_path と同じ規則（どちらかを変えたら両方を直す）。
//   sample#hap#contig          PanSN
//   sample#hap#contig#<整数>   4 項目目（vg が W 行を P 行に直すと付く `HG00438#2#MT#0`）→ 捨てる
//   sample#contig              2 項目（`GRCh38#chrM`）
//   sample.chrN                # の無い参照の略記（全ゲノム MC の `GRCh38.chr1`）。. の後が chr で始まるときだけ（`NC_000913.3` の版番号を切らない）
//   name                       区切りなし → sample = contig = name
//   末尾の [a-b] / [a:b]       部分範囲 → 捨てる
// ★株・パスの対応は、名前を解くより .trav のパス番号（pid → hid）で引く方を優先する。ここは名前しか無いとき（表示の名前・BED の染色体名など）に使う
export function splitPath(name: string): { sample: string; hap: string | null; contig: string } {
  const base = name.replace(/\[\d+[-:]\d+\]$/, '')
  if (base.includes('#')) {
    let f = base.split('#')
    if (f.length >= 4 && /^\d+$/.test(f[f.length - 1])) f = f.slice(0, -1)
    if (f.length === 2) return { sample: f[0], hap: null, contig: f[1] }
    return { sample: f[0], hap: f[1], contig: f[f.length - 1] }
  }
  const d = base.indexOf('.')
  if (d > 0 && /^chr/i.test(base.slice(d + 1))) return { sample: base.slice(0, d), hap: null, contig: base.slice(d + 1) }
  return { sample: base, hap: null, contig: base }
}
export const contigOf = (name: string) => splitPath(name).contig
export const sampleOf = (name: string) => splitPath(name).sample
