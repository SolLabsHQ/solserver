import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import { applyLibrarianGate } from "../src/gates/librarian_gate";
import type { OutputEnvelope } from "../src/contracts/output_envelope";

const COMPLIANT_ASSISTANT =
  "shape\nReceipt: ok\nRelease: ok\nNext: ok\nAssumption: ok";

describe("librarian_gate", () => {
  it("skips envelopes that are not ghost_card", () => {
    const envelope: OutputEnvelope = { assistant_text: "ok" };
    const result = applyLibrarianGate({ envelope, evidencePack: null });
    expect(result).toBeNull();
  });

  describe("integration", () => {
    let app: any;
    let store: MemoryControlPlaneStore;

    beforeAll(async () => {
      store = new MemoryControlPlaneStore();
      app = Fastify({ logger: false });
      app.register(cors, { origin: true });
      app.register(chatRoutes, { prefix: "/v1", store });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("prunes invalid refs, preserves assistant_text, and emits trace", async () => {
      const envelope = {
        assistant_text: COMPLIANT_ASSISTANT,
        meta: {
          display_hint: "ghost_card",
          ghost_kind: "memory_artifact",
          memory_id: "mem-001",
          rigor_level: "normal",
          snippet: "Summary snippet",
          fact_null: false,
          claims: [
            {
              claim_id: "claim-001",
              claim_text: "Claim with one valid and one invalid ref.",
              evidence_refs: [
                { evidence_id: "ev-001", span_id: "sp-001" },
                { evidence_id: "ev-999" },
              ],
            },
            {
              claim_id: "claim-002",
              claim_text: "Claim with duplicate ref.",
              evidence_refs: [
                { evidence_id: "ev-002" },
                { evidence_id: "ev-002" },
              ],
            },
            {
              claim_id: "claim-003",
              claim_text: "Claim with only invalid refs.",
              evidence_refs: [{ evidence_id: "ev-404" }],
            },
          ],
        },
      };

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: {
          "x-sol-test-output-envelope": JSON.stringify(envelope),
        },
        payload: {
          packetType: "chat",
          threadId: "thread-librarian-001",
          message: "Test message",
          evidence: {
            captures: [
              {
                captureId: "cap-001",
                kind: "url",
                url: "https://example.com",
                capturedAt: new Date().toISOString(),
                source: "user_provided",
              },
            ],
          },
          traceConfig: { level: "debug" },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.outputEnvelope.assistant_text).toBe(COMPLIANT_ASSISTANT);
      expect(body.outputEnvelope.meta.librarian_gate).toMatchObject({
        version: "v0",
        pruned_refs: 3,
        unsupported_claims: 1,
        verdict: "flag",
      });

      const claims = body.outputEnvelope.meta.claims ?? [];
      expect(claims.length).toBe(2);
      const refs = claims.flatMap((claim: any) => claim.evidence_refs);
      expect(refs.some((ref: any) => ref.evidence_id === "ev-999")).toBe(false);
      expect(refs.some((ref: any) => ref.evidence_id === "ev-404")).toBe(false);

      const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 200 });
      const librarianEvent = traceEvents.find((event) =>
        event.metadata?.kind === "librarian_gate"
      );
      expect(librarianEvent).toBeDefined();
      expect(librarianEvent!.metadata).toMatchObject({
        claimCount: 3,
        prunedRefs: 3,
        unsupportedClaims: 1,
        verdict: "flag",
      });
    });
  });
});
