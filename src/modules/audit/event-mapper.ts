import type { AuditLogEntry } from './types';

export function extractActor(value: unknown): string {
  return typeof value === 'string' && value ? value : 'system';
}

export function extractTarget(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function extractReason(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function extractChanges(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function extractEventId(payloadEventId: unknown, messageId?: string | null): string | null {
  if (typeof payloadEventId === 'string' && payloadEventId) {
    return payloadEventId;
  }
  if (typeof messageId === 'string' && messageId) {
    return messageId;
  }
  return null;
}

/**
 * Mapea eventos del bus RabbitMQ (exchange server.events) a registros estructurados de auditoría.
 * Si el evento no corresponde a una acción auditable de servidor, retorna null.
 */
export function mapEventToAuditLog(
  routingKey: string,
  payload: Record<string, unknown>,
  messageId?: string | null,
): AuditLogEntry | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const serverId = typeof payload.server_id === 'string' ? payload.server_id : undefined;
  if (!serverId) {
    return null;
  }

  const eventId = extractEventId(payload.event_id, messageId);

  switch (routingKey) {
    // ----------------------------------------------------
    // MEMBERS
    // ----------------------------------------------------
    case 'member.banned':
      return {
        eventId,
        serverId,
        category: 'members',
        action: 'MEMBER_BAN_ADD',
        actorId: extractActor(payload.banned_by),
        targetId: extractTarget(payload.user_id),
        reason: extractReason(payload.reason),
      };

    case 'member.unbanned':
      return {
        eventId,
        serverId,
        category: 'members',
        action: 'MEMBER_BAN_REMOVE',
        actorId: extractActor(payload.unbanned_by),
        targetId: extractTarget(payload.user_id),
      };

    case 'member.kicked':
      return {
        eventId,
        serverId,
        category: 'members',
        action: 'MEMBER_KICK',
        actorId: extractActor(payload.kicked_by),
        targetId: extractTarget(payload.user_id),
        reason: extractReason(payload.reason),
      };

    case 'member.muted':
      return {
        eventId,
        serverId,
        category: 'members',
        action: 'MEMBER_MUTE',
        actorId: extractActor(payload.muted_by),
        targetId: extractTarget(payload.user_id),
        reason: extractReason(payload.reason),
        metadata: {
          expires_at: payload.expires_at ?? null,
        },
      };

    case 'member.unmuted':
      return {
        eventId,
        serverId,
        category: 'members',
        action: 'MEMBER_UNMUTE',
        actorId: extractActor(payload.unmuted_by),
        targetId: extractTarget(payload.user_id),
      };

    // ----------------------------------------------------
    // ROLES
    // ----------------------------------------------------
    case 'member.role_assigned':
      return {
        eventId,
        serverId,
        category: 'roles',
        action: 'MEMBER_ROLE_ASSIGN',
        actorId: extractActor(payload.assigned_by),
        targetId: extractTarget(payload.user_id),
        metadata: {
          role_id: payload.role_id,
          role_name: payload.role_name,
        },
      };

    case 'member.role_removed':
      return {
        eventId,
        serverId,
        category: 'roles',
        action: 'MEMBER_ROLE_REMOVE',
        actorId: extractActor(payload.removed_by),
        targetId: extractTarget(payload.user_id),
        metadata: {
          role_id: payload.role_id,
          role_name: payload.role_name,
        },
      };

    case 'role.created':
      return {
        eventId,
        serverId,
        category: 'roles',
        action: 'ROLE_CREATE',
        actorId: extractActor(payload.created_by),
        targetId: extractTarget(payload.role_id),
        metadata: {
          name: payload.name,
          permissions: payload.permissions,
          position: payload.position,
          is_default: payload.is_default,
        },
      };

    case 'role.updated':
      return {
        eventId,
        serverId,
        category: 'roles',
        action: 'ROLE_UPDATE',
        actorId: extractActor(payload.updated_by),
        targetId: extractTarget(payload.role_id),
        changes: extractChanges(payload.changes),
        metadata: {
          name: payload.name,
        },
      };

    case 'role.permissions_updated': {
      const oldVal = payload.old_permissions ?? payload.old_permissions_bitmask ?? 0;
      const newVal = payload.new_permissions ?? payload.new_permissions_bitmask ?? 0;
      return {
        eventId,
        serverId,
        category: 'roles',
        action: 'ROLE_PERMISSIONS_UPDATE',
        actorId: extractActor(payload.updated_by),
        targetId: extractTarget(payload.role_id),
        changes: {
          permissions: {
            old: oldVal,
            new: newVal,
          },
        },
        metadata: {
          name: payload.name,
        },
      };
    }

    case 'role.deleted':
      return {
        eventId,
        serverId,
        category: 'roles',
        action: 'ROLE_DELETE',
        actorId: extractActor(payload.deleted_by),
        targetId: extractTarget(payload.role_id),
        metadata: {
          name: payload.name,
        },
      };

    // ----------------------------------------------------
    // CHANNELS
    // ----------------------------------------------------
    case 'channel.created':
      return {
        eventId,
        serverId,
        category: 'channels',
        action: 'CHANNEL_CREATE',
        actorId: extractActor(payload.created_by),
        targetId: extractTarget(payload.channel_id),
        metadata: {
          name: payload.name,
          type: payload.type,
          category_id: payload.category_id,
        },
      };

    case 'channel.updated':
      return {
        eventId,
        serverId,
        category: 'channels',
        action: 'CHANNEL_UPDATE',
        actorId: extractActor(payload.updated_by),
        targetId: extractTarget(payload.channel_id),
        changes: extractChanges(payload.changes),
        metadata: {
          name: payload.name,
        },
      };

    case 'channel.deleted':
      return {
        eventId,
        serverId,
        category: 'channels',
        action: 'CHANNEL_DELETE',
        actorId: extractActor(payload.deleted_by),
        targetId: extractTarget(payload.channel_id),
        metadata: {
          name: payload.name,
          type: payload.type,
        },
      };

    // ----------------------------------------------------
    // CATEGORIES
    // ----------------------------------------------------
    case 'category.created':
      return {
        eventId,
        serverId,
        category: 'categories',
        action: 'CATEGORY_CREATE',
        actorId: extractActor(payload.created_by),
        targetId: extractTarget(payload.category_id),
        metadata: {
          name: payload.name,
        },
      };

    case 'category.updated':
      return {
        eventId,
        serverId,
        category: 'categories',
        action: 'CATEGORY_UPDATE',
        actorId: extractActor(payload.updated_by),
        targetId: extractTarget(payload.category_id),
        changes: extractChanges(payload.changes),
        metadata: {
          name: payload.name,
        },
      };

    case 'category.deleted':
      return {
        eventId,
        serverId,
        category: 'categories',
        action: 'CATEGORY_DELETE',
        actorId: extractActor(payload.deleted_by),
        targetId: extractTarget(payload.category_id),
        metadata: {
          name: payload.name,
        },
      };

    // ----------------------------------------------------
    // SERVER SETTINGS
    // ----------------------------------------------------
    case 'server.updated':
      return {
        eventId,
        serverId,
        category: 'server',
        action: 'SERVER_UPDATE',
        actorId: extractActor(payload.updated_by),
        targetId: serverId,
        changes: extractChanges(payload.changes),
      };

    case 'server.ownership_transferred':
      return {
        eventId,
        serverId,
        category: 'server',
        action: 'SERVER_TRANSFER',
        actorId: extractActor(payload.previous_owner_id),
        targetId: extractTarget(payload.new_owner_id),
        metadata: {
          previous_owner_id: payload.previous_owner_id,
          new_owner_id: payload.new_owner_id,
        },
      };

    // ----------------------------------------------------
    // INVITES
    // ----------------------------------------------------
    case 'invite.created':
      return {
        eventId,
        serverId,
        category: 'invites',
        action: 'INVITE_CREATE',
        actorId: extractActor(payload.created_by),
        targetId: extractTarget(payload.code),
        metadata: {
          code: payload.code,
          max_uses: payload.max_uses,
          expires_at: payload.expires_at,
        },
      };

    case 'invite.revoked':
      return {
        eventId,
        serverId,
        category: 'invites',
        action: 'INVITE_REVOKE',
        actorId: extractActor(payload.revoked_by),
        targetId: extractTarget(payload.code),
        metadata: {
          code: payload.code,
        },
      };

    // ----------------------------------------------------
    // MESSAGES
    // ----------------------------------------------------
    case 'message.deleted_by_moderator':
      return {
        eventId,
        serverId,
        category: 'messages',
        action: 'MESSAGE_DELETE',
        actorId: extractActor(payload.deleted_by),
        targetId: extractTarget(payload.author_id),
        reason: extractReason(payload.reason),
        metadata: {
          channel_id: payload.channel_id,
          message_id: payload.message_id,
        },
      };

    default:
      return null;
  }
}
