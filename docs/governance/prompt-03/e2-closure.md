# E2 closure — Agenda / Tasks + Field Sales

## Estado

- E2A PASS: Agenda/Tasks persistentes, proyección read-only de actividades Commercial y Recruiting, reminders internos, recurrencia finita, tiempo IANA/DST, audit e idempotencia.
- E2B PASS: `/agenda` con Today/Day/Week/List, detalle, confirmación, reschedule, tareas, filtros y UX responsive/accesible.
- E2C PASS: Visit independiente, vínculo opcional a una cita autorizada, check-in/out, cancel/no-show, evidencia de ubicación opcional y restringida.
- E2D PASS: `/field` con lista, filtros, Drawer, creación/edición permitida, acciones y opt-in explícito de ubicación.

## Gates locales y Visual QA

- `npm run verify` PASS una vez en este cierre: formato, lint, typecheck, 26 unitarios, security local, 86 integraciones PostgreSQL/Foundation/E1/E2 y build web/API.
- Agenda E2E 5/5 PASS; Field E2E 7/7 PASS. Incluyen persistencia, reschedule/reminders, recurrence, estados forbidden/conflict, check-in/out, rechazo opcional de ubicación, móvil 390 y axe sin critical/serious en la matriz representativa.
- Capturas revisadas: `work/e2b-visual/` y `work/e2d-visual/` (no versionadas): desktop Light ES, desktop wide Dark EN, mobile System FR, mobile Dark PT, forbidden, reschedule/confirmation, check-in/out y cita→visita con travel/preparation. Sin overflow crítico, KPI wall ni permisos presentados como no-data.

## Coherencia, seguridad y privacidad

- Visit referencia una cita existente sin crear otra. Agenda reschedule actualiza la cita y sus reminders, no crea ni reprograma Visit; la fecha de Visit vinculada es un snapshot operativo independiente. Check-in/out tampoco muta Agenda.
- Travel/preparation se lee de Agenda autorizada; Visit no copia ni concede el contexto. Person, Opportunity, Recruiting, location y Agenda mantienen gates separados por RLS/policy. Network no hereda acceso; revocación, tenant/BOLA, version conflict, idempotencia y audit siguen probados.
- Listas usan consultas acotadas (93 días/500 máximo); recurrencia finita (50 instancias), sin N+1 de aplicación, polling nuevo, proveedor externo ni dependencia nueva.

## Deuda y readiness

- No bloqueante: el responsable Field se muestra como ID. Resolver su nombre exige un lookup Person sujeto a field policy; no se amplió el boundary en cierre.
- No bloqueante: el snapshot de fecha de Visit puede diferir de una cita reprogramada; sincronización automática requeriría una regla de producto explícita. La edición masiva de series tampoco está en E2 Beta.
- Blockers locales: ninguno. Listo para revisión/PR local; no hubo commit, push, PR, CI remoto ni merge en este cierre.
- NEXT_WORK_PACKAGE: E3A1 — Global Product Master + Taxonomy (no iniciado).
