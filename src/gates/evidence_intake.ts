import { randomUUID } from "crypto";
import type { PacketInput, Evidence, Capture } from "../contracts/chat";
import type { EvidenceWarning } from "../contracts/evidence_warning";
import { extractUrls } from "./url_extraction";
import { EvidenceValidationError } from "./evidence_validation_error";

const MAX_CAPTURES = 25;
const MAX_SUPPORTS = 50;
const MAX_CLAIMS = 50;

export type EvidenceIntakeOutput = {
  evidence: Evidence;
  autoCaptures: number;
  clientCaptures: number;
  urlsDetected: string[];
  warnings: EvidenceWarning[];
};

/**
 * Create auto-captures from detected URLs
 */
function createAutoCapturesFromUrls(urls: string[]): Capture[] {
  const now = new Date().toISOString();

  return urls.map((url) => ({
    captureId: randomUUID(),
    kind: "url" as const,
    url,
    capturedAt: now,
    source: "user_provided" as const,
  }));
}

/**
 * Validate ISO-8601 timestamp
 * Accepts any valid ISO-8601 format that can be parsed by Date constructor
 */
function isValidISO8601(timestamp: string): boolean {
  try {
    const date = new Date(timestamp);
    // Check if date is valid and timestamp looks like ISO-8601
    // Must contain 'T' separator and end with 'Z' or timezone offset
    return !isNaN(date.getTime()) && /T.*Z?$/.test(timestamp);
  } catch {
    return false;
  }
}

/**
 * Validate timestamps for supports and claims (fail-closed)
 * Throws typed EvidenceValidationError if timestamps are missing or invalid
 */
function validateTimestamps(evidence: Evidence): void {
  // Validate support timestamps
  if (evidence.supports) {
    for (const support of evidence.supports) {
      if (!support.createdAt) {
        throw new EvidenceValidationError({
          code: "timestamp_missing",
          message: `Support ${support.supportId} missing required createdAt timestamp`,
          supportId: support.supportId,
        });
      }

      if (!isValidISO8601(support.createdAt)) {
        throw new EvidenceValidationError({
          code: "timestamp_invalid",
          message: `Support ${support.supportId} has invalid ISO-8601 timestamp: ${support.createdAt}`,
          supportId: support.supportId,
        });
      }
    }
  }

  // Validate claim timestamps
  if (evidence.claims) {
    for (const claim of evidence.claims) {
      if (!claim.createdAt) {
        throw new EvidenceValidationError({
          code: "timestamp_missing",
          message: `Claim ${claim.claimId} missing required createdAt timestamp`,
          claimId: claim.claimId,
        });
      }

      if (!isValidISO8601(claim.createdAt)) {
        throw new EvidenceValidationError({
          code: "timestamp_invalid",
          message: `Claim ${claim.claimId} has invalid ISO-8601 timestamp: ${claim.createdAt}`,
          claimId: claim.claimId,
        });
      }
    }
  }
}

/**
 * Validate evidence for orphaned references
 * Throws typed EvidenceValidationError on failure (fail closed)
 */
function validateEvidence(evidence: Evidence): void {
  const captureIds = new Set(evidence.captures?.map((c) => c.captureId) || []);
  const supportIds = new Set(evidence.supports?.map((s) => s.supportId) || []);

  // Validate url_capture supports reference valid captures
  if (evidence.supports) {
    for (const support of evidence.supports) {
      if (support.type === "url_capture") {
        if (!support.captureId) {
          throw new EvidenceValidationError({
            code: "missing_required_field",
            message: `url_capture support ${support.supportId} missing captureId`,
            supportId: support.supportId,
          });
        }

        if (!captureIds.has(support.captureId)) {
          throw new EvidenceValidationError({
            code: "orphaned_capture_reference",
            message: `url_capture support ${support.supportId} references non-existent capture ${support.captureId}`,
            supportId: support.supportId,
            captureId: support.captureId,
          });
        }
      }

      if (support.type === "text_snippet") {
        if (!support.snippetText) {
          throw new EvidenceValidationError({
            code: "missing_required_field",
            message: `text_snippet support ${support.supportId} missing snippetText`,
            supportId: support.supportId,
          });
        }
      }
    }
  }

  // Validate claims reference valid supports
  if (evidence.claims) {
    for (const claim of evidence.claims) {
      for (const supportId of claim.supportIds) {
        if (!supportIds.has(supportId)) {
          throw new EvidenceValidationError({
            code: "orphaned_support_reference",
            message: `Claim ${claim.claimId} references non-existent support ${supportId}`,
            claimId: claim.claimId,
            supportId,
          });
        }
      }
    }
  }
}

/**
 * Enforce bounds on evidence counts
 */
function enforceBounds(evidence: Evidence): void {
  const captureCount = evidence.captures?.length || 0;
  const supportCount = evidence.supports?.length || 0;
  const claimCount = evidence.claims?.length || 0;

  if (captureCount > MAX_CAPTURES) {
    throw new EvidenceValidationError({
      code: "capture_count_overflow",
      message: `Capture count ${captureCount} exceeds maximum ${MAX_CAPTURES}`,
      count: captureCount,
      max: MAX_CAPTURES,
    });
  }

  if (supportCount > MAX_SUPPORTS) {
    throw new EvidenceValidationError({
      code: "support_count_overflow",
      message: `Support count ${supportCount} exceeds maximum ${MAX_SUPPORTS}`,
      count: supportCount,
      max: MAX_SUPPORTS,
    });
  }

  if (claimCount > MAX_CLAIMS) {
    throw new EvidenceValidationError({
      code: "claim_count_overflow",
      message: `Claim count ${claimCount} exceeds maximum ${MAX_CLAIMS}`,
      count: claimCount,
      max: MAX_CLAIMS,
    });
  }
}

/**
 * Merge auto-captures with client captures (client-authoritative)
 * 
 * Policy:
 * - Keep ALL client captures by captureId (never drop)
 * - Add auto-captures only for URLs not present in client captures (by URL)
 * - Do not rewrite captureId or metadata
 * 
 * This prevents orphaning client supports that reference client captureIds.
 */
function mergeCaptures(
  clientCaptures: Capture[],
  autoCaptures: Capture[]
): Capture[] {
  // Build set of client URLs
  const clientUrls = new Set(clientCaptures.map((c) => c.url));

  // Keep all client captures (authoritative)
  const merged = [...clientCaptures];

  // Add auto-captures for URLs not in client captures
  for (const autoCapture of autoCaptures) {
    if (!clientUrls.has(autoCapture.url)) {
      merged.push(autoCapture);
    }
  }

  return merged;
}

/**
 * Run evidence intake gate
 * 
 * Process:
 * 1. Extract URLs from messageText (fail-open with warnings)
 * 2. Create auto-captures for detected URLs
 * 3. Merge with client-provided evidence (client-authoritative)
 * 4. Validate timestamps (fail-closed)
 * 5. Validate orphaned references (fail-closed)
 * 6. Enforce bounds (fail-closed)
 * 
 * @param packet - Incoming packet with message and optional evidence
 * @returns Evidence intake output with processed evidence, metadata, and warnings
 */
export function runEvidenceIntake(packet: PacketInput): EvidenceIntakeOutput {
  // Extract URLs from message text (fail-open with warnings)
  const { urls: urlsDetected, warnings } = extractUrls(packet.message);

  // Create auto-captures from detected URLs
  const autoCaptures = createAutoCapturesFromUrls(urlsDetected);

  // Get client-provided evidence
  const clientCaptures = packet.evidence?.captures || [];
  const clientSupports = packet.evidence?.supports || [];
  const clientClaims = packet.evidence?.claims || [];

  // Merge captures (client-authoritative)
  const allCaptures = mergeCaptures(clientCaptures, autoCaptures);

  // Build evidence object
  const evidence: Evidence = {
    captures: allCaptures.length > 0 ? allCaptures : undefined,
    supports: clientSupports.length > 0 ? clientSupports : undefined,
    claims: clientClaims.length > 0 ? clientClaims : undefined,
  };

  // Enforce bounds (fail-closed)
  enforceBounds(evidence);

  // Validate timestamps (fail-closed)
  validateTimestamps(evidence);

  // Validate orphaned references (fail-closed)
  validateEvidence(evidence);

  return {
    evidence,
    autoCaptures: autoCaptures.length,
    clientCaptures: clientCaptures.length,
    urlsDetected,
    warnings,
  };
}
