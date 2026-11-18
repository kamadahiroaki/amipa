# Azure に AMIPA を公開する（全ゲノム対応）

大学に付与された Azure 枠で、全ゲノム（HPRC WG）のパンゲノムブラウザをインターネット公開する手順。
コピペで通る形にしてある。所要は VM 作成 15 分＋データ転送（250–350GB）が数時間。

- 構成は VM 1 台。backend が SQLite を直接読むので DB サーバは要らない。
- 更新は `update.sh` でイメージを入れ替えるだけ（DB は触らない）。
- 公開時は `AMIPA_READONLY=1` ＋ DB を `:ro` マウントの二重で書き込みを塞ぐ。

---

## 0. 一番大事なこと：ストレージの選び方

このアプリの負荷は 4KB ランダム読みが支配的で、シーク回数と IOPS がそのまま体感速度になる。

- ❌ Blob Storage / Azure Files / FUSE マウントに DB を置かない。細かいランダム読みの 1 回ごとに
  ネットワークの往復が乗り、桁で遅くなって実用にならない。Blob は配布にだけ使う。
- ✅ マネージドディスク（Premium SSD）に置く。さらに host caching = ReadOnly を付ける
  （読み取り専用 DB なので相性が良く、ローカル NVMe がキャッシュとして効く）。
  host caching を使うにはローカル一時ディスク付きのサイズ（`*ds_v5` / `*ads_v5`）を選ぶこと。
- ✅ RAM はページキャッシュとして効く。DB 全部が載る必要はない（よく触るページだけ残る）。

## 1. サイズの目安

| 公開するもの | データ量 | VM の目安 | データディスク |
|---|---|---|---|
| chrY デモだけ | 0.34GB | B2as_v2 (2vCPU/8GiB) | 32GB |
| chr22 フル | 8.4GB | D2ads_v5 (2vCPU/8GiB) ＝全部 RAM に載る | 64GB |
| WG MC（推奨） | 約 276GB（DB 252.6＋annot 5.4＋distill 17.6） | E8ads_v5 (8vCPU/64GiB) | P30 1TB |
| WG MC ＋ WG PGGB | 約 630GB | E8ads_v5〜E16ads_v5 | P40 2TB |

料金は変動するので [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) で確認する
（目安: 8vCPU/64GiB クラスで月 5〜8 万円、1TB Premium SSD で月 1.5〜2 万円）。付与枠でも予算アラートは必ず設定する（§8）。

## 2. VM を作る

```bash
# 変数（適宜変更）
RG=amipa-rg; LOC=japaneast; VM=amipa-vm; DNS=amipa-demo          # → amipa-demo.japaneast.cloudapp.azure.com
SIZE=Standard_E8ads_v5

az group create -n $RG -l $LOC

az vm create -g $RG -n $VM \
  --image Ubuntu2404 --size $SIZE \
  --admin-username azureuser --ssh-key-values ~/.ssh/id_ed25519.pub \
  --public-ip-address-dns-name $DNS \
  --public-ip-sku Standard \
  --os-disk-size-gb 64 \
  --custom-data cloud-init.yaml

# データディスク（Premium SSD, host caching = ReadOnly）
az disk create -g $RG -n amipa-data --size-gb 1024 --sku Premium_LRS
az vm disk attach -g $RG --vm-name $VM --name amipa-data --caching ReadOnly

# 公開ポートは 80/443 のみ。SSH は自分の IP だけに絞る
az vm open-port -g $RG -n $VM --port 80  --priority 1001
az vm open-port -g $RG -n $VM --port 443 --priority 1002
MYIP=$(curl -s https://api.ipify.org)
az network nsg rule update -g $RG --nsg-name ${VM}NSG -n default-allow-ssh --source-address-prefixes $MYIP
```

`cloud-init.yaml` が Docker の導入とデータディスクの `/data` マウントまでやる
（既にファイルシステムがあれば mkfs しない＝DB を消さない）。

## 2.5 カスタムデータが使えなかったとき

ポータルの「カスタムデータ」に `cloud-init.yaml` を貼ると検証で弾かれることがある。
その場合は VM を素のまま作り、あとから同じ内容を流す。

```bash
scp deploy/azure/setup.sh azureuser@<host>:
ssh azureuser@<host> 'sudo bash setup.sh'
```

`cloud-init.yaml` と中身は同じ（Docker / `/data` のマウント / systemd unit）。
既にファイルシステムがあれば `mkfs` しないので、動いている VM に流しても安全。

## 3. 設定ファイルを置く

```bash
HOST=azureuser@${DNS}.${LOC}.cloudapp.azure.com
ssh $HOST 'sudo mkdir -p /opt/amipa && sudo chown azureuser /opt/amipa'
scp compose.yml Caddyfile update.sh $HOST:/opt/amipa/
ssh $HOST 'chmod +x /opt/amipa/update.sh'

# .env を作る
ssh $HOST 'cat > /opt/amipa/.env' <<EOF
AMIPA_IMAGE=ghcr.io/kamadahiroaki/amipa-viewer:0.1
AMIPA_DOMAIN=${DNS}.${LOC}.cloudapp.azure.com
AMIPA_ACME_EMAIL=you@example.ac.jp
AMIPA_DATA=/data/bundles
AMIPA_CACHE_MB=512
AMIPA_DB_WORKERS=4
EOF
```

### イメージの置き場（レジストリ）の選択

VM が pull できる場所に OCI イメージ（HPC で焼いた SIF ではない）が要る。選択肢は 3 つ:

| 置き場 | 費用 | 向き |
|---|---|---|
| GHCR（リポジトリを public に） | 無料。public パッケージは容量・転送とも課金対象外。Actions も public リポは無制限 | 推奨。引用戦略(§8.4 の公開リポ＋DOI)とも揃う |
| GHCR（private リポ） | GitHub Free の private パッケージ枠は 500MB / 転送 1GB[月] ＝イメージ 1 個(約400MB)で埋まる。※GitHub は「Container registry の容量と帯域は当面無料（変更時は 1 か月前に告知）」とも書いており扱いが曖昧 | 常用は勧めない |
| Azure Container Registry (ACR) Basic | 約 $0.167/日（月 ¥800 前後）・10GB 込み。付与枠から払える | リポジトリを private のままにしたい場合。VM と同一リージョンなので pull も速い |
| レジストリを使わない | 0 円 | VM 上で `git clone && docker build`、または `docker save` の tar を転送。CI で検査済みのイメージを配る利点は失う |

ACR を使う場合:
```bash
az acr create -g $RG -n amipareg --sku Basic
az acr login -n amipareg
docker tag amipa-viewer:dev amipareg.azurecr.io/amipa-viewer:0.1 && docker push amipareg.azurecr.io/amipa-viewer:0.1
az aks/vm ...   # VM からは: az acr login -n amipareg（マネージド ID を付けるとパスワード不要）
```
private な GHCR を使う場合は VM で 1 回だけ
`echo $GITHUB_TOKEN | docker login ghcr.io -u <user> --password-stdin`。

## 4. データを送る（ここが一番時間がかかる）

`sync-bundle.sh` で送る。rsync なので切れても同じコマンドで続きから送れる。全ゲノムは数時間かかるので、
手元の端末ではなく、切れても困らない場所（ジョブスケジューラのジョブ、`tmux` の中など）から流す。

```bash
# DB のディレクトリ（amipa prep の --out）ごと送る。work/ は送らない
deploy/azure/sync-bundle.sh /path/to/graph.amipa azureuser@<公開ホスト名> /data/bundles
# 鍵が既定の名前でなければ SSH_KEY=~/.ssh/<鍵> を前に付ける
```

- DB 本体（`*.db`）を指定した場合は、同名のサイドカー（`<db>.*` のファイルと `.distill/`）と `reads/` も一緒に送る。
- `-journal` / `-wal` / `-shm` は送らない（壊れた状態を持ち込まないため。スクリプトで除外済み）。
- 転送レートが 30MB/s なら 276GB で約 2.6 時間、100MB/s なら約 45 分。
- 送り終えたらリモートで名前を分かりやすく変えてよい（例 `mc-grch38-wg.db`）。
  サイドカーも同じ名前に揃えて改名する（`<db>.tiled` のように名前で対応づけるため）。

## 5. 起動して確認する

```bash
ssh $HOST
cd /opt/amipa
docker compose run --rm viewer check          # ← まずこれ。DB とサイドカーの点検（全走査しないので一瞬）
sudo systemctl enable --now amipa             # compose up -d を systemd 管理で
curl -s localhost/healthz                     # → ok
curl -s https://$AMIPA_DOMAIN/api/version
```

`check` が `RESULT: OK` を返さないうちは公開しない。よくある指摘:
- `空間索引（.tiled サイドカー）が無い` → 開けない。転送漏れか、サイドカーの改名漏れ
- `.distill が無い/不完全` → Linear の塩基の段が出ない。転送漏れ

API の総点検も回せる（リポジトリの `tests/run.sh api`。手元から公開先に向けて流す）:
```bash
tests/run.sh api mc-grch38-wg.db <公開ホスト名>:443   # https 経由
```
初回は cold なので遅い。これはウォームアップも兼ねる。

## 6. ウォームアップの方針（WG では特に重要）

- `AMIPA_PREWARM` は未設定（空）のままでよい。既定では DB の置き場がネットワークのファイルシステムの
  ときだけ温めるので、マネージドディスクでは温めない。WG（253GB）を順読みしても RAM(64GiB) には載りきらず、
  その間ディスク帯域を食って利用者の操作が遅くなるので、明示的に温めることもしない。
- 代わりに 代表的なビューポートを何回か叩いて温める（`tests/run.sh api` か、よく見る領域の URL を curl）。
  よく触るページだけがページキャッシュに残る。
- chr22（8.4GB）は RAM に載るので `AMIPA_PREWARM=chr22.db` を付けてよい。

## 7. 更新のしかた

```bash
ssh $HOST /opt/amipa/update.sh ghcr.io/kamadahiroaki/amipa-viewer:0.2.0
```
`pull` → `up -d` → `/healthz` 確認まで自動。失敗したら `.env.bak` に旧タグが残っているので
`cp -f .env.bak .env && docker compose up -d` で戻せる。DB は無関係なので触らない。

DB を差し替えるとき（新しい前処理で作り直したとき）:
1. 新しい名前で `/data/bundles` に転送（旧 DB は残したまま）
2. `docker compose run --rm viewer check <新DB>` で点検
3. 問題なければ利用者に新しい DB 名を案内、または旧 DB を削除
   古いサイドカーを残さない（名前で対応づけるので、別の DB に付くと黙って壊れる）

## 8. 監視・費用の見張り

```bash
# 予算アラート（付与枠でも必ず）
az consumption budget create --budget-name amipa-monthly --amount 300 --time-grain Monthly \
  --category Cost --resource-group $RG --start-date $(date +%Y-%m-01)
```
- 死活: `GET /healthz`（DB に触らないので、重いクエリで詰まっていても応答する）
- ログ: Caddy のアクセスログ `/data/access.log`（引用・利用実績の証跡になる）＋`docker compose logs`
- 止めるとき: `az vm deallocate -g $RG -n $VM`（VM 課金は止まる。ディスク課金は続く）
- 完全に消す: `az group delete -n $RG`（DB も消えるので注意）

## 9. 公開前チェックリスト

- [ ] `AMIPA_READONLY=1` が効いている（`curl -X POST https://.../api/save_edits` が 403）
- [ ] DB が `:ro` でマウントされている
- [ ] SSH が自分の IP に絞られている
- [ ] `check` が RESULT: OK
- [ ] `tests/run.sh api` が全項目 OK
- [ ] 予算アラートを設定した
- [ ] `/api/version` が正しいタグを返す（版の刻印＝図版・報告に載る）
- [ ] 同時に数人が触ったときの応答を実測した（better-sqlite3 は同期なので重いクエリで詰まりうる）

## 10. 既知の弱点

- 同時実行に弱い: 1 本の重いクエリがイベントループを塞ぐ。`AMIPA_DB_WORKERS` を増やすと
  並列に読めるが、worker ごとにページキャッシュを持つのでメモリを食う。公開規模が読めない間は
  Cloudflare 無料プランを前段に置くのが安上がり（Caddyfile 末尾のコメント参照）。
- cold な初回アクセス: WG では 1 ビューポートあたり数百のランダム読みが起きうる。
  host caching(ReadOnly) と RAM で緩和する。
- DB の差し替えはダウンタイム無しではできない（同名で上書きすると開いている接続が壊れる）。
  必ず別名で置いてから切り替える。
