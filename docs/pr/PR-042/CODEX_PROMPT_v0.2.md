# CODEX PROMPT — v0 Launch Implementation + v0 Architecture Docs (v0.2)

You are Codex working in:
- solserver (Fastify/TypeScript on Fly)
- solmobile (Swift/SwiftUI)
- infra-docs (documentation repo)

## Objective
Ship v0 by:
1) Deploying solserver to prod on Fly in SJC
2) Publishing prod behind custom domain `api.sollabshq.com`
3) Uploading solmobile to TestFlight (internal)
4) Finalizing v0 architecture docs in infra-docs aligned to existing structure

## Known environment declarations (FACT from Jam)
- Staging hostname: `solserver-staging.sollabs.com`
- Prod hostname: `api.sollabshq.com`
- Region: SJC
- Persistence: SQLite on volume (`CONTROL_PLANE_DB_PATH=/data/control_plane.db`)
- solserver requires two processes:
  - API returns 202 for /v1/chat
  - Worker processes queued transmissions
  - If worker not running, clients poll forever

Ref: dev.md.

---

## Part A — solserver production deploy (Fly)

### A1. Confirm process model in repo
- Identify exact commands for:
  - API process
  - Worker process
- Confirm how worker calls internal endpoint:
  - `/internal/topology` + `SOL_INTERNAL_TOKEN` header
  - What base URL is required (`SOL_INTERNAL_API_BASE`)

### A2. fly.toml for prod
Implement Fly process groups per Fly docs:
- `[processes]`
  - `web = <api cmd>`
  - `worker = <worker cmd>`

Mount volume:
- mount name (e.g., `solserver_data`) to `/data`

Set env var for both processes:
- `CONTROL_PLANE_DB_PATH=/data/control_plane.db`

Notes:
- Keep v0 single-region/single-machine.
- Ensure `/data` is writable and shared by both processes.

### A3. Config classification table (required)
Create a table listing each env var:
- name
- required? (Y/N)
- secret? (Y/N)
- default
- process group scope (web / worker / both)
- what it does

Start from the staging baseline (names only):
- SOLSERVER_API_KEY, OPENAI_API_KEY, SOL_INTERNAL_TOKEN
- SOL_INTERNAL_API_BASE, SOL_ENFORCEMENT_MODE
- WORKER_HEARTBEAT_LOG, WORKER_NONE_LOG
- OUTPUT_CONTRACT_RETRY_* (enabled/model/provider/on)
- SOL_INLINE_PROCESSING
- LATTICE_ENABLED, LATTICE_VEC_ENABLED, LATTICE_VEC_QUERY_ENABLED

Also include:
- CONTROL_PLANE_DB_PATH (FACT)
- Any other required env vars discovered in code

### A4. Health endpoint
Confirm the existing health endpoint path; if missing, add minimal `/health` returning 200.

### A5. Custom domain setup guidance (document-only)
Provide exact CLI commands Jam will run:
- `fly certs add api.sollabshq.com`
- `fly certs check api.sollabshq.com`

Jam will follow the DNS instructions output by Fly (Cloudflare CNAME/A/AAAA depending on what Fly prints).
Do NOT include DNS values; those are environment-specific.

### A6. Deliverable
- PR in solserver with:
  - prod fly.toml (or changes to existing)
  - any minimal code changes (health endpoint only if missing)
  - verification checklist + rollback notes

---

## Part B — solmobile TestFlight readiness

### B1. Bundle IDs (FACT from current Xcode settings)
- Debug: `com.sollabshq.solmobile.dev`
- Release: `com.sollabshq.solmobile`

### B2. Base URL configuration
Confirm where base URL is defined.
Ensure Release builds target:
- `https://api.sollabshq.com`

Preferred implementation:
- Build setting or Info.plist key for base URL; runtime reads it.

### B3. Signing
Prefer Xcode Automatic Signing:
- Confirm project has Signing & Capabilities configured for Release.

### B4. Risk check
Confirm the Minimum Deployment Target is reasonable for TestFlight testers.

### B5. Deliverable
- PR in solmobile with:
  - Release base URL wiring (if needed)
  - TestFlight checklist in PR body

---

## Part C — infra-docs v0 architecture docs

### C1. Align to existing repo structure (FACT)
Use:
- `infra-docs/architecture/diagrams/...`
- `infra-docs/architecture/structurizr/...`

### C2. Add v0 index
Create `infra-docs/architecture/v0/README.md` as the entry point that links to:
- solserver C4 diagrams and sequences
- solmobile C4 diagrams and sequences
- any runbook docs relevant to v0 invariants (worker required, DB path, topology handshake)

### C3. Validate diagrams
For each diagram/doc:
- confirm it matches codepaths and naming

### C4. Deliverable
- PR in infra-docs with:
  - v0 index README
  - any missing sequences completed
  - links verified

---

## Manual steps Jam must do (do NOT claim you did these)
Fly:
- Create prod app and volume in SJC
- Set secrets via `fly secrets set`
- Add custom domain and DNS records
- Deploy and verify

Apple:
- Create App Store Connect entry for `com.sollabshq.solmobile`
- Manage signing (auto-signing preferred)
- Archive + Upload to TestFlight
- Add internal testers

---

## Output format (for each PR)
1) Summary
2) What changed
3) Manual steps (Jam)
4) Verification checklist
5) Risks + rollback
6) FACT vs ASSUMPTION (explicit)
