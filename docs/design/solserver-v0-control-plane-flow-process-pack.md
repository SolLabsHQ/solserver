# SolServer Control Plane — Flow & Process Pack v0

## Purpose
Make SolOS “law” reliably applied to stateless model calls by moving orchestration into SolServer:
- deterministic-first routing (minimize extra model calls)
- mounted law + small per-turn deltas
- retrieval of explicit memory summaries
- drift protocol (pre/post checks + regen policy)
- offline-first Transmission retry with idempotency
- Driver Blocks: user-owned micro-protocols that reduce cognitive carry and tighten compliance without user round-trips

---

## Core Artifacts

### Packet
Opaque payload wrapper (evolves over time).
- packetId
- packetType: chat | memorySave | usage | sync (future)
- threadId
- messageIds[]
- checkpointIds[]?
- factBlockRefs[]? (future)
- budgets?
- pinnedContextRef? (id/version/hash)
- driverBlockMode? (default | custom) (optional; audit clarity)
- driverBlockRefs[]? (system/default blocks by `{id, version}`)
- driverBlockInline[]? (local-first custom blocks carried inline in Packet for v0 stateless support)
- meta (client/app version, locale, etc.)
- payload (opaque JSON/text blob if needed)

> Rationale: SolServer can apply system-default Driver Blocks by reference, and apply user customizations without needing a server-side registry in v0 by accepting inline blocks in Packet.

### Transmission
Remote work unit carrying a Packet.
- transmissionId
- type
- requestId (idempotency key)
- status: queued | sending | succeeded | failed
- packetId
- deliveryAttempts[]

### DeliveryAttempt
Attempt record for retry/telemetry.
- attemptId
- transmissionId
- status
- startedAt, endedAt?
- errorCode?, latencyMs?

### ModeDecision
Output of the control plane (SoleRouter + gates).
- modeLabel (single active mode)
- domainFlags[] (architecture/finance/legal/SolOS-governance/etc.)
- rigorConfig (enabled gates + strictness)
- clusterIds[] (prompt modules activated)
- checkpointNeeded (bool)
- confidence (0–1)
- reasons[] (short)
- version (mode engine version)

### PromptProfile
Server-side registry of prompt modules by version.
- profileId
- modules[] (mounted law, mode contracts, style layer, output constraints)

### DriverBlock
User-owned micro-protocol used to reduce cognitive carry and tighten compliance.
Conceptually compiles into:
- prompt constraints (tightening)
- output contract (required fields/sections)
- validators (required/must-not patterns)
- action expectations (e.g., offload artifacts)

Driver Blocks can be:
- System default (shipped baseline, resolvable via `driverBlockRefs`)
- User-created offline (local-first, carried via `driverBlockInline` in v0)
- Runtime-created (assistant proposes; user explicitly approves; stored locally; optionally synced later)

> Driver Blocks are policy inputs. They are not “persona selection.” They shape how the selected mode behaves and how outputs are validated.

---

## Routing Ladder (Deterministic First)
Goal: usually 1 model call; 2 calls only when ambiguous.

### Step 0 — Hard Overrides (0 calls)
Inputs:
- explicit call-words / mode request
- high-rigor domain triggers (finance/legal/architecture/SolOS governance)
- “system ops” intent
Output:
- ModeDecision confidence = 1.0

### Step 1 — Deterministic Classifier (0 calls)
Inputs:
- keyword/ontology + structural cues (numbers/dates/constraints)
- thread metadata (last modeLabel, known domain tags)
Output:
- ModeDecision with confidence score

### Step 2 — LLM Selector (1 cheap call; only if needed)
Condition:
- confidence below threshold
Behavior:
- tiny selector prompt returns strictly ModeDecision JSON (no prose)
Output:
- ModeDecision (with confidence + reasons)

### Step 3 — Main Response (1 call)
Prompt assembled from: Mounted Law + Runtime Deltas + Driver Blocks + Retrieval + Windowed Messages.

---

## Prompt Assembly Contract

### A) Mounted Law (always included, versioned)
Small and stable; referenced by version/hash:
- mode invariants (one active mode)
- rigor gate rules
- governance constraints (no authority laundering, etc.)
- “stop/ask” when undefined or missing required inputs
- output constraints for the selected mode (format/behavior)

### B) Runtime Deltas (per call)
- ModeDecision (modeLabel + gates + clusterIds)
- budgets (token caps, retry caps)
- checkpoint capsule summary (only when checkpointNeeded)

### C) Driver Blocks (policy inputs; per call)
Driver Blocks are selected and compiled by Policy Engine for this turn.

Inputs:
- system default blocks (refs)
- user custom blocks (inline from Packet)
- (future) thread overrides/preferences

Compile outputs:
- promptConstraints: small additive constraints injected into the prompt (e.g., “Facts Block required,” “Receipt → Release required,” “no authority drift”)
- outputContract: required fields/sections (e.g., “Decisions/Next,” “Receipt/Release,” “assumptions labeled”)
- validators: forbidden patterns + required components
- actionExpectations (optional): when triggers occur, require offload artifacts (Anchor/Checkpoint/OpenLoop template)

> Driver Blocks are designed to reduce user round-trips by tightening the model’s obligations and enforcing them server-side.

### D) Retrieval (domain-scoped)
- fetch top N memory summaries relevant to Packet + domainFlags
- inject summaries only (full content fetch is separate if ever needed)

### E) Conversation Window
- last N messages (bounded)
- referenced Anchors/Checkpoints (bounded)

---

## Checkpoint / Heartbeat Policy

### Trigger set
checkpointNeeded = true when any of:
- modeLabel changed since last assistant turn
- high-rigor domainFlags present
- long thread / high churn (message count/token estimate thresholds)
- drift flare (post-output linter failure / forced regen)
- user requests re-anchor / replay / “what’s decided?”
- explicit checkpoint command (future)

### Behavior
- on trigger: create or refresh Checkpoint capsule and inject summary for this turn

---

## Sequences

### S1 — Normal chat turn (no selector)
1) Client creates Message locally (and Captures if any)
2) Client enqueues Transmission(chat, requestId, packetId)
3) SolServer receives Packet
4) SoleRouter Step 0/1 → ModeDecision (high confidence)
5) Policy Engine selects Driver Blocks (system defaults + user inline)
6) Assemble prompt (Mounted Law + Deltas + Driver Blocks + Retrieval + Window)
7) Call inference provider
8) Post-process: validate output against ModeDecision + gates + governance + Driver Blocks
9) Return assistant message + audit/usage (+ optional action hints)
10) Client appends assistant Message locally
11) If checkpointNeeded: write/refresh Checkpoint capsule

### S2 — Ambiguous chat turn (selector escalation)
Same as S1, except:
4) Step 0/1 low confidence → LLM Selector → ModeDecision JSON

### S3 — Capture async processing (client-local)
1) Message created immediately with Capture(s) attached (status=pending)
2) CaptureProcessor runs async
3) Update Capture: status, dataDescription, data
4) UI reflects updates without blocking new sends
5) Optional: if an action requires derived data, gate only that action (don’t trap the user)

### S4 — Retry / DeliveryAttempts
1) TransmissionQueue sends Transmission
2) Record DeliveryAttempt
3) On failure: Transmission failed/queued; store error info
4) Retry policy: backoff + max attempts + manual retry
5) Idempotency: requestId prevents double apply server-side

### S5 — Driver Block patch loop (server-side; max 1 retry)
1) Inference returns output
2) Validator checks output vs:
   - ModeDecision + rigorConfig
   - governance constraints
   - Driver Block contract + forbidden patterns
3) If validation fails:
   - regen once with “tighter deltas” (targeted patch instructions)
4) If still fails:
   - return best compliant partial + surface “missing required facts/input” only when needed

> Goal: reduce user-visible “try again” loops while keeping deterministic-first behavior.

---

## State Machines

### Capture.status
pending → ready  
pending → failed  
failed → pending (manual retry)

### Transmission.status
queued → sending → succeeded  
queued → sending → failed  
failed → queued (manual retry)  
(DeliveryAttempts accumulate)

### Checkpoint lifecycle
none → created  
created → updated (on triggers)

---

## Drift Protocol (Enforcement Layer)

### Detection: server-side first
- Post-output linter verifies output matches ModeDecision + gates + governance constraints + Driver Blocks
- On violation: regen with tighter deltas (including Driver Block patch directives); log flare

### When to surface drift to the user
Default: do not surface; silently correct via regen.
Surface only if:
- user explicitly asks for drift check
- repeated regen failures
- requires user input (“missing required facts”)
- mode allows meta-ops and a re-anchor is triggered

---

## Decisions Locked (v0)
- client does not choose persona/mode; SolServer produces ModeDecision
- deterministic routing is default; selector call only when ambiguous
- mounted law is versioned and always included
- checkpoint injection is trigger-driven, not constant
- Transmission carries Packet; DeliveryAttempts track retries; requestId enforces idempotency
- Driver Blocks are policy inputs applied by Policy Engine; Packet may carry custom blocks inline in v0
- Patch loop is internal and capped (max 1) to preserve deterministic-first

---

### Notes (implementation stance)
- Driver Blocks do not require new top-level services in v0:
  - they live inside Policy Engine as: select → compile → validate → (optional patch)
- SolMobile remains local-first:
  - user-created Driver Blocks live locally and can be carried inline per request
  - future: sync/registry can be added without changing the conceptual model