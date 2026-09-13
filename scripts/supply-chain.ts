import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run supply-chain');
async function npm(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [npmCli!, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 20_000_000) {
        child.kill();
        fail(new Error('report too large'));
      }
    });
    child.stderr.resume();
    child.once('error', fail);
    child.once('close', (code) => ok({ code: code ?? 1, stdout }));
  });
}
await mkdir('work', { recursive: true });
const lock = z
  .object({
    packages: z.record(
      z.string(),
      z.object({
        version: z.string().optional(),
        license: z.string().optional(),
        link: z.boolean().optional(),
        dev: z.boolean().optional(),
        resolved: z.string().optional(),
      }),
    ),
  })
  .parse(JSON.parse(await readFile('package-lock.json', 'utf8')));
const inventory = Object.entries(lock.packages)
  .filter(([path, p]) => path.startsWith('node_modules/') && !p.link)
  .map(([path, p]) => ({
    path,
    version: p.version,
    license: p.license ?? 'UNKNOWN',
    dev: p.dev === true,
  }));
const denied = inventory.filter(
  (p) =>
    p.license === 'UNKNOWN' ||
    p.license === 'UNLICENSED' ||
    /(^|\s|\()(?:AGPL|GPL)-/.test(p.license),
);
const conditional = inventory.filter((p) => /LGPL|MPL|CC-BY|OFL/.test(p.license));
await writeFile(
  'work/license-report.json',
  JSON.stringify(
    {
      policy: 'foundation-development-v1',
      status: denied.length ? 'FAIL' : 'PASS_WITH_DISTRIBUTION_OBLIGATIONS',
      denied,
      conditional,
      inventory,
      notes:
        'LGPL/MPL/font attribution and bundled native notices require review before distribution. SPDX metadata is not legal approval.',
    },
    null,
    2,
  ),
);
async function auditWithOneRetry() {
  const args = [
    'audit',
    '--json',
    '--audit-level=high',
    '--fetch-retries=1',
    '--fetch-timeout=15000',
    '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=3000',
  ];
  let result = await npm(args);
  if (!result.stdout.includes('auditReportVersion')) result = await npm(args);
  return result;
}
const [audit, sbom] = await Promise.all([
  auditWithOneRetry(),
  npm(['sbom', '--sbom-format', 'cyclonedx']),
]);
const auditShape = z.object({
  auditReportVersion: z.number(),
  vulnerabilities: z.record(z.string(), z.unknown()),
  metadata: z.object({ vulnerabilities: z.record(z.string(), z.number()) }),
});
let auditData: unknown;
try {
  auditData = JSON.parse(audit.stdout) as unknown;
} catch {
  auditData = undefined;
}
const safeAudit = auditShape.safeParse(auditData);
// Registry errors may contain Set-Cookie headers. Never preserve those in evidence.
await writeFile(
  'work/npm-audit.json',
  JSON.stringify(
    safeAudit.success
      ? safeAudit.data
      : { status: 'UNAVAILABLE', code: 'AUDIT_REGISTRY_ERROR', attempts: 2 },
    null,
    2,
  ),
);
await writeFile('work/sbom.cdx.json', sbom.stdout);
if (denied.length || audit.code !== 0 || sbom.code !== 0 || !safeAudit.success) {
  console.error(
    JSON.stringify({
      event: 'supply_chain_failed',
      denied: denied.map((p) => p.path),
      auditExit: audit.code,
      sbomExit: sbom.code,
    }),
  );
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      event: 'supply_chain_pass',
      packages: inventory.length,
      distributionObligations: conditional.length,
      sbom: true,
      knownHighCriticalVulnerabilities: 0,
    }),
  );
