import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError } from '@rpt/contracts';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { seedTenant } from '../helpers/fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

const at = (value: string) => `${value}T00:00:00.000Z`;
const evidence = (literal: string, observedAt = at('2026-01-01')) => ({
  sourceSystem: 'RPT_USER',
  sourceReference: 'synthetic-catalog',
  externalId: randomUUID(),
  observedAt,
  authorityLevel: 'manual',
  evidenceLevel: 'exact_primary',
  sourceLiteral: literal,
});

void test('E3A2 market catalog, temporal pricing and authorization on clean PostgreSQL', async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    const a = await seedTenant(root, 'catalog-a');
    const b = await seedTenant(root, 'catalog-b');
    for (const f of [a, b]) {
      for (const objectType of ['product', 'catalog', 'pricing']) {
        for (const verb of ['read', 'create', 'update']) {
          await root.query(
            "INSERT INTO authz.role_capability VALUES($1,'owner',$2,$3,'CONFIDENTIAL',false,1)",
            [f.tenant, objectType, verb],
          );
          await root.query(
            `INSERT INTO authz.workspace_permission
            (tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
            VALUES($1,$2,$3,$4,$5,$6,'CONFIDENTIAL',1)`,
            [f.tenant, randomUUID(), f.workspace, f.users.owner, objectType, verb],
          );
        }
      }
      for (const domain of ['product_master', 'market_catalog', 'pricing'])
        await root.query(
          `INSERT INTO authz.source_authority
          (tenant_id,user_id,source_system,domain_key,authority_level)
          VALUES($1,$2,'RPT_USER',$3,'manual')`,
          [f.tenant, f.users.owner, domain],
        );
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,'owner','pricing','manage','CONFIDENTIAL',false,1)",
        [f.tenant],
      );
      for (const verb of ['read', 'manage', 'global'])
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','market_admin',$2,'CONFIDENTIAL',false,1)",
          [f.tenant, verb],
        );
    }
    const runtime = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(runtime);
    const owner = a.identities.owner;
    const call = () => randomUUID();
    const product = await service.createProduct(
      owner,
      call(),
      {
        schemaVersion: 1,
        workspaceId: a.workspace,
        stableKey: 'global-one',
        name: 'Synthetic global product',
        lifecycle: 'active',
      },
      'product-global-one',
    );
    let ec!: { id: string; version: number };
    let mx!: { id: string; version: number };
    await t.test(
      'market identities and per-market availability are distinct from Product',
      async () => {
        ec = await service.createCatalogMarket(
          owner,
          call(),
          {
            schemaVersion: 1,
            countryCode: 'EC',
            currency: 'USD',
            timezone: 'America/Guayaquil',
            locale: 'es-EC',
          },
          'market-ec-one',
        );
        mx = await service.createCatalogMarket(
          owner,
          call(),
          {
            schemaVersion: 1,
            countryCode: 'MX',
            currency: 'MXN',
            timezone: 'America/Mexico_City',
            locale: 'es-MX',
          },
          'market-mx-one',
        );
        assert.equal(ec.id, a.market);
        assert.notEqual(ec.id, mx.id);
        assert.equal((await service.listCatalogMarkets(owner, call())).length, 2);
        await service.grantAdminMarketScope(
          owner,
          call(),
          { schemaVersion: 1, userId: a.users.owner, marketId: ec.id },
          'scope-owner-ec',
        );
        await service.grantAdminMarketScope(
          owner,
          call(),
          { schemaVersion: 1, userId: a.users.owner, marketId: mx.id },
          'scope-owner-mx',
        );
        await service.setCatalogMarketStatus(
          owner,
          call(),
          ec.id,
          { schemaVersion: 1, expectedVersion: 1, status: 'active' },
          'activate-market-ec',
        );
        await service.setCatalogMarketStatus(
          owner,
          call(),
          mx.id,
          { schemaVersion: 1, expectedVersion: 1, status: 'active' },
          'activate-market-mx',
        );
      },
    );
    const ecProductInput = {
      schemaVersion: 1,
      marketId: ec.id,
      nodeId: product.id,
      stableKey: 'market-global-ec',
      displayName: 'Synthetic EC label',
      commercialCode: 'EC-SYN',
      availability: 'available',
      effectiveAt: at('2026-01-01'),
      evidence: evidence('Published in EC'),
    };
    const ecProduct = await service.createMarketProduct(
      owner,
      call(),
      ecProductInput,
      'market-product-ec',
    );
    const repeated = await service.createMarketProduct(
      owner,
      call(),
      ecProductInput,
      'market-product-ec',
    );
    assert.equal(repeated.id, ecProduct.id);
    const mxProduct = await service.createMarketProduct(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: mx.id,
        nodeId: product.id,
        stableKey: 'market-global-mx',
        displayName: 'Synthetic MX label',
        commercialCode: 'MX-SYN',
        availability: 'available',
        effectiveAt: at('2026-01-01'),
        evidence: evidence('Published in MX'),
      },
      'market-product-mx',
    );
    assert.notEqual(ecProduct.id, mxProduct.id);
    await t.test(
      'availability is historical and Product lifecycle remains independent',
      async () => {
        await service.changeMarketAvailability(
          owner,
          call(),
          ecProduct.id,
          {
            schemaVersion: 1,
            expectedVersion: 1,
            status: 'discontinued',
            effectiveAt: at('2026-09-01'),
            evidence: evidence('Discontinued EC', at('2026-09-01')),
          },
          'availability-ec-discontinued',
        );
        const before = await service.listMarketCatalog(owner, call(), {
          marketId: ec.id,
          asOf: at('2026-05-31'),
        });
        const after = await service.listMarketCatalog(owner, call(), {
          marketId: ec.id,
          asOf: at('2026-09-02'),
        });
        const mexico = await service.listMarketCatalog(owner, call(), {
          marketId: mx.id,
          asOf: at('2026-09-02'),
        });
        assert.equal(before[0].availability, 'available');
        assert.equal(after[0].availability, 'discontinued');
        assert.equal(mexico[0].availability, 'available');
        assert.equal(
          (await service.detailProduct(owner, call(), product.id))?.nodes.find(
            (n: { id: string }) => n.id === product.id,
          )?.lifecycle,
          'active',
        );
      },
    );
    const list = await service.createPriceList(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: ec.id,
        workspaceId: a.workspace,
        stableKey: 'retail-2026',
        name: 'Synthetic retail',
        currency: 'USD',
        status: 'draft',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('Retail 2026'),
      },
      'price-list-ec-one',
    );
    const mxList = await service.createPriceList(
      owner,
      call(),
      {
        schemaVersion: 1,
        marketId: mx.id,
        workspaceId: a.workspace,
        stableKey: 'retail-2026',
        name: 'Synthetic retail MX',
        currency: 'MXN',
        status: 'draft',
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('Retail MX 2026'),
      },
      'price-list-mx-one',
    );
    await service.activatePriceList(
      owner,
      call(),
      list.id,
      { schemaVersion: 1, expectedVersion: 1 },
      'activate-list-ec',
    );
    await service.activatePriceList(
      owner,
      call(),
      mxList.id,
      { schemaVersion: 1, expectedVersion: 1 },
      'activate-list-mx',
    );
    await service.addPriceEntry(
      owner,
      call(),
      mxList.id,
      {
        schemaVersion: 1,
        expectedVersion: 2,
        marketProductId: mxProduct.id,
        currency: 'MXN',
        amount: '200.00',
        taxTreatment: 'tax_unknown',
        taxRate: null,
        validFrom: at('2026-01-01'),
        validTo: null,
        evidence: evidence('MXN 200'),
      },
      'entry-one-mx',
    );
    assert.equal(
      (
        await service.currentCatalogPrice(owner, call(), {
          priceListId: mxList.id,
          marketProductId: mxProduct.id,
          asOf: at('2026-06-01'),
        })
      )?.amount,
      '200.0000',
    );
    await t.test(
      'exact price, tax semantics, half-open intervals and immutable history',
      async () => {
        const firstInput = {
          schemaVersion: 1,
          expectedVersion: 2,
          marketProductId: ecProduct.id,
          currency: 'USD',
          amount: '100.00',
          taxTreatment: 'tax_not_applicable',
          taxRate: '0',
          validFrom: at('2026-01-01'),
          validTo: at('2026-06-01'),
          evidence: evidence('$100 tax 0'),
        };
        const first = await service.addPriceEntry(
          owner,
          call(),
          list.id,
          firstInput,
          'entry-one-ec',
        );
        const retry = await service.addPriceEntry(
          owner,
          call(),
          list.id,
          firstInput,
          'entry-one-ec',
        );
        assert.deepEqual(retry, first);
        const second = await service.addPriceEntry(
          owner,
          call(),
          list.id,
          {
            schemaVersion: 1,
            expectedVersion: 3,
            marketProductId: ecProduct.id,
            currency: 'USD',
            amount: '115.00',
            taxTreatment: 'tax_inclusive',
            taxRate: null,
            validFrom: at('2026-06-01'),
            validTo: null,
            evidence: evidence('$115 tax included', at('2026-06-01')),
          },
          'entry-two-ec',
        );
        assert.notEqual(first.id, second.id);
        const query = (date: string) =>
          service.currentCatalogPrice(owner, call(), {
            priceListId: list.id,
            marketProductId: ecProduct.id,
            asOf: at(date),
          });
        const may = await query('2026-05-31');
        const june = await query('2026-06-01');
        assert.equal(may?.amount, '100.0000');
        assert.equal(may?.taxTreatment, 'tax_not_applicable');
        assert.equal(june?.amount, '115.0000');
        assert.equal(june?.taxRate, null);
        assert.equal(
          (
            await service.catalogPriceHistory(owner, call(), {
              priceListId: list.id,
              marketProductId: ecProduct.id,
            })
          ).length,
          2,
        );
        await assert.rejects(
          () =>
            service.addPriceEntry(
              owner,
              call(),
              list.id,
              {
                ...firstInput,
                expectedVersion: 4,
                validFrom: at('2026-05-01'),
                validTo: at('2026-07-01'),
                evidence: evidence('Ambiguous overlap'),
              },
              'entry-overlap-ec',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        await assert.rejects(
          () =>
            service.addPriceEntry(
              owner,
              call(),
              list.id,
              {
                ...firstInput,
                expectedVersion: 1,
                validFrom: at('2026-10-01'),
                validTo: null,
                evidence: evidence('Stale version'),
              },
              'entry-stale-ec',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        await assert.rejects(
          () =>
            service.addPriceEntry(
              owner,
              call(),
              list.id,
              {
                ...firstInput,
                expectedVersion: 4,
                currency: 'MXN',
                validFrom: at('2026-10-01'),
                validTo: null,
                evidence: evidence('Wrong currency'),
              },
              'entry-currency-ec',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await assert.rejects(
          () =>
            service.addPriceEntry(
              owner,
              call(),
              list.id,
              {
                ...firstInput,
                expectedVersion: 4,
                marketProductId: mxProduct.id,
                validFrom: at('2027-01-01'),
                validTo: null,
                evidence: evidence('Wrong market'),
              },
              'entry-market-mismatch',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'NOT_FOUND',
        );
        await service.addPriceEntry(
          owner,
          call(),
          list.id,
          {
            schemaVersion: 1,
            expectedVersion: 4,
            marketProductId: ecProduct.id,
            currency: 'USD',
            amount: '120.00',
            taxTreatment: 'tax_unknown',
            taxRate: null,
            supersedesEntryId: second.id,
            validFrom: at('2027-01-01'),
            validTo: null,
            evidence: evidence('$120 tax not stated', at('2027-01-01')),
          },
          'entry-three-ec',
        );
        assert.equal((await query('2026-12-31'))?.amount, '115.0000');
        assert.equal((await query('2027-01-01'))?.amount, '120.0000');
        assert.equal(
          (
            await service.catalogPriceHistory(owner, call(), {
              priceListId: list.id,
              marketProductId: ecProduct.id,
            })
          ).length,
          3,
        );
        const closeInput = { schemaVersion: 1, expectedVersion: 5, validTo: at('2028-01-01') };
        const closed = await service.closePriceList(
          owner,
          call(),
          list.id,
          closeInput,
          'close-list-ec',
        );
        assert.equal(
          (await service.closePriceList(owner, call(), list.id, closeInput, 'close-list-ec'))
            .version,
          closed.version,
        );
        assert.equal((await query('2027-12-31'))?.amount, '120.0000');
        assert.equal(await query('2028-01-01'), null);
      },
    );
    await t.test('pricing boundary, BOLA, tenancy and revocation', async () => {
      const countEvidence = (identity: typeof owner, domain: string) =>
        runtime.request(
          identity,
          call(),
          async (client) =>
            (
              await client.query<{ n: number }>(
                `SELECT count(*)::integer AS n FROM rpt.source_observation
          WHERE domain_key=$1`,
                [domain],
              )
            ).rows[0]!.n,
        );
      assert.ok((await countEvidence(owner, 'market_catalog')) >= 2);
      assert.ok((await countEvidence(owner, 'pricing')) >= 3);
      assert.equal(await countEvidence(a.identities.ai, 'market_catalog'), 0);
      assert.equal(await countEvidence(a.identities.ai, 'pricing'), 0);
      assert.equal(await countEvidence(b.identities.owner, 'market_catalog'), 0);
      assert.equal(await countEvidence(b.identities.owner, 'pricing'), 0);
      await assert.rejects(
        () =>
          service.currentCatalogPrice(a.identities.ancestor, call(), {
            priceListId: list.id,
            marketProductId: ecProduct.id,
            asOf: at('2026-06-02'),
          }),
        (e: unknown) => e instanceof FoundationError && e.code === 'FORBIDDEN',
      );
      await assert.rejects(
        () =>
          service.currentCatalogPrice(b.identities.owner, call(), {
            priceListId: list.id,
            marketProductId: ecProduct.id,
            asOf: at('2026-06-02'),
          }),
        (e: unknown) => e instanceof FoundationError && e.code === 'NOT_FOUND',
      );
      await root!.query(
        "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='owner' AND object_type='pricing' AND verb='read'",
        [a.tenant],
      );
      assert.equal((await service.detailProduct(owner, call(), product.id)).nodes.length, 1);
      await assert.rejects(
        () =>
          service.currentCatalogPrice(owner, call(), {
            priceListId: list.id,
            marketProductId: ecProduct.id,
            asOf: at('2026-06-02'),
          }),
        (e: unknown) => e instanceof FoundationError && e.code === 'FORBIDDEN',
      );
    });
    const audit = await root.query(
      `SELECT count(*)::integer AS n FROM rpt.audit_event
      WHERE tenant_id=$1 AND object_type IN ('market_product','market_availability','price_list','price_list_entry')`,
      [a.tenant],
    );
    assert.ok(audit.rows[0].n >= 5);
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
