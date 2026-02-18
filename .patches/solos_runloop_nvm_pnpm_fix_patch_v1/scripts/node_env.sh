#!/usr/bin/env bash
set -euo pipefail

# Ensure a consistent Node version inside non-interactive shells.
# This avoids relying on login-shell profile loading.

use_node_env() {
  # If repo provides .nvmrc, prefer it. Otherwise respect NODE_VERSION if set.
  local repo_root="${1:-.}"
  local nvmrc="$repo_root/.nvmrc"
  local want="${NODE_VERSION:-}"

  if [[ -f "$nvmrc" ]]; then
    want="$(cat "$nvmrc" | tr -d ' \t\n\r')"
  fi

  # Only attempt nvm if present
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"
    if [[ -n "$want" ]]; then
      nvm use "$want" >/dev/null
    else
      nvm use >/dev/null || true
    fi
  fi

  # Print for receipts/debug
  command -v node >/dev/null 2>&1 && echo "node=$(command -v node)" || echo "node=missing"
  node -v 2>/dev/null || true
}
