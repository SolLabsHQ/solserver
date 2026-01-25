export function buildSpineV1OutputContract(): string {
  const lines: string[] = [];

  lines.push("Output contract (spine_v1):");
  lines.push("- Return ONLY a JSON object matching OutputEnvelope.");
  lines.push("- Required field: assistant_text (string).");
  lines.push("- meta.shape (optional): provide arc/active/parked/decisions/next when possible.");
  lines.push("- meta.affect_signal (optional): single-message affect for the CURRENT user message only.");
  lines.push("- affect_signal.confidence is a bucket: low | med | high.");
  lines.push("- If the user expresses insight (e.g., \"I just realized...\"), label should be insight (not neutral).");
  lines.push("- Do NOT invent message IDs, spans, or cross-thread state.");
  lines.push("- If you include a shape section in assistant_text, keep it brief; structured meta is the contract.");
  lines.push("- If an EvidencePack is provided, include meta.claims[] with evidence_refs.");
  lines.push("- Each evidence_ref must use evidence_id from the pack; do not invent ids.");
  lines.push("- If no EvidencePack is provided, omit meta.claims.");
  lines.push("- Budgets: max claims=8, max refs/claim=4, max total refs=20.");
  lines.push("Capture Suggestions (optional):");
  lines.push("- If the conversation includes a clear decision, next action, or notable moment, include meta.capture_suggestion.");
  lines.push("- Max one per response. If nothing clearly stands out, omit it.");
  lines.push("- Types: journal_entry (insights), reminder (tasks), calendar_event (time commitments).");
  lines.push("- For journal/reminder: use suggested_date (YYYY-MM-DD) if relevant.");
  lines.push("- For calendar_event: use suggested_start_at (RFC3339 datetime) if a specific time was discussed.");
  lines.push("- Do not include suggestion_id; server fills it.");
  lines.push("- Future: additional structured outputs will live under meta (e.g., capture_suggestion).");
  lines.push("Example OutputEnvelope (with evidence):");
  lines.push(
    '{"assistant_text":"Receipt: ...\\nRelease: ...\\nNext: ...\\nAssumption: ...","meta":{"shape":{"arc":"...","active":["..."],"parked":["..."],"decisions":["..."],"next":["..."]},"affect_signal":{"label":"insight","intensity":0.82,"confidence":"high"},"claims":[{"claim_id":"cl-1","claim_text":"...","evidence_refs":[{"evidence_id":"ev-001","span_id":"sp-001"}]}]}}'
  );
  lines.push("Example OutputEnvelope (no evidence):");
  lines.push(
    '{"assistant_text":"Receipt: ...\\nRelease: ...\\nNext: ...\\nAssumption: ...","meta":{"shape":{"arc":"...","active":["..."],"parked":["..."],"decisions":["..."],"next":["..."]},"affect_signal":{"label":"neutral","intensity":0.2,"confidence":"low"}}}'
  );

  return lines.join("\n");
}
