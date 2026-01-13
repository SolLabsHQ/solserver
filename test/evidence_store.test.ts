import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";
import type { ControlPlaneStore } from "../src/store/control_plane_store";
import type { Evidence } from "../src/contracts/chat";

// Test suite that runs against both Memory and SQLite stores
function testEvidenceStore(storeName: string, createStore: () => ControlPlaneStore) {
  describe(`Evidence Store (${storeName})`, () => {
    let store: ControlPlaneStore;

    beforeEach(async () => {
      store = createStore();
      
      // Create a test transmission
      await store.createTransmission({
        packet: {
          threadId: "test-thread",
          message: "Test message",
        },
        modeDecision: {
          modeLabel: "chat",
          domainFlags: [],
          confidence: 1.0,
        },
      });
    });

    afterEach(() => {
      if (storeName === "SQLite" && "close" in store) {
        (store as SqliteControlPlaneStore).close();
      }
    });

    it("should save and retrieve evidence", async () => {
      const evidence: Evidence = {
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
        ],
        claims: [
          {
            claimId: "claim-1",
            claimText: "Test claim",
            supportIds: ["support-1"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };

      // Get transmission ID
      const transmissions = await store.createTransmission({
        packet: { threadId: "test-thread", message: "Test" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      await store.saveEvidence({
        transmissionId: transmissions.id,
        threadId: "test-thread",
        evidence,
      });

      const retrieved = await store.getEvidence({
        transmissionId: transmissions.id,
      });

      expect(retrieved).toBeDefined();
      expect(retrieved!.captures).toHaveLength(1);
      expect(retrieved!.captures![0].url).toBe("https://example.com");
      expect(retrieved!.supports).toHaveLength(1);
      expect(retrieved!.claims).toHaveLength(1);
    });

    it("should be idempotent (save twice, same result)", async () => {
      const evidence: Evidence = {
        captures: [
          {
            captureId: "capture-1",
            kind: "url",
            url: "https://example.com",
            capturedAt: "2026-01-01T00:00:00Z",
            source: "user_provided",
          },
        ],
      };

      const transmission = await store.createTransmission({
        packet: { threadId: "test-thread", message: "Test" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      // Save once
      await store.saveEvidence({
        transmissionId: transmission.id,
        threadId: "test-thread",
        evidence,
      });

      // Save again with different data
      const updatedEvidence: Evidence = {
        captures: [
          {
            captureId: "capture-2",
            kind: "url",
            url: "https://updated.com",
            capturedAt: "2026-01-02T00:00:00Z",
            source: "user_provided",
          },
        ],
      };

      await store.saveEvidence({
        transmissionId: transmission.id,
        threadId: "test-thread",
        evidence: updatedEvidence,
      });

      // Should have the updated evidence only
      const retrieved = await store.getEvidence({
        transmissionId: transmission.id,
      });

      expect(retrieved!.captures).toHaveLength(1);
      expect(retrieved!.captures![0].url).toBe("https://updated.com");
    });

    it("should return null for non-existent transmission", async () => {
      const retrieved = await store.getEvidence({
        transmissionId: "non-existent",
      });

      expect(retrieved).toBeNull();
    });

    it("should retrieve evidence by thread", async () => {
      const threadId = "test-thread-multi";

      // Create multiple transmissions with evidence
      const tx1 = await store.createTransmission({
        packet: { threadId, message: "Message 1" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      const tx2 = await store.createTransmission({
        packet: { threadId, message: "Message 2" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      await store.saveEvidence({
        transmissionId: tx1.id,
        threadId,
        evidence: {
          captures: [
            {
              captureId: "capture-1",
              kind: "url",
              url: "https://first.com",
              capturedAt: "2026-01-01T00:00:00Z",
              source: "user_provided",
            },
          ],
        },
      });

      await store.saveEvidence({
        transmissionId: tx2.id,
        threadId,
        evidence: {
          captures: [
            {
              captureId: "capture-2",
              kind: "url",
              url: "https://second.com",
              capturedAt: "2026-01-02T00:00:00Z",
              source: "user_provided",
            },
          ],
        },
      });

      const results = await store.getEvidenceByThread({
        threadId,
        limit: 10,
      });

      expect(results).toHaveLength(2);
      expect(results[0].evidence.captures![0].url).toBeDefined();
      expect(results[1].evidence.captures![0].url).toBeDefined();
    });

    it("should retrieve supports+claims only evidence by thread", async () => {
      const threadId = "test-thread-supports-only";

      const tx = await store.createTransmission({
        packet: { threadId, message: "Message with snippet only" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      await store.saveEvidence({
        transmissionId: tx.id,
        threadId,
        evidence: {
          supports: [
            {
              supportId: "support-1",
              type: "text_snippet",
              snippetText: "Snippet only evidence",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          claims: [
            {
              claimId: "claim-1",
              claimText: "Claim with snippet support",
              supportIds: ["support-1"],
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      });

      const results = await store.getEvidenceByThread({
        threadId,
        limit: 10,
      });

      const match = results.find((row) => row.transmissionId === tx.id);
      expect(match).toBeDefined();
      expect(match!.evidence.supports).toHaveLength(1);
      expect(match!.evidence.claims).toHaveLength(1);
    });

    it("should respect limit in getEvidenceByThread", async () => {
      const threadId = "test-thread-limit";

      // Create 3 transmissions
      for (let i = 0; i < 3; i++) {
        const tx = await store.createTransmission({
          packet: { threadId, message: `Message ${i}` },
          modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
        });

        await store.saveEvidence({
          transmissionId: tx.id,
          threadId,
          evidence: {
            captures: [
              {
                captureId: `capture-${i}`,
                kind: "url",
                url: `https://example${i}.com`,
                capturedAt: "2026-01-01T00:00:00Z",
                source: "user_provided",
              },
            ],
          },
        });
      }

      const results = await store.getEvidenceByThread({
        threadId,
        limit: 2,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should handle evidence with all types", async () => {
      const evidence: Evidence = {
        captures: [
          {
            captureId: "capture-1",
            kind: "url",
            url: "https://example.com",
            capturedAt: "2026-01-01T00:00:00Z",
            title: "Example Site",
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
            snippetText: "Some important text",
            snippetHash: "hash123",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        claims: [
          {
            claimId: "claim-1",
            claimText: "This is supported",
            supportIds: ["support-1", "support-2"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };

      const transmission = await store.createTransmission({
        packet: { threadId: "test-thread", message: "Test" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      await store.saveEvidence({
        transmissionId: transmission.id,
        threadId: "test-thread",
        evidence,
      });

      const retrieved = await store.getEvidence({
        transmissionId: transmission.id,
      });

      expect(retrieved!.captures![0].title).toBe("Example Site");
      expect(retrieved!.supports![0].type).toBe("url_capture");
      expect(retrieved!.supports![1].type).toBe("text_snippet");
      expect(retrieved!.supports![1].snippetText).toBe("Some important text");
      expect(retrieved!.claims![0].supportIds).toEqual(["support-1", "support-2"]);
    });

    it("should handle empty evidence arrays correctly", async () => {
      const evidence: Evidence = {
        captures: [],
        supports: [],
        claims: [],
      };

      const transmission = await store.createTransmission({
        packet: { threadId: "test-thread", message: "Test" },
        modeDecision: { modeLabel: "chat", domainFlags: [], confidence: 1.0 },
      });

      await store.saveEvidence({
        transmissionId: transmission.id,
        threadId: "test-thread",
        evidence,
      });

      const retrieved = await store.getEvidence({
        transmissionId: transmission.id,
      });

      // Empty arrays in Memory store are preserved, SQLite returns null
      if (storeName === "Memory") {
        expect(retrieved).toEqual({ captures: [], supports: [], claims: [] });
      } else {
        expect(retrieved).toBeNull();
      }
    });
  });
}

// Run tests for both stores
testEvidenceStore("Memory", () => new MemoryControlPlaneStore());
testEvidenceStore("SQLite", () => new SqliteControlPlaneStore(":memory:"));
