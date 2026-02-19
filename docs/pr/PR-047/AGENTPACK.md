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

<!-- BEGIN GENERATED: canonical-spec-anchor -->
## Canonical Spec Anchor (infra-docs)
- Epic: SOLM-EPIC-042
- Canonical repo: SolLabsHQ/infra-docs
- Canonical commit: dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9
- Canonical epic path: codex/epics/SOLM-EPIC-042/
- Canonical files:
  - decisions/ADR-031-threadmemento-v0.2-breakpointengine-context-thread-memento-peak-guardrail.md (https://github.com/SolLabsHQ/infra-docs/blob/dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9/decisions/ADR-031-threadmemento-v0.2-breakpointengine-context-thread-memento-peak-guardrail.md)
  - decisions/ADR-032-assistant-markdown-textual-final-only-fence-safety-image-stripping.md (https://github.com/SolLabsHQ/infra-docs/blob/dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9/decisions/ADR-032-assistant-markdown-textual-final-only-fence-safety-image-stripping.md)
  - schema/v0/thread_memento.schema.json (https://github.com/SolLabsHQ/infra-docs/blob/dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9/schema/v0/thread_memento.schema.json)
  - schema/v0/api-contracts.md (https://github.com/SolLabsHQ/infra-docs/blob/dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9/schema/v0/api-contracts.md)
  - architecture/solserver/message-processing-gates-v0.md (https://github.com/SolLabsHQ/infra-docs/blob/dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9/architecture/solserver/message-processing-gates-v0.md)
  - architecture/diagrams/solmobile/transmission.md (https://github.com/SolLabsHQ/infra-docs/blob/dae793fa4a9f601abc4d9fea1fd3a1f5e35504f9/architecture/diagrams/solmobile/transmission.md)
Notes:
- If you have a local checkout, set INFRA_DOCS_ROOT to verify locally.
- Otherwise CI will verify via GitHub at the pinned commit.
<!-- END GENERATED: canonical-spec-anchor -->
