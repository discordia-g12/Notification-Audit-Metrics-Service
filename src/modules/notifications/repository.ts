import type { Pool } from 'pg';
import type { Scope } from './rules';
import type { Level, NewNotification, Notification, Preference, ScopeType } from './types';

/** Tope del contador de no leídas: más que esto, la interfaz muestra "99+". */
export const UNREAD_COUNT_CAP = 100;
/** Cuánto se guardan las leídas y las no leídas antes de borrarlas. */
export const READ_RETENTION_DAYS = 30;
export const UNREAD_RETENTION_DAYS = 90;
/** Preferencias que devuelve GET /preferences: más que esto no tiene sentido para una persona. */
export const MAX_PREFERENCES = 500;

interface NotificationRow {
  id: string;
  user_id: string;
  reason: Notification['reason'];
  server_id: string | null;
  channel_id: string;
  thread_id: string | null;
  message_id: string;
  actor_id: string;
  preview: string;
  created_at: Date;
  read_at: Date | null;
}

interface PreferenceRow {
  user_id: string;
  scope_type: ScopeType;
  scope_id: string;
  server_id: string | null;
  level: Level | null;
  muted: boolean;
  muted_until: Date | null;
  updated_at: Date;
}

const NOTIFICATION_COLUMNS =
  'id, user_id, reason, server_id, channel_id, thread_id, message_id, actor_id, preview, created_at, read_at';
const PREFERENCE_COLUMNS = 'user_id, scope_type, scope_id, server_id, level, muted, muted_until, updated_at';

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    reason: row.reason,
    serverId: row.server_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    actorId: row.actor_id,
    preview: row.preview,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function toPreference(row: PreferenceRow): Preference {
  return {
    userId: row.user_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    serverId: row.server_id,
    level: row.level,
    muted: row.muted,
    mutedUntil: row.muted_until,
    updatedAt: row.updated_at,
  };
}

/** Las preferencias de esos usuarios que aplican a este mensaje (hilo, canal y servidor), en una consulta. */
export async function findPreferencesFor(pool: Pool, userIds: string[], scope: Scope): Promise<Preference[]> {
  if (userIds.length === 0) return [];
  const { rows } = await pool.query<PreferenceRow>(
    `SELECT ${PREFERENCE_COLUMNS} FROM notification_preferences
      WHERE user_id = ANY($1)
        AND ((scope_type = 'thread' AND scope_id = $2)
          OR (scope_type = 'channel' AND scope_id = $3)
          OR (scope_type = 'server' AND scope_id = $4))`,
    [userIds, scope.threadId ?? '', scope.channelId, scope.serverId ?? ''],
  );
  return rows.map(toPreference);
}

/**
 * Guarda los avisos en un solo INSERT. Los que ya existían (misma entrega repetida) no vuelven: el que
 * llama solo reparte los nuevos.
 */
export async function insertNotifications(pool: Pool, items: NewNotification[]): Promise<Notification[]> {
  if (items.length === 0) return [];
  const { rows } = await pool.query<NotificationRow>(
    `INSERT INTO notifications
       (user_id, reason, server_id, channel_id, thread_id, message_id, actor_id, preview, event_id, created_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                          $8::text[], $9::text[], $10::timestamptz[])
     ON CONFLICT (event_id, user_id) DO NOTHING
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [
      items.map((i) => i.userId),
      items.map((i) => i.reason),
      items.map((i) => i.serverId),
      items.map((i) => i.channelId),
      items.map((i) => i.threadId),
      items.map((i) => i.messageId),
      items.map((i) => i.actorId),
      items.map((i) => i.preview),
      items.map((i) => i.eventId),
      items.map((i) => i.createdAt),
    ],
  );
  return rows.map(toNotification);
}

export interface NotificationPage {
  items: Notification[];
  unreadCount: number;
  nextCursor: string | null;
}

/**
 * Bandeja del usuario, de la más nueva a la más vieja. `before` es el id de la última de la página anterior
 * (keyset por created_at e id: dos avisos con la misma hora no se saltean).
 */
export async function listNotifications(
  pool: Pool,
  userId: string,
  options: { unreadOnly: boolean; limit: number; before?: string },
): Promise<NotificationPage> {
  const params: unknown[] = [userId, options.limit + 1];
  const filters = ['user_id = $1'];
  if (options.unreadOnly) filters.push('read_at IS NULL');
  if (options.before) {
    params.push(options.before);
    filters.push(
      `(created_at, id) < (SELECT created_at, id FROM notifications WHERE id = $${params.length} AND user_id = $1)`,
    );
  }

  const [page, unread] = await Promise.all([
    pool.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    ),
    pool.query<{ count: string }>(
      `SELECT count(*) FROM (SELECT 1 FROM notifications WHERE user_id = $1 AND read_at IS NULL LIMIT $2) AS u`,
      [userId, UNREAD_COUNT_CAP],
    ),
  ]);

  const items = page.rows.slice(0, options.limit).map(toNotification);
  const hasMore = page.rows.length > options.limit;
  return {
    items,
    unreadCount: Number(unread.rows[0].count),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

/** Marca leída una del usuario. false si no existe o es de otro (no se distingue: no se filtra qué ids existen). */
export async function markRead(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function markAllRead(pool: Pool, userId: string): Promise<void> {
  await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
}

export async function listPreferences(pool: Pool, userId: string): Promise<Preference[]> {
  const { rows } = await pool.query<PreferenceRow>(
    `SELECT ${PREFERENCE_COLUMNS} FROM notification_preferences WHERE user_id = $1
      ORDER BY scope_type, scope_id LIMIT $2`,
    [userId, MAX_PREFERENCES],
  );
  return rows.map(toPreference);
}

export interface PreferenceChange {
  level?: Level | null;
  muted?: boolean;
  mutedUntil?: Date | null;
  serverId?: string | null;
}

/**
 * Crea o modifica una preferencia cambiando solo los campos que llegan (silenciar no pisa el nivel, y al
 * revés). En un alcance `server`, el servidor es el propio scope.
 */
export async function upsertPreference(
  pool: Pool,
  userId: string,
  scopeType: ScopeType,
  scopeId: string,
  change: PreferenceChange,
): Promise<Preference> {
  const serverId = scopeType === 'server' ? scopeId : (change.serverId ?? null);
  const { rows } = await pool.query<PreferenceRow>(
    `INSERT INTO notification_preferences (user_id, scope_type, scope_id, server_id, level, muted, muted_until)
     VALUES ($1, $2, $3, $4, $6, COALESCE($8, false), $10)
     ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET
       server_id = COALESCE($4, notification_preferences.server_id),
       level = CASE WHEN $5 THEN $6 ELSE notification_preferences.level END,
       muted = CASE WHEN $7 THEN $8 ELSE notification_preferences.muted END,
       muted_until = CASE WHEN $9 THEN $10 ELSE notification_preferences.muted_until END,
       updated_at = now()
     RETURNING ${PREFERENCE_COLUMNS}`,
    [
      userId,
      scopeType,
      scopeId,
      serverId,
      change.level !== undefined,
      change.level ?? null,
      change.muted !== undefined,
      change.muted ?? null,
      change.mutedUntil !== undefined,
      change.mutedUntil ?? null,
    ],
  );
  return toPreference(rows[0]);
}

/** Vuelve al default (borra la preferencia). false si no había. */
export async function deletePreference(
  pool: Pool,
  userId: string,
  scopeType: ScopeType,
  scopeId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM notification_preferences WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3`,
    [userId, scopeType, scopeId],
  );
  return (rowCount ?? 0) > 0;
}

/** Al borrarse un canal: sus avisos y las preferencias del canal (las de sus hilos se van con el servidor o por retención). */
export async function deleteForChannel(pool: Pool, channelId: string): Promise<void> {
  await pool.query(`DELETE FROM notifications WHERE channel_id = $1`, [channelId]);
  await pool.query(`DELETE FROM notification_preferences WHERE scope_type = 'channel' AND scope_id = $1`, [channelId]);
}

/** Al borrarse un servidor: todo lo suyo, avisos y preferencias de servidor, canales e hilos. */
export async function deleteForServer(pool: Pool, serverId: string): Promise<void> {
  await pool.query(`DELETE FROM notifications WHERE server_id = $1`, [serverId]);
  await pool.query(`DELETE FROM notification_preferences WHERE server_id = $1`, [serverId]);
}

/** Retención: leídas de más de 30 días y no leídas de más de 90. Devuelve cuántas borró. */
export async function purgeOldNotifications(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM notifications
      WHERE (read_at IS NOT NULL AND read_at < now() - make_interval(days => $1))
         OR created_at < now() - make_interval(days => $2)`,
    [READ_RETENTION_DAYS, UNREAD_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}
