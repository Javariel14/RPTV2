# Prompt 02 — Contrato de implementación local

Ruta oficial: `C:\Proyectos JAVARIEL\RoyalPerformanceTracker`.

## Entrada

Foundation revalidada el 2026-09-04 14:52 UTC: nueve checks PASS. GitHub es una integración pendiente, no un impedimento para el workspace local confirmado. No se reutiliza el legacy ni se habilitan datos reales.

## Fuentes y autoridad

Leídos nuevamente en Drive: 16,17,19,20,26,27,28,33,37,42 y 43/00–08. Las ubicaciones permanecen en el manifiesto heredado del Prompt 00. DR-001/002 rigen aprobación; ERD-001/002/013/018/020/030 rigen identidad, ownership, provenance y ledger. 43 prevalece visualmente sobre 37 y sobre el logo histórico del blueprint.

## Ruta y composición

`/crm/commercial`: asesor sobre ownership; asistente solo mediante grants; ancestro Network sin acceso CRM. Shell reutilizado 248/72 + topbar 64; header con crear oportunidad; vistas; tabla/Kanban; filtros compactos; tabla dominante; drawer 460; selección/acciones contextuales. Mobile usa lista, filtros bottom-sheet y detalle full-screen. Sin KPI cards en CRM.

Tokens: `packages/design-tokens`, mismas fuentes y SVG canónico. Componentes: Button, Panel, State y nuevos controles reutilizables; no variantes de marca por feature. ES/EN/FR/PT; Light/Dark/System.

## Flujo y datos

Identidad de laboratorio firmada y revocable, onboarding del asesor, Person, Opportunity con ownership independiente, Appointment, DemoVisit, Quote versionada, Order, reconciliación mock, aprobación y ganada simuladas, entrega/curación, métricas y vista mínima separada de prioridades. Operaciones persistidas, idempotentes, con optimistic concurrency y auditoría.

La simulación conserva `authority_level=manual`, `verified_at=NULL` y etiqueta explícita. `won_simulated` nunca equivale a `won`; las métricas de simulación no entran a `sales` oficiales. Una venta oficial continúa requiriendo fuente autorizada y observación vinculada. No se introducen precios, productos o políticas oficiales inventadas.

## Acceptance y evidencias

- Flujo end-to-end sobre PostgreSQL real, sin mocks de permisos ni arrays como persistencia.
- Allow owner; deny same-tenant/cross-tenant/Network; grant exacto; revocación; campos PII; mutaciones directas ilegales; concurrencia/idempotencia; evidencia append-only.
- Vistas guardan configuración, nunca privilegios. Compartir requiere autoridad vigente sobre el scope completo; lectura reevalúa permisos.
- Loading/empty/no results/error/permission/offline/degraded/stale sin datos sensibles antes de autorización.
- 320/390/768/1024/1280/1440/1728, Light/Dark/System, teclado/foco/semántica/contraste, traducciones largas, reflujo y volumen >=1000.
- Capturas y baselines técnicos dentro del workspace; revisión contra 43/03 y 43/07. El blueprint capturado durante Foundation se conserva con su procedencia; la URL visual actualmente exige login, pero los textos canónicos se consultaron con el conector autorizado.
- No expansión de módulos de Prompt 03; no PASS sin checks y evidencia.
