import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { JournalOfferEventSchema, DeviceMuseObservationSchema } from "../contracts/trace_events";
import type { ControlPlaneStore } from "../store/control_plane_store";

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

const normalizeTraceRequest = (body: any) => {
  if (!body || typeof body !== "object") return body;
  const normalized: Record<string, any> = { ...body };
  if (normalized.requestId === undefined && normalized.request_id !== undefined) {
    normalized.requestId = normalized.request_id;
    delete normalized.request_id;
  }
  if (normalized.localUserUuid === undefined && normalized.local_user_uuid !== undefined) {
    normalized.localUserUuid = normalized.local_user_uuid;
    delete normalized.local_user_uuid;
  }
  if (Array.isArray(normalized.events)) {
    normalized.events = normalized.events.map((event: any) => normalizeEvent(event));
  }
  return normalized;
};

const normalizeEvent = (event: any) => {
  if (!event || typeof event !== "object") return event;
  const normalized: Record<string, any> = { ...event };
  if (normalized.eventId === undefined && normalized.event_id !== undefined) {
    normalized.eventId = normalized.event_id;
    delete normalized.event_id;
  }
  if (normalized.eventType === undefined && normalized.event_type !== undefined) {
    normalized.eventType = normalized.event_type;
    delete normalized.event_type;
  }
  if (normalized.threadId === undefined && normalized.thread_id !== undefined) {
    normalized.threadId = normalized.thread_id;
    delete normalized.thread_id;
  }
  if (normalized.momentId === undefined && normalized.moment_id !== undefined) {
    normalized.momentId = normalized.moment_id;
    delete normalized.moment_id;
  }
  if (normalized.evidenceSpan === undefined && normalized.evidence_span !== undefined) {
    normalized.evidenceSpan = normalized.evidence_span;
    delete normalized.evidence_span;
  }
  if (normalized.phaseAtOffer === undefined && normalized.phase_at_offer !== undefined) {
    normalized.phaseAtOffer = normalized.phase_at_offer;
    delete normalized.phase_at_offer;
  }
  if (normalized.modeSelected === undefined && normalized.mode_selected !== undefined) {
    normalized.modeSelected = normalized.mode_selected;
    delete normalized.mode_selected;
  }
  if (normalized.userAction === undefined && normalized.user_action !== undefined) {
    normalized.userAction = normalized.user_action;
    delete normalized.user_action;
  }
  if (normalized.cooldownActive === undefined && normalized.cooldown_active !== undefined) {
    normalized.cooldownActive = normalized.cooldown_active;
    delete normalized.cooldown_active;
  }
  if (normalized.latencyMs === undefined && normalized.latency_ms !== undefined) {
    normalized.latencyMs = normalized.latency_ms;
    delete normalized.latency_ms;
  }
  if (normalized.refs && typeof normalized.refs === "object") {
    const refs = { ...normalized.refs };
    if (refs.cpbId === undefined && refs.cpb_id !== undefined) {
      refs.cpbId = refs.cpb_id;
      delete refs.cpb_id;
    }
    if (refs.draftId === undefined && refs.draft_id !== undefined) {
      refs.draftId = refs.draft_id;
      delete refs.draft_id;
    }
    if (refs.entryId === undefined && refs.entry_id !== undefined) {
      refs.entryId = refs.entry_id;
      delete refs.entry_id;
    }
    if (refs.requestId === undefined && refs.request_id !== undefined) {
      refs.requestId = refs.request_id;
      delete refs.request_id;
    }
    normalized.refs = refs;
  }
  if (normalized.tuning && typeof normalized.tuning === "object") {
    const tuning = { ...normalized.tuning };
    if (tuning.newCooldownMinutes === undefined && tuning.new_cooldown_minutes !== undefined) {
      tuning.newCooldownMinutes = tuning.new_cooldown_minutes;
      delete tuning.new_cooldown_minutes;
    }
    if (tuning.avoidPeakOverwhelm === undefined && tuning.avoid_peak_overwhelm !== undefined) {
      tuning.avoidPeakOverwhelm = tuning.avoid_peak_overwhelm;
      delete tuning.avoid_peak_overwhelm;
    }
    if (tuning.offersEnabled === undefined && tuning.offers_enabled !== undefined) {
      tuning.offersEnabled = tuning.offers_enabled;
      delete tuning.offers_enabled;
    }
    normalized.tuning = tuning;
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
  if (normalized.observationId === undefined && normalized.observation_id !== undefined) {
    normalized.observationId = normalized.observation_id;
    delete normalized.observation_id;
  }
  if (normalized.localUserUuid === undefined && normalized.local_user_uuid !== undefined) {
    normalized.localUserUuid = normalized.local_user_uuid;
    delete normalized.local_user_uuid;
  }
  if (normalized.messageId === undefined && normalized.message_id !== undefined) {
    normalized.messageId = normalized.message_id;
    delete normalized.message_id;
  }
  if (normalized.detectedType === undefined && normalized.detected_type !== undefined) {
    normalized.detectedType = normalized.detected_type;
    delete normalized.detected_type;
  }
  if (normalized.phaseHint === undefined && normalized.phase_hint !== undefined) {
    normalized.phaseHint = normalized.phase_hint;
    delete normalized.phase_hint;
  }
  return normalized;
};

const hasForbiddenDeviceFields = (event: Record<string, any>): boolean => {
  const forbidden = new Set([
    "text",
    "content",
    "rawText",
    "raw_text",
    "messageText",
    "message_text",
    "inputText",
    "input_text",
    "outputText",
    "output_text",
    "context",
    "contextWindow",
    "context_window",
    "evidenceSpan",
    "evidence_span",
    "evidenceSpans",
    "evidence_spans",
    "summary",
    "title",
    "body",
    "entities",
  ]);
  return Object.keys(event).some((key) => forbidden.has(key));
};

const TraceEventsEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  localUserUuid: z.string().min(1),
  events: z.array(z.any()).min(1),
}).strict();

export async function traceRoutes(
  app: FastifyInstance,
  opts: { store: ControlPlaneStore }
) {
  const { store } = opts;

  app.options("/trace/events", async (_req, reply) => reply.code(204).send());

  app.post("/trace/events", async (req, reply) => {
    const normalized = normalizeTraceRequest(req.body);
    const parsed = TraceEventsEnvelopeSchema.safeParse(normalized);
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
    const accepted: Array<{
      eventType: "journal_offer_event" | "device_muse_observation";
      threadId: string;
      messageId?: string | null;
      ts: string;
      payload: Record<string, any>;
    }> = [];
    let rejectedCount = 0;

    for (const rawEvent of data.events) {
      const journalParsed = JournalOfferEventSchema.safeParse(rawEvent);
      if (journalParsed.success) {
        accepted.push({
          eventType: "journal_offer_event",
          threadId: journalParsed.data.threadId,
          messageId: null,
          ts: journalParsed.data.ts,
          payload: journalParsed.data,
        });
        continue;
      }

      if (hasForbiddenDeviceFields(rawEvent)) {
        rejectedCount += 1;
        continue;
      }

      const deviceParsed = DeviceMuseObservationSchema.safeParse(rawEvent);
      if (deviceParsed.success) {
        accepted.push({
          eventType: "device_muse_observation",
          threadId: deviceParsed.data.threadId,
          messageId: deviceParsed.data.messageId,
          ts: deviceParsed.data.ts,
          payload: deviceParsed.data,
        });
        continue;
      }

      rejectedCount += 1;
    }

    if (accepted.length > 0) {
      await store.appendTraceIngestEvents({
        requestId: data.requestId,
        localUserUuid: data.localUserUuid,
        events: accepted,
      });
    }

    return reply.code(200).send({
      requestId: data.requestId,
      acceptedCount: accepted.length,
      rejectedCount,
    });
  });
}
