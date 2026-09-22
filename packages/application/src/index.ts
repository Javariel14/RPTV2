import type { Client } from 'pg';
import { z } from 'zod';
import {
  FoundationError,
  personDto,
  type ActivityCommand,
  type Identity,
  type ErrorCode,
} from '@rpt/contracts';
import { allowed, decision, type Database, type AuthContext } from '@rpt/persistence';
import {
  crmListQuery,
  crmSaveView,
  crmMutation,
  recruitingCreate,
  recruitingListQuery,
  recruitingMutation,
  agendaCreate,
  agendaListQuery,
  agendaMutation,
  uuid,
  idempotencyKey,
} from '@rpt/contracts';
import { detailCrm, commandCrm } from './crm-detail.js';
import { crmContext, listCrm, listCrmViews, saveCrmView } from './crm.js';
import { confirmCrmImport, previewCrmImport } from './crm-import.js';
import type { ImportFile } from './crm-import-parser.js';
import {
  commandRecruitmentProfile,
  createRecruitmentProfile,
  detailRecruitmentProfile,
  listRecruitmentProfiles,
  recruitingContext,
} from './recruiting.js';
import {
  commandAgendaItem,
  createAgendaItem,
  detailAgendaItem,
  listAgendaItems,
} from './agenda.js';
type Outcome<T> = { value: T } | { error: ErrorCode };
export class FoundationService {
  constructor(private readonly database: Database) {}
  listAgendaItems(identity: Identity, requestId: string, input: unknown) {
    const query = agendaListQuery.parse(input);
    return this.execute(identity, requestId, requestId, 'agenda.list', (client) =>
      listAgendaItems(client, query),
    );
  }
  detailAgendaItem(identity: Identity, requestId: string, id: string) {
    uuid.parse(id);
    return this.execute(identity, requestId, id, 'agenda.detail', (client) =>
      detailAgendaItem(client, id),
    );
  }
  async createAgendaItem(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = agendaCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(
      identity,
      requestId,
      command.workspaceId,
      'agenda.create',
      (client, context) => createAgendaItem(client, context, command, key, hash),
    );
  }
  async commandAgendaItem(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const command = agendaMutation.parse(input);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'agenda.command', (client, context) =>
      commandAgendaItem(client, context, id, command, key, hash),
    );
  }
  previewCrmImport(identity: Identity, requestId: string, file: ImportFile) {
    return this.execute(identity, requestId, requestId, 'crm.import.preview', (client) =>
      previewCrmImport(client, file),
    );
  }
  confirmCrmImport(
    identity: Identity,
    requestId: string,
    file: ImportFile,
    previewHash: string,
    key: string,
  ) {
    z.string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(previewHash);
    idempotencyKey.parse(key);
    return this.execute(identity, requestId, requestId, 'crm.import.confirm', (client, context) =>
      confirmCrmImport(client, context, file, previewHash, key),
    );
  }
  recruitingContext(identity: Identity, requestId: string) {
    return this.execute(identity, requestId, requestId, 'recruiting.context', recruitingContext);
  }
  listRecruitmentProfiles(identity: Identity, requestId: string, input: unknown) {
    const query = recruitingListQuery.parse(input);
    return this.execute(identity, requestId, query.workspaceId, 'recruiting.list', (client) =>
      listRecruitmentProfiles(client, query),
    );
  }
  detailRecruitmentProfile(identity: Identity, requestId: string, id: string) {
    uuid.parse(id);
    return this.execute(identity, requestId, id, 'recruiting.detail', (client) =>
      detailRecruitmentProfile(client, id),
    );
  }
  async createRecruitmentProfile(
    identity: Identity,
    requestId: string,
    input: unknown,
    key: string,
  ) {
    const command = recruitingCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(
      identity,
      requestId,
      command.workspaceId,
      'recruiting.create',
      (client, context) => createRecruitmentProfile(client, context, command, key, hash),
    );
  }
  async commandRecruitmentProfile(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const command = recruitingMutation.parse(input);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'recruiting.command', (client, context) =>
      commandRecruitmentProfile(client, context, id, command, key, hash),
    );
  }
  detailCrm(identity: Identity, requestId: string, id: string) {
    uuid.parse(id);
    return this.execute(identity, requestId, id, 'crm.detail', (client) => detailCrm(client, id));
  }
  async commandCrm(identity: Identity, requestId: string, id: string, input: unknown, key: string) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const command = crmMutation.parse(input);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({ id, ...command })),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return this.execute(identity, requestId, id, 'crm.command', (client, context) =>
      commandCrm(client, context, id, command, key, hash),
    );
  }
  crmContext(identity: Identity, requestId: string) {
    return this.execute(identity, requestId, requestId, 'crm.context', crmContext);
  }
  listCrm(identity: Identity, requestId: string, input: unknown) {
    const query = crmListQuery.parse(input);
    return this.execute(identity, requestId, requestId, 'crm.list', (client) =>
      listCrm(client, query),
    );
  }
  listCrmViews(identity: Identity, requestId: string) {
    return this.execute(identity, requestId, requestId, 'crm.view', listCrmViews);
  }
  async saveCrmView(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = crmSaveView.parse(input);
    idempotencyKey.parse(key);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(command)),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return this.execute(identity, requestId, command.workspaceId, 'crm.view', (client, context) =>
      saveCrmView(client, context, command, key, hash),
    );
  }
  private async commandHash(value: unknown) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  private async execute<T>(
    identity: Identity,
    requestId: string,
    objectId: string,
    action: string,
    operation: (client: Client, context: AuthContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.database.request<Outcome<T>>(
      identity,
      requestId,
      async (client, context) => {
        await client.query('SAVEPOINT operation');
        try {
          const value = await operation(client, context);
          await decision(client, objectId, action, 'success');
          return { value };
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT operation');
          const pgCode = z.object({ code: z.string() }).safeParse(error);
          const code: ErrorCode =
            error instanceof FoundationError
              ? error.code
              : pgCode.success && pgCode.data.code === '23505'
                ? 'CONFLICT'
                : pgCode.success && ['23514', '22P02'].includes(pgCode.data.code)
                  ? 'INVALID_REQUEST'
                  : pgCode.success && pgCode.data.code === '42501'
                    ? 'NOT_FOUND'
                    : 'UNAVAILABLE';
          await decision(client, objectId, action, code === 'NOT_FOUND' ? 'deny' : 'failure');
          return { error: code };
        }
      },
    );
    if ('error' in result) throw new FoundationError(result.error);
    return result.value;
  }
  readPerson(identity: Identity, requestId: string, id: string) {
    return this.execute(identity, requestId, id, 'person.read', async (client) => {
      if (!(await allowed(client, id, 'read'))) throw new FoundationError('NOT_FOUND');
      const row = (
        await client.query(
          'SELECT id,display_name AS "displayName",lifecycle,version FROM rpt.person WHERE id=$1',
          [id],
        )
      ).rows[0] as unknown;
      if (row === undefined) throw new FoundationError('NOT_FOUND');
      return personDto.parse(row);
    });
  }
  updatePerson(
    identity: Identity,
    requestId: string,
    id: string,
    displayName: string,
    version: number,
  ) {
    return this.execute(identity, requestId, id, 'person.update', async (client) => {
      if (!(await allowed(client, id, 'update'))) throw new FoundationError('NOT_FOUND');
      const row = (
        await client.query(
          'UPDATE rpt.person SET display_name=$2 WHERE id=$1 AND version=$3 RETURNING id,display_name AS "displayName",lifecycle,version',
          [id, displayName, version],
        )
      ).rows[0] as unknown;
      if (row === undefined) {
        if (!(await allowed(client, id, 'read'))) throw new FoundationError('NOT_FOUND');
        throw new FoundationError('CONFLICT');
      }
      return personDto.parse(row);
    });
  }
  appendActivity(identity: Identity, requestId: string, command: ActivityCommand, key: string) {
    return this.execute(identity, requestId, command.subjectId, 'metric.append', async (client) => {
      const row = (
        await client.query('SELECT authz.append_activity($1,$2,$3,$4,$5,$6,$7,$8,$9) AS id', [
          command.subjectId,
          command.registrationId,
          command.marketId,
          command.metric,
          command.value,
          command.occurredAt,
          command.unit,
          key,
          command.reversalOf,
        ])
      ).rows[0] as unknown;
      return z.object({ id: z.uuid() }).parse(row);
    });
  }
  networkStatistics(identity: Identity, requestId: string, ancestor: string, at: string) {
    return this.execute(identity, requestId, ancestor, 'network.stats', async (client) => {
      const rows = (
        await client.query(
          'SELECT metric_key AS metric,total::text FROM authz.network_statistics($1,$2)',
          [ancestor, at],
        )
      ).rows as unknown;
      return z.array(z.object({ metric: z.string(), total: z.string() })).parse(rows);
    });
  }
  createGrant(
    identity: Identity,
    requestId: string,
    command: {
      objectId: string;
      granteeId: string;
      verb: string;
      field: string;
      until: string;
      reason: string;
    },
  ) {
    return this.execute(identity, requestId, command.objectId, 'grant.create', async (client) =>
      z
        .object({ id: z.uuid() })
        .parse(
          (
            await client.query('SELECT authz.create_grant($1,$2,$3,$4,$5,$6) AS id', [
              command.objectId,
              command.granteeId,
              command.verb,
              command.field,
              command.until,
              command.reason,
            ])
          ).rows[0] as unknown,
        ),
    );
  }
  revokeGrant(identity: Identity, requestId: string, id: string) {
    return this.execute(identity, requestId, id, 'grant.revoke', async (client) => {
      const row = (
        await client.query<{ revoked: boolean }>('SELECT authz.revoke_grant($1) AS revoked', [id])
      ).rows[0];
      if (!row?.revoked) throw new FoundationError('NOT_FOUND');
      return { revoked: true as const };
    });
  }
}
