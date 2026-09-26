import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationService, CommercialCalculatorService } from '@rpt/application';
import { FoundationError } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
import { seedTenant } from '../helpers/fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

const at = (s: string) => `${s}T00:00:00.000Z`;
const evidence = (sourceLiteral: string) => ({
  sourceSystem: 'RPT_USER',
  sourceReference: 'fixture://commercial',
  externalId: randomUUID(),
  observedAt: at('2026-01-01'),
  authorityLevel: 'manual',
  evidenceLevel: 'exact_primary',
  sourceLiteral,
});
const denied =
  (...codes: string[]) =>
  (e: unknown) =>
    e instanceof FoundationError && codes.includes(e.code);
void test('E3B1 commercial configuration, exact calculation and runtime RLS on clean PostgreSQL', async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    const a = await seedTenant(root, 'commercial-a'),
      b = await seedTenant(root, 'commercial-b');
    const grant = async (role: string, type: string, verb: string, user?: string, fixture = a) => {
      await root!.query(
        "INSERT INTO authz.role_capability VALUES($1,$2,$3,$4,'CONFIDENTIAL',false,1)",
        [fixture.tenant, role, type, verb],
      );
      if (user)
        await root!.query(
          `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
      VALUES($1,$2,$3,$4,$5,$6,'CONFIDENTIAL',1)`,
          [fixture.tenant, randomUUID(), fixture.workspace, user, type, verb],
        );
    };
    for (const type of ['product', 'catalog', 'pricing'])
      for (const verb of ['read', 'create', 'update'])
        await grant('owner', type, verb, a.users.owner);
    await grant('owner', 'pricing', 'manage');
    for (const verb of ['read', 'manage', 'global']) await grant('owner', 'market_admin', verb);
    for (const verb of ['calculate', 'configure']) await grant('owner', 'commercial', verb);
    // Equivalent permissions in tenant B: denials must prove tenancy, not missing capability.
    for (const type of ['product', 'catalog', 'pricing'])
      for (const verb of ['read', 'create', 'update'])
        await grant('owner', type, verb, b.users.owner, b);
    await grant('owner', 'pricing', 'manage', undefined, b);
    for (const verb of ['read', 'manage', 'global'])
      await grant('owner', 'market_admin', verb, undefined, b);
    for (const verb of ['calculate', 'configure'])
      await grant('owner', 'commercial', verb, undefined, b);
    for (const [role, user] of [
      ['delegate', a.users.delegate],
      ['ancestor', a.users.ancestor],
      ['ai', a.users.ai],
    ] as const) {
      for (const type of ['product', 'catalog', 'pricing']) await grant(role, type, 'read', user);
      await grant(role, 'commercial', 'calculate');
    }
    for (const role of ['ancestor', 'ai'] as const) {
      await grant(role, 'pricing', 'update', a.users[role]);
      for (const verb of ['read', 'manage']) await grant(role, 'market_admin', verb);
      await grant(role, 'commercial', 'configure');
    }
    for (const domain of [
      'product_master',
      'market_catalog',
      'pricing',
      'commercial_configuration',
      'fx',
    ])
      await root.query(
        "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_USER',$3,'manual')",
        [a.tenant, a.users.owner, domain],
      );
    const db = new PostgresDatabase(cluster.runtimeConfig()),
      foundation = new FoundationService(db),
      service = new CommercialCalculatorService(db);
    const owner = a.identities.owner,
      request = () => randomUUID();
    const product = await foundation.createProduct(
      owner,
      request(),
      {
        schemaVersion: 1,
        workspaceId: a.workspace,
        stableKey: 'synthetic-commercial',
        name: 'Synthetic shared global product',
        lifecycle: 'active',
      },
      'commercial-product',
    );
    const createMarket = async (
      countryCode: string,
      currency: string,
      timezone: string,
      locale: string,
    ) => {
      const m = await foundation.createCatalogMarket(
        owner,
        request(),
        { schemaVersion: 1, countryCode, currency, timezone, locale },
        `commercial-market-${countryCode}`,
      );
      await foundation.grantAdminMarketScope(
        owner,
        request(),
        { schemaVersion: 1, userId: a.users.owner, marketId: m.id },
        `commercial-scope-${countryCode}`,
      );
      await foundation.setCatalogMarketStatus(
        owner,
        request(),
        m.id,
        { schemaVersion: 1, expectedVersion: 1, status: 'active' },
        `commercial-active-${countryCode}`,
      );
      return m.id;
    };
    const ec = await createMarket('EC', 'USD', 'America/Guayaquil', 'es-EC'),
      mx = await createMarket('MX', 'MXN', 'America/Mexico_City', 'es-MX');
    await foundation.registerCatalogCurrency(
      owner,
      request(),
      { schemaVersion: 1, code: 'CLP', name: 'Synthetic Chilean peso', minorUnits: 0 },
      'commercial-clp-register',
    );
    await foundation.setCatalogCurrencyStatus(
      owner,
      request(),
      'CLP',
      { schemaVersion: 1, expectedVersion: 1, status: 'active' },
      'commercial-clp-activate',
    );
    const cl = await createMarket('CL', 'CLP', 'America/Santiago', 'es-CL');
    const addMP = async (marketId: string, key: string) =>
      foundation.createMarketProduct(
        owner,
        request(),
        {
          schemaVersion: 1,
          marketId,
          nodeId: product.id,
          stableKey: key,
          displayName: `Synthetic ${key}`,
          commercialCode: key,
          availability: 'available',
          effectiveAt: at('2026-01-01'),
          evidence: evidence(key),
        },
        `commercial-mp-${key}`,
      );
    const first = await addMP(ec, 'first'),
      second = await addMP(ec, 'second'),
      anchor = await addMP(ec, 'anchor'),
      foreign = await addMP(mx, 'foreign'),
      zero = await addMP(cl, 'zero');
    const addList = async (
      marketId: string,
      currency: string,
      key: string,
      entries: Array<
        [
          string,
          string,
          ('tax_inclusive' | 'tax_exclusive' | 'tax_not_applicable' | 'tax_unknown')?,
          (string | null)?,
        ]
      >,
    ) => {
      const p = await foundation.createPriceList(
        owner,
        request(),
        {
          schemaVersion: 1,
          marketId,
          workspaceId: a.workspace,
          stableKey: key,
          name: `Synthetic ${key}`,
          currency,
          status: 'draft',
          validFrom: at('2026-01-01'),
          validTo: null,
          evidence: evidence(key),
        },
        `commercial-list-${key}`,
      );
      let version = 1;
      for (const [mp, amount, taxTreatment = 'tax_not_applicable', taxRate = null] of entries) {
        const r = await foundation.addPriceEntry(
          owner,
          request(),
          p.id,
          {
            schemaVersion: 1,
            expectedVersion: version,
            marketProductId: mp,
            currency,
            amount,
            taxTreatment,
            taxRate,
            validFrom: at('2026-01-01'),
            validTo: null,
            evidence: evidence(amount),
          },
          `commercial-entry-${key}-${mp}`,
        );
        version = r.version;
      }
      await foundation.activatePriceList(
        owner,
        request(),
        p.id,
        { schemaVersion: 1, expectedVersion: version },
        `commercial-publish-${key}`,
      );
      return p.id;
    };
    const ecList = await addList(ec, 'USD', 'ec-list', [
      [first.id, '100'],
      [second.id, '50'],
      [anchor.id, '125'],
    ]);
    const mxList = await addList(mx, 'MXN', 'mx-list', [[foreign.id, '200']]),
      clList = await addList(cl, 'CLP', 'cl-list', [[zero.id, '100']]);
    await foundation.assignOperationalMarket(
      owner,
      request(),
      {
        schemaVersion: 1,
        userId: a.users.delegate,
        marketId: ec,
        expectedVersion: 0,
        reason: 'Synthetic operational assignment',
      },
      'commercial-assign-delegate',
    );
    for (const [user, markets] of [
      [a.users.ancestor, [ec]],
      [a.users.ai, [ec, mx]],
    ] as const)
      for (const marketId of markets)
        await foundation.grantAdminMarketScope(
          owner,
          request(),
          { schemaVersion: 1, userId: user, marketId },
          `commercial-scope-${user}-${marketId}`,
        );
    const common = {
      schemaVersion: 1,
      marketId: ec,
      priceListId: ecList,
      name: 'Synthetic configuration',
      expectedVersion: 0,
      validFrom: at('2026-01-01'),
      validTo: null,
    };
    const create = async (input: unknown, key: string) =>
      service.createConfigurationVersion(owner, request(), input, key);
    const activate = async (v: { versionId: string }) =>
      service.transitionConfigurationVersion(
        owner,
        request(),
        v.versionId,
        { schemaVersion: 1, expectedVersion: 1, action: 'activate', effectiveAt: at('2026-01-01') },
        `activate-${v.versionId}`,
      );
    const bundleInput = {
      ...common,
      kind: 'bundle',
      stableKey: 'component-bundle',
      pricingMode: 'COMPONENT_SUM',
      lines: [
        { marketProductId: first.id, quantity: '1' },
        { marketProductId: second.id, quantity: '2' },
      ],
    };
    const bundle = await create(bundleInput, 'commercial-bundle');
    await activate(bundle);
    const published = await create(
      {
        ...common,
        kind: 'bundle',
        stableKey: 'anchor-bundle',
        pricingMode: 'PUBLISHED_ANCHOR',
        anchorMarketProductId: anchor.id,
        lines: [
          { marketProductId: first.id, quantity: '1' },
          { marketProductId: second.id, quantity: '2' },
        ],
      },
      'commercial-anchor',
    );
    await activate(published);
    const rules = await create(
      {
        ...common,
        kind: 'rules',
        stableKey: 'rule-set',
        rules: [
          { kind: 'percentage_discount', value: '0.1', autoLimit: '0.05', priority: 1 },
          { kind: 'fixed_surcharge', value: '5', priority: 2 },
        ],
      },
      'commercial-rules',
    );
    await activate(rules);
    const card = await create(
      {
        ...common,
        kind: 'financing',
        stableKey: 'card-plan',
        mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
        terms: [{ months: 3, value: '0.1' }],
      },
      'commercial-card',
    );
    await activate(card);
    const direct = await create(
      {
        ...common,
        kind: 'financing',
        stableKey: 'direct-plan',
        mode: 'DOWN_PAYMENT_INSTALLMENT_FACTOR',
        downPaymentRate: '0.2',
        allowAdditionalBalance: true,
        terms: [{ months: 5, value: '0.25' }],
      },
      'commercial-direct',
    );
    await activate(direct);
    const mxBundle = await create(
      {
        ...common,
        marketId: mx,
        priceListId: mxList,
        kind: 'bundle',
        stableKey: 'foreign-bundle',
        pricingMode: 'COMPONENT_SUM',
        lines: [{ marketProductId: foreign.id, quantity: '1' }],
      },
      'commercial-foreign-bundle',
    );
    await activate(mxBundle);
    const mxPlan = await create(
      {
        ...common,
        marketId: mx,
        priceListId: mxList,
        kind: 'financing',
        stableKey: 'foreign-plan',
        mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
        terms: [{ months: 6, value: '0.2' }],
      },
      'commercial-foreign-plan',
    );
    await activate(mxPlan);
    const mxTerm = (await service.configurationHistory(owner, request(), mxPlan.id))[0]!.terms[0]!;
    const calculate = (extra: Record<string, unknown> = {}, identity = owner) =>
      service.calculateCommercialOffer(identity, request(), {
        schemaVersion: 1,
        asOf: at('2026-05-31'),
        priceListId: ecList,
        lines: [{ kind: 'product', marketProductId: first.id, quantity: '1' }],
        ...extra,
      });
    await t.test(
      'component sum and published anchor consume official prices without inventing prices',
      async () => {
        const sum = await calculate({
          lines: [{ kind: 'bundle', bundleId: bundle.id, quantity: '2' }],
        });
        assert.equal(sum.totals.grandTotal, '400.00');
        assert.equal(sum.lines.length, 2);
        assert.ok(sum.lines.every((l) => l.entryId && l.bundleVersion === 1));
        const anchorResult = await calculate({
          lines: [{ kind: 'bundle', bundleId: published.id, quantity: '1' }],
        });
        assert.equal(anchorResult.totals.grandTotal, '125.00');
        assert.equal(anchorResult.lines.length, 1);
        assert.equal(anchorResult.lines[0]!.marketProductId, anchor.id);
        const adjusted = await calculate({ ruleSetId: rules.id });
        assert.equal(adjusted.totals.grandTotal, '95.00');
        assert.equal(adjusted.requiresApproval, true);
        const cardHistory = await service.configurationHistory(owner, request(), card.id),
          cardTerm = cardHistory[0]!.terms[0]!;
        const financed = await calculate({ financing: { planId: card.id, termId: cardTerm.id } });
        assert.equal(financed.financing!.scheduledTotal, '110.00');
        const directTerm = (await service.configurationHistory(owner, request(), direct.id))[0]!
          .terms[0]!;
        const factored = await calculate({
          financing: { planId: direct.id, termId: directTerm.id, additionalBalance: '10' },
        });
        assert.equal(factored.financing!.installment, '22.50');
        const zeroResult = await calculate({
          priceListId: clList,
          lines: [{ kind: 'product', marketProductId: zero.id, quantity: '0.5' }],
        });
        assert.equal(zeroResult.currency, 'CLP');
        assert.equal(zeroResult.totals.grandTotal, '50');
      },
    );
    await t.test(
      'automatic limits persist independently, retries are safe and invalid SQL limits fail',
      async () => {
        const input = {
          ...common,
          kind: 'rules',
          stableKey: 'independent-limits',
          rules: [
            { kind: 'percentage_discount', value: '0.1', autoLimit: '0.2', priority: 1 },
            { kind: 'fixed_discount', value: '5', autoLimit: '10', priority: 2 },
            { kind: 'fixed_surcharge', value: '1', priority: 3 },
          ],
        };
        const configured = await create(input, 'commercial-independent-limits');
        assert.deepEqual(await create(input, 'commercial-independent-limits'), configured);
        await assert.rejects(
          () => create(input, 'commercial-independent-stale'),
          denied('CONFLICT'),
        );
        const history = await service.configurationHistory(owner, request(), configured.id);
        assert.equal(history.length, 1);
        assert.equal(history[0]!.rules.length, 3);
        assert.equal(history[0]!.rules[0]!.value, '0.1000000000');
        assert.equal(history[0]!.rules[0]!.autoLimit, '0.2000000000');
        for (const limit of ['-0.1', '1.01'])
          await assert.rejects(() =>
            create(
              {
                ...input,
                stableKey: 'invalid-limit',
                rules: [{ ...input.rules[0], autoLimit: limit }],
              },
              `commercial-bad-limit-${limit}`,
            ),
          );
        await db.request(owner, request(), async (client) => {
          assert.equal(
            (
              await client.query('SELECT currency FROM rpt.commercial_configuration WHERE id=$1', [
                configured.id,
              ])
            ).rows[0]?.currency,
            'USD',
          );
          for (const [index, limit] of ['-0.1', '1.01'].entries()) {
            await client.query('SAVEPOINT limit_probe');
            await assert.rejects(
              () =>
                client.query(
                  `INSERT INTO rpt.commercial_rule(tenant_id,id,version_id,market_id,kind,value,auto_limit,priority)
             VALUES($1,$2,$3,$4,'percentage_discount',0.1,$5,$6)`,
                  [a.tenant, randomUUID(), configured.versionId, ec, limit, 10 + index],
                ),
              (error: unknown) => {
                const pg = error as { code?: string; table?: string; constraint?: string };
                return pg.code === '23514' && pg.table === 'commercial_rule' && !!pg.constraint;
              },
            );
            await client.query('ROLLBACK TO SAVEPOINT limit_probe');
          }
          assert.equal(
            (
              await client.query('SELECT * FROM rpt.commercial_rule WHERE version_id=$1', [
                configured.versionId,
              ])
            ).rowCount,
            3,
          );
        });
        await activate(configured);
        const result = await calculate({ ruleSetId: configured.id });
        assert.equal(result.status, 'final');
        assert.equal(result.requiresApproval, false);
        assert.equal(result.totals.discountTotal, '15.00');
        assert.equal(result.totals.grandTotal, '86.00');
        assert.deepEqual(
          result.appliedRules.map((r) => r.id),
          history[0]!.rules.map((r) => r.id),
        );
        const selected = await calculate({
          ruleSetId: configured.id,
          requestedDiscountRuleId: history[0]!.rules[0]!.id,
        });
        assert.equal(selected.totals.grandTotal, '91.00');
        assert.deepEqual(
          selected.appliedRules.map((r) => r.id),
          [history[0]!.rules[0]!.id, history[0]!.rules[2]!.id],
        );
        assert.ok(!selected.appliedRules.some((r) => r.id === history[0]!.rules[1]!.id));
        const exceeded = await calculate({ ruleSetId: rules.id });
        assert.equal(exceeded.status, 'requires_approval');
        assert.equal(exceeded.requiresApproval, true);
        assert.equal(exceeded.appliedRules[0]!.autoLimit, '0.05');
      },
    );
    await t.test(
      'rule-set versions cannot overlap at publication, including direct SQL',
      async () => {
        const overlapping = await create(
          {
            ...common,
            kind: 'rules',
            stableKey: 'rule-set',
            expectedVersion: 1,
            rules: [{ kind: 'fixed_surcharge', value: '2', priority: 1 }],
          },
          'commercial-rule-overlap',
        );
        await assert.rejects(() => activate(overlapping), denied('CONFLICT'));
        await db.request(owner, request(), async (client) => {
          await client.query('SAVEPOINT overlap_probe');
          await assert.rejects(
            () =>
              client.query(
                "UPDATE rpt.commercial_configuration_version SET status='active',revision=revision+1 WHERE id=$1",
                [overlapping.versionId],
              ),
            (error: unknown) => (error as { code?: string }).code === '23P01',
          );
          await client.query('ROLLBACK TO SAVEPOINT overlap_probe');
          assert.equal(
            (
              await client.query(
                'SELECT status FROM rpt.commercial_configuration_version WHERE id=$1',
                [overlapping.versionId],
              )
            ).rows[0]?.status,
            'draft',
          );
        });
        assert.equal((await calculate({ ruleSetId: rules.id })).totals.grandTotal, '95.00');
      },
    );
    await t.test(
      'mixed-tax component adjustments recalculate each basis; incomplete tax skips traces',
      async () => {
        const list = await addList(ec, 'USD', 'mixed-tax', [
          [first.id, '115', 'tax_inclusive', '0.15'],
          [second.id, '50', 'tax_exclusive', '0.1'],
        ]);
        const mixedBundle = await create(
          {
            ...bundleInput,
            priceListId: list,
            stableKey: 'mixed-bundle',
            lines: [
              { marketProductId: first.id, quantity: '1' },
              { marketProductId: second.id, quantity: '1' },
            ],
          },
          'commercial-mixed-bundle',
        );
        const mixedRules = await create(
          {
            ...common,
            priceListId: list,
            kind: 'rules',
            stableKey: 'mixed-discount',
            rules: [{ kind: 'percentage_discount', value: '0.1', autoLimit: '0.2', priority: 1 }],
          },
          'commercial-mixed-rules',
        );
        await activate(mixedBundle);
        await activate(mixedRules);
        const result = await calculate({
          priceListId: list,
          lines: [{ kind: 'bundle', bundleId: mixedBundle.id, quantity: '1' }],
          ruleSetId: mixedRules.id,
        });
        assert.equal(result.status, 'final');
        assert.equal(result.totals.subtotal, '150.00');
        assert.equal(result.totals.taxTotal, '18.00');
        assert.equal(result.totals.grandTotal, '153.00');
        const inclusive = result.lines.find((l) => l.marketProductId === first.id)!,
          exclusive = result.lines.find((l) => l.marketProductId === second.id)!;
        assert.deepEqual(
          [inclusive.net, inclusive.tax, inclusive.gross],
          ['90.00', '13.50', '103.50'],
        );
        assert.deepEqual(
          [exclusive.net, exclusive.tax, exclusive.gross],
          ['45.00', '4.50', '49.50'],
        );
        assert.equal(result.appliedRules.length, 1);
        assert.ok(
          result.lines.every(
            (l) => l.appliedAdjustments[0]?.id === result.appliedRules[0]?.id && !!l.entryId,
          ),
        );
        const unknownList = await addList(ec, 'USD', 'unknown-tax', [
          [first.id, '100', 'tax_unknown'],
        ]);
        const skippedRules = await create(
          {
            ...common,
            priceListId: unknownList,
            kind: 'rules',
            stableKey: 'skipped-discount',
            rules: [{ kind: 'percentage_discount', value: '0.1', autoLimit: '0.05', priority: 1 }],
          },
          'commercial-skipped-rules',
        );
        await activate(skippedRules);
        const incomplete = await calculate({
          priceListId: unknownList,
          ruleSetId: skippedRules.id,
        });
        assert.equal(incomplete.status, 'incomplete_tax_semantics');
        assert.equal(incomplete.requiresApproval, false);
        assert.equal(incomplete.totals.grandTotal, null);
        assert.equal(incomplete.totals.discountTotal, '0.00');
        assert.deepEqual(incomplete.appliedRules, []);
        assert.ok(incomplete.lines.every((l) => l.appliedAdjustments.length === 0));
      },
    );
    await t.test('populated FX reference cannot replace either market official price', async () => {
      const rate = await foundation.recordExchangeRate(
        owner,
        request(),
        {
          schemaVersion: 1,
          marketId: ec,
          baseCurrency: 'USD',
          quoteCurrency: 'MXN',
          rate: '20.125',
          validFrom: at('2026-01-01'),
          validTo: null,
          evidence: evidence('Synthetic USD/MXN 20.125'),
        },
        'commercial-reference-fx',
      );
      assert.ok(rate.id);
      const before = (
        await root!.query(
          'SELECT count(*)::int AS n FROM rpt.price_list_entry WHERE tenant_id=$1',
          [a.tenant],
        )
      ).rows[0].n;
      const reference = await foundation.referenceConversion(owner, request(), {
        marketId: ec,
        baseCurrency: 'USD',
        quoteCurrency: 'MXN',
        amount: '100.00',
        asOf: at('2026-05-31'),
      });
      assert.equal(reference?.kind, 'DERIVED_REFERENCE');
      assert.equal(reference?.officialMarketPrice, false);
      assert.equal(reference?.derivedAmount, '2012.50');
      const official = await calculate();
      assert.equal(official.lines[0]!.unitPrice, '100.00');
      assert.equal(official.totals.grandTotal, '100.00');
      const foreignOfficial = await calculate({
        priceListId: mxList,
        lines: [{ kind: 'product', marketProductId: foreign.id, quantity: '1' }],
      });
      assert.equal(foreignOfficial.lines[0]!.unitPrice, '200.00');
      assert.notEqual(foreignOfficial.totals.grandTotal, reference?.derivedAmount);
      assert.throws(
        () => calculate({ unitPrice: reference!.derivedAmount, fxRate: '20.125' }),
        /Unrecognized keys/,
      );
      assert.equal(
        (
          await root!.query(
            'SELECT count(*)::int AS n FROM rpt.price_list_entry WHERE tenant_id=$1',
            [a.tenant],
          )
        ).rows[0].n,
        before,
      );
    });
    await t.test(
      'tenant B with equivalent effective commercial capabilities remains denied',
      async () => {
        await db.request(b.identities.owner, request(), async (client) => {
          for (const [type, verb] of [
            ['commercial', 'calculate'],
            ['commercial', 'configure'],
            ['pricing', 'read'],
            ['market_admin', 'global'],
          ])
            assert.equal(
              (
                await client.query(
                  "SELECT authz.capable(authz.actor_id(),$1,$2,'CONFIDENTIAL') AS allowed",
                  [type, verb],
                )
              ).rows[0]?.allowed,
              true,
            );
          for (const [table, id] of [
            ['commercial_configuration', bundle.id],
            ['commercial_configuration_version', card.versionId],
            ['price_list', ecList],
          ])
            assert.equal(
              (await client.query(`SELECT id FROM rpt.${table} WHERE id=$1`, [id])).rowCount,
              0,
            );
        });
        await assert.rejects(
          () => calculate({}, b.identities.owner),
          denied('NOT_FOUND', 'FORBIDDEN'),
        );
        await assert.rejects(
          () => service.configurationHistory(b.identities.owner, request(), bundle.id),
          denied('NOT_FOUND'),
        );
        await assert.rejects(
          () =>
            service.createConfigurationVersion(
              b.identities.owner,
              request(),
              { ...bundleInput, stableKey: 'cross-tenant' },
              'commercial-tenant-b-write',
            ),
          denied('FORBIDDEN', 'NOT_FOUND'),
        );
      },
    );
    await t.test(
      'idempotent configuration retry, stale concurrency, cross-market child and ambiguity rejected',
      async () => {
        assert.deepEqual(await create(bundleInput, 'commercial-bundle'), bundle);
        await assert.rejects(
          () => create({ ...bundleInput, expectedVersion: 0 }, 'commercial-stale'),
          denied('CONFLICT'),
        );
        await assert.rejects(
          () =>
            create(
              {
                ...bundleInput,
                stableKey: 'invalid-child',
                lines: [{ marketProductId: foreign.id, quantity: '1' }],
              },
              'commercial-bad-child',
            ),
          denied('INVALID_REQUEST', 'NOT_FOUND'),
        );
        const overlap = await create(
          { ...bundleInput, expectedVersion: 1 },
          'commercial-overlap-version',
        );
        await assert.rejects(() => activate(overlap), denied('CONFLICT'));
        await assert.rejects(() =>
          create(
            {
              ...common,
              kind: 'rules',
              stableKey: 'ambiguous-order',
              rules: [
                { kind: 'fixed_surcharge', value: '1', priority: 1 },
                { kind: 'fixed_discount', value: '1', priority: 1 },
              ],
            },
            'commercial-bad-order',
          ),
        );
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::int AS n FROM rpt.commercial_configuration_version WHERE configuration_id=$1',
              [bundle.id],
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      'same-tenant known UUID, market manipulation, plan/bundle and catalog-only defenses',
      async () => {
        const advisor = a.identities.delegate;
        assert.equal((await calculate({}, advisor)).totals.grandTotal, '100.00');
        for (const extra of [
          {
            priceListId: mxList,
            lines: [{ kind: 'product', marketProductId: foreign.id, quantity: '1' }],
          },
          { marketId: mx },
          { lines: [{ kind: 'product', marketProductId: foreign.id, quantity: '1' }] },
          { lines: [{ kind: 'bundle', bundleId: mxBundle.id, quantity: '1' }] },
          { financing: { planId: mxPlan.id, termId: mxTerm.id } },
        ])
          await assert.rejects(() => calculate(extra, advisor), denied('FORBIDDEN', 'NOT_FOUND'));
        await assert.rejects(
          () =>
            service.createConfigurationVersion(
              advisor,
              request(),
              { ...bundleInput, stableKey: 'advisor-config' },
              'commercial-advisor-config',
            ),
          denied('FORBIDDEN'),
        );
        await assert.rejects(
          () => service.configurationHistory(b.identities.owner, request(), bundle.id),
          denied('NOT_FOUND'),
        );
        await assert.rejects(
          () => service.configurationHistory(a.identities.outsider, request(), bundle.id),
          denied('NOT_FOUND'),
        );
        await db.request(advisor, request(), async (client) => {
          assert.equal(
            (
              await client.query('SELECT * FROM rpt.commercial_configuration_version WHERE id=$1', [
                mxPlan.versionId,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await client.query('SELECT * FROM rpt.commercial_bundle_line WHERE version_id=$1', [
                mxBundle.versionId,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (await client.query('SELECT * FROM rpt.price_list WHERE id=$1', [mxList])).rowCount,
            0,
          );
        });
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='delegate' AND object_type='pricing'",
          [a.tenant],
        );
        await assert.rejects(() => calculate({}, advisor), denied('NOT_FOUND', 'FORBIDDEN'));
        await grant('delegate', 'pricing', 'read');
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='pricing' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        await assert.rejects(() => calculate({}, advisor), denied('NOT_FOUND', 'FORBIDDEN'));
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='pricing' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
      },
    );
    await t.test(
      'country scope denies foreign configuration, regional scope permits and revocation is immediate',
      async () => {
        const foreignConfig = {
          ...common,
          marketId: mx,
          priceListId: mxList,
          kind: 'rules',
          stableKey: 'regional-only',
          rules: [{ kind: 'fixed_surcharge', value: '2', priority: 1 }],
        };
        await assert.rejects(
          () =>
            service.createConfigurationVersion(
              a.identities.ancestor,
              request(),
              foreignConfig,
              'commercial-country-denied',
            ),
          denied('FORBIDDEN'),
        );
        const regional = await service.createConfigurationVersion(
          a.identities.ai,
          request(),
          foreignConfig,
          'commercial-regional-config',
        );
        assert.ok(regional.versionId);
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='delegate' AND object_type='commercial'",
          [a.tenant],
        );
        await assert.rejects(() => calculate({}, a.identities.delegate), denied('FORBIDDEN'));
        await grant('delegate', 'commercial', 'calculate');
      },
    );
    await t.test(
      'draft-only database lifecycle, frozen composition, audited publish/retire and historical plans',
      async () => {
        const draft = await create(
          {
            ...common,
            kind: 'financing',
            stableKey: 'lifecycle-plan',
            mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
            terms: [{ months: 6, value: '0.1' }],
          },
          'commercial-lifecycle',
        );
        await assert.rejects(
          () =>
            service.transitionConfigurationVersion(
              a.identities.delegate,
              request(),
              draft.versionId,
              {
                schemaVersion: 1,
                expectedVersion: 1,
                action: 'activate',
                effectiveAt: at('2026-01-01'),
              },
              'commercial-advisor-publish',
            ),
          denied('NOT_FOUND', 'FORBIDDEN'),
        );
        await db.request(a.identities.delegate, request(), async (client) => {
          assert.equal(
            (
              await client.query(
                "UPDATE rpt.commercial_configuration_version SET status='active',revision=revision+1 WHERE id=$1",
                [draft.versionId],
              )
            ).rowCount,
            0,
          );
        });
        await db.request(owner, request(), async (client) => {
          await client.query('SAVEPOINT lifecycle_probe');
          await assert.rejects(
            () =>
              client.query(
                `INSERT INTO rpt.commercial_configuration_version(tenant_id,id,configuration_id,market_id,price_list_id,kind,version_no,status,valid_from,financing_mode,actor_id)
      VALUES($1,$2,$3,$4,$5,'financing',1,'active',$6,'SURCHARGE_EQUAL_INSTALLMENTS',$7)`,
                [a.tenant, randomUUID(), draft.id, ec, ecList, at('2026-01-01'), a.users.owner],
              ),
            (error: unknown) => {
              const pg = error as { code?: string; message?: string };
              return pg.code === '23514' && pg.message === 'draft_creation_required';
            },
          );
          await client.query('ROLLBACK TO SAVEPOINT lifecycle_probe');
        });
        await assert.rejects(() =>
          db.request(owner, request(), (client) =>
            client.query(
              "UPDATE rpt.commercial_configuration_version SET status='retired',valid_to=$2,revision=revision+1 WHERE id=$1",
              [draft.versionId, at('2026-06-01')],
            ),
          ),
        );
        await activate(draft);
        await assert.rejects(() =>
          db.request(owner, request(), (client) =>
            client.query(
              'INSERT INTO rpt.commercial_financing_term(tenant_id,id,version_id,market_id,months,value) VALUES($1,$2,$3,$4,7,0.1)',
              [a.tenant, randomUUID(), draft.versionId, ec],
            ),
          ),
        );
        const oldTerm = (await service.configurationHistory(owner, request(), draft.id))[0]!
          .terms[0]!;
        const original = await calculate({ financing: { planId: draft.id, termId: oldTerm.id } });
        await service.transitionConfigurationVersion(
          owner,
          request(),
          draft.versionId,
          { schemaVersion: 1, expectedVersion: 2, action: 'retire', effectiveAt: at('2026-06-01') },
          'commercial-retire-plan',
        );
        const next = await create(
          {
            ...common,
            kind: 'financing',
            stableKey: 'lifecycle-plan',
            expectedVersion: 1,
            validFrom: at('2026-06-01'),
            mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
            terms: [{ months: 6, value: '0.2' }],
          },
          'commercial-new-plan',
        );
        await activate(next);
        const history = await service.configurationHistory(owner, request(), draft.id);
        assert.equal(history.length, 2);
        assert.equal(history[0]!.status, 'retired');
        assert.equal(
          (await calculate({ financing: { planId: draft.id, termId: oldTerm.id } })).financing!
            .surcharge,
          '10.00',
        );
        const current = await calculate({
          asOf: at('2026-06-01'),
          financing: { planId: draft.id, termId: history[1]!.terms[0]!.id },
        });
        assert.equal(current.financing!.surcharge, '20.00');
        assert.notEqual(original.calculationHash, current.calculationHash);
        await assert.rejects(
          () =>
            calculate({
              asOf: at('2026-06-01'),
              financing: { planId: draft.id, termId: oldTerm.id },
            }),
          denied('NOT_FOUND'),
        );
      },
    );
    await t.test(
      'typed append-only SourceObservation cannot leak by Trust, wrong kind, tenant or market',
      async () => {
        const observed = await service.appendEvidence(
          owner,
          request(),
          {
            schemaVersion: 1,
            versionId: bundle.versionId,
            evidence: evidence('Synthetic composition evidence'),
          },
          'commercial-source',
        );
        await db.request(owner, request(), async (client) => {
          assert.equal(
            (
              await client.query(
                'SELECT commercial_subject_type FROM rpt.source_observation WHERE id=$1',
                [observed.id],
              )
            ).rows[0]?.commercial_subject_type,
            'bundle_version',
          );
        });
        await assert.rejects(() =>
          db.request(owner, request(), (client) =>
            client.query("UPDATE rpt.source_observation SET facts='{}' WHERE id=$1", [observed.id]),
          ),
        );
        await assert.rejects(() =>
          db.request(owner, request(), (client) =>
            client.query(
              `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,commercial_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
       VALUES($1,$2,'RPT_USER','commercial_configuration','financing_plan_version',$3,'synthetic','fixture://wrong',now(),now(),'manual',repeat('0',64),$4,'matched',$5,'{}')`,
              [a.tenant, randomUUID(), bundle.versionId, randomUUID(), a.users.owner],
            ),
          ),
        );
        const foreignSource = await service.appendEvidence(
          owner,
          request(),
          {
            schemaVersion: 1,
            versionId: mxBundle.versionId,
            evidence: evidence('Foreign composition'),
          },
          'commercial-source-foreign',
        );
        await db.request(a.identities.delegate, request(), async (client) => {
          assert.equal(
            (
              await client.query('SELECT * FROM rpt.source_observation WHERE id=$1', [
                foreignSource.id,
              ])
            ).rowCount,
            0,
          );
        });
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,'admin','trust','read','OFFICIAL_COMPENSATION',false,1)",
          [a.tenant],
        );
        await db.request(a.identities.outsider, request(), async (client) => {
          assert.equal(
            (await client.query('SELECT * FROM rpt.source_observation WHERE id=$1', [observed.id]))
              .rowCount,
            0,
          );
        });
        await db.request(b.identities.owner, request(), async (client) => {
          assert.equal(
            (await client.query('SELECT * FROM rpt.source_observation WHERE id=$1', [observed.id]))
              .rowCount,
            0,
          );
        });
        assert.ok(
          (
            await root!.query(
              "SELECT id FROM rpt.audit_event WHERE tenant_id=$1 AND action='commercial.configure' AND result='success'",
              [a.tenant],
            )
          ).rowCount! > 0,
        );
      },
    );
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
