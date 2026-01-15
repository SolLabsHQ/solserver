import type { PacketInput } from "../contracts/chat";
import type { GateInput } from "./normalize_modality";
import { runNormalizeModality, type NormalizeModalityOutput } from "./normalize_modality";
import { runIntentRisk, type IntentRiskOutput } from "./intent_risk";
import { runLattice, type LatticeOutput } from "./lattice";
import type { GateOutput } from "./gate_interfaces";

export type GatesPipelineOutput = {
  results: GateOutput[];
  normalizeModality: NormalizeModalityOutput;
  intentRisk: IntentRiskOutput;
  lattice: LatticeOutput;
  evidenceCounts: {
    captureCount: number;
    supportCount: number;
    claimCount: number;
    snippetCharTotal: number;
  };
};

/**
 * Extract URLs from message text using simple regex
 */
function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  return text.match(urlRegex) || [];
}

/**
 * Build gate input from packet
 */
function buildGateInput(packet: PacketInput): GateInput {
  const messageText = packet.message;

  // Extract URLs from message text
  const inlineUrls = extractUrlsFromText(messageText);

  // Extract URLs from evidence captures
  const captureUrls = packet.evidence?.captures?.map((c) => c.url) || [];

  // Combine all URLs (dedupe)
  const allUrls = Array.from(new Set([...inlineUrls, ...captureUrls].filter(Boolean)));

  // Count evidence items
  const captureCount = packet.evidence?.captures?.length || 0;
  const supportCount = packet.evidence?.supports?.length || 0;
  const claimCount = packet.evidence?.claims?.length || 0;

  // Calculate snippet char total
  const snippetCharTotal =
    packet.evidence?.supports
      ?.filter((s) => s.type === "text_snippet" && s.snippetText)
      .reduce((sum, s) => sum + (s.snippetText?.length || 0), 0) || 0;

  return {
    messageText,
    urls: allUrls,
    evidenceCounts: {
      captureCount,
      supportCount,
      claimCount,
      snippetCharTotal,
    },
  };
}

/**
 * Run the gates pipeline
 *
 * Ordering:
 * 1. Normalize/Modality
 * 2. Intent/Risk
 * 3. Lattice (stub)
 */
export function runGatesPipeline(packet: PacketInput): GatesPipelineOutput {
  const gateInput = buildGateInput(packet);

  // Run gates in order
  const normalizeModality = runNormalizeModality(gateInput);
  const intentRisk = runIntentRisk(gateInput);
  const lattice = runLattice(gateInput);

  const results: GateOutput[] = [
    {
      gateName: "normalize_modality",
      status: "pass",
      summary: `Modalities: ${normalizeModality.modalities.join(", ")}`,
      metadata: {
        modalities: normalizeModality.modalities,
        modalitySummary: normalizeModality.modalitySummary,
        evidenceCounts: gateInput.evidenceCounts,
      },
    },
    {
      gateName: "intent_risk",
      status: "pass",
      summary: `Intent: ${intentRisk.intent}, Risk: ${intentRisk.risk}`,
      metadata: {
        intent: intentRisk.intent,
        risk: intentRisk.risk,
        riskReasons: intentRisk.riskReasons,
      },
    },
    {
      gateName: "lattice",
      status: "pass",
      summary: "Lattice stub (v0)",
      metadata: lattice,
    },
  ];

  return {
    results,
    normalizeModality,
    intentRisk,
    lattice,
    evidenceCounts: gateInput.evidenceCounts,
  };
}

