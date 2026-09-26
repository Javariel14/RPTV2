import { z } from 'zod';

const uuid = z.uuid();
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/);
const instant = z.iso.datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/);
const evidence = z
  .object({
    sourceSystem: z.enum(['HYCITE', 'INCITE', 'DOCUCITE', 'RPT_USER', 'IMPORT', 'API']),
    sourceReference: z.string().trim().min(1).max(500),
    externalId: z.string().trim().min(1).max(160),
    observedAt: instant,
    authorityLevel: z.enum(['official', 'verified', 'authorized', 'import', 'manual']),
    evidenceLevel: z.enum([
      'exact_primary',
      'equivalent_market',
      'disclosure_by_code',
      'name_only',
      'pending',
    ]),
    sourceLiteral: z.string().trim().min(1).max(1000),
  })
  .strict();
export type CatalogEvidence = z.infer<typeof evidence>;

export const catalogMarketCreate = z
  .object({
    schemaVersion: z.literal(1),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    currency,
    timezone: z.string().trim().min(1).max(80),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    evidence: evidence.optional(),
  })
  .strict();
export type CatalogMarketCreate = z.infer<typeof catalogMarketCreate>;

export const currencyRegister = z
  .object({
    schemaVersion: z.literal(1),
    code: currency,
    name: z.string().trim().min(1).max(100),
    minorUnits: z.number().int().min(0).max(4),
  })
  .strict();
export type CurrencyRegister = z.infer<typeof currencyRegister>;
export const currencyStatus = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    status: z.enum(['active', 'inactive']),
  })
  .strict();
export type CurrencyStatus = z.infer<typeof currencyStatus>;
export const marketStatus = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    status: z.enum(['active', 'retired']),
  })
  .strict();
export type MarketStatus = z.infer<typeof marketStatus>;
export const adminMarketScopeGrant = z
  .object({
    schemaVersion: z.literal(1),
    userId: uuid,
    marketId: uuid,
  })
  .strict();
export type AdminMarketScopeGrant = z.infer<typeof adminMarketScopeGrant>;
export const actorMarketAssignment = z
  .object({
    schemaVersion: z.literal(1),
    userId: uuid,
    marketId: uuid,
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export type ActorMarketAssignment = z.infer<typeof actorMarketAssignment>;

export const marketProductCreate = z
  .object({
    schemaVersion: z.literal(1),
    marketId: uuid,
    nodeId: uuid,
    stableKey: key,
    displayName: z.string().trim().min(1).max(200),
    commercialCode: z.string().trim().min(1).max(100),
    availability: z.enum([
      'planned',
      'available',
      'temporarily_unavailable',
      'discontinued',
      'withdrawn',
    ]),
    effectiveAt: instant,
    evidence,
  })
  .strict();
export type MarketProductCreate = z.infer<typeof marketProductCreate>;

export const marketAvailabilityChange = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    status: z.enum([
      'planned',
      'available',
      'temporarily_unavailable',
      'discontinued',
      'withdrawn',
    ]),
    effectiveAt: instant,
    evidence,
  })
  .strict();
export type MarketAvailabilityChange = z.infer<typeof marketAvailabilityChange>;

export const priceListCreate = z
  .object({
    schemaVersion: z.literal(1),
    marketId: uuid,
    workspaceId: uuid,
    stableKey: key,
    name: z.string().trim().min(1).max(200),
    currency,
    status: z.literal('draft'),
    validFrom: instant,
    validTo: instant.nullable().default(null),
    evidence,
  })
  .strict()
  .refine((v) => v.validTo === null || Date.parse(v.validTo) > Date.parse(v.validFrom));
export type PriceListCreate = z.infer<typeof priceListCreate>;

export const priceListClose = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    validTo: instant,
  })
  .strict();
export type PriceListClose = z.infer<typeof priceListClose>;
export const priceListActivate = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type PriceListActivate = z.infer<typeof priceListActivate>;

export const priceEntryCreate = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    marketProductId: uuid,
    currency,
    amount: z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/),
    taxTreatment: z.enum(['tax_inclusive', 'tax_exclusive', 'tax_not_applicable', 'tax_unknown']),
    taxRate: z
      .string()
      .regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/)
      .nullable()
      .default(null),
    supersedesEntryId: uuid.optional(),
    validFrom: instant,
    validTo: instant.nullable().default(null),
    evidence,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.validTo !== null && Date.parse(v.validTo) <= Date.parse(v.validFrom))
      ctx.addIssue({ code: 'custom', message: 'invalid interval' });
    if (v.taxTreatment === 'tax_unknown' && v.taxRate !== null)
      ctx.addIssue({ code: 'custom', message: 'unknown tax cannot imply a rate' });
    if (['pending', 'name_only'].includes(v.evidence.evidenceLevel))
      ctx.addIssue({ code: 'custom', message: 'unconfirmed evidence cannot establish a price' });
  });
export type PriceEntryCreate = z.infer<typeof priceEntryCreate>;

export const marketCatalogQuery = z
  .object({ marketId: uuid, asOf: instant, limit: z.number().int().min(1).max(100).default(50) })
  .strict();
export const priceQuery = z
  .object({ priceListId: uuid, marketProductId: uuid, asOf: instant })
  .strict();
export const priceHistoryQuery = z
  .object({
    priceListId: uuid,
    marketProductId: uuid,
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const exchangeRateCreate = z
  .object({
    schemaVersion: z.literal(1),
    marketId: uuid,
    baseCurrency: currency,
    quoteCurrency: currency,
    rate: z.string().regex(/^(?:0|[1-9]\d{0,12})(?:\.\d{1,10})?$/),
    validFrom: instant,
    validTo: instant.nullable().default(null),
    supersedesRateId: uuid.optional(),
    evidence,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.baseCurrency === v.quoteCurrency || !/[1-9]/.test(v.rate))
      ctx.addIssue({ code: 'custom', message: 'rate and currency pair must be meaningful' });
    if (v.validTo !== null && Date.parse(v.validTo) <= Date.parse(v.validFrom))
      ctx.addIssue({ code: 'custom', message: 'invalid interval' });
    if (['pending', 'name_only'].includes(v.evidence.evidenceLevel))
      ctx.addIssue({ code: 'custom', message: 'unconfirmed evidence cannot establish a rate' });
  });
export type ExchangeRateCreate = z.infer<typeof exchangeRateCreate>;
export const exchangeRateQuery = z
  .object({ marketId: uuid, baseCurrency: currency, quoteCurrency: currency, asOf: instant })
  .strict();
export const referenceConversionQuery = exchangeRateQuery.extend({
  amount: z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/),
});
