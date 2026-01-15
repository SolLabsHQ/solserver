import type { AssembledDriverBlock } from "../control-plane/driver_blocks";

export type PostLinterViolation = {
  blockId: string;
  rule: "must-not" | "must-have";
  pattern: string;
};

export type PostLinterResult =
  | { ok: true }
  | { ok: false; violations: PostLinterViolation[] };

type ParsedRule = {
  rule: "must-not" | "must-have";
  pattern: string;
};

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
  modeLabel: string;
  content: string;
  driverBlocks: AssembledDriverBlock[];
}): PostLinterResult {
  const contentLower = args.content.toLowerCase();
  const violations: PostLinterViolation[] = [];

  for (const block of args.driverBlocks) {
    const rules = parseValidatorsFromDefinition(block.definition);
    for (const rule of rules) {
      const patternLower = rule.pattern.toLowerCase();
      if (rule.rule === "must-not") {
        if (contentLower.includes(patternLower)) {
          violations.push({
            blockId: block.id,
            rule: "must-not",
            pattern: rule.pattern,
          });
        }
      } else {
        if (!contentLower.includes(patternLower)) {
          violations.push({
            blockId: block.id,
            rule: "must-have",
            pattern: rule.pattern,
          });
        }
      }
    }
  }

  if (violations.length === 0) {
    return { ok: true };
  }

  return { ok: false, violations };
}
