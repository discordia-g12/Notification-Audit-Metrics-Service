import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from '../../utils/problem';
import { requireStaff } from '../status/routes';
import { MetricsCache, type MetricsCacheOptions } from './cache';
import { resolveRange } from './range';
import { serverMetricsRoutes } from './serverRoutes';
import type { ServerActivityMetrics, ServerAdminAccessResult, ServerMetricsCollectorConfig } from './serverMetrics';
import type { MetricsSources } from './sources';

export interface MetricsRoutesOptions {
  sources: MetricsSources;
  cache?: MetricsCache;
  serverConfig?: ServerMetricsCollectorConfig;
  serverCache?: MetricsCache<ServerActivityMetrics>;
  serverCacheOptions?: MetricsCacheOptions;
  checkServerAdminAccess?: (userId: string, serverId: string) => Promise<ServerAdminAccessResult>;
  now?: () => Date;
}

/** Sin X-User-Id no hay identidad (Kong la pone desde el token): 401 antes de mirar el rol. */
async function requireStaffIdentity(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = request.headers['x-user-id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 255) {
    await sendProblem(request, reply, 401, 'Unauthorized: missing user identity');
    return;
  }
  await requireStaff(request, reply);
}

/**
 * Métricas globales de la plataforma para el backoffice (ADR-05). Kong exige staff en /api/v1/admin/* (ADR-002
 * del Gateway) y acá se vuelve a chequear.
 */
export async function metricsRoutes(app: FastifyInstance, options: MetricsRoutesOptions): Promise<void> {
  const { sources, cache } = options;
  const now = options.now ?? (() => new Date());

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get<{ Querystring: { from?: unknown; to?: unknown } }>(
    '/api/v1/admin/metrics',
    { preHandler: requireStaffIdentity },
    async (request, reply) => {
      const result = resolveRange(request.query ?? {}, now());
      if (!result.ok) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', { errors: result.errors });
      }
      const key = `${result.range.from.toISOString()}|${result.range.to.toISOString()}`;
      const cached = cache?.get(key);
      if (cached) return cached;

      const metrics = await sources.collect(result.range, request.log);
      cache?.set(key, metrics);
      return metrics;
    },
  );

  if (options.serverConfig) {
    const serverCache =
      options.serverCache ??
      (options.serverCacheOptions
        ? new MetricsCache<ServerActivityMetrics>(options.serverCacheOptions)
        : undefined);
    await serverMetricsRoutes(app, {
      serverConfig: options.serverConfig,
      cache: serverCache,
      now: options.now,
      checkAdminAccess: options.checkServerAdminAccess,
    });
  }
}
