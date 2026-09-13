import { z } from 'zod';
import { FoundationService } from '@rpt/application';
import { PostgresDatabase } from '@rpt/persistence';
import { supabaseVerifier } from '@rpt/policy';
import { FoundationTelemetry } from '@rpt/telemetry';
import { createApi } from './app.js';
const configuration = z.object({
  RPT_ENV: z.enum(['local', 'test', 'staging', 'production']),
  RPT_RELEASE_APPROVED: z.literal('true'),
  AUTH_ISSUER: z.url(),
});
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const parsed = configuration.safeParse(env);
    if (
      !parsed.success ||
      !('HYPERDRIVE' in env) ||
      !env.HYPERDRIVE ||
      parsed.data.AUTH_ISSUER.includes('unconfigured.invalid')
    ) {
      return Response.json(
        {
          schemaVersion: 1,
          error: { code: 'UNAVAILABLE', retryable: false, requestId: crypto.randomUUID() },
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    // Runtime connection credentials are provided only by the Hyperdrive binding.
    const telemetry = new FoundationTelemetry();
    try {
      const service = new FoundationService(
        new PostgresDatabase({ connectionString: env.HYPERDRIVE.connectionString }),
      );
      return await createApi(service, supabaseVerifier(parsed.data.AUTH_ISSUER), telemetry).fetch(
        request,
      );
    } finally {
      ctx.waitUntil(telemetry.flush().finally(() => telemetry.shutdown()));
    }
  },
} satisfies ExportedHandler<Env>;
