import assert from 'node:assert/strict';
import test from 'node:test';
import {
  businessOrderNumber,
  orderHistoryQuery,
  orderListItem,
  orderListQuery,
} from '@rpt/contracts';

void test('E3C2 Order read contracts are strict, bounded and versioned', () => {
  assert.equal(businessOrderNumber.parse('ORD-0000000001'), 'ORD-0000000001');
  for (const value of [
    'ORD-1',
    'ord-0000000001',
    'ORD-000000001',
    'ORD-00000000001',
    'ABC-0000000001',
    'ORD-ABCDEFGHIJ',
  ])
    assert.equal(businessOrderNumber.safeParse(value).success, false);

  assert.deepEqual(orderListQuery.parse({}), { limit: 50 });
  assert.deepEqual(orderHistoryQuery.parse({ limit: '100' }), { limit: 100 });
  for (const query of [
    { offset: '1' },
    { limit: '0' },
    { limit: '101' },
    { status: 'paid' },
    { businessOrderNumber: 'ORD-1' },
  ])
    assert.equal(orderListQuery.safeParse(query).success, false);

  const item = {
    schemaVersion: 1 as const,
    id: crypto.randomUUID(),
    businessOrderNumber: 'ORD-0000000001',
    workspaceId: crypto.randomUUID(),
    marketId: crypto.randomUUID(),
    quoteId: crypto.randomUUID(),
    quoteVersionId: crypto.randomUUID(),
    acceptanceId: crypto.randomUUID(),
    currency: 'USD',
    status: 'created' as const,
    lifecycleVersion: 1,
    createdAt: '2026-10-03T00:00:00.000Z',
  };
  assert.deepEqual(orderListItem.parse(item), item);
  assert.equal(orderListItem.safeParse({ ...item, tenant_id: crypto.randomUUID() }).success, false);
});
