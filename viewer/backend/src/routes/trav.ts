import path from 'path'
import { getDbDir } from '../db'
// 通過サイドカー `<db>.trav` の API（試作）。GET /api/trav/root?db  /api/trav/range?db&x0&x1[&min]  /api/trav/path?db&pid
import { Router } from 'express'
import fs from 'fs'
import Database from 'better-sqlite3'
import { sendTrav } from '../travClient'
import { annPathOf } from '../travOps'

export const travRouter = Router()

// 11-04: 計算は travWorker（travOps.ts）で。メインは要求を渡して返事をそのまま返すだけ
for (const op of ['root', 'range', 'path', 'atoms', 'chroms', 'nodes', 'cols', 'nleaf', 'reads', 'genes', 'nodeset', 'locate', 'findgene', 'genedensity'])
  travRouter.get('/trav/' + op, (req, res) => sendTrav(res, op, req.query as Record<string, string>))
travRouter.post('/trav/locate', (req, res) => { const b = (req.body ?? {}) as Record<string, unknown>; if (!b.db) { res.status(400).json({ error: 'Missing db' }); return } sendTrav(res, 'locate', { db: String(b.db), names: Array.isArray(b.names) ? b.names : [] }) })

// 撮影・試験用: 指定 ms 待ってから 1×1 の GIF を返す（headless firefox で <img src=…/api/sleep?ms=8000> を置くと load がその分遅れ、非同期の描画を待てる）
travRouter.get('/sleep', (req, res) => {
  const ms = Math.max(0, Math.min(20000, Number((req.query as Record<string, string>).ms) || 0))
  setTimeout(() => { res.type('image/gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')) }, ms)
})

// ---- 参照座標の注釈（<db>.ann: RepeatMasker・GIAB の変異とベンチマーク領域。build_ann.py で作る）----
//   GET /api/trav/ann?db&contig&s&e  → 区間 [s, e)（参照の 0 始まり）に掛かる反復・変異・ベンチマーク領域。塩基の段が列の参照位置に写して描く
const annDbs = new Map<string, Database.Database | null>()
function annDbOf(db: string): Database.Database | null { if (!annDbs.has(db)) { const f = annPathOf(db); annDbs.set(db, f ? new Database(f, { readonly: true }) : null) } return annDbs.get(db)! }
// 参照の名前の形の違いを吸収する（11-03）: 注釈の contig は chr1 の形。パス名は PanSN（GRCh38#chr1 → 最後の # の後）か、# の無い P 行（全ゲノム MC の
//   GRCh38.chr1 → 最初の . の後）。そのまま無ければ順に試す
function annContigOf(d: Database.Database, c: string): string {
  const cands = [c, c.slice(c.lastIndexOf('#') + 1)]; if (!c.includes('#') && c.includes('.')) cands.push(c.slice(c.indexOf('.') + 1))
  for (const x of cands) if (d.prepare('SELECT 1 FROM rmsk WHERE contig = ? LIMIT 1').get(x) || d.prepare('SELECT 1 FROM var WHERE contig = ? LIMIT 1').get(x)) return x
  return c
}
travRouter.get('/trav/ann', (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db || !q.contig) { res.status(400).json({ error: 'Missing db/contig' }); return }
  const d = annDbOf(q.db); if (!d) { res.status(404).json({ error: 'no .ann sidecar' }); return }
  const s = Math.max(0, Number(q.s) || 0), e = Number(q.e) || 0
  if (!(e > s) || e - s > 5_000_000) { res.status(400).json({ error: 'range must be 1 bp – 5 Mb' }); return }
  try {
    const meta = Object.fromEntries((d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]))
    const ml = Number(meta.maxlen_rmsk) || 0, mb = Number(meta.maxlen_bench) || 0
    const contig = annContigOf(d, q.contig)
    const rmsk = ml ? d.prepare('SELECT s, e, strand, name, cls, fam, div FROM rmsk WHERE contig = ? AND s >= ? AND s < ? AND e > ? ORDER BY s').all(contig, s - ml, e, s) : []
    const vars = d.prepare('SELECT sample, pos, ref, alt, gt FROM var WHERE contig = ? AND pos >= ? AND pos < ? ORDER BY pos').all(contig, s - 200, e)
    const samples = (d.prepare('SELECT DISTINCT sample FROM bench').all() as { sample: string }[]).map(r => r.sample)
    const bench: Record<string, [number, number][]> = {}
    for (const sm of samples) bench[sm] = (d.prepare('SELECT s, e FROM bench WHERE sample = ? AND contig = ? AND s >= ? AND s < ? AND e > ? ORDER BY s').all(sm, contig, s - mb, e, s) as { s: number; e: number }[]).map(r => [r.s, r.e])
    res.json({ ref: meta.ref_key, contig, s, e, rmsk, vars, bench, samples, src: { rmsk: meta.src_rmsk, vcf: samples.map(sm => meta['src_vcf_' + sm]) } })
  } catch (err) { res.status(500).json({ error: String(err) }) }
})

// ---- 1 株の GFF を入力どおりに書き出す（<db>.genes の gff_header と feature を元の行番号の順に）。11-02 に Blocks の /api/blocks/gff から移した ----
//   GET /api/trav/gff?db&acc   acc = パス名の # の前（GFF のファイル名）。写した注釈（genes_project.py、acc が空）は含めない
function genesFileOf(db: string): string | null { const base = path.join(getDbDir(), path.basename(db)); const cands = [base + '.genes']; try { cands.push(fs.realpathSync(base) + '.genes') } catch { /* ignore */ } return cands.find(c => { try { return fs.existsSync(c) } catch { return false } }) ?? null }
travRouter.get('/trav/gff', async (req, res) => {
  const q = req.query as Record<string, string>
  if (!q.db || !q.acc) { res.status(400).json({ error: 'db, acc が要ります' }); return }
  const gp = genesFileOf(q.db); if (!gp) { res.status(404).json({ error: 'この DB には遺伝子サイドカーがありません' }); return }
  const d = new Database(gp, { readonly: true })
  let closed = false; res.on('close', () => { closed = true })
  try {
    if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feature'").get()) { res.status(404).json({ error: 'この遺伝子サイドカーは GFF の行を持っていません（format 1）' }); return }
    // 株の名前は genes_build.py と同じ規則（# の前。# の無い GRCh38.chr1 は最初の . の前）。パス名をそのまま渡されても引けるように直す（11-03）
    let acc = q.acc; if (!d.prepare('SELECT 1 FROM feature WHERE acc = ? LIMIT 1').get(acc)) { const a2 = acc.includes('#') ? acc.split('#')[0] : acc.split('.')[0]; if (d.prepare('SELECT 1 FROM feature WHERE acc = ? LIMIT 1').get(a2)) acc = a2 }
    const hdr = (d.prepare('SELECT lineno, line FROM gff_header WHERE acc=? ORDER BY lineno').all(acc) as { lineno: number; line: string }[])
    if (!hdr.length && !d.prepare('SELECT 1 FROM feature WHERE acc = ? LIMIT 1').get(acc)) { res.status(404).json({ error: 'その株の GFF がありません: ' + q.acc }); return }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="' + acc.replace(/[^A-Za-z0-9._-]/g, '_') + '.gff"')
    // 11-03: 全ゲノムの GENCODE は 346 万行・1.6 GB（cold の読み出しに 90 秒）。行番号の順（索引 acc, lineno）に流し、4 MB ごとに書いて event loop に返す。
    //   同期のループで全部読んでから送ると、終わるまで 1 バイトも出ず、他の要求も止まり、5 分で接続が切れた
    const it = (d.prepare('SELECT lineno, seqid, source, type, start, end, score, strand, phase, attrs FROM feature WHERE acc=? ORDER BY lineno').iterate(acc) as IterableIterator<any>)
    let hi = 0, buf: string[] = [], size = 0
    const put = (line: string) => { buf.push(line, '\n'); size += line.length + 1 }
    for (;;) {
      const r = it.next()
      if (r.done) break
      const v = r.value; while (hi < hdr.length && hdr[hi].lineno < v.lineno) put(hdr[hi++].line)
      put([v.seqid, v.source, v.type, v.start, v.end, v.score, v.strand, v.phase, v.attrs].join('\t'))
      if (size > 4 << 20) {
        const ok = res.write(buf.join('')); buf = []; size = 0
        if (closed) { it.return?.(); return }
        await new Promise<void>(resolve => { if (ok) setImmediate(resolve); else { res.once('drain', () => resolve()); res.once('close', () => resolve()) } })
        if (closed) { it.return?.(); return }
      }
    }
    while (hi < hdr.length) put(hdr[hi++].line)
    if (buf.length) res.write(buf.join('')); res.end()
  } catch (err) { if (res.headersSent) res.end(); else res.status(500).json({ error: String(err) }) } finally { d.close() }
})

// 機能喪失の目安（5）: 遺伝子（写しを含む）ごとに CDS を株の配列から組み立てて翻訳し、参照と比べる。11-04 に常駐の python（gene_lof.py）から Traversals の worker（trav.ts travGeneLof）へ
travRouter.post('/trav/genelof', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>; const db = typeof b.db === 'string' ? b.db : ''; const gids = Array.isArray(b.gids) ? (b.gids as unknown[]).filter(x => Number.isInteger(x)).slice(0, 5000) : []
  if (!db || !gids.length) { res.status(400).json({ error: 'db と gids が要る' }); return }
  sendTrav(res, 'genelof', { db, gids })
})
