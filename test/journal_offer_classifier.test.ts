import { describe, it, expect } from "vitest";

import { classifyJournalOffer } from "../src/memory/journal_offer_classifier";

const span = { startMessageId: "m1", endMessageId: "m2" };

describe("JournalOfferClassifier v0", () => {
  it("suppresses offers when risk is elevated", () => {
    const offer = classifyJournalOffer({
      mood: { label: "insight", intensity: 0.9, confidence: "high" },
      risk: "med",
      phase: "settled",
      evidenceSpan: span,
    });
    expect(offer).toBeNull();
  });

  it("suppresses overwhelm when not settled", () => {
    const offer = classifyJournalOffer({
      mood: { label: "overwhelm", intensity: 0.8, confidence: "med" },
      risk: "low",
      phase: "rising",
      evidenceSpan: span,
    });
    expect(offer).toBeNull();
  });

  it("suppresses overwhelm when avoidPeakOverwhelm is true", () => {
    const offer = classifyJournalOffer({
      mood: { label: "overwhelm", intensity: 0.8, confidence: "med" },
      risk: "low",
      phase: "settled",
      avoidPeakOverwhelm: true,
      evidenceSpan: span,
    });
    expect(offer).toBeNull();
  });

  it("offers insight when intensity > 0.7", () => {
    const offer = classifyJournalOffer({
      mood: { label: "insight", intensity: 0.75, confidence: "high" },
      risk: "low",
      phase: "peak",
      evidenceSpan: span,
    });
    expect(offer?.momentType).toBe("insight");
    expect(offer?.confidence).toBe("high");
    expect(offer?.offerEligible).toBe(true);
  });

  it("offers gratitude only after downshift/settled", () => {
    const rising = classifyJournalOffer({
      mood: { label: "gratitude", intensity: 0.5, confidence: "med" },
      risk: "low",
      phase: "rising",
      evidenceSpan: span,
    });
    expect(rising).toBeNull();

    const settled = classifyJournalOffer({
      mood: { label: "gratitude", intensity: 0.5, confidence: "med" },
      risk: "low",
      phase: "settled",
      evidenceSpan: span,
    });
    expect(settled?.momentType).toBe("gratitude");
  });

  it("offers resolve only when settled", () => {
    const notYet = classifyJournalOffer({
      mood: { label: "resolve", intensity: 0.6, confidence: "med" },
      risk: "low",
      phase: "peak",
      evidenceSpan: span,
    });
    expect(notYet).toBeNull();

    const settled = classifyJournalOffer({
      mood: { label: "resolve", intensity: 0.6, confidence: "med" },
      risk: "low",
      phase: "settled",
      evidenceSpan: span,
    });
    expect(settled?.momentType).toBe("decision");
  });

  it("mutes curiosity", () => {
    const offer = classifyJournalOffer({
      mood: { label: "curiosity", intensity: 0.6, confidence: "med" },
      risk: "low",
      phase: "settled",
      evidenceSpan: span,
    });
    expect(offer).toBeNull();
  });
});
