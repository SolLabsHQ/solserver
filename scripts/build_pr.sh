#!/usr/bin/env bash
set -euo pipefail
source scripts/_lib.sh

load_packet
cd "$REPO_ROOT"
detect_gate_cmds

echo "Packet: $PACKET_DIR"
echo "Receipts: $RECEIPTS_DIR"

unit_rc=0; lint_rc=0; integ_rc=0
run_and_log unit "$GATE_UNIT" || unit_rc=$?
run_and_log lint "$GATE_LINT" || lint_rc=$?
run_and_log integration "$GATE_INTEGRATION" || integ_rc=$?

updates_json=$(python3 - <<'PY'
import json, os
from pathlib import Path
receipts = Path(os.environ["RECEIPTS_DIR"])
packet_dir = receipts.parent.name
def one(name):
    cmd = (receipts / f"{name}.cmd").read_text().strip()
    rc = int((receipts / f"{name}.rc").read_text().strip())
    result = "PASS" if rc==0 else f"FAIL({rc})"
    log = f"docs/pr/{packet_dir}/receipts/{name}.log"
    return {"cmd": cmd, "result": result, "log": log}
print(json.dumps({"unit": one("unit"), "lint": one("lint"), "integration": one("integration")}))
PY
)

python3 scripts/md_patch.py checklist "$CHECKLIST_PATH" "$updates_json" || true

ts=$(date "+%Y-%m-%d %H:%M")
block_file="$RECEIPTS_DIR/build_fixlog_block.md"
cat > "$block_file" <<EOF
### ${ts} — Builder gates run

- unit: \`${GATE_UNIT}\`
- lint: \`${GATE_LINT}\`
- integration: \`${GATE_INTEGRATION}\`

Results:
- unit rc: ${unit_rc}
- lint rc: ${lint_rc}
- integration rc: ${integ_rc}

Receipts:
- \`receipts/unit.log\`
- \`receipts/lint.log\`
- \`receipts/integration.log\`
EOF

python3 scripts/md_patch.py fixlog_append "$FIXLOG_PATH" "$block_file" || true

if [[ $unit_rc -ne 0 || $lint_rc -ne 0 || $integ_rc -ne 0 ]]; then
  echo "Gates failed. Fix issues, then rerun: PR_NUM=${PR_NUM:-} ./scripts/build_pr.sh"
  exit 1
fi

echo "Build PASS."
