import type { PacketInput, DriverBlockRef, DriverBlockInline } from "../contracts/chat";

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

export type DriverBlockSource = "system_ref" | "system_mounted_law" | "system_derived" | "user_inline";

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
  mismatch: boolean; // True if mode="default" but custom blocks were present
  mismatchDetails?: { // Only present if mismatch=true
    droppedRefsCount: number;
    droppedInlineCount: number;
  };
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
  MAX_INLINE: 5, // Max user inline blocks
  MAX_DEFINITION_LENGTH: 10_000, // Max chars per definition
  MAX_TOTAL_BLOCKS: 15, // Max total blocks (system + user)
};

/**
 * Assemble Driver Blocks from packet in strict order:
 * 1. System refs (from packet.driverBlockRefs)
 * 2. System mounted law (future: pinned context)
 * 3. System derived (future: dynamic policy)
 * 4. User inline (from packet.driverBlockInline) - LAST
 *
 * driver_block_mode semantics:
 * - "default" (or omitted): Apply system baseline only, ignore custom blocks
 * - "custom": Apply system baseline + custom blocks with strict ordering
 */
export function assembleDriverBlocks(packet: PacketInput): DriverBlockEnforcementResult {
  const systemBlocks: AssembledDriverBlock[] = [];
  const userBlocks: AssembledDriverBlock[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  const trimmed: Array<{ id: string; originalLength: number; trimmedLength: number }> = [];
  let mismatch = false;
  let mismatchDetails: { droppedRefsCount: number; droppedInlineCount: number } | undefined;

  let order = 0;

  // Determine effective mode (default to "default" if omitted)
  const mode = packet.driverBlockMode ?? "default";

  // Check for mismatch: mode="default" but custom blocks present
  if (mode === "default") {
    const hasCustomRefs = packet.driverBlockRefs && packet.driverBlockRefs.length > 0;
    const hasCustomInline = packet.driverBlockInline && packet.driverBlockInline.length > 0;
    
    if (hasCustomRefs || hasCustomInline) {
      mismatch = true;
      mismatchDetails = {
        droppedRefsCount: packet.driverBlockRefs?.length ?? 0,
        droppedInlineCount: packet.driverBlockInline?.length ?? 0,
      };
      
      // Drop all custom blocks with mismatch reason
      if (hasCustomRefs) {
        for (const ref of packet.driverBlockRefs!) {
          dropped.push({
            id: ref.id,
            reason: `driver_block_mode="default" but custom refs present (client mismatch)`,
          });
        }
      }
      if (hasCustomInline) {
        for (const block of packet.driverBlockInline!) {
          dropped.push({
            id: block.id,
            reason: `driver_block_mode="default" but custom inline blocks present (client mismatch)`,
          });
        }
      }
      
      // Return early with no custom blocks applied
      return {
        accepted: [],
        dropped,
        trimmed,
        mismatch,
        mismatchDetails,
      };
    }
  }

  // Step 1: System refs (from packet.driverBlockRefs)
  if (packet.driverBlockRefs && packet.driverBlockRefs.length > 0) {
    const refs = packet.driverBlockRefs.slice(0, DRIVER_BLOCK_BOUNDS.MAX_REFS);
    
    // Drop excess refs
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
  if (packet.driverBlockInline && packet.driverBlockInline.length > 0) {
    const inline = packet.driverBlockInline.slice(0, DRIVER_BLOCK_BOUNDS.MAX_INLINE);

    // Drop excess inline blocks
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
      if (definition.length > DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_LENGTH) {
        trimmed.push({
          id: block.id,
          originalLength: definition.length,
          trimmedLength: DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_LENGTH,
        });
        definition = definition.slice(0, DRIVER_BLOCK_BOUNDS.MAX_DEFINITION_LENGTH);
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

  // Enforce total block limit
  const allBlocks = [...systemBlocks, ...userBlocks];
  if (allBlocks.length > DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS) {
    // Drop excess user blocks (system blocks take priority)
    const excessCount = allBlocks.length - DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS;
    const droppedUserBlocks = userBlocks.splice(-excessCount, excessCount);
    for (const block of droppedUserBlocks) {
      dropped.push({
        id: block.id,
        reason: `Exceeded MAX_TOTAL_BLOCKS limit (${DRIVER_BLOCK_BOUNDS.MAX_TOTAL_BLOCKS})`,
      });
    }
  }

  return {
    accepted: [...systemBlocks, ...userBlocks],
    dropped,
    trimmed,
    mismatch,
    mismatchDetails,
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
