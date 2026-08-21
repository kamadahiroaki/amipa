#!/bin/bash
# 回帰試験のディスパッチャ。詳しくは tests/README.md。
#   tests/run.sh format
#   tests/run.sh db   [--fast] <db ファイル> [<db> ...]
#   tests/run.sh e2e --gfa /path/chrY.gfa [--reads S=GAF ...]
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
  api)  exec bash "$HERE/api/verify_api.sh" "$@" ;;
  help|*)
    sed -n '2,7p' "$0"; exit 2 ;;
esac
