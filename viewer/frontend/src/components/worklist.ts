// 地点の一覧（11-16）: 内部の汎用形式と、各ファイル形式からの変換。設計 amipa-lab/plans/ui-redesign/trav-rows-worklist.md 3
//   1 地点 ＝ 1 レコード。一覧の運転役（travRender の List）はレコードの targets を順に go するだけで、形式ごとの処理を持たない。
//   座標はすべて 0 始まり・終端を含まない（BED と同じ）。手で書く「chr1:1,000-2,000」は表示の慣習どおり 1 始まり・両端を含むとして読む。

export type Target =
  | { kind: 'gene'; name: string }
  | { kind: 'ref'; ref?: string; chrom: string; start: number; end: number }   // ref＝株（sample または sample#hap）。省略は DB の参照
  | { kind: 'path'; path: string; start: number; end: number }
  | { kind: 'node'; names: string[] }
  | { kind: 'x'; x0: number; x1: number }                                      // 合意座標
export type Status = 'todo' | 'later' | 'skip' | 'done'
export interface WorkRecord { id: string; label: string; targets: Target[]; attrs?: Record<string, string>; groups?: Record<string, string[]>; status: Status; note: string }

const num = (s: string) => Number(s.replace(/[,_]/g, ''))

/** 1 行の文字列 → 地点。gene:X / node:a,b / x:100-200 / [株#]chr:a-b（1 始まり・両端を含む）/ それ以外は遺伝子名 */
export function parseTarget(text: string): Target | null {
  const s = text.trim(); if (!s) return null
  let m = /^x:([\d,_]+)(?:-([\d,_]+))?$/i.exec(s); if (m) { const a = num(m[1]), b = m[2] ? num(m[2]) : a; return { kind: 'x', x0: Math.min(a, b), x1: Math.max(a, b) } }
  m = /^node:(.+)$/i.exec(s); if (m) { const names = m[1].split(/[,\s]+/).filter(Boolean); return names.length ? { kind: 'node', names } : null }
  m = /^gene:(.+)$/i.exec(s); if (m) return { kind: 'gene', name: m[1].trim() }
  m = /^path:(.+):([\d,_]+)(?:-([\d,_]+))?$/i.exec(s); if (m) { const a = num(m[2]), b = m[3] ? num(m[3]) : a; return { kind: 'path', path: m[1], start: Math.min(a, b) - 1, end: Math.max(a, b) } }
  m = /^(?:(.+)#)?([^\s:#]+):([\d,_]+)(?:-([\d,_]+))?$/.exec(s)
  if (m) { const a = num(m[3]), b = m[4] ? num(m[4]) : a; if (!Number.isFinite(a) || !Number.isFinite(b)) return null; return { kind: 'ref', ...(m[1] ? { ref: m[1] } : {}), chrom: m[2], start: Math.min(a, b) - 1, end: Math.max(a, b) } }
  if (/^\S+$/.test(s)) return { kind: 'gene', name: s }
  return null
}
export function targetText(t: Target): string {
  switch (t.kind) {
    case 'gene': return t.name
    case 'ref': return `${t.ref ? t.ref + '#' : ''}${t.chrom}:${(t.start + 1).toLocaleString()}-${t.end.toLocaleString()}`
    case 'path': return `${t.path}:${(t.start + 1).toLocaleString()}-${t.end.toLocaleString()}`
    case 'node': return 'node:' + t.names.slice(0, 3).join(',') + (t.names.length > 3 ? '…' : '')
    case 'x': return `x:${t.x0}-${t.x1}`
  }
}

const rec = (i: number, label: string, targets: Target[], extra: Partial<WorkRecord> = {}): WorkRecord => ({ id: extra.id || String(i + 1), label, targets, status: 'todo', note: '', ...extra })

/** BED: chrom start end [name …]（0 始まり）。track・browser・# の行は飛ばす */
function fromBed(lines: string[]): WorkRecord[] {
  const out: WorkRecord[] = []
  for (const l of lines) { if (/^(#|track|browser)/.test(l)) continue; const f = l.split('\t'); if (f.length < 3) continue; const a = num(f[1]), b = num(f[2]); if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const t: Target = { kind: 'ref', chrom: f[0], start: a, end: Math.max(a + 1, b) }; out.push(rec(out.length, f[3] || targetText(t), [t])) }
  return out
}

/** VCF: 1 行 1 地点。END・SVLEN で長さ、BND は相手の端を 2 つ目の地点に。遺伝型から保有株・非保有株の群（相が分かれていれば sample#1・#2） */
function fromVcf(lines: string[]): WorkRecord[] {
  let samples: string[] = []; const out: WorkRecord[] = []
  for (const l of lines) {
    if (l.startsWith('##')) continue
    if (l.startsWith('#CHROM')) { samples = l.split('\t').slice(9); continue }
    const f = l.split('\t'); if (f.length < 8) continue
    const chrom = f[0], pos = num(f[1]); if (!Number.isFinite(pos)) continue
    const ref = f[3], alt = f[4], info = new Map(f[7].split(';').map(kv => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)] as [string, string] }))
    let end = pos - 1 + Math.max(1, ref.length)
    if (info.has('END')) end = Math.max(end, num(info.get('END')!))
    else if (info.has('SVLEN')) { const L = Math.abs(num(info.get('SVLEN')!.split(',')[0])); if (Number.isFinite(L) && (info.get('SVTYPE') || '') !== 'INS') end = Math.max(end, pos - 1 + L) }
    const targets: Target[] = [{ kind: 'ref', chrom, start: pos - 1, end }]
    const bnd = /[[\]]([^[\]:]+):(\d+)[[\]]/.exec(alt); if (bnd) targets.push({ kind: 'ref', chrom: bnd[1], start: num(bnd[2]) - 1, end: num(bnd[2]) })
    const id = f[2] && f[2] !== '.' ? f[2] : `${chrom}:${pos}`
    const svt = info.get('SVTYPE'); const label = `${id}${svt ? ' ' + svt : ''}${end - pos + 1 > 1 ? ` ${(end - pos + 1).toLocaleString()} bp` : ''}`
    let groups: Record<string, string[]> | undefined
    if (samples.length && f.length > 9) {
      const gi = f[8].split(':').indexOf('GT'); const car: string[] = [], non: string[] = []
      if (gi >= 0) samples.forEach((sm, k) => { const gt = (f[9 + k] || '').split(':')[gi] || ''; if (!gt || gt === '.') return
        const al = gt.split(/[|/]/); const phased = gt.includes('|')
        if (phased) al.forEach((a, h) => { if (a === '.') return; (a !== '0' ? car : non).push(`${sm}#${h + 1}`) })
        else if (al.every(a => a === '.')) return
        else (al.some(a => a !== '0' && a !== '.') ? car : non).push(sm) })
      if (car.length || non.length) groups = { carrier: car, 'non-carrier': non }
    }
    out.push(rec(out.length, label, targets, { id, ...(groups ? { groups } : {}), attrs: { ...(svt ? { SVTYPE: svt } : {}), ...(f[6] && f[6] !== '.' ? { FILTER: f[6] } : {}) } }))
  }
  return out
}

/** JSON Lines（内部形式そのもの）。targets は文字列でもよい（parseTarget で読む）。status・note はあれば引き継ぐ */
function fromJsonl(lines: string[]): WorkRecord[] {
  const out: WorkRecord[] = []
  for (const l of lines) { let o: any; try { o = JSON.parse(l) } catch { continue }
    const raw = Array.isArray(o.targets) ? o.targets : o.target != null ? [o.target] : []
    const targets = raw.map((t: any) => typeof t === 'string' ? parseTarget(t) : t && typeof t.kind === 'string' ? t as Target : null).filter((t: Target | null): t is Target => !!t)
    if (!targets.length) continue
    const st: Status = ['todo', 'later', 'skip', 'done'].includes(o.status) ? o.status : 'todo'
    out.push({ id: String(o.id ?? out.length + 1), label: String(o.label ?? targetText(targets[0])), targets, ...(o.attrs ? { attrs: o.attrs } : {}), ...(o.groups ? { groups: o.groups } : {}), status: st, note: String(o.note ?? '') }) }
  return out
}

/** 1 行 1 項目の文字列（遺伝子名・座標・node:…）。タブの後ろは名札 */
function fromLines(lines: string[]): WorkRecord[] {
  const out: WorkRecord[] = []
  for (const l of lines) { if (l.startsWith('#')) continue; const [head, ...rest] = l.split('\t'); const t = parseTarget(head); if (!t) continue; out.push(rec(out.length, rest.join(' ').trim() || head.trim(), [t])) }
  return out
}

/** ファイルの中身 → 地点の一覧。形式は名前と中身で決める（.vcf・#CHROM、.bed・3 列の数、{ で始まる行、それ以外は 1 行 1 項目） */
export function parseWorklist(text: string, name = ''): { format: string; records: WorkRecord[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim())
  const lower = name.toLowerCase()
  if (/\.vcf(\.gz)?$/.test(lower) || lines.some(l => l.startsWith('#CHROM'))) return { format: 'VCF', records: fromVcf(lines) }
  if (/\.jsonl?$/.test(lower) || (lines.length && lines.every(l => l.trim().startsWith('{')))) return { format: 'JSON Lines', records: fromJsonl(lines) }
  const data = lines.filter(l => !/^(#|track|browser)/.test(l))
  if (/\.bed(\.txt)?$/.test(lower) || (data.length && data.every(l => { const f = l.split('\t'); return f.length >= 3 && /^\d+$/.test(f[1]) && /^\d+$/.test(f[2]) }))) return { format: 'BED', records: fromBed(lines) }
  return { format: 'lines', records: fromLines(lines) }
}
export function toJsonl(records: WorkRecord[]): string { return records.map(r => JSON.stringify(r)).join('\n') + '\n' }
