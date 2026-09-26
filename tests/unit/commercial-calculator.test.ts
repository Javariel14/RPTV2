import assert from 'node:assert/strict';
import test from 'node:test';
import { Exact, calculateResolvedCommercial } from '@rpt/domain';
import {
  commercialCalculationRequest,
  commercialConfigurationCreate,
  type ResolvedCommercialInput,
  type ResolvedCommercialFinancing,
} from '@rpt/contracts';
const id = '11111111-1111-4111-8111-111111111111';
const base = (): ResolvedCommercialInput => ({
  schemaVersion: 1,
  asOf: '2026-01-01T00:00:00.000Z',
  effectiveMarketId: id,
  priceListId: id,
  priceListVersion: 2,
  currency: 'USD',
  minorUnits: 2,
  lines: [
    {
      marketProductId: id,
      quantity: '1',
      entryId: id,
      entryVersion: 1,
      unitPrice: '100.00',
      taxTreatment: 'tax_not_applicable',
      taxRate: null,
    },
  ],
  rules: [],
});
void test('exact decimals preserve precision, large values and HALF_UP boundaries', () => {
  assert.equal(Exact.parse('0.1').add(Exact.parse('0.2')).format(2), '0.30');
  assert.equal(Exact.parse('1.005').format(2), '1.01');
  assert.equal(Exact.parse('-1.005').format(2), '-1.01');
  assert.equal(
    Exact.parse('99999999999999.99').mul(Exact.parse('100')).format(2),
    '9999999999999999.00',
  );
  assert.equal(Exact.parse('1').div(Exact.parse('3')).mul(Exact.parse('3')).format(2), '1.00');
});
void test('official entry trace, exact multiplication and currency minor units', async () => {
  const v = base();
  v.lines[0]!.unitPrice = '0.10';
  v.lines[0]!.quantity = '3';
  const r = await calculateResolvedCommercial(v);
  assert.equal(r.totals.grandTotal, '0.30');
  assert.equal(r.lines[0]!.entryId, id);
  assert.equal(r.lines[0]!.entryVersion, 1);
  v.currency = 'CLP';
  v.minorUnits = 0;
  v.lines[0]!.unitPrice = '3';
  v.lines[0]!.quantity = '0.5';
  assert.equal((await calculateResolvedCommercial(v)).totals.grandTotal, '2');
});
void test('tax inclusive preserves official gross and decomposes exact net/tax', async () => {
  const v = base();
  v.lines[0] = { ...v.lines[0]!, unitPrice: '115', taxTreatment: 'tax_inclusive', taxRate: '0.15' };
  const r = await calculateResolvedCommercial(v);
  assert.equal(r.lines[0]!.gross, '115.00');
  assert.equal(r.lines[0]!.net, '100.00');
  assert.equal(r.totals.taxTotal, '15.00');
  v.lines[0]!.unitPrice = '0.03';
  v.lines[0]!.taxRate = '0.2';
  v.rules = [
    {
      id: 'zero-rule',
      version: 1,
      kind: 'fixed_surcharge',
      value: '0',
      autoLimit: null,
      priority: 1,
    },
  ];
  assert.equal((await calculateResolvedCommercial(v)).totals.grandTotal, '0.03');
});
void test('tax exclusive uses evidence rate; not-applicable is explicitly zero', async () => {
  const v = base();
  v.lines[0]!.taxTreatment = 'tax_exclusive';
  v.lines[0]!.taxRate = '0.075';
  assert.equal((await calculateResolvedCommercial(v)).totals.grandTotal, '107.50');
  v.lines[0]!.taxTreatment = 'tax_not_applicable';
  v.lines[0]!.taxRate = null;
  assert.equal((await calculateResolvedCommercial(v)).totals.taxTotal, '0.00');
});
void test('unknown or undisclosed inclusive/exclusive tax is incomplete, not zero', async () => {
  for (const treatment of ['tax_unknown', 'tax_inclusive', 'tax_exclusive'] as const) {
    const v = base();
    v.lines[0]!.taxTreatment = treatment;
    v.rules = [
      {
        id: 'skipped',
        version: 1,
        kind: 'percentage_discount',
        value: '0.1',
        autoLimit: '0.2',
        priority: 1,
      },
    ];
    const r = await calculateResolvedCommercial(v);
    assert.equal(r.status, 'incomplete_tax_semantics');
    assert.equal(r.totals.taxTotal, null);
    assert.equal(r.totals.grandTotal, null);
    assert.equal(r.totals.discountTotal, '0.00');
    assert.deepEqual(r.appliedRules, []);
    assert.ok(r.lines.every((l) => l.appliedAdjustments.length === 0));
  }
});
void test('rules use priority, exact percentage/fixed adjustments and explicit approval limit', async () => {
  const v = base();
  v.rules = [
    { id: 'fixed', version: 1, kind: 'fixed_surcharge', value: '5', autoLimit: null, priority: 2 },
    {
      id: 'discount',
      version: 3,
      kind: 'percentage_discount',
      value: '0.1',
      autoLimit: '0.05',
      priority: 1,
    },
  ];
  const r = await calculateResolvedCommercial(v);
  assert.equal(r.totals.grandTotal, '95.00');
  assert.equal(r.totals.discountTotal, '10.00');
  assert.equal(r.status, 'requires_approval');
  assert.equal(r.appliedRules[0]!.version, 3);
  assert.deepEqual(
    r.appliedRules.map((rule) => rule.id),
    ['discount', 'fixed'],
  );
  assert.deepEqual(
    r.lines[0]!.appliedAdjustments.map((rule) => rule.id),
    ['discount', 'fixed'],
  );
  v.rules[0]!.kind = 'fixed_discount';
  v.rules[1]!.kind = 'percentage_surcharge';
  v.rules[1]!.autoLimit = null;
  assert.equal((await calculateResolvedCommercial(v)).totals.grandTotal, '105.00');
});
void test('ambiguous order and discounts beyond base are rejected', async () => {
  const v = base();
  const r = {
    id: 'one',
    version: 1,
    kind: 'fixed_discount' as const,
    value: '101',
    autoLimit: null,
    priority: 1,
  };
  v.rules = [r];
  await assert.rejects(() => calculateResolvedCommercial(v), /discount exceeds/);
  v.rules = [r, { ...r, id: 'two' }];
  await assert.rejects(() => calculateResolvedCommercial(v), /ambiguous/);
});
void test('basket allocation reconciles minor units without negative last lines', async () => {
  const v = base();
  v.lines = Array.from({ length: 10 }, (_, i) => ({
    ...v.lines[0]!,
    marketProductId: `line${i}`,
    unitPrice: i === 9 ? '0' : '0.01',
  }));
  v.rules = [
    {
      id: 'allocation',
      version: 1,
      kind: 'fixed_discount',
      value: '0.05',
      autoLimit: null,
      priority: 1,
    },
  ];
  const r = await calculateResolvedCommercial(v);
  assert.equal(r.totals.grandTotal, '0.04');
  assert.ok(r.lines.every((l) => Exact.parse(l.net!).compare(Exact.parse('0')) >= 0));
});
const financing = (): ResolvedCommercialFinancing => ({
  planId: id,
  planVersion: 1,
  termId: id,
  termVersion: 1,
  months: 3,
  mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
  value: '0.1',
  downPaymentRate: null,
  downPaymentAmount: null,
  allowAdditionalBalance: false,
  additionalBalance: '0',
});
void test('surcharge equal installments reconciles last payment and exact total', async () => {
  const v = base();
  v.financing = financing();
  const r = await calculateResolvedCommercial(v);
  assert.equal(r.financing!.surcharge, '10.00');
  assert.equal(r.financing!.installment, '36.67');
  assert.equal(r.financing!.lastInstallment, '36.66');
  assert.equal(r.financing!.scheduledTotal, '110.00');
  v.lines[0]!.unitPrice = '0.60';
  v.financing = { ...financing(), months: 120, value: '0' };
  const tiny = await calculateResolvedCommercial(v);
  assert.ok(
    tiny.financing!.installments.every(
      (amount) => Exact.parse(amount).compare(Exact.parse('0')) >= 0,
    ),
  );
  assert.equal(
    tiny
      .financing!.installments.reduce(
        (sum, amount) => sum.add(Exact.parse(amount)),
        Exact.parse('0'),
      )
      .format(2),
    '0.60',
  );
});
void test('down-payment factor is not APR and explicit additional balance is policy gated', async () => {
  const v = base();
  v.financing = {
    ...financing(),
    mode: 'DOWN_PAYMENT_INSTALLMENT_FACTOR',
    months: 5,
    value: '0.25',
    downPaymentRate: '0.2',
    allowAdditionalBalance: true,
    additionalBalance: '10',
  };
  const r = await calculateResolvedCommercial(v);
  assert.equal(r.financing!.downPayment, '20.00');
  assert.equal(r.financing!.financedBase, '90.00');
  assert.equal(r.financing!.installment, '22.50');
  assert.equal(r.financing!.scheduledTotal, '132.50');
  v.financing.allowAdditionalBalance = false;
  await assert.rejects(() => calculateResolvedCommercial(v), /not allowed/);
  v.financing = {
    ...v.financing,
    additionalBalance: '0',
    downPaymentRate: null,
    downPaymentAmount: '25',
  };
  assert.equal((await calculateResolvedCommercial(v)).financing!.downPayment, '25.00');
});
void test('canonical hash is deterministic and changes with price/rule/plan versions', async () => {
  const v = base();
  const a = await calculateResolvedCommercial(v);
  assert.equal(
    a.calculationHash,
    (await calculateResolvedCommercial(structuredClone(v))).calculationHash,
  );
  v.lines[0]!.quantity = '1.000';
  v.lines[0]!.unitPrice = '100.0000';
  assert.equal(a.calculationHash, (await calculateResolvedCommercial(v)).calculationHash);
  v.priceListVersion++;
  assert.notEqual(a.calculationHash, (await calculateResolvedCommercial(v)).calculationHash);
  v.financing = financing();
  const b = await calculateResolvedCommercial(v);
  v.financing.planVersion++;
  assert.notEqual(b.calculationHash, (await calculateResolvedCommercial(v)).calculationHash);
  v.rules = [
    {
      id: 'configured-rule',
      version: 1,
      kind: 'fixed_surcharge',
      value: '1.00',
      autoLimit: null,
      priority: 1,
    },
  ];
  const c = await calculateResolvedCommercial(v);
  v.rules[0]!.version++;
  assert.notEqual(c.calculationHash, (await calculateResolvedCommercial(v)).calculationHash);
});
void test('strict contracts reject supplied prices/rates/FX, cycles and active config input', () => {
  const request = {
    schemaVersion: 1,
    asOf: base().asOf,
    priceListId: id,
    lines: [{ kind: 'product', marketProductId: id, quantity: '1' }],
  };
  assert.equal(commercialCalculationRequest.safeParse(request).success, true);
  for (const extra of [{ unitPrice: '1' }, { taxRate: '0.15' }, { fxRate: '4' }, { totals: '0' }])
    assert.equal(commercialCalculationRequest.safeParse({ ...request, ...extra }).success, false);
  const configuration = {
    schemaVersion: 1,
    marketId: id,
    priceListId: id,
    stableKey: 'synthetic',
    name: 'Synthetic',
    expectedVersion: 0,
    validFrom: base().asOf,
    validTo: null,
    kind: 'bundle',
    pricingMode: 'COMPONENT_SUM',
    lines: [{ marketProductId: id, quantity: '1' }],
  };
  assert.equal(commercialConfigurationCreate.safeParse(configuration).success, true);
  assert.equal(
    commercialConfigurationCreate.safeParse({ ...configuration, status: 'active' }).success,
    false,
  );
  assert.equal(
    commercialConfigurationCreate.safeParse({
      ...configuration,
      lines: [{ bundleId: id, quantity: '1' }],
    }).success,
    false,
  );
});

void test('rule permutations have identical execution traces, totals and canonical hashes', async () => {
  const input = base();
  const discount = {
    id: 'discount',
    version: 1,
    kind: 'percentage_discount' as const,
    value: '0.1',
    autoLimit: '0.2',
    priority: 1,
  };
  const surcharge = {
    id: 'surcharge',
    version: 2,
    kind: 'fixed_surcharge' as const,
    value: '5',
    autoLimit: null,
    priority: 2,
  };
  const finalDiscount = {
    id: 'final-discount',
    version: 3,
    kind: 'fixed_discount' as const,
    value: '2',
    autoLimit: '3',
    priority: 3,
  };
  const permutations = [
    [discount, surcharge, finalDiscount],
    [discount, finalDiscount, surcharge],
    [surcharge, discount, finalDiscount],
    [surcharge, finalDiscount, discount],
    [finalDiscount, discount, surcharge],
    [finalDiscount, surcharge, discount],
  ];
  const expected = await calculateResolvedCommercial({ ...input, rules: permutations[0]! });
  assert.equal(expected.status, 'final');
  assert.equal(expected.totals.grandTotal, '93.00');
  for (const rules of permutations) {
    const provided = { ...input, rules };
    const before = structuredClone(provided);
    assert.deepEqual(await calculateResolvedCommercial(provided), expected);
    assert.deepEqual(provided, before, 'pure calculation must not mutate caller input');
  }
});

void test('bundle components are canonical while separate request-line order stays meaningful', async () => {
  const input = base();
  input.lines = [
    {
      ...input.lines[0]!,
      marketProductId: 'component-b',
      entryId: 'entry-b',
      unitPrice: '0.01',
      bundleId: 'bundle',
      bundleVersion: 1,
      requestLineIndex: 0,
    },
    {
      ...input.lines[0]!,
      marketProductId: 'component-a',
      entryId: 'entry-a',
      unitPrice: '0.01',
      bundleId: 'bundle',
      bundleVersion: 1,
      requestLineIndex: 0,
    },
    {
      ...input.lines[0]!,
      marketProductId: 'standalone',
      entryId: 'entry-c',
      unitPrice: '0.01',
      requestLineIndex: 1,
    },
  ];
  input.rules = [
    { id: 'penny', version: 1, kind: 'fixed_discount', value: '0.01', autoLimit: '1', priority: 1 },
  ];
  const expected = await calculateResolvedCommercial(input);
  assert.deepEqual(
    await calculateResolvedCommercial({
      ...input,
      lines: [input.lines[1]!, input.lines[0]!, input.lines[2]!],
    }),
    expected,
  );
  assert.deepEqual(
    expected.lines.map((l) => l.marketProductId),
    ['component-a', 'component-b', 'standalone'],
  );
  const reordered = input.lines.map((l) => ({ ...l, requestLineIndex: l.bundleId ? 1 : 0 }));
  assert.notEqual(
    (await calculateResolvedCommercial({ ...input, lines: reordered })).calculationHash,
    expected.calculationHash,
  );
});

void test('hash covers changed rule identity/value/limit/version and immutable price entry identity', async () => {
  const input = base();
  input.rules = [
    {
      id: 'discount',
      version: 1,
      kind: 'percentage_discount',
      value: '0.1',
      autoLimit: '0.2',
      priority: 1,
    },
  ];
  const expected = await calculateResolvedCommercial(input);
  for (const change of [
    { id: 'replacement-rule' },
    { version: 2 },
    { value: '0.11' },
    { autoLimit: '0.3' },
  ]) {
    const changed = structuredClone(input);
    Object.assign(changed.rules[0]!, change);
    assert.notEqual(
      (await calculateResolvedCommercial(changed)).calculationHash,
      expected.calculationHash,
    );
  }
  const superseded = structuredClone(input);
  superseded.lines[0]!.entryId = 'new-immutable-entry';
  assert.notEqual(
    (await calculateResolvedCommercial(superseded)).calculationHash,
    expected.calculationHash,
  );
  superseded.lines[0]!.entryVersion = 2 as 1;
  await assert.rejects(() => calculateResolvedCommercial(superseded), /Invalid input/);
  for (let repeat = 0; repeat < 3; repeat++)
    assert.deepEqual(await calculateResolvedCommercial(structuredClone(input)), expected);
});

void test('automatic limit is independent of the configured discount but remains bounded', () => {
  const input = {
    schemaVersion: 1,
    marketId: id,
    priceListId: id,
    stableKey: 'limits',
    name: 'Synthetic limits',
    expectedVersion: 0,
    validFrom: base().asOf,
    kind: 'rules',
    rules: [{ kind: 'percentage_discount', value: '0.1', autoLimit: '0.2', priority: 1 }],
  };
  assert.equal(commercialConfigurationCreate.safeParse(input).success, true);
  for (const limit of ['-0.1', '1.01', '100000000000000'])
    assert.equal(
      commercialConfigurationCreate.safeParse({
        ...input,
        rules: [{ ...input.rules[0], autoLimit: limit }],
      }).success,
      false,
    );
  assert.equal(
    commercialConfigurationCreate.safeParse({
      ...input,
      rules: [{ kind: 'fixed_discount', value: '5', autoLimit: '10', priority: 1 }],
    }).success,
    true,
  );
});
