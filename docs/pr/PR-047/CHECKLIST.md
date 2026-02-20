# CHECKLIST — PR-047

- [x] AUTO: unit gate passes
  - Command: `PR_NUM=47 ./scripts/run_pr.sh` (builder) and verifier re-run in same command
  - Evidence: `docs/pr/PR-047/receipts/unit.rc` = `0`, `docs/pr/PR-047/receipts/verify_unit.rc` = `0`
- [x] AUTO: lint gate passes
  - Command: `PR_NUM=47 ./scripts/run_pr.sh`
  - Evidence: `docs/pr/PR-047/receipts/lint.rc` = `0`, `docs/pr/PR-047/receipts/verify_lint.rc` = `0`
- [x] AUTO: integration gate passes
  - Command: `PR_NUM=47 ./scripts/run_pr.sh`
  - Evidence: `docs/pr/PR-047/receipts/integration.rc` = `0`, `docs/pr/PR-047/receipts/verify_integration.rc` = `0`
- [x] AUTO: EPIC-042 contract tests (context + precedence + breakpoint guardrail)
  - Command: `pnpm run test -- test/thread_memento_latest.test.ts test/breakpoint_engine.test.ts`
  - Evidence: `test/thread_memento_latest.test.ts` + `test/breakpoint_engine.test.ts` pass in green run
- [x] AUTO: spec lock verification passes in CI-mode
  - Command: `unset INFRA_DOCS_ROOT; PR_NUM=47 ./scripts/verify_spec_lock.sh --pr-num 47`
  - Evidence: command output `Spec verification PASS for docs/pr/PR-047/spec.lock.json`
