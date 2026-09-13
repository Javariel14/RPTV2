import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const sourceDirs = ['apps', 'packages', 'scripts', 'tests', 'infrastructure', '.github'];
const failures: string[] = [];
async function scan(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', '.next', '.open-next', '.wrangler', 'dist', 'work'].includes(entry.name))
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (
      !['.ts', '.tsx', '.js', '.mjs', '.json', '.jsonc', '.yml', '.yaml', '.sql', '.css'].includes(
        extname(path),
      )
    )
      continue;
    if (path.includes('source-checksums') || path.includes('worker-configuration')) continue;
    const content = await readFile(path, 'utf8');
    const client = path.startsWith(join('apps', 'web')) || path.startsWith(join('packages', 'ui'));
    if (
      client &&
      /(?:service_role|sb_secret_|DATABASE_URL|MIGRATION_DATABASE_URL|@rpt\/persistence|@rpt\/application)/i.test(
        content,
      )
    )
      failures.push(`${path}: forbidden client dependency/secret reference`);
    if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(content))
      failures.push(`${path}: private key material`);
    if (/(?:ghp_|github_pat_|sb_secret_)[a-zA-Z0-9_]{24,}/.test(content))
      failures.push(`${path}: credential pattern`);
    if (client && extname(path) !== '.json' && /#[0-9a-fA-F]{6}\b/.test(content))
      failures.push(`${path}: feature-level color literal`);
    if (
      path.startsWith(join('packages', 'domain')) &&
      /from ['"](?:pg|hono|next|@supabase|@rpt\/persistence)/.test(content)
    )
      failures.push(`${path}: domain boundary violation`);
  }
}
for (const dir of sourceDirs) await scan(dir);
let compiledClientFiles = 0;
async function scanClientBundle(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanClientBundle(path);
      continue;
    }
    if (!['.js', '.map'].includes(extname(path))) continue;
    compiledClientFiles++;
    if (
      /service_role|sb_secret_[a-zA-Z0-9_]{24,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(
        await readFile(path, 'utf8'),
      )
    )
      failures.push(`${path}: forbidden credential material in client bundle`);
  }
}
await scanClientBundle(join('apps', 'web', '.next', 'static'));
console.log(
  JSON.stringify({
    event: 'compiled_client_secret_scan',
    files: compiledClientFiles,
    status: compiledClientFiles ? 'CHECKED' : 'NOT_BUILT_YET',
  }),
);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else
  console.log(
    'PASS: source client-secret, private-key, token and domain-boundary checks. Not a replacement for SAST/SCA.',
  );
