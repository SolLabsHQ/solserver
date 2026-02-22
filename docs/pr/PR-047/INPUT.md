# INPUT — PR-047 — EPIC-042 thread_memento + BreakpointEngine guardrails (v0.5)

Use this packet with `AGENTPACK.md` for runloop execution and receipts collection.

## Why
- Bring solserver into SOLM-EPIC-042 contract compliance for request-scoped `context.thread_memento` handling.
- Add breakpoint-based guardrails so peak/high threads preserve summary stability unless a `must` breakpoint is reached.
- Maintain assistant markdown safety expectations with fence linter checks aligned to ADR-032.

## What changed
- `/v1/chat` request contract accepts `context.thread_memento` (v0.2) and applies request-over-stored precedence.
- BreakpointEngine behavior (`must|should|skip`) is integrated into orchestration and trace output.
- Peak guardrail behavior freezes summary fields unless breakpoint decision is `must`.
- Fence linter coverage is part of packet verification evidence.

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
