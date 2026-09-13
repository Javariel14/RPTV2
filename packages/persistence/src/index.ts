import { Client, type ClientConfig } from 'pg';
import { z } from 'zod';
import { FoundationError, type Identity } from '@rpt/contracts';
export interface AuthContext {
  tenantId: string;
  actorId: string;
  policyVersion: number;
  requestId: string;
}
const resolvedIdentity = z.object({
  tenant_id: z.uuid(),
  actor_id: z.uuid(),
  policy_version: z.number().int(),
  high_privilege: z.boolean(),
});
export interface Database {
  request<T>(
    identity: Identity,
    requestId: string,
    operation: (client: Client, context: AuthContext) => Promise<T>,
  ): Promise<T>;
}
export class PostgresDatabase implements Database {
  constructor(private readonly config: ClientConfig) {}
  async request<T>(
    identity: Identity,
    requestId: string,
    operation: (client: Client, context: AuthContext) => Promise<T>,
  ): Promise<T> {
    const client = new Client({
      ...this.config,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10_000,
      application_name: 'rpt-foundation-api',
    });
    try {
      await client.connect();
      const role = (
        await client.query<{ safe: boolean }>(
          `SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT pg_has_role(current_user,'rpt_owner','MEMBER') AND NOT pg_has_role(current_user,'rpt_admin','MEMBER') AND pg_has_role(current_user,'rpt_runtime','MEMBER') AS safe FROM pg_roles WHERE rolname=current_user`,
        )
      ).rows[0];
      if (!role?.safe) throw new FoundationError('UNAVAILABLE');
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const found = (
        await client.query('SELECT * FROM authz.resolve_identity($1,$2,$3)', [
          identity.iss,
          identity.sub,
          identity.session_id,
        ])
      ).rows[0] as unknown;
      const checked = resolvedIdentity.safeParse(found);
      if (!checked.success || (checked.data.high_privilege && identity.aal !== 'aal2'))
        throw new FoundationError('UNAUTHENTICATED');
      const current = checked.data;
      await client.query(
        `SELECT set_config('rpt.tenant_id',$1,true),set_config('rpt.actor_id',$2,true),set_config('rpt.session_id',$3,true),set_config('rpt.aal',$4,true),set_config('rpt.request_id',$5,true)`,
        [current.tenant_id, current.actor_id, identity.session_id, identity.aal, requestId],
      );
      const result = await operation(client, {
        tenantId: current.tenant_id,
        actorId: current.actor_id,
        policyVersion: current.policy_version,
        requestId,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof FoundationError) throw error;
      throw new FoundationError('UNAVAILABLE');
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
export async function allowed(
  client: Client,
  id: string,
  verb: string,
  field = 'CONFIDENTIAL',
): Promise<boolean> {
  return (
    (
      await client.query<{ allowed: boolean }>('SELECT authz.allowed($1,$2,$3,$4) AS allowed', [
        'person',
        id,
        verb,
        field,
      ])
    ).rows[0]?.allowed === true
  );
}
export async function decision(
  client: Client,
  id: string,
  action: string,
  result: 'allow' | 'deny' | 'success' | 'failure',
) {
  await client.query('SELECT authz.record_decision($1,$2,$3)', [id, action, result]);
}
