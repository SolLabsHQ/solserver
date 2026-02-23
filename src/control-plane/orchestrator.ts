import { z } from "zod";

import { routeMode, resolvePersonaLabel } from "./router";
import { buildPromptPack, toSinglePromptText, promptPackLogShape, withCorrectionSection, type PromptPack } from "./prompt_pack";
import { runGatesPipeline } from "../gates/gates_pipeline";
import {
  retrieveContext,
  retrievalLogShape,
  getThreadMementoLatestCached,
  setThreadMementoLatestCached,
  updateLatestAffectWithPoint,
  sanitizeThreadMementoLatest,
  shouldPersistThreadMementoLatest,
  noteThreadMementoLatestTurn,
  markThreadMementoLatestPersisted,
  type ThreadMementoLatestInternal,
  type ThreadMementoLatest,
} from "./retrieval";
import {
  decideBreakpointAction,
  shouldFreezeSummaryAtPeak,
  type BreakpointSignalKind,
  type BreakpointDecision,
} from "./breakpoint_engine";
import { postOutputLinter, type PostLinterViolation, type PostLinterBlockResult, type DriverBlockEnforcementMode } from "../gates/post_linter";
import { runEvidenceIntake } from "../gates/evidence_intake";
import { EvidenceValidationError } from "../gates/evidence_validation_error";
import { applyLibrarianGate } from "../gates/librarian_gate";
import {
  deriveUsedEvidenceIds,
  extractClaims,
  runEvidenceBindingGate,
  runEvidenceBudgetGate,
  type EvidenceGateErrorCode,
} from "../gates/evidence_output_gates";
import {
  EvidenceProviderError,
  type EvidencePack,
  selectEvidenceProvider,
  validateEvidencePack,
} from "../evidence/evidence_provider";
import { fakeModelReplyWithMeta } from "../providers/fake_model";
import { openAIModelReplyWithMeta, OpenAIProviderError } from "../providers/openai_model";
import { selectModel } from "../providers/provider_config";
import { GATE_SENTINEL, type GateOutput } from "../gates/gate_interfaces";
import * as fs from "node:fs";
import type { ControlPlaneStore, JournalOfferRecord, TraceRun, Transmission } from "../store/control_plane_store";
import {
  OUTPUT_ENVELOPE_META_ALLOWED_KEYS,
  OutputEnvelopeShapeSchema,
  OutputEnvelopeSchema,
  OutputEnvelopeV0MinSchema,
  type OutputEnvelope,
} from "../contracts/output_envelope";
import type {
  PacketInput,
  ModeDecision,
  NotificationPolicy,
  ThreadContextMode,
  ThreadMementoV02,
} from "../contracts/chat";
import { classifyJournalOffer, type MoodSignal } from "../memory/journal_offer_classifier";
import { buildSSEEnvelope, buildTransmissionSubject, sseHub } from "../sse/sse_hub";
import { computeLatticeEmbedding } from "../lattice/embedding";

export type OrchestrationSource = "api" | "worker";
export type SystemPersona = NonNullable<ModeDecision["personaLabel"]>;

export type OrchestrationRequest = {
  source: OrchestrationSource;
  packet: PacketInput;
  simulate?: boolean;
  forcedPersona?: SystemPersona | null;
  userId?: string;
};

export function makeForcedModeDecision(forcedPersona: SystemPersona): ModeDecision {
  const modeLabel = forcedPersona === "sole"
    ? "Sole"
    : forcedPersona === "ida"
      ? "Ida"
      : "System-mode";

  return {
    modeLabel,
    personaLabel: forcedPersona,
    domainFlags: ["forced_persona"],
    confidence: 1.0,
    checkpointNeeded: false,
    reasons: ["forced_persona"],
    version: "mode-engine-v0",
  };
}

export function resolveModeDecision(packet: PacketInput, forcedPersona?: SystemPersona | null): ModeDecision {
  if (forcedPersona) return makeForcedModeDecision(forcedPersona);
  return routeMode(packet);
}

export function resolveNotificationPolicy(args: {
  source: OrchestrationSource;
  simulate?: boolean;
  requestedPolicy?: NotificationPolicy;
  personaLabel: SystemPersona;
  safetyIsUrgent?: boolean;
}): NotificationPolicy {
  const defaultPolicy: NotificationPolicy =
    args.source === "worker" || args.simulate ? "silent" : "alert";
  let policy = args.requestedPolicy ?? defaultPolicy;

  const allowUrgent = args.safetyIsUrgent === true || args.personaLabel === "cassandra";
  if (policy === "urgent" && !allowUrgent) {
    policy = defaultPolicy;
  } else if (policy !== "urgent" && args.safetyIsUrgent === true) {
    policy = "urgent";
  }

  return policy;
}

export function buildOutputEnvelopeMeta(args: {
  envelope: OutputEnvelope;
  personaLabel: SystemPersona;
  notificationPolicy: NotificationPolicy;
}): OutputEnvelope {
  const meta = {
    ...(args.envelope.meta ?? {}),
    persona_label: args.personaLabel,
    notification_policy: args.notificationPolicy,
  };
  return { ...args.envelope, meta, notification_policy: args.notificationPolicy };
}

type PolicyCapsule = {
  id: string;
  title?: string;
  snippet: string;
  tags?: string[];
  max_bytes?: number;
};

const POLICY_BUNDLE_CACHE = new Map<string, { mtimeMs: number; capsules: PolicyCapsule[] }>();

function loadPolicyCapsules(
  path: string,
  log: { warn: (obj: any, msg?: string) => void }
): { capsules: PolicyCapsule[]; warning?: string } {
  try {
    const stat = fs.statSync(path);
    const cached = POLICY_BUNDLE_CACHE.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { capsules: cached.capsules };
    }

    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const capsulesRaw = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.capsules)
        ? parsed.capsules
        : [];

    const capsules: PolicyCapsule[] = capsulesRaw
      .filter((entry: any) => entry && typeof entry.id === "string" && typeof entry.snippet === "string")
      .map((entry: any) => ({
        id: String(entry.id),
        title: typeof entry.title === "string" ? entry.title : undefined,
        snippet: String(entry.snippet),
        tags: Array.isArray(entry.tags)
          ? entry.tags.filter((tag: any) => typeof tag === "string")
          : undefined,
        max_bytes: typeof entry.max_bytes === "number" ? entry.max_bytes : undefined,
      }));

    POLICY_BUNDLE_CACHE.set(path, { mtimeMs: stat.mtimeMs, capsules });
    return { capsules };
  } catch (error) {
    log.warn({ evt: "lattice.policy_bundle_load_failed", path, error: String(error) }, "lattice.policy_bundle_load_failed");
    return { capsules: [], warning: "policy_bundle_unavailable" };
  }
}

function buildLatticeQueryTerms(message: string, limit = 12): string[] {
  const tokens = message.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const unique: string[] = [];
  for (const token of tokens) {
    if (unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= limit) break;
  }
  return unique;
}

function shouldRetrievePolicy(args: {
  risk: string;
  intent: string;
  message: string;
}): boolean {
  if (args.risk === "med" || args.risk === "high") return true;
  const text = args.message.toLowerCase();
  const keywords = [
    "policy",
    "safety",
    "constraint",
    "governance",
    "rule",
    "journal",
    "consent",
    "self-harm",
    "suicide",
    "violence",
    "abuse",
    "hate",
    "escalate",
    "crisis",
    "privacy",
    "security",
  ];
  if (keywords.some((keyword) => text.includes(keyword))) return true;
  if (args.intent === "support" && text.includes("should i")) return true;
  return false;
}

function truncateByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const slice = text.slice(0, mid);
    if (Buffer.byteLength(slice, "utf8") <= maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return text.slice(0, Math.max(0, low - 1));
}

function formatThreadMementoResponse(memento: any | null) {
  if (!memento || typeof memento !== "object") return memento ?? null;
  const mementoId = memento.mementoId ?? memento.id ?? null;
  const createdAt = memento.createdAt ?? memento.createdTs ?? null;
  return {
    ...memento,
    ...(mementoId ? { id: mementoId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function toInternalLatestFromRequestMemento(
  memento: ThreadMementoV02
): ThreadMementoLatestInternal {
  const nowIso = new Date().toISOString();
  const safeUpdatedAt = memento.affect?.rollup?.updatedAt ?? nowIso;
  const safePoints = (memento.affect?.points ?? []).slice(-5).map((point) => ({
    endMessageId: point.endMessageId,
    label: point.label,
    intensity: point.intensity,
    confidence: point.confidence,
    source: point.source === "sentinel" ? "server" : point.source,
    ts: safeUpdatedAt,
  }));

  return {
    mementoId: memento.mementoId,
    threadId: memento.threadId,
    createdTs: memento.createdTs,
    updatedAt: safeUpdatedAt,
    // Keep internal storage compatibility; request contract still validates v0.2 at ingress.
    version: "memento-v0.1",
    arc: memento.arc,
    active: [...memento.active],
    parked: [...memento.parked],
    decisions: [...memento.decisions],
    next: [...memento.next],
    affect: {
      points: safePoints,
      rollup: {
        phase: memento.affect.rollup.phase,
        intensityBucket: memento.affect.rollup.intensityBucket,
        updatedAt: safeUpdatedAt,
      },
    },
  };
}

type RequestThreadMementoSource =
  | "request_context.thread_memento_ref"
  | "request_context.thread_memento"
  | null;

function resolveRequestThreadMemento(packet: PacketInput, args?: {
  cachedLatest?: ThreadMementoLatestInternal | null;
}): {
  memento: ThreadMementoLatestInternal | null;
  source: RequestThreadMementoSource;
} {
  const requestRef = packet.context?.thread_memento_ref;
  if (requestRef) {
    const targetThreadId = requestRef.threadId ?? packet.threadId;
    const latest = args?.cachedLatest ?? getThreadMementoLatestCached(packet.threadId);
    if (targetThreadId === packet.threadId && latest && latest.mementoId === requestRef.mementoId) {
      return {
        memento: latest,
        source: "request_context.thread_memento_ref",
      };
    }
  }

  const requestMemento = packet.context?.thread_memento;
  if (!requestMemento) {
    return { memento: null, source: null };
  }
  if (requestMemento.threadId !== packet.threadId) {
    return { memento: null, source: null };
  }
  return {
    memento: toInternalLatestFromRequestMemento(requestMemento),
    source: "request_context.thread_memento",
  };
}

function extractBreakpointSignalKinds(packet: PacketInput): BreakpointSignalKind[] {
  const items = packet.context?.thread_memento?.signals?.items ?? [];
  const kinds: BreakpointSignalKind[] = [];
  for (const item of items) {
    kinds.push(item.kind);
  }
  return kinds;
}

export function resolveSafetyIsUrgent(args: {
  results: GateOutput[];
  log?: { warn: (obj: Record<string, any>, msg?: string) => void };
}): boolean {
  let isUrgent = false;

  for (const result of args.results) {
    const flagged = result.is_urgent === true || result.metadata?.is_urgent === true;
    if (!flagged) continue;

    if (result.gateName === GATE_SENTINEL) {
      isUrgent = true;
      continue;
    }

    if (args.log?.warn) {
      args.log.warn(
        { evt: "gate.is_urgent_blocked", gateName: result.gateName, allowedGateName: GATE_SENTINEL },
        "gate.is_urgent_blocked"
      );
    }
  }

  return isUrgent;
}

function resolvePacketMessageId(packet: PacketInput, transmission: Transmission): string {
  const meta = (packet.meta ?? {}) as Record<string, any>;
  const candidate =
    meta.message_id
    ?? meta.messageId
    ?? transmission.id
    ?? packet.clientRequestId;
  return String(candidate);
}

function resolveAvoidPeakOverwhelm(packet: PacketInput): boolean | undefined {
  const meta = (packet.meta ?? {}) as Record<string, any>;
  const journalStyle =
    meta.cpb_journal_style
    ?? meta.cpbJournalStyle
    ?? meta.journalStyle
    ?? null;

  if (!journalStyle || typeof journalStyle !== "object") return undefined;
  const settings = (journalStyle as any).settings;
  const offerTiming = settings?.offer_timing ?? settings?.offerTiming;
  const value = offerTiming?.avoid_peak_overwhelm ?? offerTiming?.avoidPeakOverwhelm;
  return typeof value === "boolean" ? value : undefined;
}

function resolveThreadContextMode(packet: PacketInput): ThreadContextMode {
  return packet.thread_context_mode === "off" ? "off" : "auto";
}

function resolveJournalOfferMode(packet: PacketInput): JournalOfferRecord["mode"] | undefined {
  const meta = (packet.meta ?? {}) as Record<string, any>;
  const journalStyle =
    meta.cpb_journal_style
    ?? meta.cpbJournalStyle
    ?? meta.journalStyle
    ?? null;
  const settings = journalStyle && typeof journalStyle === "object"
    ? ((journalStyle as any).settings ?? journalStyle)
    : null;
  const raw =
    settings?.default_mode
    ?? settings?.defaultMode
    ?? meta.journal_mode
    ?? meta.journalMode;
  return raw === "assist" || raw === "verbatim" ? raw : undefined;
}

function buildJournalOfferRecord(args: {
  journalOffer: ReturnType<typeof classifyJournalOffer> | null;
  offerSpanStart: string;
  offerSpanEnd: string;
  offerSkipReasons: Array<
    "no_affect_signal" | "label_neutral" | "risk_not_low" | "phase_blocked" | "cooldown" | "other"
  >;
  offerPhase?: "rising" | "peak" | "downshift" | "settled";
  offerRisk: "low" | "med" | "high";
  offerLabel?: JournalOfferRecord["label"];
  offerIntensityBucket?: JournalOfferRecord["intensityBucket"];
  offerMode?: JournalOfferRecord["mode"];
}): JournalOfferRecord {
  const base: JournalOfferRecord = {
    kind: "journal_offer",
    offerEligible: Boolean(args.journalOffer),
    phase: args.offerPhase,
    risk: args.offerRisk,
    label: args.offerLabel,
    intensityBucket: args.offerIntensityBucket,
  };

  if (args.offerMode) {
    base.mode = args.offerMode;
  }

  if (args.journalOffer) {
    base.evidenceSpan = {
      startMessageId: args.journalOffer.evidenceSpan.startMessageId || args.offerSpanStart,
      endMessageId: args.journalOffer.evidenceSpan.endMessageId || args.offerSpanEnd,
    };
    return base;
  }

  base.reasonCodes = args.offerSkipReasons.length > 0
    ? args.offerSkipReasons
    : ["other"];
  return base;
}

const AFFECT_LABELS = new Set(["overwhelm", "insight", "gratitude", "resolve", "curiosity", "neutral"]);

type NormalizedAffectSignal = {
  label: "overwhelm" | "insight" | "gratitude" | "resolve" | "curiosity" | "neutral";
  intensity: number;
  confidence: "low" | "med" | "high";
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const CONFIDENCE_BUCKETS = new Set(["low", "med", "high"]);

function normalizeAffectSignal(raw: unknown): NormalizedAffectSignal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, any>;
  if (Object.keys(input).length === 0) return null;

  const labelRaw = typeof input.label === "string" ? input.label : "neutral";
  const label = AFFECT_LABELS.has(labelRaw) ? (labelRaw as NormalizedAffectSignal["label"]) : "neutral";
  const intensity = Number.isFinite(Number(input.intensity)) ? clamp01(Number(input.intensity)) : 0;

  let confidence: NormalizedAffectSignal["confidence"] = "low";
  if (typeof input.confidence === "string" && CONFIDENCE_BUCKETS.has(input.confidence)) {
    confidence = input.confidence as NormalizedAffectSignal["confidence"];
  } else if (Number.isFinite(Number(input.confidence))) {
    confidence = confidenceBucket(clamp01(Number(input.confidence)));
  }

  return { label, intensity, confidence };
}

function confidenceBucket(value: number): "low" | "med" | "high" {
  if (value >= 0.7) return "high";
  if (value >= 0.34) return "med";
  return "low";
}

function toMoodSignal(signal: NormalizedAffectSignal | null): MoodSignal | null {
  if (!signal) return null;
  if (signal.label === "neutral") return null;
  return {
    label: signal.label,
    intensity: signal.intensity,
    confidence: signal.confidence,
  };
}

type OutputEnvelopeShape = z.infer<typeof OutputEnvelopeShapeSchema>;

function parseShape(raw: unknown): OutputEnvelopeShape | null {
  const parsed = OutputEnvelopeShapeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type MementoQualityIssue = "missing_shape" | "missing_affect_signal" | "shape_decisions_empty";
type MementoShapeSource = "model" | "previous" | "fallback";
type MementoQualityResolution = "none" | "retry" | "fallback";

type MementoQualitySummary = {
  shapePresent: boolean;
  shapeDecisionsCount: number;
  shapeDecisionsEmpty: boolean;
  affectSignalPresent: boolean;
  affectSignalLabel: string | null;
  affectSignalIntensity: number | null;
  affectSignalConfidence: string | null;
  issues: MementoQualityIssue[];
};

function hasDecisionOrLockIntent(message: string): boolean {
  const text = message.toLowerCase();
  return /(?:\bdecid(?:e|ed|ing|ion)\b|\block\b|\bchoose\b|\bshould i\b)/.test(text);
}

function normalizeDecisionText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s\-•:]+/, "")
    .replace(/[.?!\s]+$/, "")
    .trim();
}

function extractFallbackDecisionFromAssistant(assistantText: string): string | null {
  const byLabel = assistantText.match(/(?:^|\n)\s*recommendation:\s*(.+?)(?:\n|$)/i);
  if (byLabel?.[1]) {
    const normalized = normalizeDecisionText(byLabel[1]);
    return normalized || null;
  }

  const byDecision = assistantText.match(/(?:^|\n)\s*(?:decision|choose)\s*:\s*(.+?)(?:\n|$)/i);
  if (byDecision?.[1]) {
    const normalized = normalizeDecisionText(byDecision[1]);
    return normalized || null;
  }

  return null;
}

function evaluateMementoQuality(envelope: OutputEnvelope): MementoQualitySummary {
  const shapePresent = envelope.meta?.shape !== undefined;
  const parsedShape = parseShape(envelope.meta?.shape);
  const shapeDecisionsCount = parsedShape?.decisions.length ?? 0;
  const shapeDecisionsEmpty = shapeDecisionsCount === 0;

  const affectSignalPresent = envelope.meta?.affect_signal !== undefined;
  const normalizedAffect = normalizeAffectSignal(envelope.meta?.affect_signal);
  const rawAffect = envelope.meta?.affect_signal as Record<string, any> | undefined;

  const issues: MementoQualityIssue[] = [];
  if (!shapePresent) issues.push("missing_shape");
  if (!affectSignalPresent || !normalizedAffect) issues.push("missing_affect_signal");
  if (shapeDecisionsEmpty) issues.push("shape_decisions_empty");

  return {
    shapePresent,
    shapeDecisionsCount,
    shapeDecisionsEmpty,
    affectSignalPresent,
    affectSignalLabel:
      normalizedAffect?.label
      ?? (typeof rawAffect?.label === "string" ? rawAffect.label : null),
    affectSignalIntensity:
      normalizedAffect?.intensity
      ?? (Number.isFinite(Number(rawAffect?.intensity)) ? Number(rawAffect?.intensity) : null),
    affectSignalConfidence:
      normalizedAffect?.confidence
      ?? (typeof rawAffect?.confidence === "string" ? rawAffect.confidence : null),
    issues,
  };
}

function buildMementoRepairCorrection(args: { issues: MementoQualityIssue[]; decisionIntent: boolean }): string {
  const lines = [
    "Memento-quality correction:",
    "- Return ONLY valid OutputEnvelope JSON.",
    "- Include meta.shape with arc/active/parked/decisions/next (best-effort, non-empty arrays when known).",
    "- Include meta.affect_signal for the current user turn.",
  ];
  if (args.decisionIntent) {
    lines.push("- User requested a decision/lock action: ensure meta.shape.decisions and meta.shape.next are non-empty best-effort.");
  }
  lines.push(`- Prior issues: ${args.issues.join(", ") || "none"}.`);
  lines.push("- Do not omit required memento context fields in this retry.");
  return lines.join("\n");
}

const DEFAULT_THREAD_MEMENTO_SHAPE: OutputEnvelopeShape = {
  arc: "support",
  active: [],
  parked: [],
  decisions: [],
  next: [],
};

function bootstrapThreadMementoShape(previous: ThreadMementoLatestInternal | null): OutputEnvelopeShape {
  if (previous) {
    return {
      arc: previous.arc,
      active: [...previous.active],
      parked: [...previous.parked],
      decisions: [...previous.decisions],
      next: [...previous.next],
    };
  }
  return { ...DEFAULT_THREAD_MEMENTO_SHAPE };
}

async function updateThreadMementoLatestFromEnvelope(args: {
  packet: PacketInput;
  envelope: OutputEnvelope;
  transmission: Transmission;
  store: ControlPlaneStore;
  threadContextMode: ThreadContextMode;
  requestThreadMemento?: ThreadMementoLatestInternal | null;
  breakpointDecision: BreakpointDecision;
}): Promise<{
  latest: ThreadMementoLatestInternal | null;
  affectSignal: NormalizedAffectSignal | null;
  moodSignal: MoodSignal | null;
  shapeSource: MementoShapeSource;
}> {
  const affectSignal = normalizeAffectSignal(args.envelope.meta?.affect_signal);
  const moodSignal = toMoodSignal(affectSignal);

  if (args.threadContextMode === "off") {
    return { latest: null, affectSignal, moodSignal, shapeSource: "previous" };
  }

  const nowIso = new Date().toISOString();
  const shape = parseShape(args.envelope.meta?.shape);
  const previous = args.requestThreadMemento ?? getThreadMementoLatestCached(args.packet.threadId);
  const baseAffect = previous?.affect ?? {
    points: [],
    rollup: {
      phase: "settled",
      intensityBucket: "low",
      updatedAt: nowIso,
    },
  };

  const freezeSummary = shouldFreezeSummaryAtPeak({
    phase: previous?.affect?.rollup?.phase,
    intensityBucket: previous?.affect?.rollup?.intensityBucket,
    decision: args.breakpointDecision,
  });

  const modelShape = shape && !freezeSummary
    ? {
        arc: shape.arc,
        active: [...shape.active],
        parked: [...shape.parked],
        decisions: [...shape.decisions],
        next: [...shape.next],
      }
    : null;

  let nextShape = modelShape ?? bootstrapThreadMementoShape(previous);
  let shapeSource: MementoShapeSource = modelShape ? "model" : "previous";

  if (modelShape && modelShape.decisions.length === 0 && (previous?.decisions.length ?? 0) > 0) {
    nextShape = {
      ...nextShape,
      decisions: [...previous!.decisions],
    };
    shapeSource = "previous";
  }

  if (modelShape && modelShape.next.length === 0 && (previous?.next.length ?? 0) > 0) {
    nextShape = {
      ...nextShape,
      next: [...previous!.next],
    };
  }

  if (hasDecisionOrLockIntent(args.packet.message) && nextShape.decisions.length === 0) {
    const fallbackDecision = extractFallbackDecisionFromAssistant(args.envelope.assistant_text);
    if (fallbackDecision && !nextShape.decisions.includes(fallbackDecision)) {
      nextShape = {
        ...nextShape,
        decisions: [...nextShape.decisions, fallbackDecision].slice(-5),
      };
      shapeSource = "fallback";
    }
  }

  let nextAffect = baseAffect;
  if (affectSignal) {
    const point = {
      endMessageId: resolvePacketMessageId(args.packet, args.transmission),
      label: affectSignal.label,
      intensity: affectSignal.intensity,
      confidence: affectSignal.confidence,
      source: "model" as const,
      ts: nowIso,
    };
    nextAffect = updateLatestAffectWithPoint({
      existing: baseAffect,
      point,
      nowIso,
    });
  }

  const next: ThreadMementoLatestInternal = {
    mementoId: previous?.mementoId ?? `memento_latest_${args.packet.threadId}`,
    threadId: args.packet.threadId,
    createdTs: previous?.createdTs ?? nowIso,
    updatedAt: nowIso,
    version: "memento-v0.1",
    arc: nextShape.arc,
    active: nextShape.active,
    parked: nextShape.parked,
    decisions: nextShape.decisions,
    next: nextShape.next,
    affect: nextAffect,
  };

  setThreadMementoLatestCached(next);
  noteThreadMementoLatestTurn(args.packet.threadId);

  if (shouldPersistThreadMementoLatest({ next, threadId: args.packet.threadId })) {
    await args.store.upsertThreadMementoLatest({ memento: next });
    markThreadMementoLatestPersisted(next);
  }

  return { latest: next, affectSignal, moodSignal, shapeSource };
}

type EnforcementFailureMetadata = {
  kind: "driver_block_enforcement";
  outcome: "fail_closed_422";
  attempts: number;
  violationsCount: number;
};

function getForcedTestProviderOutput(req: any, attempt: 0 | 1): string | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  const headers = req?.headers ?? {};

  const keyedEnvelope = attempt === 0
    ? headers["x-sol-test-output-envelope-attempt-0"]
    : headers["x-sol-test-output-envelope-attempt-1"];
  const keyedEnvelopeRaw = String(keyedEnvelope ?? "").trim();
  if (keyedEnvelopeRaw) return keyedEnvelopeRaw;

  const envelopeRaw = String(headers["x-sol-test-output-envelope"] ?? "").trim();
  if (envelopeRaw) return envelopeRaw;

  const keyed = attempt === 0
    ? headers["x-sol-test-output-attempt-0"]
    : headers["x-sol-test-output-attempt-1"];
  const attemptValue = String(keyed ?? "").trim();
  if (attemptValue) return JSON.stringify({ assistant_text: attemptValue });

  const fallback = String(headers["x-sol-test-output"] ?? "").trim();
  return fallback ? JSON.stringify({ assistant_text: fallback }) : undefined;
}

function isDeterministicTestRetryEnabled(req: any): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  const headers = req?.headers ?? {};
  const attempt0 = String(
    headers["x-sol-test-output-attempt-0"]
    ?? headers["x-sol-test-output-envelope-attempt-0"]
    ?? ""
  ).trim();
  const attempt1 = String(
    headers["x-sol-test-output-attempt-1"]
    ?? headers["x-sol-test-output-envelope-attempt-1"]
    ?? ""
  ).trim();
  return Boolean(attempt0 && attempt1);
}

type PostLinterMetadata = {
  kind: "post_linter";
  attempt: 0 | 1;
  violationsCount: number;
  blockIds: string[];
  firstFailure?: {
    blockId: string;
    rule: string;
    pattern: string;
  };
};

function buildPostLinterMetadata(violations: PostLinterViolation[], attempt: 0 | 1): PostLinterMetadata {
  const blockIds = Array.from(new Set(violations.map((v) => v.blockId))).slice(0, 10);
  const first = violations[0];
  return {
    kind: "post_linter",
    attempt,
    violationsCount: violations.length,
    blockIds,
    firstFailure: first
      ? {
          blockId: first.blockId,
          rule: first.rule,
          pattern: first.pattern,
        }
      : undefined,
  };
}

function collectPostLinterViolations(result: {
  ok: boolean;
  violations?: PostLinterViolation[];
  warnings?: PostLinterViolation[];
}): PostLinterViolation[] {
  return result.ok ? (result.warnings ?? []) : (result.violations ?? []);
}

function buildPostLinterTrace(result: {
  ok: boolean;
  violations?: PostLinterViolation[];
  warnings?: PostLinterViolation[];
  skipped?: boolean;
}, attempt: 0 | 1): {
  violations: PostLinterViolation[];
  meta: PostLinterMetadata;
  status: "completed" | "warning";
  summary: string;
} {
  const violations = collectPostLinterViolations(result);
  const meta = buildPostLinterMetadata(violations, attempt);
  const status = violations.length === 0 ? "completed" : "warning";
  const summary = result.skipped
    ? "Output linter skipped"
    : violations.length === 0
      ? "Output linter passed"
      : `Output linter warning: ${meta.violationsCount} violations`;
  return { violations, meta, status, summary };
}

function buildDriverBlockFailureDetail(meta: PostLinterMetadata): Record<string, any> {
  return {
    attempt: meta.attempt,
    violationsCount: meta.violationsCount,
    blockIds: meta.blockIds,
    ...(meta.firstFailure ? { firstFailure: meta.firstFailure } : {}),
  };
}

function resolveDriverBlockEnforcementMode(): DriverBlockEnforcementMode {
  const override = String(process.env.SOL_ENFORCEMENT_MODE ?? "").toLowerCase();
  if (override === "strict" || override === "warn" || override === "off") return override;
  const raw = String(process.env.DRIVER_BLOCK_ENFORCEMENT ?? "").toLowerCase();
  if (raw === "strict" || raw === "warn" || raw === "off") return raw;
  if (process.env.SOL_ENV === "staging") return "warn";
  if (process.env.SOL_ENV === "production" || process.env.NODE_ENV === "production") return "strict";
  return "warn";
}

type DriverBlockTraceMetadata = {
  kind: "driver_block";
  attempt: 0 | 1;
  block_id: string;
  block_name: string;
  ok: boolean;
  reason?: string;
  duration_ms: number;
};

function buildDriverBlockTraceEvents(args: {
  blockResults: PostLinterBlockResult[];
  driverBlocks: PromptPack["driverBlocks"];
  attempt: 0 | 1;
}): Array<{ status: "completed" | "warning"; summary: string; metadata: DriverBlockTraceMetadata }> {
  const byId = new Map(args.driverBlocks.map((block) => [block.id, block]));
  return args.blockResults.map((result) => {
    const block = byId.get(result.blockId);
    const blockName = block?.title || result.blockId;
    const reason = result.reason ? `${result.reason.rule}:${result.reason.pattern}` : undefined;
    return {
      status: result.ok ? "completed" : "warning",
      summary: result.ok
        ? `Driver block ${blockName} passed`
        : `Driver block ${blockName} violated`,
      metadata: {
        kind: "driver_block",
        attempt: args.attempt,
        block_id: result.blockId,
        block_name: blockName,
        ok: result.ok,
        reason,
        duration_ms: result.durationMs,
      },
    };
  });
}

type EvidenceIntentSummary = {
  captures: number;
  supports: number;
  claims: number;
};

type EvidenceProviderDecision = {
  allowed: boolean;
  allowedReason: "forced_request" | "forced_env" | "intent_detected" | "no_intent" | "forced_ignored_prod";
  forced: boolean;
};

function resolveEvidenceProviderDecision(args: {
  intakeSummary: EvidenceIntentSummary;
  traceConfig?: { forceEvidence?: boolean };
  nodeEnv?: string;
  env?: NodeJS.ProcessEnv;
}): EvidenceProviderDecision {
  const env = args.env ?? process.env;
  const nodeEnv = args.nodeEnv ?? env.NODE_ENV;
  const requestForced = args.traceConfig?.forceEvidence === true;
  const envForced = env.EVIDENCE_PROVIDER_FORCE === "1";
  const forced = requestForced || envForced;
  const allowIntent =
    args.intakeSummary.captures > 0
    || args.intakeSummary.supports > 0
    || args.intakeSummary.claims > 0;

  if (forced && nodeEnv === "production") {
    return { allowed: false, allowedReason: "forced_ignored_prod", forced: true };
  }
  if (requestForced) return { allowed: true, allowedReason: "forced_request", forced: true };
  if (envForced) return { allowed: true, allowedReason: "forced_env", forced: true };
  if (allowIntent) return { allowed: true, allowedReason: "intent_detected", forced: false };
  return { allowed: false, allowedReason: "no_intent", forced: false };
}

type OutputEnvelopeMetadata = {
  kind: "output_envelope";
  ok: boolean;
  attempt: 0 | 1;
  rawLength: number;
  reason?: "invalid_json" | "schema_invalid" | "payload_too_large";
  errorSummary?: string;
  issuesCount?: number;
  issues?: Array<{ path: string; code: string; message: string }>;
};

function buildOutputEnvelopeMetadata(args: {
  attempt: 0 | 1;
  ok: boolean;
  rawLength: number;
  reason?: "invalid_json" | "schema_invalid" | "payload_too_large";
  issuesCount?: number;
  issues?: Array<{ path: string; code: string; message: string }>;
  error?: unknown;
}): OutputEnvelopeMetadata {
  const errorSummary = args.error ? String(args.error).slice(0, 200) : undefined;
  return {
    kind: "output_envelope",
    ok: args.ok,
    attempt: args.attempt,
    rawLength: args.rawLength,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(errorSummary ? { errorSummary } : {}),
    ...(typeof args.issuesCount === "number" ? { issuesCount: args.issuesCount } : {}),
    ...(args.issues ? { issues: args.issues } : {}),
  };
}

function summarizeZodIssues(issues: Array<{ path: PropertyKey[]; code: string; message: string }>) {
  return issues.slice(0, 10).map((issue) => ({
    path: issue.path
      .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
      .join("."),
    code: issue.code,
    message: issue.message,
  }));
}

function buildCorrectionText(violations: PostLinterViolation[], driverBlocks: Array<{ id: string; title?: string }>): string {
  if (violations.length == 0) return "";

  const blockTitles = new Map(driverBlocks.map((b) => [b.id, b.title]));
  const uniqueBlocks: string[] = [];
  for (const v of violations) {
    if (!uniqueBlocks.includes(v.blockId)) {
      uniqueBlocks.push(v.blockId);
    }
  }

  const header = "CORRECTION (Attempt 1)";
  const blockLines = uniqueBlocks.map((id) => {
    const title = blockTitles.get(id);
    return title ? `- ${id} ${title}` : `- ${id}`;
  });

  const ruleLines = violations.slice(0, 6).map((v) => {
    if (v.rule === "must-not") {
      return `- Avoid: "${v.pattern}"`;
    }
    if (v.rule === "must-have-any") {
      return `- Include one of: "${v.pattern}"`;
    }
    return `- Include: "${v.pattern}"`;
  });

  return [
    header,
    "Your previous response violated Driver Blocks:",
    ...blockLines,
    "Rewrite to comply:",
    ...ruleLines,
    "Return only the corrected response.",
  ].join("\n");
}

function buildEnforcementStub(): string {
  return [
    "I can't claim to have performed external actions.",
    "Here is a safe alternative you can execute:",
    "- Draft: Provide the message you want to send.",
    "- Steps: Review the draft, then send it using your preferred tool.",
  ].join("\n");
}

function buildOutputContractStub(reason: "output_contract" | "evidence_gate" = "output_contract"): string {
  const missing =
    reason === "evidence_gate"
      ? "I couldn't validate the evidence references for this response."
      : "I couldn't validate the model response against the output contract.";
  return [
    `Missing info: ${missing}`,
    "Provisional: I can retry with a stricter output format if you'd like.",
    "Question: Want me to retry, or can you rephrase your request?",
  ].join("\n");
}

function formatOutputContractError(
  reason: "invalid_json" | "schema_invalid" | "payload_too_large",
  issuesCount?: number
): string {
  if (reason === "invalid_json") return "output_contract_failed:invalid_json";
  if (reason === "payload_too_large") return "output_contract_failed:payload_too_large";
  const count = typeof issuesCount === "number" ? issuesCount : 0;
  return `output_contract_failed:schema_invalid:issues=${count}`;
}

function applyEvidenceMeta(
  envelope: OutputEnvelope,
  evidencePack: EvidencePack | null,
  transmissionId: string
): OutputEnvelope {
  const claims = extractClaims(envelope);
  if (!envelope.meta && claims.length === 0 && !evidencePack) return envelope;

  const meta = { ...(envelope.meta ?? {}) };
  if (claims.length > 0) {
    meta.used_evidence_ids = deriveUsedEvidenceIds(claims);
  } else {
    delete meta.used_evidence_ids;
  }
  if (evidencePack) {
    meta.evidence_pack_id = evidencePack.packId;
  } else {
    delete meta.evidence_pack_id;
  }
  meta.meta_version = "v1";
  if (meta.capture_suggestion) {
    meta.capture_suggestion = {
      ...meta.capture_suggestion,
      suggestion_id: `cap_${transmissionId}`,
    };
  }

  return { ...envelope, meta };
}

function normalizeOutputEnvelopeForValidation(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const envelope = { ...(payload as Record<string, any>) };
  const meta = envelope.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return envelope;
  }

  const normalizedMeta: Record<string, any> = { ...meta };
  const ghostType = normalizedMeta.ghost_type ?? normalizedMeta.ghostType;
  const ghostKind = normalizedMeta.ghost_kind ?? normalizedMeta.ghostKind;

  if (!ghostKind && typeof ghostType === "string") {
    const mapping: Record<string, string> = {
      memory: "memory_artifact",
      journal: "journal_moment",
      action: "action_proposal",
    };
    const mapped = mapping[ghostType];
    if (mapped) {
      normalizedMeta.ghost_kind = mapped;
    }
  }

  if (normalizedMeta.ghost_kind === undefined && normalizedMeta.ghostKind !== undefined) {
    normalizedMeta.ghost_kind = normalizedMeta.ghostKind;
  }

  delete normalizedMeta.ghost_type;
  delete normalizedMeta.ghostType;
  delete normalizedMeta.ghostKind;

  envelope.meta = normalizedMeta;
  return envelope;
}

function repairOutputEnvelopeForValidation(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const envelope = { ...(payload as Record<string, any>) };
  const meta = envelope.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return envelope;
  }

  const repaired: Record<string, any> = { ...meta };
  if (repaired.meta_version === undefined && repaired.metaVersion !== undefined) {
    repaired.meta_version = repaired.metaVersion;
  }
  if (repaired.meta_version === undefined) {
    repaired.meta_version = "v1";
  }

  delete repaired.metaVersion;

  envelope.meta = repaired;
  return envelope;
}

function normalizeOutputEnvelopeForResponse(envelope: OutputEnvelope): OutputEnvelope {
  if (!envelope.meta) return envelope;

  const meta: Partial<OutputEnvelope["meta"]> = {};
  if (envelope.meta.meta_version !== undefined) {
    meta.meta_version = envelope.meta.meta_version;
  }
  if (envelope.meta.claims !== undefined) {
    meta.claims = envelope.meta.claims;
  }
  if (envelope.meta.used_evidence_ids !== undefined) {
    meta.used_evidence_ids = envelope.meta.used_evidence_ids;
  }
  if (envelope.meta.evidence_pack_id !== undefined) {
    meta.evidence_pack_id = envelope.meta.evidence_pack_id;
  }
  if (envelope.meta.capture_suggestion !== undefined) {
    meta.capture_suggestion = envelope.meta.capture_suggestion;
  }
  if (envelope.meta.shape !== undefined) {
    meta.shape = envelope.meta.shape;
  }
  if (envelope.meta.affect_signal !== undefined) {
    meta.affect_signal = envelope.meta.affect_signal;
  }
  if (envelope.meta.librarian_gate !== undefined) {
    meta.librarian_gate = envelope.meta.librarian_gate;
  }
  if (envelope.meta.lattice !== undefined) {
    meta.lattice = envelope.meta.lattice;
  }
  if (envelope.meta.journalOffer !== undefined) {
    meta.journalOffer = envelope.meta.journalOffer;
  } else if (envelope.meta.journal_offer !== undefined) {
    meta.journalOffer = envelope.meta.journal_offer;
  }

  if (Object.keys(meta).length > 0 && meta.meta_version === undefined) {
    meta.meta_version = "v1";
  }

  return Object.keys(meta).length > 0
    ? { ...envelope, meta: meta as OutputEnvelope["meta"] }
    : { ...envelope, meta: undefined };
}
function buildEvidenceGateFailureResponse(args: {
  code: EvidenceGateErrorCode;
  transmissionId: string;
  traceRunId?: string;
}): {
  error: EvidenceGateErrorCode;
  transmissionId: string;
  traceRunId?: string;
  retryable: false;
  assistant: string;
} {
  return {
    error: args.code,
    transmissionId: args.transmissionId,
    ...(args.traceRunId ? { traceRunId: args.traceRunId } : {}),
    retryable: false,
    assistant: buildOutputContractStub("evidence_gate"),
  };
}

export async function runOrchestrationPipeline(args: {
  store: ControlPlaneStore;
  request: OrchestrationRequest;
  transmission: Transmission;
  modeDecision: ModeDecision;
  traceRun: TraceRun;
  simulateStatus?: string;
  req?: any;
  log: {
    child: (bindings: Record<string, any>) => any;
    debug: (obj: any, msg?: string) => void;
    info: (obj: any, msg?: string) => void;
    warn: (obj: any, msg?: string) => void;
    error: (obj: any, msg?: string) => void;
  };
  pendingCompletions?: Set<string>;
  allowAsyncSimulation?: boolean;
}): Promise<{ statusCode: number; body: any }> {
  const {
    store,
    request,
    transmission,
    modeDecision,
    traceRun,
    simulateStatus = "",
    req,
    log: baseLog,
    pendingCompletions,
    allowAsyncSimulation = false,
  } = args;
  const packet = request.packet;
  const userId = request.userId;
  const transmissionSubject = buildTransmissionSubject({
    transmissionId: transmission.id,
    threadId: packet.threadId,
    clientRequestId: packet.clientRequestId,
  });
  const simulate = simulateStatus;
  const requestStartNs = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - requestStartNs) / 1e6;
  const logResponded = (statusCode: number, attemptsUsed: number) => {
    log.info(
      {
        evt: "chat.responded",
        statusCode,
        attemptsUsed,
        totalMs: Math.round(elapsedMs()),
      },
      "chat.responded"
    );
  };

  const effectiveForcedPersona = request.forcedPersona ?? transmission.forcedPersona ?? null;
  const personaLabel = resolvePersonaLabel(modeDecision);
  const requestedNotificationPolicy = transmission.notificationPolicy ?? packet.notification_policy;
  let resolvedNotificationPolicy = resolveNotificationPolicy({
    source: request.source,
    simulate: request.simulate === true,
    requestedPolicy: requestedNotificationPolicy,
    personaLabel,
    safetyIsUrgent: false,
  });

  const persistPolicy = async (notificationPolicy: NotificationPolicy) => {
    const needsPolicy = transmission.notificationPolicy !== notificationPolicy;
    const needsPersona = effectiveForcedPersona && transmission.forcedPersona !== effectiveForcedPersona;
    if (!needsPolicy && !needsPersona) return;

    await store.updateTransmissionPolicy({
      transmissionId: transmission.id,
      notificationPolicy,
      forcedPersona: effectiveForcedPersona ?? undefined,
    });
    transmission.notificationPolicy = notificationPolicy;
    if (effectiveForcedPersona) transmission.forcedPersona = effectiveForcedPersona;
  };

  const attachPolicyFields = (body: Record<string, any>) => ({
    ...body,
    notification_policy: resolvedNotificationPolicy,
    ...(effectiveForcedPersona ? { forced_persona: effectiveForcedPersona } : {}),
  });

  const respond = (statusCode: number, body: Record<string, any>) => ({
    statusCode,
    body: attachPolicyFields(body),
  });

  const publishSseEvent = (args: {
    kind: "run_started" | "assistant_final_ready" | "assistant_failed";
    payload?: Record<string, unknown>;
  }) => {
    if (!userId) return;
    const envelope = buildSSEEnvelope({
      kind: args.kind,
      subject: transmissionSubject,
      traceRunId: traceRun?.id,
      payload: args.payload ?? {},
    });
    sseHub.publishToUser(userId, envelope);
  };

  const emitRunStarted = (args: { provider?: string; model?: string }) => {
    const payload: Record<string, unknown> = {
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.model ? { model: args.model } : {}),
    };
    publishSseEvent({ kind: "run_started", payload });
  };

  const emitAssistantFinalReady = () => {
    publishSseEvent({
      kind: "assistant_final_ready",
      payload: { transmission_status: "completed" },
    });
  };

  const emitAssistantFailed = (args: {
    code: string;
    detail: string;
    retryable: boolean;
    retryAfterMs?: number;
    category?: string;
  }) => {
    const payload: Record<string, unknown> = {
      code: args.code,
      detail: args.detail,
      retryable: args.retryable,
      ...(typeof args.retryAfterMs === "number" ? { retry_after_ms: args.retryAfterMs } : {}),
      ...(args.category ? { category: args.category } : {}),
    };
    publishSseEvent({ kind: "assistant_failed", payload });
  };

  await persistPolicy(resolvedNotificationPolicy);

  const traceLevel = packet.traceConfig?.level ?? "info";
  const enforcementMode = resolveDriverBlockEnforcementMode();
  const postOutputLinterMode: "strict" | "warn" | "off" = isDeterministicTestRetryEnabled(req)
    ? "strict"
    : enforcementMode;

  let traceSeq = 0;
  const appendTrace = async (event: Parameters<typeof store.appendTraceEvent>[0]) => {
    const metadata = { ...(event.metadata ?? {}), seq: traceSeq++ };
    return store.appendTraceEvent({ ...event, metadata });
  };

  const llmProvider = (process.env.LLM_PROVIDER ?? "fake").toLowerCase() === "openai"
    ? "openai"
    : "fake";
  const providerSource = process.env.LLM_PROVIDER ? "env" : "default";
  const apiKeyPresent = Boolean(process.env.OPENAI_API_KEY);

  const modelSelection = selectModel({
    solEnv: process.env.SOL_ENV,
    nodeEnv: process.env.NODE_ENV,
    requestHints: packet.providerHints,
    defaultModel: process.env.OPENAI_MODEL ?? "gpt-5-nano",
  });
  const outputContractRetryEnabled = process.env.OUTPUT_CONTRACT_RETRY_ENABLED === "1";
  const outputContractRetryProvider =
    String(process.env.OUTPUT_CONTRACT_RETRY_MODEL_PROVIDER ?? "openai").toLowerCase();
  const outputContractRetryModel = process.env.OUTPUT_CONTRACT_RETRY_MODEL ?? "gpt-5-mini";
  const outputContractRetryOn = new Set(
    String(process.env.OUTPUT_CONTRACT_RETRY_ON ?? "schema_invalid")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const shouldRetryOutputContract = (reason: "invalid_json" | "schema_invalid" | "payload_too_large") => {
    if (!outputContractRetryEnabled) return false;
    if (outputContractRetryProvider !== llmProvider) return false;
    if (llmProvider !== "openai") return false;
    if (reason === "payload_too_large") return false;
    if (reason === "invalid_json") {
      return outputContractRetryOn.has("invalid_json") || outputContractRetryOn.has("json_parse_failed");
    }
    return outputContractRetryOn.has("schema_invalid");
  };

  const MAX_OUTPUT_ENVELOPE_BYTES = 64 * 1024;

  const getRawByteLength = (text: string): number => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyGlobal: any = globalThis as any;
      if (anyGlobal.Buffer?.byteLength) return anyGlobal.Buffer.byteLength(text, "utf8");
    } catch {}

    try {
      return new TextEncoder().encode(text).length;
    } catch {
      return text.length;
    }
  };

  const parseOutputEnvelope = async (args: {
    rawText: string;
    attempt: 0 | 1;
  }): Promise<
    | { ok: true; envelope: OutputEnvelope }
    | {
        ok: false;
        reason: "invalid_json" | "schema_invalid" | "payload_too_large";
        issuesCount?: number;
        issuesTop3?: Array<{ path: string; code: string; message: string }>;
      }
  > => {
    const rawLength = getRawByteLength(args.rawText);

    if (rawLength > MAX_OUTPUT_ENVELOPE_BYTES) {
      const meta = buildOutputEnvelopeMetadata({
        attempt: args.attempt,
        ok: false,
        rawLength,
        reason: "payload_too_large",
      });

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "failed",
        summary: "Output envelope payload too large",
        metadata: meta,
      });

      return { ok: false, reason: "payload_too_large" };
    }

    let parsed: unknown;
    let strippedMetaKeys: string[] = [];
    try {
      parsed = JSON.parse(args.rawText);
      parsed = normalizeOutputEnvelopeForValidation(parsed);
      parsed = repairOutputEnvelopeForValidation(parsed);
    } catch (error) {
      const meta = buildOutputEnvelopeMetadata({
        attempt: args.attempt,
        ok: false,
        rawLength,
        reason: "invalid_json",
        error,
      });

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "failed",
        summary: "Output envelope invalid JSON",
        metadata: meta,
      });

      return { ok: false, reason: "invalid_json" };
    }

    const rawMeta = (parsed as any)?.meta;
    if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
      strippedMetaKeys = Object.keys(rawMeta).filter(
        (key) => !OUTPUT_ENVELOPE_META_ALLOWED_KEYS.has(key)
      );
    }

    const hasGhostMeta = (() => {
      if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) return false;
      if (rawMeta.display_hint === "ghost_card") return true;
      const ghostKeys = [
        "ghost_kind",
        "ghost_type",
        "memory_id",
        "rigor_level",
        "snippet",
        "fact_null",
        "mood_anchor",
      ];
      return ghostKeys.some((key) => rawMeta[key] !== undefined);
    })();

    const v0MinResult = OutputEnvelopeV0MinSchema.safeParse(parsed);
    if (!v0MinResult.success) {
      const issues = summarizeZodIssues(v0MinResult.error.issues);
      const issuesTop3 = issues.slice(0, 3);
      const meta = buildOutputEnvelopeMetadata({
        attempt: args.attempt,
        ok: false,
        rawLength,
        reason: "schema_invalid",
        issuesCount: v0MinResult.error.issues.length,
        issues,
        error: v0MinResult.error,
      });

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "failed",
        summary: "Output envelope schema invalid (v0-min)",
        metadata: meta,
      });

      return {
        ok: false,
        reason: "schema_invalid",
        issuesCount: v0MinResult.error.issues.length,
        issuesTop3,
      };
    }

    const fullResult = OutputEnvelopeSchema.safeParse(parsed);
    if (hasGhostMeta && !fullResult.success) {
      const issues = summarizeZodIssues(fullResult.error.issues);
      const issuesTop3 = issues.slice(0, 3);
      const meta = buildOutputEnvelopeMetadata({
        attempt: args.attempt,
        ok: false,
        rawLength,
        reason: "schema_invalid",
        issuesCount: fullResult.error.issues.length,
        issues,
        error: fullResult.error,
      });

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "failed",
        summary: "Output envelope schema invalid (full)",
        metadata: meta,
      });

      return {
        ok: false,
        reason: "schema_invalid",
        issuesCount: fullResult.error.issues.length,
        issuesTop3,
      };
    }

    if (!hasGhostMeta && !fullResult.success) {
      const issues = summarizeZodIssues(fullResult.error.issues);
      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "warning",
        summary: "Output envelope schema issues (full)",
        metadata: {
          kind: "output_envelope_schema_warning",
          issuesCount: fullResult.error.issues.length,
          issues,
        },
      });
    }

    if (traceLevel === "debug" && strippedMetaKeys.length > 0) {
      const trimmed = strippedMetaKeys.slice(0, 10);
      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "warning",
        summary: "Output envelope meta keys stripped",
        metadata: {
          kind: "output_envelope_meta_strip",
          strippedCount: strippedMetaKeys.length,
          strippedKeys: trimmed,
        },
      });
    }

    const meta = buildOutputEnvelopeMetadata({
      attempt: args.attempt,
      ok: true,
      rawLength,
    });

    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: "completed",
      summary: "Output envelope validated",
      metadata: meta,
    });

    if (hasGhostMeta && fullResult.success) {
      return { ok: true, envelope: fullResult.data };
    }

    return { ok: true, envelope: v0MinResult.data as OutputEnvelope };
  };

  const runEvidenceOutputGates = async (args: {
    envelope: OutputEnvelope;
    attempt: 0 | 1;
    evidencePack: EvidencePack | null;
    transmissionId: string;
  }): Promise<{ ok: true; envelope: OutputEnvelope } | { ok: false; code: EvidenceGateErrorCode }> => {
    const normalized = applyEvidenceMeta(args.envelope, args.evidencePack, args.transmissionId);
    const claims = extractClaims(normalized);

    const binding = runEvidenceBindingGate(claims, args.evidencePack);
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: binding.ok ? "completed" : "failed",
      summary: binding.ok ? "Evidence binding passed" : "Evidence binding failed",
      metadata: {
        kind: "evidence_binding",
        ok: binding.ok,
        attempt: args.attempt,
        invalidRefsCount: binding.invalidRefsCount,
        ...(binding.reason ? { reason: binding.reason } : {}),
      },
    });

    if (!binding.ok) {
      return {
        ok: false,
        code: binding.reason === "claims_without_evidence"
          ? "claims_without_evidence"
          : "evidence_binding_failed",
      };
    }

    const budget = runEvidenceBudgetGate(normalized, claims, args.evidencePack);
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: budget.ok ? "completed" : "failed",
      summary: budget.ok ? "Evidence budget passed" : "Evidence budget failed",
      metadata: {
        kind: "evidence_budget",
        ok: budget.ok,
        attempt: args.attempt,
        ...(budget.reason ? { reason: budget.reason } : {}),
        limits: budget.limits,
        counts: budget.counts,
        metaBytes: budget.metaBytes,
        evidenceBytes: budget.evidenceBytes,
      },
    });

    if (!budget.ok) {
      return { ok: false, code: "evidence_budget_exceeded" };
    }

    return { ok: true, envelope: normalized };
  };

  const runLibrarianGate = async (args: {
    envelope: OutputEnvelope;
    attempt: 0 | 1;
    evidencePack: EvidencePack | null;
  }): Promise<OutputEnvelope> => {
    const result = applyLibrarianGate({
      envelope: args.envelope,
      evidencePack: args.evidencePack,
    });

    if (!result) {
      return args.envelope;
    }

    const status = result.stats.verdict === "flag" ? "warning" : "completed";

    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status,
      summary: `Librarian gate ${result.stats.verdict}`,
      metadata: {
        kind: "librarian_gate",
        attempt: args.attempt,
        claimCount: result.stats.claimCount,
        refsBefore: result.stats.refsBefore,
        refsAfter: result.stats.refsAfter,
        prunedRefs: result.stats.prunedRefs,
        unsupportedClaims: result.stats.unsupportedClaims,
        supportScore: result.stats.supportScore,
        verdict: result.stats.verdict,
        ...(result.stats.reasonCodes.length > 0
          ? { reasonCodes: result.stats.reasonCodes }
          : {}),
      },
    });

    return result.envelope;
  };

  const shouldCaptureModelIo =
    process.env.TRACE_CAPTURE_MODEL_IO === "1" && process.env.NODE_ENV !== "production";

  const truncatePreview = (value: string, max = 4096) =>
    value.length > max ? value.slice(0, max) : value;

  const runModelAttempt = async (args: {
    attempt: 0 | 1;
    promptPack: PromptPack;
    modeLabel: string;
    evidencePack?: EvidencePack | null;
    forcedRawText?: string;
    modelOverride?: string;
    providerOverride?: "openai" | "fake";
    providerSourceOverride?: "env" | "default" | "retry";
    logger?: {
      debug: (obj: any, msg?: string) => void;
      info?: (obj: any, msg?: string) => void;
      warn?: (obj: any, msg?: string) => void;
      error?: (obj: any, msg?: string) => void;
    };
  }) => {
    const providerUsed = args.providerOverride ?? llmProvider;
    const modelUsed = args.modelOverride ?? modelSelection.model;
    const providerSourceUsed = args.providerSourceOverride ?? providerSource;

    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "model",
      phase: "model_call",
      status: "started",
      summary: `Calling model provider (Attempt ${args.attempt})`,
      metadata: {
        attempt: args.attempt,
        provider: providerUsed,
        model: modelUsed,
        source: providerSourceUsed,
      },
    });

    if (args.logger?.info) {
      args.logger.info(
        {
          evt: "llm.provider.used",
          provider: providerUsed,
          model: modelUsed,
          source: providerSourceUsed,
        },
        "llm.provider.used"
      );
    }

    const modelCallStartNs = process.hrtime.bigint();
    args.logger?.info?.(
      {
        evt: "model_call.start",
        attempt: args.attempt,
        provider: providerUsed,
        model: modelUsed,
      },
      "model_call.start"
    );

    if (args.attempt === 0) {
      emitRunStarted({ provider: providerUsed, model: modelUsed });
    }

    const providerInputText = toSinglePromptText(args.promptPack);
    const meta = providerUsed === "openai"
      ? await openAIModelReplyWithMeta({
          promptText: providerInputText,
          modeLabel: args.modeLabel,
          model: modelUsed,
          logger: args.logger,
        })
      : await fakeModelReplyWithMeta({
          userText: providerInputText,
          modeLabel: args.modeLabel,
          evidencePack: args.evidencePack,
        });

    const rawText = args.forcedRawText ?? meta.rawText;
    const promptPreview = shouldCaptureModelIo ? truncatePreview(providerInputText) : undefined;
    const responsePreview = shouldCaptureModelIo ? truncatePreview(rawText) : undefined;
    const modelCallDurationMs = Number(process.hrtime.bigint() - modelCallStartNs) / 1e6;

    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "model",
      phase: "model_call",
      status: "completed",
      summary: `Model response received (Attempt ${args.attempt})`,
      metadata: {
        attempt: args.attempt,
        outputLength: rawText.length,
        durationMs: Math.round(modelCallDurationMs),
        ...(shouldCaptureModelIo
          ? { prompt_preview: promptPreview, response_preview: responsePreview }
          : {}),
      },
    });

    if (args.logger) {
      args.logger.debug({
        evt: "model_call.completed",
        attempt: args.attempt,
        outputLength: rawText.length,
        durationMs: Math.round(modelCallDurationMs),
      }, "model_call.completed");
      if (args.logger.info) {
        args.logger.info({
          evt: "model_call.end",
          attempt: args.attempt,
          provider: providerUsed,
          model: modelUsed,
          durationMs: Math.round(modelCallDurationMs),
          outputLength: rawText.length,
        }, "model_call.end");
      }
    }

    return { rawText, mementoDraft: meta.mementoDraft };
  };

  const shouldAttemptMementoQualityRepair = (quality: MementoQualitySummary): boolean => {
    if (threadContextMode !== "auto") return false;
    if (quality.issues.includes("missing_shape")) return true;
    if (quality.issues.includes("missing_affect_signal")) return true;
    if (hasDecisionOrLockIntent(packet.message) && quality.shapeDecisionsEmpty) return true;
    return false;
  };

  const maybeRepairMementoOutput = async (args: {
    assistant: string;
    envelope: OutputEnvelope;
    promptPack: PromptPack;
    forcedRawText?: string;
    logger?: {
      debug: (obj: any, msg?: string) => void;
      info?: (obj: any, msg?: string) => void;
      warn?: (obj: any, msg?: string) => void;
      error?: (obj: any, msg?: string) => void;
    };
  }): Promise<{
    assistant: string;
    envelope: OutputEnvelope;
    qualityBefore: MementoQualitySummary;
    qualityAfter: MementoQualitySummary;
    repairResolution: "none" | "retry";
  }> => {
    const qualityBefore = evaluateMementoQuality(args.envelope);
    let assistantCandidate = args.assistant;
    let envelopeCandidate = args.envelope;
    let repairResolution: "none" | "retry" = "none";

    if (!shouldAttemptMementoQualityRepair(qualityBefore)) {
      return {
        assistant: assistantCandidate,
        envelope: envelopeCandidate,
        qualityBefore,
        qualityAfter: qualityBefore,
        repairResolution,
      };
    }

    const correctionText = buildMementoRepairCorrection({
      issues: qualityBefore.issues,
      decisionIntent: hasDecisionOrLockIntent(packet.message),
    });
    const repairPromptPack = withCorrectionSection(args.promptPack, correctionText);
    const repairAttempt = await runModelAttempt({
      attempt: 1,
      promptPack: repairPromptPack,
      modeLabel: modeDecision.modeLabel,
      evidencePack,
      forcedRawText: args.forcedRawText,
      logger: args.logger,
    });

    const repairEnvelope = await parseOutputEnvelope({
      rawText: repairAttempt.rawText,
      attempt: 1,
    });

    if (repairEnvelope.ok) {
      const repairLibrarian = await runLibrarianGate({
        envelope: repairEnvelope.envelope,
        attempt: 1,
        evidencePack,
      });

      const repairEvidence = await runEvidenceOutputGates({
        envelope: repairLibrarian,
        attempt: 1,
        evidencePack,
        transmissionId: transmission.id,
      });

      if (repairEvidence.ok) {
        const repairAssistant = repairEvidence.envelope.assistant_text;
        const repairLint = postOutputLinter({
          modeDecision,
          content: repairAssistant,
          driverBlocks: repairPromptPack.driverBlocks,
          enforcementMode: postOutputLinterMode,
        });

        if (repairLint.ok) {
          assistantCandidate = repairAssistant;
          envelopeCandidate = normalizeOutputEnvelopeForResponse(repairEvidence.envelope);
          repairResolution = "retry";
        } else {
          args.logger?.warn?.(
            {
              evt: "memento_quality.repair_lint_failed",
              violationsCount: collectPostLinterViolations(repairLint).length,
            },
            "memento_quality.repair_lint_failed"
          );
        }
      } else {
        args.logger?.warn?.(
          { evt: "memento_quality.repair_evidence_failed", code: repairEvidence.code },
          "memento_quality.repair_evidence_failed"
        );
      }
    } else {
      args.logger?.warn?.(
        { evt: "memento_quality.repair_output_invalid", reason: repairEnvelope.reason },
        "memento_quality.repair_output_invalid"
      );
    }

    return {
      assistant: assistantCandidate,
      envelope: envelopeCandidate,
      qualityBefore,
      qualityAfter: evaluateMementoQuality(envelopeCandidate),
      repairResolution,
    };
  };

  const appendMementoQualityTrace = async (args: {
    qualityBefore: MementoQualitySummary;
    qualityAfter: MementoQualitySummary;
    shapeSource: MementoShapeSource;
    resolvedBy: MementoQualityResolution;
    effectiveDecisionsCount: number;
    logger?: {
      debug?: (obj: any, msg?: string) => void;
    };
  }) => {
    if (traceLevel === "debug") {
      args.logger?.debug?.({
        evt: "memento_quality.summary",
        shape_present: args.qualityAfter.shapePresent,
        shape_decisions_count: args.qualityAfter.shapeDecisionsCount,
        shape_decisions_empty: args.qualityAfter.shapeDecisionsEmpty,
        affect_signal_present: args.qualityAfter.affectSignalPresent,
        affect_signal_label: args.qualityAfter.affectSignalLabel,
        affect_signal_intensity: args.qualityAfter.affectSignalIntensity,
        affect_signal_confidence: args.qualityAfter.affectSignalConfidence,
        shape_source: args.shapeSource,
        resolved_by: args.resolvedBy,
        request_memento_source: requestThreadMementoSource ?? "stored_latest",
        effective_decisions_count: args.effectiveDecisionsCount,
        issues_before: args.qualityBefore.issues,
        issues_after: args.qualityAfter.issues,
      }, "memento_quality.summary");
    }
    if (traceLevel !== "debug") return;
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "memento_quality",
      status: "completed",
      summary: "Thread memento quality",
      metadata: {
        kind: "memento_quality",
        shape_present: args.qualityAfter.shapePresent,
        shape_decisions_count: args.qualityAfter.shapeDecisionsCount,
        shape_decisions_empty: args.qualityAfter.shapeDecisionsEmpty,
        affect_signal_present: args.qualityAfter.affectSignalPresent,
        affect_signal_label: args.qualityAfter.affectSignalLabel,
        affect_signal_intensity: args.qualityAfter.affectSignalIntensity,
        affect_signal_confidence: args.qualityAfter.affectSignalConfidence,
        shape_source: args.shapeSource,
        resolved_by: args.resolvedBy,
        request_memento_source: requestThreadMementoSource ?? "stored_latest",
        issues_before: args.qualityBefore.issues,
        issues_after: args.qualityAfter.issues,
        effective_decisions_count: args.effectiveDecisionsCount,
      },
    });
  };

  // Route-scoped logger for control-plane tracing (keeps logs searchable).
  const log = baseLog.child({
    plane: "chat",
    transmissionId: transmission.id,
    threadId: packet.threadId,
    clientRequestId: packet.clientRequestId ?? undefined,
    modeLabel: modeDecision?.modeLabel ?? undefined,
    traceRunId: traceRun.id,
  });

  if (llmProvider === "openai" && !apiKeyPresent) {
    await store.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider: llmProvider,
      status: "failed",
      error: "openai_api_key_missing",
    });

    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode: 500,
      retryable: false,
      errorCode: "openai_api_key_missing",
    });

    emitAssistantFailed({
      code: "INTERNAL_ERROR",
      detail: "Server configuration missing.",
      retryable: false,
      category: "internal",
    });

    logResponded(500, 0);
    return respond(500, {
      error: "openai_api_key_missing",
      transmissionId: transmission.id,
      traceRunId: traceRun.id,
      retryable: false,
    });
  }

  if (llmProvider === "openai" && !process.env.OPENAI_MODEL) {
    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode: 500,
      retryable: false,
      errorCode: "openai_model_missing",
    });

    emitAssistantFailed({
      code: "INTERNAL_ERROR",
      detail: "Server configuration missing.",
      retryable: false,
      category: "internal",
    });

    logResponded(500, 0);
    return respond(500, {
      error: "openai_model_missing",
      transmissionId: transmission.id,
      traceRunId: traceRun.id,
      retryable: false,
    });
  }

  log.debug({
    idempotency: Boolean(packet.clientRequestId),
    status: transmission.status,
    domainFlags: modeDecision?.domainFlags ?? [],
  }, "control_plane.transmission_ready");

  // --- Evidence Intake (PR #7) ---
  // Run evidence intake gate: extract URLs, create auto-captures, validate
  let evidenceIntakeOutput;
  try {
    evidenceIntakeOutput = runEvidenceIntake(packet);
    packet.evidence = evidenceIntakeOutput.evidence;

    // Persist evidence to SQLite (idempotent)
    if (evidenceIntakeOutput.evidence) {
      await store.saveEvidence({
        transmissionId: transmission.id,
        threadId: packet.threadId,
        evidence: evidenceIntakeOutput.evidence,
      });
    }

    const snippetCharTotal = evidenceIntakeOutput.evidence?.supports
      ?.filter((s) => s.type === "text_snippet" && s.snippetText)
      .reduce((sum, s) => sum + (s.snippetText?.length || 0), 0) ?? 0;

    const capturesCount = evidenceIntakeOutput.evidence.captures?.length ?? 0;
    const supportsCount = evidenceIntakeOutput.evidence.supports?.length ?? 0;
    const claimsCount = evidenceIntakeOutput.evidence.claims?.length ?? 0;

    // Trace event: Evidence intake
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "evidence_intake",
      status: "completed",
      summary: `Evidence processed: ${evidenceIntakeOutput.autoCaptures} auto-captures, ${evidenceIntakeOutput.clientCaptures} client-captures`,
      metadata: {
        autoCaptures: evidenceIntakeOutput.autoCaptures,
        clientCaptures: evidenceIntakeOutput.clientCaptures,
        urlsDetectedCount: evidenceIntakeOutput.urlsDetected.length,
        warningsCount: evidenceIntakeOutput.warnings.length,
        captureCount: capturesCount,
        supportCount: supportsCount,
        claimCount: claimsCount,
        snippetCharTotal,
      },
    });

    log.info({
      evt: "evidence.intake.completed",
      capturesCount,
      supportsCount,
      claimsCount,
    }, "evidence.intake.completed");
  } catch (error) {
    // Handle EvidenceValidationError (fail closed with structured 400)
    if (error instanceof EvidenceValidationError) {
      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "evidence_intake",
        status: "failed",
        summary: `Evidence validation failed: ${error.message}`,
        metadata: error.details,
      });

      await store.updateTransmissionStatus({
        transmissionId: transmission.id,
        status: "failed",
        statusCode: 400,
        retryable: false,
        errorCode: error.code,
        errorDetail: error.details,
      });

      emitAssistantFailed({
        code: "INTERNAL_ERROR",
        detail: "Request invalid.",
        retryable: false,
        category: "validation",
      });

      logResponded(400, 0);
      return respond(400, error.toJSON());
    }
    throw error;
  }

  // Trace event: Policy engine (mode routing)
  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "policy_engine",
    status: "completed",
    summary: `Mode routed: ${modeDecision.modeLabel}`,
    metadata: {
      modeLabel: modeDecision.modeLabel,
      personaLabel: resolvePersonaLabel(modeDecision),
      domainFlags: modeDecision.domainFlags,
      confidence: modeDecision.confidence,
      modelSelected: modelSelection.model,
      modelSource: modelSelection.source,
      ...(modelSelection.tier ? { modelTier: modelSelection.tier } : {}),
    },
  });
  log.info({
    evt: "llm.provider.selected",
    provider: llmProvider,
    model: modelSelection.model,
    source: providerSource,
    modelSource: modelSelection.source,
    apiKeyPresent: llmProvider === "openai" ? Boolean(process.env.OPENAI_API_KEY) : undefined,
    personaLabel: resolvePersonaLabel(modeDecision),
    ...(modelSelection.tier ? { tier: modelSelection.tier } : {}),
  }, "llm.provider.selected");

  // Ordering Contract (v0): route-level phase sequence is authoritative.
  // Phases must appear in this order in trace (not necessarily contiguous):
  // evidence_intake → gate_normalize_modality → gate_url_extraction → gate_intent → gate_sentinel → gate_lattice
  // → model_call → output_gates (post_linter + driver_block per-block events).
  // Tests assert this sequence from persisted trace events.
  // Note: metadata.seq is global and monotonic; it is not reset per gate.
  // Run gates pipeline
  const gatesOutput = runGatesPipeline(packet);
  const safetyIsUrgent = resolveSafetyIsUrgent({ results: gatesOutput.results, log });

  const resolvedAfterGates = resolveNotificationPolicy({
    source: request.source,
    simulate: request.simulate === true,
    requestedPolicy: requestedNotificationPolicy,
    personaLabel,
    safetyIsUrgent,
  });
  if (resolvedAfterGates !== resolvedNotificationPolicy) {
    resolvedNotificationPolicy = resolvedAfterGates;
    await persistPolicy(resolvedNotificationPolicy);
  }

  const effectiveEvidence = evidenceIntakeOutput?.evidence ?? packet.evidence ?? null;
  const effectiveWarnings: any[] = evidenceIntakeOutput?.warnings ?? [];

  const evidenceSummary = {
    captures: effectiveEvidence?.captures?.length || 0,
    supports: effectiveEvidence?.supports?.length || 0,
    claims: effectiveEvidence?.claims?.length || 0,
    warnings: effectiveWarnings.length,
  };

  const hasEvidence =
    evidenceSummary.captures > 0 || evidenceSummary.supports > 0 || evidenceSummary.claims > 0;

  const phaseByGateName: Record<
    string,
    "gate_normalize_modality" | "gate_url_extraction" | "gate_intent" | "gate_sentinel" | "gate_lattice"
  > = {
    normalize_modality: "gate_normalize_modality",
    url_extraction: "gate_url_extraction",
    intent: "gate_intent",
    [GATE_SENTINEL]: "gate_sentinel",
    lattice: "gate_lattice",
  };

  const statusByGateStatus: Record<string, "completed" | "failed" | "warning"> = {
    pass: "completed",
    fail: "failed",
    warn: "warning",
  };

  for (const result of gatesOutput.results) {
    const phase = phaseByGateName[result.gateName];
    if (!phase) {
      log.warn({ gateName: result.gateName }, "gate.trace.unknown_gate");
      continue;
    }
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase,
      status: statusByGateStatus[result.status] ?? "completed",
      summary: result.summary,
      metadata: { gateName: result.gateName, ...(result.metadata ?? {}) },
    });
  }

  const gatesOk = gatesOutput.results.every((r) => r.status === "pass");
  log.info({ evt: "gates.completed", gatesOk }, "gates.completed");

  // Dev/testing hook: force a 500 when requested.
  log.info({ evt: "chat.accepted", simulate: Boolean(simulate) }, "chat.accepted");
  if (simulate === "500") {
    await store.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider: llmProvider,
      status: "failed",
      error: "simulated_500",
    });

    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode: 500,
      retryable: true,
      errorCode: "simulated_failure",
    });

    emitAssistantFailed({
      code: "INTERNAL_ERROR",
      detail: "Server error.",
      retryable: true,
      category: "internal",
    });

    logResponded(500, 0);
    return respond(500, {
      error: "simulated_failure",
      transmissionId: transmission.id,
      traceRunId: traceRun.id,
      retryable: true,
    });
  }

  // --- Step 6: Prompt assembly stub (mounted law + retrieval slot) ---
  // We build the PromptPack even when using the fake provider so OpenAI wiring is a swap, not a rewrite.
  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "enrichment_lattice",
    status: "started",
    summary: "Retrieving context",
  });

  const latticeEnabled = process.env.LATTICE_ENABLED === "1";
  const latticeVecEnabled = process.env.LATTICE_VEC_ENABLED === "1";
  const latticeVecQueryEnabled = process.env.LATTICE_VEC_QUERY_ENABLED === "1";
  const latticeVecMaxDistance = process.env.LATTICE_VEC_MAX_DISTANCE
    ? Number(process.env.LATTICE_VEC_MAX_DISTANCE)
    : null;
  const latticePolicyBundlePath = process.env.LATTICE_POLICY_BUNDLE_PATH ?? "";
  const latticeWarnings: string[] = [];
  const latticeQueryTerms = buildLatticeQueryTerms(packet.message);
  const latticeStartNs = process.hrtime.bigint();
  let latticeDbMs = 0;

  const threadContextMode = resolveThreadContextMode(packet);
  if (threadContextMode === "auto") {
    const cachedLatest = getThreadMementoLatestCached(packet.threadId);
    if (!cachedLatest) {
      const persisted = await store.getThreadMementoLatest({ threadId: packet.threadId });
      if (persisted) {
        setThreadMementoLatestCached(persisted as ThreadMementoLatestInternal);
        markThreadMementoLatestPersisted(persisted as ThreadMementoLatestInternal);
      }
    }
  }
  const { memento: requestThreadMemento, source: requestThreadMementoSource } = resolveRequestThreadMemento(
    packet,
    { cachedLatest: getThreadMementoLatestCached(packet.threadId) }
  );

  const baselineThreadMemento = requestThreadMemento ?? getThreadMementoLatestCached(packet.threadId);
  const breakpointDecision = decideBreakpointAction({
    message: packet.message,
    signalKinds: extractBreakpointSignalKinds(packet),
  });
  const peakGuardrailActive = shouldFreezeSummaryAtPeak({
    phase: baselineThreadMemento?.affect?.rollup?.phase,
    intensityBucket: baselineThreadMemento?.affect?.rollup?.intensityBucket,
    decision: breakpointDecision,
  });

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "breakpoint",
    status: "completed",
    summary: `Breakpoint decision: ${breakpointDecision.toUpperCase()}`,
    metadata: {
      kind: "breakpoint_engine",
      decision: breakpointDecision,
      peakGuardrailActive,
      source: requestThreadMementoSource ?? "stored_latest",
    },
  });

  const baseRetrievalItems = await retrieveContext({
    threadId: packet.threadId,
    packetType: packet.packetType,
    message: packet.message,
    threadContextMode,
    requestThreadMemento,
  });

  const MAX_MEMORIES = 6;
  const MAX_ADR_SNIPS = 4;
  const MAX_POLICY_CAPSULES = 4;
  const MAX_TOTAL_BYTES = 8 * 1024;

  let memoryResults: Array<{ id: string; summary: string; score: number; method: "fts5_bm25" | "vec_distance" }> = [];
  if (!latticeEnabled) {
    latticeWarnings.push("lattice_disabled");
  } else if (!request.userId) {
    latticeWarnings.push("lattice_missing_user_id");
  } else {
    if (latticeQueryTerms.length === 0) {
      latticeWarnings.push("lattice_query_empty");
    } else {
      const dbStart = process.hrtime.bigint();
      try {
        const lexical = await store.searchMemoryArtifactsLexical({
          userId: request.userId,
          query: packet.message,
          lifecycleState: "pinned",
          limit: MAX_MEMORIES,
        });
        const dbEnd = process.hrtime.bigint();
        latticeDbMs += Number(dbEnd - dbStart) / 1e6;
        memoryResults = lexical.map((entry) => ({
          id: entry.artifact.id,
          summary: entry.artifact.summary ?? entry.artifact.snippet,
          score: entry.score,
          method: "fts5_bm25",
        }));
      } catch (error) {
        latticeWarnings.push("memory_query_failed");
        log.warn({ evt: "lattice.memory_query_failed", error: String(error) }, "lattice.memory_query_failed");
      }
    }

    if (latticeVecQueryEnabled) {
      if (!latticeVecEnabled) {
        latticeWarnings.push("vec_disabled");
      } else {
        try {
          const embedding = computeLatticeEmbedding(packet.message);
          const vecStart = process.hrtime.bigint();
          const vector = await store.searchMemoryArtifactsVector({
            userId: request.userId,
            embedding,
            lifecycleState: "pinned",
            limit: MAX_MEMORIES,
            maxDistance: Number.isFinite(latticeVecMaxDistance)
              ? (latticeVecMaxDistance as number)
              : null,
          });
          const vecEnd = process.hrtime.bigint();
          latticeDbMs += Number(vecEnd - vecStart) / 1e6;
          if (vector.length > 0) {
            memoryResults = vector.map((entry) => ({
              id: entry.artifact.id,
              summary: entry.artifact.summary ?? entry.artifact.snippet,
              score: entry.score,
              method: "vec_distance",
            }));
          }
        } catch (error) {
          const message = String(error ?? "");
          const isLoadFailure = message.includes("vec_extension_not_loaded");
          latticeWarnings.push(isLoadFailure ? "vec_load_failed" : "vec_query_failed");
          log.warn(
            { evt: "lattice.vec_query_failed", error: message },
            "lattice.vec_query_failed"
          );
        }
      }
    }
  }

  let policyCapsules: PolicyCapsule[] = [];
  if (latticeEnabled && shouldRetrievePolicy({
    risk: gatesOutput.sentinel.risk,
    intent: gatesOutput.intent.intent,
    message: packet.message,
  })) {
    if (!latticePolicyBundlePath) {
      latticeWarnings.push("policy_bundle_missing");
    } else {
      const { capsules, warning } = loadPolicyCapsules(latticePolicyBundlePath, log);
      policyCapsules = capsules;
      if (warning) latticeWarnings.push(warning);
    }
  }

  const policyMatches: Array<{ capsule: PolicyCapsule; score: number }> = [];
  if (policyCapsules.length > 0 && latticeQueryTerms.length > 0) {
    for (const capsule of policyCapsules) {
      const haystack = [
        capsule.title ?? "",
        capsule.snippet ?? "",
        ...(capsule.tags ?? []),
      ].join(" ").toLowerCase();
      let score = 0;
      for (const term of latticeQueryTerms) {
        if (haystack.includes(term)) score += 1;
      }
      if (score > 0) {
        policyMatches.push({ capsule, score });
      }
    }
  }

  policyMatches.sort((a, b) => b.score - a.score);

  const adrCapsules: PolicyCapsule[] = [];
  const policyOnlyCapsules: PolicyCapsule[] = [];
  for (const match of policyMatches) {
    if (match.capsule.id.toUpperCase().startsWith("ADR-")) {
      adrCapsules.push(match.capsule);
    } else {
      policyOnlyCapsules.push(match.capsule);
    }
  }

  const selectedAdrCapsules = adrCapsules.slice(0, MAX_ADR_SNIPS);
  const selectedPolicyCapsules = policyOnlyCapsules.slice(0, MAX_POLICY_CAPSULES);
  const selectedCapsules = [...selectedAdrCapsules, ...selectedPolicyCapsules];

  const memoryItems = memoryResults.slice(0, MAX_MEMORIES).map((hit) => ({
    id: hit.id,
    kind: "memory" as const,
    summary: hit.summary,
  }));

  const policyItems = selectedCapsules.map((capsule) => {
    const snippet = capsule.max_bytes
      ? truncateByBytes(capsule.snippet, capsule.max_bytes)
      : capsule.snippet;
    const prefix = capsule.title ? `${capsule.title}: ` : "";
    return {
      id: capsule.id,
      kind: "policy" as const,
      summary: `${prefix}${snippet}`,
    };
  });

  const retrievalItems: typeof baseRetrievalItems = [];
  const estimateBytes = (item: { id: string; kind: string; summary: string }) =>
    Buffer.byteLength(`[${item.kind}:${item.id}] ${item.summary}`, "utf8");

  let bytesTotal = 0;
  let hitCap = false;
  const addItemsWithCap = (items: Array<{ id: string; kind: string; summary: string }>) => {
    for (const item of items) {
      if (hitCap) break;
      const nextBytes = bytesTotal + estimateBytes(item);
      if (nextBytes > MAX_TOTAL_BYTES) {
        latticeWarnings.push("lattice_bytes_capped");
        hitCap = true;
        break;
      }
      bytesTotal = nextBytes;
      retrievalItems.push(item as any);
    }
  };

  addItemsWithCap(memoryItems);
  addItemsWithCap(policyItems);
  addItemsWithCap(baseRetrievalItems);

  log.debug(retrievalLogShape(retrievalItems), "control_plane.retrieval");

  const latticeEndNs = process.hrtime.bigint();
  const latticeTotalMs = Number(latticeEndNs - latticeStartNs) / 1e6;

  const usedMemoryIds = retrievalItems.filter((item) => item.kind === "memory").map((item) => item.id);
  const usedPolicyIds = retrievalItems.filter((item) => item.kind === "policy").map((item) => item.id);
  const usedMementoIds = retrievalItems
    .filter((item) => item.kind === "memento" || item.kind === "bookmark")
    .map((item) => item.id);

  const adrHits = usedPolicyIds.filter((id) => id.toUpperCase().startsWith("ADR-")).length;
  const policyHits = usedPolicyIds.length - adrHits;
  const latticeWarningsUnique = Array.from(new Set(latticeWarnings));

  const latticeHasHits =
    usedMemoryIds.length + usedPolicyIds.length + usedMementoIds.length > 0;
  const latticeStatus = latticeWarningsUnique.includes("memory_query_failed")
    ? "fail"
    : (latticeHasHits ? "hit" : "miss");

  const memoryScoreMap = new Map<string, { method: "fts5_bm25" | "vec_distance"; value: number }>();
  for (const hit of memoryResults) {
    if (!Number.isFinite(hit.score)) continue;
    memoryScoreMap.set(hit.id, { method: hit.method, value: hit.score });
  }

  const latticeScores: Record<string, { method: "fts5_bm25" | "vec_distance"; value: number }> = {};
  for (const id of usedMemoryIds) {
    const entry = memoryScoreMap.get(id);
    if (entry) latticeScores[id] = entry;
  }

  const latticeMetaBase = {
    status: latticeStatus as "hit" | "miss" | "fail",
    retrieval_trace: {
      memory_ids: usedMemoryIds,
      memento_ids: usedMementoIds,
      policy_capsule_ids: usedPolicyIds,
    },
    counts: {
      memories: usedMemoryIds.length,
      mementos: usedMementoIds.length,
      policy_capsules: usedPolicyIds.length,
    },
    bytes_total: Math.round(bytesTotal),
    ...(Object.keys(latticeScores).length > 0 ? { scores: latticeScores } : {}),
    ...(latticeWarningsUnique.length > 0 ? { warnings: latticeWarningsUnique } : {}),
  };

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "gate_lattice",
    status: latticeWarningsUnique.includes("memory_query_failed") ? "warning" : "completed",
    summary: "Lattice retrieval",
    metadata: {
      memory_hits: usedMemoryIds.length,
      adr_hits: adrHits,
      policy_hits: policyHits,
      bytes_total: bytesTotal,
      query_terms_count: latticeQueryTerms.length,
    },
  });

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "enrichment_lattice",
    status: "completed",
    summary: `Retrieved ${retrievalItems.length} context items`,
    metadata: {
      itemCount: retrievalItems.length,
      memoryHits: usedMemoryIds.length,
      policyHits,
      bytesTotal: bytesTotal,
    },
  });

  const evidenceDecision = resolveEvidenceProviderDecision({
    intakeSummary: evidenceSummary,
    traceConfig: packet.traceConfig,
    nodeEnv: process.env.NODE_ENV,
    env: process.env,
  });
  const allowEvidencePack = evidenceDecision.allowed;
  const evidenceProviderName = (process.env.EVIDENCE_PROVIDER ?? "stub").toLowerCase();
  const evidenceProvider = selectEvidenceProvider();
  let evidencePack: EvidencePack | null = null;
  try {
    if (allowEvidencePack) {
      evidencePack = await evidenceProvider.getEvidencePack({
        threadId: packet.threadId,
        query: packet.message,
        modeLabel: modeDecision.modeLabel,
      });
      if (evidencePack) validateEvidencePack(evidencePack);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = error instanceof EvidenceProviderError
      ? "evidence_provider_contract_failed"
      : "evidence_provider_failed";

    await store.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider: llmProvider,
      status: "failed",
      error: errorCode,
    });

    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode: 500,
      retryable: true,
      errorCode,
    });

    emitAssistantFailed({
      code: "INTERNAL_ERROR",
      detail: "Server error.",
      retryable: true,
      category: "internal",
    });

    log.error({ error: message, errorCode }, "evidence_provider.failed");
    logResponded(500, 0);
    return respond(500, {
      error: "evidence_provider_failed",
      transmissionId: transmission.id,
      traceRunId: traceRun.id,
      retryable: true,
    });
  }

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "output_gates",
    status: "completed",
    summary: "Evidence provider resolved",
    metadata: {
      kind: "evidence_provider",
      provider: allowEvidencePack ? evidenceProviderName : "skipped",
      allowed: allowEvidencePack,
      allowed_reason: evidenceDecision.allowedReason,
      forced: evidenceDecision.forced,
      packId: evidencePack?.packId,
      itemCount: evidencePack?.items.length ?? 0,
    },
  });

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "compose_request",
    status: "started",
    summary: "Building prompt pack",
  });

  const promptPack = buildPromptPack({
    packet,
    modeDecision,
    retrievalItems,
    evidencePack,
  });

  log.debug(promptPackLogShape(promptPack), "control_plane.prompt_pack");
  log.info({
    evt: "prompt_pack.built",
    driverBlocksCount: promptPack.driverBlocks.length,
    retrievalCount: retrievalItems.length,
  }, "prompt_pack.built");

  // Provider input for v0: one stable string with headers.
  // We do not log the content here.
  const providerInputText = toSinglePromptText(promptPack);

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "compose_request",
    status: "completed",
    summary: "Prompt pack assembled",
    metadata: {
      inputLength: providerInputText.length,
      driverBlocksAccepted: promptPack.driverBlocks.length,
      driverBlocksDropped: promptPack.driverBlockEnforcement.dropped.length,
      driverBlocksTrimmed: promptPack.driverBlockEnforcement.trimmed.length,
    },
  });

  const driverBlockSummary = {
    baselineCount: promptPack.driverBlocks.filter((b) => b.source === "system_baseline").length,
    acceptedCount: promptPack.driverBlocks.length,
    droppedCount: promptPack.driverBlockEnforcement.dropped.length,
    trimmedCount: promptPack.driverBlockEnforcement.trimmed.length,
  };

  // Trace event: Driver Blocks enforcement (if any blocks were dropped or trimmed)
  if (promptPack.driverBlockEnforcement.dropped.length > 0 || promptPack.driverBlockEnforcement.trimmed.length > 0) {
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "compose_request",
      status: "warning",
      summary: `Driver Blocks enforcement: ${promptPack.driverBlockEnforcement.dropped.length} dropped, ${promptPack.driverBlockEnforcement.trimmed.length} trimmed`,
      metadata: {
        dropped: promptPack.driverBlockEnforcement.dropped,
        trimmed: promptPack.driverBlockEnforcement.trimmed,
      },
    });
  }

  // Dev/testing hook: simulate an accepted-but-pending response (202) that COMPLETES shortly after.
  if (allowAsyncSimulation && simulate === "202" && pendingCompletions) {
    const transmissionId = transmission.id;

    if (!pendingCompletions.has(transmissionId)) {
      pendingCompletions.add(transmissionId);

      const bgLog = log.child({
        async: true,
      });

      bgLog.info({ evt: "chat.async.started" }, "chat.async.started");

      // Small fixed delay is enough for v0 testing. We'll replace with real async provider later.
      const delayMs = 750;

      setTimeout(async () => {
        try {
          const current = await store.getTransmission(transmissionId);
          if (!current) {
            bgLog.warn({ status: "missing" }, "delivery.async.skip");
            return;
          }

          // If already terminal, don't double-complete.
          if (current.status !== "created" && current.status !== "processing") {
            bgLog.info({ status: current.status }, "delivery.async.skip");
            return;
          }

          const attempt0Output = getForcedTestProviderOutput(req, 0);
          const attempt1Output = getForcedTestProviderOutput(req, 1);

          const attempt0 = await runModelAttempt({
            attempt: 0,
            promptPack,
            modeLabel: modeDecision.modeLabel,
            evidencePack,
            forcedRawText: attempt0Output,
            logger: bgLog,
          });

          let contractRetryUsed = false;
          let envelopeAttempt: 0 | 1 = 0;
          let envelope0 = await parseOutputEnvelope({
            rawText: attempt0.rawText,
            attempt: 0,
          });

          if (envelope0.ok) {
            bgLog.debug({
              evt: "output_envelope.completed",
              attempt: 0,
              rawLength: attempt0.rawText.length,
            }, "output_envelope.completed");
          } else {
            bgLog.info({
              evt: "output_envelope.failed",
              attempt: 0,
              reason: envelope0.reason,
              rawLength: attempt0.rawText.length,
              ...(typeof envelope0.issuesCount === "number" ? { issuesCount: envelope0.issuesCount } : {}),
              ...(envelope0.issuesTop3 ? { issuesTop3: envelope0.issuesTop3 } : {}),
            }, "output_envelope.failed");
          }

          if (!envelope0.ok && shouldRetryOutputContract(envelope0.reason)) {
            contractRetryUsed = true;
            envelopeAttempt = 1;
            bgLog.info({
              evt: "output_contract.retry",
              reason: envelope0.reason,
              fromModel: modelSelection.model,
              toModel: outputContractRetryModel,
            }, "output_contract.retry");

            await appendTrace({
              traceRunId: traceRun.id,
              transmissionId: transmission.id,
              actor: "solserver",
              phase: "model_call",
              status: "warning",
              summary: "Output contract retry",
              metadata: {
                kind: "output_contract_retry",
                reason: envelope0.reason,
                fromModel: modelSelection.model,
                toModel: outputContractRetryModel,
              },
            });

            const retryAttempt = await runModelAttempt({
              attempt: 1,
              promptPack,
              modeLabel: modeDecision.modeLabel,
              evidencePack,
              forcedRawText: attempt1Output,
              modelOverride: outputContractRetryModel,
              providerOverride: outputContractRetryProvider === "openai" ? "openai" : "fake",
              providerSourceOverride: "retry",
              logger: bgLog,
            });

            envelope0 = await parseOutputEnvelope({
              rawText: retryAttempt.rawText,
              attempt: 1,
            });

            if (envelope0.ok) {
              bgLog.debug({
                evt: "output_envelope.completed",
                attempt: 1,
                rawLength: retryAttempt.rawText.length,
              }, "output_envelope.completed");
            } else {
              bgLog.info({
                evt: "output_envelope.failed",
                attempt: 1,
                reason: envelope0.reason,
                rawLength: retryAttempt.rawText.length,
                ...(typeof envelope0.issuesCount === "number" ? { issuesCount: envelope0.issuesCount } : {}),
                ...(envelope0.issuesTop3 ? { issuesTop3: envelope0.issuesTop3 } : {}),
              }, "output_envelope.failed");
            }
          }

          if (!envelope0.ok) {
            const stubAssistant = buildOutputContractStub();
            const errorCode = formatOutputContractError(envelope0.reason, envelope0.issuesCount);

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "failed",
              error: errorCode,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
              statusCode: 422,
              retryable: false,
              errorCode,
            });

            await store.setChatResult({ transmissionId, assistant: stubAssistant });

            emitAssistantFailed({
              code: "OUTPUT_ENVELOPE_INVALID",
              detail: "Output envelope invalid.",
              retryable: false,
              category: "gates",
            });

            bgLog.info({
              evt: "simulate.persisted_failure",
              statusCode: 422,
              errorCode,
            }, "simulate.persisted_failure");
            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed", reason: envelope0.reason }, "delivery.failed_async");
            return;
          }

          const librarianEnvelope0 = await runLibrarianGate({
            envelope: envelope0.envelope,
            attempt: envelopeAttempt,
            evidencePack,
          });

          const evidenceGate0 = await runEvidenceOutputGates({
            envelope: librarianEnvelope0,
            attempt: envelopeAttempt,
            evidencePack,
            transmissionId,
          });

          if (!evidenceGate0.ok) {
            const stubAssistant = buildOutputContractStub("evidence_gate");

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "failed",
              error: evidenceGate0.code,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
              statusCode: 422,
              retryable: false,
              errorCode: evidenceGate0.code,
            });

            await store.setChatResult({ transmissionId, assistant: stubAssistant });

            emitAssistantFailed({
              code: "OUTPUT_ENVELOPE_INVALID",
              detail: "Output failed evidence gates.",
              retryable: false,
              category: "gates",
            });

            bgLog.info({
              evt: "simulate.persisted_failure",
              statusCode: 422,
              errorCode: evidenceGate0.code,
            }, "simulate.persisted_failure");
            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed", reason: evidenceGate0.code }, "delivery.failed_async");
            return;
          }

          const assistant0 = evidenceGate0.envelope.assistant_text;
          const envelope0Normalized = normalizeOutputEnvelopeForResponse(evidenceGate0.envelope);

          await appendTrace({
            traceRunId: traceRun.id,
            transmissionId: transmission.id,
            actor: "solserver",
            phase: "output_gates",
            status: "started",
            summary: "Running output linter",
            metadata: { kind: "post_linter", attempt: envelopeAttempt },
          });

          const lint0 = postOutputLinter({
            modeDecision,
            content: assistant0,
            driverBlocks: promptPack.driverBlocks,
            enforcementMode: postOutputLinterMode,
          });

          const lintTrace0 = buildPostLinterTrace(lint0, envelopeAttempt);

          await appendTrace({
            traceRunId: traceRun.id,
            transmissionId: transmission.id,
            actor: "solserver",
            phase: "output_gates",
            status: lintTrace0.status,
            summary: lintTrace0.summary,
            metadata: lintTrace0.meta,
          });

          const driverBlockEvents0 = buildDriverBlockTraceEvents({
            blockResults: lint0.blockResults ?? [],
            driverBlocks: promptPack.driverBlocks,
            attempt: envelopeAttempt,
          });
          for (const event of driverBlockEvents0) {
            await appendTrace({
              traceRunId: traceRun.id,
              transmissionId: transmission.id,
              actor: "solserver",
              phase: "output_gates",
              status: event.status,
              summary: event.summary,
              metadata: event.metadata,
            });
          }

          bgLog.debug({
            evt: "post_linter.completed",
            attempt: envelopeAttempt,
            ok: lint0.ok,
            violationsCount: lintTrace0.meta.violationsCount,
          }, "post_linter.completed");

          if (lintTrace0.violations.length > 0) {
            bgLog.warn(lintTrace0.meta, "gate.post_lint_warning");
          }

          if (lint0.ok) {
            const repairedMementoOutput = await maybeRepairMementoOutput({
              assistant: assistant0,
              envelope: envelope0Normalized,
              promptPack,
              forcedRawText: attempt1Output,
              logger: bgLog,
            });
            let mementoQualityResolution: MementoQualityResolution = repairedMementoOutput.repairResolution;
            const mementoUpdate = await updateThreadMementoLatestFromEnvelope({
              packet,
              envelope: repairedMementoOutput.envelope,
              transmission,
              store,
              threadContextMode,
              requestThreadMemento,
              breakpointDecision,
            });
            if (mementoUpdate.shapeSource === "fallback") {
              mementoQualityResolution = "fallback";
            }
            await appendMementoQualityTrace({
              qualityBefore: repairedMementoOutput.qualityBefore,
              qualityAfter: repairedMementoOutput.qualityAfter,
              shapeSource: mementoUpdate.shapeSource,
              resolvedBy: mementoQualityResolution,
              effectiveDecisionsCount: mementoUpdate.latest?.decisions.length ?? 0,
              logger: bgLog,
            });

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "succeeded",
              outputChars: repairedMementoOutput.assistant.length,
            });

            await store.recordUsage({
              transmissionId,
              inputChars: packet.message.length,
              outputChars: repairedMementoOutput.assistant.length,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "completed",
            });

            await store.setChatResult({ transmissionId, assistant: repairedMementoOutput.assistant });

            emitAssistantFinalReady();

            bgLog.info({
              evt: "chat.async.completed",
              statusCode: 200,
              attemptsUsed: contractRetryUsed ? 2 : 1,
            }, "chat.async.completed");
            bgLog.info(
              { status: "completed", outputChars: repairedMementoOutput.assistant.length },
              "delivery.completed_async"
            );
            return;
          }

          if (contractRetryUsed) {
            const stubAssistant = buildEnforcementStub();

            await appendTrace({
              traceRunId: traceRun.id,
              transmissionId: transmission.id,
              actor: "solserver",
              phase: "output_gates",
              status: "failed",
              summary: "Driver block enforcement failed",
              metadata: {
                kind: "driver_block_enforcement",
                outcome: "fail_closed_422",
                attempts: 2,
                violationsCount: lintTrace0.meta.violationsCount,
              },
            });

            bgLog.info({
              evt: "enforcement.failed",
              attempt: envelopeAttempt,
              error: "driver_block_enforcement_failed",
            }, "enforcement.failed");

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "failed",
              error: "driver_block_enforcement_failed",
            });

            const errorDetail = buildDriverBlockFailureDetail(lintTrace0.meta);
            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
              statusCode: 422,
              retryable: false,
              errorCode: "driver_block_enforcement_failed",
              errorDetail,
            });

            await store.setChatResult({ transmissionId, assistant: stubAssistant });

            emitAssistantFailed({
              code: "GATE_REGEN_EXHAUSTED",
              detail: "Output failed gating after retry.",
              retryable: false,
              category: "gates",
            });

            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed" }, "delivery.failed_async");
            return;
          }

          const correctionText = buildCorrectionText(lint0.violations, promptPack.driverBlocks);
          const promptPack1 = withCorrectionSection(promptPack, correctionText);

          const attempt1 = await runModelAttempt({
            attempt: 1,
            promptPack: promptPack1,
            modeLabel: modeDecision.modeLabel,
            evidencePack,
            forcedRawText: attempt1Output,
            logger: bgLog,
          });

          const envelope1 = await parseOutputEnvelope({
            rawText: attempt1.rawText,
            attempt: 1,
          });

          if (envelope1.ok) {
            bgLog.debug({
              evt: "output_envelope.completed",
              attempt: 1,
              rawLength: attempt1.rawText.length,
            }, "output_envelope.completed");
          } else {
            bgLog.info({
              evt: "output_envelope.failed",
              attempt: 1,
              reason: envelope1.reason,
              rawLength: attempt1.rawText.length,
              ...(typeof envelope1.issuesCount === "number" ? { issuesCount: envelope1.issuesCount } : {}),
              ...(envelope1.issuesTop3 ? { issuesTop3: envelope1.issuesTop3 } : {}),
            }, "output_envelope.failed");
          }

          if (!envelope1.ok) {
            const stubAssistant = buildOutputContractStub();
            const errorCode = formatOutputContractError(envelope1.reason, envelope1.issuesCount);

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "failed",
              error: errorCode,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
              statusCode: 422,
              retryable: false,
              errorCode,
            });

            await store.setChatResult({ transmissionId, assistant: stubAssistant });

            emitAssistantFailed({
              code: "OUTPUT_ENVELOPE_INVALID",
              detail: "Output envelope invalid.",
              retryable: false,
              category: "gates",
            });

            bgLog.info({
              evt: "simulate.persisted_failure",
              statusCode: 422,
              errorCode,
            }, "simulate.persisted_failure");
            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed", reason: envelope1.reason }, "delivery.failed_async");
            return;
          }

          const librarianEnvelope1 = await runLibrarianGate({
            envelope: envelope1.envelope,
            attempt: 1,
            evidencePack,
          });

          const evidenceGate1 = await runEvidenceOutputGates({
            envelope: librarianEnvelope1,
            attempt: 1,
            evidencePack,
            transmissionId,
          });

          if (!evidenceGate1.ok) {
            const stubAssistant = buildOutputContractStub("evidence_gate");

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "failed",
              error: evidenceGate1.code,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
              statusCode: 422,
              retryable: false,
              errorCode: evidenceGate1.code,
            });

            await store.setChatResult({ transmissionId, assistant: stubAssistant });

            emitAssistantFailed({
              code: "OUTPUT_ENVELOPE_INVALID",
              detail: "Output failed evidence gates.",
              retryable: false,
              category: "gates",
            });

            bgLog.info({
              evt: "simulate.persisted_failure",
              statusCode: 422,
              errorCode: evidenceGate1.code,
            }, "simulate.persisted_failure");
            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed", reason: evidenceGate1.code }, "delivery.failed_async");
            return;
          }

          const assistant1 = evidenceGate1.envelope.assistant_text;
          const envelope1Normalized = normalizeOutputEnvelopeForResponse(evidenceGate1.envelope);

          await appendTrace({
            traceRunId: traceRun.id,
            transmissionId: transmission.id,
            actor: "solserver",
            phase: "output_gates",
            status: "started",
            summary: "Running output linter",
            metadata: { kind: "post_linter", attempt: 1 },
          });

          const lint1 = postOutputLinter({
            modeDecision,
            content: assistant1,
            driverBlocks: promptPack.driverBlocks,
            enforcementMode: postOutputLinterMode,
          });

          const lintTrace1 = buildPostLinterTrace(lint1, 1);

          await appendTrace({
            traceRunId: traceRun.id,
            transmissionId: transmission.id,
            actor: "solserver",
            phase: "output_gates",
            status: lintTrace1.status,
            summary: lintTrace1.summary,
            metadata: lintTrace1.meta,
          });

          const driverBlockEvents1 = buildDriverBlockTraceEvents({
            blockResults: lint1.blockResults ?? [],
            driverBlocks: promptPack1.driverBlocks,
            attempt: 1,
          });
          for (const event of driverBlockEvents1) {
            await appendTrace({
              traceRunId: traceRun.id,
              transmissionId: transmission.id,
              actor: "solserver",
              phase: "output_gates",
              status: event.status,
              summary: event.summary,
              metadata: event.metadata,
            });
          }

          bgLog.debug({
            evt: "post_linter.completed",
            attempt: 1,
            ok: lint1.ok,
            violationsCount: lintTrace1.meta.violationsCount,
          }, "post_linter.completed");

          if (lintTrace1.violations.length > 0) {
            bgLog.warn(lintTrace1.meta, "gate.post_lint_warning");
          }

          if (lint1.ok) {
            const repairedMementoOutput = await maybeRepairMementoOutput({
              assistant: assistant1,
              envelope: envelope1Normalized,
              promptPack: promptPack1,
              forcedRawText: attempt1Output,
              logger: bgLog,
            });
            let mementoQualityResolution: MementoQualityResolution = repairedMementoOutput.repairResolution;
            const mementoUpdate = await updateThreadMementoLatestFromEnvelope({
              packet,
              envelope: repairedMementoOutput.envelope,
              transmission,
              store,
              threadContextMode,
              requestThreadMemento,
              breakpointDecision,
            });
            if (mementoUpdate.shapeSource === "fallback") {
              mementoQualityResolution = "fallback";
            }
            await appendMementoQualityTrace({
              qualityBefore: repairedMementoOutput.qualityBefore,
              qualityAfter: repairedMementoOutput.qualityAfter,
              shapeSource: mementoUpdate.shapeSource,
              resolvedBy: mementoQualityResolution,
              effectiveDecisionsCount: mementoUpdate.latest?.decisions.length ?? 0,
              logger: bgLog,
            });

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "succeeded",
              outputChars: repairedMementoOutput.assistant.length,
            });

            await store.recordUsage({
              transmissionId,
              inputChars: packet.message.length,
              outputChars: repairedMementoOutput.assistant.length,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "completed",
            });

            await store.setChatResult({ transmissionId, assistant: repairedMementoOutput.assistant });

            emitAssistantFinalReady();

            bgLog.info({ evt: "chat.async.completed", statusCode: 200, attemptsUsed: 2 }, "chat.async.completed");
            bgLog.info(
              { status: "completed", outputChars: repairedMementoOutput.assistant.length },
              "delivery.completed_async"
            );
            return;
          }

          const stubAssistant = buildEnforcementStub();

          await appendTrace({
            traceRunId: traceRun.id,
            transmissionId: transmission.id,
            actor: "solserver",
            phase: "output_gates",
            status: "failed",
            summary: "Driver block enforcement failed",
            metadata: {
              kind: "driver_block_enforcement",
              outcome: "fail_closed_422",
              attempts: 2,
              violationsCount: lintTrace1.meta.violationsCount,
            } satisfies EnforcementFailureMetadata,
          });

          bgLog.info({
            evt: "enforcement.failed",
            attempt: 1,
            error: "driver_block_enforcement_failed",
          }, "enforcement.failed");

          await store.appendDeliveryAttempt({
            transmissionId,
            provider: llmProvider,
            status: "failed",
            error: "driver_block_enforcement_failed",
          });

          const errorDetail = buildDriverBlockFailureDetail(lintTrace1.meta);
          await store.updateTransmissionStatus({
            transmissionId,
            status: "failed",
            statusCode: 422,
            retryable: false,
            errorCode: "driver_block_enforcement_failed",
            errorDetail,
          });

          await store.setChatResult({ transmissionId, assistant: stubAssistant });

          emitAssistantFailed({
            code: "GATE_REGEN_EXHAUSTED",
            detail: "Output failed gating after retry.",
            retryable: false,
            category: "gates",
          });

          bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
          bgLog.warn({ status: "failed" }, "delivery.failed_async");
        } catch (err: any) {
          const msg = String(err?.message ?? err);

          await store.appendDeliveryAttempt({
            transmissionId,
            provider: llmProvider,
            status: "failed",
            error: msg,
          });

          await store.updateTransmissionStatus({
            transmissionId,
            status: "failed",
            statusCode: 500,
            retryable: true,
            errorCode: "provider_failed",
          });

          emitAssistantFailed({
            code: "PROVIDER_ERROR",
            detail: "Model request failed.",
            retryable: true,
            category: "provider",
          });

          bgLog.info({ evt: "chat.async.failed" }, "chat.async.failed");
          bgLog.error({ error: msg }, "provider.failed_async");
        } finally {
          pendingCompletions.delete(transmissionId);
        }
      }, delayMs);
    }

    logResponded(202, 0);
    return respond(202, {
      ok: true,
      transmissionId,
      status: "created",
      pending: true,
      simulated: true,
      checkAfterMs: 750,
      driverBlocks: driverBlockSummary,
      ...(hasEvidence ? { evidence: effectiveEvidence } : {}),
      evidenceSummary,
      ...(effectiveWarnings.length > 0 ? { evidenceWarnings: effectiveWarnings } : {}),
      threadMemento: threadContextMode === "auto"
        ? (() => {
            const latest = getThreadMementoLatestCached(packet.threadId);
            return latest ? sanitizeThreadMementoLatest(latest) : null;
          })()
        : null,
    });
  }

  const attempt0Output = getForcedTestProviderOutput(req, 0);
  const attempt1Output = getForcedTestProviderOutput(req, 1);

  let assistant: string;
  let outputEnvelope: OutputEnvelope | null = null;
  let threadMemento: ThreadMementoLatest | null = null;
  let attemptsUsed = 0;
  const modelStartNs = process.hrtime.bigint();
  let modelTotalMs = 0;

  try {
    const attempt0 = await runModelAttempt({
      attempt: 0,
      promptPack,
      modeLabel: modeDecision.modeLabel,
      evidencePack,
      forcedRawText: attempt0Output,
      logger: log,
    });

    let contractRetryUsed = false;
    let contractAttempt: 0 | 1 = 0;
    let envelope0 = await parseOutputEnvelope({
      rawText: attempt0.rawText,
      attempt: 0,
    });

    if (envelope0.ok) {
      log.debug({
        evt: "output_envelope.completed",
        attempt: 0,
        rawLength: getRawByteLength(attempt0.rawText),
      }, "output_envelope.completed");
    } else {
      log.info({
        evt: "output_envelope.failed",
        attempt: 0,
        reason: envelope0.reason,
        rawLength: getRawByteLength(attempt0.rawText),
        ...(typeof envelope0.issuesCount === "number" ? { issuesCount: envelope0.issuesCount } : {}),
        ...(envelope0.issuesTop3 ? { issuesTop3: envelope0.issuesTop3 } : {}),
      }, "output_envelope.failed");
    }

    if (!envelope0.ok) {
      if (shouldRetryOutputContract(envelope0.reason)) {
        contractRetryUsed = true;
        contractAttempt = 1;
        log.info({
          evt: "output_contract.retry",
          reason: envelope0.reason,
          fromModel: modelSelection.model,
          toModel: outputContractRetryModel,
        }, "output_contract.retry");

        await appendTrace({
          traceRunId: traceRun.id,
          transmissionId: transmission.id,
          actor: "solserver",
          phase: "model_call",
          status: "warning",
          summary: "Output contract retry",
          metadata: {
            kind: "output_contract_retry",
            reason: envelope0.reason,
            fromModel: modelSelection.model,
            toModel: outputContractRetryModel,
          },
        });

        const retryAttempt = await runModelAttempt({
          attempt: 1,
          promptPack,
          modeLabel: modeDecision.modeLabel,
          evidencePack,
          forcedRawText: attempt1Output,
          modelOverride: outputContractRetryModel,
          providerOverride: outputContractRetryProvider === "openai" ? "openai" : "fake",
          providerSourceOverride: "retry",
          logger: log,
        });

        envelope0 = await parseOutputEnvelope({
          rawText: retryAttempt.rawText,
          attempt: 1,
        });

        if (envelope0.ok) {
          log.debug({
            evt: "output_envelope.completed",
            attempt: 1,
            rawLength: getRawByteLength(retryAttempt.rawText),
          }, "output_envelope.completed");
        } else {
          log.info({
            evt: "output_envelope.failed",
            attempt: 1,
            reason: envelope0.reason,
            rawLength: getRawByteLength(retryAttempt.rawText),
            ...(typeof envelope0.issuesCount === "number" ? { issuesCount: envelope0.issuesCount } : {}),
            ...(envelope0.issuesTop3 ? { issuesTop3: envelope0.issuesTop3 } : {}),
          }, "output_envelope.failed");
        }
      }

      if (!envelope0.ok) {
        const stubAssistant = buildOutputContractStub();
        const errorCode = formatOutputContractError(envelope0.reason, envelope0.issuesCount);

        await store.appendDeliveryAttempt({
          transmissionId: transmission.id,
          provider: llmProvider,
          status: "failed",
          error: errorCode,
        });

        await store.updateTransmissionStatus({
          transmissionId: transmission.id,
          status: "failed",
          statusCode: 422,
          retryable: false,
          errorCode,
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        emitAssistantFailed({
          code: "OUTPUT_ENVELOPE_INVALID",
          detail: "Output envelope invalid.",
          retryable: false,
          category: "gates",
        });

        logResponded(422, contractRetryUsed ? 2 : 1);
        return respond(422, {
          error: "output_contract_failed",
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
          retryable: false,
          assistant: stubAssistant,
        });
      }
    }

    const envelopeAttempt = contractAttempt;
    const librarianEnvelope0 = await runLibrarianGate({
      envelope: envelope0.envelope,
      attempt: envelopeAttempt,
      evidencePack,
    });

    const evidenceGate0 = await runEvidenceOutputGates({
      envelope: librarianEnvelope0,
      attempt: envelopeAttempt,
      evidencePack,
      transmissionId: transmission.id,
    });

    if (!evidenceGate0.ok) {
      const stubAssistant = buildOutputContractStub("evidence_gate");

      await store.appendDeliveryAttempt({
        transmissionId: transmission.id,
        provider: llmProvider,
        status: "failed",
        error: evidenceGate0.code,
      });

      await store.updateTransmissionStatus({
        transmissionId: transmission.id,
        status: "failed",
        statusCode: 422,
        retryable: false,
        errorCode: evidenceGate0.code,
      });

      await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

      emitAssistantFailed({
        code: "OUTPUT_ENVELOPE_INVALID",
        detail: "Output failed evidence gates.",
        retryable: false,
        category: "gates",
      });

      logResponded(422, contractRetryUsed ? 2 : 1);
      return respond(422, buildEvidenceGateFailureResponse({
        code: evidenceGate0.code,
        transmissionId: transmission.id,
        traceRunId: traceRun.id,
      }));
    }

    const assistant0 = evidenceGate0.envelope.assistant_text;
    const envelope0Normalized = normalizeOutputEnvelopeForResponse(evidenceGate0.envelope);

    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: "started",
      summary: "Running output linter",
      metadata: { kind: "post_linter", attempt: envelopeAttempt },
    });

    const lint0 = postOutputLinter({
      modeDecision,
      content: assistant0,
      driverBlocks: promptPack.driverBlocks,
      enforcementMode: postOutputLinterMode,
    });

    const lintTrace0 = buildPostLinterTrace(lint0, envelopeAttempt);

    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: lintTrace0.status,
      summary: lintTrace0.summary,
      metadata: lintTrace0.meta,
    });

    const driverBlockEvents0 = buildDriverBlockTraceEvents({
      blockResults: lint0.blockResults ?? [],
      driverBlocks: promptPack.driverBlocks,
      attempt: envelopeAttempt,
    });
    for (const event of driverBlockEvents0) {
      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: event.status,
        summary: event.summary,
        metadata: event.metadata,
      });
    }

    log.debug({
      evt: "post_linter.completed",
      attempt: envelopeAttempt,
      ok: lint0.ok,
      violationsCount: lintTrace0.meta.violationsCount,
    }, "post_linter.completed");

    if (lintTrace0.violations.length > 0) {
      log.warn(lintTrace0.meta, "gate.post_lint_warning");
    }

    if (lint0.ok) {
      assistant = assistant0;
      outputEnvelope = envelope0Normalized;
      attemptsUsed = contractRetryUsed ? 2 : 1;
    } else {
      if (contractRetryUsed) {
        const stubAssistant = buildEnforcementStub();

        await appendTrace({
          traceRunId: traceRun.id,
          transmissionId: transmission.id,
          actor: "solserver",
          phase: "output_gates",
          status: "failed",
          summary: "Driver block enforcement failed",
          metadata: {
            kind: "driver_block_enforcement",
            outcome: "fail_closed_422",
            attempts: 2,
            violationsCount: lintTrace0.meta.violationsCount,
          } satisfies EnforcementFailureMetadata,
        });

        log.info({
          evt: "enforcement.failed",
          attempt: envelopeAttempt,
          error: "driver_block_enforcement_failed",
        }, "enforcement.failed");

        await store.appendDeliveryAttempt({
          transmissionId: transmission.id,
          provider: llmProvider,
          status: "failed",
          error: "driver_block_enforcement_failed",
        });

        const errorDetail = buildDriverBlockFailureDetail(lintTrace0.meta);
        await store.updateTransmissionStatus({
          transmissionId: transmission.id,
          status: "failed",
          statusCode: 422,
          retryable: false,
          errorCode: "driver_block_enforcement_failed",
          errorDetail,
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        emitAssistantFailed({
          code: "GATE_REGEN_EXHAUSTED",
          detail: "Output failed gating after retry.",
          retryable: false,
          category: "gates",
        });

        logResponded(422, 2);
        return respond(422, {
          error: "driver_block_enforcement_failed",
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
          retryable: false,
          assistant: stubAssistant,
        });
      }

      const correctionText = buildCorrectionText(lint0.violations, promptPack.driverBlocks);
      const promptPack1 = withCorrectionSection(promptPack, correctionText);

      const attempt1 = await runModelAttempt({
        attempt: 1,
        promptPack: promptPack1,
        modeLabel: modeDecision.modeLabel,
        evidencePack,
        forcedRawText: attempt1Output,
        logger: log,
      });

      const envelope1 = await parseOutputEnvelope({
        rawText: attempt1.rawText,
        attempt: 1,
      });

      if (envelope1.ok) {
        log.debug({
          evt: "output_envelope.completed",
          attempt: 1,
          rawLength: getRawByteLength(attempt1.rawText),
        }, "output_envelope.completed");
      } else {
        log.info({
          evt: "output_envelope.failed",
          attempt: 1,
          reason: envelope1.reason,
          rawLength: getRawByteLength(attempt1.rawText),
          ...(typeof envelope1.issuesCount === "number" ? { issuesCount: envelope1.issuesCount } : {}),
          ...(envelope1.issuesTop3 ? { issuesTop3: envelope1.issuesTop3 } : {}),
        }, "output_envelope.failed");
      }

      if (!envelope1.ok) {
        const stubAssistant = buildOutputContractStub();
        const errorCode = formatOutputContractError(envelope1.reason, envelope1.issuesCount);

        await store.appendDeliveryAttempt({
          transmissionId: transmission.id,
          provider: llmProvider,
          status: "failed",
          error: errorCode,
        });

        await store.updateTransmissionStatus({
          transmissionId: transmission.id,
          status: "failed",
          statusCode: 422,
          retryable: false,
          errorCode,
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        emitAssistantFailed({
          code: "OUTPUT_ENVELOPE_INVALID",
          detail: "Output envelope invalid.",
          retryable: false,
          category: "gates",
        });

        logResponded(422, 2);
        return respond(422, {
          error: "output_contract_failed",
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
          retryable: false,
          assistant: stubAssistant,
        });
      }

      const librarianEnvelope1 = await runLibrarianGate({
        envelope: envelope1.envelope,
        attempt: 1,
        evidencePack,
      });

      const evidenceGate1 = await runEvidenceOutputGates({
        envelope: librarianEnvelope1,
        attempt: 1,
        evidencePack,
        transmissionId: transmission.id,
      });

      if (!evidenceGate1.ok) {
        const stubAssistant = buildOutputContractStub("evidence_gate");

        await store.appendDeliveryAttempt({
          transmissionId: transmission.id,
          provider: llmProvider,
          status: "failed",
          error: evidenceGate1.code,
        });

        await store.updateTransmissionStatus({
          transmissionId: transmission.id,
          status: "failed",
          statusCode: 422,
          retryable: false,
          errorCode: evidenceGate1.code,
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        emitAssistantFailed({
          code: "OUTPUT_ENVELOPE_INVALID",
          detail: "Output failed evidence gates.",
          retryable: false,
          category: "gates",
        });

        logResponded(422, 2);
        return respond(422, buildEvidenceGateFailureResponse({
          code: evidenceGate1.code,
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
        }));
      }

      const assistant1 = evidenceGate1.envelope.assistant_text;
      const envelope1Normalized = normalizeOutputEnvelopeForResponse(evidenceGate1.envelope);

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "started",
        summary: "Running output linter",
        metadata: { kind: "post_linter", attempt: 1 },
      });

      const lint1 = postOutputLinter({
        modeDecision,
        content: assistant1,
        driverBlocks: promptPack.driverBlocks,
        enforcementMode: postOutputLinterMode,
      });

      const lintTrace1 = buildPostLinterTrace(lint1, 1);

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: lintTrace1.status,
        summary: lintTrace1.summary,
        metadata: lintTrace1.meta,
      });

      const driverBlockEvents1 = buildDriverBlockTraceEvents({
        blockResults: lint1.blockResults ?? [],
        driverBlocks: promptPack1.driverBlocks,
        attempt: 1,
      });
      for (const event of driverBlockEvents1) {
        await appendTrace({
          traceRunId: traceRun.id,
          transmissionId: transmission.id,
          actor: "solserver",
          phase: "output_gates",
          status: event.status,
          summary: event.summary,
          metadata: event.metadata,
        });
      }

      log.debug({
        evt: "post_linter.completed",
        attempt: 1,
        ok: lint1.ok,
        violationsCount: lintTrace1.meta.violationsCount,
      }, "post_linter.completed");

      if (lintTrace1.violations.length > 0) {
        log.warn(lintTrace1.meta, "gate.post_lint_warning");
      }

      if (lint1.ok) {
        assistant = assistant1;
        outputEnvelope = envelope1Normalized;
        attemptsUsed = 2;
      } else {
        const stubAssistant = buildEnforcementStub();

        await appendTrace({
          traceRunId: traceRun.id,
          transmissionId: transmission.id,
          actor: "solserver",
          phase: "output_gates",
          status: "failed",
          summary: "Driver block enforcement failed",
          metadata: {
            kind: "driver_block_enforcement",
            outcome: "fail_closed_422",
            attempts: 2,
            violationsCount: lintTrace1.meta.violationsCount,
          } satisfies EnforcementFailureMetadata,
        });

        log.info({
          evt: "enforcement.failed",
          attempt: 1,
          error: "driver_block_enforcement_failed",
        }, "enforcement.failed");

        await store.appendDeliveryAttempt({
          transmissionId: transmission.id,
          provider: llmProvider,
          status: "failed",
          error: "driver_block_enforcement_failed",
        });

        const errorDetail = buildDriverBlockFailureDetail(lintTrace1.meta);
        await store.updateTransmissionStatus({
          transmissionId: transmission.id,
          status: "failed",
          statusCode: 422,
          retryable: false,
          errorCode: "driver_block_enforcement_failed",
          errorDetail,
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        emitAssistantFailed({
          code: "GATE_REGEN_EXHAUSTED",
          detail: "Output failed gating after retry.",
          retryable: false,
          category: "gates",
        });

        logResponded(422, 2);
        return respond(422, {
          error: "driver_block_enforcement_failed",
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
          retryable: false,
          assistant: stubAssistant,
        });
      }
    }

    if (!outputEnvelope) {
      throw new Error("output_envelope_missing");
    }
  } catch (err: any) {
    await store.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider: llmProvider,
      status: "failed",
      error: String(err?.message ?? err),
    });

    const isProviderError = err instanceof OpenAIProviderError;
    const statusCode = isProviderError ? err.statusCode : 500;
    const retryable = isProviderError ? err.retryable : true;
    const errorTag = isProviderError && !retryable
      ? "provider_invalid_request"
      : (statusCode === 502 ? "provider_upstream_failed" : "provider_failed");

    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode,
      retryable,
      errorCode: errorTag,
    });

    log.error({ error: String(err?.message ?? err) }, "provider.failed");

    const isTimeout = isProviderError
      && (statusCode === 408
        || statusCode === 504
        || String(err?.message ?? "").toLowerCase().includes("timeout"));
    const isInvalidSchema = isProviderError
      && err.errorType === "invalid_request_error"
      && err.errorCode === "invalid_json_schema";
    emitAssistantFailed({
      code: isProviderError
        ? (isTimeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR")
        : "INTERNAL_ERROR",
      detail: isProviderError
        ? (isTimeout
          ? "Model request timed out."
          : (isInvalidSchema ? "Model rejected output schema." : "Model request failed."))
        : "Internal server error.",
      retryable,
      retryAfterMs: isProviderError ? err.retryAfterMs : undefined,
      category: isProviderError ? "provider" : "internal",
    });

    return respond(statusCode, {
      error: errorTag,
      transmissionId: transmission.id,
      traceRunId: traceRun.id,
      retryable,
    });
  }

  modelTotalMs = Number(process.hrtime.bigint() - modelStartNs) / 1e6;

  const repairedMementoOutput = await maybeRepairMementoOutput({
    assistant,
    envelope: outputEnvelope!,
    promptPack,
    forcedRawText: attempt1Output,
    logger: log,
  });
  assistant = repairedMementoOutput.assistant;
  outputEnvelope = repairedMementoOutput.envelope;

  let mementoQualityResolution: MementoQualityResolution = repairedMementoOutput.repairResolution;
  const mementoQualityBefore = repairedMementoOutput.qualityBefore;
  const mementoQualityAfter = repairedMementoOutput.qualityAfter;

  const mementoUpdate = await updateThreadMementoLatestFromEnvelope({
    packet,
    envelope: outputEnvelope,
    transmission,
    store,
    threadContextMode,
    requestThreadMemento,
    breakpointDecision,
  });
  threadMemento = mementoUpdate.latest ? sanitizeThreadMementoLatest(mementoUpdate.latest) : null;
  if (mementoUpdate.shapeSource === "fallback") {
    mementoQualityResolution = "fallback";
  }
  await appendMementoQualityTrace({
    qualityBefore: mementoQualityBefore,
    qualityAfter: mementoQualityAfter,
    shapeSource: mementoUpdate.shapeSource,
    resolvedBy: mementoQualityResolution,
    effectiveDecisionsCount: mementoUpdate.latest?.decisions.length ?? 0,
    logger: log,
  });

  const avoidPeakOverwhelm = resolveAvoidPeakOverwhelm(packet);
  const messageIdForAffect = resolvePacketMessageId(packet, transmission);
  const offerSpanStart = mementoUpdate.latest?.affect.points[0]?.endMessageId ?? messageIdForAffect;
  const offerSpanEnd = mementoUpdate.latest?.affect.points.at(-1)?.endMessageId ?? messageIdForAffect;
  const offerPhase = mementoUpdate.latest?.affect.rollup.phase;
  const offerIntensityBucket = mementoUpdate.latest?.affect.rollup.intensityBucket;
  const offerRisk = gatesOutput.sentinel.risk;
  const offerLabel = mementoUpdate.moodSignal?.label ?? mementoUpdate.affectSignal?.label;
  const offerMode = resolveJournalOfferMode(packet);

  const offerSkipReasons: Array<
    "no_affect_signal" | "label_neutral" | "risk_not_low" | "phase_blocked" | "cooldown" | "other"
  > = [];

  let journalOffer = null as ReturnType<typeof classifyJournalOffer>;
  if (threadContextMode !== "auto" || !mementoUpdate.latest) {
    offerSkipReasons.push("other");
  } else if (!mementoUpdate.affectSignal) {
    offerSkipReasons.push("no_affect_signal");
  } else if (mementoUpdate.affectSignal.label === "neutral") {
    offerSkipReasons.push("label_neutral");
  } else if (offerRisk !== "low") {
    offerSkipReasons.push("risk_not_low");
  } else if (mementoUpdate.moodSignal && offerPhase) {
    journalOffer = classifyJournalOffer({
      mood: mementoUpdate.moodSignal,
      risk: offerRisk,
      phase: offerPhase,
      avoidPeakOverwhelm,
      evidenceSpan: { startMessageId: offerSpanStart, endMessageId: offerSpanEnd },
    });

    if (!journalOffer) {
      const label = mementoUpdate.affectSignal.label;
      if (label === "overwhelm") {
        if (offerPhase !== "settled") {
          offerSkipReasons.push("phase_blocked");
        } else if (avoidPeakOverwhelm) {
          offerSkipReasons.push("cooldown");
        } else {
          offerSkipReasons.push("other");
        }
      } else if (label === "gratitude") {
        if (offerPhase === "rising" || offerPhase === "peak") {
          offerSkipReasons.push("phase_blocked");
        } else {
          offerSkipReasons.push("other");
        }
      } else if (label === "resolve") {
        if (offerPhase !== "settled") {
          offerSkipReasons.push("phase_blocked");
        } else {
          offerSkipReasons.push("other");
        }
      } else {
        offerSkipReasons.push("other");
      }
    }
  }

  log.info({
    evt: "journal_offer.decision",
    offerEligible: Boolean(journalOffer),
    showOffer: Boolean(journalOffer),
    label: offerLabel ?? null,
    phase: offerPhase ?? null,
    risk: offerRisk,
    intensityBucket: offerIntensityBucket ?? null,
    skipReasons: offerSkipReasons.length > 0 ? offerSkipReasons : null,
  }, "journal_offer.decision");

  if (journalOffer) {
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: "completed",
      summary: "Journal offer attached",
      metadata: {
        kind: "journal_offer",
        action: "attached",
        offerEligible: true,
        showOffer: true,
        label: offerLabel ?? null,
        phase: offerPhase ?? null,
        risk: offerRisk,
        intensityBucket: offerIntensityBucket ?? null,
      },
    });
  } else {
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "solserver",
      phase: "output_gates",
      status: "completed",
      summary: "Journal offer skipped",
      metadata: {
        kind: "journal_offer",
        action: "skipped",
        offerEligible: false,
        showOffer: false,
        reason_codes: offerSkipReasons.length > 0 ? offerSkipReasons : ["other"],
        label: offerLabel ?? null,
        phase: offerPhase ?? null,
        risk: offerRisk,
        intensityBucket: offerIntensityBucket ?? null,
      },
    });
  }

  const journalOfferRecord = buildJournalOfferRecord({
    journalOffer,
    offerSpanStart,
    offerSpanEnd,
    offerSkipReasons,
    offerPhase,
    offerRisk,
    offerLabel: offerLabel as JournalOfferRecord["label"] | undefined,
    offerIntensityBucket: offerIntensityBucket as JournalOfferRecord["intensityBucket"] | undefined,
    offerMode,
  });

  if (journalOffer) {
    outputEnvelope = {
      ...outputEnvelope,
      meta: { ...(outputEnvelope.meta ?? {}), journalOffer: journalOffer },
    };
  }

  await store.appendDeliveryAttempt({
    transmissionId: transmission.id,
    provider: llmProvider,
    status: "succeeded",
    outputChars: assistant.length,
    journalOffer: journalOfferRecord,
  });

  await store.recordUsage({
    transmissionId: transmission.id,
    inputChars: packet.message.length,
    outputChars: assistant.length,
  });

  await store.updateTransmissionStatus({
    transmissionId: transmission.id,
    status: "completed",
  });

  await store.setChatResult({ transmissionId: transmission.id, assistant });

  emitAssistantFinalReady();

  log.info({
    status: "completed",
    outputChars: assistant.length,
  }, "delivery.completed");

  const traceSummary = await store.getTraceSummary(traceRun.id);

  // Fetch trace events for response (bounded by level)
  const traceEventLimit = traceLevel === "debug" ? 50 : 0; // debug: return up to 50 events, info: no events
  const traceEvents = traceLevel === "debug"
    ? await store.getTraceEvents(traceRun.id, { limit: traceEventLimit })
    : [];

  const eventCount = traceSummary?.eventCount
    ?? (traceLevel === "debug" ? traceEvents.length : 0);

  const responseEvidenceSummary = {
    ...evidenceSummary,
    claims: outputEnvelope?.meta?.claims?.length ?? 0,
  };
  const latticeTimings = {
    lattice_total: Math.round(latticeTotalMs),
    lattice_db: Math.round(latticeDbMs),
    model_total: Math.round(modelTotalMs),
    request_total: Math.round(elapsedMs()),
  };
  outputEnvelope = {
    ...outputEnvelope,
    meta: {
      ...(outputEnvelope?.meta ?? {}),
      lattice: { ...latticeMetaBase, timings_ms: latticeTimings },
    },
  };
  const responseEnvelope = buildOutputEnvelopeMeta({
    envelope: outputEnvelope!,
    personaLabel,
    notificationPolicy: resolvedNotificationPolicy,
  });
  await store.setTransmissionOutputEnvelope({
    transmissionId: transmission.id,
    outputEnvelope: responseEnvelope,
  });

  const responseThreadMemento = formatThreadMementoResponse(threadMemento);

  logResponded(200, attemptsUsed);
  return respond(200, {
    ok: true,
    transmissionId: transmission.id,
    modeDecision,
    assistant,
    outputEnvelope: responseEnvelope,
    threadMemento: responseThreadMemento,
    driverBlocks: driverBlockSummary,
    // Evidence fields (PR #7.1): include evidence only when present
    ...(hasEvidence ? { evidence: effectiveEvidence } : {}),
    evidenceSummary: responseEvidenceSummary,
    ...(effectiveWarnings.length > 0 ? { evidenceWarnings: effectiveWarnings } : {}),
    trace: {
      traceRunId: traceRun.id,
      level: traceLevel,
      eventCount,
      ...(traceLevel === "debug"
        ? { events: traceEvents }
        : { phaseCounts: traceSummary?.phaseCounts ?? {} }),
    },
  });
}
