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
