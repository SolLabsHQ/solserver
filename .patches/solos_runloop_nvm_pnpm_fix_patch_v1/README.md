# Runloop patch v1 (nvm + pnpm alignment)

Problem:
- bash -c is deterministic but does not load nvm, so Node version may drift.
- better-sqlite3 failures often follow from Node ABI mismatch.

This patch:
- Adds scripts/node_env.sh to select Node from .nvmrc via nvm when available
- Updates scripts/_lib.sh run_and_log() to call use_node_env before running commands
- Suggests reverting gate commands to pnpm

Install:
- Copy scripts/node_env.sh into repo scripts/
- Apply PATCH__lib.txt edits
- Apply PATCH_agentpack.txt edits
