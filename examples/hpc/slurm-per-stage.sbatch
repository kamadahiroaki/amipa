#!/bin/bash
# AMIPA の 1 段を実行する（Slurm の例）。
#   sbatch --job-name=amipa_emit --cpus-per-task=1 --mem=178G slurm-per-stage.sbatch emit
#SBATCH --output=amipa_%x_%j.log
set -euo pipefail
STAGE="${1:?段名}"
SIF=${AMIPA_SIF:?}; GFA=${GFA:?}; OUT=${OUT:?}

# Slurm は $TMPDIR を用意しない構成もある。ノードローカルの領域を確実に指す
SCRATCH="${SLURM_TMPDIR:-${TMPDIR:-/tmp/$USER}}/amipa"
mkdir -p "$SCRATCH"

apptainer exec --cleanenv -B "$SCRATCH:/scratch" "$SIF" \
  amipa prep run --only "$STAGE" \
    --gfa "$GFA" --out "$OUT" --threads "${SLURM_CPUS_PER_TASK:-8}" --tmp /scratch \
    ${AMIPA_EXTRA:-}

# 段の依存は投入側で: sbatch --dependency=afterok:<jobid> ...
