import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

import { journalRoutes } from "../src/routes/journal";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import { JournalDraftEnvelopeSchema } from "../src/contracts/journal";

const makeApp = () => {
  const app = Fastify({ logger: false });
  const store = new MemoryControlPlaneStore();
  app.register(journalRoutes as any, { prefix: "/v1", store });
  return { app, store };
};

describe("/v1/journal routes", () => {
  const { app, store } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns schema-valid journal drafts with evidence binding", async () => {
    const modeDecision = {
      modeLabel: "System-mode",
      personaLabel: "system",
      domainFlags: [],
      confidence: 1,
      checkpointNeeded: false,
      reasons: ["test"],
      version: "mode-engine-v0",
    };

    const messages = [
      "I feel overwhelmed today.",
      "Work has been nonstop.",
      "I want to reset this weekend.",
    ];

    const transmissions = [];
    for (const text of messages) {
      const transmission = await store.createTransmission({
        packet: {
          packetType: "chat",
          threadId: "t-journal",
          message: text,
        },
        modeDecision,
      });
      transmissions.push(transmission);
    }

    const payload = {
      requestId: "draft-1",
      threadId: "t-journal",
      mode: "assist",
      evidenceSpan: {
        startMessageId: transmissions[0].id,
        endMessageId: transmissions[2].id,
      },
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/journal/drafts",
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const validation = JournalDraftEnvelopeSchema.safeParse(body);
    expect(validation.success).toBe(true);
    expect(body.sourceSpan.startMessageId).toBe(payload.evidenceSpan.startMessageId);
    expect(body.sourceSpan.endMessageId).toBe(payload.evidenceSpan.endMessageId);
    expect(body.meta.evidenceBinding.sourceSpan.startMessageId).toBe(payload.evidenceSpan.startMessageId);
    expect(body.meta.evidenceBinding.nonInvention).toBe(true);
  });

  it("creates, lists, updates, and deletes journal entries", async () => {
    const userId = "user-journal-1";
    const entryId = "entry-1";
    const payload = {
      requestId: "entry-req-1",
      entry: {
        entryId,
        createdTs: new Date().toISOString(),
        title: "First entry",
        body: "Body",
        tags: ["tag1"],
        sourceSpan: { threadId: "t1", startMessageId: "m1", endMessageId: "m1" },
        draftMeta: { mode: "assist", draftId: "draft-1" },
      },
      consent: { explicitUserConsent: true },
    };

    const create = await app.inject({
      method: "POST",
      url: "/v1/journal/entries",
      headers: { "x-sol-user-id": userId },
      payload,
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().entry.entryId).toBe(entryId);

    const list = await app.inject({
      method: "GET",
      url: "/v1/journal/entries?limit=10",
      headers: { "x-sol-user-id": userId },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThan(0);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/journal/entries/${entryId}`,
      headers: { "x-sol-user-id": userId },
      payload: {
        requestId: "entry-req-2",
        patch: { title: "Updated" },
        consent: { explicitUserConsent: true },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().entryId).toBe(entryId);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/journal/entries/${entryId}`,
      headers: { "x-sol-user-id": userId },
    });
    expect(del.statusCode).toBe(204);
  });
});
