import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import { assembleDriverBlocks, DRIVER_BLOCK_BOUNDS } from "../src/control-plane/driver_blocks";
import type { PacketInput } from "../src/contracts/chat";

describe("Driver Blocks (v0)", () => {
  let app: any;
  let store: MemoryControlPlaneStore;

  beforeAll(async () => {
    store = new MemoryControlPlaneStore();
    app = Fastify({ logger: false });
    app.register(cors, { origin: true });
    app.register(chatRoutes, { prefix: "/v1", store });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Schema Validation", () => {
    it("should accept valid driverBlockRefs", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-db-001",
          message: "Test message",
          driverBlockRefs: [
            { id: "DB-001", version: "1.0" },
            { id: "DB-002", version: "1.0" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("should accept valid driverBlockInline", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-db-002",
          message: "Test message",
          driverBlockInline: [
            {
              id: "user-block-001",
              version: "1",
              title: "Custom Block",
              scope: "thread",
              definition: "Custom policy text",
              source: "user_created",
              approvedAt: "2026-01-11T00:00:00Z",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("should reject driverBlockInline with invalid scope", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-db-003",
          message: "Test message",
          driverBlockInline: [
            {
              id: "user-block-001",
              version: "1",
              title: "Custom Block",
              scope: "invalid", // Invalid scope
              definition: "Custom policy text",
              source: "user_created",
              approvedAt: "2026-01-11T00:00:00Z",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("Bounds Enforcement", () => {
    it("should drop excess driverBlockRefs beyond MAX_REFS", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-bounds-001",
        message: "Test",
        // Use valid system block IDs (DB-001 to DB-005) repeated to exceed MAX_REFS (10)
        driverBlockRefs: Array.from({ length: 15 }, (_, i) => ({
          id: `DB-00${(i % 5) + 1}`, // Cycles through DB-001 to DB-005
          version: "1.0",
        })),
      };

      const result = assembleDriverBlocks(packet);

      // Should accept only MAX_REFS (10)
      const systemBlocks = result.accepted.filter((b) => b.source === "system_ref");
      expect(systemBlocks.length).toBeLessThanOrEqual(DRIVER_BLOCK_BOUNDS.MAX_REFS);

      // Should drop excess (5 refs beyond MAX_REFS)
      expect(result.dropped.length).toBe(5);
      expect(result.dropped.some((d) => d.reason.includes("MAX_REFS"))).toBe(true);
    });

    it("should drop excess driverBlockInline beyond MAX_INLINE", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-bounds-002",
        message: "Test",
        driverBlockInline: Array.from({ length: 10 }, (_, i) => ({
          id: `user-block-${i + 1}`,
          version: "1",
          title: `Block ${i + 1}`,
          scope: "thread" as const,
          definition: "Custom policy",
          source: "user_created" as const,
          approvedAt: "2026-01-11T00:00:00Z",
        })),
      };

      const result = assembleDriverBlocks(packet);

      // Should accept only MAX_INLINE (3)
      const userBlocks = result.accepted.filter((b) => b.source === "user_inline");
      expect(userBlocks.length).toBeLessThanOrEqual(DRIVER_BLOCK_BOUNDS.MAX_INLINE);

      // Should drop excess
      expect(result.dropped.length).toBeGreaterThan(0);
      expect(result.dropped.some((d) => d.reason.includes("MAX_INLINE"))).toBe(true);
    });

    it("should trim oversized definitions", () => {
      const oversizedDefinition = "x".repeat(5000); // Exceeds MAX_DEFINITION_BYTES (4096)

      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-bounds-003",
        message: "Test",
        driverBlockInline: [
          {
            id: "user-block-oversized",
            version: "1",
            title: "Oversized Block",
            scope: "thread",
            definition: oversizedDefinition,
            source: "user_created",
            approvedAt: "2026-01-11T00:00:00Z",
          },
        ],
      };

      const result = assembleDriverBlocks(packet);

      // Should trim the definition
      expect(result.trimmed.length).toBe(1);
      expect(result.trimmed[0].originalLength).toBe(5000);
      expect(result.trimmed[0].trimmedLength).toBe(DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_BYTES);

      // Should accept the trimmed block
      const userBlock = result.accepted.find((b) => b.id === "user-block-oversized");
      expect(userBlock).toBeDefined();
      expect(userBlock?.definition.length).toBe(DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_BYTES);
    });

    it("should keep non-baseline blocks within MAX_TOTAL_BLOCKS", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-bounds-004",
        message: "Test",
        driverBlockRefs: Array.from({ length: 10 }, (_, i) => ({
          id: `DB-00${(i % 5) + 1}`, // Use valid system block IDs
          version: "1.0",
        })),
        driverBlockInline: Array.from({ length: 10 }, (_, i) => ({
          id: `user-block-${i + 1}`,
          version: "1",
          title: `Block ${i + 1}`,
          scope: "thread" as const,
          definition: "Custom policy",
          source: "user_created" as const,
          approvedAt: "2026-01-11T00:00:00Z",
        })),
      };

      const result = assembleDriverBlocks(packet);

      // Non-baseline accepted should not exceed MAX_TOTAL_BLOCKS (15)
      const nonBaselineAccepted = result.accepted.filter((b) => b.source !== "system_baseline");
      expect(nonBaselineAccepted.length).toBeLessThanOrEqual(DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS);

      // Excess inline blocks should be dropped by MAX_INLINE enforcement
      expect(result.dropped.some((d) => d.reason.includes("MAX_INLINE"))).toBe(true);
    });
  });

  describe("Ordering Enforcement", () => {
    it("should apply system refs before user inline blocks", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-order-001",
        message: "Test",
        driverBlockRefs: [
          { id: "DB-001", version: "1.0" },
          { id: "DB-002", version: "1.0" },
        ],
        driverBlockInline: [
          {
            id: "user-block-001",
            version: "1",
            title: "User Block",
            scope: "thread",
            definition: "User policy",
            source: "user_created",
            approvedAt: "2026-01-11T00:00:00Z",
          },
        ],
      };

      const result = assembleDriverBlocks(packet);

      // System blocks should come first
      const systemBlocks = result.accepted.filter((b) => b.source === "system_ref");
      const userBlocks = result.accepted.filter((b) => b.source === "user_inline");

      expect(systemBlocks.length).toBe(2);
      expect(userBlocks.length).toBe(1);

      // Check ordering
      const systemMaxOrder = Math.max(...systemBlocks.map((b) => b.order));
      const userMinOrder = Math.min(...userBlocks.map((b) => b.order));

      expect(systemMaxOrder).toBeLessThan(userMinOrder);
    });

    it("should maintain strict order within each category", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-order-002",
        message: "Test",
        driverBlockRefs: [
          { id: "DB-001", version: "1.0" },
          { id: "DB-002", version: "1.0" },
          { id: "DB-003", version: "1.0" },
        ],
      };

      const result = assembleDriverBlocks(packet);

      // Orders should be sequential
      const orders = result.accepted.map((b) => b.order);
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i]).toBe(orders[i - 1] + 1);
      }
    });
  });

  describe("Trace Events", () => {
    it("should emit trace event when blocks are dropped", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-trace-001",
          message: "Test",
          traceConfig: { level: "debug" },
          driverBlockInline: Array.from({ length: 10 }, (_, i) => ({
            id: `user-block-${i + 1}`,
            version: "1",
            title: `Block ${i + 1}`,
            scope: "thread",
            definition: "Custom policy",
            source: "user_created",
            approvedAt: "2026-01-11T00:00:00Z",
            threadId: "thread-trace-001",
          })),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should have trace events
      expect(body.trace.events).toBeDefined();
      expect(body.driverBlocks.droppedCount).toBeGreaterThan(0);
      expect(body.driverBlocks.trimmedCount).toBeGreaterThanOrEqual(0);

      // Should have a warning event for dropped blocks
      const warningEvent = body.trace.events.find(
        (e: any) => e.status === "warning" && e.summary.includes("Driver Blocks enforcement")
      );
      expect(warningEvent).toBeDefined();
      expect(warningEvent.metadata.dropped.length).toBeGreaterThan(0);
    });

    it("should retry with correction and return 200 on attempt 1", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: {
          "x-sol-test-output-attempt-0": "I sent the email for you.",
          "x-sol-test-output-attempt-1": "shape\nReceipt: Acknowledged.\nRelease: You are not required to take external actions.\nNext: Tell me if you want a draft or steps.\nAssumption: No external actions were taken.\nHere is a draft email you can send.",
        },
        payload: {
          packetType: "chat",
          threadId: "thread-trace-lint-001",
          message: "Test",
          traceConfig: { level: "debug" },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.assistant).toBe("shape\nReceipt: Acknowledged.\nRelease: You are not required to take external actions.\nNext: Tell me if you want a draft or steps.\nAssumption: No external actions were taken.\nHere is a draft email you can send.");
      expect(body.outputEnvelope).toBeDefined();
      expect(body.outputEnvelope.assistant_text).toBe(body.assistant);

      const attempt0Warning = body.trace.events.find(
        (e: any) => e.phase === "output_gates" && e.status === "warning" && e.metadata?.kind === "post_linter" && e.metadata?.attempt === 0
      );
      expect(attempt0Warning).toBeDefined();
      expect(attempt0Warning.metadata.violationsCount).toBeGreaterThan(0);
      expect(attempt0Warning.metadata.blockIds).toContain("DB-001");

      const attempt0Envelope = body.trace.events.find(
        (e: any) => e.phase === "output_gates" && e.metadata?.kind === "output_envelope" && e.metadata?.attempt === 0
      );
      expect(attempt0Envelope).toBeDefined();
      expect(attempt0Envelope.metadata.ok).toBe(true);

      const attempt1Completed = body.trace.events.find(
        (e: any) => e.phase === "output_gates" && e.status === "completed" && e.metadata?.kind === "post_linter" && e.metadata?.attempt === 1
      );
      expect(attempt1Completed).toBeDefined();

      const attempt1Envelope = body.trace.events.find(
        (e: any) => e.phase === "output_gates" && e.metadata?.kind === "output_envelope" && e.metadata?.attempt === 1
      );
      expect(attempt1Envelope).toBeDefined();
      expect(attempt1Envelope.metadata.ok).toBe(true);
    });

    it("should fail closed after attempt 1 violation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: {
          "x-sol-test-output-attempt-0": "I sent the email for you.",
          "x-sol-test-output-attempt-1": "I sent the email for you.",
        },
        payload: {
          packetType: "chat",
          threadId: "thread-trace-lint-002",
          message: "Test",
          traceConfig: { level: "debug" },
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("driver_block_enforcement_failed");
      expect(body.retryable).toBe(false);
      expect(body.assistant).toContain("I can't claim to have performed external actions");
      expect(body.outputEnvelope).toBeUndefined();

      const traceRunId = response.headers["x-sol-trace-run-id"] as string | undefined;
      expect(traceRunId).toBeDefined();
      const traceEvents = await store.getTraceEvents(traceRunId!, { limit: 200 });
      const enforcementEvent = traceEvents.find(
        (e) => e.phase === "output_gates" && e.status === "failed" && e.metadata?.kind === "driver_block_enforcement"
      );
      expect(enforcementEvent).toBeDefined();
    });

    it("should not emit trace event when no enforcement violations", async () => {
      // This test verifies that when all blocks are within bounds,
      // no warning trace event is emitted
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-trace-002",
          message: "Test",
          traceConfig: { level: "debug" },
          driverBlockInline: [
            {
              id: "user-block-normal",
              version: "1",
              title: "Normal Block",
              scope: "thread",
              definition: "Normal policy text within bounds",
              source: "user_created",
              approvedAt: "2026-01-11T00:00:00Z",
              threadId: "thread-trace-002",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should NOT have a warning event when no violations
      const warningEvents = body.trace.events.filter(
        (e: any) => e.status === "warning" && e.summary.includes("Driver Blocks enforcement")
      );
      expect(warningEvents.length).toBe(0);
    });

    it("should include driver block counts in compose_request trace event", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-e2e-001",
          message: "Test",
          traceConfig: { level: "debug" },
          driverBlockRefs: [
            { id: "DB-001", version: "1.0" },
            { id: "DB-002", version: "1.0" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Find the compose_request completed event
      const composeEvent = body.trace.events.find(
        (e: any) => e.phase === "compose_request" && e.status === "completed"
      );
      expect(composeEvent).toBeDefined();
      expect(composeEvent.metadata.driverBlocksAccepted).toBeDefined();
      expect(composeEvent.metadata.driverBlocksDropped).toBeDefined();
      expect(composeEvent.metadata.driverBlocksTrimmed).toBeDefined();
    });
  });

  describe("Strictness", () => {
    it("should reject unknown keys with bounded error response", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-strict-001",
          message: "Test",
          driverBlockMode: "custom",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("invalid_request");
      expect(body.message).toBe("Unrecognized keys in request");
      expect(body.unrecognizedKeys).toContain("driverBlockMode");
    });
  });

  describe("Baseline-Always Behavior", () => {
    it("should always include baseline blocks even when packet provides no refs/inline", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-baseline-001",
        message: "Test",
        // No driverBlockRefs or driverBlockInline
      };

      const result = assembleDriverBlocks(packet);

      // Should have 5 baseline blocks (DB-001 through DB-005)
      expect(result.accepted.length).toBe(5);
      expect(result.accepted.every(b => b.source === "system_baseline")).toBe(true);
      expect(result.accepted[0].id).toBe("DB-001");
      expect(result.accepted[1].id).toBe("DB-002");
      expect(result.accepted[2].id).toBe("DB-003");
      expect(result.accepted[3].id).toBe("DB-004");
      expect(result.accepted[4].id).toBe("DB-005");
      expect(result.dropped.length).toBe(0);
    });

    it("should accept client blocks when provided (additive to baseline)", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-additive-001",
        message: "Test",
        driverBlockRefs: [{ id: "DB-001", version: "1.0" }],
        driverBlockInline: [
          {
            id: "user-block-001",
            version: "1",
            title: "Custom Block",
            scope: "thread",
            definition: "Custom policy",
            source: "user_created",
            approvedAt: "2026-01-11T00:00:00Z",
          },
        ],
      };

      const result = assembleDriverBlocks(packet);

      // Should have: 5 baseline + 1 ref + 1 inline = 7 total
      expect(result.accepted.length).toBe(7);
      
      // First 5 should be baseline
      expect(result.accepted.slice(0, 5).every(b => b.source === "system_baseline")).toBe(true);
      
      // Then system ref
      expect(result.accepted[5].source).toBe("system_ref");
      expect(result.accepted[5].id).toBe("DB-001");
      
      // Then user inline (LAST)
      expect(result.accepted[6].source).toBe("user_inline");
      expect(result.accepted[6].id).toBe("user-block-001");

      // Should not drop any blocks
      expect(result.dropped.length).toBe(0);
    });

    it("should maintain strict ordering (baseline → refs → inline)", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-ordering-001",
        message: "Test",
        driverBlockRefs: [
          { id: "DB-001", version: "1.0" },
          { id: "DB-002", version: "1.0" },
        ],
        driverBlockInline: [
          {
            id: "user-block-001",
            version: "1",
            title: "Custom Block",
            scope: "thread",
            definition: "Custom policy",
            source: "user_created",
            approvedAt: "2026-01-11T00:00:00Z",
          },
        ],
      };

      const result = assembleDriverBlocks(packet);

      // Should have: 5 baseline + 2 refs + 1 inline = 8 total
      expect(result.accepted.length).toBe(8);

      // First 5 should be baseline (system_baseline)
      expect(result.accepted.slice(0, 5).every(b => b.source === "system_baseline")).toBe(true);

      // Next 2 should be system refs
      expect(result.accepted[5].source).toBe("system_ref");
      expect(result.accepted[5].id).toBe("DB-001");
      expect(result.accepted[6].source).toBe("system_ref");
      expect(result.accepted[6].id).toBe("DB-002");

      // User inline should come last
      expect(result.accepted[7].source).toBe("user_inline");
      expect(result.accepted[7].id).toBe("user-block-001");

      // Order field should be sequential
      expect(result.accepted[0].order).toBe(0);
      expect(result.accepted[1].order).toBe(1);
      expect(result.accepted[7].order).toBe(7);
    });

    it("should never drop baseline blocks even when limits exceeded", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-enforcement-001",
        message: "Test",
        // Send 15 refs (exceeds MAX_REFS=10)
        driverBlockRefs: Array.from({ length: 15 }, (_, i) => ({
          id: `DB-${String(i + 1).padStart(3, "0")}`,
          version: "1.0",
        })),
      // Send 10 inline blocks (exceeds MAX_INLINE=3)
        driverBlockInline: Array.from({ length: 10 }, (_, i) => ({
          id: `user-block-${String(i + 1).padStart(3, "0")}`,
          version: "1",
          title: `User Block ${i + 1}`,
          scope: "thread" as const,
          definition: `User policy ${i + 1}`,
          source: "user_created" as const,
          approvedAt: "2026-01-11T00:00:00Z",
        })),
      };

      const result = assembleDriverBlocks(packet);

      // Baseline blocks (5) should always be present
      const baselineBlocks = result.accepted.filter(b => b.source === "system_baseline");
      expect(baselineBlocks.length).toBe(5);

      // User inline blocks should be dropped first (3 kept, 7 dropped)
      expect(result.dropped.some(d => d.id.startsWith("user-block"))).toBe(true);

      // Excess refs should also be dropped (10 kept, 5 dropped)
      expect(result.dropped.some(d => d.id.startsWith("DB-"))).toBe(true);

      // But NO baseline blocks should ever be in the dropped list
      expect(result.dropped.some(d => ["DB-001", "DB-002", "DB-003", "DB-004", "DB-005"].includes(d.id))).toBe(false);
    });

    it("should not count baseline blocks toward MAX_TOTAL_BLOCKS", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-baseline-total-001",
        message: "Test",
        driverBlockRefs: Array.from({ length: 10 }, (_, i) => ({
          id: `DB-00${(i % 5) + 1}`,
          version: "1.0",
        })),
        driverBlockInline: Array.from({ length: 3 }, (_, i) => ({
          id: `user-block-${i + 1}`,
          version: "1",
          title: `Block ${i + 1}`,
          scope: "thread" as const,
          definition: "Custom policy",
          source: "user_created" as const,
          approvedAt: "2026-01-11T00:00:00Z",
        })),
      };

      const result = assembleDriverBlocks(packet);

      // 5 baseline + 10 refs + 3 inline = 18 total accepted
      expect(result.accepted.length).toBe(18);
      expect(result.dropped.length).toBe(0);
    });
  });

  describe("End-to-End Smoke Test", () => {
    it("should process /v1/chat with driver blocks successfully", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-e2e-001",
          clientRequestId: "req-e2e-001",
          message: "Help me make a decision",
          driverBlockRefs: [
            { id: "DB-001", version: "1.0" }, // NoAuthorityDrift
            { id: "DB-003", version: "1.0" }, // DecisionClosure
          ],
          driverBlockInline: [
            {
              id: "user-block-001",
              version: "1",
              title: "Decision Framework",
              scope: "thread",
              definition: "When evaluating decisions, consider: 1) Impact, 2) Reversibility, 3) Timeline",
              source: "user_created",
              approvedAt: "2026-01-11T00:00:00Z",
              threadId: "thread-e2e-001",
            },
          ],
          traceConfig: { level: "info" },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Verify response structure
      expect(body.transmissionId).toBeDefined();
      expect(body.assistant).toBeDefined();
      expect(body.driverBlocks.acceptedCount).toBeGreaterThan(0);
      expect(body.trace).toBeDefined();
      expect(body.trace.traceRunId).toBeDefined();

      // Verify transmission was created
      const transmission = await store.getTransmission(body.transmissionId);
      expect(transmission).not.toBeNull();
      expect(transmission?.threadId).toBe("thread-e2e-001");

      // Verify trace run was created
      const traceRun = await store.getTraceRun(body.trace.traceRunId);
      expect(traceRun).not.toBeNull();

      // Verify trace events were created
      const traceEvents = await store.getTraceEvents(body.trace.traceRunId);
      expect(traceEvents.length).toBeGreaterThan(0);

      // Verify compose_request phase exists
      const composeEvent = traceEvents.find((e) => e.phase === "compose_request");
      expect(composeEvent).toBeDefined();
    });

    it("should handle driver blocks with no enforcement violations", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-e2e-002",
          message: "Simple request",
          driverBlockRefs: [{ id: "DB-001", version: "1.0" }],
          traceConfig: { level: "debug" },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should not have warning events if no violations
      const warningEvents = body.trace.events.filter(
        (e: any) => e.status === "warning" && e.summary.includes("Driver Blocks enforcement")
      );
      expect(warningEvents.length).toBe(0);
    });
  });
});
