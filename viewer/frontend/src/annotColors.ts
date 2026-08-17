// アノテーション着色の共有パレット。GraphCanvas の描画と App の凡例で色定義を一元化する。
export const GIE_COLORS: Record<string, number> = {
  gneg: 0xf1f3f5, gpos25: 0xced4da, gpos50: 0x868e96, gpos75: 0x495057, gpos100: 0x212529,
  acen: 0xe03131, gvar: 0x63e6be, stalk: 0x74c0fc,
}
export function stainToColor(stain: string | undefined): number {
  return (stain && GIE_COLORS[stain]) || 0xadb5bd
}
// 遺伝子密度ランプ端点 / exon・intron・exon エッジの代表色（GraphCanvas の描画と一致）。
export const GENE_DENSITY_LOW = 0xd0bfff
export const GENE_DENSITY_HIGH = 0x5f3dc4
export const EXON_COLOR = 0x2b8a3e
export const INTRON_COLOR = 0xd3f9d8
export const hexCss = (c: number) => '#' + (c & 0xffffff).toString(16).padStart(6, '0')
