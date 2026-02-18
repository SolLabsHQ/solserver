# SolOS Runloop (VS Code Tasks + Scripts) v1

This bundle makes your PR packet executable.

## What you get
- Deterministic scripts:
  - `scripts/run_pr.sh` (build then verify)
  - `scripts/build_pr.sh` (run gates + write receipts)
  - `scripts/verify_pr.sh` (rerun gates + append Verifier Report)
  - `scripts/pr_body_hygiene.sh` (generate PR body from receipts, optionally apply via gh)
- VS Code Tasks:
  - "PR: Run (build + verify)"
  - "PR: Build (gates)"
  - "PR: Verify"
  - "PR: PR body hygiene"

## Packet layout expected
Preferred:
- `docs/pr/PR-042/AGENTPACK.md`
- `docs/pr/PR-042/INPUT.md`
- `docs/pr/PR-042/CHECKLIST.md`
- `docs/pr/PR-042/FIXLOG.md`

The scripts auto-discover the **highest PR number** under `docs/pr/PR-*` unless you set `PR_NUM`.

## How to run
### From VS Code
Command Palette -> "Tasks: Run Task" -> choose:
- "PR: Run (build + verify)"

### From Codex.app (or any agent with terminal access)
Run:
- `PR_NUM=42 ./scripts/run_pr.sh`

Agents should loop themselves: if the script fails, fix code/config, then re-run until green.

## Environment variables
- `PR_NUM` (optional): e.g. `42`
- `GATE_UNIT`, `GATE_LINT`, `GATE_INTEGRATION` (optional overrides)
- `SOLSERVER_PR` (optional): PR URL or number for gh pr edit in pr_body_hygiene
- `REPO_SLUG` (optional): owner/repo for cross-repo gh edits

## Notes
These scripts do **not** try to "fix" code. They enforce:
- consistent gate execution
- receipts written to the packet
- checklist evidence updated
- verifier report appended

The agent does the fixing, then reruns the scripts.
