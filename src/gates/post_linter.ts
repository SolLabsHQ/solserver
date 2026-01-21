import type { ModeDecision } from "../contracts/chat";
import { resolvePersonaLabel } from "../control-plane/router";
import type { AssembledDriverBlock } from "../control-plane/driver_blocks";

export type PostLinterViolation = {
  blockId: string;
  rule: "must-not" | "must-have";
  pattern: string;
};

export type PostLinterBlockResult = {
  blockId: string;
  ok: boolean;
  reason?: {
    rule: "must-not" | "must-have";
    pattern: string;
  };
  durationMs: number;
};

export type PostLinterResult =
  | { ok: true; blockResults: PostLinterBlockResult[]; warnings?: PostLinterViolation[]; skipped?: boolean }
  | { ok: false; violations: PostLinterViolation[]; blockResults: PostLinterBlockResult[] };

type ParsedRule = {
  rule: "must-not" | "must-have";
  pattern: string;
};

export type DriverBlockEnforcementMode = "strict" | "warn" | "off";

const HIGH_RIGOR_DOMAIN_FLAGS = new Set([
  "finance",
  "legal",
  "schemas",
  "governance",
  "security",
  "ip",
  "high-rigor",
]);

function normalizeEnforcementMode(value?: string): DriverBlockEnforcementMode {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "warn" || raw === "off" || raw === "strict") return raw;
  return "strict";
}

function expandSlashPattern(pattern: string): string[] {
  const parts = pattern.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [pattern];
  }

  const first = parts[0];
  const lastSpace = first.lastIndexOf(" ");
  if (lastSpace === -1) {
    return parts;
  }

  const prefix = first.slice(0, lastSpace);
  const firstToken = first.slice(lastSpace + 1);
  const expanded: string[] = [];

  if (prefix) {
    expanded.push(`${prefix} ${firstToken}`.trim());
    for (const part of parts.slice(1)) {
      expanded.push(`${prefix} ${part}`.trim());
    }
    return expanded;
  }

  return parts;
}

function extractQuotedPatterns(text: string): string[] {
  const patterns: string[] = [];
  const regex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    patterns.push(match[1]);
  }
  return patterns;
}

export function parseValidatorsFromDefinition(definition: string): ParsedRule[] {
  const lines = definition.split(/\r?\n/);
  const validatorsIndex = lines.findIndex((line) => line.trim().startsWith("Validators:"));
  if (validatorsIndex === -1) return [];

  const rules: ParsedRule[] = [];

  for (const line of lines.slice(validatorsIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) {
      continue;
    }

    const match = trimmed.match(/^\-\s*(Must-not|Must-have|Must):\s*(.*)$/i);
    if (!match) continue;

    const kindRaw = match[1].toLowerCase();
    const text = match[2];
    const quoted = extractQuotedPatterns(text);
    if (quoted.length === 0) {
      continue;
    }

    const ruleKind: "must-not" | "must-have" =
      kindRaw === "must-not" ? "must-not" : "must-have";

    for (const pattern of quoted) {
      for (const expanded of expandSlashPattern(pattern)) {
        rules.push({ rule: ruleKind, pattern: expanded });
      }
    }
  }

  return rules;
}

export function postOutputLinter(args: {
  modeDecision: ModeDecision;
  content: string;
  driverBlocks: AssembledDriverBlock[];
  enforcementMode?: DriverBlockEnforcementMode;
}): PostLinterResult {
  const enforcementMode = normalizeEnforcementMode(args.enforcementMode);
  if (enforcementMode === "off") {
    return { ok: true, blockResults: [], warnings: [], skipped: true };
  }

  const personaLabel = resolvePersonaLabel(args.modeDecision);
  const domainFlags = args.modeDecision.domainFlags ?? [];
  const hasHighRigorDomain = domainFlags.some((flag) =>
    HIGH_RIGOR_DOMAIN_FLAGS.has(String(flag).toLowerCase())
  );
  const shouldBypassDb003 =
    personaLabel === "ida"
    && !args.modeDecision.checkpointNeeded
    && !hasHighRigorDomain;

  const contentLower = args.content.toLowerCase();
  const violations: PostLinterViolation[] = [];
  const warnings: PostLinterViolation[] = [];
  const blockResults: PostLinterBlockResult[] = [];

  for (const block of args.driverBlocks) {
    const startedAt = Date.now();
    const blockViolations: PostLinterViolation[] = [];
    const blockWarnings: PostLinterViolation[] = [];
    const rules = parseValidatorsFromDefinition(block.definition);
    for (const rule of rules) {
      const patternLower = rule.pattern.toLowerCase();
      if (rule.rule === "must-not") {
        if (contentLower.includes(patternLower)) {
          const violation: PostLinterViolation = {
            blockId: block.id,
            rule: "must-not",
            pattern: rule.pattern,
          };
          const treatAsWarning =
            enforcementMode === "warn"
            || (block.id === "DB-003" && shouldBypassDb003);
          if (treatAsWarning) {
            warnings.push(violation);
            blockWarnings.push(violation);
          } else {
            violations.push(violation);
            blockViolations.push(violation);
          }
        }
      } else {
        if (!contentLower.includes(patternLower)) {
          const violation: PostLinterViolation = {
            blockId: block.id,
            rule: "must-have",
            pattern: rule.pattern,
          };
          const treatAsWarning =
            enforcementMode === "warn"
            || (block.id === "DB-003" && shouldBypassDb003);
          if (treatAsWarning) {
            warnings.push(violation);
            blockWarnings.push(violation);
          } else {
            violations.push(violation);
            blockViolations.push(violation);
          }
        }
      }
    }
    const durationMs = Date.now() - startedAt;
    const firstViolation = blockViolations[0] ?? blockWarnings[0];
    blockResults.push({
      blockId: block.id,
      ok: blockViolations.length === 0 && blockWarnings.length === 0,
      reason: firstViolation
        ? { rule: firstViolation.rule, pattern: firstViolation.pattern }
        : undefined,
      durationMs,
    });
  }

  if (violations.length === 0) {
    return { ok: true, blockResults, warnings };
  }

  return { ok: false, violations, blockResults };
}
