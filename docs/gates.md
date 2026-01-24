# Gates: canonical catalog + routing (first pass)

This document captures the current SolServer gate catalog, routing order, and trace fields as implemented today. It is intended as a canonical reference for gate wiring and future additions (e.g., `librarian_gate`).

## Chat flow routing (current)

Ordered with exact call sites:

1. **Evidence intake** (`runEvidenceIntake`) — URL extraction + auto-capture merge + evidence validation + persistence. Executed before pre-model gates. 【F:src/control-plane/orchestrator.ts†L935-L977】【F:src/gates/evidence_intake.ts†L223-L268】
2. **Pre-model gates pipeline** (`runGatesPipeline`) — ordered: normalize/modality → url_extraction → intent → sentinel → lattice (stub). 【F:src/control-plane/orchestrator.ts†L1040-L1048】【F:src/gates/gates_pipeline.ts†L89-L162】
3. **Model call** (`runModelAttempt`) — executed after prompt pack assembly. 【F:src/control-plane/orchestrator.ts†L1161-L1287】【F:src/control-plane/orchestrator.ts†L1345-L1365】
4. **OutputEnvelope parse + schema validation** (`parseOutputEnvelope` with `OutputEnvelopeSchema.safeParse`). 【F:src/control-plane/orchestrator.ts†L644-L727】【F:src/contracts/output_envelope.ts†L217-L225】
5. **Evidence output gates** (`runEvidenceOutputGates`) — binding then budget. 【F:src/control-plane/orchestrator.ts†L765-L821】【F:src/gates/evidence_output_gates.ts†L70-L218】
6. **Post-output linter + driver-block enforcement** (`postOutputLinter` + per-block trace; strict failure is `driver_block_enforcement`). 【F:src/control-plane/orchestrator.ts†L1445-L1489】【F:src/gates/post_linter.ts†L121-L209】【F:src/control-plane/orchestrator.ts†L1756-L1794】

> Note: The synaptic (memory) gate runs in the memory distillation worker flow, not in the chat request flow. 【F:src/worker.ts†L135-L206】

## Gate catalog (current)

### evidence_intake
- **Purpose:** Extract URLs, create auto-captures, merge client evidence, validate timestamps/references, enforce bounds. 【F:src/gates/evidence_intake.ts†L223-L268】
- **Function(s):** `runEvidenceIntake`. 【F:src/gates/evidence_intake.ts†L236-L268】
- **Input shape:** `PacketInput` (includes `message`, optional `evidence`). 【F:src/contracts/chat.ts†L105-L123】
- **Output fields:** `EvidenceIntakeOutput` → `{ evidence, autoCaptures, clientCaptures, urlsDetected, warnings }`. 【F:src/gates/evidence_intake.ts†L11-L17】
- **Warnings vs hard-fails:** URL extraction is fail-open with warnings; validation/bounds throw `EvidenceValidationError` (fail closed). 【F:src/gates/evidence_intake.ts†L49-L190】【F:src/gates/evidence_intake.ts†L236-L268】
- **Trace event:** `phase: "evidence_intake"` with counts/warnings, auto/client capture counts, snippet chars. 【F:src/control-plane/orchestrator.ts†L959-L976】
- **Caps / limits:** MAX_CAPTURES 25, MAX_SUPPORTS 50, MAX_CLAIMS 50. 【F:src/gates/evidence_intake.ts†L7-L189】

### url_extraction (utility)
- **Purpose:** Extract and validate URLs from text with bounded warnings (used in evidence intake and pre-model gate metadata). 【F:src/gates/url_extraction.ts†L48-L160】
- **Function(s):** `extractUrls`. 【F:src/gates/url_extraction.ts†L64-L160】
- **Input shape:** `text: string`. 【F:src/gates/url_extraction.ts†L64-L68】
- **Output fields:** `{ urls, warnings }` (warnings are `EvidenceWarning`). 【F:src/gates/url_extraction.ts†L64-L67】【F:src/contracts/evidence_warning.ts†L7-L13】
- **Warnings vs hard-fails:** Warnings only (invalid/unsupported/overflow); no hard-fail. 【F:src/gates/url_extraction.ts†L81-L158】
- **Trace event:** No standalone trace; recorded by evidence_intake or url_extraction gate metadata. 【F:src/control-plane/orchestrator.ts†L959-L976】【F:src/gates/gates_pipeline.ts†L124-L135】
- **Caps / limits:** MAX_URL_COUNT 100, MAX_URL_LENGTH 2048, MAX_WARNINGS 10. 【F:src/gates/url_extraction.ts†L3-L6】

### normalize_modality
- **Purpose:** Detect input modalities (text/url/snippet/unknown). 【F:src/gates/normalize_modality.ts†L28-L74】
- **Function(s):** `runNormalizeModality`. 【F:src/gates/normalize_modality.ts†L38-L74】
- **Input shape:** `GateInput` (`messageText`, `urls`, `evidenceCounts`). 【F:src/gates/normalize_modality.ts†L17-L26】
- **Output fields:** `{ modalities, modalitySummary }`. 【F:src/gates/normalize_modality.ts†L12-L15】
- **Warnings vs hard-fails:** None. 【F:src/gates/normalize_modality.ts†L38-L74】
- **Trace event:** `phase: "gate_normalize_modality"` with gate metadata. 【F:src/control-plane/orchestrator.ts†L1086-L1117】
- **Caps / limits:** None. 【F:src/gates/normalize_modality.ts†L38-L74】

### url_extraction (pre-model gate)
- **Purpose:** Emit URL counts + preview metadata for trace. 【F:src/gates/gates_pipeline.ts†L89-L162】
- **Function(s):** `extractUrls` + gate result in `runGatesPipeline`. 【F:src/gates/gates_pipeline.ts†L44-L135】
- **Input shape:** Derived from `PacketInput` in `buildGateInput`. 【F:src/gates/gates_pipeline.ts†L44-L86】
- **Output fields:** Gate metadata (`inlineUrlCount`, `captureUrlCount`, `totalUrlCount`, `warningsCount`, `urlPreviews`). 【F:src/gates/gates_pipeline.ts†L124-L135】
- **Warnings vs hard-fails:** Warnings only (via `warningsCount`). 【F:src/gates/gates_pipeline.ts†L124-L135】
- **Trace event:** `phase: "url_extraction"`. 【F:src/control-plane/orchestrator.ts†L1086-L1117】
- **Caps / limits:** Same as `extractUrls`. 【F:src/gates/url_extraction.ts†L3-L158】

### intent
- **Purpose:** Classify user intent using keyword heuristics. 【F:src/gates/intent_risk.ts†L42-L57】
- **Function(s):** `runIntentGate`. 【F:src/gates/intent_risk.ts†L48-L57】
- **Input shape:** `GateInput`. 【F:src/gates/normalize_modality.ts†L17-L26】
- **Output fields:** `{ intent }`. 【F:src/gates/intent_risk.ts†L29-L57】
- **Warnings vs hard-fails:** None. 【F:src/gates/intent_risk.ts†L48-L57】
- **Trace event:** `phase: "gate_intent"` with `metadata.intent`. 【F:src/control-plane/orchestrator.ts†L1086-L1117】
- **Caps / limits:** None. 【F:src/gates/intent_risk.ts†L88-L168】

### sentinel
- **Purpose:** Classify risk + urgency; attach mood signal. 【F:src/gates/intent_risk.ts†L59-L86】
- **Function(s):** `runSentinelGate`. 【F:src/gates/intent_risk.ts†L59-L86】
- **Input shape:** `GateInput`. 【F:src/gates/normalize_modality.ts†L17-L26】
- **Output fields:** `{ risk, riskReasons, isUrgent?, urgentReasonCode?, urgentSummary?, mood? }`. 【F:src/gates/intent_risk.ts†L33-L86】
- **Warnings vs hard-fails:** None (urgent is metadata). 【F:src/gates/intent_risk.ts†L59-L86】
- **Trace event:** `phase: "gate_sentinel"` with risk metadata. 【F:src/control-plane/orchestrator.ts†L1086-L1117】
- **Caps / limits:** Risk reasons capped to 5. 【F:src/gates/intent_risk.ts†L62-L65】

### lattice (stub)
- **Purpose:** Placeholder for future enrichment/retrieval logic. 【F:src/gates/lattice.ts†L8-L17】
- **Function(s):** `runLattice`. 【F:src/gates/lattice.ts†L13-L17】
- **Input shape:** `GateInput`. 【F:src/gates/normalize_modality.ts†L17-L26】
- **Output fields:** `{ status: "stub" }`. 【F:src/gates/lattice.ts†L3-L17】
- **Warnings vs hard-fails:** None. 【F:src/gates/lattice.ts†L13-L17】
- **Trace event:** `phase: "gate_lattice"` with metadata `lattice`. 【F:src/control-plane/orchestrator.ts†L1086-L1117】
- **Caps / limits:** None. 【F:src/gates/lattice.ts†L13-L17】

### output_envelope parse / schema validation
- **Purpose:** Parse JSON, enforce schema/meta keys, and size limits. 【F:src/control-plane/orchestrator.ts†L644-L727】
- **Function(s):** `parseOutputEnvelope`, `OutputEnvelopeSchema.safeParse`. 【F:src/control-plane/orchestrator.ts†L644-L727】【F:src/contracts/output_envelope.ts†L217-L225】
- **Input shape:** `{ rawText, attempt }`. 【F:src/control-plane/orchestrator.ts†L644-L647】
- **Output fields:** `{ ok: true, envelope }` or `{ ok: false, reason, issuesCount? }`. 【F:src/control-plane/orchestrator.ts†L644-L727】
- **Warnings vs hard-fails:** Hard-fail on invalid JSON/schema or payload too large. 【F:src/control-plane/orchestrator.ts†L650-L726】
- **Trace event:** `phase: "output_gates"`, `kind: "output_envelope"`, `rawLength`, `attempt`, `reason`, `issuesCount`. 【F:src/control-plane/orchestrator.ts†L651-L724】
- **Caps / limits:** MAX_OUTPUT_ENVELOPE_BYTES = 64KB. 【F:src/control-plane/orchestrator.ts†L628-L669】

### evidence_binding
- **Purpose:** Validate that claim evidence refs exist and spans are valid. 【F:src/gates/evidence_output_gates.ts†L70-L106】
- **Function(s):** `runEvidenceBindingGate`. 【F:src/gates/evidence_output_gates.ts†L70-L106】
- **Input shape:** `claims: OutputEnvelopeClaim[]`, `evidencePack: EvidencePack | null`. 【F:src/gates/evidence_output_gates.ts†L70-L73】
- **Output fields:** `{ ok, invalidRefsCount, reason? }`. 【F:src/gates/evidence_output_gates.ts†L9-L13】
- **Warnings vs hard-fails:** Hard-fail if claims lack evidence pack or invalid bindings found. 【F:src/gates/evidence_output_gates.ts†L74-L103】
- **Trace event:** `phase: "output_gates"`, `kind: "evidence_binding"`. 【F:src/control-plane/orchestrator.ts†L774-L789】
- **Caps / limits:** None. 【F:src/gates/evidence_output_gates.ts†L70-L106】

### evidence_budget
- **Purpose:** Enforce claim/ref/meta/evidence size limits. 【F:src/gates/evidence_output_gates.ts†L139-L218】
- **Function(s):** `runEvidenceBudgetGate`. 【F:src/gates/evidence_output_gates.ts†L139-L218】
- **Input shape:** `envelope`, `claims`, `evidencePack`. 【F:src/gates/evidence_output_gates.ts†L139-L143】
- **Output fields:** `{ ok, reason?, counts, limits, metaBytes, evidenceBytes }`. 【F:src/gates/evidence_output_gates.ts†L15-L32】【F:src/gates/evidence_output_gates.ts†L156-L217】
- **Warnings vs hard-fails:** Hard-fail on any limit exceedance. 【F:src/gates/evidence_output_gates.ts†L156-L209】
- **Trace event:** `phase: "output_gates"`, `kind: "evidence_budget"`, `limits`, `counts`, `metaBytes`, `evidenceBytes`. 【F:src/control-plane/orchestrator.ts†L800-L817】
- **Caps / limits:** maxClaims 8, maxRefsPerClaim 4, maxTotalRefs 20, maxMetaBytes 16KB, maxEvidenceBytes 4KB. 【F:src/gates/evidence_output_gates.ts†L34-L40】

### post_output_linter
- **Purpose:** Enforce must-have/must-not rules derived from driver blocks; can warn or hard-fail depending on enforcement mode. 【F:src/gates/post_linter.ts†L121-L209】
- **Function(s):** `postOutputLinter`. 【F:src/gates/post_linter.ts†L121-L209】
- **Input shape:** `{ modeDecision, content, driverBlocks, enforcementMode? }`. 【F:src/gates/post_linter.ts†L121-L126】
- **Output fields:** `PostLinterResult` with `ok`, `violations` or `warnings`, `blockResults`. 【F:src/gates/post_linter.ts†L21-L24】【F:src/gates/post_linter.ts†L204-L209】
- **Warnings vs hard-fails:** Warnings if enforcement is `warn` or DB-003 bypass; otherwise violations are hard-fail. 【F:src/gates/post_linter.ts†L161-L188】【F:src/control-plane/orchestrator.ts†L1756-L1794】
- **Trace event:** `phase: "output_gates"`, `kind: "post_linter"`, `violationsCount`, `blockIds`, `firstFailure`. 【F:src/control-plane/orchestrator.ts†L181-L207】【F:src/control-plane/orchestrator.ts†L1445-L1472】
- **Caps / limits:** None. 【F:src/gates/post_linter.ts†L121-L209】

### driver_block_enforcement (prompt assembly)
- **Purpose:** Assemble driver blocks deterministically and enforce bounds (drop/trim). 【F:src/control-plane/driver_blocks.ts†L102-L237】
- **Function(s):** `assembleDriverBlocks`. 【F:src/control-plane/driver_blocks.ts†L112-L237】
- **Input shape:** `PacketInput`. 【F:src/contracts/chat.ts†L105-L121】
- **Output fields:** `DriverBlockEnforcementResult` with `accepted`, `dropped`, `trimmed`. 【F:src/control-plane/driver_blocks.ts†L26-L31】【F:src/control-plane/prompt_pack.ts†L36-L43】
- **Warnings vs hard-fails:** Warning trace when blocks are dropped/trimmed; no request failure. 【F:src/control-plane/orchestrator.ts†L1296-L1308】
- **Trace event:** `phase: "compose_request"` with `dropped`, `trimmed`. 【F:src/control-plane/orchestrator.ts†L1296-L1308】
- **Caps / limits:** MAX_REFS 10, MAX_INLINE 3, MAX_DEFINITION_BYTES 4KB, MAX_TOTAL_BLOCKS 15. 【F:src/control-plane/driver_blocks.ts†L70-L78】

### driver_block_enforcement (output)
- **Purpose:** Fail closed if strict post-linter violations persist. 【F:src/control-plane/orchestrator.ts†L1756-L1794】
- **Function(s):** Enforcement logic in orchestrator (post-linter). 【F:src/control-plane/orchestrator.ts†L1756-L1794】
- **Input shape:** Linter metadata (`PostLinterMetadata`). 【F:src/control-plane/orchestrator.ts†L181-L207】
- **Output fields:** Enforcement trace metadata `{ kind: "driver_block_enforcement", outcome, attempts, violationsCount }`. 【F:src/control-plane/orchestrator.ts†L1756-L1771】
- **Warnings vs hard-fails:** Hard-fail (422) after attempts. 【F:src/control-plane/orchestrator.ts†L1786-L1794】
- **Trace event:** `phase: "output_gates"`, `kind: "driver_block_enforcement"`. 【F:src/control-plane/orchestrator.ts†L1756-L1771】
- **Caps / limits:** None. 【F:src/control-plane/orchestrator.ts†L1756-L1794】

### synaptic_gate (memory distillation worker)
- **Purpose:** Distill memory fact + mood/rigor metadata in worker flow. 【F:src/memory/synaptic_gate.ts†L64-L209】
- **Function(s):** `processDistillation`, `distillContextWindow`. 【F:src/memory/synaptic_gate.ts†L108-L209】
- **Input shape:** `ContextMessage[]`, `DistillTraceContext`. 【F:src/memory/synaptic_gate.ts†L3-L21】
- **Output fields:** `DistillResult` with `fact`, `rigorLevel`, `moodAnchor`, `sentinel`. 【F:src/memory/synaptic_gate.ts†L64-L75】
- **Warnings vs hard-fails:** Noise filtering emits trace warnings; worker handles errors. 【F:src/memory/synaptic_gate.ts†L79-L129】【F:src/worker.ts†L201-L259】
- **Trace event:** `phase: "synaptic_gate"` (worker trace); `synaptic_gate_noise_filtered` events. 【F:src/worker.ts†L159-L175】【F:src/memory/synaptic_gate.ts†L121-L128】
- **Caps / limits:** MAX_FACT_CHARS 150, MIN_SIGNAL_CHARS 12, MAX_NOISE_EVENTS 1. 【F:src/memory/synaptic_gate.ts†L22-L25】

## URL extraction mismatch (current behavior)

**Where it is computed today:** `buildGateInput` runs `extractUrls(messageText)` before `runNormalizeModality`, so inline URLs are known prior to modality detection. 【F:src/gates/gates_pipeline.ts†L44-L109】

**Why it is precomputed:** `runNormalizeModality` consumes `GateInput.urls` to decide URL modality. 【F:src/gates/normalize_modality.ts†L17-L74】

**Minimal refactor (Option A) to align execution + trace order:**
- Move `extractUrls` to the url_extraction gate step (after normalize).
- Update `runNormalizeModality` to use URL count derived from evidence captures or a new `captureUrlCount` field (so normalize no longer depends on inline URLs computed earlier).
- Keep `url_extraction` gate responsible for inline URL detection + warnings metadata. 【F:src/gates/gates_pipeline.ts†L44-L162】【F:src/gates/normalize_modality.ts†L17-L74】

## Librarian gate insertion (recommended)

**Primary insertion point:** After `parseOutputEnvelope` succeeds and before `runEvidenceOutputGates`, so it can prune or score claim refs without rewriting `assistant_text`. 【F:src/control-plane/orchestrator.ts†L644-L727】【F:src/control-plane/orchestrator.ts†L765-L821】

**Best structure to prune citations without rewriting text:** Operate on `OutputEnvelope.meta.claims` (evidence refs are scoped there). 【F:src/contracts/output_envelope.ts†L10-L15】【F:src/contracts/output_envelope.ts†L88-L106】

**Exact orchestrator insertion location + available variables (attempt 0):** Insert between `envelope0` parse and `runEvidenceOutputGates` call. Variables in scope include `envelope0.envelope` (parsed output), `evidencePack`, and `gatesOutput` (intent/sentinel/etc). 【F:src/control-plane/orchestrator.ts†L1850-L1917】【F:src/control-plane/orchestrator.ts†L1046-L1050】【F:src/control-plane/orchestrator.ts†L1188-L1196】

**Minimal schema additions (proposed):**
- `meta.support_score?: number`
- `meta.unsupported_claim_ids?: string[]`
- `meta.librarian_gate?: { version: string; pruned_refs: number; unsupported_claims: number }`

**Trace event:** `phase: "output_gates"`, `kind: "librarian_gate"` with counts and reason codes.

## Test plan (for librarian gate)

Suggested tests/locations:
1. `test/librarian_gate.test.ts` — prunes invalid refs without mutating `assistant_text`.
2. `test/output_envelope_meta.test.ts` — schema accepts new librarian meta fields.
3. `test/evidence_output_gates.test.ts` — librarian-pruned refs pass binding/budget.
4. `test/trace.test.ts` — trace contains `output_gates` event with `kind: "librarian_gate"`.
5. `test/orchestrator.gates_order.test.ts` (new) — ensure librarian gate is between parse and evidence gates.

## Appendix: types referenced

- **PacketInput / Evidence**: `src/contracts/chat.ts`. 【F:src/contracts/chat.ts†L46-L123】
- **OutputEnvelope / meta / claims**: `src/contracts/output_envelope.ts`. 【F:src/contracts/output_envelope.ts†L5-L230】
- **EvidencePack**: `src/evidence/evidence_provider.ts`. 【F:src/evidence/evidence_provider.ts†L1-L24】
- **EvidenceWarning**: `src/contracts/evidence_warning.ts`. 【F:src/contracts/evidence_warning.ts†L1-L13】

## Clarifications (for librarian gate + schema)

### Where do claims live in OutputEnvelope today?
- **Claims live at `OutputEnvelope.meta.claims`** (not top-level). This is enforced by the meta schema and consumed by evidence output gates. 【F:src/contracts/output_envelope.ts†L65-L92】【F:src/gates/evidence_output_gates.ts†L56-L75】

### Canonical ghost card indicator
- The **canonical indicator** is `meta.display_hint === "ghost_card"`; ghost metadata is required only when this is set, and ghost_kind is required for ghost cards. 【F:src/contracts/output_envelope.ts†L96-L147】
- **Where it is set:** memory distillation builds ghost envelopes with `display_hint: "ghost_card"` and `ghost_kind`. 【F:src/memory/ghost_envelope.ts†L16-L30】

### Evidence intake caps (MAX_CLAIMS) meaning
- **`MAX_CLAIMS` limits evidence-side claim map entries** in `PacketInput.evidence.claims` (not model OutputEnvelope claims). 【F:src/gates/evidence_intake.ts†L7-L189】【F:src/contracts/chat.ts†L86-L101】

### Trace naming uniformity (gate_* vs url_extraction)
- **Today:** phases are `gate_normalize_modality`, `gate_intent`, `gate_sentinel`, `gate_lattice`, but URL extraction uses `url_extraction`. 【F:src/control-plane/orchestrator.ts†L1040-L1117】
- **Smallest uniform rename:** rename trace phase from `url_extraction` → `gate_url_extraction` (and update the ordering contract + tests) to match the gate_* convention. 【F:src/control-plane/orchestrator.ts†L1040-L1048】【F:src/control-plane/orchestrator.ts†L1086-L1117】
