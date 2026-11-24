import type { Candidate, Level, MessageCreatedEvent, Preference, Reason } from './types';

/** Tope de destinatarios por evento: el mismo que Chat guarda por hilo. */
export const MAX_RECIPIENTS = 100;
const MAX_ID_LENGTH = 255;
const PREVIEW_MAX = 140;

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const idOrNull = (value: unknown): string | null => (isId(value) ? value : null);
const idList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(isId))].slice(0, MAX_RECIPIENTS) : [];

/**
 * Valida el evento que llega de RabbitMQ (frontera de confianza). Devuelve null si le falta algo
 * indispensable: no se puede avisar sin canal, mensaje, autor o id del evento.
 */
export function parseMessageCreated(
  payload: Record<string, unknown>,
  fallbackEventId?: string,
): MessageCreatedEvent | null {
  const eventId = idOrNull(payload.event_id) ?? idOrNull(fallbackEventId);
  const { channel_id: channelId, message_id: messageId, author_id: authorId } = payload;
  if (!eventId || !isId(channelId) || !isId(messageId) || !isId(authorId)) return null;

  const createdAt = typeof payload.created_at === 'string' ? new Date(payload.created_at) : new Date();
  return {
    eventId,
    serverId: idOrNull(payload.server_id),
    channelId,
    threadId: idOrNull(payload.thread_id),
    messageId,
    authorId,
    threadParticipantIds: idList(payload.thread_participant_ids),
    mentionUserIds: idList(payload.mention_user_ids),
    mentionRoleIds: idList(payload.mention_role_ids),
    mentionEveryone: payload.mention_everyone === true,
    recipientIds: idList(payload.recipient_ids),
    isDm: payload.is_dm === true,
    preview: typeof payload.preview === 'string' ? payload.preview.slice(0, PREVIEW_MAX) : '',
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
  };
}

/** Lo que el evento no trae como lista y se busca aparte (ver processor). */
export interface ExpandedRecipients {
  /** Mencionados por `@everyone` (los miembros del servidor) o por un rol (sus miembros). */
  mentionIds?: string[];
  /** Quienes pidieron `all` en este canal o servidor (y siguen siendo miembros). */
  allLevelIds?: string[];
}

/**
 * A quién le podría interesar el mensaje y por qué, sin mirar preferencias. Nunca al autor, y una sola vez
 * por usuario: si cae en varios casos gana mention > dm > thread_reply > message.
 */
export function candidates(event: MessageCreatedEvent, expanded: ExpandedRecipients = {}): Candidate[] {
  const byReason: [Reason, string[]][] = [
    ['mention', [...event.mentionUserIds, ...(expanded.mentionIds ?? [])]],
    ['dm', event.isDm ? event.recipientIds : []],
    ['thread_reply', event.threadId ? event.threadParticipantIds : []],
    ['message', expanded.allLevelIds ?? []],
  ];
  const seen = new Set<string>([event.authorId]);
  const result: Candidate[] = [];
  for (const [reason, userIds] of byReason) {
    for (const userId of userIds) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      result.push({ userId, reason });
    }
  }
  return result;
}

export interface ResolvedPreference {
  level: Level;
  muted: boolean;
}

export interface Scope {
  serverId: string | null;
  channelId: string;
  threadId: string | null;
}

/** Default sin preferencias: en un servidor solo lo que te nombra; en un DM, todo. */
export function defaultLevel(scope: Scope): Level {
  return scope.serverId ? 'mentions' : 'all';
}

const isMutedNow = (pref: Preference, now: Date) =>
  pref.muted && (pref.mutedUntil === null || pref.mutedUntil.getTime() > now.getTime());

/**
 * Preferencia efectiva de un usuario para un mensaje (función pura). Recorre hilo → canal → servidor →
 * default: el primer `level` no nulo gana (la más específica). Si cualquier nivel de la cadena está
 * silenciado y vigente, queda silenciado: silenciar el servidor silencia sus canales.
 *
 * @param prefs Las del usuario; se ignoran las que no son de este alcance
 */
export function resolve(prefs: Preference[], scope: Scope, now: Date = new Date()): ResolvedPreference {
  const chain = [
    scope.threadId ? prefs.find((p) => p.scopeType === 'thread' && p.scopeId === scope.threadId) : undefined,
    prefs.find((p) => p.scopeType === 'channel' && p.scopeId === scope.channelId),
    scope.serverId ? prefs.find((p) => p.scopeType === 'server' && p.scopeId === scope.serverId) : undefined,
  ].filter((p): p is Preference => p !== undefined);

  const level = chain.find((p) => p.level !== null)?.level ?? defaultLevel(scope);
  return { level, muted: chain.some((p) => isMutedNow(p, now)) };
}

/**
 * Si corresponde avisar. `mentions` deja pasar lo que te involucra: menciones, DMs y tus hilos. Un mensaje
 * cualquiera (`message`) solo pasa con `all`.
 */
export function shouldNotify(resolved: ResolvedPreference, reason: Reason): boolean {
  if (resolved.muted || resolved.level === 'none') return false;
  if (resolved.level === 'all') return true;
  return reason === 'mention' || reason === 'dm' || reason === 'thread_reply';
}
