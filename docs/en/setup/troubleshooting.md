# Troubleshooting

[日本語](../../ja/setup/troubleshooting.md)

Look up by symptom. Running the viewer's `amipa check` first tells you whether the problem is in the DB ([Your first DB](02-first-db.md#check)).

Messages from preprocessing are currently in Japanese; the quoted text below is what to look for in the log.

## Preprocessing

| Symptom | Cause and fix |
|---|---|
| Killed with `Killed` | Memory limit. Raise `--memory` for a container or the memory request for a job. Per-stage estimates come from `amipa prep plan` ([Large graphs](04-large-graphs.md#estimating-plan)) |
| Temporary space runs out | Give `--tmp` (where the main DB is assembled) and `--spill` (intermediate spill files) separately |
| Extremely slow | `--tmp` points to a shared filesystem. The startup log shows the chosen location and filesystem type |
| Output owned by root | Add `-u "$(id -u):$(id -g)"` to `docker run` |
| Stops with "重なりのある L 行が … 本ある" (overlapping L lines) | The GFA is not blunt. Convert de Bruijn graphs (Bifrost, Cuttlefish, ...) to a GFA without overlaps |
| No reference coordinates or coordinate jumps on screen | No reference path was chosen. Check the "参照: …" line in the log; if wrong, set the sample with `--ref-key` ([How the reference is chosen](03-your-data.md#how-the-reference-is-chosen)) |
| Stops with "--gff-dir … に、どのパスの GFF も無い" (no GFF for any path) | File names do not match the path samples. Rename to the expected names shown (`<sample>.gff3.gz`, ...) |
| No genes, or some strains have no genes | GFF seqids (column 1) differ from the path contigs (e.g. GFF `NC_001133.9`, path `S288C#0#chrI`). The gene stage logs "グラフの seqid の行が 1 行も無い" |
| `--gene` stops saying no gene line matches the seqids | Seqids differ from the reference contig names, or the GTF has no gene lines (UCSC `ncbiRefSeq.gtf`, ...). Pass the latter with `--gff-dir` |
| `--band` / `--gene` given but no annotation appears | They cannot be mapped on graphs without paths (rGFA, de Bruijn) and are skipped (logged). With paths, check that seqids match the reference contig names |
| Read import stops with "GAF のノード名が DB の葉と一致しない" (GAF node names do not match the DB) | The alignment and the DB use different node IDs. Check you aligned with `vg giraffe --named-coordinates` to the same GFA the DB was built from. To continue anyway, `--reads-force-mismatch`. For graphs with non-integer ids, give the GAF with the original names ([Segment names](03-your-data.md#segment-names)) |
| A stage reruns although nothing changed | An input file's size or modification time changed (copied again, ...). Stage keys include input signatures |

## Viewing

| Symptom | Cause and fix |
|---|---|
| The DB is not listed | Wrong `DB_DIR` (the `/data` mount in a container). Check with `amipa check` |
| Cannot open: spatial index (`.tiled` sidecar) missing or outdated | The tile index for drawing is missing, outdated or empty. Rebuild with `amipa prep add-tiled --out <DB directory>` (the main DB is not rebuilt) |
| Node names and node search show internal names like `n123` | A graph with non-integer ids lacks `<db>.segnames`. Rebuild with `amipa prep run --out <DB directory> --only distill` |
| Only the base row in Linear is missing | `<db>.distill` is missing, or was moved to another machine as a symbolic link. `check` warns. Keep it as a real directory |
| Only reads are missing | The read records in `reads/` are not in the DB; the index alone cannot show reads. `check` reports it |
| Read labels do not appear | Labels were not rerun after the reads were rebuilt. Run `amipa prep add-read-labels` again |
| No node-name search or sample filtering | The DB was built without that index. `check` reports it |
| The first interaction is slow | Random disk reads. Move the DB to a local disk or add memory ([Disk and memory](05-serve.md#disk-and-memory)) |
| Parts of the view are missing | Heavy requests are being capped. Raise `AMIPA_MAX_ROWS` / `AMIPA_FETCH_MS` ([Viewer server settings](../reference/viewer-config.md)) |
| Save cannot be pressed | The server runs with `AMIPA_READONLY=1` (normal for a public instance) |

## Building the containers

| Symptom | Cause and fix |
|---|---|
| Stuck fetching dependencies | The build needs outbound network access. Pass proxy settings if needed |
| Apptainer build fails on a mount | A site bind setting. Use `env -u APPTAINER_BINDPATH apptainer build ...` |
| Permission denied at startup | File permissions from the source leaked into the image. The bundled definitions handle this |
| A library is not found | The runtime image lacks a shared library. The bundled definitions check this at build time |
| Unexpected `import` errors | The host `~/.local` is being picked up. Use `--cleanenv` and `PYTHONNOUSERSITE=1` (set in the bundled images) |
