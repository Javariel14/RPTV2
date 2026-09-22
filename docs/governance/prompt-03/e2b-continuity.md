# E2B continuity — Calendar UX

## UX construida

- Ruta `/agenda` dentro del App Shell existente.
- Vistas Today, Day, Week y agenda/list con rango acotado y filtros mine/type/status.
- Appointments, tasks y proyecciones Commercial/Recruiting se distinguen sin mezclar lifecycle.
- Drawer contextual autorizado; proyecciones CRM permanecen read-only.
- Estados loading, empty/no-results, forbidden, not-found, conflict, unavailable y success.

## Confirmations / rescheduling / reminders

- Confirm, decline, cancel y task complete usan comandos E2A con `expectedVersion` e idempotency key.
- Reschedule edita el aggregate existente; E2A conserva historial e invalida/recrea reminders.
- Reminders configurables son internos RPT; no se envían notificaciones externas.
- Conflict recarga el aggregate más reciente sin sobrescritura silenciosa.

## Recurrence / time / travel

- Creación daily/weekly reutiliza el límite E2A de 50 instancias.
- No se expone edición masiva de series; solo operaciones seguras por ocurrencia.
- Edición usa timezone IANA y conversión wall-time con validación de huecos DST.
- Origin, destination, travel minutes y preparation minutes se muestran y crean sin mapas/GPS.

## Responsive / a11y / i18n

- Desktop usa calendario/lista dominante y Drawer; mobile prioriza Today/List y Drawer full-screen.
- ES/EN/FR/PT y Light/Dark/System usan catálogo y tokens existentes.
- Dialog nativo conserva trap, Escape y retorno de foco; focus visible y reduced motion heredados.
- Axe critical/serious PASS en matriz representativa; sin overflow crítico a 390 px.

## Tests locales

- Unit E2A+E2B: rangos, timezone/DST y catálogos.
- Integration E2A: 10/10 PASS (RLS, tenant, permisos, idempotencia, recurrence, reminders).
- E2E Agenda: Today/Week, detail, confirmation, reschedule, reminders, recurrence, task completion,
  themes/locales/mobile/forbidden y evidencia visual.

## Deuda no bloqueante

- Edición/cancelación masiva de series queda fuera hasta existir semántica core explícita.
- Google Calendar y canales externos permanecen fuera de alcance.

## Blockers

- Ninguno local conocido.

## Siguiente paquete

- E2C — Field Visits Core.
