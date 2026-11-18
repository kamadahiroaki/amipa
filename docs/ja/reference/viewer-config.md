# 閲覧サーバの設定

[English](../../en/reference/viewer-config.md)

閲覧サーバ（`amipa serve`）は環境変数で設定する。Docker なら `-e 名前=値`、Apptainer なら `--env 名前=値`（または `APPTAINERENV_名前`）で渡す。公開するときの考え方は [サーバとして公開する](../setup/05-serve.md) にある。

## 基本

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `DB_DIR` | `/data`（イメージ） | DB の置き場。この中の `*.db` を一覧に出す |
| `PORT` | `3001` | 待ち受けるポート |
| `SESSION_DIR` | `/tmp/amipa-sessions`（イメージ） | 共有 URL のための状態の保存先。閲覧側の唯一の書き込み先。残したいときは書き込めるボリュームを割り当てる |
| `AMIPA_READONLY` | 無効 | `1`（または `true`）で、ノードの編集の DB への保存だけを禁止する。公開するときは必ず付ける |

## 速さとメモリ

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `AMIPA_PREWARM` | 自動 | 起動時に DB を順に読んでページキャッシュに載せる。未設定（または `auto`）では、DB の置き場がネットワークのファイルシステムのときだけ温める。`<DB 名>,...` でその DB だけ、`off`（`0`・`false`）で無効 |
| `AMIPA_PREWARM_ON_OPEN` | 無効 | `1` で、DB を切り替えたときにも温める |
| `AMIPA_PREWARM_MIN_MBPS` | 300 | 順読みがこの速さ（MB/s）に届かなければやめる |
| `AMIPA_PREWARM_MIN_BYTES` | 4 GiB | これより小さい DB は温めない |
| `AMIPA_TRAV_PREWARM` | `1` | Linear の索引（`.trav`）が大きいとき、開く前に裏で読み流す。`0` で止める |
| `AMIPA_CACHE_MB` | 64（20 GB 以上の DB は 512） | 接続ごとの SQLite のページキャッシュ（MB）。小さなメモリの機械では下げる |
| `AMIPA_DB_WORKERS` | 2 | DB を読むワーカーの数。増やすと並列に読めるが、ワーカーごとにページキャッシュを持つのでメモリを使う |
| `AMIPA_MMAP_BYTES` | 0（無効） | SQLite の mmap の大きさ（バイト） |
| `AMIPA_GZIP_LEVEL` | 1 | 応答の gzip 圧縮のレベル（0 で圧縮しない） |

## 1 要求の上限

重い表示要求 1 本で全体が詰まるのを防ぐ。上限に当たった応答は一部が欠けて返る。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `AMIPA_MAX_ROWS` | 1,000,000 | 1 要求で返す行数の上限（メモリの保護） |
| `AMIPA_FETCH_MS` | 300,000（5 分） | 1 要求の時間の上限（ミリ秒） |
| `AMIPA_TERMINATE_GRACE_MS` | 10,000 | 取り消された要求が返らないとき、ワーカーを作り直すまでの猶予（ミリ秒） |

`deploy/azure/compose.yml` では公開向けに `AMIPA_MAX_ROWS=400000`、`AMIPA_FETCH_MS=20000` を既定にしている。

## 塩基の整列

Linear の塩基の段の整列は、常駐する Python のプロセスで計算する。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `AMIPA_PY_RUNNERS` | 2 | 常駐させる Python の本数。起動時に立ち上げて numpy の読み込みを済ませておく（ネットワークファイルシステム上の Python では読み込みだけで数十秒かかることがある） |
| `AMIPA_MSA_TIMEOUT_MS` | 30,000 | 1 回の整列の時間の上限（ミリ秒） |
| `AMIPA_PYTHON` | `python3`（イメージ） | 使う Python |

## ログ

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `AMIPA_SLOWLOG_MS` | 500 | 応答までにこれ（ミリ秒）を超えた API 要求を 1 行ずつログに出す。0 で出さない |

## 確認用の URL

| URL | 内容 |
|---|---|
| `GET /healthz` | `ok` を返す。DB に触らないので、重い要求で詰まっていても応答する |
| `GET /api/version` | 版の刻印、読み取り専用かどうか（`readonly`）、DB ごとの使える機能 |
| `GET /api/prewarm?db=<名前>` | プリウォームの進み具合 |
