# Matriz de evidencia — Prompt 01

Fixtures aislados en PostgreSQL real 17.10, con conexiones runtime/migrator distintas. No se usan mocks de RLS. `tests/integration/foundation.test.ts` ejecuta los escenarios; `scripts/security-check.ts` complementa source y bundle de cliente.

| Requisito              | Evidencia ejecutable                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1 A no lee B           | SELECT runtime sin filtro de tenant devuelve cero para Person y PII B                                                      |
| 2 A no muta B          | UPDATE devuelve cero; INSERT cross-tenant rechaza; B conserva nombre                                                       |
| 3 Sin enumeración      | API B y UUID inexistente: mismo 404/code/retryable; requestId distinto por solicitud                                       |
| 4 Network sin CRM      | Estadística calls autorizada; cero Person/PII/membership/ledger raw                                                        |
| 5 Revocación           | Grant read válido → revocado → deny; grantor pierde rol → grantee deny                                                     |
| 6 Reparent             | Historia before/after, ciclo rechazado, CRM no abierto; concurrentes inversos solo uno confirma                            |
| 7 Server auth          | JWT firmado válido; sin token/manipulado 401; user_metadata/x-tenant-id no cambia tenant; rol llamado admin no concede CRM |
| 8 Credenciales cliente | Scanner source y JS generado; no import persistence/application ni credenciales privilegiadas                              |
| 9 Audit                | Cambios y denegaciones persistidos; hashes antes/después; UPDATE/TRUNCATE rechazados                                       |
| 10 Reversal            | Original intacto + evento negativo; contexto incorrecto y segunda reversión rechazados                                     |
| 11 Migración           | Tres versiones como migrator; upgrade de esquema poblado preserva Person y permisos                                        |
| 12 Forward-fix         | Runbook + v2/v3 incrementales; datos/historial preservados; no downgrade destructivo                                       |
| 13 Retry               | Cuatro comandos simultáneos con misma clave → un ID/evento; otro cuerpo → 409                                              |
| 14 AI                  | Inference no puede reemplazar observación/rango oficial; rankKey debe coincidir con el fact autorizado                     |

Extras: aislamiento de roles, RLS en todas las tablas sensibles, membresías sin solapamiento, privacy purge bloqueado por hold, tombstone/PII, imposibilidad de nuevas actividades después de erasure, sesión revocada pese a JWT firmado no expirado, invalidación por versión de política, errores seguros, telemetría sin PII, backup cifrado alterado rechazado y restore completo por fingerprints.

Límites: estas pruebas no acreditan pentest externo, UI autenticada end-to-end, MFA real del proveedor, logout Supabase propagado a la sesión de aplicación, WORM frente a DBA malicioso ni rendimiento/carga en producción. No introducir datos reales para completar esos tests.
