import { z } from "zod";

export const TraceConfig = z.object({
  level: z.enum(["info", "debug"]).default("info"),
});

export type TraceConfig = z.infer<typeof TraceConfig>;

export const PacketInput = z.object({
  packetType: z.literal("chat").default("chat"),
  threadId: z.string().min(1),
  // Idempotency key from client (SolMobile). If provided, server will dedupe retries.
  clientRequestId: z.string().min(1).optional(),
  message: z.string().min(1).max(20_000),
  traceConfig: TraceConfig.optional(),
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
