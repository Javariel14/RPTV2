# E2C continuity — Field Visits Core

## Model

- `field_visit` is an independent aggregate linked optionally to one authorized Agenda appointment,
  Person and Commercial Opportunity; it does not duplicate those records.
- Schedule is stored as an immutable operational snapshot when linked to Agenda; travel/preparation
  remains read from the authorized Agenda item.
- Events and optional location evidence are append-only; commands use versions and idempotency.

## Transitions

- `planned -> in_progress -> completed` with server-authored actual timestamps.
- `planned -> cancelled` and `planned -> no_show` are explicit terminal paths.
- Check-out requires a valid check-in; update is limited to unlinked planned visits.

## Location / privacy

- No tracking, maps, geocoding, routes or background capture.
- Explicit check-in/out may store bounded numeric coordinates, optional accuracy, server capture time,
  fixed source/purpose and explicit action context.
- `RESTRICTED_LOCATION` is independent from basic Visit/Agenda/CRM access.

## Permissions

- Server authorization, RLS, tenant/BOLA, workspace policy, ownership and immediate revocation apply.
- Visit grants do not reveal Person, Opportunity, Agenda context or location without their own policy.
- Network hierarchy grants no Visit or location access.

## Tests

- E2C unit contracts: 2/2 PASS.
- E2C PostgreSQL integration: 8/8 PASS.
- E2A Agenda regression: 10/10 PASS.
- Security, lint and typecheck: PASS; full integration: 86/86 PASS; web/API build: PASS.
- The single `verify` run exposed only stale migration-count expectations; both checkpoints passed
  after correction and the complete integration gate was rerun successfully.

## Debt

- Offline queue and Field Sales UI remain intentionally deferred.

## Blockers

- None known locally.

## Next

- E2D — Field Sales UX.
