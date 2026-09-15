import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crmMutation } from '@rpt/contracts';
import { u4Labels } from '../../apps/web/app/u4-catalog.js';

await test('U4 mutations require version, reject authority/tenant injection, preserve strict variants', () => {
  const base = {
    schemaVersion: 1,
    expectedVersion: 1,
    command: { type: 'entry', kind: 'note', text: 'synthetic' },
  };
  assert.equal(crmMutation.safeParse(base).success, true);
  for (const value of [
    { ...base, expectedVersion: 0 },
    { ...base, expectedVersion: undefined },
    { ...base, tenantId: 'foreign' },
    { ...base, command: { ...base.command, authority: 'official' } },
    { ...base, command: { type: 'quote', product: 'x', amount: '1e9', currency: 'USD' } },
    { ...base, command: { type: 'edit_contact', email: 'bad', phone: 'x' } },
  ])
    assert.equal(crmMutation.safeParse(value).success, false);
});
await test('U4 four locales expose the same nonempty action/state vocabulary', () => {
  const keys = Object.keys(u4Labels('es')).sort();
  for (const locale of ['es', 'en', 'fr', 'pt'] as const) {
    const labels = u4Labels(locale);
    assert.deepEqual(Object.keys(labels).sort(), keys);
    assert.ok(Object.values(labels).every((value) => value.trim().length > 0));
  }
});
