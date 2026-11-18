# 導入

必要なのは Docker（または Apptainer）だけ。Node も Python も conda も要らない。

> 版を固定したいときはタグを付ける（`:0.1.0` / `:0.1`）。`:latest` は最新のリリース、
> `:main` は開発中の main を指す。

## Docker

```bash
docker pull ghcr.io/kamadahiroaki/amipa-viewer     # 閲覧だけならこれで足りる
docker pull ghcr.io/kamadahiroaki/amipa-prep       # 自分の GFA から DB を作るなら
```

## Apptainer / Singularity（HPC など docker が使えない環境）

```bash
apptainer pull amipa-viewer.sif docker://ghcr.io/kamadahiroaki/amipa-viewer
apptainer pull amipa-prep.sif   docker://ghcr.io/kamadahiroaki/amipa-prep
```

実行時は `--cleanenv` を必ず付ける。Apptainer は PATH/LD_LIBRARY_PATH 以外の環境変数を
引き継ぐため、ホスト側の conda や `PYTHONPATH`、`~/.local` のパッケージがコンテナ内の
Python を壊すことがある。

```bash
apptainer exec --cleanenv -B /path/to/graph.amipa:/data amipa-viewer.sif amipa check
```

## ソースからビルドする

context はリポジトリのルート（末尾の `.`）。`.dockerignore` で実データを外してあるので
context は数 MB に収まる。

```bash
git clone https://github.com/kamadahiroaki/amipa.git && cd amipa
docker build -f docker/Dockerfile.viewer -t amipa-viewer \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 3-5 分
docker build -f docker/Dockerfile.prep   -t amipa-prep \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 10-20 分（Rust のコンパイル）
```

`AMIPA_REV` は版の刻印（`amipa version` と、DB の `db_meta.emitter_rev` に入る）。
`.git` は context から外してあるので、渡さないと `unknown` になる。

どちらのイメージも最終段で自己テストする（BubbleFinder が起動するか、ネイティブモジュールが
require できるか、python の依存が揃っているか）。共有ライブラリの取りこぼしは
実行時ではなく `docker build` の時点で落ちる。

Apptainer なら:

```bash
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-prep.sif   docker/amipa-prep.def
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-viewer.sif docker/amipa-viewer.def
```

`env -u APPTAINER_BINDPATH` は、サイト設定で共有ディレクトリを bind している環境で必要
（イメージ側に同名のディレクトリが無いとコンテナ作成に失敗するため）。
ビルドには外向き通信が要る（conda-forge と bioconda・PyPI・crates.io）。

既定のバブル分解器は BubbleFinder。`docker/amipa-prep.def` は手元で使うイメージ用で、選択肢として
Billi も焼いて入れる（`AMIPA_WITH_BILLI=1`。Billi は再配布できないので、この方法で作ったイメージは配らない）。
`Dockerfile.prep` は配布用で、Billi を入れない。

ビルド手順の実体は `docker/build-prep.sh` / `docker/build-viewer.sh` の 2 本だけで、
Docker と Apptainer の両方がこれを呼ぶ（手順が二重化しないようにしてある）。
Dockerfile はマルチステージ（コンパイラを含む段と、実行に要る物だけの段）、
Apptainer def は単一ステージという違いだけがある。この差で過去に事故があるので
（`libncurses-dev` が残る Apptainer 版では気付けない依存の抜けが Docker 版だけで出た）、
runtime 段に何を入れるかを変えたら両方で焼き直して確かめること。

## コンテナを使わずに前処理を回す（ホスト実行）

コンテナが使えない環境では、リポジトリの `prep/amipa_prep/cli.py` を直接呼べる（`amipa prep` と同じ引数）。
イメージの中でやっていることを自分で揃える必要がある（手順の実体は `docker/build-prep.sh`）。

- Python 3.9 以上（`python3` が古い計算機ではそれ以上の版を明示して呼ぶ。3.9 で通している）
- `pip install -r docker/requirements.txt`（版を固定してある）
- Rust の拡張 3 つ: `prep/core/{emit_core,reads_core,tiled_core}` を `maturin build --release` して pip で入れる（Rust と maturin 1.14）
- BubbleFinder（`conda install -c bioconda bubblefinder` など）。場所は `--bubblefinder` か環境変数 `AMIPA_BUBBLEFINDER`

```bash
python3 prep/amipa_prep/cli.py run --gfa graph.gfa.gz --out graph.amipa --threads 8
```

閲覧側をホストで動かす手順は `docker/build-viewer.sh` にある（できた `viewer/backend/dist/server.js` を node で起動、点検は `dist/check.js`）。

## 動作確認

```bash
docker run --rm -v /path/to/graph.amipa:/data:ro ghcr.io/kamadahiroaki/amipa-viewer check
```

`RESULT: OK` なら、その DB は開ける状態にある。この点検は巨大な DB でも数秒で終わる
（全走査を一切しない）。
