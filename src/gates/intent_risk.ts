import type { GateInput } from "./normalize_modality";

export type Intent =
  | "draft"
  | "summarize"
  | "decision"
  | "research"
  | "code"
  | "plan"
  | "support"
  | "unknown";

export type Risk = "low" | "med" | "high";

export type RiskReason =
  | "FINANCE"
  | "LEGAL"
  | "MEDICAL"
  | "PRIVACY_SECURITY"
  | "SELF_HARM"
  | "VIOLENCE"
  | "EXTREMISM"
  | "RELATIONSHIP_INTIMACY"
  | "FAMILY"
  | "MINORS"
  | "UNKNOWN";

export type IntentGateOutput = {
  intent: Intent;
};

export type SentinelGateOutput = {
  risk: Risk;
  riskReasons: RiskReason[];
  isUrgent?: boolean;
  urgentReasonCode?: string;
  urgentSummary?: string;
};

/**
 * Intent/Risk Gate (v0 heuristic)
 * 
 * Classifies user intent and risk level using keyword matching.
 * Returns up to 5 risk reasons.
 */
export function runIntentGate(input: GateInput): IntentGateOutput {
  const messageText = input.messageText.toLowerCase();
  
  // Intent classification (keyword-based)
  const intent = classifyIntent(messageText);
  
  return {
    intent,
  };
}

export function runSentinelGate(input: GateInput): SentinelGateOutput {
  const messageText = input.messageText.toLowerCase();

  // Risk classification (keyword-based)
  const { risk, riskReasons } = classifyRisk(messageText);
  const boundedReasons = riskReasons.slice(0, 5);

  const urgentSignals: Record<RiskReason, { code: string; summary: string }> = {
    SELF_HARM: { code: "self_harm_signal", summary: "Self-harm signal" },
    VIOLENCE: { code: "violence_signal", summary: "Violence signal" },
  };
  const urgentReason = boundedReasons.find((reason) => reason in urgentSignals);
  const urgentMeta = urgentReason ? urgentSignals[urgentReason] : undefined;

  return {
    risk,
    riskReasons: boundedReasons,
    ...(urgentMeta
      ? {
          isUrgent: true,
          urgentReasonCode: urgentMeta.code,
          urgentSummary: urgentMeta.summary,
        }
      : {}),
  };
}

function classifyIntent(text: string): Intent {
  // Summarize
  if (
    text.includes("summarize") ||
    text.includes("tldr") ||
    text.includes("overview") ||
    text.includes("sum up")
  ) {
    return "summarize";
  }
  
  // Research
  if (
    text.includes("research") ||
    text.includes("find") ||
    text.includes("look up") ||
    text.includes("investigate") ||
    text.includes("search for")
  ) {
    return "research";
  }
  
  // Decision
  if (
    text.includes("should i") ||
    text.includes("decide") ||
    text.includes("choose") ||
    text.includes("recommend") ||
    text.includes("which one")
  ) {
    return "decision";
  }
  
  // Code
  if (
    text.includes("write code") ||
    text.includes("implement") ||
    text.includes("function") ||
    text.includes("class") ||
    text.includes("algorithm") ||
    text.includes("debug")
  ) {
    return "code";
  }
  
  // Plan
  if (
    text.includes("plan") ||
    text.includes("schedule") ||
    text.includes("organize") ||
    text.includes("steps") ||
    text.includes("roadmap")
  ) {
    return "plan";
  }
  
  // Draft
  if (
    text.includes("write") ||
    text.includes("draft") ||
    text.includes("compose") ||
    text.includes("email") ||
    text.includes("letter")
  ) {
    return "draft";
  }
  
  // Support
  if (
    text.includes("help") ||
    text.includes("how to") ||
    text.includes("explain") ||
    text.includes("what is") ||
    text.includes("can you")
  ) {
    return "support";
  }
  
  // Fallback
  return "unknown";
}

function classifyRisk(text: string): { risk: Risk; riskReasons: RiskReason[] } {
  const reasons: RiskReason[] = [];
  
  // High risk keywords
  const highRiskKeywords = {
    FINANCE: ["invest", "stock", "crypto", "loan", "mortgage", "tax", "financial advice"],
    LEGAL: ["lawsuit", "legal advice", "contract", "sue", "lawyer", "attorney"],
    MEDICAL: ["diagnose", "treatment", "medication", "doctor", "medical advice", "symptom"],
    SELF_HARM: ["suicide", "self harm", "kill myself", "end my life"],
    VIOLENCE: ["kill", "hurt", "attack", "weapon", "bomb"],
  };
  
  // Medium risk keywords
  const medRiskKeywords = {
    PRIVACY_SECURITY: ["password", "hack", "breach", "security", "private", "confidential"],
    RELATIONSHIP_INTIMACY: ["relationship", "dating", "intimacy", "romantic", "breakup"],
    FAMILY: ["family", "parenting", "children", "kids"],
    EXTREMISM: ["extremist", "radical", "terrorist"],
    MINORS: ["minor", "underage", "child safety"],
  };
  
  // Check high risk
  for (const [reason, keywords] of Object.entries(highRiskKeywords)) {
    if (keywords.some(kw => text.includes(kw))) {
      reasons.push(reason as RiskReason);
    }
  }
  
  // Check medium risk
  for (const [reason, keywords] of Object.entries(medRiskKeywords)) {
    if (keywords.some(kw => text.includes(kw))) {
      reasons.push(reason as RiskReason);
    }
  }
  
  // Determine risk level
  let risk: Risk = "low";
  if (reasons.length > 0) {
    // High risk if any high-risk keywords matched
    const highRiskReasons = ["FINANCE", "LEGAL", "MEDICAL", "SELF_HARM", "VIOLENCE"];
    if (reasons.some(r => highRiskReasons.includes(r))) {
      risk = "high";
    } else {
      risk = "med";
    }
  }
  
  // Add UNKNOWN if no specific reasons found but want to flag something
  if (reasons.length === 0 && text.includes("risk")) {
    reasons.push("UNKNOWN");
  }
  
  return { risk, riskReasons: reasons };
}
