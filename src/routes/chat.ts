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
    const modeDecision = routeMode(packet);

    // Create a control-plane Transmission record up front.
    const transmission = await store.createTransmission({ packet, modeDecision });

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

        return reply.code(500).send({ error: "post_lint_failed", details: lint.error });
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

      return reply.code(500).send({ error: "provider_failed" });
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

    return {
      ok: true,
      transmissionId: transmission.id,
      modeDecision,
      assistant,
    };
  });
}