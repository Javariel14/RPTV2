import { z } from 'zod';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,10})?$/);
const positive = decimal.refine((s) => /[1-9]/.test(s));
const interval = { validFrom: instant, validTo: instant.nullable().default(null) };
const common = {
  schemaVersion: z.literal(1),
  marketId: id,
  priceListId: id,
  stableKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  name: z.string().trim().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
  ...interval,
};
const bundleLine = z.object({ marketProductId: id, quantity: positive }).strict();
const rule = z
  .object({
    kind: z.enum([
      'percentage_discount',
      'fixed_discount',
      'percentage_surcharge',
      'fixed_surcharge',
    ]),
    value: decimal,
    autoLimit: decimal.nullable().default(null),
    priority: z.number().int().min(0).max(1000),
  })
  .strict();
const term = z
  .object({
    months: z.number().int().min(1).max(120),
    value: decimal,
  })
  .strict();
export const commercialConfigurationCreate = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('bundle'),
        pricingMode: z.enum(['COMPONENT_SUM', 'PUBLISHED_ANCHOR']),
        anchorMarketProductId: id.nullable().default(null),
        lines: z.array(bundleLine).min(1).max(50),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('rules'), rules: z.array(rule).min(1).max(20) }).strict(),
    z
      .object({
        ...common,
        kind: z.literal('financing'),
        mode: z.enum(['SURCHARGE_EQUAL_INSTALLMENTS', 'DOWN_PAYMENT_INSTALLMENT_FACTOR']),
        downPaymentRate: decimal.nullable().default(null),
        downPaymentAmount: decimal.nullable().default(null),
        allowAdditionalBalance: z.boolean().default(false),
        terms: z.array(term).min(1).max(20),
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.validTo && Date.parse(v.validTo) <= Date.parse(v.validFrom)) bad('invalid interval');
    // Rates use string validation, not floating point arithmetic.
    const unitRate = (s: string) => /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(s);
    if (v.kind === 'bundle') {
      if ((v.pricingMode === 'PUBLISHED_ANCHOR') !== (v.anchorMarketProductId !== null))
        bad('anchor mode mismatch');
      if (new Set(v.lines.map((l) => l.marketProductId)).size !== v.lines.length)
        bad('duplicate component');
    }
    if (v.kind === 'rules') {
      if (new Set(v.rules.map((r) => r.priority)).size !== v.rules.length)
        bad('ambiguous rule order');
      for (const r of v.rules) {
        if (r.kind.startsWith('percentage') && !unitRate(r.value)) bad('rate exceeds one');
        if (r.autoLimit !== null && !r.kind.endsWith('discount'))
          bad('only discounts have approval limits');
        if (r.kind.startsWith('percentage') && r.autoLimit !== null && !unitRate(r.autoLimit))
          bad('invalid approval rate');
      }
    }
    if (v.kind === 'financing') {
      if (new Set(v.terms.map((t) => t.months)).size !== v.terms.length) bad('duplicate term');
      if (v.downPaymentRate !== null && !unitRate(v.downPaymentRate)) bad('invalid down payment');
      if (
        v.mode === 'SURCHARGE_EQUAL_INSTALLMENTS' &&
        (v.downPaymentRate !== null || v.downPaymentAmount !== null || v.allowAdditionalBalance)
      )
        bad('surcharge plan cannot have a down payment');
      if (
        v.mode === 'DOWN_PAYMENT_INSTALLMENT_FACTOR' &&
        (v.downPaymentRate === null) === (v.downPaymentAmount === null)
      )
        bad('exactly one down payment policy required');
      if (
        v.mode === 'DOWN_PAYMENT_INSTALLMENT_FACTOR' &&
        v.terms.some((t) => !/[1-9]/.test(t.value))
      )
        bad('factor must be positive');
    }
  });
export type CommercialConfigurationCreate = z.infer<typeof commercialConfigurationCreate>;
export const commercialConfigurationTransition = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    action: z.enum(['activate', 'retire']),
    effectiveAt: instant,
  })
  .strict();
export const commercialCalculationRequest = z
  .object({
    schemaVersion: z.literal(1),
    asOf: instant,
    priceListId: id,
    marketId: id.optional(),
    lines: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({ kind: z.literal('product'), marketProductId: id, quantity: positive })
            .strict(),
          z.object({ kind: z.literal('bundle'), bundleId: id, quantity: positive }).strict(),
        ]),
      )
      .min(1)
      .max(50),
    ruleSetId: id.optional(),
    requestedDiscountRuleId: id.optional(),
    financing: z
      .object({ planId: id, termId: id, additionalBalance: decimal.default('0') })
      .strict()
      .optional(),
  })
  .strict();
export type CommercialCalculationRequest = z.infer<typeof commercialCalculationRequest>;
export const commercialEvidenceAppend = z
  .object({
    schemaVersion: z.literal(1),
    versionId: id,
    evidence: z
      .object({
        sourceSystem: z.enum(['HYCITE', 'INCITE', 'DOCUCITE', 'RPT_USER', 'IMPORT', 'API']),
        sourceReference: z.string().trim().min(1).max(500),
        externalId: z.string().trim().min(1).max(160),
        observedAt: instant,
        authorityLevel: z.enum(['official', 'verified', 'authorized', 'import', 'manual']),
        evidenceLevel: z.enum([
          'exact_primary',
          'component_primary',
          'equivalent_market',
          'disclosure_by_code',
          'name_only',
          'pending',
        ]),
        sourceLiteral: z.string().trim().min(1).max(1000),
      })
      .strict(),
  })
  .strict();
export interface OfficialCommercialPrice {
  marketProductId: string;
  quantity: string;
  entryId: string;
  entryVersion: 1;
  unitPrice: string;
  taxTreatment: 'tax_inclusive' | 'tax_exclusive' | 'tax_not_applicable' | 'tax_unknown';
  taxRate: string | null;
  bundleId?: string;
  bundleVersion?: number;
  /** Resolver-owned request position; bundled components share their parent position. */
  requestLineIndex?: number;
}
export interface ResolvedCommercialRule {
  id: string;
  version: number;
  kind: z.infer<typeof rule>['kind'];
  value: string;
  autoLimit: string | null;
  priority: number;
}
export interface ResolvedCommercialFinancing {
  planId: string;
  planVersion: number;
  termId: string;
  termVersion: number;
  months: number;
  mode: 'SURCHARGE_EQUAL_INSTALLMENTS' | 'DOWN_PAYMENT_INSTALLMENT_FACTOR';
  value: string;
  downPaymentRate: string | null;
  downPaymentAmount: string | null;
  allowAdditionalBalance: boolean;
  additionalBalance: string;
}
export interface ResolvedCommercialInput {
  schemaVersion: 1;
  asOf: string;
  effectiveMarketId: string;
  priceListId: string;
  priceListVersion: number;
  currency: string;
  minorUnits: number;
  lines: OfficialCommercialPrice[];
  rules: ResolvedCommercialRule[];
  financing?: ResolvedCommercialFinancing;
}

const resultDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const traceId = z.string().min(1);
const traceVersion = z.number().int().positive();
export const commercialCalculationResult = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(['final', 'requires_approval', 'incomplete_tax_semantics']),
    requiresApproval: z.boolean(),
    effectiveMarketId: traceId,
    asOf: instant,
    priceListId: traceId,
    priceListVersion: traceVersion,
    currency: z.string().regex(/^[A-Z]{3}$/),
    minorUnits: z.number().int().min(0).max(4),
    roundingPolicy: z.literal('ROUND_HALF_UP'),
    lines: z
      .array(
        z
          .object({
            marketProductId: traceId,
            quantity: resultDecimal,
            entryId: traceId,
            entryVersion: z.literal(1),
            unitPrice: resultDecimal,
            lineBaseAmount: resultDecimal,
            taxTreatment: z.enum([
              'tax_inclusive',
              'tax_exclusive',
              'tax_not_applicable',
              'tax_unknown',
            ]),
            taxRate: resultDecimal.nullable(),
            bundleId: traceId.optional(),
            bundleVersion: traceVersion.optional(),
            requestLineIndex: z.number().int().nonnegative().optional(),
            net: resultDecimal.nullable(),
            tax: resultDecimal.nullable(),
            gross: resultDecimal.nullable(),
            appliedAdjustments: z.array(
              z.object({ id: traceId, version: traceVersion, amount: resultDecimal }).strict(),
            ),
          })
          .strict(),
      )
      .min(1)
      .max(250),
    appliedRules: z.array(
      z
        .object({
          id: traceId,
          version: traceVersion,
          kind: rule.shape.kind,
          value: resultDecimal,
          autoLimit: resultDecimal.nullable(),
          priority: rule.shape.priority,
        })
        .strict(),
    ),
    financing: z
      .object({
        planId: traceId,
        planVersion: traceVersion,
        termId: traceId,
        termVersion: traceVersion,
        months: term.shape.months,
        mode: z.enum(['SURCHARGE_EQUAL_INSTALLMENTS', 'DOWN_PAYMENT_INSTALLMENT_FACTOR']),
        value: resultDecimal,
        downPaymentRate: resultDecimal.nullable(),
        downPaymentAmount: resultDecimal.nullable(),
        allowAdditionalBalance: z.boolean(),
        additionalBalance: resultDecimal,
        downPayment: resultDecimal,
        financedBase: resultDecimal,
        surcharge: resultDecimal,
        installment: resultDecimal,
        installments: z.array(resultDecimal).min(1).max(120),
        lastInstallment: resultDecimal,
        scheduledTotal: resultDecimal,
      })
      .strict()
      .optional(),
    totals: z
      .object({
        subtotal: resultDecimal.nullable(),
        taxTotal: resultDecimal.nullable(),
        discountTotal: resultDecimal,
        surchargeTotal: resultDecimal,
        grandTotal: resultDecimal.nullable(),
      })
      .strict(),
    calculationHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CommercialCalculationResult = z.infer<typeof commercialCalculationResult>;
