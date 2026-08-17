import { Router } from 'express'
import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'
import { getDb, getDbDir } from '../db'
import { AMIPA_PYTHON, amipaScript } from '../pyenv'

export const bubbleMsaRouter = Router()

// bubble(S ノード)の MSA は distill(順序付きウォーク p_tok/p_ori)を要る。backend は distill を持たない
// ので、Python 抽出器(scripts/bubble_msa.py)を **async で spawn** して JSON を得る。
//   ・async spawn なので better-sqlite3 の同期クエリと違いイベントループを塞がない(server.ts の
//     abort ガードと両立。ハンドラの同期部分は spawn 呼びだけで一瞬)。
//   ・distill の場所は DB と同じサイドカー規約 `<dbpath>.distill`(hapidx/nametri と同型)。
//     emitter(layout_emit_db_relayer.py)が `<out-db>.distill` の symlink をビルド末尾に張る。
const PYTHON = AMIPA_PYTHON                       // 既定は PATH の python3（pyenv.ts 参照）
const SCRIPT = amipaScript('bubble_msa.py')       // = viewer/scripts/bubble_msa.py
const TIMEOUT_MS = Number((process.env.AMIPA_MSA_TIMEOUT_MS ?? process.env.MSA_TIMEOUT_MS)) || 30000
const MAXBUF = 32 * 1024 * 1024
// 走査するウォーク token 数の上限(抽出器の既定 8 億 = WG cold ~12s 相当)。WG で全 hap を選んだ
// ときに timeout する前にエラーで返させるための安全弁で、env で緩められる。
const MAX_TOKENS = Number((process.env.AMIPA_MSA_MAX_TOKENS ?? process.env.MSA_MAX_TOKENS)) || 0

// distill の在り処を 3 段で解決する。emitter は「実 DB の隣」に張るが、DB_DIR の実体は
// e2e/db・wg/ への **symlink 運用**なので素の `<DB_DIR>/<db>.distill` だけでは足りない。
//   (1) `<DB_DIR>/<db>.distill`         … 手動リンクを最優先(実験時の差し替えが効くように)
//   (2) `realpath(<db>)+'.distill'`     … emitter が張ったサイドカー(symlink 運用でも届く)
//   (3) db_meta.inputs.distill.path     … サイドカー導入前に建った既存 DB(WG 等)の救済。
//       emitter は昔から入力の出自を db_meta に刻んでいるので、再ビルドせず MSA が使える。
function distillFor(dbPath: string): string | null {
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

bubbleMsaRouter.get('/bubble_msa', (req, res) => {
  const { db, nodes, samples } = req.query as Record<string, string>
  if (!db) { res.status(400).json({ error: 'Missing db query parameter' }); return }
  if (!nodes) { res.status(400).json({ error: 'Missing nodes query parameter' }); return }
  // ★ `Number(x) || 4` だと flank=0 が 4 に化ける(0 は falsy)。0 を通すため明示的に判定する。
  const fq = Number(req.query.flank)
  const flank = String(Number.isFinite(fq) ? Math.max(0, Math.min(12, fq)) : 4)

  const dbPath = path.join(getDbDir(), path.basename(db))
  if (!fs.existsSync(dbPath)) { res.status(404).json({ error: 'DB が見つかりません' }); return }
  const distill = distillFor(dbPath)
  if (!distill) {
    res.json({ error: 'この DB には MSA 用 distill サイドカーがありません（' +
      path.basename(dbPath) + '.distill）。emitter を --distill / --distill-sidecar-dir 付きで' +
      '再実行するか、ln -s <…>.distill で張ってください。' })
    return
  }
  const argv = [SCRIPT, '--db', dbPath, '--distill', distill, '--nodes', nodes, '--flank', flank]
  if (samples) argv.push('--samples', samples)
  if (MAX_TOKENS > 0) argv.push('--max-tokens', String(MAX_TOKENS))
  execFile(PYTHON, argv,
    { timeout: TIMEOUT_MS, maxBuffer: MAXBUF },
    (err, stdout, stderr) => {
      if (err) {
        res.json({ error: 'MSA 抽出に失敗: ' + (stderr ? String(stderr).slice(0, 400) : String(err)) })
        return
      }
      try { res.json(JSON.parse(stdout)) }
      catch (e) { res.json({ error: 'MSA 出力を解釈できません: ' + String(e) }) }
    })
})
