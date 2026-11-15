import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from '../../utils/problem';
import type { ActiveIncidentsSource } from '../incidents/active-cache';
import type { StatusSource } from './types';
import { toAdminView, toPublicView } from './views';

export interface StatusRoutesOptions {
  monitor: StatusSource;
  /** Incidentes activos que se suman al estado público. Sin fuente, solo el sondeo. */
  incidents?: ActiveIncidentsSource;
}

/**
 * Defensa en profundidad (ADR-002 del Gateway): Kong ya exige staff en /api/v1/admin/*, pero el servicio
 * vuelve a chequear el header. Comparación exacta: "Staff", "staff " o el header repetido no pasan.
 */
export async function requireStaff(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers['x-user-role'] === 'staff') return;
  await sendProblem(request, reply, 403, 'Forbidden: staff only');
}

export async function statusRoutes(app: FastifyInstance, options: StatusRoutesOptions): Promise<void> {
  const { monitor, incidents } = options;

  // Estado en vivo: ni el navegador ni un proxy intermedio lo cachean (403 incluido).
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // Pública (historia 74, CA1 y CA3): estado combinado e incidentes activos, sin detalles técnicos. La web la
  // consulta periódicamente para mostrar y quitar el aviso.
  app.get('/api/v1/status', async () => toPublicView(monitor.snapshot(), incidents ? await incidents.get() : []));

  app.get('/api/v1/admin/status', { preHandler: requireStaff }, async () =>
    toAdminView(monitor.snapshot()),
  );
}
