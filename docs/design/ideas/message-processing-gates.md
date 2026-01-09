flowchart TD
  A[User Turn (raw)\n- text\n- attachments\n- metadata] --> B[0) Normalize\n- lowercase\n- collapse whitespace\n- keep raw copy]
  B --> C[1) Modality Gate (deterministic)\n- has_text?\n- has_image?\n- has_audio?]
  C --> D[2) Intent Gate (Lane A: rules + scoring)\n- phrase/regex/heuristics\n=> label + confidence\n=> signals[]]
  D --> E[3) Risk Gate (rules-first)\n- domain/topic cues\n- escalation rules\n=> tier 0..3\n=> signals[]]
  E --> F[4) Enrichment Lattice (table)\nInputs: intent + risk + confidence + budgets\nOutputs:\n- enrichment_mode\n- allowed_types[]\n- posture\n- persona_hint?]
  F --> G[5) Compose Model Request (single)\n- user text + attachments\n- constraints/permissions\n- budgets\n(no re-prompts)]
  G --> H[6) Model Generation (LLM)\n- emits response\n- may emit optional enrichment specs\n  e.g., ref-image queries (descriptive)]
  H --> I[7) Renderer / Client UI\n- render text\n- if allowed & present:\n  fetch/display ref images\n  fetch/display citations\n(model doesn't validate)]
  I --> J[8) Trace + Telemetry\n- gate results + lattice\n- decision_id\n- user actions (regen/copy/scroll)]

  sequenceDiagram
  participant U as User
  participant M as SolM (device)
  participant S as SolServer (optional)
  participant I as Intent/Risk Classifiers
  participant L as Enrichment Lattice
  participant LLM as Model (LLM)
  participant R as Renderer/UI

  U->>M: Send text + attachments
  M->>M: Normalize
  M->>M: Modality Gate (deterministic)

  M->>I: Intent Gate (Lane A rules+scoring)
  I-->>M: intent label + confidence + signals

  M->>I: Risk Gate (rules-first)
  I-->>M: risk tier + signals

  M->>L: Lattice lookup (intent+risk+confidence+budgets)
  L-->>M: permissions + posture + allowed_types

  alt Model called on device
    M->>LLM: Single request (with permissions/budgets)
    LLM-->>M: Response (+ optional enrichment specs)
  else Model called via server
    M->>S: Request + gate results + budgets
    S->>LLM: Single request (with permissions/budgets)
    LLM-->>S: Response (+ optional enrichment specs)
    S-->>M: Response envelope
  end

  M->>R: Render response
  R->>R: Fetch/display reference images/citations if allowed
  R-->>U: Display answer + optional enrichment

  M->>M: Log trace + telemetry