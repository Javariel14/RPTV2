import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError } from '@rpt/contracts';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { createApi } from '../../apps/api/src/app.js';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

void test('E2C Field Visits Core', async (t) => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const a = await seedCrm(root, 'visits-a', 1);
    const b = await seedCrm(root, 'visits-b', 1);
    for (const fixture of [a, b]) {
      for (const key of ['agenda_tasks_core', 'field_visits_core'])
        await root.query(
          `INSERT INTO rpt.feature_flag(
             tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from)
           VALUES($1,$2,$3,1,true,100,'2020-01-01')`,
          [fixture.tenant, randomUUID(), key],
        );
      for (const verb of ['read', 'create', 'update']) {
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','agenda_item',$2,'CONFIDENTIAL',false,1)",
          [fixture.tenant, verb],
        );
        await root.query(
          `INSERT INTO authz.workspace_permission(
             tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
           VALUES($1,$2,$3,$4,'agenda_item',$5,'CONFIDENTIAL',1)`,
          [fixture.tenant, randomUUID(), fixture.workspace, fixture.users.owner, verb],
        );
        for (const field of ['CONFIDENTIAL', 'RESTRICTED_LOCATION']) {
          await root.query(
            "INSERT INTO authz.role_capability VALUES($1,'owner','field_visit',$2,$3,false,1)",
            [fixture.tenant, verb, field],
          );
          await root.query(
            `INSERT INTO authz.workspace_permission(
               tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
             VALUES($1,$2,$3,$4,'field_visit',$5,$6,1)`,
            [fixture.tenant, randomUUID(), fixture.workspace, fixture.users.owner, verb, field],
          );
        }
      }
      for (const verb of ['read', 'update'])
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'delegate','field_visit',$2,'CONFIDENTIAL',false,1)",
          [fixture.tenant, verb],
        );
    }

    const service = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
    const fieldContext = await service.fieldVisitContext(a.identities.owner, randomUUID());
    assert.equal(fieldContext.workspaceId, a.workspace);
    const appointmentInput = {
      schemaVersion: 1 as const,
      type: 'appointment' as const,
      workspaceId: a.workspace,
      title: 'Synthetic field appointment',
      summary: 'No customer data',
      startsAt: '2026-10-10T15:00:00-05:00',
      endsAt: '2026-10-10T16:00:00-05:00',
      timezone: 'America/Guayaquil',
      source: 'commercial_crm' as const,
      personId: a.persons[0],
      opportunityId: a.ids[0],
      recruitmentProfileId: null,
      recurrence: null,
      reminderMinutesBefore: [60],
      travel: {
        originLabel: 'Synthetic office',
        destinationLabel: 'Synthetic destination',
        estimatedTravelMinutes: 20,
        preparationMinutes: 10,
      },
    };
    const appointment = await service.createAgendaItem(
      a.identities.owner,
      randomUUID(),
      appointmentInput,
      'visit-agenda-create-01',
    );
    const linkedInput = {
      schemaVersion: 1 as const,
      workspaceId: a.workspace,
      agendaItemId: appointment.id,
      personId: null,
      opportunityId: null,
      scheduledAt: null,
      purpose: 'Synthetic product followup',
    };
    const linked = await service.createFieldVisit(
      a.identities.owner,
      randomUUID(),
      linkedInput,
      'visit-create-linked-01',
    );

    await t.test('create reuses an authorized appointment without duplicating Agenda', async () => {
      const replay = await service.createFieldVisit(
        a.identities.owner,
        randomUUID(),
        linkedInput,
        'visit-create-linked-01',
      );
      assert.deepEqual(replay, linked);
      const detail = await service.detailFieldVisit(a.identities.owner, randomUUID(), linked.id);
      assert.equal(detail.agendaItemId, appointment.id);
      assert.equal(detail.personId, a.persons[0]);
      assert.equal(detail.opportunityId, a.ids[0]);
      assert.equal(detail.travel?.estimatedTravelMinutes, 20);
      assert.equal(
        Number(
          (
            await root.query('SELECT count(*) n FROM rpt.agenda_item WHERE tenant_id=$1', [
              a.tenant,
            ])
          ).rows[0].n,
        ),
        1,
      );
    });

    await t.test('range, owner and status filters are tenant isolated and API-shaped', async () => {
      const rows = await service.listFieldVisits(a.identities.owner, randomUUID(), {
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        owner: 'mine',
        status: 'planned',
      });
      assert.deepEqual(
        rows.rows.map((row) => row.id),
        [linked.id],
      );
      assert.equal(
        (
          await service.listFieldVisits(b.identities.owner, randomUUID(), {
            from: '2026-10-01T00:00:00Z',
            to: '2026-11-01T00:00:00Z',
          })
        ).rows.length,
        0,
      );
      await assert.rejects(
        service.detailFieldVisit(b.identities.owner, randomUUID(), linked.id),
        (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
      );
      const api = createApi(service, { verify: async () => a.identities.owner });
      const response = await api.request(
        `/v1/visits?config=${encodeURIComponent(JSON.stringify({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }))}`,
        { headers: { Authorization: 'Bearer synthetic' } },
      );
      assert.equal(response.status, 200);
    });

    await t.test('check-in and check-out are idempotent and use server timestamps', async () => {
      const checkIn = {
        schemaVersion: 1 as const,
        expectedVersion: 1,
        command: {
          type: 'check_in' as const,
          location: {
            latitude: -0.180653,
            longitude: -78.467834,
            accuracyMeters: 12.5,
            source: 'device_explicit' as const,
            consentContext: 'explicit_visit_action' as const,
          },
        },
      };
      const started = await service.commandFieldVisit(
        a.identities.owner,
        randomUUID(),
        linked.id,
        checkIn,
        'visit-checkin-01',
      );
      assert.deepEqual(
        await service.commandFieldVisit(
          a.identities.owner,
          randomUUID(),
          linked.id,
          checkIn,
          'visit-checkin-01',
        ),
        started,
      );
      const checkOut = {
        schemaVersion: 1 as const,
        expectedVersion: 2,
        command: {
          type: 'check_out' as const,
          outcome: 'Followup agreed',
          notes: 'Synthetic objective note',
          location: {
            latitude: -0.1807,
            longitude: -78.4679,
            accuracyMeters: null,
            source: 'device_explicit' as const,
            consentContext: 'explicit_visit_action' as const,
          },
        },
      };
      const completed = await service.commandFieldVisit(
        a.identities.owner,
        randomUUID(),
        linked.id,
        checkOut,
        'visit-checkout-01',
      );
      assert.deepEqual(
        await service.commandFieldVisit(
          a.identities.owner,
          randomUUID(),
          linked.id,
          checkOut,
          'visit-checkout-01',
        ),
        completed,
      );
      const detail = await service.detailFieldVisit(a.identities.owner, randomUUID(), linked.id);
      assert.equal(detail.status, 'completed');
      assert.ok(Date.parse(detail.actualEnd!) >= Date.parse(detail.actualStart!));
      assert.equal(detail.locationEvidence.length, 2);
      assert.deepEqual(
        detail.locationEvidence.map((item) => item.purpose),
        ['visit_check_in', 'visit_check_out'],
      );
    });

    const directInput = (purpose: string, hour: number) => ({
      schemaVersion: 1 as const,
      workspaceId: a.workspace,
      agendaItemId: null,
      personId: null,
      opportunityId: null,
      scheduledAt: `2026-10-12T${hour.toString().padStart(2, '0')}:00:00Z`,
      purpose,
    });

    await t.test('checkout without check-in and concurrency conflicts fail closed', async () => {
      const visit = await service.createFieldVisit(
        a.identities.owner,
        randomUUID(),
        directInput('No premature checkout', 12),
        'visit-create-premature-01',
      );
      await assert.rejects(
        service.commandFieldVisit(
          a.identities.owner,
          randomUUID(),
          visit.id,
          {
            schemaVersion: 1,
            expectedVersion: 1,
            command: { type: 'check_out', outcome: 'Invalid', notes: null, location: null },
          },
          'visit-premature-checkout-01',
        ),
        (error) => error instanceof FoundationError && error.code === 'INVALID_REQUEST',
      );
      await assert.rejects(
        service.commandFieldVisit(
          a.identities.owner,
          randomUUID(),
          visit.id,
          {
            schemaVersion: 1,
            expectedVersion: 99,
            command: { type: 'check_in', location: null },
          },
          'visit-stale-version-01',
        ),
        (error) => error instanceof FoundationError && error.code === 'CONFLICT',
      );
    });

    await t.test('cancel and no-show are explicit terminal transitions', async () => {
      for (const [index, command] of ['cancel', 'no_show'].entries()) {
        const visit = await service.createFieldVisit(
          a.identities.owner,
          randomUUID(),
          directInput(`Terminal ${command}`, 13 + index),
          `visit-terminal-create-0${index + 1}`,
        );
        const result = await service.commandFieldVisit(
          a.identities.owner,
          randomUUID(),
          visit.id,
          { schemaVersion: 1, expectedVersion: 1, command: { type: command } },
          `visit-terminal-command-0${index + 1}`,
        );
        assert.equal(result.status, command === 'cancel' ? 'cancelled' : 'no_show');
        await assert.rejects(
          service.commandFieldVisit(
            a.identities.owner,
            randomUUID(),
            visit.id,
            { schemaVersion: 1, expectedVersion: 2, command: { type: 'check_in', location: null } },
            `visit-terminal-retry-0${index + 1}`,
          ),
          (error) => error instanceof FoundationError && error.code === 'INVALID_REQUEST',
        );
      }
    });

    await t.test(
      'Visit grants reveal neither CRM nor restricted location and revoke immediately',
      async () => {
        const grantIds: string[] = [];
        for (const verb of ['read', 'update']) {
          const grantId = randomUUID();
          grantIds.push(grantId);
          await root.query(
            `INSERT INTO authz.workspace_permission(
             tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
           VALUES($1,$2,$3,$4,'field_visit',$5,'CONFIDENTIAL',1)`,
            [a.tenant, grantId, a.workspace, a.users.delegate, verb],
          );
        }
        const delegated = await service.detailFieldVisit(
          a.identities.delegate,
          randomUUID(),
          linked.id,
        );
        assert.equal(delegated.agendaItemId, null);
        assert.equal(delegated.personId, null);
        assert.equal(delegated.opportunityId, null);
        assert.deepEqual(delegated.locationEvidence, []);
        assert.equal(delegated.travel, null);
        const protectedVisit = await service.createFieldVisit(
          a.identities.owner,
          randomUUID(),
          directInput('Location write protected', 18),
          'visit-location-protected-create',
        );
        await assert.rejects(
          service.commandFieldVisit(
            a.identities.delegate,
            randomUUID(),
            protectedVisit.id,
            {
              schemaVersion: 1,
              expectedVersion: 1,
              command: {
                type: 'check_in',
                location: {
                  latitude: -0.18,
                  longitude: -78.46,
                  accuracyMeters: null,
                  source: 'device_explicit',
                  consentContext: 'explicit_visit_action',
                },
              },
            },
            'visit-location-protected-command',
          ),
          (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
        );
        await assert.rejects(
          service.detailCrm(a.identities.delegate, randomUUID(), a.ids[0]!),
          (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
        );
        await root.query(
          'UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=ANY($2)',
          [a.tenant, grantIds],
        );
        await assert.rejects(
          service.detailFieldVisit(a.identities.delegate, randomUUID(), linked.id),
          (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
        );
        await assert.rejects(
          service.detailFieldVisit(a.identities.ancestor, randomUUID(), linked.id),
          (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
        );
      },
    );

    await t.test('location is optional and audit/provenance remain append-only', async () => {
      const visit = await service.createFieldVisit(
        a.identities.owner,
        randomUUID(),
        directInput('Location optional', 17),
        'visit-location-optional-create',
      );
      await service.commandFieldVisit(
        a.identities.owner,
        randomUUID(),
        visit.id,
        { schemaVersion: 1, expectedVersion: 1, command: { type: 'check_in', location: null } },
        'visit-location-optional-in',
      );
      await service.commandFieldVisit(
        a.identities.owner,
        randomUUID(),
        visit.id,
        {
          schemaVersion: 1,
          expectedVersion: 2,
          command: { type: 'check_out', outcome: 'Completed', notes: null, location: null },
        },
        'visit-location-optional-out',
      );
      const detail = await service.detailFieldVisit(a.identities.owner, randomUUID(), visit.id);
      assert.deepEqual(detail.locationEvidence, []);
      assert.deepEqual(
        detail.history.map((event) => event.action),
        ['created', 'checked_in', 'checked_out'],
      );
      const provenance = await root.query(
        `SELECT count(*) n FROM rpt.field_visit_event
         WHERE tenant_id=$1 AND visit_id=$2 AND source='RPT_USER' AND authority='manual'`,
        [a.tenant, visit.id],
      );
      assert.equal(Number(provenance.rows[0].n), 3);
      const audit = await root.query(
        `SELECT count(*) n FROM rpt.audit_event
         WHERE tenant_id=$1 AND object_type IN ('field_visit','field_visit_location','field_visit_event')`,
        [a.tenant],
      );
      assert.ok(Number(audit.rows[0].n) >= 12);
    });
  } finally {
    await root.end();
    await cluster.stop();
  }
});
