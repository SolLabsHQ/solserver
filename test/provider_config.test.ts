import { describe, it, expect } from "vitest";
import { selectModel } from "../src/providers/provider_config";

describe("selectModel", () => {
  it("uses lane defaults when no overrides are set", () => {
    const result = selectModel({
      solEnv: "local",
      nodeEnv: "development",
      defaultModel: "gpt-5-nano",
    });

    expect(result.model).toBe("gpt-5-nano");
    expect(result.source).toBe("default");
  });

  it("prefers SOL_MODEL_DEFAULT when provided", () => {
    const prev = process.env.SOL_MODEL_DEFAULT;
    process.env.SOL_MODEL_DEFAULT = "gpt-override";

    try {
      const result = selectModel({
        solEnv: "local",
        nodeEnv: "development",
        defaultModel: "gpt-5-nano",
      });

      expect(result.model).toBe("gpt-override");
      expect(result.source).toBe("env");
    } finally {
      process.env.SOL_MODEL_DEFAULT = prev;
    }
  });

  it("allows hint override in non-prod", () => {
    const result = selectModel({
      solEnv: "local",
      nodeEnv: "development",
      defaultModel: "gpt-5-nano",
      requestHints: { model: "gpt-hint" },
    });

    expect(result.model).toBe("gpt-hint");
    expect(result.source).toBe("hint");
  });

  it("blocks hint override in prod unless allowOverride is true", () => {
    const blocked = selectModel({
      solEnv: "prod",
      nodeEnv: "production",
      defaultModel: "gpt-5.2",
      requestHints: { model: "gpt-hint" },
      allowOverride: false,
    });
    expect(blocked.model).toBe("gpt-5.2");
    expect(blocked.source).toBe("default");

    const allowed = selectModel({
      solEnv: "prod",
      nodeEnv: "production",
      defaultModel: "gpt-5.2",
      requestHints: { model: "gpt-hint" },
      allowOverride: true,
    });
    expect(allowed.model).toBe("gpt-hint");
    expect(allowed.source).toBe("hint");
  });
});
