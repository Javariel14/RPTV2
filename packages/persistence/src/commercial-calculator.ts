import type { Client } from 'pg';
import type {
  CommercialConfigurationCreate,
  ResolvedCommercialRule,
  ResolvedCommercialFinancing,
} from '@rpt/contracts';
import type { AuthContext } from './index.js';

export interface CommercialVersion {
  id: string;
  configuration_id: string;
  market_id: string;
  price_list_id: string;
  kind: 'bundle' | 'rules' | 'financing';
  version_no: number;
  revision: number;
  status: 'draft' | 'active' | 'retired';
  valid_from: Date;
  valid_to: Date | null;
  pricing_mode: 'COMPONENT_SUM' | 'PUBLISHED_ANCHOR' | null;
  anchor_market_product_id: string | null;
  financing_mode: ResolvedCommercialFinancing['mode'] | null;
  down_payment_rate: string | null;
  down_payment_amount: string | null;
  allow_additional_balance: boolean;
}
export async function commercialPermission(
  client: Client,
  market: string,
  list: string,
  verb: 'calculate' | 'configure',
) {
  return (
    (
      await client.query<{ allowed: boolean }>(
        'SELECT authz.commercial_market_right($1,$2,$3) AS allowed',
        [market, list, verb],
      )
    ).rows[0]?.allowed === true
  );
}
export async function commercialReceipt(client: Client, key: string, hash: string) {
  return (
    (
      await client.query<{
        value: { id: string; versionId: string; version: number; revision: number } | null;
      }>('SELECT authz.commercial_receipt($1,$2) AS value', [key, hash])
    ).rows[0]?.value ?? null
  );
}
export async function commercialFinish(
  client: Client,
  key: string,
  value: { id: string; versionId: string; version: number; revision: number },
) {
  await client.query('SELECT authz.commercial_finish($1,$2)', [key, value]);
  return value;
}
export async function configurationByKey(
  client: Client,
  marketId: string,
  listId: string,
  kind: string,
  stableKey: string,
) {
  return (
    await client.query<{ id: string; version: number; name: string }>(
      'SELECT id,version,name FROM rpt.commercial_configuration WHERE market_id=$1 AND price_list_id=$2 AND kind=$3 AND stable_key=$4 FOR UPDATE',
      [marketId, listId, kind, stableKey],
    )
  ).rows[0];
}
export async function lockConfiguration(
  client: Client,
  context: AuthContext,
  input: CommercialConfigurationCreate,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${context.tenantId}/commercial/${input.marketId}/${input.priceListId}/${input.kind}/${input.stableKey}`,
  ]);
}
export async function insertConfiguration(
  client: Client,
  context: AuthContext,
  id: string,
  currency: string,
  input: CommercialConfigurationCreate,
) {
  await client.query(
    `INSERT INTO rpt.commercial_configuration(tenant_id,id,market_id,price_list_id,currency,kind,stable_key,name,actor_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      context.tenantId,
      id,
      input.marketId,
      input.priceListId,
      currency,
      input.kind,
      input.stableKey,
      input.name,
      context.actorId,
    ],
  );
}
export async function bumpConfiguration(client: Client, id: string, expected: number) {
  return (
    await client.query<{ version: number }>(
      'UPDATE rpt.commercial_configuration SET version=version+1 WHERE id=$1 AND version=$2 RETURNING version',
      [id, expected],
    )
  ).rows[0]?.version;
}
export async function insertCommercialVersion(
  client: Client,
  context: AuthContext,
  id: string,
  configuration: string,
  version: number,
  input: CommercialConfigurationCreate,
) {
  await client.query(
    `INSERT INTO rpt.commercial_configuration_version
  (tenant_id,id,configuration_id,market_id,price_list_id,kind,version_no,valid_from,valid_to,pricing_mode,anchor_market_product_id,financing_mode,down_payment_rate,down_payment_amount,allow_additional_balance,actor_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      context.tenantId,
      id,
      configuration,
      input.marketId,
      input.priceListId,
      input.kind,
      version,
      input.validFrom,
      input.validTo,
      input.kind === 'bundle' ? input.pricingMode : null,
      input.kind === 'bundle' ? input.anchorMarketProductId : null,
      input.kind === 'financing' ? input.mode : null,
      input.kind === 'financing' ? input.downPaymentRate : null,
      input.kind === 'financing' ? input.downPaymentAmount : null,
      input.kind === 'financing' && input.allowAdditionalBalance,
      context.actorId,
    ],
  );
  if (input.kind === 'bundle')
    for (const line of input.lines)
      await client.query(
        'INSERT INTO rpt.commercial_bundle_line(tenant_id,id,version_id,market_id,market_product_id,quantity) VALUES($1,$2,$3,$4,$5,$6)',
        [
          context.tenantId,
          crypto.randomUUID(),
          id,
          input.marketId,
          line.marketProductId,
          line.quantity,
        ],
      );
  if (input.kind === 'rules')
    for (const rule of input.rules)
      await client.query(
        'INSERT INTO rpt.commercial_rule(tenant_id,id,version_id,market_id,kind,value,auto_limit,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          context.tenantId,
          crypto.randomUUID(),
          id,
          input.marketId,
          rule.kind,
          rule.value,
          rule.autoLimit,
          rule.priority,
        ],
      );
  if (input.kind === 'financing')
    for (const term of input.terms)
      await client.query(
        'INSERT INTO rpt.commercial_financing_term(tenant_id,id,version_id,market_id,months,value) VALUES($1,$2,$3,$4,$5,$6)',
        [context.tenantId, crypto.randomUUID(), id, input.marketId, term.months, term.value],
      );
}
export async function commercialVersion(client: Client, id: string, lock = false) {
  return (
    await client.query<CommercialVersion>(
      `SELECT * FROM rpt.commercial_configuration_version WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
}
export async function commercialHistory(client: Client, id: string) {
  return (
    await client.query<CommercialVersion>(
      'SELECT * FROM rpt.commercial_configuration_version WHERE configuration_id=$1 ORDER BY version_no LIMIT 100',
      [id],
    )
  ).rows;
}
export async function transitionCommercialVersion(
  client: Client,
  id: string,
  revision: number,
  action: 'activate' | 'retire',
  at: string,
) {
  return (
    await client.query<{ revision: number }>(
      `UPDATE rpt.commercial_configuration_version SET status=$3,
  valid_to=CASE WHEN $3='retired' THEN $4::timestamptz ELSE valid_to END,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING revision`,
      [id, revision, action === 'activate' ? 'active' : 'retired', at],
    )
  ).rows[0]?.revision;
}
export async function resolveCommercialVersions(client: Client, ids: string[], asOf: string) {
  return (
    await client.query<CommercialVersion>(
      `SELECT * FROM rpt.commercial_configuration_version
    WHERE configuration_id=ANY($1::uuid[]) AND status<>'draft' AND valid_from<=$2 AND (valid_to IS NULL OR valid_to>$2) ORDER BY configuration_id,version_no`,
      [ids, asOf],
    )
  ).rows;
}
export async function bundleLines(client: Client, ids: string[]) {
  return (
    await client.query<{ version_id: string; market_product_id: string; quantity: string }>(
      'SELECT version_id,market_product_id,quantity::text AS quantity FROM rpt.commercial_bundle_line WHERE version_id=ANY($1::uuid[]) ORDER BY version_id,market_product_id',
      [ids],
    )
  ).rows;
}
export async function commercialRules(
  client: Client,
  versionId: string,
  version: number,
): Promise<ResolvedCommercialRule[]> {
  return (
    await client.query<Omit<ResolvedCommercialRule, 'version'>>(
      'SELECT id,kind,value::text AS value,auto_limit::text AS "autoLimit",priority FROM rpt.commercial_rule WHERE version_id=$1 ORDER BY priority',
      [versionId],
    )
  ).rows.map((r) => ({ ...r, version }));
}
export async function financingTerms(client: Client, versionId: string) {
  return (
    await client.query<{ id: string; months: number; value: string }>(
      'SELECT id,months,value::text AS value FROM rpt.commercial_financing_term WHERE version_id=$1 ORDER BY months',
      [versionId],
    )
  ).rows;
}
export async function commercialHistoryContents(client: Client, versions: CommercialVersion[]) {
  const ids = versions.map((v) => v.id);
  const lines = await bundleLines(client, ids);
  const rules = (
    await client.query<{
      version_id: string;
      id: string;
      kind: ResolvedCommercialRule['kind'];
      value: string;
      autoLimit: string | null;
      priority: number;
    }>(
      'SELECT version_id,id,kind,value::text AS value,auto_limit::text AS "autoLimit",priority FROM rpt.commercial_rule WHERE version_id=ANY($1::uuid[]) ORDER BY version_id,priority',
      [ids],
    )
  ).rows;
  const terms = (
    await client.query<{ version_id: string; id: string; months: number; value: string }>(
      'SELECT version_id,id,months,value::text AS value FROM rpt.commercial_financing_term WHERE version_id=ANY($1::uuid[]) ORDER BY version_id,months',
      [ids],
    )
  ).rows;
  return versions.map((v) => ({
    ...v,
    lines: lines.filter((l) => l.version_id === v.id),
    rules: rules.filter((r) => r.version_id === v.id).map((r) => ({ ...r, version: v.version_no })),
    terms: terms.filter((t) => t.version_id === v.id),
  }));
}
export async function officialPrices(
  client: Client,
  listId: string,
  products: string[],
  asOf: string,
) {
  return (
    await client.query<{
      marketProductId: string;
      entryId: string;
      unitPrice: string;
      taxTreatment: 'tax_inclusive' | 'tax_exclusive' | 'tax_not_applicable' | 'tax_unknown';
      taxRate: string | null;
    }>(
      `SELECT market_product_id AS "marketProductId",id AS "entryId",amount::text AS "unitPrice",tax_treatment AS "taxTreatment",tax_rate::text AS "taxRate"
  FROM rpt.price_list_entry WHERE price_list_id=$1 AND market_product_id=ANY($2::uuid[]) AND valid_from<=$3 AND (valid_to IS NULL OR valid_to>$3) ORDER BY market_product_id`,
      [listId, products, asOf],
    )
  ).rows;
}
export async function insertCommercialEvidence(
  client: Client,
  context: AuthContext,
  version: CommercialVersion,
  evidence: {
    sourceSystem: string;
    sourceReference: string;
    externalId: string;
    observedAt: string;
    authorityLevel: string;
    evidenceLevel: string;
    sourceLiteral: string;
  },
  hash: string,
) {
  const id = crypto.randomUUID();
  const type =
    version.kind === 'bundle'
      ? 'bundle_version'
      : version.kind === 'rules'
        ? 'rule_set_version'
        : 'financing_plan_version';
  await client.query(
    `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,commercial_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
  VALUES($1,$2,$3,'commercial_configuration',$4,$5,$6,$7,$8,$8,$9,$10,$11,'matched',$12,$13)`,
    [
      context.tenantId,
      id,
      evidence.sourceSystem,
      type,
      version.id,
      evidence.externalId,
      evidence.sourceReference,
      evidence.observedAt,
      evidence.authorityLevel,
      hash,
      crypto.randomUUID(),
      context.actorId,
      { sourceLiteral: evidence.sourceLiteral, evidenceLevel: evidence.evidenceLevel },
    ],
  );
  return id;
}
