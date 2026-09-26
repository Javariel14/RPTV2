import { z } from 'zod';
import type { Client } from 'pg';
import {
  FoundationError,
  commercialConfigurationCreate,
  commercialConfigurationTransition,
  commercialCalculationRequest,
  commercialEvidenceAppend,
  idempotencyKey,
  uuid,
  type Identity,
  type ErrorCode,
  type ResolvedCommercialInput,
} from '@rpt/contracts';
import { Exact, calculateResolvedCommercial, canonicalCommercial } from '@rpt/domain';
import type { Database, AuthContext } from '@rpt/persistence';
import { priceList, currencyDetail } from '@rpt/persistence/country-catalog';
import {
  commercialPermission,
  commercialReceipt,
  commercialFinish,
  configurationByKey,
  lockConfiguration,
  insertConfiguration,
  bumpConfiguration,
  insertCommercialVersion,
  commercialVersion,
  commercialHistory,
  commercialHistoryContents,
  transitionCommercialVersion,
  resolveCommercialVersions,
  bundleLines,
  commercialRules,
  financingTerms,
  officialPrices,
  insertCommercialEvidence,
  type CommercialVersion,
} from '@rpt/persistence/commercial-calculator';

async function digest(input: unknown) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalCommercial(input)),
  );
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}
async function requirePermission(
  client: Client,
  market: string,
  list: string,
  verb: 'calculate' | 'configure',
) {
  if (!(await commercialPermission(client, market, list, verb)))
    throw new FoundationError('FORBIDDEN');
}
/** Application entry point; shares the existing authenticated transaction boundary. */
export class CommercialCalculatorService {
  constructor(private readonly database: Database) {}
  private async execute<T>(
    identity: Identity,
    request: string,
    object: string,
    action: string,
    operation: (c: Client, a: AuthContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.database.request<{ value: T } | { error: ErrorCode }>(
      identity,
      request,
      async (client, context) => {
        await client.query('SAVEPOINT commercial_operation');
        try {
          const value = await operation(client, context);
          await client.query('SELECT authz.commercial_decision($1,$2,$3)', [
            object,
            action,
            'success',
          ]);
          return { value };
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT commercial_operation');
          const pg = z.object({ code: z.string() }).safeParse(e);
          const error: ErrorCode =
            e instanceof FoundationError
              ? e.code
              : e instanceof RangeError
                ? 'INVALID_REQUEST'
                : pg.success && ['23505', '23P01'].includes(pg.data.code)
                  ? 'CONFLICT'
                  : pg.success && ['23514', '23503', '22P02', '22003'].includes(pg.data.code)
                    ? 'INVALID_REQUEST'
                    : pg.success && pg.data.code === '42501'
                      ? 'NOT_FOUND'
                      : 'UNAVAILABLE';
          await client.query('SELECT authz.commercial_decision($1,$2,$3)', [
            object,
            action,
            ['FORBIDDEN', 'NOT_FOUND'].includes(error) ? 'deny' : 'failure',
          ]);
          return { error };
        }
      },
    );
    if ('error' in result) throw new FoundationError(result.error);
    return result.value;
  }
  async createConfigurationVersion(
    identity: Identity,
    request: string,
    input: unknown,
    key: string,
  ) {
    const command = commercialConfigurationCreate.parse(input);
    idempotencyKey.parse(key);
    const hash = await digest({ operation: 'create_version', command });
    return this.execute(
      identity,
      request,
      command.priceListId,
      'commercial.configure',
      async (client, context) => {
        await requirePermission(client, command.marketId, command.priceListId, 'configure');
        const prior = await commercialReceipt(client, key, hash);
        if (prior) return prior;
        await lockConfiguration(client, context, command);
        const list = await priceList(client, command.priceListId);
        if (!list) throw new FoundationError('NOT_FOUND');
        if (list.market_id !== command.marketId || list.status === 'closed')
          throw new FoundationError('INVALID_REQUEST');
        let current = await configurationByKey(
          client,
          command.marketId,
          command.priceListId,
          command.kind,
          command.stableKey,
        );
        if (!current) {
          if (command.expectedVersion !== 0) throw new FoundationError('CONFLICT');
          current = { id: crypto.randomUUID(), version: 1, name: command.name };
          await insertConfiguration(client, context, current.id, list.currency, command);
        } else {
          if (current.version !== command.expectedVersion) throw new FoundationError('CONFLICT');
          if (current.name !== command.name) throw new FoundationError('INVALID_REQUEST');
          const version = await bumpConfiguration(client, current.id, command.expectedVersion);
          if (!version) throw new FoundationError('CONFLICT');
          current = { ...current, version };
        }
        const versionId = crypto.randomUUID();
        await insertCommercialVersion(
          client,
          context,
          versionId,
          current.id,
          current.version,
          command,
        );
        return commercialFinish(client, key, {
          id: current.id,
          versionId,
          version: current.version,
          revision: 1,
        });
      },
    );
  }
  async transitionConfigurationVersion(
    identity: Identity,
    request: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    uuid.parse(id);
    idempotencyKey.parse(key);
    const command = commercialConfigurationTransition.parse(input);
    const hash = await digest({ operation: 'transition', id, command });
    return this.execute(identity, request, id, 'commercial.configure', async (client) => {
      const v = await commercialVersion(client, id, true);
      if (!v) throw new FoundationError('NOT_FOUND');
      await requirePermission(client, v.market_id, v.price_list_id, 'configure');
      const prior = await commercialReceipt(client, key, hash);
      if (prior) return prior;
      if (v.revision !== command.expectedVersion) throw new FoundationError('CONFLICT');
      const revision = await transitionCommercialVersion(
        client,
        id,
        command.expectedVersion,
        command.action,
        command.effectiveAt,
      );
      if (!revision) throw new FoundationError('CONFLICT');
      return commercialFinish(client, key, {
        id: v.configuration_id,
        versionId: id,
        version: v.version_no,
        revision,
      });
    });
  }
  configurationHistory(identity: Identity, request: string, id: string) {
    uuid.parse(id);
    return this.execute(identity, request, id, 'commercial.history', async (client) => {
      const history = await commercialHistory(client, id);
      if (!history.length) throw new FoundationError('NOT_FOUND');
      return commercialHistoryContents(client, history);
    });
  }
  async appendEvidence(identity: Identity, request: string, input: unknown, key: string) {
    const command = commercialEvidenceAppend.parse(input);
    idempotencyKey.parse(key);
    const hash = await digest({ operation: 'evidence', command });
    return this.execute(
      identity,
      request,
      command.versionId,
      'commercial.evidence',
      async (client, context) => {
        const v = await commercialVersion(client, command.versionId);
        if (!v) throw new FoundationError('NOT_FOUND');
        await requirePermission(client, v.market_id, v.price_list_id, 'configure');
        const prior = await commercialReceipt(client, key, hash);
        if (prior) return prior;
        const observationId = await insertCommercialEvidence(
          client,
          context,
          v,
          command.evidence,
          hash,
        );
        return commercialFinish(client, key, {
          id: observationId,
          versionId: v.id,
          version: v.version_no,
          revision: v.revision,
        });
      },
    );
  }
  calculateCommercialOffer(identity: Identity, request: string, input: unknown) {
    const command = commercialCalculationRequest.parse(input);
    return this.execute(
      identity,
      request,
      command.priceListId,
      'commercial.calculate',
      async (client) => {
        const list = await priceList(client, command.priceListId);
        if (!list) throw new FoundationError('NOT_FOUND');
        await requirePermission(client, list.market_id, list.id, 'calculate');
        const asOf = new Date(command.asOf).toISOString();
        if (command.marketId && command.marketId !== list.market_id)
          throw new FoundationError('FORBIDDEN');
        if (
          list.status === 'draft' ||
          list.valid_from.getTime() > Date.parse(asOf) ||
          (list.valid_to && list.valid_to.getTime() <= Date.parse(asOf))
        )
          throw new FoundationError('INVALID_REQUEST');
        const currency = await currencyDetail(client, list.currency);
        if (!currency || currency.status !== 'active') throw new FoundationError('INVALID_REQUEST');
        const ids = [
          ...new Set([
            ...command.lines.flatMap((l) => (l.kind === 'bundle' ? [l.bundleId] : [])),
            ...(command.ruleSetId ? [command.ruleSetId] : []),
            ...(command.financing ? [command.financing.planId] : []),
          ]),
        ];
        const versions = await resolveCommercialVersions(client, ids, asOf);
        const pick = (id: string, kind: CommercialVersion['kind']) => {
          const candidates = versions.filter(
            (v) =>
              v.configuration_id === id &&
              v.kind === kind &&
              v.market_id === list.market_id &&
              v.price_list_id === list.id,
          );
          if (!candidates.length) throw new FoundationError('NOT_FOUND');
          if (candidates.length !== 1) throw new FoundationError('CONFLICT');
          return candidates[0]!;
        };
        const compositions = await bundleLines(
          client,
          versions.filter((v) => v.kind === 'bundle').map((v) => v.id),
        );
        const expanded: {
          marketProductId: string;
          quantity: string;
          bundleId?: string;
          bundleVersion?: number;
          requestLineIndex: number;
        }[] = [];
        for (const [requestLineIndex, line] of command.lines.entries()) {
          if (line.kind === 'product')
            expanded.push({
              marketProductId: line.marketProductId,
              quantity: line.quantity,
              requestLineIndex,
            });
          else {
            const v = pick(line.bundleId, 'bundle');
            if (v.pricing_mode === 'PUBLISHED_ANCHOR') {
              if (!v.anchor_market_product_id) throw new FoundationError('INVALID_REQUEST');
              expanded.push({
                marketProductId: v.anchor_market_product_id,
                quantity: line.quantity,
                bundleId: line.bundleId,
                bundleVersion: v.version_no,
                requestLineIndex,
              });
            } else
              for (const component of compositions.filter((c) => c.version_id === v.id))
                expanded.push({
                  marketProductId: component.market_product_id,
                  quantity: Exact.parse(line.quantity)
                    .mul(Exact.parse(component.quantity))
                    .format(20),
                  bundleId: line.bundleId,
                  bundleVersion: v.version_no,
                  requestLineIndex,
                });
          }
        }
        if (!expanded.length || expanded.length > 250) throw new FoundationError('INVALID_REQUEST');
        const prices = await officialPrices(
          client,
          list.id,
          [...new Set(expanded.map((l) => l.marketProductId))],
          asOf,
        );
        const resolved: ResolvedCommercialInput = {
          schemaVersion: 1,
          asOf,
          effectiveMarketId: list.market_id,
          priceListId: list.id,
          priceListVersion: list.version,
          currency: list.currency,
          minorUnits: currency.minor_units,
          lines: expanded.map((l) => {
            const matches = prices.filter((p) => p.marketProductId === l.marketProductId);
            if (!matches.length) throw new FoundationError('NOT_FOUND');
            if (matches.length !== 1) throw new FoundationError('CONFLICT');
            return { ...matches[0]!, ...l, entryVersion: 1 as const };
          }),
          rules: [],
        };
        if (command.ruleSetId) {
          const v = pick(command.ruleSetId, 'rules');
          resolved.rules = await commercialRules(client, v.id, v.version_no);
        }
        if (command.requestedDiscountRuleId) {
          if (
            !resolved.rules.some(
              (r) => r.id === command.requestedDiscountRuleId && r.kind.endsWith('discount'),
            )
          )
            throw new FoundationError('INVALID_REQUEST');
          resolved.rules = resolved.rules.filter(
            (r) => !r.kind.endsWith('discount') || r.id === command.requestedDiscountRuleId,
          );
        }
        if (command.financing) {
          const v = pick(command.financing.planId, 'financing');
          const terms = await financingTerms(client, v.id),
            term = terms.find((t) => t.id === command.financing!.termId);
          if (!term || !v.financing_mode) throw new FoundationError('NOT_FOUND');
          resolved.financing = {
            planId: v.configuration_id,
            planVersion: v.version_no,
            termId: term.id,
            termVersion: v.version_no,
            months: term.months,
            mode: v.financing_mode,
            value: term.value,
            downPaymentRate: v.down_payment_rate,
            downPaymentAmount: v.down_payment_amount,
            allowAdditionalBalance: v.allow_additional_balance,
            additionalBalance: command.financing.additionalBalance,
          };
        }
        return calculateResolvedCommercial(resolved);
      },
    );
  }
}
