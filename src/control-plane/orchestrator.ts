import { routeMode, resolvePersonaLabel } from "./router";
import { buildPromptPack, toSinglePromptText, promptPackLogShape, withCorrectionSection, type PromptPack } from "./prompt_pack";
import { runGatesPipeline } from "../gates/gates_pipeline";
import {
  getLatestThreadMemento,
  putThreadMemento,
  retrieveContext,
  retrievalLogShape,
} from "./retrieval";
import { postOutputLinter, type PostLinterViolation, type PostLinterBlockResult, type DriverBlockEnforcementMode } from "../gates/post_linter";
import { runEvidenceIntake } from "../gates/evidence_intake";
import { EvidenceValidationError } from "../gates/evidence_validation_error";
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
import type { ControlPlaneStore, TraceRun, Transmission } from "../store/control_plane_store";
import { OutputEnvelopeSchema, type OutputEnvelope } from "../contracts/output_envelope";
import type { PacketInput, ModeDecision, NotificationPolicy } from "../contracts/chat";

export type OrchestrationSource = "api" | "worker";
export type SystemPersona = NonNullable<ModeDecision["personaLabel"]>;

export type OrchestrationRequest = {
  source: OrchestrationSource;
  packet: PacketInput;
  simulate?: boolean;
  forcedPersona?: SystemPersona | null;
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

type EnforcementFailureMetadata = {
  kind: "driver_block_enforcement";
  outcome: "fail_closed_422";
  attempts: number;
  violationsCount: number;
};

function getForcedTestProviderOutput(req: any, attempt: 0 | 1): string | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  const headers = req?.headers ?? {};
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
  const raw = String(process.env.DRIVER_BLOCK_ENFORCEMENT ?? "").toLowerCase();
  if (raw === "strict" || raw === "warn" || raw === "off") return raw;
  if (process.env.NODE_ENV === "test") return "strict";
  if (process.env.SOL_ENV === "production" || process.env.NODE_ENV === "production") return "strict";
  if (process.env.SOL_ENV === "staging") return "warn";
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
};

function buildOutputEnvelopeMetadata(args: {
  attempt: 0 | 1;
  ok: boolean;
  rawLength: number;
  reason?: "invalid_json" | "schema_invalid" | "payload_too_large";
  issuesCount?: number;
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
  };
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

function buildOutputContractStub(): string {
  return "I can't do that directly from here. Tell me what you're trying to accomplish and I'll give you a safe draft or step-by-step instructions.";
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
    assistant: buildOutputContractStub(),
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
  const simulate = simulateStatus;

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

  await persistPolicy(resolvedNotificationPolicy);

  const traceLevel = packet.traceConfig?.level ?? "info";
  const enforcementMode = resolveDriverBlockEnforcementMode();

  let traceSeq = 0;
  const appendTrace = async (event: Parameters<typeof store.appendTraceEvent>[0]) => {
    const metadata = { ...(event.metadata ?? {}), seq: traceSeq++ };
    return store.appendTraceEvent({ ...event, metadata });
  };

  const llmProvider = (process.env.LLM_PROVIDER ?? "fake").toLowerCase() === "openai"
    ? "openai"
    : "fake";

  const modelSelection = selectModel({
    solEnv: process.env.SOL_ENV,
    nodeEnv: process.env.NODE_ENV,
    requestHints: packet.providerHints,
    defaultModel: process.env.OPENAI_MODEL ?? "gpt-5-nano",
  });

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
  }): Promise<{ ok: true; envelope: OutputEnvelope } | { ok: false; reason: "invalid_json" | "schema_invalid" | "payload_too_large"; issuesCount?: number }> => {
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
    try {
      parsed = JSON.parse(args.rawText);
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

    const result = OutputEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      const meta = buildOutputEnvelopeMetadata({
        attempt: args.attempt,
        ok: false,
        rawLength,
        reason: "schema_invalid",
        issuesCount: result.error.issues.length,
        error: result.error,
      });

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: "failed",
        summary: "Output envelope schema invalid",
        metadata: meta,
      });

      return { ok: false, reason: "schema_invalid", issuesCount: result.error.issues.length };
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

    return { ok: true, envelope: result.data };
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
    logger?: {
      debug: (obj: any, msg?: string) => void;
      info?: (obj: any, msg?: string) => void;
      warn?: (obj: any, msg?: string) => void;
      error?: (obj: any, msg?: string) => void;
    };
  }) => {
    await appendTrace({
      traceRunId: traceRun.id,
      transmissionId: transmission.id,
      actor: "model",
      phase: "model_call",
      status: "started",
      summary: `Calling model provider (Attempt ${args.attempt})`,
      metadata: { attempt: args.attempt },
    });

    const providerInputText = toSinglePromptText(args.promptPack);
    const meta = llmProvider === "openai"
      ? await openAIModelReplyWithMeta({
          promptText: providerInputText,
          modeLabel: args.modeLabel,
          model: modelSelection.model,
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
      }, "model_call.completed");
    }

    return { rawText, mementoDraft: meta.mementoDraft };
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

  if (llmProvider === "openai" && !process.env.OPENAI_MODEL) {
    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode: 500,
      retryable: false,
      errorCode: "openai_model_missing",
    });

    log.info({ evt: "chat.responded", statusCode: 500, attemptsUsed: 0 }, "chat.responded");
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

      log.info({ evt: "chat.responded", statusCode: 400, attemptsUsed: 0 }, "chat.responded");
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
    source: modelSelection.source,
    personaLabel: resolvePersonaLabel(modeDecision),
    ...(modelSelection.tier ? { tier: modelSelection.tier } : {}),
  }, "llm.provider.selected");

  // Ordering Contract (v0): route-level phase sequence is authoritative.
  // Phases must appear in this order in trace (not necessarily contiguous):
  // evidence_intake → gate_normalize_modality → url_extraction → gate_intent → gate_sentinel → gate_lattice
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
    "gate_normalize_modality" | "url_extraction" | "gate_intent" | "gate_sentinel" | "gate_lattice"
  > = {
    normalize_modality: "gate_normalize_modality",
    url_extraction: "url_extraction",
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

    log.info({ evt: "chat.responded", statusCode: 500, attemptsUsed: 0 }, "chat.responded");
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

  const retrievalItems = await retrieveContext({
    threadId: packet.threadId,
    packetType: packet.packetType,
    message: packet.message,
  });

  log.debug(retrievalLogShape(retrievalItems), "control_plane.retrieval");

  await appendTrace({
    traceRunId: traceRun.id,
    transmissionId: transmission.id,
    actor: "solserver",
    phase: "enrichment_lattice",
    status: "completed",
    summary: `Retrieved ${retrievalItems.length} context items`,
    metadata: { itemCount: retrievalItems.length },
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

    log.error({ error: message, errorCode }, "evidence_provider.failed");
    log.info({ evt: "chat.responded", statusCode: 500, attemptsUsed: 0 }, "chat.responded");
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

          const envelope0 = await parseOutputEnvelope({
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
            }, "output_envelope.failed");
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

            bgLog.info({
              evt: "simulate.persisted_failure",
              statusCode: 422,
              errorCode,
            }, "simulate.persisted_failure");
            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed", reason: envelope0.reason }, "delivery.failed_async");
            return;
          }

          const evidenceGate0 = await runEvidenceOutputGates({
            envelope: envelope0.envelope,
            attempt: 0,
            evidencePack,
            transmissionId,
          });

          if (!evidenceGate0.ok) {
            const stubAssistant = buildOutputContractStub();

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

          await appendTrace({
            traceRunId: traceRun.id,
            transmissionId: transmission.id,
            actor: "solserver",
            phase: "output_gates",
            status: "started",
            summary: "Running output linter",
            metadata: { kind: "post_linter", attempt: 0 },
          });

          const lint0 = postOutputLinter({
            modeDecision,
            content: assistant0,
            driverBlocks: promptPack.driverBlocks,
            enforcementMode,
          });

          const lintTrace0 = buildPostLinterTrace(lint0, 0);

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
            attempt: 0,
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
            attempt: 0,
            ok: lint0.ok,
            violationsCount: lintTrace0.meta.violationsCount,
          }, "post_linter.completed");

          if (lintTrace0.violations.length > 0) {
            bgLog.warn(lintTrace0.meta, "gate.post_lint_warning");
          }

          if (lint0.ok) {
            if (attempt0.mementoDraft) {
              const m = putThreadMemento({
                threadId: packet.threadId,
                arc: attempt0.mementoDraft.arc || "Untitled",
                active: attempt0.mementoDraft.active ?? [],
                parked: attempt0.mementoDraft.parked ?? [],
                decisions: attempt0.mementoDraft.decisions ?? [],
                next: attempt0.mementoDraft.next ?? [],
              });

              bgLog.info(
                {
                  plane: "memento",
                  threadId: packet.threadId,
                  mementoId: m.id,
                  source: "model",
                },
                "control_plane.memento_auto_put"
              );
            }

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "succeeded",
              outputChars: assistant0.length,
            });

            await store.recordUsage({
              transmissionId,
              inputChars: packet.message.length,
              outputChars: assistant0.length,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "completed",
            });

            await store.setChatResult({ transmissionId, assistant: assistant0 });

            bgLog.info({ evt: "chat.async.completed", statusCode: 200, attemptsUsed: 1 }, "chat.async.completed");
            bgLog.info({ status: "completed", outputChars: assistant0.length }, "delivery.completed_async");
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

            bgLog.info({
              evt: "simulate.persisted_failure",
              statusCode: 422,
              errorCode,
            }, "simulate.persisted_failure");
            bgLog.info({ evt: "chat.async.failed", statusCode: 422 }, "chat.async.failed");
            bgLog.warn({ status: "failed", reason: envelope1.reason }, "delivery.failed_async");
            return;
          }

          const evidenceGate1 = await runEvidenceOutputGates({
            envelope: envelope1.envelope,
            attempt: 1,
            evidencePack,
            transmissionId,
          });

          if (!evidenceGate1.ok) {
            const stubAssistant = buildOutputContractStub();

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
            enforcementMode,
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
            if (attempt1.mementoDraft) {
              const m = putThreadMemento({
                threadId: packet.threadId,
                arc: attempt1.mementoDraft.arc || "Untitled",
                active: attempt1.mementoDraft.active ?? [],
                parked: attempt1.mementoDraft.parked ?? [],
                decisions: attempt1.mementoDraft.decisions ?? [],
                next: attempt1.mementoDraft.next ?? [],
              });

              bgLog.info(
                {
                  plane: "memento",
                  threadId: packet.threadId,
                  mementoId: m.id,
                  source: "model",
                },
                "control_plane.memento_auto_put"
              );
            }

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: llmProvider,
              status: "succeeded",
              outputChars: assistant1.length,
            });

            await store.recordUsage({
              transmissionId,
              inputChars: packet.message.length,
              outputChars: assistant1.length,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "completed",
            });

            await store.setChatResult({ transmissionId, assistant: assistant1 });

            bgLog.info({ evt: "chat.async.completed", statusCode: 200, attemptsUsed: 2 }, "chat.async.completed");
            bgLog.info({ status: "completed", outputChars: assistant1.length }, "delivery.completed_async");
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

          bgLog.info({ evt: "chat.async.failed" }, "chat.async.failed");
          bgLog.error({ error: msg }, "provider.failed_async");
        } finally {
          pendingCompletions.delete(transmissionId);
        }
      }, delayMs);
    }

    log.info({ evt: "chat.responded", statusCode: 202, attemptsUsed: 0 }, "chat.responded");
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
      threadMemento: getLatestThreadMemento(packet.threadId, { includeDraft: true }),
    });
  }

  const attempt0Output = getForcedTestProviderOutput(req, 0);
  const attempt1Output = getForcedTestProviderOutput(req, 1);

  let assistant: string;
  let outputEnvelope: OutputEnvelope | null = null;
  let threadMemento: any = null;
  let attemptsUsed = 0;

  try {
    const attempt0 = await runModelAttempt({
      attempt: 0,
      promptPack,
      modeLabel: modeDecision.modeLabel,
      evidencePack,
      forcedRawText: attempt0Output,
      logger: log,
    });

    const envelope0 = await parseOutputEnvelope({
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
      }, "output_envelope.failed");
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

      log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 1 }, "chat.responded");
      return respond(422, {
        error: "output_contract_failed",
        transmissionId: transmission.id,
        traceRunId: traceRun.id,
        retryable: false,
        assistant: stubAssistant,
      });
    }

    const evidenceGate0 = await runEvidenceOutputGates({
      envelope: envelope0.envelope,
      attempt: 0,
      evidencePack,
      transmissionId: transmission.id,
    });

    if (!evidenceGate0.ok) {
      const stubAssistant = buildOutputContractStub();

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

      log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 1 }, "chat.responded");
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
      metadata: { kind: "post_linter", attempt: 0 },
    });

    const lint0 = postOutputLinter({
      modeDecision,
      content: assistant0,
      driverBlocks: promptPack.driverBlocks,
      enforcementMode,
    });

    const lintTrace0 = buildPostLinterTrace(lint0, 0);

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
      attempt: 0,
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
      attempt: 0,
      ok: lint0.ok,
      violationsCount: lintTrace0.meta.violationsCount,
    }, "post_linter.completed");

    if (lintTrace0.violations.length > 0) {
      log.warn(lintTrace0.meta, "gate.post_lint_warning");
    }

    if (lint0.ok) {
      assistant = assistant0;
      outputEnvelope = envelope0Normalized;
      attemptsUsed = 1;
      if (attempt0.mementoDraft) {
        const m = putThreadMemento({
          threadId: packet.threadId,
          arc: attempt0.mementoDraft.arc || "Untitled",
          active: attempt0.mementoDraft.active ?? [],
          parked: attempt0.mementoDraft.parked ?? [],
          decisions: attempt0.mementoDraft.decisions ?? [],
          next: attempt0.mementoDraft.next ?? [],
        });
        threadMemento = m;
        log.info({ plane: "memento", threadId: packet.threadId, mementoId: m.id, source: "model" }, "control_plane.memento_auto_put");
      }
    } else {
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

        log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 2 }, "chat.responded");
        return respond(422, {
          error: "output_contract_failed",
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
          retryable: false,
          assistant: stubAssistant,
        });
      }

      const evidenceGate1 = await runEvidenceOutputGates({
        envelope: envelope1.envelope,
        attempt: 1,
        evidencePack,
        transmissionId: transmission.id,
      });

      if (!evidenceGate1.ok) {
        const stubAssistant = buildOutputContractStub();

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

        log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 2 }, "chat.responded");
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
        enforcementMode,
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
        if (attempt1.mementoDraft) {
          const m = putThreadMemento({
            threadId: packet.threadId,
            arc: attempt1.mementoDraft.arc || "Untitled",
            active: attempt1.mementoDraft.active ?? [],
            parked: attempt1.mementoDraft.parked ?? [],
            decisions: attempt1.mementoDraft.decisions ?? [],
            next: attempt1.mementoDraft.next ?? [],
          });
          threadMemento = m;
          log.info({ plane: "memento", threadId: packet.threadId, mementoId: m.id, source: "model" }, "control_plane.memento_auto_put");
        }
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

        log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 2 }, "chat.responded");
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

    const statusCode = err instanceof OpenAIProviderError ? err.statusCode : 500;
    const errorTag = statusCode === 502 ? "provider_upstream_failed" : "provider_failed";

    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode,
      retryable: true,
      errorCode: errorTag,
    });

    log.error({ error: String(err?.message ?? err) }, "provider.failed");

    return respond(statusCode, {
      error: errorTag,
      transmissionId: transmission.id,
      traceRunId: traceRun.id,
      retryable: true,
    });
  }

  await store.appendDeliveryAttempt({
    transmissionId: transmission.id,
    provider: llmProvider,
    status: "succeeded",
    outputChars: assistant.length,
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
  const responseEnvelope = buildOutputEnvelopeMeta({
    envelope: outputEnvelope!,
    personaLabel,
    notificationPolicy: resolvedNotificationPolicy,
  });

  log.info({ evt: "chat.responded", statusCode: 200, attemptsUsed }, "chat.responded");
  return respond(200, {
    ok: true,
    transmissionId: transmission.id,
    modeDecision,
    assistant,
    outputEnvelope: responseEnvelope,
    threadMemento,
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
