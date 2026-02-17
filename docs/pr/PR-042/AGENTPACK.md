# AGENTPACK — PR-042 — v0 Production Launch & TestFlight (v0.5)

**As-of:** 2026-02-17  
**Owner:** Jam  
**Home repo:** solserver (provider-first hub)

## Packet files
- INPUT: ./INPUT.md
- CHECKLIST: ./CHECKLIST.md
- FIXLOG: ./FIXLOG.md

## Dependency order (provider first)
1) solserver (provider)
2) solmobile (client)
3) infra-docs (docs)

## Connected PRs
infra-docs: TBD
solserver:  TBD
solmobile:  TBD

## Facts (locked)
- Fly prod app name: `solserver-prod`
- Region: `sjc`
- Prod domain: `api.sollabshq.com` (cert ready)
- Volume mount: `/data` (volume name: `solserver_data`)
- DB path: `/data/control_plane.db`
- Two processes: `web` + `worker` (shared DB path)

## Execution truth for solserver
- See: `./SOLSERVER_TASKS_A-E.md` (implementation contract)

## Workstreams (subagents)
Workstreams are a map, not magic. Use them to split work across agents/worktrees.

1) Workstream A - Fly prod config
   - Deliver: `fly.prod.toml` (do not overwrite staging)
   - Verify: internal_port, PORT wiring, volume mount, DB path

2) Workstream B - Env var classification
   - Deliver: env var table (required/secret/default/scope/meaning)
   - Verify: derived from dev.md + code usage, no invented values

3) Workstream C - Runtime wiring and health
   - Deliver: confirm `/health` (or add minimal), confirm worker handshake contract
   - Verify: receipts in CHECKLIST + FIXLOG

4) Workstream D - Docs + PR hygiene
   - Deliver: doc block for Jam (deploy command, secrets-only command, verify checklist)
   - Deliver: PR body hygiene from receipts

## Gates (fill with the repo’s real commands)
- unit: pnpm run test
- lint: pnpm run build
- integration: pnpm run test

## Runloop contract
- Complete all AUTO checklist items with receipts (commands + logs).
- HUMAN items are Jam-only. Agents must not claim completion.
- If a step requires prod credentials/DNS/Apple access, stop and write BREAKPOINT notes in FIXLOG.

## Promote to Canon (post-merge)
- ADR updated: TBD
- Evergreen docs updated: TBD
- Release notes updated: TBD
