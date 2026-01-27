import type { EvidencePack } from "../evidence/evidence_provider";
import type {
  OutputEnvelope,
  OutputEnvelopeClaim,
  OutputEnvelopeEvidenceRef,
} from "../contracts/output_envelope";

const REASON_CODES = [
  "duplicate_ref",
  "empty_ref",
  "missing_evidence_id",
  "missing_span_id",
  "missing_evidence_pack",
] as const;

export type LibrarianGateReason = (typeof REASON_CODES)[number];
export type LibrarianGateVerdict = "pass" | "prune" | "flag";

export type LibrarianGateStats = {
  claimCount: number;
  refsBefore: number;
  refsAfter: number;
  prunedRefs: number;
  unsupportedClaims: number;
  supportScore: number;
  verdict: LibrarianGateVerdict;
  reasonCodes: LibrarianGateReason[];
};

export type LibrarianGateResult = {
  envelope: OutputEnvelope;
  stats: LibrarianGateStats;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function applyLibrarianGate(args: {
  envelope: OutputEnvelope;
  evidencePack: EvidencePack | null;
}): LibrarianGateResult | null {
  if (args.envelope.meta?.display_hint !== "ghost_card") {
    return null;
  }

  const claims = args.envelope.meta?.claims ?? [];
  const claimCount = claims.length;
  const evidenceItems = args.evidencePack?.items ?? [];
  const canValidate = evidenceItems.length > 0;
  const itemsById = new Map(evidenceItems.map((item) => [item.evidenceId, item]));

  const reasonSet = new Set<LibrarianGateReason>();
  if (!canValidate && claimCount > 0) {
    reasonSet.add("missing_evidence_pack");
  }

  let refsBefore = 0;
  let refsAfter = 0;
  let prunedRefs = 0;
  let unsupportedClaims = 0;

  const nextClaims: OutputEnvelopeClaim[] = [];

  for (const claim of claims) {
    const seen = new Set<string>();
    const nextRefs: OutputEnvelopeEvidenceRef[] = [];

    for (const ref of claim.evidence_refs) {
      refsBefore += 1;
      const evidenceId = ref.evidence_id?.trim() ?? "";
      const spanId = ref.span_id?.trim();

      if (!evidenceId) {
        prunedRefs += 1;
        reasonSet.add("empty_ref");
        continue;
      }

      const key = `${evidenceId}:${spanId ?? ""}`;
      if (seen.has(key)) {
        prunedRefs += 1;
        reasonSet.add("duplicate_ref");
        continue;
      }

      if (canValidate) {
        const item = itemsById.get(evidenceId);
        if (!item) {
          prunedRefs += 1;
          reasonSet.add("missing_evidence_id");
          continue;
        }
        if (spanId) {
          const spans = item.spans ?? [];
          if (!spans.some((span) => span.spanId === spanId)) {
            prunedRefs += 1;
            reasonSet.add("missing_span_id");
            continue;
          }
        }
      }

      seen.add(key);
      nextRefs.push(ref);
    }

    refsAfter += nextRefs.length;

    if (nextRefs.length === 0) {
      unsupportedClaims += 1;
      continue;
    }

    if (nextRefs.length === claim.evidence_refs.length) {
      nextClaims.push(claim);
    } else {
      nextClaims.push({ ...claim, evidence_refs: nextRefs });
    }
  }

  const supportScore =
    claimCount === 0 ? 1 : clamp01(1 - unsupportedClaims / claimCount);
  const verdict: LibrarianGateVerdict = unsupportedClaims > 0
    ? "flag"
    : prunedRefs > 0
      ? "prune"
      : "pass";
  const reasonCodes = Array.from(reasonSet).slice(0, 6);

  const meta = { ...(args.envelope.meta ?? {}) };
  if (nextClaims.length > 0) {
    meta.claims = nextClaims;
  } else {
    delete meta.claims;
  }

  meta.librarian_gate = {
    version: "v0",
    pruned_refs: prunedRefs,
    unsupported_claims: unsupportedClaims,
    support_score: supportScore,
    verdict,
  };

  return {
    envelope: { ...args.envelope, meta },
    stats: {
      claimCount,
      refsBefore,
      refsAfter,
      prunedRefs,
      unsupportedClaims,
      supportScore,
      verdict,
      reasonCodes,
    },
  };
}
