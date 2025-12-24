import type { FastifyInstance } from "fastify";

import { PacketInput } from "../contracts/chat";
import { routeMode } from "../control-plane/router";
import { postOutputLinter } from "../gates/post_linter";
import { fakeModelReply } from "../providers/fake_model";
import type { ControlPlaneStore } from "../store/control_plane_store";
import { MemoryControlPlaneStore } from "../store/control_plane_store";

export async function chatRoutes(
  app: FastifyInstance,
  opts: { store?: ControlPlaneStore } = {}
) {
  const store = opts.store ?? new MemoryControlPlaneStore();

  // Explicit OPTIONS handler for predictable CORS preflight behavior.
  app.options("/chat", async (_req, reply) => reply.code(204).send());

  // Debug endpoint: inspect a transmission and its associated attempts/usage.
  app.get("/transmissions/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const transmission = await store.getTransmission(id);
    if (!transmission) {
      return reply.code(404).send({ error: "not_found" });
    }

    const attempts = await store.getDeliveryAttempts(id);
    const usage = await store.getUsage(id);

    return { ok: true, transmission, attempts, usage };
  });
 
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
            };
          }

          // Completed but no cached assistant (shouldn't happen) => treat as pending.
          return reply.code(202).send({
            ok: true,
            transmissionId: existing.id,
            status: existing.status,
            pending: true,
            idempotentReplay: true,
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

    // Dev/testing hook: force a 500 when requested.
    const simulate = String((req.headers as any)["x-sol-simulate-status"] ?? "");
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

    // Dev/testing hook: simulate an accepted-but-pending response (202).
    // This lets SolMobile validate "pending" behavior before we implement async delivery.
    if (simulate === "202") {
      return reply.code(202).send({
        ok: true,
        transmissionId: transmission.id,
        status: "created",
        pending: true,
        simulated: true,
      });
    }

    let assistant: string;

    try {
      assistant = await fakeModelReply({
        userText: packet.message,
        modeLabel: modeDecision.modeLabel,
      });

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

        return reply.code(500).send({
          error: "post_lint_failed",
          details: lint.error,
          transmissionId: transmission.id,
          retryable: false,
        });
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

    return {
      ok: true,
      transmissionId: transmission.id,
      modeDecision,
      assistant,
    };
  });
}