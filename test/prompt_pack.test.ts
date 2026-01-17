import { describe, it, expect } from "vitest";
import { buildPromptPack, withCorrectionSection } from "../src/control-plane/prompt_pack";

const basePacket = {
  packetType: "chat",
  threadId: "thread-pack-001",
  message: "Hello",
};

const baseModeDecision = {
  modeLabel: "Ida",
  domainFlags: [],
  confidence: 0.5,
  checkpointNeeded: false,
  reasons: [],
  version: "v0",
};

describe("PromptPack correction section", () => {
  it("should insert correction section after law", () => {
    const pack = buildPromptPack({
      packet: basePacket,
      modeDecision: baseModeDecision,
      retrievalItems: [],
    });

    const updated = withCorrectionSection(pack, "Fix the output.");
    const ids = updated.sections.map((s) => s.id);
    expect(ids).toEqual(["law", "correction", "retrieval", "evidence_pack", "user_message"]);
  });

  it("should return original pack when correction text is empty", () => {
    const pack = buildPromptPack({
      packet: basePacket,
      modeDecision: baseModeDecision,
      retrievalItems: [],
    });

    const updated = withCorrectionSection(pack, "   ");
    expect(updated.sections.map((s) => s.id)).toEqual(pack.sections.map((s) => s.id));
  });
});
