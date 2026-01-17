import type { FastifyInstance } from "fastify";

import { z } from "zod";

import { PacketInput } from "../contracts/chat";
import { OutputEnvelopeSchema, type OutputEnvelope } from "../contracts/output_envelope";
import { routeMode } from "../control-plane/router";
import { buildPromptPack, toSinglePromptText, promptPackLogShape, withCorrectionSection, type PromptPack } from "../control-plane/prompt_pack";
import { runGatesPipeline } from "../gates/gates_pipeline";
import {
  getLatestThreadMemento,
  putThreadMemento,
  acceptThreadMemento,
  declineThreadMemento,
  revokeThreadMemento,
  retrieveContext,
  retrievalLogShape,
} from "../control-plane/retrieval";
import { postOutputLinter, type PostLinterViolation } from "../gates/post_linter";
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
import type { ControlPlaneStore } from "../store/control_plane_store";
import { MemoryControlPlaneStore } from "../store/control_plane_store";

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
  reason?: "invalid_json" | "schema_invalid";
  errorSummary?: string;
  issuesCount?: number;
};

function buildOutputEnvelopeMetadata(args: {
  attempt: 0 | 1;
  ok: boolean;
  rawLength: number;
  reason?: "invalid_json" | "schema_invalid";
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

function formatOutputContractError(reason: "invalid_json" | "schema_invalid", issuesCount?: number): string {
  if (reason === "invalid_json") return "output_contract_failed:invalid_json";
  const count = typeof issuesCount === "number" ? issuesCount : 0;
  return `output_contract_failed:schema_invalid:issues=${count}`;
}

function applyEvidenceMeta(envelope: OutputEnvelope, evidencePack: EvidencePack | null): OutputEnvelope {
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

  return { ...envelope, meta };
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

export async function chatRoutes(
  app: FastifyInstance,
  opts: { store?: ControlPlaneStore } = {}
) {
  const store = opts.store ?? new MemoryControlPlaneStore();

  // Dev-only async completion guard for simulated 202 (prevents duplicate background timers per transmission).
  const pendingCompletions = new Set<string>();

  // Explicit OPTIONS handler for predictable CORS preflight behavior.
  app.options("/chat", async (_req, reply) => reply.code(204).send());

  // Preferred endpoint name (anti-drift): /memento.
  app.options("/memento", async (_req, reply) => reply.code(204).send());

  // Client decision endpoint: Accept / Decline / Revoke a draft memento.
  app.options("/memento/decision", async (_req, reply) => reply.code(204).send());

  // Back-compat alias: /cfb (historically used for "Conversation Fact Block").
  // NOTE: "CFB" is now reserved for Context Fact Block elsewhere in the design.
  app.options("/cfb", async (_req, reply) => reply.code(204).send());

  // Debug endpoint: inspect a transmission and its associated attempts/usage/result.
  app.get("/transmissions/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const transmission = await store.getTransmission(id);
    if (!transmission) {
      return reply.code(404).send({ error: "not_found" });
    }

    const attempts = await store.getDeliveryAttempts(id);
    const usage = await store.getUsage(id);
    const result = await store.getChatResult(id);
    const traceRun = await store.getTraceRunByTransmission(id);
    const traceSummary = traceRun ? await store.getTraceSummary(traceRun.id) : null;

    const threadMemento = getLatestThreadMemento(transmission.threadId, { includeDraft: true });

    return {
      ok: true,
      transmission,
      pending: transmission.status === "created",
      assistant: result?.assistant ?? null,
      attempts,
      usage,
      trace: traceRun
        ? {
            traceRunId: traceRun.id,
            level: traceRun.level,
            eventCount: traceSummary?.eventCount ?? 0,
            phaseCounts: traceSummary?.phaseCounts ?? {},
          }
        : null,
      threadMemento,
    };
  });

  // Evidence retrieval endpoints (PR #7)
  app.get("/transmissions/:id/evidence", async (req, reply) => {
    const transmissionId = (req.params as any).id as string;

    const evidence = await store.getEvidence({ transmissionId });

    if (!evidence) {
      return reply.code(404).send({ error: "not_found" });
    }

    return { ok: true, evidence };
  });

  app.get("/threads/:threadId/evidence", async (req, reply) => {
    const threadId = (req.params as any).threadId as string;
    const limit = Number((req.query as any)?.limit ?? 100);

    const results = await store.getEvidenceByThread({ threadId, limit });

    return { ok: true, results };
  });

  /**
   * ThreadMemento
   *
   * Anti-drift glossary:
   * - Context Fact Block (CFB): durable knowledge objects (authoritative | heuristic | umbra).
   * - ThreadMemento: lightweight thread navigation snapshot (arc/active/parked/decisions/next).
   *
   * v0.1 / v0.2:
   * - We store only the latest memento per thread (in memory).
   * - Retrieval attaches the latest memento summary into the PromptPack.
   *
   * Planned (v0.2+ hardening):
   * - Chain mementos via prevMementoId for deterministic replay and debugging.
   * - Persist to a real store instead of process memory.
   * - Add governance (auth, write audit, limits).
   */
  const ThreadMementoInput = z.object({
    threadId: z.string().min(1),
    arc: z.string().min(1),
    active: z.array(z.string()).default([]),
    parked: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    next: z.array(z.string()).default([]),
  });

  const ThreadMementoDecisionInput = z.object({
    threadId: z.string().min(1),
    mementoId: z.string().min(1),
    decision: z.enum(["accept", "decline", "revoke"]),
  });

  async function handleMementoDecision(req: any, reply: any) {
    const parsed = ThreadMementoDecisionInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const { threadId, mementoId, decision } = parsed.data;

    // Debug: verify body parsing and ids. Avoid logging any content.
    req.log.debug(
      {
        plane: "memento",
        decision,
        threadId,
        mementoId,
        hasMementoId: Boolean(mementoId),
        bodyKeys: req?.body && typeof req.body === "object" ? Object.keys(req.body) : [],
      },
      "control_plane.memento_decision_input"
    );

    // Apply decision against the current memento state.
    // Idempotency behavior:
    // - accept: if already accepted/current, return it with applied=false
    // - decline: discards the latest *draft*; does not touch an accepted memento
    // - revoke: removes the currently accepted memento (undo). If already revoked, applied=false
    // - for missing/unknown ids, return applied=false and memento=null

    const appliedResult =
      decision === "accept"
        ? acceptThreadMemento({ threadId, mementoId })
        : decision === "decline"
          ? declineThreadMemento({ threadId, mementoId })
          : revokeThreadMemento({ threadId, mementoId });

    const applied = Boolean(appliedResult);

    let reason:
      | "applied"
      | "already_accepted"
      | "already_accepted_not_declined"
      | "already_revoked"
      | "not_found" = "applied";

    // Response shape by decision:
    // - accept: return the accepted/current memento
    // - decline: return null when a draft is discarded
    // - revoke: return the revoked (previously accepted) memento so the client can render what was undone
    let memento =
      decision === "accept"
        ? (appliedResult ?? null)
        : decision === "revoke"
          ? (appliedResult ?? null)
          : null;

    if (!applied) {
      // If not applied, check whether this is an idempotent replay.
      // NOTE: v0 uses in-memory storage; depending on current implementation,
      // the "latest" memento may still be considered a draft.
      // We includeDraft here to support safe replay semantics.
      const latestAny = getLatestThreadMemento(threadId, { includeDraft: true });

      req.log.debug(
        {
          plane: "memento",
          threadId,
          requestedMementoId: mementoId,
          latestAnyId: latestAny?.id ?? null,
          foundLatestAny: Boolean(latestAny),
          // Best-effort: some implementations may include `isDraft`.
          latestAnyIsDraft: (latestAny as any)?.isDraft ?? null,
        },
        "control_plane.memento_decision_lookup"
      );

      if (latestAny && latestAny.id === mementoId) {
        if (decision === "accept") {
          reason = "already_accepted";
          memento = latestAny;
        } else if (decision === "decline") {
          // Decline does not override a current/accepted memento.
          reason = "already_accepted_not_declined";
          memento = latestAny;
        } else {
          // Revoke against an already-revoked/nonexistent accepted memento is a no-op.
          reason = "already_revoked";
          memento = latestAny;
        }
      } else {
        reason = "not_found";
      }
    }

    req.log.info(
      {
        plane: "memento",
        threadId,
        mementoId,
        decision,
        applied,
        reason,
      },
      "control_plane.memento_decision"
    );

    return { ok: true, decision, applied, reason, memento };
  }

  async function handlePutMemento(req: any, reply: any) {
    const parsed = ThreadMementoInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const data = parsed.data;

    // v0.1: in-process write (latest wins). This is enough to validate retrieval wiring.
    // Later: this becomes an authenticated control-plane write that persists.
    const memento = putThreadMemento({
      threadId: data.threadId,
      arc: data.arc,
      active: data.active,
      parked: data.parked,
      decisions: data.decisions,
      next: data.next,
    });

    req.log.info(
      {
        plane: "memento",
        threadId: data.threadId,
        mementoId: memento.id,
        version: memento.version,
      },
      "control_plane.memento_put"
    );

    return { ok: true, memento };
  }

  // Read the latest memento for a thread.
  // Usage: GET /v1/memento?threadId=t1
  app.get("/memento", async (req, reply) => {
    const threadId = String((req.query as any)?.threadId ?? "");
    if (!threadId) {
      return reply.code(400).send({ error: "invalid_request", details: { threadId: "required" } });
    }

    const includeDraftRaw = String((req.query as any)?.includeDraft ?? "").toLowerCase();
    const includeDraft = includeDraftRaw === "1" || includeDraftRaw === "true";

    const memento = getLatestThreadMemento(threadId, { includeDraft });

    req.log.debug(
      {
        plane: "memento",
        threadId,
        mementoId: memento?.id ?? null,
        found: Boolean(memento),
      },
      "control_plane.memento_get"
    );

    return { ok: true, memento };
  });

  // Preferred endpoint name.
  app.post("/memento", handlePutMemento);

  // Back-compat alias.
  app.post("/cfb", handlePutMemento);

  // Client decision endpoint: Accept / Decline the latest draft memento.
  app.post("/memento/decision", handleMementoDecision);
 
  app.post("/chat", async (req, reply) => {
    const parsed = PacketInput.safeParse(req.body);
    if (!parsed.success) {
      const unrecognized = new Set<string>();
      for (const issue of parsed.error.issues) {
        if (issue.code === "unrecognized_keys") {
          for (const key of issue.keys) {
            unrecognized.add(key);
          }
        }
      }

      if (unrecognized.size > 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Unrecognized keys in request",
          unrecognizedKeys: Array.from(unrecognized),
        });
      }

      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const packet = parsed.data;
    const simulate = String((req.headers as any)["x-sol-simulate-status"] ?? "");
    const emptyEvidenceSummary = { captures: 0, supports: 0, claims: 0, warnings: 0 };

    const setTransmissionHeader = (transmissionId: string) => {
      reply.header("x-sol-transmission-id", transmissionId);
    };

    // --- Idempotency + retry semantics ---
    // If clientRequestId is provided, we dedupe retries. Behavior by stored status:
    // - completed: replay cached assistant (200)
    // - created: in-flight/pending (202)
    // - failed: allow retry (re-run provider) using SAME transmission id
    let transmission: any | null = null;
    let modeDecision: any;

    if (packet.clientRequestId) {
      const existing = await store.getTransmissionByClientRequestId(packet.clientRequestId);

      if (existing) {
        // Guard: same idempotency key must not be reused for a different payload.
        if (existing.threadId !== packet.threadId || existing.message !== packet.message) {
          setTransmissionHeader(existing.id);
          return reply.code(409).send({
            error: "idempotency_conflict",
            transmissionId: existing.id,
          });
        }

        // Completed: replay cached assistant.
        if (existing.status === "completed") {
          const cached = await store.getChatResult(existing.id);
          if (cached) {
            setTransmissionHeader(existing.id);
            return {
              ok: true,
              transmissionId: existing.id,
              modeDecision: existing.modeDecision,
              assistant: cached.assistant,
              outputEnvelope: { assistant_text: cached.assistant },
              idempotentReplay: true,
              threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
              evidenceSummary: emptyEvidenceSummary,
            };
          }

          // Completed but no cached assistant (shouldn't happen) => treat as pending.
          setTransmissionHeader(existing.id);
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
            threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
            evidenceSummary: emptyEvidenceSummary,
          });
        }

        // Created: treat as in-flight/pending.
        if (existing.status === "created") {
          setTransmissionHeader(existing.id);
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
            threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
            evidenceSummary: emptyEvidenceSummary,
          });
        }

        // Failed: allow retry. Reuse the existing transmission id + modeDecision.
        if (existing.status === "failed") {
          transmission = existing;
          modeDecision = existing.modeDecision;
          await store.updateTransmissionStatus({
            transmissionId: transmission.id,
            status: "created",
          });
        }
      }
    }

    // First attempt path (no existing transmission found)
    if (!transmission) {
      modeDecision = routeMode(packet);
      // Create a control-plane Transmission record up front.
      transmission = await store.createTransmission({ packet, modeDecision });
    }

    // Attach transmissionId for HTTP summary logs (onResponse hook reads this header).
    setTransmissionHeader(transmission.id);

    // --- Trace: Always-on (v0) ---
    // Create trace run for this transmission. Level defaults to "info", client may request "debug".
    const traceLevel = packet.traceConfig?.level ?? "info";
    const traceRun = await store.createTraceRun({
      transmissionId: transmission.id,
      level: traceLevel,
    });

    reply.header("x-sol-trace-run-id", traceRun.id);

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

    const parseOutputEnvelope = async (args: {
      rawText: string;
      attempt: 0 | 1;
    }): Promise<{ ok: true; envelope: OutputEnvelope } | { ok: false; reason: "invalid_json" | "schema_invalid"; issuesCount?: number }> => {
      const rawLength = args.rawText.length;

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
    }): Promise<{ ok: true; envelope: OutputEnvelope } | { ok: false; code: EvidenceGateErrorCode }> => {
      const normalized = applyEvidenceMeta(args.envelope, args.evidencePack);
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
    const log = req.log.child({
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
      });

      log.info({ evt: "chat.responded", statusCode: 500, attemptsUsed: 0 }, "chat.responded");
      return reply.code(500).send({
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
        });

        log.info({ evt: "chat.responded", statusCode: 400, attemptsUsed: 0 }, "chat.responded");
        return reply.code(400).send(error.toJSON());
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
      ...(modelSelection.tier ? { tier: modelSelection.tier } : {}),
    }, "llm.provider.selected");

    // Run gates pipeline
    const gatesOutput = runGatesPipeline(packet);

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

    const phaseByGateName: Record<string, "gate_normalize_modality" | "gate_intent_risk" | "gate_lattice"> = {
      normalize_modality: "gate_normalize_modality",
      intent_risk: "gate_intent_risk",
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
      });

      log.info({ evt: "chat.responded", statusCode: 500, attemptsUsed: 0 }, "chat.responded");
      return reply.code(500).send({
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
      });

      log.error({ error: message, errorCode }, "evidence_provider.failed");
      log.info({ evt: "chat.responded", statusCode: 500, attemptsUsed: 0 }, "chat.responded");
      return reply.code(500).send({
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
    // SolMobile can poll GET /transmissions/:id to observe created -> completed and fetch assistant.
    if (simulate === "202") {
      const transmissionId = transmission.id;

      if (!pendingCompletions.has(transmissionId)) {
        pendingCompletions.add(transmissionId);

        const bgLog = app.log.child({
          plane: "chat",
          transmissionId,
          threadId: packet.threadId,
          clientRequestId: packet.clientRequestId ?? undefined,
          modeLabel: modeDecision?.modeLabel ?? undefined,
          traceRunId: traceRun.id,
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
            if (current.status !== "created") {
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
              modeLabel: modeDecision.modeLabel,
              content: assistant0,
              driverBlocks: promptPack.driverBlocks,
            });

            const lintMeta0 = buildPostLinterMetadata(lint0.ok ? [] : lint0.violations, 0);

            await appendTrace({
              traceRunId: traceRun.id,
              transmissionId: transmission.id,
              actor: "solserver",
              phase: "output_gates",
              status: lint0.ok ? "completed" : "warning",
              summary: lint0.ok
                ? "Output linter passed"
                : `Output linter warning: ${lintMeta0.violationsCount} violations`,
              metadata: lintMeta0,
            });

            bgLog.debug({
              evt: "post_linter.completed",
              attempt: 0,
              ok: lint0.ok,
              violationsCount: lintMeta0.violationsCount,
            }, "post_linter.completed");

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
              modeLabel: modeDecision.modeLabel,
              content: assistant1,
              driverBlocks: promptPack.driverBlocks,
            });

            const lintMeta1 = buildPostLinterMetadata(lint1.ok ? [] : lint1.violations, 1);

            await appendTrace({
              traceRunId: traceRun.id,
              transmissionId: transmission.id,
              actor: "solserver",
              phase: "output_gates",
              status: lint1.ok ? "completed" : "warning",
              summary: lint1.ok
                ? "Output linter passed"
                : `Output linter warning: ${lintMeta1.violationsCount} violations`,
              metadata: lintMeta1,
            });

            bgLog.debug({
              evt: "post_linter.completed",
              attempt: 1,
              ok: lint1.ok,
              violationsCount: lintMeta1.violationsCount,
            }, "post_linter.completed");

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
              summary: "Driver block enforcement failed (async)",
              metadata: {
                kind: "driver_block_enforcement",
                outcome: "fail_closed_422",
                attempts: 2,
                violationsCount: lintMeta1.violationsCount,
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

            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
              statusCode: 422,
              retryable: false,
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
            });

            bgLog.info({ evt: "chat.async.failed" }, "chat.async.failed");
            bgLog.error({ error: msg }, "provider.failed_async");
          } finally {
            pendingCompletions.delete(transmissionId);
          }
        }, delayMs);

      }

      log.info({ evt: "chat.responded", statusCode: 202, attemptsUsed: 0 }, "chat.responded");
      return reply.code(202).send({
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
          rawLength: attempt0.rawText.length,
        }, "output_envelope.completed");
      } else {
        log.info({
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
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 1 }, "chat.responded");
        return reply.code(422).send({
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
        });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 1 }, "chat.responded");
        return reply.code(422).send(buildEvidenceGateFailureResponse({
          code: evidenceGate0.code,
          transmissionId: transmission.id,
          traceRunId: traceRun.id,
        }));
      }

      const assistant0 = evidenceGate0.envelope.assistant_text;
      const envelope0Normalized = evidenceGate0.envelope;

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
        modeLabel: modeDecision.modeLabel,
        content: assistant0,
        driverBlocks: promptPack.driverBlocks,
      });

      const lintMeta0 = buildPostLinterMetadata(lint0.ok ? [] : lint0.violations, 0);

      await appendTrace({
        traceRunId: traceRun.id,
        transmissionId: transmission.id,
        actor: "solserver",
        phase: "output_gates",
        status: lint0.ok ? "completed" : "warning",
        summary: lint0.ok
          ? "Output linter passed"
          : `Output linter warning: ${lintMeta0.violationsCount} violations`,
        metadata: lintMeta0,
      });

      log.debug({
        evt: "post_linter.completed",
        attempt: 0,
        ok: lint0.ok,
        violationsCount: lintMeta0.violationsCount,
      }, "post_linter.completed");

      if (!lint0.ok) {
        log.warn(lintMeta0, "gate.post_lint_warning");
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
          rawLength: attempt1.rawText.length,
        }, "output_envelope.completed");
      } else {
        log.info({
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
          });

        await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

        log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 2 }, "chat.responded");
        return reply.code(422).send({
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
          });

          await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

          log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 2 }, "chat.responded");
          return reply.code(422).send(buildEvidenceGateFailureResponse({
            code: evidenceGate1.code,
            transmissionId: transmission.id,
            traceRunId: traceRun.id,
          }));
        }

        const assistant1 = evidenceGate1.envelope.assistant_text;
        const envelope1Normalized = evidenceGate1.envelope;

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
          modeLabel: modeDecision.modeLabel,
          content: assistant1,
          driverBlocks: promptPack.driverBlocks,
        });

        const lintMeta1 = buildPostLinterMetadata(lint1.ok ? [] : lint1.violations, 1);

        await appendTrace({
          traceRunId: traceRun.id,
          transmissionId: transmission.id,
          actor: "solserver",
          phase: "output_gates",
          status: lint1.ok ? "completed" : "warning",
          summary: lint1.ok
            ? "Output linter passed"
            : `Output linter warning: ${lintMeta1.violationsCount} violations`,
          metadata: lintMeta1,
        });

        log.debug({
          evt: "post_linter.completed",
          attempt: 1,
          ok: lint1.ok,
          violationsCount: lintMeta1.violationsCount,
        }, "post_linter.completed");

        if (!lint1.ok) {
          log.warn(lintMeta1, "gate.post_lint_warning");
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
              violationsCount: lintMeta1.violationsCount,
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

          await store.updateTransmissionStatus({
            transmissionId: transmission.id,
            status: "failed",
            statusCode: 422,
            retryable: false,
          });

          await store.setChatResult({ transmissionId: transmission.id, assistant: stubAssistant });

          log.info({ evt: "chat.responded", statusCode: 422, attemptsUsed: 2 }, "chat.responded");
          return reply.code(422).send({
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

      await store.updateTransmissionStatus({
        transmissionId: transmission.id,
        status: "failed",
      });

      const statusCode = err instanceof OpenAIProviderError ? err.statusCode : 500;
      const errorTag = statusCode === 502 ? "provider_upstream_failed" : "provider_failed";

      log.error({ error: String(err?.message ?? err) }, "provider.failed");

      return reply.code(statusCode).send({
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

    log.info({ evt: "chat.responded", statusCode: 200, attemptsUsed }, "chat.responded");
    return {
      ok: true,
      transmissionId: transmission.id,
      modeDecision,
      assistant,
      outputEnvelope,
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
    };
  });
}
