import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

// Define the canonical v0 packet schema based on infra-docs/schema/v0/api-contracts.md
const CanonicalPacketInputV0 = z.object({
  request_id: z.string().min(1),
  user_id: z.string().min(1),
  thread_id: z.string().min(1),
  user_message_id: z.string().min(1),
  packet: z.object({
    packet_id: z.string().min(1),
    packet_type: z.literal("chat"),
    message_ids: z.array(z.string()),
    checkpoint_ids: z.array(z.string()).optional(),
    pinned_context_ref: z.object({
      id: z.string(),
      version: z.string(),
      hash: z.string(),
    }),
    driver_block_mode: z.enum(["default", "custom"]).optional(),
    driver_block_refs: z.array(z.object({
      id: z.string(),
      version: z.string(),
    })).optional(),
    driver_block_inline: z.array(z.object({
      id: z.string(),
      version: z.string(),
      definition: z.string(),
    })).optional(),
    trace_config: z.object({
      level: z.enum(["info", "debug"]),
    }).optional(),
    retrieval_config: z.object({
      domain_scope: z.string(),
      max_items: z.number(),
      per_item_max_summary_tokens: z.number(),
    }),
    evidence: z.object({
      claim_map: z.array(z.object({
        claim_id: z.string(),
        claim_text: z.string(),
        support: z.array(z.object({
          support_id: z.string(),
          source_type: z.string(),
          source_uri: z.string(),
          excerpt: z.string(),
          capture_id: z.string().optional(),
        })),
      })),
    }).optional(),
  }),
  context: z.object({
    capsule_summary: z.string(),
    cfb_inference: z.object({
      primary_arc: z.string().optional(),
      decisions: z.array(z.any()).optional(),
      next: z.array(z.any()).optional(),
      scope_guard: z.object({
        avoid_topics: z.array(z.string()).optional(),
      }).optional(),
    }).optional(),
    history: z.array(z.any()),
  }),
  input_text: z.string().min(1),
  budgets: z.object({
    max_input_tokens: z.number(),
    max_output_tokens: z.number(),
    max_regenerations: z.number(),
  }),
});

describe("Canon Fixture Conformance (v0)", () => {
  it("should validate packet_minimal.json against canonical schema", () => {
    const fixturePath = join(__dirname, "../../test/fixtures/v0/packet_minimal.json");
    const fixtureContent = readFileSync(fixturePath, "utf-8");
    const fixtureData = JSON.parse(fixtureContent);

    const result = CanonicalPacketInputV0.safeParse(fixtureData);
    
    if (!result.success) {
      console.error("Validation errors:", JSON.stringify(result.error.errors, null, 2));
    }
    
    expect(result.success).toBe(true);
  });

  it("should validate packet_evidence.json against canonical schema", () => {
    const fixturePath = join(__dirname, "../../test/fixtures/v0/packet_evidence.json");
    const fixtureContent = readFileSync(fixturePath, "utf-8");
    const fixtureData = JSON.parse(fixtureContent);

    const result = CanonicalPacketInputV0.safeParse(fixtureData);
    
    if (!result.success) {
      console.error("Validation errors:", JSON.stringify(result.error.errors, null, 2));
    }
    
    expect(result.success).toBe(true);
  });

  it("should ensure packet_minimal includes required v0 fields", () => {
    const fixturePath = join(__dirname, "../../test/fixtures/v0/packet_minimal.json");
    const fixtureContent = readFileSync(fixturePath, "utf-8");
    const fixtureData = JSON.parse(fixtureContent);

    // Verify required fields are present
    expect(fixtureData.packet.trace_config).toBeDefined();
    expect(fixtureData.packet.driver_block_mode).toBeDefined();
    expect(fixtureData.packet.driver_block_refs).toBeDefined();
    expect(fixtureData.packet.driver_block_inline).toBeDefined();
  });

  it("should ensure packet_evidence includes typed evidence field", () => {
    const fixturePath = join(__dirname, "../../test/fixtures/v0/packet_evidence.json");
    const fixtureContent = readFileSync(fixturePath, "utf-8");
    const fixtureData = JSON.parse(fixtureContent);

    // Verify evidence is present and typed
    expect(fixtureData.packet.evidence).toBeDefined();
    expect(fixtureData.packet.evidence.claim_map).toBeDefined();
    expect(Array.isArray(fixtureData.packet.evidence.claim_map)).toBe(true);
    expect(fixtureData.packet.evidence.claim_map.length).toBeGreaterThan(0);
  });
});
