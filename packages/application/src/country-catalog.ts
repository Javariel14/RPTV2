import type { Client } from 'pg';
import {
  FoundationError,
  type CatalogEvidence,
  type CatalogMarketCreate,
  type MarketProductCreate,
  type MarketAvailabilityChange,
  type PriceListCreate,
  type PriceListClose,
  type PriceEntryCreate,
  type CurrencyRegister,
  type CurrencyStatus,
  type MarketStatus,
  type AdminMarketScopeGrant,
  type ActorMarketAssignment,
  type PriceListActivate,
  type ExchangeRateCreate,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';
import { productNode } from '@rpt/persistence/product-master';
import {
  commerceCan,
  commerceReceipt,
  commerceFinish,
  marketByCode,
  insertMarket,
  insertCatalogMarket,
  listMarkets,
  catalogMarket,
  marketProduct,
  insertMarketProduct,
  latestAvailability,
  insertAvailability,
  bumpMarketProduct,
  listCatalog,
  priceList,
  insertPriceList,
  closePriceList,
  bumpPriceList,
  insertPriceEntry,
  closeSupersededPriceEntry,
  currentPrice,
  priceHistory,
  insertCommerceObservation,
  registerCurrency,
  currencyDetail,
  setCurrencyStatus,
  setMarketStatus,
  grantMarketScope,
  revokeMarketScope,
  lockMarketActor,
  currentActorMarket,
  closeActorMarket,
  insertActorMarket,
  effectiveActorMarket,
  activatePriceList,
  retireExchangeRate,
  insertExchangeRate,
  currentExchangeRate,
  convertReference,
} from '@rpt/persistence/country-catalog';

const catalogRead =
  "SELECT authz.tenant_allowed(authz.tenant_id(),'catalog','read','CONFIDENTIAL') AS allowed";
const catalogCreate =
  "SELECT authz.tenant_allowed(authz.tenant_id(),'catalog','create','CONFIDENTIAL') AS allowed";
const pricingRead =
  "SELECT authz.tenant_allowed(authz.tenant_id(),'pricing','read','CONFIDENTIAL') AS allowed";
function canonicalAmount(value: string, scale: number) {
  const [whole, fractional = ''] = value.split('.');
  return `${whole}.${fractional.padEnd(scale, '0')}`;
}
async function observation(
  client: Client,
  context: AuthContext,
  domain: 'market_catalog' | 'pricing' | 'fx',
  subjectType: 'market' | 'market_product' | 'price_list',
  subjectId: string,
  evidence: CatalogEvidence,
  facts: Record<string, string | null>,
) {
  if (
    !(await commerceCan(client, 'SELECT authz.commerce_source_right($1,$2,$3) AS allowed', [
      domain,
      evidence.sourceSystem,
      evidence.authorityLevel,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ domain, subjectType, subjectId, evidence, facts })),
  );
  const rawHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  const id = crypto.randomUUID();
  await insertCommerceObservation(client, context, {
    id,
    domain,
    subjectType,
    subjectId,
    sourceSystem: evidence.sourceSystem,
    sourceReference: evidence.sourceReference,
    externalId: evidence.externalId,
    observedAt: evidence.observedAt,
    authorityLevel: evidence.authorityLevel,
    rawHash,
    facts: {
      ...facts,
      sourceLiteral: evidence.sourceLiteral,
      evidenceLevel: evidence.evidenceLevel,
    },
  });
  return id;
}

async function globalAdmin(client: Client) {
  if (
    !(await commerceCan(
      client,
      `SELECT authz.session_valid()
    AND authz.capable(authz.actor_id(),'market_admin','manage','CONFIDENTIAL')
    AND authz.capable(authz.actor_id(),'market_admin','global','CONFIDENTIAL') AS allowed`,
    ))
  )
    throw new FoundationError('FORBIDDEN');
}
async function marketAdmin(client: Client, marketId: string, verb: 'read' | 'manage' = 'manage') {
  if (
    !(await commerceCan(client, 'SELECT authz.market_admin_scope($1,$2) AS allowed', [
      marketId,
      verb,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
}
async function validUser(client: Client, userId: string) {
  if (!(await commerceCan(client, 'SELECT authz.market_user_exists($1) AS allowed', [userId])))
    throw new FoundationError('NOT_FOUND');
}
export async function catalogOperationalMarket(client: Client) {
  return effectiveActorMarket(client);
}
export async function createCurrency(
  client: Client,
  context: AuthContext,
  input: CurrencyRegister,
  key: string,
  hash: string,
) {
  await globalAdmin(client);
  if (
    !Intl.supportedValuesOf('currency').includes(input.code) ||
    new Intl.NumberFormat('en', { style: 'currency', currency: input.code }).resolvedOptions()
      .maximumFractionDigits !== input.minorUnits
  )
    throw new FoundationError('INVALID_REQUEST');
  const prior = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (prior) return prior;
  await registerCurrency(client, context, input);
  return commerceFinish(client, 'catalog.v1', key, { id: input.code, version: 1 });
}
export async function changeCurrencyStatus(
  client: Client,
  code: string,
  input: CurrencyStatus,
  key: string,
  hash: string,
) {
  await globalAdmin(client);
  const prior = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (prior) return prior;
  const currency = await currencyDetail(client, code);
  if (!currency) throw new FoundationError('NOT_FOUND');
  if (currency.version !== input.expectedVersion || currency.status === input.status)
    throw new FoundationError('CONFLICT');
  const version = await setCurrencyStatus(client, code, input.expectedVersion, input.status);
  if (!version) throw new FoundationError('CONFLICT');
  return commerceFinish(client, 'catalog.v1', key, { id: code, version });
}
export async function grantCatalogMarketScope(
  client: Client,
  context: AuthContext,
  input: AdminMarketScopeGrant,
  key: string,
  hash: string,
) {
  await globalAdmin(client);
  await validUser(client, input.userId);
  if (!(await catalogMarket(client, input.marketId))) throw new FoundationError('NOT_FOUND');
  const prior = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (prior) return prior;
  const id = crypto.randomUUID();
  await grantMarketScope(client, context, input.userId, input.marketId, id);
  return commerceFinish(client, 'catalog.v1', key, { id, version: 1 });
}
export async function revokeCatalogMarketScope(
  client: Client,
  id: string,
  key: string,
  hash: string,
) {
  await globalAdmin(client);
  const prior = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (prior) return prior;
  if (!(await revokeMarketScope(client, id))) throw new FoundationError('NOT_FOUND');
  return commerceFinish(client, 'catalog.v1', key, { id, version: 2 });
}
export async function assignCatalogActorMarket(
  client: Client,
  context: AuthContext,
  input: ActorMarketAssignment,
  key: string,
  hash: string,
) {
  if (input.userId === context.actorId) throw new FoundationError('FORBIDDEN');
  await marketAdmin(client, input.marketId);
  await validUser(client, input.userId);
  const market = await catalogMarket(client, input.marketId);
  if (!market || market.status !== 'active') throw new FoundationError('CONFLICT');
  const prior = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (prior) return prior;
  await lockMarketActor(client, context.tenantId, input.userId);
  const previous = await currentActorMarket(client, input.userId);
  if ((previous?.version ?? 0) !== input.expectedVersion || previous?.market_id === input.marketId)
    throw new FoundationError('CONFLICT');
  if (previous) await marketAdmin(client, previous.market_id);
  const at = (
    await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
  ).rows[0]!.at.toISOString();
  if (previous && !(await closeActorMarket(client, previous.id, previous.version, at)))
    throw new FoundationError('CONFLICT');
  const id = crypto.randomUUID();
  await insertActorMarket(client, context, id, input.userId, input.marketId, input.reason, at);
  return commerceFinish(client, 'catalog.v1', key, { id, version: 1 });
}
export async function changeCatalogMarketStatus(
  client: Client,
  id: string,
  input: MarketStatus,
  key: string,
  hash: string,
) {
  await marketAdmin(client, id);
  const market = await catalogMarket(client, id);
  if (!market) throw new FoundationError('NOT_FOUND');
  const prior = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (prior) return prior;
  if (
    market.version !== input.expectedVersion ||
    (input.status === 'active' && market.status !== 'draft') ||
    (input.status === 'retired' && market.status !== 'active')
  )
    throw new FoundationError('CONFLICT');
  const version = await setMarketStatus(client, id, input.expectedVersion, input.status);
  if (!version) throw new FoundationError('CONFLICT');
  return commerceFinish(client, 'catalog.v1', key, { id, version });
}

export async function catalogMarkets(client: Client) {
  if (!(await commerceCan(client, catalogRead))) throw new FoundationError('FORBIDDEN');
  return listMarkets(client);
}
export async function createCatalogMarket(
  client: Client,
  context: AuthContext,
  input: CatalogMarketCreate,
  key: string,
  hash: string,
) {
  await globalAdmin(client);
  if (!(await commerceCan(client, catalogCreate))) throw new FoundationError('FORBIDDEN');
  const country = new Intl.DisplayNames(['en'], { type: 'region' }).of(input.countryCode);
  if (!country || country === input.countryCode || country === 'Unknown Region')
    throw new FoundationError('INVALID_REQUEST');
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone });
  } catch {
    throw new FoundationError('INVALID_REQUEST');
  }
  const previous = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (previous) return previous;
  const selectedCurrency = await currencyDetail(client, input.currency);
  if (!selectedCurrency) throw new FoundationError('INVALID_REQUEST');
  const existing = await marketByCode(client, input.countryCode);
  if (existing && (existing.currency !== input.currency || existing.timezone !== input.timezone))
    throw new FoundationError('CONFLICT');
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing)
    await insertMarket(client, context, id, input.countryCode, input.currency, input.timezone);
  await insertCatalogMarket(client, context, id, input.countryCode, input.locale);
  if (input.evidence)
    await observation(client, context, 'market_catalog', 'market', id, input.evidence, {
      countryCode: input.countryCode,
      currency: input.currency,
      locale: input.locale,
    });
  return commerceFinish(client, 'catalog.v1', key, { id, version: 1 });
}
export async function createCatalogProduct(
  client: Client,
  context: AuthContext,
  input: MarketProductCreate,
  key: string,
  hash: string,
) {
  if (!(await commerceCan(client, catalogCreate))) throw new FoundationError('FORBIDDEN');
  const market = await catalogMarket(client, input.marketId);
  if (!market) throw new FoundationError('NOT_FOUND');
  const node = await productNode(client, input.nodeId);
  if (!node) throw new FoundationError('NOT_FOUND');
  if (
    !(await commerceCan(client, "SELECT authz.product_allowed($1,'update') AS allowed", [node.id]))
  )
    throw new FoundationError('FORBIDDEN');
  const previous = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (previous) return previous;
  const id = crypto.randomUUID();
  await insertMarketProduct(client, context, {
    id,
    marketId: input.marketId,
    nodeId: node.id,
    workspaceId: node.workspace_id,
    stableKey: input.stableKey,
    displayName: input.displayName,
    commercialCode: input.commercialCode,
  });
  const evidenceId = await observation(
    client,
    context,
    'market_catalog',
    'market_product',
    id,
    input.evidence,
    {
      marketId: input.marketId,
      commercialCode: input.commercialCode,
      availability: input.availability,
    },
  );
  await insertAvailability(client, context, {
    id: crypto.randomUUID(),
    marketProductId: id,
    status: input.availability,
    effectiveAt: input.effectiveAt,
    observationId: evidenceId,
  });
  return commerceFinish(client, 'catalog.v1', key, { id, version: 1 });
}
export async function changeCatalogAvailability(
  client: Client,
  context: AuthContext,
  id: string,
  input: MarketAvailabilityChange,
  key: string,
  hash: string,
) {
  if (
    !(await commerceCan(
      client,
      "SELECT authz.capable(authz.actor_id(),'catalog','update','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const row = await marketProduct(client, id, true);
  if (!row) throw new FoundationError('NOT_FOUND');
  if (!(await commerceCan(client, "SELECT authz.catalog_allowed($1,'update') AS allowed", [id])))
    throw new FoundationError('FORBIDDEN');
  const previous = await commerceReceipt(client, 'catalog.v1', key, hash);
  if (previous) return previous;
  if (row.version !== input.expectedVersion) throw new FoundationError('CONFLICT');
  const latest = await latestAvailability(client, id);
  if (latest && Date.parse(input.effectiveAt) <= latest.effective_at.getTime())
    throw new FoundationError('CONFLICT');
  const evidenceId = await observation(
    client,
    context,
    'market_catalog',
    'market_product',
    id,
    input.evidence,
    {
      marketId: row.market_id,
      availability: input.status,
    },
  );
  await insertAvailability(client, context, {
    id: crypto.randomUUID(),
    marketProductId: id,
    status: input.status,
    effectiveAt: input.effectiveAt,
    observationId: evidenceId,
  });
  const version = await bumpMarketProduct(client, id);
  if (!version) throw new FoundationError('UNAVAILABLE');
  return commerceFinish(client, 'catalog.v1', key, { id, version });
}
export async function marketCatalog(client: Client, marketId: string, asOf: string, limit: number) {
  if (!(await commerceCan(client, catalogRead))) throw new FoundationError('FORBIDDEN');
  if (!(await catalogMarket(client, marketId))) throw new FoundationError('NOT_FOUND');
  return listCatalog(client, marketId, asOf, limit);
}

export async function createCatalogPriceList(
  client: Client,
  context: AuthContext,
  input: PriceListCreate,
  key: string,
  hash: string,
) {
  if (
    !(await commerceCan(client, "SELECT authz.pricing_workspace_right($1,'create') AS allowed", [
      input.workspaceId,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const market = await catalogMarket(client, input.marketId);
  if (!market || (market.status !== 'active' && input.status !== 'draft'))
    throw new FoundationError('NOT_FOUND');
  if (market.currency !== input.currency) throw new FoundationError('INVALID_REQUEST');
  const previous = await commerceReceipt(client, 'pricing.v1', key, hash);
  if (previous) return previous;
  const id = crypto.randomUUID();
  await insertPriceList(client, context, { id, ...input });
  await observation(client, context, 'pricing', 'price_list', id, input.evidence, {
    marketId: input.marketId,
    currency: input.currency,
    listKey: input.stableKey,
  });
  return commerceFinish(client, 'pricing.v1', key, { id, version: 1 });
}
export async function closeCatalogPriceList(
  client: Client,
  id: string,
  input: PriceListClose,
  key: string,
  hash: string,
) {
  if (
    !(await commerceCan(
      client,
      "SELECT authz.capable(authz.actor_id(),'pricing','update','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const row = await priceList(client, id, true);
  if (!row) throw new FoundationError('NOT_FOUND');
  await marketAdmin(client, row.market_id);
  if (
    !(await commerceCan(
      client,
      "SELECT authz.capable(authz.actor_id(),'pricing','manage','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
  if (!(await commerceCan(client, "SELECT authz.pricing_allowed($1,'update') AS allowed", [id])))
    throw new FoundationError('FORBIDDEN');
  const previous = await commerceReceipt(client, 'pricing.v1', key, hash);
  if (previous) return previous;
  if (row.version !== input.expectedVersion || row.status !== 'active')
    throw new FoundationError('CONFLICT');
  if (Date.parse(input.validTo) <= row.valid_from.getTime())
    throw new FoundationError('INVALID_REQUEST');
  const version = await closePriceList(client, id, input.validTo);
  if (!version) throw new FoundationError('UNAVAILABLE');
  return commerceFinish(client, 'pricing.v1', key, { id, version });
}
export async function activateCatalogPriceList(
  client: Client,
  id: string,
  input: PriceListActivate,
  key: string,
  hash: string,
) {
  const row = await priceList(client, id, true);
  if (!row) throw new FoundationError('NOT_FOUND');
  await marketAdmin(client, row.market_id);
  if (
    !(await commerceCan(
      client,
      "SELECT authz.capable(authz.actor_id(),'pricing','manage','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
  if (!(await commerceCan(client, "SELECT authz.pricing_allowed($1,'update') AS allowed", [id])))
    throw new FoundationError('FORBIDDEN');
  const market = await catalogMarket(client, row.market_id);
  if (!market || market.status !== 'active') throw new FoundationError('CONFLICT');
  const prior = await commerceReceipt(client, 'pricing.v1', key, hash);
  if (prior) return prior;
  if (row.status !== 'draft' || row.version !== input.expectedVersion)
    throw new FoundationError('CONFLICT');
  const version = await activatePriceList(client, id, input.expectedVersion);
  if (!version) throw new FoundationError('CONFLICT');
  return commerceFinish(client, 'pricing.v1', key, { id, version });
}
export async function addCatalogPrice(
  client: Client,
  context: AuthContext,
  id: string,
  input: PriceEntryCreate,
  key: string,
  hash: string,
) {
  if (
    !(await commerceCan(
      client,
      "SELECT authz.capable(authz.actor_id(),'pricing','update','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const list = await priceList(client, id, true);
  if (!list) throw new FoundationError('NOT_FOUND');
  if (!(await commerceCan(client, "SELECT authz.pricing_allowed($1,'update') AS allowed", [id])))
    throw new FoundationError('FORBIDDEN');
  const mp = await marketProduct(client, input.marketProductId);
  if (!mp || mp.market_id !== list.market_id) throw new FoundationError('NOT_FOUND');
  if (!(await commerceCan(client, "SELECT authz.catalog_allowed($1,'read') AS allowed", [mp.id])))
    throw new FoundationError('FORBIDDEN');
  const previous = await commerceReceipt(client, 'pricing.v1', key, hash);
  if (previous) return previous;
  if (list.version !== input.expectedVersion || !['active', 'draft'].includes(list.status))
    throw new FoundationError('CONFLICT');
  if (list.status === 'draft') await marketAdmin(client, list.market_id, 'manage');
  if (input.currency !== list.currency) throw new FoundationError('INVALID_REQUEST');
  if (
    input.supersedesEntryId &&
    !(await closeSupersededPriceEntry(client, input.supersedesEntryId, id, mp.id, input.validFrom))
  )
    throw new FoundationError('CONFLICT');
  const amount = canonicalAmount(input.amount, 4);
  const taxRate = input.taxRate === null ? null : canonicalAmount(input.taxRate, 6);
  const evidenceId = await observation(
    client,
    context,
    'pricing',
    'price_list',
    id,
    input.evidence,
    {
      marketId: list.market_id,
      marketProductId: mp.id,
      amount,
      currency: list.currency,
      taxTreatment: input.taxTreatment,
      taxRate,
    },
  );
  const entryId = crypto.randomUUID();
  await insertPriceEntry(client, context, {
    id: entryId,
    priceListId: id,
    marketProductId: mp.id,
    marketId: list.market_id,
    currency: list.currency,
    amount,
    taxTreatment: input.taxTreatment,
    taxRate,
    sourceLiteral: input.evidence.sourceLiteral,
    validFrom: input.validFrom,
    validTo: input.validTo,
    observationId: evidenceId,
  });
  const version = await bumpPriceList(client, id);
  if (!version) throw new FoundationError('UNAVAILABLE');
  return commerceFinish(client, 'pricing.v1', key, { id: entryId, version });
}
export async function readCatalogPrice(
  client: Client,
  listId: string,
  marketProductId: string,
  asOf: string,
) {
  if (!(await commerceCan(client, pricingRead))) throw new FoundationError('FORBIDDEN');
  if (!(await priceList(client, listId))) throw new FoundationError('NOT_FOUND');
  if (!(await marketProduct(client, marketProductId))) throw new FoundationError('NOT_FOUND');
  const price = await currentPrice(client, listId, marketProductId, asOf);
  return price
    ? { ...price, kind: 'PUBLISHED_MARKET_PRICE' as const, officialMarketPrice: true as const }
    : null;
}
export async function readCatalogPriceHistory(
  client: Client,
  listId: string,
  marketProductId: string,
  limit: number,
) {
  if (!(await commerceCan(client, pricingRead))) throw new FoundationError('FORBIDDEN');
  if (!(await priceList(client, listId))) throw new FoundationError('NOT_FOUND');
  if (!(await marketProduct(client, marketProductId))) throw new FoundationError('NOT_FOUND');
  return priceHistory(client, listId, marketProductId, limit);
}
export async function createCatalogExchangeRate(
  client: Client,
  context: AuthContext,
  input: ExchangeRateCreate,
  key: string,
  hash: string,
) {
  await marketAdmin(client, input.marketId);
  if (
    !(await commerceCan(
      client,
      "SELECT authz.market_authorized($1,'pricing','create') AS allowed",
      [input.marketId],
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const market = await catalogMarket(client, input.marketId);
  if (!market || market.status === 'retired') throw new FoundationError('NOT_FOUND');
  for (const code of [input.baseCurrency, input.quoteCurrency]) {
    const found = await currencyDetail(client, code);
    if (!found || found.status !== 'active') throw new FoundationError('INVALID_REQUEST');
  }
  const prior = await commerceReceipt(client, 'pricing.v1', key, hash);
  if (prior) return prior;
  if (
    input.supersedesRateId &&
    !(await retireExchangeRate(
      client,
      input.supersedesRateId,
      input.marketId,
      input.baseCurrency,
      input.quoteCurrency,
      input.validFrom,
    ))
  )
    throw new FoundationError('CONFLICT');
  const id = crypto.randomUUID();
  const rate = canonicalAmount(input.rate, 10);
  const observationId = await observation(
    client,
    context,
    'fx',
    'market',
    input.marketId,
    input.evidence,
    {
      rateId: id,
      baseCurrency: input.baseCurrency,
      quoteCurrency: input.quoteCurrency,
      rate,
    },
  );
  await insertExchangeRate(client, context, {
    id,
    marketId: input.marketId,
    base: input.baseCurrency,
    quote: input.quoteCurrency,
    rate,
    validFrom: input.validFrom,
    validTo: input.validTo,
    literal: input.evidence.sourceLiteral,
    observationId,
  });
  return commerceFinish(client, 'pricing.v1', key, { id, version: 1 });
}
export async function readCatalogExchangeRate(
  client: Client,
  marketId: string,
  base: string,
  quote: string,
  asOf: string,
) {
  if (
    !(await commerceCan(client, "SELECT authz.market_authorized($1,'pricing','read') AS allowed", [
      marketId,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const rate = await currentExchangeRate(client, marketId, base, quote, asOf);
  return rate
    ? {
        ...rate,
        baseCurrency: base,
        quoteCurrency: quote,
        marketId,
        kind: 'DERIVED_REFERENCE' as const,
      }
    : null;
}
export async function deriveCatalogReference(
  client: Client,
  marketId: string,
  base: string,
  quote: string,
  asOf: string,
  amount: string,
) {
  const rate = await readCatalogExchangeRate(client, marketId, base, quote, asOf);
  if (!rate) return null;
  const derivedAmount = await convertReference(client, amount, rate.rate, quote);
  if (derivedAmount === undefined) throw new FoundationError('INVALID_REQUEST');
  return {
    kind: 'DERIVED_REFERENCE' as const,
    marketId,
    baseCurrency: base,
    quoteCurrency: quote,
    sourceAmount: amount,
    derivedAmount,
    rateId: rate.id,
    rate: rate.rate,
    asOf,
    officialMarketPrice: false as const,
  };
}
