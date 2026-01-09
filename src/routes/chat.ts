import type { FastifyInstance } from "fastify";

import { z } from "zod";

import { PacketInput } from "../contracts/chat";
import { routeMode } from "../control-plane/router";
import {
  buildPromptPack,
  promptPackLogShape,
  toSinglePromptText,
} from "../control-plane/prompt_pack";
import {
  getLatestThreadMemento,
  putThreadMemento,
  acceptThreadMemento,
  declineThreadMemento,
  revokeThreadMemento,
  retrieveContext,
  retrievalLogShape,
} from "../control-plane/retrieval";
import { postOutputLinter } from "../gates/post_linter";
import { fakeModelReplyWithMeta } from "../providers/fake_model";
import type { ControlPlaneStore } from "../store/control_plane_store";
import { MemoryControlPlaneStore } from "../store/control_plane_store";

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

    const threadMemento = getLatestThreadMemento(transmission.threadId, { includeDraft: true });

    return {
      ok: true,
      transmission,
      pending: transmission.status === "created",
      assistant: result?.assistant ?? null,
      attempts,
      usage,
      threadMemento,
    };
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
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const packet = parsed.data;

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
          return reply.code(409).send({
            error: "idempotency_conflict",
            transmissionId: existing.id,
          });
        }

        // Completed: replay cached assistant.
        if (existing.status === "completed") {
          const cached = await store.getChatResult(existing.id);
          if (cached) {
            return {
              ok: true,
              transmissionId: existing.id,
              modeDecision: existing.modeDecision,
              assistant: cached.assistant,
              idempotentReplay: true,
              threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
            };
          }

          // Completed but no cached assistant (shouldn't happen) => treat as pending.
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
            threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
          });
        }

        // Created: treat as in-flight/pending.
        if (existing.status === "created") {
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
            threadMemento: getLatestThreadMemento(existing.threadId, { includeDraft: true }),
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
    reply.header("x-sol-transmission-id", transmission.id);

    // Route-scoped logger for control-plane tracing (keeps logs searchable).
    const log = req.log.child({
      plane: "chat",
      transmissionId: transmission.id,
      threadId: packet.threadId,
      clientRequestId: packet.clientRequestId ?? undefined,
      modeLabel: modeDecision?.modeLabel ?? undefined,
    });

    log.debug({
      idempotency: Boolean(packet.clientRequestId),
      status: transmission.status,
      domainFlags: modeDecision?.domainFlags ?? [],
    }, "control_plane.transmission_ready");

    // Dev/testing hook: force a 500 when requested.
    const simulate = String((req.headers as any)["x-sol-simulate-status"] ?? "");
    if (simulate) {
      log.info({ simulate }, "simulate_status");
    }
    if (simulate === "500") {
      await store.appendDeliveryAttempt({
        transmissionId: transmission.id,
        provider: "fake",
        status: "failed",
        error: "simulated_500",
      });

      await store.updateTransmissionStatus({
        transmissionId: transmission.id,
        status: "failed",
      });

      return reply.code(500).send({
        error: "simulated_failure",
        transmissionId: transmission.id,
        retryable: true,
      });
    }

    // --- Step 6: Prompt assembly stub (mounted law + retrieval slot) ---
    // We build the PromptPack even when using the fake provider so OpenAI wiring is a swap, not a rewrite.
    const retrievalItems = await retrieveContext({
      threadId: packet.threadId,
      packetType: packet.packetType,
      message: packet.message,
    });

    log.debug(retrievalLogShape(retrievalItems), "control_plane.retrieval");

    const promptPack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems,
    });

    log.debug(promptPackLogShape(promptPack), "control_plane.prompt_pack");

    // Provider input for v0: one stable string with headers.
    // We do not log the content here.
    const providerInputText = toSinglePromptText(promptPack);

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
          async: true,
        });

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

            const meta = await fakeModelReplyWithMeta({
              userText: providerInputText,
              modeLabel: modeDecision.modeLabel,
            });

            const assistant = meta.assistant;

            const lint = postOutputLinter({
              modeLabel: modeDecision.modeLabel,
              content: assistant,
            });

            if (!lint.ok) {
              await store.appendDeliveryAttempt({
                transmissionId,
                provider: "fake",
                status: "failed",
                error: lint.error,
              });

              await store.updateTransmissionStatus({
                transmissionId,
                status: "failed",
              });

              bgLog.warn({ error: lint.error }, "gate.post_lint_failed_async");
              return;
            }

            // Option 1: model-proposed ThreadMemento draft.
            // We store it temporarily (in-memory) as a navigation artifact.
            // Client may display this and offer Undo.
            if (meta.mementoDraft) {
              const m = putThreadMemento({
                threadId: packet.threadId,
                arc: meta.mementoDraft.arc || "Untitled",
                active: meta.mementoDraft.active ?? [],
                parked: meta.mementoDraft.parked ?? [],
                decisions: meta.mementoDraft.decisions ?? [],
                next: meta.mementoDraft.next ?? [],
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
              provider: "fake",
              status: "succeeded",
              outputChars: assistant.length,
            });

            await store.recordUsage({
              transmissionId,
              inputChars: packet.message.length,
              outputChars: assistant.length,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "completed",
            });

            await store.setChatResult({ transmissionId, assistant });

            bgLog.info({ status: "completed", outputChars: assistant.length }, "delivery.completed_async");
          } catch (err: any) {
            const msg = String(err?.message ?? err);

            await store.appendDeliveryAttempt({
              transmissionId,
              provider: "fake",
              status: "failed",
              error: msg,
            });

            await store.updateTransmissionStatus({
              transmissionId,
              status: "failed",
            });

            bgLog.error({ error: msg }, "provider.failed_async");
          } finally {
            pendingCompletions.delete(transmissionId);
          }
        }, delayMs);
      }

      return reply.code(202).send({
        ok: true,
        transmissionId,
        status: "created",
        pending: true,
        simulated: true,
        checkAfterMs: 750,
        threadMemento: getLatestThreadMemento(packet.threadId, { includeDraft: true }),
      });
    }

    let assistant: string;
    let threadMemento: any = null;

    try {
      const meta = await fakeModelReplyWithMeta({
        userText: providerInputText,
        modeLabel: modeDecision.modeLabel,
      });

      assistant = meta.assistant;

      const lint = postOutputLinter({ modeLabel: modeDecision.modeLabel, content: assistant });
      if (!lint.ok) {
        await store.appendDeliveryAttempt({
          transmissionId: transmission.id,
          provider: "fake",
          status: "failed",
          error: lint.error,
        });

        await store.updateTransmissionStatus({
          transmissionId: transmission.id,
          status: "failed",
        });

        log.warn({ error: lint.error }, "gate.post_lint_failed");

        return reply.code(500).send({
          error: "post_lint_failed",
          details: lint.error,
          transmissionId: transmission.id,
          retryable: false,
        });
      }

      // Option 1: model-proposed ThreadMemento draft.
      // We store it temporarily (in-memory) as a navigation artifact.
      // Client may display this and offer Undo.
      if (meta.mementoDraft) {
        const m = putThreadMemento({
          threadId: packet.threadId,
          arc: meta.mementoDraft.arc || "Untitled",
          active: meta.mementoDraft.active ?? [],
          parked: meta.mementoDraft.parked ?? [],
          decisions: meta.mementoDraft.decisions ?? [],
          next: meta.mementoDraft.next ?? [],
        });

        threadMemento = m;

        log.info(
          {
            plane: "memento",
            threadId: packet.threadId,
            mementoId: m.id,
            source: "model",
          },
          "control_plane.memento_auto_put"
        );
      }
    } catch (err: any) {
      await store.appendDeliveryAttempt({
        transmissionId: transmission.id,
        provider: "fake",
        status: "failed",
        error: String(err?.message ?? err),
      });

      await store.updateTransmissionStatus({
        transmissionId: transmission.id,
        status: "failed",
      });

      log.error({ error: String(err?.message ?? err) }, "provider.failed");

      return reply.code(500).send({
        error: "provider_failed",
        transmissionId: transmission.id,
        retryable: true,
      });
    }

    await store.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider: "fake",
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

    return {
      ok: true,
      transmissionId: transmission.id,
      modeDecision,
      assistant,
      threadMemento,
    };
  });
}