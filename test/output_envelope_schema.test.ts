import { describe, it, expect } from "vitest";
import { OutputEnvelopeSchema } from "../src/contracts/output_envelope";

describe("OutputEnvelopeSchema strictness", () => {
  it("rejects unknown top-level fields", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      extra_field: "nope",
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid claim types", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        claims: [{ claim_id: "c1", claim_text: "x", evidence_refs: "bad" }],
      },
    });

    expect(result.success).toBe(false);
  });
});
