# PR8 Server: Ghost Card, Journal, and Memory Vault (v0)

Status: revised draft
Date: 2026-01-20

## Summary
This document describes the server-side implementation for Ghost Cards, Journal, and Memory Vault features. The server exposes async memory distillation, explicit memory CRUD, and delivery of distilled artifacts as muted OutputEnvelope packets. This spec aligns with ADR-022, ADR-023, and ADR-024.

Key decisions:
- Idempotency uses request_id everywhere (no idempotency_key).
- The Synaptic Gate is the distillation gate (Gate 04 naming may be referenced once for grep).
- Distill requests return an ACK only; the artifact arrives later as a muted Ghost Card.
- Batch delete uses POST /v1/memories/batch_delete (no DELETE /v1/memories?thread_id=...).
- Canonical ghost routing uses meta.ghost_kind; ghost_type is deprecated and should be mapped for backward compatibility.

---

## 1. API Contract

### 1.1 POST /v1/memories/distill (async)

Purpose: extract a candidate memory artifact from a bounded context window when a user explicitly requests Save to Memory.

Request (conceptual):
- request_id (idempotency key; MUST be stable across retries)
- thread_id
- trigger_message_id
- context_window[] (capped; chronological order preferred)
  - message_id
  - role: user | assistant | system
  - content
  - created_at
- reaffirm_count (optional; default 0)
- consent:
  - explicit_user_consent: true

Response (ACK only):
- request_id
- transmission_id
- status: pending

Notes:
- Distillation results are delivered later via a muted OutputEnvelope Ghost Card.
- The ACK must not include the distilled fact/snippet.

### 1.2 POST /v1/memories

Purpose: persist a user-explicit memory object (manual create flow).

Request (conceptual):
- request_id
- memory:
  - domain
  - title (optional)
  - tags[] (optional)
  - importance (optional)
  - content (text)
  - mood_anchor (optional)
  - rigor_level (optional; normal | high)
- source (optional):
  - thread_id
  - message_id
  - created_at
- consent:
  - explicit_user_consent: true

Response (conceptual):
- request_id
- memory:
  - memory_id
  - created_at
  - updated_at (optional)
  - domain
  - title
  - summary (optional)
  - tags[]
  - rigor_level

### 1.3 GET /v1/memories

Purpose: list explicit memories for review and retrieval.

Query:
- domain (optional)
- tags_any (optional)
- cursor (optional)
- limit (optional)

Response (conceptual):
- request_id
- items[]:
  - memory_id
  - type: memory | journal | action
  - snippet (or summary)
  - domain
  - title
  - tags[]
  - mood_anchor (optional)
  - rigor_level: normal | high
  - fidelity: direct | hazy (optional)
  - transition_to_hazy_at (optional)
  - created_at
  - updated_at (optional)
- next_cursor (optional)

### 1.4 PATCH /v1/memories/{memory_id}

Purpose: edit a memory artifact (user-initiated).

Request (conceptual):
- request_id
- patch:
  - snippet (optional)
  - tags[] (optional)
  - mood_anchor (optional)
- consent:
  - explicit_user_consent: true

Response (conceptual):
- request_id
- memory:
  - memory_id
  - updated_at

### 1.5 DELETE /v1/memories/{memory_id}

Purpose: forget a memory artifact.

Query:
- confirm=true (required when rigor_level=high)

Response:
- 204 No Content (idempotent)

### 1.6 POST /v1/memories/batch_delete

Purpose: delete multiple memories matching a filter (high-friction action).

Request (conceptual):
- request_id
- filter:
  - thread_id (optional)
  - domain (optional)
  - tags_any (optional)
  - created_before (optional)
- confirm: true

Response (conceptual):
- request_id
- deleted_count

### 1.7 POST /v1/memories/clear_all

Purpose: delete all memories (highest-friction action).

Request (conceptual):
- request_id
- confirm: true
- confirm_phrase: "DELETE ALL"

Response (conceptual):
- request_id
- deleted_count

---

## 2. Distillation Delivery (Muted Transmission)

The distilled result is delivered as an OutputEnvelope packet:
- meta.display_hint = "ghost_card"
- meta.ghost_kind = "memory_artifact" | "journal_moment" | "action_proposal"
- notification_policy = "muted"

Compatibility: if meta.ghost_type is present, map it to ghost_kind for routing.

---

## 3. Synaptic Gate (Gate 04)

Purpose: distill a context window into a concise memory candidate.

Rules:
- MAX_CONTEXT_WINDOW_MESSAGES = 15
- MAX_DISTILLED_FACT_CHARS = 150
- If no high-signal fact is found, return fact: null

Canonical null-fact prompt text (client):
"I didn't catch a specific fact. Is there something you want me to remember?"

Data minimization:
- context_window is ephemeral input only and MUST NOT be persisted or logged verbatim.
- Permitted logs: request_id, transmission_id, counts/sizes, hashes.

---

## 4. MemoryArtifact Model (server)

Purpose: persist Ghost Card state and link it to a Transmission.

Fields:
- id (primary key)
- transmission_id (foreign key)
- thread_id
- trigger_message_id
- type: memory | journal | action
- snippet
- mood_anchor (optional)
- rigor_level: normal | high
- tags[]
- transition_to_hazy_at (nullable)
- fidelity: direct | hazy
- created_at
- updated_at

---

## 5. High-Rigor Tagging

Sentinel (Gate 01) assigns rigor_level: high when:
- Physical safety facts (allergies, medical conditions, immediate risk)
- Legal/contractual commitments
- Sentinel severity_signal > 0.8

High-rigor deletes require confirm=true.

---

## 6. Schema Migration (v0 defaults)

Existing memories default to:
- transition_to_hazy_at = NULL
- fidelity = "direct"
- rigor_level = "normal"

Hazing logic is deferred to a later release.

---

## 7. Acceptance Criteria (v0)

- /v1/memories/distill returns 202 ACK with { request_id, transmission_id, status: pending } only.
- Distilled artifact arrives as muted OutputEnvelope with meta.display_hint + meta.ghost_kind.
- request_id is the idempotency primitive across all memory endpoints.
- Synaptic Gate enforces 15-message cap and 150-char distill cap.
- Null fact returns fact: null and triggers the manual entry fallback.
- Batch delete uses POST /v1/memories/batch_delete.
- High-rigor delete requires confirm=true.
