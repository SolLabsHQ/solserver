import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

import { traceRoutes } from "../src/routes/trace";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

const makeApp = () => {
  const app = Fastify({ logger: false });
  const store = new MemoryControlPlaneStore();
  app.register(traceRoutes as any, { prefix: "/v1", store });
  return { app };
};

describe("/v1/trace/events", () => {
  const { app } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts valid journal offer events and device muse observations", async () => {
    const payload = {
      requestId: "trace-req-1",
      localUserUuid: "local-user-1",
      events: [
        {
          eventId: "evt-1",
          eventType: "journal_offer_shown",
          ts: new Date().toISOString(),
          threadId: "t1",
          momentId: "moment-1",
          evidenceSpan: { startMessageId: "m1", endMessageId: "m2" },
        },
        {
          observationId: "obs-1",
          ts: new Date().toISOString(),
          localUserUuid: "local-user-1",
          threadId: "t1",
          messageId: "m2",
          version: "device-muse-observation-v0.1",
          source: "apple_intelligence",
          detectedType: "overwhelm",
          intensity: 0.6,
          confidence: 0.7,
        },
      ],
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/trace/events",
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.acceptedCount).toBe(2);
    expect(body.rejectedCount).toBe(0);
  });

  it("rejects device muse observations with forbidden content fields", async () => {
    const payload = {
      requestId: "trace-req-2",
      localUserUuid: "local-user-2",
      events: [
        {
          observationId: "obs-2",
          ts: new Date().toISOString(),
          localUserUuid: "local-user-2",
          threadId: "t2",
          messageId: "m9",
          version: "device-muse-observation-v0.1",
          source: "apple_intelligence",
          detectedType: "overwhelm",
          intensity: 0.6,
          confidence: 0.7,
          text: "should be rejected",
        },
      ],
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/trace/events",
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.acceptedCount).toBe(0);
    expect(body.rejectedCount).toBe(1);
  });
});
