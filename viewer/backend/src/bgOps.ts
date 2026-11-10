// bgWorker で走らせる処理の一覧（11-10）。どれも Express のハンドラをそのまま呼び、res.status/json を受け取る偽の res で結果を拾う
import { ribbonHandler, cnvHandler } from './routes/paths'
import { routeHandler } from './routes/route'

export interface BgResult { status: number; json: any }

export function runBgOp(op: string, q: Record<string, any>): BgResult {
  const OPS: Record<string, (req: { query: any }, res: any) => void> = { ribbon: ribbonHandler, cnv: cnvHandler, route: routeHandler }   // 呼ぶときに引く（paths.ts と循環 import なので、読み込み時には未定義のことがある）
  const f = OPS[op]; if (!f) return { status: 404, json: { error: 'unknown op ' + op } }
  const out: BgResult = { status: 200, json: null }
  const res = { status(c: number) { out.status = c; return res }, json(j: any) { out.json = j; return res }, type() { return res }, send(b: any) { out.json = typeof b === 'string' ? JSON.parse(b) : b; return res } }
  try { f({ query: q }, res) } catch (e) { return { status: 500, json: { error: String(e) } } }
  return out
}
