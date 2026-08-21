# 例: ヒト chrY で一通り試す

まずこれを通す。全ゲノムは 11 時間かかるが、chrY なら数分で ①GFA →
②アトラス → ③ブラウザで表示 まで行ける。導入が正しくできているかの確認にも使う。

| | |
|---|---|
| 入力 GFA | 83 MB（HPRC MC-GRCh38 v1.0 の chrY 部分） |
| 所要 | 2〜4 分（8 スレッド。コンテナ内で 2.6 分の実測） |
| 出力 | 約 250 MB のアトラス |
| メモリ | 8 GB あれば足りる |

## 1. 入力を用意する

必要なのは GFA 1 本だけ。アノテーションとリードは任意。

```bash
mkdir -p work && cd work
# GFA（パンゲノムグラフ）。手元のものを使ってよい
#   HPRC のグラフから chrY を切り出す例は下の「入力の作り方」を参照
ls chrY.gfa

# 任意: 染色体バンド（UCSC）と遺伝子（GENCODE）
wget -q https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBand.txt.gz -O cytoBand.hg38.txt.gz
# 任意: リード整列（vg giraffe --named-coordinates の GAF）
ls HG002.gaf.gz
```

## 2. アトラスを作る

```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" -w /work amipa-prep \
  prep run --gfa /work/chrY.gfa --out /work/chrY.amipa --threads 8 \
      --band  /work/cytoBand.hg38.txt.gz \
      --reads HG002=/work/HG002.gaf.gz
```

Apptainer なら:

```bash
apptainer exec --cleanenv -B "$PWD:/work" amipa-prep.sif \
  amipa prep run --gfa /work/chrY.gfa --out /work/chrY.amipa --threads 8
```

途中で失敗しても、直したあと同じコマンドを打てば終わった段は飛ばして続きから走る
（`amipa prep status --out chrY.amipa` で確認できる）。

## 3. 点検して開く

```bash
docker run --rm -v "$PWD/chrY.amipa:/data:ro" amipa-viewer check      # → RESULT: OK
docker run --rm -p 3001:3001 -v "$PWD/chrY.amipa:/data:ro" amipa-viewer serve
```

ブラウザで <http://localhost:3001>。

## 出来ているはずのもの

```
chrY.amipa/
  manifest.json
  chrY.db            本体（多層 SQLite）
  chrY.db.distill/   塩基レベル整列（bubble MSA）
  chrY.db.annot      --band/--gene を渡したとき
  chrY.db.reads      --reads を渡したとき
  reads/HG002.gaf.zst        同上（実体）
  work/                      中間物とログ。配布時は削ってよい
  state.json
```

`amipa check` が各サイドカーを `ok` で並べれば、その機能は画面でも使える状態にある。

## 入力の作り方（HPRC のグラフから切り出す）

全ゲノムの GFA から 1 染色体を取り出す場合は、その染色体のパスに乗る
セグメントとリンクだけを残す。`vg` を使うなら:

```bash
vg chunk -x hprc-v1.0-mc-grch38.gbz -p GRCh38#0#chrY -c 0 | vg view - > chrY.gfa
```

リードも表示したい場合は、GAF の path のノード ID がこの GFA のものと一致している
必要がある。切り出した GFA で ID を振り直すと合わなくなるので、整列も同じ GFA
（同じ ID 空間）に対して行うこと。ずれていると `skip` の割合が高いと報告される。
