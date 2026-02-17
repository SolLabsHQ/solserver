#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source scripts/node_env.sh
export -f use_node_env

load_packet() {
  local pkt_json
  pkt_json="$(python3 scripts/packet.py)"
  export REPO_ROOT PACKET_DIR AGENTPACK_PATH INPUT_PATH CHECKLIST_PATH FIXLOG_PATH RECEIPTS_DIR
  REPO_ROOT="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["repo_root"])')"
  PACKET_DIR="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["packet_dir"])')"
  AGENTPACK_PATH="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["agentpack"])')"
  INPUT_PATH="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["input"])')"
  CHECKLIST_PATH="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["checklist"])')"
  FIXLOG_PATH="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["fixlog"])')"
  RECEIPTS_DIR="$(echo "$pkt_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["receipts_dir"])')"
}

autodetect_script() {
  local a b
  a="$1"; b="${2:-}"
  if [[ ! -f package.json ]]; then
    echo ""
    return 0
  fi
  local runner="npm"
  if [[ -f pnpm-lock.yaml ]]; then runner="pnpm"; fi
  if [[ -f yarn.lock ]]; then runner="yarn"; fi

  if node -e "const p=require('./package.json'); process.exit((p.scripts && p.scripts['$a'])?0:1)"; then
    echo "$runner run $a"
    return 0
  fi
  if [[ -n "$b" ]] && node -e "const p=require('./package.json'); process.exit((p.scripts && p.scripts['$b'])?0:1)"; then
    echo "$runner run $b"
    return 0
  fi
  echo ""
}

detect_gate_cmds() {
  local agentpack_text
  agentpack_text="$(cat "$AGENTPACK_PATH")"

  GATE_UNIT="${GATE_UNIT:-}"
  GATE_LINT="${GATE_LINT:-}"
  GATE_INTEGRATION="${GATE_INTEGRATION:-}"

  if [[ -z "$GATE_UNIT" ]]; then
    GATE_UNIT="$(echo "$agentpack_text" | sed -n 's/^- unit:[[:space:]]*//p' | head -n1 || true)"
  fi
  if [[ -z "$GATE_LINT" ]]; then
    GATE_LINT="$(echo "$agentpack_text" | sed -n 's/^- lint:[[:space:]]*//p' | head -n1 || true)"
  fi
  if [[ -z "$GATE_INTEGRATION" ]]; then
    GATE_INTEGRATION="$(echo "$agentpack_text" | sed -n 's/^- integration:[[:space:]]*//p' | head -n1 || true)"
  fi

  if [[ -z "$GATE_UNIT" || "$GATE_UNIT" == TBD* ]]; then
    GATE_UNIT="$(autodetect_script test test:unit)"
  fi
  if [[ -z "$GATE_LINT" || "$GATE_LINT" == TBD* ]]; then
    GATE_LINT="$(autodetect_script lint lint:ci)"
  fi
  if [[ -z "$GATE_INTEGRATION" || "$GATE_INTEGRATION" == TBD* ]]; then
    GATE_INTEGRATION="$(autodetect_script test:integration integration)"
  fi

  if [[ -z "$GATE_UNIT" || -z "$GATE_LINT" || -z "$GATE_INTEGRATION" ]]; then
    echo "BREAKPOINT: Gate commands could not be determined."
    echo "Set them in docs/pr/PR-*/AGENTPACK.md under Gates, or export GATE_UNIT/GATE_LINT/GATE_INTEGRATION."
    exit 64
  fi
}

run_and_log() {
  local name cmd log_file
  name="$1"; shift
  cmd="$1"; shift
  log_file="$RECEIPTS_DIR/${name}.log"
  echo "==> $name: $cmd"
  echo "$cmd" > "$RECEIPTS_DIR/${name}.cmd"
  set +e
  bash -c "use_node_env \"$REPO_ROOT\" >/dev/null; $cmd" > "$log_file" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$RECEIPTS_DIR/${name}.rc"
  return $rc
}
