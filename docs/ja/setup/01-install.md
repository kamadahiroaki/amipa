# 導入

[English](../../en/setup/01-install.md)

AMIPA は 2 つのコンテナイメージで配っている。前処理（GFA から DB を作る）が `amipa-prep`、閲覧（DB を画面で見る）が `amipa-viewer` で、片方だけ導入して使える。必要なのは Docker か Apptainer だけで、Node・Python・conda は要らない。

## どれを選ぶか

| したいこと | 入れるもの |
|---|---|
| 作ってもらった DB を見るだけ | `amipa-viewer` |
| 自分の GFA から DB を作って見る | `amipa-prep` と `amipa-viewer` |
| HPC（Docker が使えない計算機）で DB を作る | Apptainer で `amipa-prep`（下記） |
| コンテナを使えない | ソースから（下記の「コンテナを使わずに前処理を回す」） |

版を固定したいときはタグを付ける（`:0.1.0` や `:0.1`）。`:latest` は最新のリリース、`:main` は開発中の main を指す。

## Docker

```bash
docker pull ghcr.io/kamadahiroaki/amipa-viewer     # 閲覧だけならこれで足りる
docker pull ghcr.io/kamadahiroaki/amipa-prep       # 自分の GFA から DB を作るなら
```

確かめ方: 版の刻印（イメージを焼いた commit）が JSON で出ればよい。

```bash
docker run --rm ghcr.io/kamadahiroaki/amipa-viewer version
```

```
{
  "version": "abc1234",
  "commit": "abc1234",
  "runtime": "v20.x.x"
}
```

## Apptainer（HPC）

Docker が使えない計算機では Apptainer（Singularity）でイメージを取ってくる。

```bash
apptainer pull amipa-viewer.sif docker://ghcr.io/kamadahiroaki/amipa-viewer
apptainer pull amipa-prep.sif   docker://ghcr.io/kamadahiroaki/amipa-prep
```

実行するときは `--cleanenv` を必ず付ける。Apptainer はホストの環境変数を引き継ぐので、ホスト側の conda や `PYTHONPATH`、`~/.local` のパッケージがコンテナ内の Python を壊すことがある。

```bash
apptainer exec --cleanenv amipa-prep.sif amipa prep --help
apptainer exec --cleanenv -B /path/to/graph.amipa:/data amipa-viewer.sif amipa check
```

## ソースから

### イメージを自分で焼く

ビルドの context はリポジトリのルート（末尾の `.`）。`.dockerignore` で実データを外してあるので、context は数 MB に収まる。

```bash
git clone https://github.com/kamadahiroaki/amipa.git && cd amipa
docker build -f docker/Dockerfile.viewer -t amipa-viewer \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 3-5 分
docker build -f docker/Dockerfile.prep   -t amipa-prep \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 10-20 分（Rust のコンパイル）
```

`AMIPA_REV` は版の刻印で、`amipa version` と DB の `db_meta.emitter_rev` に入る。`.git` は context から外してあるので、渡さないと `unknown` になる。

どちらのイメージも最終段で自己テストをする（BubbleFinder が起動するか、ネイティブモジュールを読み込めるか、Python の依存が揃っているか）。共有ライブラリの取りこぼしは、実行時ではなく `docker build` の時点で失敗として出る。

Apptainer で焼く場合:

```bash
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-prep.sif   docker/amipa-prep.def
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-viewer.sif docker/amipa-viewer.def
```

`env -u APPTAINER_BINDPATH` は、サイトの設定で共有ディレクトリを bind している環境で要る（イメージ側に同名のディレクトリが無いとコンテナの作成に失敗する）。ビルドには外向きの通信が要る（conda-forge、bioconda、PyPI、crates.io）。

バブル分解器（グラフの中の「分岐して再び合流する部分」を見つけるツール）の既定は BubbleFinder。`docker/amipa-prep.def` は手元で使うイメージ用で、選択肢として Billi も入れられる（`AMIPA_WITH_BILLI=1`）。Billi は再配布できないので、この方法で作ったイメージは配らないこと。`Dockerfile.prep` は配布用で、Billi を入れない。

ビルド手順の実体は `docker/build-prep.sh` と `docker/build-viewer.sh` の 2 本で、Docker と Apptainer の両方がこれを呼ぶ。イメージに入れるものを変えたら、両方で焼き直して確かめる。

### コンテナを使わずに前処理を回す

コンテナが使えない環境では、リポジトリの `prep/amipa_prep/cli.py` を直接呼べる（`amipa prep` と同じ引数）。イメージの中でしていることを自分で揃える必要がある（手順の実体は `docker/build-prep.sh`）。

- Python 3.9 以上（`python3` が古い計算機では、それ以上の版を明示して呼ぶ）
- `pip install -r docker/requirements.txt`（版を固定してある）
- Rust の拡張 3 つ: `prep/core/{emit_core,reads_core,tiled_core}` を `maturin build --release` して pip で入れる（Rust と maturin 1.14）
- BubbleFinder（`conda install -c bioconda bubblefinder` など）。場所は `--bubblefinder` か環境変数 `AMIPA_BUBBLEFINDER` で渡す

```bash
python3 prep/amipa_prep/cli.py run --gfa graph.gfa.gz --out graph.amipa --threads 8
```

閲覧側をホストで動かす手順は `docker/build-viewer.sh` にある（できた `viewer/backend/dist/server.js` を node で起動し、点検は `dist/check.js`）。

## 動作を確かめる

手元に DB があれば、閲覧イメージの点検を通す。

```bash
docker run --rm -v /path/to/graph.amipa:/data:ro ghcr.io/kamadahiroaki/amipa-viewer check
```

最後に `RESULT: OK` と出れば、その DB は開ける状態にある。この点検は DB 全体を読み通さないので、大きな DB でも数秒で終わる。まだ DB が無ければ、次の [最初の DB を作る（chrY）](02-first-db.md) で作る。

ライセンスと同梱物の一覧は、どちらのイメージでも `amipa licenses` で出る（[ライセンス](../reference/licensing.md)）。
