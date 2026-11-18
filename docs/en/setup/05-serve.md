# Serving publicly

[日本語](../../ja/setup/05-serve.md)

How to open a DB locally, and settings for serving it from a lab server or the cloud. The viewer reads the SQLite files directly; no database server is needed.

## Opening locally

```bash
docker run --rm -p 3001:3001 -v /path/to/graph.amipa:/data:ro ghcr.io/kamadahiroaki/amipa-viewer serve
# → http://localhost:3001
```

- One port serves both the page and the API.
- The DB can be mounted read-only.
- To offer several DBs, mount their parent directory as `/data`; switch between them with the selector at the top left of the page.

With Apptainer (`DB_DIR=/data` and `PORT=3001` are the image defaults):

```bash
apptainer exec --cleanenv -B /path/to/graph.amipa:/data:ro amipa-viewer.sif amipa serve
```

Check:

```bash
curl -s localhost:3001/healthz        # → ok
curl -s localhost:3001/api/version    # version stamp and read-only flag
```

`/healthz` does not touch the DB, so it answers even while heavy requests are running.

## Settings for a public instance

A public instance should at least do these three things. All settings are listed in [Viewer server settings](../reference/viewer-config.md).

1. Start with `AMIPA_READONLY=1` and mount the DB `:ro` (two layers of protection).
2. Keep the DB on block storage (a local disk).
3. Set limits for heavy requests (`AMIPA_MAX_ROWS`, `AMIPA_FETCH_MS`) and rate-limit in front.

### Preventing saved edits (`AMIPA_READONLY=1`)

The page has an edit mode for moving nodes, and the result can be saved to the DB. `AMIPA_READONLY=1` blocks only this save.

- At startup the page reads `readonly` from `/api/version` and shows Save in the Edit row as disabled from the start.
- Edit mode itself still works. Moving nodes to inspect connections works as usual; the result just is not stored in the DB. The moved state is included in shared URLs.
- The server also rejects `POST /api/save_edits` with 403, so a modified page cannot save either.
- Mounting the DB `:ro` adds a second layer.

On large graphs applying an edit (updating descendant nodes and their edges on all layers) can take impractically long. Always set it on public instances.

`SESSION_DIR`, where shared-URL states are stored, must remain writable (it is the viewer's only write location).

### Disk and memory

Viewing is dominated by small random reads, so seek count and IOPS set the perceived speed.

- Put the DB on a local disk (a managed SSD in the cloud). Object storage (Blob, ...), network filesystems and FUSE mounts are orders of magnitude slower and not usable. Use object storage only for distribution.
- Memory acts as page cache. Even if the DB does not fit, frequently viewed regions stay cached.
- If the first view is slow, the cause is almost always random disk reads.

### Prewarming at startup

Right after startup, before anyone is looking, the viewer can read the DB sequentially to load it into the OS page cache. On network filesystems, reading everything in order is much cheaper than fetching scattered pages one by one (on the shared filesystem used in development, a 230 GB whole-genome DB was read in 88 seconds).

- By default (`AMIPA_PREWARM` unset) it prewarms only when the DB directory is on a network filesystem (Lustre, NFS, GPFS, CIFS, FUSE, ...). On local disks it does not.
- `AMIPA_PREWARM=<DB name,...>` prewarms only those DBs; `off` disables it.
- Sidecars (`.tiled`, `.reads`, `.annot`) are read as well as the main DB.
- DBs under 4 GiB are skipped (they warm up on their own).
- It gives up if sequential reading is slower than `AMIPA_PREWARM_MIN_MBPS` (default 300 MB/s).
- Progress: `GET /api/prewarm?db=<name>`.
- `AMIPA_PREWARM_ON_OPEN=1` also prewarms when switching DBs. It is off by default because starting a sequential read the moment a user wants to see something competes with the first view and makes it slower.

For a DB larger than memory on a local disk, do not prewarm: the sequential read takes disk bandwidth from users. Instead, open the frequently viewed regions a few times.

### Concurrent users

One heavy request makes the others wait.

- Raising `AMIPA_DB_WORKERS` (number of DB reader workers) allows parallel reads, but each worker has its own page cache and uses memory.
- `AMIPA_MAX_ROWS` and `AMIPA_FETCH_MS` cap a single request. A capped view is returned partially.
- While the audience size is unknown, put a CDN or reverse-proxy rate limit in front.

## Deploying on Azure

A single VM is enough:

```
[browser] ──HTTPS──▶ [reverse proxy (TLS)] ──▶ [amipa-viewer container]
                                                └─ DB (local disk, read-only)
```

The full procedure (create the VM → transfer data → start → update → monitor → pre-launch checks) and the configuration files (`compose.yml`, `Caddyfile`, `cloud-init.yaml`, `setup.sh`, `update.sh`, `sync-bundle.sh`) are in [deploy/azure/](../../../deploy/azure/). The same approach applies to other clouds.

### Choosing disk and VM

- Put the DB on a managed disk (Premium SSD) with host caching set to ReadOnly. A read-only DB suits it well, and the VM's local NVMe acts as a cache. Host caching requires a size with a local temporary disk (`*ds_v5`, `*ads_v5`).
- Do not put the DB on Blob Storage, Azure Files or a FUSE mount.

| Serving | Data | VM | Data disk |
|---|---|---|---|
| chrY | 0.34 GB | B2as_v2 (2 vCPU / 8 GiB) | 32 GB |
| One chromosome (chr22) | 8.4 GB | D2ads_v5 (2 vCPU / 8 GiB; fits in RAM) | 64 GB |
| One whole genome (HPRC Minigraph-Cactus) | about 276 GB | E8ads_v5 (8 vCPU / 64 GiB) | P30 (1 TB) |
| Two whole genomes | about 630 GB | E8ads_v5 to E16ads_v5 | P40 (2 TB) |

Prices change; check the Azure Pricing Calculator and always set a budget alert.

### Steps

1. Create the VM (`az vm create`) and attach the data disk with `--caching ReadOnly`. Open only ports 80 and 443 and restrict SSH to your IP.
2. `cloud-init.yaml` (or `setup.sh` after the VM exists) installs Docker and mounts the data disk at `/data`. An existing filesystem is not reformatted (the DB is not erased).
3. Put `compose.yml`, `Caddyfile`, `update.sh` and a `.env` (image tag, domain, e-mail for the certificate, DB location) in `/opt/amipa/`.
4. Send the DB with `sync-bundle.sh <DB directory> <user@host>`. It uses rsync, so rerun the same command after an interruption. `-journal`, `-wal` and `work/` are not sent. A whole genome takes hours, so run it from somewhere that survives disconnection (such as a scheduler job).
5. Check before going public:

```bash
docker compose run --rm viewer check          # do not go public until RESULT: OK
sudo systemctl enable --now amipa
curl -s localhost/healthz                     # → ok
```

When renaming a DB, rename its sidecars to match (they are associated by name, as in `<db>.tiled`). To exercise the API, use `tests/run.sh api <DB name> <host:port>` from the repository. The first run is slow because the cache is cold; it also serves as a warm-up.

### Updating

Updating means changing the image tag; the DB is not touched.

```bash
ssh <host> /opt/amipa/update.sh ghcr.io/kamadahiroaki/amipa-viewer:0.2.0
```

It pulls, restarts and checks `/healthz`. If it fails, the old tag is in `.env.bak`: `cp -f .env.bak .env && docker compose up -d`.

To replace a DB, do not overwrite it under the same name (open connections would break). Put the new one under a new name, run `check`, point users to it, then delete the old one. Do not leave old sidecars behind.

### Pre-launch checklist

- `AMIPA_READONLY=1` is in effect (`curl -X POST https://<host>/api/save_edits` returns 403)
- The DB is mounted `:ro`
- SSH is restricted to your IP
- `check` reports `RESULT: OK`
- A budget alert is set
- `/api/version` returns the right tag (it is the version stamp printed on figures)
- Response with several simultaneous users has been tried

Use `GET /healthz` for liveness monitoring. To stop, `az vm deallocate` (VM billing stops, disk billing continues); to remove everything, `az group delete` (this deletes the DB too).
