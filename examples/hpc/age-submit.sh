#!/bin/bash
# 段別ジョブを依存で繋いで投入する（AGE/SGE の例）。
#   AMIPA_SIF=amipa-prep.sif GFA=graph.gfa OUT=graph.amipa [THREADS=24] [AMIPA_EXTRA="--gff-dir gff/ ..."] ./age-submit.sh
#
# 段の並びと資源は `amipa prep plan --json` から取る。plan は入力（AMIPA_EXTRA に書いた --reads・--gff-dir など）に
# 応じて走る段だけを、prep の段の順（distill … tiled → bundle）で返すので、ここに段名を書き写さない。
# 資源は出発点。1 度流したら実測（qacct -j <ジョブID> など）で詰める。
set -euo pipefail
: "${AMIPA_SIF:?}" "${GFA:?}" "${OUT:?}"
THREADS=${THREADS:-24}
export AMIPA_SIF GFA OUT

# GFA と OUT はコンテナから見える場所に置く（既定で bind されないなら APPTAINER_BINDPATH などで足す）
plan=$(apptainer exec --cleanenv "$AMIPA_SIF" \
         amipa prep plan --gfa "$GFA" --out "$OUT" --threads "$THREADS" --json ${AMIPA_EXTRA:-})
# 段  スロット数  スロットあたりのメモリ
mapfile -t ROWS < <(printf '%s' "$plan" | apptainer exec --cleanenv "$AMIPA_SIF" python3 -c '
import json, sys
for name, v in json.load(sys.stdin)["stages"].items():
    print(name, v["slots"], str(v["per_slot"]) + "G")')
[ ${#ROWS[@]} -gt 0 ] || { echo "plan から段を読めなかった" >&2; exit 1; }

prev=""
for row in "${ROWS[@]}"; do
  read -r stage slots vmem <<<"$row"
  # qsub の出力は環境によって余分な行が付く。ジョブ ID は 'Your job' の行から取る
  jid=$(qsub -N "amipa_$stage" -pe def_slot "$slots" -l s_vmem="$vmem" \
             ${prev:+-hold_jid $prev} -v AMIPA_SIF,GFA,OUT,AMIPA_EXTRA \
             age-per-stage.sh "$stage" | awk '/Your job/{print $3}')
  [ -n "$jid" ] || { echo "投入に失敗: $stage" >&2; exit 1; }
  echo "$stage ($slots slots, $vmem/slot) -> $jid"
  prev=$jid
done
