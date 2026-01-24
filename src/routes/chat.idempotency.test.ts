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
    expect(firstJson.threadMemento.version).toBe("memento-v0.1");

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
    expect(secondJson.threadMemento.mementoId).toBe(firstJson.threadMemento.mementoId);
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
    expect(second.headers["x-sol-transmission-id"]).toBeTruthy();
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

describe("/v1/memento/decision", () => {
  const { app } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts a draft memento and is idempotent on repeat accept", async () => {
    const threadId = "t-memento-accept";
    const clientRequestId = "memento-accept-1";

    // Create a draft memento via chat.
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId, clientRequestId, message: "hello memento" },
    });

    expect(chat.statusCode).toBe(200);
    const chatJson = chat.json();
    expect(chatJson.threadMemento).toBeTruthy();
    const mementoId = chatJson.threadMemento.mementoId as string;
    expect(typeof mementoId).toBe("string");

    const accept1 = await app.inject({
      method: "POST",
      url: "/v1/memento/decision",
      payload: { threadId, mementoId, decision: "accept" },
    });

    expect(accept1.statusCode).toBe(200);
    const a1 = accept1.json();
    expect(a1.ok).toBe(true);
    expect(a1.decision).toBe("accept");
    expect(a1.applied).toBe(true);
    expect(a1.reason).toBe("applied");
    expect(a1.memento).toBeTruthy();
    expect(a1.memento.mementoId).toBe(mementoId);

    const accept2 = await app.inject({
      method: "POST",
      url: "/v1/memento/decision",
      payload: { threadId, mementoId, decision: "accept" },
    });

    expect(accept2.statusCode).toBe(200);
    const a2 = accept2.json();
    expect(a2.ok).toBe(true);
    expect(a2.decision).toBe("accept");
    expect(a2.applied).toBe(false);
    expect(a2.reason).toBe("already_accepted");
    expect(a2.memento).toBeTruthy();
    expect(a2.memento.mementoId).toBe(mementoId);
  });

  it("declines a draft memento and repeat decline is not_found", async () => {
    const threadId = "t-memento-decline";
    const clientRequestId = "memento-decline-1";

    // Create a draft memento via chat.
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId, clientRequestId, message: "hello decline" },
    });

    expect(chat.statusCode).toBe(200);
    const chatJson = chat.json();
    expect(chatJson.threadMemento).toBeTruthy();
    const mementoId = chatJson.threadMemento.mementoId as string;

    const decline1 = await app.inject({
      method: "POST",
      url: "/v1/memento/decision",
      payload: { threadId, mementoId, decision: "decline" },
    });

    expect(decline1.statusCode).toBe(200);
    const d1 = decline1.json();
    expect(d1.ok).toBe(true);
    expect(d1.decision).toBe("decline");
    expect(d1.applied).toBe(true);
    expect(d1.reason).toBe("applied");

    const decline2 = await app.inject({
      method: "POST",
      url: "/v1/memento/decision",
      payload: { threadId, mementoId, decision: "decline" },
    });

    expect(decline2.statusCode).toBe(200);
    const d2 = decline2.json();
    expect(d2.ok).toBe(true);
    expect(d2.decision).toBe("decline");
    expect(d2.applied).toBe(false);
    expect(d2.reason).toBe("not_found");
    expect(d2.memento ?? null).toBeNull();
  });
});
