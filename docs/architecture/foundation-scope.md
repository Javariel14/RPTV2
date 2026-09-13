# Foundation — alcance y contratos de entrada

Fecha: 2026-09-03 (America/Guayaquil). Owner de producto: JAVARIEL Corp.

Implementación local autorizada por Prompt 01. Prompt 00 se conserva sin cambios.
Repositorio remoto: PENDING_OFFICIAL_REPOSITORY; no se inicializa Git, clona legacy,
publica código, contrata proveedores ni usa datos reales.

## Orden

1. Design Foundation + una CRM Commercial Reference Route (DR-028 / 42).
2. Security/Data Foundation (Prompt 01).
3. Prompt 02 solo al cerrar sus gates. No se implementa aquí el CRM completo.

## Blueprint y criterios visuales previos

Rol de referencia: asesor; fixtures de ownership propio y delegación explícita.
Ningún fixture representa un cliente real ni demuestra autenticación productiva.

Header → navegación de vistas → Table/Kanban → FilterBar → DataGrid → Drawer.
No hay KPI cards en CRM. Sidebar 248/72, topbar 64, drawer 460, tipografía
Plus Jakarta Sans/Manrope, colores y geometría 43/02. El JSON y SVG proceden de
43/Assets/Logo Oficial y se contrastan con su manifest SHA-256.

Componentes: Button, Panel (dialog/drawer/sheet), State, tabla semántica, filtros,
vistas guardadas, selección y paginación limitada a 20 filas incluso con 1000 fixtures.
Desktop usa tabla; tablet/mobile lista contextual; móvil tiene detalle fullscreen y
filtros bottom sheet. No se simulan llamadas, mensajes, pedidos ni guardado remoto.

Estado de prueba desde Component Lab: ready/loading/empty/permission/401/404/429/
500/502/503/504/offline/degraded. Los estados inaccesibles no renderizan las fichas.
Idiomas ES/EN/FR/PT. Tema System reacciona al sistema por media query; la preferencia
explícita es local y no almacena tokens ni PII. Vistas guardadas solo en sesión.

Acceptance: screenshots 320/390/768/1024/1280/1440/1728; light/dark/system;
búsqueda/filtros/sort/paginación/vistas/selección/actividad ficticia; Escape/focus
return de dialog nativo; sin scroll horizontal de página; axe AA smoke; errores
browser; copy largo. Se recuperó y visualizó el blueprint CRM embebido de 43/03;
la comparación usa también 43/07 y los assets vigentes de 43/02 (no su logo histórico). No aceptar screenshots como aprobación
automática ni ampliar módulos si hay fallos.

## Boundaries

apps/web: shell y referencia fixture, sin persistence ni credenciales.
apps/api: HTTP Hono + composición de adapters, sin decisiones de negocio en UI.
packages/domain: invariantes/value objects, sin vendors.
packages/contracts: schemas versionados, DTOs y errores seguros.
packages/policy: contrato de autorización; PostgreSQL es enforcement final.
packages/application: commands/queries transaccionales.
packages/persistence: SQL parametrizado, session context, migraciones.
packages/telemetry: allowlist de señales sin payloads ni PII.
packages/test-fixtures: fixtures sintéticos, nunca seed de facts productivos.

Auth/RLS no se habilitan con header de rol ni tenant enviado por el cliente.
Los identificadores inaccesibles y ausentes comparten respuesta segura.
No existen permisos universales por rol admin o posición en Network.

## Fuentes

Se releyeron 16–20, 26–34, 36, 38, 41, 42 y 43/00–08 desde los IDs del manifest
del Prompt 00. Prevalecen DR-016/017/018/027/028 y ERD-007/009 sobre contradicciones
históricas. 35/37/39/40 se heredan del mapa leído en Prompt 00; integraciones reales
no se activan. Fuentes externas técnicas se registrarán en ADR/runbooks.
