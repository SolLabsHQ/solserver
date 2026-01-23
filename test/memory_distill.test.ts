import { describe, it, expect, afterEach } from "vitest";

import { buildGhostCardEnvelope } from "../src/memory/ghost_envelope";
import { processDistillation, type ContextMessage } from "../src/memory/synaptic_gate";

const makeContext = (content: string): ContextMessage[] => [
  {
    messageId: "m1",
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  },
];

describe("Synaptic Gate distillation", () => {
  afterEach(() => {
    delete process.env.SENTINEL_FORCE_FAIL;
  });

  it("flags peanut allergy snippets as high rigor", async () => {
    const result = await processDistillation(makeContext("I have a peanut allergy."));
    expect(result.fact).toBeTruthy();
    expect(result.rigorLevel).toBe("high");
  });

  it("treats Sentinel failure as high rigor with reason", async () => {
    process.env.SENTINEL_FORCE_FAIL = "1";
    const result = await processDistillation(makeContext("I have a peanut allergy."));
    expect(result.rigorLevel).toBe("high");
    expect(result.rigorReason).toBe("sentinel_unavailable");
  });

  it("returns null fact for low-signal context", async () => {
    const result = await processDistillation(makeContext("hi"));
    expect(result.fact).toBeNull();
  });
});

describe("Ghost envelope metadata", () => {
  it("marks fact_null with null memory metadata", () => {
    const envelope = buildGhostCardEnvelope({
      text: "fallback",
      memoryId: null,
      rigorLevel: "normal",
      snippet: null,
      factNull: true,
    });

    expect(envelope.meta?.fact_null).toBe(true);
    expect(envelope.meta?.memory_id).toBeNull();
    expect(envelope.meta?.snippet).toBeNull();
  });
});
