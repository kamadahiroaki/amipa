#!/bin/bash
# 回帰試験のディスパッチャ。詳しくは tests/README.md。
#   tests/run.sh format
#   tests/run.sh db   [--fast] <db ファイル> [<db> ...]
#   tests/run.sh e2e --gfa /path/chrY.gfa [--reads S=GAF ...]
#   tests/run.sh e2e-named --gfa /path/chrY.gfa   （セグメント名を整数でない名前に書き換えて e2e）
#   tests/run.sh api <db ファイル名> <host:port>
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:-python3}
what=${1:-help}; shift 2>/dev/null || true

case "$what" in
  format)
    rc=0
    for t in "$HERE"/format/test_*.py; do "$PY" "$t" || rc=1; done
    exit $rc ;;
  db)   exec "$PY" "$HERE/db/verify_db.py" "$@" ;;
  e2e)  exec bash "$HERE/e2e/run_chrY.sh" "$@" ;;
  e2e-named)   # 整数でないセグメント名の GFA（--gfa の id を utg<id>l に書き換えたもの）で e2e。名前モードと <db>.segnames を通す（11-17）
    g=""; rest=(); while [ $# -gt 0 ]; do if [ "$1" = --gfa ]; then g=$2; shift 2; else rest+=("$1"); shift; fi; done
    [ -n "$g" ] || { echo "--gfa が要る" >&2; exit 2; }
    t=$(mktemp -d /tmp/amipa-named-XXXX); "$PY" "$HERE/e2e/named_gfa.py" "$g" "$t/$(basename "$g")"
    # 11-18: 出力先を明示する（以前は /tmp/amipa-e2e-* の最後を拾っていた。$TMPDIR のあるジョブでは別の古い出力を見て NG になった）
    out="$t/out/chrY.amipa"; mkdir -p "$t/out"
    bash "$HERE/e2e/run_chrY.sh" --gfa "$t/$(basename "$g")" --out "$out" "${rest[@]}"; rc=$?
    if [ $rc = 0 ]; then n=$(ls "$out"/*.segnames 2>/dev/null | wc -l); [ "$n" = 1 ] && echo "  OK  名前の表 $(ls "$out"/*.segnames)" || { echo "NG  名前の表 <db>.segnames が無い"; rc=1; }; fi
    rm -rf "$t"; exit $rc ;;
  api)  exec bash "$HERE/api/verify_api.sh" "$@" ;;
  help|*)
    sed -n '2,7p' "$0"; exit 2 ;;
esac
