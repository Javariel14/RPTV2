import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { orderDetailRead } from '@rpt/contracts';
import { localFixtureTime } from '../helpers/local-business-day.js';
import {
  addCalendarDays,
  agendaAnchorForTimeZone,
  calendarDayInTimeZone,
  localInput,
  rangeFor,
} from '../../apps/web/app/agenda-time.js';
import { OrderHttpError, protectedOrderDenial } from '../../apps/web/app/use-order-data.js';
import {
  exactAmount,
  historyLabel,
  historyView,
  listView,
  snapshotView,
  statusLabel,
  taxLabel,
  unavailable,
} from '../../apps/web/app/order-view-model.js';

void test('Ecuador synthetic today is stable across UTC and business midnight', () => {
  for (const day of ['2026-10-04', '2027-12-31']) {
    const origin = new Date(`${day}T23:52:00Z`);
    for (const offset of [0, 4 * 3_600_000, 5 * 3_600_000 + 8 * 60_000]) {
      const now = new Date(origin.getTime() + offset);
      const anchor = localInput(now.toISOString(), 'America/Guayaquil').slice(0, 10);
      const range = rangeFor(anchor, 'today', 'America/Guayaquil');
      const today = localFixtureTime(now, 0, 10).toISOString();
      assert.ok(today >= range.from && today < range.to);
      assert.equal(localInput(today, 'America/Guayaquil'), `${anchor}T10:00`);
      assert.ok(localFixtureTime(now, 1, 11).toISOString() >= range.to);
    }
  }
});
void test('Agenda calendar day follows an explicit timezone across calendar boundaries', () => {
  for (const [instant, timezone, expected] of [
    ['2026-10-04T23:52:00Z', 'America/Guayaquil', '2026-10-04'],
    ['2026-10-05T03:52:00Z', 'America/Guayaquil', '2026-10-04'],
    ['2026-10-05T05:00:00Z', 'America/Guayaquil', '2026-10-05'],
    ['2026-11-01T03:59:00Z', 'America/Guayaquil', '2026-10-31'],
    ['2027-01-01T03:59:00Z', 'America/Guayaquil', '2026-12-31'],
    ['2026-10-04T12:30:00Z', 'Pacific/Kiritimati', '2026-10-05'],
  ] as const) {
    assert.equal(calendarDayInTimeZone(instant, timezone), expected);
    const range = rangeFor(expected, 'today', timezone);
    for (const boundary of [range.from, new Date(Date.parse(range.to) - 1)])
      assert.equal(calendarDayInTimeZone(boundary, timezone), expected);
  }
  assert.throws(() => calendarDayInTimeZone('2026-10-05T03:52:00Z', 'Invalid/Zone'));
  assert.equal(addCalendarDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addCalendarDays('2026-12-31', 7), '2027-01-07');
});
void test('Authenticated Agenda timezone resyncs only an automatic today anchor', () => {
  const instant = '2026-10-05T03:52:00Z';
  const fallbackDay = calendarDayInTimeZone(instant, 'UTC');
  assert.equal(fallbackDay, '2026-10-05');
  assert.equal(
    agendaAnchorForTimeZone(fallbackDay, true, instant, 'America/Guayaquil'),
    '2026-10-04',
  );
  const manualDay = '2026-09-20';
  assert.equal(agendaAnchorForTimeZone(manualDay, false, instant, 'America/Guayaquil'), manualDay);
  assert.equal(
    agendaAnchorForTimeZone(manualDay, true, instant, 'America/Guayaquil'),
    '2026-10-04',
  );
});
void test('Only authoritative authorization/session denials invalidate protected Order state', () => {
  for (const status of [401, 403, 404])
    assert.ok(protectedOrderDenial(new OrderHttpError(status, 'safe')));
  for (const status of [422, 500, 503])
    assert.equal(protectedOrderDenial(new OrderHttpError(status, 'safe')), false);
});

void test('Order UI labels are presentation-only and unknown values fail safely', () => {
  assert.deepEqual(['created', 'cancelled', 'superseded'].map(statusLabel), [
    'Creada',
    'Cancelada',
    'Reemplazada',
  ]);
  for (const value of [null, undefined, 'paid', {}, 0])
    assert.equal(statusLabel(value), unavailable);
  assert.equal(historyLabel('technical_bootstrap'), 'Inicialización del sistema');
  assert.equal(historyLabel('cancel'), 'Cancelación registrada');
  assert.equal(historyLabel('replace'), 'Reemplazo registrado');
  assert.equal(historyLabel('unknown'), unavailable);
  assert.equal(taxLabel('tax_inclusive'), 'Impuesto incluido');
});
void test('Financial presentation preserves decimals beyond binary numeric precision', () => {
  assert.equal(
    exactAmount('9007199254740993.1234567890', 'USD', 2, 'en-US'),
    'USD 9,007,199,254,740,993.1234567890',
  );
  assert.equal(exactAmount('1234.50', 'EUR', 2, 'de-DE'), 'EUR 1.234,50');
  assert.equal(exactAmount('0.0001', 'USD', 2, 'en-US'), 'USD 0.0001');
  assert.equal(exactAmount('12', 'USD', 2, 'en-US'), 'USD 12.00');
  assert.equal(exactAmount('12.30', 'JPY', 0, 'en-US'), 'JPY 12.30');
  assert.equal(exactAmount('12', 'JPY', 0, 'en-US'), 'JPY 12');
  assert.equal(exactAmount('0', 'USD', 4, 'en-US'), 'USD 0.0000');
});
void test('Missing and malformed financial values never silently become zero', () => {
  for (const value of [
    null,
    undefined,
    '',
    '01',
    '-1',
    'NaN',
    '1e5',
    10,
    '1.',
    '1,00',
    'x'.repeat(1025),
  ])
    assert.equal(exactAmount(value, 'USD', 2), unavailable);
  for (const [currency, units] of [
    ['usd', 2],
    ['USD', -1],
    ['USD', 5],
    ['USD', 1.5],
  ] as const)
    assert.equal(exactAmount('10', currency, units), unavailable);
  assert.notEqual(exactAmount(null, 'USD', 2), exactAmount('0', 'USD', 2));
});
void test('Catalog mapping keeps authoritative lines, bundle and immutable semantics', () => {
  const id = randomUUID(),
    date = '2026-10-04T00:00:00.000Z';
  const catalog = {
    marketProductId: id,
    marketId: id,
    nodeId: id,
    displayName: 'Synthetic pot',
    commercialCode: 'SYN-POT',
    path: [{ id, kind: 'product', stableKey: 'pot', name: 'Pot' }],
  };
  const commercial = {
    marketProductId: id,
    quantity: '2',
    entryId: id,
    entryVersion: 1,
    unitPrice: '100.50',
    lineBaseAmount: '201.00',
    taxTreatment: 'tax_inclusive',
    taxRate: '0.15',
    net: null,
    tax: null,
    gross: '201.00',
    appliedAdjustments: [{ id, version: 1, amount: '20.10' }],
  };
  const order = orderDetailRead.parse({
    schemaVersion: 1,
    id,
    businessOrderNumber: 'ORD-0000000001',
    workspaceId: id,
    marketId: id,
    quoteId: id,
    quoteVersionId: id,
    acceptanceId: id,
    currency: 'USD',
    status: 'created',
    lifecycleVersion: 1,
    createdAt: date,
    calculationHash: 'a'.repeat(64),
    commercialSnapshot: {
      schemaVersion: 1,
      status: 'final',
      requiresApproval: false,
      effectiveMarketId: id,
      asOf: date,
      priceListId: id,
      priceListVersion: 1,
      currency: 'USD',
      minorUnits: 2,
      roundingPolicy: 'ROUND_HALF_UP',
      lines: [commercial],
      appliedRules: [],
      totals: {
        subtotal: null,
        taxTotal: null,
        discountTotal: '20.10',
        surchargeTotal: '0',
        grandTotal: '180.90',
      },
      calculationHash: 'a'.repeat(64),
    },
    lines: [{ commercial, catalog, bundleComposition: [{ catalog, quantity: '2' }] }],
  });
  const before = JSON.stringify(order),
    view = snapshotView(order);
  assert.equal(view.immutable, true);
  assert.equal(view.lines[0]!.name, 'Synthetic pot');
  assert.equal(view.lines[0]!.quantity, '2');
  assert.equal(view.lines[0]!.net, unavailable);
  assert.deepEqual(view.lines[0]!.bundle, ['2 × Synthetic pot (SYN-POT)']);
  assert.equal(view.lines[0]!.adjustments[0]!.amount, '20.10');
  assert.equal(listView(order).statusLabel, 'Creada');
  assert.equal(JSON.stringify(order), before);
  assert.equal(
    historyView({
      schemaVersion: 1,
      id,
      sequence: 2,
      operation: 'cancel',
      previousStatus: 'created',
      status: 'cancelled',
      reason: 'Synthetic',
      recordedAt: date,
    }).stateLabel,
    'Creada → Cancelada',
  );
});
