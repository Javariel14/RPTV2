import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { seedCrm } from './crm-fixtures.js';

type CrmFixture = Awaited<ReturnType<typeof seedCrm>>;
const stages = [
  'new',
  'initial_contact',
  'qualified',
  'interview_to_schedule',
  'interview_scheduled',
  'interviewed',
  'evaluation',
  'followup_decision',
  'onboarding',
  'activated',
] as const;
const substatuses = [
  'data_validated',
  'contacted',
  'interest_qualified',
  'interview_proposed',
  'interview_scheduled',
  'attended',
  'evaluation_pending',
  'nurture',
  'onboarding_started',
  'activated',
] as const;

/** Synthetic development/test seed only. The UI still reads every record from PostgreSQL. */
export async function seedRecruiting(root: Client, fixture: CrmFixture, count = 18) {
  const workspace = randomUUID();
  await root.query(
    "INSERT INTO rpt.crm_workspace(tenant_id,id,name,registration_id,kind) VALUES($1,$2,'Recruiting local',$3,'recruitment')",
    [fixture.tenant, workspace, fixture.registrations[1]],
  );
  await root.query(
    "INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from) VALUES($1,$2,'recruiting_crm_core',1,true,100,'2020-01-01')",
    [fixture.tenant, randomUUID()],
  );
  for (const verb of ['read', 'create', 'update', 'reassign', 'share']) {
    await root.query(
      "INSERT INTO authz.role_capability VALUES($1,'owner','recruitment_profile',$2,'CONFIDENTIAL',false,1)",
      [fixture.tenant, verb],
    );
    await root.query(
      `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
       VALUES($1,$2,$3,$4,'recruitment_profile',$5,'CONFIDENTIAL',1)`,
      [fixture.tenant, randomUUID(), workspace, fixture.users.owner, verb],
    );
  }
  for (const verb of ['read', 'update']) {
    await root.query(
      "INSERT INTO authz.role_capability VALUES($1,'delegate','recruitment_profile',$2,'CONFIDENTIAL',false,1)",
      [fixture.tenant, verb],
    );
    await root.query(
      `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
       VALUES($1,$2,$3,$4,'recruitment_profile',$5,'CONFIDENTIAL',1)`,
      [fixture.tenant, randomUUID(), workspace, fixture.users.delegate, verb],
    );
  }
  for (const [objectType, verbs] of Object.entries({
    recruitment_appointment: ['read', 'create'],
    recruitment_interview: ['read', 'create'],
    recruitment_followup: ['read', 'create', 'update'],
    recruitment_hook: ['read', 'create'],
  }))
    for (const verb of verbs)
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,'owner',$2,$3,'CONFIDENTIAL',false,1)",
        [fixture.tenant, objectType, verb],
      );

  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const personId = fixture.persons[index] ?? randomUUID();
    if (!fixture.persons[index])
      await root.query(
        "INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle) VALUES($1,$2,$3,$4,$5,'candidate')",
        [
          fixture.tenant,
          personId,
          fixture.workspace,
          fixture.users.owner,
          `Candidata sintética ${index + 1}`,
        ],
      );
    const profileId = randomUUID();
    ids.push(profileId);
    await root.query(
      `INSERT INTO rpt.recruitment_profile(tenant_id,id,person_id,workspace_id,owner_id,source,priority)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        fixture.tenant,
        profileId,
        personId,
        workspace,
        fixture.users.owner,
        ['referral', 'event', 'manual', 'telemarketing'][index % 4],
        ['A', 'B', 'C'][index % 3],
      ],
    );
    for (const nextStage of stages.slice(1, (index % stages.length) + 1))
      await root.query(
        'UPDATE rpt.recruitment_profile SET stage=$2,version=version+1 WHERE id=$1',
        [profileId, nextStage],
      );
    await root.query(
      'UPDATE rpt.recruitment_profile SET substatus=$2,version=version+1 WHERE id=$1',
      [profileId, substatuses[index % substatuses.length]],
    );
    await root.query(
      `INSERT INTO rpt.recruitment_followup(tenant_id,id,profile_id,due_at,body,actor_id)
       VALUES($1,$2,$3,now()+($4::int * interval '1 day'),$5,$6)`,
      [
        fixture.tenant,
        randomUUID(),
        profileId,
        index % 2 ? 2 : -1,
        `Seguimiento sintético ${index + 1}`,
        fixture.users.owner,
      ],
    );
    await root.query(
      `INSERT INTO rpt.recruitment_event(tenant_id,id,profile_id,actor_id,action,request_id,payload)
       VALUES($1,$2,$3,$4,'profile.seeded',$5,'{"synthetic":true}')`,
      [fixture.tenant, randomUUID(), profileId, fixture.users.owner, randomUUID()],
    );
  }
  return { workspace, ids };
}
