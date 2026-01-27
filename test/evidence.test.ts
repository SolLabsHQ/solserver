import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import {
  runEvidenceBudgetGate,
  EVIDENCE_BUDGET_LIMITS,
} from "../src/gates/evidence_output_gates";
import { validateEvidencePack, type EvidencePack } from "../src/evidence/evidence_provider";
import type { OutputEnvelope } from "../src/contracts/output_envelope";

const OUTPUT_CONTRACT_STUB = [
  "Missing info: I couldn't validate the evidence references for this response.",
  "Provisional: I can retry with a stricter output format if you'd like.",
  "Question: Want me to retry, or can you rephrase your request?",
].join("\n");
const COMPLIANT_ASSISTANT =
  "shape\nReceipt: ok\nRelease: ok\nNext: ok\nAssumption: ok";

describe("Evidence output gates (v0)", () => {
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

  it("accepts valid claims and derives used_evidence_ids + evidence_pack_id", async () => {
    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: {
        claims: [
          {
            claim_id: "claim-001",
            claim_text: "Claim grounded in evidence.",
            evidence_refs: [{ evidence_id: "ev-001", span_id: "sp-001" }],
          },
          {
            claim_id: "claim-002",
            claim_text: "Second claim grounded in evidence.",
            evidence_refs: [
              { evidence_id: "ev-001" },
              { evidence_id: "ev-002", span_id: "sp-002" },
            ],
          },
        ],
        used_evidence_ids: ["ev-999"],
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
        threadId: "thread-evidence-001",
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
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope?.meta?.evidence_pack_id).toBe("pack-001");
    expect(body.outputEnvelope?.meta?.used_evidence_ids).toEqual(["ev-001", "ev-002"]);
    expect(body.outputEnvelope?.meta?.meta_version).toBe("v1");
    expect(body.evidenceSummary?.claims).toBe(body.outputEnvelope?.meta?.claims?.length ?? 0);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 200 });
    const providerEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_provider");
    const bindingEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_binding");
    const budgetEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_budget");

    expect(providerEvent).toBeDefined();
    expect(providerEvent!.metadata).toMatchObject({
      allowed: true,
      allowed_reason: "intent_detected",
      forced: false,
    });
    expect(bindingEvent).toBeDefined();
    expect(bindingEvent!.metadata).toMatchObject({ ok: true, attempt: 0 });
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.metadata).toMatchObject({ ok: true, attempt: 0 });
  });

  it("fails closed when claims reference unknown evidence_id", async () => {
    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: {
        claims: [
          {
            claim_id: "claim-001",
            claim_text: "Claim with invalid reference.",
            evidence_refs: [{ evidence_id: "ev-999" }],
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
        threadId: "thread-evidence-002",
        message: "Test message",
        evidence: {
          captures: [
            {
              captureId: "cap-002",
              kind: "url",
              url: "https://example.com",
              capturedAt: new Date().toISOString(),
              source: "user_provided",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("evidence_binding_failed");
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(body.traceRunId).toBeDefined();

    const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
    const bindingEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_binding");
    expect(bindingEvent).toBeDefined();
    expect(bindingEvent!.metadata).toMatchObject({ ok: false, reason: "invalid_binding" });
  });

  it("fails closed when claims reference unknown span_id", async () => {
    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: {
        claims: [
          {
            claim_id: "claim-001",
            claim_text: "Claim with invalid span reference.",
            evidence_refs: [{ evidence_id: "ev-001", span_id: "sp-missing" }],
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
        threadId: "thread-evidence-span-001",
        message: "Test message",
        evidence: {
          captures: [
            {
              captureId: "cap-span-001",
              kind: "url",
              url: "https://example.com",
              capturedAt: new Date().toISOString(),
              source: "user_provided",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("evidence_binding_failed");
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(body.traceRunId).toBeDefined();

    const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
    const bindingEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_binding");
    expect(bindingEvent).toBeDefined();
    expect(bindingEvent!.metadata).toMatchObject({ ok: false, reason: "invalid_binding" });
  });

  it("fails closed when claims exist without evidence pack", async () => {
    const previous = process.env.EVIDENCE_PROVIDER;
    process.env.EVIDENCE_PROVIDER = "none";

    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: {
        claims: [
          {
            claim_id: "claim-001",
            claim_text: "Claim without evidence pack.",
            evidence_refs: [{ evidence_id: "ev-001" }],
          },
        ],
      },
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: {
          "x-sol-test-output-envelope": JSON.stringify(envelope),
        },
        payload: {
          packetType: "chat",
          threadId: "thread-evidence-003",
          message: "Test message",
        },
      });

      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.error).toBe("claims_without_evidence");
      expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
      expect(body.outputEnvelope).toBeUndefined();
      expect(body.traceRunId).toBeDefined();

      const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
      const bindingEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_binding");
      expect(bindingEvent).toBeDefined();
      expect(bindingEvent!.metadata).toMatchObject({ ok: false, reason: "claims_without_evidence" });
    } finally {
      process.env.EVIDENCE_PROVIDER = previous;
    }
  });

  it("fails closed when evidence budgets are exceeded", async () => {
    const claims = Array.from({ length: EVIDENCE_BUDGET_LIMITS.maxClaims + 1 }, (_, i) => ({
      claim_id: `claim-${i + 1}`,
      claim_text: "Budget test claim",
      evidence_refs: [{ evidence_id: "ev-001" }],
    }));

    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: { claims },
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify(envelope),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-evidence-004",
        message: "Test message",
        evidence: {
          captures: [
            {
              captureId: "cap-004",
              kind: "url",
              url: "https://example.com",
              capturedAt: new Date().toISOString(),
              source: "user_provided",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("evidence_budget_exceeded");
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(body.traceRunId).toBeDefined();

    const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
    const budgetEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_budget");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.metadata).toMatchObject({ ok: false, reason: "max_claims" });
  });

  it("fails closed when max refs per claim is exceeded", async () => {
    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: {
        claims: [
          {
            claim_id: "claim-refs",
            claim_text: "Too many refs in one claim.",
            evidence_refs: Array.from({ length: 5 }, () => ({ evidence_id: "ev-001" })),
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
        threadId: "thread-evidence-budget-refs",
        message: "Test message",
        traceConfig: { forceEvidence: true },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("evidence_budget_exceeded");
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(body.traceRunId).toBeDefined();

    const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
    const budgetEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_budget");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.metadata).toMatchObject({ ok: false, reason: "max_refs_per_claim" });
  });

  it("fails closed when total evidence refs exceed budget", async () => {
    const claims = Array.from({ length: 6 }, (_, i) => ({
      claim_id: `claim-${i + 1}`,
      claim_text: "Budget total refs test claim",
      evidence_refs: [
        { evidence_id: "ev-001" },
        { evidence_id: "ev-001" },
        { evidence_id: "ev-002" },
        { evidence_id: "ev-002" },
      ],
    }));

    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: { claims },
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify(envelope),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-evidence-budget-total-refs",
        message: "Test message",
        evidence: {
          captures: [
            {
              captureId: "cap-005",
              kind: "url",
              url: "https://example.com",
              capturedAt: new Date().toISOString(),
              source: "user_provided",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("evidence_budget_exceeded");
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(body.traceRunId).toBeDefined();

    const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
    const budgetEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_budget");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.metadata).toMatchObject({ ok: false, reason: "max_total_refs" });
  });

  it("fails closed when meta bytes exceed budget", async () => {
    const longText = "a".repeat(17 * 1024);
    const envelope = {
      assistant_text: COMPLIANT_ASSISTANT,
      meta: {
        claims: [
          {
            claim_id: "claim-oversize",
            claim_text: longText,
            evidence_refs: [{ evidence_id: "ev-001" }],
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
        threadId: "thread-evidence-budget-meta",
        message: "Test message",
        evidence: {
          captures: [
            {
              captureId: "cap-006",
              kind: "url",
              url: "https://example.com",
              capturedAt: new Date().toISOString(),
              source: "user_provided",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("evidence_budget_exceeded");
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(body.traceRunId).toBeDefined();

    const traceEvents = await store.getTraceEvents(body.traceRunId, { limit: 200 });
    const budgetEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_budget");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.metadata).toMatchObject({ ok: false, reason: "max_meta_bytes" });
  });
});

describe("Evidence budget UTF-8 bytes", () => {
  it("counts multi-byte chars toward evidence byte budget", () => {
    const emojiText = "😀".repeat(2000); // 4 bytes each => ~8000 bytes
    const pack: EvidencePack = {
      packId: "pack-utf8",
      items: [
        {
          evidenceId: "ev-utf8",
          kind: "doc_excerpt",
          excerptText: emojiText,
        },
      ],
    };

    const envelope: OutputEnvelope = {
      assistant_text: "ok",
      meta: {
        claims: [
          {
            claim_id: "claim-utf8",
            claim_text: "Uses multi-byte refs.",
            evidence_refs: [{ evidence_id: "ev-utf8" }],
          },
        ],
      },
    };

    const result = runEvidenceBudgetGate(envelope, envelope.meta?.claims ?? [], pack);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_evidence_bytes");
  });

  it("flags max refs per claim", () => {
    const pack: EvidencePack = {
      packId: "pack-refs",
      items: [{ evidenceId: "ev-001", kind: "web_snippet" }],
    };

    const envelope: OutputEnvelope = {
      assistant_text: "ok",
      meta: {
        claims: [
          {
            claim_id: "claim-refs",
            claim_text: "Too many refs in one claim",
            evidence_refs: Array.from({ length: 5 }, () => ({ evidence_id: "ev-001" })),
          },
        ],
      },
    };

    const result = runEvidenceBudgetGate(envelope, envelope.meta?.claims ?? [], pack);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_refs_per_claim");
  });
});

describe("Evidence provider validation", () => {
  it("rejects duplicate evidenceId entries", () => {
    const pack: EvidencePack = {
      packId: "pack-dup",
      items: [
        { evidenceId: "ev-dup", kind: "web_snippet" },
        { evidenceId: "ev-dup", kind: "doc_excerpt" },
      ],
    };

    expect(() => validateEvidencePack(pack)).toThrow("EvidenceItem.evidenceId must be unique");
  });

  it("rejects duplicate spanId entries per item", () => {
    const pack: EvidencePack = {
      packId: "pack-span-dup",
      items: [
        {
          evidenceId: "ev-001",
          kind: "web_snippet",
          spans: [
            { spanId: "sp-dup", text: "first" },
            { spanId: "sp-dup", text: "second" },
          ],
        },
      ],
    };

    expect(() => validateEvidencePack(pack)).toThrow("EvidenceSpan.spanId must be unique per item");
  });
});
