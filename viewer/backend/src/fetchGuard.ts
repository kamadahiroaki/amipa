// ビューポート取得の安全弁。
//
// ── 2026-08-04 に役割が変わった ─────────────────────────────────────────────
// 元々ここの時間ガード(FETCH_MS)は「better-sqlite3 は同期なので、遅いクエリがイベントループを
// 塞いでサーバ全体を無反応にする」ことへの対処で、**対話的な上限**として 15 秒に置いていた。
// その前提は DB 読み取りを worker_threads へ出したことで消えた:
//   ・メインのイベントループは空いたままなので、重いクエリ中も他のリクエストが普通に通る
//   ・クライアントが去れば **走行中のクエリを中断できる**（SharedArrayBuffer のキャンセル旗を
//     iterate ループが 16 行ごとに見る。workerPool.ts / dbWorker.ts）
//   ・「SQL 側で集めてから返す」形は中断できないので、集計もバッチ化も JS 側へ移した
//     (nodes_grid の GROUP BY / edges の可視ノード IN サブクエリ)
// つまり「ユーザーが待っているなら待たせ、待つのをやめたら止める」が実現したので、
// **時間で強制的に切る必要はなくなった**。
//
// ── いまの役割分担 ──────────────────────────────────────────────────────────
//   キャンセル旗   : 本命。ユーザーが去ったら止める（＝無駄な仕事をしない唯一の正しい基準）
//   maxRows        : client が申告する UX 上限。「これ以上は描いても読めない」
//   HARD_ROW_CAP   : **メモリ保護**の絶対上限。client が maxRows を送らない/巨大な値を送っても
//                    ここで頭打ちにする。worker が行を配列に積んで JSON 化するので、
//                    無制限だと WG(最深層 1.1 億ノード)で worker が落ちる。
//   FETCH_MS       : 破滅回避の**最終防波堤**だけ。対話的な上限ではないので長い（既定 5 分）。
//   worker 強制終了 : キャンセル旗で止まらない区間（SQL 内部で回っている最中など）用の最後の手段。
//                    workerPool.ts の TERMINATE_GRACE_MS。
//
// ── 使えなくならないための約束（従来どおり）─────────────────────────────────
//   1. 最浅層(layer 0)は時間ガードの対象外 → **必ず何かを返す**（chr22 L0=737 行 / WG L0=679 行）。
//   2. 時間 abort は永続化しない。毎回再評価し、部分読みで温まった分だけ次回は深くなる。
//   3. 打ち切ったことは必ずヘッダで通知する（黙って部分データを返さない）。

import type { Database, Statement } from 'better-sqlite3'
import type { Response } from 'express'

/**
 * 1 リクエストの時間上限（ms）。**破滅回避の最終防波堤だけ**で、対話的な上限ではない。
 *
 * 旧値は 15 秒だったが、それは「同期実行でサーバが固まる」前提の値だった。worker 化と
 * 走行中キャンセルが入った今、ユーザーが待っている限り待たせてよい（去れば止まる）ので
 * **5 分**まで緩める。ここに引っかかるのは「病的に遅い 1 行コスト」だけであるべき。
 * 実測の目安: WG 273GB の重い矩形で /edges cold 44 秒、/nodes cold 15-40 秒。
 * env AMIPA_FETCH_MS で上書き。
 */
export const FETCH_MS = (() => {
  const v = Number((process.env.AMIPA_FETCH_MS ?? process.env.GGB_FETCH_MS))
  return Number.isFinite(v) && v > 0 ? v : 300_000
})()

/**
 * 行数の絶対上限（**メモリ保護**）。client の maxRows がこれを超える/未指定でもここで切る。
 *
 * なぜ必要か: frontend の maxRows は既定 0=無制限（App.tsx）。従来はそれでも時間ガード 15 秒が
 * 実質的な天井になっていたが、その時間ガードを 5 分に緩めた今、**無制限のままだと worker が
 * 行を積んで落ちる**。WG の最深層は 110,884,673 ノードあるので現実的な危険。
 * 1 行あたり JSON で約 320B・JS オブジェクトでその 2-3 倍なので、100 万行で数百 MB。
 * env AMIPA_MAX_ROWS で上書き。
 */
export const HARD_ROW_CAP = (() => {
  const v = Number((process.env.AMIPA_MAX_ROWS ?? process.env.GGB_MAX_ROWS))
  return Number.isFinite(v) && v > 0 ? v : 1_000_000
})()

/** client 申告の maxRows に絶対上限を掛ける。0/未指定なら上限そのもの。 */
export function effectiveMaxRows(clientMaxRows: number): number {
  const m = clientMaxRows > 0 ? clientMaxRows : HARD_ROW_CAP
  return Math.min(m, HARD_ROW_CAP)
}
/** プローブ（打ち切りカウント）が走査する上限行数。maxRows が巨大でもここで頭打ちにする。 */
export const PROBE_CAP = (() => {
  const v = Number((process.env.AMIPA_PROBE_CAP ?? process.env.GGB_PROBE_CAP))
  return Number.isFinite(v) && v > 0 ? v : 100_000
})()
/**
 * 時間チェックの間隔（行）。**2 の冪であること**（下のビットマスク判定）。
 *
 * 旧値 1024 では守れていなかった。chr22 最密領域の `/edges` は 1 行あたり 16〜76ms かかることが
 * あり（2026-08-03 実測: 1024 行返すのに 16.3s / 77.9s、いずれも `X-AMIPA-Truncated: time`）、
 * 「1024 行ごとにしか時計を見ない」と **予算 15s に対して 60s 以上オーバーシュートする**。
 * 打ち切りが効いているのに backend が 78 秒同期ブロックしていた。
 *
 * 16 にすると最悪オーバーシュートが 1/64（0.26〜1.2s）に縮む。コストは `Date.now()` が 43ns
 * （実測）なので 16 行ごとで **2.7ns/行** ＝ iterate 自体の ~1us/行 に対し 0.27%。無視できる。
 */
const TIME_CHECK_EVERY = (() => {
  const v = Number((process.env.AMIPA_TIME_CHECK_EVERY ?? process.env.GGB_TIME_CHECK_EVERY))
  return Number.isFinite(v) && v > 0 && (v & (v - 1)) === 0 ? v : 16
})()

export interface GuardResult<T> {
  rows: T[]
  /** 行数上限 / 時間予算 / クライアント切断 で打ち切ったか */
  truncated: boolean
  reason: 'ok' | 'rows' | 'time' | 'cancel'
  ms: number
}

/**
 * `stmt.all()` の代わりに使う。`iterate()` で 1 行ずつ受けながら
 *   ・maxRows を超えたら打ち切る（UX 上限。未指定なら無制限）
 *   ・timeMs を超えたら打ち切る（同期ブロック回避。exemptTime=true で免除＝最浅層用）
 * @param maxRows 0/undefined で行数無制限
 */
export function guardedAll<T = any>(
  stmt: Statement, params: any[],
  opts: { maxRows?: number; timeMs?: number; exemptTime?: boolean;
          /** true を返したら即中断。DB worker が SharedArrayBuffer のキャンセル旗を渡す。 */
          cancelled?: () => boolean
          /** 進捗報告。キャンセル判定と同じ刻み(TIME_CHECK_EVERY 行ごと)で呼ばれる。 */
          onProgress?: (rows: number) => void } = {},
): GuardResult<T> {
  const maxRows = effectiveMaxRows(opts.maxRows ?? 0)   // 無制限は許さない（メモリ保護）
  const timeMs = opts.exemptTime ? Infinity : (opts.timeMs ?? FETCH_MS)
  const cancelled = opts.cancelled
  const onProgress = opts.onProgress
  const t0 = Date.now()
  const hr = process.hrtime.bigint()
  const rows: T[] = []
  let reason: GuardResult<T>['reason'] = 'ok'
  // 上限が全て無い場合だけ all() の速い経路（現状 maxRows は必ず有限なので通常は通らない）。
  if (maxRows === Infinity && timeMs === Infinity && !cancelled) {
    return { rows: stmt.all(...params) as T[], truncated: false, reason: 'ok',
             ms: Number(process.hrtime.bigint() - hr) / 1e6 }
  }
  let n = 0
  for (const r of stmt.iterate(...params) as Iterable<T>) {
    if (n >= maxRows) { reason = 'rows'; break }
    rows.push(r)
    if ((++n & (TIME_CHECK_EVERY - 1)) === 0) {
      // 時間切れ / クライアント消失 のどちらでも止める。cancel は worker 経由でのみ渡る
      // （メインスレッド実行時は同期でイベントループが止まるので旗が更新されない＝意味がない）。
      if (onProgress) onProgress(n)
      if (Date.now() - t0 > timeMs) { reason = 'time'; break }
      if (cancelled && cancelled()) { reason = 'cancel'; break }
    }
  }
  return { rows, truncated: reason !== 'ok', reason,
           ms: Number(process.hrtime.bigint() - hr) / 1e6 }
}

/**
 * `guardedAll` の畳み込み版。行を配列に貯めずに reducer へ渡す。
 *
 * 用途は 2 つ:
 *  ・**メモリ**: 集計結果だけ要るのに 7.6 万行を配列に持つ必要はない。
 *  ・**中断可能性（本命）**: SQL 側で `GROUP BY` すると EQP が `USE TEMP B-TREE FOR GROUP BY` になり、
 *    **1 行目が出る前に全集計が終わる**。`iterate()` が最初の step で丸ごとブロックするので、
 *    行ごとの時間チェックもキャンセル旗も**一度も評価されない**。実測: /nodes_grid の重い矩形は
 *    51.5 秒かかったのに FETCH_MS=15s で打ち切られていなかった（＝時間ガードも効いていなかった）。
 *    集計を JS 側でやれば行がそのまま流れてくるので、両方のガードが本来どおり効く。
 */
export function guardedFold(
  stmt: Statement, params: any[],
  onRow: (row: any) => void,
  opts: { maxRows?: number; timeMs?: number; exemptTime?: boolean; cancelled?: () => boolean;
          onProgress?: (rows: number) => void } = {},
): { rows: number; truncated: boolean; reason: GuardResult<any>['reason']; ms: number } {
  const maxRows = effectiveMaxRows(opts.maxRows ?? 0)   // 無制限は許さない（メモリ保護）
  const timeMs = opts.exemptTime ? Infinity : (opts.timeMs ?? FETCH_MS)
  const cancelled = opts.cancelled
  const t0 = Date.now()
  const hr = process.hrtime.bigint()
  let reason: GuardResult<any>['reason'] = 'ok'
  let n = 0
  for (const r of stmt.iterate(...params) as Iterable<any>) {
    if (n >= maxRows) { reason = 'rows'; break }
    onRow(r)
    if ((++n & (TIME_CHECK_EVERY - 1)) === 0) {
      if (opts.onProgress) opts.onProgress(n)
      if (Date.now() - t0 > timeMs) { reason = 'time'; break }
      if (cancelled && cancelled()) { reason = 'cancel'; break }
    }
  }
  return { rows: n, truncated: reason !== 'ok', reason,
           ms: Number(process.hrtime.bigint() - hr) / 1e6 }
}

/** 打ち切り結果をレスポンスヘッダで通知する（本文の形は変えない＝既存 frontend は無改修で動く）。 */
export function setGuardHeaders(res: Response, g: GuardResult<any>, layer?: number,
                                what = 'fetch'): void {
  res.setHeader('X-AMIPA-Rows', String(g.rows.length))
  res.setHeader('X-AMIPA-Ms', g.ms.toFixed(1))
  if (layer != null) res.setHeader('X-AMIPA-Layer', String(layer))
  if (g.truncated) {
    res.setHeader('X-AMIPA-Truncated', g.reason)
    // frontend が未対応のうちは黙って部分データが返る形になるので、サーバ側に必ず痕跡を残す。
    // reason='time' が出るのは異常（既定 15s を超えた）＝調査対象。
    const lv = g.reason === 'time' ? console.warn : console.log
    lv(`[guard] ${what} truncated by ${g.reason}: layer=${layer} rows=${g.rows.length} ` +
       `${g.ms.toFixed(0)}ms`)
  }
}

/**
 * 打ち切りカウント。`LIMIT` が R-Tree 走査に押し込まれて**早期終了する**ので、
 * 密度に依らずコストが cap 行ぶんで一定になる（実測: 全域 3,317,200 件でも warm 0.24ms）。
 * 仕事量が cap で有界なので単発 statement でも暴走しない（＝ここに時間ガードは不要）。
 *
 * @param rtree 'nodes_rtree' か 'ix.nodes_rtree_hm'（hap 絞り込み時）
 * @param mask  絞り込みの WHERE 断片（`maskWhere` の sql）。マスク条件があると LIMIT は
 *              「該当行」しか止めないので O(候補) になる点に注意。
 */
export function cappedCount(
  d: Database, rtree: string, layer: number,
  rect: { x1: number; x2: number; y1: number; y2: number },
  cap: number, mask = '', maskParams: any[] = [],
): number {
  const sql =
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${rtree} r
      WHERE r.min_layer = ? AND r.max_layer = ?
        AND r.max_x >= ? AND r.min_x <= ? AND r.max_y >= ? AND r.min_y <= ?${mask}
      LIMIT ?)`
  const row = d.prepare(sql).get(
    layer, layer, rect.x1, rect.x2, rect.y1, rect.y2, ...maskParams, cap) as { n: number }
  return row?.n ?? 0
}

/** プローブが実際に走査する cap。maxRows が巨大でも PROBE_CAP で頭打ち。 */
export function probeCapFor(maxRows: number): number {
  return Math.min(maxRows, PROBE_CAP) + 1
}
