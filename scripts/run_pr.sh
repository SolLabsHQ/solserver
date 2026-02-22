#!/usr/bin/env bash
set -euo pipefail
./scripts/verify_spec_lock.sh
./scripts/build_pr.sh
./scripts/verify_pr.sh
echo "Run PASS. Next: ./scripts/pr_body_hygiene.sh (or /pr-body-hygiene)."
