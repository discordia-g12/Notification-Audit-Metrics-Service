import type { Notification } from './types';

/** Lo que acepta `POST /internal/inbox/events` de Chat por llamada. */
export const INBOX_BATCH_SIZE = 10;
export const INBOX_TIMEOUT_MS = 2000;

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface InboxPublisherOptions {
  /** URL base de Chat-Engine (`CHAT_ENGINE_URL`, mismo nodo). */
  chatEngineUrl: string;
  /** Secreto de `/internal/inbox/events` (`INTERNAL_API_TOKEN`, D1/V9). Vacío: no se manda. */
  internalToken?: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

/** Lo que viaja por el inbox: sin el id ni el usuario, que son distintos para cada destinatario. */
export function toInboxEvent(notification: Notification) {
  return {
    type: 'NOTIFICATION_CREATED',
    notification: {
      reason: notification.reason,
      serverId: notification.serverId,
      channelId: notification.channelId,
      threadId: notification.threadId,
      messageId: notification.messageId,
      actorId: notification.actorId,
      preview: notification.preview,
      createdAt: notification.createdAt.toISOString(),
    },
  };
}

/**
 * Avisa en vivo por el inbox de Chat. Es best-effort: la bandeja en Postgres es la fuente de verdad y el
 * cliente la vuelve a pedir al recibir el aviso (o por polling). Un solo intento por lote: si Chat lo
 * publicó y la respuesta se perdió, reintentar lo duplicaría.
 */
export class InboxPublisher {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(options: InboxPublisherOptions) {
    this.url = `${options.chatEngineUrl.replace(/\/$/, '')}/internal/inbox/events`;
    this.token = options.internalToken ?? '';
    this.timeoutMs = options.timeoutMs ?? INBOX_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /**
   * Un aviso por destinatario, agrupados en lotes de 10 por evento (todos los de un mismo mensaje viajan
   * igual). Devuelve cuántos lotes fallaron; nunca lanza.
   */
  async publish(notifications: Notification[]): Promise<number> {
    const byEvent = new Map<string, { event: ReturnType<typeof toInboxEvent>; userIds: string[] }>();
    for (const notification of notifications) {
      const event = toInboxEvent(notification);
      const key = JSON.stringify(event);
      const group = byEvent.get(key) ?? { event, userIds: [] };
      group.userIds.push(notification.userId);
      byEvent.set(key, group);
    }

    let failed = 0;
    for (const { event, userIds } of byEvent.values()) {
      for (let i = 0; i < userIds.length; i += INBOX_BATCH_SIZE) {
        if (!(await this.send(userIds.slice(i, i + INBOX_BATCH_SIZE), event))) failed += 1;
      }
    }
    return failed;
  }

  private async send(userIds: string[], event: object): Promise<boolean> {
    try {
      const response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { 'x-internal-token': this.token } : {}),
        },
        body: JSON.stringify({ userIds, event }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
