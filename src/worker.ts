import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { config as loadEnv } from "dotenv";
import pino from "pino";

import { PacketInput, type PacketInput as PacketInputType } from "./contracts/chat";
import { resolvePersonaLabel } from "./control-plane/router";
import { processTransmission } from "./routes/chat";
import { SqliteControlPlaneStore } from "./store/sqlite_control_plane_store";
import type { Transmission } from "./store/control_plane_store";
import { runTopologyHandshake } from "./topology/worker_handshake";

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
const leaseAttemptLimit = Number(process.env.WORKER_LEASE_ATTEMPTS ?? 5) || 5;
const emptyScanLimit = Number(process.env.WORKER_EMPTY_SCANS ?? 2) || 2;
const jitterMinMs = Number(process.env.WORKER_LEASE_JITTER_MIN_MS ?? 10) || 10;
const jitterMaxMs = Number(process.env.WORKER_LEASE_JITTER_MAX_MS ?? 50) || 50;

const resolveInternalApiBase = () => {
  const base = process.env.SOL_INTERNAL_API_BASE;
  if (base) return base;
  const port = Number(process.env.PORT ?? 3333) || 3333;
  return `http://127.0.0.1:${port}`;
};

const pickFilter = {
  eligibleStatuses: ["created", "processing"] as const,
  packetType: "chat" as const,
  leaseCondition: "lease_expires_at IS NULL OR lease_expires_at < now",
};

let leaseAttempts = 0;
let leaseWins = 0;
let leaseContention = 0;
let leaseEmpty = 0;
let store: SqliteControlPlaneStore | null = null;

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

const requireStore = (): SqliteControlPlaneStore => {
  if (!store) {
    throw new Error("worker.store_not_initialized");
  }
  return store;
};

async function logHeartbeat(reason: "startup" | "poll") {
  const activeStore = requireStore();
  const stats = await activeStore.getLeaseableStats({
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
      leaseStats: {
        attempts: leaseAttempts,
        wins: leaseWins,
        contention: leaseContention,
        empty: leaseEmpty,
      },
    },
    "worker.heartbeat"
  );
}

async function processOne(opts: { logIdle: boolean }) {
  const activeStore = requireStore();
  let leased: Awaited<ReturnType<SqliteControlPlaneStore["leaseNextTransmission"]>> | null = null;
  let emptyScans = 0;
  let lastOutcome: "empty" | "contention" = "empty";

  for (let attempt = 1; attempt <= leaseAttemptLimit; attempt += 1) {
    leaseAttempts += 1;
    leased = await activeStore.leaseNextTransmission({
      leaseOwner: workerId,
      leaseDurationSeconds: leaseSeconds,
      eligibleStatuses: [...pickFilter.eligibleStatuses],
      packetType: pickFilter.packetType,
    });

    if (leased.outcome === "leased") {
      leaseWins += 1;
      break;
    }

    if (leased.outcome === "contention") {
      leaseContention += 1;
      lastOutcome = "contention";
    } else {
      leaseEmpty += 1;
      emptyScans += 1;
      lastOutcome = "empty";
      if (emptyScans >= emptyScanLimit) {
        leased = null;
        break;
      }
    }

    const jitter = Math.max(
      0,
      jitterMinMs + Math.floor(Math.random() * Math.max(1, jitterMaxMs - jitterMinMs + 1))
    );
    await sleep(jitter);
  }

  if (!leased || leased.outcome !== "leased") {
    const payload = { evt: "worker.transmission.none", filter: pickFilter, reason: lastOutcome };
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

  let traceRun = await activeStore.getTraceRunByTransmission(transmission.id);
  if (!traceRun) {
    traceRun = await activeStore.createTraceRun({
      transmissionId: transmission.id,
      level: traceLevel,
      personaLabel: resolvePersonaLabel(transmission.modeDecision),
    });
  }

  try {
    const result = await processTransmission({
      store: activeStore,
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

    await activeStore.appendDeliveryAttempt({
      transmissionId: transmission.id,
      provider,
      status: "failed",
      error: message,
    });

    await activeStore.updateTransmissionStatus({
      transmissionId: transmission.id,
      status: "failed",
      statusCode: 500,
      retryable: true,
      errorCode: "worker_failed",
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

async function main() {
  store = new SqliteControlPlaneStore(dbPath, log);

  const handshakeAttempts = Number(process.env.TOPOLOGY_HANDSHAKE_ATTEMPTS ?? 12) || 12;
  const handshakeDelayMs = Number(process.env.TOPOLOGY_HANDSHAKE_RETRY_MS ?? 5000) || 5000;

  await runTopologyHandshake({
    store,
    log,
    apiBaseUrl: resolveInternalApiBase(),
    internalToken: process.env.SOL_INTERNAL_TOKEN,
    maxAttempts: handshakeAttempts,
    retryDelayMs: handshakeDelayMs,
  });

  log.info(
    {
      evt: "worker.started",
      workerId,
      dbPath,
      dbStat: getDbStat(dbPath),
      pollIntervalMs,
      leaseSeconds,
      heartbeatEvery,
      leaseAttemptLimit,
      emptyScanLimit,
      jitterMinMs,
      jitterMaxMs,
      handshakeAttempts,
      handshakeDelayMs,
    },
    "worker.started"
  );

  await logHeartbeat("startup");
  tick();
  setInterval(tick, pollIntervalMs);
}

main().catch((err) => {
  log.error({ error: String(err?.message ?? err) }, "worker.fatal");
  process.exit(1);
});
