import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

describe("Deterministic retry in tests", () => {
  let app: any;
  let store: MemoryControlPlaneStore;
  let previousEnforcement: string | undefined;

  beforeAll(async () => {
    previousEnforcement = process.env.DRIVER_BLOCK_ENFORCEMENT;
    process.env.DRIVER_BLOCK_ENFORCEMENT = "warn";

    store = new MemoryControlPlaneStore();
    app = Fastify({ logger: false });
    app.register(cors, { origin: true });
    app.register(chatRoutes, { prefix: "/v1", store });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();

    if (previousEnforcement === undefined) {
      delete process.env.DRIVER_BLOCK_ENFORCEMENT;
    } else {
      process.env.DRIVER_BLOCK_ENFORCEMENT = previousEnforcement;
    }
  });

  it("uses attempt 1 output when deterministic retry headers are set", async () => {
    const attempt0 = "I sent the email for you.";
    const attempt1 = "Here is a draft email you can send.";

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-attempt-0": attempt0,
        "x-sol-test-output-attempt-1": attempt1,
      },
      payload: {
        packetType: "chat",
        threadId: "thread-deterministic-retry-001",
        message: "Test",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.assistant).toBe(attempt1);
    expect(body.outputEnvelope?.assistant_text).toBe(attempt1);

    const postLinterAttempt1 = body.trace.events.find(
      (e: any) => e.metadata?.kind === "post_linter" && e.metadata?.attempt === 1
    );
    expect(postLinterAttempt1).toBeDefined();
  });
});
