# E1C2 continuity

## Implemented

- Basic Commercial CRM import accepts strict UTF-8 CSV and non-macro XLSX.
- Files are limited to 512 KiB, 100 data rows, 10 allow-listed columns and text cells.
- The server inspects content and extension; formulas, macros, embedded/external content and unsafe ZIP paths are rejected.
- Preview parses, validates and resolves identity without persistence.
- Confirmation reparses inside one transaction, requires the preview hash and records a completed import batch.
- Partial import is explicit: valid rows persist; invalid/conflicting rows remain counted and actionable.

## Identity and security

- Person reuse is exact, tenant-local and workspace-local by canonical email/phone identifiers.
- Multiple or inconsistent exact matches are conflicts; there is no fuzzy merge or PII overwrite.
- Owner is limited to the current authorized actor and imported stage is limited to `new`.
- Referral resolution is exact and authorized and never creates access grants.
- RLS, current-session authorization, revocation, bounded input, transaction rollback and idempotent confirmation are enforced server-side.
- Preview never returns email, phone or resolved Person IDs.
- Import batches/items are immutable, audited and retain filename, file hash, actor, request and row provenance without retaining the source file.

## Local tests

- Focused parser unit tests: PASS.
- E1C2 PostgreSQL/service/API integration tests: PASS.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Supply-chain gate: PASS; new parser dependencies are exact-version MIT packages.
- The single `npm run verify` reached integration, where U4 hit a transient Windows/PostgreSQL timeout.
- U4 then passed in isolation, the complete integration suite passed 58/58, and the production build passed without changing the gate.

## Blockers

- None locally.

## Next package

- E1C3 — Commercial CRM relationship health, explainable scoring and deterministic next best action.
