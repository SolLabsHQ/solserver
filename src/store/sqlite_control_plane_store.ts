import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import type {
  ControlPlaneStore,
  Transmission,
  DeliveryAttempt,
  UsageRecord,
  ChatResult,
  TransmissionStatus,
  DeliveryStatus,
  TraceRun,
  TraceEvent,
  TraceLevel,
  TraceEventActor,
  TraceEventPhase,
  TraceEventStatus,
} from "./control_plane_store";
import type { PacketInput, ModeDecision } from "../contracts/chat";

export class SqliteControlPlaneStore implements ControlPlaneStore {
  private db: Database.Database;

  constructor(dbPath: string = "./data/control_plane.db") {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transmissions (
        id TEXT PRIMARY KEY,
        packet_type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        client_request_id TEXT,
        message TEXT NOT NULL,
        mode_decision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_request_id ON transmissions(client_request_id);

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id TEXT PRIMARY KEY,
        transmission_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        output_chars INTEGER,
        error TEXT,
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_transmission ON delivery_attempts(transmission_id);

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        transmission_id TEXT NOT NULL,
        input_chars INTEGER NOT NULL,
        output_chars INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_transmission ON usage_records(transmission_id);

      CREATE TABLE IF NOT EXISTS chat_results (
        transmission_id TEXT PRIMARY KEY,
        assistant TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id)
      );

      CREATE TABLE IF NOT EXISTS trace_runs (
        id TEXT PRIMARY KEY,
        transmission_id TEXT NOT NULL,
        level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_trace_runs_transmission_id ON trace_runs(transmission_id);

      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        trace_run_id TEXT NOT NULL,
        transmission_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        metadata_json TEXT,
        FOREIGN KEY (trace_run_id) REFERENCES trace_runs(id),
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_trace_events_trace_run_id ON trace_events(trace_run_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_transmission_id ON trace_events(transmission_id);
    `);
  }

  async createTransmission(args: {
    packet: PacketInput;
    modeDecision: ModeDecision;
  }): Promise<Transmission> {
    const id = randomUUID();
    const clientRequestId = (args.packet as any).clientRequestId as string | undefined;

    const t: Transmission = {
      id,
      packetType: "chat",
      threadId: args.packet.threadId,
      clientRequestId,
      message: args.packet.message,
      modeDecision: args.modeDecision,
      createdAt: new Date().toISOString(),
      status: "created",
    };

    const stmt = this.db.prepare(`
      INSERT INTO transmissions (id, packet_type, thread_id, client_request_id, message, mode_decision, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        t.id,
        t.packetType,
        t.threadId,
        t.clientRequestId ?? null,
        t.message,
        JSON.stringify(t.modeDecision),
        t.createdAt,
        t.status
      );
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "SQLITE_CONSTRAINT_UNIQUE" && t.clientRequestId) {
        const existing = await this.getTransmissionByClientRequestId(t.clientRequestId);
        if (existing) {
          return existing;
        }
      }
      throw err;
    }

    return t;
  }

  async getTransmissionByClientRequestId(clientRequestId: string): Promise<Transmission | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM transmissions WHERE client_request_id = ?
    `);

    const row = stmt.get(clientRequestId) as any;
    if (!row) return null;

    return this.rowToTransmission(row);
  }

  async updateTransmissionStatus(args: {
    transmissionId: string;
    status: TransmissionStatus;
  }): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE transmissions SET status = ? WHERE id = ?
    `);

    stmt.run(args.status, args.transmissionId);
  }

  async appendDeliveryAttempt(args: {
    transmissionId: string;
    provider: DeliveryAttempt["provider"];
    status: DeliveryStatus;
    outputChars?: number;
    error?: string;
  }): Promise<DeliveryAttempt> {
    const a: DeliveryAttempt = {
      id: randomUUID(),
      transmissionId: args.transmissionId,
      provider: args.provider,
      status: args.status,
      createdAt: new Date().toISOString(),
      outputChars: args.outputChars,
      error: args.error,
    };

    const stmt = this.db.prepare(`
      INSERT INTO delivery_attempts (id, transmission_id, provider, status, created_at, output_chars, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      a.id,
      a.transmissionId,
      a.provider,
      a.status,
      a.createdAt,
      a.outputChars ?? null,
      a.error ?? null
    );

    return a;
  }

  async recordUsage(args: {
    transmissionId: string;
    inputChars: number;
    outputChars: number;
  }): Promise<UsageRecord> {
    const u: UsageRecord = {
      id: randomUUID(),
      transmissionId: args.transmissionId,
      inputChars: args.inputChars,
      outputChars: args.outputChars,
      createdAt: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO usage_records (id, transmission_id, input_chars, output_chars, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(u.id, u.transmissionId, u.inputChars, u.outputChars, u.createdAt);

    return u;
  }

  async getTransmission(transmissionId: string): Promise<Transmission | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM transmissions WHERE id = ?
    `);

    const row = stmt.get(transmissionId) as any;
    if (!row) return null;

    return this.rowToTransmission(row);
  }

  async getDeliveryAttempts(transmissionId: string): Promise<DeliveryAttempt[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM delivery_attempts WHERE transmission_id = ?
    `);

    const rows = stmt.all(transmissionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      transmissionId: row.transmission_id,
      provider: row.provider,
      status: row.status,
      createdAt: row.created_at,
      outputChars: row.output_chars ?? undefined,
      error: row.error ?? undefined,
    }));
  }

  async getUsage(transmissionId: string): Promise<UsageRecord[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM usage_records WHERE transmission_id = ?
    `);

    const rows = stmt.all(transmissionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      transmissionId: row.transmission_id,
      inputChars: row.input_chars,
      outputChars: row.output_chars,
      createdAt: row.created_at,
    }));
  }

  async getChatResult(transmissionId: string): Promise<ChatResult | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM chat_results WHERE transmission_id = ?
    `);

    const row = stmt.get(transmissionId) as any;
    if (!row) return null;

    return {
      transmissionId: row.transmission_id,
      assistant: row.assistant,
      createdAt: row.created_at,
    };
  }

  async setChatResult(args: { transmissionId: string; assistant: string }): Promise<ChatResult> {
    const r: ChatResult = {
      transmissionId: args.transmissionId,
      assistant: args.assistant,
      createdAt: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chat_results (transmission_id, assistant, created_at)
      VALUES (?, ?, ?)
    `);

    stmt.run(r.transmissionId, r.assistant, r.createdAt);

    return r;
  }

  async createTraceRun(args: { transmissionId: string; level: TraceLevel }): Promise<TraceRun> {
    const tr: TraceRun = {
      id: randomUUID(),
      transmissionId: args.transmissionId,
      level: args.level,
      createdAt: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO trace_runs (id, transmission_id, level, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(tr.id, tr.transmissionId, tr.level, tr.createdAt);
    return tr;
  }

  async appendTraceEvent(args: {
    traceRunId: string;
    transmissionId: string;
    actor: TraceEventActor;
    phase: TraceEventPhase;
    status: TraceEventStatus;
    summary?: string;
    metadata?: Record<string, any>;
  }): Promise<TraceEvent> {
    const te: TraceEvent = {
      id: randomUUID(),
      traceRunId: args.traceRunId,
      transmissionId: args.transmissionId,
      ts: new Date().toISOString(),
      actor: args.actor,
      phase: args.phase,
      status: args.status,
      summary: args.summary,
      metadata: args.metadata,
    };

    const stmt = this.db.prepare(`
      INSERT INTO trace_events (
        id,
        trace_run_id,
        transmission_id,
        ts,
        actor,
        phase,
        status,
        summary,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      te.id,
      te.traceRunId,
      te.transmissionId,
      te.ts,
      te.actor,
      te.phase,
      te.status,
      te.summary ?? null,
      te.metadata ? JSON.stringify(te.metadata) : null
    );

    return te;
  }

  async getTraceRun(traceRunId: string): Promise<TraceRun | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM trace_runs WHERE id = ?
    `);

    const row = stmt.get(traceRunId) as any;
    if (!row) return null;

    return {
      id: row.id,
      transmissionId: row.transmission_id,
      level: row.level,
      createdAt: row.created_at,
    };
  }

  async getTraceEvents(
    traceRunId: string,
    options?: { limit?: number }
  ): Promise<TraceEvent[]> {
    if (options?.limit === 0) {
      return [];
    }

    if (options?.limit !== undefined) {
      const stmt = this.db.prepare(`
        SELECT * FROM trace_events
        WHERE trace_run_id = ?
        ORDER BY ts DESC
        LIMIT ?
      `);
      const rows = stmt.all(traceRunId, options.limit) as any[];
      return rows
        .map((row) => ({
          id: row.id,
          traceRunId: row.trace_run_id,
          transmissionId: row.transmission_id,
          ts: row.ts,
          actor: row.actor,
          phase: row.phase,
          status: row.status,
          summary: row.summary ?? undefined,
          metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
        }))
        .reverse();
    }

    const stmt = this.db.prepare(`
      SELECT * FROM trace_events
      WHERE trace_run_id = ?
      ORDER BY ts ASC
    `);
    const rows = stmt.all(traceRunId) as any[];

    return rows.map((row) => ({
      id: row.id,
      traceRunId: row.trace_run_id,
      transmissionId: row.transmission_id,
      ts: row.ts,
      actor: row.actor,
      phase: row.phase,
      status: row.status,
      summary: row.summary ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));
  }

  private rowToTransmission(row: any): Transmission {
    return {
      id: row.id,
      packetType: row.packet_type,
      threadId: row.thread_id,
      clientRequestId: row.client_request_id ?? undefined,
      message: row.message,
      modeDecision: JSON.parse(row.mode_decision),
      createdAt: row.created_at,
      status: row.status,
    };
  }

  close() {
    this.db.close();
  }
}
