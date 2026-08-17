# AMIPA — Annotated Multi-resolution Interactive Pangenome Atlas

パンゲノムグラフ（GFA）を**多解像度のアトラス**に前処理し、ブラウザで対話的に見るためのツール。

- **前処理** `amipa prep` … GFA → バブル分解 → 統一 LOD 木 → 向き付きレイアウト → 多層 SQLite
  （アノテーション・リード整列も同じ 1 コマンドで）
- **閲覧** `amipa serve` … 出来上がったアトラスを読むだけの軽量サーバ（Node + SQLite + WebGL）

前処理は重い計算を一度だけ、閲覧はどこでも軽く、という分離になっている。
両者はコンテナイメージが別なので、**片方だけ導入して使える**。

## 5 分で試す

```bash
# 閲覧だけ（配布されているアトラスを見る）
docker run --rm -p 3001:3001 -v /path/to/atlas:/data:ro <registry>/amipa-viewer serve
# → http://localhost:3001

# 自分の GFA からアトラスを作る
docker run --rm -v "$PWD:/work" -w /work -u "$(id -u):$(id -g)" \
  <registry>/amipa-prep prep run --gfa /work/graph.gfa --out /work/graph.amipa --threads 8
```

詳細は [docs/](docs/) を参照。

## 構成

| ディレクトリ | 中身 |
|---|---|
| `prep/` | 前処理。`amipa_prep/`(Python) と `core/`(Rust: 幾何・DB 書き込み・リード索引の hot path) |
| `viewer/` | 閲覧。`backend/`(Express + SQLite) `frontend/`(React + PixiJS) `scripts/`(Python ヘルパ) |
| `docker/` | 2 つのイメージ定義（Docker / Apptainer で同じビルド手順を共用） |
| `deploy/` | クラウド公開の手順一式 |
| `docs/` | 仕様と使い方 |

## ライセンスと引用

- `prep/` は **GPL-3.0-or-later**（Infomap を同一プロセスで利用するため）、
  `viewer/` は **MIT**。同梱物の一覧は [`NOTICE`](NOTICE)、詳細は [docs/licensing.md](docs/licensing.md)
- 引用のしかたは [docs/citation.md](docs/citation.md)（AMIPA 本体＋使った工程の外部ツール）
- コンテナ内では `amipa licenses` で同梱物のライセンス表示を確認できます
