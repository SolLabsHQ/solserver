

import type { RetrievalItem } from "./prompt_pack";

/**
 * Retrieval seam (v0).
 *
 * In v0 we intentionally return an empty list, but we wire this call into the control plane so
 * the prompt assembly path is stable before we introduce persistence, embeddings, or CFB search.
 */
export async function retrieveContext(args: {
  threadId: string;
  packetType: string;
  message: string;
}): Promise<RetrievalItem[]> {
  // NOTE: Intentionally empty for v0.
  // Future: CFB candidates, saved memories, bookmarks, and other allowed context items.
  // Keep ordering deterministic and keep results small and bounded.
  void args;
  return [];
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
    kinds
  };
}