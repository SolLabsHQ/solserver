# /run-pr (Supervisor)

You are the Supervisor.

## Goal
Run the full loop until the checklist is satisfied.
Minimize human involvement.

## Run order
1) Run Builder (/build-pr).
2) Run Verifier (/verify-pr).
3) If Verifier FAILS:
   - feed verifier findings back into Builder as constraints
   - rerun Builder then Verifier
   - allow up to 2 full cycles
4) Stop only at Breakpoints.

## Breakpoints recap
Stop only when one of these is true:
- DEVICE REQUIRED
- SIGNING/PROFILES
- SNAPSHOT INSTABILITY
- UNKNOWN FAILURE after attempt caps
- CROSS-REPO DEPENDENCY

## Output requirements
- CHECKLIST updated with evidence for all AUTO items.
- FIXLOG appended with meaningful entries.
- FIXLOG contains a Verifier Report.

## Final response
When done, output a concise status summary:
- What is green (gates)
- What is pending (DEVICE items)
- Any risks to watch
- Whether it is safe to merge after device QA
