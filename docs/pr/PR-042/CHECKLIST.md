# CHECKLIST — PR-042 — v0 Production Launch & TestFlight (v0.5)

**As-of:** 2026-02-17

AUTO items must include receipts (commands + logs).
HUMAN items are Jam-only. Agents must not claim completion.

## A) SolServer implementation (AUTO)

### A1) Branch + repo hygiene
- [ ] Create branch `pr-042/prod-launch` (AUTO) — Evidence:

### A2) fly.prod.toml (do not overwrite staging)
- [x] Add new `fly.prod.toml` (AUTO) — Evidence: Added `/Users/jmcnulty25/.codex/worktrees/9018/solserver/fly.prod.toml` with app `solserver-prod` and prod region `sjc`.
- [x] Set app, region, process groups, and volume mount (AUTO) — Evidence: Added `[processes] app = "bash scripts/run-web-worker.sh"` and `[[mounts]] source = "solserver_data"` in `/Users/jmcnulty25/.codex/worktrees/9018/solserver/fly.prod.toml`.
- [x] Set `CONTROL_PLANE_DB_PATH=/data/control_plane.db` for web and worker (AUTO) — Evidence: `CONTROL_PLANE_DB_PATH` is declared in `[env]` in `/Users/jmcnulty25/.codex/worktrees/9018/solserver/fly.prod.toml`.
- [x] Move non-secret env vars into `[env]` (AUTO) — Evidence: Non-secret defaults (`SOL_ENV`, `LLM_PROVIDER`, `OPENAI_MODEL`, `SOL_INTERNAL_API_BASE`, `LATTICE_POLICY_BUNDLE_PATH`, etc.) remain in `[env]` in `/Users/jmcnulty25/.codex/worktrees/9018/solserver/fly.prod.toml`.
- [x] Do not invent values; TODO only when required (AUTO) — Evidence: All populated values are copied from existing staging/base/defaults; no invented env values were introduced.

### A3) Runtime wiring validation
- [x] Confirm server PORT handling and Fly `internal_port` wiring (AUTO) — Evidence: `src/index.ts` binds on `PORT` with fallback `3333` and `fly.prod.toml` uses `internal_port = 3333`.
- [x] Confirm worker handshake per dev.md (`/internal/topology`, token header) (AUTO) — Evidence: `src/worker.ts` calls `runTopologyHandshake`; `src/topology/worker_handshake.ts` builds `/internal/topology` and sends `x-sol-internal-token` when `SOL_INTERNAL_TOKEN` is set; `docs/dev.md` documents `SOL_INTERNAL_TOKEN` requirements for this endpoint.
- [x] Confirm `SOL_INTERNAL_API_BASE` reachability and concrete port if needed (AUTO) — Evidence: `src/worker.ts` computes fallback `http://127.0.0.1:${PORT}` and `src/routes/internal/topology.ts` + `fly.prod.toml` use concrete `http://solserver-prod.internal:3333`.

### A4) Env var classification table (required)
- [x] Produce env var table (required/secret/default/scope/meaning) (AUTO) — Evidence: `/Users/jmcnulty25/.codex/worktrees/9018/solserver/docs/pr/PR-042/env-var-classification.md`

### A5) Health endpoint
- [x] Confirm health path exists (preferred `/health`) (AUTO) — Evidence: `src/routes/healthz.ts` registers `/health` and `src/index.ts` mounts `healthRoutes`.
- [x] If missing, add minimal `/health` 200 (AUTO) — Evidence: N/A; `/health` is already present in `src/routes/healthz.ts` for this repo state.

### A6) Docs block for Jam
- [x] Add doc block (PR description or docs/runbooks/prod.md) with deploy + secrets-only + verify checklist (AUTO) — Evidence: `/Users/jmcnulty25/.codex/worktrees/9018/solserver/docs/pr/PR-042/MANUAL_STEPS.md`

### A7) Gates (AUTO)
- [x] unit (AUTO) — Evidence: Command: `pnpm run test` | Result: PASS | Log: `docs/pr/PR-042/receipts/unit.log`
- [x] lint (AUTO) — Evidence: Command: `pnpm run build` | Result: PASS | Log: `docs/pr/PR-042/receipts/lint.log`
- [x] integration (AUTO) — Evidence: Command: `pnpm run test` | Result: PASS | Log: `docs/pr/PR-042/receipts/integration.log`

## B) Launch steps (HUMAN)

### B1) Fly.io prod (Jam-only)
- [ ] Set Fly secrets (HUMAN)
- [ ] Deploy with `fly deploy -a solserver-prod -c fly.prod.toml` (HUMAN)
- [ ] Verify: health + one real request completes end-to-end (HUMAN)

### B2) TestFlight (Jam-only)
- [ ] App Store Connect + signing + upload + testers (HUMAN)

## C) Hygiene (AUTO)
- [x] Run PR body hygiene after receipts exist (AUTO) — Evidence: `./scripts/pr_body_hygiene.sh` produced `/Users/jmcnulty25/.codex/worktrees/9018/solserver/docs/pr/PR-042/receipts/pr_body_solserver.md`
- [x] Populate FIXLOG Promote to Canon targets (AUTO) — Evidence: `docs/pr/PR-042/FIXLOG.md`
