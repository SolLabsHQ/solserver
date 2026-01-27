import type { PacketInput } from "../contracts/chat";

export type Modality = "text" | "url" | "snippet" | "unknown";

export type ModalitySummary = {
  textCharCount: number;
  urlCount: number;
  snippetCount: number;
  attachmentCount: number;
};

export type NormalizeModalityOutput = {
  modalities: Modality[];
  modalitySummary: ModalitySummary;
};

export type GateInput = {
  messageText: string;
  urlHintCount: number;
  captureUrlCount: number;
  evidenceCounts: {
    captureCount: number;
    supportCount: number;
    claimCount: number;
    snippetCharTotal: number;
  };
};

/**
 * Normalize/Modality Gate (v0 heuristic)
 * 
 * Detects input modalities based on:
 * - Message text presence
 * - URL detection (inline + evidence captures)
 * - Text snippet evidence
 * 
 * Returns multiple modalities if multiple are present (no "mixed").
 */
export function runNormalizeModality(input: GateInput): NormalizeModalityOutput {
  const modalities: Modality[] = [];
  const urlCount = input.urlHintCount + input.captureUrlCount;
  
  // Detect text modality
  const hasText = input.messageText.trim().length > 0;
  if (hasText) {
    modalities.push("text");
  }
  
  // Detect URL modality (hint count + capture URL count, no validation here)
  if (urlCount > 0) {
    modalities.push("url");
  }
  
  // Detect snippet modality (from evidence snippet char total)
  if (input.evidenceCounts.snippetCharTotal > 0) {
    modalities.push("snippet");
  }
  
  // Fallback to unknown if no modalities detected
  if (modalities.length === 0) {
    modalities.push("unknown");
  }
  
  // Build modality summary
  const modalitySummary: ModalitySummary = {
    textCharCount: input.messageText.length,
    urlCount,
    snippetCount: input.evidenceCounts.supportCount, // Count of snippet supports
    attachmentCount: 0, // v0: no attachments yet
  };
  
  return {
    modalities,
    modalitySummary,
  };
}
