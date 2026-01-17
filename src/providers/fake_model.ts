import type { EvidencePack } from "../evidence/evidence_provider";

export async function fakeModelReply(input: {
  userText: string;
  modeLabel: string;
}): Promise<string> {
  const lines = [
    "shape:",
    `- Arc: ${input.modeLabel} session`,
    "- Active: Provide a concise response.",
    "- Parked: None.",
    "- Decisions: None.",
    "- Next: Ask for the next request.",
    "Receipt: Acknowledged.",
    "Release: You are not required to take external actions.",
    "Next: Tell me if you want a draft or steps.",
    "Assumption: No external actions were taken.",
    `Stub response: I received ${input.userText.length} chars.`,
  ];
  return lines.join("\n");
}

// ThreadMemento draft is navigation-only metadata (NOT durable knowledge).
// This is intentionally lightweight so we can validate the control-plane wiring in v0.
export type ThreadMementoDraft = {
  arc: string;
  active: string[];
  parked: string[];
  decisions: string[];
  next: string[];
};

export type FakeModelReplyWithMeta = {
  rawText: string;
  mementoDraft: ThreadMementoDraft | null;
};

function lastUserLine(promptText: string): string {
  // Best-effort extraction for v0: find the last line that looks like a user turn.
  // We intentionally do not parse JSON or rely on stable headers yet.
  const lines = promptText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.toLowerCase().startsWith("user:")) return l.slice(5).trim();
    if (l.toLowerCase().startsWith("message:")) return l.slice(8).trim();
  }

  // Fallback: use the last non-empty line.
  return lines.at(-1) ?? "";
}

function proposeMementoFromPrompt(promptText: string): ThreadMementoDraft | null {
  // v0: keep the draft small, safe, and deterministic.
  // This is a "model-authored" navigation hint, not durable knowledge.
  const user = lastUserLine(promptText);
  const userLower = user.toLowerCase();

  const arc =
    userLower.includes("solserver") || userLower.includes("control plane")
      ? "SolServer v0 build"
      : "General chat";

  const active = user ? [user] : [];

  return {
    arc,
    active,
    parked: [],
    decisions: [],
    next: [],
  };
}

/**
 * Fake model reply with lightweight metadata.
 *
 * Option 1 (v0.1/v0.2): let the model propose a ThreadMemento draft.
 * SolServer may store it temporarily as a navigation artifact.
 */
export async function fakeModelReplyWithMeta(input: {
  userText: string;
  modeLabel: string;
  evidencePack?: EvidencePack | null;
}): Promise<FakeModelReplyWithMeta> {
  const assistant = await fakeModelReply(input);
  const claims = input.evidencePack?.items?.length
    ? [
        {
          claim_id: "claim-001",
          claim_text: "Claim derived from the provided evidence pack.",
          evidence_refs: [
            {
              evidence_id: input.evidencePack.items[0].evidenceId,
              ...(input.evidencePack.items[0].spans?.[0]?.spanId
                ? { span_id: input.evidencePack.items[0].spans?.[0]?.spanId }
                : {}),
            },
          ],
        },
      ]
    : undefined;

  const rawText = JSON.stringify({
    assistant_text: assistant,
    ...(claims ? { meta: { claims } } : {}),
  });
  const mementoDraft = proposeMementoFromPrompt(input.userText);
  return { rawText, mementoDraft };
}
