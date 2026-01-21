import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { buildOutputEnvelopeMeta } from "../control-plane/orchestrator";
import type { OutputEnvelope } from "../contracts/output_envelope";
import {
  distillContextWindow,
  FALLBACK_PROMPT,
  inferRigorLevel,
  type ContextMessage,
} from "../memory/synaptic_gate";
import { MemoryControlPlaneStore, type ControlPlaneStore } from "../store/control_plane_store";

const ConsentSchema = z.object({
  explicit_user_consent: z.literal(true),
}).strict();

const ContextMessageSchema = z.object({
  message_id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  created_at: z.string().datetime(),
}).strict();

const DistillRequestSchema = z.object({
  request_id: z.string().min(1),
  thread_id: z.string().min(1),
  trigger_message_id: z.string().min(1),
  context_window: z.array(ContextMessageSchema).min(1).max(15),
  reaffirm_count: z.number().int().min(0).optional(),
  consent: ConsentSchema,
}).strict();

const ManualMemorySchema = z.object({
  domain: z.string().min(1),
  title: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  importance: z.string().min(1).optional(),
  content: z.string().min(1),
  mood_anchor: z.string().min(1).optional(),
  rigor_level: z.enum(["normal", "high"]).optional(),
}).strict();

const ManualMemorySourceSchema = z.object({
  thread_id: z.string().min(1),
  message_id: z.string().min(1),
  created_at: z.string().datetime(),
}).strict();

const MemoryCreateRequestSchema = z.object({
  request_id: z.string().min(1),
  memory: ManualMemorySchema,
  source: ManualMemorySourceSchema.optional(),
  consent: ConsentSchema,
}).strict();

const MemoryPatchRequestSchema = z.object({
  request_id: z.string().min(1),
  patch: z.object({
    snippet: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    mood_anchor: z.string().nullable().optional(),
  }).strict(),
  consent: ConsentSchema,
}).strict();

const BatchDeleteRequestSchema = z.object({
  request_id: z.string().min(1),
  filter: z.object({
    thread_id: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    tags_any: z.array(z.string().min(1)).optional(),
    created_before: z.string().datetime().optional(),
  }).strict(),
  confirm: z.literal(true),
}).strict();

const ClearAllRequestSchema = z.object({
  request_id: z.string().min(1),
  confirm: z.literal(true),
  confirm_phrase: z.literal("DELETE ALL"),
}).strict();

const resolveUserId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const header = req.headers["x-sol-user-id"] ?? req.headers["x-user-id"];
  if (Array.isArray(header)) {
    return header[0] ?? "anonymous";
  }
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  return "anonymous";
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

const hashContextWindow = (contextWindow: ContextMessage[]) =>
  createHash("sha256")
    .update(JSON.stringify(contextWindow))
    .digest("hex");

const buildGhostCardEnvelope = (text: string): OutputEnvelope =>
  buildOutputEnvelopeMeta({
    envelope: {
      assistant_text: text,
      meta: {
        display_hint: "ghost_card",
        ghost_kind: "memory_artifact",
      },
    },
    personaLabel: "system",
    notificationPolicy: "muted",
  });

export async function memoryRoutes(
  app: FastifyInstance,
  opts: { store?: ControlPlaneStore } = {}
) {
  const store = opts.store ?? new MemoryControlPlaneStore();

  app.addHook("preHandler", async (req, reply) => {
    const apiKey = process.env.SOLSERVER_API_KEY;
    if (!apiKey) return;
    if (req.method === "OPTIONS") return;

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : undefined;
    if (!token || token !== apiKey) {
      reply.header("WWW-Authenticate", "Bearer");
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.options("/memories", async (_req, reply) => reply.code(204).send());
  app.options("/memories/distill", async (_req, reply) => reply.code(204).send());
  app.options("/memories/batch_delete", async (_req, reply) => reply.code(204).send());
  app.options("/memories/clear_all", async (_req, reply) => reply.code(204).send());
  app.options("/memories/:memory_id", async (_req, reply) => reply.code(204).send());

  app.post("/memories/distill", async (req, reply) => {
    const parsed = DistillRequestSchema.safeParse(req.body);
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
    const userId = resolveUserId(req as any);
    const contextWindow: ContextMessage[] = data.context_window.map((message) => ({
      messageId: message.message_id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at,
    }));
    const contextHash = hashContextWindow(contextWindow);

    const existing = await store.getMemoryDistillRequestByRequestId({
      userId,
      requestId: data.request_id,
    });

    if (existing) {
      if (
        existing.threadId !== data.thread_id
        || existing.triggerMessageId !== data.trigger_message_id
        || existing.contextHash !== contextHash
      ) {
        return reply.code(409).send({
          error: "idempotency_conflict",
          request_id: data.request_id,
          transmission_id: existing.transmissionId,
        });
      }

      const nextReaffirm = existing.reaffirmCount + 1;
      await store.updateMemoryDistillRequestReaffirm({
        userId,
        requestId: data.request_id,
        reaffirmCount: nextReaffirm,
        lastReaffirmedAt: new Date().toISOString(),
      });

      reply.header("x-sol-transmission-id", existing.transmissionId);
      return reply.code(202).send({
        request_id: data.request_id,
        transmission_id: existing.transmissionId,
        status: "pending",
      });
    }

    const transmissionId = randomUUID();
    await store.createMemoryTransmission({
      transmissionId,
      threadId: data.thread_id,
      notificationPolicy: "muted",
    });
    await store.createMemoryDistillRequest({
      userId,
      requestId: data.request_id,
      transmissionId,
      threadId: data.thread_id,
      triggerMessageId: data.trigger_message_id,
      contextHash,
      reaffirmCount: data.reaffirm_count ?? 0,
    });

    reply.header("x-sol-transmission-id", transmissionId);
    reply.code(202).send({
      request_id: data.request_id,
      transmission_id: transmissionId,
      status: "pending",
    });

    const distillJob = async () => {
      try {
        const distill = distillContextWindow(contextWindow);
        const fact = distill.fact;
        const outputText = fact ?? FALLBACK_PROMPT;
        const envelope = buildGhostCardEnvelope(outputText);

        await store.setTransmissionOutputEnvelope({
          transmissionId,
          outputEnvelope: envelope,
        });

        if (fact) {
          const artifact = await store.createMemoryArtifact({
            userId,
            transmissionId,
            threadId: data.thread_id,
            triggerMessageId: data.trigger_message_id,
            type: "memory",
            snippet: fact,
            moodAnchor: null,
            rigorLevel: inferRigorLevel(fact),
            tags: [],
            fidelity: "direct",
            transitionToHazyAt: null,
          });

          await store.completeMemoryDistillRequest({
            userId,
            requestId: data.request_id,
            status: "completed",
            outputEnvelopeJson: JSON.stringify(envelope),
            memoryId: artifact.id,
          });
        } else {
          await store.completeMemoryDistillRequest({
            userId,
            requestId: data.request_id,
            status: "completed",
            outputEnvelopeJson: JSON.stringify(envelope),
            memoryId: null,
          });
        }

        await store.updateTransmissionStatus({
          transmissionId,
          status: "completed",
        });
      } catch (error) {
        req.log.error(
          { evt: "memory.distill.failed", transmissionId, error: String(error) },
          "memory.distill.failed"
        );
        await store.updateTransmissionStatus({
          transmissionId,
          status: "failed",
          statusCode: 500,
          retryable: false,
          errorCode: "distill_failed",
        });
        await store.completeMemoryDistillRequest({
          userId,
          requestId: data.request_id,
          status: "failed",
        });
      }
    };

    setImmediate(distillJob);
  });

  app.post("/memories", async (req, reply) => {
    const parsed = MemoryCreateRequestSchema.safeParse(req.body);
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
    const userId = resolveUserId(req as any);

    const existing = await store.getMemoryArtifactByRequestId({
      userId,
      requestId: data.request_id,
    });

    if (existing) {
      const requestedTags = (data.memory.tags ?? []).slice().sort();
      const existingTags = [...existing.tags].sort();
      const tagsMatch =
        requestedTags.length === existingTags.length
        && requestedTags.every((tag, index) => tag === existingTags[index]);

      const requestedRigor = data.memory.rigor_level ?? "normal";
      const requestedMoodAnchor = data.memory.mood_anchor ?? null;
      const requestedImportance = data.memory.importance ?? null;

      const matches =
        existing.domain === data.memory.domain
        && (existing.title ?? null) === (data.memory.title ?? null)
        && existing.snippet === data.memory.content
        && (existing.moodAnchor ?? null) === requestedMoodAnchor
        && (existing.importance ?? null) === requestedImportance
        && existing.rigorLevel === requestedRigor
        && tagsMatch;

      if (!matches) {
        return reply.code(409).send({
          error: "idempotency_conflict",
          request_id: data.request_id,
          memory_id: existing.id,
        });
      }

      return reply.code(200).send({
        request_id: data.request_id,
        memory: {
          memory_id: existing.id,
          created_at: existing.createdAt,
          updated_at: existing.updatedAt,
          domain: existing.domain ?? null,
          title: existing.title ?? null,
          summary: null,
          tags: existing.tags,
          rigor_level: existing.rigorLevel,
        },
      });
    }

    const artifact = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: data.source?.thread_id ?? null,
      triggerMessageId: data.source?.message_id ?? null,
      type: "memory",
      domain: data.memory.domain,
      title: data.memory.title ?? null,
      snippet: data.memory.content,
      moodAnchor: data.memory.mood_anchor ?? null,
      rigorLevel: data.memory.rigor_level ?? "normal",
      tags: data.memory.tags ?? [],
      importance: data.memory.importance ?? null,
      fidelity: "direct",
      transitionToHazyAt: null,
      requestId: data.request_id,
    });

    return reply.code(200).send({
      request_id: data.request_id,
      memory: {
        memory_id: artifact.id,
        created_at: artifact.createdAt,
        updated_at: artifact.updatedAt,
        domain: artifact.domain ?? null,
        title: artifact.title ?? null,
        summary: null,
        tags: artifact.tags,
        rigor_level: artifact.rigorLevel,
      },
    });
  });

  app.get("/memories", async (req, reply) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const domain = typeof query.domain === "string" ? query.domain : null;
    const tagsAnyRaw = query.tags_any;
    const tagsAny = Array.isArray(tagsAnyRaw)
      ? tagsAnyRaw.flatMap((entry) => entry.split(",")).map((tag) => tag.trim()).filter(Boolean)
      : typeof tagsAnyRaw === "string"
        ? tagsAnyRaw.split(",").map((tag) => tag.trim()).filter(Boolean)
        : [];
    const limit = typeof query.limit === "string" ? Number(query.limit) : undefined;
    const cursor = typeof query.cursor === "string" ? query.cursor : null;

    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "limit must be a positive number",
      });
    }

    const userId = resolveUserId(req as any);
    const result = await store.listMemoryArtifacts({
      userId,
      domain,
      tagsAny: tagsAny.length > 0 ? tagsAny : null,
      before: cursor,
      limit,
    });

    return reply.code(200).send({
      request_id: randomUUID(),
      items: result.items.map((artifact) => ({
        memory_id: artifact.id,
        type: artifact.type,
        snippet: artifact.snippet,
        domain: artifact.domain ?? null,
        title: artifact.title ?? null,
        tags: artifact.tags,
        mood_anchor: artifact.moodAnchor ?? null,
        rigor_level: artifact.rigorLevel,
        fidelity: artifact.fidelity ?? null,
        transition_to_hazy_at: artifact.transitionToHazyAt ?? null,
        created_at: artifact.createdAt,
        updated_at: artifact.updatedAt,
      })),
      next_cursor: result.nextCursor,
    });
  });

  app.patch("/memories/:memory_id", async (req, reply) => {
    const parsed = MemoryPatchRequestSchema.safeParse(req.body);
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
    const memoryId = (req.params as any).memory_id as string;
    const userId = resolveUserId(req as any);

    if (
      data.patch.snippet === undefined
      && data.patch.tags === undefined
      && data.patch.mood_anchor === undefined
    ) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "patch must include at least one field",
      });
    }

    const updated = await store.updateMemoryArtifact({
      userId,
      memoryId,
      snippet: data.patch.snippet,
      tags: data.patch.tags,
      moodAnchor: data.patch.mood_anchor,
    });

    if (!updated) {
      return reply.code(404).send({ error: "not_found" });
    }

    return reply.code(200).send({
      request_id: data.request_id,
      memory: {
        memory_id: updated.id,
        updated_at: updated.updatedAt,
      },
    });
  });

  app.delete("/memories/:memory_id", async (req, reply) => {
    const memoryId = (req.params as any).memory_id as string;
    const userId = resolveUserId(req as any);
    const confirm = String((req.query as any)?.confirm ?? "").toLowerCase() === "true";

    const existing = await store.getMemoryArtifact({ userId, memoryId });
    if (!existing) {
      return reply.code(204).send();
    }

    if (existing.rigorLevel === "high" && !confirm) {
      return reply.code(409).send({
        error: "confirm_required",
        message: "confirm=true required for high-rigor memory deletion",
      });
    }

    await store.deleteMemoryArtifact({ userId, memoryId });
    return reply.code(204).send();
  });

  app.post("/memories/batch_delete", async (req, reply) => {
    const parsed = BatchDeleteRequestSchema.safeParse(req.body);
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
    const userId = resolveUserId(req as any);
    const deletedCount = await store.batchDeleteMemoryArtifacts({
      userId,
      filter: {
        threadId: data.filter.thread_id ?? null,
        domain: data.filter.domain ?? null,
        tagsAny: data.filter.tags_any ?? null,
        createdBefore: data.filter.created_before ?? null,
      },
    });

    if (data.filter.thread_id) {
      await store.recordMemoryAudit({
        userId,
        action: "batch_delete",
        requestId: data.request_id,
        threadId: data.filter.thread_id,
        filter: data.filter,
        deletedCount,
      });
    }

    return reply.code(200).send({
      request_id: data.request_id,
      deleted_count: deletedCount,
    });
  });

  app.post("/memories/clear_all", async (req, reply) => {
    const parsed = ClearAllRequestSchema.safeParse(req.body);
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
    const userId = resolveUserId(req as any);
    const deletedCount = await store.clearMemoryArtifacts({ userId });

    await store.recordMemoryAudit({
      userId,
      action: "clear_all",
      requestId: data.request_id,
      deletedCount,
    });

    return reply.code(200).send({
      request_id: data.request_id,
      deleted_count: deletedCount,
    });
  });
}
