export function buildSpineV1OutputContract(): string {
  const lines: string[] = [];

  lines.push("Output contract (spine_v1):");
  lines.push("- Return ONLY a JSON object matching OutputEnvelope.");
  lines.push("- Required field: assistant_text (string).");
  lines.push(
    "- meta.shape (optional but preferred): provide arc/active/parked/decisions/next. If uncertain, provide best-effort values rather than omitting."
  );
  lines.push(
    "- meta.affect_signal (required): single-message affect for the CURRENT user message only (label, intensity 0..1, confidence)."
  );
  lines.push(
    "- meta.affect_signal.label must be one of: neutral | insight | decision | gratitude | overwhelm. If none fit, use neutral.  If confidence is low, prefer neutral."
  );
  lines.push("- Do NOT invent message IDs, spans, or cross-thread state.");

  lines.push("Missing facts rule:");
  lines.push(
    "- Don't answer confidently when required facts are missing. If required facts are missing: (1) state what’s missing, (2) give a low-risk default clearly marked as an assumption, (3) ask the smallest question set to proceed."
  );
  lines.push(
    "- Assumption marker: use any clear marker (labels are flexible), e.g., 'Assumption:', 'Working assumption:', 'Default:', or 'If I assume:'."
  );

  lines.push("Assistant text formatting:");
  lines.push(
    "- assistant_text can use natural headings, but should end with a brief closure block (3–6 short lines) placed at the END for grounding."
  );
  lines.push(
    "- Suggested closure semantics: one acknowledgment line, one framing/release line, one next-step line. Labels may vary (e.g., Receipt/Release/Next or Summary/Plan/Next)."
  );
  lines.push(
    "- If you default due to missing facts, include an Assumption line and at least one question line in the closure block."
  );
  lines.push(
    "- Keep any shape/closure section brief; structured meta (meta.shape) is the contract."
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
    '{"assistant_text":"Receipt: ...\\nRelease: ...\\nNext: ...\\nAssumption: ...\\nQuestion: ...?","meta":{"shape":{"arc":"...","active":["..."],"parked":["..."],"decisions":["..."],"next":["..."]},"affect_signal":{"label":"insight","intensity":0.82,"confidence":0.76},"claims":[{"claim_id":"cl-1","claim_text":"...","evidence_refs":[{"evidence_id":"ev-001","span_id":"sp-001"}]}]}}'
  );

  lines.push("Example OutputEnvelope (no evidence):");
  lines.push(
    '{"assistant_text":"Receipt: ...\\nRelease: ...\\nNext: ...\\nAssumption: ...\\nQuestion: ...?","meta":{"shape":{"arc":"...","active":["..."],"parked":["..."],"decisions":["..."],"next":["..."]},"affect_signal":{"label":"neutral","intensity":0.2,"confidence":0.4}}}'
  );

  return lines.join("\n");
}
