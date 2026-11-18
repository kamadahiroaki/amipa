# 最初の DB を作る（chrY）

[English](../../en/setup/02-first-db.md)

自分のデータに進む前に、ヒト chrY の小さなグラフで GFA から DB を作り、画面で開くまでを一度通す。導入が正しくできているかの確認にもなる。手順の原本はリポジトリの [examples/chrY/](../../../examples/chrY/) にある。

| | |
|---|---|
| 入力 GFA | 83 MB（HPRC Minigraph-Cactus GRCh38 v1.0 の chrY 部分） |
| 所要 | 2〜4 分（8 スレッド） |
| 出力 | 約 250 MB の DB |
| メモリ | 8 GB あれば足りる |

全ゲノムでは同じ手順に 11 時間ほどかかる（[大きなグラフ](04-large-graphs.md)）。

## 用意するもの

必要なのは GFA 1 本だけ。染色体バンドとリードは任意。

```bash
mkdir -p work && cd work
# GFA（パンゲノムグラフ）。手元のものを使ってよい。作り方は下の「入力の GFA を切り出す」
ls chrY.gfa

# 任意: 染色体バンド（UCSC）
wget -q https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBand.txt.gz -O cytoBand.hg38.txt.gz
# 任意: リード整列（vg giraffe --named-coordinates で同じグラフに整列した GAF）
ls HG002.gaf.gz
```

### 入力の GFA を切り出す

全ゲノムの GFA から 1 染色体を取り出すときは、その染色体のパスに乗るセグメントとリンクだけを残す。`vg` を使うなら次のようにする。

```bash
vg chunk -x hprc-v1.0-mc-grch38.gbz -p GRCh38#0#chrY -c 0 | vg view - > chrY.gfa
```

リードも表示したいときは、GAF の中のノード ID がこの GFA のものと一致している必要がある。切り出しで ID を振り直すと合わなくなるので、整列も同じ GFA（同じ ID）に対して行う。

## 作る

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/work" -w /work \
  ghcr.io/kamadahiroaki/amipa-prep \
  prep run --gfa /work/chrY.gfa --out /work/chrY.amipa --threads 8 \
      --band  /work/cytoBand.hg38.txt.gz \
      --reads HG002=/work/HG002.gaf.gz
```

- `-u "$(id -u):$(id -g)"` は出力を自分の所有にする。付けないと root の所有になる。
- `--band` と `--reads` は持っていなければ外してよい。

Apptainer なら次のとおり。

```bash
apptainer exec --cleanenv -B "$PWD:/work" amipa-prep.sif \
  amipa prep run --gfa /work/chrY.gfa --out /work/chrY.amipa --threads 8
```

### 期待される出力

段（前処理の工程）ごとに、何をするかと、終わったときの所要時間・メモリが 1 行ずつ出る。

```
[amipa ..:..:..] build用の一時領域: /tmp（...）
[amipa ..:..:..] [distill] GFA → dense-id numpy 中間（以降の段は GFA を読まない）
[amipa ..:..:..]   ok (..s, 最大 RSS .. GB, ...)
[amipa ..:..:..] 参照: GRCh38（既定の参照 GRCh38）
[amipa ..:..:..] [decompose] バブル分解（bubblefinder）...
  ...
[amipa ..:..:..] 完了。viewer で開く例:
```

途中で失敗しても、原因を直してから同じコマンドをもう一度打てば、終わった段は飛ばして続きから走る。段の一覧と意味は [前処理の各段](../reference/pipeline.md) にある。

## 確かめる

どの段まで終わったかを見る。

```bash
docker run --rm -v "$PWD:/work" ghcr.io/kamadahiroaki/amipa-prep prep status --out /work/chrY.amipa
```

走った段が `done`（この入力では作らない段は `-`）で、最後に `manifest.json: あり` と出ればよい。

出来ているはずのもの:

```
chrY.amipa/
  manifest.json      目録（版・入っているもの・各ファイルの sha256）
  chrY.db            本体（多層 SQLite）
  chrY.db.distill/   パスの通り道（Linear と塩基の表示の材料）
  chrY.db.trav       Linear（画面下の、株ごとの行で並びを比べるパネル）の索引
                     ほかに .travx .xtiles .anc .refx も一緒にできる
  chrY.db.tiled      描画用のタイル索引（無いと開けない）
  chrY.db.annot      --band を渡したとき
  chrY.db.reads      --reads を渡したとき（リードの索引）
  chrY.db.xdepth     同上（座標ごとのリードの深さ）
  reads/HG002.gaf.zst  同上（リードの実体）
  work/              中間物とログ。配布するときは削ってよい
  state.json         どの段まで終わったかの記録
```

それぞれのファイルの中身は [DB の形式](../reference/db-format.md) にある。

次に、閲覧イメージで点検する。

```bash
docker run --rm -v "$PWD/chrY.amipa:/data:ro" ghcr.io/kamadahiroaki/amipa-viewer check
```

本体の必須の表、層（解像度の段階）の数、タイル索引、注釈・リードのサイドカー（本体の横に置く付属ファイル）が `ok` で並び、最後に `RESULT: OK` と出れば、その機能は画面でも使える。`FAIL` の行があれば、その行に理由と直し方が出る（[うまくいかないとき](troubleshooting.md)）。

## 開く

```bash
docker run --rm -p 3001:3001 -v "$PWD/chrY.amipa:/data:ro" ghcr.io/kamadahiroaki/amipa-viewer serve
```

ブラウザで <http://localhost:3001> を開く。画面の使い方は [はじめの 5 分](../guide/01-first-look.md) から。

自分のデータで作るときは [自分のデータを準備する](03-your-data.md) へ進む。
