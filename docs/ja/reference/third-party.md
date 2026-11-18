# 依存ソフトウェア

[English](../../en/reference/third-party.md)

AMIPA は以下を利用している。それぞれのライセンスは各プロジェクトを参照。同梱物の版と入手元は [NOTICE](../../../NOTICE) にある。

| ソフトウェア | 用途 | 出典 |
|---|---|---|
| BubbleFinder | バブル（入れ子の分岐構造）の分解（既定） | https://github.com/algbio/BubbleFinder |
| Billi | バブルの分解（選択肢。配布イメージには含まない） | https://github.com/at-cg/billi |
| Infomap | コミュニティの検出（解像度の階層の構築） | https://www.mapequation.org/ |
| SQLite（FTS5 を含む） | DB の格納と、名前の検索の索引 | https://sqlite.org/ |
| NumPy / SciPy / Numba | 数値計算とレイアウト | — |
| zstd（python-zstandard / zstd クレート経由） | リードの実体の圧縮の容器 | https://facebook.github.io/zstd/ |
| Biopython | 旧 DB の BGZF の読み出しと配列の取り扱い | https://biopython.org/ |
| PixiJS / React | 描画と画面 | — |
| better-sqlite3 / Express | 閲覧側のサーバ | — |

リードの実体の容器は、zstd seekable format v0.1.0 の仕様に沿った自前の実装（`prep/amipa_prep/zstd_seek.py` と `prep/core/reads_core/`）で、zstd の contrib のコードは取り込んでいない。圧縮・伸長そのものは上記の libzstd を使う。

入力データの形式は GFA（パンゲノムグラフ）と GAF（グラフへのリードの整列）を前提にしている。

デモに使うグラフやアノテーションのデータは、それぞれの配布元の条件に従う（Human Pangenome Reference Consortium のグラフ、UCSC の染色体バンド、GENCODE の遺伝子注釈など）。
