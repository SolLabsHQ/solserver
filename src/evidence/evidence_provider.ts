export type EvidenceSpan = {
  spanId: string;
  start?: number;
  end?: number;
  text?: string;
};

export type EvidenceItem = {
  evidenceId: string;
  kind: "web_snippet" | "doc_excerpt" | "user_note";
  sourceUrl?: string;
  title?: string;
  excerptText?: string;
  spans?: EvidenceSpan[];
};

export type EvidencePack = {
  packId: string;
  items: EvidenceItem[];
};

export interface EvidenceProvider {
  getEvidencePack(args: { threadId: string; query: string; modeLabel: string }): Promise<EvidencePack | null>;
}

export class EvidenceProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceProviderError";
  }
}

export function validateEvidencePack(pack: EvidencePack): void {
  if (!pack.packId.trim()) {
    throw new EvidenceProviderError("EvidencePack.packId must be non-empty");
  }

  const evidenceIds = new Set<string>();
  for (const item of pack.items) {
    const eid = item.evidenceId.trim();
    if (!eid) {
      throw new EvidenceProviderError("EvidenceItem.evidenceId must be non-empty");
    }
    if (evidenceIds.has(eid)) {
      throw new EvidenceProviderError(`EvidenceItem.evidenceId must be unique: ${eid}`);
    }
    evidenceIds.add(eid);

    if (item.spans && item.spans.length > 0) {
      const spanIds = new Set<string>();
      for (const span of item.spans) {
        const sid = span.spanId.trim();
        if (!sid) {
          throw new EvidenceProviderError("EvidenceSpan.spanId must be non-empty");
        }
        if (spanIds.has(sid)) {
          throw new EvidenceProviderError(`EvidenceSpan.spanId must be unique per item: ${sid}`);
        }
        spanIds.add(sid);
      }
    }
  }
}

export class StubEvidenceProvider implements EvidenceProvider {
  async getEvidencePack(_args: { threadId: string; query: string; modeLabel: string }): Promise<EvidencePack | null> {
    const pack: EvidencePack = {
      packId: "pack-001",
      items: [
        {
          evidenceId: "ev-001",
          kind: "web_snippet",
          sourceUrl: "https://example.com/a",
          title: "Example Source A",
          excerptText: "Example excerpt A describing the primary claim.",
          spans: [
            { spanId: "sp-001", text: "Example excerpt A describing the primary claim." },
          ],
        },
        {
          evidenceId: "ev-002",
          kind: "doc_excerpt",
          sourceUrl: "https://example.com/b",
          title: "Example Source B",
          excerptText: "Example excerpt B providing supporting context.",
          spans: [
            { spanId: "sp-002", text: "Example excerpt B providing supporting context." },
          ],
        },
      ],
    };

    validateEvidencePack(pack);
    return pack;
  }
}

export class NullEvidenceProvider implements EvidenceProvider {
  async getEvidencePack(_args: { threadId: string; query: string; modeLabel: string }): Promise<EvidencePack | null> {
    return null;
  }
}

export function selectEvidenceProvider(): EvidenceProvider {
  const provider = (process.env.EVIDENCE_PROVIDER ?? "stub").toLowerCase();
  if (provider === "none") return new NullEvidenceProvider();
  return new StubEvidenceProvider();
}
