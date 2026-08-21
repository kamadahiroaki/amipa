# AMIPA — Annotated Multi-resolution Interactive Pangenome Atlas

パンゲノムグラフをブラウザで見るためのツール。

数千万から億のノードを持つ GFA は、そのままでは開くことも描くこともできない。
AMIPA はグラフを一度だけ前処理して「アトラス」という形式に変換し、
全ゲノムの俯瞰から塩基 1 文字まで、地図のように拡大しながらたどれるようにする。

## できること

- 全ゲノムの俯瞰から塩基レベルまで、途切れずにズームする
- ハプロタイプごとに色を分け、見たいサンプルだけに絞り込む
- 参照座標（GRCh38 など）、遺伝子、染色体バンドを重ねる
- リード整列（GAF）を重ね、どの分岐を何本のリードが通ったかを見る
- 選んだ領域のアレルを並べて比較し、FASTA / CLUSTAL / TSV / GFA / BED で書き出す

## 2 つのコマンド

| | すること | いつ使うか |
|---|---|---|
| `amipa prep` | GFA からアトラスを作る | 一度だけ。重い |
| `amipa serve` | 出来たアトラスを配信する | 見るたびに。軽い |

イメージが別々なので、配布されたアトラスを見るだけなら閲覧側だけを入れればよい。

## 試す

```bash
# 閲覧だけ（手元にあるアトラスを開く）
docker run --rm -p 3001:3001 -v /path/to/atlas:/data:ro ghcr.io/kamadahiroaki/amipa-viewer serve
# → http://localhost:3001

# 自分の GFA からアトラスを作る
docker run --rm -v "$PWD:/work" -w /work -u "$(id -u):$(id -g)" \
  ghcr.io/kamadahiroaki/amipa-prep prep run --gfa /work/graph.gfa --out /work/graph.amipa --threads 8
```

ヒト chrY を一通り通す例が [examples/chrY/](examples/chrY/) にある。数分で終わるので、
導入が正しくできているかの確認にはこれを使うとよい。

## ドキュメント

| | |
|---|---|
| [docs/install.md](docs/install.md) | 導入（Docker / Apptainer / ソースからビルド） |
| [docs/usage-prep.md](docs/usage-prep.md) | アトラスの作り方 |
| [docs/usage-viewer.md](docs/usage-viewer.md) | 画面の使い方 |
| [docs/atlas-format.md](docs/atlas-format.md) | アトラスの中身（自分で読み書きしたいとき） |
| [docs/pipeline.md](docs/pipeline.md) | 前処理が何をしているか |
| [docs/deploy.md](docs/deploy.md) | 公開サーバとして配信するとき |
| [docs/troubleshooting.md](docs/troubleshooting.md) | うまくいかないとき |

## 構成

| ディレクトリ | 中身 |
|---|---|
| `prep/` | 前処理。`amipa_prep/`（Python）と `core/`（Rust） |
| `viewer/` | 閲覧。`backend/`（Express + SQLite）`frontend/`（React + PixiJS） |
| `docker/` | 2 つのイメージ定義（Docker と Apptainer で同じビルド手順を共用） |
| `deploy/` | クラウドで配信するときの手順一式 |
| `docs/` | 使い方と仕様 |
| `examples/` | まず通す例（`chrY/`）と、ジョブスケジューラの雛形（`hpc/`） |
| `tests/` | 回帰試験 |

開発に参加するときの決まりは [CONTRIBUTING.md](CONTRIBUTING.md) にある。

## ライセンスと引用

`prep/` は GPL-3.0-or-later（Infomap を同一プロセスで利用するため）、`viewer/` は MIT。
同梱物の一覧は [NOTICE](NOTICE)、考え方は [docs/licensing.md](docs/licensing.md) を参照。
コンテナの中では `amipa licenses` でも確認できる。

引用のしかたは [docs/citation.md](docs/citation.md)（AMIPA 本体と、実際に使った工程の外部ツール）。
