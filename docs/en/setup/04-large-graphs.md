# Large graphs (whole genome, HPC)

[日本語](../../ja/setup/04-large-graphs.md)

Up to a single chromosome, the one command from [Your first DB (chrY)](02-first-db.md) works on an ordinary machine. At whole-genome scale, estimate resources, choose temporary space, and run the stages through a job scheduler.

## Scale

| Graph | Time (8 threads) | Memory | Output |
|---|---|---|---|
| One chromosome (small, 166K nodes) | about 3 min | 4–8 GB | about 0.3 GB |
| One chromosome (large, 0.8 GB GFA) | about 25 min | 16 GB | about 9 GB |
| Whole genome (48 GB GFA) | about 11 h | 96–320 GB depending on stage | about 260 GB |

Resource needs differ widely between stages (steps of preprocessing). Only layout (computing the 2D positions of nodes) and bubble decomposition use many cores; the other stages run on one thread.

## Estimating (plan)

`amipa prep plan` estimates slots, memory and time per stage from the input size. It writes nothing.

```bash
amipa prep plan --gfa graph.gfa --out graph.amipa --threads 8
amipa prep plan ... --json          # for generating job scripts
```

Output for chrY (79 MB GFA):

```
  段             スロット      メモリ合計     /スロット      見込み時間
  distill          1         8G        8G       0.2h
  decompose        8         4G        1G       0.1h
  lod              1         8G        8G       0.2h
  layout           8         8G        1G       0.2h
  emit             1        24G       24G       0.2h
  trav             1         8G        8G       0.1h
  tiled            1         8G        8G       0.1h
  bundle           1         8G        8G       0.1h
```

(Columns: stage, slots, total memory, memory per slot, estimated time.)

- The numbers are measurements on a whole-genome graph plus a margin; treat them as a starting point. After one run, tighten them to what was actually used (`amipa prep status` shows peak memory per stage).
- For schedulers that take memory per slot (such as AGE `s_vmem`), use the per-slot column.
- Pass the same options you will give `run` to include their stages: `--reads` adds the read stage (driven by the amount of GAF), `--gff-dir` adds the gene stage (driven by the GFF size: only lines for the graph's seqids are read, about 9 GB per 1 GB of decompressed lines).
- For a GFA without paths, the Linear, gene and annotation stages do not appear.

## Temporary space and memory

| Option | Meaning | Default |
|---|---|---|
| `--threads` | Parallelism; affects bubble decomposition and layout (the hierarchy stage always uses one thread for reproducibility) | visible CPUs |
| `--tmp` | Where the main DB is assembled. Random writes, so it needs a fast node-local disk. Needs roughly the size of the finished DB | the first of `$TMPDIR` → `/tmp` → `<out>/work/tmp` with enough free space |
| `--spill` | Intermediate spill files. Sequential writes, so a shared filesystem does little harm, but it can need far more space than the DB | same as `--tmp` |
| `--mem-gib` | Memory budget for layout | 60% of available memory (cgroup and job limits included) |
| `--ribbon-disk` | Compute the haplotype ribbons on disk to save memory | off |

The log shows the chosen temporary directories, their free space and filesystem type at startup, and warns if a shared filesystem (Lustre, ...) was chosen. It works, but SQLite random writes become an order of magnitude slower.

At whole-genome scale `--tmp` can need hundreds of GB and `--spill` several TB, which may not both fit on a local disk. In that case move only `--spill` to large shared storage:

```bash
amipa prep run --gfa big.gfa --out big.amipa \
    --tmp /local/nvme --spill /shared/scratch --ribbon-disk
```

## Running with a job scheduler

AMIPA has no scheduler-specific syntax (it differs per site). Write the job script in your site's format and call `amipa prep run` inside it. Templates for AGE (SGE) and Slurm are in [examples/hpc/](../../../examples/hpc/).

| File | Content |
|---|---|
| `age-per-stage.sh` | Job that runs one stage (AGE/SGE) |
| `age-submit.sh` | Submits the per-stage jobs chained by dependencies (AGE/SGE). Stages and resources come from `amipa prep plan --json` |
| `slurm-per-stage.sbatch` | Job that runs one stage (Slurm) |

### One job or one job per stage

Running `amipa prep run` to the end in a single job is simplest and fine up to medium sizes. But only the layout stage uses many cores, so the job holds its slots idle during the other stages. At whole-genome scale (about 11 hours) this wastes about 200 core-hours.

With one job per stage, each stage requests only what it needs. Each job calls `amipa prep run --only <stage>`, in this order:

```
distill → decompose → lod → layout → emit → trav → (genes, ann, annot, reads, rlabel, xdepth) → tiled → bundle
```

Stages in parentheses are needed only when you pass the corresponding inputs. Always run `tiled` (the tile index for drawing); without it the viewer cannot open the DB. `age-submit.sh` submits, in this order, the stages returned by `amipa prep plan --json` (only those your inputs need). Put annotation and read options in the environment variable `AMIPA_EXTRA`; they are passed to both plan and each stage.

Chain the jobs with your scheduler (`-hold_jid` for AGE, `--dependency=afterok:` for Slurm). Dependencies often mean "the previous job ended", not "succeeded", so later jobs may start after a failure. AMIPA stops at once when its inputs are missing, so no broken output is produced.

### The caller chooses temporary space

The images do not hard-code a temporary location. Choose node-local space in the job and pass it in:

```bash
SCRATCH="${TMPDIR:-/tmp/$USER}/amipa"      # fast node-local disk
mkdir -p "$SCRATCH"
apptainer exec --cleanenv -B "$SCRATCH:/scratch" amipa-prep.sif \
    amipa prep run --only emit --gfa graph.gfa --out graph.amipa --tmp /scratch
```

If `--spill` goes elsewhere, bind and pass it too (`-B "$SPILL:/spill" ... --spill /spill`).

### Changing requests after submission

If a request is too large, the job may wait indefinitely for resources. Pending jobs can be lowered afterwards (running jobs cannot, so fix them while they wait):

```bash
# AGE / SGE (where both s_vmem and mem_req are used, give the same value)
qalter -l s_vmem=12G,mem_req=12G <job ID>
qstat -j <job ID> | grep hard_resource     # check it took effect

# Slurm
scontrol update JobId=<job ID> MinMemoryNode=96G
```

After a run, check actual usage with `qacct -j <job ID>` (AGE), `sacct -j <job ID> --format=MaxRSS,MaxVMSize` (Slurm) or `amipa prep status`, and use those values next time.

## Resuming

```bash
amipa prep status --out graph.amipa             # which stages have finished
amipa prep run --out graph.amipa --from layout  # redo layout and everything after
amipa prep run --out graph.amipa --only emit    # emit only
amipa prep run --out graph.amipa --force        # redo everything
```

Running the same `run` again skips finished stages and continues. For each stage a key is built from the command line and the signatures (size and modification time) of its input files and recorded in `state.json`; a stage is skipped when the key matches and its outputs exist. Later stages include the signatures of their own inputs, so they rerun only when an earlier stage actually rewrote its output.

Values that do not change the output, such as the temporary directory, thread count and memory budget, are not part of the key. Resuming on another node (with a different `$TMPDIR`) does not redo finished stages. A failing stage removes its partial files before stopping.

`status` shows the state, seconds and finish time of each stage, and the peak memory (RSS and virtual) of the stages that ran.
