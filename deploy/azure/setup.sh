#!/bin/bash
# 作成済みの Azure VM を AMIPA の配信ノードに仕立てる。SSH で入って 1 回だけ実行する。
#
#   scp deploy/azure/setup.sh azureuser@<host>:
#   ssh azureuser@<host> 'sudo bash setup.sh'
#
# cloud-init.yaml と中身は同じ。ポータルのカスタムデータが通らないとき、
# あるいは既に動いている VM に後から適用するときはこちらを使う。
#
# やること: Docker を入れる / データディスクを /data にマウントする / systemd unit を置く。
# compose.yml・Caddyfile・.env は別途 /opt/amipa へ置く（README 参照）。
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "sudo で実行すること" >&2; exit 1; }

ADMIN=${ADMIN:-azureuser}     # docker グループに入れるユーザー
DEV=${DEV:-/dev/disk/azure/scsi1/lun0}

echo "===== 1/4 パッケージ ====="
apt-get update
apt-get install -y ca-certificates curl gnupg rsync jq

echo "===== 2/4 Docker ====="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker "$ADMIN" || echo "警告: ユーザー $ADMIN が居ない。ADMIN=<名前> を指定して再実行するか、後で手で追加する"

echo "===== 3/4 データディスクを /data へ ====="
# ★既にファイルシステムがあれば絶対に mkfs しない（アトラスを消さないため）。
for _ in {1..30}; do [[ -e $DEV ]] && break; sleep 2; done
if [[ ! -e $DEV ]]; then
  echo "FATAL: データディスクが見つからない: $DEV" >&2
  echo "  lsblk で実際のデバイスを確認し、DEV=/dev/sdX bash setup.sh のように指定する" >&2
  lsblk >&2
  exit 1
fi
if ! blkid "$DEV" >/dev/null 2>&1 && ! blkid "${DEV}1" >/dev/null 2>&1; then
  echo "  初回なのでフォーマットする: $DEV"
  mkfs.ext4 -L amipadata -m 0 "$DEV"      # -m 0 = root 予約なし（5% ≒ 16GiB を無駄にしない）
else
  echo "  既存のファイルシステムを検出。フォーマットしない"
fi
TARGET="$DEV"; blkid "${DEV}1" >/dev/null 2>&1 && TARGET="${DEV}1"
mkdir -p /data
grep -q ' /data ' /etc/fstab || \
  echo "$(blkid -o export "$TARGET" | grep ^UUID=) /data ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
mount -a
mkdir -p /data/bundles
chmod 0755 /data /data/bundles

echo "===== 4/4 systemd unit ====="
cat > /etc/systemd/system/amipa.service <<'UNIT'
[Unit]
Description=amipa viewer (docker compose)
Requires=docker.service
After=docker.service data.mount
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/amipa
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /opt/amipa
systemctl daemon-reload

echo
echo "===== 完了。確認 ====="
df -h /data
docker --version
docker compose version
echo
echo "次にやること:"
echo "  1. /opt/amipa に compose.yml / Caddyfile / .env を置く"
echo "  2. /data/bundles にアトラスを転送する"
echo "  3. sudo systemctl enable --now amipa    ← これを忘れると再起動で上がってこない"
echo "  4. 一度ログインし直す（docker グループの反映に要る）"
