import { z } from "zod";

export const PacketInput = z.object({
  packetType: z.literal("chat").default("chat"),
  threadId: z.string().min(1),
  message: z.string().min(1).max(20_000),
  meta: z.record(z.string(), z.any()).optional(),
});

export type PacketInput = z.infer<typeof PacketInput>;

export type ModeDecision = {
  modeLabel: "Ida" | "Sole" | "System-mode";
  domainFlags: string[];
  confidence: number;
  checkpointNeeded: boolean;
  reasons: string[];
  version: string;
};
