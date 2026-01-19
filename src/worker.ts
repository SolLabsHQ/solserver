import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

import { config as loadEnv } from "dotenv";
import pino from "pino";

import { PacketInput, type PacketInput as PacketInputType } from "./contracts/chat";
import { processTransmission } from "./routes/chat";
import { SqliteControlPlaneStore } from "./store/sqlite_control_plane_store";
import type { Transmission } from "./store/control_plane_store";

if (process.env.NODE_ENV !== "production") {
  loadEnv();
}

const isDev = process.env.NODE_ENV !== "production";

const log = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  timestamp: pino.stdTimeFunctions.isoTime,
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
});

const dbPath =
  process.env.CONTROL_PLANE_DB_PATH ?? process.env.DB_PATH ?? "./data/control_plane.db";
const hasExplicitDbPath = Boolean(process.env.CONTROL_PLANE_DB_PATH || process.env.DB_PATH);

if (!isDev && !hasExplicitDbPath) {
  throw new Error("CONTROL_PLANE_DB_PATH must be set in non-dev environments.");
}
const leaseSeconds = Number(process.env.WORKER_LEASE_SECONDS ?? 120) || 120;
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 500) || 500;
const heartbeatEvery = Number(process.env.WORKER_HEARTBEAT_EVERY ?? 20) || 20;
const workerId = process.env.WORKER_ID ?? randomUUID();

const store = new SqliteControlPlaneStore(dbPath);

const pickFilter = {
  eligibleStatuses: ["created", "processing"] as const,
  packetType: "chat" as const,
  leaseCondition: "lease_expires_at IS NULL OR lease_expires_at < now",
};

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

function packetFromTransmission(tx: Transmission): PacketInputType {
  if (tx.packet) return tx.packet;

  if (tx.packetJson) {
    try {
      const parsed = JSON.parse(tx.packetJson);
      const parsedPacket = PacketInput.safeParse(parsed);
      if (parsedPacket.success) return parsedPacket.data;
    } catch (error) {
      log.warn({ transmissionId: tx.id, error: String(error) }, "worker.packet_json_invalid");
    }
  }

  const fallback = {
    packetType: "chat" as const,
    threadId: tx.threadId,
    clientRequestId: tx.clientRequestId,
    message: tx.message,
  };

  const parsedFallback = PacketInput.safeParse(fallback);
  if (!parsedFallback.success) {
    throw new Error("worker.packet_fallback_invalid");
  }

  return parsedFallback.data;
}

async function logHeartbeat(reason: "startup" | "poll") {
  const stats = await store.getLeaseableStats({
    eligibleStatuses: [...pickFilter.eligibleStatuses],
    packetType: pickFilter.packetType,
  });

  const oldestCreatedAgeMs = stats.oldestCreatedAt
    ? Date.now() - Date.parse(stats.oldestCreatedAt)
    : null;

  log.info(
    {
      evt: "worker.heartbeat",
      reason,
      dbPath,
      dbStat: getDbStat(dbPath),
      leaseableCount: stats.leaseableCount,
      oldestCreatedAgeMs,
      filter: pickFilter,
    },
    "worker.heartbeat"
  );
}

async function processOne(opts: { logIdle: boolean }) {
  const leased = await store.leaseNextTransmission({
    leaseOwner: workerId,
    leaseDurationSeconds: leaseSeconds,
    eligibleStatuses: [...pickFilter.eligibleStatuses],
    packetType: pickFilter.packetType,
  });

  if (!leased) {
    const payload = { evt: "worker.transmission.none", filter: pickFilter };
    log.debug(payload, "worker.transmission.none");
    if (opts.logIdle) {
      log.info(payload, "worker.transmission.none");
    }
    return;
  }

  const { transmission, previousStatus } = leased;
  log.info(
    { transmissionId: transmission.id, status: previousStatus, filter: pickFilter },
    "worker.transmission.picked"
  );
  log.info(
    { transmissionId: transmission.id, prevStatus: previousStatus, newStatus: "processing" },
    "worker.transmission.processing"
  );

  const packet = packetFromTransmission(transmission);
  const traceLevel = packet.traceConfig?.level ?? "info";

  let traceRun = await store.getTraceRunByTransmission(transmission.id);
  if (!traceRun) {
    traceRun = await store.createTraceRun({ transmissionId: transmission.id, level: traceLevel });
  }

  try {
    const result = await processTransmission({
      store,
      packet,
      transmission,
      modeDecision: transmission.modeDecision,
      traceRun,
      simulate: "",
      log,
      allowAsyncSimulation: false,
    });

    const outcome = result.statusCode >= 200 && result.statusCode < 300 ? "completed" : "failed";
    log.info(
      { transmissionId: transmission.id, statusCode: result.statusCode, outcome },
      "worker.transmission.done"
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const provider = (process.env.LLM_PROVIDER ?? "fake").toLowerCase() === "openai"
      ? "openai"
      : "fake";

    await store.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider,
      status: "failed",
      error: message,
    });

    await store.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
    });

    log.error({ transmissionId: transmission.id, error: message }, "worker.transmission.error");
  }
}

let running = false;
let pollCount = 0;

async function tick() {
  if (running) return;
  running = true;
  try {
    pollCount += 1;
    if (pollCount % heartbeatEvery === 0) {
      await logHeartbeat("poll");
    }
    const logIdle = pollCount % heartbeatEvery === 0;
    await processOne({ logIdle });
  } finally {
    running = false;
  }
}

log.info(
  {
    evt: "worker.started",
    workerId,
    dbPath,
    dbStat: getDbStat(dbPath),
    pollIntervalMs,
    leaseSeconds,
    heartbeatEvery,
  },
  "worker.started"
);

void logHeartbeat("startup");
tick();
setInterval(tick, pollIntervalMs);
