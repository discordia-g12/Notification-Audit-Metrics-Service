/** Por qué se le avisa a alguien. Solo `thread_reply` se genera hoy; los otros son de la épica. */
export const REASONS = ['thread_reply', 'mention', 'dm'] as const;
export type Reason = (typeof REASONS)[number];

export const LEVELS = ['all', 'mentions', 'none'] as const;
export type Level = (typeof LEVELS)[number];

export const SCOPE_TYPES = ['server', 'channel', 'thread'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** `chat.message.created` de Chat-Engine (ADR-07 de Chat, ADR 0017), ya validado. */
export interface MessageCreatedEvent {
  eventId: string;
  serverId: string | null;
  channelId: string;
  threadId: string | null;
  messageId: string;
  authorId: string;
  threadParticipantIds: string[];
  mentionUserIds: string[];
  isDm: boolean;
  preview: string;
  createdAt: Date;
}

export interface Preference {
  userId: string;
  scopeType: ScopeType;
  scopeId: string;
  serverId: string | null;
  level: Level | null;
  muted: boolean;
  mutedUntil: Date | null;
  updatedAt: Date;
}

export interface Candidate {
  userId: string;
  reason: Reason;
}

export interface NewNotification {
  userId: string;
  reason: Reason;
  serverId: string | null;
  channelId: string;
  threadId: string | null;
  messageId: string;
  actorId: string;
  preview: string;
  eventId: string;
  createdAt: Date;
}

export interface Notification extends Omit<NewNotification, 'eventId'> {
  id: string;
  readAt: Date | null;
}
