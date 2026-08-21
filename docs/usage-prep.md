# GFA からアトラスを作る（`amipa prep`）

```bash
docker run --rm -v "$PWD:/work" -w /work -u "$(id -u):$(id -g)" -e HOME=/tmp \
  ghcr.io/kamadahiroaki/amipa-prep prep run \
    --gfa  /work/graph.gfa \
    --out  /work/graph.amipa \
    --threads 8
```

- `-u $(id -u):$(id -g)` … 出力を自分の所有にする（付けないと root 所有になる）
- 途中で止めても、同じコマンドをもう一度打てば続きから走る

## アノテーションとリードも一緒に

同じ 1 コマンドで最後まで通せる。

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 \
    --band   cytoBand.txt.gz             `# 染色体バンド（参照座標）` \
    --gene   gencode.gtf.gz              `# 遺伝子` \
    --region regions.bed --region-ref chm13   `# 領域（セントロメア等）` \
    --reads  HG002=HG002.gaf --reads HG003=HG003.gaf
```

あとから足すこともできる。アトラスは作り直さない。

```bash
amipa prep add-annot --out graph.amipa --gene gencode.gtf.gz
amipa prep add-reads --out graph.amipa --reads HG002=HG002.gaf
```

アノテーションは生のファイルをそのまま渡してよい。事前に別のツールでグラフへ射影しておく
必要はなく、射影は AMIPA が参照座標とパスをたどって行う。

リードの GAF は、path のノード ID がアトラスの葉ノードと一致している必要がある
（`vg giraffe --named-coordinates` の出力など）。ずれていると大半のリードが捨てられ、
`skip` の割合が高く報告される。

> 対応予定: 現在の実装は、GFA のセグメント id が整数であることを前提にしている
> （葉の鍵が `n<整数>`）。整数でない id のグラフではリードが索引に載らず、大半が捨てられる。
> id の空間に依存しない照合（セグメント名の対応表を用いる方式）へ移し、
> 一致率が低いときは完走せずに失敗させる予定である。

リードの実体は `graph.amipa/reads/<サンプル>.gaf.zst` に詰め替えて置く。
1 行ずつ取り出せるように zstd の独立フレームに刻んであり、`zstd -d` で普通に伸長できる。
このとき、表示に使わないタグは保存しない。既定では塩基クオリティ `bq:Z` を落としており、
HiFi の GAF ではこれだけで 7 割が消える。全部残したいときは `--reads-keep-tags`、
容量を詰めたいときは `--reads-level 12`〜`19`（閲覧の速さは変わらない）。

## 途中からやり直す

```bash
amipa prep status --out graph.amipa            # どの段まで終わったか
amipa prep run --out graph.amipa --from layout # layout 以降を作り直す
amipa prep run --out graph.amipa --only emit   # emit だけ
amipa prep run --out graph.amipa --force       # 全部やり直す
```

段ごとに、コマンド行と入力ファイルの署名から鍵を作って記録している。変わっていない段は飛ばす。
後段の鍵はその段の入力の署名を含むので、前段が実際に出力を書き換えたときだけ後段も走る。

## 資源の指定

| オプション | 意味 | 既定 |
|---|---|---|
| `--threads` | 並列度。バブル分解とレイアウトに効く（階層を組む段は再現性のため常に 1 スレッド） | 見えている CPU 数 |
| `--tmp` | アトラス本体を組む場所。ランダム書き込みなのでローカルの速いディスクが要る。必要量はおよそ完成アトラスのサイズ | `$TMPDIR` → `/tmp` → `<out>/work/tmp` の順で、空きが足りる最初のもの |
| `--spill` | 途中の一時ファイル。順次書きなので共有ファイルシステムでも実害は小さいが、必要量がアトラスより桁違いに大きいことがある | `--tmp` と同じ |
| `--mem-gib` | レイアウトのメモリ予算 | 使用可能量（cgroup 上限やジョブの上限も見る）の 60% |
| `--ribbon-disk` | ハプロタイプ帯の計算をディスクストリーミングで行う（大きいグラフでメモリを抑える） | off |

`--tmp` と `--spill` を分けられるようにしてあるのは、全ゲノム規模では前者が数百 GB、
後者が数 TB になることがあり、ローカルディスクに両方は入らないため。
その場合は `--spill` だけ大きな共有ストレージへ逃がす。

```bash
amipa prep run --gfa big.gfa --out big.amipa \
    --tmp /local/nvme --spill /shared/scratch --ribbon-disk
```

## 計算機の規模の目安

| グラフ | 所要（8 スレッド） | メモリ | 出力 |
|---|---|---|---|
| 1 染色体（小, 166K ノード） | 約 3 分 | 4–8 GB | 約 0.3 GB |
| 1 染色体（大, GFA 0.8 GB） | 約 25 分 | 16 GB | 約 9 GB |
| 全ゲノム（GFA 48 GB） | 約 11 時間 | 段により 96–320 GB | 約 260 GB |

段ごとに必要な資源は大きく違う。`amipa prep plan` が入力サイズから目安を出す。

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

ジョブスクリプトは利用者が自分の環境の書式で書き、その中で `amipa prep run` を呼ぶ。
スケジューラの書式はサイトごとに違うので AMIPA は持たない。
AGE と Slurm の雛形が [`examples/hpc/`](../examples/hpc/) にある。

多コアを使うのはレイアウト段だけなので、全ゲノム規模では段を別ジョブに分けると
200 コア時間ほど節約できる。中規模までは 1 ジョブで通す方が単純でよい。
