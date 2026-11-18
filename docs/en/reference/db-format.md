# DB format

[日本語](../../ja/reference/db-format.md)

An AMIPA DB is one directory: the main DB (multi-layer SQLite) and companion files placed next to it (sidecars). Copy the whole directory and it opens on another machine as is. The stage that writes each file is in [Preprocessing stages](pipeline.md).

## Directory contents

```
graph.amipa/
  manifest.json        inventory (version, contents, size and sha256 of each file)
  graph.db             main DB (multi-layer SQLite)
  graph.db.tiled       required: tile index for drawing (the viewer's only spatial index)
  graph.db.distill/    optional: path walks and sequences (input for the base row of Linear)
  graph.db.annot       optional: reference annotations mapped onto nodes (bands, genes, regions)
  graph.db.reads       optional: read alignment index (append-only chunks; samples can be added later)
  graph.db.trav        optional: Linear index (anchors, consensus coordinates, traversals, boundaries); built by default when there are paths
  graph.db.travx       optional, built with .trav: range index over consensus coordinates (plus the array file .travx.arr)
  graph.db.xtiles      optional, built with .trav: traversals grouped by consensus-coordinate tile
  graph.db.anc         optional, built with .trav: original node → ancestors on each layer
  graph.db.refx        optional, built with .trav: anchor points between path coordinates and consensus coordinates (coordinate jumps, BED export)
  graph.db.tiledx      optional: consensus coordinates of nodes in the same order as .tiled (when Linear exists)
  graph.db.xdepth      optional: read depth per consensus coordinate (with reads and .trav)
  graph.db.genes       optional: per-strain genes; keeps the input GFF complete (below)
  graph.db.genex       optional, built with .genes: gene lane index and loss-of-function indications
  graph.db.gsearch     optional, built with .genes: gene search index
  graph.db.ann         optional: annotations in reference coordinates (RepeatMasker repeats, sample variants and benchmark regions)
  graph.db.segnames    optional: internal node names ↔ original segment names (only for non-integer ids)
  graph.db.rlabel      optional: read labels (e.g. paternal / maternal)
  graph.db.collapse    optional: differences of collapsed bubbles and mapping to original nodes (with --collapse)
  reads/               optional: read records (seekable zstd GAF)
  work/                intermediate files and logs (used for resuming; can be removed before distribution)
  state.json           which stages have finished
```

Terms:

- Layer: a resolution level. In coarser layers, one node stands for more of the original nodes. Nodes of the finest layer (leaves) correspond to the segments of the original graph.
- Anchor, consensus coordinate, traversal: the concepts behind the horizontal axis of Linear ([Preprocessing stages](pipeline.md#building-the-linear-index)).

## Rules

- Sidecars belong to one main DB and are matched by file name, `<main DB file name>.<kind>`. Mixing files from different builds makes indexes point to the wrong places and break silently. Move the whole DB directory. When renaming, rename the sidecars to match.
- `manifest.json` records the sha256 of each file, so mix-ups can be detected (files larger than `--hash-limit-gb` are skipped).
- `.distill` must be a real directory, not a symbolic link; a link breaks as soon as the DB is moved to another machine.
- Read records (`reads/`) are located relative to the index, so they follow when the DB is moved.
- Read records are not the input GAF as is. They are repacked into independent zstd blocks so that single lines can be extracted, and tags not used for display (base qualities `bq:Z` by default) are dropped. Dropped tags are recorded in the index as `read_meta.dropped_tags`. `zstd -d` decompresses them directly (the trailing position table is skipped).
- `.tiled` is required. If it is missing, older than v4 or empty, the DB cannot be viewed (rebuild with `amipa prep add-tiled`).
- The main DB is named `<name>.db`. Older DBs named `<name>.layered.db` are still read.

## Main DB

Multi-layer SQLite.

| Table | Content |
|---|---|
| `nodes` / `edges` | Nodes and edges of each layer (coordinates, radius, orientation, size, coverage) |
| `stats` | Node count per layer and the calibration of which layer to show at which zoom |
| `node_contig_cov` and others | Which haplotypes pass which nodes (ribbons, filtering) |
| `ref_contigs` / `nodes.ref_bp` | Reference coordinates (coordinate search and display) |
| `leaf_seq` | Sequences of leaf nodes |
| `db_meta` | Version, build time, list of features (`features`) |

The viewer offers only the features that `features` and the files present allow. Missing parts do not break the whole; only that feature is disabled.

The old spatial index (`nodes_rtree`) and haplotype-filter index (`.hapidx`) are no longer used. If an old DB still has them, the viewer ignores them; the spatial index is in `.tiled`.

## Tile index

`graph.db.tiled`. Nodes and edges of each layer reordered by tile (Z-order), with masks for haplotype filtering. Edge rows also carry haplotype counts and read support, so edge widths can be drawn without looking up the main DB or `.reads` per edge. `schema` in `meta` is the format version.

## Genes

`graph.db.genes`. Keeps each strain's GFF3 as is, with tables the viewer uses to place genes, CDS and exons on each row. Of the input GFF, every line whose seqid is on a graph path and every `#` line is kept, and `GET /api/trav/gff?db=&acc=` writes it back unchanged (`acc` is the GFF file name, i.e. the path sample). Lines with seqids not in the graph are not read.

| Table | Content |
|---|---|
| `feature` | Every GFF data line: the 9 columns as is (`attrs` is column 9 verbatim), `id`, `parent` (row of the first Parent), `gid` (owning gene), `lineno` |
| `feature_tok` | Path range of each line (only lines whose seqid is on a graph path) |
| `gff_header` | Lines starting with `#` (`##gff-version`, `##sequence-region`, ...) |
| `gene` / `gene_tok` | Units the viewer draws (gene, pseudogene, RNA, ...; CDS merged into gene) and their path ranges. Genes projected to unannotated paths through shared nodes carry `proj` (source) and `frac` (match fraction) |

`meta.format` 2 or higher means `feature` and the tables after it exist. With format 1, gene-level display still works.

Projected genes have `gene_qc(gid, unanch)` (number of CDS ends that could not be aligned to the source; if 1 or more, no loss-of-function call is made).

### Gene lane index and loss-of-function indications

`graph.db.genex`. Each row of `g_b` is one gene (including projections). `lof_st` is the loss-of-function indication; its values follow `meta.lof_states` (`ok,fs,trunc,nostart,nocds,partial,refdiff`; the last two were added later, so older indexes have only 0–4).

| Value | Name | Meaning |
|---|---|---|
| 0 | `ok` | Unchanged |
| 1 | `fs` | CDS length difference not a multiple of 3 (frameshift) |
| 2 | `trunc` | First stop codon comes before 90% of the source length |
| 3 | `nostart` | The source's start codon is missing |
| 4 | `nocds` | No CDS, or it cannot be assembled |
| 5 | `partial` | Not assessed: the projection is partial (fewer CDS pieces than the source), CDS ends cannot be aligned to the source, or the source annotation is a pseudogene or partial gene (`partial=true`, `cds_start_NF`, ...) |
| 6 | `refdiff` | Differs from the source (one of 1–3), but at least 90% (and at least 5) of assessable projections share the same difference; the source (reference) is likely the outlier |

A projection is compared with the same transcript of the source gene. Transcripts are chosen by `MANE_Select`, then `Ensembl_canonical`, then CDS length; `protein_coding_LoF`, `nonsense_mediated_decay` and `cds_start_NF` / `cds_end_NF` transcripts are avoided when others exist. Transcripts with Sec in `transl_except` or a `stop_codon_redefined_as_selenocysteine` line do not treat TGA as a stop. Genes with `transl_table=11` also accept CTG, ATT, ATC and ATA as start codons.

## Linear index

`graph.db.trav`. Data for the Linear panel (block, anchor column, node and base rows), built from `.distill` (path walks).

- Anchor: a node that a haplotype passes exactly once and that most haplotypes pass in the same order. The order of anchors is the consensus coordinate (horizontal axis).
- Traversal: a contig passing a monotonic stretch of the consensus coordinate. Passing the same stretch twice gives two traversals (a duplication).
- Boundary: the ends of traversals and the places where the number of haplotypes passing changes. The smallest intervals between boundaries are called atoms.

| Table | Content |
|---|---|
| `haps` / `paths` | Haplotypes and paths (contigs). Contigs entirely contained in another contig of the same strain are `excluded` |
| `trav` | Traversals: path, path range (`i0`–`i1`), consensus range (`x0`–`x1`), orientation, copy number, anchor count, bp |
| `copies` / `reps` | Overlaps between traversals of the same contig (duplications), and runs of nodes occurring twice or more within a haplotype (repeats) |
| `bounds` / `atoms` | Boundaries (supporting haplotype count, persistence) and atoms |
| `super` | Consensus coordinates of upper-layer nodes (majority of descendant leaves) |
| `arrays` | Node → consensus coordinate (`x_of_dense`; `x_fill` for non-anchors), consensus coordinate → node (`dense_of_x`), cumulative bp per coordinate (`xbp`), ... |

The orientation and order of the consensus coordinate follow the reference path ([How the reference is chosen](../setup/03-your-data.md#how-the-reference-is-chosen)); multiple chromosomes are ordered as in the reference.

## Segment names

`graph.db.segnames`. SQLite. `segs(id, name)` maps the internal number (the digits of the leaf name `n<id>`) to the original segment name, with an index on `name`. Not built when all segment ids are integers (then the original id is the internal name `n<id>` without the `n`). The viewer reads it only for display, search and export.

## Read labels

`graph.db.rlabel`. SQLite. `label(lid, sample_no, label)` is the per-sample label dictionary and `aln_label(aln_id, lid)` maps alignments to labels. `reads_size` in `meta` is the size of `graph.db.reads` when the labels were made; if it no longer matches (the read index was rebuilt), the viewer ignores this file. Alignments not in the table are unlabelled and are shown as "no label" within labelled samples.

## Checking

```bash
amipa check                 # all DBs in DB_DIR
amipa check graph.db
```

Checks required tables, layers, the tile index, and the annotation, read and segment-name sidecars without reading whole files (seconds even for large DBs).

Releases that change the DB format describe the change on this page.
