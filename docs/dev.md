# SolServer Local Dev

Local dev requires two processes: the web server and the worker. The web server returns 202 for `/v1/chat` requests and the worker processes the queued transmissions. If the worker is not running, transmissions remain `status=created` and clients will poll forever.

## Run (recommended)

```bash
CONTROL_PLANE_DB_PATH=./data/control_plane.db npm run dev:all
```

## Run (two terminals)

Terminal A:
```bash
CONTROL_PLANE_DB_PATH=./data/control_plane.db npm run dev
```

Terminal B:
```bash
CONTROL_PLANE_DB_PATH=./data/control_plane.db npm run dev:worker
```

## SQLite DB path

Both processes must use the same DB file.

```bash
export CONTROL_PLANE_DB_PATH=./data/control_plane.db
```

Fly uses `/data/control_plane.db` via `fly.toml` so web and worker share the same volume.

## Lattice flags (v0/v0.1)

Lattice is enrichment-only. Defaults are off; set explicitly when testing.

```bash
export LATTICE_ENABLED=1
export LATTICE_VEC_ENABLED=0
export LATTICE_VEC_QUERY_ENABLED=0
export LATTICE_VEC_EXTENSION_PATH=/app/extensions/vec0.so
export LATTICE_VEC_MAX_DISTANCE=
export LATTICE_POLICY_BUNDLE_PATH=/app/policy/policy_capsules.json
export LATTICE_BUSY_TIMEOUT_MS=200
```

Notes:
- Vector search is behind flags; lexical remains default.
- `/app/extensions/vec0.so` is packaged in the runtime image; override the path for local dev if needed.

## Verify worker progress

```bash
sqlite3 ./data/control_plane.db "select id,status,lease_owner,lease_expires_at from transmissions order by created_at desc limit 5;"
```

## Runbook: Topology Guard + Worker Handshake (Fly)

### Rollout order
1) Deploy API (creates persistent topology key + internal route)
2) Deploy Worker (will refuse to start until API is reachable and keys match)

### Required secrets
- `SOL_INTERNAL_TOKEN` must be set on Fly (used by worker to call `/internal/topology`)

### Worker startup failure checks
- Verify API reachability from worker: `SOL_INTERNAL_API_BASE` must resolve (default is `http://127.0.0.1:${PORT}`)
- Verify token: `X-SOL-INTERNAL-TOKEN` must match `SOL_INTERNAL_TOKEN`
- Verify `/data` writable (strict mode / Fly auto-strict)
- Check logs for:
  - `topology.guard.worker_internal_token_missing_fatal`
  - `topology.guard.worker_key_mismatch_fatal`
  - `topology.guard.worker_api_unreachable_fatal`
  - `topology.guard.worker_key_missing_fatal`
  - `topology.guard.volume_not_writable_fatal`
