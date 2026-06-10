export const meta = {
  name: 'phase-gate',
  description:
    'Phase-boundary production-readiness gate: clean-DB tests, compose boot + smoke, 3-lens adversarial review with skeptic verification, docs/history honesty',
  whenToUse:
    'Run after every phase implementation commit, before the next phase starts. Args: { phase: "phase-4", range: "<rev-range>", suites: [paths], smoke?: "...", skipReview?: bool, skipCompose?: bool, context?: "..." }',
  phases: [
    { title: 'Deterministic', detail: 'clean-DB suites + one-command compose boot + smoke' },
    { title: 'Review', detail: 'contract / security / crash lenses over the phase diff' },
    { title: 'Verify', detail: 'one skeptic per non-nit finding, refute-by-default' },
    { title: 'Readiness', detail: 'docs, pins, TDD-visible history, frozen-files checklist' },
  ],
}

// ---- args -----------------------------------------------------------------
// phase   (required) e.g. 'phase-3' — names test/<phase>/ and labels output.
// range   (required) git rev range of the phase's work, e.g. 'abc123..def456'.
// suites  (required) test paths for the clean-DB run: the phase's own suite
//         PLUS every previously-implemented suite (full regression).
// smoke   instructions for the compose smoke (which endpoints exist, what to
//         hit, expected statuses). Default: healthz only.
// skipReview / skipCompose  booleans (e.g. review already run inline this
//         session against the identical diff — say so in `context`).
// context free-text notes passed to every agent.
if (!args || !args.phase || !args.range || !Array.isArray(args.suites)) {
  throw new Error('phase-gate needs args { phase, range, suites[] } — see meta.whenToUse')
}
const PHASE = args.phase
const RANGE = args.range
const SUITES = args.suites
const SMOKE = args.smoke ?? 'No API smoke beyond GET /healthz on both services.'
const CONTEXT = args.context ?? ''

const COMMON = `
You are a phase-boundary gate agent for the repo in the CURRENT WORKING DIRECTORY
(verify with: git rev-parse --show-toplevel; the path contains a space — quote it).
Phase under gate: ${PHASE}. Phase diff: git diff ${RANGE}  (and git log --oneline ${RANGE}).
${CONTEXT ? `Session context from the orchestrator: ${CONTEXT}` : ''}

Binding spec, read before judging:
- MEMORY.md "Pinned contracts for the coding agent" (all pinned blocks)
- REQUIREMENTS.md (IDs: SYS/API/INV/REC/DEL), PLAN.md section for ${PHASE}
- CONTRACT-GAPS.md, and the tests under test/${PHASE}/ — tests are the spec and may NOT be weakened
- FROZEN: src/ledger/consumer.ts and migrations/ — flag ANY touch of them in the diff

Assume a hostile grader: processes SIGKILLed mid-line, forged tokens, malicious
payloads, injected corruption. Severity: blocker (invariant/pinned contract broken),
major (real defect, wrong behavior on plausible input), minor (defensible, worth
flagging), nit. Report only REAL findings — no style commentary.
`

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'file', 'claim', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'line refs / commands run / output' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: {
    isReal: { type: 'boolean' },
    reasoning: { type: 'string' },
    suggestedFix: { type: 'string' },
  },
}

const CHECK = {
  type: 'object',
  required: ['pass', 'items'],
  properties: {
    pass: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['check', 'ok', 'note'],
        properties: {
          check: { type: 'string' },
          ok: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
  },
}

const RESULT = {
  type: 'object',
  required: ['ok', 'summary'],
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
}

const LENSES = [
  {
    key: 'contract',
    extra: `LENS: contract fidelity. Line-by-line compare the diff against the pinned
contracts and the PLAN section for ${PHASE}: request ordering, validation bounds,
status codes, dedup-key namespacing, payload shapes the frozen consumer expects,
commit-before-response, env/boot contract, README/seed/doc obligations. Anything
the implementation pinned on its own that MEMORY.md does not record is a finding.`,
  },
  {
    key: 'security',
    extra: `LENS: security. Attack the boundary the diff ships: forged/expired/alg:none/
malleated tokens, algorithm confusion, timing of compares, HMAC over raw bytes vs
parsed, tenant isolation (any path where a row's tenant differs from the verified
principal), injection through any request field, namespace collisions in dedup keys,
oversized/slow bodies, privilege of the DB role used. Probe live where useful
(node -e against the modules; psql to the throwaway test DB on localhost:5433).`,
  },
  {
    key: 'crash',
    extra: `LENS: transaction boundaries and crash safety. For every statement in the
diff's DB paths ask: what remains if the process dies HERE? Verify single-commit
boundaries, response-after-commit, rollback on error, client.release on all paths,
lock lifetimes, isolation-level pins (bare BEGIN is a known repo defect class),
race two concurrent duplicates, race against an uncommitted rival insert. Check the
test-only crash hooks fire inside the windows they claim to.`,
  },
]

// ---- run ------------------------------------------------------------------
// Deterministic checks, the review pipeline, and the readiness checklist are
// mutually independent — run them concurrently; only Verify chains off Review.

const testsP = agent(
  COMMON +
    `
TASK: clean-DB full test run. Execute exactly:
  bash scripts/test.sh ${SUITES.join(' ')}
(from the repo root; this tears down and recreates the throwaway test Postgres).
ok=true only if EVERY test passes. Summarize counts and any failure tail verbatim.`,
  { label: 'gate:tests', phase: 'Deterministic', schema: RESULT }
)

const composeP = args.skipCompose
  ? Promise.resolve({ ok: true, summary: 'skipped by args.skipCompose' })
  : agent(
      COMMON +
        `
TASK: prove the one-command prod run (DEL-2). Steps:
1. docker compose ps — if the dev stack is ALREADY running, do not restart it; note it
   and smoke against it, and leave it up afterwards.
2. Otherwise: docker compose up --build -d --wait   (then poll GET /healthz on
   http://localhost:3001 and http://localhost:3002 until 200, max ~90s).
3. Smoke, per this phase: ${SMOKE}
   Credentials: the pre-minted JWTs documented in README.md (signed with the compose
   JWT_SECRET). Use fresh random idempotency keys, never the README literal ones.
   You may verify DB effects via: docker compose exec -T postgres psql -U postgres -d billing -c "..."
4. If YOU started the stack: docker compose down (NO -v; leave the volume).
ok=true only if boot + healthz + every smoke expectation held. Report each step's result.`,
      { label: 'gate:compose', phase: 'Deterministic', schema: RESULT }
    )

const reviewP = args.skipReview
  ? Promise.resolve([])
  : pipeline(
      LENSES,
      (l) => agent(COMMON + l.extra, { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS }),
      (review, lens) =>
        parallel(
          (review?.findings ?? [])
            .filter((f) => f.severity !== 'nit')
            .map((f) => () =>
              agent(
                COMMON +
                  `
A reviewer (lens: ${lens.key}) made this finding. REFUTE it if you can — reproduce it
or prove it wrong against the actual code, pinned contracts, and tests yourself
(run probes; do not take the reviewer's word). Default to isReal=false unless the
evidence stands up.

FINDING [${f.severity}] ${f.title} (${f.file})
Claim: ${f.claim}
Evidence: ${f.evidence}`,
                { label: `verify:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT }
              ).then((v) => ({ ...f, verdict: v }))
            )
        ).then((verified) => ({
          lens: lens.key,
          nits: (review?.findings ?? []).filter((f) => f.severity === 'nit'),
          verified: verified.filter(Boolean),
        }))
    )

const readinessP = agent(
  COMMON +
    `
TASK: docs/history honesty checklist for ${PHASE}. Evaluate each item and report it:
1. frozen-untouched: git diff --name-only ${RANGE} contains neither src/ledger/consumer.ts
   nor anything under migrations/.
2. tdd-visible: git log --oneline shows the phase's failing-test commit(s) predating the
   green implementation commit(s) in ${RANGE}; no squash of red into green.
3. readme-honest: every README claim about behavior matches what is actually shipped as
   of this diff (no present-tense claims about unbuilt routes; credentials/curls work as
   written; price book and run instructions accurate).
4. pins-amended: any contract decision visible in the diff (status codes for unpinned
   cases, formats, bounds, key shapes) is recorded in MEMORY.md's pinned blocks — an
   implementation that silently invents a contract fails this item.
5. gaps-logged: anything the phase deliberately did not do (accepted risks, deferred
   hardening) is written down in MEMORY.md / DESIGN.md / commit message, not hidden.
6. memory-phase-log: MEMORY.md's Phase log has an entry for ${PHASE}, or the orchestrator's
   context explains it is pending this gate's outcome (note which).
pass=true only if every item is ok (item 6 may be ok-with-note when pending the gate).`,
  { label: 'gate:readiness', phase: 'Readiness', schema: CHECK }
)

const [tests, compose, reviews, readiness] = await Promise.all([testsP, composeP, reviewP, readinessP])

const lensResults = (reviews ?? []).filter(Boolean)
const confirmed = lensResults.flatMap((r) => r.verified.filter((f) => f.verdict?.isReal))
const refuted = lensResults.flatMap((r) => r.verified.filter((f) => f.verdict && !f.verdict.isReal))
const nits = lensResults.flatMap((r) => r.nits)
const blocking = confirmed.filter((f) => f.severity === 'blocker' || f.severity === 'major')

const ready =
  Boolean(tests?.ok) && Boolean(compose?.ok) && blocking.length === 0 && Boolean(readiness?.pass)

log(
  `gate ${PHASE}: tests=${tests?.ok} compose=${compose?.ok} confirmed=${confirmed.length} ` +
    `(blocking=${blocking.length}) refuted=${refuted.length} nits=${nits.length} ` +
    `readiness=${readiness?.pass} -> ready=${ready}`
)

return {
  ready,
  phase: PHASE,
  range: RANGE,
  tests,
  compose,
  readiness,
  confirmed,
  refuted,
  nits,
  note:
    'ready=true is necessary, not sufficient: the engineer reviews the surfaced transaction ' +
    'boundaries and signs off before the next phase starts (CLAUDE.md per-phase review gate).',
}
