#!/usr/bin/env bash
set -euo pipefail
source scripts/_lib.sh

load_packet
cd "$REPO_ROOT"

PR_URL_OR_NUM="${SOLSERVER_PR:-}"
REPO_SLUG="${REPO_SLUG:-}"

out_dir="$RECEIPTS_DIR"
body_file="$out_dir/pr_body_solserver.md"

cat > "$body_file" <<'EOF'
## Why
v0 production launch for SolServer: prod Fly config in SJC, SQLite on volume, and release readiness.

## What changed
* [x] Added production Fly config (separate from staging) and documented deploy procedure.
* [x] Confirmed web + worker runtime requirements and shared DB path contract.
* [x] Generated "secrets only" command and verification checklist for Jam.

## Risk
* Risk level: Medium
* Failure modes:
  * Worker not running or cannot reach internal API -> transmissions stuck
  * Volume mount or DB path mismatch -> data loss or split brain
  * Wrong internal_port / PORT wiring -> app unreachable
  * Prod domain/TLS miswire -> HTTPS fails
* Rollback plan: Revert to last known-good commit/image; keep volume intact; redeploy with prior config.

## Checks
* [x] Tested locally or verified in GitHub UI
* [x] No secrets added
* [x] Main remains PR-only
* [x] If KinCart-related: boundary rules respected (no SolOS identity/memory leakage)

## Links
Issue: TBD
ADR: TBD
Docs: TBD
Follow-ups: TBD

### Connected PRs
infra-docs: TBD
solserver:  TBD
solmobile:  TBD

### Staging Merge Gate
TBD

Revert staging after merge:
```sh
TBD
```

### Test Results
- TBD
EOF

if [[ -f "$CHECKLIST_PATH" ]]; then
  echo "" >> "$body_file"
  echo "#### Gate receipts (from checklist)" >> "$body_file"
  grep -E "unit \(AUTO\)|lint \(AUTO\)|integration \(AUTO\)" "$CHECKLIST_PATH" >> "$body_file" || true
fi

echo "Generated: $body_file"

if command -v gh >/dev/null 2>&1 && [[ -n "$PR_URL_OR_NUM" ]]; then
  echo "Applying via gh pr edit..."
  if [[ -n "$REPO_SLUG" ]]; then
    gh pr edit "$PR_URL_OR_NUM" -R "$REPO_SLUG" --body-file "$body_file"
  else
    gh pr edit "$PR_URL_OR_NUM" --body-file "$body_file"
  fi
  echo "Applied PR body."
else
  echo "Not applied. Set SOLSERVER_PR=<PR url|num> and ensure gh auth to apply automatically."
fi
