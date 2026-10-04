import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { OrderReconciliationError } from '@rpt/contracts';
import { OrderReconciliationService } from '@rpt/application';
import { startPostgres } from '../helpers/postgres.js';
import { orderCommercialFixture, lifecycleRequest as req } from '../helpers/order-commercial.js';

void test('E3C1 PostgreSQL Order reconciliation is scoped, typed, append-only and snapshot-safe', async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    assert.equal(
      (await root.query('SELECT count(*)::integer AS n FROM public.foundation_migration')).rows[0]
        ?.n,
      20,
    );
    const f = await orderCommercialFixture(root, cluster.runtimeConfig());
    const svc = new OrderReconciliationService(f.db);
    for (const [tenant, user, role, workspace] of [
      [f.a.tenant, f.a.users.delegate, 'delegate', f.a.workspace],
      [f.a.tenant, f.a.users.owner, 'owner', f.a.workspace],
      [f.b.tenant, f.b.users.delegate, 'delegate', f.b.workspace],
      [f.b.tenant, f.b.users.owner, 'owner', f.b.workspace],
    ] as const) {
      if (role === 'owner')
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,$2,'order_reconciliation','identity_registry','CONFIDENTIAL',false,1) ON CONFLICT DO NOTHING",
          [tenant, role],
        );
      for (const verb of ['ingest', 'read', 'correlate', 'resolve']) {
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,$2,'order_reconciliation',$3,'CONFIDENTIAL',false,1) ON CONFLICT DO NOTHING",
          [tenant, role, verb],
        );
        await root.query(
          "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,'order_reconciliation',$5,'CONFIDENTIAL',1)",
          [tenant, randomUUID(), workspace, user, verb],
        );
      }
      await root.query(
        "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API','order_reconciliation','verified')",
        [tenant, user],
      );
    }
    const actor = f.a.identities.owner;
    const envelope = (
      externalId: string,
      body: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      schemaVersion: 1,
      workspaceId: f.a.workspace,
      marketId: f.ec.marketId,
      sourceSystem: 'API',
      externalId,
      sourceReference: 'test://provider/order',
      observedAt: '2026-09-29T10:00:00Z',
      effectiveAt: '2026-09-29T09:00:00Z',
      rawHash: createHash('sha256').update(body).digest('hex'),
      correlationId: randomUUID(),
      authorityLevel: 'verified',
      ...overrides,
    });
    const input = envelope('external-order-1', 'first');
    const key = randomUUID();
    const ingest = (v: unknown, k = randomUUID()) =>
      svc.ingestExternalOrderObservation(actor, req(), k, v) as Promise<{
        intakeId: string;
        status: string;
        version: number;
        duplicate: boolean;
      }>;
    let first!: Awaited<ReturnType<typeof ingest>>;
    await t.test(
      'absent official source policy retains untrusted intake without official promotion',
      async () => {
        const pending = (await ingest(
          envelope('no-official-policy', 'untrusted', {
            sourceSystem: 'HYCITE',
            authorityLevel: 'official',
          }),
        )) as typeof first & { sourceAuthorized: boolean };
        assert.equal(pending.status, 'pending_review');
        assert.equal(pending.version, 0);
        assert.equal(pending.sourceAuthorized, false);
        assert.equal(
          (
            await root!.query(
              'SELECT authority_verified_at FROM rpt.order_external_intake WHERE id=$1',
              [pending.intakeId],
            )
          ).rows[0]?.authority_verified_at,
          null,
        );
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.source_observation WHERE domain_key='order_reconciliation'",
            )
          ).rows[0]?.n,
          0,
        );
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.order_reconciliation_state WHERE source_system='HYCITE' AND external_id='no-official-policy'",
            )
          ).rows[0]?.n,
          0,
        );
      },
    );
    await t.test('database rejects non-finite timestamps and whitespace external IDs', async () => {
      await f.db.request(actor, req(), async (c) => {
        for (const [externalId, observedAt] of [
          ['bad-date', 'infinity'],
          ['\u00a0', input.observedAt],
        ]) {
          await c.query('SAVEPOINT bad_external');
          await assert.rejects(
            c.query('SELECT authz.ingest_external_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
              f.a.workspace,
              f.ec.marketId,
              'API',
              externalId,
              input.sourceReference,
              observedAt,
              input.effectiveAt,
              input.rawHash,
              randomUUID(),
              'verified',
              randomUUID(),
            ]),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
          await c.query('ROLLBACK TO SAVEPOINT bad_external');
        }
      });
    });
    await t.test(
      'unmatched intake does not invent a canonical Order or typed observation',
      async () => {
        first = await ingest(input, key);
        assert.equal(first.status, 'unmatched');
        assert.equal(first.version, 1);
        assert.equal(
          (await root!.query('SELECT count(*)::integer AS n FROM rpt.order_external_binding'))
            .rows[0]?.n,
          0,
        );
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.source_observation WHERE domain_key='order_reconciliation'",
            )
          ).rows[0]?.n,
          0,
        );
        assert.equal((await ingest(input, key)).intakeId, first.intakeId);
        assert.equal((await ingest(input)).duplicate, true);
        await assert.rejects(
          ingest({ ...input, rawHash: 'b'.repeat(64) }, key),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'CONFLICT',
        );
      },
    );
    const order = await f.create();
    const before = (
      await root.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [order.id])
    ).rows[0]?.value;
    await t.test('untrusted official claim cannot bind to the accepted Order', async () => {
      const row = (
        await root!.query(
          "SELECT id FROM rpt.order_external_intake WHERE source_system='HYCITE' AND external_id='no-official-policy'",
        )
      ).rows[0];
      await assert.rejects(
        svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: row?.id,
          orderId: order.id,
          expectedVersion: 1,
          reason: 'Unverified source cannot bind',
        }),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
      assert.equal(
        (
          await root!.query(
            "SELECT count(*)::integer AS n FROM rpt.order_external_binding WHERE source_system='HYCITE'",
          )
        ).rows[0]?.n,
        0,
      );
    });
    await t.test(
      'correlation binds only canonical Order, records typed generic evidence, and never mutates snapshot',
      async () => {
        const value = (await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: first.intakeId,
          orderId: order.id,
          expectedVersion: 1,
          reason: 'Verified deterministic Order UUID',
        })) as { status: string; version: number; orderId: string };
        assert.equal(value.status, 'matched');
        assert.equal(value.orderId, order.id);
        assert.equal(
          (
            await root!.query(
              "SELECT order_reconciliation_subject_type,subject_id FROM rpt.source_observation WHERE domain_key='order_reconciliation'",
            )
          ).rows[0]?.subject_id,
          order.id,
        );
        assert.deepEqual(
          (
            await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
              order.id,
            ])
          ).rows[0]?.value,
          before,
        );
        const state = (await svc.getOrderReconciliation(actor, req(), 'API', input.externalId)) as {
          order_id: string;
          status: string;
        };
        assert.equal(state.order_id, order.id);
        assert.equal(
          (
            (await svc.listOrderReconciliationHistory(actor, req(), 'API', input.externalId)) as {
              events: unknown[];
            }
          ).events.length,
          2,
        );
      },
    );
    await t.test('equivalent-capability tenant B cannot probe known intake or Order', async () => {
      await assert.rejects(
        svc.getOrderReconciliation(f.b.identities.delegate, req(), 'API', input.externalId),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        svc.correlateExternalOrderObservation(f.b.identities.delegate, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: first.intakeId,
          orderId: order.id,
          expectedVersion: 2,
          reason: 'Cross-tenant probe',
        }),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
      const own = (await svc.ingestExternalOrderObservation(
        f.b.identities.owner,
        req(),
        randomUUID(),
        {
          ...envelope('tenant-b-own-intake', 'tenant-b'),
          workspaceId: f.b.workspace,
          marketId: f.b.market,
        },
      )) as { intakeId: string };
      await assert.rejects(
        svc.correlateExternalOrderObservation(f.b.identities.delegate, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: own.intakeId,
          orderId: order.id,
          expectedVersion: 1,
          reason: 'Tenant B may not bind Tenant A Order',
        }),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
    });
    await t.test(
      'official promotion fails closed without independent official source authority',
      async () => {
        await assert.rejects(
          svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
            schemaVersion: 1,
            sourceSystem: 'API',
            externalId: input.externalId,
            expectedVersion: 2,
            outcome: 'resolved_official_wins',
            reason: 'Cannot promote verified to official',
          }),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'EXTERNAL_PENDING',
        );
        const state = (await svc.getOrderReconciliation(actor, req(), 'API', input.externalId)) as {
          version: number;
        };
        assert.equal(state.version, 2);
      },
    );
    await t.test('explicit authorized resolution is versioned and append-only', async () => {
      const result = (await svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
        schemaVersion: 1,
        sourceSystem: 'API',
        externalId: input.externalId,
        expectedVersion: 2,
        outcome: 'resolved_local_verified',
        reason: 'Local canonical snapshot retained',
      })) as { version: number; status: string };
      assert.equal(result.version, 3);
      assert.equal(result.status, 'resolved_local_verified');
      await assert.rejects(
        svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          sourceSystem: 'API',
          externalId: input.externalId,
          expectedVersion: 2,
          outcome: 'ignored_with_reason',
          reason: 'Stale command',
        }),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'STALE_VERSION',
      );
      await assert.rejects(
        svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          sourceSystem: 'API',
          externalId: input.externalId,
          expectedVersion: 3,
          outcome: 'matched',
          reason: 'Must not reopen resolution without new evidence',
        }),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'INVALID_STATE',
      );
      assert.deepEqual(
        (
          await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
            order.id,
          ])
        ).rows[0]?.value,
        before,
      );
    });
    await t.test(
      'runtime cannot directly rewrite intake, events, bindings or projection',
      async () => {
        await f.db.request(actor, req(), async (c) => {
          for (const sql of [
            'UPDATE rpt.order_external_intake SET external_id=$1 WHERE id=$2',
            'DELETE FROM rpt.order_reconciliation_event WHERE intake_id=$2',
            'UPDATE rpt.order_reconciliation_state SET status=$1 WHERE latest_intake_id=$2',
          ]) {
            await c.query('SAVEPOINT attack');
            await assert.rejects(c.query(sql, ['forged', first.intakeId]));
            await c.query('ROLLBACK TO SAVEPOINT attack');
          }
          await c.query('SAVEPOINT insert_attack');
          await assert.rejects(
            c.query(
              `INSERT INTO rpt.order_external_binding(tenant_id,source_system,external_id,order_id,workspace_id,market_id,first_intake_id,actor_id)
             VALUES($1,'API',$2,$3,$4,$5,$6,$7)`,
              [
                f.a.tenant,
                input.externalId,
                randomUUID(),
                f.a.workspace,
                f.ec.marketId,
                first.intakeId,
                f.a.users.owner,
              ],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT insert_attack');
        });
      },
    );
    await t.test(
      'typed generic observation and append-only generic case cannot be forged or rewritten',
      async () => {
        await f.db.request(actor, req(), async (c) => {
          await c.query('SAVEPOINT forged_subject');
          await assert.rejects(
            c.query(
              `INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,order_reconciliation_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id,facts)
           VALUES($1,$2,'API','order_reconciliation','order',$3,'fake-subject','test://forged',now(),now(),'verified',$4,$5,'matched',$6,$7)`,
              [
                f.a.tenant,
                randomUUID(),
                first.intakeId,
                'f'.repeat(64),
                randomUUID(),
                f.a.users.owner,
                { intakeId: first.intakeId },
              ],
            ),
          );
          await c.query('ROLLBACK TO SAVEPOINT forged_subject');
        });
        const obs = (
          await root!.query(
            "SELECT id FROM rpt.source_observation WHERE domain_key='order_reconciliation' LIMIT 1",
          )
        ).rows[0]?.id;
        const recCase = (
          await root!.query('SELECT id FROM rpt.reconciliation_case WHERE observation_id=$1', [obs])
        ).rows[0]?.id;
        await assert.rejects(
          root!.query(
            "UPDATE rpt.source_observation SET source_reference='rewritten' WHERE id=$1",
            [obs],
          ),
        );
        await assert.rejects(
          root!.query('DELETE FROM rpt.reconciliation_case WHERE id=$1', [recCase]),
        );
      },
    );
    await t.test(
      'hidden Order case stays hidden from otherwise-valid generic Trust SQL',
      async () => {
        assert.deepEqual(
          (
            await root!.query<{ domain_key: string }>(
              'SELECT domain_key FROM authz.generic_reconciliation_domain ORDER BY domain_key',
            )
          ).rows.map((row) => row.domain_key),
          ['rank', 'sales'],
        );
        for (const verb of ['read', 'approve'])
          await root!.query(
            "INSERT INTO authz.role_capability VALUES($1,'ancestor','trust',$2,'OFFICIAL_COMPENSATION',false,1) ON CONFLICT DO NOTHING",
            [f.a.tenant, verb],
          );
        // Synthetic only: production migration registers rank and sales, not arbitrary demo domains.
        await root!.query(
          "INSERT INTO authz.generic_reconciliation_domain(domain_key) VALUES('generic_demo')",
        );
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API','generic_demo','verified')",
          [f.a.tenant, f.a.users.ancestor],
        );
        const orderObservation = (
          await root!.query(
            "SELECT id FROM rpt.source_observation WHERE tenant_id=$1 AND domain_key='order_reconciliation' AND subject_id=$2 LIMIT 1",
            [f.a.tenant, order.id],
          )
        ).rows[0]?.id as string;
        const orderCase = (
          await root!.query('SELECT id FROM rpt.reconciliation_case WHERE observation_id=$1', [
            orderObservation,
          ])
        ).rows[0]?.id as string;
        const genericObservation = randomUUID();
        const genericCase = randomUUID();
        await f.db.request(f.a.identities.ancestor, req(), async (c) => {
          assert.equal(
            (
              await c.query(
                'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                [orderObservation],
              )
            ).rows[0]?.n,
            0,
          );
          assert.equal(
            (
              await c.query(
                'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
                [orderCase],
              )
            ).rows[0]?.n,
            0,
          );
          await c.query('SAVEPOINT forged_order_case');
          await assert.rejects(
            c.query(
              "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','forged_order_case',$4)",
              [f.a.tenant, randomUUID(), orderObservation, f.a.users.ancestor],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT forged_order_case');
          await c.query(
            "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id) VALUES($1,$2,'API','generic_demo',$3,$4,'test://generic',now(),now(),'verified',$5,$6,'pending',$7)",
            [
              f.a.tenant,
              genericObservation,
              randomUUID(),
              randomUUID(),
              'a'.repeat(64),
              randomUUID(),
              f.a.users.ancestor,
            ],
          );
          await c.query(
            "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','generic_still_allowed',$4)",
            [f.a.tenant, genericCase, genericObservation, f.a.users.ancestor],
          );
          assert.equal(
            (
              await c.query(
                'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
                [genericCase],
              )
            ).rows[0]?.n,
            1,
          );
        });
      },
    );
    await t.test(
      'generic case helper is an authorization decision, not a UUID oracle',
      async () => {
        const generic = (
          await root!.query(
            "SELECT observation_id FROM rpt.reconciliation_case WHERE tenant_id=$1 AND reason_code='generic_still_allowed'",
            [f.a.tenant],
          )
        ).rows[0]?.observation_id as string;
        const genericCase = (
          await root!.query(
            "SELECT id FROM rpt.reconciliation_case WHERE tenant_id=$1 AND observation_id=$2 AND reason_code='generic_still_allowed'",
            [f.a.tenant, generic],
          )
        ).rows[0]?.id as string;
        const orderObservation = (
          await root!.query(
            "SELECT id FROM rpt.source_observation WHERE tenant_id=$1 AND domain_key='order_reconciliation' AND subject_id=$2 LIMIT 1",
            [f.a.tenant, order.id],
          )
        ).rows[0]?.id as string;
        assert.ok(generic && genericCase && orderObservation);
        const unknown = randomUUID();
        const helper = async (
          identity: typeof actor,
          tenant: string,
          observation: string,
          verb: string | null,
        ) =>
          f.db.request(
            identity,
            req(),
            async (c) =>
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.order_reconciliation_generic_observation($1,$2,$3) AS allowed',
                  [tenant, observation, verb],
                )
              ).rows[0]?.allowed,
          );
        await f.db.request(f.a.identities.outsider, req(), async (c) => {
          const rights = (
            await c.query<{ valid: boolean; trust_read: boolean; trust_write: boolean }>(
              "SELECT authz.session_valid() AS valid, authz.capable(authz.actor_id(),'trust','read','OFFICIAL_COMPENSATION') AS trust_read, authz.capable(authz.actor_id(),'trust','approve','OFFICIAL_COMPENSATION') AS trust_write",
            )
          ).rows[0];
          assert.deepEqual(rights, { valid: true, trust_read: false, trust_write: false });
          for (const observation of [generic, unknown])
            assert.equal(
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.generic_reconciliation_source_read($1,$2) AS allowed',
                  [f.a.tenant, observation],
                )
              ).rows[0]?.allowed,
              false,
            );
        });
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, generic, 'read'), false);
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, unknown, 'read'), false);
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, generic, 'write'), false);
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, unknown, 'write'), false);
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, generic, null), false);
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, unknown, null), false);
        assert.equal(await helper(f.b.identities.delegate, f.a.tenant, generic, 'read'), false);
        assert.equal(
          await helper(f.a.identities.ancestor, f.a.tenant, orderObservation, 'read'),
          false,
        );
        assert.equal(await helper(f.a.identities.ancestor, f.a.tenant, unknown, 'read'), false);
        assert.equal(await helper(f.a.identities.ancestor, f.a.tenant, generic, null), false);
        assert.equal(await helper(f.a.identities.ancestor, f.a.tenant, unknown, null), false);
        assert.equal(await helper(f.a.identities.ancestor, f.a.tenant, generic, 'read'), true);
        assert.equal(await helper(f.a.identities.ancestor, f.a.tenant, generic, 'write'), true);
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,'admin','trust','read','OFFICIAL_COMPENSATION',false,1) ON CONFLICT DO NOTHING",
          [f.a.tenant],
        );
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, generic, 'read'), true);
        assert.equal(await helper(f.a.identities.outsider, f.a.tenant, generic, 'write'), false);
        await f.db.request(f.a.identities.outsider, req(), async (c) => {
          assert.equal(
            (
              await c.query(
                'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
                [genericCase],
              )
            ).rows[0]?.n,
            1,
          );
          await c.query('SAVEPOINT read_only_case_write');
          await assert.rejects(
            c.query(
              "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','read_only_forbidden',$4)",
              [f.a.tenant, randomUUID(), generic, f.a.users.outsider],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT read_only_case_write');
        });
      },
    );
    await t.test(
      'registered rank and sales retain Foundation Trust source access without update rewriting',
      async () => {
        const genericPolicies = (
          await root!.query<{
            policyname: string;
            cmd: string;
            qual: string | null;
            with_check: string | null;
          }>(
            "SELECT policyname,cmd,qual,with_check FROM pg_policies WHERE schemaname='rpt' AND tablename='source_observation' AND policyname IN ('trust_read','trust_legacy_insert','trust_legacy_update') ORDER BY policyname",
          )
        ).rows;
        assert.deepEqual(
          genericPolicies.map(({ policyname, cmd }) => [policyname, cmd]),
          [
            ['trust_legacy_insert', 'INSERT'],
            ['trust_legacy_update', 'UPDATE'],
            ['trust_read', 'SELECT'],
          ],
        );
        assert.ok(
          genericPolicies.every((policy) =>
            (policy.qual ?? policy.with_check ?? '').includes('generic_reconciliation_source_'),
          ),
        );
        assert.ok(
          genericPolicies
            .find((policy) => policy.cmd === 'UPDATE')
            ?.with_check?.includes('generic_reconciliation_source_write'),
        );
        const sourceSql =
          "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id) VALUES($1,$2,'API',$3,$4,$5,'test://registered',now(),now(),'verified',$6,$7,'pending',$8)";
        for (const [domain, subject] of [
          ['rank', f.a.groups[0]],
          ['sales', f.a.person],
        ] as const) {
          await root!.query(
            "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API',$3,'verified')",
            [f.a.tenant, f.a.users.ancestor, domain],
          );
          const observation = randomUUID();
          await f.db.request(f.a.identities.ancestor, req(), async (c) => {
            await c.query(sourceSql, [
              f.a.tenant,
              observation,
              domain,
              subject,
              randomUUID(),
              'c'.repeat(64),
              randomUUID(),
              f.a.users.ancestor,
            ]);
            assert.equal(
              (
                await c.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                  [observation],
                )
              ).rows[0]?.n,
              1,
            );
            assert.equal(
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.generic_reconciliation_source_read($1,$2) AS allowed',
                  [f.a.tenant, observation],
                )
              ).rows[0]?.allowed,
              true,
            );
            assert.equal(
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.generic_reconciliation_source_write($1,$2,$3,$4,$5) AS allowed',
                  [f.a.tenant, domain, 'API', 'verified', f.a.users.ancestor],
                )
              ).rows[0]?.allowed,
              true,
            );
            await c.query('SAVEPOINT source_domain_transition');
            await assert.rejects(
              c.query('UPDATE rpt.source_observation SET domain_key=$1 WHERE id=$2', [
                'future_specialized_domain_not_registered',
                observation,
              ]),
              (e: unknown) =>
                typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
            );
            await c.query('ROLLBACK TO SAVEPOINT source_domain_transition');
          });
          assert.equal(
            (
              await root!.query<{ domain_key: string }>(
                'SELECT domain_key FROM rpt.source_observation WHERE id=$1',
                [observation],
              )
            ).rows[0]?.domain_key,
            domain,
          );
        }
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API','rank','verified') ON CONFLICT DO NOTHING",
          [f.a.tenant, f.a.users.outsider],
        );
        await f.db.request(f.a.identities.outsider, req(), async (c) => {
          const rights = (
            await c.query<{ read: boolean; write: boolean }>(
              "SELECT authz.capable(authz.actor_id(),'trust','read','OFFICIAL_COMPENSATION') AS read, authz.capable(authz.actor_id(),'trust','approve','OFFICIAL_COMPENSATION') AS write",
            )
          ).rows[0];
          assert.deepEqual(rights, { read: true, write: false });
          await c.query('SAVEPOINT readonly_source_insert');
          await assert.rejects(
            c.query(sourceSql, [
              f.a.tenant,
              randomUUID(),
              'rank',
              f.a.groups[0],
              randomUUID(),
              'd'.repeat(64),
              randomUUID(),
              f.a.users.outsider,
            ]),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT readonly_source_insert');
        });
      },
    );
    await t.test(
      'unregistered and ambiguous domains cannot inherit generic Trust source or case access',
      async () => {
        const domains = [
          'future_specialized_domain_not_registered',
          'RANK',
          'rank ',
          ' rank',
          'Sales',
          'sales ',
          'rank\u00a0',
          '',
        ];
        const unknown = randomUUID();
        const observations: { domain: string; observation: string; existingCase: string }[] = [];
        for (const domain of domains) {
          await root!.query(
            "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API',$3,'verified')",
            [f.a.tenant, f.a.users.ancestor, domain],
          );
          const observation = randomUUID();
          const existingCase = randomUUID();
          // Privileged fixture setup creates known evidence without granting
          // runtime a generic Trust path to an unregistered domain.
          await root!.query('BEGIN');
          try {
            await root!.query(
              "SELECT set_config('rpt.tenant_id',$1,true),set_config('rpt.actor_id',$2,true)",
              [f.a.tenant, f.a.users.ancestor],
            );
            await root!.query(
              "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id) VALUES($1,$2,'API',$3,$4,$5,'test://unregistered',now(),now(),'verified',$6,$7,'pending',$8)",
              [
                f.a.tenant,
                observation,
                domain,
                randomUUID(),
                randomUUID(),
                'b'.repeat(64),
                randomUUID(),
                f.a.users.ancestor,
              ],
            );
            await root!.query('COMMIT');
          } catch (error) {
            await root!.query('ROLLBACK');
            throw error;
          }
          await root!.query(
            "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','unregistered_probe',$4)",
            [f.a.tenant, existingCase, observation, f.a.users.owner],
          );
          observations.push({ domain, observation, existingCase });
        }
        await f.db.request(f.a.identities.ancestor, req(), async (c) => {
          const rights = (
            await c.query<{ valid: boolean; trust_read: boolean; trust_write: boolean }>(
              "SELECT authz.session_valid() AS valid, authz.capable(authz.actor_id(),'trust','read','OFFICIAL_COMPENSATION') AS trust_read, authz.capable(authz.actor_id(),'trust','approve','OFFICIAL_COMPENSATION') AS trust_write",
            )
          ).rows[0];
          assert.deepEqual(rights, { valid: true, trust_read: true, trust_write: true });
          for (const { domain, observation, existingCase } of observations) {
            assert.equal(
              (
                await root!.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                  [observation],
                )
              ).rows[0]?.n,
              1,
              domain,
            );
            assert.equal(
              (
                await c.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                  [observation],
                )
              ).rows[0]?.n,
              0,
              domain,
            );
            assert.equal(
              (
                await c.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                  [unknown],
                )
              ).rows[0]?.n,
              0,
              domain,
            );
            assert.equal(
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.generic_reconciliation_source_read($1,$2) AS allowed',
                  [f.a.tenant, observation],
                )
              ).rows[0]?.allowed,
              false,
              domain,
            );
            assert.equal(
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.generic_reconciliation_source_read($1,$2) AS allowed',
                  [f.a.tenant, unknown],
                )
              ).rows[0]?.allowed,
              false,
              domain,
            );
            assert.equal(
              (
                await c.query<{ allowed: boolean }>(
                  'SELECT authz.generic_reconciliation_source_write($1,$2,$3,$4,$5) AS allowed',
                  [f.a.tenant, domain, 'API', 'verified', f.a.users.ancestor],
                )
              ).rows[0]?.allowed,
              false,
              domain,
            );
            const rejectedObservation = randomUUID();
            await c.query('SAVEPOINT unregistered_source');
            await assert.rejects(
              c.query(
                "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id) VALUES($1,$2,'API',$3,$4,$5,'test://forged',now(),now(),'verified',$6,$7,'pending',$8)",
                [
                  f.a.tenant,
                  rejectedObservation,
                  domain,
                  randomUUID(),
                  randomUUID(),
                  'e'.repeat(64),
                  randomUUID(),
                  f.a.users.ancestor,
                ],
              ),
              (e: unknown) =>
                typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
              domain,
            );
            await c.query('ROLLBACK TO SAVEPOINT unregistered_source');
            assert.equal(
              (
                await root!.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                  [rejectedObservation],
                )
              ).rows[0]?.n,
              0,
              domain,
            );
            for (const operation of ['read', 'write']) {
              const result = async (id: string) =>
                (
                  await c.query<{ allowed: boolean }>(
                    'SELECT authz.order_reconciliation_generic_observation($1,$2,$3) AS allowed',
                    [f.a.tenant, id, operation],
                  )
                ).rows[0]?.allowed;
              assert.equal(await result(observation), false, domain);
              assert.equal(await result(observation), await result(unknown), domain);
            }
            assert.equal(
              (
                await c.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
                  [existingCase],
                )
              ).rows[0]?.n,
              0,
              domain,
            );
            const forgedCase = randomUUID();
            await c.query('SAVEPOINT unregistered_case');
            await assert.rejects(
              c.query(
                "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','forged_unregistered',$4)",
                [f.a.tenant, forgedCase, observation, f.a.users.ancestor],
              ),
              (e: unknown) =>
                typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
            );
            await c.query('ROLLBACK TO SAVEPOINT unregistered_case');
            assert.equal(
              (
                await root!.query<{ n: number }>(
                  'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
                  [forgedCase],
                )
              ).rows[0]?.n,
              0,
              domain,
            );
          }
        });
      },
    );
    await t.test('runtime cannot read or mutate the generic domain registry', async () => {
      await f.db.request(f.a.identities.ancestor, req(), async (c) => {
        for (const sql of [
          'SELECT domain_key FROM authz.generic_reconciliation_domain',
          "INSERT INTO authz.generic_reconciliation_domain(domain_key) VALUES('pricing')",
          "INSERT INTO authz.generic_reconciliation_domain(domain_key) VALUES('future_typed_domain_not_registered')",
          "UPDATE authz.generic_reconciliation_domain SET domain_key='pricing' WHERE domain_key='rank'",
          "DELETE FROM authz.generic_reconciliation_domain WHERE domain_key='rank'",
          'TRUNCATE authz.generic_reconciliation_domain',
        ]) {
          await c.query('SAVEPOINT registry_denial');
          await assert.rejects(
            c.query(sql),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
            sql,
          );
          await c.query('ROLLBACK TO SAVEPOINT registry_denial');
        }
      });
      assert.deepEqual(
        (
          await root!.query<{ domain_key: string }>(
            'SELECT domain_key FROM authz.generic_reconciliation_domain ORDER BY domain_key',
          )
        ).rows.map((row) => row.domain_key),
        ['generic_demo', 'rank', 'sales'],
      );
    });
    await t.test(
      'generic Trust cannot classify or write a market-hidden pricing observation',
      async () => {
        const pricingObservation = (
          await root!.query<{ id: string }>(
            "SELECT id FROM rpt.source_observation WHERE tenant_id=$1 AND domain_key='pricing' AND commerce_subject_type='price_list' AND subject_id=$2 LIMIT 1",
            [f.a.tenant, f.co.list],
          )
        ).rows[0]?.id;
        const visiblePricingObservation = (
          await root!.query<{ id: string }>(
            "SELECT id FROM rpt.source_observation WHERE tenant_id=$1 AND domain_key='pricing' AND commerce_subject_type='price_list' AND subject_id=$2 LIMIT 1",
            [f.a.tenant, f.ec.list],
          )
        ).rows[0]?.id;
        assert.ok(pricingObservation);
        assert.ok(visiblePricingObservation);
        const unknown = randomUUID();
        const existingCase = randomUUID();
        const rejectedCase = randomUUID();
        const rejectedSource = randomUUID();
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API','pricing','verified') ON CONFLICT DO NOTHING",
          [f.a.tenant, f.a.users.ancestor],
        );
        await root!.query(
          "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','pricing_scope_probe',$4)",
          [f.a.tenant, existingCase, pricingObservation, f.a.users.owner],
        );
        await f.db.request(f.a.identities.ancestor, req(), async (c) => {
          const rights = (
            await c.query<{
              valid: boolean;
              trust_read: boolean;
              trust_write: boolean;
              pricing_read: boolean;
            }>(
              "SELECT authz.session_valid() AS valid, authz.capable(authz.actor_id(),'trust','read','OFFICIAL_COMPENSATION') AS trust_read, authz.capable(authz.actor_id(),'trust','approve','OFFICIAL_COMPENSATION') AS trust_write, authz.pricing_allowed($1,'read') AS pricing_read",
              [f.co.list],
            )
          ).rows[0];
          assert.deepEqual(rights, {
            valid: true,
            trust_read: true,
            trust_write: true,
            pricing_read: false,
          });
          assert.equal(
            (
              await c.query<{ allowed: boolean }>(
                'SELECT authz.generic_reconciliation_source_write($1,$2,$3,$4,$5) AS allowed',
                [f.a.tenant, 'pricing', 'API', 'verified', f.a.users.ancestor],
              )
            ).rows[0]?.allowed,
            false,
          );
          await c.query('SAVEPOINT hidden_pricing_source');
          await assert.rejects(
            c.query(
              "INSERT INTO rpt.source_observation(tenant_id,id,source_system,domain_key,commerce_subject_type,subject_id,external_id,source_reference,observed_at,effective_at,authority_level,raw_hash,sync_run_id,reconciliation_state,actor_id) VALUES($1,$2,'API','pricing','price_list',$3,$4,'test://forged-pricing',now(),now(),'verified',$5,$6,'pending',$7)",
              [
                f.a.tenant,
                rejectedSource,
                f.co.list,
                randomUUID(),
                'f'.repeat(64),
                randomUUID(),
                f.a.users.ancestor,
              ],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT hidden_pricing_source');
          assert.equal(
            (
              await c.query<{ n: number }>(
                'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                [pricingObservation],
              )
            ).rows[0]?.n,
            0,
          );
          assert.equal(
            (
              await c.query<{ allowed: boolean }>(
                "SELECT authz.pricing_allowed($1,'read') AS allowed",
                [f.ec.list],
              )
            ).rows[0]?.allowed,
            true,
          );
          assert.equal(
            (
              await c.query<{ n: number }>(
                'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
                [visiblePricingObservation],
              )
            ).rows[0]?.n,
            1,
          );
          assert.equal(
            (
              await c.query<{ allowed: boolean }>(
                'SELECT authz.order_reconciliation_generic_observation($1,$2,$3) AS allowed',
                [f.a.tenant, visiblePricingObservation, 'read'],
              )
            ).rows[0]?.allowed,
            false,
          );
          for (const operation of ['read', 'write']) {
            const known: boolean | undefined = (
              await c.query<{ allowed: boolean }>(
                'SELECT authz.order_reconciliation_generic_observation($1,$2,$3) AS allowed',
                [f.a.tenant, pricingObservation, operation],
              )
            ).rows[0]?.allowed;
            const missing: boolean | undefined = (
              await c.query<{ allowed: boolean }>(
                'SELECT authz.order_reconciliation_generic_observation($1,$2,$3) AS allowed',
                [f.a.tenant, unknown, operation],
              )
            ).rows[0]?.allowed;
            assert.equal(known, false);
            assert.equal(known, missing);
          }
          assert.equal(
            (
              await c.query<{ n: number }>(
                'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
                [existingCase],
              )
            ).rows[0]?.n,
            0,
          );
          await c.query('SAVEPOINT hidden_pricing_case');
          await assert.rejects(
            c.query(
              "INSERT INTO rpt.reconciliation_case(tenant_id,id,observation_id,state,reason_code,actor_id) VALUES($1,$2,$3,'pending','forged_pricing_case',$4)",
              [f.a.tenant, rejectedCase, pricingObservation, f.a.users.ancestor],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '42501',
          );
          await c.query('ROLLBACK TO SAVEPOINT hidden_pricing_case');
        });
        assert.equal(
          (
            await root!.query<{ n: number }>(
              'SELECT count(*)::integer AS n FROM rpt.reconciliation_case WHERE id=$1',
              [rejectedCase],
            )
          ).rows[0]?.n,
          0,
        );
        assert.equal(
          (
            await root!.query<{ n: number }>(
              'SELECT count(*)::integer AS n FROM rpt.source_observation WHERE id=$1',
              [rejectedSource],
            )
          ).rows[0]?.n,
          0,
        );
      },
    );
    await t.test('unprivileged actor cannot ingest or infer external identity', async () => {
      await assert.rejects(
        svc.ingestExternalOrderObservation(
          f.a.identities.outsider,
          req(),
          randomUUID(),
          envelope('outsider-probe', 'probe'),
        ),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        svc.getOrderReconciliation(f.a.identities.outsider, req(), 'API', input.externalId),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
    });
    await t.test(
      'tenant-wide identity registry gate gives scoped actors no foreign-ID oracle',
      async () => {
        const foreignWorkspace = randomUUID();
        await root!.query(
          "INSERT INTO rpt.crm_workspace(tenant_id,id,name,kind) VALUES($1,$2,'Foreign reconciliation workspace','commercial')",
          [f.a.tenant, foreignWorkspace],
        );
        await root!.query(
          "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,'order_reconciliation','ingest','CONFIDENTIAL',1)",
          [f.a.tenant, randomUUID(), foreignWorkspace, f.a.users.owner],
        );
        for (const externalId of ['m1-owner-unknown', input.externalId])
          await assert.rejects(
            ingest(envelope(externalId, 'm1-incomplete-registry-scope')),
            (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
          );
        const foreignWorkspaceInput = envelope('m1-foreign-workspace', 'm1-workspace', {
          workspaceId: foreignWorkspace,
        });
        const foreignMarketInput = envelope('m1-foreign-market', 'm1-market', {
          marketId: f.co.marketId,
        });
        for (const verb of ['read'])
          await root!.query(
            "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,'order_reconciliation',$5,'CONFIDENTIAL',1)",
            [f.a.tenant, randomUUID(), foreignWorkspace, f.a.users.owner, verb],
          );
        for (const item of [foreignWorkspaceInput, foreignMarketInput])
          await svc.ingestExternalOrderObservation(f.a.identities.owner, req(), randomUUID(), item);
        for (const verb of ['ingest', 'read']) {
          await root!.query(
            "INSERT INTO authz.role_capability VALUES($1,'ancestor','order_reconciliation',$2,'CONFIDENTIAL',false,1) ON CONFLICT DO NOTHING",
            [f.a.tenant, verb],
          );
          await root!.query(
            "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,'order_reconciliation',$5,'CONFIDENTIAL',1)",
            [f.a.tenant, randomUUID(), f.a.workspace, f.a.users.ancestor, verb],
          );
        }
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'API','order_reconciliation','verified')",
          [f.a.tenant, f.a.users.ancestor],
        );
        const probes = [
          envelope('m1-never-seen', 'm1-never-seen'),
          envelope(input.externalId, 'm1-own-scope'),
          envelope(foreignWorkspaceInput.externalId, 'm1-foreign-workspace-probe'),
          envelope(foreignMarketInput.externalId, 'm1-foreign-market-probe'),
        ];
        for (const probe of probes)
          await assert.rejects(
            svc.ingestExternalOrderObservation(f.a.identities.ancestor, req(), randomUUID(), probe),
            (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
          );
        assert.equal(
          (
            (await svc.getOrderReconciliation(
              f.a.identities.ancestor,
              req(),
              'API',
              input.externalId,
            )) as { external_id: string }
          ).external_id,
          input.externalId,
        );
        for (const externalId of [
          'm1-never-seen',
          foreignWorkspaceInput.externalId,
          foreignMarketInput.externalId,
        ])
          await assert.rejects(
            svc.getOrderReconciliation(f.a.identities.ancestor, req(), 'API', externalId),
            (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
          );
        await f.db.request(f.a.identities.ancestor, req(), async (c) => {
          for (const probe of probes) {
            await c.query('SAVEPOINT identity_probe');
            await assert.rejects(
              c.query('SELECT authz.ingest_external_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
                probe.workspaceId,
                probe.marketId,
                probe.sourceSystem,
                probe.externalId,
                probe.sourceReference,
                probe.observedAt,
                probe.effectiveAt,
                probe.rawHash,
                probe.correlationId,
                probe.authorityLevel,
                randomUUID(),
              ]),
              (e: unknown) =>
                typeof e === 'object' &&
                e !== null &&
                'code' in e &&
                e.code === '42501' &&
                'message' in e &&
                e.message === 'reconciliation_denied',
            );
            await c.query('ROLLBACK TO SAVEPOINT identity_probe');
          }
        });
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.order_external_intake WHERE tenant_id=$1 AND external_id='m1-never-seen'",
              [f.a.tenant],
            )
          ).rows[0]?.n,
          0,
        );
        const otherTenant = (await svc.ingestExternalOrderObservation(
          f.b.identities.owner,
          req(),
          randomUUID(),
          { ...foreignMarketInput, workspaceId: f.b.workspace, marketId: f.b.market },
        )) as { status: string };
        assert.equal(otherTenant.status, 'unmatched');
      },
    );
    await t.test(
      'same external ID is scoped by source system and conflicting duplicate is rejected',
      async () => {
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'DOCUCITE','order_reconciliation','verified')",
          [f.a.tenant, f.a.users.owner],
        );
        const otherProvider = await ingest(
          envelope(input.externalId, 'docucite-event', { sourceSystem: 'DOCUCITE' }),
        );
        assert.equal(otherProvider.status, 'unmatched');
        await assert.rejects(
          ingest({ ...input, sourceReference: 'changed-metadata' }),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'EXTERNAL_CONFLICT',
        );
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.order_external_intake WHERE tenant_id=$1 AND source_system='API' AND external_id=$2",
              [f.a.tenant, input.externalId],
            )
          ).rows[0]?.n,
          1,
        );
      },
    );
    await t.test(
      'stale and ambiguous external events remain evidence without replacing accepted latest hash',
      async () => {
        const ordering = envelope('ordering-case', 'ordering-first');
        await ingest(ordering);
        const late = await ingest(
          envelope(ordering.externalId, 'late-event', {
            effectiveAt: '2026-09-28T09:00:00Z',
            observedAt: '2026-09-30T10:00:00Z',
          }),
        );
        assert.equal(late.version, 2);
        const ambiguous = await ingest(
          envelope(ordering.externalId, 'same-time-different-hash', {
            effectiveAt: ordering.effectiveAt,
            observedAt: ordering.observedAt,
          }),
        );
        assert.equal(ambiguous.status, 'conflict');
        const state = (await svc.getOrderReconciliation(
          actor,
          req(),
          'API',
          ordering.externalId,
        )) as {
          latest_hash: string;
          version: number;
        };
        assert.equal(state.latest_hash, ordering.rawHash);
        assert.equal(state.version, 3);
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.order_reconciliation_event WHERE tenant_id=$1 AND source_system='API' AND external_id=$2",
              [f.a.tenant, ordering.externalId],
            )
          ).rows[0]?.n,
          3,
        );
      },
    );
    await t.test(
      'registry capability alone cannot bypass global market scope or substitute a foreign-workspace Order',
      async () => {
        await root!.query(
          "INSERT INTO authz.role_capability VALUES($1,'delegate','order_reconciliation','identity_registry','CONFIDENTIAL',false,1) ON CONFLICT DO NOTHING",
          [f.a.tenant],
        );
        await assert.rejects(
          svc.ingestExternalOrderObservation(
            f.a.identities.delegate,
            req(),
            randomUUID(),
            envelope('unknown-without-global-market-scope', 'market'),
          ),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
        );
        await assert.rejects(
          svc.ingestExternalOrderObservation(
            f.a.identities.delegate,
            req(),
            randomUUID(),
            envelope('foreign-market', 'market', { marketId: f.co.marketId }),
          ),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
        );
        const workspace = randomUUID();
        await root!.query(
          "INSERT INTO rpt.crm_workspace(tenant_id,id,name,kind) VALUES($1,$2,'Other workspace','commercial')",
          [f.a.tenant, workspace],
        );
        for (const verb of ['ingest', 'read', 'correlate']) {
          await root!.query(
            "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,'order_reconciliation',$5,'CONFIDENTIAL',1)",
            [f.a.tenant, randomUUID(), workspace, f.a.users.owner, verb],
          );
        }
        const differentWorkspace = await ingest(
          envelope('other-workspace', 'workspace', { workspaceId: workspace }),
        );
        await assert.rejects(
          svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
            schemaVersion: 1,
            intakeId: differentWorkspace.intakeId,
            orderId: order.id,
            expectedVersion: 1,
            reason: 'Must reject cross-workspace candidate',
          }),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
        );
      },
    );
    await t.test(
      'independent lifecycle and legacy simulation cannot be confused with reconciliation',
      async () => {
        assert.equal(
          (await f.lifecycle.getOrderCommercialState(actor, req(), order.id)).status,
          'created',
        );
        const opportunity = randomUUID(),
          simulatedQuote = randomUUID(),
          simulation = randomUUID();
        await root!.query(
          "INSERT INTO rpt.opportunity(tenant_id,id,person_id,workspace_id,owner_id,title,source) VALUES($1,$2,$3,$4,$5,'Legacy simulation','manual')",
          [f.a.tenant, opportunity, f.a.person, f.a.workspace, f.a.users.delegate],
        );
        await root!.query(
          "INSERT INTO rpt.quote_version(tenant_id,id,opportunity_id,revision,product,amount,currency) VALUES($1,$2,$3,1,'Legacy product',100,'USD')",
          [f.a.tenant, simulatedQuote, opportunity],
        );
        await root!.query(
          'INSERT INTO rpt.commercial_order(tenant_id,id,opportunity_id,quote_id) VALUES($1,$2,$3,$4)',
          [f.a.tenant, simulation, opportunity, simulatedQuote],
        );
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.commercial_order WHERE id=$1',
              [simulation],
            )
          ).rows[0]?.n,
          1,
        );
        assert.equal(
          (
            await root!.query('SELECT count(*)::integer AS n FROM rpt.cpq_order WHERE id=$1', [
              simulation,
            ])
          ).rows[0]?.n,
          0,
        );
        await assert.rejects(
          svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
            schemaVersion: 1,
            intakeId: first.intakeId,
            orderId: simulation,
            expectedVersion: 5,
            reason: 'Legacy commercial_order UUID is not canonical',
          }),
          (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
        );
        assert.deepEqual(
          (
            await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
              order.id,
            ])
          ).rows[0]?.value,
          before,
        );
      },
    );
    await t.test(
      'concurrent candidate binding has one canonical winner and DB uniqueness rejects substitution',
      async () => {
        const candidate = await f.create();
        const pending = await ingest(envelope('race-binding', 'race'));
        const attempts = await Promise.allSettled(
          [order.id, candidate.id].map((orderId) =>
            svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
              schemaVersion: 1,
              intakeId: pending.intakeId,
              orderId,
              expectedVersion: 1,
              reason: 'Authorized competing deterministic candidate',
            }),
          ),
        );
        assert.equal(attempts.filter((v) => v.status === 'fulfilled').length, 1);
        const binding = (
          await root!.query(
            "SELECT order_id FROM rpt.order_external_binding WHERE tenant_id=$1 AND source_system='API' AND external_id='race-binding'",
            [f.a.tenant],
          )
        ).rows;
        assert.equal(binding.length, 1);
        await assert.rejects(
          root!.query(
            "INSERT INTO rpt.order_external_binding(tenant_id,source_system,external_id,order_id,workspace_id,market_id,first_intake_id,actor_id) VALUES($1,'API','race-binding',$2,$3,$4,$5,$6)",
            [
              f.a.tenant,
              binding[0]?.order_id === order.id ? candidate.id : order.id,
              f.a.workspace,
              f.ec.marketId,
              pending.intakeId,
              f.a.users.owner,
            ],
          ),
          (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505',
        );
      },
    );
    await t.test('concurrent authorized resolutions serialize by expected version', async () => {
      const concurrent = await ingest(envelope('concurrent-resolution', 'concurrent-resolution'));
      await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
        schemaVersion: 1,
        intakeId: concurrent.intakeId,
        orderId: order.id,
        expectedVersion: 1,
        reason: 'Initial concurrent-resolution correlation',
      });
      const beforeState = (await svc.getOrderReconciliation(
        actor,
        req(),
        'API',
        'concurrent-resolution',
      )) as { version: number };
      const attempts = await Promise.allSettled(
        ['matched', 'ignored_with_reason'].map((outcome) =>
          svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
            schemaVersion: 1,
            sourceSystem: 'API',
            externalId: 'concurrent-resolution',
            expectedVersion: beforeState.version,
            outcome,
            reason: 'Concurrent explicit disposition',
          }),
        ),
      );
      assert.equal(attempts.filter((v) => v.status === 'fulfilled').length, 1);
      const after = (await svc.getOrderReconciliation(
        actor,
        req(),
        'API',
        'concurrent-resolution',
      )) as {
        version: number;
      };
      assert.equal(after.version, beforeState.version + 1);
    });
    await t.test(
      'incompatible second Order candidate is explicit conflict evidence, not a rebind',
      async () => {
        const candidate = await f.create();
        const pending = await ingest(envelope('candidate-conflict', 'candidate-conflict'));
        await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: pending.intakeId,
          orderId: order.id,
          expectedVersion: 1,
          reason: 'Initial canonical correlation',
        });
        const conflict = (await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: pending.intakeId,
          orderId: candidate.id,
          expectedVersion: 2,
          reason: 'Conflicting canonical candidate',
        })) as { status: string; orderId: string; eventId: string };
        assert.equal(conflict.status, 'conflict');
        assert.equal(conflict.orderId, order.id);
        const event = (
          await root!.query(
            'SELECT order_id,candidate_order_id FROM rpt.order_reconciliation_event WHERE id=$1',
            [conflict.eventId],
          )
        ).rows[0];
        assert.equal(event?.order_id, order.id);
        assert.equal(event?.candidate_order_id, candidate.id);
        assert.equal(
          (
            await root!.query(
              "SELECT order_id FROM rpt.order_external_binding WHERE tenant_id=$1 AND source_system='API' AND external_id='candidate-conflict'",
              [f.a.tenant],
            )
          ).rows[0]?.order_id,
          order.id,
        );
      },
    );
    await t.test('resolved correlation cannot be reopened by the same intake', async () => {
      const candidate = await f.create();
      const pending = await ingest(envelope('terminal-candidate', 'terminal-candidate'));
      await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
        schemaVersion: 1,
        intakeId: pending.intakeId,
        orderId: order.id,
        expectedVersion: 1,
        reason: 'Accepted canonical correlation',
      });
      await svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
        schemaVersion: 1,
        sourceSystem: 'API',
        externalId: 'terminal-candidate',
        expectedVersion: 2,
        outcome: 'resolved_local_verified',
        reason: 'Terminal local resolution',
      });
      const unchanged = () =>
        root!.query(
          "SELECT to_jsonb(s) AS value FROM rpt.order_reconciliation_state s WHERE tenant_id=$1 AND source_system='API' AND external_id='terminal-candidate'",
          [f.a.tenant],
        );
      const beforeState = (await unchanged()).rows[0]?.value;
      const beforeEvents = (
        await root!.query(
          "SELECT count(*)::integer AS n FROM rpt.order_reconciliation_event WHERE tenant_id=$1 AND source_system='API' AND external_id='terminal-candidate'",
          [f.a.tenant],
        )
      ).rows[0]?.n;
      const same = (await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
        schemaVersion: 1,
        intakeId: pending.intakeId,
        orderId: order.id,
        expectedVersion: 3,
        reason: 'Safe same-Order repetition',
      })) as { status: string; version: number };
      assert.equal(same.status, 'resolved_local_verified');
      assert.equal(same.version, 3);
      const alternate = () =>
        svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: pending.intakeId,
          orderId: candidate.id,
          expectedVersion: 3,
          reason: 'Forbidden alternate candidate',
        });
      const attempts = await Promise.allSettled([alternate(), alternate()]);
      assert.equal(
        attempts.every(
          (v) =>
            v.status === 'rejected' &&
            v.reason instanceof OrderReconciliationError &&
            v.reason.code === 'INVALID_STATE',
        ),
        true,
      );
      await f.db.request(actor, req(), async (c) => {
        await c.query('SAVEPOINT alternate_correlation');
        await assert.rejects(
          c.query('SELECT authz.correlate_external_order($1,$2,$3,$4,$5)', [
            pending.intakeId,
            candidate.id,
            3,
            'Forbidden direct SQL alternate',
            randomUUID(),
          ]),
          (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505',
        );
        await c.query('ROLLBACK TO SAVEPOINT alternate_correlation');
      });
      assert.deepEqual((await unchanged()).rows[0]?.value, beforeState);
      assert.equal(
        (
          await root!.query(
            "SELECT count(*)::integer AS n FROM rpt.order_reconciliation_event WHERE tenant_id=$1 AND source_system='API' AND external_id='terminal-candidate'",
            [f.a.tenant],
          )
        ).rows[0]?.n,
        beforeEvents,
      );
      assert.equal(
        (
          await root!.query(
            "SELECT order_id FROM rpt.order_external_binding WHERE tenant_id=$1 AND source_system='API' AND external_id='terminal-candidate'",
            [f.a.tenant],
          )
        ).rows[0]?.order_id,
        order.id,
      );
    });
    await t.test(
      'official outcome requires separately authorized and verified source evidence',
      async () => {
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'HYCITE','order_reconciliation','official')",
          [f.a.tenant, f.a.users.owner],
        );
        const official = (await ingest(
          envelope('official-source-order', 'official-evidence', {
            sourceSystem: 'HYCITE',
            authorityLevel: 'official',
          }),
        )) as typeof first & { sourceAuthorized: boolean };
        assert.equal(official.sourceAuthorized, true);
        await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          intakeId: official.intakeId,
          orderId: order.id,
          expectedVersion: 1,
          reason: 'Authorized official source correlation',
        });
        const outcome = (await svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          sourceSystem: 'HYCITE',
          externalId: 'official-source-order',
          expectedVersion: 2,
          outcome: 'resolved_official_wins',
          reason: 'Verified source evidence selected',
        })) as { status: string };
        assert.equal(outcome.status, 'resolved_official_wins');
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM rpt.source_observation WHERE domain_key='order_reconciliation' AND authority_level='official' AND verified_at IS NOT NULL",
            )
          ).rows[0]?.n,
          1,
        );
        assert.deepEqual(
          (
            await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
              order.id,
            ])
          ).rows[0]?.value,
          before,
        );
      },
    );
    await t.test('revoked source authority blocks even an identical receipt retry', async () => {
      const awaitingResolution = await ingest(
        envelope('m2-awaiting-resolution', 'm2-awaiting-resolution'),
      );
      await svc.correlateExternalOrderObservation(actor, req(), randomUUID(), {
        schemaVersion: 1,
        intakeId: awaitingResolution.intakeId,
        orderId: order.id,
        expectedVersion: 1,
        reason: 'Trusted evidence awaiting explicit resolution',
      });
      const newerTrusted = await ingest(
        envelope('m2-awaiting-resolution', 'm2-newer-trusted', {
          observedAt: '2026-09-30T11:00:00Z',
          effectiveAt: '2026-09-30T10:00:00Z',
        }),
      );
      assert.equal(newerTrusted.status, 'pending_review');
      const acceptedBefore = (
        await root!.query(
          "SELECT to_jsonb(s) AS value FROM rpt.order_reconciliation_state s WHERE tenant_id=$1 AND source_system='API' AND external_id=$2",
          [f.a.tenant, input.externalId],
        )
      ).rows[0]?.value;
      assert.equal((acceptedBefore as { status: string }).status, 'resolved_local_verified');
      const eventCountBefore = (
        await root!.query(
          "SELECT count(*)::integer AS n FROM rpt.order_reconciliation_event WHERE tenant_id=$1 AND source_system='API' AND external_id=$2",
          [f.a.tenant, input.externalId],
        )
      ).rows[0]?.n;
      await root!.query(
        "UPDATE authz.source_authority SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND source_system='API' AND domain_key='order_reconciliation'",
        [f.a.tenant, f.a.users.owner],
      );
      await assert.rejects(
        ingest(input, key),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        svc.resolveOrderReconciliation(actor, req(), randomUUID(), {
          schemaVersion: 1,
          sourceSystem: 'API',
          externalId: 'm2-awaiting-resolution',
          expectedVersion: 3,
          outcome: 'matched',
          reason: 'Revoked source cannot win',
        }),
        (e: unknown) => e instanceof OrderReconciliationError && e.code === 'EXTERNAL_PENDING',
      );
      assert.equal(
        (
          (await svc.getOrderReconciliation(actor, req(), 'API', 'm2-awaiting-resolution')) as {
            version: number;
          }
        ).version,
        3,
      );
      const observationCount = (
        await root!.query(
          "SELECT count(*)::integer AS n FROM rpt.source_observation WHERE domain_key='order_reconciliation'",
        )
      ).rows[0]?.n;
      const untrusted = (await ingest(
        envelope(input.externalId, 'untrusted-after-revocation', {
          observedAt: '2026-10-01T10:00:00Z',
          effectiveAt: '2026-10-01T09:00:00Z',
        }),
      )) as typeof first & { sourceAuthorized: boolean };
      assert.equal(untrusted.sourceAuthorized, false);
      assert.equal(untrusted.status, 'pending_review');
      const oldUntrusted = (await ingest(
        envelope(input.externalId, 'old-untrusted-after-revocation', {
          observedAt: '2026-09-01T10:00:00Z',
          effectiveAt: '2026-09-01T09:00:00Z',
        }),
      )) as typeof first & { sourceAuthorized: boolean };
      assert.equal(oldUntrusted.status, 'pending_review');
      assert.equal(oldUntrusted.sourceAuthorized, false);
      await f.db.request(actor, req(), async (c) => {
        const direct = (
          await c.query(
            'SELECT authz.ingest_external_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value',
            [
              f.a.workspace,
              f.ec.marketId,
              'API',
              input.externalId,
              input.sourceReference,
              '2026-10-02T10:00:00Z',
              '2026-10-02T09:00:00Z',
              createHash('sha256').update('direct-untrusted-after-revocation').digest('hex'),
              randomUUID(),
              'verified',
              randomUUID(),
            ],
          )
        ).rows[0]?.value as { status: string; sourceAuthorized: boolean };
        assert.equal(direct.status, 'pending_review');
        assert.equal(direct.sourceAuthorized, false);
      });
      const projected = (
        await root!.query(
          "SELECT to_jsonb(s) AS value FROM rpt.order_reconciliation_state s WHERE tenant_id=$1 AND source_system='API' AND external_id=$2",
          [f.a.tenant, input.externalId],
        )
      ).rows[0]?.value as {
        latest_hash: string;
        pending_intake_id: string | null;
        version: number;
      };
      assert.equal(projected.latest_hash, input.rawHash);
      assert.deepEqual(projected, acceptedBefore);
      assert.equal(untrusted.version, (acceptedBefore as { version: number }).version);
      assert.equal(
        (
          await root!.query(
            "SELECT count(*)::integer AS n FROM rpt.order_reconciliation_event WHERE tenant_id=$1 AND source_system='API' AND external_id=$2",
            [f.a.tenant, input.externalId],
          )
        ).rows[0]?.n,
        eventCountBefore,
      );
      assert.equal(
        (
          await root!.query(
            "SELECT count(*)::integer AS n FROM rpt.source_observation WHERE domain_key='order_reconciliation'",
          )
        ).rows[0]?.n,
        observationCount,
      );
      assert.equal(
        (
          await root!.query('SELECT intake_id FROM rpt.order_reconciliation_event WHERE id=$1', [
            (acceptedBefore as { last_event_id: string }).last_event_id,
          ])
        ).rows[0]?.intake_id === untrusted.intakeId,
        false,
      );
      assert.equal(
        (
          await root!.query(
            'SELECT count(*)::integer AS n FROM rpt.order_external_intake WHERE id=$1',
            [untrusted.intakeId],
          )
        ).rows[0]?.n,
        1,
      );
    });
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
