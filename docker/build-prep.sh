#!/bin/bash
# amipa-prep イメージの中身を作る。**Dockerfile と Apptainer def の両方がこれを呼ぶ**（手順の単一の正）。
#   $1 = リポジトリのルート（build context） 既定 /src
#   $2 = 配置先                              既定 /opt/amipa
#
# ①povu をビルド ②Rust core(emit_core/reads_core)を wheel 化 ③Python 依存 ④コード配置。
# ネットワークが要る（povu の CPM 依存と PyPI / crates.io）。
set -euo pipefail

SRC=${1:-/src}
APP=${2:-/opt/amipa}
POVU_REPO=${POVU_REPO:-https://github.com/pangenome/povu.git}
POVU_COMMIT=${POVU_COMMIT:-000351f}      # 検証に使っている版に固定

echo "[build-prep] 1/4 povu ($POVU_COMMIT)"
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

echo "[build-prep] 2/4 Rust core"
export CARGO_HOME=${CARGO_HOME:-/tmp/cargo}
pip install --no-cache-dir maturin==1.5.1 >/dev/null
mkdir -p /tmp/wheels
for c in emit_core reads_core; do
  ( cd "$SRC/prep/core/$c" && maturin build --release --out /tmp/wheels >/dev/null )
  echo "[build-prep]   -> $c ok"
done

echo "[build-prep] 3/4 Python 依存"
pip install --no-cache-dir -r "$SRC/docker/requirements.txt"
pip install --no-cache-dir /tmp/wheels/*.whl
python3 -c "import emit_core, reads_core, numpy, scipy, numba, infomap, Bio; print('[build-prep]   imports ok')"

echo "[build-prep] 4/4 コード配置"
mkdir -p "$APP/prep"
cp -r "$SRC/prep/amipa_prep" "$APP/prep/amipa_prep"
# ★ホストの umask がそのまま入るとコンテナの実行ユーザから読めない。全ユーザ可にする。
install -m 0644 "$SRC/NOTICE" "$APP/NOTICE" 2>/dev/null || true
chmod -R a+rX "$APP"
rm -rf /tmp/wheels /tmp/povu "${CARGO_HOME}" "$APP"/prep/amipa_prep/__pycache__
echo "[build-prep] done: $(du -sh "$APP" | cut -f1)"
