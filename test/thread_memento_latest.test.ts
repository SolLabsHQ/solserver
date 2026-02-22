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

function makeRequestThreadMementoV02(args: {
  threadId: string;
  arc: string;
  phase?: "rising" | "peak" | "downshift" | "settled";
  intensityBucket?: "low" | "med" | "high";
  signalKinds?: Array<
    | "decision_made"
    | "scope_changed"
    | "pivot"
    | "answer_provided"
    | "ack_only"
    | "open_loop_created"
    | "open_loop_resolved"
    | "risk_or_conflict"
  >;
}) {
  const now = new Date().toISOString();
  return {
    mementoId: `req-${args.threadId}`,
    threadId: args.threadId,
    createdTs: now,
    version: "memento-v0.2",
    arc: args.arc,
    active: [`active-${args.arc}`],
    parked: [],
    decisions: [],
    next: [`next-${args.arc}`],
    affect: {
      points: [
        {
          endMessageId: `msg-${args.threadId}`,
          label: "insight",
          intensity: 0.85,
          confidence: "high",
          source: "model",
        },
      ],
      rollup: {
        phase: args.phase ?? "settled",
        intensityBucket: args.intensityBucket ?? "med",
        updatedAt: now,
      },
    },
    ...(args.signalKinds && args.signalKinds.length > 0
      ? {
          signals: {
            updatedAt: now,
            items: args.signalKinds.map((kind, idx) => ({
              endMessageId: `sig-${idx}`,
              kind,
              confidence: "high",
              source: "server",
            })),
          },
        }
      : {}),
  };
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
    expect(body.threadMemento.id).toBeTruthy();
    expect(body.threadMemento.createdAt).toBeTruthy();
    expect(body.threadMemento.affect.points.length).toBe(1);
    expect(body.threadMemento.affect.points[0].label).toBe("insight");
    expect(body.threadMemento.affect.points[0].confidence).toBe("high");
    expect(body.threadMemento.affect.points[0].source).toBe("model");
    expect(body.threadMemento.affect.rollup.phase).toBe("peak");
    expect(body.threadMemento.affect.rollup.intensityBucket).toBe("high");
  });

  it("accepts context.thread_memento (v0.2) on /v1/chat", async () => {
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
        threadId: "t-context-accept",
        message: "Use my supplied thread memento.",
        context: {
          thread_memento: makeRequestThreadMementoV02({
            threadId: "t-context-accept",
            arc: "Request Arc",
          }),
        },
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it("uses request context.thread_memento over stored latest", async () => {
    const now = new Date().toISOString();
    await store.upsertThreadMementoLatest({
      memento: {
        mementoId: "stored-t-precedence",
        threadId: "t-precedence",
        createdTs: now,
        updatedAt: now,
        version: "memento-v0.1",
        arc: "Stored Arc",
        active: ["Stored Active"],
        parked: [],
        decisions: [],
        next: ["Stored Next"],
        affect: {
          points: [],
          rollup: {
            phase: "settled",
            intensityBucket: "low",
            updatedAt: now,
          },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": JSON.stringify({
          assistant_text: ASSISTANT_TEXT,
        }),
      },
      payload: {
        threadId: "t-precedence",
        message: "Prefer request memento over stored latest.",
        context: {
          thread_memento: makeRequestThreadMementoV02({
            threadId: "t-precedence",
            arc: "Request Arc",
          }),
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.threadMemento.arc).toBe("Request Arc");
    expect(body.threadMemento.arc).not.toBe("Stored Arc");
  });

  it("freezes summary at peak unless breakpoint decision is MUST", async () => {
    const responseSkip = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          shape: {
            arc: "Mutated Arc (should freeze)",
            active: ["mutated"],
            parked: [],
            decisions: ["mutated"],
            next: ["mutated"],
          },
        }),
      },
      payload: {
        threadId: "t-peak-guardrail",
        message: "ok thanks",
        traceConfig: { level: "debug" },
        context: {
          thread_memento: makeRequestThreadMementoV02({
            threadId: "t-peak-guardrail",
            arc: "Frozen Arc",
            phase: "peak",
            intensityBucket: "high",
          }),
        },
      },
    });

    expect(responseSkip.statusCode).toBe(200);
    const bodySkip = responseSkip.json();
    expect(bodySkip.threadMemento.arc).toBe("Frozen Arc");
    const breakpointSkip = (bodySkip.trace?.events ?? []).find((evt: any) => evt.phase === "breakpoint");
    expect(breakpointSkip?.metadata?.decision).toBe("skip");

    const responseMust = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        "x-sol-test-output-envelope": buildEnvelope({
          shape: {
            arc: "Must Arc",
            active: ["must-active"],
            parked: [],
            decisions: ["must-decision"],
            next: ["must-next"],
          },
        }),
      },
      payload: {
        threadId: "t-peak-guardrail",
        message: "We should lock the decision now.",
        traceConfig: { level: "debug" },
        context: {
          thread_memento: makeRequestThreadMementoV02({
            threadId: "t-peak-guardrail",
            arc: "Frozen Arc",
            phase: "peak",
            intensityBucket: "high",
            signalKinds: ["decision_made"],
          }),
        },
      },
    });

    expect(responseMust.statusCode).toBe(200);
    const bodyMust = responseMust.json();
    expect(bodyMust.threadMemento.arc).toBe("Must Arc");
    const breakpointMust = (bodyMust.trace?.events ?? []).find((evt: any) => evt.phase === "breakpoint");
    expect(breakpointMust?.metadata?.decision).toBe("must");
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
