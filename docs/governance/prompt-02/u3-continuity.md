# Prompt 02 v4 — Continuidad y entrega U3

Fecha: 2026-09-13. Entorno: desarrollo/test local, datos exclusivamente sintéticos.
Workspace: `C:\Proyectos JAVARIEL\RoyalPerformanceTracker`.

## Auditoría de entrada

| Work package                           | Estado  | Evidencia del repositorio                                                                                                                                                                                     |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 — tokens/themes/App Shell           | PASS    | `packages/design-tokens`, `apps/web/app/styles.css`, `reference-workspace.tsx`; aceptación previa `foundation-entry-evidence.json`; `tests/e2e/reference.spec.ts` cubre Light/Dark/System y anchos canónicos. |
| U2 — component primitives mínimos      | PASS    | `packages/ui`, reutilización de Button/Panel/State; Component Lab y pruebas de foco, teclado y axe de la referencia.                                                                                          |
| U3 — DataGrid/FilterBar/Saved Views    | PARTIAL | Tabla/filtros implementados, pero `referenceContacts` y `useState<SavedView[]>` eran la fuente funcional; contratos CRM y tabla `rpt.saved_view` existían sin conexión UI/API.                                |
| U4 — Kanban/Detail Drawer/permissions  | PARTIAL | Kanban y Drawer de referencia existentes; contratos `CrmDetail` y políticas CRM iniciales, sin flujo persistente de detalle/comandos.                                                                         |
| U5 — responsive/estados/a11y/i18n      | PARTIAL | Referencia validada previamente; faltaba evidencia sobre la ruta CRM integrada.                                                                                                                               |
| U6 — vertical flow/evidencia/Visual QA | PARTIAL | `implementation-plan.md`, contratos y migración inicial; no existía cierre verificable del flujo CRM completo.                                                                                                |

Se leyeron `AGENTS.md` y `CONTEXT_ROUTER.md`. Prompt 00 y Foundation no se reiniciaron.
En la auditoría inicial, `git status` y la consulta de rama fallaron porque no había `.git`.
Durante la ejecución aparecieron un repositorio y checkpoints externos a esta implementación: rama `feature/u3-crm-persistence`, HEAD observado `bfbdca2` (`wip: preserve latest U3 state`) y remoto configurado `origin`.
No se creó ni modificó el repositorio/remote y no se hizo commit/push en esta ejecución. No se verificó la publicación remota.
Git exige una excepción de ownership por pertenecer a Administradores: sólo se usó `-c safe.directory` para lecturas puntuales del directorio exacto; no se cambió la configuración global.
La comparación del turno completo usa preimágenes y `git diff --no-index`, complementada con el diff pendiente contra el HEAD actual.

## Issue ejecutado

- Goal: conectar el DataGrid existente, filtros y vistas a PostgreSQL real.
- Current state: Foundation reutilizable; U3 visual parcial y almacenamiento/API pendientes.
- Scope: listado servidor, paginación de 20, filtros, orden, columnas/densidad, vistas privadas/equipo/compartidas y sesión local autenticada.
- Non-goals: rehacer U1/U2; completar comandos/detalle/Kanban de U4; clientes reales; despliegue; Reclutamiento, Network, AI, WhatsApp, mobile o Prompt 03.
- Files/modules likely affected: aplicación/API, adaptador de la referencia web, arranque local, pruebas y evidencia CRM.
- Canonical sources required: plan local Prompt 02; [43/04 Componentes e interacción](https://docs.google.com/document/d/1Y3wCepaeQQhxE5gOi0SBOU4OvgqcFXny44VxZXct9yo/edit), especialmente DataGrid, FilterBar y Saved View; [28 Permisos](https://drive.google.com/file/d/1cn4s-cDmtz-1WiAxlPda0T9864Br97N1/view).
- Acceptance criteria: recargar conserva las vistas; todos los datos/conteos proceden de PostgreSQL; compartir una vista no concede permisos; revocaciones y fallos no recuperan fixtures.
- Validation: PostgreSQL/API/permisos, E2E, capturas inspeccionadas, typecheck/lint/build y revisión completa de cambios.

El plan se presentó antes de editar. La lectura posterior se limitó a las dependencias necesarias de identidad, transacción, RLS y pruebas. No se recorrió toda la planificación de Drive.

## Implementación

- Ruta `/crm/commercial` sobre `ReferenceWorkspace`, sin duplicar el App Shell, tokens, themes, catálogos anteriores ni primitivas. `/` conserva la referencia controlada con fixtures.
- GET `/v1/crm/context`, `/v1/crm/opportunities` y `/v1/crm/views`; POST `/v1/crm/views`.
- Listado servidor con filtros de búsqueda, owner, etapa, origen, estado, actividad y prioridad. Orden por nombre/actualización/fecha, desempate por UUID, conteos y filas en la misma sentencia/snapshot RLS.
- Filtros de actividad: `due` usa próxima fecha vencida; `inactive` usa actualización anterior a siete días. Fechas con timezone del laboratorio: America/Guayaquil.
- Vistas persistentes con filtros, orden, columnas, densidad y modo. La UI U3 crea vistas de tabla; el contrato conserva el modo para continuidad con U4.
- Vistas compartidas/equipo verifican derechos del emisor y destinatarios. Volver a aplicar su configuración ejecuta otra consulta bajo los permisos actuales. No se almacenan permisos en la vista.
- POST idempotente, misma clave/payload en reintentos; conflicto para reutilización con otro payload. Auditoría mediante la transacción Foundation ya existente.
- El cliente cancela resultados obsoletos, agrupa cambios rápidos de filtros y revalida al recuperar foco y cada 30 segundos. Una carga fallida, 401 o 403 elimina las filas visibles; no hay fallback funcional a fixtures ni almacenamiento CRM en localStorage.
- Laboratorio con JWT ES256 verificable y sesión revocable en PostgreSQL; cookie HttpOnly/SameSite=Strict; bridge privado y bind loopback; origen de POST explícito. La ruta BFF queda cerrada fuera de local/test. No se configura autenticación productiva.
- Se corrigió el error de tipos heredado de `crmCommand`: cada variante sigue siendo estricta; no se alteró su significado.

## Migraciones y rendimiento

Se aplicaron las migraciones existentes en bases desechables reales. No se modificó ninguna de las cuatro migraciones anteriores.

Se añadió `20260913021731_crm_permission_query_plan.sql`: conserva los predicados de `authz.crm_allowed` y su search_path fijo, usando un plan PL/pgSQL reutilizable. No concede privilegios nuevos ni desactiva RLS.

La primera consulta de 45 oportunidades excedía el statement timeout de 10 segundos. EXPLAIN identificó reevaluaciones de las políticas y un join con lectura repetida de personas. El listado final materializa una vez las personas autorizadas y calcula las capacidades adicionales sólo para la página. Se mantuvo el timeout; la prueba de listado/filtros y la API pasan. La hipótesis inicial de JIT no resolvió el problema y ese ajuste fue retirado.

Se usó la guía de Supabase para verificar el límite entre grants y RLS; la validación se realizó con el rol runtime real, no con service-role. Referencia técnica: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security). No se ejecutaron asesores ni migraciones contra un proyecto remoto.

## Validación y evidencia

| Comprobación                    | Resultado / archivo                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitarios existentes            | 5 PASS, `npm.cmd run test:unit`                                                                                                             |
| PostgreSQL/API U3               | 6 escenarios + suite PASS; `work/u3-integration.tap`                                                                                        |
| Regresión PostgreSQL Foundation | 17 escenarios + suite PASS; `work/u3-foundation-regression.tap`                                                                             |
| E2E U3                          | 3 PASS; `work/u3-e2e-results.json`, `work/u3-playwright-report/`                                                                            |
| Regresión E2E referencia        | 3 PASS; `work/u3-reference-regression/`                                                                                                     |
| Typecheck                       | PASS, raíz y web                                                                                                                            |
| Lint                            | PASS                                                                                                                                        |
| Build                           | Next/OpenNext y API dry-run PASS; no despliegue                                                                                             |
| Seguridad                       | Escáner de secretos cliente y límites de dominio PASS; no sustituye SAST/SCA                                                                |
| Formato focalizado              | PASS para archivos modificados TS/TSX/CSS/JSON/Markdown                                                                                     |
| Formato global                  | FAIL heredado: `AGENTS.md`, `CONTEXT_ROUTER.md`, `docs/governance/prompt-02/foundation-entry-evidence.json`; conservados sin modificaciones |

La integración prueba paginación, todos los filtros, orden, conteos, ausencia de email/teléfono en la proyección, own/sibling/cross-tenant, denegación Network/admin, delegación exacta, revocación, vistas privadas/equipo/compartidas, idempotencia concurrente, auditoría, validación HTTP y sesión revocada.

E2E: PostgreSQL → API → UI, restauración tras recarga de filtros/orden/columnas/densidad, fallos controlados sin datos de respaldo, sesión y CSRF. Los fallos HTTP inyectados pertenecen exclusivamente a pruebas de estados; el flujo funcional y las capturas usan PostgreSQL.

Capturas U3: `work/u3-visual/` contiene Light/Dark en 1440 y 390 px, cuatro idiomas en 390 px y configuración restaurada. Axe sin violaciones en las cuatro combinaciones theme/viewport. Se inspeccionaron capturas de tabla Light/Dark, móvil Dark, francés y filtros restaurados. No se declara Visual QA global del Prompt 02 PASS: U4–U6 aún requieren su propia evidencia.

La pasada inicial de regresión de referencia tuvo una interrupción del servidor compartido al terminar otra suite. Se repitió con servidor propio y sus tres pruebas pasaron. Los informes finales reemplazan los intentos fallidos de U3, no la evidencia canónica de Foundation.

## Archivos y revisión

Modificados: `packages/application/src/index.ts`, `packages/contracts/src/crm.ts`, `apps/api/src/app.ts`, `apps/web/app/reference-workspace.tsx`, `apps/web/app/styles.css`, `package.json`, `playwright.config.ts`, `tests/integration/foundation.test.ts`.

Nuevos: `packages/application/src/crm.ts`, `apps/web/app/use-crm-data.ts`, `apps/web/app/crm-catalog.ts`, `apps/web/app/api/crm/[...path]/route.ts`, `apps/web/app/crm/commercial/page.tsx`, `scripts/crm-dev.ts`, `tests/helpers/crm-fixtures.ts`, `tests/integration/crm.test.ts`, `tests/e2e/crm.config.ts`, `tests/e2e/crm.spec.ts`, la migración incremental y este informe.

El test Foundation sólo actualizó la cantidad esperada de migraciones de 3 a 5. Sus escenarios existentes no se rehicieron. El runner CRM separado evita ejecutar pruebas de sesión contra la referencia sin integración.

Preimágenes: `work/u3-before-20260912/`. Inventario y hashes: `u3-file-manifest.json`. Revisados todos los cambios de archivos existentes con `git diff --no-index`, además de los nuevos archivos, sus permisos, consultas, entrada HTTP y lifecycle del cliente. También se inspeccionó el diff del HEAD nuevo; sus checkpoints se conservaron. `apps/web/next-env.d.ts` es una salida regenerada por Next al alternar build/dev, no una edición manual.

## Uso local y continuidad

Desde el workspace oficial: `npm.cmd run dev:crm`. Abrir [CRM local](http://127.0.0.1:3101/crm/commercial) e introducir el código de sesión que imprime la terminal. No es una URL pública ni queda garantizada activa fuera del proceso local.

Cada arranque crea un laboratorio aislado de PostgreSQL en disco con 45 oportunidades sintéticas. Filas y vistas sobreviven a recargas y nuevas instancias del servicio dentro del laboratorio; no se reutiliza automáticamente la base entre arranques del laboratorio. La sesión dura una hora. Ningún dato real de cliente se importó.

Estado de salida: U1 PASS, U2 PASS, U3 PASS para este entorno de desarrollo/test; U4 PARTIAL, U5 PARTIAL, U6 PARTIAL. Sin bloqueo D3 para U3. Hay Git local y remoto configurado; publicación/remoto no se verificaron y no bloquean esta entrega local.

Siguiente: U4, conectar el Kanban/Drawer existentes a detalle y comandos CRM con permisos y validación de transiciones. No se ejecutó Prompt 03. Prompt 02 completo y su Visual QA siguen abiertos.
