# サーバとして公開する

[English](../../en/setup/05-serve.md)

DB を手元で開く方法と、研究室のサーバやクラウドで公開するときの設定。閲覧側は SQLite のファイルを直接読むので、データベースサーバは要らない。

## 手元で開く

```bash
docker run --rm -p 3001:3001 -v /path/to/graph.amipa:/data:ro ghcr.io/kamadahiroaki/amipa-viewer serve
# → http://localhost:3001
```

- 開けるポートは 1 つだけ（画面も API も同じプロセスが配る）。
- DB は読み取り専用でマウントしてよい。
- 複数の DB を見せたいときは、それらを含む親ディレクトリを `/data` に渡す。画面上部の左の選択欄で切り替える。

Apptainer なら次のとおり（`DB_DIR=/data`、`PORT=3001` がイメージの既定）。

```bash
apptainer exec --cleanenv -B /path/to/graph.amipa:/data:ro amipa-viewer.sif amipa serve
```

確かめ方:

```bash
curl -s localhost:3001/healthz        # → ok
curl -s localhost:3001/api/version    # 版の刻印と、読み取り専用かどうか
```

`/healthz` は DB に触らないので、重い要求で詰まっていても応答する。

## 公開するときの設定

公開するインスタンスでは、少なくとも次の 3 つを守る。設定の一覧は [閲覧サーバの設定](../reference/viewer-config.md) にある。

1. `AMIPA_READONLY=1` で起動し、DB を `:ro` でマウントする（二重の守り）。
2. DB はブロックストレージ（ローカルディスク）に置く。
3. 重い要求の上限（`AMIPA_MAX_ROWS`・`AMIPA_FETCH_MS`）と、前段のレート制限を決める。

### 編集を保存させない（`AMIPA_READONLY=1`）

画面にはノードを動かす編集モードがあり、その結果を DB に保存できる。`AMIPA_READONLY=1` で起動すると、この保存だけが塞がれる。

- 画面は起動時に `/api/version` の `readonly` を見て、Edit の Save を最初から押せない表示にする。
- 編集モード自体は使える。ノードを動かして繋がりを確かめる使い方はそのまま通り、結果が DB に残らないだけになる。動かした状態は共有 URL には載る。
- サーバ側でも `POST /api/save_edits` を 403 で断るので、画面を細工しても保存はできない。
- DB を `:ro` でマウントしておけば二重の守りになる。

大きなグラフでは、編集の反映（子孫のノードと関連する辺を全層で更新する）に現実的でない時間がかかることがある。公開インスタンスでは常に付ける。

共有 URL のための状態の保存先 `SESSION_DIR` だけは書き込める場所にする（閲覧側の唯一の書き込み先）。

### ディスクとメモリ

閲覧時のアクセスは細かいランダム読みが中心で、シーク回数と IOPS がそのまま体感の速さになる。

- DB はローカルディスク（クラウドならマネージドディスクの SSD）に置く。オブジェクトストレージ（Blob など）、ネットワークファイルシステム、FUSE のマウントに置くと桁で遅くなり、実用にならない。オブジェクトストレージは配布にだけ使う。
- メモリはページキャッシュとして効く。DB 全体が載らなくても、よく見られる範囲が残る。
- 初回の表示が遅いときの原因は、ほぼディスクのランダム読みにある。

### 起動時のプリウォーム

起動直後、まだ誰も見ていないうちに DB を先頭から順に読んで、OS のページキャッシュに載せておく機能。ネットワークファイルシステムでは、散ったページを 1 枚ずつ引くより全部を順に読む方が桁で安い（開発に使った共有ファイルシステムでは、全ゲノム 230 GB を 88 秒で読み切れた）。

- 既定（`AMIPA_PREWARM` 未設定）では、DB の置き場がネットワークのファイルシステム（Lustre・NFS・GPFS・CIFS・FUSE など）のときだけ温める。ローカルのディスクでは温めない。
- `AMIPA_PREWARM=<DB 名,...>` でその DB だけを温める。`off` で無効。
- 本体だけでなくサイドカー（`.tiled`・`.reads`・`.annot`）も読む。
- 4 GiB 未満の DB は対象外（放っておいても温まる）。
- 順読みの速さが `AMIPA_PREWARM_MIN_MBPS`（既定 300 MB/s）に届かなければ途中でやめる。
- 進み具合は `GET /api/prewarm?db=<名前>` で見られる。
- `AMIPA_PREWARM_ON_OPEN=1` で、DB を切り替えたときにも温める。既定で無効なのは、利用者が見たい瞬間に順読みを始めると最初の表示と競合してかえって遅くなるため。

メモリに載りきらない大きな DB をローカルディスクに置くときは温めない方がよい。順読みの間ディスクの帯域を食い、利用者の操作が遅くなる。代わりに、よく見る領域を何回か開いておく。

### 同時アクセス

重い表示要求が 1 本入ると、他の応答が待たされる構造になっている。

- `AMIPA_DB_WORKERS`（DB を読む並列数）を増やすと並列に読めるが、ワーカーごとにページキャッシュを持つのでメモリを使う。
- `AMIPA_MAX_ROWS`・`AMIPA_FETCH_MS` で 1 要求の上限を決める。上限に当たった表示は一部が欠けて返る。
- 公開規模が読めない間は、CDN やリバースプロキシのレート制限を前段に置く。

## Azure に置く

単一の VM で足りる。構成は次のとおり。

```
[ブラウザ] ──HTTPS──▶ [リバースプロキシ（TLS）] ──▶ [amipa-viewer コンテナ]
                                                    └─ DB（ローカルディスク、読み取り専用）
```

手順の一式（VM の作成 → データの転送 → 起動 → 更新 → 監視 → 公開前の確認）と設定ファイル（`compose.yml`・`Caddyfile`・`cloud-init.yaml`・`setup.sh`・`update.sh`・`sync-bundle.sh`）は [deploy/azure/](../../../deploy/azure/) にある。他のクラウドでも考え方は同じ。

### ディスクと VM の選び方

- DB はマネージドディスク（Premium SSD）に置き、host caching を ReadOnly にする。読み取り専用の DB なので相性がよく、VM のローカル NVMe がキャッシュとして効く。host caching を使うには、ローカルの一時ディスク付きのサイズ（`*ds_v5`・`*ads_v5`）を選ぶ。
- Blob Storage・Azure Files・FUSE のマウントに DB を置かない。

| 公開するもの | データ量 | VM の目安 | データディスク |
|---|---|---|---|
| chrY | 0.34 GB | B2as_v2（2 vCPU / 8 GiB） | 32 GB |
| 染色体 1 本（chr22） | 8.4 GB | D2ads_v5（2 vCPU / 8 GiB、全部が RAM に載る） | 64 GB |
| 全ゲノム 1 つ（HPRC Minigraph-Cactus） | 約 276 GB | E8ads_v5（8 vCPU / 64 GiB） | P30（1 TB） |
| 全ゲノム 2 つ | 約 630 GB | E8ads_v5〜E16ads_v5 | P40（2 TB） |

料金は変わるので Azure Pricing Calculator で確かめ、予算アラートを必ず設定する。

### 流れ

1. VM を作る（`az vm create`、データディスクを `--caching ReadOnly` で付ける）。公開するポートは 80 と 443 だけにし、SSH は自分の IP に絞る。
2. `cloud-init.yaml`（または VM を作った後で `setup.sh`）が Docker の導入とデータディスクの `/data` へのマウントをする。既にファイルシステムがあれば作り直さない（DB を消さない）。
3. `/opt/amipa/` に `compose.yml`・`Caddyfile`・`update.sh` と `.env`（イメージのタグ、ドメイン、証明書用のメールアドレス、DB の置き場）を置く。
4. `sync-bundle.sh <DB のディレクトリ> <user@host>` で DB を送る。rsync なので切れても同じコマンドで続きから送れる。`-journal`・`-wal`・`work/` は送らない。全ゲノムは数時間かかるので、切れても困らない場所（ジョブスケジューラのジョブなど）から流す。
5. 起動前に点検し、通ってから公開する。

```bash
docker compose run --rm viewer check          # RESULT: OK になるまで公開しない
sudo systemctl enable --now amipa
curl -s localhost/healthz                     # → ok
```

DB の名前を変えるときは、サイドカーも同じ名前に揃えて変える（`<db>.tiled` のように名前で対応づけるため）。API を一通り確かめるには、リポジトリの `tests/run.sh api <DB 名> <host:port>` を使う。初回はキャッシュが冷えているので遅い。これは温める役も兼ねる。

### 更新

イメージのタグを上げるだけで、DB には触らない。

```bash
ssh <host> /opt/amipa/update.sh ghcr.io/kamadahiroaki/amipa-viewer:0.2.0
```

`pull` → 起動 → `/healthz` の確認まで自動で行う。失敗したら `.env.bak` に旧タグが残っているので、`cp -f .env.bak .env && docker compose up -d` で戻せる。

DB を差し替えるときは、同じ名前で上書きしない（開いている接続が壊れる）。新しい名前で置いて `check` を通し、利用者を新しい DB に案内してから旧 DB を消す。古いサイドカーを残さない。

### 公開前の確認

- `AMIPA_READONLY=1` が効いている（`curl -X POST https://<host>/api/save_edits` が 403）
- DB が `:ro` でマウントされている
- SSH が自分の IP に絞られている
- `check` が `RESULT: OK`
- 予算アラートを設定した
- `/api/version` が正しいタグを返す（図に載る版の刻印になる）
- 数人が同時に触ったときの応答を確かめた

死活の監視には `GET /healthz` を使う。止めるときは `az vm deallocate`（VM の課金は止まり、ディスクの課金は続く）、全部消すときは `az group delete`（DB も消える）。
