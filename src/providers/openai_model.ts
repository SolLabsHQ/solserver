export class OpenAIProviderError extends Error {
  statusCode: number;
  retryable: boolean;
  errorType?: string;
  errorCode?: string;
  retryAfterMs?: number;

  constructor(
    message: string,
    args: {
      statusCode?: number;
      retryable?: boolean;
      errorType?: string;
      errorCode?: string;
      retryAfterMs?: number;
    } = {}
  ) {
    super(message);
    this.name = "OpenAIProviderError";
    this.statusCode = args.statusCode ?? 502;
    this.retryable = args.retryable ?? true;
    this.errorType = args.errorType;
    this.errorCode = args.errorCode;
    this.retryAfterMs = args.retryAfterMs;
  }
}

const OUTPUT_ENVELOPE_V0_MIN_SCHEMA_RAW = {
  type: "object",
  additionalProperties: false,
  required: [
    "assistant_text",
    "assumptions",
    "unknowns",
    "used_context_ids",
    "notification_policy",
    "meta",
  ],
  properties: {
    assistant_text: { type: "string", minLength: 1 },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
    unknowns: {
      type: "array",
      items: { type: "string" },
    },
    used_context_ids: {
      type: "array",
      items: { type: "string" },
    },
    notification_policy: {
      type: "string",
      enum: ["silent", "muted", "alert", "urgent"],
    },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["meta_version"],
      properties: {
        meta_version: { type: "string", enum: ["v1"] },
      },
    },
  },
} as const;

const sanitizeJsonSchema = (schema: any): any => {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);

  const copy: Record<string, any> = { ...schema };

  if (copy.type === "object") {
    if (copy.additionalProperties === undefined) {
      copy.additionalProperties = false;
    }
    if (copy.properties && typeof copy.properties === "object") {
      const nextProps: Record<string, any> = {};
      for (const [key, value] of Object.entries(copy.properties)) {
        nextProps[key] = sanitizeJsonSchema(value);
      }
      copy.properties = nextProps;
    }
  }

  if (copy.items) {
    copy.items = sanitizeJsonSchema(copy.items);
  }
  if (Array.isArray(copy.anyOf)) {
    copy.anyOf = copy.anyOf.map(sanitizeJsonSchema);
  }
  if (Array.isArray(copy.oneOf)) {
    copy.oneOf = copy.oneOf.map(sanitizeJsonSchema);
  }
  if (Array.isArray(copy.allOf)) {
    copy.allOf = copy.allOf.map(sanitizeJsonSchema);
  }

  return copy;
};

const OUTPUT_ENVELOPE_V0_MIN_SCHEMA = sanitizeJsonSchema(OUTPUT_ENVELOPE_V0_MIN_SCHEMA_RAW);

export async function openAIModelReplyWithMeta(input: {
  promptText: string;
  modeLabel: string;
  model?: string;
  logger?: {
    error?: (obj: any, msg?: string) => void;
    warn?: (obj: any, msg?: string) => void;
    info?: (obj: any, msg?: string) => void;
    debug?: (obj: any, msg?: string) => void;
  };
}): Promise<{ rawText: string; mementoDraft: null }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = input.model ?? process.env.OPENAI_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const textFormatMode = (process.env.OPENAI_TEXT_FORMAT ?? "json_schema").toLowerCase();

  if (!apiKey) {
    throw new OpenAIProviderError("OPENAI_API_KEY missing", {
      statusCode: 500,
      retryable: false,
    });
  }
  if (!model) {
    throw new OpenAIProviderError("OPENAI_MODEL missing", {
      statusCode: 500,
      retryable: false,
    });
  }

  const textFormat = textFormatMode === "json_object"
    ? { type: "json_object" as const }
    : {
        type: "json_schema" as const,
        name: "output_envelope_v0_min",
        strict: true,
        schema: OUTPUT_ENVELOPE_V0_MIN_SCHEMA,
      };

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      store: false,
      stream: false,
      input: input.promptText,
      text: {
        format: textFormat,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const errorType = parsed?.error?.type as string | undefined;
    const errorCode = parsed?.error?.code as string | undefined;
    const errorMessage = parsed?.error?.message as string | undefined;
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const bodySnippet = (errorMessage ?? text).slice(0, 500);
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader
      ? (() => {
          const seconds = Number(retryAfterHeader);
          if (!Number.isNaN(seconds)) {
            return Math.max(0, Math.floor(seconds * 1000));
          }
          const retryDate = Date.parse(retryAfterHeader);
          if (!Number.isNaN(retryDate)) {
            return Math.max(0, retryDate - Date.now());
          }
          return undefined;
        })()
      : undefined;
    const isInvalidSchema = errorType === "invalid_request_error"
      && errorCode === "invalid_json_schema";
    const isInvalidRequest = errorType === "invalid_request_error";
    const retryable = !isInvalidRequest;
    const statusCode = res.status;
    input.logger?.error?.(
      { statusCode, requestId, bodySnippet, errorType, errorCode },
      "openai.request_failed"
    );
    throw new OpenAIProviderError(`OpenAI error ${statusCode}: ${bodySnippet}`, {
      statusCode,
      retryable,
      errorType,
      errorCode,
      retryAfterMs: isInvalidSchema ? undefined : retryAfterMs,
    });
  }

  const data = await res.json();
  let content: string | undefined;

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const part of contentItems) {
      if (typeof part?.text === "string") {
        content = part.text;
        break;
      }
    }
    if (content) break;
  }

  if (!content && typeof data?.output_text === "string") {
    content = data.output_text;
  }

  if (!content || typeof content !== "string") {
    throw new OpenAIProviderError("OpenAI response missing content", {
      statusCode: 502,
      retryable: true,
    });
  }

  return { rawText: content, mementoDraft: null };
}

export async function openAIJsonSchemaResponse(input: {
  promptText: string;
  schema: any;
  schemaName: string;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
  logger?: {
    error?: (obj: any, msg?: string) => void;
    warn?: (obj: any, msg?: string) => void;
    info?: (obj: any, msg?: string) => void;
    debug?: (obj: any, msg?: string) => void;
  };
}): Promise<{ rawText: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  if (!apiKey) {
    throw new OpenAIProviderError("OPENAI_API_KEY missing", {
      statusCode: 500,
      retryable: false,
    });
  }

  const textFormat = {
    type: "json_schema" as const,
    name: input.schemaName,
    strict: true,
    schema: sanitizeJsonSchema(input.schema),
  };

  const body: Record<string, any> = {
    model: input.model,
    store: false,
    stream: false,
    input: input.promptText,
    text: {
      format: textFormat,
    },
  };
  if (typeof input.maxOutputTokens === "number") {
    body.max_output_tokens = input.maxOutputTokens;
  }
  if (typeof input.temperature === "number") {
    body.temperature = input.temperature;
  }

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const errorType = parsed?.error?.type as string | undefined;
    const errorCode = parsed?.error?.code as string | undefined;
    const errorMessage = parsed?.error?.message as string | undefined;
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const bodySnippet = (errorMessage ?? text).slice(0, 500);
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader
      ? (() => {
          const seconds = Number(retryAfterHeader);
          if (!Number.isNaN(seconds)) {
            return Math.max(0, Math.floor(seconds * 1000));
          }
          const retryDate = Date.parse(retryAfterHeader);
          if (!Number.isNaN(retryDate)) {
            return Math.max(0, retryDate - Date.now());
          }
          return undefined;
        })()
      : undefined;
    const isInvalidSchema = errorType === "invalid_request_error"
      && errorCode === "invalid_json_schema";
    const isInvalidRequest = errorType === "invalid_request_error";
    const retryable = !isInvalidRequest;
    const statusCode = res.status;
    input.logger?.error?.(
      { statusCode, requestId, bodySnippet, errorType, errorCode },
      "openai.json_schema_failed"
    );
    throw new OpenAIProviderError(`OpenAI error ${statusCode}: ${bodySnippet}`, {
      statusCode,
      retryable,
      errorType,
      errorCode,
      retryAfterMs: isInvalidSchema ? undefined : retryAfterMs,
    });
  }

  const data = await res.json();
  let content: string | undefined;

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const part of contentItems) {
      if (typeof part?.text === "string") {
        content = part.text;
        break;
      }
    }
    if (content) break;
  }

  if (!content && typeof data?.output_text === "string") {
    content = data.output_text;
  }

  if (!content || typeof content !== "string") {
    throw new OpenAIProviderError("OpenAI response missing content", {
      statusCode: 502,
      retryable: true,
    });
  }

  return { rawText: content };
}
