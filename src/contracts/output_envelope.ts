import { z } from "zod";

import { NotificationPolicy } from "./chat";

const SHAPE_MAX_ARC_CHARS = 200;
const SHAPE_MAX_ITEMS = 6;
const SHAPE_MAX_ITEM_CHARS = 160;

const EvidenceRefSchema = z.object({
  evidence_id: z.string().min(1),
  span_id: z.string().min(1).optional(),
}).strict();

const ClaimSchema = z.object({
  claim_id: z.string().min(1),
  claim_text: z.string().min(1),
  evidence_refs: z.array(EvidenceRefSchema).min(1),
}).strict();

const CaptureSuggestionSchema = z.object({
  suggestion_id: z.string().min(1).optional(),
  suggestion_type: z.enum(["journal_entry", "reminder", "calendar_event"]),
  title: z.string().max(200),
  body: z.string().max(1000).optional(),
  suggested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  suggested_start_at: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.suggestion_type === "calendar_event") {
    if (!value.suggested_start_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suggested_start_at"],
        message: "calendar_event requires suggested_start_at",
      });
    }
    if (value.suggested_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suggested_date"],
        message: "calendar_event must not include suggested_date",
      });
    }
    return;
  }

  if (value.suggested_start_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["suggested_start_at"],
      message: "journal_entry/reminder must not include suggested_start_at",
    });
  }
});
const GhostKindSchema = z.enum(["memory_artifact", "journal_moment", "action_proposal"]);
const GhostRigorSchema = z.enum(["normal", "high"]);
const AffectLabelSchema = z.enum(["overwhelm", "insight", "gratitude", "resolve", "curiosity", "neutral"]);
const AffectConfidenceSchema = z.enum(["low", "med", "high"]);
const confidenceBucket = (value: number): z.infer<typeof AffectConfidenceSchema> => {
  if (value >= 0.7) return "high";
  if (value >= 0.34) return "med";
  return "low";
};

export const OutputEnvelopeShapeSchema = z.object({
  arc: z.string().min(1).max(SHAPE_MAX_ARC_CHARS),
  active: z.array(z.string().min(1).max(SHAPE_MAX_ITEM_CHARS)).max(SHAPE_MAX_ITEMS),
  parked: z.array(z.string().min(1).max(SHAPE_MAX_ITEM_CHARS)).max(SHAPE_MAX_ITEMS),
  decisions: z.array(z.string().min(1).max(SHAPE_MAX_ITEM_CHARS)).max(SHAPE_MAX_ITEMS),
  next: z.array(z.string().min(1).max(SHAPE_MAX_ITEM_CHARS)).max(SHAPE_MAX_ITEMS),
}).strict();

export const OutputEnvelopeAffectSignalSchema = z.object({
  label: AffectLabelSchema,
  intensity: z.number().min(0).max(1),
  confidence: z.preprocess((value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      const clamped = Math.min(1, Math.max(0, value));
      return confidenceBucket(clamped);
    }
    return value;
  }, AffectConfidenceSchema),
}).strict();

const JournalOfferSchema = z.object({
  momentId: z.string().min(1),
  momentType: z.enum(["overwhelm", "vent", "insight", "gratitude", "decision", "fun"]),
  phase: z.enum(["rising", "peak", "downshift", "settled"]),
  confidence: z.enum(["low", "med", "high"]),
  evidenceSpan: z.object({
    startMessageId: z.string().min(1),
    endMessageId: z.string().min(1),
  }).strict(),
  why: z.array(z.string()).max(6).optional(),
  offerEligible: z.boolean(),
}).strict();

const LibrarianGateSchema = z.object({
  version: z.literal("v0"),
  pruned_refs: z.number().int().min(0),
  unsupported_claims: z.number().int().min(0),
  support_score: z.number().min(0).max(1),
  verdict: z.enum(["pass", "prune", "flag"]),
}).strict();

const LatticeMetaSchema = z.object({
  status: z.enum(["hit", "miss", "fail"]),
  retrieval_trace: z.object({
    memory_ids: z.array(z.string().min(1)).optional(),
    memento_ids: z.array(z.string().min(1)).optional(),
    policy_capsule_ids: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
  scores: z.record(
    z.string().min(1),
    z.object({
      method: z.enum(["fts5_bm25", "vec_distance"]),
      value: z.number(),
    }).strict()
  ).optional(),
  counts: z.object({
    memories: z.number().int().min(0),
    mementos: z.number().int().min(0),
    policy_capsules: z.number().int().min(0),
  }).strict(),
  bytes_total: z.number().int().min(0),
  timings_ms: z.object({
    lattice_total: z.number().min(0).optional(),
    lattice_db: z.number().min(0).optional(),
    model_total: z.number().min(0).optional(),
    request_total: z.number().min(0).optional(),
  }).strict().optional(),
  warnings: z.array(z.string().min(1)).optional(),
}).strict();

const OutputEnvelopeMetaKeys = [
  "meta_version",
  "trace_run_id",
  "claims",
  "used_evidence_ids",
  "evidence_pack_id",
  "notification_policy",
  "capture_suggestion",
  "display_hint",
  "ghost_kind",
  "ghost_type",
  "memory_id",
  "trigger_message_id",
  "rigor_level",
  "snippet",
  "fact_null",
  "mood_anchor",
  "shape",
  "affect_signal",
  "journal_offer",
  "journalOffer",
  "librarian_gate",
  "lattice",
] as const;

export const OUTPUT_ENVELOPE_META_ALLOWED_KEYS = new Set<string>(OutputEnvelopeMetaKeys);

const OutputEnvelopeMetaSchema = z.object({
  meta_version: z.literal("v1").optional(),
  trace_run_id: z.string().min(1).optional(),
  claims: z.array(ClaimSchema).min(1).optional(),
  used_evidence_ids: z.array(z.string().min(1)).optional(),
  evidence_pack_id: z.string().min(1).optional(),
  notification_policy: NotificationPolicy.optional(),
  capture_suggestion: CaptureSuggestionSchema.optional(),
  display_hint: z.literal("ghost_card").optional(),
  ghost_kind: GhostKindSchema.optional(),
  ghost_type: z.enum(["memory", "journal", "action"]).optional(),
  memory_id: z.string().nullable().optional(),
  trigger_message_id: z.string().min(1).optional(),
  rigor_level: GhostRigorSchema.nullable().optional(),
  snippet: z.string().nullable().optional(),
  fact_null: z.boolean().optional(),
  mood_anchor: z.string().nullable().optional(),
  shape: OutputEnvelopeShapeSchema.optional(),
  affect_signal: OutputEnvelopeAffectSignalSchema.optional(),
  journalOffer: JournalOfferSchema.optional(),
  journal_offer: JournalOfferSchema.optional(),
  librarian_gate: LibrarianGateSchema.optional(),
  lattice: LatticeMetaSchema.optional(),
})
  .strip()
  .superRefine((value, ctx) => {
    const ghostKeys = [
      "ghost_kind",
      "ghost_type",
      "memory_id",
      "rigor_level",
      "snippet",
      "fact_null",
      "mood_anchor",
    ] as const;

    const hasAnyGhostField = ghostKeys.some((key) => value[key] !== undefined);
    const isGhost = value.display_hint === "ghost_card";

    if (value.ghost_type !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ghost_type"],
        message: "ghost_type is deprecated; use ghost_kind",
      });
    }

    if (hasAnyGhostField && !isGhost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["display_hint"],
        message: "display_hint must be ghost_card when ghost metadata is present",
      });
      return;
    }

    if (!isGhost) return;

    if (value.ghost_kind === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ghost_kind"],
        message: "ghost_kind is required for ghost_card",
      });
    }

    if (value.memory_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory_id"],
        message: "memory_id is required for ghost_card (nullable allowed)",
      });
    }

    if (value.rigor_level === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rigor_level"],
        message: "rigor_level is required for ghost_card (nullable allowed)",
      });
    }

    if (value.snippet === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snippet"],
        message: "snippet is required for ghost_card (nullable allowed)",
      });
    }

    if (value.fact_null === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fact_null"],
        message: "fact_null is required for ghost_card",
      });
    }

    if (value.fact_null === true) {
      if (value.memory_id !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memory_id"],
          message: "memory_id must be null when fact_null is true",
        });
      }
      if (value.snippet !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["snippet"],
          message: "snippet must be null when fact_null is true",
        });
      }
    }

    if (value.fact_null === false) {
      if (value.memory_id === null || value.memory_id === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memory_id"],
          message: "memory_id must be a non-empty string when fact_null is false",
        });
      }
      if (value.snippet === null || value.snippet === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["snippet"],
          message: "snippet must be a non-empty string when fact_null is false",
        });
      }
    }
  });

export const OutputEnvelopeSchema = z.object({
  assistant_text: z.string().min(1),
  assumptions: z.array(z.string()).optional(),
  unknowns: z.array(z.string()).optional(),
  used_context_ids: z.array(z.string()).optional(),
  notification_policy: NotificationPolicy.optional(),
  // Future structured outputs (e.g., capture_suggestion) live under meta.
  meta: OutputEnvelopeMetaSchema.optional(),
}).strict();

const OutputEnvelopeV0MinMetaSchema = z.object({
  meta_version: z.literal("v1").optional(),
}).passthrough();

export const OutputEnvelopeV0MinSchema = z.object({
  assistant_text: z.string().min(1),
  assumptions: z.array(z.string()).optional(),
  unknowns: z.array(z.string()).optional(),
  used_context_ids: z.array(z.string()).optional(),
  notification_policy: NotificationPolicy.optional(),
  meta: OutputEnvelopeV0MinMetaSchema.optional(),
}).strict();

export type OutputEnvelope = z.infer<typeof OutputEnvelopeSchema>;
export type OutputEnvelopeMeta = z.infer<typeof OutputEnvelopeMetaSchema>;
export type OutputEnvelopeClaim = z.infer<typeof ClaimSchema>;
export type OutputEnvelopeEvidenceRef = z.infer<typeof EvidenceRefSchema>;
