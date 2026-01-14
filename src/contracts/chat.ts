import { z } from "zod";

import type { EvidenceSummary, EvidenceWarning } from "./evidence_warning";

export const TraceConfig = z.object({
  level: z.enum(["info", "debug"]).default("info"),
}).strict();

export type TraceConfig = z.infer<typeof TraceConfig>;

// Driver Block reference (for system defaults)
export const DriverBlockRef = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
}).strict();

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
}).strict();

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
}).strict();

export type PacketInput = z.infer<typeof PacketInput>;

export type ModeDecision = {
  modeLabel: "Ida" | "Sole" | "System-mode";
  domainFlags: string[];
  confidence: number;
  checkpointNeeded: boolean;
  reasons: string[];
  version: string;
};

export type Capture = {
  captureId: string;
  kind: "url";
  url: string;
  capturedAt: string;
  title?: string;
  source: "user_provided" | "auto_detected";
};

export type ClaimSupport = {
  supportId: string;
  type: "url_capture" | "text_snippet";
  captureId?: string;
  snippetText?: string;
  snippetHash?: string;
  createdAt: string;
};

export type ClaimMapEntry = {
  claimId: string;
  claimText: string;
  supportIds: string[];
  createdAt: string;
};

export type Evidence = {
  captures?: Capture[];
  supports?: ClaimSupport[];
  claims?: ClaimMapEntry[];
};

export type { EvidenceSummary, EvidenceWarning };
