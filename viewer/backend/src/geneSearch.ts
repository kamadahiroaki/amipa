// 遺伝子検索（11-12）: 前処理の索引 <db>.gsearch（prep/amipa_prep/gsearch_build.py）を引く。設計 amipa-lab/plans/viewer-cold-bounded.md ⑤
//   以前は Traversals の worker の列に並び（重い要求の後ろで 90〜125 秒待った）、.genes（8.7 GB）から株ごとの写しを 1 件ずつ引いていた（初回 3 秒）。
//   ここはメインスレッドで直接答える。1 回に読むのは、索引の B-tree を数回たどる数ページと、名前の順に並んだ要約（gsum）の数ページだけ（上限つき）。
//   .gsearch が無い・.genes より古いときは null を返し、呼び手が従来の経路（worker の findgene）に回す
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDbDir } from './db'

type GS = { db: Database.Database; hasProd: boolean; file: string; mtime: number }
const cache = new Map<string, GS | null>()

function fileOf(db: string, ext: string): string | null {
  const base = path.join(getDbDir(), path.basename(db)); const cands = [base + ext]; try { cands.push(fs.realpathSync(base) + ext) } catch { /* ignore */ }
  return cands.find(c => { try { return fs.existsSync(c) } catch { return false } }) ?? null
}

function open(db: string): GS | null {
  const f = fileOf(db, '.gsearch'); if (!f) { cache.set(db, null); return null }
  const mt = fs.statSync(f).mtimeMs; const c = cache.get(db); if (c && c.file === f && c.mtime === mt) return c
  if (c) { try { c.db.close() } catch { /* ignore */ } }
  const d = new Database(f, { readonly: true, fileMustExist: true })
  const meta = Object.fromEntries((d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]))
  // .genes が作り直されていたら使わない（sid・座標がずれる）
  const gf = fileOf(db, '.genes'); if (gf) { const st = fs.statSync(gf); if (String(st.size) !== meta.genes_size) { console.log(`[gsearch] ${f} は .genes と合わない（作り直しが要る）`); d.close(); cache.set(db, null); return null } }
  // 小さい（全ゲノムで数十 MB）ので開いたときに順に読み流してキャッシュに載せる（大きなファイルの先読みはしない方針の例外: 上限 64 MB）
  try { const sz = fs.statSync(f).size; if (sz <= 64 << 20) { const fd = fs.openSync(f, 'r'); const b = Buffer.allocUnsafe(1 << 22); let o = 0; while (o < sz) { const k = fs.readSync(fd, b, 0, b.length, o); if (k <= 0) break; o += k } fs.closeSync(fd) } } catch { /* 先読みは無くてもよい */ }
  const g: GS = { db: d, hasProd: !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'gprod'").get(), file: f, mtime: mt }
  cache.set(db, g); return g
}

export type GeneHit = { sid: number; gid: number; name: string; locus: string; type: string; pseudo: boolean; product: string; nhap: number; ncopy: number; x0: number; x1: number; places: [number, number, number][] | null; match: 'exact' | 'prefix' | 'product' }

/** 検索。.gsearch が使えなければ null（呼び手が従来の経路へ） */
export function searchGenes(db: string, q: string, limit = 60): { q: string; genes: GeneHit[]; truncated: boolean; ms: number } | null {
  const g = open(db); if (!g) return null
  const t0 = Date.now(); const qn = q.trim().toLowerCase(); if (!qn) return { q, genes: [], truncated: false, ms: 0 }
  const order: number[] = []; const how = new Map<number, GeneHit['match']>(); let truncated = false
  const add = (sid: number, m: GeneHit['match']) => { if (!how.has(sid)) { how.set(sid, m); order.push(sid) } }
  for (const r of g.db.prepare('SELECT sid FROM gkey WHERE key = ?').raw().all(qn) as [number][]) add(r[0], 'exact')
  // 前方一致: 索引の範囲。短い語（例 "a"）は大量に当たるので上限で切り、短い語・名前の順に
  const pre = g.db.prepare('SELECT key, sid FROM gkey WHERE key >= ? AND key < ? LIMIT ?').raw().all(qn, qn + '￿', limit * 4 + 1) as [string, number][]
  if (pre.length > limit * 4) truncated = true
  pre.sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); for (const [, sid] of pre) add(sid, 'prefix')
  if (g.hasProd && qn.length >= 3 && order.length < limit) {
    const want = limit - order.length
    const pr = g.db.prepare('SELECT sid FROM gprod WHERE instr(p, ?) > 0 LIMIT ?').raw().all(qn, want + 1) as [number][]   // 産物名は数 MB の連続した表をなめる
    if (pr.length > want) truncated = true
    for (const [sid] of pr) add(sid, 'product')
  }
  if (order.length > limit) { truncated = true; order.length = limit }
  const rows = order.length ? g.db.prepare(`SELECT sid, gid, name, locus, type, pseudo, product, nhap, ncopy, x0, x1, places FROM gsum WHERE sid IN (${order.map(() => '?').join(',')})`).all(...order) as any[] : []
  const bySid = new Map(rows.map(r => [r.sid as number, r]))
  const genes = order.map(sid => { const r = bySid.get(sid); return r ? { ...r, pseudo: !!r.pseudo, places: r.places ? JSON.parse(r.places) : null, match: how.get(sid)! } as GeneHit : null }).filter((x): x is GeneHit => !!x)
  return { q, genes, truncated, ms: Date.now() - t0 }
}

/** 1 遺伝子の株ごとの写し（hid, x0, x1）。場所が分かれる遺伝子で、選んだ場所の株を出すときに */
export function geneCopies(db: string, sid: number): { sid: number; copies: [number, number, number][] } | null {
  const g = open(db); if (!g) return null
  const r = g.db.prepare('SELECT c FROM gcopy WHERE sid = ?').get(sid) as { c: Buffer } | undefined
  if (!r) return { sid, copies: [] }
  const v = new Int32Array(r.c.buffer.slice(r.c.byteOffset, r.c.byteOffset + r.c.byteLength)); const out: [number, number, number][] = []
  for (let i = 0; i + 2 < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]])
  return { sid, copies: out }
}
