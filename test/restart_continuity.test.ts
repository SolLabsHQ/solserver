import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync, unlinkSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import { chatRoutes } from "../src/routes/chat";
import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";

/**
 * Restart Continuity Test
 * 
 * Validates that transmissions and idempotency work across server restarts.
 * 
 * Test flow:
 * 1. Start server with fresh SQLite database
 * 2. Send a request with a clientRequestId
 * 3. Verify response received
 * 4. Stop server
 * 5. Restart server (same database)
 * 6. Send same request with same clientRequestId
 * 7. Verify idempotent response (same transmissionId)
 */

const TEST_DB_PATH = pathResolve(__dirname, "../data/test_restart.db");
describe.skipIf(process.env.CI)("Restart Continuity", () => {
  const startServer = async () => {
    const store = new SqliteControlPlaneStore(TEST_DB_PATH);
    const app = Fastify({ logger: false });
    app.register(cors, { origin: true });
    app.register(chatRoutes, { prefix: "/v1", store });
    await app.ready();
    return { app, store };
  };

  beforeAll(() => {
    // Clean up any existing test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  afterAll(() => {
    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  it("should maintain idempotency across server restarts", async () => {
    const first = await startServer();

    const clientRequestId = "test-restart-" + Date.now();
    const payload = {
      packetType: "chat",
      threadId: "thread-restart-test",
      clientRequestId,
      message: "Test message for restart continuity",
    };

    // First request
    const response1 = await first.app.inject({
      method: "POST",
      url: "/v1/chat",
      payload,
    });
    expect(response1.statusCode).toBe(200);
    const data1 = response1.json();
    const transmissionId1 = data1.transmissionId;
    expect(transmissionId1).toBeDefined();

    await first.app.close();
    first.store.close();

    const second = await startServer();

    // Second request with same clientRequestId
    const response2 = await second.app.inject({
      method: "POST",
      url: "/v1/chat",
      payload,
    });
    expect(response2.statusCode).toBe(200);
    const data2 = response2.json();
    const transmissionId2 = data2.transmissionId;

    // Verify idempotency: same transmissionId returned
    expect(transmissionId2).toBe(transmissionId1);

    await second.app.close();
    second.store.close();
  }, 30000); // 30 second timeout for this test
});
