# AGENTS.md — Royal Performance Tracker (RPT)

## Scope
Aplica a todo el repositorio salvo un `AGENTS.md` más profundo.
Un `AGENTS.md` más específico manda dentro de su subárbol.

Workspace oficial:
`C:\Proyectos JAVARIEL\RoyalPerformanceTracker`

Owner: JAVARIEL Corp.
Quality: `CRITICAL`.

## Sources of truth
Producto/planificación:
`/Google Drive/04 - JAVARIEL Corp/06 - Planificación Proyectos/01 - Royal Performance Tracker/`

Implementación:
repositorio oficial + historial + tests.

Ruteo:
`CONTEXT_ROUTER.md`

Contexto derivado:
`docs/agent-context/`

El contexto derivado nunca supera a la fuente canónica.

Prioridad:
1. fuente oficial vigente Hy Cite/Royal Prestige para facts oficiales;
2. `16 — Gobierno — Decision Registry y Fuentes Canónicas — RPT`;
3. documento canónico especializado;
4. Discovery aprobado;
5. Plan Maestro;
6. investigación/histórico.

No uses `HISTÓRICO`, `DEPRECATED`, `DUPLICADO`, `SUPERSEDED` o `NO IMPLEMENTAR` como autoridad vigente.

Si una fuente no es accesible, no afirmes que fue leída.

## Context discipline
Antes de una tarea:
1. identifica dominio;
2. consulta `CONTEXT_ROUTER.md`;
3. abre solo fuentes del dominio;
4. busca código/tests relacionados;
5. amplía contexto solo por dependencia descubierta.

Default discovery:
- <= 6 fuentes;
- <= 12 archivos de código/tests.

Exceder solo con motivo concreto.

No resumas nuevamente todo RPT.
No pegues archivos completos si una sección basta.

## Core invariants
No modificar sin fuente canónica/ADR cuando corresponda:

- strict multi-tenancy;
- Tenant A nunca descubre datos de Tenant B;
- `Person != UserAccount`;
- Comercial y Reclutamiento comparten Person, no lifecycle;
- `NetworkHierarchy -> StatisticalScope`, no CRM/PII automático;
- CRM access = workspace + ownership + policy + permission + delegation;
- relaciones/membresías temporales usan effective dates;
- audit relevante append-only;
- provenance para datos externos relevantes;
- correcciones = adjustment/reversal, no reescritura silenciosa;
- AI inference no sobrescribe official fact;
- Opportunity -> Won solo tras `approved` oficial/equivalente autorizado;
- UI visibility != authorization;
- service-role secrets nunca en browser/mobile/desktop;
- no scraping/bypass de portales privados;
- high-risk autonomous AI action tolerance = 0.

## Architecture baseline
No cambiar por preferencia:

- modular monolith first;
- Next.js + React + TypeScript web;
- TypeScript backend;
- PostgreSQL/Supabase baseline;
- RLS donde corresponda;
- Cloudflare donde aporte;
- Flutter mobile;
- Tauri 2 desktop;
- Python solo donde aporte para IA/data;
- provider adapters para integraciones/AI/STT;
- OpenTelemetry baseline;
- FTS/trigram antes de vector cuando vector no esté justificado.

No microservices/Redis por prestigio.

## Visual baseline
Fuente: `43 — Marca y Sistema Visual — CANÓNICO — RPT`.

- Essence: `PROGRESO CON CLARIDAD`
- Direction: `RPT Equilibrado v2`
- Logo: `Opción B — Monograma R Ascendente`
- CRM != dashboard

Evitar card soup, KPI wall, admin-template genérico, mobile comprimido y tokens visuales arbitrarios.

No expandir UI si la reference route no pasa Visual QA.

## Decision protocol
D1 reversible/local:
decide, documenta breve, sigue.

D2 relevante:
ADR con contexto, alternativas, decisión, impacto, seguridad/privacidad y rollback.

D3 estratégica/irreversible:
no improvisar.

Bloquea solo si afecta:
- tenant isolation;
- pérdida de datos;
- legal/contrato;
- arquitectura fundamental;
- producción/release;
- acceso externo indispensable;
- decisión explícita del Product Owner.

## Execution loop
`DISCOVER -> PLAN -> IMPLEMENT -> VERIFY -> REVIEW -> REPORT`

DISCOVER:
- `git status`;
- instrucciones aplicables;
- patrón existente;
- código/tests afectados.

PLAN:
- máximo 5–10 bullets;
- objetivo/scope/non-goals;
- aceptación;
- pruebas.

IMPLEMENT:
- cambios mínimos;
- no reescribir archivos enteros sin necesidad;
- no refactor ajeno al scope;
- reutilizar patrones que ya pasan QA.

VERIFY:
- prueba focalizada primero;
- ampliar según riesgo/boundary.

REVIEW:
- inspeccionar diff;
- buscar regresiones, permisos, tenant leakage, secretos y código muerto;
- corregir antes de reportar.

REPORT:
`RESULT / FILES / TESTS / EVIDENCE / BLOCKERS / STATUS / NEXT`

## Dependencies / external code
No copiar repositorios enteros.

Antes de introducir una dependencia relevante:
- versión concreta;
- licencia;
- mantenimiento/seguridad razonable;
- paquete oficial cuando exista;
- adapter boundary si es vendor/integración;
- tests;
- upgrade path.

## Git safety
- no borrar cambios del usuario;
- no reset destructivo;
- no reescribir historia;
- no inventar repo alternativo;
- no exponer secretos;
- respetar checks existentes.

## Subagents
Default: ninguno.

Delegar solo trabajo independiente.
Evitar agentes concurrentes sobre los mismos archivos/boundaries.
El agente principal integra y verifica.

## Testing proportionality
Cambio local -> test focalizado + lint/typecheck pertinente.
Cambio de dominio -> unit + integration/contract relevante.
Security/tenancy/migration -> critical tests obligatorios.
Gate de fase -> suite definida por la fase.

## Persistence
No preguntes por dudas rutinarias.
Haz la mejor inferencia reversible respaldada por fuentes y documenta.
Pregunta/bloquea solo por D3 o falta indispensable de acceso.

FIN.
