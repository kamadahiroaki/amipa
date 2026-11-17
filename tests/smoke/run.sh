#!/bin/bash
# 使い方: tests/smoke/run.sh <host:port> [db]   例: tests/smoke/run.sh hww01:33041 ecoli50.db
#   ビルド済みの viewer/frontend/dist の Linear（trav.html）を jsdom + canvas の代用で動かし、起動中の backend の実データで
#   範囲・並び・固定・群・仮想化・地点の一覧を通す。どれも例外が 0 なら OK（11-17: 旧 Blocks MSA の試験を外して作り直した）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); DIST=${AMIPA_DIST:-$HERE/../../viewer/frontend/dist}
[ -f "$DIST/trav.html" ] || { echo "dist が無い: $DIST（viewer/frontend で npx vite build）" >&2; exit 2; }
[ -d "$HERE/node_modules/jsdom" ] || ( cd "$HERE" && npm i --no-audit --no-fund >/dev/null )
fail=0
for t in trav pin grp virt wl wl2; do
  echo "== $t"
  if AMIPA_DIST="$DIST" AMIPA_BASE="http://${1:?host:port}" AMIPA_DB="${2:-ecoli50.db}" timeout 900 node "$HERE/$t.mjs" > "$HERE/.last_$t.log" 2>&1; then tail -1 "$HERE/.last_$t.log"
  else fail=1; grep -v '^\s*at ' "$HERE/.last_$t.log" | tail -5; fi
done
[ $fail = 0 ] && echo "===== PASS" || { echo "===== FAIL"; exit 1; }
