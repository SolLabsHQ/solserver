import { describe, it, expect, beforeEach } from "vitest";

import { buildPromptPack, toSinglePromptText } from "../control-plane/prompt_pack";
import {
  __dangerous_clearThreadMementosForTestOnly,
  putThreadMemento,
  acceptThreadMemento,
  declineThreadMemento,
  revokeThreadMemento,
  getLatestThreadMemento,
  retrieveContext,
} from "../control-plane/retrieval";

import type { PacketInput, ModeDecision } from "../contracts/chat";

function makePacket(message: string): PacketInput {
  return {
    packetType: "chat",
    threadId: "t1",
    message,
  } as PacketInput;
}

function makeModeDecision(modeLabel: string): ModeDecision {
  return {
    modeLabel,
    personaLabel: modeLabel === "Sole"
      ? "sole"
      : modeLabel === "System-mode"
        ? "cassandra"
        : "ida",
    domainFlags: [],
    confidence: 0.7,
    checkpointNeeded: false,
    reasons: ["test"],
    version: "mode-engine-v0",
  } as ModeDecision;
}

describe("Step 6 - PromptPack", () => {
  it("buildPromptPack uses deterministic section order", () => {
    const packet = makePacket("hello sol");
    const modeDecision = makeModeDecision("Ida");

    const pack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems: [],
    });

    expect(pack.version).toBe("prompt-pack-v0");
    expect(pack.sections.map((s) => s.id)).toEqual(["law", "retrieval", "evidence_pack", "user_message"]);
    expect(pack.sections.map((s) => s.role)).toEqual(["system", "system", "system", "user"]);
  });

  it("retrieval section is present even when empty", () => {
    const packet = makePacket("hello sol");
    const modeDecision = makeModeDecision("Ida");

    const pack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems: [],
    });

    const retrieval = pack.sections.find((s) => s.id === "retrieval");
    expect(retrieval).toBeTruthy();
    expect(retrieval?.content).toContain("no retrieved context");
  });

  it("toSinglePromptText includes stable section headers", () => {
    const packet = makePacket("hello sol");
    const modeDecision = makeModeDecision("Ida");

    const pack = buildPromptPack({
      packet,
      modeDecision,
      retrievalItems: [],
    });

    const text = toSinglePromptText(pack);

    // Keep this intentionally light so we do not lock to exact law text yet.
    expect(text).toContain("## Mounted law");
    expect(text).toContain("## Retrieved context");
    expect(text).toContain("## Evidence Pack");
    expect(text).toContain("## User message");

    // The packed prompt should be larger than the raw user message.
    expect(text.length).toBeGreaterThan(packet.message.length);
  });
});

describe("Step 6 - retrieval seam", () => {
  beforeEach(() => {
    __dangerous_clearThreadMementosForTestOnly();
  });

  it("retrieveContext returns an empty list when no ThreadMemento exists", async () => {
    const items = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });

    expect(items).toEqual([]);
  });

  it("retrieveContext uses accepted-only memento (draft is ignored)", async () => {
    const draft = putThreadMemento({
      threadId: "t1",
      arc: "SolServer v0 build",
      active: ["Wire ThreadMemento"],
      parked: ["UI polish"],
      decisions: ["Option 1"],
      next: ["Return threadMemento in /chat"],
    });

    // Draft should be visible only when includeDraft=true.
    expect(getLatestThreadMemento("t1", { includeDraft: true })?.mementoId).toBe(draft.mementoId);

    // Retrieval MUST ignore draft until the user accepts.
    const before = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });
    expect(before).toEqual([]);

    // Accept promotes draft -> accepted.
    const accepted = acceptThreadMemento({ threadId: "t1", mementoId: draft.mementoId });
    expect(accepted?.mementoId).toBe(draft.mementoId);

    const items = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("memento");

    // Summary format should stay stable and human-readable.
    expect(items[0].summary).toContain("Arc:");
    expect(items[0].summary).toContain("Active:");
    expect(items[0].summary).toContain("Parked:");
    expect(items[0].summary).toContain("Decisions:");
    expect(items[0].summary).toContain("Next:");
  });

  it("decline discards draft and retrieval remains empty", async () => {
    const draft = putThreadMemento({
      threadId: "t1",
      arc: "SolServer v0 build",
      active: ["Draft only"],
      parked: [],
      decisions: [],
      next: [],
    });

    // Decline removes the draft.
    const declined = declineThreadMemento({ threadId: "t1", mementoId: draft.mementoId });
    expect(declined).not.toBeNull();
    expect(declined!.mementoId).toBe(draft.mementoId);

    // No draft, no accepted.
    expect(getLatestThreadMemento("t1", { includeDraft: true })).toBeNull();
    expect(getLatestThreadMemento("t1")).toBeNull();

    const items = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });

    expect(items).toEqual([]);
  });

  it("accept requires mementoId to match the latest draft", async () => {
    const draft = putThreadMemento({
      threadId: "t1",
      arc: "SolServer v0 build",
      active: ["Draft"],
      parked: [],
      decisions: [],
      next: [],
    });

    const wrong = acceptThreadMemento({ threadId: "t1", mementoId: "not-the-id" });
    expect(wrong).toBeNull();

    // Draft still exists.
    expect(getLatestThreadMemento("t1", { includeDraft: true })?.mementoId).toBe(draft.mementoId);

    const items = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });
    expect(items).toEqual([]);
  });

  it("revoke removes accepted memento and retrieval returns empty", async () => {
    const draft = putThreadMemento({
      threadId: "t1",
      arc: "SolServer v0 build",
      active: ["Revoke me"],
      parked: [],
      decisions: [],
      next: [],
    });

    // Accept promotes draft -> accepted.
    const accepted = acceptThreadMemento({ threadId: "t1", mementoId: draft.mementoId });
    expect(accepted?.mementoId).toBe(draft.mementoId);

    // Retrieval should now include the accepted memento.
    const before = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });
    expect(before).toHaveLength(1);
    expect(before[0].kind).toBe("memento");

    // Revoke removes the accepted memento.
    const revoked = revokeThreadMemento({ threadId: "t1", mementoId: draft.mementoId });
    expect(revoked?.mementoId).toBe(draft.mementoId);

    const after = await retrieveContext({
      threadId: "t1",
      packetType: "chat",
      message: "hello",
    });

    expect(after).toEqual([]);
    expect(getLatestThreadMemento("t1")).toBeNull();
  });

  it("revoke is a no-op when nothing is accepted", () => {
    const revoked = revokeThreadMemento({ threadId: "t1", mementoId: "does-not-exist" });
    expect(revoked).toBeNull();
  });
});
