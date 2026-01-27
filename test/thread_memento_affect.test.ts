import { describe, it, expect, beforeEach } from "vitest";

import {
  __dangerous_clearThreadMementosForTestOnly,
  putThreadMemento,
  updateThreadMementoAffect,
  getLatestThreadMemento,
} from "../src/control-plane/retrieval";

describe("ThreadMemento affect rollup", () => {
  beforeEach(() => {
    __dangerous_clearThreadMementosForTestOnly();
  });

  it("stores affect points and updates rollup phase", () => {
    const draft = putThreadMemento({
      threadId: "t-affect",
      arc: "Test",
      active: [],
      parked: [],
      decisions: [],
      next: [],
    });

    expect(draft.version).toBe("memento-v0.1");

    const updated1 = updateThreadMementoAffect({
      threadId: "t-affect",
      point: {
        endMessageId: "m1",
        label: "insight",
        intensity: 0.2,
        confidence: "med",
        source: "server",
      },
    });
    expect(updated1?.affect.points.length).toBe(1);
    expect(updated1?.affect.rollup.phase).toBe("settled");

    const updated2 = updateThreadMementoAffect({
      threadId: "t-affect",
      point: {
        endMessageId: "m2",
        label: "insight",
        intensity: 0.8,
        confidence: "high",
        source: "server",
      },
    });
    expect(updated2?.affect.points.length).toBe(2);
    expect(updated2?.affect.rollup.phase).toBe("rising");

    const latest = getLatestThreadMemento("t-affect", { includeDraft: true });
    expect(latest?.affect.rollup.intensityBucket).toBe("high");
  });
});
