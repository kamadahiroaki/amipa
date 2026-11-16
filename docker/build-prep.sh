#!/bin/bash
# amipa-prep イメージの中身を作る。**Dockerfile と Apptainer def の両方がこれを呼ぶ**（手順の単一の正）。
#   $1 = リポジトリのルート（build context） 既定 /src
#   $2 = 配置先                              既定 /opt/amipa
#
# ①povu をビルド ②バブル分解器（BubbleFinder、任意で Billi） ③Rust core(emit_core/reads_core/tiled_core)を
# wheel 化 ④Python 依存 ⑤コード配置。
# ネットワークが要る（povu の CPM 依存、conda-forge/bioconda、GitHub、PyPI / crates.io）。
#
# AMIPA_WITH_BILLI=1 のときだけ Billi を焼いて入れる（既定 0）。Billi のリポジトリにはライセンスの表示が無く
# （2026-11-16 確認）再配布の許諾が無いので、公開するイメージには入れない。手元で使うイメージだけ 1 にする。
set -euo pipefail

SRC=${1:-/src}
APP=${2:-/opt/amipa}
POVU_REPO=${POVU_REPO:-https://github.com/pangenome/povu.git}
POVU_COMMIT=${POVU_COMMIT:-000351f}      # 検証に使っている版に固定
BUBBLEFINDER_VERSION=${BUBBLEFINDER_VERSION:-1.0.5}   # bioconda。検証に使っている版に固定（GPL-3.0）
MICROMAMBA_VERSION=${MICROMAMBA_VERSION:-2.0.5-0}
AMIPA_WITH_BILLI=${AMIPA_WITH_BILLI:-0}
BILLI_REPO=${BILLI_REPO:-https://github.com/at-cg/billi.git}
BILLI_COMMIT=${BILLI_COMMIT:-75e203f}      # 検証に使っている版に固定

echo "[build-prep] 1/5 povu ($POVU_COMMIT)"
rm -rf /tmp/povu && mkdir -p /tmp/povu && cd /tmp/povu
git init -q .
git remote add origin "$POVU_REPO"
git fetch -q --depth 1 origin "$POVU_COMMIT" || git fetch -q origin
git checkout -q FETCH_HEAD 2>/dev/null || git checkout -q "$POVU_COMMIT"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
# `povu` ターゲットだけを作る。★TUI ライブラリ zien に依存するので ncurses の開発版が要る。
cmake --build build --target povu -j "$(nproc)" >/dev/null
BIN=$(find . -name povu -type f -perm -u+x -not -path "*/CMakeFiles/*" | head -1)
test -n "$BIN" || { echo "povu バイナリが見つからない"; exit 1; }
install -m 0755 "$BIN" /usr/local/bin/povu
# ★povu は libzien.so 等の自前共有ライブラリを持ち、RPATH がビルド木を指す。
#   バイナリだけ入れると別マシンで "error while loading shared libraries" になる。
install -d /usr/local/lib/amipa
find . \( -name "*.so" -o -name "*.so.*" \) -type f -print0 |
  xargs -0 -r -I{} install -m 0644 {} /usr/local/lib/amipa/
echo /usr/local/lib/amipa > /etc/ld.so.conf.d/amipa.conf
ldconfig
if ldd /usr/local/bin/povu | grep -q "not found"; then
  echo "povu の共有ライブラリが解決できない:"; ldd /usr/local/bin/povu | grep "not found"; exit 1
fi
povu -h >/dev/null
echo "[build-prep]   -> $(command -v povu) (+ $(ls /usr/local/lib/amipa | wc -l) shared libs)"

echo "[build-prep] 2/5 バブル分解器"
# BubbleFinder: bioconda の版をそのまま /opt/bubblefinder に入れる（共有ライブラリも conda の物を使うので
# 単体のバイナリだけ持ち出すと動かない）。micromamba は使い終わったら消す。
curl -sSfL -o /tmp/micromamba \
  "https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}/micromamba-linux-64"
chmod 0755 /tmp/micromamba
MAMBA_ROOT_PREFIX=/tmp/mamba /tmp/micromamba create -y -q -p /opt/bubblefinder \
  -c conda-forge -c bioconda "bubblefinder=${BUBBLEFINDER_VERSION}"
# ★引数なしの BubbleFinder は使い方を出して終了コード 1 になる（pipefail の下で `| grep` すると止まる）。--help は 0
/opt/bubblefinder/bin/BubbleFinder --help >/dev/null
rm -rf /tmp/micromamba /tmp/mamba /opt/bubblefinder/pkgs
chmod -R a+rX /opt/bubblefinder
echo "[build-prep]   -> /opt/bubblefinder/bin/BubbleFinder ($BUBBLEFINDER_VERSION)"
if [ "$AMIPA_WITH_BILLI" = 1 ]; then
  rm -rf /tmp/billi && git clone -q "$BILLI_REPO" /tmp/billi
  ( cd /tmp/billi && git checkout -q "$BILLI_COMMIT" && make -j "$(nproc)" >/dev/null )
  install -m 0755 /tmp/billi/billi /usr/local/bin/billi
  rm -rf /tmp/billi
  billi decompose --help >/dev/null
  echo "[build-prep]   -> $(command -v billi) ($BILLI_COMMIT)"
else
  echo "[build-prep]   Billi は入れない（AMIPA_WITH_BILLI=1 で入れる。既定の分解器は AMIPA_DECOMPOSER で決める）"
fi

echo "[build-prep] 3/5 Rust core"
export CARGO_HOME=${CARGO_HOME:-/tmp/cargo}
# ★Rust の版は Cargo.lock を書いた側（開発機）と揃える。古いと lock を読めない
#   （新しい crate は edition2024 を要求する）。maturin も同時代の物にする。
pip install --no-cache-dir maturin==1.14.1 >/dev/null
mkdir -p /tmp/wheels
for c in emit_core reads_core tiled_core; do
  ( cd "$SRC/prep/core/$c" && maturin build --release --out /tmp/wheels >/dev/null )
  echo "[build-prep]   -> $c ok"
done

echo "[build-prep] 4/5 Python 依存"
pip install --no-cache-dir -r "$SRC/docker/requirements.txt"
pip install --no-cache-dir /tmp/wheels/*.whl
python3 -c "import emit_core, reads_core, tiled_core, numpy, scipy, numba, infomap, Bio, zstandard; print('[build-prep]   imports ok')"

echo "[build-prep] 5/5 コード配置"
mkdir -p "$APP/prep"
cp -r "$SRC/prep/amipa_prep" "$APP/prep/amipa_prep"
# ★ホストの umask がそのまま入るとコンテナの実行ユーザから読めない。全ユーザ可にする。
# ★NOTICE とライセンス全文が入らないまま焼けると頒布の条件を満たせないので、失敗させる。
#   prep は GPL-3.0-or-later（GPL 第4条が全文の添付を要求する）。
install -m 0644 "$SRC/NOTICE"  "$APP/NOTICE"
install -m 0644 "$SRC/LICENSE" "$APP/LICENSE"
chmod -R a+rX "$APP"
rm -rf /tmp/wheels /tmp/povu "${CARGO_HOME}" "$APP"/prep/amipa_prep/__pycache__
echo "[build-prep] done: $(du -sh "$APP" | cut -f1)"
