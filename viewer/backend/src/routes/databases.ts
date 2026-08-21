import { Router } from 'express'
import fs from 'fs'
import { execSync } from 'child_process'
import { READONLY } from '../config'
import { getDb, getDbDir } from '../db'

export const databasesRouter = Router()

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
    name: 'amipa-viewer',
    version: process.env.AMIPA_VERSION ?? process.env.GGB_VERSION ?? 'dev',
    commit: process.env.AMIPA_COMMIT ?? process.env.GGB_COMMIT ?? null,
    built_at: process.env.AMIPA_BUILT_AT ?? process.env.GGB_BUILT_AT ?? null,
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
      // ★rtree_built_at / rad も返す。db_meta.built_at は ④ emit の時刻で、後から
      //   `hap_index --into-db` だけ回しても変わらない（radius 修正の再構築で実際に
      //   「built_at が古いままだがこれで合っているのか」となった）。R-Tree は描画の
      //   高速経路が読む実体なので、そちらの時刻と rad の有無を上部バーで見せる。
      const hmeta: Record<string, string> = {}
      try {
        for (const r of d.prepare('SELECT key, value FROM hapidx_meta').all() as
             { key: string; value: string }[]) hmeta[r.key] = r.value
      } catch { /* hapidx 無し */ }
      const rtreeCols = (() => {
        try { return (d.prepare('PRAGMA table_info(nodes_rtree)').all() as any[])
          .map(c => String(c.name)) } catch { return [] as string[] }
      })()
      out.db = {
        name: db,
        built_at: meta.built_at ?? null,
        emitter_rev: meta.emitter_rev ?? null,
        mtime,
        rtree_built_at: hmeta.rtree_built_at ?? hmeta.built_at ?? null,
        rad: rtreeCols.includes('rad'),
        features: {
          seq: has('leaf_seq'),
          inv: has('node_contig_inv'),
          mult: has('node_hap_mult'),
          contigcov: has('node_contig_cov'),
        },
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
