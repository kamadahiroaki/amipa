# Commands and options

[日本語](../../ja/reference/cli.md)

The `amipa` command and the options of each `amipa prep` subcommand, organised from `amipa prep <subcommand> --help` (whose text is in Japanese). For the workflow, see [Preparing your data](../setup/03-your-data.md) and [Large graphs](../setup/04-large-graphs.md).

## amipa (container entry point)

Both images use `amipa` as the entry point. With Docker call `docker run ... <image> <subcommand>`; with Apptainer `apptainer exec --cleanenv ... <sif> amipa <subcommand>`.

| Subcommand | Image | Purpose |
|---|---|---|
| `amipa prep ...` | amipa-prep | Preprocessing (GFA → DB), below |
| `amipa serve` | amipa-viewer | Start the viewer (the viewer image's default). Settings in [Viewer server settings](viewer-config.md) |
| `amipa check [DB]` | amipa-viewer | Check DBs: all DBs in `DB_DIR`, or the one given (a name, or a path containing `/`). Does not read whole files, so it takes seconds even for large DBs. Prints `RESULT: OK` and exits 0, or `RESULT: FAIL` and exits 1 |
| `amipa version` | both | Version stamp (`version`, `commit`, `runtime`) as JSON |
| `amipa licenses` | both | The list of bundled components (NOTICE) and the full AMIPA license text |
| `amipa help` | both | List of subcommands |

Without containers, call `python3 prep/amipa_prep/cli.py` instead of `amipa prep` (same arguments).

## amipa prep subcommands

| Subcommand | Purpose | Stages run |
|---|---|---|
| `run` | Build a DB from a GFA; finished stages are skipped | all (a subset with `--from` / `--only`) |
| `status --out DIR` | Show state, seconds, finish time and peak memory per stage | — |
| `plan` | Estimate slots, memory and time per stage. Writes nothing. Requires `--gfa`; `--json` for JSON | — |
| `add-annot` | Add `--band`, `--gene` or `--region` to an existing DB (at least one required) | annot, bundle |
| `add-reads` | Add reads to an existing DB (`--reads` required). Rebuilds the tile index, which uses read counts for edge widths | reads, tiled, bundle |
| `add-read-labels` | Label reads (`--read-labels` required). Alignments are not rebuilt | rlabel, bundle |
| `add-tiled` | Rebuild the tile index for drawing (the main DB is not rebuilt) | tiled, bundle |

All subcommands except `status` accept the same set of options; options unrelated to the stages a subcommand runs have no effect. The stages are described in [Preprocessing stages](pipeline.md).

## Options

### Input and output

| Option | Default | Meaning |
|---|---|---|
| `--out DIR` | (required) | Output directory (the DB). An existing one is resumed |
| `--gfa FILE` | — | Input GFA (`.gz`, `.zst` accepted). Needed for the first `run` and for `plan` |
| `--name NAME` | GFA file name, or the existing DB name | Name of the main DB file (`<NAME>.db`) |
| `--ref-key SAMPLE` | automatic | Sample of the reference path. Automatic: GFA header `RS:Z` (GRCh38, then CHM13 if several) → `GRCh38` → `CHM13` → first path; case-insensitive ([How the reference is chosen](../setup/03-your-data.md#how-the-reference-is-chosen)) |
| `--collapse` | off | Collapse chains of trivial bubbles (runs of single-base branches such as SNPs) into single nodes before building. Recorded reversibly; differences and the mapping to original nodes go to `<db>.collapse`. 4–6 fold fewer nodes. Not available with non-integer segment ids |

### Annotations

| Option | Default | Meaning |
|---|---|---|
| `--gff-dir DIR` | — | Per-strain GFF directory. File names `<sample>.{gff,gff3,gtf}[.gz,.zst]`. Builds `<db>.genes` and related files (genes in Linear) |
| `--band FILE` | — | Chromosome bands (UCSC cytoBand, reference coordinates) |
| `--gene FILE` | — | Reference genes (GTF/GFF3, reference coordinates; gene lines required) |
| `--gene-ref-path SAMPLE` | the reference | Sample of the path followed when mapping `--gene` |
| `--region FILE` | — | BED of regions (centromeres, ...) |
| `--region-ref SAMPLE` | `chm13` | Sample whose coordinates `--region` uses |
| `--ann-rmsk FILE` | — | RepeatMasker table (UCSC `rmsk.txt`, reference coordinates); goes to `<db>.ann` |
| `--ann-vcf SAMPLE=VCF` | — | A sample's variants (reference coordinates). Repeatable |
| `--ann-bed SAMPLE=BED` | — | A sample's benchmark regions (variants outside were not assessed). Repeatable |

### Reads

| Option | Default | Meaning |
|---|---|---|
| `--reads SAMPLE=GAF` | — | Read alignments. Repeatable |
| `--reads-append` | off | With `add-reads`, append samples to the existing index (list only the new samples in `--reads`). Without it `add-reads` rebuilds from the listed samples. Not allowed with `run` |
| `--reads-level N` | 9 | zstd level for read records. Higher is smaller and slower to build (viewing speed unchanged) |
| `--reads-keep-tags` | off | Keep all GAF tags (by default `bq:Z`, unused for display, is dropped) |
| `--reads-chunk-visits N` | 500 million | Node visits per index chunk. Lower means less build memory and more chunks |
| `--reads-no-names` | off | Do not store read names or their search index. Display is unchanged; only search by read name is unavailable |
| `--reads-force-mismatch` | off | Continue even if the pre-import check (match rate between GAF node names and the DB) is low |
| `--read-labels SAMPLE=TSV` | — | Read labels (`read name<TAB>label`). Repeatable |

### Stage control

| Option | Meaning |
|---|---|
| `--from STAGE` | Redo that stage and everything after it (their records are cleared first) |
| `--only STAGE` | Run only that stage (followed by `bundle`) |
| `--force` | Redo all stages |
| `--dry-run` | Print the commands only |
| `--no-trav` | Do not build the Linear index (`<db>.trav` and related files); the gene stage is skipped too |
| `--no-tiled` | Do not build the tile index. The viewer cannot open the DB without it; use only for testing |

Valid `STAGE` names: `distill`, `collapse`, `decompose`, `lod`, `layout`, `emit`, `trav`, `genes`, `ann`, `annot`, `reads`, `rlabel`, `xdepth`, `tiled`, `bundle` ([Preprocessing stages](pipeline.md)).

### Resources and temporary space

| Option | Default | Meaning |
|---|---|---|
| `--threads N` | visible CPUs | Parallelism; affects bubble decomposition and layout. The hierarchy stage always uses one thread for reproducibility |
| `--tmp DIR` | env `AMIPA_TMP`, else the first of `$TMPDIR` → `/tmp` → `<out>/work/tmp` with enough space | Where the main DB is assembled. A fast node-local disk is best |
| `--spill DIR` | env `AMIPA_SPILL`, else same as `--tmp` | Where haplotype ribbons and similar data spill to disk. Sequential writes, so a shared filesystem is fine, but it can need far more space than the DB |
| `--mem-gib N` | 60% of available memory | Memory budget for layout |
| `--ribbon-disk` | off | Compute haplotype ribbons on disk, keeping memory roughly proportional to the node count (large graphs) |
| `--hash-limit-gb N` | 2 | Files larger than this get no sha256 in `manifest.json` |

### Bubble decomposition and hierarchy

| Option | Default | Meaning |
|---|---|---|
| `--decomposer {bubblefinder,billi}` | env `AMIPA_DECOMPOSER`, else `bubblefinder` | Tool that finds bubbles (regions that branch and merge again). See [Preprocessing stages](pipeline.md#finding-bubbles) |
| `--bubblefinder PATH` | env `AMIPA_BUBBLEFINDER`, else `BubbleFinder` on PATH | BubbleFinder executable |
| `--billi PATH` | env `AMIPA_BILLI`, else `billi` on PATH | Billi executable (not in the distributed image) |
| `--flood {through,legacy}` | `through` | How nodes inside bubbles are assigned when building the hierarchy. `legacy` is the old behaviour (misses the interior of an outer bubble beyond an inner one); use it only to reproduce old DBs |
| `--min-comp N` | 1000 | Connected components with fewer nodes are treated together as small fragments in the hierarchy and layout |

Changing the decomposer reruns bubble decomposition and everything after it. The decomposer used is recorded under `lod` in `manifest.json`.

### Layout tuning

Normally leave these at their defaults.

| Option | Default | Meaning |
|---|---|---|
| `--layout-init {pmds,path,random}` | `pmds` | Initial placement: `pmds` is PivotMDS, `path` lays nodes out in 1D by their position in the paths |
| `--epochs N` | 30 | Layout iterations |
| `--seed N` | 1 | Random seed |
| `--pivots N` | 400 | Number of PivotMDS pivots |
| `--layout-edge-len {off,pathmed,framemed,both}` | `off` | How target edge lengths are set. `pathmed` uses the median distance along the paths between the edge's ends (keeps shortcut edges from overlapping distant regions). `framemed` does the same between pairs of nodes that each path passes only once. `both` combines them |
| `--layout-edge-len-cap X` | 1000 | Upper bound of `pathmed` target lengths |
| `--layout-edge-len-frame-cap X` | 100000 | Upper bound of `framemed` / `both` target lengths |
| `--layout-path-only` | off | Lay out using distances along paths only (for graphs transformed for display) |
| `--layout-path-term {hop,bp}` | `hop` | Distance unit for `--layout-path-only` (steps or bases) |
| `--layout-path-pairs N` | 0 | Pairs per iteration with `--layout-path-only` (0: steps within the component) |
| `--layout-node-coord TSV` | — | Table of a coordinate (bp) per node; layout distances become coordinate differences (experimental) |
| `--layout-coord-circular L` | 0 | Length (bp) if the `--layout-node-coord` coordinates are circular |
| `--layout-coord-smooth λ` | 1 | Strength of smoothing the `--layout-node-coord` coordinates to agree with neighbouring nodes (0 disables) |
| `--layout-coord-gap-min BP` | 20000 | Minimum gap for edges whose target length is taken from `--layout-node-coord` differences |

### Other

| Option | Default | Meaning |
|---|---|---|
| `--python PATH` | the Python running `amipa prep` | Python used to run the stages |
| `--template FILE` | the bundled empty template (env `AMIPA_TEMPLATE_DB`) | Empty DB that supplies the table definitions |
| `--json` | off | JSON output for `plan` |
