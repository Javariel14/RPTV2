import type { Client } from 'pg';
export { CommercialCalculatorService } from './commercial-calculator.js';
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
  fieldVisitCreate,
  fieldVisitListQuery,
  fieldVisitMutation,
  productCreate,
  productCommand,
  productListQuery,
  catalogMarketCreate,
  marketProductCreate,
  marketAvailabilityChange,
  priceListCreate,
  priceListClose,
  priceEntryCreate,
  marketCatalogQuery,
  priceQuery,
  priceHistoryQuery,
  currencyRegister,
  currencyStatus,
  marketStatus,
  adminMarketScopeGrant,
  actorMarketAssignment,
  priceListActivate,
  exchangeRateCreate,
  exchangeRateQuery,
  referenceConversionQuery,
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
import {
  commandFieldVisit,
  createFieldVisit,
  detailFieldVisit,
  fieldVisitContext,
  listFieldVisits,
} from './field-visits.js';
import { createProduct, commandProduct, listProducts, detailProduct } from './product-master.js';
import {
  catalogMarkets,
  createCatalogMarket,
  createCatalogProduct,
  changeCatalogAvailability,
  marketCatalog,
  createCatalogPriceList,
  closeCatalogPriceList,
  addCatalogPrice,
  readCatalogPrice,
  readCatalogPriceHistory,
  catalogOperationalMarket,
  createCurrency,
  changeCurrencyStatus,
  grantCatalogMarketScope,
  revokeCatalogMarketScope,
  assignCatalogActorMarket,
  changeCatalogMarketStatus,
  activateCatalogPriceList,
  createCatalogExchangeRate,
  readCatalogExchangeRate,
  deriveCatalogReference,
} from './country-catalog.js';
type Outcome<T> = { value: T } | { error: ErrorCode };
export class FoundationService {
  constructor(private readonly database: Database) {}
  operationalMarket(identity: Identity, requestId: string) {
    return this.execute(identity, requestId, requestId, 'catalog.list', catalogOperationalMarket);
  }
  async registerCatalogCurrency(
    identity: Identity,
    requestId: string,
    input: unknown,
    key: string,
  ) {
    const command = currencyRegister.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(identity, requestId, requestId, 'catalog.admin', (client, context) =>
      createCurrency(client, context, command, key, hash),
    );
  }
  async setCatalogCurrencyStatus(
    identity: Identity,
    requestId: string,
    code: string,
    input: unknown,
    key: string,
  ) {
    const command = currencyStatus.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ code, ...command });
    return this.execute(identity, requestId, requestId, 'catalog.admin', (client) =>
      changeCurrencyStatus(client, code, command, key, hash),
    );
  }
  async grantAdminMarketScope(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = adminMarketScopeGrant.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(identity, requestId, command.marketId, 'catalog.admin', (client, context) =>
      grantCatalogMarketScope(client, context, command, key, hash),
    );
  }
  async revokeAdminMarketScope(identity: Identity, requestId: string, id: string, key: string) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ id });
    return this.execute(identity, requestId, id, 'catalog.admin', (client) =>
      revokeCatalogMarketScope(client, id, key, hash),
    );
  }
  async assignOperationalMarket(
    identity: Identity,
    requestId: string,
    input: unknown,
    key: string,
  ) {
    const command = actorMarketAssignment.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(identity, requestId, command.marketId, 'catalog.admin', (client, context) =>
      assignCatalogActorMarket(client, context, command, key, hash),
    );
  }
  async setCatalogMarketStatus(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    const command = marketStatus.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'catalog.admin', (client) =>
      changeCatalogMarketStatus(client, id, command, key, hash),
    );
  }
  async activatePriceList(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    const command = priceListActivate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'pricing.command', (client) =>
      activateCatalogPriceList(client, id, command, key, hash),
    );
  }
  async recordExchangeRate(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = exchangeRateCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(identity, requestId, command.marketId, 'pricing.fx', (client, context) =>
      createCatalogExchangeRate(client, context, command, key, hash),
    );
  }
  catalogExchangeRate(identity: Identity, requestId: string, input: unknown) {
    const q = exchangeRateQuery.parse(input);
    return this.execute(identity, requestId, q.marketId, 'pricing.fx', (client) =>
      readCatalogExchangeRate(client, q.marketId, q.baseCurrency, q.quoteCurrency, q.asOf),
    );
  }
  referenceConversion(identity: Identity, requestId: string, input: unknown) {
    const q = referenceConversionQuery.parse(input);
    return this.execute(identity, requestId, q.marketId, 'pricing.fx', (client) =>
      deriveCatalogReference(client, q.marketId, q.baseCurrency, q.quoteCurrency, q.asOf, q.amount),
    );
  }
  listCatalogMarkets(identity: Identity, requestId: string) {
    return this.execute(identity, requestId, requestId, 'catalog.list', catalogMarkets);
  }
  async createCatalogMarket(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = catalogMarketCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(identity, requestId, requestId, 'catalog.create', (client, context) =>
      createCatalogMarket(client, context, command, key, hash),
    );
  }
  listMarketCatalog(identity: Identity, requestId: string, input: unknown) {
    const query = marketCatalogQuery.parse(input);
    return this.execute(identity, requestId, query.marketId, 'catalog.list', (client) =>
      marketCatalog(client, query.marketId, query.asOf, query.limit),
    );
  }
  async createMarketProduct(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = marketProductCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(identity, requestId, command.nodeId, 'catalog.create', (client, context) =>
      createCatalogProduct(client, context, command, key, hash),
    );
  }
  async changeMarketAvailability(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    const command = marketAvailabilityChange.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'catalog.command', (client, context) =>
      changeCatalogAvailability(client, context, id, command, key, hash),
    );
  }
  async createPriceList(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = priceListCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(
      identity,
      requestId,
      command.marketId,
      'pricing.create',
      (client, context) => createCatalogPriceList(client, context, command, key, hash),
    );
  }
  async closePriceList(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    const command = priceListClose.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'pricing.command', (client) =>
      closeCatalogPriceList(client, id, command, key, hash),
    );
  }
  async addPriceEntry(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    const command = priceEntryCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'pricing.command', (client, context) =>
      addCatalogPrice(client, context, id, command, key, hash),
    );
  }
  currentCatalogPrice(identity: Identity, requestId: string, input: unknown) {
    const query = priceQuery.parse(input);
    return this.execute(identity, requestId, query.priceListId, 'pricing.list', (client) =>
      readCatalogPrice(client, query.priceListId, query.marketProductId, query.asOf),
    );
  }
  catalogPriceHistory(identity: Identity, requestId: string, input: unknown) {
    const query = priceHistoryQuery.parse(input);
    return this.execute(identity, requestId, query.priceListId, 'pricing.list', (client) =>
      readCatalogPriceHistory(client, query.priceListId, query.marketProductId, query.limit),
    );
  }
  listProducts(identity: Identity, requestId: string, input: unknown) {
    const query = productListQuery.parse(input);
    return this.execute(identity, requestId, requestId, 'product.list', (client) =>
      listProducts(client, query),
    );
  }
  detailProduct(identity: Identity, requestId: string, id: string) {
    uuid.parse(id);
    return this.execute(identity, requestId, id, 'product.detail', (client) =>
      detailProduct(client, id),
    );
  }
  async createProduct(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = productCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(
      identity,
      requestId,
      command.workspaceId,
      'product.create',
      (client, context) => createProduct(client, context, command, key, hash),
    );
  }
  async commandProduct(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const command = productCommand.parse(input);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'product.command', (client, context) =>
      commandProduct(client, context, id, command, key, hash),
    );
  }
  fieldVisitContext(identity: Identity, requestId: string) {
    return this.execute(identity, requestId, requestId, 'visit.list', fieldVisitContext);
  }
  listFieldVisits(identity: Identity, requestId: string, input: unknown) {
    const query = fieldVisitListQuery.parse(input);
    return this.execute(identity, requestId, requestId, 'visit.list', (client) =>
      listFieldVisits(client, query),
    );
  }
  detailFieldVisit(identity: Identity, requestId: string, id: string) {
    uuid.parse(id);
    return this.execute(identity, requestId, id, 'visit.detail', (client) =>
      detailFieldVisit(client, id),
    );
  }
  async createFieldVisit(identity: Identity, requestId: string, input: unknown, key: string) {
    const command = fieldVisitCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await this.commandHash(command);
    return this.execute(
      identity,
      requestId,
      command.workspaceId,
      'visit.create',
      (client, context) => createFieldVisit(client, context, command, key, hash),
    );
  }
  async commandFieldVisit(
    identity: Identity,
    requestId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const command = fieldVisitMutation.parse(input);
    const hash = await this.commandHash({ id, ...command });
    return this.execute(identity, requestId, id, 'visit.command', (client, context) =>
      commandFieldVisit(client, context, id, command, key, hash),
    );
  }
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
              : pgCode.success && ['23505', '23P01'].includes(pgCode.data.code)
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
