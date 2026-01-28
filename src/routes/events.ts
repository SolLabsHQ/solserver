import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { buildSSEEnvelope, sseHub } from "../sse/sse_hub";

const getUserId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const header = req.headers["x-sol-user-id"] ?? req.headers["x-user-id"];
  if (Array.isArray(header)) {
    return header[0]?.trim() ?? null;
  }
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  return null;
};

export async function eventsRoutes(app: FastifyInstance) {
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

  app.options("/events", async (_req, reply) => reply.code(204).send());

  app.get("/events", async (req, reply) => {
    const userId = getUserId(req as any);
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    reply
      .header("Content-Type", "text/event-stream")
      .header("Cache-Control", "no-cache")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");
    reply.raw.flushHeaders?.();

    const connId = randomUUID();
    const connection = {
      id: connId,
      userId,
      createdAtMs: Date.now(),
      reply,
      log: req.log,
    };
    sseHub.registerConnection(connection);

    req.raw.on("close", () => {
      sseHub.removeConnection(userId, connId, "client_closed");
    });

    const ping = buildSSEEnvelope({
      kind: "ping",
      subject: { type: "none" },
      payload: {},
    });

    sseHub.publishToConnection(connection, ping);

    return reply;
  });
}
