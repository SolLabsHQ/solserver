import { buildOutputEnvelopeMeta } from "../control-plane/orchestrator";
import type { OutputEnvelope } from "../contracts/output_envelope";
import type { MemoryArtifact } from "../store/control_plane_store";

export type GhostEnvelopePayload = {
  text: string;
  memoryId: string | null;
  triggerMessageId?: string;
  rigorLevel: MemoryArtifact["rigorLevel"] | null;
  snippet: string | null;
  factNull: boolean;
  ghostKind?: "memory_artifact" | "journal_moment" | "action_proposal";
  traceRunId?: string | null;
};

export function buildGhostCardEnvelope(payload: GhostEnvelopePayload): OutputEnvelope {
  return buildOutputEnvelopeMeta({
    envelope: {
      assistant_text: payload.text,
      notification_policy: "muted",
      meta: {
        display_hint: "ghost_card",
        ghost_kind: payload.ghostKind ?? "memory_artifact",
        memory_id: payload.memoryId,
        ...(payload.triggerMessageId ? { trigger_message_id: payload.triggerMessageId } : {}),
        rigor_level: payload.rigorLevel,
        snippet: payload.snippet,
        fact_null: payload.factNull,
        ...(payload.traceRunId ? { trace_run_id: payload.traceRunId } : {}),
      },
    },
    personaLabel: "system",
    notificationPolicy: "muted",
  });
}
