import path from 'path'

// backend が子プロセスで呼ぶ Python ヘルパの在り処を 1 か所に集める。
//
// ★ここに絶対パス(`/home/kamada/miniconda3/...` 等)を埋めない。埋めると
//   コンテナ・他人のマシン・CI のどれでも動かなくなる（実際そうなっていた）。
//   - 実行体: 既定は PATH 上の `python3`。SHIROKANE のログインシェルでは miniconda の
//     python3(numpy あり)が先頭に来るので従来どおり動き、コンテナでは同梱の python3 が使われる。
//   - スクリプト: viewer リポに **vendoring 済み**の `viewer/scripts/`。前処理リポ
//     (`~/pangenome/ggb/superbubble/scripts`)への実行時依存を切るため。
//
// 必要な Python 側の依存は numpy だけ(bubble_msa.py が distill の .npy を読む)。
// reads_query.py / cs_ops.py は標準ライブラリのみ。

/** ヘルパ実行に使う python。AMIPA_PYTHON > 旧 MSA_PYTHON/AMIPA_PY > PATH の python3。 */
export const AMIPA_PYTHON =
  (process.env.AMIPA_PYTHON ?? process.env.GGB_PYTHON) || (process.env.AMIPA_MSA_PYTHON ?? process.env.MSA_PYTHON) || (process.env.AMIPA_PY ?? process.env.GGB_PY) || 'python3'

/**
 * 同梱 Python ヘルパの絶対パス。src 実行(ts-node-dev)でも dist 実行でも
 * `viewer/scripts/<name>` を指す（src/xxx.ts と dist/xxx.js の両方から `../scripts`）。
 */
export function amipaScript(name: string): string {
  return path.join(__dirname, '../../scripts', name)
}
