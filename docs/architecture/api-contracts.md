# Contratos Foundation v1

Todos los endpoints privados exigen Bearer JWT ES256/RS256 con issuer/audience aprobados y sesión vigente en BD. Tenant no se acepta del payload, URL ni cabeceras. JSON strict/schemaVersion:1. UI referencia no consume aún estos endpoints; Prompt 02 construirá esa integración tras readiness.

| Método/ruta                           | Entrada                                                                                                          | Requisito                                      | Salida                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| GET /health                           | —                                                                                                                | Infra/API compuesto                            | Estado foundation, realDataEnabled:false      |
| GET /v1/persons/:id                   | UUID                                                                                                             | Person read CONFIDENTIAL                       | id/displayName/lifecycle/version              |
| PATCH /v1/persons/:id                 | displayName, expectedVersion, schemaVersion                                                                      | Person update CONFIDENTIAL                     | DTO con versión siguiente                     |
| POST /v1/activities                   | subjectId, registrationId, marketId, metric, value, occurredAt, unit, reversalOf, schemaVersion; Idempotency-Key | metric create + Person update                  | event id; idempotente                         |
| GET /v1/network/:id/statistics?at=ISO | Ancestor registration + fecha                                                                                    | network statistics + StatisticalScope vigente  | metric/total; sin Person/PII; sales suprimido |
| POST /v1/grants                       | objectId/granteeId/verb/field/until/reason/schemaVersion                                                         | Share y verbo directos actuales, grantee capaz | grant id                                      |
| DELETE /v1/grants/:id                 | UUID                                                                                                             | Grantor actual de ese grant, sesión vigente    | revoked:true                                  |

Body máximo 16 KiB. No API de creación de cuenta, bootstrap tenant, export, audio, AI u official ingestion. La creación base de Person tiene constraints/RLS probados; flujo comercial completo y dedup de UI son Prompt 02.

Respuesta error: `{schemaVersion:1,error:{code,requestId,retryable}}`. 401 UNAUTHENTICATED; 404 NOT_FOUND tanto inexistente como inaccesible; 409 CONFLICT; 422 INVALID_REQUEST; 503 UNAVAILABLE. No exponer filas PG, exception.message ni stack. POST activity acepta solo actividades no oficiales; sales y overrides de autoridad son rechazados por contrato.

429/rate-limit visual está en referencia; rate limiting server/WAF/Turnstile por presupuesto y contexto es gate pendiente antes de exponer API a Internet. No hay endpoint público de enumeración ni carga masiva en esta fase.
