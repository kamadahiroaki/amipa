# AMIPA — Annotated Multi-resolution Interactive Pangenome Atlas

パンゲノムグラフをインタラクティブに閲覧するためのツール。

数千万から億のノードを持つ GFA はそのままでは可視化できない。
AMIPA はグラフを前処理してDB形式に変換し、全ゲノムの俯瞰から塩基レベルまで
高速なロードを可能にする。

## 特徴

- 全ゲノムの俯瞰から塩基レベルまでの連続的ズーム
- ハプロタイプごとに色を分け、見たいサンプルだけに絞り込む
- 参照座標、遺伝子、染色体バンドを重ねる
- リード整列（GAF）を重ね、どの分岐を何本のリードが通ったかを見る
- 選んだ領域のアレルを並べて比較し、FASTA / CLUSTAL / TSV / GFA / BED で書き出す

## 試す

```bash
# 閲覧だけ（手元にあるアトラスを開く）
docker run --rm -p 3001:3001 -v /path/to/atlas:/data:ro ghcr.io/kamadahiroaki/amipa-viewer serve
# → http://localhost:3001

# 自分の GFA からアトラスを作る
docker run --rm -v "$PWD:/work" -w /work -u "$(id -u):$(id -g)" \
  ghcr.io/kamadahiroaki/amipa-prep prep run --gfa /work/graph.gfa --out /work/graph.amipa --threads 8
```

ヒト chrY を一通り通す例 [examples/chrY/](examples/chrY/) 

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
