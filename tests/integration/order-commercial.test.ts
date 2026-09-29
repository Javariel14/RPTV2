import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError, orderCancel, orderReplace, type Identity } from '@rpt/contracts';
import { startPostgres } from '../helpers/postgres.js';
import { orderCommercialFixture, lifecycleRequest as req } from '../helpers/order-commercial.js';
const denied = (e: unknown) =>
  e instanceof FoundationError && ['NOT_FOUND', 'FORBIDDEN'].includes(e.code);
const conflict = (e: unknown) => e instanceof FoundationError && e.code === 'CONFLICT';
const invalid = (e: unknown) => e instanceof FoundationError && e.code === 'INVALID_REQUEST';
void test('E3B4 real PostgreSQL commercial lifecycle, bootstrap, immutability and adversarial commands', async (t) => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  let f!: Awaited<ReturnType<typeof orderCommercialFixture>>;
  let historical!: Awaited<ReturnType<typeof f.create>>;
  let historicalBefore: unknown;
  try {
    root = await cluster.migrate('rpt_foundation', Infinity, async (r, count) => {
      if (count === 17) {
        root = r;
        f = await orderCommercialFixture(r, cluster.runtimeConfig());
        historical = await f.create(false, f.a.person, f.a.workspace, true);
        historicalBefore = (
          await r.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
            historical.id,
          ])
        ).rows[0].value;
      }
    });
    const { a, b, db, lifecycle, workflow, foundation } = f,
      advisor = a.identities.delegate;
    const state = (id: string, actor = advisor) =>
      lifecycle.getOrderCommercialState(actor, req(), id);
    const cancel = (
      id: string,
      version = 1,
      key = randomUUID(),
      actor = advisor,
      reason = 'Internal commercial cancellation only',
    ) =>
      lifecycle.cancelOrder(actor, req(), key, {
        schemaVersion: 1,
        orderId: id,
        expectedVersion: version,
        reason,
      });
    const replace = (
      id: string,
      next: string,
      key = randomUUID(),
      actor = advisor,
      version = 1,
      successorVersion = 1,
    ) =>
      lifecycle.replaceOrder(actor, req(), key, {
        schemaVersion: 1,
        orderId: id,
        successorOrderId: next,
        expectedVersion: version,
        successorExpectedVersion: successorVersion,
        reason: 'Independently accepted replacement',
      });
    const snapshot = async (id: string) =>
      (
        await root!.query(
          `SELECT jsonb_build_object('order',to_jsonb(o),'quote',to_jsonb(q),'version',to_jsonb(v),'acceptance',to_jsonb(a),'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.ordinal) FROM rpt.cpq_quote_line l WHERE l.tenant_id=o.tenant_id AND l.quote_version_id=o.quote_version_id)) AS value
 FROM rpt.cpq_order o JOIN rpt.cpq_quote q ON q.tenant_id=o.tenant_id AND q.id=o.quote_id JOIN rpt.cpq_quote_version v ON v.tenant_id=o.tenant_id AND v.id=o.quote_version_id JOIN rpt.quote_acceptance a ON a.tenant_id=o.tenant_id AND a.id=o.acceptance_id WHERE o.id=$1`,
          [id],
        )
      ).rows[0].value;
    const sqlDenied = async (actor: Identity, sql: string, values: unknown[], code = '42501') =>
      db.request(actor, req(), async (c) => {
        await c.query('SAVEPOINT lifecycle_attack');
        await assert.rejects(
          c.query(sql, values),
          (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === code,
        );
        await c.query('ROLLBACK TO SAVEPOINT lifecycle_attack');
      });
    await t.test(
      '18 clean forward migrations safely bootstrap a pre-E3B4 genuine canonical Order',
      async () => {
        assert.equal(
          (await root!.query('SELECT count(*)::integer AS n FROM public.foundation_migration'))
            .rows[0].n,
          18,
        );
        assert.deepEqual(
          (
            await root!.query('SELECT to_jsonb(o) AS value FROM rpt.cpq_order o WHERE id=$1', [
              historical.id,
            ])
          ).rows[0].value,
          historicalBefore,
        );
        const s = await state(historical.id),
          history = await lifecycle.listOrderCommercialHistory(advisor, req(), historical.id);
        assert.equal(s.status, 'created');
        assert.equal(s.version, 1);
        assert.equal(history.events.length, 1);
        assert.equal(history.events[0].operation, 'technical_bootstrap');
        assert.equal(history.events[0].actor_id, null);
        assert.equal(history.events[0].request_id, null);
        assert.match(history.events[0].reason, /historical business actor\/time not asserted/);
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM pg_tables JOIN pg_class c ON c.oid=(quote_ident(schemaname)||'.'||quote_ident(tablename))::regclass WHERE schemaname IN ('rpt','authz') AND NOT c.relrowsecurity",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'new canonical Orders initialize event and projection atomically with trusted runtime identity',
      async () => {
        const o = await f.create(),
          s = await state(o.id),
          h = await lifecycle.listOrderCommercialHistory(advisor, req(), o.id);
        assert.equal(s.version, 1);
        assert.equal(s.status, 'created');
        assert.equal(h.events.length, 1);
        assert.equal(h.events[0].operation, 'initialized');
        assert.equal(h.events[0].actor_id, a.users.delegate);
        assert.equal(h.events[0].id, s.last_event_id);
        assert.ok(h.events[0].request_id);
      },
    );
    await t.test(
      'cancellation appends reason/actor/audit and preserves Quote, acceptance, money, hash and ancestry',
      async () => {
        const before = await snapshot(historical.id),
          result = await cancel(historical.id);
        assert.ok(before.order.commercial_snapshot.financing);
        assert.equal(before.order.commercial_snapshot.appliedRules.length, 1);
        assert.ok(before.lines[0].snapshot.bundleComposition.length);
        assert.equal(result.status, 'cancelled');
        assert.equal(result.version, 2);
        assert.deepEqual(await snapshot(historical.id), before);
        const h = await lifecycle.listOrderCommercialHistory(advisor, req(), historical.id);
        assert.deepEqual(
          h.events.map((e) => e.sequence),
          [1, 2],
        );
        assert.equal(h.events[1].previous_state, 'created');
        assert.equal(h.events[1].actor_id, a.users.delegate);
        assert.equal(h.events[1].reason, 'Internal commercial cancellation only');
        assert.ok(
          (
            await root!.query('SELECT 1 FROM rpt.audit_event WHERE object_id=$1 AND actor_id=$2', [
              result.eventId,
              a.users.delegate,
            ])
          ).rowCount,
        );
        const first = await lifecycle.listOrderCommercialHistory(advisor, req(), historical.id, {
          limit: 1,
        });
        assert.equal(first.nextAfterSequence, 1);
        const second = await lifecycle.listOrderCommercialHistory(advisor, req(), historical.id, {
          afterSequence: first.nextAfterSequence,
          limit: 1,
        });
        assert.equal(second.events[0].sequence, 2);
        assert.equal(second.nextAfterSequence, null);
      },
    );
    await t.test(
      'terminal state, stale version and malformed client authority fail closed',
      async () => {
        await assert.rejects(cancel(historical.id, 2), conflict);
        const fresh = await f.create();
        await assert.rejects(cancel(fresh.id, 2), conflict);
        await assert.rejects(
          lifecycle.cancelOrder(advisor, req(), randomUUID(), {
            schemaVersion: 1,
            orderId: fresh.id,
            expectedVersion: 1,
            reason: 'Valid',
            marketId: f.co.marketId,
          }),
          invalid,
        );
        await assert.rejects(cancel(fresh.id, 1, randomUUID(), advisor, ' '), invalid);
        assert.equal((await state(fresh.id)).status, 'created');
      },
    );
    await t.test(
      'authorized direct SQL rejects whitespace-only terminal reasons atomically',
      async () => {
        const cancelled = await f.create();
        const original = await f.create(false, a.person, a.workspace, true);
        const successor = await f.create(false, a.person, a.workspace, true);
        const cancelledSnapshot = await snapshot(cancelled.id);
        const originalSnapshot = await snapshot(original.id);
        const successorSnapshot = await snapshot(successor.id);
        for (const [orderId, verb] of [
          [cancelled.id, 'cancel'],
          [original.id, 'replace'],
          [successor.id, 'replace'],
        ]) {
          assert.equal(
            await db.request(
              advisor,
              req(),
              async (c) =>
                (
                  await c.query('SELECT authz.order_commercial_right($1,$2) AS allowed', [
                    orderId,
                    verb,
                  ])
                ).rows[0].allowed,
            ),
            true,
          );
        }
        for (const reason of [' ', '     ', '\t', '\n', '\r', '\t\n', ' \t \n \r ']) {
          const cancelKey = randomUUID();
          const replaceKey = randomUUID();
          await sqlDenied(
            advisor,
            'SELECT authz.cancel_order($1,1,$2,$3)',
            [cancelled.id, cancelKey, reason],
            '23514',
          );
          await sqlDenied(
            advisor,
            'SELECT authz.replace_order($1,$2,1,1,$3,$4)',
            [original.id, successor.id, replaceKey, reason],
            '23514',
          );
          for (const id of [cancelled.id, original.id, successor.id]) {
            const current = await state(id);
            const history = await lifecycle.listOrderCommercialHistory(advisor, req(), id);
            assert.equal(current.status, 'created');
            assert.equal(current.version, 1);
            assert.equal(history.events.length, 1);
          }
          assert.equal(
            (
              await root!.query(
                "SELECT count(*)::integer AS n FROM authz.idempotency_receipt WHERE tenant_id=$1 AND operation IN ('order_commercial.cancel','order_commercial.replace') AND key IN ($2,$3)",
                [a.tenant, cancelKey, replaceKey],
              )
            ).rows[0].n,
            0,
          );
        }
        assert.deepEqual(await snapshot(cancelled.id), cancelledSnapshot);
        assert.deepEqual(await snapshot(original.id), originalSnapshot);
        assert.deepEqual(await snapshot(successor.id), successorSnapshot);
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.order_replacement WHERE original_order_id=$1',
              [original.id],
            )
          ).rows[0].n,
          0,
        );
        await root!.query('BEGIN');
        try {
          await assert.rejects(
            root!.query(
              "INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,reason,actor_id,request_id) VALUES($1,$2,$3,$4,$5,2,'cancel','created','cancelled',$6,$7,$8)",
              [
                a.tenant,
                randomUUID(),
                cancelled.id,
                a.workspace,
                f.ec.marketId,
                '\t',
                a.users.delegate,
                req(),
              ],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
        } finally {
          await root!.query('ROLLBACK');
        }
        assert.equal((await state(cancelled.id)).status, 'created');
        assert.equal(
          (await lifecycle.listOrderCommercialHistory(advisor, req(), cancelled.id)).events.length,
          1,
        );
        const directCancel = await db.request(
          advisor,
          req(),
          async (c) =>
            (
              await c.query('SELECT authz.cancel_order($1,1,$2,$3) AS result', [
                cancelled.id,
                randomUUID(),
                'Cliente solicitó cancelar',
              ])
            ).rows[0].result,
        );
        assert.equal(directCancel.status, 'cancelled');
        const directReplace = await db.request(
          advisor,
          req(),
          async (c) =>
            (
              await c.query('SELECT authz.replace_order($1,$2,1,1,$3,$4) AS result', [
                original.id,
                successor.id,
                randomUUID(),
                'Corrección de datos comerciales',
              ])
            ).rows[0].result,
        );
        assert.equal(directReplace.status, 'superseded');
        const surrounded = await f.create();
        await db.request(advisor, req(), async (c) =>
          c.query('SELECT authz.cancel_order($1,1,$2,$3)', [
            surrounded.id,
            randomUUID(),
            '\tCliente solicitó cambio\t',
          ]),
        );
        const surroundedHistory = await lifecycle.listOrderCommercialHistory(
          advisor,
          req(),
          surrounded.id,
        );
        assert.equal(surroundedHistory.events[1].reason, '\tCliente solicitó cambio\t');
      },
    );
    await t.test(
      'ECMAScript reason whitespace is rejected independently of PostgreSQL locale',
      async () => {
        const cancelled = await f.create();
        const original = await f.create(false, a.person, a.workspace, true);
        const successor = await f.create(false, a.person, a.workspace, true);
        const before = [
          await snapshot(cancelled.id),
          await snapshot(original.id),
          await snapshot(successor.id),
        ];
        for (const [id, verb] of [
          [cancelled.id, 'cancel'],
          [original.id, 'replace'],
          [successor.id, 'replace'],
        ]) {
          assert.equal(
            await db.request(
              advisor,
              req(),
              async (c) =>
                (await c.query('SELECT authz.order_commercial_right($1,$2) AS allowed', [id, verb]))
                  .rows[0].allowed,
            ),
            true,
          );
        }
        const whitespaceCodePoints = [
          0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
          0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
          0x205f, 0x3000, 0xfeff,
        ];
        const whitespaceOnly = [
          ...whitespaceCodePoints.map((cp) => String.fromCodePoint(cp)),
          ' \u00a0\t',
          '\u00a0\u2009\n',
          '\u3000\u202f\r',
        ];
        const keys: string[] = [];
        for (const reason of whitespaceOnly) {
          assert.equal(reason.trim().length, 0);
          assert.equal(
            orderCancel.safeParse({
              schemaVersion: 1,
              orderId: cancelled.id,
              expectedVersion: 1,
              reason,
            }).success,
            false,
          );
          assert.equal(
            orderReplace.safeParse({
              schemaVersion: 1,
              orderId: original.id,
              successorOrderId: successor.id,
              expectedVersion: 1,
              successorExpectedVersion: 1,
              reason,
            }).success,
            false,
          );
          assert.equal(
            (await root!.query('SELECT authz.order_commercial_reason_valid($1) AS valid', [reason]))
              .rows[0].valid,
            false,
          );
          const cancelKey = randomUUID();
          const replaceKey = randomUUID();
          keys.push(cancelKey, replaceKey);
          await sqlDenied(
            advisor,
            'SELECT authz.cancel_order($1,1,$2,$3)',
            [cancelled.id, cancelKey, reason],
            '23514',
          );
          await sqlDenied(
            advisor,
            'SELECT authz.replace_order($1,$2,1,1,$3,$4)',
            [original.id, successor.id, replaceKey, reason],
            '23514',
          );
        }
        const nullCancelKey = randomUUID();
        const nullReplaceKey = randomUUID();
        keys.push(nullCancelKey, nullReplaceKey);
        assert.equal(
          (await root!.query('SELECT authz.order_commercial_reason_valid(NULL) AS valid')).rows[0]
            .valid,
          false,
        );
        await sqlDenied(
          advisor,
          'SELECT authz.cancel_order($1,1,$2,$3)',
          [cancelled.id, nullCancelKey, null],
          '23514',
        );
        await sqlDenied(
          advisor,
          'SELECT authz.replace_order($1,$2,1,1,$3,$4)',
          [original.id, successor.id, nullReplaceKey, null],
          '23514',
        );
        for (const o of [cancelled, original, successor]) {
          const s = await state(o.id);
          const h = await lifecycle.listOrderCommercialHistory(advisor, req(), o.id);
          assert.equal(s.status, 'created');
          assert.equal(s.version, 1);
          assert.equal(h.events.length, 1);
        }
        assert.deepEqual(
          [await snapshot(cancelled.id), await snapshot(original.id), await snapshot(successor.id)],
          before,
        );
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.order_replacement WHERE original_order_id=$1',
              [original.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await root!.query(
              "SELECT count(*)::integer AS n FROM authz.idempotency_receipt WHERE tenant_id=$1 AND key=ANY($2::text[]) AND operation IN ('order_commercial.cancel','order_commercial.replace')",
              [a.tenant, keys],
            )
          ).rows[0].n,
          0,
        );
        for (const reason of ['\u00a0', '\ufeff']) {
          await root!.query('BEGIN');
          try {
            await assert.rejects(
              root!.query(
                "INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,reason,actor_id,request_id) VALUES($1,$2,$3,$4,$5,2,'cancel','created','cancelled',$6,$7,$8)",
                [
                  a.tenant,
                  randomUUID(),
                  cancelled.id,
                  a.workspace,
                  f.ec.marketId,
                  reason,
                  a.users.delegate,
                  req(),
                ],
              ),
              (e: unknown) =>
                typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
            );
          } finally {
            await root!.query('ROLLBACK');
          }
        }
        const validReasons = [
          'Cliente solicitó cancelar',
          'Corrección de datos comerciales',
          'Cliente pidió cambio de dirección',
          'José solicitó modificación',
          '\u00a0Cliente solicitó cambio\u00a0',
          '\u3000Cliente solicitó cambio\u3000',
          '\u200b',
        ];
        for (const reason of validReasons) {
          const appValid = orderCancel.safeParse({
            schemaVersion: 1,
            orderId: cancelled.id,
            expectedVersion: 1,
            reason,
          }).success;
          const databaseValid = (
            await root!.query('SELECT authz.order_commercial_reason_valid($1) AS valid', [reason])
          ).rows[0].valid;
          assert.equal(appValid, true);
          assert.equal(databaseValid, appValid);
        }
        const surroundedNbsp = await f.create();
        const nbReason = '\u00a0Cliente solicitó cambio\u00a0';
        await db.request(advisor, req(), async (c) =>
          c.query('SELECT authz.cancel_order($1,1,$2,$3)', [
            surroundedNbsp.id,
            randomUUID(),
            nbReason,
          ]),
        );
        assert.equal(
          (await lifecycle.listOrderCommercialHistory(advisor, req(), surroundedNbsp.id)).events[1]
            .reason,
          nbReason,
        );
        const surroundingIdeographicOriginal = await f.create(false, a.person, a.workspace, true);
        const surroundingIdeographicSuccessor = await f.create(false, a.person, a.workspace, true);
        const ideographicReason = '\u3000Cliente solicitó cambio\u3000';
        await db.request(advisor, req(), async (c) =>
          c.query('SELECT authz.replace_order($1,$2,1,1,$3,$4)', [
            surroundingIdeographicOriginal.id,
            surroundingIdeographicSuccessor.id,
            randomUUID(),
            ideographicReason,
          ]),
        );
        assert.equal(
          (
            await lifecycle.listOrderCommercialHistory(
              advisor,
              req(),
              surroundingIdeographicOriginal.id,
            )
          ).events[1].reason,
          ideographicReason,
        );
        const zeroWidth = await f.create();
        await db.request(advisor, req(), async (c) =>
          c.query('SELECT authz.cancel_order($1,1,$2,$3)', [zeroWidth.id, randomUUID(), '\u200b']),
        );
        assert.equal(
          (await lifecycle.listOrderCommercialHistory(advisor, req(), zeroWidth.id)).events[1]
            .reason,
          '\u200b',
        );
      },
    );
    await t.test(
      'identical receipts replay exactly, changed payload conflicts and revoked retry is denied',
      async () => {
        const o = await f.create(),
          key = randomUUID(),
          first = await cancel(o.id, 1, key);
        assert.deepEqual(await cancel(o.id, 1, key), first);
        await assert.rejects(cancel(o.id, 1, key, advisor, 'Changed reason'), conflict);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='cancel'",
          [a.tenant, a.users.delegate],
        );
        await assert.rejects(cancel(o.id, 1, key), denied);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='cancel'",
          [a.tenant, a.users.delegate],
        );
        assert.equal(
          (await lifecycle.listOrderCommercialHistory(advisor, req(), o.id)).events.length,
          2,
        );
      },
    );
    await t.test(
      'retry of original Quote-to-Order conversion never reactivates cancelled source',
      async () => {
        assert.deepEqual(
          await workflow.createOrderFromAcceptedQuote(
            advisor,
            req(),
            historical.key,
            historical.input,
          ),
          { id: historical.id },
        );
        assert.deepEqual(
          await workflow.createOrderFromAcceptedQuote(
            advisor,
            req(),
            randomUUID(),
            historical.input,
          ),
          { id: historical.id },
        );
        assert.equal((await state(historical.id)).status, 'cancelled');
      },
    );
    let original!: Awaited<ReturnType<typeof f.create>>, successor!: typeof original;
    await t.test(
      'replacement references an independently accepted successor without repricing or mutating either snapshot',
      async () => {
        original = await f.create(false, a.person, a.workspace, true);
        successor = await f.create(false, a.person, a.workspace, true);
        assert.notEqual(original.quoteId, successor.quoteId);
        assert.notEqual(original.acceptanceId, successor.acceptanceId);
        const before = await snapshot(original.id),
          nextBefore = await snapshot(successor.id),
          key = randomUUID();
        const result = await replace(original.id, successor.id, key);
        assert.equal(result.status, 'superseded');
        assert.ok(result.replacementId);
        assert.deepEqual(await replace(original.id, successor.id, key), result);
        assert.deepEqual(await snapshot(original.id), before);
        assert.deepEqual(await snapshot(successor.id), nextBefore);
        assert.equal((await state(successor.id)).status, 'created');
        assert.equal((await state(successor.id)).version, 1);
        const r = (
          await root!.query('SELECT * FROM rpt.order_replacement WHERE id=$1', [
            result.replacementId,
          ])
        ).rows[0];
        assert.equal(r.original_order_id, original.id);
        assert.equal(r.successor_order_id, successor.id);
        assert.equal(r.event_id, result.eventId);
        assert.deepEqual(
          await workflow.createOrderFromAcceptedQuote(advisor, req(), original.key, original.input),
          { id: original.id },
        );
        assert.equal((await state(original.id)).status, 'superseded');
      },
    );
    await t.test(
      'self, duplicate predecessor/successor, terminal and cyclic replacements are rejected',
      async () => {
        await assert.rejects(replace(successor.id, successor.id), invalid);
        await assert.rejects(cancel(original.id, 2), conflict);
        const third = await f.create();
        await assert.rejects(replace(original.id, third.id), conflict);
        await assert.rejects(replace(third.id, successor.id), conflict);
        await assert.rejects(replace(successor.id, original.id), conflict);
        const fourth = await f.create();
        await replace(successor.id, fourth.id);
        await assert.rejects(replace(fourth.id, original.id), conflict);
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.order_replacement WHERE original_order_id=$1',
              [original.id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'unknown and different identified customers cannot be treated as equivalent',
      async () => {
        const unknown1 = await f.create(false, null),
          unknown2 = await f.create(false, null);
        await assert.rejects(replace(unknown1.id, unknown2.id), invalid);
        const person = randomUUID();
        await root!.query(
          "INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle) VALUES($1,$2,$3,$4,'Synthetic different customer','advisor')",
          [a.tenant, person, a.workspace, a.users.owner],
        );
        const x = await f.create(),
          y = await f.create(false, person);
        await assert.rejects(replace(x.id, y.id), invalid);
        assert.equal((await state(x.id)).status, 'created');
      },
    );
    await t.test('real concurrent cancellation produces one transition', async () => {
      const o = await f.create(),
        results = await Promise.allSettled([cancel(o.id), cancel(o.id)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected' && conflict(r.reason)).length, 1);
      assert.equal(
        (await lifecycle.listOrderCommercialHistory(advisor, req(), o.id)).events.length,
        2,
      );
    });
    await t.test(
      'cancel versus replace and competing replacements serialize to one canonical terminal outcome',
      async () => {
        const o = await f.create(),
          n = await f.create();
        const results = await Promise.allSettled([cancel(o.id), replace(o.id, n.id)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          results.filter((r) => r.status === 'rejected' && conflict(r.reason)).length,
          1,
        );
        const p = await f.create(),
          q = await f.create(),
          z = await f.create();
        const competing = await Promise.allSettled([replace(p.id, q.id), replace(p.id, z.id)]);
        assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          competing.filter((r) => r.status === 'rejected' && conflict(r.reason)).length,
          1,
        );
        const left = await f.create(),
          right = await f.create(),
          target = await f.create();
        const sameSuccessor = await Promise.allSettled([
          replace(left.id, target.id),
          replace(right.id, target.id),
        ]);
        assert.equal(sameSuccessor.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          (
            await root!.query(
              'SELECT count(*)::integer AS n FROM rpt.order_replacement WHERE successor_order_id=$1',
              [target.id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    const foreign = await f.create(true);
    await t.test(
      'equivalent-capability tenant/market actors and known UUIDs cannot read or mutate foreign Orders',
      async () => {
        const local = await f.create();
        for (const actor of [advisor, b.identities.delegate]) {
          await db.request(actor, req(), async (c, a) =>
            assert.equal(
              (await c.query('SELECT authz.operational_market() AS market')).rows[0].market,
              a.tenantId === b.tenant ? b.market : f.ec.marketId,
            ),
          );
          await db.request(actor, req(), async (c, a) =>
            assert.equal(
              (
                await c.query(
                  "SELECT authz.tenant_allowed($1,'cpq_order','cancel','CONFIDENTIAL') AS allowed",
                  [a.tenantId],
                )
              ).rows[0].allowed,
              true,
            ),
          );
          await assert.rejects(state(foreign.id, actor), denied);
          await assert.rejects(cancel(foreign.id, 1, randomUUID(), actor), denied);
          await assert.rejects(replace(local.id, foreign.id, randomUUID(), actor), denied);
          await db.request(actor, req(), async (c) => {
            for (const table of ['order_commercial_state', 'order_commercial_event'])
              assert.equal(
                (await c.query('SELECT * FROM rpt.' + table + ' WHERE order_id=$1', [foreign.id]))
                  .rowCount,
                0,
              );
            assert.equal(
              (
                await c.query('SELECT * FROM rpt.order_replacement WHERE original_order_id=$1', [
                  original.id,
                ])
              ).rowCount,
              actor === advisor ? 1 : 0,
            );
          });
        }
        await assert.rejects(state(local.id, b.identities.delegate), denied);
        await sqlDenied(advisor, 'SELECT authz.cancel_order($1,1,$2,$3)', [
          foreign.id,
          randomUUID(),
          'Foreign market SQL',
        ]);
        await sqlDenied(b.identities.delegate, 'SELECT authz.cancel_order($1,1,$2,$3)', [
          local.id,
          randomUUID(),
          'Foreign tenant SQL',
        ]);
        assert.equal((await state(local.id)).status, 'created');
      },
    );
    await t.test(
      'Country Admin cannot cross scope; Regional Admin requires explicit market scope and capability',
      async () => {
        const country = a.identities.ancestor;
        await assert.rejects(cancel(foreign.id, 1, randomUUID(), country), denied);
        await foundation.grantAdminMarketScope(
          a.identities.owner,
          req(),
          { schemaVersion: 1, userId: a.users.ancestor, marketId: f.co.marketId },
          randomUUID(),
        );
        assert.equal((await cancel(foreign.id, 1, randomUUID(), country)).status, 'cancelled');
        const another = await f.create(true);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_order' AND verb='cancel'",
          [a.tenant, a.users.ancestor],
        );
        await assert.rejects(cancel(another.id, 1, randomUUID(), country), denied);
      },
    );
    await t.test(
      'workspace scope is additive even with correct tenant, market, object and commercial capability',
      async () => {
        const local = await f.create();
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_quote' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        await assert.rejects(state(local.id), denied);
        await assert.rejects(cancel(local.id), denied);
        await root!.query(
          "UPDATE authz.workspace_permission SET revoked_at=NULL WHERE tenant_id=$1 AND user_id=$2 AND object_type='cpq_quote' AND verb='read'",
          [a.tenant, a.users.delegate],
        );
        assert.equal((await state(local.id)).status, 'created');
      },
    );
    await t.test(
      'known Order UUID in another workspace is denied without workspace permission',
      async () => {
        const workspace = randomUUID();
        await root!.query(
          "INSERT INTO rpt.crm_workspace(tenant_id,id,name,kind) VALUES($1,$2,'Synthetic foreign workspace','commercial')",
          [a.tenant, workspace],
        );
        await f.grant(a, 'delegate', 'cpq_quote', ['read', 'create', 'issue', 'accept'], workspace);
        await f.grant(
          a,
          'delegate',
          'cpq_order',
          ['read', 'create', 'cancel', 'replace'],
          workspace,
        );
        const foreignWorkspaceOrder = await f.create(false, null, workspace);
        assert.equal((await state(foreignWorkspaceOrder.id)).workspace_id, workspace);
        await root!.query(
          'UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2 AND workspace_id=$3',
          [a.tenant, a.users.delegate, workspace],
        );
        await assert.rejects(state(foreignWorkspaceOrder.id), denied);
        await assert.rejects(cancel(foreignWorkspaceOrder.id), denied);
        await sqlDenied(advisor, 'SELECT authz.cancel_order($1,1,$2,$3)', [
          foreignWorkspaceOrder.id,
          randomUUID(),
          'Foreign workspace direct SQL',
        ]);
        const local = await f.create();
        assert.equal((await state(local.id)).workspace_id, a.workspace);
      },
    );
    await t.test(
      'Quote/Approval/Pricing authority does not implicitly grant Order mutation',
      async () => {
        const o = await f.create();
        await root!.query(
          "UPDATE authz.role_capability SET verb='cancel_suspended' WHERE tenant_id=$1 AND role_key='delegate' AND object_type='cpq_order' AND verb='cancel'",
          [a.tenant],
        );
        await assert.rejects(cancel(o.id), denied);
        assert.equal((await state(o.id)).status, 'created');
        await root!.query(
          "UPDATE authz.role_capability SET verb='cancel' WHERE tenant_id=$1 AND role_key='delegate' AND object_type='cpq_order' AND verb='cancel_suspended'",
          [a.tenant],
        );
      },
    );
    await t.test(
      'direct SQL cannot bypass state/event/replacement immutability, private helpers or terminal guards',
      async () => {
        const o = await f.create();
        // Even a privileged fixture write must satisfy the relational context guard.
        await root!.query('BEGIN');
        try {
          await assert.rejects(
            root!.query(
              "INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,reason,actor_id,request_id) VALUES($1,$2,$3,$4,$5,2,'cancel','created','cancelled','Scope tamper',$6,$7)",
              [a.tenant, randomUUID(), o.id, a.workspace, f.co.marketId, a.users.delegate, req()],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
        } finally {
          await root!.query('ROLLBACK');
        }
        await root!.query('BEGIN');
        try {
          await assert.rejects(
            root!.query(
              "INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,reason,actor_id,request_id) VALUES($1,$2,$3,$4,$5,2,'cancel',NULL,'cancelled','Missing previous state',$6,$7)",
              [a.tenant, randomUUID(), o.id, a.workspace, f.ec.marketId, a.users.delegate, req()],
            ),
            (e: unknown) =>
              typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
          );
        } finally {
          await root!.query('ROLLBACK');
        }
        for (const sql of [
          "UPDATE rpt.order_commercial_state SET status='cancelled' WHERE order_id=$1",
          'DELETE FROM rpt.order_commercial_state WHERE order_id=$1',
          "UPDATE rpt.order_commercial_event SET reason='Changed' WHERE order_id=$1",
          'DELETE FROM rpt.order_commercial_event WHERE order_id=$1',
          "UPDATE rpt.cpq_order SET currency='MXN' WHERE id=$1",
        ])
          await sqlDenied(advisor, sql, [o.id]);
        await sqlDenied(
          advisor,
          'INSERT INTO rpt.order_commercial_state SELECT * FROM rpt.order_commercial_state WHERE order_id=$1',
          [o.id],
        );
        await sqlDenied(
          advisor,
          'INSERT INTO rpt.order_commercial_event SELECT * FROM rpt.order_commercial_event WHERE order_id=$1',
          [o.id],
        );
        await sqlDenied(
          advisor,
          'INSERT INTO rpt.order_replacement SELECT * FROM rpt.order_replacement',
          [],
        );
        await sqlDenied(advisor, 'UPDATE rpt.order_replacement SET successor_order_id=$1', [o.id]);
        await sqlDenied(advisor, 'DELETE FROM rpt.order_replacement', []);
        await sqlDenied(advisor, 'SELECT authz.order_commercial_mutate($1,NULL,1,NULL,$2,$3)', [
          o.id,
          randomUUID(),
          'Private helper',
        ]);
        await sqlDenied(
          advisor,
          'SELECT authz.replace_order($1,$1,1,1,$2,$3)',
          [o.id, randomUUID(), 'Self replace'],
          '23514',
        );
        await cancel(o.id);
        await sqlDenied(
          advisor,
          'SELECT authz.cancel_order($1,2,$2,$3)',
          [o.id, randomUUID(), 'Terminal SQL'],
          '40001',
        );
      },
    );
    await t.test(
      'same UUID Order/event subject collision cannot authorize foreign-market evidence',
      async () => {
        const foreignOrder = await f.create(true),
          local = await f.create();
        await root!.query(
          "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_USER','order_commercial','manual')",
          [a.tenant, a.users.ai],
        );
        const observation = await lifecycle.appendOrderCommercialEvidence(a.identities.ai, req(), {
          schemaVersion: 1,
          subjectType: 'order',
          subjectId: foreignOrder.id,
          evidence: f.evidence('Synthetic CO Order evidence'),
        });
        // Privileged fixture creates a valid local cancellation event with EXACT foreign Order UUID.
        // Runtime assertions below still execute as EC/CO actors through actual RLS.
        await root!.query(
          "INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,reason,actor_id,request_id) VALUES($1,$2,$3,$4,$5,2,'cancel','created','cancelled','Synthetic collision fixture',$6,$7)",
          [
            a.tenant,
            foreignOrder.id,
            local.id,
            a.workspace,
            f.ec.marketId,
            a.users.delegate,
            req(),
          ],
        );
        await root!.query(
          "UPDATE rpt.order_commercial_state SET status='cancelled',version=2,last_event_id=$1 WHERE tenant_id=$2 AND order_id=$3",
          [foreignOrder.id, a.tenant, local.id],
        );
        await db.request(advisor, req(), async (c) => {
          assert.equal(
            (
              await c.query('SELECT * FROM rpt.order_commercial_event WHERE id=$1', [
                foreignOrder.id,
              ])
            ).rowCount,
            1,
          );
          assert.equal(
            (await c.query('SELECT * FROM rpt.source_observation WHERE id=$1', [observation.id]))
              .rowCount,
            0,
          );
          assert.equal(
            (
              await c.query("SELECT authz.order_commercial_subject($1,'order','read') AS allowed", [
                foreignOrder.id,
              ])
            ).rows[0].allowed,
            false,
          );
          assert.equal(
            (
              await c.query(
                "SELECT authz.order_commercial_subject($1,'order_event','read') AS allowed",
                [foreignOrder.id],
              )
            ).rows[0].allowed,
            true,
          );
          assert.equal(
            (
              await c.query(
                "SELECT authz.order_commercial_subject($1,'order_replacement','read') AS allowed",
                [foreignOrder.id],
              )
            ).rows[0].allowed,
            false,
          );
        });
        const localObservation = await lifecycle.appendOrderCommercialEvidence(advisor, req(), {
          schemaVersion: 1,
          subjectType: 'order_event',
          subjectId: foreignOrder.id,
          evidence: f.evidence('Synthetic EC event evidence'),
        });
        await db.request(a.identities.ai, req(), async (c) =>
          assert.equal(
            (
              await c.query('SELECT * FROM rpt.source_observation WHERE id=$1', [
                localObservation.id,
              ])
            ).rowCount,
            0,
          ),
        );
        await assert.rejects(
          lifecycle.appendOrderCommercialEvidence(advisor, req(), {
            schemaVersion: 1,
            subjectType: 'order',
            subjectId: foreignOrder.id,
            evidence: f.evidence('Foreign append'),
          }),
          denied,
        );
        await assert.rejects(
          lifecycle.appendOrderCommercialEvidence(advisor, req(), {
            schemaVersion: 1,
            subjectType: 'order_replacement',
            subjectId: foreignOrder.id,
            evidence: f.evidence('Wrong entity kind'),
          }),
          denied,
        );
        const coOriginal = await f.create(true),
          coSuccessor = await f.create(true);
        const relation = await replace(
          coOriginal.id,
          coSuccessor.id,
          randomUUID(),
          a.identities.ai,
        );
        const relationEvidence = await lifecycle.appendOrderCommercialEvidence(
          a.identities.ai,
          req(),
          {
            schemaVersion: 1,
            subjectType: 'order_replacement',
            subjectId: relation.replacementId!,
            evidence: f.evidence('Synthetic CO replacement evidence'),
          },
        );
        const localWithAliasedEvent = await f.create();
        await root!.query(
          "INSERT INTO rpt.order_commercial_event(tenant_id,id,order_id,workspace_id,market_id,sequence,operation,previous_state,resulting_state,reason,actor_id,request_id) VALUES($1,$2,$3,$4,$5,2,'cancel','created','cancelled','Synthetic replacement/event collision',$6,$7)",
          [
            a.tenant,
            relation.replacementId,
            localWithAliasedEvent.id,
            a.workspace,
            f.ec.marketId,
            a.users.delegate,
            req(),
          ],
        );
        await root!.query(
          "UPDATE rpt.order_commercial_state SET status='cancelled',version=2,last_event_id=$1 WHERE tenant_id=$2 AND order_id=$3",
          [relation.replacementId, a.tenant, localWithAliasedEvent.id],
        );
        await db.request(advisor, req(), async (c) => {
          assert.equal(
            (
              await c.query(
                "SELECT authz.order_commercial_subject($1,'order_event','read') AS allowed",
                [relation.replacementId],
              )
            ).rows[0].allowed,
            true,
          );
          assert.equal(
            (
              await c.query('SELECT * FROM rpt.order_replacement WHERE id=$1', [
                relation.replacementId,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await c.query('SELECT * FROM rpt.source_observation WHERE id=$1', [
                relationEvidence.id,
              ])
            ).rowCount,
            0,
          );
        });
      },
    );
  } finally {
    await root?.end();
    await cluster.stop();
  }
});

void test('E3B4 empty fresh PostgreSQL applies all 18 migrations with least-privilege helpers and RLS', async () => {
  const cluster = await startPostgres();
  let root: Awaited<ReturnType<typeof cluster.migrate>> | undefined;
  try {
    root = await cluster.migrate();
    assert.equal(
      (await root.query('SELECT count(*)::integer AS n FROM public.foundation_migration')).rows[0]
        .n,
      18,
    );
    for (const table of ['order_commercial_state', 'order_commercial_event', 'order_replacement']) {
      const privileges: { read: boolean; write: boolean } = (
        await root.query<{ read: boolean; write: boolean }>(
          "SELECT has_table_privilege('rpt_runtime',$1,'SELECT') AS read, has_table_privilege('rpt_runtime',$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS write",
          ['rpt.' + table],
        )
      ).rows[0]!;
      assert.equal(privileges.read, true);
      assert.equal(privileges.write, false);
    }
    for (const name of [
      'order_commercial_mutate',
      'order_commercial_initialize',
      'order_commercial_source_guard',
      'order_commercial_projection_guard',
      'order_commercial_context_guard',
    ]) {
      const fn: { callable: boolean; proconfig: string[] } = (
        await root.query<{ callable: boolean; proconfig: string[] }>(
          "SELECT has_function_privilege('rpt_runtime',p.oid,'EXECUTE') AS callable,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname=$1",
          [name],
        )
      ).rows[0]!;
      assert.equal(fn.callable, false);
      assert.ok(fn.proconfig.includes('search_path=pg_catalog'));
    }
  } finally {
    await root?.end();
    await cluster.stop();
  }
});
