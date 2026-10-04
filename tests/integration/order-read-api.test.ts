import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { FoundationError, type Identity } from '@rpt/contracts';
import { OrderReadService } from '@rpt/application';
import { createApi } from '../../apps/api/src/app.js';
import { startPostgres } from '../helpers/postgres.js';
import { orderCommercialFixture, lifecycleRequest as req } from '../helpers/order-commercial.js';

const pgCode = (code: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

void test('E3C2 canonical Order identity and read API', { timeout: 300_000 }, async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    const f = await orderCommercialFixture(root, cluster.runtimeConfig());
    const foreign = await orderCommercialFixture(
      root,
      cluster.runtimeConfig(),
      'order-read-foreign',
    );
    const reads = new OrderReadService(f.db);
    let currentIdentity: Identity = f.a.identities.delegate;
    const api = createApi(f.foundation, { verify: async () => currentIdentity }, undefined, reads);
    const headers = { Authorization: 'Bearer synthetic' };
    const own = await f.create(false, f.a.person, f.a.workspace, true);
    const foreignOne = await foreign.create();
    // Root-only fixture setup creates a foreign number not present in the local namespace.
    await root.query(
      `SELECT setval(format('authz.order_number_%s',replace(allocator_id::text,'-',''))::regclass,49,true)
 FROM authz.order_number_counter WHERE tenant_id=$1`,
      [foreign.a.tenant],
    );
    const foreignTwo = await foreign.create();
    let tiedOrders: Awaited<ReturnType<typeof f.create>>[] = [];

    await t.test(
      'tenant namespaces are independent and replay preserves the assigned number',
      async () => {
        assert.equal(own.businessOrderNumber, 'ORD-0000000001');
        assert.equal(foreignOne.businessOrderNumber, 'ORD-0000000001');
        assert.equal(foreignTwo.businessOrderNumber, 'ORD-0000000050');
        assert.deepEqual(
          await f.workflow.createOrderFromAcceptedQuote(own.actor, req(), own.key, own.input),
          { id: own.id, businessOrderNumber: own.businessOrderNumber! },
        );
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.cpq_order WHERE quote_version_id=$1',
              [own.versionId],
            )
          ).rows[0].n,
          1,
        );
      },
    );

    await t.test(
      'first allocation rollback is not reused and new-tenant first Orders serialize',
      async () => {
        const rollbackTenant = await orderCommercialFixture(
          root!,
          cluster.runtimeConfig(),
          'order-read-first-rollback',
        );
        const allocatorId = (
          await root!.query<{ allocator_id: string }>(
            'SELECT allocator_id::text FROM authz.order_number_counter WHERE tenant_id=$1',
            [rollbackTenant.a.tenant],
          )
        ).rows[0]!.allocator_id;
        const sequence = `authz.order_number_${allocatorId.replaceAll('-', '')}`;
        await root!.query('BEGIN');
        try {
          assert.equal(
            (
              await root!.query<{ value: string }>('SELECT nextval($1::regclass)::text AS value', [
                sequence,
              ])
            ).rows[0]!.value,
            '1',
          );
        } finally {
          await root!.query('ROLLBACK');
        }
        assert.equal((await rollbackTenant.create()).businessOrderNumber, 'ORD-0000000002');

        const concurrentTenant = await orderCommercialFixture(
          root!,
          cluster.runtimeConfig(),
          'order-read-first-concurrent',
        );
        assert.deepEqual(
          (await Promise.all([concurrentTenant.create(), concurrentTenant.create()]))
            .map((order) => order.businessOrderNumber)
            .sort(),
          ['ORD-0000000001', 'ORD-0000000002'],
        );
      },
    );

    await t.test(
      'create-only authority returns and replays the canonical number without granting read',
      async () => {
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
          [f.a.tenant, f.a.users.delegate],
        );
        try {
          const created = await f.create();
          assert.match(created.businessOrderNumber ?? '', /^ORD-[0-9]{10}$/);
          assert.deepEqual(
            (
              await root!.query(
                `SELECT response FROM authz.idempotency_receipt
 WHERE tenant_id=$1 AND operation='quote_workflow.order' AND key=$2`,
                [f.a.tenant, created.key],
              )
            ).rows[0].response,
            { id: created.id, businessOrderNumber: created.businessOrderNumber },
          );
          const beforeReplay = (
            await root!.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM rpt.cpq_order WHERE tenant_id=$1',
              [f.a.tenant],
            )
          ).rows[0]!.count;
          assert.deepEqual(
            await f.workflow.createOrderFromAcceptedQuote(
              created.actor,
              req(),
              created.key,
              created.input,
            ),
            { id: created.id, businessOrderNumber: created.businessOrderNumber },
          );
          assert.equal(
            (
              await root!.query<{ count: number }>(
                'SELECT count(*)::integer AS count FROM rpt.cpq_order WHERE tenant_id=$1',
                [f.a.tenant],
              )
            ).rows[0]!.count,
            beforeReplay,
          );
          await assert.rejects(
            f.workflow.createOrderFromAcceptedQuote(created.actor, req(), created.key, {
              ...created.input,
              expectedVersion: 2,
            }),
            (error: unknown) => error instanceof FoundationError && error.code === 'CONFLICT',
          );
          assert.equal(
            (
              await root!.query(
                'SELECT count(*)::integer AS n FROM rpt.cpq_order WHERE quote_version_id=$1',
                [created.versionId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal((await api.request(`/v1/orders/${created.id}`, { headers })).status, 404);
        } finally {
          await root!.query(
            "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
            [f.a.tenant, f.a.users.delegate],
          );
        }
      },
    );

    await t.test(
      'same-tenant concurrent creation serializes to distinct immutable numbers',
      async () => {
        const created = await Promise.all([f.create(), f.create()]);
        tiedOrders = created;
        assert.equal(new Set(created.map((order) => order.businessOrderNumber)).size, 2);
        for (const order of created)
          assert.match(order.businessOrderNumber ?? '', /^ORD-[0-9]{10}$/);
        await f.db.request(f.a.identities.delegate, req(), async (client) => {
          const row = (
            await client.query(
              'SELECT tenant_id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot FROM rpt.cpq_order WHERE id=$1',
              [own.id],
            )
          ).rows[0];
          await client.query('SAVEPOINT failed_after_allocation');
          await assert.rejects(
            client.query(
              `INSERT INTO rpt.cpq_order(tenant_id,id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                row.tenant_id,
                randomUUID(),
                row.quote_version_id,
                row.acceptance_id,
                row.person_id,
                row.currency,
                row.commercial_snapshot,
              ],
            ),
            pgCode('23505'),
          );
          await client.query('ROLLBACK TO SAVEPOINT failed_after_allocation');
        });
        const afterFailure = await f.create();
        assert.equal(afterFailure.businessOrderNumber, 'ORD-0000000006');
        await assert.rejects(
          root!.query(
            "UPDATE rpt.cpq_order SET business_order_number='ORD-9999999999' WHERE id=$1",
            [own.id],
          ),
          pgCode('42501'),
        );
      },
    );

    await t.test(
      'allocator and caller-selected numbers are protected from direct SQL',
      async () => {
        await f.db.request(f.a.identities.delegate, req(), async (client) => {
          const denied = async (name: string, sql: string) => {
            await client.query(`SAVEPOINT ${name}`);
            await assert.rejects(client.query(sql), pgCode('42501'));
            await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          };
          await denied('counter_read', 'SELECT * FROM authz.order_number_counter');
          await denied(
            'counter_write',
            "UPDATE authz.order_number_counter SET allocator_id='00000000-0000-0000-0000-000000000000'::uuid",
          );
          const allocatorId = (
            await root!.query<{ allocator_id: string }>(
              'SELECT allocator_id::text FROM authz.order_number_counter WHERE tenant_id=$1',
              [f.a.tenant],
            )
          ).rows[0]!.allocator_id;
          const sequenceName = `order_number_${allocatorId.replaceAll('-', '')}`;
          await client.query('SAVEPOINT sequence_advance');
          await assert.rejects(
            client.query('SELECT nextval($1::regclass)', [`authz.${sequenceName}`]),
            pgCode('42501'),
          );
          await client.query('ROLLBACK TO SAVEPOINT sequence_advance');
          const row = (
            await client.query(
              'SELECT tenant_id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot FROM rpt.cpq_order WHERE id=$1',
              [own.id],
            )
          ).rows[0];
          await client.query('SAVEPOINT chosen_number');
          await assert.rejects(
            client.query(
              `INSERT INTO rpt.cpq_order(tenant_id,id,quote_version_id,acceptance_id,person_id,currency,commercial_snapshot,business_order_number)
 VALUES($1,$2,$3,$4,$5,$6,$7,'ORD-9999999999')`,
              [
                row.tenant_id,
                randomUUID(),
                row.quote_version_id,
                row.acceptance_id,
                row.person_id,
                row.currency,
                row.commercial_snapshot,
              ],
            ),
            pgCode('42501'),
          );
          await client.query('ROLLBACK TO SAVEPOINT chosen_number');
        });
      },
    );

    await t.test(
      'detail is a validated immutable snapshot without source or database internals',
      async () => {
        const before = (
          await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
            own.id,
          ])
        ).rows[0].value;
        const response = await api.request(`/v1/orders/${own.id}`, { headers });
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          schemaVersion: number;
          data: Record<string, unknown> & { lines: unknown[] };
        };
        assert.equal(body.schemaVersion, 1);
        assert.equal(body.data.businessOrderNumber, own.businessOrderNumber);
        assert.ok(body.data.lines.length > 0);
        const serialized = JSON.stringify(body);
        for (const forbidden of [
          'tenant_id',
          'business_order_number',
          'sourceReference',
          'externalId',
          'source_authority',
          'calculation_attestation',
        ])
          assert.equal(serialized.includes(forbidden), false);
        assert.deepEqual(
          (
            await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
              own.id,
            ])
          ).rows[0].value,
          before,
        );
      },
    );

    await t.test('list uses stable opaque keysets and exact authorized filters', async () => {
      await root!.query('ALTER TABLE rpt.cpq_order DISABLE TRIGGER immutable_history');
      await root!.query(
        "UPDATE rpt.cpq_order SET created_at='2030-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])",
        [tiedOrders.map((order) => order.id)],
      );
      await root!.query('ALTER TABLE rpt.cpq_order ENABLE TRIGGER immutable_history');
      const first = await api.request('/v1/orders?limit=1', { headers });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        data: { items: { id: string }[]; nextCursor: string | null };
      };
      assert.equal(firstBody.data.items.length, 1);
      assert.ok(firstBody.data.nextCursor);
      const second = await api.request(
        `/v1/orders?limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor!)}`,
        { headers },
      );
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { data: { items: { id: string }[] } };
      assert.notEqual(secondBody.data.items[0]?.id, firstBody.data.items[0]?.id);
      assert.deepEqual(
        [firstBody.data.items[0]?.id, secondBody.data.items[0]?.id].sort(),
        tiedOrders.map((order) => order.id).sort(),
      );
      const exact = await api.request(
        `/v1/orders?businessOrderNumber=${own.businessOrderNumber!}`,
        { headers },
      );
      assert.equal(((await exact.json()) as { data: { items: unknown[] } }).data.items.length, 1);
      for (const filter of [`workspaceId=${randomUUID()}`, `marketId=${f.co.marketId}`]) {
        const response = await api.request(`/v1/orders?${filter}`, { headers });
        assert.equal(response.status, 200);
        assert.equal(
          ((await response.json()) as { data: { items: unknown[] } }).data.items.length,
          0,
        );
      }
    });

    await t.test(
      'foreign UUID and number are non-enumerable and revoked access is immediate',
      async () => {
        const hidden = await api.request(`/v1/orders/${foreignOne.id}`, { headers });
        const absent = await api.request(`/v1/orders/${randomUUID()}`, { headers });
        assert.equal(hidden.status, 404);
        assert.equal(absent.status, 404);
        const publicError = (value: unknown) => {
          const body = value as { error: { code: string; retryable: boolean } };
          return { code: body.error.code, retryable: body.error.retryable };
        };
        assert.deepEqual(publicError(await hidden.json()), publicError(await absent.json()));

        const foreignNumber = await api.request(
          `/v1/orders?businessOrderNumber=${foreignTwo.businessOrderNumber!}`,
          { headers },
        );
        const unknownNumber = await api.request('/v1/orders?businessOrderNumber=ORD-9999999999', {
          headers,
        });
        assert.deepEqual(await foreignNumber.json(), await unknownNumber.json());

        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
          [f.a.tenant, f.a.users.delegate],
        );
        assert.equal((await api.request(`/v1/orders/${own.id}`, { headers })).status, 404);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='read'",
          [f.a.tenant, f.a.users.delegate],
        );
        assert.equal((await api.request(`/v1/orders/${own.id}`, { headers })).status, 200);
      },
    );

    await t.test(
      'market scope and missing capability remain additive authorization boundaries',
      async () => {
        const hiddenMarket = await f.create(true);
        assert.equal((await api.request(`/v1/orders/${hiddenMarket.id}`, { headers })).status, 404);
        currentIdentity = f.a.identities.outsider;
        assert.equal((await api.request(`/v1/orders/${own.id}`, { headers })).status, 404);
        currentIdentity = f.a.identities.delegate;
      },
    );

    await t.test(
      'history is bounded and inaccessible history shares not-found semantics',
      async () => {
        await f.lifecycle.cancelOrder(own.actor, req(), randomUUID(), {
          schemaVersion: 1,
          orderId: own.id,
          expectedVersion: 1,
          reason: 'E3C2 bounded history fixture',
        });
        const first = await api.request(`/v1/orders/${own.id}/history?limit=1`, { headers });
        const page = (await first.json()) as {
          data: { items: { sequence: number }[]; nextCursor: string | null };
        };
        assert.equal(page.data.items.length, 1);
        assert.ok(page.data.nextCursor);
        const next = await api.request(
          `/v1/orders/${own.id}/history?limit=1&cursor=${encodeURIComponent(page.data.nextCursor!)}`,
          { headers },
        );
        assert.equal(
          ((await next.json()) as { data: { items: { sequence: number }[] } }).data.items[0]
            ?.sequence,
          2,
        );
        const hidden = await api.request(`/v1/orders/${foreignOne.id}/history`, { headers });
        const absent = await api.request(`/v1/orders/${randomUUID()}/history`, { headers });
        assert.equal(hidden.status, 404);
        assert.equal(absent.status, 404);
        const hiddenBody = (await hidden.json()) as { error: { code: string; retryable: boolean } };
        const absentBody = (await absent.json()) as { error: { code: string; retryable: boolean } };
        assert.deepEqual(
          { code: hiddenBody.error.code, retryable: hiddenBody.error.retryable },
          { code: absentBody.error.code, retryable: absentBody.error.retryable },
        );
      },
    );

    await t.test('HTTP validation and authentication fail safely', async () => {
      assert.equal((await api.request('/v1/orders')).status, 401);
      const encoded = (value: unknown) =>
        Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
          'base64url',
        );
      for (const url of [
        '/v1/orders/not-a-uuid',
        '/v1/orders?unknown=true',
        '/v1/orders?limit=0',
        '/v1/orders?limit=101',
        '/v1/orders?status=paid',
        '/v1/orders?businessOrderNumber=ORD-1',
        '/v1/orders?cursor=A',
        '/v1/orders?cursor=AAAAA',
        '/v1/orders?cursor=%25%25%25',
        `/v1/orders?cursor=${encoded('not-json')}`,
        `/v1/orders?cursor=${encoded({})}`,
        `/v1/orders?cursor=${encoded({ schemaVersion: 2, kind: 'orders', createdAt: '2030-01-01T00:00:00.000Z', id: randomUUID() })}`,
        `/v1/orders?cursor=${encoded({ schemaVersion: 1, kind: 'orders', createdAt: '2030-01-01T00:00:00.000Z', id: randomUUID(), workspaceId: randomUUID() })}`,
        '/v1/orders?cursor=not-a-valid-cursor',
        `/v1/orders/${own.id}/history?cursor=not-a-valid-cursor`,
      ]) {
        const response = await api.request(url, { headers });
        assert.equal(response.status, 422, url);
        const value = (await response.json()) as {
          error: { code: string; retryable: boolean };
        };
        assert.deepEqual(
          { code: value.error.code, retryable: value.error.retryable },
          { code: 'INVALID_REQUEST', retryable: false },
          url,
        );
        const body = JSON.stringify(value);
        for (const forbidden of ['SQLSTATE', 'constraint', 'stack', 'policy'])
          assert.equal(body.includes(forbidden), false);
      }
    });

    await t.test(
      'allocator catalogs expose only opaque aggregate objects and no runtime state or mapping',
      async () => {
        assert.equal(
          (await root!.query('SELECT count(*)::integer AS n FROM public.foundation_migration'))
            .rows[0].n,
          20,
        );
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM information_schema.role_table_grants WHERE table_schema='authz' AND table_name='order_number_counter' AND grantee='rpt_runtime'",
            )
          ).rows[0].n,
          0,
        );
        const structures = (
          await root!.query<{ max_value: string; cycle: boolean }>(
            `SELECT max_value::text,cycle FROM pg_catalog.pg_sequences
 WHERE schemaname='authz' AND sequencename LIKE 'order_number_%'`,
          )
        ).rows;
        assert.ok(structures.length >= 4);
        assert.ok(structures.every((row) => row.max_value === '9999999999' && !row.cycle));
        const tenantIds = (
          await root!.query<{ id: string }>('SELECT id::text FROM authz.tenant')
        ).rows.map((row) => row.id.replaceAll('-', ''));
        await f.db.request(f.a.identities.delegate, req(), async (client) => {
          const classes = (
            await client.query<{ relname: string }>(
              `SELECT c.relname FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='authz' AND c.relkind='S' AND c.relname LIKE 'order_number_%'`,
            )
          ).rows;
          assert.ok(classes.length >= 2);
          for (const row of classes) {
            assert.match(row.relname, /^order_number_[0-9a-f]{32}$/);
            for (const tenantId of tenantIds) assert.equal(row.relname.includes(tenantId), false);
          }
          const sequences = (
            await client.query<{ sequencename: string; last_value: string | null }>(
              `SELECT sequencename,last_value::text FROM pg_catalog.pg_sequences
 WHERE schemaname='authz' AND sequencename LIKE 'order_number_%'`,
            )
          ).rows;
          assert.deepEqual(
            sequences.map((row) => row.sequencename).sort(),
            classes.map((row) => row.relname).sort(),
          );
          assert.ok(sequences.every((row) => row.last_value === null));
          assert.deepEqual(
            (
              await client.query(
                `SELECT sequence_name FROM information_schema.sequences
 WHERE sequence_schema='authz' AND sequence_name LIKE 'order_number_%'`,
              )
            ).rows,
            [],
          );
        });
      },
    );

    await assert.rejects(
      reads.detail(f.a.identities.outsider, req(), own.id),
      (error: unknown) => error instanceof FoundationError && error.code === 'NOT_FOUND',
    );
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
