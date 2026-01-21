import { randomUUID } from "node:crypto";

import type { PacketInput, ModeDecision, Evidence, NotificationPolicy } from "../contracts/chat";
import type { OutputEnvelope } from "../contracts/output_envelope";

export type TransmissionStatus = "created" | "processing" | "completed" | "failed";
export type DeliveryStatus = "succeeded" | "failed";

export type Transmission = {
  id: string;
  packetType: "chat" | "memory_distill";
  threadId: string;
  clientRequestId?: string;
  message: string;
  modeDecision: ModeDecision;
  notificationPolicy?: NotificationPolicy;
  forcedPersona?: ModeDecision["personaLabel"] | null;
  createdAt: string;
  status: TransmissionStatus;
  statusCode?: number;
  retryable?: boolean;
  errorCode?: string;
  errorDetail?: Record<string, any>;
  packetJson?: string;
  packet?: PacketInput;
  leaseExpiresAt?: string | null;
  leaseOwner?: string | null;
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

export type MemoryArtifactType = "memory" | "journal" | "action";
export type MemoryRigorLevel = "normal" | "high";
export type MemoryFidelity = "direct" | "hazy";

export type MemoryArtifact = {
  id: string;
  userId: string;
  transmissionId?: string | null;
  threadId?: string | null;
  triggerMessageId?: string | null;
  type: MemoryArtifactType;
  domain?: string | null;
  title?: string | null;
  snippet: string;
  moodAnchor?: string | null;
  rigorLevel: MemoryRigorLevel;
  rigorReason?: string | null;
  tags: string[];
  importance?: string | null;
  fidelity: MemoryFidelity;
  transitionToHazyAt?: string | null;
  requestId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryDistillStatus = "pending" | "completed" | "failed";

export type MemoryDistillRequest = {
  userId: string;
  requestId: string;
  transmissionId: string;
  threadId: string;
  triggerMessageId: string;
  contextHash: string;
  reaffirmCount: number;
  lastReaffirmedAt?: string | null;
  status: MemoryDistillStatus;
  outputEnvelopeJson?: string | null;
  memoryId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TraceLevel = "info" | "debug";

export type TraceRun = {
  id: string;
  transmissionId: string;
  level: TraceLevel;
  personaLabel?: string | null;
  createdAt: string;
};

export type TraceEventActor = "solmobile" | "solserver" | "model" | "renderer" | "user";
export type TraceEventPhase =
  | "normalize"
  | "evidence_intake"
  | "url_extraction"
  | "gate_normalize_modality"
  | "gate_intent"
  | "gate_sentinel"
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
    notificationPolicy?: NotificationPolicy;
    forcedPersona?: ModeDecision["personaLabel"] | null;
  }): Promise<Transmission>;

  getTransmissionByClientRequestId(clientRequestId: string): Promise<Transmission | null>;

  updateTransmissionStatus(args: {
    transmissionId: string;
    status: TransmissionStatus;
    statusCode?: number;
    retryable?: boolean;
    errorCode?: string | null;
    errorDetail?: Record<string, any> | null;
  }): Promise<void>;

  updateTransmissionPolicy(args: {
    transmissionId: string;
    notificationPolicy?: NotificationPolicy | null;
    forcedPersona?: ModeDecision["personaLabel"] | null;
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

  setTransmissionOutputEnvelope(args: {
    transmissionId: string;
    outputEnvelope: OutputEnvelope;
  }): Promise<void>;
  getTransmissionOutputEnvelope(transmissionId: string): Promise<OutputEnvelope | null>;

  createMemoryTransmission(args: {
    transmissionId: string;
    threadId: string;
    notificationPolicy?: NotificationPolicy | null;
  }): Promise<Transmission>;

  // Memory methods (PR #8)
  createMemoryDistillRequest(args: {
    userId: string;
    requestId: string;
    transmissionId: string;
    threadId: string;
    triggerMessageId: string;
    contextHash: string;
    reaffirmCount: number;
  }): Promise<MemoryDistillRequest>;

  getMemoryDistillRequestByRequestId(args: {
    userId: string;
    requestId: string;
  }): Promise<MemoryDistillRequest | null>;

  getMemoryDistillRequestByTransmissionId(args: {
    transmissionId: string;
  }): Promise<MemoryDistillRequest | null>;

  updateMemoryDistillRequestReaffirm(args: {
    userId: string;
    requestId: string;
    reaffirmCount: number;
    lastReaffirmedAt: string;
  }): Promise<void>;

  completeMemoryDistillRequest(args: {
    userId: string;
    requestId: string;
    status: MemoryDistillStatus;
    outputEnvelopeJson?: string | null;
    memoryId?: string | null;
  }): Promise<void>;

  setMemoryDistillContext(args: {
    userId: string;
    requestId: string;
    contextWindow: Array<{
      messageId: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: string;
    }>;
  }): Promise<void>;

  getMemoryDistillContext(args: {
    userId: string;
    requestId: string;
  }): Promise<
    Array<{
      messageId: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: string;
    }> | null
  >;

  consumeMemoryDistillContext(args: {
    userId: string;
    requestId: string;
  }): Promise<
    Array<{
      messageId: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: string;
    }> | null
  >;

  createMemoryArtifact(args: {
    userId: string;
    transmissionId?: string | null;
    threadId?: string | null;
    triggerMessageId?: string | null;
    type: MemoryArtifactType;
    domain?: string | null;
    title?: string | null;
    snippet: string;
    moodAnchor?: string | null;
    rigorLevel: MemoryRigorLevel;
    rigorReason?: string | null;
    tags: string[];
    importance?: string | null;
    fidelity: MemoryFidelity;
    transitionToHazyAt?: string | null;
    requestId?: string | null;
  }): Promise<MemoryArtifact>;

  getMemoryArtifact(args: {
    userId: string;
    memoryId: string;
  }): Promise<MemoryArtifact | null>;

  getMemoryArtifactByRequestId(args: {
    userId: string;
    requestId: string;
  }): Promise<MemoryArtifact | null>;

  listMemoryArtifacts(args: {
    userId: string;
    domain?: string | null;
    tagsAny?: string[] | null;
    before?: string | null;
    limit?: number;
  }): Promise<{ items: MemoryArtifact[]; nextCursor: string | null }>;

  updateMemoryArtifact(args: {
    userId: string;
    memoryId: string;
    snippet?: string | null;
    tags?: string[] | null;
    moodAnchor?: string | null;
  }): Promise<MemoryArtifact | null>;

  deleteMemoryArtifact(args: {
    userId: string;
    memoryId: string;
  }): Promise<{ deleted: boolean; artifact?: MemoryArtifact | null }>;

  batchDeleteMemoryArtifacts(args: {
    userId: string;
    filter: {
      threadId?: string | null;
      domain?: string | null;
      tagsAny?: string[] | null;
      createdBefore?: string | null;
    };
  }): Promise<number>;

  clearMemoryArtifacts(args: { userId: string }): Promise<number>;

  recordMemoryAudit(args: {
    userId: string;
    action: "delete" | "batch_delete" | "clear_all";
    requestId: string;
    threadId?: string | null;
    filter?: Record<string, any> | null;
    deletedCount: number;
  }): Promise<void>;

  // Trace methods
  createTraceRun(args: {
    transmissionId: string;
    level: TraceLevel;
    personaLabel?: string | null;
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
  getTraceRunByTransmission(transmissionId: string): Promise<TraceRun | null>;
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
  private transmissionOutputs = new Map<string, OutputEnvelope>(); // transmissionId -> output envelope
  private traceRuns = new Map<string, TraceRun>(); // traceRunId -> TraceRun
  private traceEvents = new Map<string, TraceEvent[]>(); // traceRunId -> TraceEvent[]
  private evidence = new Map<string, Evidence>(); // transmissionId -> Evidence
  private memoryDistillRequests = new Map<string, MemoryDistillRequest>(); // userId:requestId -> request
  private memoryDistillContexts = new Map<string, Array<{
    messageId: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  }>>(); // userId:requestId -> context window
  private memoryArtifacts = new Map<string, MemoryArtifact>(); // memoryId -> artifact
  private memoryAudit = new Map<string, {
    id: string;
    userId: string;
    action: "delete" | "batch_delete" | "clear_all";
    requestId: string;
    threadId?: string | null;
    filter?: Record<string, any> | null;
    deletedCount: number;
    createdAt: string;
  }>();

  async createTransmission(args: {
    packet: PacketInput;
    modeDecision: ModeDecision;
    notificationPolicy?: NotificationPolicy;
    forcedPersona?: ModeDecision["personaLabel"] | null;
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
      notificationPolicy: args.notificationPolicy,
      forcedPersona: args.forcedPersona ?? null,
      createdAt: new Date().toISOString(),
      status: "created",
      statusCode: undefined,
      retryable: undefined,
      errorCode: undefined,
      errorDetail: undefined,
      packetJson: JSON.stringify(args.packet),
      packet: args.packet,
      leaseExpiresAt: null,
      leaseOwner: null,
    };

    this.transmissions.set(id, t);

    if (t.clientRequestId) {
      this.clientRequestIndex.set(t.clientRequestId, id);
    }

    return t;
  }

  async setTransmissionOutputEnvelope(args: {
    transmissionId: string;
    outputEnvelope: OutputEnvelope;
  }): Promise<void> {
    this.transmissionOutputs.set(args.transmissionId, args.outputEnvelope);
  }

  async getTransmissionOutputEnvelope(transmissionId: string): Promise<OutputEnvelope | null> {
    return this.transmissionOutputs.get(transmissionId) ?? null;
  }

  async createMemoryTransmission(args: {
    transmissionId: string;
    threadId: string;
    notificationPolicy?: NotificationPolicy | null;
  }): Promise<Transmission> {
    const existing = this.transmissions.get(args.transmissionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const modeDecision: ModeDecision = {
      modeLabel: "System-mode",
      personaLabel: "system",
      domainFlags: [],
      confidence: 1,
      checkpointNeeded: false,
      reasons: ["memory_distill"],
      version: "memory-v0",
    };

    const transmission: Transmission = {
      id: args.transmissionId,
      packetType: "memory_distill",
      threadId: args.threadId,
      clientRequestId: undefined,
      message: "[memory_distill]",
      modeDecision,
      notificationPolicy: args.notificationPolicy ?? "muted",
      forcedPersona: null,
      createdAt: now,
      status: "created",
      statusCode: undefined,
      retryable: undefined,
      errorCode: undefined,
      errorDetail: undefined,
      packetJson: JSON.stringify({ packetType: "memory_distill", threadId: args.threadId }),
      packet: undefined,
      leaseExpiresAt: null,
      leaseOwner: null,
    };

    this.transmissions.set(transmission.id, transmission);
    return transmission;
  }

  async createMemoryDistillRequest(args: {
    userId: string;
    requestId: string;
    transmissionId: string;
    threadId: string;
    triggerMessageId: string;
    contextHash: string;
    reaffirmCount: number;
  }): Promise<MemoryDistillRequest> {
    const now = new Date().toISOString();
    const key = `${args.userId}:${args.requestId}`;
    const request: MemoryDistillRequest = {
      userId: args.userId,
      requestId: args.requestId,
      transmissionId: args.transmissionId,
      threadId: args.threadId,
      triggerMessageId: args.triggerMessageId,
      contextHash: args.contextHash,
      reaffirmCount: args.reaffirmCount,
      lastReaffirmedAt: null,
      status: "pending",
      outputEnvelopeJson: null,
      memoryId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.memoryDistillRequests.set(key, request);
    return request;
  }

  async getMemoryDistillRequestByRequestId(args: {
    userId: string;
    requestId: string;
  }): Promise<MemoryDistillRequest | null> {
    const key = `${args.userId}:${args.requestId}`;
    return this.memoryDistillRequests.get(key) ?? null;
  }

  async getMemoryDistillRequestByTransmissionId(args: {
    transmissionId: string;
  }): Promise<MemoryDistillRequest | null> {
    for (const request of this.memoryDistillRequests.values()) {
      if (request.transmissionId === args.transmissionId) {
        return request;
      }
    }
    return null;
  }

  async updateMemoryDistillRequestReaffirm(args: {
    userId: string;
    requestId: string;
    reaffirmCount: number;
    lastReaffirmedAt: string;
  }): Promise<void> {
    const key = `${args.userId}:${args.requestId}`;
    const existing = this.memoryDistillRequests.get(key);
    if (!existing) return;
    this.memoryDistillRequests.set(key, {
      ...existing,
      reaffirmCount: args.reaffirmCount,
      lastReaffirmedAt: args.lastReaffirmedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  async completeMemoryDistillRequest(args: {
    userId: string;
    requestId: string;
    status: MemoryDistillStatus;
    outputEnvelopeJson?: string | null;
    memoryId?: string | null;
  }): Promise<void> {
    const key = `${args.userId}:${args.requestId}`;
    const existing = this.memoryDistillRequests.get(key);
    if (!existing) return;
    this.memoryDistillRequests.set(key, {
      ...existing,
      status: args.status,
      outputEnvelopeJson: args.outputEnvelopeJson ?? existing.outputEnvelopeJson ?? null,
      memoryId: args.memoryId ?? existing.memoryId ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  async setMemoryDistillContext(args: {
    userId: string;
    requestId: string;
    contextWindow: Array<{
      messageId: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: string;
    }>;
  }): Promise<void> {
    const key = `${args.userId}:${args.requestId}`;
    this.memoryDistillContexts.set(key, args.contextWindow);
  }

  async getMemoryDistillContext(args: {
    userId: string;
    requestId: string;
  }): Promise<Array<{
    messageId: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  }> | null> {
    const key = `${args.userId}:${args.requestId}`;
    return this.memoryDistillContexts.get(key) ?? null;
  }

  async consumeMemoryDistillContext(args: {
    userId: string;
    requestId: string;
  }): Promise<Array<{
    messageId: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  }> | null> {
    const key = `${args.userId}:${args.requestId}`;
    const context = this.memoryDistillContexts.get(key) ?? null;
    if (context) {
      this.memoryDistillContexts.delete(key);
    }
    return context;
  }

  async createMemoryArtifact(args: {
    userId: string;
    transmissionId?: string | null;
    threadId?: string | null;
    triggerMessageId?: string | null;
    type: MemoryArtifactType;
    domain?: string | null;
    title?: string | null;
    snippet: string;
    moodAnchor?: string | null;
    rigorLevel: MemoryRigorLevel;
    rigorReason?: string | null;
    tags: string[];
    importance?: string | null;
    fidelity: MemoryFidelity;
    transitionToHazyAt?: string | null;
    requestId?: string | null;
  }): Promise<MemoryArtifact> {
    if (args.requestId) {
      for (const artifact of this.memoryArtifacts.values()) {
        if (artifact.userId === args.userId && artifact.requestId === args.requestId) {
          return artifact;
        }
      }
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const artifact: MemoryArtifact = {
      id,
      userId: args.userId,
      transmissionId: args.transmissionId ?? null,
      threadId: args.threadId ?? null,
      triggerMessageId: args.triggerMessageId ?? null,
      type: args.type,
      domain: args.domain ?? null,
      title: args.title ?? null,
      snippet: args.snippet,
      moodAnchor: args.moodAnchor ?? null,
      rigorLevel: args.rigorLevel,
      rigorReason: args.rigorReason ?? null,
      tags: [...args.tags],
      importance: args.importance ?? null,
      fidelity: args.fidelity,
      transitionToHazyAt: args.transitionToHazyAt ?? null,
      requestId: args.requestId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.memoryArtifacts.set(id, artifact);
    return artifact;
  }

  async getMemoryArtifact(args: {
    userId: string;
    memoryId: string;
  }): Promise<MemoryArtifact | null> {
    const artifact = this.memoryArtifacts.get(args.memoryId);
    if (!artifact || artifact.userId !== args.userId) return null;
    return artifact;
  }

  async getMemoryArtifactByRequestId(args: {
    userId: string;
    requestId: string;
  }): Promise<MemoryArtifact | null> {
    for (const artifact of this.memoryArtifacts.values()) {
      if (artifact.userId === args.userId && artifact.requestId === args.requestId) {
        return artifact;
      }
    }
    return null;
  }

  async listMemoryArtifacts(args: {
    userId: string;
    domain?: string | null;
    tagsAny?: string[] | null;
    before?: string | null;
    limit?: number;
  }): Promise<{ items: MemoryArtifact[]; nextCursor: string | null }> {
    const tagsAny = args.tagsAny ?? null;
    const limit = args.limit ?? 50;
    const filtered = Array.from(this.memoryArtifacts.values()).filter((artifact) => {
      if (artifact.userId !== args.userId) return false;
      if (args.domain && artifact.domain !== args.domain) return false;
      if (args.before && artifact.createdAt >= args.before) return false;
      if (tagsAny && tagsAny.length > 0) {
        const hasTag = tagsAny.some((tag) => artifact.tags.includes(tag));
        if (!hasTag) return false;
      }
      return true;
    });

    const sorted = filtered.sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return a.id < b.id ? 1 : -1;
      }
      return a.createdAt < b.createdAt ? 1 : -1;
    });

    const items = sorted.slice(0, limit);
    const nextCursor = items.length === limit ? items[items.length - 1]?.createdAt ?? null : null;
    return { items, nextCursor };
  }

  async updateMemoryArtifact(args: {
    userId: string;
    memoryId: string;
    snippet?: string | null;
    tags?: string[] | null;
    moodAnchor?: string | null;
  }): Promise<MemoryArtifact | null> {
    const existing = this.memoryArtifacts.get(args.memoryId);
    if (!existing || existing.userId !== args.userId) return null;
    const next: MemoryArtifact = {
      ...existing,
      snippet: args.snippet ?? existing.snippet,
      tags: args.tags === undefined ? existing.tags : args.tags ?? [],
      moodAnchor: args.moodAnchor === undefined ? existing.moodAnchor ?? null : args.moodAnchor,
      updatedAt: new Date().toISOString(),
    };
    this.memoryArtifacts.set(existing.id, next);
    return next;
  }

  async deleteMemoryArtifact(args: {
    userId: string;
    memoryId: string;
  }): Promise<{ deleted: boolean; artifact?: MemoryArtifact | null }> {
    const existing = this.memoryArtifacts.get(args.memoryId);
    if (!existing || existing.userId !== args.userId) {
      return { deleted: false };
    }
    this.memoryArtifacts.delete(args.memoryId);
    return { deleted: true, artifact: existing };
  }

  async batchDeleteMemoryArtifacts(args: {
    userId: string;
    filter: {
      threadId?: string | null;
      domain?: string | null;
      tagsAny?: string[] | null;
      createdBefore?: string | null;
    };
  }): Promise<number> {
    const toDelete: string[] = [];
    for (const artifact of this.memoryArtifacts.values()) {
      if (artifact.userId !== args.userId) continue;
      if (args.filter.threadId && artifact.threadId !== args.filter.threadId) continue;
      if (args.filter.domain && artifact.domain !== args.filter.domain) continue;
      if (args.filter.createdBefore && artifact.createdAt >= args.filter.createdBefore) continue;
      if (args.filter.tagsAny && args.filter.tagsAny.length > 0) {
        const hasTag = args.filter.tagsAny.some((tag) => artifact.tags.includes(tag));
        if (!hasTag) continue;
      }
      toDelete.push(artifact.id);
    }

    for (const id of toDelete) {
      this.memoryArtifacts.delete(id);
    }

    return toDelete.length;
  }

  async clearMemoryArtifacts(args: { userId: string }): Promise<number> {
    let count = 0;
    for (const [id, artifact] of this.memoryArtifacts.entries()) {
      if (artifact.userId === args.userId) {
        this.memoryArtifacts.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async recordMemoryAudit(args: {
    userId: string;
    action: "delete" | "batch_delete" | "clear_all";
    requestId: string;
    threadId?: string | null;
    filter?: Record<string, any> | null;
    deletedCount: number;
  }): Promise<void> {
    const id = randomUUID();
    const entry = {
      id,
      userId: args.userId,
      action: args.action,
      requestId: args.requestId,
      threadId: args.threadId ?? null,
      filter: args.filter ?? null,
      deletedCount: args.deletedCount,
      createdAt: new Date().toISOString(),
    };
    this.memoryAudit.set(id, entry);
  }

  async updateTransmissionPolicy(args: {
    transmissionId: string;
    notificationPolicy?: NotificationPolicy | null;
    forcedPersona?: ModeDecision["personaLabel"] | null;
  }): Promise<void> {
    const existing = this.transmissions.get(args.transmissionId);
    if (!existing) return;
    this.transmissions.set(args.transmissionId, {
      ...existing,
      notificationPolicy: args.notificationPolicy ?? existing.notificationPolicy,
      forcedPersona: args.forcedPersona ?? existing.forcedPersona,
    });
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
    errorCode?: string | null;
    errorDetail?: Record<string, any> | null;
  }): Promise<void> {
    const existing = this.transmissions.get(args.transmissionId);
    if (!existing) return;
    this.transmissions.set(args.transmissionId, {
      ...existing,
      status: args.status,
      statusCode: args.statusCode ?? existing.statusCode,
      retryable: args.retryable ?? existing.retryable,
      errorCode: args.errorCode === undefined ? existing.errorCode : args.errorCode ?? undefined,
      errorDetail: args.errorDetail === undefined ? existing.errorDetail : args.errorDetail ?? undefined,
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
    personaLabel?: string | null;
  }): Promise<TraceRun> {
    const tr: TraceRun = {
      id: randomUUID(),
      transmissionId: args.transmissionId,
      level: args.level,
      personaLabel: args.personaLabel ?? null,
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

  async getTraceRunByTransmission(transmissionId: string): Promise<TraceRun | null> {
    let latest: TraceRun | null = null;
    for (const tr of this.traceRuns.values()) {
      if (tr.transmissionId !== transmissionId) continue;
      if (!latest || tr.createdAt > latest.createdAt) {
        latest = tr;
      }
    }
    return latest;
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
