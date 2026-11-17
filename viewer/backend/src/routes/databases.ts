import { Router } from 'express'
import fs from 'fs'
import { execSync } from 'child_process'
import { READONLY } from '../config'
import { getDb, getDbDir, readsSchema } from '../db'
import { dataAvail } from '../availability'

export const databasesRouter = Router()

// 画面が要求する backend の API 段階（frontend/src/api/client.ts の API_LEVEL_REQUIRED と合わせて上げる）。
// 古い配信ジョブに新しい画面で繋いだときに、画面側が「backend が古い」と出せるようにする（木の根・接合・genes_cols を使う画面は 3）
export const API_LEVEL = 3

// viewer の版。起動時 1 回だけ解決してキャッシュ。
// ★コンテナには .git も git も無いので、イメージのビルド時に埋めた値を先に見る。
//   git を呼ぶのはリポジトリ直実行のときだけ（stderr も捨てる。無い環境で
//   "fatal: not a git repository" が起動ログに出ると障害に見える）。
const VIEWER_REV = (() => {
  const baked = process.env.AMIPA_COMMIT || process.env.AMIPA_VERSION
  if (baked && baked !== 'unknown' && baked !== 'dev') return baked
  try {
    return execSync('git rev-parse --short HEAD',
                    { cwd: __dirname, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return 'unknown' }
})()

// 上部バー用: viewer 版 + 指定 DB のビルド由来(db_meta)/機能フラグ。
// db_meta の無い旧 DB はファイル mtime にフォールバック。leaf_seq/inv/mult は表存在で検出。
databasesRouter.get('/version', (req, res) => {
  const { db } = req.query as Record<string, string>
  // ★ここが `/api/version` の唯一の実装。以前は server.ts にも同じパスがあって**こちらを覆い隠して**
  //   いたため、画面側は viewer 版も db の機能フラグ(leaf_seq 等)も受け取れていなかった。
  //   配信モード(readonly)と版の刻印も含めた上位集合を返す（配備スクリプトもこれを見る）。
  const out: any = {
    viewer: VIEWER_REV,
    api_level: API_LEVEL,
    name: 'amipa-viewer',
    version: process.env.AMIPA_VERSION ?? 'dev',
    commit: process.env.AMIPA_COMMIT ?? null,
    built_at: process.env.AMIPA_BUILT_AT ?? null,
    node: process.version,
    readonly: READONLY,
    db_dir: getDbDir(),
  }
  if (db) {
    try {
      const d = getDb(db)
      const meta: Record<string, string> = {}
      try {
        for (const r of d.prepare('SELECT key, value FROM db_meta').all() as { key: string; value: string }[])
          meta[r.key] = r.value
      } catch { /* db_meta 無し(旧 DB) */ }
      const has = (t: string) => { try { d.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); return true } catch { return false } }
      let mtime: string | null = null
      try { mtime = fs.statSync(`${getDbDir()}/${db.replace(/[^A-Za-z0-9._-]/g, '')}`).mtime.toISOString() } catch { /* */ }
      out.db = {
        name: db,
        built_at: meta.built_at ?? null,
        emitter_rev: meta.emitter_rev ?? null,
        mtime,
        features: {
          seq: has('leaf_seq'),
          inv: has('node_contig_inv'),
          mult: has('node_hap_mult'),
          contigcov: has('node_contig_cov'),
        },
        avail: (() => {
          const v = { ...dataAvail(db) }
          // 旧 DB は本体の中にリード索引・注釈を持つことがある
          if (!v.reads.ok && readsSchema(d) === 'main') v.reads = { ...v.reads, ok: true, why: undefined }
          if (!v.annot.ok && has('node_annot')) v.annot = { ...v.annot, ok: true, why: undefined }
          return v
        })(),
      }
    } catch (e) { out.db = { name: db, error: String(e) } }
  }
  res.json(out)
})

databasesRouter.get('/databases', (_req, res) => {
  const dbDir = getDbDir()
  let files: string[]
  try {
    files = fs.readdirSync(dbDir)
      .filter(f => f.endsWith('.db'))
      .sort()
  } catch (e) {
    res.status(500).json({ error: 'Could not read DB directory' })
    return
  }
  res.json(files)
})
