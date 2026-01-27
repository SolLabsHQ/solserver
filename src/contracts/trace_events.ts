import { z } from "zod";

export const JournalOfferEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum([
    "journal_offer_shown",
    "journal_offer_accepted",
    "journal_offer_declined",
    "journal_offer_muted_or_tuned",
    "journal_draft_generated",
    "journal_entry_saved",
    "journal_entry_edited_before_save",
  ]),
  ts: z.string().datetime(),
  threadId: z.string().min(1),
  momentId: z.string().min(1),
  evidenceSpan: z.object({
    startMessageId: z.string().min(1),
    endMessageId: z.string().min(1),
  }).strict(),
  phaseAtOffer: z.enum(["rising", "peak", "downshift", "settled"]).optional(),
  modeSelected: z.enum(["verbatim", "assist"]).optional(),
  userAction: z.enum(["save", "edit", "not_now", "disable_or_tune"]).optional(),
  cooldownActive: z.boolean().optional(),
  latencyMs: z.number().int().min(0).optional(),
  refs: z.object({
    cpbId: z.string().min(1).optional(),
    draftId: z.string().min(1).optional(),
    entryId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
  }).strict().optional(),
  tuning: z.object({
    newCooldownMinutes: z.number().int().min(0).max(1440).optional(),
    avoidPeakOverwhelm: z.boolean().optional(),
    offersEnabled: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const DeviceMuseObservationSchema = z.object({
  observationId: z.string().min(1),
  ts: z.string().datetime(),
  localUserUuid: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  version: z.literal("device-muse-observation-v0.1"),
  source: z.enum(["apple_intelligence"]),
  detectedType: z.string().min(1).max(64),
  intensity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  phaseHint: z.enum(["rising", "peak", "downshift", "settled"]).optional(),
}).strict();

export const TraceEventSchema = z.union([JournalOfferEventSchema, DeviceMuseObservationSchema]);

export const TraceEventsRequestSchema = z.object({
  requestId: z.string().min(1),
  localUserUuid: z.string().min(1),
  events: z.array(TraceEventSchema).min(1),
}).strict();
