// 起動時に決まる配信モード。**複数の場所で env を読み直さない**ための 1 箇所。
//
// AMIPA_READONLY=1 … DB を書き換える経路（ノード編集の保存）を塞ぐ。
//   デモ配信のように「動かして繋がりを確かめるのは自由だが、DB は変えさせない」用途を想定する。
//   セッション（パーマリンク）は SESSION_DIR 配下のファイルなので通す。
//   ★遮断はサーバ側で行い、画面側は /api/version の `readonly` を見て Save を無効表示にする
//     （押してから 403 で断られるのではなく、押せないことが先に分かるように）。
export const READONLY =
  (process.env.AMIPA_READONLY ?? process.env.GGB_READONLY) === '1' ||
  (process.env.AMIPA_READONLY ?? process.env.GGB_READONLY) === 'true'
