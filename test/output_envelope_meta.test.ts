import { describe, it, expect } from "vitest";

import { buildOutputEnvelopeMeta } from "../src/control-plane/orchestrator";
import type { OutputEnvelope } from "../src/contracts/output_envelope";

describe("buildOutputEnvelopeMeta", () => {
  it("injects persona_label and notification_policy", () => {
    const envelope: OutputEnvelope = {
      assistant_text: "Hello",
    };

    const result = buildOutputEnvelopeMeta({
      envelope,
      personaLabel: "ida",
      notificationPolicy: "muted",
    });

    expect(result.meta?.persona_label).toBe("ida");
    expect(result.meta?.notification_policy).toBe("muted");
    expect(result.notification_policy).toBe("muted");
  });
});
