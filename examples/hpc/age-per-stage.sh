#!/bin/bash
# AMIPA の 1 段を実行する（AGE/SGE の例）。段名と資源は投入側で与える。
#   qsub -N amipa_emit -pe def_slot 1 -l s_vmem=178G age-per-stage.sh emit
#$ -S /bin/bash
#$ -cwd
#$ -j y
set -euo pipefail
STAGE="${1:?段名（distill/decompose/lod/layout/emit/annot/reads/bundle）}"

SIF=${AMIPA_SIF:?AMIPA_SIF にイメージのパスを設定してください}
GFA=${GFA:?入力 GFA}
OUT=${OUT:?出力アトラス}

module use /usr/local/package/modulefiles 2>/dev/null || true
module load apptainer 2>/dev/null || true

# 一時領域はここで決める。スケジューラがジョブ専用に用意する領域があればそれを使う
SCRATCH="${TMPDIR:-/tmp/$USER}/amipa"
mkdir -p "$SCRATCH"
echo "stage=$STAGE host=$(hostname) scratch=$SCRATCH 空き=$(df -h "$SCRATCH" | awk 'NR==2{print $4}')"

apptainer exec --cleanenv -B "$SCRATCH:/scratch" "$SIF" \
  amipa prep run --only "$STAGE" \
    --gfa "$GFA" --out "$OUT" --threads "${NSLOTS:-8}" --tmp /scratch \
    ${AMIPA_EXTRA:-}
