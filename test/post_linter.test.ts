import { describe, it, expect } from "vitest";
import { postOutputLinter } from "../src/gates/post_linter";
import type { AssembledDriverBlock } from "../src/control-plane/driver_blocks";

function makeBlock(definition: string): AssembledDriverBlock {
  return {
    id: "DB-TEST",
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
      modeLabel: "Ida",
      content: "I sent the email",
      driverBlocks: [block],
    });

    expect(result.ok).toBe(true);
  });

  it("enforces quoted must-not with slash expansion", () => {
    const block = makeBlock(`Rules\nValidators:\n- Must-not: "I sent/added/checked"`);
    const result = postOutputLinter({
      modeLabel: "Ida",
      content: "I added the file",
      driverBlocks: [block],
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
      modeLabel: "Ida",
      content: "No receipt here",
      driverBlocks: [block],
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
      modeLabel: "Ida",
      content: "No next section",
      driverBlocks: [block],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].pattern).toBe("Next:");
      expect(result.violations[0].rule).toBe("must-have");
    }
  });
});
