import type { Pool } from 'pg';
import { findAllLevelUserIds, findPreferencesFor, insertNotifications } from './repository';
import { candidates, resolve, shouldNotify, type ExpandedRecipients } from './rules';
import type { MessageCreatedEvent, NewNotification, Notification } from './types';

export interface ProcessorDeps {
  pool: Pool;
  /**
   * Después de guardar: recibe solo los avisos nuevos (no los de una entrega repetida). No espera: la bandeja
   * ya quedó guardada. Reparte por el inbox de Chat y por push (ADR-08).
   */
  deliver: (notifications: Notification[]) => void;
  /** Miembros de un servidor (Server-Roles). Lanza si no responde: el evento va a la DLQ. */
  memberIds: (serverId: string) => Promise<string[]>;
  /** Miembros de un rol (Server-Roles). Lanza si no responde: el evento va a la DLQ. */
  roleMemberIds: (serverId: string, roleId: string) => Promise<string[]>;
  /** De esos usuarios, los que pueden ver el canal (Server-Roles). Lanza si no responde: el evento va a la DLQ. */
  channelViewerIds: (channelId: string, userIds: string[]) => Promise<string[]>;
  now?: () => Date;
}

/**
 * Lo que no viaja como lista en el evento: `@everyone`, las menciones de rol y quienes pidieron `all`. A
 * Server-Roles solo se le pregunta si hace falta: los miembros del servidor con `@everyone` o si alguien tiene
 * `all` (una preferencia `all` de alguien que se fue no le sigue mostrando los mensajes), y los de cada rol
 * mencionado salvo que ya esté `@everyone`, que los incluye.
 */
async function expand(deps: ProcessorDeps, event: MessageCreatedEvent): Promise<ExpandedRecipients> {
  const serverId = event.serverId;
  if (event.isDm || !serverId) return {};
  const allLevel = await findAllLevelUserIds(deps.pool, serverId, event.channelId);
  const roleIds = event.mentionEveryone ? [] : event.mentionRoleIds;
  if (!event.mentionEveryone && allLevel.length === 0 && roleIds.length === 0) return {};

  const [members, roleMembers] = await Promise.all([
    event.mentionEveryone || allLevel.length > 0 ? deps.memberIds(serverId) : null,
    Promise.all(roleIds.map((roleId) => deps.roleMemberIds(serverId, roleId))),
  ]);
  const isMember = new Set(members);
  const byRole = roleMembers.flat().filter((id) => members === null || isMember.has(id));
  return {
    mentionIds: event.mentionEveryone ? (members ?? []) : byRole,
    allLevelIds: allLevel.filter((id) => isMember.has(id)),
  };
}

/**
 * `chat.message.created` → avisos. Tres pasos separados (ADR-04): quiénes podrían querer enterarse
 * (candidates), qué dicen sus preferencias (resolve + shouldNotify) y la entrega (insertar y repartir).
 * Devuelve los avisos nuevos (vacío si el evento ya se había procesado).
 */
export async function processMessageCreated(deps: ProcessorDeps, event: MessageCreatedEvent): Promise<Notification[]> {
  let pending = candidates(event, await expand(deps, event));
  if (pending.length === 0) return [];

  // En un canal privado no todos los miembros lo ven: el preview no se les avisa. Los DMs no pasan por acá.
  if (!event.isDm && event.serverId) {
    const viewers = new Set(await deps.channelViewerIds(event.channelId, pending.map((c) => c.userId)));
    pending = pending.filter((c) => viewers.has(c.userId));
    if (pending.length === 0) return [];
  }

  const scope = { serverId: event.serverId, channelId: event.channelId, threadId: event.threadId };
  const prefs = await findPreferencesFor(
    deps.pool,
    pending.map((c) => c.userId),
    scope,
  );
  const now = deps.now?.() ?? new Date();

  const items: NewNotification[] = pending
    .filter(({ userId, reason }) =>
      shouldNotify(
        resolve(
          prefs.filter((p) => p.userId === userId),
          scope,
          now,
        ),
        reason,
      ),
    )
    .map(({ userId, reason }) => ({
      userId,
      reason,
      serverId: event.serverId,
      channelId: event.channelId,
      threadId: event.threadId,
      messageId: event.messageId,
      actorId: event.authorId,
      preview: event.preview,
      eventId: event.eventId,
      createdAt: event.createdAt,
    }));

  const created = await insertNotifications(deps.pool, items);
  if (created.length > 0) deps.deliver(created);
  return created;
}
