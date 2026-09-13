# ADR-002 — Identity tenancy y autenticación

Status: proposed (deploy topology); accepted (local contract/invariants).
Date: 2026-09-03. Owners: JAVARIEL Corp + Security/Architecture owners pendientes.

Context: ERD-002 requiere UserAccounts independientes por tenant, mismo correo
permitido entre tenants, sin login global ni selector de organizaciones comerciales.
Supabase sigue siendo proveedor baseline, no se sustituye.

Decision: UserAccount se vincula mediante (trusted issuer, subject), nunca correo ni
user_metadata. API verifica firma/audience/issuer/exp/session_id/aal; DB vuelve a
comprobar cuenta, tenant, sesión activa y policy vigente dentro de cada transacción.
Permisos no se cachean en JWT. Revocar grant/cuenta/sesión niega la siguiente operación.
Headers tenant/role no autorizan. Scope y policy salen de DB, no de UI.

Production topology pendiente: un único realm Supabase con identidad global por
email no demuestra ERD-002. La interfaz admite realms aislados y fixtures con
emisores independientes, pero este ADR NO decide crear un proyecto Supabase por
tenant ni aprobar costes/operación de esa alternativa. No se han probado login,
recovery, OAuth ni alta del mismo correo contra Supabase real.

Alternatives pendientes de prueba: aislamiento de realms gestionados por tenant;
capacidad tenant-native del proveedor; diseño equivalente formalmente revisado.
No usar emails artificiales, contraseñas compartidas, service_role en cliente ni
editable user_metadata como workaround.

Consequences: backend verificable con firmas reales de prueba; provisioning/login
productivo fail-closed. No se declara Auth listo para Beta ni se inventan cuentas.
Security/Privacy: alto privilegio exige AAL2, cuenta técnica separada y sesiones
revocables; no bypass universal admin. Break-glass productivo no activado.
Data Migration: composite tenant foreign keys; sin migración de identidades legacy.
Rollback/Exit: deshabilitar adapter; conservar identificadores internos opacos.
Cost: pendiente antes de adoptar realms; cero cuentas/planes creados en esta ejecución.
Observability: auth_failure/permission_denied contadores, sin email/token/log raw.
References: 26 ERD-002,28,29,42; [JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys),
[Supabase changelog](https://supabase.com/changelog) consultados 2026-09-03.

Gate: decisión de deployment/Auth respaldada por pruebas login/recovery/OAuth y
revocación real antes de cuentas o datos reales. No es permiso para cambiar el stack.
