import { describe, it, expect } from "vitest";
import { postOutputLinter } from "../src/gates/post_linter";
import type { AssembledDriverBlock } from "../src/control-plane/driver_blocks";

const baseModeDecision = {
  modeLabel: "Ida",
  personaLabel: "ida",
  domainFlags: [],
  confidence: 0.7,
  checkpointNeeded: false,
  reasons: ["test"],
  version: "mode-engine-v0",
};

function makeBlock(definition: string, id: string = "DB-TEST"): AssembledDriverBlock {
  return {
    id,
    version: "1.0",
    definition,
    source: "system_baseline",
    order: 0,
  };
}

describe("postOutputLinter", () => {
  it("ignores unquoted validators", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-not: I sent the email`);
    const result = postOutputLinter({
      modeDecision: baseModeDecision,
      content: "I sent the email",
      driverBlocks: [block],
      enforcementMode: "strict",
    });

    expect(result.ok).toBe(true);
  });

  it("enforces quoted must-not with slash expansion", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-not: "I sent/added/checked"`);
    const result = postOutputLinter({
      modeDecision: baseModeDecision,
      content: "I added the file",
      driverBlocks: [block],
      enforcementMode: "strict",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].pattern).toBe("I added");
      expect(result.violations[0].rule).toBe("must-not");
    }
  });

  it("enforces must-have with quoted pattern", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-have: "Receipt:"`);
    const result = postOutputLinter({
      modeDecision: baseModeDecision,
      content: "No receipt here",
      driverBlocks: [block],
      enforcementMode: "strict",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].pattern).toBe("Receipt:");
      expect(result.violations[0].rule).toBe("must-have");
    }
  });

  it("treats quoted Must lines as enforceable", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must: "Next:"`);
    const result = postOutputLinter({
      modeDecision: baseModeDecision,
      content: "No next section",
      driverBlocks: [block],
      enforcementMode: "strict",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].pattern).toBe("Next:");
      expect(result.violations[0].rule).toBe("must-have");
    }
  });

  it("treats DB-003 as warning for Ida without high-rigor flags", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-have: "Receipt:"`, "DB-003");
    const result = postOutputLinter({
      modeDecision: baseModeDecision,
      content: "No receipt here",
      driverBlocks: [block],
      enforcementMode: "strict",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.length).toBe(1);
      expect(result.warnings?.[0].blockId).toBe("DB-003");
    }
  });

  it("enforces DB-003 in high-rigor mode", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-have: "Receipt:"`, "DB-003");
    const result = postOutputLinter({
      modeDecision: {
        ...baseModeDecision,
        domainFlags: ["finance"],
      },
      content: "No receipt here",
      driverBlocks: [block],
      enforcementMode: "strict",
    });

    expect(result.ok).toBe(false);
  });

  it("downgrades violations to warnings in warn mode", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-not: "I sent"`, "DB-001");
    const result = postOutputLinter({
      modeDecision: baseModeDecision,
      content: "I sent the email",
      driverBlocks: [block],
      enforcementMode: "warn",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.length).toBe(1);
      expect(result.warnings?.[0].blockId).toBe("DB-001");
    }
  });
});
