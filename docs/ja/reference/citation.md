# 引用

[English](../../en/reference/citation.md)

AMIPA を使った結果を発表するときは、AMIPA 本体と、実際に使った工程の外部ツールを引用してほしい。図の隅に出る版の刻印（`amipa version`、`GET /api/version` でも確かめられる）を Methods に添えると、再現に必要な情報が揃う。

## AMIPA 本体

[CITATION.cff](../../../CITATION.cff) を参照（GitHub の "Cite this repository" からも取れる）。

## 同梱しているツール（使った工程だけ）

| 工程 | ツール | 引用 |
|---|---|---|
| バブル分解（`--decomposer bubblefinder`、既定） | BubbleFinder | Harviainen J, Sena F, Moumard C, Politov A, Schmidt S, Tomescu AI. Scalable Computation of Ultrabubbles in Pangenomes by Orienting Bidirected Graphs. bioRxiv 2026.03.28.714704 (2026). あわせて Sena F, et al. Identifying all snarls and superbubbles in linear-time, via a unified SPQR-tree framework. arXiv:2511.21919 (2025) |
| バブル分解（`--decomposer billi`） | Billi | Bhat SG, Mahajan D, Jain C. Billi: Accurate and Scalable Bubble Detection in Pangenome Graphs. bioRxiv (2026). doi:10.1101/2025.11.21.689636 |
| 解像度の階層 | Infomap | Rosvall M, Bergstrom CT. Maps of random walks on complex networks reveal community structure. PNAS 105:1118–1123 (2008)。あわせて Infomap のソフトウェア本体（mapequation.org）も参照 |
| 数値計算 | NumPy | Harris CR, et al. Array programming with NumPy. Nature 585:357–362 (2020) |
| 同上 | SciPy | Virtanen P, et al. SciPy 1.0. Nature Methods 17:261–272 (2020) |
| 同上 | Numba | Lam SK, Pitrou A, Seibert S. Numba: a LLVM-based Python JIT compiler. LLVM-HPC (2015) |
| 配列の入出力 | Biopython | Cock PJA, et al. Biopython. Bioinformatics 25:1422–1423 (2009) |
| 図 | Matplotlib | Hunter JD. Matplotlib: A 2D graphics environment. Comput Sci Eng 9:90–95 (2007) |

SQLite は引用を求めていない（パブリックドメイン）。

どの分解器を使ったかは、DB の `manifest.json` の `lod.decomposer` で確かめられる。

## AMIPA の外で使ったもの

AMIPA はグラフ（GFA）と整列（GAF）を入力として受け取るだけなので、それらを作ったツールとデータは利用者の側で引用する。例:

- グラフの構築（Minigraph-Cactus、PGGB など）
- リードの整列（`vg giraffe` など）: Sirén J, et al. Pangenomics enables genotyping of known structural variants in 5202 diverse genomes. Science 374:abg8871 (2021)
- 使ったパンゲノム（例: Human Pangenome Reference Consortium のグラフ）: Liao WW, et al. A draft human pangenome reference. Nature 617:312–324 (2023)
- アノテーション（GENCODE、UCSC の染色体バンドなど）

## 記載例

> パンゲノムグラフは AMIPA v0.1 (commit abc1234) で多解像度の DB に変換し、可視化した。バブル分解には BubbleFinder (Harviainen et al. 2026)、解像度の階層の構築には Infomap (Rosvall & Bergstrom 2008) を用いた。
