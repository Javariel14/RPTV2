import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteCreate, quoteHistoryQuery } from '@rpt/contracts';
import { nextQuoteStatus } from '@rpt/domain';
import { createQuoteCalculationAttestor } from '@rpt/application';
import { createHmac, randomBytes } from 'node:crypto';
import type { QuoteCalculationEnvelope } from '../../packages/application/src/cpq-attestation.js';
const id = '11111111-1111-4111-8111-111111111111';
const input = {
  schemaVersion: 1,
  workspaceId: id,
  calculation: {
    schemaVersion: 1,
    asOf: '2026-01-01T00:00:00.000Z',
    priceListId: id,
    lines: [{ kind: 'product', marketProductId: id, quantity: '1' }],
  },
};
void test('CPQ strict commands cannot supply owner, money, status or arbitrary quote market', () => {
  assert.equal(quoteCreate.parse(input).personId, null);
  for (const key of [
    'ownerId',
    'marketId',
    'status',
    'unitPrice',
    'calculationHash',
    'requiresApproval',
    'outputSnapshot',
    'calculationAttestation',
  ])
    assert.equal(quoteCreate.safeParse({ ...input, [key]: id }).success, false);
  assert.equal(
    quoteCreate.safeParse({ ...input, calculation: { ...input.calculation, unitPrice: '0' } })
      .success,
    false,
  );
  assert.equal(quoteHistoryQuery.parse({}).limit, 50);
  assert.equal(quoteHistoryQuery.safeParse({ limit: 101 }).success, false);
});
void test('CPQ authentication tag binds immutable context and result without replacing E3B1 hash', async () => {
  const secret = randomBytes(32).toString('hex');
  const attestor = createQuoteCalculationAttestor(id, secret);
  // The signer does not calculate money; its service caller supplies the validated E3B1 result.
  const envelope = {
    schemaVersion: 1,
    tenantId: id,
    actorId: id,
    quoteId: id,
    versionId: id,
    versionNumber: 1,
    workspaceId: id,
    marketId: id,
    engineIdentity: 'E3B1/v1',
    input: input.calculation,
    result: {
      status: 'requires_approval',
      requiresApproval: true,
      calculationHash: 'a'.repeat(64),
    },
    lines: [],
  } as unknown as QuoteCalculationEnvelope;
  const signed = await attestor.attest(envelope);
  assert.equal(
    signed.tag,
    createHmac('sha256', Buffer.from(secret, 'hex')).update(signed.payload, 'utf8').digest('hex'),
  );
  assert.deepEqual(await attestor.attest(envelope), signed);
  const forged = structuredClone(envelope);
  forged.result.status = 'final';
  forged.result.requiresApproval = false;
  assert.notEqual((await attestor.attest(forged)).tag, signed.tag);
  assert.equal(forged.result.calculationHash, envelope.result.calculationHash);
  assert.notEqual((await attestor.attest({ ...envelope, versionNumber: 2 })).tag, signed.tag);
  assert.throws(() => createQuoteCalculationAttestor(id, '00'), RangeError);
});
void test('CPQ lifecycle is bounded and terminal quotes cannot be reissued', () => {
  assert.equal(nextQuoteStatus('draft', 'issue'), 'issued');
  assert.equal(nextQuoteStatus('issued', 'accept'), 'accepted');
  assert.equal(nextQuoteStatus('issued', 'reject'), 'rejected');
  assert.equal(nextQuoteStatus('draft', 'cancel'), 'cancelled');
  assert.throws(() => nextQuoteStatus('draft', 'accept'), RangeError);
  for (const status of ['accepted', 'rejected', 'expired', 'cancelled'] as const)
    assert.throws(() => nextQuoteStatus(status, 'issue'), RangeError);
});
