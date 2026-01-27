import { z } from "zod";

export const EvidenceSpanSchema = z.object({
  startMessageId: z.string().min(1),
  endMessageId: z.string().min(1),
}).strict();

export const CpbRefSchema = z.object({
  cpbId: z.string().min(1),
  type: z.enum(["journalStyle"]).optional(),
}).strict();

export const JournalDraftRequestSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  mode: z.enum(["verbatim", "assist"]),
  evidenceSpan: EvidenceSpanSchema,
  cpbRefs: z.array(CpbRefSchema).optional(),
  preferences: z.object({
    maxLines: z.number().int().min(1).max(50).optional(),
    includeTagsSuggested: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const JournalDraftEnvelopeSchema = z.object({
  type: z.literal("JournalDraftEnvelope"),
  draftId: z.string().min(1),
  threadId: z.string().min(1),
  mode: z.enum(["verbatim", "assist"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  tagsSuggested: z.array(z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_\- ]*$/)).optional(),
  sourceSpan: z.object({
    threadId: z.string().min(1),
    startMessageId: z.string().min(1),
    endMessageId: z.string().min(1),
  }).strict(),
  meta: z.object({
    usedCpbIds: z.array(z.string().min(1)),
    assumptions: z.array(z.object({
      id: z.string().min(1),
      text: z.string().min(1).max(2000),
    }).strict()),
    unknowns: z.array(z.object({
      id: z.string().min(1),
      text: z.string().min(1).max(2000),
    }).strict()),
    evidenceBinding: z.object({
      sourceSpan: z.object({
        threadId: z.string().min(1),
        startMessageId: z.string().min(1),
        endMessageId: z.string().min(1),
      }).strict(),
      nonInvention: z.boolean(),
    }).strict(),
  }).strict(),
}).strict();

export const JournalEntrySchema = z.object({
  entryId: z.string().min(1),
  createdTs: z.string().datetime(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  tags: z.array(z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_\- ]*$/)).default([]),
  sourceSpan: z.object({
    threadId: z.string().min(1),
    startMessageId: z.string().min(1),
    endMessageId: z.string().min(1),
  }).strict(),
  draftMeta: z.object({
    mode: z.enum(["assist", "verbatim"]),
    cpbId: z.string().min(1).optional(),
    draftId: z.string().min(1).optional(),
  }).strict(),
}).strict();

export const JournalEntryCreateRequestSchema = z.object({
  requestId: z.string().min(1),
  entry: JournalEntrySchema,
  consent: z.object({
    explicitUserConsent: z.literal(true),
  }).strict(),
}).strict();

export const JournalEntryPatchRequestSchema = z.object({
  requestId: z.string().min(1),
  patch: z.object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20000).optional(),
    tags: z.array(z.string().min(1)).optional(),
  }).strict(),
  consent: z.object({
    explicitUserConsent: z.literal(true),
  }).strict(),
}).strict();
