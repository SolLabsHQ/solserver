import type { FastifyInstance } from "fastify";

import { z } from "zod";

import { PacketInput, type ModeDecision } from "../contracts/chat";
import { resolvePersonaLabel } from "../control-plane/router";
import {
  buildOutputEnvelopeMeta,
  resolveModeDecision,
  resolveNotificationPolicy,
  runOrchestrationPipeline,
  type SystemPersona,
} from "../control-plane/orchestrator";
import {
  getLatestThreadMemento,
  putThreadMemento,
  acceptThreadMemento,
  declineThreadMemento,
  revokeThreadMemento,
} from "../control-plane/retrieval";
import type { ControlPlaneStore } from "../store/control_plane_store";
import { MemoryControlPlaneStore } from "../store/control_plane_store";

export async function chatRoutes(
  app: FastifyInstance,
  opts: { store?: ControlPlaneStore } = {}
) {
  const store = opts.store ?? new MemoryControlPlaneStore();

  // Dev-only async completion guard for simulated 202 (prevents duplicate background timers per transmission).
  const pendingCompletions = new Set<string>();

  app.addHook("preHandler", async (req, reply) => {
    const apiKey = process.env.SOLSERVER_API_KEY;
    if (!apiKey) return;
    if (req.method === "OPTIONS") return;

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : undefined;
    if (!token || token !== apiKey) {
      reply.header("WWW-Authenticate", "Bearer");
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

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

    if (traceRun) {
      reply.header("x-sol-trace-run-id", traceRun.id);
    }

    const threadMemento = getLatestThreadMemento(transmission.threadId, { includeDraft: true });

    return {
      ok: true,
      transmission,
      pending: transmission.status === "created" || transmission.status === "processing",
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
    const simulateStatus = String((req.headers as any)["x-sol-simulate-status"] ?? "");
    const simulate = packet.simulate === true;
    const emptyEvidenceSummary = { captures: 0, supports: 0, claims: 0, warnings: 0 };
    const inlineProcessing = process.env.NODE_ENV === "test"
      || process.env.VITEST === "1"
      || process.env.VITEST === "true"
      || process.env.SOL_INLINE_PROCESSING === "1";

    const forcedPersonaRaw = (packet.meta as Record<string, any> | undefined)?.forced_persona;
    const forcedPersona = (typeof forcedPersonaRaw === "string"
      && ["ida", "sole", "cassandra", "diogenes", "system"].includes(forcedPersonaRaw))
      ? (forcedPersonaRaw as SystemPersona)
      : undefined;

    if (simulateStatus && !simulate) {
      req.log.info({ evt: "simulate.header_only", simulateStatus }, "simulate.header_only");
    }

    const setTransmissionHeader = (transmissionId: string) => {
      reply.header("x-sol-transmission-id", transmissionId);
    };

    const resolveStoredPolicy = async (existing: any, decision: ModeDecision) => {
      const personaLabel = resolvePersonaLabel(decision);
      const policy = existing.notificationPolicy ?? resolveNotificationPolicy({
        source: "api",
        simulate,
        requestedPolicy: packet.notification_policy,
        personaLabel,
        safetyIsUrgent: false,
      });

      if (!existing.notificationPolicy) {
        await store.updateTransmissionPolicy({
          transmissionId: existing.id,
          notificationPolicy: policy,
        });
        existing.notificationPolicy = policy;
      }

      return policy;
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
          const policy = await resolveStoredPolicy(existing, existing.modeDecision);
          return reply.code(409).send({
            error: "idempotency_conflict",
            transmissionId: existing.id,
            notification_policy: policy,
            ...(existing.forcedPersona ? { forced_persona: existing.forcedPersona } : {}),
          });
        }

        // Completed: replay cached assistant.
        if (existing.status === "completed") {
          const cached = await store.getChatResult(existing.id);
          if (cached) {
            setTransmissionHeader(existing.id);
            const policy = await resolveStoredPolicy(existing, existing.modeDecision);
            const replayEnvelope = buildOutputEnvelopeMeta({
              envelope: { assistant_text: cached.assistant },
              personaLabel: resolvePersonaLabel(existing.modeDecision),
              notificationPolicy: policy,
            });
            return {
              ok: true,
              transmissionId: existing.id,
              modeDecision: existing.modeDecision,
              assistant: cached.assistant,
              outputEnvelope: replayEnvelope,
              idempotentReplay: true,
              threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
              evidenceSummary: emptyEvidenceSummary,
              notification_policy: policy,
              ...(existing.forcedPersona ? { forced_persona: existing.forcedPersona } : {}),
            };
          }

          // Completed but no cached assistant (shouldn't happen) => treat as pending.
          setTransmissionHeader(existing.id);
          const policy = await resolveStoredPolicy(existing, existing.modeDecision);
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
            threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
            evidenceSummary: emptyEvidenceSummary,
            notification_policy: policy,
            ...(existing.forcedPersona ? { forced_persona: existing.forcedPersona } : {}),
          });
        }

        // Created/processing: treat as in-flight/pending.
        if (existing.status === "created" || existing.status === "processing") {
          setTransmissionHeader(existing.id);
          const policy = await resolveStoredPolicy(existing, existing.modeDecision);
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
            threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
            evidenceSummary: emptyEvidenceSummary,
            notification_policy: policy,
            ...(existing.forcedPersona ? { forced_persona: existing.forcedPersona } : {}),
          });
        }

        // Failed: allow retry. Reuse the existing transmission id + modeDecision.
        if (existing.status === "failed") {
          transmission = existing;
          modeDecision = existing.modeDecision;
          await resolveStoredPolicy(existing, existing.modeDecision);
          await store.updateTransmissionStatus({
            transmissionId: transmission.id,
            status: "created",
          });
        }
      }
    }

    // First attempt path (no existing transmission found)
    if (!transmission) {
      modeDecision = resolveModeDecision(packet, forcedPersona);
      const initialPolicy = resolveNotificationPolicy({
        source: "api",
        simulate,
        requestedPolicy: packet.notification_policy,
        personaLabel: resolvePersonaLabel(modeDecision),
        safetyIsUrgent: false,
      });
      // Create a control-plane Transmission record up front.
      transmission = await store.createTransmission({
        packet,
        modeDecision,
        notificationPolicy: initialPolicy,
        forcedPersona: forcedPersona ?? null,
      });
    }

    // Attach transmissionId for HTTP summary logs (onResponse hook reads this header).
    setTransmissionHeader(transmission.id);

    // --- Trace: Always-on (v0) ---
    // Create trace run for this transmission. Level defaults to "info", client may request "debug".
    const traceLevel = packet.traceConfig?.level ?? "info";
    const traceRun = await store.createTraceRun({
      transmissionId: transmission.id,
      level: traceLevel,
      personaLabel: resolvePersonaLabel(modeDecision),
    });

    reply.header("x-sol-trace-run-id", traceRun.id);

    if (!inlineProcessing) {
      const packetEvidence = packet.evidence ?? null;
      const evidenceSummary = {
        captures: packetEvidence?.captures?.length ?? 0,
        supports: packetEvidence?.supports?.length ?? 0,
        claims: packetEvidence?.claims?.length ?? 0,
        warnings: 0,
      };
      const policy = transmission.notificationPolicy ?? resolveNotificationPolicy({
        source: "api",
        simulate,
        requestedPolicy: packet.notification_policy,
        personaLabel: resolvePersonaLabel(modeDecision),
        safetyIsUrgent: false,
      });
      if (!transmission.notificationPolicy) {
        await store.updateTransmissionPolicy({
          transmissionId: transmission.id,
          notificationPolicy: policy,
        });
        transmission.notificationPolicy = policy;
      }

      req.log.info(
        { evt: "chat.enqueued", transmissionId: transmission.id },
        "chat.enqueued"
      );

      return reply.code(202).send({
        ok: true,
        transmissionId: transmission.id,
        status: transmission.status,
        pending: true,
        evidenceSummary,
        threadMemento: getLatestThreadMemento(packet.threadId, { includeDraft: true }),
        notification_policy: policy,
        ...(transmission.forcedPersona ? { forced_persona: transmission.forcedPersona } : {}),
      });
    }

    const result = await runOrchestrationPipeline({
      store,
      request: {
        source: "api",
        packet,
        simulate,
        forcedPersona,
      },
      transmission,
      modeDecision,
      traceRun,
      simulateStatus,
      req,
      log: req.log,
      pendingCompletions,
      allowAsyncSimulation: true,
    });

    return reply.code(result.statusCode).send(result.body);

  });
}
