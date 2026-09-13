# Prompt 01 — Foundation, Arquitectura, Datos y Seguridad — RPT

Entrega: 3 de septiembre de 2026, America/Guayaquil. Verificación conjunta terminada: 2026-09-04 04:22 UTC.

## A. Foundation Summary

Foundation técnica local implementada y validada en `C:\Proyectos JAVARIEL\RoyalPerformanceTracker`. La ejecución conjunta pasó sus nueve pasos: formato, lint, tipos, unitarias, seguridad local, PostgreSQL, builds, dependencias y E2E.

No es únicamente una maqueta: hay API server-side, transacciones, RLS, constraints, auditoría, ledger y restauración contra PostgreSQL real. La UI sigue siendo la referencia con fixtures exigida por DR-028; no se conectó a clientes reales ni se expandió el CRM completo.

Actualización del 4 de septiembre de 2026: el Product Owner confirmó este workspace como ruta oficial. La revalidación local terminó a las 14:52 UTC con los nueve checks aprobados. El cierre local para Prompt 02 queda aprobado; la integración GitHub se conserva como tarea externa separada. No se declara producción ni Beta real listas.

## B. Repository Changes

Workspace npm con lockfile, TypeScript strict, Next.js 16.3.4/React 19.2.8, API Hono y paquetes separados. Se preservaron los cuatro archivos del Prompt 00. No existía `.git`; no se creó, clonó ni sustituyó el legacy.

Toolchain probado: Node 24.14.1, npm 11.11.0, PostgreSQL nativo 17.10 para tests, Supabase CLI 2.116.0, Wrangler 4.129.0 y OpenNext Cloudflare 1.20.6. El binario embedded es exclusivamente de test, no el servidor productivo.

## C. Architecture Implemented

Modular monolith con domain, application, contracts, policy, persistence, telemetry, UI/tokens y fixtures. Dominio sin SDKs de proveedores. HTTP valida DTOs v1 y nunca devuelve filas raw ni errores SQL.

Person y UserAccount son entidades distintas. Cada cuenta pertenece a un tenant; issuer+subject autenticado resuelve esa cuenta sin confiar en email, user_metadata, rol o tenant enviados por cliente. No se construyó un login comercial global con selector de tenants.

Referencia visual: assets oficiales contrastados por SHA-256, temas Light/Dark/System, shell 248/72, drawer 460, Component Lab, tabla/Kanban, filtros, ordenación, vistas, selección y paginación de 20 filas con 1000 fixtures. Idiomas ES/EN/FR/PT, estados de error, teclado y reduced motion. Las habilidades de Drive, Next.js, Cloudflare, Supabase y verificación de browser guiaron la lectura canónica, los límites de integración y las comprobaciones; no autorizaron despliegues.

## D. Database / Migrations

Tres migraciones versionadas aplicadas por un usuario migrator separado:

1. `20260904031536_foundation.sql`: modelo, invariantes, RLS, auditoría y ledger.
2. `20260904034025_foundation_service_commands.sql`: separación de lectura/escritura, grants, estadísticas, actividad idempotente y privacy purge.
3. `20260904035430_foundation_provenance_binding.sql`: vínculo rankKey/fact oficial, bloqueo de acceso a Person borrada y auditoría de configuración tenant.

30 tablas sensibles entre authz/rpt, todas con RLS. PK/FK tenant-aware; intervalos temporales sin solapamiento; cambios de parent por cierre y nueva fila; detección de ciclos incluso concurrentes. Rango oficial global, no por mercado. Modelos de políticas versionadas, flags, consentimiento, solicitudes de derechos y legal hold.

Se probó tanto instalación desde cero como upgrade de un esquema poblado, conservando Person y sus permisos. No hubo migraciones remotas ni cambios manuales en producción.

## E. Tenant Isolation Evidence

Conexiones runtime reales para tenants A/B: SELECT cross-tenant devuelve cero; UPDATE no cambia filas; INSERT cruzado se rechaza. B conserva sus datos. IDs ajenos y desconocidos producen la misma respuesta 404/code/retryable; el requestId se genera por solicitud.

La suite no sustituye RLS por filtros de UI. El runtime no puede asumir owner ni leer authz.user_account. La credencial runtime sigue siendo una frontera de confianza del servidor: no está destinada al navegador ni a consultas arbitrarias del usuario.

## F. Permission / RLS Evidence

Capacidad vigente + verbo + campo + ownership/workspace/objeto + sesión/contexto + grant + policy version. No hay bypass por llamarse admin. PII en tabla separada; read, export, listen, download y otros verbos no se confunden.

Grant válido permite lectura concreta; al revocarlo deja de permitirla. Si el grantor pierde su rol, su delegación también deja de autorizar. No se puede redelegar autoridad recibida. Network solo devuelve estadísticas autorizadas; no Person/PII, membresías con IDs ni ledger raw. Reparent no abre CRM histórico. Sales queda suprimido del agregado hasta aprobar su política de cohortes.

La sesión de aplicación revocada bloquea un JWT de fixture todavía válido y firmado. Firma y claims AAL se probaron; MFA/login/recovery/logout del proveedor real aún no.

## G. Audit / Provenance / Event Ledger

AuditEvent, MetricEventLedger y observaciones relevantes son append-only. Cambios y denegaciones generan evidencia; savepoints permiten conservar el audit de un intento fallido sin confirmar mutaciones parciales. El audit guarda digest, no payloads PII completos.

Ledger conserva contexto del evento. Reversal añade una fila negativa y conserva el original; contexto equivocado y reversión duplicada se rechazan. Cuatro reintentos concurrentes de actividad con la misma clave producen un evento; cambiar el cuerpo produce 409.

Provenance incluye fuente, subject, external ID, timestamps, autoridad, hash, sync run y reconciliación. AI solo puede registrar inference. Un rango exige fact official autorizado/verificado, mismo grupo y rankKey coincidente. Los facts oficiales probados son fixtures; no se obtuvo información oficial de Hy Cite.

## H. CI/CD and Observability

Workflow con checks locales, CodeQL, npm audit, gitleaks, licencias/SBOM y E2E/axe; Actions fijadas a SHA, permisos limitados, actualizaciones de dependencias y plantilla PR. No CI remoto ejecutado ni branch protection verificada por faltar repositorio designado. Staging check permanece desactivado hasta configuración/aprobación; no se presenta como PASS.

OpenTelemetry SDK real produce spans, métricas y logs permitidos sin body, token, email ni tenant en etiquetas. Hay requestId/traceId, duración y categorías de error. Exportación/alertas remotas y SLO quedan pendientes de proveedor/owner.

Build Next/OpenNext PASS; API Worker dry-run PASS. Dry-run adicional web: 839.27 KiB gzip; API: 240.85 KiB gzip. Workerd local mostró referencia HTTP 200 y API no aprobada HTTP 503/no-store. Cero deployments/uploads/recursos contratados.

## I. Tests Executed

| Comprobación                         | Resultado                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Formato / lint / strict typecheck    | PASS                                                                                   |
| Unitarias                            | 5 PASS                                                                                 |
| PostgreSQL                           | 17 escenarios PASS; Node reporta 18 incluyendo el contenedor                           |
| 14 controles obligatorios del prompt | Cubiertos; matriz en docs/security/permission-test-matrix.md                           |
| E2E browser                          | 3 PASS                                                                                 |
| Visual / accesibilidad               | 7 anchos × 2 temas; 4 idiomas; drawers; 21 capturas; cero violaciones axe en la matriz |
| System / teclado / foco / motion     | PASS; reflujo equivalente a zoom 200% probado a 640 CSS px                             |
| Source + bundle cliente              | PASS; 10 archivos JS compilados escaneados                                             |
| npm audit                            | 0 vulnerabilidades reportadas                                                          |
| Licencias/SBOM                       | 658 entradas; ninguna denegada por la política; 45 con obligaciones de distribución    |
| Restore                              | PASS: 30 tablas comparadas por conteo/hash; RLS y audit vueltos a verificar            |

Restore físico de clúster detenido, gzip/AES-256-GCM y directorio nuevo. Alterar un byte se rechaza antes de extraer. Recuperación medida en este laboratorio: 21.366 s; no es una promesa RTO productiva. No acredita PITR gestionado ni recuperación con carga. Objetivos canónicos permanecen Beta RPO ≤15 min/RTO ≤4 h, GA ≤5 min/≤1 h, pendientes de ensayo operativo.

## J. Failing Tests / Risks

Sin fallos en la ejecución final conjunta. Se corrigieron contraste, retorno de foco de dialogs y el orden de build OpenNext. La primera simulación con CSS zoom no representaba zoom de navegador; se reemplazó por prueba explícita de viewport/reflujo equivalente, sin afirmar prueba física de zoom. El registry de npm devolvió un 503 transitorio; el análisis final terminó correctamente, sin conservar cookies de respuestas fallidas.

Riesgos/gates pendientes: Auth Supabase real y su fuente autoritativa de sesiones; topología de cuentas independientes por tenant; scopes/credenciales reales de Hyperdrive; Linux/WSL y staging (OpenNext advierte soporte incompleto de Windows); rate limiting/WAF, CSP de rutas autenticadas, pentest, alertas/retención remota, backup/PITR/KMS y restore en otro entorno. No son funcionalidades productivas simuladas como completas.

Las licencias LGPL/MPL/OFL/CC-BY y avisos de binarios nativos requieren obligaciones/revisión antes de distribución. npm audit no es un análisis de todos los binarios ni aprobación legal. No se usaron PII, audio o credenciales personales reales.

## K. ADR Created or Updated

ADR-001 boundaries; ADR-002 identity tenancy/Auth; ADR-003 persistence/RLS; ADR-004 audit/provenance/ledger; ADR-005 contratos/adapters; ADR-006 observabilidad/recovery/CI; ADR-007 compatibilidad Cloudflare. Siete ADR, más contratos, matriz de pruebas de control y runbooks de entornos, migraciones, privacidad y restore.

## L. D1 Decisions

npm workspaces/lockfile; npm.cmd en Windows; fixtures sintéticos limitados; PostgreSQL efímero en loopback; claves aleatorias por test; salidas temporales ignoradas; scripts repetibles; artefactos de evidencia sin clústeres, dumps o secretos. No se actualizaron memorias del usuario.

## M. D2 Decisions

Separación de PII, runtime/migrator y funciones SECURITY DEFINER por allowlist; transacciones y savepoints para decisiones auditadas; no cache de autorización; ledger append-only; SQL explícito con constraints; adapters pendientes, no scraping; restore físico cifrado de laboratorio; OpenNext para verificar Cloudflare sin crear servicios innecesarios.

ADR-002 conserva propuesta abierta para la topología Auth real: no se decide ni contrata un proyecto Supabase por tenant. La fuente canónica sigue prevaleciendo sobre alternativas técnicas.

## N. D3 Blockers

**PENDING_REMOTE_REPOSITORY_INTEGRATION**, heredado del Prompt 00 y reclasificado el 4 de septiembre: el workspace oficial está confirmado. No bloquea el vertical slice local con fixtures según Prompt 01 §28 (repo/workspace reproducible y CI skeleton). Owner del destino remoto: Product Owner. GitHub, historial, PR y protección de rama siguen sin verificar; no se inventa un destino ni se modifica el legacy. El informe original entregado conserva el estado histórico anterior.

No se bloqueó la implementación local por cuentas externas aún no contratadas. Auth productivo, acceso oficial a fuentes, legal/PII, secrets/owners y DR gestionado siguen cerrados antes de datos reales. La lectura documental no es autorización de cumplimiento ni contratación.

## O. Files Changed

Aplicaciones web/API; nueve paquetes compartidos; tres migraciones; bootstrap; tests y scripts; CI y configuración; siete ADR y documentación. El inventario exacto con SHA-256 está en `Evidencias/source-sha256.json` del ZIP. El paquete excluye node_modules, clústeres PostgreSQL, claves, dumps y carpetas temporales.

Evidencia entregada: logs de los nueve checks; verification/database/restore/runtime JSON; npm audit; inventario de licencias; SBOM CycloneDX; resultados E2E y 21 screenshots. El código fuente con lockfile permite reconstruir los artifacts; no se confunde un build local con un despliegue.

## P. Commits / PR

Ninguno. Workspace sin Git; cero push, PR o modificaciones remotas. El repositorio legacy no se reutilizó como destino sin confirmación. Los servidores temporales de prueba se cierran al terminar; la referencia se vuelve a iniciar con `npm.cmd run dev`.

## Q. Foundation Readiness

Base técnica local revalidada: PASS. Se corrigió únicamente la exclusión de bundles generados en directorios `work` anidados del lint. Los nueve checks volvieron a pasar, incluyendo 5 unitarias, 17 escenarios PostgreSQL (18 con el contenedor) y 3 E2E. Evidencia de entrada preservada en `docs/governance/prompt-02/foundation-entry-evidence.json`.

Alcance de readiness: desarrollo local del Prompt 02 con fixtures ficticios, PostgreSQL real y test doubles explícitos. No habilita Auth productivo, datos reales, fuentes oficiales, publicación ni despliegue. Los gates externos siguen vigentes y documentados.

NEXT_PROMPT = 02 — CRM, UX y Vertical Slice — RPT

FOUNDATION_READY_FOR_VERTICAL_SLICE = TRUE
