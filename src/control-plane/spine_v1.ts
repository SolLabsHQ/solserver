export function buildSpineV1OutputContract(): string {
  const lines: string[] = [];

  lines.push("Output contract (spine_v1):");
  lines.push("- Return ONLY a JSON object matching OutputEnvelope.");
  lines.push("- Required field: assistant_text (string).");
  lines.push("- assistant_text MUST start with a 'shape' section (3-6 bullets) and include:");
  lines.push("  Arc | Active | Parked | Decisions | Next (as bullet labels).");
  lines.push("- If an EvidencePack is provided, include meta.claims[] with evidence_refs.");
  lines.push("- Each evidence_ref must use evidence_id from the pack; do not invent ids.");
  lines.push("- If no EvidencePack is provided, omit meta.claims.");
  lines.push("- Budgets: max claims=8, max refs/claim=4, max total refs=20.");
  lines.push("- Future: additional structured outputs will live under meta (e.g., capture_suggestion).");
  lines.push("Example OutputEnvelope (with evidence):");
  lines.push(
    '{"assistant_text":"shape:\\n- Arc: ...\\n- Active: ...\\n- Parked: ...\\n- Decisions: ...\\n- Next: ...\\n\\nReceipt: ...\\nRelease: ...\\nNext: ...\\nAssumption: ...","meta":{"claims":[{"claim_id":"cl-1","claim_text":"...","evidence_refs":[{"evidence_id":"ev-001","span_id":"sp-001"}]}]}}'
  );
  lines.push("Example OutputEnvelope (no evidence):");
  lines.push(
    '{"assistant_text":"shape:\\n- Arc: ...\\n- Active: ...\\n- Parked: ...\\n- Decisions: ...\\n- Next: ...\\n\\nReceipt: ...\\nRelease: ...\\nNext: ...\\nAssumption: ..."}'
  );

  return lines.join("\n");
}
