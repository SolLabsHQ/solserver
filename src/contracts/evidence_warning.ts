export type EvidenceWarningCode =
  | "invalid_url_format"
  | "url_length_overflow"
  | "url_count_overflow"
  | "unsupported_protocol";

export interface EvidenceWarning {
  code: EvidenceWarningCode;
  message: string; // user-safe
  count?: number; // for overflow
  max?: number;
  urlPreview?: string; // redacted: host + truncated path (max 50 chars), no scheme, no query/fragment
}

export interface EvidenceSummary {
  captures: number;
  supports: number;
  claims: number;
  warnings: number;
}
