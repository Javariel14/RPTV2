# Migraciones y forward-fix

Solo un migrator NOLOGIN-member aislado aplica versiones en transacciones; el runtime no es owner, no tiene BYPASSRLS y no puede cambiar políticas. El bootstrap privilegiado es un paso de operador, fuera del API y sin contraseñas en el repositorio.

1. Generar una migración con `supabase migration new <nombre>`. Revisar locks, constraints y compatibilidad expand/contract.
2. En local, `npx tsx scripts/check-migrations.ts` levanta PostgreSQL efímero en loopback, usuarios y claves aleatorias; aplica el historial en orden y verifica checksums. No usa datos ni proyectos remotos.
3. No editar migraciones ya liberadas. Aplicar un **forward-fix** nuevo: por ejemplo, `20260904034025` separa políticas de lectura/escritura sin borrar tablas o datos de `20260904031536`.
4. Ante fallo: detener promoción; rollback de la transacción no confirmada; preservar el historial previo. Para un cambio confirmado, construir migración correctiva, probar con copia minimizada y desplegar bajo aprobación. Nunca usar DROP/RESET de producción como rollback.
5. Restore: recuperar snapshot compatible y después aplicar versiones faltantes con checksum original. Probar RLS, auditoría, ledger y conteos antes de abrir tráfico. Registrar actor, request, release y resultado fuera de logs con PII.

Los tests de PostgreSQL nativo no sustituyen `supabase db lint`, advisors, migraciones y pruebas de Auth/Storage sobre un proyecto Supabase staging autorizado. Docker/Supabase local no estaban disponibles. El runtime y la topología de identidad siguen cerrados en despliegues hasta validar esos gates.
