/**
 * 導入確認コマンド（`amipa check`）。
 *
 * 「入れた／マウントしたものが本当に使えるか」をサーバを起動せずに確かめる。
 * ★巨大 DB(WG 250GB+)でも一瞬で終わるよう、**全走査になるクエリを一切使わない**
 *   （COUNT(*) / MIN / MAX / GROUP BY は禁止。db_meta・stats・PRAGMA・LIMIT 1 のみ）。
 *
 *   使い方: amipa check            … DB_DIR の全 DB
 *           amipa check <name|path> … 1 つだけ
 *   終了コード: 0=致命的な問題なし / 1=あり
 */
import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { AMIPA_PYTHON, amipaScript } from './pyenv'

const DB_DIR = process.env.DB_DIR || path.resolve(__dirname, '../../../data/db')
let failed = false

const ok = (m: string) => console.log(`  ok    ${m}`)
const warn = (m: string) => console.log(`  warn  ${m}`)
const bad = (m: string) => { failed = true; console.log(`  FAIL  ${m}`) }
const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`

function checkRuntime(): void {
  console.log('runtime')
  console.log(`  node ${process.version}`)
  // SQLite の機能: R-Tree(ビューポート検索) と FTS5(ノード名 trigram 検索) が無いと viewer は成立しない。
  const probe = new Database(':memory:')
  for (const opt of ['ENABLE_RTREE', 'ENABLE_FTS5']) {
    const used = probe.prepare('SELECT sqlite_compileoption_used(?) AS u').get(opt) as { u: number }
    used.u ? ok(`sqlite ${opt}`) : bad(`sqlite ${opt} が無い（この better-sqlite3 では viewer は動かない）`)
  }
  console.log(`  sqlite ${(probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v}`)
  probe.close()
  // Python ヘルパ（bubble MSA パネル / reads 表示）。無くてもグラフ表示は動くので warn 止まり。
  try {
    const out = execFileSync(AMIPA_PYTHON, ['-c', 'import numpy,sys;print(sys.version.split()[0],numpy.__version__)'],
      { encoding: 'utf8', timeout: 20000 }).trim()
    ok(`python ${AMIPA_PYTHON} (${out}) + numpy`)
  } catch {
    warn(`python(${AMIPA_PYTHON})+numpy が使えない → bubble MSA パネルが無効（グラフ表示は可）`)
  }
  for (const s of ['bubble_msa.py', 'reads_query.py', 'cs_ops.py', 'zstd_seek.py']) {
    fs.existsSync(amipaScript(s)) ? ok(`script ${s}`) : warn(`script ${s} が無い`)
  }
}


// リード整列サイドカーの点検。索引が指す実体が本当にそこにあり、開ける形式かまで見る。
function checkReads(sidecar: string, dbPath: string): void {
  let rd: Database.Database
  try { rd = new Database(sidecar, { readonly: true, fileMustExist: true }) }
  catch (e) { bad(`.reads を開けない: ${(e as Error).message}`); return }
  try {
    const meta = Object.fromEntries((rd.prepare('SELECT key,value FROM read_meta').all() as
      { key: string, value: string }[]).map(r => [r.key, r.value]))
    const cols = new Set((rd.prepare('PRAGMA table_info(read_src)').all() as { name: string }[]).map(r => r.name))
    const pathCol = cols.has('path') ? 'path' : 'bgzf_path'
    const rows = rd.prepare(`SELECT sample_id, ${pathCol} AS p, n_reads FROM read_src`).all() as
      { sample_id: string, p: string, n_reads: number }[]
    ok(`reads: サイドカー.reads (${gb(fs.statSync(sidecar).size)}) — ${rows.length} サンプル`
      + `, aln ${Number(meta.n_aln || 0).toLocaleString()}`
      + (meta.dropped_tags ? `, 保存時に捨てたタグ ${meta.dropped_tags}` : ''))
    const dir = path.dirname(fs.realpathSync(dbPath))
    for (const r of rows) {
      const base = path.basename(r.p)
      const found = [path.join(dir, 'reads', base), path.join(dir, base), r.p].find(q => fs.existsSync(q))
      if (!found) { bad(`reads: ${r.sample_id} の実体が無い（${base}）→ リード表示が空になる`); continue }
      // 末尾 9 バイトの seekable zstd マジック（旧アトラスは BGZF なので判定しない）
      let kind = 'bgzf'
      if (base.endsWith('.zst')) {
        const fd = fs.openSync(found, 'r')
        const buf = Buffer.alloc(9)
        try { fs.readSync(fd, buf, 0, 9, fs.fstatSync(fd).size - 9) } finally { fs.closeSync(fd) }
        if (buf.readUInt32LE(5) !== 0x8F92EAB1) {
          bad(`reads: ${base} にシークテーブルが無い（seekable zstd ではない）`)
          continue
        }
        kind = 'zstd'
      }
      ok(`  ${r.sample_id}: ${path.relative(dir, found)} (${gb(fs.statSync(found).size)}, ${kind})`
        + `, ${Number(r.n_reads || 0).toLocaleString()} reads`)
    }
  } catch (e) {
    bad(`.reads の点検でエラー: ${(e as Error).message}`)
  } finally {
    rd.close()
  }
}

function checkDb(dbPath: string): void {
  const name = path.basename(dbPath)
  console.log(`\n${name}`)
  let st: fs.Stats
  try { st = fs.statSync(dbPath) } catch { bad(`開けない: ${dbPath}`); return }
  console.log(`  path  ${fs.realpathSync(dbPath)}`)
  console.log(`  size  ${gb(st.size)}`)

  let db: Database.Database
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }) }
  catch (e) { bad(`SQLite として開けない: ${(e as Error).message}`); return }

  try {
    const need = ['nodes', 'edges', 'nodes_rtree', 'stats', 'db_meta']
    const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map(r => r.name))
    const miss = need.filter(t => !have.has(t))
    miss.length ? bad(`必須テーブルが無い: ${miss.join(', ')}`) : ok(`必須テーブル (${need.length})`)

    const meta = Object.fromEntries((db.prepare('SELECT key,value FROM db_meta').all() as { key: string, value: string }[])
      .map(r => [r.key, r.value]))
    const feats = (meta.features || '').split(',').filter(Boolean)
    console.log(`  built ${meta.built_at || '?'}  emitter ${meta.emitter_rev || '?'}`)
    console.log(`  feat  ${feats.join(' ') || '(none)'}`)
    const maxlayer = (db.prepare('SELECT maxlayer FROM stats LIMIT 1').get() as { maxlayer: number } | undefined)?.maxlayer
    maxlayer == null ? bad('stats が空（層情報が無い）') : ok(`layers 0..${maxlayer}`)
    db.prepare('SELECT rowid FROM nodes_rtree LIMIT 1').get()   // R-Tree が引けるか（全走査しない）
    ok('R-Tree 参照')

    // 索引の在り処は「DB 本体に内蔵」か「サイドカーを ATTACH」の 2 通り（db.ts と同じ判定）。
    // features に書いてあるのにどちらも無い＝機能が**黙って**落ちる状態なので、それを検出する。
    const real = fs.realpathSync(dbPath)
    const side = (suffix: string) => [dbPath + suffix, real + suffix].find(p => fs.existsSync(p)) || null
    const rtreeCols = new Set((db.prepare('PRAGMA table_info(nodes_rtree)').all() as { name: string }[]).map(r => r.name))
    const inMain: Record<string, boolean> = {
      hapidx: have.has('hapidx_meta') && rtreeCols.has('hm0'),
      nametri: have.has('nmfts') || have.has('nmfts_data'),
      annot: have.has('node_annot'),
    }
    for (const [suffix, feat, what] of [
      ['.hapidx', 'hapidx', 'ハプロタイプ絞り込み'],
      ['.nametri', 'nametri', 'ノード名の部分一致検索'],
      ['.annot', 'annot', 'アノテーション'],
    ] as [string, string, string][]) {
      const p = side(suffix)
      if (p) ok(`${feat}: サイドカー${suffix} (${gb(fs.statSync(p).size)}) — ${what}`)
      else if (inMain[feat]) ok(`${feat}: DB 本体に内蔵 — ${what}`)
      else if (feats.includes(feat)) warn(`${feat} が見つからない（features には書いてある）→ ${what}が使えない`)
    }
    const dis = side('.distill')
    if (dis && fs.existsSync(path.join(dis, 'p_tok.npy'))) ok(`sidecar .distill — bubble MSA`)
    else if (feats.includes('distill_msa')) warn('.distill が無い/不完全 → bubble MSA パネルが使えない')

    // リード整列: 索引はサイドカー .reads、実体は reads/<サンプル>.gaf.zst。
    // 索引だけあって実体が無い（＝別マシンへ半分だけ運んだ）状態を検出する。
    const rp = side('.reads')
    if (rp) checkReads(rp, dbPath)
  } catch (e) {
    bad(`点検中のエラー: ${(e as Error).message}`)
  } finally {
    db.close()
  }
}

console.log(`DB_DIR = ${DB_DIR}`)
checkRuntime()

const arg = process.argv[2]
let targets: string[]
if (arg) {
  targets = [arg.includes('/') ? arg : path.join(DB_DIR, arg)]
} else {
  let ents: string[] = []
  try { ents = fs.readdirSync(DB_DIR) } catch { bad(`DB_DIR を読めない: ${DB_DIR}（マウントし忘れ？）`) }
  targets = ents.filter(f => f.endsWith('.db')).sort().map(f => path.join(DB_DIR, f))
  if (!targets.length) bad(`DB_DIR に *.db が無い: ${DB_DIR}`)
}
for (const t of targets) checkDb(t)

console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: OK')
process.exit(failed ? 1 : 0)
