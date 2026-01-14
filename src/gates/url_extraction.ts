import type { EvidenceWarning } from "../contracts/evidence_warning";

const MAX_URL_COUNT = 100; // Prevent DoS via URL spam
const MAX_URL_LENGTH = 2048; // Match Capture schema
const MAX_WARNINGS = 10; // Bounded warnings to prevent response bloat

/**
 * Strip trailing punctuation from extracted URLs
 * Common cases: markdown links, URLs in sentences
 */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[).,\]]+$/, "");
}

/**
 * Validate URL format and protocol
 * Only http and https are allowed
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Redact URL for safe display in warnings
 * Format: host + truncated path (max 50 chars), no scheme, no query/fragment
 * Example: "example.com/very/long/path/..."
 */
function redactUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    const pathPart = url.pathname + url.hash;
    const hostAndPath = url.host + pathPart;
    
    if (hostAndPath.length > 50) {
      return hostAndPath.substring(0, 47) + "...";
    }
    return hostAndPath;
  } catch {
    // If URL parsing fails, just truncate the raw string
    return urlString.substring(0, 50);
  }
}

/**
 * Extract and validate URLs from text (fail-open with warnings)
 * 
 * Process:
 * 1. Extract URLs using regex
 * 2. Strip trailing punctuation
 * 3. Validate with URL() constructor
 * 4. Enforce http/https only
 * 5. Trim to max length
 * 6. Deduplicate (keeps first occurrence)
 * 7. Enforce max count
 * 8. Generate bounded warnings for invalid/overflow URLs
 * 
 * @param text - Input text to extract URLs from
 * @returns Object with valid URLs and warnings for invalid ones
 */
export function extractUrls(text: string): {
  urls: string[];
  warnings: EvidenceWarning[];
} {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const matches = text.match(urlRegex) || [];

  const urls: string[] = [];
  const warnings: EvidenceWarning[] = [];
  const seen = new Set<string>();
  
  // Track warning counts for aggregation
  let invalidFormatCount = 0;
  let lengthOverflowCount = 0;
  let unsupportedProtocolCount = 0;
  let countOverflow = 0;

  for (const match of matches) {
    // Strip trailing punctuation
    const cleaned = stripTrailingPunctuation(match);

    // Check for unsupported protocol (before URL validation)
    let protocol: string | null = null;
    try {
      const url = new URL(cleaned);
      protocol = url.protocol;
    } catch {
      // Will be caught as invalid_format below
    }

    if (protocol && protocol !== "http:" && protocol !== "https:") {
      unsupportedProtocolCount++;
      if (warnings.length < MAX_WARNINGS) {
        warnings.push({
          code: "unsupported_protocol",
          message: `URL with unsupported protocol ignored`,
          urlPreview: redactUrl(cleaned),
        });
      }
      continue;
    }

    // Validate format
    if (!isValidUrl(cleaned)) {
      invalidFormatCount++;
      if (warnings.length < MAX_WARNINGS) {
        warnings.push({
          code: "invalid_url_format",
          message: `URL could not be parsed`,
          urlPreview: redactUrl(cleaned),
        });
      }
      continue;
    }

    // Enforce max length
    if (cleaned.length > MAX_URL_LENGTH) {
      lengthOverflowCount++;
      if (warnings.length < MAX_WARNINGS) {
        warnings.push({
          code: "url_length_overflow",
          message: `URL exceeds maximum length`,
          count: cleaned.length,
          max: MAX_URL_LENGTH,
          urlPreview: redactUrl(cleaned),
        });
      }
      continue;
    }

    // Deduplicate (keep first occurrence)
    if (seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    
    // Check count overflow before adding
    if (urls.length >= MAX_URL_COUNT) {
      countOverflow++;
      continue;
    }
    
    urls.push(cleaned);
  }
  
  // Add aggregated count overflow warning if needed
  if (countOverflow > 0) {
    warnings.push({
      code: "url_count_overflow",
      message: `${countOverflow} URL(s) ignored (exceeded maximum of ${MAX_URL_COUNT})`,
      count: matches.length,
      max: MAX_URL_COUNT,
    });
  }

  return { urls, warnings };
}
