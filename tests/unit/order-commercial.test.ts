import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orderCancel,
  orderReplace,
  orderCommercialHistoryQuery,
  orderCommercialEvidence,
} from '@rpt/contracts';
import { nextOrderCommercialStatus } from '@rpt/domain';
const id = '11111111-1111-4111-8111-111111111111',
  successor = '22222222-2222-4222-8222-222222222222';
void test('E3B4 strict commands reject client authority, money, invalid reason/version and self replacement', () => {
  const base = {
    schemaVersion: 1,
    orderId: id,
    expectedVersion: 1,
    reason: 'Internal commercial correction',
  };
  for (const [schema, input] of [
    [orderCancel, base],
    [orderReplace, { ...base, successorOrderId: successor, successorExpectedVersion: 1 }],
  ] as const) {
    assert.equal(schema.safeParse(input).success, true);
    for (const key of [
      'tenantId',
      'marketId',
      'workspaceId',
      'actorId',
      'customerId',
      'status',
      'calculationHash',
      'amount',
      'snapshot',
    ])
      assert.equal(schema.safeParse({ ...input, [key]: id }).success, false);
    for (const expectedVersion of [0, -1, 1.5, 2147483647])
      assert.equal(schema.safeParse({ ...input, expectedVersion }).success, false);
    for (const reason of [' ', '     ', '\t', '\n', '\r', '\t\n', ' \t \n \r '])
      assert.equal(schema.safeParse({ ...input, reason }).success, false);
    for (const reason of [
      'Cliente solicitó cancelar',
      'Corrección de datos comerciales',
      '\tCliente solicitó cambio\t',
    ])
      assert.equal(schema.safeParse({ ...input, reason }).success, true);
    assert.equal(schema.safeParse({ ...input, reason: 'x'.repeat(501) }).success, false);
  }
  assert.equal(
    orderReplace.safeParse({ ...base, successorOrderId: id, successorExpectedVersion: 1 }).success,
    false,
  );
});
void test('E3B4 bounded terminal commercial states cannot reopen or imply other domain states', () => {
  assert.equal(nextOrderCommercialStatus('created', 'cancel'), 'cancelled');
  assert.equal(nextOrderCommercialStatus('created', 'replace'), 'superseded');
  for (const state of ['cancelled', 'superseded'] as const)
    for (const operation of ['cancel', 'replace'] as const)
      assert.equal(nextOrderCommercialStatus(state, operation), null);
});
void test('E3B4 keyset history is bounded and evidence subject identity is explicit', () => {
  assert.deepEqual(orderCommercialHistoryQuery.parse({}), { afterSequence: 0, limit: 50 });
  for (const input of [{ limit: 101 }, { limit: 0 }, { afterSequence: -1 }, { marketId: id }])
    assert.equal(orderCommercialHistoryQuery.safeParse(input).success, false);
  assert.equal(
    orderCommercialEvidence.safeParse({ schemaVersion: 1, subjectId: id }).success,
    false,
  );
});
