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

## Verify worker progress

```bash
sqlite3 ./data/control_plane.db "select id,status,lease_owner,lease_expires_at from transmissions order by created_at desc limit 5;"
```
