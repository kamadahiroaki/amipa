# GFA からアトラスを作る（`amipa prep`）

```bash
docker run --rm -v "$PWD:/work" -w /work -u "$(id -u):$(id -g)" -e HOME=/tmp \
  <registry>/amipa-prep prep run \
    --gfa  /work/graph.gfa \
    --out  /work/graph.amipa \
    --threads 8
```

- `-u $(id -u):$(id -g)` … 出力を自分の所有にする（付けないと root 所有になる）
- **途中で止めても、同じコマンドをもう一度打てば続きから走る**

## アノテーションとリードも一緒に

同じ 1 コマンドで最後まで通せる。

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 \
    --band   cytoBand.txt.gz             `# 染色体バンド（参照座標）` \
    --gene   gencode.gtf.gz              `# 遺伝子` \
    --region regions.bed --region-ref chm13   `# 領域（セントロメア等）` \
    --reads  HG002=HG002.gaf --reads HG003=HG003.gaf
```

あとから足すこともできる（**アトラスは作り直さない**）。

```bash
amipa prep add-annot --out graph.amipa --gene gencode.gtf.gz
amipa prep add-reads --out graph.amipa --reads HG002=HG002.gaf
```

アノテーションは**生のファイルをそのまま渡す**（事前に別ツールでグラフへ射影しておく必要はない）。
射影は AMIPA が参照座標とパスをたどって行う。

リードの GAF は **path のノード ID がアトラスの葉ノードと一致**している必要がある
（`vg giraffe --named-coordinates` の出力など）。ずれていると大半のリードが捨てられ、
`skip` の割合が高く報告される。

## 途中からやり直す

```bash
amipa prep status --out graph.amipa            # どの段まで終わったか
amipa prep run --out graph.amipa --from layout # layout 以降を作り直す
amipa prep run --out graph.amipa --only emit   # emit だけ
amipa prep run --out graph.amipa --force       # 全部やり直す
```

段ごとに「コマンド行 ＋ 入力ファイルの署名」から鍵を作って記録しており、**変わっていない段は飛ばす**。
後段の鍵はその段の入力の署名を含むので、前段が実際に出力を書き換えたときだけ後段も走る。

## 資源の指定

| オプション | 意味 | 既定 |
|---|---|---|
| `--threads` | 並列度。バブル分解とレイアウトに効く（**統一 LOD 木の段は再現性のため常に 1 スレッド**） | 見えている CPU 数 |
| `--tmp` | **多層 SQLite を組む場所**。ランダム書き込みなので**ローカルの速いディスク**が要る。必要量 ≒ 完成アトラスのサイズ | `$TMPDIR` → `/tmp` → `<out>/work/tmp` の順で空きが足りる最初のもの |
| `--spill` | リボン・多重度の一時ファイル。**順次書き**なので共有ファイルシステムでも実害が小さいが、**必要量がアトラスより桁違いに大きいことがある** | `--tmp` と同じ |
| `--mem-gib` | レイアウトのメモリ予算 | 使用可能量（cgroup 上限・ジョブの上限も見る）の 60% |
| `--ribbon-disk` | リボンをディスクストリーミングで作る（大きいグラフで RAM を抑える） | off |

**`--tmp` と `--spill` を分けられる理由**: 全ゲノム規模では前者が数百 GB、後者が数 TB になることがあり、
ローカルディスクに両方は入らない。その場合は `--spill` だけ大きな共有ストレージへ逃がす。

```bash
amipa prep run --gfa big.gfa --out big.amipa \
    --tmp /local/nvme --spill /shared/scratch --ribbon-disk
```

## 計算機の規模の目安

| グラフ | 所要（8 スレッド） | メモリ | 出力 |
|---|---|---|---|
| 1 染色体（小, 166K ノード） | 約 3 分 | 4–8GB | 約 0.3GB |
| 1 染色体（大, GFA 0.8GB） | 約 25 分 | 16GB | 約 9GB |
| 全ゲノム（GFA 48GB） | 約 11 時間 | 段により 96–320GB | 約 260GB |

段ごとに必要な資源は大きく違う。**`amipa prep plan`** が入力サイズから目安を出す。

```bash
amipa prep plan --gfa graph.gfa --out graph.amipa --threads 24
```

```
  段             スロット      メモリ合計     /スロット      見込み時間
  distill          1        67G       67G       1.0h
  decompose        8       164G       21G       1.1h
  lod              1       149G      149G       1.9h
  layout          24        91G        4G       2.1h
  emit             1       178G      178G       4.6h
```

ジョブスクリプトは**利用者が自分の環境の書式で書き、その中で `amipa prep run` を呼ぶ**
（スケジューラの書式はサイトごとに違うので AMIPA は持たない）。
AGE / Slurm の雛形は [`examples/hpc/`](../examples/hpc/) にある。

多コアを使うのはレイアウト段だけなので、全ゲノム規模では**段を別ジョブに分ける**と
200 コア時間ほど節約できる。中規模までは 1 ジョブで通す方が単純でよい。
