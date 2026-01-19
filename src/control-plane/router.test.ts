import { describe, it, expect } from "vitest";
import { routeMode } from "./router";

describe("routeMode", () => {
  it("defaults to Ida", () => {
    const md = routeMode({
      packetType: "chat",
      threadId: "t1",
      message: "hello sol",
    });
    expect(md.modeLabel).toBe("Ida");
    expect(md.personaLabel).toBe("ida");
    expect(md.checkpointNeeded).toBe(false);
    expect(md.reasons).toContain("default");
  });

  it("routes high-rigor keywords to System-mode and requires checkpoint", () => {
    const md = routeMode({
      packetType: "chat",
      threadId: "t1",
      message: "I need architecture advice",
    });
    expect(md.modeLabel).toBe("System-mode");
    expect(md.personaLabel).toBe("cassandra");
    expect(md.domainFlags).toContain("high-rigor");
    expect(md.checkpointNeeded).toBe(true);
    expect(md.reasons).toContain("high_rigor_keyword");
  });

  it("routes reflective cues to Sole", () => {
    const md = routeMode({
      packetType: "chat",
      threadId: "t1",
      message: "I feel worried about family stuff",
    });
    expect(md.modeLabel).toBe("Sole");
    expect(md.personaLabel).toBe("sole");
    expect(md.domainFlags).toContain("relationship");
    expect(md.checkpointNeeded).toBe(false);
    expect(md.reasons).toContain("reflective_cues");
  });
});
