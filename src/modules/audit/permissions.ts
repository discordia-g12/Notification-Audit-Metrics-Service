export interface ModeratorAccessCheckResult {
  allowed: boolean;
  isOwner?: boolean;
  canModerate?: boolean;
  notFound?: boolean;
  upstreamError?: boolean;
  message?: string;
}

export type FetchFn = typeof globalThis.fetch;

export async function checkServerModeratorAccess(
  userId: string,
  serverId: string,
  serverRolesUrl = process.env.SERVER_ROLES_URL || 'http://server-roles-service:8080',
  fetchFn: FetchFn = globalThis.fetch,
): Promise<ModeratorAccessCheckResult> {
  const url = `${serverRolesUrl.replace(/\/+$/, '')}/internal/servers/${serverId}/members/${userId}/permissions`;

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
      },
    });

    if (res.status === 404) {
      return {
        allowed: false,
        notFound: true,
        message: 'Server or member not found',
      };
    }

    if (res.status === 403) {
      return {
        allowed: false,
        message: 'Forbidden: User is not a member of this server',
      };
    }

    if (!res.ok) {
      return {
        allowed: false,
        upstreamError: true,
        message: `Upstream error: ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      is_owner?: boolean;
      can_moderate?: boolean;
      permissions_bitmask?: number;
    };

    const isOwner = Boolean(data.is_owner);
    const canModerate = Boolean(data.can_moderate);
    const allowed = isOwner || canModerate;

    return {
      allowed,
      isOwner,
      canModerate,
      message: allowed ? undefined : 'Forbidden: User does not have moderation permissions',
    };
  } catch (err) {
    return {
      allowed: false,
      upstreamError: true,
      message: (err as Error).message || 'Failed to connect to Server-Roles service',
    };
  }
}
