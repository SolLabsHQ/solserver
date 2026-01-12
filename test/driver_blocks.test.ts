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
        driverBlockMode: "custom",
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
        driverBlockMode: "custom",
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

      // Should accept only MAX_INLINE (5)
      const userBlocks = result.accepted.filter((b) => b.source === "user_inline");
      expect(userBlocks.length).toBeLessThanOrEqual(DRIVER_BLOCK_BOUNDS.MAX_INLINE);

      // Should drop excess
      expect(result.dropped.length).toBeGreaterThan(0);
      expect(result.dropped.some((d) => d.reason.includes("MAX_INLINE"))).toBe(true);
    });

    it("should trim oversized definitions", () => {
      const oversizedDefinition = "x".repeat(15000); // Exceeds MAX_DEFINITION_LENGTH (10,000)

      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-bounds-003",
        message: "Test",
        driverBlockMode: "custom",
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
      expect(result.trimmed[0].originalLength).toBe(15000);
      expect(result.trimmed[0].trimmedLength).toBe(DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_LENGTH);

      // Should accept the trimmed block
      const userBlock = result.accepted.find((b) => b.id === "user-block-oversized");
      expect(userBlock).toBeDefined();
      expect(userBlock?.definition.length).toBe(DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_LENGTH);
    });

    it("should enforce MAX_TOTAL_BLOCKS limit", () => {
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

      // Total accepted should not exceed MAX_TOTAL_BLOCKS (15)
      expect(result.accepted.length).toBeLessThanOrEqual(DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS);

      // Should drop excess blocks
      expect(result.dropped.length).toBeGreaterThan(0);
    });
  });

  describe("Ordering Enforcement", () => {
    it("should apply system refs before user inline blocks", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-order-001",
        message: "Test",
        driverBlockMode: "custom",
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
          driverBlockMode: "custom",
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

      // Should have a warning event for dropped blocks
      const warningEvent = body.trace.events.find(
        (e: any) => e.status === "warning" && e.summary.includes("Driver Blocks enforcement")
      );
      expect(warningEvent).toBeDefined();
      expect(warningEvent.metadata.dropped.length).toBeGreaterThan(0);
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
          threadId: "thread-trace-003",
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

  describe("driver_block_mode Enforcement", () => {
    it("should apply baseline only when mode=default", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-mode-001",
        message: "Test",
        driverBlockMode: "default",
        // These should be ignored
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

      // Should accept no blocks (baseline-only means no custom blocks)
      expect(result.accepted.length).toBe(0);

      // Should drop all custom blocks
      expect(result.dropped.length).toBe(2); // 1 ref + 1 inline

      // Should flag mismatch
      expect(result.mismatch).toBe(true);
      expect(result.mismatchDetails).toBeDefined();
      expect(result.mismatchDetails?.droppedRefsCount).toBe(1);
      expect(result.mismatchDetails?.droppedInlineCount).toBe(1);

      // Should have mismatch reason
      expect(result.dropped[0].reason).toContain('driver_block_mode="default"');
    });

    it("should apply baseline + custom when mode=custom", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-mode-002",
        message: "Test",
        driverBlockMode: "custom",
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

      // Should accept both system ref and user inline
      expect(result.accepted.length).toBe(2);
      expect(result.accepted[0].source).toBe("system_ref");
      expect(result.accepted[1].source).toBe("user_inline");

      // Should not flag mismatch
      expect(result.mismatch).toBe(false);
      expect(result.mismatchDetails).toBeUndefined();

      // Should not drop any blocks
      expect(result.dropped.length).toBe(0);
    });

    it("should default to mode=default when omitted", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-mode-003",
        message: "Test",
        // driverBlockMode omitted
        driverBlockRefs: [{ id: "DB-001", version: "1.0" }],
      };

      const result = assembleDriverBlocks(packet);

      // Should treat as mode="default" and drop custom blocks
      expect(result.mismatch).toBe(true);
      expect(result.dropped.length).toBe(1);
      expect(result.dropped[0].reason).toContain('driver_block_mode="default"');
    });

    it("should not flag mismatch when mode=default and no custom blocks", () => {
      const packet: PacketInput = {
        packetType: "chat",
        threadId: "thread-mode-004",
        message: "Test",
        driverBlockMode: "default",
        // No custom blocks
      };

      const result = assembleDriverBlocks(packet);

      // Should not flag mismatch
      expect(result.mismatch).toBe(false);
      expect(result.mismatchDetails).toBeUndefined();
      expect(result.dropped.length).toBe(0);
    });

    it("should emit trace event for driver_block_mode mismatch", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          packetType: "chat",
          threadId: "thread-mode-trace-001",
          message: "Test",
          traceConfig: { level: "debug" },
          driverBlockMode: "default",
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
              threadId: "thread-mode-trace-001",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should have a warning event for mismatch
      const mismatchEvent = body.trace.events.find(
        (e: any) => e.status === "warning" && e.summary.includes("Driver Blocks mismatch")
      );
      expect(mismatchEvent).toBeDefined();
      expect(mismatchEvent.metadata.mismatch).toBe(true);
      expect(mismatchEvent.metadata.mismatchDetails).toBeDefined();
      expect(mismatchEvent.metadata.mismatchDetails.droppedRefsCount).toBe(1);
      expect(mismatchEvent.metadata.mismatchDetails.droppedInlineCount).toBe(1);
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
          driverBlockMode: "custom",
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
