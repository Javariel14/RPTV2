# E1A — Recruiting CRM Core

## Implementado

- `RecruitmentProfile` persistente reutiliza `Person`; no crea ni comparte `Opportunity`.
- Workspace, ownership, source, stage, substatus, prioridad A/B/C opcional, versión y timestamps.
- Objetos persistentes separados para appointments, interviews, followups y hooks de training/onboarding.
- Eventos de Recruiting append-only con actor, request, fuente y autoridad manual.
- API para crear, listar, obtener detalle y ejecutar comandos con `expectedVersion` e idempotencia.
- Crear sobre Person existente o crear Person + perfil atómicamente, sin efectos comerciales.

## Lifecycle

- Fuente: documento canónico 05 de Operación/Pipelines/Reclutamiento.
- Etapas: new → initial_contact → qualified → interview_to_schedule → interview_scheduled → interviewed → evaluation → followup_decision → onboarding → activated.
- Subestados operativos permanecen separados de las columnas visibles.
- A/B/C es prioridad operativa explicable; no personalidad ni diagnóstico.

## Permisos

- RLS en todas las tablas nuevas; runtime sin bypass/owner role.
- Acceso por capability + workspace/ownership o delegación explícita y revocable.
- Network hierarchy no concede acceso a Recruiting CRM.
- PII se proyecta únicamente mediante el permiso existente sobre `Person`.
- Reasignación requiere permiso explícito y acceso del nuevo owner.

## Tests locales

- Contratos E1A: 2/2 PASS.
- Integración PostgreSQL/API E1A: 11/11 PASS.
- Incluye tenant/BOLA, Network deny, revocación, concurrency, idempotencia, audit/provenance e independencia Comercial/Recruiting.
- Lint focalizado, typecheck y security: PASS.

## Estado

- Blockers: ninguno.
- Estado: `PASS_LOCAL_READY_FOR_REVIEW`; `npm run verify` completo PASS.
- Siguiente paquete: E1B — Recruiting CRM UI.
