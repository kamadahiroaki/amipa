# ジョブスケジューラで回す

AMIPA 自身はスケジューラの書式を持たない（サイトごとに違うため）。**ジョブスクリプトは
自分の環境の書式で書き、その中で `amipa prep run` を呼ぶ**。必要な資源は次で見られる。

```bash
amipa prep plan --gfa graph.gfa --out graph.amipa --threads 24
amipa prep plan ... --json          # 自動生成に使うなら
```

ここにある雛形をコピーして使う。

| ファイル | 想定 |
|---|---|
| `age-single-job.sh` | 1 ジョブで全段（中規模まで。単純） |
| `age-per-stage.sh` + `age-submit.sh` | 段別ジョブ（全ゲノム規模。資源効率がよい） |
| `slurm-per-stage.sbatch` | Slurm 版 |

## どちらを選ぶか

**1 ジョブ**は単純で、`--only` も要らない。ただし多コアを使うのはレイアウト段だけなので、
その他の段の間もスロットを占有する。全ゲノム規模（11 時間級）では 200 コア時間ほど無駄になる。

**段別**は各段が必要な分だけ要求する。ジョブ間の依存はスケジューラの機能で繋ぐ
（AGE なら `-hold_jid`、Slurm なら `--dependency=afterok:`）。
**前段が失敗しても後段は起動する**点に注意（依存は「終了」であって「成功」ではないことが多い）。
AMIPA 側は入力が揃っていなければその場で止まるので、壊れた出力は作られない。

## 一時領域（重要）

**呼び出す側が決めて渡す**。イメージ内は場所を決め打ちしない。

```bash
SCRATCH="${TMPDIR:-/tmp/$USER}/amipa"      # ノードローカルの速いディスク
mkdir -p "$SCRATCH"
apptainer exec --cleanenv -B "$SCRATCH:/scratch" amipa-prep.sif \
    amipa prep run --only emit ... --tmp /scratch
```

多層 SQLite を組む `--tmp` は**ランダム書き込み**なのでローカルディスクが要る。
リボンの `--spill` は順次書きなので共有ストレージでもよく、**必要量が桁違いに大きいことがある**。
その場合は別々に渡す（`-B "$SPILL:/spill" ... --spill /spill`）。

## 投入した後で要求を直す

見積りが大きすぎると、資源が空くまでいつまでも順番が回ってこない。**実行待ちのジョブなら
要求を後から下げられる**（実行中は変えられないので、待っているうちに直すのが肝心）。

```bash
# AGE / SGE — s_vmem と mem_req を両方持たせている環境では**同時に**（食い違うと弾かれる）
qalter -l s_vmem=12G,mem_req=12G <ジョブID>
qstat -j <ジョブID> | grep hard_resource     # 反映されたか確認

# Slurm
scontrol update JobId=<ジョブID> MinMemoryNode=96G
```

1 度でも流したら、`qreport -j <ジョブID>`（AGE）や `sacct -j <ジョブID> --format=MaxVMSize`
（Slurm）で**実測**を見て、次からはその値に寄せる。`amipa prep plan` が出すのは出発点でしかない。

## リード整列の段だけは GAF の量で決まる

他の段は GFA の大きさに比例するが、`reads` は**葉ごとの転置索引をメモリに載せる**ので
GAF の量で決まる。`amipa prep plan` に `--reads` も一緒に渡すと、その分を含めた目安が出る。
