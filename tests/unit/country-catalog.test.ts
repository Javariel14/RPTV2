import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogMarketCreate,
  currencyRegister,
  exchangeRateCreate,
  priceEntryCreate,
  priceListCreate,
} from '@rpt/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const evidence = {
  sourceSystem: 'RPT_USER',
  sourceReference: 'fixture://price',
  externalId: 'synthetic',
  observedAt: '2026-01-01T00:00:00Z',
  authorityLevel: 'manual',
  evidenceLevel: 'exact_primary',
  sourceLiteral: '$100 IVA 0%',
};
void test('E3A2 contracts constrain market, money, tax and time without CPQ fields', () => {
  assert.equal(
    catalogMarketCreate.safeParse({
      schemaVersion: 1,
      countryCode: 'EC',
      currency: 'USD',
      timezone: 'America/Guayaquil',
      locale: 'es-EC',
    }).success,
    true,
  );
  assert.equal(
    catalogMarketCreate.safeParse({
      schemaVersion: 1,
      countryCode: 'Ecuador',
      currency: 'USD',
      timezone: 'America/Guayaquil',
      locale: 'es-EC',
    }).success,
    false,
  );
  assert.equal(
    priceListCreate.safeParse({
      schemaVersion: 1,
      marketId: id,
      workspaceId: id,
      stableKey: 'retail',
      name: 'Retail',
      currency: 'USD',
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      evidence,
      discount: 10,
    }).success,
    false,
  );
  const draftList = {
    schemaVersion: 1,
    marketId: id,
    workspaceId: id,
    stableKey: 'retail',
    name: 'Retail',
    currency: 'USD',
    status: 'draft',
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    evidence,
  };
  assert.equal(priceListCreate.safeParse(draftList).success, true);
  assert.equal(priceListCreate.safeParse({ ...draftList, status: 'active' }).success, false);
  const entry = {
    schemaVersion: 1,
    expectedVersion: 1,
    marketProductId: id,
    currency: 'USD',
    amount: '100.00',
    taxTreatment: 'tax_not_applicable',
    taxRate: '0',
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2026-06-01T00:00:00Z',
    evidence,
  };
  assert.equal(priceEntryCreate.safeParse(entry).success, true);
  assert.equal(
    priceEntryCreate.safeParse({ ...entry, taxTreatment: 'tax_unknown', taxRate: '0' }).success,
    false,
  );
  assert.equal(priceEntryCreate.safeParse({ ...entry, amount: '100.00001' }).success, false);
  assert.equal(priceEntryCreate.safeParse({ ...entry, validTo: entry.validFrom }).success, false);
  assert.equal(priceEntryCreate.safeParse({ ...entry, probability: 0.9 }).success, false);
});

void test('E3A2 F1 currency and FX contracts remain controlled and exact', () => {
  assert.equal(
    currencyRegister.safeParse({
      schemaVersion: 1,
      code: 'CLP',
      name: 'Chilean peso',
      minorUnits: 0,
    }).success,
    true,
  );
  assert.equal(
    currencyRegister.safeParse({
      schemaVersion: 1,
      code: 'clp',
      name: 'Chilean peso',
      minorUnits: 0,
    }).success,
    false,
  );
  const fx = {
    schemaVersion: 1,
    marketId: id,
    baseCurrency: 'USD',
    quoteCurrency: 'CLP',
    rate: '901.1234567890',
    validFrom: '2026-01-01T00:00:00Z',
    validTo: null,
    evidence,
  };
  assert.equal(exchangeRateCreate.safeParse(fx).success, true);
  assert.equal(exchangeRateCreate.safeParse({ ...fx, rate: '901.12345678901' }).success, false);
  assert.equal(exchangeRateCreate.safeParse({ ...fx, baseCurrency: 'CLP' }).success, false);
  assert.equal(
    exchangeRateCreate.safeParse({ ...fx, evidence: { ...evidence, evidenceLevel: 'pending' } })
      .success,
    false,
  );
});
