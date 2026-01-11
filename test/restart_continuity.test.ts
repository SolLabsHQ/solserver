import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "node:net";

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
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const HEALTH_URL = `${SERVER_URL}/health`;

describe.skipIf(process.env.CI)("Restart Continuity", () => {
  let serverProcess: ChildProcess | null = null;

  const waitForHealth = async (timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(HEALTH_URL);
        if (response.ok) return;
      } catch (err) {
        // ignore until timeout
      }
      await setTimeout(200);
    }
    throw new Error("Server health endpoint did not become ready.");
  };

  const waitForPort = async (timeoutMs = 4000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = connect(SERVER_PORT, "127.0.0.1");
          socket.once("connect", () => {
            socket.end();
            resolve();
          });
          socket.once("error", (error) => {
            socket.destroy();
            reject(error);
          });
        });
        return;
      } catch (err) {
        // ignore until timeout
      }
      await setTimeout(200);
    }
    throw new Error("Server port did not open within timeout.");
  };

  const waitForReady = async (): Promise<void> => {
    try {
      await waitForHealth();
    } catch (err) {
      await waitForPort();
    }
  };

  const startServer = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn("npm", ["run", "dev"], {
        cwd: resolve(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(SERVER_PORT),
          CONTROL_PLANE_DB_PATH: TEST_DB_PATH,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`Server exited before ready (code ${code}, signal ${signal})`));
      };

      serverProcess.once("exit", onExit);
      serverProcess.on("error", reject);
      serverProcess.stderr?.on("data", (data) => {
        console.error("Server stderr:", data.toString());
      });

      waitForReady()
        .then(() => {
          serverProcess?.off("exit", onExit);
          resolve();
        })
        .catch((err) => {
          serverProcess?.off("exit", onExit);
          reject(err);
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
