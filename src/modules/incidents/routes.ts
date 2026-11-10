import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from '../../utils/problem';
import { SERVICE_CATALOG } from '../status/catalog';
import { requireStaff } from '../status/routes';
import type { ActiveIncidentsSource } from './active-cache';
import {
  INCIDENT_KINDS,
  INCIDENT_LIMITS,
  INCIDENT_STATUSES,
  type IncidentKind,
  type IncidentStatus,
  type IncidentStore,
} from './types';
import { toAdminIncident, toAdminPage } from './views';

export interface IncidentRoutesOptions {
  store: IncidentStore;
  activeIncidents: ActiveIncidentsSource;
}

const SERVICE_IDS = SERVICE_CATALOG.map((s) => s.id);
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const BASE = '/api/v1/admin/incidents';

const createSchema = {
  body: {
    type: 'object',
    required: ['title', 'description', 'kind', 'affectedServices'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', maxLength: INCIDENT_LIMITS.titleMax },
      description: { type: 'string', maxLength: INCIDENT_LIMITS.descriptionMax },
      kind: { type: 'string', enum: [...INCIDENT_KINDS] },
      affectedServices: {
        type: 'array',
        minItems: 1,
        maxItems: SERVICE_IDS.length,
        uniqueItems: true,
        items: { type: 'string', enum: SERVICE_IDS },
      },
    },
  },
} as const;

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: [...INCIDENT_STATUSES] },
      limit: { type: 'integer', minimum: 1, maximum: INCIDENT_LIMITS.pageMax, default: INCIDENT_LIMITS.pageDefault },
      before: { type: 'string', maxLength: 40 },
    },
  },
} as const;

const resolveSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: UUID } },
  },
} as const;

interface CreateBody {
  title: string;
  description: string;
  kind: IncidentKind;
  affectedServices: string[];
}

interface ListQuery {
  status?: IncidentStatus;
  limit: number;
  before?: string;
}

/** El autor de la acción: Kong pone X-User-Id del token. Sin él no hay a quién atribuirla en la auditoría. */
function actorOf(request: FastifyRequest): string | null {
  const id = request.headers['x-user-id'];
  return typeof id === 'string' && id.length > 0 && id.length <= 255 ? id : null;
}

async function requireStaffActor(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireStaff(request, reply);
  if (reply.sent) return;
  if (!actorOf(request)) await sendProblem(request, reply, 403, 'Forbidden: missing user identity');
}

function fieldOf(error: { instancePath?: string; params?: Record<string, unknown> }, context?: string): string {
  const missing = error.params?.missingProperty;
  const path = (error.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
  const field = typeof missing === 'string' ? (path ? `${path}.${missing}` : missing) : path;
  return field || context || 'body';
}

/**
 * Incidentes de la plataforma (historia 74, CA1, CA2 y CA4). Todo bajo /api/v1/admin: Kong exige staff
 * (ADR-002 del Gateway) y acá se vuelve a chequear. Cada escritura queda en audit_logs.
 */
export async function incidentRoutes(app: FastifyInstance, options: IncidentRoutesOptions): Promise<void> {
  const { store, activeIncidents } = options;

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // Errores de validación y de parseo como problem+json, igual que el resto de las respuestas de error.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error.validation) {
      const errors = error.validation.map((e) => ({
        field: fieldOf(e, error.validationContext),
        message: e.message ?? 'inválido',
      }));
      return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', { errors });
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) return sendProblem(request, reply, status, error.message);
    request.log.error({ err: error }, 'incidents: error inesperado');
    return sendProblem(request, reply, 500, 'No se pudo procesar la solicitud');
  });

  app.post<{ Body: CreateBody }>(
    BASE,
    { schema: createSchema, preValidation: requireStaffActor },
    async (request, reply) => {
      const title = request.body.title.trim();
      const description = request.body.description.trim();
      const errors: Array<{ field: string; message: string }> = [];
      if (title.length < INCIDENT_LIMITS.titleMin) {
        errors.push({ field: 'title', message: `must NOT have fewer than ${INCIDENT_LIMITS.titleMin} characters` });
      }
      if (description.length === 0) {
        errors.push({ field: 'description', message: 'must NOT be empty' });
      }
      if (errors.length > 0) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', { errors });
      }

      // En el orden del catálogo: el mismo incidente se ve igual venga como venga el array.
      const requested = new Set(request.body.affectedServices);
      const incident = await store.create({
        kind: request.body.kind,
        title,
        description,
        affectedServices: SERVICE_IDS.filter((id) => requested.has(id)),
        createdBy: actorOf(request) as string,
      });
      activeIncidents.invalidate();
      request.log.info({ incident: incident.id, kind: incident.kind }, 'incidents: incidente publicado');
      return reply.code(201).header('location', `${BASE}/${incident.id}`).send(toAdminIncident(incident));
    },
  );

  app.get<{ Querystring: ListQuery }>(BASE, { schema: listSchema, preValidation: requireStaff }, async (request, reply) => {
    const { status, limit, before } = request.query;
    let beforeDate: Date | undefined;
    if (before !== undefined) {
      beforeDate = new Date(before);
      if (Number.isNaN(beforeDate.getTime())) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', {
          errors: [{ field: 'before', message: 'must be an ISO 8601 date' }],
        });
      }
    }
    return toAdminPage(await store.list({ status, limit, before: beforeDate }));
  });

  app.post<{ Params: { id: string }; Body: { note?: unknown } | undefined }>(
    `${BASE}/:id/resolve`,
    { schema: resolveSchema, preValidation: requireStaffActor },
    async (request, reply) => {
      const raw = request.body?.note;
      if (raw !== undefined && raw !== null && (typeof raw !== 'string' || raw.length > INCIDENT_LIMITS.noteMax)) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', {
          errors: [{ field: 'note', message: `must be a string of at most ${INCIDENT_LIMITS.noteMax} characters` }],
        });
      }
      const note = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

      const result = await store.resolve(request.params.id.toLowerCase(), {
        resolvedBy: actorOf(request) as string,
        note,
      });
      if (result.outcome === 'not_found') {
        return sendProblem(request, reply, 404, 'El incidente no existe');
      }
      if (result.outcome === 'already_resolved') {
        return sendProblem(request, reply, 409, 'El incidente ya estaba resuelto');
      }
      activeIncidents.invalidate();
      request.log.info({ incident: result.incident.id }, 'incidents: incidente resuelto');
      return toAdminIncident(result.incident);
    },
  );
}
