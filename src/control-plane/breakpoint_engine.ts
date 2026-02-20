export type BreakpointDecision = "must" | "should" | "skip";

export type BreakpointSignalKind =
  | "decision_made"
  | "scope_changed"
  | "pivot"
  | "answer_provided"
  | "ack_only"
  | "open_loop_created"
  | "open_loop_resolved"
  | "risk_or_conflict";

const MUST_SIGNAL_KINDS = new Set<BreakpointSignalKind>([
  "decision_made",
  "scope_changed",
  "pivot",
  "answer_provided",
]);

const SHOULD_SIGNAL_KINDS = new Set<BreakpointSignalKind>([
  "open_loop_created",
  "open_loop_resolved",
  "risk_or_conflict",
]);

function isAckOnlyMessage(message: string): boolean {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return false;

  const ackTokens = new Set([
    "ok",
    "okay",
    "kk",
    "thx",
    "thanks",
    "got",
    "it",
    "sounds",
    "good",
    "cool",
    "yep",
    "yup",
    "sure",
    "all",
    "right",
  ]);

  const tokens = normalized.split(" ");
  return tokens.every((token) => ackTokens.has(token));
}

export function decideBreakpointAction(args: {
  message: string;
  signalKinds?: BreakpointSignalKind[];
  contextWindowPressure?: boolean;
  driftRisk?: boolean;
  summaryChanged?: boolean;
}): BreakpointDecision {
  const signalKinds = args.signalKinds ?? [];

  if (args.summaryChanged) return "must";
  if (signalKinds.some((kind) => MUST_SIGNAL_KINDS.has(kind))) return "must";
  if (signalKinds.some((kind) => SHOULD_SIGNAL_KINDS.has(kind))) return "should";
  if (args.contextWindowPressure || args.driftRisk) return "should";
  if (signalKinds.includes("ack_only") || isAckOnlyMessage(args.message)) return "skip";
  return "should";
}

export function shouldFreezeSummaryAtPeak(args: {
  phase?: "rising" | "peak" | "downshift" | "settled";
  intensityBucket?: "low" | "med" | "high";
  decision: BreakpointDecision;
}): boolean {
  const isPeakOrHigh = args.phase === "peak" || args.intensityBucket === "high";
  return isPeakOrHigh && args.decision !== "must";
}
