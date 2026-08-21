#!/bin/bash
# viewer(backend+frontend)をビルドして $APP/viewer に配置する。Dockerfile と def が共用。
#   $1 = リポジトリのルート 既定 /src   $2 = 配置先 既定 /opt/amipa
# 配置後の相対関係（server.ts / pyenv.ts が前提にする）:
#   $APP/viewer/backend/dist/server.js  →  ../../frontend/dist（静的配信） / ../../scripts（python ヘルパ）
set -euo pipefail
SRC=${1:-/src}
APP=${2:-/opt/amipa}
export CI=1 YARN_CACHE_FOLDER=/tmp/yarncache
if [[ "${AMIPA_BUILD_FROM_SOURCE:-1}" == "1" ]]; then export npm_config_build_from_source=true; fi
# ★node-gyp にイメージ同梱のヘッダを使わせる（fakeroot ビルドで tar の fchown が EINVAL になるため）
[[ -d /usr/local/include/node ]] && export npm_config_nodedir=/usr/local

echo "[build-viewer] install deps"
( cd "$SRC/viewer/backend"  && yarn install --frozen-lockfile )
( cd "$SRC/viewer/frontend" && yarn install --frozen-lockfile )
echo "[build-viewer] build (tsc / vite)"
( cd "$SRC/viewer/backend"  && yarn build )
( cd "$SRC/viewer/frontend" && yarn build )

echo "[build-viewer] stage into $APP/viewer"
mkdir -p "$APP/viewer/backend" "$APP/viewer/frontend"
cp -r "$SRC/viewer/backend/dist"  "$APP/viewer/backend/dist"
cp    "$SRC/viewer/backend/package.json" "$SRC/viewer/backend/yarn.lock" "$APP/viewer/backend/"
cp -r "$SRC/viewer/frontend/dist" "$APP/viewer/frontend/dist"
cp -r "$SRC/viewer/scripts"       "$APP/viewer/scripts"
# ★前処理側と共有する python モジュール（形式・アルゴリズムの正は prep 側にある）。
#   viewer イメージに prep は入れないので、必要な物だけここへ複製する。
#   Apptainer の def は %files で先に viewer/scripts へ置くので、その場合は prep/ が無い＝skip。
for m in cs_ops.py zstd_seek.py; do
  # Dockerfile は prep/amipa_prep/ 側を context に入れる。Apptainer の def は %files で先に
  # viewer/scripts へ置くので prep/ が無い＝そのまま使う。どちらでも最後に有無を確かめる。
  if [[ -f "$SRC/prep/amipa_prep/$m" ]]; then
    cp "$SRC/prep/amipa_prep/$m" "$APP/viewer/scripts/$m"
  fi
  if [[ ! -f "$APP/viewer/scripts/$m" ]]; then
    echo "[build-viewer] 共有モジュール $m が見つからない（context の入れ方を確認）" >&2
    exit 1
  fi
done
rm -rf "$APP/viewer/scripts/__pycache__"
# 同梱物のライセンス表示（amipa licenses が読む）。GPL/LGPL のシステムパッケージを含む以上、
# 配布物から必ず参照できる必要があるので、無ければ落とす。
install -m 0644 "$SRC/NOTICE" "$APP/NOTICE"
( cd "$APP/viewer/backend" && yarn install --frozen-lockfile --production )
rm -rf "$YARN_CACHE_FOLDER"
echo "[build-viewer] done: $(du -sh "$APP/viewer" | cut -f1)"
