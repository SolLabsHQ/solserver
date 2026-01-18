import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  const payload = () => ({
    ok: true,
    service: "solserver",
    ts: new Date().toISOString(),
  });

  app.get("/healthz", async () => payload());
  app.get("/health", async () => payload());
}
