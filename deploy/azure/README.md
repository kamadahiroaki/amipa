# Azure に AMIPA を公開する（全ゲノム対応）

大学に付与された Azure 枠で、全ゲノム（HPRC WG）のパンゲノムブラウザをインターネット公開する手順。
コピペで通る形にしてある。所要は VM 作成 15 分＋データ転送（250–350GB）が数時間。

- 構成は VM 1 台。backend が SQLite を直接読むので DB サーバは要らない。
- 更新は `update.sh` でイメージを入れ替えるだけ（DB は触らない）。
- 公開時は `AMIPA_READONLY=1` ＋ DB を `:ro` マウントの二重で書き込みを塞ぐ。

---

## 0. 一番大事なこと：ストレージの選び方

このアプリの負荷は 4KB ランダム読みが支配的で、シーク回数と IOPS がそのまま体感速度になる。

- ❌ Blob Storage / Azure Files / FUSE マウントに DB を置かない。確実に破綻する
  （社内 Lustre で実測した「1 回 13.8ms・全ページ読み 0.46MB/s」と同じ罠）。Blob は配布にだけ使う。
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

> 枠を節約したい場合は「層を削った WG デモ DB（L0–L13, 推定 26GB）」という選択肢もある
> （`functions/deploy/PLAN.md` §6.3）。枠に余裕があるならフル深度をそのまま出すのが当然よい。

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

計算ノードから qsub で流す（ログインノードで数時間流さない）。rsync なので切れても再開できる。

```bash
# HPC 側。ジョブスクリプトの例（scripts/ に置いて qsub）
#$ -S /bin/bash
#$ -cwd -j y -l s_vmem=4G -pe def_slot 1 -l ljob      # ★2日を超える見込みなら ljob
<リポジトリ> \
  <リポジトリ> \
  azureuser@<公開ホスト名> /data/bundles
```

- DB を指定すると 同名のサイドカー（.annot / .hapidx / .nametri / .distill）も一緒に送る。
- `-journal` / `-wal` は送らない（壊れた状態を持ち込まないため。スクリプトで除外済み）。
- 転送レートが 30MB/s なら 276GB で約 2.6 時間、100MB/s なら約 45 分。
- 送り終えたらリモートで名前を分かりやすく変えてよい（例 `mc-grch38-wg.db`）。
  ★サイドカーも同じ名前に揃えて改名する（`<db>.annot` の規約で引くため）。

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
- `.distill が無い/不完全` → MSA パネルが出ない。転送漏れ
- `hapidx が見つからない` → hap 絞り込みが効かない。サイドカーの改名漏れ

API の総点検（35 endpoint）も回せる。HPC 側の `functions/reemit2/verify_api.sh` を使う:
```bash
./verify_api.sh mc-grch38-wg.db <公開ホスト名>:443   # https 経由
```
初回は cold なので遅い。これはウォームアップも兼ねる。

## 6. ウォームアップの方針（WG では特に重要）

- `AMIPA_PREWARM` は WG では `off` にする（★空文字は「無効」ではなく「既定＝全部温める」になる）。253GB を順読みしても RAM(64GiB) には載りきらず、
  その間ディスク帯域を食って利用者の操作が遅くなる。
- 代わりに 代表的なビューポートを何回か叩いて温める（`verify_api.sh` か、よく見る領域の URL を curl）。
  よく触るページだけがページキャッシュに残る。
- chr22（8.4GB）は RAM に載るので `AMIPA_PREWARM=chr22.db` を付けてよい。

## 7. 更新のしかた

```bash
ssh $HOST /opt/amipa/update.sh ghcr.io/kamadahiroaki/amipa-viewer:v0.2.0
```
`pull` → `up -d` → `/healthz` 確認まで自動。失敗したら `.env.bak` に旧タグが残っているので
`cp -f .env.bak .env && docker compose up -d` で戻せる。DB は無関係なので触らない。

DB を差し替えるとき（新しい前処理で作り直したとき）:
1. 新しい名前で `/data/bundles` に転送（旧 DB は残したまま）
2. `docker compose run --rm viewer check <新DB>` で点検
3. 問題なければ利用者に新しい DB 名を案内、または旧 DB を削除
   ★古いサイドカーを残さない（`.hapidx` は rowid 鍵なので、別の DB に付くと壊れる）

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
- [ ] `verify_api.sh` が 35/35
- [ ] 予算アラートを設定した
- [ ] `/api/version` が正しいタグを返す（版の刻印＝図版・報告に載る）
- [ ] 同時に数人が触ったときの応答を実測した（better-sqlite3 は同期なので重いクエリで詰まりうる）

## 10. 既知の弱点

- 同時実行に弱い: 1 本の重いクエリがイベントループを塞ぐ。`AMIPA_DB_WORKERS` を増やすと
  並列に読めるが、worker ごとにページキャッシュを持つのでメモリを食う。公開規模が読めない間は
  Cloudflare 無料プランを前段に置くのが安上がり（Caddyfile 末尾のコメント参照）。
- cold な初回アクセス: WG では 1 ビューポートあたり数百のランダム読みが起きうる。
  host caching(ReadOnly) と RAM で緩和する。それでも遅ければ「層を削ったデモ DB」を検討する。
- DB の差し替えはダウンタイム無しではできない（同名で上書きすると開いている接続が壊れる）。
  必ず別名で置いてから切り替える。
