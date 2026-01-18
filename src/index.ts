import Fastify from "fastify";
import cors from "@fastify/cors";
import pino from "pino";
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
import { selectModel } from "./providers/provider_config";
import { SqliteControlPlaneStore } from "./store/sqlite_control_plane_store";

const dbPath =
  process.env.CONTROL_PLANE_DB_PATH ?? process.env.DB_PATH ?? "./data/control_plane.db";
const store = new SqliteControlPlaneStore(dbPath);

async function main() {
  // CORS (v0/dev): permissive. Tighten before prod.
  app.register(cors, {
    origin: true,
  });

  // Routes
  app.register(healthRoutes, { dbPath });
  app.register(chatRoutes, { prefix: "/v1", store });

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
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
