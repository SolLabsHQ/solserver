import { z } from "zod";

export const TraceConfig = z.object({
  level: z.enum(["info", "debug"]).default("info"),
});

export type TraceConfig = z.infer<typeof TraceConfig>;

// Driver Block reference (for system defaults)
export const DriverBlockRef = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});

export type DriverBlockRef = z.infer<typeof DriverBlockRef>;

// Driver Block inline (user-approved blocks carried inline)
export const DriverBlockInline = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  scope: z.enum(["global", "thread"]),
  definition: z.string().min(1).max(10_000), // Bounded definition text
  source: z.enum(["user_created", "assistant_proposed", "system_shipped"]),
  approvedAt: z.string().datetime(),
  threadId: z.string().optional(),
  notes: z.string().optional(),
});

export type DriverBlockInline = z.infer<typeof DriverBlockInline>;

export const PacketInput = z.object({
  packetType: z.literal("chat").default("chat"),
  threadId: z.string().min(1),
  // Idempotency key from client (SolMobile). If provided, server will dedupe retries.
  clientRequestId: z.string().min(1).optional(),
  message: z.string().min(1).max(20_000),
  traceConfig: TraceConfig.optional(),
  // Driver Blocks (v0) - always additive
  driverBlockRefs: z.array(DriverBlockRef).optional(), // Bounded by enforcement logic
  driverBlockInline: z.array(DriverBlockInline).optional(), // Bounded by enforcement logic
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
