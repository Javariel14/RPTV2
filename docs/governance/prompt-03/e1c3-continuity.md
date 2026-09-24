# E1C3 continuity

## Derived model

- Commercial intelligence is calculated on demand; no derived state or external cache is persisted.
- Rule version: `commercial-beta-v1`; every response includes its calculation timestamp.
- Inputs are authorized structured CRM facts only: stage, next action/due date, updates, CRM activity/events, tasks, objections, commitments, appointments and simulated order state.
- Person PII, protected attributes and Network rank are not inputs.

## Relationship health

- `at_risk`: overdue task or at least 14 days without activity/update.
- `attention`: missing/overdue next action, 7-day inactivity, pending objection or pending commitment.
- `healthy`: no attention/risk rule; closed stages are explicitly identified.
- Stable reason codes accompany every result.

## Operational score

- Bounded integer hygiene/engagement score from 0 to 100; it is not a close probability.
- Base 50 with explicit positive/negative components returned as reason plus impact.
- Main positive signals: recent activity/update and scheduled appointment.
- Main negative signals: inactivity, overdue task/action, missing action, objection and commitment.

## Next best action

- At most one advisory action; it never executes a command.
- Precedence: closed stage, overdue task, objection, commitment, scheduled appointment, missing/overdue action, then stage-specific existing flow.
- Action, priority, reason, reference and deterministic explanation code are returned.
- UI labels the output as an RPT recommendation and not an official external fact.

## Tests and blockers

- Pure rule unit tests, PostgreSQL authorization/integration tests and focused CRM E2E: PASS during development.
- Final local gates are recorded in the task result.
- Blockers: none at implementation time.

## Next package

- E1D — E1 regression, integration and closure.
