# PR-042 env var classification (solserver)

## Source
- `docs/dev.md`
- Runtime usage in `src/**/*` (not just defaults)

## Env matrix (required / secret / default / scope / meaning)

| Variable | Required | Secret | Default | Scope | Meaning |
| --- | --- | --- | --- | --- | --- |
| `SOLSERVER_API_KEY` | Optional (security bypass when unset) | Yes | None | web | API key for `/v1/chat`, `/v1/events`, `/v1/memories` pre-handler auth. |
| `OPENAI_API_KEY` | Yes when `LLM_PROVIDER=openai` | Yes | None | web | Required by OpenAI request path. |
| `SOL_INTERNAL_TOKEN` | Yes in Fly/production worker+API handshake | Yes | None | both (worker→API and API internal route) | Required token for `/internal/topology` auth. |
| `SOL_INTERNAL_API_BASE` | Required when worker can’t reach `127.0.0.1:${PORT}` | No | `http://127.0.0.1:${PORT}` | worker | URL used by worker topology handshake. |
| `CONTROL_PLANE_DB_PATH` | Required in non-dev for both web/worker | No | `./data/control_plane.db` | both | Shared DB path used by web and worker (`/data/control_plane.db` in prod). |
| `DB_PATH` | Optional alias for local/dev convenience | No | `./data/control_plane.db` via fallback logic | both | Alternate DB path fallback key. |
| `PORT` | No | No | `3333` | both | Port for web bind and worker default handshake fallback. |
| `SOL_ENV` | No | No | None | both | Environment discriminator for defaults and guard behavior. |
| `LLM_PROVIDER` | No | No | `fake` | web | Selects model backend (`openai` or `fake`). |
| `OPENAI_MODEL` | Yes when `LLM_PROVIDER=openai` | No | `gpt-5-nano` | web | OpenAI model used by orchestration, required when using OpenAI. |
| `OPENAI_BASE_URL` | No | No | `https://api.openai.com/v1` | web | OpenAI API base URL override. |
| `OPENAI_TEXT_FORMAT` | No | No | `json_schema` | web | Response format sent to OpenAI (`json_schema` / `json_object`). |
| `SOL_ALLOW_MODEL_OVERRIDE` | No | No | `0`/`false` | web | Enables request-based model/tier override. |
| `SOL_MODEL_DEFAULT` | No | No | None | web | Override default model for all environments. |
| `SOL_MODEL_LOCAL` | No | No | None | web | Local env model override. |
| `SOL_MODEL_FLY_DEV` | No | No | None | web | Fly dev env model override. |
| `SOL_MODEL_FLY_STAGING` | No | No | None | web | Fly staging model override. |
| `SOL_MODEL_PROD` | No | No | None | web | Fly prod model override. |
| `SOL_TRACE_DEBUG` | No | No | `0`/`false` | web, worker | Enables verbose trace logs in memory pipeline paths. |
| `TRACE_CAPTURE_MODEL_IO` | No | No | `0`/`false` | web | Captures model IO traces when non-production. |
| `LOG_LEVEL` | No | No | `debug` (dev), `info` otherwise | both | Logger verbosity. |
| `PINO_PRETTY` | No | No | Off | both | Pretty log transport in dev only. |
| `TOPOLOGY_GUARD_STRICT` | No | No | `false` | both | Forces topology/volume guard to throw instead of warn. |
| `FLY_APP_NAME` | No | No | Platform-provided | both | Marks Fly runtime; toggles production and strict guard mode. |
| `FLY_PROCESS_GROUP` | No | No | Platform-provided | both | Topology guard warning path expectation. |
| `SOL_ENFORCEMENT_MODE` | No | No | `warn` in staging, `strict` in prod via `SOL_ENV`/`NODE_ENV` | web | Driver-block enforcement mode override. |
| `DRIVER_BLOCK_ENFORCEMENT` | No | No | `warn` (staging), `strict` (prod), else warn fallback | web | Secondary enforcement mode override. |
| `WORKER_LEASE_SECONDS` | No | No | `120` | worker | Worker lease TTL. |
| `WORKER_POLL_INTERVAL_MS` | No | No | `500` | worker | Poll cadence for transmission lease loop. |
| `WORKER_HEARTBEAT_EVERY` | No | No | `20` | worker | Heartbeat/event cadence. |
| `WORKER_SUPPRESS_IDLE_LOGS` | No | No | Off (`1/true/yes` only) | worker | Reduces non-critical idle worker logs. |
| `WORKER_HEARTBEAT_LOG` | No | No | `smart` | worker | Heartbeat log mode. |
| `WORKER_NONE_LOG` | No | No | `off` | worker | Logging mode for no-op poll loops. |
| `WORKER_ID` | No | No | Auto UUID | worker | Lease identifier for worker instance. |
| `WORKER_LEASE_ATTEMPTS` | No | No | `5` | worker | Lease conflict retry attempts. |
| `WORKER_EMPTY_SCANS` | No | No | `2` | worker | Idle scan threshold behavior. |
| `WORKER_LEASE_JITTER_MIN_MS` | No | No | `10` | worker | Lease backoff jitter floor. |
| `WORKER_LEASE_JITTER_MAX_MS` | No | No | `50` | worker | Lease backoff jitter ceil. |
| `TOPOLOGY_HANDSHAKE_ATTEMPTS` | No | No | `12` | worker | Topology handshake retry attempts. |
| `TOPOLOGY_HANDSHAKE_RETRY_MS` | No | No | `5000` | worker | Topology handshake retry delay. |
| `OUTPUT_CONTRACT_RETRY_ENABLED` | No | No | `0`/`false` | web | Enables output-envelope retry flow. |
| `OUTPUT_CONTRACT_RETRY_MODEL_PROVIDER` | No | No | `openai` | web | Retry provider gate for output contract retries. |
| `OUTPUT_CONTRACT_RETRY_MODEL` | No | No | `gpt-5-mini` | web | Retry model for output contract pass. |
| `OUTPUT_CONTRACT_RETRY_ON` | No | No | `schema_invalid` | web | Retry trigger set (comma list). |
| `SOL_INLINE_PROCESSING` | No | No | Off (`1` enables) | web | Forces inline processing path for `/v1/chat` in tests/dev. |
| `LATTICE_ENABLED` | No | No | `0` | web | Enables lattice enrichment stage. |
| `LATTICE_VEC_ENABLED` | No | No | `0` | web | Enables vector path in lattice retrieval. |
| `LATTICE_VEC_QUERY_ENABLED` | No | No | `0` | web | Enables vector query usage in lattice stage. |
| `LATTICE_VEC_MAX_DISTANCE` | No | No | `null` | web | Vector radius/filter for cosine/embedding query. |
| `LATTICE_POLICY_BUNDLE_PATH` | No | No | `` (empty string) | web | Optional path to policy bundle file. |
| `LATTICE_VEC_EXTENSION_PATH` | No | No | `/app/extensions/vec0.so` | web, worker | Path for sqlite vector extension load. |
| `LATTICE_BUSY_TIMEOUT_MS` | No | No | `200` | web, worker | SQLite busy-timeout pragma. |
| `EVIDENCE_PROVIDER` | No | No | `stub` | web | Evidence provider choice. |
| `EVIDENCE_PROVIDER_FORCE` | No | No | `0`/`false` | web | Forces evidence path usage. |
| `VITEST` | No | No | None | web | Dev/test-only switch for inline processing behavior. |
| `SENTINEL_FORCE_FAIL` | No | No | `0`/`false` | web | Test/debug gate to force sentinel failure. |
