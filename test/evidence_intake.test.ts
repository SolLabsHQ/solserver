import { describe, it, expect } from "vitest";
import { runEvidenceIntake } from "../src/gates/evidence_intake";
import { EvidenceValidationError } from "../src/gates/evidence_validation_error";
import type { PacketInput } from "../src/contracts/chat";

describe("Evidence Intake Gate", () => {
  it("should create auto-captures from URLs in message", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "Check out https://example.com for more info",
    };

    const result = runEvidenceIntake(packet);

    expect(result.autoCaptures).toBe(1);
    expect(result.clientCaptures).toBe(0);
    expect(result.urlsDetected).toEqual(["https://example.com"]);
    expect(result.evidence.captures).toHaveLength(1);
    expect(result.evidence.captures![0].url).toBe("https://example.com");
    expect(result.evidence.captures![0].source).toBe("user_provided");
  });

  it("should merge client captures with auto-captures (client-authoritative)", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "Check out https://example.com and https://another.com",
      evidence: {
        captures: [
          {
            captureId: "client-capture-1",
            kind: "url",
            url: "https://example.com",
            capturedAt: "2026-01-01T00:00:00Z",
            title: "Example Site",
            source: "user_provided",
          },
        ],
      },
    };

    const result = runEvidenceIntake(packet);

    expect(result.autoCaptures).toBe(2); // Both URLs detected
    expect(result.clientCaptures).toBe(1);
    expect(result.evidence.captures).toHaveLength(2); // Client + auto for another.com
    
    // Client capture should be preserved with title
    const clientCapture = result.evidence.captures!.find(c => c.captureId === "client-capture-1");
    expect(clientCapture).toBeDefined();
    expect(clientCapture!.title).toBe("Example Site");
    
    // Auto-capture for another.com should be added
    const autoCapture = result.evidence.captures!.find(c => c.url === "https://another.com");
    expect(autoCapture).toBeDefined();
  });

  it("should not drop client captures when URL matches", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "https://example.com",
      evidence: {
        captures: [
          {
            captureId: "client-1",
            kind: "url",
            url: "https://example.com",
            capturedAt: "2026-01-01T00:00:00Z",
            title: "Client Title",
            source: "user_provided",
          },
        ],
      },
    };

    const result = runEvidenceIntake(packet);

    expect(result.evidence.captures).toHaveLength(1);
    expect(result.evidence.captures![0].captureId).toBe("client-1");
    expect(result.evidence.captures![0].title).toBe("Client Title");
  });

  it("should validate orphaned capture references in supports", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs here",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "url_capture",
            captureId: "non-existent-capture",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("orphaned_capture_reference");
      expect(validationError.details.supportId).toBe("support-1");
      expect(validationError.details.captureId).toBe("non-existent-capture");
    }
  });

  it("should validate orphaned support references in claims", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs here",
      evidence: {
        claims: [
          {
            claimId: "claim-1",
            claimText: "Some claim",
            supportIds: ["non-existent-support"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("orphaned_support_reference");
      expect(validationError.details.claimId).toBe("claim-1");
      expect(validationError.details.supportId).toBe("non-existent-support");
    }
  });

  it("should validate url_capture requires captureId", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs here",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "url_capture",
            // Missing captureId
            createdAt: "2026-01-01T00:00:00Z",
          } as any,
        ],
      },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("missing_required_field");
      expect(validationError.details.supportId).toBe("support-1");
    }
  });

  it("should validate text_snippet requires snippetText", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs here",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            // Missing snippetText
            createdAt: "2026-01-01T00:00:00Z",
          } as any,
        ],
      },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("missing_required_field");
      expect(validationError.details.supportId).toBe("support-1");
    }
  });

  it("should enforce max captures (25)", () => {
    const captures = Array.from({ length: 26 }, (_, i) => ({
      captureId: `capture-${i}`,
      kind: "url" as const,
      url: `https://example${i}.com`,
      capturedAt: "2026-01-01T00:00:00Z",
      source: "user_provided" as const,
    }));

    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs",
      evidence: { captures },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("capture_count_overflow");
      expect(validationError.details.count).toBe(26);
      expect(validationError.details.max).toBe(25);
    }
  });

  it("should enforce max supports (50)", () => {
    const supports = Array.from({ length: 51 }, (_, i) => ({
      supportId: `support-${i}`,
      type: "text_snippet" as const,
      snippetText: `Snippet ${i}`,
      createdAt: "2026-01-01T00:00:00Z",
    }));

    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs",
      evidence: { supports },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("support_count_overflow");
      expect(validationError.details.count).toBe(51);
      expect(validationError.details.max).toBe(50);
    }
  });

  it("should enforce max claims (50)", () => {
    const claims = Array.from({ length: 51 }, (_, i) => ({
      claimId: `claim-${i}`,
      claimText: `Claim ${i}`,
      supportIds: [],
      createdAt: "2026-01-01T00:00:00Z",
    }));

    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs",
      evidence: { claims },
    };

    expect(() => runEvidenceIntake(packet)).toThrow(EvidenceValidationError);
    
    try {
      runEvidenceIntake(packet);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("claim_count_overflow");
      expect(validationError.details.count).toBe(51);
      expect(validationError.details.max).toBe(50);
    }
  });

  it("should handle valid complete evidence graph", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "https://example.com",
      evidence: {
        captures: [
          {
            captureId: "capture-1",
            kind: "url",
            url: "https://example.com",
            capturedAt: "2026-01-01T00:00:00Z",
            source: "user_provided",
          },
        ],
        supports: [
          {
            supportId: "support-1",
            type: "url_capture",
            captureId: "capture-1",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            supportId: "support-2",
            type: "text_snippet",
            snippetText: "Some text",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        claims: [
          {
            claimId: "claim-1",
            claimText: "This is a claim",
            supportIds: ["support-1", "support-2"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    const result = runEvidenceIntake(packet);

    expect(result.evidence.captures).toHaveLength(1);
    expect(result.evidence.supports).toHaveLength(2);
    expect(result.evidence.claims).toHaveLength(1);
  });

  it("should handle empty evidence gracefully", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      message: "No URLs or evidence",
    };

    const result = runEvidenceIntake(packet);

    expect(result.autoCaptures).toBe(0);
    expect(result.clientCaptures).toBe(0);
    expect(result.urlsDetected).toEqual([]);
    expect(result.evidence.captures).toBeUndefined();
    expect(result.evidence.supports).toBeUndefined();
    expect(result.evidence.claims).toBeUndefined();
  });
});
