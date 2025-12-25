import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

import { chatRoutes } from "./chat";
import { MemoryControlPlaneStore } from "../store/control_plane_store";

function makeApp() {
  const app = Fastify({ logger: false });
  const store = new MemoryControlPlaneStore();
  app.register(chatRoutes as any, { prefix: "/v1", store });
  return { app };
}

describe("/v1/chat idempotency", () => {
  const { app } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("replays completed responses for the same clientRequestId", async () => {
    const clientRequestId = "test-replay-1";

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId: "t1", clientRequestId, message: "hello sol" },
    });

    expect(first.statusCode).toBe(200);
    const firstJson = first.json();
    expect(firstJson.ok).toBe(true);
    expect(firstJson.transmissionId).toBeTruthy();
    expect(firstJson.threadMemento).toBeTruthy();
    expect(firstJson.threadMemento.threadId).toBe("t1");
    expect(firstJson.threadMemento.arc).toBeTruthy();
    expect(firstJson.threadMemento.version).toBe("memento-v0");

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId: "t1", clientRequestId, message: "hello sol" },
    });

    expect(second.statusCode).toBe(200);
    const secondJson = second.json();
    expect(secondJson.transmissionId).toBe(firstJson.transmissionId);
    expect(secondJson.idempotentReplay).toBe(true);
    expect(secondJson.threadMemento).toBeTruthy();
    // Replay should return the same latest ThreadMemento snapshot.
    expect(secondJson.threadMemento.id).toBe(firstJson.threadMemento.id);
  });

  it("returns 409 if the same clientRequestId is reused for a different payload", async () => {
    const clientRequestId = "test-conflict-1";

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId: "t1", clientRequestId, message: "m1" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId: "t1", clientRequestId, message: "m2" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("idempotency_conflict");
  });

  it("allows retry after a simulated 500 using the same transmission id", async () => {
    const clientRequestId = "test-retry-500-1";

    const fail = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-simulate-status": "500" },
      payload: { threadId: "t1", clientRequestId, message: "hello sol" },
    });

    expect(fail.statusCode).toBe(500);
    const failJson = fail.json();
    expect(failJson.transmissionId).toBeTruthy();
    expect(failJson.retryable).toBe(true);
    expect(failJson.threadMemento ?? null).toBeNull();

    const ok = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId: "t1", clientRequestId, message: "hello sol" },
    });

    expect(ok.statusCode).toBe(200);
    const okJson = ok.json();
    expect(okJson.ok).toBe(true);
    expect(okJson.threadMemento).toBeTruthy();
    expect(okJson.threadMemento.threadId).toBe("t1");
    // Critical: retry reuses SAME transmission id
    expect(okJson.transmissionId).toBe(failJson.transmissionId);
  });
});