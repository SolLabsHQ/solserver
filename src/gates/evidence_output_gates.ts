import type { EvidencePack } from "../evidence/evidence_provider";
import type { OutputEnvelope, OutputEnvelopeClaim, OutputEnvelopeEvidenceRef } from "../contracts/output_envelope";

export type EvidenceGateErrorCode =
  | "claims_without_evidence"
  | "evidence_binding_failed"
  | "evidence_budget_exceeded";

export type EvidenceBindingResult = {
  ok: boolean;
  invalidRefsCount: number;
  reason?: "claims_without_evidence" | "invalid_binding";
};

export type EvidenceBudgetResult = {
  ok: boolean;
  reason?: "max_claims" | "max_refs_per_claim" | "max_total_refs" | "max_meta_bytes" | "max_evidence_bytes";
  counts: {
    claimCount: number;
    totalRefs: number;
    maxRefsPerClaim: number;
  };
  limits: {
    maxClaims: number;
    maxRefsPerClaim: number;
    maxTotalRefs: number;
    maxMetaBytes: number;
    maxEvidenceBytes: number;
  };
  metaBytes: number;
  evidenceBytes: number;
};

export const EVIDENCE_BUDGET_LIMITS = {
  maxClaims: 8,
  maxRefsPerClaim: 4,
  maxTotalRefs: 20,
  maxMetaBytes: 16 * 1024,
  maxEvidenceBytes: 4 * 1024,
};

function utf8ByteLength(text: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyGlobal: any = globalThis as any;
    if (anyGlobal.Buffer?.byteLength) return anyGlobal.Buffer.byteLength(text, "utf8");
  } catch {}

  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

export function extractClaims(envelope: OutputEnvelope): OutputEnvelopeClaim[] {
  return envelope.meta?.claims ?? [];
}

export function deriveUsedEvidenceIds(claims: OutputEnvelopeClaim[]): string[] {
  const ids = new Set<string>();
  for (const claim of claims) {
    for (const ref of claim.evidence_refs) {
      ids.add(ref.evidence_id);
    }
  }
  return Array.from(ids);
}

export function runEvidenceBindingGate(
  claims: OutputEnvelopeClaim[],
  evidencePack: EvidencePack | null
): EvidenceBindingResult {
  if (!claims.length) {
    return { ok: true, invalidRefsCount: 0 };
  }

  if (!evidencePack || evidencePack.items.length === 0) {
    return { ok: false, invalidRefsCount: 0, reason: "claims_without_evidence" };
  }

  const itemsById = new Map(evidencePack.items.map((item) => [item.evidenceId, item]));
  let invalidRefsCount = 0;

  for (const claim of claims) {
    for (const ref of claim.evidence_refs) {
      const item = itemsById.get(ref.evidence_id);
      if (!item) {
        invalidRefsCount += 1;
        continue;
      }
      if (ref.span_id) {
        const spans = item.spans ?? [];
        if (!spans.some((s) => s.spanId === ref.span_id)) {
          invalidRefsCount += 1;
        }
      }
    }
  }

  if (invalidRefsCount > 0) {
    return { ok: false, invalidRefsCount, reason: "invalid_binding" };
  }

  return { ok: true, invalidRefsCount: 0 };
}

function referencedTextBytes(
  refs: OutputEnvelopeEvidenceRef[],
  evidencePack: EvidencePack | null
): number {
  if (!evidencePack || refs.length === 0) return 0;
  const itemsById = new Map(evidencePack.items.map((item) => [item.evidenceId, item]));
  const seen = new Set<string>();
  let total = 0;

  for (const ref of refs) {
    const item = itemsById.get(ref.evidence_id);
    if (!item) continue;
    const key = `${ref.evidence_id}:${ref.span_id ?? "excerpt"}`;
    if (seen.has(key)) continue;

    let text: string | undefined;
    if (ref.span_id) {
      text = item.spans?.find((s) => s.spanId === ref.span_id)?.text;
    } else {
      text = item.excerptText;
    }

    if (text) {
      total += utf8ByteLength(text);
      seen.add(key);
    }
  }

  return total;
}

export function runEvidenceBudgetGate(
  envelope: OutputEnvelope,
  claims: OutputEnvelopeClaim[],
  evidencePack: EvidencePack | null
): EvidenceBudgetResult {
  const limits = EVIDENCE_BUDGET_LIMITS;
  const claimCount = claims.length;
  const perClaimRefs = claims.map((c) => c.evidence_refs.length);
  const maxRefsPerClaim = perClaimRefs.reduce((max, v) => Math.max(max, v), 0);
  const totalRefs = perClaimRefs.reduce((sum, v) => sum + v, 0);

  const metaBytes = envelope.meta ? utf8ByteLength(JSON.stringify(envelope.meta)) : 0;
  const evidenceBytes = referencedTextBytes(
    claims.flatMap((c) => c.evidence_refs),
    evidencePack
  );

  if (claimCount > limits.maxClaims) {
    return {
      ok: false,
      reason: "max_claims",
      counts: { claimCount, totalRefs, maxRefsPerClaim },
      limits,
      metaBytes,
      evidenceBytes,
    };
  }

  if (maxRefsPerClaim > limits.maxRefsPerClaim) {
    return {
      ok: false,
      reason: "max_refs_per_claim",
      counts: { claimCount, totalRefs, maxRefsPerClaim },
      limits,
      metaBytes,
      evidenceBytes,
    };
  }

  if (totalRefs > limits.maxTotalRefs) {
    return {
      ok: false,
      reason: "max_total_refs",
      counts: { claimCount, totalRefs, maxRefsPerClaim },
      limits,
      metaBytes,
      evidenceBytes,
    };
  }

  if (metaBytes > limits.maxMetaBytes) {
    return {
      ok: false,
      reason: "max_meta_bytes",
      counts: { claimCount, totalRefs, maxRefsPerClaim },
      limits,
      metaBytes,
      evidenceBytes,
    };
  }

  if (evidenceBytes > limits.maxEvidenceBytes) {
    return {
      ok: false,
      reason: "max_evidence_bytes",
      counts: { claimCount, totalRefs, maxRefsPerClaim },
      limits,
      metaBytes,
      evidenceBytes,
    };
  }

  return {
    ok: true,
    counts: { claimCount, totalRefs, maxRefsPerClaim },
    limits,
    metaBytes,
    evidenceBytes,
  };
}
