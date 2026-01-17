import { randomUUID } from "node:crypto";

import type { PacketInput, ModeDecision, Evidence } from "../contracts/chat";

export type TransmissionStatus = "created" | "completed" | "failed";
export type DeliveryStatus = "succeeded" | "failed";

export type Transmission = {
  id: string;
  packetType: "chat";
  threadId: string;
  clientRequestId?: string;
  message: string;
  modeDecision: ModeDecision;
  createdAt: string;
  status: TransmissionStatus;
  statusCode?: number;
  retryable?: boolean;
};

export type DeliveryAttempt = {
  id: string;
  transmissionId: string;
  provider: "fake" | "openai";
  status: DeliveryStatus;
  createdAt: string;
  outputChars?: number;
  error?: string;
};

export type UsageRecord = {
  id: string;
  transmissionId: string;
  inputChars: number;
  outputChars: number;
  createdAt: string;
};

export type ChatResult = {
  transmissionId: string;
  assistant: string;
  createdAt: string;
};

export type TraceLevel = "info" | "debug";

export type TraceRun = {
  id: string;
  transmissionId: string;
  level: TraceLevel;
  createdAt: string;
};

export type TraceEventActor = "solmobile" | "solserver" | "model" | "renderer" | "user";
export type TraceEventPhase =
  | "normalize"
  | "evidence_intake"
  | "gate_normalize_modality"
  | "gate_intent_risk"
  | "gate_lattice"
  | "modality_gate"
  | "intent_gate"
  | "risk_gate"
  | "enrichment_lattice"
  | "policy_engine"
  | "compose_request"
  | "model_call"
  | "output_gates"
  | "render"
  | "breakpoint"
  | "export"
  | "error";
export type TraceEventStatus = "started" | "completed" | "paused" | "blocked" | "failed" | "warning";

export type TraceEvent = {
  id: string;
  traceRunId: string;
  transmissionId: string;
  ts: string;
  actor: TraceEventActor;
  phase: TraceEventPhase;
  status: TraceEventStatus;
  summary?: string;
  metadata?: Record<string, any>;
};

export type TraceSummary = {
  eventCount: number;
  phaseCounts: Record<TraceEventPhase, number>;
  latestTs?: string;
};

export interface ControlPlaneStore {
  createTransmission(args: {
    packet: PacketInput;
    modeDecision: ModeDecision;
  }): Promise<Transmission>;

  getTransmissionByClientRequestId(clientRequestId: string): Promise<Transmission | null>;

  updateTransmissionStatus(args: {
    transmissionId: string;
    status: TransmissionStatus;
    statusCode?: number;
    retryable?: boolean;
  }): Promise<void>;

  appendDeliveryAttempt(args: {
    transmissionId: string;
    provider: DeliveryAttempt["provider"];
    status: DeliveryStatus;
    outputChars?: number;
    error?: string;
  }): Promise<DeliveryAttempt>;

  recordUsage(args: {
    transmissionId: string;
    inputChars: number;
    outputChars: number;
  }): Promise<UsageRecord>;

  // Optional read helpers (handy for debugging)
  getTransmission(transmissionId: string): Promise<Transmission | null>;
  getDeliveryAttempts(transmissionId: string): Promise<DeliveryAttempt[]>;
  getUsage(transmissionId: string): Promise<UsageRecord[]>;

  getChatResult(transmissionId: string): Promise<ChatResult | null>;
  setChatResult(args: { transmissionId: string; assistant: string }): Promise<ChatResult>;

  // Trace methods
  createTraceRun(args: {
    transmissionId: string;
    level: TraceLevel;
  }): Promise<TraceRun>;

  appendTraceEvent(args: {
    traceRunId: string;
    transmissionId: string;
    actor: TraceEventActor;
    phase: TraceEventPhase;
    status: TraceEventStatus;
    summary?: string;
    metadata?: Record<string, any>;
  }): Promise<TraceEvent>;

  getTraceRun(traceRunId: string): Promise<TraceRun | null>;
  getTraceEvents(traceRunId: string, options?: { limit?: number }): Promise<TraceEvent[]>;
  getTraceSummary(traceRunId: string): Promise<TraceSummary | null>;

  // Evidence methods (PR #7)
  saveEvidence(args: {
    transmissionId: string;
    threadId: string;
    evidence: Evidence;
  }): Promise<void>;

  getEvidence(args: {
    transmissionId: string;
  }): Promise<Evidence | null>;

  getEvidenceByThread(args: {
    threadId: string;
    limit?: number;
  }): Promise<Array<{ transmissionId: string; evidence: Evidence }>>;
}

export class MemoryControlPlaneStore implements ControlPlaneStore {
  private transmissions = new Map<string, Transmission>();
  private attempts = new Map<string, DeliveryAttempt[]>();
  private usage = new Map<string, UsageRecord[]>();
  private clientRequestIndex = new Map<string, string>(); // clientRequestId -> transmissionId
  private chatResults = new Map<string, ChatResult>(); // transmissionId -> cached result
  private traceRuns = new Map<string, TraceRun>(); // traceRunId -> TraceRun
  private traceEvents = new Map<string, TraceEvent[]>(); // traceRunId -> TraceEvent[]
  private evidence = new Map<string, Evidence>(); // transmissionId -> Evidence

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

    this.transmissions.set(id, t);

    if (t.clientRequestId) {
      this.clientRequestIndex.set(t.clientRequestId, id);
    }

    return t;
  }

  async getTransmissionByClientRequestId(clientRequestId: string): Promise<Transmission | null> {
    const id = this.clientRequestIndex.get(clientRequestId);
    if (!id) return null;
    return this.transmissions.get(id) ?? null;
  }

  async updateTransmissionStatus(args: {
    transmissionId: string;
    status: TransmissionStatus;
    statusCode?: number;
    retryable?: boolean;
  }): Promise<void> {
    const existing = this.transmissions.get(args.transmissionId);
    if (!existing) return;
    this.transmissions.set(args.transmissionId, {
      ...existing,
      status: args.status,
      statusCode: args.statusCode ?? existing.statusCode,
      retryable: args.retryable ?? existing.retryable,
    });
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

    const list = this.attempts.get(args.transmissionId) ?? [];
    list.push(a);
    this.attempts.set(args.transmissionId, list);
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

    const list = this.usage.get(args.transmissionId) ?? [];
    list.push(u);
    this.usage.set(args.transmissionId, list);
    return u;
  }

  async getTransmission(transmissionId: string): Promise<Transmission | null> {
    return this.transmissions.get(transmissionId) ?? null;
  }

  async getDeliveryAttempts(transmissionId: string): Promise<DeliveryAttempt[]> {
    return this.attempts.get(transmissionId) ?? [];
  }

  async getUsage(transmissionId: string): Promise<UsageRecord[]> {
    return this.usage.get(transmissionId) ?? [];
  }

  async getChatResult(transmissionId: string): Promise<ChatResult | null> {
    return this.chatResults.get(transmissionId) ?? null;
  }

  async setChatResult(args: { transmissionId: string; assistant: string }): Promise<ChatResult> {
    const r: ChatResult = {
      transmissionId: args.transmissionId,
      assistant: args.assistant,
      createdAt: new Date().toISOString(),
    };
    this.chatResults.set(args.transmissionId, r);
    return r;
  }

  async createTraceRun(args: {
    transmissionId: string;
    level: TraceLevel;
  }): Promise<TraceRun> {
    const tr: TraceRun = {
      id: randomUUID(),
      transmissionId: args.transmissionId,
      level: args.level,
      createdAt: new Date().toISOString(),
    };
    this.traceRuns.set(tr.id, tr);
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
    const list = this.traceEvents.get(args.traceRunId) ?? [];
    list.push(te);
    this.traceEvents.set(args.traceRunId, list);
    return te;
  }

  async getTraceRun(traceRunId: string): Promise<TraceRun | null> {
    return this.traceRuns.get(traceRunId) ?? null;
  }

  async getTraceEvents(traceRunId: string, options?: { limit?: number }): Promise<TraceEvent[]> {
    const events = this.traceEvents.get(traceRunId) ?? [];
    if (options?.limit !== undefined) {
      if (options.limit === 0) {
        return []; // Return no events when limit is 0
      }
      return events.slice(-options.limit); // Return last N events
    }
    return events;
  }

  async getTraceSummary(traceRunId: string): Promise<TraceSummary | null> {
    const events = this.traceEvents.get(traceRunId);
    if (!events) return null;
    const phaseCounts: Record<TraceEventPhase, number> = {} as Record<TraceEventPhase, number>;
    let latestTs: string | undefined;
    for (const event of events) {
      phaseCounts[event.phase] = (phaseCounts[event.phase] ?? 0) + 1;
      if (!latestTs || event.ts > latestTs) {
        latestTs = event.ts;
      }
    }
    return {
      eventCount: events.length,
      phaseCounts,
      latestTs,
    };
  }

  // Evidence methods (PR #7)
  async saveEvidence(args: {
    transmissionId: string;
    threadId: string;
    evidence: Evidence;
  }): Promise<void> {
    // Idempotent: overwrite existing evidence for this transmission
    this.evidence.set(args.transmissionId, args.evidence);
  }

  async getEvidence(args: {
    transmissionId: string;
  }): Promise<Evidence | null> {
    return this.evidence.get(args.transmissionId) ?? null;
  }

  async getEvidenceByThread(args: {
    threadId: string;
    limit?: number;
  }): Promise<Array<{ transmissionId: string; evidence: Evidence }>> {
    const results: Array<{ transmissionId: string; evidence: Evidence }> = [];
    const limit = args.limit ?? 100;

    // Find transmissions for this thread
    for (const [transmissionId, transmission] of this.transmissions.entries()) {
      if (transmission.threadId === args.threadId) {
        const evidence = this.evidence.get(transmissionId);
        if (evidence) {
          results.push({ transmissionId, evidence });
          if (results.length >= limit) {
            break;
          }
        }
      }
    }

    return results;
  }
}
