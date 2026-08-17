# 引用のしかた

AMIPA を使った結果を発表するときは、**AMIPA 本体**と、**実際に使った工程の外部ツール**を引用してください。
図の隅に出る版の刻印（`amipa version` / `GET /api/version` でも確認できます）を Methods に添えると、
再現に必要な情報が揃います。

## AMIPA 本体

`CITATION.cff` を参照（GitHub の "Cite this repository" からも取得できます）。

## 同梱ツール（使った工程だけ）

| 工程 | ツール | 引用 |
|---|---|---|
| バブル分解 | **povu** | Mwaniki MN, Garrison E, Pisanti N. *Popping Bubbles in Pangenome Graphs.* arXiv:2410.20932 (2024) |
| 解像度階層 | **Infomap** | Rosvall M, Bergstrom CT. *Maps of random walks on complex networks reveal community structure.* PNAS 105:1118–1123 (2008) — あわせて Infomap ソフトウェア本体（mapequation.org）も参照 |
| 数値計算 | **NumPy** | Harris CR, et al. *Array programming with NumPy.* Nature 585:357–362 (2020) |
| 同上 | **SciPy** | Virtanen P, et al. *SciPy 1.0.* Nature Methods 17:261–272 (2020) |
| 同上 | **Numba** | Lam SK, Pitrou A, Seibert S. *Numba: a LLVM-based Python JIT compiler.* LLVM-HPC (2015) |
| 配列の入出力 | **Biopython** | Cock PJA, et al. *Biopython.* Bioinformatics 25:1422–1423 (2009) |
| 図 | **Matplotlib** | Hunter JD. *Matplotlib: A 2D graphics environment.* Comput Sci Eng 9:90–95 (2007) |

SQLite は引用を求めていません（パブリックドメイン）。

## AMIPA の外で使ったもの

AMIPA はグラフ（GFA）と整列（GAF）を**入力として受け取る**だけなので、それらを作った
ツールとデータは利用者側で引用してください。例:

- グラフ構築（Minigraph-Cactus / PGGB など）
- リード整列（`vg giraffe` など）: Sirén J, et al. *Pangenomics enables genotyping of known structural variants in 5202 diverse genomes.* Science 374:abg8871 (2021)
- 使用したパンゲノム（例: ヒトパンゲノム参照コンソーシアムのグラフ）: Liao WW, et al. *A draft human pangenome reference.* Nature 617:312–324 (2023)
- アノテーション（GENCODE、UCSC の染色体バンド など）

## 記載例

> パンゲノムグラフは AMIPA v0.1 (commit abc1234) で多解像度アトラスに変換し、可視化した。
> バブル分解には povu (Mwaniki et al. 2024)、解像度階層の構築には Infomap (Rosvall & Bergstrom 2008) を用いた。
