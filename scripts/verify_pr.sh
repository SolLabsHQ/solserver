#!/usr/bin/env bash
set -euo pipefail
source scripts/_lib.sh

load_packet
cd "$REPO_ROOT"
detect_gate_cmds

unit_rc=0; lint_rc=0; integ_rc=0
run_and_log verify_unit "$GATE_UNIT" || unit_rc=$?
run_and_log verify_lint "$GATE_LINT" || lint_rc=$?
run_and_log verify_integration "$GATE_INTEGRATION" || integ_rc=$?

status="PASS"
gaps="No gaps detected."
if [[ $unit_rc -ne 0 || $lint_rc -ne 0 || $integ_rc -ne 0 ]]; then
  status="FAIL"
  gaps="One or more gates failed in verifier pass. See receipts logs."
fi

cmds_file="$RECEIPTS_DIR/verifier_cmds.md"
results_file="$RECEIPTS_DIR/verifier_results.md"
gaps_file="$RECEIPTS_DIR/verifier_gaps.md"

cat > "$cmds_file" <<EOF
- unit: \`${GATE_UNIT}\`
- lint: \`${GATE_LINT}\`
- integration: \`${GATE_INTEGRATION}\`
EOF

cat > "$results_file" <<EOF
- verify unit rc: ${unit_rc}
- verify lint rc: ${lint_rc}
- verify integration rc: ${integ_rc}
EOF

echo "$gaps" > "$gaps_file"

python3 scripts/md_patch.py verifier_report "$FIXLOG_PATH" "$status" "$cmds_file" "$results_file" "$gaps_file" || true

if [[ "$status" == "FAIL" ]]; then
  echo "Verifier FAIL. Fix issues, then rerun: PR_NUM=${PR_NUM:-} ./scripts/verify_pr.sh"
  exit 1
fi

echo "Verifier PASS."
