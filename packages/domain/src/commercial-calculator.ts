import { commercialCalculationResult, type ResolvedCommercialInput } from '@rpt/contracts';
import { Exact } from './commercial-decimal.js';

const zero = Exact.parse('0');
const one = Exact.parse('1');
/** JSON key ordering is canonical; array ordering is meaningful and resolved explicitly. */
export function canonicalCommercial(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCommercial).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalCommercial(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function calculateResolvedCommercial(provided: ResolvedCommercialInput) {
  const decimal = (s: string) =>
    Exact.parse(s)
      .format(20)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  const nullable = (s: string | null) => (s === null ? null : decimal(s));
  const input: ResolvedCommercialInput = {
    ...provided,
    asOf: new Date(provided.asOf).toISOString(),
    lines: provided.lines
      .map((l, index) => {
        if (l.bundleId && l.requestLineIndex === undefined)
          throw new RangeError('bundle request position required');
        const requestLineIndex = l.requestLineIndex ?? index;
        if (!Number.isSafeInteger(requestLineIndex) || requestLineIndex < 0)
          throw new RangeError('invalid request position');
        return {
          ...l,
          requestLineIndex,
          quantity: decimal(l.quantity),
          unitPrice: decimal(l.unitPrice),
          taxRate: nullable(l.taxRate),
        };
      })
      .sort((a, b) => {
        // Top-level request order is meaningful. Components of one bundle request
        // are an unordered collection, including for allocation remainder ties.
        const position = a.requestLineIndex - b.requestLineIndex;
        if (position) return position;
        if (!a.bundleId || a.bundleId !== b.bundleId || a.bundleVersion !== b.bundleVersion)
          throw new RangeError('ambiguous request position');
        if (a.marketProductId !== b.marketProductId)
          return a.marketProductId < b.marketProductId ? -1 : 1;
        const left = canonicalCommercial(a),
          right = canonicalCommercial(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    rules: provided.rules
      .map((r) => ({
        ...r,
        value: decimal(r.value),
        autoLimit: nullable(r.autoLimit),
      }))
      .sort((a, b) => a.priority - b.priority),
    ...(provided.financing
      ? {
          financing: {
            ...provided.financing,
            value: decimal(provided.financing.value),
            downPaymentRate: nullable(provided.financing.downPaymentRate),
            downPaymentAmount: nullable(provided.financing.downPaymentAmount),
            additionalBalance: decimal(provided.financing.additionalBalance),
          },
        }
      : {}),
  };
  const money = (v: Exact) => v.format(input.minorUnits);
  const round = (v: Exact) => Exact.parse(money(v));
  const sum = (v: Exact[]) => v.reduce((a, b) => a.add(b), zero);
  const rules = input.rules;
  if (new Set(rules.map((r) => r.priority)).size !== rules.length)
    throw new RangeError('ambiguous rules');
  let incomplete = false,
    approval = false;
  const lines = input.lines.map((l) => {
    const price = Exact.parse(l.unitPrice),
      quantity = Exact.parse(l.quantity);
    if (price.compare(zero) < 0 || quantity.compare(zero) <= 0)
      throw new RangeError('invalid line');
    const base = round(price.mul(quantity));
    const unknown =
      l.taxTreatment === 'tax_unknown' ||
      (l.taxTreatment !== 'tax_not_applicable' && l.taxRate === null);
    incomplete ||= unknown;
    const rate = l.taxTreatment === 'tax_not_applicable' ? zero : Exact.parse(l.taxRate ?? '0');
    if (rate.compare(zero) < 0 || rate.compare(one) > 0) throw new RangeError('invalid tax rate');
    const net = l.taxTreatment === 'tax_inclusive' ? round(base.div(one.add(rate))) : base;
    const tax = l.taxTreatment === 'tax_inclusive' ? base.sub(net) : round(net.mul(rate));
    return {
      source: l,
      base,
      net,
      tax,
      rate,
      unknown,
      adjustments: [] as { id: string; version: number; amount: string }[],
    };
  });
  const initialNet = sum(lines.map((l) => l.net));
  let discounts = zero,
    surcharges = zero;
  const appliedRules: ResolvedCommercialInput['rules'] = [];
  if (!incomplete)
    for (const rule of rules) {
      const current = sum(lines.map((l) => l.net)),
        value = Exact.parse(rule.value);
      const discount = rule.kind.endsWith('discount');
      if (value.compare(zero) < 0) throw new RangeError('negative rule');
      if (discount && rule.autoLimit !== null && value.compare(Exact.parse(rule.autoLimit)) > 0)
        approval = true;
      const adjustment = round(rule.kind.startsWith('percentage') ? current.mul(value) : value);
      if (discount && adjustment.compare(current) > 0)
        throw new RangeError('discount exceeds eligible base');
      if (current.compare(zero) === 0 && adjustment.compare(zero) !== 0)
        throw new RangeError('cannot allocate adjustment');
      const factor = 10n ** BigInt(input.minorUnits);
      const allocations = lines.map((l) => {
        const share = current.compare(zero) === 0 ? zero : adjustment.mul(l.net).div(current);
        return (share.numerator * factor) / share.denominator;
      });
      let remaining =
        (adjustment.numerator * factor) / adjustment.denominator -
        allocations.reduce((a, b) => a + b, 0n);
      // Largest remainder allocation in source-line order on ties. Never assigns
      // a negative remainder to a small/zero final line.
      const ranked = lines
        .map((l, index) => {
          const share =
            current.compare(zero) === 0
              ? zero
              : adjustment.mul(l.net).div(current).mul(new Exact(factor));
          return { index, remainder: share.sub(new Exact(allocations[index]!)) };
        })
        .sort((a, b) => b.remainder.compare(a.remainder) || a.index - b.index);
      for (const r of ranked)
        if (remaining > 0n) {
          allocations[r.index] = allocations[r.index]! + 1n;
          remaining--;
        }
      lines.forEach((l, index) => {
        const part = new Exact(allocations[index]!, factor);
        l.net = discount ? l.net.sub(part) : l.net.add(part);
        if (l.net.compare(zero) < 0) throw new RangeError('negative adjusted line');
        // A zero adjustment must not re-derive rounded inclusive tax and thereby
        // change the published gross by a minor unit.
        if (part.compare(zero) !== 0) l.tax = round(l.net.mul(l.rate));
        l.adjustments.push({ id: rule.id, version: rule.version, amount: money(part) });
      });
      if (discount) discounts = discounts.add(adjustment);
      else surcharges = surcharges.add(adjustment);
      appliedRules.push({ ...rule });
    }
  const taxTotal = sum(lines.map((l) => l.tax));
  const grand = sum(lines.map((l) => l.net.add(l.tax)));
  let financing;
  if (input.financing && !incomplete) {
    const f = input.financing,
      value = Exact.parse(f.value),
      additional = Exact.parse(f.additionalBalance);
    if (
      additional.compare(zero) < 0 ||
      (!f.allowAdditionalBalance && additional.compare(zero) !== 0)
    )
      throw new RangeError('additional balance not allowed');
    const down =
      f.mode === 'SURCHARGE_EQUAL_INSTALLMENTS'
        ? zero
        : round(
            f.downPaymentRate !== null
              ? grand.mul(Exact.parse(f.downPaymentRate))
              : Exact.parse(f.downPaymentAmount ?? '0'),
          );
    if (down.compare(zero) < 0 || down.compare(grand) > 0 || value.compare(zero) < 0)
      throw new RangeError('invalid financing');
    const balance = round(grand.sub(down).add(additional));
    const surcharge = f.mode === 'SURCHARGE_EQUAL_INSTALLMENTS' ? round(balance.mul(value)) : zero;
    const installment = round(
      f.mode === 'SURCHARGE_EQUAL_INSTALLMENTS'
        ? balance.add(surcharge).div(new Exact(BigInt(f.months)))
        : balance.mul(value),
    );
    const financedTotal =
      f.mode === 'SURCHARGE_EQUAL_INSTALLMENTS'
        ? balance.add(surcharge)
        : installment.mul(new Exact(BigInt(f.months)));
    // Equal rounded installments can leave a remainder; the last payment is
    // explicitly reconciled, never hidden as an inconsistent scheduled total.
    const unit = 10n ** BigInt(input.minorUnits);
    const totalUnits = (financedTotal.numerator * unit) / financedTotal.denominator;
    const floorPayment = totalUnits / BigInt(f.months),
      extraPayments = totalUnits % BigInt(f.months);
    const installments = Array.from({ length: f.months }, (_, i) =>
      money(new Exact(floorPayment + (BigInt(i) < extraPayments ? 1n : 0n), unit)),
    );
    const lastInstallment = installments[installments.length - 1]!;
    financing = {
      ...f,
      downPayment: money(down),
      financedBase: money(balance),
      surcharge: money(surcharge),
      installment: money(installment),
      installments,
      lastInstallment,
      scheduledTotal: money(financedTotal.add(down)),
    };
  }
  const output = {
    schemaVersion: 1 as const,
    status: incomplete
      ? ('incomplete_tax_semantics' as const)
      : approval
        ? ('requires_approval' as const)
        : ('final' as const),
    requiresApproval: approval,
    effectiveMarketId: input.effectiveMarketId,
    asOf: input.asOf,
    priceListId: input.priceListId,
    priceListVersion: input.priceListVersion,
    currency: input.currency,
    minorUnits: input.minorUnits,
    roundingPolicy: 'ROUND_HALF_UP' as const,
    lines: lines.map((l) => ({
      ...l.source,
      unitPrice: money(Exact.parse(l.source.unitPrice)),
      lineBaseAmount: money(l.base),
      net: l.unknown ? null : money(l.net),
      tax: l.unknown ? null : money(l.tax),
      gross: l.unknown ? null : money(l.net.add(l.tax)),
      appliedAdjustments: l.adjustments,
    })),
    appliedRules,
    financing,
    totals: {
      subtotal: incomplete ? null : money(initialNet),
      taxTotal: incomplete ? null : money(taxTotal),
      discountTotal: money(discounts),
      surchargeTotal: money(surcharges),
      grandTotal: incomplete ? null : money(grand),
    },
  };
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalCommercial({ input, output })),
  );
  return commercialCalculationResult.parse({
    ...output,
    calculationHash: Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join(
      '',
    ),
  });
}
