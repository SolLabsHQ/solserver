# PR #42: v0 Production Launch & TestFlight (v0.2)

**Date:** 2026-02-03  
**Author:** Manus AI (TPM) + Jam updates (from staging reality)  
**Status:** DRAFT (implementation-ready)

---

## 1. Summary

This PR makes v0 **real**: production deploy for `solserver` on Fly.io and internal TestFlight distribution for `solmobile`.

**Environments (as declared by Jam):**
- **Staging**: `solserver-staging.sollabs.com` (naming drift noted; keep as-is for v0)
- **Production**: `api.sollabs.com`
- **Region**: `sjc` for prod (to match staging)

**Persistence (as-built):**
- SQLite via `CONTROL_PLANE_DB_PATH`
- Staging runs **single-machine + local SQLite**
- Production should match: **Fly Volume mounted to `/data`**, DB at `/data/control_plane.db`

---

## 2. Operating Facts (from repo + staging)

### 2.1 Two-process requirement (API + Worker)

Local dev requires **two processes**:
- Web server returns `202` for `/v1/chat`
- Worker processes queued `transmissions`

If the worker is not running, transmissions stay `status=created` and clients will poll forever.

Ref: `dev.md` (SolServer Local Dev).

### 2.2 DB path contract

- Local: `CONTROL_PLANE_DB_PATH=./data/control_plane.db`
- Fly: `CONTROL_PLANE_DB_PATH=/data/control_plane.db` (volume mount)

Both the API process and worker must point to the **same** DB file.

---

## 3. Decisions Locked for v0

1) **Prod region**: `sjc`  
2) **DB**: SQLite on Fly Volume  
3) **Prod domain**: `api.sollabs.com`  
4) **Staging domain stays**: `solserver-staging.sollabs.com` (don’t rename during launch)

---

## 4. Fly.io: Production Deployment Plan (solserver)

### 4.1 Process model

Use Fly **process groups** for separate API and worker processes within the same app (recommended by Fly).  
The `fly.toml` should define `[processes]` with at least:
- `web` (API)
- `worker`

Each process group runs in its own Machine(s) inside the same Fly App.

### 4.2 Volume mount for SQLite

Create a volume in `sjc` and mount it at `/data`.  
Set `CONTROL_PLANE_DB_PATH=/data/control_plane.db` for **both** processes.

**Notes:**
- Volumes aren’t shareable across Machines in different regions; v0 stays single-region.
- Scale later only after you introduce a multi-node DB strategy.

### 4.3 Custom domain + TLS

Attach `api.sollabs.com` to the Fly app using `fly certs add api.sollabs.com`, then follow the DNS instructions Fly provides (typically a CNAME for a subdomain).

If you’re using Cloudflare proxying (orange cloud), double-check the recommended Fly setup for proxied DNS so certificate issuance works.

---

## 5. Configuration & Secrets (staging baseline)

Below is the current **staging** environment variable set (names only).  
Codex must confirm: which are required, which are optional, which are “config not secret”.

### 5.1 Authentication / Keys (treat as secrets)
- `SOLSERVER_API_KEY`
- `OPENAI_API_KEY`
- `SOL_INTERNAL_TOKEN`

### 5.2 Internal topology / worker handshake (likely config, but can be secret-stored for v0)
- `SOL_INTERNAL_API_BASE`
- `SOL_ENFORCEMENT_MODE`

### 5.3 Worker logging toggles (config)
- `WORKER_HEARTBEAT_LOG`
- `WORKER_NONE_LOG`

### 5.4 Output contract retry (config)
- `OUTPUT_CONTRACT_RETRY_ENABLED`
- `OUTPUT_CONTRACT_RETRY_MODEL`
- `OUTPUT_CONTRACT_RETRY_MODEL_PROVIDER`
- `OUTPUT_CONTRACT_RETRY_ON`

### 5.5 Processing mode toggles (config)
- `SOL_INLINE_PROCESSING`

### 5.6 Lattice flags (config)
- `LATTICE_ENABLED`
- `LATTICE_VEC_ENABLED`
- `LATTICE_VEC_QUERY_ENABLED`

### 5.7 Additional env vars required by repo (FACT from dev.md)
- `CONTROL_PLANE_DB_PATH=/data/control_plane.db` (Fly)
- (Optional, only if vector enabled)
  - `LATTICE_VEC_EXTENSION_PATH=/app/extensions/vec0.so`
  - `LATTICE_POLICY_BUNDLE_PATH=/app/policy/policy_capsules.json`
  - `LATTICE_BUSY_TIMEOUT_MS=200`

**v0 recommendation:** keep “config” values in Fly secrets for speed/consistency; migrate non-secrets into `fly.toml` `[env]` later (v0.1 hardening).

---

## 6. Deployment Steps (Prod)

### Phase 0: Create prod app (manual)
- Choose Fly app name (example: `solserver-prod`)
- `fly apps create <APP_NAME>`
- Ensure it’s in `sjc`

### Phase 1: Allocate IPs (manual)
- Ensure IPv4 and IPv6 exist (Fly Proxy + cert validation often wants IPv6)

### Phase 2: Create volume (manual)
- Create volume in `sjc` named e.g. `solserver_data`
- Mount to `/data` in `fly.toml`

### Phase 3: Configure process groups (Codex)
- Define `[processes] web=... worker=...`
- Ensure both use `CONTROL_PLANE_DB_PATH=/data/control_plane.db`

### Phase 4: Set secrets (manual)
- `fly secrets set ...` for required keys/tokens + config flags

### Phase 5: Deploy (manual or Codex-driven instructions)
- `fly deploy`

### Phase 6: Verify (manual)
- Check logs: `fly logs`
- Hit health endpoint (Codex must confirm path; add minimal if missing)
- Send a message and verify:
  - 202 accepted
  - worker consumes transmission
  - client receives final assistant message

---

## 7. Runbook: Worker handshake (Fly)

**Rollout order (from dev.md):**
1) Deploy API (creates persistent topology key + internal route)
2) Deploy Worker (refuses to start until API reachable and keys match)

**Required secret:**
- `SOL_INTERNAL_TOKEN` (worker uses it to call `/internal/topology`)

**Common failure checks:**
- `SOL_INTERNAL_API_BASE` must resolve and be reachable from worker
- Header must match token: `X-SOL-INTERNAL-TOKEN` == `SOL_INTERNAL_TOKEN`
- `/data` writable in prod

---

## 8. TestFlight Plan (solmobile)

### 8.1 Bundle IDs (from current Xcode settings)
- Debug: `com.sollabshq.solmobile.dev`
- Release: `com.sollabshq.solmobile`

### 8.2 Base URLs (v0 requirement)
- Release build must call: `https://api.sollabs.com`
- Debug build can keep local/staging depending on current config

Codex must confirm where base URL is defined and ensure Release uses prod via build config (Info.plist/build setting is preferred).

### 8.3 Signing
Preferred: Xcode **Automatically manage signing** for speed.

### 8.4 Risk: Minimum iOS version
Current target settings show a very high minimum iOS version. Verify this is intentional, because TestFlight installs require devices at or above the minimum deployment target.

---

## 9. Smoke Test Checklist (internal)

Each tester verifies:
1) App launches
2) Send message → request accepted
3) Response arrives and renders
4) No stuck “waiting” state (SSE + polling)
5) Restart app → thread still present (persistence)
6) 10–15 minutes crash-free

---

## 10. Manual Steps (Jam)

### Fly + DNS
- Create prod Fly app in `sjc`
- Create volume and mount to `/data`
- Set all Fly secrets
- Attach domain `api.sollabs.com` and add DNS records in Cloudflare
- Verify TLS certificate is issued and traffic reaches app

### Apple / TestFlight
- Create App Store Connect app with bundle id `com.sollabshq.solmobile`
- Enable automatic signing (or manage certs/profiles manually)
- Archive + upload build
- Create internal tester group + add emails
- Install from TestFlight and run smoke test

---

## 11. Open Items (Codex must answer in implementation PR)

- What is the health endpoint path (or add minimal `/health`)?
- Exact process commands for `web` and `worker` in Fly
- Confirm env var usage and which ones are truly required
- Confirm how `SOLSERVER_API_KEY` is used (server-only vs client header)
