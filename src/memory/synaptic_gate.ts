import { assessSentinel, type SentinelAssessment, type SentinelSentiment } from "../gates/sentinel_assess";

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

export type DistillResult = {
  fact: string | null;
  rigorLevel: "normal" | "high";
  rigorReason?: string | null;
  moodAnchor: string | null;
  sentinel: {
    assessed: boolean;
    severitySignal?: number;
    detectedSentiment?: SentinelSentiment;
    error?: string;
  };
};

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

const moodAnchorFromSentiment = (sentiment: SentinelSentiment): string => {
  switch (sentiment) {
    case "joy":
    case "awe":
      return "breakthrough";
    case "determination":
    case "confidence":
      return "resolve";
    case "warmth":
    case "longing":
    case "affection":
      return "nostalgia";
    case "neutral":
      return "standard_fact";
    case "mixed":
    case "unclear":
    default:
      return "insight";
  }
};

const shouldEscalateRigor = (assessment: SentinelAssessment): boolean =>
  assessment.severity_signal > 0.8;

export async function processDistillation(messages: ContextMessage[]): Promise<DistillResult> {
  const distill = distillContextWindow(messages);
  const fact = distill.fact;
  if (!fact) {
    return {
      fact: null,
      rigorLevel: "normal",
      rigorReason: null,
      moodAnchor: null,
      sentinel: { assessed: false },
    };
  }

  try {
    const assessment = await assessSentinel(fact);
    const rigorLevel = shouldEscalateRigor(assessment) ? "high" : "normal";
    const moodAnchor = moodAnchorFromSentiment(assessment.detected_sentiment);

    return {
      fact,
      rigorLevel,
      rigorReason: null,
      moodAnchor,
      sentinel: {
        assessed: true,
        severitySignal: assessment.severity_signal,
        detectedSentiment: assessment.detected_sentiment,
      },
    };
  } catch (error) {
    return {
      fact,
      rigorLevel: "high",
      rigorReason: "sentinel_unavailable",
      moodAnchor: null,
      sentinel: {
        assessed: false,
        error: String(error),
      },
    };
  }
}
