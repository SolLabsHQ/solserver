import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { resolve } from "node:path";

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

const cleanupFile = (path: string) => {
  if (fs.existsSync(path)) {
    fs.unlinkSync(path);
  }
};

const loadValidateTopology = async (overrideExists?: (path: fs.PathLike) => boolean) => {
  vi.resetModules();

  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs");
    return {
      ...actual,
      existsSync: overrideExists ?? actual.existsSync,
    };
  });

  const mod = await import("../src/store/sqlite_control_plane_store");
  return mod.validateTopology;
};

describe("Topology guard", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = {
      FLY_PROCESS_GROUP: process.env.FLY_PROCESS_GROUP,
      TOPOLOGY_GUARD_STRICT: process.env.TOPOLOGY_GUARD_STRICT,
    };
  });

  afterEach(() => {
    if (envSnapshot.FLY_PROCESS_GROUP === undefined) {
      delete process.env.FLY_PROCESS_GROUP;
    } else {
      process.env.FLY_PROCESS_GROUP = envSnapshot.FLY_PROCESS_GROUP;
    }

    if (envSnapshot.TOPOLOGY_GUARD_STRICT === undefined) {
      delete process.env.TOPOLOGY_GUARD_STRICT;
    } else {
      process.env.TOPOLOGY_GUARD_STRICT = envSnapshot.TOPOLOGY_GUARD_STRICT;
    }

    vi.restoreAllMocks();
  });

  it("passes when db is on Fly volume and process group is app", async () => {
    const { log, entries } = makeLogger();
    const dbPath = "/data/control_plane.db";

    process.env.FLY_PROCESS_GROUP = "app";

    const validateTopology = await loadValidateTopology((path) => path === dbPath);
    expect(() => validateTopology(dbPath, log)).not.toThrow();

    const warns = entries.filter((entry) => entry.level === "warn");
    const errors = entries.filter((entry) => entry.level === "error");
    const infos = entries.filter((entry) => entry.level === "info");

    expect(warns.length).toBe(0);
    expect(errors.length).toBe(0);
    expect(infos.some((entry) => entry.message.includes("validation passed"))).toBe(true);
  });

  it("warns for in-memory database", async () => {
    const { log, entries } = makeLogger();

    const validateTopology = await loadValidateTopology((path) => fs.existsSync(path));
    expect(() => validateTopology(":memory:", log)).not.toThrow();

    expect(entries.some((entry) => entry.message.includes("in-memory database"))).toBe(true);
  });

  it("throws when database file does not exist", async () => {
    const { log } = makeLogger();
    const dbPath = resolve(__dirname, "../data/does_not_exist.db");

    cleanupFile(dbPath);

    const validateTopology = await loadValidateTopology((path) => fs.existsSync(path));
    expect(() => validateTopology(dbPath, log)).toThrow("Database file not found");
  });

  it("warns when database is on ephemeral storage", async () => {
    const { log, entries } = makeLogger();
    const dbPath = "/tmp/topology_guard.db";

    cleanupFile(dbPath);
    fs.writeFileSync(dbPath, "");

    try {
      const validateTopology = await loadValidateTopology((path) => fs.existsSync(path));
      expect(() => validateTopology(dbPath, log)).not.toThrow();
      expect(entries.some((entry) => entry.message.includes("ephemeral storage"))).toBe(true);
    } finally {
      cleanupFile(dbPath);
    }
  });

  it("warns when database is not on Fly volume", async () => {
    const { log, entries } = makeLogger();
    const dbPath = resolve(__dirname, "../data/topology_guard.db");

    cleanupFile(dbPath);
    fs.writeFileSync(dbPath, "");

    try {
      const validateTopology = await loadValidateTopology((path) => fs.existsSync(path));
      expect(() => validateTopology(dbPath, log)).not.toThrow();
      expect(entries.some((entry) => entry.message.includes("not on Fly.io volume"))).toBe(true);
    } finally {
      cleanupFile(dbPath);
    }
  });

  it("warns when process group is unexpected", async () => {
    const { log, entries } = makeLogger();
    const dbPath = resolve(__dirname, "../data/topology_guard_group.db");

    cleanupFile(dbPath);
    fs.writeFileSync(dbPath, "");
    process.env.FLY_PROCESS_GROUP = "worker";

    try {
      const validateTopology = await loadValidateTopology((path) => fs.existsSync(path));
      expect(() => validateTopology(dbPath, log)).not.toThrow();
      expect(entries.some((entry) => entry.message.includes("unexpected Fly.io process group"))).toBe(
        true
      );
    } finally {
      cleanupFile(dbPath);
    }
  });
});
