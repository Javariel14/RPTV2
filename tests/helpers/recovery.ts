import { spawn } from 'node:child_process';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
function archiveProcess(args: string[]) {
  const child = spawn('tar', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let errorText = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errorText = (errorText + chunk.toString()).slice(-1000);
  });
  const finished = new Promise<void>((ok, fail) => {
    const timeout = setTimeout(() => {
      child.kill();
      fail(new Error('archive timeout'));
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) ok();
      else fail(new Error(errorText));
    });
  });
  return { child, finished };
}
/** Test-only cold physical backup. Caller MUST stop the whole cluster first. */
export async function encryptedColdRestore(data: string, workDirectory: string) {
  const start = performance.now(),
    key = randomBytes(32),
    iv = randomBytes(12);
  const archive = join(workDirectory, 'recovery.pg17.enc');
  const target = join(workDirectory, 'restored');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('rpt-physical-backup-v1'));
  const pack = archiveProcess(['-cf', '-', '-C', data, '.']);
  pack.child.stdin.end();
  await Promise.all([
    pipeline(pack.child.stdout, createGzip(), cipher, createWriteStream(archive, { mode: 0o600 })),
    pack.finished,
  ]);
  const tag = cipher.getAuthTag();
  const encrypted = await readFile(archive);
  if (encrypted.length > 512 * 1024 * 1024) throw new Error('test archive too large');
  const sha256 = createHash('sha256').update(encrypted).digest('hex');
  const decrypt = (payload: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('rpt-physical-backup-v1'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  };
  const tampered = Buffer.from(encrypted);
  tampered[0] = tampered[0]! ^ 1;
  let integrityRejected = false;
  try {
    decrypt(tampered);
  } catch {
    integrityRejected = true;
  }
  if (!integrityRejected) throw new Error('backup integrity not enforced');
  const authenticated = decrypt(encrypted); // Authenticate before creating or extracting a target.
  await mkdir(target);
  const unpack = archiveProcess(['-xf', '-', '-C', target]);
  unpack.child.stdout.resume();
  await Promise.all([
    pipeline(Readable.from([authenticated]), createGunzip(), unpack.child.stdin),
    unpack.finished,
  ]);
  key.fill(0);
  authenticated.fill(0);
  const evidence = {
    format: 'cold-whole-cluster/pg17/aes-256-gcm+gzip',
    sha256,
    bytes: encrypted.length,
    integrityRejected,
    durationMs: Math.round(performance.now() - start),
    keyPersisted: false,
  };
  await writeFile(join(workDirectory, 'recovery-manifest.json'), JSON.stringify(evidence, null, 2));
  return { target, evidence };
}
