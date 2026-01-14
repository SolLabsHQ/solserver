import { describe, it, expect } from "vitest";
import { extractUrls } from "../src/gates/url_extraction";

describe("URL Extraction", () => {
  it("should extract basic HTTP URLs", () => {
    const text = "Check out http://example.com for more info";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["http://example.com"]);
    expect(result.warnings).toEqual([]);
  });

  it("should extract basic HTTPS URLs", () => {
    const text = "Visit https://example.com today";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com"]);
    expect(result.warnings).toEqual([]);
  });

  it("should strip trailing punctuation from URLs", () => {
    const cases = [
      { text: "See https://example.com.", expected: "https://example.com" },
      { text: "Link: https://example.com,", expected: "https://example.com" },
      { text: "Check (https://example.com)", expected: "https://example.com" },
      { text: "Array [https://example.com]", expected: "https://example.com" },
      { text: "Multiple https://example.com.,]", expected: "https://example.com" },
    ];

    for (const { text, expected } of cases) {
      const result = extractUrls(text);
      expect(result.urls).toEqual([expected]);
    }
  });

  it("should handle markdown links correctly", () => {
    const text = "Read [this article](https://example.com).";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com"]);
  });

  it("should deduplicate URLs (keep first occurrence)", () => {
    const text = "Visit https://example.com and also https://example.com again";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com"]);
  });

  it("should extract multiple distinct URLs", () => {
    const text = "See https://example.com and https://another.com";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com", "https://another.com"]);
  });

  it("should not extract non-http/https protocols", () => {
    const text = "File: file:///path/to/file and ftp://example.com";
    const result = extractUrls(text);

    // Regex only matches http/https, so these are simply not extracted
    expect(result.urls).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("should reject invalid URL formats after extraction", () => {
    // These match the regex but fail URL() validation
    const text = "Invalid: https://[invalid and https://";
    const result = extractUrls(text);

    expect(result.urls).toEqual([]);
    // Note: Simple "https://" won't be matched by regex (requires more chars)
  });

  it("should enforce max URL length (2048)", () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    const result = extractUrls(longUrl);

    expect(result.urls).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_length_overflow");
    expect(result.warnings[0].count).toBe(longUrl.length);
    expect(result.warnings[0].max).toBe(2048);
  });

  it("should enforce max URL count (100)", () => {
    // Create text with 101 URLs
    const urls = Array.from({ length: 101 }, (_, i) => `https://example${i}.com`);
    const text = urls.join(" ");
    const result = extractUrls(text);

    expect(result.urls.length).toBe(100);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_count_overflow");
    expect(result.warnings[0].count).toBe(101);
    expect(result.warnings[0].max).toBe(100);
  });

  it("should handle mixed valid and invalid URLs", () => {
    // ftp:// won't be matched by regex (only http/https)
    const text = "Valid: https://example.com Invalid: ftp://bad.com Another: https://good.com";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com", "https://good.com"]);
    expect(result.warnings).toEqual([]); // ftp not extracted, so no warnings
  });

  it("should handle URLs with query parameters", () => {
    const text = "Search: https://example.com/search?q=test&page=1";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com/search?q=test&page=1"]);
  });

  it("should handle URLs with fragments", () => {
    const text = "Anchor: https://example.com/page#section";
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://example.com/page#section"]);
  });

  it("should return empty arrays for text with no URLs", () => {
    const text = "This is just plain text with no links";
    const result = extractUrls(text);

    expect(result.urls).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
