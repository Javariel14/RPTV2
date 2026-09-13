# Entornos y secretos

| Entorno    | Datos                                 | Identidad / BD                                                     | Estado                                   |
| ---------- | ------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Local      | Fixtures sintéticos                   | PostgreSQL 17.10 efímero loopback, JWT firmado de fixture en tests | Verificado                               |
| Test       | Fixtures nuevos por ejecución         | Runtime y migrator con claves aleatorias distintas                 | Reproducible; Windows runner configurado |
| Staging    | Solo sintéticos/minimizados aprobados | Supabase aislado + Hyperdrive propio                               | Cerrado; sin recursos creados            |
| Production | Requiere aprobación de datos reales   | Proveedor/cuentas/secrets propios; nunca compartir con staging     | Cerrado                                  |

Variables: RPT_ENV obligatorio al configurar despliegue; RPT_RELEASE_APPROVED debe ser true solo tras autorización; AUTH_ISSUER HTTPS fijado por operador. Sin las tres, API responde 503. HYPERDRIVE es binding, no NEXT_PUBLIC ni cadena en código. ID todo ceros y contraseña `placeholder` son marcadores no funcionales de config local, no recursos reales. No ejecutar deploy con marcadores.

Web es una referencia fixture independiente sin backend activado. No agregar datos reales hasta resolver identidad/consentimientos. No hay variables públicas de acceso privilegiado. `.env.example` documenta valores seguros; archivos .env/.dev.vars se ignoran.

Owners por función (personas pendientes de designación): Platform/SRE posee runtime Hyperdrive y backups; Security posee política/rotación; release maintainer usa credencial migrator temporal; Product Owner designa repo/proveedores/entornos; Legal/Privacy aprueba tratamientos. No inventar un owner humano ni aprobación.

Rotación: crear secreto de reemplazo de mínimo privilegio, probar staging y role-check, actualizar binding por canal autorizado, drenar conexiones, revocar anterior, registrar auditoría sin secreto. Ante exposición, revocación inmediata y revisión de sesiones/accesos; no basta ocultar la cadena. JWT key rotation requiere JWKS/provider revocation y una fuente autoritativa de sesiones, no cache local como única prueba.

Bootstrap local: Node 24.14.1/npm 11.11.0, `npm ci`, `npm run verify`, `npm run test:e2e`, `npm run supply-chain`. Tests descargan paquetes binarios públicos al instalar, pero no contratan ni despliegan. PostgreSQL nativo de tests requiere usuario no-root en Linux; workflow usa Windows. No usar la dependencia embedded beta como servidor productivo.
