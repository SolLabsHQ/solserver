# AGENTPACK — PR-047 — EPIC-042 thread_memento + BreakpointEngine guardrails (v0.5)

**As-of:** 2026-02-21  
**Owner:** Jam  
**Home repo:** solserver (provider-first hub)

## Packet files
- INPUT: ./INPUT.md
- CHECKLIST: ./CHECKLIST.md
- FIXLOG: ./FIXLOG.md

## Dependency order (provider first)
1) solserver (provider)
2) solmobile (client)
3) infra-docs (canonical specs)

## Connected PRs
infra-docs: TBD
solserver: TBD
solmobile: TBD

## Why
- Align solserver behavior with SOLM-EPIC-042 contracts for `context.thread_memento` and breakpoint decisions.
- Enforce message-processing safety so high/peak threads keep summary fields frozen unless a breakpoint decision is `must`.
- Keep assistant final-output formatting constrained by fence safety expectations from ADR-032.

## What changed
- Request contract now accepts `context.thread_memento` (v0.2) for `/v1/chat`.
- Added BreakpointEngine decisioning (`must|should|skip`) and wiring in request orchestration.
- Orchestrator precedence uses request-provided `context.thread_memento` over stored latest memento when both exist.
- Peak guardrail freezes summary updates unless breakpoint decision is `must`.
- Fence linter checks are included as part of EPIC-042 packet verification scope.

## Gates
- unit: pnpm run test
- lint: pnpm run build
- integration: pnpm run test

## Runloop contract
- Complete all AUTO checklist items with receipts (commands + logs).
- HUMAN items are Jam-only; agents must not claim completion.
- If a step needs external/manual dependencies, stop and add BREAKPOINT notes in `FIXLOG.md`.

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
