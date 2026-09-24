# E2D — Field Sales UX (local)

- `/field` usa el App Shell existente con Today/Upcoming, rango local, filtros mine/status, lista operativa, creación y Drawer adaptable.
- El Drawer lee el detalle autorizado de E2C y ofrece update limitado, check-in, check-out confirmado, cancel y no-show según transición. La UI espera la respuesta del servidor, bloquea doble envío, conserva `expectedVersion` y reutiliza idempotency key durante reintentos inciertos.
- La ubicación se solicita solo tras opt-in explícito en check-in/out. Si el navegador la deniega, continúa sin ella; si el servidor rechaza la evidencia opcional, permite un reintento explícito sin ubicación. No hay mapas, tracking ni geolocalización pasiva.
- Los vínculos Agenda/Person/Opportunity y la evidencia de ubicación dependen exclusivamente del detalle autorizado por E2C; la UI no concede permisos. El endpoint de contexto solo devuelve un workspace con autorización de create.
- ES/EN/FR/PT, Light/Dark/System, Drawer móvil, focus return y estados forbidden/conflict/unavailable reutilizan los patrones existentes. No se añadieron dependencias.
- Pruebas locales: Field Sales E2E 7/7 PASS (desktop Light ES, wide Dark EN, mobile System FR, mobile Dark PT, check-in/out, location denied/retry, conflict/no-show, axe); `npm run verify` PASS (formato, lint, typecheck, 26 unitarios, seguridad, 86 integraciones y build web/API).
- Visual QA: capturas locales representativas en `work/e2d-visual/`; no se versionan. El Drawer móvil se capturó después de cargar el detalle.
- Deuda no bloqueante: E2C expone el owner como ID, no como display name; no se amplió el contrato ni la política PII para resolverlo en E2D.
- Blockers: ninguno para revisión local. No se ejecutó CI remoto ni se hizo commit, push o merge.
- Siguiente paquete: E2E — E2 regression, integration and closure. No iniciado.
