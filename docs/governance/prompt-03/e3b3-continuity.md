# E3B3 — Quote approval, acceptance and Order boundary

## Precheck and domain boundary

Local branch `feature/e3b3-quote-order-approval-workflow` started clean at merged
E3B2 base `ff8d8d599ec6a82bd70273394a6dce24067c3358`. No commit, push or later
package is authorized. E3B1 is still the only calculator; E3B2 still owns immutable
QuoteVersion/line snapshots and calculationHash. No monetary formulas or signing
system are introduced by E3B3.

## Initial implementation

Five append-only artifacts: approval request, approval decision, publication,
acceptance and `cpq_order`. Each binds tenant, workspace, market, Quote, exact
QuoteVersion UUID/number, calculationHash and tenant key ID/tag. UUID equality or
equal calculationHash between versions cannot transfer an approval/acceptance.
Request uniqueness permits one request and one decision per version. A rejection
requires a new commercial revision, not a rewritten decision. Pending requests
become non-actionable/superseded when the version is no longer current or the
Quote leaves draft. Completed decisions keep their historical status.

Approval capabilities use `quote_approval` request/read/decide. Order capabilities
use `cpq_order` create/read. They are additive to parent Quote object/read rights,
workspace policy, tenant and operational-market/admin scope. No Product, Trust,
Network, Catalog, Pricing or quote-create capability grants approval or Order
authority implicitly. Self-decision fails closed for requester, commercial owner
and version creator; there is no administrator override.

PostgreSQL evaluates fresh authority on decision insertion and captures actor,
request, timestamp and policy version. Legitimate prior decisions remain valid
historical authorizations after subsequent grant revocation; revocation prevents
new decisions, not retroactive destruction of history.

## Publication and commercial authenticity

The new forward migration replaces the existing publication guard function, not
its historical migration. Publication still requires the current authentic
immutable version and actor publication authority. A final result requires no
approval; `requires_approval` requires an approved exact-version request/decision;
incomplete results remain non-publishable. Approval never changes the result,
requiresApproval flag, hash, lines or attestation.

Historical HMAC verification uses the existing E3B2 tenant key ID and exact signed
envelope. Old keys need not remain active, but their original IDs/secrets must be
retained. Missing/mismatched keys fail closed. No runtime secret access or signing
oracle is added. Authentication does not recalculate commercial values.

Every successful issue records the exact immutable publication. Acceptance binds
that publication/current version, has explicit recorded method/note/actor and
canonical CRM Person reference when the Quote has one. This is an administrative
business record, not cryptographic customer consent or electronic signature.
The existing QuoteService accept operation also creates this artifact using
`administrative_record`; direct status UPDATE cannot omit acceptance because of
the deferred database constraint. Acceptance advances the aggregate to accepted;
accepted Quotes cannot be revised.

## Order source and concurrency

Order creation reads only acceptance and immutable QuoteVersion/line history.
It stores an exact copy of the accepted commercial result, currency and source
identities. Lines reference the immutable source version's ordinal lines rather
than duplicating a mutable OrderLine table. Tax, adjustments, financing, bundle
composition, product ancestry and published-pricing provenance remain available
without current catalog lookups. There is no repricing, calculation or signing
on conversion, even after live price changes or pricing-read revocation.

One canonical Order per accepted QuoteVersion is enforced by UNIQUE plus Quote
row locking. Concurrent conversions return the same existing authorized Order;
the database constraint remains the final backstop. Stable UUID identity is
sufficient; no MAX()+1 order-number generator is introduced. Initial Order status
is only `created`; fulfillment/payment/cancellation workflows are deferred.

Mutations reuse actor-bound, operation-scoped idempotency receipts, canonical
request digests, transactional locks and audit. Expected aggregate versions
reject stale operations. Identical retries reauthorize before returning receipts.
Snapshots, workflow artifacts and commercial source fields reject runtime
UPDATE/DELETE/TRUNCATE. Manual actions use existing audit; external evidence uses
SourceObservation domain `quote_workflow` and explicit approval_request,
approval_decision, acceptance or order subject types. Restrictive policies and
typed database lookup prevent same-UUID cross-entity authorization aliases.

## Migration and validation chronology

CLI-created forward migration:
`20260927015824_e3b3_quote_order_approval_workflow.sql`. Historical E3A1/E3A2/E3B1/
E3B2 migrations are unchanged; Field Sales and UI are unchanged.

Initial TypeScript compilation passed. During test expansion, inferred UUID-only
helper key types and unused copied fixture helper imports were found and fixed
before final validation, without weakening assertions. The initial focused
E3B3 run passed 2 unit tests and 12 integration tests (including the outer test);
additional negative and lifecycle assertions were then added. E3B2 regression
passed 13/13 with the new migration. Final focused/regression/full-verify evidence
and the separate read-only self-review are pending below; no checkpoint readiness
is claimed solely from this initial run.

## Deferred scope / operational requirements

No payment collection, inventory, fulfillment, post-sale, commissions, external
sync/importer, fiscal documents, e-signature, PDF, portal, messaging, notifications
or heavy UI. Non-blocking follow-ups: UI/API transport, business order numbering,
snapshot-query batching and automated tenant key management. Secure provisioning
and historical key retention remain deployment prerequisites. Local PostgreSQL
tests do not establish Supabase-provider or production readiness.

## Validation interruption — environment blocker (not a code finding)

The focused E3B1 integration regression passed 12/12 and E3A2 market-administration
regression passed 7/7. All selected unit tests passed, including E3B3 2/2. The
remaining PostgreSQL suites then failed during initdb, before their assertions,
with `No space left on device`; C: reported zero free bytes. The expanded E3B3
integration tests and remaining regression reruns therefore remain unvalidated.
The earlier E3B2 run passed 13/13 and initial E3B3 run passed 12/12 integration,
both applying the new full 17-migration history. Those earlier passes do not
establish the expanded suite's final validation.

Source security checks passed. Full verify has NOT been started. Final read-only
R1 self-review has NOT been completed and checkpoint readiness is NOT claimed.
A narrowly scoped cleanup of this turn's own stopped synthetic laboratories was
blocked by tool policy; no laboratory was deleted. Existing labs/user work remain
untouched. Free disk space is required before resuming PostgreSQL validation.

BLOCKERS = C_DRIVE_NO_FREE_SPACE
CHECKPOINT_RECOMMENDATION = FIX_BEFORE_CHECKPOINT
E3B3_STATUS = FAIL_REQUIRES_FIX
NEXT = FREE_DISK_SPACE_THEN_RESUME_FOCUSED_VALIDATION

## Validation resumed after disk recovery

Resume precheck confirmed the original branch and base HEAD, five tracked changes
and eight new E3B3 files, with no unrelated work. C: now had approximately 17 GB
free. The existing implementation was preserved; no domain, test or migration
code was regenerated or changed during this resume.

The expanded E3B3 suite passed: 2/2 unit tests and 16/16 PostgreSQL integration
tests (15 focused subtests plus the outer test). Fresh PostgreSQL applied all
17 migrations. Tests cover exact-version and same-hash replay denial, self-
approval, fresh approver authority, publication, immutable acceptance, no-
repricing Order conversion, idempotency/concurrency, direct SQL, tenant/market/
workspace boundaries, historical keys and intentionally colliding typed evidence
subjects. Complete foundation regressions, full verify and final read-only
self-review follow; this entry does not yet claim checkpoint readiness.

Complete focused foundation regressions then passed (64/64 tests): E3B2 3 unit
and 13 integration; E3B1 16 unit and 12 integration; E3A2 2 unit and 12
integration (5 catalog/pricing plus 7 market-administration/security); E3A1
1 unit and 5 integration. Every integration fixture applied the current fresh
migration history. E3B2 H1 attestation tampering/non-final publication defenses,
immutable snapshots, current-version protection and revoked authority remained
green. Historical migrations and Field Sales remain untouched.

## Final validation and read-only self-review

The repository-standard `npm.cmd run verify` completed successfully exactly once
after the resumed focused checks: format, lint, typecheck, 50/50 unit tests,
security checks, 144/144 integration tests, web/Cloudflare build and API dry-run
build. No Playwright or remote deployment was run. Fresh PostgreSQL validation
passed the full 17-migration history, including the Foundation RLS gate.

Next type generation temporarily changed only the two generated route-type
imports in `apps/web/next-env.d.ts`; after builds they were restored to their
pre-validation content. This is not an E3B3 implementation file and has no final
diff. The complete worktree remains 13 files: five tracked changes and eight new
files. No implementation/test/migration correction was made during this resume.

The separate final adversarial read-only self-review covered every tracked/new
file and the relevant inherited authorization/attestation boundaries. Exact
version UUID/context binding, immutable decisions and same-hash replay denial
prevent approval transfer. Self-decision and revoked/new approver authority fail
closed. Publication retains E3B2 authenticated non-final/H1 defenses and requires
the current exact approved version. Acceptance references its immutable exact
publication; the deferred constraint prevents direct status-only acceptance.
Order conversion copies the accepted immutable result/lines, without pricing,
calculator or signer calls. Parent row locks and uniqueness serialize decisions,
acceptance, revision/publication and canonical Order creation. Reauthorization
precedes idempotent responses. Tenant, workspace, market and object authorization
remain additive; runtime has no artifact mutation/truncation or signing-key
access. Typed SourceObservation lookup plus restrictive policy prevents the
intentional same-UUID cross-entity evidence alias. Tests assert direct SQL errors
and deferred constraints, realistic equivalent-capability foreign actors, genuine
approval-required snapshots, changed live prices and concurrent requests.

Historical migrations, Field Sales and production UI remain unchanged. The
documented deployment key retention/provisioning and deferred transport/numbering/
batching remain non-blocking local-package follow-ups, not production readiness.
Final `git diff --check` passes; no commit, push, PR, merge or E3B4 work occurred.

E3B3_SELF_REVIEW_RESULT = PASS
FINDINGS_CRITICAL = NONE
FINDINGS_HIGH = NONE
FINDINGS_MEDIUM = NONE
FINDINGS_LOW = NONE
BLOCKERS = NONE
CHECKPOINT_RECOMMENDATION = READY_FOR_CHECKPOINT
E3B3_STATUS = PASS_LOCAL_READY_FOR_CHECKPOINT_REVIEW
NEXT = ORCHESTRATOR_E3B3_R1_REVIEW_BEFORE_CHECKPOINT

## Independent E3B3-R1 review and checkpoint readiness

The independent read-only R1 reviewed all 13 E3B3 files (five tracked changes
and eight new files), the inherited security boundaries and every required
approval, publication, acceptance and Order invariant. Its focused rerun passed
2/2 unit tests and 16/16 PostgreSQL integration tests, applying all 17 migrations
on fresh PostgreSQL. Full verify was not repeated; the completed 50-unit,
144-integration and web/API build evidence remained consistent.

R1 confirmed exact-version approval/acceptance binding, same-hash replay denial,
self-approval separation, immutable decisions and snapshots, E3B2 H1 protection,
no-repricing Order conversion, transactional concurrency and idempotency,
tenant/workspace/market/object authorization and typed provenance. Historical
migrations and Field Sales were unchanged. Generated `apps/web/next-env.d.ts`
had no current diff and is excluded from the checkpoint.

The initial implementation, disk-space interruption, recovery, resumed validation
and initial self-review above remain historical evidence. Non-blocking follow-ups
remain API/UI transport, business-readable Order numbering, snapshot-query
batching and automated key management. Production key provisioning and historical
key retention remain operational prerequisites.

E3B3_R1_REVIEW_RESULT = PASS
E3B3_R1_FINDINGS_CRITICAL = NONE
E3B3_R1_FINDINGS_HIGH = NONE
E3B3_R1_FINDINGS_MEDIUM = NONE
E3B3_R1_FINDINGS_LOW = NONE
E3B3_R1_CHECKPOINT_RECOMMENDATION = READY_FOR_CHECKPOINT
E3B3_STATUS = PASS_LOCAL_READY_FOR_CHECKPOINT
NEXT = CREATE_LOCAL_E3B3_CHECKPOINT

## Local checkpoint creation, verification and continuity-only repair

After independent R1 passed with no findings, the authorized local checkpoint
was created as `6ae1b11ec7af1b92d41a3a83d1d4ed4b805a0a45`, subject
`feat(workflow): add E3B3 quote approval and order boundary`. It contained exactly
the 13 reviewed E3B3 files, including all eight previously untracked files.
`apps/web/next-env.d.ts` was excluded. Post-commit diff checking passed and the
worktree was clean. No push, PR or merge occurred.

The subsequent read-only checkpoint verification refreshed remote references and
confirmed the expected base, zero commits behind origin/main and one E3B3 commit
ahead. Code, security, commercial, migration and secret-leak integrity passed.
Verification temporarily blocked push solely because this document recorded
checkpoint readiness but not completed checkpoint creation. This was a
documentation omission, not an implementation or validation failure.

The explicitly authorized documentation-only repair appends this chronology and
amends the existing unpushed checkpoint without changing its subject. It resolves
the missing checkpoint-creation record; the original SHA remains historical
evidence, while the amended SHA is reported by Git and the repair report. No
application, calculator, test, migration or package-metadata change is included.
No tests or full verify are repeated for this repair.

E3B3_R1_REVIEW_RESULT = PASS
E3B3_R1_FINDINGS_CRITICAL = NONE
E3B3_R1_FINDINGS_HIGH = NONE
E3B3_R1_FINDINGS_MEDIUM = NONE
E3B3_R1_FINDINGS_LOW = NONE
E3B3_R1_CHECKPOINT_RECOMMENDATION = READY_FOR_CHECKPOINT
E3B3_LOCAL_CHECKPOINT_CREATED = YES
E3B3_ORIGINAL_CHECKPOINT_SHA = 6ae1b11ec7af1b92d41a3a83d1d4ed4b805a0a45
E3B3_CHECKPOINT_FILE_COUNT = 13
E3B3_CHECKPOINT_DIFF_CHECK = PASS
E3B3_CHECKPOINT_WORKTREE_STATUS = CLEAN
E3B3_NEXT_ENV_COMMITTED = NO
E3B3_POST_CHECKPOINT_VERIFICATION_CODE_INTEGRITY = PASS
E3B3_POST_CHECKPOINT_VERIFICATION_SECURITY = PASS
E3B3_POST_CHECKPOINT_VERIFICATION_COMMERCIAL_INTEGRITY = PASS
E3B3_POST_CHECKPOINT_VERIFICATION_MIGRATION_INTEGRITY = PASS
E3B3_POST_CHECKPOINT_VERIFICATION_SECRET_LEAK_CHECK = PASS
E3B3_POST_CHECKPOINT_VERIFICATION_DOCUMENTATION_BLOCKER = CONTINUITY_CHECKPOINT_CREATION_NOT_RECORDED
E3B3_DOCUMENTATION_ONLY_REPAIR = CONTINUITY_CHECKPOINT_CREATION_RECORDED
E3B3_DOCUMENTATION_BLOCKER_RESOLVED = YES

Non-blocking debt remains API/UI transport, business-readable Order numbering,
snapshot-query batching and automated key management. Production key
provisioning and historical-key retention operations remain deployment
prerequisites. All earlier implementation, interruption, recovery, validation
and review entries are preserved above.
