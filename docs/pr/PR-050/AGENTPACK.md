# AGENTPACK — PR-050 — solserver

<!-- BEGIN GENERATED: canonical-spec-anchor -->
## Canonical Spec Anchor (infra-docs)
- Epic: SOLM-EPIC-044
- Canonical repo: SolLabsHQ/infra-docs
- Canonical commit: 5e79a954b240c2a27b03710119d7bf96e1842cf2
- Canonical epic path: codex/epics/SOLM-EPIC-044/
- Canonical files:
  - decisions/ADR-031-threadmemento-v0.2-breakpointengine-context-thread-memento-peak-guardrail.md (https://github.com/SolLabsHQ/infra-docs/blob/5e79a954b240c2a27b03710119d7bf96e1842cf2/decisions/ADR-031-threadmemento-v0.2-breakpointengine-context-thread-memento-peak-guardrail.md)
Notes:
- If you have a local checkout, set INFRA_DOCS_ROOT to verify locally.
- Otherwise CI will verify via GitHub at the pinned commit.
<!-- END GENERATED: canonical-spec-anchor -->

<!-- BEGIN GENERATED: epic-execution-payload -->
## Scope for solserver
- Add `context.thread_memento_ref` request support and keep legacy `context.thread_memento` for migration compatibility.
- Unify `/v1/memento` latest semantics with the same authoritative `thread_memento_latest` path used by `/v1/chat` carry lookup.

## Required Behaviors
- API shape lock: add `context.thread_memento_ref` (object) to `/v1/chat` request context with fields:
  - `mementoId` (required)
  - `threadId` (optional)
  - `createdTs` (optional)
- Keep `/v1/chat` backward compatible during rollout: `context.thread_memento` remains accepted.
- Deterministic carry precedence MUST be:
  1. `context.thread_memento_ref` resolution
  2. `context.thread_memento` (legacy full object)
  3. stored `thread_memento_latest`
  4. safe empty seed
- `/v1/memento` default latest behavior MUST resolve from the same authoritative latest source as `/v1/chat` carry.
- Maintain structured continuity intent from ADR-031: decisions/affect continuity must survive sequential turns (for example, decide -> lock decision).
- Add debug traceability for carry source/resolution in successful runs.

## Acceptance Criteria
- solserver: `/v1/chat` accepts `context.thread_memento_ref` and resolves carry via deterministic precedence.
- solserver: `/v1/memento` latest and `/v1/chat` carry semantics are aligned on authoritative latest source.
- continuity: sequential planning turns retain prior decision context in normal flow.

## Out of Scope
- infra-docs: Regenerate canonical EPIC-044 packet docs with locked API shape (`context.thread_memento_ref`) and deterministic carry precedence.
- infra-docs: Patch ADR-031 with Addendum A2 documenting reference-first carry and latest-source alignment decisions.
- solmobile: Emit compact carry by default (`context.thread_memento_ref`) and avoid full memento echo unless compatibility fallback is required.
- solmobile: Preserve existing user-visible memory controls while transport shifts to reference-first behavior.

## Packet Source Docs
- codex/epics/SOLM-EPIC-044/AGENTPACK-SOLM-EPIC-044.md (https://github.com/SolLabsHQ/infra-docs/blob/99fd8ada2542b57e2f02731492b8b16961a45148/codex/epics/SOLM-EPIC-044/AGENTPACK-SOLM-EPIC-044.md)
- codex/epics/SOLM-EPIC-044/INPUT-SOLM-EPIC-044.md (https://github.com/SolLabsHQ/infra-docs/blob/99fd8ada2542b57e2f02731492b8b16961a45148/codex/epics/SOLM-EPIC-044/INPUT-SOLM-EPIC-044.md)
- decisions/ADR-031-threadmemento-v0.2-breakpointengine-context-thread-memento-peak-guardrail.md (https://github.com/SolLabsHQ/infra-docs/blob/99fd8ada2542b57e2f02731492b8b16961a45148/decisions/ADR-031-threadmemento-v0.2-breakpointengine-context-thread-memento-peak-guardrail.md)
- solserver/docs/notes/FP-013-implementation-status.md (https://github.com/SolLabsHQ/solserver/blob/main/docs/notes/FP-013-implementation-status.md)
- solos-internal/thoughts/FP-013-threadmemento-breakpoints-v2.md (https://github.com/SolLabsHQ/solos-internal/blob/main/thoughts/FP-013-threadmemento-breakpoints-v2.md)
- solos-internal/thoughts/pr 42/FP-013-threadmemento-signals-breakpoints.md (https://github.com/SolLabsHQ/solos-internal/blob/main/thoughts/pr%2042/FP-013-threadmemento-signals-breakpoints.md)
<!-- END GENERATED: epic-execution-payload -->
