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

describe("/v1/transmissions journalOffer", () => {
  const { app } = makeApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns journalOffer when eligible", async () => {
    const envelope = {
      assistant_text: "ok",
      meta: {
        affect_signal: { label: "insight", intensity: 0.9, confidence: "high" },
      },
    };

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-test-output-envelope": JSON.stringify(envelope) },
      payload: { threadId: "t-journal-eligible", clientRequestId: "cr-eligible", message: "hello" },
    });

    expect(chat.statusCode).toBe(200);
    const chatJson = chat.json();
    const txId = chatJson.transmissionId as string;
    expect(txId).toBeTruthy();

    const tx = await app.inject({
      method: "GET",
      url: `/v1/transmissions/${txId}`,
    });

    expect(tx.statusCode).toBe(200);
    const txJson = tx.json();
    expect(txJson.journalOffer).toBeTruthy();
    expect(txJson.journalOffer.offerEligible).toBe(true);
    expect(txJson.journalOffer.kind).toBe("journal_offer");
    expect(txJson.journalOffer.evidenceSpan?.startMessageId).toBeTruthy();
    expect(txJson.journalOffer.evidenceSpan?.endMessageId).toBeTruthy();
  });

  it("returns journalOffer with skip reasons when ineligible", async () => {
    const envelope = {
      assistant_text: "ok",
      meta: {
        affect_signal: { label: "neutral", intensity: 0.1, confidence: "low" },
      },
    };

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "x-sol-test-output-envelope": JSON.stringify(envelope) },
      payload: { threadId: "t-journal-skip", clientRequestId: "cr-skip", message: "hello" },
    });

    expect(chat.statusCode).toBe(200);
    const chatJson = chat.json();
    const txId = chatJson.transmissionId as string;
    expect(txId).toBeTruthy();

    const tx = await app.inject({
      method: "GET",
      url: `/v1/transmissions/${txId}`,
    });

    expect(tx.statusCode).toBe(200);
    const txJson = tx.json();
    expect(txJson.journalOffer).toBeTruthy();
    expect(txJson.journalOffer.offerEligible).toBe(false);
    expect(txJson.journalOffer.reasonCodes?.length).toBeGreaterThan(0);
  });
});
