#!/bin/bash
# 段別ジョブを依存で繋いで投入する（AGE/SGE の例）。資源は `amipa prep plan` の出力から。
#   AMIPA_SIF=... GFA=... OUT=... ./age-submit.sh
set -euo pipefail
: "${AMIPA_SIF:?}" "${GFA:?}" "${OUT:?}"
export AMIPA_SIF GFA OUT

#           段         slots  s_vmem(/スロット)
STAGES=(  "distill    1      67G"
          "decompose  8      21G"
          "lod        1      149G"
          "layout     24     4G"
          "emit       1      178G"
          "annot      1      91G"
          "bundle     1      8G" )

prev=""
for row in "${STAGES[@]}"; do
  read -r stage slots vmem <<<"$row"
  # ★qsub の出力は環境によって余分な行が付く。ジョブ ID は 'Your job' の行から取る
  jid=$(qsub -N "amipa_$stage" -pe def_slot "$slots" -l s_vmem="$vmem" \
             ${prev:+-hold_jid $prev} -v AMIPA_SIF,GFA,OUT,AMIPA_EXTRA \
             age-per-stage.sh "$stage" | awk '/Your job/{print $3}')
  [ -n "$jid" ] || { echo "投入に失敗: $stage" >&2; exit 1; }
  echo "$stage -> $jid"
  prev=$jid
done
