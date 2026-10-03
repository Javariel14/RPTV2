import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ingestExternalOrder,
  correlateExternalOrder,
  resolveExternalOrder,
  orderReconciliationHttpStatus,
} from '@rpt/contracts';
import { classifyExternalOrderEvent, canResolveExternalOrder } from '@rpt/domain';

void test('E3C1 adapter-neutral envelope and resolution contracts reject malformed inputs', () => {
  const envelope = {
    schemaVersion: 1,
    workspaceId: randomUUID(),
    marketId: randomUUID(),
    sourceSystem: 'API',
    externalId: 'provider-1',
    sourceReference: 'external://provider/1',
    observedAt: '2026-09-29T10:00:00Z',
    effectiveAt: '2026-09-29T09:00:00Z',
    rawHash: 'a'.repeat(64),
    correlationId: randomUUID(),
    authorityLevel: 'verified',
  };
  assert.equal(ingestExternalOrder.safeParse(envelope).success, true);
  for (const mutation of [
    { externalId: '' },
    { rawHash: 'bad' },
    { sourceSystem: 'FAKE' },
    { workspaceId: 'bad' },
    { observedAt: '2026-09-29T10:00:00.1234567Z' },
  ]) {
    assert.equal(ingestExternalOrder.safeParse({ ...envelope, ...mutation }).success, false);
  }
  assert.equal(
    correlateExternalOrder.safeParse({
      schemaVersion: 1,
      intakeId: randomUUID(),
      orderId: randomUUID(),
      expectedVersion: 1,
      reason: ' ',
    }).success,
    false,
  );
  assert.equal(
    resolveExternalOrder.safeParse({
      schemaVersion: 1,
      sourceSystem: 'API',
      externalId: 'provider-1',
      expectedVersion: 0,
      outcome: 'matched',
      reason: 'valid',
    }).success,
    false,
  );
  assert.equal(orderReconciliationHttpStatus.STALE_VERSION, 409);
});

void test('E3C1 pure duplicate, stale, ambiguity and resolution classification', () => {
  const current = {
    effectiveAt: '2026-09-29T09:00:00Z',
    observedAt: '2026-09-29T10:00:00Z',
    hash: 'a',
  };
  assert.equal(classifyExternalOrderEvent(null, current), 'unmatched');
  assert.equal(classifyExternalOrderEvent(current, current), 'duplicate');
  assert.equal(
    classifyExternalOrderEvent(
      { ...current, effectiveAt: '2026-09-29T09:00:00.000001Z' },
      { ...current, effectiveAt: '2026-09-29T09:00:00.000002Z' },
    ),
    'conflict',
  );
  assert.equal(
    classifyExternalOrderEvent(
      { ...current, effectiveAt: '2026-09-29T09:00:00.000002Z' },
      { ...current, effectiveAt: '2026-09-29T09:00:00.000001Z', hash: 'b' },
    ),
    'stale',
  );
  assert.equal(
    classifyExternalOrderEvent(current, {
      ...current,
      effectiveAt: '2026-09-29T10:00:00+01:00',
      observedAt: '2026-09-29T11:00:00+01:00',
    }),
    'duplicate',
  );
  assert.equal(
    classifyExternalOrderEvent(current, {
      ...current,
      effectiveAt: '2026-09-28T09:00:00Z',
      hash: 'b',
    }),
    'stale',
  );
  assert.equal(classifyExternalOrderEvent(current, { ...current, hash: 'b' }), 'conflict');
  assert.equal(
    classifyExternalOrderEvent(current, {
      ...current,
      hash: 'b',
      effectiveAt: '2026-09-29T10:00:00+01:00',
    }),
    'conflict',
  );
  assert.equal(
    classifyExternalOrderEvent(current, { ...current, observedAt: '2026-09-29T11:00:00Z' }),
    'conflict',
  );
  assert.equal(
    classifyExternalOrderEvent(current, {
      ...current,
      observedAt: '2026-09-29T11:00:00Z',
      hash: 'b',
    }),
    'newer',
  );
  assert.equal(canResolveExternalOrder('unmatched', 'matched'), false);
  assert.equal(canResolveExternalOrder('conflict', 'resolved_local_verified'), true);
  assert.equal(canResolveExternalOrder('matched', 'matched'), false);
  assert.equal(canResolveExternalOrder('resolved_local_verified', 'matched'), false);
  assert.equal(canResolveExternalOrder('pending_review', 'resolved_official_wins', true), false);
});
