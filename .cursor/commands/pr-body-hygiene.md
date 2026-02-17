# /pr-body-hygiene

You are doing PR-body hygiene only.
Do NOT change code.

Packet discovery:
- Prefer `docs/pr/PR-*/AGENTPACK.md` and sibling INPUT/CHECKLIST/FIXLOG.
- Else `pr/PR-*/AGENTPACK.md`.
- Else match `INPUT-PR-*.md`, `CHECKLIST-PR-*.md`, `FIXLOG-PR-*.md`.

Apply updates:
- Prefer `gh pr edit <num|url> --body-file <file>`.
- Cross-repo: add `-R <owner/repo>`.
