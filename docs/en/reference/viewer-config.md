# Viewer server settings

[日本語](../../ja/reference/viewer-config.md)

The viewer server (`amipa serve`) is configured with environment variables: `-e NAME=value` for Docker, `--env NAME=value` (or `APPTAINERENV_NAME`) for Apptainer. For how to set up a public instance, see [Serving publicly](../setup/05-serve.md).

## Basics

| Variable | Default | Meaning |
|---|---|---|
| `DB_DIR` | `/data` (image) | Where DBs are. Every `*.db` in it is listed |
| `PORT` | `3001` | Listening port |
| `SESSION_DIR` | `/tmp/amipa-sessions` (image) | Where shared-URL states are stored; the viewer's only write location. Mount a writable volume to keep them |
| `AMIPA_READONLY` | off | `1` (or `true`) forbids saving node edits to the DB. Always set it on public instances |

## Speed and memory

| Variable | Default | Meaning |
|---|---|---|
| `AMIPA_PREWARM` | automatic | Read DBs sequentially at startup to load them into the page cache. Unset (or `auto`): only when the DB directory is on a network filesystem. `<DB name>,...`: only those DBs. `off` (`0`, `false`): disabled |
| `AMIPA_PREWARM_ON_OPEN` | off | `1` also prewarms when switching DBs |
| `AMIPA_PREWARM_MIN_MBPS` | 300 | Give up if sequential reading is slower than this (MB/s) |
| `AMIPA_PREWARM_MIN_BYTES` | 4 GiB | DBs smaller than this are not prewarmed |
| `AMIPA_TRAV_PREWARM` | `1` | Read a large Linear index (`.trav`) in the background before opening it. `0` disables |
| `AMIPA_CACHE_MB` | 64 (512 for DBs of 20 GB or more) | SQLite page cache per connection (MB). Lower it on small-memory machines |
| `AMIPA_DB_WORKERS` | 2 | Number of DB reader workers. More allow parallel reads, but each has its own page cache |
| `AMIPA_MMAP_BYTES` | 0 (off) | SQLite mmap size (bytes) |
| `AMIPA_GZIP_LEVEL` | 1 | gzip level for responses (0 disables compression) |

## Per-request limits

These keep one heavy request from blocking everything. A response that hits a limit is returned partially.

| Variable | Default | Meaning |
|---|---|---|
| `AMIPA_MAX_ROWS` | 1,000,000 | Maximum rows returned per request (memory protection) |
| `AMIPA_FETCH_MS` | 300,000 (5 min) | Time limit per request (ms) |
| `AMIPA_TERMINATE_GRACE_MS` | 10,000 | Grace period before a worker is recreated when a cancelled request does not return (ms) |

`deploy/azure/compose.yml` uses `AMIPA_MAX_ROWS=400000` and `AMIPA_FETCH_MS=20000` as defaults for public serving.

## Base alignment

The alignment in the base row of Linear is computed by resident Python processes.

| Variable | Default | Meaning |
|---|---|---|
| `AMIPA_PY_RUNNERS` | 2 | Number of resident Python processes. They start with the server and import numpy in advance (on network filesystems the import alone can take tens of seconds) |
| `AMIPA_MSA_TIMEOUT_MS` | 30,000 | Time limit per alignment (ms) |
| `AMIPA_PYTHON` | `python3` (image) | Python to use |

## Logging

| Variable | Default | Meaning |
|---|---|---|
| `AMIPA_SLOWLOG_MS` | 500 | Log one line for each API request slower than this (ms). 0 disables |

## Status endpoints

| URL | Content |
|---|---|
| `GET /healthz` | Returns `ok`. Does not touch the DB, so it answers even while heavy requests are running |
| `GET /api/version` | Version stamp, read-only flag (`readonly`), available features per DB |
| `GET /api/prewarm?db=<name>` | Prewarm progress |
