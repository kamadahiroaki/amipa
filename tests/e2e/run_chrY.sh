#!/bin/bash
# 一気通貫の回帰試験: GFA → アトラス → `amipa check` が全部 ok になるか。
# 段の連結・サイドカーの生成・再開の判定が壊れていないかを、実際に走らせて確かめる。
#
#   ./run_chrY.sh --gfa /path/chrY.gfa [--out DIR] [--reads S=GAF] [--band F] [--gene F]
#   ./run_chrY.sh --gfa ... --runner apptainer   # 焼いたイメージで（既定はホストの python）
#
# chrY で 2〜4 分。所要とメモリの目安は examples/chrY/README.md。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

GFA=""; OUT=""; RUNNER=host; THREADS=${THREADS:-8}; NAME=chrY
PREP_SIF=${PREP_SIF:-$REPO/sif/amipa-prep.sif}
VIEW_SIF=${VIEW_SIF:-$REPO/sif/amipa-viewer.sif}
PY=${PY:-python3}
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --gfa) GFA=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --runner) RUNNER=$2; shift 2 ;;
    --threads) THREADS=$2; shift 2 ;;
    --reads|--band|--gene|--region|--region-ref) EXTRA+=("$1" "$2"); shift 2 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$GFA" ] || { echo "--gfa が要る" >&2; exit 2; }
OUT=${OUT:-$(mktemp -d -t amipa-e2e-XXXX)/$NAME.amipa}
TMP=${TMPDIR:-/tmp}/amipa-e2e-$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "##### e2e: $GFA → $OUT  (runner=$RUNNER, threads=$THREADS)"
t0=$SECONDS
case "$RUNNER" in
  host)
    "$PY" "$REPO/prep/amipa_prep/cli.py" run --gfa "$GFA" --out "$OUT" --name "$NAME" \
        --threads "$THREADS" --tmp "$TMP" "${EXTRA[@]}" ;;
  apptainer)
    apptainer exec --cleanenv -B "$(dirname "$GFA"):/in:ro" -B "$(dirname "$OUT"):/out" \
        -B "$TMP:/scratch" "$PREP_SIF" \
        amipa prep run --gfa "/in/$(basename "$GFA")" --out "/out/$(basename "$OUT")" \
        --name "$NAME" --threads "$THREADS" --tmp /scratch "${EXTRA[@]}" ;;
  *) echo "--runner は host か apptainer" >&2; exit 2 ;;
esac
rc=$?
[ $rc -eq 0 ] || { echo "NG  前処理が rc=$rc で終わった"; exit 1; }
echo "  前処理 $((SECONDS - t0)) 秒"

echo "-- amipa check"
if [ -x "$(command -v node)" ] && [ -f "$REPO/viewer/backend/dist/check.js" ]; then
  DB_DIR="$OUT" node "$REPO/viewer/backend/dist/check.js" | tee "$TMP/check.log"
elif [ -f "$VIEW_SIF" ]; then
  apptainer exec --cleanenv -B "$OUT:/data:ro" "$VIEW_SIF" amipa check | tee "$TMP/check.log"
else
  echo "NG  check を走らせる手段が無い（viewer をビルドするか SIF を用意する）"; exit 1
fi
grep -q "RESULT: OK" "$TMP/check.log" || { echo "NG  amipa check が OK でない"; exit 1; }

echo "-- 再開の判定（もう一度走らせて、全段が「変更なし」で飛ぶか）"
if [ "$RUNNER" = host ]; then
  "$PY" "$REPO/prep/amipa_prep/cli.py" run --gfa "$GFA" --out "$OUT" --name "$NAME" \
      --threads "$THREADS" --tmp "$TMP" "${EXTRA[@]}" > "$TMP/again.log" 2>&1
  # bundle は毎回作り直す仕様なので、それ以外が飛べば正しい
  if grep -qE "^\[amipa .*\] \[(distill|decompose|lod|layout|emit)\]" "$TMP/again.log"; then
    echo "NG  変えていないのに走り直した段がある:"; grep -E "\[(distill|decompose|lod|layout|emit)\]" "$TMP/again.log"; exit 1
  fi
  echo "  OK  全段「変更なし」で飛んだ"
fi

echo
echo "===== PASS  出力: $OUT  ($((SECONDS - t0)) 秒)"
