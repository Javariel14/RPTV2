# ADR-007 — Runtime Cloudflare comprobado sin despliegue

Estado: aceptado para build/preview local; remoto pendiente de aprobación.

Next 16.3.4 + OpenNext Cloudflare 1.20.6 + Wrangler 4.129.0, compat date 2026-09-03/nodejs_compat. Versiones y peer constraints consultados antes de instalar. Monorepo empaquetado con builder soportado; no next-on-pages ni export runtime=edge. Referencia dinámica sin datos remotos, sin cache tenant/PII ni bucket R2 creado. Self-reference y ASSETS locales. API utiliza Hyperdrive cuando haya binding aprobado; binding local placeholder no conecta a producción.

`npm run build` ejecuta OpenNext (que invoca Next con su output standalone y tracing del monorepo) y Worker API dry-run. No usar skipNextBuild después de un Next build regular: le faltan los artefactos standalone que exige el adapter; ese caso se detectó y corrigió en el pipeline. `npm run preview:cloudflare --workspace @rpt/web` ejecuta workerd local en 3102. Se verificaron HTTP 200, assets y UI en browser; API sin aprobación devuelve 503/no-store en workerd. No se hizo deploy/upload, ni se crearon recursos o costes.

La herramienta advierte soporte incompleto de Windows: preview local exitoso no acredita Linux CI, staging, carga, latencia ni compatibilidad en todas las rutas futuras. Publicación requiere prueba en runner Linux/WSL y Cloudflare staging autorizado. Las dependencias transitivas de build incluyen avisos deprecados; no se parchearon vendors ni se ocultaron advisories. Inventario/SBOM y audit acompañan la entrega.

Configuración conforme a [OpenNext Get Started](https://opennext.js.org/cloudflare/get-started). Mantener la separación entre `next dev` y `workerd preview`; ambos fueron usados. No activar R2/Queues/DO solo por completar una plantilla: se añaden al aparecer la necesidad real, con aislamiento y lifecycle definidos.
