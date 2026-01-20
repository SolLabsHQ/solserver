import { describe, it, expect } from "vitest";

import { resolveModeDecision } from "../src/control-plane/orchestrator";
import type { PacketInput } from "../src/contracts/chat";

describe("resolveModeDecision", () => {
  it("bypasses routing when forced persona is provided", () => {
    const packet: PacketInput = {
      packetType: "chat",
      threadId: "t1",
      message: "hello",
    };

    const decision = resolveModeDecision(packet, "diogenes");

    expect(decision.personaLabel).toBe("diogenes");
    expect(decision.modeLabel).toBe("System-mode");
    expect(decision.reasons).toContain("forced_persona");
  });
});
