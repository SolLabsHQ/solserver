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

  it("accepts top-level notification_policy", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "ok",
      notification_policy: "muted",
    });

    expect(result.success).toBe(true);
  });

  it("accepts journal suggestion with suggested_date", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "journal_entry",
          title: "Reflection",
          suggested_date: "2026-01-17",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts calendar suggestion with suggested_start_at", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "calendar_event",
          title: "Team sync",
          suggested_start_at: "2026-01-21T14:00:00Z",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid suggestion_type", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          // @ts-expect-error invalid type
          suggestion_type: "note",
          title: "Bad",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects body over 1000 chars", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "reminder",
          title: "Too long",
          body: "a".repeat(1001),
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects suggested_date with wrong format", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "journal_entry",
          title: "Bad date",
          suggested_date: "01/17/2026",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects calendar_event without suggested_start_at", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "calendar_event",
          title: "Missing time",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects journal/reminder with suggested_start_at", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "reminder",
          title: "Wrong time",
          suggested_start_at: "2026-01-21T14:00:00Z",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects calendar_event with suggested_date", () => {
    const result = OutputEnvelopeSchema.safeParse({
      assistant_text: "shape:\n- Arc: ok\n- Active: ok\n- Parked: ok\n- Decisions: ok\n- Next: ok",
      meta: {
        capture_suggestion: {
          suggestion_type: "calendar_event",
          title: "Wrong date",
          suggested_date: "2026-01-17",
          suggested_start_at: "2026-01-21T14:00:00Z",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
