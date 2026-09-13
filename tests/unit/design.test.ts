import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { referenceContacts } from '@rpt/test-fixtures';
await test('canonical machine token values and raw SVG source checksum', async () => {
  const raw = await readFile('packages/design-tokens/canonical.json', 'utf8');
  const tokens = JSON.parse(raw) as {
    color: { brand: { blue600: { $value: string } } };
    brand: { logoConcept: string };
  };
  assert.equal(tokens.color.brand.blue600.$value, '#2563EB');
  assert.equal(tokens.brand.logoConcept, 'Opción B — Monograma R Ascendente');
  const checksum: Record<string, string> = JSON.parse(
    await readFile('packages/design-tokens/source-checksums.json', 'utf8'),
  ) as Record<string, string>;
  const svg = await readFile('apps/web/public/rpt-symbol-color.svg', 'utf8');
  // apply_patch appends a final LF; no geometry/color/content has changed.
  assert.equal(
    createHash('sha256').update(svg.trimEnd()).digest('hex'),
    checksum['02_Vector_SVG/rpt-symbol-color.svg'],
  );
  assert.equal(
    createHash('sha256').update(raw.trimEnd()).digest('hex'),
    checksum['05_Design_Tokens/rpt-design-tokens.json'],
  );
});
await test('fixtures are bounded, unique, synthetic, deterministic', () => {
  const rows = referenceContacts(1000);
  assert.equal(rows.length, 1000);
  assert.equal(new Set(rows.map((r) => r.id)).size, 1000);
  assert.equal(referenceContacts(1_000_000).length, 2000);
  assert.deepEqual(referenceContacts(1), referenceContacts(1));
});
