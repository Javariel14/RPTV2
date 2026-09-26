# E3B1 — Commercial Calculator Core

Local implementation only. E3B2 must reuse `calculateResolvedCommercial` and its
strict v1 result; no Quote/QuoteVersion, Order, approval records, payments, UI,
inventory, external sync or importer is implemented.

## Model and operation

Five tenant-safe primitives: stable commercial configuration, immutable definition
versions, bundle lines, rules and financing terms. The bounded kinds are bundle,
rules and financing (not an arbitrary formula/EAV engine). Configuration is scoped
to exactly one Market + PriceList + currency. New definitions are new versions;
draft → active → retired is configure-authorized in application and PostgreSQL.
Retirement closes an interval, preserves definitions and prevents overlapping
published versions of the same identity. Composition/rules/terms are append-only;
no recursive bundle references exist.

`CommercialCalculatorService` exposes create-version, activate/retire, authorized
history, append evidence and calculation. Mutations use receipts, advisory locks,
expected identity version / definition revision, and append-only audit. Retried
commands reauthorize before returning receipts. Calculation writes only an access
audit, never a quote, price, configuration or receipt.

## Exact calculation

Resolver loads authorized E3A2 official entries in one batch, resolves unique
effective definitions at `[validFrom, validTo)`, then invokes a pure rational
BigInt engine. No monetary/rate arithmetic uses JS floating point. Currency registry
minorUnits defines monetary boundaries; ROUND_HALF_UP rounds line bases, inclusive
net decomposition, per-rule basket adjustments, recomputed taxes and financing.
Bundle quantity multiplication retains its complete decimal precision.

Order: official price → bundle expansion → quantity → initial net/tax/gross →
rules by unique priority → adjusted net/tax/gross → financing. Inclusive tax
preserves initial official gross; exclusive tax adds the disclosed rate;
not-applicable explicitly yields zero; unknown/undisclosed rates return
`incomplete_tax_semantics` with null final totals, not zero tax. Adjustments target
net bases. Fixed basket amounts allocate by largest fractional remainder, source
line order on ties, conserving minor units. No country VAT defaults exist.

COMPONENT_SUM prices components via official entries; PUBLISHED_ANCHOR prices the
official anchor entry, with separate descriptive composition. Revoked component
access denies the whole calculated bundle rather than silently dropping lines.
Rules are percentage/fixed discounts/surcharges; configured discounts beyond their
autoLimit produce `requires_approval`, never an approval or execution.

Financing modes: surcharge + equal installments; or down-payment percentage/fixed
amount + term factor. Extra financed balance must be explicit and plan-permitted.
Factors are not APR. The nominal installment is HALF_UP; the actual bounded payment
schedule distributes indivisible minor units exactly (payments differ by at most
one unit), so tiny amounts never produce a negative final payment. No amortization
or collection engine exists.

Result preserves official entry ID (immutable fact-version 1; supersession is a new
entry ID), list revision, definition/term/rule versions, source amounts, tax semantics,
rounding and totals. SHA-256 covers canonical resolved inputs and outputs; no raw
evidence/PII is hashed. FX DERIVED_REFERENCE is never accepted as a source price.
Rules are normalized and sorted by unique priority inside the pure calculator,
before execution and hashing (not just by SQL). Top-level request-line order is
semantic: it breaks allocation ties. The resolver preserves that order via an
internal requestLineIndex; components of each bundle occurrence are canonicalized
by MarketProduct identity, then normalized content. Repeated bundle requests stay
separate. Callers do not supply this metadata in the public calculation request.
Selected rules remain hash inputs, but appliedRules contains only executed rules;
incomplete tax skips adjustments and therefore returns an empty applied-rule trace.

## Authorization and provenance

Dedicated `commercial.calculate` / `commercial.configure`; neither Catalog nor
Pricing read implies configure. Every path also requires E3A2 list/object/workspace
permissions and the current server-derived operational market or explicit admin
scope. Configure additionally requires scoped market administration + pricing update.
All five tables enforce tenant-safe FKs and RLS; runtime is never owner/service-role.
Helpers have fixed pg_catalog search_path, revoked PUBLIC execution and explicit
runtime grants. No Network/Trust inheritance or authorization cache is introduced.

External evidence reuses SourceObservation with typed bundle_version,
rule_set_version or financing_plan_version subjects. The shared version PK space
and DB kind validation prevent cross-kind UUID aliasing. A restrictive boundary
intersects all legacy permissive policies for the new domain only; a dedicated
source-authority helper avoids runtime access to private authorization tables.
Manual configuration uses administrative audit without fake external evidence.
Evidence literals are preserved separately from immutable normalized definitions.

## Initial implementation report (before R1)

New forward-only `20260926100000_e3b1_commercial_calculator.sql`; E3A1/E3A2 and
Field Sales hotfix are untouched. No dependency added.

Focused evidence: pure calculator 12/12; E3B1 integration 7/7 on fresh PostgreSQL;
E3A2 base/admin/security + E3A1 regression 17/17. TypeScript compilation and focused
lint pass. Clean history application passes (15 migrations, fresh PostgreSQL).
One full `npm.cmd run verify` passed: format/lint/typecheck/security, 41 unit tests,
110 integration tests, web build and API dry-run build. Final review strengthened
two test assertions (a real foreign financing term and the specific PostgreSQL
draft-creation error); the E3B1 integration rerun remained 7/7, with focused lint,
TypeScript and formatting checks passing. Final diff review and `git diff --check`
pass; only the 13 E3B1 files remain, without generated web files or a local commit.

Non-blocking debt: no UI/API transport surface; application contracts/services are
the entry point. Plans/rules are deliberately PriceList-scoped, not tenant-wide.
History storage is complete and append-only. The history response returns the first
100 definitions, ordered by version, without pagination; exact-ID/as-of repository
resolution is not limited to 100. No generic editing of active definitions or
payment collection. The initial report identified no blockers, but its checkpoint
readiness was invalidated by the independent R1 findings below.

## R1 FAIL and targeted F1 correction

R1 = FAIL: H1 hashed the caller's unsorted rules while executing priority order;
M1 incorrectly required auto_limit <= value in SQL; M2 reported selected rules as
applied even when incomplete tax skipped execution. Initial passing gates did not
cover these defects; this correction does not erase that report or R1.

F1 canonicalizes rules and bundle components at the pure boundary as documented
above. Rule values and automatic limits are independently bounded: percentage
limits are 0..1, fixed limits are nonnegative in the inherited PriceList currency.
10% discount + 20% automatic allowance is valid; above-limit execution remains
requires_approval, without an approval workflow. Applied-rule output records
execution only; unselected discounts and tax-skipped adjustments are not applied.

Focused F1 evidence: pure units 16/16; E3B1 integration 12/12. Tests cover all six
rule permutations, unchanged caller input, bundle order, changed rule identity /
value / allowance / version, immutable entry supersession ID, repeat hashes,
independent limits, SQL rejection, retries/concurrency, actual/skipped/unselected
trace, mixed-tax bundle adjustment, rule-set overlap, populated FX vs official
prices, and tenant B with equivalent effective capabilities. Entry fact-version
is always 1: a new published fact has a new ID; an invalid in-place version is
rejected. Typecheck and focused lint pass. Initial test-authoring errors (currency
asserted on a history row; synchronous validation checked as async) were corrected
and the complete focused integration rerun passed.

Clean migration passes on fresh PostgreSQL (all 15 migrations); security checks
pass. E3A2 base/admin/security regression passes 12/12 and E3A1 passes 5/5.
The single F1 `npm.cmd run verify` passes: format/lint/typecheck/security, 45 unit
tests, 115 integrations, web build and API dry-run build. No Playwright was run.
Final review and tracked/untracked whitespace checks pass. The generated-only
Next.js type-reference diff was removed; the worktree contains only the 13 E3B1
files (4 tracked changes + 9 new), with no commit. F1 blockers: none.
Non-blocking debt remains no UI/API transport and history-response pagination.
Status: PASS_LOCAL_READY_FOR_R2.
Next: ORCHESTRATOR_E3B1_R2_FOCUSED_REVIEW_BEFORE_CHECKPOINT; do not start E3B2.

## R2 PASS — ready for local checkpoint

The independent read-only R2 review confirmed all three R1 blockers are closed:
semantic rule/hash canonicalization, independent automatic-discount allowances,
and executed-only applied-rule traces. Mixed-tax adjustments, SQL overlap/limit
protection, FX reference separation and equivalent-capability tenant isolation
also pass. Request-line order remains intentionally semantic; bundle components
are canonicalized within each occurrence. Exact math, financing reconciliation,
PriceList scope, history, market authorization and typed provenance remain intact.

R2 reran E3B1 units 16/16 and integration 12/12 on fresh PostgreSQL applying all
15 migrations. Prior F1 evidence remains valid: E3A2 regression 12/12, E3A1 5/5,
and one full verify with 45 units, 115 integrations and web/API builds passing.
R2 did not repeat full verify. Tracked and untracked whitespace checks pass;
E3A1/E3A2 migrations and Field Sales remain untouched. The complete worktree is
13 E3B1 files (4 tracked changes + 9 new), not the earlier reported 15.

E3B1_R2_REVIEW_RESULT = PASS
E3B1_R2_FINDINGS_CRITICAL = NONE
E3B1_R2_FINDINGS_HIGH = NONE
E3B1_R2_FINDINGS_MEDIUM = NONE
E3B1_R2_FINDINGS_LOW = NONE
E3B1_R2_CHECKPOINT_RECOMMENDATION = READY_FOR_CHECKPOINT
E3B1_STATUS = PASS_LOCAL_READY_FOR_CHECKPOINT
NEXT = CREATE_LOCAL_E3B1_CHECKPOINT

Non-blocking debt remains history-response pagination and no UI/API transport.
No implementation changes or additional test runs accompany this review recording.
