# Citation

[日本語](../../ja/reference/citation.md)

When publishing results obtained with AMIPA, please cite AMIPA itself and the external tools of the steps you actually used. Adding the version stamp shown in the corner of figures (also from `amipa version` or `GET /api/version`) to the Methods gives what is needed for reproduction.

## AMIPA

See [CITATION.cff](../../../CITATION.cff) (also available from "Cite this repository" on GitHub).

## Bundled tools (only the steps you used)

| Step | Tool | Reference |
|---|---|---|
| Bubble decomposition (`--decomposer bubblefinder`, default) | BubbleFinder | Harviainen J, Sena F, Moumard C, Politov A, Schmidt S, Tomescu AI. Scalable Computation of Ultrabubbles in Pangenomes by Orienting Bidirected Graphs. bioRxiv 2026.03.28.714704 (2026). Also Sena F, et al. Identifying all snarls and superbubbles in linear-time, via a unified SPQR-tree framework. arXiv:2511.21919 (2025) |
| Bubble decomposition (`--decomposer billi`) | Billi | Bhat SG, Mahajan D, Jain C. Billi: Accurate and Scalable Bubble Detection in Pangenome Graphs. bioRxiv (2026). doi:10.1101/2025.11.21.689636 |
| Resolution hierarchy | Infomap | Rosvall M, Bergstrom CT. Maps of random walks on complex networks reveal community structure. PNAS 105:1118–1123 (2008); see also the Infomap software (mapequation.org) |
| Numerics | NumPy | Harris CR, et al. Array programming with NumPy. Nature 585:357–362 (2020) |
| Numerics | SciPy | Virtanen P, et al. SciPy 1.0. Nature Methods 17:261–272 (2020) |
| Numerics | Numba | Lam SK, Pitrou A, Seibert S. Numba: a LLVM-based Python JIT compiler. LLVM-HPC (2015) |
| Sequence I/O | Biopython | Cock PJA, et al. Biopython. Bioinformatics 25:1422–1423 (2009) |
| Figures | Matplotlib | Hunter JD. Matplotlib: A 2D graphics environment. Comput Sci Eng 9:90–95 (2007) |

SQLite does not ask to be cited (public domain).

The decomposer used is recorded as `lod.decomposer` in the DB's `manifest.json`.

## Things used outside AMIPA

AMIPA only takes graphs (GFA) and alignments (GAF) as input, so cite the tools and data that produced them yourself. For example:

- Graph construction (Minigraph-Cactus, PGGB, ...)
- Read alignment (`vg giraffe`, ...): Sirén J, et al. Pangenomics enables genotyping of known structural variants in 5202 diverse genomes. Science 374:abg8871 (2021)
- The pangenome used (e.g. the Human Pangenome Reference Consortium graphs): Liao WW, et al. A draft human pangenome reference. Nature 617:312–324 (2023)
- Annotations (GENCODE, UCSC chromosome bands, ...)

## Example

> The pangenome graph was converted to a multi-resolution DB and visualised with AMIPA v0.1 (commit abc1234). Bubbles were decomposed with BubbleFinder (Harviainen et al. 2026) and the resolution hierarchy was built with Infomap (Rosvall & Bergstrom 2008).
