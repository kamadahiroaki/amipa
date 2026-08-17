# 導入

必要なのは **Docker（または Apptainer）だけ**。Node も Python も conda も要らない。

## Docker

```bash
docker pull <registry>/amipa-viewer     # 閲覧だけならこれで足りる
docker pull <registry>/amipa-prep       # 自分の GFA からアトラスを作るなら
```

## Apptainer / Singularity（HPC など docker が使えない環境）

```bash
apptainer pull amipa-viewer.sif docker://<registry>/amipa-viewer
apptainer pull amipa-prep.sif   docker://<registry>/amipa-prep
```

実行時は **`--cleanenv` を必ず付ける**。Apptainer は PATH/LD_LIBRARY_PATH 以外の環境変数を
引き継ぐため、ホスト側の conda や `PYTHONPATH`、`~/.local` のパッケージがコンテナ内の
Python を壊すことがある。

```bash
apptainer exec --cleanenv -B /path/to/atlas:/data amipa-viewer.sif amipa check
```

## ソースからビルドする

**context はリポジトリのルート**（末尾の `.`）。`.dockerignore` で実データを外してあるので
context は数 MB に収まる。

```bash
git clone <repo> amipa && cd amipa
docker build -f docker/Dockerfile.viewer -t amipa-viewer \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 3-5 分
docker build -f docker/Dockerfile.prep   -t amipa-prep \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 15-25 分（povu と Rust のコンパイル）
```

`AMIPA_REV` は版の刻印（`amipa version` と、アトラスの `db_meta.emitter_rev` に入る）。
`.git` は context から外してあるので、**渡さないと `unknown`** になる。

どちらのイメージも**最終段で自己テストする**（povu が起動するか、ネイティブモジュールが
require できるか、python の依存が揃っているか）。共有ライブラリの取りこぼしは
実行時ではなく **`docker build` の時点で**落ちる。

Apptainer なら:

```bash
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-prep.sif   docker/amipa-prep.def
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-viewer.sif docker/amipa-viewer.def
```

`env -u APPTAINER_BINDPATH` は、サイト設定で共有ディレクトリを bind している環境で必要
（イメージ側に同名のディレクトリが無いとコンテナ作成に失敗するため）。
**ビルドには外向き通信が要る**（povu の依存取得・PyPI・crates.io）。

ビルド手順の実体は `docker/build-prep.sh` / `docker/build-viewer.sh` の 2 本だけで、
Docker と Apptainer の両方がこれを呼ぶ（手順が二重化しないようにしてある）。
Dockerfile はマルチステージ（コンパイラを含む段と、実行に要る物だけの段）、
Apptainer def は単一ステージという違いだけがある。**この差で過去に事故がある**ので
（`libncurses-dev` が残る Apptainer 版では気付けない依存の抜けが Docker 版だけで出た）、
runtime 段に何を入れるかを変えたら両方で焼き直して確かめること。

## 動作確認

```bash
docker run --rm -v /path/to/atlas:/data:ro <registry>/amipa-viewer check
```

`RESULT: OK` なら、そのアトラスは開ける状態にある。この点検は**巨大なアトラスでも数秒**で終わる
（全走査を一切しない）。
