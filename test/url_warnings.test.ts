import { describe, it, expect } from "vitest";
import { extractUrls } from "../src/gates/url_extraction";

describe("URL Warnings (PR #7.1)", () => {
  it("should generate warning for invalid URL format", () => {
    const text = "Check https://[invalid";
    const result = extractUrls(text);

    expect(result.urls).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("invalid_url_format");
    expect(result.warnings[0].message).toContain("could not be parsed");
    expect(result.warnings[0].urlPreview).toBeDefined();
  });

  it("should generate warning for URL length overflow", () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    const result = extractUrls(longUrl);

    expect(result.urls).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_length_overflow");
    expect(result.warnings[0].count).toBe(longUrl.length);
    expect(result.warnings[0].max).toBe(2048);
    expect(result.warnings[0].urlPreview).toBeDefined();
  });

  it("should generate warning for URL count overflow", () => {
    const urls = Array.from({ length: 101 }, (_, i) => `https://example${i}.com`);
    const text = urls.join(" ");
    const result = extractUrls(text);

    expect(result.urls.length).toBe(100);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_count_overflow");
    expect(result.warnings[0].count).toBe(101);
    expect(result.warnings[0].max).toBe(100);
    expect(result.warnings[0].message).toContain("1 URL(s) ignored");
  });

  it("should redact URL in warnings (no scheme, no query/fragment)", () => {
    // Create a URL that's too long to trigger length overflow warning
    const longUrl = "https://example.com/path" + "a".repeat(3000) + "?query=value#fragment";
    const result = extractUrls(longUrl);

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_length_overflow");
    const urlPreview = result.warnings[0].urlPreview;
    expect(urlPreview).toBeDefined();
    // urlPreview should not contain scheme
    expect(urlPreview).not.toContain("https://");
    expect(urlPreview).toContain("example.com");
  });

  it("should truncate urlPreview to max 50 chars", () => {
    // Create a URL that's too long to trigger length overflow warning
    const longPath = "https://example.com/" + "a".repeat(3000);
    const result = extractUrls(longPath);

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_length_overflow");
    const urlPreview = result.warnings[0].urlPreview;
    expect(urlPreview).toBeDefined();
    expect(urlPreview!.length).toBeLessThanOrEqual(50);
    expect(urlPreview).toContain("...");
  });

  it("should bound warnings to max 10", () => {
    // Create 20 invalid URLs
    const invalidUrls = Array.from({ length: 20 }, () => "https://[invalid").join(" ");
    const result = extractUrls(invalidUrls);

    expect(result.urls).toEqual([]);
    expect(result.warnings.length).toBeLessThanOrEqual(10);
  });

  it("should handle mixed valid URLs and warnings", () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    const text = `Valid: https://good.com Invalid: ${longUrl} Another: https://another.com`;
    const result = extractUrls(text);

    expect(result.urls).toEqual(["https://good.com", "https://another.com"]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].code).toBe("url_length_overflow");
  });

  it("should not generate warnings for valid URLs", () => {
    const text = "Check https://example.com and https://another.com";
    const result = extractUrls(text);

    expect(result.urls.length).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("should handle unsupported protocols as warnings", () => {
    // Note: ftp:// won't match the regex, so this tests the protocol check
    // We need to test with a URL that matches the regex but has wrong protocol
    // However, the regex only matches http/https, so this is not directly testable
    // The unsupported_protocol warning is for URLs that parse but have wrong protocol
    
    // This is a limitation of the current implementation:
    // The regex only matches http/https, so unsupported protocols are never extracted
    // The unsupported_protocol warning code exists but may not be reachable
    
    const text = "File: file:///path/to/file";
    const result = extractUrls(text);
    
    // ftp/file protocols don't match the regex, so no extraction, no warnings
    expect(result.urls).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
