# ADR-001 — Modular monolith y contratos Foundation

Status: accepted for local Foundation. Date: 2026-09-03.
Owners: JAVARIEL Corp (producto); implementación Codex; reviewer técnico/seguridad pendiente de designación.

Context: 16/18/26–38/42 exigen un solo dominio por responsabilidad, sin microservicios prematuros.
Decision: workspace npm, TypeScript strict, Next/React para web y Hono como HTTP
boundary. Domain no conoce vendors; application orquesta transacciones; persistence
es única entrada SQL parametrizada. Contratos Zod versionados, errores con code,
message_key, request_id y retryable. UUID opacos generados por librería.

Alternatives: DB CRUD desde cliente (rechazado: rompe boundary); servicios por
dominio desde inicio (coste operacional sin evidencia); reusar Expo legacy (superseded).
Consequences: workspace privado local reproducible con lockfile; no dependencia del legacy.
Security/Privacy: ningún cliente importa persistence/application ni secretos; fixtures no reales.
Data Migration: versiones expand-only iniciales; no datos legacy importados.
Rollback/Exit: revertir implementación local, conservar docs Prompt 00; sin cambios remotos.
Cost: ningún recurso cloud creado; Node/Postgres locales para pruebas.
Observability: señales allowlisted con request correlation; sin payload SQL/PII.
References: Decision Registry DR-014/018/022/026; 18,26,27,30,38,42; source-manifest Prompt 00.

Readiness remoto/CI/main protection no se infiere de este ADR.
