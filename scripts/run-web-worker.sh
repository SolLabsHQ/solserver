#!/usr/bin/env bash
set -euo pipefail

node dist/index.js &
web_pid=$!

node dist/worker.js &
worker_pid=$!

terminate() {
  kill -TERM "$web_pid" "$worker_pid" 2>/dev/null || true
  wait "$web_pid" "$worker_pid" 2>/dev/null || true
}

trap terminate TERM INT

wait -n "$web_pid" "$worker_pid"
exit_code=$?

terminate
exit "$exit_code"
