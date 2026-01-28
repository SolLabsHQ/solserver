import "fastify-sse-v2";

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyReply } from "fastify";

export type SSEEventKind =
  | "ping"
  | "tx_accepted"
  | "run_started"
  | "assistant_final_ready"
  | "assistant_failed";

export type SSESubject =
  | { type: "none" }
  | {
      type: "transmission";
      transmission_id: string;
      thread_id?: string;
      client_request_id?: string;
    }
  | { type: "thread"; thread_id: string }
  | { type: "user"; user_id: string };

export type SSETrace = {
  trace_run_id?: string | null;
};

export type SSEEventEnvelopeV1 = {
  v: 1;
  ts: string;
  kind: SSEEventKind;
  subject: SSESubject;
  trace?: SSETrace;
  payload: Record<string, unknown>;
};

export type SSEConnection = {
  id: string;
  userId: string;
  createdAtMs: number;
  reply: FastifyReply;
  log?: FastifyBaseLogger;
};

const DEFAULT_PING_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS_PER_USER = 3;

const buildTrace = (traceRunId?: string | null): SSETrace | undefined => {
  if (traceRunId === undefined) return undefined;
  return { trace_run_id: traceRunId ?? null };
};

export const buildSSEEnvelope = (args: {
  kind: SSEEventKind;
  subject: SSESubject;
  traceRunId?: string | null;
  payload?: Record<string, unknown>;
  ts?: string;
}): SSEEventEnvelopeV1 => {
  const trace = buildTrace(args.traceRunId);
  return {
    v: 1,
    ts: args.ts ?? new Date().toISOString(),
    kind: args.kind,
    subject: args.subject,
    ...(trace ? { trace } : {}),
    payload: args.payload ?? {},
  };
};

export const buildTransmissionSubject = (args: {
  transmissionId: string;
  threadId?: string;
  clientRequestId?: string;
}): SSESubject => ({
  type: "transmission",
  transmission_id: args.transmissionId,
  ...(args.threadId ? { thread_id: args.threadId } : {}),
  ...(args.clientRequestId ? { client_request_id: args.clientRequestId } : {}),
});

class InMemoryConnectionRegistry {
  private readonly connections = new Map<string, Map<string, SSEConnection>>();

  add(conn: SSEConnection) {
    const bucket = this.connections.get(conn.userId) ?? new Map<string, SSEConnection>();
    bucket.set(conn.id, conn);
    this.connections.set(conn.userId, bucket);
  }

  remove(userId: string, connId: string) {
    const bucket = this.connections.get(userId);
    if (!bucket) return;
    bucket.delete(connId);
    if (bucket.size === 0) {
      this.connections.delete(userId);
    }
  }

  list(userId: string): SSEConnection[] {
    const bucket = this.connections.get(userId);
    if (!bucket) return [];
    return Array.from(bucket.values());
  }

  listAll(): SSEConnection[] {
    const all: SSEConnection[] = [];
    for (const bucket of this.connections.values()) {
      all.push(...bucket.values());
    }
    return all;
  }

  countAll(): number {
    let total = 0;
    for (const bucket of this.connections.values()) {
      total += bucket.size;
    }
    return total;
  }

  countUser(userId: string): number {
    return this.connections.get(userId)?.size ?? 0;
  }
}

class SSEHub {
  private registry = new InMemoryConnectionRegistry();
  private pingTimer: NodeJS.Timeout | null = null;
  private pingIntervalMs = DEFAULT_PING_MS;
  private maxConnectionsPerUser = DEFAULT_MAX_CONNECTIONS_PER_USER;

  configure(args: { pingIntervalMs?: number; maxConnectionsPerUser?: number } = {}) {
    if (typeof args.pingIntervalMs === "number" && args.pingIntervalMs > 0) {
      this.pingIntervalMs = args.pingIntervalMs;
    }
    if (typeof args.maxConnectionsPerUser === "number" && args.maxConnectionsPerUser > 0) {
      this.maxConnectionsPerUser = args.maxConnectionsPerUser;
    }
  }

  registerConnection(conn: SSEConnection) {
    const count = this.registry.countUser(conn.userId);
    if (count >= this.maxConnectionsPerUser) {
      const existing = this.registry.list(conn.userId);
      const oldest = existing.sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (oldest) {
        this.closeConnection(oldest, "cap_exceeded");
        this.registry.remove(conn.userId, oldest.id);
      }
    }

    this.registry.add(conn);
    this.ensurePingLoop();
  }

  removeConnection(userId: string, connId: string, reason: string = "closed") {
    const bucket = this.registry.list(userId);
    const conn = bucket.find((entry) => entry.id === connId);
    if (conn) {
      this.closeConnection(conn, reason);
    }
    this.registry.remove(userId, connId);
  }

  publishToUser(userId: string, event: SSEEventEnvelopeV1): void {
    const connections = this.registry.list(userId);
    for (const conn of connections) {
      this.send(conn, event);
    }
  }

  publishToConnection(conn: SSEConnection, event: SSEEventEnvelopeV1): void {
    this.send(conn, event);
  }

  activeConnectionCount(): number {
    return this.registry.countAll();
  }

  activeConnectionCountForUser(userId: string): number {
    return this.registry.countUser(userId);
  }

  private ensurePingLoop() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const pingEvent = buildSSEEnvelope({
        kind: "ping",
        subject: { type: "none" },
        payload: {},
      });
      for (const conn of this.registry.listAll()) {
        this.send(conn, pingEvent);
      }
    }, this.pingIntervalMs);

    if (typeof this.pingTimer.unref === "function") {
      this.pingTimer.unref();
    }
  }

  private send(conn: SSEConnection, event: SSEEventEnvelopeV1) {
    try {
      const replyAny = conn.reply as any;
      const data = JSON.stringify(event);
      replyAny.sse({
        id: randomUUID(),
        event: event.kind,
        data,
      });
    } catch (error) {
      conn.log?.warn?.(
        { err: String((error as Error)?.message ?? error), userId: conn.userId, connId: conn.id },
        "sse.send_failed"
      );
      this.removeConnection(conn.userId, conn.id, "send_failed");
    }
  }

  private closeConnection(conn: SSEConnection, reason: string) {
    try {
      const source = (conn.reply as any).sseContext?.source;
      source?.end?.();
    } catch (error) {
      conn.log?.debug?.(
        { err: String((error as Error)?.message ?? error), userId: conn.userId, connId: conn.id, reason },
        "sse.close_failed"
      );
    }
  }
}

export const sseHub = new SSEHub();
