# U5 — Responsive, estados, accesibilidad, temas e i18n

## Checkpoint de entrada

Rama `feature/u5-crm-responsive-a11y-i18n`, creada desde `ccd1afc3eb2e837d9bdb9915c9782a629175a701`: merge del PR #10 de U4 en `main`. Al comenzar, HEAD, `main` y `origin/main` coincidían y el working tree estaba limpio. U1–U4 se conservaron sin rehacer Foundation, contratos, persistencia ni reglas CRM.

## Plan y fuentes canónicas

- Goal: cerrar responsive, estados UX, WCAG 2.2 AA, ES/EN/FR/PT y Light/Dark/System sobre el CRM persistente U3/U4.
- Scope: DataGrid/lista, Kanban, Drawer/Sheet, acciones, estados, componentes mínimos, pruebas, evidencia y CI.
- Non-goals: reglas o comandos CRM nuevos, drag/drop, U6, Prompt 03, datos reales, deploy y merge a `main`.
- Acceptance: breakpoints canónicos sin overflow; navegación y foco completos; estados sin fixtures; cuatro locales y tres modos de tema; axe sin violaciones en la matriz; regresiones U3/U4 verdes.

Se aplicó progressive disclosure desde `AGENTS.md`, `CONTEXT_ROUTER.md`, `apps/web/AGENTS.md`, continuidad/manifiesto U4 y las fuentes canónicas `43/02`, `43/03`, `43/04`, `43/05`, `43/07`; `43/06` se consultó para reduced motion y microcopy. También se usó la documentación local de Next para límites client/server. No se leyó toda la planificación ni se modificaron dominios ajenos.

## Implementación

- Responsive: matriz real `320/390/768/1024/1280/1440/1728`; lista action-first en móvil, tabla en desktop, Kanban y filtros sin overflow horizontal. Las Saved Views largas se envuelven en móvil, incluidos estados persistidos por U4.
- Drawer/Sheet: 460 px en desktop y ancho completo de 390 px en móvil; cuerpo con scroll contenido. El diálogo captura Tab/Shift+Tab, inicia en un control visible, cierra con Escape y devuelve el foco al disparador.
- Semántica: caption sólo visualmente oculto, `scope="col"` en encabezados, grupos y estados con nombres accesibles, títulos de panel únicos y `aria-live` para loading/Kanban.
- Estados: skeleton estructural, vacío persistente, sin resultados, forbidden, not found indistinguible, throttled, unavailable, success/conflict/validation ya provistos por U4 y datos limitados sin PII. Ningún error vuelve a fixtures.
- i18n: copy de estados, navegación, acciones, Kanban, Drawer y formularios verificado en ES/EN/FR/PT. El vacío real se distingue de un filtro sin resultados. Locale inválido conserva el fallback controlado existente.
- Themes: tokens existentes en Light/Dark/System; overlays, Drawer, tabla, Kanban, formularios, focus y reduced motion sin colores nuevos arbitrarios.
- CI: el gate CRM incluye U5 y conserva U3/U4; el runner Foundation excluye explícitamente todos los specs CRM. Actions publica `work/u5-e2e-results.json` y `work/u5-visual/` junto al reporte HTML combinado existente, sin versionar artifacts.
- No se añadieron dependencias, migraciones, endpoints, permisos ni comandos CRM.

## Validación y evidencia

Estado: **PASS local / READY FOR PR** en el checkpoint estable `u5-local-2026-09-20`, sobre el base commit `ccd1afc3eb2e837d9bdb9915c9782a629175a701`. El nombre es un identificador de evidencia, no un HEAD autorreferencial. GitHub Actions todavía debe ejecutar esta rama mediante el PR; no se afirma validación remota inexistente.

| Gate                             | Resultado local                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| format:check, lint, typecheck    | PASS                                                                                    |
| test:unit                        | 7/7 PASS                                                                                |
| security                         | PASS; secretos/tokens/private keys/client boundary                                      |
| test:integration                 | 33/33 PASS; incluye restore cifrado, RLS, BOLA, revocación, concurrencia e idempotencia |
| build                            | PASS Next/OpenNext + API Wrangler dry-run; sin deploy                                   |
| supply-chain                     | PASS; 631 paquetes, 0 high/critical conocidas, SBOM y licencias                         |
| test:e2e Foundation              | 3/3 PASS                                                                                |
| test:crm:e2e U3 + U4 + U5        | 11/11 PASS, 0 skip/retry; U5 4/4                                                        |
| axe                              | 0 violaciones en la matriz U5 probada                                                   |
| git diff --check / diff completo | PASS / revisado                                                                         |

Evidencia local ignorada por Git:

- `work/u5-e2e-results.json`: resumen U5 4/4 y `suiteStatus: passed`.
- `work/u5-visual/`: 17 capturas inspeccionadas de lista/Kanban/Drawer, desktop/mobile, Light/Dark/System, ES/EN/FR/PT, vacío, loading, forbidden, unavailable y detalle limitado.
- `work/u3-e2e-results.json` y `work/u3-playwright-report/`: resultado conjunto U3+U4+U5 y reporte HTML.
- `work/npm-audit.json`, `work/sbom.cdx.json`, `work/license-report.json`, `work/database-test-summary.json` y `work/restore-evidence.json`: evidencia de supply-chain e integración.

La evidencia visual confirma el slice U5 probado; no certifica Visual QA global de U6, staging o producción. No hay bloqueos de implementación. Quedan como verificación externa el run de GitHub Actions/CodeQL/Gitleaks al abrir el PR.

U6 y Prompt 03 no se iniciaron; no se hizo merge a `main`.
