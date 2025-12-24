import type { PacketInput, ModeDecision } from "../contracts/chat"; 

export function routeMode(packet: PacketInput): ModeDecision {
  const msg = packet.message;

  // Step 0 — hard overrides (high-rigor)
  const highRigor = /\b(finance|tax|legal|contract|architecture|adr|security)\b/i.test(msg);
  if (highRigor) {
    return {
      modeLabel: "System-mode",
      domainFlags: ["high-rigor"],
      confidence: 1.0,
      checkpointNeeded: true,
      reasons: ["high_rigor_keyword"],
      version: "mode-engine-v0",
    };
  }

  // Step 1 — lightweight classifier
  const reflective = /\b(feel|worried|anxious|relationship|family)\b/i.test(msg);
  if (reflective) {
    return {
      modeLabel: "Sole",
      domainFlags: ["relationship"],
      confidence: 0.8,
      checkpointNeeded: false,
      reasons: ["reflective_cues"],
      version: "mode-engine-v0",
    };
  }

  return {
    modeLabel: "Ida",
    domainFlags: [],
    confidence: 0.7,
    checkpointNeeded: false,
    reasons: ["default"],
    version: "mode-engine-v0",
  };
}