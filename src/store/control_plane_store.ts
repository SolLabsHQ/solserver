

import { randomUUID } from "node:crypto";

import type { PacketInput, ModeDecision } from "../contracts/chat";

export type TransmissionStatus = "created" | "completed" | "failed";
export type DeliveryStatus = "succeeded" | "failed";

export type Transmission = {
  id: string;
  packetType: "chat";
  threadId: string;
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

export interface ControlPlaneStore {
  createTransmission(args: {
    packet: PacketInput;
    modeDecision: ModeDecision;
  }): Promise<Transmission>;

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
}

export class MemoryControlPlaneStore implements ControlPlaneStore {
  private transmissions = new Map<string, Transmission>();
  private attempts = new Map<string, DeliveryAttempt[]>();
  private usage = new Map<string, UsageRecord[]>();

  async createTransmission(args: {
    packet: PacketInput;
    modeDecision: ModeDecision;
  }): Promise<Transmission> {
    const id = randomUUID();
    const t: Transmission = {
      id,
      packetType: "chat",
      threadId: args.packet.threadId,
      message: args.packet.message,
      modeDecision: args.modeDecision,
      createdAt: new Date().toISOString(),
      status: "created",
    };

    this.transmissions.set(id, t);
    return t;
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
}