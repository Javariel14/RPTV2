import { randomUUID, randomBytes } from 'node:crypto';
import type { Client, ClientConfig } from 'pg';
import {
  FoundationService,
  CommercialCalculatorService,
  QuoteService,
  QuoteWorkflowService,
  OrderCommercialService,
  createQuoteCalculationAttestor,
} from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { seedTenant } from './fixtures.js';
export const lifecycleRequest = () => randomUUID();
const at = (date: string) => `${date}T00:00:00.000Z`;
export async function orderCommercialFixture(root: Client, config: ClientConfig) {
  const a = await seedTenant(root, 'order-life-a'),
    b = await seedTenant(root, 'order-life-b');
  const db = new PostgresDatabase(config),
    foundation = new FoundationService(db),
    calculator = new CommercialCalculatorService(db),
    workflow = new QuoteWorkflowService(db),
    lifecycle = new OrderCommercialService(db);
  const keyId = randomUUID(),
    secret = randomBytes(32).toString('hex');
  await root.query(
    "INSERT INTO authz.quote_calculation_key(tenant_id,id,secret) VALUES($1,$2,decode($3,'hex'))",
    [a.tenant, keyId, secret],
  );
  const quotes = new QuoteService(db, createQuoteCalculationAttestor(keyId, secret));
  const grant = async (
    f: typeof a,
    role: keyof typeof a.users,
    type: string,
    verbs: string[],
    workspace = f.workspace,
  ) => {
    for (const verb of verbs) {
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,$2,$3,$4,'CONFIDENTIAL',false,1) ON CONFLICT DO NOTHING",
        [f.tenant, role, type, verb],
      );
      await root.query(
        "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,$5,$6,'CONFIDENTIAL',1)",
        [f.tenant, randomUUID(), workspace, f.users[role], type, verb],
      );
    }
  };
  for (const f of [a, b]) {
    for (const role of ['owner', 'delegate', 'ancestor', 'ai'] as const) {
      await grant(f, role, 'cpq_quote', ['read', 'create', 'revise', 'issue', 'accept']);
      await grant(f, role, 'cpq_order', ['read', 'create', 'cancel', 'replace']);
      await grant(f, role, 'commercial', ['calculate']);
      for (const domain of ['product', 'catalog', 'pricing', 'person'])
        await grant(f, role, domain, ['read']);
    }
    for (const domain of ['product', 'catalog', 'pricing'])
      await grant(f, 'owner', domain, ['create', 'update']);
    await grant(f, 'owner', 'pricing', ['manage']);
    await grant(f, 'owner', 'market_admin', ['read', 'manage', 'global']);
    await grant(f, 'owner', 'commercial', ['configure']);
    for (const domain of ['product_master', 'market_catalog', 'pricing', 'order_commercial'])
      await root.query(
        "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_USER',$3,'manual')",
        [f.tenant, f.users.owner, domain],
      );
  }
  await root.query(
    "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_USER','order_commercial','manual')",
    [a.tenant, a.users.delegate],
  );
  const evidence = (literal: string) => ({
    sourceSystem: 'RPT_USER',
    sourceReference: 'fixture://order-commercial',
    externalId: randomUUID(),
    observedAt: at('2026-01-01'),
    authorityLevel: 'manual',
    evidenceLevel: 'exact_primary',
    sourceLiteral: literal,
  });
  const product = await foundation.createProduct(
    a.identities.owner,
    lifecycleRequest(),
    {
      schemaVersion: 1,
      workspaceId: a.workspace,
      stableKey: 'lifecycle-product',
      name: 'Synthetic lifecycle product',
      lifecycle: 'active',
    },
    'lifecycle-product',
  );
  const market = async (countryCode: string) => {
    const m = await foundation.createCatalogMarket(
      a.identities.owner,
      lifecycleRequest(),
      {
        schemaVersion: 1,
        countryCode,
        currency: 'USD',
        locale: `es-${countryCode}`,
        timezone: countryCode === 'EC' ? 'America/Guayaquil' : 'UTC',
      },
      'lifecycle-market-' + countryCode,
    );
    await foundation.grantAdminMarketScope(
      a.identities.owner,
      lifecycleRequest(),
      { schemaVersion: 1, userId: a.users.owner, marketId: m.id },
      'lifecycle-scope-' + countryCode,
    );
    await foundation.setCatalogMarketStatus(
      a.identities.owner,
      lifecycleRequest(),
      m.id,
      { schemaVersion: 1, expectedVersion: 1, status: 'active' },
      'lifecycle-market-active-' + countryCode,
    );
    const mp = await foundation.createMarketProduct(
      a.identities.owner,
      lifecycleRequest(),
      {
        schemaVersion: 1,
        marketId: m.id,
        nodeId: product.id,
        stableKey: countryCode.toLowerCase(),
        displayName: countryCode,
        commercialCode: countryCode,
        availability: 'available',
        effectiveAt: at('2026-01-01'),
        evidence: evidence('Synthetic product'),
      },
      'lifecycle-mp-' + countryCode,
    );
    const list = await foundation.createPriceList(
      a.identities.owner,
      lifecycleRequest(),
      {
        schemaVersion: 1,
        marketId: m.id,
        workspaceId: a.workspace,
        stableKey: countryCode.toLowerCase(),
        name: countryCode,
        currency: 'USD',
        status: 'draft',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('Synthetic official list'),
      },
      'lifecycle-list-' + countryCode,
    );
    const entry = await foundation.addPriceEntry(
      a.identities.owner,
      lifecycleRequest(),
      list.id,
      {
        schemaVersion: 1,
        expectedVersion: 1,
        marketProductId: mp.id,
        currency: 'USD',
        amount: '100.00',
        taxTreatment: 'tax_exclusive',
        taxRate: '0.10',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('Synthetic exact amount'),
      },
      'lifecycle-price-' + countryCode,
    );
    await foundation.activatePriceList(
      a.identities.owner,
      lifecycleRequest(),
      list.id,
      { schemaVersion: 1, expectedVersion: entry.version },
      'lifecycle-publish-' + countryCode,
    );
    return { marketId: m.id, mp: mp.id, list: list.id };
  };
  const ec = await market('EC'),
    co = await market('CO');
  const configuration = {
    schemaVersion: 1,
    marketId: ec.marketId,
    priceListId: ec.list,
    name: 'Synthetic lifecycle snapshot configuration',
    expectedVersion: 0,
    validFrom: at('2026-01-01'),
    validTo: null,
  };
  const rules = await calculator.createConfigurationVersion(
    a.identities.owner,
    lifecycleRequest(),
    {
      ...configuration,
      kind: 'rules',
      stableKey: 'lifecycle-rules',
      rules: [{ kind: 'percentage_discount', value: '0.10', autoLimit: '0.20', priority: 1 }],
    },
    'lifecycle-rules',
  );
  const bundle = await calculator.createConfigurationVersion(
    a.identities.owner,
    lifecycleRequest(),
    {
      ...configuration,
      kind: 'bundle',
      stableKey: 'lifecycle-bundle',
      pricingMode: 'COMPONENT_SUM',
      lines: [{ marketProductId: ec.mp, quantity: '2' }],
    },
    'lifecycle-bundle',
  );
  const financing = await calculator.createConfigurationVersion(
    a.identities.owner,
    lifecycleRequest(),
    {
      ...configuration,
      kind: 'financing',
      stableKey: 'lifecycle-financing',
      mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
      terms: [{ months: 3, value: '0.10' }],
    },
    'lifecycle-financing',
  );
  for (const item of [rules, bundle, financing])
    await calculator.transitionConfigurationVersion(
      a.identities.owner,
      lifecycleRequest(),
      item.versionId,
      {
        schemaVersion: 1,
        expectedVersion: 1,
        action: 'activate',
        effectiveAt: at('2026-01-01'),
      },
      'lifecycle-activate-' + item.id,
    );
  const term = (
    await root.query('SELECT id FROM rpt.commercial_financing_term WHERE version_id=$1', [
      financing.versionId,
    ])
  ).rows[0].id as string;
  for (const role of ['delegate', 'ancestor', 'ai'] as const)
    await foundation.assignOperationalMarket(
      a.identities.owner,
      lifecycleRequest(),
      {
        schemaVersion: 1,
        userId: a.users[role],
        marketId: role === 'ai' ? co.marketId : ec.marketId,
        expectedVersion: 0,
        reason: 'Synthetic controlled assignment',
      },
      'lifecycle-assignment-' + role,
    );
  await grant(a, 'ancestor', 'market_admin', ['read', 'manage']);
  // Tenant B must also be a valid operational actor, not merely possess capability names.
  const betaMarket = await foundation.createCatalogMarket(
    b.identities.owner,
    lifecycleRequest(),
    {
      schemaVersion: 1,
      countryCode: 'EC',
      currency: 'USD',
      locale: 'es-EC',
      timezone: 'America/Guayaquil',
    },
    'lifecycle-beta-market',
  );
  await foundation.grantAdminMarketScope(
    b.identities.owner,
    lifecycleRequest(),
    { schemaVersion: 1, userId: b.users.owner, marketId: betaMarket.id },
    'lifecycle-beta-scope',
  );
  await foundation.setCatalogMarketStatus(
    b.identities.owner,
    lifecycleRequest(),
    betaMarket.id,
    {
      schemaVersion: 1,
      expectedVersion: 1,
      status: 'active',
    },
    'lifecycle-beta-active',
  );
  await foundation.assignOperationalMarket(
    b.identities.owner,
    lifecycleRequest(),
    {
      schemaVersion: 1,
      userId: b.users.delegate,
      marketId: betaMarket.id,
      expectedVersion: 0,
      reason: 'Synthetic valid Tenant B operational actor',
    },
    'lifecycle-beta-assignment',
  );
  await foundation.grantAdminMarketScope(
    a.identities.owner,
    lifecycleRequest(),
    { schemaVersion: 1, userId: a.users.ancestor, marketId: ec.marketId },
    'lifecycle-country-scope',
  );
  const create = async (
    foreign = false,
    person: string | null = a.person,
    workspace = a.workspace,
    richSnapshot = false,
  ) => {
    const catalog = foreign ? co : ec,
      actor = foreign ? a.identities.ai : a.identities.delegate;
    const q = await quotes.createQuote(actor, lifecycleRequest(), randomUUID(), {
      schemaVersion: 1,
      workspaceId: workspace,
      personId: person,
      calculation: {
        schemaVersion: 1,
        asOf: at('2026-05-01'),
        priceListId: catalog.list,
        lines: richSnapshot
          ? [{ kind: 'bundle', bundleId: bundle.id, quantity: '2' }]
          : [{ kind: 'product', marketProductId: catalog.mp, quantity: '2' }],
        ...(richSnapshot
          ? { ruleSetId: rules.id, financing: { planId: financing.id, termId: term } }
          : {}),
      },
    });
    await quotes.transitionQuoteStatus(actor, lifecycleRequest(), q.id, {
      schemaVersion: 1,
      expectedVersion: 1,
      action: 'issue',
    });
    const acceptance = await workflow.recordQuoteAcceptance(
      actor,
      lifecycleRequest(),
      randomUUID(),
      {
        schemaVersion: 1,
        quoteVersionId: q.versionId,
        expectedVersion: 2,
        method: 'administrative_record',
        note: 'Synthetic recorded acceptance, no electronic signature',
      },
    );
    const key = randomUUID(),
      input = {
        schemaVersion: 1,
        quoteVersionId: q.versionId,
        expectedVersion: 3,
        acceptanceId: acceptance.id,
      };
    const order = await workflow.createOrderFromAcceptedQuote(
      actor,
      lifecycleRequest(),
      key,
      input,
    );
    return {
      ...order,
      quoteId: q.id,
      versionId: q.versionId,
      acceptanceId: acceptance.id,
      actor,
      key,
      input,
    };
  };
  return {
    a,
    b,
    db,
    foundation,
    calculator,
    quotes,
    workflow,
    lifecycle,
    ec,
    co,
    grant,
    evidence,
    create,
  };
}
