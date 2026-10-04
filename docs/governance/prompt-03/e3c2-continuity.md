# E3C2 — Canonical Order Identity + Read API — Continuity

## State

- Base SHA: `559803e3166cf1fef3b7f6680212a42c892a9b29`
- Branch: `feature/e3c2-order-identity-read-api`
- Implementation status: local, uncommitted, R2-M1 receipt-integrity repair ready for independent R3 review
- Canonical full verify: intentionally not run in I1 or F1

## Scope implemented

- Tenant-scoped immutable business Order number in format `ORD-0000000001`.
- UUID remains the canonical relational identity and the Order number is never authorization material.
- One forward migration: `20261003221801_e3c2_order_identity_read_api.sql`.
- Strict versioned contracts and a composed Order list/detail/history read service.
- Production HTTP reads:
  - `GET /v1/orders`
  - `GET /v1/orders/:id`
  - `GET /v1/orders/:id/history`
- Exact Order-number, workspace, market and lifecycle-state filters with opaque keyset pagination.
- Existing `cpq_order.read`, tenant, workspace and market authorization remains authoritative through RLS.

## Order-number design

- Namespace: tenant-local; the same textual number may exist in different tenants.
- Deterministic backfill: `PARTITION BY tenant_id ORDER BY created_at,id`.
- Uniqueness: `(tenant_id,business_order_number)`.
- Exact database format constraint: `^ORD-[0-9]{10}$`.
- Allocation: one private PostgreSQL sequence per tenant, registered in private
  `authz.order_number_counter` infrastructure.
- Existing and new tenants receive a PostgreSQL-generated random `allocator_id`; sequence names
  derive only from that opaque UUID and contain no tenant, workspace, market, user or provider ID.
- Assignment occurs after the established Order workflow guard and rejects caller-supplied values.
- Sequences are non-cycling and capped at `9,999,999,999`.
- `nextval` is intentionally non-transactional: a failure after allocation leaves a gap and cannot
  cause the value to be reused.
- Runtime has no registry or sequence state/advancement privileges; `PUBLIC` execution is revoked
  from privileged trigger functions and every `SECURITY DEFINER` function has a fixed `pg_catalog`
  search path. PostgreSQL catalogs can expose aggregate existence of opaque allocator sequence
  objects, but cannot correlate them to tenants or expose their values to runtime.

## Read model and disclosure boundary

- Composed reads use `REPEATABLE READ` to avoid torn Order/lifecycle responses.
- Detail validates the accepted immutable commercial snapshot and exposes only safe line/catalog
  projections; source references, external provider identities and raw database rows are omitted.
- Lifecycle history is separately bounded and omits actor/request internals.
- Known inaccessible and nonexistent UUIDs share public `404` semantics.
- Foreign/inaccessible and nonexistent business numbers both produce an empty authorized list.
- Cursors are strict/versioned and can only narrow an RLS-authorized result set.
- Reads do not recalculate or mutate QuoteVersion, acceptance, commercial snapshots, lifecycle or
  reconciliation state.

## Validation chronology

1. Initial E3B4 regression exposed assertions that still expected Order creation replay to return
   only `{id}`. The assertions and replay result were updated to require the same assigned business
   number.
2. Initial E3C2 integration fixture reused fixed synthetic tenant slugs. The test helper received an
   optional tenant prefix; its existing default behavior is unchanged.
3. Initial list mapping passed internal detail fields into a strict public list DTO, correctly
   producing `422`. The mapper now projects only explicit public fields.
4. Direct-SQL negative probes were isolated with savepoints so expected permission errors do not
   leave the test transaction aborted.
5. A transactional row counter was replaced before final validation with private per-tenant
   sequences so a post-allocation rollback cannot reuse a number.
6. A foreign-number non-disclosure fixture initially collided with a valid local tenant number.
   Root-only test setup moved the foreign sequence to a distinct value before comparison.
7. Focused regression found that a pre-E3C2 idempotency receipt contained only `{id}` and one suite
   still expected 19 migrations. Historical replay now enriches the old receipt from the
   backfilled canonical Order without allocating again; migration assertions now expect 20.

## I1 focused evidence

- E3C2 unit contracts: `1/1 PASS`.
- E3C2 PostgreSQL/API integration: `11/11 PASS`.
- E3A2 market authorization: `4/4 PASS`.
- E3B1 calculator/configuration: `11/11 PASS`.
- E3B2 immutable QuoteVersion: `12/12 PASS`.
- E3B3 + E3B4 affected rerun: `38/38 PASS`.
- E3C1 reconciliation: `28/28 PASS`.
- Clean forward migration application: `20/20 PASS`.
- Focused TypeScript: PASS.
- Focused ESLint: PASS.
- Security check: PASS.
- API dry-run build: PASS.
- `git diff --check`: PASS before continuity update.

## R1 independent review

- `R1 = FAIL`.
- `R1-M1 MEDIUM`: tenant UUIDs were embedded, without hyphens, in per-tenant PostgreSQL sequence
  names visible through system catalogs.
- `R1-M2 MEDIUM`: canonical creation followed its authorized `INSERT` with an RLS-protected
  `SELECT`, so an actor with `cpq_order.create` but not `cpq_order.read` received only `{id}` on
  creation and replay.
- `R1-L1 LOW`: malformed Base64URL such as `cursor=A` could throw a `DOMException` outside the
  cursor validation boundary and map to retryable `503 UNAVAILABLE` instead of `422`.

## F1 targeted repairs

- R1-M1: `authz.order_number_counter` now stores a PostgreSQL-generated random `allocator_id`.
  Sequence identifiers are `order_number_<opaque UUID without hyphens>` and remain safely under
  PostgreSQL's identifier limit. The registry mapping has no runtime grants, while sequence
  identifiers are constructed only from trusted allocator UUIDs with `%I` and schema qualification.
- The runtime catalog probe queries `pg_catalog.pg_class`, `pg_catalog.pg_sequences` and
  `information_schema.sequences`. It proves that no sequence name contains any tenant UUID, the
  registry cannot be joined/read, sequence values remain hidden, and runtime cannot advance them.
  Residual visibility is accurately classified as `OPAQUE_AGGREGATE_CATALOG_METADATA`, not total
  catalog invisibility.
- R1-M2: successful Order insertion obtains the trigger-assigned UUID/number pair through a
  transaction-local authoritative creation identity set by the guarded insert trigger. This avoids
  a general Order `SELECT` and does not confer read authority. New receipts persist both `id` and
  `businessOrderNumber`; exact replay returns that stored pair without an Order read.
- The same forward migration enriches only provably matching historical `quote_workflow.order`
  receipts from canonical same-tenant Orders, preserving receipt key, request hash, actor, tenant
  and operation identity. The pre-E3C2 migration bootstrap remains compatible only while the
  `business_order_number` column is absent; once E3C2 is present, missing authoritative creation
  identity fails closed.
- R1-L1: one strict decoder now validates alphabet and impossible lengths, checks canonical
  Base64URL encoding, performs fatal UTF-8 decoding, parses JSON and applies the exact cursor schema
  inside the cursor-only error boundary. All malformed cursor inputs normalize to
  `INVALID_REQUEST`, public `422`, `retryable=false`.

## F1 targeted evidence

- E3C2 Order read/HTTP/PostgreSQL integration: `13/13 PASS`, including real runtime catalog probes,
  first-allocation rollback nonreuse, new-tenant first-Order concurrency, create-only creation and
  replay, ordinary read denial, and malformed cursor HTTP cases.
- E3B4 lifecycle plus historical bootstrap and two clean 20-migration applications: `22/22 PASS`.
- E3B3 Quote workflow: `16/16 PASS`.
- E3C1 Order reconciliation: `29/29 PASS`.
- Focused E3B3/E3B4/E3C1/E3C2 unit anchors: `8/8 PASS`.
- Historical receipt enrichment, exact replay, changed-payload conflict and normal Order-read denial
  are all exercised against PostgreSQL.
- No canonical full verify was run. No commit, push or PR was created.

## R2 independent adversarial review

- `R2 = FAIL`; the review was read-only and changed no files.
- `R2-M1 MEDIUM / DEFECT_CONFIRMED_READ_ONLY`: the runtime-executable generic
  `authz.quote_workflow_finish` accepted caller-provided JSON for Order conversion. A completed
  receipt could therefore contain an Order UUID/business-number pair that the database had not
  bound to the exact accepted QuoteVersion, acceptance and canonical Order result.
- Application replay treated the presence of `businessOrderNumber` as sufficient proof and could
  return that unverified pair without a corresponding canonical Order.
- The review observed the actual 18-file E3C2 worktree. The older 14-file E3C1 inventory was stale.

## F1 receipt-integrity repair after R2

- Generic `quote_workflow_receipt` and `quote_workflow_finish` now reject the `order` operation;
  their request/decision/acceptance behavior remains unchanged.
- Order conversion uses dedicated `authz.order_creation_receipt` and
  `authz.order_creation_finish` boundaries. The receipt persists the exact QuoteVersion,
  acceptance and expected quote version alongside its existing tenant, actor, operation, key and
  normalized request hash binding.
- The database derives `{id,businessOrderNumber}` from the unique same-tenant canonical Order and
  requires exact QuoteVersion, acceptance and creating-actor correspondence. The caller supplies
  no business number, and an unrelated/nonexistent Order cannot finalize the receipt.
- Both dedicated functions are `SECURITY DEFINER` with fixed `pg_catalog` search paths, explicit
  runtime-only execution grants, revoked `PUBLIC` execution, current session/capability/object
  authorization and fail-closed resource checks.
- Historical E3B3 Order receipts are preserved unchanged because they lack sufficient stored
  request context to prove exact command binding. They are not enriched or replayed as success;
  a new independently authorized request may derive the existing canonical result through the
  new authoritative boundary.
- The prior transaction-local JSON creation identity was removed. Persistence now accepts only the
  authoritative result returned by the dedicated database finalizer, and application replay no
  longer treats a non-null business number as proof by itself.
- Direct runtime negative tests cover the disabled generic Order helpers, nonexistent identity,
  wrong actor, wrong tenant, invalid acceptance, unrelated accepted context and unchanged receipt
  state after denial.
- Focused evidence: Quote workflow `18/18 PASS`; E3C2 Order read/API `13/13 PASS`; E3B4 lifecycle
  plus two clean 20-migration applications `22/22 PASS`; E3C1 reconciliation `29/29 PASS`; focused
  unit anchors `8/8 PASS`.
- Historical migrations remain unchanged, total migrations remain 20, and no migration 21 was
  created. Canonical full verify was not run; no commit, push or PR was created.

## Explicit exclusions and debt

- No Order mutation HTTP routes.
- No reconciliation mutation transport or UI.
- No web UI changes.
- No provider connector or production source-authority provisioning.
- No E3D delivery/curation or E3E post-sale behavior.
- No canonical full verify, checkpoint, push, PR or merge in I1 or F1.
- Independent E3C2 R3 receipt-integrity review remains required before any full
  verification/checkpoint.

## R3 independent receipt-integrity review

- `E3C2-R3 = PASS`; the review was read-only and changed no repository files.
- `R2_M1_STATUS = CLOSED`.
- The generic Order receipt path remained denied, callers had no authority over the receipt
  result, and PostgreSQL derived the unique authoritative `{id,businessOrderNumber}` pair from
  the exact tenant, actor, QuoteVersion, acceptance and expected-version context.
- Direct runtime probes independently denied nonexistent and unrelated Orders, UUID/number
  substitution, foreign tenant/actor/context, changed request hashes, wrong expected version and
  direct receipt-table mutation. Create-only replay remained narrow and ordinary Order read stayed
  denied.
- Independent focused evidence: `82/82 PASS` across Quote workflow, Order commercial lifecycle,
  Order read/API and Order reconciliation, plus an ephemeral direct PostgreSQL adversarial probe.
- R3 authorized one post-F1 canonical full verification before any checkpoint.

## Post-F1 canonical full verification

- Date: `2026-10-04` (`America/Guayaquil`).
- Command: `npm.cmd run verify`.
- Run count in this gate: `1`.
- C: free space before execution: `40.64 GB`.
- Format: `PASS`.
- Lint: `PASS`.
- Typecheck, including Next route type generation: `PASS`.
- Security: `PASS`.
- Unit: `56/56 PASS`.
- Integration: `210/210 PASS`.
- E2E: `NOT_INCLUDED_IN_CANONICAL_VERIFY`.
- Web/OpenNext Cloudflare build: `PASS`.
- API Wrangler dry-run build: `PASS`.
- Clean migration: `20/20 PASS`.
- Historical migrations, including E3B3, remain unchanged; exactly one uncommitted E3C2
  migration exists and no migration 21 was created.
- The build-only `apps/web/next-env.d.ts` change was restored to its pre-verify content.
- Final worktree: `18` intended E3C2 files, `git diff --check = PASS`, no generated contamination.
- No checkpoint, commit, push, PR or merge was created in this gate.
