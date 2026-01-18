export class OpenAIProviderError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 502) {
    super(message);
    this.name = "OpenAIProviderError";
    this.statusCode = statusCode;
  }
}

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

  if (!apiKey) {
    throw new OpenAIProviderError("OPENAI_API_KEY missing", 500);
  }
  if (!model) {
    throw new OpenAIProviderError("OPENAI_MODEL missing", 500);
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: input.promptText,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const bodySnippet = text.slice(0, 500);
    input.logger?.error?.(
      { statusCode: res.status, requestId, bodySnippet },
      "openai.request_failed"
    );
    throw new OpenAIProviderError(`OpenAI error ${res.status}: ${bodySnippet}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new OpenAIProviderError("OpenAI response missing content");
  }

  return { rawText: content, mementoDraft: null };
}
