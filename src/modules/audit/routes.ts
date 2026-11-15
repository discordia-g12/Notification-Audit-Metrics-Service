import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { listAuditLogs } from './repository';
import { checkServerModeratorAccess } from './permissions';
import type { AuditCategory, AuditAction } from './types';

export interface AuditRoutesOptions {
  pool: Pool;
  serverRolesUrl?: string;
  checkAccess?: typeof checkServerModeratorAccess;
}

interface AuditLogQueryParams {
  category?: AuditCategory;
  action?: AuditAction;
  actor_id?: string;
  before?: string;
  limit?: string;
}

interface ServerParams {
  serverId: string;
}

function sendProblem(
  reply: FastifyReply,
  statusCode: number,
  title: string,
  detail: string,
  instance: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .header('content-type', 'application/problem+json')
    .send({
      type: 'about:blank',
      title,
      status: statusCode,
      detail,
      instance,
    });
}

export async function auditRoutes(app: FastifyInstance, options: AuditRoutesOptions): Promise<void> {
  const { pool, serverRolesUrl, checkAccess = checkServerModeratorAccess } = options;

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get<{
    Params: ServerParams;
    Querystring: AuditLogQueryParams;
  }>('/api/v1/servers/:serverId/audit-logs', async (request, reply) => {
    const rawUserId = request.headers['x-user-id'];
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;

    if (!userId) {
      return sendProblem(
        reply,
        401,
        'Unauthorized',
        'Missing X-User-Id header',
        request.url.split('?')[0],
      );
    }

    const { serverId } = request.params;

    const access = await checkAccess(userId, serverId, serverRolesUrl);

    if (access.notFound) {
      return sendProblem(
        reply,
        404,
        'Not Found',
        access.message || 'Server not found',
        request.url.split('?')[0],
      );
    }

    if (access.upstreamError) {
      return sendProblem(
        reply,
        503,
        'Service Unavailable',
        access.message || 'Upstream service unavailable',
        request.url.split('?')[0],
      );
    }

    if (!access.allowed) {
      return sendProblem(
        reply,
        403,
        'Forbidden',
        access.message || 'Forbidden: User does not have moderation permissions for this server',
        request.url.split('?')[0],
      );
    }

    const query = request.query;
    const limit = query.limit ? parseInt(query.limit, 10) : undefined;

    const page = await listAuditLogs(pool, serverId, {
      category: query.category,
      action: query.action,
      actorId: query.actor_id,
      before: query.before,
      limit: Number.isNaN(limit) ? undefined : limit,
    });

    return reply.send(page);
  });
}
