import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  JournalDraftRequestSchema,
  JournalDraftEnvelopeSchema,
  JournalEntryCreateRequestSchema,
  JournalEntryPatchRequestSchema,
  JournalEntrySchema,
} from "../contracts/journal";
import type { ControlPlaneStore, Transmission } from "../store/control_plane_store";

const getUserId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const header = req.headers["x-sol-user-id"] ?? req.headers["x-user-id"];
  if (Array.isArray(header)) {
    return header[0]?.trim() ?? null;
  }
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  return null;
};

const requireUserId = (req: any, reply: any): string | null => {
  const userId = getUserId(req);
  if (!userId) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return userId;
};

const extractUnrecognizedKeys = (error: z.ZodError) => {
  const unrecognized = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        unrecognized.add(key);
      }
    }
  }
  return Array.from(unrecognized);
};

const normalizeDraftRequest = (body: any) => {
  if (!body || typeof body !== "object") return body;
  const normalized: Record<string, any> = { ...body };
  if (normalized.requestId === undefined && normalized.request_id !== undefined) {
    normalized.requestId = normalized.request_id;
    delete normalized.request_id;
  }
  if (normalized.threadId === undefined && normalized.thread_id !== undefined) {
    normalized.threadId = normalized.thread_id;
    delete normalized.thread_id;
  }
  if (normalized.evidenceSpan === undefined && normalized.evidence_span !== undefined) {
    normalized.evidenceSpan = normalized.evidence_span;
    delete normalized.evidence_span;
  }
  if (normalized.cpbRefs === undefined && normalized.cpb_refs !== undefined) {
    normalized.cpbRefs = normalized.cpb_refs;
    delete normalized.cpb_refs;
  }
  if (normalized.preferences && typeof normalized.preferences === "object") {
    const prefs = { ...normalized.preferences };
    if (prefs.maxLines === undefined && prefs.max_lines !== undefined) {
      prefs.maxLines = prefs.max_lines;
      delete prefs.max_lines;
    }
    if (prefs.includeTagsSuggested === undefined && prefs.include_tags_suggested !== undefined) {
      prefs.includeTagsSuggested = prefs.include_tags_suggested;
      delete prefs.include_tags_suggested;
    }
    normalized.preferences = prefs;
  }
  if (normalized.evidenceSpan && typeof normalized.evidenceSpan === "object") {
    const span = { ...normalized.evidenceSpan };
    if (span.startMessageId === undefined && span.start_message_id !== undefined) {
      span.startMessageId = span.start_message_id;
      delete span.start_message_id;
    }
    if (span.endMessageId === undefined && span.end_message_id !== undefined) {
      span.endMessageId = span.end_message_id;
      delete span.end_message_id;
    }
    normalized.evidenceSpan = span;
  }
  if (Array.isArray(normalized.cpbRefs)) {
    normalized.cpbRefs = normalized.cpbRefs.map((ref: any) => {
      if (!ref || typeof ref !== "object") return ref;
      const mapped = { ...ref };
      if (mapped.cpbId === undefined && mapped.cpb_id !== undefined) {
        mapped.cpbId = mapped.cpb_id;
        delete mapped.cpb_id;
      }
      return mapped;
    });
  }
  return normalized;
};

const normalizeEntry = (entry: any) => {
  if (!entry || typeof entry !== "object") return entry;
  const normalized: Record<string, any> = { ...entry };
  if (normalized.entryId === undefined && normalized.entry_id !== undefined) {
    normalized.entryId = normalized.entry_id;
    delete normalized.entry_id;
  }
  if (normalized.createdTs === undefined && normalized.created_ts !== undefined) {
    normalized.createdTs = normalized.created_ts;
    delete normalized.created_ts;
  }
  if (normalized.sourceSpan === undefined && normalized.source_span !== undefined) {
    normalized.sourceSpan = normalized.source_span;
    delete normalized.source_span;
  }
  if (normalized.draftMeta === undefined && normalized.draft_meta !== undefined) {
    normalized.draftMeta = normalized.draft_meta;
    delete normalized.draft_meta;
  }
  if (normalized.sourceSpan && typeof normalized.sourceSpan === "object") {
    const span = { ...normalized.sourceSpan };
    if (span.threadId === undefined && span.thread_id !== undefined) {
      span.threadId = span.thread_id;
      delete span.thread_id;
    }
    if (span.startMessageId === undefined && span.start_message_id !== undefined) {
      span.startMessageId = span.start_message_id;
      delete span.start_message_id;
    }
    if (span.endMessageId === undefined && span.end_message_id !== undefined) {
      span.endMessageId = span.end_message_id;
      delete span.end_message_id;
    }
    normalized.sourceSpan = span;
  }
  if (normalized.draftMeta && typeof normalized.draftMeta === "object") {
    const meta = { ...normalized.draftMeta };
    if (meta.cpbId === undefined && meta.cpb_id !== undefined) {
      meta.cpbId = meta.cpb_id;
      delete meta.cpb_id;
    }
    if (meta.draftId === undefined && meta.draft_id !== undefined) {
      meta.draftId = meta.draft_id;
      delete meta.draft_id;
    }
    normalized.draftMeta = meta;
  }
  return normalized;
};

const normalizeEntryCreateRequest = (body: any) => {
  if (!body || typeof body !== "object") return body;
  const normalized: Record<string, any> = { ...body };
  if (normalized.requestId === undefined && normalized.request_id !== undefined) {
    normalized.requestId = normalized.request_id;
    delete normalized.request_id;
  }
  if (normalized.consent && typeof normalized.consent === "object") {
    const consent = { ...normalized.consent };
    if (consent.explicitUserConsent === undefined && consent.explicit_user_consent !== undefined) {
      consent.explicitUserConsent = consent.explicit_user_consent;
      delete consent.explicit_user_consent;
    }
    normalized.consent = consent;
  }
  if (normalized.entry) {
    normalized.entry = normalizeEntry(normalized.entry);
  }
  return normalized;
};

const normalizeEntryPatchRequest = (body: any) => {
  if (!body || typeof body !== "object") return body;
  const normalized: Record<string, any> = { ...body };
  if (normalized.requestId === undefined && normalized.request_id !== undefined) {
    normalized.requestId = normalized.request_id;
    delete normalized.request_id;
  }
  if (normalized.consent && typeof normalized.consent === "object") {
    const consent = { ...normalized.consent };
    if (consent.explicitUserConsent === undefined && consent.explicit_user_consent !== undefined) {
      consent.explicitUserConsent = consent.explicit_user_consent;
      delete consent.explicit_user_consent;
    }
    normalized.consent = consent;
  }
  return normalized;
};

const resolveSpanTransmissions = (
  transmissions: Transmission[],
  startMessageId: string,
  endMessageId: string
): Transmission[] | null => {
  const startIndex = transmissions.findIndex((transmission) => transmission.id === startMessageId);
  const endIndex = transmissions.findIndex((transmission) => transmission.id === endMessageId);

  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    return null;
  }

  return transmissions.slice(startIndex, endIndex + 1);
};

const buildDraftBody = (args: {
  mode: "verbatim" | "assist";
  messages: string[];
  maxLines?: number;
}): string => {
  const base = args.messages.join("\n\n");
  const lines = base.split(/\r?\n/);
  const limited = args.maxLines ? lines.slice(0, args.maxLines) : lines;
  return limited.join("\n");
};

export async function journalRoutes(
  app: FastifyInstance,
  opts: { store: ControlPlaneStore }
) {
  const { store } = opts;

  app.options("/journal/drafts", async (_req, reply) => reply.code(204).send());
  app.options("/journal/entries", async (_req, reply) => reply.code(204).send());
  app.options("/journal/entries/:entry_id", async (_req, reply) => reply.code(204).send());

  app.post("/journal/drafts", async (req, reply) => {
    const normalized = normalizeDraftRequest(req.body);
    const parsed = JournalDraftRequestSchema.safeParse(normalized);
    if (!parsed.success) {
      const unrecognizedKeys = extractUnrecognizedKeys(parsed.error);
      if (unrecognizedKeys.length > 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Unrecognized keys in request",
          unrecognizedKeys,
        });
      }
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const data = parsed.data;
    const transmissions = await store.listTransmissionsByThread({ threadId: data.threadId });
    const spanTransmissions = resolveSpanTransmissions(
      transmissions,
      data.evidenceSpan.startMessageId,
      data.evidenceSpan.endMessageId
    );
    if (!spanTransmissions || spanTransmissions.length === 0) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Evidence span message ids must reference server transmission ids for this thread",
      });
    }

    const spanMessages = spanTransmissions.map((transmission) => transmission.message);
    const sourceSpan = {
      threadId: data.threadId,
      startMessageId: data.evidenceSpan.startMessageId,
      endMessageId: data.evidenceSpan.endMessageId,
    };
    const usedCpbIds = data.cpbRefs?.map((ref) => ref.cpbId).filter(Boolean) ?? [];
    const maxLines = data.preferences?.maxLines;
    const body = buildDraftBody({
      mode: data.mode,
      messages: spanMessages,
      maxLines,
    });
    const title = data.mode === "assist" ? "Journal Draft" : "Journal Draft (Verbatim)";

    const envelope = {
      type: "JournalDraftEnvelope",
      draftId: randomUUID(),
      threadId: data.threadId,
      mode: data.mode,
      title,
      body,
      tagsSuggested: [],
      sourceSpan,
      meta: {
        usedCpbIds,
        assumptions: [],
        unknowns: [],
        evidenceBinding: {
          sourceSpan,
          nonInvention: data.mode === "verbatim",
        },
      },
    };

    const validation = JournalDraftEnvelopeSchema.safeParse(envelope);
    if (!validation.success) {
      return reply.code(500).send({
        error: "schema_invalid",
        details: validation.error.flatten(),
      });
    }

    return reply.code(200).send(envelope);
  });

  app.post("/journal/entries", async (req, reply) => {
    const normalized = normalizeEntryCreateRequest(req.body);
    const parsed = JournalEntryCreateRequestSchema.safeParse(normalized);
    if (!parsed.success) {
      const unrecognizedKeys = extractUnrecognizedKeys(parsed.error);
      if (unrecognizedKeys.length > 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Unrecognized keys in request",
          unrecognizedKeys,
        });
      }
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const userId = requireUserId(req, reply);
    if (!userId) return;

    const entry = parsed.data.entry;
    const now = new Date().toISOString();
    const stored = await store.createJournalEntry({
      entry: {
        entryId: entry.entryId,
        userId,
        createdTs: entry.createdTs,
        updatedAt: now,
        title: entry.title,
        body: entry.body,
        tags: entry.tags ?? [],
        sourceSpan: entry.sourceSpan,
        draftMeta: entry.draftMeta,
      },
    });

    return reply.code(200).send({
      requestId: parsed.data.requestId,
      entry: stored,
    });
  });

  app.get("/journal/entries", async (req, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const threadId = typeof query.thread_id === "string"
      ? query.thread_id
      : typeof query.threadId === "string"
        ? query.threadId
        : null;
    const limit = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const cursor = typeof query.cursor === "string" ? query.cursor : null;

    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "limit must be a positive number",
      });
    }

    const userId = requireUserId(req, reply);
    if (!userId) return;

    const result = await store.listJournalEntries({
      userId,
      threadId,
      before: cursor,
      limit,
    });

    return reply.code(200).send({
      requestId: randomUUID(),
      items: result.items,
      nextCursor: result.nextCursor,
    });
  });

  app.patch("/journal/entries/:entry_id", async (req, reply) => {
    const normalized = normalizeEntryPatchRequest(req.body);
    const parsed = JournalEntryPatchRequestSchema.safeParse(normalized);
    if (!parsed.success) {
      const unrecognizedKeys = extractUnrecognizedKeys(parsed.error);
      if (unrecognizedKeys.length > 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Unrecognized keys in request",
          unrecognizedKeys,
        });
      }
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten(),
      });
    }

    const userId = requireUserId(req, reply);
    if (!userId) return;
    const entryId = (req.params as any).entry_id as string;

    if (
      parsed.data.patch.title === undefined
      && parsed.data.patch.body === undefined
      && parsed.data.patch.tags === undefined
    ) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "patch must include at least one field",
      });
    }

    const updated = await store.updateJournalEntry({
      userId,
      entryId,
      title: parsed.data.patch.title,
      body: parsed.data.patch.body,
      tags: parsed.data.patch.tags,
    });

    if (!updated) {
      return reply.code(404).send({ error: "not_found" });
    }

    return reply.code(200).send({
      requestId: parsed.data.requestId,
      entryId: updated.entryId,
      updatedAt: updated.updatedAt,
    });
  });

  app.delete("/journal/entries/:entry_id", async (req, reply) => {
    const userId = requireUserId(req, reply);
    if (!userId) return;
    const entryId = (req.params as any).entry_id as string;

    const deleted = await store.deleteJournalEntry({ userId, entryId });
    if (!deleted) {
      return reply.code(204).send();
    }
    return reply.code(204).send();
  });
}
