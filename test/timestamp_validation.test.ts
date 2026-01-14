import { describe, it, expect } from "vitest";
import { runEvidenceIntake } from "../src/gates/evidence_intake";
import { EvidenceValidationError } from "../src/gates/evidence_validation_error";
import type { PacketInput } from "../src/contracts/chat";

describe("Timestamp Validation (PR #7.1)", () => {
  it("should accept valid ISO-8601 timestamps for supports", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      packetType: "user",
      message: "Test message",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            snippetText: "Test snippet",
            createdAt: "2026-01-13T10:00:00Z",
          },
        ],
      },
    };

    const result = runEvidenceIntake(packet);
    expect(result.evidence.supports).toBeDefined();
    expect(result.evidence.supports?.length).toBe(1);
  });

  it("should accept valid ISO-8601 timestamps for claims", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      packetType: "user",
      message: "Test message",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            snippetText: "Test snippet",
            createdAt: "2026-01-13T10:00:00Z",
          },
        ],
        claims: [
          {
            claimId: "claim-1",
            claimText: "Test claim",
            supportIds: ["support-1"],
            createdAt: "2026-01-13T10:00:00Z",
          },
        ],
      },
    };

    const result = runEvidenceIntake(packet);
    expect(result.evidence.claims).toBeDefined();
    expect(result.evidence.claims?.length).toBe(1);
  });

  it("should reject supports with missing createdAt", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      packetType: "user",
      message: "Test message",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            snippetText: "Test snippet",
            // Missing createdAt
          } as any,
        ],
      },
    };

    try {
      runEvidenceIntake(packet);
      expect.fail("Should have thrown EvidenceValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("timestamp_missing");
      expect(validationError.details.supportId).toBe("support-1");
    }
  });

  it("should reject claims with missing createdAt", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      packetType: "user",
      message: "Test message",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            snippetText: "Test snippet",
            createdAt: "2026-01-13T10:00:00Z",
          },
        ],
        claims: [
          {
            claimId: "claim-1",
            claimText: "Test claim",
            supportIds: ["support-1"],
            // Missing createdAt
          } as any,
        ],
      },
    };

    try {
      runEvidenceIntake(packet);
      expect.fail("Should have thrown EvidenceValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("timestamp_missing");
      expect(validationError.details.claimId).toBe("claim-1");
    }
  });

  it("should reject supports with invalid timestamp format", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      packetType: "user",
      message: "Test message",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            snippetText: "Test snippet",
            createdAt: "not-a-timestamp",
          },
        ],
      },
    };

    try {
      runEvidenceIntake(packet);
      expect.fail("Should have thrown EvidenceValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("timestamp_invalid");
      expect(validationError.details.supportId).toBe("support-1");
    }
  });

  it("should reject claims with invalid timestamp format", () => {
    const packet: PacketInput = {
      threadId: "thread-1",
      packetType: "user",
      message: "Test message",
      evidence: {
        supports: [
          {
            supportId: "support-1",
            type: "text_snippet",
            snippetText: "Test snippet",
            createdAt: "2026-01-13T10:00:00Z",
          },
        ],
        claims: [
          {
            claimId: "claim-1",
            claimText: "Test claim",
            supportIds: ["support-1"],
            createdAt: "2026-01-13",  // Missing time component
          },
        ],
      },
    };

    try {
      runEvidenceIntake(packet);
      expect.fail("Should have thrown EvidenceValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      const validationError = error as EvidenceValidationError;
      expect(validationError.code).toBe("timestamp_invalid");
      expect(validationError.details.claimId).toBe("claim-1");
    }
  });

  it("should accept various valid ISO-8601 formats", () => {
    const validTimestamps = [
      "2026-01-13T10:00:00Z",
      "2026-01-13T10:00:00.000Z",
      "2026-01-13T10:00:00.123Z",
      "2026-01-13T10:00:00+00:00",
      "2026-01-13T10:00:00-05:00",
    ];

    for (const timestamp of validTimestamps) {
      const packet: PacketInput = {
        threadId: "thread-1",
        packetType: "user",
        message: "Test message",
        evidence: {
          supports: [
            {
              supportId: "support-1",
              type: "text_snippet",
              snippetText: "Test snippet",
              createdAt: timestamp,
            },
          ],
        },
      };

      const result = runEvidenceIntake(packet);
      expect(result.evidence.supports).toBeDefined();
      expect(result.evidence.supports?.length).toBe(1);
    }
  });
});
