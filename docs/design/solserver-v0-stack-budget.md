# SolServer Comfort v0 Stack and Budget

## Decisions
- Runtime: Node.js (TypeScript)
- Server: NestJS on Fastify adapter (or pure Fastify if you want thinner framework)
- Contracts: Zod
- DB for v0: Modern SQLite via Turso (low ops)
- Hosting: Fly.io for SolServer APIs and worker
- Website: Cloudflare Pages (keep DNS on Cloudflare, host static site on Pages)

## Products and monthly prices

### Fly.io
Compute (pay-as-you-go, always-on examples shown here):
- API machine: `shared-cpu-1x, 1GB` = **$5.70/mo**  [oai_citation:0‡Fly](https://fly.io/docs/about/pricing/)
- Worker machine: `shared-cpu-1x, 512MB` = **$3.19/mo**  [oai_citation:1‡Fly](https://fly.io/docs/about/pricing/)

Bandwidth:
- Outbound egress in North America and Europe: **$0.02/GB** (ingress free)  [oai_citation:2‡Fly](https://fly.io/docs/about/cost-management/?utm_source=chatgpt.com)

Optional persistent volumes (not required with Turso):
- Fly Volumes: **$0.15/GB-month**  [oai_citation:3‡Fly](https://fly.io/docs/about/pricing/)

### Turso (SQLite hosting)
- Developer plan: **$4.99/mo**  [oai_citation:4‡turso.tech](https://turso.tech/pricing?utm_source=chatgpt.com)
- Free plan exists at **$0**  [oai_citation:5‡turso.tech](https://turso.tech/pricing?utm_source=chatgpt.com)

### OpenAI API (usage-based)
Model prices (per 1M tokens):
- `gpt-4.1`: **$2.00 input**, **$8.00 output**  [oai_citation:6‡OpenAI](https://platform.openai.com/docs/models/compare?model=gpt-4.1&utm_source=chatgpt.com)
- `gpt-5.2`: **$1.75 input**, **$14.00 output**  [oai_citation:7‡OpenAI](https://platform.openai.com/docs/pricing?utm_source=chatgpt.com)

### Website hosting (recommended)
Cloudflare Pages:
- Free plan: **$0**, includes unlimited static requests and unlimited bandwidth  [oai_citation:8‡Cloudflare Pages](https://pages.cloudflare.com/?utm_source=chatgpt.com)
If you need server-side functions:
- Workers Paid plan: **minimum $5/mo** (Pages Functions are billed as Workers)  [oai_citation:9‡Cloudflare Docs](https://developers.cloudflare.com/workers/platform/pricing/?utm_source=chatgpt.com)

## Comfort v0 fixed monthly floor

Assumptions:
- 1 API machine always-on
- 1 Worker machine always-on
- Turso Developer plan
- 100GB outbound egress starter placeholder

Math:
- Fly compute: $5.70 + $3.19 = **$8.89**  [oai_citation:10‡Fly](https://fly.io/docs/about/pricing/)
- Turso: **$4.99**  [oai_citation:11‡turso.tech](https://turso.tech/pricing?utm_source=chatgpt.com)
- Bandwidth: 100GB × $0.02 = **$2.00**  [oai_citation:12‡Fly](https://fly.io/docs/about/cost-management/?utm_source=chatgpt.com)

Fixed subtotal: **$15.88/mo** (round to $16–$20 for safety)

## Variable monthly burn (OpenAI)

Your policy:
- You (owner): can use `gpt-5.2` for “kick the tires”
- Others: default `gpt-4.1`

This keeps 5.2 output costs from leaking to everyone.  [oai_citation:13‡OpenAI](https://platform.openai.com/docs/pricing?utm_source=chatgpt.com)

## Tooling
Dev:
- VSCode (free)
- Node.js LTS + TypeScript
- pnpm or npm
- Vitest (tests), ESLint + Prettier (style)
- flyctl (deploy)

Server libs:
- NestJS + Fastify adapter (or Fastify directly)
- Zod
- OpenAI SDK (`openai`)
- Pino logging
- OpenTelemetry + Sentry (recommended)

## SDKs
v0: OpenAI only for model provider.
- OpenAI pricing + model table is your source of truth for costs.  [oai_citation:14‡OpenAI](https://platform.openai.com/docs/pricing?utm_source=chatgpt.com)

## Lambda-like needs
v0 default: no AWS Lambda required.
- Background work runs on the Fly worker process group (same repo, different entrypoint).
If you want “serverless” for small edge jobs later:
- Cloudflare Workers is the clean pairing with Pages, with a $5/mo minimum on paid.  [oai_citation:15‡Cloudflare Docs](https://developers.cloudflare.com/workers/platform/pricing/?utm_source=chatgpt.com)

## BudgetConfig v0

This is designed to plug into your control-plane artifacts:
- Packet carries budgets
- Transmission enforces idempotency
- ModeDecision selects model and rigor gates
- Post-output linter can trigger regen within caps

```json
{
  "budget_config_version": "v0",
  "default_currency": "USD",

  "routing_policy": {
    "default_model_for_non_owner": "gpt-4.1",
    "owner_allowlist_models": ["gpt-4.1", "gpt-5.2"],
    "selector_model": "gpt-4.1-mini",
    "allow_owner_override": true
  },

  "per_request_limits": {
    "max_model_calls": 2,
    "max_regenerations": 2,
    "max_tool_steps": 8,

    "max_input_tokens": 24000,
    "max_output_tokens": 2000,

    "selector": {
      "enabled": true,
      "confidence_threshold": 0.75,
      "max_output_tokens": 350
    }
  },

  "per_user_monthly_caps": {
    "owner": { "max_usd": 200, "max_requests": 3000 },
    "default": { "max_usd": 40, "max_requests": 800 }
  },

  "cost_model": {
    "prices_per_1m_tokens": {
      "gpt-4.1": { "input": 2.00, "output": 8.00, "cached_input": 0.50 },
      "gpt-5.2": { "input": 1.75, "output": 14.00, "cached_input": 0.175 }
    },
    "estimation_rule": "estimated_cost = (input_tokens/1e6)*input_price + (output_tokens/1e6)*output_price"
  },

  "enforcement": {
    "on_budget_exceeded": "downgrade_model_then_shorten_output",
    "downgrade_order": ["gpt-5.2", "gpt-4.1", "gpt-4.1-mini"],
    "log_budget_events": true
  }
}