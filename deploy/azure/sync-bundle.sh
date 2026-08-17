#!/bin/bash
# HPC → Azure VM へバンドルを転送する（再開可能）。
#
#   使い方:  sync-bundle.sh <ローカルのバンドル or DB> <user@host> [リモートの置き場]
#   例:      sync-bundle.sh ~/…/wg/mcgrch38.povu.fin.layered.db azureuser@ggb-demo.japaneast.cloudapp.azure.com
#
# ・WG は 250-350GB ある。**必ず qsub（計算ノード）から流す**。ログインノードで数時間流さない。
#   計算ノードから外向き通信はできる（このプロジェクトでの実績あり）。
# ・rsync は再開可能。切れたら**同じコマンドをもう一度**打てば続きから進む。
# ・sqlite の `-journal` / `-wal` は**送らない**（送ると壊れた状態を持ち込む）。
# ・転送後は必ずリモートで `ggb-viewer check` を通すこと（README 参照）。
set -euo pipefail

SRC="${1:?転送元（バンドルのディレクトリ、または *.layered.db）}"
DEST_HOST="${2:?転送先 user@host}"
DEST_DIR="${3:-/data/bundles}"

SRC="$(readlink -f "$SRC")"
SSH_OPTS="-o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o StrictHostKeyChecking=accept-new"

echo "[sync] $SRC"
du -shL "$SRC" 2>/dev/null || true

# 単一 DB を指した場合は、同名のサイドカー（.annot/.hapidx/.nametri/.distill）も一緒に送る。
ITEMS=("$SRC")
if [[ -f "$SRC" ]]; then
  for s in .annot .hapidx .nametri .distill; do
    p="$SRC$s"
    [[ -e "$p" ]] && ITEMS+=("$(readlink -f "$p")")
  done
fi

for it in "${ITEMS[@]}"; do
  echo "[sync] → $(basename "$it")"
  rsync -aP --copy-links --no-owner --no-group \
    --exclude '*-journal' --exclude '*-wal' --exclude '*-shm' \
    --partial --inplace \
    -e "ssh $SSH_OPTS" \
    "$it" "$DEST_HOST:$DEST_DIR/"
done

cat <<EOF

[sync] 完了。リモート側で:
  ls -la $DEST_DIR
  cd /opt/ggb && docker compose run --rm viewer check
EOF
