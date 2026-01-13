const MAX_URL_COUNT = 100; // Prevent DoS via URL spam
const MAX_URL_LENGTH = 2048; // Match Capture schema

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
 * Extract and validate URLs from text
 * 
 * Process:
 * 1. Extract URLs using regex
 * 2. Strip trailing punctuation
 * 3. Validate with URL() constructor
 * 4. Enforce http/https only
 * 5. Trim to max length
 * 6. Deduplicate (keeps first occurrence)
 * 7. Enforce max count
 * 
 * @param text - Input text to extract URLs from
 * @returns Object with valid URLs and errors for invalid ones
 */
export function extractUrls(text: string): {
  urls: string[];
  errors: Array<{ url: string; reason: string }>;
} {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const matches = text.match(urlRegex) || [];

  const urls: string[] = [];
  const errors: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const match of matches) {
    // Strip trailing punctuation
    const cleaned = stripTrailingPunctuation(match);

    // Validate format
    if (!isValidUrl(cleaned)) {
      errors.push({ url: cleaned.substring(0, 100), reason: "invalid_format" });
      continue;
    }

    // Enforce max length
    if (cleaned.length > MAX_URL_LENGTH) {
      errors.push({
        url: cleaned.substring(0, 100),
        reason: `url_too_long (${cleaned.length} > ${MAX_URL_LENGTH})`,
      });
      continue;
    }

    // Deduplicate (keep first occurrence)
    if (seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    urls.push(cleaned);

    // Enforce max count
    if (urls.length >= MAX_URL_COUNT) {
      break;
    }
  }

  return { urls, errors };
}
