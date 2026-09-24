# E2A — Agenda / Tasks Core

## Model

- `rpt.agenda_item` is the native calendar/task aggregate with owner, workspace, optional authorized Person or exactly one CRM context, version, source and travel metadata.
- Existing Commercial appointments/tasks and Recruiting appointments/followups are projected into the unified read model without copying them. They remain read-only through Agenda and keep their original lifecycle/permissions.
- List queries are bounded to 93 days/500 results and expose generic legacy titles; source notes/contact PII are not copied into Agenda summaries.

## Appointments, tasks and reminders

- Native appointments support create, title/summary update, confirm, decline, cancel and idempotent reschedule.
- Native tasks support create, title/summary/due date/priority update and idempotent completion. Reopen is intentionally unsupported because no prior lifecycle contract permits it.
- Internal-only reminders carry dedupe, status and retry metadata. Reschedule/due-date changes cancel pending jobs and create only the replacement set.
- Audit triggers and append-only `agenda_event` provenance record create/update/reschedule/confirmation/cancel/completion operations.

## Recurrence and time

- Finite daily and weekly/selected-weekday rules generate at most 50 instances and reject larger expansions.
- Occurrences are expanded from local wall time using the stored IANA timezone, preserving DST behavior and unambiguous `timestamptz` instants.
- Series and occurrence indexes prevent duplicates. E2A supports safe single-instance commands; series-wide edit/cancel UX remains E2B scope.
- Travel context is labels plus estimated travel/preparation minutes only; no geocoding, routes, GPS or tracking.

## Permissions and tests

- Agenda uses the existing capability/workspace/grant engine, RLS, tenant boundary, BOLA behavior and immediate policy revocation.
- Agenda visibility never grants Person, Opportunity or RecruitmentProfile access; linked IDs are redacted when source access is absent. Network hierarchy grants nothing.
- Focused contracts: 2/2 PASS. PostgreSQL/API E2A plus E1 cross-lifecycle regression: 14/14 PASS.
- The single `npm run verify` passed format, lint, typecheck, 21 unit and security; integration found only two stale migration-count expectations (10 → 11).
- After that necessary regression update, the affected CRM/Foundation suites passed 25/25, including encrypted restore/RLS; web and API builds passed separately.

## Blockers and next

- Blockers: none. Local status: PASS_LOCAL_READY_FOR_REVIEW.
- Next after PASS: E2B — Calendar UX, reminders, confirmations and rescheduling.
