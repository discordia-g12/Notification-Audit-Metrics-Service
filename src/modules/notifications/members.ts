import type { FetchFn } from './inbox';

export const MEMBERS_TIMEOUT_MS = 2000;

export interface ServerMembersOptions {
  /** URL base de Server-Roles (`SERVER_ROLES_URL`, nodo edge). */
  serverRolesUrl: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

/**
 * `user_ids` de un endpoint interno de Server-Roles. Vacío si no existe (404). Lanza si no responde a tiempo
 * o responde algo inesperado: el consumidor manda el evento a la DLQ en vez de perder los avisos.
 */
function memberIdsFetcher(
  options: ServerMembersOptions,
): (path: string, body?: unknown) => Promise<string[]> {
  const base = options.serverRolesUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? MEMBERS_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));

  return async (path, body) => {
    const response = await fetchFn(`${base}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return [];
    const parsed = response.ok ? ((await response.json().catch(() => null)) as { user_ids?: unknown } | null) : null;
    const userIds = parsed?.user_ids;
    if (!Array.isArray(userIds) || !userIds.every((id) => typeof id === 'string')) {
      throw new Error(`Server-Roles ${path} respondió algo inesperado (status ${response.status})`);
    }
    return userIds;
  };
}

/** Miembros de un servidor (`GET /internal/servers/{id}/member-ids`, el mismo que usa Chat). 404 → vacío. */
export function serverMemberIds(options: ServerMembersOptions): (serverId: string) => Promise<string[]> {
  const get = memberIdsFetcher(options);
  return (serverId) => get(`/internal/servers/${encodeURIComponent(serverId)}/member-ids`);
}

/**
 * Miembros de un rol (`GET /internal/servers/{id}/roles/{roleId}/member-ids`). 404 si el servidor no existe o
 * el rol no es de ese servidor → vacío.
 */
export function roleMemberIds(options: ServerMembersOptions): (serverId: string, roleId: string) => Promise<string[]> {
  const get = memberIdsFetcher(options);
  return (serverId, roleId) =>
    get(`/internal/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}/member-ids`);
}

export const VIEWERS_BATCH_SIZE = 5000;

/**
 * De `userIds`, los que pueden ver el canal (`POST /internal/channels/{id}/viewers`, máx. 5000 por llamada: se
 * parte en lotes). Sin ids no llama. 404 (canal borrado) → vacío: nadie recibe el aviso.
 */
export function channelViewerIds(
  options: ServerMembersOptions,
): (channelId: string, userIds: string[]) => Promise<string[]> {
  const post = memberIdsFetcher(options);
  return async (channelId, userIds) => {
    const viewers: string[] = [];
    for (let i = 0; i < userIds.length; i += VIEWERS_BATCH_SIZE) {
      viewers.push(
        ...(await post(`/internal/channels/${encodeURIComponent(channelId)}/viewers`, {
          user_ids: userIds.slice(i, i + VIEWERS_BATCH_SIZE),
        })),
      );
    }
    return viewers;
  };
}
