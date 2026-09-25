import type { Client } from 'pg';
import {
  FoundationError,
  type ProductCommand,
  type ProductCreate,
  type ProductListQuery,
} from '@rpt/contracts';
import type { AuthContext } from '@rpt/persistence';
import {
  productCan,
  productReceipt,
  productFinish,
  productRoot,
  productNode,
  insertProductNode,
  insertProductObservation,
  listProductRoots,
  detailProductTree,
  bumpProductVersion,
  setProductLifecycle,
  insertProductTaxonGroup,
  insertProductTaxon,
  productTaxonGroupExists,
  assignProductTaxon,
  insertProductCode,
  insertProductFact,
  insertProductRelation,
} from '@rpt/persistence/product-master';

async function requireRead(client: Client) {
  if (
    !(await productCan(
      client,
      "SELECT authz.session_valid() AND authz.capable(authz.actor_id(),'product','read','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
}
export async function listProducts(client: Client, query: ProductListQuery) {
  await requireRead(client);
  return listProductRoots(client, query.limit, query.afterId);
}
export async function detailProduct(client: Client, id: string) {
  await requireRead(client);
  const detail = await detailProductTree(client, id);
  if (!detail) throw new FoundationError('NOT_FOUND');
  return detail;
}
export async function createProduct(
  client: Client,
  context: AuthContext,
  input: ProductCreate,
  key: string,
  hash: string,
) {
  if (
    !(await productCan(client, "SELECT authz.product_workspace_right($1,'create') AS allowed", [
      input.workspaceId,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const previous = await productReceipt(client, key, hash);
  if (previous) return previous;
  const id = crypto.randomUUID();
  await insertProductNode(client, context, {
    id,
    kind: 'product',
    parentId: null,
    rootId: id,
    workspaceId: input.workspaceId,
    ownerId: context.actorId,
    stableKey: input.stableKey,
    name: input.name,
    lifecycle: input.lifecycle,
  });
  return productFinish(client, key, { id, version: 1 });
}
async function observationFor(
  client: Client,
  context: AuthContext,
  nodeId: string,
  evidence: {
    sourceLiteral: string;
    evidenceLevel: string;
    observation: {
      sourceSystem: string;
      sourceReference: string;
      externalId: string;
      observedAt: string;
      authorityLevel: string;
      scope: { kind: string; key: string };
    };
  },
) {
  const { observation } = evidence;
  if (
    !(await productCan(client, 'SELECT authz.product_source_right($1,$2) AS allowed', [
      observation.sourceSystem,
      observation.authorityLevel,
    ]))
  )
    throw new FoundationError('FORBIDDEN');
  const data = new TextEncoder().encode(JSON.stringify({ nodeId, evidence }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const rawHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  const id = crypto.randomUUID();
  await insertProductObservation(client, context, {
    id,
    nodeId,
    sourceSystem: observation.sourceSystem,
    sourceReference: observation.sourceReference,
    externalId: observation.externalId,
    observedAt: observation.observedAt,
    authorityLevel: observation.authorityLevel,
    sourceLiteral: evidence.sourceLiteral,
    evidenceLevel: evidence.evidenceLevel,
    scope: observation.scope,
    rawHash,
  });
  return id;
}
export async function commandProduct(
  client: Client,
  context: AuthContext,
  rootId: string,
  input: ProductCommand,
  key: string,
  hash: string,
) {
  if (
    !(await productCan(
      client,
      "SELECT authz.session_valid() AND authz.capable(authz.actor_id(),'product','update','CONFIDENTIAL') AS allowed",
    ))
  )
    throw new FoundationError('FORBIDDEN');
  const root = await productRoot(client, rootId, true);
  if (!root) throw new FoundationError('NOT_FOUND');
  if (!(await productCan(client, "SELECT authz.product_allowed($1,'update') AS allowed", [rootId])))
    throw new FoundationError('FORBIDDEN');
  const previous = await productReceipt(client, key, hash);
  if (previous) return previous;
  if (root.version !== input.expectedVersion) throw new FoundationError('CONFLICT');
  const command = input.command;
  let id = rootId;
  const requireNode = async (nodeId: string, withinRoot = true) => {
    const node = await productNode(client, nodeId);
    if (!node || (withinRoot && node.root_id !== rootId)) throw new FoundationError('NOT_FOUND');
    return node;
  };
  if (command.type === 'create_model') {
    id = crypto.randomUUID();
    await insertProductNode(client, context, {
      id,
      kind: 'model',
      parentId: rootId,
      rootId,
      workspaceId: root.workspace_id,
      ownerId: root.owner_id,
      stableKey: command.stableKey,
      name: command.name,
      lifecycle: command.lifecycle,
    });
  } else if (command.type === 'create_variant') {
    const model = await requireNode(command.modelId);
    if (model.kind !== 'model') throw new FoundationError('INVALID_REQUEST');
    id = crypto.randomUUID();
    await insertProductNode(client, context, {
      id,
      kind: 'variant',
      parentId: model.id,
      rootId,
      workspaceId: root.workspace_id,
      ownerId: root.owner_id,
      stableKey: command.stableKey,
      name: command.name,
      lifecycle: null,
    });
  } else if (command.type === 'set_lifecycle') {
    const node = await requireNode(command.nodeId);
    if (node.kind === 'variant') throw new FoundationError('INVALID_REQUEST');
    id = node.id;
    if (node.id !== rootId) await setProductLifecycle(client, id, command.lifecycle);
  } else if (command.type === 'define_group') {
    await insertProductTaxonGroup(client, context.tenantId, command.slug, command.label);
  } else if (command.type === 'define_taxon') {
    if (!(await productTaxonGroupExists(client, context.tenantId, command.group)))
      throw new FoundationError('INVALID_REQUEST');
    await insertProductTaxon(client, context.tenantId, command.group, command.slug, command.label);
  } else if (command.type === 'assign_taxon') {
    await requireNode(command.nodeId);
    await assignProductTaxon(client, context.tenantId, command.nodeId, command.group, command.slug);
  } else if (command.type === 'assign_code') {
    await requireNode(command.nodeId);
    id = crypto.randomUUID();
    await insertProductCode(
      client,
      context.tenantId,
      id,
      command.nodeId,
      command.codeKind,
      command.scope,
      command.code,
    );
  } else if (command.type === 'record_fact') {
    const fact = command.fact;
    await requireNode(fact.nodeId);
    const observationId = await observationFor(client, context, fact.nodeId, fact.evidence);
    id = crypto.randomUUID();
    await insertProductFact(client, context.tenantId, {
      id,
      nodeId: fact.nodeId,
      factKind: fact.factKind,
      valueKind: fact.valueKind,
      valueText: fact.valueText,
      valueDecimal: fact.valueDecimal,
      unitSlug: fact.unitSlug,
      taxon: fact.taxon,
      sourceLiteral: fact.evidence.sourceLiteral,
      scope: fact.evidence.observation.scope,
      evidenceLevel: fact.evidence.evidenceLevel,
      observationId,
      previousFactId: fact.previousFactId,
    });
  } else {
    await requireNode(command.fromNodeId);
    await requireNode(command.toNodeId, false);
    const observationId = await observationFor(
      client,
      context,
      command.fromNodeId,
      command.evidence,
    );
    id = crypto.randomUUID();
    await insertProductRelation(client, context.tenantId, {
      id,
      fromNodeId: command.fromNodeId,
      toNodeId: command.toNodeId,
      relationKind: command.relationKind,
      evidenceLevel: command.evidence.evidenceLevel,
      observationId,
    });
  }
  const version =
    command.type === 'set_lifecycle' && command.nodeId === rootId
      ? await setProductLifecycle(client, rootId, command.lifecycle)
      : await bumpProductVersion(client, rootId);
  if (!version) throw new FoundationError('UNAVAILABLE');
  return productFinish(client, key, { id, version });
}
