import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import path from "node:path";

import { chatRoutes } from "../src/routes/chat";
import { memoryRoutes } from "../src/routes/memories";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";

const makeApp = () => {
  const app = Fastify({ logger: false });
  const store = new MemoryControlPlaneStore();
  app.register(chatRoutes as any, { prefix: "/v1", store });
  app.register(memoryRoutes as any, { prefix: "/v1", store });
  return { app, store };
};

describe("lattice retrieval", () => {
  const { app, store } = makeApp();
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await app.ready();
  });

  beforeEach(() => {
    for (const key of [
      "LATTICE_ENABLED",
      "LATTICE_VEC_ENABLED",
      "LATTICE_VEC_QUERY_ENABLED",
      "LATTICE_VEC_EXTENSION_PATH",
      "LATTICE_POLICY_BUNDLE_PATH",
      "LLM_PROVIDER",
    ]) {
      originalEnv[key] = process.env[key];
    }
    process.env.LLM_PROVIDER = "fake";
  });

  afterEach(() => {
    for (const key of Object.keys(originalEnv)) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("always includes meta.lattice and respects byte caps", async () => {
    process.env.LATTICE_ENABLED = "1";
    const userId = "user-lattice-1";

    for (let i = 0; i < 8; i += 1) {
      await store.createMemoryArtifact({
        userId,
        transmissionId: null,
        threadId: "thread-lattice-1",
        triggerMessageId: `m-${i}`,
        type: "memory",
        snippet: `caps test memory ${i} ` + "x".repeat(2000),
        summary: `caps test memory ${i} ` + "x".repeat(2000),
        moodAnchor: null,
        rigorLevel: "normal",
        tags: ["caps"],
        fidelity: "direct",
        transitionToHazyAt: null,
        lifecycleState: "pinned",
        memoryKind: "preference",
      });
    }

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId: "thread-lattice-1",
        message: "caps memory check",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outputEnvelope?.meta?.lattice).toBeDefined();
    expect(body.outputEnvelope.meta.lattice.bytes_total).toBeLessThanOrEqual(8192);
    expect(body.outputEnvelope.meta.lattice.warnings).toContain("lattice_bytes_capped");
  });

  it("retrieves memories saved via the API on the next chat turn", async () => {
    process.env.LATTICE_ENABLED = "1";
    const userId = "user-lattice-api-1";

    const create = await app.inject({
      method: "POST",
      url: "/v1/memories",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "mem-api-1",
        memory: {
          domain: "prefs",
          content: "User prefers espresso drinks over drip coffee.",
          tags: ["coffee"],
        },
        consent: { explicit_user_consent: true },
      },
    });

    expect(create.statusCode).toBe(200);
    const createdBody = create.json();
    const memoryId = createdBody.memory?.memory_id as string;
    expect(memoryId).toBeTruthy();

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId: "thread-lattice-api-1",
        message: "espresso sounds great",
      },
    });

    expect(chat.statusCode).toBe(200);
    const lattice = chat.json().outputEnvelope.meta.lattice;
    expect(lattice.retrieval_trace.memory_ids).toContain(memoryId);
  });

  it("uses a saved name memory on the next turn", async () => {
    process.env.LATTICE_ENABLED = "1";
    const userId = "user-lattice-name-1";
    const threadId = "thread-lattice-name-1";

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId,
        message: "My name is Jassen",
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    const anchorId = (firstBody.transmissionId ?? firstBody.transmission_id) as string;
    expect(anchorId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId,
        message: "Nice to meet you.",
      },
    });
    expect(second.statusCode).toBe(200);

    const save = await app.inject({
      method: "POST",
      url: "/v1/memories",
      headers: { "x-sol-user-id": userId },
      payload: {
        request_id: "mem-name-1",
        thread_id: threadId,
        anchor_message_id: anchorId,
        window: { before: 0, after: 1 },
        memory_kind: "fact",
        consent: { explicit_user_consent: true },
      },
    });
    expect(save.statusCode).toBe(200);
    const saveBody = save.json();
    const memoryId = saveBody.memory?.memory_id as string;
    expect(memoryId).toBeTruthy();

    const recall = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId,
        message: "What's my name?",
      },
    });
    expect(recall.statusCode).toBe(200);
    const recallBody = recall.json();
    const lattice = recallBody.outputEnvelope.meta.lattice;
    expect(lattice.status).toBe("hit");
    expect(lattice.retrieval_trace.memory_ids).toContain(memoryId);
    expect(String(recallBody.assistant ?? "")).toContain("Jassen");
  });

  it("retrieves pinned memories only", async () => {
    process.env.LATTICE_ENABLED = "1";
    process.env.LATTICE_VEC_ENABLED = "0";
    process.env.LATTICE_VEC_QUERY_ENABLED = "0";
    const userId = "user-lattice-2";

    const pinned = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: "thread-lattice-2",
      triggerMessageId: "m1",
      type: "memory",
      snippet: "pinned memory alpha",
      summary: "pinned memory alpha",
      moodAnchor: null,
      rigorLevel: "normal",
      tags: ["alpha"],
      fidelity: "direct",
      transitionToHazyAt: null,
      lifecycleState: "pinned",
      memoryKind: "fact",
    });

    const archived = await store.createMemoryArtifact({
      userId,
      transmissionId: null,
      threadId: "thread-lattice-2",
      triggerMessageId: "m2",
      type: "memory",
      snippet: "archived memory alpha",
      summary: "archived memory alpha",
      moodAnchor: null,
      rigorLevel: "normal",
      tags: ["alpha"],
      fidelity: "direct",
      transitionToHazyAt: null,
      lifecycleState: "archived",
      memoryKind: "fact",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId: "thread-lattice-2",
        message: "alpha",
      },
    });

    expect(response.statusCode).toBe(200);
    const lattice = response.json().outputEnvelope.meta.lattice;
    expect(lattice.retrieval_trace.memory_ids).toContain(pinned.id);
    expect(lattice.retrieval_trace.memory_ids).not.toContain(archived.id);
    const scores = lattice.scores ?? {};
    expect(Object.keys(scores)).toContain(pinned.id);
    expect(scores[pinned.id].method).toBe("fts5_bm25");
    expect(typeof scores[pinned.id].value).toBe("number");
  });

  it("marks lattice hit when mementos are present", async () => {
    process.env.LATTICE_ENABLED = "0";
    const threadId = "thread-lattice-memento-1";

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId,
        message: "Seed memento context",
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId,
        message: "Follow-up for memento hit",
      },
    });
    expect(second.statusCode).toBe(200);
    const lattice = second.json().outputEnvelope.meta.lattice;
    expect(lattice.status).toBe("hit");
    expect(lattice.retrieval_trace.memento_ids?.length ?? 0).toBeGreaterThan(0);
    expect(lattice.retrieval_trace.memory_ids ?? []).toHaveLength(0);
  });

  it("retrieves policy capsules only when triggered", async () => {
    process.env.LATTICE_ENABLED = "1";
    process.env.LATTICE_POLICY_BUNDLE_PATH = path.join(
      __dirname,
      "fixtures",
      "policy_capsules.json"
    );

    const userId = "user-lattice-3";
    const quiet = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId: "thread-lattice-3",
        message: "hello there",
      },
    });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json().outputEnvelope.meta.lattice.retrieval_trace.policy_capsule_ids).toEqual([]);

    const triggered = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": userId },
      payload: {
        threadId: "thread-lattice-3",
        message: "policy safety check",
      },
    });
    expect(triggered.statusCode).toBe(200);
    const policyIds = triggered.json().outputEnvelope.meta.lattice.retrieval_trace.policy_capsule_ids;
    expect(policyIds.length).toBeGreaterThan(0);
  });

  it("fails open when vec extension cannot load", async () => {
    process.env.LATTICE_ENABLED = "1";
    process.env.LATTICE_VEC_ENABLED = "1";
    process.env.LATTICE_VEC_QUERY_ENABLED = "1";
    process.env.LATTICE_VEC_EXTENSION_PATH = "/tmp/missing-vec0.so";

    const sqliteStore = new SqliteControlPlaneStore(":memory:");
    const localApp = Fastify({ logger: false });
    localApp.register(chatRoutes as any, { prefix: "/v1", store: sqliteStore });
    localApp.register(memoryRoutes as any, { prefix: "/v1", store: sqliteStore });
    await localApp.ready();

    const response = await localApp.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-user-id": "user-vec-fail" },
      payload: {
        threadId: "thread-vec-fail",
        message: "memory vec check",
      },
    });

    expect(response.statusCode).toBe(200);
    const lattice = response.json().outputEnvelope.meta.lattice;
    expect(lattice.warnings).toContain("vec_load_failed");

    await localApp.close();
    sqliteStore.close();
  });
});
