import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";
import type { ModeDecision, PacketInput } from "../src/contracts/chat";

const TEST_DB_PATH = resolve(__dirname, "../data/test_atomic_claims.db");

const MODE_DECISION: ModeDecision = {
  modeLabel: "Ida",
  domainFlags: [],
  confidence: 1,
  checkpointNeeded: false,
  reasons: [],
  version: "test",
};

const buildPacket = (index: number): PacketInput => ({
  packetType: "chat",
  threadId: `thread-${index}`,
  message: `hello-${index}`,
});

const cleanup = () => {
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
};

const createBarrier = (count: number) => {
  let ready = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    wait: async () => {
      ready += 1;
      if (ready === count && release) {
        release();
      }
      await gate;
    },
  };
};

const seedTransmissions = async (store: SqliteControlPlaneStore, total: number) => {
  for (let i = 0; i < total; i += 1) {
    await store.createTransmission({ packet: buildPacket(i), modeDecision: MODE_DECISION });
  }
};

describe("Atomic lease claims (SQLite)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("claims without duplicates under concurrent workers", async () => {
    const total = 20;
    const workers = 20;
    const seedStore = new SqliteControlPlaneStore(TEST_DB_PATH);
    await seedTransmissions(seedStore, total);
    seedStore.close();

    const stores = Array.from({ length: workers }, () => new SqliteControlPlaneStore(TEST_DB_PATH));
    const claimedIds = new Set<string>();

    try {
      for (let round = 0; round < total && claimedIds.size < total; round += 1) {
        const barrier = createBarrier(stores.length);
        const results = await Promise.all(
          stores.map((store, index) => (async () => {
            await barrier.wait();
            return store.leaseNextTransmission({
              leaseOwner: `worker-${index}`,
              leaseDurationSeconds: 60,
              eligibleStatuses: ["created", "processing"],
              packetType: "chat",
            });
          })())
        );

        for (const result of results) {
          if (result.outcome === "leased") {
            expect(claimedIds.has(result.transmission.id)).toBe(false);
            claimedIds.add(result.transmission.id);
          }
        }
      }
    } finally {
      for (const store of stores) {
        store.close();
      }
    }

    expect(claimedIds.size).toBe(total);
  });

  it("reclaims expired leases", async () => {
    const storeA = new SqliteControlPlaneStore(TEST_DB_PATH);
    await seedTransmissions(storeA, 1);

    const first = await storeA.leaseNextTransmission({
      leaseOwner: "worker-a",
      leaseDurationSeconds: -1,
      eligibleStatuses: ["created", "processing"],
      packetType: "chat",
    });

    expect(first.outcome).toBe("leased");
    if (first.outcome !== "leased") {
      storeA.close();
      throw new Error("Expected initial lease to succeed.");
    }

    const storeB = new SqliteControlPlaneStore(TEST_DB_PATH);
    try {
      const second = await storeB.leaseNextTransmission({
        leaseOwner: "worker-b",
        leaseDurationSeconds: 60,
        eligibleStatuses: ["created", "processing"],
        packetType: "chat",
      });

      expect(second.outcome).toBe("leased");
      if (second.outcome !== "leased") {
        throw new Error("Expected lease reclaim to succeed.");
      }
      expect(second.transmission.id).toBe(first.transmission.id);
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});
