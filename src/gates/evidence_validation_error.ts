export type EvidenceValidationErrorCode =
  | "orphaned_capture_reference"
  | "orphaned_support_reference"
  | "missing_required_field"
  | "capture_count_overflow"
  | "support_count_overflow"
  | "claim_count_overflow"
  | "timestamp_missing"
  | "timestamp_invalid";

export interface EvidenceValidationErrorDetails {
  code: EvidenceValidationErrorCode;
  message: string;
  // Bounded details (no full payloads)
  supportId?: string;
  captureId?: string;
  claimId?: string;
  count?: number;
  max?: number;
  url?: string; // truncated to first 100 chars for logging
}

export class EvidenceValidationError extends Error {
  public readonly code: EvidenceValidationErrorCode;
  public readonly details: EvidenceValidationErrorDetails;

  constructor(details: EvidenceValidationErrorDetails) {
    super(details.message);
    this.name = "EvidenceValidationError";
    this.code = details.code;
    this.details = details;
  }

  toJSON() {
    return {
      error: "invalid_request",
      code: this.code,
      message: this.message,
      details: {
        ...this.details,
        // Ensure URL is truncated in response
        url: this.details.url?.substring(0, 100),
      },
    };
  }
}
