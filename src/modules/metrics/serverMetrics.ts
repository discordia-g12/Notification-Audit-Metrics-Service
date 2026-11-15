import { DAY_MS, MAX_RANGE_DAYS, resolveRange, type MetricsRange, type RangeResult } from './range';
import type { FetchFn } from './sources';

const ADMIN_PERMISSION_BITS = (1 << 3) | (1 << 20); // MANAGE_SERVER | ADMINISTRATOR
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServerActivityPoint {
  date: string;
  activeMembers: number | null;
  messagesSent: number | null;
  newMembers: number | null;
}

export interface ServerActivityMetrics {
  serverId: string;
  from: string;
  to: string;
  activeMembers: number | null;
  messagesSent: number | null;
  newMembers: number | null;
  hasActivity: boolean;
  partial: boolean;
  series: ServerActivityPoint[];
}

export interface ServerAdminAccessResult {
  allowed: boolean;
  isOwner?: boolean;
  permissionsBitmask?: number;
  notFound?: boolean;
  forbidden?: boolean;
  upstreamError?: boolean;
  message?: string;
}

export interface ServerMetricsCollectorConfig {
  chatEngineUrl: string;
  coreServiceUrl: string;
  timeoutMs: number;
  fetchFn?: FetchFn;
}

export interface ServerMetricsLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

interface InternalServerActivityPayload {
  channelIds?: unknown;
  newMembers?: unknown;
  dailyNewMembers?: unknown;
}

interface InternalChannelMessagesPayload {
  messages?: unknown;
  activeUsers?: unknown;
  daily?: unknown;
}

class SourceHttpError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export function isValidServerId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Interpreta `?days=` (entre 1 y 366 días) o delega en `resolveRange` (`?from=` / `?to=`).
 */
export function resolveServerMetricsRange(
  query: { from?: unknown; to?: unknown; days?: unknown },
  now: Date = new Date(),
): RangeResult {
  if (query.days !== undefined && query.from === undefined && query.to === undefined) {
    const raw = typeof query.days === 'string' ? query.days.trim() : '';
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        errors: [{ field: 'days', message: `Debe ser un entero entre 1 y ${MAX_RANGE_DAYS}` }],
      };
    }
    const days = Number(raw);
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RANGE_DAYS) {
      return {
        ok: false,
        errors: [{ field: 'days', message: `Debe estar entre 1 y ${MAX_RANGE_DAYS}` }],
      };
    }
    // Usar `now` exacto (sin truncar al minuto anterior) para incluir mensajes y altas ocurridos en el minuto actual.
    const end = new Date(now.getTime());
    const start = new Date(end.getTime() - days * DAY_MS);
    return { ok: true, range: { from: start, to: end } };
  }
  return resolveRange(query, now);
}

/**
 * Verifica contra Server-Roles si el usuario tiene permisos de administración del servidor
 * (`is_owner`, `ADMINISTRATOR` o `MANAGE_SERVER`).
 */
export async function checkServerAdminAccess(
  userId: string,
  serverId: string,
  coreServiceUrl: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = 2000,
): Promise<ServerAdminAccessResult> {
  const url = `${coreServiceUrl}/internal/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/permissions`;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) {
      return { allowed: false, notFound: true, message: 'Server not found' };
    }
    if (res.status === 403) {
      let detail = 'Forbidden: User does not have server administration permissions';
      try {
        const body = (await res.json()) as { detail?: unknown; message?: unknown };
        if (typeof body.detail === 'string' && body.detail) detail = body.detail;
        else if (typeof body.message === 'string' && body.message) detail = body.message;
      } catch {
        // Usar mensaje por defecto si el upstream no devolvió JSON legible.
      }
      return { allowed: false, forbidden: true, message: detail };
    }
    if (!res.ok) {
      return { allowed: false, upstreamError: true, message: 'Failed to verify server permissions' };
    }
    const data = (await res.json()) as { is_owner?: unknown; permissions_bitmask?: unknown };
    const isOwner = data.is_owner === true;
    const bitmask = typeof data.permissions_bitmask === 'number' && Number.isFinite(data.permissions_bitmask)
      ? data.permissions_bitmask
      : 0;
    const allowed = isOwner || (bitmask & ADMIN_PERMISSION_BITS) !== 0;
    return {
      allowed,
      isOwner,
      permissionsBitmask: bitmask,
      message: allowed ? undefined : 'Forbidden: User does not have server administration permissions',
    };
  } catch {
    return { allowed: false, upstreamError: true, message: 'Failed to communicate with Server Roles service' };
  }
}

/**
 * Recolecta métricas de actividad de un servidor combinando Server-Roles (canales + nuevos miembros)
 * y Chat-Engine (mensajes enviados + miembros activos por canal).
 */
export async function collectServerActivityMetrics(
  serverId: string,
  range: MetricsRange,
  config: ServerMetricsCollectorConfig,
  logger: ServerMetricsLogger,
): Promise<{ notFound: true } | { notFound: false; metrics: ServerActivityMetrics }> {
  const fetchFn = config.fetchFn ?? fetch;
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();
  const params = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;

  let coreData: {
    channelIds: string[];
    newMembers: number;
    dailyNewMembers: Map<string, number>;
  } | null = null;

  try {
    const coreRes = await fetchFn(
      `${config.coreServiceUrl}/internal/metrics/servers/${encodeURIComponent(serverId)}?${params}`,
      { signal: AbortSignal.timeout(config.timeoutMs) },
    );
    if (coreRes.status === 404) {
      return { notFound: true };
    }
    if (!coreRes.ok) {
      throw new SourceHttpError(coreRes.status >= 500 ? 'http_5xx' : `http_${coreRes.status}`);
    }
    const raw = (await coreRes.json()) as InternalServerActivityPayload;
    coreData = parseCorePayload(raw);
  } catch (err) {
    logger.warn({ source: 'server-roles', reason: reasonOf(err) }, 'No se pudo consultar métricas de servidor');
  }

  let chatData: {
    messages: number;
    activeUsers: number;
    daily: Map<string, { messages: number; activeUsers: number }>;
  } | null = null;

  if (coreData !== null) {
    if (coreData.channelIds.length === 0) {
      chatData = { messages: 0, activeUsers: 0, daily: new Map() };
    } else {
      try {
        const chatRes = await fetchFn(`${config.chatEngineUrl}/internal/metrics/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from: fromIso,
            to: toIso,
            channelIds: coreData.channelIds,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (!chatRes.ok) {
          throw new SourceHttpError(chatRes.status >= 500 ? 'http_5xx' : `http_${chatRes.status}`);
        }
        const raw = (await chatRes.json()) as InternalChannelMessagesPayload;
        chatData = parseChatPayload(raw);
      } catch (err) {
        logger.warn({ source: 'chat', reason: reasonOf(err) }, 'No se pudo consultar mensajes del servidor');
      }
    }
  }

  const newMembers = coreData?.newMembers ?? null;
  const activeMembers = chatData?.activeUsers ?? null;
  const messagesSent = chatData?.messages ?? null;
  const partial = coreData === null || chatData === null;
  const hasActivity = (activeMembers ?? 0) > 0 || (messagesSent ?? 0) > 0 || (newMembers ?? 0) > 0;

  const series = buildSeries(range, coreData?.dailyNewMembers ?? null, chatData?.daily ?? null);

  return {
    notFound: false,
    metrics: {
      serverId,
      from: fromIso,
      to: toIso,
      activeMembers,
      messagesSent,
      newMembers,
      hasActivity,
      partial,
      series,
    },
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseCorePayload(raw: InternalServerActivityPayload) {
  if (!raw || !Array.isArray(raw.channelIds) || !isCount(raw.newMembers)) {
    throw new SourceHttpError('invalid_payload');
  }
  const channelIds = raw.channelIds.filter((id): id is string => typeof id === 'string');
  const dailyNewMembers = new Map<string, number>();
  if (Array.isArray(raw.dailyNewMembers)) {
    for (const point of raw.dailyNewMembers) {
      if (point && typeof point === 'object' && typeof (point as { date?: unknown }).date === 'string' && isCount((point as { count?: unknown }).count)) {
        dailyNewMembers.set((point as { date: string }).date, (point as { count: number }).count);
      }
    }
  }
  return { channelIds, newMembers: raw.newMembers, dailyNewMembers };
}

function parseChatPayload(raw: InternalChannelMessagesPayload) {
  if (!raw || !isCount(raw.messages) || !isCount(raw.activeUsers)) {
    throw new SourceHttpError('invalid_payload');
  }
  const daily = new Map<string, { messages: number; activeUsers: number }>();
  if (Array.isArray(raw.daily)) {
    for (const point of raw.daily) {
      if (
        point &&
        typeof point === 'object' &&
        typeof (point as { date?: unknown }).date === 'string' &&
        isCount((point as { messages?: unknown }).messages) &&
        isCount((point as { activeUsers?: unknown }).activeUsers)
      ) {
        daily.set((point as { date: string }).date, {
          messages: (point as { messages: number }).messages,
          activeUsers: (point as { activeUsers: number }).activeUsers,
        });
      }
    }
  }
  return { messages: raw.messages, activeUsers: raw.activeUsers, daily };
}

function buildSeries(
  range: MetricsRange,
  dailyNewMembers: Map<string, number> | null,
  dailyChat: Map<string, { messages: number; activeUsers: number }> | null,
): ServerActivityPoint[] {
  const days = listUtcDays(range.from, range.to);
  return days.map((date) => {
    const chat = dailyChat ? (dailyChat.get(date) ?? { messages: 0, activeUsers: 0 }) : null;
    const joins = dailyNewMembers ? (dailyNewMembers.get(date) ?? 0) : null;
    return {
      date,
      activeMembers: chat ? chat.activeUsers : null,
      messagesSent: chat ? chat.messages : null,
      newMembers: joins,
    };
  });
}

function listUtcDays(from: Date, to: Date): string[] {
  if (to.getTime() <= from.getTime()) return [];
  const startDayMs = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const inclusiveLast = new Date(to.getTime() - 1);
  const endDayMs = Date.UTC(
    inclusiveLast.getUTCFullYear(),
    inclusiveLast.getUTCMonth(),
    inclusiveLast.getUTCDate(),
  );
  const result: string[] = [];
  for (let ms = startDayMs; ms <= endDayMs; ms += DAY_MS) {
    result.push(new Date(ms).toISOString().slice(0, 10));
  }
  return result;
}

function reasonOf(err: unknown): string {
  if (err instanceof SourceHttpError) return err.reason;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'network';
}
