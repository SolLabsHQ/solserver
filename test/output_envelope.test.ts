import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

const OUTPUT_CONTRACT_STUB = [
  "Missing info: I couldn't validate the model response against the output contract.",
  "Provisional: I can retry with a stricter output format if you'd like.",
  "Question: Want me to retry, or can you rephrase your request?",
].join("\n");
const SHAPE_ASSISTANT_TEXT = [
  "shape:",
  "- Arc: ok",
  "- Active: ok",
  "- Parked: ok",
  "- Decisions: ok",
  "- Next: ok",
  "",
  "Receipt: ok",
  "Release: ok",
  "Next: ok",
  "Assumption: ok",
].join("\n");

describe("OutputEnvelope v0-min", () => {
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

  it("returns outputEnvelope on success and matches assistant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-001",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope).toBeDefined();
    expect(body.outputEnvelope.assistant_text).toBe(body.assistant);
    expect(body.outputEnvelope.meta?.lattice).toBeDefined();
    expect(body.outputEnvelope.meta?.lattice?.status).toBeDefined();
    expect(response.headers["x-sol-transmission-id"]).toBeTruthy();
    expect(response.headers["x-sol-trace-run-id"]).toBeTruthy();
  });

  it("omits outputEnvelope on output_contract_failed 422", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": "{not-json",
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-002",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("output_contract_failed");
    expect(body.retryable).toBe(false);
    expect(body.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(body.outputEnvelope).toBeUndefined();
    expect(response.headers["x-sol-transmission-id"]).toBeTruthy();
    expect(response.headers["x-sol-trace-run-id"]).toBeTruthy();
  });

  it("logs schema issues when full schema fails but v0-min passes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: "shape\nReceipt: ok\nRelease: ok\nNext: ok\nAssumption: ok",
          meta: { claims: [] },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-004",
        message: "Test message",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope).toBeDefined();

    const traceRunId = response.headers["x-sol-trace-run-id"] as string;
    expect(traceRunId).toBeTruthy();
    const events = await store.getTraceEvents(traceRunId, { limit: 50 });
    const warning = events.find((event) =>
      event.metadata?.kind === "output_envelope_schema_warning"
    );
    expect(warning).toBeTruthy();
  });

  it("fails when ghost_card output is missing required fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: "Ghost draft",
          meta: { display_hint: "ghost_card" },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-ghost-001",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("output_contract_failed");
    expect(body.outputEnvelope).toBeUndefined();
  });

  it("accepts ghostType/metaVersion and normalizes ghost metadata", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: "Ghost memory draft",
          meta: {
            display_hint: "ghost_card",
            ghostType: "memory",
            metaVersion: "v1",
            memory_id: "mem-1",
            rigor_level: "normal",
            snippet: "Some memory snippet",
            fact_null: false,
          },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-ghost-002",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope).toBeDefined();
    expect(body.outputEnvelope.meta.meta_version).toBe("v1");
  });

  it("drops unknown meta keys from the response payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: SHAPE_ASSISTANT_TEXT,
          meta: {
            meta_version: "v1",
            librarian_gate: {
              version: "v0",
              pruned_refs: 0,
              unsupported_claims: 0,
              support_score: 1,
              verdict: "pass",
            },
            unexpected_key: "nope",
          },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-005",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope.meta.meta_version).toBe("v1");
    expect(body.outputEnvelope.meta.librarian_gate).toBeDefined();
    expect(body.outputEnvelope.meta.unexpected_key).toBeUndefined();
  });

  it("adds meta_version when journalOffer is present", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: SHAPE_ASSISTANT_TEXT,
          meta: {
            journalOffer: {
              momentId: "moment-1",
              momentType: "insight",
              phase: "settled",
              confidence: "med",
              evidenceSpan: {
                startMessageId: "msg-1",
                endMessageId: "msg-1",
              },
              offerEligible: true,
            },
          },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-006",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope.meta.meta_version).toBe("v1");
    expect(body.outputEnvelope.meta.journalOffer).toBeTruthy();
  });

  it("emits a debug trace when meta keys are stripped", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: SHAPE_ASSISTANT_TEXT,
          meta: { meta_version: "v1", unexpected_key: "nope" },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-005-trace",
        message: "Test message",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const traceRunId = response.headers["x-sol-trace-run-id"] as string;
    expect(traceRunId).toBeTruthy();

    const events = await store.getTraceEvents(traceRunId, { limit: 50 });
    const stripEvent = events.find((event) =>
      event.metadata?.kind === "output_envelope_meta_strip"
    );
    expect(stripEvent).toBeTruthy();
    expect(stripEvent?.metadata?.strippedKeys).toContain("unexpected_key");
  });

  it("fills capture_suggestion suggestion_id and returns it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: SHAPE_ASSISTANT_TEXT,
          meta: {
            capture_suggestion: {
              suggestion_type: "journal_entry",
              title: "Notable moment",
              suggested_date: "2026-01-17",
            },
          },
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-007",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope.meta.capture_suggestion).toBeDefined();
    expect(body.outputEnvelope.meta.capture_suggestion.suggestion_id).toBe(
      `cap_${body.transmissionId}`
    );
  });
  it("fails when raw output exceeds max bytes and records trace reason", async () => {
    const largeText = "a".repeat(100 * 1024);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: largeText,
        }),
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-006",
        message: "Test message",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("output_contract_failed");
    expect(body.outputEnvelope).toBeUndefined();

    const traceRunId = response.headers["x-sol-trace-run-id"] as string;
    expect(traceRunId).toBeTruthy();
    const events = await store.getTraceEvents(traceRunId, { limit: 50 });
    const payloadTooLarge = events.find((e: any) =>
      e.phase === "output_gates"
      && e.metadata?.kind === "output_envelope"
      && e.metadata?.reason === "payload_too_large"
    );
    expect(payloadTooLarge).toBeTruthy();
  });
  it("persists output_contract_failed in async completion", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-simulate-status": "202",
        "x-sol-test-output-envelope": "{not-json",
      },
      payload: {
        packetType: "chat",
        threadId: "thread-output-envelope-003",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    const transmissionId = body.transmissionId as string;
    expect(transmissionId).toBeTruthy();
    expect(response.headers["x-sol-transmission-id"]).toBeTruthy();
    expect(response.headers["x-sol-trace-run-id"]).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 900));

    const poll = await app.inject({
      method: "GET",
      url: `/v1/transmissions/${transmissionId}`,
    });

    expect(poll.statusCode).toBe(200);
    const pollBody = poll.json();
    expect(pollBody.transmission.status).toBe("failed");
    expect(pollBody.transmission.statusCode).toBe(422);
    expect(pollBody.transmission.retryable).toBe(false);
    expect(pollBody.assistant).toBe(OUTPUT_CONTRACT_STUB);
    expect(
      pollBody.attempts.some((a: any) => a.error === "output_contract_failed:invalid_json")
    ).toBe(true);
  }, 10000);
});
