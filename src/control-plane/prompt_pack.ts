

import type { PacketInput, ModeDecision } from "../contracts/chat";
import { assembleDriverBlocks, formatDriverBlocksForPrompt, type AssembledDriverBlock, type DriverBlockEnforcementResult } from "./driver_blocks";

/**
 * PromptPack is the deterministic "spine" for provider calls.
 * We build it even when the provider is fake so later OpenAI wiring is a swap, not a rewrite.
 */

export type PromptRole = "system" | "user";

export type PromptSectionId = "law" | "retrieval" | "user_message";

export type RetrievalItemKind = "memento" | "bookmark" | "memory";

export type RetrievalItem = {
  id: string;
  kind: RetrievalItemKind;
  summary: string;
};

export type PromptSection = {
  id: PromptSectionId;
  role: PromptRole;
  title: string;
  content: string;
  meta?: {
    used_context_ids?: string[];
  };
};

export type PromptPack = {
  version: "prompt-pack-v0";
  modeDecision: ModeDecision;
  packet: PacketInput;
  sections: PromptSection[];
  driverBlocks: AssembledDriverBlock[]; // Driver Blocks in strict order
  driverBlockEnforcement: DriverBlockEnforcementResult; // Enforcement results (dropped/trimmed)
};

/**
 * Minimal mounted law for v0.
 * Later this will be loaded from a file and will include the full constraint manifest.
 * Driver Blocks are prepended to the law section.
 */
function buildMountedLaw(modeDecision: ModeDecision, driverBlocksText: string): string {
  const lines: string[] = [];

  // Driver Blocks first (if present)
  if (driverBlocksText) {
    lines.push("# Driver Blocks (Policy)");
    lines.push(driverBlocksText);
    lines.push("");
  }

  lines.push("# System Instructions");
  lines.push("You are SolServer running the Sol control plane.");
  lines.push("Follow the system constraints and keep outputs bounded.");
  lines.push("If you do not know something, say so plainly.");
  lines.push("Do not fabricate facts.");
  lines.push("");

  lines.push("Output contract (v0 placeholder):");
  lines.push("- Return a helpful assistant reply.");
  lines.push("- Prefer explicit assumptions and unknowns when needed.");
  lines.push("- This will become an OutputEnvelope in Step 7.");
  lines.push("");

  lines.push("ModeDecision:");
  lines.push(`- modeLabel: ${modeDecision.modeLabel}`);
  lines.push(`- domainFlags: ${(modeDecision.domainFlags ?? []).join(", ") || "(none)"}`);

  return lines.join("\n");
}

function formatRetrievalSection(items: RetrievalItem[]): { content: string; usedIds: string[] } {
  if (!items.length) {
    return { content: "(no retrieved context)", usedIds: [] };
  }

  const usedIds: string[] = [];
  const lines: string[] = [];

  for (const item of items) {
    usedIds.push(item.id);
    lines.push(`[${item.kind}:${item.id}] ${item.summary}`);
  }

  return { content: lines.join("\n"), usedIds };
}

/**
 * Build a deterministic PromptPack.
 * Order is fixed:
 * 1) law (system)
 * 2) retrieval (system)
 * 3) user_message (user)
 */
export function buildPromptPack(args: {
  packet: PacketInput;
  modeDecision: ModeDecision;
  retrievalItems: RetrievalItem[];
}): PromptPack {
  const { packet, modeDecision, retrievalItems } = args;

  // Assemble Driver Blocks with enforcement
  const driverBlockEnforcement = assembleDriverBlocks(packet);
  const driverBlocksText = formatDriverBlocksForPrompt(driverBlockEnforcement.accepted);

  const law = buildMountedLaw(modeDecision, driverBlocksText);
  const retrieval = formatRetrievalSection(retrievalItems);

  const sections: PromptSection[] = [
    {
      id: "law",
      role: "system",
      title: "Mounted law",
      content: law
    },
    {
      id: "retrieval",
      role: "system",
      title: "Retrieved context",
      content: retrieval.content,
      meta: { used_context_ids: retrieval.usedIds }
    },
    {
      id: "user_message",
      role: "user",
      title: "User message",
      content: packet.message
    }
  ];

  return {
    version: "prompt-pack-v0",
    modeDecision,
    packet,
    sections,
    driverBlocks: driverBlockEnforcement.accepted,
    driverBlockEnforcement,
  };
}

/**
 * Provider-friendly representation: array of role/content messages.
 * This matches common chat model APIs while keeping our internal pack structure.
 */
export function toModelMessages(pack: PromptPack): Array<{ role: PromptRole; content: string }> {
  return pack.sections.map((s) => ({ role: s.role, content: s.content }));
}

/**
 * Convenience for fake provider and debugging.
 * Produces a single stable string with section headers.
 */
export function toSinglePromptText(pack: PromptPack): string {
  const parts: string[] = [];

  for (const s of pack.sections) {
    parts.push(`## ${s.title} (${s.role})`);
    parts.push(s.content);
    parts.push("");
  }

  return parts.join("\n").trim();
}

function utf8ByteLength(text: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyGlobal: any = globalThis as any;
    if (anyGlobal.Buffer?.byteLength) return anyGlobal.Buffer.byteLength(text, "utf8");
  } catch {}

  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length; // fallback
  }
}

/**
 * Small helper for structured logs. Avoid logging full content by default.
 */
export function promptPackLogShape(pack: PromptPack): {
  version: PromptPack["version"];
  modeLabel: string;
  sectionBytes: Array<{ id: PromptSectionId; role: PromptRole; bytes: number }>;
  retrievalIds: string[];
} {
  const retrieval = pack.sections.find((s) => s.id === "retrieval");
  const retrievalIds = retrieval?.meta?.used_context_ids ?? [];

  return {
    version: pack.version,
    modeLabel: pack.modeDecision.modeLabel,
    sectionBytes: pack.sections.map((s) => ({
      id: s.id,
      role: s.role,
      bytes: utf8ByteLength(s.content ?? "")
    })),
    retrievalIds
  };
}