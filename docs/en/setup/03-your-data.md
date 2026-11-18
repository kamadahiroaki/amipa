# Preparing your data

[日本語](../../ja/setup/03-your-data.md)

Requirements for each input, what happens if they are not met, and how to fix it. Running [Your first DB (chrY)](02-first-db.md) once first makes problems easier to locate.

The basic command is a single line; annotations and reads are added to the same command.

```bash
amipa prep run --gfa graph.gfa.gz --out graph.amipa --threads 16
```

From a container, use `docker run ... ghcr.io/kamadahiroaki/amipa-prep prep run ...` or `apptainer exec --cleanenv ... amipa-prep.sif amipa prep run ...` ([Install](01-install.md)). All options are listed in [Commands and options](../reference/cli.md).

## Graph (GFA)

| Requirement | If not met |
|---|---|
| GFA 1.0 / 1.1 (S, L, P, W lines) | Other lines are ignored |
| `.gz` or `.zst` compressed is fine | No need to decompress |
| Blunt graph (no overlaps): L-line CIGAR is `0M` or `*` | A single overlapping L line stops the first stage with "重なりのある L 行が N 本ある" (N overlapping L lines) and an example |
| Paths (P, W lines) are optional | Without paths, the Linear (the bottom panel that compares haplotypes row by row), gene and reference-annotation stages are skipped; the DB shows the graph only |
| Segment ids need not be integers | See "Segment names" below |

Overlaps are rejected because ignoring them would duplicate the overlapping bases at every junction of a path sequence. Convert de Bruijn graphs (Bifrost, Cuttlefish, BCALM, ...) to a GFA without overlaps first.

The `SN`/`SO` tags of minigraph rGFA (reference coordinates) are not used yet. A path-less rGFA gets no reference coordinates or annotations.

### Path names

AMIPA reads the sample (strain), haplotype and contig from each path name. The sample is used to choose the reference, to find `--gff-dir` files and to label haplotype rows; the contig is matched against GFF seqids and shown in coordinates.

| Example path name | Interpretation |
|---|---|
| `HG002#1#chr20` | PanSN (`sample#hap#contig`). W lines are read in this form |
| `HG00438#2#MT#0` | Fourth PanSN field (phase block number); dropped, same as `HG00438#2#MT` |
| `GRCh38#chr20` | Two fields (`sample#contig`), no haplotype |
| `GRCh38.chr1` | Reference shorthand without `#` (whole-genome Minigraph-Cactus graphs). Split at `.` only when the part after it starts with `chr`; versioned names such as `NC_000913.3` are not split |
| `CHM13#chrM[0-15992]` | A trailing subrange `[a-b]` or `[a:b]` is dropped |
| `CASBIT01`, `Reference:1_Sequence:1` | Names without separators are used as both sample and contig |

### Segment names

Segment ids need not be integers (minigraph `s1`, hifiasm or verkko `utg000001l`, ...). If any id is not an integer, preprocessing numbers the segments internally in S-line order and keeps the original names in `<db>.segnames`. Node names on screen, node search and GFA/BED export always use the original names. Give read GAFs with the original names as well; they are translated on import.

Collapsing trivial bubbles (`--collapse`, below) is not supported together with non-integer ids.

## How the reference is chosen

One reference (the sample part of a path name) is used for reference coordinates, jumping to a coordinate, the orientation and chromosome order in Linear, and as the target for `--band`, `--gene` and `--ann-*`. By default the first match in this order is used; sample names are compared case-insensitively (`grch38` equals `GRCh38`).

1. The sample given with `--ref-key`
2. The `RS:Z` tag in the GFA header (written by Minigraph-Cactus). If it lists several, as in `RS:Z:CHM13 GRCh38`, prefer GRCh38, then CHM13, then the first listed
3. `GRCh38`, then `CHM13`
4. The sample of the first path

The chosen reference and the reason are logged once:

```
[amipa ..:..:..] 参照: GRCh38（GFA ヘッダの RS:Z（CHM13 GRCh38）のうち GRCh38）
```

If no path matches `--ref-key`, the rule above is applied instead and the log says so. If reference coordinates or coordinate jumps are missing on screen, check this line first; if it is wrong, run the same `run` again with `--ref-key <sample>`. Only the stages that use the reference and those after them are rerun ([Resuming](04-large-graphs.md#resuming)).

## Genes (GFF/GTF)

There are two ways to add genes.

| Option | Input | On screen |
|---|---|---|
| `--gff-dir <directory>` | GFF3/GTF per strain | Under each haplotype row in Linear, that strain's genes. Strains without annotation get genes projected from annotated ones |
| `--gene <file>` | GTF/GFF3 for the reference only | Gene colouring and labels on the graph, jump to a gene by name |

You can use both.

### Per-strain GFF (`--gff-dir`)

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 --gff-dir gff/
```

Files in the directory are named after the sample of the path names (the part before `#`) with the extension `.gff`, `.gff3` or `.gtf`, optionally compressed with `.gz` or `.zst`.

| Path name | File looked for (any one) |
|---|---|
| `GRCh38#chr20` | `GRCh38.gff3.gz`, `GRCh38.gtf`, ... |
| `GCF_000148365.1#1#NC_017631.1` | `GCF_000148365.1.gff`, ... |
| `CASBIT01` (no `#`) | `CASBIT01.gff`, ... |

The GFF seqid (column 1) must equal the contig of the path name (`chr20` for `GRCh38#chr20`, `MT` for `HG00438#2#MT#0`).

| Situation | What happens |
|---|---|
| No file found for any sample | Stops and prints the expected file names. Rename to match |
| Files missing for some samples | Logs their names and continues. Those strains get genes projected from annotated strains through shared nodes |
| Seqids differ from the path contigs (e.g. GFF `NC_001133.9`, path `S288C#0#chrI`) | That strain gets no genes; the log says "グラフの seqid の行が 1 行も無い" (no lines for the graph's seqids). Rename the seqids or prepare a GFF that matches the path names |
| GFF has seqids not in the graph | Those lines are skipped. You can pass a whole-genome annotation to a one-chromosome graph; memory follows only the lines that are used |
| GTF without gene lines (UCSC `ncbiRefSeq.gtf`, `refGene.gtf`: only transcript, exon, CDS) | Genes are reconstructed from the transcripts sharing a gene_id |
| Graph without paths, or `--no-trav` | The gene stage is skipped (the log says why) |

Every line of the input GFF for the graph's seqids, and every `#` line, is kept in the DB ([DB format](../reference/db-format.md#genes)).

### Reference genes (`--gene`)

`--gene` takes a GTF (GENCODE, ...) or GFF3 (Ensembl, NCBI, SGD, ...) in the coordinates of the reference chosen [above](#how-the-reference-is-chosen). Its seqids must match the reference contig names (`chr20` for `GRCh38#chr20`). If no gene line matches, it stops and shows example reference contig names.

`--gene` needs gene lines (gene or pseudogene in GFF3). Pass UCSC GTFs without gene lines through `--gff-dir`.

Give annotation files as they are; there is no need to project them onto the graph with another tool. AMIPA follows the reference path and maps them onto nodes.

## Reference annotations

Annotations in reference coordinates. All of them follow the reference path, so they are skipped for graphs without paths (and the log says so).

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 \
    --band   cytoBand.txt.gz \
    --gene   gencode.gtf.gz \
    --region regions.bed --region-ref chm13 \
    --ann-rmsk rmsk.txt.gz \
    --ann-vcf HG002=HG002.vcf.gz --ann-bed HG002=HG002.bed
```

| Option | Format | Coordinates | On screen |
|---|---|---|---|
| `--band` | UCSC cytoBand | reference | colouring and labels on the graph |
| `--gene` | GTF/GFF3 (above) | reference | colouring and labels on the graph, jump to gene |
| `--region` | BED (centromeres and other regions) | sample given by `--region-ref` (default `chm13`) | colouring and labels on the graph |
| `--ann-rmsk` | UCSC `rmsk.txt` (RepeatMasker) | reference | repeats in the Linear header |
| `--ann-vcf SAMPLE=VCF` | VCF (e.g. GIAB benchmarks); repeatable | reference | the sample's variants in the Linear header |
| `--ann-bed SAMPLE=BED` | BED (benchmark regions; variants outside were not assessed); repeatable | reference | Linear header |

All may stay `.gz` or `.zst`. If the reference is not GRCh38, `--band` is read in that reference's coordinates too. Lines of `--ann-*` on contigs that are not on the graph's reference path are skipped.

If `--band`, `--gene` or `--region` seems to have no effect, check that the graph has paths and that the seqids match the reference contig names.

## Reads (GAF) and labels

### Reads

```bash
amipa prep run --gfa graph.gfa --out graph.amipa --threads 16 \
    --reads HG002=HG002.gaf.gz --reads HG003=HG003.gaf.gz
```

`--reads` takes `sample=GAF` and can be repeated. Node IDs in the GAF path column must match the segments of the GFA the DB was built from (for example the output of `vg giraffe --named-coordinates`). Align to the same graph the DB was built from.

| Situation | What happens |
|---|---|
| Node IDs do not match the DB | The match rate of the first 10,000 lines is checked before import; if it is low the import fails at once with the cause and the fix. It never silently drops reads and finishes |
| You want to continue anyway | `--reads-force-mismatch` |
| Graph with non-integer segment ids | Give the GAF with the original names |

Reads are repacked into `graph.amipa/reads/<sample>.gaf.zst`, cut into independent zstd blocks so that single lines can be extracted; `zstd -d` decompresses it normally. Tags not used for display are not kept: by default the base qualities `bq:Z` are dropped, which alone removes 70% of a HiFi GAF.

| Option | Meaning |
|---|---|
| `--reads-keep-tags` | Keep all tags |
| `--reads-level 12`–`19` | Smaller files (slower to build, no effect on viewing speed; default 9) |
| `--reads-no-names` | Do not build the read-name search index. Display is unchanged; only search by read name is unavailable. With billions of short reads the name index alone reaches hundreds of GB, so use this for short-read cohorts |
| `--reads-chunk-visits` | Lower the memory used to build the index (below) |

The read index is built in chunks, so build memory stays constant regardless of the number of reads (peak 17 GB for a whole genome with trio HiFi). Lowering `--reads-chunk-visits` reduces it further.

Samples can be appended later:

```bash
amipa prep add-reads --out graph.amipa --reads-append --reads HG005=HG005.gaf.gz
```

`--reads-append` adds samples without touching the existing index and records. `add-reads` without it rebuilds the index from the listed samples only. `add-reads` also rebuilds the tile index (edge widths use read counts). To update the read depth for Linear (`<db>.xdepth`), follow with `amipa prep run --out graph.amipa --only xdepth`.

### Read labels

Use labels to group reads within a sample, for example a trio child's reads by paternal and maternal origin.

```bash
amipa prep add-read-labels --out graph.amipa --read-labels HG002=HG002.labels.tsv
```

The table has one read per line: `read name<TAB>label`. Further columns and lines starting with `#` are ignored. Write read names as in column 1 of the GAF.

Labels are decided outside this step, for example from trio binning (columns 1 and 2 of `yak triobin`) or by converting the output of `whatshap haplotag --output-haplotag-list`. The result goes to `<db>.rlabel`; alignments and the tile index are not rebuilt (to replace labels, rerun only this step). In the base row of Linear, reads within a sample are grouped by label ("HG002 · pat", "HG002 · mat", ...). Passing `--read-labels` to `run` runs the same step.

After rebuilding the reads, run the labels again (the viewer ignores labels made for an older read index).

## Adding things later

These do not rebuild the DB.

```bash
amipa prep add-annot --out graph.amipa --gene gencode.gtf.gz        # --band / --gene / --region
amipa prep add-reads --out graph.amipa --reads HG002=HG002.gaf.gz
amipa prep add-read-labels --out graph.amipa --read-labels HG002=HG002.labels.tsv
amipa prep run --out graph.amipa --only genes --gff-dir gff/        # per-strain genes
amipa prep run --out graph.amipa --only ann --ann-rmsk rmsk.txt.gz  # reference annotations
amipa prep run --out graph.amipa --only trav                        # Linear index
amipa prep run --out graph.amipa --only xdepth                      # read depth
amipa prep add-tiled --out graph.amipa                              # rebuild the tile index
```

## Graphs with many small variants (`--collapse`)

Collapses runs of single-base branches such as SNPs (chains of trivial bubbles) into single nodes before building the DB. The number of nodes drops 4–6 fold, and small branches no longer take up space on screen. The collapse is recorded reversibly; allele differences and the mapping to the original nodes go to `<db>.collapse`. Not available for graphs with non-integer segment ids.
