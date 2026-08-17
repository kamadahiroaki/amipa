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

```bash
git clone <repo> amipa && cd amipa
docker build -f docker/Dockerfile.viewer -t amipa-viewer .    # 3-5 分
docker build -f docker/Dockerfile.prep   -t amipa-prep   .    # 15-25 分（povu と Rust のコンパイル）
```

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

## 動作確認

```bash
docker run --rm -v /path/to/atlas:/data:ro <registry>/amipa-viewer check
```

`RESULT: OK` なら、そのアトラスは開ける状態にある。この点検は**巨大なアトラスでも数秒**で終わる
（全走査を一切しない）。
