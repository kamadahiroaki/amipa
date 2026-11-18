# Install

[日本語](../../ja/setup/01-install.md)

AMIPA ships as two container images: `amipa-prep` builds a DB from a GFA, and `amipa-viewer` shows a DB in the browser. You can install either one on its own. All you need is Docker or Apptainer; no Node, Python or conda.

## Which one

| You want to | Install |
|---|---|
| Look at a DB someone built for you | `amipa-viewer` |
| Build a DB from your own GFA and look at it | `amipa-prep` and `amipa-viewer` |
| Build DBs on an HPC cluster without Docker | `amipa-prep` with Apptainer (below) |
| Run without containers | From source (see "Running preprocessing without containers" below) |

Pin a version with a tag (`:0.1.0` or `:0.1`). `:latest` is the latest release; `:main` follows the development branch.

## Docker

```bash
docker pull ghcr.io/kamadahiroaki/amipa-viewer     # enough for viewing
docker pull ghcr.io/kamadahiroaki/amipa-prep       # to build DBs from your own GFA
```

Check: the version stamp (the commit the image was built from) is printed as JSON.

```bash
docker run --rm ghcr.io/kamadahiroaki/amipa-viewer version
```

```
{
  "version": "abc1234",
  "commit": "abc1234",
  "runtime": "v20.x.x"
}
```

## Apptainer (HPC)

On machines without Docker, pull the images with Apptainer (Singularity).

```bash
apptainer pull amipa-viewer.sif docker://ghcr.io/kamadahiroaki/amipa-viewer
apptainer pull amipa-prep.sif   docker://ghcr.io/kamadahiroaki/amipa-prep
```

Always pass `--cleanenv`. Apptainer passes host environment variables into the container, so a host conda, `PYTHONPATH` or packages in `~/.local` can break the Python inside.

```bash
apptainer exec --cleanenv amipa-prep.sif amipa prep --help
apptainer exec --cleanenv -B /path/to/graph.amipa:/data amipa-viewer.sif amipa check
```

## From source

### Building the images yourself

The build context is the repository root (the trailing `.`). Real data is excluded by `.dockerignore`, so the context is a few MB.

```bash
git clone https://github.com/kamadahiroaki/amipa.git && cd amipa
docker build -f docker/Dockerfile.viewer -t amipa-viewer \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 3-5 min
docker build -f docker/Dockerfile.prep   -t amipa-prep \
    --build-arg AMIPA_REV=$(git rev-parse --short HEAD) .    # 10-20 min (Rust compilation)
```

`AMIPA_REV` is the version stamp written to `amipa version` and to `db_meta.emitter_rev` in the DB. `.git` is excluded from the context, so without it the stamp is `unknown`.

Both images test themselves in the final stage (BubbleFinder starts, native modules load, Python dependencies are present). A missing shared library therefore fails `docker build`, not a later run.

With Apptainer:

```bash
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-prep.sif   docker/amipa-prep.def
env -u APPTAINER_BINDPATH apptainer build --fakeroot amipa-viewer.sif docker/amipa-viewer.def
```

`env -u APPTAINER_BINDPATH` is needed on sites that bind shared directories by default (container creation fails if the image lacks a directory of the same name). The build needs outbound network access (conda-forge, bioconda, PyPI, crates.io).

The default bubble decomposer (the tool that finds regions where the graph branches and merges again) is BubbleFinder. `docker/amipa-prep.def` is meant for local images and can also include Billi as an alternative (`AMIPA_WITH_BILLI=1`). Billi cannot be redistributed, so do not distribute images built this way. `Dockerfile.prep` is the distribution build and does not include Billi.

The actual build steps live in `docker/build-prep.sh` and `docker/build-viewer.sh`; both Docker and Apptainer call them. If you change what goes into an image, rebuild and check with both.

### Running preprocessing without containers

Where containers are not available, call `prep/amipa_prep/cli.py` from the repository directly (same arguments as `amipa prep`). You need to provide what the image provides (see `docker/build-prep.sh`):

- Python 3.9 or newer (call a newer interpreter explicitly if the system `python3` is older)
- `pip install -r docker/requirements.txt` (pinned versions)
- The three Rust extensions `prep/core/{emit_core,reads_core,tiled_core}`, built with `maturin build --release` and installed with pip (Rust and maturin 1.14)
- BubbleFinder (for example `conda install -c bioconda bubblefinder`), passed with `--bubblefinder` or the environment variable `AMIPA_BUBBLEFINDER`

```bash
python3 prep/amipa_prep/cli.py run --gfa graph.gfa.gz --out graph.amipa --threads 8
```

To run the viewer on the host, follow `docker/build-viewer.sh` (start the resulting `viewer/backend/dist/server.js` with node; the check is `dist/check.js`).

## Checking the installation

If you have a DB, run the viewer's check on it.

```bash
docker run --rm -v /path/to/graph.amipa:/data:ro ghcr.io/kamadahiroaki/amipa-viewer check
```

`RESULT: OK` on the last line means the DB can be opened. The check does not read the whole DB, so it takes seconds even for large ones. If you do not have a DB yet, build one in [Your first DB (chrY)](02-first-db.md).

Both images print their licenses and bundled components with `amipa licenses` ([Licensing](../reference/licensing.md)).
