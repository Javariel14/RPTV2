import assert from 'node:assert/strict';
import test from 'node:test';
import {
  quoteApprovalRequest,
  quoteApprovalDecision,
  quoteAcceptanceRecord,
  orderFromAcceptedQuote,
} from '@rpt/contracts';
import { quoteApprovalState } from '@rpt/domain';
const id = '11111111-1111-4111-8111-111111111111';
void test('workflow commands reject client authority, money and foreign context', () => {
  const base = { schemaVersion: 1, quoteVersionId: id, expectedVersion: 1 };
  const commands = [
    [quoteApprovalRequest, { ...base, reason: 'Request' }],
    [
      quoteApprovalDecision,
      { ...base, approvalRequestId: id, decision: 'approved', reason: 'Decision' },
    ],
    [quoteAcceptanceRecord, { ...base, method: 'administrative_record', note: 'Record' }],
    [orderFromAcceptedQuote, { ...base, acceptanceId: id }],
  ] as const;
  for (const [schema, input] of commands) {
    assert.equal(schema.safeParse(input).success, true);
    for (const field of [
      'tenantId',
      'workspaceId',
      'marketId',
      'ownerId',
      'approverId',
      'decidedBy',
      'requiresApproval',
      'calculationHash',
      'total',
      'outputSnapshot',
    ])
      assert.equal(schema.safeParse({ ...input, [field]: id }).success, false);
    assert.equal(schema.safeParse({ ...input, expectedVersion: 0 }).success, false);
  }
});
void test('approval supersession preserves historical decisions without replaying their authority', () => {
  assert.deepEqual(quoteApprovalState(null, true), { status: 'pending', actionable: true });
  assert.deepEqual(quoteApprovalState(null, false), { status: 'superseded', actionable: false });
  assert.deepEqual(quoteApprovalState('approved', false), {
    status: 'approved',
    actionable: false,
  });
  assert.deepEqual(quoteApprovalState('rejected', true), { status: 'rejected', actionable: false });
});
