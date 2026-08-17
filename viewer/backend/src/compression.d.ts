// `compression` の型宣言を自前で持つ理由:
//
// 公式の `@types/compression` は `@types/express: '*'` を要求するので **@types/express@5** を
// 入れ子で引き込む。このプロジェクトは express 4 なので、v5 の `RequestHandler` と v4 の
// `app.use()` オーバーロードが噛み合わず `TS2769: ... not assignable to PathParams` になる。
// yarn の resolutions で揃えようとしても入れ子の
// `@types/compression/node_modules/@types/express-serve-static-core@5` が残って解決しなかった。
//
// 必要な型は「オプションを取って RequestHandler を返す関数」1 個だけなので、
// **プロジェクト自身の express 型**を使ってここで宣言する。依存も 1 つ減る。
declare module 'compression' {
  import type { RequestHandler, Request, Response } from 'express'

  interface CompressionOptions {
    /** zlib の圧縮レベル 0-9。既定 -1(=6)。ggb は対話取得なので 1 を使う。 */
    level?: number
    /** これ未満のバイト数は圧縮しない。既定 1024。 */
    threshold?: number | string
    /** 圧縮するかを応答ごとに決める。既定は Content-Type が compressible なもの。 */
    filter?: (req: Request, res: Response) => boolean
    chunkSize?: number
    memLevel?: number
    strategy?: number
    windowBits?: number
  }

  function compression(options?: CompressionOptions): RequestHandler
  export = compression
}
