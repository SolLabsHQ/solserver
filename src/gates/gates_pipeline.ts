import type { PacketInput } from "../contracts/chat";
import type { GateInput } from "./normalize_modality";
import { runNormalizeModality, type NormalizeModalityOutput } from "./normalize_modality";
import { runIntentRisk, type IntentRiskOutput } from "./intent_risk";
import { runLattice, type LatticeOutput } from "./lattice";
import { GATE_SENTINEL, type GateOutput } from "./gate_interfaces";
import { extractUrls } from "./url_extraction";

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

function redactUrlForTrace(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    const hostAndPath = url.host + url.pathname;
    if (hostAndPath.length > 50) {
      return hostAndPath.substring(0, 47) + "...";
    }
    return hostAndPath;
  } catch {
    return null;
  }
}

/**
 * Build gate input from packet
 */
function buildGateInput(packet: PacketInput): {
  gateInput: GateInput;
  inlineUrls: string[];
  urlWarningsCount: number;
} {
  const messageText = packet.message;

  // Extract URLs from message text (robust, fail-open)
  const extracted = extractUrls(messageText);
  const inlineUrls = extracted.urls;
  const urlWarningsCount = extracted.warnings.length;

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
    gateInput: {
      messageText,
      urls: allUrls,
      evidenceCounts: {
        captureCount,
        supportCount,
        claimCount,
        snippetCharTotal,
      },
    },
    inlineUrls,
    urlWarningsCount,
  };
}

/**
 * Run the gates pipeline
 *
 * Ordering:
 * 1. Normalize/Modality
 * 2. URL Extraction
 * 3. Intent/Risk
 * 4. Lattice (stub)
 */
export function runGatesPipeline(packet: PacketInput): GatesPipelineOutput {
  const { gateInput, inlineUrls, urlWarningsCount } = buildGateInput(packet);
  const captureUrls = packet.evidence?.captures?.map((c) => c.url) || [];
  const urlPreviews = inlineUrls
    .map((url) => redactUrlForTrace(url))
    .filter((url): url is string => Boolean(url))
    .slice(0, 10);

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
      gateName: "url_extraction",
      status: "pass",
      summary: `URLs: inline=${inlineUrls.length}, captures=${captureUrls.length}, total=${gateInput.urls.length}`,
      metadata: {
        inlineUrlCount: inlineUrls.length,
        captureUrlCount: captureUrls.length,
        totalUrlCount: gateInput.urls.length,
        warningsCount: urlWarningsCount,
        urlPreviews,
      },
    },
    {
      gateName: GATE_SENTINEL,
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
