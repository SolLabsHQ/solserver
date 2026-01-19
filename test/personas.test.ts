import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const personasDir = join(__dirname, "..", "src", "control-plane", "personas");
const MAX_PERSONA_BYTES = 1024;
const ALLOWED_PERSONA_FILES = new Set([
  "ida.md",
  "sole.md",
  "cassandra.md",
  "diogenes.md",
  "system.md",
]);

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

describe("persona preambles", () => {
  it("keeps persona preambles under 1KB", () => {
    expect(existsSync(personasDir)).toBe(true);

    const files = readdirSync(personasDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));

    for (const name of files) {
      expect(
        ALLOWED_PERSONA_FILES.has(name),
        `${name} is not a recognized persona preamble file name`
      ).toBe(true);
      const content = readFileSync(join(personasDir, name), "utf8");
      const bytes = utf8ByteLength(content);
      expect(bytes, `${name} exceeds ${MAX_PERSONA_BYTES} bytes`).toBeLessThanOrEqual(MAX_PERSONA_BYTES);
    }
  });
});
