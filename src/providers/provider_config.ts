import { config as loadEnv } from "dotenv";

if (process.env.NODE_ENV !== "production") {
  loadEnv();
}

export type ModelTier = "nano" | "mini" | "full";

export type ProviderHints = {
  model?: string;
  tier?: ModelTier;
};

export type ModelSelection = {
  model: string;
  source: "default" | "env" | "hint";
  tier?: ModelTier;
};

type SelectModelArgs = {
  solEnv?: string;
  nodeEnv?: string;
  requestHints?: ProviderHints;
  allowOverride?: boolean;
  defaultModel: string;
};

const DEFAULTS_BY_ENV: Record<string, string> = {
  local: "gpt-5-nano",
  fly_dev: "gpt-5-mini",
  fly_staging: "gpt-5-mini",
  prod: "gpt-5.2",
};

const MODEL_BY_TIER: Record<ModelTier, string> = {
  nano: "gpt-5-nano",
  mini: "gpt-5-mini",
  full: "gpt-5.2",
};

function resolveSolEnv(nodeEnv?: string): string {
  const env = process.env.SOL_ENV ?? "";
  if (env) return env;
  if (nodeEnv === "production") return "prod";
  return "local";
}

export function selectModel(args: SelectModelArgs): ModelSelection {
  const solEnv = args.solEnv ?? resolveSolEnv(args.nodeEnv);
  const allowOverride =
    typeof args.allowOverride === "boolean"
      ? args.allowOverride
      : process.env.SOL_ALLOW_MODEL_OVERRIDE === "1";

  const envDefault = process.env.SOL_MODEL_DEFAULT;
  const envLane = {
    local: process.env.SOL_MODEL_LOCAL,
    fly_dev: process.env.SOL_MODEL_FLY_DEV,
    fly_staging: process.env.SOL_MODEL_FLY_STAGING,
    prod: process.env.SOL_MODEL_PROD,
  }[solEnv as keyof typeof DEFAULTS_BY_ENV];

  const laneDefault = DEFAULTS_BY_ENV[solEnv] ?? DEFAULTS_BY_ENV.local;
  let model = envDefault || envLane || args.defaultModel || laneDefault;
  let source: ModelSelection["source"] = envDefault || envLane ? "env" : "default";
  let tier: ModelTier | undefined;

  const hint = args.requestHints;
  const hintAllowed = allowOverride || solEnv !== "prod";
  if (hintAllowed && hint?.model) {
    model = hint.model;
    source = "hint";
  } else if (hintAllowed && hint?.tier) {
    model = MODEL_BY_TIER[hint.tier];
    tier = hint.tier;
    source = "hint";
  }

  return { model, source, ...(tier ? { tier } : {}) };
}
