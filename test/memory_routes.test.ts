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
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    originalEnv.LLM_PROVIDER = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fake";
    await app.ready();
  });

  afterAll(async () => {
    if (originalEnv.LLM_PROVIDER === undefined) {
      delete process.env.LLM_PROVIDER;
    } else {
      process.env.LLM_PROVIDER = originalEnv.LLM_PROVIDER;
    }
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

  it("saves a memory span and includes evidence_message_ids", async () => {
    const userId = "user-span-1";
    const threadId = "thread-span-1";

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId,
        message: "First message for span.",
      },
    });
    const firstBody = first.json();
    const firstTx = firstBody.transmissionId as string;

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId,
        message: "Second message for span.",
      },
    });
    const secondBody = second.json();
    const secondTx = secondBody.transmissionId as string;

    const save = await app.inject({
      method: "POST",
      url: "/v1/memories",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "span-save-1",
        thread_id: threadId,
        anchor_message_id: firstTx,
        window: { before: 0, after: 1 },
        memory_kind: "preference",
        consent: { explicit_user_consent: true },
      },
    });

    expect(save.statusCode).toBe(200);
    const body = save.json();
    expect(body.memory.evidence_message_ids.length).toBeGreaterThan(1);
    expect(body.memory.evidence_message_ids).toContain(firstTx);
    expect(body.memory.evidence_message_ids).toContain(secondTx);
    expect(body.memory.snippet.length).toBeGreaterThan(0);
    expect(body.memory.snippet.length).toBeLessThanOrEqual(200);
    expect(body.memory.snippet).not.toMatch(/\b(User|Assistant|System):/);
    expect(body.memory.summary?.split(/\r?\n/).filter(Boolean).length ?? 0).toBeLessThanOrEqual(3);
  });

  it("filters memory list by lifecycle_state and returns archived by id", async () => {
    const userId = "user-life-1";
    const pinned = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: "thread-life-1",
      triggerMessageId: "m-life-1",
      type: "memory",
      snippet: "Pinned memory",
      summary: "Pinned memory",
      moodAnchor: null,
      rigorLevel: "normal",
      tags: [],
      fidelity: "direct",
      transitionToHazyAt: null,
      lifecycleState: "pinned",
      memoryKind: "preference",
    });
    const archived = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: "thread-life-1",
      triggerMessageId: "m-life-2",
      type: "memory",
      snippet: "Archived memory",
      summary: "Archived memory",
      moodAnchor: null,
      rigorLevel: "normal",
      tags: [],
      fidelity: "direct",
      transitionToHazyAt: null,
      lifecycleState: "archived",
      memoryKind: "fact",
    });

    const listPinned = await app.inject({
      method: "GET",
      url: "/v1/memories",
      headers: { "x-sol-user-id": userId },
    });
    expect(listPinned.statusCode).toBe(200);
    const pinnedBody = listPinned.json();
    const ids = pinnedBody.items.map((item: any) => item.memory_id);
    expect(ids).toContain(pinned.id);
    expect(ids).not.toContain(archived.id);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/memories/${archived.id}`,
      headers: { "x-sol-user-id": userId },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.memory.lifecycle_state).toBe("archived");
  });

  it("patch creates new memory id and archives old record", async () => {
    const userId = "user-edit-1";
    const artifact = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: "thread-edit-1",
      triggerMessageId: "m-edit-1",
      type: "memory",
      snippet: "Original",
      summary: "Original",
      moodAnchor: null,
      rigorLevel: "normal",
      tags: ["a"],
      fidelity: "direct",
      transitionToHazyAt: null,
      lifecycleState: "pinned",
      memoryKind: "fact",
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/memories/${artifact.id}`,
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "edit-req-1",
        patch: {
          snippet: "Updated",
        },
        consent: { explicit_user_consent: true },
      },
    });
    expect(patch.statusCode).toBe(200);
    const patchBody = patch.json();
    expect(patchBody.memory.memory_id).not.toBe(artifact.id);
    expect(patchBody.memory.supersedes_memory_id).toBe(artifact.id);

    const oldDetail = await app.inject({
      method: "GET",
      url: `/v1/memories/${artifact.id}`,
      headers: { "x-sol-user-id": userId },
    });
    expect(oldDetail.statusCode).toBe(200);
    expect(oldDetail.json().memory.lifecycle_state).toBe("archived");
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

    const detail = await app.inject({
      method: "GET",
      url: `/v1/memories/${artifact.id}`,
      headers: { "x-sol-user-id": userId },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().memory.lifecycle_state).toBe("archived");

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
