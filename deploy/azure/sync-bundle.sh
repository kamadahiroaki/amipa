#!/bin/bash
# アトラスを配信先のマシンへ転送する（再開可能）。
#
#   使い方:  sync-bundle.sh <アトラスのディレクトリ or DB> <user@host> [置き場]
#   例:      sync-bundle.sh ~/atlases/mc-grch38-wg.amipa azureuser@<公開ホスト名>
#
# ・全ゲノムは 250-350GB ある。**ジョブスケジューラ経由で流す**。
#   ログインノードや手元の端末で数時間流さない（切れると最初からになる環境がある）。
# ・rsync なので再開できる。切れたら同じコマンドをもう一度打つ。
# ・sqlite の -journal / -wal / -shm は送らない（壊れた状態を持ち込むため）。
# ・work/ は送らない（中間生成物。配信には要らず、数 GB ある）。
# ・転送後は必ず配信先で `amipa check` を通すこと。
#
# 圧縮について: アトラスは zstd -3 でおよそ 2.2 倍に縮む。rsync 3.1 系の -z は zlib で
#   1 コア 50-100MB/s 程度しか出ないため、速い回線では -z が足を引っ張る。
#   実効 50MB/s を下回るときだけ RSYNC_Z=1 を付ける（下記）。
set -euo pipefail

SRC="${1:?転送元（アトラスのディレクトリ、または *.db）}"
DEST_HOST="${2:?転送先 user@host}"
DEST_DIR="${3:-/data/bundles}"

SRC="$(readlink -f "$SRC")"
SSH_OPTS="-o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o StrictHostKeyChecking=accept-new"
Z=(); [[ ${RSYNC_Z:-0} == 1 ]] && Z=(-z)

# ★--append-verify: 送信元は不変なので、既に届いている先頭を検証して続きだけ送る。
#   --inplace の差分アルゴリズムは 200GB 級だと両側を丸ごと読み直すことになり、
#   再開のたびに時間がかかる。
COMMON=(-a --copy-links --no-owner --no-group --info=progress2
        --partial --append-verify "${Z[@]}"
        --exclude '*-journal' --exclude '*-wal' --exclude '*-shm'
        -e "ssh $SSH_OPTS")

echo "[sync] $SRC"
# ★除外後の量を出す（work/ を含めた値を出すと「思ったより多い」と混乱するため）
du -shL --apparent-size --exclude=work "$SRC" 2>/dev/null | sed 's/^/[sync] 送る量 /' || true

if [[ -d "$SRC" ]]; then
  # アトラスのディレクトリごと。work/ は配信に不要なので落とす。
  echo "[sync] ディレクトリごと転送（work/ は除外）"
  rsync "${COMMON[@]}" --exclude 'work/' "$SRC" "$DEST_HOST:$DEST_DIR/"
else
  # 単一 DB を指した場合は、同名のサイドカーも一緒に送る。
  # ★.reads を落とすとリード表示だけが黙って消える（以前ここが抜けていた）。
  ITEMS=("$SRC")
  for s in .annot .reads .hapidx .nametri .distill; do
    p="$SRC$s"
    [[ -e "$p" ]] && ITEMS+=("$(readlink -f "$p")")
  done
  # リードの実体は索引から相対で探すので、同じ階層の reads/ も要る
  rd="$(dirname "$SRC")/reads"
  [[ -d "$rd" ]] && ITEMS+=("$rd")
  for it in "${ITEMS[@]}"; do
    echo "[sync] → $(basename "$it")"
    rsync "${COMMON[@]}" "$it" "$DEST_HOST:$DEST_DIR/"
  done
fi

cat <<EOF

[sync] 完了。配信先で中身を確かめる:
  ssh $DEST_HOST 'ls -la $DEST_DIR; df -h /data'
  ssh $DEST_HOST 'cd /opt/amipa && docker compose run --rm viewer check'
EOF
