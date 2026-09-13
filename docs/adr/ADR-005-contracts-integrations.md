# ADR-005 — Contratos y adapters

Estado: aceptado Foundation; no developer API público.

/v1 y schemaVersion:1; Zod strict rechaza claves desconocidas. DTO explícito de Person no contiene email/teléfono. HTTP no exporta filas raw. 401 autenticación, 404 ausente/inaccesible con forma idéntica, 409 conflicto de versión/idempotencia, 422 validación, 503 dependencia. No revelar SQL ni existencia cross-tenant. Request id UUID generado por servidor, nunca confiar en valor aportado por cliente.

PATCH Person usa expectedVersion; POST activity exige Idempotency-Key. Savepoints preservan auditoría de denegaciones sin commit parcial. Máximo JSON 16 KiB; SQL timeout 10 s/conexión 5 s, sin reintento automático ciego de escrituras. Reintento 503 conserva clave/cuerpo; 409 requiere reconciliar, no inventar nueva clave para duplicar operación.

Interfaces ExternalSourceAdapter/HyCiteOfficialAdapter/InciteAdapter/DocuCiteAdapter/WhatsAppAdapter/CalendarAdapter/AIProvider/STTProvider viven en dominio sin SDKs. PendingSource produce estado explícito PENDING_OFFICIAL_ACCESS, no respuesta simulada exitosa. OAuth, webhooks, dedupe proveedor, refresh token vault, circuit-breakers y DLQ se implementarán al activar el adapter autorizado. No scraping privado ni credenciales personales.

Integraciones no llaman dominio por debajo de su autorización/consentimiento. AI/STT solo devuelven inference. Imports no heredan autoridad official. Registrar fuente/hashes y decidir por dominio, no por un ranking global de confianza genérico.
