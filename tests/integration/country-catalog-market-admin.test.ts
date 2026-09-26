import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError } from '@rpt/contracts';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { seedTenant } from '../helpers/fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

const at = (date: string) => `${date}T00:00:00.000Z`;
const evidence = (literal: string) => ({
  sourceSystem: 'RPT_USER',
  sourceReference: 'synthetic-admin',
  externalId: randomUUID(),
  observedAt: at('2026-01-01'),
  authorityLevel: 'manual',
  evidenceLevel: 'exact_primary',
  sourceLiteral: literal,
});
const denied = (code: string) => (error: unknown) =>
  error instanceof FoundationError && error.code === code;

void test('E3A2 F1 data-driven Chile, market-scoped RLS, reassignment and FX', async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    const a = await seedTenant(root, 'market-admin-a');
    const b = await seedTenant(root, 'market-admin-b');
    const grant = async (role: string, type: string, verb: string, userId?: string) => {
      await root!.query(
        "INSERT INTO authz.role_capability VALUES($1,$2,$3,$4,'CONFIDENTIAL',false,1)",
        [a.tenant, role, type, verb],
      );
      if (userId)
        await root!.query(
          `INSERT INTO authz.workspace_permission
        (tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
        VALUES($1,$2,$3,$4,$5,$6,'CONFIDENTIAL',1)`,
          [a.tenant, randomUUID(), a.workspace, userId, type, verb],
        );
    };
    for (const type of ['product', 'catalog', 'pricing']) {
      for (const verb of ['read', 'create', 'update'])
        await grant('owner', type, verb, a.users.owner);
      for (const [role, user] of [
        ['delegate', a.users.delegate],
        ['ai', a.users.ai],
        ['ancestor', a.users.ancestor],
      ] as Array<[string, string]>)
        await grant(role, type, 'read', user);
    }
    await grant('owner', 'pricing', 'manage');
    await grant('delegate', 'pricing', 'create', a.users.delegate);
    for (const type of ['product', 'catalog']) await grant('admin', type, 'read', a.users.outsider);
    for (const verb of ['read', 'manage', 'global']) await grant('owner', 'market_admin', verb);
    for (const role of ['ai', 'ancestor'])
      for (const verb of ['read', 'manage']) await grant(role, 'market_admin', verb);
    for (const domain of ['product_master', 'market_catalog', 'pricing', 'fx'])
      await root.query(
        `INSERT INTO authz.source_authority
        (tenant_id,user_id,source_system,domain_key,authority_level)
        VALUES($1,$2,'RPT_USER',$3,'manual')`,
        [a.tenant, a.users.owner, domain],
      );
    await root.query(
      `INSERT INTO authz.source_authority
      (tenant_id,user_id,source_system,domain_key,authority_level)
      VALUES($1,$2,'RPT_USER','pricing','manual')`,
      [a.tenant, a.users.delegate],
    );
    const runtime = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(runtime);
    const call = () => randomUUID();
    const owner = a.identities.owner;
    const product = await service.createProduct(
      owner,
      call(),
      {
        schemaVersion: 1,
        workspaceId: a.workspace,
        stableKey: 'f1-global',
        name: 'Synthetic F1 global',
        lifecycle: 'active',
      },
      'f1-product-one',
    );
    await t.test('CLP and draft Chile bootstrap without country-specific code', async () => {
      await assert.rejects(
        () =>
          service.registerCatalogCurrency(
            owner,
            call(),
            {
              schemaVersion: 1,
              code: 'ZZZ',
              name: 'Invalid',
              minorUnits: 2,
            },
            'f1-invalid-currency',
          ),
        denied('INVALID_REQUEST'),
      );
      await service.registerCatalogCurrency(
        owner,
        call(),
        { schemaVersion: 1, code: 'CLP', name: 'Chilean peso', minorUnits: 0 },
        'f1-clp-register',
      );
      const chile = await service.createCatalogMarket(
        owner,
        call(),
        {
          schemaVersion: 1,
          countryCode: 'CL',
          currency: 'CLP',
          timezone: 'America/Santiago',
          locale: 'es-CL',
          evidence: evidence('Chile catalog definition'),
        },
        'f1-market-cl',
      );
      assert.ok(chile.id);
      assert.equal(
        (await service.listCatalogMarkets(owner, call())).find(
          (m: { id: string }) => m.id === chile.id,
        )?.status,
        'draft',
      );
      await assert.rejects(
        () =>
          service.setCatalogMarketStatus(
            owner,
            call(),
            chile.id,
            { schemaVersion: 1, expectedVersion: 1, status: 'active' },
            'f1-cl-premature',
          ),
        denied('INVALID_REQUEST'),
      );
      await service.setCatalogCurrencyStatus(
        owner,
        call(),
        'CLP',
        { schemaVersion: 1, expectedVersion: 1, status: 'active' },
        'f1-clp-activate',
      );
      const clProduct = await service.createMarketProduct(
        owner,
        call(),
        {
          schemaVersion: 1,
          marketId: chile.id,
          nodeId: product.id,
          stableKey: 'cl-syn',
          displayName: 'Synthetic Chile',
          commercialCode: 'CL-SYN',
          availability: 'planned',
          effectiveAt: at('2026-01-01'),
          evidence: evidence('Planned Chile'),
        },
        'f1-cl-product',
      );
      const clList = await service.createPriceList(
        owner,
        call(),
        {
          schemaVersion: 1,
          marketId: chile.id,
          workspaceId: a.workspace,
          stableKey: 'cl-retail',
          name: 'Chile retail draft',
          currency: 'CLP',
          status: 'draft',
          validFrom: at('2026-01-01'),
          validTo: null,
          evidence: evidence('Chile retail'),
        },
        'f1-cl-list',
      );
      await service.addPriceEntry(
        owner,
        call(),
        clList.id,
        {
          schemaVersion: 1,
          expectedVersion: 1,
          marketProductId: clProduct.id,
          currency: 'CLP',
          amount: '420000',
          taxTreatment: 'tax_unknown',
          taxRate: null,
          validFrom: at('2026-01-01'),
          validTo: null,
          evidence: evidence('CLP 420000 tax unknown'),
        },
        'f1-cl-price',
      );
      assert.equal(
        await service.currentCatalogPrice(owner, call(), {
          priceListId: clList.id,
          marketProductId: clProduct.id,
          asOf: at('2026-06-01'),
        }),
        null,
      );
      await service.grantAdminMarketScope(
        owner,
        call(),
        { schemaVersion: 1, userId: a.users.owner, marketId: chile.id },
        'f1-cl-owner-scope',
      );
      await service.setCatalogMarketStatus(
        owner,
        call(),
        chile.id,
        { schemaVersion: 1, expectedVersion: 1, status: 'active' },
        'f1-cl-activate',
      );
      await assert.rejects(
        () =>
          service.setCatalogCurrencyStatus(
            owner,
            call(),
            'CLP',
            { schemaVersion: 1, expectedVersion: 2, status: 'inactive' },
            'f1-clp-in-use',
          ),
        denied('INVALID_REQUEST'),
      );
      await service.activatePriceList(
        owner,
        call(),
        clList.id,
        { schemaVersion: 1, expectedVersion: 2 },
        'f1-cl-list-activate',
      );
      assert.equal(
        (
          await service.currentCatalogPrice(owner, call(), {
            priceListId: clList.id,
            marketProductId: clProduct.id,
            asOf: at('2026-06-01'),
          })
        )?.amount,
        '420000.0000',
      );
      await service.setCatalogMarketStatus(
        owner,
        call(),
        chile.id,
        { schemaVersion: 1, expectedVersion: 2, status: 'retired' },
        'f1-cl-retire',
      );
      assert.equal(
        (
          await service.listMarketCatalog(owner, call(), {
            marketId: chile.id,
            asOf: at('2026-06-01'),
          })
        )[0].availability,
        'planned',
      );
    });
    const ec = await service.createCatalogMarket(
      owner,
      call(),
      {
        schemaVersion: 1,
        countryCode: 'EC',
        currency: 'USD',
        timezone: 'America/Guayaquil',
        locale: 'es-EC',
      },
      'f1-market-ec',
    );
    const co = await service.createCatalogMarket(
      owner,
      call(),
      {
        schemaVersion: 1,
        countryCode: 'CO',
        currency: 'COP',
        timezone: 'America/Bogota',
        locale: 'es-CO',
        evidence: evidence('CO market definition'),
      },
      'f1-market-co',
    );
    let coOwnerScopeId = '';
    for (const [id, slug] of [
      [ec.id, 'ec'],
      [co.id, 'co'],
    ] as Array<[string, string]>) {
      const scope = await service.grantAdminMarketScope(
        owner,
        call(),
        { schemaVersion: 1, userId: a.users.owner, marketId: id },
        `f1-owner-${slug}`,
      );
      if (slug === 'co') coOwnerScopeId = scope.id;
      await service.setCatalogMarketStatus(
        owner,
        call(),
        id,
        { schemaVersion: 1, expectedVersion: 1, status: 'active' },
        `f1-activate-${slug}`,
      );
    }
    const ecProduct = await service.createMarketProduct(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: ec.id,
        nodeId: product.id,
        stableKey: 'ec-syn',
        displayName: 'Synthetic Ecuador',
        commercialCode: 'EC-SYN',
        availability: 'available',
        effectiveAt: at('2026-01-01'),
        evidence: evidence('EC product'),
      },
      'f1-product-ec',
    );
    const coProduct = await service.createMarketProduct(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: co.id,
        nodeId: product.id,
        stableKey: 'co-syn',
        displayName: 'Synthetic Colombia',
        commercialCode: 'CO-SYN',
        availability: 'available',
        effectiveAt: at('2026-01-01'),
        evidence: evidence('CO product'),
      },
      'f1-product-co',
    );
    const ecList = await service.createPriceList(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: ec.id,
        workspaceId: a.workspace,
        stableKey: 'ec-retail',
        name: 'Ecuador retail',
        currency: 'USD',
        status: 'draft',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('EC retail'),
      },
      'f1-list-ec',
    );
    const ecDraft = await service.createPriceList(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: ec.id,
        workspaceId: a.workspace,
        stableKey: 'ec-draft',
        name: 'Ecuador draft',
        currency: 'USD',
        status: 'draft',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('EC draft'),
      },
      'f1-list-ec-draft',
    );
    const coList = await service.createPriceList(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: co.id,
        workspaceId: a.workspace,
        stableKey: 'co-retail',
        name: 'Colombia retail',
        currency: 'COP',
        status: 'draft',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('CO retail'),
      },
      'f1-list-co',
    );
    await service.activatePriceList(
      owner,
      call(),
      ecList.id,
      { schemaVersion: 1, expectedVersion: 1 },
      'f1-list-ec-activate',
    );
    await service.activatePriceList(
      owner,
      call(),
      coList.id,
      { schemaVersion: 1, expectedVersion: 1 },
      'f1-list-co-activate',
    );
    const coEntry = await service.addPriceEntry(
      owner,
      call(),
      coList.id,
      {
        schemaVersion: 1,
        expectedVersion: 2,
        marketProductId: coProduct.id,
        currency: 'COP',
        amount: '420000',
        taxTreatment: 'tax_unknown',
        taxRate: null,
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('Published CO 420000'),
      },
      'f1-entry-co',
    );
    await t.test('advisor lock, same-tenant BOLA, country and regional admin scopes', async () => {
      await service.assignOperationalMarket(
        owner,
        call(),
        {
          schemaVersion: 1,
          userId: a.users.delegate,
          marketId: ec.id,
          expectedVersion: 0,
          reason: 'Synthetic EC assignment',
        },
        'f1-advisor-ec',
      );
      assert.equal(await service.operationalMarket(a.identities.delegate, call()), ec.id);
      assert.equal(
        (
          await service.listMarketCatalog(a.identities.delegate, call(), {
            marketId: ec.id,
            asOf: at('2026-06-01'),
          })
        )[0].id,
        ecProduct.id,
      );
      await service.assignOperationalMarket(
        owner,
        call(),
        {
          schemaVersion: 1,
          userId: a.users.outsider,
          marketId: ec.id,
          expectedVersion: 0,
          reason: 'Catalog-only synthetic actor',
        },
        'f1-catalog-only',
      );
      assert.equal(
        (
          await service.listMarketCatalog(a.identities.outsider, call(), {
            marketId: ec.id,
            asOf: at('2026-06-01'),
          })
        )[0].id,
        ecProduct.id,
      );
      await assert.rejects(
        () =>
          service.currentCatalogPrice(a.identities.outsider, call(), {
            priceListId: ecList.id,
            marketProductId: ecProduct.id,
            asOf: at('2026-06-01'),
          }),
        denied('FORBIDDEN'),
      );
      await assert.rejects(
        () =>
          service.listMarketCatalog(a.identities.delegate, call(), {
            marketId: co.id,
            asOf: at('2026-06-01'),
          }),
        denied('NOT_FOUND'),
      );
      await assert.rejects(
        () =>
          service.currentCatalogPrice(a.identities.delegate, call(), {
            priceListId: coList.id,
            marketProductId: coProduct.id,
            asOf: at('2026-06-01'),
          }),
        denied('NOT_FOUND'),
      );
      await assert.rejects(
        () =>
          service.assignOperationalMarket(
            a.identities.delegate,
            call(),
            {
              schemaVersion: 1,
              userId: a.users.delegate,
              marketId: co.id,
              expectedVersion: 1,
              reason: 'Forbidden self switch',
            },
            'f1-self-switch',
          ),
        denied('FORBIDDEN'),
      );
      const direct = await runtime.request(a.identities.delegate, call(), async (client) => ({
        market: (
          await client.query('SELECT market_id FROM rpt.catalog_market WHERE market_id=$1', [co.id])
        ).rowCount,
        product: (
          await client.query('SELECT id FROM rpt.market_product WHERE id=$1', [coProduct.id])
        ).rowCount,
        list: (await client.query('SELECT id FROM rpt.price_list WHERE id=$1', [coList.id]))
          .rowCount,
        entry: (await client.query('SELECT id FROM rpt.price_list_entry WHERE id=$1', [coEntry.id]))
          .rowCount,
        draft: (await client.query('SELECT id FROM rpt.price_list WHERE id=$1', [ecDraft.id]))
          .rowCount,
      }));
      assert.deepEqual(direct, { market: 0, product: 0, list: 0, entry: 0, draft: 0 });
      for (const [type, verb] of [
        ['product', 'read'],
        ['catalog', 'read'],
        ['pricing', 'read'],
        ['market_admin', 'read'],
        ['market_admin', 'manage'],
        ['market_admin', 'global'],
      ] as Array<[string, string]>)
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner',$2,$3,'CONFIDENTIAL',false,1)",
          [b.tenant, type, verb],
        );
      const foreign = await runtime.request(
        b.identities.owner,
        call(),
        async (client) =>
          (await client.query('SELECT id FROM rpt.market_product WHERE id=$1', [coProduct.id]))
            .rowCount,
      );
      assert.equal(foreign, 0);
      const countryScope = await service.grantAdminMarketScope(
        owner,
        call(),
        { schemaVersion: 1, userId: a.users.ai, marketId: ec.id },
        'f1-country-ec',
      );
      assert.equal(
        (
          await service.listMarketCatalog(a.identities.ai, call(), {
            marketId: ec.id,
            asOf: at('2026-06-01'),
          })
        ).length,
        1,
      );
      await assert.rejects(
        () =>
          service.listMarketCatalog(a.identities.ai, call(), {
            marketId: co.id,
            asOf: at('2026-06-01'),
          }),
        denied('NOT_FOUND'),
      );
      await assert.rejects(
        () =>
          service.assignOperationalMarket(
            a.identities.ai,
            call(),
            {
              schemaVersion: 1,
              userId: a.users.delegate,
              marketId: co.id,
              expectedVersion: 1,
              reason: 'Out-of-scope reassignment',
            },
            'f1-country-denied-co',
          ),
        denied('FORBIDDEN'),
      );
      await service.revokeAdminMarketScope(owner, call(), countryScope.id, 'f1-revoke-country-ec');
      await assert.rejects(
        () =>
          service.listMarketCatalog(a.identities.ai, call(), {
            marketId: ec.id,
            asOf: at('2026-06-01'),
          }),
        denied('NOT_FOUND'),
      );
      for (const [id, slug] of [
        [ec.id, 'ec'],
        [co.id, 'co'],
      ])
        await service.grantAdminMarketScope(
          owner,
          call(),
          { schemaVersion: 1, userId: a.users.ancestor, marketId: id },
          `f1-regional-${slug}`,
        );
      assert.equal(
        (
          await service.listMarketCatalog(a.identities.ancestor, call(), {
            marketId: co.id,
            asOf: at('2026-06-01'),
          })
        ).length,
        1,
      );
      await assert.rejects(
        () =>
          service.grantAdminMarketScope(
            owner,
            call(),
            { schemaVersion: 1, userId: b.users.owner, marketId: ec.id },
            'f1-cross-tenant-scope',
          ),
        denied('NOT_FOUND'),
      );
    });
    await t.test(
      'PriceList creation is draft-only and publication requires pricing manage',
      async () => {
        const input = {
          schemaVersion: 1,
          marketId: ec.id,
          workspaceId: a.workspace,
          stableKey: 'delegate-draft',
          name: 'Synthetic delegate draft',
          currency: 'USD',
          status: 'draft',
          validFrom: at('2026-01-01'),
          validTo: null,
          evidence: evidence('Delegate draft'),
        } as const;
        const draft = await service.createPriceList(
          a.identities.delegate,
          call(),
          input,
          'f2-delegate-draft',
        );
        assert.ok(draft.id);
        const createOnly = await runtime.request(
          a.identities.delegate,
          call(),
          async (client) =>
            (
              await client.query<{ create: boolean; update: boolean; manage: boolean }>(
                `SELECT authz.capable(authz.actor_id(),'pricing','create','CONFIDENTIAL') AS create,
               authz.capable(authz.actor_id(),'pricing','update','CONFIDENTIAL') AS update,
               authz.capable(authz.actor_id(),'pricing','manage','CONFIDENTIAL') AS manage`,
              )
            ).rows[0],
        );
        assert.deepEqual(createOnly, { create: true, update: false, manage: false });
        await assert.rejects(() =>
          service.createPriceList(
            a.identities.delegate,
            call(),
            { ...input, stableKey: 'delegate-active', status: 'active' },
            'f2-delegate-active',
          ),
        );
        await assert.rejects(() =>
          runtime.request(a.identities.delegate, call(), (client) =>
            client.query(
              `INSERT INTO rpt.price_list
            (tenant_id,id,market_id,workspace_id,owner_id,stable_key,name,currency,status,valid_from)
            VALUES($1,$2,$3,$4,$5,'direct-active','Direct active','USD','active',$6)`,
              [a.tenant, randomUUID(), ec.id, a.workspace, a.users.delegate, at('2026-01-01')],
            ),
          ),
        );
        await assert.rejects(() =>
          runtime.request(owner, call(), (client) =>
            client.query(
              `INSERT INTO rpt.price_list
              (tenant_id,id,market_id,workspace_id,owner_id,stable_key,name,currency,status,valid_from)
              VALUES($1,$2,$3,$4,$5,'admin-direct-active','Admin direct active','USD','active',$6)`,
              [a.tenant, randomUUID(), ec.id, a.workspace, a.users.owner, at('2026-01-01')],
            ),
          ),
        );
        await assert.rejects(
          () =>
            service.activatePriceList(
              a.identities.delegate,
              call(),
              draft.id,
              { schemaVersion: 1, expectedVersion: 1 },
              'f2-delegate-activate',
            ),
          denied('NOT_FOUND'),
        );
        await grant('delegate', 'pricing', 'update', a.users.delegate);
        const unauthorizedUpdate = await runtime.request(a.identities.delegate, call(), (client) =>
          client.query("UPDATE rpt.price_list SET status='active',version=version+1 WHERE id=$1", [
            draft.id,
          ]),
        );
        assert.equal(unauthorizedUpdate.rowCount, 0);
        assert.equal(
          (
            await root!.query<{ status: string }>('SELECT status FROM rpt.price_list WHERE id=$1', [
              draft.id,
            ])
          ).rows[0]?.status,
          'draft',
        );
        await assert.rejects(() =>
          runtime.request(owner, call(), (client) =>
            client.query(
              "UPDATE rpt.price_list SET status='closed',valid_to=$2,version=version+1 WHERE id=$1",
              [ecDraft.id, at('2027-01-01')],
            ),
          ),
        );
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='owner' AND object_type='pricing' AND verb='manage'",
          [a.tenant],
        );
        await assert.rejects(
          () =>
            service.activatePriceList(
              owner,
              call(),
              ecDraft.id,
              { schemaVersion: 1, expectedVersion: 1 },
              'f2-admin-without-publish',
            ),
          denied('FORBIDDEN'),
        );
        await grant('owner', 'pricing', 'manage');
        const activated = await service.activatePriceList(
          owner,
          call(),
          ecDraft.id,
          { schemaVersion: 1, expectedVersion: 1 },
          'f2-owner-activate',
        );
        assert.equal(activated.version, 2);
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='owner' AND object_type='pricing' AND verb='manage'",
          [a.tenant],
        );
        await assert.rejects(
          () =>
            service.closePriceList(
              owner,
              call(),
              ecDraft.id,
              { schemaVersion: 1, expectedVersion: 2, validTo: at('2027-01-01') },
              'f2-admin-without-close',
            ),
          denied('FORBIDDEN'),
        );
        await grant('owner', 'pricing', 'manage');
        const closed = await service.closePriceList(
          owner,
          call(),
          ecDraft.id,
          { schemaVersion: 1, expectedVersion: 2, validTo: at('2027-01-01') },
          'f2-owner-close',
        );
        assert.equal(closed.version, 3);
      },
    );
    await t.test('admin reassignment closes EC history and opens CO immediately', async () => {
      const result = await service.assignOperationalMarket(
        owner,
        call(),
        {
          schemaVersion: 1,
          userId: a.users.delegate,
          marketId: co.id,
          expectedVersion: 1,
          reason: 'Synthetic move to CO',
        },
        'f1-advisor-co',
      );
      assert.deepEqual(
        await service.assignOperationalMarket(
          owner,
          call(),
          {
            schemaVersion: 1,
            userId: a.users.delegate,
            marketId: co.id,
            expectedVersion: 1,
            reason: 'Synthetic move to CO',
          },
          'f1-advisor-co',
        ),
        result,
      );
      assert.equal(await service.operationalMarket(a.identities.delegate, call()), co.id);
      await assert.rejects(
        () =>
          service.listMarketCatalog(a.identities.delegate, call(), {
            marketId: ec.id,
            asOf: at('2026-06-01'),
          }),
        denied('NOT_FOUND'),
      );
      assert.equal(
        (
          await service.listMarketCatalog(a.identities.delegate, call(), {
            marketId: co.id,
            asOf: at('2026-06-01'),
          })
        )[0].id,
        coProduct.id,
      );
      const rows = await root!.query<{ market_id: string; valid_to: Date | null }>(
        `SELECT market_id,valid_to
        FROM authz.operational_market_assignment WHERE tenant_id=$1 AND user_id=$2 ORDER BY valid_from`,
        [a.tenant, a.users.delegate],
      );
      assert.deepEqual(
        rows.rows.map((r) => r.market_id),
        [ec.id, co.id],
      );
      assert.ok(rows.rows[0]?.valid_to);
      assert.equal(rows.rows[1]?.valid_to, null);
    });
    await t.test('FX is exact, temporal and explicitly derived, not published', async () => {
      const first = await service.recordExchangeRate(
        owner,
        call(),
        {
          schemaVersion: 1,
          marketId: co.id,
          baseCurrency: 'USD',
          quoteCurrency: 'COP',
          rate: '4200.125',
          validFrom: at('2026-01-01'),
          validTo: at('2026-06-01'),
          evidence: evidence('USD/COP 4200.125'),
        },
        'f1-fx-one',
      );
      await service.recordExchangeRate(
        owner,
        call(),
        {
          schemaVersion: 1,
          marketId: co.id,
          baseCurrency: 'USD',
          quoteCurrency: 'COP',
          rate: '4300.5',
          validFrom: at('2026-06-01'),
          validTo: null,
          evidence: evidence('USD/COP 4300.5'),
        },
        'f1-fx-two',
      );
      const before = await service.referenceConversion(owner, call(), {
        marketId: co.id,
        baseCurrency: 'USD',
        quoteCurrency: 'COP',
        amount: '100.00',
        asOf: at('2026-05-31'),
      });
      const after = await service.referenceConversion(owner, call(), {
        marketId: co.id,
        baseCurrency: 'USD',
        quoteCurrency: 'COP',
        amount: '100.00',
        asOf: at('2026-06-01'),
      });
      assert.equal(before?.derivedAmount, '420012.50');
      assert.equal(after?.derivedAmount, '430050.00');
      assert.equal(after?.kind, 'DERIVED_REFERENCE');
      assert.equal(after?.officialMarketPrice, false);
      assert.equal(
        (
          await service.currentCatalogPrice(owner, call(), {
            priceListId: coList.id,
            marketProductId: coProduct.id,
            asOf: at('2026-06-01'),
          })
        )?.kind,
        'PUBLISHED_MARKET_PRICE',
      );
      assert.equal(
        (
          await service.currentCatalogPrice(owner, call(), {
            priceListId: coList.id,
            marketProductId: coProduct.id,
            asOf: at('2026-06-01'),
          })
        )?.amount,
        '420000.0000',
      );
      await assert.rejects(
        () =>
          service.recordExchangeRate(
            owner,
            call(),
            {
              schemaVersion: 1,
              marketId: co.id,
              baseCurrency: 'USD',
              quoteCurrency: 'COP',
              rate: '4400',
              validFrom: at('2026-05-01'),
              validTo: at('2026-07-01'),
              evidence: evidence('Overlapping rate'),
            },
            'f1-fx-overlap',
          ),
        denied('CONFLICT'),
      );
      assert.ok(first.id);
      await assert.rejects(
        () =>
          service.referenceConversion(a.identities.ai, call(), {
            marketId: co.id,
            baseCurrency: 'USD',
            quoteCurrency: 'COP',
            amount: '100',
            asOf: at('2026-06-01'),
          }),
        denied('FORBIDDEN'),
      );
      const rateRows = await root!.query(
        'SELECT count(*)::int AS n FROM rpt.exchange_rate WHERE tenant_id=$1 AND market_id=$2',
        [a.tenant, co.id],
      );
      assert.equal(rateRows.rows[0].n, 2);
    });
    await t.test('typed catalog evidence blocks same-UUID cross-market aliasing', async () => {
      const source = await root!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM rpt.source_observation
         WHERE tenant_id=$1 AND domain_key='market_catalog' AND commerce_subject_type='market'
         AND subject_id=$2`,
        [a.tenant, co.id],
      );
      assert.equal(source.rows[0]?.n, 1);
      await service.revokeAdminMarketScope(owner, call(), coOwnerScopeId, 'f2-owner-revoke-co');
      await root!.query(
        `DELETE FROM authz.role_capability
         WHERE tenant_id=$1 AND role_key='owner' AND object_type='market_admin' AND verb='global'`,
        [a.tenant],
      );
      const countEvidence = (subjectType: string) =>
        runtime.request(
          owner,
          call(),
          async (client) =>
            (
              await client.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM rpt.source_observation
               WHERE domain_key='market_catalog' AND subject_id=$1 AND commerce_subject_type=$2`,
                [co.id, subjectType],
              )
            ).rows[0]!.n,
        );
      assert.equal(await countEvidence('market'), 0);
      await runtime.request(owner, call(), (client) =>
        client.query(
          `INSERT INTO rpt.market_product
           (tenant_id,id,market_id,node_id,workspace_id,owner_id,stable_key,display_name,commercial_code)
           VALUES($1,$2,$3,$4,$5,$6,'f2-uuid-collision','Synthetic EC alias','EC-ALIAS')`,
          [a.tenant, co.id, ec.id, product.id, a.workspace, a.users.owner],
        ),
      );
      assert.equal(await countEvidence('market'), 0);
      const insertCollidingEvidence = (subjectType: 'market' | 'market_product') =>
        runtime.request(owner, call(), (client) =>
          client.query(
            `INSERT INTO rpt.source_observation
           (tenant_id,id,source_system,domain_key,commerce_subject_type,subject_id,
            external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,
            sync_run_id,reconciliation_state,actor_id,facts)
           VALUES($1,$2,'RPT_USER','market_catalog',$3,$4,
            $5,'synthetic://collision',now(),now(),'manual',$6,$7,'matched',$8,$9)`,
            [
              a.tenant,
              randomUUID(),
              subjectType,
              co.id,
              randomUUID(),
              '0'.repeat(64),
              randomUUID(),
              a.users.owner,
              JSON.stringify({
                sourceLiteral: 'Synthetic EC alias',
                evidenceLevel: 'exact_primary',
              }),
            ],
          ),
        );
      await assert.rejects(() => insertCollidingEvidence('market'));
      await insertCollidingEvidence('market_product');
      assert.equal(await countEvidence('market_product'), 1);
      assert.equal(await countEvidence('market'), 0);
      const linked = await root!.query<{ availability: number; price: number; fx: number }>(
        `SELECT
         (SELECT count(*)::int FROM rpt.market_availability a JOIN rpt.source_observation o
          ON (o.tenant_id,o.id)=(a.tenant_id,a.observation_id)
          WHERE a.tenant_id=$1 AND o.commerce_subject_type='market_product'
          AND o.subject_id=a.market_product_id) AS availability,
         (SELECT count(*)::int FROM rpt.price_list_entry e JOIN rpt.source_observation o
          ON (o.tenant_id,o.id)=(e.tenant_id,e.observation_id)
          WHERE e.tenant_id=$1 AND o.commerce_subject_type='price_list'
          AND o.subject_id=e.price_list_id) AS price,
         (SELECT count(*)::int FROM rpt.exchange_rate x JOIN rpt.source_observation o
          ON (o.tenant_id,o.id)=(x.tenant_id,x.observation_id)
          WHERE x.tenant_id=$1 AND o.commerce_subject_type='market'
          AND o.subject_id=x.market_id) AS fx`,
        [a.tenant],
      );
      assert.ok(linked.rows[0]!.availability >= 2);
      assert.ok(linked.rows[0]!.price >= 1);
      assert.ok(linked.rows[0]!.fx >= 2);
    });
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
