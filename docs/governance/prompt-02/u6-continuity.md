# U6 — Flujo vertical y Visual QA local

## Verificado y corregido

- Flujo persistente: Advisor/session → Person → Opportunity → Appointment → Demo → Quote → Order → reconciliación manual simulada → `won_simulated` → Delivery → Curation.
- El boundary se mantiene explícito: la reconciliación local no crea aprobación, venta ni MetricEvent oficial; el resultado observable persiste en etapa, pedido e historial/provenance.
- DataGrid/List, FilterBar, Saved View, Kanban y Drawer se recorren en una sola prueba U6.
- Se preservan autorización server-side, RLS, tenant/BOLA, revocación, expectedVersion, idempotencia, auditoría y límites PII cubiertos por la regresión CRM/integración existente.
- Corrección U6: si una mutación mueve la tarjeta entre columnas mientras el Drawer está abierto, el cierre espera de forma acotada al control equivalente y restaura allí el foco. No roba foco si el usuario ya lo movió.
- Sin cambios de reglas, backend, contratos, migraciones, dependencias ni integraciones oficiales.

## Pruebas y evidencia local

- U6 focalizado: 1/1 PASS.
- Matriz visual representativa bajo `work/u6-visual/`: desktop Light/ES/List; desktop wide Dark/EN/Kanban+Drawer; mobile System/FR/flujo; mobile Dark/PT/forbidden.
- Sin overflow horizontal, PII en forbidden, permission-as-empty, contenido crítico cortado, card soup ni KPI wall; axe sin violaciones en los cuatro estados probados.
- `test:crm:e2e`: 12/12 PASS; `npm run verify`: PASS con 7/7 unitarios, 33/33 integraciones, seguridad y build; typecheck, lint y diff: PASS.

## Blockers y estado

- Blockers: ninguno.
- Estado: `PASS_LOCAL_READY_FOR_REVIEW`.
- Sin commit, push, PR, CI remoto, merge ni Prompt 03.

## Cierre remoto de Prompt 02

- PR #12 de U6 mergeado correctamente a `main`.
- GitHub Actions Foundation #25: PASS.
- `verify`: PASS.
- CRM E2E incluyendo U6: PASS.
- CodeQL/SAST: PASS.
- Gitleaks/secrets: PASS.
- Supply-chain: PASS.
- `staging-readiness`: no aplica todavía y permanece fuera del gate actual.
- U1–U6 están integrados en `main`.
- No existen blockers críticos pendientes para el CRM Vertical Slice.

`CRM_VERTICAL_SLICE_VISUAL_QA = PASS`

`NEXT_PROMPT = 03 — Expansión Funcional, IA, Integraciones y Beta — RPT`
