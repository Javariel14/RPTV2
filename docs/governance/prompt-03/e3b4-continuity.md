# E3B4 — Order commercial lifecycle

## Precheck and boundary

Started clean on `feature/e3b4-order-commercial-lifecycle` at merged E3B3
`094a5586874babc9adf3e3037ce6941ed9588e66` (PR #25). Implementation only;
no commit, push, PR or E3B5 is authorized.

The accepted `cpq_order`, QuoteVersion, lines, approval, acceptance, calculationHash
and attestation remain immutable. No calculator, signer or repricing path is added.
Commercial cancellation is internal RPT cancellation only, not refund, fiscal
annulment, inventory/fulfillment reversal or external company cancellation.

## Implementation decisions

Three bounded relations: `order_commercial_state` (one current projection per Order),
`order_commercial_event` (append-only sequence), and `order_replacement` (immutable
original/successor relationship). Initial version is 1. The only business transitions
are `created -> cancelled` and `created -> superseded`, producing version/event 2.
Both terminal states prohibit reopening. The original Order status remains its
immutable creation marker; the new projection is the commercial lifecycle authority.

New canonical Orders initialize lifecycle in the same insertion transaction via a
private trigger. Pre-E3B4 Orders receive a clearly marked `technical_bootstrap` event
at migration time with null business actor/request, never fabricated historical
business evidence. Normal initialization records the trusted Order creator/request.
The forward migration locks canonical Order writes until bootstrap and the new
initialization trigger commit together, preventing an initialization gap.

The constrained PostgreSQL commands own authorization, actor identity, receipts,
deterministic row locking, compatibility, transition, event and projection. Runtime
has SELECT only on the three relations: no direct INSERT/UPDATE/DELETE or arbitrary
finish/response helper. Projection versions reference the exact event/result through
a composite FK. Events/replacements also reject UPDATE/DELETE/TRUNCATE.
An additional context trigger validates inherited scope and replacement customer/
currency compatibility against actual canonical Orders independently of the mutation
helper, and rejects replacement cycles at relation insertion.

`cpq_order.cancel` and `cpq_order.replace` are explicit additive capabilities,
requiring existing Order read access, parent Quote object/workspace access and
operational market or authorized admin scope. Product/Pricing/Trust/Network and
Quote/Approval capabilities do not imply these verbs. Both Orders are authorized
for replacement and locked in UUID order. Both must remain `created` at the supplied
versions. They must share tenant, workspace, market, currency and the same non-null
Person. The successor must already exist through the canonical accepted Quote path;
no cloning or reopening of the accepted source Quote. Unique predecessor/successor
constraints, terminal states and recursive checking prevent cycles/replay.

Receipts reuse `authz.idempotency_receipt`, bound to actor, operation, Order identities,
expected versions and trimmed reason. Identical retries return the same response;
payload/actor mismatch conflicts. Object/workspace/market/capability authorization
is re-evaluated before returning a receipt, including after revocation. Original
Quote-to-Order retries return the original Order without resetting the projection.

History uses bounded keyset pagination by sequence, not destructive history limits.
Internal actions use existing audit digests, without fake SourceObservation rows.
Actual external evidence can use explicit `order`, `order_event`, `order_replacement`
subjects in domain `order_commercial`; PostgreSQL resolves the exact typed entity.
A restrictive SourceObservation policy closes permissive OR branches. Helpers use
fixed `pg_catalog` search paths, qualified names and explicit grants. No service_role
or runtime owner access is introduced.

## Migration and validation chronology

Exactly one new CLI-created forward migration:
`20260927140014_e3b4_order_commercial_lifecycle.sql`. Historical E3A1–E3B3
migrations remain unchanged. The E3B3 integration migration-count expectation is
advanced from 17 to 18; no behavioral regression assertion is removed.

Initial focused units: 3/3 PASS. Initial PostgreSQL fixture setup failed before
E3B4 migration/behavior assertions: the cleanup initially obscured the setup error;
retaining the root connection exposed an existing-market configuration CONFLICT.
The synthetic EC fixture timezone was corrected to match the existing seeded EC
market, instead of weakening market validation. A test snapshot query also corrected
its column name to the existing `ordinal` before successful validation. These were
test setup corrections, not modifications to historical implementation/migrations.

The next fixture attempt rejected uppercase synthetic stable keys at the existing
contract boundary. Fixture keys were normalized to lowercase; contracts were not
relaxed. No full verify has been run during these setup iterations.

Expanded focused validation then passed: 3/3 pure units; 20/20 PostgreSQL tests
(18 lifecycle/security cases, their parent test, and a separate empty fresh database
gate). Both populated pre-E3B4 bootstrap and empty clean installation apply all
18 migrations. TypeScript no-emit, targeted lint and formatting checks passed.
Tests include real competing transactions, receipt mismatch/revoked retry, genuine
foreign workspace Orders, equivalent-capability tenant/market denials, Country vs
Regional scope, SQL DML/private-helper denial, rich bundle/adjustment/financing
snapshot preservation, and exact same-UUID Order/event and replacement/event
evidence isolation. Privileged fixtures construct deliberate UUID collisions only;
authorization assertions execute through runtime identities and PostgreSQL RLS.

E3B3 through E3A1 focused regressions subsequently passed together: 82/82 checks.
Breakdown: E3B3 2 units + 16 integrations; E3B2 3 + 13; E3B1 16 + 12;
E3A2 2 + 12; E3A1 1 + 5. No Field Sales code was modified. Final schema hardening
also adds independent context validation and null-safe previous-state checks; final
focused migration/security verification covers that current schema before full verify.
Full verify and final self-review are pending below; no readiness is claimed yet.

After adding the separate fresh-schema privilege assertions, the final no-emit
check exposed TS7022 inference errors for two test query results. Explicit typed
query/result annotations corrected them without disabling strict checks or changing
runtime lifecycle behavior. Full verify had not yet been started.

## Full verification attempt and targeted fixture recovery

The repository-wide `npm.cmd run verify` was executed once. Format, lint,
typecheck, security and all 53 units passed. While that run was progressing,
the Tenant B negative-test fixture was strengthened to include an active own
operational market, rather than relying only on equivalent capability names.
Targeted lint/typecheck passed after this test-only refinement.

That refinement initially omitted the explicit administrative market scope
required before activating Tenant B's draft market. Consequently the E3B4
integration parent failed during fixture preparation with `INVALID_REQUEST`;
none of its business/security child assertions ran in that full-suite attempt.
The full integration command ended with 145 passes and one failure (146 total),
including the separate clean 18-migration gate and all existing regression
suites. Because `verify` uses chained success gates, its build stage did not run.
This is a failed full verification attempt, not a full-suite PASS.

The fixture was corrected using the existing `grantAdminMarketScope` operation
before market activation; no production code, historical migration, capability
guard or assertion was weakened. The final focused rerun passed 23/23 checks:
3 E3B4 units plus 20 PostgreSQL tests, including all 18 lifecycle/security child
cases and fresh empty installation. Tenant B's operational assignment and
equivalent capability are explicitly asserted before foreign-object denials.
Post-correction targeted Prettier, lint and TypeScript checks passed.

A separate repository build was started to complete the gates skipped by the
failed attempt. Its final outcome is recorded below when available. A second
full verify has not been executed: authorization was requested because the work
package limits that command to one execution. Successful targeted recovery must
not be mislabeled as a successful complete `verify` invocation.

## Final adversarial self-review

The complete tracked diff and every new E3B4 file were inspected, including
contracts, domain, application, persistence, migration, fixtures and assertions.
The review checked terminal transitions, projection/event identity, inherited
scope and non-null customer compatibility, replacement uniqueness/cycles,
deterministic locking and TOCTOU, reauthorized receipt retries, immutable source
snapshots, typed same-UUID evidence isolation, private helper grants/search paths,
and absence of repricing or later-package functionality.

FINDINGS_CRITICAL = NONE
FINDINGS_HIGH = NONE
FINDINGS_MEDIUM = NONE
FINDINGS_LOW = NONE

No material implementation defect was identified in this self-review. The failed
full verification command remains a validation gate pending explicit permission
to repeat it; this is not independent orchestrator R1 approval or checkpoint
readiness. No commit, push or PR was created.

The separate `npm.cmd run build` completed successfully: Next/OpenNext web bundle
and API Wrangler dry-run both passed. No deployment was performed. The generated
`apps/web/next-env.d.ts` imports were restored to their precheck contents; that
file has no remaining diff and is not E3B4 scope. The final worktree contains
14 E3B4 files (5 tracked modified, 9 new), with historical migrations and Field
Sales unchanged. This differs from E3B3's 13-file package because E3B4 also has a
dedicated test-fixture helper; no unrelated file is included.

VERIFY = FAILED_SINGLE_ATTEMPT_WITH_TARGETED_FIX_AND_BUILD_PASS
BLOCKERS = FULL_VERIFY_SUCCESS_ON_FINAL_WORKTREE_NOT_ESTABLISHED
CHECKPOINT_RECOMMENDATION = FIX_BEFORE_CHECKPOINT
E3B4_STATUS = FAIL_REQUIRES_FIX
NEXT = AUTHORIZE_FULL_VERIFY_ONLY_RERUN_THEN_ORCHESTRATOR_E3B4_R1

## Authorized final verification rerun

The first full verify failure above remains part of the record. After the
administrative-scope fixture repair, the focused 23/23 rerun had passed. The
orchestrator then explicitly authorized exactly one final full repository
`npm.cmd run verify` rerun. That single authorized rerun completed successfully
with exit code 0. Its canonical script passed format, lint, TypeScript/Next
typecheck, the security checks, all 53 unit tests and all 164 PostgreSQL
integration tests. The integration total includes the E3B4 20/20 checks,
the clean 18-migration installation, and the E3B3 through E3A1 regressions.
The Next/OpenNext web build and API Wrangler dry-run build both passed; no
deployment was performed. No further full verify run was made.

The build regenerated only `apps/web/next-env.d.ts` imports. They were restored
to their exact pre-validation contents, leaving no current diff. Post-run
`git diff --check` passed. The worktree remains the same 14 E3B4 files
(5 tracked modifications and 9 new files), with no unrelated/generated change.
The already-completed adversarial self-review still reports no Critical, High,
Medium or Low findings. This verification-only step did not change application
logic, tests or migrations; it appends this truthful validation result only.

E3B4_FINAL_VERIFY = PASS
E3B4_FINAL_UNIT_TESTS = 53/53 PASS
E3B4_FINAL_INTEGRATION_TESTS = 164/164 PASS
E3B4_FINAL_WEB_BUILD = PASS
E3B4_FINAL_API_BUILD = PASS
E3B4_FINAL_DIFF_CHECK = PASS
E3B4_FINAL_BLOCKERS = NONE
E3B4_CHECKPOINT_RECOMMENDATION = READY_FOR_CHECKPOINT
E3B4_STATUS = PASS_LOCAL_READY_FOR_R1
NEXT = ORCHESTRATOR_E3B4_R1_REVIEW_BEFORE_CHECKPOINT

## Deferred scope / non-blocking debt

API/UI transport; business-readable Order numbering; snapshot-query batching;
automated key management and production key provisioning/historical-key retention.
No payments, receivables, financing agreements, fulfillment, fiscal documents,
external synchronization, AI, heavy UI or later work package is implemented.

## Independent R1 review — failed before checkpoint

E3B4_R1_RESULT = FAIL
E3B4_R1_FINDING_M1_SEVERITY = MEDIUM
E3B4_R1_FINDING_M1 = mandatory cancellation/replacement reason can be whitespace-only through authorized direct SQL.

The application rejects whitespace-only reasons, but the PostgreSQL command and
event constraint used default `btrim`, which removes only ordinary spaces, not
tabs, newlines or carriage returns. An otherwise-authorized runtime actor could
therefore record a terminal lifecycle action without a meaningful audit reason.
The previous focused and full verification PASS evidence above remains accurate;
it did not cover this adversarial input. R1 classified the affected boundaries:

CANCEL_SEMANTICS = FAIL
REPLACEMENT_SEMANTICS = FAIL
DATABASE_INVARIANT_STRENGTH = FAIL
DIRECT_SQL_DEFENSE = FAIL
MIGRATION_QUALITY = FAIL
TEST_QUALITY = FAIL

R1 requested a targeted F1 repair before checkpoint. No checkpoint was created.

## F1 — PostgreSQL mandatory-reason repair and focused validation

The existing uncommitted E3B4 migration now requires cancel/replace reasons
to match `[^[:space:]]` in both the runtime-callable mutation function and the
terminal-event table constraint. The pre-existing 1–500 character bound and
stored `btrim` behavior remain unchanged. Technical initialization/bootstrap
events are not reclassified as business cancellations or replacements.
The application contract already used `trim().min(1)` and needed no change.

An otherwise-authorized delegate was verified to have the cancel/replace
rights, then attempted both SQL commands with spaces, tabs, newlines, carriage
returns and mixed whitespace. Every attempt returned PostgreSQL `23514`;
state stayed `created` at version 1, no terminal event, replacement or
idempotency receipt appeared, and the canonical Order/Quote/Acceptance/line
snapshots remained identical. A privileged fixture insert additionally proved
the event-table constraint rejects a tab-only cancellation reason. Meaningful
Spanish reasons passed cancellation and replacement; surrounding tabs around
meaningful content remained valid without changing the existing SQL storage
normalization. Existing append-only and terminal guards remained green.

Focused E3B4 validation: 3/3 units and 21/21 PostgreSQL checks passed
(24/24 combined), including the populated historical bootstrap and fresh
empty 18-migration install. The relevant E3B3 Quote-to-Order regression passed
18/18, including no repricing. Targeted Prettier, ESLint and TypeScript checks
passed. Next type generation briefly rewrote `apps/web/next-env.d.ts`; only
those generated imports were restored to their exact precheck contents.
No full repository verify was rerun in F1; its pre-F1 PASS remains recorded
above without being misrepresented as post-F1 validation. Historical migrations,
authorization, RLS, market lock, calculation and Order snapshots were not
modified. No commit, push or PR was made.

E3B4_F1_RESULT = PASS
E3B4_F1_BLOCKERS = NONE
E3B4_F1_STATUS = PASS_LOCAL_READY_FOR_R2
NEXT = ORCHESTRATOR_E3B4_R2_FOCUSED_REVIEW

## Independent R2 review — residual Unicode bypass

E3B4_R2_RESULT = FAIL
R1_M1_STATUS = STILL_OPEN_AFTER_F1

R2 confirmed that F1's ASCII-focused tests and direct-SQL denials were real,
but `[^[:space:]]` is locale-sensitive. The PostgreSQL test harness uses
`--locale=C`, where non-ASCII characters are not members of the POSIX whitespace
class. A reason containing only U+00A0 NO-BREAK SPACE therefore passes the
database's non-whitespace predicate even though JavaScript `trim()` rejects it.
The same residual path affects cancellation, replacement and the terminal-event
constraint. R2 retained M1 as a MEDIUM checkpoint blocker and requested a
locale-independent F2 repair. F1's observed ASCII results remain recorded above;
they were insufficient to establish complete application/database parity.

## F2 — locale-independent ECMAScript reason validation

The actual application contract uses `String.prototype.trim()` through Zod.
The current Node runtime confirmed that the 25 ECMAScript WhiteSpace and
LineTerminator code points listed in the F2 test trim to empty. U+200B ZERO
WIDTH SPACE and U+0085 NEXT LINE do not; F2 does not invent a broader Unicode
policy. The uncommitted E3B4 migration now defines one immutable,
security-invoker `authz.order_commercial_reason_valid` function using an explicit
code-point set. `btrim` with that set implements the same edge trimming and
1–500-character bound as the application without consulting PostgreSQL locale.
The function validates both runtime cancellation/replacement commands and the
terminal-event CHECK. It is not granted to the runtime role directly. Existing
stored reason text, receipt hashing, actor authorization, RLS, locking,
append-only history, technical bootstrap and accepted Order snapshots were not
changed. No new migration or historical-migration edit was made.

In the C-locale PostgreSQL harness, an otherwise-authorized delegate attempted
both SQL commands with each canonical whitespace code point, including the R2
U+00A0 exploit, plus mixed ASCII/Unicode sequences and NULL. Every attempt was
rejected as `23514`. State and version remained `created`/1; no terminal event,
replacement relation or success receipt appeared; Order, Quote, Acceptance and
line snapshots stayed identical. A privileged fixture insert additionally
confirmed the event constraint rejects U+00A0 and U+FEFF. Application and
database validity agreed across all negative and positive vectors. Meaningful
Spanish text surrounded by U+00A0 and U+3000 remained valid and retained the
existing SQL storage behavior. U+200B remained valid, matching JavaScript.

Final focused E3B4 validation passed 25/25 checks: 3 units and 22 PostgreSQL
integration/security checks, including historical bootstrap and fresh empty
installation of all 18 migrations. E3B3's relevant canonical Quote-to-Order
regression passed 18/18, including no repricing. Targeted formatting, ESLint
and TypeScript checks passed. Type generation temporarily altered only the
generated `apps/web/next-env.d.ts` imports, which were restored to their
precheck contents. The new test was adjusted to perform fixture snapshot reads
sequentially after a PostgreSQL-client concurrency warning; the final focused
rerun passed without that warning. The full repository verify was deliberately
not rerun in F2 and remains the next independent gate. No commit, push or PR
was made.

E3B4_F2_RESULT = PASS
R1_M1_STATUS = CLOSED_BY_F2
E3B4_F2_BLOCKERS = NONE
E3B4_F2_STATUS = PASS_LOCAL_READY_FOR_R3
NEXT = ORCHESTRATOR_E3B4_R3_FOCUSED_REVIEW

## Independent R3 review — Unicode reason invariant closed

E3B4_R3_RESULT = PASS
R1_M1_STATUS = CLOSED
E3B4_R3_FINDINGS_CRITICAL = NONE
E3B4_R3_FINDINGS_HIGH = NONE
E3B4_R3_FINDINGS_MEDIUM = NONE
E3B4_R3_FINDINGS_LOW = NONE

R3 independently compared the current Node `trim()` whitespace set with the
explicit PostgreSQL `chr(...)` set: all 25 code points matched with no omissions
or extras, and U+200B remained non-whitespace in both layers. It confirmed the
locale-independent command and terminal-event guards, authorized direct-SQL
negative tests, rejection atomicity, technical bootstrap compatibility, and no
F2 weakening of the existing lifecycle or security boundaries. R3 required one
canonical full verify after F2 before checkpoint; it did not rerun that verify.

## Authorized post-F2 final repository verification

One explicitly authorized `npm.cmd run verify` was executed after F2 and R3.
The canonical command completed with exit code 0. Format, lint, TypeScript
typecheck and the security check passed; 53/53 unit tests and 166/166
integration tests passed, including E3B4's 3/3 unit and 22/22 integration
checks, clean installation of all 18 migrations, and E3B3 through E3A1
regressions. The OpenNext web build completed and the API Wrangler dry-run
build passed. `git diff --check` passed. The build temporarily changed only
Next's generated `apps/web/next-env.d.ts` imports; those two imports were
restored to their exact pre-verification contents. No E3B4 implementation,
test, or migration file was modified by this verification task. All earlier
FAIL and repair entries above remain part of the record. No unresolved
Critical, High, Medium, or Low finding remains; no commit, push, or PR was made.

E3B4_POST_F2_VERIFY = PASS
E3B4_POST_F2_FORMAT = PASS
E3B4_POST_F2_LINT = PASS
E3B4_POST_F2_TYPECHECK = PASS
E3B4_POST_F2_SECURITY = PASS
E3B4_POST_F2_UNIT = 53/53 PASS
E3B4_POST_F2_INTEGRATION = 166/166 PASS
E3B4_POST_F2_WEB_BUILD = PASS
E3B4_POST_F2_API_BUILD = PASS
E3B4_POST_F2_DIFF_CHECK = PASS
E3B4_STATUS = PASS_LOCAL_READY_FOR_CHECKPOINT
NEXT = LOCAL_CHECKPOINT_CREATION_RECORDED_BELOW

## Local checkpoint and documentation-only pre-push repair

The authorized local E3B4 checkpoint was created as commit
`864a45cc835038505cbb8584e8099c61cb4b066c`, with subject
`feat(order): add E3B4 commercial order lifecycle`. It contained exactly
14 reviewed E3B4 files; checkpoint composition and the post-commit diff check
passed, and the worktree was clean. No push, PR, or merge occurred.

A subsequent strict pre-push verification confirmed the expected branch,
commit, base and `origin/main...HEAD = 0 1`. It found no code, migration,
security, commercial-integrity, secret-leak, generated-file, or divergence
defect. Its sole blocker was documentary: the continuity record had not yet
said that the local checkpoint had been created. The pre-push result was
therefore FAIL with `CONTINUITY_CHECKPOINT_CREATION_NOT_RECORDED` and
`DO_NOT_PUSH`; the earlier verification and repair history above remains
unchanged.

This continuity-only correction was authorized before push. Only this
document is changed, and the existing local E3B4 checkpoint is being amended
without changing its subject or creating a second feature commit. The final
post-amend recheck is pending; no result for it is claimed here. The amended
commit SHA is intentionally not embedded in this historical record.

E3B4_ORIGINAL_CHECKPOINT_SHA = 864a45cc835038505cbb8584e8099c61cb4b066c
E3B4_CHECKPOINT_FILE_COUNT = 14
E3B4_ORIGINAL_CHECKPOINT_DIFF_CHECK = PASS
E3B4_ORIGINAL_CHECKPOINT_WORKTREE = CLEAN
E3B4_PRE_PUSH_DOCUMENTATION_RESULT = FAIL
E3B4_PRE_PUSH_DOCUMENTATION_BLOCKER = CONTINUITY_CHECKPOINT_CREATION_NOT_RECORDED
E3B4_CHECKPOINT_STATUS = LOCAL_CHECKPOINT_CREATED_CONTINUITY_REPAIR_IN_PROGRESS
NEXT = AMEND_CHECKPOINT_AND_REVERIFY_BEFORE_PUSH
