import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StatusSource } from './types';
import { toAdminView, toPublicView } from './views';

export interface StatusRoutesOptions {
  monitor: StatusSource;
}

/**
 * Defensa en profundidad (ADR-002 del Gateway): Kong ya exige staff en /api/v1/admin/*, pero el servicio
 * vuelve a chequear el header. Comparación exacta: "Staff", "staff " o el header repetido no pasan.
 */
export async function requireStaff(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers['x-user-role'] === 'staff') return;
  // Mismo formato que reject() de auth0_validator.lua.
  await reply
    .code(403)
    .header('content-type', 'application/problem+json')
    .send({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Forbidden: staff only',
      instance: request.url.split('?')[0],
    });
}

export async function statusRoutes(app: FastifyInstance, options: StatusRoutesOptions): Promise<void> {
  const { monitor } = options;

  // Estado en vivo: ni el navegador ni un proxy intermedio lo cachean (403 incluido).
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // Pública (historia 74, CA3): cualquiera ve el estado, sin detalles técnicos.
  app.get('/api/v1/status', async () => toPublicView(monitor.snapshot()));

  app.get('/api/v1/admin/status', { preHandler: requireStaff }, async () =>
    toAdminView(monitor.snapshot()),
  );
}
