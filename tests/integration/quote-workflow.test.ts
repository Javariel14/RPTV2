import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  FoundationService,
  CommercialCalculatorService,
  QuoteService,
  QuoteWorkflowService,
  createQuoteCalculationAttestor,
} from '@rpt/application';
import { FoundationError } from '@rpt/contracts';
import { PostgresDatabase } from '@rpt/persistence';
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
void test('E3B3 exact-version approval, acceptance and immutable Order on real PostgreSQL', async (t) => {
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
    const db = new PostgresDatabase(cluster.runtimeConfig()),
      foundation = new FoundationService(db),
      calculator = new CommercialCalculatorService(db),
      service = new QuoteService(db, attestor),
      workflow = new QuoteWorkflowService(db);
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

    assert.equal(
      (await root.query('SELECT count(*)::integer AS n FROM public.foundation_migration')).rows[0]
        .n,
      18,
    );
    for (const f of [a, b]) {
      await grant(f, 'owner', 'quote_approval', ['read', 'request', 'decide']);
      await grant(f, 'owner', 'cpq_order', ['read', 'create']);
    }
    for (const role of ['delegate', 'ancestor', 'ai'] as const) {
      if (role !== 'delegate') {
        await grant(a, role, 'cpq_quote', ['read', 'create', 'revise', 'issue', 'accept']);
        await grant(a, role, 'commercial', ['calculate']);
        for (const domain of ['product', 'catalog', 'pricing'])
          await grant(a, role, domain, ['read']);
      }
      await grant(a, role, 'quote_approval', ['read', 'request', 'decide']);
      await grant(a, role, 'cpq_order', ['read', 'create']);
      await foundation.assignOperationalMarket(
        owner,
        req(),
        {
          schemaVersion: 1,
          userId: a.users[role],
          marketId: role === 'ai' ? co : ec,
          expectedVersion: 0,
          reason: 'Synthetic bounded actor',
        },
        'workflow-assignment-' + role,
      );
    }
    await grant(a, 'ancestor', 'market_admin', ['read', 'manage']);
    await foundation.grantAdminMarketScope(
      owner,
      req(),
      { schemaVersion: 1, userId: a.users.ancestor, marketId: ec },
      'workflow-country-scope',
    );
    const approver = a.identities.ancestor,
      foreignActor = a.identities.ai;
    for (const actor of [a.users.owner, a.users.delegate])
      await root.query(
        "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_USER','quote_workflow','manual')",
        [a.tenant, actor],
      );
    const base = {
      schemaVersion: 1,
      marketId: ec,
      priceListId: local.list,
      name: 'Synthetic workflow policy',
      expectedVersion: 0,
      validFrom: at('2026-01-01'),
      validTo: null,
    };
    const rules = await calculator.createConfigurationVersion(
      owner,
      req(),
      {
        ...base,
        kind: 'rules',
        stableKey: 'workflow-rules',
        rules: [{ kind: 'percentage_discount', value: '0.10', autoLimit: '0.05', priority: 1 }],
      },
      'workflow-rules-create',
    );
    const bundle = await calculator.createConfigurationVersion(
      owner,
      req(),
      {
        ...base,
        kind: 'bundle',
        stableKey: 'workflow-bundle',
        pricingMode: 'COMPONENT_SUM',
        lines: [{ marketProductId: local.mp, quantity: '2' }],
      },
      'workflow-bundle-create',
    );
    const finance = await calculator.createConfigurationVersion(
      owner,
      req(),
      {
        ...base,
        kind: 'financing',
        stableKey: 'workflow-finance',
        mode: 'SURCHARGE_EQUAL_INSTALLMENTS',
        terms: [{ months: 3, value: '0.10' }],
      },
      'workflow-finance-create',
    );
    for (const config of [rules, bundle, finance])
      await calculator.transitionConfigurationVersion(
        owner,
        req(),
        config.versionId,
        { schemaVersion: 1, expectedVersion: 1, action: 'activate', effectiveAt: at('2026-01-01') },
        'workflow-activate-' + config.id,
      );
    const term = (
      await root.query('SELECT id FROM rpt.commercial_financing_term WHERE version_id=$1', [
        finance.versionId,
      ])
    ).rows[0];
    const calculation = {
      schemaVersion: 1,
      asOf: at('2026-05-31'),
      priceListId: local.list,
      lines: [{ kind: 'product', marketProductId: local.mp, quantity: '1' }],
    };
    const requiredCalculation = {
      ...calculation,
      lines: [{ kind: 'bundle', bundleId: bundle.id, quantity: '1' }],
      ruleSetId: rules.id,
      financing: { planId: finance.id, termId: term.id },
    };
    const create = (key: string, required = true, actor = advisor) =>
      service.createQuote(actor, req(), key, {
        schemaVersion: 1,
        workspaceId: a.workspace,
        personId: null,
        calculation: required ? requiredCalculation : calculation,
      });
    const requestApproval = (version: string, expectedVersion = 1, key: string = randomUUID()) =>
      workflow.requestQuoteApproval(advisor, req(), key, {
        schemaVersion: 1,
        quoteVersionId: version,
        expectedVersion,
        reason: 'Synthetic authorized request',
      });
    const decide = (
      version: string,
      requestId: string,
      decision = 'approved',
      actor = approver,
      expectedVersion = 1,
    ) =>
      workflow.decideQuoteApproval(actor, req(), randomUUID(), {
        schemaVersion: 1,
        quoteVersionId: version,
        expectedVersion,
        approvalRequestId: requestId,
        decision,
        reason: 'Synthetic decision',
      });
    const issue = (id: string, expectedVersion = 1, actor = advisor) =>
      service.transitionQuoteStatus(actor, req(), id, {
        schemaVersion: 1,
        expectedVersion,
        action: 'issue',
      });
    const accept = (
      version: string,
      expectedVersion = 2,
      key: string = randomUUID(),
      actor = advisor,
    ) =>
      workflow.recordQuoteAcceptance(actor, req(), key, {
        schemaVersion: 1,
        quoteVersionId: version,
        expectedVersion,
        method: 'administrative_record',
        note: 'Recorded business acceptance, not an electronic signature',
      });
    const convert = (
      version: string,
      acceptanceId: string,
      expectedVersion = 3,
      key: string = randomUUID(),
      actor = advisor,
    ) =>
      workflow.createOrderFromAcceptedQuote(actor, req(), key, {
        schemaVersion: 1,
        quoteVersionId: version,
        expectedVersion,
        acceptanceId,
      });
    const invalid = (e: unknown) =>
      e instanceof FoundationError &&
      ['INVALID_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'CONFLICT'].includes(e.code);
    const sqlRejected = async (
      actor: typeof advisor,
      sql: string,
      values: unknown[],
      code?: string,
    ) =>
      db.request(actor, req(), async (c) => {
        await c.query('SAVEPOINT workflow_attack');
        await assert.rejects(
          (async () => {
            await c.query(sql, values);
            await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          })(),
          (e) => typeof e === 'object' && e !== null && 'code' in e && (!code || e.code === code),
        );
        await c.query('ROLLBACK TO SAVEPOINT workflow_attack');
      });
    let primary: Awaited<ReturnType<typeof create>>,
      approval: { id: string },
      accepted: { id: string },
      canonicalOrder: { id: string };
    let original: Awaited<ReturnType<typeof service.getQuoteVersion>>;
    await t.test(
      'approval request is exact-version, idempotent and authentic; non-required request denied',
      async () => {
        primary = await create('workflow-primary');
        original = await service.getQuoteVersion(advisor, req(), primary.versionId);
        assert.equal(original.version.output_snapshot.status, 'requires_approval');
        assert.equal(original.version.output_snapshot.requiresApproval, true);
        approval = await requestApproval(primary.versionId, 1, 'workflow-primary-request');
        assert.deepEqual(
          await requestApproval(primary.versionId, 1, 'workflow-primary-request'),
          approval,
        );
        await assert.rejects(requestApproval(primary.versionId), invalid);
        const detail = await workflow.getQuoteApproval(advisor, req(), approval.id);
        assert.equal(detail.status, 'pending');
        assert.equal(detail.actionable, true);
        assert.equal(detail.quote_version_id, primary.versionId);
        const final = await create('workflow-final-no-request', false);
        await assert.rejects(requestApproval(final.versionId), invalid);
      },
    );
    await t.test(
      'self-approval, false approver, foreign scope and runtime decision forgery fail closed',
      async () => {
        await assert.rejects(decide(primary.versionId, approval.id, 'approved', advisor), denied);
        await assert.rejects(
          workflow.decideQuoteApproval(approver, req(), randomUUID(), {
            schemaVersion: 1,
            quoteVersionId: primary.versionId,
            expectedVersion: 1,
            approvalRequestId: approval.id,
            decision: 'approved',
            reason: 'Spoof',
            decidedBy: a.users.owner,
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await sqlRejected(
          advisor,
          "INSERT INTO rpt.quote_approval_decision(tenant_id,id,quote_version_id,approval_request_id,decision,reason) VALUES($1,$2,$3,$4,'approved','Self forgery')",
          [a.tenant, randomUUID(), primary.versionId, approval.id],
          '42501',
        );
        await sqlRejected(
          approver,
          "INSERT INTO rpt.quote_approval_decision(tenant_id,id,quote_version_id,approval_request_id,created_by,decision,reason) VALUES($1,$2,$3,$4,$5,'approved','Spoofed actor')",
          [a.tenant, randomUUID(), primary.versionId, approval.id, a.users.owner],
          '23514',
        );
        for (const actor of [foreignActor, b.identities.owner]) {
          await assert.rejects(workflow.getQuoteApproval(actor, req(), approval.id), denied);
          await assert.rejects(decide(primary.versionId, approval.id, 'approved', actor), denied);
          await db.request(actor, req(), async (c) =>
            assert.equal(
              (
                await c.query('SELECT id FROM rpt.quote_approval_request WHERE id=$1', [
                  approval.id,
                ])
              ).rowCount,
              0,
            ),
          );
        }
        // Prove lack of the explicit approval capability, rather than assigning implicit quote authority.
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='delegate' AND object_type='quote_approval' AND verb='decide'",
          [a.tenant],
        );
        await assert.rejects(decide(primary.versionId, approval.id, 'approved', advisor), denied);
      },
    );
    await t.test(
      'only exact approved current version may issue; decision history is immutable',
      async () => {
        await assert.rejects(issue(primary.id), invalid);
        await sqlRejected(
          advisor,
          "UPDATE rpt.cpq_quote SET status='issued',version=version+1 WHERE id=$1",
          [primary.id],
          '23514',
        );
        const decision = await decide(primary.versionId, approval.id);
        assert.equal(
          (await workflow.getQuoteApproval(advisor, req(), approval.id)).status,
          'approved',
        );
        await sqlRejected(
          approver,
          "UPDATE rpt.quote_approval_decision SET decision='rejected' WHERE id=$1",
          [decision.id],
          '42501',
        );
        await assert.rejects(decide(primary.versionId, approval.id), invalid);
        await issue(primary.id);
        assert.deepEqual(
          await service.getQuoteVersion(advisor, req(), primary.versionId),
          original,
        );
      },
    );
    await t.test(
      'issued exact version accepts immutably; direct terminal UPDATE cannot omit acceptance',
      async () => {
        await sqlRejected(
          advisor,
          "UPDATE rpt.cpq_quote SET status='accepted',version=version+1 WHERE id=$1 RETURNING id",
          [primary.id],
        );
        // Deferred guard fires at constraint evaluation, not necessarily at UPDATE itself.
        accepted = await accept(primary.versionId, 2, 'workflow-primary-accept');
        assert.deepEqual(await accept(primary.versionId, 2, 'workflow-primary-accept'), accepted);
        const record = await workflow.getQuoteAcceptance(advisor, req(), accepted.id);
        assert.equal(record.quote_version_id, primary.versionId);
        assert.equal((await service.getQuote(advisor, req(), primary.id)).quote.status, 'accepted');
        await sqlRejected(
          advisor,
          'UPDATE rpt.quote_acceptance SET quote_version_id=$2 WHERE id=$1',
          [accepted.id, randomUUID()],
          '42501',
        );
        await assert.rejects(
          service.reviseQuote(advisor, req(), primary.id, randomUUID(), {
            schemaVersion: 1,
            expectedVersion: 3,
            calculation,
          }),
          invalid,
        );
        assert.deepEqual(
          await service.getQuoteVersion(advisor, req(), primary.versionId),
          original,
        );
      },
    );
    await t.test(
      'Order copies accepted snapshot without repricing after live source changes',
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
            amount: '999.00',
            taxTreatment: 'tax_exclusive',
            taxRate: '0.10',
            validFrom: at('2026-06-01'),
            validTo: null,
            evidence: evidence('Synthetic changed price'),
          },
          'workflow-new-live-price',
        );
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='pricing' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        canonicalOrder = await convert(primary.versionId, accepted.id, 3, 'workflow-primary-order');
        const detail = await workflow.getOrder(advisor, req(), canonicalOrder.id);
        assert.equal(
          (detail.order as unknown as { calculation_hash: string }).calculation_hash,
          original.version.calculation_hash,
        );
        assert.deepEqual(
          (detail.order as unknown as { commercial_snapshot: unknown }).commercial_snapshot,
          original.version.output_snapshot,
        );
        assert.deepEqual(detail.lines, original.lines);
        assert.ok(original.version.output_snapshot.financing);
        assert.equal(original.version.output_snapshot.appliedRules.length, 1);
        assert.equal(original.lines[0]?.bundleComposition[0]?.quantity, '2.0000000000');
        assert.deepEqual(
          await convert(primary.versionId, accepted.id, 3, 'workflow-primary-order'),
          canonicalOrder,
        );
        const concurrent = await Promise.all([
          convert(primary.versionId, accepted.id),
          convert(primary.versionId, accepted.id),
        ]);
        assert.deepEqual(concurrent, [canonicalOrder, canonicalOrder]);
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.cpq_order WHERE quote_version_id=$1',
              [primary.versionId],
            )
          ).rows[0].n,
          1,
        );
        await sqlRejected(
          advisor,
          "UPDATE rpt.cpq_order SET commercial_snapshot='{}' WHERE id=$1",
          [canonicalOrder.id],
          '42501',
        );
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='pricing' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
      },
    );
    await t.test(
      'same-hash V1 approval cannot authorize V2 or another Quote; pending history superseded',
      async () => {
        const first = await create('workflow-replay-first');
        const r1 = await requestApproval(first.versionId);
        await decide(first.versionId, r1.id);
        const v1 = await service.getQuoteVersion(advisor, req(), first.versionId);
        const v2 = await service.reviseQuote(advisor, req(), first.id, randomUUID(), {
          schemaVersion: 1,
          expectedVersion: 1,
          calculation: requiredCalculation,
        });
        const current = await service.getQuoteVersion(advisor, req(), v2.versionId);
        assert.equal(v1.version.calculation_hash, current.version.calculation_hash);
        assert.notEqual(v1.version.id, current.version.id);
        await assert.rejects(issue(first.id, 2), invalid);
        const r2 = await requestApproval(v2.versionId, 2);
        await assert.rejects(decide(v2.versionId, r1.id, 'approved', approver, 2), denied);
        const other = await create('workflow-replay-other');
        await assert.rejects(decide(other.versionId, r2.id), denied);
        await decide(v2.versionId, r2.id, 'approved', approver, 2);
        await issue(first.id, 2);
        assert.equal((await workflow.getQuoteApproval(advisor, req(), r1.id)).status, 'approved');
        assert.equal((await workflow.getQuoteApproval(advisor, req(), r1.id)).actionable, false);
        const pending = await create('workflow-superseded');
        const old = await requestApproval(pending.versionId);
        await service.reviseQuote(advisor, req(), pending.id, randomUUID(), {
          schemaVersion: 1,
          expectedVersion: 1,
          calculation: requiredCalculation,
        });
        assert.equal(
          (await workflow.getQuoteApproval(advisor, req(), old.id)).status,
          'superseded',
        );
        await assert.rejects(decide(pending.versionId, old.id, 'approved', approver, 2), invalid);
      },
    );
    await t.test(
      'rejection blocks publication; authority revoked before decision fails; past approval survives revocation',
      async () => {
        const rejected = await create('workflow-rejected'),
          r = await requestApproval(rejected.versionId);
        await decide(rejected.versionId, r.id, 'rejected');
        await assert.rejects(issue(rejected.id), invalid);
        await assert.rejects(accept(rejected.versionId, 1), invalid);
        const target = await create('workflow-revoked'),
          request = await requestApproval(target.versionId);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='quote_approval' AND verb='decide'",
          [a.tenant, a.users.ancestor],
        );
        await assert.rejects(decide(target.versionId, request.id), denied);
        assert.equal(
          (await workflow.getQuoteApproval(advisor, req(), approval.id)).status,
          'approved',
        );
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='quote_approval' AND verb='decide'",
          [a.tenant, a.users.ancestor],
        );
      },
    );
    await t.test(
      'draft, rejected, cancelled, expired and foreign acceptance/version cannot convert',
      async () => {
        const draft = await create('workflow-draft', false);
        await assert.rejects(accept(draft.versionId, 1), invalid);
        await assert.rejects(convert(draft.versionId, accepted.id, 1), denied);
        await assert.rejects(convert(draft.versionId, randomUUID(), 1), denied);
        const cancelled = await create('workflow-cancelled', false);
        await service.transitionQuoteStatus(advisor, req(), cancelled.id, {
          schemaVersion: 1,
          expectedVersion: 1,
          action: 'cancel',
        });
        await assert.rejects(accept(cancelled.versionId, 2), invalid);
        for (const actor of [foreignActor, b.identities.owner]) {
          await assert.rejects(workflow.getQuoteAcceptance(actor, req(), accepted.id), denied);
          await assert.rejects(workflow.getOrder(actor, req(), canonicalOrder.id), denied);
          await assert.rejects(
            convert(primary.versionId, accepted.id, 3, randomUUID(), actor),
            denied,
          );
          await db.request(actor, req(), async (c) => {
            assert.equal(
              (await c.query('SELECT id FROM rpt.cpq_order WHERE id=$1', [canonicalOrder.id]))
                .rowCount,
              0,
            );
            assert.equal(
              (await c.query('SELECT id FROM rpt.quote_acceptance WHERE id=$1', [accepted.id]))
                .rowCount,
              0,
            );
          });
        }
        await sqlRejected(
          advisor,
          "INSERT INTO rpt.cpq_order(tenant_id,id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot) VALUES($1,$2,$3,$4,NULL,'USD','{}')",
          [a.tenant, randomUUID(), draft.versionId, accepted.id],
          '42501',
        );
      },
    );
    await t.test(
      'historical tenant key rotation retains approval/publication/acceptance authenticity',
      async () => {
        const target = await create('workflow-historical-key');
        const r = await requestApproval(target.versionId);
        await decide(target.versionId, r.id);
        await root!.query(
          'UPDATE authz.quote_calculation_key SET active=false WHERE tenant_id=$1 AND id=$2',
          [a.tenant, keyId],
        );
        await issue(target.id);
        const acceptance = await accept(target.versionId);
        await convert(target.versionId, acceptance.id);
        assert.equal((await workflow.getQuoteApproval(advisor, req(), r.id)).status, 'approved');
        await root!.query(
          'UPDATE authz.quote_calculation_key SET active=true WHERE tenant_id=$1 AND id=$2',
          [a.tenant, keyId],
        );
      },
    );
    await t.test(
      'country EC approver cannot decide CO; regional/global scoped approver can with capability',
      async () => {
        const coRules = await calculator.createConfigurationVersion(
          owner,
          req(),
          {
            ...base,
            marketId: co,
            priceListId: foreign.list,
            kind: 'rules',
            stableKey: 'workflow-co-rules',
            rules: [{ kind: 'percentage_discount', value: '0.10', autoLimit: '0.05', priority: 1 }],
          },
          'workflow-co-rules',
        );
        await calculator.transitionConfigurationVersion(
          owner,
          req(),
          coRules.versionId,
          {
            schemaVersion: 1,
            expectedVersion: 1,
            action: 'activate',
            effectiveAt: at('2026-01-01'),
          },
          'workflow-co-rules-active',
        );
        const foreignQuote = await service.createQuote(foreignActor, req(), randomUUID(), {
          schemaVersion: 1,
          workspaceId: a.workspace,
          calculation: {
            ...calculation,
            priceListId: foreign.list,
            lines: [{ kind: 'product', marketProductId: foreign.mp, quantity: '1' }],
            ruleSetId: coRules.id,
          },
        });
        const foreignRequest = await workflow.requestQuoteApproval(
          foreignActor,
          req(),
          randomUUID(),
          {
            schemaVersion: 1,
            quoteVersionId: foreignQuote.versionId,
            expectedVersion: 1,
            reason: 'CO request',
          },
        );
        await assert.rejects(decide(foreignQuote.versionId, foreignRequest.id), denied);
        // With global capability removed, the explicit EC+CO scope proves regional access.
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='owner' AND object_type='market_admin' AND verb='global'",
          [a.tenant],
        );
        await decide(foreignQuote.versionId, foreignRequest.id, 'approved', owner);
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','market_admin','global','CONFIDENTIAL',false,1)",
          [a.tenant],
        );
        await issue(foreignQuote.id, 1, foreignActor);
        const coAccept = await accept(foreignQuote.versionId, 2, randomUUID(), foreignActor);
        const coOrder = await convert(
          foreignQuote.versionId,
          coAccept.id,
          3,
          randomUUID(),
          foreignActor,
        );
        await assert.rejects(convert(primary.versionId, coAccept.id), denied);
        const coEvidence = await workflow.appendWorkflowEvidence(owner, req(), {
          schemaVersion: 1,
          subjectType: 'order',
          subjectId: coOrder.id,
          evidence: evidence('Foreign Order evidence'),
        });
        // Intentional SAME UUID across different entity tables.
        const localCollision = await create('workflow-evidence-collision');
        await db.request(advisor, req(), async (c) =>
          c.query(
            'INSERT INTO rpt.quote_approval_request(tenant_id,id,quote_version_id,reason) VALUES($1,$2,$3,$4)',
            [a.tenant, coOrder.id, localCollision.versionId, 'Synthetic collision'],
          ),
        );
        const localEvidence = await workflow.appendWorkflowEvidence(advisor, req(), {
          schemaVersion: 1,
          subjectType: 'approval_request',
          subjectId: coOrder.id,
          evidence: evidence('Local approval request evidence'),
        });
        await db.request(advisor, req(), async (c) => {
          assert.equal(
            (await c.query('SELECT id FROM rpt.source_observation WHERE id=$1', [coEvidence.id]))
              .rowCount,
            0,
          );
          assert.equal(
            (await c.query('SELECT id FROM rpt.source_observation WHERE id=$1', [localEvidence.id]))
              .rowCount,
            1,
          );
        });
        await assert.rejects(
          workflow.appendWorkflowEvidence(advisor, req(), {
            schemaVersion: 1,
            subjectType: 'order',
            subjectId: coOrder.id,
            evidence: evidence('Foreign evidence attack'),
          }),
          invalid,
        );
        await assert.rejects(
          workflow.appendWorkflowEvidence(advisor, req(), {
            schemaVersion: 1,
            subjectType: 'approval_decision',
            subjectId: localCollision.versionId,
            evidence: evidence('Wrong type'),
          }),
          invalid,
        );
      },
    );
    await t.test(
      'concurrent decisions/conversion are unique; workspace and capability revocation remain additive',
      async () => {
        const target = await create('workflow-race');
        const r = await requestApproval(target.versionId);
        const decisions = await Promise.allSettled([
          decide(target.versionId, r.id),
          decide(target.versionId, r.id),
        ]);
        assert.equal(decisions.filter((x) => x.status === 'fulfilled').length, 1);
        assert.equal(decisions.filter((x) => x.status === 'rejected').length, 1);
        await issue(target.id);
        const acceptance = await accept(target.versionId);
        const conversions = await Promise.all([
          convert(target.versionId, acceptance.id),
          convert(target.versionId, acceptance.id),
        ]);
        assert.deepEqual(conversions[0], conversions[1]);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        await assert.rejects(workflow.getOrder(advisor, req(), conversions[0]!.id), denied);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        const otherWorkspace = randomUUID();
        await root!.query(
          "INSERT INTO rpt.crm_workspace(tenant_id,id,name,kind) VALUES($1,$2,'Foreign workflow workspace','commercial')",
          [a.tenant, otherWorkspace],
        );
        await sqlRejected(
          advisor,
          'INSERT INTO rpt.quote_approval_request(tenant_id,id,quote_version_id,workspace_id,reason) VALUES($1,$2,$3,$4,$5)',
          [a.tenant, randomUUID(), target.versionId, otherWorkspace, 'Substitution'],
          '23514',
        );
        await assert.rejects(
          workflow.requestQuoteApproval(advisor, req(), randomUUID(), {
            schemaVersion: 1,
            quoteVersionId: target.versionId,
            expectedVersion: 3,
            reason: 'Spoofed country',
            marketId: co,
          }),
          (e) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
      },
    );
    await t.test(
      'terminal states and absent Order capability cannot substitute acceptance authority',
      async () => {
        const rejected = await create('workflow-terminal-rejected', false);
        await issue(rejected.id);
        await service.transitionQuoteStatus(advisor, req(), rejected.id, {
          schemaVersion: 1,
          expectedVersion: 2,
          action: 'reject',
        });
        await assert.rejects(accept(rejected.versionId, 3), invalid);
        const expired = await service.createQuote(advisor, req(), 'workflow-terminal-expired', {
          schemaVersion: 1,
          workspaceId: a.workspace,
          validUntil: at('2020-01-01'),
          calculation,
        });
        await assert.rejects(issue(expired.id), invalid);
        await service.transitionQuoteStatus(advisor, req(), expired.id, {
          schemaVersion: 1,
          expectedVersion: 1,
          action: 'expire',
        });
        await assert.rejects(accept(expired.versionId, 2), invalid);
        const cancelled = await create('workflow-pending-cancelled');
        const pending = await requestApproval(cancelled.versionId);
        await service.transitionQuoteStatus(advisor, req(), cancelled.id, {
          schemaVersion: 1,
          expectedVersion: 1,
          action: 'cancel',
        });
        assert.equal(
          (await workflow.getQuoteApproval(advisor, req(), pending.id)).actionable,
          false,
        );
        await root!.query(
          "DELETE FROM authz.role_capability WHERE tenant_id=$1 AND role_key='delegate' AND object_type='cpq_order' AND verb='create'",
          [a.tenant],
        );
        await assert.rejects(convert(primary.versionId, accepted.id), denied);
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,'delegate','cpq_order','create','CONFIDENTIAL',false,1)",
          [a.tenant],
        );
      },
    );
    await t.test(
      'direct SQL equivalent-capability foreign actors cannot insert accepted-source Orders',
      async () => {
        for (const actor of [foreignActor, b.identities.owner])
          await sqlRejected(
            actor,
            'INSERT INTO rpt.cpq_order(tenant_id,id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot) VALUES($1,$2,$3,$4,NULL,$5,$6)',
            [
              a.tenant,
              randomUUID(),
              primary.versionId,
              accepted.id,
              original.version.currency,
              original.version.output_snapshot,
            ],
            '42501',
          );
        await sqlRejected(
          advisor,
          'INSERT INTO rpt.cpq_order(tenant_id,id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot) VALUES($1,$2,$3,$4,NULL,$5,$6)',
          [
            a.tenant,
            randomUUID(),
            primary.versionId,
            accepted.id,
            original.version.currency,
            { ...original.version.output_snapshot, requiresApproval: false },
          ],
          '42501',
        );
      },
    );
    await t.test(
      'foreign workspace approval UUID remains denied with otherwise-equivalent capabilities',
      async () => {
        const workspace = randomUUID();
        await root!.query(
          "INSERT INTO rpt.crm_workspace(tenant_id,id,name,kind) VALUES($1,$2,'Other commercial workspace','commercial')",
          [a.tenant, workspace],
        );
        for (const [domain, verbs] of [
          ['cpq_quote', ['read', 'create', 'revise']],
          ['quote_approval', ['read', 'request']],
        ] as const)
          for (const verb of verbs)
            await root!.query(
              "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,$5,$6,'CONFIDENTIAL',1)",
              [a.tenant, randomUUID(), workspace, a.users.owner, domain, verb],
            );
        const target = await service.createQuote(owner, req(), 'workflow-foreign-workspace', {
          schemaVersion: 1,
          workspaceId: workspace,
          calculation: requiredCalculation,
        });
        const approval = await workflow.requestQuoteApproval(owner, req(), randomUUID(), {
          schemaVersion: 1,
          quoteVersionId: target.versionId,
          expectedVersion: 1,
          reason: 'Other workspace request',
        });
        await assert.rejects(workflow.getQuoteApproval(approver, req(), approval.id), denied);
        await assert.rejects(decide(target.versionId, approval.id), denied);
      },
    );
    await t.test(
      'approved authority remains historical after approver revocation, without granting new decisions',
      async () => {
        const target = await create('workflow-past-authority');
        const approval = await requestApproval(target.versionId);
        await decide(target.versionId, approval.id);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='quote_approval' AND verb='decide'",
          [a.tenant, a.users.ancestor],
        );
        await issue(target.id);
        assert.equal(
          (await workflow.getQuoteApproval(advisor, req(), approval.id)).status,
          'approved',
        );
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='quote_approval' AND verb='decide'",
          [a.tenant, a.users.ancestor],
        );
      },
    );
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
