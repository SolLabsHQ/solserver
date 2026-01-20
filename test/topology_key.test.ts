import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";

import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";

const DB_PATH = resolve(__dirname, "../data/test_topology_key.db");

const cleanup = () => {
  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
  }
};

describe("Topology key persistence", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("creates a key once and keeps it stable across restarts", () => {
    const storeA = new SqliteControlPlaneStore(DB_PATH);
    const metaA = storeA.ensureTopologyKeyPrimary({ createdBy: "api" });
    const metaARepeat = storeA.ensureTopologyKeyPrimary({ createdBy: "api" });

    expect(metaARepeat.topologyKey).toBe(metaA.topologyKey);
    expect(metaARepeat.createdAtMs).toBe(metaA.createdAtMs);

    storeA.close();

    const storeB = new SqliteControlPlaneStore(DB_PATH);
    const metaB = storeB.ensureTopologyKeyPrimary({ createdBy: "api" });
    storeB.close();

    expect(metaB.topologyKey).toBe(metaA.topologyKey);
    expect(metaB.createdAtMs).toBe(metaA.createdAtMs);
  });
});
