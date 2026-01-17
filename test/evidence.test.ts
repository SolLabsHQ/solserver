import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import {
  runEvidenceBudgetGate,
  EVIDENCE_BUDGET_LIMITS,
} from "../src/gates/evidence_output_gates";
import type { EvidencePack } from "../src/evidence/evidence_provider";
import type { OutputEnvelope } from "../src/contracts/output_envelope";

const OUTPUT_CONTRACT_STUB =
  "I can't do that directly from here. Tell me what you're trying to accomplish and I'll give you a safe draft or step-by-step instructions.";
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
    expect(body.outputEnvelope?.meta?.used_evidence_ids).toEqual(["ev-001"]);
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
});
