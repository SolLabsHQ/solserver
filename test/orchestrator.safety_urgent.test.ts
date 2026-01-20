import { describe, expect, it, vi } from "vitest";

import { resolveSafetyIsUrgent } from "../src/control-plane/orchestrator";
import { GATE_SENTINEL, type GateOutput } from "../src/gates/gate_interfaces";

describe("resolveSafetyIsUrgent", () => {
  it("blocks non-safety gates from setting is_urgent", () => {
    const warn = vi.fn();
    const results: GateOutput[] = [
      {
        gateName: "lattice",
        status: "pass",
        summary: "intent ok",
        is_urgent: true,
      },
    ];

    const urgent = resolveSafetyIsUrgent({ results, log: { warn } });

    expect(urgent).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts safety gate as the urgent signal source", () => {
    const warn = vi.fn();
    const results: GateOutput[] = [
      {
        gateName: GATE_SENTINEL,
        status: "fail",
        summary: "sentinel escalation",
        is_urgent: true,
      },
    ];

    const urgent = resolveSafetyIsUrgent({ results, log: { warn } });

    expect(urgent).toBe(true);
    expect(warn).toHaveBeenCalledTimes(0);
  });
});
