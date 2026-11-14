import type { FastifyInstance } from 'fastify';
import { sendProblem } from '../../utils/problem';
import { MetricsCache } from './cache';
import {
  checkServerAdminAccess,
  collectServerActivityMetrics,
  isValidServerId,
  resolveServerMetricsRange,
  type ServerActivityMetrics,
  type ServerAdminAccessResult,
  type ServerMetricsCollectorConfig,
} from './serverMetrics';

export interface ServerMetricsRoutesOptions {
  serverConfig: ServerMetricsCollectorConfig;
  cache?: MetricsCache<ServerActivityMetrics>;
  now?: () => Date;
  checkAdminAccess?: (userId: string, serverId: string) => Promise<ServerAdminAccessResult>;
}

interface ServerMetricsParams {
  serverId: string;
}

interface ServerMetricsQuery {
  from?: unknown;
  to?: unknown;
  days?: unknown;
}

/**
 * Expone métricas de actividad de un servidor (`GET /api/v1/servers/:serverId/metrics`)
 * restringidas a su dueño o miembros con permiso `ADMINISTRATOR` o `MANAGE_SERVER`.
 */
export async function serverMetricsRoutes(
  app: FastifyInstance,
  opts: ServerMetricsRoutesOptions,
): Promise<void> {
  const { serverConfig, cache, checkAdminAccess } = opts;
  const now = opts.now ?? (() => new Date());

  app.get<{ Params: ServerMetricsParams; Querystring: ServerMetricsQuery }>(
    '/api/v1/servers/:serverId/metrics',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');

      const userIdHeader = request.headers['x-user-id'];
      const userId = typeof userIdHeader === 'string' ? userIdHeader.trim() : '';
      if (!userId || userId.length > 255) {
        return sendProblem(request, reply, 401, 'Unauthorized: missing user identity');
      }

      const { serverId } = request.params;
      if (!isValidServerId(serverId)) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', {
          errors: [{ field: 'serverId', message: 'Formato de UUID inválido' }],
        });
      }

      const parsedRange = resolveServerMetricsRange(request.query ?? {}, now());
      if (!parsedRange.ok) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', {
          errors: parsedRange.errors,
        });
      }

      const access = checkAdminAccess
        ? await checkAdminAccess(userId, serverId)
        : await checkServerAdminAccess(
            userId,
            serverId,
            serverConfig.coreServiceUrl,
            serverConfig.fetchFn,
            serverConfig.timeoutMs,
          );

      if (access.notFound) {
        return sendProblem(request, reply, 404, access.message ?? 'Server not found');
      }
      if (access.upstreamError) {
        return sendProblem(request, reply, 503, access.message ?? 'Failed to verify server permissions');
      }
      if (!access.allowed || access.forbidden) {
        return sendProblem(
          request,
          reply,
          403,
          access.message ?? 'Forbidden: User does not have server administration permissions',
        );
      }

      const { range } = parsedRange;
      const cacheKey = `${serverId}|${range.from.toISOString()}|${range.to.toISOString()}`;
      const cached = cache?.get(cacheKey);
      if (cached) {
        return cached;
      }

      const result = await collectServerActivityMetrics(serverId, range, serverConfig, request.log);
      if (result.notFound) {
        return sendProblem(request, reply, 404, 'Server not found');
      }

      cache?.set(cacheKey, result.metrics);
      return result.metrics;
    },
  );
}
