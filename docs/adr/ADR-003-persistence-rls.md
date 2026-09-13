# ADR-003 — Persistence, tenant y RLS

Estado: aceptado para Foundation local. Release Supabase pendiente de pruebas del proveedor.

PostgreSQL es el enforcement final. PK/FK compuestas contienen tenant; todas las tablas sensibles tienen RLS. Person canónica y UserAccount son distintas. La PII está en una tabla separada, sin vistas que la mezclen con DTOs generales. Ningún rango ni rol llamado admin concede acceso universal.

Runtime NOLOGIN-group + login de entorno separado; admin NOLOGIN-group sin permisos comerciales implícitos; migrator separado hereda owner únicamente para DDL. Nunca usar postgres, service_role ni owner como runtime. Al conectar se comprueban atributos y memberships peligrosos. El navegador no accede a PostgreSQL ni a esquemas internos por Data API.

El servidor valida firma/algoritmo/issuer/audience/exp/iat/session_id/aal del JWT. Resolver issuer+subject+session en BD fija tenant y actor. Las políticas no leen user_metadata ni cabeceras de tenant. Contexto transaccional con set_config LOCAL; no se comparte entre solicitudes ni se cachean grants. El role de conexión es una credencial del servidor confiable: quien lo robe y ejecute SQL arbitrario podría falsificar GUC; no se pretende que RLS autentique por sí solo a ese proceso. TLS/Hyperdrive, consultas parametrizadas, menor privilegio y rotación son controles complementarios.

Funciones SECURITY DEFINER con search_path=pg_catalog y nombres cualificados encapsulan lecturas privadas para evitar recursión RLS. Owner bypass existe SOLO en esa frontera revisada; no FORCE RLS en tablas que lee el owner, ni grants directos authz para runtime. EXECUTE por allowlist; PUBLIC revocado. No se exponen funciones de bootstrap por HTTP.

Permisos: capacidad vigente × objeto/workspace/ownership × verbo × campo × sesión/contexto × policy version. Grant requiere autoridad directa actual del grantor, misma capacidad del grantee, objeto concreto y vencimiento (30 días máximo técnico conservador, ADR configurable futuro). No redelegación. Revocar grant, rol, sesión o versión cambia la siguiente evaluación, también en retries.

Network aporta únicamente una función estadística sin Person/PII; sales permanece suprimido hasta política de cohortes aprobada. Acceso CRM no se deriva de edges. Membresías y parents son intervalos [from,to), sin solapamientos. Cycle guard intersecta intervalos durante traversal y serializa escrituras con advisory lock. Reparent: cerrar intervalo y añadir nuevo; nunca UPDATE de parent histórico.

Implementación SQL se conserva explícita y parametrizada; no se introduce ORM. Application orquesta transacciones/consultas limitadas, Persistence administra conexiones/roles/contexto. Antes de ampliar módulos, extraer nuevos repositorios específicos en lugar de permitir SQL en UI o dominio.

Validación: suite real con conexiones runtime separadas, dos tenants, scopes negativos, fields, grants, revocación, ciclos, integridad temporal y restore. No equivale a pentest ni valida todavía Auth/Storage/RLS sobre Supabase real.
