# Third-party software

[日本語](../../ja/reference/third-party.md)

AMIPA uses the following. See each project for its license. Versions and sources of bundled components are in [NOTICE](../../../NOTICE).

| Software | Use | Source |
|---|---|---|
| BubbleFinder | Bubble (nested branching structure) decomposition (default) | https://github.com/algbio/BubbleFinder |
| Billi | Bubble decomposition (alternative; not in the distributed image) | https://github.com/at-cg/billi |
| Infomap | Community detection (building the resolution hierarchy) | https://www.mapequation.org/ |
| SQLite (including FTS5) | DB storage and the name search index | https://sqlite.org/ |
| NumPy / SciPy / Numba | Numerics and layout | — |
| zstd (via python-zstandard / the zstd crate) | Compression container for read records | https://facebook.github.io/zstd/ |
| Biopython | Reading BGZF from old DBs, sequence handling | https://biopython.org/ |
| PixiJS / React | Rendering and UI | — |
| better-sqlite3 / Express | Viewer server | — |

The read container is AMIPA's own implementation of the zstd seekable format v0.1.0 (`prep/amipa_prep/zstd_seek.py` and `prep/core/reads_core/`); no zstd contrib code is included. Compression itself uses libzstd above.

Input formats are GFA (pangenome graphs) and GAF (read alignments to graphs).

Graphs and annotations used for demos follow the terms of their providers (Human Pangenome Reference Consortium graphs, UCSC chromosome bands, GENCODE gene annotation, ...).
