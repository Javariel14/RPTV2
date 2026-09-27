import type { Client } from 'pg';
import {
  quoteCatalogSnapshot,
  quoteLineSnapshot,
  type quoteEvidenceAppend,
  type CommercialCalculationResult,
  type QuoteCreate,
  type QuoteLineSnapshot,
} from '@rpt/contracts';
import type { z } from 'zod';
import type { AuthContext } from './index.js';

export interface QuoteRow {
  id: string;
  workspace_id: string;
  market_id: string;
  person_id: string | null;
  owner_id: string;
  status: 'draft' | 'issued' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  current_version_number: number;
  version: number;
  valid_until: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface QuoteVersionRow {
  id: string;
  quote_id: string;
  version_number: number;
  market_id: string;
  currency: string;
  price_list_id: string;
  price_list_version: number;
  calculation_hash: string;
  engine_identity: string;
  input_snapshot: QuoteCreate['calculation'];
  output_snapshot: CommercialCalculationResult;
  created_by: string;
  created_at: Date;
}
export async function quotePermission(c: Client, id: string, verb: string) {
  return (
    (
      await c.query<{ allowed: boolean }>('SELECT authz.quote_allowed($1,$2) AS allowed', [
        id,
        verb,
      ])
    ).rows[0]?.allowed === true
  );
}
export async function quoteWorkspacePermission(
  c: Client,
  workspace: string,
  market: string,
  verb: string,
) {
  return (
    (
      await c.query<{ allowed: boolean }>(
        'SELECT authz.quote_workspace_right($1,$2,$3) AS allowed',
        [workspace, market, verb],
      )
    ).rows[0]?.allowed === true
  );
}
export async function quote(c: Client, id: string, lock = false) {
  return (
    await c.query<QuoteRow>(
      `SELECT id,workspace_id,market_id,person_id,owner_id,status,current_version_number,version,valid_until,created_at,updated_at FROM rpt.cpq_quote WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
}
export async function quoteVersion(c: Client, id: string) {
  return (await c.query<QuoteVersionRow>('SELECT * FROM rpt.cpq_quote_version WHERE id=$1', [id]))
    .rows[0];
}
export async function quoteHistory(c: Client, id: string, after: number, limit: number) {
  return (
    await c.query<QuoteVersionRow>(
      'SELECT * FROM rpt.cpq_quote_version WHERE quote_id=$1 AND version_number>$2 ORDER BY version_number LIMIT $3',
      [id, after, limit],
    )
  ).rows;
}
export async function quoteLines(c: Client, id: string) {
  return (
    await c.query<{ snapshot: QuoteLineSnapshot }>(
      'SELECT snapshot FROM rpt.cpq_quote_line WHERE quote_version_id=$1 ORDER BY ordinal',
      [id],
    )
  ).rows.map((r) => quoteLineSnapshot.parse(r.snapshot));
}
export async function insertQuote(
  c: Client,
  a: AuthContext,
  id: string,
  market: string,
  input: QuoteCreate,
) {
  await c.query(
    'INSERT INTO rpt.cpq_quote(tenant_id,id,workspace_id,market_id,person_id,owner_id,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [a.tenantId, id, input.workspaceId, market, input.personId, a.actorId, input.validUntil],
  );
}
async function catalogSnapshot(c: Client, id: string) {
  const row = (
    await c.query(
      `SELECT m.id AS "marketProductId",m.market_id AS "marketId",m.node_id AS "nodeId",m.display_name AS "displayName",m.commercial_code AS "commercialCode",
 (WITH RECURSIVE path AS (SELECT n.*,0 AS depth FROM rpt.product_node n WHERE n.tenant_id=m.tenant_id AND n.id=m.node_id
 UNION ALL SELECT n.*,p.depth+1 FROM rpt.product_node n JOIN path p ON n.tenant_id=p.tenant_id AND n.id=p.parent_id WHERE p.depth<2)
 SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'stableKey',stable_key,'name',name) ORDER BY depth DESC) FROM path) AS path
 FROM rpt.market_product m WHERE m.id=$1`,
      [id],
    )
  ).rows[0];
  return quoteCatalogSnapshot.parse(row);
}
export async function buildQuoteLines(c: Client, result: CommercialCalculationResult) {
  const snapshots: QuoteLineSnapshot[] = [];
  for (const line of result.lines) {
    const catalog = await catalogSnapshot(c, line.marketProductId);
    const source = (
      await c.query(
        `SELECT e.observation_id AS "observationId",e.source_literal AS "sourceLiteral",o.source_reference AS "sourceReference",o.observed_at AS "observedAt",o.authority_level AS "authorityLevel"
   FROM rpt.price_list_entry e JOIN rpt.source_observation o ON o.tenant_id=e.tenant_id AND o.id=e.observation_id WHERE e.id=$1`,
        [line.entryId],
      )
    ).rows[0];
    const composition: QuoteLineSnapshot['bundleComposition'] = [];
    if (line.bundleId) {
      const components = (
        await c.query<{ market_product_id: string; quantity: string }>(
          `SELECT b.market_product_id,b.quantity::text FROM rpt.commercial_bundle_line b
    JOIN rpt.commercial_configuration_version v ON v.tenant_id=b.tenant_id AND v.id=b.version_id
    WHERE v.configuration_id=$1 AND v.version_no=$2 ORDER BY b.market_product_id`,
          [line.bundleId, line.bundleVersion],
        )
      ).rows;
      for (const part of components)
        composition.push({
          catalog: await catalogSnapshot(c, part.market_product_id),
          quantity: part.quantity,
        });
    }
    snapshots.push(
      quoteLineSnapshot.parse({
        commercial: line,
        catalog,
        source: { ...source, observedAt: source?.observedAt.toISOString() },
        bundleComposition: composition,
      }),
    );
  }
  return snapshots;
}
export async function insertQuoteVersion(
  c: Client,
  a: AuthContext,
  q: QuoteRow,
  input: QuoteCreate['calculation'],
  result: CommercialCalculationResult,
  snapshots: QuoteLineSnapshot[],
  attestation: { versionId: string; keyId: string; payload: string; tag: string },
) {
  const id = attestation.versionId;
  await c.query(
    `INSERT INTO rpt.cpq_quote_version(tenant_id,id,quote_id,market_id,version_number,currency,price_list_id,price_list_version,calculation_hash,engine_identity,input_snapshot,output_snapshot,created_by,attestation_key_id,attestation_payload,calculation_attestation)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'E3B1/v1',$10,$11,$12,$13,$14,$15)`,
    [
      a.tenantId,
      id,
      q.id,
      q.market_id,
      q.current_version_number + 1,
      result.currency,
      result.priceListId,
      result.priceListVersion,
      result.calculationHash,
      input,
      result,
      a.actorId,
      attestation.keyId,
      attestation.payload,
      attestation.tag,
    ],
  );
  for (const [index, snapshot] of snapshots.entries())
    await c.query(
      'INSERT INTO rpt.cpq_quote_line(tenant_id,id,quote_id,quote_version_id,ordinal,snapshot) VALUES($1,$2,$3,$4,$5,$6)',
      [a.tenantId, crypto.randomUUID(), q.id, id, index + 1, snapshot],
    );
  return { id: q.id, versionId: id, version: q.current_version_number + 1 };
}
export async function transitionQuote(
  c: Client,
  id: string,
  status: QuoteRow['status'],
  version: number,
) {
  return (
    await c.query<QuoteRow>(
      'UPDATE rpt.cpq_quote SET status=$2,version=version+1 WHERE id=$1 AND version=$3 RETURNING *',
      [id, status, version],
    )
  ).rows[0];
}
export async function quoteReceipt(c: Client, key: string, hash: string) {
  return (
    (
      await c.query<{ value: { id: string; versionId: string; version: number } | null }>(
        'SELECT authz.quote_receipt($1,$2) AS value',
        [key, hash],
      )
    ).rows[0]?.value ?? null
  );
}
export async function finishQuote(
  c: Client,
  key: string,
  value: { id: string; versionId: string; version: number },
) {
  await c.query('SELECT authz.quote_finish($1,$2)', [key, value]);
  return value;
}
export async function insertQuoteEvidence(
  c: Client,
  a: AuthContext,
  input: z.infer<typeof quoteEvidenceAppend>,
  hash: string,
) {
  const id = crypto.randomUUID(),
    e = input.evidence;
  await c.query(
    `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,quote_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
 VALUES($1,$2,$3,'cpq_quote',$4,$5,$6,$7,$8,$8,$9,$10,$11,'matched',$12,$13)`,
    [
      a.tenantId,
      id,
      e.sourceSystem,
      input.subjectType,
      input.subjectId,
      e.externalId,
      e.sourceReference,
      e.observedAt,
      e.authorityLevel,
      hash,
      crypto.randomUUID(),
      a.actorId,
      { sourceLiteral: e.sourceLiteral, evidenceLevel: e.evidenceLevel },
    ],
  );
  return { id };
}
