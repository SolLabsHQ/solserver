# SolServer Control Plane — Flow & Process Pack v0

## Purpose
Make SolOS “law” reliably applied to stateless model calls by moving orchestration into SolServer:
- deterministic-first routing (minimize extra model calls)
- mounted law + small per-turn deltas
- retrieval of explicit memory summaries
- drift protocol (pre/post checks + regen policy)
- offline-first Transmission retry with idempotency

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
- meta (client/app version, locale, etc.)
- payload (opaque JSON/text blob if needed)

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
Prompt assembled from: Mounted Law + Runtime Deltas + Retrieval + Windowed Messages.

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

### C) Retrieval (domain-scoped)
- fetch top N memory summaries relevant to Packet + domainFlags
- inject summaries only (full content fetch is separate if ever needed)

### D) Conversation Window
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
5) Assemble prompt (Mounted Law + Deltas + Retrieval + Window)
6) Call inference provider
7) Return assistant message + audit/usage
8) Client appends assistant Message locally
9) If checkpointNeeded: write/refresh Checkpoint capsule

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
- Post-output linter verifies output matches ModeDecision + gates + governance constraints
- On violation: regen with tighter deltas; log flare

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
