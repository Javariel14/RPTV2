# Prompt 02 v4 — Continuidad y entrega U3

Actualizado: 2026-09-14. Entorno: desarrollo/test local y GitHub Actions, datos exclusivamente sintéticos.
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
Repositorio verificado: [Javariel14/RPTV2](https://github.com/Javariel14/RPTV2), rama `feature/u3-crm-persistence`, [PR #6](https://github.com/Javariel14/RPTV2/pull/6). El checkpoint de entrada al cierre CI es `ba4a6e5167b15ecba001ff7c74db116bbaafd8ec`; no representa un HEAD dinámico.
Git exige una excepción de ownership por pertenecer a Administradores: se usa `-c safe.directory` únicamente para el directorio exacto, sin modificar la configuración global. Los checkpoints anteriores se conservan; no se hace merge a `main`.

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

| Comprobación                    | Resultado / archivo                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Unitarios existentes            | 5 PASS, `npm.cmd run test:unit`                                                    |
| PostgreSQL/API U3               | 6 escenarios + suite PASS; `work/u3-integration.tap`                               |
| Regresión PostgreSQL Foundation | 17 escenarios + suite PASS; `work/u3-foundation-regression.tap`                    |
| E2E U3                          | 3 PASS; `work/u3-e2e-results.json`, `work/u3-playwright-report/`                   |
| Regresión E2E referencia        | 3 PASS; `work/u3-reference-regression/`                                            |
| Typecheck                       | PASS, raíz y web                                                                   |
| Lint                            | PASS                                                                               |
| Build                           | Next/OpenNext y API dry-run PASS; no despliegue                                    |
| Seguridad                       | Escáner de secretos cliente y límites de dominio PASS; no sustituye SAST/SCA       |
| Formato focalizado              | PASS para archivos modificados TS/TSX/CSS/JSON/Markdown                            |
| Formato global                  | PASS local y GitHub desde el checkpoint `ba4a6e5`; normalización previa conservada |

La integración prueba paginación, todos los filtros, orden, conteos, ausencia de email/teléfono en la proyección, own/sibling/cross-tenant, denegación Network/admin, delegación exacta, revocación, vistas privadas/equipo/compartidas, idempotencia concurrente, auditoría, validación HTTP y sesión revocada.

E2E: PostgreSQL → API → UI, restauración tras recarga de filtros/orden/columnas/densidad, fallos controlados sin datos de respaldo, sesión y CSRF. Los fallos HTTP inyectados pertenecen exclusivamente a pruebas de estados; el flujo funcional y las capturas usan PostgreSQL.

Capturas U3: `work/u3-visual/` contiene Light/Dark en 1440 y 390 px, cuatro idiomas en 390 px y configuración restaurada. Axe sin violaciones en las cuatro combinaciones theme/viewport. Se inspeccionaron capturas de tabla Light/Dark, móvil Dark, francés y filtros restaurados. No se declara Visual QA global del Prompt 02 PASS: U4–U6 aún requieren su propia evidencia.

La pasada inicial de regresión de referencia tuvo una interrupción del servidor compartido al terminar otra suite. Se repitió con servidor propio y sus tres pruebas pasaron. Los informes finales reemplazan los intentos fallidos de U3, no la evidencia canónica de Foundation.

## Archivos y revisión

Modificados: `packages/application/src/index.ts`, `packages/contracts/src/crm.ts`, `apps/api/src/app.ts`, `apps/web/app/reference-workspace.tsx`, `apps/web/app/styles.css`, `package.json`, `playwright.config.ts`, `tests/integration/foundation.test.ts`.

Nuevos: `packages/application/src/crm.ts`, `apps/web/app/use-crm-data.ts`, `apps/web/app/crm-catalog.ts`, `apps/web/app/api/crm/[...path]/route.ts`, `apps/web/app/crm/commercial/page.tsx`, `scripts/crm-dev.ts`, `tests/helpers/crm-fixtures.ts`, `tests/integration/crm.test.ts`, `tests/e2e/crm.config.ts`, `tests/e2e/crm.spec.ts`, la migración incremental y este informe.

El test Foundation sólo actualizó la cantidad esperada de migraciones de 3 a 5. Sus escenarios existentes no se rehicieron. El runner CRM separado evita ejecutar pruebas de sesión contra la referencia sin integración.

El inventario `u3-file-manifest.json` identifica el checkpoint de entrada estable, archivos funcionales, archivos de cierre y ubicaciones de evidencia; no intenta almacenar el hash del propio documento ni un HEAD autorreferencial. La implementación original se revisó con preimágenes; el cierre se revisa mediante diff contra el checkpoint de entrada. `apps/web/next-env.d.ts` es una salida regenerada por Next al alternar build/dev, no una edición manual.

## Uso local y continuidad

Desde el workspace oficial: `npm.cmd run dev:crm`. Abrir [CRM local](http://127.0.0.1:3101/crm/commercial) e introducir el código de sesión que imprime la terminal. No es una URL pública ni queda garantizada activa fuera del proceso local.

Cada arranque crea un laboratorio aislado de PostgreSQL en disco con 45 oportunidades sintéticas. Filas y vistas sobreviven a recargas y nuevas instancias del servicio dentro del laboratorio; no se reutiliza automáticamente la base entre arranques del laboratorio. La sesión dura una hora. Ningún dato real de cliente se importó.

Estado funcional: U1 PASS, U2 PASS, U3 PASS local y CI; U4 PARTIAL, U5 PARTIAL, U6 PARTIAL. U3 está listo para revisión, no para un merge automático ni para abrir producción; véase el registro CI siguiente.

Esta ejecución cierra exclusivamente U3. No inicia U4, U5, U6 ni Prompt 03. Prompt 02 completo y su Visual QA global siguen abiertos.

## Cierre CI U3

Baseline: [Foundation #12](https://github.com/Javariel14/RPTV2/actions/runs/34847434070) falló en el arranque del cluster restaurado; formato, lint, typecheck, unitarios, CRM integration, CodeQL y Gitleaks pasaron. El error original de `pg_ctl` no incluía `restored.log`, y el artifact sólo contenía un resumen.

Diagnóstico reproducido en [Foundation #13](https://github.com/Javariel14/RPTV2/actions/runs/34849296291), con el error interno conservado: `PANIC: could not open file "global/pg_control": Permission denied`. No fue un timeout, puerto ocupado ni snapshot tomado antes del shutdown: el servidor alcanzó la lectura del control file después del stop/extracción completados. La extracción en el runner elevado crea archivos cuyos ACL no dan acceso suficiente al proceso PostgreSQL restringido. [PostgreSQL 17 elimina Administrators/Power Users del token de ejecución](https://raw.githubusercontent.com/postgres/postgres/REL_17_STABLE/src/common/restricted_token.c), a diferencia del proceso que extrae el tar.

Corrección D1, sólo en el helper de test Windows: tras autenticar y extraer el backup, obtener el SID del usuario actual y conceder Modify heredable únicamente a ese SID sobre el target nuevo (`icacls /grant:r ... /T`). No se concede acceso a Everyone/Users ni se modifican el source cluster, directorios padres o ACL de producción. La salida no cero aborta; no se ocultan errores. Se conservan stop/start con espera, AES-GCM, rechazo de alteración, comparación de todas las tablas, RLS posterior y auditoría append-only. El log de arranque se incorpora a la excepción si el restore falla. [Sintaxis y alcance de icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls).

El job `verify` conserva `npm run verify`, supply-chain y los E2E Foundation. El job independiente `crm-e2e` ejecuta `npm run test:crm:e2e` con PostgreSQL sintético y servidor propios. Staging depende de ambos jobs y de SAST/secrets; no se habilita staging ni se despliega.

Artifacts con retención de 14 días, incluso al fallar: `foundation-evidence` incluye `work/u3-verify.log`, restore/resúmenes y SCA/SBOM; `u3-crm-evidence` incluye `work/u3-e2e-results.json`, `work/u3-playwright-report/`, `work/u3-visual/` y resultados de navegador. Sólo se conserva `restored.log` de PostgreSQL; nunca datos del cluster, backups cifrados, claves o credenciales. `work/` continúa ignorado por Git.

### Checkpoint validado

[Foundation #14 — SUCCESS](https://github.com/Javariel14/RPTV2/actions/runs/34849917345), código `bdcef8428039b3c657008d66196132f5bc3ad8c8`: `npm run verify` PASS (formato, lint, typecheck, 5 unitarios, security, 25 resultados de integración incluyendo las suites CRM/Foundation, build), supply-chain PASS, E2E Foundation 3/3, CRM E2E 3/3, CodeQL PASS y Gitleaks PASS. Cero skips de tests; el job opcional staging permanece deshabilitado por su gate preexistente.

Evidencia descargada y SHA-256 contrastado con Actions: [foundation-evidence](https://github.com/Javariel14/RPTV2/actions/runs/34849917345/artifacts/10349532920) y [u3-crm-evidence](https://github.com/Javariel14/RPTV2/actions/runs/34849917345/artifacts/10349637062). Este último conserva JSON (3 expected, 0 unexpected/skipped/flaky), HTML y 9 PNG. Se inspeccionó la captura Light 1440 del artifact remoto; el gate de imágenes/axe sigue acotado a U3, no certifica Visual QA global de Prompt 02.

El checkpoint anterior es evidencia inmutable del código corregido, no el HEAD actual. Las ediciones documentales posteriores deben conservar los checks verdes del [PR #6](https://github.com/Javariel14/RPTV2/pull/6/checks). La revisión completa del diff de cierre contra `ba4a6e5` incluye ambos helpers, workflow, lock/dependencias y documentos; no hay cambios funcionales U4–U6 ni artifacts generados versionados.

### Supply-chain

Las 3 high del baseline eran una cadena única: Wrangler 4.129.0 → Miniflare 5.20260903.0-alpha → sharp 0.35.2. [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) afecta sharp <0.35.4 por vulnerabilidades de libheif al procesar imágenes no confiables; no se trata de tres fallos independientes del CRM.

Actualización puntual y exacta a Wrangler 4.131.2 (MIT OR Apache-2.0, Node >=22, compatible con Node 24 y el peer existente de OpenNext). Su Miniflare 5.20260911.1-alpha usa sharp 0.35.4, compartido con Next. No se usaron `audit fix --force`, overrides ni actualizaciones generales. El lock conserva integridades y binarios multiplataforma; elimina la copia vulnerable duplicada de sharp.

`npm run supply-chain`: PASS, cero vulnerabilidades conocidas, SBOM generado, 631 entradas de inventario y 31 obligaciones de distribución. Riesgo residual: metadata SPDX no equivale a aprobación legal; siguen pendientes los avisos/licencias LGPL/MPL/fuentes antes de distribución. Miniflare sigue siendo prerelease como en el baseline; el build OpenNext advierte soporte Windows incompleto. No se acredita producción/PITR ni ausencia de vulnerabilidades desconocidas. Las guías Wrangler/Cloudflare limitaron la validación al build/dry-run sin despliegue.
