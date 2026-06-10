---
description: Run the phase-boundary production-readiness gate (clean-DB tests, compose boot + smoke, adversarial review, docs honesty) for a phase
---

Run the production-readiness gate for: $ARGUMENTS

This is the mechanized form of CLAUDE.md's per-phase review gate. Steps:

1. Resolve the inputs:
   - `phase`: the phase id from the arguments (e.g. `phase-4`).
   - `range`: the git rev range covering this phase's implementation (and any
     review-fix) commits — find it with `git log --oneline`; never guess.
   - `suites`: the phase's own test path (`test/<phase>`) PLUS every
     previously-implemented suite: `test/phase0_infra.test.ts
     test/phase1_schema.test.ts test/phase2_consumer.test.ts
     test/phase2_crash.test.ts` and each earlier `test/phase-K` already green.
     Suites for not-yet-built phases stay out (they are red by design).
   - `smoke`: instructions for what the compose stack must serve for this
     phase (endpoints, expected statuses, DB effects), using the pre-minted
     README JWTs with fresh random idempotency keys.

2. Invoke the Workflow tool with `name: "phase-gate"` and those args. Pass
   `skipReview: true` ONLY if the identical diff already had its 3-lens
   adversarial review in this session — and say so in `context`.

3. On the verdict:
   - `ready: false` — fix every confirmed blocker/major (TDD: write the
     failing test first when the fix is behavior-visible), commit the fixes,
     and re-run the gate.
   - `ready: true` — append the MEMORY.md Phase log entry (what happened /
     what review found / what was solved), commit, then STOP and surface the
     phase's transaction boundaries, the gate verdict, and the confirmed/
     accepted findings to the engineer for sign-off.

4. The next phase does not start until the engineer clears this one.
