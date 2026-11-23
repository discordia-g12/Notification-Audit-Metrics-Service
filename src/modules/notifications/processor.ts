import type { Pool } from 'pg';
import { findPreferencesFor, insertNotifications } from './repository';
import { candidates, resolve, shouldNotify } from './rules';
import type { MessageCreatedEvent, NewNotification, Notification } from './types';

export interface ProcessorDeps {
  pool: Pool;
  /** Reparte en vivo los avisos nuevos. No espera: la bandeja ya quedó guardada. */
  deliver: (notifications: Notification[]) => void;
  now?: () => Date;
}

/**
 * `chat.message.created` → avisos. Tres pasos separados (ADR-04): quiénes podrían querer enterarse
 * (candidates), qué dicen sus preferencias (resolve + shouldNotify) y la entrega (insertar y repartir).
 * Devuelve los avisos nuevos (vacío si el evento ya se había procesado).
 */
export async function processMessageCreated(deps: ProcessorDeps, event: MessageCreatedEvent): Promise<Notification[]> {
  const pending = candidates(event);
  if (pending.length === 0) return [];

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
