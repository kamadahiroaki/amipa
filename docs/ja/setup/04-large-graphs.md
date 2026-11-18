# 大きなグラフ（全ゲノム・HPC）

[English](../../en/setup/04-large-graphs.md)

染色体 1 本までなら、[最初の DB を作る（chrY）](02-first-db.md) と同じ 1 コマンドで手元の計算機でも作れる。全ゲノム規模では、資源を見積もり、一時領域を選び、ジョブスケジューラで段ごとに回す。

## 規模の目安

| グラフ | 所要（8 スレッド） | メモリ | 出力 |
|---|---|---|---|
| 1 染色体（小、16.6 万ノード） | 約 3 分 | 4–8 GB | 約 0.3 GB |
| 1 染色体（大、GFA 0.8 GB） | 約 25 分 | 16 GB | 約 9 GB |
| 全ゲノム（GFA 48 GB） | 約 11 時間 | 段により 96–320 GB | 約 260 GB |

必要な資源は段（前処理の工程）ごとに大きく違う。多くのコアを使うのはレイアウト（ノードの 2 次元の配置を決める段）とバブル分解だけで、ほかの段は 1 スレッドで走る。

## 見積もる（plan）

`amipa prep plan` が入力の大きさから、段ごとのスロット数・メモリ・時間の目安を出す。何も書き込まない。

```bash
amipa prep plan --gfa graph.gfa --out graph.amipa --threads 8
amipa prep plan ... --json          # ジョブスクリプトを自動で組むとき
```

chrY（GFA 79 MB）での出力:

```
  段             スロット      メモリ合計     /スロット      見込み時間
  distill          1         8G        8G       0.2h
  decompose        8         4G        1G       0.1h
  lod              1         8G        8G       0.2h
  layout           8         8G        1G       0.2h
  emit             1        24G       24G       0.2h
  trav             1         8G        8G       0.1h
  tiled            1         8G        8G       0.1h
  bundle           1         8G        8G       0.1h
```

- 値は全ゲノムのグラフでの実測に余裕を掛けたもので、出発点として使う。1 度流したら、実際に使った量で詰める（`amipa prep status` に段ごとの最大メモリが出る）。
- スロットあたりのメモリで指定するスケジューラ（AGE の `s_vmem` など）では「/スロット」の列を使う。
- `run` に渡すのと同じ選択肢を渡すと、その分も見積もる。`--reads` を渡すとリードの段（GAF の量で決まる）、`--gff-dir` を渡すと遺伝子の段（GFF の大きさで決まる。グラフにある seqid の行だけを読み、伸長して 1 GB 分の行あたり約 9 GB）が入る。
- パスの無い GFA では Linear・遺伝子・注釈の段は出ない。

## 一時領域とメモリを指定する

| 選択肢 | 意味 | 既定 |
|---|---|---|
| `--threads` | 並列度。バブル分解とレイアウトに効く（階層を組む段は結果の再現性のため常に 1 スレッド） | 見えている CPU 数 |
| `--tmp` | DB 本体を組む場所。ランダム書き込みなので、ノードローカルの速いディスクが要る。必要量はおよそ完成した DB の大きさ | `$TMPDIR` → `/tmp` → `<out>/work/tmp` のうち、空きが足りる最初のもの |
| `--spill` | 途中の一時ファイル。順次書きなので共有ファイルシステムでも実害は小さいが、必要量が DB より桁違いに大きいことがある | `--tmp` と同じ |
| `--mem-gib` | レイアウトのメモリ予算 | 使えるメモリ（cgroup やジョブの上限も見る）の 60% |
| `--ribbon-disk` | ハプロタイプの帯の計算をディスクに逃がして、メモリを抑える | off |

起動時のログに、選ばれた一時領域とその空き・ファイルシステムの種類が出る。共有ファイルシステム（Lustre など）が選ばれると警告が出る。動くが、SQLite のランダム書き込みが桁で遅くなる。

全ゲノム規模では `--tmp` が数百 GB、`--spill` が数 TB になることがあり、ローカルディスクに両方は入らない。その場合は `--spill` だけ大きな共有ストレージへ逃がす。

```bash
amipa prep run --gfa big.gfa --out big.amipa \
    --tmp /local/nvme --spill /shared/scratch --ribbon-disk
```

## ジョブスケジューラで回す

AMIPA 自身はスケジューラの書式を持たない（サイトごとに違うため）。ジョブスクリプトは自分の環境の書式で書き、その中で `amipa prep run` を呼ぶ。AGE（SGE）と Slurm の雛形が [examples/hpc/](../../../examples/hpc/) にある。

| ファイル | 中身 |
|---|---|
| `age-per-stage.sh` | 1 段を実行するジョブ（AGE/SGE） |
| `age-submit.sh` | 段ごとのジョブを依存でつないで投入する（AGE/SGE）。段の並びと資源は `amipa prep plan --json` から取る |
| `slurm-per-stage.sbatch` | 1 段を実行するジョブ（Slurm） |

### 1 ジョブか、段ごとか

1 ジョブで `amipa prep run` を最後まで流すのが最も単純で、中規模まではそれでよい。ただし多くのコアを使うのはレイアウトの段だけなので、ほかの段の間もスロットを占有する。全ゲノム規模（11 時間級）では 200 コア時間ほど無駄になる。

段ごとに分けると、各段が必要な分だけを要求できる。各ジョブで `amipa prep run --only <段>` を呼び、段の順は次のとおり。

```
distill → decompose → lod → layout → emit → trav → (genes, ann, annot, reads, rlabel, xdepth) → tiled → bundle
```

括弧の中は、その入力を渡したときだけ要る段。`tiled`（描画用のタイル索引）は必ず流す。無いと閲覧側で DB が開けない。`age-submit.sh` は `amipa prep plan --json` が返す段（入力に応じて走る段だけ）をこの順に投入する。注釈やリードの選択肢は環境変数 `AMIPA_EXTRA` に書くと、plan と各段の両方に渡る。

ジョブ間の依存はスケジューラの機能でつなぐ（AGE なら `-hold_jid`、Slurm なら `--dependency=afterok:`）。依存は多くの場合「前のジョブの終了」であって「成功」ではないので、前段が失敗しても後段は起動する。AMIPA の側は入力が揃っていなければその場で止まるので、壊れた出力は作られない。

### 一時領域は呼び出す側で決める

イメージの中は一時領域の場所を決め打ちしない。ジョブの中でノードローカルの領域を選んで渡す。

```bash
SCRATCH="${TMPDIR:-/tmp/$USER}/amipa"      # ノードローカルの速いディスク
mkdir -p "$SCRATCH"
apptainer exec --cleanenv -B "$SCRATCH:/scratch" amipa-prep.sif \
    amipa prep run --only emit --gfa graph.gfa --out graph.amipa --tmp /scratch
```

`--spill` を別の場所に置くときは、それも bind して渡す（`-B "$SPILL:/spill" ... --spill /spill`）。

### 投入した後で要求を直す

見積もりが大きすぎると、資源が空くまでいつまでも順番が回ってこない。実行待ちのジョブなら要求を後から下げられる（実行中は変えられないので、待っているうちに直す）。

```bash
# AGE / SGE（s_vmem と mem_req の両方を持たせている環境では同じ値に）
qalter -l s_vmem=12G,mem_req=12G <ジョブID>
qstat -j <ジョブID> | grep hard_resource     # 反映されたか確認

# Slurm
scontrol update JobId=<ジョブID> MinMemoryNode=96G
```

1 度流したら、`qacct -j <ジョブID>`（AGE）や `sacct -j <ジョブID> --format=MaxRSS,MaxVMSize`（Slurm）、または `amipa prep status` で実測を見て、次からはその値に寄せる。

## 途中から再開する

```bash
amipa prep status --out graph.amipa             # どの段まで終わったか
amipa prep run --out graph.amipa --from layout  # layout 以降を作り直す
amipa prep run --out graph.amipa --only emit    # emit だけ
amipa prep run --out graph.amipa --force        # 全部やり直す
```

同じ `run` をもう一度打つと、終わった段は飛ばして続きから走る。段ごとに「コマンド行と入力ファイルの署名（大きさと更新時刻）」から鍵を作って `state.json` に記録し、鍵と出力の実在が合う段は飛ばす。後段の鍵はその段の入力ファイルの署名を含むので、前段が実際に出力を書き換えたときだけ後段も走り直す。

一時領域の場所・スレッド数・メモリ予算のように、出力を変えない値は鍵に入れていない。別のノード（`$TMPDIR` が違う）で再開しても、終わった段はやり直さない。失敗した段の途中のファイルは消してから止まる。

`status` は段ごとに状態・秒数・終了時刻と、走った段の最大メモリ（RSS と仮想メモリ）を出す。
