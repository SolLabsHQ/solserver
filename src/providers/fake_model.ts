export async function fakeModelReply(input: {
  userText: string;
  modeLabel: string;
}): Promise<string> {
  return `[${input.modeLabel}] Stub response: I received ${input.userText.length} chars.`;
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
  assistant: string;
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
}): Promise<FakeModelReplyWithMeta> {
  const assistant = await fakeModelReply(input);
  const mementoDraft = proposeMementoFromPrompt(input.userText);
  return { assistant, mementoDraft };
}
