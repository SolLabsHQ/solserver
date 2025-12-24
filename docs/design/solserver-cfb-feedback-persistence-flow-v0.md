# SolServer v0 — CFB-Aware Reasoning + Feedback + Persistence Loop (Implementation Flow)

**Audience:** SolServer/SolMobile devs  
**Goal:** Let the model use its brain **with guidance**, while we *instrument* what it used/ignored, learn from user feedback, and promote durable knowledge into **CFBs + Umbra** for future injection.

This is **not** “CFB-or-nothing.”  
This is “CFBs are anchors; the model can infer beyond them, but must label it.”

---

## 1) Concepts

### 1.1 CFB (Context Fact Block)
A reusable, inject-able block of information we consider authoritative for a domain/topic (within its scope + staleness policy).

### 1.2 UmbraEntry
Richer memory artifact (narrative + lesson + tags) that can later be **rolled up** into one or more CFBs.

### 1.3 EvidencePack vs CFBs
- **CFBs** are internal “facts we own” (from ADRs, decisions, user-approved truths).
- **EvidencePack** is the request-specific bundle we inject for a run.  
In v0, EvidencePack is primarily “selected CFBs + any retrieval snippets + thread pins.”

---

## 2) End-to-end pipeline

### 2.1 High-level sequence
1) **Packet received** (thread + window + requestId)
2) **Routing Ladder** (Step 0/1 deterministic; Step 2 selector only if needed)
3) **CFB Lookup** (local-first FTS5; return K CFBs + why matched)
4) **Prompt assembly** (Mounted Law + Runtime Deltas + Windowed Messages + Injected CFBs)
5) **Main model call** returns structured `OutputEnvelope`
6) **Gates + telemetry** record what happened (including used/ignored CFBs)
7) **User feedback** (thumbs/tags/corrections)
8) **Persistence flow** (model proposes `PersistenceCandidate`; user approves save)
9) **Offline critic loop** distills logs into policy/CFB updates
10) **Promotion** (Jam approves → new CFB / updated tags / policy bundle version)

---

## 3) Deterministic Routing Ladder (who decides what)

### Step 0 — Hard overrides (0 model calls)
- Explicit mode requests (“System-mode”, etc.)
- Hard domain triggers (finance/legal/architecture/SolOS governance)

### Step 1 — Deterministic classifier (0 model calls)
- Produces `ModeDecisionDraft` with `confidence`
- Produces `domainHints[]` (e.g., `architecture`, `cost`, `family`, `writing`, `needs_retrieval`)

### Step 2 — Selector model (≤1 cheap call, only if Step 1 confidence < threshold)
- Returns `ModeDecision` JSON (schema-validated)
- SolServer clamps/calibrates confidence; applies overrides

### Step 3 — Main model (≤1 call per attempt; regen within caps)
- Returns `OutputEnvelope` JSON (schema-validated)

---

## 4) CFB Lookup: where we “look up the right CFB”

### 4.1 Source of truth (local-first)
**SolMobile** hosts the canonical offline index:
- SQLite + FTS5 table for CFBs
- Optional sync to SolServer (for multi-device or remote calls), but local is canonical

SolServer can also host a mirrored index for server-only operations, but do not require it for correctness.

### 4.2 CFB schema (storage)
```json
{
  "cfb_id": "CFB-0187",
  "domain": "solserver",
  "title": "Routing ladder v0",
  "tags": ["control-plane","routing","selector","budgets"],
  "entities": ["SolServer","SolMobile","Fly.io","Turso"],
  "trust_tier": "authoritative",
  "staleness_policy": { "ttl_days": 180, "review_on_use": true },
  "text": "…the block…",
  "source_refs": ["ADR-011","ADR-017","solserver-v0-stack-budget.md"],
  "created_ts": "…",
  "updated_ts": "…",
  "last_accessed_ts": "…"
}
```

### 4.3 CFBQueryPack (what retrieval runs on)
Built by SolServer from the packet + router hints:
```json
{
  "query_text": "user msg + short thread recap",
  "domain_hint": "solserver",
  "modeLabel": "System",
  "entities": ["SolServer","control plane","gates"],
  "tags": ["routing","gates","CFB"],
  "k": 6,
  "boost": { "domain": 2.0, "entity": 1.5, "pinned": 3.0, "recency": 1.2 }
}
```

### 4.4 Retrieval algorithm (v0)
1) FTS5 search over: `text`, `title`, `tags`, `entities`
2) Boost by: domain match, entity match, pinned CFBs, recency/last_accessed
3) Return: top K + score + “why matched” breakdown

**Log candidates** (not just selected), so we can later see what was available but not used.

---

## 5) Prompt assembly: how the model “KNOWS” about CFBs

### 5.1 Injection format (stable IDs)
Inject selected CFBs as a numbered list with IDs:
- `CFB-0187` title + trust tier + staleness note + content

### 5.2 Instruction posture (anchor, not cage)
System instruction (condensed):
- “CFBs are authoritative within scope.”
- “You may infer beyond them, but label as **ASSUMPTION**.”
- “If a factual claim is not supported by CFBs/retrieval, label **UNKNOWN**.”
- “Return OutputEnvelope JSON only.”

---

## 6) OutputEnvelope: model self-report (used/ignored CFBs)

### 6.1 OutputEnvelope schema (returned by main model)
```json
{
  "assistant_text": "…user-visible…",
  "meta": {
    "modeLabel": "System",
    "domainHints": ["solserver","control-plane"],
    "used_cfb_ids": ["CFB-0187","CFB-0201"],
    "ignored_cfb_ids": ["CFB-0122"],
    "assumptions": [
      { "id":"A1", "text":"Assuming Fly Machines are used for workers." }
    ],
    "unknowns": [
      { "id":"U1", "text":"Exact monthly spend without usage metrics." }
    ],
    "claim_map": [
      { "claim_id":"c1", "span": {"sentence": 2}, "text":"Routing ladder has Step 0–3.", "support": {"cfb_ids":["CFB-0187"]} },
      { "claim_id":"c2", "span": {"sentence": 4}, "text":"Estimated cost is $X.", "support": {"unknown_id":"U1"} }
    ],
    "checkpointSuggested": false
  }
}
```

**Note:** `ignored_cfb_ids` is a tuning signal, not a correctness requirement.

---

## 7) Gates + telemetry: what we record and what we can enforce

### 7.1 Gates are server functions that emit GateResult
A gate “enforces” by:
- failing + triggering regen with a tight delta
- or degrading safely after retry caps

### 7.2 Required gates for this flow (v0)
**G1 output_schema (cheap):** OutputEnvelope must parse  
**G2 mode_echo_match (cheap):** meta.modeLabel matches ModeDecision  
**G3 evidence_binding (cheap-ish):** in high-rigor modes, every claim must be supported by:
- `cfb_ids` OR retrieval ids OR `unknown_id` (explicit UNKNOWN)
**G4 budget_enforcer (cheap):** token/tool/retry/time caps  
**G5 telemetry_writer (cheap):** always records used/ignored CFB IDs + unknowns

### 7.3 What we *cannot* “prove” on server
We cannot prove “truth” beyond provided evidence.  
We can prove:
- the model **declared** support sources (CFB IDs)
- those IDs were actually present
- unknowns/assumptions are explicitly labeled when unsupported

---

## 8) User feedback loop (Jam + others)

### 8.1 HumanFeedback event (client-side)
Collected in SolMobile UI (local-first):
- thumbs up/down
- tags: `missed_fact`, `confusing`, `too_long`, `hallucination`, `tone`, `needs_cfb`, `great`
- optional correction text

### 8.2 Why we need it
We correlate:
- which CFBs were injected
- which were used/ignored
- which assumptions/unknowns were produced
- whether user liked/corrected it

This is the data that tells us where to add/update CFBs and where routing/gates need tightening.

---

## 9) Persistence flow: “user asked to persist” → model proposes → user approves

### 9.1 PersistenceCandidate (model output when asked to persist)
When the user says “persist this,” the assistant returns:
- normal response text
- plus structured `PersistenceCandidate[]` in meta

```json
{
  "candidates": [
    {
      "domain":"solserver",
      "title":"CFB lookup pipeline v0",
      "summary":"Local-first CFB store (SQLite+FTS5) ...",
      "tags":["CFB","retrieval","offline-first","telemetry"],
      "entities":["SolServer","SolMobile","Umbra"],
      "confidence":0.8,
      "rollup_target":"CFB",
      "source_refs":["thread:t1#msg:103"]
    }
  ]
}
```

### 9.2 Approval
- SolMobile surfaces a “Save” affordance
- On Save:
  - write UmbraEntry
  - optionally generate/update a CFB (rollup) **only on explicit approval**

---

## 10) Offline critic loop: “turn our work inside out” (multi-model)

### 10.1 What gets exported
Export trace bundles (JSONL), each containing:
- ModeDecision + confidence
- CFB candidates + selected CFBs
- OutputEnvelope (including used/ignored CFBs, claim_map, assumptions, unknowns)
- GateResults
- HumanFeedback (if available)

### 10.2 What we ask critics to do
Run multiple models (ChatGPT/Gemini/Claude/Grok) as critics:
- identify unsupported claims
- identify ignored but relevant CFBs
- propose:
  - new CFB candidates
  - tag/entity improvements
  - gate tweaks (tighten/relax conditions)
  - selector rubric tweaks

### 10.3 Distillation + promotion
- Models propose; **Jam approves**
- Approved changes become:
  - new/updated CFBs
  - updated retrieval boosts/tags
  - policy bundle version bump
  - ADR entry if governance-level

---

## 11) Sync semantic critic (rare, weighted)

We optionally run a synchronous critic gate when:
- confidence is very low, AND
- domain is high-rigor, OR
- user is about to take consequential action

Critic compares:
- EvidencePack + CFBs vs claim_map
Outputs CriticFindings; server may regen or respond with explicit UNKNOWN.

---

## 12) Implementation checklist (SolServer dev-ready)

### 12.1 Data model
- `cfb` (id, domain, tags, entities, trust, ttl, text, refs, last_accessed)
- `cfb_fts` (FTS5 virtual table)
- `trace_bundle` (path/hash)
- `gate_results`
- `human_feedback`
- `critic_findings`
- `umbra_entries`

### 12.2 Services
- `RouterService` (Step 0–2)
- `CfbRetrievalService` (FTS5 query + boosts)
- `PromptAssembler` (Mounted Law + CFB injection)
- `ModelClient` (selector + main with structured outputs)
- `GateRunner` (gates + regen/degrade policy)
- `TelemetryWriter` (events)
- `CriticPipeline` (export + run external critics + ingest findings)
- `UmbraService` (save approved candidates + rollups)

### 12.3 Acceptance tests (minimum)
1) If OutputEnvelope JSON invalid → regen until valid or degrade  
2) In high-rigor mode: uncited factual claim → fail gate → regen with UNKNOWN/citations  
3) CFB retrieval returns deterministic top K; candidates logged  
4) used/ignored CFB IDs recorded per run  
5) “persist this” produces PersistenceCandidate; Save writes UmbraEntry + optional CFB rollup

---

## 13) Ida summary (implementation intent)
We trust the model’s intelligence — **and** we build a system that learns:

- CFBs get injected so the model is aware of what we already know.
- The model self-reports what it used/ignored.
- Users tell us what worked.
- Umbra turns repeated signals into durable CFBs.
- Retrieval gets better. Gates get tighter where it matters.

That’s the loop.
