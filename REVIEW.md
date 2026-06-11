# REVIEW.md — Requirements-Compliance Audit

An adversarial, evidence-backed audit of every requirement ID in REQUIREMENTS.md,
performed against local main at `3ea72fc` (phases 0-10 complete), 2026-06-10/11.

**Method.** A multi-agent audit: one hostile-grader pass per requirement family
(SYS, API, INV-1..4, INV-5..8, REC, DEL, OOS+EVAL, plus a docs-honesty sweep), every
non-nit finding re-verified by an independent skeptic agent against the repo, and a
completeness critic confirming all 42 IDs and all mandated re-proofs were covered.
Deterministic evidence gathered directly: the full suite run from a clean database,
a cold one-command compose boot smoke-tested with the README credentials, and a real
(rendered, not estimated) page measurement of DESIGN.md.

**Verdict: all 42 requirement IDs are met. Zero blockers, zero majors, no `not_met`.**
The skeptics confirmed four non-nit findings — every one a judgment call, a
documentation overclaim, or an already-documented accepted gap; none is a correctness
defect in code. They are flagged below for the engineer; per the fixing policy, none
was silently changed.

## Evidence baseline (measured during this audit)

- **Tests:** `npm test` from a clean throwaway DB: **133/133 green**, 17 files, 9.0s.
- **One-command boot (DEL-2, live):** `docker compose down -v` then
  `docker compose up --build` from clean volumes; both healthz 200, console 200 on
  :8080 with assets; then with README credentials: event 202 → replay 202 →
  payload-mismatch 409; cross-tenant body 403; no token 401; derived balance `"100"`
  after one `api_call×100`; balance with the admin token 401; adjustment as tenant 403,
  as admin 202 (posted −250, visible in the statement); close 2026-05 → 200, re-close →
  409; statement lines + BigInt-string total; reconcile `{"ok":true,"discrepancies":[]}`;
  webhook README recipe: first 202, byte-identical replay 202, tampered signature 401.
  Every README claim matched the running stack.
- **DESIGN.md size (DEL-4, measured):** 1,546 words / 166 lines. Headless-Chrome PDF
  render, US-letter, 1-inch margins, 11pt serif: **4 pages at line-height 1.35-1.45
  (4th page ~20-40% full); 3 pages only at the browser's tighter default line-height.**
  Words/500-per-page cross-check: 3.09. Conclusion: at or just over the limit with
  zero headroom — see the flags section.

## 1. System shape (SYS-1..7) — all met

| ID | Status | Evidence (verified, not quoted) |
|----|--------|--------------------------------|
| SYS-1 | met | Multi-tenant metering+billing: `tenants` (0001), tenant_id + composite FKs on every financial table (0002:61-77), rated events → double-entry postings (`consumer.ts:97-101`), reads/admin/reconcile APIs (`src/ledger/main.ts`). |
| SYS-2 | met | Two entry points with separate HTTP servers, containers, and DB roles (`src/ingest/main.ts`, `src/ledger/main.ts`, compose:27-54; grants 0003). Only stateless compile-time shared imports; all runtime communication via Postgres. |
| SYS-3 | met | Table-backed queue: committed INSERT before the 202 (ingest:107-151); claim via `FOR UPDATE SKIP LOCKED` (`consumer.ts:43-47`); done-mark in the same transaction as the ledger effect. Rival-claim invisibility tested (`phase2_consumer` :150). |
| SYS-4 | met | Redelivery is real and assumed: a killed claim's lock dies with the connection and the row stays `pending` (SIGKILL matrix, `phase2_crash.test.ts:67-114`); caught failures re-pend with attempts+1, dead at 5 (`consumer.ts:201-214`, poison test :173). Dedup is designed for redelivery (INV-2). |
| SYS-5 | met | Ingest accepts tenant events (JWT) and provider webhooks (HMAC over raw bytes) and publishes both through the same enqueue. Proving tests: `events_contract` :118, `webhook_contract` :106. |
| SYS-6 | met | Ledger consumes, rates via the integer price book, writes the balanced pair in one statement, serves balance/statement. Proving tests: `phase2_consumer` :85, `reads_contract` :99/:163. |
| SYS-7 | met | One container per service, no replicas; one consumer worker child. Bonus: the design tolerates two workers anyway (`phase2_crash` :149, exact-count drain). |

Nit (SYS-4, flagged): a payload that hard-crashes the worker is never counted by
`recordFailure` (it only runs on the caught-error path), and the strict-FIFO claim plus
the unconditional 1s respawn means such a row would head-of-line block the queue.
DESIGN.md:138-143 documents the poison/crash-loop non-dead-letter honestly; the
specific *queue-wedge* consequence is implied ("crash-loop") rather than spelled out.
Liveness-only; no invariant at risk. Flag, not fix.

## 2. API surface (API-1..8) — all met

| ID | Status | Evidence |
|----|--------|----------|
| API-1 | met | `POST /events`, brief-exact payload, pinned 401→403→400→enqueue order, 202 only after COMMIT (ingest:153-263). Tests: `events_contract` (24 tests: auth incl. alg:none, validation table, idempotency 202/409). |
| API-2 | met | HMAC-SHA256 over `{timestamp}.{key_id}.{raw_body}`, raw bytes before parse, length-checked `timingSafeEqual`, ±300s freshness, tenant = secret owner. Tampered (`webhook_contract` :72, :93), replayed-charged-once (`webhook.e2e` :88), retry-tolerant (202 on identical replay). |
| API-3 | met | Tenant-scoped from the verified claim only; derived BigInt-string balance (ledger:113-132). Tests: :95/:99/:113/:133 in `reads_contract`. |
| API-4 | met | Tenant-scoped statement, strict YYYY-MM, booked-period scoping, deterministic order (ledger:134-171). Tests: default-period equality, period filtering, closed-period stability. |
| API-5 | met | Admin-only by the distinct `admin === true` claim check (ledger:104-111, 228-231); enqueued `kind='adjustment'`, posted by the frozen consumer (no parallel posting path); `app_ingest` cannot set `kind` (column grant, proven by SQLSTATE 42501 test, `admin_contract` :150). |
| API-6 | met | One-winner close via append-only `period_closures` + `UNIQUE(tenant_id, period_id)`; the unique violation IS the 409. Concurrent test really races two in-flight closes (`admin_contract` :197, Promise.all, separate pool connections) and asserts one 200 / one 409 / one closure row. |
| API-7 | met | Two tenants + webhook secret seeded (seed.sql); the admin credential is a claim, not a row — pre-minted JWT in README, deviation documented in seed.sql itself. The audit re-verified all three README JWTs cryptographically against the compose `JWT_SECRET`. Accepted documented deviation; substance (admin works on first boot, no signup) fully satisfied. |
| API-8 | met | Flat integer book `{api_call: 1, storage_gb_hour: 5}`, pure BigInt `rate()`, load-bearing in ingest validation, consumer rating, and reconcile re-rating. |

Nits (flagged): the unknown-`X-Key-Id` 401 skips the HMAC compute, so it is
timing-distinguishable from a bad-signature 401 — recorded as an accepted minor in
MEMORY (GAP-9), but the code comment at `ingest:285-287` says "indistinguishable",
which overclaims; `storage_gb_hour`'s 5× multiplier is never asserted end-to-end
(every rating assertion uses `api_call`; a regression of the 5n rate would pass the
suite); `/statement` has no direct cross-tenant test (mechanism identical to
`/balance`, which has one).

## 3. The eight invariants (INV-1..8) — all met, re-proven

Each invariant was re-proven two ways: by mechanism (reasoning over the code under
concurrency, retries, crashes) and by pointing at the kill-test that fails if the
invariant is violated. Every cited test was opened and checked for vacuity.

**INV-1 zero-sum.** Balanced pair written in ONE INSERT (`consumer.ts:97-101`) — a
crash cannot leave half a pair; `UNIQUE(txn_id, account)` + two-value account CHECK +
`CHECK(amount_minor <> 0)` make a third or rogue leg impossible; append-only is a
*grant*, not a comment (0003: INSERT,SELECT only for app_ledger on financial tables).
Kill-tests: `phase1_schema` "append-only: app_ledger cannot UPDATE or DELETE financial
rows" (asserts 42501 as the real runtime role) + `phase2_consumer` standing zero-sum
check (:318).

**INV-2 exactly-once.** Dedup at the point of ledger effect:
`UNIQUE(tenant_id, originating_event_id)` with `ON CONFLICT DO NOTHING` in the same
transaction as the postings; duplicate path retires the queue row without posting.
Namespaced keys (`api:`/`wh:`/`adj:`) kill cross-channel suppression by construction.
Kill-tests, one per redelivery vector: queue redelivery (`phase2_consumer` :134
"redelivered event charges exactly once"), client retry (`events.e2e` :70 "a client
retry (same key+payload) is charged exactly once end-to-end"), webhook replay
(`webhook.e2e` :88 "a replayed delivery within the freshness window is charged exactly
once").

**INV-3 crash safety.** One DB transaction per ledger effect; the claim lock is the
lease and dies with the connection; failure bookkeeping is a separate guarded
transaction; ingest/admin 2xx only after COMMIT. Kill-tests are real child-process
self-SIGKILLs, not mocks: `phase2_crash` SIGKILL matrix at four in-transaction
boundaries (asserts zero partial rows AND `{status:'pending', attempts:0}` before
asserting clean recovery, then exactly-once), after-commit redelivery writes nothing;
`events_crash.e2e` (ingest dies before enqueue COMMIT → nothing enqueued, retry works);
`phase-8/admin_crash.e2e` both admin transactions ("kill between the INSERT and
COMMIT" → no partial state, retry succeeds once). The webhook enqueue has no dedicated
crash test but calls the *identical* `enqueue()` carrying the same hook — covered by
architecture, noted.

**INV-4 tenant isolation.** Scope only from the verified `tenant_id` claim (alg pinned
server-side, exp enforced, no fallback secret); webhook tenant = owner of the verifying
secret, body.tenant ignored; admin's body-tenant is the one pinned exception. Composite
FKs make cross-tenant postings a database error. Kill-tests: `reads_contract` :113
(cross-tenant balance isolation, exact-value both sides), `events_contract` :76
(body.tenant mismatch → 403, nothing enqueued), `webhook_contract` :106 (attribution to
secret owner), `phase1_schema` composite-FK denial.

**INV-5 no drift.** Balance derived per read (`SUM ... ::text`), never stored — no
cache to drift; BIGINT/BigInt end-to-end; hostile grep: `Number()` touches no money
anywhere in src/ (ports, poll interval, and *validated* request ints only). Kill-test:
`reads_contract` :99 — balance asserted equal to an independently computed SUM (380n).
Nit: no test exercises a sum past 2^53 (mechanism-verified, magnitude-unproven).

**INV-6 authorization.** `authAdmin` requires verified `admin === true`; a validly
signed tenant token gets 403 on all three admin routes; forged/expired/alg:none tokens
die in `verifyJwt` (canonical base64url re-encode, length-guarded timingSafeEqual,
required finite exp). Negative quantity cannot mint a credit: `quantity >= 1` at
/events and the webhook, re-validated in the consumer; adjustments are the admin-only
credit path and `app_ingest` cannot write `kind`. Kill-tests: `admin_contract` :64
("a tenant token on /adjustments → 403, nothing enqueued"), `events_contract` :53
(alg:none → 401) and :98 (negative quantity → 400, nothing enqueued, via the invalid-
payload table), `admin_contract` :150 (column-grant 42501 backstop).
**Skeptic-confirmed minor (flagged):** the negative-quantity guard is only
*kill-tested* on /events; the webhook route's and the consumer's own guards have no
direct negative test (mechanism present at all three layers; exploiting it needs a
valid webhook secret or app_ledger access).

**INV-7 immutable close.** Append-only `period_closures` (no runtime UPDATE/DELETE
grant), `UNIQUE(tenant_id, period_id)` makes one winner; close = get-or-create →
`FOR UPDATE` → INSERT closure (no ON CONFLICT — the 23505 IS the 409) → status-cache
flip, one transaction. The consumer posts only while holding `FOR SHARE` on a period
verified open *under that lock*, and reroutes forward otherwise. Kill-tests:
`admin_contract` :197 (two genuinely concurrent closes → exactly one 200/one 409/one
row) and `phase2_consumer` :230 ("a close committing mid-reroute cannot trap the event
in a closed period" — fails if the post-lock closure re-check is removed). Note: the
HTTP race would also pass under accidental serialization (inherent to black-box
racing); the DB-level interleaving is forced by the phase-2 test, and the unique
constraint makes the outcome interleaving-independent.

**INV-8 webhook integrity.** Raw bytes read before any parse (the signature covers
them); HMAC algorithm pinned server-side (no algo column in the schema — by design);
length-checked `timingSafeEqual` over hex with no lenient decode; ±300s freshness with
the timestamp bound into the string-to-sign; delivery id inside the signed body;
every auth failure an identical 401 with no side effect. Kill-tests:
`webhook_contract` :72 (tampered body → 401 — kills any verify-after-parse
implementation), :93 (re-stamped timestamp breaks the signature), stale-but-correctly-
signed → 401, unknown key → 401; `webhook.e2e` (mutated delivery id → nothing posted;
replay charged once). Nit (documented in CONTRACT-GAPS GAP-10): the *future* side of
the freshness window is enforced in code (`Math.abs`) but untested.

## 4. Reconciliation (REC-1..3) — all met

**REC-1 met.** `POST /reconcile`, admin-gated (401/403 tested), one
`REPEATABLE READ READ ONLY` snapshot; every `done` queue row re-derived and compared,
plus global legs=2/net=0 checks; 200 even when flagging, each discrepancy carries
tenant/event/txn/expected/posted. Wording note: REQUIREMENTS' "re-derives each
tenant's balance from the postings" is circular in a derived-balance design; DESIGN.md
argues this openly and substitutes the strictly stronger per-event queue-vs-postings
comparison. Faithful reading, judgment call documented in DESIGN.md.

**REC-2 met (with the documented narrowing, scrutinized below).** The expected amount
is built ONLY from the queue payload (re-rated) or the enqueued adjustment amount —
never the header. Decisive non-vacuity evidence: "an altered queue payload is flagged
even though postings and header agree" (:225) — a header-trusting mutant passes every
other test and dies here. All injection scenarios run as app_owner against real rows:
tampered posting (:165), deleted balanced pair (:179), **symmetric scale with a
net===0n pre-assertion** (:191) — explicitly defeating a zero-sum-only checker —
adjustment mismatch (:211).

**REC-3 met.** Snapshot isolation + atomic consumer commits mean an in-flight event is
fully visible or invisible, never torn. `reconcile.e2e` :58: 300 events draining
through a real worker while reconcile is hammered 8× expecting `ok:true`, **with an
anti-vacuity guard** (the test fails if no reconcile call actually overlapped
in-flight events).

Nit: the five corruption tests assert `ok === false` but never the discrepancy's
locator fields (type/tenant/expected/posted), so GAP-18's "enough to locate it" payload
is itself unproven by tests. The live Phase 7 gate smoke did verify the fields.

## 5. Deliverables (DEL-1..5) — all met; DEL-4 has zero headroom

**DEL-1 met.** 65 commits, single day, unsquashed, real branch topology (the merged
red-scaffold branch is preserved). Red-before-green verified per phase with
`git show --stat`: phase 3 `e8bf74f`→`7034d77`, phase 8 `f27b0b5`→`1378812`, phase 9
`41df701`→`75b9d76`; review-fix commits visible (`58ea8ac`, `a087c95`, `5df48ac`,
gate-fix commits). Nit: phase 8/9 red→green timestamp gaps are 3 and 6 minutes —
order proves the discipline, timestamps alone can't (plausible with an agent coding
to a pre-reviewed red suite; a hostile grader may notice).

**DEL-2 met (live-verified).** See the evidence baseline: clean-volume cold boot,
one documented command, all five containers, console included, every README credential
and curl proven against the running stack.

**DEL-3 met.** Explicitly grader-findable: `phase2_crash.test.ts` describes named
"DEL-3 crash-restart test" (real SIGKILL at 4 boundaries, asserts no-partial-state
*then* exactly-once recovery) and "DEL-3 concurrency test" (two live workers, 30
events, exact counts 30/60, receivable 465n, zero unbalanced). Both substantive.

**DEL-4 met — at the line, flagged.** Content: all five mandated elements present and
located — (a) "Architecture, and why"; (b) "How each invariant survives" covers all
eight (INV-8 via the threat-model section, cross-referenced); (c) "The dedup boundary";
(d) "Webhook threat model"; (e) "What I cut, and why" + "Honest known gaps".
Size: **measured at 3.09 words-pages; real render is 3 pages only at tight
line-height and 4 pages at common settings (11pt/1in/lh≥1.35).** Zero headroom: any
addition — including the CORS-flag note this session's work requires — tips it over.
**Action taken: Part C of this session condenses DESIGN.md (wording only, no argument
removed) so it measures ≤ 3 pages at 11pt/1-inch/1.45 line-height, including the new
material.**

**DEL-5 met.** All four elements in named sections: how-I-worked (two AI roles +
engineer, TDD, mechanized gate), delegated-vs-owned (owned: schema, transaction
boundaries, dedup key, grants), had-to-learn (5 real items incl. the U+FFFD surrogate
collapse and ON CONFLICT vs catch), agents-wrong-and-caught (four design-time catches
plus one per build phase, each cross-checked against a real commit; includes the
Phase 4 finding the skeptic *refuted* — arguing both directions). Nit: at 2,122 words
NOTES.md is longer than DESIGN.md; "short" is strained. Nit: the per-phase catch list
skips Phase 7 (its two accepted minors are in MEMORY/DESIGN — incomplete enumeration,
not concealment).

## 6. Out of scope (OOS-1..5) — all met

- **OOS-1 (UI exists, by instruction):** the override is documented in DESIGN.md's cut
  section (bolded, with "graders instructed in person"), MEMORY, NOTES, PLAN, README.
  The console is verified a pure client: `ui/app.js` calls exactly the seven existing
  endpoints, no business logic, no new server endpoint; the only protocol logic is
  SubtleCrypto HMAC signing, disclosed as a labeled local-test convenience. A grader
  reading DESIGN.md cannot mistake the brief as ignored. Nits: "dev-only" CORS is
  currently a *label*, not an enforced gate (both services attach it unconditionally) —
  **this is the one approved backend change of this session (ENABLE_DEV_CORS, off by
  default)**; MEMORY.md:139 still says "Phase 8 UI" (stale after the re-scope).
- **OOS-2..5 met:** grep-verified hit-by-hit (the only "sso" hits are `processOne` and
  `crossorigin`); single runtime dependency `pg`; no replicas/cloud/IaC anywhere. The
  console's one external reference is the Google Fonts stylesheet (cosmetic, degrades
  offline).

## 7. Evaluation criteria (EVAL-1..6) — all met

- **EVAL-1:** every cut is argued individually in DESIGN.md (price book, pagination,
  channels, currency, liveness trio), with rejected alternatives in MEMORY's decision
  log.
- **EVAL-2:** measurably correctness-weighted: ~1,510 lines of production code vs
  ~3,493 lines of tests (≈2.3:1, 133 cases), entire suites existing only for
  invariants and attack surface.
- **EVAL-3 (skeptic-confirmed, accepted documented gaps):** strongest evidence is the
  SIGKILL matrix, the two-worker drain, the concurrent close, and reconcile-under-load
  with an anti-vacuity guard. What a fault-injecting grader could still hit, in order:
  (1) the REC-2 orphan blind spot — graders inject corruption *with DB access*, which
  is exactly the class reconcile misses (forged balanced header, no queue row);
  documented and accepted, but it is the one injected-corruption class that
  demonstrably reconciles clean; (2) the poison hard-crash queue wedge (documented);
  (3) the untested future-side freshness window (documented in GAP-10). None is
  hidden; all are engineer-accepted.
- **EVAL-4:** DESIGN's known-gaps section is honest and matches the code; two
  understatements flagged below (the DESIGN:149 wording; MEMORY-only minors).
- **EVAL-5:** the catch-and-fix story is in the history itself (eight-plus visible
  review-fix/gate-fix commits), and NOTES narrates both directions including a refuted
  finding.
- **EVAL-6:** Node 24 + Postgres + vitest; trivially met.

## 8. Scrutiny of the documented gaps (mandated)

1. **REC-2 orphan-transaction non-check.** Honestly stated? Yes — DESIGN.md:144-150
   states the gap, the reason (Phase 5/6 seeds legitimately write queue-less headers;
   flagging would false-positive), and the deferral. Grant argument sound? *Mostly*:
   only `app_ledger` and `app_owner` can INSERT into transactions/postings;
   `app_ingest` (the exposed service) is fully grant-blocked — verified in 0003 and by
   the 42501 tests. **One wording overclaim (skeptic-confirmed):** DESIGN.md:149 says
   "the grant boundary makes the gap non-reachable" — for the *ledger service itself*
   non-reachability rests on code-path absence (the consumer and /adjustments are the
   only insert paths, both queue-driven — verified), which is a weaker, code-audit-
   dependent guarantee than a grant. The earlier sentence in the same paragraph
   ("requires ledger-level INSERT, which the exposed Ingest role is grant-blocked
   from") is accurate. **Flagged for the engineer; not changed** (accepted documented
   gap; a one-clause wording tighten is possible if DESIGN is touched in Part C).
2. **Unbounded reconcile scan.** Honestly stated — DESIGN.md:151-152 says exactly what
   the code does (one buffered pass over all `done` rows), with the scale argument and
   a measured datapoint in MEMORY. Acceptable for a single-node case study. No change.
3. **Dev-only CORS.** The mechanism is honestly *described* everywhere (README, MEMORY
   pin, code comments, page footer), but "dev-only" is enforced by nothing — the
   permissive headers ship unconditionally. **This is the sanctioned Part B change:**
   gate behind `ENABLE_DEV_CORS` (off by default), compose turns it on, README
   documents it. After that change the label is true by mechanism, not intent.

## 9. Docs-honesty sweep (overclaim check)

- README: every credential, status code, and curl verified against the live stack;
  test count 133 matches the clean-DB run; the manual browser checklist's 401-vs-403
  promises match the handlers (admin token on /balance → 401 because `tenantOf`
  finds no claim; tenant on admin routes → 403).
- **Confirmed doc-staleness (skeptic-verified): ARCHITECTURE.md §2 still sketches
  `webhook_secrets` with an `algo` column** — the column was deliberately dropped in
  the Phase 0 review *because* it contradicted "algorithm pinned server-side"
  (MEMORY records the drop; the migration has a comment saying why). The doc thus
  depicts the very design the build rejected. One-line doc fix; queued for Part C.
- Wording nits: ARCH/DESIGN say an idempotent retry "returns the stored/original
  response" — no response is stored; an equivalent 202 is reconstructed, and the
  payload hash covers material fields only (metric, quantity, event_date), so a retry
  differing in an extraneous field replays 202. Narrower than a literal reading;
  consistent with the pinned contract.
- UI: no localStorage/sessionStorage/cookies/console-logging of secrets (grep-clean);
  secrets are *deliberately* embedded and labeled — disclosure, not leakage. XSS
  posture before this session's hardening: all four `innerHTML` sites interpolate
  through `escapeHtml` (incl. attribute positions, double-quoted); `escapeHtml` does
  not escape single quotes (safe today, fragile under edit — addressed in Part B).
- MEMORY pinned contracts vs shipped behavior: spot-checked clean (key bound 200B,
  reason 1024B, body cap 256KiB→413 flush-then-drop, freshness 300s + the recorded
  Number() leniency, event_date regex, webhook wire contract).

## 10. Flagged for the engineer (not changed by this session)

Judgment calls and accepted gaps, per the fixing policy — surfaced, never silently
"fixed":

1. **DESIGN.md:149 wording** ("grant boundary makes the gap non-reachable") mildly
   overclaims for the ledger-service path — suggest "the grant boundary blocks the
   exposed Ingest role, and the ledger service has no code path that writes a header
   without a queue row" if DESIGN is edited anyway.
2. **EVAL-3 soft spot:** REC-2's orphan blind spot is precisely the injected-corruption
   class a DB-access grader could exercise. Documented + accepted; re-confirm that
   acceptance stands for submission.
3. **Negative-quantity kill-test coverage** exists only on /events; webhook + consumer
   guards are mechanism-verified but untested. Test-only addition if desired.
4. **`storage_gb_hour` 5× rate** never asserted end-to-end (suite would pass if the
   rate regressed). Test-only addition if desired.
5. **/statement cross-tenant test** missing (mechanism identical to /balance's tested
   path).
6. **Reconcile discrepancy locator fields** untested (tests assert `ok:false` only).
7. **DEL-4 headroom:** none — addressed by the Part C condensation (reported there).
8. **NOTES.md length** (2,122 words) vs "short"; per-phase catch list skips Phase 7.
9. **Stale lines:** ARCHITECTURE.md `algo` column (Part C one-line fix);
   MEMORY.md:139 "Phase 8 UI" (Part C one-word fix); ingest comment
   "indistinguishable" at the unknown-key 401 (timing-distinguishable; MEMORY's pin
   already states this accurately — comment is the outlier).
10. **Hybrid tokens** (admin + tenant_id passes both route classes) — pinned and
    documented; reiterated here because it is a contract surface, not a bug.

## 11. Fixes applied as a result of this audit

- **None to backend logic in Part A** — the audit found no correctness defect.
- Part B (this session, sanctioned by the work order): the `ENABLE_DEV_CORS` gate —
  making the "dev-only" claim mechanically true — plus UI hardening; reported in
  MEMORY's session log.
- Part C (docs only): DESIGN.md condensation to a measured ≤ 3 pages; the
  ARCHITECTURE.md `algo`-column staleness; the MEMORY "Phase 8 UI" stale line.
