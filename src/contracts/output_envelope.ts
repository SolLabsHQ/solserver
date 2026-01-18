import { z } from "zod";

const EvidenceRefSchema = z.object({
  evidence_id: z.string().min(1),
  span_id: z.string().min(1).optional(),
}).strict();

const ClaimSchema = z.object({
  claim_id: z.string().min(1),
  claim_text: z.string().min(1),
  evidence_refs: z.array(EvidenceRefSchema).min(1),
}).strict();

// Meta is passthrough on ingest for forward-compatibility; response egress is allowlisted.
const OutputEnvelopeMetaSchema = z.object({
  meta_version: z.literal("v1").optional(),
  claims: z.array(ClaimSchema).min(1).optional(),
  used_evidence_ids: z.array(z.string().min(1)).optional(),
  evidence_pack_id: z.string().min(1).optional(),
}).passthrough();

export const OutputEnvelopeSchema = z.object({
  assistant_text: z.string().min(1),
  assumptions: z.array(z.string()).optional(),
  unknowns: z.array(z.string()).optional(),
  used_context_ids: z.array(z.string()).optional(),
  // Future structured outputs (e.g., capture_suggestion) live under meta.
  meta: OutputEnvelopeMetaSchema.optional(),
}).strict();

export type OutputEnvelope = z.infer<typeof OutputEnvelopeSchema>;
export type OutputEnvelopeMeta = z.infer<typeof OutputEnvelopeMetaSchema>;
export type OutputEnvelopeClaim = z.infer<typeof ClaimSchema>;
export type OutputEnvelopeEvidenceRef = z.infer<typeof EvidenceRefSchema>;
