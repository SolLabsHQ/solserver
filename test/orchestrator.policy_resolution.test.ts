import { describe, it, expect } from "vitest";

import { resolveNotificationPolicy } from "../src/control-plane/orchestrator";

describe("resolveNotificationPolicy", () => {
  it("defaults to silent for worker", () => {
    const policy = resolveNotificationPolicy({
      source: "worker",
      simulate: false,
      requestedPolicy: undefined,
      personaLabel: "ida",
      safetyIsUrgent: false,
    });

    expect(policy).toBe("silent");
  });

  it("defaults to alert for api", () => {
    const policy = resolveNotificationPolicy({
      source: "api",
      simulate: false,
      requestedPolicy: undefined,
      personaLabel: "ida",
      safetyIsUrgent: false,
    });

    expect(policy).toBe("alert");
  });

  it("defaults to silent when simulate is true", () => {
    const policy = resolveNotificationPolicy({
      source: "api",
      simulate: true,
      requestedPolicy: undefined,
      personaLabel: "ida",
      safetyIsUrgent: false,
    });

    expect(policy).toBe("silent");
  });

  it("escalates to urgent when safety is flagged", () => {
    const policy = resolveNotificationPolicy({
      source: "api",
      simulate: false,
      requestedPolicy: "silent",
      personaLabel: "ida",
      safetyIsUrgent: true,
    });

    expect(policy).toBe("urgent");
  });
});
