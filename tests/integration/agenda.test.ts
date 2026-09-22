import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FoundationError } from '@rpt/contracts';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { createApi } from '../../apps/api/src/app.js';
import { seedCrm } from '../helpers/crm-fixtures.js';
import { startPostgres } from '../helpers/postgres.js';

void test('E2A Agenda / Tasks Core', async (t) => {
  const cluster = await startPostgres();
  const root = await cluster.migrate();
  try {
    const a = await seedCrm(root, 'agenda-a', 1);
    const b = await seedCrm(root, 'agenda-b', 1);
    const recruitingWorkspace = randomUUID();
    const profileId = randomUUID();
    for (const fixture of [a, b]) {
      await root.query(
        "INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from) VALUES($1,$2,'agenda_tasks_core',1,true,100,'2020-01-01')",
        [fixture.tenant, randomUUID()],
      );
      for (const verb of ['read', 'create', 'update', 'share']) {
        await root.query(
          "INSERT INTO authz.role_capability VALUES($1,'owner','agenda_item',$2,'CONFIDENTIAL',false,1)",
          [fixture.tenant, verb],
        );
        await root.query(
          `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
           VALUES($1,$2,$3,$4,'agenda_item',$5,'CONFIDENTIAL',1)`,
          [fixture.tenant, randomUUID(), fixture.workspace, fixture.users.owner, verb],
        );
      }
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,'delegate','agenda_item','read','CONFIDENTIAL',false,1)",
        [fixture.tenant],
      );
    }
    await root.query(
      "INSERT INTO rpt.crm_workspace(tenant_id,id,name,registration_id,kind) VALUES($1,$2,'Recruiting agenda',$3,'recruitment')",
      [a.tenant, recruitingWorkspace, a.registrations[1]],
    );
    await root.query(
      "INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from) VALUES($1,$2,'recruiting_crm_core',1,true,100,'2020-01-01')",
      [a.tenant, randomUUID()],
    );
    await root.query(
      "INSERT INTO authz.role_capability VALUES($1,'owner','recruitment_profile','read','CONFIDENTIAL',false,1)",
      [a.tenant],
    );
    for (const [objectType, verb] of [
      ['recruitment_appointment', 'read'],
      ['recruitment_followup', 'read'],
    ])
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,'owner',$2,$3,'CONFIDENTIAL',false,1)",
        [a.tenant, objectType, verb],
      );
    for (const verb of ['read', 'create', 'update', 'share'])
      await root.query(
        `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
         VALUES($1,$2,$3,$4,'agenda_item',$5,'CONFIDENTIAL',1)`,
        [a.tenant, randomUUID(), recruitingWorkspace, a.users.owner, verb],
      );
    await root.query(
      `INSERT INTO rpt.recruitment_profile(tenant_id,id,person_id,workspace_id,owner_id,source)
       VALUES($1,$2,$3,$4,$5,'manual')`,
      [a.tenant, profileId, a.persons[0], recruitingWorkspace, a.users.owner],
    );
    const legacyIds = {
      commercialAppointment: randomUUID(),
      commercialTask: randomUUID(),
      recruitingAppointment: randomUUID(),
      recruitingFollowup: randomUUID(),
    };
    await root.query(
      `INSERT INTO rpt.appointment(tenant_id,id,opportunity_id,starts_at,timezone,channel)
       VALUES($1,$2,$3,'2026-10-14T15:00:00Z','America/Guayaquil','phone')`,
      [a.tenant, legacyIds.commercialAppointment, a.ids[0]],
    );
    await root.query(
      `INSERT INTO rpt.crm_entry(tenant_id,id,opportunity_id,kind,body,due_at,actor_id)
       VALUES($1,$2,$3,'task','Synthetic legacy task','2026-10-15T15:00:00Z',$4)`,
      [a.tenant, legacyIds.commercialTask, a.ids[0], a.users.owner],
    );
    await root.query(
      `INSERT INTO rpt.recruitment_appointment(tenant_id,id,profile_id,starts_at,timezone,channel,actor_id)
       VALUES($1,$2,$3,'2026-10-16T15:00:00Z','America/Guayaquil','phone',$4)`,
      [a.tenant, legacyIds.recruitingAppointment, profileId, a.users.owner],
    );
    await root.query(
      `INSERT INTO rpt.recruitment_followup(tenant_id,id,profile_id,due_at,body,actor_id)
       VALUES($1,$2,$3,'2026-10-17T15:00:00Z','Synthetic legacy followup',$4)`,
      [a.tenant, legacyIds.recruitingFollowup, profileId, a.users.owner],
    );

    const service = new FoundationService(new PostgresDatabase(cluster.runtimeConfig()));
    const appointmentInput = {
      schemaVersion: 1 as const,
      type: 'appointment' as const,
      workspaceId: a.workspace,
      title: 'Synthetic visit',
      summary: 'Operational preparation',
      startsAt: '2026-10-10T15:00:00-05:00',
      endsAt: '2026-10-10T16:00:00-05:00',
      timezone: 'America/Guayaquil',
      source: 'commercial_crm' as const,
      personId: a.persons[0],
      opportunityId: a.ids[0],
      recruitmentProfileId: null,
      recurrence: null,
      reminderMinutesBefore: [60, 15],
      travel: {
        originLabel: 'Office',
        destinationLabel: 'Synthetic venue',
        estimatedTravelMinutes: 25,
        preparationMinutes: 10,
      },
    };
    const appointment = await service.createAgendaItem(
      a.identities.owner,
      randomUUID(),
      appointmentInput,
      'agenda-create-appointment-01',
    );

    await t.test('appointment persists with travel, reminders, audit and idempotency', async () => {
      const replay = await service.createAgendaItem(
        a.identities.owner,
        randomUUID(),
        appointmentInput,
        'agenda-create-appointment-01',
      );
      assert.deepEqual(replay, appointment);
      const detail = await service.detailAgendaItem(
        a.identities.owner,
        randomUUID(),
        appointment.id,
      );
      assert.equal(detail.type, 'appointment');
      assert.equal(detail.timezone, 'America/Guayaquil');
      assert.equal(detail.travel.estimatedTravelMinutes, 25);
      assert.equal(detail.reminders.length, 2);
      assert.deepEqual(
        detail.history.map((event) => event.action),
        ['created'],
      );
      assert.equal(
        Number(
          (
            await root.query(
              "SELECT count(*) n FROM rpt.audit_event WHERE tenant_id=$1 AND object_type IN ('agenda_item','agenda_reminder','agenda_event')",
              [a.tenant],
            )
          ).rows[0].n,
        ),
        4,
      );
    });

    await t.test('range list is bounded, tenant isolated and API-shaped', async () => {
      const list = await service.listAgendaItems(a.identities.owner, randomUUID(), {
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        owner: 'mine',
      });
      assert.equal(list.rows.length, 5);
      assert.ok(list.rows.some((row) => row.id === appointment.id && row.mutable));
      assert.ok(
        list.rows.some(
          (row) =>
            row.id === legacyIds.commercialAppointment &&
            !row.mutable &&
            row.source === 'commercial_crm',
        ),
      );
      assert.ok(
        list.rows.some(
          (row) =>
            row.id === legacyIds.recruitingFollowup &&
            !row.mutable &&
            row.source === 'recruiting_crm',
        ),
      );
      const legacyDetail = await service.detailAgendaItem(
        a.identities.owner,
        randomUUID(),
        legacyIds.commercialTask,
      );
      assert.equal(legacyDetail.title, 'Commercial task');
      assert.equal(legacyDetail.summary, null);
      assert.equal(legacyDetail.mutable, false);
      await assert.rejects(
        service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          legacyIds.commercialTask,
          { schemaVersion: 1, expectedVersion: 1, command: { type: 'complete' } },
          'agenda-legacy-command-01',
        ),
        (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
      );
      const foreign = await service.listAgendaItems(b.identities.owner, randomUUID(), {
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
      });
      assert.equal(foreign.rows.length, 0);
      await assert.rejects(
        service.detailAgendaItem(b.identities.owner, randomUUID(), appointment.id),
        (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
      );
      const api = createApi(service, { verify: async () => a.identities.owner });
      const response = await api.request(
        `/v1/agenda/items?config=${encodeURIComponent(JSON.stringify({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }))}`,
        { headers: { Authorization: 'Bearer synthetic' } },
      );
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { data: { rows: unknown[] } }).data.rows.length, 5);
    });

    await t.test(
      'agenda grants do not grant Commercial, Recruiting or Person context',
      async () => {
        const policyId = randomUUID();
        await root.query(
          `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
           VALUES($1,$2,$3,$4,'agenda_item','read','CONFIDENTIAL',1)`,
          [a.tenant, policyId, a.workspace, a.users.delegate],
        );
        const delegated = await service.detailAgendaItem(
          a.identities.delegate,
          randomUUID(),
          appointment.id,
        );
        assert.equal(delegated.opportunityId, null);
        assert.equal(delegated.personId, null);
        await assert.rejects(
          service.detailCrm(a.identities.delegate, randomUUID(), a.ids[0]!),
          (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
        );
        await root.query(
          'UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
          [a.tenant, policyId],
        );
        await assert.rejects(
          service.detailAgendaItem(a.identities.delegate, randomUUID(), appointment.id),
          (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
        );
        await assert.rejects(
          service.detailAgendaItem(a.identities.ancestor, randomUUID(), appointment.id),
          (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
        );
      },
    );

    await t.test('Recruiting link is authorized but does not alter either lifecycle', async () => {
      const item = await service.createAgendaItem(
        a.identities.owner,
        randomUUID(),
        {
          ...appointmentInput,
          workspaceId: recruitingWorkspace,
          title: 'Synthetic interview slot',
          source: 'recruiting_crm',
          opportunityId: null,
          recruitmentProfileId: profileId,
          reminderMinutesBefore: [],
        },
        'agenda-recruiting-link-01',
      );
      const detail = await service.detailAgendaItem(a.identities.owner, randomUUID(), item.id);
      assert.equal(detail.recruitmentProfileId, profileId);
      assert.equal(detail.opportunityId, null);
      const delegatePolicy = randomUUID();
      await root.query(
        `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
         VALUES($1,$2,$3,$4,'agenda_item','read','CONFIDENTIAL',1)`,
        [a.tenant, delegatePolicy, recruitingWorkspace, a.users.delegate],
      );
      const delegated = await service.detailAgendaItem(
        a.identities.delegate,
        randomUUID(),
        item.id,
      );
      assert.equal(delegated.recruitmentProfileId, null);
      assert.equal(delegated.personId, null);
      await assert.rejects(
        service.detailRecruitmentProfile(a.identities.delegate, randomUUID(), profileId),
        (error) => error instanceof FoundationError && error.code === 'NOT_FOUND',
      );
      await root.query(
        'UPDATE authz.workspace_permission SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
        [a.tenant, delegatePolicy],
      );
      assert.equal(
        (await root.query('SELECT stage FROM rpt.opportunity WHERE id=$1', [a.ids[0]])).rows[0]
          .stage,
        'lost',
      );
      assert.equal(
        (await root.query('SELECT stage FROM rpt.recruitment_profile WHERE id=$1', [profileId]))
          .rows[0].stage,
        'new',
      );
    });

    await t.test(
      'confirmation, reschedule and cancellation preserve history and reminder lifecycle',
      async () => {
        const confirmed = await service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          appointment.id,
          { schemaVersion: 1, expectedVersion: 1, command: { type: 'confirm' } },
          'agenda-confirm-01',
        );
        const replay = await service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          appointment.id,
          { schemaVersion: 1, expectedVersion: 1, command: { type: 'confirm' } },
          'agenda-confirm-01',
        );
        assert.deepEqual(replay, confirmed);
        await assert.rejects(
          service.commandAgendaItem(
            a.identities.owner,
            randomUUID(),
            appointment.id,
            { schemaVersion: 1, expectedVersion: 1, command: { type: 'cancel' } },
            'agenda-stale-01',
          ),
          (error) => error instanceof FoundationError && error.code === 'CONFLICT',
        );
        const moved = await service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          appointment.id,
          {
            schemaVersion: 1,
            expectedVersion: 2,
            command: {
              type: 'reschedule',
              startsAt: '2026-10-11T15:00:00-05:00',
              endsAt: '2026-10-11T16:00:00-05:00',
              timezone: 'America/Guayaquil',
            },
          },
          'agenda-reschedule-01',
        );
        const movedReplay = await service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          appointment.id,
          {
            schemaVersion: 1,
            expectedVersion: 2,
            command: {
              type: 'reschedule',
              startsAt: '2026-10-11T15:00:00-05:00',
              endsAt: '2026-10-11T16:00:00-05:00',
              timezone: 'America/Guayaquil',
            },
          },
          'agenda-reschedule-01',
        );
        assert.deepEqual(movedReplay, moved);
        const detail = await service.detailAgendaItem(
          a.identities.owner,
          randomUUID(),
          appointment.id,
        );
        assert.equal(Date.parse(detail.startsAt!), Date.parse('2026-10-11T20:00:00Z'));
        assert.equal(detail.timezone, 'America/Guayaquil');
        assert.equal(detail.reminders.filter((value) => value.status === 'scheduled').length, 2);
        assert.equal(detail.reminders.filter((value) => value.status === 'cancelled').length, 2);
        assert.ok(detail.history.some((event) => event.action === 'rescheduled'));
        const cancelled = await service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          appointment.id,
          { schemaVersion: 1, expectedVersion: 3, command: { type: 'cancel' } },
          'agenda-cancel-01',
        );
        assert.equal(cancelled.version, 4);
        assert.equal(
          (await service.detailAgendaItem(a.identities.owner, randomUUID(), appointment.id))
            .confirmationState,
          'cancelled',
        );
        const declinedItem = await service.createAgendaItem(
          a.identities.owner,
          randomUUID(),
          {
            ...appointmentInput,
            title: 'Synthetic confirmation decline',
            reminderMinutesBefore: [],
          },
          'agenda-decline-create-01',
        );
        await service.commandAgendaItem(
          a.identities.owner,
          randomUUID(),
          declinedItem.id,
          { schemaVersion: 1, expectedVersion: 1, command: { type: 'decline' } },
          'agenda-decline-01',
        );
        const declined = await service.detailAgendaItem(
          a.identities.owner,
          randomUUID(),
          declinedItem.id,
        );
        assert.equal(declined.confirmationState, 'declined');
        assert.equal(declined.status, 'cancelled');
      },
    );

    await t.test('tasks persist, complete idempotently and cannot be reopened', async () => {
      const created = await service.createAgendaItem(
        a.identities.owner,
        randomUUID(),
        {
          schemaVersion: 1,
          type: 'task',
          workspaceId: a.workspace,
          title: 'Prepare synthetic notes',
          summary: null,
          dueAt: '2026-10-12T18:00:00-05:00',
          timezone: 'America/Guayaquil',
          priority: 'high',
          source: 'manual',
          personId: a.persons[0],
          opportunityId: null,
          recruitmentProfileId: null,
          recurrence: null,
          reminderMinutesBefore: [30],
          travel: {},
        },
        'agenda-task-create-01',
      );
      const updated = await service.commandAgendaItem(
        a.identities.owner,
        randomUUID(),
        created.id,
        {
          schemaVersion: 1,
          expectedVersion: 1,
          command: { type: 'update', title: 'Prepare reviewed notes', summary: null },
        },
        'agenda-task-update-01',
      );
      const dueUpdated = await service.commandAgendaItem(
        a.identities.owner,
        randomUUID(),
        created.id,
        {
          schemaVersion: 1,
          expectedVersion: updated.version,
          command: {
            type: 'update_task',
            dueAt: '2026-10-13T18:00:00-05:00',
            timezone: 'America/Guayaquil',
            priority: 'normal',
          },
        },
        'agenda-task-due-update-01',
      );
      const completed = await service.commandAgendaItem(
        a.identities.owner,
        randomUUID(),
        created.id,
        { schemaVersion: 1, expectedVersion: dueUpdated.version, command: { type: 'complete' } },
        'agenda-task-complete-01',
      );
      const replay = await service.commandAgendaItem(
        a.identities.owner,
        randomUUID(),
        created.id,
        { schemaVersion: 1, expectedVersion: dueUpdated.version, command: { type: 'complete' } },
        'agenda-task-complete-01',
      );
      assert.deepEqual(replay, completed);
      const detail = await service.detailAgendaItem(a.identities.owner, randomUUID(), created.id);
      assert.equal(detail.status, 'completed');
      assert.equal(detail.title, 'Prepare reviewed notes');
      assert.equal(Date.parse(detail.dueAt!), Date.parse('2026-10-13T23:00:00Z'));
      assert.equal(detail.priority, 'normal');
    });

    await t.test(
      'finite recurrence is idempotent and keeps local wall time through DST',
      async () => {
        const input = {
          ...appointmentInput,
          title: 'Recurring synthetic visit',
          startsAt: '2026-03-07T09:00:00-05:00',
          endsAt: '2026-03-07T10:00:00-05:00',
          timezone: 'America/New_York',
          source: 'manual' as const,
          opportunityId: null,
          personId: null,
          reminderMinutesBefore: [],
          recurrence: {
            frequency: 'daily' as const,
            interval: 1,
            weekdays: [],
            until: '2026-03-09T09:00:00-04:00',
          },
        };
        const series = await service.createAgendaItem(
          a.identities.owner,
          randomUUID(),
          input,
          'agenda-dst-series-01',
        );
        const replay = await service.createAgendaItem(
          a.identities.owner,
          randomUUID(),
          input,
          'agenda-dst-series-01',
        );
        assert.deepEqual(replay, series);
        assert.equal(series.createdIds?.length, 3);
        const rows = await root.query(
          "SELECT to_char(starts_at AT TIME ZONE timezone,'YYYY-MM-DD HH24:MI') local FROM rpt.agenda_item WHERE tenant_id=$1 AND series_id=$2 ORDER BY occurrence_index",
          [a.tenant, series.id],
        );
        assert.deepEqual(
          rows.rows.map((row) => row.local),
          ['2026-03-07 09:00', '2026-03-08 09:00', '2026-03-09 09:00'],
        );
        const weekly = await service.createAgendaItem(
          a.identities.owner,
          randomUUID(),
          {
            ...input,
            title: 'Weekly synthetic visit',
            startsAt: '2026-03-09T09:00:00-04:00',
            endsAt: '2026-03-09T10:00:00-04:00',
            recurrence: {
              frequency: 'weekly',
              interval: 1,
              weekdays: [1, 3],
              until: '2026-03-18T09:00:00-04:00',
            },
          },
          'agenda-weekly-series-01',
        );
        assert.equal(weekly.createdIds?.length, 4);
      },
    );

    await t.test('unprivileged actors get forbidden without an empty-data disguise', async () => {
      await assert.rejects(
        service.listAgendaItems(a.identities.ancestor, randomUUID(), {
          from: '2026-10-01T00:00:00Z',
          to: '2026-11-01T00:00:00Z',
        }),
        (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
      );
      await assert.rejects(
        service.createAgendaItem(
          a.identities.delegate,
          randomUUID(),
          appointmentInput,
          'agenda-forbidden-01',
        ),
        (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
      );
      await assert.rejects(
        service.createAgendaItem(
          a.identities.owner,
          randomUUID(),
          { ...appointmentInput, opportunityId: b.ids[0], personId: null },
          'agenda-cross-tenant-01',
        ),
        (error) => error instanceof FoundationError && error.code === 'FORBIDDEN',
      );
    });

    await t.test('HTTP create, detail and command use the same authorized core', async () => {
      const api = createApi(service, { verify: async () => a.identities.owner });
      const body = {
        schemaVersion: 1,
        type: 'task',
        workspaceId: a.workspace,
        title: 'Synthetic API task',
        summary: null,
        dueAt: '2026-10-20T09:00:00-05:00',
        timezone: 'America/Guayaquil',
        priority: 'normal',
        source: 'manual',
        personId: null,
        opportunityId: null,
        recruitmentProfileId: null,
        recurrence: null,
        reminderMinutesBefore: [],
        travel: {},
      };
      const createdResponse = await api.request('/v1/agenda/items', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'agenda-api-create-01',
        },
        body: JSON.stringify(body),
      });
      assert.equal(createdResponse.status, 201);
      const created = (await createdResponse.json()) as { data: { id: string; version: number } };
      const detailResponse = await api.request(`/v1/agenda/items/${created.data.id}`, {
        headers: { Authorization: 'Bearer synthetic' },
      });
      assert.equal(detailResponse.status, 200);
      const commandResponse = await api.request(`/v1/agenda/items/${created.data.id}/commands`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'agenda-api-complete-01',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          expectedVersion: created.data.version,
          command: { type: 'complete' },
        }),
      });
      assert.equal(commandResponse.status, 200);
    });
  } finally {
    await root.end();
    await cluster.stop();
  }
});
