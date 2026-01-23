import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

import { chatRoutes } from "../src/routes/chat";
import { memoryRoutes } from "../src/routes/memories";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

const makeApp = () => {
  const app = Fastify({ logger: false });
  const store = new MemoryControlPlaneStore();
  app.register(chatRoutes as any, { prefix: "/v1", store });
  app.register(memoryRoutes as any, { prefix: "/v1", store });
  return { app, store };
};

describe("/v1/memories routes", () => {
  const { app, store } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns distill ACK and increments reaffirm count", async () => {
    const userId = "user-1";
    const requestId = "distill-req-1";
    const payload = {
      request_id: requestId,
      thread_id: "thread-1",
      trigger_message_id: "m1",
      context_window: [
        {
          message_id: "m1",
          role: "user",
          content: "Remember I like espresso.",
          created_at: new Date().toISOString(),
        },
      ],
      consent: { explicit_user_consent: true },
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/memories/distill",
      headers: { "x-sol-user-id": userId },
      payload,
    });

    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    expect(firstBody.request_id).toBe(requestId);
    expect(firstBody.transmission_id).toBeTruthy();
    expect(firstBody.status).toBe("pending");
    expect("fact" in firstBody).toBe(false);
    expect("snippet" in firstBody).toBe(false);

    const firstRecord = await store.getMemoryDistillRequestByRequestId({
      userId,
      requestId,
    });
    expect(firstRecord?.reaffirmCount).toBe(0);

    const storedContext = await store.getMemoryDistillContext({ userId, requestId });
    expect(storedContext?.length).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/v1/memories/distill",
      headers: { "x-sol-user-id": userId },
      payload: { ...payload, reaffirm_count: 5 },
    });

    expect(second.statusCode).toBe(202);
    const secondRecord = await store.getMemoryDistillRequestByRequestId({
      userId,
      requestId,
    });
    expect(secondRecord?.reaffirmCount).toBe(5);
  });

  it("rejects unknown keys and oversized context windows", async () => {
    const userId = "user-2";
    const bad = await app.inject({
      method: "POST",
      url: "/v1/memories/distill",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "bad-req",
        thread_id: "thread-2",
        trigger_message_id: "m2",
        context_window: [
          {
            message_id: "m2",
            role: "user",
            content: "ok",
            created_at: new Date().toISOString(),
          },
        ],
        consent: { explicit_user_consent: true },
        extra_field: "nope",
      },
    });

    expect(bad.statusCode).toBe(400);
    const badBody = bad.json();
    expect(badBody.error).toBe("invalid_request");
    expect(badBody.unrecognizedKeys).toContain("extra_field");

    const contextWindow = Array.from({ length: 16 }, (_, idx) => ({
      message_id: `m-${idx}`,
      role: "user",
      content: `message ${idx}`,
      created_at: new Date().toISOString(),
    }));

    const tooLarge = await app.inject({
      method: "POST",
      url: "/v1/memories/distill",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "bad-req-2",
        thread_id: "thread-2",
        trigger_message_id: "m-0",
        context_window: contextWindow,
        consent: { explicit_user_consent: true },
      },
    });

    expect(tooLarge.statusCode).toBe(400);
  });

  it("requires user identity for memory routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/memories",
    });

    expect(response.statusCode).toBe(401);
  });

  it("enforces confirm=true for high-rigor deletes", async () => {
    const userId = "user-3";
    const artifact = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: "thread-3",
      triggerMessageId: "m3",
      type: "memory",
      snippet: "Peanut allergy",
      moodAnchor: "standard_fact",
      rigorLevel: "high",
      tags: ["health"],
      fidelity: "direct",
      transitionToHazyAt: null,
      requestId: "mem-req-3",
    });

    const blocked = await app.inject({
      method: "DELETE",
      url: `/v1/memories/${artifact.id}`,
      headers: { "x-sol-user-id": userId },
    });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("confirm_required");

    const ok = await app.inject({
      method: "DELETE",
      url: `/v1/memories/${artifact.id}?confirm=true`,
      headers: { "x-sol-user-id": userId },
    });

    expect(ok.statusCode).toBe(204);

    const idempotent = await app.inject({
      method: "DELETE",
      url: `/v1/memories/${artifact.id}?confirm=true`,
      headers: { "x-sol-user-id": userId },
    });

    expect(idempotent.statusCode).toBe(204);
  });

  it("requires confirm phrase for clear_all and confirm=true for batch delete", async () => {
    const userId = "user-4";
    const badClear = await app.inject({
      method: "POST",
      url: "/v1/memories/clear_all",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "clear-1",
        confirm: true,
        confirm_phrase: "NOPE",
      },
    });

    expect(badClear.statusCode).toBe(400);

    const badBatch = await app.inject({
      method: "POST",
      url: "/v1/memories/batch_delete",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "batch-1",
        confirm: false,
        filter: { thread_id: "thread-x" },
      },
    });

    expect(badBatch.statusCode).toBe(400);
  });
});

describe("/v1/transmissions ghost_type normalization", () => {
  const { app, store } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("maps ghost_type to ghost_kind on read", async () => {
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { threadId: "t-ghost", message: "hello" },
    });

    const transmissionId = chat.json().transmissionId as string;
    await store.setTransmissionOutputEnvelope({
      transmissionId,
      outputEnvelope: {
        assistant_text: "ghost",
        meta: { ghost_type: "memory" },
      },
    });

    const poll = await app.inject({
      method: "GET",
      url: `/v1/transmissions/${transmissionId}`,
    });

    const body = poll.json();
    expect(body.outputEnvelope.meta.ghost_kind).toBe("memory_artifact");
  });
});
