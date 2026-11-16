# Linear の地点の一覧の例

List ▾ → Load… で読む（貼り付けでもよい）。値・遺伝型は動作確認用の架空のもの。

| ファイル | 形式 | 対象 DB | 中身 |
|---|---|---|---|
| human_genes.txt | 1 行 1 項目 | chr202122v2・mc-grch38-v1 | 遺伝子名 7、GRCh38 と CHM13 の座標、ノード名、見つからない名前 |
| human_regions.bed | BED（0 始まり） | 同上 | 6 遺伝子の区間、chr22 の p 腕（錨の無い所）、無い染色体 |
| human_sv.vcf | VCF | 同上 | DEL・INV・INS・BND・SNV。6 株＋CHM13 の遺伝型 → Group by の List（carrier / non-carrier） |
| human_mixed.jsonl | JSON Lines（内部形式） | chr202122v2 | 地点の種類すべて（遺伝子・参照・CHM13・BND の 2 端と群・合意座標・ノード）。1 つは Later とメモ付き |
| ecoli50_genes.txt | 1 行 1 項目 | ecoli50 | dnaA・lacZ・recA・rpoB・thrA、参照のコンティグの座標、別の株のコンティグの座標（path:）、ノード名 |
| ecoli50_regions.bed | BED | ecoli50 | 4 遺伝子の区間と 50 kb の区間（コンティグ NC_017631.1） |

わざと失敗する地点（「✗ 理由」が帯に出る）: NO_SUCH_GENE、chr99。chr22:1,001-2,000 は移動するが「錨の無い所（最寄りの錨まで 15.15 Mb）」と出る。
ノード名と合意座標（x:）は chr202122v2 の値なので、全ゲノムでは別の場所か見つからない。

確かめ方（全地点を引くだけ。移動しない）:

```
cd viewer/frontend
AMIPA_BASE=http://localhost:33041 AMIPA_DIST=$PWD/dist AMIPA_DB=chr202122v2.db \
  AMIPA_FILES="human_genes.txt human_regions.bed human_sv.vcf human_mixed.jsonl" node ../../tests/smoke/wlfiles.mjs
```

11-16 の結果（chr202122v2）: APOL1 は遺伝子名で x 3,215,414–3,215,702、GRCh38 の座標で 3,215,409–3,215,700、CHM13 の座標（36,714,080-36,726,149、GRCh38 の +460,116）で 3,215,412–3,215,701。
ecoli50 の lacZ は遺伝子名で 29,136–30,063、参照の座標で 29,136–30,064。
