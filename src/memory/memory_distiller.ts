import { z } from "zod";

import { openAIJsonSchemaResponse } from "../providers/openai_model";
import type { MemoryKind } from "../store/control_plane_store";

const MemoryKindSchema = z.enum([
  "preference",
  "fact",
  "workflow",
  "relationship",
  "constraint",
  "project",
  "other",
]);

const DistillSchema = z.object({
  snippet: z.string().min(1),
  summary: z.string().min(1),
  memory_kind: MemoryKindSchema,
}).strict();

const DISTILL_SCHEMA_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["snippet", "summary", "memory_kind"],
  properties: {
    snippet: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 600 },
    memory_kind: {
      type: "string",
      enum: [
        "preference",
        "fact",
        "workflow",
        "relationship",
        "constraint",
        "project",
        "other",
      ],
    },
  },
} as const;

const MAX_SNIPPET_CHARS = 200;
const MAX_SUMMARY_LINES = 3;
const PRIMARY_MODEL = "gpt-5-mini";
const FALLBACK_MODEL = "gpt-5.2";

const normalizeLine = (text: string) => text.replace(/\s+/g, " ").trim();

const summaryLines = (summary: string) =>
  summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const hasTranscriptMarkers = (text: string) =>
  /\b(User|Assistant|System):/i.test(text);

const hasBoilerplate = (summary: string) => {
  const lowered = summary.toLowerCase();
  const patterns = [
    "as an ai",
    "i can help",
    "i'm here",
    "let me know",
    "happy to help",
    "feel free",
    "sure thing",
    "of course",
    "no problem",
  ];
  return patterns.some((p) => lowered.includes(p));
};

const extractFactToken = (snippet: string): string | null => {
  const lowered = snippet.toLowerCase();
  const patterns: RegExp[] = [
    /\bmy name is ([a-zA-Z][\w'-]*(?:\s+[a-zA-Z][\w'-]*){0,2})/i,
    /\bcall me ([a-zA-Z][\w'-]*(?:\s+[a-zA-Z][\w'-]*){0,2})/i,
    /\bpreferred name[:\s]+([a-zA-Z][\w'-]*(?:\s+[a-zA-Z][\w'-]*){0,2})/i,
    /\bname[:\s]+([a-zA-Z][\w'-]*(?:\s+[a-zA-Z][\w'-]*){0,2})/i,
  ];
  for (const pattern of patterns) {
    const match = snippet.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  if (lowered.includes("name")) {
    return null;
  }
  return null;
};

const validateDistillOutput = (raw: z.infer<typeof DistillSchema>) => {
  const snippet = raw.snippet.trim();
  const summary = raw.summary.trim();

  if (!snippet || snippet.length > MAX_SNIPPET_CHARS) {
    return { ok: false, reason: "snippet_length" as const };
  }
  if (snippet.includes("\n") || hasTranscriptMarkers(snippet)) {
    return { ok: false, reason: "snippet_transcript" as const };
  }

  const lines = summaryLines(summary);
  if (lines.length === 0 || lines.length > MAX_SUMMARY_LINES) {
    return { ok: false, reason: "summary_lines" as const };
  }
  if (hasTranscriptMarkers(summary)) {
    return { ok: false, reason: "summary_transcript" as const };
  }
  if (hasBoilerplate(summary)) {
    return { ok: false, reason: "summary_boilerplate" as const };
  }

  const token = extractFactToken(snippet);
  if (token) {
    const tokenLower = token.toLowerCase();
    if (!summary.toLowerCase().includes(tokenLower)) {
      return { ok: false, reason: "summary_missing_fact" as const };
    }
  }

  return {
    ok: true as const,
    snippet: normalizeLine(snippet),
    summary,
    memoryKind: raw.memory_kind,
  };
};

const buildPrompt = (args: {
  messages: Array<{ role: string; content: string }>;
  memoryKindHint?: MemoryKind | null;
}) => {
  const hint = args.memoryKindHint ? `User-selected memory_kind: ${args.memoryKindHint}` : "User-selected memory_kind: (none)";
  const contextLines = args.messages.map((msg) => `${msg.role}: ${msg.content}`);
  return [
    "You are a memory distiller.",
    "Return JSON only with keys: snippet, summary, memory_kind.",
    "snippet must be a single line, <= 200 chars, no role prefixes.",
    "summary must be 1-3 lines, no greetings or boilerplate, include key specifics.",
    `memory_kind must be one of: ${MemoryKindSchema.options.join(", ")}.`,
    hint,
    "",
    "Conversation span:",
    ...contextLines,
  ].join("\n");
};

const fakeDistill = (messages: Array<{ role: string; content: string }>, memoryKindHint?: MemoryKind | null) => {
  const userMessages = messages.filter((msg) => msg.role === "user").map((msg) => msg.content);
  const nameCandidate = [...userMessages].reverse().find((content) =>
    /\b(my name is|call me|preferred name|name:)/i.test(content)
  );
  const lastUser = [...userMessages].reverse()[0] ?? "";
  const normalized = normalizeLine(nameCandidate ?? lastUser);
  let memoryKind: MemoryKind = memoryKindHint ?? "fact";
  const lower = normalized.toLowerCase();
  if (!memoryKindHint) {
    if (lower.includes("prefer") || lower.includes("like") || lower.includes("favorite")) {
      memoryKind = "preference";
    } else if (lower.includes("workflow") || lower.includes("routine")) {
      memoryKind = "workflow";
    } else if (lower.includes("project")) {
      memoryKind = "project";
    }
  }

  let snippet = normalized.slice(0, MAX_SNIPPET_CHARS);
  let summary = snippet;
  const nameMatch =
    normalized.match(/\bmy name is ([a-zA-Z][\w'-]*(?:\s+[a-zA-Z][\w'-]*){0,2})/i)
    ?? normalized.match(/\bcall me ([a-zA-Z][\w'-]*(?:\s+[a-zA-Z][\w'-]*){0,2})/i);
  if (nameMatch && nameMatch[1]) {
    const name = nameMatch[1].trim();
    snippet = `Preferred name: ${name}`;
    summary = `User's name is ${name}.`;
    memoryKind = memoryKindHint ?? "fact";
  }

  return {
    snippet,
    summary,
    memory_kind: memoryKind,
  };
};

export async function distillMemorySpan(args: {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  memoryKindHint?: MemoryKind | null;
  requestId?: string;
  threadId?: string;
  logger?: {
    info?: (obj: any, msg?: string) => void;
    warn?: (obj: any, msg?: string) => void;
    error?: (obj: any, msg?: string) => void;
  };
}): Promise<{
  snippet: string;
  summary: string;
  memoryKind: MemoryKind;
  modelUsed: "gpt-5-mini" | "gpt-5.2";
  distillAttempts: 1 | 2;
}> {
  const provider = (process.env.LLM_PROVIDER ?? "fake").toLowerCase() === "openai"
    ? "openai"
    : "fake";

  if (provider !== "openai") {
    const fake = fakeDistill(args.messages, args.memoryKindHint);
    const validated = DistillSchema.safeParse(fake);
    if (!validated.success) {
      throw new Error("distill_fake_invalid");
    }
    const checked = validateDistillOutput(validated.data);
    if (!checked.ok) {
      throw new Error(`distill_fake_failed:${checked.reason}`);
    }
    return {
      snippet: checked.snippet,
      summary: checked.summary,
      memoryKind: checked.memoryKind,
      modelUsed: PRIMARY_MODEL,
      distillAttempts: 1,
    };
  }

  const attempt = async (model: "gpt-5-mini" | "gpt-5.2") => {
    const promptText = buildPrompt({
      messages: args.messages,
      memoryKindHint: args.memoryKindHint,
    });
    const response = await openAIJsonSchemaResponse({
      promptText,
      schema: DISTILL_SCHEMA_JSON,
      schemaName: "memory_distill_v0",
      model,
      maxOutputTokens: 250,
      temperature: 0.2,
      logger: args.logger,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.rawText);
    } catch {
      throw new Error("distill_invalid_json");
    }

    const validated = DistillSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error("distill_schema_invalid");
    }

    const checked = validateDistillOutput(validated.data);
    if (!checked.ok) {
      throw new Error(`distill_quality:${checked.reason}`);
    }

    return {
      snippet: checked.snippet,
      summary: checked.summary,
      memoryKind: checked.memoryKind,
      modelUsed: model,
    };
  };

  try {
    const primary = await attempt(PRIMARY_MODEL);
    return { ...primary, distillAttempts: 1 };
  } catch (error) {
    args.logger?.warn?.({ err: String(error), requestId: args.requestId }, "memory_distill.retry");
    const fallback = await attempt(FALLBACK_MODEL);
    return { ...fallback, distillAttempts: 2 };
  }
}
