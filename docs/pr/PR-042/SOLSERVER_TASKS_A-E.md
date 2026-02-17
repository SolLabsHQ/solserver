# SOLSERVER_TASKS_A-E — PR-042 (v0.5)

**As-of:** 2026-02-17

Repo: solserver
Goal: Prepare PR #42 branch that sets up prod Fly config for v0 in SJC, SQLite on volume, and moves non-secret env vars out of Fly secrets.

FACTS / CONTRACT
- Fly prod app name: solserver-prod
- Region: sjc
- Prod domain already handled: api.sollabshq.com (cert ready)
- DB: SQLite on Fly Volume mounted to /data, DB file at /data/control_plane.db
- Two processes required in local dev (web + worker). Ensure Fly runtime runs both.

TASKS
A) Create branch pr-042/prod-launch
B) Add fly.prod.toml (do not overwrite staging), move non-secrets into [env]
C) Confirm runtime wiring (PORT/internal_port, worker handshake, SOL_INTERNAL_API_BASE)
D) Produce secrets-only command for Jam (3 vars)
E) Add doc block (deploy cmd, volume/mount, secrets cmd, verify checklist)
