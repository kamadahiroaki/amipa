# blocks/ — 多解像度 MSA（共線ブロック）の計算器

viewer の Blocks パネルが使う 2 つの入口。依存は numpy（numba はあれば速い、無くても動く）。

| ファイル | 役割 |
|---|---|
| `hier.py` | 事前計算 CLI。`--db X.db --distill X.db.distill [--circular] --out X.db.blocks.json`。全体窓から、逐次計算では予算（`--budget` 秒）を超える窓だけを先に焼く。`compute_window()` は worker と共通 |
| `worker.py` | 逐次計算ワーカー。backend（`blocksWorker.ts`）が DB ごとに 1 本 spawn して常駐。stdin/stdout の 1 行 JSON。Ctx（アトラス＋distill の読み込み・合意順序）を温めておき、窓 1 個を 1 秒以内で返す |
| `msalib.py` | アトラス／distill の読み込み、破断点、合意順序（共通部） |

- サイドカー `X.db.blocks.json` の `meta.params`（錨の出現割合・併合上限・ビン数・段数）と `circular` / `order_arg` を worker も使うので、
  事前計算と逐次計算で同じ条件になる。サイドカーが無い DB でも worker は既定値で動く（全体窓は焼いていないので画面には出ない）
- 環境変数: `AMIPA_PYTHON`（実行体）、`AMIPA_BLOCKS_IDLE_MS`（既定 15 分で落とす）、`AMIPA_BLOCKS_MAX_WORKERS`（既定 3）、
  `AMIPA_BLOCKS_TIMEOUT_MS`（窓 1 個 90 s）、`AMIPA_BLOCKS_WARM_MS`（Ctx 15 分）
- 手で試す: `printf '{"id":1,"op":"warm"}\n{"id":2,"op":"ping"}\n{"op":"quit"}\n' | python3 worker.py --db X.db --distill X.db.distill`
