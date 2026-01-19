import { z } from "zod";

import type { EvidenceSummary, EvidenceWarning } from "./evidence_warning";

export const TraceConfig = z.object({
  level: z.enum(["info", "debug"]).default("info"),
  forceEvidence: z.boolean().optional(),
}).strict();

export type TraceConfig = z.infer<typeof TraceConfig>;

export const ProviderHints = z.object({
  model: z.string().min(1).optional(),
  tier: z.enum(["nano", "mini", "full"]).optional(),
}).strict();

export type ProviderHints = z.infer<typeof ProviderHints>;

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
  definition: z.string().min(1).max(100_000), // Allow oversize; trimmed by enforcement
  source: z.enum(["user_created", "assistant_proposed", "system_shipped"]),
  approvedAt: z.string().datetime(),
  threadId: z.string().optional(),
  notes: z.string().optional(),
}).strict();

export type DriverBlockInline = z.infer<typeof DriverBlockInline>;

// Evidence types (v0)

// Capture (URL capture metadata)
export const Capture = z.object({
  captureId: z.string().min(1),
  kind: z.literal("url"),
  url: z.string().min(1).max(2048),
  capturedAt: z.string().datetime(),
  title: z.string().max(256).optional(),
  source: z.literal("user_provided"),
}).strict();

export type Capture = z.infer<typeof Capture>;

// ClaimSupport (evidence backing a claim)
const ClaimSupportUrlCapture = z.object({
  supportId: z.string().min(1),
  type: z.literal("url_capture"),
  captureId: z.string().min(1),
  snippetText: z.string().min(1).max(10_000).optional(),
  snippetHash: z.string().optional(),
  createdAt: z.string().datetime(),
}).strict();

const ClaimSupportTextSnippet = z.object({
  supportId: z.string().min(1),
  type: z.literal("text_snippet"),
  snippetText: z.string().min(1).max(10_000),
  snippetHash: z.string().optional(),
  captureId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
}).strict();

export const ClaimSupport = z.discriminatedUnion("type", [
  ClaimSupportUrlCapture,
  ClaimSupportTextSnippet,
]);

export type ClaimSupport = z.infer<typeof ClaimSupport>;

// ClaimMapEntry (claim with supporting evidence)
export const ClaimMapEntry = z.object({
  claimId: z.string().min(1),
  claimText: z.string().min(1).max(2000),
  supportIds: z.array(z.string()).max(20),
  createdAt: z.string().datetime(),
}).strict();

export type ClaimMapEntry = z.infer<typeof ClaimMapEntry>;

// Evidence (top-level evidence container)
export const Evidence = z.object({
  captures: z.array(Capture).max(25).optional(),
  supports: z.array(ClaimSupport).max(50).optional(),
  claims: z.array(ClaimMapEntry).max(50).optional(),
}).strict();

export type Evidence = z.infer<typeof Evidence>;

export const PacketInput = z.object({
  packetType: z.literal("chat").default("chat"),
  threadId: z.string().min(1),
  // Idempotency key from client (SolMobile). If provided, server will dedupe retries.
  clientRequestId: z.string().min(1).optional(),
  message: z.string().min(1).max(20_000),
  traceConfig: TraceConfig.optional(),
  providerHints: ProviderHints.optional(),
  // Driver Blocks (v0) - always additive
  driverBlockRefs: z.array(DriverBlockRef).optional(), // Bounded by enforcement logic
  driverBlockInline: z.array(DriverBlockInline).optional(), // Bounded by enforcement logic
  // Evidence (v0) - typed validation
  evidence: Evidence.optional(),
  meta: z.record(z.string(), z.any()).optional(),
}).strict();

export type PacketInput = z.infer<typeof PacketInput>;

export type ModeDecision = {
  modeLabel: "Ida" | "Sole" | "System-mode";
  personaLabel?: "ida" | "sole" | "cassandra" | "diogenes" | "system";
  domainFlags: string[];
  confidence: number;
  checkpointNeeded: boolean;
  reasons: string[];
  version: string;
};

export type { EvidenceSummary, EvidenceWarning };
