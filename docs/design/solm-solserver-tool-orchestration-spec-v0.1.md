# SolM + SolServer Tool Orchestration Spec v0.1
Status: Draft
Audience: SolM / SolServer implementers
Decision: **Option A - SolServer as Single Orchestrator (selected)**
Scope: Tool-call orchestration for "model wants info" across local (SolM) and server (SolServer) execution.

---

## 1. Summary
SolM + SolServer treats "GPT wants info" as a **tool-call contract**. The model proposes tool calls; the system decides **where** each tool executes (device vs server) based on:
- **trust** (OS as source of truth),
- **offline capability**,
- **secrets** (keys/PII governance),
- **audit and policy** (central enforcement).

This design keeps SolM **local-first** and SolServer **governed**, while allowing both to act as tool executors under one shared envelope.

### Draft and truth note
This spec is a design intent for v0.1. It is not authoritative by itself.
- The API contracts and Control Plane flow pack are the source of truth for fields and endpoints.
- This doc explains where tool orchestration belongs in the runtime and what invariants we must preserve.

---

## 2. Shape
- **Core flow:** model proposes tool calls → SolServer executes (or delegates to SolM local tools) → results return → model answers.
- **Two tool lanes:**
  - **Local Tools (SolM)** for OS-truth + offline
  - **Server Tools (SolServer)** for secrets, network, governance, audit
- **One contract:** a single `ToolCall` / `ToolResult` envelope so SolM and SolServer can both be executors.
- **Guardrails:** consent + minimization + idempotency + audit, especially for writes.
- **4B budgets:** Bounds/Buffer/Breakpoints/Beat applied to tool execution so it can’t sprawl.

---

## 3. Canonical Flow (Who Does What)

### 3.0 Where this fits in the Control Plane
Tool orchestration is a phase inside a single Transmission attempt.
Order (conceptual):
- Packet accepted and stored
- Transmission created (idempotent)
- ModeDecision computed
- Prompt assembly (mounted law + retrieval slots)
- Tool phase (optional): model proposes ToolCall list
- Execution phase: SolServer executes server tools or delegates local tools to SolM
- ToolResult list returned to model
- Model emits final OutputEnvelope
- Gates validate OutputEnvelope. On failure, one bounded regen attempt is allowed

This means tool calls and tool results should be logged and attributable to a transmissionId and attemptId.

### 3.1 Model Constraint
The **model never calls your services directly**. It emits tool-call intents like:

```json
{ "tool_call": { "name": "calendar.query", "args": { "time_min": "...", "time_max": "..." } } }
```

SolServer (or SolM, depending on tool lane) actually executes the work.

### 3.2 Recommended Orchestration
1. **SolM → SolServer:** user intent + minimal local context summary (optional; minimized)
2. **SolServer → Model:** prompt + tool catalog
3. **Model → SolServer:** tool calls (JSON)
4. **SolServer executes:**
   - **Server tool** → call internal service / DB / third party
   - **Local tool** → ask SolM to execute locally (EventKit/FTS5/etc.) and return sanitized result
5. **SolServer → Model:** tool results
6. **Model → SolServer → SolM:** final response + any "proposed actions" requiring confirmation

**Outcome:** secrets + governance live in SolServer while still honoring "OS as source of truth."

---

## 4. Two Tool Lanes (Clear Split)

### 4.1 Local Tools (SolM Executes)
Use for **offline-safe** + **OS-authoritative** reads/writes:

- `os.calendar.query` (EventKit read)
- `os.reminders.create` (EventKit write)
- `local.search` (SQLite/FTS5 over captures)
- `local.thread.get` (read local store)
- `device.state` (online/offline, locale, time)

**Why:** no server round-trip needed; OS is the truth; works offline.

### 4.2 Server Tools (SolServer Executes)
Use when you need **secrets**, **network**, or **governance**:

- `solserver.search_global` (server index / cross-device / remote archive)
- `solserver.fetch_url` (if controlled web retrieval is allowed)
- `solserver.profile.get` (account-level settings, policy, entitlements)
- `solserver.transcribe_cloud` (cloud fallback STT)
- any integration w/ third-party APIs

**Why:** keys stay server-side; you can rate-limit, audit, and enforce policy.

---

## 5. One Envelope Contract (Both Lanes)

### 5.1 Design Goal
A single shared shape lets SolM and SolServer both act as "tool executors" with uniform logging, retries, audits, and error handling.

### 5.2 `ToolCall`
```json
{
  "call_id": "uuid",
  "name": "os.calendar.query",
  "args": {
    "time_min": "2025-12-24T00:00:00-08:00",
    "time_max": "2025-12-25T00:00:00-08:00"
  },
  "context": {
    "thread_id": "uuid",
    "user_intent_id": "uuid",
    "privacy_tier": "low|medium|high"
  }
}
```

### 5.3 `ToolResult`
```json
{
  "call_id": "uuid",
  "name": "os.calendar.query",
  "status": "ok|error",
  "data": {
    "events": [
      { "title": "…", "start": "…", "end": "…" }
    ]
  },
  "error": {
    "code": "OFFLINE|DENIED|TIMEOUT|BAD_ARGS",
    "message": "…"
  }
}
```

### 5.4 Key Rule
Tool results must be **data-first**, not prose.
The model does narration; tools return structured facts.

---

## 6. Guardrails for Writes: Breakpoints

### 6.1 Principle
For any tool that **changes state** (create reminder, send message, post calendar event, etc.), enforce a **Breakpoint** (explicit user control).

### 6.2 Pattern
- Model may propose: `os.reminders.create {...}`
- SolServer responds to SolM: **"Proposed action: create reminder X. Approve?"**
- Only after user confirmation does SolM execute the write.

**Outcome:** prevents "oops it edited my life" and preserves user agency.

---

## 7. 4B Budgets for Tool Execution
Apply 4B to every orchestration run:

### 7.1 Bounds
- max tool calls (e.g., 3)
- max payload bytes (request + results)
- max latency per tool

### 7.2 Buffer
Fallback plan when a tool fails:
- offline message
- cached answer
- partial results with explicit limitation

### 7.3 Breakpoints
Consent gates for:
- writes
- sensitive reads
- sharing data off-device

### 7.4 Beat
Retry beat:
- 0 retries for writes
- 1 retry for reads (optional)
- exponential backoff for transient network issues

**Outcome:** deterministic governor even when the model gets "curious."

---

## 8. Minimal v0 Tool Set (80% Coverage)

### 8.1 Local (SolM)
- `local.capture.list(thread_id, limit)`
- `local.search(query, scope, limit)`
- `os.calendar.query(time_min, time_max)`
- `os.reminders.create(title, due, notes)` *(write → Breakpoint)*

### 8.2 Server (SolServer)
- `solserver.user.get_settings()`
- `solserver.transcribe_cloud(audio_ref)` *(fallback only)*
- `solserver.archive.search(query)` *(optional in v0)*

Everything else can wait until the loop is proven.

### v0.1 scope guard
For v0.1, it is acceptable to define the ToolCall and ToolResult contracts and log shapes without implementing full server-to-device delegation.
- Local tools can be stubbed or kept read-only.
- Write tools must require a Breakpoint confirmation before execution.

---

## 9. Selected Architecture: Option A - SolServer as Single Orchestrator
SolServer runs the model and routes all tool calls. SolM:
- executes local tools when delegated,
- renders Breakpoints (confirmations),
- returns sanitized tool results back to SolServer.

### Pros
- Centralized governance + audit
- Consistent tool catalog and policy
- Secrets and network access remain server-side

### Cons / Implications
- Model-driven workflows require SolServer availability
- Offline behavior should degrade to deterministic local features (capture/search/OS actions) without "model orchestration"

---

## 10. Mini Re-anchor
- **Arc:** "How GPT gets info" → tool calls with SolServer/SolM executing
- **Active:** two-lane tools + shared ToolCall/ToolResult + Breakpoints for writes
- **Parked:** MCP vs custom tool gateway; exact security/audit fields; error UX patterns
- **Decisions:** Option A selected
- **Next:** define exact packet fields + example sequences for:
  - local search,
  - calendar query,
  - reminder create (write + Breakpoint).

---
End.
