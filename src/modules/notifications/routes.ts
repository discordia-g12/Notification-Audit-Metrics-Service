import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { sendProblem } from '../../utils/problem';
import {
  deletePreference,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  upsertPreference,
  type PreferenceChange,
} from './repository';
import {
  deleteDevice,
  getPushEnabled,
  setPushEnabled,
  upsertDevice,
  PUSH_PLATFORMS,
  type PushPlatform,
  type WebPushKeys,
} from './push-repository';
import { LEVELS, SCOPE_TYPES, type Level, type Notification, type Preference, type ScopeType } from './types';

export const DEFAULT_PAGE = 20;
export const MAX_PAGE = 50;

const BASE = '/api/v1/notifications';
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
// Ids de Chat y Server-Roles: ObjectId, UUID o `dm-<ObjectId>`. Sin espacios ni separadores raros.
const SCOPE_ID = '^[A-Za-z0-9_-]{1,128}$';

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      unread: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE },
      before: { type: 'string', pattern: UUID },
    },
  },
} as const;

const idSchema = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
} as const;

const scopeParams = {
  type: 'object',
  required: ['scopeType', 'scopeId'],
  properties: {
    scopeType: { type: 'string', enum: [...SCOPE_TYPES] },
    scopeId: { type: 'string', pattern: SCOPE_ID },
  },
} as const;

const putPreferenceSchema = {
  params: scopeParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      level: { anyOf: [{ type: 'string', enum: [...LEVELS] }, { type: 'null' }] },
      muted: { type: 'boolean' },
      mutedUntil: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      serverId: { type: 'string', pattern: SCOPE_ID },
    },
  },
} as const;

// Expo push token (`ExponentPushToken[…]`, o `ExpoPushToken[…]` en versiones nuevas)
const EXPO_TOKEN = '^Expo(nent)?PushToken\\[[A-Za-z0-9_-]{1,200}\\]$';
// Solo los servicios de push de los navegadores: el endpoint lo elige el cliente y este servicio le hace un
// POST, así que cualquier otro host sería un SSRF desde el nodo realtime.
const WEB_PUSH_ENDPOINT =
  '^https://([a-z0-9-]+\\.)*(fcm\\.googleapis\\.com|push\\.services\\.mozilla\\.com|notify\\.windows\\.com|push\\.apple\\.com)/[!-~]+$';
const BASE64URL = '^[A-Za-z0-9_-]+=*$';

const registerDeviceSchema = {
  body: {
    type: 'object',
    required: ['platform'],
    additionalProperties: false,
    properties: {
      platform: { type: 'string', enum: [...PUSH_PLATFORMS] },
      token: { type: 'string', maxLength: 255, pattern: EXPO_TOKEN },
      subscription: {
        type: 'object',
        required: ['endpoint', 'keys'],
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', maxLength: 1024, pattern: WEB_PUSH_ENDPOINT },
          keys: {
            type: 'object',
            required: ['p256dh', 'auth'],
            additionalProperties: false,
            properties: {
              p256dh: { type: 'string', maxLength: 200, pattern: BASE64URL },
              auth: { type: 'string', maxLength: 100, pattern: BASE64URL },
            },
          },
        },
      },
    },
  },
} as const;

const deleteDeviceSchema = {
  body: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: { token: { type: 'string', minLength: 1, maxLength: 1024 } },
  },
} as const;

const pushSettingsSchema = {
  body: {
    type: 'object',
    required: ['pushEnabled'],
    additionalProperties: false,
    properties: { pushEnabled: { type: 'boolean' } },
  },
} as const;

interface RegisterDeviceBody {
  platform: PushPlatform;
  token?: string;
  subscription?: { endpoint: string; keys: WebPushKeys };
}

interface ScopeParams {
  scopeType: ScopeType;
  scopeId: string;
}

interface PreferenceBody {
  level?: Level | null;
  muted?: boolean;
  mutedUntil?: string | null;
  serverId?: string;
}

// Sin userId: es siempre el de quien pregunta
const toView = (n: Notification) => ({
  id: n.id,
  reason: n.reason,
  serverId: n.serverId,
  channelId: n.channelId,
  threadId: n.threadId,
  messageId: n.messageId,
  actorId: n.actorId,
  preview: n.preview,
  createdAt: n.createdAt,
  readAt: n.readAt,
});
const toPreferenceView = (p: Preference) => ({
  scopeType: p.scopeType,
  scopeId: p.scopeId,
  serverId: p.serverId,
  level: p.level,
  muted: p.muted,
  mutedUntil: p.mutedUntil,
  updatedAt: p.updatedAt,
});

/** Kong pone X-User-Id al validar el token. Sin él no hay de quién es la bandeja. */
function userOf(request: FastifyRequest): string | null {
  const id = request.headers['x-user-id'];
  return typeof id === 'string' && id.length > 0 && id.length <= 255 ? id : null;
}

// Devuelve el reply al cortar: así Fastify no sigue con el handler (hook async que responde antes)
async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!userOf(request)) return sendProblem(request, reply, 401, 'Missing user identity');
}

/**
 * Bandeja y preferencias de notificación del usuario (ADR-04). Kong enruta /api/v1/notifications sin
 * sacar el prefijo y exige token. Cada usuario solo ve y cambia lo suyo: el id sale de X-User-Id, nunca
 * del cliente.
 */
export async function notificationRoutes(
  app: FastifyInstance,
  options: { pool: Pool; vapidPublicKey?: string | null },
): Promise<void> {
  const { pool } = options;

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.addHook('preValidation', requireUser);

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error.validation) {
      const errors = error.validation.map((e) => ({
        field: (e.instancePath || '').replace(/^\//, '').replace(/\//g, '.') || error.validationContext || 'body',
        message: e.message ?? 'inválido',
      }));
      return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', { errors });
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) return sendProblem(request, reply, status, error.message);
    request.log.error({ err: error }, 'notifications: error inesperado');
    return sendProblem(request, reply, 500, 'No se pudo procesar la solicitud');
  });

  app.get<{ Querystring: { unread: boolean; limit: number; before?: string } }>(
    BASE,
    { schema: listSchema },
    async (request) => {
      const { unread, limit, before } = request.query;
      const page = await listNotifications(pool, userOf(request) as string, {
        unreadOnly: unread,
        limit,
        before: before?.toLowerCase(),
      });
      return { ...page, items: page.items.map(toView) };
    },
  );

  app.post(`${BASE}/read-all`, async (request, reply) => {
    await markAllRead(pool, userOf(request) as string);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(`${BASE}/:id/read`, { schema: idSchema }, async (request, reply) => {
    const found = await markRead(pool, userOf(request) as string, request.params.id.toLowerCase());
    if (!found) return sendProblem(request, reply, 404, 'La notificación no existe');
    return reply.code(204).send();
  });

  app.get(`${BASE}/preferences`, async (request) => ({
    items: (await listPreferences(pool, userOf(request) as string)).map(toPreferenceView),
  }));

  app.put<{ Params: ScopeParams; Body: PreferenceBody }>(
    `${BASE}/preferences/:scopeType/:scopeId`,
    { schema: putPreferenceSchema },
    async (request, reply) => {
      const { level, muted, mutedUntil, serverId } = request.body;
      // Fastify saca las propiedades desconocidas antes de validar: { otra: 1 } llega vacío
      if (level === undefined && muted === undefined && mutedUntil === undefined) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', {
          errors: [{ field: 'body', message: 'must have level, muted or mutedUntil' }],
        });
      }
      const change: PreferenceChange = {
        ...(level !== undefined ? { level } : {}),
        ...(muted !== undefined ? { muted } : {}),
        ...(mutedUntil !== undefined ? { mutedUntil: mutedUntil === null ? null : new Date(mutedUntil) } : {}),
        ...(serverId !== undefined ? { serverId } : {}),
      };
      const { scopeType, scopeId } = request.params;
      return toPreferenceView(await upsertPreference(pool, userOf(request) as string, scopeType, scopeId, change));
    },
  );

  app.delete<{ Params: ScopeParams }>(
    `${BASE}/preferences/:scopeType/:scopeId`,
    { schema: { params: scopeParams } },
    async (request, reply) => {
      const { scopeType, scopeId } = request.params;
      await deletePreference(pool, userOf(request) as string, scopeType, scopeId);
      return reply.code(204).send();
    },
  );

  // Push (ADR-08). Rutas estáticas: no chocan con /:id/read (find-my-way prioriza lo estático).
  app.post<{ Body: RegisterDeviceBody }>(
    `${BASE}/push/devices`,
    { schema: registerDeviceSchema },
    async (request, reply) => {
      const { platform, token, subscription } = request.body;
      const web = platform === 'web';
      if (web ? !subscription || token !== undefined : !token || subscription !== undefined) {
        return sendProblem(request, reply, 400, 'La solicitud tiene campos inválidos', {
          errors: [{ field: web ? 'subscription' : 'token', message: web ? 'web lleva subscription' : 'ios y android llevan token' }],
        });
      }
      await upsertDevice(pool, {
        userId: userOf(request) as string,
        platform,
        token: web ? subscription!.endpoint : token!,
        keys: web ? subscription!.keys : null,
      });
      return reply.code(204).send();
    },
  );

  app.delete<{ Body: { token: string } }>(
    `${BASE}/push/devices`,
    { schema: deleteDeviceSchema },
    async (request, reply) => {
      await deleteDevice(pool, userOf(request) as string, request.body.token);
      return reply.code(204).send();
    },
  );

  app.get(`${BASE}/push/settings`, async (request) => ({
    pushEnabled: await getPushEnabled(pool, userOf(request) as string),
  }));

  app.put<{ Body: { pushEnabled: boolean } }>(
    `${BASE}/push/settings`,
    { schema: pushSettingsSchema },
    async (request) => {
      await setPushEnabled(pool, userOf(request) as string, request.body.pushEnabled);
      return { pushEnabled: request.body.pushEnabled };
    },
  );

  // Para que la web se suscriba sin tener la clave en el build. null: push web apagado en este entorno.
  app.get(`${BASE}/push/vapid-public-key`, async () => ({ publicKey: options.vapidPublicKey ?? null }));
}
