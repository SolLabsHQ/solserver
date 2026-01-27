import Fastify from "fastify";
import cors from "@fastify/cors";
import pino from "pino";
import { statSync } from "node:fs";
import { config as loadEnv } from "dotenv";

if (process.env.NODE_ENV !== "production") {
  loadEnv();
}

const isDev = process.env.NODE_ENV !== "production";

const app = Fastify({
  // We'll emit our own summary line via onResponse.
  disableRequestLogging: true,

  logger: {
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),

    // ISO timestamp instead of epoch millis.
    timestamp: pino.stdTimeFunctions.isoTime,

    // Optional pretty logs in dev (only if enabled and dependency is installed).
    ...(isDev && process.env.PINO_PRETTY === "1"
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              singleLine: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  },
});

// v0: one useful HTTP summary line for every request.
app.addHook("onRequest", async (req) => {
  (req as any).startNs = process.hrtime.bigint();
});

app.addHook("onResponse", async (req, reply) => {
  const route = (req as any).routerPath ?? req.url;
  if (route === "/healthz" || route === "/readyz") {
    return;
  }
  const startNs = (req as any).startNs as bigint | undefined;
  const endNs = process.hrtime.bigint();
  const responseTimeMs = startNs ? Number(endNs - startNs) / 1e6 : undefined;

  // Stitched in by routes (e.g., /v1/chat) for control-plane correlation.
  const transmissionId = reply.getHeader("x-sol-transmission-id") as string | undefined;

  req.log.info(
    {
      reqId: req.id,
      method: req.method,
      url: req.url,
      route: (req as any).routerPath ?? undefined,
      statusCode: reply.statusCode,
      responseTimeMs,
      transmissionId,
    },
    "http"
  );
});

import { healthRoutes } from "./routes/healthz";
import { chatRoutes } from "./routes/chat";
import { memoryRoutes } from "./routes/memories";
import { journalRoutes } from "./routes/journal";
import { traceRoutes } from "./routes/trace";
import { internalTopologyRoutes } from "./routes/internal/topology";
import { selectModel } from "./providers/provider_config";
import { SqliteControlPlaneStore } from "./store/sqlite_control_plane_store";

const dbPath =
  process.env.CONTROL_PLANE_DB_PATH ?? process.env.DB_PATH ?? "./data/control_plane.db";
const hasExplicitDbPath = Boolean(process.env.CONTROL_PLANE_DB_PATH || process.env.DB_PATH);

if (!isDev && !hasExplicitDbPath) {
  throw new Error("CONTROL_PLANE_DB_PATH must be set in non-dev environments.");
}

const getDbStat = (path: string): { exists: boolean; sizeBytes?: number; mtime?: string } => {
  try {
    const stat = statSync(path);
    return {
      exists: true,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
};
const store = new SqliteControlPlaneStore(dbPath, app.log);

async function main() {
  store.ensureTopologyKeyPrimary({ createdBy: "api" });

  // CORS (v0/dev): permissive. Tighten before prod.
  app.register(cors, {
    origin: true,
  });

  // Routes
  app.register(healthRoutes, { dbPath });
  app.register(chatRoutes, { prefix: "/v1", store });
  app.register(memoryRoutes, { prefix: "/v1", store });
  app.register(journalRoutes, { prefix: "/v1", store });
  app.register(traceRoutes, { prefix: "/v1", store });
  app.register(internalTopologyRoutes, { prefix: "/internal", store, dbPath });

  const llmProvider =
    (process.env.LLM_PROVIDER ?? "fake").toLowerCase() === "openai" ? "openai" : "fake";
  const modelSelection = selectModel({
    solEnv: process.env.SOL_ENV,
    nodeEnv: process.env.NODE_ENV,
    defaultModel: process.env.OPENAI_MODEL ?? "gpt-5-nano",
  });

  app.log.info(
    {
      evt: "llm.provider.config",
      provider: llmProvider,
      model: modelSelection.model,
      source: modelSelection.source,
      ...(modelSelection.tier ? { tier: modelSelection.tier } : {}),
    },
    "llm.provider.config"
  );

  const port = Number(process.env.PORT ?? 3333);
  const address = await app.listen({ port, host: "0.0.0.0" });

  app.log.info(
    { evt: "server.started", address, port, dbPath, dbStat: getDbStat(dbPath) },
    "server.started"
  );

  if (isDev) {
    app.log.info(
      {
        evt: "worker.reminder",
        hint: "If responses remain pending, start the worker: npm run dev:worker (or npm run dev:all).",
      },
      "worker.reminder"
    );
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
