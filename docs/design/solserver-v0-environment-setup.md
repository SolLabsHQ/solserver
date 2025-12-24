## Coach — SolServer v0 Local Dev Setup + Build Plan (Comfort Stack)

**Goal:** get a local SolServer running that SolMobile can call, validate the Control Plane flow (Packet → Transmission → ModeDecision → prompt assembly), and only later turn on paid services (OpenAI, Fly, Turso).

### North Star sequence (matches this pack)
1) **Local HTTP API** (health + echo + basic Packet/Transmission endpoints)
2) **Control plane stub** (Step 0/1 router + ModeDecision JSON)
3) **Gates skeleton** (rigor + governance lint placeholders)
4) **Provider stub** (fake “model” response; no OpenAI)
5) **SolMobile integration** (call `/healthz`, then `/v1/chat`)
6) **Real provider toggle** (OpenAI on/off via env flag)
7) **Deploy later** (Fly Machines + Turso) — *not needed to start*

### Comfort v0 stack (what we’re building toward)
- Runtime: **Node.js + TypeScript**
- HTTP: **Fastify** (thin kernel) with a clean seam to evolve into **NestJS (FastifyAdapter)** later if we want more DI/module structure.
- Validation/contracts: **Zod**
- Data: **SQLite now** (local file) → **Turso** later (same SQL-ish model)
- Deploy later: **Fly.io** (API + worker)

> **Change Proposal (for Day 0 speed):** Start with **Fastify directly** for the first working server + SolMobile wiring. Once endpoints and the control-plane flow are real, we can either (a) keep Fastify + plugins, or (b) lift into NestJS for larger modularity.

---

## Step 0 — Local dev prerequisites (Mac + VSCode)

### Install / verify tooling
1) **Node.js LTS** (recommended via `nvm`):
   - Install nvm (if needed), then:
     ```bash
     nvm install --lts
     nvm use --lts
     node -v
     npm -v
     ```
2) Package manager: use `npm` for now (keep it simple). We can adopt `pnpm` later.
3) VSCode extensions (minimum):
   - ESLint
   - Prettier

### Repo sanity
From your `solserver/` folder:
```bash
git status
ls
```

---

## Step 1 — Create the SolServer skeleton (TypeScript + Fastify)

From the `solserver/` repo root:
```bash
npm init -y
npm i fastify zod pino-pretty
npm i -D typescript tsx @types/node vitest supertest
npx tsc --init
```

### Package scripts
Edit `package.json` and add:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest",
    "lint": "eslint .",
    "format": "prettier -w ."
  }
}
```

### Create folders
```bash
mkdir -p src/routes src/control-plane src/gates src/providers src/contracts
```

---

## Step 2 — Your first local HTTP server (SolMobile can hit this)

Create `src/index.ts`:
```ts
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({
  ok: true,
  service: "solserver",
  ts: new Date().toISOString()
}));

app.get("/v1/echo", async (req) => ({
  ok: true,
  you_sent: req.query
}));

const port = Number(process.env.PORT ?? 3333);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

Run it:
```bash
npm run dev
```

Test it:
```bash
curl http://localhost:3333/healthz
curl "http://localhost:3333/v1/echo?hi=sol"
```

### SolMobile dev connectivity notes
- **iOS Simulator** can call `http://localhost:3333/healthz` directly.
- **Physical device** must call your Mac’s LAN IP (e.g., `http://192.168.1.10:3333/healthz`).
- iOS may block plain HTTP by default (ATS). For dev you can:
  - use a temporary ATS exception for your local IP, or
  - later run HTTPS locally.

---

## Step 3 — Add the first “Control Plane” endpoint (stubbed, no OpenAI)

We’ll implement a minimal `/v1/chat` that accepts a Packet-like payload, runs Step 0/1 routing, and returns:
- `modeDecision`
- `assistant_stub` (fake model response)

### Contracts (Zod)
Create `src/contracts/chat.ts`:
```ts
import { z } from "zod";

export const PacketInput = z.object({
  packetType: z.enum(["chat"]).default("chat"),
  threadId: z.string().min(1),
  message: z.string().min(1).max(20_000),
  meta: z.record(z.any()).optional()
});

export type PacketInput = z.infer<typeof PacketInput>;

export const ModeDecision = z.object({
  modeLabel: z.string(),
  domainFlags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  checkpointNeeded: z.boolean(),
  reasons: z.array(z.string()).default([]),
  version: z.string()
});

export type ModeDecision = z.infer<typeof ModeDecision>;
```

### Deterministic router (Step 0/1 only)
Create `src/control-plane/router.ts`:
```ts
import type { PacketInput, ModeDecision } from "../contracts/chat";

export function routeMode(packet: PacketInput): ModeDecision {
  const msg = packet.message;

  // Step 0 — hard overrides (call-words / high-rigor)
  const highRigor = /\b(finance|tax|legal|contract|architecture|adr|security)\b/i.test(msg);
  if (highRigor) {
    return {
      modeLabel: "System-mode",
      domainFlags: ["high-rigor"],
      confidence: 1.0,
      checkpointNeeded: true,
      reasons: ["high_rigor_keyword"],
      version: "mode-engine-v0"
    };
  }

  // Step 1 — lightweight classifier
  const reflective = /\b(feel|worried|anxious|relationship|family)\b/i.test(msg);
  if (reflective) {
    return {
      modeLabel: "Sole",
      domainFlags: ["relationship"],
      confidence: 0.8,
      checkpointNeeded: false,
      reasons: ["reflective_cues"],
      version: "mode-engine-v0"
    };
  }

  return {
    modeLabel: "Ida",
    domainFlags: [],
    confidence: 0.7,
    checkpointNeeded: false,
    reasons: ["default"],
    version: "mode-engine-v0"
  };
}
```

### Gates skeleton (placeholders)
Create `src/gates/post_linter.ts`:
```ts
export function postOutputLinter(args: {
  modeLabel: string;
  content: string;
}): { ok: true } | { ok: false; error: string } {
  // v0 placeholder: always OK
  // Later: enforce format/constraints per ModeDecision + governance rules.
  return { ok: true };
}
```

### Provider stub (no OpenAI)
Create `src/providers/fake_model.ts`:
```ts
export async function fakeModelReply(input: {
  userText: string;
  modeLabel: string;
}): Promise<string> {
  return `[${input.modeLabel}] Stub response: I received ${input.userText.length} chars.`;
}
```

### Wire `/v1/chat`
Edit `src/index.ts` and add the route (keep `/healthz` too):
```ts
import { PacketInput } from "./contracts/chat";
import { routeMode } from "./control-plane/router";
import { fakeModelReply } from "./providers/fake_model";
import { postOutputLinter } from "./gates/post_linter";

app.post("/v1/chat", async (req, reply) => {
  const parsed = PacketInput.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
  }

  const packet = parsed.data;
  const modeDecision = routeMode(packet);

  const assistant = await fakeModelReply({ userText: packet.message, modeLabel: modeDecision.modeLabel });

  const lint = postOutputLinter({ modeLabel: modeDecision.modeLabel, content: assistant });
  if (!lint.ok) {
    return reply.code(500).send({ error: "post_lint_failed", details: lint.error });
  }

  return {
    ok: true,
    modeDecision,
    assistant
  };
});
```

Test it:
```bash
curl -X POST http://localhost:3333/v1/chat \
  -H 'content-type: application/json' \
  -d '{"threadId":"t1","message":"hello sol"}'

curl -X POST http://localhost:3333/v1/chat \
  -H 'content-type: application/json' \
  -d '{"threadId":"t1","message":"I need architecture advice"}'
```

---

## Step 4 — Minimal test (prove the spine)

Create `src/control-plane/router.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { routeMode } from "./router";

describe("routeMode", () => {
  it("routes high-rigor keywords to System-mode", () => {
    const md = routeMode({ packetType: "chat", threadId: "t1", message: "architecture question" });
    expect(md.modeLabel).toBe("System-mode");
    expect(md.checkpointNeeded).toBe(true);
  });
});
```

Run:
```bash
npm test
```

---

## Step 5 — SolMobile wiring (first handshake)

1) Add a SolMobile dev setting for `baseURL`.
2) Call:
   - `GET /healthz` (show green dot)
   - `POST /v1/chat` (send user message, display `assistant`)

Notes:
- Keep the server response shape stable; the app can ignore fields it doesn’t need yet.
- This is how we avoid paying early: **no Fly deploy, no OpenAI calls** until the pipeline behaves.

---

## Step 6 — Later: “Real provider” toggle (OpenAI on/off)

We’ll add an env flag:
- `PROVIDER=fake` (default)
- `PROVIDER=openai` (only when ready)

Then we swap `fakeModelReply` → `openaiReply` inside `providers/`.

---

## Step 7 — Later: push-to-production flow (not now)

When local works end-to-end:
- Deploy to **Fly.io** (API + worker)
- Switch SQLite to **Turso** by changing connection URL (keep same store interface)
- Add secrets (OpenAI key, Turso URL) via `fly secrets set`

**Rule:** don’t deploy until SolMobile can complete the local handshake + `/v1/chat` loop and the control-plane objects look right.
