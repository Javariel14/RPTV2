# E3B2 — CPQ quotation snapshots

## Boundary and model

Local implementation based on merged `c90c347`. The historical CRM `quote_version`
remains a simulation-only Opportunity artifact and is unchanged. New `cpq_quote`,
`cpq_quote_version` and `cpq_quote_line` primitives provide a stable quotation
aggregate and immutable commercial history. Optional Person references use the
existing CRM identity; no customer redesign or Order conversion is introduced.

`QuoteService` calls the existing authorized `CommercialCalculatorService` inside
the same authenticated repeatable-read transaction. No monetary formulas, pricing
resolution, rounding, financing engine or calculation-hash implementation is
duplicated. `calculationHash` is the exact E3B1 hash; `E3B1/v1` denotes its current
logical engine/schema identity, not a binary-build attestation.

Each version stores the strict calculation request and complete canonical result,
including source PriceList/version, entries, rules, bundles, financing, tax,
approval determination and decimal totals. Immutable line snapshots additionally
store Product/Model/Variant ancestry labels and stable keys, localized commercial
name/code, source observation/literal and bundle composition. Historical reads
never rerun current pricing or depend on current product labels.

## Integrity and authorization

- A Quote begins draft with Version 1. Revision appends the next version and resets
  an issued quote to draft; terminal quotes cannot be revised.
- PostgreSQL serializes revisions using the aggregate row lock and enforces a
  unique tenant/quote/version number. Expected aggregate versions reject stale
  requests. Serialization collisions surface as CONFLICT, without hidden retries.
- Deferred constraints require every inserted version, including older versions
  in the same transaction, to have all declared line snapshots. Runtime UPDATE,
  DELETE and TRUNCATE of snapshot history are unavailable; immutable triggers
  provide additional protection.
- Explicit `cpq_quote` capabilities and current workspace permissions are additive
  to object ownership/delegation and effective operational market/admin scope.
  Product/Catalog/Pricing/Trust/Network permissions do not grant Quote access.
  Operational users cannot choose a foreign market; E3B1 resolves the authorized
  PriceList/market and applies all existing pricing/catalog restrictions.
- New snapshots require an active, valid PriceList even for administrators. Issue
  requires a final result without approval requirements and an unexpired deadline.
  Accept/reject require issued; cancel/expire require draft or issued. Expiration
  requires the configured deadline to have elapsed. Lifecycle changes are audited.
- Creation/revision reuse tenant/actor-bound idempotency receipts with request
  hashes and conflict detection; authorization is checked again on retries.
- External evidence reuses SourceObservation with domain `cpq_quote` and explicit
  `quote`/`quote_version` subjects. Database guards resolve exactly that type;
  restrictive policies prevent legacy permissive OR branches from bypassing the
  quote boundary. Manual actions use audit provenance, not fabricated observations.
- Runtime credentials remain trusted-server credentials under ADR-003. The initial
  implementation checked snapshot identities but did not authenticate the result;
  F1 below closes that gap. SQL never recomputes E3B1 monetary formulas.

History uses ascending version-number keyset pagination (maximum 100 per response),
with a cursor and direct version retrieval. Storage is not capped.

## Migration and validation chronology

New forward-only migration: `20260926235659_e3b2_cpq_quote_versions.sql`.
E3A1/E3A2/E3B1 migrations and Field Sales files are unchanged.

Initial focused runs identified a new trigger syntax/record-field error and a
source-authority policy referencing a protected table directly. These were fixed
within this uncommitted migration, without relaxing runtime permissions or tests.
The initial full-history clean apply then passed (16 migrations).

Focused evidence obtained during implementation:

- E3B2 unit: 2/2; final expanded integration: 11/11.
- E3B1 integration: 12/12; E3A2 base: 5/5 and market-admin: 7/7; E3A1: 5/5.
- TypeScript compile and source security checks passed during implementation.
- Final clean apply: PASS, all 16 migrations on fresh PostgreSQL.
- Full verify started once: format, lint, typecheck, 47 unit tests and security
  passed. It was interrupted during integration validation after the blocking
  self-review finding below. Full verify and builds are NOT reported as PASS.

## R1 self-review — FAIL (local, before checkpoint)

HIGH H1: runtime INSERT can forge the E3B1 result's approval status while retaining
the canonical hash. The new migration's `quote_version_guard` checks identities,
published list/entry references and hash-string equality, but does not bind the
persisted result to an authentic execution of E3B1. `quote_guard` then trusts
`output_snapshot.status` and `requiresApproval` for publication.

An in-memory diagnostic extension of the synthetic integration scenario used the
normal advisor runtime identity, not the owner/migrator database role. It copied
an actual E3B1 `requires_approval` result, changed only status to `final` and
requiresApproval to false, retained its original calculationHash and line
snapshots, inserted a new Quote/Version, and successfully transitioned it to
issued through runtime SQL. Deferred constraints also passed. The probe explicitly
threw afterward so its entire transaction rolled back; no probe file was written.

Evidence marker: `R1_PROVEN_APPROVAL_BYPASS`. The existing 11/11 positive/negative
integration suite does not cover this forged-insert path and therefore does not
establish full publication/hash integrity. This is a blocking requirement, not
non-blocking debt or a justification for duplicating the calculator in SQL.

FINDINGS_CRITICAL = NONE
FINDINGS_HIGH = H1
FINDINGS_MEDIUM = NONE
FINDINGS_LOW = NONE
CHECKPOINT_RECOMMENDATION = FIX_BEFORE_CHECKPOINT

No functional repair was made during that independent review. A targeted
fix must establish a trusted calculation-to-snapshot publication boundary while
retaining E3B1 as the only calculator and add a regression for this exact attack.

## Deferred scope and debt

No transport/UI, PDF, signatures, messaging, approvals workflow, Order, payments,
inventory, delivery, importer or later work package. Approval requirements are
persisted determinations, not approved commitments. Future API transport and
batch optimization of catalog snapshot metadata are non-blocking follow-ups.

## F1 targeted repair — calculation/publication authentication

H1 was not a duplicated scalar column: `output_snapshot.status` and
`requiresApproval` were themselves writable during runtime INSERT. Comparing a
caller-provided hash string, or deriving a generated status from that same JSON,
cannot authenticate an E3B1 execution. An application-only guard would also leave
the reproduced direct-SQL attack open.

The authorized application path now obtains the unchanged, strictly parsed E3B1
result and its catalog line snapshots and authenticates a canonical envelope with
HMAC-SHA-256. This tag is a server-authentication mechanism, **not** a competing
calculationHash, another calculator, or an approval workflow. The envelope binds
tenant, actor, workspace, market, quote, version UUID/number, engine identity,
request, result and line snapshots. Original calculationHash and result are
preserved verbatim.

The new migration's private `authz.quote_calculation_key` stores tenant-scoped
verification secrets (32–64 bytes). Runtime/PUBLIC have no table privileges or
policies, and there is no SQL signing oracle. The existing fixed-search-path
SECURITY DEFINER insertion trigger only verifies the tag with qualified pgcrypto
and compares the authenticated envelope to the exact new row/context. A changed
result, approval flag, payload or unrelated version cannot reuse an authentic tag.
It also enforces typed status/approval/final-total consistency. Line insertion
must equal the corresponding authenticated snapshot as well as the published
entry checks already present.

Publication selects the aggregate's exact current tenant/quote/version and now
explicitly rejects a missing current version. Only authenticated immutable
`final`, `requiresApproval=false`, non-null grand-total output can issue.
Requires-approval and incomplete results may remain historical drafts; there is
no approval bypass or new approval engine. Current-pointer changes, stale
expected versions and snapshot/hash/line mutations remain protected.

### Server key provisioning / fail-closed deployment contract

Deployment operators provision a cryptographically random tenant key through the
privileged migration/administration channel and inject the matching key ID/secret
into the server-only `QuoteCalculationAttestor` dependency. Never provision or
read keys through runtime SQL or accept them from a request. A multi-tenant server
must select the trusted tenant-specific signer using authenticated server context;
the attestor interface permits this routing. Missing/wrong/inactive keys fail
closed. A tenant-scoped service can use `createQuoteCalculationAttestor` directly.
There are no default/committed secrets. Tests provision random synthetic keys only
through harness setup. New versions require an active key; retain old key rows
(FK protected) so immutable history remains available after rotation. Publication
does not require an old key to remain active after its version was authenticated.
Key rotation/provisioning is an operational deployment prerequisite, not a runtime
permission shortcut. UI/API transport and automated key-management tooling remain
outside this package.

### Focused F1 evidence

- E3B2 unit: 3/3 PASS, including HMAC interoperability, context binding, unchanged
  E3B1 hash and client-status/approval rejection.
- E3B2 integration: 13/13 PASS on fresh PostgreSQL. Both authentic
  requires-approval and incomplete results reject final-label tampering with
  the genuine calculationHash, and reject modified authenticated payloads.
- Runtime application and direct-SQL publication reject genuine non-final
  versions; genuine final/current versions issue successfully.
- Runtime secret reads, historical mutation, stale/current-pointer substitution,
  cross-market access, equivalent-capability tenant-B access and revoked issue
  permission are denied. Prior idempotency, concurrency, typed evidence and
  historical pricing tests remain intact.
- Fresh full-history clean apply: PASS, all 16 migrations. E3A1/E3A2/E3B1 historical
  migrations and Field Sales remain unchanged.

Final F1 validation (after the focused gates passed):

- E3B1: unit 16/16 and integration 12/12 PASS.
- E3A2: unit 2/2 and integration 12/12 (base 5/5 + market-admin 7/7) PASS.
- E3A1: unit 1/1 and integration 5/5 PASS.
- Full `npm.cmd run verify` completed once after F1: format, lint, typecheck,
  security, 48/48 units, 128/128 integrations, web production build and API
  dry-run build PASS. This does not retroactively change the interrupted initial
  verify into a pass, and no deployment was performed.
- Tracked/untracked E3B2 worktree reviewed: 14 files (5 tracked changes + 9 new
  files), including the new server attestation module. Historical migrations and
  Field Sales are unchanged. Next's generated-only `next-env.d.ts` path changes
  were removed after the build; no UI source change remains.
- Final diff/whitespace checks: PASS. No tests or assertions were weakened.

H1 is closed by the database-authenticated snapshot boundary and publication
regressions, not by a duplicate calculator or replacement calculationHash.
Non-blocking follow-ups remain API/UI transport, snapshot-query batching and
automated deployment key management. Secure tenant key provisioning is required
before running the application in a deployed environment, as described above.

BLOCKERS = NONE
E3B2_F1_STATUS = PASS_LOCAL_READY_FOR_R1
NEXT = ORCHESTRATOR_E3B2_R1_FOCUSED_REVIEW_BEFORE_CHECKPOINT

No commit or push has been made. Ready for focused R1; no later package started.

## Focused final R1 review — PASS (before checkpoint)

The independent read-only R1 confirmed closure of H1, complete attestation
context binding, runtime key/oracle denial, fail-closed key handling, and retained
historical verification after rotation. Publication/current-version concurrency,
immutable snapshots, E3B1 reuse, snapshot completeness, RLS/BOLA, typed provenance,
migration integrity and test quality passed. No implementation changes were made
during R1.

Independent validation: E3B2 unit 3/3 PASS; PostgreSQL integration 14/14 PASS
(the 13 existing tests plus one in-memory diagnostic review test), with all 16
migrations applied on fresh PostgreSQL. The diagnostic covered key/context
substitution, replay, key access, rotation and publication/revision concurrency;
it introduced no persisted test file. Full verify was not rerun; the completed
post-F1 evidence above remains unchanged.

The reviewed worktree contains 14 E3B2 files: 5 tracked changes and 9 new files.
The transient generated `apps/web/next-env.d.ts` has no remaining diff. Historical
E3A1/E3A2/E3B1 migrations and Field Sales remain unchanged.

Non-blocking follow-ups remain API/UI transport, snapshot-query batching and
automated key-management tooling. Secure deployment key provisioning and retention
of historical key IDs/secrets remain operational requirements, not optional
authorization shortcuts.

E3B2_R1_REVIEW_RESULT = PASS
E3B2_R1_FINDINGS_CRITICAL = NONE
E3B2_R1_FINDINGS_HIGH = NONE
E3B2_R1_FINDINGS_MEDIUM = NONE
E3B2_R1_FINDINGS_LOW = NONE
E3B2_R1_CHECKPOINT_RECOMMENDATION = READY_FOR_CHECKPOINT
E3B2_STATUS = PASS_LOCAL_READY_FOR_CHECKPOINT
NEXT = CREATE_LOCAL_E3B2_CHECKPOINT

The initial self-review FAIL and targeted F1 repair remain recorded above.
