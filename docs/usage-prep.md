# GFA から DB を作る（`amipa prep`）

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

あとから足すこともできる。DB は作り直さない。

```bash
amipa prep add-annot --out graph.amipa --gene gencode.gtf.gz
amipa prep add-reads --out graph.amipa --reads HG002=HG002.gaf
amipa prep add-tiled --out graph.amipa            # タイル索引を作り直す（通常は run が作る。無いと閲覧できない）
```

アノテーションは生のファイルをそのまま渡してよい。事前に別のツールでグラフへ射影しておく
必要はなく、射影は AMIPA が参照座標とパスをたどって行う。

リードの GAF は、path のノード ID が DB の葉ノードと一致している必要がある
（`vg giraffe --named-coordinates` の出力など）。取り込みの最初に先頭 1 万行で一致率を
検査し、低ければ**その場で失敗する**（原因と対処を表示する。黙って捨てて完走することはない）。

リードの索引はチャンク単位で構築するので、構築時のメモリはリード本数に依存せず一定に
収まり、数十億本のショートリードでも破綻しない（全ゲノム＋トリオ HiFi の実測でピーク 17 GB。
`--reads-chunk-visits` を下げるとさらに減る）。

```bash
amipa prep add-reads --out graph.amipa --reads-append --reads HG005=HG005.gaf
```

`--reads-append` は既存のリード索引に**サンプルを追記**する（既存の索引と実体には触れない）。
付けない `add-reads` は、列挙したサンプルで索引を作り直す。
リード名で検索する索引が要らなければ `--reads-no-names`（表示は変わらず、名前検索だけ不可に
なる。数十億本では名前索引だけで数百 GB になるため、ショートリードのコホートで指定する）。

セグメント id は整数でなくてよい（minigraph の `s1`、hifiasm・verkko の `utg000001l` など）。
整数でない id が 1 つでもあれば、前処理は S 行の順に内部の番号を振り、元の名前を `graph.db.segnames` に残す。
画面のノード名・ノード検索・GFA/BED の書き出しは、どちらの場合も元のグラフの名前を使う。
リードの GAF も元の名前のまま渡せばよい（取り込むときに内部の番号へ書き換える）。
ただし、自明バブルの畳み込み（`--collapse`）と整数でない id の組み合わせは未対応。

### リードのラベル（例: トリオの子のリードを父由来・母由来に分ける）

```bash
amipa prep add-read-labels --out graph.amipa --read-labels HG002=HG002.labels.tsv
```

表は 1 行 1 リードで「リード名<TAB>ラベル」（3 列目以降と `#` の行は無視）。リード名は GAF の 1 列目と同じ書き方にする。
ラベルの決め方はこの段の外で、たとえば trio binning（`yak triobin` の出力の 1・2 列目）や
`whatshap haplotag --output-haplotag-list` の出力を変換して使う。
結果は `graph.db.rlabel` に入り、整列とタイル索引は作り直さない（ラベルを差し替えるときはこの段だけを流し直す）。
閲覧側の Linear の塩基の段では、リードがサンプルの中でラベルごとにまとまって並ぶ（「HG002 · pat」「HG002 · mat」など）。
`run` に `--read-labels` を付けても同じ段が走る。

リードの実体は `graph.amipa/reads/<サンプル>.gaf.zst` に詰め替えて置く。
1 行ずつ取り出せるように zstd の独立フレームに刻んであり、`zstd -d` で普通に伸長できる。
このとき、表示に使わないタグは保存しない。既定では塩基クオリティ `bq:Z` を落としており、
HiFi の GAF ではこれだけで 7 割が消える。全部残したいときは `--reads-keep-tags`、
容量を詰めたいときは `--reads-level 12`〜`19`（閲覧の速さは変わらない）。

## Traversals の材料（通過・遺伝子・参照注釈）

通過の索引（`graph.db.trav`）はパスがあれば既定で作る。合意座標の向きと染色体の順は `--ref-key` の参照パス
（名前がこの文字列で始まるパス。無ければ先頭のパス）を手掛かりに決める。要らなければ `--no-trav`。

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 --ref-key GRCh38 \
    --gff-dir gff/                                  `# 株ごとの GFF（<名前>.gff）` \
    --ann-rmsk rmsk.txt.gz                          `# RepeatMasker（参照座標）` \
    --ann-vcf HG002=HG002.vcf.gz --ann-bed HG002=HG002.bed   `# サンプルの変異とベンチマーク領域`
```

- `--gff-dir`: GFF の名前はパス名の `#` の前（`GRCh38#chr20` → `GRCh38.gff`、`GCF_000148365.1#1#NC_017631.1` → `GCF_000148365.1.gff`）、
  seqid はパス名の最後の `#` の後。参照だけに注釈がある場合は、ほかのパスへノードの共有で写す
- リードがあれば、合意座標ごとのリードの深さ（`graph.db.xdepth`）も作る
- あとから足すときは `--only trav` / `--only genes` / `--only ann` / `--only xdepth` で、その段だけを走らせる

## 途中からやり直す

```bash
amipa prep status --out graph.amipa            # どの段まで終わったか
amipa prep run --out graph.amipa --from layout # layout 以降を作り直す
amipa prep run --out graph.amipa --only emit   # emit だけ
amipa prep run --out graph.amipa --force       # 全部やり直す
```

段ごとに、コマンド行と入力ファイルの署名から鍵を作って記録している。変わっていない段は飛ばす。
後段の鍵はその段の入力の署名を含むので、前段が実際に出力を書き換えたときだけ後段も走る。

## バブル分解器の選択

| オプション | 意味 | 既定 |
|---|---|---|
| `--decomposer` | バブル分解器。`bubblefinder` / `billi`（違いは[各段の説明](pipeline.md)） | 環境変数 `AMIPA_DECOMPOSER`、無ければ `bubblefinder` |
| `--billi` | Billi の実行ファイル | 環境変数 `AMIPA_BILLI`、無ければ PATH 上の `billi` |
| `--bubblefinder` | BubbleFinder の実行ファイル | 環境変数 `AMIPA_BUBBLEFINDER`、無ければ PATH 上の `BubbleFinder` |
| `--flood` | 階層を組む段でバブルの内部を割り当てる方法。`legacy` は以前の動作（内側のバブルより先にある外側のバブルの内部を割り当て損ね、その部分がバブルの外として扱われる）で、以前の DB を再現するときだけ使う | `through` |

分解器を変えると、バブル分解の段とそれ以降がやり直しになる。どの分解器で作ったかは出力一式の
`manifest.json` の `lod` に記録される。

## 資源の指定

| オプション | 意味 | 既定 |
|---|---|---|
| `--threads` | 並列度。バブル分解（BubbleFinder）とレイアウトに効く（階層を組む段は再現性のため常に 1 スレッド） | 見えている CPU 数 |
| `--tmp` | DB 本体を組む場所。ランダム書き込みなのでローカルの速いディスクが要る。必要量はおよそ完成 DB のサイズ | `$TMPDIR` → `/tmp` → `<out>/work/tmp` の順で、空きが足りる最初のもの |
| `--spill` | 途中の一時ファイル。順次書きなので共有ファイルシステムでも実害は小さいが、必要量が DB より桁違いに大きいことがある | `--tmp` と同じ |
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
