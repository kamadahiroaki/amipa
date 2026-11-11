// DB の付属データが無いときの「使えない理由」の文言（backend の availability.ts と対）。
// 使えない機能は隠さず、押せない形で出してこの文言を添える。Traversals パネル（素の DOM）からも使う。
export type AvailWhy = 'none' | 'failed' | 'broken'
export interface Avail { ok: boolean; why?: AvailWhy; file: string; stage: string; log?: string; detail?: string }
export type AvailMap = Record<string, Avail>

const WHAT: Record<string, { name: string; how: string }> = {
  reads: { name: 'リードの整列', how: 'DB を作るときに --reads を渡すか、あとから amipa prep add-reads で足せる' },
  trav: { name: 'Traversals の錨と通過', how: 'パスのある GFA から --no-trav を付けずに作ると入る' },
  genes: { name: '株ごとの遺伝子', how: 'DB を作るときに --gff-dir を渡すと入る' },
  ann: { name: '参照の注釈（反復配列・変異）', how: 'DB を作るときに --ann-rmsk / --ann-vcf を渡すと入る' },
  annot: { name: 'グラフの注釈', how: 'amipa prep add-annot で足せる' },
  xdepth: { name: '座標ごとのリードの深さ', how: 'リードと Traversals の両方があると作られる' },
}

// 使えるなら null。backend が古くて情報が無いときも null（従来どおり使える扱い）。
export function naReason(av: AvailMap | undefined | null, key: string): string | null {
  const a = av?.[key]
  if (!a || a.ok) return null
  const w = WHAT[key] ?? { name: key, how: '' }
  if (a.why === 'failed')
    return `この DB では使えない: ${w.name}の取り込みが最後まで終わっていない（${a.file} が無い）。` +
      `${a.log ? `ログ ${a.log} を見る。` : ''}${w.how ? `やり直すには、${w.how}` : ''}`
  if (a.why === 'broken')
    return `この DB では使えない: ${w.name}のファイルが読めない（${a.file}${a.detail ? `：${a.detail}` : ''}）。`
  return `この DB には${w.name}が入っていない（${a.file} が無い）。${w.how}`
}

// 短い札（メニューの右端に出す）
export function naTag(av: AvailMap | undefined | null, key: string): string | null {
  const a = av?.[key]
  if (!a || a.ok) return null
  return a.why === 'none' ? 'Not in DB' : a.why === 'failed' ? 'Import failed' : 'Unreadable'
}
