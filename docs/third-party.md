# 依存している外部ソフトウェア

AMIPA は以下を利用している。それぞれのライセンスは各プロジェクトを参照。

| ソフトウェア | 用途 | 出典 |
|---|---|---|
| povu | バブル（入れ子の分岐構造）の分解 | https://github.com/pangenome/povu |
| Infomap | コミュニティ検出（解像度階層の構築） | https://www.mapequation.org/ |
| SQLite（R*Tree / FTS5 を含む） | アトラスの格納と空間・文字列索引 | https://sqlite.org/ |
| NumPy / SciPy / numba | 数値計算とレイアウト | — |
| zstd（python-zstandard / zstd クレート経由） | リード実体の圧縮容器 | https://facebook.github.io/zstd/ |
| Biopython | 旧アトラスの BGZF 読み出しと配列の取り扱い | https://biopython.org/ |
| PixiJS / React | 描画と画面 | — |
| better-sqlite3 / Express | 閲覧側のサーバ | — |

リード実体の容器は **zstd seekable format v0.1.0** の仕様に沿った自前実装
（`prep/amipa_prep/zstd_seek.py` と `prep/core/reads_core/`）で、zstd の contrib
コードは取り込んでいない。圧縮・伸長そのものは上記の libzstd を使う。

入力データの形式は GFA（パンゲノムグラフ）と GAF（グラフへのリード整列）を前提にしている。

デモに用いるグラフやアノテーションのデータは、それぞれの配布元の条件に従う
（ヒトパンゲノム参照コンソーシアムのグラフ、UCSC の染色体バンド、GENCODE の遺伝子注釈など）。
