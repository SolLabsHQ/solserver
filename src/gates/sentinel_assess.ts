import type { GateInput } from "./normalize_modality";
import { runSentinelGate, type Risk, type RiskReason } from "./intent_risk";

export type SentinelSentiment =
  | "joy"
  | "awe"
  | "determination"
  | "confidence"
  | "warmth"
  | "longing"
  | "affection"
  | "neutral"
  | "mixed"
  | "unclear";

export type SentinelAssessment = {
  severity_signal: number;
  detected_sentiment: SentinelSentiment;
  risk: Risk;
  riskReasons: RiskReason[];
};

const sentimentKeywords: Record<Exclude<SentinelSentiment, "mixed" | "unclear">, string[]> = {
  joy: ["happy", "joy", "excited", "delighted", "thrilled", "glad"],
  awe: ["awe", "amazing", "incredible", "wow", "blown away"],
  determination: ["determined", "persist", "grit", "resolve", "commit"],
  confidence: ["confident", "certain", "sure", "capable", "can do"],
  warmth: ["grateful", "thankful", "appreciate", "kind", "warm"],
  longing: ["miss", "wish", "yearn", "longing"],
  affection: ["love", "adore", "cherish", "affection", "hug"],
  neutral: [],
};

const detectSentiment = (text: string): SentinelSentiment => {
  const matches: SentinelSentiment[] = [];
  const lower = text.toLowerCase();

  for (const [sentiment, keywords] of Object.entries(sentimentKeywords)) {
    if (sentiment === "neutral") continue;
    if (keywords.some((keyword) => lower.includes(keyword))) {
      matches.push(sentiment as SentinelSentiment);
    }
  }

  if (matches.length === 0) return "neutral";
  if (matches.length > 1) return "mixed";
  return matches[0] ?? "unclear";
};

const severityFromRisk = (risk: Risk): number => {
  if (risk === "high") return 0.9;
  if (risk === "med") return 0.6;
  return 0.1;
};

export async function assessSentinel(snippet: string): Promise<SentinelAssessment> {
  if (process.env.SENTINEL_FORCE_FAIL === "1") {
    throw new Error("sentinel_forced_failure");
  }

  const gateInput: GateInput = {
    messageText: snippet,
    urlHintCount: 0,
    captureUrlCount: 0,
    evidenceCounts: {
      captureCount: 0,
      supportCount: 0,
      claimCount: 0,
      snippetCharTotal: 0,
    },
  };

  const output = runSentinelGate(gateInput);
  return {
    severity_signal: severityFromRisk(output.risk),
    detected_sentiment: detectSentiment(snippet),
    risk: output.risk,
    riskReasons: output.riskReasons,
  };
}
