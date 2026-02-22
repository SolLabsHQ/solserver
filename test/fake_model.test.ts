import { describe, it, expect } from "vitest";
import { fakeModelReplyWithMeta } from "../src/providers/fake_model";
import type { EvidencePack } from "../src/evidence/evidence_provider";

describe("fakeModelReplyWithMeta", () => {
  it("includes evidence claims when evidence pack is provided", async () => {
    const evidencePack: EvidencePack = {
      packId: "pack-1",
      items: [
        {
          evidenceId: "ev-1",
          kind: "web_snippet",
          sourceUrl: "https://example.com",
          spans: [{ spanId: "sp-1", text: "Snippet" }],
        },
      ],
    };

    const result = await fakeModelReplyWithMeta({
      userText: "User message",
      modeLabel: "Sole",
      evidencePack,
    });

    const parsed = JSON.parse(result.rawText);
    expect(parsed.assistant_text).toBeTruthy();
    expect(parsed.meta?.claims).toHaveLength(1);
    expect(parsed.meta.claims[0].evidence_refs[0].evidence_id).toBe("ev-1");
    expect(parsed.meta.claims[0].evidence_refs[0].span_id).toBe("sp-1");
    expect(result.mementoDraft).toBeTruthy();
  });

  it("omits claims when no evidence pack is provided", async () => {
    const result = await fakeModelReplyWithMeta({
      userText: "User message",
      modeLabel: "Sole",
    });

    const parsed = JSON.parse(result.rawText);
    expect(parsed.assistant_text).toBeTruthy();
    expect(parsed.meta).toBeUndefined();
  });
});
