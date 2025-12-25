

import { describe, it, expect } from "vitest";

import { buildPromptPack, toSinglePromptText } from "../control-plane/prompt_pack";
import { retrieveContext } from "../control-plane/retrieval";

import type { PacketInput, ModeDecision } from "../contracts/chat";

function makePacket(message: string): PacketInput {
  return {
    packetType: "chat",
    threadId: "t1",
    message,
  } as PacketInput;
}

function makeModeDecision(modeLabel: string): ModeDecision {
  return {
    modeLabel,
    domainFlags: [],
    confidence: 0.7,
    checkpointNeeded: false,
    reasons: ["test"],
    version: "mode-engine-v0",
  } as ModeDecision;
}

describe("Step 6 - PromptPack", () => {
  it("buildPromptPack uses deterministic section order", () => {
    const packet = makePacket("hello sol");
    const modeDecision = makeModeDecision("Ida");

    const pack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems: [],
    });

    expect(pack.version).toBe("prompt-pack-v0");
    expect(pack.sections.map((s) => s.id)).toEqual(["law", "retrieval", "user_message"]);
    expect(pack.sections.map((s) => s.role)).toEqual(["system", "system", "user"]);
  });

  it("retrieval section is present even when empty", () => {
    const packet = makePacket("hello sol");
    const modeDecision = makeModeDecision("Ida");

    const pack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems: [],
    });

    const retrieval = pack.sections.find((s) => s.id === "retrieval");
    expect(retrieval).toBeTruthy();
    expect(retrieval?.content).toContain("no retrieved context");
  });

  it("toSinglePromptText includes stable section headers", () => {
    const packet = makePacket("hello sol");
    const modeDecision = makeModeDecision("Ida");

    const pack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems: [],
    });

    const text = toSinglePromptText(pack);

    // Keep this intentionally light so we do not lock to exact law text yet.
    expect(text).toContain("## Mounted law");
    expect(text).toContain("## Retrieved context");
    expect(text).toContain("## User message");

    // The packed prompt should be larger than the raw user message.
    expect(text.length).toBeGreaterThan(packet.message.length);
  });
});

describe("Step 6 - retrieval seam", () => {
  it("retrieveContext returns an empty list in v0", async () => {
    const items = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });

    expect(items).toEqual([]);
  });
});