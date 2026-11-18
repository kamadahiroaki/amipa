# 自分のデータを準備する

[English](../../en/setup/03-your-data.md)

入力ごとの条件と、合わないときに何が起きるか、どう直すかをまとめる。先に [最初の DB を作る（chrY）](02-first-db.md) を一度通しておくと、どこで問題が起きたかを切り分けやすい。

基本の形は次の 1 行で、注釈やリードは同じコマンドに足していく。

```bash
amipa prep run --gfa graph.gfa.gz --out graph.amipa --threads 16
```

コンテナから呼ぶときは `docker run ... ghcr.io/kamadahiroaki/amipa-prep prep run ...` か `apptainer exec --cleanenv ... amipa-prep.sif amipa prep run ...` の形にする（[導入](01-install.md)）。選択肢の一覧は [コマンドと選択肢](../reference/cli.md) にある。

## グラフ（GFA）

| 条件 | 合わないとどうなるか |
|---|---|
| GFA 1.0 / 1.1（S・L・P・W 行） | 他の行は読み飛ばす |
| `.gz`・`.zst` で圧縮したままでよい | 伸長しておく必要はない |
| 重なりの無い（blunt な）グラフ。L 行の CIGAR が `0M` か `*` | 重なりのある L 行が 1 本でもあると、最初の段で「重なりのある L 行が N 本ある」と例を示して止まる |
| パス（P・W 行）は無くてもよい | 無いと Linear（画面下の、株ごとの行で並びを比べるパネル）・遺伝子・参照の注釈の段を飛ばし、グラフの表示だけの DB になる |
| セグメント id は整数でなくてよい | 下記「セグメント名」 |

重なりを無視して通すと、パスの塩基列が継ぎ目ごとに重なりの分だけ重複してしまうので、重なりのあるグラフは受け付けない。Bifrost・Cuttlefish・BCALM などの de Bruijn グラフは、重なりを除いた GFA に変換してから渡す。

minigraph の rGFA が持つ `SN`/`SO` タグ（参照の座標）は今は使わない。パスの無い rGFA では、参照座標・注釈は付かない。

### パス名の形

パス名から「サンプル（株）」「ハプロタイプ」「コンティグ」を読み取る。サンプル名は参照の選択、`--gff-dir` のファイル名、画面の株の行に使い、コンティグ名は GFF の seqid の照合と座標の表示に使う。

| パス名の例 | 読み方 |
|---|---|
| `HG002#1#chr20` | PanSN（`sample#hap#contig`）。W 行もこの形に直して読む |
| `HG00438#2#MT#0` | PanSN の 4 項目目（位相ブロックの番号）。番号は捨てて `HG00438#2#MT` と同じに扱う |
| `GRCh38#chr20` | 2 項目（`sample#contig`）。ハプロタイプ無し |
| `GRCh38.chr1` | `#` の無い参照の略記（全ゲノムの Minigraph-Cactus グラフ）。`.` の後が `chr` で始まるときだけ `.` で切る。`NC_000913.3` のような版番号付きの名前は切らない |
| `CHM13#chrM[0-15992]` | 末尾の部分範囲 `[a-b]`・`[a:b]` は捨てる |
| `CASBIT01`、`Reference:1_Sequence:1` | 区切りが無い名前は、名前そのものをサンプルとコンティグの両方として扱う |

### セグメント名

セグメント id は整数でなくてよい（minigraph の `s1`、hifiasm・verkko の `utg000001l` など）。整数でない id が 1 つでもあれば、前処理は S 行の順に内部の番号を振り、元の名前を `<db>.segnames` に残す。画面のノード名、ノードの検索、GFA・BED の書き出しは、どちらの場合も元のグラフの名前を使う。リードの GAF も元の名前のまま渡せばよい（取り込むときに内部の番号へ書き換える）。

ただし、自明なバブルの畳み込み（`--collapse`、下記）と整数でない id の組み合わせは未対応。

## 参照の決まり方

参照座標の表示、座標での移動、Linear の向きと染色体の順、`--band`・`--gene`・`--ann-*` の写し先には、1 本の参照（パス名のサンプル）を使う。既定では次の順に、最初に見つかったものを使う。サンプル名の大小は区別しない（`grch38` と `GRCh38` は同じ）。

1. `--ref-key` で指定したサンプル
2. GFA ヘッダの `RS:Z` タグ（Minigraph-Cactus が参照のサンプルを書く）。`RS:Z:CHM13 GRCh38` のように複数あれば、その中で GRCh38、CHM13、先に書かれたもの、の順
3. `GRCh38`、次に `CHM13`
4. 先頭のパスのサンプル

選んだ参照とその理由は各段のログに 1 行出る。

```
[amipa ..:..:..] 参照: GRCh38（GFA ヘッダの RS:Z（CHM13 GRCh38）のうち GRCh38）
```

`--ref-key` に当たるパスが無いときは、上の規則で選び直し、その旨をログに書いて続ける。参照座標や座標での移動が画面に出ないときは、まずこの行を見て、意図と違えば、同じ `run` に `--ref-key` でサンプル名を付けて流し直す。参照を使う段から後だけが走り直す（[途中から再開する](04-large-graphs.md#途中から再開する)）。

## 遺伝子（GFF・GTF）

遺伝子の入れ方は 2 通りある。

| 選択肢 | 入れるもの | 画面での出方 |
|---|---|---|
| `--gff-dir <ディレクトリ>` | 株ごとの GFF3・GTF | Linear の各株の行の下に、その株の遺伝子。注釈の無い株には、注釈のある株から写したもの |
| `--gene <ファイル>` | 参照 1 本の GTF・GFF3 | グラフの上の遺伝子の塗りと名前、遺伝子名での移動 |

両方渡してよい。

### 株ごとの GFF（`--gff-dir`）

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 --gff-dir gff/
```

ディレクトリの中のファイル名は、パス名のサンプル（`#` の前）に拡張子 `.gff`・`.gff3`・`.gtf` を付けたもの。`.gz`・`.zst` で圧縮したままでよい。

| パス名 | 探すファイル（どれか 1 つ） |
|---|---|
| `GRCh38#chr20` | `GRCh38.gff3.gz`、`GRCh38.gtf` など |
| `GCF_000148365.1#1#NC_017631.1` | `GCF_000148365.1.gff` など |
| `CASBIT01`（`#` 無し） | `CASBIT01.gff` など |

GFF の seqid（第 1 列）は、パス名のコンティグと一致している必要がある（`GRCh38#chr20` なら `chr20`、`HG00438#2#MT#0` なら `MT`）。

| 状況 | 何が起きるか |
|---|---|
| どのサンプルのファイルも見つからない | 期待したファイル名を表示して止まる。表示された名前に合わせる |
| 一部のサンプルだけファイルが無い | ログに名前を出して続ける。その株には、注釈のある株の遺伝子をノードの共有を手掛かりに写す |
| seqid がパス名のコンティグと違う（例: GFF は `NC_001133.9`、パスは `S288C#0#chrI`） | その株の遺伝子が 0 件になる。ログに「グラフの seqid の行が 1 行も無い」と出る。seqid を書き換えるか、パス名に合わせた GFF を用意する |
| GFF にグラフに無い seqid の行がある | 読まずに飛ばす。全ゲノムの注釈を染色体 1 本のグラフにそのまま渡してよい（メモリもグラフにある行の分だけで済む） |
| GTF に gene 行が無い（UCSC の `ncbiRefSeq.gtf`・`refGene.gtf` など。transcript・exon・CDS だけ） | 同じ gene_id の転写産物の範囲から gene を補う |
| パスの無いグラフ、または `--no-trav` | 遺伝子の段を飛ばす（ログに理由が出る） |

入力の GFF は、グラフにある seqid の行と `#` の行を 1 行も落とさずに DB に残る（[DB の形式](../reference/db-format.md#遺伝子)）。

### 参照の遺伝子（`--gene`）

`--gene` には GTF（GENCODE など）か GFF3（Ensembl・NCBI・SGD など）を渡す。座標は参照（[上の規則](#参照の決まり方)で選んだもの）の座標で、seqid は参照のコンティグ名（`GRCh38#chr20` なら `chr20`）と一致している必要がある。一致する gene 行が 1 つも無いと、参照のコンティグ名の例を示して止まる。

`--gene` は gene 行（GFF3 では gene・pseudogene）を必要とする。gene 行の無い UCSC の GTF は `--gff-dir` で渡す。

アノテーションは生のファイルをそのまま渡してよい。別のツールでグラフへ写しておく必要はなく、AMIPA が参照のパスをたどってノードに写す。

## 参照の注釈

参照の座標で書かれた注釈を重ねる。どれも参照のパスをたどって写すので、パスの無いグラフでは飛ばす（ログに出る）。

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 \
    --band   cytoBand.txt.gz \
    --gene   gencode.gtf.gz \
    --region regions.bed --region-ref chm13 \
    --ann-rmsk rmsk.txt.gz \
    --ann-vcf HG002=HG002.vcf.gz --ann-bed HG002=HG002.bed
```

| 選択肢 | 形式 | 座標 | 画面での出方 |
|---|---|---|---|
| `--band` | UCSC の cytoBand 形式 | 参照 | グラフの塗りと名前 |
| `--gene` | GTF・GFF3（上記） | 参照 | グラフの塗りと名前、遺伝子名での移動 |
| `--region` | BED（セントロメアなどの領域） | `--region-ref` のサンプル（既定 `chm13`） | グラフの塗りと名前 |
| `--ann-rmsk` | UCSC の `rmsk.txt`（RepeatMasker） | 参照 | Linear の見出しの反復 |
| `--ann-vcf SAMPLE=VCF` | VCF（GIAB のベンチマークなど）。複数可 | 参照 | Linear の見出しのサンプルの変異 |
| `--ann-bed SAMPLE=BED` | BED（ベンチマーク領域。この外の変異は判定されていない）。複数可 | 参照 | Linear の見出し |

どれも `.gz`・`.zst` のままでよい。参照が GRCh38 でないときは、`--band` もその参照の座標で読む。`--ann-*` の行のうち、グラフの参照のパスに無いコンティグの行は読み飛ばす。

`--band`・`--gene`・`--region` が付かないと思ったら、パスのあるグラフか、seqid と参照のコンティグ名が一致しているかを確かめる。

## リード（GAF）とラベル

### リード

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 \
    --reads HG002=HG002.gaf.gz --reads HG003=HG003.gaf.gz
```

`--reads` は `サンプル名=GAF` の形で、何回でも書ける。GAF の中のノード ID（path の列）が、DB を作った GFA のセグメントと一致している必要がある（`vg giraffe --named-coordinates` の出力など）。整列に使ったグラフと DB の元のグラフは同じものにする。

| 状況 | 何が起きるか |
|---|---|
| ノード ID が DB と一致しない | 取り込みの最初に先頭 1 万行で一致率を調べ、低ければその場で失敗する。原因と対処が表示される。黙って捨てて完走することはない |
| 承知の上で続けたい | `--reads-force-mismatch` |
| セグメント id が整数でないグラフ | GAF も元の名前のまま渡す |

リードの実体は `graph.amipa/reads/<サンプル>.gaf.zst` に詰め替えて置く。1 行ずつ取り出せるように zstd の独立した塊に刻んであり、`zstd -d` で普通に伸長できる。このとき、表示に使わないタグは保存しない。既定では塩基クオリティ `bq:Z` を落としており、HiFi の GAF ではこれだけで 7 割が消える。

| 選択肢 | 意味 |
|---|---|
| `--reads-keep-tags` | タグを全部残す |
| `--reads-level 12`〜`19` | 容量を詰める（構築は遅くなるが、閲覧の速さは変わらない。既定 9） |
| `--reads-no-names` | リード名で検索する索引を作らない。表示は変わらず、名前検索だけができなくなる。数十億本のショートリードでは名前の索引だけで数百 GB になるので、ショートリードのコホートで使う |
| `--reads-chunk-visits` | 索引を作るときのメモリを下げる（下記） |

リードの索引はチャンク単位で作るので、構築時のメモリはリードの本数によらず一定に収まる（全ゲノムとトリオの HiFi でピーク 17 GB）。`--reads-chunk-visits` を下げるとさらに減る。

あとからサンプルを足すときは、既存の索引に追記できる。

```bash
amipa prep add-reads --out graph.amipa --reads-append --reads HG005=HG005.gaf.gz
```

`--reads-append` は既存の索引と実体に触れずにサンプルを足す。付けない `add-reads` は、列挙したサンプルだけで索引を作り直す。`add-reads` はタイル索引（線の太さにリードの本数を使う）も作り直す。Linear のリードの深さ（`<db>.xdepth`）も更新するときは、続けて `amipa prep run --out graph.amipa --only xdepth` を流す。

### リードのラベル

トリオの子のリードを父由来・母由来に分けるなど、サンプルの中のリードを群に分けて並べたいときに使う。

```bash
amipa prep add-read-labels --out graph.amipa --read-labels HG002=HG002.labels.tsv
```

表は 1 行 1 リードで「リード名<TAB>ラベル」。3 列目以降と `#` で始まる行は無視する。リード名は GAF の 1 列目と同じ書き方にする。

ラベルの決め方はこの段の外で行う。たとえば trio binning（`yak triobin` の出力の 1・2 列目）や、`whatshap haplotag --output-haplotag-list` の出力を変換して使う。結果は `<db>.rlabel` に入り、整列とタイル索引は作り直さない（ラベルを差し替えるときはこの段だけを流し直す）。画面では、Linear の塩基の段でリードがサンプルの中でラベルごとにまとまって並ぶ（「HG002 · pat」「HG002 · mat」など）。`run` に `--read-labels` を付けても同じ段が走る。

リードを作り直した後は、ラベルも流し直す（古いラベルは閲覧側で使われなくなる）。

## あとから足す

DB を作り直さずに足せる。

```bash
amipa prep add-annot --out graph.amipa --gene gencode.gtf.gz        # --band / --gene / --region
amipa prep add-reads --out graph.amipa --reads HG002=HG002.gaf.gz
amipa prep add-read-labels --out graph.amipa --read-labels HG002=HG002.labels.tsv
amipa prep run --out graph.amipa --only genes --gff-dir gff/        # 株ごとの遺伝子
amipa prep run --out graph.amipa --only ann --ann-rmsk rmsk.txt.gz  # 参照の注釈
amipa prep run --out graph.amipa --only trav                        # Linear の索引
amipa prep run --out graph.amipa --only xdepth                      # リードの深さ
amipa prep add-tiled --out graph.amipa                              # タイル索引を作り直す
```

## 細かい変異の多いグラフ（`--collapse`）

SNP のような 1 塩基の分岐が連なる部分（自明なバブルの連鎖）を 1 つのノードに畳んでから DB を作る。ノードが 4〜6 倍減り、細かい分岐が画面の場所を取らなくなる。畳み込みは元に戻せる形で記録し、アレルの差分と元のノードとの対応は `<db>.collapse` に入る。整数でないセグメント id のグラフでは使えない。
