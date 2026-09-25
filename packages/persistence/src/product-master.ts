import type { Client } from 'pg';
import type { AuthContext } from './index.js';

export async function productCan(client: Client, sql: string, values: unknown[] = []) {
  return (await client.query<{ allowed: boolean }>(sql, values)).rows[0]?.allowed === true;
}

export async function productReceipt(client: Client, key: string, hash: string) {
  return (
    (
      await client.query<{ value: { id: string; version: number } | null }>(
        'SELECT authz.product_receipt($1,$2) AS value',
        [key, hash],
      )
    ).rows[0]?.value ?? null
  );
}
export async function productFinish(
  client: Client,
  key: string,
  value: { id: string; version: number },
) {
  await client.query('SELECT authz.product_finish($1,$2)', [key, value]);
  return value;
}

export async function productRoot(client: Client, id: string, lock = false) {
  return (
    await client.query<{ id: string; version: number; workspace_id: string; owner_id: string }>(
      `SELECT id,version,workspace_id,owner_id FROM rpt.product_node WHERE id=$1 AND kind='product'${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
}
export async function productNode(client: Client, id: string) {
  return (
    await client.query<{
      id: string;
      root_id: string;
      kind: string;
      version: number;
      workspace_id: string;
      owner_id: string;
    }>('SELECT id,root_id,kind,version,workspace_id,owner_id FROM rpt.product_node WHERE id=$1', [
      id,
    ])
  ).rows[0];
}
export async function insertProductNode(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    kind: 'product' | 'model' | 'variant';
    parentId: string | null;
    rootId: string;
    workspaceId: string;
    ownerId: string;
    stableKey: string;
    name: string;
    lifecycle: string | null;
  },
) {
  await client.query(
    `INSERT INTO rpt.product_node(
    tenant_id,id,kind,parent_id,root_id,workspace_id,owner_id,stable_key,name,lifecycle)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      context.tenantId,
      input.id,
      input.kind,
      input.parentId,
      input.rootId,
      input.workspaceId,
      input.ownerId,
      input.stableKey,
      input.name,
      input.lifecycle,
    ],
  );
}
export async function insertProductObservation(
  client: Client,
  context: AuthContext,
  input: {
    id: string;
    nodeId: string;
    sourceSystem: string;
    sourceReference: string;
    externalId: string;
    observedAt: string;
    authorityLevel: string;
    sourceLiteral: string;
    evidenceLevel: string;
    scope: { kind: string; key: string };
    rawHash: string;
  },
) {
  await client.query(
    `INSERT INTO rpt.source_observation(
    tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,
    effective_at,verified_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
    VALUES($1,$2,$3,'product_master',$4,$5,$6,$7,$7,
      CASE WHEN $8::boolean THEN clock_timestamp() END,$9,$10,$11,$12,$13,$14)`,
    [
      context.tenantId,
      input.id,
      input.sourceSystem,
      input.nodeId,
      input.externalId,
      input.sourceReference,
      input.observedAt,
      ['official', 'verified'].includes(input.authorityLevel),
      input.authorityLevel,
      input.rawHash,
      crypto.randomUUID(),
      ['pending', 'name_only'].includes(input.evidenceLevel) ? 'pending_review' : 'matched',
      context.actorId,
      {
        sourceLiteral: input.sourceLiteral,
        evidenceLevel: input.evidenceLevel,
        sourceScope: input.scope,
      },
    ],
  );
}

export async function listProductRoots(client: Client, limit: number, afterId: string | null) {
  const result = await client.query(
    `SELECT id,stable_key AS "stableKey",name,lifecycle,version,
    created_at AS "createdAt" FROM rpt.product_node WHERE kind='product'
    AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
    [afterId, limit + 1],
  );
  return {
    rows: result.rows.slice(0, limit),
    nextCursor: result.rows.length > limit ? result.rows[limit - 1]?.id : null,
  };
}
export async function detailProductTree(client: Client, rootId: string) {
  const nodes = (
    await client.query(
      `SELECT id,kind,parent_id AS "parentId",root_id AS "rootId",
    stable_key AS "stableKey",name,lifecycle,version,created_at AS "createdAt"
    FROM rpt.product_node WHERE root_id=$1 ORDER BY kind,id`,
      [rootId],
    )
  ).rows;
  if (!nodes.length) return null;
  const codes = (
    await client.query(
      `SELECT id,node_id AS "nodeId",code_kind AS "codeKind",
    scope_kind AS "scopeKind",scope_key AS "scopeKey",code FROM rpt.product_code
    WHERE node_id IN (SELECT id FROM rpt.product_node WHERE root_id=$1) ORDER BY id`,
      [rootId],
    )
  ).rows;
  const taxonomy = (
    await client.query(
      `SELECT a.node_id AS "nodeId",a.group_key AS "group",a.slug,t.label
    FROM rpt.product_taxon_assignment a JOIN rpt.product_taxon t USING(tenant_id,group_key,slug)
    WHERE a.node_id IN (SELECT id FROM rpt.product_node WHERE root_id=$1) ORDER BY a.node_id,a.group_key,a.slug`,
      [rootId],
    )
  ).rows;
  const facts = (
    await client.query(
      `SELECT f.id,f.node_id AS "nodeId",f.fact_kind AS "factKind",
    f.value_kind AS "valueKind",f.value_text AS "valueText",f.value_decimal::text AS "valueDecimal",
    f.unit_slug AS "unitSlug",f.taxon_group AS "taxonGroup",f.taxon_slug AS "taxonSlug",
    f.source_literal AS "sourceLiteral",f.source_scope_kind AS "sourceScopeKind",
    f.source_scope_key AS "sourceScopeKey",f.evidence_level AS "evidenceLevel",
    f.observation_id AS "observationId",f.previous_fact_id AS "previousFactId",
    o.source_system AS "sourceSystem",o.source_reference AS "sourceReference",
    o.authority_level AS "authorityLevel",o.observed_at AS "observedAt"
    FROM rpt.product_fact f JOIN rpt.source_observation o ON (o.tenant_id,o.id)=(f.tenant_id,f.observation_id)
    WHERE f.node_id IN (SELECT id FROM rpt.product_node WHERE root_id=$1)
    ORDER BY f.created_at,f.id`,
      [rootId],
    )
  ).rows;
  const relations = (
    await client.query(
      `SELECT id,from_node_id AS "fromNodeId",to_node_id AS "toNodeId",
    relation_kind AS "relationKind",evidence_level AS "evidenceLevel",observation_id AS "observationId"
    FROM rpt.product_relation WHERE from_node_id IN
    (SELECT id FROM rpt.product_node WHERE root_id=$1) ORDER BY id`,
      [rootId],
    )
  ).rows;
  return { nodes, codes, taxonomy, facts, relations };
}

export async function bumpProductVersion(client: Client, rootId: string) {
  return (
    await client.query<{ version: number }>(
      'UPDATE rpt.product_node SET version=version+1 WHERE id=$1 RETURNING version',
      [rootId],
    )
  ).rows[0]?.version;
}
export async function setProductLifecycle(client: Client, nodeId: string, lifecycle: string) {
  return (
    await client.query<{ version: number }>(
      'UPDATE rpt.product_node SET lifecycle=$2,version=version+1 WHERE id=$1 RETURNING version',
      [nodeId, lifecycle],
    )
  ).rows[0]?.version;
}
export async function insertProductTaxonGroup(
  client: Client,
  tenantId: string,
  slug: string,
  label: string,
) {
  await client.query('INSERT INTO rpt.product_taxon_group(tenant_id,slug,label) VALUES($1,$2,$3)', [
    tenantId,
    slug,
    label,
  ]);
}
export async function productTaxonGroupExists(client: Client, tenantId: string, slug: string) {
  return (
    (
      await client.query('SELECT 1 FROM rpt.product_taxon_group WHERE tenant_id=$1 AND slug=$2', [
        tenantId,
        slug,
      ])
    ).rowCount === 1
  );
}
export async function insertProductTaxon(
  client: Client,
  tenantId: string,
  group: string,
  slug: string,
  label: string,
) {
  await client.query(
    'INSERT INTO rpt.product_taxon(tenant_id,group_key,slug,label) VALUES($1,$2,$3,$4)',
    [tenantId, group, slug, label],
  );
}
export async function assignProductTaxon(
  client: Client,
  tenantId: string,
  nodeId: string,
  group: string,
  slug: string,
) {
  await client.query(
    'INSERT INTO rpt.product_taxon_assignment(tenant_id,node_id,group_key,slug) VALUES($1,$2,$3,$4)',
    [tenantId, nodeId, group, slug],
  );
}
export async function insertProductCode(
  client: Client,
  tenantId: string,
  id: string,
  nodeId: string,
  codeKind: string,
  scope: { kind: string; key: string },
  code: string,
) {
  await client.query(
    `INSERT INTO rpt.product_code(tenant_id,id,node_id,code_kind,scope_kind,scope_key,code)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, id, nodeId, codeKind, scope.kind, scope.key, code],
  );
}
export async function insertProductFact(
  client: Client,
  tenantId: string,
  input: {
    id: string;
    nodeId: string;
    factKind: string;
    valueKind: string;
    valueText: string | null;
    valueDecimal: string | null;
    unitSlug: string | null;
    taxon: { group: string; slug: string } | null;
    sourceLiteral: string;
    scope: { kind: string; key: string };
    evidenceLevel: string;
    observationId: string;
    previousFactId: string | null;
  },
) {
  await client.query(
    `INSERT INTO rpt.product_fact(tenant_id,id,node_id,fact_kind,value_kind,value_text,
    value_decimal,unit_group,unit_slug,taxon_group,taxon_slug,source_literal,source_scope_kind,
    source_scope_key,evidence_level,observation_id,previous_fact_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      tenantId,
      input.id,
      input.nodeId,
      input.factKind,
      input.valueKind,
      input.valueText,
      input.valueDecimal,
      input.unitSlug ? 'unit' : null,
      input.unitSlug,
      input.taxon?.group ?? null,
      input.taxon?.slug ?? null,
      input.sourceLiteral,
      input.scope.kind,
      input.scope.key,
      input.evidenceLevel,
      input.observationId,
      input.previousFactId,
    ],
  );
}
export async function insertProductRelation(
  client: Client,
  tenantId: string,
  input: {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    relationKind: string;
    observationId: string;
    evidenceLevel: string;
  },
) {
  await client.query(
    `INSERT INTO rpt.product_relation(tenant_id,id,from_node_id,to_node_id,relation_kind,
    observation_id,evidence_level) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      tenantId,
      input.id,
      input.fromNodeId,
      input.toNodeId,
      input.relationKind,
      input.observationId,
      input.evidenceLevel,
    ],
  );
}
