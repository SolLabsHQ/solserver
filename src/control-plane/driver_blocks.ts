import type { PacketInput, DriverBlockRef, DriverBlockInline } from "../contracts/chat.js";
import { SYSTEM_BASELINE_BLOCKS } from "./driver_block_registry.js";

/**
 * Driver Blocks are user-owned micro-protocols that reduce cognitive carry
 * and tighten assistant compliance without repeated user prompting.
 * 
 * They are applied in strict order to prevent prompt injection:
 * 1. System refs (shipped baseline)
 * 2. System mounted law (future: from pinned_context_ref)
 * 3. System derived (future: dynamic policy)
 * 4. User inline (LAST - applied after all system blocks)
 */

export type DriverBlockSource = "system_baseline" | "system_ref" | "system_mounted_law" | "system_derived" | "user_inline";

export type AssembledDriverBlock = {
  id: string;
  version: string;
  title?: string;
  definition: string;
  source: DriverBlockSource;
  order: number; // Explicit ordering for auditability
};

export type DriverBlockEnforcementResult = {
  accepted: AssembledDriverBlock[];
  dropped: Array<{ id: string; reason: string }>;
  trimmed: Array<{ id: string; originalLength: number; trimmedLength: number }>;
};

/**
 * System default Driver Blocks (shipped baseline)
 * These are referenced by ID in packet.driverBlockRefs
 */
const SYSTEM_DEFAULT_BLOCKS: Record<string, { id: string; version: string; title: string; definition: string }> = {
  "DB-001": {
    id: "DB-001",
    version: "1.0",
    title: "NoAuthorityDrift",
    definition: "Do not assume authority beyond what the user has explicitly granted. If uncertain, ask for clarification.",
  },
  "DB-002": {
    id: "DB-002",
    version: "1.0",
    title: "ShapeFirst",
    definition: "When starting a new task, propose a structure or outline before diving into details. Wait for user approval.",
  },
  "DB-003": {
    id: "DB-003",
    version: "1.0",
    title: "DecisionClosure",
    definition: "When the user makes a decision, provide a Receipt (summary + rationale) and Release (next action). Do not revisit unless explicitly asked.",
  },
  "DB-004": {
    id: "DB-004",
    version: "1.0",
    title: "OffloadWhenRemembering",
    definition: "When the user asks to remember something, suggest creating an Anchor or Checkpoint for durable storage.",
  },
  "DB-005": {
    id: "DB-005",
    version: "1.0",
    title: "MissingFactsStopAsk",
    definition: "If critical facts are missing, stop and ask rather than guessing or hallucinating.",
  },
};

/**
 * Bounds for Driver Blocks (v0)
 */
export const DRIVER_BLOCK_BOUNDS = {
  MAX_REFS: 10, // Max system refs
  MAX_INLINE: 3, // Max user inline blocks
  MAX_DEFINITION_BYTES: 4 * 1024, // Max UTF-8 bytes per definition
  MAX_TOTAL_BLOCKS: 15, // Max total blocks (system + user)
};

function utf8ByteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function trimToUtf8Bytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const char of text) {
    const encoded = encoder.encode(char);
    if (bytes + encoded.length > maxBytes) break;
    result += char;
    bytes += encoded.length;
  }
  return result;
}

/**
 * Assemble Driver Blocks from packet in strict order:
 * 1. Baseline system blocks (server-owned, always applied)
 * 2. System refs (from packet.driverBlockRefs)
 * 3. System mounted law (future: pinned context)
 * 4. System derived (future: dynamic policy)
 * 5. User inline (from packet.driverBlockInline) - LAST
 *
 * Baseline system blocks are always applied; refs/inline are additive.
 * No client-controlled mode exists; server contract is deterministic.
 */
export function assembleDriverBlocks(packet: PacketInput): DriverBlockEnforcementResult {
  const baselineBlocks: AssembledDriverBlock[] = [];
  const systemBlocks: AssembledDriverBlock[] = [];
  const userBlocks: AssembledDriverBlock[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  const trimmed: Array<{ id: string; originalLength: number; trimmedLength: number }> = [];

  let order = 0;

  // Step 0: Baseline system blocks (server-owned, always applied, never dropped)
  for (const baselineBlock of SYSTEM_BASELINE_BLOCKS) {
    baselineBlocks.push({
      id: baselineBlock.id,
      version: baselineBlock.version,
      title: baselineBlock.title,
      definition: baselineBlock.definition,
      source: "system_baseline",
      order: order++,
    });
  }

  // Step 1: System refs (from packet.driverBlockRefs)
  // Note: Baseline blocks are already added and are never subject to bounds enforcement.
  // Only client-provided refs and inline blocks are subject to limits.
  if (packet.driverBlockRefs && packet.driverBlockRefs.length > 0) {
    const refs = packet.driverBlockRefs.slice(0, DRIVER_BLOCK_BOUNDS.MAX_REFS);
    
    // Drop excess refs (baseline blocks are never dropped)
    if (packet.driverBlockRefs.length > DRIVER_BLOCK_BOUNDS.MAX_REFS) {
      for (let i = DRIVER_BLOCK_BOUNDS.MAX_REFS; i < packet.driverBlockRefs.length; i++) {
        dropped.push({
          id: packet.driverBlockRefs[i].id,
          reason: `Exceeded MAX_REFS limit (${DRIVER_BLOCK_BOUNDS.MAX_REFS})`,
        });
      }
    }

    for (const ref of refs) {
      const systemBlock = SYSTEM_DEFAULT_BLOCKS[ref.id];
      if (systemBlock && systemBlock.version === ref.version) {
        systemBlocks.push({
          id: systemBlock.id,
          version: systemBlock.version,
          title: systemBlock.title,
          definition: systemBlock.definition,
          source: "system_ref",
          order: order++,
        });
      } else {
        dropped.push({
          id: ref.id,
          reason: `System block not found or version mismatch (requested: ${ref.version})`,
        });
      }
    }
  }

  // Step 2: System mounted law (future: from pinned_context_ref)
  // Placeholder for v0

  // Step 3: System derived (future: dynamic policy based on thread context)
  // Placeholder for v0

  // Step 4: User inline blocks (LAST - applied after all system blocks)
  // Enforcement priority when limits exceeded:
  // 1. Drop user inline blocks first (these are dropped here)
  // 2. Drop extra refs (dropped in Step 1)
  // 3. Baseline blocks are NEVER dropped
  if (packet.driverBlockInline && packet.driverBlockInline.length > 0) {
    const inline = packet.driverBlockInline.slice(0, DRIVER_BLOCK_BOUNDS.MAX_INLINE);

    // Drop excess inline blocks (user blocks drop first when limits exceeded)
    if (packet.driverBlockInline.length > DRIVER_BLOCK_BOUNDS.MAX_INLINE) {
      for (let i = DRIVER_BLOCK_BOUNDS.MAX_INLINE; i < packet.driverBlockInline.length; i++) {
        dropped.push({
          id: packet.driverBlockInline[i].id,
          reason: `Exceeded MAX_INLINE limit (${DRIVER_BLOCK_BOUNDS.MAX_INLINE})`,
        });
      }
    }

    for (const block of inline) {
      let definition = block.definition;
      
      // Trim oversized definitions
      const originalBytes = utf8ByteLength(definition);
      if (originalBytes > DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_BYTES) {
        definition = trimToUtf8Bytes(definition, DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_BYTES);
        trimmed.push({
          id: block.id,
          originalLength: originalBytes,
          trimmedLength: utf8ByteLength(definition),
        });
      }

      userBlocks.push({
        id: block.id,
        version: block.version,
        title: block.title,
        definition,
        source: "user_inline",
        order: order++,
      });
    }
  }

  // Enforce total block limit (baseline blocks are excluded from this limit)
  const nonBaselineBlocks = [...systemBlocks, ...userBlocks];
  if (nonBaselineBlocks.length > DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS) {
    // Drop excess user blocks (system refs take priority)
    const excessCount = nonBaselineBlocks.length - DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS;
    const droppedUserBlocks = userBlocks.splice(-excessCount, excessCount);
    for (const block of droppedUserBlocks) {
      dropped.push({
        id: block.id,
        reason: `Exceeded MAX_TOTAL_BLOCKS limit (${DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS})`,
      });
    }
  }

  return {
    accepted: [...baselineBlocks, ...systemBlocks, ...userBlocks],
    dropped,
    trimmed,
  };
}

/**
 * Format Driver Blocks as a prompt section
 * Returns formatted text with blocks in order
 */
export function formatDriverBlocksForPrompt(blocks: AssembledDriverBlock[]): string {
  if (blocks.length === 0) {
    return "";
  }

  const systemBlocks = blocks.filter((b) => b.source !== "user_inline");
  const userBlocks = blocks.filter((b) => b.source === "user_inline");

  const parts: string[] = [];

  // System blocks first
  if (systemBlocks.length > 0) {
    parts.push("## System Policy");
    for (const block of systemBlocks) {
      parts.push(`### ${block.title || block.id}`);
      parts.push(block.definition);
      parts.push("");
    }
  }

  // User blocks last
  if (userBlocks.length > 0) {
    parts.push("## User Preferences");
    for (const block of userBlocks) {
      parts.push(`### ${block.title || block.id}`);
      parts.push(block.definition);
      parts.push("");
    }
  }

  return parts.join("\n");
}
