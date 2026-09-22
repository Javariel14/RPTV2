import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  uuid,
  personUpdate,
  activityCommand,
  grantCommand,
  idempotencyKey,
  FoundationError,
  errorStatus,
  type ApiError,
  type Identity,
} from '@rpt/contracts';
import type { IdentityVerifier } from '@rpt/policy';
import type { FoundationService } from '@rpt/application';
import { FoundationTelemetry } from '@rpt/telemetry';
export function createApi(
  service: FoundationService,
  verifier: IdentityVerifier,
  telemetry = new FoundationTelemetry(),
) {
  const api = new Hono<{ Variables: { identity: Identity; requestId: string } }>();
  const standardLimit = bodyLimit({
    maxSize: 16_384,
    onError: (c) =>
      c.json(
        {
          schemaVersion: 1,
          error: {
            code: 'INVALID_REQUEST',
            requestId: c.get('requestId'),
            retryable: false,
          },
        },
        413,
      ),
  });
  const importLimit = bodyLimit({
    maxSize: 640 * 1024,
    onError: (c) =>
      c.json(
        {
          schemaVersion: 1,
          error: {
            code: 'INVALID_REQUEST',
            requestId: c.get('requestId'),
            retryable: false,
          },
        },
        413,
      ),
  });
  api.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return telemetry.request(requestId, async () => {
      await next();
      return c.res;
    });
  });
  api.use('*', (c, next) =>
    c.req.path.startsWith('/v1/crm/imports/') ? importLimit(c, next) : standardLimit(c, next),
  );
  api.get('/health', (c) =>
    c.json({ schemaVersion: 1, status: 'foundation', realDataEnabled: false }),
  );
  api.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ') || header.length > 8192)
      throw new FoundationError('UNAUTHENTICATED');
    c.set('identity', await verifier.verify(header.slice(7)));
    await next();
  });
  api.get('/v1/persons/:id', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.readPerson(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
      ),
    }),
  );
  api.patch('/v1/persons/:id', async (c) => {
    const body = personUpdate.parse(await c.req.json<unknown>());
    return c.json({
      schemaVersion: 1,
      data: await service.updatePerson(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
        body.displayName,
        body.expectedVersion,
      ),
    });
  });
  api.post('/v1/activities', async (c) => {
    const body = activityCommand.parse(await c.req.json<unknown>());
    const key = idempotencyKey.parse(c.req.header('idempotency-key'));
    return c.json(
      {
        schemaVersion: 1,
        data: await service.appendActivity(c.get('identity'), c.get('requestId'), body, key),
      },
      201,
    );
  });
  api.get('/v1/network/:id/statistics', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.networkStatistics(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
        z.iso.datetime({ offset: true }).parse(c.req.query('at')),
      ),
    }),
  );
  api.post('/v1/grants', async (c) =>
    c.json(
      {
        schemaVersion: 1,
        data: await service.createGrant(
          c.get('identity'),
          c.get('requestId'),
          grantCommand.parse(await c.req.json<unknown>()),
        ),
      },
      201,
    ),
  );
  api.delete('/v1/grants/:id', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.revokeGrant(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
      ),
    }),
  );
  api.get('/v1/crm/context', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.crmContext(c.get('identity'), c.get('requestId')),
    }),
  );
  api.get('/v1/agenda/items', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.listAgendaItems(
        c.get('identity'),
        c.get('requestId'),
        JSON.parse(c.req.query('config') ?? '{}') as unknown,
      ),
    }),
  );
  api.get('/v1/agenda/items/:id', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.detailAgendaItem(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
      ),
    }),
  );
  api.post('/v1/agenda/items', async (c) =>
    c.json(
      {
        schemaVersion: 1,
        data: await service.createAgendaItem(
          c.get('identity'),
          c.get('requestId'),
          await c.req.json<unknown>(),
          idempotencyKey.parse(c.req.header('Idempotency-Key')),
        ),
      },
      201,
    ),
  );
  api.post('/v1/agenda/items/:id/commands', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.commandAgendaItem(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
        await c.req.json<unknown>(),
        idempotencyKey.parse(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  api.get('/v1/visits', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.listFieldVisits(
        c.get('identity'),
        c.get('requestId'),
        JSON.parse(c.req.query('config') ?? '{}') as unknown,
      ),
    }),
  );
  api.get('/v1/visits/:id', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.detailFieldVisit(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
      ),
    }),
  );
  api.post('/v1/visits', async (c) =>
    c.json(
      {
        schemaVersion: 1,
        data: await service.createFieldVisit(
          c.get('identity'),
          c.get('requestId'),
          await c.req.json<unknown>(),
          idempotencyKey.parse(c.req.header('Idempotency-Key')),
        ),
      },
      201,
    ),
  );
  api.post('/v1/visits/:id/commands', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.commandFieldVisit(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
        await c.req.json<unknown>(),
        idempotencyKey.parse(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  api.get('/v1/crm/opportunities', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.listCrm(
        c.get('identity'),
        c.get('requestId'),
        JSON.parse(c.req.query('config') ?? '{"filters":{}}') as unknown,
      ),
    }),
  );
  api.get('/v1/crm/views', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.listCrmViews(c.get('identity'), c.get('requestId')),
    }),
  );
  api.post('/v1/crm/imports/preview', async (c) => {
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!isUploadedFile(upload)) throw new FoundationError('INVALID_REQUEST');
    return c.json({
      schemaVersion: 1,
      data: await service.previewCrmImport(c.get('identity'), c.get('requestId'), {
        name: upload.name,
        bytes: new Uint8Array(await upload.arrayBuffer()),
      }),
    });
  });
  api.post('/v1/crm/imports/confirm', async (c) => {
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!isUploadedFile(upload) || typeof body.previewHash !== 'string')
      throw new FoundationError('INVALID_REQUEST');
    return c.json(
      {
        schemaVersion: 1,
        data: await service.confirmCrmImport(
          c.get('identity'),
          c.get('requestId'),
          { name: upload.name, bytes: new Uint8Array(await upload.arrayBuffer()) },
          body.previewHash,
          idempotencyKey.parse(c.req.header('Idempotency-Key')),
        ),
      },
      201,
    );
  });
  api.get('/v1/crm/opportunities/:id', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.detailCrm(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
      ),
    }),
  );
  api.post('/v1/crm/opportunities/:id/commands', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.commandCrm(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
        await c.req.json<unknown>(),
        idempotencyKey.parse(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  api.post('/v1/crm/views', async (c) =>
    c.json(
      {
        schemaVersion: 1,
        data: await service.saveCrmView(
          c.get('identity'),
          c.get('requestId'),
          await c.req.json<unknown>(),
          idempotencyKey.parse(c.req.header('Idempotency-Key')),
        ),
      },
      201,
    ),
  );
  api.get('/v1/recruiting/context', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.recruitingContext(c.get('identity'), c.get('requestId')),
    }),
  );
  api.get('/v1/recruiting/profiles', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.listRecruitmentProfiles(
        c.get('identity'),
        c.get('requestId'),
        JSON.parse(c.req.query('config') ?? '{}') as unknown,
      ),
    }),
  );
  api.get('/v1/recruiting/profiles/:id', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.detailRecruitmentProfile(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
      ),
    }),
  );
  api.post('/v1/recruiting/profiles', async (c) =>
    c.json(
      {
        schemaVersion: 1,
        data: await service.createRecruitmentProfile(
          c.get('identity'),
          c.get('requestId'),
          await c.req.json<unknown>(),
          idempotencyKey.parse(c.req.header('Idempotency-Key')),
        ),
      },
      201,
    ),
  );
  api.post('/v1/recruiting/profiles/:id/commands', async (c) =>
    c.json({
      schemaVersion: 1,
      data: await service.commandRecruitmentProfile(
        c.get('identity'),
        c.get('requestId'),
        uuid.parse(c.req.param('id')),
        await c.req.json<unknown>(),
        idempotencyKey.parse(c.req.header('Idempotency-Key')),
      ),
    }),
  );
  api.notFound((c) =>
    c.json(
      {
        schemaVersion: 1,
        error: { code: 'NOT_FOUND', requestId: c.get('requestId'), retryable: false },
      },
      404,
    ),
  );
  api.onError((error, c) => {
    const code =
      error instanceof FoundationError
        ? error.code
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 'INVALID_REQUEST'
          : 'UNAVAILABLE';
    const body: ApiError = {
      schemaVersion: 1,
      error: { code, requestId: c.get('requestId'), retryable: code === 'UNAVAILABLE' },
    };
    return c.json(body, errorStatus[code]);
  });
  return api;
}

function isUploadedFile(
  value: unknown,
): value is { name: string; arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'arrayBuffer' in value &&
    typeof value.arrayBuffer === 'function'
  );
}
