import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { chatRoutes } from "../src/routes/chat";
import { MemoryControlPlaneStore } from "../src/store/control_plane_store";
import { __dangerous_clearThreadMementosForTestOnly, retrieveContext } from "../src/control-plane/retrieval";

const ASSISTANT_TEXT = [
  "Receipt: ok",
  "Release: ok",
  "Next: ok",
  "Assumption: ok",
].join("\n");

function buildEnvelope(meta: Record<string, any>) {
  return JSON.stringify({
    assistant_text: ASSISTANT_TEXT,
    meta,
  });
}

describe("ThreadMementoLatest", () => {
  let app: any;
  let store: MemoryControlPlaneStore;

  beforeEach(async () => {
    __dangerous_clearThreadMementosForTestOnly();
    store = new MemoryControlPlaneStore();
    app = Fastify({ logger: false });
    app.register(cors, { origin: true });
    app.register(chatRoutes, { prefix: "/v1", store });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("appends affect_signal and updates rollup", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          shape: {
            arc: "Arc",
            active: ["Active"],
            parked: [],
            decisions: [],
            next: ["Next"],
          },
          affect_signal: {
            label: "insight",
            intensity: 0.8,
            confidence: 0.9,
          },
        }),
      },
      payload: {
        threadId: "t-affect",
        message: "I just realized I avoid asking for help because I expect rejection.",
        thread_context_mode: "auto",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.threadMemento).toBeTruthy();
    expect(body.threadMemento.affect.points.length).toBe(1);
    expect(body.threadMemento.affect.points[0].label).toBe("insight");
    expect(body.threadMemento.affect.points[0].confidence).toBe("high");
    expect(body.threadMemento.affect.points[0].source).toBe("model");
    expect(body.threadMemento.affect.rollup.phase).toBe("peak");
    expect(body.threadMemento.affect.rollup.intensityBucket).toBe("high");
  });

  it("keeps prior affect when affect_signal is missing", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          shape: {
            arc: "Arc",
            active: ["Active"],
            parked: [],
            decisions: [],
            next: ["Next"],
          },
          affect_signal: {
            label: "insight",
            intensity: 0.6,
            confidence: 0.6,
          },
        }),
      },
      payload: {
        threadId: "t-affect-miss",
        message: "first",
        thread_context_mode: "auto",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          shape: {
            arc: "Arc",
            active: ["Active"],
            parked: [],
            decisions: [],
            next: ["Next"],
          },
        }),
      },
      payload: {
        threadId: "t-affect-miss",
        message: "second",
        thread_context_mode: "auto",
      },
    });

    const body = response.json();
    expect(body.threadMemento).toBeTruthy();
    expect(body.threadMemento.affect.points.length).toBe(1);
    expect(body.threadMemento.affect.rollup.intensityBucket).toBe("med");
  });

  it("skips ThreadMementoLatest when thread_context_mode=off", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          affect_signal: {
            label: "gratitude",
            intensity: 0.7,
            confidence: 0.7,
          },
        }),
      },
      payload: {
        threadId: "t-off",
        message: "hello",
        thread_context_mode: "off",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.threadMemento ?? null).toBeNull();

    const stored = await store.getThreadMementoLatest({ threadId: "t-off" });
    expect(stored).toBeNull();
  });

  it("includes latest in retrieval only when auto", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          shape: {
            arc: "Arc",
            active: ["Active"],
            parked: [],
            decisions: [],
            next: ["Next"],
          },
          affect_signal: {
            label: "resolve",
            intensity: 0.4,
            confidence: 0.5,
          },
        }),
      },
      payload: {
        threadId: "t-retrieval",
        message: "hello",
        thread_context_mode: "auto",
      },
    });

    const autoItems = await retrieveContext({
      threadId: "t-retrieval",
      packetType: "chat",
      message: "next",
      threadContextMode: "auto",
    });
    expect(autoItems.some((item) => item.kind === "memento")).toBe(true);

    const offItems = await retrieveContext({
      threadId: "t-retrieval",
      packetType: "chat",
      message: "next",
      threadContextMode: "off",
    });
    expect(offItems.some((item) => item.kind === "memento")).toBe(false);
  });

  it("does not persist latest on every turn", async () => {
    const persistSpy = vi.spyOn(store, "upsertThreadMementoLatest");

    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: {
          "x-sol-test-output-envelope": buildEnvelope({
            shape: {
              arc: "Arc",
              active: ["Active"],
              parked: [],
              decisions: [],
              next: ["Next"],
            },
            affect_signal: {
              label: "insight",
              intensity: 0.5,
              confidence: 0.5,
            },
          }),
        },
        payload: {
          threadId: "t-persist",
          message: `hello-${i}`,
          thread_context_mode: "auto",
        },
      });

      expect(response.statusCode).toBe(200);
    }

    expect(persistSpy.mock.calls.length).toBe(1);
  });
});
