import { startPostgres } from '../tests/helpers/postgres.js';
const cluster = await startPostgres();
try {
  const database = await cluster.migrate();
  console.log(
    JSON.stringify({
      event: 'migrations_verified',
      rows: (
        await database.query('SELECT name,sha256 FROM public.foundation_migration ORDER BY name')
      ).rows,
    }),
  );
  await database.end();
} finally {
  await cluster.stop();
}
