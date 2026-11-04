import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { getDb, getDbDir } from '../db'
import { amipaScript } from '../pyenv'
import { runScript } from '../pyRunner'
import { sendTrav } from '../travClient'

export const bubbleMsaRouter = Router()

// bubble(S ノード)の MSA は distill(順序付きウォーク p_tok/p_ori)を要る。backend は distill を持たない
// ので、Python 抽出器(scripts/bubble_msa.py)を **常駐の python 実行器**（pyRunner.ts → scripts/py_runner.py）で走らせて JSON を得る。
//   ・以前は要求ごとに spawn していたが、計算ノードでは Lustre 上の miniconda の `import numpy` だけで 6〜43 秒かかり
//     （2026-10-15 実測）、計算本体の 1 秒を桁で上回っていた。常駐にして import を 1 回にする（README 改訂 113）
//   ・非同期なので better-sqlite3 の同期クエリと違いイベントループを塞がない
//   ・distill の場所は DB と同じサイドカー規約 `<dbpath>.distill`(hapidx/nametri と同型)。
//     emitter(layout_emit_db_relayer.py)が `<out-db>.distill` の symlink をビルド末尾に張る。
const SCRIPT = amipaScript('bubble_msa.py')       // = viewer/scripts/bubble_msa.py
const TIMEOUT_MS = Number((process.env.AMIPA_MSA_TIMEOUT_MS ?? process.env.MSA_TIMEOUT_MS)) || 30000
// 走査するウォーク token 数の上限(抽出器の既定 8 億 = WG cold ~12s 相当)。WG で全 hap を選んだ
// ときに timeout する前にエラーで返させるための安全弁で、env で緩められる。
const MAX_TOKENS = Number((process.env.AMIPA_MSA_MAX_TOKENS ?? process.env.MSA_MAX_TOKENS)) || 0

// distill の在り処を 3 段で解決する。emitter は「実 DB の隣」に張るが、DB_DIR の実体は
// e2e/db・wg/ への **symlink 運用**なので素の `<DB_DIR>/<db>.distill` だけでは足りない。
//   (1) `<DB_DIR>/<db>.distill`         … 手動リンクを最優先(実験時の差し替えが効くように)
//   (2) `realpath(<db>)+'.distill'`     … emitter が張ったサイドカー(symlink 運用でも届く)
//   (3) db_meta.inputs.distill.path     … サイドカー導入前に建った既存 DB(WG 等)の救済。
//       emitter は昔から入力の出自を db_meta に刻んでいるので、再ビルドせず MSA が使える。
export function distillFor(dbPath: string): string | null {
  const cands: string[] = [dbPath + '.distill']
  try { const rp = fs.realpathSync(dbPath); if (rp !== dbPath) cands.push(rp + '.distill') } catch { /* ignore */ }
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'p_tok.npy'))) return c } catch { /* ignore */ }
  }
  try {
    const db = getDb(path.basename(dbPath))
    const row = db.prepare("SELECT value FROM db_meta WHERE key='inputs'").get() as { value?: string } | undefined
    const p = row?.value ? JSON.parse(row.value)?.distill?.path : null
    if (p && fs.existsSync(path.join(p, 'p_tok.npy'))) return p
  } catch { /* db_meta が無い旧 DB / JSON 破損は素通り */ }
  return null
}


// Traversals の塩基の段（ノード段・塩基段）: 各行（パス）のトークン範囲を stdin の JSON で渡し、その範囲の塩基レベル MSA を返す（11-02 にノード集合で選ぶ GET /bubble_msa と Blocks パネルを外した）。
//   POST /api/bubble_msa/ranges  body {db, ranges:[[path, s0, e0, dir?], …], label, flank}   dir（任意）＝コンティグの主な向き ±1（行の表示の向き）
//   S（列）は範囲内のトークンの葉集合、行は与えたパスの範囲だけ。葉の上限は maxLeaves（既定 400、ここで 12,000 まで。画面は 1 遺伝子分〜を一度に出す）。
bubbleMsaRouter.post('/bubble_msa/ranges', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const db = typeof b.db === 'string' ? b.db : ''
  const ranges = Array.isArray(b.ranges) ? (b.ranges as unknown[]) : []
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  if (!ranges.length || !ranges.every(r => Array.isArray(r) && (r.length === 3 || r.length === 4) && (typeof r[0] === 'string' || Number.isInteger(r[0])))) { res.status(400).json({ error: 'ranges must be [[path | path_index, s0, e0, dir?], ...]' }); return }   // r[0] は distill のパス名、r[3]（任意）はコンティグの主な向き ±1、または p_names の番号（通過パネル。ヒト v2 は名前が重複する）
  const fq = Number(b.flank); const flank = String(Number.isFinite(fq) ? Math.max(0, Math.min(12, fq)) : 0)
  const dbPath = path.join(getDbDir(), path.basename(db))
  if (!fs.existsSync(dbPath)) { res.status(404).json({ error: 'DB が見つかりません' }); return }
  const distill = distillFor(dbPath)
  if (!distill) { res.json({ error: 'この DB には MSA 用 distill サイドカーがありません（' + path.basename(dbPath) + '.distill）' }); return }
  const argv = ['--db', dbPath, '--distill', distill, '--ranges-stdin', '--flank', flank, '--label', String(b.label ?? 'Traversals')]
  { // 合意の並びで行の向きと列の区切りの順を決める（窓の一部しか覆わない行があっても揃う）。.trav の座標を優先し、無ければ古い木の dcol（11-02: 6 窓で列・行とも同一）
    let real = ''; try { real = fs.realpathSync(dbPath) } catch { /* */ }
    const sp = ['.trav', '.synteny'].flatMap(sfx => [dbPath + sfx, real ? real + sfx : '']).find(f => f && fs.existsSync(f)) || ''; if (sp) argv.push('--synteny', sp) }
  if (b.cap != null && Number.isFinite(Number(b.cap))) argv.push('--cap', String(Math.max(0, Math.floor(Number(b.cap)))))   // 0 = 畳まない（画面側で畳む）
  if (b.maxLeaves != null && Number.isFinite(Number(b.maxLeaves))) argv.push('--max-leaves', String(Math.max(1, Math.min(12000, Math.floor(Number(b.maxLeaves))))))   // 葉の上限（既定 400。画面は 12,000 を渡す: 1,200 列 ≈ 13 kb を一度に。3,000 列で計算 2 秒・5 MB）
  // 11-04: .trav があれば Traversals の worker の TS 版（msa.ts）で計算する（python 版と 4 グラフ×8 窓で出力同一、5〜10 倍速い）。
  //   .trav が無い古い DB と AMIPA_MSA_TS=0 のときだけ常駐の python（bubble_msa.py）
  if ((process.env.AMIPA_MSA_TS ?? '1') !== '0' && argv.includes('--synteny') && argv[argv.indexOf('--synteny') + 1].endsWith('.trav')) {
    sendTrav(res, 'msa', { db, req: { ranges, label: b.label ?? 'Traversals', ...(b.reads && typeof b.reads === 'object' ? { reads: b.reads } : {}) }, label: String(b.label ?? 'Traversals'), flank: Number(flank),
      cap: argv.includes('--cap') ? Number(argv[argv.indexOf('--cap') + 1]) : null, maxLeaves: argv.includes('--max-leaves') ? Number(argv[argv.indexOf('--max-leaves') + 1]) : null })
    return
  }
  const t0 = Date.now()
  runScript(SCRIPT, argv, JSON.stringify({ ranges, label: b.label ?? 'Traversals', ...(b.reads && typeof b.reads === 'object' ? { reads: b.reads } : {}) }), TIMEOUT_MS).then(r => {
    if (!r.ok) { res.json({ error: 'MSA 抽出に失敗: ' + r.err.slice(-400) }); return }
    try { const o = JSON.parse(r.out); if (o && typeof o === 'object' && !o.error) o.ms = Date.now() - t0; res.json(o) }
    catch (e) { res.json({ error: 'MSA 出力を解釈できません: ' + (r.err ? r.err.slice(-400) : String(e)) }) }
  }).catch(e => res.json({ error: /timeout/.test(String(e?.message)) ? 'MSA 抽出がタイムアウトしました' : 'MSA 抽出に失敗: ' + String(e?.message ?? e) }))
})
