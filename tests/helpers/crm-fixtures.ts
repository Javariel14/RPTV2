import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { seedTenant } from './fixtures.js';

/** Synthetic development/test seed only. Runtime reads the database, not this generator. */
export async function seedCrm(root: Client, slug: string, count = 45) {
  const fixture = await seedTenant(root, slug);
  const { tenant, workspace, users } = fixture;
  await root.query(
    "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'MANUAL_RECONCILIATION','order_simulation','manual')",
    [tenant, users.owner],
  );
  for (const [type, verbs] of Object.entries({
    appointment: ['read', 'create'],
    demo: ['read', 'create'],
    quote: ['read', 'create'],
    order: ['read', 'create', 'update'],
    entry: ['read', 'create', 'update'],
    activity: ['read', 'create'],
    reconciliation: ['read', 'approve'],
  })) {
    for (const verb of verbs)
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,'owner',$2,$3,'CONFIDENTIAL',false,1)",
        [tenant, type, verb],
      );
  }
  await root.query(
    `INSERT INTO rpt.feature_flag(tenant_id,id,key,policy_version,enabled,rollout_percent,effective_from)
    VALUES($1,$2,'crm_vertical_slice',1,true,100,'2020-01-01')`,
    [tenant, randomUUID()],
  );
  for (const role of ['owner', 'delegate']) {
    for (const verb of role === 'owner' ? ['read', 'create', 'update', 'share'] : ['read']) {
      await root.query(
        "INSERT INTO authz.role_capability VALUES($1,$2,'opportunity',$3,'CONFIDENTIAL',false,1)",
        [tenant, role, verb],
      );
    }
  }
  for (const verb of ['read', 'create', 'share']) {
    await root.query(
      `INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version)
      VALUES($1,$2,$3,$4,'opportunity',$5,'CONFIDENTIAL',1)`,
      [tenant, randomUUID(), workspace, users.owner, verb],
    );
  }
  const ids: string[] = [];
  const persons: string[] = [];
  for (let i = 0; i < count; i++) {
    const person = randomUUID(),
      id = randomUUID();
    ids.push(id);
    persons.push(person);
    await root.query(
      `INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle)
      VALUES($1,$2,$3,$4,$5,'prospect')`,
      [
        tenant,
        person,
        workspace,
        users.owner,
        `Persona sintética ${String(i + 1).padStart(3, '0')}`,
      ],
    );
    await root.query(
      `INSERT INTO rpt.opportunity(tenant_id,id,person_id,workspace_id,owner_id,title,source,priority,next_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::int * interval '1 day'))`,
      [
        tenant,
        id,
        person,
        workspace,
        users.owner,
        `Oportunidad sintética ${i + 1}`,
        i % 2 ? 'referral' : 'event',
        i % 3 ? 'normal' : 'high',
        i % 2 ? -1 : 1,
      ],
    );
    if (i % 4 === 0)
      await root.query(
        "UPDATE rpt.opportunity SET stage='contacted' WHERE tenant_id=$1 AND id=$2",
        [tenant, id],
      );
    if (i % 10 === 0)
      await root.query("UPDATE rpt.opportunity SET stage='lost' WHERE tenant_id=$1 AND id=$2", [
        tenant,
        id,
      ]);
  }
  return { ...fixture, ids, persons };
}
