# SolServer

SolServer is the backend runtime for SolMobile v0.

It acts as the policy, validation, and orchestration layer between the SolMobile client, inference providers, and persistent storage.

SolServer is intentionally narrow in scope. It does not behave as an autonomous agent and does not accumulate implicit memory.

---

## Purpose

SolServer exists to enforce architectural constraints that cannot safely live on the client or inside the inference provider.

Its primary goals are:
- explicit user consent for persistence
- bounded context injection
- drift control
- predictable cost and usage
- auditability

SolServer is not a general-purpose AI backend.

---

## Core Responsibilities

- Accept chat requests from SolMobile
- Validate request schemas and budget caps
- Enforce explicit memory rules
- Perform scoped memory retrieval (summaries only)
- Shape context sent to inference providers
- Route inference calls
- Persist user-explicit memory objects
- Emit usage and audit metadata

---

## What SolServer Does *Not* Do

- It does not store full conversation history
- It does not infer user preferences or personality
- It does not auto-save memory
- It does not learn across sessions
- It does not take actions on behalf of the user

All long-term state is explicit and user initiated.

---

## Architecture Position

SolServer sits between:

- **SolMobile (iOS client)**  
  Trusted for user interaction and local state

- **Inference Providers (LLMs)**  
  Treated as stateless reasoning engines

- **Control Plane Store (SQLite → Turso)**  
  Stores only explicit memory objects + minimal audit/usage metadata

SolServer enforces trust boundaries and policy across these systems.

---

## API Surface (v0)

SolServer exposes a minimal API:

- `GET /healthz`  
  Returns service status for SolMobile connectivity tests

- `POST /v1/chat`  
  Performs bounded inference with optional retrieval summaries

- `POST /v1/memories`  
  Persists a user-explicit memory object

- `GET /v1/memories`  
  Lists explicit memory summaries

- `GET /v1/usage/daily`  
  Returns token usage and estimated cost data

Detailed contracts live in `infra-docs/schemas/v0/api-contracts.md`.

---

## Memory Model

- All long-term memory requires explicit user consent
- Memories are domain-scoped
- Retrieval injects summaries only
- Retrieval limits are enforced per request
- Deletion and auditability are first-class concerns

SolServer does not accumulate implicit state.

---

## Hosting and Runtime

- Containerized service
- Local-first for v0 development (no paid services required to start)
- Hosted on Fly.io for deployment (later)
- Stateless by default
- Persistent writes limited to:
  - explicit memory objects
  - minimal audit metadata

Configuration is environment-based and not committed to source control.

---

## Observability

- Error tracking via Sentry (client and server)
- Optional tracing with low sampling
- Token usage recorded per request
- Cost visibility treated as a product feature, not an afterthought

---

## Status

SolServer is under active development as part of SolMobile v0.

The current focus is correctness, clarity, and constraint enforcement rather than feature breadth or scale.

---

## Repository Layout (v0)

Planned directory structure (we will create these as we build):

- `docs/` — design docs, ADR references, flow packs
- `src/` — server code
  - `src/index.ts` — Fastify app entry
  - `src/routes/` — HTTP routes (v0 minimal)
  - `src/contracts/` — Zod schemas + types
  - `src/control-plane/` — Packet/Transmission pipeline + mode routing
  - `src/gates/` — Rigor gate + governance lint (skeleton first)
  - `src/providers/` — fake model provider now; OpenAI provider later
  - `src/store/` — SQLite store (local file) now; Turso later
- `test/` or `src/**/*.test.ts` — Vitest tests

## Local Development (v0)

We start locally (free) and only deploy once SolMobile can complete the end-to-end handshake.

### Quick start
```bash
npm init -y
npm i fastify zod pino-pretty
npm i -D typescript tsx @types/node vitest supertest
npx tsc --init
mkdir -p src/routes src/contracts src/control-plane src/gates src/providers src/store
```

Run:
```bash
npm run dev
```

Test:
```bash
curl http://localhost:3333/healthz
```

### Provider toggle (planned)
- Default provider is a **fake model** for pipeline testing.
- OpenAI wiring is added later behind an environment flag.

---

## Related Documentation

- `infra-docs/architecture/context.md`
- `infra-docs/architecture/containers.md`
- `infra-docs/decisions/ADR-003-explicit-memory.md`
- `infra-docs/decisions/ADR-004-fly-io-hosting.md`
- `infra-docs/schemas/v0/api-contracts.md`
- `docs/design/solserver-v0-control-plane-flow-process-pack.md`
