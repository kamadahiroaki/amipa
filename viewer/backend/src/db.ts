import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_DIR = process.env.DB_DIR || path.resolve(__dirname, '../../../data/db')

// 巨大 DB(WG 258GB 等)では索引の無い MAX/blob 全走査が同期でイベントループを数十秒〜分塞ぎ、
// サーバー全体が無反応になる。ファイルサイズで巨大判定し、そうした起動時スキャンを飛ばす閾値。
// stats.ts(coverage/hb/mult)と paths.ts(/annot_dicts の gene_cnt MAX)が共通で使う単一定義。
export const HUGE_DB_BYTES = 20e9
const fileSizeCache = new Map<string, number>()
export function dbBytes(filename: string): number {
  const safeName = path.basename(filename)
  if (!fileSizeCache.has(safeName)) {
    let n = 0
    try { n = fs.statSync(path.join(DB_DIR, safeName)).size } catch { /* ignore */ }
    fileSizeCache.set(safeName, n)
  }
  return fileSizeCache.get(safeName)!
}

const cache = new Map<string, Database.Database>()

// C(2026-07-22): 接続ごとの SQLite ページキャッシュを厚くする。backend は DB ごとに readonly 接続を
// 1つキャッシュ(下記 cache)しているので、その接続に大きめ cache_size を与えるとパンで一度読んだ
// ページが backend プロセス内に保持され、OS ページキャッシュが他ユーザの大ジョブで evict されても
// warm(~1ms) を維持できる(WG=Lustre & 共有ノードで効く)。DB ファイルは無改変・接続側ランタイム設定。
// ⚠ 初回 cold の実 I/O は減らない(データは一度 Lustre から読む)。負値=KB(上限、触った分だけ確保)。
// 巨大 DB(WG 等 >HUGE_DB_BYTES)は厚め、それ以外は控えめ。env AMIPA_CACHE_MB で上書き可。
function cacheKbFor(filename: string): number {
  const env = Number((process.env.AMIPA_CACHE_MB ?? process.env.GGB_CACHE_MB))
  if (Number.isFinite(env) && env > 0) return Math.round(env * 1024)
  return dbBytes(filename) >= HUGE_DB_BYTES ? 512 * 1024 : 64 * 1024
}
// mmap は Lustre で効かない/制限される場合があるため既定 off。AMIPA_MMAP_BYTES=<bytes> で有効化し実測して採否。
const MMAP_BYTES = Number((process.env.AMIPA_MMAP_BYTES ?? process.env.GGB_MMAP_BYTES)) || 0

export function getDb(filename: string): Database.Database {
  const cached = cache.get(filename)
  if (cached) {
    try {
      cached.prepare('SELECT 1').get()
      return cached
    } catch {
      cache.delete(filename)
      try { cached.close() } catch {}
    }
  }

  const safeName = path.basename(filename)
  const dbPath = path.join(DB_DIR, safeName)
  const db = new Database(dbPath, { readonly: true })
  try {
    db.pragma(`cache_size = -${cacheKbFor(filename)}`)
    if (MMAP_BYTES > 0) db.pragma(`mmap_size = ${MMAP_BYTES}`)
  } catch { /* pragma 失敗は致命的でない: 既定設定で続行 */ }
  attachHapIdx(db, dbPath)
  attachNameTri(db, dbPath)
  attachAnnot(db, dbPath)
  attachReads(db, dbPath)
  cache.set(filename, db)
  return db
}

// hap 絞り込み索引サイドカー `<db>.hapidx`（scripts/ggb_hapidx.py 産）があれば ix として ATTACH する。
// 無ければ何もしない（= 絞り込み機能だけ無効になり従来動作、graceful）。readonly 接続に ATTACH した
// DB は SQLite が同じフラグで開くので書き込み不可のまま（SQLITE_READONLY を実測確認済）。
// URI 形式は better-sqlite3 が SQLITE_USE_URI 無効でビルドされており CANTOPEN になるので素のパスで渡す。
export const HAPIDX_SUFFIX = '.hapidx'
export function hapIdxPath(dbPath: string): string { return dbPath + HAPIDX_SUFFIX }
function attachHapIdx(db: Database.Database, dbPath: string): void {
  const p = hapIdxPath(dbPath)
  try {
    if (!fs.existsSync(p)) return
    db.prepare('ATTACH DATABASE ? AS ix').run(p)
  } catch (e) {
    console.warn('hapidx attach failed (絞り込みは無効で続行):', p, String(e))
  }
}

// アノテーションのサイドカー `<db>.annot`（scripts/ggb_annot_sidecar.py 産）を an として ATTACH。
//
// ★なぜサイドカーが要るか（2026-08-10 実測）: 主 DB 内の node_annot は rowid 昇順に書いても
//   **物理配置が散る**。SQLite が新ページを **freelist から再利用**するためで、実測で
//   wgpggb.povu.fin は freelist 14.2GB / mcgrch38.povu.fin は 11.6GB もの穴がある
//   （emitter の hapidx --into-db が旧 R-Tree を drop した跡など）。その結果 node_annot の
//   走査が 4KB ランダム読みになり 0.4 MB/s / CPU 4% まで落ちた（索引作成が 7 時間見込み）。
//   新規ファイルには freelist が無いので追記＝物理連続が保証される。10GB 程度なので
//   順読みプリウォームも 6 秒で済む。主 DB 内で書き直しても再び freelist から取るので直らない。
// 無ければ何もしない（= 主 DB の node_annot にフォールバック、graceful）。
export const ANNOT_SUFFIX = '.annot'
export function annotPath(dbPath: string): string { return dbPath + ANNOT_SUFFIX }
function attachAnnot(db: Database.Database, dbPath: string): void {
  const p = annotPath(dbPath)
  try {
    if (!fs.existsSync(p)) return
    db.prepare('ATTACH DATABASE ? AS an').run(p)
  } catch (e) {
    console.warn('annot sidecar attach failed (主 DB の node_annot で続行):', p, String(e))
  }
}

// リード索引のサイドカー `<db>.reads`（scripts/ggb_reads_ondemand.py 産）を rd として ATTACH。
// 転置索引 node_reads(gfa_id→aln_id blob)・read_aln・read_cov・edge_read_support・read_src を持つ。
// per-visit の read_node は廃止（WG で 73億行に膨張するため）。base の layered DB は改変しない。
// 無ければ何もしない（= リード機能だけ無効で従来動作、graceful）。
export const READS_SUFFIX = '.reads'
export function readsPath(dbPath: string): string { return dbPath + READS_SUFFIX }
function attachReads(db: Database.Database, dbPath: string): void {
  const p = readsPath(dbPath)
  try {
    if (!fs.existsSync(p)) return
    db.prepare('ATTACH DATABASE ? AS rd').run(p)
  } catch (e) {
    console.warn('reads sidecar attach failed (リード機能は無効で続行):', p, String(e))
  }
}

// この接続でリード索引をどこから引くか。'rd' = サイドカー、'main' = 本体内（レガシー）、null = 無し。
const readsSchemaCache = new WeakMap<Database.Database, string | null>()
export function readsSchema(db: Database.Database): string | null {
  let v = readsSchemaCache.get(db)
  if (v === undefined) {
    v = null
    for (const s of ['rd', 'main']) {
      try {
        if (db.prepare(`SELECT 1 FROM ${s}.sqlite_master WHERE type='table' AND name='node_reads'`).get()) {
          v = s
          break
        }
      } catch { /* 未 ATTACH の rd は例外。無しとして次へ */ }
    }
    readsSchemaCache.set(db, v)
  }
  return v
}

// ノード名 trigram 索引（scripts/ggb_nametri.py 産）。新しい DB は emitter が **本体内** に
// nmdict/nmfts を作るので ATTACH 不要。旧 DB 向けにサイドカー `<db>.nametri` があれば tri として
// ATTACH する（無ければ何もしない＝部分一致だけ従来の全走査にフォールバック、graceful）。
// 解決順は nameTriSchema() が「本体 → サイドカー → 無し」で判定する。
export const NAMETRI_SUFFIX = '.nametri'
export function nameTriPath(dbPath: string): string { return dbPath + NAMETRI_SUFFIX }
function attachNameTri(db: Database.Database, dbPath: string): void {
  const p = nameTriPath(dbPath)
  try {
    if (!fs.existsSync(p)) return
    db.prepare('ATTACH DATABASE ? AS tri').run(p)
  } catch (e) {
    console.warn('nametri attach failed (部分一致は全走査で続行):', p, String(e))
  }
}

// この接続で trigram 索引をどう引けるか。'main' = 本体内 nmfts、'tri' = サイドカー、null = 無し。
const nameTriCache = new WeakMap<Database.Database, string | null>()
export function nameTriSchema(db: Database.Database): string | null {
  let v = nameTriCache.get(db)
  if (v === undefined) {
    v = null
    for (const s of ['main', 'tri']) {
      try {
        if (db.prepare(`SELECT 1 FROM ${s}.sqlite_master WHERE type='table' AND name='nmfts'`).get()) {
          v = s
          break
        }
      } catch { /* 未 ATTACH の tri は例外。無しとして次へ */ }
    }
    nameTriCache.set(db, v)
  }
  return v
}

// 書き込み用に開く（編集の DB 反映専用）。readonly キャッシュとは別に都度開いてクローズする。
// 別コネクションなので、コミット後はキャッシュ済み readonly 接続の次回読み取りに反映される。
export function getWritableDb(filename: string): Database.Database {
  const safeName = path.basename(filename)
  const dbPath = path.join(DB_DIR, safeName)
  return new Database(dbPath)
}

export function getDbDir(): string {
  return DB_DIR
}
