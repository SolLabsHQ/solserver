import type { FastifyInstance } from "fastify";

import type { SqliteControlPlaneStore } from "../../store/sqlite_control_plane_store";

type InternalTopologyOptions = {
  store: SqliteControlPlaneStore;
  dbPath?: string;
};

export async function internalTopologyRoutes(
  app: FastifyInstance,
  opts: InternalTopologyOptions
) {
  app.get("/topology", async (req, reply) => {
    const isFly = Boolean(process.env.FLY_APP_NAME);
    const isProd = process.env.NODE_ENV === "production" || isFly;
    const expectedToken = process.env.SOL_INTERNAL_TOKEN ?? "";
    const providedToken = req.headers["x-sol-internal-token"];
    const requestIp = req.ip;
    const isLocal =
      requestIp === "127.0.0.1"
      || requestIp === "::1"
      || requestIp === "::ffff:127.0.0.1";

    if (!expectedToken) {
      if (isProd) {
        app.log.error(
          { evt: "topology.guard.internal_token_missing" },
          "topology.guard.internal_token_missing"
        );
        return reply.code(403).send({ error: "forbidden" });
      }

      if (!isLocal) {
        return reply.code(403).send({ error: "forbidden" });
      }
    } else {
      if (!providedToken) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      if (String(providedToken) !== expectedToken) {
        return reply.code(403).send({ error: "forbidden" });
      }
    }

    const meta = opts.store.readTopologyKey();
    if (!meta) {
      return reply.code(404).send({ error: "topology_key_missing" });
    }

    return reply.send({
      topologyKey: meta.topologyKey,
      createdAtMs: meta.createdAtMs,
      createdBy: meta.createdBy,
      ...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
    });
  });
}
