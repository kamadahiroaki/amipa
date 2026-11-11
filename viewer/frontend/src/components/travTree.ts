// Linear パネルの表示範囲の木（11-11）。距離関数 dist(i, j) だけを受け取り、株数で計算の方法を切り替える。
//   n ≤ FULL_MAX（2,000）: 全対の距離 → UPGMA（最近隣連鎖法。O(n²) 時間・O(n²) メモリ。以前の素朴な実装は O(n³) で 1,000 株 2.9 秒）
//   n >  FULL_MAX: 二段（10-15 の Blocks の方式を移植）。最遠点抽出で √n 個の目印 → 各株を最も近い目印の群へ（n√n 回の距離）
//                  → 群の中は全対で UPGMA → 群どうしは群の中心（距離の和が最小の株）の距離で UPGMA → 継ぐ。遠い株どうしの厳密な比較を省く
//   木の高さ h は併合の距離そのもの（半分にしない。描画と treeCut がこれを前提にしている）
export type Clade = { leaves: number[]; size: number; h: number; kids: Clade[]; rep?: number; collapsed?: boolean }
export type TreeHow = 'exact' | 'two-level'

const urlNum = (k: string): number | null => { try { const v = new URLSearchParams(location.search).get(k); return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null } catch { return null } }
// ?treefull=N は検証用（二段を少ない株で試す）。利用者の設定ではない
export const FULL_MAX = urlNum('treefull') ?? 2000

// 全対の距離行列（n×n、対称）から UPGMA。葉は 0..n-1
export function upgmaNN(n: number, D: Float64Array): Clade {
  const cl: (Clade | null)[] = Array.from({ length: n }, (_, i) => ({ leaves: [i], size: 1, h: 0, kids: [] }))
  if (n === 1) return cl[0]!
  const alive = new Uint8Array(n).fill(1); const stack: number[] = []; const onStack = new Int32Array(n).fill(-1); let remaining = n
  while (remaining > 1) {
    if (!stack.length) { for (let i = 0; i < n; i++) if (alive[i]) { stack.push(i); onStack[i] = 0; break } }
    for (;;) {
      const a = stack[stack.length - 1]; const prev = stack.length > 1 ? stack[stack.length - 2] : -1
      let b = -1, bd = Infinity; const ra = a * n
      for (let j = 0; j < n; j++) { if (!alive[j] || j === a) continue; const d = D[ra + j]; if (d < bd || (d === bd && j === prev)) { bd = d; b = j } }   // 同点は直前の株を優先（連鎖が回らないように）
      if (b === prev) {   // 互いに最近隣 → 併合
        stack.pop(); stack.pop(); onStack[a] = -1; onStack[b] = -1
        const A = cl[a]!, B = cl[b]!; const sa = A.size, sb = B.size
        for (let m = 0; m < n; m++) { if (!alive[m] || m === a || m === b) continue; const d = (sa * D[ra + m] + sb * D[b * n + m]) / (sa + sb); D[ra + m] = d; D[m * n + a] = d }
        cl[a] = { leaves: A.leaves.concat(B.leaves), size: sa + sb, h: Math.max(bd, A.h, B.h), kids: [A, B] }; cl[b] = null; alive[b] = 0; remaining--
        break
      }
      onStack[b] = stack.length; stack.push(b)
    }
  }
  for (let i = 0; i < n; i++) if (alive[i]) return cl[i]!
  return cl[0]!
}

function fullTree(n: number, dist: (i: number, j: number) => number): Clade {
  const D = new Float64Array(n * n)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = dist(i, j); D[i * n + j] = d; D[j * n + i] = d }
  return upgmaNN(n, D)
}
const relabel = (c: Clade, map: (i: number) => number): Clade => ({ leaves: c.leaves.map(map), size: c.size, h: c.h, kids: c.kids.map(k => relabel(k, map)) })

export function twoLevelTree(n: number, dist: (i: number, j: number) => number): Clade {
  const k = Math.max(2, Math.min(n, Math.ceil(Math.sqrt(n)))); const lm = [0]; const minD = new Float64Array(n).fill(Infinity); const near = new Int32Array(n)
  for (let t = 0; t < k; t++) {
    const c = lm[t]; for (let i = 0; i < n; i++) { const d = i === c ? 0 : dist(i, c); if (d < minD[i]) { minD[i] = d; near[i] = t } }
    if (t + 1 < k) { let bi = -1, bd = -1; for (let i = 0; i < n; i++) if (minD[i] > bd) { bd = minD[i]; bi = i } if (bd <= 0) break; lm.push(bi) }
  }
  const cells: number[][] = Array.from({ length: lm.length }, () => []); for (let i = 0; i < n; i++) cells[near[i]].push(i)
  const subs: Clade[] = [], meds: number[] = []
  for (const m of cells) {
    if (!m.length) continue
    const mm = m.length; const D = new Float64Array(mm * mm); const sum = new Float64Array(mm)
    for (let i = 0; i < mm; i++) for (let j = i + 1; j < mm; j++) { const d = dist(m[i], m[j]); D[i * mm + j] = d; D[j * mm + i] = d; sum[i] += d; sum[j] += d }
    let med = 0; for (let i = 1; i < mm; i++) if (sum[i] < sum[med]) med = i
    meds.push(m[med]); subs.push(relabel(upgmaNN(mm, D), i => m[i]))
  }
  if (subs.length === 1) return subs[0]
  const top = fullTree(meds.length, (i, j) => dist(meds[i], meds[j]))
  const graft = (c: Clade): Clade => {
    if (!c.kids.length) return subs[c.leaves[0]]
    const kids = c.kids.map(graft)
    return { leaves: kids[0].leaves.concat(kids[1].leaves), size: kids[0].size + kids[1].size, h: Math.max(c.h, kids[0].h, kids[1].h), kids }
  }
  return graft(top)
}

export function buildTree(n: number, dist: (i: number, j: number) => number, force?: TreeHow): { root: Clade; how: TreeHow } {
  const how: TreeHow = force ?? (n <= FULL_MAX ? 'exact' : 'two-level')
  return { root: how === 'exact' ? fullTree(n, dist) : twoLevelTree(n, dist), how }
}

// 群の中心（距離の和が最小の株）。大きな群は標本で近似（候補 64 × 比較相手 256）
export function medoid(pool: number[], members: number[], dist: (a: number, b: number) => number): number {
  const samp = (a: number[], m: number) => a.length <= m ? a : Array.from({ length: m }, (_, i) => a[Math.floor(i * a.length / m)])
  const cand = samp(pool, 64), against = samp(members, 256); let rep = cand[0], best = Infinity
  for (const a of cand) { let s = 0; for (const b of against) if (a !== b) s += dist(a, b); if (s < best) { best = s; rep = a } }
  return rep
}

// ---- 比較用（検証のみ。window.__amipaTreeCmp から） ----
// 共表型距離（2 葉の最も近い共通祖先の高さ）。葉は 0..n-1
export function cophenetic(root: Clade, n: number): Float64Array {
  const C = new Float64Array(n * n)
  const walk = (c: Clade) => { if (!c.kids.length) return; const [A, B] = c.kids; for (const a of A.leaves) for (const b of B.leaves) { C[a * n + b] = c.h; C[b * n + a] = c.h } walk(A); walk(B) }
  walk(root); return C
}
const pearson = (x: ArrayLike<number>, y: ArrayLike<number>) => { const m = x.length; let sx = 0, sy = 0; for (let i = 0; i < m; i++) { sx += x[i]; sy += y[i] } const mx = sx / m, my = sy / m; let a = 0, b = 0, c = 0; for (let i = 0; i < m; i++) { const dx = x[i] - mx, dy = y[i] - my; a += dx * dy; b += dx * dx; c += dy * dy } return b && c ? a / Math.sqrt(b * c) : 1 }
const upper = (M: Float64Array, n: number) => { const o: number[] = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) o.push(M[i * n + j]); return o }
// 根の高さに対する割合 f で木を切ったときの群（葉 → 群番号）
function cutLabels(root: Clade, n: number, f: number): Int32Array { const L = new Int32Array(n); let g = 0; const t = f * Math.max(1e-12, root.h); const walk = (c: Clade) => { if (!c.kids.length || c.h <= t) { for (const l of c.leaves) L[l] = g; g++ } else c.kids.forEach(walk) }; walk(root); return L }
function ari(a: Int32Array, b: Int32Array): number {
  const n = a.length; const key = new Map<string, number>(), ca = new Map<number, number>(), cb = new Map<number, number>()
  for (let i = 0; i < n; i++) { const k = a[i] + ',' + b[i]; key.set(k, (key.get(k) || 0) + 1); ca.set(a[i], (ca.get(a[i]) || 0) + 1); cb.set(b[i], (cb.get(b[i]) || 0) + 1) }
  const c2 = (x: number) => x * (x - 1) / 2; let sij = 0, sa = 0, sb = 0; for (const v of key.values()) sij += c2(v); for (const v of ca.values()) sa += c2(v); for (const v of cb.values()) sb += c2(v)
  const exp = sa * sb / c2(n), mx = (sa + sb) / 2; return mx === exp ? 1 : (sij - exp) / (mx - exp)
}
const splits = (root: Clade, n: number) => { const s = new Set<string>(); const walk = (c: Clade) => { if (c.kids.length && c.size > 1 && c.size < n - 1) { const m = new Uint8Array(n); for (const l of c.leaves) m[l] = 1; if (m[0]) for (let i = 0; i < n; i++) m[i] ^= 1; s.add(m.join('')) } c.kids.forEach(walk) }; walk(root); return s }
export function compareTrees(n: number, dist: (i: number, j: number) => number) {
  const T0 = performance.now(); const A = buildTree(n, dist, 'exact').root; const T1 = performance.now(); const B = buildTree(n, dist, 'two-level').root; const T2 = performance.now()
  const D = new Float64Array(n * n); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = dist(i, j); D[i * n + j] = d; D[j * n + i] = d }
  const d = upper(D, n), ca = upper(cophenetic(A, n), n), cb = upper(cophenetic(B, n), n)
  const sA = splits(A, n), sB = splits(B, n); let shared = 0; for (const s of sA) if (sB.has(s)) shared++
  const cuts: Record<string, { ari: number; gExact: number; gTwo: number }> = {}
  for (const f of [0.05, 0.1, 0.2, 0.3, 0.5]) { const la = cutLabels(A, n, f), lb = cutLabels(B, n, f); cuts[String(f)] = { ari: +ari(la, lb).toFixed(3), gExact: Math.max(...la) + 1, gTwo: Math.max(...lb) + 1 } }
  return { n, landmarks: Math.ceil(Math.sqrt(n)), msExact: +(T1 - T0).toFixed(1), msTwo: +(T2 - T1).toFixed(1),
    copheneticExact: +pearson(d, ca).toFixed(4), copheneticTwo: +pearson(d, cb).toFixed(4), copheneticBetween: +pearson(ca, cb).toFixed(4),
    rfShared: +(shared / Math.max(1, sA.size)).toFixed(3), rootH: [+A.h.toFixed(4), +B.h.toFixed(4)], cuts }
}
