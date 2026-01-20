import { describe, it, expect } from "vitest";

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
