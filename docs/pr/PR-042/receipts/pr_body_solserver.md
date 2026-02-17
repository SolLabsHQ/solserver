## Why
v0 production launch for SolServer: prod Fly config in SJC, SQLite on volume, and release readiness.

## What changed
* [x] Added production Fly config (separate from staging) and documented deploy procedure.
* [x] Confirmed web + worker runtime requirements and shared DB path contract.
* [x] Generated "secrets only" command and verification checklist for Jam.

## Risk
* Risk level: Medium
* Failure modes:
  * Worker not running or cannot reach internal API -> transmissions stuck
  * Volume mount or DB path mismatch -> data loss or split brain
  * Wrong internal_port / PORT wiring -> app unreachable
  * Prod domain/TLS miswire -> HTTPS fails
* Rollback plan: Revert to last known-good commit/image; keep volume intact; redeploy with prior config.

## Checks
* [x] Tested locally or verified in GitHub UI
* [x] No secrets added
* [x] Main remains PR-only
* [x] If KinCart-related: boundary rules respected (no SolOS identity/memory leakage)

## Links
Issue: TBD
ADR: TBD
Docs: TBD
Follow-ups: TBD

### Connected PRs
infra-docs: TBD
solserver:  TBD
solmobile:  TBD

### Staging Merge Gate
TBD

Revert staging after merge:
```sh
TBD
```

### Test Results
- TBD

#### Gate receipts (from checklist)
- [ ] unit (AUTO) — Evidence: Command: `pnpm run test` | Result: PASS | Log: `docs/pr/PR-042/receipts/unit.log`
- [ ] lint (AUTO) — Evidence: Command: `pnpm run build` | Result: PASS | Log: `docs/pr/PR-042/receipts/lint.log`
- [ ] integration (AUTO) — Evidence: Command: `pnpm run test` | Result: PASS | Log: `docs/pr/PR-042/receipts/integration.log`
