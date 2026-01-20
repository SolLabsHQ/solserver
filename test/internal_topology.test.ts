import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";

import { internalTopologyRoutes } from "../src/routes/internal/topology";
import { SqliteControlPlaneStore } from "../src/store/sqlite_control_plane_store";

const DB_PATH = resolve(__dirname, "../data/test_internal_topology.db");

const cleanup = () => {
  if (existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
  }
};

const buildApp = async () => {
  const store = new SqliteControlPlaneStore(DB_PATH);
  store.ensureTopologyKeyPrimary({ createdBy: "api" });

  const app = Fastify({ logger: false });
  app.register(internalTopologyRoutes, { prefix: "/internal", store, dbPath: DB_PATH });
  await app.ready();

  return { app, store };
};

describe("Internal topology route", () => {
  let previousToken: string | undefined;

  beforeEach(() => {
    cleanup();
    previousToken = process.env.SOL_INTERNAL_TOKEN;
    process.env.SOL_INTERNAL_TOKEN = "test-token";
  });

  afterEach(async () => {
    cleanup();
    if (previousToken === undefined) {
      delete process.env.SOL_INTERNAL_TOKEN;
    } else {
      process.env.SOL_INTERNAL_TOKEN = previousToken;
    }
  });

  it("returns 401 when token is missing", async () => {
    const { app, store } = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/internal/topology",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      store.close();
      await app.close();
    }
  });

  it("returns 403 when token is invalid", async () => {
    const { app, store } = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/internal/topology",
        headers: {
          "x-sol-internal-token": "wrong-token",
        },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      store.close();
      await app.close();
    }
  });

  it("returns topology data when token is valid", async () => {
    const { app, store } = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/internal/topology",
        headers: {
          "x-sol-internal-token": "test-token",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.topologyKey).toBeDefined();
      expect(body.createdAtMs).toBeTypeOf("number");
      expect(body.createdBy).toBe("api");
      expect(body.dbPath).toBe(DB_PATH);
    } finally {
      store.close();
      await app.close();
    }
  });
});
