import { describe, it, expect } from "vitest";
import { buildPromptPack, withCorrectionSection } from "../src/control-plane/prompt_pack";

const basePacket = {
  packetType: "chat",
  threadId: "thread-pack-001",
  message: "Hello",
};

const baseModeDecision = {
  modeLabel: "Ida",
  personaLabel: "ida",
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

describe("PromptPack evidence guidance", () => {
  it("includes evidence claims guidance and budgets in the law section", () => {
    const pack = buildPromptPack({
      packet: basePacket,
      modeDecision: baseModeDecision,
      retrievalItems: [],
    });

    const law = pack.sections.find((s) => s.id === "law")?.content ?? "";
    expect(law).toContain("Return ONLY a JSON object matching OutputEnvelope.");
    expect(law).toContain("meta.shape (optional but preferred): provide arc/active/parked/decisions/next.");
    expect(law).toContain("meta.affect_signal (required): single-message affect for the CURRENT user message only");
    expect(law).toContain("meta.affect_signal.label must be one of");
    expect(law).toContain("If an EvidencePack is provided, include meta.claims[]");
    expect(law).toContain("If no EvidencePack is provided, omit meta.claims.");
    expect(law).toContain("Budgets: max claims=8, max refs/claim=4, max total refs=20.");
  });
});
