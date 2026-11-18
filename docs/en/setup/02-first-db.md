# Your first DB (chrY)

[日本語](../../ja/setup/02-first-db.md)

Before using your own data, go once through the whole path with a small human chrY graph: GFA to DB, then open it in the browser. This also confirms the installation works. The original recipe is in [examples/chrY/](../../../examples/chrY/).

| | |
|---|---|
| Input GFA | 83 MB (chrY part of HPRC Minigraph-Cactus GRCh38 v1.0) |
| Time | 2–4 min (8 threads) |
| Output | about 250 MB |
| Memory | 8 GB is enough |

The same steps take about 11 hours for a whole genome ([Large graphs](04-large-graphs.md)).

## What you need

Only a GFA. Chromosome bands and reads are optional.

```bash
mkdir -p work && cd work
# GFA (pangenome graph). Use your own if you have one; see "Extracting the input GFA" below
ls chrY.gfa

# optional: chromosome bands (UCSC)
wget -q https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBand.txt.gz -O cytoBand.hg38.txt.gz
# optional: read alignments (GAF aligned to the same graph with vg giraffe --named-coordinates)
ls HG002.gaf.gz
```

### Extracting the input GFA

To take one chromosome out of a whole-genome GFA, keep only the segments and links on that chromosome's paths. With `vg`:

```bash
vg chunk -x hprc-v1.0-mc-grch38.gbz -p GRCh38#0#chrY -c 0 | vg view - > chrY.gfa
```

If you also want reads, the node IDs in the GAF must match this GFA. Renumbering IDs during extraction breaks that, so align to the same GFA (same IDs).

## Build

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/work" -w /work \
  ghcr.io/kamadahiroaki/amipa-prep \
  prep run --gfa /work/chrY.gfa --out /work/chrY.amipa --threads 8 \
      --band  /work/cytoBand.hg38.txt.gz \
      --reads HG002=/work/HG002.gaf.gz
```

- `-u "$(id -u):$(id -g)"` makes you the owner of the output; without it the files belong to root.
- Drop `--band` and `--reads` if you do not have those files.

With Apptainer:

```bash
apptainer exec --cleanenv -B "$PWD:/work" amipa-prep.sif \
  amipa prep run --gfa /work/chrY.gfa --out /work/chrY.amipa --threads 8
```

### Expected output

Each stage (a step of preprocessing) prints what it does, then its time and memory when it finishes.

```
[amipa ..:..:..] build用の一時領域: /tmp（...）
[amipa ..:..:..] [distill] GFA → dense-id numpy 中間（以降の段は GFA を読まない）
[amipa ..:..:..]   ok (..s, 最大 RSS .. GB, ...)
[amipa ..:..:..] 参照: GRCh38（既定の参照 GRCh38）
[amipa ..:..:..] [decompose] バブル分解（bubblefinder）...
  ...
[amipa ..:..:..] 完了。viewer で開く例:
```

The log messages are currently in Japanese. If a run fails, fix the cause and run the same command again: finished stages are skipped. The stages are described in [Preprocessing stages](../reference/pipeline.md).

## Check

See which stages have finished:

```bash
docker run --rm -v "$PWD:/work" ghcr.io/kamadahiroaki/amipa-prep prep status --out /work/chrY.amipa
```

Stages that ran should be `done` (stages not needed for this input show `-`), and the last line should say `manifest.json: あり` (present).

What you should have:

```
chrY.amipa/
  manifest.json      inventory (version, contents, sha256 of each file)
  chrY.db            main DB (multi-layer SQLite)
  chrY.db.distill/   path walks and sequences (input for Linear and the base view)
  chrY.db.trav       index for Linear (the bottom panel that compares haplotypes row by row)
                     .travx .xtiles .anc .refx are built with it
  chrY.db.tiled      tile index for drawing (required to open the DB)
  chrY.db.annot      with --band
  chrY.db.reads      with --reads (read index)
  chrY.db.xdepth     likewise (read depth per coordinate)
  reads/HG002.gaf.zst  likewise (read records)
  work/              intermediate files and logs; can be removed before distribution
  state.json         which stages have finished
```

Each file is described in [DB format](../reference/db-format.md).

Then run the viewer's check:

```bash
docker run --rm -v "$PWD/chrY.amipa:/data:ro" ghcr.io/kamadahiroaki/amipa-viewer check
```

It lists the required tables, the number of layers (resolution levels), the tile index, and the annotation and read sidecars (files placed next to the main DB) as `ok`, and ends with `RESULT: OK`. Those features will then work in the browser. A `FAIL` line states the reason and the fix ([Troubleshooting](troubleshooting.md)).

## Open

```bash
docker run --rm -p 3001:3001 -v "$PWD/chrY.amipa:/data:ro" ghcr.io/kamadahiroaki/amipa-viewer serve
```

Open <http://localhost:3001>. For the screen, start with [The first five minutes](../guide/01-first-look.md).

To build from your own data, continue with [Preparing your data](03-your-data.md).
