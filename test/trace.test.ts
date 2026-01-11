import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";

describe("Trace (v0)", () => {
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

  it("should always create a trace run for /v1/chat requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-1",
        message: "Test message for trace",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Trace is always present
    expect(body.trace).toBeDefined();
    expect(body.trace.traceRunId).toBeDefined();
    expect(body.trace.level).toBe("info"); // default level
    expect(body.trace.eventCount).toBe(0); // info level returns no events

    // Verify trace run was created in store
    const traceRun = await store.getTraceRun(body.trace.traceRunId);
    expect(traceRun).not.toBeNull();
    expect(traceRun?.transmissionId).toBe(body.transmissionId);
    expect(traceRun?.level).toBe("info");
  });

  it("should respect trace_config.level = debug and return events", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-2",
        message: "Test message for debug trace",
        traceConfig: {
          level: "debug",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Debug level should return events
    expect(body.trace.level).toBe("debug");
    expect(body.trace.events).toBeDefined();
    expect(Array.isArray(body.trace.events)).toBe(true);
    expect(body.trace.events.length).toBeGreaterThan(0);

    // Verify event structure
    const firstEvent = body.trace.events[0];
    expect(firstEvent.id).toBeDefined();
    expect(firstEvent.traceRunId).toBe(body.trace.traceRunId);
    expect(firstEvent.transmissionId).toBe(body.transmissionId);
    expect(firstEvent.ts).toBeDefined();
    expect(firstEvent.actor).toBeDefined();
    expect(firstEvent.phase).toBeDefined();
    expect(firstEvent.status).toBeDefined();
  });

  it("should not return events for info level (bounded response)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-3",
        message: "Test message for info trace",
        traceConfig: {
          level: "info",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Info level should NOT return events (bounded)
    expect(body.trace.level).toBe("info");
    expect(body.trace.events).toBeUndefined();
    expect(body.trace.eventCount).toBe(0); // eventCount is 0 when no events are returned
  });

  it("should generate trace events at key phases", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-4",
        message: "Test message for phase tracking",
        traceConfig: {
          level: "debug",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const events = body.trace.events;
    const phases = events.map((e: any) => e.phase);

    // Verify key phases are present
    expect(phases).toContain("policy_engine");
    expect(phases).toContain("enrichment_lattice");
    expect(phases).toContain("compose_request");
    expect(phases).toContain("model_call");
    expect(phases).toContain("output_gates");
  });

  it("should limit debug events to 50 (bounded)", async () => {
    // Generate a request that would create many events
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-5",
        message: "Test message for bounded events",
        traceConfig: {
          level: "debug",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Verify event count is bounded
    expect(body.trace.events.length).toBeLessThanOrEqual(50);
  });

  it("should include trace_run_id in response header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-6",
        message: "Test message for header check",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Verify header is set
    const headerValue = response.headers["x-sol-trace-run-id"];
    expect(headerValue).toBeDefined();
    expect(headerValue).toBe(body.trace.traceRunId);
  });

  it("should store trace events in ControlPlaneStore", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        packetType: "chat",
        threadId: "thread-trace-7",
        message: "Test message for store verification",
        traceConfig: {
          level: "debug",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Verify events are stored
    const storedEvents = await store.getTraceEvents(body.trace.traceRunId);
    expect(storedEvents.length).toBeGreaterThan(0);

    // Verify all events have required fields
    storedEvents.forEach((event) => {
      expect(event.id).toBeDefined();
      expect(event.traceRunId).toBe(body.trace.traceRunId);
      expect(event.transmissionId).toBe(body.transmissionId);
      expect(event.ts).toBeDefined();
      expect(event.actor).toBeDefined();
      expect(event.phase).toBeDefined();
      expect(event.status).toBeDefined();
    });
  });
});
