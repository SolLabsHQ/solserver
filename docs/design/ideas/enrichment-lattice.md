# Enrichment Lattice v0.1 (SolM + SolServer)

**Purpose:** Decide *how much extra* to add (images, citations, tools, checklists, steps) in a way that is:
- predictable (no surprise agent loops)
- cheap (pre-gates are fast)
- safe (risk-tier drives posture + permissions)
- evolvable (versioned table + telemetry)

**Core principle:** The system decides what is **allowed**. The model decides what is **useful**. The renderer decides how it **appears**.

---

## Inputs

### Required
- `modality`: `{ has_text, has_image, has_audio }`
- `intent`: one of: `inspect | teach | decide | create | reflect | other`
- `intent_confidence`: `0.0..1.0`
- `risk_tier`: `0..3`
  - 0 = harmless
  - 1 = low (food handling, basic home tasks)
  - 2 = medium (financial, legal-ish, medical-ish guidance)
  - 3 = high (self-harm, illegal wrongdoing, medical diagnosis, etc.)
- `budgets`: token + tool-call limits (4B-ready)

### Optional (later)
- `user_state`: `rushed | normal | deep`
- `session_context`: “how long / how many regens / user frustration”

---

## Outputs

- `enrichment_mode`: `none | light | full`
- `allowed_types`: subset of:
  - `reference_images` (illustrative)
  - `citations` (requires browsing permission)
  - `checklist`
  - `step_by_step`
  - `timing_table`
  - `tool_calls_read`
  - `tool_calls_write` (requires explicit confirmation breakpoint)
- `posture`: `direct | conditional | boundary_pause | containment`
- `persona_hint` (optional): e.g., `Ida | Sole | Sherlock`

---

## Decision rules (v0.1)

### Confidence breakpoint
- If `intent_confidence < 0.55` → degrade to `enrichment_mode = none|light`, posture becomes more `conditional`, and avoid optional enrichments.

### Risk breakpoints
- `risk_tier = 0..1` → direct allowed; enrichment permitted where helpful.
- `risk_tier = 2` → require assumptions, present options, avoid “single answer certainty.” Prefer citations if browsing enabled.
- `risk_tier = 3` → boundary_pause / containment; do not provide operational guidance; tools restricted.

### Modality breakpoints
- If `has_image` and `intent = inspect` and `risk_tier <= 1` → allow `reference_images` (illustrative), but **never** treat them as evidence. Prefer explaining what you see in the *user-provided* image.

---

## Lattice table (starter)

> This is intentionally small and sane. Expand only when data proves it’s worth it.

| Intent \ Risk | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|---|
| **inspect** | **Light**: checklist, quick checks | **Light**: checklist + (optional) reference_images | **Full-bounded**: assumptions + options; citations if enabled | **Containment**: boundary_pause; no operational detail |
| **teach** | **Light→Full**: step_by_step | **Full**: step_by_step + timing_table | **Full-bounded**: assumptions + options; cite sources if browsing | **Boundary_pause** |
| **decide** | **Light**: options + quick pros/cons | **Full**: options + recommendation | **Full-bounded**: assumptions + options; avoid certainty; citations | **Boundary_pause** |
| **create** | **Full**: variants welcome | **Full** | **Full-bounded** (if sensitive topic) | **Boundary_pause** |
| **reflect** | **Light**: validate + 1 next step | **Light** | **Containment** if intensity high; avoid insight-bombs | **Containment** |
| **other** | **None/Light** | **None/Light** | **Light** | **Boundary_pause** |

**Default allowed_types by mode**
- `none`: no extras, concise answer
- `light`: checklist OR 1 small table OR 1 optional enrichment type
- `full`: step-by-step + tables + tools (read) if useful; citations if browsing

---

## Example policies

### Inspect + Tier 1 (food spoilage photo)
- `mode: light`
- `allowed_types: checklist, reference_images`
- `posture: direct`
- Notes: explain what’s visible; add “sniff test” & “slime” checks; references are illustrative only.

### Decide + Tier 2 (money/legal/medical-ish)
- `mode: full-bounded`
- `allowed_types: checklist, citations (if browsing), tool_calls_read`
- `posture: conditional`
- Notes: state assumptions; give options; recommend with bounds, not certainty.

---

## 4B hooks (optional, but designed-in)

- **Bounds:** confidence envelope on intent + recommendation strength
- **Buffer:** token/tool-call budget reserve
- **Breakpoints:** thresholds (risk tier, confidence) that force posture changes
- **Beat:** refresh cadence for classifier + lattice version (e.g., weekly model eval)

---

## Telemetry (minimal, local-first)

Store in trace (no content required):
- `{intent, intent_confidence, risk_tier, enrichment_mode, allowed_types, posture, lattice_version}`
- user actions: `regen_tap`, `followup_latency_ms`, `copy_event`, `scroll_delta` (SolM telemetry idea)

---

## Decision flow sketch (Mermaid)

```mermaid
flowchart TD
  A[User input: text + attachments] --> B[Modality Gate (deterministic)]
  B --> C[Intent Gate (cheap classifier)]
  C --> D[Risk Gate (rules-first)]
  D --> E[Enrichment Lattice (permissions + posture)]
  E --> F[Model generation (chooses what is useful within permissions)]
  F --> G[Renderer (fetches reference images/citations if instructed)]
  G --> H[User sees response + optional enrichment]
  H --> I[Telemetry/Trace logged]
```

