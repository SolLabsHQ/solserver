# v0 Launch Manual Runbook (Jam) — PR-042 (v0.5)

**As-of:** 2026-02-17  
**Human-only:** Yes.

## Locked facts (v0)
- Fly prod app name: `solserver-prod`
- Region: `sjc`
- Prod domain: `api.sollabshq.com` (cert ready)
- Volume name: `solserver_data` mounted to `/data`
- DB path: `/data/control_plane.db`
- Two processes: `web` + `worker`

## A) SolServer prod deploy (Fly)

### A1) Branch
```sh
git checkout main && git pull
git checkout -b pr-042/prod-launch
```

### A2) Secrets-only command (fill values)
```sh
fly secrets set -a solserver-prod   OPENAI_API_KEY="..."   SOLSERVER_API_KEY="..."   SOL_INTERNAL_TOKEN="..."
```

### A3) Deploy using prod config
```sh
fly deploy -a solserver-prod -c fly.prod.toml
```

### A4) Verify checklist
- Health endpoint responds 200 (path: TBD, prefer `/health`)
- One real request completes end-to-end (202 -> worker consumes -> final answer)

## B) Jam handoff block

### Secrets-only command (3 vars, no inventing)
```sh
fly secrets set -a solserver-prod \
  OPENAI_API_KEY="..." \
  SOLSERVER_API_KEY="..." \
  SOL_INTERNAL_TOKEN="..."
```

### Deploy command
```sh
fly deploy -a solserver-prod -c fly.prod.toml
```

### Runtime + data validation
- Confirm mount: volume `solserver_data` attached at `/data`.
- Confirm env includes `CONTROL_PLANE_DB_PATH=/data/control_plane.db` for both processes.
- Confirm topology: `SOL_INTERNAL_API_BASE=http://solserver-prod.internal:3333`.
- Confirm port wiring: internal API and worker base share `3333`.
- Endpoint checks:
  - `GET /health` => 200
  - `GET /healthz` => 200
  - `GET /readyz` => 200
- Worker-flow checks:
  - Submit one message and confirm `/v1/chat` returns 202.
  - Confirm `/v1/events` progress/trace reflects completion to final output.

## B) TestFlight (SolMobile)
- Create App Store Connect app (bundle id: `com.sollabshq.solmobile`)
- Configure signing (auto signing recommended)
- Archive + upload
- Add internal testers and run smoke test
