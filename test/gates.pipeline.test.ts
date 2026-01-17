import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { chatRoutes } from "../src/routes/chat";
import { runGatesPipeline } from "../src/gates/gates_pipeline";
import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";
import { unlinkSync } from "fs";

function makeApp(dbPath: string) {
  const app = Fastify({ logger: false });
  const store = new SqliteControlPlaneStore(dbPath);
  app.decorate("store", store);
  app.register(chatRoutes as any, { prefix: "/v1", store });
  return { app, store };
}

describe("Gates Pipeline", () => {
  it("should expose adapter results in order", () => {
    const output = runGatesPipeline({
      packetType: "chat",
      threadId: "thread-results-1",
      message: "hello world",
    } as any);

    expect(output.results).toHaveLength(3);
    expect(output.results.map((r) => r.gateName)).toEqual([
      "normalize_modality",
      "intent_risk",
      "lattice",
    ]);
  });


  let app: any;
  let store: SqliteControlPlaneStore;
  const testDbPath = "./data/test_gates_pipeline.db";

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      unlinkSync(testDbPath);
      unlinkSync(`${testDbPath}-wal`);
      unlinkSync(`${testDbPath}-shm`);
    } catch {}

    // Build app with test database
    const appSetup = makeApp(testDbPath);
    app = appSetup.app;
    store = appSetup.store;
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    // Clean up test database
    try {
      unlinkSync(testDbPath);
      unlinkSync(`${testDbPath}-wal`);
      unlinkSync(`${testDbPath}-shm`);
    } catch {}
  });

  it("should run gates in correct order: evidence_intake → normalize_modality → intent_risk → lattice", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-gates-order",
        message: "Please summarize this article about finance",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);

    // Fetch trace events from SQLite store
    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });

    // Find gate-related events
    const evidenceIntake = traceEvents.find(e => e.phase === "evidence_intake");
    const normalizeModality = traceEvents.find(e => e.phase === "gate_normalize_modality");
    const intentRisk = traceEvents.find(e => e.phase === "gate_intent_risk");
    const lattice = traceEvents.find(e => e.phase === "gate_lattice");

    // Verify all gates ran
    expect(evidenceIntake).toBeDefined();
    expect(normalizeModality).toBeDefined();
    expect(intentRisk).toBeDefined();
    expect(lattice).toBeDefined();

    const gatePhases = [
      "evidence_intake",
      "gate_normalize_modality",
      "gate_intent_risk",
      "gate_lattice",
    ];
    const ordered = traceEvents.filter((event) => gatePhases.includes(event.phase));
    const seqs = ordered.map((event) => event.metadata?.seq);
    expect(seqs.every((seq) => Number.isFinite(seq))).toBe(true);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // Ensure the filtered ordering matches the order in the full trace.
    const indices = ordered.map((event) => traceEvents.indexOf(event));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
    expect(ordered.map((event) => event.phase)).toEqual([
      "evidence_intake",
      "gate_normalize_modality",
      "gate_intent_risk",
      "gate_lattice",
    ]);
  });

  it("should force evidence provider on hello when requested", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-evidence-force",
        message: "hello",
        traceConfig: { level: "debug", forceEvidence: true },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.outputEnvelope?.meta?.claims?.length ?? 0).toBeGreaterThan(0);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 200 });
    const providerEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_provider");
    expect(providerEvent).toBeDefined();
    expect(providerEvent!.metadata).toMatchObject({
      allowed: true,
      allowed_reason: "forced_request",
      forced: true,
      provider: "stub",
    });
  });

  it("should skip evidence provider on hello without forceEvidence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-evidence-skip",
        message: "hello",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.outputEnvelope?.meta?.claims).toBeUndefined();

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 200 });
    const providerEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_provider");
    expect(providerEvent).toBeDefined();
    expect(providerEvent!.metadata).toMatchObject({
      allowed: false,
      allowed_reason: "no_intent",
      forced: false,
      provider: "skipped",
    });
  });

  it("should ignore forceEvidence in production", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevForce = process.env.EVIDENCE_PROVIDER_FORCE;
    try {
      process.env.NODE_ENV = "production";
      process.env.EVIDENCE_PROVIDER_FORCE = "1";

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        payload: {
          threadId: "test-thread-evidence-prod",
          message: "hello",
          traceConfig: { level: "debug", forceEvidence: true },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.outputEnvelope?.meta?.claims).toBeUndefined();

      const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 200 });
      const providerEvent = traceEvents.find((e) => e.metadata?.kind === "evidence_provider");
      expect(providerEvent).toBeDefined();
      expect(providerEvent!.metadata).toMatchObject({
        allowed: false,
        allowed_reason: "forced_ignored_prod",
        forced: true,
        provider: "skipped",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevForce === undefined) {
        delete process.env.EVIDENCE_PROVIDER_FORCE;
      } else {
        process.env.EVIDENCE_PROVIDER_FORCE = prevForce;
      }
    }
  });

  it("should validate evidence schema and accept valid evidence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-evidence-valid",
        message: "Test message",
        evidence: {
          captures: [{
            captureId: "cap-001",
            kind: "url",
            url: "https://example.com/article",
            capturedAt: new Date().toISOString(),
            title: "Example Article",
            source: "user_provided",
          }],
          supports: [{
            supportId: "sup-001",
            type: "url_capture",
            captureId: "cap-001",
            createdAt: new Date().toISOString(),
          }],
          claims: [{
            claimId: "claim-001",
            claimText: "The article states X",
            supportIds: ["sup-001"],
            createdAt: new Date().toISOString(),
          }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.evidenceSummary).toEqual({
      captures: 1,
      supports: 1,
      claims: 1,
      warnings: 0,
    });

    // Verify evidence_intake trace event
    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });
    const evidenceIntake = traceEvents.find(e => e.phase === "evidence_intake");
    expect(evidenceIntake).toBeDefined();
    expect(evidenceIntake!.metadata).toMatchObject({
      autoCaptures: 0,
      clientCaptures: 1,
      warningsCount: 0,
      captureCount: 1,
      supportCount: 1,
      claimCount: 1,
    });
  });

  it("should reject unknown keys in evidence with bounded 400 error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-evidence-unknown",
        message: "Test message",
        evidence: {
          captures: [],
          unknownField: "should fail",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("invalid_request");
    expect(body.unrecognizedKeys).toContain("unknownField");
  });

  it("should detect modalities correctly (text + url)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-modality",
        message: "Check out this article: https://example.com/article",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });
    const normalizeModality = traceEvents.find(e => e.phase === "gate_normalize_modality");
    
    expect(normalizeModality).toBeDefined();
    expect(normalizeModality!.metadata).toMatchObject({
      modalities: expect.arrayContaining(["text", "url"]),
    });
  });

  it("should classify intent as summarize for summarization requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-intent-summarize",
        message: "Please summarize this article for me",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });
    const intentRisk = traceEvents.find(e => e.phase === "gate_intent_risk");
    
    expect(intentRisk).toBeDefined();
    expect(intentRisk!.metadata).toMatchObject({
      intent: "summarize",
    });
  });

  it("should classify risk as high for financial advice requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-risk-high",
        message: "Should I invest in crypto? Give me financial advice",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });
    const intentRisk = traceEvents.find(e => e.phase === "gate_intent_risk");
    
    expect(intentRisk).toBeDefined();
    expect(intentRisk!.metadata).toMatchObject({
      risk: "high",
      riskReasons: expect.arrayContaining(["FINANCE"]),
    });
  });

  it("should run lattice stub and emit trace event", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-lattice",
        message: "Test message",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });
    const lattice = traceEvents.find(e => e.phase === "gate_lattice");
    
    expect(lattice).toBeDefined();
    expect(lattice!.metadata).toMatchObject({
      status: "stub",
    });
  });

  it("should not include raw evidence content in trace events", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-evidence-bounded",
        message: "Test message",
        evidence: {
          supports: [{
            supportId: "sup-001",
            type: "text_snippet",
            snippetText: "This is a long snippet that should not appear in trace events",
            createdAt: new Date().toISOString(),
          }],
        },
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });
    const evidenceIntake = traceEvents.find(e => e.phase === "evidence_intake");
    
    expect(evidenceIntake).toBeDefined();
    // Verify only counts are stored, not raw content
    expect(evidenceIntake!.metadata).toHaveProperty("snippetCharTotal");
    expect(evidenceIntake!.metadata).not.toHaveProperty("snippetText");
    expect(evidenceIntake!.summary).not.toContain("This is a long snippet");
  });

  it("should keep response bounded (no raw gate outputs or evidence content)", async () => {
    const snippetText = "Long snippet content that should not be echoed";
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-bounded-response",
        message: "Test message with https://example.com/url",
        evidence: {
          supports: [{
            supportId: "sup-001",
            type: "text_snippet",
            snippetText,
            createdAt: new Date().toISOString(),
          }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Verify response only contains bounded summaries
    expect(body.evidenceSummary).toEqual({
      captures: 1,
      supports: 1,
      claims: 1,
      warnings: 0,
    });

    // Evidence is returned in response when present
    expect(body.evidence).toBeDefined();
    expect(body.evidence.supports?.[0]?.snippetText).toBe(snippetText);
    
    // Verify no full gate outputs in response (only trace summary)
    expect(body).not.toHaveProperty("gatesOutput");
    expect(body).toHaveProperty("trace");
  });

  it("should persist all trace events in SQLite (not just memory)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        threadId: "test-thread-persistence",
        message: "Test persistence",
        traceConfig: { level: "debug" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Fetch trace events directly from SQLite store
    const traceEvents = await store.getTraceEvents(body.trace.traceRunId, { limit: 100 });

    // Verify all gate events are persisted
    const phases = traceEvents.map(e => e.phase);
    expect(phases).toContain("evidence_intake");
    expect(phases).toContain("gate_normalize_modality");
    expect(phases).toContain("gate_intent_risk");
    expect(phases).toContain("gate_lattice");

    // Verify events have proper structure
    traceEvents.forEach(event => {
      expect(event).toHaveProperty("id");
      expect(event).toHaveProperty("traceRunId");
      expect(event).toHaveProperty("transmissionId");
      expect(event).toHaveProperty("actor");
      expect(event).toHaveProperty("phase");
      expect(event).toHaveProperty("status");
      expect(event).toHaveProperty("summary");
      expect(event).toHaveProperty("ts");
    });
  });
});
