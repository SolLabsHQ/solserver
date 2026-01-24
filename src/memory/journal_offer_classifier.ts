import { randomUUID } from "node:crypto";

export type MoodLabel = "overwhelm" | "insight" | "gratitude" | "resolve" | "curiosity";
export type MoodSignal = {
  label: MoodLabel;
  intensity: number;
  confidence: "low" | "med" | "high";
};

export type JournalOffer = {
  momentId: string;
  momentType: "overwhelm" | "vent" | "insight" | "gratitude" | "decision" | "fun";
  phase: "rising" | "peak" | "downshift" | "settled";
  confidence: "low" | "med" | "high";
  evidenceSpan: { startMessageId: string; endMessageId: string };
  why?: string[];
  offerEligible: boolean;
};

const KEYWORDS: Record<MoodLabel, string[]> = {
  overwhelm: ["overwhelmed", "overwhelm", "too much", "can't handle", "panic", "panicking", "drowning"],
  insight: ["realize", "realised", "insight", "aha", "learned", "noticed", "figured out"],
  gratitude: ["grateful", "thankful", "appreciate"],
  resolve: ["resolve", "resolved", "decide", "decision", "committed", "determined"],
  curiosity: ["curious", "wonder", "what if", "why", "how", "explore"],
};

const INTENSIFIERS = ["very", "really", "so", "extremely", "incredibly", "super", "totally"];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function detectMoodSignal(text: string): MoodSignal | null {
  const lower = text.toLowerCase();
  const matches = (label: MoodLabel) => KEYWORDS[label].some((word) => lower.includes(word));

  const label = (Object.keys(KEYWORDS) as MoodLabel[]).find(matches) ?? null;
  if (!label) return null;

  let intensity = 0.5;
  const keywordHits = KEYWORDS[label].filter((word) => lower.includes(word)).length;
  if (keywordHits > 1) intensity += 0.15;
  if (INTENSIFIERS.some((word) => lower.includes(word))) intensity += 0.2;
  if (lower.includes("!")) intensity += 0.1;
  if (label === "overwhelm" && lower.includes("panic")) intensity += 0.2;

  const confidence: MoodSignal["confidence"] =
    keywordHits > 1 || intensity > 0.7 ? "high" : "med";

  return { label, intensity: clamp01(intensity), confidence };
}

export function classifyJournalOffer(args: {
  mood: MoodSignal | null;
  risk: "low" | "med" | "high";
  phase: "rising" | "peak" | "downshift" | "settled";
  avoidPeakOverwhelm?: boolean;
  evidenceSpan: { startMessageId: string; endMessageId: string };
}): JournalOffer | null {
  if (!args.mood) return null;
  if (args.risk !== "low") return null;

  const { label, intensity } = args.mood;
  const phase = args.phase;

  if (label === "curiosity") return null;

  if (label === "overwhelm") {
    if (phase !== "settled") return null;
    if (args.avoidPeakOverwhelm) return null;
    const reasons = ["overwhelm_settled"];
    return {
      momentId: randomUUID(),
      momentType: "vent",
      phase,
      confidence: "med",
      evidenceSpan: {
        startMessageId: args.evidenceSpan.startMessageId,
        endMessageId: args.evidenceSpan.endMessageId,
      },
      why: reasons,
      offerEligible: true,
    };
  }

  if (label === "insight" && intensity > 0.7) {
    return {
      momentId: randomUUID(),
      momentType: "insight",
      phase,
      confidence: "high",
      evidenceSpan: {
        startMessageId: args.evidenceSpan.startMessageId,
        endMessageId: args.evidenceSpan.endMessageId,
      },
      why: ["insight_high_intensity"],
      offerEligible: true,
    };
  }

  if (label === "gratitude") {
    if (phase === "rising" || phase === "peak") return null;
    return {
      momentId: randomUUID(),
      momentType: "gratitude",
      phase,
      confidence: "med",
      evidenceSpan: {
        startMessageId: args.evidenceSpan.startMessageId,
        endMessageId: args.evidenceSpan.endMessageId,
      },
      why: ["gratitude_downshift_or_settled"],
      offerEligible: true,
    };
  }

  if (label === "resolve") {
    if (phase !== "settled") return null;
    return {
      momentId: randomUUID(),
      momentType: "decision",
      phase,
      confidence: "med",
      evidenceSpan: {
        startMessageId: args.evidenceSpan.startMessageId,
        endMessageId: args.evidenceSpan.endMessageId,
      },
      why: ["resolve_settled"],
      offerEligible: true,
    };
  }

  return null;
}
