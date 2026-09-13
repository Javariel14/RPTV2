import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { z } from 'zod';
import { encryptedColdRestore } from './recovery.js';

export function runFile(file: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-6000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-6000);
    });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`postgres command timeout: ${file}`));
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (code === 0) ok();
      else fail(new Error(output));
    });
  });
}
async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        fail(new Error('port unavailable'));
        return;
      }
      server.close((error) => (error ? fail(error) : ok(address.port)));
    });
  });
}
export async function startPostgres() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const binaryPackage = `@embedded-postgres/${platform}-${process.arch}`;
  const binaries = z
    .object({ initdb: z.string(), pg_ctl: z.string() })
    .parse(await import(binaryPackage));
  await mkdir('work', { recursive: true });
  const directory = await mkdtemp(resolve('work/pg-'));
  const data = join(directory, 'data');
  const password = randomBytes(32).toString('hex');
  const runtimePassword = randomBytes(32).toString('hex');
  const migrationPassword = randomBytes(32).toString('hex');
  const passwordFile = join(directory, 'init-password');
  const port = await freePort();
  await writeFile(passwordFile, password, { mode: 0o600 });
  try {
    await runFile(binaries.initdb, [
      '-D',
      data,
      '-U',
      'postgres',
      '--pwfile',
      passwordFile,
      '--auth-host=scram-sha-256',
      '--auth-local=scram-sha-256',
      '--encoding=UTF8',
      '--locale=C',
    ]);
  } finally {
    await unlink(passwordFile);
  }
  await runFile(binaries.pg_ctl, [
    '-D',
    data,
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-h 127.0.0.1 -p ${port}`,
    '-w',
    'start',
  ]);
  const base = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
  };
  let admin = new Client({ ...base, database: 'postgres' });
  await admin.connect();
  const bootstrap = await readFile('infrastructure/bootstrap.sql', 'utf8');
  await admin.query(bootstrap);
  await admin.query(
    `CREATE ROLE rpt_test_runtime LOGIN PASSWORD '${runtimePassword}' IN ROLE rpt_runtime`,
  );
  await admin.query(
    `CREATE ROLE rpt_test_migrator LOGIN PASSWORD '${migrationPassword}' IN ROLE rpt_migrator`,
  );
  const runtimeConfig = (database = 'rpt_foundation') => ({
    ...base,
    database,
    user: 'rpt_test_runtime',
    password: runtimePassword,
  });
  async function migrate(
    database = 'rpt_foundation',
    limit = Infinity,
    afterMigration?: (root: Client, count: number) => Promise<void>,
  ) {
    if (!/^rpt_[a-z_]+$/.test(database)) throw new Error('invalid test database name');
    await admin.query(`CREATE DATABASE ${database}`);
    const root = new Client({ ...base, database });
    await root.connect();
    await root.query(bootstrap);
    await root.query(`GRANT CREATE ON DATABASE ${database} TO rpt_owner`);
    await root.query(
      'CREATE TABLE public.foundation_migration (name text PRIMARY KEY, sha256 text NOT NULL)',
    );
    await root.query('GRANT SELECT,INSERT ON public.foundation_migration TO rpt_migrator');
    const migrator = new Client({
      ...base,
      database,
      user: 'rpt_test_migrator',
      password: migrationPassword,
    });
    await migrator.connect();
    let count = 0;
    try {
      for (const file of (await readdir('supabase/migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .slice(0, limit)) {
        const sql = await readFile(join('supabase/migrations', file), 'utf8');
        await migrator.query('BEGIN');
        try {
          await migrator.query(sql);
          await migrator.query('RESET ROLE');
          await migrator.query('INSERT INTO public.foundation_migration VALUES($1,$2)', [
            file,
            createHash('sha256').update(sql).digest('hex'),
          ]);
          await migrator.query('COMMIT');
          count++;
          await afterMigration?.(root, count);
        } catch (error) {
          await migrator.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await migrator.end();
    }
    return root;
  }
  let currentData = data;
  let running = true;
  return {
    directory,
    admin,
    migrate,
    runtimeConfig,
    async restore() {
      await admin.end();
      await runFile(binaries.pg_ctl, ['-D', currentData, '-m', 'fast', '-w', 'stop']);
      running = false;
      const restored = await encryptedColdRestore(currentData, directory);
      currentData = restored.target;
      await runFile(binaries.pg_ctl, [
        '-D',
        currentData,
        '-l',
        join(directory, 'restored.log'),
        '-o',
        `-h 127.0.0.1 -p ${port}`,
        '-w',
        'start',
      ]);
      running = true;
      admin = new Client({ ...base, database: 'postgres' });
      await admin.connect();
      const restoredRoot = new Client({ ...base, database: 'rpt_foundation' });
      await restoredRoot.connect();
      return { root: restoredRoot, evidence: restored.evidence };
    },
    async stop() {
      await admin.end();
      if (running) await runFile(binaries.pg_ctl, ['-D', currentData, '-m', 'fast', '-w', 'stop']);
    },
  };
}
