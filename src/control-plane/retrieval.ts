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
  id: string;
  threadId: string;
  createdAt: string;
  version: "memento-v0";

  arc: string;
  active: string[];
  parked: string[];
  decisions: string[];
  next: string[];
};

// v0.1: in-process ThreadMemento registry.
// - Keyed by threadId.
// - Stores only the latest memento per thread.
// Later: move into ControlPlaneStore + persistence + chaining.
const mementoByThreadId = new Map<string, ThreadMementoSnapshot>();

function formatMementoSummary(m: ThreadMementoSnapshot): string {
  // Keep this stable and human-readable.
  // The PromptPack uses the summary as plain text; we avoid JSON here on purpose.
  const lines: string[] = [];

  lines.push(`Arc: ${m.arc}`);
  lines.push(`Active: ${m.active.length ? m.active.join(" | ") : "(none)"}`);
  lines.push(`Parked: ${m.parked.length ? m.parked.join(" | ") : "(none)"}`);
  lines.push(`Decisions: ${m.decisions.length ? m.decisions.join(" | ") : "(none)"}`);
  lines.push(`Next: ${m.next.length ? m.next.join(" | ") : "(none)"}`);

  return lines.join("\n");
}

/**
 * Store/replace the latest ThreadMemento for a thread.
 *
 * v0.1: This is the only write surface for ThreadMemento in SolServer.
 * In practice, SolMobile will be the producer (it decides the memento and posts it to SolServer).
 */
export function putThreadMemento(args: {
  threadId: string;
  arc: string;
  active: string[];
  parked: string[];
  decisions: string[];
  next: string[];
}): ThreadMementoSnapshot {
  const record: ThreadMementoSnapshot = {
    id: crypto.randomUUID(),
    threadId: args.threadId,
    createdAt: new Date().toISOString(),
    version: "memento-v0",
    arc: args.arc,
    active: args.active,
    parked: args.parked,
    decisions: args.decisions,
    next: args.next,
  };

  mementoByThreadId.set(args.threadId, record);
  return record;
}

/**
 * Read the latest ThreadMemento for a thread.
 */
export function getLatestThreadMemento(threadId: string): ThreadMementoSnapshot | null {
  return mementoByThreadId.get(threadId) ?? null;
}

/**
 * Test helper: clear in-memory state.
 *
 * Do not call this from production code.
 */
export function __dangerous_clearThreadMementosForTestOnly(): void {
  mementoByThreadId.clear();
}

/**
 * Retrieve allowed context items for the current packet.
 *
 * v0.1 behavior:
 * - If a ThreadMemento exists for the thread, return exactly one RetrievalItem of kind "memento".
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
}): Promise<RetrievalItem[]> {
  // v0.1: packetType/message are not used, but we keep them in the signature
  // so retrieval can evolve without touching callers.
  void args.packetType;
  void args.message;

  const m = getLatestThreadMemento(args.threadId);
  if (!m) return [];

  return [
    {
      id: m.id,
      kind: "memento",
      summary: formatMementoSummary(m),
    },
  ];
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