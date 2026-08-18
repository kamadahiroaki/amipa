import express from 'express'
import cors from 'cors'
import compression from 'compression'
import path from 'path'
import { READONLY } from './config'
import { graphRouter } from './routes/graph'
import { statsRouter } from './routes/stats'
import { databasesRouter } from './routes/databases'
import { pathsRouter } from './routes/paths'
import { sessionRouter } from './routes/session'
import { bubbleMsaRouter } from './routes/bubbleMsa'
import { exportRouter } from './routes/exportData'
import { renderRouter } from './routes/render'
import { initWorkerPool } from './workerPool'
import { prewarmAtStartup } from './prewarm'
import { getDbDir } from './db'

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors())

// 応答を gzip する。API 本文は座標・数値の JSON で冗長度が高く、実測(2026-08-05)で
//   /nodes 77,150 行   24.78 MB → 4.47 MB (5.5x, level 1) / 3.85 MB (6.4x, level 6)
//   /nodes 13,462 行    4.29 MB → 0.46 MB (9.3x)
//   /edges 22,842 本    2.47 MB → 0.23 MB (10.6x)
//   /nodes_grid         0.42 MB → 0.08 MB (4.9x)
// 圧縮率は level 1 と 6 で 5.5x vs 6.4x しか違わないのに CPU は 130ms vs 398ms(24.78MB 実測)。
// 対話的な取得なので **level 1 を既定**にする（AMIPA_GZIP_LEVEL で上書き可、0 で無効）。
//
// ⚠ ここ(メインスレッド)で圧縮されるのは軽い endpoint だけ。`/nodes` `/edges` `/nodes_grid` は
//   **worker 側で圧縮済み**で Content-Encoding が既に立っているので compression は素通しする
//   ('already encoded' 判定)。重い本文の deflate をメインのイベントループに持ち込まないため。
//   → dbWorker.ts / workerPool.ts の gzip 参照。
const GZIP_LEVEL = (() => {
  const v = Number((process.env.AMIPA_GZIP_LEVEL ?? process.env.GGB_GZIP_LEVEL))
  return Number.isFinite(v) && v >= 0 && v <= 9 ? Math.floor(v) : 1
})()
if (GZIP_LEVEL > 0) app.use(compression({ level: GZIP_LEVEL, threshold: 1024 }))

app.use(express.json({ limit: '1mb' }))   // スナップショット保存用に上限を引き上げ
// API レスポンスは全て動的（DB内容依存）で、frontend が独自にタイルキャッシュする。
// ブラウザの HTTP キャッシュを無効化して、編集のDB反映後に古い応答が返らないようにする。
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

// 放棄されたリクエストを、DB に触る前に捨てる。
//
// better-sqlite3 は同期 API なので **始まってしまったクエリは中断できない**。イベントループごと
// 止まるため切断イベントを受け取ることすら原理的にできず、リクエストは厳密に直列処理される。
// 実測(WG 273GB, 重い矩形 ~10s): 重いリクエストを 2 秒でクライアント切断しても、直後の
// `/api/databases`(単体 0.002s) が **7.81s** 待たされた。パン 3 回相当（3 本放棄）で **27.9s**。
// ＝放棄した分がそのまま残り本数に比例して積み上がる（ユーザ自身の次の操作も後ろで待たされる）。
//
// 一方 **キューで順番待ちしている間はイベントループが回る**ので、その間の切断は届いている。
// ここでハンドラ入口に見張りを置けば、順番が回ってきた時点で既に見捨てられているものを
// DB に触る前に落とせる。実行中の 1 本は止められないが、積み上がりは止まる。
//
// ⚠ 対象は **GET のみ**。編集の DB 反映(POST /api/save_edits)とセッション保存(POST /api/session)は
//   途中で捨ててはいけないので必ず通す。現状 DB へ書くのはこの 2 つだけで、どちらも POST
//   (getWritableDb を使うのは routes/paths.ts の save_edits のみ)。この不変条件が崩れると
//   書き込みが握り潰されるので、**書き込み系のエンドポイントを GET で足さないこと**。
// ★ハンドラ入口で見ても切断は分からない（実測）。1 tick 遅らせる必要がある。
//   キュー待ちのまま放棄されたリクエストのハンドラ入口では、
//     req.destroyed / req.aborted / socket.destroyed / res.closed が **全部 false**
//   で、生きているリクエストと見分けが付かない。イベントループが再開したとき、poll フェーズで
//   ソケットを読んで 'request' を発火 → 同期ハンドラが走る、の順なので FIN はまだ処理されていない。
//   `setImmediate`(check フェーズ)でも早すぎる。close コールバックフェーズの**後**に来る
//   **次の timers フェーズ**＝`setTimeout(…, 0)` まで待つと destroyed が立つ（実測で確認）。
//
// ただし全 GET に 1 tick 挟むと平常時のレイテンシに響くので、**直前のリクエストが実際に
// イベントループを長時間止めていた時だけ**遅延させる（＝積み上がりが起きている状況だけ）。
//
// ⚠ 「ループ遅延(lag)を setInterval で測る」方式は**動かない**（実測）。ブロックが解けた直後は
//   イベントループの順序が timers → poll なので、キュー待ちリクエストを読む poll フェーズより
//   先に interval が発火して lag が 0 に戻ってしまい、後続が素通りする。
//   代わりに **next() の同期実行時間を直接測る**（better-sqlite3 は同期なのでこれがブロック時間そのもの）。
const ABORT_DEBUG = !!(process.env.AMIPA_ABORT_DEBUG ?? process.env.GGB_ABORT_DEBUG)   // 判定の内訳を出す（切り分け用）
const BLOCKED_MS = 200      // この時間以上ブロックしたら「積み上がりが起きうる」とみなす
const DEFER_GRACE_MS = 1000 // 一度検知したらこの間は遅延チェックを続ける（同じ波の後続を拾う）
let deferUntil = 0
let skippedAborted = 0

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') return next()          // 書き込みは決して捨てない
  const runTimed = () => {
    const t0 = Date.now()
    next()
    const dt = Date.now() - t0                     // 同期ハンドラならこれが実ブロック時間
    if (dt > BLOCKED_MS) deferUntil = Date.now() + DEFER_GRACE_MS
  }
  if (Date.now() >= deferUntil) {
    if (ABORT_DEBUG) console.log(`[abort:dbg] pass ${req.path}`)
    return runTimed()                              // 平常時: 遅延ゼロでそのまま通す
  }

  // 1 回の setTimeout(0) では取りこぼす。同じ波で放棄された複数のリクエストのうち、
  // FIN が同じ close コールバックフェーズに間に合わなかったものは gone=false に見える
  // （実測: 3 本放棄で 1 本しか検知できなかった）。数 ms 空けて数回だけ見直す。
  // 待つのは**既に輻輳している時だけ**で、最悪 28ms。15 秒級のクエリ 1 本と比べれば無視できる。
  const RECHECK_MS = [0, 8, 20]
  let attempt = 0
  const check = () => {
    const gone = req.destroyed || res.closed || req.socket?.destroyed
    if (ABORT_DEBUG) {
      console.log(`[abort:dbg] defer#${attempt} ${req.path} gone=${gone} ` +
                  `(reqD=${req.destroyed} resC=${res.closed} sockD=${req.socket?.destroyed})`)
    }
    if (!gone) {
      if (++attempt < RECHECK_MS.length) return setTimeout(check, RECHECK_MS[attempt])
      return runTimed()                            // 生きている: 通常どおり処理
    }
    skippedAborted++
    if (ABORT_DEBUG || skippedAborted % 20 === 1) {
      console.log(`[abort] skipped ${skippedAborted} abandoned GET(s); ` +
                  `latest ${req.originalUrl.slice(0, 120)}`)
    }
    try { res.end() } catch { /* 相手はもういない */ }
    // next() を呼ばない = DB を触らない
  }
  setTimeout(check, RECHECK_MS[0])
})

// 読み取り専用モード（公開インスタンス用）。詳細は config.ts。
//   ・遮断: POST /api/save_edits（ノード編集の DB 反映）
//   ・通す: POST /api/session（パーマリンク用のスナップショット。SESSION_DIR 配下のファイルのみ）
// 公開時は DB を ro マウントすれば二重の守りになる（better-sqlite3 は readonly 接続だが
// save_edits だけ writable 接続を開くため、アプリ側でも塞いでおく）。
if (READONLY) {
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && /^\/save_edits\b/.test(req.path)) {
      res.status(403).json({ error: 'read-only instance (AMIPA_READONLY=1)' })
      return
    }
    next()
  })
}

// 死活監視（コンテナの HEALTHCHECK / ロードバランサ用）。DB には触らない＝重いクエリで詰まっていても返る。
app.get('/healthz', (_req, res) => { res.type('text/plain').send('ok') })

app.use('/api', graphRouter)
app.use('/api', statsRouter)
app.use('/api', databasesRouter)
app.use('/api', pathsRouter)
app.use('/api', sessionRouter)
app.use('/api', bubbleMsaRouter)
app.use('/api', exportRouter)
app.use('/api', renderRouter)

// Serve built frontend in production
const frontendDist = path.join(__dirname, '../../frontend/dist')
app.use(express.static(frontendDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'))
})

// DB 読み取り worker プールを先に立ち上げる（失敗してもメイン実行へフォールバックするので致命的でない）。
initWorkerPool()

app.listen(PORT, () => {
  console.log(`Backend: http://localhost:${PORT}`)
  // 起動時プリウォーム（AMIPA_PREWARM に DB 名をカンマ区切り）。この時点では利用者がいないので
  // 絞らずフル速度で読む。DB 切り替え時の自動プリウォームは /stats 側で開始し進捗を返す。
  prewarmAtStartup()
})
