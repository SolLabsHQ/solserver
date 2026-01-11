import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

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

const TEST_DB_PATH = resolve(__dirname, "../data/test_restart.db");
const SERVER_PORT = 3334;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

describe("Restart Continuity", () => {
  let serverProcess: ChildProcess | null = null;

  const startServer = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn("pnpm", ["tsx", "src/index.ts"], {
        cwd: resolve(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(SERVER_PORT),
          DB_PATH: TEST_DB_PATH,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let resolved = false;
      let output = "";
      serverProcess.stdout?.on("data", (data) => {
        output += data.toString();
        if (!resolved && output.includes("Server listening")) {
          resolved = true;
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        console.error("Server stderr:", data.toString());
      });

      serverProcess.on("error", reject);

      // Timeout after 10 seconds
      setTimeout(10000).then(() => {
        if (!resolved) {
          reject(new Error("Server failed to start within timeout. Output: " + output));
        }
      });
    });
  };

  const stopServer = async (): Promise<void> => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await setTimeout(1000);
      serverProcess = null;
    }
  };

  beforeAll(() => {
    // Clean up any existing test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  afterAll(async () => {
    await stopServer();
    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  it("should maintain idempotency across server restarts", async () => {
    // Start server
    await startServer();
    await setTimeout(2000); // Give server time to fully initialize

    const clientRequestId = "test-restart-" + Date.now();
    const payload = {
      packetType: "chat",
      threadId: "thread-restart-test",
      clientRequestId,
      message: "Test message for restart continuity",
    };

    // First request
    const response1 = await fetch(`${SERVER_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response1.ok) {
      const errorText = await response1.text();
      console.error("First request failed:", response1.status, errorText);
    }
    expect(response1.ok).toBe(true);
    const data1 = await response1.json();
    const transmissionId1 = data1.transmissionId;
    expect(transmissionId1).toBeDefined();

    // Stop server
    await stopServer();
    await setTimeout(1000);

    // Restart server
    await startServer();
    await setTimeout(2000);

    // Second request with same clientRequestId
    const response2 = await fetch(`${SERVER_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(response2.ok).toBe(true);
    const data2 = await response2.json();
    const transmissionId2 = data2.transmissionId;

    // Verify idempotency: same transmissionId returned
    expect(transmissionId2).toBe(transmissionId1);

    // Stop server
    await stopServer();
  }, 30000); // 30 second timeout for this test
});
