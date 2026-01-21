export type ContextMessage = {
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

const MAX_FACT_CHARS = 150;
const MIN_SIGNAL_CHARS = 12;
const LOW_SIGNAL_PATTERNS = [
  /\b(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|great|bye|goodbye)\b/i,
  /\b(lol|lmao|haha|sure|yep|nope)\b/i,
];

export const FALLBACK_PROMPT =
  "I didn't catch a specific fact. Is there something you want me to remember?";

const normalizeContent = (content: string) => content.trim().replace(/\s+/g, " ");

const isLowSignal = (content: string) => {
  if (content.length < MIN_SIGNAL_CHARS) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(content));
};

const truncateToMax = (content: string) => {
  if (content.length <= MAX_FACT_CHARS) return content;
  const trimmed = content.slice(0, MAX_FACT_CHARS + 1);
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace > 0 && lastSpace >= MAX_FACT_CHARS - 20) {
    return trimmed.slice(0, lastSpace).trim();
  }
  return trimmed.slice(0, MAX_FACT_CHARS).trim();
};

export function distillContextWindow(messages: ContextMessage[]): {
  fact: string | null;
  sourceMessageId?: string;
} {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const normalized = normalizeContent(message.content);
    if (!normalized || isLowSignal(normalized)) continue;
    return { fact: truncateToMax(normalized), sourceMessageId: message.messageId };
  }
  return { fact: null };
}

export function inferRigorLevel(snippet: string): "normal" | "high" {
  const text = snippet.toLowerCase();
  const keywords = [
    "allergy",
    "allergic",
    "anaphylaxis",
    "epipen",
    "medication",
    "medical",
    "diagnosis",
    "doctor",
    "hospital",
    "asthma",
    "diabetes",
    "insulin",
    "blood pressure",
    "legal",
    "lawyer",
    "attorney",
    "contract",
    "lawsuit",
    "court",
  ];

  return keywords.some((keyword) => text.includes(keyword)) ? "high" : "normal";
}
