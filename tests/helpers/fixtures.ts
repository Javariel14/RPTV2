import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { Identity } from '@rpt/contracts';
export const fixtureTime = '2026-09-01T12:00:00.000Z';
export async function seedTenant(root: Client, slug: string) {
  const tenant = randomUUID(),
    workspace = randomUUID(),
    market = randomUUID(),
    person = randomUUID();
  const groups = [randomUUID(), randomUUID(), randomUUID()] as const;
  const registrations = [randomUUID(), randomUUID(), randomUUID()] as const;
  const users = {
    owner: randomUUID(),
    delegate: randomUUID(),
    ancestor: randomUUID(),
    outsider: randomUUID(),
    ai: randomUUID(),
  };
  const identities = {} as Record<keyof typeof users, Identity>;
  await root.query(
    "INSERT INTO authz.tenant(id,slug,status,policy_version) VALUES($1,$2,'active',1)",
    [tenant, slug],
  );
  for (const [role, user] of Object.entries(users)) {
    const subject = randomUUID(),
      session = randomUUID();
    const identity: Identity = {
      iss: `https://${slug}.invalid/auth/v1`,
      sub: subject,
      session_id: session,
      aal: 'aal2',
    };
    identities[role as keyof typeof users] = identity;
    await root.query(
      'INSERT INTO authz.user_account(tenant_id,id,issuer,subject,email) VALUES($1,$2,$3,$4,$5)',
      [tenant, user, identity.iss, subject, `${role}@example.invalid`],
    );
    await root.query(
      "INSERT INTO authz.session(tenant_id,id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [tenant, session, user],
    );
    await root.query(
      "INSERT INTO authz.role_assignment(tenant_id,id,user_id,role_key,effective_from) VALUES($1,$2,$3,$4,'2020-01-01')",
      [tenant, randomUUID(), user, role === 'outsider' ? 'admin' : role],
    );
  }
  const capabilities: Array<[string, string, string, string, boolean]> = [
    ...[
      'read',
      'update',
      'create',
      'share',
      'reassign',
      'delete',
      'export',
      'download',
      'listen',
      'view_transcript',
      'send_message',
    ].flatMap((verb) =>
      ['CONFIDENTIAL', 'RESTRICTED_PII'].map(
        (field) =>
          ['owner', 'person', verb, field, false] as [string, string, string, string, boolean],
      ),
    ),
    ['owner', 'audit', 'read', 'SECURITY_AUDIT', true],
    ['owner', 'network', 'read', 'INTERNAL', false],
    ['owner', 'network', 'update', 'INTERNAL', true],
    ['owner', 'metric', 'create', 'INTERNAL', false],
    ['owner', 'trust', 'read', 'OFFICIAL_COMPENSATION', true],
    ['owner', 'trust', 'approve', 'OFFICIAL_COMPENSATION', true],
    ['owner', 'privacy', 'approve', 'RESTRICTED_PII', true],
    ['owner', 'policy', 'publish_policy', 'INTERNAL', true],
    ['delegate', 'person', 'read', 'CONFIDENTIAL', false],
    ['delegate', 'person', 'update', 'CONFIDENTIAL', false],
    ['delegate', 'metric', 'create', 'INTERNAL', false],
    ['ancestor', 'network', 'statistics', 'INTERNAL', false],
    ['ai', 'trust', 'read', 'OFFICIAL_COMPENSATION', false],
    ['ai', 'trust', 'approve', 'OFFICIAL_COMPENSATION', false],
  ];
  for (const [role, type, verb, field, aal2] of capabilities)
    await root.query('INSERT INTO authz.role_capability VALUES($1,$2,$3,$4,$5,$6,1)', [
      tenant,
      role,
      type,
      verb,
      field,
      aal2,
    ]);
  await root.query(
    "INSERT INTO rpt.market(tenant_id,id,code,timezone,currency) VALUES($1,$2,'EC','America/Guayaquil','USD')",
    [tenant, market],
  );
  for (let i = 0; i < 3; i++) {
    await root.query('INSERT INTO rpt.distribution_group(tenant_id,id,name) VALUES($1,$2,$3)', [
      tenant,
      groups[i],
      `Synthetic group ${i}`,
    ]);
    await root.query(
      "INSERT INTO rpt.market_registration(tenant_id,id,group_id,market_id,effective_from) VALUES($1,$2,$3,$4,'2020-01-01')",
      [tenant, registrations[i], groups[i], market],
    );
  }
  await root.query(
    "INSERT INTO rpt.crm_workspace(tenant_id,id,name,registration_id,kind) VALUES($1,$2,'Synthetic workspace',$3,'commercial')",
    [tenant, workspace, registrations[1]],
  );
  await root.query(
    "INSERT INTO authz.workspace_permission(tenant_id,id,workspace_id,user_id,object_type,verb,field_class,policy_version) VALUES($1,$2,$3,$4,'person','create','CONFIDENTIAL',1)",
    [tenant, randomUUID(), workspace, users.owner],
  );
  await root.query(
    "INSERT INTO rpt.person(tenant_id,id,workspace_id,owner_id,display_name,lifecycle) VALUES($1,$2,$3,$4,'Synthetic person','advisor')",
    [tenant, person, workspace, users.owner],
  );
  await root.query(
    "INSERT INTO rpt.person_pii(tenant_id,person_id,email,phone) VALUES($1,$2,'synthetic@example.invalid','+000000000')",
    [tenant, person],
  );
  await root.query(
    "INSERT INTO rpt.commercial_membership(tenant_id,id,person_id,group_id,effective_from,status,source,reason) VALUES($1,$2,$3,$4,'2020-01-01','active','FIXTURE','synthetic test')",
    [tenant, randomUUID(), person, groups[1]],
  );
  const edge = randomUUID();
  await root.query(
    "INSERT INTO rpt.network_parent(tenant_id,id,market_id,child_id,parent_id,effective_from,source,reason) VALUES($1,$2,$3,$4,$5,'2020-01-01','FIXTURE','synthetic test')",
    [tenant, edge, market, registrations[1], registrations[0]],
  );
  await root.query(
    "INSERT INTO authz.statistical_scope(tenant_id,id,user_id,ancestor_id,effective_from) VALUES($1,$2,$3,$4,'2020-01-01')",
    [tenant, randomUUID(), users.ancestor, registrations[0]],
  );
  for (const domain of ['rank', 'sales'])
    await root.query(
      "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'HYCITE',$3,'official')",
      [tenant, users.owner, domain],
    );
  await root.query(
    "INSERT INTO authz.source_authority(tenant_id,user_id,source_system,domain_key,authority_level) VALUES($1,$2,'RPT_AI','rank','inference')",
    [tenant, users.ai],
  );
  return { tenant, workspace, market, person, groups, registrations, users, identities, edge };
}
