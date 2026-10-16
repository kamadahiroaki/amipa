#!/bin/bash
# 使い方: tests/smoke/run.sh <host:port> [db]   例: tests/smoke/run.sh hc025:33001 ecoli50.db
#   viewer/frontend の esbuild で描画部を束ね、jsdom 上で 接合一覧→カード→遺伝子の並び→塩基→系統樹のまとめ/表示範囲の木 を通す。例外が 0 なら OK
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); FE="$HERE/../../viewer/frontend"
[ -d "$HERE/node_modules/jsdom" ] || ( cd "$HERE" && npm i --no-audit --no-fund >/dev/null )
( cd "$FE" && npx esbuild "$HERE/entry.ts" --bundle --format=esm --platform=node --target=es2022 --outfile="$HERE/bundle.mjs" --log-level=warning )
AMIPA_BASE="http://${1:?host:port}" AMIPA_DB="${2:-ecoli50.db}" node "$HERE/smoke.mjs"
# 変異の効果（段階 A）: ybeF の座位で擬似遺伝子 8 株に機能喪失が付くか（遺伝子サイドカー format 3 の ecoli50 向け。他の DB では AMIPA_EFFECTS=0 で飛ばす）
[ "${AMIPA_EFFECTS:-1}" = 1 ] && AMIPA_BASE="http://$1" AMIPA_DB="${2:-ecoli50.db}" node "$HERE/effects.mjs"
