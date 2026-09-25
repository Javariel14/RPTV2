import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError, type Identity } from '@rpt/contracts';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { seedTenant } from '../helpers/fixtures.js';
import { startPostgres } from '../helpers/postgres.js';
import type { Client } from 'pg';

void test('E3A1 tenant-local Product Master', async (t) => {
  const cluster = await startPostgres();
  let root: Client | undefined;
  try {
    const db = await cluster.migrate();
    root = db;
    const migration = await db.query<{ name: string }>(
      "SELECT name FROM public.foundation_migration WHERE name='20260924100000_e3a1_product_master.sql'",
    );
    assert.equal(migration.rows.length, 1);
    const a = await seedTenant(db, 'product-a');
    const b = await seedTenant(db, 'product-b');
    for (const fixture of [a, b]) {
      for (const verb of ['read', 'create', 'update']) {
        await db.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','product',$2,'CONFIDENTIAL',false,1)",
          [fixture.tenant, verb],
        );
        await db.query(
          `INSERT INTO authz.workspace_permission
          (tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
          VALUES($1,$2,$3,$4,'product',$5,'CONFIDENTIAL',1)`,
          [fixture.tenant, randomUUID(), fixture.workspace, fixture.users.owner, verb],
        );
      }
      for (const role of ['delegate', 'ancestor'])
        await db.query(
          "INSERT INTO authz.role_capability VALUES($1,$2,'product','read','CONFIDENTIAL',false,1)",
          [fixture.tenant, role],
        );
      for (const [source, authority] of [
        ['RPT_USER', 'manual'],
        ['HYCITE', 'official'],
      ])
        await db.query(
          `INSERT INTO authz.source_authority
          (tenant_id,user_id,source_system,domain_key,authority_level)
          VALUES($1,$2,$3,'product_master',$4)`,
          [fixture.tenant, fixture.users.owner, source, authority],
        );
    }
    const runtime = new PostgresDatabase(cluster.runtimeConfig());
    const service = new FoundationService(runtime);
    const create = async (
      stableKey: string,
      workspaceId = a.workspace,
      identity = a.identities.owner,
    ) =>
      service.createProduct(
        identity,
        randomUUID(),
        {
          schemaVersion: 1,
          workspaceId,
          stableKey,
          name: 'Synthetic same name',
          lifecycle: 'active',
        },
        `create-${stableKey}`,
      );
    const command = async (rootId: string, version: number, body: object, key: string) =>
      service.commandProduct(
        a.identities.owner,
        randomUUID(),
        rootId,
        { schemaVersion: 1, expectedVersion: version, command: body },
        key,
      );
    let ids!: { first: string; second: string; model: string; variant: string; version: number };
    await t.test(
      'identity tree, equal names, scoped codes, historical model and idempotency',
      async () => {
        const first = await create('product-one');
        const repeated = await create('product-one');
        assert.deepEqual(repeated, first);
        const second = await create('product-two');
        assert.notEqual(first.id, second.id);
        let version = first.version;
        const model = await command(
          first.id,
          version,
          {
            type: 'create_model',
            stableKey: 'generation-one',
            name: 'Historical model',
            lifecycle: 'discontinued',
          },
          'model-create-one',
        );
        version = model.version;
        const variant = await command(
          first.id,
          version,
          { type: 'create_variant', modelId: model.id, stableKey: 'size-ten', name: 'Size 10' },
          'variant-create-one',
        );
        version = variant.version;
        const code = await command(
          first.id,
          version,
          {
            type: 'assign_code',
            nodeId: variant.id,
            codeKind: 'sku',
            scope: { kind: 'market', key: 'ec' },
            code: 'SHARED',
          },
          'code-ec-one',
        );
        version = code.version;
        await assert.rejects(
          () =>
            command(
              first.id,
              version,
              {
                type: 'assign_code',
                nodeId: variant.id,
                codeKind: 'sku',
                scope: { kind: 'market', key: 'ec' },
                code: 'SHARED',
              },
              'code-ec-duplicate',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        const otherCode = await command(
          first.id,
          version,
          {
            type: 'assign_code',
            nodeId: variant.id,
            codeKind: 'sku',
            scope: { kind: 'market', key: 'mx' },
            code: 'SHARED',
          },
          'code-mx-one',
        );
        version = otherCode.version;
        const detail = await service.detailProduct(a.identities.owner, randomUUID(), first.id);
        assert.equal(detail?.nodes.length, 3);
        assert.equal(detail?.codes.length, 2);
        assert.equal(
          detail?.nodes.find((n: { id: string }) => n.id === model.id)?.lifecycle,
          'discontinued',
        );
        assert.equal(JSON.stringify(detail).includes('price'), false);
        await assert.rejects(
          () =>
            command(
              first.id,
              version - 1,
              { type: 'define_taxon', group: 'unit', slug: 'in', label: 'inch' },
              'stale-command-one',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'CONFLICT',
        );
        ids = { first: first.id, second: second.id, model: model.id, variant: variant.id, version };
      },
    );
    await t.test(
      'canonical groups bootstrap and tenant-scoped groups extend without schema changes',
      async () => {
        const expected = [
          'category',
          'subcategory',
          'family',
          'material',
          'technology',
          'function',
          'compatibility',
          'care',
          'status',
          'evidence',
          'unit',
        ];
        for (const fixture of [a, b]) {
          const groups = await db.query<{ slug: string }>(
            'SELECT slug FROM rpt.product_taxon_group WHERE tenant_id=$1 ORDER BY slug',
            [fixture.tenant],
          );
          assert.deepEqual(
            groups.rows.map((row) => row.slug),
            [...expected].sort(),
          );
        }
        await assert.rejects(
          () =>
            command(
              ids.first,
              ids.version,
              {
                type: 'define_taxon',
                group: 'unregistered',
                slug: 'one',
                label: 'One',
              },
              'unregistered-term-one',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        const group = await command(
          ids.first,
          ids.version,
          {
            type: 'define_group',
            slug: 'finish',
            label: 'Finish',
          },
          'define-finish-one',
        );
        ids.version = group.version;
        const term = await command(
          ids.first,
          ids.version,
          {
            type: 'define_taxon',
            group: 'finish',
            slug: 'matte',
            label: 'Matte',
          },
          'define-matte-one',
        );
        ids.version = term.version;
        const foreign = await create('product-b-only', b.workspace, b.identities.owner);
        await service.commandProduct(
          b.identities.owner,
          randomUUID(),
          foreign.id,
          {
            schemaVersion: 1,
            expectedVersion: foreign.version,
            command: { type: 'define_group', slug: 'private_b', label: 'Private B' },
          },
          'define-private-b',
        );
        await assert.rejects(
          () =>
            command(
              ids.first,
              ids.version,
              {
                type: 'define_taxon',
                group: 'private_b',
                slug: 'secret',
                label: 'Secret',
              },
              'foreign-group-one',
            ),
          (e: unknown) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
        );
        await assert.rejects(() =>
          command(
            ids.first,
            ids.version,
            {
              type: 'define_group',
              slug: 'Invalid Group',
              label: 'Invalid',
            },
            'invalid-group-one',
          ),
        );
      },
    );
    await t.test('typed facts, append-only evidence, pending, taxons and relations', async () => {
      let version = ids.version;
      const unit = await command(
        ids.first,
        version,
        { type: 'define_taxon', group: 'unit', slug: 'in', label: 'inch' },
        'unit-inch-one',
      );
      version = unit.version;
      const family = await command(
        ids.first,
        version,
        { type: 'define_taxon', group: 'family', slug: 'cookware', label: 'Cookware' },
        'family-one',
      );
      version = family.version;
      const assignment = await command(
        ids.first,
        version,
        { type: 'assign_taxon', nodeId: ids.first, group: 'family', slug: 'cookware' },
        'assign-family-one',
      );
      version = assignment.version;
      const observedAt = '2026-09-01T12:00:00Z';
      const base = {
        sourceSystem: 'HYCITE',
        sourceReference: 'fixture://synthetic-primary',
        observedAt,
        authorityLevel: 'official',
        scope: { kind: 'market', key: 'ec' },
      };
      const fact = await command(
        ids.first,
        version,
        {
          type: 'record_fact',
          fact: {
            nodeId: ids.variant,
            factKind: 'dimension',
            valueKind: 'decimal',
            valueDecimal: '10.250000',
            unitSlug: 'in',
            evidence: {
              observation: { ...base, externalId: 'measurement-one' },
              evidenceLevel: 'exact_primary',
              sourceLiteral: '10 1/4 in',
            },
          },
        },
        'fact-dimension-one',
      );
      version = fact.version;
      const pending = await command(
        ids.first,
        version,
        {
          type: 'record_fact',
          fact: {
            nodeId: ids.model,
            factKind: 'construction',
            valueKind: 'text',
            evidence: {
              observation: { ...base, externalId: 'layers-pending' },
              evidenceLevel: 'pending',
              sourceLiteral: 'layers not established',
            },
          },
        },
        'fact-pending-one',
      );
      version = pending.version;
      const correction = await command(
        ids.first,
        version,
        {
          type: 'record_fact',
          fact: {
            nodeId: ids.variant,
            factKind: 'dimension',
            valueKind: 'decimal',
            valueDecimal: '10.500000',
            unitSlug: 'in',
            previousFactId: fact.id,
            evidence: {
              observation: { ...base, externalId: 'measurement-correction' },
              evidenceLevel: 'exact_primary',
              sourceLiteral: '10 1/2 in',
            },
          },
        },
        'fact-correction-one',
      );
      version = correction.version;
      const relation = await command(
        ids.first,
        version,
        {
          type: 'relate',
          fromNodeId: ids.first,
          toNodeId: ids.second,
          relationKind: 'contains',
          evidence: {
            observation: { ...base, externalId: 'set-contains-one' },
            evidenceLevel: 'exact_primary',
            sourceLiteral: 'set includes item',
          },
        },
        'relation-one',
      );
      version = relation.version;
      assert.deepEqual(
        await command(
          ids.first,
          version - 1,
          {
            type: 'relate',
            fromNodeId: ids.first,
            toNodeId: ids.second,
            relationKind: 'contains',
            evidence: {
              observation: { ...base, externalId: 'set-contains-one' },
              evidenceLevel: 'exact_primary',
              sourceLiteral: 'set includes item',
            },
          },
          'relation-one',
        ),
        relation,
      );
      const detail = await service.detailProduct(a.identities.owner, randomUUID(), ids.first);
      assert.equal(detail?.taxonomy.length, 1);
      assert.equal(detail?.facts.length, 3);
      assert.equal(
        detail?.facts.find((f: { id: string }) => f.id === fact.id)?.valueDecimal,
        '10.250000',
      );
      assert.equal(
        detail?.facts.find((f: { id: string }) => f.id === fact.id)?.sourceLiteral,
        '10 1/4 in',
      );
      assert.equal(
        detail?.facts.find((f: { id: string }) => f.id === correction.id)?.previousFactId,
        fact.id,
      );
      assert.equal(
        detail?.facts.find((f: { id: string }) => f.id === fact.id)?.sourceScopeKey,
        'ec',
      );
      assert.equal(detail?.facts.find((f: { id: string }) => f.id === pending.id)?.valueText, null);
      assert.equal(detail?.relations.length, 1);
      const count = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='product_master'",
      );
      assert.equal(count.rows[0]?.n, '4');
      const audit = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM rpt.audit_event WHERE object_type IN ('product_node','product_fact','product_relation')",
      );
      assert.ok(Number(audit.rows[0]?.n) >= 3);
      await assert.rejects(
        () =>
          command(
            ids.first,
            version,
            {
              type: 'relate',
              fromNodeId: ids.first,
              toNodeId: ids.first,
              relationKind: 'contains',
              evidence: {
                observation: { ...base, externalId: 'invalid-self-relation' },
                evidenceLevel: 'exact_primary',
                sourceLiteral: 'self',
              },
            },
            'invalid-relation-one',
          ),
        (e: unknown) => e instanceof FoundationError && e.code === 'INVALID_REQUEST',
      );
      await db.query(
        `UPDATE authz.source_authority SET revoked_at=clock_timestamp()
        WHERE tenant_id=$1 AND user_id=$2 AND source_system='HYCITE'
        AND domain_key='product_master'`,
        [a.tenant, a.users.owner],
      );
      await assert.rejects(
        () =>
          command(
            ids.first,
            version,
            {
              type: 'record_fact',
              fact: {
                nodeId: ids.variant,
                factKind: 'dimension',
                valueKind: 'decimal',
                valueDecimal: '11.000000',
                unitSlug: 'in',
                evidence: {
                  observation: { ...base, externalId: 'after-source-revocation' },
                  evidenceLevel: 'exact_primary',
                  sourceLiteral: '11 in',
                },
              },
            },
            'revoked-source-one',
          ),
        (e: unknown) => e instanceof FoundationError && e.code === 'FORBIDDEN',
      );
    });
    await t.test('tenant, BOLA, Network, revocation and RLS fail closed', async () => {
      await db.query(
        "INSERT INTO authz.role_capability VALUES($1,'admin','trust','approve','OFFICIAL_COMPENSATION',false,1)",
        [a.tenant],
      );
      for (const domain of ['product_master', 'legacy-test'])
        for (const actorId of [a.users.ai, a.users.outsider])
          await db.query(
            `INSERT INTO authz.source_authority
          (tenant_id,user_id,source_system,domain_key,authority_level)
          VALUES($1,$2,'RPT_USER',$3,'manual')`,
            [a.tenant, actorId, domain],
          );
      const trustRights = await runtime.request(a.identities.ai, randomUUID(), (client) =>
        client.query<{ trust: boolean; product: boolean; productObject: boolean }>(
          `SELECT authz.tenant_allowed($1,'trust','approve','OFFICIAL_COMPENSATION') AS trust,
          authz.tenant_allowed($1,'product','read','CONFIDENTIAL') AS product,
          authz.product_allowed($2,'update') AS "productObject"`,
          [a.tenant, ids.first],
        ),
      );
      assert.equal(trustRights.rows[0]?.trust, true);
      assert.equal(trustRights.rows[0]?.product, false);
      assert.equal(trustRights.rows[0]?.productObject, false);
      const sourcePolicies = await db.query<{ policyname: string; cmd: string }>(
        "SELECT policyname,cmd FROM pg_policies WHERE schemaname='rpt' AND tablename='source_observation'",
      );
      assert.equal(
        sourcePolicies.rows.some((row) =>
          ['trust_write', 'trust_insert', 'trust_update'].includes(row.policyname),
        ),
        false,
      );
      assert.equal(
        sourcePolicies.rows.some((row) => row.policyname === 'trust_legacy_approve_read'),
        false,
      );
      const trustOnlyCount = await runtime.request(a.identities.ai, randomUUID(), async (client) =>
        client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='product_master'",
        ),
      );
      assert.equal(trustOnlyCount.rows[0]?.n, '0');
      const ownerEvidence = await runtime.request(a.identities.owner, randomUUID(), (client) =>
        client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='product_master'",
        ),
      );
      assert.equal(ownerEvidence.rows[0]?.n, '4');
      const foreignEvidence = await runtime.request(b.identities.owner, randomUUID(), (client) =>
        client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='product_master' AND tenant_id=$1",
          [a.tenant],
        ),
      );
      assert.equal(foreignEvidence.rows[0]?.n, '0');
      const insertObservation = (
        identity: Identity,
        actorId: string,
        domain: string,
        subjectId: string,
      ) =>
        runtime.request(identity, randomUUID(), async (client) => {
          await client.query('SAVEPOINT policy_probe');
          try {
            await client.query(
              `INSERT INTO rpt.source_observation
            (tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,
             observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
            VALUES($1,$2,'RPT_USER',$3,$4,$5,'fixture://trust-policy',
             '2026-09-01T12:00:00Z','2026-09-01T12:00:00Z','manual',$6,$7,'matched',$8,'{}')`,
              [
                a.tenant,
                randomUUID(),
                domain,
                subjectId,
                randomUUID(),
                '0'.repeat(64),
                randomUUID(),
                actorId,
              ],
            );
            return 'INSERTED';
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT policy_probe');
            return (error as { code?: string }).code;
          }
        });
      assert.equal(
        await insertObservation(a.identities.ai, a.users.ai, 'product_master', ids.first),
        '42501',
      );
      assert.equal(
        await insertObservation(a.identities.ai, a.users.ai, 'legacy-test', randomUUID()),
        'INSERTED',
      );
      const legacyVisible = await runtime.request(a.identities.ai, randomUUID(), (client) =>
        client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='legacy-test'",
        ),
      );
      assert.equal(legacyVisible.rows[0]?.n, '1');
      const approveOnly = await runtime.request(a.identities.outsider, randomUUID(), (client) =>
        client.query<{
          approve: boolean;
          read: boolean;
          productRead: boolean;
          productUpdate: boolean;
          legacyCount: string;
          productCount: string;
        }>(
          `SELECT authz.tenant_allowed($1,'trust','approve','OFFICIAL_COMPENSATION') AS approve,
          authz.tenant_allowed($1,'trust','read','OFFICIAL_COMPENSATION') AS read,
          authz.tenant_allowed($1,'product','read','CONFIDENTIAL') AS "productRead",
          authz.product_allowed($2,'update') AS "productUpdate",
          (SELECT count(*)::text FROM rpt.source_observation WHERE domain_key='legacy-test') AS "legacyCount",
          (SELECT count(*)::text FROM rpt.source_observation WHERE domain_key='product_master') AS "productCount"`,
          [a.tenant, ids.first],
        ),
      );
      assert.deepEqual(approveOnly.rows[0], {
        approve: true,
        read: false,
        productRead: false,
        productUpdate: false,
        legacyCount: '0',
        productCount: '0',
      });
      assert.equal(
        await insertObservation(
          a.identities.outsider,
          a.users.outsider,
          'legacy-test',
          randomUUID(),
        ),
        'INSERTED',
      );
      assert.equal(
        await insertObservation(
          a.identities.outsider,
          a.users.outsider,
          'product_master',
          ids.first,
        ),
        '42501',
      );
      const legacyAfterApproveInsert = await runtime.request(
        a.identities.ai,
        randomUUID(),
        (client) =>
          client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='legacy-test'",
          ),
      );
      assert.equal(legacyAfterApproveInsert.rows[0]?.n, '2');
      const approveStillCannotRead = await runtime.request(
        a.identities.outsider,
        randomUUID(),
        (client) =>
          client.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='legacy-test'",
          ),
      );
      assert.equal(approveStillCannotRead.rows[0]?.n, '0');
      const foreignLegacy = await runtime.request(b.identities.owner, randomUUID(), (client) =>
        client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM rpt.source_observation WHERE domain_key='legacy-test' AND tenant_id=$1",
          [a.tenant],
        ),
      );
      assert.equal(foreignLegacy.rows[0]?.n, '0');
      await assert.rejects(
        () => service.detailProduct(b.identities.owner, randomUUID(), ids.first),
        (e: unknown) => e instanceof FoundationError && e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () =>
          service.commandProduct(
            b.identities.owner,
            randomUUID(),
            ids.first,
            {
              schemaVersion: 1,
              expectedVersion: ids.version,
              command: { type: 'define_taxon', group: 'unit', slug: 'kg', label: 'kilogram' },
            },
            'foreign-product-one',
          ),
        (e: unknown) => e instanceof FoundationError && e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () => service.detailProduct(a.identities.ancestor, randomUUID(), ids.first),
        (e: unknown) => e instanceof FoundationError && e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () =>
          service.commandProduct(
            a.identities.delegate,
            randomUUID(),
            ids.first,
            {
              schemaVersion: 1,
              expectedVersion: ids.version,
              command: { type: 'define_taxon', group: 'unit', slug: 'cm', label: 'centimeter' },
            },
            'delegate-command-one',
          ),
        (e: unknown) => e instanceof FoundationError && e.code === 'FORBIDDEN',
      );
      await db.query(
        "UPDATE authz.role_assignment SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND role_key='owner'",
        [a.tenant, a.users.owner],
      );
      await assert.rejects(
        () => service.detailProduct(a.identities.owner, randomUUID(), ids.first),
        (e: unknown) => e instanceof FoundationError && e.code === 'FORBIDDEN',
      );
      const rls = await db.query<{
        relname: string;
        relrowsecurity: boolean;
      }>(`SELECT relname,relrowsecurity
        FROM pg_class WHERE oid IN ('rpt.product_node'::regclass,'rpt.product_taxon_group'::regclass,
        'rpt.product_taxon'::regclass,
        'rpt.product_taxon_assignment'::regclass,'rpt.product_code'::regclass,
        'rpt.product_fact'::regclass,'rpt.product_relation'::regclass)`);
      assert.equal(rls.rows.length, 7);
      assert.ok(rls.rows.every((row) => row.relrowsecurity));
    });
  } catch (error) {
    console.error('E3A1 focused integration failure:', error);
    throw error;
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
