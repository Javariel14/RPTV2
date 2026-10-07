# E3C3A — Commercial Shell + Authorized Order Read Workspace

## Baseline and scope

E3C3A-P0 was approved by the orchestrator. I1 implementation was explicitly authorized.
Precheck: clean `main`, HEAD/main/origin-main `d641198ed575fe0aa7585e815bd1de3203aa589a`.
Created `feature/e3c3a-order-read-workspace`; HEAD remains unchanged. No checkpoint.
The web client consumes the existing E3C2 list/detail/history contracts. No domain,
API semantics, authorization, RLS or migration changes. Twenty historical migrations remain intact.

## Implementation chronology

- A: GET-only local/test Orders BFF with exact paths/queries, duplicate rejection,
  fixed loopback bridge, server session cookie, no authority-header forwarding,
  15-second timeout, safe errors/request IDs and no-store.
- A: shared local PostgreSQL runtime injects FoundationService and OrderReadService.
  Twelve authorized canonical Orders are created through calculation/QuoteVersion/
  acceptance/Order services, with financing, lines, adjustments, cancellation and
  replacement history. Separate foreign, empty, create-only and revoked identities
  support boundary testing. Synthetic lab only; no production seed.
- B: scoped CommercialShell and `/orders` table/mobile cards, exact number/status
  filters, page-size controls and opaque forward cursor navigation with a local Back stack.
- C: URL-backed detail, immutable accepted snapshot, exact financial strings,
  catalog/bundle lines, financing and oldest-first lifecycle history. No mutation controls.
- D: persistent CRM navigation entry, responsive styles, keyboard/error/empty/session
  states and focused Orders Playwright script. Other workspaces are not migrated.
- First browser attempt exposed unresolved ESM `.js` specifiers in shared TS contracts.
  A bounded Next Turbopack alias configuration resolves existing contract sources;
  no contract changes. This necessary adapter addition makes the inventory 21 files
  (15 created / 6 modified), rather than P0's approximate 20.
- A test-only exact label selector timed out after startup changes; corrected to the
  semantic combobox selector. No authorization assertions or expectations were weakened.

## UX decisions

UNDERSTAND: operational Order reading, no command authority inferred from visible navigation.
DEFINE: one list/detail primary task, explicit server-authorized scope and immutable conditions.
IDEATE: dense desktop table, mobile cards, real detail URL and ordered timeline.
DELIVER: semantic landmarks/table/time, visible focus, skip link, safe status states,
exact decimal formatting, accessibility/viewport checks and PostgreSQL-backed journeys.

## Validation

- `npx.cmd tsx --test tests/unit/order-ui.test.ts tests/unit/order-read.test.ts`: 5/5 PASS.
- Five focused integration files (Order BFF/read API, Quote workflow, commercial lifecycle,
  reconciliation), `--test-concurrency=1`: 88/88 PASS, including fresh 20-migration bootstrap.
- Order BFF rerun after prototype-key/method-tunneling negative coverage: 6/6 PASS.
- Typecheck and scoped ESLint: PASS. `npm.cmd run security`: PASS, including compiled-client scan.
- Initial completed Orders E2E: 5/5 PASS. Real DB list/search/filter/pagination,
  detail/snapshot/financing/provenance/history, browser Back, 390x844 mobile,
  no document overflow, Axe zero critical/serious violations and safe 401/404/422/503 states.
- Final completed Orders E2E: 5/5 PASS, including HttpOnly/browser-storage checks.
- Adjacent E2E: CRM 16/16 PASS; Recruiting 8/8 PASS; Agenda 5/5 PASS.
- Field E2E: two failures at the shared login precondition (`.field-list article`
  absent; authenticated Today view reports zero visits). Interrupted the running
  battery immediately after inspecting the failures, per I1 stop policy.
- Read-only diagnosis: at `2026-10-05T03:53:27Z`, the browser local day in
  America/Guayaquil is `2026-10-04`, while the pre-existing UTC seed builds the
  linked appointment/visit at `2026-10-05T15:00:00Z`. The Field Today query ends
  at `2026-10-05T05:00:00Z`, so that visit is outside its range. The seed's
  `setUTCHours`/`setUTCDate` logic is unchanged from HEAD. This is a pre-existing
  time-dependent local fixture/harness mismatch, not evidence of an Order/RLS defect.
- Foundation/reference E2E and the additional real history cursor/denied-refresh
  test: NOT_RUN after the failure stop. The additional test source is present but
  is not certified as passing. No Field code/test/seed-date repair or retry was made.
- Desktop/mobile screenshot review completed. Evidence/logs stay in ignored `work/`.
- Canonical full verify: NOT_RUN_BY_DESIGN. Independent adversarial review is the next gate.

## Security delta

Assets/data: authorized canonical Order DTOs and immutable accepted commercial values.
Trust boundaries: browser → local Next BFF → secret-protected server bridge → existing `/v1` API → runtime PostgreSQL/RLS.
Attack surface: only allowlisted GET list/detail/history; no Order command route or browser DB access.
Privilege model: unchanged server-session identity, additive tenant/workspace/market/capability checks; navigation is not authority.
Inputs/outputs: bounded strict query schemas and UUID paths; canonical DTO validation; safe status/request IDs only in UI errors.
Abuse modes/mitigations: unsupported/duplicate/prototype query keys, method tunneling, arbitrary target and browser authority ignored/rejected; no request body; timeout and no-store.
Security tests: real runtime authorization, create-only read denial, immediate next-request revocation, foreign/absent equivalence, cursor/limit rejection and HttpOnly session isolation.
Logging/detection: existing API request/trace IDs retained; failures expose correlation reference, not SQL or stack text.
Recovery/rollback: uncommitted local changes only, isolated disposable lab; existing backend and migrations unchanged.
Residual risk: local/test bridge remains intentionally production-disabled; no production authentication/release readiness claim. Cached presentation is discarded on a failed revalidation; no realtime revocation notification is promised.
Financial values are never converted through Number or recalculated; null/malformed remains unavailable, ISO currency and ROUND_HALF_UP provenance remain visible.

## Multiplatform and next gate

MULTIPLATFORM_COMPATIBILITY = PASS: only web presentation/local adapter changes;
shared HTTP contracts, identity, domain, pricing, concurrency, audit and RLS remain backend-owned.
No unrelated dependencies, lockfile drift, migration 21, commit, push, PR or remote CI.
RESULT = FAIL. STATUS = LOCAL_VALIDATION_FAILURE_REQUIRES_REVIEW.
BLOCKERS: Field E2E fixture date mismatch; Foundation regression and added history
append/denied-refresh validation remain unexecuted under the stop policy.
No independent-review readiness claim. No canonical verify, checkpoint, push or PR.
NEXT = ORCHESTRATOR_E3C3A_LOCAL_VALIDATION_FAILURE_REVIEW.

## R0 review and SF1 targeted repair

R0 confirmed the pre-existing UTC/Ecuador fixture mismatch and R0-L1 LOW:
history denial cleared history but could leave the parent's protected snapshot visible.
I1's failed validation above remains historical evidence, not a passing gate.

- SF1: the detail owner now invalidates its snapshot after protected 401/403/404
  from detail or history, including pagination. History events/cursors and all
  detail sections are removed. Abort plus request-generation/current-request guards
  prevent older completions from restoring protected data. No global state library.
- Transient 503/network failures do not establish revocation: previously authorized
  detail/history can remain with a safe retry error. This corrects the earlier
  overly broad statement that every failed revalidation discards cached presentation.
- A fresh local candidate review found denied-query A→B→A retry suppression;
  path-change cleanup now clears that latch, with a browser regression.
- Synthetic fixtures capture one `now`, derive America/Guayaquil calendar dates
  through existing temporal helpers, and convert intended local times to instants.
  Field Playwright explicitly uses that zone. Field production semantics are unchanged.
- Unit: `npx.cmd tsx --test tests/unit/order-ui.test.ts tests/unit/order-read.test.ts`:
  7/7 PASS, including UTC/business midnight and year rollover with injected time.
- Integration: BFF plus E3C2 read API, serial execution: 19/19 PASS, including
  initial history access followed by real SQL permission revocation and safe 404.
- Ephemeral real PostgreSQL/API/BFF/browser probe: authorized detail/history rendered;
  SQL revocation made the next history request return 404; all protected presentation
  cleared; releasing an older real 200 detail response did not restore it. PASS.
- Orders E2E: 10/10 PASS; real history cursors, append/order/exhaustion, invalid
  cursor 422, initial/pagination denial, late response, transient retry, responsive/Axe.
  The new session-restoration test initially omitted Origin (403); corrected to a
  same-origin browser fetch without changing CSRF or its expected success status.
- Field E2E: 7/7 PASS. Foundation/reference E2E: 3/3 PASS.
- Root/web typecheck, scoped ESLint and Prettier: PASS. No canonical verify.
- Directly affected Agenda E2E: 1/5 PASS, 4 FAIL at login (expected 2 rows, got 0).
  Its unchanged `isoDay()` uses UTC while the authenticated range uses Ecuador.
  At diagnostic time 2026-10-05T04:41:33.823Z, UTC day was October 5 and Ecuador
  day October 4: Agenda queried from October 5 05:00Z; today's fixture was October 4
  15:00Z. The failure snapshot showed October 5 and zero rows. The old UTC fixture
  masked this separate pre-existing Agenda bug. No blind rerun or Agenda repair.

Security delta: asset = previously authorized Order snapshot/history; trust signal =
authoritative denial; mitigation = parent invalidation plus stale completion suppression.
Backend/authz/RLS changes = NONE. Multiplatform compatibility = PASS: shared `/v1`
remains authority; client clearing is presentation privacy hygiene; date fix is lab-only.
R0-L1 = CLOSED_BY_SF1_PENDING_INDEPENDENT_REVIEW. No new security finding confirmed.
All 20 migrations unchanged; no migration 21, next-env noise, lockfile change or checkpoint.
RESULT = BLOCKED. Further Agenda production-view repair is outside the two authorized
defects and would add a 24th intended file, beyond SF1's 23-file guard.
BLOCKER = AGENDA_CALENDAR_AUTHORITY_REQUIRES_SCOPE_DECISION.
STATUS = LOCAL_VALIDATION_FAILURE_REQUIRES_SCOPE_REVIEW.
NEXT = ORCHESTRATOR_E3C3A_SCOPE_REVIEW. No canonical verify, commit, push or PR.

## SR1 review and TF1 authenticated calendar-time fix

SR1 confirmed Agenda's UTC `isoDay()` as a pre-existing production temporal
defect and approved a narrow E3C3A prerequisite. TF1 now derives calendar days
from an explicit IANA timezone: browser/device is the initial fallback and
`CrmSession.timezone` becomes authoritative when authenticated context arrives.
Auto-Today resynchronizes; manual day selection is preserved until Today is
pressed again. Calendar-day and range-boundary authority are aligned. No Ecuador
timezone is hardcoded in production, and no API/domain/auth/migration changed.

Deterministic helper/state tests, including UTC/local midnight, month/year rollover,
non-Ecuador timezone, invalid timezone fallback and manual/auto resync: 12/12 PASS.
Root/web typecheck and scoped ESLint: PASS. The first Agenda E2E attempt did not
start tests because an isolated local harness timed out; after diagnosing and
removing only that orphan process, the directed execution ran 5 tests: 2 PASS,
3 FAIL. The unchanged E2E reschedule step still derives a day with UTC
`toISOString().slice(0, 10)`. During the observed UTC/local mismatch it moved the
appointment to the next authenticated calendar day, correctly removing it from
Today and causing later shared-state expectations to fail.

Repairing that deterministic E2E assumption requires changing
`tests/e2e/agenda.spec.ts`, which would be a 26th intended file. TF1's explicit
scope gate permits at most 25, so no test/source workaround, blind retry or further
suite execution was performed. RESULT = BLOCKED.
STATUS = TEMPORAL_FIX_SCOPE_EXCEEDED.
NEXT = ORCHESTRATOR_E3C3A_TEMPORAL_SCOPE_REVIEW. No canonical verify, commit, push or PR.

## TSR2 scope review and VF1 final local validation

TSR2 confirmed that the Agenda E2E UTC assumption also predates E3C3A and
approved `tests/e2e/agenda.spec.ts` as the 26th and final intended file. VF1
keeps every exact business assertion and replaces only its human-calendar-day
calculation: the browser reads the authenticated `/api/crm/context` timezone,
captures the current instant, and the existing `calendarDayInTimeZone` helper
derives the reschedule day. No hardcoded date, retry, timeout increase, skip or
weakened count assertion was introduced.

- Agenda temporal unit/contract set: 12/12 PASS.
- Agenda E2E: 5/5 PASS, including the full critical/serious Axe check.
- Field E2E: 7/7 PASS; Orders E2E: 10/10 PASS; Foundation E2E: 3/3 PASS.
- Orders reconfirmed parent/detail/history invalidation, late-response rejection,
  transient retry and session recheck. R0-L1 remains closed pending review.
- Root typecheck, scoped ESLint, Prettier and diff check: PASS.
- Security/authz/RLS/API/domain/database contracts: unchanged. Migrations remain
  20; no migration 21, dependency, lockfile or generated-file drift.

RESULT = PASS. STATUS = PASS_LOCAL_READY_FOR_INDEPENDENT_REVIEW.
NEXT = ORCHESTRATOR_E3C3A_ADVERSARIAL_REVIEW. No canonical verify, commit, push or PR.
R1 then failed only E3C3A-R1-L1 (LOW); R1F1 aligned the visible inclusive range with the authenticated timezone and passed temporal 8/8, Agenda 5/5, Field 7/7, Orders 10/10 and Foundation 3/3. Closure remains pending R2.
