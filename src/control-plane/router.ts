import type { PacketInput, ModeDecision } from "../contracts/chat"; 

export type PersonaLabel = "ida" | "sole" | "cassandra" | "diogenes" | "system";

export function resolvePersonaLabel(modeDecision: ModeDecision): PersonaLabel {
  if (modeDecision.personaLabel) return modeDecision.personaLabel;

  switch (modeDecision.modeLabel) {
    case "Ida":
      return "ida";
    case "Sole":
      return "sole";
    case "System-mode":
      return "cassandra";
    default:
      return "ida";
  }
}

export function routeMode(packet: PacketInput): ModeDecision {
  const msg = packet.message;

  // Step 0 — hard overrides (high-rigor)
  const highRigor = /\b(finance|tax|legal|contract|architecture|adr|security)\b/i.test(msg);
  if (highRigor) {
    return {
      modeLabel: "System-mode",
      personaLabel: "cassandra",
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
      personaLabel: "sole",
      domainFlags: ["relationship"],
      confidence: 0.8,
      checkpointNeeded: false,
      reasons: ["reflective_cues"],
      version: "mode-engine-v0",
    };
  }

  return {
    modeLabel: "Ida",
    personaLabel: "ida",
    domainFlags: [],
    confidence: 0.7,
    checkpointNeeded: false,
    reasons: ["default"],
    version: "mode-engine-v0",
  };
}
