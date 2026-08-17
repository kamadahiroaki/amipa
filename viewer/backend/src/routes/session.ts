import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getDbDir } from '../db'

// 状態スナップショットの保存先（DB_DIR の隣に sessions/）
const SESSION_DIR = process.env.SESSION_DIR || path.resolve(getDbDir(), '../sessions')
const MAX_BYTES  = 512 * 1024              // 1件あたり上限（URL長制限は無いが本体は必ず制限）
const TTL_MS     = 90 * 24 * 3600 * 1000   // 90日でTTL失効
const MAX_FILES  = 5000                     // 総件数上限（超過は古い順に削除）
const ID_RE      = /^[A-Za-z0-9_-]{12,64}$/

function ensureDir() { fs.mkdirSync(SESSION_DIR, { recursive: true }) }

function sweep() {
  try {
    ensureDir()
    const now = Date.now()
    const stats = fs.readdirSync(SESSION_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const p = path.join(SESSION_DIR, f)
        let m = 0; try { m = fs.statSync(p).mtimeMs } catch {}
        return { p, m }
      })
    for (const s of stats) if (now - s.m > TTL_MS) { try { fs.unlinkSync(s.p) } catch {} }
    const alive = stats.filter(s => now - s.m <= TTL_MS).sort((a, b) => b.m - a.m)
    for (const s of alive.slice(MAX_FILES)) { try { fs.unlinkSync(s.p) } catch {} }
  } catch {}
}

// 簡易レート制限（書き込み: IP毎 30回/分）
const writeLog = new Map<string, number[]>()
function rateOk(ip: string): boolean {
  const now = Date.now(), win = 60_000, max = 30
  const arr = (writeLog.get(ip) ?? []).filter(t => now - t < win)
  if (arr.length >= max) { writeLog.set(ip, arr); return false }
  arr.push(now); writeLog.set(ip, arr)
  return true
}

export const sessionRouter = Router()
let sweepCount = 0

// 状態を保存して短い id を返す
sessionRouter.post('/session', (req, res) => {
  if (!rateOk(req.ip || 'unknown')) { res.status(429).json({ error: 'rate limited' }); return }
  const body = req.body
  if (body == null || typeof body !== 'object') { res.status(400).json({ error: 'invalid body' }); return }
  const text = JSON.stringify(body)
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) { res.status(413).json({ error: 'too large' }); return }
  try {
    ensureDir()
    if ((sweepCount++ % 50) === 0) sweep()
    const id = crypto.randomBytes(12).toString('base64url')   // 推測不能・16文字
    fs.writeFileSync(path.join(SESSION_DIR, `${id}.json`), text)
    res.json({ id })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// id から状態を取得
sessionRouter.get('/session', (req, res) => {
  const id = String(req.query.id ?? '')
  if (!ID_RE.test(id)) { res.status(400).json({ error: 'bad id' }); return }   // パストラバーサル防止
  try {
    const text = fs.readFileSync(path.join(SESSION_DIR, `${id}.json`), 'utf8')
    res.type('application/json').send(text)
  } catch {
    res.status(404).json({ error: 'not found' })
  }
})
