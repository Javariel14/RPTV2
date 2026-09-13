# ADR-006 — Observabilidad, recovery y pipeline

Estado: baseline local aceptado; promoción remota pendiente.

OpenTelemetry SDK real, no solo API no-op: TracerProvider/SpanProcessor y MeterProvider con reader por demanda. Logs JSON por allowlist, latencia/count/failures de cardinalidad limitada, traceId/requestId; sin raw URL, SQL, body, token, email, tenant o nombre humano. Traces y métricas se verifican en tests. Worker usa waitUntil para flush/shutdown fuera de la respuesta. Exportador OTLP remoto, alertas/SLO, DB-specific spans, replay de DLQ y retención del proveedor están pendientes; no hay queues en esta fase. Emitir migration y restore evidence no equivale a alerta operativa configurada.

Referencia de implementación SDK: [OpenTelemetry JS](https://opentelemetry.io/docs/languages/js/) y [guía de actualización 2.x](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md).

Recovery local: backup físico del clúster completo detenido, gzip y AES-256-GCM. Autenticar antes de extraer. Restaurar en directorio nuevo con PostgreSQL idéntico; comparar hashes/conteos de todas las tablas, auditar invariantes y RLS. Test modifica un byte y comprueba rechazo. La clave efímera no se guarda: el artifact de test queda intencionalmente irrecuperable fuera del proceso; producción necesita escrow/KMS con owner y restauración en otro entorno. Procedimiento conforme a [backup filesystem de PostgreSQL](https://www.postgresql.org/docs/17/backup-file.html). No es PITR gestionado ni acredita RPO/RTO con carga.

CI define format/lint/types/unit/build/integration/migrations/RLS/recovery, CodeQL, npm audit, gitleaks, licencias/SBOM y E2E/axe. Actions fijadas a SHA verificado; permisos por job, no checkout de PR con secretos privilegiados ni auto-deploy. CI no ejecutado remotamente sin repositorio designado. Staging-readiness solo informa el bloqueo, no cuenta como staging PASS. Firma, DAST remoto y branch protection deben verificarse antes de promoción.
