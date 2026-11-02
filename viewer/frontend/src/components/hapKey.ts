// 行のハプロタイプ名（例 'HG00673#1', 'GCF_013459175.1#1', 'grch38#chrY'）を、グラフのパス群の鍵
// （sample 'HG00673' / haplotype 'HG00673#1' / ecoli では haplotype 'GCF_013459175.1', sample 'GCF_013459175'）に合わせる。
// 11-02 に Blocks パネル（blockMsaRender.ts）から移した（Traversals と App が使う）
export function hapCandidates(hap: string): string[] {
  const noHap = hap.replace(/#\d+$/, ''), sample = hap.split('#')[0]
  return [...new Set([hap, noHap, sample, sample.replace(/\.\d+$/, '')])]
}
export function matchHapToKey(hap: string, keys: Iterable<string>): string | null {
  const ks = new Set(keys); for (const c of hapCandidates(hap)) if (ks.has(c)) return c; return null
}
