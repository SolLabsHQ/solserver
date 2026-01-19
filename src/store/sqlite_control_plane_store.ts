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
  TraceSummary,
} from "./control_plane_store";
import type { PacketInput, ModeDecision, Evidence } from "../contracts/chat";

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
        packet_json TEXT,
        mode_decision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        retryable INTEGER,
        error_code TEXT,
        error_detail_json TEXT,
        lease_expires_at TEXT,
        lease_owner TEXT
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
        persona_label TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_trace_events_trace_run_id_phase ON trace_events(trace_run_id, phase);
      CREATE INDEX IF NOT EXISTS idx_trace_events_transmission_id ON trace_events(transmission_id);

      -- Evidence tables (PR #7)
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        transmission_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        capture_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'url',
        url TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        title TEXT,
        source TEXT NOT NULL DEFAULT 'user_provided',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id) ON DELETE CASCADE,
        UNIQUE (transmission_id, capture_id)
      );

      CREATE INDEX IF NOT EXISTS idx_captures_transmission ON captures(transmission_id);
      CREATE INDEX IF NOT EXISTS idx_captures_thread ON captures(thread_id);
      CREATE INDEX IF NOT EXISTS idx_captures_tx_capture ON captures(transmission_id, capture_id);

      CREATE TABLE IF NOT EXISTS claim_supports (
        id TEXT PRIMARY KEY,
        transmission_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        support_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('url_capture', 'text_snippet')),
        capture_id TEXT,
        snippet_text TEXT,
        snippet_hash TEXT,
        created_at_iso TEXT NOT NULL,
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id) ON DELETE CASCADE,
        FOREIGN KEY (transmission_id, capture_id) 
          REFERENCES captures(transmission_id, capture_id) 
          ON DELETE SET NULL,
        UNIQUE (transmission_id, support_id)
      );

      CREATE INDEX IF NOT EXISTS idx_supports_transmission ON claim_supports(transmission_id);
      CREATE INDEX IF NOT EXISTS idx_supports_thread ON claim_supports(thread_id);
      CREATE INDEX IF NOT EXISTS idx_supports_tx_support ON claim_supports(transmission_id, support_id);
      CREATE INDEX IF NOT EXISTS idx_supports_tx_capture ON claim_supports(transmission_id, capture_id);

      CREATE TABLE IF NOT EXISTS claim_map_entries (
        id TEXT PRIMARY KEY,
        transmission_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        support_ids TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        FOREIGN KEY (transmission_id) REFERENCES transmissions(id) ON DELETE CASCADE,
        UNIQUE (transmission_id, claim_id)
      );

      CREATE INDEX IF NOT EXISTS idx_claims_transmission ON claim_map_entries(transmission_id);
      CREATE INDEX IF NOT EXISTS idx_claims_thread ON claim_map_entries(thread_id);
      CREATE INDEX IF NOT EXISTS idx_claims_tx_claim ON claim_map_entries(transmission_id, claim_id);
    `);

    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN status_code INTEGER");
    } catch {}
    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN retryable INTEGER");
    } catch {}
    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN packet_json TEXT");
    } catch {}
    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN error_code TEXT");
    } catch {}
    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN error_detail_json TEXT");
    } catch {}
    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN lease_expires_at TEXT");
    } catch {}
    try {
      this.db.exec("ALTER TABLE transmissions ADD COLUMN lease_owner TEXT");
    } catch {}
    try {
      this.db.exec("ALTER TABLE trace_runs ADD COLUMN persona_label TEXT");
    } catch {}
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
      statusCode: undefined,
      retryable: undefined,
    };

    const stmt = this.db.prepare(`
      INSERT INTO transmissions (
        id,
        packet_type,
        thread_id,
        client_request_id,
        message,
        packet_json,
        mode_decision,
        created_at,
        status,
        status_code,
        retryable,
        error_code,
        error_detail_json,
        lease_expires_at,
        lease_owner
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        t.id,
        t.packetType,
        t.threadId,
        t.clientRequestId ?? null,
        t.message,
        JSON.stringify(args.packet),
        JSON.stringify(t.modeDecision),
        t.createdAt,
        t.status,
        t.statusCode ?? null,
        t.retryable === undefined ? null : (t.retryable ? 1 : 0),
        null,
        null,
        null,
        null
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
    statusCode?: number;
    retryable?: boolean;
    errorCode?: string | null;
    errorDetail?: Record<string, any> | null;
  }): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE transmissions
      SET status = ?,
        status_code = COALESCE(?, status_code),
        retryable = COALESCE(?, retryable),
        error_code = COALESCE(?, error_code),
        error_detail_json = COALESCE(?, error_detail_json)
      WHERE id = ?
    `);

    const retryableValue = args.retryable === undefined ? null : (args.retryable ? 1 : 0);
    const errorDetailJson = args.errorDetail === undefined
      ? null
      : args.errorDetail === null
        ? null
        : JSON.stringify(args.errorDetail);
    stmt.run(
      args.status,
      args.statusCode ?? null,
      retryableValue,
      args.errorCode ?? null,
      errorDetailJson,
      args.transmissionId
    );
  }

  async leaseNextTransmission(args: {
    leaseOwner: string;
    leaseDurationSeconds: number;
    eligibleStatuses?: TransmissionStatus[];
    packetType?: Transmission["packetType"];
  }): Promise<{ transmission: Transmission; previousStatus: TransmissionStatus } | null> {
    const eligible = (args.eligibleStatuses ?? ["created", "processing"])
      .filter((status) => status === "created" || status === "processing");
    if (eligible.length === 0) return null;

    const statusList = eligible.map((status) => `'${status}'`).join(", ");
    const nowIso = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + args.leaseDurationSeconds * 1000).toISOString();
    const packetClause = args.packetType ? "AND packet_type = ?" : "";

    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM transmissions
        WHERE status IN (${statusList})
          ${packetClause}
          AND (lease_expires_at IS NULL OR lease_expires_at < ?)
        ORDER BY created_at ASC
        LIMIT 1
      `).get(...(args.packetType ? [args.packetType, nowIso] : [nowIso])) as any;

      if (!row) return null;

      const updateParams = [leaseExpiresAt, args.leaseOwner, row.id];
      if (args.packetType) updateParams.push(args.packetType);
      updateParams.push(nowIso);

      const update = this.db.prepare(`
        UPDATE transmissions
        SET status = 'processing', lease_expires_at = ?, lease_owner = ?
        WHERE id = ?
          ${packetClause}
          AND status IN (${statusList})
          AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      `).run(...updateParams);

      if (update.changes === 0) {
        return null;
      }

      const transmission = this.rowToTransmission({
        ...row,
        status: "processing",
        lease_expires_at: leaseExpiresAt,
        lease_owner: args.leaseOwner,
      });

      return { transmission, previousStatus: row.status as TransmissionStatus };
    });

    return tx();
  }

  async getLeaseableStats(args: {
    eligibleStatuses?: TransmissionStatus[];
    packetType?: Transmission["packetType"];
  }): Promise<{ leaseableCount: number; oldestCreatedAt: string | null }> {
    const eligible = (args.eligibleStatuses ?? ["created", "processing"])
      .filter((status) => status === "created" || status === "processing");
    if (eligible.length === 0) {
      return { leaseableCount: 0, oldestCreatedAt: null };
    }

    const statusList = eligible.map((status) => `'${status}'`).join(", ");
    const nowIso = new Date().toISOString();
    const packetClause = args.packetType ? "AND packet_type = ?" : "";
    const params = args.packetType ? [args.packetType, nowIso] : [nowIso];

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        MIN(CASE WHEN status = 'created' THEN created_at END) as oldest_created_at
      FROM transmissions
      WHERE status IN (${statusList})
        ${packetClause}
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)
    `).get(...params) as { count?: number; oldest_created_at?: string | null } | undefined;

    return {
      leaseableCount: Number(row?.count ?? 0),
      oldestCreatedAt: row?.oldest_created_at ?? null,
    };
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

  async createTraceRun(args: {
    transmissionId: string;
    level: TraceLevel;
    personaLabel?: string | null;
  }): Promise<TraceRun> {
    const tr: TraceRun = {
      id: randomUUID(),
      transmissionId: args.transmissionId,
      level: args.level,
      personaLabel: args.personaLabel ?? null,
      createdAt: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO trace_runs (id, transmission_id, level, persona_label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(tr.id, tr.transmissionId, tr.level, tr.personaLabel ?? null, tr.createdAt);
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
      personaLabel: row.persona_label ?? null,
      createdAt: row.created_at,
    };
  }

  async getTraceRunByTransmission(transmissionId: string): Promise<TraceRun | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM trace_runs
      WHERE transmission_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = stmt.get(transmissionId) as any;
    if (!row) return null;

    return {
      id: row.id,
      transmissionId: row.transmission_id,
      level: row.level,
      personaLabel: row.persona_label ?? null,
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

    const stmt = this.db.prepare(`
      SELECT rowid, * FROM trace_events
      WHERE trace_run_id = ?
    `);
    const rows = stmt.all(traceRunId) as any[];

    const events = rows.map((row) => {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : undefined;
      const seq = Number.isFinite(metadata?.seq) ? metadata.seq : null;
      return {
        event: {
          id: row.id,
          traceRunId: row.trace_run_id,
          transmissionId: row.transmission_id,
          ts: row.ts,
          actor: row.actor,
          phase: row.phase,
          status: row.status,
          summary: row.summary ?? undefined,
          metadata,
        },
        seq,
        ts: row.ts,
        rowid: row.rowid as number,
      };
    });

    const withSeq = events.filter((entry) => entry.seq !== null);
    const withoutSeq = events.filter((entry) => entry.seq === null);

    withSeq.sort((a, b) => (a.seq as number) - (b.seq as number));
    withoutSeq.sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return a.rowid - b.rowid;
    });

    const sorted = [...withSeq, ...withoutSeq].map((entry) => entry.event);

    if (options?.limit !== undefined) {
      return sorted.slice(-options.limit);
    }

    return sorted;
  }

  async getTraceSummary(traceRunId: string): Promise<TraceSummary | null> {
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count, MAX(ts) as latest_ts
      FROM trace_events
      WHERE trace_run_id = ?
    `);
    const countRow = countStmt.get(traceRunId) as any;
    const eventCount = Number(countRow?.count ?? 0);

    const phaseStmt = this.db.prepare(`
      SELECT phase, COUNT(*) as count
      FROM trace_events
      WHERE trace_run_id = ?
      GROUP BY phase
    `);
    const phaseRows = phaseStmt.all(traceRunId) as Array<{ phase: TraceEventPhase; count: number }>;

    const phaseCounts: Record<TraceEventPhase, number> = {} as Record<TraceEventPhase, number>;
    for (const row of phaseRows) {
      phaseCounts[row.phase] = Number(row.count ?? 0);
    }

    return {
      eventCount,
      phaseCounts,
      latestTs: countRow?.latest_ts ?? undefined,
    };
  }

  private rowToTransmission(row: any): Transmission {
    let packet: PacketInput | undefined;
    const packetJson = row.packet_json ?? undefined;
    if (packetJson) {
      try {
        packet = JSON.parse(packetJson);
      } catch {}
    }
    let errorDetail: Record<string, any> | undefined;
    if (row.error_detail_json) {
      try {
        errorDetail = JSON.parse(row.error_detail_json);
      } catch {}
    }

    return {
      id: row.id,
      packetType: row.packet_type,
      threadId: row.thread_id,
      clientRequestId: row.client_request_id ?? undefined,
      message: row.message,
      modeDecision: JSON.parse(row.mode_decision),
      createdAt: row.created_at,
      status: row.status,
      statusCode: row.status_code ?? undefined,
      retryable: row.retryable === null || row.retryable === undefined ? undefined : Boolean(row.retryable),
      errorCode: row.error_code ?? undefined,
      errorDetail,
      packetJson,
      packet,
      leaseExpiresAt: row.lease_expires_at ?? null,
      leaseOwner: row.lease_owner ?? null,
    };
  }

  // Evidence methods (PR #7)
  async saveEvidence(args: {
    transmissionId: string;
    threadId: string;
    evidence: Evidence;
  }): Promise<void> {
    const { transmissionId, threadId, evidence } = args;

    // Idempotent: delete-then-insert in single transaction
    const tx = this.db.transaction(() => {
      // Delete existing evidence for this transmission
      this.db.prepare("DELETE FROM captures WHERE transmission_id = ?").run(transmissionId);
      this.db.prepare("DELETE FROM claim_supports WHERE transmission_id = ?").run(transmissionId);
      this.db.prepare("DELETE FROM claim_map_entries WHERE transmission_id = ?").run(transmissionId);

      // Insert captures
      if (evidence.captures) {
        const insertCapture = this.db.prepare(`
          INSERT INTO captures (
            id, transmission_id, thread_id, capture_id, kind, url, 
            captured_at, title, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const capture of evidence.captures) {
          insertCapture.run(
            randomUUID(),
            transmissionId,
            threadId,
            capture.captureId,
            capture.kind,
            capture.url,
            capture.capturedAt,
            capture.title || null,
            capture.source
          );
        }
      }

      // Insert supports
      if (evidence.supports) {
        const insertSupport = this.db.prepare(`
          INSERT INTO claim_supports (
            id, transmission_id, thread_id, support_id, type, 
            capture_id, snippet_text, snippet_hash, created_at_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const support of evidence.supports) {
          insertSupport.run(
            randomUUID(),
            transmissionId,
            threadId,
            support.supportId,
            support.type,
            support.captureId || null,
            support.snippetText || null,
            support.snippetHash || null,
            support.createdAt
          );
        }
      }

      // Insert claims
      if (evidence.claims) {
        const insertClaim = this.db.prepare(`
          INSERT INTO claim_map_entries (
            id, transmission_id, thread_id, claim_id, 
            claim_text, support_ids, created_at_iso
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const claim of evidence.claims) {
          insertClaim.run(
            randomUUID(),
            transmissionId,
            threadId,
            claim.claimId,
            claim.claimText,
            JSON.stringify(claim.supportIds),
            claim.createdAt
          );
        }
      }
    });

    tx();
  }

  async getEvidence(args: {
    transmissionId: string;
  }): Promise<Evidence | null> {
    const { transmissionId } = args;

    // Read captures
    const captures = this.db
      .prepare(`
        SELECT capture_id, kind, url, captured_at, title, source
        FROM captures
        WHERE transmission_id = ?
        ORDER BY created_at
      `)
      .all(transmissionId) as any[];

    // Read supports
    const supports = this.db
      .prepare(`
        SELECT support_id, type, capture_id, snippet_text, snippet_hash, created_at_iso
        FROM claim_supports
        WHERE transmission_id = ?
        ORDER BY created_at_iso
      `)
      .all(transmissionId) as any[];

    // Read claims
    const claims = this.db
      .prepare(`
        SELECT claim_id, claim_text, support_ids, created_at_iso
        FROM claim_map_entries
        WHERE transmission_id = ?
        ORDER BY created_at_iso
      `)
      .all(transmissionId) as any[];

    // Return null if no evidence found
    if (captures.length === 0 && supports.length === 0 && claims.length === 0) {
      return null;
    }

    // Map to Evidence DTO (contract-shaped)
    const evidence: Evidence = {
      captures:
        captures.length > 0
          ? captures.map((row) => ({
              captureId: row.capture_id,
              kind: row.kind,
              url: row.url,
              capturedAt: row.captured_at,
              title: row.title || undefined,
              source: row.source,
            }))
          : undefined,
      supports:
        supports.length > 0
          ? supports.map((row) => ({
              supportId: row.support_id,
              type: row.type,
              captureId: row.capture_id || undefined,
              snippetText: row.snippet_text || undefined,
              snippetHash: row.snippet_hash || undefined,
              createdAt: row.created_at_iso,
            }))
          : undefined,
      claims:
        claims.length > 0
          ? claims.map((row) => ({
              claimId: row.claim_id,
              claimText: row.claim_text,
              supportIds: JSON.parse(row.support_ids),
              createdAt: row.created_at_iso,
            }))
          : undefined,
    };

    return evidence;
  }

  async getEvidenceByThread(args: {
    threadId: string;
    limit?: number;
  }): Promise<Array<{ transmissionId: string; evidence: Evidence }>> {
    const { threadId, limit = 100 } = args;

    // Get distinct transmission IDs for thread (ordered by most recent evidence)
    const transmissionIds = this.db
      .prepare(`
        SELECT transmission_id, MAX(sort_ts) AS sort_ts
        FROM (
          SELECT transmission_id, thread_id, created_at AS sort_ts FROM captures
          UNION ALL
          SELECT transmission_id, thread_id, created_at_iso AS sort_ts FROM claim_supports
          UNION ALL
          SELECT transmission_id, thread_id, created_at_iso AS sort_ts FROM claim_map_entries
        )
        WHERE thread_id = ?
        GROUP BY transmission_id
        ORDER BY sort_ts DESC, transmission_id DESC
        LIMIT ?
      `)
      .all(threadId, limit)
      .map((row: any) => row.transmission_id);

    // Fetch evidence for each transmission
    const results: Array<{ transmissionId: string; evidence: Evidence }> = [];

    for (const transmissionId of transmissionIds) {
      const evidence = await this.getEvidence({ transmissionId });
      if (evidence) {
        results.push({ transmissionId, evidence });
      }
    }

    return results;
  }

  close() {
    this.db.close();
  }
}
