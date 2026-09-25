import assert from 'node:assert/strict';
import test from 'node:test';
import { productCommand, productCreate, productTaxonGroup } from '@rpt/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const observation = {
  sourceSystem: 'RPT_USER',
  sourceReference: 'fixture://product',
  externalId: 'synthetic-01',
  observedAt: '2026-09-01T12:00:00Z',
  authorityLevel: 'manual',
  scope: { kind: 'tenant', key: 'global' },
};
void test('E3A1 contracts keep identity, scope, taxonomy and normalized facts bounded', () => {
  assert.equal(
    productCreate.safeParse({
      schemaVersion: 1,
      workspaceId: id,
      stableKey: 'pan-01',
      name: 'Same name',
      lifecycle: 'active',
      price: 100,
    }).success,
    false,
  );
  assert.equal(productTaxonGroup.safeParse('Random Tag').success, false);
  assert.equal(productTaxonGroup.safeParse('future_group').success, true);
  assert.equal(
    productCommand.safeParse({
      schemaVersion: 1,
      expectedVersion: 1,
      command: { type: 'define_group', slug: 'future_group', label: 'Future group' },
    }).success,
    true,
  );
  const base = { schemaVersion: 1, expectedVersion: 1 };
  assert.equal(
    productCommand.safeParse({
      ...base,
      command: {
        type: 'assign_code',
        nodeId: id,
        codeKind: 'sku',
        scope: { kind: 'market', key: 'ec' },
        code: 'ABC',
      },
    }).success,
    true,
  );
  assert.equal(
    productCommand.safeParse({
      ...base,
      command: {
        type: 'assign_code',
        nodeId: id,
        codeKind: 'sku',
        scope: { kind: 'tenant', key: 'ec' },
        code: 'ABC',
      },
    }).success,
    false,
  );
  const fact = {
    nodeId: id,
    factKind: 'dimension',
    valueKind: 'decimal',
    valueDecimal: '10.250000',
    unitSlug: 'in',
    evidence: { observation, evidenceLevel: 'pending', sourceLiteral: '10 in' },
  };
  assert.equal(
    productCommand.safeParse({ ...base, command: { type: 'record_fact', fact } }).success,
    false,
  );
  assert.equal(
    productCommand.safeParse({
      ...base,
      command: { type: 'record_fact', fact: { ...fact, valueDecimal: null, unitSlug: null } },
    }).success,
    true,
  );
  assert.equal(
    productCommand.safeParse({
      ...base,
      command: {
        type: 'record_fact',
        fact: { ...fact, evidence: { ...fact.evidence, evidenceLevel: 'exact_primary' } },
      },
    }).success,
    false,
  );
});
