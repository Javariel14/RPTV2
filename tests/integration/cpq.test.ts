import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  FoundationService,
  CommercialCalculatorService,
  QuoteService,
  createQuoteCalculationAttestor,
} from '@rpt/application';
import { FoundationError } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
import {
  insertQuote,
  quote,
  insertQuoteVersion as persistQuoteVersion,
} from '@rpt/persistence/cpq';
import { canonicalCommercial } from '@rpt/domain';
import { seedTenant } from '../helpers/fixtures.js';
import { startPostgres } from '../helpers/postgres.js';
const at = (date: string) => `${date}T00:00:00.000Z`;
const denied = (e: unknown) =>
  e instanceof FoundationError && ['NOT_FOUND', 'FORBIDDEN'].includes(e.code);
const evidence = (literal: string) => ({
  sourceSystem: 'RPT_USER',
  sourceReference: 'fixture://cpq',
  externalId: randomUUID(),
  observedAt: at('2026-01-01'),
  authorityLevel: 'manual',
  evidenceLevel: 'exact_primary',
  sourceLiteral: literal,
});
void test('E3B2 immutable CPQ snapshots, authorization and concurrent revision on real PostgreSQL', async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    const a = await seedTenant(root, 'cpq-a'),
      b = await seedTenant(root, 'cpq-b');
    const keyId = randomUUID(),
      secret = randomBytes(32).toString('hex');
    // Deployment provisioning only; the application/runtime never reads the secret from SQL.
    await root.query(
      "INSERT INTO authz.quote_calculation_key(tenant_id,id,secret) VALUES($1,$2,decode($3,'hex'))",
      [a.tenant, keyId, secret],
    );
    const attestor = createQuoteCalculationAttestor(keyId, secret);
    const insertQuoteVersion = async (
      c: Parameters<typeof persistQuoteVersion>[0],
      context: Parameters<typeof persistQuoteVersion>[1],
      row: Parameters<typeof persistQuoteVersion>[2],
      input: Parameters<typeof persistQuoteVersion>[3],
      output: Parameters<typeof persistQuoteVersion>[4],
      lines: Parameters<typeof persistQuoteVersion>[5],
      omitLines = false,
    ) =>
      persistQuoteVersion(
        c,
        context,
        row,
        input,
        output,
        omitLines ? [] : lines,
        await attestor.attest({
          schemaVersion: 1,
          tenantId: context.tenantId,
          actorId: context.actorId,
          quoteId: row.id,
          versionId: randomUUID(),
          versionNumber: row.current_version_number + 1,
          workspaceId: row.workspace_id,
          marketId: row.market_id,
          engineIdentity: 'E3B1/v1',
          input,
          result: output,
          lines,
        }),
      );
    const db = new PostgresDatabase(cluster.runtimeConfig()),
      foundation = new FoundationService(db),
      calculator = new CommercialCalculatorService(db),
      service = new QuoteService(db, attestor);
    const req = () => randomUUID(),
      owner = a.identities.owner,
      advisor = a.identities.delegate;
    const grant = async (
      fixture: typeof a,
      role: keyof typeof a.users,
      type: string,
      verbs: string[],
    ) => {
      for (const verb of verbs) {
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,$2,$3,$4,'CONFIDENTIAL',false,1)",
          [fixture.tenant, role, type, verb],
        );
        await root!.query(
          "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,$5,$6,'CONFIDENTIAL',1)",
          [fixture.tenant, randomUUID(), fixture.workspace, fixture.users[role], type, verb],
        );
      }
    };
    for (const f of [a, b]) {
      for (const type of ['product', 'catalog', 'pricing'])
        await grant(f, 'owner', type, ['read', 'create', 'update']);
      await grant(f, 'owner', 'pricing', ['manage']);
      await grant(f, 'owner', 'market_admin', ['read', 'manage', 'global']);
      await grant(f, 'owner', 'commercial', ['calculate', 'configure']);
      await grant(f, 'owner', 'cpq_quote', [
        'read',
        'create',
        'revise',
        'issue',
        'accept',
        'reject',
        'expire',
        'cancel',
      ]);
    }
    for (const type of ['product', 'catalog', 'pricing'])
      await grant(a, 'delegate', type, ['read']);
    await grant(a, 'delegate', 'commercial', ['calculate']);
    await grant(a, 'delegate', 'cpq_quote', [
      'read',
      'create',
      'revise',
      'issue',
      'accept',
      'reject',
      'expire',
      'cancel',
    ]);
    for (const domain of ['product_master', 'market_catalog', 'pricing', 'cpq_quote'])
      await root.query(
        "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_USER',$3,'manual')",
        [a.tenant, a.users.owner, domain],
      );
    const product = await foundation.createProduct(
      owner,
      req(),
      {
        schemaVersion: 1,
        workspaceId: a.workspace,
        stableKey: 'cpq-synthetic',
        name: 'Synthetic historical product',
        lifecycle: 'active',
      },
      'cpq-product-seed',
    );
    const market = async (countryCode: string, currency: string) => {
      const m = await foundation.createCatalogMarket(
        owner,
        req(),
        {
          schemaVersion: 1,
          countryCode,
          currency,
          locale: `es-${countryCode}`,
          timezone: countryCode === 'EC' ? 'America/Guayaquil' : 'UTC',
        },
        `cpq-market-${countryCode}`,
      );
      await foundation.grantAdminMarketScope(
        owner,
        req(),
        { schemaVersion: 1, userId: a.users.owner, marketId: m.id },
        `cpq-scope-${countryCode}`,
      );
      await foundation.setCatalogMarketStatus(
        owner,
        req(),
        m.id,
        { schemaVersion: 1, expectedVersion: 1, status: 'active' },
        `cpq-market-activate-${countryCode}`,
      );
      return m.id;
    };
    const ec = await market('EC', 'USD'),
      co = await market('CO', 'USD');
    const catalog = async (marketId: string, key: string, unknownTax = false) => {
      const mp = await foundation.createMarketProduct(
        owner,
        req(),
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
        `cpq-product-${key}`,
      );
      const list = await foundation.createPriceList(
        owner,
        req(),
        {
          schemaVersion: 1,
          marketId,
          workspaceId: a.workspace,
          stableKey: key,
          name: `Synthetic ${key}`,
          currency: 'USD',
          status: 'draft',
          validFrom: at('2026-01-01'),
          validTo: null,
          evidence: evidence(key),
        },
        `cpq-list-${key}`,
      );
      const entry = await foundation.addPriceEntry(
        owner,
        req(),
        list.id,
        {
          schemaVersion: 1,
          expectedVersion: 1,
          marketProductId: mp.id,
          currency: 'USD',
          amount: '100.00',
          taxTreatment: unknownTax ? 'tax_unknown' : 'tax_exclusive',
          taxRate: unknownTax ? null : '0.10',
          validFrom: at('2026-01-01'),
          validTo: at('2026-06-01'),
          evidence: evidence('$100 + explicit synthetic tax'),
        },
        `cpq-entry-${key}`,
      );
      await foundation.activatePriceList(
        owner,
        req(),
        list.id,
        { schemaVersion: 1, expectedVersion: entry.version },
        `cpq-list-active-${key}`,
      );
      return { mp: mp.id, list: list.id };
    };
    const local = await catalog(ec, 'ec'),
      foreign = await catalog(co, 'co');
    const tamperProbe = async (snapshot: Awaited<ReturnType<typeof service.getQuoteVersion>>) => {
      for (const changePayload of [false, true]) {
        await db.request(advisor, req(), async (c, context) => {
          await c.query('SAVEPOINT forged_final');
          const id = randomUUID();
          await insertQuote(c, context, id, ec, {
            schemaVersion: 1,
            workspaceId: a.workspace,
            personId: null,
            validUntil: null,
            calculation: snapshot.version.input_snapshot,
          });
          const row = await quote(c, id);
          assert.ok(row);
          const attestation = await attestor.attest({
            schemaVersion: 1,
            tenantId: context.tenantId,
            actorId: context.actorId,
            quoteId: id,
            versionId: randomUUID(),
            versionNumber: 1,
            workspaceId: row.workspace_id,
            marketId: ec,
            engineIdentity: 'E3B1/v1',
            input: snapshot.version.input_snapshot,
            result: snapshot.version.output_snapshot,
            lines: snapshot.lines,
          });
          const forged = structuredClone(snapshot.version.output_snapshot);
          forged.status = 'final';
          forged.requiresApproval = false;
          forged.totals.grandTotal ??= '100.00';
          assert.equal(forged.calculationHash, snapshot.version.calculation_hash);
          if (changePayload) {
            const envelope = JSON.parse(attestation.payload);
            envelope.result = forged;
            attestation.payload = canonicalCommercial(envelope);
          }
          await assert.rejects(
            persistQuoteVersion(
              c,
              context,
              row,
              snapshot.version.input_snapshot,
              forged,
              snapshot.lines,
              attestation,
            ),
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              'code' in e &&
              e.code === '23514' &&
              'message' in e &&
              String(e.message).includes(
                changePayload
                  ? 'unauthenticated_quote_calculation'
                  : 'inconsistent_authenticated_quote_snapshot',
              ),
          );
          await c.query('ROLLBACK TO SAVEPOINT forged_final');
          assert.equal(
            (await c.query('SELECT id FROM rpt.cpq_quote WHERE id=$1', [id])).rowCount,
            0,
          );
        });
      }
    };
    await foundation.assignOperationalMarket(
      owner,
      req(),
      {
        schemaVersion: 1,
        userId: a.users.delegate,
        marketId: ec,
        expectedVersion: 0,
        reason: 'Synthetic assignment',
      },
      'cpq-assign-advisor',
    );
    const calculation = {
      schemaVersion: 1,
      asOf: at('2026-05-31'),
      priceListId: local.list,
      lines: [{ kind: 'product', marketProductId: local.mp, quantity: '1' }],
    };
    const command = { schemaVersion: 1, workspaceId: a.workspace, calculation };
    let q: { id: string; versionId: string; version: number };
    let initial: Awaited<ReturnType<QuoteService['getQuoteVersion']>>;
    await t.test(
      'initial version reuses canonical calculator/hash and retry does not duplicate',
      async () => {
        const output = await calculator.calculateCommercialOffer(advisor, req(), calculation);
        q = await service.createQuote(advisor, req(), 'cpq-create-initial', command);
        assert.equal(q.version, 1);
        initial = await service.getQuoteVersion(advisor, req(), q.versionId);
        assert.equal(
          canonicalCommercial(initial.version.output_snapshot),
          canonicalCommercial(output),
        );
        assert.equal(initial.version.calculation_hash, output.calculationHash);
        assert.equal(initial.lines[0]?.catalog.path[0]?.name, 'Synthetic historical product');
        assert.equal(initial.lines[0]?.commercial.tax, '10.00');
        assert.deepEqual(
          await service.createQuote(advisor, req(), 'cpq-create-initial', command),
          q,
        );
        assert.equal((await service.listQuoteVersions(advisor, req(), q.id)).items.length, 1);
      },
    );
    await t.test(
      'revision snapshots are append-only; stale and concurrent revisions cannot duplicate numbers',
      async () => {
        const next = {
          schemaVersion: 1,
          expectedVersion: 1,
          calculation: {
            ...calculation,
            lines: [{ kind: 'product', marketProductId: local.mp, quantity: '2' }],
          },
        };
        const v2 = await service.reviseQuote(advisor, req(), q.id, 'cpq-revision-two', next);
        assert.equal(v2.version, 2);
        assert.deepEqual(await service.getQuoteVersion(advisor, req(), q.versionId), initial);
        await assert.rejects(
          service.reviseQuote(advisor, req(), q.id, 'cpq-revision-stale', next),
          (e) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        const concurrent = { ...next, expectedVersion: 2 };
        const results = await Promise.allSettled([
          service.reviseQuote(advisor, req(), q.id, 'cpq-race-one', concurrent),
          service.reviseQuote(advisor, req(), q.id, 'cpq-race-two', concurrent),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const failure = results.find((r) => r.status === 'rejected');
        assert.ok(
          failure?.status === 'rejected' &&
            failure.reason instanceof FoundationError &&
            failure.reason.code === 'CONFLICT',
        );
        assert.deepEqual(
          (await service.listQuoteVersions(advisor, req(), q.id)).items.map(
            (v) => v.version_number,
          ),
          [1, 2, 3],
        );
        assert.equal(
          (await service.listQuoteVersions(advisor, req(), q.id, { limit: 1 })).nextAfterVersion,
          1,
        );
      },
    );
    await t.test(
      'equivalent tenant capabilities, market spoofing and foreign object UUIDs fail closed',
      async () => {
        const fq = await service.createQuote(owner, req(), 'cpq-foreign-create', {
          ...command,
          calculation: {
            ...calculation,
            priceListId: foreign.list,
            lines: [{ kind: 'product', marketProductId: foreign.mp, quantity: '1' }],
          },
        });
        for (const actor of [advisor, b.identities.owner]) {
          await assert.rejects(service.getQuote(actor, req(), fq.id), denied);
          await assert.rejects(service.getQuoteVersion(actor, req(), fq.versionId), denied);
          await db.request(actor, req(), async (c) => {
            assert.equal(
              (await c.query('SELECT id FROM rpt.cpq_quote WHERE id=$1', [fq.id])).rowCount,
              0,
            );
            assert.equal(
              (
                await c.query('SELECT id FROM rpt.cpq_quote_line WHERE quote_version_id=$1', [
                  fq.versionId,
                ])
              ).rowCount,
              0,
            );
          });
        }
        await assert.rejects(service.getQuote(b.identities.owner, req(), q.id), denied);
        await assert.rejects(
          service.createQuote(advisor, req(), 'cpq-market-spoof', {
            ...command,
            calculation: { ...calculation, marketId: co },
          }),
          denied,
        );
        await assert.rejects(
          service.createQuote(advisor, req(), 'cpq-foreign-list', {
            ...command,
            calculation: { ...calculation, priceListId: foreign.list },
          }),
          denied,
        );
        await assert.rejects(
          foundation.assignOperationalMarket(
            advisor,
            req(),
            {
              schemaVersion: 1,
              userId: a.users.delegate,
              marketId: co,
              expectedVersion: 1,
              reason: 'Unauthorized switch',
            },
            'cpq-self-switch',
          ),
          denied,
        );
      },
    );
    await t.test(
      'typed Quote versus QuoteVersion evidence stays isolated with the SAME UUID',
      async () => {
        const foreignQuote = await service.createQuote(owner, req(), 'cpq-collision-foreign', {
          ...command,
          calculation: {
            ...calculation,
            priceListId: foreign.list,
            lines: [{ kind: 'product', marketProductId: foreign.mp, quantity: '1' }],
          },
        });
        const coEvidence = await service.appendQuoteEvidence(owner, req(), {
          schemaVersion: 1,
          subjectType: 'quote_version',
          subjectId: foreignQuote.versionId,
          evidence: evidence('Synthetic foreign version evidence'),
        });
        await db.request(owner, req(), async (c, aContext) => {
          await insertQuote(c, aContext, foreignQuote.versionId, ec, {
            ...command,
            schemaVersion: 1,
            personId: null,
            validUntil: null,
            calculation: initial.version.input_snapshot,
          });
          const row = await quote(c, foreignQuote.versionId);
          assert.ok(row);
          await insertQuoteVersion(
            c,
            aContext,
            row,
            initial.version.input_snapshot,
            initial.version.output_snapshot,
            initial.lines,
          );
        });
        const ecEvidence = await service.appendQuoteEvidence(owner, req(), {
          schemaVersion: 1,
          subjectType: 'quote',
          subjectId: foreignQuote.versionId,
          evidence: evidence('Synthetic local quote evidence'),
        });
        await db.request(advisor, req(), async (c) => {
          assert.equal(
            (await c.query('SELECT id FROM rpt.source_observation WHERE id=$1', [coEvidence.id]))
              .rowCount,
            0,
          );
          assert.equal(
            (await c.query('SELECT id FROM rpt.source_observation WHERE id=$1', [ecEvidence.id]))
              .rowCount,
            1,
          );
        });
        await assert.rejects(
          service.appendQuoteEvidence(advisor, req(), {
            schemaVersion: 1,
            subjectType: 'quote_version',
            subjectId: foreignQuote.versionId,
            evidence: evidence('Unauthorized foreign write'),
          }),
          denied,
        );
        await assert.rejects(
          service.appendQuoteEvidence(owner, req(), {
            schemaVersion: 1,
            subjectType: 'quote_version',
            subjectId: q.id,
            evidence: evidence('Incorrect entity type'),
          }),
          denied,
        );
        await db.request(b.identities.owner, req(), async (c) =>
          assert.equal(
            (
              await c.query('SELECT id FROM rpt.source_observation WHERE id=ANY($1::uuid[])', [
                [coEvidence.id, ecEvidence.id],
              ])
            ).rowCount,
            0,
          ),
        );
      },
    );
    await t.test(
      'direct SQL cannot hide an incomplete older version behind a complete newer version',
      async () => {
        await db.request(owner, req(), async (c, context) => {
          await c.query('SAVEPOINT incomplete_attack');
          const id = randomUUID();
          await insertQuote(c, context, id, ec, {
            ...command,
            schemaVersion: 1,
            personId: null,
            validUntil: null,
            calculation: initial.version.input_snapshot,
          });
          const v = initial.version;
          const first = await quote(c, id);
          assert.ok(first);
          await insertQuoteVersion(
            c,
            context,
            first,
            v.input_snapshot,
            v.output_snapshot,
            initial.lines,
            true,
          );
          const current = await quote(c, id);
          assert.ok(current);
          await insertQuoteVersion(
            c,
            context,
            current,
            v.input_snapshot,
            v.output_snapshot,
            initial.lines,
          );
          await assert.rejects(
            c.query('SET CONSTRAINTS ALL IMMEDIATE'),
            (e) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
          await c.query('ROLLBACK TO SAVEPOINT incomplete_attack');
        });
      },
    );
    await t.test(
      'runtime SQL cannot mutate historical versions/lines or skip lifecycle',
      async () => {
        await assert.rejects(
          db.request(advisor, req(), (c) =>
            c.query(
              "UPDATE rpt.cpq_quote_version SET calculation_hash=repeat('0',64) WHERE id=$1",
              [q.versionId],
            ),
          ),
        );
        await assert.rejects(
          db.request(advisor, req(), (c) =>
            c.query("UPDATE rpt.cpq_quote_line SET snapshot='{}' WHERE quote_version_id=$1", [
              q.versionId,
            ]),
          ),
        );
        await assert.rejects(
          service.transitionQuoteStatus(advisor, req(), q.id, {
            schemaVersion: 1,
            expectedVersion: 3,
            action: 'accept',
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await service.transitionQuoteStatus(advisor, req(), q.id, {
          schemaVersion: 1,
          expectedVersion: 3,
          action: 'issue',
        });
        await service.transitionQuoteStatus(advisor, req(), q.id, {
          schemaVersion: 1,
          expectedVersion: 4,
          action: 'accept',
        });
        await assert.rejects(
          service.reviseQuote(advisor, req(), q.id, 'cpq-terminal-revise', {
            schemaVersion: 1,
            expectedVersion: 5,
            calculation,
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        assert.deepEqual(await service.getQuoteVersion(advisor, req(), q.versionId), initial);
      },
    );
    await t.test(
      'history remains stable after a newly published future price; invalid pricing interval denied',
      async () => {
        await foundation.addPriceEntry(
          owner,
          req(),
          local.list,
          {
            schemaVersion: 1,
            expectedVersion: 3,
            marketProductId: local.mp,
            currency: 'USD',
            amount: '120.00',
            taxTreatment: 'tax_exclusive',
            taxRate: '0.10',
            validFrom: at('2026-06-01'),
            validTo: null,
            evidence: evidence('Synthetic future price'),
          },
          'cpq-future-price',
        );
        assert.deepEqual(await service.getQuoteVersion(advisor, req(), q.versionId), initial);
        const next = await service.createQuote(advisor, req(), 'cpq-future-quote', {
          ...command,
          calculation: { ...calculation, asOf: at('2026-06-01') },
        });
        const snapshot = await service.getQuoteVersion(advisor, req(), next.versionId);
        assert.equal(snapshot.lines[0]?.commercial.unitPrice, '120.00');
        assert.notEqual(snapshot.version.calculation_hash, initial.version.calculation_hash);
        await assert.rejects(
          service.createQuote(advisor, req(), 'cpq-invalid-interval', {
            ...command,
            calculation: { ...calculation, asOf: at('2025-12-31') },
          }),
        );
      },
    );
    await t.test(
      'bundle, discount, financing and requires-approval snapshots reuse E3B1 unchanged',
      async () => {
        const base = {
          schemaVersion: 1,
          marketId: ec,
          priceListId: local.list,
          name: 'Synthetic CPQ configuration',
          expectedVersion: 0,
          validFrom: at('2026-01-01'),
          validTo: null,
        };
        const bundle = await calculator.createConfigurationVersion(
          owner,
          req(),
          {
            ...base,
            kind: 'bundle',
            stableKey: 'cpq-bundle',
            pricingMode: 'COMPONENT_SUM',
            lines: [{ marketProductId: local.mp, quantity: '2' }],
          },
          'cpq-bundle-create',
        );
        const rules = await calculator.createConfigurationVersion(
          owner,
          req(),
          {
            ...base,
            kind: 'rules',
            stableKey: 'cpq-rules',
            rules: [{ kind: 'percentage_discount', value: '0.10', autoLimit: '0.05', priority: 1 }],
          },
          'cpq-rules-create',
        );
        const finance = await calculator.createConfigurationVersion(
          owner,
          req(),
          {
            ...base,
            kind: 'financing',
            stableKey: 'cpq-finance',
            mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
            terms: [{ months: 3, value: '0.10' }],
          },
          'cpq-finance-create',
        );
        for (const v of [bundle, rules, finance])
          await calculator.transitionConfigurationVersion(
            owner,
            req(),
            v.versionId,
            {
              schemaVersion: 1,
              expectedVersion: 1,
              action: 'activate',
              effectiveAt: at('2026-01-01'),
            },
            `cpq-activate-${v.versionId}`,
          );
        const term = (
          await root!.query<{ id: string }>(
            'SELECT id FROM rpt.commercial_financing_term WHERE version_id=$1',
            [finance.versionId],
          )
        ).rows[0]!;
        const input = {
          ...calculation,
          lines: [{ kind: 'bundle', bundleId: bundle.id, quantity: '1' }],
          ruleSetId: rules.id,
          financing: { planId: finance.id, termId: term.id },
        };
        const expected = await calculator.calculateCommercialOffer(advisor, req(), input);
        const created = await service.createQuote(advisor, req(), 'cpq-complex-snapshot', {
          ...command,
          calculation: input,
        });
        const snapshot = await service.getQuoteVersion(advisor, req(), created.versionId);
        assert.equal(
          canonicalCommercial(snapshot.version.output_snapshot),
          canonicalCommercial(expected),
        );
        assert.equal(snapshot.version.output_snapshot.requiresApproval, true);
        assert.equal(snapshot.lines[0]?.bundleComposition[0]?.quantity, '2.0000000000');
        assert.equal(snapshot.version.output_snapshot.appliedRules.length, 1);
        assert.ok(snapshot.version.output_snapshot.financing);
        await tamperProbe(snapshot);
        // Capability-equivalent foreign-market and foreign-tenant identities cannot publish it.
        for (const actor of [advisor, b.identities.owner]) {
          await db.request(actor, req(), async (c) => {
            await c.query('SAVEPOINT denied_publication');
            if (actor === advisor) {
              await assert.rejects(
                c.query("UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1", [
                  created.id,
                ]),
                (e) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
              );
              await c.query('ROLLBACK TO SAVEPOINT denied_publication');
            } else {
              assert.equal(
                (
                  await c.query(
                    "UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1",
                    [created.id],
                  )
                ).rowCount,
                0,
              );
            }
          });
        }
        await assert.rejects(
          service.transitionQuoteStatus(advisor, req(), created.id, {
            schemaVersion: 1,
            expectedVersion: 1,
            action: 'issue',
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await assert.rejects(
          db.request(advisor, req(), (c) =>
            c.query("UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1", [
              created.id,
            ]),
          ),
        );
      },
    );
    await t.test(
      'F1 incomplete E3B1 result cannot be relabeled or published; client flags and key access fail closed',
      async () => {
        const unknown = await catalog(ec, 'unknown-tax', true);
        const created = await service.createQuote(advisor, req(), 'cpq-incomplete-snapshot', {
          ...command,
          calculation: {
            ...calculation,
            priceListId: unknown.list,
            lines: [{ kind: 'product', marketProductId: unknown.mp, quantity: '1' }],
          },
        });
        const snapshot = await service.getQuoteVersion(advisor, req(), created.versionId);
        assert.equal(snapshot.version.output_snapshot.status, 'incomplete_tax_semantics');
        assert.equal(snapshot.version.output_snapshot.totals.grandTotal, null);
        await tamperProbe(snapshot);
        await assert.rejects(
          service.transitionQuoteStatus(advisor, req(), created.id, {
            schemaVersion: 1,
            expectedVersion: 1,
            action: 'issue',
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await db.request(advisor, req(), async (c) => {
          for (const sql of [
            "UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1",
            "UPDATE rpt.cpq_quote_version SET output_snapshot=jsonb_set(output_snapshot,'{requiresApproval}','false') WHERE quote_id=$1",
          ]) {
            await c.query('SAVEPOINT nonfinal_attack');
            await assert.rejects(c.query(sql, [created.id]));
            await c.query('ROLLBACK TO SAVEPOINT nonfinal_attack');
          }
          await c.query('SAVEPOINT private_key');
          await assert.rejects(
            c.query('SELECT secret FROM authz.quote_calculation_key'),
            (e) => typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT private_key');
        });
        await assert.rejects(
          service.createQuote(advisor, req(), 'cpq-client-false-flag', {
            ...command,
            requiresApproval: false,
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        const foreignQuote = await service.createQuote(owner, req(), 'cpq-f1-foreign-publication', {
          ...command,
          calculation: {
            ...calculation,
            priceListId: foreign.list,
            lines: [{ kind: 'product', marketProductId: foreign.mp, quantity: '1' }],
          },
        });
        for (const actor of [advisor, b.identities.owner]) {
          await assert.rejects(
            service.transitionQuoteStatus(actor, req(), foreignQuote.id, {
              schemaVersion: 1,
              expectedVersion: 1,
              action: 'issue',
            }),
            denied,
          );
          await db.request(actor, req(), async (c) =>
            assert.equal(
              (
                await c.query(
                  "UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1",
                  [foreignQuote.id],
                )
              ).rowCount,
              0,
            ),
          );
        }
      },
    );
    await t.test(
      'F1 current-version publication and revocation guard genuine final snapshots',
      async () => {
        const created = await service.createQuote(advisor, req(), 'cpq-f1-final', command);
        await service.reviseQuote(advisor, req(), created.id, 'cpq-f1-final-revision', {
          schemaVersion: 1,
          expectedVersion: 1,
          calculation,
        });
        await assert.rejects(
          service.transitionQuoteStatus(advisor, req(), created.id, {
            schemaVersion: 1,
            expectedVersion: 1,
            action: 'issue',
          }),
          (e) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        await db.request(advisor, req(), async (c) => {
          await c.query('SAVEPOINT stale_pointer');
          await assert.rejects(
            c.query(
              "UPDATE rpt.cpq_quote SET current_version_number=1,status='issued',version=version+1 WHERE id=$1",
              [created.id],
            ),
            (e) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
          await c.query('ROLLBACK TO SAVEPOINT stale_pointer');
        });
        const before = await service.getQuoteVersion(advisor, req(), created.versionId);
        await service.transitionQuoteStatus(advisor, req(), created.id, {
          schemaVersion: 1,
          expectedVersion: 2,
          action: 'issue',
        });
        assert.deepEqual(await service.getQuoteVersion(advisor, req(), created.versionId), before);
        const revoked = await service.createQuote(advisor, req(), 'cpq-f1-revoked-final', command);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_quote' AND verb='issue'",
          [a.tenant, a.users.delegate],
        );
        await assert.rejects(
          service.transitionQuoteStatus(advisor, req(), revoked.id, {
            schemaVersion: 1,
            expectedVersion: 1,
            action: 'issue',
          }),
          denied,
        );
        await db.request(advisor, req(), async (c) => {
          await c.query('SAVEPOINT revoked_issue');
          await assert.rejects(
            c.query("UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1", [
              revoked.id,
            ]),
            (e) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
          await c.query('ROLLBACK TO SAVEPOINT revoked_issue');
        });
        assert.equal((await service.getQuote(advisor, req(), revoked.id)).quote.status, 'draft');
      },
    );
    await t.test(
      'workspace and capability revocation apply immediately to historical read',
      async () => {
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_quote' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        await assert.rejects(service.getQuote(advisor, req(), q.id), denied);
        await assert.rejects(service.getQuoteVersion(advisor, req(), q.versionId), denied);
      },
    );
    await t.test(
      'workspace UUID cannot substitute authorized scope and draft/closed lists cannot create snapshots',
      async () => {
        const workspace = randomUUID();
        await root!.query(
          "INSERT INTO rpt.crm_workspace(tenant_id,id,name,kind) VALUES($1,$2,'Foreign same-tenant workspace','commercial')",
          [a.tenant, workspace],
        );
        await assert.rejects(
          service.createQuote(owner, req(), 'cpq-foreign-workspace', {
            ...command,
            workspaceId: workspace,
          }),
          denied,
        );
        const draft = await foundation.createPriceList(
          owner,
          req(),
          {
            schemaVersion: 1,
            marketId: ec,
            workspaceId: a.workspace,
            stableKey: 'cpq-draft-list',
            name: 'Synthetic unpublished list',
            currency: 'USD',
            status: 'draft',
            validFrom: at('2026-01-01'),
            validTo: null,
            evidence: evidence('Synthetic draft'),
          },
          'cpq-draft-list-create',
        );
        await assert.rejects(
          service.createQuote(owner, req(), 'cpq-draft-quote', {
            ...command,
            calculation: { ...calculation, priceListId: draft.id },
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await foundation.closePriceList(
          owner,
          req(),
          local.list,
          { schemaVersion: 1, expectedVersion: 4, validTo: at('2027-01-01') },
          'cpq-close-list',
        );
        await assert.rejects(
          service.createQuote(owner, req(), 'cpq-closed-quote', command),
          denied,
        );
        // Authorized historical read survives source-list closure and revoked advisor read.
        assert.deepEqual(await service.getQuoteVersion(owner, req(), q.versionId), initial);
      },
    );
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
