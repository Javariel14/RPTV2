# Privacidad y recuperación

## Tratamientos mínimos

| Datos                         | Clase                 | Uso y límite                                      |
| ----------------------------- | --------------------- | ------------------------------------------------- |
| Person/display name/lifecycle | CONFIDENTIAL          | CRM sujeto a ownership/workspace/grant            |
| Email/teléfono                | RESTRICTED_PII        | Tabla aparte; read independiente; no logs         |
| Rango/facts oficiales         | OFFICIAL_COMPENSATION | Fuente autorizada verificada; AI no publica       |
| Audit/security                | SECURITY_AUDIT        | Append-only, acceso específico, sin payload raw   |
| Métricas operativas           | INTERNAL / objeto     | Evento temporal; Network solo agregado autorizado |
| Assets oficiales públicos     | PUBLIC                | SVG/tokens con provenance/checksums               |

ConsentRecord es historial de otorgar/retirar/denegar por propósito, modalidad, versión, idioma, canal y evidencia. No inferir consentimiento de una membresía o de usar la app. Rights request modela verificación, aprobación, retención legal y resultado. Purge exige actor autorizado + MFA + objeto delete PII + solicitud verificada/aprobada; legal hold activo lo bloquea. Tombstone conserva IDs/ledger/auditoría, elimina PII y bloquea nuevas actividades del objeto. No es un endpoint público de borrado.

Retention hooks: policy_version puede versionar políticas por tenant/market; fechas due_at permiten un worker futuro de derechos. No hay cron que borre datos automáticamente ni plazo jurídico inventado. Antes de datos reales: registro de tratamientos, base/propósito aprobado, plazos concretos, proveedores/subencargados/DPA, transferencias, solicitudes verificadas y responsable humano. No audio, mensajes o categorías sensibles reales en Foundation. No se afirma cumplimiento legal certificado.

## DR

Beta target RPO ≤15 minutos/RTO ≤4 horas; GA target ≤5 minutos/≤1 hora, pendientes de evidencia en volumen y proveedor. El test local solo acredita snapshot en frío con cero escrituras aceptadas durante parada y tiempo medido del laboratorio.

Producción propuesta: backups gestionados + PITR según plan contratado, cifrado con KMS/escrow, copias segregadas, retención compatible con privacy/legal hold; acceso restore temporal y auditado. Owner Platform/SRE y Security deben ser designados. No almacenar dumps/keys en Git ni subir el clúster de test como artifact de CI.

Restore: cerrar tráfico → preservar evidencia incidente → escoger punto consistente → recuperar schema/datos/secrets mediante canal autorizado → comprobar versión/hash de migraciones → aplicar forward-fix pendiente → conteos/hashes/RLS/ledger/PII → smoke funcional → autorización de reapertura. Ensayar periódicamente en entorno aislado sin clonar PII a desarrollo. El test actual restaura todo el clúster, verifica integridad AES-GCM y rechaza alteración; resultados en `work/restore-evidence.json`.
