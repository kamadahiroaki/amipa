# Preprocessing stages

[日本語](../../ja/reference/pipeline.md)

`amipa prep run` turns a GFA into a multi-resolution DB through a series of stages. Each stage's output stays in the DB directory (intermediate files in `work/`), so a run can be resumed ([Resuming](../setup/04-large-graphs.md#resuming)). Stage names are the ones passed to `--from` and `--only` ([Commands and options](cli.md#stage-control)).

```
GFA ─ distill ─▶ array intermediate ─ decompose ─▶ bubble tree
                     │                                   │
                     └──────────── lod ◀─────────────────┘
                                    │
                        resolution hierarchy ─ layout ─▶ coordinates ─ emit ─▶ multi-layer SQLite (main DB)
                                                                                    │
                            trav (Linear), genes, ann, annot, reads, rlabel, xdepth ◀─┤
                                                                                    │
                                                         tiled (tile index) ─ bundle (inventory)
```

| Stage | What it does | When it runs |
|---|---|---|
| `distill` | Read the GFA | always |
| `collapse` | Collapse trivial bubbles | `--collapse` |
| `decompose` | Find bubbles | always |
| `lod` | Build the resolution hierarchy | always |
| `layout` | Lay out in 2D | always |
| `emit` | Write the multi-layer DB | always |
| `trav` | Build the Linear index | when the graph has paths (off with `--no-trav`) |
| `genes` | Map per-strain genes | `--gff-dir` |
| `ann` | Store reference annotations | `--ann-rmsk`, `--ann-vcf`, `--ann-bed` |
| `annot` | Map reference annotations onto nodes | `--band`, `--gene`, `--region` (graphs with paths) |
| `reads` | Import reads | `--reads` |
| `rlabel` | Label reads | `--read-labels` |
| `xdepth` | Count read depth | when reads and the Linear index exist |
| `tiled` | Build the tile index for drawing | always (without it, via `--no-tiled`, the DB cannot be viewed) |
| `bundle` | Write the inventory | always (rebuilt last) |

## Reading the GFA

Stage: `distill`

Reads the GFA once and turns nodes, edges, paths and sequences into arrays indexed by dense integer numbers. Later stages never read the GFA again; at whole-genome scale this is the only full pass over it.

- Reads `.gz` and `.zst` directly.
- Stops with an example if any L line overlaps (CIGAR other than `0M` or `*`).
- Records the GFA header `RS:Z` (reference samples) for choosing the reference ([How the reference is chosen](../setup/03-your-data.md#how-the-reference-is-chosen)).
- If some segment ids are not integers, numbers the segments internally in S-line order and writes the original names to `<db>.segnames`.

## Collapsing trivial bubbles

Stage: `collapse` (only with `--collapse`)

Writes a GFA in which runs of single-base branches such as SNPs (chains of trivial bubbles) are collapsed into single nodes, and reads it again. Later stages see only the collapsed graph. Allele differences and the mapping to the original nodes go to `<db>.collapse`.

## Finding bubbles

Stage: `decompose`

Finds the nested bubbles of the graph (regions that branch and merge again) and writes them as a tree, using one external tool (`--decomposer`).

| Decomposer | Characteristics |
|---|---|
| `bubblefinder` (default) | Ultrabubbles from [BubbleFinder](https://github.com/algbio/BubbleFinder). Fastest and lightest (minutes and tens of GB at whole-genome scale). By definition it does not report bubbles containing cycles (tandem repeats, parts of circular genomes), so those regions become a fragmented hierarchy in the next stage |
| `billi` | Panbubbles from [Billi](https://github.com/at-cg/billi). Also finds bubbles with cycles and reports nesting more accurately. Several times slower and heavier than BubbleFinder; single-threaded |

Both outputs are converted to the same format, which is all the next stage reads. Paths (P and W lines) are removed before decomposition. The decomposers stop on connected components without ends (pure cycles); only then each such component is opened at one unbranched node, the run is repeated, and the result is mapped back to the original nodes.

The distributed image does not include Billi (its repository has no license statement, so it cannot be redistributed). To use Billi, obtain and build it yourself and pass its location with `--billi` (or the environment variable `AMIPA_BILLI`).

The tools name bubbles differently (BubbleFinder: ultrabubble; Billi: panbubble); AMIPA calls both "bubbles".

## Building the resolution hierarchy

Stage: `lod`

Merges the bubble tree and the graph's community structure (Infomap) into one tree that decides which nodes are shown at which resolution. Each level of this tree is called a layer. In coarser layers, one node on screen stands for more of the original nodes.

Each node is assigned to the deepest bubble that contains it (bubbles are processed from the deepest, walking the interior from entrance to exit; when walking an outer bubble, parts already assigned to inner bubbles are passed through). Bubble nesting alone gives uneven granularity, and communities alone do not follow biological structure, so both are combined.

This stage is fixed to one thread for reproducibility (running it in parallel changes the result).

## Laying out in 2D

Stage: `layout`

Computes 2D coordinates from the graph's connectivity alone (stochastic gradient descent initialised with PivotMDS). The layout is not forced into the genome's one-dimensional order, so the nesting of bubbles stays visible. This stage and bubble decomposition are the only ones that use many cores. Tuning options: [Layout tuning](cli.md#layout-tuning).

## Writing the multi-layer DB

Stage: `emit`

Writes the nodes and edges of each layer to SQLite, together with search indexes, reference coordinates, sequences, and haplotype coverage (which haplotypes pass which nodes). The spatial index is not stored in the main DB; the later `tiled` stage writes it to a separate file.

This stage is dominated by random writes, so pointing `--tmp` to a fast local disk speeds it up considerably (building directly on a shared filesystem waits on the network).

## Building the Linear index

Stage: `trav`

Builds the data for the Linear panel at the bottom of the page, which compares order, orientation, deletions and duplications across haplotypes row by row.

- Anchor: a node that a haplotype passes exactly once and that most haplotypes pass in the same order. Anchors are the landmarks that align the haplotypes.
- Consensus coordinate: the shared horizontal axis obtained by ordering anchors as most haplotypes pass them. The horizontal axis of Linear is this coordinate.
- Traversal: a stretch where one contig moves monotonically along the consensus coordinate. A contig passing the same stretch twice has two traversals (a duplication).

The reference path's order determines the orientation of the consensus coordinate and the order of chromosomes. Along with `<db>.trav`, range indexes (`.travx`, `.xtiles`, `.anc`, `.refx`) are built ([DB format](db-format.md)).

## Mapping per-strain genes

Stage: `genes`

Streams the per-strain GFFs (GFF3/GTF) and maps lines whose seqid is a contig of a graph path onto ranges of that path (memory depends on the number of lines in the graph, not on the GFF size). Paths without annotation receive genes from annotated paths through shared nodes. Then the gene search index and, for each projected gene, a loss-of-function indication (from assembling and translating the CDS) are precomputed ([DB format](db-format.md#genes)).

## Storing reference annotations

Stage: `ann`

Keeps the RepeatMasker table and the samples' VCF and BED files in reference coordinates (`<db>.ann`). The viewer matches them against the reference position of each column in the base row of Linear. Lines on contigs not on the reference path are not read.

## Mapping reference annotations onto nodes

Stage: `annot`

Reads chromosome band tables, GTF/GFF3 and BED, and maps them onto nodes by following the reference path (not built for graphs without paths). No external tools are used. The main DB is not modified; the result goes to `<db>.annot`.

## Importing reads

Stage: `reads`

Repacks the GAF as seekable zstd (independent compressed blocks of 256 KiB plus a table of their positions) and stores only the index in `<db>.reads`. For display, only the needed block is decompressed to extract a line. Tags not used for display (`bq:Z` by default) are not stored, so the same content fits in 1/8 of BGZF. Before importing, the match rate between GAF node names and the DB is checked.

## Labelling reads

Stage: `rlabel`

Maps a `read name<TAB>label` table onto the alignment numbers of the read index and writes `<db>.rlabel`. Alignments and the tile index are not rebuilt.

## Counting read depth

Stage: `xdepth`

For each consensus coordinate, counts the alignments spanning it per sample, and stores coarse levels (averages over 1, 64 and 4,096 coordinates). Read coverage over wide ranges can then be drawn by reading these values.

## Building the tile index

Stage: `tiled`

Writes a separate file (`<db>.tiled`) in which nodes and edges of each layer are reordered by tile (Z-order). Fetching the visible range, estimating counts, haplotype filtering and edge widths (haplotype and read counts) all come from here. A rectangle on screen becomes a contiguous range of the file, so fetching the visible range stays fast even for large DBs on network filesystems. It is the viewer's only spatial index; without it the DB cannot be opened. It is rebuilt when reads are added.

## Writing the inventory

Stage: `bundle`

Writes `manifest.json` (version, contents, size and sha256 of each file). It is rebuilt last whichever stages ran.
