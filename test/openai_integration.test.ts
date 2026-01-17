import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

describe.skipIf(process.env.RUN_OPENAI_INTEGRATION !== "1")("OpenAI integration (optional)", () => {
  let app: any;
  let store: MemoryControlPlaneStore;
  const previousProvider = process.env.LLM_PROVIDER;

  beforeAll(async () => {
    process.env.LLM_PROVIDER = "openai";
    store = new MemoryControlPlaneStore();
    app = Fastify({ logger: false });
    app.register(cors, { origin: true });
    app.register(chatRoutes, { prefix: "/v1", store });
    await app.ready();
  });

  afterAll(async () => {
    process.env.LLM_PROVIDER = previousProvider;
    await app.close();
  });

  it("returns a valid outputEnvelope from OpenAI", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-openai-001",
        message: "Test message",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope).toBeDefined();
    expect(body.outputEnvelope.assistant_text).toBe(body.assistant);
  }, 60000);
});
