# Royal Performance Tracker — Foundation

Implementación local del Prompt 01 en la ruta oficial. Modular monolith TypeScript, PostgreSQL/RLS, referencia Next.js con fixtures y API Worker cerrada por defecto. No es el CRM completo ni una publicación productiva.

## Ejecutar

Requiere Node 24.14.1, npm 11.11.0 y Windows para el camino probado de PostgreSQL nativo.

```powershell
npm.cmd ci
npm.cmd run verify
npm.cmd run supply-chain
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run dev
```

Referencia local: http://127.0.0.1:3101. Todo contacto/actividad es ficticio; filtros/vistas/actividad no se guardan en producción. Tests de seguridad usan PostgreSQL real separado con claves efímeras y JWT firmado; no requieren Supabase remoto.

## Mapa

- apps/web: tokens/themes, shell, Component Lab, una referencia CRM.
- apps/api: Hono, auth y composición server-side; deploy no incluido.
- packages: domain, contracts, policy, application, persistence, telemetry, UI y fixtures.
- supabase/migrations: historial incremental con constraints/RLS/funciones.
- infrastructure/bootstrap.sql: roles privilegiados del operador, separado del runtime.
- docs/adr, docs/architecture, docs/runbooks: límites, contratos, decisiones y gates.
- .github/workflows: CI reproducible definido; no ejecutado remotamente todavía.

## No omitir

Repositorio oficial pendiente de designación; no .git, commits, PR, push, deploy ni recursos externos creados. Auth Supabase real, session lifecycle/MFA, legal/PII, PITR gestionado, secrets/owners, branch protection y staging siguen sujetos a aprobación y pruebas. Los informes distinguen baseline local de readiness para la siguiente fase.

No subir work/ (clústeres sintéticos, archivos efímeros) ni secretos. Artefactos de evidencia permitidos son JSON resumidos, SBOM y screenshots de fixtures. Nunca copiar producción a lower environments sin tratamiento aprobado.
