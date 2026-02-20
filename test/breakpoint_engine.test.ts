import { describe, it, expect } from "vitest";

import { decideBreakpointAction, shouldFreezeSummaryAtPeak } from "../src/control-plane/breakpoint_engine";

describe("BreakpointEngine", () => {
  it("returns MUST for decision/scope/pivot/answer signals", () => {
    const decision = decideBreakpointAction({
      message: "I decided to proceed.",
      signalKinds: ["decision_made"],
    });
    expect(decision).toBe("must");
  });

  it("returns SKIP for acknowledgement-only turns", () => {
    const decision = decideBreakpointAction({
      message: "ok thanks",
      signalKinds: ["ack_only"],
    });
    expect(decision).toBe("skip");
  });

  it("peak guardrail freezes summary unless decision is MUST", () => {
    expect(shouldFreezeSummaryAtPeak({
      phase: "peak",
      intensityBucket: "high",
      decision: "should",
    })).toBe(true);

    expect(shouldFreezeSummaryAtPeak({
      phase: "peak",
      intensityBucket: "high",
      decision: "must",
    })).toBe(false);
  });
});
