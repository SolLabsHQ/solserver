# FP-013 implementation status audit (solserver)

Date: 2026-02-21

## Verdict

FP-013 is **partially implemented**. Core BreakpointEngine and peak guardrail wiring are in place, and the API already accepts `thread_memento` v0.2 with optional `signals`. However, key Option A semantics and closure prompt-injection correctness are not fully implemented yet.

## Coverage summary

| FP-013 area | Status | Evidence |
|---|---|---|
| Prompt-context correctness for UI closure (always injected when flagged) | **Missing / unclear** | No `include_in_prompt` or `closureIncludeInPrompt` handling was found in server prompt/transcript codepaths. |
| BreakpointEngine deterministic-first (`must/should/skip`) | **Implemented (baseline)** | `decideBreakpointAction` supports signal-driven and heuristic decisions with `must/should/skip`. |
| Peak guardrail freezes summary unless MUST | **Implemented** | `shouldFreezeSummaryAtPeak` + orchestrator wiring prevents shape updates at peak/high unless decision is `must`. |
| Affect points recorded on USER messages only | **Not implemented** | Affect updates are sourced from assistant output `meta.affect_signal` during response handling, not directly from incoming user turns. |
| Affect FIFO cap | **Implemented** | Affect points are capped to 5 (latest window). |
| Deterministic rollup from time series | **Partially implemented** | Rollup uses simple latest-intensity bucketing and phase delta over the last point pair; recency-weighted intensity and 3-point slope semantics from FP-013 are not present. |
| Summary fields update only at breakpoints | **Partially implemented** | Summary updates are blocked at peak unless MUST, but otherwise default decision flow returns `should` for most turns, so summary can still update frequently. |
| Signals (`decision_made`, `ack_only`, etc.) available and advisory | **Implemented (input side)** | v0.2 contract includes `signals`; orchestrator extracts signal kinds to influence breakpoint decisions. |
| `/v1/chat` thread memento versioning with v0.2 | **Implemented** | Request contract accepts `context.thread_memento` as `memento-v0.2`. |
| Concurrency token (`thread_memento_etag`) | **Not implemented** | No ETag/thread memento token fields were found in route/contracts store wiring. |

## Key file references

- Breakpoint decision + guardrail logic: `src/control-plane/breakpoint_engine.ts`.
- Affect update + rollup implementation: `src/control-plane/retrieval.ts`.
- Orchestrator wiring for breakpoint decisions, peak freeze, and affect ingestion from envelope meta: `src/control-plane/orchestrator.ts`.
- API contract for `context.thread_memento` v0.2 + optional signals: `src/contracts/chat.ts`.
- Regression coverage around peak guardrail and memento precedence: `test/thread_memento_latest.test.ts`, `test/breakpoint_engine.test.ts`.

## Practical interpretation

If your question is "can we claim FP-013 done end-to-end?" the answer is **no**.

If your question is "did we already land the structural pieces needed for FP-013?" the answer is **yes, partially** (breakpoint engine, peak guardrail, v0.2 signals contract, and memento precedence are already present).
