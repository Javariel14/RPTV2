# E1B — Recruiting CRM UI continuity

## Surfaces implemented

- Route: `/crm/recruiting`.
- Persistent PostgreSQL List/DataGrid with Person, owner, source, recruiting stage,
  operational substatus, A/B/C priority, next follow-up and updated state.
- Recruiting Kanban with the ten E1A lifecycle stages and authorized forward movement.
- Filters: search, owner, stage, source, priority, substatus and follow-up activity.
- Detail Drawer with authorized Person contact, profile data, appointments, interviews,
  follow-ups, training/onboarding hooks and audit timeline.
- Commands: stage, substatus, priority, owner reassignment, appointment, interview,
  follow-up create/complete and training/onboarding hook.
- Saved Views were not added because E1A exposes no Recruiting Saved View contract.

## Patterns reused

- Existing RPT App Shell, Page Header, view navigation, FilterBar, List/Kanban,
  native-dialog Drawer, tokens, responsive breakpoints and reduced-motion behavior.
- Light/Dark/System and ES/EN/FR/PT catalogs.
- Local/test BFF boundary; no fixture fallback in the runtime UI.

## Security

- Server commands remain authoritative and use expectedVersion plus idempotency keys.
- The UI consumes action-level permissions; hidden actions do not replace backend checks.
- Contact PII is absent unless the Person restricted-field policy allows it.
- New SECURITY DEFINER context projection exposes only an authorized Recruiting workspace
  and eligible owner identifiers; runtime receives no direct authz-table grants.
- Tenant/RLS/BOLA, revocation and Network non-inheritance remain covered by E1A tests.

## Local tests and Visual QA

- Recruiting UI unit catalog test: PASS.
- E1B PostgreSQL read-model integration: PASS.
- E1A Recruiting integration regression: 12/12 PASS.
- Recruiting E2E: 6/6 PASS, including persistence, conflict, forbidden/revocation,
  focus return, mobile overflow, four locales/themes and axe critical/serious checks.
- Representative evidence: `work/e1b-visual/` and `work/e1b-e2e-results.json`.
- Matrix: desktop Light ES List; desktop-wide Dark EN Kanban + Drawer;
  mobile 390 System FR Drawer; mobile 390 Dark PT forbidden.

## Blockers and next package

- Blockers: none for local review.
- Status: PASS_LOCAL_READY_FOR_REVIEW.
- Next: E1C — Commercial CRM remaining gaps.
