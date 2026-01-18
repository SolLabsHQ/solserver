import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";

type HealthRoutesOptions = {
  dbPath?: string;
};

export async function healthRoutes(app: FastifyInstance, opts: HealthRoutesOptions = {}) {
  const dbPath =
    opts.dbPath ?? process.env.CONTROL_PLANE_DB_PATH ?? process.env.DB_PATH ?? "./data/control_plane.db";
  const payload = () => ({
    ok: true,
    service: "solserver",
    ts: new Date().toISOString(),
  });

  app.get("/healthz", async () => payload());
  app.get("/health", async () => payload());
  app.get("/readyz", async (_req, reply) => {
    try {
      const db = new Database(dbPath);
      db.prepare("SELECT 1").get();
      db.close();
      return reply.send(payload());
    } catch (err) {
      const reason = String(err instanceof Error ? err.message : err).slice(0, 200);
      return reply.code(503).send({
        ok: false,
        service: "solserver",
        ts: new Date().toISOString(),
        reason,
      });
    }
  });
}
