import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run npm run verify:evidence');
await mkdir('work/verification', { recursive: true });
const scripts = [
  'format:check',
  'lint',
  'typecheck',
  'test:unit',
  'security',
  'test:integration',
  'build',
  'supply-chain',
  'test:e2e',
];
const results: Array<{ script: string; exitCode: number; durationMs: number; log: string }> = [];
for (const script of scripts) {
  console.log(`VERIFY ${script}`);
  const start = performance.now();
  const result = await new Promise<{ exitCode: number; output: string }>((ok, fail) => {
    const child = spawn(process.execPath, [npmCli!, 'run', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', fail);
    child.once('close', (code) => ok({ exitCode: code ?? 1, output }));
  });
  const log = `work/verification/${script.replaceAll(':', '-')}.log`;
  await writeFile(log, result.output);
  results.push({
    script,
    exitCode: result.exitCode,
    durationMs: Math.round(performance.now() - start),
    log,
  });
  await writeFile(
    'work/verification-summary.json',
    JSON.stringify({ completedAt: new Date().toISOString(), results }, null, 2),
  );
  if (result.exitCode !== 0) {
    process.exitCode = 1;
    break;
  }
}
