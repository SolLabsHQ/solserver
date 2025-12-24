# SolServer v0 Working Doc — CFB-Only Knowledge Model + OutputMeta Promotion Loop + Schemas

> **Design bias:** avoid new “objects” that drift.  
> **We keep ONE knowledge object:** `CFB` with `kind` + `confidence` + optional `stats`.  
> “UmbraEntry” is just a **CFB(kind='umbra', confidence≈low)** and/or a **CFBStats decoration** for an existing CFB.

---

## 1) Terminology (to avoid UI collision)

- **UI Anchor** (existing SolM meaning): a user-facing pinned thing / reminder / re-entry point.  
  **Do not reuse the word “anchor”** in server schema.

- **CFB**: canonical knowledge item (fact block / memory block).  
- **CFBStats**: roll-up counters + outcomes that *decorate* a CFB (derived, mutable).

---

## 2) Single object model: CFB (+ decoration)

### 2.1 CFB (canonical)
- Purpose: what we inject into prompts.
- Stable `cfb_id` is the primary key.

```json
{
  "cfb_id": "CFB-0187",
  "domain": "solserver",
  "kind": "authoritative | heuristic | umbra",
  "confidence": 0.0,
  "title": "CFB lookup pipeline v0",
  "summary": "1–3 sentence gist for manifest injection",
  "text": "full block (optional injection depending on policy)",
  "tags": ["CFB","retrieval","offline-first"],
  "entities": ["SolServer","SolMobile","Umbra"],
  "trust_tier": "user_approved | repo_adr | derived",
  "staleness": { "ttl_days": 180, "review_on_use": true },
  "source_refs": ["thread:t1#msg:103", "file:ADR-018-search-v0.1.md"],
  "created_ts": "2025-12-23T22:15:00Z",
  "updated_ts": "2025-12-23T22:15:00Z",
  "last_accessed_ts": "2025-12-23T22:15:00Z"
}
```

**Notes**
- `kind='umbra'` is “low confidence / narrative / early.” Same table, fewer required fields (summary required; text optional).
- `confidence` expresses “how solid is this CFB,” *not* model confidence.

### 2.2 CFBStats (decoration, derived)
- Purpose: improve retrieval and guide updates/merges.
- Stored separately (or materialized view) keyed by `cfb_id`.

```json
{
  "cfb_id": "CFB-0187",
  "usage_30d": 14,
  "used_by_model_30d": 11,
  "ignored_by_model_30d": 6,
  "positive_feedback_30d": 7,
  "negative_feedback_30d": 2,
  "correction_events_30d": 1,
  "unknown_rate_when_injected": 0.12,
  "last_feedback_ts": "2025-12-23T23:10:00Z",
  "hotness": 0.81
}
```

---

## 3) The missing loop you called out: OutputEnvelope.meta → client UI → server formalizes

### 3.1 Response transport (single assistant message)
We do **not** send “two assistant messages.” We return **one response** that contains:
- user-visible `assistant_text`
- optionally a **compact preview** of proposals for UI
- the server stores the full meta internally for audit/replay

### 3.2 Server response shape (API)
**POST /chat/respond** returns:

```json
{
  "packet_id": "P-001",
  "transmission_id": "T-001",
  "attempt_id": "A-003",
  "response_id": "R-009",
  "assistant_text": "…",
  "ui_hints": {
    "has_proposals": true,
    "proposal_previews": [
      {
        "proposal_id": "UP-771",
        "op": "update",
        "target_cfb_id": "CFB-0187",
        "title": "CFB lookup pipeline v0",
        "delta_summary": "Add: used/ignored telemetry + resolve algorithm",
        "confidence": 0.74
      }
    ]
  }
}
```

**Important:** `proposal_previews` are derived by the server from stored meta, not trusted directly from the model.

### 3.3 Client promotion flow
When user taps “Review / Save / Update” in UI:
- **GET /umbra/proposals?response_id=R-009** → full proposal list + resolve suggestions
- User picks action → **POST /umbra/promote**

Promotion request:

```json
{
  "proposal_id": "UP-771",
  "response_id": "R-009",
  "action": "approve_update | approve_create | reject | edit_then_approve",
  "editorial_overrides": {
    "tags_add": ["telemetry"],
    "summary_edit": "…optional…"
  }
}
```

Server then:
- runs Resolve (create vs update vs merge)
- writes/updates CFB
- increments stats
- records PromotionEvent (linked to packet/transmission)

### 3.4 Traceability via Packet/Transmission
Every artifact is keyed back to the run:

- Packet → Transmission → DeliveryAttempt → Response
- OutputEnvelope meta stored as `response_meta` row keyed by `response_id`

---

## 4) OutputEnvelope meta schema (the bits we care about)

### 4.1 OutputEnvelope returned by the model (stored, not fully exposed)
```json
{
  "assistant_text": "…",
  "meta": {
    "modeLabel": "System",
    "domainHints": ["solserver","control-plane"],
    "used_cfb_ids": ["CFB-0187"],
    "ignored_cfb_ids": ["CFB-0201"],
    "assumptions": [
      { "id": "A1", "text": "Assuming workers run as Fly Machines.", "severity": "low" }
    ],
    "unknowns": [
      { "id": "U1", "text": "Exact monthly cost without usage metrics.", "needs_user_input": true }
    ],
    "missing_cfb_queries": [
      "dedupe policy for CFB updates"
    ],
    "cfb_suggestions": [
      {
        "op": "update",
        "target_cfb_id": "CFB-0187",
        "title": "CFB lookup pipeline v0",
        "delta_summary": "Add promotion loop details + resolve thresholds.",
        "tags": ["CFB","Umbra","telemetry"],
        "entities": ["SolServer","SolMobile"],
        "confidence": 0.74,
        "rationale": "Matches existing by tags/entities; content extends it."
      }
    ],
    "claim_map": [
      {
        "claim_id": "c1",
        "span": { "sentence": 2 },
        "text": "CFBs are injected via manifest-only by default.",
        "support": { "cfb_ids": ["CFB-0187"] }
      },
      {
        "claim_id": "c2",
        "span": { "sentence": 4 },
        "text": "Exact cost is $X.",
        "support": { "unknown_id": "U1" }
      }
    ]
  }
}
```

**Enforcement is mechanical:** the server can require that every claim has either `cfb_ids` or `unknown_id` in strict domains.

---

## 5) Umbra “coverage improvement” (fully traceable)

Umbra improves coverage by updating:
- CFB content/metadata (create/update/merge)
- Retrieval boosts (domain/tag/entity weighting)
- Routing rules (domain mismatch tuning)

### 5.1 Events/tables Umbra uses (minimum viable)
- `cfb` (canonical)
- `cfb_stats` (decoration)
- `cfb_usage_event`
- `human_feedback`
- `response_meta` (stored OutputEnvelope.meta)
- `umbra_proposal`
- `umbra_resolve_decision`
- `promotion_event`

### 5.2 What repetitions Umbra tracks
Umbra increments counters on these keys:

1) **CFB usage**
- key: `(router_domain, cfb_id)` counts used/ignored

2) **Coverage gaps**
- key: `(router_domain, normalized_missing_cfb_query)`
- key: `(router_domain, unknown.type)` (derived classifier)
- key: `(router_domain, feedback_tag)`

3) **Proposal fingerprint**
- key: `sha256(normalize(title + tags + first_300(delta_summary)))`

These become Breakpoints (promotion triggers).

---

## 6) Umbra Resolve algorithm (create vs update vs merge)

**Inputs:** `CFBProposal` + existing CFB index (FTS5)  
**Output:** `UmbraResolveDecision` with traceable scores.

### 6.1 Candidate retrieval (deterministic)
FTS query built from:
- proposal.title
- proposal.tags + entities
- key phrases from delta_summary

### 6.2 Composite score (v0)
```
score = 0.50 * bm25_norm
      + 0.25 * tag_overlap
      + 0.20 * entity_overlap
      + 0.05 * title_similarity
```

### 6.3 4B thresholds
- **Bounds**
  - low: < 0.55
  - mid: 0.55–0.75
  - high: > 0.75
- **Buffer**
  - hysteresis +0.05 before flipping create↔update
- **Breakpoints**
  - top_score > 0.75 → UPDATE
  - 0.55–0.75 → REVIEW (surface to user/Jam)
  - < 0.55 → CREATE
  - top2 > 0.75 and |s1-s2| < 0.06 → MERGE suggestion
- **Beat**
  - daily for heavy dev; weekly when stable

Resolve decision record:

```json
{
  "proposal_id": "UP-771",
  "decision": "update",
  "target_cfb_id": "CFB-0187",
  "scores": [
    { "cfb_id": "CFB-0187", "score": 0.82 },
    { "cfb_id": "CFB-0440", "score": 0.61 }
  ],
  "reason_codes": ["HIGH_TAG_ENTITY_MATCH","BM25_TOP"]
}
```

---

## 7) Schemas (TypeScript-ish) — dev copy/paste start

### 7.1 Packet / Transmission / Attempt / Response
```ts
type Packet = {
  packet_id: string
  thread_id: string
  message_window_ids: string[]
  request_id: string
  created_ts: string
}

type Transmission = {
  transmission_id: string
  packet_id: string
  status: "queued"|"running"|"done"|"failed"
  modeLabel: string
  router_domain: string
  created_ts: string
}

type DeliveryAttempt = {
  attempt_id: string
  transmission_id: string
  step: "selector"|"main"
  n: number
  model: string
  tokens_in?: number
  tokens_out?: number
  latency_ms?: number
  created_ts: string
}

type Response = {
  response_id: string
  transmission_id: string
  attempt_id: string
  assistant_text: string
  created_ts: string
}
```

### 7.2 Stored response meta (OutputEnvelope.meta)
```ts
type ResponseMeta = {
  response_id: string
  modeLabel: string
  domainHints: string[]
  used_cfb_ids: string[]
  ignored_cfb_ids: string[]
  assumptions: { id: string; text: string; severity?: "low"|"med"|"high" }[]
  unknowns: { id: string; text: string; needs_user_input?: boolean }[]
  missing_cfb_queries: string[]
  cfb_suggestions: CfbSuggestion[]
  claim_map?: ClaimMapEntry[]
}

type CfbSuggestion = {
  op: "create"|"update"|"merge"
  target_cfb_id?: string
  title: string
  delta_summary: string
  tags: string[]
  entities: string[]
  confidence: number
  rationale?: string
}

type ClaimMapEntry = {
  claim_id: string
  span: { sentence?: number; start_char?: number; end_char?: number }
  text: string
  support: { cfb_ids?: string[]; unknown_id?: string }
}
```

### 7.3 Umbra Proposal + Resolve + Promotion
```ts
type UmbraProposal = {
  proposal_id: string
  response_id: string
  op: "create"|"update"|"merge"
  target_cfb_id?: string
  proposed_cfb: Partial<CFB>
  delta_summary: string
  confidence: number
  fingerprint: string
  created_ts: string
}

type UmbraResolveDecision = {
  proposal_id: string
  decision: "create"|"update"|"merge"|"review"
  target_cfb_id?: string
  scores: { cfb_id: string; score: number }[]
  reason_codes: string[]
  created_ts: string
}

type PromotionEvent = {
  promotion_id: string
  proposal_id: string
  response_id: string
  action: "approve_create"|"approve_update"|"reject"|"edit_then_approve"
  final_cfb_id?: string
  editor?: "user"|"jam"
  created_ts: string
}
```

---

## 8) Dev note: UI “Anchor” integration stays separate
If we later want a UI Anchor to point at knowledge, it should reference `cfb_id` (or `thread_id`), but UI Anchor remains its own UI construct.

---

## 9) Quick “what to implement first”
1) `ResponseMeta` storage + return `proposal_previews` in API response  
2) `UmbraProposal` generation from ResponseMeta.cfb_suggestions  
3) Resolve algorithm (FTS + scoring)  
4) Promote endpoint (create/update CFB + stats)  
5) Retrieval boost adjustments using CFBStats

