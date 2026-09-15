# U4 — Kanban, detalle y comandos CRM persistentes

## Checkpoint de entrada

Rama `feature/u4-crm-kanban-detail`, creada desde `2b10ca19a7d144947dfd7fe1fb8dde00bdffae66`: merge del [PR #6 de U3](https://github.com/Javariel14/RPTV2/pull/6). Al comenzar, HEAD, main y origin/main coincidían, `git status --short` y el diff contra origin/main estaban vacíos. No se reinició Foundation ni se repitieron U1/U2/U3.

## Plan ejecutado y fuentes

- Goal: conectar Kanban, Drawer y acciones existentes a PostgreSQL sintético.
- Current state: contratos, tablas y triggers CRM ya presentes; detalle y comandos pendientes de conexión.
- Scope: aplicación/API/BFF, componentes CRM reutilizando el Shell, permisos, concurrencia, idempotencia, tests y evidencia.
- Non-goals: drag/drop, aprobación oficial, datos reales, cambios de reglas comerciales, reclutamiento, Network, AI, U5/U6/Prompt 03 y merge.
- Files likely: application/contracts, web/api, fixtures de test, migración incremental sólo para proyección de permisos, tests y workflow.
- Acceptance: persistencia real; conteos/filtros/vistas; detalle y acciones fail-closed; cuatro idiomas/themes; regresiones sin rebajar gates.
- Test plan: unit, PostgreSQL/API, BOLA/tenant, delegación/revocación, expectedVersion/idempotencia, E2E/axe, build/SAST/secrets/SCA y diff.

Fuentes consultadas mediante progressive disclosure, sin leer toda la planificación:

- `AGENTS.md`, `CONTEXT_ROUTER.md`, `apps/web/AGENTS.md`, continuidad/manifiesto U3 y plan local Prompt 02.
- [05 — Operación](https://docs.google.com/document/d/15tKfH9nRsKBy9ohuaCKfbF-WGnv5Y2lN-Ikv57lAH54/edit): pipeline comercial, venta ganada/ciclo de pedido y visibilidad por rol. Se conserva la máquina de estados del contrato/migración del slice, sin extender otros módulos.
- [28 — Permisos](https://drive.google.com/file/d/1cn4s-cDmtz-1WiAxlPda0T9864Br97N1/view): capability + objeto/scope + campo + contexto/policy vigente; delegación explícita y revocable.
- [43/04 — Componentes](https://docs.google.com/document/d/1Y3wCepaeQQhxE5gOi0SBOU4OvgqcFXny44VxZXct9yo/edit): Kanban, Saved Views, Drawer 420–480 px, sheet, timeline y tareas.
- Documentación local Next para client/server y Route Handlers; guías React/Supabase para límites de cliente, cancelación y [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security); build Cloudflare conservado en dry-run.

La inspección se amplió desde los contratos a sus dependencias directas (triggers/permissions, servicio transaccional, BFF, seed y harness de pruebas) porque U4 atraviesa esas fronteras. No se refactorizaron áreas ajenas.

## Implementación

- Kanban: usa consultas U3 autorizadas, filtros completos y configuración de Saved View; paginación de 20 por etapa, conteos de servidor y etapas vacías explícitas. No descarga toda la cartera ni usa fixtures al fallar. No drag/drop; cambio de etapa desde comando/formulario accesible.
- Drawer: abre por UUID desde DataGrid/lista móvil/Kanban, sin depender de que el objeto esté en la página de tabla actual. SELECT bajo RLS, PII aislada; colecciones autorizadas limitadas a los 100 registros más recientes por sección, indicado en la UI. Panel canónico 460 px; móvil full-screen/action-first, cierre nativo/Escape y retorno de foco.
- Endpoint GET `/v1/crm/opportunities/:id`; POST `/v1/crm/opportunities/:id/commands`. BFF allowlist de UUID, origen/CSRF y entorno local/test existentes. Sin exposición pública de laboratorio.
- Comandos: stage (`contacted`/`lost`); appointment; demo; quote versionada; submit_order; reconcile_mock; delivery; curation; entry (note/task/objection/commitment); complete_task; edit_person con personVersion; edit_contact.
- Los hitos con evidencia se alcanzan mediante su comando específico, no por un cambio arbitrario de stage. Los triggers existentes siguen rechazando transiciones ilegales y `won` oficial.
- Toda escritura usa identidad vigente, `rpt_runtime`, lock de oportunidad, `expectedVersion`, recibo de idempotencia y auditoría transaccional. La respuesta del recibo sólo se devuelve después de reevaluar permiso sobre el objeto y la acción. Cambiar payload con la misma key es conflicto. Reintento de respuesta perdida conserva body/key.
- Reconciliación exclusivamente `MANUAL_RECONCILIATION / order_simulation / manual`, `verified_at=NULL`, evidencia vinculada al pedido; no genera ventas/compensación oficiales. Se conserva la separación entre `won_simulated` y `won`.
- La migración incremental expone sólo un booleano de autoridad manual vigente; no concede autoridad ni reemplaza guards. La autoridad sintética se concede únicamente en el seed de desarrollo/test. Una revocación bloquea también el replay del recibo.
- Errores: estados de carga, vacío, no disponible/sin permiso, conflicto, validación e indisponibilidad; foreign/unknown devuelven el mismo NOT_FOUND. Las proyecciones se descartan al recibir denegación/error. No se registran PII en eventos de timeline ni credenciales en evidencia.
- Se preservan catálogos y mensajes U3; vocabulario nuevo separado para ES/EN/FR/PT. Sin nuevas dependencias ni cambios de versión.
- Estabilidad de consultas: la suite ampliada reprodujo un `statement_timeout` de 10 s en el listado U3 después del flujo U4. Se materializa la entrada de oportunidades autorizadas antes del JOIN, siguiendo el patrón existente de Person; esto evita reevaluaciones RLS por rescans del JOIN. Dos ejecuciones completas posteriores pasaron 7/7 sin aumentar timeouts. No se atribuye el disparador a autovacuum: las pruebas aisladas con ANALYZE no reprodujeron ese disparador. Se conserva una regresión con volumen y estadísticas actualizadas. Revisión con la guía Supabase PostgreSQL: `EXPLAIN ANALYZE` bajo `rpt_runtime` y 45 oportunidades sintéticas confirmó un único scan de oportunidad (`loops=1`, 780.869 ms de ejecución total), guardado en `work/u4-query-plan.json`.

## Validación y evidencia

Estado de cierre: **EN VALIDACIÓN**. No representa PASS hasta registrar la ejecución completa y el checkpoint remoto.

Pruebas U4: `tests/unit/crm-u4.test.ts`, `tests/integration/crm-u4.test.ts`, `tests/e2e/crm-u4.spec.ts`. CRM E2E ejecuta U3 y U4 con el mismo gate, sin retries. Foundation E2E permanece separado.

Artifacts generados, ignorados por Git: `work/u4-e2e-results.json`, `work/u4-visual/`, JSON/HTML/traces conjuntos en `work/u3-*`, `work/u4-verify.log`, `work/u4-integration.log`, `work/u4-supply-chain.log`. Actions conserva las capturas U4 y el resumen U4 junto a la evidencia CRM existente; verify conserva la salida de integración y supply-chain en `foundation-evidence`. Nunca se suben datos del cluster, backups ni secretos.

La evidencia visual U4 no certifica U5/U6 ni Visual QA global de Prompt 02. Staging/producción y cualquier adaptador oficial siguen fuera de alcance.
