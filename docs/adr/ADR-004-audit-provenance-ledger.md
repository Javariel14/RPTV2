# ADR-004 — Auditoría, autoridad y ledger

Estado: aceptado Foundation.

AuditEvent y MetricEventLedger son append-only con triggers contra UPDATE/DELETE/TRUNCATE. Auditoría de cambios y decisiones registra tenant, actor, objeto/scope, política, request, timestamp y resultado. Denegaciones del servicio se confirman mediante savepoint para que el rollback de una mutación fallida no borre la evidencia. Fallos previos a identidad se registran en telemetría sin inventar tenant. Bootstrap privilegiado se distingue con reason operator_bootstrap; requiere trazabilidad humana externa del operador.

Audit no almacena payloads sensibles: before/after son digest SHA-256 de fila. Esto no es almacenamiento WORM frente a un DBA malicioso ni sustituye archivo protegido/retención; esas garantías son gates operativos antes de datos reales.

Ledger guarda contexto al evento, no re-resuelve membresía actual durante reconstrucción. Reversal es nuevo evento con referencia al original, contexto coincidente y signo inverso. Solo una reversión por original. API Foundation admite actividad RPT_USER no oficial; sales/compensación no se crean por ese endpoint. Clave idempotente tenant+operación, hash canónico, lock transaccional, actor y reautorización en cada retry.

SourceObservation es inmutable, con fuente, subject, external_id, hash, timestamps, nivel de autoridad y contexto de ejecución. ReconciliationCase añade decisiones, nunca sobrescribe la observación. AI=inference obligatoriamente. OfficialRankAssignment exige observación official verificada/autorizada, grupo y rankKey coincidentes; rango global, no por market. Integraciones externas siguen PENDING_OFFICIAL_ACCESS: las inserciones official probadas son fixtures bajo un actor explícitamente autorizado, no datos obtenidos de Hy Cite.

Las correcciones no destructivas se migran hacia delante; v3 agrega facts normalizados conservando observaciones anteriores. Observaciones históricas sin rankKey no habilitan nuevos rangos por defecto.
