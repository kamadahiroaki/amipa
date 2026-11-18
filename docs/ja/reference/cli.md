# コマンドと選択肢

[English](../../en/reference/cli.md)

`amipa` コマンドと `amipa prep` の各サブコマンドの選択肢の一覧。`amipa prep <サブコマンド> --help` の内容を整理したもの。使い方の流れは [自分のデータを準備する](../setup/03-your-data.md) と [大きなグラフ](../setup/04-large-graphs.md) にある。

## amipa（コンテナの入口）

どちらのイメージでも、入口は `amipa` コマンド。Docker では `docker run ... <イメージ> <サブコマンド>`、Apptainer では `apptainer exec --cleanenv ... <sif> amipa <サブコマンド>` の形で呼ぶ。

| サブコマンド | イメージ | 内容 |
|---|---|---|
| `amipa prep ...` | amipa-prep | 前処理（GFA → DB）。下記 |
| `amipa serve` | amipa-viewer | 閲覧サーバを起動する（viewer イメージの既定）。設定は [閲覧サーバの設定](viewer-config.md) |
| `amipa check [DB]` | amipa-viewer | DB の点検。引数が無ければ `DB_DIR` の全 DB、あればその DB（名前か、`/` を含むパス）。全体を読み通さないので大きな DB でも数秒。問題が無ければ `RESULT: OK` で終了コード 0、あれば `RESULT: FAIL` で 1 |
| `amipa version` | 両方 | 版の刻印（`version`・`commit`・`runtime`）を JSON で出す |
| `amipa licenses` | 両方 | 同梱物の一覧（NOTICE）と AMIPA 本体のライセンス全文を出す |
| `amipa help` | 両方 | サブコマンドの一覧 |

コンテナを使わないときは `amipa prep` の代わりに `python3 prep/amipa_prep/cli.py` を呼ぶ（引数は同じ）。

## amipa prep のサブコマンド

| サブコマンド | 内容 | 走る段 |
|---|---|---|
| `run` | GFA から DB を作る。終わった段は飛ばす | 全段（`--from`・`--only` で一部） |
| `status --out DIR` | 段ごとの状態・秒数・終了時刻・最大メモリを表示する | — |
| `plan` | 段ごとのスロット数・メモリ・時間の目安を出す。何も書き込まない。`--gfa` が必須。`--json` で JSON（標準出力は JSON だけ、ログは標準エラー） | — |
| `add-annot` | 既存の DB に `--band`・`--gene`・`--region` を足す（どれか 1 つは必須） | annot, bundle |
| `add-reads` | 既存の DB にリードを足す（`--reads` 必須）。線の太さに使うので、タイル索引も作り直す | reads, tiled, bundle |
| `add-read-labels` | リードにラベルを付ける（`--read-labels` 必須）。整列は作り直さない | rlabel, bundle |
| `add-tiled` | 描画用のタイル索引を作り直す（本体は作り直さない） | tiled, bundle |

`status` 以外のサブコマンドは同じ選択肢の組を受け取る。サブコマンドが走らせる段に関係しない選択肢は効かない。段の中身は [前処理の各段](pipeline.md) にある。

## 選択肢

### 入力と出力

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--out DIR` | （必須） | 出力のディレクトリ（DB 一式）。既存のものを渡すと続きから |
| `--gfa FILE` | — | 入力の GFA（`.gz`・`.zst` 可）。最初の `run` と `plan` で要る |
| `--name NAME` | GFA のファイル名、または既存の DB の名前 | DB の本体の名前（`<NAME>.db`） |
| `--ref-key SAMPLE` | 自動 | 参照にするパスのサンプル。自動のときは GFA ヘッダの `RS:Z`（複数なら GRCh38、CHM13 の順）→ `GRCh38` → `CHM13` → 先頭のパス。大小は区別しない（[参照の決まり方](../setup/03-your-data.md#参照の決まり方)） |
| `--collapse` | off | 自明なバブルの連鎖（SNP のような 1 塩基の分岐の連なり）を 1 ノードに畳んでから DB を作る。元に戻せる形で記録し、差分と元のノードとの対応は `<db>.collapse` に入る。ノードが 4〜6 倍減る。整数でないセグメント id のグラフでは使えない |

### 注釈

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--gff-dir DIR` | — | 株ごとの GFF の置き場。ファイル名は `<サンプル>.{gff,gff3,gtf}[.gz,.zst]`。`<db>.genes` などを作る（Linear の遺伝子） |
| `--band FILE` | — | 染色体バンド（UCSC の cytoBand 形式、参照の座標） |
| `--gene FILE` | — | 参照の遺伝子（GTF・GFF3、参照の座標。gene 行が要る） |
| `--gene-ref-path SAMPLE` | 参照 | `--gene` を写すときにたどるパスのサンプル |
| `--region FILE` | — | 領域の BED（セントロメアなど） |
| `--region-ref SAMPLE` | `chm13` | `--region` の座標のサンプル |
| `--ann-rmsk FILE` | — | RepeatMasker の表（UCSC の `rmsk.txt`、参照の座標）。`<db>.ann` に入る |
| `--ann-vcf SAMPLE=VCF` | — | サンプルの変異（参照の座標）。複数可 |
| `--ann-bed SAMPLE=BED` | — | サンプルのベンチマーク領域（この外の変異は判定されていない）。複数可 |

### リード

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--reads SAMPLE=GAF` | — | リードの整列。複数可 |
| `--reads-append` | off | `add-reads` で、既存の索引にサンプルを追記する（`--reads` には新しいサンプルだけを書く）。付けない `add-reads` は列挙したサンプルで作り直す。`run` では使えない |
| `--reads-level N` | 9 | リードの実体の zstd 圧縮レベル。上げると容量は減り、構築は遅くなる（閲覧の速さは変わらない） |
| `--reads-keep-tags` | off | GAF のタグを全部残す（既定は表示に使わない `bq:Z` を捨てる） |
| `--reads-chunk-visits N` | 5 億 | 索引の 1 チャンクあたりのノード通過数。下げると構築時のメモリが減り、チャンクの数が増える |
| `--reads-no-names` | off | リード名の列と検索の索引を作らない。表示は変わらず、名前の検索だけができなくなる |
| `--reads-force-mismatch` | off | 取り込み前の検査（GAF のノード名と DB の一致率）が低くても続ける |
| `--read-labels SAMPLE=TSV` | — | リードのラベル（「リード名<TAB>ラベル」の表）。複数可 |

### 段の制御

| 選択肢 | 意味 |
|---|---|
| `--from STAGE` | その段から後を作り直す（その段以降の記録を消してから走る） |
| `--only STAGE` | その段だけを走らせる（続けて `bundle` も走る） |
| `--force` | 全段をやり直す |
| `--dry-run` | 走らせるコマンドを表示するだけ |
| `--no-trav` | Linear の索引（`<db>.trav` など）を作らない。遺伝子の段も作らない |
| `--no-tiled` | 描画用のタイル索引を作らない。無いと閲覧で開けないので、試験の目的以外では付けない |

`STAGE` に書ける段: `distill`、`collapse`、`decompose`、`lod`、`layout`、`emit`、`trav`、`genes`、`ann`、`annot`、`reads`、`rlabel`、`xdepth`、`tiled`、`bundle`（[前処理の各段](pipeline.md)）。

### 資源と一時領域

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--threads N` | 見えている CPU 数 | 並列度。バブル分解とレイアウトに効く。階層を組む段は再現性のため常に 1 |
| `--tmp DIR` | 環境変数 `AMIPA_TMP`、無ければ `$TMPDIR` → `/tmp` → `<out>/work/tmp` のうち空きが足りる最初のもの | DB の本体を組む一時領域。ノードローカルの速いディスクが望ましい |
| `--spill DIR` | 環境変数 `AMIPA_SPILL`、無ければ `--tmp` と同じ | ハプロタイプの帯などをディスクに逃がす場所。順次書きなので共有ファイルシステムでもよいが、必要量が DB より桁違いに大きいことがある |
| `--mem-gib N` | 使えるメモリの 60% | レイアウトのメモリ予算 |
| `--ribbon-disk` | off | ハプロタイプの帯の計算をディスクに逃がし、メモリをノード数に比例する程度に抑える（大きいグラフ向け） |
| `--hash-limit-gb N` | 2 | `manifest.json` に sha256 を記録するファイルの大きさの上限。これより大きいファイルは省く |

### バブル分解と階層

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--decomposer {bubblefinder,billi}` | 環境変数 `AMIPA_DECOMPOSER`、無ければ `bubblefinder` | バブル（分岐して再び合流する部分）を見つけるツール。違いは [前処理の各段](pipeline.md#バブルを見つける) |
| `--bubblefinder PATH` | 環境変数 `AMIPA_BUBBLEFINDER`、無ければ PATH 上の `BubbleFinder` | BubbleFinder の実行ファイル |
| `--billi PATH` | 環境変数 `AMIPA_BILLI`、無ければ PATH 上の `billi` | Billi の実行ファイル（配布イメージには入っていない） |
| `--flood {through,legacy}` | `through` | 階層を組む段で、バブルの内部のノードを割り当てる方法。`legacy` は以前の動作（内側のバブルより先にある外側のバブルの内部を割り当て損ねる）で、以前の DB を再現するときだけ使う |
| `--min-comp N` | 1000 | これよりノードの少ない連結成分は、階層とレイアウトで小片としてまとめて扱う |

分解器を変えると、バブル分解の段から後が作り直しになる。どの分解器で作ったかは `manifest.json` の `lod` に記録される。

### レイアウトの調整

通常は既定のままでよい。

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--layout-init {pmds,path,random}` | `pmds` | 初期配置。`pmds` は PivotMDS、`path` はパスの中の位置で 1 次元に並べる |
| `--epochs N` | 30 | 配置の反復回数 |
| `--seed N` | 1 | 乱数の種 |
| `--pivots N` | 400 | PivotMDS の基準点の数 |
| `--layout-edge-len {off,pathmed,framemed,both}` | `off` | 辺の目標の長さの決め方。`pathmed` は辺の両端の間の、パスに沿った距離の中央値にする（近道の辺で遠い領域が重なるのを防ぐ）。`framemed` は一意に通るノードの対の間で同じことをする。`both` は両方 |
| `--layout-edge-len-cap X` | 1000 | `pathmed` の目標の長さの上限 |
| `--layout-edge-len-frame-cap X` | 100000 | `framemed`・`both` の目標の長さの上限 |
| `--layout-path-only` | off | パスに沿った距離だけで配置する（表示用に変換したグラフ向け） |
| `--layout-path-term {hop,bp}` | `hop` | `--layout-path-only` の距離の尺度（ステップ数か塩基数） |
| `--layout-path-pairs N` | 0 | `--layout-path-only` で 1 回の反復あたりに使う対の数（0 で成分内のステップ数） |
| `--layout-node-coord TSV` | — | ノードごとの座標（bp）の表。配置の距離をこの座標の差にする（実験的） |
| `--layout-coord-circular L` | 0 | `--layout-node-coord` の座標が環状なら、その長さ（bp） |
| `--layout-coord-smooth λ` | 1 | `--layout-node-coord` の座標を、隣り合うノードと整合するよう平滑化する強さ（0 で無効） |
| `--layout-coord-gap-min BP` | 20000 | `--layout-node-coord` で、座標の差を目標の長さに使う辺の最小の隙間 |

### その他

| 選択肢 | 既定 | 意味 |
|---|---|---|
| `--python PATH` | `amipa prep` を起動した Python | 各段を走らせる Python |
| `--template FILE` | 同梱の空のテンプレート（環境変数 `AMIPA_TEMPLATE_DB` で変更可） | DB の表の定義を供給する空の DB |
| `--json` | off | `plan` の出力を JSON にする |
