# E1 — Local regression and closure

## Scope and corrections

- Commercial Beta: persistent List/Kanban/Drawer, filters/Saved Views, ownership/collaboration, activities, sales/post-sale commands, referral, import and derived intelligence.
- Recruiting Beta: independent profile/pipeline, operational A/B/C priority, appointments/interviews/followups, hooks, List/Kanban/Drawer and authorized actions.
- Entry checkpoint included the completed E1C3 working-tree changes; E1C3 was not committed locally. E1D preserves them and creates no commit.
- Fixed the local browser bridge: bounded binary multipart bodies and content type now reach CSV/XLSX preview/confirmation intact.
- Fixed NBA suppression of simulated post-sale work: approved → delivery; delivered/curation_pending → curation; cured/unknown state → no action.
- No migration, permission expansion, external integration or later lane added.

## Integration and security

- One canonical Person holds both aggregates; changes in either lifecycle leave the other unchanged and create no duplicate aggregate/Person.
- Explicit Commercial and Recruiting grants remain independent; revoking either preserves the independently authorized other lifecycle.
- Tenant/Network denial, BOLA, restricted PII, RLS, owner uniqueness, concurrency, idempotency, audit/provenance and append-only evidence retain regression coverage.
- Import preview does not persist; confirmation is explicit/transactional/idempotent, exact identity reuse is scoped, ambiguity is rejected and untrusted schema cannot add authority.
- Health/score/NBA remain deterministic authorized read projections with stable reason codes, bounded score, rule version and RPT advisory labeling. No action is executed by NBA.
- Commercial list aggregates intelligence within one paginated SQL statement; no per-row query loop or new cache was introduced. Existing volume regression remains the performance gate.

## Local validation

- Initial E1 focused tests: 11 unit and 31 integration PASS.
- Cross-lifecycle closure: 4/4 PASS; intelligence including post-sale boundary: 5/5 PASS.
- Integrated Commercial E2E: 14/14 PASS; affected post-sale and CSV/XLSX E2E rerun: 3/3 PASS.
- Recruiting E2E: 6/6 PASS; complementary Light ES and System PT cases: 2/2 PASS. Commercial Light ES Drawer: 1/1 PASS.
- Keyboard/focus trap/return/Escape, reduced motion, accessible states and axe checked through the existing regression plus closure tests.
- Visual evidence: `work/u6-visual/`, `work/e1b-visual/`, `work/e1-closure-visual/`; artifacts remain unversioned.
- Representative matrix: Commercial Light ES List/Drawer, wide Dark EN Kanban/Drawer, mobile System FR; Recruiting Light ES List, wide Dark EN Kanban/Drawer, mobile System PT; forbidden and import preview/result.
- Final `npm run verify`: PASS (format, lint, typecheck, 19 unit, security, 68 integration and web/API builds).
- Final `git diff --check`: PASS; complete local diff reviewed.

## Limits and readiness

- Existing local/test authentication bridge and simulated approval boundaries are retained; this is not a production release.
- Non-blocking debt: detailed import parser errors in FR/PT retain the existing English catalog fallback; no raw localization keys in the tested flows.
- Blockers: none.
- E1 status: PASS_LOCAL_READY_FOR_REVIEW. Next package: E2 — Agenda / Tasks / Field Sales.
