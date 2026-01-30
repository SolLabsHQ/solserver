

import type { PacketInput, ModeDecision } from "../contracts/chat";
import type { EvidencePack, EvidenceItem } from "../evidence/evidence_provider";
import { assembleDriverBlocks, formatDriverBlocksForPrompt, type AssembledDriverBlock, type DriverBlockEnforcementResult } from "./driver_blocks";
import { buildSpineV1OutputContract } from "./spine_v1";
import { resolvePersonaLabel } from "./router";

/**
 * PromptPack is the deterministic "spine" for provider calls.
 * We build it even when the provider is fake so later OpenAI wiring is a swap, not a rewrite.
 */

export type PromptRole = "system" | "user";

export type PromptSectionId = "law" | "correction" | "retrieval" | "evidence_pack" | "user_message";

export type RetrievalItemKind = "memento" | "bookmark" | "memory" | "policy";

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
  evidencePack?: EvidencePack | null;
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
  lines.push(buildSpineV1OutputContract());
  lines.push("");

  lines.push("ModeDecision:");
  lines.push(`- modeLabel: ${modeDecision.modeLabel}`);
  lines.push(`- personaLabel: ${resolvePersonaLabel(modeDecision)}`);
  lines.push(`- domainFlags: ${(modeDecision.domainFlags ?? []).join(", ") || "(none)"}`);

  return lines.join("\n");
}

function formatRetrievalSection(items: RetrievalItem[]): { content: string; usedIds: string[] } {
  if (!items.length) {
    return { content: "(no retrieved context)", usedIds: [] };
  }

  const usedIds: string[] = [];
  for (const item of items) {
    usedIds.push(item.id);
  }

  const lines: string[] = [];
  const threadItems = items.filter((item) => item.kind === "memento" || item.kind === "bookmark");
  const memoryItems = items.filter((item) => item.kind === "memory");
  const policyItems = items.filter((item) => item.kind === "policy");

  if (threadItems.length > 0) {
    lines.push("Thread context:");
    for (const item of threadItems) {
      lines.push(`[${item.kind}:${item.id}] ${item.summary}`);
    }
  }

  if (memoryItems.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Memory:");
    for (const item of memoryItems) {
      lines.push(`[${item.kind}:${item.id}] ${item.summary}`);
    }
  }

  if (policyItems.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Governance:");
    for (const item of policyItems) {
      lines.push(`[${item.kind}:${item.id}] ${item.summary}`);
    }
  }

  return { content: lines.join("\n"), usedIds };
}

function formatEvidenceItem(item: EvidenceItem): string {
  const lines: string[] = [];
  lines.push(`- evidence_id: ${item.evidenceId}`);
  lines.push(`  kind: ${item.kind}`);
  if (item.title) lines.push(`  title: ${item.title}`);
  if (item.sourceUrl) lines.push(`  source_url: ${item.sourceUrl}`);
  if (item.excerptText) lines.push(`  excerpt_text: ${item.excerptText}`);
  if (item.spans && item.spans.length > 0) {
    lines.push("  spans:");
    for (const span of item.spans) {
      const spanLine = span.text
        ? `    - span_id: ${span.spanId} | text: ${span.text}`
        : `    - span_id: ${span.spanId}`;
      lines.push(spanLine);
    }
  }
  return lines.join("\n");
}

function formatEvidencePackForPrompt(pack: EvidencePack | null | undefined): string {
  if (!pack || pack.items.length === 0) {
    return "(no evidence pack)";
  }

  const lines: string[] = [];
  lines.push(`pack_id: ${pack.packId}`);
  lines.push("items:");
  for (const item of pack.items) {
    lines.push(formatEvidenceItem(item));
  }
  return lines.join("\n");
}

/**
 * Build a deterministic PromptPack.
 * Order is fixed:
 * 1) law (system)
 * 2) retrieval (system)
 * 3) user_message (user)
 */
export function withCorrectionSection(pack: PromptPack, correctionText: string): PromptPack {
  const text = correctionText.trim();
  if (!text) return pack;

  const sections: PromptSection[] = [];
  for (const section of pack.sections) {
    sections.push(section);
    if (section.id === "law") {
      sections.push({
        id: "correction",
        role: "system",
        title: "Correction",
        content: text,
      });
    }
  }

  return { ...pack, sections };
}

export function buildPromptPack(args: {
  packet: PacketInput;
  modeDecision: ModeDecision;
  retrievalItems: RetrievalItem[];
  evidencePack?: EvidencePack | null;
}): PromptPack {
  const { packet, modeDecision, retrievalItems, evidencePack } = args;

  // Assemble Driver Blocks with enforcement
  const driverBlockEnforcement = assembleDriverBlocks(packet);
  const driverBlocksText = formatDriverBlocksForPrompt(driverBlockEnforcement.accepted);

  const law = buildMountedLaw(modeDecision, driverBlocksText);
  const retrieval = formatRetrievalSection(retrievalItems);
  const evidencePackText = formatEvidencePackForPrompt(evidencePack);

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
      id: "evidence_pack",
      role: "system",
      title: "Evidence Pack",
      content: evidencePackText
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
    evidencePack,
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
