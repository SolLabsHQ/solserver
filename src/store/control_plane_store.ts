import { randomUUID } from "node:crypto";

import type { PacketInput, ModeDecision } from "../contracts/chat";

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

export interface ControlPlaneStore {
  createTransmission(args: {
    packet: PacketInput;
    modeDecision: ModeDecision;
  }): Promise<Transmission>;

  getTransmissionByClientRequestId(clientRequestId: string): Promise<Transmission | null>;

  updateTransmissionStatus(args: {
    transmissionId: string;
    status: TransmissionStatus;
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
}

export class MemoryControlPlaneStore implements ControlPlaneStore {
  private transmissions = new Map<string, Transmission>();
  private attempts = new Map<string, DeliveryAttempt[]>();
  private usage = new Map<string, UsageRecord[]>();
  private clientRequestIndex = new Map<string, string>(); // clientRequestId -> transmissionId
  private chatResults = new Map<string, ChatResult>(); // transmissionId -> cached result

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
  }): Promise<void> {
    const existing = this.transmissions.get(args.transmissionId);
    if (!existing) return;
    this.transmissions.set(args.transmissionId, { ...existing, status: args.status });
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
}