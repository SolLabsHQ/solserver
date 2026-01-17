import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

const OUTPUT_CONTRACT_STUB =
  "I can't do that directly from here. Tell me what you're trying to accomplish and I'll give you a safe draft or step-by-step instructions.";

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

  it("fails when claims are present but empty", async () => {
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
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe("output_contract_failed");
    expect(body.outputEnvelope).toBeUndefined();
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
