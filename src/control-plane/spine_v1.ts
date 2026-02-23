export function buildSpineV1OutputContract(): string {
  const lines: string[] = [];

  lines.push("Output contract (spine_v1):");
  lines.push("- Return ONLY a JSON object matching OutputEnvelope.");
  lines.push("- Required field: assistant_text (string).");
  lines.push(
    "- meta.shape (required for context carry): provide arc/active/parked/decisions/next. If uncertain, provide best-effort values rather than omitting."
  );
  lines.push(
    "- meta.affect_signal (required): single-message affect for the CURRENT user message only (label, intensity 0..1, confidence)."
  );
  lines.push(
    "- meta.affect_signal.label must be one of: neutral | insight | decision | gratitude | overwhelm. If none fit, use neutral.  If confidence is low, prefer neutral."
  );
  lines.push(
    "- When the user asks to decide/lock, ensure meta.shape.decisions and meta.shape.next are non-empty best-effort."
  );
  lines.push("- Do NOT invent message IDs, spans, or cross-thread state.");

  lines.push("Missing facts rule:");
  lines.push(
    "- Only when required facts are missing: (1) state what’s missing, (2) give a low-risk provisional approach clearly marked as provisional, (3) ask the smallest question set to proceed."
  );
  lines.push(
    "- If facts are sufficient, do NOT add assumption/provisional scaffolding."
  );

  lines.push("Assistant text formatting:");
  lines.push(
    "- assistant_text should be clean, user-facing prose."
  );
  lines.push(
    "- Avoid system/process scaffolding (Outline/Receipt/Release/Next/Assumption) unless explicitly requested or clearly needed."
  );
  lines.push(
    "- If you choose a labeled closure block, keep it brief and place it at the end."
  );
  lines.push(
    "- Keep any headings brief; structured meta (meta.shape) is the contract."
  );

  lines.push("Evidence (when provided):");
  lines.push(
    "- If an EvidencePack is provided, include meta.claims[] with evidence_refs. If no EvidencePack is provided, omit meta.claims."
  );
  lines.push(
    "- Each evidence_ref must use evidence_id from the pack; do not invent ids."
  );
  lines.push("- Budgets: max claims=8, max refs/claim=4, max total refs=20.");

  lines.push("Capture Suggestions (optional):");
  lines.push(
    "- If the conversation includes a clear decision, next action, or notable moment, include meta.capture_suggestion."
  );
  lines.push("- Max one per response. If nothing clearly stands out, omit it.");
  lines.push(
    "- Types: journal_entry (insights), reminder (tasks), calendar_event (time commitments)."
  );
  lines.push("- For journal/reminder: use suggested_date (YYYY-MM-DD) if relevant.");
  lines.push(
    "- For calendar_event: use suggested_start_at (RFC3339 datetime) if a specific time was discussed."
  );
  lines.push("- Do not include suggestion_id; server fills it.");
  lines.push(
    "- Future: additional structured outputs will live under meta (e.g., capture_suggestion)."
  );

  lines.push("Example OutputEnvelope (with evidence):");
  lines.push(
    '{"assistant_text":"Here’s a concise response tailored to the user’s request.","meta":{"shape":{"arc":"...","active":["..."],"parked":["..."],"decisions":["..."],"next":["..."]},"affect_signal":{"label":"insight","intensity":0.82,"confidence":0.76},"claims":[{"claim_id":"cl-1","claim_text":"...","evidence_refs":[{"evidence_id":"ev-001","span_id":"sp-001"}]}]}}'
  );

  lines.push("Example OutputEnvelope (no evidence):");
  lines.push(
    '{"assistant_text":"Here’s a concise response tailored to the user’s request.","meta":{"shape":{"arc":"...","active":["..."],"parked":["..."],"decisions":["..."],"next":["..."]},"affect_signal":{"label":"neutral","intensity":0.2,"confidence":0.4}}}'
  );

  return lines.join("\n");
}
