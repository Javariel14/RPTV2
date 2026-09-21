# E1C1 — Commercial CRM collaborators, activities and referral core

## Model and changes

- Opportunity keeps one immutable primary owner.
- Collaborators reuse explicit, time-bounded `authz.access_grant` records; no parallel ACL.
- The collaboration grant includes Opportunity scope plus canonical Person identity read,
  but never restricted PII.
- `crm_activity` stores append-only internal `call` and `message` facts with actor,
  occurrence time, summary, request provenance and `RPT_USER` source.
- Opportunity may reference an existing same-tenant Person as referrer only when its
  existing source is `referral`; no Person duplication or referral graph is created.
- Commercial Detail Drawer exposes the authorized collaborator, activity and referral
  projections and the existing command endpoint handles their mutations.

## Permissions

- Add/remove collaborator requires explicit Opportunity update plus share authorization.
- Capability, grantor authority, policy version, expiry and revocation are re-evaluated.
- Network hierarchy grants no collaborator or CRM access.
- Activity creation uses existing `activity:create`; reads remain RLS/field scoped.
- Referral lookup uses Person RLS and never grants access to the referrer.
- Commands retain expectedVersion, idempotency receipts, audit and BOLA-safe failures.

## Local tests

- E1C1 unit contracts: PASS.
- E1C1 PostgreSQL integration: 5/5 PASS.
- CRM U3/U4 regression: 15/15 PASS.
- Covered owner uniqueness, scoped collaboration, cross-tenant denial, Network denial,
  policy/removal revocation, PII boundary, call/message persistence, append-only facts,
  no external side effects, referral reuse, concurrency, idempotency and audit/provenance.

## Blockers and next package

- Blockers: none for local review.
- Status: PASS_LOCAL_READY_FOR_REVIEW after final local gate.
- Next: E1C2 — Commercial CRM basic CSV/Excel import.
