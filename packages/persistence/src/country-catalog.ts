import type { Client } from 'pg';
import type { AuthContext } from './index.js';

export async function commerceCan(client: Client, sql: string, values: unknown[] = []) {
  return (await client.query<{ allowed: boolean }>(sql, values)).rows[0]?.allowed === true;
}
export async function commerceReceipt(
  client: Client,
  operation: 'catalog.v1' | 'pricing.v1',
  key: string,
  hash: string,
) {
  return (
    (
      await client.query<{ value: { id: string; version: number } | null }>(
        'SELECT authz.commerce_receipt($1,$2,$3) AS value',
        [operation, key, hash],
      )
    ).rows[0]?.value ?? null
  );
}
export async function commerceFinish(
  client: Client,
  operation: 'catalog.v1' | 'pricing.v1',
  key: string,
  value: { id: string; version: number },
) {
  await client.query('SELECT authz.commerce_finish($1,$2,$3)', [operation, key, value]);
  return value;
}
export async function marketByCode(client: Client, code: string) {
  return (
    await client.query<{ id: string; currency: string; timezone: string }>(
      'SELECT id,currency,timezone FROM rpt.market WHERE code=$1',
      [code],
    )
  ).rows[0];
}
export async function insertMarket(
  client: Client,
  context: AuthContext,
  id: string,
  code: string,
  currency: string,
  timezone: string,
) {
  await client.query(
    'INSERT INTO rpt.market(tenant_id,id,code,currency,timezone) VALUES($1,$2,$3,$4,$5)',
    [context.tenantId, id, code, currency, timezone],
  );
}
export async function insertCatalogMarket(
  client: Client,
  context: AuthContext,
  id: string,
  code: string,
  locale: string,
) {
  await client.query(
    "INSERT INTO rpt.catalog_market(tenant_id,market_id,country_code,locale,status) VALUES($1,$2,$3,$4,'draft')",
    [context.tenantId, id, code, locale],
  );
}
export async function listMarkets(client: Client) {
  return (
    await client.query(`SELECT c.market_id AS "id",c.country_code AS "countryCode",c.locale,c.status,c.version,
    m.currency,m.timezone FROM rpt.catalog_market c JOIN rpt.market m USING(tenant_id)
    WHERE m.id=c.market_id ORDER BY c.country_code`)
  ).rows;
}
export async function catalogMarket(client: Client, id: string) {
  return (
    await client.query<{ market_id: string; status: string; currency: string; version: number }>(
      'SELECT c.market_id,c.status,c.version,m.currency FROM rpt.catalog_market c JOIN rpt.market m ON (m.tenant_id,m.id)=(c.tenant_id,c.market_id) WHERE c.market_id=$1',
      [id],
    )
  ).rows[0];
}
export async function registerCurrency(
  client: Client,
  context: AuthContext,
  input: { code: string; name: string; minorUnits: number },
) {
  await client.query(
    `INSERT INTO rpt.catalog_currency
    (tenant_id,code,name,minor_units,status,created_by,source_kind)
    VALUES($1,$2,$3,$4,'inactive',$5,'manual_admin')`,
    [context.tenantId, input.code, input.name, input.minorUnits, context.actorId],
  );
}
export async function setCurrencyStatus(
  client: Client,
  code: string,
  version: number,
  status: string,
) {
  return (
    await client.query<{ version: number }>(
      `UPDATE rpt.catalog_currency SET status=$3,version=version+1
    WHERE code=$1 AND version=$2 RETURNING version`,
      [code, version, status],
    )
  ).rows[0]?.version;
}
export async function currencyDetail(client: Client, code: string) {
  return (
    await client.query<{ code: string; status: string; version: number; minor_units: number }>(
      'SELECT code,status,version,minor_units FROM rpt.catalog_currency WHERE code=$1',
      [code],
    )
  ).rows[0];
}
export async function setMarketStatus(
  client: Client,
  marketId: string,
  version: number,
  status: string,
) {
  return (
    await client.query<{ version: number }>(
      `UPDATE rpt.catalog_market SET status=$3,version=version+1
    WHERE market_id=$1 AND version=$2 RETURNING version`,
      [marketId, version, status],
    )
  ).rows[0]?.version;
}
export async function grantMarketScope(
  client: Client,
  context: AuthContext,
  userId: string,
  marketId: string,
  id: string,
) {
  await client.query(
    `INSERT INTO authz.admin_market_scope
    (tenant_id,id,user_id,market_id,granted_by,request_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [context.tenantId, id, userId, marketId, context.actorId, context.requestId],
  );
}
export async function revokeMarketScope(client: Client, id: string) {
  return (
    await client.query<{ id: string }>(
      `UPDATE authz.admin_market_scope SET revoked_at=clock_timestamp()
    WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
      [id],
    )
  ).rows[0];
}
export async function lockMarketActor(client: Client, tenantId: string, userId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${tenantId}/market/${userId}`,
  ]);
}
export async function currentActorMarket(client: Client, userId: string) {
  return (
    await client.query<{ id: string; market_id: string; version: number }>(
      `SELECT id,market_id,version
    FROM authz.operational_market_assignment WHERE user_id=$1 AND valid_to IS NULL
    ORDER BY valid_from DESC LIMIT 1 FOR UPDATE`,
      [userId],
    )
  ).rows[0];
}
export async function closeActorMarket(client: Client, id: string, version: number, at: string) {
  return (
    await client.query<{ id: string }>(
      `UPDATE authz.operational_market_assignment
    SET valid_to=$3,version=version+1 WHERE id=$1 AND version=$2 RETURNING id`,
      [id, version, at],
    )
  ).rows[0];
}
export async function insertActorMarket(
  client: Client,
  context: AuthContext,
  id: string,
  userId: string,
  marketId: string,
  reason: string,
  at: string,
) {
  await client.query(
    `INSERT INTO authz.operational_market_assignment
    (tenant_id,id,user_id,market_id,valid_from,assigned_by,reason,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [context.tenantId, id, userId, marketId, at, context.actorId, reason, context.requestId],
  );
}
export async function effectiveActorMarket(client: Client) {
  return (
    (
      await client.query<{ market_id: string | null }>(
        'SELECT authz.operational_market() AS market_id',
      )
    ).rows[0]?.market_id ?? null
  );
}
export async function marketProduct(client: Client, id: string, lock = false) {
  return (
    await client.query<{ id: string; market_id: string; node_id: string; version: number }>(
      `SELECT id,market_id,node_id,version FROM rpt.market_product WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
}
export async function insertMarketProduct(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    marketId: string;
    nodeId: string;
    workspaceId: string;
    stableKey: string;
    displayName: string;
    commercialCode: string;
  },
) {
  await client.query(
    `INSERT INTO rpt.market_product(tenant_id,id,market_id,node_id,workspace_id,owner_id,stable_key,display_name,commercial_code)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      context.tenantId,
      input.id,
      input.marketId,
      input.nodeId,
      input.workspaceId,
      context.actorId,
      input.stableKey,
      input.displayName,
      input.commercialCode,
    ],
  );
}
export async function latestAvailability(client: Client, marketProductId: string) {
  return (
    await client.query<{ effective_at: Date }>(
      'SELECT effective_at FROM rpt.market_availability WHERE market_product_id=$1 ORDER BY effective_at DESC LIMIT 1',
      [marketProductId],
    )
  ).rows[0];
}
export async function insertAvailability(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    marketProductId: string;
    status: string;
    effectiveAt: string;
    observationId: string;
  },
) {
  await client.query(
    `INSERT INTO rpt.market_availability(tenant_id,id,market_product_id,status,effective_at,observation_id,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      context.tenantId,
      input.id,
      input.marketProductId,
      input.status,
      input.effectiveAt,
      input.observationId,
      context.actorId,
    ],
  );
}
export async function bumpMarketProduct(client: Client, id: string) {
  return (
    await client.query<{ version: number }>(
      'UPDATE rpt.market_product SET version=version+1 WHERE id=$1 RETURNING version',
      [id],
    )
  ).rows[0]?.version;
}
export async function listCatalog(client: Client, marketId: string, asOf: string, limit: number) {
  return (
    await client.query(
      `SELECT m.id,m.node_id AS "nodeId",m.display_name AS "displayName",m.commercial_code AS "commercialCode",m.version,
    a.status AS availability,a.effective_at AS "availabilityFrom"
    FROM rpt.market_product m LEFT JOIN LATERAL (
      SELECT status,effective_at FROM rpt.market_availability a WHERE a.market_product_id=m.id
      AND a.effective_at<=$2 ORDER BY a.effective_at DESC LIMIT 1
    ) a ON true WHERE m.market_id=$1 ORDER BY m.id LIMIT $3`,
      [marketId, asOf, limit],
    )
  ).rows;
}
export async function priceList(client: Client, id: string, lock = false) {
  return (
    await client.query<{
      id: string;
      market_id: string;
      currency: string;
      status: string;
      version: number;
      valid_from: Date;
      valid_to: Date | null;
    }>(
      `SELECT id,market_id,currency,status,version,valid_from,valid_to FROM rpt.price_list WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
}
export async function insertPriceList(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    marketId: string;
    workspaceId: string;
    stableKey: string;
    name: string;
    currency: string;
    status: string;
    validFrom: string;
    validTo: string | null;
  },
) {
  await client.query(
    `INSERT INTO rpt.price_list(tenant_id,id,market_id,workspace_id,owner_id,stable_key,name,currency,status,valid_from,valid_to)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      context.tenantId,
      input.id,
      input.marketId,
      input.workspaceId,
      context.actorId,
      input.stableKey,
      input.name,
      input.currency,
      input.status,
      input.validFrom,
      input.validTo,
    ],
  );
}
export async function closePriceList(client: Client, id: string, validTo: string) {
  return (
    await client.query<{ version: number }>(
      "UPDATE rpt.price_list SET status='closed',valid_to=$2,version=version+1 WHERE id=$1 RETURNING version",
      [id, validTo],
    )
  ).rows[0]?.version;
}
export async function activatePriceList(client: Client, id: string, version: number) {
  return (
    await client.query<{ version: number }>(
      `UPDATE rpt.price_list SET status='active',version=version+1
    WHERE id=$1 AND version=$2 AND status='draft' RETURNING version`,
      [id, version],
    )
  ).rows[0]?.version;
}
export async function bumpPriceList(client: Client, id: string) {
  return (
    await client.query<{ version: number }>(
      'UPDATE rpt.price_list SET version=version+1 WHERE id=$1 RETURNING version',
      [id],
    )
  ).rows[0]?.version;
}
export async function insertPriceEntry(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    priceListId: string;
    marketProductId: string;
    marketId: string;
    currency: string;
    amount: string;
    taxTreatment: string;
    taxRate: string | null;
    sourceLiteral: string;
    validFrom: string;
    validTo: string | null;
    observationId: string;
  },
) {
  await client.query(
    `INSERT INTO rpt.price_list_entry(tenant_id,id,price_list_id,market_product_id,market_id,currency,amount,tax_treatment,tax_rate,source_literal,valid_from,valid_to,observation_id,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      context.tenantId,
      input.id,
      input.priceListId,
      input.marketProductId,
      input.marketId,
      input.currency,
      input.amount,
      input.taxTreatment,
      input.taxRate,
      input.sourceLiteral,
      input.validFrom,
      input.validTo,
      input.observationId,
      context.actorId,
    ],
  );
}
export async function closeSupersededPriceEntry(
  client: Client,
  entryId: string,
  listId: string,
  marketProductId: string,
  validTo: string,
) {
  return (
    await client.query<{ id: string }>(
      `UPDATE rpt.price_list_entry SET valid_to=$4
    WHERE id=$1 AND price_list_id=$2 AND market_product_id=$3 AND valid_to IS NULL
    AND valid_from<$4 RETURNING id`,
      [entryId, listId, marketProductId, validTo],
    )
  ).rows[0];
}
export async function currentPrice(
  client: Client,
  listId: string,
  marketProductId: string,
  asOf: string,
) {
  return (
    (
      await client.query(
        `SELECT e.id,e.amount::text AS amount,e.currency,e.tax_treatment AS "taxTreatment",e.tax_rate::text AS "taxRate",
    e.source_literal AS "sourceLiteral",e.valid_from AS "validFrom",e.valid_to AS "validTo",e.observation_id AS "observationId"
    FROM rpt.price_list_entry e JOIN rpt.price_list p ON (p.tenant_id,p.id)=(e.tenant_id,e.price_list_id)
    WHERE e.price_list_id=$1 AND e.market_product_id=$2
    AND e.valid_from<=$3 AND (e.valid_to IS NULL OR e.valid_to>$3)
    AND p.status<>'draft' AND p.valid_from<=$3 AND (p.valid_to IS NULL OR p.valid_to>$3) LIMIT 1`,
        [listId, marketProductId, asOf],
      )
    ).rows[0] ?? null
  );
}
export async function priceHistory(
  client: Client,
  listId: string,
  marketProductId: string,
  limit: number,
) {
  return (
    await client.query(
      `SELECT id,amount::text AS amount,currency,tax_treatment AS "taxTreatment",tax_rate::text AS "taxRate",
    source_literal AS "sourceLiteral",valid_from AS "validFrom",valid_to AS "validTo",observation_id AS "observationId"
    FROM rpt.price_list_entry WHERE price_list_id=$1 AND market_product_id=$2 ORDER BY valid_from DESC LIMIT $3`,
      [listId, marketProductId, limit],
    )
  ).rows;
}
export async function insertCommerceObservation(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    domain: 'market_catalog' | 'pricing' | 'fx';
    subjectType: 'market' | 'market_product' | 'price_list';
    subjectId: string;
    sourceSystem: string;
    sourceReference: string;
    externalId: string;
    observedAt: string;
    authorityLevel: string;
    rawHash: string;
    facts: Record<string, string | null>;
  },
) {
  await client.query(
    `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,commerce_subject_type,subject_id,external_id,
    source_reference,observed_at,effective_at,verified_at,authority_level,raw_hash,sync_run_id,
    reconciliation_state,actor_id,facts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,CASE WHEN $10::boolean THEN clock_timestamp() END,
    $11,$12,$13,'matched',$14,$15)`,
    [
      context.tenantId,
      input.id,
      input.sourceSystem,
      input.domain,
      input.subjectType,
      input.subjectId,
      input.externalId,
      input.sourceReference,
      input.observedAt,
      ['official', 'verified'].includes(input.authorityLevel),
      input.authorityLevel,
      input.rawHash,
      crypto.randomUUID(),
      context.actorId,
      input.facts,
    ],
  );
}
export async function retireExchangeRate(
  client: Client,
  id: string,
  marketId: string,
  base: string,
  quote: string,
  at: string,
) {
  return (
    await client.query<{ id: string }>(
      `UPDATE rpt.exchange_rate SET valid_to=$5,status='retired'
    WHERE id=$1 AND market_id=$2 AND base_currency=$3 AND quote_currency=$4
    AND valid_to IS NULL AND valid_from<$5 RETURNING id`,
      [id, marketId, base, quote, at],
    )
  ).rows[0];
}
export async function insertExchangeRate(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    marketId: string;
    base: string;
    quote: string;
    rate: string;
    validFrom: string;
    validTo: string | null;
    literal: string;
    observationId: string;
  },
) {
  await client.query(
    `INSERT INTO rpt.exchange_rate
    (tenant_id,id,market_id,base_currency,quote_currency,rate,valid_from,valid_to,status,source_literal,observation_id,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11)`,
    [
      context.tenantId,
      input.id,
      input.marketId,
      input.base,
      input.quote,
      input.rate,
      input.validFrom,
      input.validTo,
      input.literal,
      input.observationId,
      context.actorId,
    ],
  );
}
export async function currentExchangeRate(
  client: Client,
  marketId: string,
  base: string,
  quote: string,
  asOf: string,
) {
  return (
    (
      await client.query<{ id: string; rate: string; validFrom: Date; validTo: Date | null }>(
        `SELECT id,rate::text AS rate,
    valid_from AS "validFrom",valid_to AS "validTo" FROM rpt.exchange_rate
    WHERE market_id=$1 AND base_currency=$2 AND quote_currency=$3
    AND valid_from<=$4 AND (valid_to IS NULL OR valid_to>$4) LIMIT 1`,
        [marketId, base, quote, asOf],
      )
    ).rows[0] ?? null
  );
}
export async function convertReference(
  client: Client,
  amount: string,
  rate: string,
  quote: string,
) {
  return (
    await client.query<{ amount: string }>(
      `SELECT round($1::numeric*$2::numeric,c.minor_units)::text AS amount
    FROM rpt.catalog_currency c WHERE c.tenant_id=authz.tenant_id() AND c.code=$3 AND c.status='active'`,
      [amount, rate, quote],
    )
  ).rows[0]?.amount;
}
