import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runTopologyHandshake } from "../src/topology/worker_handshake";

type LogEntry = {
  level: "info" | "warn" | "error";
  message: string;
  context: Record<string, unknown>;
};

const makeLogger = () => {
  const entries: LogEntry[] = [];
  const log = {
    info: (context: Record<string, unknown>, message?: string) => {
      entries.push({ level: "info", message: message ?? "", context });
    },
    warn: (context: Record<string, unknown>, message?: string) => {
      entries.push({ level: "warn", message: message ?? "", context });
    },
    error: (context: Record<string, unknown>, message?: string) => {
      entries.push({ level: "error", message: message ?? "", context });
    },
  };

  return { log, entries };
};

describe("Worker topology handshake", () => {
  let previousNodeEnv: string | undefined;
  let previousFlyApp: string | undefined;

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    previousFlyApp = process.env.FLY_APP_NAME;
    process.env.NODE_ENV = "development";
    delete process.env.FLY_APP_NAME;
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }

    if (previousFlyApp === undefined) {
      delete process.env.FLY_APP_NAME;
    } else {
      process.env.FLY_APP_NAME = previousFlyApp;
    }
  });

  it("fails when API returns a different key", async () => {
    const { log, entries } = makeLogger();

    await expect(
      runTopologyHandshake({
        store: { readTopologyKey: () => ({ topologyKey: "local-key" }) },
        log,
        apiBaseUrl: "http://example.test",
        internalToken: "token",
        maxAttempts: 1,
        retryDelayMs: 1,
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ topologyKey: "remote-key" }),
          }) as Response,
        sleepImpl: async () => undefined,
      })
    ).rejects.toThrow("topology key mismatch");

    expect(
      entries.some((entry) => entry.message.includes("topology.guard.worker_key_mismatch_fatal"))
    ).toBe(true);
  });

  it("allows missing token in dev when API reachable", async () => {
    const { log } = makeLogger();
    let receivedHeaders: Record<string, string> | undefined;

    await runTopologyHandshake({
      store: { readTopologyKey: () => ({ topologyKey: "local-key" }) },
      log,
      apiBaseUrl: "http://example.test",
      internalToken: undefined,
      maxAttempts: 1,
      retryDelayMs: 1,
      fetchImpl: async (_url, init) => {
        receivedHeaders = init?.headers as Record<string, string> | undefined;
        return {
          ok: true,
          status: 200,
          json: async () => ({ topologyKey: "local-key" }),
        } as Response;
      },
      sleepImpl: async () => undefined,
    });

    expect(receivedHeaders).toBeUndefined();
  });

  it("fails when token is missing in prod", async () => {
    const { log, entries } = makeLogger();
    process.env.NODE_ENV = "production";

    await expect(
      runTopologyHandshake({
        store: { readTopologyKey: () => ({ topologyKey: "local-key" }) },
        log,
        apiBaseUrl: "http://example.test",
        internalToken: undefined,
        maxAttempts: 1,
        retryDelayMs: 1,
        fetchImpl: async () => {
          throw new Error("should-not-call");
        },
        sleepImpl: async () => undefined,
      })
    ).rejects.toThrow("SOL_INTERNAL_TOKEN missing");

    expect(
      entries.some((entry) =>
        entry.message.includes("topology.guard.worker_internal_token_missing_fatal")
      )
    ).toBe(true);
  });

  it("retries then fails when API is unreachable", async () => {
    const { log, entries } = makeLogger();
    let attempts = 0;

    await expect(
      runTopologyHandshake({
        store: { readTopologyKey: () => ({ topologyKey: "local-key" }) },
        log,
        apiBaseUrl: "http://example.test",
        internalToken: "token",
        maxAttempts: 3,
        retryDelayMs: 1,
        fetchImpl: async () => {
          attempts += 1;
          throw new Error("network down");
        },
        sleepImpl: async () => undefined,
      })
    ).rejects.toThrow("API unreachable");

    expect(attempts).toBe(3);
    expect(
      entries.some((entry) => entry.message.includes("topology.guard.worker_api_unreachable_fatal"))
    ).toBe(true);
  });

  it("retries then fails when local key is missing", async () => {
    const { log, entries } = makeLogger();
    let calls = 0;

    await expect(
      runTopologyHandshake({
        store: { readTopologyKey: () => {
          calls += 1;
          return null;
        } },
        log,
        apiBaseUrl: "http://example.test",
        internalToken: "token",
        maxAttempts: 2,
        retryDelayMs: 1,
        fetchImpl: async () => {
          throw new Error("should-not-call");
        },
        sleepImpl: async () => undefined,
      })
    ).rejects.toThrow("topology key missing");

    expect(calls).toBe(2);
    expect(
      entries.some((entry) => entry.message.includes("topology.guard.worker_key_missing_fatal"))
    ).toBe(true);
  });
});
