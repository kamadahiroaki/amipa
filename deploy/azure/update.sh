#!/bin/bash
# 公開インスタンスを新しい viewer イメージへ更新する（VM 上で実行）。
#   /opt/amipa/update.sh [イメージタグ]
#     例: /opt/amipa/update.sh ghcr.io/kamadahiroaki/amipa-viewer:v0.2.0
#   引数を省くと .env の AMIPA_IMAGE をそのまま pull し直す（:edge 運用向け）。
#
# DB は触らないので、更新はイメージの入れ替えだけ。数十秒で戻る。
set -euo pipefail
cd /opt/amipa

if [[ $# -ge 1 ]]; then
  NEW="$1"
  # .env の AMIPA_IMAGE を書き換え（旧値は .env.bak に残す＝戻せるように）
  cp -f .env .env.bak
  if grep -q '^AMIPA_IMAGE=' .env; then
    sed -i "s|^AMIPA_IMAGE=.*|AMIPA_IMAGE=$NEW|" .env
  else
    echo "AMIPA_IMAGE=$NEW" >> .env
  fi
fi

echo "[update] image = $(grep ^AMIPA_IMAGE= .env | cut -d= -f2-)"
docker compose pull
docker compose up -d
docker image prune -f >/dev/null || true

echo "[update] 待機して確認"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/healthz >/dev/null 2>&1 || \
     curl -fsSk https://127.0.0.1/healthz >/dev/null 2>&1; then
    echo "[update] healthz OK"
    docker compose exec -T viewer node -e \
      "fetch('http://127.0.0.1:3001/api/version').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))" || true
    exit 0
  fi
  sleep 2
done

echo "[update] ★健全性確認に失敗。ロールバックする場合:" >&2
echo "  cp -f .env.bak .env && docker compose up -d" >&2
exit 1
