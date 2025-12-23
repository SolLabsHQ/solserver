import type { FastifyInstance } from "fastify";
import { PacketInput } from "../contracts/chat";
import { routeMode } from "../control-plane/router";
import { postOutputLinter } from "../gates/post_linter";
import { fakeModelReply } from "../providers/fake_model";

export async function chatRoutes(app: FastifyInstance) {
  // This makes your CORS preflight happy (you saw OPTIONS 404 before).
  app.options("/chat", async (_req, reply) => reply.code(204).send());

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

    const assistant = await fakeModelReply({
      userText: packet.message,
      modeLabel: modeDecision.modeLabel,
    });

    const lint = postOutputLinter({ modeLabel: modeDecision.modeLabel, content: assistant });
    if (!lint.ok) {
      return reply.code(500).send({ error: "post_lint_failed", details: lint.error });
    }

    return { ok: true, modeDecision, assistant };
  });
}