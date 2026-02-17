# CHECKLIST — PR-042 — v0 Production Launch & TestFlight (v0.5)

**As-of:** 2026-02-17

AUTO items must include receipts (commands + logs).
HUMAN items are Jam-only. Agents must not claim completion.

## A) SolServer implementation (AUTO)

### A1) Branch + repo hygiene
- [ ] Create branch `pr-042/prod-launch` (AUTO) — Evidence:

### A2) fly.prod.toml (do not overwrite staging)
- [ ] Add new `fly.prod.toml` (AUTO) — Evidence:
- [ ] Set app, region, process groups, and volume mount (AUTO) — Evidence:
- [ ] Set `CONTROL_PLANE_DB_PATH=/data/control_plane.db` for web and worker (AUTO) — Evidence:
- [ ] Move non-secret env vars into `[env]` (AUTO) — Evidence:
- [ ] Do not invent values; TODO only when required (AUTO) — Evidence:

### A3) Runtime wiring validation
- [ ] Confirm server PORT handling and Fly `internal_port` wiring (AUTO) — Evidence:
- [ ] Confirm worker handshake per dev.md (`/internal/topology`, token header) (AUTO) — Evidence:
- [ ] Confirm `SOL_INTERNAL_API_BASE` reachability and concrete port if needed (AUTO) — Evidence:

### A4) Env var classification table (required)
- [ ] Produce env var table (required/secret/default/scope/meaning) (AUTO) — Evidence:

### A5) Health endpoint
- [ ] Confirm health path exists (preferred `/health`) (AUTO) — Evidence:
- [ ] If missing, add minimal `/health` 200 (AUTO) — Evidence:

### A6) Docs block for Jam
- [ ] Add doc block (PR description or docs/runbooks/prod.md) with deploy + secrets-only + verify checklist (AUTO) — Evidence:

### A7) Gates (AUTO)
- [ ] unit (AUTO) — Evidence: Command: `pnpm run test` | Result: PASS | Log: `docs/pr/PR-042/receipts/unit.log`
- [ ] lint (AUTO) — Evidence: Command: `pnpm run build` | Result: PASS | Log: `docs/pr/PR-042/receipts/lint.log`
- [ ] integration (AUTO) — Evidence: Command: `pnpm run test` | Result: PASS | Log: `docs/pr/PR-042/receipts/integration.log`

## B) Launch steps (HUMAN)

### B1) Fly.io prod (Jam-only)
- [ ] Set Fly secrets (HUMAN)
- [ ] Deploy with `fly deploy -a solserver-prod -c fly.prod.toml` (HUMAN)
- [ ] Verify: health + one real request completes end-to-end (HUMAN)

### B2) TestFlight (Jam-only)
- [ ] App Store Connect + signing + upload + testers (HUMAN)

## C) Hygiene (AUTO)
- [ ] Run PR body hygiene after receipts exist (AUTO) — Evidence:
- [ ] Populate FIXLOG Promote to Canon targets (AUTO) — Evidence:
