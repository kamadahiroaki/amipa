import { Router } from 'express'
import { execFile, spawn } from 'child_process'
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

// Blocks パネルの底からの受け渡し: 各行（パス）のトークン範囲を stdin の JSON で渡し、その範囲の塩基レベル MSA を返す。
//   POST /api/bubble_msa/ranges  body {db, ranges:[[path, s0, e0], …], label, flank}
//   S（列）は範囲内のトークンの葉集合、行は与えたパスの範囲だけ。上限は bubble_msa.py の MAX_LEAVES（400 葉）。
bubbleMsaRouter.post('/bubble_msa/ranges', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const db = typeof b.db === 'string' ? b.db : ''
  const ranges = Array.isArray(b.ranges) ? (b.ranges as unknown[]) : []
  if (!db) { res.status(400).json({ error: 'Missing db' }); return }
  if (!ranges.length || !ranges.every(r => Array.isArray(r) && r.length === 3 && typeof r[0] === 'string')) { res.status(400).json({ error: 'ranges must be [[path, s0, e0], ...]' }); return }
  const fq = Number(b.flank); const flank = String(Number.isFinite(fq) ? Math.max(0, Math.min(12, fq)) : 0)
  const dbPath = path.join(getDbDir(), path.basename(db))
  if (!fs.existsSync(dbPath)) { res.status(404).json({ error: 'DB が見つかりません' }); return }
  const distill = distillFor(dbPath)
  if (!distill) { res.json({ error: 'この DB には MSA 用 distill サイドカーがありません（' + path.basename(dbPath) + '.distill）' }); return }
  const argv = [SCRIPT, '--db', dbPath, '--distill', distill, '--ranges-stdin', '--flank', flank, '--label', String(b.label ?? 'Blocks')]
  if (b.cap != null && Number.isFinite(Number(b.cap))) argv.push('--cap', String(Math.max(0, Math.floor(Number(b.cap)))))   // 0 = 畳まない（Blocks パネルは画面側で畳む）
  if (b.maxLeaves != null && Number.isFinite(Number(b.maxLeaves))) argv.push('--max-leaves', String(Math.max(1, Math.min(4000, Math.floor(Number(b.maxLeaves))))))   // 葉の上限（既定 400。変異の少ない区間は上げる）
  const child = spawn(PYTHON, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', errTxt = ''; let done = false
  const timer = setTimeout(() => { if (!done) { done = true; try { child.kill() } catch { /* ignore */ } res.json({ error: 'MSA 抽出がタイムアウトしました' }) } }, TIMEOUT_MS)
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (d: string) => { out += d })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (d: string) => { errTxt += d })
  child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); res.json({ error: 'MSA 抽出に失敗: ' + String(e) }) })
  child.on('close', () => {
    if (done) return; done = true; clearTimeout(timer)
    try { res.json(JSON.parse(out)) } catch (e) { res.json({ error: 'MSA 出力を解釈できません: ' + (errTxt ? errTxt.slice(0, 400) : String(e)) }) }
  })
  child.stdin.on('error', () => { /* ignore */ })
  child.stdin.end(JSON.stringify({ ranges, label: b.label ?? 'Blocks' }))
})
