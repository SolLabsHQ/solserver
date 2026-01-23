import { assessSentinel, type SentinelAssessment, type SentinelSentiment } from "../gates/sentinel_assess";

export type ContextMessage = {
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type SynapticTraceRecorder = {
  level: "info" | "debug";
  enabled: boolean;
  emit: (eventName: string, payload: Record<string, any>) => void;
};

export type DistillTraceContext = {
  trace?: SynapticTraceRecorder;
  requestId?: string;
  threadId?: string | null;
};

const MAX_FACT_CHARS = 150;
const MIN_SIGNAL_CHARS = 12;
const NOISE_REGISTRY_VERSION = "v0.1";
const MAX_NOISE_EVENTS = 1;

type NamedPattern = {
  id: string;
  regex: RegExp;
  description: string;
};

const LOW_SIGNAL_REGISTRY: NamedPattern[] = [
  {
    id: "greetings_gratitude",
    regex: /\b(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|great|bye|goodbye)\b/i,
    description: "Standard conversational fillers",
  },
  {
    id: "reactive_noise",
    regex: /\b(lol|lmao|haha|wow|oh|ugh|hmm)\b/i,
    description: "One-word emotional reactions",
  },
  {
    id: "affirmation_negation",
    regex: /\b(yes|yeah|yep|no|nope|nah|sure|ok|okay)\b/i,
    description: "Binary conversational signals",
  },
  {
    id: "testing_noise",
    regex: /\b(test|testing|ping|are you there|can you hear me)\b/i,
    description: "Developer/user connection checks",
  },
  {
    id: "unicode_spam",
    regex: /^[\p{Emoji}\s\p{Punctuation}]+$/u,
    description: "Emoji/punct-only",
  },
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

const isLowSignal = (
  content: string,
  emitNoise?: (patternId: string, contentLength: number) => void
) => {
  if (content.length < MIN_SIGNAL_CHARS) {
    emitNoise?.("length_guard", content.length);
    return true;
  }

  for (const pattern of LOW_SIGNAL_REGISTRY) {
    if (pattern.regex.test(content)) {
      emitNoise?.(pattern.id, content.length);
      return true;
    }
  }

  return false;
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

export function distillContextWindow(
  messages: ContextMessage[],
  opts: DistillTraceContext = {}
): {
  fact: string | null;
  sourceMessageId?: string;
} {
  let emitted = 0;
  const emitNoise = (patternId: string, contentLength: number) => {
    if (!opts.trace?.enabled) return;
    if (emitted >= MAX_NOISE_EVENTS) return;
    emitted += 1;
    try {
      opts.trace.emit("synaptic_gate_noise_filtered", {
        gate: "synaptic_gate",
        pattern_id: patternId,
        content_length: contentLength,
        registry_version: NOISE_REGISTRY_VERSION,
        ...(opts.requestId ? { request_id: opts.requestId } : {}),
        ...(opts.threadId ? { thread_id: opts.threadId } : {}),
      });
    } catch {}
  };

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const normalized = normalizeContent(message.content);
    if (!normalized || isLowSignal(normalized, emitNoise)) continue;
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

export async function processDistillation(
  messages: ContextMessage[],
  opts: DistillTraceContext = {}
): Promise<DistillResult> {
  const distill = distillContextWindow(messages, opts);
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
