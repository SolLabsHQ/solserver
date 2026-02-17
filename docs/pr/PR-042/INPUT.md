# INPUT — PR-042 — v0 Production Launch & TestFlight (v0.5)

**As-of:** 2026-02-17

## Goal
Release v0 by preparing SolServer production config and documenting human-only launch steps.
Connected PRs will handle SolMobile TestFlight readiness and infra-docs v0 architecture updates.

## Non-goals
- No new product features
- Do not rename staging during v0 launch
- No multi-region scaling changes for v0
- No public App Store release (TestFlight internal only)

## Facts (locked for v0)
- Fly prod app name: `solserver-prod`
- Region: `sjc`
- Prod domain: `api.sollabshq.com` (cert ready)
- Volume mount: `/data` (volume name: `solserver_data`)
- DB path: `/data/control_plane.db`
- Two processes: API + Worker must both run and share the same DB path

## SolServer implementation contract (A–E)
See: `SOLSERVER_TASKS_A-E.md`

## Acceptance criteria (solserver)
- Add new prod config file: `fly.prod.toml` (do not overwrite staging config)
- Move all non-secret env vars into `[env]` in `fly.prod.toml` without inventing values
- Verify runtime wiring: internal_port / PORT handling + worker handshake + SOL_INTERNAL_API_BASE
- Produce secrets-only command for Jam (3 vars only)
- Add doc block with deploy, secrets, volume mount, and verify checklist

## Expected breakpoints (human-only)
- Fly secrets, deploy, DNS: Jam-only
- App Store Connect + signing + upload: Jam-only
