import type { RetrievalItem } from "./prompt_pack";

/**
 * Retrieval seam (v0.1).
 *
 * Goal: make retrieval real but still small and local so we can validate the control-plane flow.
 *
 * Glossary (anti-drift):
 * - Context Fact Block (CFB): durable knowledge objects (authoritative | heuristic | umbra).
 * - ThreadMemento: lightweight thread navigation snapshot
 *   (arc/active/parked/decisions/next). This is not durable knowledge.
 *
 * In Sol terms:
 * - A RetrievalItem is allowed context we can safely attach to the PromptPack.
 * - For v0.1, our first real retrieval item is the ThreadMemento.
 */

/**
 * ThreadMemento
 *
 * A compact, human-readable snapshot of the current navigation state for a thread.
 * This exists to reduce drift and prevent the model from re-deriving basic navigation context.
 *
 * Typical fields:
 * - Arc: the primary purpose of the current thread
 * - Active: what we are working on right now
 * - Parked: tangents we intentionally paused
 * - Decisions: what has been locked
 * - Next: the immediate next actions
 *
 * v0.1 note:
 * - This is intentionally an in-process registry (memory only).
 * - Later we will persist this (store / DB) and add governance (auth, writes, audits).
 * - Later we will chain mementos (prevMementoId) for deterministic replay and debugging.
 */
export type ThreadMementoSnapshot = {
  mementoId: string;
  threadId: string;
  createdTs: string;
  version: "memento-v0.1";

  arc: string;
  active: string[];
  parked: string[];
  decisions: string[];
  next: string[];
  affect: {
    points: Array<{
      endMessageId: string;
      label: string;
      intensity: number;
      confidence: "low" | "med" | "high";
      source: "server" | "device_hint" | "model";
    }>;
    rollup: {
      phase: "rising" | "peak" | "downshift" | "settled";
      intensityBucket: "low" | "med" | "high";
      updatedAt: string;
    };
  };
};

export type ThreadMementoAffectPoint = {
  endMessageId: string;
  label: string;
  intensity: number;
  confidence: "low" | "med" | "high";
  source: "server" | "device_hint" | "model";
};

export type ThreadMementoAffectPointInternal = ThreadMementoAffectPoint & {
  ts: string;
};

export type ThreadMementoLatestInternal = {
  mementoId: string;
  threadId: string;
  createdTs: string;
  updatedAt: string;
  version: "memento-v0.1";
  arc: string;
  active: string[];
  parked: string[];
  decisions: string[];
  next: string[];
  affect: {
    points: ThreadMementoAffectPointInternal[];
    rollup: {
      phase: "rising" | "peak" | "downshift" | "settled";
      intensityBucket: "low" | "med" | "high";
      updatedAt: string;
    };
  };
};

export type ThreadMementoLatest = Omit<ThreadMementoLatestInternal, "affect"> & {
  affect: {
    points: ThreadMementoAffectPoint[];
    rollup: ThreadMementoLatestInternal["affect"]["rollup"];
  };
};

// v0.1: in-process ThreadMemento registry.
// - Keyed by threadId.
// - Draft is what the model proposes (returned to the client for review).
// - Accepted is what the user canonizes (safe to use in retrieval).
// - Revoke clears the accepted snapshot so retrieval stops using it.
// Later: move into ControlPlaneStore + persistence + chaining.
const mementoDraftByThreadId = new Map<string, ThreadMementoSnapshot>();
const mementoAcceptedByThreadId = new Map<string, ThreadMementoSnapshot>();
const mementoLatestByThreadId = new Map<string, ThreadMementoLatestInternal>();
const mementoLatestPersistedByThreadId = new Map<string, ThreadMementoLatestInternal>();
const mementoLatestTurnsSincePersist = new Map<string, number>();
type ThreadMementoSummaryInput = Pick<
  ThreadMementoSnapshot,
  "arc" | "active" | "parked" | "decisions" | "next" | "affect"
>;

function formatMementoSummary(m: ThreadMementoSummaryInput): string {
  // Keep this stable and human-readable.
  // The PromptPack uses the summary as plain text; we avoid JSON here on purpose.
  const lines: string[] = [];

  lines.push(`Arc: ${m.arc}`);
  lines.push(`Active: ${m.active.length ? m.active.join(" | ") : "(none)"}`);
  lines.push(`Parked: ${m.parked.length ? m.parked.join(" | ") : "(none)"}`);
  lines.push(`Decisions: ${m.decisions.length ? m.decisions.join(" | ") : "(none)"}`);
  lines.push(`Next: ${m.next.length ? m.next.join(" | ") : "(none)"}`);
  if (m.affect?.rollup) {
    lines.push(`Affect: ${m.affect.rollup.phase} (${m.affect.rollup.intensityBucket})`);
  }

  return lines.join("\n");
}

const intensityBucketFor = (intensity: number): "low" | "med" | "high" => {
  if (intensity >= 0.7) return "high";
  if (intensity >= 0.34) return "med";
  return "low";
};

const phaseFor = (points: Array<{ intensity: number }>): "rising" | "peak" | "downshift" | "settled" => {
  if (points.length === 0) return "settled";
  if (points.length === 1) {
    const intensity = points[0].intensity;
    return intensity >= 0.7 ? "peak" : "settled";
  }
  const prev = points[points.length - 2].intensity;
  const last = points[points.length - 1].intensity;
  const delta = last - prev;
  if (last >= 0.8 && Math.abs(delta) <= 0.05) return "peak";
  if (delta >= 0.1) return "rising";
  if (delta <= -0.1) return "downshift";
  return "settled";
};

const defaultAffect = (): ThreadMementoSnapshot["affect"] => ({
  points: [],
  rollup: {
    phase: "settled",
    intensityBucket: "low",
    updatedAt: new Date().toISOString(),
  },
});

function updateAffectWithPoint(
  existing: ThreadMementoSnapshot["affect"],
  point: ThreadMementoSnapshot["affect"]["points"][number]
): ThreadMementoSnapshot["affect"] {
  const points = [...existing.points, point].slice(-5);
  const latestIntensity = points.at(-1)?.intensity ?? 0;
  return {
    points,
    rollup: {
      phase: phaseFor(points),
      intensityBucket: intensityBucketFor(latestIntensity),
      updatedAt: new Date().toISOString(),
    },
  };
}

const THREAD_MEMENTO_MAX_POINTS = 5;
const THREAD_MEMENTO_MAX_WINDOW_MS = 30 * 60 * 1000;
const THREAD_MEMENTO_PERSIST_EVERY_TURNS = 5;

function normalizeAffectPoints(
  points: ThreadMementoAffectPointInternal[],
  nowIso: string
): ThreadMementoAffectPointInternal[] {
  return points.map((point) => ({
    ...point,
    ts: point.ts ?? nowIso,
  }));
}

function capAffectPoints(
  points: ThreadMementoAffectPointInternal[],
  nowIso: string
): ThreadMementoAffectPointInternal[] {
  const nowMs = Date.parse(nowIso);
  const bounded = points.filter((point) => {
    const ts = Date.parse(point.ts ?? nowIso);
    return Number.isNaN(ts) ? true : nowMs - ts <= THREAD_MEMENTO_MAX_WINDOW_MS;
  });

  return bounded.slice(-THREAD_MEMENTO_MAX_POINTS);
}

export function updateLatestAffectWithPoint(args: {
  existing: ThreadMementoLatestInternal["affect"];
  point: ThreadMementoAffectPointInternal;
  nowIso: string;
}): ThreadMementoLatestInternal["affect"] {
  const normalized = normalizeAffectPoints(args.existing.points, args.nowIso);
  const nextPoints = capAffectPoints([...normalized, args.point], args.nowIso);
  const latestIntensity = nextPoints.at(-1)?.intensity ?? 0;

  return {
    points: nextPoints,
    rollup: {
      phase: phaseFor(nextPoints),
      intensityBucket: intensityBucketFor(latestIntensity),
      updatedAt: args.nowIso,
    },
  };
}

export function sanitizeThreadMementoLatest(
  memento: ThreadMementoLatestInternal
): ThreadMementoLatest {
  const points = memento.affect.points
    .slice(-THREAD_MEMENTO_MAX_POINTS)
    .map(({ ts, ...rest }) => rest);
  return {
    ...memento,
    affect: {
      ...memento.affect,
      points,
    },
  };
}

function shapeEquals(a: ThreadMementoLatestInternal, b: ThreadMementoLatestInternal): boolean {
  const eq = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, idx) => value === right[idx]);

  return a.arc === b.arc
    && eq(a.active, b.active)
    && eq(a.parked, b.parked)
    && eq(a.decisions, b.decisions)
    && eq(a.next, b.next);
}

export function shouldPersistThreadMementoLatest(args: {
  next: ThreadMementoLatestInternal;
  threadId: string;
}): boolean {
  const persisted = mementoLatestPersistedByThreadId.get(args.threadId);
  const turnsSince = mementoLatestTurnsSincePersist.get(args.threadId) ?? 0;
  if (!persisted) return true;
  if (persisted.affect.rollup.phase !== args.next.affect.rollup.phase) return true;
  if (!shapeEquals(persisted, args.next)) return true;
  return turnsSince >= THREAD_MEMENTO_PERSIST_EVERY_TURNS;
}

export function noteThreadMementoLatestTurn(threadId: string): number {
  const next = (mementoLatestTurnsSincePersist.get(threadId) ?? 0) + 1;
  mementoLatestTurnsSincePersist.set(threadId, next);
  return next;
}

export function markThreadMementoLatestPersisted(memento: ThreadMementoLatestInternal): void {
  mementoLatestPersistedByThreadId.set(memento.threadId, memento);
  mementoLatestTurnsSincePersist.set(memento.threadId, 0);
}

export function getThreadMementoLatestCached(threadId: string): ThreadMementoLatestInternal | null {
  return mementoLatestByThreadId.get(threadId) ?? null;
}

export function setThreadMementoLatestCached(memento: ThreadMementoLatestInternal): void {
  mementoLatestByThreadId.set(memento.threadId, memento);
}

/**
 * Store/replace the latest DRAFT ThreadMemento for a thread.
 *
 * v0.1 behavior:
 * - The model can propose a draft ThreadMemento.
 * - The client can show it and decide Accept or Decline.
 * - Only Accepted mementos are allowed to enter retrieval.
 */
export function putThreadMemento(args: {
  threadId: string;
  arc: string;
  active: string[];
  parked: string[];
  decisions: string[];
  next: string[];
  affect?: ThreadMementoSnapshot["affect"];
}): ThreadMementoSnapshot {
  const record: ThreadMementoSnapshot = {
    mementoId: crypto.randomUUID(),
    threadId: args.threadId,
    createdTs: new Date().toISOString(),
    version: "memento-v0.1",
    arc: args.arc,
    active: args.active,
    parked: args.parked,
    decisions: args.decisions,
    next: args.next,
    affect: args.affect ?? defaultAffect(),
  };

  mementoDraftByThreadId.set(args.threadId, record);
  return record;
}

/**
 * Accept a draft ThreadMemento.
 *
 * v0.1: accept is an in-process promotion.
 * Later: persistence, audit trail, and chaining.
 */
export function acceptThreadMemento(args: {
  threadId: string;
  mementoId: string;
}): ThreadMementoSnapshot | null {
  const draft = mementoDraftByThreadId.get(args.threadId);
  if (!draft) return null;
  if (draft.mementoId !== args.mementoId) return null;

  mementoAcceptedByThreadId.set(args.threadId, draft);
  mementoDraftByThreadId.delete(args.threadId);
  return draft;
}

/**
 * Decline a draft ThreadMemento.
 *
 * v0.1: decline discards the latest draft.
 */
export function declineThreadMemento(args: {
  threadId: string;
  mementoId: string;
}): ThreadMementoSnapshot | null {
  const draft = mementoDraftByThreadId.get(args.threadId);
  if (!draft) return null;
  if (draft.mementoId !== args.mementoId) return null;

  mementoDraftByThreadId.delete(args.threadId);
  // Return the declined draft so callers can treat this as applied=true.
  return draft;
}

/**
 * Revoke the currently accepted ThreadMemento.
 *
 * v0.1: revoke is an in-process demotion.
 * - Clears the accepted snapshot so retrieval stops using it.
 * - Requires mementoId to match the currently-accepted id (to prevent stale UI actions).
 */
export function revokeThreadMemento(args: {
  threadId: string;
  mementoId: string;
}): ThreadMementoSnapshot | null {
  const accepted = mementoAcceptedByThreadId.get(args.threadId);
  if (!accepted) return null;
  if (accepted.mementoId !== args.mementoId) return null;

  mementoAcceptedByThreadId.delete(args.threadId);
  return accepted;
}

/**
 * Read the latest ThreadMemento for a thread.
 *
 * v0.1 semantics:
 * - Default (no opts): returns Accepted only (unless it has been revoked).
 * - includeDraft: returns Draft if present, else falls back to Accepted.
 */
export function getLatestThreadMemento(
  threadId: string,
  opts?: { includeDraft?: boolean }
): ThreadMementoSnapshot | null {
  const accepted = mementoAcceptedByThreadId.get(threadId) ?? null;

  if (opts?.includeDraft) {
    const draft = mementoDraftByThreadId.get(threadId) ?? null;
    return draft ?? accepted;
  }

  return accepted;
}

export function updateThreadMementoAffect(args: {
  threadId: string;
  point: ThreadMementoSnapshot["affect"]["points"][number];
}): ThreadMementoSnapshot | null {
  const draft = mementoDraftByThreadId.get(args.threadId);
  if (draft) {
    draft.affect = updateAffectWithPoint(draft.affect, args.point);
    return draft;
  }

  const accepted = mementoAcceptedByThreadId.get(args.threadId);
  if (accepted) {
    accepted.affect = updateAffectWithPoint(accepted.affect, args.point);
    return accepted;
  }

  return null;
}

/**
 * Test helper: clear in-memory state.
 *
 * Do not call this from production code.
 */
export function __dangerous_clearThreadMementosForTestOnly(): void {
  mementoDraftByThreadId.clear();
  mementoAcceptedByThreadId.clear();
  mementoLatestByThreadId.clear();
  mementoLatestPersistedByThreadId.clear();
  mementoLatestTurnsSincePersist.clear();
}

/**
 * Retrieve allowed context items for the current packet.
 *
 * v0.1 behavior:
 * - If a pinned ThreadMemento exists, include it as kind "bookmark".
 * - If thread_context_mode=auto and a latest ThreadMemento exists, include it as kind "memento".
 * - Otherwise return an empty list.
 *
 * Constraints:
 * - Keep ordering deterministic.
 * - Keep results small and bounded.
 * - Never leak raw user content in logs.
 */
export async function retrieveContext(args: {
  threadId: string;
  packetType: string;
  message: string;
  threadContextMode?: "off" | "auto";
}): Promise<RetrievalItem[]> {
  // v0.1: packetType/message are not used, but we keep them in the signature
  // so retrieval can evolve without touching callers.
  void args.packetType;
  void args.message;

  const items: RetrievalItem[] = [];
  const pinned = getLatestThreadMemento(args.threadId);
  if (pinned) {
    items.push({
      id: pinned.mementoId,
      kind: "bookmark",
      summary: formatMementoSummary(pinned),
    });
  }

  if (args.threadContextMode !== "off") {
    const latest = getThreadMementoLatestCached(args.threadId);
    if (latest) {
      items.push({
        id: latest.mementoId,
        kind: "memento",
        summary: formatMementoSummary(latest),
      });
    }
  }

  return items;
}

/**
 * Small helper to keep logging consistent without leaking content.
 */
export function retrievalLogShape(items: RetrievalItem[]): {
  count: number;
  ids: string[];
  kinds: Record<string, number>;
} {
  const kinds: Record<string, number> = {};
  for (const it of items) {
    kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
  }

  return {
    count: items.length,
    ids: items.map((i) => i.id),
    kinds,
  };
}
