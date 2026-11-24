import type { Pool } from 'pg';
import webpush from 'web-push';
import { deleteTokens, findPushTargets, type PushDevice } from './push-repository';
import type { FetchFn } from './inbox';
import type { Notification, Reason } from './types';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Lo que acepta la Expo Push API por llamada. */
export const EXPO_BATCH_SIZE = 100;
/** Envíos web en paralelo: cada uno es una conexión HTTPS a otro proveedor. */
export const WEB_PUSH_CONCURRENCY = 10;
export const PUSH_TIMEOUT_MS = 5000;
/** Cuánto guarda el proveedor un aviso web si el navegador está apagado. */
export const WEB_PUSH_TTL_S = 60 * 60;

const TITLES: Record<Reason, string> = {
  mention: 'Te mencionaron',
  dm: 'Mensaje directo',
  thread_reply: 'Respuesta en un hilo',
  message: 'Mensaje nuevo',
};

export type WebPushSendFn = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSenderOptions {
  pool: Pool;
  /** `EXPO_ACCESS_TOKEN`, solo si el proyecto de Expo exige push seguro. */
  expoAccessToken?: string;
  /** Sin VAPID no se manda push web (los dispositivos web se ignoran). */
  vapid?: VapidConfig;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  webPushSend?: WebPushSendFn;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

/**
 * Lo que viaja en el push: lo justo para abrir el mensaje (mismos nombres que `Notification` de la API) y el
 * preview que ya guarda la bandeja. Sin el actor ni el usuario.
 */
export function toPushMessage(notification: Notification) {
  return {
    title: TITLES[notification.reason],
    body: notification.preview,
    data: {
      notificationId: notification.id,
      reason: notification.reason,
      serverId: notification.serverId,
      channelId: notification.channelId,
      threadId: notification.threadId,
      messageId: notification.messageId,
    },
  };
}

/** Variables de entorno → VAPID. Si falta alguna, push web queda apagado. */
export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | undefined {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : undefined;
}

/**
 * Push a mobile (Expo Push API) y a la web (Web Push con VAPID), después de guardar en la bandeja. Best-effort
 * como el inbox: un intento, nunca lanza, y lo que falla no toca la bandeja. Los tokens que el proveedor da por
 * muertos se borran.
 */
export class PushSender {
  readonly webEnabled: boolean;
  private readonly pool: Pool;
  private readonly expoAccessToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly webPushSend: WebPushSendFn;

  constructor(options: PushSenderOptions) {
    this.pool = options.pool;
    this.expoAccessToken = options.expoAccessToken ?? '';
    this.timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.webPushSend = options.webPushSend ?? webpush.sendNotification;
    // setVapidDetails valida las claves y el subject: mejor enterarse al arrancar que en cada envío
    let valid = false;
    if (options.vapid) {
      try {
        webpush.setVapidDetails(options.vapid.subject, options.vapid.publicKey, options.vapid.privateKey);
        valid = true;
      } catch {
        // claves o subject inválidos: push web apagado (app.ts lo avisa en el log)
      }
    }
    this.webEnabled = valid;
  }

  async send(notifications: Notification[]): Promise<PushResult> {
    const result: PushResult = { sent: 0, failed: 0, removed: 0 };
    try {
      const devices = await findPushTargets(this.pool, [...new Set(notifications.map((n) => n.userId))]);
      if (devices.length === 0) return result;

      const byUser = new Map<string, PushDevice[]>();
      for (const d of devices) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);
      const pairs = notifications.flatMap((n) => (byUser.get(n.userId) ?? []).map((device) => ({ n, device })));

      const dead = [
        ...(await this.sendExpo(pairs.filter((p) => p.device.platform !== 'web'), result)),
        ...(this.webEnabled ? await this.sendWeb(pairs.filter((p) => p.device.platform === 'web'), result) : []),
      ];
      await deleteTokens(this.pool, dead);
      result.removed = dead.length;
    } catch {
      result.failed += 1;
    }
    return result;
  }

  private async sendExpo(pairs: { n: Notification; device: PushDevice }[], result: PushResult): Promise<string[]> {
    const dead: string[] = [];
    for (let i = 0; i < pairs.length; i += EXPO_BATCH_SIZE) {
      const batch = pairs.slice(i, i + EXPO_BATCH_SIZE);
      const messages = batch.map(({ n, device }) => ({
        to: device.token,
        ...toPushMessage(n),
        sound: 'default',
        priority: 'high',
      }));
      try {
        const response = await this.fetchFn(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(this.expoAccessToken ? { authorization: `Bearer ${this.expoAccessToken}` } : {}),
          },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          result.failed += batch.length;
          continue;
        }
        // Un ticket por mensaje, en el mismo orden
        const { data } = (await response.json()) as {
          data?: { status: string; details?: { error?: string } }[];
        };
        batch.forEach(({ device }, j) => {
          const ticket = data?.at(j);
          if (ticket?.status === 'ok') result.sent += 1;
          else result.failed += 1;
          if (ticket?.details?.error === 'DeviceNotRegistered') dead.push(device.token);
        });
      } catch {
        result.failed += batch.length;
      }
    }
    return dead;
  }

  private async sendWeb(pairs: { n: Notification; device: PushDevice }[], result: PushResult): Promise<string[]> {
    const dead: string[] = [];
    for (let i = 0; i < pairs.length; i += WEB_PUSH_CONCURRENCY) {
      await Promise.all(
        pairs.slice(i, i + WEB_PUSH_CONCURRENCY).map(async ({ n, device }) => {
          try {
            await this.webPushSend(
              { endpoint: device.token, keys: device.keys as webpush.PushSubscription['keys'] },
              JSON.stringify(toPushMessage(n)),
              { TTL: WEB_PUSH_TTL_S, timeout: this.timeoutMs },
            );
            result.sent += 1;
          } catch (err) {
            result.failed += 1;
            const status = (err as { statusCode?: number }).statusCode;
            // 404/410: la suscripción ya no existe (el usuario la revocó o el navegador la rotó)
            if (status === 404 || status === 410) dead.push(device.token);
          }
        }),
      );
    }
    return dead;
  }
}
