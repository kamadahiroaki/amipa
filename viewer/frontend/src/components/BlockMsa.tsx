import { useEffect, useRef, useState } from 'react'
import { fetchBlocks, fetchBlockWindow, fetchBlockRange, fetchBlockRangeAtoms, fetchBlockSites, fetchBlockTokRanges, fetchBubbleMsaRanges, fetchBlockLocate, fetchBlockGenes, fetchBlockGenesCols, fetchBlockGenesTok, fetchBlockOrth, fetchBlockOrthRows, fetchBlockOrthGroup, fetchBlockOrthFind, fetchBlockJunction, fetchBlockFeature, fetchBlockJunctions, fetchBlockJunctionBase, fetchBlockJunctionGenes, warmBlocks, BlockDrillRequest } from '../api/client'
import { mountBlockMsa, BlockMsaHandle, BlockRef, BlockView, GeneLite } from './blockMsaRender'

// 多解像度 MSA（共線ブロック）パネル。中身は vanilla の blockMsaRender（試作の移植）。
//   ・db が変わるたびに /api/blocks（サイドカー JSON）を取り直して描き直す
//   ・ブロックの選択/ホバーを App へ返す（App が参照区間 → 表示層のノード名に解き、グラフを強調）
//   ・onReady で handle を渡す（グラフでノードを選んだときに App が selectByRef で逆に選ぶ）
//   ・事前計算に無い窓は onDrill → POST /api/blocks/window（常駐 Python ワーカー）。開いた時に /warm で温める
interface Props {
  db: string | null
  onSelectBlock?: (b: BlockRef | null) => void
  onHoverBlock?: (b: BlockRef | null) => void
  onView?: (v: BlockView | null) => void            // 見えている窓・段のブロックと色（グラフの塗り分け用）、範囲（グラフ連動用）
  onSelectHap?: (groupKey: string, hap: string) => void   // 行ラベルのクリック → グラフのパス群の選択切替
  onBaseMsa?: (req: BlockDrillRequest) => void           // 底: ブロックの各行のトークン範囲を塩基レベル MSA へ
  hapMarks?: Map<string, string>                    // グラフで選択中のパス群（鍵→色）→ 行ラベルの印
  genes?: Map<number, GeneLite[]>                   // 参照コンティグ id → 遺伝子（列見出しのトラックと遺伝子密度の色）
  onReady?: (h: BlockMsaHandle | null) => void
}

export default function BlockMsa({ db, onSelectBlock, onHoverBlock, onView, onSelectHap, onBaseMsa, hapMarks, genes, onReady }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<BlockMsaHandle | null>(null)
  const cbRef = useRef({ onSelectBlock, onHoverBlock, onView, onSelectHap, onBaseMsa })
  useEffect(() => { cbRef.current = { onSelectBlock, onHoverBlock, onView, onSelectHap, onBaseMsa } }, [onSelectBlock, onHoverBlock, onView, onSelectHap, onBaseMsa])
  useEffect(() => { handleRef.current?.setHapMarks(hapMarks ?? new Map()) }, [hapMarks])
  useEffect(() => { handleRef.current?.setGenes(genes ?? new Map()) }, [genes])
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    handleRef.current?.destroy(); handleRef.current = null; onReady?.(null)
    if (!db) { setMsg('アトラスを選んでください'); return }
    setMsg('読み込み中…')
    fetchBlocks(db).then(data => {
      if (!live || !rootRef.current) return
      if (data.error || !Array.isArray(data.windows) || data.windows.length === 0) { setMsg(data.error || 'ブロックのサイドカーが空です'); return }
      setMsg(null)
      handleRef.current = mountBlockMsa(rootRef.current, data, {
        onSelectBlock: b => cbRef.current.onSelectBlock?.(b),
        onHoverBlock: b => cbRef.current.onHoverBlock?.(b),
        onDrill: req => fetchBlockWindow(db, req),          // 旧サイドカー: 事前計算に無い窓を backend で逐次計算
        onRange: (x0, x1, label, depth, parent, pblock) => fetchBlockRange(db, x0, x1, label, depth, parent, pblock),   // 木: 範囲の窓
        onRangeAtoms: (a0, a1, label, depth, parent) => fetchBlockRangeAtoms(db, a0, a1, label, depth, parent),   // 木: 原子の範囲の窓（画面の既定）
        onSites: q => fetchBlockSites(db, q),                // 木: 変異の段（アレル行列）
        onTokRanges: (c0, c1) => fetchBlockTokRanges(db, c0, c1),   // 木: 列の範囲 → 各行のトークン範囲（塩基へ）
        onGenes: ranges => fetchBlockGenes(db, ranges),          // 木: 各行のコンティグ範囲の遺伝子と接合×遺伝子（.genes サイドカー）
        onGenesCols: (c0, c1, paths) => fetchBlockGenesCols(db, c0, c1, paths),
        onGenesTok: ranges => fetchBlockGenesTok(db, ranges),             // 木: トークン範囲で開いた塩基の窓（接合の塩基）の遺伝子
        onOrth: (c0, c1, max) => fetchBlockOrth(db, c0, c1, max),           // 見出しの遺伝子トラック（オルソログ群）
        onOrthRows: (c0, c1, paths) => fetchBlockOrthRows(db, c0, c1, paths),   // 行の差分（持つ／擬似／逆向き／余分）
        onOrthGroup: og => fetchBlockOrthGroup(db, og),                      // 群の運命の表
        onOrthFind: (q, limit) => fetchBlockOrthFind(db, q, limit),          // 遺伝子名の検索   // 木: 列範囲（アレル行列・塩基）の遺伝子（列の区間と塩基の端）
        onJunction: jid => fetchBlockJunction(db, jid),          // 接合カード
        onFeature: q => fetchBlockFeature(db, q),              // 遺伝子（GFF の行）の全項目: 9 列・属性・親・子（.genes format 2）
        onJunctions: () => fetchBlockJunctions(db),             // 接合一覧
        onJunctionBase: (jid, k) => fetchBlockJunctionBase(db, jid, k),   // 接合の塩基（トークン範囲）
        onJunctionGenes: (jid, n) => fetchBlockJunctionGenes(db, jid, n),   // 接合の遺伝子近傍の比較
        onBaseFetch: (ranges, label, maxLeaves) => fetchBubbleMsaRanges(db, ranges, label, 0, 0, maxLeaves),   // 木: 塩基レベル MSA をパネル内に出す（畳まずに受けて画面側で畳む）。maxLeaves=変異の少ない区間で葉の上限を上げる
        onLocate: names => fetchBlockLocate(db, names),      // 木: グラフのノード → 葉（原子）の場所
        onView: v => cbRef.current.onView?.(v),
        onSelectHap: (k, h) => cbRef.current.onSelectHap?.(k, h),
        onBaseMsa: req => cbRef.current.onBaseMsa?.(req),
      })
      handleRef.current.setHapMarks(hapMarks ?? new Map())
      handleRef.current.setGenes(genes ?? new Map())
      onReady?.(handleRef.current)
      if (!(data.meta && data.meta.tree)) void warmBlocks(db)   // 旧サイドカーだけ: ワーカーを先に起こして Ctx を温める。木は backend が SQLite から作るので不要
    }).catch(e => { if (live) setMsg('読み込みに失敗: ' + String(e)) })
    return () => { live = false; handleRef.current?.destroy(); handleRef.current = null; onReady?.(null) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {msg && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#667', font: '13px sans-serif' }}>{msg}</div>}
      <div ref={rootRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
